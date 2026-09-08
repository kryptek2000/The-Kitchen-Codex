/**
 * The Kitchen Codex — Obsidian Plugin Composition Guard (Phase 4D3B).
 *
 * Static guards proving the Obsidian plugin and its obsidian platform adapters are
 * composed ONLY from the platform-neutral application contracts + the Obsidian API:
 *   - the plugin and obsidian platform code NEVER import browser adapters
 *     (BrowserFsaVaultAdapter / BrowserSettingsAdapter / BrowserNetworkAdapter),
 *   - they NEVER import the browser-only vault utilities (vaultFileSystem /
 *     vaultAssets) or the browser platform folder,
 *   - and the platform-neutral application/core layers NEVER import the Obsidian SDK.
 *
 * Only IMPORT STATEMENTS are inspected (not comments/string literals), so a
 * comment referencing an adapter name never causes a false positive.
 *
 * Obsidian is scanned (not Node-loaded) because it is a plugin (the Obsidian API
 * only exists at runtime in Obsidian); adapter correctness is separately proven by
 * unit suites using fakes + `implements` compile-time checks.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const PLUGIN_MAIN = resolve(ROOT, 'plugin/main.ts');
const OBSIDIAN_PLATFORM_FILES = walk(resolve(ROOT, 'src/platform/obsidian'), ['.ts']);
const OBSIDIAN_ENTRY = [PLUGIN_MAIN, ...OBSIDIAN_PLATFORM_FILES];

const FORBIDDEN_BINDING_NAMES = ['BrowserFsaVaultAdapter', 'BrowserSettingsAdapter', 'BrowserNetworkAdapter'];
const FORBIDDEN_UTIL_FILES = ['vaultFileSystem', 'vaultAssets'];
const FORBIDDEN_PLATFORM_SUBPATH = 'src/platform/browser';

/** Extracts `{ binding } from 'spec'` / `import 'spec'` pairs (imports only). */
function importPairs(source: string): Array<{ binding: string; spec: string }> {
  const pairs: Array<{ binding: string; spec: string }> = [];
  const re = /import\s*([\s\S]*?)\s*from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(source)) !== null) {
    const binding = (m[1] ?? '').trim();
    const spec = (m[2] ?? m[3] ?? '').trim();
    if (spec) pairs.push({ binding, spec });
  }
  return pairs;
}

describe('Obsidian plugin composition guard (Phase 4D3B)', () => {
  it('the plugin + obsidian platform import NO browser adapters or browser vault utils', () => {
    for (const file of Array.from(new Set(OBSIDIAN_ENTRY)).sort()) {
      const src = readFileSync(file, 'utf8');
      for (const { binding, spec } of importPairs(src)) {
        for (const name of FORBIDDEN_BINDING_NAMES) {
          expect(binding.includes(name), `${file} must not import ${name}`).toBe(false);
        }
        if (spec.startsWith('.')) {
          const rel = resolve(dirname(file), spec).replace(/\\/g, '/').slice(ROOT.length + 1);
          for (const util of FORBIDDEN_UTIL_FILES) {
            expect(rel.startsWith(`src/utils/${util}`), `${file} must not import ${util}`).toBe(false);
          }
          expect(rel.startsWith(`${FORBIDDEN_PLATFORM_SUBPATH}/`), `${file} must not import platform/browser`).toBe(false);
        }
      }
    }
  });

  it('the platform-neutral application and core layers do NOT import the Obsidian SDK', () => {
    const applicationFiles = walk(resolve(ROOT, 'src/application'), ['.ts']);
    const coreFiles = walk(resolve(ROOT, 'src/core'), ['.ts']);
    for (const file of Array.from(new Set([...applicationFiles, ...coreFiles])).sort()) {
      const src = readFileSync(file, 'utf8');
      for (const { spec } of importPairs(src)) {
        expect(spec).not.toBe('obsidian');
      }
    }
  });
});
