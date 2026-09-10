import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  ObsidianRecipe,
  VaultSyncStatus,
  FilterState,
  ActiveTimer,
  MealPlanDay,
  MealPlanSlot,
  ShoppingCategoryGroup,
  ThemeId,
  VaultNote,
  RecipeNutrition,
} from './types';
import { DEFAULT_VAULT_PATH, getStarterVaultRecipes, getStarterVaultNotes, STARTER_MEAL_PLAN, STARTER_SHOPPING_CATEGORIES } from './data/starterVault';
import { getRecipeImage } from './utils/imageHelper';
import { cleanRecipeTitle, parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from './utils/markdownParser';
import {
  pickVaultDirectory,
  saveRecipeToVaultFile,
  parseUploadedFileList,
  parseDroppedFilesAndFolders,
  getDirectoryHandleFromIDB,
  saveDirectoryHandleToIDB,
  clearDirectoryHandleFromIDB,
  isFileSystemAccessSupported,
  scanVaultAssetsFromHandle,
} from './utils/vaultFileSystem';
import {
  createAppServices,
  loadVaultContent,
  saveRecipeWithVaultAdapter,
  deleteRecipeWithVaultAdapter,
  saveMealPlanWithVaultAdapter,
  saveShoppingListWithVaultAdapter,
  vaultErrorMessage,
  mergeHydratedSetting,
  createTimer,
  reconcileTimer,
  reconcileTimers,
  pauseTimer,
  resumeTimer,
  migrateLegacyTimer,
  upsertTimer,
} from './application';
import {
  createBrowserSettingsAdapter,
  createBrowserNetworkAdapter,
  createBrowserVaultAdapter,
  createBrowserAssetAdapter,
  createBrowserSecretAdapter,
  browserRemoteImageDownloader,
  fetchRecipeImagePreviewBytes,
} from './platform/browser';
import {
  createVaultSessionId,
  type RecipeImageRecoverySupport,
} from './application/recipeImageRecovery';
import { saveGeneratedRecipeImageToVault, hashCanonicalMarkdown, type GeneratedImageSaveResult } from './application/recipeImageSave';
import { hydrateAiSelections } from './application/aiSelection';
import { playTimerChime } from './utils/audioAlert';
import { APP_VERSION } from './version';
import ProviderSettings from './application-ui/ProviderSettings';
import { CreateForMeModal } from './components/CreateForMeModal';
import { saveGeneratedRecipeToVault, GeneratedRecipePathCollisionError } from './application/createForMe';
import {
  sameCanonicalRecipeIdentity,
  reconcileActiveRecipe,
  upsertCanonicalRecipe,
  removeCanonicalRecipe,
  deriveVaultSnapshotState,
  createScanGenerationGuard,
  applyAcceptedVaultSnapshot,
} from './core/recipeIdentity';

import { VaultHeader } from './components/VaultHeader';
import { RecipeFilterBar } from './components/RecipeFilterBar';
import { RecipeCard } from './components/RecipeCard';
import { RecipeDetailView } from './components/RecipeDetailView';
import { DataviewTableView } from './components/DataviewTableView';
import { MealPlannerView } from './components/MealPlannerView';
import { ShoppingListView } from './components/ShoppingListView';
import { ThemesView } from './components/ThemesView';
import { ActiveTimersBar } from './components/ActiveTimersBar';
import { ConnectVaultModal } from './components/ConnectVaultModal';
import { RecipeGrabberModal } from './components/RecipeGrabberModal';
import { VaultIntelligenceModal } from './components/VaultIntelligenceModal';
import { AskMyKitchenModal } from './components/AskMyKitchenModal';
import { summarizeVaultHealth } from './utils/vaultIntelligence';

// Cooking Mode and the Recipe Editor are modal-heavy views only opened on
// demand. Lazy-load them so their code ships in separate chunks and is fetched
// when the user actually enters cooking mode or edits a recipe.
const CookingModeModal = React.lazy(() =>
  import('./components/CookingModeModal').then((m) => ({ default: m.CookingModeModal }))
);
const RecipeEditorModal = React.lazy(() =>
  import('./components/RecipeEditorModal').then((m) => ({ default: m.RecipeEditorModal }))
);

const INITIAL_FILTERS: FilterState = {
  search: '',
  tag: null,
  category: null,
  cuisine: null,
  difficulty: null,
  maxCookTime: null,
  minRating: null,
  ingredientSearch: '',
  onlyFavorites: false,
  sortBy: 'title',
  sortOrder: 'asc',
};

/** Logs a redacted SettingsAdapter write failure (never logs payload/secrets). */
function warnPersist(label: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
  console.warn(`Failed to persist ${label}:`, detail);
}

interface LoadedVaultData {
  recipes: ObsidianRecipe[];
  notes: VaultNote[];
  mealPlan?: MealPlanDay[];
  shoppingList?: ShoppingCategoryGroup[];
  folderName: string;
}

/**
 * Reads a connected vault handle through the application VaultAdapter
 * orchestration, then runs the legacy ASSET-ONLY pass (images) as a second,
 * separate pass. This is the bootstrap-edge composition: Markdown data comes
 * from the adapter; images/assets stay on the legacy `scanVaultAssetsFromHandle`
 * path. Exactly ONE Markdown scan per load (no `scanVaultDirectory` double scan).
 */
async function loadVaultFromHandle(handle: any): Promise<LoadedVaultData> {
  const vault = createBrowserVaultAdapter(handle);
  const scan = await loadVaultContent(vault, () =>
    scanVaultAssetsFromHandle(handle).catch((err) =>
      console.warn('Background vault asset scan failed:', err)
    )
  );
  return {
    recipes: scan.recipes,
    notes: scan.notes,
    mealPlan: scan.mealPlan,
    shoppingList: scan.shoppingList,
    folderName: (handle && typeof handle.name === 'string') ? handle.name : '',
  };
}

export default function App() {
  // 1. Vault Recipes State (Canonical Source: In-Memory working state hydrated from Obsidian vault files)
  const [recipes, setRecipes] = useState<ObsidianRecipe[]>(() => {
    return getStarterVaultRecipes();
  });

  // Vault Notes State (Non-recipe notes in the Obsidian vault, like ingredients, techniques, wine guides)
  const [notes, setNotes] = useState<VaultNote[]>(() => {
    return [];
  });

  // Vault Sync Status
  const [vaultStatus, setVaultStatus] = useState<VaultSyncStatus>({
    isConnected: false,
    vaultPath: DEFAULT_VAULT_PATH,
    fileCount: 8,
    accessType: 'starter_vault',
  });

  // Non-vault browser adapters (always available, independent of vault connection).
  // Created once per App mount (local composition, NOT module-global/singleton).
  // Browser adapters are constructed through the platform/browser composition
  // module (the single place that news up concrete browser adapters; Phase 4D3C).
  // Settings/network are independent of a vault connection (built once); the
  // vault adapter is only constructible once a directory handle is connected.
  const settingsAdapter = useMemo(() => createBrowserSettingsAdapter(), []);
  const networkAdapter = useMemo(() => createBrowserNetworkAdapter(), []);
  // The browser shell truthfully exposes NO provider-secret storage (read-only,
  // `supportsWrites() === false`). No provider key is ever persisted client-side.
  const secretAdapter = useMemo(() => createBrowserSecretAdapter(), []);

  // Application service composition (Phase 4C3B/4D2A). Constructed from the SAME
  // authoritative FSA handle stored in vaultStatus — no second picker, no extra
  // IndexedDB record, no module-global singleton. Memoized per-handle so it is
  // recreated only when the vault handle actually changes.
  const vaultServices = useMemo(() => {
    if (!vaultStatus.folderHandle) return null;
    const vault = createBrowserVaultAdapter(vaultStatus.folderHandle);
    return createAppServices({ vault, settings: settingsAdapter, network: networkAdapter, secret: secretAdapter });
  }, [vaultStatus.folderHandle, settingsAdapter, networkAdapter, secretAdapter]);
  const vaultAdapter = vaultServices?.adapters.vault ?? null;

  // Asset save dependencies, supplied BY the browser shell: the binary storage
  // boundary (BrowserAssetAdapter) + the fixed-purpose remote image downloader.
  // The components receive this as a plain dependency object (they never import a
  // platform/browser module); shared vaultAssets code no longer imports platform.
  const imageService = useMemo(() => {
    const folderHandle = vaultStatus.folderHandle;
    return {
      folderHandle,
      asset: folderHandle ? createBrowserAssetAdapter(folderHandle) : undefined,
      downloadRemoteImage: browserRemoteImageDownloader,
    };
  }, [vaultStatus.folderHandle]);

  // Vault Intelligence Image Recovery support (v0.7 Phase 2B). Built ONLY for a
  // connected, WRITABLE (File System Access) vault with an AssetAdapter and an
  // explicit vault session id — the capability gate for the Generate Image
  // action. Surfaces without full support (Obsidian plugin, starter vault,
  // uploaded folder) get a truthful unavailable reason instead of fake support.
  const vaultSessionId = useMemo(() => {
    return vaultStatus.folderHandle ? createVaultSessionId() : '';
  }, [vaultStatus.folderHandle]);

  const recipeImageRecoverySupport = useMemo((): RecipeImageRecoverySupport | undefined => {
    const folderHandle = vaultStatus.folderHandle;
    if (!folderHandle || vaultStatus.accessType !== 'filesystem_api' || !vaultSessionId) return undefined;
    const asset = createBrowserAssetAdapter(folderHandle);
    const vault = createBrowserVaultAdapter(folderHandle);
    return {
      vaultSessionId,
      asset,
      computeContentHash: (recipe) => hashCanonicalMarkdown(recipe.rawMarkdown || ''),
      saveImage: async ({ recipePath, recipeTitle, token, activeVaultSessionId, preview }) => {
        // Trusted preview source: bytes via the authenticated preview endpoint,
        // metadata from the server-originated generation response (UI state).
        const previewSource = {
          resolvePreview: async (resolvedToken: string) => {
            if (resolvedToken !== token) return undefined;
            const bytes = await fetchRecipeImagePreviewBytes(token);
            if (!bytes) return undefined;
            return {
              token,
              bytes,
              contentType: preview.contentType,
              provider: preview.provider,
              model: preview.model,
              recipeContentHash: preview.recipeContentHash,
              vaultSessionId: preview.vaultSessionId,
            };
          },
        };
        return saveGeneratedRecipeImageToVault(
          { vault, asset, previewSource },
          { recipePath, recipeTitle, token, activeVaultSessionId, approved: true }
        );
      },
    };
  }, [vaultStatus.folderHandle, vaultStatus.accessType, vaultSessionId]);

  const imageRecoveryUnavailableReason = recipeImageRecoverySupport
    ? undefined
    : vaultStatus.isConnected && vaultStatus.accessType === 'filesystem_api'
      ? 'Image recovery needs a writable vault connection.'
      : 'Image recovery is available in the browser app with a writable connected vault.';

  // Lightweight user-facing error surface for adapter save/delete failures
  // (no new notification framework — reuses the inline-alert UX pattern).
  const [vaultError, setVaultError] = useState<string | null>(null);
  const reportVaultError = (operation: 'save' | 'delete', label: string, err: unknown) => {
    console.warn(`Vault ${operation} "${label}" failed:`, err);
    setVaultError(vaultErrorMessage(operation, label, err));
  };
  const clearVaultError = () => setVaultError(null);

  // Theme State (persisted via SettingsAdapter; hydrated on mount)
  const [theme, setTheme] = useState<ThemeId>('obsidian');

  // Navigation & View State (persisted via SettingsAdapter; hydrated on mount)
  const [activeTab, setActiveTab] = useState<'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers'>('grid');

  const [selectedRecipe, setSelectedRecipe] = useState<ObsidianRecipe | null>(null);
  const [cookingRecipe, setCookingRecipe] = useState<{ recipe: ObsidianRecipe; servings: number } | null>(null);

  // Modals
  const [isConnectVaultOpen, setIsConnectVaultOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isCreateForMeOpen, setIsCreateForMeOpen] = useState(false);
  const [isGrabberOpen, setIsGrabberOpen] = useState(false);
  const [isVaultIntelligenceOpen, setIsVaultIntelligenceOpen] = useState(false);
  const [isAskMyKitchenOpen, setIsAskMyKitchenOpen] = useState(false);
  const [vaultIntelligenceRecipeId, setVaultIntelligenceRecipeId] = useState<string | null>(null);
  const [editingRecipe, setEditingRecipe] = useState<ObsidianRecipe | null>(null);
  const [isWindowDragging, setIsWindowDragging] = useState(false);
  const [grabberInitialUrl, setGrabberInitialUrl] = useState('');

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  // Active Timers (persisted via SettingsAdapter; hydrated on mount)
  const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>([]);

  // Meal Plan & Shopping List (Canonical Source: Vault Notes `Meal Plan.md` & `Shopping List.md`)
  const [mealPlan, setMealPlan] = useState<MealPlanDay[]>(STARTER_MEAL_PLAN);
  const [shoppingCategories, setShoppingCategories] = useState<ShoppingCategoryGroup[]>(STARTER_SHOPPING_CATEGORIES);

  // Canonical vault integrity (Phase 2A prerequisite).
  //  - `vaultScanGeneration` is a monotonic counter: each canonical scan snapshot
  //    is tagged with the generation active when it STARTED; a scan only applies its
  //    result if its generation is STILL current, so a slow old scan can never
  //    overwrite a newer vault connection/scan (defect E).
  //  - `vaultHydrated` gates the meal-plan/shopping autosave effects so they never
  //    write the PREVIOUS vault's state into a newly connected vault (defect F).
  const vaultScanGeneration = useRef(createScanGenerationGuard());
  const [vaultHydrated, setVaultHydrated] = useState(true);
  // Tracks the CURRENT active canonical references so a snapshot commit reconciles
  // them against the latest committed state (avoids closing over stale values).
  const activeRefs = useRef({ selectedRecipe: null as ObsidianRecipe | null, cookingRecipe: null as { recipe: ObsidianRecipe; servings: number } | null, editingRecipe: null as ObsidianRecipe | null });
  useEffect(() => {
    activeRefs.current = { selectedRecipe, cookingRecipe, editingRecipe };
  }, [selectedRecipe, cookingRecipe, editingRecipe]);

  // Applies a SUCCESSFUL canonical vault snapshot. It is authoritative: a successful
  // empty scan replaces recipes/notes with [] (defect A), absence of Meal Plan.md /
  // Shopping List.md means empty state (defect F/V), and active canonical references
  // (selected/cooking/editing) are reconciled against the fresh snapshot (defect D).
  // A stale (older-generation) result is ignored (defect E). Returns true only when
  // the snapshot was actually accepted as the current generation.
  const commitVaultSnapshot = useCallback((result: LoadedVaultData, generation: number, folderHandle?: any) => {
    if (!vaultScanGeneration.current.isCurrent(generation)) return false;
    const next = deriveVaultSnapshotState(result, activeRefs.current);
    setRecipes(next.recipes);
    setNotes(next.notes);
    setMealPlan(next.mealPlan);
    setShoppingCategories(next.shoppingList);
    setSelectedRecipe(next.selectedRecipe);
    setCookingRecipe(next.cookingRecipe);
    setEditingRecipe(next.editingRecipe);
    setVaultStatus((s) => ({
      ...s,
      isConnected: true,
      accessType: 'filesystem_api',
      vaultPath: result.folderName ? `Vault / ${result.folderName}` : s.vaultPath,
      fileCount: result.recipes.length + result.notes.length,
      folderHandle: folderHandle ?? s.folderHandle,
    }));
    setVaultHydrated(true);
    return true;
  }, []);

  // In-memory canonical state update AFTER a successful image save (the vault
  // write itself already happened inside the save flow — never re-written here).
  const handleRecipeImageSaved = useCallback((recipeId: string, imagePath: string) => {
    setRecipes((prev) =>
      prev.map((r) => (r.id === recipeId ? { ...r, image: imagePath } : r))
    );
    setSelectedRecipe((prev) => (prev && prev.id === recipeId ? { ...prev, image: imagePath } : prev));
  }, []);

  // Update document title with version
  useEffect(() => {
    document.title = `The Kitchen Codex ${APP_VERSION} — Obsidian Culinary Vault`;
  }, []);

  // 1. Reconnect to IndexedDB directory handle on mount if permission granted
  useEffect(() => {
    let isMounted = true;
    async function restoreVaultConnection() {
      try {
        const handle = await getDirectoryHandleFromIDB();
        if (handle && typeof handle.queryPermission === 'function') {
          const status = await handle.queryPermission({ mode: 'readwrite' });
          if (status === 'granted') {
            const generation = vaultScanGeneration.current.begin();
            const result = await loadVaultFromHandle(handle);
            if (isMounted) {
              commitVaultSnapshot(result, generation, handle);
            }
          }
        }
      } catch (err) {
        console.warn('Auto-reconnect vault check:', err);
      }
    }
    restoreVaultConnection();
    return () => {
      isMounted = false;
    };
  }, []);

  // 2. Background Re-Sync on Window Focus: Live updates from Obsidian desktop
  useEffect(() => {
    const handleWindowFocus = async () => {
      if (vaultStatus.isConnected && vaultStatus.folderHandle && vaultStatus.accessType === 'filesystem_api') {
        try {
          const generation = vaultScanGeneration.current.begin();
          const result = await loadVaultFromHandle(vaultStatus.folderHandle);
          commitVaultSnapshot(result, generation, vaultStatus.folderHandle);
        } catch (err) {
          console.warn('Background vault scan on focus failed:', err);
        }
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [vaultStatus]);

  // Hydrate persisted UI preferences from the SettingsAdapter once after mount.
  // The adapter is async, so stored values are applied asynchronously. To avoid
  // a startup race (user changes a value BEFORE hydration completes), hydration
  // NEVER overwrites a value the user already changed away from its default;
  // and persist effects are gated on `settingsHydrated` so defaults are never
  // written over stored preferences before hydration. `settingsHydrated` is a
  // STATE so persist effects re-run (and flush any pending user change) when it
  // flips to true.
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [savedTheme, savedTab, savedTimers] = await Promise.all([
          settingsAdapter.get<ThemeId>('obsidian_vault_theme'),
          settingsAdapter.get<'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers'>('obsidian_active_tab'),
          settingsAdapter.get<ActiveTimer[]>('obsidian_active_cooking_timers'),
        ]);
        if (cancelled) return;
        setTheme((cur) =>
          mergeHydratedSetting(
            cur,
            savedTheme,
            (t) => t === 'obsidian',
            (t) => t === 'obsidian' || t === 'parchment' || t === 'nordic'
          )
        );
        setActiveTab((cur) =>
          mergeHydratedSetting(
            cur,
            savedTab,
            (t) => t === 'grid',
            (t) => t === 'grid' || t === 'dataview' || t === 'mealplan' || t === 'shopping' || t === 'themes' || t === 'providers'
          )
        );
        // Timers: default is an empty list. Only apply a persisted timer list if
        // the user has not already started a timer (which would make it non-empty).
        // Persisted timers are migrated (legacy -> endsAt) and reconciled against
        // the wall clock so elapsed time while the app was closed is accounted for.
        setActiveTimers((cur) => {
          const now = Date.now();
          const migrated = (Array.isArray(savedTimers) ? savedTimers : [])
            .map((t) => migrateLegacyTimer(t, now))
            .map((t) => reconcileTimer(t, now).timer);
          return mergeHydratedSetting(cur, migrated, (t) => Array.isArray(t) && t.length === 0, (t) => Array.isArray(t));
        });
      } catch (err) {
        console.warn('Failed to hydrate persisted settings:', err);
      } finally {
        if (!cancelled) setSettingsHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsAdapter]);

  // 2b. CENTRAL APPLICATION BOOTSTRAP — hydrate AI provider/model selection
  // preferences BEFORE any AI feature can execute. This is deliberately NOT a
  // UI-panel side effect (ProviderSettings may never be opened). The application
  // selection layer fails closed while hydration is pending and after a settings
  // read error, so there is NO server-default routing window.
  useEffect(() => {
    let cancelled = false;
    hydrateAiSelections(settingsAdapter).catch((err) => {
      if (!cancelled) {
        console.warn(
          'Failed to hydrate AI provider selections:',
          err instanceof Error ? err.message : 'unknown error'
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settingsAdapter]);

  // 3. UI Preferences to the SettingsAdapter (localStorage-backed)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if (settingsHydrated) {
      settingsAdapter.set('obsidian_vault_theme', theme).catch((err) => warnPersist('theme', err));
    }
  }, [theme, settingsAdapter, settingsHydrated]);

  useEffect(() => {
    if (settingsHydrated) {
      settingsAdapter.set('obsidian_active_tab', activeTab).catch((err) => warnPersist('active tab', err));
    }
  }, [activeTab, settingsAdapter, settingsHydrated]);

  useEffect(() => {
    if (settingsHydrated) {
      settingsAdapter.set('obsidian_active_cooking_timers', activeTimers).catch((err) => warnPersist('active cooking timers', err));
    }
  }, [activeTimers, settingsAdapter, settingsHydrated]);

  // 4. Auto-save Meal Plan note to the vault through the adapter if connected.
  //    Gated on `vaultHydrated` so a newly connected vault only receives its OWN
  //    (already-scanned) plan, never the previous vault's plan (defect F).
  useEffect(() => {
    if (vaultAdapter && vaultHydrated) {
      saveMealPlanWithVaultAdapter(vaultAdapter, mealPlan).catch((e) =>
        reportVaultError('save', 'Meal Plan', e)
      );
    }
  }, [mealPlan, vaultAdapter, vaultHydrated]);

  // 5. Auto-save Shopping List note to the vault through the adapter if connected.
  useEffect(() => {
    if (vaultAdapter && vaultHydrated) {
      saveShoppingListWithVaultAdapter(vaultAdapter, shoppingCategories).catch((e) =>
        reportVaultError('save', 'Shopping List', e)
      );
    }
  }, [shoppingCategories, vaultAdapter, vaultHydrated]);

  // Timers Background Interval Engine — refreshes display state once per second.
  // The authoritative clock is `endsAt`; reconciliation (not blind decrement)
  // accounts for browser throttling, suspended tabs, sleep, and time while closed.
  useEffect(() => {
    const timerInterval = setInterval(() => {
      setActiveTimers((prevTimers) => {
        if (prevTimers.length === 0) return prevTimers;
        const { timers: updated, completed } = reconcileTimers(prevTimers, Date.now());
        for (let i = 0; i < completed; i += 1) {
          playTimerChime();
        }
        return updated;
      });
    }, 1000);

    return () => clearInterval(timerInterval);
  }, []);

  // Connect local folder via File System Access API
  const handleDirectVaultConnected = async (folderHandle: any): Promise<{ recipeCount: number; noteCount: number }> => {
    // Invalidate prior in-flight scans and gate autosave (defect E + F): old-vault
    // meal-plan/shopping state must not be written into the newly connected vault.
    const generation = vaultScanGeneration.current.begin();
    setVaultHydrated(false);
    const result = await loadVaultFromHandle(folderHandle);
    // Persist the handle as the active vault ONLY after it was successfully scanned
    // and accepted as the current-generation canonical snapshot; a stale/superseded
    // (or failed) scan is never persisted. saveDirectoryHandleToIDB is best-effort
    // (IDB failures log a warning and do not fail the connection).
    await applyAcceptedVaultSnapshot(
      vaultScanGeneration.current,
      generation,
      () => commitVaultSnapshot(result, generation, folderHandle),
      () => saveDirectoryHandleToIDB(folderHandle)
    );
    return { recipeCount: result.recipes.length, noteCount: result.notes.length };
  };

  // Legacy dead-code connect entrypoint, kept consistent with the adapter flow.
  const handleConnectVault = async () => {
    try {
      const { folderHandle } = await pickVaultDirectory();
      if (folderHandle) await handleDirectVaultConnected(folderHandle);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        alert(err.message || 'Could not connect to Obsidian vault folder.');
      }
    }
  };

  // Upload folder fallback
  const handleUploadFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    try {
      const parsed = await parseUploadedFileList(e.target.files);
      if (parsed.recipes.length > 0) {
        setRecipes(parsed.recipes);
      }
      if (parsed.notes && parsed.notes.length > 0) {
        setNotes(parsed.notes);
      }
      if (parsed.mealPlan) setMealPlan(parsed.mealPlan);
      if (parsed.shoppingList) setShoppingCategories(parsed.shoppingList);

      if (parsed.recipes.length > 0 || parsed.mealPlan || parsed.shoppingList || (parsed.notes && parsed.notes.length > 0)) {
        setVaultStatus((prev) => ({
          ...prev,
          isConnected: true,
          fileCount: parsed.recipes.length + (parsed.notes?.length || 0),
          accessType: 'uploaded_folder',
        }));
      }
    } catch (err) {
      console.error('Failed to import files:', err);
    }
  };

  // Save / Update Recipe
  const handleSaveRecipe = async (savedRecipe: ObsidianRecipe) => {
    // Write FIRST: Obsidian Markdown is the canonical source of truth. React state is
    // only updated AFTER the canonical write succeeds, so a failed write leaves the
    // prior canonical state (and the open editor) intact (defect C).
    try {
      if (vaultAdapter) {
        await saveRecipeWithVaultAdapter(vaultAdapter, savedRecipe);
      } else {
        // Disconnected workflow: preserve the existing download-to-disk fallback.
        await saveRecipeToVaultFile(savedRecipe, undefined);
      }
    } catch (err) {
      // Surface the failure; do NOT claim persistence succeeded (editor stays open).
      reportVaultError('save', savedRecipe.title || 'recipe', err);
      throw err;
    }
    // Commit state from the successfully written/serialized canonical object, matched
    // by canonical vault-path identity (never basename) (defect B).
    setRecipes((prev) => upsertCanonicalRecipe(prev, savedRecipe));
    setSelectedRecipe((prev) => (prev && sameCanonicalRecipeIdentity(prev, savedRecipe) ? savedRecipe : prev));
    setIsEditorOpen(false);
    setEditingRecipe(null);
  };

  // Create for Me save (generated-save scoped). A same-title file is NEVER
  // overwritten: on a collision this throws GeneratedRecipePathCollisionError
  // before any write, so the modal keeps the draft open with a bounded message.
  const handleSaveGeneratedRecipe = async (recipe: ObsidianRecipe) => {
    try {
      if (vaultAdapter) {
        await saveGeneratedRecipeToVault(vaultAdapter, recipe);
      } else {
        // Disconnected: no vault exists()-check support; preserve the download-to-disk
        // fallback for this generated draft (out of collision-safety scope).
        await saveRecipeToVaultFile(recipe, undefined);
      }
    } catch (err) {
      if (err instanceof GeneratedRecipePathCollisionError) {
        throw err; // let the modal surface the collision message and keep edits
      }
      reportVaultError('save', recipe.title || 'recipe', err);
      throw err;
    }
    // Insert/update by canonical vault-path identity (never basename), so a root
    // `Dish.md` can never replace `B/Dish.md` on a basename match.
    setRecipes((prev) => upsertCanonicalRecipe(prev, recipe));
    setIsCreateForMeOpen(false);
  };

  // Update Nutrition on a recipe and save to Obsidian Markdown frontmatter
  const handleUpdateNutrition = async (recipe: ObsidianRecipe, nutrition: RecipeNutrition) => {
    const updatedRecipe: ObsidianRecipe = {
      ...recipe,
      nutrition,
      calories: nutrition.calories !== undefined ? nutrition.calories.toString() : recipe.calories,
    };
    updatedRecipe.rawMarkdown = serializeRecipeToObsidianMarkdown(updatedRecipe);

    // Write FIRST then commit state (defect C): a failed canonical write must not
    // mutate the displayed canonical recipe.
    if (vaultAdapter) {
      try {
        await saveRecipeWithVaultAdapter(vaultAdapter, updatedRecipe);
      } catch (err) {
        reportVaultError('save', updatedRecipe.title || 'recipe', err);
        return;
      }
    }
    setRecipes((prev) => upsertCanonicalRecipe(prev, updatedRecipe));
    setSelectedRecipe((prev) => (prev && sameCanonicalRecipeIdentity(prev, updatedRecipe) ? updatedRecipe : prev));
  };

  // Save or Create a Vault Note (e.g. ingredient or technique created from wikilink modal)
  const handleSaveNoteToVault = async (note: VaultNote) => {
    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === note.id || n.fileName.toLowerCase() === note.fileName.toLowerCase());
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = note;
        return next;
      }
      return [note, ...prev];
    });

    if (vaultStatus.folderHandle) {
      try {
        const fileName = note.fileName.endsWith('.md') ? note.fileName : `${note.fileName}.md`;
        let targetDir = vaultStatus.folderHandle;
        try {
          targetDir = await vaultStatus.folderHandle.getDirectoryHandle('Notes', { create: true });
        } catch (e) {
          targetDir = vaultStatus.folderHandle;
        }
        const fileHandle = await targetDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(note.rawMarkdown);
        await writable.close();
      } catch (err) {
        console.warn('Could not write note to vault filesystem:', err);
      }
    }
  };

  // Delete Recipe
  const handleDeleteRecipe = async (recipeToDelete: ObsidianRecipe) => {
    // Write FIRST: only remove from state after the vault delete succeeds (defect C).
    if (vaultAdapter) {
      try {
        await deleteRecipeWithVaultAdapter(vaultAdapter, recipeToDelete);
      } catch (err) {
        // The disk delete failed: do NOT claim it was deleted. Keep prior state.
        reportVaultError('delete', recipeToDelete.title || 'recipe', err);
        return;
      }
    }
    // Remove by canonical vault-path identity, never basename (defect B).
    setRecipes((prev) => removeCanonicalRecipe(prev, recipeToDelete));
    setSelectedRecipe((prev) => (prev && sameCanonicalRecipeIdentity(prev, recipeToDelete) ? null : prev));
    setCookingRecipe((prev) => (prev && sameCanonicalRecipeIdentity(prev.recipe, recipeToDelete) ? null : prev));
  };

  // Start Cooking Mode
  const handleStartCooking = (recipe: ObsidianRecipe, servings?: number) => {
    setCookingRecipe({
      recipe,
      servings: servings || recipe.servings || 4,
    });
  };

  // Add Timer — single global entry point used by Recipe Detail, Cooking Mode,
  // and the custom timer UI. `semanticKey` (from Cooking Mode) makes a repeat
  // start RESTART/REPLACE the same step timer instead of duplicating it.
  const handleStartTimer = (recipeTitle: string, minutes: number, label: string, semanticKey?: string) => {
    const now = Date.now();
    const totalSecs = Math.round(minutes * 60);
    const newTimer = createTimer(
      {
        id: `${now}-${Math.random()}`,
        recipeTitle,
        label,
        totalSeconds: totalSecs,
        createdAt: now,
        semanticKey,
      },
      now
    );
    setActiveTimers((prev) => upsertTimer(prev, newTimer, semanticKey));
  };

  const handleToggleTimer = (id: string) => {
    setActiveTimers((prev) =>
      prev.map((t) => (t.id === id ? (t.isRunning ? pauseTimer(t, Date.now()) : resumeTimer(t, Date.now())) : t))
    );
  };

  const handleDeleteTimer = (id: string) => {
    setActiveTimers((prev) => prev.filter((t) => t.id !== id));
  };

  const handleAddCustomTimer = () => {
    const minStr = prompt('Enter timer duration in minutes:', '10');
    if (!minStr) return;
    const mins = parseFloat(minStr);
    if (!isNaN(mins) && mins > 0) {
      handleStartTimer('Kitchen Timer', mins, `${mins} min timer`);
    }
  };

  // Toggle Favorite
  const handleToggleFavorite = (recipeId: string) => {
    setRecipes((prev) =>
      prev.map((r) => (r.id === recipeId ? { ...r, isFavorite: !r.isFavorite } : r))
    );
    if (selectedRecipe && selectedRecipe.id === recipeId) {
      setSelectedRecipe((prev) => (prev ? { ...prev, isFavorite: !prev.isFavorite } : null));
    }
  };

  // Filter by Wikilink
  const handleFilterByWikilink = (wikilink: string) => {
    setSearchQuery(wikilink);
    setSelectedRecipe(null);
    setActiveTab('grid');
  };

  // Shopping List & Meal Plan synchronization helper
  const generateShoppingFromMealPlan = (
    plan: MealPlanDay[],
    recipesList: ObsidianRecipe[],
    previousCategories: ShoppingCategoryGroup[] = []
  ): ShoppingCategoryGroup[] => {
    const totalMeals = plan.reduce(
      (acc, d) =>
        acc +
        (d.breakfast?.recipeTitle ? 1 : 0) +
        (d.lunch?.recipeTitle ? 1 : 0) +
        (d.dinner?.recipeTitle ? 1 : 0),
      0
    );

    // If meal plan is empty, shopping list is empty!
    if (totalMeals === 0) {
      return [];
    }

    // Preserve previously checked states
    const checkedMap = new Map<string, boolean>();
    previousCategories.forEach((group) => {
      group.items.forEach((item) => {
        if (item.isChecked) {
          checkedMap.set(`${group.category}::${item.text}`, true);
        }
      });
    });

    const groups: ShoppingCategoryGroup[] = [];

    plan.forEach((day) => {
      const slots: { type: 'Breakfast' | 'Lunch' | 'Dinner'; slot?: MealPlanSlot }[] = [
        { type: 'Breakfast', slot: day.breakfast },
        { type: 'Lunch', slot: day.lunch },
        { type: 'Dinner', slot: day.dinner },
      ];

      slots.forEach(({ type, slot }) => {
        if (!slot?.recipeTitle) return;

        const matchingRecipe = recipesList.find(
          (r) =>
            (slot.recipeId && r.id === slot.recipeId) ||
            r.title.toLowerCase() === slot.recipeTitle.toLowerCase()
        );

        if (matchingRecipe && matchingRecipe.ingredients.length > 0) {
          const categoryName = `${day.dayName} ${type}: ${matchingRecipe.title}`;
          groups.push({
            category: categoryName,
            items: matchingRecipe.ingredients.map((ing, idx) => {
              const cleanText = ing.original.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim() || ing.name;
              const key = `${categoryName}::${cleanText}`;
              return {
                id: `${day.dayName}-${type}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
                text: cleanText,
                recipeSources: [`${day.dayName} ${type}`],
                isChecked: !!checkedMap.get(key),
              };
            }),
          });
        }
      });
    });

    return groups;
  };

  // Meal Plan Handlers
  const handleSelectSlotRecipe = (
    dayIndex: number,
    mealType: 'breakfast' | 'lunch' | 'dinner',
    recipe: ObsidianRecipe
  ) => {
    setMealPlan((prev) => {
      const next = [...prev];
      next[dayIndex] = {
        ...next[dayIndex],
        [mealType]: {
          recipeId: recipe.id,
          recipeTitle: recipe.title,
        },
      };
      setShoppingCategories((prevShop) =>
        generateShoppingFromMealPlan(next, recipes, prevShop)
      );
      return next;
    });
  };

  const handleRemoveSlotRecipe = (
    dayIndex: number,
    mealType: 'breakfast' | 'lunch' | 'dinner'
  ) => {
    setMealPlan((prev) => {
      const next = [...prev];
      next[dayIndex] = {
        ...next[dayIndex],
        [mealType]: undefined,
      };
      setShoppingCategories((prevShop) =>
        generateShoppingFromMealPlan(next, recipes, prevShop)
      );
      return next;
    });
  };

  const handleResetMealPlan = () => {
    const emptyPlan: MealPlanDay[] = [
      { dayName: 'Monday' },
      { dayName: 'Tuesday' },
      { dayName: 'Wednesday' },
      { dayName: 'Thursday' },
      { dayName: 'Friday' },
      { dayName: 'Saturday' },
      { dayName: 'Sunday' },
    ];
    setMealPlan(emptyPlan);
    setShoppingCategories([]);
  };

  const handleAddToMealPlan = (r: ObsidianRecipe) => {
    setMealPlan((prev) => {
      const next = [...prev];
      const firstEmpty = next.find((d) => !d.dinner?.recipeTitle) || next.find((d) => !d.lunch?.recipeTitle) || next[0];
      if (!firstEmpty.dinner?.recipeTitle) {
        firstEmpty.dinner = { recipeId: r.id, recipeTitle: r.title };
      } else if (!firstEmpty.lunch?.recipeTitle) {
        firstEmpty.lunch = { recipeId: r.id, recipeTitle: r.title };
      } else {
        firstEmpty.breakfast = { recipeId: r.id, recipeTitle: r.title };
      }
      setShoppingCategories((prevShop) =>
        generateShoppingFromMealPlan(next, recipes, prevShop)
      );
      return next;
    });
    setActiveTab('mealplan');
  };

  const handleGenerateWeeklyShoppingList = () => {
    setShoppingCategories((prevShop) =>
      generateShoppingFromMealPlan(mealPlan, recipes, prevShop)
    );
    setActiveTab('shopping');
  };

  // Shopping List helpers
  const handleAddToShoppingList = (recipe: ObsidianRecipe, ingredientStrings: string[]) => {
    setShoppingCategories((prev) => {
      const categoryName = `Recipe: ${recipe.title}`;
      const newItems = ingredientStrings.map((text, idx) => {
        const cleanText = text.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
        return {
          id: `${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
          text: cleanText || text,
          recipeSources: [recipe.title],
          isChecked: false,
        };
      });

      const existingIndex = prev.findIndex((g) => g.category === categoryName);
      if (existingIndex >= 0) {
        const next = [...prev];
        next[existingIndex] = {
          ...next[existingIndex],
          items: [...next[existingIndex].items, ...newItems],
        };
        return next;
      }

      return [
        ...prev,
        {
          category: categoryName,
          items: newItems,
        },
      ];
    });
  };

  const handleToggleShoppingItem = (category: string, itemId: string) => {
    setShoppingCategories((prev) =>
      prev.map((group) => {
        if (group.category === category) {
          return {
            ...group,
            items: group.items.map((i) =>
              i.id === itemId ? { ...i, isChecked: !i.isChecked } : i
            ),
          };
        }
        return group;
      })
    );
  };

  const handleAddShoppingItem = (category: string, text: string) => {
    setShoppingCategories((prev) => {
      const targetCategory = category || (prev[0]?.category || 'General');
      const existing = prev.find((g) => g.category === targetCategory);
      if (existing) {
        return prev.map((group) =>
          group.category === targetCategory
            ? {
                ...group,
                items: [
                  ...group.items,
                  { id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`, text, recipeSources: ['Custom'], isChecked: false },
                ],
              }
            : group
        );
      }
      return [
        ...prev,
        {
          category: targetCategory,
          items: [
            { id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`, text, recipeSources: ['Custom'], isChecked: false },
          ],
        },
      ];
    });
  };

  const handleDeleteShoppingItem = (category: string, itemId: string) => {
    setShoppingCategories((prev) =>
      prev.map((group) => {
        if (group.category === category) {
          return {
            ...group,
            items: group.items.filter((i) => i.id !== itemId),
          };
        }
        return group;
      })
    );
  };

  const handleClearDoneShopping = () => {
    setShoppingCategories((prev) =>
      prev.map((group) => ({
        ...group,
        items: group.items.filter((i) => !i.isChecked),
      }))
    );
  };

  const handleGenerateShoppingForDay = (day: MealPlanDay) => {
    const mealSlots: { mealType: string; recipeTitle: string; recipeId?: string }[] = [];
    if (day.breakfast?.recipeTitle) {
      mealSlots.push({
        mealType: 'Breakfast',
        recipeTitle: day.breakfast.recipeTitle,
        recipeId: day.breakfast.recipeId,
      });
    }
    if (day.lunch?.recipeTitle) {
      mealSlots.push({
        mealType: 'Lunch',
        recipeTitle: day.lunch.recipeTitle,
        recipeId: day.lunch.recipeId,
      });
    }
    if (day.dinner?.recipeTitle) {
      mealSlots.push({
        mealType: 'Dinner',
        recipeTitle: day.dinner.recipeTitle,
        recipeId: day.dinner.recipeId,
      });
    }

    if (mealSlots.length === 0) return;

    const dayCategoryGroups: ShoppingCategoryGroup[] = [];

    mealSlots.forEach((slot) => {
      const matchingRecipe = recipes.find(
        (r) =>
          (slot.recipeId && r.id === slot.recipeId) ||
          r.title.toLowerCase() === slot.recipeTitle.toLowerCase()
      );

      if (matchingRecipe && matchingRecipe.ingredients.length > 0) {
        dayCategoryGroups.push({
          category: `${day.dayName} ${slot.mealType}: ${matchingRecipe.title}`,
          items: matchingRecipe.ingredients.map((ing, idx) => {
            const cleanText = ing.original.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
            return {
              id: `${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 6)}`,
              text: cleanText || ing.name,
              recipeSources: [`${day.dayName} ${slot.mealType}: ${matchingRecipe.title}`],
              isChecked: false,
            };
          }),
        });
      }
    });

    if (dayCategoryGroups.length > 0) {
      setShoppingCategories(dayCategoryGroups);
    }

    setActiveTab('shopping');
  };

  // Compute Tags, Cuisines, Categories
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => r.tags.forEach((t) => set.add(t)));
    return Array.from(set);
  }, [recipes]);

  const availableCuisines = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => r.cuisine && set.add(r.cuisine));
    return Array.from(set);
  }, [recipes]);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    recipes.forEach((r) => r.category && set.add(r.category));
    return Array.from(set);
  }, [recipes]);

  // Filtered & Sorted Recipes
  const filteredRecipes = useMemo(() => {
    return recipes.filter((recipe) => {
      // Search query (matches title, tags, ingredients, notes)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const inTitle = recipe.title.toLowerCase().includes(q);
        const inTags = recipe.tags.some((t) => t.toLowerCase().includes(q));
        const inIngs = recipe.ingredients.some((i) => i.original.toLowerCase().includes(q));
        const inNotes = (recipe.notes || '').toLowerCase().includes(q);
        const inWikilinks = (recipe.wikilinks || []).some((wl) => wl.toLowerCase().includes(q));
        if (!inTitle && !inTags && !inIngs && !inNotes && !inWikilinks) return false;
      }

      // Tag filter
      if (filters.tag && !recipe.tags.includes(filters.tag)) return false;

      // Cuisine filter
      if (filters.cuisine && recipe.cuisine !== filters.cuisine) return false;

      // Category filter
      if (filters.category && recipe.category !== filters.category) return false;

      // Difficulty
      if (filters.difficulty && recipe.difficulty !== filters.difficulty) return false;

      // Favorites
      if (filters.onlyFavorites && !recipe.isFavorite) return false;

      // Max Cook Time
      if (filters.maxCookTime) {
        const cookMin = parseInt(recipe.cookTime, 10) || 30;
        if (cookMin > filters.maxCookTime) return false;
      }

      return true;
    }).sort((a, b) => {
      if (filters.sortBy === 'title') {
        return a.title.localeCompare(b.title);
      } else if (filters.sortBy === 'rating') {
        return (b.rating || 0) - (a.rating || 0);
      } else if (filters.sortBy === 'cookTime') {
        const minA = parseInt(a.cookTime, 10) || 0;
        const minB = parseInt(b.cookTime, 10) || 0;
        return minA - minB;
      } else if (filters.sortBy === 'servings') {
        return (b.servings || 0) - (a.servings || 0);
      }
      return 0;
    });
  }, [recipes, searchQuery, filters]);

  const activeFilterCount =
    (filters.tag ? 1 : 0) +
    (filters.cuisine ? 1 : 0) +
    (filters.category ? 1 : 0) +
    (filters.difficulty ? 1 : 0) +
    (filters.maxCookTime ? 1 : 0) +
    (filters.onlyFavorites ? 1 : 0);

  const vaultHealthSummary = useMemo(() => {
    return summarizeVaultHealth(recipes);
  }, [recipes]);

  return (
    <div
      data-theme={theme}
      className="min-h-screen bg-[#0C0C0C] text-gray-200 flex flex-col font-sans selection:bg-amber-500/30 selection:text-amber-200 relative transition-colors duration-200"
      onDragOver={(e) => {
        e.preventDefault();
        setIsWindowDragging(true);
      }}
      onDragLeave={(e) => {
        // If leaving the window
        if (!e.relatedTarget) {
          setIsWindowDragging(false);
        }
      }}
      onDrop={async (e) => {
        e.preventDefault();
        setIsWindowDragging(false);
        try {
          const result = await parseDroppedFilesAndFolders(e.dataTransfer);
          if (result.recipes.length > 0) {
            setRecipes((prev) => {
              const map = new Map(prev.map((r) => [r.id, r]));
              result.recipes.forEach((r) => map.set(r.id, r));
              return Array.from(map.values());
            });
          }
          if (result.notes && result.notes.length > 0) {
            setNotes((prev) => {
              const map = new Map(prev.map((n) => [n.id, n]));
              result.notes.forEach((n) => map.set(n.id, n));
              return Array.from(map.values());
            });
          }
          if (result.mealPlan) setMealPlan(result.mealPlan);
          if (result.shoppingList) setShoppingCategories(result.shoppingList);

          if (result.recipes.length > 0 || result.mealPlan || result.shoppingList || (result.notes && result.notes.length > 0)) {
            setVaultStatus((prev) => ({
              ...prev,
              isConnected: true,
              fileCount: prev.fileCount + result.recipes.length + (result.notes?.length || 0),
            }));
          }
        } catch (err) {
          console.warn('Drop error:', err);
        }
      }}
    >
      {/* Global Drag and Drop Dropzone Indicator */}
      {isWindowDragging && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex flex-col items-center justify-center p-6 border-4 border-dashed border-amber-500 pointer-events-none">
          <div className="bg-[#141414] p-8 rounded-2xl border border-amber-500/40 text-center max-w-md shadow-2xl">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center mx-auto mb-4 border border-amber-500/30 animate-bounce">
              <span className="text-2xl font-bold">📂</span>
            </div>
            <h3 className="text-lg font-serif font-bold text-white mb-1">
              Drop Obsidian Recipe Files or Folder
            </h3>
            <p className="text-xs text-gray-400">
              Release to instantly parse recipes, notes, Meal Plan.md, and Shopping List.md into The Kitchen Codex.
            </p>
          </div>
        </div>
      )}

      {/* Lightweight adapter save/delete error surface (inline alert, no new framework) */}
      {vaultError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-2rem)] max-w-xl">
          <div className="bg-rose-950/90 border border-rose-500/40 rounded-xl px-4 py-3 shadow-2xl flex items-start gap-3 text-rose-100">
            <span className="text-base">⚠️</span>
            <p className="flex-1 text-xs leading-relaxed text-rose-200">{vaultError}</p>
            <button
              onClick={clearVaultError}
              className="px-2 py-0.5 rounded-md text-rose-300 hover:text-white hover:bg-white/10 text-xs transition-colors shrink-0"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Top Header */}
      <VaultHeader
        vaultStatus={vaultStatus}
        activeTab={activeTab}
        setActiveTab={(tab) => {
          setActiveTab(tab);
          setSelectedRecipe(null);
        }}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        isFilterOpen={isFilterOpen}
        setIsFilterOpen={setIsFilterOpen}
        activeFilterCount={activeFilterCount}
        onOpenConnectVaultModal={() => setIsConnectVaultOpen(true)}
        onOpenNewRecipeModal={() => {
          setEditingRecipe(null);
          setIsEditorOpen(true);
        }}
        onOpenRecipeGrabber={() => setIsGrabberOpen(true)}
        onOpenVaultIntelligence={() => {
          setVaultIntelligenceRecipeId(null);
          setIsVaultIntelligenceOpen(true);
        }}
        onOpenAskMyKitchen={() => setIsAskMyKitchenOpen(true)}
        onOpenCreateForMe={() => setIsCreateForMeOpen(true)}
        legacyRecipeCount={vaultHealthSummary.legacyCount + vaultHealthSummary.incompleteCount}
        onRefreshVault={async () => {
          if (vaultStatus.isConnected && vaultStatus.folderHandle) {
            try {
              const generation = vaultScanGeneration.current.begin();
              const result = await loadVaultFromHandle(vaultStatus.folderHandle);
              commitVaultSnapshot(result, generation, vaultStatus.folderHandle);
            } catch (err) {
              console.warn('Re-scan failed:', err);
            }
          } else {
            setRecipes(getStarterVaultRecipes());
            setMealPlan(STARTER_MEAL_PLAN);
            setShoppingCategories(STARTER_SHOPPING_CATEGORIES);
            setVaultHydrated(true);
          }
        }}
      />

      {/* Filter Drawer */}
      {isFilterOpen && (
        <RecipeFilterBar
          filters={filters}
          setFilters={setFilters}
          availableTags={availableTags}
          availableCuisines={availableCuisines}
          availableCategories={availableCategories}
          totalResults={filteredRecipes.length}
          onResetFilters={() => setFilters(INITIAL_FILTERS)}
        />
      )}

      {/* Main View Router */}
      <main className="flex-1">
        {selectedRecipe ? (
          <RecipeDetailView
            recipe={selectedRecipe}
            allRecipes={recipes}
            allNotes={notes}
            onBack={() => setSelectedRecipe(null)}
            onStartCooking={(recipe, servings) => handleStartCooking(recipe, servings)}
            onEditRecipe={(recipe) => {
              setEditingRecipe(recipe);
              setIsEditorOpen(true);
            }}
            onDeleteRecipe={handleDeleteRecipe}
            onAddToMealPlan={(recipe) => {
              handleAddToMealPlan(recipe);
              setSelectedRecipe(null);
            }}
            onAddToShoppingList={handleAddToShoppingList}
            onStartTimer={handleStartTimer}
            onFilterByWikilink={handleFilterByWikilink}
            onUpdateNutrition={handleUpdateNutrition}
            onSelectRecipe={(r) => setSelectedRecipe(r)}
            onSaveNoteToVault={handleSaveNoteToVault}
            onOpenVaultIntelligence={(recipeId) => {
              setVaultIntelligenceRecipeId(recipeId || null);
              setIsVaultIntelligenceOpen(true);
            }}
            network={networkAdapter}
          />
        ) : activeTab === 'grid' ? (
          /* Recipe Gallery View */
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
            {/* Gallery Stats & Info */}
            <div className="flex items-center justify-between text-xs text-gray-400 pb-2 border-b border-white/5">
              <span>
                Showing <strong className="text-white">{filteredRecipes.length}</strong> of {recipes.length} recipes in vault
              </span>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-amber-400 font-semibold hover:underline"
                >
                  Clear search: &quot;{searchQuery}&quot;
                </button>
              )}
            </div>

            {filteredRecipes.length === 0 ? (
              <div className="bg-[#141414] rounded-2xl border border-dashed border-white/10 p-12 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto">
                  <span className="text-xl">🔍</span>
                </div>
                <h3 className="font-serif font-bold text-base text-white">No matching recipes found</h3>
                <p className="text-xs text-gray-400 max-w-sm mx-auto">
                  Try adjusting your search terms, clearing active tag filters, or creating/importing new recipe markdown notes.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setFilters(INITIAL_FILTERS);
                    }}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black rounded-xl text-xs font-bold transition-colors cursor-pointer"
                  >
                    Reset All Filters
                  </button>
                  <button
                    onClick={() => setIsGrabberOpen(true)}
                    className="px-4 py-2 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 rounded-xl text-xs font-bold transition-colors cursor-pointer"
                  >
                    🌐 Grab Recipe from Web
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                {filteredRecipes.map((recipe) => (
                  <RecipeCard
                    key={recipe.id}
                    recipe={recipe}
                    onSelectRecipe={(r) => setSelectedRecipe(r)}
                    onStartCooking={(r) => handleStartCooking(r)}
                    onToggleFavorite={handleToggleFavorite}
                    onAddToMealPlan={(r) => handleAddToMealPlan(r)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'dataview' ? (
          /* Dataview Table View */
          <DataviewTableView
            recipes={filteredRecipes}
            onSelectRecipe={(r) => setSelectedRecipe(r)}
            onStartCooking={(r) => handleStartCooking(r)}
          />
        ) : activeTab === 'mealplan' ? (
          /* Weekly Meal Planner View */
          <MealPlannerView
            recipes={recipes}
            mealPlan={mealPlan}
            onOpenRecipe={(id) => {
              const r = recipes.find((item) => item.id === id);
              if (r) setSelectedRecipe(r);
            }}
            onGenerateDayShoppingList={handleGenerateShoppingForDay}
            onGenerateWeeklyShoppingList={handleGenerateWeeklyShoppingList}
            onSelectSlotRecipe={handleSelectSlotRecipe}
            onRemoveSlotRecipe={handleRemoveSlotRecipe}
            onResetMealPlan={handleResetMealPlan}
          />
        ) : activeTab === 'shopping' ? (
          /* Shopping List View */
          <ShoppingListView
            categories={shoppingCategories}
            mealPlan={mealPlan}
            onToggleItem={handleToggleShoppingItem}
            onAddItem={handleAddShoppingItem}
            onDeleteItem={handleDeleteShoppingItem}
            onClearChecked={handleClearDoneShopping}
            onNavigateToMealPlan={() => setActiveTab('mealplan')}
          />
        ) : activeTab === 'providers' ? (
          /* AI Provider Status / Selection View (read-only truth + safe client preferences) */
          <ProviderSettings network={networkAdapter} settings={settingsAdapter} />
        ) : (
          /* Themes View */
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
            <ThemesView
              currentTheme={theme}
              onSelectTheme={(newTheme) => setTheme(newTheme)}
            />
          </div>
        )}
      </main>

      {/* App Footer */}
      <footer className="border-t border-stone-800/60 bg-stone-900/40 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-stone-500">
          <div className="flex items-center gap-2">
            <span className="font-medium text-stone-400">The Kitchen Codex</span>
            <span>•</span>
            <span>Markdown-Native Culinary Vault</span>
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
              {APP_VERSION}
            </span>
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <span>Obsidian Compatible</span>
            <span>•</span>
            <span>Local-First & Schema v1 Compliant</span>
          </div>
        </div>
      </footer>

      {/* Floating Active Timers Bar */}
      <ActiveTimersBar
        timers={activeTimers}
        onToggleTimer={handleToggleTimer}
        onDeleteTimer={handleDeleteTimer}
        onAddCustomTimer={handleAddCustomTimer}
      />

      {/* Fullscreen Cooking Mode Modal */}
      {cookingRecipe && (
        <React.Suspense fallback={null}>
          <CookingModeModal
            recipe={cookingRecipe.recipe}
            servings={cookingRecipe.servings}
            activeTimers={activeTimers}
            onStartTimer={handleStartTimer}
            onToggleTimer={handleToggleTimer}
            onDeleteTimer={handleDeleteTimer}
            onClose={() => setCookingRecipe(null)}
          />
        </React.Suspense>
      )}

      {/* Recipe Editor Modal */}
      {isEditorOpen && (
        <React.Suspense fallback={<div className="p-8 text-center text-gray-400">Loading editor…</div>}>
          <RecipeEditorModal
            initialRecipe={editingRecipe}
            folderHandle={vaultStatus.folderHandle}
            imageService={imageService}
            network={networkAdapter}
            onSave={handleSaveRecipe}
            onClose={() => {
              setIsEditorOpen(false);
              setEditingRecipe(null);
            }}
          />
        </React.Suspense>
      )}

      {/* Connect Obsidian Vault Modal */}
      <ConnectVaultModal
        isOpen={isConnectVaultOpen}
        onClose={() => setIsConnectVaultOpen(false)}
        vaultStatus={vaultStatus}
        setVaultStatus={setVaultStatus}
        recipes={recipes}
        setRecipes={setRecipes}
        setMealPlan={setMealPlan}
        setShoppingCategories={setShoppingCategories}
        onOpenWebGrabber={() => setIsGrabberOpen(true)}
        onDirectVaultConnected={handleDirectVaultConnected}
      />

      {/* Web Recipe Grabber Modal */}
      <RecipeGrabberModal
        isOpen={isGrabberOpen}
        folderHandle={vaultStatus.folderHandle}
        imageService={imageService}
        initialUrl={grabberInitialUrl}
        onClose={() => setIsGrabberOpen(false)}
        onSaveRecipe={async (savedRecipe) => {
          await handleSaveRecipe(savedRecipe);
          setSelectedRecipe(savedRecipe);
        }}
        onOpenInEditor={(recipe) => {
          setEditingRecipe(recipe);
          setIsEditorOpen(true);
        }}
        network={networkAdapter}
      />

      {/* Vault Intelligence & Legacy Recovery Modal */}
      <VaultIntelligenceModal
        isOpen={isVaultIntelligenceOpen}
        onClose={() => {
          setIsVaultIntelligenceOpen(false);
          setVaultIntelligenceRecipeId(null);
        }}
        recipes={recipes}
        initialSelectedRecipeId={vaultIntelligenceRecipeId}
        network={networkAdapter}
        imageRecovery={recipeImageRecoverySupport}
        imageRecoveryUnavailableReason={imageRecoveryUnavailableReason}
        onRecipeImageSaved={handleRecipeImageSaved}
        onSaveRecipe={async (updatedRecipe) => {
          await handleSaveRecipe(updatedRecipe);
          if (selectedRecipe && selectedRecipe.id === updatedRecipe.id) {
            setSelectedRecipe(updatedRecipe);
          }
        }}
      />

      {/* Ask My Kitchen Modal */}
      <AskMyKitchenModal
        isOpen={isAskMyKitchenOpen}
        onClose={() => setIsAskMyKitchenOpen(false)}
        allRecipes={recipes}
        currentRecipe={selectedRecipe}
        network={networkAdapter}
        onSelectRecipe={(recipe) => {
          setIsAskMyKitchenOpen(false);
          setSelectedRecipe(recipe);
        }}
        onWebImport={(handoff) => {
          setGrabberInitialUrl(handoff.sourceUrl);
          setIsAskMyKitchenOpen(false);
          setIsGrabberOpen(true);
        }}
      />

      {/* Create for Me Modal */}
      <CreateForMeModal
        isOpen={isCreateForMeOpen}
        onClose={() => setIsCreateForMeOpen(false)}
        network={networkAdapter}
        onSaveRecipe={handleSaveGeneratedRecipe}
      />
    </div>
  );
}
