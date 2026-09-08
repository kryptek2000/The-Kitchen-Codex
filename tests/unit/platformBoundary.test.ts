/**
 * The Kitchen Codex — Platform Boundary / Dependency Direction (Phase 4C2, extended 4D3B).
 *
 * Verifies the concrete platform layer points the RIGHT way:
 *   - platform/* -> application/adapter CONTRACTS  = ALLOWED
 *   - platform/* -> src/core                       = FORBIDDEN
 *   - platform/* -> src/application/index          = FORBIDDEN (would be
 *     a reverse/application entrypoint dependency, not a contract dependency)
 *   - platform/* -> src/utils                      = FORBIDDEN
 *   - platform/browser and platform/obsidian may import ONLY their OWN siblings
 *     (intra-platform) or the application adapter CONTRACT — never each other
 *   - no React / Express / Node builtins / @google/genai in the platform adapters
 *
 * This is inspected STATICALLY (import scan of the platform source). The concrete
 * adapters are NOT Node-loaded here (browser = FSA code; obsidian = type-only
 * Obsidian API injected by the plugin); their runtime behavior is covered by
 * their own unit suites with mocks. Correctness as a `VaultAdapter`/etc. is
 * enforced at compile time (`implements X`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const PLATFORM_DIR = resolve(ROOT, 'src/platform');

/** Recursively discovers TypeScript sources under `src/platform` (no AST tooling). */
function discoverTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...discoverTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const PLATFORM_FILES = discoverTsFiles(PLATFORM_DIR);

const FORBIDDEN_EXTERNAL = [
  /^react$/,
  /^react-dom(\/|$)/,
  /^express$/,
  /^node:/,
  /^fs(\/|$)/,
  /^path$/,
  /^process$/,
  /^buffer$/,
  /^@google\/genai$/,
];

/** Returns the platform subfolder a platform file belongs to (e.g. "browser", "obsidian"). */
function platformSubdir(relativeToPlatform: string): string {
  return relativeToPlatform.split('/')[0] ?? '';
}

describe('platform boundary / dependency direction (Phase 4C2, extended 4D3B)', () => {
  it('platform files import ONLY the application adapter contract or their OWN platform siblings', () => {
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const file of PLATFORM_FILES) {
      const source = readFileSync(file, 'utf8');
      const relToPlatform = file.slice(PLATFORM_DIR.length + 1);
      const subdir = platformSubdir(relToPlatform);
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const spec = match[1];

        // External platform/server/UI/provider specs are forbidden.
        for (const re of FORBIDDEN_EXTERNAL) {
          expect(`${relToPlatform}:${spec}`).not.toMatch(new RegExp(re.source));
        }

        // Every project-relative import must resolve into (a) a sibling WITHIN the
        // same platform subfolder, or (b) the application adapter CONTRACT. It must
        // never reach core, the application entrypoint, server, src/utils, or a
        // DIFFERENT platform subfolder.
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec).replace(/\\/g, '/');
          const rel = resolved.slice(ROOT.length + 1);
          const allowedSameSubdir = rel.startsWith(`src/platform/${subdir}/`);
          const allowedContract = rel.startsWith('src/application/adapters/');
          expect(
            allowedSameSubdir || allowedContract,
            `${relToPlatform} must import only platform/${subdir} siblings or the application adapter CONTRACT, but imported ${rel}`
          ).toBe(true);
        }
      }
    }
  });

  it('the platform layer does not reach core, application index, or src/utils', () => {
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const file of PLATFORM_FILES) {
      const source = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        const resolved = resolve(dirname(file), spec).replace(/\\/g, '/');
        const rel = resolved.slice(ROOT.length + 1);
        expect(rel.startsWith('src/core/')).toBe(false);
        expect(rel.startsWith('src/application/index')).toBe(false);
        expect(rel.startsWith('src/utils/')).toBe(false);
      }
    }
  });

  it('the platform code contains no Node/server leakage', () => {
    // Platform adapters legitimately use BROWSER runtime globals (fetch,
    // window.localStorage) and Obsidian type injects; we forbid Node/server-only
    // symbols here.
    const forbidden = [
      /\bprocess\s*[.\[]/,
      /\bBuffer\b/,
      /node:/,
      /\brequire\s*\(/,
      /\bchild_process\s*\(/,
    ];
    for (const file of PLATFORM_FILES) {
      const source = readFileSync(file, 'utf8');
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const re of forbidden) {
        expect(re.test(stripped), `${file} must not use ${re}`).toBe(false);
      }
    }
  });
});
