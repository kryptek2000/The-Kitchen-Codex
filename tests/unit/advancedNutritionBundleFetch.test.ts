// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: bounded same-origin fetch.
 *
 * Proves the browser platform transport enforces fixed same-origin URLs, rejects
 * credentials/redirects/changed final URLs/HTTP errors/malformed responses,
 * streams with an exact incremental byte ceiling (never trusting
 * Content-Length), fails closed on short/long/over-limit/reader-error bodies,
 * and is genuinely retryable (ordinary fetch, not a cached dynamic import).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchAdvancedNutritionBundleAssets,
  type AdvancedNutritionAssetRequest,
} from '../../src/platform/browser/advancedNutritionBundleFetch';

const ORIGIN = 'http://localhost:3000';

function request(name: string, url: string, expectedBytes: number): AdvancedNutritionAssetRequest {
  return { name, url, expectedBytes };
}

function codeOf(result: unknown): string {
  return (result as { code: string }).code;
}

interface FakeResponseOptions {
  readonly ok?: boolean;
  readonly status?: number;
  readonly redirected?: boolean;
  readonly contentLength?: number | string;
  readonly chunks?: ReadonlyArray<Uint8Array>;
  readonly body?: unknown;
  readonly url?: string;
  readonly malformedHeaders?: boolean;
}

function makeResponse(url: string, options: FakeResponseOptions = {}): unknown {
  const chunks = options.chunks ?? [new Uint8Array(0)];
  const body =
    options.body !== undefined
      ? options.body
      : new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
  const headers = new Headers();
  if (options.contentLength !== undefined) headers.set('content-length', String(options.contentLength));
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    redirected: options.redirected ?? false,
    url: options.url ?? url,
    headers: options.malformedHeaders ? {} : headers,
    body,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): void {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(String(url), init))));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('phase 4.5B fetch — exact streaming bounds', () => {
  it('accepts an exact-length single-chunk body', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { chunks: [bytes] }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 5)]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.length).toBe(1);
      expect(Array.from(result.files[0].bytes)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('accepts a multi-chunk exact-length body', async () => {
    mockFetch(() =>
      makeResponse(`${ORIGIN}/assets/a.bin`, { chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])] })
    );
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 5)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.files[0].bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('aborts immediately when the stream exceeds the bound', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])] }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 4)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('too_large');
  });

  it('fails on a short body', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { chunks: [new Uint8Array([1, 2])] }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 5)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('length_mismatch');
  });

  it('does not let a misleading small Content-Length bypass streamed counting', async () => {
    mockFetch(() =>
      makeResponse(`${ORIGIN}/assets/a.bin`, { contentLength: 1, chunks: [new Uint8Array([1, 2, 3, 4, 5, 6])] })
    );
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 5)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('too_large');
  });

  it('rejects early on an oversized Content-Length', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { contentLength: 9999, chunks: [new Uint8Array([1])] }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 5)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('too_large');
  });

  it('works when Content-Length is absent', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { chunks: [new Uint8Array([1, 2, 3])] }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 3)]);
    expect(result.ok).toBe(true);
  });

  it('fails closed on a reader error', async () => {
    const erroredBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('boom'));
      },
    });
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { body: erroredBody }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 3)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('read_error');
  });

  it('fails closed on a non-byte chunk', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { body: { getReader: () => ({ read: async () => ({ done: false, value: 'nope' }), cancel: async () => {} }) } }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 3)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('read_error');
  });
});

describe('phase 4.5B fetch — origin, redirect, and response policy', () => {
  it('rejects a cross-origin URL', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', 'https://evil.example/a.bin', 1)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('cross_origin');
  });

  it('rejects a URL carrying credentials', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', 'http://user:pass@localhost:3000/a.bin', 1)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('cross_origin');
  });

  it('rejects a redirected response', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { redirected: true }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 1)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('redirected');
  });

  it('rejects a changed final URL', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/other.bin`));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 1)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('redirected');
  });

  it('rejects an HTTP error', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { ok: false, status: 404 }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 1)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('http_error');
  });

  it('rejects a missing response body', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`, { body: null }));
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 1)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('read_error');
  });

  it('rejects a malformed response object', async () => {
    mockFetch(() => null);
    const result = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 1)]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('read_error');
  });

  it('rejects an invalid request shape', async () => {
    mockFetch(() => makeResponse(`${ORIGIN}/assets/a.bin`));
    const result = await fetchAdvancedNutritionBundleAssets([
      { name: 'a.bin', url: '/assets/a.bin', expectedBytes: -1 } as unknown as AdvancedNutritionAssetRequest,
    ]);
    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe('invalid_request');
  });
});

describe('phase 4.5B fetch — all-or-nothing and retryability', () => {
  it('discards partial files when a later request fails', async () => {
    mockFetch((url) => {
      if (url.endsWith('b.bin')) return makeResponse(url, { ok: false, status: 500 });
      return makeResponse(url, { chunks: [new Uint8Array([1])] });
    });
    const result = await fetchAdvancedNutritionBundleAssets([
      request('a.bin', '/assets/a.bin', 1),
      request('b.bin', '/assets/b.bin', 1),
    ]);
    expect(result.ok).toBe(false);
    expect((result as { files?: unknown }).files).toBeUndefined();
  });

  it('issues genuine new fetch calls on a subsequent attempt (retryable, not cached)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string) => {
      call += 1;
      if (call === 1) throw new Error('network down');
      return makeResponse(String(url), { chunks: [new Uint8Array([9, 9])] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 2)]);
    expect(first.ok).toBe(false);
    expect(codeOf(first)).toBe('http_error');

    const second = await fetchAdvancedNutritionBundleAssets([request('a.bin', '/assets/a.bin', 2)]);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
