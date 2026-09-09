/**
 * The Kitchen Codex — Provider Status / AI Settings UI (v0.7 Phase 1E).
 *
 * A READ-ONLY, platform-neutral surface that surfaces the server operator's AI
 * provider configuration to users. It consumes the existing application
 * `NetworkAdapter` (never a direct fetch) and renders truthful state only:
 *
 *   - each provider's configured / enabled / available state,
 *   - its truthful storage source/scope,
 *   - its registry-owned capabilities (read-only, never user-editable).
 *
 * SECURITY:
 *   - No API key, token, masked key, or partial secret is ever rendered.
 *   - No key-entry / Reveal / Copy / Edit / Delete controls exist.
 *   - Provider state is read-only; there is no write API for secrets.
 *   - A failed status fetch renders a bounded "unavailable" state — it never
 *     invents provider states (fail-closed / no fabrication).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import {
  CAPABILITY_KEYS,
  capabilityLabel,
  createRequestSequencer,
  fetchProviderStatus,
  storageScopeLabel,
  type ProviderStatusView,
} from './providerStatus';

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

/** Presentational panel (pure, no hooks) — renders the list of provider cards. */
export function ProviderStatusPanel({
  statuses,
  onRefresh,
}: {
  statuses: ProviderStatusView[];
  onRefresh: () => void;
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

/**
 * Read-only provider status container. Fetches once on mount and exposes an
 * explicit Refresh; does NOT poll and never performs a real connection test.
 */
export function ProviderSettings({ network }: { network: NetworkAdapter }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [statuses, setStatuses] = useState<ProviderStatusView[]>([]);
  const sequencerRef = useRef(createRequestSequencer());

  const load = useCallback(() => {
    const requestId = sequencerRef.current.begin();
    setState('loading');
    fetchProviderStatus(network)
      .then((rows) => {
        // Stale success: a newer request has started — drop this result.
        if (!sequencerRef.current.isCurrent(requestId)) return;
        setStatuses(rows);
        setState('ready');
      })
      .catch(() => {
        // Stale failure: a newer request has started — do not let an older (slow)
        // failure overwrite the newer request's outcome. Fail-closed only if this
        // is still the newest request.
        if (!sequencerRef.current.isCurrent(requestId)) return;
        // A status fetch failure is NOT the same as every provider being
        // unavailable. Do not fabricate provider states.
        setStatuses([]);
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
    return <ProviderStatusError onRefresh={load} />;
  }

  return <ProviderStatusPanel statuses={statuses} onRefresh={load} />;
}

export default ProviderSettings;
