import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Activity, FlaskConical, Loader2, Lock, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ObsidianRecipe } from '../types';
import {
  INITIAL_PHASE4_STATE,
  PHASE4_BUNDLE_FAILED_MESSAGE,
  PHASE4_BUNDLE_RETRY_LABEL,
  PHASE4_IDLE_MESSAGE,
  PHASE4_LOADING_MESSAGE,
  PHASE4_UNAVAILABLE_MESSAGE,
  PHASE4_UNREADABLE_MESSAGE,
  PHASE4_UNSUPPORTED_MESSAGE,
  adaptRecipe,
  analyzeRecipe,
  basisLabel,
  buildCalculationRequest,
  buildReviewRows,
  coverageSummary,
  deriveDisplayNutrients,
  formatAmount,
  hydrateWorkingReview,
  phase4Failure,
  phase4Reducer,
  phase4SessionIdentity,
  readStoredBlock,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type AnalyzedRow,
  type MatchChoice,
  type Phase4Action,
  type Phase4Row,
  type Phase4State,
  type PortionChoice,
  type RecipeAnalysis,
  type UserMassChoice,
} from '../core/nutritionV2/phase4';
import { authorizeNutritionPersistence } from '../core/nutritionV2/phase5';
import type { CodexNutritionV1, CodexNutritionV2 } from '../core/nutritionV2/schema';
import {
  actionableExceptionRows,
  buildUserChoiceFromAiAmountOffer,
  ingredientEvidenceViews,
  liveExceptionKind,
  projectLiveRows,
  summarizeLiveRows,
  userConfirmedChoiceFromAiSuggestion,
  type AiAmountResolveOutcome,
  type AiResolutionIssueKind,
  type AiResolveOutcome,
  type CountPortionChoice,
  type HouseholdPortionChoice,
  type LiveRowState,
} from '../core/nutritionV2/phase4';
import {
  AdvancedNutritionModal,
  type AdvancedNutritionAiAmountOffer,
  type AdvancedNutritionApplyUi,
  type AdvancedNutritionAiUi,
  type AdvancedNutritionAiSuggestion,
} from './AdvancedNutritionModal';
import { AdvancedNutritionSavedReport } from './AdvancedNutritionSavedReport';

export type AdvancedNutritionBundleUiStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'failed'
  | 'unsupported';

/** Arguments for the explicit Phase 5B Apply handler (owned by the shell). */
export interface AdvancedNutritionApplyHandlerArgs {
  readonly session: AdvancedNutritionSession;
  readonly recipe: ObsidianRecipe;
  readonly state: Phase4State;
  readonly expectedMode: 'create' | 'replace';
}

export interface AdvancedNutritionApplyUiResult {
  readonly ok: boolean;
  readonly mode?: 'create' | 'replace';
  readonly message: string;
}

/**
 * The explicit Apply handler. The shell (App) implements it with the application
 * write coordinator + the existing vault write path. The card only renders the
 * control and the result; it never writes anything itself.
 */
export type AdvancedNutritionApplyHandler = (
  args: AdvancedNutritionApplyHandlerArgs
) => Promise<AdvancedNutritionApplyUiResult>;

interface AdvancedNutritionCardProps {
  recipe: ObsidianRecipe;
  session?: AdvancedNutritionSession | null;
  servings?: number;
  /** Phase 4.5B lazy local-bundle state (absent when no loader is wired). */
  bundleStatus?: AdvancedNutritionBundleUiStatus;
  /** Explicit user-triggered load. Absent when no loader is wired. */
  onLoadBundle?: () => void;
  /** Explicit Phase 5B Apply handler. Absent when no write path is wired. */
  onApplyAdvancedNutrition?: AdvancedNutritionApplyHandler;
  /**
   * The ALREADY-VALIDATED saved Advanced block, supplied by the consolidated
   * nutrition section. The saved report renders from this alone; no USDA
   * session is required. Absent for recipes without a recognized saved result.
   */
  savedAdvancedBlock?: CodexNutritionV1 | CodexNutritionV2;
  /**
   * Optional AI-assisted USDA resolution port, injected by the shell (the shell
   * owns the network + application layer; the UI never imports the application
   * layer directly). Advisory only: it returns deterministic local candidates.
   */
  onResolveWithAi?: AdvancedNutritionAiResolveHandler;
}

/**
 * Injected AI-resolution port. The shell sends the bounded unresolved rows to the
 * server resolver and resolves the advisory phrases against the genuine session.
 */
export type AdvancedNutritionAiResolveHandler = (args: {
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  /** Trusted application issue kind per actionable line ref (never inferred). */
  readonly issueKinds: Readonly<Record<string, AiResolutionIssueKind>>;
  /** The SAME live projection that renders the ingredient list. */
  readonly liveRows: ReadonlyArray<LiveRowState>;
  readonly state: Phase4State;
}) => Promise<{
  readonly ok: boolean;
  readonly message?: string;
  /** Number of advisory suggestions the resolver accepted as usable (optional). */
  readonly interpretedCount?: number;
  readonly outcome: AiResolveOutcome;
  readonly amounts: AiAmountResolveOutcome;
}>;

/**
 * The number of advisory suggestions that were actually processed by the local
 * verifiers, derived from the outcome itself. Used as the truthful fallback when
 * the resolver port does not report an explicit count.
 */
function interpretedSuggestionCount(result: {
  readonly outcome: AiResolveOutcome;
  readonly amounts: AiAmountResolveOutcome;
}): number {
  const refs = new Set<string>();
  for (const candidate of result.outcome.candidates) refs.add(candidate.line_ref);
  for (const ref of result.outcome.unresolved) refs.add(ref);
  for (const entry of result.amounts.resolved) refs.add(entry.line_ref);
  for (const entry of result.amounts.offers) refs.add(entry.line_ref);
  for (const ref of result.amounts.unresolved) refs.add(ref);
  for (const ref of result.amounts.inconsistent) refs.add(ref);
  return refs.size;
}

/**
 * Order-independent SEMANTIC key for one arbitrary working-choice value. Keys
 * are sorted recursively so a choice that is re-created with the same fields is
 * `===`-key-equal (never a false conflict), while any field the user actually
 * changed — food/FDC, review or record digest, portion index, selection digest,
 * automatic/AI provenance, mass — produces a different key. Never relies on
 * object identity. Bounded depth/keys keep it safe for frozen choice objects.
 */
function stableChoiceKey(value: unknown, depth = 0): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number' || type === 'boolean') return String(value);
  if (type !== 'object') return 'x';
  if (depth >= 8) return 'd';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableChoiceKey(entry, depth + 1)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableChoiceKey(record[key], depth + 1)}`)
    .join(',')}}`;
}

/**
 * The PER-LINE working-choice fingerprint used to preserve mid-flight user
 * edits. It covers every working selection that can resolve or alter one row:
 * the food match (authority + provenance), the authenticated source portion,
 * the authenticated count portion, and an explicit user-entered mass. Captured
 * for each AI-targeted row when the request starts and re-read immediately
 * before application; a changed fingerprint means the user edited that row
 * after the AI request began and the stale AI result must NOT overwrite it.
 */
function workingChoiceFingerprint(state: Phase4State, lineRef: string): string {
  return [
    stableChoiceKey(state.matches[lineRef]),
    stableChoiceKey(state.countPortions[lineRef]),
    stableChoiceKey(state.portions[lineRef]),
    stableChoiceKey(state.userMasses[lineRef]),
  ].join('\u0000');
}

type ApplyUiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming'; readonly mode: 'create' | 'replace' }
  | { readonly kind: 'applying' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

const NO_INGREDIENTS: ReadonlyArray<AdaptedIngredient> = Object.freeze([]);

export const AdvancedNutritionCard: React.FC<AdvancedNutritionCardProps> = ({
  recipe,
  session = null,
  bundleStatus,
  onLoadBundle,
  onApplyAdvancedNutrition,
  savedAdvancedBlock,
  onResolveWithAi,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isSavedReportOpen, setIsSavedReportOpen] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [applyState, setApplyState] = useState<ApplyUiState>({ kind: 'idle' });
  const [analysisRuns, setAnalysisRuns] = useState(0);
  const [state, dispatch] = useReducer(phase4Reducer, INITIAL_PHASE4_STATE);
  /**
   * Recipe-bound pending open intent. A Generate/Edit click that triggers a lazy
   * bundle load records the recipe key AT CLICK TIME; when the session arrives it
   * opens the editor ONLY if the same recipe is still current. A pending intent
   * from Recipe A can therefore never auto-open Recipe B.
   */
  const pendingOpenRecipeKey = useRef<string | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  // Hydration/dirty tracking for the working review.
  const hydratedKeyRef = useRef<string | null>(null);
  const [workingTouched, setWorkingTouched] = useState(false);
  const [hydratedFromSaved, setHydratedFromSaved] = useState(false);
  // AI-assisted USDA resolution (advisory only; never authority).
  const [aiRunning, setAiRunning] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, AdvancedNutritionAiSuggestion>>({});
  /**
   * AI-interpreted authenticated count portions that remain the USER'S explicit
   * choice (materially different weights). Never auto-selected.
   */
  const [aiAmountOffers, setAiAmountOffers] = useState<
    Record<string, ReadonlyArray<AdvancedNutritionAiAmountOffer>>
  >({});
  const aiRequestSeq = useRef(0);
  /**
   * Monotonic AI lifecycle generation. Bumped on every recipe-identity change so
   * an in-flight response created for a previous recipe can never land.
   */
  const aiGeneration = useRef(0);
  /** Synchronous re-entry guard (a rapid double-click must make ONE request). */
  const aiRunningRef = useRef(false);
  /** Latest recipe/session identity, readable from async callbacks. */
  const identityRef = useRef<{ recipeKey: string | null; sessionIdentity: string | null }>({
    recipeKey: null,
    sessionIdentity: null,
  });
  /** Latest editor-open state, readable from async callbacks. */
  const isOpenRef = useRef(false);
  /** Latest authoritative review state, readable from async callbacks. */
  const stateRef = useRef<Phase4State>(state);
  stateRef.current = state;
  /** Latest live row projection, readable from async callbacks. */
  const liveRowsRef = useRef<ReadonlyArray<LiveRowState>>(Object.freeze([]));
  /**
   * Set by the explicit Generate Nutrition action (bound to the recipe key at
   * click time) so the deterministic analyzer runs immediately once the working
   * editor opens for THAT recipe (one click, not two). It is consumed once and
   * NEVER set by viewing or by Edit / Re-analyze.
   */
  const [pendingGenerateRecipeKey, setPendingGenerateRecipeKey] = useState<string | null>(null);

  // The saved report renders from this ALREADY-VALIDATED block alone; no USDA
  // session, catalog authentication, or matcher initialization is required.
  const savedBlock = savedAdvancedBlock;

  // Materialize the narrow adaptation envelope ONCE, safely, before any recipe
  // or ingredient property is used. The untrusted runtime recipe is never read
  // directly.
  const adaptation = useMemo(() => adaptRecipe(recipe), [recipe]);
  const adapted = adaptation.ok ? adaptation.recipe.adapted : NO_INGREDIENTS;
  const rows = useMemo(
    () => (session && adaptation.ok ? buildReviewRows(session, adapted) : []),
    [session, adaptation, adapted]
  );
  const currentRecipeKey = adaptation.ok ? adaptation.recipe.recipe_key : null;
  const currentSessionIdentity = session ? phase4SessionIdentity(session.metadata()) : null;
  // Latest identity/open state for async callbacks (never a render-scope stale).
  identityRef.current = { recipeKey: currentRecipeKey, sessionIdentity: currentSessionIdentity };
  isOpenRef.current = isOpen;

  /**
   * RECIPE-IDENTITY RESET. When the working recipe changes, every transient
   * AI/Generate intent is cleared and the AI generation is invalidated so a
   * response created for Recipe A can never land in Recipe B. Saved Advanced
   * Nutrition and hydration state for the NEW recipe are untouched.
   */
  useEffect(() => {
    aiGeneration.current += 1;
    aiRequestSeq.current += 1;
    aiRunningRef.current = false;
    pendingOpenRecipeKey.current = null;
    setPendingGenerateRecipeKey(null);
    setAiSuggestions({});
    setAiAmountOffers({});
    setAiMessage(null);
    setAiRunning(false);
    setIsOpen(false);
    setIsSavedReportOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRecipeKey]);

  /**
   * SESSION-AUTHORITY RESET. A different pinned session (bundle authority)
   * invalidates in-flight AI responses too, but must NOT cancel a recipe-bound
   * Generate intent that is waiting for the SAME recipe's lazy load to finish.
   */
  useEffect(() => {
    aiGeneration.current += 1;
    aiRequestSeq.current += 1;
    aiRunningRef.current = false;
    setAiSuggestions({});
    setAiAmountOffers({});
    setAiMessage(null);
    setAiRunning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionIdentity]);

  // When a user-initiated load succeeds, focus the (now-rendered) opener and
  // open the review UI exactly once — ONLY when the SAME recipe that requested
  // the load is still current (a mid-load recipe switch cancels the intent).
  useEffect(() => {
    if (!session) return;
    const captured = pendingOpenRecipeKey.current;
    if (captured === null) return;
    pendingOpenRecipeKey.current = null;
    if (!adaptation.ok || adaptation.recipe.recipe_key !== captured) return;
    openerRef.current?.focus();
    setIsOpen(true);
  }, [session, adaptation]);

  /** Opens the WORKING analyzer/editor, initializing the USDA bundle if needed. */
  const openWorkingEditor = () => {
    if (session) {
      setIsOpen(true);
      return;
    }
    if (onLoadBundle) {
      pendingOpenRecipeKey.current = currentRecipeKey;
      onLoadBundle();
    }
  };

  /**
   * The single opener contract. A saved Advanced block means the SAVED REPORT
   * opens immediately (no USDA authentication); only the explicit
   * Edit / Re-analyze action initializes the working analyzer.
   */
  const handleOpenRequest = () => {
    if (savedBlock) {
      setIsSavedReportOpen(true);
      return;
    }
    openWorkingEditor();
  };

  useEffect(() => {
    if (!session || !adaptation.ok) {
      dispatch({ type: 'reset' });
      return;
    }
    if (adapted.length === 0) return;
    if (state.recipeKey !== adaptation.recipe.recipe_key) {
      setWorkingTouched(false);
      setHydratedFromSaved(false);
    }
    dispatch({
      type: 'initialize',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows,
      baseServings: adaptation.recipe.base_servings,
    });
  }, [session, adaptation, adapted.length, rows]);

  // HYDRATE the working review from the saved result when the recipe is
  // unchanged. Every choice is rebuilt through the genuine session, so hydrated
  // evidence is never trusted merely because it was persisted.
  useEffect(() => {
    if (!session || !adaptation.ok || !savedBlock) return;
    if (state.recipeKey !== adaptation.recipe.recipe_key) return;
    if (state.rows.length === 0) return;
    const key = `${phase4SessionIdentity(session.metadata())}|${savedBlock.ingredient_digest}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    let hydrated: ReturnType<typeof hydrateWorkingReview>;
    try {
      hydrated = hydrateWorkingReview({
        session,
        adapted,
        rows: state.rows,
        savedBlock,
      });
    } catch {
      return;
    }
    if (!hydrated) return;
    dispatch({
      type: 'hydrate',
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      householdPortions: hydrated.householdPortions,
    });
    setHydratedFromSaved(true);
    setWorkingTouched(false);
  }, [session, adaptation, adapted, savedBlock, state.recipeKey, state.rows]);

  /** Dispatch wrapper that records a genuine user edit as dirty. */
  const workingDispatch: React.Dispatch<Phase4Action> = useCallback((action: Phase4Action) => {
    if (
      action.type !== 'hydrate' &&
      action.type !== 'initialize' &&
      action.type !== 'reset' &&
      action.type !== 'preview_succeeded'
    ) {
      setWorkingTouched(true);
    }
    dispatch(action);
  }, []);

  const stored = useMemo(() => readStoredBlock(recipe), [recipe]);
  const preview = state.preview;
  const display = useMemo(
    () =>
      preview
        ? deriveDisplayNutrients(preview, state.basis, state.baseServings, state.selectedServings)
        : null,
    [preview, state.basis, state.baseServings, state.selectedServings]
  );
  const coverage = useMemo(() => (preview ? coverageSummary(preview) : null), [preview]);
  const evidence = useMemo(
    () => (state.preview ? ingredientEvidenceViews(state.preview) : null),
    [state.preview]
  );

  // Deterministic live-vs-saved equality using the canonical ingredient digest
  // (never a formatted-string comparison). When the current live review result
  // is byte-for-byte the result that is already saved, there is no unsaved
  // divergence and the "UNSAVED REVIEW — NOT APPLIED" panel must not be shown.
  const liveMatchesSaved = useMemo(
    () =>
      preview !== null &&
      (stored.kind === 'v1' || stored.kind === 'v2') &&
      typeof stored.ingredientDigest === 'string' &&
      stored.ingredientDigest === preview.ingredient_digest,
    [preview, stored.kind, stored.ingredientDigest]
  );

  // DETERMINISTIC dirty state. A hydrated working review is clean; it becomes an
  // unsaved working change after a genuine user edit (or when a preview diverges
  // from the saved ingredient digest). Never a formatted-string comparison.
  const workingDirty =
    workingTouched || state.status === 'preview_stale' || (preview !== null && !liveMatchesSaved);

  // After a successful Apply the parent updates the recipe, so the live preview
  // matches the saved digest: the working review rebases cleanly.
  useEffect(() => {
    if (liveMatchesSaved) setWorkingTouched(false);
  }, [liveMatchesSaved]);

  // Phase 5A: report whether the current reviewed result is currently eligible
  // for an explicit Apply. This NEVER writes anything. An opaque/malformed
  // existing block is never eligible (Apply must not replace it).
  const applyEligibility = useMemo(() => {
    if (!session || !adaptation.ok || state.status !== 'preview_current' || state.preview === null) {
      return null;
    }
    if (stored.kind === 'opaque') return false;
    return authorizeNutritionPersistence({ session, recipe, state }).ok;
  }, [session, recipe, adaptation, state, stored.kind]);

  const applyMode: 'create' | 'replace' | null =
    stored.kind === 'v1' || stored.kind === 'v2' ? 'replace' : stored.kind === 'none' ? 'create' : null;

  const handleRequestApply = () => {
    if (!onApplyAdvancedNutrition || applyEligibility !== true || applyMode === null) return;
    if (applyState.kind === 'applying' || applyState.kind === 'confirming') return;
    setApplyState({ kind: 'confirming', mode: applyMode });
  };

  const handleConfirmApply = async () => {
    if (!onApplyAdvancedNutrition || !session || !adaptation.ok) return;
    if (applyState.kind !== 'confirming') return;
    const expectedMode = applyState.mode;
    setApplyState({ kind: 'applying' });
    try {
      const result = await onApplyAdvancedNutrition({ session, recipe, state, expectedMode });
      setApplyState(
        result.ok
          ? { kind: 'success', message: result.message }
          : { kind: 'error', message: result.message }
      );
    } catch {
      setApplyState({ kind: 'error', message: 'Advanced Nutrition could not be applied.' });
    }
  };

  const handleCancelApply = () => {
    setApplyState((current) => (current.kind === 'confirming' ? { kind: 'idle' } : current));
  };

  const applyUi: AdvancedNutritionApplyUi | undefined = onApplyAdvancedNutrition
    ? {
        eligible: applyEligibility,
        mode: applyMode,
        status: applyState.kind,
        message: applyState.kind === 'success' || applyState.kind === 'error' ? applyState.message : null,
        onRequest: handleRequestApply,
        onConfirm: handleConfirmApply,
        onCancel: handleCancelApply,
      }
    : undefined;

  const handleCalculate = () => {
    if (!session || !adaptation.ok) return;
    setCalculating(true);
    const seq = state.operationSeq;
    const key = state.recipeKey ?? '';
    const request = buildCalculationRequest(adapted, state);
    const result = session.calculate(request);
    setCalculating(false);
    if (result.ok) {
      dispatch({ type: 'preview_succeeded', seq, recipeKey: key, preview: result.preview });
    } else {
      dispatch({ type: 'preview_failed', seq, failure: phase4Failure('validation_error') });
    }
  };

  // Deterministic automatic analysis. Pure/offline; it never persists and never
  // mutates the recipe. Recomputed whenever the adaptation or session changes.
  const analysis = useMemo<RecipeAnalysis | null>(
    () =>
      session && adaptation.ok
        ? analyzeRecipe(session, adapted, adaptation.recipe.base_servings)
        : null,
    [session, adaptation, adapted]
  );

  // The ONE central projection of every row's CURRENT effective state, shared
  // with the modal and used for AI eligibility. It never reads the analyzer
  // snapshot status directly.
  const analyzedByRef = useMemo(() => {
    const map = new Map<string, AnalyzedRow>();
    if (analysis) for (const row of analysis.rows) map.set(row.line_ref, row);
    return map;
  }, [analysis]);
  const liveRows = useMemo(
    () =>
      session && adaptation.ok
        ? projectLiveRows(
            state,
            analyzedByRef,
            adapted,
            session,
            evidence,
            analysis?.portions,
            analysis?.countPortions
          )
        : Object.freeze([] as LiveRowState[]),
    [session, adaptation, state, analyzedByRef, adapted, evidence, analysis]
  );
  liveRowsRef.current = liveRows;
  /** The actionable exception rows derived from the SAME live projection. */
  const actionableRows = useMemo(
    () =>
      session && adaptation.ok
        ? actionableExceptionRows(state.rows, liveRows)
        : Object.freeze([] as Phase4Row[]),
    [session, adaptation, state.rows, liveRows]
  );
  const actionableByRef = useMemo(() => {
    const map = new Map<string, AiResolutionIssueKind>();
    for (const live of liveRows) {
      const kind = liveExceptionKind(live.status);
      if (kind !== undefined) map.set(live.line_ref, kind);
    }
    return map;
  }, [liveRows]);

  const handleAnalyze = () => {
    if (!session || !adaptation.ok) return;
    // Always execute a fresh analysis on click. Fall back to an on-demand
    // computation if the memoized analysis is unavailable, so the control can
    // never become a dead button after a saved-state reopen.
    const current =
      analysis ?? analyzeRecipe(session, adapted, adaptation.recipe.base_servings);
    if (!current) return;

    // REVIEWED-DECISION PRESERVATION. Re-analysis is a gap-filling pass, never a
    // destructive reset: every explicit user choice (a manual/USDA-search
    // selection, a hydrated reviewed decision, or a mass the user entered) is
    // preserved for its line, and the analyzer only supplies the lines the user
    // has not already decided. Without this, reopening and clicking Re-analyze
    // discarded a user's manually selected foods and weights, reverting rows to
    // NEEDS MATCH / NEEDS AMOUNT.
    const matches: Record<string, MatchChoice> = { ...current.matches };
    const portions: Record<string, PortionChoice> = { ...current.portions };
    const countPortions: Record<string, CountPortionChoice> = { ...current.countPortions };
    const userMasses: Record<string, UserMassChoice> = { ...state.userMasses };
    // Phase 6: the analyzer's verified household fallbacks. A line the user has
    // explicitly decided keeps its higher-authority choice (the household entry
    // is removed below), so a household portion can never override a stored
    // user/USDA source.
    const householdPortions: Record<string, HouseholdPortionChoice> = {
      ...(current.householdPortions ?? {}),
    };
    for (const row of state.rows) {
      const choice = state.matches[row.line_ref];
      if (!choice) continue;
      // An AI-assisted AUTOMATIC acceptance is NOT a reviewed decision; only an
      // explicit manual/user choice (no aiAccepted marker) is preserved.
      const userDecision =
        choice.aiAccepted !== true && (choice.kind === 'manual' || choice.automatic !== true);
      if (!userDecision) continue;
      matches[row.line_ref] = choice;
      const userMass = state.userMasses[row.line_ref];
      const portion = state.portions[row.line_ref];
      const countPortion = state.countPortions[row.line_ref];
      if (userMass) {
        userMasses[row.line_ref] = userMass;
        delete portions[row.line_ref];
        delete countPortions[row.line_ref];
        delete householdPortions[row.line_ref];
      } else if (portion) {
        portions[row.line_ref] = portion;
        delete userMasses[row.line_ref];
        delete countPortions[row.line_ref];
        delete householdPortions[row.line_ref];
      } else if (countPortion) {
        countPortions[row.line_ref] = countPortion;
        delete userMasses[row.line_ref];
        delete portions[row.line_ref];
        delete householdPortions[row.line_ref];
      }
    }

    // Recompute the advisory preview from the MERGED state so the preview the
    // user sees reflects the preserved reviewed decisions, not just the
    // analyzer's automatic picks.
    const mergedState = {
      ...state,
      matches,
      portions,
      countPortions,
      userMasses,
      householdPortions,
    } as Phase4State;
    let preview = current.preview;
    const calculated = session.calculate(buildCalculationRequest(adapted, mergedState));
    if (calculated.ok) preview = calculated.preview;

    dispatch({
      type: 'apply_analysis',
      matches,
      portions,
      countPortions,
      householdPortions,
      userMasses,
      preview,
    });
    // Visible transition/feedback: the analyzer run is observable even when the
    // deterministic result is identical to a previous run.
    setAnalysisRuns((runs) => runs + 1);
    // AI suggestions/messages/amount offers are EPHEMERAL advisory working
    // state: a fresh deterministic Re-analyze invalidates them (they are never
    // reviewed decisions and must not linger against a new review identity).
    setAiSuggestions({});
    setAiAmountOffers({});
    setAiMessage(null);
  };

  const compact = display
    ? (['calories', 'protein', 'carbohydrates', 'fat'] as const).map((id) => {
        const row = display.find((entry) => entry.nutrient === id);
        return row;
      })
    : null;

  /**
   * GENERATE NUTRITION — the single recipe-facing entry and an EXPLICIT user
   * action that authorizes the deterministic analysis. It loads the USDA
   * analyzer lazily (viewing a recipe still never loads it), opens the working
   * review, and immediately runs the EXISTING deterministic analyzer. AI is NOT
   * called here: it remains an optional secondary action for rows the
   * deterministic pass cannot resolve. Nothing is written until Apply.
   */
  const handleGenerate = () => {
    if (savedBlock) {
      setIsSavedReportOpen(true);
      return;
    }
    // Bind the intent to the recipe CURRENT at click time; it is consumed only if
    // that same recipe is still current once the editor is ready.
    setPendingGenerateRecipeKey(currentRecipeKey);
    openWorkingEditor();
  };

  // ONE-CLICK GENERATE: run the deterministic analyzer exactly once, once the
  // working editor is READY for the SAME recipe that requested Generate. Waiting
  // for `state.recipeKey` to match guarantees the analyzer runs against the
  // initialized rows (never a stale pre-initialize snapshot), and the recipe-key
  // binding means a mid-load recipe switch cancels the intent.
  useEffect(() => {
    if (pendingGenerateRecipeKey === null) return;
    if (!session || !adaptation.ok) return;
    if (pendingGenerateRecipeKey !== adaptation.recipe.recipe_key) {
      setPendingGenerateRecipeKey(null);
      return;
    }
    if (state.recipeKey !== adaptation.recipe.recipe_key) return;
    setPendingGenerateRecipeKey(null);
    handleAnalyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGenerateRecipeKey, state.recipeKey, session, adaptation]);

  /**
   * The authoritative result of one working-state application. `state` is the
   * EXACT post-operation phase state the reducer will hold (same matches /
   * portions / countPortions / userMasses / preview), so callers derive the real
   * live rows and result counts from it — never from a proposal or a successful
   * function return. `ok: false` means NOTHING was applied and no count may
   * claim otherwise.
   */
  interface WorkingApplyResult {
    readonly ok: boolean;
    readonly state?: Phase4State;
    readonly preview?: NonNullable<Phase4State['preview']>;
  }

  /**
   * Applies working selection maps and deterministically RECOMPUTES the advisory
   * preview from the merged state in one step. Nothing is persisted; Apply stays
   * the only persistence boundary. Returns the authoritative applied state so
   * every caller reports what ACTUALLY changed.
   */
  const applyWorkingSelections = useCallback(
    (next: {
      readonly matches?: Readonly<Record<string, MatchChoice>>;
      readonly portions?: Readonly<Record<string, PortionChoice>>;
      readonly countPortions?: Readonly<Record<string, CountPortionChoice>>;
      readonly userMasses?: Readonly<Record<string, UserMassChoice>>;
      readonly householdPortions?: Readonly<Record<string, HouseholdPortionChoice>>;
      readonly fallback?: { readonly type: 'select_match' | 'select_count_portion'; readonly lineRef: string; readonly choice: unknown };
    }): WorkingApplyResult => {
      if (!session || !adaptation.ok) return { ok: false };
      const base = stateRef.current;
      // The reducer refuses `apply_analysis` before initialization; the caller
      // must therefore never be told an application succeeded.
      if (base.recipeKey === null) return { ok: false };
      // MASS-SOURCE EXCLUSIVITY: a verified household portion is the LOWEST
      // authority, so adding any stored higher-authority source (a changed food
      // selection, a USDA source/count portion, or a user-entered weight) for a
      // line removes that line's household choice, exactly as the reducer does.
      // This keeps every merged state conflict-free by construction (conflicts
      // remain a fail-closed backstop for forged/legacy states).
      const mergedHousehold: Record<string, HouseholdPortionChoice> = {
        ...(next.householdPortions ?? base.householdPortions ?? {}),
      };
      for (const lineRef of Object.keys(mergedHousehold)) {
        const hasHigherSource =
          next.matches?.[lineRef] !== undefined ||
          next.portions?.[lineRef] !== undefined ||
          next.countPortions?.[lineRef] !== undefined ||
          next.userMasses?.[lineRef] !== undefined;
        if (hasHigherSource) delete mergedHousehold[lineRef];
      }
      const merged = {
        ...base,
        matches: next.matches ?? base.matches,
        portions: next.portions ?? base.portions,
        countPortions: next.countPortions ?? base.countPortions,
        userMasses: next.userMasses ?? base.userMasses,
        householdPortions: mergedHousehold,
      } as Phase4State;
      const calculated = session.calculate(buildCalculationRequest(adapted, merged));
      if (calculated.ok) {
        setWorkingTouched(true);
        dispatch({
          type: 'apply_analysis',
          matches: merged.matches,
          portions: merged.portions,
          countPortions: merged.countPortions,
          householdPortions: merged.householdPortions,
          userMasses: merged.userMasses,
          preview: calculated.preview,
        });
        return {
          ok: true,
          state: {
            ...merged,
            status: 'preview_current',
            preview: calculated.preview,
            previewKey: merged.recipeKey,
            failure: null,
            operationSeq: base.operationSeq + 1,
          } as Phase4State,
          preview: calculated.preview,
        };
      }
      if (next.fallback) {
        // An explicit user action may still bind its single choice even when a
        // full preview is not computable; the caller is told the application was
        // NOT authoritative so it can never report a resolution.
        setWorkingTouched(true);
        dispatch(
          next.fallback.type === 'select_match'
            ? { type: 'select_match', lineRef: next.fallback.lineRef, choice: next.fallback.choice as MatchChoice }
            : {
                type: 'select_count_portion',
                lineRef: next.fallback.lineRef,
                choice: next.fallback.choice as CountPortionChoice,
              }
        );
      }
      return { ok: false };
    },
    [session, adaptation, adapted]
  );

  /**
   * AI-ASSISTED EXCEPTION RESOLUTION (optional, explicit, SECONDARY). Sends ONLY
   * the current actionable exception rows (needs_match / review_suggested /
   * needs_amount) to the server resolver, then routes every suggestion back
   * through local deterministic verification:
   *   - food identity -> pinned catalog + confidence matcher;
   *   - amount/count  -> authenticated USDA count portions + the calculator.
   * Auto-verifiable outcomes are applied; everything else is offered for user
   * review. The AI never grants authority and never writes.
   */
  const handleResolveWithAi = useCallback(
    async (lineRefs?: ReadonlyArray<string>) => {
      if (!session || !adaptation.ok) return;
      if (!onResolveWithAi) {
        setAiMessage('AI assistance is unavailable. You can continue with USDA search manually.');
        return;
      }
      // UNIFIED ACTIONABLE-EXCEPTION ELIGIBILITY: the SAME live projection that
      // renders the ingredient list decides what AI may help with. NEEDS MATCH is
      // NOT required.
      const eligible = actionableExceptionRows(stateRef.current.rows, liveRowsRef.current);
      const targets =
        lineRefs && lineRefs.length > 0
          ? eligible.filter((row) => lineRefs.includes(row.line_ref))
          : eligible;
      if (targets.length === 0) {
        setAiMessage('No remaining ingredients need AI assistance.');
        return;
      }
      const issueKinds: Record<string, AiResolutionIssueKind> = {};
      for (const live of liveRowsRef.current) {
        const kind = liveExceptionKind(live.status);
        if (kind !== undefined) issueKinds[live.line_ref] = kind;
      }
      // SYNCHRONOUS RE-ENTRY GUARD: a rapid double-click must create exactly ONE
      // request (the server rate limiter is only a backstop).
      if (aiRunningRef.current) return;
      aiRunningRef.current = true;
      // MID-FLIGHT USER-AUTHORITY SNAPSHOT. For every targeted row, capture the
      // semantic working choice at the instant the request starts. At apply time
      // any row whose choice changed in the meantime is SKIPPED: the user's newer
      // explicit decision is final authority and a stale AI result must never
      // overwrite it. Untouched rows still receive their AI result.
      const capturedWorkingChoices = new Map<string, string>();
      for (const row of targets) {
        capturedWorkingChoices.set(row.line_ref, workingChoiceFingerprint(stateRef.current, row.line_ref));
      }
      // RECIPE-BOUND REQUEST TOKEN. Captured at request creation; the response is
      // accepted only while the SAME recipe + session authority are current, the
      // AI lifecycle generation is unchanged, and the editor is still open.
      const capturedRecipeKey = identityRef.current.recipeKey;
      const capturedSessionIdentity = identityRef.current.sessionIdentity;
      const capturedGeneration = aiGeneration.current;
      const seq = aiRequestSeq.current + 1;
      aiRequestSeq.current = seq;
      setAiRunning(true);
      setAiMessage(null);
      const stillCurrent = (): boolean => {
        if (aiRequestSeq.current !== seq) return false;
        if (aiGeneration.current !== capturedGeneration) return false;
        const current = identityRef.current;
        if (current.recipeKey !== capturedRecipeKey) return false;
        if (current.sessionIdentity !== capturedSessionIdentity) return false;
        // A closed editor must never later receive AI state.
        return isOpenRef.current === true;
      };
      try {
        const result = await onResolveWithAi({
          session,
          rows: targets,
          adapted,
          issueKinds,
          liveRows: liveRowsRef.current,
          state: stateRef.current,
        });
        // STALE-RESPONSE PROTECTION: a response for a different recipe/session,
        // an older generation, a superseded request, or a closed editor is
        // discarded BEFORE any dispatch/UI mutation.
        if (!stillCurrent()) return;
        if (!result.ok) {
          setAiMessage(
            result.message ?? 'AI assistance is unavailable. You can continue with USDA search manually.'
          );
          return;
        }

        // LOCAL VERIFICATION OUTCOMES ONLY: merge the accepted deterministic
        // results into fresh maps and apply them through the ONE authoritative
        // working-state helper (the SAME path row-level actions use).
        const base = stateRef.current;
        // AUTHORITATIVE BEFORE SNAPSHOT: taken at APPLY time (immediately before
        // the state mutation), so a row resolved by an unrelated edit during the
        // request flight can never be attributed to the AI pass.
        const beforeApplyRefs = new Set(
          liveRowsRef.current
            .filter((row) => liveExceptionKind(row.status) !== undefined)
            .map((row) => row.line_ref)
        );
        // PER-LINE MID-FLIGHT CONFLICT DETECTION: a targeted row whose working
        // choice changed since the request began belongs to the USER now. Its AI
        // result is discarded (per line, without aborting the rest) so the newer
        // explicit decision is preserved exactly and is never credited to AI.
        const conflictedRefs = new Set<string>();
        for (const [lineRef, captured] of capturedWorkingChoices) {
          if (workingChoiceFingerprint(base, lineRef) !== captured) conflictedRefs.add(lineRef);
        }
        const matches: Record<string, MatchChoice> = { ...base.matches };
        const countPortions: Record<string, CountPortionChoice> = { ...base.countPortions };
        const suggestions: Record<string, AdvancedNutritionAiSuggestion> = {};
        const amountOffers: Record<string, ReadonlyArray<AdvancedNutritionAiAmountOffer>> = {};

        for (const candidate of result.outcome.candidates) {
          if (conflictedRefs.has(candidate.line_ref)) continue;
          if (candidate.auto) {
            // AI-assisted DETERMINISTIC acceptance: automatic authority, never
            // user-confirmed (the choice carries aiAssisted + aiAccepted).
            matches[candidate.line_ref] = Object.freeze({ ...candidate.choice });
          } else {
            suggestions[candidate.line_ref] = Object.freeze({
              line_ref: candidate.line_ref,
              fdc_id: candidate.fdc_id,
              description: candidate.description,
              auto: false,
              choice: candidate.choice,
            });
          }
        }
        for (const amount of result.amounts.resolved) {
          if (conflictedRefs.has(amount.line_ref)) continue;
          // AI-assisted deterministic COUNT resolution through an authenticated
          // USDA portion. Display marker only; not user-confirmed.
          countPortions[amount.line_ref] = Object.freeze({ ...amount.choice });
        }
        for (const offer of result.amounts.offers) {
          if (conflictedRefs.has(offer.line_ref)) continue;
          // Materially different authenticated weights: the user chooses.
          const list = amountOffers[offer.line_ref] ?? [];
          amountOffers[offer.line_ref] = Object.freeze([
            ...list,
            Object.freeze({
              line_ref: offer.line_ref,
              fdc_id: offer.fdc_id,
              portion_index: offer.portion_index,
              display_label: offer.display_label,
              resolved_grams: offer.resolved_grams,
              hint: Object.freeze({ unit: offer.hint.unit, size: offer.hint.size }),
            }),
          ]);
        }

        setAiSuggestions(suggestions);
        setAiAmountOffers(amountOffers);
        const applied = applyWorkingSelections({ matches, countPortions });

        const interpretedCount =
          typeof result.interpretedCount === 'number' && Number.isFinite(result.interpretedCount)
            ? result.interpretedCount
            : interpretedSuggestionCount(result);

        if (!applied.ok || applied.state === undefined) {
          // The merged resolutions could NOT be authenticated against the live
          // state, so NOTHING was applied. Never claim success that did not
          // happen.
          setAiMessage(
            `AI interpreted ${interpretedCount} ingredient${interpretedCount === 1 ? '' : 's'}, ` +
              'but the authenticated USDA resolutions could not be applied to the review. ' +
              'No row was changed — continue with USDA search or enter a weight.'
          );
          return;
        }

        // TRUTH COMES FROM THE POST-OPERATION LIVE ROWS. Project the authoritative
        // live rows from the SAME state that was just applied, and count a row as
        // resolved automatically ONLY when it genuinely transitioned from an
        // actionable status to `matched`. A food suggestion with no mass, or a
        // candidate that remains review-suggested, counts ZERO.
        const afterLiveRows = projectLiveRows(
          applied.state,
          analyzedByRef,
          adapted,
          session,
          applied.preview ? ingredientEvidenceViews(applied.preview) : null,
          analysis?.portions,
          analysis?.countPortions
        );
        const targetedRefs = new Set(targets.map((row) => row.line_ref));
        let resolvedAutomatically = 0;
        for (const live of afterLiveRows) {
          if (
            targetedRefs.has(live.line_ref) &&
            beforeApplyRefs.has(live.line_ref) &&
            !conflictedRefs.has(live.line_ref) &&
            live.status === 'matched'
          ) {
            resolvedAutomatically += 1;
          }
        }
        const stillNeedReview = summarizeLiveRows(afterLiveRows).actionable;

        if (resolvedAutomatically === 0) {
          setAiMessage(
            `AI interpreted ${interpretedCount} ingredient${interpretedCount === 1 ? '' : 's'}. ` +
              'No additional ingredients could be resolved automatically. ' +
              `${stillNeedReview} still need${stillNeedReview === 1 ? 's' : ''} review.`
          );
        } else {
          setAiMessage(
            `AI interpreted ${interpretedCount} ingredient${interpretedCount === 1 ? '' : 's'}. ` +
              `${resolvedAutomatically} resolved automatically with USDA data. ` +
              `${stillNeedReview} still need${stillNeedReview === 1 ? 's' : ''} review.`
          );
        }
      } catch {
        if (stillCurrent()) {
          setAiMessage('AI assistance is unavailable. You can continue with USDA search manually.');
        }
      } finally {
        if (aiRequestSeq.current === seq) {
          aiRunningRef.current = false;
          setAiRunning(false);
        }
      }
    },
    [session, adaptation, onResolveWithAi, adapted, applyWorkingSelections, analyzedByRef, analysis]
  );

  const handleUseAiSuggestion = (lineRef: string) => {
    const suggestion = aiSuggestions[lineRef];
    if (!suggestion) return;
    // EXPLICIT USER CONFIRMATION: clicking "Use this match" is a user decision.
    // The offered (below-threshold) candidate becomes a genuine user-confirmed
    // manual choice: every automatic-authority marker is stripped, so the
    // deterministic calculator reports `user_confirmed` (never `auto_confirmed`)
    // while the display-only AI provenance is retained.
    const confirmedChoice = userConfirmedChoiceFromAiSuggestion(suggestion.choice);
    setAiSuggestions((prev) => {
      const next = { ...prev };
      delete next[lineRef];
      return next;
    });
    applyWorkingSelections({
      matches: { ...stateRef.current.matches, [lineRef]: confirmedChoice },
      fallback: { type: 'select_match', lineRef, choice: confirmedChoice },
    });
  };

  const handleUseAiAmountOffer = (lineRef: string, portionIndex: number) => {
    if (!session || !adaptation.ok) return;
    const offers = aiAmountOffers[lineRef];
    const offer = offers?.find((entry) => entry.portion_index === portionIndex);
    if (!offer) return;
    const base = stateRef.current;
    const row = base.rows.find((entry) => entry.line_ref === lineRef);
    const entry = adapted.find((item) => item.line_ref === lineRef);
    if (!row || !entry) return;
    const choice = buildUserChoiceFromAiAmountOffer({
      session,
      offer,
      row,
      entry,
      matchChoice: base.matches[lineRef],
    });
    if (!choice) {
      setAiMessage('That authenticated USDA portion could not be applied. Choose another or enter a weight.');
      return;
    }
    setAiAmountOffers((prev) => {
      const next = { ...prev };
      delete next[lineRef];
      return next;
    });
    applyWorkingSelections({
      countPortions: { ...base.countPortions, [lineRef]: choice },
      fallback: { type: 'select_count_portion', lineRef, choice },
    });
  };

  const aiUi: AdvancedNutritionAiUi | undefined =
    session && adaptation.ok && onResolveWithAi
      ? {
          available: true,
          running: aiRunning,
          message: aiMessage,
          suggestions: aiSuggestions,
          amountOffers: aiAmountOffers,
          exceptionCount: actionableRows.length,
          onResolve: (lineRef?: string) => {
            void handleResolveWithAi(lineRef ? [lineRef] : undefined);
          },
          onUseSuggestion: handleUseAiSuggestion,
          onUseAmountOffer: handleUseAiAmountOffer,
          onDismissMessage: () => setAiMessage(null),
        }
      : undefined;

  return (
    <div
      id="advanced-nutrition-card"
      className="bg-[#141414] rounded-2xl border border-indigo-500/20 p-5 shadow-xs text-gray-200"
    >
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 flex items-center justify-center">
            <FlaskConical className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-serif font-bold text-white flex items-center gap-1.5">
              <span>Advanced Nutrition</span>
              <span className="text-[10px] font-mono text-indigo-300 font-normal uppercase">Advisory</span>
            </h3>
            <p className="text-[10px] text-gray-500">
              Reviewed USDA source matching · authenticated saved result
            </p>
          </div>
        </div>
      </div>

      {!session && !onLoadBundle && (
        <div className="p-3 rounded-xl bg-[#0E0E0E] border border-dashed border-white/10 space-y-2">
          {savedBlock ? (
            <p className="text-[11px] text-gray-400" data-testid="advanced-saved-readonly-note">
              Saved Advanced Nutrition is available to view. Editing requires the USDA review tools,
              which are unavailable in this build.
            </p>
          ) : (
            <p className="text-xs text-gray-300">{PHASE4_UNAVAILABLE_MESSAGE}</p>
          )}
          <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            <span>This is not an error in the recipe.</span>
          </p>
          <button
            type="button"
            data-testid="advanced-nutrition-open"
            onClick={handleOpenRequest}
            disabled={!savedBlock}
            aria-disabled={!savedBlock}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              savedBlock
                ? 'text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border-indigo-500/30'
                : 'text-gray-500 bg-white/5 border-white/10 cursor-not-allowed'
            }`}
          >
            <FlaskConical className="w-3.5 h-3.5" />
            <span>{savedBlock ? 'Open Saved Advanced Report' : 'Generate Nutrition'}</span>
          </button>
        </div>
      )}

      {!session && onLoadBundle && (
        <div className="p-3 rounded-xl bg-[#0E0E0E] border border-dashed border-white/10 space-y-2">
          {bundleStatus === 'loading' ||
          bundleStatus === 'failed' ||
          bundleStatus === 'unsupported' ||
          (stored.kind !== 'v1' && stored.kind !== 'v2') ? (
            <p className="text-xs text-gray-300" role="status" aria-live="polite">
              {bundleStatus === 'loading'
                ? PHASE4_LOADING_MESSAGE
                : bundleStatus === 'failed'
                  ? PHASE4_BUNDLE_FAILED_MESSAGE
                  : bundleStatus === 'unsupported'
                    ? PHASE4_UNSUPPORTED_MESSAGE
                    : PHASE4_IDLE_MESSAGE}
            </p>
          ) : stored.status === 'complete' && stored.unresolvedCount === 0 ? (
            <div data-testid="advanced-saved-complete" role="status" aria-live="polite" className="space-y-0.5">
              <p className="text-xs font-semibold text-emerald-300">Advanced Nutrition saved</p>
              <p className="text-[11px] text-gray-400">
                USDA reviewed · Complete coverage
                {stored.servings ? ` · base ${stored.servings} servings` : ''}
              </p>
            </div>
          ) : (
            <div data-testid="advanced-saved-partial" role="status" aria-live="polite" className="space-y-0.5">
              <p className="text-xs font-semibold text-amber-300">Advanced Nutrition saved — partial</p>
              <p className="text-[11px] text-gray-400">
                {stored.resolvedCount} of {stored.resolvedCount + stored.unresolvedCount} ingredient line
                {stored.resolvedCount + stored.unresolvedCount === 1 ? '' : 's'} resolved
                {stored.servings ? ` · base ${stored.servings} servings` : ''}. Open Advanced Nutrition to
                finish review.
              </p>
            </div>
          )}
          <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            <span>This is not an error in the recipe.</span>
          </p>
          {bundleStatus === 'loading' ? (
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 bg-white/5 border border-white/10 cursor-wait"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Authenticating…</span>
            </button>
          ) : bundleStatus === 'failed' ? (
            <button
              type="button"
              onClick={handleOpenRequest}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{PHASE4_BUNDLE_RETRY_LABEL}</span>
            </button>
          ) : bundleStatus === 'unsupported' ? null : (
            <button
              type="button"
              data-testid="advanced-nutrition-open"
              onClick={savedBlock ? handleOpenRequest : handleGenerate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 transition-colors"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>{savedBlock ? 'Open Saved Advanced Report' : 'Generate Nutrition'}</span>
            </button>
          )}
        </div>
      )}

      {session && !adaptation.ok && (
        <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-amber-200 text-xs flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{PHASE4_UNREADABLE_MESSAGE}</span>
        </div>
      )}

      {session && adaptation.ok && (
        <div className="space-y-3">
          {(stored.kind === 'v1' || stored.kind === 'v2') && (
            <div className="p-3 rounded-xl bg-[#0E0E0E] border border-white/5">
              {stored.status === 'complete' && stored.unresolvedCount === 0 ? (
                <div data-testid="advanced-saved-complete" className="space-y-0.5">
                  <p className="text-[11px] font-semibold text-emerald-300">Advanced Nutrition saved</p>
                  <p className="text-[10px] text-gray-400">
                    USDA reviewed · Complete coverage
                    {stored.servings ? ` · base ${stored.servings} servings` : ''}
                  </p>
                </div>
              ) : (
                <div data-testid="advanced-saved-partial" className="space-y-0.5">
                  <p className="text-[11px] font-semibold text-amber-300">
                    Advanced Nutrition saved — partial
                  </p>
                  <p className="text-[10px] text-gray-400">
                    {stored.resolvedCount} of {stored.resolvedCount + stored.unresolvedCount} ingredient line
                    {stored.resolvedCount + stored.unresolvedCount === 1 ? '' : 's'} resolved
                    {stored.servings ? ` · base ${stored.servings} servings` : ''}. Open Advanced Nutrition to
                    finish review.
                  </p>
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs mt-1.5">
                {(stored.values ?? []).map((value) => (
                  <span key={value.label} className="text-gray-300">
                    {value.label}: <span className="font-mono text-white">{value.amount}</span> {value.unit}
                  </span>
                ))}
                {(stored.values ?? []).length === 0 && (
                  <span className="text-gray-500">No recognized nutrient amounts.</span>
                )}
              </div>
            </div>
          )}
          {stored.kind === 'opaque' && (
            <div className="p-3 rounded-xl bg-[#0E0E0E] border border-white/5">
              <p className="text-[11px] text-gray-400">
                This recipe carries an unrecognized advanced-nutrition format. It is preserved but not
                interpreted or displayed as trusted data.
              </p>
            </div>
          )}

          {preview && compact && !liveMatchesSaved && (
            <div className="p-3 rounded-xl bg-indigo-950/20 border border-indigo-500/20">
              <p className="text-[10px] font-mono uppercase text-indigo-300 mb-1">
                Unsaved review — not applied · {basisLabel(state.basis, state.selectedServings)}
                {state.status === 'preview_stale' ? ' · stale' : ''}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {compact.map((nutrient) =>
                  nutrient ? (
                    <span key={nutrient.nutrient} className="text-gray-300">
                      {nutrient.label}:{' '}
                      <span className="font-mono text-white">{formatAmount(nutrient.amount)}</span>{' '}
                      {nutrient.amount !== undefined ? nutrient.unit_label : ''}
                    </span>
                  ) : null
                )}
              </div>
              {coverage && (
                <p className="text-[10px] text-gray-400 mt-1">
                  Coverage {coverage.status} · {coverage.unresolved_count} unresolved line(s)
                </p>
              )}
              <p className="text-[10px] text-gray-500 mt-1">
                Review only — nothing is saved until you Apply.
              </p>
              {applyEligibility !== null && (
                <p
                  data-testid="advanced-nutrition-apply-eligibility"
                  className={`text-[10px] mt-1 ${applyEligibility ? 'text-emerald-300' : 'text-amber-300'}`}
                >
                  {applyEligibility
                    ? 'This reviewed result is eligible for a future Apply. Nothing is saved automatically.'
                    : 'This reviewed result is not eligible for Apply yet.'}
                </p>
              )}
            </div>
          )}

          {!preview && (
            <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-indigo-300" />
              <span>
                Review each ingredient's source match, then calculate an advisory preview. Nothing is
                calculated automatically.
              </span>
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-500 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              <span>Advisory · not saved · not medical advice</span>
            </span>
            <button
              type="button"
              ref={openerRef}
              data-testid="advanced-nutrition-open"
              onClick={savedBlock ? handleOpenRequest : handleGenerate}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 transition-colors"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>{savedBlock ? 'Open Saved Advanced Report' : 'Generate Nutrition'}</span>
            </button>
          </div>
        </div>
      )}

      {session && adaptation.ok && (
        <AdvancedNutritionModal
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          title={adaptation.recipe.title}
          session={session}
          adapted={adapted}
          state={state}
          dispatch={workingDispatch}
          onCalculate={handleCalculate}
          calculating={calculating}
          analysis={analysis}
          onAnalyze={handleAnalyze}
          analysisRuns={analysisRuns}
          apply={applyUi}
          workingDirty={workingDirty}
          hydratedFromSaved={hydratedFromSaved}
          ai={aiUi}
        />
      )}

      {savedBlock && (
        <AdvancedNutritionSavedReport
          isOpen={isSavedReportOpen}
          onClose={() => setIsSavedReportOpen(false)}
          title={adaptation.ok ? adaptation.recipe.title : ''}
          block={savedBlock}
          onEdit={() => {
            setIsSavedReportOpen(false);
            openWorkingEditor();
          }}
        />
      )}
    </div>
  );
};
