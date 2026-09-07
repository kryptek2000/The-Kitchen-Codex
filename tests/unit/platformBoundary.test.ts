/**
 * The Kitchen Codex — Platform Boundary / Dependency Direction (Phase 4C2).
 *
 * Verifies the concrete platform layer points the RIGHT way:
 *   - platform/browser -> application/adapter CONTRACTS  = ALLOWED
 *   - platform/browser -> src/core                       = FORBIDDEN
 *   - platform/browser -> src/application/index          = FORBIDDEN (would be
 *     a reverse/application entrypoint dependency, not a contract dependency)
 *   - platform/browser -> src/utils                      = FORBIDDEN
 *   - no React / Express / Node builtins / @google/genai in the platform adapter
 *
 * This is inspected STATICALLY (import scan of the platform source). The concrete
 * adapter is NOT Node-loaded here because it is browser/File-System-Access code;
 * its runtime behavior is covered separately by browserVaultAdapter.test.ts using
 * mock handles. The adapter's correctness as a `VaultAdapter` is enforced at
 * compile time (`implements VaultAdapter`).
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

describe('platform boundary / dependency direction (Phase 4C2)', () => {
  it('platform browser files import ONLY the application VaultAdapter contract (allowed direction)', () => {
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const file of PLATFORM_FILES) {
      const source = readFileSync(resolve(PLATFORM_DIR, file), 'utf8');
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const spec = match[1];

        // External platform/server/UI/provider specs are forbidden.
        for (const re of FORBIDDEN_EXTERNAL) {
          expect(`${file}:${spec}`).not.toMatch(new RegExp(re.source));
        }

        // Every project-relative import must resolve into (a) a sibling within the
        // same platform folder (intra-platform), or (b) the application adapter
        // CONTRACT (src/application/adapters/). It must never reach core, the
        // application entrypoint, server, or src/utils (asserted separately below).
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(resolve(PLATFORM_DIR, file)), spec).replace(/\\/g, '/');
          const rel = resolved.slice(ROOT.length + 1);
          const allowed =
            rel.startsWith('src/platform/browser/') || rel.startsWith('src/application/adapters/');
          expect(
            allowed,
            `${file} must import only platform siblings or the application adapter CONTRACT, but imported ${rel}`
          ).toBe(true);
        }
      }
    }
  });

  it('the platform layer does not reach core, application index, or src/utils', () => {
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const file of PLATFORM_FILES) {
      const source = readFileSync(resolve(PLATFORM_DIR, file), 'utf8');
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        const resolved = resolve(dirname(resolve(PLATFORM_DIR, file)), spec).replace(/\\/g, '/');
        const rel = resolved.slice(ROOT.length + 1);
        expect(rel.startsWith('src/core/')).toBe(false);
        expect(rel.startsWith('src/application/index')).toBe(false);
        expect(rel.startsWith('src/utils/')).toBe(false);
      }
    }
  });

  it('the browser platform code contains no Node/server leakage', () => {
    // Browser-platform adapters legitimately use BROWSER runtime globals: the
    // network adapter wraps `fetch`, and the settings adapter wraps
    // `window.localStorage`. Those are intentional browser transports, NOT
    // Node/server leakage. We forbid only Node/server-only symbols here.
    const forbidden = [
      /\bprocess\s*[.\[]/,
      /\bBuffer\b/,
      /node:/,
      /\brequire\s*\(/,
      /\bchild_process\s*\(/,
    ];
    for (const file of PLATFORM_FILES) {
      const source = readFileSync(resolve(PLATFORM_DIR, file), 'utf8');
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const re of forbidden) {
        expect(re.test(stripped), `${file} must not use ${re}`).toBe(false);
      }
    }
  });
});
