/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: review-row and request builders.
 *
 * PURE, offline. Bridges the adapted recipe ingredients to the genuine session
 * (authoritative reviews) and to the Phase 3 calculation request. It never
 * auto-selects a candidate or a portion, never invents an amount, and never
 * treats a qualitative ingredient as measurable.
 */

import { parseIngredient } from '../matching/parse';
import { projectQueryText } from '../matching/query';
import { candidatePortionCompatibility } from '../calculation/portionSemantics';
export { candidatePortionCompatibility };
import { canonicalCountRequirementHint } from './countContext';
import {
  convertMassToGrams,
  type MeasurementKind,
  type NormalizedUnit,
} from '../../../utils/measurements';
import { isQualitativeIngredientText } from '../../../utils/ingredientSemantics';
import { NUTRIENT_IDS } from '../nutrients';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  MatchChoice,
  Phase4CandidateView,
  Phase4Row,
  Phase4State,
  ReviewOutcome,
} from './types';

interface EvidenceLike {
  readonly exact_phrase: boolean;
  readonly exact_token_multiset: boolean;
  readonly matched_query_token_count: number;
  readonly missing_query_token_count: number;
  readonly extra_candidate_token_count: number;
  readonly order_agreement: boolean;
}

function evidenceText(matchClass: string, evidence: EvidenceLike, aliasNote?: string): string {
  const matched = evidence.matched_query_token_count;
  const total = matched + evidence.missing_query_token_count;
  const parts = [matchClass, `tokens ${matched}/${total}`];
  if (evidence.exact_phrase) parts.push('exact phrase');
  else if (evidence.exact_token_multiset) parts.push('token set');
  parts.push(evidence.order_agreement ? 'order agrees' : 'order differs');
  if (aliasNote) parts.push(aliasNote);
  return parts.join(' · ');
}

function classifyOutcome(
  review: { outcome: string; candidates?: ReadonlyArray<unknown> },
  parsed: ReturnType<typeof parseIngredient>
): ReviewOutcome {
  if (review.outcome === 'invalid') return 'invalid';
  const hasMeasurable =
    parsed.ok && typeof parsed.parsed.amount === 'number' && Number.isFinite(parsed.parsed.amount);
  const qualitative =
    parsed.ok &&
    !hasMeasurable &&
    isQualitativeIngredientText(`${parsed.parsed.query} ${parsed.parsed.original_text}`);
  if (qualitative) return 'qualitative';
  if (review.outcome === 'matched_exact') return 'matched_exact';
  if (review.outcome === 'review_required') return 'review_required';
  return 'unmatched';
}

/**
 * Bounded portion-availability annotation for one candidate, computed through
 * the canonical portion-semantics layer. It never changes ranking or selection.
 */
function portionAnnotation(
  session: AdvancedNutritionSession,
  fdcId: number,
  measurementKind: MeasurementKind,
  needsPortion: boolean
): string {
  if (!needsPortion) return 'Direct mass; no source portion required';
  const portions = session.reviewPortions(fdcId);
  if (!portions.ok) return 'USDA portion data unavailable';
  const candidates = portions.review.candidates;
  if (candidates.length === 0) return 'No USDA source portions';
  const compatible = candidates.filter(
    (candidate) => candidatePortionCompatibility(candidate, measurementKind) === 'compatible'
  );
  if (compatible.length === 0) {
    return measurementKind === 'volume' ? 'No compatible USDA volume portion' : 'No compatible USDA portion';
  }
  return `USDA source portion: ${compatible[0].display_label}`;
}

/** Builds the authoritative current review row for every adapted ingredient. */
export function buildReviewRows(
  session: AdvancedNutritionSession,
  adapted: ReadonlyArray<AdaptedIngredient>
): ReadonlyArray<Phase4Row> {
  const rows: Phase4Row[] = adapted.map((entry) => {
    const review = session.reviewIngredient(entry.ingredient) as unknown as {
      outcome: string;
      candidates?: ReadonlyArray<{
        fdc_id: number;
        data_type: Phase4CandidateView['data_type'];
        description: string;
        match_class: string;
        evidence: EvidenceLike;
      }>;
      query?: unknown;
      normalized_query?: unknown;
      review_digest?: unknown;
    };
    const parsed = parseIngredient(entry.ingredient);
    const outcome = classifyOutcome(review, parsed);
    const measurementKind: MeasurementKind = parsed.ok ? parsed.parsed.measurement_kind : 'unknown';
    const needsPortion = measurementKind !== 'mass';
    // Bounded, understandable alias evidence for the current query.
    const normalizedForAlias = typeof review.normalized_query === 'string' ? review.normalized_query : '';
    const aliasNote =
      normalizedForAlias.length > 0
        ? (() => {
            const aliases = projectQueryText(normalizedForAlias).aliases;
            return aliases.length > 0 ? `alias ${aliases.join(', ')}` : undefined;
          })()
        : undefined;
    const candidates: Phase4CandidateView[] = (review.candidates ?? []).map((candidate) =>
      Object.freeze({
        fdc_id: candidate.fdc_id,
        data_type: candidate.data_type,
        description: candidate.description,
        match_class: candidate.match_class,
        rank_evidence: evidenceText(candidate.match_class, candidate.evidence, aliasNote),
        portion_annotation: portionAnnotation(session, candidate.fdc_id, measurementKind, needsPortion),
      })
    );
    return Object.freeze({
      line_ref: entry.line_ref,
      original_text: (entry.ingredient.original || entry.ingredient.name || '').trim(),
      outcome,
      query: typeof review.query === 'string' ? review.query : '',
      candidates: Object.freeze(candidates),
      review_digest: typeof review.review_digest === 'string' ? review.review_digest : undefined,
      selected_fdc_id: typeof (review as { selected_fdc_id?: unknown }).selected_fdc_id === 'number'
        ? (review as { selected_fdc_id?: number }).selected_fdc_id
        : undefined,
      review,
      note: typeof entry.ingredient.note === 'string' ? entry.ingredient.note : undefined,
    });
  });
  return Object.freeze(rows);
}

/** True when the ingredient has no direct mass and therefore needs a portion. */
export function ingredientNeedsPortion(entry: AdaptedIngredient): boolean {
  const parsed = parseIngredient(entry.ingredient);
  return parsed.ok && parsed.parsed.measurement_kind !== 'mass';
}

/**
 * True when the ingredient line itself declares a usable direct recipe mass
 * (g/kg/oz/lb). Such a line already has COMPLETE mass authority: the ONE
 * shared creation gate — every core mass-choice builder calls this — refuses
 * to create any alternate mass choice (user total, source portion, or count
 * portion) for it, and the effective-mass decision fails any conflicting
 * hand-built state closed.
 */
export function hasDirectRecipeMass(ingredient: unknown): boolean {
  const parsed = parseIngredient(ingredient);
  return (
    parsed.ok &&
    parsed.parsed.measurement_kind === 'mass' &&
    typeof parsed.parsed.grams === 'number' &&
    Number.isFinite(parsed.parsed.grams) &&
    parsed.parsed.grams >= 0
  );
}

/** The deterministic measurement dimension of an adapted ingredient. */
export function ingredientMeasurementKind(entry: AdaptedIngredient): MeasurementKind {
  const parsed = parseIngredient(entry.ingredient);
  return parsed.ok ? parsed.parsed.measurement_kind : 'unknown';
}

/** The parsed count amount of an adapted ingredient, or null when absent. */
export function ingredientCountAmount(entry: AdaptedIngredient): number | null {
  const parsed = parseIngredient(entry.ingredient);
  return parsed.ok ? parsed.parsed.amount : null;
}

/**
 * The deterministic parsed measurement of an adapted ingredient, projected
 * through the canonical Phase 2 parser at the Phase 4 boundary so the UI never
 * imports the matching module directly. `amount`/`raw_unit` are the recipe's own
 * quantity/unit; `milliliters`/`grams` are the deterministic canonical values
 * used to bind an authenticated USDA portion.
 */
export interface IngredientMeasurementView {
  readonly amount: number | null;
  readonly raw_unit: string | undefined;
  readonly measurement_kind: MeasurementKind;
  readonly milliliters: number | undefined;
  readonly grams: number | undefined;
}

export function ingredientMeasurement(entry: AdaptedIngredient): IngredientMeasurementView {
  const parsed = parseIngredient(entry.ingredient);
  if (!parsed.ok) {
    return Object.freeze({
      amount: null,
      raw_unit: undefined,
      measurement_kind: 'unknown' as MeasurementKind,
      milliliters: undefined,
      grams: undefined,
    });
  }
  const p = parsed.parsed;
  return Object.freeze({
    amount: p.amount,
    raw_unit: p.raw_unit,
    measurement_kind: p.measurement_kind,
    milliliters: p.milliliters,
    grams: p.grams,
  });
}

/**
 * Deterministic total grams for a selected authenticated source portion applied
 * to the recipe's own quantity/unit. This mirrors the calculator's exact
 * canonical-volume / mass ratio (no density, no average, no guess) so the UI can
 * show the resolved mass IMMEDIATELY after a portion is selected, without
 * waiting for a full preview recalculation. The calculator remains the
 * authority for the preview.
 */
export function derivedSourcePortionGrams(
  selection: unknown,
  measurement: IngredientMeasurementView
): number | undefined {
  if (typeof selection !== 'object' || selection === null) return undefined;
  const value = selection as Record<string, unknown>;
  const kind = value.semantics_kind;
  const gramWeight = value.semantics_gram_weight;
  if (typeof gramWeight !== 'number' || !Number.isFinite(gramWeight) || gramWeight <= 0) return undefined;
  if (kind === 'volume') {
    const volumeMl = value.semantics_volume_ml;
    if (typeof volumeMl !== 'number' || !(volumeMl > 0) || measurement.milliliters === undefined) {
      return undefined;
    }
    const grams = (measurement.milliliters / volumeMl) * gramWeight;
    return Number.isFinite(grams) && grams >= 0 ? grams : undefined;
  }
  if (kind === 'mass') {
    const amount = value.semantics_amount;
    const unit = value.semantics_unit;
    if (typeof amount !== 'number' || typeof unit !== 'string' || measurement.grams === undefined) {
      return undefined;
    }
    const massGrams = convertMassToGrams(amount, unit as NormalizedUnit);
    if (massGrams === undefined || !(massGrams > 0)) return undefined;
    const grams = (measurement.grams / massGrams) * gramWeight;
    return Number.isFinite(grams) && grams >= 0 ? grams : undefined;
  }
  return undefined;
}

/**
 * The explicit Phase 3 selection object for a working match choice. Exported so
 * the AI-assisted amount binder can build a count-portion choice that binds the
 * SAME authenticated food selection as the live row.
 */
export function selectionFromMatchChoice(choice: MatchChoice, lineRef: string): unknown {
  return selectionFor(choice, lineRef);
}

function selectionFor(choice: MatchChoice, lineRef: string): unknown {
  if (choice.kind === 'candidate') {
    return { kind: 'candidate', fdc_id: choice.fdc_id, review_digest: choice.review_digest };
  }
  if (choice.kind === 'manual') {
    return {
      kind: 'manual',
      fdc_id: choice.fdc_id,
      record_digest: choice.record_digest,
      catalog_digest: choice.catalog_digest,
      line_ref: lineRef,
      review_digest: choice.review_digest,
      // AI-assisted DETERMINISTIC acceptance only. An explicit user choice
      // (manual search / "Use this match") omits this marker.
      ...(choice.aiAccepted === true ? { ai_assisted: true } : {}),
    };
  }
  return { kind: 'none', review_digest: choice.review_digest };
}

/**
 * A BOUNDED review reference for the calculation request. The calculator
 * independently re-derives the genuine current review from the pinned catalog
 * and reads ONLY `review_digest` from the supplied object, so embedding the full
 * candidate evidence is unnecessary — and for a realistic multi-line recipe it
 * pushed the serialized request past the 64 KiB materialization bound, failing
 * the WHOLE calculation closed and silently discarding every accepted
 * resolution. The digest reference preserves every authentication check while
 * keeping the request small. A row without a review digest keeps its original
 * value (fail closed: the calculator still refuses to confirm it).
 */
function reviewReference(row: Phase4Row): unknown {
  let digest: string | undefined =
    typeof row.review_digest === 'string' ? row.review_digest : undefined;
  if (digest === undefined) {
    const review = row.review;
    if (review !== null && typeof review === 'object') {
      const value = (review as { review_digest?: unknown }).review_digest;
      if (typeof value === 'string') digest = value;
    }
  }
  if (digest === undefined) return row.review;
  return Object.freeze({ review_digest: digest });
}

/**
 * Builds the explicit Phase 3 calculation input for ONE adapted ingredient from
 * the current review state. This is the ONE construction shared by the full
 * request builder and the live projection's bounded per-line verification
 * dry-run, so the calculator and the display always re-derive the identical
 * identity digest and selection context for the same line and working state.
 * Only explicitly user-confirmed matches and portions are supplied; ambiguous
 * rows remain unresolved (never auto-selected).
 */
export function lineCalculationInput(
  entry: AdaptedIngredient,
  state: Phase4State,
  row: Phase4Row | undefined
): Record<string, unknown> {
  const choice = state.matches[entry.line_ref];
  const portion = state.portions[entry.line_ref];
  const countPortion = state.countPortions[entry.line_ref];
  const userMass = state.userMasses[entry.line_ref];
  // The ONE canonical count-identity context for this line: the sanitized
  // bounded hint bound to the stored count-portion choice. The calculator
  // re-derives the SAME candidate set/digest the live projection displays.
  const countRequirementHint = canonicalCountRequirementHint(state, entry.line_ref);
  // Any explicit user decision is supplied, not only a `review_required` row:
  // a user can manually select a USDA food for an `unmatched` (or
  // `matched_exact`) line via the full-catalog manual search, and that
  // selection must reach the calculation (and therefore persistence) — the
  // calculator independently re-authenticates it and fails closed if invalid.
  const confirmed = row !== undefined && choice !== undefined;
  return {
    line_ref: entry.line_ref,
    ingredient: entry.ingredient,
    ...(confirmed
      ? { review: reviewReference(row), selection: selectionFor(choice, entry.line_ref) }
      : {}),
    ...(confirmed && choice?.automatic === true ? { automatic_selection: true } : {}),
    ...(portion ? { portion_selection: portion.selection } : {}),
    ...(countPortion
      ? {
          count_portion_selection: countPortion.selection,
          // The canonical bounded count-identity hint accompanies the
          // selection so the calculator re-derives the SAME candidate set.
          ...(countRequirementHint !== undefined
            ? { count_requirement_hint: countRequirementHint }
            : {}),
        }
      : {}),
    ...(userMass ? { user_mass_selection: userMass.selection } : {}),
  };
}

/**
 * Builds the explicit Phase 3 calculation request from the current review state.
 */
export function buildCalculationRequest(
  adapted: ReadonlyArray<AdaptedIngredient>,
  state: Phase4State
): unknown {
  const rowByRef = new Map(state.rows.map((row) => [row.line_ref, row]));
  return {
    servings: state.baseServings,
    nutrient_scope: [...NUTRIENT_IDS],
    ingredients: adapted.map((entry) => lineCalculationInput(entry, state, rowByRef.get(entry.line_ref))),
  };
}
