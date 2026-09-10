/**
 * The Kitchen Codex — client AI provider/model selection preferences (BYOK-4).
 *
 * Stores NON-SECRET user/provider MODEL selection preferences per surface
 * (text / image) and attaches them to each AI request as HTTP headers that the
 * server validates against ITS catalog and honors per-request.
 *
 * TRUTH / SECURITY MODEL:
 *   - NEVER persists `server_managed` mode (that is server-derived and always
 *     authoritative server-side). Only `server_default` or `user_selected` are
 *     stored.
 *   - Stored selections are validated against the CURRENT catalog on load and
 *     on save for DISPLAY only. A stale/invalid `user_selected` is PRESERVED
 *     (never silently rewritten to `server_default`): it stays visible as invalid
 *     and keeps being transmitted, so the server FAILS CLOSED rather than
 *     executing a different paid provider. Server-default execution resumes ONLY
 *     after the user explicitly resets to server default.
 *   - The stored payload is NON-SECRET: provider/model IDs only. No API keys,
 *     tokens, masked secrets, credentials, or model prompts are ever stored.
 *   - The server NEVER trusts the header blindly: it re-validates provider/
 *     model against the server catalog + registry, and a server-managed pin
 *     always wins.
 *   - When a server-managed pin exists, the saved user selection becomes
 *     INERT at runtime (the server ignores it) and the UI must render the
 *     selection as read-only (gated via catalog `userSelectionAllowed`).
 */

import type { SettingsAdapter } from './adapters/SettingsAdapter';
import type { NetworkRequestOptions } from './adapters/NetworkAdapter';

/** Header names (mirror of the server's parseSelectionMetadata allowlist). */
export const TEXT_SELECTION_HEADER = 'x-kitchen-ai-text-selection';
export const IMAGE_SELECTION_HEADER = 'x-kitchen-ai-image-selection';

/** The client-storable selection modes (NEVER `server_managed`). */
export type SavedSelectionMode = 'server_default' | 'user_selected';

/** One surface's saved selection preference (non-secret, catalog-free ids). */
export interface SavedSelection {
  mode: SavedSelectionMode;
  providerId?: string;
  modelId?: string;
}

/** The full persisted selection-preferences shape (non-secret). */
export interface SavedAiSelections {
  textAi: SavedSelection;
  imageAi: SavedSelection;
}

/** The single settings key for the non-secret selection preferences. */
export const AI_SELECTION_SETTINGS_KEY = 'kitchen.codex.aiSelections.v1';

/** The minimal catalog surface the selection validator needs (structural). */
export interface AiSelectionCatalogSurface {
  textProviders: {
    providerId: string;
    models: { id: string }[];
    /** Exposed by the catalog view; optional so minimal callers stay valid. */
    available?: boolean;
    enabled?: boolean;
    selectable?: boolean;
  }[];
  imageProviders: {
    providerId: string;
    models: { id: string }[];
    available?: boolean;
    enabled?: boolean;
    selectable?: boolean;
  }[];
}

/** The default (no user selection) preferences. */
export function defaultAiSelections(): SavedAiSelections {
  return { textAi: { mode: 'server_default' }, imageAi: { mode: 'server_default' } };
}

// ---------------------------------------------------------------------------
// Module-level cache + PER-SURFACE hydration state machine (populated at
// APPLICATION BOOTSTRAP, not by a UI-panel side effect). The cache is the ONLY
// thing the header builder reads per request; it MUST be hydrated from the
// SettingsAdapter before any AI request is made.
//
// READINESS IS TRACKED INDEPENDENTLY FOR TEXT AND IMAGE. Changing one surface
// never marks the other ready. An unread/read-error surface stays fail-closed.
//
// STATES (per surface):
//   loading              — hydration has not completed; requests blocked/deferred
//   loaded               — hydration succeeded (incl. an intentional server_default)
//   read-error           — the settings read FAILED; NOT server_default
//   invalid-stored-intent — a PRESENT but malformed stored explicit intent;
//                           stays fail-closed (never collapsed to server_default)
// ---------------------------------------------------------------------------

/** The AI surface a selection applies to. */
export type AiSelectionSurface = 'text' | 'image';

/** The per-surface hydration/readiness state. */
export type AiSelectionSurfaceStatus =
  | 'loading'
  | 'loaded'
  | 'read-error'
  | 'invalid-stored-intent';

/** Back-compat aggregate status (any non-loaded surface dominates). */
export type AiSelectionHydrationStatus =
  | 'loading'
  | 'loaded'
  | 'read-error'
  | 'invalid-stored-intent';

/** The code carried by `AiSelectionNotReadyError`. */
export type AiSelectionNotReadyCode = 'loading' | 'read-error' | 'invalid-stored-intent';

/**
 * Thrown when an AI request is built before the relevant surface's selection
 * hydration resolves, after a settings read error, or for a malformed stored
 * explicit intent. Fail-closed: the caller must NOT proceed with a request that
 * the server would interpret as server_default.
 */
export class AiSelectionNotReadyError extends Error {
  readonly code: AiSelectionNotReadyCode;
  readonly surface?: AiSelectionSurface;
  constructor(code: AiSelectionNotReadyCode, surface?: AiSelectionSurface) {
    super(
      code === 'read-error'
        ? 'AI provider selection preferences could not be read.'
        : code === 'invalid-stored-intent'
          ? 'The saved AI provider selection is malformed and cannot be used.'
          : 'AI provider selection preferences are still loading.'
    );
    this.name = 'AiSelectionNotReadyError';
    this.code = code;
    this.surface = surface;
  }
}

/** The stored-intent parse result for ONE surface. */
export type StoredSelectionStatus = 'default' | 'selected' | 'invalid';
export interface ParsedStoredSelection {
  status: StoredSelectionStatus;
  selection: SavedSelection;
}

const SURFACES: readonly AiSelectionSurface[] = ['text', 'image'] as const;

interface SurfaceState {
  status: AiSelectionSurfaceStatus;
  selection: SavedSelection;
}

function initialState(): SurfaceState {
  return { status: 'loading', selection: { mode: 'server_default' } };
}

let surfaceStates: Record<AiSelectionSurface, SurfaceState> = {
  text: initialState(),
  image: initialState(),
};
let hydrationPromise: Promise<SavedAiSelections> | null = null;
// The adapter instance the current readiness belongs to. A NEW adapter (app
// remount / different shell) must NOT reuse stale global readiness.
let currentAdapter: unknown = null;
// Per-surface deliberate-change generation: a save/reset bumps its surface so a
// late-resolving hydration cannot overwrite a newer deliberate user change.
const deliberateGeneration: Record<AiSelectionSurface, number> = { text: 0, image: 0 };

/** The current readiness of ONE surface. */
export function getAiSelectionSurfaceStatus(kind: AiSelectionSurface): AiSelectionSurfaceStatus {
  return surfaceStates[kind].status;
}

/**
 * The aggregate hydration state. Returns 'loading' if any surface is loading,
 * otherwise the first non-loaded surface state, otherwise 'loaded'.
 */
export function getAiSelectionHydrationStatus(): AiSelectionHydrationStatus {
  if (SURFACES.some((k) => surfaceStates[k].status === 'loading')) return 'loading';
  if (SURFACES.some((k) => surfaceStates[k].status === 'read-error')) return 'read-error';
  if (SURFACES.some((k) => surfaceStates[k].status === 'invalid-stored-intent')) return 'invalid-stored-intent';
  return 'loaded';
}

/** True once the requested surface (or both, when omitted) has loaded. */
export function isAiSelectionReady(kind?: AiSelectionSurface): boolean {
  if (kind) return surfaceStates[kind].status === 'loaded';
  return SURFACES.every((k) => surfaceStates[k].status === 'loaded');
}

/** Returns the current in-memory selections (defaults for unset surfaces). */
export function getCachedAiSelections(): SavedAiSelections {
  return {
    textAi: { ...surfaceStates.text.selection },
    imageAi: { ...surfaceStates.image.selection },
  };
}

function notReadyCode(status: AiSelectionSurfaceStatus): AiSelectionNotReadyCode {
  if (status === 'read-error') return 'read-error';
  if (status === 'invalid-stored-intent') return 'invalid-stored-intent';
  return 'loading';
}

/**
 * Awaits readiness for ONE surface (defaults to `text`). Resolves with the
 * effective selections once that surface is loaded; REJECTS (fail-closed) while
 * still loading without a started hydration, after a settings read error, or for
 * a malformed stored explicit intent.
 */
export async function awaitAiSelectionReady(
  kind: AiSelectionSurface = 'text'
): Promise<SavedAiSelections> {
  const status = surfaceStates[kind].status;
  if (status === 'loaded') return getCachedAiSelections();
  if (status !== 'loading') throw new AiSelectionNotReadyError(notReadyCode(status), kind);
  if (hydrationPromise) {
    try {
      await hydrationPromise;
    } catch {
      /* fall through to the per-surface re-check below */
    }
    const after = surfaceStates[kind].status;
    if (after === 'loaded') return getCachedAiSelections();
    throw new AiSelectionNotReadyError(notReadyCode(after), kind);
  }
  throw new AiSelectionNotReadyError('loading', kind);
}

// ---------------------------------------------------------------------------
// Selection normalization + catalog validity
//
// IMPORTANT (BYOK-4 final hardening): an EXPLICIT `user_selected` preference is
// NEVER silently collapsed to `server_default`. Collapsing it would drop the
// explicit intent from the request, so the server would apply the server-default
// chain (a DIFFERENT paid provider). Instead the explicit selection is preserved
// verbatim; the server validates it against its own registry and FAILS CLOSED
// when it is stale/invalid/unavailable. The catalog check below exists only so
// the UI can EXPLAIN that a preserved selection is currently invalid.
// ---------------------------------------------------------------------------

/**
 * Strictly parses a stored selection for ONE surface. Absent/null -> `default`
 * (an intentional server_default). A valid explicit `user_selected` -> `selected`.
 * Any PRESENT but malformed payload -> `invalid` (fail-closed; never collapsed
 * to server_default). Identifiers are rejected when oversized, never truncated.
 */
export function parseStoredSelection(raw: unknown): ParsedStoredSelection {
  const invalid: ParsedStoredSelection = { status: 'invalid', selection: { mode: 'server_default' } };
  if (raw === undefined || raw === null) return { status: 'default', selection: { mode: 'server_default' } };
  if (typeof raw !== 'object' || Array.isArray(raw)) return invalid;
  const row = raw as Record<string, unknown>;
  const providerPresent = Object.prototype.hasOwnProperty.call(row, 'providerId');
  const modelPresent = Object.prototype.hasOwnProperty.call(row, 'modelId');
  if (providerPresent && typeof row.providerId !== 'string') return invalid;
  if (modelPresent && typeof row.modelId !== 'string') return invalid;
  const providerId = typeof row.providerId === 'string' ? row.providerId.trim() : '';
  const modelId = typeof row.modelId === 'string' ? row.modelId.trim() : '';
  // Reject oversized identifiers — never truncate them into valid values.
  if (providerId.length > 64 || modelId.length > 128) return invalid;
  if (row.mode === 'server_default') {
    if (providerPresent || modelPresent) return invalid;
    return { status: 'default', selection: { mode: 'server_default' } };
  }
  if (row.mode === 'user_selected') {
    if (!providerId) return invalid;
    if (modelPresent && !modelId) return invalid;
    return {
      status: 'selected',
      selection: modelId
        ? { mode: 'user_selected', providerId, modelId }
        : { mode: 'user_selected', providerId },
    };
  }
  return invalid;
}

/**
 * Best-effort shape-normalizer used by DISPLAY and the explicit save path. An
 * explicit valid `user_selected` is preserved; malformed input returns
 * `server_default` HERE (the hydration path uses `parseStoredSelection` to keep
 * malformed stored intent fail-closed).
 */
export function normalizeStoredSelection(raw: unknown): SavedSelection {
  return parseStoredSelection(raw).selection;
}

/**
 * True when a selection is currently valid against the supplied catalog surface.
 * Used ONLY to explain (in the UI) that a preserved explicit selection is stale;
 * it never mutates or drops the user's stored preference.
 *
 * An explicit user selection is INVALID for UI truth when:
 *   - the provider is missing from the catalog,
 *   - the provider is not selectable / not available / disabled (where exposed),
 *   - an explicit model is no longer in the provider's curated model set.
 * Server-default selections are always valid (the server owns that chain).
 */
export function isSelectionValidAgainstCatalog(
  selection: SavedSelection,
  catalog: AiSelectionCatalogSurface,
  kind: 'text' | 'image'
): boolean {
  if (selection.mode !== 'user_selected') return true;
  if (!selection.providerId) return false;
  const surface = kind === 'text' ? catalog.textProviders : catalog.imageProviders;
  const provider = surface.find((p) => p.providerId === selection.providerId);
  if (!provider) return false;
  if (provider.available === false) return false;
  if (provider.enabled === false) return false;
  if (provider.selectable === false) return false;
  if (selection.modelId && !provider.models.some((m) => m.id === selection.modelId)) return false;
  return true;
}

/**
 * Hydrates the module cache from the SettingsAdapter with PER-SURFACE readiness.
 * An explicit valid `user_selected` is PRESERVED; a malformed PRESENT stored
 * intent marks ONLY that surface `invalid-stored-intent` (fail-closed, never
 * collapsed to server_default). Absent/null storage is an intentional default.
 *
 * A settings READ FAILURE is NOT server_default: each still-loading surface
 * becomes `read-error`. A NEW adapter instance (app remount / different shell)
 * resets readiness so stale global state is never reused.
 *
 * Generation guards ensure a late-resolving hydration NEVER overwrites a newer
 * deliberate save/reset for that surface. Call once at App bootstrap (before any
 * AI request) and idempotently from ProviderSettings.
 */
export function hydrateAiSelections(settings: Pick<SettingsAdapter, 'get'>): Promise<SavedAiSelections> {
  // Adapter replacement/remount: require a fresh read; never reuse stale readiness.
  if (settings !== currentAdapter) {
    currentAdapter = settings;
    surfaceStates = { text: initialState(), image: initialState() };
    hydrationPromise = null;
  }

  if (SURFACES.every((k) => surfaceStates[k].status === 'loaded')) {
    return Promise.resolve(getCachedAiSelections());
  }
  if (hydrationPromise) return hydrationPromise;

  const startGeneration: Record<AiSelectionSurface, number> = {
    text: deliberateGeneration.text,
    image: deliberateGeneration.image,
  };

  const run = (async (): Promise<SavedAiSelections> => {
    let stored: unknown;
    let readFailed = false;
    try {
      stored = await settings.get<SavedAiSelections>(AI_SELECTION_SETTINGS_KEY);
    } catch {
      readFailed = true;
    }

    if (readFailed) {
      for (const kind of SURFACES) {
        if (deliberateGeneration[kind] === startGeneration[kind] && surfaceStates[kind].status === 'loading') {
          surfaceStates[kind] = { status: 'read-error', selection: { mode: 'server_default' } };
        }
      }
    } else {
      const storedObj =
        typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : undefined;
      for (const kind of SURFACES) {
        // A deliberate change (or a surface already resolved) wins over hydration.
        if (deliberateGeneration[kind] !== startGeneration[kind] || surfaceStates[kind].status !== 'loading') {
          continue;
        }
        const raw = storedObj ? storedObj[kind === 'text' ? 'textAi' : 'imageAi'] : undefined;
        const parsed = parseStoredSelection(raw);
        surfaceStates[kind] =
          parsed.status === 'invalid'
            ? { status: 'invalid-stored-intent', selection: { mode: 'server_default' } }
            : { status: 'loaded', selection: parsed.selection };
      }
    }

    hydrationPromise = null;
    const failing = SURFACES.find((k) => surfaceStates[k].status !== 'loaded');
    if (failing) {
      throw new AiSelectionNotReadyError(notReadyCode(surfaceStates[failing].status), failing);
    }
    return getCachedAiSelections();
  })();
  hydrationPromise = run;
  // Avoid an unhandled rejection when a caller does not await hydration.
  run.catch(() => {});
  return run;
}

/**
 * Persists a user's selection preference for ONE surface and updates that
 * surface's readiness. Changing Text NEVER marks Image ready (and vice versa).
 * An explicit `user_selected` is stored as requested (the server is the
 * authority that validates/fails-closed); `server_default` is stored only when
 * the user explicitly chooses it. Never persists `server_managed`.
 */
export async function saveAiSelection(
  settings: SettingsAdapter,
  kind: 'text' | 'image',
  mode: SavedSelectionMode,
  providerId?: string,
  modelId?: string
): Promise<SavedAiSelections> {
  const parsed = parseStoredSelection(
    mode === 'user_selected' ? { mode: 'user_selected', providerId, modelId } : { mode: 'server_default' }
  );
  const selection = parsed.status === 'selected' ? parsed.selection : { mode: 'server_default' as const };
  surfaceStates[kind] = { status: 'loaded', selection };
  deliberateGeneration[kind] += 1;
  const next = getCachedAiSelections();
  try {
    await settings.set(AI_SELECTION_SETTINGS_KEY, next);
  } catch {
    // Persistence failure is non-fatal: the in-memory preference still holds
    // for this session; the next save re-attempts persistence.
  }
  return getCachedAiSelections();
}

/**
 * Clears the user selection preference for ONE surface (back to server_default).
 * Changing Text NEVER marks Image ready (and vice versa).
 */
export async function resetAiSelection(
  settings: SettingsAdapter,
  kind: 'text' | 'image'
): Promise<SavedAiSelections> {
  surfaceStates[kind] = { status: 'loaded', selection: { mode: 'server_default' } };
  deliberateGeneration[kind] += 1;
  const next = getCachedAiSelections();
  try {
    await settings.set(AI_SELECTION_SETTINGS_KEY, next);
  } catch {
    // Non-fatal (see saveAiSelection).
  }
  return getCachedAiSelections();
}

// ---------------------------------------------------------------------------
// Request attachment (per-request NON-SECRET metadata headers)
// ---------------------------------------------------------------------------

function selectionToHeaderValue(selection: SavedSelection): string | undefined {
  if (selection.mode !== 'user_selected' || !selection.providerId) return undefined;
  const payload: { mode: 'user_selected'; providerId: string; modelId?: string } = {
    mode: 'user_selected',
    providerId: selection.providerId,
  };
  if (selection.modelId) payload.modelId = selection.modelId;
  return JSON.stringify(payload);
}

/**
 * Builds the HTTP headers attaching BOTH surfaces' selection metadata from an
 * explicit or cached `SavedAiSelections`. This is a PURE display/test helper —
 * it performs no readiness gating. Real requests use
 * `buildAiSelectionRequestOptions` (per-surface, deferred + fail-closed).
 */
export function buildAiSelectionHeaders(selections?: SavedAiSelections): Record<string, string> {
  const current = selections ?? getCachedAiSelections();
  const headers: Record<string, string> = {};
  const textValue = selectionToHeaderValue(current.textAi);
  if (textValue) headers[TEXT_SELECTION_HEADER] = textValue;
  const imageValue = selectionToHeaderValue(current.imageAi);
  if (imageValue) headers[IMAGE_SELECTION_HEADER] = imageValue;
  return headers;
}

/** Builds the single header for ONE surface from a selection (or nothing). */
function buildSurfaceHeader(kind: AiSelectionSurface, selection: SavedSelection): Record<string, string> {
  const value = selectionToHeaderValue(selection);
  if (!value) return {};
  return { [kind === 'text' ? TEXT_SELECTION_HEADER : IMAGE_SELECTION_HEADER]: value };
}

/**
 * Builds `NetworkRequestOptions` carrying the selection header for ONE surface
 * (defaults to `text`). Merge into any existing options object passed to
 * `network.post` / `network.request`.
 *
 * PER-SURFACE, DEFERRED + FAIL-CLOSED: when no explicit `selections` are
 * supplied this AWAITS only the REQUESTED surface's hydration, so a request made
 * before that surface resolves is deferred rather than routed to the server
 * default. A read error / malformed stored intent for that surface rejects — and
 * readiness of the OTHER surface is irrelevant to this request.
 */
export async function buildAiSelectionRequestOptions(
  existing?: NetworkRequestOptions,
  selections?: SavedAiSelections,
  surface: AiSelectionSurface = 'text'
): Promise<NetworkRequestOptions> {
  let selection: SavedSelection;
  if (selections) {
    selection = surface === 'text' ? selections.textAi : selections.imageAi;
  } else {
    const current = await awaitAiSelectionReady(surface);
    selection = surface === 'text' ? current.textAi : current.imageAi;
  }
  const headers = buildSurfaceHeader(surface, selection);
  if (Object.keys(headers).length === 0) {
    return existing ?? {};
  }
  return { ...existing, headers: { ...existing?.headers, ...headers } };
}