/**
 * The Kitchen Codex — Advanced Nutrition AI-6B4: ranking disposition REPORT
 * BUILDER (planning only, ZERO production consumers).
 *
 * Gathers real evidence for every `compatible_candidate_not_selected` line
 * through the existing PUBLIC session contracts, adjudicates each into exactly
 * one closed disposition, SIMULATES the hypothetical general ranking rules that
 * could ever justify a repair, and derives the next-lane handoff from MEASURED
 * repairability.
 *
 * Reusable so tests build the identical report in-process; the CLI wrapper
 * (`scripts/benchmark_nutrition_ranking_disposition.ts`) only prints/serializes.
 *
 * DETERMINISTIC: no clock, randomness, hostname, absolute path, or environment
 * field enters the returned object. Two calls are byte-identical.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import {
  HYPOTHETICAL_RANKING_RULES,
  RANKING_DISPOSITIONS,
  RANKING_DISPOSITION_SCHEMA,
  RANKING_EVIDENCE_CODES,
  SEMANTIC_PARITY_VALUES,
  applyRuleSafetyGate,
  classifyRankingDisposition,
  isAi6b4RankingDisposition,
  isAi6b4RankingEvidenceCode,
  type Ai6b4HypotheticalRankingRule,
  type Ai6b4RankingDisposition,
  type Ai6b4RankingEvidence,
  type Ai6b4RankingEvidenceCode,
  type Ai6b4RuleSimulation,
  type Ai6b4SemanticParity,
} from './rankingDisposition';
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
 * The base production state this report is measured against. Pinned as a
 * CONSTANT so later HEAD movement cannot perturb the planning artifact.
 */
export const BASE_PHASE = 'AI-6B3';
export const BASE_COMMIT = 'd31070978c44cb21721441158b130b8ad98831b6';

/**
 * AI-6B2's and AI-6B3's MEASURED actionable counts, pinned as recorded
 * measurements. Passing the observed blocker counts here instead would resurrect
 * two exhausted lanes purely from blocker frequency.
 */
export const PORTION_LANE_ACTIONABLE_DEFECTS = 0;
export const IDENTITY_LANE_ACTIONABLE_DEFECTS = 0;

/** Observed blocker counts those two phases recorded; asserted, never recomputed. */
export const PORTION_LANE_OBSERVED_BLOCKERS = 35;
export const IDENTITY_LANE_OBSERVED_BLOCKERS = 27;

/**
 * DECLARED, REVIEWABLE state contradictions. An alternate that asserts one of
 * these while the recipe authors the opposing state may never replace the
 * selected record, however convenient its portion.
 */
export const AI6B4_STATE_CONTRADICTIONS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['raw', ['fried', 'cooked', 'roasted', 'baked', 'canned']],
  ['cooked', ['raw', 'uncooked', 'unprepared']],
  ['fresh', ['dried', 'freeze-dried', 'dehydrated']],
  ['unsalted', ['salted']],
  ['whole', ['ground']],
];

/**
 * DECLARED product-class negations. A record carrying one of these is not the
 * same product as a selected record that names an animal protein source: a
 * meatless analog is not bacon.
 */
export const AI6B4_PRODUCT_CLASS_NEGATIONS: ReadonlySet<string> = new Set([
  'meatless',
  'imitation',
  'substitute',
  'surrogate',
  'analogue',
]);

/** DECLARED animal protein tokens that a product-class negation would contradict. */
export const AI6B4_ANIMAL_PROTEIN_TOKENS: ReadonlySet<string> = new Set([
  'pork',
  'beef',
  'chicken',
  'turkey',
  'meat',
  'bacon',
  'sausage',
  'fish',
  'shrimp',
]);

/** DECLARED brand / commercial tokens; a branded identity is never genericized. */
export const AI6B4_BRAND_TOKENS: ReadonlySet<string> = new Set([
  'lipton',
  'kellogg',
  'cereal',
  'general',
  'mills',
  'nestle',
  'post',
  'quaker',
  'campbell',
  'heinz',
  'kraft',
  'alpen',
]);

/**
 * The food-inside-preparation safety class named by the AI-6A identity safety
 * history.
 *
 * WHAT THE HAZARD ACTUALLY IS
 * ---------------------------
 * The historical failure is a specific structural identity collision: for an
 * authored line like `sardines in tomato sauce`, the engine once risked binding
 * the EMBEDDED preparation component (`tomato sauce`) instead of the CONTAINING
 * food (`sardines`).
 *
 * WHAT THE PREVIOUS AI-6B4 DETECTOR GOT WRONG (Muse audit FLAG, repaired here)
 * ---------------------------------------------------------------------------
 * The earlier detector was a bare `/ in /` test. That is not a detector for this
 * hazard at all — it flags any authored line containing the standalone word
 * `in`. It reported two hits, and BOTH were false positives of the same kind: a
 * same-food record swap caught by an annotation word.
 *
 *   `3 to 4 slices provolone (about 75 to 100 grams in total)`
 *   `3 to 4 slices provolone (about 75-100 g in total)`
 *
 * In both, `in` occurs inside a PARENTHETICAL MASS ANNOTATION ("in total"), and
 * the swap under evaluation was `170850 Cheese, provolone` -> `2705733 Cheese,
 * Provolone` — the same food from a different data source. That is a
 * same-food record swap, not a nested-food identity collision, and calling it
 * `sardines`-class would misrepresent the safety history.
 *
 * WHY A DECLARED WITNESS SET RATHER THAN A GRAMMAR
 * ----------------------------------------------
 * A structural regex still cannot separate the hazard from ordinary preparation
 * wording: after stripping parentheticals, `sardines in tomato sauce` and
 * `1 can packed in oil` are syntactically identical, yet the first is a nested
 * food identity and the second is a preparation state phrase ("packed in oil").
 * Telling those apart requires FOOD SEMANTICS this artifact must not invent, so
 * the class is declared explicitly from the checked-in historical record instead.
 * The set is small, audited, and testable — which is the honest alternative to a
 * brittle heuristic that over-claims.
 */
export const AI6B4_FOOD_INSIDE_PREPARATION_WITNESSES: ReadonlySet<string> = new Set([
  // The historical witness: authored `food in preparation`, where binding the
  // embedded component instead of the containing food is the known failure.
  'sardines in tomato sauce',
]);

/**
 * Deliberately NOT a member of the structural-hazard class, recorded so the
 * exclusion is auditable rather than accidental:
 * - `1 can packed in oil` — "packed in oil" is a preparation STATE phrase, not a
 *   nested food identity.
 * - `3 to 4 slices provolone (... in total)` — `in` sits inside a parenthetical
 *   mass annotation and the evaluated swap is same-food.
 */
export const AI6B4_FOOD_INSIDE_PREPARATION_EXCLUSIONS: ReadonlySet<string> = new Set([
  '1 can packed in oil',
  '3 to 4 slices provolone (about 75 to 100 grams in total)',
  '3 to 4 slices provolone (about 75-100 g in total)',
]);

/**
 * True only for an authored line that is a checked-in witness of the historical
 * nested-food identity hazard. A simulation binding on such a line is a TRUE
 * `food_inside_preparation_safety` hit. Everything else — including same-food
 * record swaps — is not.
 */
export function isFoodInsidePreparationWitness(authoredLine: string): boolean {
  return AI6B4_FOOD_INSIDE_PREPARATION_WITNESSES.has(authoredLine);
}

// ---------------------------------------------------------------------------
// Token helpers (pure; no production module is altered)
// ---------------------------------------------------------------------------

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

/** Bounded morphology used ONLY so `chicken breasts` is not a false mismatch. */
function singularize(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && /(ch|sh|s|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function identicalDescription(a: string, b: string): boolean {
  const left = tokenize(a);
  const right = tokenize(b);
  return left.length === right.length && left.every((token) => right.includes(token));
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
  if (pattern === undefined) return false;
  return compiles(pattern).test(description);
}

/** True when the alternate asserts a state/form that opposes an authored state. */
function contradictsAuthoredState(
  descriptionTokens: ReadonlySet<string>,
  authoredHead: ReadonlyArray<string>
): boolean {
  for (const [authored, opposites] of AI6B4_STATE_CONTRADICTIONS) {
    if (!authoredHead.includes(authored)) continue;
    if (opposites.some((token) => descriptionTokens.has(token))) return true;
  }
  return false;
}

/** True when the alternate negates the selected record's product class. */
function changesFoodIdentity(
  descriptionTokens: ReadonlySet<string>,
  selectedTokens: ReadonlySet<string>
): boolean {
  const negates = [...descriptionTokens].some((token) =>
    AI6B4_PRODUCT_CLASS_NEGATIONS.has(token)
  );
  const selectedIsAnimalProtein = [...selectedTokens].some((token) =>
    AI6B4_ANIMAL_PROTEIN_TOKENS.has(token)
  );
  return negates && selectedIsAnimalProtein;
}

// ---------------------------------------------------------------------------
// Per-line projection
// ---------------------------------------------------------------------------

export interface Ai6b4AlternateView {
  readonly fdc_id: number;
  readonly rank: number;
  readonly description: string;
  readonly data_type: string;
  readonly preserves_authored_head: boolean;
  readonly identical_description_to_selected: boolean;
  readonly adds_unauthored_specificity: boolean;
  readonly contradicts_authored_state: boolean;
  readonly changes_food_identity: boolean;
  readonly forbidden: boolean;
}

export interface Ai6b4ReportLine {
  readonly line: string;
  readonly source: string;
  readonly focus: string;
  readonly families: ReadonlyArray<string>;
  readonly parsed_food_query: string | null;
  readonly head_tokens: ReadonlyArray<string>;
  readonly measurement_kind: string | null;
  readonly raw_unit: string | null;
  readonly amount: number | null;
  readonly count_noun_class: string;
  readonly container: string | null;
  readonly primary_blocker: string;
  readonly terminal: string;
  readonly review_outcome: string | null;
  // selected candidate evidence
  readonly selected_fdc_id: number | null;
  readonly selected_description: string | null;
  readonly selected_rank: number | null;
  readonly selected_has_compatible_portion: boolean;
  readonly selected_data_type: string | null;
  // current outcome (observational only)
  readonly mass_source: string;
  readonly resolved_grams: number | null;
  readonly identity_correctness: string;
  readonly auto_outcome: string;
  readonly expected_candidate_rank: string;
  readonly secondary_signals: ReadonlyArray<string>;
  // compatible alternate evidence
  readonly compatible_alternates: ReadonlyArray<Ai6b4AlternateView>;
  readonly compatible_alternate_count: number;
  // corpus constraints
  readonly expected_auto_fdc: number | null;
  readonly baseline_auto_fdc: number | null;
  readonly expect_top_fdc: number | null;
  readonly expect_candidate_description: string | null;
  readonly expect_no_automatic: boolean;
  readonly forbidden_auto_fdcs: ReadonlyArray<number>;
  readonly forbidden_auto_description: string | null;
  readonly known_issue: string | null;
  // verdict
  readonly disposition: Ai6b4RankingDisposition;
  readonly evidence: Ai6b4RankingEvidenceCode;
  readonly semantic_parity: Ai6b4SemanticParity;
  readonly repairable: boolean;
  readonly hypothetical_safe_rule: Ai6b4HypotheticalRankingRule | null;
  readonly handoff_lane: string | null;
  readonly ai3_eligible: boolean;
  readonly ai3_reason: string;
}

export interface Ai6b4RankingDispositionReport {
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
  readonly observed_ranking_blockers: number;
  readonly ranking_blocker_split: ReadonlyArray<{ key: string; count: number }>;
  /** The MEASURED number of genuine deterministic ranking defects. */
  readonly repairable_deterministic_ranking_defects: number;
  readonly ranking_lane_exhausted: boolean;
  /** Ranking is NOT identity: both lanes are reported, never merged. */
  readonly deterministic_identity_blockers: number;
  readonly deterministic_portion_blockers: number;
  readonly disposition_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly evidence_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly semantic_parity_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly handoff_lane_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ai3_eligibility_counts: ReadonlyArray<{ key: string; count: number }>;
  readonly ranking_lane_constraint_counts: {
    readonly expected_auto_fdc: number;
    readonly baseline_auto_fdc: number;
    readonly expect_top_fdc: number;
    readonly expect_candidate_description: number;
    readonly expect_no_automatic: number;
    readonly forbidden_auto_fdcs: number;
    readonly forbidden_auto_description: number;
    readonly known_issue: number;
  };
  readonly hypothetical_rule_simulations: ReadonlyArray<Ai6b4RuleSimulation>;
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
  readonly lines: ReadonlyArray<Ai6b4ReportLine>;
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
    head: tokenize((projection?.food_tokens ?? []).join(' ')).map(singularize),
    normalized,
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
    title: 'ai6b4',
    servings: 1,
    ingredients: [ingredient],
  } as never);
  if (!adaptedResult.ok) return { eligible: false, reason: 'adapt_failed' };
  const adapted = adaptedResult.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted as never, 1);

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptedResult.recipe.recipe_key,
    sessionIdentity: 'ai6b4',
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

const RULE_ASSERTIONS: Readonly<Record<Ai6b4HypotheticalRankingRule, string>> = {
  prefer_identical_description_with_compatible_portion:
    'Prefer a candidate whose description is token-identical to the selected record when it carries compatible portion authority.',
  prefer_head_token_preserving_candidate_with_compatible_portion:
    'Among candidates preserving every authored food-head token, prefer one carrying compatible portion authority over the selected record.',
};

interface RuleOutcome {
  newAutomatic: number;
  changedAutomatic: number;
  unchangedAutomatic: number;
  expectedDivergences: number;
  baselineDivergences: number;
  expectTopViolations: number;
  expectNoAutomaticViolations: number;
  forbiddenFdcViolations: number;
  forbiddenDescriptionViolations: number;
  safetyHistoryBindings: number;
  rankingLaneNewBindings: number;
  newAuthenticatedMasses: number;
  changedGrams: number;
}

interface SimProjection {
  readonly record: Ai6aDiagnosticRecord;
  readonly expectation: CorpusExpectationView | undefined;
  readonly head: ReadonlyArray<string>;
}

/**
 * Runs one hypothetical ranking rule across ALL 207 recon lines and every
 * checked-in safety constraint. It never mutates a record: it only computes what
 * the rule WOULD select and whether that would break anything.
 */
function simulateRule(
  rule: Ai6b4HypotheticalRankingRule,
  projections: ReadonlyArray<SimProjection>
): RuleOutcome {
  const out: RuleOutcome = {
    newAutomatic: 0,
    changedAutomatic: 0,
    unchangedAutomatic: 0,
    expectedDivergences: 0,
    baselineDivergences: 0,
    expectTopViolations: 0,
    expectNoAutomaticViolations: 0,
    forbiddenFdcViolations: 0,
    forbiddenDescriptionViolations: 0,
    safetyHistoryBindings: 0,
    rankingLaneNewBindings: 0,
    newAuthenticatedMasses: 0,
    changedGrams: 0,
  };

  for (const { record, expectation, head } of projections) {
    const selected = record.candidates.find((c) => c.fdc_id === record.selected_fdc_id);
    if (selected === undefined) continue;
    const selectedTokens = new Set(tokenize(selected.description));

    // Which compatible alternate WOULD this rule prefer?
    const candidate = record.candidates.find((c) => {
      if (!c.has_compatible_portion || c.fdc_id === record.selected_fdc_id) return false;
      if (rule === 'prefer_identical_description_with_compatible_portion') {
        return identicalDescription(c.description, selected.description);
      }
      const tokens = new Set(tokenize(c.description).map(singularize));
      return head.every((token) => tokens.has(token));
    });
    if (candidate === undefined) {
      out.unchangedAutomatic += 1;
      continue;
    }

    out.rankingLaneNewBindings += 1;
    // Counts ONLY true structural witnesses of the historical nested-food
    // identity hazard. See AI6B4_FOOD_INSIDE_PREPARATION_WITNESSES.
    if (isFoodInsidePreparationWitness(record.line)) out.safetyHistoryBindings += 1;
    if (expectation?.expectNoAutomatic === true) out.expectNoAutomaticViolations += 1;
    if (expectation?.forbiddenAutoFdcs?.includes(candidate.fdc_id) === true) {
      out.forbiddenFdcViolations += 1;
    }
    if (
      expectation?.forbiddenAutoDescription !== undefined &&
      compiles(expectation.forbiddenAutoDescription).test(candidate.description)
    ) {
      out.forbiddenDescriptionViolations += 1;
    }
    if (expectation?.expectedAutoFdc !== undefined) {
      if (expectation.expectedAutoFdc !== candidate.fdc_id) out.expectedDivergences += 1;
      else out.unchangedAutomatic += 1;
    }
    if (expectation?.baselineAutoFdc !== undefined && expectation.baselineAutoFdc !== candidate.fdc_id) {
      out.baselineDivergences += 1;
    }
    if (
      expectation?.expectTopFdc !== undefined &&
      expectation.expectTopFdc !== candidate.fdc_id
    ) {
      out.expectTopViolations += 1;
    }
    if (record.selected_fdc_id === null) {
      out.newAutomatic += 1;
      out.newAuthenticatedMasses += 1;
    } else {
      out.changedAutomatic += 1;
      // The selected record cannot satisfy the authored quantity today, so
      // switching identities would move the gram value that production reports.
      out.changedGrams += 1;
    }
  }

  return out;
}

function toSimulation(
  rule: Ai6b4HypotheticalRankingRule,
  outcome: RuleOutcome
): Ai6b4RuleSimulation {
  const violations =
    outcome.expectedDivergences +
    outcome.baselineDivergences +
    outcome.expectTopViolations +
    outcome.expectNoAutomaticViolations +
    outcome.forbiddenFdcViolations +
    outcome.forbiddenDescriptionViolations +
    outcome.safetyHistoryBindings;
  const repairable = violations === 0 && outcome.rankingLaneNewBindings > 0;
  const reason: string = repairable
    ? 'bounded_general_rule_with_ranking_lane_witness_and_no_violations'
    : violations === 0
      ? 'no_ranking_lane_witness'
      : `hypothetical_rule_would_violate:${[
          outcome.expectedDivergences > 0 ? 'diverges_expected_identity_oracle' : null,
          outcome.baselineDivergences > 0 ? 'diverges_baseline_identity' : null,
          outcome.expectTopViolations > 0 ? 'violates_expect_top_fdc' : null,
          outcome.expectNoAutomaticViolations > 0 ? 'expect_no_automatic' : null,
          outcome.forbiddenFdcViolations > 0 ? 'forbidden_fdc' : null,
          outcome.forbiddenDescriptionViolations > 0 ? 'forbidden_description' : null,
          outcome.safetyHistoryBindings > 0 ? 'food_inside_preparation_safety' : null,
        ]
          .filter((entry) => entry !== null)
          .join('+')}`;
  return Object.freeze({
    rule_id: rule,
    assertion: RULE_ASSERTIONS[rule],
    new_automatic_identities: outcome.newAutomatic,
    changed_automatic_identities: outcome.changedAutomatic,
    unchanged_automatic_identities: outcome.unchangedAutomatic,
    expected_fdc_divergences: outcome.expectedDivergences,
    baseline_fdc_divergences: outcome.baselineDivergences,
    expect_top_fdc_violations: outcome.expectTopViolations,
    expect_no_automatic_violations: outcome.expectNoAutomaticViolations,
    forbidden_fdc_violations: outcome.forbiddenFdcViolations,
    forbidden_description_violations: outcome.forbiddenDescriptionViolations,
    safety_history_bindings: outcome.safetyHistoryBindings,
    ranking_lane_new_bindings: outcome.rankingLaneNewBindings,
    new_authenticated_masses: outcome.newAuthenticatedMasses,
    changed_grams: outcome.changedGrams,
    repairable_eligible: repairable,
    eligibility_reason: reason,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Builds the full AI-6B4 ranking disposition report from the real bundle. */
export async function buildNutritionRankingDispositionReport(): Promise<Ai6b4RankingDispositionReport> {
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

  const rankingLane = records.filter(
    (record) => record.primary_blocker === 'compatible_candidate_not_selected'
  );

  const projections: SimProjection[] = records.map((record) => ({
    record,
    expectation: expectationOf(record.line),
    head: headTokensOf(record).head,
  }));

  // The hypothetical rules are simulated FIRST, because whether a line counts as
  // repairable depends on whether its rule survives corpus-wide simulation.
  // A line-local verdict is deliberately NOT sufficient.
  const hypothetical_rule_simulations = HYPOTHETICAL_RANKING_RULES.map((rule) =>
    toSimulation(rule, simulateRule(rule, projections))
  );
  const ruleEligibility: Record<string, boolean> = Object.fromEntries(
    hypothetical_rule_simulations.map((entry) => [entry.rule_id, entry.repairable_eligible])
  );

  const lines: Ai6b4ReportLine[] = rankingLane.map((record) => {
    const expectation = expectationOf(record.line);
    const { head, normalized } = headTokensOf(record);
    const selected = record.candidates.find((c) => c.fdc_id === record.selected_fdc_id);
    const selectedTokens = new Set(tokenize(selected?.description ?? ''));

    const compatible_alternates: Ai6b4AlternateView[] = record.candidates
      .filter((c) => c.has_compatible_portion && c.fdc_id !== record.selected_fdc_id)
      .map((c) => {
        const descriptionTokens = new Set(tokenize(c.description).map(singularize));
        const rawTokens = new Set(tokenize(c.description));
        return {
          fdc_id: c.fdc_id,
          rank: c.rank,
          description: c.description,
          data_type: c.data_type,
          preserves_authored_head: head.every((token) => descriptionTokens.has(token)),
          identical_description_to_selected: identicalDescription(
            c.description,
            selected?.description ?? ''
          ),
          adds_unauthored_specificity: [...rawTokens].some(
            (token) => !selectedTokens.has(token) && !head.includes(singularize(token))
          ),
          contradicts_authored_state: contradictsAuthoredState(rawTokens, head),
          changes_food_identity: changesFoodIdentity(rawTokens, selectedTokens),
          forbidden: isForbidden(expectation, c.fdc_id, c.description),
        };
      });

    const evidence: Ai6b4RankingEvidence = {
      expected_fdc_pins_selected: expectation?.expectedAutoFdc === record.selected_fdc_id,
      expect_no_automatic: expectation?.expectNoAutomatic === true,
      alternate_forbidden: compatible_alternates.some((alternate) => alternate.forbidden),
      compatible_alternates,
      selected_is_branded: [...tokenize(selected?.description ?? '')].some((token) =>
        AI6B4_BRAND_TOKENS.has(token)
      ),
    };

    const provisional = classifyRankingDisposition(evidence);
    // CORPUS-WIDE GATE: a line-local repairable verdict counts only when the
    // general rule that would implement it survived simulation.
    const verdict = applyRuleSafetyGate(provisional, ruleEligibility);
    const ai3 = ai3CrossCheck(session, record);

    const line: Ai6b4ReportLine = {
      line: record.line,
      source: record.source,
      focus: record.focus,
      families: record.families,
      parsed_food_query: normalized,
      head_tokens: head,
      measurement_kind: record.measurement_kind,
      raw_unit: record.raw_unit,
      amount: record.amount,
      count_noun_class: record.count_noun_class,
      container: record.container,
      primary_blocker: record.primary_blocker,
      terminal: record.terminal,
      review_outcome: record.review_outcome,
      selected_fdc_id: record.selected_fdc_id,
      selected_description: record.selected_description,
      selected_rank: selected?.rank ?? null,
      selected_has_compatible_portion: selected?.has_compatible_portion ?? false,
      selected_data_type: selected?.data_type ?? null,
      mass_source: record.mass_source,
      resolved_grams: record.resolved_grams,
      identity_correctness: record.identity_correctness,
      auto_outcome: record.auto_outcome,
      expected_candidate_rank: record.expected_candidate_rank,
      secondary_signals: record.secondary_signals,
      compatible_alternates,
      compatible_alternate_count: compatible_alternates.length,
      expected_auto_fdc: expectation?.expectedAutoFdc ?? null,
      baseline_auto_fdc: expectation?.baselineAutoFdc ?? null,
      expect_top_fdc: expectation?.expectTopFdc ?? null,
      expect_candidate_description: expectation?.expectCandidateDescription?.source ?? null,
      expect_no_automatic: expectation?.expectNoAutomatic === true,
      forbidden_auto_fdcs: expectation?.forbiddenAutoFdcs ?? [],
      forbidden_auto_description: expectation?.forbiddenAutoDescription?.source ?? null,
      known_issue: expectation?.knownIssue ?? null,
      disposition: verdict.disposition,
      evidence: verdict.evidence,
      semantic_parity: verdict.semantic_parity,
      repairable: verdict.repairable,
      hypothetical_safe_rule: verdict.hypothetical_safe_rule,
      handoff_lane: verdict.handoff_lane,
      ai3_eligible: ai3.eligible,
      ai3_reason: ai3.reason,
    };

    // TOTALITY GUARD: no line may be left unclassified.
    if (!isAi6b4RankingDisposition(line.disposition)) {
      throw new Error(`unclassified disposition for ${line.line}`);
    }
    if (!isAi6b4RankingEvidenceCode(line.evidence)) {
      throw new Error(`unclassified evidence code for ${line.line}`);
    }
    return line;
  });

  const countBy = <T>(keys: ReadonlyArray<T>, pick: (line: Ai6b4ReportLine) => T) =>
    keys
      .map((key) => ({ key: String(key), count: lines.filter((line) => pick(line) === key).length }))
      .filter((entry) => entry.count > 0);

  const handoffKeys = [...new Set(lines.map((line) => line.handoff_lane ?? 'none'))].sort();
  const ai3Keys = [...new Set(lines.map((line) => line.ai3_reason))].sort();

  const repairableCount = lines.filter((line) => line.repairable).length;

  const nextWork = deriveNextWork({
    observedBlockers: aggregates.primary_blockers.map((entry) => ({
      lane: laneForBlocker(entry.key),
      count: entry.count,
    })),
    // THREE lanes are now adjudicated. Everything else stays honestly
    // un-adjudicated (null), never zero.
    adjudicatedActionableDefects: {
      deterministic_portion: PORTION_LANE_ACTIONABLE_DEFECTS,
      deterministic_identity: IDENTITY_LANE_ACTIONABLE_DEFECTS,
      deterministic_ranking: repairableCount,
    },
    criteriaScores: AI6A_LANE_CRITERION_SCORES as never,
    criteriaOrder: AI6A_ROADMAP_CRITERIA,
    neverTargetLanes: AI6A_NEVER_TARGET_LANES as ReadonlySet<string>,
  });

  // The two previously measured observations must still hold, so a corpus change
  // cannot silently rewrite AI-6B2 / AI-6B3 history.
  for (const [laneName, observed] of [
    ['deterministic_portion', PORTION_LANE_OBSERVED_BLOCKERS],
    ['deterministic_identity', IDENTITY_LANE_OBSERVED_BLOCKERS],
  ] as const) {
    const row = nextWork.lanes.find((lane) => lane.lane === laneName);
    if (row !== undefined && row.observed_blockers !== observed) {
      throw new Error(`the ${laneName} observation moved; its recorded measurement must be reviewed`);
    }
  }

  return {
    schema: RANKING_DISPOSITION_SCHEMA,
    tool: 'benchmark_nutrition_ranking_disposition',
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
    observed_ranking_blockers: rankingLane.length,
    ranking_blocker_split: [...new Set(rankingLane.map((record) => record.primary_blocker))]
      .sort()
      .map((key) => ({
        key,
        count: rankingLane.filter((record) => record.primary_blocker === key).length,
      })),
    repairable_deterministic_ranking_defects: repairableCount,
    ranking_lane_exhausted: repairableCount === 0,
    deterministic_identity_blockers: records.filter(
      (record) => record.repair_lane === 'deterministic_identity'
    ).length,
    deterministic_portion_blockers: records.filter(
      (record) => record.repair_lane === 'deterministic_portion'
    ).length,
    disposition_counts: countBy(RANKING_DISPOSITIONS, (line) => line.disposition),
    evidence_counts: countBy(RANKING_EVIDENCE_CODES, (line) => line.evidence),
    semantic_parity_counts: countBy(SEMANTIC_PARITY_VALUES, (line) => line.semantic_parity),
    handoff_lane_counts: handoffKeys.map((key) => ({
      key,
      count: lines.filter((line) => (line.handoff_lane ?? 'none') === key).length,
    })),
    ai3_eligibility_counts: ai3Keys.map((key) => ({
      key,
      count: lines.filter((line) => line.ai3_reason === key).length,
    })),
    ranking_lane_constraint_counts: {
      expected_auto_fdc: lines.filter((line) => line.expected_auto_fdc !== null).length,
      baseline_auto_fdc: lines.filter((line) => line.baseline_auto_fdc !== null).length,
      expect_top_fdc: lines.filter((line) => line.expect_top_fdc !== null).length,
      expect_candidate_description: lines.filter(
        (line) => line.expect_candidate_description !== null
      ).length,
      expect_no_automatic: lines.filter((line) => line.expect_no_automatic).length,
      forbidden_auto_fdcs: lines.filter((line) => line.forbidden_auto_fdcs.length > 0).length,
      forbidden_auto_description: lines.filter(
        (line) => line.forbidden_auto_description !== null
      ).length,
      known_issue: lines.filter((line) => line.known_issue !== null).length,
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