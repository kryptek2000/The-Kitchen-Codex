import { describe, it, expect } from 'vitest';
import { ObsidianNetworkAdapter, ObsidianNetworkError } from '../../src/platform/obsidian/ObsidianNetworkAdapter';
import type { ObsidianFetchLike } from '../../src/platform/obsidian/ObsidianNetworkAdapter';

function jsonResponse(status: number, body: unknown): { status: number; ok: boolean; json(): Promise<unknown> } {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

describe('ObsidianNetworkAdapter (Phase 4D3B)', () => {
  it('accepts an /api/... path and prepends the configured base origin', async () => {
    let called = '';
    const fetchFn: ObsidianFetchLike = (_url, init) => {
      called = _url;
      return Promise.resolve(jsonResponse(200, { ok: true }));
    };
    const adapter = new ObsidianNetworkAdapter({ baseUrl: 'http://127.0.0.1:3000', fetchFn });
    const res = await adapter.post<{ ok: boolean }>('/api/kitchen/interpret', { question: 'chicken' });
    expect(called).toBe('http://127.0.0.1:3000/api/kitchen/interpret');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ok: true });
  });

  it('rejects an absolute https path (no arbitrary-URL primitive)', async () => {
    const adapter = new ObsidianNetworkAdapter({ fetchFn: () => Promise.resolve(jsonResponse(200, {})) });
    await expect(adapter.get('https://evil.example/x')).rejects.toBeInstanceOf(ObsidianNetworkError);
    await expect(adapter.get('//evil.example/x')).rejects.toBeInstanceOf(ObsidianNetworkError);
  });

  it('rejects traversal in the api path', async () => {
    const adapter = new ObsidianNetworkAdapter({ fetchFn: () => Promise.resolve(jsonResponse(200, {})) });
    await expect(adapter.get('/api/../secret')).rejects.toBeInstanceOf(ObsidianNetworkError);
  });

  it('rejects a non-http baseUrl', async () => {
    expect(() => new ObsidianNetworkAdapter({ baseUrl: 'ftp://x' })).toThrow(ObsidianNetworkError);
    expect(() => new ObsidianNetworkAdapter({ baseUrl: 'not-a-url' })).toThrow(ObsidianNetworkError);
  });

  it('sends a JSON body with Content-Type application/json', async () => {
    let sentInit: RequestInit | undefined;
    const fetchFn: ObsidianFetchLike = (_url, init) => {
      sentInit = init;
      return Promise.resolve(jsonResponse(200, { ok: true }));
    };
    const adapter = new ObsidianNetworkAdapter({ baseUrl: 'http://x', fetchFn });
    await adapter.post('/api/grab-recipe', { url: 'https://recipe.example' });
    expect((sentInit?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(sentInit?.body))).toEqual({ url: 'https://recipe.example' });
  });

  it('returns status/ok/data structurally for non-2xx without throwing', async () => {
    const adapter = new ObsidianNetworkAdapter({
      fetchFn: () => Promise.resolve(jsonResponse(422, { error: 'bad' })),
    });
    const res = await adapter.get('/api/kitchen/interpret');
    expect(res.status).toBe(422);
    expect(res.ok).toBe(false);
    expect(res.data).toEqual({ error: 'bad' });
  });

  it('normalizes malformed JSON to undefined data', async () => {
    const fetchFn: ObsidianFetchLike = () =>
      Promise.resolve({ status: 200, ok: true, json: async () => { throw new Error('bad json'); } });
    const adapter = new ObsidianNetworkAdapter({ fetchFn });
    const res = await adapter.get('/api/health');
    expect(res.data).toBeUndefined();
  });

  it('preserves an injected AbortSignal', async () => {
    let sentSignal: AbortSignal | undefined;
    const fetchFn: ObsidianFetchLike = (_url, init) => {
      sentSignal = init.signal;
      return Promise.resolve(jsonResponse(200, {}));
    };
    const adapter = new ObsidianNetworkAdapter({ fetchFn });
    const controller = new AbortController();
    await adapter.get('/api/health', { signal: controller.signal });
    expect(sentSignal).toBe(controller.signal);
  });

  it('throws a normalized error on transport failure', async () => {
    const adapter = new ObsidianNetworkAdapter({
      fetchFn: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(adapter.get('/api/health')).rejects.toMatchObject({ name: 'ObsidianNetworkError', status: 0 });
  });
});
