import React, { useState, useRef } from 'react';
import {
  FolderOpen,
  Upload,
  FolderGit2,
  FileText,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  X,
  RotateCcw,
  Download,
  FolderTree,
  FileCode,
  ArrowRight,
  HardDrive,
  Copy,
  Check,
  Globe,
} from 'lucide-react';
import { ObsidianRecipe, VaultSyncStatus, MealPlanDay, ShoppingCategoryGroup } from '../types';
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

  if (!isOpen) return null;

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
          fileCount: parsedRecipes.length,
          accessType: 'uploaded_folder',
        });
        setStatusMessage({
          type: 'success',
          text: `Successfully imported ${parsedRecipes.length} Obsidian recipe ${
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
          fileCount: recipes.length + parsedRecipes.length,
        }));
        setStatusMessage({
          type: 'success',
          text: `Added ${parsedRecipes.length} recipe note(s) to your culinary vault!`,
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
          fileCount: prev.fileCount + parsedRecipes.length,
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
      const label = folderHandle.name || 'Obsidian Vault';
      if (counts && counts.recipeCount > 0) {
        setStatusMessage({
          type: 'success',
          text: `Connected live to Obsidian folder "${label}" (${counts.recipeCount} notes synced)!`,
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
    setVaultStatus({
      isConnected: false,
      vaultPath: DEFAULT_VAULT_PATH,
      fileCount: starters.length,
      accessType: 'starter_vault',
    });
    setStatusMessage({
      type: 'success',
      text: `Vault reset to the 8 curated gourmet starter recipes!`,
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

  return (
    <div
      id="connect-vault-modal-overlay"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        id="connect-vault-modal-card"
        className="bg-[#141414] border border-white/10 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col text-gray-200 animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Modal Header */}
        <div className="p-5 border-b border-white/5 flex items-start justify-between bg-[#181818]/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center">
              <FolderGit2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-serif font-bold text-white flex items-center gap-2">
                <span>Connect Obsidian Vault</span>
                <span className="text-[10px] uppercase font-sans font-medium px-2 py-0.5 rounded bg-white/5 text-amber-300 border border-white/5">
                  Markdown Sync
                </span>
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Load recipe notes directly from your local Obsidian vault or files.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Tabs */}
        <div className="flex items-center gap-1 px-5 pt-3 border-b border-white/5 bg-[#0F0F0F] overflow-x-auto">
          <button
            onClick={() => {
              setActiveTab('upload');
              setStatusMessage(null);
            }}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-t-lg transition-colors border-b-2 whitespace-nowrap ${
              activeTab === 'upload'
                ? 'text-amber-400 border-amber-500 bg-[#141414]'
                : 'text-gray-400 border-transparent hover:text-gray-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import Folder / Files</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('direct');
              setStatusMessage(null);
            }}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-t-lg transition-colors border-b-2 whitespace-nowrap ${
              activeTab === 'direct'
                ? 'text-amber-400 border-amber-500 bg-[#141414]'
                : 'text-gray-400 border-transparent hover:text-gray-200'
            }`}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Live Directory Sync</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('paste');
              setStatusMessage(null);
            }}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-t-lg transition-colors border-b-2 whitespace-nowrap ${
              activeTab === 'paste'
                ? 'text-amber-400 border-amber-500 bg-[#141414]'
                : 'text-gray-400 border-transparent hover:text-gray-200'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            <span>Paste Markdown</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('manage');
              setStatusMessage(null);
            }}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-t-lg transition-colors border-b-2 whitespace-nowrap ${
              activeTab === 'manage'
                ? 'text-amber-400 border-amber-500 bg-[#141414]'
                : 'text-gray-400 border-transparent hover:text-gray-200'
            }`}
          >
            <FolderTree className="w-3.5 h-3.5" />
            <span>Vault Stats ({recipes.length})</span>
          </button>

          {onOpenWebGrabber && (
            <button
              onClick={() => {
                onClose();
                onOpenWebGrabber();
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg transition-colors border-b-2 border-transparent text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 ml-auto whitespace-nowrap"
              title="Import recipe from website URL"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Web Grabber</span>
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
          {/* Status Alert if any */}
          {statusMessage && (
            <div
              className={`p-3 rounded-xl text-xs flex items-start gap-2.5 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-950/40 border border-emerald-800/40 text-emerald-300'
                  : statusMessage.type === 'info'
                  ? 'bg-blue-950/40 border border-blue-800/40 text-blue-300'
                  : 'bg-rose-950/40 border border-rose-800/40 text-rose-300'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span className="flex-1 leading-relaxed">{statusMessage.text}</span>
            </div>
          )}

          {/* TAB 1: UPLOAD / DRAG & DROP */}
          {activeTab === 'upload' && (
            <div className="space-y-4">
              {/* Drag and Drop Zone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center transition-all flex flex-col items-center justify-center space-y-3 cursor-pointer ${
                  dragOver
                    ? 'border-amber-500 bg-amber-500/10'
                    : 'border-white/10 bg-[#0C0C0C] hover:border-amber-500/40 hover:bg-white/5'
                }`}
                onClick={() => folderInputRef.current?.click()}
              >
                <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
                  <Upload className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="font-serif font-bold text-sm text-white">
                    Drag &amp; Drop your Obsidian Recipe folder or .md files here
                  </h4>
                  <p className="text-xs text-gray-400 mt-1 max-w-md mx-auto">
                    Drop your entire <span className="font-mono text-amber-300">Recipes</span> directory or multiple recipe notes. We will parse YAML frontmatter, Dataview fields, wikilinks, and checklist ingredients automatically.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      folderInputRef.current?.click();
                    }}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black rounded-xl text-xs font-bold shadow-md shadow-amber-500/20 transition-all flex items-center gap-1.5"
                  >
                    <FolderOpen className="w-4 h-4" />
                    <span>Select Recipes Folder</span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      filesInputRef.current?.click();
                    }}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5"
                  >
                    <FileText className="w-4 h-4 text-amber-400" />
                    <span>Select .md Files</span>
                  </button>
                </div>
              </div>

              {/* Hidden Inputs */}
              <input
                type="file"
                ref={folderInputRef}
                onChange={handleFolderUpload}
                // @ts-ignore
                webkitdirectory="true"
                directory="true"
                multiple
                className="hidden"
              />
              <input
                type="file"
                ref={filesInputRef}
                onChange={handleFilesUpload}
                accept=".md,.markdown,text/markdown"
                multiple
                className="hidden"
              />

              <div className="bg-[#0C0C0C] p-3.5 rounded-xl border border-white/5 text-xs text-gray-400 flex items-center justify-between">
                <span>Currently active vault contains:</span>
                <span className="font-mono font-semibold text-amber-300">
                  {recipes.length} recipe notes loaded
                </span>
              </div>
            </div>
          )}

          {/* TAB 2: DIRECT TWO-WAY FILE SYSTEM API */}
          {activeTab === 'direct' && (
            <div className="space-y-4">
              <div className="bg-[#0C0C0C] p-4 rounded-xl border border-white/5 space-y-3">
                <div className="flex items-center gap-2 text-amber-400 font-semibold text-xs">
                  <HardDrive className="w-4 h-4" />
                  <span>Two-Way Local File System Integration</span>
                </div>
                <p className="text-xs text-gray-300 leading-relaxed">
                  Connect directly to your local file system using the modern File System Access API. Any edits, new recipes, or checklist updates can be written directly to your disk into your Obsidian vault.
                </p>
                <div className="p-3 bg-white/5 rounded-lg border border-white/5 text-[11px] text-gray-400 space-y-1 font-mono">
                  <div>• Vault Location: {customVaultPath}</div>
                  <div>• Status: {vaultStatus.isConnected ? 'Connected' : 'Ready to link folder'}</div>
                </div>
              </div>

              <button
                onClick={handleDirectFileSystemConnect}
                disabled={isProcessing}
                className="w-full py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-bold text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all flex items-center justify-center gap-2"
              >
                <FolderOpen className="w-4 h-4" />
                <span>{isProcessing ? 'Reading directory...' : 'Choose Local Obsidian Vault Folder'}</span>
              </button>

              <div className="text-[11px] text-gray-500 bg-[#0A0A0A] p-3 rounded-lg border border-white/5 leading-relaxed">
                💡 <strong>Browser Note:</strong> When running inside embedded web previews or iframes, browsers may enforce strict security rules on direct disk handles. If prompted with a permission notice, click allow, or use the <strong>Import Folder / Files</strong> tab to import effortlessly.
              </div>
            </div>
          )}

          {/* TAB 3: PASTE MARKDOWN NOTE */}
          {activeTab === 'paste' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">
                  Recipe Note Title (Optional)
                </label>
                <input
                  type="text"
                  value={pasteTitle}
                  onChange={(e) => setPasteTitle(e.target.value)}
                  placeholder="e.g. Sourdough Pizza Crust"
                  className="w-full text-xs bg-[#0C0C0C] border border-white/10 rounded-xl px-3.5 py-2.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">
                  Raw Obsidian Markdown Note (with YAML frontmatter)
                </label>
                <textarea
                  rows={8}
                  value={pasteContent}
                  onChange={(e) => setPasteContent(e.target.value)}
                  placeholder={`---\ntitle: Garlic Butter Shrimp\ntags:\n  - food/recipes\n  - quick-15min\ncuisine: Seafood\nprep_time: 5 mins\ncook_time: 10 mins\nservings: 2\ndifficulty: Easy\n---\n\n# Garlic Butter Shrimp\n\n## 🥘 Ingredients\n- [ ] 1 lb [[Jumbo Shrimp]], peeled\n- [ ] 4 tbsp [[Unsalted Butter]]\n- [ ] 4 cloves [[Garlic]], minced\n\n## 🍳 Instructions\n1. Sauté garlic in butter for 1 minute.\n2. Add shrimp and cook for 4-5 minutes until pink.`}
                  className="w-full text-xs font-mono bg-[#0C0C0C] border border-white/10 rounded-xl p-3 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-amber-500 leading-relaxed"
                />
              </div>

              <button
                type="button"
                onClick={handleImportPastedNote}
                className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2"
              >
                <FileCode className="w-4 h-4" />
                <span>Parse &amp; Add to Vault</span>
              </button>
            </div>
          )}

          {/* TAB 4: MANAGE & VAULT STATS */}
          {activeTab === 'manage' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-[#0C0C0C] p-3 rounded-xl border border-white/5">
                  <span className="text-[10px] text-gray-500 block uppercase">Recipe Notes</span>
                  <span className="text-lg font-mono font-bold text-amber-400">{recipes.length}</span>
                </div>
                <div className="bg-[#0C0C0C] p-3 rounded-xl border border-white/5">
                  <span className="text-[10px] text-gray-500 block uppercase">Ingredients</span>
                  <span className="text-lg font-mono font-bold text-white">
                    {recipes.reduce((acc, r) => acc + (r.ingredients?.length || 0), 0)}
                  </span>
                </div>
                <div className="bg-[#0C0C0C] p-3 rounded-xl border border-white/5">
                  <span className="text-[10px] text-gray-500 block uppercase">Wikilinks</span>
                  <span className="text-lg font-mono font-bold text-white">
                    {recipes.reduce((acc, r) => acc + (r.wikilinks?.length || 0), 0)}
                  </span>
                </div>
                <div className="bg-[#0C0C0C] p-3 rounded-xl border border-white/5">
                  <span className="text-[10px] text-gray-500 block uppercase">Callouts</span>
                  <span className="text-lg font-mono font-bold text-white">
                    {recipes.reduce((acc, r) => acc + (r.callouts?.length || 0), 0)}
                  </span>
                </div>
              </div>

              {/* Recipe List preview */}
              <div className="bg-[#0C0C0C] rounded-xl border border-white/5 p-3 space-y-2">
                <h4 className="text-xs font-bold text-gray-300 uppercase tracking-wider pb-1 border-b border-white/5 flex items-center justify-between">
                  <span>Current Notes in Vault</span>
                  <span className="text-[10px] text-gray-500 font-normal">{recipes.length} files</span>
                </h4>
                <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                  {recipes.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-white/5 text-gray-300"
                    >
                      <span className="truncate font-mono">{r.fileName}</span>
                      <span className="text-[10px] text-amber-400 shrink-0 font-sans ml-2">
                        {r.cuisine} • {r.cookTime}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
                <button
                  type="button"
                  onClick={handleExportAllMarkdown}
                  className="flex-1 py-2 px-3 bg-white/5 hover:bg-white/10 text-gray-200 border border-white/10 rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5 text-amber-400" />
                  <span>Export All .md Files</span>
                </button>

                <button
                  type="button"
                  onClick={handleRestoreStarterVault}
                  className="py-2 px-3 bg-white/5 hover:bg-white/10 text-gray-300 border border-white/10 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5"
                  title="Reload default 8 rich gourmet starter recipes"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                  <span>Restore Starter Vault</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-white/5 bg-[#0F0F0F] flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-gray-400 truncate max-w-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
            <span className="truncate font-mono text-[11px]">{vaultStatus.vaultPath}</span>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-xl text-xs font-semibold transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
