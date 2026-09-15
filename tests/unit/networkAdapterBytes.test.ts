import { describe, it, expect, vi } from 'vitest';
import { BrowserNetworkAdapter } from '../../src/platform/browser/BrowserNetworkAdapter';
import { ObsidianNetworkAdapter } from '../../src/platform/obsidian/ObsidianNetworkAdapter';
import { fetchGeneratedPreviewBytes } from '../../src/application/recipeImageRecovery';

/**
 * Phase 2 — the optional NetworkAdapter binary path used for authenticated
 * transient image-preview fetches. Same `/api/`-only restriction as JSON.
 */
describe('BrowserNetworkAdapter.getBytes — authenticated binary preview transport', () => {
  it('rejects any non-/api/ path (no arbitrary-URL primitive)', async () => {
    const adapter = new BrowserNetworkAdapter(async () => new Response(''));
    await expect(adapter.getBytes('https://evil.example/x.png')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes('//evil.example/x.png')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes('/other/x.png')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes('/api/../secret')).rejects.toMatchObject({ status: 400 });
  });

  it('returns bytes + content type for a 200 response', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const adapter = new BrowserNetworkAdapter(async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    );
    const res = await adapter.getBytes('/api/recipes/image/preview/tok-1');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/png');
    expect(Array.from(res.bytes ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('returns a structural non-2xx result (never throws) and applies headers', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    const adapter = new BrowserNetworkAdapter(fetchMock as never);
    const res = await adapter.getBytes('/api/recipes/image/preview/tok-1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res).toEqual({ status: 401, ok: false });
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });
});

describe('NetworkAdapter — single in-memory endpoint-access authorization', () => {
  const auth = () => ({ Authorization: 'Bearer endpoint-token' });

  it('attaches the configured authorization header to BINARY and JSON requests (same mechanism)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'image/png' } })
    );
    const adapter = new BrowserNetworkAdapter({ fetchFn: fetchMock as never, authorizationHeaders: auth });
    await adapter.getBytes('/api/recipes/image/preview/tok-1');
    const binInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((binInit.headers as Record<string, string>).Authorization).toBe('Bearer endpoint-token');
    // `redirect: 'error'` guarantees the header can never be forwarded off-origin.
    expect(binInit.redirect).toBe('error');

    fetchMock.mockClear();
    await adapter.get('/api/providers');
    const jsonInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((jsonInit.headers as Record<string, string>).Authorization).toBe('Bearer endpoint-token');
  });

  it('sends NO authorization header when unconfigured (unprotected deployment works)', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    const adapter = new BrowserNetworkAdapter({ fetchFn: fetchMock as never });
    await adapter.getBytes('/api/recipes/image/preview/tok-1');
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('rejects an absolute/external URL BEFORE any fetch (token never leaves origin)', async () => {
    const fetchMock = vi.fn();
    const adapter = new BrowserNetworkAdapter({ fetchFn: fetchMock as never, authorizationHeaders: auth });
    await expect(adapter.getBytes('https://evil.example/preview/tok')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the authorization token never appears in the request URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array([1]), { status: 200 }));
    const adapter = new BrowserNetworkAdapter({
      fetchFn: fetchMock as never,
      authorizationHeaders: () => ({ Authorization: 'Bearer SUPER-SECRET-TOKEN' }),
    });
    await adapter.getBytes('/api/recipes/image/preview/tok-1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('SUPER-SECRET-TOKEN');
    expect(url).toContain('/api/recipes/image/preview/tok-1');
  });
});

describe('ObsidianNetworkAdapter.getBytes — authenticated binary transport', () => {
  it('attaches the authorization header and sets redirect:error on the resolved origin', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      status: 200,
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    }));
    const adapter = new ObsidianNetworkAdapter({
      baseUrl: 'https://app.example',
      fetchFn: fetchMock as never,
      authorizationHeaders: () => ({ Authorization: 'Bearer endpoint-token' }),
    });
    const res = await adapter.getBytes('/api/recipes/image/preview/tok-1');
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.example/api/recipes/image/preview/tok-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer endpoint-token');
    expect(init.redirect).toBe('error');
  });
});

describe('fetchGeneratedPreviewBytes — fail closed without an authenticated binary path', () => {
  it('returns undefined when the adapter has NO getBytes (never a bare unauthenticated fetch)', async () => {
    const adapter = { request: vi.fn(), get: vi.fn(), post: vi.fn() } as never;
    const result = await fetchGeneratedPreviewBytes(adapter, 'tok-1');
    expect(result).toBeUndefined();
  });
});
