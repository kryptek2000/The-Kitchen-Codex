import { resolveRecipeNutritionPresentation } from '../core/nutritionV2/phase5c/presentation';
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
  analyzeRecipeFromRows,
  basisLabel,
  buildCalculationRequest,
  buildReviewRows,
  buildPortionChoice,
  coverageSummary,
  deriveDisplayNutrients,
  deriveEnergyDisplay,
  formatAmount,
  hydrateWorkingReview,
  phase4Failure,
  phase4Reducer,
  phase4SessionIdentity,
  readStoredBlock,
  summarizeStoredAdvanced,
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
import type { QuarantinedSupplement } from '../core/nutritionV2/supplementVerification';
import { previewNutritionApplyEligibility } from '../core/nutritionV2/phase5';
import {
  activeAiEstimatesForPreview,
} from '../core/nutritionV2/phase4/aiEstimateApplyGate';
import type { CodexNutritionV1, CodexNutritionV2, CodexNutritionV3, CodexNutritionV4, CodexNutritionV5, CodexNutritionV6 } from '../core/nutritionV2/schema';
import { buildShisoNutrientCoverage } from '../core/shiso/nutritionCoverage';
import { brandedReviewIdentity } from '../core/nutritionV2/brandedEvidenceTrust';
import {
  actionableExceptionRows,
  buildUserChoiceFromAiAmountOffer,
  ingredientEvidenceViews,
  ingredientMeasurement,
  liveExceptionKind,
  projectLiveRows,
  summarizeLiveRows,
  userConfirmedChoiceFromAiSuggestion,
  type AiAmountResolveOutcome,
  type AiHouseholdResolveOutcome,
  type AiResolutionIssueKind,
  type AiResolveOutcome,
  type CountPortionChoice,
  type HouseholdPortionChoice,
  type LiveRowState,
} from '../core/nutritionV2/phase4';
import {
  conflictedWorkingLineRefs,
  mergeAiHouseholdPortions,
  workingChoiceFingerprint,
} from '../core/nutritionV2/phase4/aiMidFlight';
import {
  AI_ESTIMATE_OFFER_LABEL,
  acceptAiEstimateOffer,
  buildAiEstimateUiSnapshot,
  type AiEstimateOffer,
} from '../core/nutritionV2/phase4/aiEstimateAccept';
import { aiEstimateSnapshotBinding } from '../core/nutritionV2/phase4/aiEstimateValidation';
import { combineAiContributionsWithPreview, type AiNutrientContribution } from '../core/nutritionV2/aiContribution';
import {
  brandedBrandAppearsInIngredient,
  buildBrandedContribution,
  type BrandedLookupTarget,
  type UsdaBrandedFoodCandidate,
} from '../core/nutritionV2/brandedFoods';
import { MAX_RESEARCH_TARGETS, type ResearchTarget } from '../core/nutritionV2/aiResearch';
import type { AiEstimateSelectionEvidence } from '../core/nutritionV2/phase4/aiEstimateSelection';
import { useShiso, type ShisoNutritionReviewApplyResult } from '../application-ui/shisoEntryPoints';
import type { ShisoAnalysisOutcome, ShisoNutritionCorrectionsOutcome } from '../core/shiso/protocol';
import type { ShisoNutritionSourceSelectionOutcome } from '../core/shiso/protocol';
import { selectionFromMatchChoice } from '../core/nutritionV2/phase4/rows';
import { buildSupportedNutritionCorrections } from '../core/shiso/nutritionCorrections';
import { deriveNutritionCoverage, nutritionCoverageSummary } from '../core/shiso/nutritionCoverage';
import {
  decideCorrectionDispatch,
  evaluateCorrectionTransition,
} from '../core/shiso/correctionTransition';
import {
  AdvancedNutritionModal,
  type AdvancedNutritionAiAmountOffer,
  type AdvancedNutritionApplyUi,
  type AdvancedNutritionAiUi,
  type AdvancedNutritionBrandedUi,
  type AdvancedNutritionAiReview,
  type AdvancedNutritionAiSuggestion,
  type AdvancedNutritionResearchOffer,
  type AdvancedNutritionRecipeContextUi,
} from './AdvancedNutritionModal';
import { AdvancedNutritionSavedReport } from './AdvancedNutritionSavedReport';
import {
  acceptRecipeContextRow,
  dismissRecipeContextRow,
  recipeContextReviewView,
  undoRecipeContextRow,
  type RecipeContextReviewSession,
  type RecipeContextSessionIdentity,
  type RecipeContextSessionResult,
} from '../core/nutritionV2/aiRecipeContextSession';

/** The user-facing label for removing an accepted AI-3 estimate. */
export const AI_ESTIMATE_CLEAR_LABEL = 'Remove estimate';

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
  /**
   * Display-only `needs_review` markers from the current AI-first review. Apply
   * persists them as unresolved metadata so reopen does not mislabel the line as
   * `no_match`. They never change nutrition or matching authority.
   */
  readonly reviewReasons?: Readonly<Record<string, 'needs_review'>>;
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
  /** Vault-scoped, persistent opt-in. It authorizes nutrition Apply+Save only. */
  nutritionAuthority?: {
    readonly enabled: boolean;
    readonly available: boolean;
    /** Exact active recipe/Vault bindings used by the existing standing save grant. */
    readonly recipeIdentity?: string;
    readonly vaultScope?: string;
    readonly onChange: (enabled: boolean) => Promise<void> | void;
  };
  /**
   * The ALREADY-VALIDATED saved Advanced block, supplied by the consolidated
   * nutrition section. The saved report renders from this alone; no USDA
   * session is required. Absent for recipes without a recognized saved result.
   */
  savedAdvancedBlock?: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3 | CodexNutritionV4 | CodexNutritionV5 | CodexNutritionV6;
  /**
   * Optional AI-assisted USDA resolution port, injected by the shell (the shell
   * owns the network + application layer; the UI never imports the application
   * layer directly). Advisory only: it returns deterministic local candidates.
   */
  onResolveWithAi?: AdvancedNutritionAiResolveHandler;
  /**
   * Optional AI-FIRST resolution port. The explicit “Analyze with SHISO” action
   * uses the two-pass AI-first workflow (whole-recipe interpretation -> real USDA
   * discovery -> candidate evaluation -> local verification). Generate Nutrition
   * and opening a saved report never call it. The manual AI-help action keeps the
   * legacy port.
   */
  onResolveWithAiFirst?: AdvancedNutritionAiResolveHandler;
  /** Optional bounded external nutrition research port (AN-WEB-1). */
  onResearchNutritionWithAi?: AdvancedNutritionResearchHandler;
  /** Optional explicit USDA Branded Foods lookup port (SINC-2). */
  onSearchBrandedFoods?: AdvancedNutritionBrandedLookupHandler;
  /**
   * Optional AI candidate-PLAN port (AI-2C), injected by the shell for the SAME
   * reason: the UI never imports the application layer, and the shell owns the
   * network + Phase-4 authority. It returns ONLY inert, already-confirmed
   * deterministic results; the card applies them through the existing
   * working-state path.
   */
  onPlanWithAi?: AdvancedNutritionAiPlanHandler;
  /**
   * Optional AI-3 BOUNDED MASS ESTIMATE port, injected by the shell for the
   * same reason as the other AI ports: the UI never imports the application
   * layer or any provider/server code. It is called ONLY on an explicit first
   * click, never on render and never on re-analysis, and it returns OFFERS
   * ONLY. An offer is inert: it grants no authority and changes no state
   * until the user performs a SECOND explicit click.
   */
  onEstimateMassesWithAi?: AdvancedNutritionAiEstimateHandler;
  /**
   * Optional AI-4D2 RECIPE-CONTEXT REVIEW port, injected by the shell for the same
   * reason as every other AI port: the UI never imports the application layer or
   * any provider/server code. It is called ONLY on an explicit click, never on
   * open, render or re-analysis, and it returns an inert review session with an
   * EMPTY decision overlay: nothing is accepted on the user's behalf.
   */
  onReviewRecipeContextWithAi?: AdvancedNutritionRecipeContextReviewHandler;
  /**
   * AI-5C BOUNDED PRESENTATION STATE (optional; shell-owned).
   *
   * Two plain fields, already decided by the shell/application layer:
   *
   *   - `available`: effective AI availability, composed as PRODUCT ENTITLED AND
   *     OPERATIONALLY READY. False for a Basic deployment, for AI Advanced with no
   *     usable provider, and for an unverifiable product status alike.
   *   - `reason`: a fixed, bounded, pre-computed user-facing sentence explaining WHY,
   *     so the three distinct situations stop sharing one generic message.
   *
   * This is presentation input ONLY. The component never calls the status endpoint,
   * never imports the application layer or any server/provider/credential module,
   * never inspects the environment, never infers BYOK, and never resolves
   * entitlement for itself. It also never grants authority: even a forged `available`
   * here cannot make a gated server route run, and it must never cause a paid route
   * to be invoked from a visually disabled control.
   *
   * When absent, the AI surfaces render as they did before AI-5C (no reason copy),
   * which keeps this purely additive for embedders that do not supply it.
   */
  advancedNutritionAiAvailability?: AdvancedNutritionAiAvailability;
}

/**
 * AI-5C BOUNDED PRESENTATION STATE.
 *
 * Deliberately two primitives and nothing else: a boolean and a fixed sentence. No
 * tier string, no feature flags, no provider state, no billing/plan field and
 * nothing the UI could mistake for an entitlement of its own. The distinction between
 * "not enabled for this deployment", "enabled but no provider available" and
 * "access could not be verified" is resolved by the shell and arrives here as copy.
 */
export interface AdvancedNutritionAiAvailability {
  /** Effective AI availability: product entitled AND operationally ready. */
  readonly available: boolean;
  /** Fixed bounded reason sentence, or `null` when AI is available. */
  readonly reason: string | null;
  /**
   * AI-5D: a readiness refresh is in flight. While true, AI controls are disabled and
   * the reason copy is NEUTRAL — the UI must not claim Basic, "not entitled", or
   * "provider unavailable" while the answer is genuinely still being checked.
   */
  readonly refreshing?: boolean;
  /**
   * AI-5D: whether the user may request a re-check. True only for states a re-check
   * can actually improve (provider unavailable, or an unverified status). A
   * definitive Basic product answer is policy, not a transient failure, so it is
   * never offered.
   */
  readonly canRetry?: boolean;
  /** AI-5D: the explicit user-triggered re-check. Never called while refreshing. */
  readonly onRetry?: () => void;
  /**
   * Product entitlement to the Advanced review workspace. This is INDEPENDENT of
   * provider readiness: a product-entitled user may still review/edit manually
   * when the provider is unavailable, while a Basic user cannot enter the
   * workspace at all. `unknown` fails closed until the server-owned product read
   * completes.
   */
  readonly advancedEditingAccess?: 'unknown' | 'basic' | 'entitled';
  /**
   * Lightweight product-tier read used ONLY to decide whether the Advanced
   * workspace may be offered. It must not load the USDA bundle and must not make
   * an AI/provider call. Called once on mount only while access is unknown.
   */
  readonly onResolveAccess?: () => void;
}

/**
 * The outcome of one explicit recipe-context review. Deliberately narrow: a
 * bounded message on failure, or an inert review session on success. No nutrition
 * state, no preview, no persistence field and no authority crosses this boundary.
 */
export interface AdvancedNutritionRecipeContextOutcome {
  readonly ok: boolean;
  readonly message?: string;
  readonly session?: RecipeContextReviewSession;
}

export type AdvancedNutritionRecipeContextReviewHandler = (args: {
  readonly recipe: ObsidianRecipe;
}) => Promise<AdvancedNutritionRecipeContextOutcome>;

/**
 * The AI-3 estimate port. It returns already-reconciled, already-sanitised
 * OFFERS. The card never turns an offer into a working choice on its own.
 */
export type AdvancedNutritionAiEstimateHandler = (args: {
  readonly state: Phase4State;
  readonly lines: ReadonlyArray<{
    readonly line_ref: string;
    readonly original_text: string;
    readonly outcome: string;
  }>;
  readonly servings: number;
  readonly request_token: string;
}) => Promise<{
  readonly ok: true;
  readonly offers: ReadonlyArray<{
    readonly line_ref: string;
    readonly label: string;
    readonly lower_grams: number;
    readonly upper_grams: number;
    readonly representative_grams: number;
    readonly representative_policy: 'midpoint';
    readonly notes?: string;
    /**
     * Local, already-derived identity evidence. It is NEVER rendered and never
     * leaves the card. The card re-verifies it against `state.matches` at the
     * second click, so a stale capture cannot be applied.
     */
    readonly evidence?: {
      readonly line_ref: string;
      readonly fdc_id: number;
      readonly record_digest: string;
      readonly ingredient_identity_digest: string;
      readonly bundle_release: string;
    };
  }>;
  readonly refused: ReadonlyArray<{ readonly line_ref: string; readonly reason: string }>;
  readonly message?: string;
}>;

/** One accepted (confirmed) AI-2C line, ready for the existing match transition. */
export interface AdvancedNutritionAiPlanAccepted {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly choice: unknown;
}

/** One authenticated AI-2C recommendation (never preselected, never applied). */
export interface AdvancedNutritionAiPlanOffer {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly description?: string;
  readonly choice: unknown;
}

/** Honest, bounded AI-2C outcome the card reports verbatim. */
export interface AdvancedNutritionAiPlanOutcome {
  readonly ok: boolean;
  readonly message?: string;
  readonly accepted: ReadonlyArray<AdvancedNutritionAiPlanAccepted>;
  readonly offers: ReadonlyArray<AdvancedNutritionAiPlanOffer>;
  readonly acceptedCount: number;
  readonly offerCount: number;
  readonly preservedCount: number;
  readonly conflictCount: number;
  readonly unchangedCount: number;
}

/**
 * Injected AI candidate-plan port (AI-2C). Unlike the AI-1 resolve port, the
 * deterministic plan needs a request identity and the mid-flight working-choice
 * fingerprint snapshot, which the UI owns (it is the only layer that sees every
 * user edit).
 */
export type AdvancedNutritionAiPlanHandler = (args: {
  readonly session: AdvancedNutritionSession;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly issueKinds: Readonly<Record<string, AiResolutionIssueKind>>;
  readonly liveRows: ReadonlyArray<LiveRowState>;
  readonly state: Phase4State;
  /** Bounded request identity, generated by the UI (no clock, no randomness). */
  readonly requestId: string;
  /** Working-choice fingerprints captured at request start, per line ref. */
  readonly capturedFingerprints: Readonly<Record<string, string>>;
}) => Promise<AdvancedNutritionAiPlanOutcome>;

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
  /**
   * Phase 9B-3C — the AUTHORED recipe source, supplied by the shell.
   *
   * The whole-recipe semantic path reasons over the COMPLETE recipe including
   * its instructions, so the shell needs the authored recipe to build that
   * request. The UI never parses it: it only forwards the recipe object it
   * already holds, and the shell derives exact line refs through the existing
   * deterministic adapter.
   */
  readonly recipe?: ObsidianRecipe;
  /**
   * Caller cancellation owned by the card. The AI-first port forwards it through
   * both HTTP requests so the route can abort the actual provider transport.
   */
  readonly signal?: AbortSignal;
  /**
   * AN-ARCH-1 — set ONLY for the explicit “Analyze with SHISO” action. The shell
   * may then keep a DETERMINISTICALLY VALIDATED semantic match automatic instead
   * of downgrading every `review_suggested` line to a per-row offer. Generate
   * Nutrition never sets it; manual AI help omits it and keeps the conservative
   * contract.
   */
  readonly orchestration?: 'generate';
}) => Promise<{
  readonly ok: boolean;
  readonly message?: string;
  /** Number of advisory suggestions the resolver accepted as usable (optional). */
  readonly interpretedCount?: number;
  readonly outcome: AiResolveOutcome;
  readonly amounts: AiAmountResolveOutcome;
  /** Verified-household resolutions (optional for back-compatible ports). */
  readonly households?: AiHouseholdResolveOutcome;
  /** Bounded server diagnostics: source-contradicted quantity interpretations. */
  readonly contradicted?: ReadonlyArray<string>;
  /** Bounded server diagnostics: interpretations with no usable semantic content. */
  readonly inadaptable?: ReadonlyArray<string>;
  /** Bounded server diagnostics: understood but withheld non-resolutions. */
  readonly withheld?: ReadonlyArray<{
    readonly line_ref: string;
    readonly reason: 'ambiguous' | 'alternatives';
  }>;
  /** AI-FIRST per-line model explanations for non-selections. */
  readonly aiFirstReviews?: ReadonlyArray<AdvancedNutritionAiReview>;
}>;

/** AN-WEB-1: one explicit external-research request from the UI. */
export type AdvancedNutritionResearchHandler = (args: {
  readonly targets: ReadonlyArray<ResearchTarget>;
  readonly lineRefs: ReadonlyArray<string>;
  readonly lineTextByRef: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly ok: boolean;
  readonly message?: string;
  readonly code?: string;
  readonly contributions?: ReadonlyArray<AiNutrientContribution>;
  readonly offers?: ReadonlyArray<AdvancedNutritionResearchOffer>;
  readonly skipped?: ReadonlyArray<{ readonly line_ref: string; readonly reason: string }>;
}>;

/** SINC-2: one explicit USDA Branded Foods lookup request from the UI. */
export type AdvancedNutritionBrandedLookupHandler = (args: {
  readonly lineRef: string;
  readonly query: string;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly ok: boolean;
  readonly message?: string;
  readonly code?: string;
  readonly candidates?: ReadonlyArray<UsdaBrandedFoodCandidate>;
  readonly cacheStatus?: 'hit' | 'miss';
  readonly retrievedAt?: string;
  readonly retryAfterSeconds?: number;
}>;

/**
 * Visible outcome of the explicit “Analyze with SHISO” operation. This is
 * deliberately separate from the manual AI panel's `aiMessage`: the intentional
 * SHISO operation must report its own completion/failure even when the secondary
 * review panel is collapsed.
 */
export type GenerateAiFeedback =
  | { readonly kind: 'running'; readonly message: string }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'partial'; readonly message: string }
  | { readonly kind: 'insufficient'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

interface AiResolveUiOutcome {
  readonly ok: boolean;
  readonly resolvedAutomatically: number;
  readonly stillNeedReview: number;
  readonly interpretedCount: number;
  readonly message: string;
}

/**
 * The number of advisory suggestions that were actually processed by the local
 * verifiers, derived from the outcome itself. Used as the truthful fallback when
 * the resolver port does not report an explicit count.
 */
function interpretedSuggestionCount(result: {
  readonly outcome: AiResolveOutcome;
  readonly amounts: AiAmountResolveOutcome;
  readonly households?: AiHouseholdResolveOutcome;
}): number {
  const refs = new Set<string>();
  for (const candidate of result.outcome.candidates) refs.add(candidate.line_ref);
  for (const ref of result.outcome.unresolved) refs.add(ref);
  for (const entry of result.amounts.resolved) refs.add(entry.line_ref);
  for (const entry of result.amounts.offers) refs.add(entry.line_ref);
  for (const ref of result.amounts.unresolved) refs.add(ref);
  for (const ref of result.amounts.inconsistent) refs.add(ref);
  for (const entry of result.households?.resolved ?? []) refs.add(entry.line_ref);
  for (const ref of result.households?.unresolved ?? []) refs.add(ref);
  for (const ref of result.households?.inconsistent ?? []) refs.add(ref);
  return refs.size;
}

type ApplyUiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming'; readonly mode: 'create' | 'replace' }
  | { readonly kind: 'applying' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

type ShisoNutritionUiState =
  | { readonly kind: 'idle'; readonly message: null }
  | { readonly kind: 'running'; readonly message: string }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

const NO_INGREDIENTS: ReadonlyArray<AdaptedIngredient> = Object.freeze([]);
const NO_AI_CONTRIBUTIONS = Object.freeze([]);
const NO_AI_SUPPLEMENTS = Object.freeze([]);

/**
 * The Advanced card's single status-label authority. Precedence is deliberate
 * and presentation-only:
 *   1. not analyzed / applied-not-saved (the persisted-state distinction);
 *   2. stale / needs review;
 *   3. partial / incomplete;
 *   4. includes AI estimates;
 *   5. complete.
 * Qualifiers compose so a partial result can never hide behind an AI badge.
 */
export function advancedNutritionStatusLabel(input: {
  readonly hasSavedBlock: boolean;
  readonly nutritionUnsaved: boolean;
  readonly stale: boolean;
  readonly partial: boolean;
  readonly hasAiEstimate: boolean;
}): string {
  if (!input.hasSavedBlock) return 'Not analyzed';
  const qualifiers = [
    input.partial ? 'partial' : null,
    input.hasAiEstimate ? 'includes AI estimates' : null,
  ].filter((value): value is string => value !== null);
  if (input.nutritionUnsaved) {
    return ['Applied · not saved', ...qualifiers].join(' · ');
  }
  if (input.stale) {
    return ['Saved · needs review', ...qualifiers].join(' · ');
  }
  if (qualifiers.length === 0) return 'Saved · complete';
  return ['Saved', ...qualifiers].join(' · ');
}

export const AdvancedNutritionCard: React.FC<AdvancedNutritionCardProps> = ({
  recipe,
  session = null,
  bundleStatus,
  onLoadBundle,
  onApplyAdvancedNutrition,
  nutritionAuthority,
  savedAdvancedBlock,
  onResolveWithAi,
  onResolveWithAiFirst,
  onResearchNutritionWithAi,
  onSearchBrandedFoods,
  onPlanWithAi,
  onEstimateMassesWithAi,
onReviewRecipeContextWithAi,
  advancedNutritionAiAvailability,
}) => {
  const servingBasisAssumed = !(typeof recipe.servings === 'number' && Number.isFinite(recipe.servings) && recipe.servings > 0);
  const shiso = useShiso();
  const standingNutritionEnabled = nutritionAuthority?.enabled === true;
  const standingNutritionRecipeIdentity = nutritionAuthority?.recipeIdentity ?? '';
  const standingNutritionVaultScope = nutritionAuthority?.vaultScope ?? '';
  const nutritionUnsaved = shiso.workingRecipe?.nutrition_unsaved === true;
  // Product entitlement is independent of provider readiness. `unknown` fails
  // closed until the server-owned product read completes.
  const advancedEditingAccess =
    advancedNutritionAiAvailability?.advancedEditingAccess ?? 'entitled';
  const advancedEditingEntitled = advancedEditingAccess === 'entitled';
  const advancedEditingBasic = advancedEditingAccess === 'basic';
  const aiRefreshing = advancedNutritionAiAvailability?.refreshing === true;
  const aiAvailabilityAvailable =
    !aiRefreshing && (advancedNutritionAiAvailability?.available ?? true);
  const aiAvailabilityReason = advancedNutritionAiAvailability?.reason ?? null;
  const aiCanRetry = advancedNutritionAiAvailability?.canRetry === true;
  const aiOnRetry = advancedNutritionAiAvailability?.onRetry;
  const onResolveAccess = advancedNutritionAiAvailability?.onResolveAccess;

  // Resolve the product tier once for an honest Basic/Advanced surface. This is a
  // lightweight server-owned product read, never a bundle load or provider call.
  useEffect(() => {
    if (advancedEditingAccess !== 'unknown') return;
    onResolveAccess?.();
  }, [advancedEditingAccess, onResolveAccess]);

  const [isOpen, setIsOpen] = useState(false);
  const [isSavedReportOpen, setIsSavedReportOpen] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [applyState, setApplyState] = useState<ApplyUiState>({ kind: 'idle' });
  const [appliedNutritionSaved, setAppliedNutritionSaved] = useState(false);
  const [analysisRuns, setAnalysisRuns] = useState(0);
  const [shisoNutritionState, setShisoNutritionState] = useState<ShisoNutritionUiState>({ kind: 'idle', message: null });
  const [standingTransactionPending, setStandingTransactionPending] = useState(false);
  const standingTransactionSeq = useRef(0);
  const shisoNutritionRunningRef = useRef(false);
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
  // SINC-4R2: persisted supplements are shown as verification-needed until the
  // genuine session re-derives source evidence and either verifies or
  // quarantines each one.
  const [quarantinedSupplements, setQuarantinedSupplements] = useState<ReadonlyArray<QuarantinedSupplement>>([]);
  const [supplementVerificationDone, setSupplementVerificationDone] = useState(false);
  // AI-assisted USDA resolution (advisory only; never authority).
  const [aiRunning, setAiRunning] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, AdvancedNutritionAiSuggestion>>({});
  /**
   * AI-FIRST `needs_review` / `no_match` explanations. EPHEMERAL working state:
   * cleared on every new analysis, recipe/session change and editor closure. It
   * never mutates nutrition or grants selection authority.
   */
  const [aiReviews, setAiReviews] = useState<Record<string, AdvancedNutritionAiReview>>({});
  const [researchRunning, setResearchRunning] = useState(false);
  const [researchMessage, setResearchMessage] = useState<string | null>(null);
  const [researchOffers, setResearchOffers] = useState<ReadonlyArray<AdvancedNutritionResearchOffer>>([]);
  const [researchContributions, setResearchContributions] = useState<ReadonlyArray<AiNutrientContribution>>([]);
  /**
   * AN-LIVE-R1: the user's explicit research selection. Research never gathers
   * eligible lines automatically; only these bounded refs may be requested.
   */
  const [researchSelectedRefs, setResearchSelectedRefs] = useState<ReadonlyArray<string>>([]);
  const researchAbortRef = useRef<AbortController | null>(null);
  const researchRequestSeq = useRef(0);
  /**
   * SINC-2: explicit USDA Branded Foods lookup state. A candidate is never
   * selected or used automatically; the user chooses the ingredient, searches,
   * selects a product, acknowledges a representative-brand assumption when
   * needed, and then explicitly uses it.
   */
  const [brandedSelectedLineRef, setBrandedSelectedLineRef] = useState<string>('');
  const [brandedRunning, setBrandedRunning] = useState(false);
  const [brandedMessage, setBrandedMessage] = useState<string | null>(null);
  const [brandedCandidates, setBrandedCandidates] = useState<ReadonlyArray<UsdaBrandedFoodCandidate>>([]);
  const [brandedSelectedFdcId, setBrandedSelectedFdcId] = useState<number | null>(null);
  const [brandedRepresentativeAccepted, setBrandedRepresentativeAccepted] = useState(false);
  const [brandedCacheStatus, setBrandedCacheStatus] = useState<'hit' | 'miss' | null>(null);
  const [brandedRetrievedAt, setBrandedRetrievedAt] = useState<string | null>(null);
  const brandedAbortRef = useRef<AbortController | null>(null);
  const brandedRequestSeq = useRef(0);
  /**
   * AI-interpreted authenticated count portions that remain the USER'S explicit
   * choice (materially different weights). Never auto-selected.
   */
  const [aiAmountOffers, setAiAmountOffers] = useState<
    Record<string, ReadonlyArray<AdvancedNutritionAiAmountOffer>>
  >({});
  /**
   * AI-3 estimate OFFERS. These are INERT display values: they are not
   * working choices, they are not passed to the calculator, and they do not
   * affect the preview or Apply eligibility. Only `handleUseAiEstimateOffer`
   * may promote one into working state, and only after every re-check passes.
   */
  const [aiEstimateOffers, setAiEstimateOffers] = useState<
    Record<string, Readonly<AiEstimateOffer>>
  >({});
  const [aiEstimateRunning, setAiEstimateRunning] = useState(false);
  /** Local, non-displayed identity evidence captured with each offer. */
  const [aiEstimateEvidence, setAiEstimateEvidence] = useState<
    Record<string, AiEstimateSelectionEvidence>
  >({});
  const [aiEstimateMessage, setAiEstimateMessage] = useState<string | null>(null);
  /**
   * The working-choice fingerprint and snapshot binding captured when each
   * offer was created. The second click compares the CURRENT values against
   * these; any drift refuses the acceptance.
   */
  const [aiEstimateOfferBindings, setAiEstimateOfferBindings] = useState<
    Record<string, { readonly fingerprint: string; readonly snapshot_binding: string }>>({});
  const aiRequestSeq = useRef(0);
  /**
   * Monotonic AI lifecycle generation. Bumped on every recipe-identity change so
   * an in-flight response created for a previous recipe can never land.
   */
  const aiGeneration = useRef(0);
  /** Synchronous re-entry guard (a rapid double-click must make ONE request). */
  const aiRunningRef = useRef(false);
  /**
   * Cancellation owner for the CURRENT AI request. Closing the editor, changing
   * the recipe/session, bundle failure or unmount aborts it; the AI-first port
   * forwards this signal to the HTTP route and the actual provider transport.
   */
  const aiAbortRef = useRef<AbortController | null>(null);
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
  // ---------------------------------------------------------------------------
  // AI-4D2 EXPLICIT RECIPE-CONTEXT REVIEW (session-only, memory-only, NO authority)
  //
  // The review is INERT data owned by this component and by nothing else: it is
  // never dispatched into `Phase4State`, never hydrated, never persisted and never
  // sent anywhere. Accept/Dismiss/Undo are pure local decisions, so they make no
  // network call at all — only `handleReviewRecipeContext` performs a request, and
  // only from an explicit click.
  // ---------------------------------------------------------------------------
  const [recipeContextSession, setRecipeContextSession] = useState<RecipeContextReviewSession | null>(
    null
  );
  const [recipeContextRunning, setRecipeContextRunning] = useState(false);
  const [recipeContextMessage, setRecipeContextMessage] = useState<string | null>(null);
  const [recipeContextStarted, setRecipeContextStarted] = useState(false);
  /**
   * Monotonic review generation. Bumped on every new run, every clear, and every
   * recipe change, so an older completion can never replace newer review state.
   */
  const recipeContextGeneration = useRef(0);
  /** The recipe identity this review belongs to; a decision must match it. */
  const recipeContextRecipeId = useRef<string | null>(null);
  /**
   * The independently captured IDENTITY ANCHOR for the INSTALLED review operation.
   *
   * Captured ONCE, from the successful review result, when the session is installed —
   * and then NEVER recomputed. Accept/Dismiss/Undo and the review view read THIS,
   * never the session being checked. Deriving the expectation from the object under
   * test made the D2 core's identity check compare the session with itself, so it
   * could never fail; with a separately captured anchor the same check is meaningful
   * again, because a session whose identity drifted from the anchor is refused.
   *
   * It is an anchor, NOT a second digest and NOT a second freshness algorithm: it
   * holds the `request_id` and `context_binding` the D2 core already requires, and it
   * adds no computation, no network call and no receipt verification. It is memory-only
   * and is never persisted, transmitted or handed to Apply.
   */
  const recipeContextExpectedIdentity = useRef<RecipeContextSessionIdentity | null>(null);

  /**
   * A new recipe ends the review. Decisions from the previous recipe are dropped
   * with it, so a stale review can never be accepted against different source text.
   * The identity anchor is cleared with the session, never carried across recipes.
   */
  useEffect(() => {
    recipeContextGeneration.current += 1;
    recipeContextRecipeId.current = null;
    recipeContextExpectedIdentity.current = null;
    setRecipeContextSession(null);
    setRecipeContextMessage(null);
    setRecipeContextStarted(false);
    setRecipeContextRunning(false);
  }, [recipe.id]);

  /** Clears the review, every decision in it, and its identity anchor. */
  const clearRecipeContextReview = useCallback(() => {
    recipeContextGeneration.current += 1;
    recipeContextRecipeId.current = null;
    recipeContextExpectedIdentity.current = null;
    setRecipeContextSession(null);
    setRecipeContextMessage(null);
    setRecipeContextStarted(false);
  }, []);

  const handleReviewRecipeContext = useCallback(async () => {
    if (!onReviewRecipeContextWithAi || recipeContextRunning) return;
    recipeContextGeneration.current += 1;
    const token = recipeContextGeneration.current;
    setRecipeContextRunning(true);
    // A run has now been requested: the surface offers Clear review from here on,
    // whether or not the run produces a review.
    setRecipeContextStarted(true);
    setRecipeContextMessage(null);
    try {
      const outcome = await onReviewRecipeContextWithAi({ recipe });
      // An older run finishing late can never write state.
      if (token !== recipeContextGeneration.current) return;
      if (outcome.ok !== true || outcome.session === undefined) {
        // A FAILED run fabricates nothing: no session and no new identity anchor.
        // A previously installed review keeps its own consistent anchor.
        setRecipeContextMessage(
          outcome.message ?? "Recipe context review isn't available right now."
        );
        return;
      }
      setRecipeContextSession(outcome.session);
      // Capture the identity anchor for THIS review operation exactly once, frozen,
      // at install time — from the review result, never from a later session read.
      recipeContextExpectedIdentity.current = Object.freeze({
        requestId: outcome.session.request_id,
        contextBinding: outcome.session.context_binding,
      });
      recipeContextRecipeId.current = recipe.id;
    } finally {
      if (token === recipeContextGeneration.current) setRecipeContextRunning(false);
    }
  }, [onReviewRecipeContextWithAi, recipe, recipeContextRunning]);

  /**
   * Applies ONE user decision through the pure acceptance core, using the separately
   * captured identity anchor. The core re-checks the session against that anchor, so
   * a stale or drifted review fails closed instead of being applied.
   *
   * FAILS CLOSED on all of: no session, a run in flight, a recipe identity mismatch,
   * no captured anchor, and the core's own identity verdict. A mismatch is never
   * silently repaired or rewritten.
   */
  const applyRecipeContextDecision = useCallback(
    (
      decide: (
        session: RecipeContextReviewSession,
        expected: RecipeContextSessionIdentity
      ) => RecipeContextSessionResult
    ) => {
      const current = recipeContextSession;
      if (current === null || recipeContextRunning) return;
      if (recipeContextRecipeId.current !== recipe.id) return;
      const expected = recipeContextExpectedIdentity.current;
      if (expected === null) return;
      const result = decide(current, expected);
      if (!result.ok) return;
      setRecipeContextSession(result.session);
    },
    [recipe.id, recipeContextRunning, recipeContextSession]
  );

  const handleAcceptRecipeContextRow = useCallback(
    (lineRef: string) => {
      applyRecipeContextDecision((session, expected) =>
        acceptRecipeContextRow(session, lineRef, expected)
      );
    },
    [applyRecipeContextDecision]
  );

  const handleDismissRecipeContextRow = useCallback(
    (lineRef: string) => {
      applyRecipeContextDecision((session, expected) =>
        dismissRecipeContextRow(session, lineRef, expected)
      );
    },
    [applyRecipeContextDecision]
  );

  const handleUndoRecipeContextRow = useCallback(
    (lineRef: string) => {
      applyRecipeContextDecision((session, expected) =>
        undoRecipeContextRow(session, lineRef, expected)
      );
    },
    [applyRecipeContextDecision]
  );

  const [pendingGenerateRecipeKey, setPendingGenerateRecipeKey] = useState<string | null>(null);
  /**
   * User-visible state of the EXPLICIT “Analyze with SHISO” action. Generate
   * Nutrition never sets this and never calls AI; only the intentional SHISO
   * action does.
   */
  const [generateAiFeedback, setGenerateAiFeedback] = useState<GenerateAiFeedback | null>(null);

  /**
   * Cancels any in-flight AI/SHISO/research request and clears its visible
   * status. It is called only for a genuine cancellation: the user closes the
   * working editor, the recipe changes, the component unmounts, or bundle
   * initialization fails.
   */
  const cancelGenerateAiIntent = useCallback(() => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    researchAbortRef.current?.abort();
    researchAbortRef.current = null;
    brandedAbortRef.current?.abort();
    brandedAbortRef.current = null;
    setGenerateAiFeedback(null);
    setAiReviews({});
    setResearchRunning(false);
    setResearchMessage(null);
    setResearchOffers([]);
    setResearchContributions([]);
    setResearchSelectedRefs([]);
    setBrandedCandidates([]);
    setBrandedSelectedFdcId(null);
    setBrandedRepresentativeAccepted(false);
    setBrandedCacheStatus(null);
    setBrandedRetrievedAt(null);
    setBrandedMessage(null);
  }, []);

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
    cancelGenerateAiIntent();
    setAiSuggestions({});
    setAiAmountOffers({});
    setAiEstimateOffers({});
    setAiEstimateOfferBindings({});
    setAiEstimateEvidence({});
    setAiMessage(null);
    setAiRunning(false);
    setIsOpen(false);
    setIsSavedReportOpen(false);
    researchAbortRef.current?.abort();
    researchAbortRef.current = null;
    brandedAbortRef.current?.abort();
    brandedAbortRef.current = null;
    setBrandedCandidates([]);
    setBrandedSelectedFdcId(null);
    setBrandedRepresentativeAccepted(false);
    setBrandedCacheStatus(null);
    setBrandedRetrievedAt(null);
    setBrandedMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRecipeKey]);

  /**
   * BUNDLE-INITIALIZATION FAILURE is a genuine cancellation: no session will
   * arrive, so no automatic provider call may remain pending.
   */
  useEffect(() => {
    if (bundleStatus === 'failed' || bundleStatus === 'unsupported') {
      cancelGenerateAiIntent();
    }
  }, [bundleStatus, cancelGenerateAiIntent]);

  /**
   * UNMOUNT is a genuine cancellation. Ref-only cleanup is safe; it invalidates
   * any in-flight response and prevents a later pending effect from surviving the
   * component.
   */
  useEffect(
    () => () => {
      isOpenRef.current = false;
      aiGeneration.current += 1;
      aiRequestSeq.current += 1;
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
      researchAbortRef.current?.abort();
      researchAbortRef.current = null;
      brandedAbortRef.current?.abort();
      brandedAbortRef.current = null;
    },
    []
  );

  /**
   * SESSION-AUTHORITY RESET. A different pinned session (bundle authority)
   * invalidates in-flight AI responses too, but must NOT cancel a recipe-bound
   * Generate intent that is waiting for the SAME recipe's lazy load to finish.
   */
  useEffect(() => {
    aiGeneration.current += 1;
    aiRequestSeq.current += 1;
    aiRunningRef.current = false;
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    researchAbortRef.current?.abort();
    researchAbortRef.current = null;
    brandedAbortRef.current?.abort();
    brandedAbortRef.current = null;
    setAiSuggestions({});
    setAiReviews({});
    setResearchRunning(false);
    setResearchMessage(null);
    setResearchOffers([]);
    setResearchContributions([]);
    setResearchSelectedRefs([]);
    setBrandedCandidates([]);
    setBrandedSelectedFdcId(null);
    setBrandedRepresentativeAccepted(false);
    setBrandedCacheStatus(null);
    setBrandedRetrievedAt(null);
    setBrandedMessage(null);
    setAiAmountOffers({});
    setAiEstimateOffers({});
    setAiEstimateOfferBindings({});
    setAiEstimateEvidence({});
    setAiMessage(null);
    setAiRunning(false);
    setGenerateAiFeedback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionIdentity]);

  // When a user-initiated load succeeds AND the server-owned product read says
  // Advanced is entitled, focus the (now-rendered) opener and open the review UI
  // exactly once — ONLY when the SAME recipe that requested the load is current.
  useEffect(() => {
    if (advancedEditingAccess === 'basic') {
      pendingOpenRecipeKey.current = null;
      return;
    }
    if (!session || advancedEditingAccess !== 'entitled') return;
    const captured = pendingOpenRecipeKey.current;
    if (captured === null) return;
    pendingOpenRecipeKey.current = null;
    if (!adaptation.ok || adaptation.recipe.recipe_key !== captured) return;
    openerRef.current?.focus();
    setIsOpen(true);
  }, [session, adaptation, advancedEditingAccess]);

  /** Opens the WORKING analyzer/editor, initializing the USDA bundle if needed. */
  const openWorkingEditor = () => {
    if (advancedEditingBasic) return;
    if (advancedEditingEntitled && session) {
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
    const evidenceKey = JSON.stringify({
      ingredients: savedBlock.ingredients.map((entry) => ({
        line_ref: entry.line_ref,
        source_food_id: entry.source_food_id,
        source_release: entry.source_release,
        amount: entry.amount?.value,
        source_nutrients: (entry as { source_nutrients?: readonly string[] }).source_nutrients,
      })),
      supplements: savedBlock.schema === 6 ? (savedBlock.nutrient_supplements ?? []) : [],
      source_amounts: savedBlock.schema === 6 ? savedBlock.source_amounts : undefined,
    });
    const key = `${phase4SessionIdentity(session.metadata())}|${savedBlock.ingredient_digest}|${evidenceKey}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    setQuarantinedSupplements([]);
    setSupplementVerificationDone(false);
    let hydrated: ReturnType<typeof hydrateWorkingReview>;
    try {
      hydrated = hydrateWorkingReview({
        session,
        recipeKey: adaptation.recipe.recipe_key,
        baseServings: adaptation.recipe.base_servings,
        adapted,
        instructions: recipe.instructions.map((step) => step.text),
        rows: state.rows,
        savedBlock,
      });
    } catch {
      return;
    }
    if (!hydrated) return;
    setQuarantinedSupplements(hydrated.quarantinedSupplements ?? []);
    setSupplementVerificationDone(hydrated.supplementEvidence === 'authoritative_preview');
    dispatch({
      type: 'hydrate',
      aiEstimates: hydrated.aiEstimates,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      householdPortions: hydrated.householdPortions,
      aiNutrition: hydrated.aiNutrition,
    });
    setHydratedFromSaved(true);
    setWorkingTouched(false);
  }, [session, adaptation, adapted, recipe.instructions, savedBlock, state.recipeKey, state.rows]);

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

  // The saved report and this working review must share the SAME already-validated
  // block. Re-reading only recipe.codexNutrition can miss a frontmatter-only
  // block and manufacture a digest mismatch/duplicate UNSAVED REVIEW panel.
  const stored = useMemo(
    () => savedBlock ? summarizeStoredAdvanced(savedBlock) : readStoredBlock(recipe),
    [savedBlock, recipe]
  );
  const savedPresentation = useMemo(() => resolveRecipeNutritionPresentation(recipe), [recipe]);
  const savedSupplementCount = savedBlock?.schema === 6 ? (savedBlock.nutrient_supplements?.length ?? 0) : 0;
  const savedSupplementVerification: 'verified' | 'required' | 'partial' | undefined =
    savedSupplementCount === 0
      ? undefined
      : !supplementVerificationDone
        ? 'required'
        : quarantinedSupplements.length === 0
          ? 'verified'
          : quarantinedSupplements.length >= savedSupplementCount
            ? 'required'
            : 'partial';
  // A v6 block is authoritative only when the genuine session has verified its
  // supplements. Pure presentation intentionally withholds that complete flag.
  const savedDisplayComplete =
    savedPresentation.advanced_complete ||
    (savedPresentation.advanced_verification_required && savedSupplementVerification === 'verified');
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
      (stored.kind === 'v1' || stored.kind === 'v2' || (stored.kind === 'v3' || stored.kind === 'v4' || stored.kind === 'v5' || stored.kind === 'v6')) &&
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
    // Genuine reauthorization checks accepted estimates and their provenance
    // together with source-backed contributions before allowing Apply.
    return previewNutritionApplyEligibility({ session, recipe, state });
  }, [session, recipe, adaptation, state, stored.kind]);

  // Keep accepted quantity estimates visible alongside Apply eligibility.
  const acceptedEstimates = activeAiEstimatesForPreview(state);

  const applyMode: 'create' | 'replace' | null =
    stored.kind === 'v1' || stored.kind === 'v2' || (stored.kind === 'v3' || stored.kind === 'v4' || stored.kind === 'v5' || stored.kind === 'v6')
      ? 'replace'
      : stored.kind === 'none'
        ? 'create'
        : null;

  const handleRequestApply = () => {
    if (!onApplyAdvancedNutrition || applyEligibility !== true || applyMode === null) return;
    if (applyState.kind === 'applying' || applyState.kind === 'confirming') return;
    setApplyState({ kind: 'confirming', mode: applyMode });
  };

  const handleConfirmApply = async () => {
    if (!onApplyAdvancedNutrition || !session || !adaptation.ok) return;
    if (applyState.kind !== 'confirming') return;
    const expectedMode = applyState.mode;
    const reviewReasons: Record<string, 'needs_review'> = {};
    for (const [lineRef, review] of Object.entries(aiReviews)) {
      if (review.decision === 'needs_review') reviewReasons[lineRef] = 'needs_review';
    }
    setApplyState({ kind: 'applying' });
    setAppliedNutritionSaved(false);
    try {
      const result = await onApplyAdvancedNutrition({
        session,
        recipe,
        state,
        expectedMode,
        ...(Object.keys(reviewReasons).length > 0 ? { reviewReasons } : {}),
      });
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

  const handleSaveAppliedNutrition = async () => {
    const result = await shiso.saveWorkingRecipe({ via: 'ui' });
    setAppliedNutritionSaved(result.ok && result.saved);
    setApplyState(result.ok && result.saved
      ? { kind: 'success', message: result.message }
      : { kind: 'error', message: result.message });
  };

  // The always-mounted card owns the live Phase 4 reducer. Register its exact
  // Phase 5 Apply operation so SHISO cannot observe this review and then try to
  // apply a separate or absent application-controller snapshot.
  const shisoRegisterNutritionReviewApplier = shiso.registerNutritionReviewApplier;
  const shisoNutritionReviewApplyRef = useRef({
    onApplyAdvancedNutrition,
    session,
    adaptationOk: adaptation.ok,
    applyEligibility,
    applyMode,
    aiReviews,
    recipe,
    state,
  });
  shisoNutritionReviewApplyRef.current = {
    onApplyAdvancedNutrition,
    session,
    adaptationOk: adaptation.ok,
    applyEligibility,
    applyMode,
    aiReviews,
    recipe,
    state,
  };
  const canRegisterNutritionReviewApplier =
    Boolean(onApplyAdvancedNutrition) && Boolean(session) && adaptation.ok && applyMode !== null;
  useEffect(() => {
    if (!canRegisterNutritionReviewApplier) {
      return undefined;
    }
    return shisoRegisterNutritionReviewApplier(async (): Promise<ShisoNutritionReviewApplyResult> => {
    const current = shisoNutritionReviewApplyRef.current;
    const {
      onApplyAdvancedNutrition: apply,
      session: currentSession,
      adaptationOk,
      applyMode: mode,
      aiReviews: currentAiReviews,
      recipe: currentRecipe,
      state: currentState,
    } = current;
    const currentEligible = currentSession && adaptationOk && currentState.status === 'preview_current' && currentState.preview !== null
      ? previewNutritionApplyEligibility({ session: currentSession, recipe: currentRecipe, state: currentState })
      : false;
    if (!apply || !currentSession || !adaptationOk || currentEligible !== true || mode === null) {
      return {
        ok: false,
        applied: false,
        message: 'The current nutrition review is not eligible to apply.',
        code: 'not_eligible',
      };
    }
    const reviewReasons: Record<string, 'needs_review'> = {};
    for (const [lineRef, review] of Object.entries(currentAiReviews)) {
      if (review.decision === 'needs_review') reviewReasons[lineRef] = 'needs_review';
    }
    const result = await apply({
      session: currentSession,
      recipe: currentRecipe,
      state: currentState,
      expectedMode: mode,
      ...(Object.keys(reviewReasons).length > 0 ? { reviewReasons } : {}),
    });
    return { ok: result.ok, applied: result.ok, message: result.message };
    });
  }, [canRegisterNutritionReviewApplier, shisoRegisterNutritionReviewApplier]);

  const applyUi: AdvancedNutritionApplyUi | undefined = onApplyAdvancedNutrition
    ? {
        eligible: applyEligibility,
        mode: applyMode,
        status: applyState.kind,
        message: applyState.kind === 'success' || applyState.kind === 'error' ? applyState.message : null,
        onRequest: handleRequestApply,
        onConfirm: handleConfirmApply,
        onCancel: handleCancelApply,
        onSave: appliedNutritionSaved || !shiso.canSaveWorkingRecipe ? undefined : handleSaveAppliedNutrition,
      }
    : undefined;

  const handleCalculate = useCallback(() => {
    if (!session || !adaptation.ok) return;
    setCalculating(true);
    const seq = state.operationSeq;
    const key = state.recipeKey ?? '';
    const request = buildCalculationRequest(adapted, state);
    const result = session.calculate(request);
    setCalculating(false);
    if (result.ok) {
      const ai = state.aiNutrition;
      const preview = ai && ai.recipe_key === key && ai.servings === state.baseServings
        ? combineAiContributionsWithPreview(result.preview, ai.contributions, ai.supplements)
        : result.preview;
      dispatch({ type: 'preview_succeeded', seq, recipeKey: key, preview });
    } else {
      dispatch({ type: 'preview_failed', seq, failure: phase4Failure('validation_error') });
    }
  }, [session, adaptation, adapted, state]);

  // Deterministic automatic analysis. Pure/offline; it never persists and never
  // mutates the recipe. Recomputed whenever the adaptation or session changes.
  const analysis = useMemo<RecipeAnalysis | null>(
    () =>
      session && adaptation.ok
        ? analyzeRecipeFromRows(session, adapted, rows, adaptation.recipe.base_servings)
        : null,
    [session, adaptation, adapted, rows]
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
  /**
   * H-2N: the AUTHORITATIVE working state at the moment a capability runs.
   * The applier effect re-registers on every state change, but a ref removes
   * every stale-closure window: corrections are ALWAYS built from, verified
   * against, and dispatched as a delta of the state that exists right now.
   */
  const phase4StateRef = useRef(state);
  phase4StateRef.current = state;

  const shisoRegisterAnalysis = shiso.registerAnalysisApplier;
  useEffect(() => {
    return shisoRegisterAnalysis(async (): Promise<ShisoAnalysisOutcome> => {
      if (!session || !adaptation.ok) {
        return {
          ok: false,
          analyzed: false,
          summary: 'This recipe cannot be analysed yet.',
          matched: 0,
          needs_amount: 0,
          needs_match: 0,
          total_lines: 0,
          unresolved_line_refs: [],
          preview_state: 'absent',
          message: 'Advanced Nutrition cannot analyse this recipe until its ingredients can be read.',
        };
      }
      // Run the existing deterministic analysis + calculator. The projection is
      // already memoized from exactly these inputs, so this is a refresh, not a
      // second engine.
      handleCalculate();
      const rows = liveRowsRef.current;
      const matched = rows.filter((r) => r.status === 'matched' || r.status === 'qualitative').length;
      const needsAmount = rows.filter((r) => r.status === 'needs_amount').length;
      const needsMatch = rows.filter((r) => r.status === 'needs_match').length;
      const unresolved = rows
        .filter((r) => r.status === 'needs_amount' || r.status === 'needs_match')
        .map((r) => r.line_ref);
      return {
        ok: true,
        analyzed: true,
        summary: `${matched} of ${rows.length} ingredient lines resolved`,
        matched,
        needs_amount: needsAmount,
        needs_match: needsMatch,
        total_lines: rows.length,
        unresolved_line_refs: unresolved,
        preview_state: unresolved.length === 0 ? 'complete' : 'partial',
      };
    });
  }, [session, adaptation.ok, handleCalculate, shisoRegisterAnalysis]);

  /**
   * H-2 — SHISO READ SNAPSHOT.
   *
   * The CARD is the always-mounted owner of the working review, so it publishes
   * the CURRENT live projection for the conversation. (Previously only the
   * modal published, so Shiso could not talk about the review unless the dialog
   * happened to be open.) This publishes a READ-ONLY snapshot: publishing
   * grants no authority.
   */
  const shisoResearchEligibleRefs = useMemo(
    () => liveRows
      .filter((live) => live.status === 'needs_match' && aiReviews[live.line_ref]?.decision !== 'needs_review')
      .map((live) => live.line_ref),
    [liveRows, aiReviews]
  );
  const shisoBrandedEligibleRefs = useMemo(
    () => liveRows
      .filter((live) => live.status === 'needs_match' && aiReviews[live.line_ref]?.decision !== 'needs_review')
      .map((live) => live.line_ref),
    [liveRows, aiReviews]
  );
  const shisoPublishNutrition = shiso.publishNutrition;
  const acceptedShisoContributions = state.aiNutrition?.recipe_key === state.recipeKey &&
    state.aiNutrition?.servings === state.baseServings
    ? state.aiNutrition.contributions
    : NO_AI_CONTRIBUTIONS;
  const acceptedShisoSupplements = state.aiNutrition?.recipe_key === state.recipeKey &&
    state.aiNutrition?.servings === state.baseServings
    ? state.aiNutrition.supplements ?? NO_AI_SUPPLEMENTS
    : NO_AI_SUPPLEMENTS;
  const nutritionSummaryText = useMemo(() => {
    return nutritionCoverageSummary(deriveNutritionCoverage(liveRows, acceptedShisoContributions));
  }, [liveRows, acceptedShisoContributions]);
  const shisoNutrientCoverage = useMemo(() => buildShisoNutrientCoverage(preview), [preview]);
  const shisoReviewIdentity = useMemo(
    () => brandedReviewIdentity(state.sessionIdentity ?? '', state.recipeKey ?? '', state.baseServings),
    [state.sessionIdentity, state.recipeKey, state.baseServings]
  );
  useEffect(() => {
    if (!session || !adaptation.ok) {
      shisoPublishNutrition(null);
      return undefined;
    }
    shisoPublishNutrition({
      rows: liveRows,
      summary: nutritionSummaryText,
      unsaved: workingDirty,
      recipeKey: state.recipeKey ?? null,
      sessionIdentity: state.sessionIdentity ?? null,
      reviewRows: state.rows,
      aiContributions: acceptedShisoContributions,
      recipeDigest: state.preview?.ingredient_digest ?? null,
      reviewIdentity: shisoReviewIdentity,
      researchEligibleRefs: shisoResearchEligibleRefs,
      brandedEligibleRefs: shisoBrandedEligibleRefs,
      nutrientCoverage: shisoNutrientCoverage,
      nutrientSupplements: acceptedShisoSupplements,
    });
    return () => shisoPublishNutrition(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, adaptation.ok, liveRows, nutritionSummaryText, workingDirty, state.recipeKey, state.sessionIdentity, state.rows, acceptedShisoContributions, acceptedShisoSupplements, shisoResearchEligibleRefs, shisoBrandedEligibleRefs, shisoNutrientCoverage, shisoReviewIdentity]);

  const shisoRegisterAiNutrition = shiso.registerAiNutritionApplier;
  useEffect(() => shisoRegisterAiNutrition((contributions, supplements) => {
    const current = phase4StateRef.current;
    if (!session || !adaptation.ok || current.recipeKey === null || current.baseServings !== adaptation.recipe.base_servings) return false;
    if (contributions.some((entry) => !current.rows.some((row) => row.line_ref === entry.line_ref))) return false;
    const calculated = session.calculate(buildCalculationRequest(adapted, current));
    if (!calculated.ok) return false;
    const combined = combineAiContributionsWithPreview(calculated.preview, contributions, supplements);
    workingDispatch({
      type: 'accept_ai_nutrition',
      recipeKey: current.recipeKey,
      servings: current.baseServings,
      contributions,
      ...(supplements !== undefined ? { supplements } : {}),
    });
    dispatch({ type: 'preview_succeeded', seq: current.operationSeq, recipeKey: current.recipeKey, preview: combined });
    return true;
  }), [session, adaptation, adapted, shisoRegisterAiNutrition, workingDispatch]);

  /**
   * H-2 — SHISO NUTRITION CORRECTIONS.
   *
   * Registered HERE because this component owns the Phase 4 reducer, the
   * authenticated session, the adaptation and the calculator. The deterministic
   * correction builder reads ONLY authenticated evidence (the same ranked
   * candidate set the review UI shows); the actions it produces are the SAME
   * existing reducer actions a user edit produces; and the preview is computed
   * by the SAME calculator the Calculate button runs. Shiso never fabricates a
   * match, a portion or a gram.
   */
  const shisoRegisterCorrections = shiso.registerCorrectionsApplier;
  useEffect(() => {
    return shisoRegisterCorrections(
      async (lineRefs?: readonly string[]): Promise<ShisoNutritionCorrectionsOutcome> => {
        const unavailable = (message: string): ShisoNutritionCorrectionsOutcome => ({
          ok: false,
          applied: [],
          failed: [],
          regressed: [],
          changes: [],
          unresolved: [],
          summary: message,
          resolved_count: 0,
          total_count: 0,
          recalculation: 'absent',
          working_unsaved: workingDirty,
        });
        if (!session || !adaptation.ok) {
          return unavailable('Advanced Nutrition cannot analyse this recipe yet.');
        }
        // H-2N: ALWAYS the current authoritative state, never a closure copy.
        const currentState = phase4StateRef.current;
        const beforeLive = liveRowsRef.current;
        const before = summarizeLiveRows(beforeLive);
        if (currentState.recipeKey === null || currentState.sessionIdentity === null) {
          return unavailable('The nutrition review is not initialized yet for this recipe.');
        }
        if (currentState.recipeKey !== adaptation.recipe.recipe_key) {
          return unavailable('The nutrition review belongs to a different version of this recipe. Re-analyse it first.');
        }
        const built = buildSupportedNutritionCorrections({
          session,
          liveRows: beforeLive,
          adapted,
          workingState: currentState,
          ...(lineRefs !== undefined ? { lineRefs } : {}),
        });
        if (built.corrections.length === 0) {
          const emptySubset = lineRefs !== undefined && lineRefs.length === 0;
          return {
            ok: false,
            applied: [],
            failed: [],
            regressed: [],
            changes: [],
            unresolved: built.unresolved,
            summary: emptySubset
              ? 'No ingredient lines were specified for correction.'
              : built.unresolved.length > 0
                ? 'No supported correction was available. The remaining ingredients need information only the user can supply.'
                : 'There was nothing to correct.',
            before_resolved_count: before.matched + before.qualitative,
            before_total_count: before.total,
            resolved_count: before.matched + before.qualitative,
            total_count: before.total,
            recalculation: 'absent',
            working_unsaved: workingDirty,
          };
        }

        // H-2N STATE TRUTH. Compute the post-operation state and its REAL
        // projection BEFORE dispatching anything, then verify:
        //   - every attempted correction actually ends resolved with a mass;
        //   - no previously resolved line regresses.
        // Anything else is refused WHOLE — the working review is left untouched
        // and the outcome reports exactly what was found.
        let next = currentState;
        for (const correction of built.corrections) {
          for (const action of correction.actions) next = phase4Reducer(next, action);
        }
        const calculated = session.calculate(buildCalculationRequest(adapted, next));
        if (!calculated.ok) {
          return {
            ok: false,
            applied: [],
            failed: [],
            regressed: [],
            changes: [],
            unresolved: built.unresolved,
            summary:
              'No correction was applied: the recalculated review could not be authenticated, so the working review was left unchanged.',
            before_resolved_count: before.matched + before.qualitative,
            before_total_count: before.total,
            resolved_count: before.matched + before.qualitative,
            total_count: before.total,
            recalculation: 'absent',
            working_unsaved: workingDirty,
          };
        }
        const afterLive = projectLiveRows(
          next,
          analyzedByRef,
          adapted,
          session,
          // The post-operation projection uses the POST-operation preview
          // evidence, so the reported state is exactly what the UI will show.
          ingredientEvidenceViews(calculated.preview),
          analysis?.portions,
          analysis?.countPortions,
        );
        const transition = evaluateCorrectionTransition({
          before: beforeLive,
          after: afterLive,
          corrections: built.corrections.map((correction) => ({
            line_ref: correction.line_ref,
            label: correction.label,
            description: correction.description,
          })),
        });
        const decision = decideCorrectionDispatch(transition);
        const afterSummary = transition.after;
        if (decision.ok !== true) {
          // REFUSED: no dispatch; the user's working review is exactly as it was.
          const regressed = decision.regressed.map((entry) => ({
            line_ref: entry.line_ref,
            label: entry.label,
            reason: `would change ${entry.change} (previously resolved)`,
          }));
          return {
            ok: false,
            applied: [],
            failed: decision.failed,
            regressed,
            changes: transition.changes.map((entry) => ({
              line_ref: entry.line_ref,
              label: entry.label,
              change: entry.change,
              before_status: entry.before_status,
              after_status: entry.after_status,
            })),
            unresolved: built.unresolved,
            summary:
              decision.reason === 'regression'
                ? `No correction was applied: the operation would have left ${decision.regressed.length} previously resolved ingredient(s) unresolved. The working review is unchanged.`
                : `No correction was applied: ${decision.failed.length} correction(s) did not verify against the recalculated review. The working review is unchanged.`,
            before_resolved_count: transition.before.resolved,
            before_total_count: transition.before.total,
            resolved_count: transition.before.resolved,
            total_count: transition.before.total,
            recalculation: 'absent',
            working_unsaved: workingDirty,
          };
        }

        // VERIFIED: dispatch the SAME state that was verified, atomically.
        workingDispatch({
          type: 'apply_analysis',
          matches: next.matches,
          portions: next.portions,
          countPortions: next.countPortions,
          householdPortions: next.householdPortions,
          userMasses: next.userMasses,
          aiEstimates: next.aiEstimates,
          preview: calculated.preview,
        });

        const stillUnresolved = afterSummary.needs_amount + afterSummary.needs_match + afterSummary.review_suggested;
        return {
          ok: true,
          applied: transition.verified.map((entry) => ({
            line_ref: entry.line_ref,
            label: entry.label,
            description: entry.description,
          })),
          failed: [],
          regressed: [],
          changes: transition.changes.map((entry) => ({
            line_ref: entry.line_ref,
            label: entry.label,
            change: entry.change,
            before_status: entry.before_status,
            after_status: entry.after_status,
          })),
          unresolved: built.unresolved,
          summary:
            `Verified ${transition.verified.length} correction(s) against the recalculated review: ` +
            `resolved ${transition.before.resolved} → ${afterSummary.resolved} of ${afterSummary.total}; ` +
            `${stillUnresolved} still unresolved.`,
          before_resolved_count: transition.before.resolved,
          before_total_count: transition.before.total,
          resolved_count: afterSummary.resolved,
          total_count: afterSummary.total,
          recalculation: stillUnresolved === 0 ? 'complete' : 'partial',
          working_unsaved: true,
        };
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, adaptation, state, adapted, analyzedByRef, evidence, analysis, workingDispatch, shisoRegisterCorrections, workingDirty]);

  // SHISO source selection uses the same authenticated Phase 4 match/portion
  // builders as the visible review controls. It never accepts model-supplied
  // grams or digests and verifies the resulting preview before dispatching.
  const shisoRegisterSourceSelection = shiso.registerNutritionSourceSelectionApplier;
  useEffect(() => {
    return shisoRegisterSourceSelection(async ({ lineRef, fdcId, portionIndex }): Promise<ShisoNutritionSourceSelectionOutcome> => {
      const currentState = phase4StateRef.current;
      const fail = (code: string, summary: string): ShisoNutritionSourceSelectionOutcome => ({
        ok: false,
        line_ref: lineRef,
        summary,
        recalculation: 'absent',
        working_unsaved: workingDirty,
        code,
      });
      if (!session || !adaptation.ok) return fail('no_nutrition_review', 'Advanced Nutrition is not available for this source selection.');
      const row = currentState.rows.find((candidate) => candidate.line_ref === lineRef);
      const entry = adapted.find((candidate) => candidate.line_ref === lineRef);
      if (!row || !entry || currentState.recipeKey !== adaptation.recipe.recipe_key || currentState.sessionIdentity === null) {
        return fail('stale_recipe', 'That ingredient line is no longer part of the current authenticated review.');
      }
      if (!Number.isSafeInteger(fdcId) || fdcId <= 0 || !Number.isSafeInteger(portionIndex) || portionIndex < 0) {
        return fail('invalid_request', 'The USDA food or portion selection is invalid.');
      }
      const exact = session.searchFoods(String(fdcId), 5);
      const hit = exact.ok ? exact.results.find((result) => result.fdc_id === fdcId && result.exact_fdc_id) : undefined;
      if (!hit) return fail('invalid_selection', 'That USDA record is not available in the authenticated catalog.');
      const match: MatchChoice = Object.freeze({
        kind: 'manual',
        fdc_id: fdcId,
        review_digest: row.review_digest ?? '',
        record_digest: hit.record_digest,
        catalog_digest: session.metadata().catalog_digest,
        selectionOrigin: 'shiso_user_directed',
        description: hit.description,
      });
      const portion = buildPortionChoice(session, {
        lineRef,
        ingredient: entry.ingredient,
        review: row.review,
        selection: selectionFromMatchChoice(match, lineRef),
        fdcId,
        portionIndex,
      });
      if (!portion.ok) return fail('invalid_selection', 'That USDA portion could not be authenticated for this ingredient.');
      let next = phase4Reducer(currentState, { type: 'select_match', lineRef, choice: match });
      next = phase4Reducer(next, { type: 'select_portion', lineRef, choice: portion.choice });
      const calculated = session.calculate(buildCalculationRequest(adapted, next));
      if (!calculated.ok) return fail('invalid_selection', 'The authenticated nutrition review rejected that source selection.');
      const selected = calculated.preview.ingredients.find((candidate) => candidate.line_ref === lineRef);
      if (!selected || selected.fdc_id !== fdcId || selected.resolved_grams === undefined) {
        return fail('invalid_selection', 'The selected USDA source did not produce a verified ingredient amount.');
      }
      next = phase4Reducer(next, {
        type: 'apply_analysis',
        matches: next.matches,
        portions: next.portions,
        countPortions: next.countPortions,
        householdPortions: next.householdPortions,
        userMasses: next.userMasses,
        aiEstimates: next.aiEstimates,
        preview: calculated.preview,
      });
      // React dispatch is asynchronous. Publish the exact verified state to
      // the synchronous capability owner before dispatching it, so an Apply
      // requested by the next tool in this same SHISO turn cannot consume the
      // previous reducer snapshot.
      phase4StateRef.current = next;
      shisoNutritionReviewApplyRef.current = {
        ...shisoNutritionReviewApplyRef.current,
        state: next,
      };
      workingDispatch({
        type: 'apply_analysis',
        matches: next.matches,
        portions: next.portions,
        countPortions: next.countPortions,
        householdPortions: next.householdPortions,
        userMasses: next.userMasses,
        aiEstimates: next.aiEstimates,
        preview: calculated.preview,
      });
      const portionReview = session.reviewPortions(fdcId);
      const portionCandidate = portionReview.ok
        ? portionReview.review.candidates.find((candidate) => candidate.index === portionIndex)
        : undefined;
      return {
        ok: true,
        line_ref: lineRef,
        fdc_id: fdcId,
        description: hit.description,
        resolved_grams: selected.resolved_grams,
        ...(portionCandidate ? { portion: portionCandidate.display_label } : {}),
        summary: `Verified ${hit.description}: ${portionCandidate?.display_label ?? 'authenticated USDA portion'} → ${selected.resolved_grams} g. The working nutrition review was recalculated; nothing was saved.`,
        recalculation: calculated.preview.status === 'complete' ? 'complete' : 'partial',
        working_unsaved: true,
      };
    });
  }, [session, adaptation, adapted, workingDispatch, shisoRegisterSourceSelection, workingDirty]);

  /** The actionable exception rows derived from the SAME live projection. */
  const actionableRows = useMemo(
    () =>
      session && adaptation.ok
        ? actionableExceptionRows(state.rows, liveRows)
        : Object.freeze([] as Phase4Row[]),
    [session, adaptation, state.rows, liveRows]
  );
  /** AN-WEB-1: unresolved identity-missing lines eligible for external research. */
  const researchEligibleRows = useMemo(
    () => liveRows.filter((live) =>
      live.status === 'needs_match' &&
      aiReviews[live.line_ref]?.decision !== 'needs_review'
    ),
    [liveRows, aiReviews]
  );
  /**
   * AN-LIVE-R1: the bounded, user-selectable research targets. The UI never
   * infers a selection from recipe order; only these rows may be requested.
   */
  const researchCandidates = useMemo(
    () =>
      researchEligibleRows.map((live) =>
        Object.freeze({
          line_ref: live.line_ref,
          ingredient: live.original_text,
        })
      ),
    [researchEligibleRows]
  );
  /**
   * Identity-ambiguous unresolved lines stay VISIBLE but ineligible. The AI-first
   * review already refused to decide them; research must not bypass that.
   */
  const researchIneligibleRows = useMemo(
    () =>
      liveRows
        .filter(
          (live) =>
            live.status === 'needs_match' &&
            aiReviews[live.line_ref]?.decision === 'needs_review'
        )
        .map((live) =>
          Object.freeze({
            line_ref: live.line_ref,
            ingredient: live.original_text,
            reason: 'identity_ambiguous' as const,
          })
        ),
    [liveRows, aiReviews]
  );
  const researchCandidateRefs = useMemo(
    () => new Set(researchCandidates.map((candidate) => candidate.line_ref)),
    [researchCandidates]
  );
  /**
   * SINC-2: branded lookup is offered for ANY unresolved identity line, including
   * a line the AI-first review marked as identity-ambiguous. The branded product
   * itself is the explicit identity choice, and the representative-brand
   * assumption is disclosed before use. Quantity-missing lines are not listed:
   * they already have a food identity and need a mass, not a product search.
   */
  const brandedEligibleLines = useMemo(
    () =>
      liveRows
        .filter((live) => live.status === 'needs_match')
        .map((live) =>
          Object.freeze({
            line_ref: live.line_ref,
            ingredient: live.original_text,
          })
        ),
    [liveRows]
  );
  const brandedEligibleRefs = useMemo(
    () => new Set(brandedEligibleLines.map((candidate) => candidate.line_ref)),
    [brandedEligibleLines]
  );
  useEffect(() => {
    setBrandedSelectedLineRef((current) => (brandedEligibleRefs.has(current) ? current : ''));
  }, [brandedEligibleRefs]);
  useEffect(() => {
    setBrandedCandidates([]);
    setBrandedSelectedFdcId(null);
    setBrandedRepresentativeAccepted(false);
    setBrandedCacheStatus(null);
    setBrandedRetrievedAt(null);
    setBrandedMessage(null);
  }, [brandedSelectedLineRef]);
  /**
   * Selection is always intersected with the CURRENT eligible set. A fresh
   * analysis, recipe change or newly ambiguous review can never leave a stale
   * ref selected.
   */
  useEffect(() => {
    setResearchSelectedRefs((current) => {
      const next = current.filter((lineRef) => researchCandidateRefs.has(lineRef));
      return next.length === current.length ? current : next;
    });
  }, [researchCandidateRefs]);
  /**
   * The CURRENT live-row status per line, straight from the live projection.
   * This is the authoritative actionability fact the AI-3 estimate port
   * receives; a line absent from this map is never assumed actionable.
   */
  const liveRowStatusByRef = useMemo(() => {
    const map = new Map<string, string>();
    for (const live of liveRows) map.set(live.line_ref, live.status);
    return map;
  }, [liveRows]);

  const actionableByRef = useMemo(() => {
    const map = new Map<string, AiResolutionIssueKind>();
    for (const live of liveRows) {
      const kind = liveExceptionKind(live.status);
      if (kind !== undefined) map.set(live.line_ref, kind);
    }
    return map;
  }, [liveRows]);

  const handleAnalyze = (): RecipeAnalysis | null => {
    if (!session || !adaptation.ok) return null;
    // Always execute a fresh analysis on click. Fall back to an on-demand
    // computation if the memoized analysis is unavailable, so the control can
    // never become a dead button after a saved-state reopen.
    const current =
      analysis ?? analyzeRecipeFromRows(session, adapted, rows, adaptation.recipe.base_servings);
    if (!current) return null;

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
      // A deterministic AI acceptance is automatic, not a user decision.
      // Explicit Use/Confirm actions strip aiAccepted and remain preserved.
      const userDecision =
        choice.aiAccepted !== true && (choice.kind === 'manual' || choice.automatic !== true);
      if (!userDecision) continue;
      matches[row.line_ref] = choice;
      const userMass = state.userMasses[row.line_ref];
      const portion = state.portions[row.line_ref];
      const countPortion = state.countPortions[row.line_ref];
      if (state.aiEstimates?.[row.line_ref]) {
        delete portions[row.line_ref];
        delete countPortions[row.line_ref];
        delete householdPortions[row.line_ref];
        delete userMasses[row.line_ref];
      } else if (userMass) {
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
    if (calculated.ok) preview = state.aiNutrition && state.aiNutrition.recipe_key === state.recipeKey && state.aiNutrition.servings === state.baseServings
      ? combineAiContributionsWithPreview(calculated.preview, state.aiNutrition.contributions, state.aiNutrition.supplements)
      : calculated.preview;

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
    setAiReviews({});
    setResearchRunning(false);
    setResearchMessage(null);
    setResearchOffers([]);
    setResearchContributions([]);
    setResearchSelectedRefs([]);
    setBrandedCandidates([]);
    setBrandedSelectedFdcId(null);
    setBrandedRepresentativeAccepted(false);
    setBrandedCacheStatus(null);
    setBrandedRetrievedAt(null);
    setBrandedMessage(null);
    setAiAmountOffers({});
    setAiEstimateOffers({});
    setAiEstimateOfferBindings({});
    setAiEstimateEvidence({});
    setGenerateAiFeedback(null);
    setAiMessage(null);
    return current;
  };

  const compact = display
    ? (['calories', 'protein', 'carbohydrates', 'fat'] as const).map((id) => {
        const row = display.find((entry) => entry.nutrient === id);
        return row;
      })
    : null;
  /**
   * AN-LIVE-R1: incomplete energy is a SUBTOTAL, never complete recipe calories.
   * The compact review summary and the modal share this one presentation rule.
   */
  const compactEnergy =
    display && preview
      ? deriveEnergyDisplay(
          display.find((entry) => entry.nutrient === 'calories'),
          preview
        )
      : null;

  /**
   * GENERATE NUTRITION — the single recipe-facing entry and an EXPLICIT user
   * action that authorizes the deterministic analysis. It loads the USDA
   * analyzer lazily (viewing a recipe still never loads it), opens the working
   * review, and immediately runs the EXISTING deterministic analyzer. AI is NOT
   * called here: it remains an optional secondary action for rows the
   * deterministic pass cannot resolve. Nothing is written until Apply.
   */
  /** Genuine user closure: cancel all in-flight AI/SHISO/research work. */
  const handleCloseWorkingEditor = useCallback(() => {
    cancelGenerateAiIntent();
    setIsOpen(false);
  }, [cancelGenerateAiIntent]);

  const handleGenerate = () => {
    if (savedBlock) {
      setIsSavedReportOpen(true);
      return;
    }
    if (advancedEditingBasic) return;
    // Bind the DETERMINISTIC analysis intent to the recipe CURRENT at click time;
    // it is consumed only if that same recipe is still current once the editor is
    // ready. This is not an AI intent.
    setGenerateAiFeedback(null);
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
        // A food-identity match (automatic or user) is NOT a mass source and
        // must not evict a verified household portion by itself; only a CHANGED
        // food selection or an actual higher-authority mass choice does.
        const matchChanged =
          next.matches?.[lineRef] !== undefined &&
          next.matches[lineRef] !== base.matches[lineRef];
        const hasHigherSource =
          matchChanged ||
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
          aiEstimates: merged.aiEstimates,
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
    async (
      lineRefs?: ReadonlyArray<string>,
      options?: { readonly orchestration?: 'generate'; readonly aiFirst?: boolean }
    ): Promise<AiResolveUiOutcome> => {
      if (!session || !adaptation.ok) {
        return {
          ok: false,
          resolvedAutomatically: 0,
          stillNeedReview: 0,
          interpretedCount: 0,
          message: 'Advanced Nutrition cannot analyse this recipe yet.',
        };
      }
      // Analyze with SHISO explicitly selects the AI-first port. The manual
      // AI-help action deliberately keeps the conservative legacy port. If the
      // AI-first port fails, this returns its failure visibly: it never silently
      // falls back to a SECOND provider workflow.
      const resolvePort = options?.aiFirst === true ? onResolveWithAiFirst : onResolveWithAi;
      if (!resolvePort) {
        const message = 'AI assistance is unavailable. You can continue with USDA search manually.';
        setAiMessage(message);
        return {
          ok: false,
          resolvedAutomatically: 0,
          stillNeedReview: summarizeLiveRows(liveRowsRef.current).actionable,
          interpretedCount: 0,
          message,
        };
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
        const message = 'No remaining ingredients need AI assistance.';
        setAiMessage(message);
        return {
          ok: true,
          resolvedAutomatically: 0,
          stillNeedReview: summarizeLiveRows(liveRowsRef.current).actionable,
          interpretedCount: 0,
          message,
        };
      }
      const issueKinds: Record<string, AiResolutionIssueKind> = {};
      for (const live of liveRowsRef.current) {
        const kind = liveExceptionKind(live.status);
        if (kind !== undefined) issueKinds[live.line_ref] = kind;
      }
      // SYNCHRONOUS RE-ENTRY GUARD: a rapid double-click must create exactly ONE
      // request (the server rate limiter is only a backstop).
      if (aiRunningRef.current) {
        return {
          ok: false,
          resolvedAutomatically: 0,
          stillNeedReview: summarizeLiveRows(liveRowsRef.current).actionable,
          interpretedCount: 0,
          message: 'AI assistance is already running.',
        };
      }
      aiRunningRef.current = true;
      // ONE cancellation owner for this request. It is aborted by editor close,
      // recipe/session change, bundle failure, unmount, or a newer request.
      aiAbortRef.current?.abort();
      const requestController = new AbortController();
      aiAbortRef.current = requestController;
      // MID-FLIGHT USER-AUTHORITY SNAPSHOT. For EVERY current row, capture the
      // semantic working choice at the instant the request starts. At apply time
      // any row whose choice changed in the meantime is SKIPPED: the user's newer
      // explicit decision is final authority and a stale AI result must never
      // overwrite it. Untouched rows still receive their AI result. The snapshot
      // covers every row (not only the targeted set) because the response merge
      // boundary applies entries per line_ref; a line the user edited — e.g. the
      // user Clear of an existing verified household choice — must remain
      // protected even when it was not part of the request.
      const capturedWorkingChoices = new Map<string, string>();
      for (const row of stateRef.current.rows) {
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
      setAiReviews({});
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
        const result = await resolvePort({
          session,
          rows: targets,
          adapted,
          issueKinds,
          liveRows: liveRowsRef.current,
          state: stateRef.current,
          // Phase 9B-3C: forward the authored recipe so the shell can build the
          // WHOLE-recipe semantic request. The callback closes over the recipe
          // current at CLICK time, and `stillCurrent()` below still discards any
          // response whose recipe/session generation has moved on.
          recipe,
          signal: requestController.signal,
          ...(options?.orchestration !== undefined
            ? { orchestration: options.orchestration }
            : {}),
        });
        // STALE-RESPONSE PROTECTION: a response for a different recipe/session,
        // an older generation, a superseded request, or a closed editor is
        // discarded BEFORE any dispatch/UI mutation.
        if (!stillCurrent()) {
          return {
            ok: false,
            resolvedAutomatically: 0,
            stillNeedReview: summarizeLiveRows(liveRowsRef.current).actionable,
            interpretedCount: 0,
            message: 'AI result was discarded because the review changed.',
          };
        }
        if (!result.ok) {
          const message =
            result.message ?? 'AI assistance is unavailable. You can continue with USDA search manually.';
          setAiMessage(message);
          return {
            ok: false,
            resolvedAutomatically: 0,
            stillNeedReview: summarizeLiveRows(liveRowsRef.current).actionable,
            interpretedCount: 0,
            message,
          };
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
        const conflictedRefs = conflictedWorkingLineRefs(base, capturedWorkingChoices);
        const matches: Record<string, MatchChoice> = { ...base.matches };
        const portions: Record<string, PortionChoice> = { ...base.portions };
        const countPortions: Record<string, CountPortionChoice> = { ...base.countPortions };
        const suggestions: Record<string, AdvancedNutritionAiSuggestion> = {};
        const reviews: Record<string, AdvancedNutritionAiReview> = {};
        const amountOffers: Record<string, ReadonlyArray<AdvancedNutritionAiAmountOffer>> = {};
        for (const review of result.aiFirstReviews ?? []) {
          if (conflictedRefs.has(review.line_ref)) continue;
          reviews[review.line_ref] = review;
        }

        for (const candidate of result.outcome.candidates) {
          if (conflictedRefs.has(candidate.line_ref)) continue;
          if (candidate.auto) {
            // AI-assisted DETERMINISTIC acceptance: automatic authority, never
            // user-confirmed (the choice carries aiAssisted + aiAccepted).
            matches[candidate.line_ref] = Object.freeze({ ...candidate.choice });
            // The application layer may have proved ONE authenticated volume
            // portion with the SAME deterministic rule the analyzer uses. It
            // supplies grams; AI never does.
            if (candidate.portion) {
              portions[candidate.line_ref] = Object.freeze({ ...candidate.portion });
            }
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
        // LOWEST mass authority: the independent merge guard refuses a verified
        // household choice over a mid-flight-conflicted row, a line that already
        // carries one, or a line with any stored higher-authority mass source
        // (including a count portion resolved by THIS response).
        const householdPortions = mergeAiHouseholdPortions({
          base,
          countPortions,
          resolved: result.households?.resolved ?? [],
          conflicted: conflictedRefs,
        });

        setAiSuggestions(suggestions);
        setAiReviews(reviews);
        setAiAmountOffers(amountOffers);
        const applied = applyWorkingSelections({
          matches,
          portions,
          countPortions,
          householdPortions,
        });

        const interpretedCount =
          typeof result.interpretedCount === 'number' && Number.isFinite(result.interpretedCount)
            ? result.interpretedCount
            : interpretedSuggestionCount(result);

        if (!applied.ok || applied.state === undefined) {
          // The merged resolutions could NOT be authenticated against the live
          // state, so NOTHING was applied. Never claim success that did not
          // happen.
          const message =
            `AI interpreted ${interpretedCount} ingredient${interpretedCount === 1 ? '' : 's'}, ` +
            'but the authenticated USDA resolutions could not be applied to the review. ' +
            'No row was changed — continue with USDA search or enter a weight.';
          setAiMessage(message);
          return {
            ok: false,
            resolvedAutomatically: 0,
            stillNeedReview: summarizeLiveRows(liveRowsRef.current).actionable,
            interpretedCount,
            message,
          };
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
        const withheld = result.withheld ?? [];
        const ambiguousCount = withheld.filter((entry) => entry.reason === 'ambiguous').length;
        const alternativeCount = withheld.filter((entry) => entry.reason === 'alternatives').length;
        const contradictedCount = (result.contradicted ?? []).length;
        const inadaptableCount = (result.inadaptable ?? []).length;
        const diagnostics: string[] = [];
        if (ambiguousCount > 0) {
          diagnostics.push(`${ambiguousCount} withheld as ambiguous`);
        }
        if (alternativeCount > 0) {
          diagnostics.push(`${alternativeCount} had explicit alternative readings`);
        }
        if (inadaptableCount > 0) {
          diagnostics.push(`${inadaptableCount} had insufficient semantic information`);
        }
        if (contradictedCount > 0) {
          diagnostics.push(`${contradictedCount} contradicted the authored quantity`);
        }
        const diagnosticSuffix =
          diagnostics.length > 0 ? ` Diagnostics: ${diagnostics.join('; ')}.` : '';
        const remaining = `${stillNeedReview} still need${
          stillNeedReview === 1 ? 's' : ''
        } review.`;
        const message =
          interpretedCount === 0
            ? `AI returned no usable food suggestion.${diagnosticSuffix} ${remaining}`
            : resolvedAutomatically > 0
              ? `AI returned usable search wording for ${interpretedCount} ingredient${
                  interpretedCount === 1 ? '' : 's'
                }. ${resolvedAutomatically} resolved automatically from verified local data. ${remaining}${diagnosticSuffix}`
              : result.outcome.candidates.length === 0
                ? `AI returned usable search wording for ${interpretedCount} ingredient${
                    interpretedCount === 1 ? '' : 's'
                  }. No additional ingredients could be resolved automatically: no authenticated USDA candidate passed validation. ${remaining}${diagnosticSuffix}`
                : `AI returned usable search wording for ${interpretedCount} ingredient${
                    interpretedCount === 1 ? '' : 's'
                  }. No additional ingredients could be resolved automatically. ${remaining}${diagnosticSuffix}`;
        setAiMessage(message);
        return {
          ok: true,
          resolvedAutomatically,
          stillNeedReview,
          interpretedCount,
          message,
        };
      } catch {
        const message = 'AI assistance is unavailable. You can continue with USDA search manually.';
        if (stillCurrent()) setAiMessage(message);
        return {
          ok: false,
          resolvedAutomatically: 0,
          stillNeedReview: summarizeLiveRows(liveRowsRef.current).actionable,
          interpretedCount: 0,
          message,
        };
      } finally {
        if (aiAbortRef.current === requestController) aiAbortRef.current = null;
        if (aiRequestSeq.current === seq) {
          aiRunningRef.current = false;
          setAiRunning(false);
        }
      }
    },
    [session, adaptation, onResolveWithAi, onResolveWithAiFirst, adapted, applyWorkingSelections, analyzedByRef, analysis]
  );

  /**
   * ANALYZE WITH SHISO — the ONE explicit intelligent Advanced Nutrition action.
   *
   * Generate Nutrition is deterministic only. This action is the user's
   * authorization for the existing genuine AI-first whole-recipe workflow
   * (semantic interpretation -> real USDA discovery -> candidate evaluation ->
   * local authentication). It reuses `handleResolveWithAi` with the AI-first port;
   * every result still crosses the same deterministic verification, review and
   * explicit Apply boundaries.
   */
  const handleAnalyzeNutritionWithShiso = useCallback(async () => {
    if (!session || !adaptation.ok) {
      setGenerateAiFeedback({
        kind: 'error',
        message: 'Advanced Nutrition cannot analyse this recipe yet.',
      });
      return;
    }
    if (!advancedEditingEntitled) {
      setGenerateAiFeedback({
        kind: 'unavailable',
        message: 'Advanced Nutrition editing is not enabled for this deployment.',
      });
      return;
    }
    if (onResolveWithAiFirst === undefined || !aiAvailabilityAvailable) {
      if (shisoNutritionRunningRef.current) return;
      shisoNutritionRunningRef.current = true;
      setShisoNutritionState({ kind: 'running', message: 'SHISO is running the authenticated USDA-only review…' });
      const local = handleAnalyze();
      const limitation = aiAvailabilityReason ?? (onResolveWithAiFirst === undefined
        ? 'AI whole-recipe interpretation is not available in this build.'
        : 'The selected AI connection is unavailable.');
      const message = local
        ? `${limitation} SHISO completed the authenticated USDA-only analysis instead. Review the source matches and unresolved lines below; nothing was applied or saved.`
        : `${limitation} The USDA-only analysis could not initialize. Load the authenticated USDA catalog and retry.`;
      setGenerateAiFeedback({ kind: local ? 'partial' : 'error', message });
      setShisoNutritionState({ kind: local ? 'success' : 'error', message });
      if (local && standingNutritionEnabled) setStandingTransactionPending(true);
      shisoNutritionRunningRef.current = false;
      return;
    }
    if (shisoNutritionRunningRef.current) return;
    if (actionableRows.length === 0) {
      const message = 'The deterministic review resolved every ingredient. No AI interpretation was needed.';
      setGenerateAiFeedback({ kind: 'success', message });
      if (standingNutritionEnabled) setStandingTransactionPending(true);
      return;
    }
    shisoNutritionRunningRef.current = true;
    setShisoNutritionState({
      kind: 'running',
      message: 'SHISO is interpreting the whole recipe, finding real USDA candidates, and verifying selections…',
    });
    setGenerateAiFeedback({
      kind: 'running',
      message:
        'AI Advanced Nutrition is interpreting the whole recipe, finding real USDA candidates, and verifying selections…',
    });
    const recipeKey = identityRef.current.recipeKey;
    try {
      const outcome = await handleResolveWithAi(undefined, {
        orchestration: 'generate',
        aiFirst: true,
      });
      if (identityRef.current.recipeKey !== recipeKey || !isOpenRef.current) return;
      setGenerateAiFeedback(
        outcome.ok
          ? {
              kind:
                outcome.interpretedCount === 0
                  ? 'insufficient'
                  : outcome.stillNeedReview > 0
                    ? 'partial'
                    : 'success',
              message: outcome.message,
            }
          : { kind: 'error', message: outcome.message }
      );
      setShisoNutritionState(
        outcome.ok
          ? { kind: 'success', message: `${outcome.message} Review before Apply. Nothing was saved.` }
          : { kind: 'error', message: outcome.message }
      );
      if (outcome.ok && standingNutritionEnabled) setStandingTransactionPending(true);
    } catch {
      if (identityRef.current.recipeKey === recipeKey && isOpenRef.current) {
        setGenerateAiFeedback({
          kind: 'error',
          message:
            'AI assistance failed or timed out. Deterministic partial nutrition remains available.',
        });
        setShisoNutritionState({
          kind: 'error',
          message: 'SHISO could not complete the analysis. Your existing review is unchanged.',
        });
      }
    } finally {
      shisoNutritionRunningRef.current = false;
    }
  }, [
    session,
    adaptation,
    advancedEditingEntitled,
    onResolveWithAiFirst,
    aiAvailabilityAvailable,
    aiAvailabilityReason,
    actionableRows.length,
    handleResolveWithAi,
    handleAnalyze,
    standingNutritionEnabled,
  ]);

  // With standing nutrition authority enabled, the Analyze button owns the
  // complete authorized transaction. This effect waits for the same reducer
  // state and Phase 5 Apply owner used by the visible Apply control to publish
  // after analysis has committed. Equal authored alternatives leave
  // applyEligibility false and stop here, asking for the real user choice.
  useEffect(() => {
    if (!standingTransactionPending || !standingNutritionEnabled) return undefined;
    if (!session || !adaptation.ok || applyEligibility === null) return undefined;
    if (applyEligibility !== true) {
      setStandingTransactionPending(false);
      const message = 'Standing nutrition authority is enabled, but an equal ingredient alternative still needs your choice. Nothing was applied or saved.';
      setShisoNutritionState({ kind: 'error', message });
      setGenerateAiFeedback({ kind: 'partial', message });
      return undefined;
    }
    if (!shiso.canApplyNutritionReview) return undefined;
    const seq = standingTransactionSeq.current + 1;
    standingTransactionSeq.current = seq;
    setStandingTransactionPending(false);
    void (async () => {
      setShisoNutritionState({ kind: 'running', message: 'SHISO is applying the verified review and saving it to the active Vault…' });
      const applied = await shiso.applyNutritionReview();
      if (standingTransactionSeq.current !== seq) return;
      if (!applied.ok || !applied.applied) {
        const message = `Standing nutrition authority could not Apply this review: ${applied.message} Nothing was saved.`;
        setShisoNutritionState({ kind: 'error', message });
        setGenerateAiFeedback({ kind: 'error', message });
        return;
      }
      const recipeIdentity = standingNutritionRecipeIdentity;
      const vaultScope = standingNutritionVaultScope;
      if (recipeIdentity.length === 0 || vaultScope.length === 0) {
        const message = 'The review was applied, but the exact recipe/Vault save binding was unavailable. Nothing was saved.';
        setShisoNutritionState({ kind: 'error', message });
        setGenerateAiFeedback({ kind: 'error', message });
        return;
      }
      const saved = await shiso.saveWorkingRecipe({
        via: 'standing_nutrition',
        recipe_identity: recipeIdentity,
        vault_scope: vaultScope,
        nutrition_applied: true,
      });
      if (standingTransactionSeq.current !== seq) return;
      const message = saved.ok && saved.saved
        ? `SHISO applied the verified nutrition review and saved it to the active Vault. ${saved.message}`
        : `SHISO applied the verified nutrition review, but it was not saved: ${saved.message}`;
      setShisoNutritionState({ kind: saved.ok && saved.saved ? 'success' : 'error', message });
      setGenerateAiFeedback({ kind: saved.ok && saved.saved ? 'success' : 'error', message });
    })().catch(() => {
      if (standingTransactionSeq.current !== seq) return;
      const message = 'SHISO applied no persistent nutrition change because the authorized save failed. Nothing was saved.';
      setShisoNutritionState({ kind: 'error', message });
      setGenerateAiFeedback({ kind: 'error', message });
    });
    return undefined;
  }, [adaptation, applyEligibility, session, shiso, standingNutritionEnabled, standingNutritionRecipeIdentity, standingNutritionVaultScope, standingTransactionPending]);

  /**
   * AN-WEB-1 — explicit external research for locally unresolved, non-ambiguous
   * lines. Research never decides a salted/unsalted/brand ambiguity: only
   * `no_match` explanations are eligible. The returned contributions are OFFERS;
   * the user must click Use before they enter working state.
   */
  /** Explicit checkbox toggle for ONE eligible unresolved line. */
  const handleToggleResearchSelection = useCallback(
    (lineRef: string) => {
      if (researchRunning) return;
      if (researchSelectedRefs.includes(lineRef)) {
        setResearchSelectedRefs((current) => current.filter((ref) => ref !== lineRef));
        return;
      }
      if (!researchCandidateRefs.has(lineRef)) return;
      if (researchSelectedRefs.length >= MAX_RESEARCH_TARGETS) {
        setResearchMessage(
          `You can research at most ${MAX_RESEARCH_TARGETS} ingredients at a time. Clear one to choose another.`
        );
        return;
      }
      setResearchSelectedRefs((current) => Object.freeze([...current, lineRef]));
    },
    [researchRunning, researchSelectedRefs, researchCandidateRefs]
  );

  const handleResearchWithAi = useCallback(async () => {
    if (!session || !adaptation.ok || !onResearchNutritionWithAi) {
      setResearchMessage('External nutrition research is unavailable. Use USDA search or manual review.');
      return;
    }
    if (researchRunning) return;
    // EXACT SELECTION ONLY. Never fall back to every eligible row, never use
    // recipe order, and never include a line the user did not check.
    const selected = researchSelectedRefs.filter((lineRef) => researchCandidateRefs.has(lineRef));
    const targets: ResearchTarget[] = [];
    for (const lineRef of selected) {
      const row = stateRef.current.rows.find((entry) => entry.line_ref === lineRef);
      const entry = adapted.find((item) => item.line_ref === lineRef);
      if (!row || !entry) continue;
      const measurement = ingredientMeasurement(entry);
      targets.push(Object.freeze({
        line_ref: lineRef,
        ingredient_text: entry.ingredient.original,
        amount: measurement.amount,
        unit: measurement.raw_unit ?? null,
        measurement_kind: measurement.measurement_kind,
        ...(measurement.grams !== undefined ? { quantity_grams: measurement.grams } : {}),
        ...(measurement.milliliters !== undefined ? { quantity_ml: measurement.milliliters } : {}),
        ambiguity: 'missing_information',
      }));
    }
    if (targets.length === 0) {
      setResearchMessage('Select one to three eligible unresolved ingredients before researching.');
      return;
    }
    researchAbortRef.current?.abort();
    const controller = new AbortController();
    const requestSeq = ++researchRequestSeq.current;
    researchAbortRef.current = controller;
    setResearchRunning(true);
    setResearchMessage(
      `Researching credible external nutrition sources for ${targets.length} selected ingredient${targets.length === 1 ? '' : 's'}…`
    );
    setResearchOffers([]);
    setResearchContributions([]);
    try {
      const result = await onResearchNutritionWithAi({
        targets,
        lineRefs: targets.map((target) => target.line_ref),
        lineTextByRef: Object.fromEntries(targets.map((target) => [target.line_ref, target.ingredient_text])),
        signal: controller.signal,
      });
      if (controller.signal.aborted || requestSeq !== researchRequestSeq.current) return;
      if (result.ok) {
        setResearchOffers(result.offers ?? []);
        setResearchContributions(result.contributions ?? []);
        setResearchMessage(result.message ?? 'External nutrition evidence is ready for review.');
      } else {
        setResearchMessage(result.message ?? 'No reliable external nutrition evidence was found.');
      }
    } catch {
      if (!controller.signal.aborted && requestSeq === researchRequestSeq.current) {
        setResearchMessage('External nutrition research failed. Use USDA search or manual review.');
      }
    } finally {
      if (researchAbortRef.current === controller) researchAbortRef.current = null;
      if (requestSeq === researchRequestSeq.current) setResearchRunning(false);
    }
  }, [
    session,
    adaptation,
    onResearchNutritionWithAi,
    researchRunning,
    researchSelectedRefs,
    researchCandidateRefs,
    adapted,
  ]);

  /**
   * Explicit user acceptance of researched contributions. Existing AI-nutrition
   * state, preview combination, Apply, Save and reopen remain the only authority.
   */
  const handleUseResearch = useCallback(() => {
    if (!session || !adaptation.ok || researchContributions.length === 0) return;
    const current = stateRef.current;
    if (current.recipeKey === null) return;
    if (researchContributions.some((entry) => !current.rows.some((row) => row.line_ref === entry.line_ref))) {
      setResearchMessage('Researched nutrition no longer matches this review. Run research again.');
      return;
    }
    const calculated = session.calculate(buildCalculationRequest(adapted, current));
    if (!calculated.ok) {
      setResearchMessage('Researched nutrition could not be combined with the current review.');
      return;
    }
    const combined = combineAiContributionsWithPreview(calculated.preview, researchContributions, state.aiNutrition?.supplements);
    workingDispatch({
      type: 'accept_ai_nutrition',
      recipeKey: current.recipeKey,
      servings: current.baseServings,
      contributions: researchContributions,
    });
    dispatch({
      type: 'preview_succeeded',
      seq: current.operationSeq,
      recipeKey: current.recipeKey,
      preview: combined,
    });
    setAiReviews((current) => {
      const next = { ...current };
      for (const contribution of researchContributions) delete next[contribution.line_ref];
      return next;
    });
    setResearchOffers([]);
    setResearchContributions([]);
    setResearchSelectedRefs([]);
    setResearchMessage('Researched nutrition was added to the working review. Apply to keep it.');
  }, [session, adaptation, researchContributions, workingDispatch]);

  /** Builds the exact local target for one selected branded lookup line. */
  const buildBrandedTarget = useCallback((): BrandedLookupTarget | null => {
    if (!session || !adaptation.ok || !brandedSelectedLineRef) return null;
    const row = stateRef.current.rows.find((entry) => entry.line_ref === brandedSelectedLineRef);
    const entry = adapted.find((item) => item.line_ref === brandedSelectedLineRef);
    if (!row || !entry) return null;
    const measurement = ingredientMeasurement(entry);
    return Object.freeze({
      line_ref: brandedSelectedLineRef,
      ingredient_text: entry.ingredient.original,
      query: row.query,
      amount: measurement.amount,
      unit: measurement.raw_unit ?? null,
      measurement_kind: measurement.measurement_kind,
      ...(measurement.grams !== undefined ? { quantity_grams: measurement.grams } : {}),
      ...(measurement.milliliters !== undefined ? { quantity_ml: measurement.milliliters } : {}),
    });
  }, [session, adaptation, brandedSelectedLineRef, adapted]);

  /**
   * SINC-2: one explicit branded lookup. Only the selected food term leaves the
   * browser. No recipe, quantity, Vault content, or personal data is sent to
   * USDA. Nothing is applied here.
   */
  const handleSearchBrandedFoods = useCallback(async () => {
    if (!session || !adaptation.ok || !onSearchBrandedFoods) {
      setBrandedMessage('USDA Branded Foods lookup is unavailable in this deployment.');
      return;
    }
    if (brandedRunning) return;
    const target = buildBrandedTarget();
    if (!target || target.query.trim().length < 2) {
      setBrandedMessage('Choose one unresolved ingredient with a usable food name before searching.');
      return;
    }
    brandedAbortRef.current?.abort();
    const controller = new AbortController();
    const requestSeq = ++brandedRequestSeq.current;
    brandedAbortRef.current = controller;
    setBrandedRunning(true);
    setBrandedCandidates([]);
    setBrandedSelectedFdcId(null);
    setBrandedRepresentativeAccepted(false);
    setBrandedCacheStatus(null);
    setBrandedRetrievedAt(null);
    setBrandedMessage(`Searching USDA Branded Foods for “${target.query}”…`);
    try {
      const result = await onSearchBrandedFoods({
        lineRef: target.line_ref,
        query: target.query,
        signal: controller.signal,
      });
      if (controller.signal.aborted || requestSeq !== brandedRequestSeq.current) return;
      if (result.ok) {
        const candidates = result.candidates ?? [];
        setBrandedCandidates(candidates);
        setBrandedCacheStatus(result.cacheStatus ?? null);
        setBrandedRetrievedAt(result.retrievedAt ?? null);
        setBrandedMessage(
          result.message ??
            (candidates.length > 0
              ? `${candidates.length} USDA Branded Foods candidate${candidates.length === 1 ? '' : 's'} ready for review. Nothing is selected or applied automatically.`
              : 'No suitable USDA Branded Foods records were found. The ingredient remains unresolved.')
        );
      } else {
        setBrandedCandidates([]);
        setBrandedSelectedFdcId(null);
        setBrandedMessage(
          result.message ??
            'USDA Branded Foods lookup failed. The ingredient remains unresolved.'
        );
      }
    } catch {
      if (!controller.signal.aborted && requestSeq === brandedRequestSeq.current) {
        setBrandedMessage('USDA Branded Foods lookup failed. The ingredient remains unresolved.');
      }
    } finally {
      if (brandedAbortRef.current === controller) brandedAbortRef.current = null;
      if (requestSeq === brandedRequestSeq.current) setBrandedRunning(false);
    }
  }, [session, adaptation, onSearchBrandedFoods, brandedRunning, buildBrandedTarget]);

  /**
   * Explicit user acceptance of ONE selected branded candidate. The existing
   * preview combination, Apply, Save and reopen remain the only authority.
   */
  const handleUseBrandedFood = useCallback(() => {
    if (!session || !adaptation.ok || brandedSelectedFdcId === null) return;
    const current = stateRef.current;
    if (current.recipeKey === null) return;
    const target = buildBrandedTarget();
    if (!target) {
      setBrandedMessage('The selected ingredient no longer matches this review. Search again.');
      return;
    }
    const candidate = brandedCandidates.find((entry) => entry.fdc_id === brandedSelectedFdcId);
    if (!candidate) {
      setBrandedMessage('The selected USDA Branded Foods product is no longer available. Search again.');
      return;
    }
    if (!candidate.usable) {
      setBrandedMessage('This product does not publish a usable serving weight or volume, so its nutrition cannot be applied.');
      return;
    }
    const brandMatch = brandedBrandAppearsInIngredient(candidate, target.ingredient_text);
    if (!brandMatch && !brandedRepresentativeAccepted) {
      setBrandedMessage('Confirm that this product is a representative estimate before using it.');
      return;
    }
    const built = buildBrandedContribution(candidate, target);
    if (!built.ok) {
      const reason = (built as { reason?: string }).reason;
      setBrandedMessage(
        reason === 'missing_serving_basis'
          ? 'This product does not publish a usable serving weight or volume.'
          : reason === 'mass_required'
            ? 'A verified gram weight is required for this product; the recipe line does not provide one.'
            : reason === 'volume_required'
              ? 'A verified volume is required for this product; the recipe line does not provide one.'
              : 'This product nutrition could not be scaled safely. The ingredient remains unresolved.'
      );
      return;
    }
    const calculated = session.calculate(buildCalculationRequest(adapted, current));
    if (!calculated.ok) {
      setBrandedMessage('USDA Branded nutrition could not be combined with the current review.');
      return;
    }
    const combined = combineAiContributionsWithPreview(calculated.preview, [built.contribution], state.aiNutrition?.supplements);
    workingDispatch({
      type: 'accept_ai_nutrition',
      recipeKey: current.recipeKey,
      servings: current.baseServings,
      contributions: [built.contribution],
    });
    dispatch({
      type: 'preview_succeeded',
      seq: current.operationSeq,
      recipeKey: current.recipeKey,
      preview: combined,
    });
    setAiReviews((currentReviews) => {
      const next = { ...currentReviews };
      delete next[built.contribution.line_ref];
      return next;
    });
    setBrandedCandidates([]);
    setBrandedSelectedFdcId(null);
    setBrandedRepresentativeAccepted(false);
    setBrandedCacheStatus(null);
    setBrandedRetrievedAt(null);
    setBrandedMessage('USDA Branded nutrition was added to the working review. Apply to keep it.');
  }, [
    session,
    adaptation,
    brandedSelectedFdcId,
    brandedCandidates,
    brandedRepresentativeAccepted,
    buildBrandedTarget,
    workingDispatch,
  ]);

  /**
   * AI CANDIDATE PLAN (AI-2C) — optional, explicit, SECONDARY. Asks the shell for
   * ONE deterministic candidate plan over the current actionable exceptions, then
   * applies ONLY what the deterministic authority already confirmed:
   *   - accepted lines flow through the SAME `applyWorkingSelections` merge the
   *     row-level actions use (the reducer clears that line's mass sources, which
   *     is exactly why AI-2C never accepts over an existing user mass decision —
   *     the shell's reconciliation refuses those lines before they reach here);
   *   - offers are surfaced for explicit user confirmation and are NEVER
   *     preselected or applied;
   *   - review/abstention stays review.
   * No Apply, no persistence, no automatic retry: one deliberate user click.
   */
  const handlePlanWithAi = useCallback(async () => {
    if (!session || !adaptation.ok) return;
    if (!onPlanWithAi) {
      setAiMessage('AI assistance is unavailable. You can continue with USDA search manually.');
      return;
    }
    if (aiRunningRef.current) return;
    aiRunningRef.current = true;

    const eligible = actionableExceptionRows(stateRef.current.rows, liveRowsRef.current);
    if (eligible.length === 0) {
      aiRunningRef.current = false;
      setAiMessage('No remaining ingredients need AI assistance.');
      return;
    }
    const issueKinds: Record<string, AiResolutionIssueKind> = {};
    for (const live of liveRowsRef.current) {
      const kind = liveExceptionKind(live.status);
      if (kind !== undefined) issueKinds[live.line_ref] = kind;
    }
    // MID-FLIGHT SNAPSHOT (same discipline as the AI-1 flow): every row's working
    // choice at request start, so a user edit during the flight wins.
    const capturedWorkingChoices = new Map<string, string>();
    const capturedFingerprints: Record<string, string> = {};
    for (const row of stateRef.current.rows) {
      const fingerprint = workingChoiceFingerprint(stateRef.current, row.line_ref);
      capturedWorkingChoices.set(row.line_ref, fingerprint);
      capturedFingerprints[row.line_ref] = fingerprint;
    }
    const capturedRecipeKey = identityRef.current.recipeKey;
    const capturedSessionIdentity = identityRef.current.sessionIdentity;
    const capturedGeneration = aiGeneration.current;
    const seq = aiRequestSeq.current + 1;
    aiRequestSeq.current = seq;
    // DETERMINISTIC request identity: a monotonic counter, never a clock.
    const requestId = `plan-${capturedSessionIdentity.slice(0, 12)}-${seq}`.slice(0, 120);
    setAiRunning(true);
    setAiMessage(null);
    const stillCurrent = (): boolean => {
      if (aiRequestSeq.current !== seq) return false;
      if (aiGeneration.current !== capturedGeneration) return false;
      const current = identityRef.current;
      if (current.recipeKey !== capturedRecipeKey) return false;
      if (current.sessionIdentity !== capturedSessionIdentity) return false;
      return isOpenRef.current === true;
    };
    try {
      const result = await onPlanWithAi({
        session,
        rows: eligible,
        adapted,
        issueKinds,
        liveRows: liveRowsRef.current,
        state: stateRef.current,
        requestId,
        capturedFingerprints,
      });
      if (!stillCurrent()) return;
      if (!result.ok) {
        setAiMessage(
          result.message ?? 'AI planning is unavailable. You can continue with USDA search manually.'
        );
        return;
      }
      const base = stateRef.current;
      const conflictedRefs = conflictedWorkingLineRefs(base, capturedWorkingChoices);
      const matches: Record<string, MatchChoice> = { ...base.matches };
      const suggestions: Record<string, AdvancedNutritionAiSuggestion> = { ...aiSuggestions };
      let appliedCount = 0;
      for (const entry of result.accepted) {
        if (conflictedRefs.has(entry.line_ref)) continue;
        matches[entry.line_ref] = entry.choice as MatchChoice;
        appliedCount += 1;
      }
      // OFFERS ARE NOT PRESELECTED: they populate the SAME suggestion surface the
      // AI-1 flow uses, and only an explicit "Use this match" confirms them.
      for (const offer of result.offers) {
        if (conflictedRefs.has(offer.line_ref)) continue;
        suggestions[offer.line_ref] = {
          line_ref: offer.line_ref,
          fdc_id: offer.fdc_id,
          description: offer.description ?? '',
          auto: false,
          choice: offer.choice as MatchChoice,
        } as AdvancedNutritionAiSuggestion;
      }
      setAiSuggestions(suggestions);
      const applied =
        appliedCount > 0 ? applyWorkingSelections({ matches }) : { ok: true } as WorkingApplyResult;
      if (!applied.ok) {
        setAiMessage(
          'The planned selections could not be verified against the current review. Nothing was applied.'
        );
        return;
      }
      const conflicts = result.conflictCount + conflictedRefs.size;
      setAiMessage(
        `AI planned candidates. ${appliedCount} accepted from verified local data, ` +
          `${result.offerCount} offered for your review, ${result.preservedCount} still need review, ` +
          `${conflicts} left untouched (your decision).`
      );
    } catch {
      if (stillCurrent()) {
        setAiMessage('AI planning is unavailable. You can continue with USDA search manually.');
      }
    } finally {
      if (aiRequestSeq.current === seq) {
        aiRunningRef.current = false;
        setAiRunning(false);
      }
    }
  }, [session, adaptation, onPlanWithAi, adapted, applyWorkingSelections, aiSuggestions]);


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

  /**
   * FIRST EXPLICIT CLICK: ask the injected port for estimate OFFERS.
   *
   * This is the ONLY caller of the port. Nothing here writes working state,
   * the calculator, or the preview. There is no render-time call, no
   * re-analysis call, and no automatic retry: a failed call reports a message
   * and stops.
   */
  const handleEstimateMassesWithAi = async (): Promise<void> => {
    if (!onEstimateMassesWithAi) return;
    if (aiEstimateRunning) return;
    if (!session || !adaptation.ok) return;
    setAiEstimateRunning(true);
    setAiEstimateMessage(null);
    try {
      const result = await onEstimateMassesWithAi({
        state,
        lines: adaptation.recipe.adapted.map((ingredient) => ({
          line_ref: ingredient.line_ref,
          original_text: ingredient.ingredient.original,
          // The AUTHORITATIVE current live-row status from the SAME live
          // projection the UI already uses for its exception count. Never a
          // hardcoded assumption that a line is actionable.
          outcome: liveRowStatusByRef.get(ingredient.line_ref) ?? 'unknown',
        })),
        servings: adaptation.recipe.base_servings,
        request_token: `estimate:${aiGeneration.current}`,
      });
      if (result.ok !== true) {
        setAiEstimateMessage('AI estimate unavailable.');
        return;
      }
      // Offers only. No dispatch, no selection, no state change.
      const nextOffers: Record<string, Readonly<AiEstimateOffer>> = {};
      const nextEvidence: Record<string, AiEstimateSelectionEvidence> = {};
      const nextBindings: Record<string, { readonly fingerprint: string; readonly snapshot_binding: string }> = {};
      for (const offer of result.offers) {
        nextOffers[offer.line_ref] = Object.freeze({ ...offer, label: AI_ESTIMATE_OFFER_LABEL } as AiEstimateOffer);
        if (offer.evidence !== undefined) nextEvidence[offer.line_ref] = offer.evidence;
        nextBindings[offer.line_ref] = Object.freeze({
          fingerprint: workingChoiceFingerprint(state, offer.line_ref),
          snapshot_binding: aiEstimateSnapshotBinding(
            buildAiEstimateUiSnapshot(offer.line_ref, analyzedByRef.get(offer.line_ref), state.matches[offer.line_ref])
          ),
        });
      }
      setAiEstimateOffers(nextOffers);
      setAiEstimateOfferBindings(nextBindings);
      setAiEstimateEvidence(nextEvidence);
      const refused = result.refused.length;
      setAiEstimateMessage(
        result.message ?? (result.offers.length === 0
          ? `No lines are eligible for an AI estimate${refused > 0 ? ` (${refused} refused)` : ''}.`
          : `${result.offers.length} AI estimate offer${result.offers.length === 1 ? '' : 's'}${
              refused > 0 ? `, ${refused} refused` : ''
            }. Nothing is used until you choose one.`
        )
      );
    } catch {
      // No automatic retry. The user can press the button again explicitly.
      setAiEstimateMessage('AI estimate failed.');
    } finally {
      setAiEstimateRunning(false);
    }
  };

  /**
   * SECOND EXPLICIT CLICK: accept one offer.
   *
   * Every staleness/currentness/authority re-check lives in the pure
   * `acceptAiEstimateOffer`. If it refuses, working state is NOT touched. If it
   * passes, the existing AI-estimate selection action is dispatched -- this
   * path does not invent a parallel state mutation.
   */
  const handleUseAiEstimateOffer = (lineRef: string): void => {
    const offer = aiEstimateOffers[lineRef];
    const binding = aiEstimateOfferBindings[lineRef];
    if (!offer || !binding) return;
    const match = state.matches[lineRef];
    const analyzedRow = analyzedByRef.get(lineRef);
    const snapshot = buildAiEstimateUiSnapshot(lineRef, analyzedRow, match);
    const accepted = acceptAiEstimateOffer(offer, {
      currentState: state,
      offerFingerprint: binding.fingerprint,
      offerSnapshotBinding: binding.snapshot_binding,
      evidence: aiEstimateEvidence[lineRef],
      snapshot,
    });
    if (accepted.ok !== true) {
      // Stale: drop the offer and leave working state untouched.
      setAiEstimateOffers((prev) => {
        const next = { ...prev };
        delete next[lineRef];
        return next;
      });
      setAiEstimateMessage('That estimate is out of date and was not used.');
      return;
    }
    // The EXISTING Phase-4 selection action. AI-3 does not invent a parallel
    // mutation path: the reducer remains the single authority for what enters
    // working state, including its own refusals.
    dispatch({ type: 'select_ai_estimate', lineRef, choice: accepted.choice });
    setWorkingTouched(true);
    setAiEstimateOffers((prev) => {
      const next = { ...prev };
      delete next[lineRef];
      return next;
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

  /**
   * AI-5C: the shell's already-decided effective availability and bounded reason.
   *
   * Absent (an embedder that supplies no AI-5C state) keeps the pre-AI-5C behaviour
   * of an available surface with no reason copy.
   */
  // AI-5D: a refresh in flight always disables the AI layer, even before the shell's
  // published `available` flips, so no control can be clicked mid-reconciliation.
  // Basic product: never mount or leave the Advanced working workspace open.
  // The compact Basic Nutrition card remains available; this is the separate
  // paid editing surface.
  useEffect(() => {
    if (!advancedEditingBasic) return;
    pendingOpenRecipeKey.current = null;
    setPendingGenerateRecipeKey(null);
    setGenerateAiFeedback(null);
    if (isOpenRef.current) {
      cancelGenerateAiIntent();
      setIsOpen(false);
    }
  }, [advancedEditingBasic, cancelGenerateAiIntent]);

  /**
   * The AI-4D2 review view model: a pure projection of the inert review session.
   * It exists only to render; every decision it exposes is the user's own, and
   * nothing in it can change nutrition state.
   */
  const recipeContextUi: AdvancedNutritionRecipeContextUi | undefined = onReviewRecipeContextWithAi
    ? (() => {
        const session = recipeContextSession;
        // The captured identity anchor, never session-derived values. With no anchor
        // there is no authenticated review operation, so the surface renders nothing.
        const expectedIdentity = recipeContextExpectedIdentity.current;
        if (session === null || expectedIdentity === null) {
          return {
            available: aiAvailabilityAvailable,
            unavailableReason: aiAvailabilityReason,
            refreshing: aiRefreshing,
            canRetry: aiCanRetry,
            ...(aiOnRetry !== undefined ? { onRetry: aiOnRetry } : {}),
            running: recipeContextRunning,
            message: recipeContextMessage,
            rows: [],
            pending_count: 0,
            accepted_count: 0,
            dismissed_count: 0,
            abstained_count: 0,
            uninterpreted_count: 0,
            reviewStarted: recipeContextStarted,
            onReview: () => {
              void handleReviewRecipeContext();
            },
            onAccept: handleAcceptRecipeContextRow,
            onDismiss: handleDismissRecipeContextRow,
            onUndo: handleUndoRecipeContextRow,
            onClearReview: clearRecipeContextReview,
          };
        }
        const view = recipeContextReviewView(session, expectedIdentity);
        // A review that is no longer current renders as no review at all.
        if (!view.ok) {
          return {
            available: aiAvailabilityAvailable,
            unavailableReason: aiAvailabilityReason,
            refreshing: aiRefreshing,
            canRetry: aiCanRetry,
            ...(aiOnRetry !== undefined ? { onRetry: aiOnRetry } : {}),
            running: recipeContextRunning,
            message: recipeContextMessage,
            rows: [],
            pending_count: 0,
            accepted_count: 0,
            dismissed_count: 0,
            abstained_count: 0,
            uninterpreted_count: 0,
            reviewStarted: recipeContextStarted,
            onReview: () => {
              void handleReviewRecipeContext();
            },
            onAccept: handleAcceptRecipeContextRow,
            onDismiss: handleDismissRecipeContextRow,
            onUndo: handleUndoRecipeContextRow,
            onClearReview: clearRecipeContextReview,
          };
        }
        return {
          available: aiAvailabilityAvailable,
          unavailableReason: aiAvailabilityReason,
          refreshing: aiRefreshing,
          canRetry: aiCanRetry,
          ...(aiOnRetry !== undefined ? { onRetry: aiOnRetry } : {}),
          running: recipeContextRunning,
          message: recipeContextMessage,
          rows: view.view.rows,
          pending_count: view.view.pending_count,
          accepted_count: view.view.accepted_count,
          dismissed_count: view.view.dismissed_count,
          abstained_count: view.view.abstained_count,
          uninterpreted_count: view.view.uninterpreted_count,
          reviewStarted: recipeContextStarted,
          onReview: () => {
            void handleReviewRecipeContext();
          },
          onAccept: handleAcceptRecipeContextRow,
          onDismiss: handleDismissRecipeContextRow,
          onUndo: handleUndoRecipeContextRow,
          onClearReview: clearRecipeContextReview,
        };
      })()
    : undefined;

  const brandedUi: AdvancedNutritionBrandedUi | undefined =
    onSearchBrandedFoods !== undefined && brandedEligibleLines.length > 0
      ? {
          available: Boolean(session && adaptation.ok),
          running: brandedRunning,
          message: brandedMessage,
          lines: brandedEligibleLines,
          selectedLineRef: brandedSelectedLineRef.length > 0 ? brandedSelectedLineRef : null,
          candidates: brandedCandidates,
          selectedFdcId: brandedSelectedFdcId,
          representativeAccepted: brandedRepresentativeAccepted,
          cacheStatus: brandedCacheStatus,
          retrievedAt: brandedRetrievedAt,
          onSelectLine: (lineRef: string) => {
            setBrandedSelectedLineRef(lineRef);
          },
          onSearch: () => {
            void handleSearchBrandedFoods();
          },
          onSelectCandidate: (fdcId: number) => {
            setBrandedSelectedFdcId(fdcId);
            setBrandedRepresentativeAccepted(false);
          },
          onAcceptRepresentative: (accepted: boolean) => {
            setBrandedRepresentativeAccepted(accepted);
          },
          onUse: handleUseBrandedFood,
        }
      : undefined;

  const aiUi: AdvancedNutritionAiUi | undefined =
    session && adaptation.ok && onResolveWithAi
      ? {
          available: aiAvailabilityAvailable,
          unavailableReason: aiAvailabilityReason,
          refreshing: aiRefreshing,
          canRetry: aiCanRetry,
          ...(aiOnRetry !== undefined ? { onRetry: aiOnRetry } : {}),
          running: aiRunning,
          message: aiMessage,
          suggestions: aiSuggestions,
          reviews: aiReviews,
          onClearReview: (lineRef: string) => {
            setAiReviews((current) => {
              if (!(lineRef in current)) return current;
              const next = { ...current };
              delete next[lineRef];
              return next;
            });
          },
          researchAvailable:
            onResearchNutritionWithAi !== undefined &&
            (researchCandidates.length > 0 || researchIneligibleRows.length > 0),
          researchRunning,
          researchMessage,
          researchOffers,
          researchCandidates,
          researchSelectedRefs,
          researchIneligible: researchIneligibleRows,
          onToggleResearchSelection: handleToggleResearchSelection,
          researchLimit: MAX_RESEARCH_TARGETS,
          onResearch: () => {
            void handleResearchWithAi();
          },
          onUseResearch: handleUseResearch,
          ...(brandedUi !== undefined ? { brandedLookup: brandedUi } : {}),
          amountOffers: aiAmountOffers,
          // AI-3 estimate offers. INERT until the second explicit click.
          ...(onEstimateMassesWithAi
            ? {
                estimateOffers: aiEstimateOffers,
                estimateRunning: aiEstimateRunning,
                estimateMessage: aiEstimateMessage,
                onEstimateMassesWithAi: () => {
                  void handleEstimateMassesWithAi();
                },
                onUseEstimateOffer: handleUseAiEstimateOffer,
              }
            : {}),
          exceptionCount: actionableRows.length,
          // AI-2C candidate planning lives in the SAME panel (no parallel review
          // subsystem): same explicit user invocation, same request token, same
          // suggestion surface for offers.
          ...(onPlanWithAi
            ? {
                planAvailable: true,
                planRunning: aiRunning,
                onPlan: () => {
                  void handlePlanWithAi();
                },
              }
            : {}),
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
      className="rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-5 text-[var(--text-primary,#F3F4F6)] shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)]">
            <FlaskConical className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">
              Reviewed source analysis
            </p>
            <h3 className="flex flex-wrap items-baseline gap-x-2 font-serif text-[19px] leading-snug text-[var(--text-primary,#F3F4F6)]">
              <span>Advanced Nutrition</span>
              <span className="font-mono text-[11px] font-normal uppercase tracking-wide text-[var(--text-secondary,#9CA3AF)]">Advisory</span>
            </h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
              {savedBlock ? 'Reviewed USDA source matching · saved result' : 'Reviewed USDA source matching · advisory analysis'}
            </p>
          </div>
        </div>

        {(() => {
          // Existing authoritative evidence only: saved schema-5 AI
          // contributions and schema-4 accepted quantity estimates. No nutrient
          // numbers are inspected and no new status authority is introduced.
          const hasAiEstimate =
            ((savedBlock?.schema === 5 || savedBlock?.schema === 6) &&
              (savedBlock.ai_contributions ?? []).some(
                (entry) => entry.classification === 'ai_estimate' && entry.disposition !== 'excluded'
              )) ||
            (savedBlock?.schema === 6 && (savedBlock.nutrient_supplements?.length ?? 0) > 0) ||
            (savedBlock?.schema === 4 &&
              savedBlock.ingredients.some((entry) => entry.quantity_estimate !== undefined));
          const isPartial =
            savedPresentation.advanced_unresolved_count > 0 || !savedDisplayComplete;
          const label = advancedNutritionStatusLabel({
            hasSavedBlock: savedBlock !== undefined,
            nutritionUnsaved,
            stale: savedPresentation.advanced_stale,
            partial: isPartial,
            hasAiEstimate,
          });
          return (
            <span
              data-testid="advanced-nutrition-status-chip"
              className="max-w-full shrink-0 whitespace-normal rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary,#9CA3AF)]"
            >
              {label}
            </span>
          );
        })()}
      </div>

      {savedSupplementVerification !== undefined && savedSupplementVerification !== 'verified' && (
        <div
          data-testid="advanced-saved-supplement-verification-required"
          role="status"
          className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] p-3 text-[12px] leading-relaxed text-[var(--text-primary,#F3F4F6)]"
        >
          <p className="font-semibold">Supplemental estimates need verification</p>
          <p className="mt-1 text-[var(--text-secondary,#9CA3AF)]">
            {savedSupplementVerification === 'partial'
              ? 'Some saved AI supplements could not be verified against the pinned USDA source and are quarantined. Verified values remain active; review the saved report before using the totals.'
              : 'Saved AI supplements are preserved for recovery but are not active until Advanced Nutrition verifies them against the pinned USDA source.'}
          </p>
        </div>
      )}

      {!session && !onLoadBundle && (
        <div className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-dashed border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-2">
          {savedBlock ? (
            <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]" data-testid="advanced-saved-readonly-note">
              Saved Advanced Nutrition is available to view. Editing requires the USDA review tools,
              which are unavailable in this build.
            </p>
          ) : (
            <p className="text-[14px] text-[var(--text-secondary,#9CA3AF)]">{PHASE4_UNAVAILABLE_MESSAGE}</p>
          )}
          <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)] flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            <span>This is not an error in the recipe.</span>
          </p>
          {advancedEditingBasic && !savedBlock ? (
            <p
              data-testid="advanced-nutrition-basic-locked"
              className="text-[13px] leading-relaxed text-[var(--text-primary,#F3F4F6)]"
            >
              Advanced Nutrition editing is not enabled for this deployment. Basic Nutrition remains
              available in Nutrition &amp; Macros.
            </p>
          ) : (
            <button
              type="button"
              data-testid="advanced-nutrition-open"
              onClick={handleOpenRequest}
              disabled={!savedBlock}
              aria-disabled={!savedBlock}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-medium border transition-colors ${
                savedBlock
                  ? 'text-[var(--text-primary,#F3F4F6)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border-[var(--border-subtle,rgba(255,255,255,0.08))]'
                  : 'text-[var(--text-secondary,#9CA3AF)] bg-[var(--bg-elevated,#1E1E1E)] border-[var(--border-subtle,rgba(255,255,255,0.08))] cursor-not-allowed'
              }`}
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>{savedBlock ? (nutritionUnsaved ? 'Open Working Advanced Report' : 'Open Saved Advanced Report') : 'Generate Nutrition'}</span>
            </button>
          )}
        </div>
      )}

      {!session && onLoadBundle && (
        <div className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-dashed border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-2">
          {bundleStatus === 'loading' ||
          bundleStatus === 'failed' ||
          bundleStatus === 'unsupported' ||
          (stored.kind !== 'v1' && stored.kind !== 'v2' && (stored.kind !== 'v3' && stored.kind !== 'v4' && stored.kind !== 'v5' && stored.kind !== 'v6')) ? (
            <p className="text-[14px] text-[var(--text-secondary,#9CA3AF)]" role="status" aria-live="polite">
              {bundleStatus === 'loading'
                ? PHASE4_LOADING_MESSAGE
                : bundleStatus === 'failed'
                  ? PHASE4_BUNDLE_FAILED_MESSAGE
                  : bundleStatus === 'unsupported'
                    ? PHASE4_UNSUPPORTED_MESSAGE
                    : PHASE4_IDLE_MESSAGE}
            </p>
          ) : savedPresentation.advanced_unresolved_count === 0 ? (
            <div data-testid="advanced-saved-complete" role="status" aria-live="polite" className="space-y-0.5">
              <p className="text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)]">Advanced Nutrition {nutritionUnsaved ? 'applied — not saved' : 'saved'}{savedDisplayComplete ? '' : ' · nutrient coverage partial'}</p>
              <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                {savedPresentation.advanced_stale ? 'Saved result needs review — recalculate before using these totals' : stored.kind === 'v5' || stored.kind === 'v6' ? 'Source-backed + AI-estimated contributions' : 'USDA reviewed'}
                {savedPresentation.advanced_ingredient_count ? ` · ${savedPresentation.advanced_ingredient_count} ingredient lines accounted for` : ''}
                {savedPresentation.advanced_supplement_count ? ` · ${savedPresentation.advanced_supplement_count} supplemental AI estimate${savedPresentation.advanced_supplement_count === 1 ? '' : 's'}` : ''}
                {savedPresentation.advanced_excluded_count ? ` · ${savedPresentation.advanced_excluded_count} cooking wrapper excluded` : ''}
                {stored.servings ? ` · base ${stored.servings} servings` : ''}
                {servingBasisAssumed ? ' · assumed basis; recipe yield is unspecified' : ''}
              </p>
            </div>
          ) : (
            <div data-testid="advanced-saved-partial" role="status" aria-live="polite" className="space-y-0.5">
              <p className="text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)]">Advanced Nutrition {nutritionUnsaved ? 'applied — not saved' : 'saved'} — partial</p>
              <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                {savedPresentation.advanced_resolved_count + savedPresentation.advanced_excluded_count} of {savedPresentation.advanced_ingredient_count} ingredient line
                {savedPresentation.advanced_ingredient_count === 1 ? '' : 's'} accounted for
                {savedPresentation.advanced_excluded_count ? ` · ${savedPresentation.advanced_excluded_count} wrapper excluded` : ''}
                {stored.servings ? ` · base ${stored.servings} servings` : ''}
                {servingBasisAssumed ? ' · assumed basis; recipe yield is unspecified' : ''}. Open Advanced Nutrition to
                finish review.
              </p>
            </div>
          )}
          <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)] flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            <span>This is not an error in the recipe.</span>
          </p>
          {bundleStatus === 'loading' ? (
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="inline-flex min-h-[44px] items-center gap-1.5 px-4 rounded-lg text-[14px] font-medium text-[var(--text-secondary,#9CA3AF)] bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] cursor-wait"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Authenticating…</span>
            </button>
          ) : bundleStatus === 'failed' ? (
            <button
              type="button"
              onClick={handleOpenRequest}
              className="inline-flex min-h-[44px] items-center gap-1.5 px-4 rounded-lg text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{PHASE4_BUNDLE_RETRY_LABEL}</span>
            </button>
          ) : bundleStatus === 'unsupported' ? null : advancedEditingBasic && !savedBlock ? (
            <p
              data-testid="advanced-nutrition-basic-locked"
              className="text-[13px] leading-relaxed text-[var(--text-primary,#F3F4F6)]"
            >
              Advanced Nutrition editing is not enabled for this deployment. Basic Nutrition remains
              available in Nutrition &amp; Macros.
            </p>
          ) : (
            <button
              type="button"
              data-testid="advanced-nutrition-open"
              onClick={savedBlock ? handleOpenRequest : handleGenerate}
              className="inline-flex min-h-[44px] items-center gap-1.5 px-4 rounded-lg text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] transition-colors"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>{savedBlock ? (nutritionUnsaved ? 'Open Working Advanced Report' : 'Open Saved Advanced Report') : 'Generate Nutrition'}</span>
            </button>
          )}
        </div>
      )}

      {session && !adaptation.ok && (
        <div className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] text-[14px] flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{PHASE4_UNREADABLE_MESSAGE}</span>
        </div>
      )}

      {session && adaptation.ok && (
        <div className="space-y-3">
          {(stored.kind === 'v1' || stored.kind === 'v2' || (stored.kind === 'v3' || stored.kind === 'v4' || stored.kind === 'v5' || stored.kind === 'v6')) && (
            <div className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))]">
              {savedPresentation.advanced_unresolved_count === 0 ? (
                <div data-testid="advanced-saved-complete" className="space-y-0.5">
                  <p className="text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)]">Advanced Nutrition {nutritionUnsaved ? 'applied — not saved' : 'saved'}{savedDisplayComplete ? '' : ' · nutrient coverage partial'}</p>
                  <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                    {savedPresentation.advanced_stale ? 'Saved result needs review — recalculate before using these totals' : stored.kind === 'v5' || stored.kind === 'v6' ? 'Source-backed + AI-estimated contributions' : 'USDA reviewed'}
                    {savedPresentation.advanced_ingredient_count ? ` · ${savedPresentation.advanced_ingredient_count} ingredient lines accounted for` : ''}
                    {savedPresentation.advanced_supplement_count ? ` · ${savedPresentation.advanced_supplement_count} supplemental AI estimate${savedPresentation.advanced_supplement_count === 1 ? '' : 's'}` : ''}
                    {savedPresentation.advanced_excluded_count ? ` · ${savedPresentation.advanced_excluded_count} cooking wrapper excluded` : ''}
                    {stored.servings ? ` · base ${stored.servings} servings` : ''}
                  </p>
                </div>
              ) : (
                <div data-testid="advanced-saved-partial" className="space-y-0.5">
                  <p className="text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)]">
                    Advanced Nutrition {nutritionUnsaved ? 'applied — not saved' : 'saved'} — partial
                  </p>
                  <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                    {savedPresentation.advanced_resolved_count + savedPresentation.advanced_excluded_count} of {savedPresentation.advanced_ingredient_count} ingredient line
                    {savedPresentation.advanced_ingredient_count === 1 ? '' : 's'} accounted for
                    {savedPresentation.advanced_excluded_count ? ` · ${savedPresentation.advanced_excluded_count} wrapper excluded` : ''}
                    {stored.servings ? ` · base ${stored.servings} servings` : ''}. Open Advanced Nutrition to
                    finish review.
                  </p>
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[14px] mt-1.5">
                {(stored.values ?? []).map((value) => (
                  <span key={value.label} className="text-[var(--text-secondary,#9CA3AF)]">
                    {value.label}: <span className="font-mono text-[var(--text-primary,#F3F4F6)]">{value.amount}</span> {value.unit}
                  </span>
                ))}
                {(stored.values ?? []).length === 0 && (
                  <span className="text-[var(--text-secondary,#9CA3AF)]">No recognized nutrient amounts.</span>
                )}
              </div>
            </div>
          )}
          {stored.kind === 'opaque' && (
            <div className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))]">
              <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                This recipe carries an unrecognized advanced-nutrition format. It is preserved but not
                interpreted or displayed as trusted data.
              </p>
            </div>
          )}

          {preview && compact && !liveMatchesSaved && (
            <div className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))]">
              <p className="mb-1 font-mono text-[12px] uppercase text-[var(--text-primary,#F3F4F6)]">
                Unsaved review — not applied · {basisLabel(state.basis, state.selectedServings)}
                {state.status === 'preview_stale' ? ' · stale' : ''}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
                {compact.map((nutrient) => {
                  if (!nutrient) return null;
                  const isEnergy = nutrient.nutrient === 'calories' && compactEnergy !== null;
                  const label = isEnergy
                    ? compactEnergy.label
                    : nutrient.coverage === 'partial'
                      ? `${nutrient.label} · subtotal`
                      : nutrient.label;
                  return (
                    <span
                      key={nutrient.nutrient}
                      data-testid={isEnergy ? 'advanced-nutrition-unsaved-energy' : undefined}
                      className="text-[var(--text-secondary,#9CA3AF)]"
                    >
                      {label}:{' '}
                      <span className="font-mono text-[var(--text-primary,#F3F4F6)]">{formatAmount(nutrient.amount)}</span>{' '}
                      {nutrient.amount !== undefined ? nutrient.unit_label : ''}
                    </span>
                  );
                })}
              </div>
              {coverage && (
                <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)] mt-1">
                  Coverage {coverage.status} · {coverage.unresolved_count} unresolved line(s)
                </p>
              )}
              {compactEnergy !== null && compactEnergy.kind !== 'complete' && (
                <p
                  data-testid="advanced-nutrition-unsaved-energy-note"
                  className="text-[12px] mt-1 leading-relaxed text-[var(--text-primary,#F3F4F6)]"
                >
                  {compactEnergy.note}
                </p>
              )}
              <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)] mt-1">
                Review only — nothing is saved until you Apply.
              </p>
              {acceptedEstimates.length > 0 && (
                <p
                  data-testid="advanced-nutrition-ai-estimate-apply-block"
                  className="text-[12px] mt-1 text-[var(--text-primary,#F3F4F6)]"
                >
                  Accepted estimated quantities — these remain labeled estimates when saved.
                </p>
              )}
              {acceptedEstimates.length > 0 && (
                <ul data-testid="advanced-nutrition-ai-estimate-apply-block-lines" className="text-[12px] text-[var(--text-secondary,#9CA3AF)] mt-1 list-disc pl-4">
                  {acceptedEstimates.map((estimate) => (
                    <li key={estimate.lineRef} data-testid={`ai-estimate-block-${estimate.lineRef}`}>
                      {`${estimate.lower_grams}\u2013${estimate.upper_grams} g \u00b7 estimate uses ${estimate.representative_grams} g`}
                      {/* The accepted AI estimate is only ever removed by the user,
                          through the EXISTING reducer action. Nothing about AI-3
                          changes: the line simply returns to needing a confirmed
                          amount, exactly as before the estimate was accepted. */}
                      <button
                        type="button"
                        data-testid={`advanced-nutrition-ai-estimate-clear-${estimate.lineRef}`}
                        onClick={() => dispatch({ type: 'clear_ai_estimate', lineRef: estimate.lineRef })}
                        className="ml-1.5 px-1.5 py-0.5 rounded border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--text-primary,#F3F4F6)] hover:bg-amber-500/20"
                      >
                        {AI_ESTIMATE_CLEAR_LABEL}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {applyEligibility !== null && (
                <p
                  data-testid="advanced-nutrition-apply-eligibility"
                  className={`text-[12px] mt-1 ${applyEligibility ? 'text-[var(--text-primary,#F3F4F6)]' : 'text-[var(--text-primary,#F3F4F6)]'}`}
                >
                  {applyEligibility
                    ? 'This reviewed result is eligible for Apply. Nothing is saved automatically.'
                    : 'This reviewed result is not eligible for Apply yet.'}
                </p>
              )}
            </div>
          )}

          {!preview && (
            <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)] flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-[var(--accent-text,#F59E0B)]" />
              <span>
                Review each ingredient's source match, then calculate an advisory preview. Nothing is
                calculated automatically.
              </span>
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[var(--text-secondary,#9CA3AF)] flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              <span>Advisory · not saved · not medical advice</span>
            </span>
            {advancedEditingBasic && !savedBlock ? (
              <p
                data-testid="advanced-nutrition-basic-locked"
                className="max-w-md text-[13px] leading-relaxed text-[var(--text-primary,#F3F4F6)]"
              >
                Advanced Nutrition editing is not enabled for this deployment. Basic Nutrition remains
                available in Nutrition &amp; Macros.
              </p>
            ) : (
              <button
                type="button"
                ref={openerRef}
                data-testid="advanced-nutrition-open"
                onClick={savedBlock ? handleOpenRequest : handleGenerate}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] transition-colors"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                <span>{savedBlock ? (nutritionUnsaved ? 'Open Working Advanced Report' : 'Open Saved Advanced Report') : 'Generate Nutrition'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {session && adaptation.ok && (
        <AdvancedNutritionModal
          isOpen={isOpen}
          onClose={handleCloseWorkingEditor}
          generateAiFeedback={generateAiFeedback}
          title={adaptation.recipe.title}
          assumedServingBasis={servingBasisAssumed}
          session={session}
          adapted={adapted}
          state={state}
          dispatch={workingDispatch}
          onCalculate={handleCalculate}
          calculating={calculating}
          analysis={analysis}
          onAnalyze={handleAnalyze}
          onAnalyzeRecipe={() => { void handleAnalyzeNutritionWithShiso(); }}
          nutritionAuthority={nutritionAuthority}
          shisoAnalysisState={shisoNutritionState}
          analysisRuns={analysisRuns}
          apply={applyUi}
          workingDirty={workingDirty}
          hydratedFromSaved={hydratedFromSaved}
          ai={aiUi}
          recipeContext={recipeContextUi}
        />
      )}

      {savedBlock && (
        <AdvancedNutritionSavedReport
          isOpen={isSavedReportOpen}
          unsaved={nutritionUnsaved}
          onClose={() => setIsSavedReportOpen(false)}
          title={adaptation.ok ? adaptation.recipe.title : ''}
          block={savedBlock}
          stale={savedPresentation.advanced_stale}
          servingBasisAssumed={servingBasisAssumed}
          {...(savedSupplementVerification !== undefined ? { supplementVerification: savedSupplementVerification } : {})}
          {...(quarantinedSupplements.length > 0
            ? {
                quarantinedSupplements: quarantinedSupplements.map((entry) => ({
                  line_ref: entry.supplement.line_ref,
                  nutrient_id: entry.supplement.nutrient_id,
                  reason: entry.reason,
                })),
              }
            : {})}
          {...(advancedEditingEntitled
            ? {
                onEdit: () => {
                  setIsSavedReportOpen(false);
                  openWorkingEditor();
                },
              }
            : {})}
        />
      )}
    </div>
  );
};
