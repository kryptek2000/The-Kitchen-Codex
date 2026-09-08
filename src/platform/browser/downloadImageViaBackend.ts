/**
 * The Kitchen Codex — Browser scoped image download via the backend proxy
 * (Phase 4D3C, refined 4D3D).
 *
 * A NARROW, shell-scoped binary helper for downloading a remote image through the
 * server-side SSRF-protected proxy, returned as platform-neutral bytes. It is the
 * concrete browser implementation of the application `RemoteImageDownloader` port
 * and is NOT part of the `NetworkAdapter` contract (which stays JSON-only).
 *
 * SECURITY / SCOPE (must never be weakened):
 *   - The endpoint is HARDCODED to the application backend proxy
 *     (`/api/download-image`). It is NEVER caller-controlled.
 *   - The remote image URL is request BODY data, never the request URL.
 *   - No direct fetch to the remote image URL and no CORS fallback. A proxy
 *     failure is surfaced; the client does NOT retry the remote host directly.
 *   - SSRF ownership stays server-side (DNS/IP/private/metadata/redirect/rate
 *     limiting/content-type checks are server responsibility).
 *
 * Returns `Uint8Array` (platform-neutral); the browser render layer converts bytes
 * to Blob/object-URL as needed.
 */

import type { AssetBytes, RemoteImageDownloader } from '../../application/adapters/AssetAdapter';

/** The fixed backend proxy endpoint this helper may target. */
export const BACKEND_IMAGE_DOWNLOAD_ENDPOINT = '/api/download-image';

/** A minimal response shape (the browser/Node `Response` satisfies this). */
export interface BackendResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  blob(): Promise<Blob>;
}

export type BackendFetchLike = (url: string, init: RequestInit) => Promise<BackendResponseLike>;

/** Normalized error for a failed backend image download (no remote-host fallback). */
export class BackendImageDownloadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BackendImageDownloadError';
    this.status = status;
  }
}

export interface DownloadImageOptions {
  signal?: AbortSignal;
  fetchFn?: BackendFetchLike;
}

function defaultFetch(): BackendFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

/**
 * POSTs `{ imageUrl }` to the fixed backend proxy endpoint and returns the binary
 * result as platform-neutral bytes. Throws `BackendImageDownloadError` on a
 * non-2xx response; it NEVER falls back to fetching the remote URL directly.
 */
export async function downloadImageViaBackend(
  imageUrl: string,
  options: DownloadImageOptions = {}
): Promise<AssetBytes> {
  const fetchFn = options.fetchFn ?? defaultFetch();
  const res = await fetchFn(BACKEND_IMAGE_DOWNLOAD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl: String(imageUrl ?? '').trim() }),
    signal: options.signal,
  });

  if (!res.ok) {
    throw new BackendImageDownloadError(res.status, `Image download failed (HTTP ${res.status}).`);
  }

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buffer), contentType };
}

/** The browser-shell concrete implementation of the application download port. */
export const browserRemoteImageDownloader: RemoteImageDownloader = {
  downloadRemoteImage(imageUrl: string, options?: { signal?: AbortSignal }): Promise<AssetBytes> {
    return downloadImageViaBackend(imageUrl, { signal: options?.signal });
  },
};
