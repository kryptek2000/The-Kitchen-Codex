/**
 * The Kitchen Codex — Advanced Nutrition AI-6A recon aggregation.
 *
 * Deterministic, bounded aggregation of AI-6A diagnostic records into the
 * report/JSON shape. Every count is derived from the records; nothing is
 * asserted here that the records do not evidence.
 */

import { isSafeResolution, type CorpusExpectation } from './diagnose';
import type { Ai6aDiagnosticRecord } from './diagnose';
import {
  AI6A_BLOCKER_TOTAL,
  AI6A_EXPECTATION_CLASSES,
  AI6A_FAILURE_BLOCKER_TOTAL,
  AI6A_KNOWLEDGE_FLAGS,
  AI6A_LANE_CRITERION_SCORES,
  AI6A_NEVER_TARGET_LANES,
  AI6A_ROADMAP_CRITERIA,
  AUTHENTICATED_MASS_SOURCES,
  AI6A_RELEASE_BASELINE,
  AI6B1_EXPECTED_PRODUCTION_BASELINE,
  HISTORICAL_TOTAL,
  LEGACY_EXCLUDED_LINES,
  LEGACY_TOTAL,
  laneForBlocker,
  type Ai6aAutoOutcome,
  type Ai6aCountNounClass,
  type Ai6aCoverageFamily,
  type Ai6aExpectationClass,
  type Ai6aExpectedCandidateRank,
  type Ai6aIdentityCorrectness,
  type Ai6aKnowledgeFlag,
  type Ai6aMassSource,
  type Ai6aProductionBaseline,
  type Ai6aPrimaryBlocker,
  type Ai6aRepairLane,
  type Ai6aRoadmapCriterion,
  type Ai6aSecondarySignal,
  type Ai6aTerminal,
} from './taxonomy';

export interface Ai6aCounter<T extends string> {
  readonly key: T;
  readonly count: number;
}

/** Stable descending-by-count, then ascending-by-key ordering. */
function counter<T extends string>(values: ReadonlyArray<T>): ReadonlyArray<Ai6aCounter<T>> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key.localeCompare(b.key)));
}

function mapCounter<T extends string>(
  records: ReadonlyArray<Ai6aDiagnosticRecord>,
  select: (record: Ai6aDiagnosticRecord) => T
): ReadonlyArray<Ai6aCounter<T>> {
  return counter(records.map(select));
}

/**
 * A FAILURE CLUSTER: the ordered (primary_blocker, repair_lane, terminal) shape
 * a line failed in, plus how many lines share it. This is what makes "what
 * should the next phase attack first" answerable from frequency rather than
 * impression.
 */
export interface Ai6aFailureCluster {
  readonly primary_blocker: Ai6aPrimaryBlocker;
  readonly repair_lane: Ai6aRepairLane;
  readonly terminal: Ai6aTerminal;
  readonly count: number;
  readonly sample_lines: ReadonlyArray<string>;
}

const CLUSTER_SAMPLE_LIMIT = 3;

function clusters(records: ReadonlyArray<Ai6aDiagnosticRecord>): ReadonlyArray<Ai6aFailureCluster> {
  const grouped = new Map<string, Ai6aDiagnosticRecord[]>();
  for (const record of records) {
    if (record.primary_blocker === 'none_resolved') continue;
    const key = `${record.primary_blocker}|${record.repair_lane}|${record.terminal}`;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [record]);
    else bucket.push(record);
  }
  return [...grouped.entries()]
    .map(([key, bucket]) => {
      const [blocker, lane, terminal] = key.split('|') as [
        Ai6aPrimaryBlocker,
        Ai6aRepairLane,
        Ai6aTerminal
      ];
      return {
        primary_blocker: blocker,
        repair_lane: lane,
        terminal,
        count: bucket.length,
        sample_lines: Object.freeze(
          bucket.slice(0, CLUSTER_SAMPLE_LIMIT).map((record) => record.line)
        ),
      };
    })
    .sort(
      (a, b) =>
        b.count !== a.count
          ? b.count - a.count
          : a.primary_blocker.localeCompare(b.primary_blocker)
    );
}

/**
 * AI-6A-R3: a subset summary now reports THREE DISTINCT resolution axes, because
 * conflating them is exactly what let a collapsed authored choice look like a win.
 *
 *   - `raw_matched`   the live pipeline returned `matched`. Production fact.
 *   - `authenticated_resolved` an AUTHENTICATED MASS SOURCE was produced. The
 *     load-bearing 46/97 and 42/91 invariants are checked against THIS axis,
 *     because the historical benchmark measures current PRODUCTION resolution
 *     and must not be rewritten to hide production behavior.
 *   - `safe_resolved`  authenticated mass AND no competing diagnostic failure.
 *     The only axis that may be called a SUCCESS.
 */
export interface Ai6aSubsetSummary {
  readonly total: number;
  /** PRODUCTION axis — the load-bearing invariant. Mass source is authenticated. */
  readonly authenticated_resolved: number;
  /** RAW axis — the live terminal was `matched`. */
  readonly raw_matched: number;
  /** DIAGNOSTIC SAFE axis — authenticated mass and no competing diagnostic cause. */
  readonly safe_resolved: number;
}

function subsetSummary(records: ReadonlyArray<Ai6aDiagnosticRecord>): Ai6aSubsetSummary {
  return {
    total: records.length,
    // The PRODUCTION axis, checked by `historicalBaselineCheck`. Deliberately NOT
    // gated on the primary blocker: the historical benchmark measures what
    // production actually resolved, so a line whose DIAGNOSTIC verdict is
    // `alternative_ambiguous` still counts here when production returned an
    // authenticated mass. Rewriting this to hide production behavior is forbidden.
    authenticated_resolved: records.filter(
      (record) => AUTHENTICATED_MASS_SOURCES.includes(record.mass_source)
    ).length,
    raw_matched: records.filter((record) => record.terminal === 'matched').length,
    safe_resolved: records.filter(isSafeResolution).length,
  };
}

/**
 * AI-6A-R1: the expectation breakdown, so "binds the expected FDC" can never be
 * read against the wrong denominator. `classes` are MUTUALLY EXCLUSIVE (one per
 * line, so counts sum to the corpus total); `knowledge_flags` OVERLAP (a line may
 * carry several at once) and therefore do NOT sum to the total.
 */
export interface Ai6aExpectationSummary {
  readonly classes: Readonly<Record<Ai6aExpectationClass, number>>;
  readonly knowledge_flags: Readonly<Record<Ai6aKnowledgeFlag, number>>;
  /** Lines with an exact `expectedAutoFdc` — the ONLY "binds expected" denominator. */
  readonly expected_auto_identity_cases: number;
  /** Lines whose corpus forbids any automatic identity. */
  readonly expect_no_automatic_cases: number;
  /** Lines with only a recorded current value (not a correctness contract). */
  readonly known_issue_baseline_cases: number;
  /** Lines with only an ORDER expectation, which says nothing about auto-binding. */
  readonly top_fdc_order_only_cases: number;
  /** Lines with only a candidate-PRESENCE expectation. */
  readonly candidate_description_only_cases: number;
  /** Lines with only forbidden constraints — no positive expectation at all. */
  readonly forbidden_only_cases: number;
  /** Lines with no checked-in knowledge; correctness is unknowable. */
  readonly no_expectation_cases: number;
}

/**
 * The ONE mutually-exclusive class a line belongs to, decided in a fixed order so
 * the assignment is deterministic. Overlapping knowledge is counted separately.
 */
export function expectationClassFor(identity: CorpusExpectation | undefined): Ai6aExpectationClass {
  if (identity === undefined) return 'no_expectation';
  if (identity.expectedAutoFdc !== undefined) return 'expected_auto_identity';
  if (identity.expectNoAutomatic === true) return 'expect_no_automatic';
  if (identity.baselineAutoFdc !== undefined) return 'known_issue_baseline';
  if (identity.expectTopFdc !== undefined) return 'top_fdc_order_only';
  if (identity.expectCandidateDescription !== undefined) return 'candidate_description_only';
  if (
    identity.forbiddenAutoFdcs !== undefined ||
    identity.forbiddenAutoDescription !== undefined
  ) {
    return 'forbidden_only';
  }
  return 'no_expectation';
}

function expectationSummary(
  records: ReadonlyArray<Ai6aDiagnosticRecord>,
  identityFor: (line: string) => CorpusExpectation | undefined
): Ai6aExpectationSummary {
  const classes: Record<string, number> = {};
  for (const key of AI6A_EXPECTATION_CLASSES) classes[key] = 0;
  const flags: Record<string, number> = {};
  for (const key of AI6A_KNOWLEDGE_FLAGS) flags[key] = 0;
  for (const record of records) {
    const identity = identityFor(record.line);
    const klass = expectationClassFor(identity);
    classes[klass] = (classes[klass] ?? 0) + 1;
    if (identity === undefined) continue;
    if (identity.expectedAutoFdc !== undefined) flags.has_expected_auto_fdc += 1;
    if (identity.baselineAutoFdc !== undefined) flags.has_baseline_auto_fdc += 1;
    if (identity.expectNoAutomatic === true) flags.has_expect_no_automatic += 1;
    if (identity.expectTopFdc !== undefined) flags.has_expect_top_fdc += 1;
    if (identity.expectCandidateDescription !== undefined) {
      flags.has_candidate_description_expectation += 1;
    }
    if (identity.forbiddenAutoFdcs !== undefined) flags.has_forbidden_fdc_constraint += 1;
    if (identity.forbiddenAutoDescription !== undefined) {
      flags.has_forbidden_description_constraint += 1;
    }
    if (identity.knownIssue !== undefined) flags.is_known_issue += 1;
  }
  return {
    classes: classes as Record<Ai6aExpectationClass, number>,
    knowledge_flags: flags as Record<Ai6aKnowledgeFlag, number>,
    expected_auto_identity_cases: classes.expected_auto_identity ?? 0,
    expect_no_automatic_cases: classes.expect_no_automatic ?? 0,
    known_issue_baseline_cases: classes.known_issue_baseline ?? 0,
    top_fdc_order_only_cases: classes.top_fdc_order_only ?? 0,
    candidate_description_only_cases: classes.candidate_description_only ?? 0,
    forbidden_only_cases: classes.forbidden_only ?? 0,
    no_expectation_cases: classes.no_expectation ?? 0,
  };
}

export interface Ai6aRankingSummary {
  /** EXACTLY the lines carrying an `expectedAutoFdc`. Nothing else. */
  readonly expected_auto_identity_cases: number;
  /** Of those, how many the engine auto-bound to that exact id. */
  readonly bound_expected_auto_identity: number;
  /**
   * Of those, how many the expected record appears at rank 1 of the bounded
   * candidate WINDOW. This is a DIFFERENT measurement from binding: a record can
   * be auto-bound by a resolution path that does not surface it in the window.
   */
  readonly expected_present_at_window_top_1: number;
  readonly expected_top_1: number;
  readonly expected_within_top_3: number;
  readonly expected_within_top_5: number;
  readonly expected_absent_from_bounded_candidates: number;
  readonly automatic_matches_expected: number;
  readonly automatic_differs_from_expected: number;
  readonly correct_candidate_present_but_auto_withheld: number;
  readonly no_automatic_identity: number;
  readonly no_expected_candidate_declared: number;
}

function rankingSummary(records: ReadonlyArray<Ai6aDiagnosticRecord>): Ai6aRankingSummary {
  const labeled = records.filter(
    (record) => record.expected_candidate_rank !== 'not_applicable'
  );
  void labeled;
  const count = (
    rank: Ai6aExpectedCandidateRank,
    outcome?: Ai6aAutoOutcome
  ): number =>
    records.filter(
      (record) =>
        record.expected_candidate_rank === rank &&
        (outcome === undefined || record.auto_outcome === outcome)
    ).length;
  return {
    expected_auto_identity_cases: labeled.length,
    bound_expected_auto_identity: records.filter(
      (record) =>
        record.expected_candidate_rank !== 'not_applicable' &&
        record.selected_fdc_id !== null &&
        record.auto_outcome === 'automatic_matches_expected'
    ).length,
    expected_present_at_window_top_1: count('top_1'),
    expected_top_1: count('top_1'),
    expected_within_top_3: count('within_top_3'),
    expected_within_top_5: count('within_top_5'),
    expected_absent_from_bounded_candidates: count('absent_from_bounded_candidates'),
    automatic_matches_expected: count('top_1', 'automatic_matches_expected') + count('within_top_3', 'automatic_matches_expected') + count('within_top_5', 'automatic_matches_expected') + count('absent_from_bounded_candidates', 'automatic_matches_expected'),
    automatic_differs_from_expected: records.filter(
      (record) => record.auto_outcome === 'automatic_differs_from_expected'
    ).length,
    correct_candidate_present_but_auto_withheld: records.filter(
      (record) => record.auto_outcome === 'correct_candidate_present_but_auto_withheld'
    ).length,
    no_automatic_identity: records.filter(
      (record) => record.auto_outcome === 'no_automatic_identity'
    ).length,
    no_expected_candidate_declared: records.filter(
      (record) => record.auto_outcome === 'no_expected_candidate_declared'
    ).length,
  };
}

/** Count/household noun census over FAILING lines, so noun gaps are named. */
export function countNounFailures(
  records: ReadonlyArray<Ai6aDiagnosticRecord>
): ReadonlyArray<Ai6aCounter<Ai6aCountNounClass>> {
  return counter(
    records
      .filter((record) => record.primary_blocker !== 'none_resolved')
      .map((record) => record.count_noun_class)
  );
}

export interface Ai6aAggregates {
  readonly total_unique_lines: number;
  readonly historical_97: Ai6aSubsetSummary;
  readonly legacy_91: Ai6aSubsetSummary;
  readonly historical_97_expected: typeof HISTORICAL_TOTAL | number;
  readonly terminals: ReadonlyArray<Ai6aCounter<Ai6aTerminal>>;
  readonly mass_sources: ReadonlyArray<Ai6aCounter<Ai6aMassSource>>;
  readonly primary_blockers: ReadonlyArray<Ai6aCounter<Ai6aPrimaryBlocker>>;
  readonly repair_lanes: ReadonlyArray<Ai6aCounter<Ai6aRepairLane>>;
  readonly identity_correctness: ReadonlyArray<Ai6aCounter<Ai6aIdentityCorrectness>>;
  readonly secondary_signals: ReadonlyArray<Ai6aCounter<Ai6aSecondarySignal>>;
  readonly focus_counts: ReadonlyArray<Ai6aCounter<string>>;
  readonly family_counts: ReadonlyArray<Ai6aCounter<Ai6aCoverageFamily>>;
  readonly failure_clusters: ReadonlyArray<Ai6aFailureCluster>;
  readonly count_noun_failures: ReadonlyArray<Ai6aCounter<Ai6aCountNounClass>>;
  readonly ranking: Ai6aRankingSummary;
  readonly expectations: Ai6aExpectationSummary;
  /**
   * AI-6A-R2 Issue 5: RAW observation and ACTIONABLE blocker are SEPARATE
   * metrics with separate names, because R1 printed the raw number beside the
   * actionable lane and a reader could not tell which one justified a roadmap.
   *
   * `raw_selected_record_portion_incompatible` is a compatibility probe result.
   * `actionable_portion_blocker` is a root cause: a bounded authored quantity
   * exists AND the missing portion is genuinely the primary blocker. ONLY the
   * actionable count may be used to rank AI-6B.
   */
  readonly portion: {
    /** RAW: unresolved lines whose selected record has no compatible portion. */
    readonly raw_selected_record_portion_incompatible: number;
    readonly alternate_candidate_has_compatible_portion: number;
    readonly compatible_candidate_not_selected: number;
    readonly selected_record_has_compatible_portion_but_unresolved: number;
    /**
     * ACTIONABLE: unresolved, BOUNDED-quantity lines whose PRIMARY blocker is a
     * portion blocker. This is the roadmap input.
     */
    readonly actionable_portion_blocker: number;
    /**
     * The subset of ACTIONABLE lines where the selected record DOES carry a
     * compatible portion yet still produced no mass
     * (`compatible_portion_unresolved`). These are NOT in the raw-incompatible
     * set, which is why the two numbers do not sum naively:
     * `raw_incompatible(59) = actionable_with_incompatible_record(35) +
     * not_actionable(24)` and `actionable(37) = 35 + 2`.
     */
    readonly actionable_with_compatible_record_but_unresolved: number;
    /**
     * The honest reconciliation of the two headline numbers: unresolved lines
     * whose record is probe-incompatible but whose PRIMARY blocker is not portion
     * authority. `raw_incompatible_by_blocker` names exactly which blocker each
     * one really has, so the gap is explained rather than merely stated.
     */
    readonly bounded_lines_incompatible_but_not_actionable: number;
    readonly raw_incompatible_by_blocker: ReadonlyArray<Ai6aCounter<Ai6aPrimaryBlocker>>;
  };
  readonly counts: {
    /**
     * AI-6A-R3 PRODUCTION AXIS — the live pipeline returned `matched`. A
     * production fact, never a success claim.
     */
    readonly raw_matched: number;
    /**
     * AI-6A-R3 MASS AXIS — the mass SOURCE is authenticated (USDA portion,
     * household registry, or authored mass). This says NOTHING about whether the
     * authored SEMANTIC FOOD CHOICE was authorized.
     */
    readonly authenticated_mass_resolved: number;
    /**
     * AI-6A-R3 SAFE AXIS — the only count that may be called a success:
     * authenticated mass AND no competing diagnostic failure.
     */
    readonly safe_resolved: number;
    /**
     * AI-6A-R3: lines with an AUTHENTICATED MASS whose authored food CHOICE is
     * still unresolved — production collapsed `X or Y` and the recon declines to
     * call that a success. `1 cup all-purpose or bread flour` is the sole case.
     */
    readonly authenticated_mass_with_unresolved_authored_choice: number;
    readonly verified_unsafe_auto_identity: number;
    readonly verified_correct_auto_identity: number;
    readonly unverified_auto_identity: number;
    readonly catalog_or_specificity_gap: number;
    readonly alternative_ambiguous: number;
    /**
     * AI-6A-R2 MEASURED FINDING: lines that offer an authored `X or Y` yet the
     * engine nonetheless AUTO-BOUND one of them and resolved a gram value. The
     * recon reports this rather than hiding it behind `none_resolved`, because
     * "we picked one for you" is exactly the outcome the alternative rules say
     * must not happen silently. It is a LABEL, not a repair: AI-6A changes no
     * production behavior.
     */
    readonly authored_alternative_auto_resolved: number;
    readonly qualitative_or_absent_amount: number;
    readonly qualitative_explicit_cue: number;
    readonly qualitative_amount_absent: number;
    /** AI-6A-R2: the measurement WAS mis-captured by deterministic parsing. */
    readonly measurement_parse_gap: number;
    /** AI-6A-R2: the measurement was captured correctly and no policy consumes it. */
    readonly measurement_policy_gap: number;
    readonly container_mass_absent: number;
    readonly container_net_mass_boundary: number;
    readonly identity_needs_review: number;
    readonly identity_unmatched: number;
    /** AI-6A-R2: ordinary identity review that lost precedence to a root cause. */
    readonly identity_review_symptom_observed: number;
    /**
     * AI-6A-R2: lines with a BOUNDED authored measurement. Reported so the
     * "unmeasurable amount" count can be read against its own denominator.
     */
    readonly bounded_authored_measurement: number;
    readonly unclassified: number;
  };
  readonly accounting: {
    readonly blocker_enum_total: number;
    readonly success_sentinel_count: number;
    readonly failure_blocker_count: number;
  };
  readonly roadmap: Ai6aRoadmapEntry;
  readonly roadmap_ranking: ReadonlyArray<Ai6aRoadmapEntry>;
}

/**
 * ONE ranked candidate for the next phase.
 *
 * `root_cause_count` is the count of PRIMARY BLOCKERS (never a raw compatibility
 * probe). `frequency_score` is the measured root-cause count expressed on the
 * same 1-5 scale as the declared judgments, so the five criteria are directly
 * comparable without letting raw line counts silently dominate.
 */
export interface Ai6aRoadmapEntry {
  readonly lane: Ai6aRepairLane;
  /** Root-cause blocker count for this lane, measured from `primary_blockers`. */
  readonly root_cause_count: number;
  /** The 1-5 judgment per criterion; `frequency` is MEASURED, not asserted. */
  readonly criteria: Readonly<Record<Ai6aRoadmapCriterion, number>>;
  /** The criterion that decided this entry's position against the entry above. */
  readonly decided_by: Ai6aRoadmapCriterion | 'sole_candidate';
  /** Why this lane is or is not a legitimate target at all. */
  readonly eligible: boolean;
}

/**
 * AI-6A-R2 Issue 5: the AI-6B recommendation, COMPUTED from the current
 * root-cause distribution plus the declared criterion judgments.
 *
 * Three properties matter and are all test-enforced:
 *
 *   1. It reads ONLY `primary_blockers` for its frequency. The RAW portion
 *      compatibility metric is never an input, so inflating it cannot change the
 *      recommendation.
 *   2. No lane is named as the target in code. The winner is the argmax of a
 *      computed comparison, so a change in the measurement changes the answer.
 *   3. The criteria are compared LEXICOGRAPHICALLY in the mission's order, so
 *      `frequency` — the last criterion — can never promote a merely large
 *      bucket over a safer or more tractable one. Picking the largest bucket is
 *      therefore structurally impossible.
 */
export function roadmapRanking(
  primaryBlockers: ReadonlyArray<Ai6aCounter<Ai6aPrimaryBlocker>>
): ReadonlyArray<Ai6aRoadmapEntry> {
  const laneRootCauses = new Map<Ai6aRepairLane, number>();
  for (const blocker of primaryBlockers) {
    const lane = laneForBlocker(blocker.key);
    laneRootCauses.set(lane, (laneRootCauses.get(lane) ?? 0) + blocker.count);
  }

  const entries: Ai6aRoadmapEntry[] = [];
  for (const [lane, declared] of Object.entries(AI6A_LANE_CRITERION_SCORES)) {
    const repairLane = lane as Ai6aRepairLane;
    const rootCauseCount = laneRootCauses.get(repairLane) ?? 0;
    // AI-6A-R2: frequency is MEASURED on the root-cause scale, then normalized
    // against the largest eligible root-cause count. This is the ONLY place a
    // raw count enters the ranking, and it is a root-cause count.
    entries.push({
      lane: repairLane,
      root_cause_count: rootCauseCount,
      criteria: Object.freeze({ ...declared, frequency: rootCauseCount }),
      decided_by: 'sole_candidate',
      eligible: !AI6A_NEVER_TARGET_LANES.has(repairLane),
    });
  }

  // Lexicographic comparison in the declared criterion order.
  const compare = (a: Ai6aRoadmapEntry, b: Ai6aRoadmapEntry): number => {
    for (const criterion of AI6A_ROADMAP_CRITERIA) {
      if (a.criteria[criterion] !== b.criteria[criterion]) {
        return b.criteria[criterion] - a.criteria[criterion];
      }
    }
    return b.root_cause_count - a.root_cause_count;
  };
  const decided = (a: Ai6aRoadmapEntry, b: Ai6aRoadmapEntry): Ai6aRoadmapEntry['decided_by'] => {
    for (const criterion of AI6A_ROADMAP_CRITERIA) {
      if (a.criteria[criterion] !== b.criteria[criterion]) return criterion;
    }
    return 'sole_candidate';
  };

  // Ineligible lanes sort after every eligible lane, then by the criteria.
  const ordered = [...entries].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return compare(a, b);
  });
  return Object.freeze(
    ordered.map((entry, index) =>
      index === 0 ? entry : Object.freeze({ ...entry, decided_by: decided(entry, ordered[index - 1]!) })
    )
  );
}

/** The single recommended target, derived from the ranking. */
function topRoadmap(
  primaryBlockers: ReadonlyArray<Ai6aCounter<Ai6aPrimaryBlocker>>
): Ai6aRoadmapEntry {
  const ranking = roadmapRanking(primaryBlockers);
  const first = ranking[0];
  if (first === undefined) {
    throw new Error('ai6a_roadmap_empty');
  }
  return first;
}

export function aggregate(
  records: ReadonlyArray<Ai6aDiagnosticRecord>,
  identityFor: (line: string) => CorpusExpectation | undefined = () => undefined
): Ai6aAggregates {
  const historical = records.filter((record) => record.source === 'historical');
  const legacy = historical.filter((record) => !LEGACY_EXCLUDED_LINES.has(record.line));
  const unsafe = records.filter(
    (record) => record.identity_correctness === 'verified_unsafe'
  );
  const verifiedCorrect = records.filter(
    (record) => record.identity_correctness === 'verified_correct'
  );
  const autoSelected = records.filter((record) => record.selected_fdc_id !== null);
  const unresolvedLines = records.filter((record) => record.mass_source === 'none');
  const primaryBlockers = mapCounter(records, (record) => record.primary_blocker);

  // AI-6A-R2 Issue 5: RAW probe vs ACTIONABLE root cause, counted separately.
  const rawIncompatible = unresolvedLines.filter(
    (record) => record.selected_record_portion_compatible === false
  );
  // ACTIONABLE means the remedy is portion AUTHORITY, so the definition is
  // routed by the same lane table the roadmap uses. Deliberately EXCLUDES
  // `compatible_candidate_not_selected`: there a compatible portion genuinely
  // exists, in a different record, so the defect is selection/ranking and
  // counting it as portion work would overstate the lane by exactly those lines.
  const actionablePortion = unresolvedLines.filter(
    (record) =>
      record.portion_resolvable_quantity === true &&
      laneForBlocker(record.primary_blocker) === 'deterministic_portion'
  );
  const rawIncompatibleNotActionable = rawIncompatible.filter(
    (record) => !actionablePortion.includes(record)
  );

  return {
    total_unique_lines: records.length,
    historical_97: subsetSummary(historical),
    legacy_91: subsetSummary(legacy),
    historical_97_expected: HISTORICAL_TOTAL,
    terminals: mapCounter(records, (record) => record.terminal),
    mass_sources: mapCounter(records, (record) => record.mass_source),
    primary_blockers: primaryBlockers,
    repair_lanes: mapCounter(records, (record) => record.repair_lane),
    identity_correctness: mapCounter(records, (record) => record.identity_correctness),
    secondary_signals: secondarySignalCounts(records),
    focus_counts: mapCounter(records, (record) => record.focus),
    family_counts: counter(records.flatMap((record) => [...record.families])),
    failure_clusters: clusters(records),
    count_noun_failures: countNounFailures(records),
    ranking: rankingSummary(records),
    expectations: expectationSummary(records, identityFor),
    portion: {
      // All four RAW metrics are scoped to UNRESOLVED lines. On a line that
      // already resolved, "another candidate also had a compatible portion" is
      // not a finding, so counting it there would inflate the number.
      raw_selected_record_portion_incompatible: rawIncompatible.length,
      alternate_candidate_has_compatible_portion: unresolvedLines.filter(
        (record) => record.alternate_candidate_portion_compatible === true
      ).length,
      compatible_candidate_not_selected: unresolvedLines.filter(
        (record) => record.primary_blocker === 'compatible_candidate_not_selected'
      ).length,
      selected_record_has_compatible_portion_but_unresolved: unresolvedLines.filter(
        (record) => record.selected_record_portion_compatible === true
      ).length,
      actionable_portion_blocker: actionablePortion.length,
      actionable_with_compatible_record_but_unresolved: actionablePortion.filter(
        (record) => record.selected_record_portion_compatible === true
      ).length,
      bounded_lines_incompatible_but_not_actionable: rawIncompatibleNotActionable.length,
      raw_incompatible_by_blocker: counter(
        rawIncompatibleNotActionable.map((record) => record.primary_blocker)
      ),
    },
    counts: {
      // AI-6A-R3: the three resolution axes, reported separately and never
      // substituted for one another.
      raw_matched: records.filter((record) => record.terminal === 'matched').length,
      authenticated_mass_resolved: records.filter((record) =>
        AUTHENTICATED_MASS_SOURCES.includes(record.mass_source)
      ).length,
      safe_resolved: records.filter(isSafeResolution).length,
      authenticated_mass_with_unresolved_authored_choice: records.filter(
        (record) =>
          AUTHENTICATED_MASS_SOURCES.includes(record.mass_source) &&
          record.secondary_signals.includes('has_alternative') &&
          !isSafeResolution(record)
      ).length,
      verified_unsafe_auto_identity: unsafe.length,
      verified_correct_auto_identity: verifiedCorrect.length,
      unverified_auto_identity: autoSelected.length - unsafe.length - verifiedCorrect.length,
      catalog_or_specificity_gap: records.filter(
        (record) => record.primary_blocker === 'catalog_or_specificity_gap'
      ).length,
      alternative_ambiguous: records.filter(
        (record) => record.primary_blocker === 'alternative_ambiguous'
      ).length,
      authored_alternative_auto_resolved: records.filter(
        (record) =>
          record.secondary_signals.includes('has_alternative') &&
          record.primary_blocker === 'alternative_ambiguous' &&
          AUTHENTICATED_MASS_SOURCES.includes(record.mass_source)
      ).length,
      qualitative_or_absent_amount: records.filter(
        (record) => record.primary_blocker === 'qualitative_or_absent_amount'
      ).length,
      // AI-6A-R1: the two subtypes of an unbounded authored amount, which are
      // different USER problems (an intentional cue is correct behavior; an
      // absent amount is an authored gap).
      qualitative_explicit_cue: records.filter(
        (record) => record.qualitative_reason === 'explicit_qualitative_amount'
      ).length,
      qualitative_amount_absent: records.filter(
        (record) => record.qualitative_reason === 'authored_amount_absent'
      ).length,
      // AI-6A-R2: the parse-gap / policy-gap split.
      measurement_parse_gap: records.filter(
        (record) => record.primary_blocker === 'measurement_parse_gap'
      ).length,
      measurement_policy_gap: records.filter(
        (record) => record.primary_blocker === 'measurement_policy_gap'
      ).length,
      container_mass_absent: records.filter(
        (record) => record.primary_blocker === 'container_mass_absent'
      ).length,
      container_net_mass_boundary: records.filter(
        (record) => record.primary_blocker === 'container_net_mass_boundary'
      ).length,
      identity_needs_review: records.filter(
        (record) => record.primary_blocker === 'identity_needs_review'
      ).length,
      identity_unmatched: records.filter(
        (record) => record.primary_blocker === 'identity_unmatched'
      ).length,
      identity_review_symptom_observed: records.filter((record) =>
        record.secondary_signals.includes('identity_review_symptom_present')
      ).length,
      // AI-6A-R2 Issue 1: the denominator for every "unmeasurable amount" count.
      bounded_authored_measurement: records.filter(
        (record) => record.portion_resolvable_quantity === true
      ).length,
      unclassified: records.filter((record) => record.primary_blocker === 'unclassified').length,
    },
    accounting: {
      blocker_enum_total: AI6A_BLOCKER_TOTAL,
      success_sentinel_count: 1,
      failure_blocker_count: AI6A_FAILURE_BLOCKER_TOTAL,
    },
    roadmap: topRoadmap(primaryBlockers),
    roadmap_ranking: roadmapRanking(primaryBlockers),
  };
}

function secondarySignalCounts(
  records: ReadonlyArray<Ai6aDiagnosticRecord>
): ReadonlyArray<Ai6aCounter<Ai6aSecondarySignal>> {
  return counter(records.flatMap((record) => [...record.secondary_signals]));
}

/**
 * THE HISTORICAL BASELINE INVARIANT.
 *
 * AI-6A is measurement-only, so the historical 97 must still resolve 46 and the
 * legacy subset must still resolve 42. A drift here means behavior changed, which
 * is a STOP condition and must be reported rather than absorbed.
 */
/**
 * Conformance + transition report for the historical/legacy denominators.
 *
 * CONFORMANCE is measured against the CURRENT authorized production baseline
 * (AI-6B1), so an explicitly authorized later phase that genuinely improves
 * production resolution is not permanently reported as drift.
 *
 * The IMMUTABLE AI-6A release baseline is still reported alongside it, together
 * with the delta, so the output always shows that the CORPUS did not change and
 * that production resolution improved by exactly the authorized amount.
 */
export function historicalBaselineCheck(aggregates: Ai6aAggregates): {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<string>;
  readonly ai6a_release_baseline: Ai6aProductionBaseline;
  readonly expected_production_baseline: Ai6aProductionBaseline;
  readonly observed: {
    readonly historical_total: number;
    readonly historical_authenticated_resolved: number;
    readonly legacy_total: number;
    readonly legacy_authenticated_resolved: number;
  };
  readonly delta_from_ai6a_release: {
    readonly historical_authenticated_resolved: number;
    readonly legacy_authenticated_resolved: number;
  };
} {
  const expected = AI6B1_EXPECTED_PRODUCTION_BASELINE;
  const observed = {
    historical_total: aggregates.historical_97.total,
    historical_authenticated_resolved: aggregates.historical_97.authenticated_resolved,
    legacy_total: aggregates.legacy_91.total,
    legacy_authenticated_resolved: aggregates.legacy_91.authenticated_resolved,
  };
  const problems: string[] = [];
  if (observed.historical_total !== expected.historical_total) {
    problems.push(`historical_total:${observed.historical_total}!=${expected.historical_total}`);
  }
  if (
    observed.historical_authenticated_resolved !== expected.historical_authenticated_resolved
  ) {
    problems.push(
      `historical_resolved:${observed.historical_authenticated_resolved}!=${expected.historical_authenticated_resolved}`
    );
  }
  if (observed.legacy_total !== expected.legacy_total) {
    problems.push(`legacy_total:${observed.legacy_total}!=${expected.legacy_total}`);
  }
  if (observed.legacy_authenticated_resolved !== expected.legacy_authenticated_resolved) {
    problems.push(
      `legacy_resolved:${observed.legacy_authenticated_resolved}!=${expected.legacy_authenticated_resolved}`
    );
  }
  return {
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    ai6a_release_baseline: AI6A_RELEASE_BASELINE,
    expected_production_baseline: expected,
    observed: Object.freeze(observed),
    delta_from_ai6a_release: Object.freeze({
      historical_authenticated_resolved:
        observed.historical_authenticated_resolved -
        AI6A_RELEASE_BASELINE.historical_authenticated_resolved,
      legacy_authenticated_resolved:
        observed.legacy_authenticated_resolved -
        AI6A_RELEASE_BASELINE.legacy_authenticated_resolved,
    }),
  };
}

export { AI6A_BLOCKER_TOTAL, AI6A_FAILURE_BLOCKER_TOTAL };

export function rate(resolved: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((resolved / total) * 100).toFixed(1)}%`;
}