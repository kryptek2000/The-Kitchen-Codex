import { describe, it, expect, vi } from 'vitest';
import {
  downloadImageViaBackend,
  BackendImageDownloadError,
  BACKEND_IMAGE_DOWNLOAD_ENDPOINT,
  type BackendFetchLike,
  type BackendResponseLike,
} from '../../src/platform/browser/downloadImageViaBackend';

function fakeResponse(opts: {
  ok: boolean;
  status: number;
  contentType?: string;
  blobText?: string;
  blobError?: boolean;
}): BackendResponseLike {
  return {
    ok: opts.ok,
    status: opts.status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (opts.contentType ?? 'image/jpeg') : null) },
    blob: async () => {
      if (opts.blobError) throw new Error('blob failed');
      return new globalThis.Blob([opts.blobText ?? 'xx'], { type: opts.contentType ?? 'image/jpeg' });
    },
  };
}

describe('downloadImageViaBackend (Phase 4D3C)', () => {
  it('POSTs to the fixed backend proxy endpoint (never the remote URL)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: BackendFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(fakeResponse({ ok: true, status: 200 }));
    };
    const url = 'https://evil.example/photo.png';
    await downloadImageViaBackend(url, { fetchFn });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(BACKEND_IMAGE_DOWNLOAD_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).not.toContain('http'); // no absolute URL targeted
  });

  it('carries the remote image URL as request BODY, not as the endpoint', async () => {
    let sentBody: string | undefined;
    const fetchFn: BackendFetchLike = (url, init) => {
      sentBody = typeof init.body === 'string' ? init.body : undefined;
      return Promise.resolve(fakeResponse({ ok: true, status: 200 }));
    };
    await downloadImageViaBackend('https://r.example/a.jpg', { fetchFn });
    expect(JSON.parse(sentBody as string)).toEqual({ imageUrl: 'https://r.example/a.jpg' });
  });

  it('sends JSON with Content-Type application/json', async () => {
    let headers: Record<string, string> | undefined;
    const fetchFn: BackendFetchLike = (url, init) => {
      headers = (init.headers ?? {}) as Record<string, string>;
      return Promise.resolve(fakeResponse({ ok: true, status: 200 }));
    };
    await downloadImageViaBackend('https://r.example/a.jpg', { fetchFn });
    expect(headers?.['Content-Type']).toBe('application/json');
  });

  it('returns the binary Blob and content type on success', async () => {
    const fetchFn: BackendFetchLike = (url, init) =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, contentType: 'image/png', blobText: 'PNG' }));
    const result = await downloadImageViaBackend('https://r.example/a.png', { fetchFn });
    expect(result.contentType).toBe('image/png');
    const text = await result.blob.text();
    expect(text).toBe('PNG');
  });

  it('throws a normalized error on non-2xx (no direct remote fallback)', async () => {
    const fetchFn: BackendFetchLike = (url, init) =>
      Promise.resolve(fakeResponse({ ok: false, status: 422 }));
    await expect(downloadImageViaBackend('https://r.example/a.jpg', { fetchFn })).rejects.toMatchObject({
      name: 'BackendImageDownloadError',
      status: 422,
    });
  });

  it('surfaces a failed blob() response (does not silently fall back)', async () => {
    const fetchFn: BackendFetchLike = (url, init) =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, blobError: true }));
    await expect(downloadImageViaBackend('https://r.example/a.jpg', { fetchFn })).rejects.toThrow('blob failed');
  });

  it('preserves an injected AbortSignal', async () => {
    let sentSignal: AbortSignal | undefined;
    const fetchFn: BackendFetchLike = (url, init) => {
      sentSignal = init.signal;
      return Promise.resolve(fakeResponse({ ok: true, status: 200 }));
    };
    const controller = new AbortController();
    await downloadImageViaBackend('https://r.example/a.jpg', { fetchFn, signal: controller.signal });
    expect(sentSignal).toBe(controller.signal);
  });

  it('never falls back to a direct fetch of the remote image URL', async () => {
    const fetchFn = vi.fn<BackendFetchLike>(() => Promise.resolve(fakeResponse({ ok: false, status: 500 })));
    await expect(downloadImageViaBackend('https://r.example/a.jpg', { fetchFn })).rejects.toBeInstanceOf(BackendImageDownloadError);
    // The remote image URL must never appear as a request target.
    for (const [url] of fetchFn.mock.calls) {
      expect(url).toBe(BACKEND_IMAGE_DOWNLOAD_ENDPOINT);
      expect(url).not.toBe('https://r.example/a.jpg');
    }
  });
});
