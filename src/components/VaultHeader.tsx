import React, { useLayoutEffect, useRef } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  FolderCheck,
  RefreshCw,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { VaultSyncStatus } from '../types';
import { KitchenCodexMark } from './BrandMark';

interface VaultHeaderProps {
  vaultStatus: VaultSyncStatus;
  activeTab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers';
  setActiveTab: (tab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers') => void;
  /**
   * Search/filter state still travels through this component's public contract
   * for compatibility. The daily-use command bar now lives in the Vault page
   * introduction, immediately below the header, so the sticky header can stay
   * a single truthful Vault-state line.
   */
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
  /** The RECIPE count of the active vault, derived from canonical state. */
  recipeCount: number;
  /** Non-recipe notes. Reported separately, never as recipes. */
  noteCount: number;
  /** Re-authorises a remembered Vault. Invoked from a user gesture. */
  onReconnectVault: () => void;
}

/**
 * Signature Edition Vault chrome.
 *
 * The header now does one job: state the truth about the active collection and
 * keep creation/assistant/settings within thumb reach on small screens. The
 * desktop page introduction below owns the title, primary action, search and
 * filters, so the photographs begin much sooner.
 */
export function VaultHeader({
  vaultStatus,
  onOpenConnectVaultModal,
  onOpenAskMyKitchen,
  onRefreshVault,
  recipeCount,
  onReconnectVault,
}: VaultHeaderProps) {
  const fullPath = vaultStatus.vaultPath || '';
  const pathSegments = fullPath.split(/[\\/]/).filter(Boolean);
  const pathLabel = pathSegments.length ? pathSegments[pathSegments.length - 1] : fullPath;
  const recipeNoun = recipeCount === 1 ? 'recipe' : 'recipes';

  const connectionState = vaultStatus.connectionState ?? (vaultStatus.isConnected ? 'connected' : 'starter');
  const needsReconnect = connectionState === 'reauthorization_required' || connectionState === 'permission_denied';
  const isLiveVault = vaultStatus.isConnected && vaultStatus.accessType === 'filesystem_api';

  // A starter collection is never labelled with a folder path that could be
  // mistaken for the owner's private Vault. Remembered Vaults are named
  // explicitly so recovery is unambiguous. Files imported for this session are
  // labelled as imported files, not as a live two-way Vault.
  const stateLabel = needsReconnect
    ? vaultStatus.rememberedVaultName || 'Remembered Vault'
    : vaultStatus.isConnected
      ? isLiveVault
        ? pathLabel || 'Vault'
        : 'Imported files'
      : 'Starter Vault';

  // STICKY HEADER GEOMETRY — unchanged contract (UD-2A.1B R-1).
  // The header is static below 768px and sticky from 768px up. Its measured
  // height is published as `--kc-sticky-header-h`; index.css consumes it as
  // `scroll-padding-top`. The compact Signature header is shorter, but the
  // measurement remains content-driven and truthful.
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
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty('--kc-sticky-header-h');
    };
  }, []);

  const StatusIcon = needsReconnect ? AlertCircle : vaultStatus.isConnected ? FolderCheck : BookOpen;

  return (
    <header
      ref={headerRef}
      id="obsidian-vault-header"
      className="static z-30 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] shadow-sm md:sticky md:top-0"
    >
      {/* ONE truthful Vault-state line. No duplicate brand, no duplicate
          connection control, no second search region. */}
      <div
        id="vault-status-strip"
        className="flex flex-nowrap items-center justify-between gap-2 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] px-3 text-sm text-[var(--text-secondary,#9CA3AF)] sm:px-4"
      >
        <button
          onClick={onOpenConnectVaultModal}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left transition-colors hover:text-[var(--text-primary,#F3F4F6)]"
          title={fullPath ? `${fullPath} — open Vault settings` : 'Open Vault settings & connect folders'}
        >
          <StatusIcon
            className="h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-[12px] font-medium tracking-[0.01em] text-[var(--text-secondary,#9CA3AF)]">
            {connectionState === 'starter' ? (
              <>
                <span className="sm:hidden">Starter</span>
                <span className="hidden sm:inline">Starter Vault</span>
              </>
            ) : (
              stateLabel
            )}
          </span>
          <span className="hidden text-[var(--text-secondary,#9CA3AF)] sm:inline" aria-hidden="true">•</span>
          <span
            id="vault-recipe-count"
            className="shrink-0 whitespace-nowrap text-[12px] font-medium text-[var(--text-secondary,#9CA3AF)]"
          >
            {recipeCount}
            {needsReconnect ? ' sample' : ''} {recipeNoun}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {needsReconnect ? (
            <button
              id="reconnect-vault-btn"
              onClick={onReconnectVault}
              className="flex min-h-[44px] items-center gap-1 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-2.5 text-sm font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20"
              title={
                connectionState === 'permission_denied'
                  ? `Access to “${vaultStatus.rememberedVaultName || 'your Vault'}” was denied. Click to try again, or pick the folder again.`
                  : `“${vaultStatus.rememberedVaultName || 'Your Vault'}” is remembered. Click to grant access and reconnect it.`
              }
            >
              <BookOpen className="h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" strokeWidth={1.75} aria-hidden="true" />
              <span className="whitespace-nowrap">Reconnect Vault</span>
            </button>
          ) : vaultStatus.isConnected ? (
            <button
              id="vault-linked-chip"
              onClick={onOpenConnectVaultModal}
              className="flex min-h-[44px] items-center gap-1 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 text-sm text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-root,#0C0C0C)]"
              title={isLiveVault ? 'Vault connected — open Vault settings' : 'Recipes loaded from files — open Vault settings'}
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" strokeWidth={1.75} aria-hidden="true" />
              <span className="whitespace-nowrap">{isLiveVault ? 'Vault Linked' : 'Recipes Loaded'}</span>
            </button>
          ) : (
            <button
              id="connect-vault-chip"
              onClick={onOpenConnectVaultModal}
              className="flex min-h-[44px] items-center gap-1 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-2.5 text-sm font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20"
              title="Connect your recipe vault folder"
            >
              <BookOpen className="h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" strokeWidth={1.75} aria-hidden="true" />
              <span className="whitespace-nowrap">Connect Vault</span>
            </button>
          )}

          <button
            id="refresh-vault-btn"
            onClick={onRefreshVault}
            className="flex h-11 w-11 items-center justify-center rounded-sm text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)] hover:text-[var(--text-primary,#F3F4F6)]"
            title="Reload vault markdown notes"
            aria-label="Reload vault markdown notes"
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* Small-screen utility row. Desktop expresses the same actions in the
          page introduction; only one set is visible at a time. */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 sm:px-4 lg:hidden">
        <div className="flex min-w-0 items-center gap-2.5">
          <KitchenCodexMark size={64} decorative className="shrink-0" />
          <div className="min-w-0">
            <div className="truncate font-serif text-[15px] font-semibold leading-tight text-[var(--text-primary,#F3F4F6)] sm:text-lg">
              The Kitchen Codex
            </div>
            <div className="mt-0.5 hidden text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)] sm:block">
              My Recipe Vault
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            id="ask-my-kitchen-header-btn"
            onClick={onOpenAskMyKitchen}
            className="flex h-11 w-11 items-center justify-center rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20"
            aria-label="Ask My Kitchen"
            title="Ask My Kitchen"
          >
            <Sparkles className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            id="connect-local-vault-btn"
            onClick={onOpenConnectVaultModal}
            className="hidden h-11 w-11 items-center justify-center rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20 sm:flex"
            aria-label="Vault settings and connection"
            title="Vault settings and connection"
          >
            <Settings2 className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}
