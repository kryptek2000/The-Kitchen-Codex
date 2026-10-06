/**
 * The Kitchen Codex — Advanced Nutrition AI-6A recon taxonomy.
 *
 * CLOSED vocabularies for the AI-6A intelligence reconnaissance pass. Every
 * diagnostic label this phase can emit is declared here exactly once, so the
 * classification surface is auditable, bounded, and testable.
 *
 * AI-6A is MEASUREMENT ONLY. Nothing in this module is imported by `src/`,
 * `server/`, or `plugin/`, nothing here changes a nutrition truth, and no
 * label here grants authority. `primaryBlocker` is a ROOT-CAUSE label, not a UI
 * terminal state: `needs_amount` / `needs_match` / `review_suggested` /
 * `qualitative` are recorded separately as `terminal` and MUST NOT be used as
 * a primary blocker, because collapsing every failure into those would hide the
 * layer that actually needs work.
 */

/** Canonical schema identifier written into the AI-6A JSON report. */
export const AI6A_RECON_SCHEMA = 'nutrition_ai6a_intelligence_recon_v1';

/** Bundled release this recon measures. */
export const AI6A_RECON_TOOL = 'benchmark_nutrition_intelligence';

// ---------------------------------------------------------------------------
// Terminal states (the EXISTING UI vocabulary — recorded, never a blocker)
// ---------------------------------------------------------------------------

/**
 * The live Phase 4 projection's terminal state for one row. These are the
 * statuses a user sees today. They are the OUTCOME of the pipeline, not the
 * cause of a failure, so they are recorded next to `primaryBlocker` rather
 * than standing in for it.
 */
export const AI6A_TERMINALS = [
  'matched',
  'needs_amount',
  'needs_match',
  'review_suggested',
  'qualitative',
  'unresolved',
] as const;

export type Ai6aTerminal = (typeof AI6A_TERMINALS)[number];

// ---------------------------------------------------------------------------
// Authenticated mass sources (deterministic only)
// ---------------------------------------------------------------------------

/**
 * Authenticated deterministic mass authority. There is deliberately NO
 * `estimate` member: an AI-3 bounded estimate is estimate-class and must never
 * be counted as authenticated mass (AI-3 INVARIANCE), so it can never reach
 * this vocabulary in the first place.
 */
export const AI6A_MASS_SOURCES = [
  'direct_mass',
  'source_portion',
  'count_portion',
  'household_portion',
  'none',
] as const;

export type Ai6aMassSource = (typeof AI6A_MASS_SOURCES)[number];

/** Mass sources that constitute authenticated (non-estimate) mass authority. */
export const AUTHENTICATED_MASS_SOURCES: ReadonlyArray<Ai6aMassSource> = Object.freeze([
  'direct_mass',
  'source_portion',
  'count_portion',
  'household_portion',
]);

export function isAuthenticatedMassSource(source: Ai6aMassSource): boolean {
  return source !== 'none';
}

// ---------------------------------------------------------------------------
// Identity correctness axis
// ---------------------------------------------------------------------------

/**
 * The correctness axis is INDEPENDENT of the terminal state. An
 * automatically-resolved line whose identity violates a checked-in identity
 * expectation is more important than an unresolved line, so this axis is
 * reported separately and prominently.
 */
export const AI6A_IDENTITY_CORRECTNESS = [
  /** Checked-in corpus knowledge positively supports the bound identity. */
  'verified_correct',
  /** Checked-in corpus knowledge positively forbids the bound identity. */
  'verified_unsafe',
  /** No checked-in knowledge either way. Correctness is NOT invented. */
  'unverified',
] as const;

export type Ai6aIdentityCorrectness = (typeof AI6A_IDENTITY_CORRECTNESS)[number];

// ---------------------------------------------------------------------------
// Primary blocker taxonomy (CLOSED)
// ---------------------------------------------------------------------------

/**
 * CLOSED root-cause vocabulary. Ordered EXACTLY as `BLOCKER_PRECEDENCE`, most
 * dangerous first. The declaration order and the precedence order are asserted to
 * be IDENTICAL by test, because a declaration order that only *claims* to match
 * the precedence ladder is a documentation lie waiting to happen.
 *
 * The critical distinction this vocabulary exists to force: `needs_amount` and
 * `needs_match` are UI terminal states, not root causes. "1 tbsp butter has no
 * mass" and "the catalog has no branded ranch blend" and "a compatible USDA
 * duplicate existed but ranking picked the wrong record" are three DIFFERENT
 * problems with three different owners.
 *
 * EXACT ACCOUNTING (pinned by test): **18 total values = 1 success sentinel
 * (`none_resolved`) + 17 failure blockers.** Do not describe this as "17
 * blockers" without the sentinel arithmetic. AI-6A-R2 added
 * `measurement_policy_gap` (see below), taking the total 17 -> 18.
 *
 * AI-6A-R1 TRUTHFULNESS RULE: a portion blocker may only be used when the
 * authored parse carries a genuine bounded quantity that a portion authority
 * could actually consume (see `boundedAuthoredMeasurement`). "A perfect USDA
 * portion" cannot truthfully resolve `handful fresh spinach` or an
 * amount-less `skim milk`, so those are amount causes, not portion defects.
 *
 * AI-6A-R2 BOUNDED-MEASUREMENT EXCLUSION RULE: a line whose authored
 * measurement IS bounded can NEVER acquire a qualitative/absent signal, for any
 * reason whatsoever — not because a later identity problem exists, and not
 * because a policy boundary exists. `8 oz spaghetti`, `2 tbsp butter`,
 * `1 cup milk`, `3 cloves garlic` and `1 whole chicken` all have an exact
 * authored scalar with a real or implicit unit, so all five carry
 * `qualitative_reason: null` and no qualitative/absent secondary signal. Only
 * `boundedAuthoredMeasurement` decides this, and every qualitative signal is
 * derived from its answer rather than from a second, independent test.
 */
export const AI6A_PRIMARY_BLOCKERS = [
  /** Nothing is wrong: the line resolved with authenticated deterministic mass. */
  'none_resolved',
  /** The engine bound an identity that checked-in knowledge positively forbids. */
  'unsafe_auto_identity',
  /** The frozen deterministic parser refused the authored text outright. */
  'parse_failed',
  /**
   * The authored measurement was NOT REPRESENTED CORRECTLY by deterministic
   * parsing. AI-6A-R2 narrowed this definition: it is only a defect in how the
   * measurement was captured, never a statement about whether anything
   * downstream CONSUMES a correctly-captured measurement.
   */
  'measurement_parse_gap',
  /**
   * The measurement WAS represented correctly, but no AUTHORIZED deterministic
   * policy consumes it. AI-6A-R2 split this out of `measurement_parse_gap`:
   * `1-2 tbsp olive oil` has both endpoints parsed truthfully, so calling it a
   * PARSE failure is false, and routing it to an AI-interpretation lane implies
   * a semantic interpretation that is not needed merely to know the endpoints.
   */
  'measurement_policy_gap',
  /** No plausible identity was surfaced for the parsed food query. */
  'identity_unmatched',
  /**
   * Intentional conservative wording (`to taste`) OR a genuinely unbounded
   * authored amount. The two subtypes are distinguished by `qualitative_reason`.
   *
   * AI-6A-R2 raised this ABOVE every ordinary identity symptom. For a genuinely
   * unbounded authored amount, repairing identity alone still cannot produce
   * truthful grams, so `identity_needs_review` must not hide it. It stays BELOW
   * `identity_unmatched`, which is our own matcher failing rather than a
   * characteristic of what the author wrote.
   */
  'qualitative_or_absent_amount',
  /**
   * The authored line offers alternatives; choosing one would manufacture
   * authored intent. AI-6A-R2 raised this ABOVE ordinary identity review for
   * the same root-cause reason: if picking a single food is fabrication, then
   * "no food was auto-bound" is a symptom of the authored ambiguity, not an
   * independent identity defect.
   */
  'alternative_ambiguous',
  /** Candidates exist, but none is eligible for automatic binding. */
  'identity_needs_review',
  /**
   * The line DECLARES a package net mass that the pipeline deliberately refuses
   * to convert into authority. This is an explicit POLICY BOUNDARY and is a
   * CAUSE, not a symptom, so AI-6A-R1 moved it above every portion symptom: a
   * generic "selected record has no source portion" must never hide the fact
   * that policy itself declined to promote the declared net mass.
   *
   * It stays BELOW identity review on purpose. On `1 can (400 g) diced tomatoes`
   * no identity binds at all, so the boundary is latent rather than causal and
   * the identity failure is the honest root cause.
   */
  'container_net_mass_boundary',
  /**
   * A DIFFERENT candidate in the bounded candidate set would have carried a
   * compatible portion, and the automatically chosen one did not. Always
   * requires named candidate evidence.
   */
  'compatible_candidate_not_selected',
  /**
   * The bound record DOES carry a portion compatible with the authored
   * measurement, yet no mass was produced. Distinct from "lacks a portion":
   * here the authority is present and something downstream still withheld it.
   */
  'compatible_portion_unresolved',
  /** The bound record has no portion compatible with the authored measure. */
  'selected_record_lacks_source_portion',
  /** A count noun is present but the bound record carries no count portion. */
  'authenticated_count_portion_absent',
  /** A household measure is present but no authenticated household mapping exists. */
  'household_portion_absent',
  /** A container/package noun carries no mass authority at all. */
  'container_mass_absent',
  /**
   * No plausible candidate was available within a bounded deterministic search
   * AND the corpus names no expected candidate. For branded/commercial wording
   * this is the honest, expected measurement.
   */
  'catalog_or_specificity_gap',
  /** A real failure that no closed label above describes. Always a finding. */
  'unclassified',
] as const;

export type Ai6aPrimaryBlocker = (typeof AI6A_PRIMARY_BLOCKERS)[number];

/**
 * Deterministic blocker precedence, safety-first. The classifier assigns the
 * FIRST label whose evidence is present, so a low-level amount problem can
 * never hide an unsafe identity and a UI terminal can never override a root
 * cause.
 *
 * AI-6A-R1 ORDERING PRINCIPLE — ROOT CAUSE, NOT FIRST AVAILABLE SYMPTOM.
 * The primary blocker answers "what must change for this line to become
 * truthfully resolvable?", so an explicit POLICY or AUTHORED-INPUT cause is
 * ranked above a generic downstream symptom.
 *
 * AI-6A-R2 RE-EVALUATION OF THAT PRINCIPLE AGAINST THE ROOT-CAUSE QUESTION.
 * R1 left ordinary identity review at rank 5, above `qualitative_or_absent_amount`
 * (rank 7) and above `alternative_ambiguous` (rank 14). That was internally
 * consistent but semantically WRONG, and it is the defect R2 repairs: for
 * `drizzle of olive oil` or `2 tbsp butter or margarine`, repairing identity
 * alone still cannot produce a truthful gram value, because the AMOUNT is what
 * lacks bounded authority (or the authored line offers a choice that only the
 * author may make). A symptom therefore outranked its own root cause, which
 * hid 10 genuinely unresolvable amounts inside a 38-line identity bucket.
 *
* The R2 ladder, in order:
 *
 *   0  `unsafe_auto_identity`            SAFETY, unoverrideable.
 *   1  `parse_failed`                    SAFETY: malformed source, nothing to reason about.
 *   2  `measurement_parse_gap`           the measurement itself was mis-captured.
 *   3  `measurement_policy_gap`          captured correctly, no authorized policy consumes it.
 *   4  `identity_unmatched`              OUR defect: nothing surfaced, catalog has candidates.
 *   5  `qualitative_or_absent_amount`    ROOT CAUSE: the amount has no bounded authority.
 *   6  `alternative_ambiguous`           ROOT CAUSE: choosing would manufacture intent.
 *   7  `identity_needs_review`           ORDINARY identity symptom — a nudge, not a cause.
 *   8  `container_net_mass_boundary`     POLICY: a declared net mass was deliberately declined.
 *   9-13 portion symptoms                 the authority is simply missing downstream.
 *   14 `container_mass_absent`
 *   15 `catalog_or_specificity_gap`
 *   16 `unclassified`
 *
 * WHY `identity_unmatched` SITS ABOVE THE AMOUNT CAUSES. It is the one identity
 * label that is not an "ordinary" symptom: the pipeline surfaced NO identity at
 * all while a bounded probe proved plausible records EXIST. That is a defect in
 * our own deterministic matcher, not a characteristic of what the author wrote,
 * and naming our own defect first is both more actionable and more honest. An
 * authored amount that is absent can never be repaired by us at all.
 *
 * IDENTITY SAFETY IS NOT WEAKENED. `unsafe_auto_identity` (0) and `parse_failed`
 * (1) remain above everything, and `identity_unmatched` (4) remains above the
 * amount/ambiguity causes at (5)/(6). Only the ORDINARY `identity_needs_review`
 * symptom (7) moved below them, which is precisely the case where a better-bound
 * candidate would not have produced grams anyway. Every reordering stays
 * separately recorded by the bounded secondary signal
 * `identity_review_symptom_present`, so nothing is hidden.
 */
export const BLOCKER_PRECEDENCE: ReadonlyArray<Ai6aPrimaryBlocker> = Object.freeze([
  'unsafe_auto_identity',
  'parse_failed',
  'measurement_parse_gap',
  'measurement_policy_gap',
  'identity_unmatched',
  'qualitative_or_absent_amount',
  'alternative_ambiguous',
  'identity_needs_review',
  'container_net_mass_boundary',
  'compatible_candidate_not_selected',
  'compatible_portion_unresolved',
  'selected_record_lacks_source_portion',
  'authenticated_count_portion_absent',
  'household_portion_absent',
  'container_mass_absent',
  'catalog_or_specificity_gap',
  'unclassified',
]);

/** The single success sentinel. Every other declared blocker is a FAILURE. */
export const AI6A_SUCCESS_SENTINEL = 'none_resolved' as const;

export type Ai6aFailureBlocker = Exclude<Ai6aPrimaryBlocker, typeof AI6A_SUCCESS_SENTINEL>;

/** EXACT accounting: 17 declared values = 1 success sentinel + 16 failures. */
export const AI6A_FAILURE_BLOCKERS: ReadonlyArray<Ai6aFailureBlocker> = Object.freeze(
  AI6A_PRIMARY_BLOCKERS.filter(
    (blocker): blocker is Ai6aFailureBlocker => blocker !== AI6A_SUCCESS_SENTINEL
  )
);

export const AI6A_BLOCKER_TOTAL = AI6A_PRIMARY_BLOCKERS.length;
export const AI6A_FAILURE_BLOCKER_TOTAL = AI6A_FAILURE_BLOCKERS.length;

/**
 * INDEFINITE measure units. A digit in front of one of these is still not a
 * measurable quantity: "1 handful" is not one countable thing, and "1 dash" is
 * not a dash-sized volume that any USDA portion could convert.
 *
 * Read from the PARSE's own extracted `raw_unit`, not from a text scan, so the
 * decision rests on observed parser output.
 */
export const AI6A_INDEFINITE_MEASURE_UNITS: ReadonlySet<string> = new Set([
  'handful',
  'handfuls',
  'pinch',
  'pinches',
  'dash',
  'dashes',
  'drizzle',
  'splash',
  'sprinkle',
  'sprinkles',
  'drop',
  'drops',
  'smidgen',
  'splash',
]);

/** True when the parse's extracted unit is an INDEFINITE measure (`handful`, `dash`, ...). */
export function isIndefiniteMeasureUnit(rawUnit: string | undefined): boolean {
  if (rawUnit === undefined) return false;
  return AI6A_INDEFINITE_MEASURE_UNITS.has(rawUnit.toLowerCase());
}

/**
 * AI-6A-R2: did the authored parse carry a BOUNDED quantity?
 *
 * This is the SINGLE boundedness authority for the whole recon. AI-6A-R1 had
 * TWO independent notions of "is this amount measurable" — `portionResolvableQuantity`
 * for the blocker and a raw `amount === null` test inside the secondary-signal
 * builder — and they disagreed. That divergence is exactly the R2 Issue 1 defect:
 * a range (`2-3 cloves garlic`) has `amount === null` because the scalar is
 * absent while the AUTHORED ENDPOINTS ARE BOUNDED, so the secondary-signal test
 * stamped `has_qualitative_amount` + `has_authored_amount_absent` onto 14 lines
 * whose measurement is fully and truthfully parsed. Every qualitative signal is
 * now derived from this one answer.
 *
 * A quantity is BOUNDED when the author wrote a number that some authorized
 * deterministic authority could act on:
 *
 *   1. A RANGE with both endpoints parsed and finite. The author DID write
 *      bounded endpoints; the failure there is that no policy consumes them
 *      (`measurement_policy_gap`), never that the quantity is missing.
 *   2. An EXACT scalar with a unit that is NOT an indefinite measure.
 *
 * It is NOT bounded when:
 *
 *   - `quantity_kind` is `absent` (`handful fresh spinach`, `skim milk`,
 *     `fresh parsley, chopped`) — there is no number at all;
 *   - the scalar is missing or non-finite;
 *   - the unit is INDEFINITE (`1 handful`, `1 dash`). The author wrote a number,
 *     but it is not a measurable amount.
 *
 * NOTE: `measurement_kind: 'unknown'` is deliberately NOT disqualifying. An
 * explicit amount with no unit token (`2 carrots, sliced`, `1 large white
 * onion`) is a genuine implicit COUNT, and a USDA count portion is exactly the
 * right authority for it.
 */
export function boundedAuthoredMeasurement(input: {
  readonly quantityKind: string | null;
  readonly amount: number | null;
  readonly quantityRange?: { readonly lower: number; readonly upper: number } | null;
  readonly rawUnit?: string | undefined;
}): boolean {
  if (input.quantityKind === 'range') {
    const range = input.quantityRange;
    if (range === undefined || range === null) return false;
    return Number.isFinite(range.lower) && Number.isFinite(range.upper);
  }
  if (input.quantityKind !== 'exact') return false;
  if (input.amount === null || !Number.isFinite(input.amount)) return false;
  if (isIndefiniteMeasureUnit(input.rawUnit)) return false;
  return true;
}

/**
 * Did the parse represent the authored measurement FAITHFULLY?
 *
 * AI-6A-R2: a range is only well-represented when BOTH endpoints were actually
 * extracted as finite numbers. `quantity_kind: 'range'` alone is not enough — a
 * range whose endpoints the parser dropped is a genuine `measurement_parse_gap`.
 * On the current corpus every range parses, so this is defensive, but it is what
 * keeps `measurement_parse_gap` and `measurement_policy_gap` honest instead of
 * collapsing them back into one concept.
 */
export function rangeEndpointsRepresented(input: {
  readonly quantityKind: string | null;
  readonly quantityRange?: { readonly lower: number; readonly upper: number } | null;
}): boolean {
  if (input.quantityKind !== 'range') return false;
  const range = input.quantityRange;
  if (range === undefined || range === null) return false;
  return Number.isFinite(range.lower) && Number.isFinite(range.upper);
}

/**
 * AI-6A-R2: the portion-authority resolvability gate, now DELEGATING to the
 * single boundedness authority above. There is deliberately no second notion of
 * "measurable" anywhere in the recon.
 */
export function portionResolvableQuantity(input: {
  readonly quantityKind: string | null;
  readonly amount: number | null;
  readonly quantityRange?: { readonly lower: number; readonly upper: number } | null;
  readonly rawUnit?: string | undefined;
}): boolean {
  return boundedAuthoredMeasurement(input);
}

/**
 * AI-6A-R2: the portion blockers, named as a CLOSED set.
 *
 * These are the blockers whose remedy is portion authority, so they are the only
 * ones that count toward the ACTIONABLE portion metric. They are distinct from
 * the RAW compatibility observation (`selected_record_portion_compatible ===
 * false`), which is a probe result and not a root cause — see `AI6A_PORTION_METRIC`
 * below.
 */
export const AI6A_PORTION_BLOCKERS: ReadonlySet<Ai6aPrimaryBlocker> = new Set([
  'compatible_candidate_not_selected',
  'compatible_portion_unresolved',
  'selected_record_lacks_source_portion',
  'authenticated_count_portion_absent',
  'household_portion_absent',
]);

/**
 * AI-6A-R2: the two portion metrics, defined because R1 conflated them.
 *
 *   - RAW OBSERVATION: the selected record has no portion compatible with the
 *     authored measurement, under the current bounded probe. Useful as a
 *     compatibility signal. NOT a roadmap input: a line whose real blocker is
 *     identity, policy, or authored ambiguity can also show an incompatible
 *     record without the missing portion being what prevents resolution.
 *   - ACTIONABLE BLOCKER: a BOUNDED authored quantity exists AND the missing
 *     portion is genuinely the primary blocker. This is the roadmap input.
 *
 * The R1 report quoted the raw number (59) next to the actionable lane (37),
 * which is exactly how a reader concludes that 59 lines need portion work.
 */
export const AI6A_PORTION_METRIC = Object.freeze({
  raw: 'raw_selected_record_portion_incompatible',
  actionable: 'actionable_portion_blocker',
} as const);

/**
 * The two diagnostically distinct subtypes of a missing resolvable amount.
 * Both lack a bounded quantity, but they are different USER problems: an
 * intentional cue is correct behavior, while an absent amount is an authored gap.
 */
export const AI6A_QUALITATIVE_REASONS = [
  'explicit_qualitative_amount',
  'authored_amount_absent',
] as const;

export type Ai6aQualitativeReason = (typeof AI6A_QUALITATIVE_REASONS)[number];

const PRECEDENCE_INDEX: ReadonlyMap<Ai6aPrimaryBlocker, number> = new Map(
  BLOCKER_PRECEDENCE.map((blocker, index) => [blocker, index])
);

/**
 * Every declared blocker, including the `none_resolved` success short-circuit,
 * which is deliberately OUTSIDE the failure precedence ladder. Membership and
 * precedence are separate questions, so both are declared independently.
 */
const BLOCKER_MEMBERSHIP: ReadonlySet<string> = new Set(AI6A_PRIMARY_BLOCKERS);

/** The precedence rank of a blocker. Lower rank wins. Never throws. */
export function blockerPrecedenceRank(blocker: Ai6aPrimaryBlocker): number {
  return PRECEDENCE_INDEX.get(blocker) ?? BLOCKER_PRECEDENCE.length;
}

/** True when `blocker` is part of the closed vocabulary. */
export function isAi6aPrimaryBlocker(value: unknown): value is Ai6aPrimaryBlocker {
  return typeof value === 'string' && BLOCKER_MEMBERSHIP.has(value);
}

// ---------------------------------------------------------------------------
// Secondary signals (CLOSED, bounded, non-authoritative)
// ---------------------------------------------------------------------------

/**
 * Bounded closed set of contributing factors. These are DIAGNOSTICS ONLY: they
 * never become runtime behavior and never authorize anything.
 */
export const AI6A_SECONDARY_SIGNALS = [
  'has_explicit_mass',
  'has_volume',
  'has_count',
  'has_household_word',
  'has_size_descriptor',
  'has_container',
  'has_package_mass',
  'has_range',
  'has_alternative',
  'has_preparation_modifier',
  'has_state_modifier',
  'has_form_modifier',
  'has_brand_or_commercial_specificity',
  'has_qualitative_amount',
  'has_explicit_qualitative_amount',
  'has_authored_amount_absent',
  /**
   * AI-6A-R2. Identity evidence WAS present but lost precedence to a root cause
   * (an unresolvable authored amount, an authored `X or Y` choice, or a
   * measurement policy boundary). Recorded so the Issue 2 reordering never
   * SILENTLY discards the identity symptom: the line is reported by its root
   * cause while the identity work stays visible.
   */
  'identity_review_symptom_present',
  'has_nutrient_annotation',
  'selected_candidate_has_compatible_portion',
  'alternate_candidate_has_compatible_portion',
  'plausible_candidate_present',
  'no_plausible_candidate_observed',
] as const;

export type Ai6aSecondarySignal = (typeof AI6A_SECONDARY_SIGNALS)[number];

const SECONDARY_SET: ReadonlySet<string> = new Set(AI6A_SECONDARY_SIGNALS);

export function isAi6aSecondarySignal(value: unknown): value is Ai6aSecondarySignal {
  return typeof value === 'string' && SECONDARY_SET.has(value);
}

// ---------------------------------------------------------------------------
// Repair lanes (CLOSED, PLANNING ONLY)
// ---------------------------------------------------------------------------

/**
 * Where a follow-up phase should INVESTIGATE. A lane is a routing label, not a
 * fix and not a permission:
 *
 *   - `ai_semantic_interpretation` means "semantic interpretation may be worth
 *     evaluating". It does NOT mean AI may choose FDC identity.
 *   - `ai_bounded_mass_estimation` means "this may be a legitimate AI-3-style
 *     estimate candidate". It does NOT mean the estimate auto-applies.
 *
 * No lane grants authority, and no lane is implemented by AI-6A.
 */
export const AI6A_REPAIR_LANES = [
  'already_resolved',
  'deterministic_parser',
  'deterministic_identity',
  'deterministic_ranking',
  'deterministic_portion',
  'catalog_gap',
  'ai_semantic_interpretation',
  'ai_bounded_mass_estimation',
  'intentional_human_review',
  'needs_recon',
] as const;

export type Ai6aRepairLane = (typeof AI6A_REPAIR_LANES)[number];

const LANE_SET: ReadonlySet<string> = new Set(AI6A_REPAIR_LANES);

export function isAi6aRepairLane(value: unknown): value is Ai6aRepairLane {
  return typeof value === 'string' && LANE_SET.has(value);
}

/**
 * The ONLY blocker -> lane routing table. Adding a blocker without adding its
 * lane is a type error by construction, which keeps the two vocabularies from
 * drifting apart.
 *
 * AI-6A-R2 LANE CORRECTIONS (two lanes were conceptually wrong, and being
 * conceptually wrong here is what mis-routes a roadmap):
 *
 *   - `container_net_mass_boundary` USED TO route to
 *     `ai_bounded_mass_estimation`. That was wrong. `1 (15 oz) can tomato sauce`
 *     already contains AUTHORED mass information; the issue is not "AI should
 *     estimate the mass", it is "current authority policy intentionally does not
 *     promote declared package net mass into ingredient mass". Routing it to an
 *     AI-estimation lane told the roadmap to have AI fill in a number the author
 *     already wrote. It now routes to `needs_recon`, which truthfully means a
 *     SEPARATE AUTHORITY/POLICY DECISION IS REQUIRED. AI-6A still authorizes
 *     nothing; it only names the decision.
 *
 *   - `measurement_parse_gap` USED TO route to `ai_semantic_interpretation`. A
 *     mis-captured measurement is a deterministic parser defect, so it routes to
 *     `deterministic_parser`. `measurement_policy_gap` — correctly-captured
 *     measurement with no consuming policy — routes to `needs_recon`, because no
 *     semantic interpretation is needed merely to know the authored endpoints
 *     and AI-6A must not implement midpoint/average/range consumption.
 */
export const BLOCKER_TO_LANE: Readonly<Record<Ai6aPrimaryBlocker, Ai6aRepairLane>> =
  Object.freeze({
    none_resolved: 'already_resolved',
    unsafe_auto_identity: 'deterministic_identity',
    parse_failed: 'deterministic_parser',
    measurement_parse_gap: 'deterministic_parser',
    measurement_policy_gap: 'needs_recon',
    qualitative_or_absent_amount: 'intentional_human_review',
    alternative_ambiguous: 'intentional_human_review',
    identity_unmatched: 'deterministic_identity',
    identity_needs_review: 'deterministic_identity',
    container_net_mass_boundary: 'needs_recon',
    compatible_candidate_not_selected: 'deterministic_ranking',
    compatible_portion_unresolved: 'deterministic_portion',
    selected_record_lacks_source_portion: 'deterministic_portion',
    authenticated_count_portion_absent: 'deterministic_portion',
    household_portion_absent: 'deterministic_portion',
    container_mass_absent: 'catalog_gap',
    catalog_or_specificity_gap: 'catalog_gap',
    unclassified: 'needs_recon',
  });

export function laneForBlocker(blocker: Ai6aPrimaryBlocker): Ai6aRepairLane {
  return BLOCKER_TO_LANE[blocker];
}

// ---------------------------------------------------------------------------
// AI-6B roadmap criteria (DECLARED JUDGMENTS, ordered, bounded)
// ---------------------------------------------------------------------------

/**
 * The ranking criteria, in the order the mission fixes them. The order is
 * LEXICOGRAPHIC: the first criterion on which two candidates differ decides
 * between them, so `frequency` — the LAST criterion — can never promote a merely
 * large bucket over a safer, more tractable one.
 */
export const AI6A_ROADMAP_CRITERIA = [
  'safety',
  'ordinary_user_impact',
  'generalizability',
  'tractability',
  'frequency',
] as const;

export type Ai6aRoadmapCriterion = (typeof AI6A_ROADMAP_CRITERIA)[number];

/**
 * A bounded 1-5 judgment per NON-frequency criterion, plus the reason the score
 * is what it is. Frequency is deliberately absent: it is MEASURED from the
 * root-cause distribution at report time, never asserted here.
 *
 * These are DECLARED, REVIEWABLE JUDGMENTS — the same kind of artifact as
 * `BRAND_TOKENS` or `AI6A_INDEFINITE_MEASURE_UNITS` — not a hard-coded winner.
 * The winner is COMPUTED by `roadmapRanking` from these scores plus the measured
 * root-cause counts, so changing the measurement changes the recommendation and
 * no lane name is ever named as "the target" in code.
 */
export const AI6A_LANE_CRITERION_SCORES: Readonly<
  Record<Exclude<Ai6aRepairLane, 'already_resolved'>, Readonly<Record<Ai6aRoadmapCriterion, number>>>
> = Object.freeze({
  deterministic_portion: Object.freeze({
    safety: 5,
    ordinary_user_impact: 5,
    generalizability: 5,
    tractability: 5,
    frequency: 0,
  }),
  deterministic_identity: Object.freeze({
    // The Phase 0A history shows this surface already caused a real safety
    // defect (`sardines in tomato sauce` binding tomato sauce), and the
    // measurement shows it is not one problem but several, only some of which
    // are tractable as a single lane.
    safety: 2,
    ordinary_user_impact: 4,
    generalizability: 3,
    tractability: 2,
    frequency: 0,
  }),
  deterministic_ranking: Object.freeze({
    safety: 3,
    ordinary_user_impact: 4,
    generalizability: 4,
    tractability: 4,
    frequency: 0,
  }),
  deterministic_parser: Object.freeze({
    safety: 5,
    ordinary_user_impact: 2,
    generalizability: 4,
    tractability: 5,
    frequency: 0,
  }),
  catalog_gap: Object.freeze({
    // Mostly not ours to fix: `breadcrumbs` is genuinely absent from the pinned
    // catalog, and branded products must not be forced onto generic records.
    safety: 3,
    ordinary_user_impact: 2,
    generalizability: 2,
    tractability: 1,
    frequency: 0,
  }),
  intentional_human_review: Object.freeze({
    // Correct behavior. A phase that "fixed" these would manufacture quantity
    // authority, so it must never be ranked as a target.
    safety: 5,
    ordinary_user_impact: 1,
    generalizability: 1,
    tractability: 1,
    frequency: 0,
  }),
  needs_recon: Object.freeze({
    // A separate authority/policy DECISION, not a defect to repair.
    safety: 5,
    ordinary_user_impact: 2,
    generalizability: 1,
    tractability: 1,
    frequency: 0,
  }),
  ai_semantic_interpretation: Object.freeze({
    safety: 2,
    ordinary_user_impact: 3,
    generalizability: 3,
    tractability: 2,
    frequency: 0,
  }),
  ai_bounded_mass_estimation: Object.freeze({
    safety: 1,
    ordinary_user_impact: 2,
    generalizability: 2,
    tractability: 2,
    frequency: 0,
  }),
});

/** The AI-3 invariant, restated as a guard on the ranking itself. */
export const AI6A_NEVER_TARGET_LANES: ReadonlySet<Ai6aRepairLane> = new Set([
  'already_resolved',
  'intentional_human_review',
  'needs_recon',
]);

// ---------------------------------------------------------------------------
// Count / household noun classes (CLOSED)
// ---------------------------------------------------------------------------

/**
 * Count/household noun classes tracked explicitly, so systematic failures such
 * as "pickle slice weight is unknown" are exposed by name instead of being
 * hidden inside a generic `needs_amount` bucket.
 */
export const AI6A_COUNT_NOUN_CLASSES = [
  'slice',
  'clove',
  'head',
  'stalk',
  'stick',
  'piece',
  'sprig',
  'bunch',
  'can',
  'jar',
  'package',
  'packet',
  'whole_item',
  'none',
] as const;

export type Ai6aCountNounClass = (typeof AI6A_COUNT_NOUN_CLASSES)[number];

const COUNT_NOUN_SET: ReadonlySet<string> = new Set(AI6A_COUNT_NOUN_CLASSES);

export function isAi6aCountNounClass(value: unknown): value is Ai6aCountNounClass {
  return typeof value === 'string' && COUNT_NOUN_SET.has(value);
}

// ---------------------------------------------------------------------------
// Ranking diagnostics (CLOSED)
// ---------------------------------------------------------------------------

/** Where an expected candidate sits in the BOUNDED candidate list. */
export const AI6A_EXPECTED_CANDIDATE_RANKS = [
  'not_applicable',
  'top_1',
  'within_top_3',
  'within_top_5',
  'absent_from_bounded_candidates',
] as const;

export type Ai6aExpectedCandidateRank = (typeof AI6A_EXPECTED_CANDIDATE_RANKS)[number];

/** Deterministic ordering helper: narrower rank labels sort first. */
const RANK_ORDER: ReadonlyMap<string, number> = new Map(
  AI6A_EXPECTED_CANDIDATE_RANKS.map((rank, index) => [rank, index])
);

export function expectedCandidateRankOrder(rank: Ai6aExpectedCandidateRank): number {
  return RANK_ORDER.get(rank) ?? AI6A_EXPECTED_CANDIDATE_RANKS.length;
}

/** How a plausible candidate relates to the automatic outcome. */
export const AI6A_AUTO_OUTCOMES = [
  'no_automatic_identity',
  'automatic_matches_expected',
  'automatic_differs_from_expected',
  'correct_candidate_present_but_auto_withheld',
  'no_expected_candidate_declared',
] as const;

export type Ai6aAutoOutcome = (typeof AI6A_AUTO_OUTCOMES)[number];

/**
 * AI-6A-R1: MUTUALLY EXCLUSIVE expectation classes.
 *
 * The pre-repair report said "46 labeled identity cases", "expected top-1 = 45",
 * "absent = 1" and "46/46 bind the expected FDC" without stating that these use
 * DIFFERENT denominators, which is exactly how a reader ends up convinced two
 * numbers disagree when they do not. Every line is assigned ONE class here, so
 * any two class counts are directly comparable.
 *
 *   - `expected_auto_identity`      has an exact `expectedAutoFdc` to satisfy.
 *                                  THIS is the only denominator for
 *                                  "binds the expected FDC".
 *   - `expect_no_automatic`         corpus forbids ANY automatic identity.
 *   - `known_issue_baseline`        only a recorded current `baselineAutoFdc`;
 *                                  not a correctness contract.
 *   - `top_fdc_order_only`          only an `expectTopFdc` ORDER expectation.
 *   - `candidate_description_only`  only an `expectCandidateDescription` presence rule.
 *   - `forbidden_only`              only forbidden-id / forbidden-description rules.
 *   - `no_expectation`              nothing checked in; correctness is unknowable.
 */
export const AI6A_EXPECTATION_CLASSES = [
  'expected_auto_identity',
  'expect_no_automatic',
  'known_issue_baseline',
  'top_fdc_order_only',
  'candidate_description_only',
  'forbidden_only',
  'no_expectation',
] as const;

export type Ai6aExpectationClass = (typeof AI6A_EXPECTATION_CLASSES)[number];

/**
 * Distinct, NON-mutually-exclusive knowledge flags. Reported separately from
 * `AI6A_EXPECTATION_CLASSES` because a line can carry several at once (e.g.
 * `4 slices bacon` has an expected id AND a forbidden description).
 */
export const AI6A_KNOWLEDGE_FLAGS = [
  'has_expected_auto_fdc',
  'has_baseline_auto_fdc',
  'has_expect_no_automatic',
  'has_expect_top_fdc',
  'has_candidate_description_expectation',
  'has_forbidden_fdc_constraint',
  'has_forbidden_description_constraint',
  'is_known_issue',
] as const;

export type Ai6aKnowledgeFlag = (typeof AI6A_KNOWLEDGE_FLAGS)[number];

// ---------------------------------------------------------------------------
// Coverage families (CLOSED)
// ---------------------------------------------------------------------------

/**
 * The 30 required ingredient-word coverage families. Each corpus line declares
 * the families it materially exercises, and the corpus test proves every family
 * is represented.
 */
export const AI6A_COVERAGE_FAMILIES = [
  'explicit_mass',
  'explicit_volume',
  'count',
  'household_measures',
  'ranges',
  'secondary_parenthetical_mass',
  'container_package',
  'package_net_mass',
  'count_noun_specific',
  'preparation_wording',
  'state_wording',
  'food_form_wording',
  'fresh_vs_dried',
  'raw_vs_cooked',
  'canned_drained_packed',
  'lean_fat_percentage',
  'salted_vs_unsalted',
  'skim_lowfat_whole',
  'chopped_minced_sliced_crushed_ground',
  'alternatives',
  'qualitative_amounts',
  'nutrient_annotation',
  'sauces_condiments',
  'spices_seasonings',
  'cheeses_dairy',
  'meat_poultry_seafood',
  'produce',
  'grains_pasta',
  'composite_food_name_traps',
  'branded_commercial',
] as const;

export type Ai6aCoverageFamily = (typeof AI6A_COVERAGE_FAMILIES)[number];

const COVERAGE_SET: ReadonlySet<string> = new Set(AI6A_COVERAGE_FAMILIES);

export function isAi6aCoverageFamily(value: unknown): value is Ai6aCoverageFamily {
  return typeof value === 'string' && COVERAGE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Corpus provenance
// ---------------------------------------------------------------------------

/**
 * Where a recon line came from. `historical` is the load-bearing 97-line
 * benchmark denominator; `semantic` is the AI-1 semantic corpus; `supplemental`
 * is new AI-6A real-recipe reconnaissance.
 */
export const AI6A_CORPUS_SOURCES = ['historical', 'semantic', 'supplemental'] as const;

export type Ai6aCorpusSource = (typeof AI6A_CORPUS_SOURCES)[number];

// ---------------------------------------------------------------------------
// Historical subset isolation
// ---------------------------------------------------------------------------

/**
 * A versioned production-resolution baseline for one recon phase.
 *
 * The distinction between these records is load-bearing. The AI-6A record is
 * IMMUTABLE historical evidence of what the engine actually did when AI-6A
 * shipped; it is never rewritten because a later authorized phase improved the
 * engine. The AI-6B1 record is the CURRENT authorized production expectation.
 */
export interface Ai6aProductionBaseline {
  /** The phase whose authorized production behavior this record pins. */
  readonly phase: string;
  readonly historical_total: number;
  readonly historical_authenticated_resolved: number;
  readonly legacy_total: number;
  readonly legacy_authenticated_resolved: number;
}

/**
 * IMMUTABLE AI-6A RELEASE BASELINE — before any AI-6B production change.
 *
 * These are the values AI-6A shipped with and the exact digests of the two
 * deterministic JSON artifacts it produced at that release point. They are
 * preserved as historical evidence and must NOT be updated when a later phase
 * legitimately improves production resolution.
 */
export const AI6A_RELEASE_BASELINE: Ai6aProductionBaseline = Object.freeze({
  phase: 'AI-6A',
  historical_total: 97,
  historical_authenticated_resolved: 46,
  legacy_total: 91,
  legacy_authenticated_resolved: 42,
});

/**
 * Exact AI-6A release-point artifact digests (immutable historical evidence).
 * AI-6B1 legitimately produces DIFFERENT current output; these remain the
 * snapshot proving the AI-6A release state.
 */
export const AI6A_RELEASE_RECON_JSON_SHA256 =
  '0a08840535f9a43712942fef89cd1416c3c883f9d0d762929557530a2eeb7444';

export const AI6A_RELEASE_HISTORICAL_BENCHMARK_JSON_SHA256 =
  '0480527440eb8344a2210901f5796ae21b232fc81d218f5f082be32f01db8375';

/**
 * CURRENT AUTHORIZED PRODUCTION BASELINE — AI-6B1.
 *
 * AI-6B1 closed the documented `deterministic_portion` root cause in which a size
 * qualifier preceding a whole-object count unit (`1 medium head green cabbage`)
 * made the canonical parse drop the unit, so no authenticated portion could ever
 * be consumed. Exactly two historical-corpus lines became resolvable with
 * authenticated, identity-bound evidence:
 *
 *   - `1 medium head green cabbage` -> household_portion 908 g
 *   - `1 medium head cauliflower`   -> count_portion 588 g
 *
 * The corpus, the 97/91 denominators, identity truth, and every safety rule are
 * UNCHANGED; only production resolution improved. Conformance is checked against
 * THIS record so an authorized improvement is not reported as drift, while
 * AI6A_RELEASE_BASELINE remains the immutable before-AI-6B measurement.
 */
export const AI6B1_EXPECTED_PRODUCTION_BASELINE: Ai6aProductionBaseline = Object.freeze({
  phase: 'AI-6B1',
  historical_total: 97,
  historical_authenticated_resolved: 48,
  legacy_total: 91,
  legacy_authenticated_resolved: 44,
});

/**
 * The historical subset denominators. These are corpus SHAPE facts (the load-bearing
 * 97-line benchmark denominator and its 91-line legacy subset) and are therefore
 * shared by every baseline record. Only the RESOLVED counts move between phases.
 */
export const HISTORICAL_TOTAL = AI6A_RELEASE_BASELINE.historical_total;
export const LEGACY_TOTAL = AI6A_RELEASE_BASELINE.legacy_total;

/**
 * Resolved-count accessors, named for the phase whose authorized behavior they
 * pin. There is deliberately NO ambiguous bare `HISTORICAL_RESOLVED` constant:
 * every consumer must state which baseline it means.
 */
export const AI6A_RELEASE_HISTORICAL_RESOLVED =
  AI6A_RELEASE_BASELINE.historical_authenticated_resolved;
export const AI6A_RELEASE_LEGACY_RESOLVED =
  AI6A_RELEASE_BASELINE.legacy_authenticated_resolved;
export const AI6B1_EXPECTED_HISTORICAL_RESOLVED =
  AI6B1_EXPECTED_PRODUCTION_BASELINE.historical_authenticated_resolved;
export const AI6B1_EXPECTED_LEGACY_RESOLVED =
  AI6B1_EXPECTED_PRODUCTION_BASELINE.legacy_authenticated_resolved;

/**
 * The six `nutrient_annotation` lines were added to the resolution corpus AFTER
 * the Phase 7 legacy benchmark was pinned at 91 lines / 42 resolved. They are
 * therefore NOT part of the legacy denominator. This set is what makes
 * `91 = 97 - 6` and `42 = 46 - 4` explicit and checkable rather than folklore.
 */
export const LEGACY_EXCLUDED_LINES: ReadonlySet<string> = new Set([
  '1 cup flour (20 g protein)',
  '2 tbsp peanut butter (8 g protein per serving)',
  '1 cup milk (about 30 g fat)',
  '1 cup yogurt (12 g carbs)',
  '1 serving cereal (5 g fiber)',
  '1 bar (200 calories, 10 g protein)',
]);

/** Bounded top-candidate window recorded per line (deterministic). */
export const AI6A_CANDIDATE_WINDOW = 5;