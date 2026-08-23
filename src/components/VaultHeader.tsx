import React, { useRef } from 'react';
import {
  FolderGit2,
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
} from 'lucide-react';
import { VaultSyncStatus } from '../types';

interface VaultHeaderProps {
  vaultStatus: VaultSyncStatus;
  activeTab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes';
  setActiveTab: (tab: 'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  isFilterOpen: boolean;
  setIsFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  activeFilterCount: number;
  onOpenConnectVaultModal: () => void;
  onOpenNewRecipeModal: () => void;
  onOpenRecipeGrabber: () => void;
  onOpenVaultIntelligence: () => void;
  legacyRecipeCount?: number;
  onRefreshVault: () => void;
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
  legacyRecipeCount = 0,
  onRefreshVault,
}: VaultHeaderProps) {
  return (
    <header id="obsidian-vault-header" className="bg-[#141414] border-b border-white/5 sticky top-0 z-30 shadow-md">
      {/* Top Vault Path & Quick Status Bar */}
      <div className="bg-[#080808] text-gray-400 text-xs px-4 py-2 flex flex-wrap items-center justify-between gap-2 border-b border-white/5">
        <div
          onClick={onOpenConnectVaultModal}
          className="flex items-center gap-2 min-w-0 cursor-pointer hover:opacity-90 transition-opacity"
          title="Click to view Vault settings & connect folders"
        >
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono text-[11px]">
            <FolderCheck className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-semibold">Obsidian Vault</span>
          </div>
          <span className="text-gray-600 hidden sm:inline">/</span>
          <span className="font-mono text-gray-300 truncate" title={vaultStatus.vaultPath}>
            {vaultStatus.vaultPath}
          </span>
          <span className="text-gray-600">•</span>
          <span className="text-gray-400 font-medium whitespace-nowrap">
            {vaultStatus.fileCount} {vaultStatus.fileCount === 1 ? 'recipe note' : 'recipe notes'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {vaultStatus.isConnected ? (
            <button
              onClick={onOpenConnectVaultModal}
              className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded-md border border-emerald-800/40 hover:bg-emerald-950/70 transition-colors"
            >
              <CheckCircle2 className="w-3 h-3" />
              <span>Vault Linked ({vaultStatus.fileCount})</span>
            </button>
          ) : (
            <button
              onClick={onOpenConnectVaultModal}
              className="flex items-center gap-1 text-[11px] text-amber-300 bg-amber-950/40 px-2 py-0.5 rounded-md border border-amber-800/40 hover:bg-amber-950/70 transition-colors"
            >
              <BookOpen className="w-3 h-3" />
              <span>Starter Vault (8 Notes)</span>
            </button>
          )}

          <button
            id="refresh-vault-btn"
            onClick={onRefreshVault}
            className="p-1 text-gray-400 hover:text-gray-100 hover:bg-white/5 rounded transition-colors"
            title="Reload vault markdown notes"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Action Bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* App Title & Branding */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/20 text-amber-500 flex items-center justify-center border border-amber-500/30">
            <FolderGit2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-serif font-bold text-white tracking-tight">The Kitchen Codex</h1>
              <span className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded bg-white/5 text-gray-400 border border-white/5 font-medium">
                Obsidian Culinary Vault
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                v0.2.2
              </span>
            </div>
            <p className="text-xs text-gray-500">
              Markdown-native kitchen companion &amp; culinary note system for Obsidian
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Vault Intelligence Button */}
          <button
            id="vault-intelligence-header-btn"
            onClick={onOpenVaultIntelligence}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 transition-colors shadow-xs"
            title="Scan recipe metadata health, recover missing fields, and detect legacy formats"
          >
            <BrainCircuit className="w-4 h-4 text-purple-400" />
            <span>Vault Intelligence</span>
            {legacyRecipeCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-purple-500 text-black font-bold">
                {legacyRecipeCount}
              </span>
            )}
          </button>

          {/* Grab Recipe from Web Button */}
          <button
            id="grab-recipe-header-btn"
            onClick={onOpenRecipeGrabber}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 transition-colors shadow-xs"
            title="Import & grab recipes directly from website URLs or text"
          >
            <Globe className="w-4 h-4 text-sky-400" />
            <span>Grab from Web</span>
          </button>

          {/* Connect Vault Modal Button */}
          <button
            id="connect-local-vault-btn"
            onClick={onOpenConnectVaultModal}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-colors shadow-xs"
            title="Connect your Obsidian Vault folder, import .md files, or drop recipes"
          >
            <FolderOpen className="w-4 h-4 text-amber-400" />
            <span>Connect Vault</span>
          </button>

          {/* New Recipe Note Button */}
          <button
            id="create-new-recipe-btn"
            onClick={onOpenNewRecipeModal}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-black shadow-md shadow-amber-500/20 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>New Recipe Note</span>
          </button>
        </div>
      </div>

      {/* Navigation Tabs & Search Controls */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-3 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Navigation Tabs */}
        <nav id="vault-view-tabs" className="flex items-center gap-1 bg-[#0C0C0C] p-1 rounded-xl border border-white/5 self-start">
          <button
            id="tab-recipe-cards"
            onClick={() => setActiveTab('grid')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'grid'
                ? 'bg-white/10 text-amber-400 font-semibold border border-white/10'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Recipe Gallery</span>
          </button>

          <button
            id="tab-dataview-table"
            onClick={() => setActiveTab('dataview')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'dataview'
                ? 'bg-white/10 text-amber-400 font-semibold border border-white/10'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <Table className="w-3.5 h-3.5" />
            <span>Dataview Table</span>
          </button>

          <button
            id="tab-meal-planner"
            onClick={() => setActiveTab('mealplan')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'mealplan'
                ? 'bg-white/10 text-amber-400 font-semibold border border-white/10'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <CalendarDays className="w-3.5 h-3.5" />
            <span>Meal Plan</span>
          </button>

          <button
            id="tab-shopping-list"
            onClick={() => setActiveTab('shopping')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'shopping'
                ? 'bg-white/10 text-amber-400 font-semibold border border-white/10'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            <span>Shopping List</span>
          </button>

          <button
            id="tab-themes"
            onClick={() => setActiveTab('themes')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'themes'
                ? 'bg-white/10 text-amber-400 font-semibold border border-white/10'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <Palette className="w-3.5 h-3.5" />
            <span>Themes</span>
          </button>
        </nav>

        {/* Search & Filter Controls */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              id="recipe-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search recipes, tags, ingredients..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#0C0C0C] border border-white/10 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
              >
                ×
              </button>
            )}
          </div>

          <button
            id="toggle-filters-btn"
            onClick={() => setIsFilterOpen((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
              isFilterOpen || activeFilterCount > 0
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 font-semibold'
                : 'bg-white/5 border-white/10 text-gray-300 hover:bg-white/10'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-amber-500 text-black text-[10px] flex items-center justify-center font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
