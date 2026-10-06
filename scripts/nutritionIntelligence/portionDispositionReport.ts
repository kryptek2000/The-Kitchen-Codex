/**
 * The Kitchen Codex — Advanced Nutrition AI-6B2: portion disposition REPORT
 * BUILDER (planning only, ZERO production consumers).
 *
 * Gathers real evidence for every unresolved `deterministic_portion` line through
 * the existing PUBLIC session contracts, adjudicates each line into exactly one
 * closed disposition, and derives the next-lane handoff from MEASURED
 * repairability.
 *
 * Reusable so tests build the identical report in-process; the CLI wrapper
 * (`scripts/benchmark_nutrition_portion_disposition.ts`) only prints/serializes.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field enters the returned object. Two calls are byte-identical.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { canonicalHouseholdUnit } from '../../src/utils/householdUnits';
import { canonicalCountUnit } from '../../src/core/nutritionV2/calculation/countPortion';
import {
  PORTION_DISPOSITION_SCHEMA,
  PORTION_DISPOSITIONS,
  PORTION_EVIDENCE_CODES,
  classifyPortionDisposition,
  deriveNextWork,
  isAi6b2PortionDisposition,
  isAi6b2PortionEvidenceCode,
  type Ai6b2CountCandidateView,
  type Ai6b2LaneRepairability,
  type Ai6b2PortionDisposition,
  type Ai6b2PortionEvidence,
  type Ai6b2PortionEvidenceCode,
} from './portionDisposition';
import {
  AI6A_LANE_CRITERION_SCORES,
  AI6A_NEVER_TARGET_LANES,
  AI6A_ROADMAP_CRITERIA,
  laneForBlocker,
} from './taxonomy';
import { aggregate } from './summarize';
import { diagnoseCorpus, structuredIngredient, type Ai6aDiagnosticRecord } from './diagnose';
import { AI6A_INTELLIGENCE_CORPUS } from '../../tests/fixtures/advancedNutritionAi6aIntelligenceCorpus';
import {
  deriveAiEstimateParseFacts,
  evaluateAiEstimateEligibility,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe, type AnalyzedRow } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { projectQueryText } from '../../src/core/nutritionV2/matching/query';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';

const ROOT = resolve(import.meta.dirname, '../..');
const BUNDLE_DIR = join(
  ROOT,
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

/** The base production state this disposition report is measured against. */
export const BASE_PHASE = 'AI-6B1';
export const BASE_COMMIT = '210c511c40d7dfc642dc7143d89ffb88ff415b6d';

export interface Ai6b2ReportLine {
  readonly line: string;
  readonly primary_blocker: string;
  readonly repair_lane: string;
  readonly selected_fdc_id: number | null;
  readonly selected_description: string | null;
  readonly measurement_kind: string | null;
  readonly mass_source: string;
  readonly resolved_grams: number | null;
  readonly disposition: Ai6b2PortionDisposition;
  readonly evidence: Ai6b2PortionEvidenceCode;
  readonly repairable: boolean;
  readonly handoff_lane: string | null;
  /** Authenticated candidate masses considered, so ambiguity stays auditable. */
  readonly compatible_candidate_masses: ReadonlyArray<number>;
  /** AI-3 eligibility cross-check. AI-3 is the LOWEST authority and unchanged. */
  readonly ai3_eligible: boolean;
  readonly ai3_reason: string;
}

export interface Ai6b2DispositionReport {
  readonly schema: string;
  readonly tool: string;
  readonly base_phase: string;
  readonly base_commit: string;
  readonly production_baseline: {
    readonly historical_resolved: number;
    readonly historical_total: number;
    readonly legacy_resolved: number;
    readonly legacy_total: number;
    readonly raw_matched: number;
    readonly authenticated_mass_resolved: number;
    readonly safe_resolved: number;
    readonly verified_correct_auto_identity: number;
    readonly verified_unsafe_auto_identity: number;
    readonly corpus_total: number;
  };
  /** The observed blocker count — a TRUTH, never a work estimate. */
  readonly observed_portion_blockers: number;
  /** The MEASURED number of genuine deterministic implementation defects. */
  readonly repairable_deterministic_portion_defects: number;
  readonly portion_lane_exhausted: boolean;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly lane_repairability: ReadonlyArray<Ai6b2LaneRepairability>;
  readonly recommended_active_repair_lane: string | null;
  readonly recommended_active_repair_reason: string;
  readonly next_adjudication_target_lane: string | null;
  readonly next_adjudication_reason: string;
  readonly lines: ReadonlyArray<Ai6b2ReportLine>;
}

type CountSession = {
  reviewCountPortions(
    ingredient: unknown,
    fdcId: unknown,
    hint?: unknown
  ): { ok: boolean; review?: { candidates: ReadonlyArray<never> } };
  reviewPortions(fdc: unknown): {
    ok: boolean;
    review?: { candidates: ReadonlyArray<{ measure: string; modifier?: string }> };
  };
};

function reduceCandidates(
  candidates: ReadonlyArray<{
    amount: number;
    gram_weight: number;
    unit: string | null;
    size: string | null;
  }>
): Ai6b2CountCandidateView[] {
  return candidates.map((entry) => ({
    amount: entry.amount,
    gram_weight: entry.gram_weight,
    unit: entry.unit,
    size: entry.size,
  }));
}

/** True when a selected-record portion names the recipe's own food head noun. */
function recordPortionNamesFoodHead(
  session: CountSession,
  fdcId: number,
  foodHead: string | null
): boolean {
  if (foodHead === null || foodHead.length < 3) return false;
  const review = session.reviewPortions(fdcId);
  if (!review.ok || review.review === undefined) return false;
  const needle = foodHead.toLowerCase();
  const plural = needle.endsWith('s') ? needle.slice(0, -1) : `${needle}s`;
  return review.review.candidates.some((candidate) => {
    const text = `${candidate.measure} ${candidate.modifier ?? ''}`.toLowerCase();
    return text.includes(needle) || text.includes(plural);
  });
}

function gatherEvidence(
  session: CountSession,
  record: Ai6aDiagnosticRecord
): Ai6b2PortionEvidence {
  const fdcId = record.selected_fdc_id;
  const ingredient = structuredIngredient(record.line);

  const parsed = parseIngredient(ingredient);
  const p = parsed.ok ? parsed.parsed : null;
  const normalized = p !== null ? normalizeQuery(p.query).text : null;
  const projection =
    p !== null && normalized !== null
      ? projectQueryText(normalized, { count_noun: p.count_noun, container: p.container })
      : null;
  const sizePresent = (projection?.size_qualifiers.length ?? 0) > 0;

  // The count noun the line contains BEHIND other words (the `slices` in
  // `4 thin slices mortadella`, which the canonical parse does not keep as
  // `raw_unit`).
  let authoredCountNoun: string | null = null;
  if (normalized !== null) {
    const seen = new Set<string>();
    for (const token of normalized.split(/\s+/)) {
      const household = canonicalHouseholdUnit(token.toLowerCase().replace(/[.,;:]+$/, ''));
      if (household !== null && household.kind === 'count') seen.add(household.noun);
    }
    authoredCountNoun = [...seen].sort()[0] ?? null;
  }

  const compatible: Ai6b2CountCandidateView[] =
    fdcId === null
      ? []
      : (() => {
          const review = session.reviewCountPortions(ingredient, fdcId);
          return review.ok && review.review !== undefined
            ? reduceCandidates(review.review.candidates)
            : [];
        })();

  // Probe: would authenticated authority be reachable if the authored count noun
  // were supplied as a bounded hint? This is the parser-gap discriminator.
  const hinted: Ai6b2CountCandidateView[] =
    fdcId === null || authoredCountNoun === null || compatible.length > 0
      ? []
      : (() => {
          const review = session.reviewCountPortions(ingredient, fdcId, {
            unit: authoredCountNoun,
            size: null,
          });
          return review.ok && review.review !== undefined
            ? reduceCandidates(review.review.candidates)
            : [];
        })();

  return {
    container: record.container,
    package_net_mass_declared: record.package_net_mass !== null,
    explicit_count_unit: canonicalCountUnit(record.raw_unit),
    authored_count_noun: authoredCountNoun,
    size_qualifier_present: sizePresent,
    compatible_count_candidates: compatible,
    hinted_count_candidates: hinted,
    record_portion_names_food_head:
      fdcId === null || projection === null || projection.food_tokens.length === 0
        ? false
        : recordPortionNamesFoodHead(
            session,
            fdcId,
            projection.food_tokens[projection.food_tokens.length - 1]
          ),
    household_blocker: record.primary_blocker === 'household_portion_absent',
  };
}

/**
 * AI-3 eligibility cross-check through the REAL phase-4 flow
 * (adapt -> analyze -> reducer -> live projection) and the genuine eligibility
 * contract. AI-3 eligibility is observed, never assumed, and never modified.
 */
function ai3CrossCheck(
  session: AdvancedNutritionSession,
  record: Ai6aDiagnosticRecord
): { eligible: boolean; reason: string } {
  const text = record.line;
  const parsed = parseIngredient(text);
  const ingredient: Record<string, unknown> = { original: text };
  if (parsed.ok && parsed.parsed.amount !== null) ingredient.amount = parsed.parsed.amount;
  if (parsed.ok && parsed.parsed.raw_unit !== undefined) ingredient.unit = parsed.parsed.raw_unit;
  if (parsed.ok) ingredient.name = parsed.parsed.query;

  const adaptedResult = adaptRecipe({
    title: 'ai6b2',
    servings: 1,
    ingredients: [ingredient],
  } as never);
  if (!adaptedResult.ok) return { eligible: false, reason: 'adapt_failed' };
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, 1);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai6b2',
    rows: buildReviewRows(session, adapted as never),
    baseServings: 1,
  } as never);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);

  const lineRef = adapted[0].line_ref;
  const live = projectLiveRows(
    state,
    new Map<string, AnalyzedRow>(analysis.rows.map((row) => [row.line_ref, row])),
    adapted as never,
    session,
    undefined,
    analysis.portions,
    analysis.countPortions
  )[0];
  if (live === undefined) return { eligible: false, reason: 'no_live_row' };

  const result = evaluateAiEstimateEligibility({
    state,
    lineRef,
    parse: deriveAiEstimateParseFacts(text),
    rowStatus: live.status,
    capabilityAvailable: true,
  });
  if (result.eligible === true) return { eligible: true, reason: 'eligible' };
  const reason = (result as { reason?: string }).reason;
  return { eligible: false, reason: typeof reason === 'string' ? reason : 'not_eligible' };
}

/** Builds the full AI-6B2 disposition report from the real bundle and pipeline. */
export async function buildNutritionPortionDispositionReport(): Promise<Ai6b2DispositionReport> {
  const loaded = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  });
  if (!loaded.ok) throw new Error('the real USDA bundle failed to authenticate');

  const session = loaded.session;
  const records = diagnoseCorpus(session, AI6A_INTELLIGENCE_CORPUS);
  const aggregates = aggregate(records, (line) => {
    const entry = AI6A_INTELLIGENCE_CORPUS.find((candidate) => candidate.line === line);
    return entry?.identity;
  });

  const portionLane = records.filter((r) => r.repair_lane === 'deterministic_portion');

  const lines: Ai6b2ReportLine[] = portionLane.map((record) => {
    const evidence = gatherEvidence(session as never, record);
    const verdict = classifyPortionDisposition(evidence);
    const ai3 = ai3CrossCheck(session, record);
    const line: Ai6b2ReportLine = {
      line: record.line,
      primary_blocker: record.primary_blocker,
      repair_lane: record.repair_lane,
      selected_fdc_id: record.selected_fdc_id,
      selected_description: record.selected_description,
      measurement_kind: record.measurement_kind,
      mass_source: record.mass_source,
      resolved_grams: record.resolved_grams,
      disposition: verdict.disposition,
      evidence: verdict.evidence,
      repairable: verdict.repairable,
      handoff_lane: verdict.handoff_lane,
      compatible_candidate_masses: evidence.compatible_count_candidates.map((c) => c.gram_weight),
      ai3_eligible: ai3.eligible,
      ai3_reason: ai3.reason,
    };
    // TOTALITY GUARD: no line may be left unclassified.
    if (!isAi6b2PortionDisposition(line.disposition)) {
      throw new Error(`unclassified disposition for ${line.line}`);
    }
    if (!isAi6b2PortionEvidenceCode(line.evidence)) {
      throw new Error(`unclassified evidence code for ${line.line}`);
    }
    return line;
  });

  const disposition_counts = PORTION_DISPOSITIONS.map((key) => ({
    key,
    count: lines.filter((line) => line.disposition === key).length,
  })).filter((entry) => entry.count > 0);

  const evidence_counts = PORTION_EVIDENCE_CODES.map((key) => ({
    key,
    count: lines.filter((line) => line.evidence === key).length,
  })).filter((entry) => entry.count > 0);

  const handoffKeys = [...new Set(lines.map((line) => line.handoff_lane ?? 'none'))].sort();
  const handoff_lane_counts = handoffKeys.map((key) => ({
    key,
    count: lines.filter((line) => (line.handoff_lane ?? 'none') === key).length,
  }));

  const ai3Keys = [...new Set(lines.map((line) => line.ai3_reason))].sort();
  const ai3_eligibility_counts = ai3Keys.map((key) => ({
    key,
    count: lines.filter((line) => line.ai3_reason === key).length,
  }));

  const repairableCount = lines.filter((line) => line.repairable).length;

  const nextWork = deriveNextWork({
    observedBlockers: aggregates.primary_blockers.map((entry) => ({
      lane: laneForBlocker(entry.key),
      count: entry.count,
    })),
    // ONLY the portion lane is adjudicated by AI-6B2. Every other lane is honestly
    // reported as un-adjudicated (null), never as zero.
    adjudicatedActionableDefects: { deterministic_portion: repairableCount },
    criteriaScores: AI6A_LANE_CRITERION_SCORES as never,
    criteriaOrder: AI6A_ROADMAP_CRITERIA,
    neverTargetLanes: AI6A_NEVER_TARGET_LANES as ReadonlySet<string>,
  });

  return {
    schema: PORTION_DISPOSITION_SCHEMA,
    tool: 'benchmark_nutrition_portion_disposition',
    base_phase: BASE_PHASE,
    base_commit: BASE_COMMIT,
    production_baseline: {
      historical_resolved: aggregates.historical_97.authenticated_resolved,
      historical_total: aggregates.historical_97.total,
      legacy_resolved: aggregates.legacy_91.authenticated_resolved,
      legacy_total: aggregates.legacy_91.total,
      raw_matched: aggregates.counts.raw_matched,
      authenticated_mass_resolved: aggregates.counts.authenticated_mass_resolved,
      safe_resolved: aggregates.counts.safe_resolved,
      verified_correct_auto_identity: aggregates.counts.verified_correct_auto_identity,
      verified_unsafe_auto_identity: aggregates.counts.verified_unsafe_auto_identity,
      corpus_total: AI6A_INTELLIGENCE_CORPUS.length,
    },
    observed_portion_blockers: portionLane.length,
    repairable_deterministic_portion_defects: repairableCount,
    portion_lane_exhausted: repairableCount === 0,
    disposition_counts,
    evidence_counts,
    handoff_lane_counts,
    ai3_eligibility_counts,
    lane_repairability: nextWork.lanes,
    recommended_active_repair_lane: nextWork.recommended_active_repair_lane,
    recommended_active_repair_reason: nextWork.recommended_active_repair_reason,
    next_adjudication_target_lane: nextWork.next_adjudication_target_lane,
    next_adjudication_reason: nextWork.next_adjudication_reason,
    lines,
  };
}
