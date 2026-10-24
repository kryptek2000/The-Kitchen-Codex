import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  SlidersHorizontal,
  Heart,
  GitCompare,
  X,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  BookOpen,
} from 'lucide-react';
import { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { fetchProviderCatalog } from '../application-ui/providerCatalog';
import type { ProviderCatalogView, ProviderCatalogTextProviderView, ProviderCatalogImageProviderView } from '../application-ui/providerCatalog';
import {
  getLivingLibraryFixtures,
  LIVING_LIBRARY_FIXTURE_COUNT,
  LIVING_LIBRARY_PAGE_SIZE,
  type LibraryModel,
  type LibraryModality,
  type LibraryCategory,
  type LibraryReadiness,
} from '../data/livingLibraryFixtures';

type PricingFilter = 'all' | 'known' | 'unknown';
type SortKey = 'name' | 'context';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const OPERATIONS = ['text-generation', 'image-generation', 'embedding', 'vision-analysis'];

function isDemoMode(): boolean {
  // Strong boundary: synthetic fixtures can NEVER appear in a production build,
  // regardless of any flag. Demo mode requires BOTH a dev build AND an explicit
  // opt-in (localStorage or ?demo=1). This keeps synthetic data out of production.
  if (!import.meta.env.DEV) return false;
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('demo') === '1') return true;
      if (window.localStorage.getItem('tkc_living_library_demo') === '1') return true;
    }
  } catch {
    // ignore — treat as not demo
  }
  return false;
}

const CATEGORIES: { id: LibraryCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All categories' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'creative', label: 'Creative' },
  { id: 'code', label: 'Code' },
  { id: 'vision', label: 'Vision' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'general', label: 'General' },
];

const MODALITY_LABEL: Record<LibraryModality, string> = {
  text: 'Text',
  image: 'Image',
  multimodal: 'Multimodal',
  embedding: 'Embedding',
};

const READINESS_LABEL: Record<LibraryReadiness, string> = {
  capability_verified: 'Capability verified',
  catalog_only: 'Catalog only',
  unsupported: 'Unsupported',
  not_configured: 'Not configured',
};

const READINESS_TONE: Record<LibraryReadiness, string> = {
  capability_verified: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  catalog_only: 'bg-white/5 text-gray-300 border-white/10',
  unsupported: 'bg-red-500/10 text-red-300 border-red-500/30',
  not_configured: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
};

function formatContext(n: number | null): string {
  if (n === null) return 'Unknown';
  if (n >= 1000) return `${Math.round(n / 1000)}k tokens`;
  return `${n} tokens`;
}

function formatPrice(p: LibraryModel['pricing']): string {
  if (!p) return 'Unknown';
  return `$${p.inputPer1M.toFixed(2)} in / $${p.outputPer1M.toFixed(2)} out per 1M`;
}

function capabilitiesToList(c: any): string[] {
  if (!c || typeof c !== 'object') return [];
  const out: string[] = [];
  if (c.reasoning) out.push('reasoning');
  if (c.structuredOutput) out.push('structured-output');
  if (c.recipeGeneration) out.push('recipe-generation');
  if (c.webSearch) out.push('web-search');
  return out;
}

export function mapCatalogToLibraryModels(catalog: ProviderCatalogView): LibraryModel[] {
  const out: LibraryModel[] = [];
  for (const provider of catalog.textProviders || []) {
    for (const m of provider.models || []) {
      const caps = capabilitiesToList(m.capabilities);
      const hasVision = !!m.vision || (Array.isArray(m.inputModalities) && m.inputModalities.includes('image'));
      const modality: LibraryModality = hasVision ? 'multimodal' : 'text';
      const category: LibraryCategory = m.recipeGenerationVerified || m.recipeGenerationCandidate
        ? 'creative'
        : caps.includes('reasoning')
        ? 'reasoning'
        : 'general';
      const contextWindow = typeof m.contextLength === 'number' ? m.contextLength : null;
      let pricing: LibraryModel['pricing'] = null;
      if (m.pricing && m.pricingVerified) {
        const prompt = m.pricing.promptPerToken;
        const completion = m.pricing.completionPerToken;
        if (typeof prompt === 'number' && typeof completion === 'number' && isFinite(prompt) && isFinite(completion)) {
          pricing = { inputPer1M: prompt * 1e6, outputPer1M: completion * 1e6, unit: 'USD per 1M tokens' };
        }
      }
      let readiness: LibraryReadiness = 'catalog_only';
      if (!provider.configured) readiness = 'not_configured';
      else if (m.compatibility === 'unsupported') readiness = 'unsupported';
      else if (m.capabilityVerified) readiness = 'capability_verified';
      else readiness = 'catalog_only';

      const compatible = (op: string) => {
        if (readiness === 'unsupported') return { compatible: false, reason: 'Unsupported by this deployment.' };
        if (readiness === 'not_configured') return { compatible: false, reason: 'Provider not configured.' };
        if (op === 'image-generation' && modality !== 'multimodal') return { compatible: false, reason: 'Model does not support image generation.' };
        if (op === 'vision-analysis' && !caps.includes('vision-input') && modality !== 'multimodal' && !hasVision) return { compatible: false, reason: 'Model does not support vision input.' };
        return { compatible: true };
      };

      out.push({
        id: m.id,
        name: m.displayName || m.id,
        providerId: provider.providerId,
        providerName: provider.name,
        category,
        modality,
        description: 'Not provided',
        contextWindow,
        pricing,
        capabilities: caps,
        readiness,
        capabilityVerified: !!m.capabilityVerified,
        executionVerified: false,
        compatibility: OPERATIONS.map((op) => ({ operation: op, ...compatible(op) })),
      });
    }
  }
  for (const provider of catalog.imageProviders || []) {
    for (const m of provider.models || []) {
      const pricing: LibraryModel['pricing'] = null; // image pricing not mapped to per-1M text tokens
      let readiness: LibraryReadiness = 'catalog_only';
      if (!provider.configured) readiness = 'not_configured';
      else if (m.compatibility === 'unsupported') readiness = 'unsupported';
      else readiness = 'catalog_only';

      out.push({
        id: m.id,
        name: m.displayName || m.id,
        providerId: provider.providerId,
        providerName: provider.name,
        category: 'vision',
        modality: 'image',
        description: 'Not provided',
        contextWindow: null,
        pricing,
        capabilities: m.compatibility ? [m.compatibility] : [],
        readiness,
        capabilityVerified: false,
        executionVerified: false,
        compatibility: OPERATIONS.map((op) => {
          if (op === 'image-generation') return { operation: op, compatible: true };
          return { operation: op, compatible: false, reason: 'Image model: not applicable.' };
        }),
      });
    }
  }
  return out;
}

/** Readiness badge — text + color, never color alone. */
function ReadinessBadge({ readiness }: { readiness: LibraryReadiness }) {
  return (
    <span
      data-readiness={readiness}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${READINESS_TONE[readiness]}`}
    >
      <span aria-hidden="true">
        {readiness === 'capability_verified' ? '✓' : readiness === 'unsupported' ? '!' : readiness === 'not_configured' ? '○' : '·'}
      </span>
      {READINESS_LABEL[readiness]}
    </span>
  );
}

interface ModelCardProps {
  model: LibraryModel;
  isFavorite: boolean;
  isCompared: boolean;
  compareDisabled: boolean;
  onToggleFavorite: (id: string) => void;
  onToggleCompare: (id: string) => void;
  onInspect: (model: LibraryModel) => void;
}

function ModelCard({
  model,
  isFavorite,
  isCompared,
  compareDisabled,
  onToggleFavorite,
  onToggleCompare,
  onInspect,
}: ModelCardProps) {
  return (
    <article
      data-model-card={model.id}
      className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-4 sm:p-5 space-y-3 flex flex-col"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-serif text-[18px] sm:text-[20px] leading-[1.25] text-[var(--text-primary,#F3F4F6)]">
            {model.name}
          </h3>
          <p className="text-[12px] text-[var(--text-muted,#6B7280)]">
            {model.providerName} · {MODALITY_LABEL[model.modality]}
          </p>
        </div>
        <button
          type="button"
          data-favorite-toggle={model.id}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`}
          onClick={() => onToggleFavorite(model.id)}
          className="w-11 h-11 shrink-0 flex items-center justify-center rounded-lg text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--accent-text,#F59E0B)] hover:bg-[var(--bg-elevated,#1E1E1E)] transition-colors duration-[140ms]"
        >
          <Heart className={`w-4 h-4 ${isFavorite ? 'fill-current text-[var(--accent-text,#F59E0B)]' : ''}`} aria-hidden="true" />
        </button>
      </div>

      <p className="text-[13px] leading-[1.5] text-[var(--text-secondary,#9CA3AF)] line-clamp-2 min-h-[2.6em]">
        {model.description}
      </p>

      <div className="flex flex-wrap gap-1.5">
        <ReadinessBadge readiness={model.readiness} />
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-300 border-white/10">
          {model.category}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <div>
          <dt className="text-[var(--text-muted,#6B7280)]">Context</dt>
          <dd className="text-[var(--text-primary,#F3F4F6)]">{formatContext(model.contextWindow)}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted,#6B7280)]">Pricing</dt>
          <dd className="text-[var(--text-primary,#F3F4F6)]">{formatPrice(model.pricing)}</dd>
        </div>
      </dl>

      {model.capabilities.length > 0 && (
        <p className="text-[10px] text-[var(--text-muted,#6B7280)] truncate">
          {model.capabilities.join(' · ')}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary,#9CA3AF)] cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            data-compare-checkbox={model.id}
            checked={isCompared}
            disabled={!isCompared && compareDisabled}
            onChange={() => onToggleCompare(model.id)}
            className="w-4 h-4 accent-[var(--accent,#F59E0B)]"
          />
          Compare
        </label>
        <button
          type="button"
          data-inspect-button={model.id}
          onClick={() => onInspect(model)}
          className="px-3 py-2 rounded-lg text-[12px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px] hover:bg-[var(--bg-surface,#141414)] transition-colors duration-[140ms]"
        >
          Inspect
        </button>
      </div>
    </article>
  );
}

interface LivingLibraryProps {
  network?: NetworkAdapter;
  demo?: boolean;
  fixtures?: LibraryModel[];
}

export function LivingLibrary({ network, demo = false, fixtures }: LivingLibraryProps) {
  const useDemo = !!fixtures || demo || isDemoMode();

  const [loadState, setLoadState] = useState<LoadState>(useDemo ? 'ready' : 'loading');
  const [realModels, setRealModels] = useState<LibraryModel[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const allModels = useMemo<LibraryModel[]>(() => {
    if (fixtures) return fixtures;
    if (useDemo) return getLivingLibraryFixtures();
    return realModels;
  }, [fixtures, useDemo, realModels]);

  const loadCatalog = useCallback(async () => {
    if (useDemo || !network) {
      if (!useDemo) {
        setLoadState('error');
        setLoadError('No catalog source available.');
      }
      return;
    }
    setLoadState('loading');
    setLoadError(null);
    try {
      const catalog = await fetchProviderCatalog(network);
      const mapped = mapCatalogToLibraryModels(catalog);
      setRealModels(mapped);
      setLoadState('ready');
    } catch {
      setRealModels([]);
      setLoadError('The provider catalog could not be loaded.');
      setLoadState('error');
    }
  }, [network, useDemo]);

  useEffect(() => {
    if (useDemo) {
      setLoadState('ready');
      return;
    }
    void loadCatalog();
  }, [useDemo, loadCatalog]);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<LibraryCategory | 'all'>('all');
  const [provider, setProvider] = useState<string>('all');
  const [pricing, setPricing] = useState<PricingFilter>('all');
  const [readiness, setReadiness] = useState<LibraryReadiness | 'all'>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>('name');
  const [page, setPage] = useState(1);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [comparison, setComparison] = useState<string[]>([]);
  const [inspector, setInspector] = useState<LibraryModel | null>(null);
  const [compareNotice, setCompareNotice] = useState<string | null>(null);

  const providers = useMemo(() => {
    const set = new Set(allModels.map((m) => m.providerName));
    return Array.from(set).sort();
  }, [allModels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = allModels.filter((m) => {
      if (q) {
        const hay = `${m.name} ${m.id} ${m.providerName} ${m.providerId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (category !== 'all' && m.category !== category) return false;
      if (provider !== 'all' && m.providerName !== provider) return false;
      if (pricing === 'known' && !m.pricing) return false;
      if (pricing === 'unknown' && m.pricing) return false;
      if (readiness !== 'all' && m.readiness !== readiness) return false;
      if (favoritesOnly && !favorites.has(m.id)) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      if (sort === 'context') {
        const av = a.contextWindow ?? -1;
        const bv = b.contextWindow ?? -1;
        if (av !== bv) return bv - av;
        return a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [allModels, query, category, provider, pricing, readiness, favoritesOnly, sort, favorites]);

  useEffect(() => {
    setPage(1);
  }, [query, category, provider, pricing, readiness, favoritesOnly, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / LIVING_LIBRARY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(() => {
    const start = (safePage - 1) * LIVING_LIBRARY_PAGE_SIZE;
    return filtered.slice(start, start + LIVING_LIBRARY_PAGE_SIZE);
  }, [filtered, safePage]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleCompare = useCallback((id: string) => {
    setComparison((prev) => {
      if (prev.includes(id)) {
        setCompareNotice(null);
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= 3) {
        setCompareNotice('Comparison is limited to 3 models. Remove one to add another.');
        return prev;
      }
      setCompareNotice(null);
      return [...prev, id];
    });
  }, []);

  const resetFilters = useCallback(() => {
    setQuery('');
    setCategory('all');
    setProvider('all');
    setPricing('all');
    setReadiness('all');
    setFavoritesOnly(false);
    setSort('name');
  }, []);

  const comparedModels = useMemo(
    () => comparison.map((id) => allModels.find((m) => m.id === id)).filter(Boolean) as LibraryModel[],
    [comparison, allModels]
  );

  return (
    <section data-living-library="true" className="space-y-6">
      {/* Synthetic data banner — only in demo mode */}
      {useDemo && (
        <div
          data-synthetic-banner="true"
          role="note"
          className="rounded-xl border border-amber-500/40 bg-[var(--bg-elevated,#1E1E1E)] px-4 py-3 text-[12px] text-[var(--text-primary,#F3F4F6)]"
        >
          <strong className="font-semibold text-amber-300">Synthetic design fixtures.</strong>{' '}
          These {allModels.length} models are generated for the Living Library discovery UI at the approved
          scale. They are not real providers, not executable, and are not connected to any credential,
          billing or execution flow.
        </div>
      )}

      <header className="space-y-2 pb-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold text-[var(--text-muted,#6B7280)]">
          <BookOpen className="w-4 h-4" aria-hidden="true" />
          <span>Living Library</span>
        </div>
        <h2 className="font-serif text-[28px] sm:text-[32px] leading-[1.2] text-[var(--text-primary,#F3F4F6)]">
          Model discovery
        </h2>
        <p className="text-[14px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)] max-w-2xl">
          Explore the catalog, compare models, and inspect capabilities. Discovery, compatibility and
          applied assignment are distinct states — nothing here is configured or ready to run.
        </p>
      </header>

      {/* Loading state */}
      {loadState === 'loading' && (
        <div data-library-loading="true" className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-8 text-center text-[14px] text-[var(--text-secondary,#9CA3AF)]">
          Loading provider catalog…
        </div>
      )}

      {/* Error / unavailable state */}
      {loadState === 'error' && !useDemo && (
        <div
          data-library-unavailable="true"
          className="rounded-2xl border border-dashed border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] p-8 text-center space-y-3"
        >
          <Sparkles className="w-6 h-6 mx-auto text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
          <p className="text-[14px] text-[var(--text-primary,#F3F4F6)]">The provider catalog is unavailable.</p>
          <p className="text-[12px] text-[var(--text-muted,#6B7280)]">
            {loadError || 'The server could not provide the model catalog.'} No synthetic data is substituted.
          </p>
          <button
            type="button"
            onClick={loadCatalog}
            className="mt-2 px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px]"
          >
            Retry
          </button>
        </div>
      )}

      {loadState === 'ready' && (
        <>
          <ModelFilters
            query={query} setQuery={setQuery}
            category={category} setCategory={setCategory}
            provider={provider} setProvider={setProvider} providers={providers}
            pricing={pricing} setPricing={setPricing}
            readiness={readiness} setReadiness={setReadiness}
            favoritesOnly={favoritesOnly} setFavoritesOnly={setFavoritesOnly}
            sort={sort} setSort={setSort}
            onReset={resetFilters}
            resultCount={filtered.length}
            totalCount={allModels.length}
          />

          {compareNotice && (
            <div
              data-compare-notice="true"
              role="status"
              aria-live="polite"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200"
            >
              {compareNotice}
            </div>
          )}

          {allModels.length === 0 ? (
            <div
              data-library-empty="true"
              className="rounded-2xl border border-dashed border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] p-8 text-center space-y-2"
            >
              <BookOpen className="w-6 h-6 mx-auto text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
              <p className="text-[14px] text-[var(--text-primary,#F3F4F6)]">No models in the catalog.</p>
              <p className="text-[12px] text-[var(--text-muted,#6B7280)]">
                Configure providers to populate the Living Library.
              </p>
              <button
                type="button"
                onClick={() => { /* navigation handled by parent section */ }}
                className="mt-2 px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px]"
              >
                Open Providers
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div
              data-library-empty="true"
              className="rounded-2xl border border-dashed border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] p-8 text-center space-y-2"
            >
              <Sparkles className="w-6 h-6 mx-auto text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
              <p className="text-[14px] text-[var(--text-primary,#F3F4F6)]">No models match your filters.</p>
              <p className="text-[12px] text-[var(--text-muted,#6B7280)]">Try resetting filters or broadening your search.</p>
              <button
                type="button"
                onClick={resetFilters}
                className="mt-2 px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[44px]"
              >
                Reset filters
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {pageItems.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  isFavorite={favorites.has(m.id)}
                  isCompared={comparison.includes(m.id)}
                  compareDisabled={comparison.length >= 3}
                  onToggleFavorite={toggleFavorite}
                  onToggleCompare={toggleCompare}
                  onInspect={setInspector}
                />
              ))}
            </div>
          )}

          {filtered.length > 0 && (
            <LibraryPagination
              page={safePage}
              totalPages={totalPages}
              total={filtered.length}
              pageSize={LIVING_LIBRARY_PAGE_SIZE}
              onChange={setPage}
            />
          )}

          <ModelComparison models={comparedModels} onRemove={(id) => toggleCompare(id)} onReset={() => setComparison([])} />

          {inspector && (
            <ModelInspector model={inspector} onClose={() => setInspector(null)} isDemo={useDemo} />
          )}
        </>
      )}
    </section>
  );
}

export default LivingLibrary;

interface ModelFiltersProps {
  query: string;
  setQuery: (v: string) => void;
  category: LibraryCategory | 'all';
  setCategory: (v: LibraryCategory | 'all') => void;
  provider: string;
  setProvider: (v: string) => void;
  providers: string[];
  pricing: PricingFilter;
  setPricing: (v: PricingFilter) => void;
  readiness: LibraryReadiness | 'all';
  setReadiness: (v: LibraryReadiness | 'all') => void;
  favoritesOnly: boolean;
  setFavoritesOnly: (v: boolean) => void;
  sort: SortKey;
  setSort: (v: SortKey) => void;
  onReset: () => void;
  resultCount: number;
  totalCount: number;
}

function ModelFilters({
  query, setQuery,
  category, setCategory,
  provider, setProvider, providers,
  pricing, setPricing,
  readiness, setReadiness,
  favoritesOnly, setFavoritesOnly,
  sort, setSort,
  onReset, resultCount, totalCount,
}: ModelFiltersProps) {
  return (
    <div
      data-library-filters="true"
      className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-4 sm:p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
          <h3 className="font-serif text-[16px] text-[var(--text-primary,#F3F4F6)]">Filters</h3>
        </div>
        <div className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
          <span data-result-count="true">{resultCount}</span> of {totalCount} models
        </div>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted,#6B7280)]" aria-hidden="true" />
        <input
          type="search"
          data-library-search="true"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by model or provider…"
          aria-label="Search models by name or provider"
          className="w-full pl-9 pr-3 py-2 min-h-[44px] rounded-lg bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] text-[13px] text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-muted,#6B7280)]"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Category</span>
          <select
            data-filter-category="true"
            value={category}
            onChange={(e) => setCategory(e.target.value as LibraryCategory | 'all')}
            className="w-full min-h-[44px] bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-lg px-2 py-1.5 text-[12px] text-[var(--text-primary,#F3F4F6)]"
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Provider</span>
          <select
            data-filter-provider="true"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full min-h-[44px] bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-lg px-2 py-1.5 text-[12px] text-[var(--text-primary,#F3F4F6)]"
          >
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Pricing</span>
          <select
            data-filter-pricing="true"
            value={pricing}
            onChange={(e) => setPricing(e.target.value as PricingFilter)}
            className="w-full min-h-[44px] bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-lg px-2 py-1.5 text-[12px] text-[var(--text-primary,#F3F4F6)]"
          >
            <option value="all">All pricing</option>
            <option value="known">Known pricing</option>
            <option value="unknown">Unknown pricing</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Readiness</span>
          <select
            data-filter-readiness="true"
            value={readiness}
            onChange={(e) => setReadiness(e.target.value as LibraryReadiness | 'all')}
            className="w-full min-h-[44px] bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-lg px-2 py-1.5 text-[12px] text-[var(--text-primary,#F3F4F6)]"
          >
            <option value="all">All readiness</option>
            {(['capability_verified', 'catalog_only', 'unsupported', 'not_configured'] as LibraryReadiness[]).map((r) => (
              <option key={r} value={r}>{READINESS_LABEL[r]}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
          <input
            type="checkbox"
            data-filter-favorites="true"
            checked={favoritesOnly}
            onChange={(e) => setFavoritesOnly(e.target.checked)}
            className="w-4 h-4 accent-[var(--accent,#F59E0B)]"
          />
          Favorites only
        </label>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Sort</span>
            <select
              data-filter-sort="true"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="min-h-[40px] bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-lg px-2 py-1.5 text-[12px] text-[var(--text-primary,#F3F4F6)]"
            >
              <option value="name">Name</option>
              <option value="context">Context window</option>
            </select>
          </label>
          <button
            type="button"
            data-filter-reset="true"
            onClick={onReset}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[40px] hover:text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms]"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function LibraryPagination({
  page, totalPages, total, pageSize, onChange,
}: {
  page: number; totalPages: number; total: number; pageSize: number; onChange: (p: number) => void;
}) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <nav
      data-library-pagination="true"
      aria-label="Library pagination"
      className="flex flex-wrap items-center justify-between gap-3 pt-2"
    >
      <div className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
        Showing <span data-page-range="true">{start}–{end}</span> of {total}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-page-prev="true"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[40px] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />
        </button>
        <span data-page-current="true" className="text-[12px] text-[var(--text-primary,#F3F4F6)] min-w-[6ch] text-center">
          Page {page} / {Math.max(1, totalPages)}
        </span>
        <button
          type="button"
          data-page-next="true"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages || totalPages === 0}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[40px] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

function ModelInspector({ model, onClose, isDemo }: { model: LibraryModel; onClose: () => void; isDemo: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      data-model-inspector="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby="library-inspector-title"
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-6"
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className="relative w-full sm:max-w-[780px] max-h-[90vh] sm:max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] p-5 sm:p-6 space-y-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">
              Model inspector
            </p>
            <h2 id="library-inspector-title" className="font-serif text-[22px] text-[var(--text-primary,#F3F4F6)]">
              {model.name}
            </h2>
            <p className="text-[12px] text-[var(--text-muted,#6B7280)] font-mono break-all">{model.id}</p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            data-inspector-close="true"
            onClick={onClose}
            aria-label="Close inspector"
            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-lg text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)] hover:bg-[var(--bg-elevated,#1E1E1E)]"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <ReadinessBadge readiness={model.readiness} />
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-300 border-white/10">
            {model.category}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-300 border-white/10">
            {MODALITY_LABEL[model.modality]}
          </span>
        </div>

        <p className="text-[13px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)]">{model.description}</p>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
          <div className="rounded-xl bg-[var(--bg-elevated,#1E1E1E)] p-3 space-y-1">
            <dt className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Provider</dt>
            <dd className="text-[var(--text-primary,#F3F4F6)]">{model.providerName}</dd>
            <dd className="text-[10px] text-[var(--text-muted,#6B7280)] font-mono">{model.providerId}</dd>
          </div>
          <div className="rounded-xl bg-[var(--bg-elevated,#1E1E1E)] p-3 space-y-1">
            <dt className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Context window</dt>
            <dd className="text-[var(--text-primary,#F3F4F6)]">{formatContext(model.contextWindow)}</dd>
          </div>
          <div className="rounded-xl bg-[var(--bg-elevated,#1E1E1E)] p-3 space-y-1">
            <dt className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Pricing</dt>
            <dd className="text-[var(--text-primary,#F3F4F6)]">{formatPrice(model.pricing)}</dd>
            <dd className="text-[10px] text-[var(--text-muted,#6B7280)]">
              {model.pricing ? model.pricing.unit : 'No pricing published'}
            </dd>
          </div>
          <div className="rounded-xl bg-[var(--bg-elevated,#1E1E1E)] p-3 space-y-1">
            <dt className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Verification</dt>
            <dd className="text-[var(--text-primary,#F3F4F6)]">
              {model.capabilityVerified ? 'Capability verified' : 'Not capability-verified'}
            </dd>
            <dd className="text-[10px] text-[var(--text-muted,#6B7280)]">
              Execution: {model.executionVerified ? 'verified' : 'not verified (no evidence)'}
            </dd>
            <dd className="text-[10px] text-[var(--text-muted,#6B7280)]">
              Discovery ≠ compatibility ≠ applied assignment.
            </dd>
          </div>
        </dl>

        {model.capabilities.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Capabilities</h3>
            <div className="flex flex-wrap gap-1.5">
              {model.capabilities.map((c) => (
                <span key={c} className="px-2 py-0.5 rounded-md text-[10px] font-semibold border bg-white/5 text-gray-300 border-white/10">
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">
            Operation compatibility
          </h3>
          <ul className="space-y-1.5">
            {model.compatibility.map((c) => (
              <li
                key={c.operation}
                className="flex items-center justify-between gap-3 text-[12px] rounded-lg bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2"
              >
                <span className="text-[var(--text-primary,#F3F4F6)]">{c.operation}</span>
                <span className={c.compatible ? 'text-emerald-300' : 'text-amber-300'}>
                  {c.compatible ? 'Compatible' : (c.reason || 'Not compatible')}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-1">
          <p className="text-[12px] text-amber-200 font-medium">Apply is disabled in this phase.</p>
          <p className="text-[11px] text-amber-200/80">
            This entry is a {isDemo ? 'synthetic design fixture' : 'catalog record'}. Discovery, compatibility and applied assignment are
            distinct states; no model here is connected to a real provider, credential or execution
            flow. Apply will only become available through a verified, authorized assignment contract.
          </p>
          <button
            type="button"
            data-inspector-apply="true"
            disabled
            className="mt-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/5 text-gray-400 border border-white/10 cursor-not-allowed"
          >
            Apply (disabled)
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelComparison({ models, onRemove, onReset }: { models: LibraryModel[]; onRemove: (id: string) => void; onReset: () => void }) {
  if (models.length === 0) return null;
  return (
    <section
      data-library-comparison="true"
      className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-4 sm:p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-[18px] text-[var(--text-primary,#F3F4F6)]">
          Model comparison ({models.length}/3)
        </h3>
        <button
          type="button"
          data-comparison-reset="true"
          onClick={onReset}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] min-h-[36px] hover:text-[var(--text-primary,#F3F4F6)]"
        >
          Reset comparison
        </button>
      </div>

      <div className="overflow-x-auto -mx-2 px-2">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr>
              <th className="text-left text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)] p-2 border-b border-[var(--color-rule,var(--bg-elevated))]">
                Attribute
              </th>
              {models.map((m) => (
                <th key={m.id} className="text-left p-2 border-b border-[var(--color-rule,var(--bg-elevated))] min-w-[180px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-serif text-[14px] text-[var(--text-primary,#F3F4F6)]">{m.name}</span>
                    <button
                      type="button"
                      data-comparison-remove={m.id}
                      onClick={() => onRemove(m.id)}
                      aria-label={`Remove ${m.name} from comparison`}
                      className="w-7 h-7 flex items-center justify-center rounded text-[var(--text-muted,#6B7280)] hover:text-[var(--text-primary,#F3F4F6)]"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { label: 'Provider', render: (m: LibraryModel) => m.providerName },
              { label: 'Modality', render: (m: LibraryModel) => MODALITY_LABEL[m.modality] },
              { label: 'Category', render: (m: LibraryModel) => m.category },
              { label: 'Context window', render: (m: LibraryModel) => formatContext(m.contextWindow) },
              { label: 'Pricing', render: (m: LibraryModel) => formatPrice(m.pricing) },
              { label: 'Readiness', render: (m: LibraryModel) => READINESS_LABEL[m.readiness] },
              { label: 'Capability verified', render: (m: LibraryModel) => (m.capabilityVerified ? 'Yes' : 'No') },
              { label: 'Capabilities', render: (m: LibraryModel) => (m.capabilities.length ? m.capabilities.join(', ') : 'Unknown') },
            ].map((row) => (
              <tr key={row.label}>
                <td className="text-[11px] font-semibold text-[var(--text-muted,#6B7280)] p-2 border-b border-[var(--color-rule,var(--bg-elevated))]">
                  {row.label}
                </td>
                {models.map((m) => (
                  <td key={m.id} className="text-[12px] text-[var(--text-primary,#F3F4F6)] p-2 border-b border-[var(--color-rule,var(--bg-elevated))] align-top">
                    {row.render(m)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-[var(--text-muted,#6B7280)]">
        Unknown values are shown as "Unknown" — never replaced with zero. Comparison is capped at 3 models.
      </p>
    </section>
  );
}