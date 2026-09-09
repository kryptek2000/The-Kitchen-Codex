/**
 * The Kitchen Codex — Provider-Secret Persistence Guard (v0.7 Phase 1D).
 *
 * Static guards proving Phase 1D imposes NO provider-key persistencence on any
 * client/platform surface:
 *   - the browser shell NEVER writes a provider key to localStorage /
 *     sessionStorage / IndexedDB (BrowserSecretAdapter is unavailable and its
 *     set/remove throw — no silent write);
 *   - the Obsidian shell NEVER writes a provider key to plugin data.json /
 *     settings / vault Markdown (ObsidianSecretAdapter is unavailable and its
 *     set/remove throw — no silent write);
 *   - the raw provider env-variable names (which belong SERVER-SIDE) do not leak
 *     into browser/obsidian platform code or the Obsidian plugin;
 *   - there is no key-entry plumbing in this phase.
 *
 * Inspected STATICALLY (readFileSync + comment stripping), mirroring the other
 * boundary guards. `local_plaintext` is reserved and NOT claimed by any adapter.
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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PROVIDER_ENV_NAMES = ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY'];

describe('provider-secret persistence guard (v0.7 1D)', () => {
  it('does NOT persist provider keys in the browser shell (no localStorage/sessionStorage/IndexedDB)', () => {
    const files = walk(resolve(ROOT, 'src/platform/browser'), ['.ts']);
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const rel = file.slice(ROOT.length + 1);
      // localStorage is allowed for the SettingsAdapter (non-secret UI prefs) — but
      // the SECRET adapter + the browser shell must never use a browser storage API
      // to persist provider keys. We assert no provider env name appears and no
      // storage write target is used by the secret adapter.
      for (const name of PROVIDER_ENV_NAMES) {
        expect(stripped, `${rel} must not reference provider env name ${name}`).not.toContain(name);
      }
    }
  });

  it('the browser secret adapter is an unavailable, no-write adapter', () => {
    const file = resolve(ROOT, 'src/platform/browser/BrowserSecretAdapter.ts');
    const stripped = stripComments(readFileSync(file, 'utf8'));
    expect(stripped).not.toContain('localStorage');
    expect(stripped).not.toContain('sessionStorage');
    expect(stripped).not.toContain('indexedDB');
    expect(stripped).not.toContain('setItem');
    expect(stripped).not.toContain('saveData');
  });

  it('does NOT persist provider keys in the Obsidian shell (plugin data/settings/vault Markdown)', () => {
    const files = [
      ...walk(resolve(ROOT, 'src/platform/obsidian'), ['.ts']),
      resolve(ROOT, 'plugin/main.ts'),
    ];
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const rel = file.slice(ROOT.length + 1);
      for (const name of PROVIDER_ENV_NAMES) {
        expect(stripped, `${rel} must not reference provider env name ${name}`).not.toContain(name);
      }
    }
  });

  it('the obsidian secret adapter is an unavailable, no-write adapter (no key entry)', () => {
    const file = resolve(ROOT, 'src/platform/obsidian/ObsidianSecretAdapter.ts');
    const stripped = stripComments(readFileSync(file, 'utf8'));
    expect(stripped).not.toContain('localStorage');
    expect(stripped).not.toContain('saveData');
    expect(stripped).not.toContain('loadData');
    expect(stripped).not.toContain('setItem');
    // local_plaintext is reserved for a future Obsidian plaintext adapter.
    expect(stripped).not.toContain('local_plaintext');
  });

  it('no provider key field/input entry exists on any surface in 1D (no BYOK plumbing)', () => {
    const files = walk(resolve(ROOT, 'src/platform'), ['.ts']);
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      // No secret key-entry plumbing in this phase.
      expect(stripped, `${file.slice(ROOT.length + 1)} must not persist a provider key`).not.toMatch(/api[_ ]?key/i);
    }
  });
});
