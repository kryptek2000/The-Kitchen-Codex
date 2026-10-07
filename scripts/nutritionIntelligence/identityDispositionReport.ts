/**
 * The Kitchen Codex — Advanced Nutrition AI-6B3: identity disposition REPORT
 * BUILDER (planning only, ZERO production consumers).
 *
 * Gathers real evidence for every unresolved `deterministic_identity` line through
 * the existing PUBLIC session contracts, adjudicates each line into exactly one
 * closed disposition, SIMULATES the hypothetical rules that could ever justify a
 * repair, and derives the next-lane handoff from MEASURED repairability.
 *
 * Reusable so tests build the identical report in-process; the CLI wrapper
 * (`scripts/benchmark_nutrition_identity_disposition.ts`) only prints/serializes.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field enters the returned object. Two calls are byte-identical.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import {
  IDENTITY_DISPOSITIONS,
  IDENTITY_DISPOSITION_SCHEMA,
  IDENTITY_EVIDENCE_CODES,
  HYPOTHETICAL_SAFE_RULES,
  classifyIdentityDisposition,
  isAi6b3IdentityDisposition,
  isAi6b3IdentityEvidenceCode,
  type Ai6b3HypotheticalSafeRule,
  type Ai6b3IdentityDisposition,
  type Ai6b3IdentityEvidence,
  type Ai6b3IdentityEvidenceCode,
  type Ai6b3RuleSimulation,
} from './identityDisposition';
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

/**
 * The base production state this disposition report is measured against. Pinned
 * as a CONSTANT so later HEAD movement cannot perturb the planning artifact.
 */
export const BASE_PHASE = 'AI-6B2';
export const BASE_COMMIT = '9761ae5fef84058ef76ba1ad6232c1b3f644cc5a';

/**
 * AI-6B2's MEASURED actionable count for the portion lane, pinned as a recorded
 * measurement. Zero there is what marks the lane exhausted. Re-deriving it here
 * would be scoreboard gaming in the other direction, so it is pinned and the
 * observed portion count is asserted separately.
 */
export const PORTION_LANE_ACTIONABLE_DEFECTS = 0;

/** The portion-lane observation AI-6B2 recorded; asserted, never recomputed. */
export const PORTION_LANE_OBSERVED_BLOCKERS = 35;

/**
 * DECLARED, REVIEWABLE planning-side list of tokens that are NOT food identity
 * nouns: preparation verbs, state modifiers, and size adjectives. This mirrors
 * the qualifier vocabulary the AI-6A catalog probe already treats as droppable.
 *
 * It is declared here rather than imported so that AI-6B3 adds no dependency on,
 * and changes no byte of, the AI-6A/AI-6B1 tooling — their serialized artifacts
 * must stay byte-identical.
 */
export const AI6B3_NON_FOOD_HEAD_TOKENS: ReadonlySet<string> = new Set([
  'fresh',
  'freshly',
  'raw',
  'cooked',
  'dried',
  'ground',
  'chopped',
  'minced',
  'sliced',
  'diced',
  'crushed',
  'grated',
  'shredded',
  'large',
  'small',
  'medium',
  'whole',
  'unsalted',
  'salted',
  'lean',
  'optional',
  'finely',
  'thinly',
]);

/** DECLARED container nouns, which are never food identity nouns. */
export const AI6B3_CONTAINER_NOUN_TOKENS: ReadonlySet<string> = new Set([
  'can',
  'cans',
  'jar',
  'jars',
  'bottle',
  'bottles',
  'packet',
  'packets',
  'package',
  'packages',
  'box',
  'boxes',
  'bag',
  'bags',
  'pouch',
  'tin',
  'tins',
  'carton',
  'cartons',
  'tub',
  'tubs',
]);

/**
 * The food-inside-preparation safety class named by the AI-6A identity safety
 * history (`sardines in tomato sauce`). A rule that newly binds one of these is
 * never repairable, whatever else it achieves.
 */
export const AI6B3_FOOD_INSIDE_PREPARATION = / in /;

// ---------------------------------------------------------------------------
// Token helpers (pure, no production module is altered)
// ---------------------------------------------------------------------------

/** Lowercased alphanumeric tokens of length > 1, de-duplicated, order preserved. */
function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 1)
    ),
  ];
}

/** The hypothetical, SIMULATED-ONLY morphology rule. */
function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && /(ch|sh|s|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function satisfyingIds(
  headTokens: ReadonlyArray<string>,
  descriptions: ReadonlyArray<{ fdc_id: number; description: string }>
): number[] {
  if (headTokens.length === 0) return [];
  const out: number[] = [];
  for (const candidate of descriptions) {
    const tokens = new Set(tokenize(candidate.description));
    if (headTokens.every((token) => tokens.has(token))) out.push(candidate.fdc_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-line projection
// ---------------------------------------------------------------------------

export interface Ai6b3ReportLine {
  // --- census (§4): what the line is -------------------------------------
  readonly line: string;
  readonly source: string;
  readonly focus: string;
  readonly families: ReadonlyArray<string>;
  readonly parsed_food_query: string | null;
  readonly head_tokens: ReadonlyArray<string>;
  readonly quantity_kind: string | null;
  readonly measurement_kind: string | null;
  readonly raw_unit: string | null;
  readonly amount: number | null;
  readonly container: string | null;
  // --- census: live terminal ---------------------------------------------
  readonly primary_blocker: string;
  readonly terminal: string;
  readonly review_outcome: string | null;
  readonly selected_fdc_id: number | null;
  readonly selected_description: string | null;
  readonly mass_source: string;
  readonly resolved_grams: number | null;
  // --- census: candidate evidence ----------------------------------------
  readonly candidate_count: number;
  readonly candidates: ReadonlyArray<{
    readonly rank: number;
    readonly fdc_id: number;
    readonly description: string;
    readonly data_type: string;
    readonly has_compatible_portion: boolean;
  }>;
  readonly satisfying_candidate_ids: ReadonlyArray<number>;
  readonly all_satisfying_candidates_forbidden: boolean;
  readonly head_probe_total: number | null;
  readonly head_probe_drop_leading_total: number | null;
  readonly catalog_probe_total: number;
  readonly expected_candidate_rank: string;
  readonly auto_outcome: string;
  readonly identity_correctness: string;
  readonly secondary_signals: ReadonlyArray<string>;
  // --- census: checked-in identity knowledge ------------------------------
  readonly expected_auto_fdc: number | null;
  readonly baseline_auto_fdc: number | null;
  readonly expect_no_automatic: boolean;
  readonly forbidden_auto_fdcs: ReadonlyArray<number>;
  readonly forbidden_auto_description: string | null;
  readonly expect_top_fdc: number | null;
  readonly expect_candidate_description: string | null;
  readonly known_issue: string | null;
  // --- verdict -------------------------------------------------------------
  readonly disposition: Ai6b3IdentityDisposition;
  readonly evidence: Ai6b3IdentityEvidenceCode;
  readonly repairable: boolean;
  readonly hypothetical_safe_rule: Ai6b3HypotheticalSafeRule | null;
  readonly handoff_lane: string | null;
  // --- AI-3 cross-check (observed, never changed) -------------------------
  readonly ai3_eligible: boolean;
  readonly ai3_reason: string;
}

export interface Ai6b3IdentityDispositionReport {
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
  readonly observed_identity_blockers: number;
  readonly blocker_split: ReadonlyArray<{ key: string; count: number }>;
  /** The MEASURED number of genuine deterministic implementation defects. */
  readonly repairable_deterministic_identity_defects: number;
  readonly identity_lane_exhausted: boolean;
  /** Identity is NOT ranking: the ranking lane is reported, never absorbed. */
  readonly deterministic_ranking_blockers: number;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly identity_lane_constraint_counts: {
    readonly expect_no_automatic: number;
    readonly forbidden_auto_fdcs: number;
    readonly forbidden_auto_description: number;
  };
  readonly hypothetical_rule_simulations: ReadonlyArray<Ai6b3RuleSimulation>;
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
  readonly lines: ReadonlyArray<Ai6b3ReportLine>;
}

interface CorpusExpectationView {
  readonly expectedAutoFdc?: number;
  readonly baselineAutoFdc?: number;
  readonly knownIssue?: string;
  readonly forbiddenAutoFdcs?: ReadonlyArray<number>;
  readonly forbiddenAutoDescription?: RegExp;
  readonly expectNoAutomatic?: boolean;
  readonly expectCandidateDescription?: RegExp;
  readonly expectTopFdc?: number;
}

/** True when the corpus forbids ANY automatic identity on this line. */
function isForbiddenByCorpus(
  expectation: CorpusExpectationView | undefined,
  fdcId: number,
  description: string
): boolean {
  if (expectation === undefined) return false;
  if (expectation.forbiddenAutoFdcs?.includes(fdcId) === true) return true;
  const pattern = expectation.forbiddenAutoDescription;
  if (pattern === undefined) return false;
  return new RegExp(pattern.source, pattern.flags.replace('g', '')).test(description);
}

function probeTotal(
  session: AdvancedNutritionSession,
  query: string
): number | null {
  if (query.trim().length === 0) return null;
  const search = session.searchFoods(query, 1);
  return search.ok ? search.total : null;
}

function gatherEvidence(
  session: AdvancedNutritionSession,
  record: Ai6aDiagnosticRecord,
  expectation: CorpusExpectationView | undefined
): {
  evidence: Ai6b3IdentityEvidence;
  headTokens: ReadonlyArray<string>;
  normalized: string | null;
  satisfying: ReadonlyArray<number>;
  allForbidden: boolean;
} {
  const ingredient = structuredIngredient(record.line);
  const parsed = parseIngredient(ingredient);
  const p = parsed.ok ? parsed.parsed : null;
  const normalized = p !== null ? normalizeQuery(p.query).text : null;
  const projection =
    p !== null && normalized !== null
      ? projectQueryText(normalized, { count_noun: p.count_noun, container: p.container })
      : null;
  const headTokens = tokenize((projection?.food_tokens ?? []).join(' '));

  const descriptions = record.candidates.map((candidate) => ({
    fdc_id: candidate.fdc_id,
    description: candidate.description,
  }));
  const satisfying = satisfyingIds(headTokens, descriptions);
  const allForbidden =
    satisfying.length > 0 &&
    satisfying.every((fdcId) => {
      const match = descriptions.find((entry) => entry.fdc_id === fdcId);
      return isForbiddenByCorpus(expectation, fdcId, match?.description ?? '');
    });

  const quantityAbsorbed = normalized !== null && /^\s*\d+(\.\d+)?\b/.test(normalized);
  const containerNounInHead = headTokens.some((token) =>
    AI6B3_CONTAINER_NOUN_TOKENS.has(token)
  );
  const declaredQualifierInHead = headTokens.some((token) =>
    AI6B3_NON_FOOD_HEAD_TOKENS.has(token)
  );

  return {
    normalized,
    headTokens,
    satisfying,
    allForbidden,
    evidence: {
      brand_specificity: record.secondary_signals.includes('has_brand_or_commercial_specificity'),
      quantity_absorbed_into_query: quantityAbsorbed,
      container_noun_in_head: containerNounInHead,
      declared_qualifier_in_head: declaredQualifierInHead,
      food_head_absent: headTokens.length === 0,
      satisfying_candidate_ids: satisfying,
      all_satisfying_forbidden: allForbidden,
      head_probe_total: probeTotal(session, headTokens.join(' ')),
      head_probe_drop_leading_total:
        headTokens.length >= 2 ? probeTotal(session, headTokens.slice(1).join(' ')) : null,
      expect_no_automatic: expectation?.expectNoAutomatic === true,
    },
  };
}

/**
 * AI-3 eligibility cross-check through the REAL phase-4 flow and the genuine
 * eligibility contract. Observed, never assumed, and never modified.
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
    title: 'ai6b3',
    servings: 1,
    ingredients: [ingredient],
  } as never);
  if (!adaptedResult.ok) return { eligible: false, reason: 'adapt_failed' };
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, 1);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai6b3',
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

// ---------------------------------------------------------------------------
// Hypothetical-rule simulation harness
// ---------------------------------------------------------------------------

const RULE_ASSERTIONS: Readonly<Record<Ai6b3HypotheticalSafeRule, string>> = {
  unique_satisfying_candidate_auto_bind:
    'Bind an identity when exactly one candidate in the bounded window satisfies every authored food-head token.',
  singularize_plural_head_token:
    'Match a plural authored food-head token against a singular catalog noun.',
};

interface RuleOutcome {
  readonly newBindings: number;
  readonly changedBindings: number;
  readonly oracleDivergences: number;
  readonly expectNoAutomaticViolations: number;
  readonly forbiddenFdcViolations: number;
  readonly forbiddenDescriptionViolations: number;
  readonly safetyHistoryBindings: number;
  readonly identityLaneNewBindings: number;
}

/**
 * Runs one hypothetical rule across ALL 207 recon lines and every checked-in
 * safety constraint. It never mutates a record: it only computes what the rule
 * WOULD bind and whether that would break anything.
 */
function simulateRule(
  rule: Ai6b3HypotheticalSafeRule,
  projections: ReadonlyArray<{
    record: Ai6aDiagnosticRecord;
    headTokens: ReadonlyArray<string>;
    expectation: CorpusExpectationView | undefined;
  }>
): RuleOutcome {
  let newBindings = 0;
  let changedBindings = 0;
  let oracleDivergences = 0;
  let expectNoAutomaticViolations = 0;
  let forbiddenFdcViolations = 0;
  let forbiddenDescriptionViolations = 0;
  let safetyHistoryBindings = 0;
  let identityLaneNewBindings = 0;

  for (const projection of projections) {
    const { record, headTokens, expectation } = projection;
    if (headTokens.length === 0) continue;
    const evaluated =
      rule === 'singularize_plural_head_token'
        ? headTokens.map(singularize)
        : headTokens;
    const ids = satisfyingIds(
      evaluated,
      record.candidates.map((candidate) => ({ fdc_id: candidate.fdc_id, description: candidate.description }))
    );
    if (ids.length !== 1) continue;
    const bound = ids[0];
    const description = record.candidates.find((c) => c.fdc_id === bound)?.description ?? '';
    const isNew = record.selected_fdc_id !== bound;
    if (isNew) {
      newBindings += 1;
      if (record.repair_lane === 'deterministic_identity') identityLaneNewBindings += 1;
      if (AI6B3_FOOD_INSIDE_PREPARATION.test(record.line)) safetyHistoryBindings += 1;
      if (expectation?.expectNoAutomatic === true) expectNoAutomaticViolations += 1;
      if (expectation?.forbiddenAutoFdcs?.includes(bound) === true) forbiddenFdcViolations += 1;
      if (
        expectation?.forbiddenAutoDescription !== undefined &&
        new RegExp(
          expectation.forbiddenAutoDescription.source,
          expectation.forbiddenAutoDescription.flags.replace('g', '')
        ).test(description)
      ) {
        forbiddenDescriptionViolations += 1;
      }
    } else if (record.selected_fdc_id !== null) {
      // Production already binds something else; the rule would rewrite it.
      changedBindings += 1;
    }
    if (expectation?.expectedAutoFdc !== undefined && expectation.expectedAutoFdc !== bound) {
      oracleDivergences += 1;
    }
  }

  return {
    newBindings,
    changedBindings,
    oracleDivergences,
    expectNoAutomaticViolations,
    forbiddenFdcViolations,
    forbiddenDescriptionViolations,
    safetyHistoryBindings,
    identityLaneNewBindings,
  };
}

function toSimulation(
  rule: Ai6b3HypotheticalSafeRule,
  outcome: RuleOutcome
): Ai6b3RuleSimulation {
  const violations =
    outcome.changedBindings +
    outcome.oracleDivergences +
    outcome.expectNoAutomaticViolations +
    outcome.forbiddenFdcViolations +
    outcome.forbiddenDescriptionViolations +
    outcome.safetyHistoryBindings;
  const repairable =
    violations === 0 && outcome.identityLaneNewBindings > 0 && outcome.newBindings > 0;
  const reason: string = !repairable
    ? outcome.identityLaneNewBindings === 0
      ? 'no_identity_lane_witness'
      : `hypothetical_rule_would_violate:${[
          outcome.changedBindings > 0 ? 'changes_existing_bindings' : null,
          outcome.oracleDivergences > 0 ? 'diverges_known_good_oracle' : null,
          outcome.expectNoAutomaticViolations > 0 ? 'expect_no_automatic' : null,
          outcome.forbiddenFdcViolations > 0 ? 'forbidden_fdc' : null,
          outcome.forbiddenDescriptionViolations > 0 ? 'forbidden_description' : null,
          outcome.safetyHistoryBindings > 0 ? 'food_inside_preparation_safety' : null,
        ]
          .filter((entry) => entry !== null)
          .join('+')}`
    : 'bounded_rule_with_identity_lane_witness_and_no_violations';
  return Object.freeze({
    rule_id: rule,
    assertion: RULE_ASSERTIONS[rule],
    identity_lane_new_bindings: outcome.identityLaneNewBindings,
    corpus_new_bindings: outcome.newBindings,
    corpus_changed_bindings: outcome.changedBindings,
    oracle_divergences: outcome.oracleDivergences,
    expect_no_automatic_violations: outcome.expectNoAutomaticViolations,
    forbidden_fdc_violations: outcome.forbiddenFdcViolations,
    forbidden_description_violations: outcome.forbiddenDescriptionViolations,
    safety_history_bindings: outcome.safetyHistoryBindings,
    repairable_eligible: repairable,
    eligibility_reason: reason,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Builds the full AI-6B3 identity disposition report from the real bundle. */
export async function buildNutritionIdentityDispositionReport(): Promise<Ai6b3IdentityDispositionReport> {
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

  const expectationOf = (line: string): CorpusExpectationView | undefined =>
    AI6A_INTELLIGENCE_CORPUS.find((entry) => entry.line === line)?.identity as
      | CorpusExpectationView
      | undefined;

  const identityLane = records.filter((r) => r.repair_lane === 'deterministic_identity');
  const rankingBlockers = records.filter((r) => r.repair_lane === 'deterministic_ranking').length;

  const projections = records.map((record) => {
    const expectation = expectationOf(record.line);
    const parsed = parseIngredient(structuredIngredient(record.line));
    const p = parsed.ok ? parsed.parsed : null;
    const normalized = p !== null ? normalizeQuery(p.query).text : null;
    const projection =
      p !== null && normalized !== null
        ? projectQueryText(normalized, { count_noun: p.count_noun, container: p.container })
        : null;
    return {
      record,
      expectation,
      headTokens: tokenize((projection?.food_tokens ?? []).join(' ')),
    };
  });

  const lines: Ai6b3ReportLine[] = identityLane.map((record) => {
    const expectation = expectationOf(record.line);
    const gathered = gatherEvidence(session, record, expectation);
    const verdict = classifyIdentityDisposition(gathered.evidence);
    const ai3 = ai3CrossCheck(session, record);
    const line: Ai6b3ReportLine = {
      line: record.line,
      source: record.source,
      focus: record.focus,
      families: record.families,
      parsed_food_query: gathered.normalized,
      head_tokens: gathered.headTokens,
      quantity_kind: record.quantity_kind,
      measurement_kind: record.measurement_kind,
      raw_unit: record.raw_unit,
      amount: record.amount,
      container: record.container,
      primary_blocker: record.primary_blocker,
      terminal: record.terminal,
      review_outcome: record.review_outcome,
      selected_fdc_id: record.selected_fdc_id,
      selected_description: record.selected_description,
      mass_source: record.mass_source,
      resolved_grams: record.resolved_grams,
      candidate_count: record.candidate_count,
      candidates: record.candidates.map((candidate) => ({
        rank: candidate.rank,
        fdc_id: candidate.fdc_id,
        description: candidate.description,
        data_type: candidate.data_type,
        has_compatible_portion: candidate.has_compatible_portion,
      })),
      satisfying_candidate_ids: gathered.satisfying,
      all_satisfying_candidates_forbidden: gathered.allForbidden,
      head_probe_total: gathered.evidence.head_probe_total,
      head_probe_drop_leading_total: gathered.evidence.head_probe_drop_leading_total,
      catalog_probe_total: record.catalog_probe_total,
      expected_candidate_rank: record.expected_candidate_rank,
      auto_outcome: record.auto_outcome,
      identity_correctness: record.identity_correctness,
      secondary_signals: record.secondary_signals,
      expected_auto_fdc: expectation?.expectedAutoFdc ?? null,
      baseline_auto_fdc: expectation?.baselineAutoFdc ?? null,
      expect_no_automatic: expectation?.expectNoAutomatic === true,
      forbidden_auto_fdcs: expectation?.forbiddenAutoFdcs ?? [],
      forbidden_auto_description: expectation?.forbiddenAutoDescription?.source ?? null,
      expect_top_fdc: expectation?.expectTopFdc ?? null,
      expect_candidate_description: expectation?.expectCandidateDescription?.source ?? null,
      known_issue: expectation?.knownIssue ?? null,
      disposition: verdict.disposition,
      evidence: verdict.evidence,
      repairable: verdict.repairable,
      hypothetical_safe_rule: verdict.hypothetical_safe_rule,
      handoff_lane: verdict.handoff_lane,
      ai3_eligible: ai3.eligible,
      ai3_reason: ai3.reason,
    };
    // TOTALITY GUARD: no line may be left unclassified.
    if (!isAi6b3IdentityDisposition(line.disposition)) {
      throw new Error(`unclassified disposition for ${line.line}`);
    }
    if (!isAi6b3IdentityEvidenceCode(line.evidence)) {
      throw new Error(`unclassified evidence code for ${line.line}`);
    }
    return line;
  });

  const countBy = <T>(keys: ReadonlyArray<T>, pick: (line: Ai6b3ReportLine) => T) =>
    keys
      .map((key) => ({ key: String(key), count: lines.filter((line) => pick(line) === key).length }))
      .filter((entry) => entry.count > 0);

  const handoffKeys = [...new Set(lines.map((line) => line.handoff_lane ?? 'none'))].sort();
  const ai3Keys = [...new Set(lines.map((line) => line.ai3_reason))].sort();

  const repairableCount = lines.filter((line) => line.repairable).length;

  const hypothetical_rule_simulations = HYPOTHETICAL_SAFE_RULES.map((rule) =>
    toSimulation(rule, simulateRule(rule, projections))
  );

  const nextWork = deriveNextWork({
    observedBlockers: aggregates.primary_blockers.map((entry) => ({
      lane: laneForBlocker(entry.key),
      count: entry.count,
    })),
    // BOTH lanes are now adjudicated. Every other lane is honestly reported as
    // un-adjudicated (null), never as zero.
    //
    // `deterministic_portion` carries AI-6B2's MEASURED actionable count of 0.
    // It is a pinned RECORDED MEASUREMENT, not a recomputation and not the
    // observed 35: passing the observation here would resurrect an exhausted lane
    // as the top repair target purely from blocker frequency.
    adjudicatedActionableDefects: {
      deterministic_portion: PORTION_LANE_ACTIONABLE_DEFECTS,
      deterministic_identity: repairableCount,
    },
    criteriaScores: AI6A_LANE_CRITERION_SCORES as never,
    criteriaOrder: AI6A_ROADMAP_CRITERIA,
    neverTargetLanes: AI6A_NEVER_TARGET_LANES as ReadonlySet<string>,
  });

  // The portion lane's observed blocker count must still be AI-6B2's recorded 35,
  // so a corpus change cannot silently rewrite that historical measurement.
  const portionLaneRow = nextWork.lanes.find((lane) => lane.lane === 'deterministic_portion');
  if (
    portionLaneRow !== undefined &&
    portionLaneRow.observed_blockers !== PORTION_LANE_OBSERVED_BLOCKERS
  ) {
    throw new Error('the portion lane observation moved; AI-6B2 measurement must be reviewed');
  }

  return {
    schema: IDENTITY_DISPOSITION_SCHEMA,
    tool: 'benchmark_nutrition_identity_disposition',
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
    observed_identity_blockers: identityLane.length,
    blocker_split: [...new Set(identityLane.map((record) => record.primary_blocker))]
      .sort()
      .map((key) => ({
        key,
        count: identityLane.filter((record) => record.primary_blocker === key).length,
      })),
    repairable_deterministic_identity_defects: repairableCount,
    identity_lane_exhausted: repairableCount === 0,
    deterministic_ranking_blockers: rankingBlockers,
    disposition_counts: countBy(IDENTITY_DISPOSITIONS, (line) => line.disposition),
    evidence_counts: countBy(IDENTITY_EVIDENCE_CODES, (line) => line.evidence),
    handoff_lane_counts: handoffKeys.map((key) => ({
      key,
      count: lines.filter((line) => (line.handoff_lane ?? 'none') === key).length,
    })),
    ai3_eligibility_counts: ai3Keys.map((key) => ({
      key,
      count: lines.filter((line) => line.ai3_reason === key).length,
    })),
    identity_lane_constraint_counts: {
      expect_no_automatic: lines.filter((line) => line.expect_no_automatic).length,
      forbidden_auto_fdcs: lines.filter((line) => line.forbidden_auto_fdcs.length > 0).length,
      forbidden_auto_description: lines.filter(
        (line) => line.forbidden_auto_description !== null
      ).length,
    },
    hypothetical_rule_simulations,
    lane_repairability: nextWork.lanes,
    recommended_active_repair_lane: nextWork.recommended_active_repair_lane,
    recommended_active_repair_reason: nextWork.recommended_active_repair_reason,
    next_adjudication_target_lane: nextWork.next_adjudication_target_lane,
    next_adjudication_reason: nextWork.next_adjudication_reason,
    lines,
  };
}