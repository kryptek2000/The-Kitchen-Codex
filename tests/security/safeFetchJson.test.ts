import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dns from 'dns/promises';
import { EventEmitter } from 'node:events';

/**
 * Dedicated `safeFetchJson` security tests. The PRODUCTION fetcher is exercised
 * (no duplicate implementation): DNS is scripted and the HTTPS transport is
 * mocked, so no real network is used.
 */

interface FakeResponseOptions {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
  emitErrorAfter?: number;
}

function makeResponse(opts: FakeResponseOptions): any {
  const emitter = new EventEmitter() as any;
  emitter.statusCode = opts.statusCode ?? 200;
  emitter.headers = opts.headers ?? {};
  let index = 0;
  let destroyed = false;
  emitter.destroy = () => {
    destroyed = true;
  };
  emitter.wasDestroyed = () => destroyed;
  emitter[Symbol.asyncIterator] = () => ({
    async next() {
      if (destroyed) return { done: true };
      if (opts.emitErrorAfter !== undefined && index === opts.emitErrorAfter) {
        throw new Error('stream failed');
      }
      const chunks = opts.chunks ?? [];
      if (index >= chunks.length) return { done: true };
      return { done: false, value: chunks[index++] };
    },
  });
  return emitter;
}

const scripted = new Map<string, string[]>();
const requestMock = vi.fn();
const realLookup = dns.lookup.bind(dns);

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

vi.mock('https', () => ({
  default: { request: (...args: unknown[]) => requestMock(...args) },
  request: (...args: unknown[]) => requestMock(...args),
}));
vi.mock('http', () => ({
  default: { request: (...args: unknown[]) => requestMock(...args) },
  request: (...args: unknown[]) => requestMock(...args),
}));

const { safeFetchJson } = await import('../../server/ssrfGuard');

beforeEach(() => {
  scripted.clear();
  requestMock.mockReset();
  (dns as unknown as Record<string, unknown>).lookup = (hostname: string) => {
    const addresses = scripted.get(String(hostname).toLowerCase());
    if (!addresses) return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    return Promise.resolve(addresses.map((address) => ({ address, family: 4 })));
  };
});

afterEach(() => {
  (dns as unknown as Record<string, unknown>).lookup = realLookup;
});

function scriptResponse(response: any): void {
  requestMock.mockImplementation((_options: unknown, callback?: (res: any) => void) => {
    const req: any = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      if (callback) queueMicrotask(() => callback(response));
    };
    return req;
  });
}

describe('safeFetchJson — production fetcher security', () => {
  it('parses an HTTPS JSON success (fixed endpoint)', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    scriptResponse(makeResponse({ headers: { 'content-type': 'application/json' }, chunks: [encode('{"ok":true}')] }));
    await expect(safeFetchJson('https://api.openverse.org/v1/images/')).resolves.toEqual({ ok: true });
  });

  it('rejects non-JSON MIME before parsing', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    const res = makeResponse({ headers: { 'content-type': 'text/html' }, chunks: [encode('<html>RAW_BODY_SENTINEL</html>')] });
    scriptResponse(res);
    await expect(safeFetchJson('https://api.openverse.org/x')).rejects.toThrow(/not JSON/i);
    expect(res.wasDestroyed()).toBe(true);
  });

  it('rejects malformed JSON without leaking the body', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    scriptResponse(makeResponse({ headers: { 'content-type': 'application/json' }, chunks: [encode('{not json')] }));
    let message = '';
    try {
      await safeFetchJson('https://api.openverse.org/x');
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toMatch(/not valid JSON/i);
    expect(message).not.toContain('{not json');
  });

  it('rejects an oversized Content-Length before reading', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    const res = makeResponse({ headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) }, chunks: [] });
    scriptResponse(res);
    await expect(safeFetchJson('https://api.openverse.org/x', { maxBytes: 1024 })).rejects.toThrow(/size limit/i);
    expect(res.wasDestroyed()).toBe(true);
  });

  it('cancels a streamed overflow', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    const res = makeResponse({
      headers: { 'content-type': 'application/json' },
      chunks: [new Uint8Array(2048), new Uint8Array(2048)],
    });
    scriptResponse(res);
    await expect(safeFetchJson('https://api.openverse.org/x', { maxBytes: 1024 })).rejects.toThrow(/size limit/i);
    expect(res.wasDestroyed()).toBe(true);
  });

  it('follows a redirect only to a revalidated public address', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    scripted.set('cdn.example.com', ['93.184.216.35']);
    let call = 0;
    requestMock.mockImplementation((_options: unknown, callback?: (res: any) => void) => {
      const req: any = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        const response = call++ === 0
          ? makeResponse({ statusCode: 302, headers: { location: 'https://cdn.example.com/data.json' } })
          : makeResponse({ headers: { 'content-type': 'application/json' }, chunks: [encode('{"ok":1}')] });
        if (callback) queueMicrotask(() => callback(response));
      };
      return req;
    });
    await expect(safeFetchJson('https://api.openverse.org/x')).resolves.toEqual({ ok: 1 });
  });

  it('rejects a redirect to a private/metadata address', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    scripted.set('metadata.google.internal', ['169.254.169.254']);
    requestMock.mockImplementation((_options: unknown, callback?: (res: any) => void) => {
      const req: any = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        const response = makeResponse({ statusCode: 302, headers: { location: 'http://metadata.google.internal/latest' } });
        if (callback) queueMicrotask(() => callback(response));
      };
      return req;
    });
    await expect(safeFetchJson('https://api.openverse.org/x')).rejects.toThrow(/restricted|resolve/i);
  });

  it('rejects loopback/metadata/credentialed/non-http targets without any request', async () => {
    await expect(safeFetchJson('http://127.0.0.1/x')).rejects.toThrow(/restricted/i);
    await expect(safeFetchJson('http://169.254.169.254/latest')).rejects.toThrow(/restricted/i);
    await expect(safeFetchJson('https://user:pass@api.openverse.org/x')).rejects.toThrow(/credentials/i);
    await expect(safeFetchJson('file:///etc/passwd')).rejects.toThrow(/permitted/i);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('surfaces a bounded timeout error (no raw details)', async () => {
    scripted.set('api.openverse.org', ['93.184.216.34']);
    requestMock.mockImplementation((options: any) => {
      const req: any = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {};
      const signal: AbortSignal | undefined = options?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          req.emit('error', Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        });
      }
      return req;
    });
    await expect(safeFetchJson('https://api.openverse.org/x', { timeoutMs: 5 })).rejects.toThrow(/timed out/i);
  });
});
