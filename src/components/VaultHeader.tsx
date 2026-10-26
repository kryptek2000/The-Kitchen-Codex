import React, { useLayoutEffect, useRef } from 'react';
import {
  FolderOpen,
  Upload,
  Plus,
  Search,
  LayoutGrid,
  Table,
  CalendarDays,
  ShoppingCart,
  Palette,
  SlidersHorizontal,
  RefreshCw,
  FolderCheck,
  CheckCircle2,
  BookOpen,
  Globe,
  BrainCircuit,
  Sparkles,
  Wand2,
  MessageCircle,
} from 'lucide-react';
import { useShiso } from '../application-ui/shisoEntryPoints';
import { VaultSyncStatus } from '../types';
import { APP_VERSION } from '../version';
import { KitchenCodexMark } from './BrandMark';

interface VaultHeaderProps {
  vaultStatus: VaultSyncStatus;
  activeTab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers';
  setActiveTab: (tab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  isFilterOpen: boolean;
  setIsFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  activeFilterCount: number;
  onOpenConnectVaultModal: () => void;
  onOpenNewRecipeModal: () => void;
  onOpenRecipeGrabber: () => void;
  onOpenVaultIntelligence: () => void;
  onOpenAskMyKitchen: () => void;
  onOpenCreateForMe: () => void;
  legacyRecipeCount?: number;
  onRefreshVault: () => void;
  /**
   * The RECIPE count of the active vault (UD-2A.2). It is passed in from the
   * canonical in-memory state rather than stored in the vault status, so the
   * status strip can never disagree with the gallery heading.
   */
  recipeCount: number;
  /** The count of non-recipe vault notes. Reported separately, never as recipes. */
  noteCount: number;
  /** Re-authorises a remembered Vault. Invoked from a user gesture. */
  onReconnectVault: () => void;
}

export function VaultHeader({
  vaultStatus,
  activeTab,
  setActiveTab,
  searchQuery,
  setSearchQuery,
  isFilterOpen,
  setIsFilterOpen,
  activeFilterCount,
  onOpenConnectVaultModal,
  onOpenNewRecipeModal,
  onOpenRecipeGrabber,
  onOpenVaultIntelligence,
  onOpenAskMyKitchen,
  onOpenCreateForMe,
  legacyRecipeCount = 0,
  onRefreshVault,
  recipeCount,
  noteCount,
  onReconnectVault,
}: VaultHeaderProps) {
  // SHISO global entry point. Read from context, not props, so every existing
  // caller is unaffected and there is exactly one Shiso surface.
  const shiso = useShiso();

  // The vault path can be long ("/home/you/Obsidian/My Vault"). The status
  // strip is a single non-wrapping line, so the mobile label is the vault
  // folder name and the full path stays available as the tooltip.
  const fullPath = vaultStatus.vaultPath || '';
  const pathSegments = fullPath.split(/[\\/]/).filter(Boolean);
  const pathLabel = pathSegments.length ? pathSegments[pathSegments.length - 1] : fullPath;
  const recipeNoun = recipeCount === 1 ? 'recipe' : 'recipes';

  // The connection state drives the status strip's action (UD-2A.2). A Vault
  // that is remembered but not yet authorised gets an explicit "Reconnect
  // Vault" action instead of the ordinary "Connect Vault" flow, so the user is
  // never silently shown the starter Vault as though it were their own data.
  const connectionState = vaultStatus.connectionState ?? (vaultStatus.isConnected ? 'connected' : 'starter');
  const needsReconnect = connectionState === 'reauthorization_required' || connectionState === 'permission_denied';
  // A live folder handle is the only state that supports two-way disk sync.
  // Imported files/folders are loaded in this app but are not a live Vault.
  const isLiveVault = vaultStatus.isConnected && vaultStatus.accessType === 'filesystem_api';

  // STICKY HEADER GEOMETRY — published for scroll positioning (UD-2A.1B R-1).
  //
  // The header is `static` below 768px and `sticky` from 768px up. While it is
  // sticky it owns the top of the viewport and paints above the scrolling
  // content column, so content scrolled into view must land BELOW it.
  // `scroll-padding-top` on the scrolling element is the mechanism that
  // expresses that relationship, and the only correct value is the header's
  // own measured height — which is content-driven (198px at the desktop rail,
  // 253px in the stacked tablet layout) and so cannot be a fixed constant.
  //
  // The measured height is published as `--kc-sticky-header-h` on the root
  // element; index.css consumes it as
  // `html { scroll-padding-top: var(--kc-sticky-header-h, 0px) }`.
  //
  // When the header is not sticky the published value is 0, so mobile
  // scrolling is unchanged and the compact mobile header still scrolls away
  // with the content. Stickiness is read from the computed style rather than
  // from a duplicated breakpoint, so the published value always matches the
  // header's actual behaviour.
  const headerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el || typeof document === 'undefined') return;
    const root = document.documentElement;
    const publish = () => {
      const isSticky = getComputedStyle(el).position === 'sticky';
      const height = isSticky ? Math.ceil(el.getBoundingClientRect().height) : 0;
      root.style.setProperty('--kc-sticky-header-h', `${height}px`);
    };
    publish();
    // ResizeObserver keeps the published height truthful when the header's own
    // content changes (font loading, theme change, viewport breakpoint).
    // It is absent in some non-browser DOM implementations, in which case the
    // resize listener below still keeps the value current.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty('--kc-sticky-header-h');
    };
  }, []);

  return (
    <header ref={headerRef} id="obsidian-vault-header" className="bg-[var(--bg-surface,#141414)] border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] static md:sticky md:top-0 z-30 shadow-sm">
      {/* Vault status strip — one line, never wraps.
          Connected  -> quiet "Vault Linked" chip (the vault action is not
                        prominent while a vault is connected).
          Not linked -> prominent "Connect Vault" (still discoverable). */}
      <div id="vault-status-strip" className="bg-[var(--bg-root,#0C0C0C)] text-[var(--text-secondary,#9CA3AF)] text-sm px-3 sm:px-4 py-0 sm:py-0.5 flex flex-nowrap items-center justify-between gap-2 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))]">
        <button
          onClick={onOpenConnectVaultModal}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left transition-colors hover:text-[var(--text-primary,#F3F4F6)]"
          title={fullPath ? `${fullPath} — open Vault settings` : 'Open Vault settings & connect folders'}
        >
          <FolderCheck className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
          <span className="hidden min-w-0 truncate font-mono text-[var(--text-secondary,#9CA3AF)] sm:inline">{pathLabel}</span>
          <span className="hidden text-[var(--text-muted,#6B7280)] sm:inline">•</span>
          <span id="vault-recipe-count" className="shrink-0 whitespace-nowrap font-medium text-[var(--text-secondary,#9CA3AF)]">
            {recipeCount} {recipeNoun}
          </span>
        </button>

        <div className="flex items-center gap-1 shrink-0">
          {needsReconnect ? (
            /* A Vault is remembered but the browser needs a user gesture to
               re-authorise it (UD-2A.2). This button performs that gesture:
               it calls requestPermission() and reconnects the remembered
               Vault. It is deliberately NOT the ordinary "Connect Vault"
               flow, and the starter Vault is never shown as the user's data. */
            <button
              id="reconnect-vault-btn"
              onClick={onReconnectVault}
              className="flex items-center gap-1 rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-2.5 text-sm font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20 min-h-[44px]"
              title={
                connectionState === 'permission_denied'
                  ? `Access to “${vaultStatus.rememberedVaultName || 'your Vault'}” was denied. Click to try again, or pick the folder again.`
                  : `“${vaultStatus.rememberedVaultName || 'Your Vault'}” is remembered. Click to grant access and reconnect it.`
              }
            >
              <BookOpen className="h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
              <span className="whitespace-nowrap">Reconnect Vault</span>
            </button>
          ) : vaultStatus.isConnected ? (
            <button
              id="vault-linked-chip"
              onClick={onOpenConnectVaultModal}
              className="flex min-h-[44px] items-center gap-1 rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 text-sm text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-root,#0C0C0C)]"
              title={isLiveVault ? 'Vault connected — open Vault settings' : 'Recipes loaded from files — open Vault settings'}
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
              <span className="whitespace-nowrap">{isLiveVault ? 'Vault Linked' : 'Recipes Loaded'}</span>
            </button>
          ) : (
            <button
              id="connect-vault-chip"
              onClick={onOpenConnectVaultModal}
              className="flex items-center gap-1 rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-2.5 text-sm font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20 min-h-[44px]"
              title="Connect your recipe vault folder"
            >
              <BookOpen className="h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
              <span className="whitespace-nowrap">Connect Vault</span>
            </button>
          )}

          <button
            id="refresh-vault-btn"
            onClick={onRefreshVault}
            className="w-11 h-11 flex items-center justify-center text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)] hover:bg-[var(--bg-elevated,#1E1E1E)] rounded transition-colors duration-[140ms]"
            title="Reload vault markdown notes"
            aria-label="Reload vault markdown notes"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Brand + primary actions.
          Mobile (<768px): ONE horizontal brand row — hero mark + wordmark +
          compact New Recipe. The secondary actions (Ask My Kitchen, Connect
          Vault) are not stacked here; they live in the More dialog. */}
      <div className="max-w-7xl mx-auto kc-vault-surface py-2.5 md:py-3.5 flex flex-row items-center justify-between gap-2 md:flex-col md:items-start md:gap-3 lg:flex-row lg:items-center">
        {/* Compact brand — only below the desktop rail breakpoint, so the
            product identity is never duplicated in two places. The hero mark
            keeps the full (non-compact) brand detail below 768px. */}
        <div className="flex items-center gap-2.5 lg:hidden min-w-0">
          <KitchenCodexMark size={64} decorative className="shrink-0 md:hidden" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-base md:text-xl font-serif font-bold text-[var(--text-primary,#F3F4F6)] tracking-tight leading-tight truncate">
                The Kitchen Codex
              </h1>
              <span className="hidden md:inline-flex shrink-0 rounded border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-1.5 py-0.5 font-mono text-sm font-medium text-[var(--accent-text,#F59E0B)]">
                {APP_VERSION}
              </span>
            </div>
            <p className="text-sm text-[var(--text-secondary,#9CA3AF)] leading-tight truncate">
              My Recipe Vault
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {/* New Recipe Note — the primary creation action. On mobile it is a
              compact 48px control in the brand row (RV-2 mobile "Add"
              geometry), never a stacked row of full-width buttons; the full
              label is exposed to assistive tech and to tablet/desktop. */}
          <button
            id="create-new-recipe-btn"
            onClick={onOpenNewRecipeModal}
            className="flex items-center justify-center gap-1.5 w-12 h-12 md:w-auto md:h-auto md:px-4 md:min-h-[52px] text-base font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-black shadow-md shadow-amber-500/20 transition-colors duration-[140ms]"
          >
            <Plus className="w-5 h-5 shrink-0" />
            <span className="sr-only md:hidden">New Recipe Note</span>
            <span className="hidden md:inline">New Recipe Note</span>
          </button>

          {/* Ask My Kitchen Button */}
          <button
            id="ask-my-kitchen-header-btn"
            onClick={onOpenAskMyKitchen}
            className="hidden md:inline-flex items-center gap-2 px-4 min-h-[52px] text-base font-semibold rounded-lg bg-[var(--accent-subtle,rgba(245,158,11,0.12))] hover:bg-amber-500/20 text-[var(--text-primary,#F3F4F6)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] transition-colors duration-[140ms] shadow-xs"
            title="Ask a question and search your vault for matching recipes"
          >
            <Sparkles className="w-5 h-5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
            <span>Ask My Kitchen</span>
          </button>

          {/* Connect Vault Modal Button */}
          <button
            id="connect-local-vault-btn"
            onClick={onOpenConnectVaultModal}
            className="hidden md:inline-flex items-center gap-2 px-4 min-h-[52px] text-base font-semibold rounded-lg bg-[var(--accent-subtle,rgba(245,158,11,0.12))] hover:bg-amber-500/20 text-[var(--text-primary,#F3F4F6)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] transition-colors duration-[140ms] shadow-xs"
            title="Connect your recipe vault folder, import .md files, or drop recipes"
          >
            <FolderOpen className="w-5 h-5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
            <span>Connect Vault</span>
          </button>
        </div>
      </div>

      {/* Search & Filter Controls (primary navigation now lives in the shell) */}
      <div className="max-w-7xl mx-auto kc-vault-surface pb-2.5 md:pb-3 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 md:gap-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-80">
            <Search className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted,#6B7280)]" />
            <input
              id="recipe-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search recipes, tags, ingredients..."
              className="w-full pl-11 pr-10 h-[52px] md:h-14 text-base bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] rounded-lg text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-muted,#6B7280)] focus:border-[var(--accent-text,#F59E0B)] transition-colors duration-[140ms]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center text-base text-[var(--text-muted,#6B7280)] hover:text-[var(--text-secondary,#9CA3AF)]"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>

          <button
            id="toggle-filters-btn"
            onClick={() => setIsFilterOpen((prev) => !prev)}
            aria-label={activeFilterCount > 0 ? `Filters (${activeFilterCount} active)` : 'Filters'}
            className={`relative flex items-center justify-center gap-1.5 sm:gap-2 w-12 h-12 md:w-auto md:h-auto md:px-4 md:min-h-[52px] text-base font-medium rounded-lg border transition-colors duration-[140ms] ${
              isFilterOpen || activeFilterCount > 0
                ? 'bg-[var(--accent-subtle,rgba(245,158,11,0.12))] border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] font-semibold'
                : 'bg-[var(--bg-elevated,#1E1E1E)] border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-secondary,#9CA3AF)] hover:bg-[var(--bg-root,#0C0C0C)]'
            }`}
          >
            <SlidersHorizontal className="w-5 h-5 shrink-0" />
            <span className="hidden md:inline whitespace-nowrap">Filters</span>
            {activeFilterCount > 0 && (
              <span className="absolute -top-1 -right-1 md:static md:ml-1 w-5 h-5 rounded-full bg-amber-500 text-black text-xs flex items-center justify-center font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
