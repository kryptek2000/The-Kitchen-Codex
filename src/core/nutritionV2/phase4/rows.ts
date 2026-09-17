/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: review-row and request builders.
 *
 * PURE, offline. Bridges the adapted recipe ingredients to the genuine session
 * (authoritative reviews) and to the Phase 3 calculation request. It never
 * auto-selects a candidate or a portion, never invents an amount, and never
 * treats a qualitative ingredient as measurable.
 */

import { parseIngredient } from '../matching/parse';
import { candidatePortionCompatibility } from '../calculation/portionSemantics';
export { candidatePortionCompatibility };
import type { MeasurementKind } from '../../../utils/measurements';
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

function evidenceText(matchClass: string, evidence: EvidenceLike): string {
  const matched = evidence.matched_query_token_count;
  const total = matched + evidence.missing_query_token_count;
  const parts = [matchClass, `tokens ${matched}/${total}`];
  if (evidence.exact_phrase) parts.push('exact phrase');
  else if (evidence.exact_token_multiset) parts.push('token set');
  parts.push(evidence.order_agreement ? 'order agrees' : 'order differs');
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
      review_digest?: unknown;
    };
    const parsed = parseIngredient(entry.ingredient);
    const outcome = classifyOutcome(review, parsed);
    const measurementKind: MeasurementKind = parsed.ok ? parsed.parsed.measurement_kind : 'unknown';
    const needsPortion = measurementKind !== 'mass';
    const candidates: Phase4CandidateView[] = (review.candidates ?? []).map((candidate) =>
      Object.freeze({
        fdc_id: candidate.fdc_id,
        data_type: candidate.data_type,
        description: candidate.description,
        match_class: candidate.match_class,
        rank_evidence: evidenceText(candidate.match_class, candidate.evidence),
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

/** The deterministic measurement dimension of an adapted ingredient. */
export function ingredientMeasurementKind(entry: AdaptedIngredient): MeasurementKind {
  const parsed = parseIngredient(entry.ingredient);
  return parsed.ok ? parsed.parsed.measurement_kind : 'unknown';
}

function selectionFor(choice: MatchChoice): unknown {
  if (choice.kind === 'candidate') {
    return { kind: 'candidate', fdc_id: choice.fdc_id, review_digest: choice.review_digest };
  }
  return { kind: 'none', review_digest: choice.review_digest };
}

/**
 * Builds the explicit Phase 3 calculation request from the current review state.
 * Only explicitly user-confirmed matches and portions are supplied; ambiguous
 * rows remain unresolved (never auto-selected).
 */
export function buildCalculationRequest(
  adapted: ReadonlyArray<AdaptedIngredient>,
  state: Phase4State
): unknown {
  const rowByRef = new Map(state.rows.map((row) => [row.line_ref, row]));
  return {
    servings: state.baseServings,
    nutrient_scope: [...NUTRIENT_IDS],
    ingredients: adapted.map((entry) => {
      const row = rowByRef.get(entry.line_ref);
      const choice = state.matches[entry.line_ref];
      const portion = state.portions[entry.line_ref];
      const userMass = state.userMasses[entry.line_ref];
      const confirmed = row !== undefined && row.outcome === 'review_required' && choice !== undefined;
      return {
        line_ref: entry.line_ref,
        ingredient: entry.ingredient,
        ...(confirmed ? { review: row.review, selection: selectionFor(choice) } : {}),
        ...(portion ? { portion_selection: portion.selection } : {}),
        ...(userMass ? { user_mass_selection: userMass.selection } : {}),
      };
    }),
  };
}
