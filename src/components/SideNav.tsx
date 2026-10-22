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
  `flex items-center gap-3 px-3 py-2 min-h-[44px] rounded-lg text-base font-medium transition-colors duration-[140ms] ${
    active
      ? 'bg-white/10 text-amber-400 border border-white/10'
      : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
  }`;

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

  return (
    <aside className="kc-app-rail hidden lg:flex flex-col shrink-0 border-r border-white/5 bg-[#111111] sticky top-0 h-screen">
      <div className="px-4 py-4 flex items-center gap-3 border-b border-white/5">
        <KitchenCodexMark size={40} decorative className="shrink-0" />
        <div className="min-w-0">
          <div className="font-serif font-bold text-xl text-white leading-tight">The Kitchen Codex</div>
          <div className="text-sm uppercase tracking-widest text-gray-500">My Recipe Vault</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Primary">
        <button id="nav-recipe-vault" aria-current={activeTab === 'grid' ? 'page' : undefined} className={navItem(activeTab === 'grid')} onClick={() => setActiveTab('grid')}>
          <LayoutGrid className="w-5 h-5" /> My Recipe Vault
        </button>
        <button id="nav-favorites" className={navItem(false)} onClick={onFavorites}>
          <Star className="w-5 h-5" /> Favorites
        </button>
        <button id="nav-dataview-table" aria-current={activeTab === 'dataview' ? 'page' : undefined} className={navItem(activeTab === 'dataview')} onClick={() => setActiveTab('dataview')}>
          <LayoutGrid className="w-5 h-5" /> Dataview Table
        </button>
        <button id="nav-meal-planner" aria-current={activeTab === 'mealplan' ? 'page' : undefined} className={navItem(activeTab === 'mealplan')} onClick={() => setActiveTab('mealplan')}>
          <CalendarDays className="w-5 h-5" /> Meal Planner
        </button>
        <button id="nav-shopping-list" aria-current={activeTab === 'shopping' ? 'page' : undefined} className={navItem(activeTab === 'shopping')} onClick={() => setActiveTab('shopping')}>
          <ShoppingCart className="w-5 h-5" /> Shopping List
        </button>

        <div className="pt-4 pb-1 px-3 text-sm uppercase tracking-widest text-gray-600">Tools</div>
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
          <span className="w-5 h-5 inline-flex items-center justify-center text-amber-400">+</span> New Recipe
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

        <div className="pt-4 pb-1 px-3 text-sm uppercase tracking-widest text-gray-600">Companion</div>
        <button
          onClick={onShisoOpen}
          className="w-full flex items-center gap-3 px-3 py-2 min-h-[44px] rounded-lg text-base font-medium text-teal-300 bg-teal-500/10 border border-teal-500/30 hover:bg-teal-500/20 transition-colors duration-[140ms]"
        >
          <MessageCircle className="w-5 h-5" /> Chat with SHISO
        </button>
        <button
          onClick={onOpenAskMyKitchen}
          className="w-full flex items-center gap-3 px-3 py-2 min-h-[44px] rounded-lg text-base font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 transition-colors duration-[140ms]"
        >
          <Settings className="w-5 h-5" /> Ask My Kitchen
        </button>
      </nav>

      {/* Vault status. The quantity is always the RECIPE count — the same total
          the header strip and the gallery heading report. A note count is
          reported separately, and only when there are notes, so the two are
          never conflated (UD-2A.2). */}
      <div id="sidenav-vault-status" className="px-3 py-3 border-t border-white/5 text-sm text-gray-500 space-y-1">
        <div id="sidenav-vault-status-line" className={vaultStatus.isConnected ? 'text-emerald-400' : 'text-amber-400'}>
          {vaultStatus.isConnected
            ? `Vault linked · ${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'}${
                noteCount > 0 ? ` · ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : ''
              }`
            : `Starter vault · ${recipeCount} sample ${recipeCount === 1 ? 'recipe' : 'recipes'}`}
        </div>
        {needsReconnect && (
          <button
            id="sidenav-reconnect-vault-btn"
            onClick={onReconnectVault}
            className="text-amber-300 underline underline-offset-2 hover:text-amber-200 text-left"
            title={vaultStatus.rememberedVaultName
              ? `“${vaultStatus.rememberedVaultName}” is remembered — click to grant access and reconnect it.`
              : 'Your Vault is remembered — click to grant access and reconnect it.'}
          >
            Reconnect your Vault
          </button>
        )}
      </div>
    </aside>
  );
}
