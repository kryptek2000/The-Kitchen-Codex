/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: central LIVE row-state
 * projection.
 *
 * PURE, offline, display/review only. This is the ONE place that derives the
 * CURRENT effective state of one Advanced Nutrition ingredient row from the
 * authoritative live session state:
 *
 *   - the current authoritative review row (Phase 2 candidates/outcome);
 *   - the current food selection (`state.matches`, automatic OR user-confirmed);
 *   - the current authenticated source-portion selection (`state.portions`);
 *   - the current authenticated count-portion selection (`state.countPortions`);
 *   - the current user-entered total weight (`state.userMasses`);
 *   - the current advisory-preview evidence for the same food.
 *
 * It NEVER reads a collapsed row status from the initial analyzer snapshot, the
 * initial `row.outcome`, a memoized automatic suggestion, or component-local
 * display state. A user who explicitly confirms a food, selects an authenticated
 * portion, or enters a total weight sees that resolution IMMEDIATELY, without
 * waiting for a preview recalculation and without a stale "Review suggested".
 *
 * It never invents a mass, never guesses a density, and never persists anything.
 * The Phase 3 calculator remains the final numerical authority.
 */

import { convertMassToGrams, type NormalizedUnit } from '../../../utils/measurements';
import {
  derivedSourcePortionGrams,
  ingredientCountAmount,
  ingredientMeasurement,
  ingredientMeasurementKind,
  type IngredientMeasurementView,
} from './rows';
import type { AnalyzedRow } from './analyzer';
import type { AiResolutionIssueKind } from '../aiResolution';
import type {
  AdvancedNutritionSession,
  AdaptedIngredient,
  IngredientEvidenceView,
  Phase4Row,
  Phase4State,
} from './types';

/** The explicit live row-status contract. */
export type LiveRowStatus =
  | 'needs_match'
  | 'review_suggested'
  | 'needs_amount'
  | 'matched'
  | 'qualitative';

/** The live, authenticated mass provenance of a resolved row. */
export type LiveRowMassSource = 'source_portion' | 'count_portion' | 'user_mass' | 'direct_mass';

/** The live food-identity authority of a resolved row. */
export type LiveRowFoodAuthority =
  | 'automatic'
  | 'unique_exact'
  | 'ai_assisted'
  | 'user_confirmed'
  | 'none';

export interface LiveRowState {
  readonly line_ref: string;
  readonly original_text: string;
  readonly status: LiveRowStatus;
  readonly food_authority: LiveRowFoodAuthority;
  readonly selected_fdc_id: number | undefined;
  readonly selected_description: string | undefined;
  readonly resolved_grams: number | undefined;
  readonly mass_source: LiveRowMassSource | undefined;
  readonly portion_index: number | undefined;
  readonly user_mass_quantity: number | undefined;
  readonly user_mass_unit: string | undefined;
  readonly source_portion_automatic: boolean;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Deterministic total grams for an authenticated count-portion selection applied
 * to the recipe's own count. Mirrors the calculator's exact count ratio
 * (`count / portion_amount × gram_weight`); never averages, never guesses.
 */
export function derivedCountPortionGrams(
  selection: unknown,
  countAmount: number | null
): number | undefined {
  if (typeof selection !== 'object' || selection === null) return undefined;
  const value = selection as Record<string, unknown>;
  const portionAmount = value.portion_amount;
  const gramWeight = value.gram_weight;
  if (!finitePositive(countAmount)) return undefined;
  if (!finitePositive(portionAmount) || !finitePositive(gramWeight)) return undefined;
  const grams = (countAmount / portionAmount) * gramWeight;
  return Number.isFinite(grams) && grams > 0 ? grams : undefined;
}

/**
 * Deterministic count grams resolved directly from the authenticated record when
 * exactly one compatible count identity exists (every candidate shares the same
 * amount/gram weight). This is the SAME rule the calculator applies for an
 * automatic count resolution; it is display-only here.
 */
function deterministicCountGrams(
  session: AdvancedNutritionSession,
  entry: AdaptedIngredient,
  fdcId: number,
  countAmount: number
): number | undefined {
  const review = session.reviewCountPortions(entry.ingredient, fdcId);
  if (!review.ok) return undefined;
  const candidates = review.review.candidates;
  if (candidates.length === 0) return undefined;
  const first = candidates[0];
  for (const candidate of candidates) {
    if (candidate.amount !== first.amount || candidate.gram_weight !== first.gram_weight) {
      return undefined;
    }
  }
  if (!finitePositive(first.amount) || !finitePositive(first.gram_weight)) return undefined;
  const grams = (countAmount / first.amount) * first.gram_weight;
  return Number.isFinite(grams) && grams > 0 ? grams : undefined;
}

export interface LiveRowProjectionInput {
  readonly row: Phase4Row;
  readonly analyzed: AnalyzedRow | undefined;
  readonly state: Phase4State;
  readonly entry: AdaptedIngredient | undefined;
  readonly session: AdvancedNutritionSession;
  readonly evidence: IngredientEvidenceView | undefined;
  /**
   * The analyzer's CURRENT authenticated portion suggestion for this row, used
   * ONLY as a fallback before the user has applied/confirmed anything. Once the
   * live session state carries a resolution, that resolution wins.
   */
  readonly suggestedPortion?: {
    readonly fdc_id: number;
    readonly portion_index?: number;
    readonly selection: unknown;
  };
  readonly suggestedCountPortion?: {
    readonly fdc_id: number;
    readonly portion_index?: number;
    readonly selection: unknown;
  };
}

/**
 * Projects the CURRENT effective state of one ingredient row from authoritative
 * live session state. Never throws; malformed/absent inputs fail closed to
 * `needs_match`/`needs_amount` rather than manufacturing a mass.
 */
export function projectLiveRow(input: LiveRowProjectionInput): LiveRowState {
  const { row, analyzed, state, entry, session, evidence, suggestedPortion, suggestedCountPortion } =
    input;
  const lineRef = row.line_ref;
  const originalText = row.original_text || row.query;

  const base = {
    line_ref: lineRef,
    original_text: originalText,
    selected_fdc_id: undefined as number | undefined,
    selected_description: undefined as string | undefined,
    resolved_grams: undefined as number | undefined,
    mass_source: undefined as LiveRowMassSource | undefined,
    portion_index: undefined as number | undefined,
    user_mass_quantity: undefined as number | undefined,
    user_mass_unit: undefined as string | undefined,
    source_portion_automatic: false,
  };

  if (row.outcome === 'qualitative') {
    return Object.freeze({ ...base, status: 'qualitative' as const, food_authority: 'none' as const });
  }

  const matchChoice = state.matches[lineRef];
  const hasMatchChoice =
    matchChoice !== undefined && (matchChoice.kind === 'candidate' || matchChoice.kind === 'manual');
  const uniqueExact = row.outcome === 'matched_exact' && typeof row.selected_fdc_id === 'number';
  const foodResolved = hasMatchChoice || uniqueExact;
  const appliedFdcId = hasMatchChoice
    ? matchChoice.fdc_id
    : uniqueExact
      ? row.selected_fdc_id
      : undefined;

  // Before the user has applied/confirmed anything, the analyzer's CURRENT
  // automatic suggestion is the effective state (it is recomputed from the same
  // session/recipe, so it is never stale). A live resolution always wins.
  const suggestedAutomatic =
    !foodResolved && analyzed?.status === 'matched' && typeof analyzed.selected_fdc_id === 'number';
  const selectedFdcId = appliedFdcId ?? (suggestedAutomatic ? analyzed.selected_fdc_id : undefined);

  const candidateView =
    selectedFdcId !== undefined
      ? row.candidates.find((candidate) => candidate.fdc_id === selectedFdcId)
      : undefined;
  const selectedDescription =
    candidateView?.description ??
    (analyzed?.selected_fdc_id !== undefined && analyzed.selected_fdc_id === selectedFdcId
      ? analyzed.selected_description
      : undefined) ??
    (hasMatchChoice && matchChoice.description !== undefined ? matchChoice.description : undefined);

  const foodAuthority: LiveRowFoodAuthority = !foodResolved
    ? suggestedAutomatic
      ? 'automatic'
      : 'none'
    : uniqueExact && !hasMatchChoice
      ? 'unique_exact'
      : matchChoice?.aiAccepted === true
        ? 'ai_assisted'
        : matchChoice?.automatic === true
          ? 'automatic'
          : 'user_confirmed';

  const measurement: IngredientMeasurementView | undefined = entry
    ? ingredientMeasurement(entry)
    : undefined;
  const countAmount = entry ? ingredientCountAmount(entry) : null;
  const portion = state.portions[lineRef];
  const count = state.countPortions[lineRef];
  const userMass = state.userMasses[lineRef];

  let resolvedGrams: number | undefined;
  let massSource: LiveRowMassSource | undefined;
  let portionIndex: number | undefined;
  let userMassQuantity: number | undefined;
  let userMassUnit: string | undefined;
  let sourcePortionAutomatic = false;

  if (userMass) {
    const grams = convertMassToGrams(userMass.quantity, userMass.unit as NormalizedUnit);
    if (grams !== undefined && grams > 0) {
      resolvedGrams = grams;
      massSource = 'user_mass';
    }
    userMassQuantity = userMass.quantity;
    userMassUnit = userMass.unit;
  } else if (
    // DIRECT RECIPE MASS IS AUTHORITATIVE. When the recipe line already supplies
    // a direct mass (g / kg / oz / lb), that mass resolves the row WITHOUT any
    // USDA source portion, and it survives a food change (only food-dependent
    // portion/count state is invalidated). This is checked before source
    // portions/counts so a direct mass is never dependent on a portion.
    measurement !== undefined &&
    measurement.measurement_kind === 'mass' &&
    measurement.grams !== undefined &&
    Number.isFinite(measurement.grams) &&
    measurement.grams > 0
  ) {
    resolvedGrams = measurement.grams;
    massSource = 'direct_mass';
  } else if (portion) {
    const grams = derivedSourcePortionGrams(portion.selection, measurement ?? {
      amount: null,
      raw_unit: undefined,
      measurement_kind: 'unknown',
      milliliters: undefined,
      grams: undefined,
    });
    if (grams !== undefined) {
      resolvedGrams = grams;
      massSource = 'source_portion';
      portionIndex = portion.portion_index;
      sourcePortionAutomatic = portion.automatic === true;
    }
  } else if (count) {
    const grams = derivedCountPortionGrams(count.selection, countAmount);
    if (grams !== undefined) {
      resolvedGrams = grams;
      massSource = 'count_portion';
      portionIndex = count.portion_index;
    }
  } else if (selectedFdcId !== undefined && entry) {
    // Automatic count resolution (the calculator resolves a unique authenticated
    // count identity without an explicit selection). Display-only derivation.
    if (ingredientMeasurementKind(entry) === 'count' && countAmount !== null) {
      const grams = deterministicCountGrams(session, entry, selectedFdcId, countAmount);
      if (grams !== undefined) {
        resolvedGrams = grams;
        massSource = 'count_portion';
      }
    }
    if (
      resolvedGrams === undefined &&
      suggestedCountPortion !== undefined &&
      suggestedCountPortion.fdc_id === selectedFdcId
    ) {
      const grams = derivedCountPortionGrams(suggestedCountPortion.selection, countAmount);
      if (grams !== undefined) {
        resolvedGrams = grams;
        massSource = 'count_portion';
        portionIndex = suggestedCountPortion.portion_index;
      }
    }
    if (
      resolvedGrams === undefined &&
      evidence !== undefined &&
      evidence.fdc_id === selectedFdcId &&
      evidence.resolved_grams !== undefined
    ) {
      resolvedGrams = evidence.resolved_grams;
      massSource = evidence.mass_source as LiveRowMassSource | undefined;
      portionIndex = evidence.portion_index;
    }
    if (
      resolvedGrams === undefined &&
      suggestedPortion !== undefined &&
      suggestedPortion.fdc_id === selectedFdcId
    ) {
      const grams = derivedSourcePortionGrams(suggestedPortion.selection, measurement ?? {
        amount: null,
        raw_unit: undefined,
        measurement_kind: 'unknown',
        milliliters: undefined,
        grams: undefined,
      });
      if (grams !== undefined) {
        resolvedGrams = grams;
        massSource = 'source_portion';
        portionIndex = suggestedPortion.portion_index;
      }
    }
  }

  let status: LiveRowStatus;
  if (!foodResolved && !suggestedAutomatic) {
    status = analyzed?.status === 'matched_check' ? 'review_suggested' : 'needs_match';
  } else if (resolvedGrams === undefined) {
    status = 'needs_amount';
  } else {
    status = 'matched';
  }

  return Object.freeze({
    line_ref: lineRef,
    original_text: originalText,
    status,
    food_authority: foodAuthority,
    selected_fdc_id: selectedFdcId,
    selected_description: selectedDescription,
    resolved_grams: resolvedGrams,
    mass_source: massSource,
    portion_index: portionIndex,
    user_mass_quantity: userMassQuantity,
    user_mass_unit: userMassUnit,
    source_portion_automatic: sourcePortionAutomatic,
  });
}

/**
 * Projects every current row in one pass. Deterministic and independent of input
 * order.
 */
export function projectLiveRows(
  state: Phase4State,
  analyzedByRef: ReadonlyMap<string, AnalyzedRow>,
  adapted: ReadonlyArray<AdaptedIngredient>,
  session: AdvancedNutritionSession,
  evidence: ReadonlyArray<IngredientEvidenceView> | null,
  suggestedPortions?: Readonly<Record<string, { fdc_id: number; portion_index?: number; selection: unknown }>>,
  suggestedCountPortions?: Readonly<
    Record<string, { fdc_id: number; portion_index?: number; selection: unknown }>
  >
): ReadonlyArray<LiveRowState> {
  const entryByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));
  const evidenceByRef = new Map<string, IngredientEvidenceView>();
  if (evidence) for (const item of evidence) evidenceByRef.set(item.line_ref, item);
  return Object.freeze(
    state.rows.map((row) =>
      projectLiveRow({
        row,
        analyzed: analyzedByRef.get(row.line_ref),
        state,
        entry: entryByRef.get(row.line_ref),
        session,
        evidence: evidenceByRef.get(row.line_ref),
        suggestedPortion: suggestedPortions?.[row.line_ref],
        suggestedCountPortion: suggestedCountPortions?.[row.line_ref],
      })
    )
  );
}

/** Bounded, user-facing status label for the live row contract. */
export const LIVE_ROW_STATUS_LABEL: Readonly<Record<LiveRowStatus, string>> = Object.freeze({
  needs_match: 'Needs match',
  review_suggested: 'Review suggested',
  needs_amount: 'Needs amount',
  matched: 'Matched',
  qualitative: 'Qualitative',
});

/**
 * The actionable exception kinds an AI exception-resolution pass may help with.
 * This is the SAME bounded vocabulary the resolver receives as trusted issue
 * state, so the user never needs to understand the internal taxonomy.
 */
export type LiveRowExceptionKind = AiResolutionIssueKind;

/** Maps a live row status to its actionable exception kind, or undefined. */
export function liveExceptionKind(status: LiveRowStatus): LiveRowExceptionKind | undefined {
  switch (status) {
    case 'needs_match':
      return 'needs_match';
    case 'review_suggested':
      return 'review_suggested';
    case 'needs_amount':
      return 'needs_amount';
    default:
      return undefined;
  }
}

/**
 * The ONE deterministic status summary of the CURRENT live rows. The ingredient
 * list and every summary/count surface derive from this single projection, so a
 * separately maintained mutable counter can never disagree with the rendered
 * rows.
 */
export interface LiveRowStatusSummary {
  readonly total: number;
  readonly matched: number;
  readonly review_suggested: number;
  readonly needs_amount: number;
  readonly needs_match: number;
  readonly qualitative: number;
  /** needs_match + review_suggested + needs_amount. */
  readonly actionable: number;
}

export function summarizeLiveRows(
  rows: ReadonlyArray<LiveRowState>
): LiveRowStatusSummary {
  let matched = 0;
  let reviewSuggested = 0;
  let needsAmount = 0;
  let needsMatch = 0;
  let qualitative = 0;
  for (const row of rows) {
    switch (row.status) {
      case 'matched':
        matched += 1;
        break;
      case 'review_suggested':
        reviewSuggested += 1;
        break;
      case 'needs_amount':
        needsAmount += 1;
        break;
      case 'needs_match':
        needsMatch += 1;
        break;
      case 'qualitative':
        qualitative += 1;
        break;
      default:
        break;
    }
  }
  return Object.freeze({
    total: rows.length,
    matched,
    review_suggested: reviewSuggested,
    needs_amount: needsAmount,
    needs_match: needsMatch,
    qualitative,
    actionable: needsMatch + reviewSuggested + needsAmount,
  });
}

/**
 * The actionable exception rows (in `state.rows` order) derived from the SAME
 * live projection that renders the ingredient list. MATCHED and QUALITATIVE rows
 * are never included, so the AI resolver receives only the genuine remaining
 * work.
 */
export function actionableExceptionRows(
  rows: ReadonlyArray<Phase4Row>,
  liveRows: ReadonlyArray<LiveRowState>
): ReadonlyArray<Phase4Row> {
  const actionableRefs = new Set<string>();
  for (const live of liveRows) {
    if (liveExceptionKind(live.status) !== undefined) actionableRefs.add(live.line_ref);
  }
  return Object.freeze(rows.filter((row) => actionableRefs.has(row.line_ref)));
}
