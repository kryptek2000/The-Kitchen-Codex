/**
 * The Kitchen Codex — Advanced Nutrition AI-6B3: IDENTITY disposition and
 * REPAIRABILITY (planning only, zero production consumers).
 *
 * WHY THIS EXISTS
 * ---------------
 * AI-6B2 measured `repairable_deterministic_portion_defects = 0` and therefore
 * marked the portion lane EXHAUSTED. Its computed next ADJUDICATION target was
 * `deterministic_identity` with 27 observed blockers.
 *
 * The same trap the portion lane set is now applied to identity. A BLOCKER and a
 * REPAIRABILITY verdict are not the same thing: `identity_needs_review` is a
 * truthful observation that the deterministic engine declined to bind an
 * identity, and most such refusals are CORRECT. The planning label
 * `deterministic_identity = 27` therefore OVERSTATES remaining implementation
 * work unless each refusal is adjudicated against real evidence.
 *
 * THE ARCHITECTURAL CORRECTION
 * ----------------------------
 * An identity blocker stays EXACTLY as observed. This module adds an ORTHOGONAL,
 * closed disposition axis beside it. Nothing here rewrites blocker truth, corpus
 * membership, authored text, identity labels, mass sources, or grams in order to
 * move a roadmap ranking — that would be scoreboard gaming. Every disposition is
 * derived from read-only evidence gathered through the existing public session
 * contracts plus the already-checked-in corpus constraints.
 *
 * IDENTITY IS NOT RANKING
 * -----------------------
 * IDENTITY asks "what food is this?". RANKING asks "given valid candidate
 * identities, which one should come first?". The 9 `deterministic_ranking`
 * blockers are a DIFFERENT lane and are never folded in here. This module reads
 * the identity lane only; a classification discrepancy is reported, never acted
 * on silently.
 *
 * WHAT IT IS NOT
 * --------------
 * It grants no authority, binds no FDC, changes no production behavior, and adds
 * no food-specific exception table. It never auto-selects an additional USDA
 * identity, never genericizes a branded food, never asserts a food equivalence,
 * and never routes an identity case to AI. Pure, offline, deterministic: no clock,
 * randomness, hostname, absolute path, or environment-dependent field, so two
 * runs are byte-identical.
 */

/** Explicit planning-artifact schema version (independent of every recon schema). */
export const IDENTITY_DISPOSITION_SCHEMA = 'nutrition_ai6b3_identity_disposition_v1';

// ---------------------------------------------------------------------------
// CLOSED disposition vocabulary
// ---------------------------------------------------------------------------

/**
 * What KIND of problem an identity-lane blocker actually is.
 *
 * The distinction that matters: only `repairable_deterministic_identity_defect`
 * means "the current bounded candidate window ALREADY determines one safe,
 * unambiguous identity, and production fails to consume it because of an
 * implementation defect". Every other value is a correct refusal, a decision
 * that would require inventing specificity the recipe did not author, or work
 * belonging to a different lane entirely.
 */
export const IDENTITY_DISPOSITIONS = [
  /**
   * A bounded general deterministic rule could safely bind ONE identity: exactly
   * one candidate in the bounded window satisfies every authored food-head token,
   * every competitor violates at least one, the winner violates no corpus
   * constraint, and the line carries no `expectNoAutomatic`. This is a real bug
   * class, so the vocabulary member exists even when the measured count is zero.
   */
  'repairable_deterministic_identity_defect',
  /**
   * The authored food head is not a faithful identity string: it carries the
   * parsed quantity, a container noun, or a token the repository already declares
   * a preparation/state/size modifier rather than a food noun. Candidate
   * generation is therefore reasoning about a phrase no catalog describes.
   */
  'normalization_or_tokenization_gap',
  /**
   * No candidate in the bounded window satisfies the authored food head, yet a
   * bounded catalog probe over a strict relaxation of that head DOES find records.
   * The catalog is not empty for this food family; the deterministic candidate
   * path surfaced nothing usable.
   */
  'catalog_candidate_generation_gap',
  /**
   * Two or more window candidates satisfy the authored food head. Several
   * identities are genuinely plausible, so choosing one would manufacture
   * certainty the recipe never supplied.
   */
  'ambiguous_identity_requires_review',
  /**
   * No window candidate satisfies the authored food head and no bounded probe
   * over a one-token relaxation finds records either. Binding anything would mean
   * discarding authored content — a generic substitution the recipe never made.
   */
  'specificity_not_authorized',
  /**
   * Resolving would require asserting a food equivalence no canonical contract
   * holds (for example treating an unspecified form as a specific catalog form).
   */
  'semantic_equivalence_not_authorized',
  /**
   * The line names a branded/commercial or product-specific food. Generic
   * substitution would be dishonest, so this is a catalog or human decision, not
   * a repairable generic match.
   */
  'branded_or_commercial_specificity_gap',
  /**
   * The authored line names no discriminating food identity at all (a quantity
   * plus a nutrient annotation, say), so only the user can say what it is.
   */
  'intentional_human_identity_choice',
  /**
   * Evidence is insufficient to classify safely. Every use MUST carry a bounded
   * reason code; this member may never act as a silent catch-all.
   */
  'needs_identity_recon',
] as const;

export type Ai6b3IdentityDisposition = (typeof IDENTITY_DISPOSITIONS)[number];

const DISPOSITION_SET: ReadonlySet<string> = new Set(IDENTITY_DISPOSITIONS);

/** Closed membership test for the disposition vocabulary. */
export function isAi6b3IdentityDisposition(value: unknown): value is Ai6b3IdentityDisposition {
  return typeof value === 'string' && DISPOSITION_SET.has(value);
}

// ---------------------------------------------------------------------------
// CLOSED evidence vocabulary
// ---------------------------------------------------------------------------

/**
 * A bounded, machine-checkable REASON for a disposition. Free-form prose is not
 * evidence; every disposition must name exactly one of these codes.
 */
export const IDENTITY_EVIDENCE_CODES = [
  /** Exactly one window candidate satisfies every authored food-head token. */
  'single_safe_candidate_withheld',
  /** Two or more window candidates satisfy the authored food head. */
  'multiple_plausible_candidates',
  /** Every window candidate satisfying the food head is forbidden by the corpus. */
  'all_satisfying_candidates_forbidden',
  /** The parsed food query still carries the parsed quantity as its leading token. */
  'quantity_token_absorbed_into_food_query',
  /** The authored food head carries a container noun, not a food noun. */
  'container_noun_in_food_head',
  /** The authored food head carries a token already declared a state/form/size modifier. */
  'declared_qualifier_token_in_food_head',
  /** A bounded catalog probe finds records for a relaxation of the food head. */
  'catalog_probe_finds_candidate_but_window_empty',
  /** Neither the food head nor any one-token relaxation matches any record. */
  'no_authorized_record_for_authored_specificity',
  /** Resolution requires asserting a food equivalence no canonical contract holds. */
  'resolving_requires_unstated_food_equivalence',
  /** The authored line carries a brand or commercial token. */
  'brand_token_in_authored_line',
  /** The authored line names no discriminating food identity. */
  'authored_line_names_no_discriminating_food',
  /** Classification could not be completed from measured evidence. */
  'insufficient_evidence_for_classification',
] as const;

export type Ai6b3IdentityEvidenceCode = (typeof IDENTITY_EVIDENCE_CODES)[number];

const EVIDENCE_SET: ReadonlySet<string> = new Set(IDENTITY_EVIDENCE_CODES);

/** Closed membership test for the evidence vocabulary. */
export function isAi6b3IdentityEvidenceCode(value: unknown): value is Ai6b3IdentityEvidenceCode {
  return typeof value === 'string' && EVIDENCE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Hypothetical safe rules (measured, never executed in production)
// ---------------------------------------------------------------------------

/**
 * The closed set of hypothetical deterministic rules AI-6B3 is willing to
 * SIMULATE. A rule earns membership by being general (no food-specific
 * constants) and bounded. Membership is not permission: each rule is run through
 * the simulation harness and reported, and none of them is applied to production.
 */
export const HYPOTHETICAL_SAFE_RULES = [
  /**
   * "Bind the identity when the bounded candidate window already determines
   * exactly one safe candidate." This is the only shape that could ever justify a
   * `repairable_deterministic_identity_defect`.
   */
  'unique_satisfying_candidate_auto_bind',
  /**
   * "Plural authored head tokens should match singular catalog nouns."
   * Simulated because it is general and bounded; it is NOT applied.
   */
  'singularize_plural_head_token',
] as const;

export type Ai6b3HypotheticalSafeRule = (typeof HYPOTHETICAL_SAFE_RULES)[number];

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

/** One bounded candidate in the real candidate window. */
export interface Ai6b3CandidateView {
  readonly rank: number;
  readonly fdc_id: number;
  readonly description: string;
  readonly data_type: string;
  readonly has_compatible_portion: boolean;
}

/** All evidence the classifier needs, gathered READ-ONLY. */
export interface Ai6b3IdentityEvidence {
  /** True when the recipe line carries a brand or commercial token. */
  readonly brand_specificity: boolean;
  /** True when the parsed food query still leads with the parsed quantity. */
  readonly quantity_absorbed_into_query: boolean;
  /** True when a container noun leaked into the projected food head. */
  readonly container_noun_in_head: boolean;
  /** True when the food head carries a token the repo declares a non-food modifier. */
  readonly declared_qualifier_in_head: boolean;
  /** True when no discriminating food-head token could be projected at all. */
  readonly food_head_absent: boolean;
  /** Window candidates whose description contains EVERY authored food-head token. */
  readonly satisfying_candidate_ids: ReadonlyArray<number>;
  /** True when every satisfying candidate is forbidden by a corpus constraint. */
  readonly all_satisfying_forbidden: boolean;
  /** Bounded catalog probe over the authored food head, else null when absent. */
  readonly head_probe_total: number | null;
  /**
   * Bounded catalog probe over the food head with its LEADING token removed.
   * This is the strictest possible relaxation: it asks whether records exist for
   * the remaining authored words at all. A non-zero value proves the catalog is
   * not empty for this food family without asserting any equivalence.
   */
  readonly head_probe_drop_leading_total: number | null;
  /** True when a corpus expectation forbids any automatic identity here. */
  readonly expect_no_automatic: boolean;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface Ai6b3IdentityVerdict {
  readonly disposition: Ai6b3IdentityDisposition;
  readonly evidence: Ai6b3IdentityEvidenceCode;
  /** True only for a genuine deterministic implementation defect. */
  readonly repairable: boolean;
  /** Closed handoff lane for non-repairable work, else null. */
  readonly handoff_lane: string | null;
  /**
   * The hypothetical rule that WOULD have to be simulated before this line could
   * ever be called repairable. Null means no rule shape applies.
   */
  readonly hypothetical_safe_rule: Ai6b3HypotheticalSafeRule | null;
}

/**
 * Maps evidence to exactly ONE disposition plus ONE evidence code.
 *
 * The predicates are ordered from most specific to most general, so a line is
 * never given a vaguer verdict than its evidence supports, and a query-shape
 * defect is reported as such rather than being masked by an ambiguity the
 * defective query manufactured. Total: every input yields a verdict, so no line
 * can be unclassified.
 */
export function classifyIdentityDisposition(
  evidence: Ai6b3IdentityEvidence
): Ai6b3IdentityVerdict {
  // 1. A branded/commercial food is NOT genericizable. Binding a generic record
  //    would silently substitute a different product, so this is reported as a
  //    specificity/catalog limitation for a human, never as a repair.
  if (evidence.brand_specificity) {
    return Object.freeze({
      disposition: 'branded_or_commercial_specificity_gap' as const,
      evidence: 'brand_token_in_authored_line' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
    });
  }

  // 2. A food head that is not a faithful identity string is a PARSER/TOKENIZER
  //    finding, not a missing identity. Reported before any ambiguity verdict,
  //    because candidate counts computed from a defective query are not evidence
  //    about the food at all.
  if (evidence.quantity_absorbed_into_query && evidence.food_head_absent) {
    return Object.freeze({
      disposition: 'normalization_or_tokenization_gap' as const,
      evidence: 'quantity_token_absorbed_into_food_query' as const,
      repairable: false,
      handoff_lane: 'deterministic_parser',
      hypothetical_safe_rule: null,
    });
  }
  if (evidence.food_head_absent) {
    return Object.freeze({
      disposition: 'intentional_human_identity_choice' as const,
      evidence: 'authored_line_names_no_discriminating_food' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
    });
  }
  if (evidence.container_noun_in_head) {
    return Object.freeze({
      disposition: 'normalization_or_tokenization_gap' as const,
      evidence: 'container_noun_in_food_head' as const,
      repairable: false,
      handoff_lane: 'deterministic_parser',
      hypothetical_safe_rule: null,
    });
  }
  if (evidence.declared_qualifier_in_head) {
    return Object.freeze({
      disposition: 'normalization_or_tokenization_gap' as const,
      evidence: 'declared_qualifier_token_in_food_head' as const,
      repairable: false,
      handoff_lane: 'deterministic_parser',
      hypothetical_safe_rule: null,
    });
  }

  // 3. THE ONLY REPAIRABLE CLASS. The current bounded window ALREADY determines
  //    one identity: exactly one candidate satisfies every authored food-head
  //    token, every competitor violates at least one, that winner is not
  //    forbidden, and the recipe does not forbid an automatic bind. Anything less
  //    determinate is NOT repairable, however plausible it looks to a human.
  if (
    evidence.satisfying_candidate_ids.length === 1 &&
    !evidence.all_satisfying_forbidden &&
    !evidence.expect_no_automatic
  ) {
    return Object.freeze({
      disposition: 'repairable_deterministic_identity_defect' as const,
      evidence: 'single_safe_candidate_withheld' as const,
      repairable: true,
      handoff_lane: 'deterministic_identity',
      hypothetical_safe_rule: 'unique_satisfying_candidate_auto_bind' as const,
    });
  }

  // 4. Every candidate that satisfies the authored head is forbidden by checked-in
  //    corpus knowledge, so there is no authorized identity to bind. This is the
  //    safety-critical refusal: it is exactly the `sardines in tomato sauce`
  //    family the corpus already forbids.
  if (
    evidence.satisfying_candidate_ids.length > 0 &&
    evidence.all_satisfying_forbidden
  ) {
    return Object.freeze({
      disposition: 'specificity_not_authorized' as const,
      evidence: 'all_satisfying_candidates_forbidden' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
    });
  }

  // 5. Several candidates satisfy the authored head. Choosing one would
  //    manufacture certainty; refusing is correct.
  if (evidence.satisfying_candidate_ids.length > 1) {
    return Object.freeze({
      disposition: 'ambiguous_identity_requires_review' as const,
      evidence: 'multiple_plausible_candidates' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
    });
  }

  // 6. Nothing in the window satisfies the authored head, yet the catalog is not
  //    empty for this food family. That is a candidate-generation gap, NOT proof
  //    of a repairable defect: any bind would still need a safe rule, and none is
  //    authorized here.
  if (evidence.satisfying_candidate_ids.length === 0) {
    if ((evidence.head_probe_total ?? 0) > 0 || (evidence.head_probe_drop_leading_total ?? 0) > 0) {
      return Object.freeze({
        disposition: 'catalog_candidate_generation_gap' as const,
        evidence: 'catalog_probe_finds_candidate_but_window_empty' as const,
        repairable: false,
        handoff_lane: 'needs_recon',
        hypothetical_safe_rule: null,
      });
    }
    return Object.freeze({
      disposition: 'specificity_not_authorized' as const,
      evidence: 'no_authorized_record_for_authored_specificity' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      hypothetical_safe_rule: null,
    });
  }

  // 7. Unreachable in practice (predicates above are total); kept so the function
  //    can never return an unclassified line.
  return Object.freeze({
    disposition: 'needs_identity_recon' as const,
    evidence: 'insufficient_evidence_for_classification' as const,
    repairable: false,
    handoff_lane: 'needs_recon',
    hypothetical_safe_rule: null,
  });
}

// ---------------------------------------------------------------------------
// Hypothetical-rule simulation contract
// ---------------------------------------------------------------------------

/** What one SIMULATED hypothetical rule would do. Never executed in production. */
export interface Ai6b3RuleSimulation {
  readonly rule_id: Ai6b3HypotheticalSafeRule;
  /** What the rule asserts, in one bounded sentence. */
  readonly assertion: string;
  /** Identity-lane lines this rule would newly bind. */
  readonly identity_lane_new_bindings: number;
  /** Every corpus line (all 207) this rule would newly bind. */
  readonly corpus_new_bindings: number;
  /** Already-auto-binding lines whose bound identity this rule would change. */
  readonly corpus_changed_bindings: number;
  /** Known-good oracle lines whose bound identity this rule would change. */
  readonly oracle_divergences: number;
  /** New binds that violate `expectNoAutomatic`. */
  readonly expect_no_automatic_violations: number;
  /** New binds that violate `forbiddenAutoFdcs`. */
  readonly forbidden_fdc_violations: number;
  /** New binds whose description matches a `forbiddenAutoDescription`. */
  readonly forbidden_description_violations: number;
  /** New binds landing on a documented food-inside-preparation safety line. */
  readonly safety_history_bindings: number;
  /**
   * True only when the rule changes NOTHING currently bound, breaks NO checked-in
   * constraint, adds NO safety-history binding, and has at least one identity-lane
   * witness. Anything else is not repairable in its current form.
   */
  readonly repairable_eligible: boolean;
  /** Bounded reason for the eligibility verdict. */
  readonly eligibility_reason: string;
}