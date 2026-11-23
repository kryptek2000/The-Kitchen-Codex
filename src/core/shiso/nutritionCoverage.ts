/**
 * One derived view of the current source rows plus accepted nutrition
 * contributions. Source matching remains intact on each row; an accepted
 * contribution only changes effective nutrient coverage for its own line.
 */
import { hasUsableAiNutrientValue, type AiNutrientContribution } from '../nutritionV2/aiContribution';
import type { LiveRowState } from '../nutritionV2/phase4/liveRow';
import { NUTRIENT_REGISTRY, type NutrientId } from '../nutritionV2/nutrients';
import type { AdvisoryNutritionPreview } from '../nutritionV2/calculation/types';
import { sumNutrientSupplements } from '../nutritionV2/aiContribution';

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

export interface ShisoNutrientGapLine {
  readonly line_ref: string;
  readonly label: string;
  readonly fdc_id?: number;
  readonly record_digest?: string;
  readonly weight_grams?: number;
  readonly source_release?: string;
}

/**
 * Read-only whole-recipe nutrient coverage published by Advanced Nutrition.
 * `derived_source_subtotal` is the existing engine total minus explicit AI
 * contribution amounts; it is a display subtotal, not a second calculator.
 */
export interface ShisoNutrientCoverageEntry {
  readonly id: NutrientId;
  readonly label: string;
  readonly unit: string;
  readonly status: 'complete' | 'partial' | 'unknown';
  readonly total_amount: number | null;
  readonly ai_estimated_amount: number;
  readonly derived_source_subtotal: number | null;
  readonly covered_ingredient_count: number;
  readonly measurable_ingredient_count: number;
  /** Source-backed lines that do not contribute this nutrient and remain unsupplemented. */
  readonly missing_source_lines: ReadonlyArray<ShisoNutrientGapLine>;
  /** Source-backed lines whose missing nutrient is covered by an AI supplement. */
  readonly supplemented_lines?: ReadonlyArray<ShisoNutrientGapLine>;
  /** AI-estimated lines that do not contribute this nutrient. */
  readonly missing_ai_lines: ReadonlyArray<ShisoNutrientGapLine>;
  /** Explicit supplemental AI amount for this nutrient. */
  readonly supplemental_estimated_amount?: number;
}

/**
 * Maps the EXISTING calculated preview into a read-only whole-recipe nutrient
 * coverage view. It does not calculate nutrients; it reports the preview's
 * totals and `contributing_nutrients` plus the explicit AI contribution
 * amounts/unknown lists.
 */
export function buildShisoNutrientCoverage(
  preview: AdvisoryNutritionPreview | null | undefined,
): ReadonlyArray<ShisoNutrientCoverageEntry> {
  if (!preview) return [];
  const ai = (preview.ai_contributions ?? []).filter((entry) => entry.disposition !== 'excluded');
  const sourceIngredients = preview.ingredients.filter(
    (entry) => entry.outcome === 'calculated' || entry.outcome === 'qualitative',
  );
  const supplements = preview.nutrient_supplements ?? [];
  const supplementTotals = sumNutrientSupplements(supplements) as Record<string, {
    amount: number;
    covered_ingredient_count: number;
    lines: ReadonlySet<string>;
  }>;
  return preview.nutrient_scope.flatMap((id) => {
    const definition = NUTRIENT_REGISTRY[id];
    if (!definition) return [];
    const total = preview.totals[id];
    const sourceGapCandidates = sourceIngredients
      // Only calculated, USDA-identified lines can carry a source-bound
      // supplement. A qualitative line has no nutrient record or mass basis.
      .filter((entry) => entry.outcome === 'calculated' && entry.fdc_id !== undefined)
      .filter((entry) => !entry.contributing_nutrients.includes(id))
      .map((entry) => ({
        line_ref: entry.line_ref,
        label: entry.original_text.slice(0, 200),
        ...(entry.fdc_id !== undefined ? { fdc_id: entry.fdc_id } : {}),
        ...(entry.record_digest !== undefined ? { record_digest: entry.record_digest } : {}),
        ...(entry.resolved_grams !== undefined ? { weight_grams: entry.resolved_grams } : {}),
        source_release: preview.bundle_release,
      }));
    const supplement = supplementTotals[id];
    const supplementedLines = sourceGapCandidates.filter((entry) => supplement?.lines.has(entry.line_ref));
    const missingSourceLines = sourceGapCandidates.filter((entry) => !supplement?.lines.has(entry.line_ref));
    const missingAiLines = ai
      .filter((entry) => entry.nutrients[id] === undefined && entry.unknown_nutrients.includes(id))
      .map((entry) => ({ line_ref: entry.line_ref, label: entry.ingredient.slice(0, 200) }));
    const aiAmount = ai.reduce((sum, entry) => sum + (entry.nutrients[id]?.amount ?? 0), 0);
    const supplementAmount = supplement?.amount ?? 0;
    const roundedAi = Math.round(aiAmount * 1e6) / 1e6;
    const roundedSupplement = Math.round(supplementAmount * 1e6) / 1e6;
    const totalAmount = total?.amount ?? null;
    return [{
      id,
      label: definition.label,
      unit: total?.unit ?? definition.unit,
      status: total ? total.status : 'unknown',
      total_amount: totalAmount,
      ai_estimated_amount: roundedAi,
      supplemental_estimated_amount: roundedSupplement,
      derived_source_subtotal:
        totalAmount === null
          ? null
          : Math.max(0, Math.round((totalAmount - roundedAi - roundedSupplement) * 1e6) / 1e6),
      covered_ingredient_count: total?.covered_ingredient_count ?? 0,
      measurable_ingredient_count:
        total?.measurable_ingredient_count ?? sourceIngredients.length + ai.length,
      missing_source_lines: missingSourceLines,
      supplemented_lines: supplementedLines,
      missing_ai_lines: missingAiLines,
    }];
  });
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
