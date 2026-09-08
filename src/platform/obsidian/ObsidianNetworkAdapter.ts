/**
 * The Kitchen Codex — Obsidian Network Adapter (Phase 4D3B).
 *
 * Concrete implementation of the application `NetworkAdapter` port for the
 * Obsidian desktop runtime. The plugin does NOT have a browser same-origin
 * `/api` path, so this adapter prepends a CONFIGURED backend origin internally.
 *
 * CONTRACT KEPT NARROW (unchanged from BrowserNetworkAdapter semantics):
 *   - callers still pass ONLY application-scoped `/api/...` paths;
 *   - the base origin is platform implementation detail, NOT caller input;
 *   - arbitrary absolute URLs, protocol-relative URLs, and traversal are
 *     rejected by the adapter itself (no arbitrary-URL primitive);
 *   - JSON request/response only (no binary/blob);
 *   - `AbortSignal` preserved;
 *   - non-2xx responses are RETURNED structurally, not thrown;
 *   - a normalized error is thrown ONLY for misuse or transport failure.
 *
 * The `obsidian` import is TYPE-ONLY and the adapter is runtime-clean, so it is
 * unit-testable in Node with a plain-object fetch fake.
 */

import type { NetworkAdapter, NetworkRequest, NetworkRequestOptions, NetworkResponse } from '../../application/adapters/NetworkAdapter';

const API_PATH = /^\/api\//;

/** A minimal response shape; the real browser/Node `Response` satisfies this. */
export interface ObsidianResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export type ObsidianFetchLike = (url: string, init: RequestInit) => Promise<ObsidianResponseLike>;

/** Normalized, minimal request error (no server stack leaked). */
export class ObsidianNetworkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ObsidianNetworkError';
    this.status = status;
  }
}

/** Options for the Obsidian network adapter. */
export interface ObsidianNetworkOptions {
  /** Backend origin, e.g. `http://127.0.0.1:3000` or `https://hosted.example`. */
  baseUrl?: string;
  /** Injectable fetch for tests; defaults to `globalThis.fetch`. */
  fetchFn?: ObsidianFetchLike;
}

function assertApiPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ObsidianNetworkError(400, 'NetworkAdapter path must not be empty.');
  }
  if (API_PATH.test(path) === false) {
    throw new ObsidianNetworkError(
      400,
      `NetworkAdapter only accepts application API paths starting with "/api/" (got "${path}").`
    );
  }
  if (path.includes('..')) {
    throw new ObsidianNetworkError(400, 'NetworkAdapter does not allow path traversal.');
  }
}

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ObsidianNetworkError(400, `ObsidianNetworkAdapter baseUrl must be an absolute http(s) URL (got "${raw}").`);
  }
  return trimmed;
}

function defaultFetch(): ObsidianFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

export class ObsidianNetworkAdapter implements NetworkAdapter {
  private readonly baseUrl: string | undefined;
  private readonly fetchFn: ObsidianFetchLike;

  constructor(options: ObsidianNetworkOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? defaultFetch();
  }

  async request<TResponse = unknown, TBody = unknown>(
    request: NetworkRequest<TBody>
  ): Promise<NetworkResponse<TResponse>> {
    assertApiPath(request.path);

    const url = this.baseUrl ? `${this.baseUrl}${request.path}` : request.path;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(request.headers || {}),
    };
    const init: RequestInit = { method: request.method, headers, signal: request.signal };
    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
    }

    let res: ObsidianResponseLike;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw new ObsidianNetworkError(0, err instanceof Error ? err.message : 'Network request failed.');
    }

    const status = res.status;
    const ok = res.ok;
    let data: unknown = undefined;
    if (status !== 204) {
      try {
        data = await res.json();
      } catch {
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
}
