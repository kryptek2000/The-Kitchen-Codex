import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { AlertTriangle, BookOpen, ChevronRight, FolderOpen, Globe2, Plus, RotateCcw, Search, SearchX, SlidersHorizontal, Sparkles, Star, X } from 'lucide-react';
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
import {
  DEFAULT_VAULT_PATH,
  getStarterVaultRecipes,
  isBuiltInRecipe,
  STARTER_MEAL_PLAN,
  STARTER_SHOPPING_CATEGORIES,
} from './data/starterVault';
import {
  buildSavedStarterCopy,
  importSignatureStarterCollection,
  saveStarterRecipeToVault,
  type SignatureImportSummary,
  type StarterSaveResult,
} from './application/starterCollection';
import {
  connectionStateForRestoreAction,
  queryVaultWritePermission,
  reconnectRememberedVault,
  resolveVaultRestoreAction,
  type VaultWritePermission,
} from './core/vaultConnection';
import {
  createVaultSessionAuthority,
  type VaultCollectionIntent,
  type VaultSession,
  type VaultSessionKind,
  type VaultTransition,
} from './core/vaultSession';
import type { VaultAdapter } from './application/adapters/VaultAdapter';
import { createVaultAssetScope, type SessionAssetRunner, type VaultAssetScope, type VaultCollectionImportStart } from './utils/vaultAssets';
import { validateRecipeAssetReferences } from './utils/assetReferences';
import { createSessionAssetRunner } from './utils/sessionAssets';
import { VaultAssetScopeProvider } from './hooks/VaultAssetScopeContext';
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
import { rebaseRecipeOntoLatest, enqueueRecipeWrite as enqueueRecipeWriteHelper, normalizeRecipeWriteKey } from './application/recipeWriteCoordination';
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
import {
  beginDesktopInitialization,
  completeDesktopInitialization,
  createDesktopDirectoryHandle,
  ensureDesktopManagedVault,
  getDesktopVaultInfo,
  isDesktopDirectoryHandle,
  isDesktopRuntime,
  openDesktopVaultFolder,
  seedStarterCopies,
  setDesktopActiveVault,
} from './platform/desktop';
import { saveGeneratedRecipeImageToVault, hashCanonicalMarkdown, type GeneratedImageSaveResult } from './application/recipeImageSave';
import { hydrateAiSelections } from './application/aiSelection';
import {
  resolveUnresolvedRowsWithAi,
  type WholeRecipeSemanticSource,
} from './application/nutritionAiResolve';
import { AI_FIRST_GENERATE_ENABLED, resolveWithAiFirst } from './application/nutritionAiFirst';
import { requestNutritionWebResearch } from './application/nutritionWebResearch';
import {
  requestUsdaBrandedFoodLookup,
  verifyUsdaBrandedContributionsForApply,
} from './application/nutritionBrandedFoods';
import { brandedReviewIdentity } from './core/nutritionV2/brandedEvidenceTrust';
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
  normalizeCanonicalPath,
  deriveVaultSnapshotState,
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
import { createVoiceCache } from './application/voiceCache';
import type {
  AdvancedNutritionAiResolveHandler,
  AdvancedNutritionResearchHandler,
  AdvancedNutritionBrandedLookupHandler,
  AdvancedNutritionAiEstimateHandler,
  AdvancedNutritionRecipeContextReviewHandler,
  AdvancedNutritionApplyHandler,
  AdvancedNutritionApplyHandlerArgs,
  AdvancedNutritionApplyUiResult,
} from './components/AdvancedNutritionCard';
import { DataviewTableView } from './components/DataviewTableView';
import { MealPlannerView } from './components/MealPlannerView';
import { addRecipeToMealPlan, normalizeMealPlanDays } from './core/mealPlan';
import { ShoppingListView } from './components/ShoppingListView';
import { ThemesView, themeBackgroundColor } from './components/ThemesView';
import { ActiveTimersBar } from './components/ActiveTimersBar';
import { ConnectVaultModal } from './components/ConnectVaultModal';
import { RecipeGrabberModal } from './components/RecipeGrabberModal';
import { VaultIntelligenceModal } from './components/VaultIntelligenceModal';
import { AskMyKitchenModal } from './components/AskMyKitchenModal';
import { AboutUpdatesModal } from './components/AboutUpdatesModal';
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
 * Last accepted session kind. The read-only import is not durable across a
 * reload, but it must NOT be silently replaced by the old persisted FSA handle
 * when the app restarts. This marker is the persistent half of that rule; the
 * in-memory session authority is the live half.
 */
const LAST_VAULT_KIND_KEY = 'tkc_last_vault_session_kind';
type LastVaultKind = 'filesystem' | 'uploaded' | 'starter';

function readLastVaultKind(): LastVaultKind | null {
  try {
    const value = window.localStorage.getItem(LAST_VAULT_KIND_KEY);
    return value === 'filesystem' || value === 'uploaded' || value === 'starter' ? value : null;
  } catch {
    return null;
  }
}

function writeLastVaultKind(kind: LastVaultKind): boolean {
  try {
    window.localStorage.setItem(LAST_VAULT_KIND_KEY, kind);
    return true;
  } catch {
    return false;
  }
}

export interface ImportedCollectionSnapshot {
  recipes: ObsidianRecipe[];
  notes: VaultNote[];
  mealPlan: MealPlanDay[];
  shoppingList: ShoppingCategoryGroup[];
  folderName: string;
}

function isVaultSessionSuperseded(error: unknown): boolean {
  return Boolean(error) && (error as { name?: unknown }).name === 'VaultSessionSupersededError';
}

function vaultSessionSupersededError(): Error {
  const error = new Error('The active Vault changed before this operation could complete.');
  Object.defineProperty(error, 'name', { value: 'VaultSessionSupersededError' });
  return error;
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
async function loadVaultFromHandle(handle: any, assetScope: VaultAssetScope): Promise<LoadedVaultData> {
  const vault = createBrowserVaultAdapter(handle);
  const scan = await loadVaultContent(vault, () =>
    scanVaultAssetsFromHandle(handle, assetScope).catch((err) =>
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
  // ONE Recipe Vault. Brand-new users see the nine application-owned starter
  // recipes as a read-only cookbook. Once a personal Vault is connected or
  // imported, the Vault view contains ONLY the user's personal recipes; starter
  // templates are hidden until the user explicitly imports them.
  const starterRecipes = useMemo(() => getStarterVaultRecipes(), []);
  const [personalRecipes, setPersonalRecipes] = useState<ObsidianRecipe[]>([]);
  const [hasPersonalVaultCollection, setHasPersonalVaultCollection] = useState(false);
  useEffect(() => {
    // Any actual personal recipe (created, imported, or saved) takes over the
    // one Vault view from the first-run starter cookbook.
    if (personalRecipes.length > 0) setHasPersonalVaultCollection(true);
  }, [personalRecipes.length]);
  // In-memory only personalization for the first-run starter cookbook.
  const [starterOverrides, setStarterOverrides] = useState<Record<string, Partial<ObsidianRecipe>>>({});
  const recipes = useMemo<ObsidianRecipe[]>(() => {
    if (hasPersonalVaultCollection) return personalRecipes;
    return starterRecipes.map((recipe) => {
      const override = recipe.builtInId ? starterOverrides[recipe.builtInId] : undefined;
      return override ? { ...recipe, ...override } : recipe;
    });
  }, [hasPersonalVaultCollection, personalRecipes, starterRecipes, starterOverrides]);

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
    () =>
      createBrowserNetworkAdapter({
        authorizationHeaders: getEndpointAccessHeaders,
        imageSessionBootstrap: true,
      }),
    []
  );
  const voiceService = useMemo(() => createVoiceCache(networkAdapter), [networkAdapter]);
  // App-owned voice service lifecycle. The service is created once per App
  // instance and shared by Recipe Detail (prewarming) and Cooking Mode
  // (foreground narration). It must survive ordinary rerenders, be
  // disposed only when the owning App genuinely unmounts, and be replaced
  // with fresh state on remount.
  //
  // StrictMode (src/main.tsx) replays effects in development
  // (mount -> cleanup -> remount) with the same memoized service still
  // active. Disposing synchronously in that cleanup would leave the
  // remounted App holding a disposed service. Cleanup therefore defers
  // disposal by a macrotask; the remount setup synchronously cancels the
  // pending timer, so only a genuine unmount (no remount) disposes.
  // If the owned service is ever replaced (adapter transition), the old
  // instance is disposed in the new setup where the instances differ.
  const voiceMountedRef = useRef(false);
  const voiceDisposalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevVoiceServiceRef = useRef<typeof voiceService | null>(null);
  useEffect(() => {
    voiceMountedRef.current = true;
    if (voiceDisposalTimerRef.current) {
      clearTimeout(voiceDisposalTimerRef.current);
      voiceDisposalTimerRef.current = null;
    }
    const prev = prevVoiceServiceRef.current;
    if (prev && prev !== voiceService) {
      try { prev.dispose(); } catch {}
    }
    prevVoiceServiceRef.current = voiceService;
    return () => {
      voiceMountedRef.current = false;
      if (voiceDisposalTimerRef.current) clearTimeout(voiceDisposalTimerRef.current);
      const serviceToDispose = voiceService;
      voiceDisposalTimerRef.current = setTimeout(() => {
        voiceDisposalTimerRef.current = null;
        if (!voiceMountedRef.current) {
          try { serviceToDispose.dispose(); } catch {}
        }
      }, 0);
    };
  }, [voiceService]);
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

  // ONE live Vault authority. Every scan, write, import, autosave, and handle
  // persistence belongs to the session recorded here. `activeVaultRef` pairs
  // that session with the authorized adapter/handle, so a stale render closure
  // can never write through an adapter that belongs to a different session.
  const vaultAuthority = useMemo(() => createVaultSessionAuthority(), []);
  const initialAssetScope = useMemo(() => createVaultAssetScope(null, { active: true }), []);
  const [activeAssetScope, setActiveAssetScope] = useState<VaultAssetScope>(initialAssetScope);
  const pendingImportScopesRef = useRef<Map<number, VaultAssetScope>>(new Map());
  const desktopVaultPreparationRef = useRef<Promise<void> | null>(null);
  const vaultSessionRef = useRef<VaultSession>(vaultAuthority.current());
  const activeVaultRef = useRef<{
    session: VaultSession;
    adapter: VaultAdapter | null;
    handle: any;
    assetScope: VaultAssetScope;
  }>({
    session: vaultSessionRef.current,
    adapter: null,
    handle: null,
    assetScope: initialAssetScope,
  });
  const vaultHydratedRef = useRef(true);
  const lastImageSaveSessionRef = useRef<VaultSession | null>(null);
  const lastImageSaveRevisionRef = useRef<number | null>(null);
  const appUnmountedRef = useRef(false);
  const shutdownTransitionRef = useRef<VaultTransition | null>(null);
  const assetScopeDisposalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    appUnmountedRef.current = false;
    if (assetScopeDisposalTimerRef.current) {
      clearTimeout(assetScopeDisposalTimerRef.current);
      assetScopeDisposalTimerRef.current = null;
    }
    // StrictMode replays effects: a preceding fake cleanup must not leave the
    // real remounted app with a permanently blocked write barrier.
    if (shutdownTransitionRef.current) {
      vaultAuthority.cancelTransition(shutdownTransitionRef.current);
      shutdownTransitionRef.current = null;
    }
    return () => {
      appUnmountedRef.current = true;
      // Block every not-yet-started write. Already-started writes retain their
      // lease and are allowed to settle; nothing new may begin.
      shutdownTransitionRef.current = vaultAuthority.beginShutdownTransition('uploaded');
      const activeScope = activeVaultRef.current.assetScope;
      const pendingScopes = [...pendingImportScopesRef.current.values()];
      pendingImportScopesRef.current.clear();
      // Defer disposal so a StrictMode remount can cancel it.
      assetScopeDisposalTimerRef.current = setTimeout(() => {
        assetScopeDisposalTimerRef.current = null;
        activeScope.deactivate();
        for (const scope of pendingScopes) scope.deactivate();
      }, 0);
    };
  }, [vaultAuthority]);

  const activateAssetScope = useCallback((
    scope: VaultAssetScope,
    session: VaultSession,
    adapter: VaultAdapter | null,
    handle: any
  ) => {
    const previous = activeVaultRef.current.assetScope;
    scope.activate(session.id);
    vaultSessionRef.current = session;
    activeVaultRef.current = { session, adapter, handle, assetScope: scope };
    if (previous !== scope) previous.deactivate();
    setActiveAssetScope(scope);
    return scope;
  }, []);
  // Exact state that was hydrated from the active Vault. The autosave effects
  // skip an unchanged hydration, so connecting does not rewrite files merely to
  // update their generated date. A real user change still persists normally.
  const hydratedMealPlanRef = useRef<MealPlanDay[] | null>(null);
  const hydratedShoppingRef = useRef<ShoppingCategoryGroup[] | null>(null);

  // Keep the active ref's adapter in lockstep with the rendered composition
  // ONLY when the exact same session/handle is current. A stale render can
  // never donate its adapter to a newer session.
  useLayoutEffect(() => {
    const active = activeVaultRef.current;
    if (
      active.session.kind === 'filesystem' &&
      active.handle === vaultStatus.folderHandle &&
      vaultAdapter
    ) {
      activeVaultRef.current = { ...active, adapter: vaultAdapter };
    }
  }, [vaultAdapter, vaultStatus.folderHandle]);

  // Current browser permission for the ACTIVE File System Access handle. This
  // is deliberately separate from adapter existence: a handle can exist while
  // read/write permission is 'prompt', 'denied', or no longer queryable. Only
  // a fresh 'granted' result may unlock a bulk write.
  const [vaultWritePermission, setVaultWritePermission] = useState<VaultWritePermission>('unknown');
  const checkVaultWritePermission = useCallback(async (
    session: VaultSession,
    handle: any
  ): Promise<VaultWritePermission> => {
    if (!vaultAuthority.isCurrent(session) || activeVaultRef.current.handle !== handle) {
      return 'unknown';
    }
    const permission = await queryVaultWritePermission(handle);
    if (!vaultAuthority.isCurrent(session) || activeVaultRef.current.handle !== handle) {
      return 'unknown';
    }
    return permission;
  }, [vaultAuthority]);
  const refreshVaultWritePermission = useCallback(async (handle: any = activeVaultRef.current.handle) => {
    const session = activeVaultRef.current.session;
    const permission = await checkVaultWritePermission(session, handle);
    if (vaultAuthority.isCurrent(session) && activeVaultRef.current.handle === handle) {
      setVaultWritePermission(permission);
    }
    return permission;
  }, [checkVaultWritePermission, vaultAuthority]);

  useEffect(() => {
    void refreshVaultWritePermission();
  }, [refreshVaultWritePermission, vaultStatus.folderHandle]);

  // Recheck when the window regains focus. This is a non-prompting query, so
  // it is safe outside a user gesture.
  useEffect(() => {
    const onFocus = () => {
      void refreshVaultWritePermission();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshVaultWritePermission]);

  /**
   * Composite Asset + recipe operation bound to ONE originating session. The
   * lease covers both the binary Asset write and any recipe save performed
   * inside the callback. A transition either prevents the operation from
   * starting or waits for it to settle; a stale operation can never resolve an
   * asset in A and a recipe in B.
   */
  const runSessionAssetOperation = useMemo<SessionAssetRunner>(() => createSessionAssetRunner({
    authority: vaultAuthority,
    getActive: () => activeVaultRef.current,
    createDeps: (handle, assetScope) => ({
      asset: createBrowserAssetAdapter(handle),
      folderHandle: handle,
      downloadRemoteImage: browserRemoteImageDownloader,
      assetScope,
    }),
    isUnavailable: () => appUnmountedRef.current,
  }), [vaultAuthority]);

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
        const active = activeVaultRef.current;
        if (
          active.session.kind !== 'filesystem' ||
          !active.adapter ||
          active.handle !== folderHandle ||
          !vaultAuthority.isCurrent(active.session)
        ) {
          throw new Error('The active Vault changed before the image could be saved.');
        }
        const lease = vaultAuthority.beginWrite(active.session);
        if (!lease) throw new Error('The active Vault changed before the image could be saved.');
        lastImageSaveSessionRef.current = active.session;
        lastImageSaveRevisionRef.current = vaultAuthority.collectionRevision(active.session);
        try {
          const result = await saveGeneratedRecipeImageToVault(
            { vault: active.adapter, asset, assetScope: active.assetScope, previewSource },
            { recipePath, recipeTitle, token, activeVaultSessionId, approved: true }
          );
          // Invalidate stale scans before releasing the write lease.
          if (vaultAuthority.isCurrent(active.session)) vaultAuthority.markCollectionChanged(active.session);
          return result;
        } finally {
          lease.release();
        }
      },
    };
  }, [vaultStatus.folderHandle, vaultStatus.accessType, vaultSessionId, networkAdapter, vaultAuthority]);

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
  // ONE Recipe Vault: the only collection views are all / favorites.
  const [vaultView, setVaultView] = useState<'all' | 'favorites'>('all');
  // Explicit Save-to-Vault feedback for the selected built-in recipe.
  const [starterSaveState, setStarterSaveState] = useState<StarterSaveResult | null>(null);
  const [starterSavePending, setStarterSavePending] = useState(false);
  const [signaturePromptOpen, setSignaturePromptOpen] = useState(false);
  const [signatureImportState, setSignatureImportState] = useState<{
    status: 'idle' | 'running' | 'done';
    completed: number;
    total: number;
    summary: SignatureImportSummary | null;
  }>({ status: 'idle', completed: 0, total: 0, summary: null });
  const [vaultNotice, setVaultNotice] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);
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
  useEffect(() => {
    setStarterSaveState(null);
  }, [selectedRecipe?.id]);

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
  const [isAboutUpdatesOpen, setIsAboutUpdatesOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isCreateForMeOpen, setIsCreateForMeOpen] = useState(false);
  const [isGrabberOpen, setIsGrabberOpen] = useState(false);
  const [isVaultIntelligenceOpen, setIsVaultIntelligenceOpen] = useState(false);
  const [isAskMyKitchenOpen, setIsAskMyKitchenOpen] = useState(false);
  const [vaultIntelligenceRecipeId, setVaultIntelligenceRecipeId] = useState<string | null>(null);
  const [editingRecipe, setEditingRecipe] = useState<ObsidianRecipe | null>(null);
  const [isWindowDragging, setIsWindowDragging] = useState(false);
  const [grabberInitialUrl, setGrabberInitialUrl] = useState('');

  // Recheck the CURRENT handle permission whenever the Vault modal opens. This
  // covers a permission change made in browser UI while the app stayed open.
  useEffect(() => {
    if (!isConnectVaultOpen) return;
    void refreshVaultWritePermission();
  }, [isConnectVaultOpen, refreshVaultWritePermission]);

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
  const [mealPlan, setMealPlan] = useState<MealPlanDay[]>(() => normalizeMealPlanDays(STARTER_MEAL_PLAN));
  const [shoppingCategories, setShoppingCategories] = useState<ShoppingCategoryGroup[]>(STARTER_SHOPPING_CATEGORIES);

  // Canonical vault integrity (R2). `vaultAuthority` is the ONE identity
  // source for scans, writes, imports, autosaves, and handle persistence.
  // `vaultHydrated` remains the autosave hydration gate, mirrored in a ref so a
  // transition can disable it synchronously before React re-renders.
  const [vaultHydrated, setVaultHydrated] = useState(true);
  const setVaultHydratedState = useCallback((hydrated: boolean) => {
    vaultHydratedRef.current = hydrated;
    setVaultHydrated(hydrated);
  }, []);
  // Tracks the CURRENT active canonical references so a snapshot commit reconciles
  // them against the latest committed state (avoids closing over stale values).
  const activeRefs = useRef({ selectedRecipe: null as ObsidianRecipe | null, cookingRecipe: null as { recipe: ObsidianRecipe; servings: number } | null, editingRecipe: null as ObsidianRecipe | null });
  useEffect(() => {
    activeRefs.current = { selectedRecipe, cookingRecipe, editingRecipe };
  }, [selectedRecipe, cookingRecipe, editingRecipe]);

  const resetSessionScopedUi = useCallback((showSignaturePrompt: boolean, preserveRoute = false, preserveEditor = false) => {
    const preservedEditingRecipe = preserveEditor ? activeRefs.current.editingRecipe : null;
    setStarterSaveState(null);
    setStarterSavePending(false);
    setVaultNotice(null);
    setSignatureImportState({ status: 'idle', completed: 0, total: 0, summary: null });
    setSignaturePromptOpen(showSignaturePrompt);
    setVaultView('all');
    if (!preserveRoute) setRouteRecipeId(null);
    if (!preserveEditor) {
      setIsEditorOpen(false);
      setEditingRecipe(null);
    }
    setSelectedRecipe(null);
    setCookingRecipe(null);
    setIsGrabberOpen(false);
    setIsVaultIntelligenceOpen(false);
    setVaultIntelligenceRecipeId(null);
    activeRefs.current = {
      selectedRecipe: null,
      cookingRecipe: null,
      editingRecipe: preservedEditingRecipe,
    };
    if (preservedEditingRecipe) setEditingRecipe(preservedEditingRecipe);
    updateShisoWorkingRecipe(null);
  }, [updateShisoWorkingRecipe]);

  // Applies a SUCCESSFUL canonical FSA snapshot. The caller must have installed
  // the matching session (inside `commitTransition`) before this runs.
  const commitVaultSnapshot = useCallback((result: LoadedVaultData, session: VaultSession, folderHandle: any) => {
    if (!vaultAuthority.isCurrent(session)) return false;
    const next = deriveVaultSnapshotState(result, activeRefs.current);
    setPersonalRecipes(next.recipes);
    setHasPersonalVaultCollection(true);
    personalRecipesRef.current = next.recipes;
    recipesRef.current = next.recipes;
    committedRecipesRef.current = next.recipes;
    setNotes(next.notes);
    setMealPlan(next.mealPlan);
    setShoppingCategories(next.shoppingList);
    hydratedMealPlanRef.current = next.mealPlan;
    hydratedShoppingRef.current = next.shoppingList;
    setSelectedRecipe(next.selectedRecipe);
    setCookingRecipe(next.cookingRecipe);
    setEditingRecipe(next.editingRecipe);
    setVaultStatus({
      isConnected: true,
      accessType: 'filesystem_api',
      connectionState: 'connected',
      vaultPath: (folderHandle as any)?.isDesktopVault && typeof (folderHandle as any)?.root === 'string'
        ? (folderHandle as any).root
        : result.folderName
          ? `Vault / ${result.folderName}`
          : 'My Recipe Vault',
      folderHandle,
      rememberedVaultName: undefined,
    });
    setVaultHydratedState(true);
    vaultAuthority.markCollectionChanged(session);
    return true;
  }, [vaultAuthority, setVaultHydratedState]);

  const applyUploadedCollection = useCallback((snapshot: ImportedCollectionSnapshot) => {
    setPersonalRecipes(snapshot.recipes);
    setHasPersonalVaultCollection(true);
    personalRecipesRef.current = snapshot.recipes;
    recipesRef.current = snapshot.recipes;
    committedRecipesRef.current = snapshot.recipes;
    setNotes(snapshot.notes);
    const normalizedMealPlan = normalizeMealPlanDays(snapshot.mealPlan);
    setMealPlan(normalizedMealPlan);
    setShoppingCategories(snapshot.shoppingList);
    hydratedMealPlanRef.current = normalizedMealPlan;
    hydratedShoppingRef.current = snapshot.shoppingList;
    setVaultStatus({
      isConnected: true,
      accessType: 'uploaded_folder',
      connectionState: 'connected',
      vaultPath: `Vault / ${snapshot.folderName}`,
    });
    setVaultHydratedState(true);
    resetSessionScopedUi(true);
  }, [resetSessionScopedUi, setVaultHydratedState]);

  /**
   * Commits an FSA snapshot through the barrier and persists its handle only
   * for the winning session. The handle save is epoch- and identity-guarded, so
   * an older save cannot resurrect a Vault that was replaced by a read-only
   * import.
   */
  const transitionToFilesystemVault = useCallback(async (
    transition: VaultTransition,
    handle: any,
    result: LoadedVaultData,
    assetScope: VaultAssetScope,
    options?: { showSignaturePrompt?: boolean; persistHandle?: boolean; preserveEditor?: boolean }
  ): Promise<{ accepted: boolean; session?: VaultSession; writesSettled: boolean }> => {
    const adapter = createBrowserVaultAdapter(handle);
    let adopted = false;
    let outcome;
    try {
      outcome = await vaultAuthority.commitTransition(transition, (session) => {
        if (!commitVaultSnapshot(result, session, handle)) {
          throw new Error('Vault snapshot was no longer current.');
        }
        resetSessionScopedUi(
          Boolean(options?.showSignaturePrompt),
          !options?.showSignaturePrompt,
          Boolean(options?.preserveEditor)
        );
        setVaultWritePermission('unknown');
        activateAssetScope(assetScope, session, adapter, handle);
        adopted = true;
      });
    } catch (error) {
      if (!adopted) assetScope.deactivate();
      throw error;
    }
    if (!outcome.accepted || !outcome.session) {
      if (!adopted) assetScope.deactivate();
      // A newer intent may have invalidated this transition without beginning
      // its own transition yet (e.g. a folder parse that later fails). Restore
      // the previous session's autosave gate when no transition owns it.
      if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
      return { accepted: false, writesSettled: outcome.writesSettled };
    }

    const session = outcome.session;
    void refreshVaultWritePermission(handle);

    if (isDesktopDirectoryHandle(handle)) {
      // Persist restart authority only while this accepted session still owns
      // the transition. A newer selection must never inherit or overwrite it.
      if (vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
        try {
          await setDesktopActiveVault(handle.root);
          writeLastVaultKind('filesystem');
        } catch (error) {
          if (vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
            setVaultNotice({
              tone: 'error',
              message:
                'The Vault is open, but the desktop app could not save it as the remembered Vault. The previously remembered Vault will be used next launch.',
            });
          }
          console.warn('Could not remember native desktop Vault path:', error);
        }
      }
    } else if (options?.persistHandle === false) {
      if (!writeLastVaultKind('filesystem') && vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
        setVaultNotice({
          tone: 'info',
          message: 'Connected to this Vault, but the browser could not record the active session. A reload may return to the starter cookbook.',
        });
      }
    } else {
      const saved = await saveDirectoryHandleToIDB(handle, {
        shouldPersist: () => vaultAuthority.isCurrent(session) && activeVaultRef.current.handle === handle,
      });
      if (saved && !writeLastVaultKind('filesystem') && vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
        setVaultNotice({
          tone: 'info',
          message: 'Connected to this Vault, but the browser could not record the active session. A reload may return to the starter cookbook.',
        });
      }
      if (!saved && vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
        // Never leave the previous handle as the silent startup authority.
        const cleared = await clearDirectoryHandleFromIDB();
        if (vaultAuthority.isCurrent(session)) {
          writeLastVaultKind(cleared ? 'starter' : 'uploaded');
          setVaultNotice({
            tone: 'error',
            message: cleared
              ? 'Connected to this Vault for this session, but the browser could not remember it for the next launch. The previous Vault was forgotten.'
              : 'Connected to this Vault for this session, but the browser could not update its remembered Vault. A previous Vault may still ask to reconnect after a reload; it will not replace this session automatically.',
          });
        }
      }
    }
    if (!outcome.writesSettled && vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
      setVaultNotice({
        tone: 'info',
        message: 'The previous Vault operation is still finishing. Its result will not be merged into this Vault.',
      });
    }
    return { accepted: true, session, writesSettled: outcome.writesSettled };
  }, [activateAssetScope, commitVaultSnapshot, refreshVaultWritePermission, resetSessionScopedUi, vaultAuthority]);

  /**
   * Desktop zero-setup preparation. The managed native Vault is created only
   * when a user actually saves (or explicitly authorizes a write), never during
   * application launch. Starter copies are seeded idempotently under a durable
   * initialization marker; an existing non-empty Vault is never seeded.
   */
  const ensureDesktopVaultForSave = useCallback(async (): Promise<void> => {
    if (!isDesktopRuntime()) return;
    const active = activeVaultRef.current;

    // A restarted, interrupted initialization can be connected but incomplete.
    if (active.session.kind === 'filesystem' && active.adapter && isDesktopDirectoryHandle(active.handle)) {
      try {
        const info = await getDesktopVaultInfo();
        if (info?.isManaged && info.exists && !info.initialized && info.path === active.handle.root) {
          const claim = await beginDesktopInitialization(info.path);
          if (claim.action === 'claimed' || claim.action === 'resume') {
            await seedStarterCopies(
              active.handle,
              starterRecipes.map((recipe) => buildSavedStarterCopy(recipe))
            );
            await completeDesktopInitialization(info.path);
            const refreshed = await loadVaultFromHandle(active.handle, active.assetScope);
            if (vaultAuthority.isCurrent(active.session)) {
              const draft = activeRefs.current.editingRecipe;
              commitVaultSnapshot(refreshed, active.session, active.handle);
              if (draft) {
                activeRefs.current.editingRecipe = draft;
                setEditingRecipe(draft);
              }
            }
          }
        }
      } catch (error) {
        console.warn('Desktop Vault starter resume failed:', error);
        throw error;
      }
      return;
    }

    if (desktopVaultPreparationRef.current) return desktopVaultPreparationRef.current;

    const preparation = (async () => {
      const info = await ensureDesktopManagedVault();
      if (!info?.path) throw new Error('The desktop app could not create a local Recipe Vault.');
      const handle = createDesktopDirectoryHandle(info.path);
      const claim = await beginDesktopInitialization(info.path);
      if (claim.action === 'claimed' || claim.action === 'resume') {
        await seedStarterCopies(handle, starterRecipes.map((recipe) => buildSavedStarterCopy(recipe)));
        await completeDesktopInitialization(info.path);
      }
      const transition = vaultAuthority.beginTransition('filesystem');
      if (!transition) throw new Error('A Vault change is already in progress. Please try again.');
      const assetScope = createVaultAssetScope(null, { active: false });
      try {
        const result = await loadVaultFromHandle(handle, assetScope);
        if (!vaultAuthority.isTransitionCurrent(transition)) {
          assetScope.deactivate();
          throw new Error('A newer Vault action replaced this save. Nothing was written.');
        }
        const outcome = await transitionToFilesystemVault(transition, handle, result, assetScope, {
          showSignaturePrompt: false,
          persistHandle: false,
          preserveEditor: true,
        });
        if (!outcome.accepted) throw new Error('The desktop Recipe Vault could not be activated. Your draft was kept.');
      } catch (error) {
        assetScope.deactivate();
        if (vaultAuthority.isTransitionCurrent(transition)) vaultAuthority.cancelTransition(transition);
        if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
        throw error;
      }
    })();

    desktopVaultPreparationRef.current = preparation;
    try {
      await preparation;
    } finally {
      desktopVaultPreparationRef.current = null;
    }
  }, [
    commitVaultSnapshot,
    setVaultHydratedState,
    starterRecipes,
    transitionToFilesystemVault,
    vaultAuthority,
  ]);

  /**
   * The single read-only collection transition. Reads/writes for the previous
   * Vault are blocked immediately; already-started writes are allowed to settle
   * before the new collection is applied.
   */
  const transitionToUploadedCollection = useCallback(async (
    snapshot: ImportedCollectionSnapshot,
    intent?: VaultCollectionIntent,
    explicitAssetScope?: VaultAssetScope
  ): Promise<boolean> => {
    let assetScope = explicitAssetScope;
    if (intent) {
      if (!assetScope) {
        assetScope = pendingImportScopesRef.current.get(intent.id);
      }
      // The intent is consumed even when its scope was passed explicitly. A
      // stale map entry would otherwise be mistaken for a provisional scope
      // and deactivated by a later import (possibly after it became active).
      pendingImportScopesRef.current.delete(intent.id);
    }
    if (!assetScope) assetScope = createVaultAssetScope(null, { active: false });
    // The intent was registered before the first parse await. A newer import
    // invalidates it; an older parse therefore cannot replace the newer one.
    const transition = intent
      ? vaultAuthority.beginCollectionTransition(intent, 'uploaded')
      : vaultAuthority.beginTransition('uploaded');
    if (!transition) {
      assetScope.deactivate();
      return false;
    }
    const hadActiveWrites = vaultAuthority.activeWriteCount() > 0;
    setVaultHydratedState(false);
    if (hadActiveWrites) {
      setVaultNotice({ tone: 'info', message: 'Finishing the current Vault operation before switching…' });
    }
    let adopted = false;
    let outcome;
    try {
      outcome = await vaultAuthority.commitTransition(transition, (session) => {
        applyUploadedCollection(snapshot);
        setVaultWritePermission('unknown');
        activateAssetScope(assetScope, session, null, null);
        adopted = true;
      });
    } catch (error) {
      if (!adopted) assetScope.deactivate();
      if (vaultAuthority.isTransitionCurrent(transition)) vaultAuthority.cancelTransition(transition);
      if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
      throw error;
    }
    if (!outcome.accepted || !outcome.session) {
      if (!adopted) assetScope.deactivate();
      if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
      return false;
    }

    const session = outcome.session;
    const markerWritten = writeLastVaultKind('uploaded');
    const handleCleared = await clearDirectoryHandleFromIDB();
    if (vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
      if (!markerWritten || !handleCleared) {
        setVaultNotice({
          tone: 'error',
          message: markerWritten && !handleCleared
            ? 'The imported collection is active, but the browser could not forget the previous Vault handle. Reloads are marked as an imported session and will not auto-reconnect that Vault.'
            : 'The imported collection is active, but the browser could not record that the previous Vault was replaced. Do not reload until you have re-imported these files.',
        });
      }
      if (!outcome.writesSettled) {
        setVaultNotice({
          tone: 'info',
          message: 'The previous Vault operation is still finishing. Its result will not be merged into this imported collection.',
        });
      }
    }
    return true;
  }, [activateAssetScope, applyUploadedCollection, setVaultHydratedState, vaultAuthority]);

  /**
   * Starts a folder-import intent and its destination asset scope BEFORE the
   * first parse await. The scope is provisional: registrations are captured but
   * invisible until the transition commits. A newer intent deactivates older
   * provisional scopes and revokes their owned URLs.
   */
  const beginCollectionImportWithScope = useCallback((): VaultCollectionImportStart => {
    const activeScope = activeVaultRef.current.assetScope;
    for (const [id, scope] of [...pendingImportScopesRef.current]) {
      // Only provisional scopes belong in this map. Never deactivate the
      // currently authoritative collection's scope, even if a stale entry
      // somehow survived.
      pendingImportScopesRef.current.delete(id);
      if (scope === activeScope) continue;
      scope.deactivate();
    }
    const intent = vaultAuthority.beginCollectionIntent();
    const assetScope = createVaultAssetScope(null, { active: false });
    pendingImportScopesRef.current.set(intent.id, assetScope);
    return { intent, assetScope };
  }, [vaultAuthority]);

  // Re-authorise a REMEMBERED Vault and reconnect it. The browser only allows
  // `requestPermission()` from a user gesture, so this is invoked directly from
  // the "Reconnect Vault" button. It never clears a valid handle on failure.
  const handleReconnectVault = useCallback(async () => {
    const transition = vaultAuthority.beginTransition('filesystem');
    const assetScope = createVaultAssetScope(null, { active: false });
    setVaultHydratedState(false);
    const outcome = await reconnectRememberedVault<LoadedVaultData>({
      getHandle: () => getDirectoryHandleFromIDB(),
      requestPermission: (handle: any) => handle.requestPermission({ mode: 'readwrite' }),
      load: (handle: any) => loadVaultFromHandle(handle, assetScope),
    });
    if (!vaultAuthority.isTransitionCurrent(transition)) {
      assetScope.deactivate();
      return; // superseded by a user transition
    }

    if (outcome.status === 'reconnected') {
      try {
        await transitionToFilesystemVault(transition, outcome.handle, outcome.data, assetScope, {
          showSignaturePrompt: true,
          persistHandle: true,
        });
      } catch (err) {
        assetScope.deactivate();
        if (vaultAuthority.isTransitionCurrent(transition)) vaultAuthority.cancelTransition(transition);
        if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
        console.warn('Reconnect snapshot was not applied:', err);
      }
      return;
    }

    assetScope.deactivate();
    vaultAuthority.cancelTransition(transition);
    setVaultHydratedState(true);
    if (outcome.status === 'no-handle' || outcome.status === 'unsupported') {
      // Preserve any valid active session; only the starter shell falls back.
      if (vaultAuthority.current().kind === 'starter') {
        setVaultStatus((s) => ({ ...s, isConnected: false, connectionState: 'starter' }));
      }
      return;
    }
    // 'denied' and 'error': the Vault stays remembered, but the browser will
    // not re-authorise it — say so plainly instead of showing sample data.
    if (vaultAuthority.current().kind === 'starter') {
      setVaultStatus((s) => ({ ...s, isConnected: false, connectionState: 'permission_denied' }));
    }
  }, [setVaultHydratedState, transitionToFilesystemVault, vaultAuthority]);

  // In-memory canonical state update AFTER a successful image save (the vault
  // write itself already happened inside the save flow — never re-written here).
  const handleRecipeImageSaved = useCallback((recipeId: string, imagePath: string) => {
    const saveSession = lastImageSaveSessionRef.current;
    if (!saveSession || !vaultAuthority.isCurrent(saveSession) || vaultAuthority.writesBlocked()) return;
    if (isBuiltInRecipe(recipesRef.current.find((r) => r.id === recipeId))) return;
    const startRevision = lastImageSaveRevisionRef.current;
    const currentRevision = vaultAuthority.collectionRevision(saveSession);
    // Recovery has committed both the asset and canonical Markdown. Advance the
    // collection revision so a scan that captured the pre-recovery snapshot
    // cannot commit over this result.
    vaultAuthority.markCollectionChanged(saveSession);
    if (startRevision !== null && currentRevision !== null && currentRevision !== startRevision) {
      // A newer collection mutation intervened. Do not publish a stale recipe
      // projection; the next authoritative scan will read the committed files.
      setVaultNotice({
        tone: 'info',
        message: 'The image was saved, but the Vault state changed during the operation. Refresh to view the latest state.',
      });
      return;
    }
    setPersonalRecipes((prev) =>
      prev.map((r) => (r.id === recipeId ? { ...r, image: imagePath } : r))
    );
    setSelectedRecipe((prev) => (prev && prev.id === recipeId ? { ...prev, image: imagePath } : prev));
  }, [vaultAuthority]);

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
        if (isDesktopRuntime()) {
          const restoreSession = vaultAuthority.current();
          const desktopLastKind = readLastVaultKind();
          if (desktopLastKind === 'uploaded' || desktopLastKind === 'starter') return;
          const info = await getDesktopVaultInfo();
          if (!isMounted || !vaultAuthority.isCurrent(restoreSession) || restoreSession.kind !== 'starter') {
            return;
          }
          // A managed Vault with no completed marker and no recipe files is an
          // interrupted/never-started first save. Stay on the read-only starter
          // cookbook until the user's first write resumes initialization.
          const shouldReconnect = !!info?.exists && !!info.path && (
            !info.isManaged || info.initialized === true || info.hasMarkdown === true
          );
          if (!shouldReconnect) return;
          const handle = createDesktopDirectoryHandle(info.path);
          const transition = vaultAuthority.beginAutomaticTransition('filesystem');
          if (!transition) return;
          const assetScope = createVaultAssetScope(null, { active: false });
          setVaultHydratedState(false);
          try {
            const result = await loadVaultFromHandle(handle, assetScope);
            if (!isMounted || !vaultAuthority.isTransitionCurrent(transition)) {
              assetScope.deactivate();
              return;
            }
            await transitionToFilesystemVault(transition, handle, result, assetScope, {
              showSignaturePrompt: false,
              persistHandle: false,
            });
          } catch (error) {
            assetScope.deactivate();
            if (vaultAuthority.isTransitionCurrent(transition)) vaultAuthority.cancelTransition(transition);
            if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
            console.warn('Desktop Vault restore failed:', error);
          }
          return;
        }

        // A read-only import is not durable across a reload, but it must not be
        // silently replaced by the previous writable handle either. The marker
        // is the persistent half of that authority.
        const lastKind = readLastVaultKind();
        if (lastKind === 'uploaded' || lastKind === 'starter') {
          await clearDirectoryHandleFromIDB();
          return;
        }

        const restoreSession = vaultAuthority.current();
        const handle = await getDirectoryHandleFromIDB();
        if (!isMounted || !vaultAuthority.isCurrent(restoreSession) || restoreSession.kind !== 'starter') {
          return;
        }
        const permission = handle && typeof handle.queryPermission === 'function'
          ? await handle.queryPermission({ mode: 'readwrite' })
          : null;
        if (!isMounted || !vaultAuthority.isCurrent(restoreSession)) return;
        const action = resolveVaultRestoreAction(!!handle, permission);
        if (action.kind === 'reconnect') {
          // Automatic reconnect may only begin when no user intent exists. If
          // the user picks B while this check/handle read was pending, this
          // returns null and A never becomes authoritative.
          const transition = vaultAuthority.beginAutomaticTransition('filesystem');
          if (!transition) return;
          const assetScope = createVaultAssetScope(null, { active: false });
          setVaultHydratedState(false);
          try {
            const result = await loadVaultFromHandle(handle, assetScope);
            if (!isMounted || !vaultAuthority.isTransitionCurrent(transition)) {
              assetScope.deactivate();
              return;
            }
            await transitionToFilesystemVault(transition, handle, result, assetScope, {
              showSignaturePrompt: false,
              persistHandle: false,
            });
          } catch (err) {
            assetScope.deactivate();
            if (vaultAuthority.isTransitionCurrent(transition)) vaultAuthority.cancelTransition(transition);
            if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
            console.warn('Automatic Vault snapshot was not applied:', err);
          }
          return;
        }
        if (action.kind === 'none') return;
        // The Vault IS remembered, but the browser will not re-authorise it
        // without a user gesture. Remember it and surface an explicit
        // "Reconnect Vault" action — never silently present the starter Vault
        // as though it were the user's connected Vault.
        if (!vaultAuthority.isCurrent(restoreSession)) return;
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
  }, [setVaultHydratedState, transitionToFilesystemVault, vaultAuthority]);

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

  // 2. Background Re-Sync on Window Focus: Live updates from Obsidian desktop.
  // The scan token is bound to BOTH the session identity and its collection
  // revision, so a scan that started before a write or transition cannot commit.
  useEffect(() => {
    const handleWindowFocus = async () => {
      const active = activeVaultRef.current;
      if (active.session.kind !== 'filesystem' || !active.handle) return;
      const scan = vaultAuthority.beginScan(active.session);
      if (!scan) return;
      try {
        const result = await loadVaultFromHandle(active.handle, active.assetScope);
        if (
          appUnmountedRef.current ||
          !vaultAuthority.isScanCurrent(scan) ||
          !vaultAuthority.isCurrent(active.session) ||
          activeVaultRef.current.handle !== active.handle
        ) {
          return;
        }
        commitVaultSnapshot(result, active.session, active.handle);
      } catch (err) {
        if (vaultAuthority.isScanCurrent(scan)) {
          console.warn('Background vault scan on focus failed:', err);
        }
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, [commitVaultSnapshot, vaultAuthority]);

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
  //    The write holds a session lease, so a transition either prevents it from
  //    starting or waits for it to settle. A stale completion never reports into
  //    a newer session.
  useEffect(() => {
    if (!vaultHydratedRef.current) return undefined;
    const active = activeVaultRef.current;
    if (active.session.kind !== 'filesystem' || !active.adapter) return undefined;
    const { session, adapter } = active;
    let cancelled = false;
    const run = async () => {
      if (!vaultHydratedRef.current || !vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) return;
      if (hydratedMealPlanRef.current !== null && JSON.stringify(hydratedMealPlanRef.current) === JSON.stringify(mealPlan)) return;
      const lease = vaultAuthority.beginWrite(session);
      if (!lease) return;
      try {
        await saveMealPlanWithVaultAdapter(adapter, mealPlan);
        if (vaultAuthority.isCurrent(session)) {
          hydratedMealPlanRef.current = mealPlan;
          vaultAuthority.markCollectionChanged(session);
        }
      } catch (e) {
        if (!cancelled && vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
          reportVaultError('save', 'Meal Plan', e);
        }
      } finally {
        lease.release();
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [mealPlan, vaultAdapter, vaultHydrated, vaultAuthority]);

  // 5. Auto-save Shopping List note to the vault through the adapter if connected.
  useEffect(() => {
    if (!vaultHydratedRef.current) return undefined;
    const active = activeVaultRef.current;
    if (active.session.kind !== 'filesystem' || !active.adapter) return undefined;
    const { session, adapter } = active;
    let cancelled = false;
    const run = async () => {
      if (!vaultHydratedRef.current || !vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) return;
      if (hydratedShoppingRef.current !== null && JSON.stringify(hydratedShoppingRef.current) === JSON.stringify(shoppingCategories)) return;
      const lease = vaultAuthority.beginWrite(session);
      if (!lease) return;
      try {
        await saveShoppingListWithVaultAdapter(adapter, shoppingCategories);
        if (vaultAuthority.isCurrent(session)) {
          hydratedShoppingRef.current = shoppingCategories;
          vaultAuthority.markCollectionChanged(session);
        }
      } catch (e) {
        if (!cancelled && vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
          reportVaultError('save', 'Shopping List', e);
        }
      } finally {
        lease.release();
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [shoppingCategories, vaultAdapter, vaultHydrated, vaultAuthority]);

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

  // Connect local folder via File System Access API.
  // The transition starts BEFORE the scan so no new write can begin against the
  // previous Vault. A slow scan that loses to a newer transition never commits
  // and never persists its handle.
  const handleDirectVaultConnected = async (
    folderHandle: any
  ): Promise<{ recipeCount: number; noteCount: number; accepted: boolean; message?: string }> => {
    const transition = vaultAuthority.beginTransition('filesystem');
    const assetScope = createVaultAssetScope(null, { active: false });
    setVaultHydratedState(false);
    try {
      const result = await loadVaultFromHandle(folderHandle, assetScope);
      if (!vaultAuthority.isTransitionCurrent(transition)) {
        assetScope.deactivate();
        return {
          recipeCount: 0,
          noteCount: 0,
          accepted: false,
          message: 'A newer Vault selection replaced this connection. The active collection was not changed.',
        };
      }
      const outcome = await transitionToFilesystemVault(transition, folderHandle, result, assetScope, {
        showSignaturePrompt: true,
        persistHandle: true,
      });
      if (!outcome.accepted) {
        return {
          recipeCount: 0,
          noteCount: 0,
          accepted: false,
          message: 'A newer Vault selection replaced this connection. The active collection was not changed.',
        };
      }
      return { recipeCount: result.recipes.length, noteCount: result.notes.length, accepted: true };
    } catch (error) {
      assetScope.deactivate();
      if (vaultAuthority.isTransitionCurrent(transition)) vaultAuthority.cancelTransition(transition);
      if (!vaultAuthority.writesBlocked()) setVaultHydratedState(true);
      throw error;
    }
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

  // Upload folder fallback. A folder selection is a complete read-only
  // collection import and goes through the same session transition barrier.
  const handleUploadFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    // Identity + provisional destination scope BEFORE the first await: a slower
    // older parse can never replace a newer accepted folder.
    const { intent, assetScope } = beginCollectionImportWithScope();
    try {
      if (files.length === 0) {
        await transitionToUploadedCollection({
          recipes: [],
          notes: [],
          mealPlan: [],
          shoppingList: [],
          folderName: 'Empty folder',
        }, intent, assetScope);
        return;
      }
      const parsed = await parseUploadedFileList(files, assetScope);
      const folderName = files[0]?.webkitRelativePath?.split('/')[0] || 'Selected folder';
      await transitionToUploadedCollection({
        recipes: parsed.recipes,
        notes: parsed.notes || [],
        mealPlan: parsed.mealPlan ?? [],
        shoppingList: parsed.shoppingList ?? [],
        folderName,
      }, intent, assetScope);
    } catch (err) {
      // Parsing failed before state replacement; the active collection remains.
      assetScope.deactivate();
      console.error('Failed to import files:', err);
    }
  };

  // Save / Update Recipe
  //
  // H-2: the canonical write is factored into `commitRecipeWrite` so the SHISO
  // save capability uses the very SAME authoritative path as the editor. Any
  // successful canonical write also RESOLVES the unsaved SHISO working copy for
  // that recipe (the written recipe now contains those changes).
  // Shared per-recipe write coordination. Every full-recipe snapshot write
  // (normal save, nutrition update, favorite toggle) for the same canonical
  // recipe is serialized through this chain, so a stale snapshot from one path
  // cannot overwrite a newer successful write from another path.
  const recipeWriteChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const enqueueRecipeWrite = useCallback((recipe: ObsidianRecipe, task: () => Promise<void>) => {
    return enqueueRecipeWriteHelper(recipeWriteChainsRef.current, recipe, task);
  }, []);

  const commitRecipeWrite = useCallback(
    async (savedRecipe: ObsidianRecipe, baseRecipe?: ObsidianRecipe) => {
      if (isBuiltInRecipe(savedRecipe) || isBuiltInRecipe(baseRecipe)) {
        throw new Error('Signature Collection originals are read-only. Save this recipe to My Vault first.');
      }
      const base = baseRecipe ?? committedRecipesRef.current.find((r) => sameCanonicalRecipeIdentity(r, savedRecipe)) ?? recipesRef.current.find((r) => sameCanonicalRecipeIdentity(r, savedRecipe));
      // Capture the destination BEFORE queueing. A task that reaches the front
      // of the per-recipe queue after a transition must never adopt the newer
      // Vault's adapter/session.
      const requested = activeVaultRef.current;
      const requestedSession = requested.session;
      const requestedAdapter = requested.adapter;
      const run = async () => {
        if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(requestedSession)) {
          throw vaultSessionSupersededError();
        }
        if (requestedSession.kind === 'filesystem' && !requestedAdapter) {
          throw vaultSessionSupersededError();
        }
        const latest = committedRecipesRef.current.find((r) => sameCanonicalRecipeIdentity(r, savedRecipe));
        const toWrite = rebaseRecipeOntoLatest(latest, base, savedRecipe);
        if (requestedAdapter) {
          const lease = vaultAuthority.beginWrite(requestedSession);
          if (!lease) throw vaultSessionSupersededError();
          try {
            const validation = await validateRecipeAssetReferences(
              {
                asset: createBrowserAssetAdapter(requested.handle),
                folderHandle: requested.handle,
                assetScope: requested.assetScope,
              },
              toWrite
            );
            if (!validation.ok) {
              throw new Error(validation.reason || 'The active Vault could not verify this recipe image reference.');
            }
            await saveRecipeWithVaultAdapter(requestedAdapter, toWrite);
          } finally {
            lease.release();
          }
          if (!vaultAuthority.isCurrent(requestedSession)) return;
          vaultAuthority.markCollectionChanged(requestedSession);
        } else {
          // Disconnected workflow: preserve the existing download-to-disk fallback.
          await saveRecipeToVaultFile(toWrite, undefined);
        }
        // A pending transition keeps the OLD session authoritative until it
        // commits. Updating the old state here is safe: a later commit replaces
        // it, while a failed/cancelled transition preserves the verified write.
        if (!vaultAuthority.isCurrent(requestedSession)) return;
        committedRecipesRef.current = upsertCanonicalRecipe(committedRecipesRef.current, toWrite);
        setPersonalRecipes((prev) => upsertCanonicalRecipe(prev, toWrite));
        setSelectedRecipe((prev) => (prev && sameCanonicalRecipeIdentity(prev, toWrite) ? toWrite : prev));
        const working = shisoWorkingRecipeRef.current;
        if (working !== null && sameCanonicalRecipeIdentity(working.base, toWrite)) {
          updateShisoWorkingRecipe(null);
        }
      };
      await enqueueRecipeWrite(savedRecipe, run);
    },
    [updateShisoWorkingRecipe, enqueueRecipeWrite, vaultAuthority],
  );

  const handleSaveRecipe = async (savedRecipe: ObsidianRecipe) => {
    if (isBuiltInRecipe(savedRecipe)) {
      throw new Error('Signature Collection originals are read-only. Use Save to My Vault, then edit the saved copy.');
    }
    await ensureDesktopVaultForSave();
    // Write FIRST: Obsidian Markdown is the canonical source of truth. React state is
    // only updated AFTER the canonical write succeeds, so a failed write leaves the
    // prior canonical state (and the open editor) intact (defect C).
    try {
      const saveBase = editingRecipe && sameCanonicalRecipeIdentity(editingRecipe, savedRecipe) ? editingRecipe : undefined;
      const ratingChanged = saveBase ? saveBase.rating !== savedRecipe.rating : false;
      const toSave: ObsidianRecipe = {
        ...savedRecipe,
        ratingExplicit: ratingChanged ? true : (saveBase?.ratingExplicit ?? savedRecipe.ratingExplicit ?? (savedRecipe.frontmatter?.rating !== undefined)),
        ratingSource: ratingChanged ? (savedRecipe.rating > 0 ? 'personal' : undefined) : (saveBase?.ratingSource ?? savedRecipe.ratingSource),
      };
      await commitRecipeWrite(toSave, saveBase);
    } catch (err) {
      if (isVaultSessionSuperseded(err)) {
        // The caller (editor/grabber) must know the recipe was NOT saved so it
        // can keep its draft and roll back any transaction-owned asset.
        throw err;
      }
      // Surface the failure; do NOT claim persistence succeeded (editor stays open).
      reportVaultError('save', savedRecipe.title || 'recipe', err);
      throw err;
    }
    setIsEditorOpen(false);
    setEditingRecipe(null);
  };

  /**
   * Explicit, single-recipe copy of a built-in Signature recipe into the
   * connected personal Vault. No background/bulk copy and no overwrite.
   */
  const handleSaveStarterToVault = async (builtIn: ObsidianRecipe) => {
    if (!isBuiltInRecipe(builtIn) || starterSavePending) return;
    if (vaultAuthority.writesBlocked()) {
      setVaultNotice({ tone: 'info', message: 'A Vault change is in progress. Wait for it to finish before saving this recipe.' });
      return;
    }
    try {
      await ensureDesktopVaultForSave();
    } catch (error: any) {
      setVaultNotice({ tone: 'error', message: error?.message || 'The desktop Recipe Vault could not be prepared. No files were changed.' });
      return;
    }
    const active = activeVaultRef.current;
    const session = active.session;
    if (session.kind !== 'filesystem' || !active.adapter) {
      const result: StarterSaveResult = {
        status: 'unavailable',
        message: 'Connect a writable Vault before saving this recipe. No files were changed.',
      };
      if (vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
        setStarterSaveState(result);
        setVaultNotice({ tone: 'info', message: result.message });
      }
      return;
    }

    const permission = await queryVaultWritePermission(active.handle);
    if (!vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) return;
    setVaultWritePermission(permission);
    if (permission !== 'granted') {
      const result: StarterSaveResult = {
        status: 'permission_required',
        message: 'Write access to this Vault is not granted. Reconnect the Vault and allow read/write access before saving. No files were changed.',
      };
      setStarterSaveState(result);
      setVaultNotice({ tone: 'info', message: result.message });
      return;
    }

    setStarterSavePending(true);
    setStarterSaveState(null);
    setVaultNotice(null);
    try {
      const starterAsset = createBrowserAssetAdapter(active.handle);
      const result = await saveStarterRecipeToVault({
        vault: active.adapter,
        builtIn,
        personalRecipes: personalRecipesRef.current,
        validateRecipe: async (recipe) =>
          validateRecipeAssetReferences(
            { asset: starterAsset, folderHandle: active.handle, assetScope: active.assetScope },
            recipe
          ),
        isCurrent: () => !appUnmountedRef.current && vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked(),
        runWrite: async (operation) => {
          if (appUnmountedRef.current || !vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) {
            return { executed: false };
          }
          const currentPermission = await queryVaultWritePermission(active.handle);
          if (currentPermission !== 'granted') return { executed: false };
          if (!vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) {
            return { executed: false };
          }
          const lease = vaultAuthority.beginWrite(session);
          if (!lease) return { executed: false };
          try {
            const value = await operation();
            if (vaultAuthority.isCurrent(session)) vaultAuthority.markCollectionChanged(session);
            return { executed: true, value };
          } finally {
            lease.release();
          }
        },
      });
      if (appUnmountedRef.current || !vaultAuthority.isCurrent(session)) return;

      setStarterSaveState(result);
      if ((result.status === 'saved' || result.status === 'already_saved') && result.recipe) {
        const verified = result.recipe;
        const next = upsertCanonicalRecipe(personalRecipesRef.current, verified);
        personalRecipesRef.current = next;
        committedRecipesRef.current = upsertCanonicalRecipe(committedRecipesRef.current, verified);
        setPersonalRecipes(next);
        setHasPersonalVaultCollection(true);
        vaultAuthority.markCollectionChanged(session);
        // Open the ACTUAL personal copy so nutrition/edit/favorite/delete are
        // immediately available instead of leaving the user on the read-only
        // starter template.
        setSelectedRecipe(verified);
        setVaultView('all');
        setVaultNotice({
          tone: 'success',
          message: result.message,
        });
      } else {
        setVaultNotice({
          tone: result.status === 'unavailable' || result.status === 'permission_required' || result.status === 'cancelled' ? 'info' : 'error',
          message: result.message,
        });
      }
    } catch (error) {
      if (appUnmountedRef.current || !vaultAuthority.isCurrent(session)) return;
      const message = isVaultSessionSuperseded(error)
        ? 'The Vault changed before this save completed. The recipe was not added to the new Vault.'
        : 'The recipe could not be saved to My Vault. The built-in template is unchanged.';
      setStarterSaveState({ status: isVaultSessionSuperseded(error) ? 'cancelled' : 'error', message });
      setVaultNotice({ tone: 'info', message });
    } finally {
      if (vaultAuthority.isCurrent(session)) setStarterSavePending(false);
    }
  };

  const handleImportSignatureNine = async () => {
    if (signatureImportState.status === 'running') return;
    if (vaultAuthority.writesBlocked()) {
      setVaultNotice({ tone: 'info', message: 'A Vault change is in progress. Wait for it to finish before importing recipes.' });
      return;
    }
    if (isDesktopRuntime() && activeVaultRef.current.session.kind !== 'filesystem') {
      try {
        await ensureDesktopVaultForSave();
      } catch (error: any) {
        setVaultNotice({ tone: 'error', message: error?.message || 'The desktop Recipe Vault could not be prepared.' });
        return;
      }
    }
    const active = activeVaultRef.current;
    const session = active.session;
    if (session.kind !== 'filesystem' || !active.adapter) {
      if (vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
        setVaultNotice({
          tone: 'info',
          message: 'A writable Vault connection is required before importing recipes. No files were changed.',
        });
      }
      return;
    }

    // Recheck the live permission at click time. Rendering state can be stale
    // if the browser revoked access after the panel was displayed.
    const permission = await queryVaultWritePermission(active.handle);
    if (!vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked() || activeVaultRef.current.handle !== active.handle) {
      return;
    }
    setVaultWritePermission(permission);
    if (permission !== 'granted') {
      const message = permission === 'denied'
        ? 'Write access to this Vault is denied. Reconnect the Vault and allow read/write access before importing recipes. No files were changed.'
        : permission === 'prompt'
          ? 'The browser has not granted read/write access to this Vault. Reconnect the Vault and allow access before importing recipes. No files were changed.'
          : permission === 'unsupported'
            ? 'Writable access could not be verified for this Vault. Choose a writable Vault folder before importing recipes. No files were changed.'
            : 'Writable access to this Vault is not available. Reconnect a writable Vault folder before importing recipes. No files were changed.';
      setVaultNotice({ tone: permission === 'denied' ? 'error' : 'info', message });
      return;
    }

    const total = starterRecipes.length;
    let cancelReason: string | undefined;
    setSignatureImportState({ status: 'running', completed: 0, total, summary: null });
    setVaultNotice(null);
    try {
      const starterAsset = createBrowserAssetAdapter(active.handle);
      const summary = await importSignatureStarterCollection({
        vault: active.adapter,
        builtIns: starterRecipes,
        personalRecipes: personalRecipesRef.current,
        validateRecipe: async (recipe) =>
          validateRecipeAssetReferences(
            { asset: starterAsset, folderHandle: active.handle, assetScope: active.assetScope },
            recipe
          ),
        isCurrent: () => !appUnmountedRef.current && vaultAuthority.isCurrent(session),
        getCancelReason: () => cancelReason,
        onProgress: (completed, progressTotal) => {
          if (appUnmountedRef.current || !vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) return;
          setSignatureImportState((current) => ({ ...current, status: 'running', completed, total: progressTotal }));
        },
        runWrite: async (operation) => {
          if (appUnmountedRef.current || !vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) {
            cancelReason = 'The active Vault changed before this recipe could be written.';
            return { executed: false };
          }
          const currentPermission = await queryVaultWritePermission(active.handle);
          if (currentPermission !== 'granted') {
            cancelReason = 'Write permission is no longer granted. Remaining recipes were not written.';
            return { executed: false };
          }
          if (!vaultAuthority.isCurrent(session) || vaultAuthority.writesBlocked()) {
            cancelReason = 'The active Vault changed before this recipe could be written.';
            return { executed: false };
          }
          const lease = vaultAuthority.beginWrite(session);
          if (!lease) {
            cancelReason = 'The active Vault changed before this recipe could be written.';
            return { executed: false };
          }
          try {
            const value = await operation();
            if (vaultAuthority.isCurrent(session)) vaultAuthority.markCollectionChanged(session);
            return { executed: true, value };
          } finally {
            lease.release();
          }
        },
      });

      // A completion from a COMMITTED superseded session must never mutate the
      // new Vault. A merely pending transition still leaves the old session
      // authoritative; its verified partial result is safe because a later
      // commit replaces this state, while a failed/cancelled transition keeps it.
      if (appUnmountedRef.current || !vaultAuthority.isCurrent(session)) {
        console.warn('Discarded a Signature import completion from a previous Vault session.');
        return;
      }

      if (summary.recipes.length > 0) {
        let next = personalRecipesRef.current;
        for (const recipe of summary.recipes) {
          next = upsertCanonicalRecipe(next, recipe);
        }
        personalRecipesRef.current = next;
        committedRecipesRef.current = next;
        setPersonalRecipes(next);
        vaultAuthority.markCollectionChanged(session);
      }
      setHasPersonalVaultCollection(true);
      setSignatureImportState({ status: 'done', completed: total, total, summary });
      const hasProblems = summary.permissionRequired > 0 || summary.failed > 0 || summary.verificationFailed > 0 || summary.pathConflicts > 0;
      const stopped = summary.cancelled > 0;
      setVaultNotice({
        tone: stopped ? (summary.added > 0 ? 'info' : 'error') : summary.added > 0 && !hasProblems ? 'success' : hasProblems ? 'error' : 'info',
        message: summary.cancelReason ? `${summary.message} ${summary.cancelReason}` : summary.message,
      });
    } catch (error) {
      if (appUnmountedRef.current || !vaultAuthority.isCurrent(session)) return;
      const message = isVaultSessionSuperseded(error)
        ? 'The Vault changed before this import completed. Any files already written remain in the previous Vault and were not merged into the new one.'
        : 'The Signature Nine import stopped unexpectedly. Any files already written remain; the active collection was not updated.';
      setSignatureImportState({ status: 'done', completed: 0, total, summary: null });
      setVaultNotice({ tone: 'error', message });
    }
  };

  const dismissSignatureImport = () => {
    setSignaturePromptOpen(false);
    setSignatureImportState({ status: 'idle', completed: 0, total: 0, summary: null });
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
        await commitRecipeWrite(current.working, current.base);
      } catch (err) {
        if (isVaultSessionSuperseded(err)) {
          return { ok: false, saved: false, reason_code: 'write_failed', message: 'The Vault changed before this save completed. Nothing was written to the new Vault.' };
        }
        reportVaultError('save', current.working.title || 'recipe', err);
        return { ok: false, saved: false, reason_code: 'write_failed', message: 'The recipe could not be saved to the vault.' };
      }
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
  // Publish the working-recipe summary in a LAYOUT effect so the visible
  // Apply/Save banner reflects a just-applied Advanced Nutrition block in the
  // SAME paint. A passive effect left a transient "saved" frame after Apply
  // even though the block existed only in the working copy. This remains a
  // display-order fix; it never writes or saves anything.
  useLayoutEffect(() => {
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
    await ensureDesktopVaultForSave();
    const active = activeVaultRef.current;
    const session = active.session;
    if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(session)) {
      throw vaultSessionSupersededError();
    }
    try {
      if (active.adapter) {
        const lease = vaultAuthority.beginWrite(session);
        if (!lease) throw vaultSessionSupersededError();
        try {
          const validation = await validateRecipeAssetReferences(
            {
              asset: createBrowserAssetAdapter(active.handle),
              folderHandle: active.handle,
              assetScope: active.assetScope,
            },
            recipe
          );
          if (!validation.ok) {
            throw new Error(validation.reason || 'The active Vault could not verify this recipe image reference.');
          }
          await saveGeneratedRecipeToVault(active.adapter, recipe);
        } finally {
          lease.release();
        }
      } else {
        // Disconnected: no vault exists()-check support; preserve the download-to-disk
        // fallback for this generated draft (out of collision-safety scope).
        await saveRecipeToVaultFile(recipe, undefined);
      }
    } catch (err) {
      if (err instanceof GeneratedRecipePathCollisionError) {
        throw err; // let the modal surface the collision message and keep edits
      }
      if (isVaultSessionSuperseded(err)) throw err;
      reportVaultError('save', recipe.title || 'recipe', err);
      throw err;
    }
    if (!vaultAuthority.isCurrent(session)) return;
    if (active.adapter) vaultAuthority.markCollectionChanged(session);
    // Insert/update by canonical vault-path identity (never basename), so a root
    // `Dish.md` can never replace `B/Dish.md` on a basename match.
    setPersonalRecipes((prev) => upsertCanonicalRecipe(prev, recipe));
    setIsCreateForMeOpen(false);
  };

  // Update Nutrition on a recipe and save to Obsidian Markdown frontmatter
  const handleUpdateNutrition = async (recipe: ObsidianRecipe, nutrition: RecipeNutrition) => {
    if (isBuiltInRecipe(recipe)) return;
    const updatedRecipe: ObsidianRecipe = {
      ...recipe,
      nutrition,
      calories: nutrition.calories !== undefined ? nutrition.calories.toString() : recipe.calories,
      ratingExplicit: recipe.ratingExplicit,
      ratingSource: recipe.ratingSource,
    };
    // Keep the existing raw body; the preserving canonical serializer patches
    // only the nutrition/frontmatter fields that changed.

    // Write FIRST then commit state (defect C): a failed canonical write must not
    // mutate the displayed canonical recipe. Route through commitRecipeWrite so
    // nutrition edits share the per-recipe write queue with favorite toggles.
    try {
      await commitRecipeWrite(updatedRecipe, recipe);
    } catch (err) {
      if (!isVaultSessionSuperseded(err)) reportVaultError('save', updatedRecipe.title || 'recipe', err);
      return;
    }
  };

  // Phase 5B: Apply moves the freshly authorized nutrition block into the
  // unsaved recipe working copy. The existing banner's explicit Save to vault
  // action remains the only persistence boundary.
  const handleApplyAdvancedNutrition: AdvancedNutritionApplyHandler = async (
    args: AdvancedNutritionApplyHandlerArgs
  ): Promise<AdvancedNutritionApplyUiResult> => {
    // AUTHORITATIVE PRODUCT-ACCESS GATE. The Advanced Apply operation is not a
    // Basic feature. This check runs at the operation boundary, not only in the
    // button render, so a Basic deployment cannot apply an Advanced review even if
    // a stale/forged UI state reaches this handler.
    if (nutritionAiClientStateRef.current?.productAccessIsAiAdvanced !== true) {
      return {
        ok: false,
        message:
          'Advanced Nutrition editing is not enabled for this deployment. Basic Nutrition remains available in Nutrition & Macros.',
      };
    }
    if (isBuiltInRecipe(args.recipe)) {
      return {
        ok: false,
        message: 'Signature Collection originals are read-only. Save this recipe to My Vault before applying nutrition changes.',
      };
    }
    // SINC-2R2: branded evidence is server-authenticated. The working review may
    // contain a proposal, but Apply is the trust boundary: re-verify the exact
    // contribution against the server-held source snapshot and the exact local
    // target before any persistence authorization can run.
    const brandedContributions = args.state.aiNutrition?.contributions.filter(
      (entry) => entry.source_kind === 'usda_branded'
    ) ?? [];
    let applyState = args.state;
    if (brandedContributions.length > 0) {
      const recipeDigest = args.state.preview?.ingredient_digest;
      const reviewIdentity = brandedReviewIdentity(
        args.state.sessionIdentity ?? '',
        args.state.recipeKey ?? '',
        args.state.baseServings
      );
      if (!recipeDigest) {
        return { ok: false, message: 'The branded evidence is not bound to a current recipe review. Recalculate and review again.' };
      }
      let verified: Awaited<ReturnType<typeof verifyUsdaBrandedContributionsForApply>>;
      try {
        verified = await verifyUsdaBrandedContributionsForApply({
          network: networkAdapter,
          contributions: brandedContributions,
          recipeDigest,
          reviewIdentity,
        });
      } catch {
        return { ok: false, message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
      }
      if (verified.ok !== true) {
        return { ok: false, message: verified.message };
      }
      const verifiedByLine = new Map(verified.contributions.map((entry) => [entry.line_ref, entry]));
      const contributions = args.state.aiNutrition!.contributions.map((entry) =>
        entry.source_kind === 'usda_branded' ? verifiedByLine.get(entry.line_ref) ?? entry : entry
      );
      applyState = {
        ...args.state,
        aiNutrition: {
          ...args.state.aiNutrition!,
          contributions: Object.freeze(contributions),
        },
      };
    }
    const result = await applyAdvancedNutrition({
      session: args.session,
      recipe: args.recipe,
      state: applyState,
      expectedMode: args.expectedMode,
      ...(args.reviewReasons !== undefined ? { reviewReasons: args.reviewReasons } : {}),
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
      advancedEditingAccess: state.productAccessIsAiAdvanced
        ? ('entitled' as const)
        : state.productAccessIsBasic
          ? ('basic' as const)
          : ('unknown' as const),
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
   * `deterministicReview` and `manualEditing` are literal `true` here because they
   * describe the deterministic ENGINE available in this build. PRODUCT entitlement
   * to open the Advanced workspace and edit USDA matches/portions is separate and
   * is derived from the server-owned product tier in the presentation state below.
   * Only the AI assistance layer is gated by provider readiness.
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
   * Components receive the effective AI availability, a fixed bounded reason,
   * and the SEPARATE product entitlement for Advanced editing. They never call
   * the status endpoint, never import the application layer, never inspect the
   * environment, never infer BYOK, and never resolve entitlement themselves.
   *
   * Before the lazy read completes this is `unknown` rather than Basic, so the UI
   * cannot claim a product fact the server has not stated and cannot open the
   * paid Advanced workspace.
   */
  const [nutritionAiPresentation, setNutritionAiPresentation] = useState<{
    readonly available: boolean;
    readonly reason: string | null;
    readonly refreshing: boolean;
    readonly canRetry: boolean;
    readonly advancedEditingAccess: 'unknown' | 'basic' | 'entitled';
  }>(() => {
    const initial = unresolvedNutritionAiClientState();
    return {
      available: initial.available,
      reason: nutritionAiUnavailableMessage(initial.availability),
      refreshing: false,
      canRetry: true,
      advancedEditingAccess: 'unknown',
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

  /**
   * Lightweight product-tier read used only to decide whether Basic or Advanced
   * UI may be offered. It never loads the USDA bundle and never probes a
   * provider; it reuses the same server-owned product access endpoint and cached
   * decision.
   */
  const handleResolveAdvancedEditingAccess = useCallback(() => {
    if (nutritionRefreshingRef.current) return;
    if (nutritionProductReadRef.current !== null) return;
    void runNutritionAiRefresh({ reuseProductAccess: false });
  }, [runNutritionAiRefresh]);

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
    orchestration,
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
      // AN-ARCH-1: ONLY the explicit Generate operation authorizes a validated
      // AI semantic match to remain automatic. The manual AI-help action keeps
      // the conservative below-threshold offer contract unchanged.
      ...(orchestration === 'generate' ? { acceptValidatedSemanticMatches: true } : {}),
      ...(wholeRecipe !== undefined ? { wholeRecipe } : {}),
    });
  };

  /**
   * AI-FIRST GENERATE — the experimental two-pass workflow.
   *
   * ONE explicit Generate action. Pass 1 is the released whole-recipe semantic
   * route. The browser then performs bounded full-catalog USDA discovery and
   * sends the ACTUAL candidate descriptions to the pass-2 evaluation route. The
   * returned opaque refs are resolved against the SAME local session and every
   * selection is re-authenticated before the existing card merge sees it.
   *
   * No third pass, no hidden retry, no fallback to the legacy AI resolver.
   */
  const handleResolveAdvancedNutritionAiFirst: AdvancedNutritionAiResolveHandler = async ({
    session,
    rows,
    adapted,
    recipe,
    signal,
  }) => {
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
    return resolveWithAiFirst({
      network: networkAdapter,
      session,
      rows,
      adapted,
      capabilities: await resolveEffectiveNutritionCapabilitiesOnce(),
      ...(recipe !== undefined ? { recipe } : {}),
      ...(wholeRecipe !== undefined ? { wholeRecipe } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  };

  /**
   * AN-WEB-1 — explicit external nutrition research.
   *
   * The application transport re-validates every returned source-backed
   * contribution against the exact requested lines. Evidence remains an OFFER
   * until the user accepts it in Advanced Nutrition.
   */
  /**
   * SINC-2 — explicit USDA Branded Foods lookup.
   *
   * Only the selected food term leaves the browser. The server owns the USDA
   * key and returns validated source snapshots. Nothing is applied here.
   */
  const handleSearchBrandedFoods: AdvancedNutritionBrandedLookupHandler = async ({
    lineRef,
    query,
    signal,
  }) => {
    const result = await requestUsdaBrandedFoodLookup({
      network: networkAdapter,
      lineRef,
      query,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.ok !== true) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      };
    }
    return {
      ok: true,
      message: result.message,
      candidates: result.candidates,
      cacheStatus: result.cacheStatus,
      retrievedAt: result.retrievedAt,
    };
  };

  const handleResearchAdvancedNutritionAi: AdvancedNutritionResearchHandler = async ({
    targets,
    lineRefs,
    lineTextByRef,
    signal,
  }) => {
    const result = await requestNutritionWebResearch({
      network: networkAdapter,
      targets,
      lineRefs,
      lineTextByRef,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.ok !== true) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        skipped: result.skipped,
      };
    }
    const contributionByRef = new Map(result.contributions.map((entry) => [entry.line_ref, entry]));
    const offers = result.evidence.map((evidence) => {
      const contribution = contributionByRef.get(evidence.line_ref);
      return {
        line_ref: evidence.line_ref,
        ingredient: contribution?.ingredient ?? evidence.food_identity,
        source_title: evidence.source_title,
        source_url: evidence.source_url,
        quantity_basis: evidence.quantity_basis,
        classification: 'source_backed' as const,
        nutrients: evidence.nutrients,
        limitations: evidence.limitations,
      };
    });
    return {
      ok: true,
      message: result.message,
      contributions: result.contributions,
      offers,
      skipped: result.skipped,
    };
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
    const active = activeVaultRef.current;
    const session = active.session;
    if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(session)) return;

    setNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === note.id || n.fileName.toLowerCase() === note.fileName.toLowerCase());
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = note;
        return next;
      }
      return [note, ...prev];
    });

    if (active.handle) {
      const lease = vaultAuthority.beginWrite(session);
      if (!lease) return;
      try {
        const fileName = note.fileName.endsWith('.md') ? note.fileName : `${note.fileName}.md`;
        let targetDir = active.handle;
        try {
          targetDir = await active.handle.getDirectoryHandle('Notes', { create: true });
        } catch {
          targetDir = active.handle;
        }
        const fileHandle = await targetDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(note.rawMarkdown);
        await writable.close();
        if (vaultAuthority.isCurrent(session)) vaultAuthority.markCollectionChanged(session);
      } catch (err) {
        if (vaultAuthority.isCurrent(session) && !vaultAuthority.writesBlocked()) {
          console.warn('Could not write note to vault filesystem:', err);
        }
      } finally {
        lease.release();
      }
    }
  };

  // Delete Recipe
  const handleDeleteRecipe = async (recipeToDelete: ObsidianRecipe) => {
    if (isBuiltInRecipe(recipeToDelete)) return;
    const active = activeVaultRef.current;
    const session = active.session;
    if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(session)) return;
    // Write FIRST: only remove from state after the vault delete succeeds (defect C).
    if (active.adapter) {
      const lease = vaultAuthority.beginWrite(session);
      if (!lease) return;
      try {
        await deleteRecipeWithVaultAdapter(active.adapter, recipeToDelete);
      } catch (err) {
        if (vaultAuthority.isCurrent(session)) {
          // The disk delete failed: do NOT claim it was deleted. Keep prior state.
          reportVaultError('delete', recipeToDelete.title || 'recipe', err);
        }
        return;
      } finally {
        lease.release();
      }
    }
    if (!vaultAuthority.isCurrent(session)) return;
    if (active.adapter) vaultAuthority.markCollectionChanged(session);
    // Remove by canonical vault-path identity, never basename (defect B).
    setPersonalRecipes((prev) => removeCanonicalRecipe(prev, recipeToDelete));
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

  // Authoritative committed PERSONAL recipe state (updated only after successful
  // writes and vault loads). Built-ins are intentionally absent: no write path may
  // ever rebase or persist a built-in original.
  const committedRecipesRef = useRef<ObsidianRecipe[]>([]);

  // Keep synchronous mirrors so toggles never read a stale closure.
  const recipesRef = useRef(recipes);
  const personalRecipesRef = useRef<ObsidianRecipe[]>(personalRecipes);
  const starterOverridesRef = useRef<Record<string, Partial<ObsidianRecipe>>>({});
  useEffect(() => {
    personalRecipesRef.current = personalRecipes;
  }, [personalRecipes]);
  useEffect(() => {
    starterOverridesRef.current = starterOverrides;
  }, [starterOverrides]);
  useEffect(() => {
    recipesRef.current = recipes;
  }, [recipes]);
  const selectedRecipeRef = useRef(selectedRecipe);
  useEffect(() => {
    selectedRecipeRef.current = selectedRecipe;
  }, [selectedRecipe]);
  const favoriteOperationIdRef = useRef<Map<string, number>>(new Map());
  const ratingOperationIdRef = useRef<Map<string, number>>(new Map());

  const updatePersonalRecipes = useCallback((updater: (current: ObsidianRecipe[]) => ObsidianRecipe[]) => {
    const next = updater(personalRecipesRef.current);
    personalRecipesRef.current = next;
    setPersonalRecipes(next);
    if (hasPersonalVaultCollection) {
      recipesRef.current = next;
    } else {
      recipesRef.current = starterRecipes.map((recipe) => {
        const override = recipe.builtInId ? starterOverridesRef.current[recipe.builtInId] : undefined;
        return override ? { ...recipe, ...override } : recipe;
      });
    }
  }, [hasPersonalVaultCollection, starterRecipes]);

  const updateStarterOverride = useCallback((builtInId: string, patch: Partial<ObsidianRecipe>) => {
    const next = {
      ...starterOverridesRef.current,
      [builtInId]: { ...(starterOverridesRef.current[builtInId] || {}), ...patch },
    };
    starterOverridesRef.current = next;
    recipesRef.current = recipesRef.current.map((recipe) =>
      recipe.isBuiltIn && recipe.builtInId === builtInId ? { ...recipe, ...patch } : recipe
    );
    setStarterOverrides(next);
  }, []);

  // Toggle Favorite
  //
  // Personal recipes persist through the authoritative recipe-storage mechanism
  // (write first, then commit state). Built-in favorites are in-memory demo state
  // only: they never write to the Vault and are never counted as personal.
  const handleToggleFavorite = (recipeId: string) => {
    const current =
      recipesRef.current.find((r) => r.id === recipeId) ||
      (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId
        ? selectedRecipeRef.current
        : undefined);
    if (!current) return;

    const nextFavorite = !Boolean(current.isFavorite);

    if (isBuiltInRecipe(current)) {
      if (!current.builtInId) return;
      updateStarterOverride(current.builtInId, { isFavorite: nextFavorite });
      if (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId) {
        const optimisticSelected = { ...selectedRecipeRef.current, isFavorite: nextFavorite };
        selectedRecipeRef.current = optimisticSelected;
        setSelectedRecipe(optimisticSelected);
      }
      return;
    }

    const sessionAtRequest = activeVaultRef.current.session;
    if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(sessionAtRequest)) return;

    // Operation identity for this toggle, so a stale failed write cannot roll
    // back a newer optimistic user selection.
    const operationId = (favoriteOperationIdRef.current.get(recipeId) ?? 0) + 1;
    favoriteOperationIdRef.current.set(recipeId, operationId);

    const optimisticRecipe: ObsidianRecipe = { ...current, isFavorite: nextFavorite };
    recipesRef.current = recipesRef.current.map((r) =>
      r.id === recipeId ? optimisticRecipe : r
    );
    updatePersonalRecipes((prev) => prev.map((r) => (r.id === recipeId ? optimisticRecipe : r)));
    if (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId) {
      const optimisticSelected: ObsidianRecipe = { ...selectedRecipeRef.current, isFavorite: nextFavorite };
      selectedRecipeRef.current = optimisticSelected;
      setSelectedRecipe(optimisticSelected);
    }

    if (!vaultAdapter) return;

    const persist = async () => {
      if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(sessionAtRequest)) return;
      const latest = personalRecipesRef.current.find((r) => r.id === recipeId);
      if (!latest) return;
      try {
        await commitRecipeWrite(latest, current);
      } catch (err) {
        if (isVaultSessionSuperseded(err)) return;
        reportVaultError('save', latest.title || 'recipe', err);
        // Roll back ONLY if no newer toggle has superseded this operation.
        if (favoriteOperationIdRef.current.get(recipeId) === operationId) {
          const revertedFavorite = current.isFavorite;
          recipesRef.current = recipesRef.current.map((r) =>
            r.id === recipeId ? { ...r, isFavorite: revertedFavorite } : r
          );
          updatePersonalRecipes((prev) =>
            prev.map((r) => (r.id === recipeId ? { ...r, isFavorite: revertedFavorite } : r))
          );
          if (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId) {
            const revertedSelected: ObsidianRecipe = { ...selectedRecipeRef.current, isFavorite: revertedFavorite };
            selectedRecipeRef.current = revertedSelected;
            setSelectedRecipe(revertedSelected);
          }
        }
      }
    };

    // Fire and forget; commitRecipeWrite serializes the actual write per recipe.
    void persist();
  };


  // Rate recipe (interactive five-star). Personal recipes persist through the
  // authoritative recipe-storage path; built-in ratings are in-memory only and
  // never touch the Vault. Rating 0 represents an unrated/cleared recipe.
  const handleRateRecipe = async (recipeId: string, rating: number) => {
    const current =
      recipesRef.current.find((r) => r.id === recipeId) ||
      (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId
        ? selectedRecipeRef.current
        : undefined);
    if (!current) return;

    const nextRating = Math.min(5, Math.max(0, Math.round(rating)));
    const ratingPatch = {
      rating: nextRating,
      ratingExplicit: true,
      ratingSource: nextRating > 0 ? 'personal' as const : undefined,
    };

    if (isBuiltInRecipe(current)) {
      if (!current.builtInId) return;
      updateStarterOverride(current.builtInId, ratingPatch);
      if (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId) {
        const optimisticSelected = { ...selectedRecipeRef.current, ...ratingPatch };
        selectedRecipeRef.current = optimisticSelected;
        setSelectedRecipe(optimisticSelected);
      }
      return;
    }

    const sessionAtRequest = activeVaultRef.current.session;
    if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(sessionAtRequest)) return;

    const operationId = (ratingOperationIdRef.current.get(recipeId) ?? 0) + 1;
    ratingOperationIdRef.current.set(recipeId, operationId);

    const optimisticRecipe: ObsidianRecipe = { ...current, ...ratingPatch };
    recipesRef.current = recipesRef.current.map((r) =>
      r.id === recipeId ? optimisticRecipe : r
    );
    updatePersonalRecipes((prev) => prev.map((r) => (r.id === recipeId ? optimisticRecipe : r)));
    if (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId) {
      const optimisticSelected: ObsidianRecipe = { ...selectedRecipeRef.current, ...ratingPatch };
      selectedRecipeRef.current = optimisticSelected;
      setSelectedRecipe(optimisticSelected);
    }

    if (!vaultAdapter) return;

    const persist = async () => {
      if (vaultAuthority.writesBlocked() || !vaultAuthority.isCurrent(sessionAtRequest)) return;
      const latest = personalRecipesRef.current.find((r) => r.id === recipeId);
      if (!latest) return;
      try {
        await commitRecipeWrite(latest, current);
      } catch (err) {
        if (isVaultSessionSuperseded(err)) return;
        reportVaultError('save', latest.title || 'recipe', err);
        if (ratingOperationIdRef.current.get(recipeId) === operationId) {
          const revertedRating = current.rating;
          recipesRef.current = recipesRef.current.map((r) =>
            r.id === recipeId ? { ...r, rating: revertedRating, ratingSource: current.ratingSource } : r
          );
          updatePersonalRecipes((prev) =>
            prev.map((r) => (r.id === recipeId ? { ...r, rating: revertedRating, ratingSource: current.ratingSource } : r))
          );
          if (selectedRecipeRef.current && selectedRecipeRef.current.id === recipeId) {
            const revertedSelected: ObsidianRecipe = { ...selectedRecipeRef.current, rating: revertedRating, ratingSource: current.ratingSource };
            selectedRecipeRef.current = revertedSelected;
            setSelectedRecipe(revertedSelected);
          }
        }
      }
    };

    void persist();
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
      const next = normalizeMealPlanDays(prev);
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
      const next = normalizeMealPlanDays(prev);
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
    setMealPlan(normalizeMealPlanDays([]));
    setShoppingCategories([]);
  };

  const handleAddToMealPlan = (r: ObsidianRecipe) => {
    setMealPlan((prev) => {
      const next = addRecipeToMealPlan(prev, r);
      setShoppingCategories((prevShop) =>
        generateShoppingFromMealPlan(next, recipes, prevShop)
      );
      return next;
    });
    setActiveTab('mealplan');
  };

  const handleGenerateWeeklyShoppingList = () => {
    setShoppingCategories((prevShop) =>
      generateShoppingFromMealPlan(normalizeMealPlanDays(mealPlan), recipes, prevShop)
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

      // Navigation-only Favorites view. This is separate from the manual filter
      // controls, so navigating never erases the user's filters.
      if (vaultView === 'favorites' && activeTab === 'grid' && !recipe.isFavorite) return false;
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
  }, [recipes, searchQuery, filters, vaultView, activeTab]);

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

  const isFavoritesView = vaultView === 'favorites' && activeTab === 'grid';
  const hasFavoriteRecipes = recipes.some((recipe) => recipe.isFavorite);
  const favoriteRecipeCount = useMemo(
    () => recipes.filter((recipe) => recipe.isFavorite).length,
    [recipes]
  );
  const collectionRecipeTotal = isFavoritesView ? favoriteRecipeCount : recipes.length;
  const collectionCountLabel = isFavoritesView
    ? `${collectionRecipeTotal} ${collectionRecipeTotal === 1 ? 'favorite' : 'favorites'}`
    : `${collectionRecipeTotal} ${collectionRecipeTotal === 1 ? 'recipe' : 'recipes'}`;

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
    isFavoritesView
      ? 'Favorites'
      : !hasPersonalVaultCollection
        ? 'Starter cookbook'
        : vaultConnectionState === 'permission_denied'
          ? 'Vault access denied'
          : vaultConnectionState === 'reauthorization_required'
            ? 'Vault awaiting access'
            : vaultStatus.isConnected
              ? liveFilesystemVault
                ? 'Private vault'
                : 'Imported collection'
              : 'My Recipe Vault';
  const vaultIntroduction =
    isFavoritesView
      ? 'The recipes you have marked as favorites.'
      : !hasPersonalVaultCollection
        ? 'Nine carefully curated recipes are ready to cook. They are read-only starter templates until you connect a writable Vault and explicitly save or import them.'
        : vaultConnectionState === 'permission_denied'
          ? 'The browser refused access to your remembered Vault. Reconnect, or choose the folder again, to restore your own recipes.'
          : vaultConnectionState === 'reauthorization_required'
            ? 'Your Vault is remembered, but the browser needs your permission before its recipes can be shown.'
            : vaultStatus.isConnected
              ? liveFilesystemVault
                ? 'Your saved recipes, gathered from your connected Vault.'
                : 'Recipes loaded into this session. Connect a writable Vault folder to make future changes durable.'
              : 'My Recipe Vault.';
  const vaultPageTitle = isFavoritesView ? 'Favorites' : 'My Recipe Vault';

  const vaultHealthSummary = useMemo(() => {
    return summarizeVaultHealth(personalRecipes);
  }, [personalRecipes]);

  return (
    <VaultAssetScopeProvider scope={activeAssetScope}>
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
        let folderDrop = false;
        let droppedFolderName = 'Dropped folder';
        try {
          const items = Array.from(e.dataTransfer.items || []);
          for (const item of items) {
            try {
              const entry = (item as any).webkitGetAsEntry?.();
              if (entry?.isDirectory) {
                folderDrop = true;
                if (typeof entry.name === 'string' && entry.name) droppedFolderName = entry.name;
                break;
              }
            } catch {
              // Ignore an item that cannot expose an entry.
            }
          }
        } catch {
          folderDrop = false;
        }
        const importSession = vaultAuthority.current();
        // Folder drops share the SAME intent + provisional asset scope as the
        // picker. Additive drops use the active collection scope.
        const folderStart = folderDrop ? beginCollectionImportWithScope() : null;
        const additiveAssetScope = folderDrop ? null : activeVaultRef.current.assetScope;
        try {
          const result = await parseDroppedFilesAndFolders(
            e.dataTransfer,
            folderStart?.assetScope ?? additiveAssetScope ?? undefined
          );

          if (folderDrop) {
            // A dropped folder is a complete imported collection and must go
            // through the same barrier/invalidation as the folder picker.
            await transitionToUploadedCollection({
              recipes: result.recipes,
              notes: result.notes ?? [],
              mealPlan: result.mealPlan ?? [],
              shoppingList: result.shoppingList ?? [],
              folderName: droppedFolderName,
            }, folderStart?.intent, folderStart?.assetScope);
            return;
          }

          // Additive file drops still belong to the collection they were
          // dropped into. If the active session changed while parsing, discard.
          if (!vaultAuthority.isCurrent(importSession) || vaultAuthority.writesBlocked()) {
            return;
          }
          const parsedNotes = result.notes ?? [];

          if (result.recipes.length > 0) {
            setPersonalRecipes((prev) => {
              const map = new Map(prev.map((r) => [r.id, r]));
              result.recipes.forEach((r) => map.set(r.id, r));
              return Array.from(map.values());
            });
          }
          if (parsedNotes.length > 0) {
            setNotes((prev) => {
              const map = new Map(prev.map((n) => [n.id, n]));
              parsedNotes.forEach((n) => map.set(n.id, n));
              return Array.from(map.values());
            });
          }
          if (result.mealPlan) setMealPlan(normalizeMealPlanDays(result.mealPlan));
          if (result.shoppingList) setShoppingCategories(result.shoppingList);

          if (result.recipes.length > 0 || result.mealPlan || result.shoppingList || parsedNotes.length > 0) {
            setHasPersonalVaultCollection(true);
            setVaultNotice(null);
            setVaultStatus((prev) => ({
              ...prev,
              isConnected: true,
              accessType: 'uploaded_folder',
              connectionState: 'connected',
            }));
            setSignatureImportState({ status: 'idle', completed: 0, total: 0, summary: null });
            setSignaturePromptOpen(true);
          }
        } catch (err) {
          folderStart?.assetScope.deactivate();
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
        vaultView={vaultView}
        setVaultView={setVaultView}
        onFavorites={() => {
          setVaultView('favorites');
          setActiveTab('grid');
          setSelectedRecipe(null);
        }}
      />

      <div className="flex-1 flex flex-col min-w-0">
      {/* Top Header */}
      <VaultHeader
        vaultStatus={vaultStatus}
        activeTab={activeTab}
        vaultView={vaultView}
        favoriteCount={favoriteRecipeCount}
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
          if (vaultAuthority.writesBlocked()) {
            setVaultNotice({ tone: 'info', message: 'A Vault change is in progress. Refresh is available once it finishes.' });
            return;
          }
          const active = activeVaultRef.current;
          if (active.session.kind === 'filesystem' && vaultAuthority.activeWriteCount(active.session) > 0) {
            setVaultNotice({ tone: 'info', message: 'A Vault operation is in progress. Refresh is available once it finishes.' });
            return;
          }
          if (active.session.kind === 'filesystem' && active.handle) {
            const scan = vaultAuthority.beginScan(active.session);
            if (!scan) return;
            try {
              const result = await loadVaultFromHandle(active.handle, active.assetScope);
              if (
                appUnmountedRef.current ||
                !vaultAuthority.isScanCurrent(scan) ||
                !vaultAuthority.isCurrent(active.session) ||
                activeVaultRef.current.handle !== active.handle
              ) {
                return;
              }
              commitVaultSnapshot(result, active.session, active.handle);
            } catch (err) {
              if (vaultAuthority.isScanCurrent(scan)) {
                console.warn('Re-scan failed:', err);
              }
            }
          } else if (active.session.kind === 'uploaded') {
            // A read-only upload has no persistent rescan source. Preserve the
            // imported recipes/notes/plan/shopping list and say so truthfully;
            // never substitute the Signature starter collection.
            setVaultNotice({
              tone: 'info',
              message: 'This imported collection is read-only and cannot be rescanned from disk. Your recipes, notes, meal plan, and shopping list are unchanged. Re-import the folder to update it.',
            });
          } else {
            // The actual active collection is the starter cookbook. Only then
            // is resetting the in-memory demo personalization/plan correct.
            setStarterOverrides({});
            setMealPlan(normalizeMealPlanDays(STARTER_MEAL_PLAN));
            setShoppingCategories(STARTER_SHOPPING_CATEGORIES);
            setVaultHydratedState(true);
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
        {vaultNotice && (
          <div className="mx-auto w-full max-w-5xl px-4 pt-4 sm:px-6">
            <div
              data-testid="vault-notice"
              role={vaultNotice.tone === 'error' ? 'alert' : 'status'}
              className={`flex items-start justify-between gap-3 rounded-xl border-l-[3px] px-4 py-3 text-[12px] leading-relaxed ${
                vaultNotice.tone === 'success'
                  ? 'border-l-emerald-400 bg-emerald-500/10 text-[var(--text-primary,#F3F4F6)]'
                  : vaultNotice.tone === 'error'
                    ? 'border-l-amber-500 bg-amber-500/10 text-[var(--text-primary,#F3F4F6)]'
                    : 'border-l-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--text-primary,#F3F4F6)]'
              }`}
            >
              <span>{vaultNotice.message}</span>
              <button
                type="button"
                onClick={() => setVaultNotice(null)}
                aria-label="Dismiss message"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
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
            onSaveToVault={handleSaveStarterToVault}
            starterSaveState={starterSaveState}
            starterSavePending={starterSavePending}
            onDeleteRecipe={handleDeleteRecipe}
            onAddToMealPlan={(recipe) => {
              handleAddToMealPlan(recipe);
              setSelectedRecipe(null);
            }}
            onToggleFavorite={handleToggleFavorite}
            onRateRecipe={handleRateRecipe}
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
            voiceService={voiceService}
            advancedNutritionSession={advancedNutritionBundle.session}
            advancedNutritionBundleStatus={advancedNutritionBundle.status}
            onLoadAdvancedNutritionBundle={handleLoadAdvancedNutritionBundle}
            onApplyAdvancedNutrition={handleApplyAdvancedNutrition}
            onResolveAdvancedNutritionAi={handleResolveAdvancedNutritionAi}
            onResolveAdvancedNutritionAiFirst={
              AI_FIRST_GENERATE_ENABLED ? handleResolveAdvancedNutritionAiFirst : undefined
            }
            onResearchAdvancedNutritionAi={handleResearchAdvancedNutritionAi}
            onSearchBrandedFoods={handleSearchBrandedFoods}
            onEstimateMassesWithAi={handleEstimateMassesWithAi}
            onReviewRecipeContextWithAi={handleReviewRecipeContextWithAi}
            advancedNutritionAiAvailability={{
              ...nutritionAiPresentation,
              onResolveAccess: handleResolveAdvancedEditingAccess,
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
                    {vaultPageTitle}
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
                      ? `Showing ${filteredRecipes.length} of ${collectionRecipeTotal}`
                      : collectionCountLabel}
                  </p>
                </div>
              </div>
            </section>

            {filteredRecipes.length === 0 ? (
              hasPersonalVaultCollection && personalRecipes.length === 0 ? (
                <div className="mt-8 border border-dashed border-[var(--border-subtle,rgba(255,255,255,0.08))] px-6 py-16 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--accent-text,#F59E0B)]">
                    <BookOpen className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                  </div>
                  <h2 className="mt-5 font-serif text-3xl font-medium text-[var(--text-primary,#F3F4F6)]">
                    No recipes in this Vault yet
                  </h2>
                  <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                    You can create a recipe, import your own notes, or optionally add the nine Signature recipes.
                    Existing Vault files are never overwritten.
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                    {vaultAdapter ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSignaturePromptOpen(true);
                          setIsConnectVaultOpen(true);
                        }}
                        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-sm bg-[var(--accent,#F59E0B)] px-4 text-sm font-semibold text-[var(--accent-contrast,#0C0C0C)] transition-colors hover:bg-[var(--accent-hover,#D97706)]"
                      >
                        Add Signature Nine
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setIsConnectVaultOpen(true)}
                        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-sm bg-[var(--accent,#F59E0B)] px-4 text-sm font-semibold text-[var(--accent-contrast,#0C0C0C)] transition-colors hover:bg-[var(--accent-hover,#D97706)]"
                      >
                        Connect a writable Vault
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingRecipe(null);
                        setIsEditorOpen(true);
                      }}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-sm border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-4 text-sm font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
                    >
                      New Recipe Note
                    </button>
                  </div>
                </div>
              ) : isFavoritesView && !hasFavoriteRecipes ? (
                <div className="mt-8 border border-dashed border-[var(--border-subtle,rgba(255,255,255,0.08))] px-6 py-16 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-subtle,rgba(245,158,11,0.12))] text-[var(--accent-text,#F59E0B)]">
                    <Star className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                  </div>
                  <h2 className="mt-5 font-serif text-3xl font-medium text-[var(--text-primary,#F3F4F6)]">
                    No favorite recipes yet
                  </h2>
                  <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                    Tap the heart on any recipe to save it here. Your full collection and filters remain available.
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => setVaultView('all')}
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-sm bg-[var(--accent,#F59E0B)] px-4 text-sm font-semibold text-[var(--accent-contrast,#0C0C0C)] transition-colors hover:bg-[var(--accent-hover,#D97706)]"
                    >
                      Browse all recipes
                    </button>
                  </div>
                </div>
              ) : (
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
              )
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
            <button
              type="button"
              onClick={() => setIsAboutUpdatesOpen(true)}
              className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium hover:bg-amber-500/20"
              aria-label="About and updates"
            >
              {APP_VERSION}
            </button>
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
          setVaultView('all');
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
              { label: 'Favorites', action: () => { setVaultView('favorites'); setActiveTab('grid'); } },
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

      {/* Floating Active Timers Bar — hidden while Cooking Mode is open to avoid a duplicate dock */}
      {!cookingRecipe && (
        <ActiveTimersBar
        timers={activeTimers}
        onToggleTimer={handleToggleTimer}
        onDeleteTimer={handleDeleteTimer}
        onAddCustomTimer={handleAddCustomTimer}
        />
      )}

      {/* Fullscreen Cooking Mode Modal */}
      {cookingRecipe && (
        <React.Suspense fallback={null}>
          <CookingModeModal
            recipe={cookingRecipe.recipe}
            servings={cookingRecipe.servings}
            network={networkAdapter}
            voiceService={voiceService}
            activeTimers={activeTimers}
            onStartTimer={handleStartTimer}
            onToggleTimer={handleToggleTimer}
            onDeleteTimer={handleDeleteTimer}
            onAddCustomTimer={handleAddCustomTimer}
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
            runSessionAsset={runSessionAssetOperation}
            onBeforeSave={ensureDesktopVaultForSave}
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
        recipes={personalRecipes}
        setRecipes={setPersonalRecipes}
        setMealPlan={setMealPlan}
        setShoppingCategories={setShoppingCategories}
        setNotes={setNotes}
        signatureImportOffer={signaturePromptOpen}
        signatureImportWritable={Boolean(vaultAdapter) && vaultWritePermission === 'granted'}
        signatureImportPermission={vaultWritePermission}
        signatureImportState={signatureImportState}
        onImportSignatureNine={() => { void handleImportSignatureNine(); }}
        onDismissSignatureImport={dismissSignatureImport}
        onOpenVaultFolder={isDesktopRuntime() && activeVaultRef.current.handle?.isDesktopVault
          ? () => { void openDesktopVaultFolder(); }
          : undefined}
        onImportedCollectionActivated={() => {
          setHasPersonalVaultCollection(true);
          setVaultView('all');
          setSelectedRecipe(null);
          setCookingRecipe(null);
          setEditingRecipe(null);
          setStarterSaveState(null);
          setStarterSavePending(false);
          setVaultNotice(null);
          setSignatureImportState({ status: 'idle', completed: 0, total: 0, summary: null });
          setSignaturePromptOpen(true);
        }}
        onReplaceCollection={transitionToUploadedCollection}
        beginCollectionImport={beginCollectionImportWithScope}
        captureCollectionSession={() => activeVaultRef.current.session}
        isCollectionOperationCurrent={(token) =>
          vaultAuthority.isCurrent(token as VaultSession | null | undefined)
        }
        onOpenWebGrabber={() => setIsGrabberOpen(true)}
        onDirectVaultConnected={handleDirectVaultConnected}
      />

      {/* About & Updates Modal */}
      <AboutUpdatesModal
        isOpen={isAboutUpdatesOpen}
        onClose={() => setIsAboutUpdatesOpen(false)}
        network={networkAdapter}
      />

      {/* Web Recipe Grabber Modal */}
      <RecipeGrabberModal
        isOpen={isGrabberOpen}
        folderHandle={vaultStatus.folderHandle}
        imageService={imageService}
        runSessionAsset={runSessionAssetOperation}
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
    </VaultAssetScopeProvider>
  );
}
