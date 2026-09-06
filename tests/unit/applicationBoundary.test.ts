/**
 * The Kitchen Codex — Application Boundary / Adapter Contract Conformance (Phase 4C1).
 *
 * Verifies the application layer (`src/application`) is a PORTS-ONLY boundary:
 *   - the adapter contracts and the application entrypoint load under Node,
 *   - they depend only on platform-neutral core (application -> core is allowed),
 *   - they do NOT reach platform implementations, UI, server, React/Express, the
 *     Gemini SDK, or raw platform APIs (no window/document/localStorage/fs/fetch),
 *   - and NO concrete platform adapter implementation is present (no
 *     Browser / Obsidian / Pwa adapter classes, no fetch(, no process.env, no
 *     showDirectoryPicker/localStorage).
 *
 * This is contract conformance, not runtime-behavior testing. Runs under the
 * existing Vitest Node environment with no DOM mocks.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, sep, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const APPLICATION_ENTRY = resolve(ROOT, 'src/application/index.ts');

// Forbidden external specifiers (mirrors coreBoundary; application is a pure port
// layer and must not pull runtime platforms either).
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
  /^child_process$/,
  /^worker_threads$/,
  /^zlib$/,
  /^http2$/,
  /^perf_hooks$/,
  /^events$/,
  /^readline$/,
  /^timers$/,
  /^url$/,
  /^util$/,
  /^string_decoder$/,
  /^tty$/,
  /^async_hooks$/,
  /^cluster$/,
  /^vm$/,
  /^v8$/,
  /^trace_events$/,
  /^querystring$/,
  /^@google\/genai$/,
].map((re) => (raw: string) => re.test(raw));

// Concrete platform implementations / raw platform code the application layer is
// prohibited from reaching (application should go through adapter CONTRACTS).
const FORBIDDEN_PATH_SEGMENTS = [
  'vaultFileSystem',
  'vaultAssets',
  'imageHelper',
  'audioAlert',
  'cardExportColors',
  'useVaultImage',
  '/components/',
  '/server/',
  '/hooks/',
  'main.tsx',
  'App.tsx',
];

// Raw platform-runtime tokens that indicate a concrete implementation leaked in.
const FORBIDDEN_IMPLEMENTATION_GLOBAL = [
  /\bwindow\s*[.\[]/,
  /\bdocument\s*[.\[]/,
  /\bnavigator\s*[.\[]/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
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
  /class\s+<?[A-Za-z]*(Browser|Obsidian|Pwa|Node|Server)[A-Za-z]*/,
];

/** Strips `//` line comments and `/* *​/` block comments (pragmatic). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function resolveProjectSpecifier(fromFile: string, specifier: string): string | null {
  const ALIAS = '@/';
  let base: string | null = null;
  if (specifier.startsWith(ALIAS)) {
    base = resolve(ROOT, specifier.slice(ALIAS.length));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }
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
      const resolved = resolveProjectSpecifier(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return visited;
}

function auditApplication(): string[] {
  const graph = collectGraph(APPLICATION_ENTRY);
  const failures: string[] = [];
  for (const file of graph) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    if (file.includes('node_modules')) continue;
    const source = readFileSync(file, 'utf8');

    for (const segment of FORBIDDEN_PATH_SEGMENTS) {
      if (`/${rel}/`.includes(segment) || rel.includes(segment)) {
        failures.push(`${rel}: reachable module matches forbidden platform/UI/server segment "${segment}"`);
      }
    }

    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    let im: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((im = importRe.exec(source)) !== null) {
      const spec = im[1];
      if (FORBIDDEN_SPECIFIER.some((pred) => pred(spec))) {
        failures.push(`${rel}: forbidden import specifier "${spec}"`);
      }
      const resolved = resolveProjectSpecifier(file, spec);
      if (resolved) {
        const resolvedRel = resolved.slice(ROOT.length + 1).replace(/\\/g, '/');
        for (const segment of FORBIDDEN_PATH_SEGMENTS) {
          if (resolvedRel.includes(segment) && !resolvedRel.startsWith('src/data/')) {
            failures.push(`${rel}: transitively imports ${resolvedRel} (forbidden "${segment}")`);
          }
        }
      }
    }

    const stripped = stripComments(source);
    for (const re of FORBIDDEN_IMPLEMENTATION_GLOBAL) {
      if (re.test(stripped)) {
        failures.push(`${rel}: references forbidden platform-runtime token ${re}`);
      }
    }
  }
  return failures;
}

describe('application layer / adapter contracts (Phase 4C1)', () => {
  it('loads the application entrypoint and all adapter contracts under Node without DOM mocks', async () => {
    await import('../../src/application/index.ts');
    await import('../../src/application/adapters/VaultAdapter');
    await import('../../src/application/adapters/SettingsAdapter');
    await import('../../src/application/adapters/SecretAdapter');
    await import('../../src/application/adapters/NetworkAdapter');
    expect(true).toBe(true);
  });

  it('contains zero forbidden platform/UI/server/provider dependencies', () => {
    const failures = auditApplication();
    expect(failures).toEqual([]);
  });

  it('application may import core (positive control) and never reaches platform impls', () => {
    const rels = Array.from(collectGraph(APPLICATION_ENTRY)).map((f) =>
      f.slice(ROOT.length + 1).replace(/\\/g, '/')
    );
    // application -> core is allowed.
    expect(rels.some((r) => r.startsWith('src/schema/'))).toBe(true);
    expect(rels.some((r) => r.startsWith('src/utils/kitchen'))).toBe(true);
    // The adapter contracts are present.
    expect(rels.some((r) => r.endsWith('/adapters/VaultAdapter.ts'))).toBe(true);
    expect(rels.some((r) => r.endsWith('/adapters/NetworkAdapter.ts'))).toBe(true);
    // No concrete platform impls or server/UI/vault/asset code.
    for (const rel of rels) {
      expect(
        [
          'vaultFileSystem',
          'vaultAssets',
          'imageHelper',
          'audioAlert',
          'cardExportColors',
          '/server/',
          '/components/',
        ].some((b) => rel.includes(b))
      ).toBe(false);
    }
  });
});
