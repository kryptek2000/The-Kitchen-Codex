/**
 * The Kitchen Codex — SHISO bounded batch ingredient investigation.
 *
 * Audit H-1. The human test showed that a 12-ingredient recipe with nine
 * unresolved lines cannot be investigated inside a per-turn tool budget: the
 * model burned one model+tool cycle per ingredient, hit the ceiling, and the
 * turn then reported "here is what I found so far" having found nothing.
 *
 * This module replaces that loop with ONE deterministic, local, bounded pass.
 *
 * WHAT IT IS NOT:
 *   - it is NOT a matcher. It never scores, ranks or invents a candidate. Every
 *     food identity it reports came from `session.reviewIngredient`, which is the
 *     application's EXISTING deterministic ranked authority.
 *   - it is NOT a calculator. It computes no nutrient value and no gram weight
 *     of its own. Every gram weight it reports is a gram weight the authenticated
 *     USDA portion record states.
 *   - it is NOT a catalog. It never searches, fetches, or holds USDA data; it
 *     asks the session that already owns the authenticated bundle.
 *   - it is NOT a mutation. It selects nothing. It produces EVIDENCE plus the
 *     digests a proposal needs; whether anything is applied remains an explicit
 *     user action revalidated against live state by `prepareShisoProposalActions`.
 *
 * Because it makes no model call, its cost is a CPU-bound scan of the already
 * in-memory review, so a bound here is a response-size bound rather than a
 * spend bound. A recipe with more unresolved lines than one pass covers is
 * RESUMED through `next_cursor` rather than silently truncated.
 */

import { SHISO_LIMITS } from './protocol';
import type { AdvancedNutritionSession } from '../nutritionV2/phase4';
import type { LiveRowState } from '../nutritionV2/phase4/liveRow';

/**
 * How the application itself resolved one line, stated in terms the user can act
 * on. These are classifications OF EXISTING AUTHORITY OUTPUT, never judgements
 * invented by a model.
 */
export type ShisoLineClassification =
  /** Already matched with a mass. Nothing to investigate. */
  | 'resolved'
  /** No food identity is confident enough to select; candidates may still exist to show. */
  | 'needs_food_identity'
  /**
   * The deterministic engine has a SUGGESTED match awaiting human review. This
   * was the fifth live status and was invisible in the H-1 reports, which is why
   * the human test saw 3 + 5 + 3 = 11 for a 12-ingredient recipe.
   */
  | 'suggested_match_awaiting_review'
  /**
   * Food identity is known but no portion yields a mass, and at least one
   * COMPATIBLE alternative record DOES carry authenticated portions. A verified
   * correction is available for the user to approve.
   */
  | 'alternative_portion_available'
  /** Food identity is known, a count-portion measurement exists. */
  | 'count_portion_available'
  /**
   * Food identity is known but no authenticated mass can be derived and no
   * compatible alternative helps. Only a human-supplied measurement can fix it.
   */
  | 'needs_user_measurement'
  /** The live row could not be read at all. */
  | 'unreadable';

export interface ShisoBatchAlternative {
  readonly fdc_id: number;
  readonly description: string;
  readonly match_class: string;
  readonly record_digest: string;
  readonly review_digest: string | null;
  readonly usable_portions: ReadonlyArray<{
    readonly index: number;
    readonly measure: string;
    readonly gram_weight: number;
  }>;
}

export interface ShisoBatchLine {
  readonly line_ref: string;
  readonly label: string;
  readonly status: LiveRowState['status'];
  readonly classification: ShisoLineClassification;
  /** The plain-language reason, derived from authority output only. */
  readonly reason: string;
  readonly current_food: string | null;
  readonly current_fdc_id: number | null;
  readonly mass_source: string | null;
  readonly resolved_grams: number | null;
  /** Ranked compatible alternatives that carry an authenticated portion. */
  readonly alternatives: readonly ShisoBatchAlternative[];
  /** Candidates offered for a line that has no confident identity yet. */
  readonly candidates: ReadonlyArray<{
    readonly fdc_id: number;
    readonly description: string;
    readonly match_class: string;
    readonly record_digest: string;
    readonly review_digest: string | null;
  }>;
  /** True when the user could approve a correction that resolves this line. */
  readonly correction_available: boolean;
}

export interface ShisoBatchReport {
  /** Lines examined in THIS pass. */
  readonly examined: number;
  /** Unresolved lines in the whole review, before this pass was bounded. */
  readonly total_unresolved: number;
  /** Unresolved lines NOT covered by this pass. */
  readonly remaining: number;
  readonly counts: Readonly<Record<ShisoLineClassification, number>>;
  readonly lines: readonly ShisoBatchLine[];
  /** Non-null when more unresolved lines remain than this pass covered. */
  readonly next_cursor: string | null;
  /** True when every unresolved line was examined. */
  readonly complete: boolean;
}

function isUsablePortion(c: {
  kind: string;
  gram_weight: number;
}): boolean {
  return c.kind !== 'unusable' && c.gram_weight > 0 && c.gram_weight < 100000;
}

/**
 * Reuses the SAME compatibility rule the per-ingredient probe uses: walk the
 * deterministic ranked candidate set for the line's own text, keep the records
 * whose authenticated portions carry a usable gram weight, and never look
 * outside that ranked set.
 */
function collectAlternatives(
  session: AdvancedNutritionSession,
  row: LiveRowState,
  excludeFdcId: number | null,
): ShisoBatchAlternative[] {
  const review = session.reviewIngredient({ name: row.original_text });
  if (review.outcome !== 'review_required' && review.outcome !== 'matched_exact') return [];
  const out: ShisoBatchAlternative[] = [];
  for (const candidate of review.candidates.slice(0, 10)) {
    if (candidate.fdc_id === excludeFdcId) continue;
    const portions = session.reviewPortions(candidate.fdc_id);
    if (!portions.ok) continue;
    const usable = portions.review.candidates.filter(isUsablePortion);
    if (usable.length === 0) continue;
    out.push({
      fdc_id: candidate.fdc_id,
      description: candidate.description.slice(0, 160),
      match_class: candidate.match_class,
      record_digest: candidate.record_digest,
      review_digest: review.review_digest ?? null,
      usable_portions: usable.slice(0, 4).map((c) => ({
        index: c.index,
        measure: c.measure.slice(0, 120),
        gram_weight: c.gram_weight,
      })),
    });
    if (out.length >= SHISO_LIMITS.maxBatchAlternativesPerLine) break;
  }
  return out;
}

/**
 * Classifies ONE line from authority output. Pure with respect to the model: it
 * reads only the live row and the authenticated session.
 */
export function classifyBatchLine(
  session: AdvancedNutritionSession,
  row: LiveRowState,
): ShisoBatchLine {
  const base = {
    line_ref: row.line_ref,
    label: row.original_text.slice(0, 120),
    status: row.status,
    current_food: row.selected_description ?? null,
    current_fdc_id: row.selected_fdc_id ?? null,
    mass_source: row.mass_source,
    resolved_grams: row.resolved_grams ?? null,
  };

  // needs_match: the food identity itself is unresolved.
  if (row.status === 'needs_match') {
    const review = session.reviewIngredient({ name: row.original_text });
    const reviewable = review.outcome === 'review_required' || review.outcome === 'matched_exact';
    const candidates = reviewable ? review.candidates.slice(0, 5) : [];
    // A candidate that carries a usable portion is an approvable correction.
    const approvable = candidates
      .map((c) => ({ c, portions: session.reviewPortions(c.fdc_id) }))
      .filter((e) => e.portions.ok && e.portions.review.candidates.some(isUsablePortion))
      .slice(0, SHISO_LIMITS.maxBatchAlternativesPerLine)
      .map((e) => ({
        fdc_id: e.c.fdc_id,
        description: e.c.description.slice(0, 160),
        match_class: e.c.match_class,
        record_digest: e.c.record_digest,
        review_digest: review.outcome === 'review_required' ? review.review_digest : null,
        usable_portions: e.portions.ok
          ? e.portions.review.candidates
              .filter(isUsablePortion)
              .slice(0, 4)
              .map((p) => ({ index: p.index, measure: p.measure.slice(0, 120), gram_weight: p.gram_weight }))
          : [],
      }));
    return {
      ...base,
      classification:
        approvable.length > 0 ? 'alternative_portion_available' : 'needs_food_identity',
      reason:
        candidates.length === 0
          ? 'The USDA catalogue returned no confident food for this ingredient.'
          : approvable.length > 0
            ? `No confident food match, but ${approvable.length} authenticated candidate record(s) carry usable portions you could approve.`
            : 'No confident food match. Candidates exist but none carries a usable portion, so choosing one would not resolve the amount.',
      alternatives: approvable,
      candidates: candidates.map((c) => ({
        fdc_id: c.fdc_id,
        description: c.description.slice(0, 160),
        match_class: c.match_class,
        record_digest: c.record_digest,
        review_digest: review.outcome === 'review_required' ? review.review_digest : null,
      })),
      correction_available: approvable.length > 0,
    };
  }

  // review_suggested: the deterministic engine already ranked a candidate but is
  // deliberately waiting for a human. The useful question is whether a BETTER
  // compatible record carries usable portions, because that is a correction the
  // user can actually approve.
  if (row.status === 'review_suggested') {
    const suggestedId = row.selected_fdc_id ?? null;
    const alternatives = collectAlternatives(session, row, suggestedId);
    const review = session.reviewIngredient({ name: row.original_text });
    const candidates =
      review.outcome === 'review_required' || review.outcome === 'matched_exact'
        ? review.candidates.slice(0, 5)
        : [];
    return {
      ...base,
      classification:
        alternatives.length > 0 ? 'alternative_portion_available' : 'suggested_match_awaiting_review',
      reason:
        alternatives.length > 0
          ? `The suggested match ${row.selected_description ?? 'on file'} has no usable portion, but ${alternatives.length} compatible alternative record(s) in the same ranked set DO carry authenticated portions.`
          : `The deterministic engine suggested ${row.selected_description ?? 'a record'} but is waiting for your confirmation. No compatible alternative record carries a usable portion, so approving the suggestion would not resolve the amount.`,
      alternatives,
      candidates: candidates.map((c) => ({
        fdc_id: c.fdc_id,
        description: c.description.slice(0, 160),
        match_class: c.match_class,
        record_digest: c.record_digest,
        review_digest: review.outcome === 'review_required' ? review.review_digest : null,
      })),
      correction_available: alternatives.length > 0,
    };
  }

  // needs_amount: food identity is known, the mass is not.
  const fdcId = row.selected_fdc_id;
  const alternatives = typeof fdcId === 'number' ? collectAlternatives(session, row, fdcId) : [];

  let selectedHasPortion = false;
  if (typeof fdcId === 'number') {
    const portions = session.reviewPortions(fdcId);
    if (portions.ok) selectedHasPortion = portions.review.candidates.some(isUsablePortion);
  }

  let countPortion = false;
  if (typeof fdcId === 'number') {
    const counts = session.reviewCountPortions({ name: row.original_text }, fdcId);
    if (counts.ok) countPortion = counts.review.applicable;
  }

  if (alternatives.length > 0) {
    return {
      ...base,
      classification: 'alternative_portion_available',
      reason: `The selected USDA record ${selectedHasPortion ? 'has' : 'does not have'} a usable portion, but ${alternatives.length} compatible alternative record(s) in the same ranked set DO carry authenticated portions.`,
      alternatives,
      candidates: [],
      correction_available: true,
    };
  }
  if (countPortion) {
    return {
      ...base,
      classification: 'count_portion_available',
      reason:
        'The selected USDA record carries count-based portion measures (for example one egg, one slice), which can supply the amount without weighing.',
      alternatives: [],
      candidates: [],
      correction_available: true,
    };
  }
  return {
    ...base,
    classification: 'needs_user_measurement',
    reason:
      'The food identity is established, but no authenticated portion in any compatible record supplies a gram weight for this amount. Only a measurement you enter yourself can resolve it.',
    alternatives: [],
    candidates: [],
    correction_available: false,
  };
}

const CLASSIFICATIONS: readonly ShisoLineClassification[] = [
  'resolved',
  'needs_food_identity',
  'suggested_match_awaiting_review',
  'alternative_portion_available',
  'count_portion_available',
  'needs_user_measurement',
  'unreadable',
];

/** The three statuses that mean "the user still has something to decide". */
const UNRESOLVED_STATUSES: ReadonlySet<string> = new Set([
  'needs_amount',
  'needs_match',
  'review_suggested',
]);

/**
 * Runs ONE bounded pass over the live review.
 *
 * `cursor` is the `line_ref` the previous pass stopped before, so a recipe with
 * more unresolved lines than one pass covers is resumed deterministically and
 * never re-investigated from scratch.
 */
export function runBatchInvestigation(params: {
  readonly session: AdvancedNutritionSession;
  readonly rows: readonly LiveRowState[];
  readonly cursor?: string | undefined;
  readonly statuses?: readonly ('needs_amount' | 'needs_match')[] | undefined;
}): ShisoBatchReport {
  const { session, rows } = params;
  const wanted = params.statuses;
  const isUnresolved = (r: LiveRowState): boolean =>
    UNRESOLVED_STATUSES.has(r.status) &&
    (wanted === undefined || wanted.includes(r.status as 'needs_amount'));

  const unresolved = rows.filter(
    (r) => isUnresolved(r) && (wanted === undefined || wanted.includes(r.status as 'needs_amount')),
  );

  // The cursor names the LAST line the previous pass already examined, so the
  // resumed pass starts AFTER it. Resuming AT it would silently repeat one
  // line's work, which is the very waste this capability exists to remove.
  const startIndex =
    params.cursor === undefined
      ? 0
      : unresolved.findIndex((r) => r.line_ref === params.cursor) + 1;

  const slice = unresolved.slice(startIndex, startIndex + SHISO_LIMITS.maxBatchIngredients);
  const nextCursor =
    startIndex + SHISO_LIMITS.maxBatchIngredients < unresolved.length && slice.length > 0
      ? (slice[slice.length - 1] as LiveRowState).line_ref
      : null;

  const lines: ShisoBatchLine[] = [];
  for (const row of slice) {
    try {
      lines.push(classifyBatchLine(session, row));
    } catch {
      lines.push({
        line_ref: row.line_ref,
        label: row.original_text.slice(0, 120),
        status: row.status,
        classification: 'unreadable',
        reason: 'This line could not be evaluated against the authenticated catalogue.',
        current_food: row.selected_description ?? null,
        current_fdc_id: row.selected_fdc_id ?? null,
        mass_source: row.mass_source,
        resolved_grams: row.resolved_grams ?? null,
        alternatives: [],
        candidates: [],
        correction_available: false,
      });
    }
  }

  const counts = Object.fromEntries(
    CLASSIFICATIONS.map((c) => [c, lines.filter((l) => l.classification === c).length]),
  ) as Record<ShisoLineClassification, number>;

  return {
    examined: lines.length,
    total_unresolved: unresolved.length,
    remaining: Math.max(0, unresolved.length - lines.length),
    counts,
    lines,
    next_cursor: nextCursor,
    complete: nextCursor === null,
  };
}
