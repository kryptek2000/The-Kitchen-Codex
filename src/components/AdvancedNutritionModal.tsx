import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ShieldAlert, FlaskConical, CheckCircle2, AlertTriangle, Info, Search } from 'lucide-react';
import { convertMassToGrams, type NormalizedUnit } from '../utils/measurements';
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
  summarizeLiveRows,
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
  readonly running: boolean;
  readonly message: string | null;
  readonly suggestions: Readonly<Record<string, AdvancedNutritionAiSuggestion>>;
  readonly amountOffers: Readonly<Record<string, ReadonlyArray<AdvancedNutritionAiAmountOffer>>>;
  /** Actionable rows (needs_match + review_suggested + needs_amount). */
  readonly exceptionCount: number;
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
  matched: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  review_suggested: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/25',
  needs_amount: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  needs_match: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  qualitative: 'bg-white/5 text-gray-400 border-white/10',
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
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    return () => {
      const restore = restoreRef.current;
      if (restore && typeof restore.focus === 'function') restore.focus();
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
    <div className="mt-2 pl-3 border-l border-white/10 space-y-3">
      {measurementKind === 'mass' ? (
        // DIRECT-MASS EXCLUSIVITY: a line that already declares its own recipe
        // mass has complete mass authority. No alternate mass choice (source
        // portion, count portion, or manual total weight) is offered, retained,
        // or displayed as active; the bounded note is the only content.
        <p data-testid="advanced-nutrition-direct-mass-note" className="text-[10px] text-gray-500">
          {PHASE4_DIRECT_MASS_NOTE}
        </p>
      ) : (
        <>
      {currentHousehold && (
        <div className="space-y-1" data-testid="advanced-nutrition-household-portion">
          <div className="flex items-center gap-2">
            <h4 className="text-[11px] font-semibold text-gray-300">
              {verifiedHousehold === undefined
                ? 'Stored household portion'
                : verifiedHousehold.household_authority_class === 'bounded_estimate'
                  ? 'Kitchen Codex household estimate'
                  : 'Kitchen Codex household portion'}
            </h4>
            <span className="text-[10px] text-gray-500">
              {verifiedHousehold?.household_unit ??
                currentHousehold.record_key.split('|')[1] ??
                'item'}
            </span>
            <button
              type="button"
              onClick={() => dispatch({ type: 'clear_household_portion', lineRef: row.line_ref })}
              className="px-2 py-0.5 rounded-lg text-[11px] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              Clear
            </button>
          </div>
          <p className="text-[10px] text-gray-500">
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
            <h4 className="text-[11px] font-semibold text-gray-300">USDA count portions</h4>
            {currentCount && (
              <span className="text-[11px] text-emerald-300 font-medium">Count portion selected</span>
            )}
          </div>
          {error && (
            <p role="alert" className="text-[11px] text-amber-300">
              {error}
            </p>
          )}
          {countCandidates.length === 0 && (
            <p className="text-[11px] text-gray-500">
              No compatible authenticated count portion for this food. Count mass stays unresolved.
            </p>
          )}
          {deterministicCandidate && deterministicTotal !== undefined && countAmount !== null && (
            <p className="text-[11px] text-emerald-300">
              {countAmount} {deterministicUnit}
              {countAmount === 1 ? '' : 's'} × {deterministicCandidate.gram_weight} g per{' '}
              {deterministicUnit} = {deterministicTotal} g
              <span className="text-gray-400"> · deterministic (applied automatically)</span>
            </p>
          )}
          {!countDeterministic && countCandidates.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="text-[11px] text-gray-400">
                Choose an authenticated count portion for {row.original_text}
              </legend>
              {countCandidates.map((candidate) => (
                <label
                  key={candidate.index}
                  className="flex items-start gap-2 text-[11px] text-gray-200 cursor-pointer"
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
          <h4 className="text-[11px] font-semibold text-gray-300">USDA source portions</h4>
          <button
            type="button"
            onClick={load}
            className="px-2 py-0.5 rounded-md text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 transition-colors"
          >
            Review source portions
          </button>
          {current && (
            <span className="text-[11px] text-emerald-300 font-medium">Source portion selected</span>
          )}
        </div>
        {recipeAmount !== null && recipeUnit && (
          <p data-testid="advanced-nutrition-recipe-amount" className="text-[11px] text-gray-300">
            Recipe amount: <span className="font-mono text-white">{recipeAmount} {recipeUnit}</span>
          </p>
        )}
        {error && (
          <p role="alert" className="text-[11px] text-amber-300">
            {error}
          </p>
        )}
        {candidates && (
          <fieldset className="space-y-1">
            <legend className="text-[11px] text-gray-400">
              Choose an authenticated source portion for {row.original_text}
            </legend>
            {candidates.length === 0 && (
              <p className="text-[11px] text-gray-500">
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
                    className={`flex items-start gap-2 text-[11px] ${disabled ? 'text-gray-500 cursor-not-allowed' : 'text-gray-200 cursor-pointer'}`}
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
                        <span className="text-amber-300">
                          {compatibility === 'unusable'
                            ? ' · unusable source portion'
                            : ' · not compatible with this measurement'}
                        </span>
                      )}
                    </span>
                  </label>
                  {total !== undefined && (
                    <span className="text-[11px] text-indigo-300">
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
            <h4 className="text-[11px] font-semibold text-gray-300">{PHASE4_USER_MASS_LABEL}</h4>
            {currentUserMass && (
              <span className="text-[11px] text-emerald-300 font-medium">
                Weight entered ({currentUserMass.quantity} {currentUserMass.unit})
              </span>
            )}
          </div>
          <p className="text-[10px] text-gray-500">{PHASE4_USER_MASS_NOTE}</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              aria-label="Total weight for this ingredient line"
              value={weightQty}
              min={0}
              step="any"
              onChange={(event) => setWeightQty(event.target.value)}
              className="w-24 px-2 py-1 rounded-lg bg-[#0C0C0C] border border-white/10 text-gray-100 text-xs"
            />
            <select
              aria-label="Weight unit"
              value={weightUnit}
              onChange={(event) => setWeightUnit(event.target.value as 'g' | 'oz' | 'lb')}
              className="px-2 py-1 rounded-lg bg-[#0C0C0C] border border-white/10 text-gray-100 text-xs"
            >
              <option value="g">g</option>
              <option value="oz">oz</option>
              <option value="lb">lb</option>
            </select>
            <button
              type="button"
              onClick={confirmUserMass}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200 transition-colors"
            >
              {PHASE4_USER_MASS_CONFIRM_LABEL}
            </button>
            {currentUserMass && (
              <button
                type="button"
                onClick={() => dispatch({ type: 'clear_user_mass', lineRef: row.line_ref })}
                className="px-2 py-1 rounded-lg text-[11px] text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
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
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 transition-colors"
      >
        <Search className="w-3 h-3" aria-hidden="true" />
        {open ? 'Close search' : 'Search USDA database'}
      </button>
      {open && (
        <div className="mt-1 space-y-2 p-2 rounded-lg bg-[#0C0C0C] border border-white/10">
          <label className="block text-[10px] text-gray-400" htmlFor={`usda-search-${row.line_ref}`}>
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
              className="flex-1 px-2 py-1 rounded-lg bg-[#141414] border border-white/10 text-gray-100 text-xs"
            />
            <button
              type="button"
              data-testid="advanced-nutrition-search-run"
              onClick={() => run(20)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/30 text-indigo-100 transition-colors"
            >
              Search
            </button>
          </div>
          {error && (
            <p role="alert" className="text-[11px] text-amber-300">
              {error}
            </p>
          )}
          {searched && results !== null && results.length === 0 && !error && (
            <p data-testid="advanced-nutrition-search-empty" className="text-[11px] text-gray-500">
              No matching USDA record found in this pinned dataset.
            </p>
          )}
          {results !== null && results.length > 0 && (
            <>
              <p className="text-[10px] text-gray-500">
                {total} matching USDA record{total === 1 ? '' : 's'}
                {results.length < total ? ` · showing first ${results.length}` : ''}
              </p>
              <ul className="space-y-1 max-h-64 overflow-y-auto">
                {results.map((result) => (
                  <li
                    key={result.fdc_id}
                    className="flex items-start justify-between gap-2 p-1.5 rounded-md bg-[#141414] border border-white/5"
                  >
                    <div className="min-w-0">
                      <p className="text-[11px] text-gray-100">{result.description}</p>
                      <p className="text-[10px] text-gray-400">
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
                      className="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-100 transition-colors"
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
                  className="px-2 py-0.5 rounded-md text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 transition-colors"
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
  session,
  adapted,
  state,
  dispatch,
  onCalculate,
  calculating,
  analysis,
  onAnalyze,
  analysisRuns = 0,
  workingDirty = false,
  hydratedFromSaved = false,
  apply,
  ai,
}) => {
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
  const liveSummary = useMemo(() => summarizeLiveRows(liveRows), [liveRows]);

  if (!isOpen) return null;

  const stale = state.status === 'preview_stale';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto"
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
        className="w-full max-w-3xl bg-[#101010] border border-white/10 rounded-2xl shadow-2xl text-gray-200 max-h-[92vh] overflow-y-auto focus:outline-none"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10 bg-[#101010]/95 backdrop-blur">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-amber-400" />
            <h2 id="advanced-nutrition-title" className="text-base font-serif font-bold text-white">
              Advanced Nutrition
            </h2>
            <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
              Advisory
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="advanced-nutrition-close-without-saving"
              onClick={onClose}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
            >
              Close without saving
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Advanced Nutrition"
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* SAVED vs WORKING distinction: the editor is a temporary draft. */}
          <div
            data-testid="advanced-nutrition-working-banner"
            className="p-3 rounded-xl bg-indigo-950/25 border border-indigo-500/25 space-y-0.5"
          >
            <p className="text-[11px] font-semibold text-indigo-200">Working Advanced Nutrition review</p>
            <p className="text-[10px] text-gray-400">
              {workingDirty
                ? 'Unsaved changes · nothing is written until Apply.'
                : hydratedFromSaved
                  ? 'Hydrated from the saved review · nothing is written until Apply.'
                  : 'Nothing is written until Apply.'}
            </p>
          </div>

          {/* AI-ASSISTED EXCEPTION RESOLUTION (advisory only; optional and
              SECONDARY). AI suggests food search phrases and bounded amount/count
              interpretations; the pinned USDA catalog, the deterministic matcher,
              and authenticated USDA portions decide every resolution. Available
              for ANY actionable exception, not merely NEEDS MATCH. */}
          {ai && (ai.exceptionCount > 0 || ai.message !== null) && (
            <div
              data-testid="advanced-nutrition-ai"
              className="p-3 rounded-xl bg-[#0E0E0E] border border-white/10 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p
                    data-testid="advanced-nutrition-ai-tier"
                    className="text-[11px] font-semibold text-gray-200"
                  >
                    ✨ {AI_ADVANCED_NUTRITION_LABEL}
                  </p>
                  <p className="text-[10px] text-gray-500">
                    AI interprets food wording, count language, and household unit/size/state
                    wording only. The pinned USDA catalog, the deterministic matcher, authenticated
                    USDA portions, and the verified Kitchen Codex household registry decide every
                    resolution; AI never supplies grams. Basic manual review and correction are
                    always available. Nothing is saved.
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="advanced-nutrition-ai-resolve"
                  disabled={!ai.available || ai.running || ai.exceptionCount === 0}
                  aria-disabled={!ai.available || ai.running || ai.exceptionCount === 0}
                  onClick={() => ai.onResolve()}
                  className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/30 text-indigo-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {ai.running ? 'Resolving remaining ingredients…' : 'Resolve remaining with AI'}
                </button>
              </div>
              {!ai.available && (
                <p className="text-[10px] text-gray-500">
                  AI assistance is not configured in this build. Manual USDA search is always
                  available.
                </p>
              )}
              {ai.message && (
                <p
                  data-testid="advanced-nutrition-ai-message"
                  role="status"
                  className="text-[11px] text-indigo-200 flex items-start justify-between gap-2"
                >
                  <span>{ai.message}</span>
                  <button
                    type="button"
                    onClick={ai.onDismissMessage}
                    className="text-gray-500 hover:text-gray-300 text-[10px] shrink-0"
                  >
                    Dismiss
                  </button>
                </p>
              )}
            </div>
          )}

          <p id="advanced-nutrition-desc" className="text-[11px] text-gray-400">
            {PHASE4_NOT_MEDICAL_ADVICE}
          </p>

          {state.failure && (
            <div role="alert" className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/40 text-rose-200 text-xs flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{state.failure.message}</span>
            </div>
          )}

          <section className="text-[11px] text-gray-400 font-mono">
            <span>Source: USDA FoodData Central · bundle {session.metadata().bundle_release.slice(0, 24)}…</span>
            <span className="mx-2">·</span>
            <span>{session.metadata().record_count} eligible home-recipe records</span>
          </section>

          <section aria-label="Display basis" className="space-y-2">
            <h3 className="text-xs font-bold text-white">Display basis</h3>
            <div role="radiogroup" aria-label="Display basis" className="flex flex-wrap gap-3 text-xs">
              {(
                [
                  ['entire_recipe', 'Entire recipe'],
                  ['per_serving', 'Per serving'],
                  ['selected_servings', 'Selected servings'],
                ] as ReadonlyArray<[BasisMode, string]>
              ).map(([mode, label]) => (
                <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="advanced-basis"
                    value={mode}
                    checked={state.basis === mode}
                    onChange={() => dispatch({ type: 'set_basis', basis: mode })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {state.basis === 'selected_servings' && (
              <label className="flex items-center gap-2 text-xs">
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
                  className="w-20 px-2 py-1 rounded-lg bg-[#0C0C0C] border border-white/10 text-gray-100"
                />
              </label>
            )}
          </section>

          <section
            aria-label="Automatic ingredient analysis"
            data-testid="advanced-nutrition-analysis"
            className="space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-indigo-950/20 border border-indigo-500/20">
              <div>
                <p className="text-xs font-bold text-white">Analyze automatically</p>
                <p className="text-[10px] text-gray-400">
                  Deterministic USDA selection and authenticated portions. Review only exceptions.
                  Nothing is saved.
                </p>
              </div>
              <button
                type="button"
                data-testid="advanced-nutrition-analyze"
                onClick={onAnalyze}
                disabled={calculating || (analysis === null && !session)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black disabled:opacity-50 transition-colors"
              >
                {analysisRuns > 0 ? 'Re-analyze Nutrition' : 'Analyze Nutrition'}
              </button>
            </div>

            {analysis && (
              <p
                data-testid="advanced-nutrition-analysis-runs"
                className="text-[10px] font-mono uppercase text-gray-400"
              >
                {analysisRuns > 0 ? `Analysis applied · run ${analysisRuns} · ` : ''}
                {/* LIVE STATUS SUMMARY: exact counts of the CURRENT rendered rows. */}
                <span data-testid="advanced-nutrition-live-summary">
                  {liveSummary.matched} matched · {liveSummary.review_suggested} review suggested ·{' '}
                  {liveSummary.needs_amount} need amount · {liveSummary.needs_match} need match ·{' '}
                  {liveSummary.qualitative} qualitative
                </span>
              </p>
            )}

            <ul className="space-y-2">
              {state.rows.map((row) => {
                const choice = state.matches[row.line_ref];
                const live = liveByRef.get(row.line_ref);
                const status: LiveRowStatus = live?.status ?? 'needs_match';
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
                    className="p-3 rounded-xl bg-[#141414] border border-white/5 space-y-2"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-100">{row.original_text || row.query}</p>
                        {description ? (
                          <p className="text-[11px] text-emerald-300 truncate">
                            {description}
                            {massText !== undefined ? (
                              <span className="text-gray-400"> · {massText}</span>
                            ) : (
                              <span className="text-gray-500">
                                {' '}
                                · amount —
                                {rowAmount !== null && rowUnit ? ` (recipe ${rowAmount} ${rowUnit})` : ''}
                              </span>
                            )}
                            {choice?.aiAssisted === true && (
                              <span
                                data-testid="advanced-nutrition-ai-badge"
                                className="text-indigo-300"
                                title="Food discovered with AI-assisted interpretation; the pinned USDA catalog and deterministic matcher accepted it."
                              >
                                {' '}
                                · {choice?.aiAccepted === true ? 'AI-assisted USDA match' : 'AI-assisted'}
                              </span>
                            )}
                            {state.countPortions[row.line_ref]?.aiAssisted === true && (
                              <span
                                data-testid="advanced-nutrition-ai-amount-badge"
                                className="text-indigo-300"
                                title="The count identity was AI-interpreted; the mass comes from one authenticated USDA count portion that the deterministic calculator re-verified."
                              >
                                {' '}
                                · AI-assisted USDA count portion
                              </span>
                            )}
                          </p>
                        ) : (
                          <p className="text-[11px] text-gray-500">
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
                        <span
                          data-testid="advanced-nutrition-row-status"
                          className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ${LIVE_STATUS_CLASS[status]}`}
                        >
                          {LIVE_ROW_STATUS_LABEL[status]}
                        </span>
                        <button
                          type="button"
                          data-testid="advanced-nutrition-edit"
                          onClick={() =>
                            setExpandedLineRef(expanded ? null : row.line_ref)
                          }
                          aria-expanded={expanded}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200 transition-colors"
                        >
                          {expanded ? 'Close' : 'Edit'}
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="pt-1 border-t border-white/5 space-y-2">
                        {row.outcome === 'matched_exact' && (
                          <p className="text-[11px] text-emerald-300">
                            Matched automatically as the single exact source description. This was not
                            manually confirmed by you.
                          </p>
                        )}

                        {fdcId !== undefined && (
                          <div className="space-y-1" data-testid="advanced-nutrition-food-summary">
                            <p className="text-[11px] text-gray-300">
                              Food:{' '}
                              <span className="text-emerald-300 font-medium">
                                {description ?? 'Selected source'}
                              </span>
                              {choice?.kind === 'manual' && choice?.aiAssisted !== true && (
                                <span className="text-gray-400"> · user-selected from USDA search</span>
                              )}
                              {choice?.aiAssisted === true && (
                                <span className="text-indigo-300">
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
                                className="px-2 py-0.5 rounded-md text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 transition-colors"
                              >
                                {changingFood ? 'Cancel change' : 'Change food'}
                              </button>
                            )}
                          </div>
                        )}
                        {row.outcome === 'review_required' && showCandidates && (
                          <fieldset className="space-y-1">
                            <legend className="text-[11px] text-gray-400">
                              Choose the source food for {row.original_text}
                            </legend>
                            {row.candidates.map((candidate) => (
                              <label
                                key={candidate.fdc_id}
                                className="flex items-start gap-2 text-[11px] text-gray-200 cursor-pointer"
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
                                  <span className="text-gray-400">
                                    · {candidate.data_type} · FDC {candidate.fdc_id} ·{' '}
                                    {candidate.rank_evidence}
                                  </span>
                                  {candidate.portion_annotation && (
                                    <span className="block text-[10px] text-indigo-300">
                                      {candidate.portion_annotation}
                                    </span>
                                  )}
                                </span>
                              </label>
                            ))}
                            <label className="flex items-start gap-2 text-[11px] text-gray-200 cursor-pointer">
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

                        {(row.outcome === 'unmatched' || row.outcome === 'invalid') && (
                          <p className="text-[11px] text-amber-300">
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
                              className="px-2 py-0.5 rounded-md text-[10px] bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-400/30 text-indigo-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {ai.running ? 'Asking AI…' : 'Ask AI for help'}
                            </button>
                            {ai.suggestions[row.line_ref] && (
                              <div
                                data-testid="advanced-nutrition-ai-suggestion"
                                className="p-2 rounded-lg bg-indigo-950/20 border border-indigo-500/25 space-y-1"
                              >
                                <p className="text-[11px] text-gray-200">
                                  AI-suggested USDA match:{' '}
                                  <span className="text-emerald-300">
                                    {ai.suggestions[row.line_ref].description}
                                  </span>
                                </p>
                                <button
                                  type="button"
                                  data-testid="advanced-nutrition-ai-use"
                                  onClick={() => ai.onUseSuggestion(row.line_ref)}
                                  className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-100 transition-colors"
                                >
                                  Use this match
                                </button>
                              </div>
                            )}
                            {ai.amountOffers[row.line_ref] && ai.amountOffers[row.line_ref].length > 0 && (
                              <div
                                data-testid="advanced-nutrition-ai-amount-offers"
                                className="p-2 rounded-lg bg-indigo-950/20 border border-indigo-500/25 space-y-1"
                              >
                                <p className="text-[11px] text-gray-200">
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
                                      className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 text-emerald-100 transition-colors"
                                    >
                                      Use {offer.display_label} → {Math.round(offer.resolved_grams * 10) / 10} g
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {row.outcome === 'qualitative' && (
                          <p className="text-[11px] text-gray-400">
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

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCalculate}
              disabled={calculating}
              className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black disabled:opacity-50 transition-colors"
            >
              {calculating ? 'Calculating…' : preview ? 'Recalculate Preview' : 'Calculate Preview'}
            </button>
          </div>

          {preview && (
            <section aria-label="Advisory nutrition preview" className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <h3 className="text-xs font-bold text-white">Advisory nutrition preview</h3>
                {stale && (
                  <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    Stale — recalculate
                  </span>
                )}
              </div>
              <div className="text-[11px] text-gray-400 grid grid-cols-2 gap-x-4 gap-y-1">
                <span>Basis: {basisLabel(state.basis, state.selectedServings)}</span>
                <span>Status: {preview.status}</span>
                <span>Nutrients in scope: {preview.nutrient_scope.length}</span>
                <span>Unresolved ingredients: {preview.unresolved.length}</span>
                <span className="col-span-2 font-mono break-all">
                  Ingredient digest: {preview.ingredient_digest.slice(0, 32)}…
                </span>
              </div>

              {coverage && (
                <p className="text-[11px] text-gray-400">
                  Coverage: {coverage.status} · {coverage.unresolved_count} of {coverage.total_ingredients}{' '}
                  ingredient lines unresolved.
                </p>
              )}

              <div className="space-y-3">
                {NUTRIENT_GROUPS.map((group) => (
                  <div key={group.id}>
                    <h4 className="text-[11px] font-bold text-gray-300 uppercase tracking-wide mb-1">
                      {group.label}
                    </h4>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                      {(display ?? [])
                        .filter((nutrient) => group.nutrients.includes(nutrient.nutrient))
                        .map((nutrient) => (
                          <li
                            key={nutrient.nutrient}
                            className="flex items-center justify-between text-[11px] py-0.5 border-b border-white/5"
                          >
                            <span className="text-gray-300">{nutrient.label}</span>
                            <span className="font-mono text-gray-100">
                              {formatAmount(nutrient.amount)}
                              {nutrient.amount !== undefined ? ` ${nutrient.unit_label}` : ''}
                              <span className="text-gray-500 ml-2">
                                {formatDailyValue(nutrient.percent_daily_value)} DV
                              </span>
                              {nutrient.coverage === 'partial' && (
                                <span className="text-amber-300 ml-1">partial</span>
                              )}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>

              {evidence && (
                <div>
                  <h4 className="text-[11px] font-bold text-gray-300 uppercase tracking-wide mb-1">
                    Ingredient evidence
                  </h4>
                  <ul className="space-y-1">
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
                        <li key={entry.line_ref} className="text-[11px] text-gray-400">
                          <span className="text-gray-200">{entry.original_text}</span> — {entry.outcome}
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
                </div>
              )}

              {preview.unresolved.length > 0 && (
                <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-[11px] text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Some ingredient lines are unresolved.</p>
                    <ul className="list-disc list-inside">
                      {preview.unresolved.map((entry) => (
                        <li key={entry.line_ref}>
                          {entry.line_ref}: {entry.outcome}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <p className="text-[10px] text-gray-500 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  This advisory preview is derived from a pinned local USDA dataset. It is not saved
                  unless you explicitly Apply it, is not medical advice, and does not claim complete
                  nutritional coverage.
                </span>
              </p>

              {apply && (
                <section
                  aria-label="Apply advanced nutrition"
                  className="space-y-2 border-t border-white/10 pt-3"
                >
                  <h3 className="text-xs font-bold text-white">Apply advanced nutrition</h3>
                  {apply.status === 'success' && apply.message && (
                    <p role="status" className="text-[11px] text-emerald-300">
                      {apply.message}
                    </p>
                  )}
                  {apply.status === 'error' && apply.message && (
                    <p role="alert" className="text-[11px] text-amber-300">
                      {apply.message}
                    </p>
                  )}

                  {apply.status === 'confirming' ? (
                    <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-[11px] text-amber-100 space-y-2">
                      <p>
                        {apply.mode === 'replace'
                          ? 'Apply will replace the existing saved Advanced Nutrition block on this recipe.'
                          : 'Apply will add a saved Advanced Nutrition block to this recipe.'}
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={apply.onConfirm}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-black bg-amber-400 hover:bg-amber-300 transition-colors"
                        >
                          Confirm Apply
                        </button>
                        <button
                          type="button"
                          onClick={apply.onCancel}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-200 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] text-gray-500">
                        Writes one canonical Advanced Nutrition block; nothing else is changed.
                      </span>
                      <button
                        type="button"
                        onClick={apply.onRequest}
                        disabled={apply.eligible !== true || apply.status === 'applying'}
                        aria-disabled={apply.eligible !== true || apply.status === 'applying'}
                        className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-200 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                    <p className="text-[10px] text-amber-300">
                      Apply is unavailable until the reviewed result is eligible.
                    </p>
                  )}
                </section>
              )}
            </section>
          )}

          <p className="text-[10px] text-gray-600">
            Recipe: {title}. Advanced Nutrition is advisory review only; nothing here is written
            to your vault.
          </p>
        </div>
      </div>
    </div>
  );
};
