/**
 * The Kitchen Codex — Advanced Nutrition AI-6B5: CATALOG disposition and
 * REPAIRABILITY (planning only, zero production consumers).
 *
 * WHY THIS EXISTS
 * ---------------
 * AI-6B2, AI-6B3 and AI-6B4 each measured ZERO actionable defects and marked
 * `deterministic_portion`, `deterministic_identity` and `deterministic_ranking`
 * exhausted. The computed next ADJUDICATION target was `catalog_gap` with 5
 * observed blockers.
 *
 * "CATALOG GAP IS NOT ONE PROBLEM"
 * -------------------------------
 * A catalog-lane blocker can mean several genuinely different things, and
 * collapsing them into one "the catalog is missing something" bucket is exactly
 * how a roadmap gets misled. This module keeps them apart:
 *
 *   A. the pinned catalog genuinely lacks the authored food family
 *   B. the catalog holds related records but not the authored specificity
 *   C. the record EXISTS but the candidate/search surface never surfaces it
 *   D. a container/package has no authored net mass (an external fact, not an
 *      identity fact at all)
 *   E. identity exists but usable portion evidence is the real gap
 *   F. resolving would need a food equivalence nobody owns
 *
 * CATALOG ABSENCE IS NOT MATCHER FAILURE
 * -------------------------------------
 * If an authorized record exists in the authenticated pinned bundle but search
 * never surfaces it, that is NOT catalog absence. This module reports the two
 * facts separately and never uses "catalog gap" as shorthand for "the matcher
 * didn't find it".
 *
 * WHAT IT IS NOT
 * --------------
 * It grants no authority, binds no FDC, changes no production behavior, and adds
 * no food-specific exception table or equivalence table. It never genericizes a
 * branded food, never infers package net mass from a typical retail size, and
 * never reaches for a live or external USDA source. Pure, offline,
 * deterministic: no clock, randomness, hostname, absolute path, or
 * environment-dependent field, so two runs are byte-identical.
 */

/** Explicit planning-artifact schema version (independent of every recon schema). */
export const CATALOG_DISPOSITION_SCHEMA = 'nutrition_ai6b5_catalog_disposition_v1';

// ---------------------------------------------------------------------------
// CLOSED disposition vocabulary
// ---------------------------------------------------------------------------

/**
 * What KIND of problem a catalog-lane blocker actually is.
 *
 * The distinction that matters: only `repairable_catalog_surface_defect` means
 * "an authorized record already exists in the pinned bundle, the authored
 * identity safely determines it, and the catalog/search/index surface is what
 * fails to expose it". Everything else is a true absence, an external fact that
 * was never authored, work owned by another lane, or a decision that would
 * require inventing equivalence.
 */
export const CATALOG_DISPOSITIONS = [
  /**
   * The required authorized record ALREADY exists in the pinned bundle, the
   * authored identity safely determines it, the catalog/search/index machinery
   * fails to expose it, no branded or generic equivalence must be invented, and
   * a GENERAL deterministic rule can repair the surface without touching the
   * parser, matcher, normalizer, or portion logic. A real bug class, so the
   * member exists even when the measured count is zero.
   */
  'repairable_catalog_surface_defect',
  /**
   * The required catalog record EXISTS in the authenticated bundle but the
   * current deterministic candidate/search surface does not expose it. This is
   * NOT catalog absence — and the repair it implies is usually owned by a
   * different lane (tokenization, candidate generation, or identity), which is
   * why it is a HANDOFF rather than catalog repair work.
   */
  'candidate_generation_handoff',
  /**
   * The pinned catalog genuinely contains NO authorized record satisfying the
   * authored food identity. Adding one would require new external data.
   */
  'authenticated_catalog_absence',
  /**
   * The authored commercial identity is more specific than the pinned catalog
   * can express. Genericizing it into an arbitrary generic product would invent
   * a formulation, which a brand name is never permission to do.
   */
  'branded_specificity_not_in_catalog',
  /**
   * A related generic record exists, but binding it would assert a food
   * equivalence the authored wording does not make.
   */
  'generic_substitution_not_authorized',
  /**
   * Food identity is not the problem: a container/package authored with NO net
   * mass. The missing fact is an external package fact that was never authored
   * and must never be inferred from a typical retail size or another brand.
   */
  'container_net_mass_absent_from_authored_text',
  /**
   * The identity exists, but compatible deterministic PORTION authority is the
   * actual missing fact. That is portion authority, not catalog identity.
   */
  'portion_authority_handoff',
  /**
   * The observed blocker belongs to another lane. Reported, never acted on by
   * rewriting AI-6A blocker history.
   */
  'catalog_blocker_misclassified',
  /** Insufficient evidence for a safe conclusion. */
  'needs_catalog_recon',
] as const;

export type Ai6b5CatalogDisposition = (typeof CATALOG_DISPOSITIONS)[number];

const DISPOSITION_SET: ReadonlySet<string> = new Set(CATALOG_DISPOSITIONS);

/** Closed membership test for the disposition vocabulary. */
export function isAi6b5CatalogDisposition(value: unknown): value is Ai6b5CatalogDisposition {
  return typeof value === 'string' && DISPOSITION_SET.has(value);
}

// ---------------------------------------------------------------------------
// CLOSED evidence vocabulary
// ---------------------------------------------------------------------------

/** A bounded, machine-checkable REASON for a disposition. */
export const CATALOG_EVIDENCE_CODES = [
  /** No authorized record matching the authored food identity exists in the bundle. */
  'exact_authored_record_absent_from_bundle',
  /** A broader related family exists, but it is not the authored food. */
  'broader_generic_family_exists_but_not_equivalent',
  /** An authorized record exists in the bundle but the search surface returns none. */
  'exact_record_present_but_surface_returns_nothing',
  /** The repair implied is tokenization/candidate generation, not the catalog surface. */
  'repair_owned_by_tokenization_not_catalog_surface',
  /** The authored brand has no record, and generic records are not equivalent. */
  'brand_record_absent_and_generic_not_equivalent',
  /** A container/package authored with no net mass; mass was never authored. */
  'authored_package_net_mass_absent',
  /** Identity is available but usable portion authority is not. */
  'identity_present_but_portion_authority_absent',
  /** The observed blocker routes to a different lane. */
  'blocker_belongs_to_another_lane',
  /** Classification could not be completed from measured evidence. */
  'insufficient_evidence_for_conclusion',
] as const;

export type Ai6b5CatalogEvidenceCode = (typeof CATALOG_EVIDENCE_CODES)[number];

const EVIDENCE_SET: ReadonlySet<string> = new Set(CATALOG_EVIDENCE_CODES);

/** Closed membership test for the evidence vocabulary. */
export function isAi6b5CatalogEvidenceCode(value: unknown): value is Ai6b5CatalogEvidenceCode {
  return typeof value === 'string' && EVIDENCE_SET.has(value);
}

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

/** All evidence the classifier needs, gathered READ-ONLY from the pinned bundle. */
export interface Ai6b5CatalogEvidence {
  /** True when the line authors a container/package noun. */
  readonly container_authored: boolean;
  /** True when the recipe declared a package net mass. */
  readonly package_net_mass_declared: boolean;
  /** True when the line carries brand/commercial specificity. */
  readonly brand_specificity: boolean;
  /** The direct bounded search over the authored food head returns records. */
  readonly exact_identity_found: boolean;
  /**
   * An authorized record exists but only under a separated/orthographic form of
   * the authored compound, which the direct search surface never reaches.
   */
  readonly exact_identity_found_via_variant: boolean;
  /**
   * True when that variant surface resolves to EXACTLY ONE record. A variant
   * surface that returns several materially different foods (for example plain
   * crumbs, SEASONED crumbs and a cake) cannot be repaired generically: choosing
   * among them needs a food-specific discrimination rule, which AI-6B5 must not
   * invent. Measured, not assumed.
   */
  readonly variant_surface_unambiguous: boolean;
  /** A broader related family exists in the bundle. */
  readonly broader_generic_family_exists: boolean;
  /** True when the exact identity record carries compatible portion authority. */
  readonly portion_authority_available: boolean;
  /** True when the line forbids any automatic identity (`expectNoAutomatic`). */
  readonly expect_no_automatic: boolean;
  /** True when the surfaced candidate violates a forbidden corpus constraint. */
  readonly surfaced_candidate_forbidden: boolean;
  /**
   * True when a branded or commercial token would have to be dropped for a
   * surfaced candidate to be usable. Deleting brand tokens is never permitted as
   * a route to repairability.
   */
  readonly would_require_dropping_brand_token: boolean;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface Ai6b5CatalogVerdict {
  readonly disposition: Ai6b5CatalogDisposition;
  readonly evidence: Ai6b5CatalogEvidenceCode;
  /** True only for a genuine, general, catalog-surface defect. */
  readonly repairable: boolean;
  /** Closed handoff lane for non-repairable work, else null. */
  readonly handoff_lane: string | null;
  /**
   * True when the disposition implies work owned by a DIFFERENT lane than the
   * catalog. Reported so lane ownership stays explicit.
   */
  readonly owned_by_other_lane: boolean;
}

/**
 * Maps evidence to exactly ONE disposition plus ONE evidence code.
 *
 * Ordered so that external-fact absence is never misreported as identity
 * absence, and so that a branded identity is refused before any generic record
 * is ever considered. Total: every input yields a verdict.
 */
export function classifyCatalogDisposition(
  evidence: Ai6b5CatalogEvidence
): Ai6b5CatalogVerdict {
  // 1. A branded/commercial identity is never genericized. Even when a related
  //    generic record exists, binding it asserts a formulation the recipe never
  //    stated, and a brand name is never permission to guess.
  if (evidence.brand_specificity) {
    const genericExists = evidence.broader_generic_family_exists;
    return Object.freeze({
      disposition: 'branded_specificity_not_in_catalog' as const,
      evidence: 'brand_record_absent_and_generic_not_equivalent' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      owned_by_other_lane: false,
    });
  }

  // 2. A container/package with NO authored net mass is an EXTERNAL FACT absent,
  //    not a catalog identity failure. The food may exist perfectly well. Mass
  //    must never be inferred from a typical retail size, another brand, or a
  //    USDA serving size.
  if (evidence.container_authored && !evidence.package_net_mass_declared) {
    return Object.freeze({
      disposition: 'container_net_mass_absent_from_authored_text' as const,
      evidence: 'authored_package_net_mass_absent' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
      owned_by_other_lane: true,
    });
  }

  // 3. THE ONLY REPAIRABLE CLASS. The authorized record already exists in the
  //    pinned bundle, the authored identity safely determines it, the variant
  //    surface resolves to exactly ONE record so no food-specific discrimination
  //    rule is needed, no branded or generic equivalence must be invented, no
  //    brand token may be dropped, and the defect is genuinely in the
  //    catalog/search/index surface.
  if (
    evidence.exact_identity_found_via_variant &&
    evidence.variant_surface_unambiguous &&
    evidence.portion_authority_available &&
    !evidence.expect_no_automatic &&
    !evidence.surfaced_candidate_forbidden &&
    !evidence.would_require_dropping_brand_token
  ) {
    return Object.freeze({
      disposition: 'repairable_catalog_surface_defect' as const,
      evidence: 'exact_record_present_but_surface_returns_nothing' as const,
      repairable: true,
      handoff_lane: 'catalog_gap',
      owned_by_other_lane: false,
    });
  }

  // 4. The correct record EXISTS in the authenticated bundle but the search
  //    surface never reaches it. This is NOT catalog absence — and it is NOT
  //    generically repairable here, because isolating the right record from the
  //    records the surface does reach needs a food-specific discrimination rule.
  //    It is a HANDOFF to the lane that owns tokenization / candidate generation.
  if (evidence.exact_identity_found_via_variant) {
    return Object.freeze({
      disposition: 'candidate_generation_handoff' as const,
      evidence: 'repair_owned_by_tokenization_not_catalog_surface' as const,
      repairable: false,
      handoff_lane: 'deterministic_identity',
      owned_by_other_lane: true,
    });
  }

  // 5. The identity EXISTS on the direct surface. That is never catalog absence.
  //    If usable portion authority is what is missing, the blocker belongs to the
  //    portion lane; if even that is present, the blocker is misclassified,
  //    because a catalog-gap blocker requires that the catalog cannot serve the
  //    authored identity at all.
  if (evidence.exact_identity_found) {
    if (!evidence.portion_authority_available) {
      return Object.freeze({
        disposition: 'portion_authority_handoff' as const,
        evidence: 'identity_present_but_portion_authority_absent' as const,
        repairable: false,
        handoff_lane: 'deterministic_portion',
        owned_by_other_lane: true,
      });
    }
    return Object.freeze({
      disposition: 'catalog_blocker_misclassified' as const,
      evidence: 'blocker_belongs_to_another_lane' as const,
      repairable: false,
      handoff_lane: 'needs_recon',
      owned_by_other_lane: true,
    });
  }

  // 6. A broader related family may exist, but binding it would assert an
  //    equivalence the recipe never made.
  if (evidence.broader_generic_family_exists) {
    return Object.freeze({
      disposition: 'generic_substitution_not_authorized' as const,
      evidence: 'broader_generic_family_exists_but_not_equivalent' as const,
      repairable: false,
      handoff_lane: 'intentional_human_review',
      owned_by_other_lane: false,
    });
  }

  // 7. Genuine authenticated absence: the family itself is not represented.
  return Object.freeze({
    disposition: 'authenticated_catalog_absence' as const,
    evidence: 'exact_authored_record_absent_from_bundle' as const,
    repairable: false,
    handoff_lane: 'needs_recon',
    owned_by_other_lane: false,
  });
}