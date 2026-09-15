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

import type {
  NetworkAdapter,
  NetworkBinaryResponse,
  NetworkRequest,
  NetworkRequestOptions,
  NetworkResponse,
} from '../../application/adapters/NetworkAdapter';

const API_PATH = /^\/api\//;

/** Hard bounds before unrestricted allocation (never render raw error bodies). */
const MAX_API_PATH_LENGTH = 2048;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A minimal response shape; the real browser/Node `Response` satisfies this. */
export interface ObsidianResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
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
  /**
   * The SINGLE in-memory endpoint-access authorization provider applied to every
   * app `/api/` request (JSON and binary). Never persisted. Optional (unprotected
   * deployments provide none).
   */
  authorizationHeaders?: () => Record<string, string>;
}

function assertApiPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ObsidianNetworkError(400, 'NetworkAdapter path must not be empty.');
  }
  if (path.length > MAX_API_PATH_LENGTH) {
    throw new ObsidianNetworkError(400, 'NetworkAdapter path is too long.');
  }
  // Decode and normalize BEFORE the authorization boundary check, exactly like
  // the browser adapter: encoded traversal (`/api/%2e%2e/outside`,
  // double-encoded `%252e`, backslash, NUL) is rejected like its literal form.
  let decoded = path;
  try {
    for (let i = 0; i < 4; i += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new ObsidianNetworkError(400, 'NetworkAdapter path has malformed encoding.');
  }
  if (API_PATH.test(decoded) === false) {
    throw new ObsidianNetworkError(
      400,
      `NetworkAdapter only accepts application API paths starting with "/api/" (got "${path}").`
    );
  }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new ObsidianNetworkError(400, 'NetworkAdapter does not allow path traversal.');
  }
}

/** Declared content length when the transport exposes it (pre-allocation guard). */
function responseContentLength(res: ObsidianResponseLike): number | undefined {
  try {
    const raw = res.headers?.get('content-length');
    if (raw === undefined || raw === null) return undefined;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  } catch {
    return undefined;
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
  private readonly authorizationHeaders: () => Record<string, string>;

  constructor(options: ObsidianNetworkOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? defaultFetch();
    this.authorizationHeaders = options.authorizationHeaders ?? (() => ({}));
  }

  /** In-memory endpoint-access headers applied to every app `/api/` call. */
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

  /** Bounded JSON decode (declared length pre-check + materialized cap). */
  private async decodeJsonBody(res: ObsidianResponseLike): Promise<unknown> {
    const declared = responseContentLength(res);
    if (declared !== undefined && declared > MAX_JSON_RESPONSE_BYTES) {
      throw new ObsidianNetworkError(502, 'Network response body is too large.');
    }
    if (typeof res.text === 'function') {
      const text = await res.text();
      if (text.length > MAX_JSON_RESPONSE_BYTES) {
        throw new ObsidianNetworkError(502, 'Network response body is too large.');
      }
      if (!text) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return undefined;
    }
    try {
      if (JSON.stringify(data)?.length > MAX_JSON_RESPONSE_BYTES) {
        throw new ObsidianNetworkError(502, 'Network response body is too large.');
      }
    } catch (err) {
      if (err instanceof ObsidianNetworkError) throw err;
      return undefined;
    }
    return data;
  }

  async request<TResponse = unknown, TBody = unknown>(
    request: NetworkRequest<TBody>
  ): Promise<NetworkResponse<TResponse>> {
    assertApiPath(request.path);

    const url = this.baseUrl ? `${this.baseUrl}${request.path}` : request.path;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.mergedHeaders(request.headers),
    };
    // `redirect: 'error'` on EVERY app request: the endpoint Authorization
    // header can never be forwarded off-origin by a followed redirect.
    const init: RequestInit = { method: request.method, headers, signal: request.signal, redirect: 'error' };
    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
    }

    let res: ObsidianResponseLike;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      if (err instanceof ObsidianNetworkError) throw err;
      throw new ObsidianNetworkError(0, err instanceof Error ? err.message : 'Network request failed.');
    }

    const status = res.status;
    const ok = res.ok;
    let data: unknown = undefined;
    if (status !== 204) {
      try {
        data = await this.decodeJsonBody(res);
      } catch (err) {
        if (err instanceof ObsidianNetworkError) throw err;
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

  /** Binary GET for app-local byte responses (transient image previews). */
  async getBytes(path: string, options?: NetworkRequestOptions): Promise<NetworkBinaryResponse> {
    assertApiPath(path);
    const url = this.baseUrl ? `${this.baseUrl}${path}` : path;
    let res: ObsidianResponseLike;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        // Same endpoint-access authorization as JSON requests; `redirect: 'error'`
        // prevents the header from ever being forwarded off-origin.
        headers: this.mergedHeaders(options?.headers),
        redirect: 'error',
        signal: options?.signal,
      });
    } catch (err) {
      if (err instanceof ObsidianNetworkError) throw err;
      throw new ObsidianNetworkError(0, err instanceof Error ? err.message : 'Network request failed.');
    }
    if (!res.ok) return { status: res.status, ok: false };
    if (typeof res.arrayBuffer !== 'function') return { status: res.status, ok: false };
    const declared = responseContentLength(res);
    if (declared !== undefined && declared > MAX_BINARY_RESPONSE_BYTES) {
      throw new ObsidianNetworkError(502, 'Network response body is too large.');
    }
    const contentType = res.headers?.get('content-type') || undefined;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BINARY_RESPONSE_BYTES) {
      throw new ObsidianNetworkError(502, 'Network response body is too large.');
    }
    return {
      status: res.status,
      ok: true,
      bytes: new Uint8Array(buffer),
      ...(contentType ? { contentType } : {}),
    };
  }
}
