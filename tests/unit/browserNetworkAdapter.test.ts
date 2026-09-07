/**
 * The Kitchen Codex — BrowserNetworkAdapter (Phase 4D2A).
 *
 * Tests the app-backend fetch transport with an injected fake `fetch`. Covers:
 * allow-list path enforcement (relative /api/ paths only), rejection of all
 * absolute/foreign/schemed URLs and traversal, JSON GET/POST, AbortSignal
 * pass-through, non-2xx normalization (ok:false, no throw), and malformed JSON
 * response handling. No real network calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { BrowserNetworkAdapter } from '../../src/platform/browser';

interface FakeResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function withFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  const adapter = new BrowserNetworkAdapter(spy as never);
  return { adapter, calls, spy };
}

describe('BrowserNetworkAdapter — path enforcement', () => {
  const REJECT = [
    'http://evil.test',
    'https://evil.test',
    '//evil.test/x',
    'ftp://evil.test/x',
    'javascript:alert(1)',
    'data:text/plain,x',
    '/other/foo',
    '',
    '../api/foo',
    '/api/../evil',
  ];

  it.each(REJECT)('rejects %j before any fetch is made', async (badPath) => {
    const { adapter, calls } = withFetch(async () => fakeResponse(200, {}));
    await expect(adapter.get(badPath)).rejects.toThrow();
    expect(calls).toHaveLength(0); // never reached fetch
  });

  it('allows /api/foo and /api/foo?x=1 (relative app paths only)', async () => {
    const { adapter, calls } = withFetch(async (url) => fakeResponse(200, { ok: true }));
    await adapter.get('/api/foo');
    await adapter.get('/api/foo?x=1');
    expect(calls.map((c) => c.url)).toEqual(['/api/foo', '/api/foo?x=1']);
  });

  it('never passes an arbitrary URL to fetch', async () => {
    const { adapter, calls } = withFetch(async (url) => fakeResponse(200, {}));
    for (const bad of ['https://evil.test', '//evil.test', 'data:evil']) {
      await expect(adapter.get(bad)).rejects.toThrow();
    }
    expect(calls.every((c) => !/^(https?:)?\/\//.test(c.url))).toBe(true);
  });
});

describe('BrowserNetworkAdapter — JSON transport', () => {
  it('GET returns parsed JSON and ok', async () => {
    const { adapter } = withFetch(async () => fakeResponse(200, { data: [1, 2] }));
    const res = await adapter.get<{ data: number[] }>('/api/health');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ data: [1, 2] });
  });

  it('POST sends a JSON body with the JSON content-type', async () => {
    const { adapter, calls } = withFetch(async () => fakeResponse(200, { success: true }));
    await adapter.post('/api/estimate-nutrition', { servings: 4 });
    const init = calls[0].init as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ servings: 4 }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('passes an AbortSignal through', async () => {
    const { adapter, calls } = withFetch(async () => fakeResponse(200, {}));
    const controller = new AbortController();
    const signal = controller.signal;
    await adapter.get('/api/foo', { signal });
    expect((calls[0].init as RequestInit).signal).toBe(signal);
  });
});

describe('BrowserNetworkAdapter — response/error semantics', () => {
  it('returns ok:false for non-2xx without throwing', async () => {
    const { adapter } = withFetch(async () => fakeResponse(401, { error: 'unauthorized' }));
    const res = await adapter.get('/api/foo');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.data).toEqual({ error: 'unauthorized' });
  });

  it('handles malformed/empty JSON body as undefined data', async () => {
    const { adapter } = withFetch(async () => fakeResponse(204, {}));
    const res = await adapter.get('/api/foo');
    expect(res.ok).toBe(true);
    expect(res.data).toBeUndefined();
  });

  it('normalizes a transport failure into NetworkRequestError', async () => {
    const { adapter } = withFetch(async () => {
      throw new Error('fetch failed');
    });
    const err = await adapter.get('/api/foo').catch((e) => e);
    expect(err.name).toBe('NetworkRequestError');
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/fetch failed/);
  });
});
