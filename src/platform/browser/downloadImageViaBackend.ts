/**
 * The Kitchen Codex — Browser scoped image download via the backend proxy
 * (Phase 4D3C).
 *
 * A NARROW, shell-scoped binary helper for downloading a remote image through the
 * server-side SSRF-protected proxy. It is deliberately NOT part of the
 * `NetworkAdapter` contract (which stays JSON-only) and is NOT a general
 * arbitrary-URL fetch primitive.
 *
 * SECURITY / SCOPE (must never be weakened):
 *   - The endpoint is HARDCODED to the application backend proxy
 *     (`/api/download-image`). It is NEVER caller-controlled.
 *   - The remote image URL is request BODY data, never the request URL.
 *   - There is NO direct fetch to the remote image URL and NO CORS fallback.
 *     If the server-side proxy rejects/errors, that failure is surfaced — the
 *     client does NOT retry the remote host directly.
 *   - SSRF ownership stays server-side (DNS/IP/private/metadata/redirect/rate
 *     limiting/content-type checks are all server responsibility).
 *
 * Transports the binary reply as a `Blob` for the existing asset-save flow.
 */

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
  /** Cross-runtime cancellation signal. */
  signal?: AbortSignal;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchFn?: BackendFetchLike;
}

export interface BackendImageResult {
  blob: Blob;
  contentType: string;
}

function defaultFetch(): BackendFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

/**
 * POSTs `{ imageUrl }` to the fixed backend proxy endpoint and returns the
 * binary result as a Blob. Throws `BackendImageDownloadError` on a non-2xx
 * response; it NEVER falls back to fetching the remote URL directly.
 */
export async function downloadImageViaBackend(
  imageUrl: string,
  options: DownloadImageOptions = {}
): Promise<BackendImageResult> {
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
  return { blob, contentType };
}
