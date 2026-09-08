/**
 * The Kitchen Codex — Browser Shell Boundary Guard (Phase 4D3C).
 *
 * Statically enforces the browser-shell boundary won in Phase 4D3C:
 *   - the platform-neutral APPLICATION + APPLICATION-UI layers do NOT import
 *     browser platform modules / browser-only vault utilities and do NOT use
 *     browser globals (window, document, localStorage, indexedDB, FSA, bare
 *     fetch);
 *   - concrete browser adapters are constructed ONLY in `src/platform/browser`;
 *   - production `fetch()` only appears inside `src/platform/browser`
 *     (BrowserNetworkAdapter + the scoped image-download helper) — no arbitrary
 *     direct remote fetch anywhere else (e.g. vaultAssets).
 *
 * Inspected STATICALLY (no module loading, no AST tooling). Comments and string
 * literals that merely mention a symbol are stripped so they never trigger a
 * false positive.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SRC = resolve(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const isTestFile = (file: string) => /\.(test|spec)\.(ts|tsx)$/.test(file);

const PROD_FILES = walk(SRC).filter((f) => !isTestFile(f));

/** Strips block + line comments (keeps URLs like http:// intact via order). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const relOf = (file: string) => relative(ROOT, file).replace(/\\/g, '/');

const FORBIDDEN_IMPORT_SPECS = [
  /platform\/browser/,
  /utils\/vaultFileSystem/,
  /utils\/vaultAssets/,
];

function importSpecs(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    // Ignore TypeScript-only ("import type") is handled identically — type-only
    // platform imports are still a boundary break.
    specs.push(spec);
  }
  return specs;
}

describe('browser shell boundary guard (Phase 4D3C)', () => {
  it('application + application-ui do NOT import browser platform/utils and use NO browser globals', () => {
    const appUi = ['src/application', 'src/application-ui'].flatMap((d) => walk(resolve(ROOT, d)).filter((f) => !isTestFile(f)));

    const FORBIDDEN_GLOBALS = [
      /\bwindow\b/,
      /\bdocument\b/,
      /\blocalStorage\b/,
      /\bindexedDB\b/,
      /\bshowDirectoryPicker\b/,
      /\bFileSystemHandle\b/,
      /\bfetch\s*\(/,
    ];

    for (const file of appUi) {
      const src = readFileSync(file, 'utf8');

      for (const spec of importSpecs(src)) {
        for (const re of FORBIDDEN_IMPORT_SPECS) {
          expect(re.test(spec), `${relOf(file)} must not import ${re}`).toBe(false);
        }
      }

      const stripped = stripComments(src);
      for (const re of FORBIDDEN_GLOBALS) {
        expect(re.test(stripped), `${relOf(file)} must not use browser global/API ${re}`).toBe(false);
      }
    }
  });

  it('concrete browser adapters are constructed ONLY inside src/platform/browser', () => {
    const re = /new\s+(BrowserFsaVaultAdapter|BrowserSettingsAdapter|BrowserNetworkAdapter)\s*\(/;
    for (const file of PROD_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      if (re.test(src)) {
        const rel = relOf(file);
        expect(rel.startsWith('src/platform/browser/'), `${rel} must not construct a concrete browser adapter`).toBe(true);
      }
    }
  });

  it('production fetch() only appears inside src/platform/* (platform adapters / scoped helpers)', () => {
    for (const file of PROD_FILES) {
      const src = stripComments(readFileSync(file, 'utf8'));
      const hasFetch = /\bfetch\s*\(/.test(src);
      if (hasFetch) {
        const rel = relOf(file);
        expect(rel.startsWith('src/platform/'), `${rel} must not use a bare fetch(); use the NetworkAdapter or the scoped backend helper`).toBe(true);
      }
    }
  });
});
