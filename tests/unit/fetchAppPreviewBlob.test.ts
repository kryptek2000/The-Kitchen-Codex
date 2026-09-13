import { describe, it, expect, vi } from 'vitest';
import {
  fetchAppPreviewBlob,
  BackendImageDownloadError,
} from '../../src/platform/browser/downloadImageViaBackend';

/**
 * `fetchAppPreviewBlob` must accept ONLY the exact app-local preview route.
 * Absolute URLs, protocol-relative URLs, data:/blob:, traversal, alternate API
 * routes, and query/authority tricks are all rejected before any fetch.
 */
describe('fetchAppPreviewBlob — app-local preview route restriction', () => {
  const makeFetch = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      blob: async () => new Blob(['x']),
    }));

  it.each([
    'https://evil.example/x',
    'http://evil.example/x',
    '//evil.example/x',
    'data:image/png;base64,AAAA',
    'blob:https://evil.example/x',
    '/api/recipes/image/generate',
    '/api/recipes/image/preview/../secret',
    '/api/recipes/image/preview/tok?x=1',
    '/api/recipes/image/preview/tok/extra',
    '/api/recipes/image/preview/',
    '',
  ])('rejects %s without fetching', async (path) => {
    const fetchFn = makeFetch();
    await expect(fetchAppPreviewBlob(path, { fetchFn })).rejects.toBeInstanceOf(BackendImageDownloadError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts the exact app-local preview route', async () => {
    const blob = new Blob(['x']);
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      blob: async () => blob,
    }));
    await expect(fetchAppPreviewBlob('/api/recipes/image/preview/abc_DEF-123', { fetchFn })).resolves.toBe(blob);
    expect(fetchFn).toHaveBeenCalledWith('/api/recipes/image/preview/abc_DEF-123', expect.anything());
  });
});
