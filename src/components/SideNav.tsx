import React from 'react';
import {
  LayoutGrid,
  CalendarDays,
  ShoppingCart,
  Palette,
  BrainCircuit,
  FolderOpen,
  Star,
  MessageCircle,
  Settings,
} from 'lucide-react';
import { KitchenCodexMark } from './BrandMark';
import { VaultSyncStatus } from '../types';
import { describeVaultConnection } from '../core/vaultConnection';

interface SideNavProps {
  activeTab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers';
  setActiveTab: (tab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers') => void;
  vaultStatus: VaultSyncStatus;
  /** The RECIPE count of the active vault — the same total the header and gallery show. */
  recipeCount: number;
  /** The count of non-recipe vault notes. Labelled as notes, never as recipes. */
  noteCount: number;
  /** Re-authorises a remembered Vault. Invoked from a user gesture. */
  onReconnectVault: () => void;
  onOpenConnectVaultModal: () => void;
  onOpenNewRecipeModal: () => void;
  onOpenAskMyKitchen: () => void;
  onOpenCreateForMe: () => void;
  onOpenRecipeGrabber: () => void;
  onOpenVaultIntelligence: () => void;
  legacyRecipeCount?: number;
  onShisoOpen: () => void;
  onFavorites: () => void;
}

const navItem = (active: boolean) =>
  `flex items-center gap-3 rounded-lg border px-3 py-2 text-[15px] font-medium transition-colors duration-[140ms] min-h-[44px] ${
    active
      ? 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--text-primary,#F3F4F6)]'
      : 'border-transparent text-[var(--text-secondary,#9CA3AF)] hover:bg-[var(--bg-elevated,#1E1E1E)] hover:text-[var(--text-primary,#F3F4F6)]'
  }`;

const sectionLabel = 'px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted,#6B7280)]';

export function SideNav({
  activeTab,
  setActiveTab,
  vaultStatus,
  recipeCount,
  noteCount,
  onReconnectVault,
  onOpenConnectVaultModal,
  onOpenNewRecipeModal,
  onOpenAskMyKitchen,
  onOpenCreateForMe,
  onOpenRecipeGrabber,
  onOpenVaultIntelligence,
  legacyRecipeCount = 0,
  onShisoOpen,
  onFavorites,
}: SideNavProps) {
  // A remembered Vault that still needs the browser's permission must be
  // surfaced explicitly (UD-2A.2) — never silently replaced by the starter
  // Vault as though it were the user's own data.
  const connectionState = vaultStatus.connectionState ?? (vaultStatus.isConnected ? 'connected' : 'starter');
  const needsReconnect = connectionState === 'reauthorization_required' || connectionState === 'permission_denied';
  const isLiveVault = vaultStatus.isConnected && vaultStatus.accessType === 'filesystem_api';
  const described = describeVaultConnection({
    state: connectionState,
    recipeCount,
    noteCount,
    rememberedVaultName: vaultStatus.rememberedVaultName,
  });
  const statusLine = needsReconnect
    ? described.label
    : vaultStatus.isConnected
      ? `${isLiveVault ? 'Vault linked' : 'Recipes loaded'} · ${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'}${
          noteCount > 0 ? ` · ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : ''
        }`
      : `Starter vault · ${recipeCount} sample ${recipeCount === 1 ? 'recipe' : 'recipes'}`;
  const statusTone = needsReconnect
    ? 'text-[var(--text-primary,#F3F4F6)]'
    : vaultStatus.isConnected
      ? 'text-[var(--accent-text,#F59E0B)]'
      : 'text-[var(--text-secondary,#9CA3AF)]';

  return (
    <aside className="kc-app-rail sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-header,#111111)] lg:flex">
      <div className="flex items-center gap-3 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] px-4 py-4">
        <KitchenCodexMark size={40} decorative className="shrink-0" />
        <div className="min-w-0">
          <div className="font-serif text-xl font-semibold leading-tight text-[var(--text-primary,#F3F4F6)]">The Kitchen Codex</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">My Recipe Vault</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3" aria-label="Primary">
        <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted,#6B7280)]">Library</div>
        <button id="nav-recipe-vault" aria-current={activeTab === 'grid' ? 'page' : undefined} className={navItem(activeTab === 'grid')} onClick={() => setActiveTab('grid')}>
          <LayoutGrid className="w-5 h-5" /> My Recipe Vault
        </button>
        <button id="nav-favorites" className={navItem(false)} onClick={onFavorites}>
          <Star className="w-5 h-5" /> Favorites
        </button>
        <button id="nav-dataview-table" aria-current={activeTab === 'dataview' ? 'page' : undefined} className={navItem(activeTab === 'dataview')} onClick={() => setActiveTab('dataview')}>
          <LayoutGrid className="w-5 h-5" /> Dataview Table
        </button>
        <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted,#6B7280)]">Kitchen</div>
        <button id="nav-meal-planner" aria-current={activeTab === 'mealplan' ? 'page' : undefined} className={navItem(activeTab === 'mealplan')} onClick={() => setActiveTab('mealplan')}>
          <CalendarDays className="w-5 h-5" /> Meal Planner
        </button>
        <button id="nav-shopping-list" aria-current={activeTab === 'shopping' ? 'page' : undefined} className={navItem(activeTab === 'shopping')} onClick={() => setActiveTab('shopping')}>
          <ShoppingCart className="w-5 h-5" /> Shopping List
        </button>

        <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted,#6B7280)]">Tools</div>
        <button id="nav-ai-studio" aria-current={activeTab === 'providers' ? 'page' : undefined} className={navItem(activeTab === 'providers')} onClick={() => setActiveTab('providers')}>
          <BrainCircuit className="w-5 h-5" /> AI Studio
        </button>
        <button id="nav-themes" aria-current={activeTab === 'themes' ? 'page' : undefined} className={navItem(activeTab === 'themes')} onClick={() => setActiveTab('themes')}>
          <Palette className="w-5 h-5" /> Themes
        </button>
        <button className={navItem(false)} onClick={onOpenConnectVaultModal}>
          <FolderOpen className="w-5 h-5" /> Vault Settings
        </button>
        <button className={navItem(false)} onClick={onOpenNewRecipeModal}>
          <span className="inline-flex h-5 w-5 items-center justify-center text-[var(--accent-text,#F59E0B)]" aria-hidden="true">+</span> New Recipe
        </button>
        <button className={navItem(false)} onClick={onOpenCreateForMe}>
          <span className="w-5 h-5 inline-flex items-center justify-center text-violet-400">✦</span> Create with SHISO
        </button>
        <button className={navItem(false)} onClick={onOpenRecipeGrabber}>
          <span className="w-5 h-5 inline-flex items-center justify-center text-sky-400">🌐</span> Grab from Web
        </button>
        <button className={navItem(false)} onClick={onOpenVaultIntelligence}>
          <span className="w-5 h-5 inline-flex items-center justify-center text-purple-400">🧠</span> Vault Intelligence
          {legacyRecipeCount > 0 && (
            <span className="ml-auto text-[10px] px-1.5 py-0.2 rounded-full bg-purple-500 text-black font-bold">
              {legacyRecipeCount}
            </span>
          )}
        </button>

        <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted,#6B7280)]">Companion</div>
        <button
          onClick={onShisoOpen}
          className="flex min-h-[44px] w-full items-center gap-3 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-[15px] font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-root,#0C0C0C)]"
        >
          <MessageCircle className="w-5 h-5" /> Chat with SHISO
        </button>
        <button
          onClick={onOpenAskMyKitchen}
          className="flex min-h-[44px] w-full items-center gap-3 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-3 py-2 text-[15px] font-medium text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
        >
          <Settings className="w-5 h-5" /> Ask My Kitchen
        </button>
      </nav>

      {/* Vault status. The quantity is always the RECIPE count — the same total
          the header strip and the gallery heading report. A note count is
          reported separately, and only when there are notes, so the two are
          never conflated (UD-2A.2). */}
      <div id="sidenav-vault-status" className="space-y-1 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] px-3 py-3 text-sm text-[var(--text-muted,#6B7280)]">
        <div id="sidenav-vault-status-line" className={`${statusTone} truncate`} title={described.detail}>
          {statusLine}
        </div>
        {needsReconnect && (
          <>
            <p className="text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">{described.detail}</p>
            <button
              id="sidenav-reconnect-vault-btn"
              onClick={onReconnectVault}
              className="min-h-[44px] text-left text-[12px] font-semibold text-[var(--accent-text,#F59E0B)] underline underline-offset-2 hover:text-[var(--text-primary,#F3F4F6)]"
              title={vaultStatus.rememberedVaultName
                ? `“${vaultStatus.rememberedVaultName}” is remembered — click to grant access and reconnect it.`
                : 'Your Vault is remembered — click to grant access and reconnect it.'}
            >
              Reconnect your Vault
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
