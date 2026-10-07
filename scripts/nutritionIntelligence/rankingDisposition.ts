/**
 * The Kitchen Codex — Advanced Nutrition AI-6B4: RANKING disposition and
 * REPAIRABILITY (planning only, zero production consumers).
 *
 * WHY THIS EXISTS
 * ---------------
 * AI-6B2 measured `repairable_deterministic_portion_defects = 0`; AI-6B3 measured
 * `repairable_deterministic_identity_defects = 0`. Both lanes are adjudicated and
 * exhausted, so the computed next ADJUDICATION target is `deterministic_ranking`
 * with 9 observed `compatible_candidate_not_selected` blockers.
 *
 * THE LOAD-BEARING RULE
 * ---------------------
 * A candidate must NEVER outrank a semantically better food identity merely
 * because it has a convenient USDA portion. The diagnostic
 * `compatible_candidate_not_selected` means only that PRODUCTION HAS A SELECTED
 * FDC, that the selected FDC cannot satisfy the authored measurement through
 * compatible authenticated portion authority, and that SOME OTHER bounded
 * candidate can. It says nothing about whether that other candidate is the right
 * FOOD.
 *
 * Portion compatibility is therefore allowed to influence an outcome only AFTER
 * food-identity fidelity is satisfied. Every alternate is put through, in order:
 * does it satisfy the authored food identity; does it preserve authored
 * state/form qualifiers; does it avoid introducing un-authored specificity; does
 * it avoid contradicting an authored state; does it violate no checked-in corpus
 * constraint; and only then does it carry usable portion authority.
 *
 * WHAT IT IS NOT
 * --------------
 * It grants no authority, binds no FDC, reranks nothing, and adds no food-specific
 * exception table. It never prefers a candidate for coverage, never optimizes a
 * resolution rate, and never routes a ranking case to AI. Pure, offline,
 * deterministic: no clock, randomness, hostname, absolute path, or
 * environment-dependent field, so two runs are byte-identical.
 */

/** Explicit planning-artifact schema version (independent of every recon schema). */
export const RANKING_DISPOSITION_SCHEMA = 'nutrition_ai6b4_ranking_disposition_v1';

// ---------------------------------------------------------------------------
// CLOSED disposition vocabulary
// ---------------------------------------------------------------------------

/**
 * What KIND of problem a ranking-lane blocker actually is.
 *
 * The distinction that matters: only `repairable_deterministic_ranking_defect`
 * means "a bounded GENERAL ranking rule could safely prefer a different
 * candidate, because that candidate is at least as faithful a food identity,
 * violates no checked-in constraint, and supplies the missing portion
 * authority". Every other value is a correct refusal, an authority decision, or
 * work belonging to a different lane.
 */
export const RANKING_DISPOSITIONS = [
  /**
   * A different bounded candidate is semantically at least as faithful as the
   * selected one, violates no authority/safety constraint, carries the missing
   * portion authority, and a GENERAL deterministic rule (not a food-specific
   * patch) can safely prefer it. A real bug class, so the member exists even
   * when the measured count is zero.
   */
  'repairable_deterministic_ranking_defect',
  /**
   * The current selected FDC is the more faithful expression of the authored food
   * identity, even though another candidate carries usable portion authority.
   * Reranking would trade identity truth for grams.
   */
  'selected_identity_semantically_preferred',
  /**
   * The compatible alternate is a materially different food, product class, or
   * state/form, and may not replace the selected identity.
   */
  'alternate_identity_not_equivalent',
  /**
   * Several candidates are semantically acceptable and no authored signal
   * distinguishes them, so no deterministic rerank is safe.
   */
  'authoritative_ranking_ambiguity',
  /**
   * The alternate's ONLY meaningful advantage is its portion evidence. Identity
   * evidence is neutral or worse, so swapping would buy grams with fidelity.
   */
  'portion_compatibility_only_advantage',
  /**
   * Reranking would discard or contradict an authored qualifier (for example an
   * authored `unsalted`, `raw`, or `fresh`).
   */
  'qualifier_fidelity_blocks_rerank',
  /**
   * Reranking would genericize or replace a branded/commercial product identity.
   */
  'brand_or_product_specificity_blocks_rerank',
  /**
   * A checked-in corpus expectation or safety constraint forbids the rerank —
   * for instance `expectedAutoFdc` pinning the SELECTED record.
   */
  'corpus_constraint_blocks_rerank',
  /**
   * No safe GENERAL ranking rule is demonstrable. This is the honest verdict when
   * a line-local look suggests a fix but the minimal rule that would repair it
   * provably moves an already-verified identity elsewhere in the corpus.
   */
  'no_safe_general_ranking_rule',
  /**
   * The case does not actually belong to the ranking lane and should be handed
   * to another lane. Reported, never acted on silently.
   */
  'ranking_blocker_misclassified',
  /** Evidence is insufficient for a safe verdict. */
  'needs_ranking_recon',
] as const;

export type Ai6b4RankingDisposition = (typeof RANKING_DISPOSITIONS)[number];

const DISPOSITION_SET: ReadonlySet<string> = new Set(RANKING_DISPOSITIONS);

/** Closed membership test for the disposition vocabulary. */
export function isAi6b4RankingDisposition(value: unknown): value is Ai6b4RankingDisposition {
  return typeof value === 'string' && DISPOSITION_SET.has(value);
}

// ---------------------------------------------------------------------------
// CLOSED evidence vocabulary
// ---------------------------------------------------------------------------

/**
 * A bounded, machine-checkable REASON for a disposition. Free-form prose is not
 * evidence; every disposition must name exactly one of these codes.
 */
export const RANKING_EVIDENCE_CODES = [
  /** The canonical observation: the selected record lacks compatible portion, an alternate has it. */
  'alternate_compatible_selected_incompatible',
  /** A checked-in `expectedAutoFdc` names the SELECTED record, so reranking diverges from the oracle. */
  'expected_candidate_supports_selected',
  /** A compatible alternate cannot be used because `expectNoAutomatic` forbids any automatic identity. */
  'expect_no_automatic_constraint',
  /** A compatible alternate is a forbidden FDC, or its description matches a forbidden pattern. */
  'forbidden_candidate_constraint',
  /** Every compatible alternate drops at least one authored food-head token. */
  'alternate_drops_authored_qualifier',
  /** A compatible alternate introduces an un-authored specificity the selected record does not carry. */
  'alternate_adds_unauthored_specificity',
  /** A compatible alternate asserts a state/form that contradicts an authored qualifier. */
  'alternate_contradicts_authored_state',
  /** A compatible alternate names a different product class than the selected record. */
  'alternate_changes_food_identity',
  /** The alternate's description is token-identical to the selected record's. */
  'same_food_semantics',
  /** More than one compatible alternate preserves the authored food identity. */
  'multiple_compatible_alternates',
  /** The only advantage the alternate offers is its portion evidence. */
  'portion_compatibility_is_only_advantage',
  /** The minimal general rule that would repair this line provably breaks a verified identity elsewhere. */
  'rule_would_break_known_good_identity_oracle',
  /** No general, food-independent ranking principle is demonstrable from measured evidence. */
  'no_safe_general_rule_demonstrable',
  /** Classification could not be completed from measured evidence. */
  'insufficient_semantic_evidence',
] as const;

export type Ai6b4RankingEvidenceCode = (typeof RANKING_EVIDENCE_CODES)[number];

const EVIDENCE_SET: ReadonlySet<string> = new Set(RANKING_EVIDENCE_CODES);

/** Closed membership test for the evidence vocabulary. */
export function isAi6b4RankingEvidenceCode(value: unknown): value is Ai6b4RankingEvidenceCode {
  return typeof value === 'string' && EVIDENCE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Hypothetical safe rules (measured, never executed in production)
// ---------------------------------------------------------------------------

/**
 * The closed set of hypothetical GENERAL ranking rules AI-6B4 is willing to
 * SIMULATE. Membership is not permission: each is run through the simulation
 * harness across all 207 recon lines and reported, and none is applied.
 */
export const HYPOTHETICAL_RANKING_RULES = [
  /**
   * Within the window, prefer a candidate whose description is token-identical to
   * the selected record's when that candidate carries compatible portion
   * authority. Food-independent: it compares descriptions, never food names.
   */
  'prefer_identical_description_with_compatible_portion',
  /**
   * Among candidates that preserve every authored food-head token, prefer one that
   * carries compatible portion authority over the selected record.
   */
  'prefer_head_token_preserving_candidate_with_compatible_portion',
] as const;

export type Ai6b4HypotheticalRankingRule = (typeof HYPOTHETICAL_RANKING_RULES)[number];

// ---------------------------------------------------------------------------
// Semantic parity
// ---------------------------------------------------------------------------

/**
 * Whether the compatible alternate and the selected record express the SAME food
 * identity. Derived from authored text and candidate descriptions ONLY — never
 * from portion availability, which is the whole point.
 */
export const SEMANTIC_PARITY_VALUES = [
  /** Alternate and selected denote the same food at materially equal specificity. */
  'same_semantic_identity',
  /** The alternate is at least as faithful a reading of the authored line. */
  'alternate_more_faithful',
  /** The selected record matches the authored line more closely. */
  'selected_more_faithful',
  /** A different food, product class, or state/form. */
  'materially_different',
  /** Several readings are plausible and no authored signal separates them. */
  'ambiguous',
] as const;

export type Ai6b4SemanticParity = (typeof SEMANTIC_PARITY_VALUES)[number];

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

/** One bounded candidate in the real candidate window. */
export interface Ai6b4CandidateView {
  readonly rank: number;
  readonly fdc_id: number;
  readonly description: string;
  readonly data_type: string;
  readonly has_compatible_portion: boolean;
}

/** All evidence the classifier needs, gathered READ-ONLY. */
export interface Ai6b4RankingEvidence {
  /** True when a checked-in `expectedAutoFdc` names the SELECTED record. */
  readonly expected_fdc_pins_selected: boolean;
  /** True when the line forbids any automatic identity (`expectNoAutomatic`). */
  readonly expect_no_automatic: boolean;
  /** True when at least one compatible alternate is forbidden by the corpus. */
  readonly alternate_forbidden: boolean;
  /** Compatible alternates, reduced to the decisive identity facts. */
  readonly compatible_alternates: ReadonlyArray<{
    readonly fdc_id: number;
    readonly description: string;
    /** Every authored food-head token appears in this description. */
    readonly preserves_authored_head: boolean;
    /** Description token set is identical to the selected record's. */
    readonly identical_description_to_selected: boolean;
    /** Introduces a specificity token the selected record does not carry. */
    readonly adds_unauthored_specificity: boolean;
    /** Asserts a state/form that contradicts an authored qualifier. */
    readonly contradicts_authored_state: boolean;
    /** Names a different product class than the selected record. */
    readonly changes_food_identity: boolean;
  }>;
  /** True when the selected record is itself a branded/commercial product. */
  readonly selected_is_branded: boolean;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface Ai6b4RankingVerdict {
  readonly disposition: Ai6b4RankingDisposition;
  readonly evidence: Ai6b4RankingEvidenceCode;
  /** True only for a genuine, general, demonstrably safe ranking defect. */
  readonly repairable: boolean;
  /** Closed handoff lane for non-repairable work, else null. */
  readonly handoff_lane: string | null;
  /**
   * The hypothetical rule that WOULD have to be simulated before this line could
   * be called repairable. Null means no rule shape applies.
   */
  readonly hypothetical_safe_rule: Ai6b4HypotheticalRankingRule | null;
  /** True when the alternate and selected denote the same food identity. */
  readonly semantic_parity: Ai6b4SemanticParity;
}

/** True when at least one compatible alternate is semantically safe to prefer. */
function hasSafeAlternate(evidence: Ai6b4RankingEvidence): boolean {
  return evidence.compatible_alternates.some(
    (alternate) =>
      alternate.preserves_authored_head &&
      !alternate.contradicts_authored_state &&
      !alternate.changes_food_identity
  );
}

/** True when some compatible alternate is token-identical to the selected record. */
function hasIdenticalAlternate(evidence: Ai6b4RankingEvidence): boolean {
  return evidence.compatible_alternates.some(
    (alternate) =>
      alternate.identical_description_to_selected &&
      alternate.preserves_authored_head &&
      !alternate.changes_food_identity
  );
}

/** True when EVERY compatible alternate drops an authored head token. */
function allAlternatesDropAuthoredToken(evidence: Ai6b4RankingEvidence): boolean {
  return (
    evidence.compatible_alternates.length > 0 &&
    evidence.compatible_alternates.every((alternate) => !alternate.preserves_authored_head)
  );
}

/** True when SOME compatible alternate contradicts an authored state. */
function someAlternateContradictsState(evidence: Ai6b4RankingEvidence): boolean {
  return evidence.compatible_alternates.some((alternate) => alternate.contradicts_authored_state);
}

/** True when SOME compatible alternate names a different product class. */
function someAlternateChangesFood(evidence: Ai6b4RankingEvidence): boolean {
  return evidence.compatible_alternates.some((alternate) => alternate.changes_food_identity);
}

/** True when SOME safe alternate introduces un-authored specificity instead. */
function someSafeAlternateAddsSpecificity(evidence: Ai6b4RankingEvidence): boolean {
  return evidence.compatible_alternates.some(
    (alternate) =>
      alternate.preserves_authored_head &&
      !alternate.contradicts_authored_state &&
      !alternate.changes_food_identity &&
      alternate.adds_unauthored_specificity
  );
}

/**
 * Maps evidence to exactly ONE disposition plus ONE evidence code.
 *
 * Ordered from most specific and most authoritative to least, so a line is never
 * given a vaguer verdict than its evidence supports, and a checked-in safety
 * constraint is never overridden by a merely convenient portion.
 *
 * Total: every input yields a verdict, so no line can be unclassified.
 */
export function classifyRankingDisposition(
  evidence: Ai6b4RankingEvidence
): Ai6b4RankingVerdict {
  // 0. Semantic parity FIRST, and derived ONLY from authored text and candidate
  //    descriptions. Portion availability never participates in this verdict.
  const parity: Ai6b4SemanticParity = hasIdenticalAlternate(evidence)
    ? 'same_semantic_identity'
    : allAlternatesDropAuthoredToken(evidence) || someAlternateContradictsState(evidence)
      ? evidence.compatible_alternates.some((alternate) => alternate.contradicts_authored_state)
        ? 'materially_different'
        : 'selected_more_faithful'
      : someAlternateChangesFood(evidence)
        ? 'materially_different'
        : evidence.compatible_alternates.length > 1
          ? 'ambiguous'
          : 'selected_more_faithful';

  // 1. A checked-in corpus constraint is authoritative over any portion
  //    convenience. `expectedAutoFdc` naming the selected record means the
  //    identity is already VERIFIED correct; reranking away from it diverges from
  //    the oracle and is refused.
  if (evidence.expected_fdc_pins_selected) {
    return Object.freeze({
      disposition: 'corpus_constraint_blocks_rerank' as const,
      evidence: 'expected_candidate_supports_selected' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }
  if (evidence.expect_no_automatic) {
    return Object.freeze({
      disposition: 'corpus_constraint_blocks_rerank' as const,
      evidence: 'expect_no_automatic_constraint' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }
  if (evidence.alternate_forbidden) {
    return Object.freeze({
      disposition: 'corpus_constraint_blocks_rerank' as const,
      evidence: 'forbidden_candidate_constraint' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }

  // 2. A branded/commercial selected identity is never traded away for a generic
  //    record that merely happens to carry a usable portion.
  if (evidence.selected_is_branded) {
    return Object.freeze({
      disposition: 'brand_or_product_specificity_blocks_rerank' as const,
      evidence: 'portion_compatibility_is_only_advantage' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }

  // 3. Every compatible alternate discards an authored qualifier, or one of them
  //    asserts a state/form the recipe explicitly contradicts. Switching would
  //    trade authored truth for grams.
  if (allAlternatesDropAuthoredToken(evidence)) {
    return Object.freeze({
      disposition: 'qualifier_fidelity_blocks_rerank' as const,
      evidence: 'alternate_drops_authored_qualifier' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }
  if (someAlternateContradictsState(evidence)) {
    return Object.freeze({
      disposition: 'alternate_identity_not_equivalent' as const,
      evidence: 'alternate_contradicts_authored_state' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }

  // 4. A compatible alternate names a different product class (a meatless analog
  //    is not bacon). Never interchangeable, regardless of its portion.
  if (!hasSafeAlternate(evidence) && someAlternateChangesFood(evidence)) {
    return Object.freeze({
      disposition: 'alternate_identity_not_equivalent' as const,
      evidence: 'alternate_changes_food_identity' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }

  // 5. THE ONLY REPAIRABLE CLASS. A compatible alternate is token-identical to the
  //    selected record (same food, same specificity), introduces no un-authored
  //    specificity, contradicts nothing, and violates no checked-in constraint.
  if (hasIdenticalAlternate(evidence)) {
    return Object.freeze({
      disposition: 'repairable_deterministic_ranking_defect' as const,
      evidence: 'same_food_semantics' as const,
      repairable: true,
      handoff_lane: 'deterministic_ranking',
      hypothetical_safe_rule: 'prefer_identical_description_with_compatible_portion' as const,
      semantic_parity: parity,
    });
  }

  // 6. A semantically safe alternate exists but is strictly LESS faithful than the
  //    selected record, so its only real advantage is the portion it carries.
  if (someSafeAlternateAddsSpecificity(evidence)) {
    return Object.freeze({
      disposition: 'portion_compatibility_only_advantage' as const,
      evidence: 'alternate_adds_unauthored_specificity' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }

  // 7. Several candidates preserve the authored identity and no authored signal
  //    separates them.
  if (evidence.compatible_alternates.filter((a) => a.preserves_authored_head).length > 1) {
    return Object.freeze({
      disposition: 'authoritative_ranking_ambiguity' as const,
      evidence: 'multiple_compatible_alternates' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
      semantic_parity: parity,
    });
  }

  // 8. Fall-through: no general, food-independent principle is demonstrable. This
  //    is the honest verdict whenever a line-level look suggests a fix that no
  //    GENERAL rule may safely express.
  return Object.freeze({
    disposition: 'no_safe_general_ranking_rule' as const,
    evidence: 'no_safe_general_rule_demonstrable' as const,
    repairable: false,
    handoff_lane: 'needs_recon',
    hypothetical_safe_rule: null,
    semantic_parity: parity,
  });
}

// ---------------------------------------------------------------------------
// Corpus-wide rule-safety gate
// ---------------------------------------------------------------------------

/**
 * A line may only be counted as `repairable_deterministic_ranking_defect` when a
 * GENERAL rule exists AND that rule survives simulation across the whole corpus.
 *
 * This gate exists because a line-local verdict is not sufficient, and the
 * corpus provides the proof: `3 stalks celery` looks perfectly repairable on its
 * own — its compatible alternate (`2709778`, *Celery, raw*) is TOKEN-IDENTICAL
 * to the selected record (`169988`, *Celery, raw*), and no checked-in constraint
 * forbids the swap. But the minimal general rule that expresses that preference
 * also fires on the two sibling celery lines whose `expectedAutoFdc` PINS
 * `169988`, so the rule trades one unresolved line for two verified ones.
 *
 * The gate therefore refuses the line-level "fix" and reclassifies it as
 * `no_safe_general_ranking_rule`. Correct refusals are not implementation
 * backlog, and a defect that cannot be fixed by a general rule is not a
 * repairable deterministic ranking defect.
 */
export function applyRuleSafetyGate(
  verdict: Ai6b4RankingVerdict,
  ruleEligibility: Readonly<Record<string, boolean>>
): Ai6b4RankingVerdict {
  if (!verdict.repairable) return verdict;
  const rule = verdict.hypothetical_safe_rule;
  // No rule shape means the line could never have been repairable in the first
  // place; refuse rather than silently promote it.
  if (rule === null || ruleEligibility[rule] !== true) {
    return Object.freeze({
      disposition: 'no_safe_general_ranking_rule' as const,
      evidence: 'rule_would_break_known_good_identity_oracle' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
      hypothetical_safe_rule: null,
      semantic_parity: verdict.semantic_parity,
    });
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Hypothetical-rule simulation contract
// ---------------------------------------------------------------------------

/** What one SIMULATED hypothetical ranking rule would do. Never applied. */
export interface Ai6b4RuleSimulation {
  readonly rule_id: Ai6b4RankingRankingRuleId;
  readonly assertion: string;
  /** Automatic identities the rule would newly bind where none exists today. */
  readonly new_automatic_identities: number;
  /** Lines whose currently bound FDC the rule would CHANGE. */
  readonly changed_automatic_identities: number;
  /** Lines the rule would leave exactly as they are. */
  readonly unchanged_automatic_identities: number;
  /**
   * PRIMARY decisive evidence: divergences from a checked-in `expectedAutoFdc`.
   * Exact-record authority. A rule that moves an already-verified identity is
   * ineligible on its own, with no safety argument required.
   */
  readonly expected_fdc_divergences: number;
  /** Divergences from a checked-in `baselineAutoFdc`. */
  readonly baseline_fdc_divergences: number;
  /** Lines whose ranking would no longer satisfy a checked-in `expectTopFdc`. */
  readonly expect_top_fdc_violations: number;
  /** New binds violating `expectNoAutomatic`. */
  readonly expect_no_automatic_violations: number;
  /** New binds violating `forbiddenAutoFdcs`. */
  readonly forbidden_fdc_violations: number;
  /** New binds whose description matches a `forbiddenAutoDescription`. */
  readonly forbidden_description_violations: number;
  /**
   * SECONDARY evidence: changes landing on a checked-in witness of the
   * historical nested-food identity hazard (`sardines in tomato sauce`). This is
   * reported only when a real structural witness is actually hit, and is never
   * the sole basis for refusal — exact-record authority divergence is.
   */
  readonly safety_history_bindings: number;
  /** Ranking-lane lines the rule would actually repair. */
  readonly ranking_lane_new_bindings: number;
  /** Whether the rule would newly produce authenticated mass. */
  readonly new_authenticated_masses: number;
  /** Whether the rule would change any already-resolved gram value. */
  readonly changed_grams: number;
  /**
   * True only when the rule repairs at least one ranking-lane line, changes no
   * already-correct identity, and breaks no checked-in constraint.
   */
  readonly repairable_eligible: boolean;
  /** Bounded reason for the eligibility verdict. */
  readonly eligibility_reason: string;
}

/** Convenience alias so the simulation interface reads clearly. */
export type Ai6b4RankingRankingRuleId = Ai6b4HypotheticalRankingRule;