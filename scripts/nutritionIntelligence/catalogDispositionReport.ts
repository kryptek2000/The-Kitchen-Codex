/**
 * The Kitchen Codex — Advanced Nutrition AI-6B5: catalog disposition REPORT
 * BUILDER (planning only, ZERO production consumers).
 *
 * Proves, from the authenticated pinned USDA bundle ONLY, whether each
 * catalog-lane line is a true catalog absence, a candidate-surface failure, an
 * external-fact absence, or a branded-specificity refusal — then adjudicates
 * each into exactly one closed disposition and derives the next-lane handoff
 * from MEASURED repairability.
 *
 * Reusable so tests build the identical report in-process; the CLI wrapper
 * (`scripts/benchmark_nutrition_catalog_disposition.ts`) only prints/serializes.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field enters the returned object. Two calls are byte-identical.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import {
  CATALOG_DISPOSITIONS,
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_EVIDENCE_CODES,
  classifyCatalogDisposition,
  isAi6b5CatalogDisposition,
  isAi6b5CatalogEvidenceCode,
  type Ai6b5CatalogDisposition,
  type Ai6b5CatalogEvidence,
  type Ai6b5CatalogEvidenceCode,
} from './catalogDisposition';
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
import { deriveNextWork } from './portionDisposition';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';

const ROOT = resolve(import.meta.dirname, '../..');
const BUNDLE_DIR = join(
  ROOT,
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

/** The base production state this report is measured against. Pinned constant. */
export const BASE_PHASE = 'AI-6B4';
export const BASE_COMMIT = '5ee912999fa2cf7bd83efc56a0fcfa89c2df258f';

/**
 * AI-6B2/3/4's MEASURED actionable counts, pinned as recorded measurements.
 * Passing observed blocker counts here instead would resurrect exhausted lanes
 * purely from blocker frequency.
 */
export const PORTION_LANE_ACTIONABLE_DEFECTS = 0;
export const IDENTITY_LANE_ACTIONABLE_DEFECTS = 0;
export const RANKING_LANE_ACTIONABLE_DEFECTS = 0;

/** Observed blocker counts those phases recorded; asserted, never recomputed. */
export const PORTION_LANE_OBSERVED_BLOCKERS = 35;
export const IDENTITY_LANE_OBSERVED_BLOCKERS = 27;
export const RANKING_LANE_OBSERVED_BLOCKERS = 9;

/**
 * DECLARED, REVIEWABLE minimum token length for the orthographic-variant probe.
 * A closed compound of at least this many letters is unusual in food wording, so
 * its separated form is worth searching. This is a search-surface MEASUREMENT
 * aid only; nothing here is applied to production.
 */
export const AI6B5_VARIANT_PROBE_MIN_TOKEN_LENGTH = 8;

type SearchSession = {
  searchFoods(query: string, limit: number): {
    ok: boolean;
    total: number;
    results?: ReadonlyArray<{ fdc_id: number; description: string }>;
  };
  reviewPortions(fdc: unknown): {
    ok: boolean;
    review?: { candidates: ReadonlyArray<{ measure: string; modifier?: string; gram_weight?: number }> };
  };
};

interface CorpusExpectationView {
  readonly forbiddenAutoFdcs?: ReadonlyArray<number>;
  readonly forbiddenAutoDescription?: RegExp;
  readonly expectNoAutomatic?: boolean;
  readonly expectedAutoFdc?: number;
  readonly baselineAutoFdc?: number;
  readonly expectTopFdc?: number;
  readonly knownIssue?: string;
}

function compiles(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace('g', ''));
}

function isForbidden(
  expectation: CorpusExpectationView | undefined,
  fdcId: number,
  description: string
): boolean {
  if (expectation === undefined) return false;
  if (expectation.forbiddenAutoFdcs?.includes(fdcId) === true) return true;
  const pattern = expectation.forbiddenAutoDescription;
  return pattern === undefined ? false : compiles(pattern).test(description);
}

/**
 * Every internal split of a long closed compound, e.g. `breadcrumbs` yields
 * `bread|crumbs` among others. Fully general and food-independent: it enumerates
 * positions rather than encoding any known word pair.
 */
export function compoundSplitProbes(token: string): string[] {
  if (token.length < AI6B5_VARIANT_PROBE_MIN_TOKEN_LENGTH) return [];
  const out: string[] = [];
  for (let index = 3; index <= token.length - 3; index += 1) {
    out.push(`${token.slice(0, index)} ${token.slice(index)}`);
  }
  return out;
}

/** Total records the bounded surface returns for a query, else null. */
function searchTotal(session: SearchSession, query: string): number | null {
  if (query.trim().length === 0) return null;
  const search = session.searchFoods(query, 1);
  return search.ok ? search.total : null;
}

export interface Ai6b5ReportLine {
  readonly line: string;
  readonly source: string;
  readonly focus: string;
  readonly families: ReadonlyArray<string>;
  readonly parsed_food_query: string | null;
  readonly head_tokens: ReadonlyArray<string>;
  readonly amount: number | null;
  readonly raw_unit: string | null;
  readonly measurement_kind: string | null;
  readonly container: string | null;
  readonly count_noun_class: string;
  readonly package_net_mass: unknown;
  readonly primary_blocker: string;
  readonly terminal: string;
  readonly selected_fdc_id: number | null;
  readonly selected_description: string | null;
  readonly candidate_count: number;
  readonly candidates: ReadonlyArray<{ rank: number; fdc_id: number; description: string }>;
  // --- catalog-existence evidence -----------------------------------------
  readonly catalog_probe_phrase: string;
  readonly exact_search_total: number | null;
  readonly variant_split_count: number;
  readonly variant_found_total: number | null;
  readonly variant_found_fdc_ids: ReadonlyArray<number>;
  readonly variant_found_descriptions: ReadonlyArray<string>;
  readonly variant_surface_unambiguous: boolean;
  readonly broader_generic_family_exists: boolean;
  readonly portion_authority_available_for_variant: boolean;
  // --- specificity / package evidence -------------------------------------
  readonly brand_specificity: boolean;
  readonly package_net_mass_declared: boolean;
  // --- corpus constraints --------------------------------------------------
  readonly expected_auto_fdc: number | null;
  readonly baseline_auto_fdc: number | null;
  readonly expect_top_fdc: number | null;
  readonly expect_no_automatic: boolean;
  readonly forbidden_auto_fdcs: ReadonlyArray<number>;
  readonly forbidden_auto_description: string | null;
  readonly known_issue: string | null;
  // --- current outcome ------------------------------------------------------
  readonly mass_source: string;
  readonly resolved_grams: number | null;
  readonly identity_correctness: string;
  // --- verdict --------------------------------------------------------------
  readonly disposition: Ai6b5CatalogDisposition;
  readonly evidence: Ai6b5CatalogEvidenceCode;
  readonly repairable: boolean;
  readonly handoff_lane: string | null;
  readonly owned_by_other_lane: boolean;
  readonly ai3_eligible: boolean;
  readonly ai3_reason: string;
}

export interface Ai6b5CatalogDispositionReport {
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
  readonly observed_catalog_blockers: number;
  readonly blocker_split: ReadonlyArray<{ key: string; count: number }>;
  readonly repairable_deterministic_catalog_surface_defects: number;
  readonly catalog_lane_exhausted: boolean;
  /** Lanes are reported side by side and never merged. */
  readonly deterministic_portion_blockers: number;
  readonly deterministic_identity_blockers: number;
  readonly deterministic_ranking_blockers: number;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly catalog_lane_constraint_counts: {
    readonly expected_auto_fdc: number;
    readonly baseline_auto_fdc: number;
    readonly expect_top_fdc: number;
    readonly expect_no_automatic: number;
    readonly forbidden_auto_fdcs: number;
    readonly forbidden_auto_description: number;
    readonly known_issue: number;
    readonly brand_specificity: number;
  };
  /** Hypothetical surface rule, MEASURED across all 207 lines, never applied. */
  readonly hypothetical_surface_simulation: {
    readonly rule_id: string;
    readonly assertion: string;
    readonly lines_probed: number;
    readonly lines_whose_direct_surface_is_empty: number;
    readonly lines_whose_variant_surface_finds_records: number;
    readonly lines_whose_variant_surface_is_brand_genericizing: number;
    readonly expected_fdc_divergences: number;
    readonly expect_no_automatic_violations: number;
    readonly forbidden_fdc_violations: number;
    readonly forbidden_description_violations: number;
    /** AI-6B5 does not apply the rule, so identity/mass effects are not computed. */
    readonly identity_or_mass_changes_computed: boolean;
    readonly not_computed_reason: string;
  };
  readonly lane_repairability: ReadonlyArray<{
    readonly lane: string;
    readonly observed_blockers: number;
    readonly actionable_defects: number | null;
    readonly adjudicated: boolean;
    readonly exhausted: boolean;
  }>;
  readonly recommended_active_repair_lane: string | null;
  readonly recommended_active_repair_reason: string;
  readonly next_adjudication_target_lane: string | null;
  readonly next_adjudication_reason: string;
  readonly lines: ReadonlyArray<Ai6b5ReportLine>;
}

function headTokensOf(record: Ai6aDiagnosticRecord): {
  head: string[];
  normalized: string | null;
} {
  const parsed = parseIngredient(structuredIngredient(record.line));
  const p = parsed.ok ? parsed.parsed : null;
  const normalized = p !== null ? normalizeQuery(p.query).text : null;
  const projection =
    p !== null && normalized !== null
      ? projectQueryText(normalized, { count_noun: p.count_noun, container: p.container })
      : null;
  return {
    head: (projection?.food_tokens ?? []).filter((token) => token.length > 1),
    normalized,
  };
}

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

  const adaptedResult = adaptRecipe({ title: 'ai6b5', servings: 1, ingredients: [ingredient] } as never);
  if (!adaptedResult.ok) return { eligible: false, reason: 'adapt_failed' };
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, 1);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai6b5',
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

/** True when the record exposes a portion matching the line's authored measurement. */
function recordHasCompatiblePortion(
  session: SearchSession,
  fdcId: number,
  measurementKind: string | null
): boolean {
  const review = session.reviewPortions(fdcId);
  if (!review.ok || review.review === undefined) return false;
  if (measurementKind === 'mass') return true;
  if (measurementKind === 'volume') {
    return review.review.candidates.some(
      (candidate) => `${candidate.measure} ${candidate.modifier ?? ''}`.toLowerCase().includes('cup')
    );
  }
  return review.review.candidates.length > 0;
}

/** Builds the full AI-6B5 catalog disposition report from the real bundle. */
export async function buildNutritionCatalogDispositionReport(): Promise<Ai6b5CatalogDispositionReport> {
  const loaded = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  });
  if (!loaded.ok) throw new Error('the real USDA bundle failed to authenticate');

  const session = loaded.session;
  const search = session as unknown as SearchSession;
  const records = diagnoseCorpus(session, AI6A_INTELLIGENCE_CORPUS);
  const aggregates = aggregate(records, (line) => {
    const entry = AI6A_INTELLIGENCE_CORPUS.find((candidate) => candidate.line === line);
    return entry?.identity;
  });

  const expectationOf = (line: string): CorpusExpectationView | undefined =>
    AI6A_INTELLIGENCE_CORPUS.find((entry) => entry.line === line)?.identity as
      | CorpusExpectationView
      | undefined;

  const catalogLane = records.filter((record) => record.repair_lane === 'catalog_gap');

  /** Probe ladder shared by the census and the hypothetical-rule simulation. */
  interface Probe {
    readonly phrase: string;
    readonly exactTotal: number | null;
    readonly variantTotal: number | null;
    readonly variantIds: number[];
    readonly variantDescriptions: string[];
    readonly variantSplitCount: number;
  }
  const probe = (head: ReadonlyArray<string>): Probe => {
    const phrase = head.join(' ');
    const exactTotal = searchTotal(search, phrase);
    const variantIds: number[] = [];
    const variantDescriptions: string[] = [];
    let variantSplitCount = 0;
    for (const token of head) {
      for (const variant of compoundSplitProbes(token)) {
        variantSplitCount += 1;
        const found = search.searchFoods(variant, 3);
        if (!found.ok) continue;
        for (const hit of found.results ?? []) {
          if (!variantIds.includes(hit.fdc_id)) {
            variantIds.push(hit.fdc_id);
            variantDescriptions.push(hit.description);
          }
        }
      }
    }
    return {
      phrase,
      exactTotal,
      variantTotal: variantIds.length === 0 ? (variantSplitCount === 0 ? null : 0) : variantIds.length,
      variantIds,
      variantDescriptions,
      variantSplitCount,
    };
  };

  const lines: Ai6b5ReportLine[] = catalogLane.map((record) => {
    const expectation = expectationOf(record.line);
    const { head, normalized } = headTokensOf(record);
    const measured = probe(head);

    const brandSpecificity = record.secondary_signals.includes(
      'has_brand_or_commercial_specificity'
    );
    const packageDeclared = record.package_net_mass !== null;

    // A broader generic family exists when the DIRECT surface finds nothing but
    // relaxing the authored head (dropping its last token) does find something.
    const relaxed =
      head.length >= 2 ? searchTotal(search, head.slice(0, -1).join(' ')) : null;
    const broaderGeneric =
      (measured.exactTotal ?? 0) === 0 &&
      (measured.variantTotal ?? 0) === 0 &&
      relaxed !== null &&
      relaxed > 0;

    const portionAvailable =
      measured.variantIds.length > 0 &&
      measured.variantIds.some((id) =>
        recordHasCompatiblePortion(search, id, record.measurement_kind)
      );

    const surfacedForbidden = measured.variantIds.some((id) =>
      isForbidden(expectation, id, measured.variantDescriptions[measured.variantIds.indexOf(id)] ?? '')
    );

    const evidence: Ai6b5CatalogEvidence = {
      container_authored: record.container !== null,
      package_net_mass_declared: packageDeclared,
      brand_specificity: brandSpecificity,
      exact_identity_found: (measured.exactTotal ?? 0) > 0,
      exact_identity_found_via_variant: (measured.exactTotal ?? 0) === 0 && measured.variantIds.length > 0,
      // Measured, not assumed: the variant surface must isolate ONE record for a
      // generic repair to be possible. `breadcrumbs` splits to `bread crumbs`,
      // which returns plain crumbs, SEASONED crumbs AND a cake — so the surface
      // cannot isolate the authored food without a food-specific rule.
      variant_surface_unambiguous: measured.variantIds.length === 1,
      broader_generic_family_exists: broaderGeneric,
      portion_authority_available: portionAvailable,
      expect_no_automatic: expectation?.expectNoAutomatic === true,
      surfaced_candidate_forbidden: surfacedForbidden,
      // Dropping a brand token is never a route to repairability, so this stays
      // false by construction for any branded line.
      would_require_dropping_brand_token: false,
    };

    const verdict = classifyCatalogDisposition(evidence);
    const ai3 = ai3CrossCheck(session, record);

    const line: Ai6b5ReportLine = {
      line: record.line,
      source: record.source,
      focus: record.focus,
      families: record.families,
      parsed_food_query: normalized,
      head_tokens: head,
      amount: record.amount,
      raw_unit: record.raw_unit,
      measurement_kind: record.measurement_kind,
      container: record.container,
      count_noun_class: record.count_noun_class,
      package_net_mass: record.package_net_mass,
      primary_blocker: record.primary_blocker,
      terminal: record.terminal,
      selected_fdc_id: record.selected_fdc_id,
      selected_description: record.selected_description,
      candidate_count: record.candidate_count,
      candidates: record.candidates.map((candidate) => ({
        rank: candidate.rank,
        fdc_id: candidate.fdc_id,
        description: candidate.description,
      })),
      catalog_probe_phrase: measured.phrase,
      exact_search_total: measured.exactTotal,
      variant_split_count: measured.variantSplitCount,
      variant_found_total: measured.variantTotal,
      variant_found_fdc_ids: measured.variantIds,
      variant_found_descriptions: measured.variantDescriptions,
      variant_surface_unambiguous: measured.variantIds.length === 1,
      broader_generic_family_exists: broaderGeneric,
      portion_authority_available_for_variant: portionAvailable,
      brand_specificity: brandSpecificity,
      package_net_mass_declared: packageDeclared,
      expected_auto_fdc: expectation?.expectedAutoFdc ?? null,
      baseline_auto_fdc: expectation?.baselineAutoFdc ?? null,
      expect_top_fdc: expectation?.expectTopFdc ?? null,
      expect_no_automatic: expectation?.expectNoAutomatic === true,
      forbidden_auto_fdcs: expectation?.forbiddenAutoFdcs ?? [],
      forbidden_auto_description: expectation?.forbiddenAutoDescription?.source ?? null,
      known_issue: expectation?.knownIssue ?? null,
      mass_source: record.mass_source,
      resolved_grams: record.resolved_grams,
      identity_correctness: record.identity_correctness,
      disposition: verdict.disposition,
      evidence: verdict.evidence,
      repairable: verdict.repairable,
      handoff_lane: verdict.handoff_lane,
      owned_by_other_lane: verdict.owned_by_other_lane,
      ai3_eligible: ai3.eligible,
      ai3_reason: ai3.reason,
    };

    if (!isAi6b5CatalogDisposition(line.disposition)) {
      throw new Error(`unclassified disposition for ${line.line}`);
    }
    if (!isAi6b5CatalogEvidenceCode(line.evidence)) {
      throw new Error(`unclassified evidence code for ${line.line}`);
    }
    return line;
  });

  const countBy = <T>(keys: ReadonlyArray<T>, pick: (line: Ai6b5ReportLine) => T) =>
    keys
      .map((key) => ({ key: String(key), count: lines.filter((line) => pick(line) === key).length }))
      .filter((entry) => entry.count > 0);

  const handoffKeys = [...new Set(lines.map((line) => line.handoff_lane ?? 'none'))].sort();
  const ai3Keys = [...new Set(lines.map((line) => line.ai3_reason))].sort();
  const repairableCount = lines.filter((line) => line.repairable).length;

  // ---- hypothetical surface-rule simulation across ALL 207 lines -------------
  let probed = 0;
  let emptyDirect = 0;
  let variantFinds = 0;
  let brandGenericizing = 0;
  let expectedDivergences = 0;
  let expectNoAutomaticViolations = 0;
  let forbiddenFdcViolations = 0;
  let forbiddenDescriptionViolations = 0;
  for (const record of records) {
    const expectation = expectationOf(record.line);
    const { head } = headTokensOf(record);
    if (head.length === 0) continue;
    probed += 1;
    const measured = probe(head);
    if ((measured.exactTotal ?? 0) > 0) continue;
    emptyDirect += 1;
    if (measured.variantIds.length === 0) continue;
    variantFinds += 1;
    const branded = record.secondary_signals.includes('has_brand_or_commercial_specificity');
    for (let index = 0; index < measured.variantIds.length; index += 1) {
      const id = measured.variantIds[index];
      const description = measured.variantDescriptions[index];
      // A variant-probed record reached only by discarding a brand token would be
      // a brand genericization. Counted, never permitted.
      if (branded) {
        brandGenericizing += 1;
        continue;
      }
      if (expectation?.expectNoAutomatic === true) expectNoAutomaticViolations += 1;
      if (expectation?.forbiddenAutoFdcs?.includes(id) === true) forbiddenFdcViolations += 1;
      if (
        expectation?.forbiddenAutoDescription !== undefined &&
        compiles(expectation.forbiddenAutoDescription).test(description)
      ) {
        forbiddenDescriptionViolations += 1;
      }
      if (expectation?.expectedAutoFdc !== undefined && expectation.expectedAutoFdc !== id) {
        expectedDivergences += 1;
      }
    }
  }

  const nextWork = deriveNextWork({
    observedBlockers: aggregates.primary_blockers.map((entry) => ({
      lane: laneForBlocker(entry.key),
      count: entry.count,
    })),
    adjudicatedActionableDefects: {
      deterministic_portion: PORTION_LANE_ACTIONABLE_DEFECTS,
      deterministic_identity: IDENTITY_LANE_ACTIONABLE_DEFECTS,
      deterministic_ranking: RANKING_LANE_ACTIONABLE_DEFECTS,
      catalog_gap: repairableCount,
    },
    criteriaScores: AI6A_LANE_CRITERION_SCORES as never,
    criteriaOrder: AI6A_ROADMAP_CRITERIA,
    neverTargetLanes: AI6A_NEVER_TARGET_LANES as ReadonlySet<string>,
  });

  for (const [laneName, observed] of [
    ['deterministic_portion', PORTION_LANE_OBSERVED_BLOCKERS],
    ['deterministic_identity', IDENTITY_LANE_OBSERVED_BLOCKERS],
    ['deterministic_ranking', RANKING_LANE_OBSERVED_BLOCKERS],
  ] as const) {
    const row = nextWork.lanes.find((lane) => lane.lane === laneName);
    if (row !== undefined && row.observed_blockers !== observed) {
      throw new Error(`the ${laneName} observation moved; its recorded measurement must be reviewed`);
    }
  }

  // A zero-blocker lane is not adjudication work. When every remaining eligible
  // un-adjudicated lane has ZERO observed blockers, there is genuinely nothing
  // left to adjudicate, and the roadmap says so instead of nominating an empty
  // lane.
  const derivedTarget = nextWork.next_adjudication_target_lane;
  const derivedTargetRow =
    derivedTarget === null ? undefined : nextWork.lanes.find((lane) => lane.lane === derivedTarget);
  const hasRemainingWork =
    derivedTargetRow !== undefined && derivedTargetRow.observed_blockers > 0;
  const nextAdjudicationTarget = hasRemainingWork ? derivedTarget : null;
  const nextAdjudicationReason = hasRemainingWork
    ? nextWork.next_adjudication_reason
    : 'every remaining eligible un-adjudicated lane has zero observed blockers';

  return {
    schema: CATALOG_DISPOSITION_SCHEMA,
    tool: 'benchmark_nutrition_catalog_disposition',
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
    observed_catalog_blockers: catalogLane.length,
    blocker_split: [...new Set(catalogLane.map((record) => record.primary_blocker))]
      .sort()
      .map((key) => ({
        key,
        count: catalogLane.filter((record) => record.primary_blocker === key).length,
      })),
    repairable_deterministic_catalog_surface_defects: repairableCount,
    catalog_lane_exhausted: repairableCount === 0,
    deterministic_portion_blockers: records.filter(
      (record) => record.repair_lane === 'deterministic_portion'
    ).length,
    deterministic_identity_blockers: records.filter(
      (record) => record.repair_lane === 'deterministic_identity'
    ).length,
    deterministic_ranking_blockers: records.filter(
      (record) => record.repair_lane === 'deterministic_ranking'
    ).length,
    disposition_counts: countBy(CATALOG_DISPOSITIONS, (line) => line.disposition),
    evidence_counts: countBy(CATALOG_EVIDENCE_CODES, (line) => line.evidence),
    handoff_lane_counts: handoffKeys.map((key) => ({
      key,
      count: lines.filter((line) => (line.handoff_lane ?? 'none') === key).length,
    })),
    ai3_eligibility_counts: ai3Keys.map((key) => ({
      key,
      count: lines.filter((line) => line.ai3_reason === key).length,
    })),
    catalog_lane_constraint_counts: {
      expected_auto_fdc: lines.filter((line) => line.expected_auto_fdc !== null).length,
      baseline_auto_fdc: lines.filter((line) => line.baseline_auto_fdc !== null).length,
      expect_top_fdc: lines.filter((line) => line.expect_top_fdc !== null).length,
      expect_no_automatic: lines.filter((line) => line.expect_no_automatic).length,
      forbidden_auto_fdcs: lines.filter((line) => line.forbidden_auto_fdcs.length > 0).length,
      forbidden_auto_description: lines.filter(
        (line) => line.forbidden_auto_description !== null
      ).length,
      known_issue: lines.filter((line) => line.known_issue !== null).length,
      brand_specificity: lines.filter((line) => line.brand_specificity).length,
    },
    hypothetical_surface_simulation: {
      rule_id: 'expose_exact_records_present_under_separated_compound_forms',
      assertion:
        'When the direct bounded surface returns nothing, also search the separated forms of long closed compounds and surface any record the bundle already contains.',
      lines_probed: probed,
      lines_whose_direct_surface_is_empty: emptyDirect,
      lines_whose_variant_surface_finds_records: variantFinds,
      lines_whose_variant_surface_is_brand_genericizing: brandGenericizing,
      expected_fdc_divergences: expectedDivergences,
      expect_no_automatic_violations: expectNoAutomaticViolations,
      forbidden_fdc_violations: forbiddenFdcViolations,
      forbidden_description_violations: forbiddenDescriptionViolations,
      identity_or_mass_changes_computed: false,
      not_computed_reason:
        'AI-6B5 never applies the rule, so no automatic identity, mass, or gram value changes are computed; only candidate-surface reach and constraint safety are measured.',
    },
    lane_repairability: nextWork.lanes,
    recommended_active_repair_lane: nextWork.recommended_active_repair_lane,
    recommended_active_repair_reason: nextWork.recommended_active_repair_reason,
    next_adjudication_target_lane: nextAdjudicationTarget,
    next_adjudication_reason: nextAdjudicationReason,
    lines,
  };
}