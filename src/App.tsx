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
  DEFAULT_THEME_ID,
  isThemeId,
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
  applyAdvancedNutrition,
  ADVANCED_NUTRITION_APPLY_UI_MESSAGE,
} from './application';
import { resolveRecipeVaultPath } from './core/vaultPath';
import {
  createBrowserSettingsAdapter,
  createBrowserNetworkAdapter,
  createBrowserVaultAdapter,
  createBrowserAssetAdapter,
  createBrowserSecretAdapter,
  browserRemoteImageDownloader,
} from './platform/browser';
import {
  createVaultSessionId,
  fetchGeneratedPreviewBytes,
  type RecipeImageRecoverySupport,
} from './application/recipeImageRecovery';
import { saveGeneratedRecipeImageToVault, hashCanonicalMarkdown, type GeneratedImageSaveResult } from './application/recipeImageSave';
import { hydrateAiSelections } from './application/aiSelection';
import { resolveUnresolvedRowsWithAi } from './application/nutritionAiResolve';
import {
  NUTRITION_AI_REFRESHING_MESSAGE,
  UNAVAILABLE_EFFECTIVE_CAPABILITIES,
  nutritionAiUnavailableMessage,
  recomposeNutritionAiClientState,
  unresolvedNutritionAiClientState,
  type NutritionAiClientState,
  type NutritionAiEffectiveCapabilities,
} from './application/nutritionAiClientState';
// AI-5D: product-state predicates are re-exported by the composition owner, so the
// shell never imports the product-access module and never becomes a contract consumer.
import {
  createNutritionRefreshSequencer,
  isAiAdvancedProductAccessRead,
  isBasicProductAccessRead,
  type NutritionProductAccessRead,
} from './application/nutritionAiClientState';

import { requestAiMassEstimateOffers } from './application/nutritionAiEstimate';
import { buildAiSelectionRequestOptions } from './application/aiSelection';
import {
  createRecipeContextInstanceToken,
  createRecipeContextRequestId,
  requestRecipeContextReview,
} from './application/nutritionAiRecipeContext';

/** The ONE dedicated AI-3 route. It never shares the AI-2 planning route. */
const AI_ESTIMATE_ENDPOINT = '/api/nutrition/estimate-mass';
import type { NutritionCapabilities } from './core/nutritionV2/nutritionCapabilities';
import { getEndpointAccessHeaders } from './application/endpointAccess';
import { loadProductionAdvancedNutritionSession } from './browser/advancedNutritionBundle';
import { useAdvancedNutritionBundle } from './application-ui/useAdvancedNutritionBundle';
import { playTimerChime } from './utils/audioAlert';
import { buildGalleryRoute, buildRecipeRoute, parseRecipeRoute } from './utils/recipeRoute';
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
import type {
  AdvancedNutritionAiResolveHandler,
  AdvancedNutritionAiEstimateHandler,
  AdvancedNutritionRecipeContextReviewHandler,
  AdvancedNutritionApplyHandler,
  AdvancedNutritionApplyHandlerArgs,
  AdvancedNutritionApplyUiResult,
} from './components/AdvancedNutritionCard';
import { DataviewTableView } from './components/DataviewTableView';
import { MealPlannerView } from './components/MealPlannerView';
import { ShoppingListView } from './components/ShoppingListView';
import { ThemesView, themeBackgroundColor } from './components/ThemesView';
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
  const networkAdapter = useMemo(
    () => createBrowserNetworkAdapter({ authorizationHeaders: getEndpointAccessHeaders }),
    []
  );
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

  // Phase 4.5B: ONE in-memory Advanced Nutrition bundle load for the page. It is
  // lazy — nothing is fetched, decoded, or installed at startup. The first
  // explicit "Open Advanced Nutrition" action begins authentication; the
  // resulting genuine Phase 4 session is retained in memory across recipe
  // navigation for the lifetime of the page and is never persisted.
  const advancedNutritionBundle = useAdvancedNutritionBundle(loadProductionAdvancedNutritionSession);

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
            // Prefer the authenticated NetworkAdapter binary path; fall back to
            // the scoped browser helper for adapters without a binary path.
            // The generated preview MUST travel the authenticated application
            // binary transport. An adapter without a binary path FAILS CLOSED —
            // there is NO unauthenticated direct-fetch fallback.
            const viaAdapter = await fetchGeneratedPreviewBytes(networkAdapter, token);
            if (!viaAdapter) return undefined;
            const bytes = viaAdapter.bytes;
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
  }, [vaultStatus.folderHandle, vaultStatus.accessType, vaultSessionId, networkAdapter]);

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
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME_ID);

  // Navigation & View State (persisted via SettingsAdapter; hydrated on mount)
  const [activeTab, setActiveTab] = useState<'grid' | 'dataview' | 'mealplan' | 'shopping' | 'themes' | 'providers'>('grid');

  const [selectedRecipe, setSelectedRecipe] = useState<ObsidianRecipe | null>(null);
  const [cookingRecipe, setCookingRecipe] = useState<{ recipe: ObsidianRecipe; servings: number } | null>(null);

  // Stable recipe-detail route restoration. The canonical recipe id from the
  // browser fragment is resolved once the recipe collection is loaded, so a hard
  // refresh on a recipe detail page restores that recipe (never the gallery).
  const [routeRecipeId, setRouteRecipeId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const parsed = parseRecipeRoute(window.location.hash);
    return parsed.kind === 'recipe' ? parsed.id : null;
  });
  const suppressHashSyncRef = useRef(false);
  // True once the initial IndexedDB vault-reconnect attempt has settled, so an
  // unresolved route is only treated as not-found AFTER loading has finished
  // (never prematurely while the vault is still being scanned).
  const [vaultRestoreSettled, setVaultRestoreSettled] = useState(false);

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
    restoreVaultConnection().finally(() => {
      if (isMounted) setVaultRestoreSettled(true);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  // Stable recipe-detail route restoration. On mount the fragment is the
  // authority: once the recipe collection contains the routed id, the same
  // detail view is restored. This waits for the vault/recipe loading state and
  // only falls back to the gallery AFTER loading has settled and the id is
  // genuinely absent.
  useEffect(() => {
    if (routeRecipeId === null) return;
    const match = recipes.find((recipe) => recipe.id === routeRecipeId);
    if (match) {
      setRouteRecipeId(null);
      if (activeRefs.current.selectedRecipe?.id === match.id) return;
      suppressHashSyncRef.current = true;
      setSelectedRecipe(match);
      return;
    }
    if (vaultRestoreSettled) {
      // Invalid/missing recipe route: fail safely back to the gallery.
      setRouteRecipeId(null);
      suppressHashSyncRef.current = true;
      setSelectedRecipe(null);
    }
  }, [recipes, routeRecipeId, vaultRestoreSettled]);

  // Keep the browser fragment in sync with the selected recipe. A popstate /
  // route-restoration driven change suppresses this sync so back/forward
  // navigation is not clobbered.
  useEffect(() => {
    const desired = selectedRecipe ? buildRecipeRoute(selectedRecipe.id) : buildGalleryRoute();
    if (suppressHashSyncRef.current) {
      suppressHashSyncRef.current = false;
      return;
    }
    if (typeof window === 'undefined' || window.location.hash === desired) return;
    window.history.pushState(null, '', desired);
  }, [selectedRecipe]);

  // Browser back/forward. A recipe fragment restores that recipe; the gallery
  // fragment returns to the gallery.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      const parsed = parseRecipeRoute(window.location.hash);
      if (parsed.kind === 'recipe') {
        setRouteRecipeId(parsed.id);
        return;
      }
      suppressHashSyncRef.current = true;
      setSelectedRecipe(null);
      setRouteRecipeId(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Normalize an empty fragment to the gallery route once on mount so the first
  // user navigation does not create a spurious history entry.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '') {
      window.history.replaceState(null, '', buildGalleryRoute());
    }
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
            (t) => t === DEFAULT_THEME_ID,
            (t): t is ThemeId => isThemeId(t)
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
    // Keep the browser chrome (theme-color) in sync with the active theme so it
    // is never stuck on another theme's color. Sourced from the theme config.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeBackgroundColor(theme));
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

  // Phase 5B: explicit Advanced Nutrition Apply. The application write
  // coordinator re-authorizes from genuine Phase 4 authority immediately before
  // the write; this shell only supplies the SAME authoritative recipe write path
  // the editor uses, plus an optional post-write re-read when a vault is connected.
  const handleApplyAdvancedNutrition: AdvancedNutritionApplyHandler = async (
    args: AdvancedNutritionApplyHandlerArgs
  ): Promise<AdvancedNutritionApplyUiResult> => {
    const result = await applyAdvancedNutrition({
      session: args.session,
      recipe: args.recipe,
      state: args.state,
      expectedMode: args.expectedMode,
      write: async (updated: ObsidianRecipe) => {
        if (vaultAdapter) {
          await saveRecipeWithVaultAdapter(vaultAdapter, updated);
        } else {
          await saveRecipeToVaultFile(updated, undefined);
        }
        // Commit in-memory state ONLY after the canonical write succeeded. The
        // new saved result immediately becomes THE current recipe on every
        // surface (Advanced summary, saved report, compact card, header).
        setRecipes((prev) => upsertCanonicalRecipe(prev, updated));
        setSelectedRecipe((prev) =>
          prev && sameCanonicalRecipeIdentity(prev, updated) ? updated : prev
        );
        // AUTHORITATIVE HANDOFF: invalidate any vault scan that STARTED before
        // this write. Such a scan may have read the pre-Apply Markdown and would
        // otherwise still be considered "current", letting a later-resolving
        // stale scan overwrite the just-applied result. The committed in-memory
        // recipe is authoritative until a scan that began AFTER this write
        // completes.
        vaultScanGeneration.current.begin();
      },
      ...(vaultAdapter
        ? {
            readBack: async (updated: ObsidianRecipe) =>
              vaultAdapter.readText(resolveRecipeVaultPath(updated)),
          }
        : {}),
    });

    if (result.ok) {
      return {
        ok: true,
        mode: result.result.mode,
        message:
          result.result.mode === 'replace'
            ? 'Advanced Nutrition was replaced and saved to your recipe.'
            : 'Advanced Nutrition was saved to your recipe.',
      };
    }
    const failureCode = (result as { ok: false; failure: { code: keyof typeof ADVANCED_NUTRITION_APPLY_UI_MESSAGE } })
      .failure.code;
    return { ok: false, message: ADVANCED_NUTRITION_APPLY_UI_MESSAGE[failureCode] };
  };

  // ==========================================================================
  // AI-5C — EFFECTIVE NUTRITION AI CLIENT STATE (the ONE shell decision owner)
  // ==========================================================================
  //
  // Previously the shell resolved a provider-derived capability set once and used it
  // directly as if it were entitlement. That conflated two different questions: it
  // could not tell "this deployment is Basic" from "no provider is configured", and
  // it silently reported both as one generic message.
  //
  // AI-5C composes them explicitly:
  //
  //     EFFECTIVE = PRODUCT ENTITLED (server-owned, read-only awareness)
  //              AND OPERATIONALLY READY (pre-existing provider surface)
  //
  // per feature, never OR. The product read comes from the read-only
  // `/api/nutrition/product-access` endpoint and is resolved through the unchanged
  // AI-5A contract; readiness still comes from `resolveNutritionAiCapabilities`
  // reading `/api/providers`, which this phase does not reinterpret.
  //
  // AWARENESS IS NOT AUTHORITY: this cached value is an in-memory UX optimization
  // only. It is never persisted, never sent back to the server, and never treated as
  // authorization. Every AI request still reaches the AI-5B gate, which resolves
  // product access from its own server-side configuration and denies a Basic
  // deployment independently — so a forged or stale `ai_advanced` belief here
  // changes nothing about what the server will do.
  //
  // LAZY: the product-status request happens only when the user actually loads the
  // Advanced Nutrition experience, never on ordinary startup or recipe browsing. A
  // page that never opens Advanced Nutrition performs no AI-5C request at all.
  // AI-5D SPLITS THE TWO LIFETIMES. Product access is deployment-scoped and stable,
  // so it stays cached. Operational readiness is DYNAMIC, so it is never cached
  // forever: it is re-read on demand and invalidated immediately on any relevant
  // text-runtime change.
  const nutritionProductReadRef = useRef<NutritionProductAccessRead | null>(null);
  const nutritionAiClientStateRef = useRef<NutritionAiClientState | null>(null);
  const nutritionRefreshingRef = useRef(false);
  // ONE monotonic sequencing authority for the initial load, an explicit Retry, and
  // every Provider-Settings-triggered refresh. There are deliberately no competing
  // counters: an older async completion can never overwrite a newer one.
  const nutritionRefreshGenerationRef = useRef(createNutritionRefreshSequencer());

  const publishNutritionAiPresentation = useCallback((state: NutritionAiClientState, refreshing: boolean) => {
    setNutritionAiPresentation({
      available: refreshing ? false : state.available,
      reason: refreshing
        ? NUTRITION_AI_REFRESHING_MESSAGE
        : nutritionAiUnavailableMessage(state.availability),
      refreshing,
      // Retry is offered only where it can actually help: a provider that may come
      // back, or a status we may not yet have verified. A definitive Basic product
      // answer is policy, not a transient failure, so it never offers Retry.
      canRetry: !refreshing && (state.availability === 'provider_unavailable' || state.availability === 'product_access_unverified'),
      ...(refreshing ? {} : {}),
    });
  }, []);

  /**
   * The single refresh entry point. ALL of initial load, Retry, and
   * Provider-Settings invalidation funnel through here, so they share one
   * generation counter and cannot race each other.
   *
   * `reuseProductAccess` is the AI-5D distinction in one flag: an ordinary provider
   * recovery re-reads READINESS ONLY and reuses the known canonical product access,
   * while an explicit Retry after an unverified status re-reads product access too.
   */
  const runNutritionAiRefresh = useCallback(
    async (options: { reuseProductAccess: boolean }): Promise<void> => {
      const generation = nutritionRefreshGenerationRef.current.begin();
      nutritionRefreshingRef.current = true;

      const cachedProductAccess = nutritionProductReadRef.current;
      // Fail closed IMMEDIATELY, before any await: a known readiness-affecting
      // change must never leave AI executable against yesterday's answer. This is
      // what closes the stale-window on credential revocation.
      const currentState = nutritionAiClientStateRef.current;
      if (currentState !== null) publishNutritionAiPresentation(currentState, true);

      try {
        const state = await recomposeNutritionAiClientState(
          networkAdapter,
          options.reuseProductAccess && cachedProductAccess !== null ? cachedProductAccess : undefined,
        );
        // STALE COMPLETION GUARD: a newer refresh superseded this one, so this
        // result must not rewrite the ref, the presentation, or re-enable AI.
        if (!nutritionRefreshGenerationRef.current.isCurrent(generation)) return;
        // Only a RESOLVED product read may become the cached stable truth. Unknown
        // stays unknown and is deliberately not cached as a product answer.
        if (state.productAccessStatus.status === 'resolved') {
          nutritionProductReadRef.current = state.productAccessStatus;
        }
        nutritionAiClientStateRef.current = state;
        nutritionRefreshingRef.current = false;
        publishNutritionAiPresentation(state, false);
      } catch {
        if (!nutritionRefreshGenerationRef.current.isCurrent(generation)) return;
        nutritionRefreshingRef.current = false;
        const fallback = unresolvedNutritionAiClientState();
        nutritionAiClientStateRef.current = fallback;
        publishNutritionAiPresentation(fallback, false);
      }
    },
    [networkAdapter, publishNutritionAiPresentation],
  );

  /**
   * AI-5D IMMEDIATE INVALIDATION on a readiness-affecting change.
   *
   * Called by Provider Settings when something that can change TEXT execution truth
   * changed. It carries NO secret and grants NO authority: it means only "the cached
   * nutrition operational-readiness result may now be stale".
   *
   * Crucially it does NOT trigger product-access resolution. If Advanced Nutrition
   * has never been opened there is no cached product truth and nothing is fetched —
   * the first entry into Advanced Nutrition still owns the lazy boundary. If the
   * known answer is Basic, a provider change cannot grant Advanced, so no readiness
   * request is made at all.
   */
  const invalidateNutritionReadiness = useCallback(() => {
    if (nutritionProductReadRef.current === null) return; // never resolved: stay lazy
    const cached = nutritionProductReadRef.current;
    const knownBasic = isBasicProductAccessRead(cached);
    if (knownBasic) return; // provider configuration cannot turn Basic into Advanced
    void runNutritionAiRefresh({ reuseProductAccess: true });
  }, [runNutritionAiRefresh]);

  /**
   * The user-triggered recovery control ("Retry AI availability").
   *
   * From a provider-unavailable state it reuses known canonical product access and
   * refreshes READINESS ONLY. From an unverified state it re-reads product access
   * first, stopping at Basic if that is what the server now says. It is never
   * offered for a definitive Basic product answer.
   */
  const handleRetryNutritionAiAvailability = useCallback(() => {
    if (nutritionRefreshingRef.current) return; // no duplicate refreshes
    const cached = nutritionProductReadRef.current;
    const knownAdvanced = cached !== null && isAiAdvancedProductAccessRead(cached);
    void runNutritionAiRefresh({ reuseProductAccess: knownAdvanced });
  }, [runNutritionAiRefresh]);

  /**
   * Projects the AND-composed effective availability into the EXISTING
   * operational `NutritionCapabilities` shape, so every existing AI port gates on
   * effective availability without any of them being rewritten.
   *
   * `deterministicReview` and `manualEditing` are literal `true` here, exactly as
   * `nutritionCapabilities.ts` defines them: Basic Nutrition — deterministic USDA
   * analysis, matching, manual correction, portions, calculation, provenance, Review
   * and Apply — is never reduced by AI-5C. Only the AI assistance layer is gated.
   *
   * The core capability module is NOT modified or reinterpreted; this is an
   * application-layer projection of the composed result.
   */
  const toEffectiveNutritionCapabilities = useCallback(
    (effective: NutritionAiEffectiveCapabilities): NutritionCapabilities =>
      Object.freeze({
        tier: effective.aiInterpretation ? ('ai_advanced' as const) : ('basic' as const),
        deterministicReview: true as const,
        manualEditing: true as const,
        aiInterpretation: effective.aiInterpretation,
        aiCandidateOrchestration: effective.aiCandidateOrchestration,
        aiEstimation: effective.aiBoundedMassEstimation ? ('available' as const) : ('disabled' as const),
      }),
    [],
  );

  /**
   * The single centralized effective-capability decision every AI port gates on.
   *
   * AI-5D: this reads the CURRENT composed state at CALL time rather than capturing
   * a value, so a port can never execute against a stale readiness result, and it
   * fails closed whenever a refresh is in flight. It never re-derives availability
   * itself and never becomes an authority.
   */
  const currentEffectiveNutritionCapabilities = useCallback((): NutritionCapabilities => {
    if (nutritionRefreshingRef.current) {
      return toEffectiveNutritionCapabilities(UNAVAILABLE_EFFECTIVE_CAPABILITIES);
    }
    const state = nutritionAiClientStateRef.current;
    if (state === null) return toEffectiveNutritionCapabilities(UNAVAILABLE_EFFECTIVE_CAPABILITIES);
    return toEffectiveNutritionCapabilities(state.effectiveCapabilities);
  }, [toEffectiveNutritionCapabilities]);

  /** Async facade so existing AI ports keep their single-decision call shape. */
  const resolveEffectiveNutritionCapabilitiesOnce = useCallback(async (): Promise<NutritionCapabilities> =>
    currentEffectiveNutritionCapabilities(),
  [currentEffectiveNutritionCapabilities]);

  /**
   * The bounded presentation state handed to the Advanced Nutrition UI.
   *
   * Components receive only `available` plus a fixed, bounded reason string: they
   * never call the status endpoint, never import the application layer, never
   * inspect the environment, never infer BYOK, and never resolve entitlement.
   *
   * Before the lazy read completes this is `unknown` rather than Basic, so the UI
   * cannot claim a product fact the server has not stated.
   */
  const [nutritionAiPresentation, setNutritionAiPresentation] = useState<{
    readonly available: boolean;
    readonly reason: string | null;
    readonly refreshing: boolean;
    readonly canRetry: boolean;
  }>(() => {
    const initial = unresolvedNutritionAiClientState();
    return {
      available: initial.available,
      reason: nutritionAiUnavailableMessage(initial.availability),
      refreshing: false,
      canRetry: true,
    };
  });

  /**
   * The Advanced Nutrition user-triggered boundary.
   *
   * Entering the experience loads the lazy USDA bundle AND resolves AI-5C client
   * state. This is the ONLY trigger, which is what keeps the product-status request
   * off the ordinary startup path. Readiness resolution failures are contained: the
   * bundle still loads and deterministic/manual nutrition is unaffected.
   */
  const handleLoadAdvancedNutritionBundle = useCallback(() => {
    advancedNutritionBundle.load();
    // AI-5D: entering Advanced Nutrition owns the lazy product-access boundary. On a
    // SECOND entry the stable product read is reused, so re-entering never re-asks
    // the product-status endpoint for an already-known answer.
    const cached = nutritionProductReadRef.current;
    const knownAdvanced = cached !== null && isAiAdvancedProductAccessRead(cached);
    void runNutritionAiRefresh({ reuseProductAccess: knownAdvanced });
  }, [advancedNutritionBundle, runNutritionAiRefresh]);

  // Optional AI-assisted USDA resolution port. This shell owns the network +
  // application layer; the Advanced Nutrition UI receives ONLY this bounded port
  // (it never imports the application layer). Advisory only: the resolver sends
  // bounded unresolved-ingredient text and returns deterministic local candidates.
  // AI-1 activates the LIVE canonical semantic path: bounded ingredient rows ->
  // canonical interpretation route -> client re-sanitization -> deterministic
  // source reconciliation -> the SAME deterministic resolvers.
  const handleResolveAdvancedNutritionAi: AdvancedNutritionAiResolveHandler = async ({
    session,
    rows,
    adapted,
    issueKinds,
    liveRows,
    state,
  }) =>
    resolveUnresolvedRowsWithAi({
      network: networkAdapter,
      session,
      rows,
      adapted,
      issueKinds,
      liveRows,
      state,
      capabilities: await resolveEffectiveNutritionCapabilitiesOnce(),
      liveCanonicalInterpretation: true,
    });

  /**
   * AI-3 PRODUCTION COMPOSITION OWNER — bounded mass estimates.
   *
   * This is a THIN adapter. It does not parse, hash, build a provider payload,
   * implement eligibility, compute a midpoint, dispatch a selection or persist.
   * All of that lives in `requestAiMassEstimateOffers` and the Phase-4/session
   * evidence owner it calls.
   *
   * Capability: the adapter gates FIRST. A Basic tier costs zero provider calls.
   */
  const handleEstimateMassesWithAi: AdvancedNutritionAiEstimateHandler = useCallback(
    async ({ state, lines, servings, request_token }) => {
      const session = advancedNutritionBundle.session;
      if (session === null || session === undefined) {
        return { ok: true, offers: [], refused: [], message: 'Advanced Nutrition is still loading.' };
      }
      try {
        return await requestAiMassEstimateOffers({
          state,
          lines,
          // The shell's single centralized EFFECTIVE capability decision (AI-5C:
          // product entitled AND operationally ready), used verbatim. The adapter
          // has no other way to learn availability, and it must never re-derive it.
          capabilities: await resolveEffectiveNutritionCapabilitiesOnce(),
          session,
          transport: {
            request: async (request) => {
              const response = await networkAdapter.post<{
                ok?: boolean;
                request_id?: string;
                estimates?: ReadonlyArray<Record<string, unknown>>;
                code?: string;
              }>(
                AI_ESTIMATE_ENDPOINT,
                request,
                await buildAiSelectionRequestOptions(),
              );
              const data = response.data;
              if (response.ok !== true || data?.ok !== true) {
                return { ok: false, code: data?.code };
              }
              return {
                ok: true,
                request_id: data.request_id,
                estimates: (data.estimates ?? []) as ReadonlyArray<Record<string, unknown>>,
              };
            },
          },
        });
      } catch {
        return { ok: true, offers: [], refused: [], message: 'AI estimate failed.' };
      }
    },
    [advancedNutritionBundle.session, networkAdapter, resolveEffectiveNutritionCapabilitiesOnce],
  );

  /**
   * The AI-4D2 EXPLICIT recipe-context REVIEW port.
   *
   * Called ONLY from the review control the user clicks. It performs the two-step
   * chain (one provider interpretation, then deterministic reconciliation) and
   * returns an INERT review session with an empty decision overlay: nothing is
   * accepted here, and no nutrition state is touched.
   *
   * `recipeInstance` is an opaque memory-only token minted per review session. It
   * is not a path, URL or recipe id, and it is never persisted.
   *
   * Capability (AI-5C): the adapter gates FIRST on the composed EFFECTIVE
   * `aiRecipeContextReview` bit — product entitlement AND compatible text-AI
   * operational readiness — so a Basic deployment, an unready provider, or an
   * unverifiable product status all cost zero provider calls, exactly like every
   * other AI surface in this shell.
   */
  const handleReviewRecipeContextWithAi: AdvancedNutritionRecipeContextReviewHandler = useCallback(
    async ({ recipe: target }) => {
      // AI-5D: gate on the CURRENT composed per-feature bit, read at call time so a
      // stale closure can never authorize a review after invalidation.
      const state = nutritionAiClientStateRef.current;
      const reviewAvailable =
        !nutritionRefreshingRef.current &&
        state !== null &&
        state.effectiveCapabilities.aiRecipeContextReview;
      if (!reviewAvailable) {
        return {
          ok: false,
          message: "Recipe context review isn't available right now.",
        };
      }
      try {
        // The same AI selection headers every other text AI surface sends.
        const options = await buildAiSelectionRequestOptions();
        return await requestRecipeContextReview({
          network: networkAdapter,
          source: {
            recipe: {
              title: target.title,
              servings: target.servings,
              ingredients: target.ingredients.map((ingredient) => ({
                original: ingredient.original ?? ingredient.name ?? '',
                name: ingredient.name,
              })),
            },
            instructions: target.instructions.map((step) => ({ text: step.text })),
            recipeInstance: createRecipeContextInstanceToken(),
          },
          requestId: createRecipeContextRequestId(),
          headers: options.headers,
          signal: options.signal,
        });
      } catch {
        return {
          ok: false,
          message: "Recipe context review isn't available right now.",
        };
      }
    },
    [networkAdapter, currentEffectiveNutritionCapabilities]
  );

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
            advancedNutritionSession={advancedNutritionBundle.session}
            advancedNutritionBundleStatus={advancedNutritionBundle.status}
            onLoadAdvancedNutritionBundle={handleLoadAdvancedNutritionBundle}
            onApplyAdvancedNutrition={handleApplyAdvancedNutrition}
            onResolveAdvancedNutritionAi={handleResolveAdvancedNutritionAi}
            onEstimateMassesWithAi={handleEstimateMassesWithAi}
            onReviewRecipeContextWithAi={handleReviewRecipeContextWithAi}
            advancedNutritionAiAvailability={{
              ...nutritionAiPresentation,
              onRetry: handleRetryNutritionAiAvailability,
            }}
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
          <ProviderSettings
            network={networkAdapter}
            settings={settingsAdapter}
            onTextAiRuntimeChanged={invalidateNutritionReadiness}
          />
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
            onOpenAiSettings={() => {
              setIsEditorOpen(false);
              setEditingRecipe(null);
              setActiveTab('providers');
            }}
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
