/**
 * The Kitchen Codex — in-memory endpoint-access authorization (Phase 2 repair).
 *
 * A SINGLE, PROCESS-MEMORY holder for the optional shared endpoint-access token
 * that protects the application's own `/api/` AI endpoints when the server has
 * `AI_ENDPOINT_TOKEN` configured (the exact `Authorization: Bearer <token>`
 * header `server/aiEndpointAuth.ts` requires).
 *
 * SECURITY / SCOPE (must never be weakened):
 *   - NEVER persisted: no localStorage/sessionStorage/IndexedDB, no Markdown, no
 *     provenance, no settings store, no plugin data.json, no cookie.
 *   - NEVER exposed in a URL/query, an image `src`, DOM text, an object URL, an
 *     error/log, or the selection state.
 *   - It is set at bootstrap by the shell that owns the runtime configuration and
 *     is attached to every same-origin `/api/` request by the network adapters.
 *   - Unprotected deployments never set it; the adapters then send no
 *     authorization header and behave exactly as before.
 */

let endpointAccessToken: string | undefined;

/** Sets (or clears, for an empty value) the in-memory endpoint-access token. */
export function setEndpointAccessToken(token: string | undefined | null): void {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  endpointAccessToken = trimmed ? trimmed : undefined;
}

/** Clears the in-memory endpoint-access token. */
export function clearEndpointAccessToken(): void {
  endpointAccessToken = undefined;
}

/** True when an endpoint-access token is configured for this process/session. */
export function isEndpointAccessConfigured(): boolean {
  return endpointAccessToken !== undefined;
}

/**
 * The authorization headers for the application's own `/api/` requests. Returns
 * an empty object on unprotected deployments. Never returns a token in any other
 * shape (no query, no body, no logging).
 */
export function getEndpointAccessHeaders(): Record<string, string> {
  return endpointAccessToken ? { Authorization: `Bearer ${endpointAccessToken}` } : {};
}
