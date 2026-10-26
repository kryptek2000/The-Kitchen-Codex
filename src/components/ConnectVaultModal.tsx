import React, { useEffect, useRef, useState } from 'react';
import {
  FolderOpen,
  Upload,
  FolderGit2,
  FileText,
  CheckCircle2,
  AlertCircle,
  X,
  RotateCcw,
  Download,
  FolderTree,
  FileCode,
  HardDrive,
  Globe,
} from 'lucide-react';
import { ObsidianRecipe, VaultNote, VaultSyncStatus, MealPlanDay, ShoppingCategoryGroup } from '../types';
import {
  pickVaultDirectory,
  parseUploadedFileList,
  parseDroppedFilesAndFolders,
  isFileSystemAccessSupported,
  downloadMarkdownFile,
} from '../utils/vaultFileSystem';
import { parseObsidianRecipeMarkdown } from '../utils/markdownParser';
import { getStarterVaultRecipes, DEFAULT_VAULT_PATH } from '../data/starterVault';
import { resolveNewRecipeVaultPath } from '../core/vaultPath';

interface ConnectVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  vaultStatus: VaultSyncStatus;
  setVaultStatus: React.Dispatch<React.SetStateAction<VaultSyncStatus>>;
  recipes: ObsidianRecipe[];
  setRecipes: React.Dispatch<React.SetStateAction<ObsidianRecipe[]>>;
  setMealPlan?: React.Dispatch<React.SetStateAction<MealPlanDay[]>>;
  setShoppingCategories?: React.Dispatch<React.SetStateAction<ShoppingCategoryGroup[]>>;
  /** Used to clear the previous Vault's notes when the starter Vault is restored. */
  setNotes?: React.Dispatch<React.SetStateAction<VaultNote[]>>;
  onOpenWebGrabber?: () => void;
  /**
   * Receives the authoritative handle from the picker and performs the
   * adapter-backed Markdown load + separate asset pass (owned by App.tsx,
   * the bootstrap edge). Returns counts so this modal can report the outcome.
   */
  onDirectVaultConnected?: (handle: any) => Promise<{ recipeCount: number; noteCount: number }>;
}

export function ConnectVaultModal({
  isOpen,
  onClose,
  vaultStatus,
  setVaultStatus,
  recipes,
  setRecipes,
  setMealPlan,
  setShoppingCategories,
  setNotes,
  onOpenWebGrabber,
  onDirectVaultConnected,
}: ConnectVaultModalProps) {
  const [activeTab, setActiveTab] = useState<'upload' | 'direct' | 'paste' | 'manage'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [pasteContent, setPasteContent] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [customVaultPath, setCustomVaultPath] = useState(vaultStatus.vaultPath || DEFAULT_VAULT_PATH);
  const [isProcessing, setIsProcessing] = useState(false);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return undefined;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const node = dialogRef.current;
    if (node) node.focus({ preventScroll: true });
    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = Array.from(
      node.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.offsetParent !== null || element === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Handle Folder Picker via standard webkitdirectory (Works in all iframes and browsers)
  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const result = await parseUploadedFileList(e.target.files);
      const parsedRecipes = result.recipes;
      if (parsedRecipes.length > 0 || result.mealPlan || result.shoppingList) {
        const folderName = e.target.files[0]?.webkitRelativePath?.split('/')[0] || 'Recipes';
        if (parsedRecipes.length > 0) setRecipes(parsedRecipes);
        if (result.mealPlan && setMealPlan) setMealPlan(result.mealPlan);
        if (result.shoppingList && setShoppingCategories) setShoppingCategories(result.shoppingList);

        setVaultStatus({
          isConnected: true,
          vaultPath: folderName ? `Vault / ${folderName}` : 'Recipes',
          accessType: 'uploaded_folder',
          connectionState: 'connected',
        });
        setStatusMessage({
          type: 'success',
          text: `Successfully imported ${parsedRecipes.length} recipe ${
            parsedRecipes.length === 1 ? 'note' : 'notes'
          }${result.mealPlan ? ' and Meal Plan.md' : ''}${result.shoppingList ? ' and Shopping List.md' : ''} from "${folderName}"!`,
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: 'No Markdown (.md) recipe notes found in the selected folder.',
        });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'Failed to parse folder files.',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle Multiple .md Files Selection
  const handleFilesUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const result = await parseUploadedFileList(e.target.files);
      const parsedRecipes = result.recipes;
      if (result.mealPlan && setMealPlan) setMealPlan(result.mealPlan);
      if (result.shoppingList && setShoppingCategories) setShoppingCategories(result.shoppingList);

      if (parsedRecipes.length > 0) {
        // Merge or replace
        setRecipes((prev) => {
          const map = new Map(prev.map((r) => [r.id, r]));
          parsedRecipes.forEach((r) => map.set(r.id, r));
          return Array.from(map.values());
        });
        setVaultStatus((prev) => ({
          ...prev,
          isConnected: true,
          connectionState: 'connected',
        }));
        setStatusMessage({
          type: 'success',
          text: `Added ${parsedRecipes.length} recipe note(s) to your recipe vault!`,
        });
      } else if (result.mealPlan || result.shoppingList) {
        setStatusMessage({
          type: 'success',
          text: `Updated Meal Plan and Shopping List from Markdown notes!`,
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: 'Please select valid .md Markdown files.',
        });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'Failed to parse files.',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle Drag and Drop of files or entire folders
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setIsProcessing(true);
    setStatusMessage(null);

    try {
      const result = await parseDroppedFilesAndFolders(e.dataTransfer);
      const parsedRecipes = result.recipes;
      if (result.mealPlan && setMealPlan) setMealPlan(result.mealPlan);
      if (result.shoppingList && setShoppingCategories) setShoppingCategories(result.shoppingList);

      if (parsedRecipes.length > 0) {
        setRecipes((prev) => {
          const map = new Map(prev.map((r) => [r.id, r]));
          parsedRecipes.forEach((r) => map.set(r.id, r));
          return Array.from(map.values());
        });
        setVaultStatus((prev) => ({
          ...prev,
          isConnected: true,
          connectionState: 'connected',
        }));
        setStatusMessage({
          type: 'success',
          text: `Successfully parsed and loaded ${parsedRecipes.length} Markdown recipe note(s)!`,
        });
      } else if (result.mealPlan || result.shoppingList) {
        setStatusMessage({
          type: 'success',
          text: `Imported vault note configuration!`,
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: 'No valid .md markdown recipe files detected in dropped items.',
        });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err?.message || 'Error parsing dropped files.',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle Native File System Access API (Two-Way Live Sync)
  const handleDirectFileSystemConnect = async () => {
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const { folderHandle } = await pickVaultDirectory();
      if (!folderHandle) return;
      // The picker only returns the handle. Markdown hydration + asset pass are
      // performed by the App bootstrap edge (adapter-backed, single Markdown scan).
      const counts = await onDirectVaultConnected?.(folderHandle);
      const label = folderHandle.name || 'My Recipe Vault';
      if (counts && counts.recipeCount > 0) {
        setStatusMessage({
          type: 'success',
          text: `Connected live to vault "${label}" (${counts.recipeCount} notes synced)!`,
        });
      } else {
        setStatusMessage({
          type: 'info',
          text: `Connected to "${label}", but no .md recipe notes were found yet.`,
        });
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setStatusMessage(null);
      } else if (
        err.name === 'SecurityError' ||
        err.message?.includes('Cross origin') ||
        err.message?.includes('sub frames')
      ) {
        setStatusMessage({
          type: 'info',
          text: 'The preview iframe blocks direct disk handles. Use "Import Folder / Files" tab or open this app in a new tab for native OS sync.',
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: err?.message || 'Failed to open directory.',
        });
      }
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle Pasted Markdown Note
  const handleImportPastedNote = () => {
    if (!pasteContent.trim()) {
      setStatusMessage({ type: 'error', text: 'Please paste raw Obsidian markdown content.' });
      return;
    }
    try {
      const fileName = pasteTitle.trim() ? `${pasteTitle.trim().replace(/\.md$/, '')}.md` : 'Pasted Recipe.md';
      const parsed = parseObsidianRecipeMarkdown(pasteContent, fileName, resolveNewRecipeVaultPath(fileName));
      setRecipes((prev) => [parsed, ...prev.filter((r) => r.id !== parsed.id)]);
      setStatusMessage({
        type: 'success',
        text: `Imported "${parsed.title}" as a recipe note!`,
      });
      setPasteContent('');
      setPasteTitle('');
    } catch (e: any) {
      setStatusMessage({ type: 'error', text: 'Failed to parse markdown: ' + e.message });
    }
  };

  // Reset to Starter Library
  const handleRestoreStarterVault = () => {
    const starters = getStarterVaultRecipes();
    setRecipes(starters);
    // The starter Vault carries no notes: clearing them keeps the note count
    // truthful after a Vault switch (UD-2A.2).
    setNotes?.([]);
    setVaultStatus({
      isConnected: false,
      vaultPath: DEFAULT_VAULT_PATH,
      accessType: 'starter_vault',
    });
    setStatusMessage({
      type: 'success',
      text: `Vault reset to the ${starters.length} curated gourmet starter recipes!`,
    });
  };

  // Export All Notes
  const handleExportAllMarkdown = () => {
    recipes.forEach((r, idx) => {
      setTimeout(() => {
        downloadMarkdownFile(r.fileName || `${r.title}.md`, r.rawMarkdown);
      }, idx * 150);
    });
    setStatusMessage({
      type: 'success',
      text: `Exporting ${recipes.length} Markdown recipe notes to your Downloads folder!`,
    });
  };

  const connectionState = vaultStatus.connectionState ?? (vaultStatus.isConnected ? 'connected' : 'starter');
  const needsReconnect = connectionState === 'reauthorization_required' || connectionState === 'permission_denied';
  const isLiveVault = vaultStatus.isConnected && vaultStatus.accessType === 'filesystem_api';
  const connectionLabel =
    connectionState === 'connected' && isLiveVault
      ? 'Local Vault Connected'
      : connectionState === 'connected'
        ? 'Recipes loaded'
        : connectionState === 'reauthorization_required'
          ? 'Reconnect required'
          : connectionState === 'permission_denied'
            ? 'Vault access denied'
            : 'Starter library';
  const connectionDescription =
    connectionState === 'connected' && isLiveVault
      ? 'Changes can sync to the folder you chose.'
      : connectionState === 'connected'
        ? 'These recipes are loaded in this app. Live folder sync is not connected.'
        : connectionState === 'reauthorization_required'
          ? 'Your Vault is remembered; the browser needs permission to reopen it.'
          : connectionState === 'permission_denied'
            ? 'The browser refused access. Choose the folder again or reconnect.'
            : 'Sample recipes are loaded. Connect your own Vault to see your recipes.';
  const vaultTabs = [
    { id: 'upload' as const, label: 'Import Folder / Files', icon: Upload },
    { id: 'direct' as const, label: 'Live Directory Sync', icon: FolderOpen },
    { id: 'paste' as const, label: 'Paste Markdown', icon: FileCode },
    { id: 'manage' as const, label: `Vault Stats (${recipes.length})`, icon: FolderTree },
  ];

  return (
    <div
      id="connect-vault-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/65 p-3 backdrop-blur-sm sm:p-5"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id="connect-vault-modal-card"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-vault-title"
        aria-describedby="connect-vault-description"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="my-2 flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-primary,#F3F4F6)] shadow-2xl focus:outline-none sm:my-4"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--accent-text,#F59E0B)]">
              <FolderGit2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">My Recipe Vault</p>
              <h2 id="connect-vault-title" className="font-serif text-[22px] leading-snug text-[var(--text-primary,#F3F4F6)] sm:text-[25px]">
                Connect or manage your recipes
              </h2>
              <p id="connect-vault-description" className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)] sm:line-clamp-none">
                Bring your own Markdown recipes into The Kitchen Codex, or keep using the sample library.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`hidden rounded-full border px-2.5 py-1 text-[11px] font-medium sm:inline-flex ${
              connectionState === 'connected'
                ? 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)]'
                : needsReconnect
                  ? 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--text-primary,#F3F4F6)]'
                  : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)]'
            }`}>
              {connectionLabel}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Vault settings"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-elevated,#1E1E1E)] hover:text-[var(--text-primary,#F3F4F6)]"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div
          className="hidden items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] px-5 sm:flex"
          role="tablist"
          aria-label="Vault options"
          onKeyDown={(event) => {
            const ids = vaultTabs.map((tab) => tab.id);
            const index = ids.indexOf(activeTab);
            if (index < 0) return;
            let nextIndex: number | null = null;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % ids.length;
            else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + ids.length) % ids.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = ids.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            const next = ids[nextIndex];
            setActiveTab(next);
            setStatusMessage(null);
            window.requestAnimationFrame(() => document.getElementById(`vault-tab-${next}`)?.focus());
          }}
        >
          {vaultTabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`vault-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`vault-panel-${id}`}
              onClick={() => {
                setActiveTab(id);
                setStatusMessage(null);
              }}
              className={`flex min-h-[48px] items-center justify-center gap-2 whitespace-nowrap border-b-2 px-3 text-[12px] font-semibold transition-colors ${
                activeTab === id
                  ? 'border-[var(--accent-text,#F59E0B)] text-[var(--text-primary,#F3F4F6)]'
                  : 'border-transparent text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
          {onOpenWebGrabber && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenWebGrabber();
              }}
              className="ml-auto flex min-h-[48px] items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-[12px] font-semibold text-[var(--accent-text,#F59E0B)] hover:bg-[var(--bg-elevated,#1E1E1E)]"
              title="Import recipe from a website URL"
            >
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Grab from Web</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] px-3 py-2 sm:hidden">
          <label className="sr-only" htmlFor="vault-section-select">Vault section</label>
          <select
            id="vault-section-select"
            aria-label="Vault section"
            value={activeTab}
            onChange={(event) => {
              setActiveTab(event.target.value as typeof activeTab);
              setStatusMessage(null);
            }}
            className="min-h-[44px] flex-1 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 text-[13px] text-[var(--text-primary,#F3F4F6)]"
          >
            {vaultTabs.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          {onOpenWebGrabber && (
            <button
              type="button"
              aria-label="Grab recipe from web"
              title="Import recipe from a website URL"
              onClick={() => {
                onClose();
                onOpenWebGrabber();
              }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--accent-text,#F59E0B)]"
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="max-h-[65vh] flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {statusMessage && (
            <div
              role={statusMessage.type === 'error' ? 'alert' : 'status'}
              className={`flex items-start gap-2.5 rounded-xl border p-3 text-[12px] ${
                statusMessage.type === 'success'
                  ? 'border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)]'
                  : statusMessage.type === 'info'
                    ? 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)]'
                    : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-amber-500 bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)]'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
              )}
              <span className="flex-1 leading-relaxed">{statusMessage.text}</span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 sm:hidden">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary,#9CA3AF)]">Current connection</p>
              <p className="truncate font-serif text-[15px] text-[var(--text-primary,#F3F4F6)]">{connectionLabel}</p>
            </div>
            <span className="shrink-0 font-mono text-[10px] text-[var(--text-secondary,#9CA3AF)]">{recipes.length} recipe{recipes.length === 1 ? '' : 's'}</span>
          </div>
          <div className="hidden flex-wrap items-start justify-between gap-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-3 sm:flex">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary,#9CA3AF)]">Current connection</p>
              <p className="mt-0.5 font-serif text-[17px] text-[var(--text-primary,#F3F4F6)]">{connectionLabel}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">{connectionDescription}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-[12px] text-[var(--text-primary,#F3F4F6)]">{recipes.length} recipe{recipes.length === 1 ? '' : 's'} loaded</p>
              <p className="mt-0.5 max-w-[220px] truncate font-mono text-[10px] text-[var(--text-secondary,#9CA3AF)]" title={vaultStatus.vaultPath || DEFAULT_VAULT_PATH}>
                {vaultStatus.vaultPath || DEFAULT_VAULT_PATH}
              </p>
            </div>
          </div>

          {activeTab === 'upload' && (
            <div
              id="vault-panel-upload"
              role="tabpanel"
              aria-labelledby="vault-tab-upload"
              className="space-y-4"
            >
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => folderInputRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center space-y-3 rounded-2xl border-2 border-dashed p-4 text-center transition-colors sm:p-8 ${
                  dragOver
                    ? 'border-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.12))]'
                    : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] hover:border-[var(--accent-text,#F59E0B)]'
                }`}
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--accent-text,#F59E0B)]">
                  <Upload className="h-6 w-6" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="font-serif text-[16px] text-[var(--text-primary,#F3F4F6)] sm:text-[18px]">
                    Drop your recipe folder or Markdown files
                  </h3>
                  <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                    We read recipe notes, Meal Plan.md and Shopping List.md. Your files stay in the
                    folder you choose — nothing is uploaded to a service.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      folderInputRef.current?.click();
                    }}
                    className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-amber-500 px-4 text-[12px] font-semibold text-black transition-colors hover:bg-amber-400"
                  >
                    <FolderOpen className="h-4 w-4" aria-hidden="true" />
                    <span>Choose recipe folder</span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      filesInputRef.current?.click();
                    }}
                    className="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 text-[12px] font-medium text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                  >
                    <FileText className="h-4 w-4 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                    <span>Choose .md files</span>
                  </button>
                </div>
              </div>

              <input type="file" ref={folderInputRef} onChange={handleFolderUpload} {...({ webkitdirectory: 'true', directory: 'true' } as any)} multiple className="hidden" />
              <input type="file" ref={filesInputRef} onChange={handleFilesUpload} accept=".md,.markdown,text/markdown" multiple className="hidden" />

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3.5 py-3 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                <span>This import adds recipes to the library currently loaded here.</span>
                <span className="font-mono text-[var(--text-primary,#F3F4F6)]">{recipes.length} recipe{recipes.length === 1 ? '' : 's'} loaded</span>
              </div>
            </div>
          )}

          {activeTab === 'direct' && (
            <div id="vault-panel-direct" role="tabpanel" aria-labelledby="vault-tab-direct" className="space-y-4">
              <div className="space-y-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)]">
                  <HardDrive className="h-4 w-4 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                  <span>Keep your Vault and this app in step</span>
                </div>
                <p className="text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                  Choose the folder that holds your recipe notes. When you save a recipe here,
                  The Kitchen Codex can write the updated Markdown back to that folder.
                </p>
                <dl className="grid gap-2 text-[12px] sm:grid-cols-2">
                  <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 py-2">
                    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-secondary,#9CA3AF)]">Folder</dt>
                    <dd className="mt-0.5 break-all font-mono text-[11px] text-[var(--text-primary,#F3F4F6)]">{customVaultPath}</dd>
                  </div>
                  <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 py-2">
                    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-secondary,#9CA3AF)]">Status</dt>
                    <dd className="mt-0.5 text-[11px] text-[var(--text-primary,#F3F4F6)]">{connectionLabel}</dd>
                  </div>
                </dl>
              </div>

              <button
                type="button"
                onClick={handleDirectFileSystemConnect}
                disabled={isProcessing}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 text-[13px] font-semibold text-black shadow-md shadow-amber-500/20 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FolderOpen className="h-4 w-4" aria-hidden="true" />
                <span>{isProcessing ? 'Opening folder…' : 'Choose Local Obsidian Vault Folder'}</span>
              </button>

              <p className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                Browsers only grant folder access after you choose the folder. If you are viewing this
                app inside an embedded preview, use <strong className="text-[var(--text-primary,#F3F4F6)]">Import Files</strong> or open the app in its own tab.
              </p>

              {needsReconnect && (
                <p className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] p-3 text-[12px] leading-relaxed text-[var(--text-primary,#F3F4F6)]">
                  {connectionDescription}
                </p>
              )}
            </div>
          )}

          {activeTab === 'paste' && (
            <div id="vault-panel-paste" role="tabpanel" aria-labelledby="vault-tab-paste" className="space-y-3">
              <div>
                <label htmlFor="vault-paste-title" className="mb-1 block text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)]">
                  Recipe note title <span className="font-normal text-[var(--text-secondary,#9CA3AF)]">(optional)</span>
                </label>
                <input
                  id="vault-paste-title"
                  type="text"
                  value={pasteTitle}
                  onChange={(event) => setPasteTitle(event.target.value)}
                  placeholder="e.g. Sourdough Pizza Crust"
                  className="min-h-[44px] w-full rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] px-3.5 text-[13px] text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-muted,#6B7280)] focus:border-[var(--accent-text,#F59E0B)]"
                />
              </div>

              <div>
                <label htmlFor="vault-paste-markdown" className="mb-1 block text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)]">
                  Markdown note
                </label>
                <textarea
                  id="vault-paste-markdown"
                  rows={8}
                  value={pasteContent}
                  onChange={(event) => setPasteContent(event.target.value)}
                  placeholder={`---\ntitle: Garlic Butter Shrimp\ntags:\n  - food/recipes\nservings: 2\n---\n\n# Garlic Butter Shrimp\n\n## Ingredients\n- 1 lb shrimp, peeled\n- 4 tbsp butter\n\n## Instructions\n1. Cook until pink.`}
                  className="w-full rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-muted,#6B7280)] focus:border-[var(--accent-text,#F59E0B)]"
                />
              </div>

              <button
                type="button"
                onClick={handleImportPastedNote}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 text-[13px] font-semibold text-black transition-colors hover:bg-amber-400"
              >
                <FileCode className="h-4 w-4" aria-hidden="true" />
                <span>Add recipe from Markdown</span>
              </button>
            </div>
          )}

          {activeTab === 'manage' && (
            <div id="vault-panel-manage" role="tabpanel" aria-labelledby="vault-tab-manage" className="space-y-4">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {[
                  ['Recipe notes', recipes.length],
                  ['Ingredients', recipes.reduce((total, recipe) => total + (recipe.ingredients?.length || 0), 0)],
                  ['Wikilinks', recipes.reduce((total, recipe) => total + (recipe.wikilinks?.length || 0), 0)],
                  ['Callouts', recipes.reduce((total, recipe) => total + (recipe.callouts?.length || 0), 0)],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2.5">
                    <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary,#9CA3AF)]">{label}</span>
                    <span className="mt-0.5 block font-mono text-[19px] font-semibold text-[var(--text-primary,#F3F4F6)]">{value}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-3">
                <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary,#9CA3AF)]">Recipes currently loaded</h3>
                  <span className="font-mono text-[10px] text-[var(--text-secondary,#9CA3AF)]">{recipes.length} files</span>
                </div>
                <div className="mt-2 max-h-36 space-y-1 overflow-y-auto pr-1">
                  {recipes.map((recipe) => (
                    <div key={recipe.id} className="flex min-h-[32px] items-center justify-between gap-2 rounded-md px-2 text-[12px] text-[var(--text-primary,#F3F4F6)] hover:bg-[var(--bg-surface,#141414)]">
                      <span className="truncate font-mono text-[11px]">{recipe.fileName}</span>
                      <span className="shrink-0 text-[10px] text-[var(--text-secondary,#9CA3AF)]">{recipe.cuisine || 'Uncategorized'}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-3">
                <button
                  type="button"
                  onClick={handleExportAllMarkdown}
                  className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                >
                  <Download className="h-3.5 w-3.5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                  <span>Export Markdown</span>
                </button>
                <button
                  type="button"
                  onClick={handleRestoreStarterVault}
                  title={`Reload the ${getStarterVaultRecipes().length} curated starter recipes`}
                  className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                >
                  <RotateCcw className="h-3.5 w-3.5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                  <span>Use starter library</span>
                </button>
              </div>

              <p className="text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                “Use starter library” replaces the recipes loaded in this app with the curated
                starter set. It does not delete or change files in your folder.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${connectionState === 'connected' ? 'bg-[var(--accent-text,#F59E0B)]' : needsReconnect ? 'bg-amber-500' : 'bg-[var(--text-muted,#6B7280)]'}`} />
            <span className="truncate font-mono text-[11px] text-[var(--text-secondary,#9CA3AF)]" title={vaultStatus.vaultPath || DEFAULT_VAULT_PATH}>
              {connectionLabel} · {vaultStatus.vaultPath || DEFAULT_VAULT_PATH}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
