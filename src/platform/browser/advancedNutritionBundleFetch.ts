/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: bounded same-origin asset
 * fetch (browser platform transport).
 *
 * This is the ONLY network access on the Phase 4.5B runtime path. It fetches the
 * fixed, compile-time-owned bundle assets from the application's own origin with
 * ordinary retryable `fetch` semantics (no dynamic module import, so a failed
 * request can be retried). It:
 *   - accepts only a closed list of `{ name, url, expectedBytes }` requests;
 *   - resolves each URL against the current document and REQUIRES same-origin;
 *   - rejects URLs carrying credentials and rejects redirects / changed final
 *     URLs (no silent substitution to another origin);
 *   - uses `cache: 'no-store'` so a retry issues a genuine new request;
 *   - streams each body with a hard incremental ceiling equal to the exact
 *     expected locked length (never trusting `Content-Length` alone);
 *   - fails closed on an over-limit stream, a short/long body, a missing body, a
 *     malformed response, an HTTP error, or a reader error;
 *   - discards all partial inputs if any request or read fails.
 *
 * It never echoes a URL, path, response body, or exception message. Failures use
 * a fixed, bounded, closed code vocabulary.
 */

export interface AdvancedNutritionAssetRequest {
  readonly name: string;
  readonly url: string;
  readonly expectedBytes: number;
}

export interface AdvancedNutritionAssetBytes {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type AdvancedNutritionAssetFetchFailureCode =
  | 'invalid_request'
  | 'cross_origin'
  | 'http_error'
  | 'redirected'
  | 'too_large'
  | 'length_mismatch'
  | 'read_error';

export type AdvancedNutritionAssetFetchResult =
  | { readonly ok: true; readonly files: ReadonlyArray<AdvancedNutritionAssetBytes> }
  | { readonly ok: false; readonly code: AdvancedNutritionAssetFetchFailureCode };

interface SingleFetchResult {
  readonly ok: true;
  readonly file: AdvancedNutritionAssetBytes;
}

function fail(code: AdvancedNutritionAssetFetchFailureCode): { ok: false; code: AdvancedNutritionAssetFetchFailureCode } {
  return { ok: false, code };
}

function isBoundedExpectedBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function currentLocation(): Location | null {
  const location = (globalThis as { location?: Location }).location;
  if (!location || typeof location.href !== 'string' || typeof location.origin !== 'string') {
    return null;
  }
  return location;
}

async function fetchOne(
  request: AdvancedNutritionAssetRequest,
  location: Location
): Promise<SingleFetchResult | { ok: false; code: AdvancedNutritionAssetFetchFailureCode }> {
  if (
    !request ||
    typeof request.name !== 'string' ||
    typeof request.url !== 'string' ||
    !isBoundedExpectedBytes(request.expectedBytes)
  ) {
    return fail('invalid_request');
  }

  let resolved: URL;
  try {
    resolved = new URL(request.url, location.href);
  } catch {
    return fail('invalid_request');
  }
  if (resolved.origin !== location.origin) return fail('cross_origin');
  if (resolved.username !== '' || resolved.password !== '') return fail('cross_origin');

  let response: Response;
  try {
    response = await (globalThis.fetch as typeof fetch)(resolved.href, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return fail('http_error');
  }

  if (!response || typeof response !== 'object') return fail('read_error');
  if (response.ok !== true) return fail('http_error');
  if (response.redirected === true) return fail('redirected');

  let finalUrl: URL;
  try {
    finalUrl = new URL(String(response.url));
  } catch {
    return fail('redirected');
  }
  if (finalUrl.origin !== location.origin) return fail('cross_origin');
  if (finalUrl.pathname !== resolved.pathname) return fail('redirected');

  const headers = response.headers;
  if (headers && typeof headers.get === 'function') {
    const contentLength = headers.get('content-length');
    if (contentLength !== null && contentLength !== undefined) {
      const declared = Number(contentLength);
      // `Content-Length` is only an early rejection signal; it is never trusted
      // as the authoritative size.
      if (Number.isFinite(declared) && declared > request.expectedBytes) return fail('too_large');
    }
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') return fail('read_error');
  const reader = body.getReader();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        return fail('read_error');
      }
      total += value.byteLength;
      if (total > request.expectedBytes) {
        await reader.cancel().catch(() => undefined);
        return fail('too_large');
      }
      chunks.push(value);
    }
  } catch {
    return fail('read_error');
  }

  if (total !== request.expectedBytes) return fail('length_mismatch');

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, file: { name: request.name, bytes } };
}

/**
 * Fetches the fixed bundle assets with exact-length streaming bounds. All or
 * nothing: any failure returns a fixed code and no partial files.
 */
export async function fetchAdvancedNutritionBundleAssets(
  requests: ReadonlyArray<AdvancedNutritionAssetRequest>
): Promise<AdvancedNutritionAssetFetchResult> {
  const location = currentLocation();
  if (!location) return fail('invalid_request');
  if (!Array.isArray(requests) || requests.length === 0) return fail('invalid_request');

  const files: AdvancedNutritionAssetBytes[] = [];
  for (const request of requests) {
    const result = await fetchOne(request, location);
    if (!result.ok) return fail((result as { code: AdvancedNutritionAssetFetchFailureCode }).code);
    files.push(result.file);
  }
  return { ok: true, files };
}
