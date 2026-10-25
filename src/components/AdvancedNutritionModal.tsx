import { flushSync } from 'react-dom';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ShieldAlert, FlaskConical, CheckCircle2, AlertTriangle, Info, Search, Sparkles, ChevronDown } from 'lucide-react';
import { convertMassToGrams, type NormalizedUnit } from '../utils/measurements';
import { useShiso } from '../application-ui/shisoEntryPoints';
import { prepareShisoProposalActions } from '../core/shiso/proposalActions';
import { deriveNutritionCoverage } from '../core/shiso/nutritionCoverage';
import { AI_ADVANCED_NUTRITION_LABEL } from '../core/nutritionV2/nutritionCapabilities';
import {
  NUTRIENT_GROUPS,
  PHASE4_DIRECT_MASS_NOTE,
  PHASE4_NOT_MEDICAL_ADVICE,
  PHASE4_USER_MASS_CONFIRM_LABEL,
  PHASE4_USER_MASS_LABEL,
  PHASE4_USER_MASS_NOTE,
  basisLabel,
  buildCountPortionChoice,
  buildPortionChoice,
  buildUserMassChoice,
  canonicalCountRequirementHint,
  candidatePortionCompatibility,
  countDerivationLabel,
  coverageSummary,
  deriveDisplayNutrients,
  formatAmount,
  formatDailyValue,
  ingredientCountAmount,
  ingredientEvidenceViews,
  ingredientMeasurement,
  ingredientMeasurementKind,
  liveExceptionKind,
  LIVE_ROW_STATUS_LABEL,
  massSourceLabel,
  projectLiveRows,
  reviewCanonicalLineCountPortions,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type AnalyzedRow,
  type BasisMode,
  type FoodSearchResult,
  type LiveRowState,
  type LiveRowStatus,
  type MatchChoice,
  type Phase4Action,
  type Phase4Row,
  type Phase4State,
  type RecipeAnalysis,
} from '../core/nutritionV2/phase4';
import {
  formatAiEstimateOfferSummary,
  type AiEstimateOffer,
} from '../core/nutritionV2/phase4/aiEstimateAccept';
import {
  AI_RECIPE_CONTEXT_ABSTAIN_LABEL,
  AI_RECIPE_CONTEXT_ACCEPT_LABEL,
  AI_RECIPE_CONTEXT_CLEAR_REVIEW_LABEL,
  AI_RECIPE_CONTEXT_DISMISS_LABEL,
  AI_RECIPE_CONTEXT_INTERPRETATION_LABEL,
  AI_RECIPE_CONTEXT_NOTE,
  AI_RECIPE_CONTEXT_REVIEW_LABEL,
  AI_RECIPE_CONTEXT_SECTION_LABEL,
  AI_RECIPE_CONTEXT_STATUS_LABEL,
  AI_RECIPE_CONTEXT_UNDO_LABEL,
  formatRecipeContextTerm,
  type AiRecipeContextReviewStatus,
} from '../core/nutritionV2/aiRecipeContextSession';

/** Apply status shown by the explicit Phase 5B control. */
export type AdvancedNutritionApplyStatus = 'idle' | 'confirming' | 'applying' | 'success' | 'error';

/**
 * The explicit Apply control state. It is a UI view model only: the actual write
 * coordinator lives in the application layer and is invoked through the card's
 * `onApplyAdvancedNutrition` prop. Never an automatic write.
 */
export interface AdvancedNutritionApplyUi {
  readonly eligible: boolean | null;
  readonly mode: 'create' | 'replace' | null;
  readonly status: AdvancedNutritionApplyStatus;
  readonly message: string | null;
  readonly onRequest: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Existing explicit Vault save path for an already-applied working copy. */
  readonly onSave?: () => void;
}

/**
 * ONE AI-4D2 review row, as pure display data.
 *
 * `status` is a closed vocabulary rendered as TEXT, so review state is never
 * communicated by colour alone. The three action flags come straight from the
 * acceptance core: only a pending reviewable row can be accepted or dismissed,
 * and only a decided row can be undone.
 */
export interface AdvancedNutritionRecipeContextRow {
  readonly line_ref: string;
  readonly source_text: string;
  readonly status: AiRecipeContextReviewStatus;
  readonly role?: string;
  readonly preparation_hints: ReadonlyArray<string>;
  readonly relations: ReadonlyArray<{ readonly kind: string; readonly target_ref: string }>;
  readonly confidence?: string;
  readonly explanation?: string;
  readonly abstain_reason?: keyof typeof AI_RECIPE_CONTEXT_ABSTAIN_LABEL;
  readonly accept_capable: boolean;
  readonly dismiss_capable: boolean;
  readonly undo_capable: boolean;
}

/**
 * The AI-4D2 review surface, injected by the card. Absent when no AI-4 port is
 * wired. Every callback is a USER action: opening the modal never calls any of
 * them, and Accept/Dismiss/Undo are pure local decisions that make no request.
 */
export interface AdvancedNutritionRecipeContextUi {
  readonly available: boolean;
  /** AI-5D: a readiness refresh is in flight. */
  readonly refreshing?: boolean;
  /** AI-5D: an explicit re-check is worth offering. */
  readonly canRetry?: boolean;
  /** AI-5D: the explicit user-triggered re-check. */
  readonly onRetry?: () => void;
  /**
   * AI-5C bounded reason copy for an unavailable surface, or `null`. Pre-computed by
   * the shell so this component never re-derives WHY.
   */
  readonly unavailableReason: string | null;
  readonly running: boolean;
  readonly message: string | null;
  readonly rows: ReadonlyArray<AdvancedNutritionRecipeContextRow>;
  readonly pending_count: number;
  readonly accepted_count: number;
  readonly dismissed_count: number;
  readonly abstained_count: number;
  readonly uninterpreted_count: number;
  readonly reviewStarted: boolean;
  readonly onReview: () => void;
  readonly onAccept: (lineRef: string) => void;
  readonly onDismiss: (lineRef: string) => void;
  readonly onUndo: (lineRef: string) => void;
  readonly onClearReview: () => void;
}

/** One advisory AI-assisted candidate shown for a specific unresolved row. */
export interface AdvancedNutritionAiSuggestion {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly description: string;
  readonly auto: boolean;
  readonly choice: MatchChoice;
}

/**
 * One AI-interpreted, LOCALLY AUTHENTICATED count portion that remains the
 * user's explicit choice (materially different weights are never auto-chosen).
 * `hint` is a bounded count-identity hint (closed vocabulary), never a mass.
 */
export interface AdvancedNutritionAiAmountOffer {
  readonly line_ref: string;
  readonly fdc_id: number;
  readonly portion_index: number;
  readonly display_label: string;
  readonly resolved_grams: number;
  readonly hint: { readonly unit: string | null; readonly size: string | null };
}

/**
 * Optional AI-assisted exception-resolution UI (advisory only). The AI suggests
 * food search phrases and bounded amount/count interpretations; the deterministic
 * local catalog, confidence contract, and authenticated USDA portions decide
 * every resolution. Available for ANY actionable exception (needs match, review
 * suggested, needs amount), not merely needs match. Absent when the shell does
 * not wire the resolver.
 */
export interface AdvancedNutritionAiUi {
  readonly available: boolean;
  /** AI-5D: a readiness refresh is in flight. */
  readonly refreshing?: boolean;
  /** AI-5D: an explicit re-check is worth offering. */
  readonly canRetry?: boolean;
  /** AI-5D: the explicit user-triggered re-check. */
  readonly onRetry?: () => void;
  /**
   * AI-5C bounded reason copy for an unavailable AI layer, or `null`. Pre-computed by
   * the shell; this component never re-derives WHY.
   */
  readonly unavailableReason: string | null;
  readonly running: boolean;
  readonly message: string | null;
  readonly suggestions: Readonly<Record<string, AdvancedNutritionAiSuggestion>>;
  readonly amountOffers: Readonly<Record<string, ReadonlyArray<AdvancedNutritionAiAmountOffer>>>;
  /**
   * AI-3 estimate OFFERS. Display-only. An offer that merely exists never
   * changes the preview or Apply eligibility; only the second explicit click
   * can promote one into working state.
   */
  readonly estimateOffers?: Readonly<Record<string, Readonly<AiEstimateOffer>>>;
  readonly estimateRunning?: boolean;
  readonly estimateMessage?: string | null;
  readonly onEstimateMassesWithAi?: () => void;
  readonly onUseEstimateOffer?: (lineRef: string) => void;
  /** Actionable rows (needs_match + review_suggested + needs_amount). */
  readonly exceptionCount: number;
  /**
   * OPTIONAL AI-2C candidate-plan action (absent when no plan port is wired).
   * Explicit, user-invoked, and non-mutating on its own: accepted results flow
   * through the card's existing working-state merge, offers wait for the user.
   */
  readonly planAvailable?: boolean;
  readonly planRunning?: boolean;
  readonly onPlan?: () => void;
  readonly onResolve: (lineRef?: string) => void;
  readonly onUseSuggestion: (lineRef: string) => void;
  readonly onUseAmountOffer: (lineRef: string, portionIndex: number) => void;
  readonly onDismissMessage: () => void;
}

interface AdvancedNutritionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Materialized, bounded recipe title (never a raw untrusted recipe). */
  title: string;
  /** The recipe has no authored serving count, so the shared 4-serving fallback is in use. */
  assumedServingBasis?: boolean;
  session: AdvancedNutritionSession;
  adapted: ReadonlyArray<AdaptedIngredient>;
  state: Phase4State;
  dispatch: React.Dispatch<Phase4Action>;
  onCalculate: () => void;
  calculating: boolean;
  /** Deterministic automatic analysis result (post-Phase-5 remediation). */
  analysis: RecipeAnalysis | null;
  /** Runs the one-click automatic analyzer. */
  onAnalyze: () => void;
  /** Runs the registered, recipe-bound SHISO structured nutrition request. */
  onAnalyzeRecipe?: () => void;
  shisoAnalysisState?: { readonly kind: 'idle' | 'running' | 'success' | 'error'; readonly message: string | null };
  /** Number of analyzer runs in this modal session (visible feedback). */
  analysisRuns?: number;
  /** True when the working review diverges from the saved Advanced result. */
  workingDirty?: boolean;
  /** True when the working review was hydrated from the saved Advanced result. */
  hydratedFromSaved?: boolean;
  /** Explicit Apply control (Phase 5B). Absent when no write path is wired. */
  apply?: AdvancedNutritionApplyUi;
  /** Optional AI-assisted USDA resolution (advisory only). */
  ai?: AdvancedNutritionAiUi;
  /**
   * Optional AI-4D2 explicit recipe-context REVIEW surface. Display + the user's
   * own Accept/Dismiss/Undo actions only. It has no nutrition authority: nothing
   * here changes a match, a portion, a mass, a nutrient, the preview or Apply.
   */
  recipeContext?: AdvancedNutritionRecipeContextUi;
}

const OUTCOME_LABEL: Record<string, string> = {
  matched_exact: 'Automatic unique-exact source match',
  review_required: 'Review required',
  unmatched: 'No source match',
  qualitative: 'Qualitative (not measurable)',
  invalid: 'Invalid ingredient line',
  none_selected: 'None of these selected',
};

/** Live row-status badge styling (the CURRENT effective state, not the snapshot). */
const LIVE_STATUS_CLASS: Record<LiveRowStatus, string> = {
  matched: 'bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border-[var(--border-subtle,rgba(255,255,255,0.08))]',
  review_suggested: 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)] border-[var(--border-subtle,rgba(255,255,255,0.08))]',
  needs_amount: 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--text-primary,#F3F4F6)] border-[var(--border-subtle,rgba(255,255,255,0.08))]',
  needs_match: 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--text-primary,#F3F4F6)] border-[var(--border-subtle,rgba(255,255,255,0.08))]',
  qualitative: 'bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] border-[var(--border-subtle,rgba(255,255,255,0.08))]',
};

/**
 * Bounded, user-facing live mass-source text for the collapsed row. Direct mass
 * derived from a written MASS RANGE is labelled as a deterministic midpoint and
 * always rendered through the same 1-decimal display rounding, so raw
 * floating-point artifacts are never exposed.
 */
export function liveMassText(live: LiveRowState): string | undefined {
  if (live.resolved_grams === undefined) return undefined;
  const grams = Math.round(live.resolved_grams * 10) / 10;
  switch (live.mass_source) {
    case 'user_mass':
      return `${grams} g · user-entered`;
    case 'source_portion':
      return `${grams} g · ${live.source_portion_automatic ? 'auto-selected' : 'selected'} USDA portion`;
    case 'count_portion':
      return `${grams} g · USDA count portion`;
    case 'household_portion': {
      const base =
        live.household_authority_class === 'bounded_estimate'
          ? `${grams} g · household estimate`
          : `${grams} g · vetted household portion`;
      return live.household_ai_assisted === true ? `${base} · AI-interpreted wording` : base;
    }
    case 'direct_mass': {
      const representative = live.mass_representative;
      if (representative !== undefined) {
        return `${grams} g · written range midpoint (${representative.lower}–${representative.upper} ${representative.unit})`;
      }
      return `${grams} g`;
    }
    default:
      return `${grams} g`;
  }
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function useDialogFocus(isOpen: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    restoreRef.current = (typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null) ?? null;
    const node = dialogRef.current;
    if (node) {
      // Focus the dialog container itself so the accessible name and description
      // are announced before the first control, and no secondary action appears
      // pre-activated. Tab then moves into the controls.
      node.scrollTop = 0;
      node.focus({ preventScroll: true });
    }
    return () => {
      const restore = restoreRef.current;
      if (restore && typeof restore.focus === 'function') restore.focus({ preventScroll: true });
    };
  }, [isOpen]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = dialogRef.current;
      if (!node) return;
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  return { dialogRef, onKeyDown };
}

interface PortionCandidateView {
  readonly index: number;
  readonly measure: string;
  readonly amount?: number;
  readonly gram_weight: number;
  readonly modifier?: string;
  readonly semantics_version: string;
  readonly kind: 'volume' | 'mass' | 'count' | 'unusable';
  readonly unit: string | null;
  readonly effective_amount: number | null;
  readonly volume_ml: number | null;
  readonly amount_source: string;
  readonly descriptor: string | null;
  readonly display_label: string;
}

interface CountPortionCandidateView {
  readonly index: number;
  readonly measure: string;
  readonly modifier?: string;
  readonly amount: number;
  readonly gram_weight: number;
  readonly unit: string | null;
  readonly size: string | null;
  readonly display_label: string;
}

interface PortionControlsProps {
  row: Phase4Row;
  fdcId: number;
  session: AdvancedNutritionSession;
  state: Phase4State;
  dispatch: React.Dispatch<Phase4Action>;
  adapted: ReadonlyArray<AdaptedIngredient>;
  /**
   * The SAME calculator/live-verified row projection used everywhere else. A
   * displayed household gram value comes ONLY from this verified row (source +
   * grams), never from the stored choice's own `resolved_grams` claim.
   */
  live: LiveRowState | undefined;
}

const PortionControls: React.FC<PortionControlsProps> = ({
  row,
  fdcId,
  session,
  state,
  dispatch,
  adapted,
  live,
}) => {
  const [candidates, setCandidates] = useState<ReadonlyArray<PortionCandidateView> | null>(null);
  const [countReview, setCountReview] = useState<{
    readonly applicable: boolean;
    readonly candidates: ReadonlyArray<CountPortionCandidateView>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weightQty, setWeightQty] = useState('');
  const [weightUnit, setWeightUnit] = useState<'g' | 'oz' | 'lb'>('g');
  const current = state.portions[row.line_ref];
  const currentCount = state.countPortions[row.line_ref];
  const currentUserMass = state.userMasses[row.line_ref];
  const currentHousehold = state.householdPortions[row.line_ref];
  /**
   * CALCULATOR/LIVE-VERIFIED household display authority. The stored choice's
   * own `resolved_grams` is a display claim only and is NEVER rendered: the
   * displayed gram value comes from the SAME live row projection used by the
   * collapsed row (a bounded per-line calculation dry-run through the genuine
   * session). When the current calculation does not accept the stored choice as
   * the effective household source, no gram value is shown at all.
   */
  const verifiedHousehold =
    live !== undefined &&
    live.mass_source === 'household_portion' &&
    typeof live.resolved_grams === 'number'
      ? live
      : undefined;
  const matchChoice = state.matches[row.line_ref];
  const entry = adapted.find((item) => item.line_ref === row.line_ref);
  const measurementKind = entry ? ingredientMeasurementKind(entry) : 'unknown';
  const countAmount = entry ? ingredientCountAmount(entry) : null;

  // The recipe's own parsed quantity/unit flows into the amount UI. The row
  // binds it to an authenticated USDA portion deterministically; the manual
  // total weight stays a fallback.
  const parsedEntry = entry ? ingredientMeasurement(entry) : undefined;
  const recipeAmount = parsedEntry ? parsedEntry.amount : null;
  const recipeUnit = parsedEntry ? parsedEntry.raw_unit : undefined;
  const recipeMl = parsedEntry ? parsedEntry.milliliters : undefined;
  const recipeGrams = parsedEntry ? parsedEntry.grams : undefined;

  /**
   * Deterministic total grams for a compatible authenticated portion applied to
   * the recipe's own quantity/unit. Volume scales by exact canonical volume;
   * mass scales by the portion's own mass. Never a density, never an average.
   */
  const derivedTotalFor = (candidate: PortionCandidateView): number | undefined => {
    if (measurementKind === 'volume' && candidate.kind === 'volume') {
      if (recipeMl === undefined || !(candidate.volume_ml !== null && candidate.volume_ml > 0)) return undefined;
      const grams = (recipeMl / candidate.volume_ml) * candidate.gram_weight;
      return Number.isFinite(grams) && grams > 0 ? grams : undefined;
    }
    if (measurementKind === 'mass' && candidate.kind === 'mass') {
      if (recipeGrams === undefined || candidate.effective_amount === null) return undefined;
      const portionMass = candidate.unit
        ? convertMassToGrams(candidate.effective_amount, candidate.unit as NormalizedUnit)
        : undefined;
      if (portionMass === undefined || !(portionMass > 0)) return undefined;
      const grams = (recipeGrams / portionMass) * candidate.gram_weight;
      return Number.isFinite(grams) && grams > 0 ? grams : undefined;
    }
    return undefined;
  };

  const load = useCallback(() => {
    setError(null);
    const result = session.reviewPortions(fdcId);
    if (!result.ok) {
      setCandidates([]);
      setError('Portion review is unavailable for this food.');
      return;
    }
    setCandidates(result.review.candidates as unknown as ReadonlyArray<PortionCandidateView>);
  }, [session, fdcId]);

  const loadCount = useCallback(() => {
    if (!entry) {
      setCountReview({ applicable: false, candidates: [] });
      return;
    }
    // ONE canonical count context for the line: the candidate review uses the
    // SAME bounded hint the calculation request and live projection use, so the
    // candidate set/digest can never differ between display and authority.
    const result = reviewCanonicalLineCountPortions(session, state, row.line_ref, entry.ingredient, fdcId);
    if (!result.ok) {
      setCountReview({ applicable: false, candidates: [] });
      return;
    }
    setCountReview({
      applicable: result.review.applicable,
      candidates: result.review.candidates as unknown as ReadonlyArray<CountPortionCandidateView>,
    });
  }, [session, state, row.line_ref, fdcId, entry]);

  // Compatible canonical portions are presented immediately after a food is
  // selected; no second action is required to reveal them. The button remains as
  // a manual refresh. Nothing is auto-selected. A direct-mass line offers no
  // alternate mass choice at all, so no review is loaded for it.
  useEffect(() => {
    if (measurementKind === 'mass') return;
    load();
    loadCount();
  }, [load, loadCount, measurementKind]);

  const selectionForChoice = () => {
    if (!matchChoice) return undefined;
    if (matchChoice.kind === 'manual') {
      return {
        kind: 'manual',
        fdc_id: matchChoice.fdc_id,
        record_digest: matchChoice.record_digest,
        catalog_digest: matchChoice.catalog_digest,
        line_ref: row.line_ref,
        review_digest: matchChoice.review_digest,
      };
    }
    if (row.outcome === 'review_required') {
      return matchChoice.kind === 'candidate'
        ? { kind: 'candidate', fdc_id: matchChoice.fdc_id, review_digest: matchChoice.review_digest }
        : { kind: 'none', review_digest: matchChoice.review_digest };
    }
    return undefined;
  };

  const choose = (portionIndex: number) => {
    setError(null);
    if (!entry) return;
    const result = buildPortionChoice(session, {
      lineRef: row.line_ref,
      ingredient: entry.ingredient,
      review: row.outcome === 'review_required' ? row.review : undefined,
      selection: selectionForChoice(),
      automaticSelection: matchChoice?.automatic === true,
      fdcId,
      portionIndex,
    });
    if (!result.ok) {
      setError('That source portion cannot be applied. No mass can be derived from it.');
      return;
    }
    dispatch({ type: 'select_portion', lineRef: row.line_ref, choice: result.choice });
  };

  const chooseCount = (portionIndex: number) => {
    setError(null);
    if (!entry) return;
    const result = buildCountPortionChoice(session, {
      lineRef: row.line_ref,
      ingredient: entry.ingredient,
      review: row.outcome === 'review_required' ? row.review : undefined,
      selection: selectionForChoice(),
      automaticSelection: matchChoice?.automatic === true,
      fdcId,
      portionIndex,
      // The stored selection preserves the SAME canonical hint its candidate
      // review used, so the calculator re-derives an identical digest.
      countRequirementHint: canonicalCountRequirementHint(state, row.line_ref),
    });
    if (!result.ok) {
      setError('That count portion cannot be applied. No mass can be derived from it.');
      return;
    }
    dispatch({ type: 'select_count_portion', lineRef: row.line_ref, choice: result.choice });
  };

  const confirmUserMass = () => {
    setError(null);
    if (!entry) return;
    const result = buildUserMassChoice(session, {
      lineRef: row.line_ref,
      ingredient: entry.ingredient,
      review: row.outcome === 'review_required' ? row.review : undefined,
      selection: selectionForChoice(),
      automaticSelection: matchChoice?.automatic === true,
      fdcId,
      quantity: Number(weightQty),
      unit: weightUnit,
    });
    if (!result.ok) {
      setError('Enter a positive weight in grams, ounces, or pounds.');
      return;
    }
    dispatch({ type: 'select_user_mass', lineRef: row.line_ref, choice: result.choice });
  };

  const countApplicable = countReview?.applicable === true;
  const countCandidates = countReview?.candidates ?? [];
  const countDistinct = new Set(countCandidates.map((candidate) => `${candidate.amount}:${candidate.gram_weight}`));
  const countDeterministic = countCandidates.length > 0 && countDistinct.size === 1;
  const deterministicCandidate = countDeterministic ? countCandidates[0] : null;
  const deterministicUnit = deterministicCandidate?.unit ?? deterministicCandidate?.size ?? 'portion';
  const deterministicTotal =
    deterministicCandidate && countAmount !== null
      ? (countAmount / deterministicCandidate.amount) * deterministicCandidate.gram_weight
      : undefined;

  return (
    <div className="mt-2 pl-3 border-l border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-3">
      {measurementKind === 'mass' ? (
        // DIRECT-MASS EXCLUSIVITY: a line that already declares its own recipe
        // mass has complete mass authority. No alternate mass choice (source
        // portion, count portion, or manual total weight) is offered, retained,
        // or displayed as active; the bounded note is the only content.
        <p data-testid="advanced-nutrition-direct-mass-note" className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
          {PHASE4_DIRECT_MASS_NOTE}
        </p>
      ) : (
        <>
      {currentHousehold && (
        <div className="space-y-1" data-testid="advanced-nutrition-household-portion">
          <div className="flex items-center gap-2">
            <h4 className="text-[13px] font-semibold text-[var(--text-secondary,#9CA3AF)]">
              {verifiedHousehold === undefined
                ? 'Stored household portion'
                : verifiedHousehold.household_authority_class === 'bounded_estimate'
                  ? 'Kitchen Codex household estimate'
                  : 'Kitchen Codex household portion'}
            </h4>
            <span className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
              {verifiedHousehold?.household_unit ??
                currentHousehold.record_key.split('|')[1] ??
                'item'}
            </span>
            <button
              type="button"
              onClick={() => dispatch({ type: 'clear_household_portion', lineRef: row.line_ref })}
              className="px-2 py-0.5 rounded-lg text-[13px] text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)] hover:bg-[var(--bg-root,#0C0C0C)] transition-colors"
            >
              Clear
            </button>
          </div>
          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
            {verifiedHousehold !== undefined ? (
              <>
                {Math.round(verifiedHousehold.resolved_grams * 10) / 10} g from a reviewed Kitchen
                Codex household record. It applies only while no higher-authority mass source is
                chosen, and it is never treated as USDA portion or user-entered data.
                {verifiedHousehold.household_ai_assisted === true &&
                  ' The household wording was AI-interpreted; the record and grams were authenticated locally by the registry.'}
              </>
            ) : (
              'This stored household portion is not accepted by the current calculation, so no gram value is shown.'
            )}
          </p>
        </div>
      )}
      {countApplicable ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h4 className="text-[13px] font-semibold text-[var(--text-secondary,#9CA3AF)]">USDA count portions</h4>
            {currentCount && (
              <span className="text-[13px] text-[var(--text-primary,#F3F4F6)] font-medium">Count portion selected</span>
            )}
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
              {error}
            </p>
          )}
          {countCandidates.length === 0 && (
            <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
              No compatible authenticated count portion for this food. Count mass stays unresolved.
            </p>
          )}
          {deterministicCandidate && deterministicTotal !== undefined && countAmount !== null && (
            <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
              {countAmount} {deterministicUnit}
              {countAmount === 1 ? '' : 's'} × {deterministicCandidate.gram_weight} g per{' '}
              {deterministicUnit} = {deterministicTotal} g
              <span className="text-[var(--text-secondary,#9CA3AF)]"> · deterministic (applied automatically)</span>
            </p>
          )}
          {!countDeterministic && countCandidates.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                Choose an authenticated count portion for {row.original_text}
              </legend>
              {countCandidates.map((candidate) => (
                <label
                  key={candidate.index}
                  className="flex items-start gap-2 text-[13px] text-[var(--text-primary,#F3F4F6)] cursor-pointer"
                >
                  <input
                    type="radio"
                    name={`count-portion-${row.line_ref}`}
                    checked={currentCount?.portion_index === candidate.index}
                    onChange={() => chooseCount(candidate.index)}
                    className="mt-0.5"
                  />
                  <span>{candidate.display_label}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
      ) : (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h4 className="text-[13px] font-semibold text-[var(--text-secondary,#9CA3AF)]">USDA source portions</h4>
          <button
            type="button"
            onClick={load}
            className="min-h-[36px] rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 text-[12px] text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
          >
            Review source portions
          </button>
          {current && (
            <span className="text-[13px] text-[var(--text-primary,#F3F4F6)] font-medium">Source portion selected</span>
          )}
        </div>
        {recipeAmount !== null && recipeUnit && (
          <p data-testid="advanced-nutrition-recipe-amount" className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
            Recipe amount: <span className="font-mono text-[var(--text-primary,#F3F4F6)]">{recipeAmount} {recipeUnit}</span>
          </p>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
            {error}
          </p>
        )}
        {candidates && (
          <fieldset className="space-y-1">
            <legend className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
              Choose an authenticated source portion for {row.original_text}
            </legend>
            {candidates.length === 0 && (
              <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                This source food has no authenticated portion. Choose a different source food above, or
                enter the total weight below.
              </p>
            )}
            {candidates.map((candidate) => {
              const compatibility = candidatePortionCompatibility(candidate, measurementKind);
              const disabled = compatibility !== 'compatible';
              const total = disabled ? undefined : derivedTotalFor(candidate);
              return (
                <div key={candidate.index} className="flex items-start gap-2">
                  <label
                    className={`flex items-start gap-2 text-[13px] ${disabled ? 'text-[var(--text-secondary,#9CA3AF)] cursor-not-allowed' : 'text-[var(--text-primary,#F3F4F6)] cursor-pointer'}`}
                  >
                    <input
                      type="radio"
                      name={`portion-${row.line_ref}`}
                      checked={current?.portion_index === candidate.index}
                      disabled={disabled}
                      onChange={() => choose(candidate.index)}
                      className="mt-0.5"
                    />
                    <span>
                      {candidate.display_label}
                      {disabled && (
                        <span className="text-[var(--text-primary,#F3F4F6)]">
                          {compatibility === 'unusable'
                            ? ' · unusable source portion'
                            : ' · not compatible with this measurement'}
                        </span>
                      )}
                    </span>
                  </label>
                  {total !== undefined && (
                    <span className="text-[13px] text-[var(--accent-text,#F59E0B)]">
                      → {Math.round(total * 10) / 10} g for {recipeAmount} {recipeUnit}
                    </span>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}
      </div>
      )}

      <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h4 className="text-[13px] font-semibold text-[var(--text-secondary,#9CA3AF)]">{PHASE4_USER_MASS_LABEL}</h4>
            {currentUserMass && (
              <span className="text-[13px] text-[var(--text-primary,#F3F4F6)] font-medium">
                Weight entered ({currentUserMass.quantity} {currentUserMass.unit})
              </span>
            )}
          </div>
          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">{PHASE4_USER_MASS_NOTE}</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              aria-label="Total weight for this ingredient line"
              value={weightQty}
              min={0}
              step="any"
              onChange={(event) => setWeightQty(event.target.value)}
              className="w-24 px-2 py-1 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] text-[14px]"
            />
            <select
              aria-label="Weight unit"
              value={weightUnit}
              onChange={(event) => setWeightUnit(event.target.value as 'g' | 'oz' | 'lb')}
              className="px-2 py-1 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] text-[14px]"
            >
              <option value="g">g</option>
              <option value="oz">oz</option>
              <option value="lb">lb</option>
            </select>
            <button
              type="button"
              onClick={confirmUserMass}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
            >
              {PHASE4_USER_MASS_CONFIRM_LABEL}
            </button>
            {currentUserMass && (
              <button
                type="button"
                onClick={() => dispatch({ type: 'clear_user_mass', lineRef: row.line_ref })}
                className="px-2 py-1 rounded-lg text-[13px] text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)] hover:bg-[var(--bg-root,#0C0C0C)] transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
};

interface FoodSearchPanelProps {
  row: Phase4Row;
  session: AdvancedNutritionSession;
  dispatch: React.Dispatch<Phase4Action>;
  onApplied: () => void;
}

/**
 * User-directed manual USDA search. Deterministic and local to the SAME pinned
 * bundle as Advanced Nutrition (no network, no AI). Discovery only — the chosen
 * record is re-authenticated by the calculation engine.
 */
const FoodSearchPanel: React.FC<FoodSearchPanelProps> = ({ row, session, dispatch, onApplied }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ReadonlyArray<FoodSearchResult> | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const catalogDigest = useMemo(() => session.metadata().catalog_digest, [session]);
  const prefill = row.query || row.original_text;

  const run = useCallback(
    (requestedLimit: number) => {
      setError(null);
      const q = (query.trim().length > 0 ? query.trim() : prefill).slice(0, 300);
      if (q.length === 0) {
        setError('Enter a food to search.');
        setResults([]);
        setTotal(0);
        setSearched(true);
        return;
      }
      const result = session.searchFoods(q, requestedLimit);
      if (!result.ok) {
        setError('USDA search is unavailable for this session.');
        setResults([]);
        setTotal(0);
        setSearched(true);
        return;
      }
      setResults(result.results);
      setTotal(result.total);
      setLimit(result.limit);
      setSearched(true);
    },
    [query, prefill, session]
  );

  const use = (result: FoodSearchResult) => {
    dispatch({
      type: 'select_match',
      lineRef: row.line_ref,
      choice: {
        kind: 'manual',
        fdc_id: result.fdc_id,
        review_digest: row.review_digest ?? '',
        record_digest: result.record_digest,
        catalog_digest: catalogDigest,
        description: result.description,
      },
    });
    onApplied();
  };

  const canLoadMore = results !== null && results.length < total && limit < 100;

  return (
    <div className="space-y-1" data-testid="advanced-nutrition-usda-search">
      <button
        type="button"
        data-testid="advanced-nutrition-search-usda"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] bg-[var(--bg-elevated,#1E1E1E)] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-secondary,#9CA3AF)] transition-colors"
      >
        <Search className="w-3 h-3" aria-hidden="true" />
        {open ? 'Close search' : 'Search USDA database'}
      </button>
      {open && (
        <div className="mt-1 space-y-2 p-2 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))]">
          <label className="block text-[12px] text-[var(--text-secondary,#9CA3AF)]" htmlFor={`usda-search-${row.line_ref}`}>
            Search all USDA foods (full pinned dataset)
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`usda-search-${row.line_ref}`}
              data-testid="advanced-nutrition-search-input"
              type="text"
              value={query}
              placeholder={prefill}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  run(20);
                }
              }}
              className="flex-1 px-2 py-1 rounded-lg bg-[var(--bg-surface,#141414)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] text-[14px]"
            />
            <button
              type="button"
              data-testid="advanced-nutrition-search-run"
              onClick={() => run(20)}
              className="px-2.5 py-1 rounded-lg text-[13px] font-semibold bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] transition-colors"
            >
              Search
            </button>
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
              {error}
            </p>
          )}
          {searched && results !== null && results.length === 0 && !error && (
            <p data-testid="advanced-nutrition-search-empty" className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
              No matching USDA record found in this pinned dataset.
            </p>
          )}
          {results !== null && results.length > 0 && (
            <>
              <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                {total} matching USDA record{total === 1 ? '' : 's'}
                {results.length < total ? ` · showing first ${results.length}` : ''}
              </p>
              <ul className="space-y-1 max-h-64 overflow-y-auto">
                {results.map((result) => (
                  <li
                    key={result.fdc_id}
                    className="flex items-start justify-between gap-2 p-1.5 rounded-md bg-[var(--bg-surface,#141414)] border border-[var(--border-subtle,rgba(255,255,255,0.08))]"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">{result.description}</p>
                      <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                        {result.data_type} · FDC {result.fdc_id}
                        {result.exact_fdc_id ? ' · exact FDC match' : ''}
                        {result.portion_summary
                          ? ` · ${result.portion_summary}`
                          : ' · no authenticated portion'}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid={`advanced-nutrition-use-usda-${result.fdc_id}`}
                      onClick={() => use(result)}
                      className="shrink-0 px-2 py-0.5 rounded-md text-[12px] font-semibold bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] transition-colors"
                    >
                      Use this USDA food
                    </button>
                  </li>
                ))}
              </ul>
              {canLoadMore && (
                <button
                  type="button"
                  data-testid="advanced-nutrition-search-load-more"
                  onClick={() => run(Math.min(limit + 20, 100))}
                  className="min-h-[36px] rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 text-[12px] text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                >
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const AdvancedNutritionModal: React.FC<AdvancedNutritionModalProps> = ({
  isOpen,
  onClose,
  title,
  assumedServingBasis = false,
  session,
  adapted,
  state,
  dispatch,
  onCalculate,
  calculating,
  analysis,
  onAnalyze,
  onAnalyzeRecipe = () => {},
  shisoAnalysisState = { kind: 'idle', message: null },
  analysisRuns = 0,
  workingDirty = false,
  hydratedFromSaved = false,
  apply,
  ai,
  recipeContext,
}) => {
  const shiso = useShiso();
  const { dialogRef, onKeyDown } = useDialogFocus(isOpen, onClose);
  const [expandedLineRef, setExpandedLineRef] = useState<string | null>(null);
  const [changeFoodFor, setChangeFoodFor] = useState<string | null>(null);

  const preview = state.preview;
  const display = useMemo(
    () =>
      preview
        ? deriveDisplayNutrients(preview, state.basis, state.baseServings, state.selectedServings)
        : null,
    [preview, state.basis, state.baseServings, state.selectedServings]
  );
  const evidence = useMemo(() => (preview ? ingredientEvidenceViews(preview) : null), [preview]);
  const coverage = useMemo(() => (preview ? coverageSummary(preview) : null), [preview]);

  const analyzedByRef = useMemo(() => {
    const map = new Map<string, AnalyzedRow>();
    if (analysis) for (const row of analysis.rows) map.set(row.line_ref, row);
    return map;
  }, [analysis]);

  // The ONE central projection of every row's CURRENT effective state. It is
  // derived from live session state (food/portion/count/user-mass selections),
  // never from the analyzer snapshot or a memoized suggestion.
  const liveRows = useMemo(
    () =>
      projectLiveRows(
        state,
        analyzedByRef,
        adapted,
        session,
        evidence,
        analysis?.portions,
        analysis?.countPortions
      ),
    [state, analyzedByRef, adapted, session, evidence, analysis]
  );
  const liveByRef = useMemo(() => {
    const map = new Map<string, LiveRowState>();
    for (const live of liveRows) map.set(live.line_ref, live);
    return map;
  }, [liveRows]);
  // The SINGLE live-status authority: the summary below and every row badge
  // derive from this exact projection, so they can never disagree.
  const currentAiContributions = state.aiNutrition?.recipe_key === state.recipeKey &&
    state.aiNutrition?.servings === state.baseServings
    ? state.aiNutrition.contributions
    : [];
  const nutritionCoverage = useMemo(
    () => deriveNutritionCoverage(liveRows, currentAiContributions),
    [liveRows, currentAiContributions]
  );

  /**
   * H-2: the read snapshot is published by the CARD that always owns the
   * working review (see `AdvancedNutritionCard`). The modal deliberately no
   * longer publishes: a modal unmount would otherwise publish `null` and blank
   * the conversation's view of a review that is still open on the card.
   */
  const calculateCurrentRef = useRef(onCalculate);
  calculateCurrentRef.current = onCalculate;

  /**
   * SHISO CONFIRMATION — the authorized path from conversation to working review.
   *
   * The applier lives HERE, not in the conversation, because THIS component owns
   * the reducer, the session and the adapted recipe. Shiso may only ask. Every
   * proposal is revalidated against live state by `prepareShisoProposalActions`,
   * which asks the existing authorities; only the resulting existing actions are
   * dispatched, and the existing deterministic calculator then recomputes.
   *
   * Nothing here writes to the recipe or the Vault. The user still presses the
   * existing final Apply control.
   */
  useEffect(() => {
    if (!isOpen) return undefined;
    return shiso.registerApplier(async (bound) => {
      const prepared = prepareShisoProposalActions({
        bound,
        session,
        recipeKey: state.recipeKey ?? null,
        sessionIdentity: state.sessionIdentity ?? null,
        rows: state.rows,
        adapted,
      });
      if (!prepared.ok) return prepared;
      flushSync(() => { for (const action of prepared.actions) dispatch(action); });
      calculateCurrentRef.current();
      return prepared;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, session, state.recipeKey, state.sessionIdentity, state.rows, adapted, dispatch, onCalculate, shiso.registerApplier]);

  if (!isOpen) return null;

  const stale = state.status === 'preview_stale';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-nutrition-title"
        aria-describedby="advanced-nutrition-desc"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="my-2 w-full max-w-4xl overflow-y-auto rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-primary,#F3F4F6)] shadow-2xl focus:outline-none sm:my-4 max-h-[94vh]"
      >
        <div className="sticky top-0 z-10 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)]/95 backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 sm:gap-3 sm:px-5 sm:py-4">
            <div className="flex min-w-0 items-start gap-2.5 sm:gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)] sm:h-10 sm:w-10">
                <FlaskConical className="h-4.5 w-4.5 sm:h-5 sm:w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)] sm:block">Nutrition workspace</p>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="advanced-nutrition-title" className="font-serif text-[20px] leading-snug text-[var(--text-primary,#F3F4F6)] sm:text-[22px]">Advanced Nutrition</h2>
                  <span className="shrink-0 rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--text-secondary,#9CA3AF)] sm:text-[11px]">
                    Advisory
                  </span>
                </div>
                <p className="hidden text-[12px] text-[var(--text-secondary,#9CA3AF)] sm:block">Nutrition with SHISO</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="advanced-nutrition-ask-shiso"
                onClick={() => shiso.open('nutrition')}
                className="min-h-[44px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[13px] font-medium text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                title="Ask Shiso about this nutrition review"
              >
                Ask Shiso
              </button>
              <button
                type="button"
                data-testid="advanced-nutrition-close-without-saving"
                onClick={onClose}
                className="min-h-[44px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[13px] font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] hover:text-[var(--text-primary,#F3F4F6)]"
              >
                Close without saving
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close Advanced Nutrition"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] hover:text-[var(--text-primary,#F3F4F6)]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-4 py-5 sm:px-5">
          {state.rows.length > 0 && (
            <section aria-label="Review progress" className="space-y-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">Review progress</p>
                <p className="font-mono text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                  {nutritionCoverage.resolved} of {nutritionCoverage.total} ingredient line{nutritionCoverage.total === 1 ? '' : 's'} resolved
                </p>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-surface,#141414)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={nutritionCoverage.total}
                aria-valuenow={nutritionCoverage.resolved}
                aria-label="Ingredient lines resolved"
              >
                <div
                  className="h-full rounded-full bg-[var(--accent,#F59E0B)] transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${nutritionCoverage.total > 0 ? Math.round((nutritionCoverage.resolved / nutritionCoverage.total) * 100) : 0}%` }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="font-mono">{nutritionCoverage.source_backed}</span>{' '}
                  <span>USDA-sourced</span>
                </span>
                <span className="inline-flex items-baseline gap-x-2">
                  <span aria-hidden="true" className="text-[var(--text-muted,#6B7280)]">·</span>
                  <span className="inline-flex items-baseline gap-1.5">
                    <span className="font-mono">{nutritionCoverage.ai_estimated}</span>{' '}
                    <span>AI-estimated</span>
                  </span>
                </span>
                <span className="inline-flex items-baseline gap-x-2">
                  <span aria-hidden="true" className="text-[var(--text-muted,#6B7280)]">·</span>
                  <span className="inline-flex items-baseline gap-1.5">
                    <span className="font-mono">{nutritionCoverage.unresolved}</span>{' '}
                    <span>need attention</span>
                  </span>
                </span>
                {nutritionCoverage.excluded > 0 && (
                  <span className="inline-flex items-baseline gap-x-2">
                    <span aria-hidden="true" className="text-[var(--text-muted,#6B7280)]">·</span>
                    <span className="inline-flex items-baseline gap-1.5">
                      <span className="font-mono">{nutritionCoverage.excluded}</span>{' '}
                      <span>wrapper excluded</span>
                    </span>
                  </span>
                )}
              </div>
            </section>
          )}
          {/* SAVED vs WORKING distinction: the editor is a temporary draft. */}
          <div
            data-testid="advanced-nutrition-working-banner"
            className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-0.5"
          >
              <p className="text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)]">Working Advanced Nutrition review</p>
            <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
              {workingDirty
                ? 'Unsaved changes · nothing is written until Apply.'
                : hydratedFromSaved
                  ? 'Hydrated from the saved review · nothing is written until Apply.'
                : 'Nothing is changed in your recipe until Apply.'}
            </p>
          </div>

          {/* AI-ASSISTED EXCEPTION RESOLUTION (advisory only; optional and
              SECONDARY). AI suggests food search phrases and bounded amount/count
              interpretations; the pinned USDA catalog, the deterministic matcher,
              and authenticated USDA portions decide every resolution. Available
              for ANY actionable exception, not merely NEEDS MATCH. */}
          {ai && (ai.exceptionCount > 0 || ai.message !== null) && (
            <details className="group rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)]">
              <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-2 px-4 py-3 text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)]">
                <span>Manual ingredient review and corrections</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-secondary,#9CA3AF)] transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
              </summary>
              <div
              data-testid="advanced-nutrition-ai"
              className="p-3 pt-1 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p
                    data-testid="advanced-nutrition-ai-tier"
                    className="text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)]"
                  >
                    ✨ {AI_ADVANCED_NUTRITION_LABEL}
                  </p>
                  <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                    Review any ingredient that needs attention. Estimates stay labeled, and nothing is
                    saved automatically.
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="advanced-nutrition-ai-resolve"
                  disabled={!ai.available || ai.running || ai.exceptionCount === 0}
                  aria-disabled={!ai.available || ai.running || ai.exceptionCount === 0}
                  onClick={() => ai.onResolve()}
                  className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] px-3 text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {ai.running ? 'Resolving remaining ingredients…' : 'Resolve remaining with AI'}
                </button>
                {ai.onEstimateMassesWithAi && (
                  <button
                    type="button"
                    data-testid="advanced-nutrition-ai-estimate"
                    disabled={!ai.available || ai.running || ai.estimateRunning === true || ai.exceptionCount === 0}
                    aria-disabled={
                      !ai.available || ai.running || ai.estimateRunning === true || ai.exceptionCount === 0
                    }
                    onClick={ai.onEstimateMassesWithAi}
                    className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] px-3 text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {ai.estimateRunning === true
                      ? 'Estimating remaining amounts…'
                      : 'Estimate remaining amounts with AI'}
                  </button>
                )}
                {ai.estimateMessage !== undefined && ai.estimateMessage !== null && (
                  <p
                    data-testid="advanced-nutrition-ai-estimate-message"
                    className="w-full text-[12px] text-[var(--text-secondary,#9CA3AF)]"
                  >
                    {ai.estimateMessage}
                  </p>
                )}
                {ai.planAvailable === true && ai.onPlan !== undefined && (
                  <button
                    type="button"
                    data-testid="advanced-nutrition-ai-plan"
                    disabled={!ai.available || ai.running || ai.planRunning === true || ai.exceptionCount === 0}
                    aria-disabled={
                      !ai.available || ai.running || ai.planRunning === true || ai.exceptionCount === 0
                    }
                    onClick={ai.onPlan}
                    className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {ai.planRunning === true ? 'Planning candidates…' : 'Plan candidates with AI'}
                  </button>
                )}
              </div>
              {!ai.available && (
                <div className="flex flex-wrap items-center gap-2">
                  <p
                    data-testid="advanced-nutrition-ai-unavailable"
                    className="text-[12px] text-[var(--text-secondary,#9CA3AF)]"
                  >
                  {/* AI-5C: the shell distinguishes Basic product access, AI
                      Advanced with no usable provider, and an unverifiable
                      product status. Each message states only what the client
                      actually knows, and every one keeps the Basic manual path
                      visible. No billing, upgrade or paywall language exists,
                      because no billing or account system does. */}
                    {ai.unavailableReason ??
                      'AI Advanced Nutrition access couldn\'t be verified. Basic manual review and correction are still available.'}
                  </p>
                  {/* AI-5D: an explicit, user-triggered re-check. Offered only where a
                      re-check can help — a provider that may come back, or a status we
                      may not yet have verified. A definitive Basic product answer never
                      offers it. Disabled while a refresh is already running, so repeated
                      clicks cannot launch duplicate refreshes. */}
                  {ai.canRetry === true && ai.onRetry !== undefined && (
                    <button
                      type="button"
                      data-testid="advanced-nutrition-ai-retry"
                      disabled={ai.refreshing === true}
                      aria-disabled={ai.refreshing === true}
                      onClick={ai.onRetry}
                      className="min-h-[40px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[12px] font-semibold text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {ai.refreshing === true ? 'Checking AI availability…' : 'Retry AI availability'}
                    </button>
                  )}
                </div>
              )}
              {ai.message && (
                <p
                  data-testid="advanced-nutrition-ai-message"
                  role="status"
                  className="text-[13px] text-[var(--text-primary,#F3F4F6)] flex items-start justify-between gap-2"
                >
                  <span>{ai.message}</span>
                  <button
                    type="button"
                    onClick={ai.onDismissMessage}
                    className="min-h-[40px] shrink-0 rounded-lg px-2 text-[12px] text-[var(--text-secondary,#9CA3AF)] underline underline-offset-2 hover:text-[var(--text-secondary,#9CA3AF)]"
                  >
                    Dismiss
                  </button>
                </p>
              )}
              </div>
            </details>
          )}

          {/* AI-4D2 EXPLICIT RECIPE-CONTEXT REVIEW (session-only, no authority).

              The user asks for a review with ONE explicit click; the model output
              is then shown line by line as an INTERPRETATION, and only the user can
              accept or dismiss it. There is no auto-accept, no confidence
              threshold, no bulk action, and nothing here changes nutrition: no
              match, portion, mass, nutrient, preview, Apply or saved value. */}
          {recipeContext && (
            <details className="group rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)]">
              <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-2 px-4 py-3 text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)]">
                <span>Recipe context suggestions</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-secondary,#9CA3AF)] transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
              </summary>
              <div
              data-testid="advanced-nutrition-recipe-context"
              className="p-3 pt-1 space-y-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p
                    data-testid="advanced-nutrition-recipe-context-title"
                    className="text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)]"
                  >
                    {AI_RECIPE_CONTEXT_SECTION_LABEL}
                  </p>
                  <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                    AI reads the whole recipe and suggests how each line relates to the
                    others. Nothing is accepted for you, and nothing here changes
                    nutrition values.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="advanced-nutrition-recipe-context-review"
                    disabled={!recipeContext.available || recipeContext.running}
                    aria-disabled={!recipeContext.available || recipeContext.running}
                    onClick={recipeContext.onReview}
                    className="px-2.5 py-1 rounded-lg text-[13px] font-semibold bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] disabled:opacity-50"
                  >
                    {recipeContext.running ? 'Reviewing recipe context…' : AI_RECIPE_CONTEXT_REVIEW_LABEL}
                  </button>
                  {recipeContext.reviewStarted && !recipeContext.running && (
                    <button
                      type="button"
                      data-testid="advanced-nutrition-recipe-context-clear"
                      onClick={recipeContext.onClearReview}
                      className="px-2.5 py-1 rounded-lg text-[13px] font-medium bg-[var(--bg-elevated,#1E1E1E)] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-secondary,#9CA3AF)]"
                    >
                      {AI_RECIPE_CONTEXT_CLEAR_REVIEW_LABEL}
                    </button>
                  )}
                </div>
              </div>

              {!recipeContext.available && (
                <p
                  data-testid="advanced-nutrition-recipe-context-unavailable"
                  className="text-[12px] text-[var(--text-secondary,#9CA3AF)]"
                >
                  {/* AI-5C: recipe-context review follows the SAME composed
                      availability as the rest of the AI layer, so its reason
                      copy is truthful too — never "not entitled" when the
                      deployment IS entitled, and never a provider excuse when
                      the status itself could not be verified. */}
                  {recipeContext.unavailableReason ??
                    'AI Advanced Nutrition access couldn\'t be verified. Basic manual review and correction are still available.'}
                </p>
              )}

              {recipeContext.message !== null && (
                <p
                  data-testid="advanced-nutrition-recipe-context-message"
                  role="status"
                  className="text-[13px] text-[var(--text-primary,#F3F4F6)]"
                >
                  {recipeContext.message}
                </p>
              )}

              {recipeContext.rows.length > 0 && (
                <>
                  <p
                    data-testid="advanced-nutrition-recipe-context-summary"
                    className="text-[12px] text-[var(--text-secondary,#9CA3AF)]"
                  >
                    {`${recipeContext.accepted_count} accepted · ${recipeContext.dismissed_count} dismissed · ${recipeContext.pending_count} awaiting review · ${recipeContext.abstained_count} abstained · ${recipeContext.uninterpreted_count} not interpreted`}
                  </p>
                  <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">{AI_RECIPE_CONTEXT_NOTE}</p>
                  <ul className="space-y-1.5" data-testid="advanced-nutrition-recipe-context-rows">
                    {recipeContext.rows.map((row) => (
                      <li
                        key={row.line_ref}
                        data-testid={`advanced-nutrition-recipe-context-row-${row.line_ref}`}
                        data-status={row.status}
                        className="p-2 rounded-lg bg-[var(--bg-surface,#141414)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-1"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-[13px] text-[var(--text-primary,#F3F4F6)]">{row.source_text}</span>
                          <span
                            data-testid={`advanced-nutrition-recipe-context-status-${row.line_ref}`}
                            className="text-[12px] text-[var(--text-secondary,#9CA3AF)]"
                          >
                            {AI_RECIPE_CONTEXT_STATUS_LABEL[row.status]}
                          </span>
                        </div>
                        {row.status === 'pending' && row.role !== undefined && (
                          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                            {`${AI_RECIPE_CONTEXT_INTERPRETATION_LABEL}: ${formatRecipeContextTerm(row.role)}`}
                            {row.preparation_hints.length > 0
                              ? ` · ${row.preparation_hints.map(formatRecipeContextTerm).join(', ')}`
                              : ''}
                          </p>
                        )}
                        {row.status === 'accepted' && row.role !== undefined && (
                          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                            {`${AI_RECIPE_CONTEXT_INTERPRETATION_LABEL}: ${formatRecipeContextTerm(row.role)}`}
                            {row.preparation_hints.length > 0
                              ? ` · ${row.preparation_hints.map(formatRecipeContextTerm).join(', ')}`
                              : ''}
                          </p>
                        )}
                        {row.relations.length > 0 && row.status !== 'uninterpreted' && (
                          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                            {`${AI_RECIPE_CONTEXT_INTERPRETATION_LABEL}: ${row.relations
                              .map((relation) => `${formatRecipeContextTerm(relation.kind)} ${relation.target_ref}`)
                              .join('; ')}`}
                          </p>
                        )}
                        {row.explanation !== undefined && row.status !== 'uninterpreted' && (
                          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)] italic">
                            {`${AI_RECIPE_CONTEXT_INTERPRETATION_LABEL}: ${row.explanation}`}
                          </p>
                        )}
                        {row.confidence !== undefined && row.status !== 'uninterpreted' && (
                          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                            {`${AI_RECIPE_CONTEXT_INTERPRETATION_LABEL} confidence: ${row.confidence}`}
                          </p>
                        )}
                        {row.abstain_reason !== undefined && (
                          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                            {`${AI_RECIPE_CONTEXT_INTERPRETATION_LABEL}: abstained — ${
                              AI_RECIPE_CONTEXT_ABSTAIN_LABEL[row.abstain_reason]
                            }`}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {row.accept_capable && (
                            <button
                              type="button"
                              data-testid={`advanced-nutrition-recipe-context-accept-${row.line_ref}`}
                              aria-label={`${AI_RECIPE_CONTEXT_ACCEPT_LABEL} AI interpretation for ${row.source_text}`}
                              onClick={() => recipeContext.onAccept(row.line_ref)}
                              className="px-2 py-0.5 rounded-md text-[12px] font-semibold bg-[var(--accent-subtle,rgba(245,158,11,0.15))] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)]"
                            >
                              {AI_RECIPE_CONTEXT_ACCEPT_LABEL}
                            </button>
                          )}
                          {row.dismiss_capable && (
                            <button
                              type="button"
                              data-testid={`advanced-nutrition-recipe-context-dismiss-${row.line_ref}`}
                              aria-label={`${AI_RECIPE_CONTEXT_DISMISS_LABEL} AI interpretation for ${row.source_text}`}
                              onClick={() => recipeContext.onDismiss(row.line_ref)}
                              className="px-2 py-0.5 rounded-md text-[12px] font-semibold bg-[var(--bg-elevated,#1E1E1E)] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)]"
                            >
                              {AI_RECIPE_CONTEXT_DISMISS_LABEL}
                            </button>
                          )}
                          {row.undo_capable && (
                            <button
                              type="button"
                              data-testid={`advanced-nutrition-recipe-context-undo-${row.line_ref}`}
                              aria-label={`${AI_RECIPE_CONTEXT_UNDO_LABEL} your decision for ${row.source_text}`}
                              onClick={() => recipeContext.onUndo(row.line_ref)}
                              className="px-2 py-0.5 rounded-md text-[12px] font-semibold bg-[var(--bg-elevated,#1E1E1E)] hover:bg-[var(--bg-root,#0C0C0C)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-secondary,#9CA3AF)]"
                            >
                              {AI_RECIPE_CONTEXT_UNDO_LABEL}
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              </div>
            </details>
          )}

          {state.failure && (
            <div role="alert" className="p-3 rounded-xl bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] text-[var(--text-primary,#F3F4F6)] text-[14px] flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{state.failure.message}</span>
            </div>
          )}

          <details className="group text-[13px] text-[var(--text-secondary,#9CA3AF)]">
            <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)]"><span>Sources and calculation details</span><ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" /></summary>
            <p className="mt-2 font-mono">
              Source: USDA FoodData Central · bundle {session.metadata().bundle_release.slice(0, 24)}… · {session.metadata().record_count} eligible records
            </p>
          </details>

          <section aria-label="Display basis" className="space-y-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)]">Display basis</h3>
              <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">Stored totals are never changed.</p>
            </div>
            {assumedServingBasis ? (
              <p className="rounded-lg border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text-primary,#F3F4F6)]" data-testid="advanced-assumed-serving-basis">
                Recipe yield is not authored. Per-serving calculations use an assumed 4-serving basis; enter the recipe yield to replace this assumption. This does not change the saved recipe.
              </p>
            ) : null}
            <div role="radiogroup" aria-label="Display basis" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  ['entire_recipe', 'Entire recipe'],
                  ['per_serving', 'Per serving'],
                  ['selected_servings', 'Selected servings'],
                ] as ReadonlyArray<[BasisMode, string]>
              ).map(([mode, label]) => (
                <label
                  key={mode}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[14px] transition-colors ${
                    state.basis === mode
                      ? 'border-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--text-primary,#F3F4F6)]'
                      : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="advanced-basis"
                    value={mode}
                    checked={state.basis === mode}
                    onChange={() => dispatch({ type: 'set_basis', basis: mode })}
                    className="h-4 w-4 accent-[var(--accent,#F59E0B)]"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {state.basis === 'selected_servings' && (
              <label className="flex flex-wrap items-center gap-2 text-[14px] text-[var(--text-secondary,#9CA3AF)]">
                <span>Servings</span>
                <input
                  type="number"
                  aria-label="Requested servings"
                  value={state.selectedServings}
                  min={1}
                  max={1000}
                  onChange={(event) =>
                    dispatch({ type: 'set_servings', value: Number(event.target.value) })
                  }
                  className="min-h-[44px] w-24 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[var(--text-primary,#F3F4F6)]"
                />
              </label>
            )}
          </section>

          <section
            aria-label="Automatic ingredient analysis"
            data-testid="advanced-nutrition-analysis"
            className="space-y-3"
          >
            <div className="space-y-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4">
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">Analyze</p>
                <p className="text-[18px] font-serif text-[var(--text-primary,#F3F4F6)]">Nutrition with SHISO</p>
                <p className="text-[14px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                  Let SHISO review the recipe, use available food data, and clearly label estimates and unknowns. Review the result before applying it.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="advanced-nutrition-analyze-with-shiso"
                  onClick={onAnalyzeRecipe}
                  disabled={shisoAnalysisState.kind === 'running'}
                  aria-describedby="advanced-nutrition-shiso-status"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-amber-500 px-4 text-[14px] font-semibold text-black transition-colors hover:bg-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {shisoAnalysisState.kind === 'running' ? 'Analyzing Recipe…' : 'Analyze Recipe'}
                </button>
                <button
                  type="button"
                  data-testid="advanced-nutrition-analyze"
                  onClick={onAnalyze}
                  disabled={calculating || (analysis === null && !session)}
                  className="inline-flex min-h-[44px] items-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-4 text-[14px] font-medium text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {calculating ? 'Calculating…' : 'Calculate Without AI'}
                </button>
              </div>
              <p
                id="advanced-nutrition-shiso-status"
                data-testid="advanced-nutrition-shiso-status"
                role={shisoAnalysisState.kind === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`text-[14px] ${shisoAnalysisState.kind === 'error' ? 'text-[var(--text-primary,#F3F4F6)]' : shisoAnalysisState.kind === 'success' ? 'text-[var(--text-primary,#F3F4F6)]' : 'text-[var(--text-secondary,#9CA3AF)]'}`}
              >
                {shisoAnalysisState.message ?? (shisoAnalysisState.kind === 'idle' ? 'Analysis creates a review only. Apply and Vault saving are separate steps.' : '')}
              </p>
            </div>

            {analysis && (
              <p
                data-testid="advanced-nutrition-analysis-runs"
                className="text-[12px] font-mono uppercase text-[var(--text-secondary,#9CA3AF)]"
              >
                {analysisRuns > 0 ? `Source review run ${analysisRuns} · ` : ''}
                {/* LIVE STATUS SUMMARY: exact counts of the CURRENT rendered rows. */}
                <span data-testid="advanced-nutrition-live-summary">
                  {nutritionCoverage.source_backed} source-backed · {nutritionCoverage.ai_estimated} AI estimated ·{' '}
                  {nutritionCoverage.source_backed_contributions} other source-backed · {nutritionCoverage.partial_known} partial known ·{' '}
                  {nutritionCoverage.excluded} excluded wrapper(s) ·{' '}
                  {nutritionCoverage.unresolved} need attention ({nutritionCoverage.needs_amount} amount, {nutritionCoverage.needs_match} match,{' '}
                  {nutritionCoverage.review_suggested} source review) · {nutritionCoverage.qualitative} qualitative
                </span>
              </p>
            )}

            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">Ingredient review</p>
                <h3 className="font-serif text-[18px] text-[var(--text-primary,#F3F4F6)]">
                  {state.rows.length} ingredient line{state.rows.length === 1 ? '' : 's'}
                </h3>
              </div>
              <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                Open a line to change its source food, portion, or weight. Nothing changes until Apply.
              </p>
            </div>

            <ul className="space-y-2">
              {state.rows.map((row) => {
                const choice = state.matches[row.line_ref];
                const live = liveByRef.get(row.line_ref);
                const status: LiveRowStatus = live?.status ?? 'needs_match';
                const effective = nutritionCoverage.lines.find((line) => line.line_ref === row.line_ref);
                const displayContribution = effective?.contribution ?? effective?.candidate_contribution;
                const rowAccentClass =
                  status === 'qualitative'
                    ? 'border-l-[var(--border-subtle,rgba(255,255,255,0.08))]'
                    : effective?.contribution !== undefined || status === 'matched'
                      ? 'border-l-[var(--border-subtle,rgba(255,255,255,0.08))]'
                      : 'border-l-[var(--accent-text,#F59E0B)]';
                const fdcId = live?.selected_fdc_id;
                const entry = adapted.find((item) => item.line_ref === row.line_ref);
                const expanded = expandedLineRef === row.line_ref;
                const parsedRow = entry ? ingredientMeasurement(entry) : undefined;
                const rowAmount = parsedRow ? parsedRow.amount : null;
                const rowUnit = parsedRow ? parsedRow.raw_unit : undefined;
                const description = live?.selected_description;
                const massText = live ? liveMassText(live) : undefined;
                const changingFood = changeFoodFor === row.line_ref;
                const showCandidates =
                  row.outcome === 'review_required' && (fdcId === undefined || changingFood);
                return (
                  <li
                    key={row.line_ref}
                    data-testid="advanced-nutrition-row"
                    className={`space-y-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] bg-[var(--bg-surface,#141414)] p-3 ${rowAccentClass}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[15px] leading-snug text-[var(--text-primary,#F3F4F6)]">{row.original_text || row.query}</p>
                        {description && !effective?.contribution ? (
                          <p className="text-[13px] text-[var(--text-primary,#F3F4F6)] truncate">
                            {description}
                            {massText !== undefined ? (
                              <span className="text-[var(--text-secondary,#9CA3AF)]"> · {massText}</span>
                            ) : (
                              <span className="text-[var(--text-secondary,#9CA3AF)]">
                                {' '}
                                · amount —
                                {rowAmount !== null && rowUnit ? ` (recipe ${rowAmount} ${rowUnit})` : ''}
                              </span>
                            )}
                            {choice?.aiAssisted === true && (
                              <span
                                data-testid="advanced-nutrition-ai-badge"
                                className="text-[var(--accent-text,#F59E0B)]"
                                title="Food discovered with AI-assisted interpretation; the pinned USDA catalog and deterministic matcher accepted it."
                              >
                                {' '}
                                · {choice?.aiAccepted === true ? 'AI-assisted USDA match' : 'AI-assisted'}
                              </span>
                            )}
                            {state.countPortions[row.line_ref]?.aiAssisted === true && (
                              <span
                                data-testid="advanced-nutrition-ai-amount-badge"
                                className="text-[var(--accent-text,#F59E0B)]"
                                title="The count identity was AI-interpreted; the mass comes from one authenticated USDA count portion that the deterministic calculator re-verified."
                              >
                                {' '}
                                · AI-assisted USDA count portion
                              </span>
                            )}
                          </p>
                        ) : effective?.status === 'excluded' && effective.candidate_contribution ? (
                          <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                            Excluded cooking wrapper · {effective.candidate_contribution.exclusion_assumption}
                          </p>
                        ) : displayContribution ? (
                          <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                            {effective?.contribution ? 'Nutrition contribution accepted' : 'AI contribution has no known nutrient values'}
                            {' · '}{displayContribution.weight_grams !== undefined
                              ? `${displayContribution.weight_grams} g estimated weight`
                              : 'weight unknown'}
                            {effective?.partial_known ? ` · ${effective.unknown_nutrients.length} nutrient(s) remain unknown` : ''}
                          </p>
                        ) : (
                          <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                            {status === 'review_suggested'
                              ? 'Best candidate needs your confirmation.'
                              : status === 'needs_match'
                                ? 'No confident source match.'
                                : status === 'qualitative'
                                  ? 'Qualitative — not measurable.'
                                  : 'Not analyzed yet.'}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {effective?.status === 'excluded' ? (
                          <span data-testid="advanced-nutrition-effective-status" className="text-[12px] font-mono uppercase px-2 py-0.5 rounded-full border bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)] border-[var(--border-subtle,rgba(255,255,255,0.08))]">
                            Excluded · cooking wrapper
                          </span>
                        ) : displayContribution && (
                          <span
                            data-testid="advanced-nutrition-effective-status"
                            className={`text-[12px] font-mono uppercase px-2 py-0.5 rounded-full border ${effective?.contribution ? 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--text-primary,#F3F4F6)] border-[var(--border-subtle,rgba(255,255,255,0.08))]' : 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--text-primary,#F3F4F6)] border-[var(--border-subtle,rgba(255,255,255,0.08))]'}`}
                          >
                            {effective?.contribution
                              ? `${displayContribution.classification === 'ai_estimate' ? 'AI Estimated' : 'Source-backed'}${effective.partial_known ? ' · Partial' : ''}`
                              : 'AI Estimate Incomplete'}
                          </span>
                        )}
                        {!effective?.contribution && effective?.status !== 'excluded' && (
                          <span
                            data-testid="advanced-nutrition-row-status"
                            className={`text-[12px] font-mono uppercase px-2 py-0.5 rounded-full border ${LIVE_STATUS_CLASS[status]}`}
                          >
                            {LIVE_ROW_STATUS_LABEL[status]}
                          </span>
                        )}
                        <button
                          type="button"
                          data-testid="advanced-nutrition-edit"
                          onClick={() =>
                            setExpandedLineRef(expanded ? null : row.line_ref)
                          }
                          aria-expanded={expanded}
                          className="inline-flex min-h-[44px] items-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                        >
                          {expanded ? 'Close' : 'Edit'}
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="pt-1 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-2">
                        {displayContribution && description && (
                          <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">USDA reference: {description} · {massText ?? 'No source-backed mass available'}</p>
                        )}
                        {displayContribution && (
                          <section className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-2 space-y-1" data-testid="advanced-nutrition-contribution-details">
                            <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                              {effective?.contribution
                                ? (displayContribution.classification === 'ai_estimate' ? 'AI-estimated nutrition' : 'Source-backed contribution')
                                : 'Incomplete AI-estimated contribution — no known nutrient values'}
                              {' · '}{displayContribution.weight_grams !== undefined
                                ? `${displayContribution.weight_grams} g ${displayContribution.classification === 'ai_estimate' ? 'estimated weight' : 'source-backed weight'}`
                                : 'weight unknown'}
                            </p>
                            <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                              Known nutrients: {Object.entries(displayContribution.nutrients).map(([id, value]) => `${id.replace(/_/g, ' ')} ${value.amount} ${value.unit}`).join(' · ') || 'none'}
                            </p>
                            <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                              Unknown nutrients: {displayContribution.unknown_nutrients.length ? displayContribution.unknown_nutrients.map((id) => id.replace(/_/g, ' ')).join(', ') : 'none reported'}
                            </p>
                            {displayContribution.assumptions.length > 0 && (
                              <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">Assumptions: {displayContribution.assumptions.join(' · ')}</p>
                            )}
                            {displayContribution.sources.length > 0 && (
                              <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">Sources: {displayContribution.sources.map((source) => source.title).join(' · ')}</p>
                            )}
                            <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">USDA review row: {LIVE_ROW_STATUS_LABEL[effective.source_status]}</p>
                          </section>
                        )}
                        {row.outcome === 'matched_exact' && (
                          <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                            Matched automatically as the single exact source description. This was not
                            manually confirmed by you.
                          </p>
                        )}

                        {fdcId !== undefined && (
                          <div className="space-y-1" data-testid="advanced-nutrition-food-summary">
                            <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                              Food:{' '}
                              <span className="text-[var(--text-primary,#F3F4F6)] font-medium">
                                {description ?? 'Selected source'}
                              </span>
                              {choice?.kind === 'manual' && choice?.aiAssisted !== true && (
                                <span className="text-[var(--text-secondary,#9CA3AF)]"> · user-selected from USDA search</span>
                              )}
                              {choice?.aiAssisted === true && (
                                <span className="text-[var(--accent-text,#F59E0B)]">
                                  {' '}
                                  · {choice?.aiAccepted === true ? 'AI-assisted USDA match' : 'AI-assisted · user-confirmed'}
                                </span>
                              )}
                            </p>
                            {row.outcome === 'review_required' && (
                              <button
                                type="button"
                                data-testid="advanced-nutrition-change-food"
                                onClick={() =>
                                  setChangeFoodFor(changingFood ? null : row.line_ref)
                                }
                                className="min-h-[36px] rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 text-[12px] text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                              >
                                {changingFood ? 'Cancel change' : 'Change food'}
                              </button>
                            )}
                          </div>
                        )}
                        {row.outcome === 'review_required' && showCandidates && (
                          <fieldset className="space-y-1">
                            <legend className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                              Choose the source food for {row.original_text}
                            </legend>
                            {row.candidates.map((candidate) => (
                              <label
                                key={candidate.fdc_id}
                                className="flex items-start gap-2 text-[13px] text-[var(--text-primary,#F3F4F6)] cursor-pointer"
                              >
                                <input
                                  type="radio"
                                  name={`match-${row.line_ref}`}
                                  checked={
                                    choice?.kind === 'candidate' && choice.fdc_id === candidate.fdc_id
                                  }
                                  onChange={() => {
                                    dispatch({
                                      type: 'select_match',
                                      lineRef: row.line_ref,
                                      choice: {
                                        kind: 'candidate',
                                        fdc_id: candidate.fdc_id,
                                        review_digest: row.review_digest ?? '',
                                      },
                                    });
                                    setChangeFoodFor(null);
                                  }}
                                  className="mt-0.5"
                                />
                                <span>
                                  {candidate.description}{' '}
                                  <span className="text-[var(--text-secondary,#9CA3AF)]">
                                    · {candidate.data_type} · FDC {candidate.fdc_id} ·{' '}
                                    {candidate.rank_evidence}
                                  </span>
                                  {candidate.portion_annotation && (
                                    <span className="block text-[12px] text-[var(--accent-text,#F59E0B)]">
                                      {candidate.portion_annotation}
                                    </span>
                                  )}
                                </span>
                              </label>
                            ))}
                            <label className="flex items-start gap-2 text-[13px] text-[var(--text-primary,#F3F4F6)] cursor-pointer">
                              <input
                                type="radio"
                                name={`match-${row.line_ref}`}
                                checked={choice?.kind === 'none'}
                                onChange={() => {
                                  dispatch({
                                    type: 'select_match',
                                    lineRef: row.line_ref,
                                    choice: { kind: 'none', review_digest: row.review_digest ?? '' },
                                  });
                                  setChangeFoodFor(null);
                                }}
                                className="mt-0.5"
                              />
                              <span>None of these</span>
                            </label>
                          </fieldset>
                        )}

                        {(row.outcome === 'matched_exact' ||
                          row.outcome === 'review_required' ||
                          row.outcome === 'unmatched') && (
                          <FoodSearchPanel
                            row={row}
                            session={session}
                            dispatch={dispatch}
                            onApplied={() => setChangeFoodFor(null)}
                          />
                        )}

                        {(row.outcome === 'unmatched' || row.outcome === 'invalid') && !effective?.contribution && (
                          <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                            {row.outcome === 'unmatched'
                              ? 'No USDA source candidate shares this ingredient automatically. Search USDA below to choose one, or it contributes nothing.'
                              : 'This ingredient line could not be parsed safely. It contributes nothing.'}
                          </p>
                        )}

                        {ai && liveExceptionKind(status) !== undefined && (
                          <div className="space-y-1" data-testid="advanced-nutrition-ai-row">
                            <button
                              type="button"
                              data-testid="advanced-nutrition-ai-help"
                              disabled={!ai.available || ai.running}
                              aria-disabled={!ai.available || ai.running}
                              onClick={() => ai.onResolve(row.line_ref)}
                              className="min-h-[40px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-[12px] text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {ai.running ? 'Asking AI…' : 'Ask AI for help'}
                            </button>
                            {ai.suggestions[row.line_ref] && (
                              <div
                                data-testid="advanced-nutrition-ai-suggestion"
                                className="p-2 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-1"
                              >
                                <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                                  AI-suggested USDA match:{' '}
                                  <span className="text-[var(--text-primary,#F3F4F6)]">
                                    {ai.suggestions[row.line_ref].description}
                                  </span>
                                </p>
                                <button
                                  type="button"
                                  data-testid="advanced-nutrition-ai-use"
                                  onClick={() => ai.onUseSuggestion(row.line_ref)}
                                  className="min-h-[40px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] px-3 text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                                >
                                  Use this match
                                </button>
                              </div>
                            )}
                            {ai.amountOffers[row.line_ref] && ai.amountOffers[row.line_ref].length > 0 && (
                              <div
                                data-testid="advanced-nutrition-ai-amount-offers"
                                className="p-2 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-1"
                              >
                                <p className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                                  AI interpreted “{row.original_text || row.query}”; choose an
                                  authenticated USDA portion:
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {ai.amountOffers[row.line_ref].map((offer) => (
                                    <button
                                      key={offer.portion_index}
                                      type="button"
                                      data-testid="advanced-nutrition-ai-amount-use"
                                      onClick={() => ai.onUseAmountOffer(row.line_ref, offer.portion_index)}
                                      className="min-h-[40px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] px-3 text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                                    >
                                      Use {offer.display_label} → {Math.round(offer.resolved_grams * 10) / 10} g
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                        {ai.estimateOffers?.[row.line_ref] !== undefined && (
                          <div
                            data-testid="advanced-nutrition-ai-estimate-offer"
                            className="p-2 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--border-subtle,rgba(255,255,255,0.08))] space-y-1"
                          >
                            <p
                              data-testid="advanced-nutrition-ai-estimate-label"
                              className="text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)]"
                            >
                              {ai.estimateOffers[row.line_ref]?.label}
                            </p>
                            <p
                              data-testid="advanced-nutrition-ai-estimate-range"
                              className="text-[13px] text-[var(--text-primary,#F3F4F6)]"
                            >
                              {ai.estimateOffers[row.line_ref] !== undefined
                                ? formatAiEstimateOfferSummary(ai.estimateOffers[row.line_ref] as AiEstimateOffer)
                                : ''}
                            </p>
                            {ai.estimateOffers[row.line_ref]?.notes !== undefined && (
                              <p
                                data-testid="advanced-nutrition-ai-estimate-note"
                                className="text-[12px] text-[var(--text-secondary,#9CA3AF)] italic"
                              >
                                {ai.estimateOffers[row.line_ref]?.notes}
                              </p>
                            )}
                            {ai.onUseEstimateOffer && (
                              <button
                                type="button"
                                data-testid="advanced-nutrition-ai-estimate-use"
                                onClick={() => ai.onUseEstimateOffer?.(row.line_ref)}
                                className="min-h-[40px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] px-3 text-[12px] font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                              >
                                Use this estimate
                              </button>
                            )}
                          </div>
                        )}
                          </div>
                        )}
                        {row.outcome === 'qualitative' && (
                          <p className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                            Qualitative ingredient — it is not treated as measurable and contributes no
                            mass.
                          </p>
                        )}

                        {fdcId !== undefined && (
                          <PortionControls
                            row={row}
                            fdcId={fdcId}
                            session={session}
                            state={state}
                            dispatch={dispatch}
                            adapted={adapted}
                            live={live}
                          />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">Calculate</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                Build an advisory preview from the reviewed ingredient lines. Nothing is applied automatically.
              </p>
            </div>
            <button
              type="button"
              onClick={onCalculate}
              disabled={calculating}
              className="inline-flex min-h-[44px] items-center rounded-lg bg-amber-500 px-4 text-[14px] font-semibold text-black transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {calculating ? 'Calculating…' : preview ? 'Recalculate Preview' : 'Calculate Preview'}
            </button>
          </div>

          {preview && (
            <section aria-label="Advisory nutrition preview" className="space-y-4 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">Preview</p>
                    <h3 className="font-serif text-[18px] text-[var(--text-primary,#F3F4F6)]">Advisory nutrition preview</h3>
                  </div>
                </div>
                {stale && (
                  <span className="rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-[var(--text-primary,#F3F4F6)]">
                    Stale — recalculate
                  </span>
                )}
              </div>

              <dl className="grid grid-cols-1 gap-x-5 gap-y-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-3 text-[13px] sm:grid-cols-2">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-[var(--text-secondary,#9CA3AF)]">Basis</dt>
                  <dd className="text-right text-[var(--text-primary,#F3F4F6)]">{basisLabel(state.basis, state.selectedServings)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-[var(--text-secondary,#9CA3AF)]">Status</dt>
                  <dd className="text-right font-mono text-[var(--text-primary,#F3F4F6)]">{preview.status}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-[var(--text-secondary,#9CA3AF)]">Nutrients in scope</dt>
                  <dd className="text-right font-mono text-[var(--text-primary,#F3F4F6)]">{preview.nutrient_scope.length}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-[var(--text-secondary,#9CA3AF)]">Unresolved ingredients</dt>
                  <dd className="text-right font-mono text-[var(--text-primary,#F3F4F6)]">{preview.unresolved.length}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[var(--text-secondary,#9CA3AF)]">Ingredient digest</dt>
                  <dd className="mt-0.5 break-all font-mono text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                    {preview.ingredient_digest.slice(0, 32)}…
                  </dd>
                </div>
              </dl>

              {coverage && (
                <p className="text-[13px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                  Coverage: <span className="text-[var(--text-primary,#F3F4F6)]">{coverage.status}</span> · {coverage.unresolved_count} of {coverage.total_ingredients}{' '}
                  ingredient lines unresolved.
                </p>
              )}

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {NUTRIENT_GROUPS.map((group) => {
                  const rows = (display ?? []).filter((nutrient) => group.nutrients.includes(nutrient.nutrient));
                  if (rows.length === 0) return null;
                  return (
                    <div key={group.id} className="space-y-1.5 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-4 py-3">
                      <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary,#9CA3AF)]">
                        {group.label}
                      </h4>
                      <ul>
                        {rows.map((nutrient) => (
                          <li
                            key={nutrient.nutrient}
                            className="flex items-baseline justify-between gap-3 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] py-1.5 text-[13px] last:border-b-0"
                          >
                            <span className="min-w-0 text-[var(--text-secondary,#9CA3AF)]">{nutrient.label}</span>
                            <span className="flex shrink-0 items-baseline gap-2 text-right font-mono text-[var(--text-primary,#F3F4F6)]">
                              <span>
                                {formatAmount(nutrient.amount)}
                                {nutrient.amount !== undefined ? ` ${nutrient.unit_label}` : ''}
                              </span>
                              <span className="min-w-[56px] text-right text-[var(--text-secondary,#9CA3AF)]">
                                {formatDailyValue(nutrient.percent_daily_value)} DV
                              </span>
                              {nutrient.coverage === 'partial' && (
                                <span className="rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary,#F3F4F6)]">partial</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>

              {evidence && (
                <details className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)]">
                  <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)]">
                    Ingredient evidence · {evidence.length} line{evidence.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="space-y-1.5 px-4 pb-3">
                    {evidence.map((entry) => {
                      const live = liveByRef.get(entry.line_ref);
                      const foodAuthority =
                        live?.food_authority === 'automatic'
                          ? 'automatic food'
                          : live?.food_authority === 'unique_exact'
                            ? 'unique-exact food'
                            : live?.food_authority === 'user_confirmed' || entry.user_confirmed
                              ? 'user-confirmed food'
                              : undefined;
                      // Mass provenance is INDEPENDENT of food authority.
                      const portionAuthority =
                        entry.mass_source === 'source_portion'
                          ? live?.source_portion_automatic
                            ? 'auto-selected portion'
                            : 'user-selected portion'
                          : undefined;
                      return (
                        <li key={entry.line_ref} className="text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                          <span className="text-[var(--text-primary,#F3F4F6)]">{entry.original_text}</span> — {entry.outcome}
                          {entry.fdc_id !== undefined ? ` · FDC ${entry.fdc_id}` : ''}
                          {' · '}
                          {massSourceLabel(entry)}
                          {portionAuthority ? ` · ${portionAuthority}` : ''}
                          {entry.resolved_grams !== undefined ? ` → ${entry.resolved_grams} g` : ''}
                          {countDerivationLabel(entry) ? ` · ${countDerivationLabel(entry)}` : ''}
                          {foodAuthority ? ` · ${foodAuthority}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}

              {preview.ai_contributions && preview.ai_contributions.length > 0 && (
                <div aria-label="AI nutrition contributions" className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary,#9CA3AF)]">
                    AI-estimated ingredient contributions
                  </h4>
                  <ul className="space-y-2">
                    {preview.ai_contributions.map((entry) => (
                      <li key={entry.line_ref} className="space-y-1 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] p-3 text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-[var(--text-primary,#F3F4F6)]">{entry.ingredient}</span>
                          <span className="rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2 py-0.5 text-[11px] text-[var(--text-primary,#F3F4F6)]">
                            {entry.classification === 'source_backed' ? 'Source-backed' : 'AI estimate'}
                          </span>
                          <span className="text-[var(--text-secondary,#9CA3AF)]">{entry.quantity_basis}{entry.weight_grams !== undefined ? ` · ${entry.classification === 'source_backed' ? 'Source-backed' : 'Estimated'} weight: ${entry.weight_grams} g` : ' · Weight unknown'}</span>
                        </div>
                        <p>{Object.entries(entry.nutrients).map(([id, value]) => `${id}: ${value?.amount} ${value?.unit}`).join(' · ') || 'No nutrient values established'}</p>
                        {entry.unknown_nutrients.length > 0 && <p className="text-[var(--text-primary,#F3F4F6)]">Unknown: {entry.unknown_nutrients.join(', ')}</p>}
                        {entry.assumptions.length > 0 && <ul className="list-inside list-disc text-[var(--text-secondary,#9CA3AF)]">{entry.assumptions.map((assumption, index) => <li key={`${entry.line_ref}-assumption-${index}`}>{assumption}</li>)}</ul>}
                        {entry.sources.length > 0 && <p className="text-[var(--text-secondary,#9CA3AF)]">References: {entry.sources.map((source) => source.title).join(', ')}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.unresolved.length > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] p-3 text-[13px] text-[var(--text-primary,#F3F4F6)]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                  <div>
                    <p className="font-semibold">Some ingredient lines are unresolved.</p>
                    <ul className="list-inside list-disc text-[var(--text-secondary,#9CA3AF)]">
                      {preview.unresolved.map((entry) => (
                        <li key={entry.line_ref}>
                          {entry.line_ref}: {entry.outcome}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                This advisory preview combines available food data{preview.ai_contributions?.length ? ' and labeled AI estimates' : ''}. Apply updates the working recipe; Save to Vault is a separate explicit step. This is not medical advice and does not claim complete
                  nutritional coverage.
                </span>
              </p>

              {apply && (
                <section
                  aria-label="Apply advanced nutrition"
                  className="space-y-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-serif text-[17px] text-[var(--text-primary,#F3F4F6)]">Apply advanced nutrition</h3>
                    <span className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">Apply updates the working recipe. Save to Vault is a separate step.</span>
                  </div>
                  {apply.status === 'success' && apply.message && (
                    <p role="status" className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                      {apply.message}
                    </p>
                  )}
                  {apply.status === 'success' && apply.onSave && (
                    <button
                      type="button"
                      data-testid="advanced-nutrition-save-working"
                      onClick={apply.onSave}
                      className="min-h-[44px] rounded-lg bg-amber-500 px-4 text-[13px] font-semibold text-black transition-colors hover:bg-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)]"
                    >
                      Save to Vault
                    </button>
                  )}
                  {apply.status === 'error' && apply.message && (
                    <p role="alert" className="text-[13px] text-[var(--text-primary,#F3F4F6)]">
                      {apply.message}
                    </p>
                  )}

                  {apply.status === 'confirming' ? (
                    <div className="space-y-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-surface,#141414)] p-3 text-[13px] text-[var(--text-primary,#F3F4F6)]">
                      <p>
                        {apply.mode === 'replace'
                          ? 'Apply will replace the existing Advanced Nutrition block in this working recipe.'
                          : 'Apply will add Advanced Nutrition to this working recipe. You can save it to your Vault afterward.'}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={apply.onConfirm}
                          className="min-h-[44px] rounded-lg bg-amber-500 px-4 text-[13px] font-semibold text-black transition-colors hover:bg-amber-400"
                        >
                          Confirm Apply
                        </button>
                        <button
                          type="button"
                          onClick={apply.onCancel}
                          className="min-h-[44px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 text-[13px] font-medium text-[var(--text-primary,#F3F4F6)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                        Nothing is written until you confirm.
                      </span>
                      <button
                        type="button"
                        onClick={apply.onRequest}
                        disabled={apply.eligible !== true || apply.status === 'applying'}
                        aria-disabled={apply.eligible !== true || apply.status === 'applying'}
                        className="min-h-[44px] rounded-lg bg-amber-500 px-4 text-[13px] font-semibold text-black transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {apply.status === 'applying'
                          ? 'Applying…'
                          : apply.mode === 'replace'
                            ? 'Apply and replace saved nutrition'
                            : 'Apply to recipe'}
                      </button>
                    </div>
                  )}

                  {apply.eligible !== true && apply.status !== 'applying' && apply.status !== 'confirming' && (
                    <p className="text-[12px] text-[var(--text-primary,#F3F4F6)]">
                      Apply is unavailable until the reviewed result is eligible.
                    </p>
                  )}
                </section>
              )}
            </section>
          )}

          <p id="advanced-nutrition-desc" className="text-[13px] text-[var(--text-secondary,#9CA3AF)]">
            {PHASE4_NOT_MEDICAL_ADVICE}
          </p>

          <p className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">
            Recipe: {title}. Review before Apply. Applying updates the working recipe; Save to Vault is always explicit.
          </p>
        </div>
      </div>
    </div>
  );
};
