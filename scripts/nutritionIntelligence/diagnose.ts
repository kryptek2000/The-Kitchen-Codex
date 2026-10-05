/**
 * The Kitchen Codex — Advanced Nutrition AI-6A diagnostic classifier.
 *
 * Runs the REAL pinned USDA bundle through the REAL production pipeline
 * (parse -> adapt -> review/matching -> analyzer -> deterministic portions ->
 * calculation -> live projection) and produces one MULTI-AXIS diagnostic record
 * per authored line.
 *
 * AI-6A is RECONNAISSANCE + MEASUREMENT ONLY:
 *   - it changes no nutrition truth and imports nothing into production;
 *   - it makes no network, provider, Gemini, OpenRouter, or AI request;
 *   - it uses no clock, no randomness, and no user files;
 *   - an AI-3 bounded estimate is estimate-class and is NEVER credited as
 *     authenticated mass here.
 *
 * Every label is derived from OBSERVABLE pipeline facts. A conclusion that
 * cannot be established from checked-in corpus knowledge is `unverified` — this
 * module never invents correctness.
 */

import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { candidatePortionCompatibility } from '../../src/core/nutritionV2/calculation/portionSemantics';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { ParsedIngredientReview } from '../../src/core/nutritionV2/matching/types';
import type { Ai6aCorpusLine } from '../../tests/fixtures/advancedNutritionAi6aIntelligenceCorpus';
import {
  AI6A_CANDIDATE_WINDOW,
  AI6A_COUNT_NOUN_CLASSES,
  AI6A_SUCCESS_SENTINEL,
  blockerPrecedenceRank,
  boundedAuthoredMeasurement,
  isAuthenticatedMassSource,
  isIndefiniteMeasureUnit,
  laneForBlocker,
  portionResolvableQuantity,
  rangeEndpointsRepresented,
  type Ai6aAutoOutcome,
  type Ai6aCountNounClass,
  type Ai6aCoverageFamily,
  type Ai6aCorpusSource,
  type Ai6aExpectedCandidateRank,
  type Ai6aIdentityCorrectness,
  type Ai6aMassSource,
  type Ai6aPrimaryBlocker,
  type Ai6aQualitativeReason,
  type Ai6aRepairLane,
  type Ai6aSecondarySignal,
  type Ai6aTerminal,
} from './taxonomy';

// ---------------------------------------------------------------------------
// Authored-text signal vocabularies (declared, closed, deterministic)
// ---------------------------------------------------------------------------

/**
 * Branded / commercial specificity tokens observed in real recipe wording. This
 * is a DIAGNOSTIC vocabulary, not a brand catalog and not a claim that USDA must
 * contain any exact branded record: it only marks that the line names a
 * commercial product, which is the signal that separates an
 * identity/specificity problem from an amount/portion problem.
 */
export const BRAND_TOKENS: ReadonlySet<string> = new Set([
  'lipton',
  'mrs',
  'dash',
  'knorr',
  'heinz',
  'best foods',
  'hunt s',
  'prego',
  'barilla',
  'swanson',
  'pace',
  'idahoan',
  'betty crocker',
  'carnation',
  'bouillon',
  'oxo',
  'kikkoman',
  'tabasco',
]);

const SIZE_DESCRIPTOR = /\b(large|small|medium|jumbo|extra[\s-]?large|whole)\b/i;
const PREPARATION_MODIFIER =
  /\b(chopped|minced|sliced|diced|crushed|ground|grated|shredded|peeled|cubed|trimmed|rinsed|drained|halved|quartered|beaten|melted|softened|divided)\b/i;
const STATE_MODIFIER =
  /\b(raw|cooked|uncooked|fresh|dried|frozen|canned|packed|drained|unsalted|salted|lean|whole|skim|low[\s-]?fat|lowfat|reduced[\s-]?fat|boneless|skinless|smoked|cured)\b/i;
const FORM_MODIFIER =
  /\b(shredded|grated|ground|crushed|minced|diced|sliced|chopped|whole|halved|quartered|puree|pur[ée]ed)\b/i;
const NUTRIENT_ANNOTATION =
  /\(\s*(?:about\s+)?\d+(?:\.\d+)?\s*(?:g|mg|mcg|kcal|cal|calories|oz|ounces)\b[^)]*\)/i;
/**
 * Explicit qualitative CUES (an author deliberately under-specifying).
 *
 * AI-6A-R1: `dash` is only a cue in its genuine QUANTITY PHRASE. The pre-repair
 * regex matched the bare token, so the BRAND "Mrs. Dash" was flagged as a
 * qualitative amount even though it carries an explicit `1 tbsp` measurement.
 * `a dash of` / `dasherful` are the real English quantity phrases.
 */
const QUALITATIVE_CUE =
  /\b(to taste|as needed|as required|for garnish|for serving|for dusting|to garnish|a pinch of|pinch|handful|a handful of|drizzle|drizzled|dash(?:es)? of|dasherful|splash|sprinkle|a sprinkle of)\b/i;

/**
 * True when the line carries an explicit intentional qualitative cue. Exported
 * so the adversarial brand-vs-quantity distinction is directly testable.
 */
export function hasExplicitQualitativeCue(authored: string): boolean {
  return QUALITATIVE_CUE.test(authored);
}
/**
 * Indefinite-measure PHRASES removed before brand-token scanning, so a quantity
 * word that is also a brand fragment is never read as a brand.
 */
const INDEFINITE_MEASURE_PHRASE =
  /\b(?:a\s+)?(?:pinch|handful|dash|drizzle|splash|sprinkle|smidgen|drop)s?\s+of\b/g;

const CONTAINER_CUE =
  /\b(can|cans|jar|jars|package|packages|packet|packets|bottle|bottles|tin|tins|carton|box|bag|container|tube|box)\b/i;

/**
 * COUNT NOUNS (a countable unit of the food) vs HOUSEHOLD NOUNS (a
 * household-sized object rather than a culinary unit). The split is what lets
 * "a pickle slice weighs nothing" and "a bunch of parsley weighs nothing" be
 * reported as two different noun classes instead of one generic amount failure.
 */
const COUNT_UNIT_NOUNS: ReadonlySet<string> = new Set(['slice', 'clove', 'piece']);
const HOUSEHOLD_NOUNS: ReadonlySet<string> = new Set([
  'head',
  'stalk',
  'stick',
  'sprig',
  'bunch',
]);
const CONTAINER_NOUNS: ReadonlySet<string> = new Set(['can', 'jar', 'package', 'packet']);

/**
 * Every authored plural folds onto its CLOSED singular noun class, so the noun
 * census can never report `slices` and `slice` as two different classes (which
 * would silently halve the apparent frequency of a real noun gap).
 */
const NOUN_SINGULARS: Readonly<Record<string, Ai6aCountNounClass>> = Object.freeze({
  slice: 'slice',
  slices: 'slice',
  clove: 'clove',
  cloves: 'clove',
  head: 'head',
  heads: 'head',
  stalk: 'stalk',
  stalks: 'stalk',
  stick: 'stick',
  sticks: 'stick',
  piece: 'piece',
  pieces: 'piece',
  sprig: 'sprig',
  sprigs: 'sprig',
  bunch: 'bunch',
  bunches: 'bunch',
  can: 'can',
  cans: 'can',
  jar: 'jar',
  jars: 'jar',
  package: 'package',
  packages: 'package',
  packet: 'packet',
  packets: 'packet',
  whole: 'whole_item',
});

/**
 * Compound food-form words that FOLLOW `whole`. In `whole milk` and `whole wheat
 * bread`, `whole` describes the FOOD FORM, not a countable item — so token
 * presence alone must never yield `whole_item`.
 */
const WHOLE_FOOD_FORM_SUFFIXES: ReadonlySet<string> = new Set(['wheat', 'milk']);

/**
 * `whole` is only a count/item descriptor when PARSE CONTEXT supports it: the
 * author wrote an explicit exact quantity. `1 whole chicken` / `2 whole lemons`
 * qualify; `whole milk` / `whole cloves` do not.
 */
function wholeIsCountDescriptor(
  countNoun: string | undefined,
  authored: string,
  context: { readonly amount: number | null; readonly quantityKind: string | null }
): boolean {
  if (countNoun === 'whole') return true;
  if (context.quantityKind !== 'exact' || context.amount === null) return false;
  const tokens = authored.toLowerCase().match(/[a-z]+/g) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'whole') continue;
    const next = tokens[index + 1];
    if (next !== undefined && WHOLE_FOOD_FORM_SUFFIXES.has(next)) continue;
    return true;
  }
  return false;
}

/** Parse context the noun classifier needs to disambiguate food-state wording. */
export interface NounParseContext {
  readonly amount: number | null;
  readonly quantityKind: string | null;
}

/**
 * Maps an authored/parsed count noun onto the closed noun-class vocabulary.
 *
 * Falls back to the authored wording so a household noun the parser did not
 * canonicalize is still reported by name rather than as `none`. The result is
 * ALWAYS a member of `AI6A_COUNT_NOUN_CLASSES`.
 *
 * AI-6A-R1: `whole_item` REQUIRES parse context. Previously `whole milk` was
 * reported as `whole_item` purely because the token `whole` appeared, which
 * collided food-state wording with count wording and mis-filed it under
 * `authenticated_count_portion_absent`.
 */
export function countNounClassFor(
  countNoun: string | undefined,
  authored: string,
  context: NounParseContext = { amount: null, quantityKind: null }
): Ai6aCountNounClass {
  const direct = countNoun === undefined ? undefined : NOUN_SINGULARS[countNoun];
  if (direct !== undefined && direct !== 'whole_item') return direct;
  if (countNoun === 'whole') {
    return wholeIsCountDescriptor(countNoun, authored, context) ? 'whole_item' : 'none';
  }
  const tokens = authored.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const token of tokens) {
    const mapped = NOUN_SINGULARS[token];
    if (mapped === undefined) continue;
    if (mapped === 'whole_item') {
      if (wholeIsCountDescriptor(undefined, authored, context)) return 'whole_item';
      continue;
    }
    return mapped;
  }
  return 'none';
}

/** True when the noun class is a household-sized object rather than a unit. */
export function isHouseholdNounClass(value: Ai6aCountNounClass): boolean {
  return HOUSEHOLD_NOUNS.has(value);
}

/** True when the noun class names a container/package rather than a food unit. */
export function isContainerNounClass(value: Ai6aCountNounClass): boolean {
  return CONTAINER_NOUNS.has(value);
}

/** True when the noun class is a countable culinary unit. */
export function isCountUnitNounClass(value: Ai6aCountNounClass): boolean {
  return COUNT_UNIT_NOUNS.has(value);
}

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

export interface Ai6aCandidateView {
  /** 1-based rank inside the bounded candidate window. */
  readonly rank: number;
  readonly fdc_id: number;
  readonly description: string;
  readonly data_type: string;
  /** True when the record can satisfy the line's authored measurement. */
  readonly has_compatible_portion: boolean;
}

export interface Ai6aDiagnosticRecord {
  // --- identity of the line ------------------------------------------------
  readonly line: string;
  readonly source: Ai6aCorpusSource;
  readonly focus: string;
  readonly families: ReadonlyArray<Ai6aCoverageFamily>;

  // --- parse axis ----------------------------------------------------------
  readonly parsed_food_query: string | null;
  readonly quantity_kind: string | null;
  readonly measurement_kind: string | null;
  readonly amount: number | null;
  readonly raw_unit: string | null;
  readonly count_noun_class: Ai6aCountNounClass;
  readonly range: { readonly lower: number; readonly upper: number } | null;
  /**
   * AI-6A-R1: which kind of missing amount this is, or null when the line has a
   * resolvable quantity. Makes the two subtypes visible per line.
   */
  readonly qualitative_reason: Ai6aQualitativeReason | null;
  /** True when a portion authority could actually consume the authored quantity. */
  readonly portion_resolvable_quantity: boolean;
  readonly container: string | null;
  readonly package_net_mass: {
    readonly amount: number;
    readonly unit: string;
    readonly scope: string | null;
  } | null;

  // --- live terminal axis --------------------------------------------------
  readonly terminal: Ai6aTerminal;
  readonly review_outcome: string | null;
  readonly selected_fdc_id: number | null;
  readonly selected_description: string | null;
  readonly mass_source: Ai6aMassSource;
  readonly resolved_grams: number | null;

  // --- candidate axis ------------------------------------------------------
  readonly candidate_count: number;
  readonly candidates: ReadonlyArray<Ai6aCandidateView>;
  readonly expected_candidate_rank: Ai6aExpectedCandidateRank;
  readonly auto_outcome: Ai6aAutoOutcome;
  /** Bounded deterministic catalog probe over the food's core tokens. */
  readonly catalog_probe_total: number;

  // --- portion axis --------------------------------------------------------
  readonly selected_record_portion_compatible: boolean | null;
  readonly alternate_candidate_portion_compatible: boolean | null;
  readonly alternate_candidate_fdc_id: number | null;

  // --- judgement axes ------------------------------------------------------
  readonly identity_correctness: Ai6aIdentityCorrectness;
  readonly primary_blocker: Ai6aPrimaryBlocker;
  readonly secondary_signals: ReadonlyArray<Ai6aSecondarySignal>;
  readonly repair_lane: Ai6aRepairLane;
}

// ---------------------------------------------------------------------------
// Pipeline helpers (identical shape to the historical benchmark)
// ---------------------------------------------------------------------------

/**
 * The benchmark's structured ingredient projection. Reproduced verbatim so the
 * historical 97 lines observe exactly the same pipeline as
 * `scripts/benchmark_resolution_coverage.ts`.
 */
export function structuredIngredient(line: string): Record<string, unknown> {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { original: line };
  const p = parsed.parsed;
  return {
    original: line,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function recipeFor(line: string): never {
  return {
    id: 'ai6a',
    fileName: 'ai6a.md',
    filePath: 'ai6a.md',
    rawMarkdown: '',
    title: 'ai6a',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [structuredIngredient(line)],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as never;
}

/**
 * True when the record can satisfy the line's authored measurement, using the
 * SAME deterministic portion-compatibility authority the calculation uses.
 */
function recordHasCompatiblePortion(
  session: AdvancedNutritionSession,
  ingredient: unknown,
  fdcId: number,
  measurementKind: string
): boolean {
  if (measurementKind === 'mass') return true;
  if (measurementKind === 'volume') {
    const review = session.reviewPortions(fdcId);
    if (!review.ok) return false;
    return review.review.candidates.some(
      (candidate) =>
        candidate.kind === 'volume' &&
        candidatePortionCompatibility(candidate, 'volume') === 'compatible' &&
        candidate.volume_ml !== null &&
        candidate.volume_ml > 0 &&
        candidate.gram_weight > 0
    );
  }
  if (measurementKind === 'count') {
    const review = session.reviewCountPortions(ingredient, fdcId);
    if (!review.ok) return false;
    return review.review.candidates.length > 0;
  }
  return false;
}

/**
 * The food's CORE tokens, used only as a bounded catalog plausibility probe.
 *
 * This is how the recon honestly separates a CATALOG GAP (nothing plausible even
 * under simpler terms) from a MATCHER FAILURE (plausible records exist but the
 * pipeline did not surface them). It is a probe, never a selection.
 */
function coreProbeQuery(foodQuery: string): string {
  const stop = new Set([
    'fresh',
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
    'freshly',
    'finely',
    'thinly',
    'roughly',
  ]);
  const tokens = foodQuery
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stop.has(token));
  return tokens.slice(0, 4).join(' ');
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * An authored alternative is a STANDALONE `or` word joining two foods.
 *
 * Detection is `\bor\b`, so a substring inside another token can never match:
 * `Worcestershire`, `coriander`, `porridge` and `flour` all contain the letters
 * `or` without being a choice. AI-6A-R3 raises the stakes on precision — an
 * authored alternative now WITHHOLDS safe success credit — so the word-boundary
 * requirement is load-bearing, not cosmetic.
 *
 * Detection is intentionally recall-oriented: in English ingredient text a
 * standalone `or` essentially always IS an authored choice. A line that merely
 * *mentions* an alternative still cannot receive safe success credit, because the
 * engine would have had to pick one to earn it.
 */
export function hasAuthoredAlternative(parsedQuery: string, authored: string): boolean {
  return /\bor\b/.test(parsedQuery) || /\bor\b/.test(authored);
}

export interface PrecedenceInput {
  readonly resolved: boolean;
  readonly massSource: Ai6aMassSource;
  readonly correctness: Ai6aIdentityCorrectness;
  readonly parsedOk: boolean;
  readonly quantityKind: string | null;
  readonly measurementKind: string | null;
  /**
   * AI-6A-R2: true when a `range` was authored AND both endpoints were actually
   * extracted as finite numbers. This is what separates the two measurement
   * blockers:
   *
   *   - endpoints represented  -> `measurement_policy_gap`. The measurement was
   *     captured correctly; nothing authorized is allowed to consume it. Calling
   *     this a PARSE failure is false, and routing it to an AI-interpretation
   *     lane implies a semantic interpretation nobody needs to read `1-2 tbsp`.
   *   - endpoints NOT represented -> `measurement_parse_gap`. The authored
   *     measurement genuinely failed to survive deterministic parsing.
   */
  readonly rangeEndpointsRepresented: boolean;
  /**
   * True only when an exact mass was parsed AND an identity was actually bound.
   * A mass that never got applied because NO identity was bound is an identity
   * failure, not a measurement gap — labeling it as one would send AI-6B to the
   * wrong layer.
   *
   * AI-6A-R2: a parsed mass that simply was not CONSUMED is a POLICY gap, not a
   * parse gap — the measurement was represented correctly.
   */
  readonly directMassUnapplied: boolean;
  readonly reviewOutcome: string | null;
  readonly selectedFdcId: number | null;
  readonly selectedCompatible: boolean | null;
  readonly alternateCompatible: boolean | null;
  readonly container: string | null;
  readonly packageNetMass: number | null;
  /**
   * AI-6A-R3: the authored line offers `X or Y`. This is UNGATED on `resolved`,
   * because the point is precisely that a pipeline `matched` result must NOT
   * launder a collapsed authored choice into a safe success.
   */
  readonly hasAlternative: boolean;
  readonly qualitative: boolean;
  readonly catalogProbeTotal: number;
  readonly countNounClass: Ai6aCountNounClass;
  /**
   * AI-6A-R1: whether the authored parse carries a bounded quantity a portion
   * authority could actually consume. ALL portion evidence is withheld when this
   * is false, so an amount-less line can never be reported as a portion defect.
   */
  readonly portionResolvable: boolean;
}

/**
 * Assigns EXACTLY ONE primary blocker using the documented safety-first
 * precedence. Three rules dominate everything else:
 *
 *   1. A verified-unsafe automatic identity ALWAYS wins, even over a line that
 *      otherwise resolved. A wrong food is worse than a missing amount.
 *   2. A UI terminal state is NEVER a blocker; only the closed root-cause
 *      vocabulary is.
 *   3. AI-6A-R2 ROOT-CAUSE RULE. An amount with no bounded authority, and an
 *      authored `X or Y` choice, are CAUSES. `identity_needs_review` is an
 *      ORDINARY SYMPTOM: on such a line a better-bound candidate would still not
 *      produce truthful grams, so the symptom must not outrank its own cause.
 *      `identity_unmatched` (no identity surfaced at all) and both safety ranks
 *      are deliberately left ABOVE the amount/ambiguity causes.
 *
 * AI-6A-R3: the success sentinel is CONDITIONAL, and is therefore computed LAST.
 * `none_resolved` records "nothing is wrong". It may only be recorded when NO
 * competing diagnostic failure exists, so a production `matched` can never hide
 * an unresolved authored alternative. This is what stops
 * `1 cup all-purpose or bread flour` from being credited as a safe success for
 * the 125 g it resolved to by silently choosing all-purpose over bread flour.
 *
 * The RAW production result is NOT falsified: `resolved`, `massSource` and the
 * live `terminal` still describe exactly what the pipeline did. Only the
 * DIAGNOSTIC verdict changes.
 */
export function classifyPrimaryBlocker(input: PrecedenceInput): Ai6aPrimaryBlocker {
  // Rule 1: unsafe automatic identity outranks everything, including success.
  if (input.correctness === 'verified_unsafe') return 'unsafe_auto_identity';

  const evidence = new Set<Ai6aPrimaryBlocker>();

  if (!input.parsedOk) evidence.add('parse_failed');
  if (!input.resolved && input.quantityKind === 'range') {
    // AI-6A-R2 Issue 4: PARSE GAP vs POLICY GAP are different concepts and must
    // never be reported as one.
    if (input.rangeEndpointsRepresented) evidence.add('measurement_policy_gap');
    else evidence.add('measurement_parse_gap');
  }
  if (!input.resolved && input.directMassUnapplied) {
    // The mass parsed into grams and an identity was bound; the gap is that no
    // authorized policy CONSUMED a correctly-represented measurement.
    evidence.add('measurement_policy_gap');
  }
  if (!input.resolved && (input.reviewOutcome === 'unmatched' || input.reviewOutcome === 'invalid')) {
    // The pipeline surfaced no identity at all. Whether the CAUSE is the matcher
    // or the catalog is decided by the bounded catalog probe below.
    if (input.catalogProbeTotal > 0) evidence.add('identity_unmatched');
    else evidence.add('catalog_or_specificity_gap');
  }
  if (
    !input.resolved &&
    input.reviewOutcome === 'review_required' &&
    input.selectedFdcId === null
  ) {
    evidence.add('identity_needs_review');
  }
  if (
    !input.resolved &&
    input.portionResolvable &&
    input.selectedFdcId !== null &&
    input.alternateCompatible === true &&
    input.selectedCompatible === false
  ) {
    // Requires NAMED candidate evidence: a DIFFERENT record in the bounded set
    // would have carried a compatible portion.
    evidence.add('compatible_candidate_not_selected');
  }
  if (
    !input.resolved &&
    input.portionResolvable &&
    input.selectedFdcId !== null &&
    input.selectedCompatible === true
  ) {
    // The bound record DOES carry a compatible portion, yet no mass came out.
    // That is a different root cause from "the record lacks one", and it is the
    // class a `needs_amount` terminal alone can never reveal.
    evidence.add('compatible_portion_unresolved');
  }
  if (
    !input.resolved &&
    input.portionResolvable &&
    input.selectedFdcId !== null &&
    input.selectedCompatible === false &&
    input.alternateCompatible !== true
  ) {
    if (input.countNounClass === 'none' || isContainerNounClass(input.countNounClass)) {
      evidence.add('selected_record_lacks_source_portion');
    } else if (isHouseholdNounClass(input.countNounClass)) {
      evidence.add('household_portion_absent');
    } else {
      evidence.add('authenticated_count_portion_absent');
    }
  }
  if (
    !input.resolved &&
    input.container !== null &&
    input.packageNetMass === null
  ) {
    evidence.add('container_mass_absent');
  }
  if (
    !input.resolved &&
    input.container !== null &&
    input.packageNetMass !== null
  ) {
    // An existing, intentional boundary: the declared net mass is parsed and
    // preserved but deliberately never converted into mass authority.
    evidence.add('container_net_mass_boundary');
  }
  // AI-6A-R3: DELIBERATELY NOT GATED ON `resolved`. An authored `X or Y` is an
  // unresolved AUTHORITY question whether or not the pipeline returned a match.
  // The engine earned its match by picking one branch, and picking one is
  // exactly the fabrication the authority rule forbids. Gating this on
  // `!resolved` is what let a 125 g match on `all-purpose or bread flour` be
  // recorded as `none_resolved` / `already_resolved`.
  if (input.hasAlternative) evidence.add('alternative_ambiguous');
  if (!input.resolved && input.qualitative) evidence.add('qualitative_or_absent_amount');

  // AI-6A-R3: the success sentinel is recorded ONLY when nothing else is wrong,
  // and only for an authenticated deterministic mass source. It is deliberately
  // the LAST thing added, so it can never short-circuit a real diagnostic cause.
  if (
    evidence.size === 0 &&
    input.resolved &&
    isAuthenticatedMassSource(input.massSource)
  ) {
    evidence.add('none_resolved');
  }

  if (evidence.size === 0) return 'unclassified';

  let best: Ai6aPrimaryBlocker = 'unclassified';
  let bestRank = Number.POSITIVE_INFINITY;
  for (const blocker of evidence) {
    const rank = blockerPrecedenceRank(blocker);
    if (rank < bestRank) {
      best = blocker;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * AI-6A-R3: three DISTINCT resolution axes. They are reported separately because
 * conflating them is what let a collapsed authored choice look like a win.
 *
 *   - RAW MATCHED: the live pipeline returned `matched`. Production fact.
 *   - AUTHENTICATED MASS RESOLVED: the mass SOURCE is an authenticated
 *     deterministic one (USDA portion / household registry / authored mass).
 *     This says NOTHING about whether the authored SEMANTIC FOOD CHOICE was
 *     authorized. A line can have authenticated mass AND an unresolved authored
 *     choice at the same time — `1 cup all-purpose or bread flour` is exactly
 *     that case: an authenticated `source_portion` mass of 125 g for a food the
 *     author never actually chose.
 *   - SAFE RESOLVED: authenticated mass AND no competing diagnostic failure.
 *     This is the only axis that may be called a success.
 */
export const AI6A_RESOLUTION_AXES = Object.freeze({
  raw_matched: 'raw_matched',
  authenticated_mass_resolved: 'authenticated_mass_resolved',
  safe_resolved: 'safe_resolved',
} as const);

export type Ai6aResolutionAxis = (typeof AI6A_RESOLUTION_AXES)[keyof typeof AI6A_RESOLUTION_AXES];

/**
 * AI-6A-R3: is this line a SAFE resolution?
 *
 * Derived from the classifier's own verdict rather than from a constant, so the
 * number can never be hard-coded. It is deliberately NOT the same predicate as
 * `terminal === 'matched'`.
 */
export function isSafeResolution(record: {
  readonly primary_blocker: Ai6aPrimaryBlocker;
  readonly mass_source: Ai6aMassSource;
}): boolean {
  return record.primary_blocker === AI6A_SUCCESS_SENTINEL && record.mass_source !== 'none';
}

/**
 * AI-6A-R2: was ORDINARY IDENTITY REVIEW evidence present on this line, whether
 * or not it won precedence?
 *
 * Recorded so the Issue 2 reordering never SILENTLY discards the identity
 * symptom. `drizzle of olive oil` is now reported by its root cause (an
 * unbounded authored amount) while the fact that identity also needs review
 * stays visible in `secondary_signals`.
 */
export function identityReviewSymptomPresent(input: {
  readonly resolved: boolean;
  readonly reviewOutcome: string | null;
  readonly selectedFdcId: number | null;
}): boolean {
  return (
    !input.resolved &&
    input.reviewOutcome === 'review_required' &&
    input.selectedFdcId === null
  );
}

/**
 * The correctness axis. `verified_correct` / `verified_unsafe` are ONLY ever
 * returned when checked-in corpus knowledge supports the conclusion; anything
 * else is `unverified`. A supplemental line with no checked-in expectation can
 * therefore never be reported as verified, which is the point.
 */
export function classifyIdentityCorrectness(input: {
  readonly selectedFdcId: number | null;
  readonly selectedDescription: string | null;
  readonly expectation: CorpusExpectation | undefined;
}): Ai6aIdentityCorrectness {
  const { selectedFdcId, selectedDescription, expectation } = input;
  if (selectedFdcId === null || expectation === undefined) return 'unverified';

  if (expectation.forbiddenAutoFdcs?.includes(selectedFdcId) === true) {
    return 'verified_unsafe';
  }
  if (
    expectation.forbiddenAutoDescription !== undefined &&
    selectedDescription !== null &&
    expectation.forbiddenAutoDescription.test(selectedDescription)
  ) {
    return 'verified_unsafe';
  }
  // Checked-in knowledge states NO automatic identity may bind here.
  if (expectation.expectNoAutomatic === true) return 'verified_unsafe';
  if (expectation.expectedAutoFdc === selectedFdcId) return 'verified_correct';
  return 'unverified';
}

export interface CorpusExpectation {
  readonly expectedAutoFdc?: number;
  readonly baselineAutoFdc?: number;
  readonly knownIssue?: string;
  readonly forbiddenAutoFdcs?: ReadonlyArray<number>;
  readonly forbiddenAutoDescription?: RegExp;
  readonly expectNoAutomatic?: boolean;
  readonly expectCandidateDescription?: RegExp;
  /** ORDER expectation only: says nothing about whether a record auto-binds. */
  readonly expectTopFdc?: number;
}

function secondarySignalsFor(input: {
  readonly line: string;
  readonly foodQuery: string | null;
  readonly quantityKind: string | null;
  readonly measurementKind: string | null;
  readonly countNounClass: Ai6aCountNounClass;
  readonly container: string | null;
  readonly packageNetMass: number | null;
  readonly amount: number | null;
  readonly hasAlternative: boolean;
  readonly selectedCompatible: boolean | null;
  readonly alternateCompatible: boolean | null;
  readonly candidateCount: number;
  readonly catalogProbeTotal: number;
  /**
   * AI-6A-R2 ISSUE 1 — THE BOUNDED-MEASUREMENT EXCLUSION.
   *
   * Every qualitative/absent signal is derived from this ONE answer, which comes
   * from `boundedAuthoredMeasurement`. The R1 code tested `amount === null`
   * directly, which is NOT the same question: a range carries `amount === null`
   * while its authored endpoints are fully bounded, so 14 correctly-parsed range
   * lines were stamped `has_qualitative_amount` + `has_authored_amount_absent`.
   *
   * Because `qualitativeReason` is `null` for every bounded measurement, a
   * bounded exact MASS, VOLUME or COUNT can no longer acquire an "unmeasurable
   * amount" signal for any reason — including a later identity problem or a
   * package-policy boundary.
   */
  readonly qualitativeReason: Ai6aQualitativeReason | null;
  /** Whether ordinary identity review was evidence, whether or not it won. */
  readonly identityReviewSymptom: boolean;
}): ReadonlyArray<Ai6aSecondarySignal> {
  const line = input.line.toLowerCase();
  const signals: Ai6aSecondarySignal[] = [];
  const add = (signal: Ai6aSecondarySignal): void => {
    if (!signals.includes(signal)) signals.push(signal);
  };

  if (input.measurementKind === 'mass') add('has_explicit_mass');
  if (input.measurementKind === 'volume') add('has_volume');
  if (input.measurementKind === 'count' || input.countNounClass !== 'none') add('has_count');
  if (
    isHouseholdNounClass(input.countNounClass) ||
    /\b(cup|cups|tablespoon|teaspoon|tbsp|tsp|quart|pint|gallon)\b/i.test(line)
  ) {
    add('has_household_word');
  }
  if (SIZE_DESCRIPTOR.test(line)) add('has_size_descriptor');
  if (input.container !== null || CONTAINER_CUE.test(line)) add('has_container');
  if (input.packageNetMass !== null) add('has_package_mass');
  if (input.quantityKind === 'range') add('has_range');
  if (input.hasAlternative || /\bor\b/.test(input.foodQuery ?? line)) add('has_alternative');
  if (PREPARATION_MODIFIER.test(line)) add('has_preparation_modifier');
  if (STATE_MODIFIER.test(line)) add('has_state_modifier');
  if (FORM_MODIFIER.test(line)) add('has_form_modifier');
  // AI-6A-R1: brand detection must not fire on the QUANTITY use of a word that
  // is also a brand token. `a dash of pepper` is a measure; `Mrs. Dash` is a
  // brand. Indefinite-measure phrases are stripped before the token scan so the
  // collision cannot reappear from either direction.
  const brandScan = line.replace(INDEFINITE_MEASURE_PHRASE, ' ');
  if (BRAND_TOKENS.has(brandScan.replace(/[^a-z\s]/g, ' ').trim()) === false) {
    const tokens = brandScan.replace(/[^a-z\s]/g, ' ').split(/\s+/);
    if (tokens.some((token) => BRAND_TOKENS.has(token))) add('has_brand_or_commercial_specificity');
  }
  // AI-6A-R2 ISSUE 1: a BOUNDED authored measurement can never be reported as
  // qualitative or absent. This replaces the R1 `QUALITATIVE_CUE.test(line) ||
  // amount === null` test, which mislabeled every parsed range as an absent
  // amount.
  if (input.qualitativeReason !== null) add('has_qualitative_amount');
  // The two subtype signals are MUTUALLY EXCLUSIVE and mirror
  // `qualitative_reason`, so a line can never claim to be both an intentional
  // cue and an authored gap.
  if (input.qualitativeReason === 'explicit_qualitative_amount') {
    add('has_explicit_qualitative_amount');
  } else if (input.qualitativeReason === 'authored_amount_absent') {
    add('has_authored_amount_absent');
  }
  // AI-6A-R2 Issue 2: the identity symptom stays VISIBLE even when a root cause
  // outranks it, so the reordering never silently discards identity work.
  if (input.identityReviewSymptom) add('identity_review_symptom_present');
  if (NUTRIENT_ANNOTATION.test(input.line)) add('has_nutrient_annotation');

  if (input.selectedCompatible === true) add('selected_candidate_has_compatible_portion');
  if (input.alternateCompatible === true) add('alternate_candidate_has_compatible_portion');
  if (input.candidateCount > 0 || input.catalogProbeTotal > 0) add('plausible_candidate_present');
  else add('no_plausible_candidate_observed');

  return signals;
}

// ---------------------------------------------------------------------------
// The per-line runner
// ---------------------------------------------------------------------------

const MASS_SOURCE_BY_TERMINAL: Readonly<Record<string, Ai6aMassSource>> = {
  direct_mass: 'direct_mass',
  source_portion: 'source_portion',
  count_portion: 'count_portion',
  household_portion: 'household_portion',
};

/** Diagnoses ONE corpus line against the real pipeline. Never throws. */
export function diagnoseLine(
  session: AdvancedNutritionSession,
  entry: Ai6aCorpusLine
): Ai6aDiagnosticRecord {
  const line = entry.line;
  const ingredient = structuredIngredient(line);

  const parseResult = parseIngredient(ingredient);
  const parsedOk = parseResult.ok;
  const p = parsedOk ? parseResult.parsed : null;

  const terminal: Ai6aTerminal = 'unresolved';
  let reviewOutcome: string | null = null;
  let selectedFdcId: number | null = null;
  let selectedDescription: string | null = null;
  let liveStatus: Ai6aTerminal = 'unresolved';
  let massSource: Ai6aMassSource = 'none';
  let resolvedGrams: number | null = null;
  let candidates: ReadonlyArray<Ai6aCandidateView> = [];
  let candidateCount = 0;
  let catalogProbeTotal = 0;
  let selectedCompatible: boolean | null = null;
  let alternateCompatible: boolean | null = null;
  let alternateFdcId: number | null = null;

  if (!parseResult.ok) {
    return Object.freeze({
      line,
      source: entry.source,
      focus: entry.focus,
      families: entry.families,
      parsed_food_query: null,
      quantity_kind: null,
      measurement_kind: null,
      amount: null,
      raw_unit: null,
      count_noun_class: countNounClassFor(undefined, line),
      range: null,
      qualitative_reason: null,
      portion_resolvable_quantity: false,
      container: null,
      package_net_mass: null,
      terminal,
      review_outcome: null,
      selected_fdc_id: null,
      selected_description: null,
      mass_source: 'none',
      resolved_grams: null,
      candidate_count: 0,
      candidates: Object.freeze([]),
      expected_candidate_rank: 'not_applicable',
      auto_outcome: 'no_automatic_identity',
      catalog_probe_total: 0,
      selected_record_portion_compatible: null,
      alternate_candidate_portion_compatible: null,
      alternate_candidate_fdc_id: null,
      identity_correctness: 'unverified',
      primary_blocker: 'parse_failed',
      secondary_signals: secondarySignalsFor({
        line,
        foodQuery: null,
        quantityKind: null,
        measurementKind: null,
        countNounClass: countNounClassFor(undefined, line),
        container: null,
        packageNetMass: null,
        amount: null,
        hasAlternative: false,
        selectedCompatible: null,
        alternateCompatible: null,
        candidateCount: 0,
        catalogProbeTotal: 0,
        // A refused line has no parse, therefore no bounded measurement and no
        // qualitative verdict either: `parse_failed` is the whole truth.
        qualitativeReason: null,
        identityReviewSymptom: false,
      }),
      repair_lane: laneForBlocker('parse_failed'),
    });
  }

  const measurementKind = p.measurement_kind;
  const adaptation = adaptRecipe(recipeFor(line));
  if (!adaptation.ok) {
    return Object.freeze({
      ...baseRecord(entry, p),
      primary_blocker: 'unclassified' as Ai6aPrimaryBlocker,
      secondary_signals: Object.freeze([]),
      repair_lane: laneForBlocker('unclassified'),
    });
  }
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const analysisRow = analysis.rows[0];
  const reviewRow = buildReviewRows(session, adapted)[0];

  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows: buildReviewRows(session, adapted),
    baseServings: 1,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  });
  const calc = session.calculate(buildCalculationRequest(adapted, state));
  const live = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    calc.ok ? ingredientEvidenceViews(calc.preview) : null,
    analysis.portions,
    analysis.countPortions
  )[0];

  liveStatus =
    live.status === 'matched' ||
    live.status === 'needs_amount' ||
    live.status === 'needs_match' ||
    live.status === 'review_suggested' ||
    live.status === 'qualitative'
      ? live.status
      : 'unresolved';
  reviewOutcome = reviewRow?.outcome ?? null;
  selectedFdcId = live.selected_fdc_id ?? null;
  selectedDescription = live.selected_description ?? analysisRow.selected_description ?? null;
  candidateCount = analysisRow.candidates.length;

  const resolved =
    live.status === 'matched' && live.resolved_grams !== undefined && live.mass_source !== undefined;
  if (resolved) {
    massSource = MASS_SOURCE_BY_TERMINAL[live.mass_source as string] ?? 'none';
    resolvedGrams = live.resolved_grams ?? null;
  }

  // Bounded candidate window with real portion evidence per candidate.
  const window = analysisRow.candidates.slice(0, AI6A_CANDIDATE_WINDOW);
  const views: Ai6aCandidateView[] = [];
  for (let index = 0; index < window.length; index += 1) {
    const candidate = window[index];
    const compatible = recordHasCompatiblePortion(
      session,
      ingredient,
      candidate.fdc_id,
      measurementKind
    );
    views.push({
      rank: index + 1,
      fdc_id: candidate.fdc_id,
      description: candidate.description,
      data_type: String(candidate.data_type),
      has_compatible_portion: compatible,
    });
  }
  candidates = views;

  if (selectedFdcId !== null) {
    selectedCompatible = recordHasCompatiblePortion(session, ingredient, selectedFdcId, measurementKind);
    for (const view of views) {
      if (view.fdc_id !== selectedFdcId && view.has_compatible_portion) {
        alternateCompatible = true;
        alternateFdcId = view.fdc_id;
        break;
      }
    }
    if (alternateCompatible === null && !selectedCompatible) alternateCompatible = false;
  }

  // Bounded catalog plausibility probe: is there anything plausible even under
  // simpler core terms? This is the catalog-gap-vs-matcher-failure evidence.
  const probe = coreProbeQuery(p.query);
  if (probe.length > 0) {
    const search = session.searchFoods(probe, AI6A_CANDIDATE_WINDOW);
    catalogProbeTotal = search.ok ? search.total : 0;
  }

  const expectation = entry.identity as CorpusExpectation | undefined;
  const correctness = classifyIdentityCorrectness({
    selectedFdcId,
    selectedDescription,
    expectation,
  });

  const countNounClass = countNounClassFor(p.count_noun, line, {
    amount: p.amount,
    quantityKind: p.quantity_kind,
  });
  // An authored alternative (`X or Y`) stays ambiguous on purpose: collapsing it
  // to one food would be fabrication. AI-6A-R3 requires a STANDALONE `or` word
  // in the parsed food query or the authored line, never a substring match.
  const hasAlternative = hasAuthoredAlternative(p.query, line);
  // AI-6A-R2 TRUTHFULNESS GATE: ONE boundedness authority decides both whether
  // a portion authority could consume the quantity and whether the amount may be
  // called qualitative/absent. There is no second notion of "measurable".
  const quantityRange = p.quantity_range ?? null;
  const boundedMeasurement = boundedAuthoredMeasurement({
    quantityKind: p.quantity_kind,
    amount: p.amount,
    quantityRange,
    rawUnit: p.raw_unit,
  });
  const portionResolvable = portionResolvableQuantity({
    quantityKind: p.quantity_kind,
    amount: p.amount,
    quantityRange,
    rawUnit: p.raw_unit,
  });
  const rangeEndpoints = rangeEndpointsRepresented({
    quantityKind: p.quantity_kind,
    quantityRange,
  });
  // Two diagnostically distinct subtypes of an UNBOUNDED authored amount.
  //
  // This covers BOTH "no quantity at all" (`handful fresh spinach`, `skim milk`)
  // and "a number in front of an INDEFINITE unit" (`1 handful fresh basil`). In
  // the second case the author DID write a quantity — they wrote an indefinite
  // one — so it is an explicit qualitative measure, not an absent amount, and it
  // is still not something a USDA portion can resolve.
  //
  // A container line is excluded from the verdict because its blocker is the
  // policy boundary, not the amount.
  const qualitative = !boundedMeasurement && p.container === undefined;
  const explicitCue = hasExplicitQualitativeCue(line);
  const indefiniteUnit = isIndefiniteMeasureUnit(p.raw_unit);
  // AI-6A-R2: a BOUNDED measurement has `qualitative_reason = null` by
  // construction, so no bounded mass/volume/count can ever acquire an
  // "unmeasurable amount" signal.
  const qualitativeReason: Ai6aQualitativeReason | null = !boundedMeasurement
    ? explicitCue || indefiniteUnit
      ? 'explicit_qualitative_amount'
      : 'authored_amount_absent'
    : null;

  const identitySymptom = identityReviewSymptomPresent({
    resolved,
    reviewOutcome,
    selectedFdcId,
  });

  const blocker = classifyPrimaryBlocker({
    resolved,
    massSource,
    correctness,
    parsedOk: true,
    quantityKind: p.quantity_kind,
    measurementKind,
    rangeEndpointsRepresented: rangeEndpoints,
    directMassUnapplied:
      measurementKind === 'mass' && typeof p.grams === 'number' && selectedFdcId !== null,
    reviewOutcome,
    selectedFdcId,
    selectedCompatible,
    alternateCompatible,
    container: p.container ?? null,
    packageNetMass: p.package_net_mass?.amount ?? null,
    hasAlternative,
    qualitative,
    catalogProbeTotal,
    countNounClass,
    portionResolvable,
  });

  return Object.freeze({
    ...baseRecord(entry, p),
    qualitative_reason: qualitativeReason,
    portion_resolvable_quantity: boundedMeasurement,
    terminal: liveStatus,
    review_outcome: reviewOutcome,
    selected_fdc_id: selectedFdcId,
    selected_description: selectedDescription,
    mass_source: massSource,
    resolved_grams: resolvedGrams,
    candidate_count: candidateCount,
    candidates: Object.freeze(candidates),
    expected_candidate_rank: expectedRankFor(expectation, candidates),
    auto_outcome: autoOutcomeFor(expectation, selectedFdcId, candidates),
    catalog_probe_total: catalogProbeTotal,
    selected_record_portion_compatible: selectedCompatible,
    alternate_candidate_portion_compatible: alternateCompatible,
    alternate_candidate_fdc_id: alternateFdcId,
    identity_correctness: correctness,
    primary_blocker: blocker,
    secondary_signals: secondarySignalsFor({
      line,
      foodQuery: p.query,
      quantityKind: p.quantity_kind,
      measurementKind,
      countNounClass,
      container: p.container ?? null,
      packageNetMass: p.package_net_mass?.amount ?? null,
      amount: p.amount,
      hasAlternative,
      selectedCompatible,
      alternateCompatible,
      candidateCount,
      catalogProbeTotal,
      qualitativeReason,
      identityReviewSymptom: identitySymptom,
    }),
    repair_lane: laneForBlocker(blocker),
  });
}

/**
 * The complete zero-evidence record every diagnostic starts from. Returning the
 * FULL type (rather than a loose partial) means a new diagnostic axis cannot be
 * added without every construction site being forced to state its value.
 */
function baseRecord(
  entry: Ai6aCorpusLine,
  p: ParsedIngredientReview | null
): Ai6aDiagnosticRecord {
  return Object.freeze({
    line: entry.line,
    source: entry.source,
    focus: entry.focus,
    families: entry.families,
    parsed_food_query: p?.query ?? null,
    quantity_kind: p?.quantity_kind ?? null,
    measurement_kind: p?.measurement_kind ?? null,
    amount: p?.amount ?? null,
    raw_unit: p?.raw_unit ?? null,
    count_noun_class: countNounClassFor(p?.count_noun, entry.line, {
      amount: p?.amount ?? null,
      quantityKind: p?.quantity_kind ?? null,
    }),
    range: p?.quantity_range ?? null,
    qualitative_reason: null,
    portion_resolvable_quantity: false,
    container: p?.container ?? null,
    package_net_mass:
      p?.package_net_mass === undefined
        ? null
        : {
            amount: p.package_net_mass.amount,
            unit: String(p.package_net_mass.unit),
            scope: p.package_net_mass.scope,
          },
    terminal: 'unresolved' as Ai6aTerminal,
    review_outcome: null,
    selected_fdc_id: null,
    selected_description: null,
    mass_source: 'none' as Ai6aMassSource,
    resolved_grams: null,
    candidate_count: 0,
    candidates: Object.freeze([]),
    expected_candidate_rank: 'not_applicable' as Ai6aExpectedCandidateRank,
    auto_outcome: 'no_automatic_identity' as Ai6aAutoOutcome,
    catalog_probe_total: 0,
    selected_record_portion_compatible: null,
    alternate_candidate_portion_compatible: null,
    alternate_candidate_fdc_id: null,
    identity_correctness: 'unverified' as Ai6aIdentityCorrectness,
    primary_blocker: 'unclassified',
    secondary_signals: Object.freeze([]),
    repair_lane: laneForBlocker('unclassified'),
  });
}

function expectedRankFor(
  expectation: CorpusExpectation | undefined,
  candidates: ReadonlyArray<Ai6aCandidateView>
): Ai6aExpectedCandidateRank {
  const expected = expectation?.expectedAutoFdc;
  if (expected === undefined) return 'not_applicable';
  const index = candidates.findIndex((candidate) => candidate.fdc_id === expected);
  if (index < 0) return 'absent_from_bounded_candidates';
  const rank = index + 1;
  if (rank === 1) return 'top_1';
  if (rank <= 3) return 'within_top_3';
  if (rank <= AI6A_CANDIDATE_WINDOW) return 'within_top_5';
  return 'absent_from_bounded_candidates';
}

function autoOutcomeFor(
  expectation: CorpusExpectation | undefined,
  selectedFdcId: number | null,
  candidates: ReadonlyArray<Ai6aCandidateView>
): Ai6aAutoOutcome {
  const expected = expectation?.expectedAutoFdc;
  if (expected === undefined) return 'no_expected_candidate_declared';
  if (selectedFdcId === expected) return 'automatic_matches_expected';
  if (selectedFdcId !== null) return 'automatic_differs_from_expected';
  return candidates.some((candidate) => candidate.fdc_id === expected)
    ? 'correct_candidate_present_but_auto_withheld'
    : 'no_automatic_identity';
}

/** Runs the whole corpus. Order-preserving and deterministic. */
export function diagnoseCorpus(
  session: AdvancedNutritionSession,
  corpus: ReadonlyArray<Ai6aCorpusLine>
): ReadonlyArray<Ai6aDiagnosticRecord> {
  return Object.freeze(corpus.map((entry) => diagnoseLine(session, entry)));
}

export { AI6A_COUNT_NOUN_CLASSES };