/**
 * The Kitchen Codex — session-key client API helpers (BYOK-5E).
 *
 * Small, typed wrappers over the FIXED BYOK-5B/5D application API paths. They
 * NEVER accept an arbitrary URL, NEVER persist anything, and NEVER return a
 * secret: the session key only travels one way (into the POST body) and the
 * server never echoes it back.
 */

import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';

/** Fixed application API paths (never caller-controlled). */
export const SESSION_KEY_API_PATH = '/api/providers/session-key';
export const SESSION_KEY_STATUS_API_PATH = '/api/providers/session-key/status';
export const PROVIDER_TEST_CONNECTION_API_PATH = '/api/providers/test-connection';

export type CredentialSourceView = 'server_environment' | 'session_only';
export type ProviderKind = 'text' | 'image';

/** Matches the server's provider-id length bound (no trimming/case-folding). */
export const MAX_PROVIDER_ID_LENGTH = 64;

/**
 * Local defense-in-depth bound on a provider id. The EXACT value is preserved
 * (no trim/case normalization); the server remains authoritative.
 */
export function isValidProviderId(providerId: unknown): providerId is string {
  return typeof providerId === 'string' && providerId.length > 0 && providerId.length <= MAX_PROVIDER_ID_LENGTH;
}

/** A NON-SECRET session-key status row (never a key/prefix/hash). */
export interface SessionKeyStatusView {
  providerId: string;
  storageScope: 'session_only';
  configured: boolean;
  expiresAt?: string;
  version?: string;
}

/** A bounded session-key mutation result (never a secret). */
export interface SessionKeyMutationResult {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  /** Present on a successful save/rotate (non-secret status only). */
  session?: SessionKeyStatusView;
}

/** A bounded connection-test result view (never a secret). */
export interface ConnectionTestView {
  ok: boolean;
  providerId?: string;
  model?: string;
  credentialSource?: CredentialSourceView;
  latencyMs?: number;
  code?: string;
  message?: string;
}

/** Normalizes ONE status row, keeping ONLY allowlisted non-secret fields. */
function normalizeStatusRow(raw: unknown): SessionKeyStatusView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['providerId'] !== 'string' || row['providerId'].length === 0) return null;
  if (row['storageScope'] !== 'session_only') return null;
  if (typeof row['configured'] !== 'boolean') return null;
  const view: SessionKeyStatusView = {
    providerId: row['providerId'],
    storageScope: 'session_only',
    configured: row['configured'],
  };
  if (typeof row['expiresAt'] === 'string' && row['expiresAt']) view.expiresAt = row['expiresAt'];
  if (typeof row['version'] === 'string' && row['version']) view.version = row['version'];
  return view;
}

/** Normalizes the `/status` payload into non-secret rows. */
export function normalizeSessionKeyStatus(payload: unknown): SessionKeyStatusView[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Session key status response was not an object.');
  }
  const providers = (payload as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) {
    throw new Error('Session key status response did not include a providers array.');
  }
  const rows: SessionKeyStatusView[] = [];
  for (const item of providers) {
    const row = normalizeStatusRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

function boundedError(data: unknown): { code?: string; message?: string } {
  if (typeof data !== 'object' || data === null) return {};
  const row = data as Record<string, unknown>;
  const out: { code?: string; message?: string } = {};
  if (typeof row['code'] === 'string' && row['code']) out.code = row['code'];
  if (typeof row['error'] === 'string' && row['error']) out.message = row['error'];
  return out;
}

/**
 * Fetches the non-secret session-key status for ALL allowlisted providers.
 * A non-2xx (e.g. 503 BYOK_SESSION_UNAVAILABLE in an unsupported deployment) is
 * surfaced as a bounded error, never fabricated state.
 */
export async function fetchSessionKeyStatus(
  network: NetworkAdapter
): Promise<{ ok: true; providers: SessionKeyStatusView[] } | { ok: false; status: number; code?: string; message?: string }> {
  const res = await network.get(SESSION_KEY_STATUS_API_PATH);
  if (res.ok === false) {
    const err = boundedError(res.data);
    return { ok: false, status: res.status, code: err.code, message: err.message };
  }
  try {
    return { ok: true, providers: normalizeSessionKeyStatus(res.data) };
  } catch {
    return { ok: false, status: res.status, code: 'INVALID_RESPONSE', message: 'Session key status was unusable.' };
  }
}

/**
 * Saves or rotates a session key. `expectedVersion` MUST be supplied when a live
 * key already exists (the server enforces rotation safety). The key is placed in
 * the POST body ONLY and is never persisted client-side.
 */
export async function saveSessionKey(
  network: NetworkAdapter,
  providerId: string,
  apiKey: string,
  expectedVersion?: string
): Promise<SessionKeyMutationResult> {
  if (!isValidProviderId(providerId)) {
    return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid provider id.' };
  }
  const body: { providerId: string; apiKey: string; expectedVersion?: string } = { providerId, apiKey };
  if (expectedVersion) body.expectedVersion = expectedVersion;
  const res = await network.post(SESSION_KEY_API_PATH, body);
  if (!res.ok) {
    const err = boundedError(res.data);
    return { ok: false, status: res.status, code: err.code, message: err.message };
  }
  const session = normalizeStatusRow(res.data) ?? undefined;
  return { ok: true, status: res.status, session };
}

/** Revokes a provider's session key (idempotent server-side). */
export async function revokeSessionKey(
  network: NetworkAdapter,
  providerId: string
): Promise<SessionKeyMutationResult> {
  // Local bound BEFORE building the path; the exact value is preserved and the
  // server remains authoritative. No arbitrary URL is ever constructed.
  if (!isValidProviderId(providerId)) {
    return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Invalid provider id.' };
  }
  const res = await network.request({
    method: 'DELETE',
    path: `${SESSION_KEY_API_PATH}/${encodeURIComponent(providerId)}`,
  });
  if (!res.ok) {
    const err = boundedError(res.data);
    return { ok: false, status: res.status, code: err.code, message: err.message };
  }
  return { ok: true, status: res.status };
}

/**
 * Runs an explicit, bounded provider connection test. The request carries the
 * credential SOURCE (non-secret) and NEVER an apiKey.
 */
export async function testProviderConnection(
  network: NetworkAdapter,
  params: { providerId: string; kind: ProviderKind; modelId?: string; credentialSource?: CredentialSourceView }
): Promise<ConnectionTestView> {
  if (!isValidProviderId(params.providerId)) {
    return { ok: false, providerId: params.providerId, code: 'INVALID_REQUEST', message: 'Invalid provider id.' };
  }
  const body: {
    providerId: string;
    kind: ProviderKind;
    modelId?: string;
    credentialSource?: CredentialSourceView;
  } = { providerId: params.providerId, kind: params.kind };
  if (params.modelId) body.modelId = params.modelId;
  if (params.credentialSource) body.credentialSource = params.credentialSource;
  const res = await network.post(PROVIDER_TEST_CONNECTION_API_PATH, body);
  const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
  const view: ConnectionTestView = {
    ok: res.ok && data['ok'] === true,
    providerId: typeof data['providerId'] === 'string' ? data['providerId'] : params.providerId,
    model: typeof data['model'] === 'string' ? data['model'] : undefined,
    credentialSource:
      data['credentialSource'] === 'session_only' || data['credentialSource'] === 'server_environment'
        ? data['credentialSource']
        : undefined,
  };
  if (typeof data['latencyMs'] === 'number') view.latencyMs = data['latencyMs'];
  if (typeof data['code'] === 'string') view.code = data['code'];
  if (typeof data['message'] === 'string') view.message = data['message'];
  return view;
}
