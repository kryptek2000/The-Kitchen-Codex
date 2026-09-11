/**
 * The Kitchen Codex — Provider Status / AI Settings UI (v0.7 Phase 1E + BYOK-4).
 *
 * Two surfaces:
 *   1. READ-ONLY provider status + model catalog (server operator truth), and
 *   2. INTERACTIVE non-secret client preferences:
 *        - per-surface (text / image) provider + model selection, persisted as
 *          NON-SECRET preferences and honored server-side per-request via
 *          `x-kitchen-ai-text-selection` / `x-kitchen-ai-image-selection`,
 *        - a REAL bounded "Test Connection" probe (server-side, rate-limited,
 *          never exposes API keys or raw provider errors).
 *
 * TRUTH / SECURITY MODEL:
 *   - No API key, token, masked key, or partial secret is ever rendered, stored,
 *     or transported by this UI. Selection preferences store provider/model IDs
 *     only (readable, non-secret).
 *   - No key-entry / Reveal / Copy / Edit / Delete secret controls exist.
 *   - A server-managed pin (catalog `selection.userSelectionAllowed == false`)
 *     locks the surface: the UI renders the selection read-only (fail-closed),
 *     and saved user preferences become inert server-side.
 *   - Selection IDs are validated against the CURRENT catalog for DISPLAY only;
 *     a stale/invalid selection is PRESERVED and fails closed (never silently
 *     rewritten to `server_default`, never another paid provider). Hydration is
 *     owned by the central application bootstrap (App.tsx), not this panel.
 *   - No model/capability data is fabricated: a failed status OR catalog fetch
 *     renders a bounded "unavailable" state (fail-closed / no fabrication).
 */

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../application/adapters/SettingsAdapter';
import type { AiCapabilities } from '../core/ai/types';
import {
  CAPABILITY_KEYS,
  capabilityLabel,
  createRequestSequencer,
  fetchProviderStatus,
  storageScopeLabel,
  type ProviderStatusView,
} from './providerStatus';
import {
  fetchProviderCatalog,
  type ProviderCatalogImageProviderView,
  type ProviderCatalogTextProviderView,
  type ProviderCatalogView,
  type ProviderSelectionView,
} from './providerCatalog';
import {
  getCachedAiSelections,
  hydrateAiSelections,
  isSelectionValidAgainstCatalog,
  resetAiSelectionWithOutcome,
  saveAiSelectionWithOutcome,
  type SavedCredentialSource,
  type SavedSelection,
  type SavedSelectionMode,
  type SavedAiSelections,
} from '../application/aiSelection';
import { SessionKeyPanel, type SessionKeyProviderOption } from './SessionKeyPanel';

/** The app-scoped server endpoint for a bounded provider connection test. */
export const PROVIDER_TEST_CONNECTION_API_PATH = '/api/providers/test-connection';

/** Per-provider connection test result view-model (bounded, secret-free). */
interface ConnectionTestView {
  state: 'idle' | 'testing' | 'success' | 'failure';
  latencyMs?: number;
  model?: string;
  code?: string;
  message?: string;
}

/** A surface selection draft held by the selection UI before Apply. */
export interface ProviderSelectionDraft {
  mode: SavedSelectionMode;
  providerId?: string;
  modelId?: string;
  /** BYOK-5E: non-secret credential-source preference (text surface). */
  credentialSource?: SavedCredentialSource;
}

/** Label for the server's connection-test surface kind (truthful, non-secret). */
function connectionTestKindLabel(kind: ProviderCatalogTextProviderView['connectionTest']): string {
  switch (kind) {
    case 'network_probe':
      return 'Network probe';
    case 'credential_check':
      return 'Credential check';
    default:
      return 'Unavailable';
  }
}

/**
 * Truthful success copy for a connection test. An IMAGE credential check does
 * NOT prove a generation connection, so it is labeled "Credential check passed"
 * (never "Connected · model"). A TEXT network probe is a real connection.
 */
export function connectionTestSuccessLabel(
  kind: ProviderCatalogTextProviderView['connectionTest'],
  model?: string
): string {
  if (kind === 'credential_check') return 'Credential check passed';
  return model ? `Connected · ${model}` : 'Connected';
}

/**
 * The upper "Server Environment Connection Tests" ALWAYS probe the operator/
 * environment credential source. Session-only credentials are validated
 * separately in the Session API Keys panel. This pure builder is exported so the
 * credential-source contract is directly testable (and can never silently drift
 * to `session_only`). No secret is ever included.
 */
export function buildServerEnvironmentTestBody(
  providerId: string,
  kind: 'text' | 'image',
  modelId?: string
): { providerId: string; kind: 'text' | 'image'; modelId?: string; credentialSource: 'server_environment' } {
  return {
    providerId,
    kind,
    ...(modelId ? { modelId } : {}),
    credentialSource: 'server_environment',
  };
}

/**
 * A truthful, NON-SECRET label for the USER's active runtime selection (their
 * browser preference), distinct from the server/operator catalog truth. Never
 * contains a key, version, expiry token, or any secret material.
 */
export function activeSelectionLabel(
  selection: SavedSelection,
  providers: { providerId: string; name: string }[] = []
): string {
  if (selection.mode !== 'user_selected' || !selection.providerId) return 'Server default';
  const name =
    providers.find((p) => p.providerId === selection.providerId)?.name ?? selection.providerId;
  const model = selection.modelId ? ` / ${selection.modelId}` : '';
  const source =
    selection.credentialSource === 'session_only'
      ? ' / Session only'
      : selection.credentialSource === 'server_environment'
      ? ' / Server environment'
      : '';
  return `${name}${model}${source}`;
}

/**
 * Truthful Apply/Reset confirmation for ONE operation. `persistenceFailed` is
 * the outcome of THAT operation's own SettingsAdapter write (never shared state),
 * so overlapping operations cannot misattribute a failure. If the write failed,
 * the selection is still active in memory for this session, so the copy must not
 * claim it was saved to the browser.
 */
export function selectionPersistenceNotice(base: string, persistenceFailed: boolean): string {
  return persistenceFailed
    ? `${base} (active this session; could not be saved to this browser)`
    : base;
}

/** Maps a saved selection to the fully-explicit editable draft shape. */
function selectionToDraft(selection: SavedSelection): ProviderSelectionDraft {
  return {
    mode: selection.mode,
    providerId: selection.providerId,
    modelId: selection.modelId,
    credentialSource: selection.credentialSource,
  };
}

type SelectionDrafts = { text: ProviderSelectionDraft; image: ProviderSelectionDraft };

/**
 * Pure Apply transition: synchronize ONLY the target surface's draft to the
 * actually-applied selection. The other surface is never touched.
 */
export function applyDraftSync(
  drafts: SelectionDrafts,
  kind: 'text' | 'image',
  applied: SavedSelection
): SelectionDrafts {
  return { ...drafts, [kind]: selectionToDraft(applied) };
}

/**
 * Pure Reset transition: reset ONLY the target surface's draft to
 * server_default. The other surface is never touched.
 */
export function resetDraftSync(drafts: SelectionDrafts, kind: 'text' | 'image'): SelectionDrafts {
  return { ...drafts, [kind]: selectionToDraft({ mode: 'server_default' }) };
}

/**
 * The selection-control state slice owned by `ProviderSelectionPanel`. This is a
 * pure reducer so the panel's Apply/Reset interaction is directly testable
 * without a DOM harness. The persistence outcome travels IN the action payload,
 * so it is ALWAYS operation-local (never inferred from shared module state).
 */
export interface ProviderSelectionControlState {
  saved: SavedAiSelections;
  drafts: SelectionDrafts;
  notices: { text?: string; image?: string };
  /**
   * Per-surface id of the MOST RECENTLY STARTED Apply/Reset operation. A
   * completion may mutate this surface's state ONLY when its captured id still
   * equals this value; older same-surface completions are discarded. The two
   * surfaces are INDEPENDENT (a new Image op never invalidates an in-flight Text
   * op, and vice versa).
   */
  opIds: { text: number; image: number };
}

export type ProviderSelectionControlAction =
  | { type: 'hydrated'; selections: SavedAiSelections }
  | { type: 'draftChanged'; kind: 'text' | 'image'; patch: Partial<ProviderSelectionDraft> }
  | { type: 'operationStarted'; kind: 'text' | 'image'; opId: number }
  | {
      type: 'applied';
      kind: 'text' | 'image';
      opId: number;
      selections: SavedAiSelections;
      persistenceFailed: boolean;
    }
  | {
      type: 'reset';
      kind: 'text' | 'image';
      opId: number;
      selections: SavedAiSelections;
      persistenceFailed: boolean;
    };

export function providerSelectionReducer(
  state: ProviderSelectionControlState,
  action: ProviderSelectionControlAction
): ProviderSelectionControlState {
  switch (action.type) {
    case 'hydrated':
      return {
        // Hydration is a full sync from the authoritative cache; it preserves the
        // monotonic per-surface operation ids so an in-flight operation is never
        // silently re-adopted by a late hydration.
        ...state,
        saved: action.selections,
        drafts: {
          text: selectionToDraft(action.selections.textAi),
          image: selectionToDraft(action.selections.imageAi),
        },
        // A fresh hydration never resurrects a stale confirmation.
        notices: {},
      };
    case 'draftChanged':
      return {
        ...state,
        drafts: { ...state.drafts, [action.kind]: { ...state.drafts[action.kind], ...action.patch } },
        // Any edit invalidates this surface's previous confirmation.
        notices: { ...state.notices, [action.kind]: undefined },
      };
    case 'operationStarted':
      return {
        ...state,
        opIds: { ...state.opIds, [action.kind]: action.opId },
      };
    case 'applied': {
      // SAME-SURFACE STALE-COMPLETION GUARD: ignore an older operation's result.
      if (action.opId !== state.opIds[action.kind]) return state;
      const key = action.kind === 'text' ? 'textAi' : 'imageAi';
      const applied = action.selections[key];
      return {
        ...state,
        // Merge ONLY the target surface — the opposite surface is never altered.
        saved: { ...state.saved, [key]: applied },
        drafts: applyDraftSync(state.drafts, action.kind, applied),
        notices: {
          ...state.notices,
          [action.kind]: selectionPersistenceNotice(
            applied.mode === 'user_selected' ? 'Selection applied' : 'Reset to server default',
            action.persistenceFailed
          ),
        },
      };
    }
    case 'reset': {
      // SAME-SURFACE STALE-COMPLETION GUARD: ignore an older operation's result.
      if (action.opId !== state.opIds[action.kind]) return state;
      const key = action.kind === 'text' ? 'textAi' : 'imageAi';
      return {
        ...state,
        // Merge ONLY the target surface — the opposite surface is never altered.
        saved: { ...state.saved, [key]: { mode: 'server_default' } },
        drafts: resetDraftSync(state.drafts, action.kind),
        notices: {
          ...state.notices,
          [action.kind]: selectionPersistenceNotice(
            'Reset to server default',
            action.persistenceFailed
          ),
        },
      };
    }
  }
}

/** The initial selection-control state from the current cached selections. */
export function initialProviderSelectionControlState(): ProviderSelectionControlState {
  const cached = getCachedAiSelections();
  return {
    saved: cached,
    drafts: {
      text: selectionToDraft(cached.textAi),
      image: selectionToDraft(cached.imageAi),
    },
    notices: {},
    opIds: { text: 0, image: 0 },
  };
}

/**
 * BYOK-5E: true when a TEXT credential-source transition (or a reset to
 * server_default, represented by `undefined`) must clear any typed session key.
 * Only `session_only` keeps the session-key panel's typed state.
 */
export function shouldClearSessionKeyOnCredentialSource(
  source: SavedCredentialSource | undefined
): boolean {
  return source !== 'session_only';
}

/**
 * Fail-closed copy for an unavailable provider catalog. It must NOT promise a
 * server-default execution when an explicit saved user selection may still be
 * active/fail-closed.
 */
export const PROVIDER_CATALOG_UNAVAILABLE_COPY =
  'The provider catalog is unavailable, so this view cannot show provider truth. Your saved provider selection still applies and fails closed if it is stale — AI requests are never silently routed to a different paid provider.';

/** Renders a single provider card (pure presentational piece, no hooks). */
function ProviderCard({ status }: { status: ProviderStatusView }) {
  const configured = status.configured ? 'Configured' : 'Not configured';
  const enabled = status.enabled ? 'Enabled' : 'Disabled';
  const available = status.available ? 'Available' : 'Unavailable';
  const supportedCapabilities = CAPABILITY_KEYS.filter((k) => status.capabilities[k] === true);

  return (
    <article
      data-provider-id={status.providerId}
      className="border border-white/10 rounded-2xl bg-[#141414] p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{status.name}</h3>
        {/* Optional providers that are simply unconfigured are normal, not errors. */}
        <span className="text-[10px] font-medium text-gray-500">{status.providerId}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span
          className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
            status.configured
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
              : 'bg-white/5 text-gray-400 border-white/10'
          }`}
        >
          {configured}
        </span>
        <span
          className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
            status.enabled
              ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
              : 'bg-white/5 text-gray-400 border-white/10'
          }`}
        >
          {enabled}
        </span>
        <span
          className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
            status.available
              ? 'bg-sky-500/10 text-sky-300 border-sky-500/30'
              : 'bg-white/5 text-gray-400 border-white/10'
          }`}
        >
          {available}
        </span>
      </div>

      <div className="text-[11px] text-gray-400 space-y-1">
        <div>
          Secret source:{' '}
          <span className="text-gray-300">{storageScopeLabel(status.storageScope)}</span>
        </div>
        <div>
          Managed by: <span className="text-gray-300">server operator</span>
        </div>
        <div>
          Secret writes: <span className="text-gray-300">{status.supportsSecretWrites ? 'Supported' : 'Not supported'}</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Capabilities</div>
        {supportedCapabilities.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {supportedCapabilities.map((k) => (
              <span
                key={k}
                className="px-2 py-0.5 rounded-md text-[10px] text-gray-300 bg-white/5 border border-white/10"
              >
                {capabilityLabel(k)}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-gray-500">No provider-backed capabilities for this provider.</div>
        )}
      </div>
    </article>
  );
}

/** Renders the per-model capability chips (read from the server-owned catalog truth). */
function ModelCapabilities({ capabilities }: { capabilities: AiCapabilities }) {
  const supported = CAPABILITY_KEYS.filter((k) => capabilities[k] === true);
  if (supported.length === 0) {
    return <div className="text-[10px] text-gray-500">No curated capabilities for this model.</div>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {supported.map((k) => (
        <span
          key={k}
          className="px-2 py-0.5 rounded-md text-[10px] text-gray-300 bg-white/5 border border-white/10"
        >
          {capabilityLabel(k)}
        </span>
      ))}
    </div>
  );
}

/** Renders a single text-provider model list (read-only, no selection controls). */
function ModelCatalogTextCard({ provider }: { provider: ProviderCatalogTextProviderView }) {
  return (
    <article
      data-catalog-provider-id={provider.providerId}
      className="border border-white/10 rounded-2xl bg-[#141414] p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-white">{provider.name}</h4>
        <span className="text-[10px] font-medium text-gray-500">{provider.providerId}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-400 border-white/10">
          Connection: {connectionTestKindLabel(provider.connectionTest)}
        </span>
        {provider.selectable ? (
          <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
            Selectable
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-400 border-white/10">
            Not selectable
          </span>
        )}
      </div>
      <div className="space-y-2">
        {provider.models.length > 0 ? (
          provider.models.map((model) => (
            <div
              key={model.id}
              data-model-id={model.id}
              className="space-y-1.5 border border-white/5 rounded-xl p-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-gray-200 font-mono">{model.id}</span>
                {model.default && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-white/10 text-gray-300 border border-white/10">
                    Default
                  </span>
                )}
              </div>
              <ModelCapabilities capabilities={model.capabilities} />
            </div>
          ))
        ) : (
          <div className="text-[11px] text-gray-500">No curated models for this provider.</div>
        )}
      </div>
    </article>
  );
}

/** Renders a single image-provider card (read-only). */
function ImageModelCatalogCard({ provider }: { provider: ProviderCatalogImageProviderView }) {
  return (
    <article
      data-catalog-provider-id={provider.providerId}
      className="border border-white/10 rounded-2xl bg-[#141414] p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-white">{provider.name}</h4>
        <span className="text-[10px] font-medium text-gray-500">{provider.providerId}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-400 border-white/10">
          Image generation: {provider.imageGeneration ? 'Enabled' : 'Disabled'}
        </span>
        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-400 border-white/10">
          Connection: {connectionTestKindLabel(provider.connectionTest)}
        </span>
        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-400 border-white/10">
          Formats: {provider.formats.join(', ')}
        </span>
        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-400 border-white/10">
          Max size: {formatMaxBytes(provider.maxBytes)}
        </span>
      </div>
      <div className="space-y-2">
        {provider.models.map((model) => (
          <div key={model.id} data-model-id={model.id} className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-gray-200 font-mono">{model.id}</span>
            {model.default && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-white/10 text-gray-300 border border-white/10">
                Default
              </span>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

/** Formats a byte limit truthfully for display (e.g. 4194304 -> "4 MB"). */
function formatMaxBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${bytes} bytes`;
}

/** Renders one read-only selection-truth block (text or image). */
function SelectionSummaryCard({
  kind,
  selection,
  executable,
}: {
  kind: 'text' | 'image';
  selection: ProviderSelectionView;
  /** Runtime executability truth from the server (`selection.executable`). */
  executable?: boolean;
}) {
  const label = kind === 'text' ? 'Server Text AI' : 'Server Image AI';
  const value =
    selection.selectionMode === 'server_managed'
      ? `Server managed: ${selection.selectedProviderId ?? '(unset)'}${selection.selectedModelId ? ` / ${selection.selectedModelId}` : ''}`
      : 'Server default';
  return (
    <div
      data-selection-kind={kind}
      className="border border-white/10 rounded-xl bg-white/[0.03] p-3 space-y-1"
    >
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
      <div className="text-[12px] text-gray-200">{value}</div>
      <div className="text-[10px] text-gray-500">
        Operator/server truth (not your browser selection).
      </div>
      {executable !== undefined && (
        <div
          data-selection-executable={kind}
          className={`text-[11px] ${executable ? 'text-emerald-300' : 'text-amber-300'}`}
        >
          Runtime provider: {executable ? 'Available' : 'Unavailable'}
        </div>
      )}
      {selection.selectionMode === 'server_managed' && !selection.valid && (
        <div className="text-[11px] text-amber-300">Server-managed provider selection is invalid; Kitchen Codex will not use another provider until the selection is fixed.</div>
      )}
    </div>
  );
}

/** Presentational panel (pure, no hooks) — renders the provider list of cards. */
export function ProviderStatusPanel({
  statuses,
  onRefresh,
  catalog,
}: {
  statuses: ProviderStatusView[];
  onRefresh: () => void;
  catalog?: ProviderCatalogView;
}) {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-white/5">
        <div>
          <h2 className="font-serif font-bold text-base text-white">AI Providers</h2>
          <p className="text-xs text-gray-400 mt-1 max-w-2xl">
            AI providers are configured by the server operator. API keys are not stored in your
            browser or vault.
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-gray-200 hover:bg-white/15 border border-white/10 transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {statuses.map((s) => (
          <ProviderCard key={s.providerId} status={s} />
        ))}
      </div>

      {catalog && (
        <section
          data-catalog-section="provider-model-catalog"
          className="space-y-5 pt-4 border-t border-white/5"
        >
          <div>
            <h3 className="font-serif font-semibold text-sm text-white">Provider Model Catalog</h3>
            <p className="text-xs text-gray-400 mt-1 max-w-2xl">
              The curated models this server can actually execute, with their effective
              capabilities. Read-only — selection and keys are managed by the server operator.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SelectionSummaryCard
              kind="text"
              selection={catalog.selection.text}
              executable={catalog.selection.executable.text}
            />
            <SelectionSummaryCard
              kind="image"
              selection={catalog.selection.image}
              executable={catalog.selection.executable.image}
            />
          </div>

          <div data-catalog-kind="text" className="space-y-3">
            {catalog.textProviders.map((provider) => (
              <ModelCatalogTextCard key={provider.providerId} provider={provider} />
            ))}
          </div>

          <div className="space-y-3">
            <h4 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
              Image Providers
            </h4>
            <div data-catalog-kind="image" className="space-y-3">
              {catalog.imageProviders.map((provider) => (
                <ImageModelCatalogCard key={provider.providerId} provider={provider} />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Presentational loading state. */
export function ProviderStatusLoading() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 text-sm text-gray-400">
      Loading provider status…
    </div>
  );
}

/** Presentational fail-closed error state (a fetch failure is NOT provider-unavailable). */
export function ProviderStatusError({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <div className="border border-white/10 rounded-2xl bg-[#141414] p-4 space-y-3 max-w-md">
        <p className="text-sm text-white">Provider status unavailable.</p>
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-gray-200 hover:bg-white/15 border border-white/10 transition-colors"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactive BYOK-4 selection + connection-test UI (stateful; rendered by
// ProviderSettings after the catalog loads).
// ---------------------------------------------------------------------------

/** Presentational surface-selection controls (value -> callback, no hooks). */
export function SelectionControlCard({
  kind,
  label,
  allowed,
  effective,
  lockedPin,
  invalid,
  draft,
  providers,
  allowSessionCredential,
  notice,
  onChangeDraft,
  onApply,
  onReset,
}: {
  kind: 'text' | 'image';
  label: string;
  allowed: boolean;
  effective: SavedSelection;
  lockedPin?: { selectedProviderId?: string; selectedModelId?: string };
  invalid?: boolean;
  draft: ProviderSelectionDraft;
  providers: { providerId: string; name: string; models: { id: string; default: boolean }[] }[];
  /** Text surfaces may select session_only; image session generation is deferred. */
  allowSessionCredential?: boolean;
  /** Non-secret confirmation shown after a successful Apply/Reset. */
  notice?: string;
  onChangeDraft: (patch: Partial<ProviderSelectionDraft>) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const selectedProvider = providers.find((p) => p.providerId === draft.providerId);
  const activeLabel = activeSelectionLabel(effective, providers);

  return (
    <div
      data-selection-control-kind={kind}
      className="border border-white/10 rounded-2xl bg-[#141414] p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-white">{label}</h4>
        {!allowed && (
          <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-amber-500/10 text-amber-300 border-amber-500/30">
            Server locked
          </span>
        )}
      </div>

      <div data-active-selection={kind} className="text-[11px] text-gray-300">
        Active selection: <span className="text-gray-100">{activeLabel}</span>
      </div>
      {notice && (
        <div
          data-selection-notice={kind}
          role="status"
          aria-live="polite"
          className="text-[11px] text-emerald-300"
        >
          {notice}
        </div>
      )}

      {!allowed ? (
        <div className="text-[11px] text-gray-400">
          The server operator has pinned this surface to{' '}
          <span className="text-gray-200">
            {lockedPin?.selectedProviderId ?? effective.providerId ?? 'the default provider'}
            {lockedPin?.selectedProviderId ? ` / ${lockedPin.selectedModelId ?? 'provider default'}` : effective.modelId ? ` / ${effective.modelId}` : ''}
          </span>
          . Your preference cannot override it and will not be charged to another provider.
        </div>
      ) : (
        <div className="space-y-3">
          {invalid && (
            <div
              data-selection-invalid={kind}
              className="text-[11px] rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 px-2.5 py-2"
            >
              Your saved selection is no longer available. It fails closed — no other provider
              is used — until you apply a new selection or reset to server default.
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Mode</span>
            <select
              data-selection-mode-select={kind}
              value={draft.mode}
              onChange={(e) => onChangeDraft({ mode: e.target.value as SavedSelectionMode })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
            >
              <option value="server_default">Server default</option>
              <option value="user_selected">Use my selection</option>
            </select>
          </label>

          {draft.mode === 'user_selected' && (
            <>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Provider</span>
                <select
                  data-selection-provider-select={kind}
                  value={draft.providerId ?? ''}
                  onChange={(e) =>
                    onChangeDraft({ providerId: e.target.value || undefined, modelId: undefined })
                  }
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
                >
                  <option value="">Choose a provider…</option>
                  {providers.map((p) => (
                    <option key={p.providerId} value={p.providerId}>
                      {p.name} ({p.providerId})
                    </option>
                  ))}
                </select>
              </label>

              {selectedProvider && selectedProvider.models.length > 0 && (
                <label className="block space-y-1">
                  <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Model</span>
                  <select
                    data-selection-model-select={kind}
                    value={draft.modelId ?? ''}
                    onChange={(e) => onChangeDraft({ modelId: e.target.value || undefined })}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
                  >
                    <option value="">Provider default ({selectedProvider.models.find((m) => m.default)?.id ?? 'first'})</option>
                    {selectedProvider.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {allowSessionCredential ? (
                <label className="block space-y-1">
                  <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
                    Credential source
                  </span>
                  <select
                    data-selection-credential-source-select={kind}
                    value={draft.credentialSource ?? 'server_environment'}
                    onChange={(e) =>
                      onChangeDraft({
                        credentialSource:
                          e.target.value === 'session_only' ? 'session_only' : 'server_environment',
                      })
                    }
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
                  >
                    <option value="server_environment">Server environment</option>
                    <option value="session_only">Session only</option>
                  </select>
                  <span className="block text-[10px] text-gray-500">
                    {draft.credentialSource === 'session_only'
                      ? 'Uses a key stored only in this server process memory. It expires automatically and is lost when the server restarts.'
                      : 'Uses the API key configured on the Kitchen Codex server.'}
                  </span>
                </label>
              ) : (
                <div className="text-[10px] text-gray-500">
                  Session credentials are not available for this surface.
                </div>
              )}
            </>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              data-selection-apply={kind}
              onClick={onApply}
              disabled={draft.mode === 'user_selected' && !draft.providerId}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-gray-200 hover:bg-white/15 border border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply selection
            </button>
            <button
              type="button"
              data-selection-reset={kind}
              onClick={onReset}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 text-gray-400 hover:bg-white/10 border border-white/10 transition-colors"
            >
              Reset to default
            </button>
          </div>
          <div className="text-[11px] text-gray-500">
            Stored in your browser preferences only (provider/model IDs — never API keys). The
            server re-validates every selection against its own catalog.
          </div>
        </div>
      )}
    </div>
  );
}

/** Interactive BYOK-4 panel: selection preference + connection tests. */
export function ProviderSelectionPanel({
  catalog,
  settings,
  network,
  onCredentialSourceChange,
}: {
  catalog: ProviderCatalogView;
  settings: SettingsAdapter;
  network: NetworkAdapter;
  /** BYOK-5E: notified when the TEXT credential source changes (to clear typed keys). */
  onCredentialSourceChange?: (source: SavedCredentialSource | undefined) => void;
}) {
  // The selection-control slice is a pure reducer (component-used) so the
  // Apply/Reset interaction is directly testable without a DOM harness. The
  // persistence outcome is carried IN the dispatched action (operation-local).
  const [control, dispatch] = useReducer(
    providerSelectionReducer,
    undefined,
    initialProviderSelectionControlState
  );
  const { saved, drafts, notices } = control;
  // Per-surface monotonic operation counters. The guard is PER SURFACE: a new
  // Image operation never invalidates an in-flight Text operation (and vice
  // versa). Hydration uses aiSelection's separate deliberate-generation guard.
  const opCounterRef = useRef<{ text: number; image: number }>({ text: 0, image: 0 });
  const [tests, setTests] = useState<Record<string, ConnectionTestView>>({});
  const [hydrationError, setHydrationError] = useState(false);

  // Reflect the APPLICATION-BOOTSTRAP hydration (App.tsx). This panel is NOT the
  // hydration trigger; it only observes the shared application state so the UI
  // is truthful even when the user never opened Provider Settings. A settings
  // read error is surfaced explicitly and is NEVER presented as server_default.
  useEffect(() => {
    let cancelled = false;
    hydrateAiSelections(settings)
      .then((effective) => {
        if (cancelled) return;
        setHydrationError(false);
        dispatch({ type: 'hydrated', selections: effective });
      })
      .catch(() => {
        if (!cancelled) setHydrationError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  // BYOK-5F: the user-selectable provider list is CREDENTIAL-SOURCE AWARE. A
  // provider is offered when it is selectable under EITHER source:
  //   - server_environment: the existing environment availability/selectability;
  //   - session_only: the server declares it session-capable AND the deployment
  //     supports session-only BYOK (operator env availability is irrelevant).
  // Unknown/unregistered providers are never offered (they are not in the
  // server-owned catalog), and the server re-validates every selection.
  const sessionByokSupported = catalog.sessionByokSupported === true;
  const isSessionSelectable = (p: { sessionKeySupported: boolean; models: unknown[] }) =>
    sessionByokSupported && p.sessionKeySupported && p.models.length > 0;
  const selectedTextProviders = catalog.textProviders.filter((p) => p.selectable || isSessionSelectable(p));
  const selectedImageProviders = catalog.imageProviders.filter((p) => p.selectable || isSessionSelectable(p));

  // A preserved explicit selection that no longer exists in the catalog is shown
  // as invalid; it keeps failing closed at the server until the user resets.
  const textSelectionInvalid =
    saved.textAi.mode === 'user_selected' && !isSelectionValidAgainstCatalog(saved.textAi, catalog, 'text');
  const imageSelectionInvalid =
    saved.imageAi.mode === 'user_selected' && !isSelectionValidAgainstCatalog(saved.imageAi, catalog, 'image');

  const changeDraft = useCallback(
    (kind: 'text' | 'image', patch: Partial<ProviderSelectionDraft>) => {
      dispatch({ type: 'draftChanged', kind, patch });
      // BYOK-5E/5F: tell the session panel to clear any typed session key whenever
      // a surface's credential source changes away from session_only (or the mode
      // resets to server_default).
      if (patch.mode === 'server_default') onCredentialSourceChange?.(undefined);
      else if (patch.credentialSource !== undefined) onCredentialSourceChange?.(patch.credentialSource);
    },
    [onCredentialSourceChange]
  );

  const applySelection = useCallback(
    async (kind: 'text' | 'image') => {
      const draft = drafts[kind];
      // Capture THIS operation's per-surface id; a newer same-surface operation
      // bumps the counter so this completion is discarded as stale.
      const opId = (opCounterRef.current[kind] += 1);
      dispatch({ type: 'operationStarted', kind, opId });
      // The persistence outcome is returned by THIS exact operation — never read
      // from shared state — so concurrent surfaces cannot contaminate each other.
      const { selections, persistenceFailed } = await saveAiSelectionWithOutcome(
        settings,
        kind,
        draft.mode,
        draft.providerId,
        draft.modelId,
        draft.mode === 'user_selected' ? draft.credentialSource : undefined
      );
      dispatch({ type: 'applied', kind, opId, selections, persistenceFailed });
    },
    [settings, catalog, drafts]
  );

  const resetSelection = useCallback(
    async (kind: 'text' | 'image') => {
      const opId = (opCounterRef.current[kind] += 1);
      dispatch({ type: 'operationStarted', kind, opId });
      // The persistence outcome is operation-local (see applySelection).
      const { selections, persistenceFailed } = await resetAiSelectionWithOutcome(settings, kind);
      dispatch({ type: 'reset', kind, opId, selections, persistenceFailed });
      // BYOK-5E/5F: resetting a surface to server_default must clear any typed
      // session key (same signal as switching away from session_only). The
      // server-side session key is NOT revoked and no provider traffic occurs.
      onCredentialSourceChange?.(undefined);
    },
    [settings, onCredentialSourceChange]
  );

  const testConnection = useCallback(
    async (kind: 'text' | 'image', providerId: string, modelId?: string) => {
      const key = `${kind}:${providerId}`;
      setTests((prev) => ({ ...prev, [key]: { state: 'testing' } }));
      try {
        // BYOK-5E: the explicit per-provider test uses the operator environment
        // credential source; session-only testing is owned by SessionKeyPanel.
        const res = await network.post<{
          ok?: boolean;
          model?: string;
          latencyMs?: number;
          code?: string;
          message?: string;
        }>(PROVIDER_TEST_CONNECTION_API_PATH, buildServerEnvironmentTestBody(providerId, kind, modelId));
        const data = res.data ?? {};
        if (res.ok && data.ok === true) {
          setTests((prev) => ({
            ...prev,
            [key]: { state: 'success', latencyMs: data.latencyMs, model: data.model },
          }));
        } else {
          setTests((prev) => ({
            ...prev,
            [key]: {
              state: 'failure',
              code: data.code ?? 'PROVIDER_ERROR',
              message: data.message ?? 'Connection test failed.',
            },
          }));
        }
      } catch {
        setTests((prev) => ({
          ...prev,
          [key]: { state: 'failure', code: 'NETWORK_ERROR', message: 'Could not reach the server.' },
        }));
      }
    },
    [network]
  );

  const allProviders: {
    kind: 'text' | 'image';
    providerId: string;
    name: string;
    connectionTest: ProviderCatalogTextProviderView['connectionTest'];
    sessionKeySupported: boolean;
    defaultModelId?: string;
  }[] = [
    ...catalog.textProviders.map((p) => ({
      kind: 'text' as const,
      providerId: p.providerId,
      name: p.name,
      connectionTest: p.connectionTest,
      sessionKeySupported: p.sessionKeySupported,
      defaultModelId: p.models.find((m) => m.default)?.id ?? p.models[0]?.id,
    })),
    ...catalog.imageProviders.map((p) => ({
      kind: 'image' as const,
      providerId: p.providerId,
      name: p.name,
      connectionTest: p.connectionTest,
      sessionKeySupported: p.sessionKeySupported,
      defaultModelId: p.models.find((m) => m.default)?.id ?? p.models[0]?.id,
    })),
  ];

  return (
    <section
      data-selection-panel="provider-selection"
      className="max-w-7xl mx-auto px-4 sm:px-6 space-y-6"
    >
      <div className="pt-4 border-t border-white/5">
        <h3 className="font-serif font-semibold text-sm text-white">Your AI Provider Selection</h3>
        <p className="text-xs text-gray-400 mt-1 max-w-2xl">
          Choose which provider your AI requests use. Preferences are stored in this browser only
          (never API keys) and validated by the server on every request. When the server operator
          pins a provider, that pin always wins and this panel locks.
        </p>
      </div>

      {hydrationError && (
        <div
          data-selection-hydration-error="true"
          className="text-[11px] rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 px-3 py-2"
        >
          Your saved AI provider selection could not be read. AI requests fail closed (no provider
          is charged) until this is resolved — they do not silently fall back to the server default.
        </div>
      )}

      {!catalog.selection.userSelectionAllowed.text && !catalog.selection.userSelectionAllowed.image ? (
        <div className="text-[12px] text-gray-400">
          All provider surfaces are currently server-managed. Selections are read-only until an
          operator pin is removed.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SelectionControlCard
            kind="text"
            label="Text AI"
            allowed={catalog.selection.userSelectionAllowed.text}
            effective={saved.textAi}
            lockedPin={catalog.selection.text}
            invalid={textSelectionInvalid}
            draft={drafts.text}
            providers={selectedTextProviders}
            allowSessionCredential
            notice={notices.text}
            onChangeDraft={(patch) => changeDraft('text', patch)}
            onApply={() => applySelection('text')}
            onReset={() => resetSelection('text')}
          />
          <SelectionControlCard
            kind="image"
            label="Image AI"
            allowed={catalog.selection.userSelectionAllowed.image}
            effective={saved.imageAi}
            lockedPin={catalog.selection.image}
            invalid={imageSelectionInvalid}
            draft={drafts.image}
            providers={selectedImageProviders}
            allowSessionCredential
            notice={notices.image}
            onChangeDraft={(patch) => changeDraft('image', patch)}
            onApply={() => applySelection('image')}
            onReset={() => resetSelection('image')}
          />
        </div>
      )}

      <div className="pt-2 border-t border-white/5">
        <h4 className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
          Server Environment Connection Tests
        </h4>
        <p className="text-xs text-gray-400 mt-1 max-w-2xl">
          These tests check credentials configured by the server operator (the environment
          credential source). Text providers execute a minimal chat call; image providers run a
          quota-free credential check. Session-only credentials are tested separately in Session
          API Keys below. Results never include API keys or raw provider errors, and tests are
          rate-limited server-side.
        </p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {allProviders.map((p) => {
            const key = `${p.kind}:${p.providerId}`;
            const result = tests[key];
            const unavailable = p.connectionTest === 'unavailable';
            // A provider with no operator env key is NOT generically "unavailable":
            // it may be session-capable (and even have a configured session key).
            const sessionAlternative =
              unavailable && sessionByokSupported && p.sessionKeySupported;
            return (
              <div
                key={key}
                data-connection-test-provider={p.providerId}
                className="border border-white/10 rounded-xl bg-white/[0.03] p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[12px] text-gray-200">
                    <span className="font-medium">{p.name}</span>{' '}
                    <span className="text-[10px] text-gray-500">{p.kind}</span>
                  </div>
                  <button
                    type="button"
                    data-connection-test-run={key}
                    onClick={() => testConnection(p.kind, p.providerId, p.defaultModelId)}
                    disabled={result?.state === 'testing' || unavailable}
                    title={unavailable ? 'No server operator key is configured for this provider (environment test unavailable).' : undefined}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white/10 text-gray-200 hover:bg-white/15 border border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {result?.state === 'testing' ? 'Testing…' : 'Test Connection'}
                  </button>
                </div>
                {sessionAlternative && (
                  <div className="text-[11px] text-amber-300/90">
                    Environment credential unavailable. This provider is session-capable — test a
                    session key in Session API Keys below.
                  </div>
                )}
                {result?.state === 'success' && (
                  <div className="text-[11px] text-emerald-300">
                    {connectionTestSuccessLabel(p.connectionTest, result.model)}
                    {result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ''}
                  </div>
                )}
                {result?.state === 'failure' && (
                  <div className="text-[11px] text-red-300">
                    {result.message ?? 'Connection test failed.'}
                    {result.code ? ` (${result.code})` : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="text-[11px] text-gray-500 mt-2">
          A provider with no operator environment key cannot be tested here (its environment
          credential is unavailable) — but it may still be usable with a session key; test that in
          Session API Keys below. A provider with an unavailable environment credential never
          affects the others.
        </div>
      </div>
    </section>
  );
}

/**
 * Provider status + selection container. Fetches status + catalog once on mount
 * (refreshable), delegates AI-selection preference hydration to
 * `ProviderSelectionPanel`, and never polls. `network` is the application
 * transport; `settings` is the browser preferences store (non-secret).
 */
export function ProviderSettings({
  network,
  settings,
}: {
  network: NetworkAdapter;
  settings: SettingsAdapter;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [statuses, setStatuses] = useState<ProviderStatusView[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalogView | null>(null);
  const sequencerRef = useRef(createRequestSequencer());
  // BYOK-5E: incremented when the TEXT credential source switches away from
  // session_only, so the session panel clears any typed (in-memory) key.
  const [sessionClearSignal, setSessionClearSignal] = useState(0);

  const load = useCallback(() => {
    const requestId = sequencerRef.current.begin();
    setState('loading');
    // Status + catalog are fetched together; BOTH must succeed or the panel
    // fails closed (no fabricated providers or model lists).
    Promise.all([fetchProviderStatus(network), fetchProviderCatalog(network)])
      .then(([rows, catalogRows]) => {
        // Stale success: a newer request has started — drop this result.
        if (!sequencerRef.current.isCurrent(requestId)) return;
        setStatuses(rows);
        setCatalog(catalogRows);
        setState('ready');
      })
      .catch(() => {
        // Stale failure: a newer request has started — do not let an older (slow)
        // failure overwrite the newer request's outcome. Fail-closed only if this
        // is still the newest request.
        if (!sequencerRef.current.isCurrent(requestId)) return;
        // A status/catalog fetch failure is NOT the same as every provider being
        // unavailable. Do not fabricate provider states or model catalogs.
        setStatuses([]);
        setCatalog(null);
        setState('error');
      });
  }, [network]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === 'loading') {
    return <ProviderStatusLoading />;
  }

  if (state === 'error') {
    return (
      <>
        <ProviderStatusError onRefresh={load} />
        <div className="text-xs text-gray-500 max-w-2xl px-4 sm:px-6 pb-6">
          {PROVIDER_CATALOG_UNAVAILABLE_COPY}
        </div>
      </>
    );
  }

  const sessionKeyProviders: SessionKeyProviderOption[] = catalog
    ? [
        ...catalog.textProviders.map((p) => ({
          providerId: p.providerId,
          name: p.name,
          kind: 'text' as const,
          models: p.models.map((m) => ({ id: m.id, default: m.default })),
        })),
        ...catalog.imageProviders.map((p) => ({
          providerId: p.providerId,
          name: p.name,
          kind: 'image' as const,
          models: p.models.map((m) => ({ id: m.id, default: m.default })),
        })),
      ]
    : [];

  return (
    <>
      <ProviderStatusPanel statuses={statuses} catalog={catalog ?? undefined} onRefresh={load} />
      {catalog && (
        <ProviderSelectionPanel
          catalog={catalog}
          settings={settings}
          network={network}
          onCredentialSourceChange={(source) => {
            if (shouldClearSessionKeyOnCredentialSource(source)) setSessionClearSignal((n) => n + 1);
          }}
        />
      )}
      {catalog && (
        <SessionKeyPanel
          network={network}
          sessionByokSupported={catalog.sessionByokSupported === true}
          providers={sessionKeyProviders}
          clearKeySignal={sessionClearSignal}
        />
      )}
    </>
  );
}

export default ProviderSettings;