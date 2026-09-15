import { describe, it, expect, vi } from 'vitest';
import { BrowserNetworkAdapter } from '../../src/platform/browser/BrowserNetworkAdapter';
import { ObsidianNetworkAdapter } from '../../src/platform/obsidian/ObsidianNetworkAdapter';

/**
 * I3 — adversarial browser + Obsidian adapter parity.
 *
 * JSON and binary share ONE canonical rule set in both adapters:
 * decode-then-validate paths (encoded traversal rejected), trusted endpoint
 * Authorization wins over caller headers case-insensitively, redirect:'error'
 * everywhere, bounded bodies, no raw error rendering, no auth outside /api/.
 */

const TRUSTED = () => ({ Authorization: 'Bearer trusted-endpoint-token' });

function browserResponse(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function obsidianOk(body: unknown) {
  return { status: 200, ok: true, json: async () => body, headers: { get: () => 'application/json' } };
}

const ENCODED_TRAVERSAL = [
  '/api/%2e%2e/outside',
  '/api/%2E%2E/outside',
  '/api/%252e%252e/outside',
  '/api/%c0%ae%c0%ae/outside',
  '/api/..%2foutside',
  '/api/%2e%2e%2foutside',
  '/api/./%2e%2e/outside',
];

const NON_API = [
  'https://evil.example/api/x',
  'http://evil.example/api/x',
  '//evil.example/api/x',
  'ftp://evil.example/x',
  'javascript:alert(1)',
  'data:text/plain,x',
  '/other/x',
  '',
  '../api/x',
  '/api/../x',
  '/api/%00/x',
  '/api/a\\b',
];

describe.each([
  ['browser', (fetchFn: never, auth?: () => Record<string, string>) => new BrowserNetworkAdapter({ fetchFn, ...(auth ? { authorizationHeaders: auth } : {}) })],
  ['obsidian', (fetchFn: never, auth?: () => Record<string, string>) => new ObsidianNetworkAdapter({ fetchFn, ...(auth ? { authorizationHeaders: auth } : {}) })],
])('%s adapter — canonical path rules', (_kind, make) => {
  it.each(ENCODED_TRAVERSAL)('rejects encoded traversal %j on JSON before fetch', async (bad) => {
    const spy = vi.fn();
    const adapter = make(spy as never, TRUSTED);
    await expect(adapter.get(bad)).rejects.toMatchObject({ status: 400 });
    await expect(adapter.post(bad, {})).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(ENCODED_TRAVERSAL)('rejects encoded traversal %j on binary before fetch', async (bad) => {
    const spy = vi.fn();
    const adapter = make(spy as never, TRUSTED);
    await expect(adapter.getBytes!(bad)).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(NON_API)('rejects non-API path %j on JSON and binary before fetch', async (bad) => {
    const spy = vi.fn();
    const adapter = make(spy as never, TRUSTED);
    await expect(adapter.get(bad)).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getBytes!(bad)).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects malformed percent-encoding before fetch', async () => {
    const spy = vi.fn();
    const adapter = make(spy as never, TRUSTED);
    await expect(adapter.get('/api/%zz')).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe.each([
  ['browser', (fetchFn: never, auth?: () => Record<string, string>) => new BrowserNetworkAdapter({ fetchFn, ...(auth ? { authorizationHeaders: auth } : {}) })],
  ['obsidian', (fetchFn: never, auth?: () => Record<string, string>) => new ObsidianNetworkAdapter({ fetchFn, ...(auth ? { authorizationHeaders: auth } : {}) })],
])('%s adapter — trusted Authorization precedence', (_kind, make) => {
  it('trusted value wins over caller Authorization on JSON (exact case)', async () => {
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init!);
      return (_kind === 'browser' ? browserResponse(200, { ok: true }) : obsidianOk({ ok: true })) as never;
    });
    const adapter = make(fetchFn as never, TRUSTED);
    await adapter.post('/api/x', {}, { headers: { Authorization: 'Bearer evil' } });
    expect((seen[0].headers as Record<string, string>).Authorization).toBe('Bearer trusted-endpoint-token');
  });

  it('caller cannot suppress trusted Authorization with an empty value or case variant', async () => {
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init!);
      return (_kind === 'browser' ? browserResponse(200, { ok: true }) : obsidianOk({ ok: true })) as never;
    });
    const adapter = make(fetchFn as never, TRUSTED);
    await adapter.get('/api/x', { headers: { Authorization: '', authorization: 'Bearer evil', AUTHORIZATION: 'Bearer evil2' } });
    const headers = seen[0].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer trusted-endpoint-token');
    expect(headers.authorization).toBeUndefined();
    expect(headers.AUTHORIZATION).toBeUndefined();
    const authValues = Object.entries(headers)
      .filter(([k]) => k.toLowerCase() === 'authorization')
      .map(([, v]) => v);
    expect(authValues).toEqual(['Bearer trusted-endpoint-token']);
  });

  it('caller Authorization passes through only when no trusted value is configured', async () => {
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init!);
      return (_kind === 'browser' ? browserResponse(200, { ok: true }) : obsidianOk({ ok: true })) as never;
    });
    const adapter = make(fetchFn as never);
    await adapter.get('/api/x', { headers: { Authorization: 'Bearer caller' } });
    expect((seen[0].headers as Record<string, string>).Authorization).toBe('Bearer caller');
  });

  it('missing/invalid endpoint access sends NO Authorization (fail closed, still functional)', async () => {
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init!);
      return (_kind === 'browser' ? browserResponse(200, { ok: true }) : obsidianOk({ ok: true })) as never;
    });
    const adapter = make(fetchFn as never, () => ({}));
    await adapter.get('/api/x');
    await adapter.getBytes!('/api/recipes/image/preview/tok');
    expect((seen[0].headers as Record<string, string>).Authorization).toBeUndefined();
    expect((seen[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('token replacement is reflected immediately on JSON and binary', async () => {
    let token = 'first';
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init!);
      return (_kind === 'browser'
        ? new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } })
        : { status: 200, ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1]).buffer }) as never;
    });
    const adapter = make(fetchFn as never, () => ({ Authorization: `Bearer ${token}` }));
    await adapter.get('/api/x');
    token = 'second';
    await adapter.getBytes!('/api/recipes/image/preview/tok');
    expect((seen[0].headers as Record<string, string>).Authorization).toBe('Bearer first');
    expect((seen[1].headers as Record<string, string>).Authorization).toBe('Bearer second');
  });
});

describe.each([
  ['browser', (fetchFn: never, auth?: () => Record<string, string>) => new BrowserNetworkAdapter({ fetchFn, ...(auth ? { authorizationHeaders: auth } : {}) })],
  ['obsidian', (fetchFn: never, auth?: () => Record<string, string>) => new ObsidianNetworkAdapter({ fetchFn, ...(auth ? { authorizationHeaders: auth } : {}) })],
])('%s adapter — redirect and body bounds', (_kind, make) => {
  it("sets redirect:'error' on JSON and binary (auth never forwarded)", async () => {
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init!);
      return (_kind === 'browser'
        ? new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } })
        : { status: 200, ok: true, json: async () => ({}), headers: { get: () => 'application/json' }, arrayBuffer: async () => new Uint8Array([1]).buffer }) as never;
    });
    const adapter = make(fetchFn as never, TRUSTED);
    await adapter.get('/api/x');
    await adapter.getBytes!('/api/recipes/image/preview/tok');
    expect(seen[0].redirect).toBe('error');
    expect(seen[1].redirect).toBe('error');
  });

  it('rejects oversized JSON before unrestricted allocation', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    const fetchFn = vi.fn(async () =>
      (_kind === 'browser'
        ? new Response(JSON.stringify({ blob: big }), { status: 200, headers: { 'content-type': 'application/json' } })
        : { status: 200, ok: true, json: async () => ({ blob: big }), headers: { get: () => 'application/json' } }) as never
    );
    const adapter = make(fetchFn as never, TRUSTED);
    await expect(adapter.get('/api/x')).rejects.toMatchObject({ status: 502 });
  });

  it('rejects oversized binary before unrestricted allocation', async () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    const fetchFn = vi.fn(async () =>
      (_kind === 'browser'
        ? new Response(big, { status: 200, headers: { 'content-type': 'image/png' } })
        : { status: 200, ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => big.buffer }) as never
    );
    const adapter = make(fetchFn as never, TRUSTED);
    await expect(adapter.getBytes!('/api/recipes/image/preview/tok')).rejects.toMatchObject({ status: 502 });
  });

  it('never renders raw error bodies (non-2xx stays structural)', async () => {
    const fetchFn = vi.fn(async () =>
      (_kind === 'browser'
        ? browserResponse(500, { error: 'stack-trace-with-secrets', detail: 'x'.repeat(100) })
        : { status: 500, ok: false, json: async () => ({ error: 'stack-trace-with-secrets' }), headers: { get: () => 'application/json' } }) as never
    );
    const adapter = make(fetchFn as never, TRUSTED);
    const res = await adapter.get('/api/x');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it('external absolute binary URLs are rejected before fetch (token never leaves origin)', async () => {
    const spy = vi.fn();
    const adapter = make(spy as never, TRUSTED);
    await expect(adapter.getBytes!('https://evil.example/preview/tok')).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
  });
});
