/**
 * The Kitchen Codex — Advanced Nutrition post-Phase-5 smoke-test remediation:
 * automatic recipe analyzer (deterministic, exception-only review).
 *
 * PURE, offline, advisory-only. `analyzeRecipe` turns an adapted recipe into:
 *   - a deterministic automatic food selection for every high-confidence row;
 *   - a deterministic automatic authenticated volume-portion resolution for
 *     every row where exactly one compatible source portion is authoritative;
 *   - a compact row status (matched / matched-check / needs-amount /
 *     needs-match / unresolved / qualitative);
 *   - an advisory preview computed through the genuine Phase 4 session.
 *
 * It NEVER persists, never writes a recipe, never weakens a deterministic
 * authority, never invents a mass, and never auto-selects a weak/random partial
 * overlap. Rows that are not safely resolvable remain unresolved and are shown
 * as "needs review". Nothing here is a write; Phase 5B Apply stays explicit.
 */

import { parseIngredient } from '../matching/parse';
import { normalizeQuery } from '../matching/normalize';
import { projectQueryText } from '../matching/query';
import {
  bestEffortPortionTieCandidates,
  classifyReviewConfidence,
  selectAutomaticMatch,
  selectBestEffortMatch,
  type MatchConfidence,
} from '../matching/confidence';
import type { IngredientReviewResult } from '../matching/types';
import { candidatePortionCompatibility } from '../calculation/portionSemantics';
import type { AdvisoryNutritionPreview } from '../calculation/types';
import { buildPortionChoice } from './portion';
import { buildHouseholdPortionChoice } from './householdPortion';
import { buildCalculationRequest, buildReviewRows } from './rows';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  CountPortionChoice,
  HouseholdPortionChoice,
  MatchChoice,
  Phase4Row,
  Phase4State,
  PortionChoice,
} from './types';

export const ANALYZER_VERSION = 'usda_auto_analyzer_v4';

/** Compact, user-facing row status (exception-only review). */
export type AnalyzerStatus =
  | 'matched'
  | 'matched_check'
  | 'needs_amount'
  | 'needs_match'
  | 'unresolved'
  | 'qualitative';

export interface AnalyzedRow {
  readonly line_ref: string;
  readonly original_text: string;
  readonly query: string;
  readonly status: AnalyzerStatus;
  readonly confidence: MatchConfidence;
  readonly selected_fdc_id: number | undefined;
  readonly selected_description: string | undefined;
  readonly match_class: string | undefined;
  readonly review_digest: string | undefined;
  readonly review: unknown;
  readonly candidates: Phase4Row['candidates'];
  readonly auto_portion: boolean;
  readonly reason: string;
}

export interface RecipeAnalysis {
  readonly version: string;
  readonly rows: ReadonlyArray<AnalyzedRow>;
  readonly matches: Readonly<Record<string, MatchChoice>>;
  readonly portions: Readonly<Record<string, PortionChoice>>;
  readonly countPortions: Readonly<Record<string, CountPortionChoice>>;
  readonly householdPortions: Readonly<Record<string, HouseholdPortionChoice>>;
  readonly preview: AdvisoryNutritionPreview | undefined;
  readonly summary: {
    readonly total: number;
    readonly matched: number;
    readonly matched_check: number;
    readonly needs_amount: number;
    readonly needs_match: number;
    readonly unresolved: number;
    readonly qualitative: number;
    readonly auto_matches: number;
    readonly auto_portions: number;
  };
}

/** True when the original text embeds an explicit mass RANGE (not one value). */
export function hasExplicitMassRange(originalText: string): boolean {
  return /\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*(?:g|gram|grams|oz|ounce|ounces|lb|pounds?)\b/i.test(
    originalText
  );
}

function reviewOf(row: Phase4Row): IngredientReviewResult | undefined {
  const review = row.review as IngredientReviewResult | undefined;
  if (!review || typeof review !== 'object') return undefined;
  return review;
}

function selectionForAuto(review: IngredientReviewResult, fdcId: number): unknown {
  const digest = typeof review.review_digest === 'string' ? review.review_digest : '';
  return { kind: 'candidate', fdc_id: fdcId, review_digest: digest };
}

interface VolumePortionChoice {
  readonly index: number;
}

/**
 * Deterministic automatic volume-portion resolution. Returns the lowest-index
 * compatible authenticated source portion ONLY when every compatible portion
 * resolves to the SAME authoritative mass for the ingredient's measurement.
 * Differing authoritative gram weights are ambiguous and are NOT auto-chosen.
 * Never averages, never guesses a density, never invents a conversion.
 */
function selectDeterministicVolumePortion(
  session: AdvancedNutritionSession,
  fdcId: number,
  measurementKind: string,
  milliliters: number | undefined,
  requestedUnit: string | undefined,
  queryText: string
): VolumePortionChoice | undefined {
  if (measurementKind !== 'volume') return undefined;
  if (typeof milliliters !== 'number' || !Number.isFinite(milliliters) || milliliters <= 0) {
    return undefined;
  }
  const review = session.reviewPortions(fdcId);
  if (!review.ok) return undefined;
  const compatible = review.review.candidates.filter(
    (candidate) => candidatePortionCompatibility(candidate, 'volume') === 'compatible'
  );
  if (compatible.length === 0) return undefined;

  const resolvedGrams = (candidate: (typeof compatible)[number]): number | undefined => {
    if (
      candidate.volume_ml === null ||
      !Number.isFinite(candidate.volume_ml) ||
      candidate.volume_ml <= 0 ||
      !(candidate.gram_weight > 0)
    ) {
      return undefined;
    }
    const grams = (milliliters / candidate.volume_ml) * candidate.gram_weight;
    if (!Number.isFinite(grams) || grams <= 0 || Object.is(grams, -0)) return undefined;
    return grams;
  };

  const allEquivalent = (candidates: ReadonlyArray<(typeof compatible)[number]>): boolean => {
    const values: number[] = [];
    for (const candidate of candidates) {
      const grams = resolvedGrams(candidate);
      if (grams === undefined) return false;
      values.push(grams);
    }
    const first = values[0];
    return values.every((value) => Math.abs(value - first) <= 1e-9 * Math.max(1, Math.abs(first)));
  };

  // 1. Prefer the exact requested unit identity.
  if (requestedUnit) {
    const exactUnit = compatible.filter((candidate) => candidate.unit === requestedUnit);
    if (exactUnit.length === 1) return { index: exactUnit[0].index };
    if (exactUnit.length > 1) {
      // 1a. Narrow by a requested preparation/qualifier descriptor
      //     (e.g. `tsp, ground` for `ground black pepper`).
      const projection = projectQueryText(normalizeQuery(queryText).text);
      const descriptorTokens = new Set([
        ...projection.preparation_qualifiers,
        ...projection.qualifier_tokens,
      ]);
      const descriptorMatches = exactUnit.filter(
        (candidate) => candidate.descriptor !== null && descriptorTokens.has(candidate.descriptor)
      );
      if (descriptorMatches.length === 1) return { index: descriptorMatches[0].index };
      // Bounded default for measured spices: when the query did not request a
      // preparation and exactly one exact-unit portion is the `ground` form, the
      // ground form is the ordinary measured seasoning (e.g. `1/2 tsp black
      // pepper` -> `1 tsp, ground`). This is deterministic, not arbitrary.
      if (descriptorMatches.length === 0) {
        const groundMatches = exactUnit.filter((candidate) => candidate.descriptor === 'ground');
        if (groundMatches.length === 1) return { index: groundMatches[0].index };
      }
      const pool = descriptorMatches.length > 0 ? descriptorMatches : exactUnit;
      if (allEquivalent(pool)) return { index: pool[0].index };
      return undefined;
    }
  }

  // 2. Otherwise, only a provably equivalent compatible set is auto-chosen.
  if (allEquivalent(compatible)) return { index: compatible[0].index };
  return undefined;
}

/**
 * True when a candidate has an authenticated mass source compatible with the
 * recipe's measurement: a compatible canonical volume portion, a deterministic
 * compatible count identity, or direct mass (which needs no portion).
 */
function hasCompatibleAuthenticatedMass(
  session: AdvancedNutritionSession,
  entry: AdaptedIngredient,
  fdcId: number,
  measurementKind: string
): boolean {
  if (measurementKind === 'mass') return true;
  if (measurementKind === 'volume') {
    const review = session.reviewPortions(fdcId);
    if (!review.ok) return false;
    return review.review.candidates.some(
      (candidate) =>
        candidatePortionCompatibility(candidate, 'volume') === 'compatible' &&
        candidate.kind === 'volume' &&
        candidate.volume_ml !== null &&
        candidate.volume_ml > 0 &&
        candidate.gram_weight > 0
    );
  }
  if (measurementKind === 'count') {
    const review = session.reviewCountPortions(entry.ingredient, fdcId);
    if (!review.ok) return false;
    const candidates = review.review.candidates;
    if (candidates.length === 0) return false;
    const first = candidates[0];
    if (!(first.gram_weight > 0) || !(first.amount > 0)) return false;
    return candidates.every(
      (candidate) => candidate.amount === first.amount && candidate.gram_weight === first.gram_weight
    );
  }
  return false;
}

/**
 * Portion-aware same-family default. When the deterministic best-effort default
 * cannot satisfy the recipe measurement with an authenticated portion but an
 * otherwise-equivalent same-family sibling can, prefer the sibling. Never
 * reorders across a material boundary or toward an unrequested product form.
 */
function tokenSet(description: unknown): Set<string> {
  if (typeof description !== 'string' || description.length === 0) return new Set();
  return new Set(description.split(' ').filter(Boolean));
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

function chooseBestEffortFood(
  session: AdvancedNutritionSession,
  entry: AdaptedIngredient,
  review: IngredientReviewResult,
  defaultFdcId: number,
  measurementKind: string
): number {
  if (measurementKind !== 'volume' && measurementKind !== 'count') return defaultFdcId;
  const tie = bestEffortPortionTieCandidates(review);
  if (tie.length === 0) return defaultFdcId;
  if (!tie.some((candidate) => candidate.fdc_id === defaultFdcId)) return defaultFdcId;
  if (hasCompatibleAuthenticatedMass(session, entry, defaultFdcId, measurementKind)) {
    return defaultFdcId;
  }
  // The default cannot satisfy the measurement. Prefer the same-family sibling
  // that (a) has a compatible authenticated portion and (b) is MOST SIMILAR to
  // the default's own description, so `Flour, wheat, all-purpose, ...` chooses
  // another all-purpose record rather than a whole-grain one. Ranking order
  // breaks an overlap tie.
  const defaultCandidate = review.candidates.find((candidate) => candidate.fdc_id === defaultFdcId);
  const defaultTokens = tokenSet(defaultCandidate?.normalized_description);
  let bestFdcId = defaultFdcId;
  let bestOverlap = -1;
  for (const candidate of tie) {
    if (candidate.fdc_id === defaultFdcId) continue;
    if (!hasCompatibleAuthenticatedMass(session, entry, candidate.fdc_id, measurementKind)) continue;
    const overlap = overlapCount(defaultTokens, tokenSet(candidate.normalized_description));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestFdcId = candidate.fdc_id;
    }
  }
  return bestFdcId;
}

/**
 * Order-independent token key for one candidate's normalized description. Used
 * ONLY to prove two USDA records are the SAME food (identical description token
 * set), never to compare different foods.
 */
function descriptionTokenKey(description: unknown): string {
  if (typeof description !== 'string' || description.length === 0) return '';
  return description.toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
}

/**
 * STRICT-SELECTION PORTION EQUIVALENCE (VOLUME ONLY). A strict automatic
 * selection (unique exact / unambiguous specific match) is never reordered
 * toward a different food. When the strict record exposes NO compatible
 * authenticated VOLUME portion at all for the recipe's measurement, and
 * ANOTHER candidate carries the IDENTICAL normalized description token set (an
 * equivalent duplicate USDA record of the SAME food, e.g. two `Cream, heavy`
 * records), preferring the portion-bearing duplicate is a pure
 * measurement-resolution choice, not an identity change.
 *
 * Count/stalk-style interpretations are deliberately NOT reordered here: the
 * Phase 1/4/5/6 contract keeps size-specific count portions from binding an
 * unsized requirement, and an ambiguous-but-present portion set stays with the
 * strict default. The identity gate is never crossed.
 */
function chooseDescriptionEquivalentPortionFood(
  session: AdvancedNutritionSession,
  entry: AdaptedIngredient,
  review: IngredientReviewResult,
  defaultFdcId: number,
  measurementKind: string
): number {
  if (measurementKind !== 'volume') return defaultFdcId;
  if (hasCompatibleAuthenticatedMass(session, entry, defaultFdcId, measurementKind)) {
    return defaultFdcId;
  }
  const defaultCandidate = review.candidates.find((candidate) => candidate.fdc_id === defaultFdcId);
  const defaultKey = descriptionTokenKey(defaultCandidate?.normalized_description);
  if (defaultKey.length === 0) return defaultFdcId;
  for (const candidate of review.candidates) {
    if (candidate.fdc_id === defaultFdcId) continue;
    if (descriptionTokenKey(candidate.normalized_description) !== defaultKey) continue;
    if (hasCompatibleAuthenticatedMass(session, entry, candidate.fdc_id, measurementKind)) {
      return candidate.fdc_id;
    }
  }
  return defaultFdcId;
}

/**
 * Analyzes one adapted recipe: deterministic auto-selection + auto-portion +
 * compact row statuses + advisory preview. Never throws for an adapted recipe.
 */
export function analyzeRecipe(
  session: AdvancedNutritionSession,
  adapted: ReadonlyArray<AdaptedIngredient>,
  baseServings = 1
): RecipeAnalysis {
  const rows = buildReviewRows(session, adapted);
  const adaptedByRef = new Map(adapted.map((entry) => [entry.line_ref, entry]));

  const matches: Record<string, MatchChoice> = {};
  const portions: Record<string, PortionChoice> = {};
  const countPortions: Record<string, CountPortionChoice> = {};

  const analyzed: AnalyzedRow[] = [];
  let autoMatches = 0;
  let autoPortions = 0;

  for (const row of rows) {
    const entry = adaptedByRef.get(row.line_ref);
    const review = reviewOf(row);
    const parsed = entry ? parseIngredient(entry.ingredient) : undefined;
    const measurementKind = parsed && parsed.ok ? parsed.parsed.measurement_kind : 'unknown';
    const originalText = row.original_text || row.query;
    const hasMassRange = hasExplicitMassRange(originalText);

    const base = {
      line_ref: row.line_ref,
      original_text: row.original_text,
      query: row.query,
      review_digest: row.review_digest,
      review: row.review,
      candidates: row.candidates,
    };

    if (row.outcome === 'qualitative') {
      analyzed.push({
        ...base,
        status: 'qualitative',
        confidence: 'unresolved',
        selected_fdc_id: undefined,
        selected_description: undefined,
        match_class: undefined,
        auto_portion: false,
        reason: 'qualitative',
      });
      continue;
    }

    if (row.outcome === 'invalid' || row.outcome === 'unmatched' || !review) {
      analyzed.push({
        ...base,
        status: row.outcome === 'invalid' ? 'unresolved' : 'needs_match',
        confidence: 'unresolved',
        selected_fdc_id: undefined,
        selected_description: undefined,
        match_class: undefined,
        auto_portion: false,
        reason: row.outcome,
      });
      continue;
    }

    const confidence = classifyReviewConfidence(review);
    const automatic = selectBestEffortMatch(review);

    if (!automatic) {
      // No automatic authority: a credible top candidate (high/review) is
      // "review suggested"; only a genuinely unresolved match is "needs match".
      const credible = confidence !== 'unresolved';
      analyzed.push({
        ...base,
        status: credible ? 'matched_check' : 'needs_match',
        confidence,
        selected_fdc_id: undefined,
        selected_description: undefined,
        match_class: undefined,
        auto_portion: false,
        reason: credible ? 'review_suggested' : 'no_confident_match',
      });
      continue;
    }

    // Portion-aware candidate resolution. Food identity always wins over portion
    // availability: a best-effort default may prefer a same-family sibling, and a
    // STRICT selection may only prefer an IDENTICAL-description duplicate record.
    const strict = selectAutomaticMatch(review);
    const chosenFdcId = entry
      ? strict === undefined
        ? chooseBestEffortFood(session, entry, review, automatic.fdc_id, measurementKind)
        : chooseDescriptionEquivalentPortionFood(session, entry, review, automatic.fdc_id, measurementKind)
      : automatic.fdc_id;
    const selected = review.candidates.find((candidate) => candidate.fdc_id === chosenFdcId);
    const selectedDescription = selected?.description;

    // Record an automatic match choice only for a review-required row; a
    // unique-exact row is auto-selected by the calculation engine directly.
    if (row.outcome === 'review_required') {
      matches[row.line_ref] = Object.freeze({
        kind: 'candidate' as const,
        fdc_id: chosenFdcId,
        review_digest: row.review_digest ?? '',
        automatic: true,
      });
      autoMatches += 1;
    }

    // Deterministic automatic volume-portion resolution (never for a mass line,
    // and never when the ingredient embeds an explicit mass range).
    let autoPortion = false;
    if (
      entry &&
      parsed &&
      parsed.ok &&
      measurementKind === 'volume' &&
      !hasMassRange &&
      parsed.parsed.milliliters !== undefined
    ) {
      const portion = selectDeterministicVolumePortion(
        session,
        chosenFdcId,
        measurementKind,
        parsed.parsed.milliliters,
        parsed.parsed.normalized_unit,
        row.query
      );
      if (portion) {
        const choice = buildPortionChoice(session, {
          lineRef: row.line_ref,
          ingredient: entry.ingredient,
          review: row.outcome === 'review_required' ? row.review : undefined,
          selection: row.outcome === 'review_required' ? selectionForAuto(review, chosenFdcId) : undefined,
          automaticSelection: row.outcome === 'review_required',
          fdcId: chosenFdcId,
          portionIndex: portion.index,
        });
        if (choice.ok) {
          portions[row.line_ref] = Object.freeze({ ...choice.choice, automatic: true });
          autoPortion = true;
          autoPortions += 1;
        }
      }
    }

    analyzed.push({
      ...base,
      status: 'matched',
      confidence: 'high',
      selected_fdc_id: chosenFdcId,
      selected_description: selectedDescription,
      match_class: automatic.match_class,
      auto_portion: autoPortion,
      reason: hasMassRange ? 'explicit_mass_range' : 'high_confidence',
    });
  }

  // Compute the advisory preview through the genuine session so the compact
  // table can report resolved mass and coverage without any persistence.
  const servings = Number.isFinite(baseServings) && baseServings > 0 ? baseServings : 1;
  const syntheticState = {
    version: '',
    status: 'ready',
    recipeKey: null,
    sessionIdentity: null,
    baseServings: servings,
    rows,
    matches,
    portions,
    countPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: servings,
    preview: null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as unknown as Phase4State;

  const request = buildCalculationRequest(adapted, syntheticState);
  const calculated = session.calculate(request);
  let preview = calculated.ok ? calculated.preview : undefined;

  // Phase 6 verified household-portion fallback. LOWEST authority: a household
  // choice is created ONLY for a line the higher-authority machinery left
  // without a resolved mass (the first preview above already reflects direct
  // mass, user mass, USDA source portions, and automatic count portions). The
  // builder performs its own full-binding verification through the genuine
  // session, so the stored choice can never be one the calculator rejects.
  const householdPortions: Record<string, HouseholdPortionChoice> = {};
  if (preview) {
    const analyzedByRef = new Map(analyzed.map((row) => [row.line_ref, row]));
    for (const row of rows) {
      const entry = adaptedByRef.get(row.line_ref);
      if (!entry) continue;
      const analyzedRow = analyzedByRef.get(row.line_ref);
      if (!analyzedRow || analyzedRow.status !== 'matched') continue;
      const selectedFdcId = analyzedRow.selected_fdc_id;
      if (selectedFdcId === undefined) continue;
      const evidence = preview.ingredients.find((item) => item.line_ref === row.line_ref);
      if (!evidence || evidence.outcome === 'calculated' || evidence.qualitative) continue;
      const review = row.outcome === 'review_required' ? reviewOf(row) : undefined;
      const built = buildHouseholdPortionChoice(session, {
        lineRef: row.line_ref,
        ingredient: entry.ingredient,
        review: row.outcome === 'review_required' ? row.review : undefined,
        selection:
          row.outcome === 'review_required' && review
            ? selectionForAuto(review, selectedFdcId)
            : undefined,
        automaticSelection: row.outcome === 'review_required',
        fdcId: selectedFdcId,
      });
      if (built.ok) householdPortions[row.line_ref] = built.choice;
    }
  }
  if (Object.keys(householdPortions).length > 0) {
    const withHouseholdState = {
      ...syntheticState,
      householdPortions,
    } as unknown as Phase4State;
    const householdRequest = buildCalculationRequest(adapted, withHouseholdState);
    const householdCalculated = session.calculate(householdRequest);
    if (householdCalculated.ok) preview = householdCalculated.preview;
  }

  // Refine the food-level status with mass evidence from the preview: a
  // high-confidence food whose mass cannot be resolved is `needs_amount`.
  const resolvedRefs = new Set<string>();
  if (preview) {
    for (const evidence of preview.ingredients) {
      if (evidence.outcome === 'calculated') resolvedRefs.add(evidence.line_ref);
    }
  }

  const finalRows = analyzed.map((row) => {
    if (row.status !== 'matched' || !preview) return row;
    if (resolvedRefs.has(row.line_ref)) return row;
    return Object.freeze({ ...row, status: 'needs_amount' as const });
  });

  const summary = {
    total: finalRows.length,
    matched: finalRows.filter((row) => row.status === 'matched').length,
    matched_check: finalRows.filter((row) => row.status === 'matched_check').length,
    needs_amount: finalRows.filter((row) => row.status === 'needs_amount').length,
    needs_match: finalRows.filter((row) => row.status === 'needs_match').length,
    unresolved: finalRows.filter((row) => row.status === 'unresolved').length,
    qualitative: finalRows.filter((row) => row.status === 'qualitative').length,
    auto_matches: autoMatches,
    auto_portions: autoPortions,
  };

  return Object.freeze({
    version: ANALYZER_VERSION,
    rows: Object.freeze(finalRows),
    matches: Object.freeze(matches),
    portions: Object.freeze(portions),
    countPortions: Object.freeze(countPortions),
    householdPortions: Object.freeze(householdPortions),
    preview,
    summary: Object.freeze(summary),
  });
}
