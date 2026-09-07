/**
 * The Kitchen Codex — SSRF-Boundary Guard (Phase 4D2A).
 *
 * Static + behavioral guard proving the app-fetch boundary cannot be widened into
 * an arbitrary remote URL tunnel:
 *   - The `NetworkAdapter` contract exposes ONLY an app-scoped `path` (no URL /
 *     host primitive).
 *   - The `BrowserNetworkAdapter` implementation resolves `fetch` against a
 *     relative `/api/` path only and rejects every absolute/foreign/schemed URL
 *     (never reaching fetch).
 *
 * No real network access.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { BrowserNetworkAdapter } from '../../src/platform/browser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const CONTRACT = readFileSync(resolve(ROOT, 'src/application/adapters/NetworkAdapter.ts'), 'utf8');
const BRIDGE = readFileSync(resolve(ROOT, 'src/platform/browser/BrowserNetworkAdapter.ts'), 'utf8');

describe('SSRF-boundary guard (Phase 4D2A)', () => {
  it('the contract exposes only an app-scoped path (no arbitrary-url/host primitive)', () => {
    expect(CONTRACT).toMatch(/path:\s*string/);
    expect(CONTRACT).not.toMatch(/url\??:/);
    expect(CONTRACT).not.toMatch(/host\??:/);
    expect(CONTRACT).toMatch(/SERVER\s+responsibility/i);
  });

  it('the browser implementation enforces the /api/ allow-list', () => {
    expect(BRIDGE).toContain('const API_PATH = /^\\/api\\//');
    expect(BRIDGE).toContain('only accepts application API paths starting with "/api/"');
    expect(BRIDGE).toContain('path traversal');
  });

  it('rejects every absolute/foreign URL and never issues a remote fetch', async () => {
    const calls: string[] = [];
    const fetcher = async (u: string) => {
      calls.push(u);
      return { status: 200, ok: true, json: async () => ({}) } as unknown as Response;
    };
    const adapter = new BrowserNetworkAdapter(fetcher);

    const bad = [
      'http://evil.test',
      'https://evil.test',
      '//evil.test/x',
      'ftp://evil.test/x',
      'javascript:alert(1)',
      'data:text/plain,x',
      '/notapi',
      '../api/foo',
    ];
    for (const p of bad) {
      await expect(adapter.get(p)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0); // fetch was never called with any remote URL
  });
});
