/**
 * The Kitchen Codex — NetworkAdapter contract (Phase 4C1).
 *
 * Application-facing HTTP/API transport port. Its purpose is to let future
 * application/UI code stop hardcoding `fetch('/api/...')` against a co-located
 * Express server, so the same orchestration can run against a hosted backend, an
 * Obsidian plugin, or a PWA.
 *
 * IMPORTANT SECURITY DISTINCTION:
 *   This is APPLICATION API TRANSPORT, NOT a generic arbitrary-URL fetch tunnel.
 *   `path` is an application-scoped API path (e.g. `/api/kitchen/interpret`),
 *   resolved by the implementation against the application's OWN backend origin.
 *   It deliberately does NOT expose an "fetch any URL" primitive. Arbitrary remote
 *   fetching and SSRF-guarded URL/image fetching remain a SERVER responsibility
 *   and must NOT be fronted by this adapter.
 *
 * Portability: light-weight, custom request/response types are used instead of
 * the DOM `Request`/`Response` classes. `AbortSignal` is the one cross-runtime
 * primitive referenced and is available in both Node (17.3+) and all modern
 * browsers/workers.
 *
 * This is a CONTRACT ONLY. No concrete implementation (and no `fetch`) exists in
 * this phase.
 */

/** HTTP methods the application API needs today. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Optional per-request settings. */
export interface NetworkRequestOptions {
  headers?: Record<string, string>;
  /** Cross-runtime cancellation signal (Node + browser). */
  signal?: AbortSignal;
}

/** A typed request to the application's own backend. */
export interface NetworkRequest<TBody = unknown> extends NetworkRequestOptions {
  method: HttpMethod;
  /** Application-scoped API path (NOT an arbitrary URL). */
  path: string;
  /** Request body (JSON-serializable). */
  body?: TBody;
}

/** A normalized response; `data` is the parsed JSON body when present. */
export interface NetworkResponse<TData = unknown> {
  /** HTTP status code. */
  status: number;
  /** True for 2xx responses. */
  ok: boolean;
  /** Parsed response body (when the transport decodes JSON). */
  data?: TData;
}

/**
 * The application-facing transport port. Implementations may be Express-backed
 * (standalone), hosted/remote (PWA), or a plugin bridge (Obsidian).
 */
export interface NetworkAdapter {
  /** Executes a typed request against the application's own backend. */
  request<TResponse = unknown, TBody = unknown>(
    request: NetworkRequest<TBody>
  ): Promise<NetworkResponse<TResponse>>;
  /** Convenience GET. */
  get<TResponse = unknown>(
    path: string,
    options?: NetworkRequestOptions
  ): Promise<NetworkResponse<TResponse>>;
  /** Convenience POST. */
  post<TResponse = unknown, TBody = unknown>(
    path: string,
    body: TBody,
    options?: NetworkRequestOptions
  ): Promise<NetworkResponse<TResponse>>;
}
