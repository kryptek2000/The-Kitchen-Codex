import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { AlertTriangle, BookOpen, ChevronRight, FolderOpen, Globe2, Plus, RotateCcw, Search, SearchX, SlidersHorizontal, Sparkles, X } from 'lucide-react';
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
  ParsedIngredient,
} from './types';
import { DEFAULT_VAULT_PATH, getStarterVaultRecipes, getStarterVaultNotes, STARTER_MEAL_PLAN, STARTER_SHOPPING_CATEGORIES } from './data/starterVault';
import {
  connectionStateForRestoreAction,
  reconnectRememberedVault,
  resolveVaultRestoreAction,
} from './core/vaultConnection';
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
import {
  resolveUnresolvedRowsWithAi,
  type WholeRecipeSemanticSource,
} from './application/nutritionAiResolve';
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
import { ShisoEntryProvider, useShiso } from './application-ui/shisoEntryPoints';
import { ShisoModal } from './components/ShisoModal';
import { applyShisoIngredientEdits } from './core/shiso/recipeEditing';
import {
  extendWorkingRecipe,
  undoLastWorkingEdit,
  type ShisoWorkingRecipeCore,
} from './core/shiso/workingRecipe';
import {
  recipeIdentityOf,
  verifySaveGrant,
  type ShisoSaveGrant,
} from './core/shiso/saveAuthorization';
import type {
  ShisoIngredientEditArgs,
  ShisoRecipeEditOutcome,
  ShisoRecipeSaveOutcome,
} from './core/shiso/protocol';
import { playTimerChime } from './utils/audioAlert';
import { buildGalleryRoute, buildRecipeRoute, parseRecipeRoute } from './utils/recipeRoute';
import { APP_VERSION } from './version';
import ProviderSettings from './application-ui/ProviderSettings';
import { CodexAtelier } from './components/CodexAtelier';
import { CreateForMeModal } from './components/CreateForMeModal';
import { generatedDraftToObsidianRecipe, saveGeneratedRecipeToVault, GeneratedRecipePathCollisionError } from './application/createForMe';
import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from './schema/generatedRecipe';
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
import { FeaturedRecipe } from './components/FeaturedRecipe';
import { splitFeatured } from './utils/featuredRecipe';
import { MobileRecipeRow } from './components/MobileRecipeRow';
import { SideNav } from './components/SideNav';
import { BottomNav } from './components/BottomNav';
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
 * SHISO H-2 — the UNSAVED working copy of the selected recipe.
 *
 * `base` is the canonical recipe the working copy derives from (identity
 * binding); `working` is the edited recipe the UI displays; `changes` is the
 * bounded human-readable account; `history` is the per-edit undo record. This
 * state is memory-only: it is never persisted, and it is discarded on Save,
 * Discard, or any successful canonical write of the same recipe.
 */
type ShisoWorkingRecipeState = ShisoWorkingRecipeCore<ObsidianRecipe, ParsedIngredient>;

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

  // Vault Sync Status.
  // NOTE (UD-2A.2): there is deliberately NO count field here. The recipe and
  // note totals are derived from the canonical in-memory state (`recipes.length`
  // / `notes.length`) and passed to the interface as props, so a count can
  // never drift from the collection it describes.
  const [vaultStatus, setVaultStatus] = useState<VaultSyncStatus>({
    isConnected: false,
    vaultPath: DEFAULT_VAULT_PATH,
    accessType: 'starter_vault',
    connectionState: 'starter',
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
  // SHISO — one conversation, three entry points (global, recipe, nutrition).
  // `ShisoEntryProvider` lives in main.tsx ABOVE this component, so the context
  // is available here as well as inside the recipe / nutrition surfaces.
  const shiso = useShiso();

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
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreDialogRef = useRef<HTMLDialogElement>(null);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  useEffect(() => {
    const onResize = () => {
      // The recipe shelf switches between the card tree and the compact row
      // tree at 768px (Sol RV-2 tablet composition).
      const desktop = window.innerWidth >= 768;
      setIsDesktop(desktop);
      // The "More" sheet belongs to the bottom-navigation composition, which
      // ends at the desktop rail breakpoint.
      if (window.innerWidth >= 1024) setIsMoreOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const dlg = moreDialogRef.current;
    if (!dlg) return;
    if (isMoreOpen) {
      try {
        dlg.showModal();
      } catch {
        // already open
      }
    } else if (dlg.open) {
      dlg.close();
    }
  }, [isMoreOpen]);

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

  // SHISO H-2 — the UNSAVED working copy produced by authorized chat edits.
  // Memory-only: never persisted here, cleared on Save/Discard (or any
  // successful canonical write of the same recipe). A ref mirrors the state so
  // the conversation tools (which await between steps) always read the latest
  // working copy rather than a stale render closure.
  const [shisoWorkingRecipe, setShisoWorkingRecipe] = useState<ShisoWorkingRecipeState | null>(null);
  const shisoWorkingRecipeRef = useRef<ShisoWorkingRecipeState | null>(null);
  const updateShisoWorkingRecipe = useCallback((next: ShisoWorkingRecipeState | null) => {
    shisoWorkingRecipeRef.current = next;
    setShisoWorkingRecipe(next);
  }, []);

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
      connectionState: 'connected',
      vaultPath: result.folderName ? `Vault / ${result.folderName}` : s.vaultPath,
      folderHandle: folderHandle ?? s.folderHandle,
    }));
    setVaultHydrated(true);
    return true;
  }, []);

  // Re-authorise a REMEMBERED Vault and reconnect it. The browser only allows
  // `requestPermission()` from a user gesture, so this is invoked directly
  // from the "Reconnect Vault" button. It never writes to the Vault and never
  // clears the remembered handle: if the user declines, the Vault stays
  // remembered and the starter Vault is never presented as their data.
  const handleReconnectVault = useCallback(async () => {
    const outcome = await reconnectRememberedVault<LoadedVaultData>({
      getHandle: () => getDirectoryHandleFromIDB(),
      requestPermission: (handle: any) => handle.requestPermission({ mode: 'readwrite' }),
      load: (handle: any) => loadVaultFromHandle(handle),
    });
    if (outcome.status === 'reconnected') {
      const generation = vaultScanGeneration.current.begin();
      commitVaultSnapshot(outcome.data, generation);
      return;
    }
    if (outcome.status === 'no-handle' || outcome.status === 'unsupported') {
      // Nothing usable is remembered: fall back to the ordinary connect flow.
      setVaultStatus((s) => ({ ...s, isConnected: false, connectionState: 'starter' }));
      return;
    }
    // 'denied' and 'error': the Vault stays remembered, but the browser will
    // not re-authorise it — say so plainly instead of showing sample data.
    setVaultStatus((s) => ({ ...s, isConnected: false, connectionState: 'permission_denied' }));
  }, [commitVaultSnapshot]);

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
    document.title = `The Kitchen Codex ${APP_VERSION} — My Recipe Vault`;
  }, []);

  // 1. Reconnect to IndexedDB directory handle on mount if permission granted
  //    (UD-2A.2). The handle is persisted across browser restarts, but the
  //    browser's PERMISSION is session-scoped: after a restart `queryPermission`
  //    reports 'prompt'. The previous implementation treated anything other
  //    than 'granted' as "no vault" and silently fell back to the starter
  //    Vault, so a remembered Vault looked like a fresh install. The restore
  //    decision is now explicit: reconnect when permitted, otherwise remember
  //    the Vault and offer a user-gesture reconnect (requestPermission).
  useEffect(() => {
    let isMounted = true;
    async function restoreVaultConnection() {
      try {
        const handle = await getDirectoryHandleFromIDB();
        const permission = handle && typeof handle.queryPermission === 'function'
          ? await handle.queryPermission({ mode: 'readwrite' })
          : null;
        if (!isMounted) return;
        const action = resolveVaultRestoreAction(!!handle, permission);
        if (action.kind === 'reconnect') {
          const generation = vaultScanGeneration.current.begin();
          const result = await loadVaultFromHandle(handle);
          if (isMounted) {
            commitVaultSnapshot(result, generation, handle);
          }
          return;
        }
        if (action.kind === 'none') return;
        // The Vault IS remembered, but the browser will not re-authorise it
        // without a user gesture. Remember it and surface an explicit
        // "Reconnect Vault" action — never silently present the starter Vault
        // as though it were the user's connected Vault.
        setVaultStatus((s) => ({
          ...s,
          isConnected: false,
          accessType: 'starter_vault',
          connectionState: connectionStateForRestoreAction(action),
          rememberedVaultName:
            handle && typeof handle.name === 'string' ? handle.name : undefined,
        }));
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
  //
  // The document element is the SINGLE theme scope. The previous composition
  // also rendered `data-theme` on the application root, which meant a partial
  // theme application (for example an external screenshot harness setting only
  // `<html>`) left the root's semantic variables on the old palette while
  // legacy class remaps switched to the new one. That is exactly how a dark
  // page and a light-theme heading can end up in the same frame. Applying the
  // attribute in a layout effect removes that split and prevents a first-paint
  // flash.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme === 'parchment' ? 'light' : 'dark';
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
      // A NEW vault replaces the note set outright (UD-2A.2). Leaving the
      // previous vault's notes in place would make the note count describe a
      // Vault the user is no longer connected to.
      setNotes(parsed.notes || []);
      if (parsed.mealPlan) setMealPlan(parsed.mealPlan);
      if (parsed.shoppingList) setShoppingCategories(parsed.shoppingList);

      if (parsed.recipes.length > 0 || parsed.mealPlan || parsed.shoppingList || (parsed.notes && parsed.notes.length > 0)) {
        setVaultStatus((prev) => ({
          ...prev,
          isConnected: true,
          accessType: 'uploaded_folder',
          connectionState: 'connected',
        }));
      }
    } catch (err) {
      console.error('Failed to import files:', err);
    }
  };

  // Save / Update Recipe
  //
  // H-2: the canonical write is factored into `commitRecipeWrite` so the SHISO
  // save capability uses the very SAME authoritative path as the editor. Any
  // successful canonical write also RESOLVES the unsaved SHISO working copy for
  // that recipe (the written recipe now contains those changes).
  const commitRecipeWrite = useCallback(
    async (savedRecipe: ObsidianRecipe) => {
      if (vaultAdapter) {
        await saveRecipeWithVaultAdapter(vaultAdapter, savedRecipe);
      } else {
        // Disconnected workflow: preserve the existing download-to-disk fallback.
        await saveRecipeToVaultFile(savedRecipe, undefined);
      }
      setRecipes((prev) => upsertCanonicalRecipe(prev, savedRecipe));
      setSelectedRecipe((prev) => (prev && sameCanonicalRecipeIdentity(prev, savedRecipe) ? savedRecipe : prev));
      const working = shisoWorkingRecipeRef.current;
      if (working !== null && sameCanonicalRecipeIdentity(working.base, savedRecipe)) {
        updateShisoWorkingRecipe(null);
      }
    },
    [vaultAdapter, updateShisoWorkingRecipe],
  );

  const handleSaveRecipe = async (savedRecipe: ObsidianRecipe) => {
    // Write FIRST: Obsidian Markdown is the canonical source of truth. React state is
    // only updated AFTER the canonical write succeeds, so a failed write leaves the
    // prior canonical state (and the open editor) intact (defect C).
    try {
      await commitRecipeWrite(savedRecipe);
    } catch (err) {
      // Surface the failure; do NOT claim persistence succeeded (editor stays open).
      reportVaultError('save', savedRecipe.title || 'recipe', err);
      throw err;
    }
    setIsEditorOpen(false);
    setEditingRecipe(null);
  };

  /**
   * H-2 — applies structured ingredient edits to the UNSAVED working copy
   * through the ONE core editing engine. The core function re-derives every
   * line reference against the CURRENT recipe, so a stale reference fails
   * closed. Nothing is written here; the working copy is memory-only until the
   * user explicitly saves.
   */
  const applyShisoEdits = useCallback(
    async (edits: readonly ShisoIngredientEditArgs[]): Promise<ShisoRecipeEditOutcome> => {
      const currentWorking = shisoWorkingRecipeRef.current;
      const base =
        currentWorking !== null &&
        selectedRecipe !== null &&
        sameCanonicalRecipeIdentity(currentWorking.base, selectedRecipe)
          ? currentWorking.working
          : selectedRecipe;
      if (base === null) {
        return {
          ok: false,
          applied: [],
          refused: [],
          summary: 'No recipe is open to edit.',
          working_unsaved: false,
          note: '',
        };
      }
      const result = applyShisoIngredientEdits(base, edits);
      if (result.ok !== true) {
        const failure = result as { message?: string };
        return {
          ok: false,
          applied: [],
          refused: [],
          summary: failure.message ?? 'No ingredient change could be applied.',
          working_unsaved: false,
          note: '',
        };
      }
      const sameWorking =
        currentWorking !== null && sameCanonicalRecipeIdentity(currentWorking.base, base)
          ? currentWorking
          : null;
      const next = extendWorkingRecipe<ObsidianRecipe, ParsedIngredient>({
        current: sameWorking,
        base,
        working: result.recipe as unknown as ObsidianRecipe,
        ledger: result.ledger.map((entry) => ({
          index: entry.index,
          previous: entry.previous as ParsedIngredient,
        })),
        changeLines: result.applied.map((entry) => `${entry.before} → ${entry.after}`.slice(0, 300)),
        maxChanges: 24,
      });
      updateShisoWorkingRecipe(next);
      return {
        ok: true,
        applied: result.applied,
        refused: result.refused,
        summary: result.summary,
        working_unsaved: true,
        note:
          'Saved: no. These changes exist only in the UNSAVED working copy. Say so plainly, and tell the user ' +
          'they can review the changes and save when they are ready.',
      };
    },
    [selectedRecipe, updateShisoWorkingRecipe],
  );

  /**
   * H-2 — one-step undo: restores the ingredient a single edit replaced. This
   * is the visible undo path for authorized chat edits.
   */
  const undoLastShisoEdit = useCallback(() => {
    const current = shisoWorkingRecipeRef.current;
    if (current === null) return;
    const next = undoLastWorkingEdit<ObsidianRecipe, ParsedIngredient>(current, (working, index, previous) => {
      const ingredients = [...(working.ingredients as ParsedIngredient[])];
      if (ingredients[index] === undefined) return null;
      ingredients[index] = previous;
      return { ...working, ingredients, rawMarkdown: '' };
    });
    if (next !== null) updateShisoWorkingRecipe(next);
  }, [updateShisoWorkingRecipe]);

  /**
   * H-2 — persists the UNSAVED working recipe through the EXISTING canonical
   * save path.
   *
   * H-2 SECURITY (the adversarial boundary): before ANY write this owner
   * INDEPENDENTLY re-verifies the save grant:
   *
   *   - the grant must be structurally authorized (only the trusted entry
   *     surface constructs one; a model tool call cannot);
   *   - an assistant-initiated grant must be bound to the SAME recipe identity
   *     that is actually being saved, so a stale (recipe switched) or replayed
   *     authorization fails closed.
   *
   * The visible Save control passes a `ui` grant (the trusted user event is its
   * own authorization).
   */
  const saveShisoWorkingRecipe = useCallback(
    async (grant?: ShisoSaveGrant): Promise<ShisoRecipeSaveOutcome> => {
      const current = shisoWorkingRecipeRef.current;
      if (current === null) {
        return {
          ok: true,
          saved: false,
          reason_code: 'nothing_unsaved',
          message: 'There is nothing to save — this recipe has no unsaved changes from Shiso.',
        };
      }
      const verdict = verifySaveGrant(grant, recipeIdentityOf(current.base));
      if (verdict.ok !== true) {
        return {
          ok: false,
          saved: false,
          reason_code: verdict.reason,
          message:
            verdict.reason === 'stale_recipe'
              ? 'That save was authorized for a different recipe, so nothing was saved. Ask again for this recipe.'
              : 'Saving needs your explicit instruction (for example “save my changes”) or the Save button. Nothing was saved.',
        };
      }
      try {
        await commitRecipeWrite(current.working);
      } catch (err) {
        reportVaultError('save', current.working.title || 'recipe', err);
        return { ok: false, saved: false, reason_code: 'write_failed', message: 'The recipe could not be saved to the vault.' };
      }
      // A canonical write happened: invalidate any vault scan that STARTED before
      // it so a stale scan can never overwrite the just-saved recipe.
      vaultScanGeneration.current.begin();
      updateShisoWorkingRecipe(null);
      return {
        ok: true,
        saved: true,
        message: `Saved "${current.working.title}" with ${current.changes.length + Number(JSON.stringify(current.working.codexNutrition ?? null) !== JSON.stringify(current.base.codexNutrition ?? null))} recipe change(s).`,
      };
    },
    [commitRecipeWrite, updateShisoWorkingRecipe],
  );

  // SHISO H-2 — register the recipe-edit/save applier with the ONE Shiso entry
  // point surface. The registered functions always read the latest working copy
  // through the ref, so a mid-turn edit can never be applied against stale
  // state. An absent applier makes every edit capability fail closed.
  const registerRecipeEditApplier = shiso.registerRecipeEditApplier;
  useEffect(() => {
    return registerRecipeEditApplier({
      applyEdits: (edits) => applyShisoEdits(edits),
      save: (grant) => saveShisoWorkingRecipe(grant),
      discard: () => updateShisoWorkingRecipe(null),
    });
  }, [registerRecipeEditApplier, applyShisoEdits, saveShisoWorkingRecipe, updateShisoWorkingRecipe]);

  // Publish the bounded working-copy summary (the ONE visible banner account).
  const publishWorkingRecipe = shiso.publishWorkingRecipe;
  const shisoWorkingForSelected =
    shisoWorkingRecipe !== null &&
    selectedRecipe !== null &&
    sameCanonicalRecipeIdentity(shisoWorkingRecipe.base, selectedRecipe)
      ? shisoWorkingRecipe
      : null;
  const shisoWorkingChangeLines = useMemo(
    () => shisoWorkingForSelected === null
      ? []
      : [
          ...shisoWorkingForSelected.changes,
          ...(JSON.stringify(shisoWorkingForSelected.working.codexNutrition ?? null) !== JSON.stringify(shisoWorkingForSelected.base.codexNutrition ?? null)
            ? ['Advanced Nutrition applied']
            : []),
        ],
    [shisoWorkingForSelected],
  );
  useEffect(() => {
    if (shisoWorkingForSelected === null) {
      publishWorkingRecipe(null);
      return;
    }
    publishWorkingRecipe({
      unsaved: true,
      nutrition_unsaved: JSON.stringify(shisoWorkingForSelected.working.codexNutrition ?? null) !==
        JSON.stringify(shisoWorkingForSelected.base.codexNutrition ?? null),
      change_count: shisoWorkingChangeLines.length,
      changes: shisoWorkingChangeLines,
    });
  }, [shisoWorkingForSelected, shisoWorkingChangeLines, publishWorkingRecipe]);

  /**
   * H-2 — the recipe every surface DISPLAYS: the unsaved working copy when one
   * exists for the selected recipe, otherwise the canonical recipe. Advanced
   * Nutrition, the detail view and the Shiso conversation all read this, so an
   * authorized edit is immediately visible everywhere.
   */
  const displayRecipe: ObsidianRecipe | null =
    shisoWorkingForSelected?.working ?? selectedRecipe;

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
    // H-2: a canonical write of the displayed (working) recipe resolves the
    // unsaved SHISO working copy for that recipe.
    const workingAfterNutrition = shisoWorkingRecipeRef.current;
    if (workingAfterNutrition !== null && sameCanonicalRecipeIdentity(workingAfterNutrition.base, updatedRecipe)) {
      updateShisoWorkingRecipe(null);
    }
  };

  // Phase 5B: Apply moves the freshly authorized nutrition block into the
  // unsaved recipe working copy. The existing banner's explicit Save to vault
  // action remains the only persistence boundary.
  const handleApplyAdvancedNutrition: AdvancedNutritionApplyHandler = async (
    args: AdvancedNutritionApplyHandlerArgs
  ): Promise<AdvancedNutritionApplyUiResult> => {
    const result = await applyAdvancedNutrition({
      session: args.session,
      recipe: args.recipe,
      state: args.state,
      expectedMode: args.expectedMode,
      write: async (updated: ObsidianRecipe) => {
        const existingWorking = shisoWorkingRecipeRef.current;
        const sameWorking = existingWorking !== null && sameCanonicalRecipeIdentity(existingWorking.base, updated)
          ? existingWorking
          : null;
        const selectedBase = selectedRecipe !== null && sameCanonicalRecipeIdentity(selectedRecipe, updated)
          ? selectedRecipe
          : args.recipe;
        const base = sameWorking?.base ?? selectedBase;
        updateShisoWorkingRecipe(Object.freeze({
          base,
          working: updated,
          // Keep the ingredient-only undo history aligned with `changes`; the
          // nutrition change is reported separately in the working banner.
          changes: sameWorking?.changes ?? Object.freeze([]),
          history: sameWorking?.history ?? Object.freeze([]),
        }));
      },
    });

    if (result.ok) {
      return {
        ok: true,
        mode: result.result.mode,
        message: 'Nutrition was applied to the working recipe. It is not saved to your Vault yet; use Save to vault in the recipe banner when ready.',
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
    recipe,
  }) => {
    // Phase 9B-3C: build the WHOLE-recipe semantic source from the authored
    // recipe and the SAME deterministic adapter the card already used, so the
    // requested line references are the exact canonical ones — never fabricated.
    // Every authored ingredient goes in ORIGINAL order, and the complete bounded
    // instruction list is included: whole-recipe interpretation reasons over the
    // instructions, so sending only the exception rows would discard that context.
    let wholeRecipe: WholeRecipeSemanticSource | undefined;
    if (recipe !== undefined) {
      const ingredients = recipe.ingredients
        .map((ingredient) => ingredient.original ?? ingredient.name ?? '')
        .map((original) => original.trim())
        .filter((original) => original.length > 0);
      const targetLineRefs = rows
        .map((row) => row.line_ref)
        .filter((lineRef): lineRef is string => typeof lineRef === 'string' && lineRef.length > 0);
      if (ingredients.length > 0 && targetLineRefs.length > 0) {
        wholeRecipe = {
          recipe: { ingredients: ingredients.map((name) => ({ name })) },
          instructions: recipe.instructions.map((step) => ({ text: step.text })),
          targets: targetLineRefs.map((line_ref) => ({ line_ref })),
        };
      }
    }
    return resolveUnresolvedRowsWithAi({
      network: networkAdapter,
      session,
      rows,
      adapted,
      issueKinds,
      liveRows,
      state,
      capabilities: await resolveEffectiveNutritionCapabilitiesOnce(),
      liveCanonicalInterpretation: true,
      ...(wholeRecipe !== undefined ? { wholeRecipe } : {}),
    });
  };

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

  // The vault result count only switches to the "Showing X of Y" form while a
  // search or filter is actually active, so the number is never printed twice.
  const vaultResultIsFiltered = Boolean(searchQuery) || activeFilterCount > 0;

  // Deterministic featured selection is computed once for the spread and the
  // editorial folio line. No recommendation logic or persisted pin is added.
  const featuredSelection = useMemo(() => splitFeatured(filteredRecipes), [filteredRecipes]);
  const featuredPosition = featuredSelection.featured
    ? filteredRecipes.indexOf(featuredSelection.featured) + 1
    : 0;

  // The page introduction states the same connection truth as the header and
  // sidebar. Starter recipes are never introduced as the owner's private Vault.
  const vaultConnectionState = vaultStatus.connectionState ?? (vaultStatus.isConnected ? 'connected' : 'starter');
  const vaultNeedsReconnect =
    vaultConnectionState === 'reauthorization_required' || vaultConnectionState === 'permission_denied';
  const liveFilesystemVault = vaultStatus.isConnected && vaultStatus.accessType === 'filesystem_api';
  const vaultStateEyebrow =
    vaultConnectionState === 'permission_denied'
      ? 'Vault access denied'
      : vaultConnectionState === 'reauthorization_required'
        ? 'Vault awaiting access'
        : vaultStatus.isConnected
          ? liveFilesystemVault
            ? 'Private vault'
            : 'Imported collection'
          : 'Starter collection';
  const vaultIntroduction =
    vaultConnectionState === 'permission_denied'
      ? 'The browser refused access to your remembered Vault. Reconnect, or choose the folder again, to restore your own recipes.'
      : vaultConnectionState === 'reauthorization_required'
        ? 'Your Vault is remembered, but the browser needs your permission before its recipes can be shown.'
        : vaultStatus.isConnected
          ? liveFilesystemVault
            ? 'Your saved recipes, gathered from the connected Vault.'
            : 'Recipes loaded from your files for this session.'
          : "Sample recipes from the Starter Vault. Connect your own folder whenever you're ready.";

  const vaultHealthSummary = useMemo(() => {
    return summarizeVaultHealth(recipes);
  }, [recipes]);

  return (
    <div
      className="relative flex min-h-screen flex-col bg-[var(--bg-root,#0C0C0C)] font-sans text-[var(--text-primary,#F3F4F6)] transition-colors duration-200 selection:bg-amber-500/30 selection:text-amber-200 lg:flex-row"
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
              connectionState: 'connected',
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
          <div className="max-w-md rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-8 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--accent-text,#F59E0B)] motion-safe:animate-bounce">
              <FolderOpen className="h-8 w-8" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <h3 className="mb-1 font-serif text-[20px] font-semibold text-[var(--text-primary,#F3F4F6)]">
              Drop Recipe Files or Folder
            </h3>
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
              Release to instantly parse recipes, notes, Meal Plan.md, and Shopping List.md into The Kitchen Codex.
            </p>
          </div>
        </div>
      )}

      {/* Lightweight adapter save/delete error surface (inline alert, no new framework) */}
      {vaultError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-2rem)] max-w-xl">
          <div className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-surface,#141414)] px-4 py-3 text-[var(--text-primary,#F3F4F6)] shadow-2xl">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" strokeWidth={1.75} aria-hidden="true" />
            <p className="flex-1 text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">{vaultError}</p>
            <button
              onClick={clearVaultError}
              className="min-h-[40px] shrink-0 rounded-md px-2 text-[12px] text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-elevated,#1E1E1E)]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Unified application shell — desktop sidebar */}
      <SideNav
        activeTab={activeTab}
        setActiveTab={(tab) => {
          setActiveTab(tab);
          setSelectedRecipe(null);
          setIsMoreOpen(false);
        }}
        vaultStatus={vaultStatus}
        recipeCount={recipes.length}
        noteCount={notes.length}
        onReconnectVault={handleReconnectVault}
        onOpenConnectVaultModal={() => setIsConnectVaultOpen(true)}
        onOpenNewRecipeModal={() => {
          setEditingRecipe(null);
          setIsEditorOpen(true);
        }}
        onOpenAskMyKitchen={() => setIsAskMyKitchenOpen(true)}
        onOpenCreateForMe={() => setIsCreateForMeOpen(true)}
        onOpenRecipeGrabber={() => setIsGrabberOpen(true)}
        onOpenVaultIntelligence={() => {
          setVaultIntelligenceRecipeId(null);
          setIsVaultIntelligenceOpen(true);
        }}
        legacyRecipeCount={vaultHealthSummary.legacyCount + vaultHealthSummary.incompleteCount}
        onShisoOpen={() => shiso.open('global')}
        onFavorites={() => {
          setFilters((f) => ({ ...f, onlyFavorites: true }));
          setActiveTab('grid');
          setSelectedRecipe(null);
        }}
      />

      <div className="flex-1 flex flex-col min-w-0">
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
        recipeCount={recipes.length}
        noteCount={notes.length}
        onReconnectVault={handleReconnectVault}
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
        onOpenCreateForMe={() => shiso.open('create')}
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

      {/* Main View Router — the bottom navigation is fixed below 1024px, so the
          content column reserves 116px of clearance (Sol: ≥110px). */}
      <main className="flex-1 pb-[116px] lg:pb-0">
        {selectedRecipe && displayRecipe ? (
          <>
            {/* SHISO H-2 — the ONE visible account of unauthorized-not-yet-saved
                chat edits, with Save, one-step Undo, and Discard. */}
            {shisoWorkingForSelected !== null && (
              <div
                data-testid="shiso-working-recipe-banner"
                className="max-w-5xl mx-auto mt-4 kc-vault-surface"
              >
                <div className="rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-teal-100">
                      <strong>Unsaved recipe changes.</strong>{' '}
                      {shisoWorkingChangeLines.length} change
                      {shisoWorkingChangeLines.length === 1 ? '' : 's'} are in the working copy. Your Vault recipe is unchanged until you save.
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="shiso-banner-save"
                        onClick={() =>
                          void saveShisoWorkingRecipe({
                            authorized: true,
                            via: 'ui',
                            recipe_identity: '',
                            turn: 0,
                          })
                        }
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-teal-500/25 text-teal-100 border border-teal-500/40 hover:bg-teal-500/35"
                      >
                        Save to vault
                      </button>
                      <button
                        type="button"
                        data-testid="shiso-banner-undo"
                        disabled={shisoWorkingForSelected.history.length === 0}
                        onClick={undoLastShisoEdit}
                        className="text-[11px] px-2.5 py-1 rounded-lg border border-white/15 text-gray-200 hover:bg-white/5 disabled:opacity-40"
                      >
                        Undo last ingredient change
                      </button>
                      <button
                        type="button"
                        data-testid="shiso-banner-discard"
                        onClick={() => updateShisoWorkingRecipe(null)}
                        className="text-[11px] px-2.5 py-1 rounded-lg border border-white/15 text-gray-200 hover:bg-white/5"
                      >
                        Discard changes
                      </button>
                    </div>
                  </div>
                  <ul className="space-y-0.5">
                    {shisoWorkingChangeLines.slice(-4).map((change, index) => (
                      <li key={`${index}-${change}`} className="text-[11px] text-teal-200/90">• {change}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <RecipeDetailView
              recipe={displayRecipe}
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
          </>
        ) : activeTab === 'grid' ? (
          /* Vault page — Signature Edition reading order:
             state · introduction · actions · search/filters · feature · shelf. */
          <div id="vault-gallery-page" className="mx-auto w-full max-w-7xl kc-vault-surface pb-16">
            <section
              aria-labelledby="vault-page-title"
              className="border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-6 pt-7 md:pb-7 md:pt-9"
            >
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                  <p className="kc-eyebrow flex items-center gap-2">
                    <span className="h-px w-6 bg-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                    {vaultStateEyebrow}
                  </p>
                  <h1
                    id="vault-page-title"
                    className="kc-vault-page-title mt-3 font-serif font-medium text-[var(--text-primary,#F3F4F6)]"
                  >
                    My Recipe Vault
                  </h1>
                  <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-[var(--text-secondary,#9CA3AF)] md:text-[15px]">
                    {vaultIntroduction}
                  </p>
                  {vaultNeedsReconnect && (
                    <>
                      <button
                        type="button"
                        onClick={handleReconnectVault}
                        className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-3 text-sm font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-amber-500/20"
                      >
                        <BookOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                        Reconnect Vault
                      </button>
                      <div
                        data-testid="starter-preview-banner"
                        role="note"
                        className="mt-5 max-w-2xl border-l-2 border-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] px-4 py-3"
                      >
                        <p className="text-[13px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                          <strong className="text-[var(--text-primary,#F3F4F6)]">Starter Vault preview.</strong>{' '}
                          These are sample recipes, not the recipes in your remembered Vault. Reconnect to restore your own collection.
                        </p>
                      </div>
                    </>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  <button
                    id="create-new-recipe-btn"
                    type="button"
                    onClick={() => {
                      setEditingRecipe(null);
                      setIsEditorOpen(true);
                    }}
                    className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-sm bg-[var(--accent,#F59E0B)] px-5 text-sm font-semibold text-[var(--accent-contrast,#0C0C0C)] transition-colors duration-[140ms] hover:bg-[var(--accent-hover,#D97706)]"
                  >
                    <Plus className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                    New Recipe Note
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsAskMyKitchenOpen(true)}
                    className="hidden min-h-[48px] items-center justify-center gap-2 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-4 text-sm font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)] lg:inline-flex"
                  >
                    <Sparkles className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    Ask My Kitchen
                  </button>
                </div>
              </div>
            </section>

            <section
              aria-label="Search and filter recipes"
              className="border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] py-3.5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1 sm:max-w-[600px]">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-secondary,#9CA3AF)]"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <input
                    id="recipe-search-input"
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search recipes, tags, ingredients…"
                    aria-label="Search recipes"
                    className="h-[52px] w-full rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] pl-10 pr-12 text-[15px] text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] focus:border-[var(--accent-text,#F59E0B)]"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-0.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-sm text-[var(--text-secondary,#9CA3AF)] transition-colors hover:text-[var(--text-primary,#F3F4F6)]"
                      aria-label="Clear search"
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 sm:justify-start">
                  <button
                    id="toggle-filters-btn"
                    type="button"
                    onClick={() => setIsFilterOpen((prev) => !prev)}
                    aria-label={activeFilterCount > 0 ? `Filters (${activeFilterCount} active)` : 'Filters'}
                    aria-expanded={isFilterOpen}
                    className={`inline-flex min-h-[52px] items-center justify-center gap-2 rounded-sm border px-4 text-sm font-medium transition-colors duration-[140ms] ${
                      isFilterOpen || activeFilterCount > 0
                        ? 'border-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--text-primary,#F3F4F6)]'
                        : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]'
                    }`}
                  >
                    <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    Filters
                    {activeFilterCount > 0 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--accent,#F59E0B)] px-1 text-[10px] font-bold text-[var(--accent-contrast,#0C0C0C)]">
                        {activeFilterCount}
                      </span>
                    )}
                  </button>

                  <p
                    className="whitespace-nowrap text-[12px] font-medium uppercase tracking-[0.12em] text-[var(--text-secondary,#9CA3AF)]"
                    aria-live="polite"
                  >
                    {vaultResultIsFiltered
                      ? `Showing ${filteredRecipes.length} of ${recipes.length}`
                      : `${recipes.length} ${recipes.length === 1 ? 'recipe' : 'recipes'}`}
                  </p>
                </div>
              </div>
            </section>

            {filteredRecipes.length === 0 ? (
              <div className="mt-8 border border-dashed border-[var(--border-subtle,rgba(255,255,255,0.08))] px-6 py-16 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--accent-text,#F59E0B)]">
                  <SearchX className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                </div>
                <h2 className="mt-5 font-serif text-3xl font-medium text-[var(--text-primary,#F3F4F6)]">
                  No matching recipes found
                </h2>
                <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                  Try adjusting your search terms, clearing active tag filters, or creating and importing new recipe notes.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setFilters(INITIAL_FILTERS);
                    }}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-sm bg-[var(--accent,#F59E0B)] px-4 text-sm font-semibold text-[var(--accent-contrast,#0C0C0C)] transition-colors hover:bg-[var(--accent-hover,#D97706)]"
                  >
                    <RotateCcw className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    Reset All Filters
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsGrabberOpen(true)}
                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-4 text-sm font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
                  >
                    <Globe2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    Grab Recipe from Web
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-12 pt-7 md:space-y-16 md:pt-8">
                {featuredSelection.featured && (
                  <FeaturedRecipe
                    key={`featured-${featuredSelection.featured.id}`}
                    recipe={featuredSelection.featured}
                    index={featuredPosition}
                    total={filteredRecipes.length}
                    onSelectRecipe={(recipe) => setSelectedRecipe(recipe)}
                    onStartCooking={(recipe) => handleStartCooking(recipe)}
                    onToggleFavorite={handleToggleFavorite}
                    onAddToMealPlan={(recipe) => handleAddToMealPlan(recipe)}
                  />
                )}

                {featuredSelection.rest.length > 0 && (
                  <section aria-labelledby="recipe-shelf-heading">
                    <div className="flex items-end justify-between gap-4 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-4">
                      <div>
                        <p className="kc-eyebrow">The rest of the collection</p>
                        <h2
                          id="recipe-shelf-heading"
                          className="kc-section-title mt-2 font-serif font-medium text-[var(--text-primary,#F3F4F6)]"
                        >
                          On the shelf
                        </h2>
                      </div>
                      <p className="pb-1 text-[12px] font-medium uppercase tracking-[0.12em] text-[var(--text-secondary,#9CA3AF)]">
                        {featuredSelection.rest.length}{' '}
                        {featuredSelection.rest.length === 1 ? 'recipe' : 'recipes'}
                      </p>
                    </div>

                    {isDesktop ? (
                      <div className="kc-vault-grid pt-7">
                        {featuredSelection.rest.map((recipe) => (
                          <RecipeCard
                            key={recipe.id}
                            recipe={recipe}
                            onSelectRecipe={(item) => setSelectedRecipe(item)}
                            onStartCooking={(item) => handleStartCooking(item)}
                            onToggleFavorite={handleToggleFavorite}
                            onAddToMealPlan={(item) => handleAddToMealPlan(item)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="divide-y divide-[var(--border-subtle,rgba(255,255,255,0.08))]">
                        {featuredSelection.rest.map((recipe) => (
                          <div key={recipe.id} className="py-5 first:pt-6">
                            <MobileRecipeRow
                              recipe={recipe}
                              onSelectRecipe={(item) => setSelectedRecipe(item)}
                              onStartCooking={(item) => handleStartCooking(item)}
                              onToggleFavorite={handleToggleFavorite}
                              onAddToMealPlan={(item) => handleAddToMealPlan(item)}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}
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
          /* The Codex Atelier — unified AI Studio workspace (UD-2B) */
          <CodexAtelier
            network={networkAdapter}
            settings={settingsAdapter}
            onTextAiRuntimeChanged={invalidateNutritionReadiness}
          />
        ) : (
          /* Themes View */
          <div className="max-w-7xl mx-auto kc-vault-surface py-6">
            <ThemesView
              currentTheme={theme}
              onSelectTheme={(newTheme) => setTheme(newTheme)}
            />
          </div>
        )}
      </main>

      {/* App Footer — below 1024px the fixed bottom navigation overlays the
          last 76–80px of the viewport, so the footer reserves that space and
          its own content stays clear of the navigation. */}
      <footer className="mt-auto border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)]">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 kc-vault-surface py-4 pb-[92px] text-sm text-[var(--text-secondary,#9CA3AF)] sm:flex-row lg:pb-4">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text-primary,#F3F4F6)]">My Recipe Vault</span>
            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
              {APP_VERSION}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span>Obsidian Compatible</span>
            <span>•</span>
            <span>Local-First &amp; Schema v1 Compliant</span>
          </div>
        </div>
      </footer>

      </div>

      {/* Mobile bottom navigation */}
      <BottomNav
        activeTab={activeTab}
        onVault={() => {
          setActiveTab('grid');
          setSelectedRecipe(null);
          // The mobile header scrolls away with the document (the recipe rows
          // own the screen), so the Vault destination returns to the top where
          // the brand row and the search field live.
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onStudio={() => {
          setActiveTab('providers');
          setSelectedRecipe(null);
        }}
        onShiso={() => shiso.open('global')}
        onMore={() => setIsMoreOpen(true)}
      />

      {/* More dialog (below the desktop rail breakpoint) */}
      {isMoreOpen && (
        <dialog
          ref={moreDialogRef}
          aria-labelledby="more-dialog-title"
          onClose={() => setIsMoreOpen(false)}
          className="fixed inset-0 z-50 m-0 h-full w-full max-w-none max-h-none border-0 bg-transparent p-0 lg:hidden"
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setIsMoreOpen(false)} />
          <div
            className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-2xl border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-[var(--text-primary,#F3F4F6)] shadow-2xl"
            role="document"
          >
            <div className="mb-3 flex items-center justify-between">
              <div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">The Kitchen Codex</p><h2 id="more-dialog-title" className="font-serif text-[22px] text-[var(--text-primary,#F3F4F6)]">More</h2></div>
              <button
                onClick={() => setIsMoreOpen(false)}
                aria-label="Close More menu"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-elevated,#1E1E1E)] hover:text-[var(--text-primary,#F3F4F6)]"
              >
                <X className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            {[
              { label: 'New Recipe Note', action: () => { setEditingRecipe(null); setIsEditorOpen(true); } },
              { label: 'Create with SHISO', action: () => setIsCreateForMeOpen(true) },
              { label: 'Grab from Web', action: () => setIsGrabberOpen(true) },
              { label: 'Vault Intelligence', action: () => { setVaultIntelligenceRecipeId(null); setIsVaultIntelligenceOpen(true); } },
              { label: 'Meal Planner', action: () => setActiveTab('mealplan') },
              { label: 'Shopping List', action: () => setActiveTab('shopping') },
              { label: 'Themes', action: () => setActiveTab('themes') },
              { label: 'AI Settings', action: () => setActiveTab('providers') },
              { label: 'Connect Vault', action: () => setIsConnectVaultOpen(true) },
              { label: 'Ask My Kitchen', action: () => setIsAskMyKitchenOpen(true) },
              { label: 'Dataview Table', action: () => setActiveTab('dataview') },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => {
                  item.action();
                  setSelectedRecipe(null);
                  setIsMoreOpen(false);
                }}
                className="flex min-h-[48px] w-full items-center justify-between rounded-lg px-3 text-left text-[15px] text-[var(--text-primary,#F3F4F6)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)]"
              >
                <span>{item.label}</span>
                <ChevronRight className="h-4 w-4 text-[var(--text-muted,#6B7280)]" strokeWidth={1.75} aria-hidden="true" />
              </button>
            ))}
          </div>
        </dialog>
      )}

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
        setNotes={setNotes}
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

      {/* SHISO — one conversational surface, opened from the global header,
          a recipe, or Advanced Nutrition. It holds no mutation authority. */}
      <ShisoModal
        isOpen={shiso.isOpen}
        onClose={shiso.close}
        network={networkAdapter}
        recipe={shiso.source === 'create' ? null : displayRecipe}
        nutritionSession={advancedNutritionBundle.session}
        loadNutritionBundle={async () => {
          // Calls the SAME controller the user's own "Load USDA data" button
          // calls. Deliberately no polling and no timer: the controller installs
          // the session when it is ready and the next Shiso turn observes it.
          advancedNutritionBundle.load();
        }}
        nutritionRows={shiso.snapshot?.rows ?? []}
        nutritionAiContributions={shiso.snapshot?.aiContributions ?? []}
        nutritionReviewRows={shiso.snapshot?.reviewRows ?? []}
        nutritionSummary={shiso.snapshot?.summary ?? null}
        nutritionUnsaved={shiso.snapshot?.unsaved ?? false}
        onSaveCreatedDraft={async (draft: GeneratedRecipeDraft, provenance: GeneratedRecipeProvenance) => {
          const recipeToSave = generatedDraftToObsidianRecipe({ draft, provenance });
          await handleSaveGeneratedRecipe(recipeToSave);
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
