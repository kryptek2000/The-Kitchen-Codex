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
  NetworkRequest,
  NetworkRequestOptions,
  NetworkResponse,
} from '../../application/adapters/NetworkAdapter';

/** Minimal fetch-able signature (avoids depending on the DOM `fetch` type directly). */
export type FetcherLike = (url: string, init?: RequestInit) => Promise<Response>;

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

/**
 * Rejects any path that is not an application-scoped relative backend path.
 * Guards against absolute URLs, schemes, protocol-relative hosts, and traversal.
 */
function assertApiPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new NetworkRequestError(400, 'NetworkAdapter path must not be empty.');
  }
  if (API_PATH.test(path) === false) {
    throw new NetworkRequestError(
      400,
      `NetworkAdapter only accepts application API paths starting with "/api/" (got "${path}").`
    );
  }
  if (path.includes('..')) {
    throw new NetworkRequestError(400, 'NetworkAdapter does not allow path traversal.');
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
  constructor(private readonly fetchFn: FetcherLike = defaultFetcher()) {}

  async request<TResponse = unknown, TBody = unknown>(
    request: NetworkRequest<TBody>
  ): Promise<NetworkResponse<TResponse>> {
    assertApiPath(request.path);

    const signal = request.signal;
    const method = request.method;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(request.headers || {}),
    };
    const init: RequestInit = { method, headers, signal };
    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(request.path, init);
    } catch (err) {
      // Transport-level failure (e.g. network down / aborted). Normalize; no stack.
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
        data = await res.json();
      } catch {
        data = undefined; // non-JSON / empty body
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
}
