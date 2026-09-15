/**
 * The Kitchen Codex — Browser Network Adapter (Phase 4D2A).
 *
 * Concrete implementation of the application `NetworkAdapter` port: a thin
 * `fetch` wrapper for the app's OWN backend (`/api/...`).
 *
 * SECURITY / SCOPE (must never be weakened):
 *   - This is APPLICATION API TRANSPORT ONLY. It accepts ONLY relative app
 *     backend paths beginning with `/api/`. It NEVER accepts an arbitrary URL
 *     (http/https/ftp/javascript/data scheme, protocol-relative `//host`, or any
 *     path that does not start with `/api/`), so it cannot be used as an SSRF or
 *     arbitrary-remote-fetch tunnel. Remote URL/image fetching remains SERVER
 *     owned (SSRF-guarded proxies); do not front it here.
 *   - Because only relative `/api/` paths are permitted, `fetch(path, ...)`
 *     resolves against the document base origin (the app backend). No configurable
 *     host is added in this phase.
 *
 * SEMANTICS:
 *   - HTTP non-2xx responses are RETURNED as `{ status, ok:false, data }` (the
 *     contract's shape); the caller decides what to do. They are NOT thrown.
 *   - A normalized `NetworkRequestError` is thrown ONLY for invalid/misuse cases
 *     (bad path before any request) and for transport-level failures (the
 *     `fetch` call itself rejected). It never leaks a server stack.
 *   - `AbortSignal` is passed through. JSON GET/POST are supported; no blob,
 *     streaming, multipart, retry, cache, or offline queue in this phase.
 */

import type {
  NetworkAdapter,
  NetworkBinaryResponse,
  NetworkRequest,
  NetworkRequestOptions,
  NetworkResponse,
} from '../../application/adapters/NetworkAdapter';

/** Minimal fetch-able signature (avoids depending on the DOM `fetch` type directly). */
export type FetcherLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Optional adapter configuration. `authorizationHeaders` is the SINGLE in-memory
 * endpoint-access authorization provider (e.g. `{ Authorization: "Bearer …" }`)
 * applied to EVERY same-origin `/api/` request — JSON and binary alike. It is
 * never persisted and never exposed in a URL/DOM/log/state. Unprotected
 * deployments simply provide none.
 */
export interface BrowserNetworkAdapterOptions {
  fetchFn?: FetcherLike;
  authorizationHeaders?: () => Record<string, string>;
}

/** A normalized, minimal request error (no server stack leaked). */
export class NetworkRequestError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'NetworkRequestError';
    this.status = status;
    this.body = body;
  }
}

const API_PATH = /^\/api\//;

/** Hard bounds before unrestricted allocation (never render raw error bodies). */
const MAX_API_PATH_LENGTH = 2048;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Rejects any path that is not a canonical application-scoped relative backend
 * path. Percent-encoding is decoded (repeatedly, up to a fixed depth) and
 * normalized BEFORE the authorization boundary check, so encoded traversal
 * (`/api/%2e%2e/outside`, double-encoded `%252e`, backslash, NUL) is rejected
 * exactly like its literal form. Absolute URLs, schemes, protocol-relative
 * hosts, non-API paths, malformed encodings, and overlong paths never reach
 * fetch — the endpoint Authorization header can never leave the `/api/` boundary.
 */
function assertApiPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new NetworkRequestError(400, 'NetworkAdapter path must not be empty.');
  }
  if (path.length > MAX_API_PATH_LENGTH) {
    throw new NetworkRequestError(400, 'NetworkAdapter path is too long.');
  }
  let decoded = path;
  try {
    for (let i = 0; i < 4; i += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new NetworkRequestError(400, 'NetworkAdapter path has malformed encoding.');
  }
  if (API_PATH.test(decoded) === false) {
    throw new NetworkRequestError(
      400,
      `NetworkAdapter only accepts application API paths starting with "/api/" (got "${path}").`
    );
  }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new NetworkRequestError(400, 'NetworkAdapter does not allow path traversal.');
  }
}

/** Declared content length when the transport exposes it (pre-allocation guard). */
function responseContentLength(res: { headers?: { get(name: string): string | null } | Headers }): number | undefined {
  try {
    const raw = res.headers?.get('content-length');
    if (raw === undefined || raw === null) return undefined;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function defaultFetcher(): FetcherLike {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    return window.fetch.bind(window);
  }
  // Node/browser-simulated runtime (used by tests); real browser always supplies fetch.
  return (url, init) => (globalThis.fetch as FetcherLike)(url, init);
}

export class BrowserNetworkAdapter implements NetworkAdapter {
  private readonly fetchFn: FetcherLike;
  private readonly authorizationHeaders: () => Record<string, string>;

  constructor(fetchOrOptions: FetcherLike | BrowserNetworkAdapterOptions = {}) {
    if (typeof fetchOrOptions === 'function') {
      this.fetchFn = fetchOrOptions;
      this.authorizationHeaders = () => ({});
    } else {
      this.fetchFn = fetchOrOptions.fetchFn ?? defaultFetcher();
      this.authorizationHeaders = fetchOrOptions.authorizationHeaders ?? (() => ({}));
    }
  }

  /** In-memory endpoint-access headers applied to every same-origin `/api/` call. */
  private authHeaders(): Record<string, string> {
    try {
      return { ...(this.authorizationHeaders() || {}) };
    } catch {
      return {};
    }
  }

  /**
   * Merges caller headers under the TRUSTED endpoint Authorization value. When
   * a trusted value is configured, any caller-supplied Authorization (any
   * casing) is discarded: callers can neither replace, duplicate, nor suppress
   * it. When unconfigured, caller headers pass through untouched (existing
   * per-request auth behavior is preserved).
   */
  private mergedHeaders(caller?: Record<string, string>): Record<string, string> {
    const trusted = this.authHeaders();
    const hasTrustedAuth = Object.keys(trusted).some((key) => key.toLowerCase() === 'authorization');
    const safe: Record<string, string> = {};
    if (caller) {
      for (const [key, value] of Object.entries(caller)) {
        if (hasTrustedAuth && key.toLowerCase() === 'authorization') continue;
        safe[key] = value;
      }
    }
    return { ...safe, ...trusted };
  }

  /**
   * Bounded JSON decode: the declared length is checked before allocation and
   * the materialized body is capped after. Oversized or unreadable bodies fail
   * closed (never thrown raw into the UI; non-2xx callers get `ok:false`).
   */
  private async decodeJsonBody(res: Response): Promise<unknown> {
    const declared = responseContentLength(res);
    if (declared !== undefined && declared > MAX_JSON_RESPONSE_BYTES) {
      throw new NetworkRequestError(502, 'Network response body is too large.');
    }
    if (typeof res.text === 'function') {
      const text = await res.text();
      if (text.length > MAX_JSON_RESPONSE_BYTES) {
        throw new NetworkRequestError(502, 'Network response body is too large.');
      }
      if (!text) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined; // non-JSON / empty body
      }
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return undefined; // non-JSON / empty body
    }
    try {
      if (JSON.stringify(data)?.length > MAX_JSON_RESPONSE_BYTES) {
        throw new NetworkRequestError(502, 'Network response body is too large.');
      }
    } catch (err) {
      if (err instanceof NetworkRequestError) throw err;
      return undefined;
    }
    return data;
  }

  async request<TResponse = unknown, TBody = unknown>(
    request: NetworkRequest<TBody>
  ): Promise<NetworkResponse<TResponse>> {
    assertApiPath(request.path);

    const signal = request.signal;
    const method = request.method;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.mergedHeaders(request.headers),
    };
    // `redirect: 'error'` on EVERY app request (JSON and binary alike): the
    // endpoint Authorization header can never be forwarded off-origin by a
    // followed redirect. A redirect therefore surfaces as a transport failure.
    const init: RequestInit = { method, headers, signal, redirect: 'error' };
    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(request.path, init);
    } catch (err) {
      // Transport-level failure (e.g. network down / aborted / redirect
      // rejected). Normalize; no stack, no raw body.
      if (err instanceof NetworkRequestError) throw err;
      throw new NetworkRequestError(
        0,
        err instanceof Error ? err.message : 'Network request failed.',
        undefined
      );
    }

    const status = res.status;
    const ok = res.ok;
    let data: unknown = undefined;
    if (status !== 204) {
      try {
        data = await this.decodeJsonBody(res);
      } catch (err) {
        if (err instanceof NetworkRequestError) throw err;
        data = undefined;
      }
    }

    return { status, ok, data: data as TResponse | undefined };
  }

  async get<TResponse = unknown>(
    path: string,
    options?: NetworkRequestOptions
  ): Promise<NetworkResponse<TResponse>> {
    return this.request<TResponse, undefined>({ method: 'GET', path, ...options });
  }

  async post<TResponse = unknown, TBody = unknown>(
    path: string,
    body: TBody,
    options?: NetworkRequestOptions
  ): Promise<NetworkResponse<TResponse>> {
    return this.request<TResponse, TBody>({ method: 'POST', path, body, ...options });
  }

  /**
   * Binary GET for app-local byte responses (transient image previews). Same
   * `/api/`-only path restriction and header passthrough as JSON requests. A
   * non-2xx response is returned structurally (never thrown); the caller decides.
   */
  async getBytes(path: string, options?: NetworkRequestOptions): Promise<NetworkBinaryResponse> {
    assertApiPath(path);
    let res: Response;
    try {
      res = await this.fetchFn(path, {
        method: 'GET',
        // Same endpoint-access authorization as JSON requests. `redirect: 'error'`
        // guarantees the authorization header can never be forwarded off-origin.
        headers: this.mergedHeaders(options?.headers),
        redirect: 'error',
        signal: options?.signal,
      });
    } catch (err) {
      if (err instanceof NetworkRequestError) throw err;
      throw new NetworkRequestError(
        0,
        err instanceof Error ? err.message : 'Network request failed.',
        undefined
      );
    }
    if (!res.ok) return { status: res.status, ok: false };
    const declared = responseContentLength(res);
    if (declared !== undefined && declared > MAX_BINARY_RESPONSE_BYTES) {
      throw new NetworkRequestError(502, 'Network response body is too large.');
    }
    const contentType = res.headers.get('content-type') || undefined;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BINARY_RESPONSE_BYTES) {
      throw new NetworkRequestError(502, 'Network response body is too large.');
    }
    return {
      status: res.status,
      ok: true,
      bytes: new Uint8Array(buffer),
      ...(contentType ? { contentType } : {}),
    };
  }
}
