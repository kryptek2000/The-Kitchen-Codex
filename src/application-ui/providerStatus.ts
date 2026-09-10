/**
 * The Kitchen Codex — Provider Status View Model (v0.7 Phase 1E).
 *
 * Client-side, platform-neutral logic for the read-only Provider Status UI. It is
 * intentionally SEPARATE from the server (`server/ai/providerStatus.ts`) so the
 * browser bundle never imports server-only code. It consumes the existing
 * `NetworkAdapter` (never a direct `fetch`), and its view-model strips unknown
 * fields so a provider secret could never enter the client model even if a
 * backend response were malformed or malicious.
 *
 * SEMANTICS (mirror the backend, never conflated):
 *   - `configured`: a server operator secret exists for this provider.
 *   - `enabled`:    the registry descriptor permits selection (read-only here).
 *   - `available`:  the provider's cheap local availability check (no network probe).
 *   - `capabilities`: registry-owned truth — read-only, never user-editable.
 */

import type { NetworkAdapter, NetworkResponse } from '../application/adapters/NetworkAdapter';
import type { SecretStorageScope } from '../application/adapters/SecretAdapter';
import type { AiCapabilities, AiCapability } from '../core/ai/types';

/** The single application-backed status path (read-only). */
export const PROVIDER_STATUS_API_PATH = '/api/providers';

/** The client-facing view of a provider (never carries a secret value). */
export interface ProviderStatusView {
  providerId: string;
  name: string;
  configured: boolean;
  enabled: boolean;
  available: boolean;
  storageScope: SecretStorageScope;
  supportsSecretWrites: boolean;
  capabilities: AiCapabilities;
}

/** The raw response shape from `GET /api/providers`. */
interface ProviderStatusResponse {
  providers?: unknown;
}

/** Human-facing labels for the truthful storage scopes. */
const STORAGE_SCOPE_LABELS: Record<SecretStorageScope, string> = {
  server_environment: 'Server environment',
  secure_platform: 'Secure platform storage',
  local_plaintext: 'Local plaintext storage',
  session_only: 'Session only (server memory)',
  unavailable: 'Unavailable',
};

/** Order of capability chips to display (registry-owned truth). */
export const CAPABILITY_KEYS: AiCapability[] = [
  'reasoning',
  'structuredOutput',
  'recipeGeneration',
  'webSearch',
];

const CAPABILITY_LABELS: Record<AiCapability, string> = {
  reasoning: 'Reasoning',
  structuredOutput: 'Structured Output',
  recipeGeneration: 'Recipe Generation',
  webSearch: 'Grounded Web Search',
};

/** Maps a machine storage-scope key to a truthful human label. Unknown -> Unavailable. */
export function storageScopeLabel(scope: SecretStorageScope): string {
  return STORAGE_SCOPE_LABELS[scope as SecretStorageScope] ?? 'Unavailable';
}

/** Maps a machine capability key to a human label. Unknown keys render as the raw key. */
export function capabilityLabel(key: AiCapability): string {
  return (CAPABILITY_LABELS as Record<string, string>)[key as string] ?? String(key);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** Validates + normalizes a single provider row, keeping ONLY allowlisted fields. */
function normalizeRow(raw: unknown): ProviderStatusView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['providerId'] !== 'string' || typeof row['name'] !== 'string') return null;
  const storageScope = row['storageScope'] as SecretStorageScope;
  if (!STORAGE_SCOPE_LABELS[storageScope]) return null;
  if (
    !isBoolean(row['configured']) ||
    !isBoolean(row['enabled']) ||
    !isBoolean(row['available']) ||
    !isBoolean(row['supportsSecretWrites'])
  ) {
    return null;
  }
  const capsRaw = row['capabilities'];
  const capabilities: AiCapabilities = {
    reasoning: false,
    structuredOutput: false,
    recipeGeneration: false,
    webSearch: false,
  };
  if (typeof capsRaw === 'object' && capsRaw !== null) {
    const caps = capsRaw as Record<string, unknown>;
    capabilities.reasoning = caps['reasoning'] === true;
    capabilities.structuredOutput = caps['structuredOutput'] === true;
    capabilities.recipeGeneration = caps['recipeGeneration'] === true;
    capabilities.webSearch = caps['webSearch'] === true;
  }
  // Copy ONLY the allowlisted fields; no other key (e.g. any secret-shaped field)
  // can survive into the client view-model.
  return {
    providerId: row['providerId'],
    name: row['name'],
    configured: row['configured'],
    enabled: row['enabled'],
    available: row['available'],
    storageScope,
    supportsSecretWrites: row['supportsSecretWrites'],
    capabilities,
  };
}

/** Validates the whole `/api/providers` payload and returns normalized rows. */
export function normalizeProviderStatus(payload: unknown): ProviderStatusView[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Provider status response was not an object.');
  }
  const providers = (payload as ProviderStatusResponse).providers;
  if (!Array.isArray(providers)) {
    throw new Error('Provider status response did not include a providers array.');
  }
  const rows: ProviderStatusView[] = [];
  for (const item of providers) {
    const row = normalizeRow(item);
    if (row) rows.push(row);
  }
  if (rows.length === 0) {
    throw new Error('Provider status response contained no valid providers.');
  }
  return rows;
}

/**
 * Fetches provider status through the application `NetworkAdapter` (no direct
 * fetch, no arbitrary URL). Throws on a non-2xx response or malformed payload so
 * the UI can render a bounded "provider status unavailable" state instead of
 * fabricating provider states.
 */
export async function fetchProviderStatus(network: NetworkAdapter): Promise<ProviderStatusView[]> {
  const res: NetworkResponse<ProviderStatusResponse> = await network.get<ProviderStatusResponse>(
    PROVIDER_STATUS_API_PATH
  );
  if (!res.ok) {
    throw new Error(`Provider status request failed (HTTP ${res.status}).`);
  }
  if (res.data === undefined) {
    throw new Error('Provider status request returned no data.');
  }
  return normalizeProviderStatus(res.data);
}

/**
 * A minimal monotonic request sequence guard that makes rapid concurrent Refresh
 * requests deterministic: the NEWEST request wins, and any result belonging to a
 * superseded request (success OR failure) is ignored. No AbortController, no
 * dependency — a tiny counter is enough.
 */
export function createRequestSequencer(): {
  /** Begins a new request and returns its sequence id (latest id wins). */
  begin(): number;
  /** True only when `id` is the most recently begun request (no stale commit). */
  isCurrent(id: number): boolean;
} {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    isCurrent(id: number): boolean {
      return id === current;
    },
  };
}
