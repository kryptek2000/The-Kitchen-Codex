/**
 * One derived view of the current source rows plus accepted nutrition
 * contributions. Source matching remains intact on each row; an accepted
 * contribution only changes effective nutrient coverage for its own line.
 */
import { hasUsableAiNutrientValue, type AiNutrientContribution } from '../nutritionV2/aiContribution';
import type { LiveRowState } from '../nutritionV2/phase4/liveRow';

export type EffectiveNutritionStatus =
  | 'source_backed'
  | 'qualitative'
  | 'ai_estimated'
  | 'ai_estimated_partial'
  | 'source_backed_contribution'
  | 'source_backed_contribution_partial'
  | 'excluded'
  | 'needs_amount'
  | 'needs_match'
  | 'review_suggested';

export interface EffectiveNutritionLine {
  readonly line_ref: string;
  readonly source_status: LiveRowState['status'];
  readonly status: EffectiveNutritionStatus;
  /** A validated contribution may contain only unknown nutrients; it remains visible but is not coverage. */
  readonly candidate_contribution?: AiNutrientContribution;
  readonly contribution?: AiNutrientContribution;
  readonly known_nutrients: readonly string[];
  readonly unknown_nutrients: readonly string[];
  readonly resolved: boolean;
  readonly partial_known: boolean;
}

export interface NutritionCoverage {
  readonly lines: readonly EffectiveNutritionLine[];
  readonly total: number;
  readonly resolved: number;
  readonly source_backed: number;
  readonly ai_estimated: number;
  readonly source_backed_contributions: number;
  readonly excluded: number;
  readonly partial_known: number;
  readonly qualitative: number;
  readonly needs_amount: number;
  readonly needs_match: number;
  readonly review_suggested: number;
  readonly unresolved: number;
  readonly reconciled: boolean;
}

/**
 * Derives the only coverage state that should be used for summaries, row
 * badges, SHISO context, and unresolved-line investigation. A known zero is a
 * usable value; an unknown-only estimate is not.
 */
export function deriveNutritionCoverage(
  rows: readonly LiveRowState[],
  contributions: readonly AiNutrientContribution[] = [],
): NutritionCoverage {
  const rowByRef = new Map(rows.map((row) => [row.line_ref, row]));
  const contributionByRef = new Map<string, AiNutrientContribution>();
  const candidateByRef = new Map<string, AiNutrientContribution>();
  for (const contribution of contributions) {
    const row = rowByRef.get(contribution.line_ref);
    if (!row || row.status === 'matched' || row.status === 'qualitative') continue;
    if (candidateByRef.has(contribution.line_ref)) continue;
    candidateByRef.set(contribution.line_ref, contribution);
    if (hasUsableAiNutrientValue(contribution)) contributionByRef.set(contribution.line_ref, contribution);
  }

  let sourceBacked = 0;
  let aiEstimated = 0;
  let sourceBackedContributions = 0;
  let excluded = 0;
  let partialKnown = 0;
  let qualitative = 0;
  let needsAmount = 0;
  let needsMatch = 0;
  let reviewSuggested = 0;

  const lines = rows.map((row): EffectiveNutritionLine => {
    if (row.status === 'matched') {
      sourceBacked += 1;
      return { line_ref: row.line_ref, source_status: row.status, status: 'source_backed', known_nutrients: [], unknown_nutrients: [], resolved: true, partial_known: false };
    }
    if (row.status === 'qualitative') {
      qualitative += 1;
      return { line_ref: row.line_ref, source_status: row.status, status: 'qualitative', known_nutrients: [], unknown_nutrients: [], resolved: true, partial_known: false };
    }

    const candidateContribution = candidateByRef.get(row.line_ref);
    if (candidateContribution?.disposition === 'excluded') {
      excluded += 1;
      return { line_ref: row.line_ref, source_status: row.status, status: 'excluded', candidate_contribution: candidateContribution, known_nutrients: [], unknown_nutrients: [], resolved: false, partial_known: false };
    }
    const contribution = contributionByRef.get(row.line_ref);
    if (contribution) {
      const known = Object.keys(contribution.nutrients);
      const unknown = [...contribution.unknown_nutrients];
      const partial = unknown.length > 0;
      if (partial) partialKnown += 1;
      const ai = contribution.classification === 'ai_estimate';
      if (ai) aiEstimated += 1;
      else sourceBackedContributions += 1;
      return {
        line_ref: row.line_ref,
        source_status: row.status,
        status: ai
          ? partial ? 'ai_estimated_partial' : 'ai_estimated'
          : partial ? 'source_backed_contribution_partial' : 'source_backed_contribution',
        candidate_contribution: candidateContribution,
        contribution,
        known_nutrients: known,
        unknown_nutrients: unknown,
        resolved: true,
        partial_known: partial,
      };
    }

    if (row.status === 'needs_amount') needsAmount += 1;
    else if (row.status === 'needs_match') needsMatch += 1;
    else reviewSuggested += 1;
    return {
      line_ref: row.line_ref,
      source_status: row.status,
      status: row.status,
      ...(candidateContribution ? { candidate_contribution: candidateContribution } : {}),
      unknown_nutrients: candidateContribution ? [...candidateContribution.unknown_nutrients] : [],
      known_nutrients: [],
      resolved: false,
      partial_known: false,
    };
  });

  const total = rows.length;
  const unresolved = needsAmount + needsMatch + reviewSuggested;
  const resolved = sourceBacked + qualitative + aiEstimated + sourceBackedContributions;
  return Object.freeze({
    lines: Object.freeze(lines),
    total,
    resolved,
    source_backed: sourceBacked,
    ai_estimated: aiEstimated,
    source_backed_contributions: sourceBackedContributions,
    excluded,
    partial_known: partialKnown,
    qualitative,
    needs_amount: needsAmount,
    needs_match: needsMatch,
    review_suggested: reviewSuggested,
    unresolved,
    reconciled: resolved + unresolved + excluded === total,
  });
}

export function nutritionCoverageSummary(coverage: NutritionCoverage): string {
  return `${coverage.total} ingredient lines: ${coverage.source_backed} source-backed, ` +
    `${coverage.ai_estimated} AI-estimated, ${coverage.source_backed_contributions} other source-backed contributions, ` +
    `${coverage.excluded} excluded cooking material${coverage.excluded === 1 ? '' : 's'}, ` +
    `${coverage.partial_known} with partial known nutrients, ${coverage.unresolved} requiring attention ` +
    `(${coverage.needs_amount} need amount, ${coverage.needs_match} need a match, ${coverage.review_suggested} need source review).`;
}
