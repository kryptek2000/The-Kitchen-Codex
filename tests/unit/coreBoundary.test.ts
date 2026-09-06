/**
 * The Kitchen Codex — Shared Core Purity / Conformance Boundary (Phase 4A).
 *
 * Guards the formal shared-core boundary so `src/core` cannot silently gain
 * browser / UI / server / provider / platform dependencies.
 *
 * It performs a transitive STATIC import-graph scan starting at the core
 * entrypoint (`src/core/index.ts`) and fails if any reachable project module
 * imports a forbidden platform module, OR references a forbidden platform
 * global (after stripping comments). Dom-pending node_modules packages are not
 * recursed into; `js-yaml`, `console`, `Date`, and `URL` are permitted.
 *
 * Runs under the existing Vitest Node environment (no DOM mocks, no shims).
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, sep, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CORE_ENTRY = resolve(ROOT, 'src/core/index.ts');

// Import specifiers that must NEVER appear (directly or transitively) in core.
const FORBIDDEN_SPECIFIER = [
  /^react$/,
  /^react-dom(\/|$)/,
  /^express$/,
  /^node:/,
  /^fs(\/|$)/,
  /^path$/,
  /^process$/,
  /^buffer$/,
  /^os$/,
  /^crypto$/,
  /^net$/,
  /^dns(\/|$)/,
  /^http$/,
  /^https$/,
  /^stream$/,
  /^@google\/genai$/,
].map((re) => (raw: string) => re.test(raw));

// Project-relative path segments that mark a module as platform/UI/server-bound.
const FORBIDDEN_PATH_SEGMENTS = [
  'vaultFileSystem',
  'vaultAssets',
  'imageHelper',
  'audioAlert',
  'cardExportColors',
  'useVaultImage',
  'components',
  '/server/',
  '/hooks/',
  'main.tsx',
  'App.tsx',
];

// Platform globals that must not be referenced at runtime in core sources.
// Applied to comment-stripped source so JSDoc/prose mentions do not trip it.
const FORBIDDEN_GLOBAL = [
  /\bwindow\s*[.\[]/,
  /\bdocument\s*[.\[]/,
  /\bnavigator\s*[.\[]/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bFileSystemHandle\b/,
  /\bshowDirectoryPicker\b/,
  /\bshowOpenFilePicker\b/,
  /\bshowSaveFilePicker\b/,
  /createObjectURL\s*\(/,
  /\bnew\s+Blob\s*\(/,
  /\bnew\s+File\s*\(/,
  /\bDataTransfer\b/,
  /\bBuffer\b/,
  /\bprocess\s*[.\[]/,
  /\bfetch\s*\(/,
  /\bwebkitGetAsEntry\b/,
];

/** Strips `//` line comments and `/* *​/` block comments (pragmatic). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block + JSDoc
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid http://)
}

/** Resolves a possibly-extensionless / directory import specifier to a file. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // external or alias -> skip for graph
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Collects every reachable project-relative file from an entrypoint. */
function collectGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [entry];

  const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;

  while (queue.length) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    if (file.includes(`${sep}node_modules${sep}`)) continue;

    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    let match: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(source)) !== null) {
      const specifier = match[1];
      // Forbidden external module (react / express / node: / @google/genai ...)
      if (FORBIDDEN_SPECIFIER.some((pred) => pred(specifier))) {
        // Handled per-file below; here only recurse into project-relative.
      }
      const resolved = resolveSpecifier(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }

  return visited;
}

/** Loads the real graph and runs the assertions. */
function auditCore(): string[] {
  const graph = collectGraph(CORE_ENTRY);
  const failures: string[] = [];

  for (const file of graph) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');

    if (!file.includes('node_modules')) {
      // 1. Forbidden project-relative path segments.
      for (const segment of FORBIDDEN_PATH_SEGMENTS) {
        if (`/${rel}/`.includes(segment) || rel.includes(segment)) {
          failures.push(
            `${rel}: reachable module matches forbidden platform/ui/server segment "${segment}"`
          );
        }
      }

      // 2. Forbidden external import specifiers (react/express/node:/@google/genai).
      const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
      let im: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((im = importRe.exec(source)) !== null) {
        const spec = im[1];
        if (FORBIDDEN_SPECIFIER.some((pred) => pred(spec))) {
          failures.push(`${rel}: forbidden import specifier "${spec}"`);
        }
        // Also forbid any resolved path that lands in components/hooks/App/main.
        const resolved = resolveSpecifier(file, spec);
        if (resolved) {
          const resolvedRel = resolved.slice(ROOT.length + 1).replace(/\\/g, '/');
          for (const segment of FORBIDDEN_PATH_SEGMENTS) {
            if (resolvedRel.includes(segment) && !resolvedRel.startsWith('src/data/')) {
              failures.push(
                `${rel}: transitively imports ${resolvedRel} (forbidden "${segment}")`
              );
            }
          }
        }
      }

      // 3. Forbidden globals in comment-stripped source.
      const stripped = stripComments(source);
      for (const re of FORBIDDEN_GLOBAL) {
        if (re.test(stripped)) {
          failures.push(`${rel}: references forbidden platform global ${re}`);
        }
      }
    }
  }

  return failures;
}

describe('shared core purity / conformance boundary', () => {
  it('loads the core entrypoint in a Node environment without DOM shims', async () => {
    // Importing the barrel proves every reachable module resolves and evaluates
    // under Node (environment: 'node') with no window/document/localStorage.
    await import('../../src/core/index.ts');
    // Reaching here means the whole core graph loaded cleanly in Node.
    expect(true).toBe(true);
  });

  it('contains zero forbidden browser/UI/server/platform imports', () => {
    const failures = auditCore();
    expect(failures).toEqual([]);
  });

  it('does not reach browser/UI/server modules', () => {
    const graph = collectGraph(CORE_ENTRY);
    const rels = Array.from(graph)
      .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .sort();
    // Positive control: the core graph must include core members and exclude
    // the known browser/server/UI modules.
    for (const rel of rels) {
      expect(['src/App.tsx', 'src/main.tsx', 'src/components/'].some((b) => rel.includes(b))).toBe(
        false
      );
      expect(rel.includes('/server/')).toBe(false);
      expect(
        ['vaultFileSystem', 'vaultAssets', 'imageHelper', 'audioAlert', 'cardExportColors'].some(
          (b) => rel.includes(b)
        )
      ).toBe(false);
    }
  });

  it('reachable core graph is non-empty and rooted at the candidate modules', () => {
    const graph = collectGraph(CORE_ENTRY);
    expect(graph.size).toBeGreaterThan(0);
    // Sanity: the canonical schema modules are reachable.
    expect(graph.has(resolve(ROOT, 'src/schema/recipeSchema.ts'))).toBe(true);
    expect(graph.has(resolve(ROOT, 'src/utils/kitchenSearch.ts'))).toBe(true);
  });
});
