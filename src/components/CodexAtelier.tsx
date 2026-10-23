import React, { useEffect, useState, useCallback } from 'react';
import {
  BrainCircuit,
  Sparkles,
  BookOpen,
  Library,
  Image as ImageIcon,
  LayoutGrid,
  RefreshCw,
} from 'lucide-react';
import { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { SettingsAdapter } from '../application/adapters/SettingsAdapter';
import { ProviderSettings, ProviderStatusPanel, ProviderStatusLoading, ProviderStatusError } from '../application-ui/ProviderSettings';
import { fetchProviderStatus } from '../application-ui/providerStatus';
import { fetchProviderCatalog } from '../application-ui/providerCatalog';
import type { ProviderStatusView } from '../application-ui/providerStatus';
import type { ProviderCatalogView } from '../application-ui/providerCatalog';

type StudioSection = 'overview' | 'providers' | 'library' | 'image';

const SECTIONS: { id: StudioSection; label: string; description: string }[] = [
  { id: 'overview', label: 'Overview', description: 'Studio at a glance' },
  { id: 'providers', label: 'Providers', description: 'Text AI selection' },
  { id: 'library', label: 'Living Library', description: 'Model discovery (UD-2C)' },
  { id: 'image', label: 'Image configuration', description: 'Image AI selection' },
];

interface CodexAtelierProps {
  network: NetworkAdapter;
  settings: SettingsAdapter;
  onTextAiRuntimeChanged?: () => void;
}

/**
 * The Codex Atelier — the unified AI Studio workspace (UD-2B).
 *
 * Visual shell only: it reuses the existing provider/model configuration
 * behaviour (ProviderSettings) and adds an editorial Atelier heading plus a
 * Studio section navigator. No backend, provider orchestration, or nutrition
 * logic is changed here.
 */
export function CodexAtelier({ network, settings, onTextAiRuntimeChanged }: CodexAtelierProps) {
  const [section, setSection] = useState<StudioSection>('overview');

  return (
    <section
      data-codex-atelier="true"
      className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6"
    >
      {/* Editorial Studio heading */}
      <header className="space-y-2 pb-4 border-b border-[var(--color-rule,var(--bg-elevated))]">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold text-[var(--text-muted,#6B7280)]">
          <BrainCircuit className="w-4 h-4" aria-hidden="true" />
          <span>AI Studio</span>
        </div>
        <h1 className="font-serif text-[32px] sm:text-[40px] leading-[1.15] text-[var(--text-primary,#F3F4F6)]">
          The Codex Atelier
        </h1>
        <p className="text-[14px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)] max-w-2xl">
          A refined workspace for assigning the AI providers and models Kitchen Codex uses.
          Provider keys and catalog truth remain server-owned; this surface only configures
          non-secret preferences and tests connectivity.
        </p>
      </header>

      {/* Studio section navigator — desktop tabs */}
      <nav
        aria-label="Studio sections"
        className="hidden md:block"
      >
        <div className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => {
            const active = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                data-studio-section={s.id}
                aria-current={active ? 'page' : undefined}
                onClick={() => setSection(s.id)}
                className={[
                  'px-4 py-2 rounded-lg text-[13px] font-medium transition-colors duration-[140ms] min-h-[44px]',
                  'border focus-visible:outline-none',
                  active
                    ? 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)] border-[var(--accent-text,#F59E0B)]'
                    : 'bg-[var(--bg-surface,#141414)] text-[var(--text-secondary,#9CA3AF)] border-[var(--color-control-border,rgba(255,255,255,0.1))] hover:bg-[var(--bg-elevated,#1E1E1E)]',
                ].join(' ')}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Studio section navigator — mobile native select */}
      <div className="md:hidden">
        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">
            Studio section
          </span>
          <select
            data-studio-section-select="true"
            value={section}
            onChange={(e) => setSection(e.target.value as StudioSection)}
            className="w-full min-h-[48px] bg-[var(--bg-surface,#141414)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-lg px-3 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)]"
          >
            {SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.description}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Section content */}
      <div className="pt-2">
        {section === 'overview' && (
          <AtelierOverview network={network} settings={settings} onNavigate={setSection} />
        )}
        {section === 'providers' && (
          <ProviderSettings
            network={network}
            settings={settings}
            onTextAiRuntimeChanged={onTextAiRuntimeChanged}
            focus="all"
          />
        )}
        {section === 'library' && <AtelierLibraryPlaceholder onNavigate={setSection} />}
        {section === 'image' && (
          <ProviderSettings
            network={network}
            settings={settings}
            onTextAiRuntimeChanged={onTextAiRuntimeChanged}
            focus="image"
          />
        )}
      </div>
    </section>
  );
}

function AtelierOverview({
  network,
  settings,
  onNavigate,
}: {
  network: NetworkAdapter;
  settings: SettingsAdapter;
  onNavigate: (s: StudioSection) => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [statuses, setStatuses] = useState<ProviderStatusView[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalogView | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [rows, cat] = await Promise.all([
        fetchProviderStatus(network),
        fetchProviderCatalog(network),
      ]);
      setStatuses(rows);
      setCatalog(cat);
      setState('ready');
    } catch {
      setStatuses([]);
      setCatalog(null);
      setState('error');
    }
  }, [network]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectableCount = catalog
    ? new Set(
        [...catalog.textProviders, ...catalog.imageProviders]
          .filter((p) => p.selectable)
          .map((p) => p.providerId)
      ).size
    : 0;
  const textAssignment = catalog
    ? catalog.selection.text.selectedProviderId
      ? `${catalog.selection.text.selectedProviderId} / ${catalog.selection.text.selectedModelId ?? 'default'}`
      : 'Server default'
    : '—';
  const imageAssignment = catalog
    ? catalog.selection.image.selectedProviderId
      ? `${catalog.selection.image.selectedProviderId} / ${catalog.selection.image.selectedModelId ?? 'default'}`
      : 'Server default'
    : '—';

  return (
    <div className="space-y-6">
      {/* Editorial Atelier introduction */}
      <div className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-5 sm:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
          <h2 className="font-serif text-[22px] text-[var(--text-primary,#F3F4F6)]">Welcome to the Atelier</h2>
        </div>
        <p className="text-[14px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)] max-w-2xl">
          The Codex Atelier is the control center for the AI providers Kitchen Codex uses for
          text and image work. Keys and catalog truth stay server-owned; here you choose
          non-secret preferences, verify connectivity, and review what the server can execute.
          Provider and model details live under Providers; full model discovery arrives with
          the Living Library (UD-2C).
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => onNavigate('providers')}
            className="px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--accent,#F59E0B)] text-[var(--color-on-accent,#0C0C0C)] min-h-[44px]"
          >
            Configure Text AI
          </button>
          <button
            type="button"
            onClick={() => onNavigate('image')}
            className="px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px]"
          >
            Configure Image AI
          </button>
          <button
            type="button"
            onClick={() => onNavigate('library')}
            className="px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px]"
          >
            Open Living Library
          </button>
        </div>
      </div>

      {state === 'loading' && <ProviderStatusLoading />}
      {state === 'error' && <ProviderStatusError onRefresh={load} />}
      {state === 'ready' && catalog && (
        <>
          {/* Assignment summaries — prominent */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-5 sm:p-6 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-serif text-[18px] text-[var(--text-primary,#F3F4F6)]">Text AI assignment</h3>
                <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Text</span>
              </div>
              <p className="text-[14px] font-medium text-[var(--text-primary,#F3F4F6)] break-words">{textAssignment}</p>
              <p className="text-[12px] text-[var(--text-muted,#6B7280)]">
                {catalog.selection.userSelectionAllowed.text ? 'User-selectable surface' : 'Server-managed surface'}
              </p>
              <button
                type="button"
                onClick={() => onNavigate('providers')}
                className="text-[12px] text-[var(--accent-text,#F59E0B)] hover:underline underline-offset-2"
              >
                Configure Text AI →
              </button>
            </div>
            <div className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-5 sm:p-6 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-serif text-[18px] text-[var(--text-primary,#F3F4F6)]">Image AI assignment</h3>
                <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Image</span>
              </div>
              <p className="text-[14px] font-medium text-[var(--text-primary,#F3F4F6)] break-words">{imageAssignment}</p>
              <p className="text-[12px] text-[var(--text-muted,#6B7280)]">
                {catalog.selection.userSelectionAllowed.image ? 'User-selectable surface' : 'Server-managed surface'}
              </p>
              <button
                type="button"
                onClick={() => onNavigate('image')}
                className="text-[12px] text-[var(--accent-text,#F59E0B)] hover:underline underline-offset-2"
              >
                Configure Image AI →
              </button>
            </div>
          </div>

          {/* Compact provider readiness summary — no full catalog */}
          <div className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-serif text-[18px] text-[var(--text-primary,#F3F4F6)]">Provider readiness</h3>
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[36px]"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                Refresh
              </button>
            </div>
            <div className="flex flex-wrap gap-3 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
              <span className="px-2.5 py-1 rounded-md bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))]">
                {statuses.length} provider{statuses.length === 1 ? '' : 's'}
              </span>
              <span className="px-2.5 py-1 rounded-md bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))]">
                {selectableCount} selectable
              </span>
              <span className="px-2.5 py-1 rounded-md bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))]">
                {statuses.filter((s) => s.configured).length} with operator key
              </span>
            </div>
            {statuses.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted,#6B7280)]">No provider status available.</p>
            ) : (
              <ul className="divide-y divide-[var(--color-rule,var(--bg-elevated))]">
                {statuses.map((s) => (
                  <li key={s.providerId} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[13px] text-[var(--text-primary,#F3F4F6)] truncate">{s.name || s.providerId}</div>
                      <div className="text-[11px] text-[var(--text-muted,#6B7280)] truncate">{s.providerId}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">
                        {s.configured ? 'Operator key' : 'No operator key'}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${
                          s.enabled
                            ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                            : 'bg-white/5 text-gray-400 border-white/10'
                        }`}
                      >
                        {s.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => onNavigate('providers')}
              className="text-[12px] text-[var(--accent-text,#F59E0B)] hover:underline underline-offset-2"
            >
              View full provider details and catalog →
            </button>
          </div>

          {/* Living Library entry */}
          <div className="rounded-2xl border border-dashed border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
                <h3 className="font-serif text-[16px] text-[var(--text-primary,#F3F4F6)]">Living Library</h3>
              </div>
              <p className="text-[12px] text-[var(--text-muted,#6B7280)] max-w-xl">
                Full model discovery, filtering, comparison and pricing arrive in UD-2C. Reserved
                here so the Atelier shell stays stable.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('library')}
              className="px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px] shrink-0"
            >
              Open Living Library
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AtelierLibraryPlaceholder({ onNavigate }: { onNavigate: (s: StudioSection) => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] p-8 sm:p-10 text-center space-y-3">
      <Library className="w-8 h-8 mx-auto text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
      <h2 className="font-serif text-[22px] text-[var(--text-primary,#F3F4F6)]">The Living Library</h2>
      <p className="text-[14px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)] max-w-xl mx-auto">
        Full model discovery, categorical browsing, verification badges and comparison tools
        arrive in UD-2C. This surface is intentionally reserved so the Atelier shell stays
        stable while the Library is built.
      </p>
      <button
        type="button"
        onClick={() => onNavigate('providers')}
        className="px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px]"
      >
        Back to Providers
      </button>
    </div>
  );
}
