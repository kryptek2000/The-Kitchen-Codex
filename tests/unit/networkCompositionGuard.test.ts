/**
 * The Kitchen Codex — Network Composition + Direct-Fetch Guard (Phase 4D2B).
 *
 * Static guards enforcing the app-backend transport boundary:
 *   - Component files must NOT make direct same-origin `/api` fetches (they must
 *     use the injected NetworkAdapter). This is the app-backend transport guard.
 *   - Component files must NOT construct BrowserNetworkAdapter (concrete browser
 *     composition belongs in App/platform bootstrap). This is the concrete-adapter
 *     composition guard.
 *
 * Platform/browser owns BrowserNetworkAdapter; the low-level legacy asset utility
 * (src/utils/vaultAssets.ts) is an intentionally deferred path and is not scanned.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const COMPONENTS_DIR = resolve(ROOT, 'src/components');

function discoverTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...discoverTsx(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const COMPONENT_FILES = discoverTsx(COMPONENTS_DIR);

const SAME_ORIGIN_FETCH = /fetch\s*\(\s*(['"`])/;

describe('network transport + composition guards (Phase 4D2B)', () => {
  it('component files make NO direct fetch() call (they use the injected NetworkAdapter)', () => {
    for (const file of COMPONENT_FILES) {
      const src = readFileSync(file, 'utf8');
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(SAME_ORIGIN_FETCH.test(stripped), `${file.slice(ROOT.length + 1)} must not call fetch() directly`).toBe(false);
    }
  });

  it('component files do NOT import or construct BrowserNetworkAdapter', () => {
    for (const file of COMPONENT_FILES) {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toContain('BrowserNetworkAdapter');
      expect(src).not.toMatch(/new\s+BrowserNetworkAdapter\s*\(/);
    }
  });

  it('components depend only on the NetworkAdapter contract type', () => {
    for (const file of COMPONENT_FILES) {
      const src = readFileSync(file, 'utf8');
      const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(src)) !== null) {
        const spec = m[1];
        if (spec.includes('NetworkAdapter')) {
          expect(spec).toMatch(/application\/adapters\/NetworkAdapter/);
          expect(spec).not.toMatch(/platform/);
        }
      }
    }
  });
});
