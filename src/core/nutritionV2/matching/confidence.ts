/**
 * The Kitchen Codex — Advanced Nutrition post-Phase-5 smoke-test remediation:
 * deterministic match-confidence contract.
 *
 * PURE, offline, explainable. This module is the ONE authority for deciding
 * whether a ranked candidate is safe to auto-select. It never uses AI, network
 * data, nutrient values, floating-point ML-style scores, or the stable FDC-id
 * tie-break to manufacture authority. Confidence derives ONLY from explicit,
 * deterministic evidence about the query's CORE food identity and its
 * qualifiers/forms/variants.
 *
 * CONTRACT
 * --------
 *   high       safe to auto-select (the application may pre-select this food);
 *   review     credible best candidate, but a human must confirm/review;
 *   unresolved no trustworthy automatic selection.
 *
 * A candidate is HIGH only when it is an exact phrase / exact token multiset, or
 * when it contains every CORE identity token with no qualifier opposition, no
 * qualifier/form conflicts, no absent requested qualifier/form, no compound-food
 * demotion, NO unrequested material variant (`Apple, dried` for `apple`,
 * `Eggs, scrambled, frozen mixture` for `scrambled eggs`), and NO unrequested
 * cooking/preparation method (`Egg, whole, fried, NS as to fat` for a bare
 * `egg`). An explicitly requested derived component (`beef fat`) is satisfied
 * only by a structural component, never by a composition descriptor
 * (`Beef, steak, ribeye, lean and fat eaten`).
 *
 * RUNNER-UP AMBIGUITY
 * -------------------
 * The stable FDC-id tie-break is presentation-only. Before returning an automatic
 * selection, the runner-up set is inspected: if any candidate ties the top on the
 * AUTO-AUTHORITY key (identity + requested specificity only; it excludes
 * `extra_candidate_token_count`, `order_agreement`, and the display-only subtype
 * demotion) AND differs in an UNREQUESTED MATERIAL SUBTYPE (`whole`/`nonfat`/
 * `heavy`/`half`/`salted`/`dried`/`enriched`/zero-padded numeric grind), no
 * automatic selection is authorized. Benign descriptive differences (verbose
 * USDA wording, cooking method, color, `whole` as the ordinary member, and
 * health-claim modifiers) do NOT make two records ambiguous. This is what stops
 * a bare `cream` from auto-selecting `Cream, heavy` over `Cream, light`/`half
 * and half`, and a bare `powdered milk` from inventing a fat class, without
 * over-blocking every verbose sibling record.
 *
 * This module is NOT re-exported from any public production barrel; the Phase 4
 * presentation layer imports it explicitly.
 */

import {
  candidateSubtypeDiffers,
  compoundPenaltyCount,
  compoundProductPenaltyCount,
  familyMismatchCount,
  genericMarkerCount,
  impliedStateCompatibilityMismatchCount,
  missingCoreTokenCount,
  missingFormTokenCount,
  missingQualifierTokenCount,
  preparationFormContradictionCount,
  preparedProductFormCount,
  projectQueryText,
  qualifierAgreementCount,
  qualifierConflictCount,
  qualifierOppositionCount,
  secondaryComponentOnlyMatchCount,
  stateContradictionCount,
  tokensEquivalent,
  unrequestedCookingMethodCount,
  unrequestedFormTokenCount,
  unrequestedMaterialVariantCount,
  unrequestedMaterialVarietyCount,
  unrequestedSpecialtyCount,
  unrequestedVarietyCount,
  varietyContradictionCount,
  type IngredientQueryProjection,
  type QueryProjectionContext,
} from './query';
import type { IngredientReviewResult, RankedCandidate } from './types';

export const MATCH_CONFIDENCE_VERSION = 'usda_match_confidence_v13';

export type MatchConfidence = 'high' | 'review' | 'unresolved';

/** Bounded, explainable evidence for one candidate against one query. */
export interface CandidateExplanation {
  readonly version: string;
  readonly match_class: string;
  readonly core_tokens: ReadonlyArray<string>;
  readonly qualifier_tokens: ReadonlyArray<string>;
  readonly form_tokens: ReadonlyArray<string>;
  readonly missing_core_tokens: number;
  readonly family_mismatch: number;
  readonly prepared_product_forms: number;
  readonly qualifier_conflicts: number;
  readonly qualifier_opposition: number;
  readonly qualifier_agreement: number;
  readonly missing_qualifier_tokens: number;
  readonly missing_form_tokens: number;
  readonly unrequested_variety: number;
  readonly material_variety: number;
  readonly compound_penalty: number;
  readonly compound_product_penalty: number;
  readonly unrequested_material_variants: number;
  readonly unrequested_cooking_methods: number;
  readonly generic_marker: number;
  /**
   * Phase 2 STATE-CONTRADICTION count: requested physical states the candidate
   * explicitly contradicts through a closed opposite pair (`drained` vs
   * `undrained`, `ground` vs `whole`, `fresh` vs `dried`/`frozen`, ...). Any
   * positive value withholds automatic authority. Negative evidence only.
   */
  readonly state_contradiction: number;
  /**
   * Container-implied state compatibility: 1 when a `can` line's implied
   * `canned` state is not honored by an explicit canned token or a generic
   * family record (`NFS`/`NS`/`unspecified`). Any positive value withholds
   * automatic authority. Negative evidence only.
   */
  readonly implied_state_mismatch: number;
  /**
   * Phase 2 PREPARATION-FORM CONTRADICTION: 1 when the query explicitly requests
   * a recognized preparation form and the candidate explicitly declares a
   * different incompatible form (`diced` vs `crushed`, `sliced` vs `whole`).
   * Any positive value withholds automatic authority. A candidate silent about
   * preparation form is neutral (0). Negative evidence only.
   */
  readonly preparation_form_contradiction: number;
  /**
   * Phase 3 EXPLICIT VARIETY CONTRADICTION: 1 when the query names a
   * variety/color/cultivar and the candidate explicitly names a different one
   * (`white rice` vs `Rice, red`). Any positive value withholds automatic
   * authority. A candidate silent about variety is neutral, not a contradiction.
   */
  readonly variety_contradiction: number;
  /**
   * Phase 3 UNREQUESTED SPECIALTY VARIANT count: candidate specialty modifiers
   * (`flavored`, `fortified`, `seasoned`, `colored`, `spinach`, `chili`) that the
   * query did not request. Any positive value withholds automatic authority and
   * demotes the candidate below the plain family member.
   */
  readonly unrequested_specialty: number;
  /**
   * Phase 0A SECONDARY-COMPONENT-ONLY count: positive when every matched query
   * identity token identifies only a relational/flavor secondary component of
   * the candidate (the candidate's primary food is absent from the query).
   * Surfaced here as bounded explanation evidence; the Phase 0A guard itself
   * remains the owner of the withholding decision through `family_mismatch`.
   */
  readonly secondary_component_only: number;
  readonly automatic_eligible: boolean;
  /**
   * True when the candidate is a safe SAME-FAMILY best-effort default: full core
   * identity, same family, no requested qualifier/form missing, no contradiction,
   * and no unrequested material state/cooking/prepared/composed product. It
   * deliberately tolerates BENIGN ordinary variation (color/level variety and
   * non-material subtype) so a one-click analysis can choose a reasonable default
   * without forcing USDA taxonomy review. It never crosses a material food-family
   * boundary.
   */
  readonly same_family_default_eligible: boolean;
  readonly reasons: ReadonlyArray<string>;
}

const EMPTY_PROJECTION: IngredientQueryProjection = Object.freeze({
  version: '',
  food_identity: '',
  food_tokens: Object.freeze([] as string[]),
  core_tokens: Object.freeze([] as string[]),
  primary_identity_tokens: Object.freeze([] as string[]),
  qualifier_tokens: Object.freeze([] as string[]),
  state_tokens: Object.freeze([] as string[]),
  form_tokens: Object.freeze([] as string[]),
  variety_tokens: Object.freeze([] as string[]),
  refinement_tokens: Object.freeze([] as string[]),
  alternative_groups: Object.freeze([]),
  anchor_groups: Object.freeze([]),
  measurement_tokens: Object.freeze([] as string[]),
  size_qualifiers: Object.freeze([] as string[]),
  preparation_qualifiers: Object.freeze([] as string[]),
  notes: Object.freeze([] as string[]),
  numeric_qualifiers: Object.freeze([] as string[]),
  aliases: Object.freeze([] as string[]),
  secondary_component_tokens: Object.freeze([] as string[]),
  count_noun: null,
  container: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function candidateTokensOf(candidate: unknown): ReadonlyArray<string> {
  if (!isRecord(candidate)) return [];
  const text = typeof candidate.normalized_description === 'string' ? candidate.normalized_description : '';
  return text.length === 0 ? [] : text.split(' ').filter(Boolean);
}

/**
 * True when two candidates name the SAME food head. The head noun (first token)
 * of each must appear (morphologically equivalent) in the other's tokens. This
 * admits `Flour, wheat, ...` / `Wheat flour, ...` and `Cornmeal, blue` /
 * `Cornmeal, whole-grain` while excluding a different food whose head is a
 * foreign noun (`Yogurt, ... milk` is not `milk`).
 */
function headTokensOverlap(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>
): boolean {
  const headA = a[0];
  const headB = b[0];
  if (headA === undefined || headB === undefined) return false;
  const aHasHeadB = a.some((token) => tokensEquivalent(token, headB));
  const bHasHeadA = b.some((token) => tokensEquivalent(token, headA));
  return aHasHeadB && bHasHeadA;
}

function projectionFor(
  normalizedQuery: string,
  context?: QueryProjectionContext
): IngredientQueryProjection {
  try {
    return projectQueryText(normalizedQuery, context);
  } catch {
    return EMPTY_PROJECTION;
  }
}

/**
 * Bounded Phase 1 context extracted from a review snapshot. Only the canonical
 * count/container nouns are read (amount metadata, never identity), and the
 * projection validates them again; an unsafe/oversized value is ignored. Every
 * automatic-authority decision runs against a FRESH review computed from the raw
 * ingredient, so a caller cannot gain authority by injecting metadata into a
 * stale serialized review.
 */
function reviewContext(review: IngredientReviewResult | undefined): QueryProjectionContext | undefined {
  if (review === undefined || review === null || typeof review !== 'object') return undefined;
  const context: { count_noun?: string; container?: string } = {};
  if (typeof review.count_noun === 'string') context.count_noun = review.count_noun;
  if (typeof review.container === 'string') context.container = review.container;
  return context.count_noun === undefined && context.container === undefined ? undefined : context;
}

function ineligibleExplanation(): CandidateExplanation {
  return Object.freeze({
    version: MATCH_CONFIDENCE_VERSION,
    match_class: 'no_match',
    core_tokens: Object.freeze([] as string[]),
    qualifier_tokens: Object.freeze([] as string[]),
    form_tokens: Object.freeze([] as string[]),
  missing_core_tokens: 0,
  family_mismatch: 0,
  prepared_product_forms: 0,
  qualifier_conflicts: 0,
    qualifier_opposition: 0,
    qualifier_agreement: 0,
    missing_qualifier_tokens: 0,
    missing_form_tokens: 0,
    unrequested_variety: 0,
    material_variety: 0,
    compound_penalty: 0,
    compound_product_penalty: 0,
    unrequested_material_variants: 0,
    unrequested_cooking_methods: 0,
    generic_marker: 0,
    state_contradiction: 0,
    implied_state_mismatch: 0,
    preparation_form_contradiction: 0,
    variety_contradiction: 0,
    unrequested_specialty: 0,
    secondary_component_only: 0,
    automatic_eligible: false,
    same_family_default_eligible: false,
    reasons: Object.freeze(['invalid_candidate']),
  });
}

/**
 * Explains one candidate's deterministic evidence. Never throws; a malformed
 * candidate yields an ineligible explanation.
 */
export function explainCandidate(
  normalizedQuery: string,
  candidate: RankedCandidate,
  context?: QueryProjectionContext
): CandidateExplanation {
  if (!isRecord(candidate) || typeof candidate.match_class !== 'string') {
    return ineligibleExplanation();
  }
  const projection = projectionFor(typeof normalizedQuery === 'string' ? normalizedQuery : '', context);
  const tokens = candidateTokensOf(candidate);
  const missingCore = missingCoreTokenCount(tokens, projection);
  const familyMismatch = familyMismatchCount(tokens, projection);
  const preparedProduct = preparedProductFormCount(tokens, projection, candidate.data_type);
  const conflicts = qualifierConflictCount(tokens, projection);
  const opposition = qualifierOppositionCount(tokens, projection);
  const agreement = qualifierAgreementCount(tokens, projection);
  const missingQualifier = missingQualifierTokenCount(tokens, projection);
  const missingForm = missingFormTokenCount(tokens, projection);
  const unrequestedVariety = unrequestedVarietyCount(tokens, projection);
  const materialVariety = unrequestedMaterialVarietyCount(tokens, projection);
  const unrequestedForm = unrequestedFormTokenCount(tokens, projection);
  const stateContradiction = stateContradictionCount(tokens, projection);
  const impliedStateMismatch = impliedStateCompatibilityMismatchCount(tokens, projection);
  const preparationFormContradiction = preparationFormContradictionCount(tokens, projection);
  const varietyContradiction = varietyContradictionCount(tokens, projection);
  const unrequestedSpecialty = unrequestedSpecialtyCount(tokens, projection);
  const secondaryOnly = secondaryComponentOnlyMatchCount(tokens, projection);
  // Numeric qualifiers (`80 20`) are agreement evidence, exactly as in ranking.
  let numericAgreement = 0;
  for (const numeric of projection.numeric_qualifiers) {
    if (tokens.includes(numeric)) numericAgreement += 1;
  }
  const agreementTotal = agreement + numericAgreement;
  const compound = compoundPenaltyCount(tokens, projection);
  const compoundProduct = compoundProductPenaltyCount(tokens, projection);
  const unrequestedVariants = unrequestedMaterialVariantCount(tokens, projection);
  const unrequestedCooking = unrequestedCookingMethodCount(tokens, projection);
  const genericMarker = genericMarkerCount(tokens);
  const exact = candidate.match_class === 'exact_phrase' || candidate.match_class === 'exact_token_multiset';
  // The STRICT automatic-authority contract: no ordinary variety may be invented.
  const automaticEligible =
    exact ||
    (projection.core_tokens.length > 0 &&
      missingCore === 0 &&
      familyMismatch === 0 &&
      preparedProduct === 0 &&
      conflicts === 0 &&
      opposition === 0 &&
      // A candidate that explicitly contradicts a requested physical state
      // (`drained` vs `undrained`, `ground` vs `whole`, `fresh` vs `dried`) can
      // never be an automatic choice, even when every core token is present.
      stateContradiction === 0 &&
      // A `can` line's implied `canned` state must be honored by an explicit
      // canned token or a generic family record.
      impliedStateMismatch === 0 &&
      // An explicitly different preparation form (`diced` query vs `crushed`
      // candidate) is a material misrepresentation and can never be an automatic
      // choice; candidate silence stays neutral.
      preparationFormContradiction === 0 &&
      // An explicit variety/color contradiction (`Rice, red` for `white rice`)
      // can never be an automatic choice; a silent candidate stays eligible.
      varietyContradiction === 0 &&
      // A specialty variant the query did not request (`spinach` pasta,
      // `flavored` products) is never auto-authorized over the plain food.
      unrequestedSpecialty === 0 &&
      missingQualifier === 0 &&
      missingForm === 0 &&
      unrequestedVariety === 0 &&
      unrequestedForm === 0 &&
      compound === 0 &&
      unrequestedVariants === 0 &&
      unrequestedCooking === 0);
  // The BEST-EFFORT same-family default contract: identical to the strict
  // contract EXCEPT it tolerates benign ordinary variety/level variation, so a
  // one-click analysis can pick a reasonable default for `cornmeal`, `jalapeno`,
  // etc. It still fails closed on every material boundary.
  const sameFamilyDefaultEligible =
    exact ||
    (projection.core_tokens.length > 0 &&
      missingCore === 0 &&
      familyMismatch === 0 &&
      preparedProduct === 0 &&
      conflicts === 0 &&
      opposition === 0 &&
      stateContradiction === 0 &&
      impliedStateMismatch === 0 &&
      preparationFormContradiction === 0 &&
      varietyContradiction === 0 &&
      unrequestedSpecialty === 0 &&
      missingQualifier === 0 &&
      missingForm === 0 &&
      // An unrequested FORM (`Rice, white, with gravy`, `Cheese sandwich`) is a
      // different preparation/product form, never a benign same-family sibling.
      unrequestedForm === 0 &&
      // A compound (`Rice milk`, `Rice pilaf`, `Peanut butter`) is a different
      // product. Ordinary descriptor modifiers (`double-acting`) are exempted
      // via the descriptor vocabulary, so `baking powder` is not a compound.
      compound === 0 &&
      // A named specialty cultivar (`Beans, Dry, Tan`, `Rice, black`,
      // `Wild rice`) is a different food within the family, never the ordinary
      // default. An explicit cultivar query is honored (the token is requested).
      materialVariety === 0 &&
      unrequestedVariants === 0 &&
      unrequestedCooking === 0);

  const reasons: string[] = [];
  if (exact) reasons.push('exact');
  if (missingCore > 0) reasons.push('missing_core_identity');
  if (familyMismatch > 0) reasons.push('food_family_mismatch');
  if (secondaryOnly > 0) reasons.push('secondary_component_only');
  if (stateContradiction > 0) reasons.push('state_contradiction');
  if (impliedStateMismatch > 0) reasons.push('container_state_incompatible');
  if (preparationFormContradiction > 0) reasons.push('preparation_form_contradiction');
  if (varietyContradiction > 0) reasons.push('variety_contradiction');
  if (unrequestedSpecialty > 0) reasons.push('unrequested_specialty');
  if (preparedProduct > 0) reasons.push('prepared_product_form');
  if (conflicts > 0) reasons.push('qualifier_or_form_conflict');
  if (opposition > 0) reasons.push('qualifier_opposition');
  if (missingQualifier > 0) reasons.push('missing_requested_qualifier');
  if (missingForm > 0) reasons.push('missing_requested_form');
  if (unrequestedVariety > 0) reasons.push('unrequested_variety');
  if (materialVariety > 0) reasons.push('material_variety');
  if (compound > 0) reasons.push('compound_food');
  if (unrequestedVariants > 0) reasons.push('unrequested_material_variant');
  if (unrequestedCooking > 0) reasons.push('unrequested_preparation_state');

  return Object.freeze({
    version: MATCH_CONFIDENCE_VERSION,
    match_class: candidate.match_class,
    core_tokens: Object.freeze([...projection.core_tokens]),
    qualifier_tokens: Object.freeze([...projection.qualifier_tokens]),
    form_tokens: Object.freeze([...projection.form_tokens]),
    missing_core_tokens: missingCore,
    family_mismatch: familyMismatch,
    prepared_product_forms: preparedProduct,
    qualifier_conflicts: conflicts,
    qualifier_opposition: opposition,
    qualifier_agreement: agreementTotal,
    missing_qualifier_tokens: missingQualifier,
    missing_form_tokens: missingForm,
    unrequested_variety: unrequestedVariety,
    material_variety: materialVariety,
    compound_penalty: compound,
    compound_product_penalty: compoundProduct,
    unrequested_material_variants: unrequestedVariants,
    unrequested_cooking_methods: unrequestedCooking,
    generic_marker: genericMarker,
    state_contradiction: stateContradiction,
    implied_state_mismatch: impliedStateMismatch,
    preparation_form_contradiction: preparationFormContradiction,
    variety_contradiction: varietyContradiction,
    unrequested_specialty: unrequestedSpecialty,
    secondary_component_only: secondaryOnly,
    automatic_eligible: automaticEligible,
    same_family_default_eligible: sameFamilyDefaultEligible,
    reasons: Object.freeze(reasons),
  });
}

function isReviewLike(review: unknown): review is IngredientReviewResult {
  if (!isRecord(review)) return false;
  const outcome = review.outcome;
  return outcome === 'matched_exact' || outcome === 'review_required' || outcome === 'unmatched' || outcome === 'invalid';
}

/** Classifies one ingredient review snapshot into the confidence contract. */
export function classifyReviewConfidence(review: IngredientReviewResult): MatchConfidence {
  if (!isReviewLike(review)) return 'unresolved';
  if (review.outcome === 'matched_exact') return 'high';
  if (review.outcome !== 'review_required') return 'unresolved';
  const candidates = Array.isArray(review.candidates) ? review.candidates : [];
  const top = candidates[0];
  if (!top) return 'unresolved';
  const normalized = typeof review.normalized_query === 'string' ? review.normalized_query : '';
  if (normalized.length === 0) return 'review';
  const explanation = explainCandidate(normalized, top, reviewContext(review));
  if (explanation.automatic_eligible) return 'high';
  // A credible but not auto-eligible match: all core identity tokens present and
  // no qualifier opposition. This is "review suggested", never automatic.
  if (explanation.missing_core_tokens === 0 && explanation.qualifier_opposition === 0) {
    return 'review';
  }
  return 'unresolved';
}

export interface AutomaticSelection {
  readonly fdc_id: number;
  readonly match_class: string;
  readonly confidence: 'high';
  readonly explanation: CandidateExplanation;
}

/**
 * The AUTO-AUTHORITY equivalence key. It contains ONLY the dimensions that prove
 * food identity and requested specificity (match class, core coverage, family,
 * qualifier conflict/opposition/agreement, requested qualifier/form coverage,
 * unrequested variety, compound demotion, unrequested material variants).
 *
 * It deliberately EXCLUDES presentation-quality dimensions
 * (`extra_candidate_token_count`, `order_agreement`) and the display-only
 * generic-marker preference. Those dimensions separate verbose USDA descriptions
 * without proving that two candidates are the same food, so including them would
 * let the lowest-FDC-id materially different sibling gain automatic authority
 * (`Cream, heavy` vs `Cream, light`/`half and half`,
 * `Milk, dry, whole` vs `Milk, dry, nonfat`). The stable FDC-id tie-break remains
 * presentation-only.
 */
function semanticKey(explanation: CandidateExplanation, _candidate: RankedCandidate): string {
  return JSON.stringify([
    explanation.match_class,
    explanation.missing_core_tokens,
    explanation.family_mismatch,
    explanation.qualifier_conflicts,
    explanation.qualifier_opposition,
    explanation.qualifier_agreement,
    explanation.missing_qualifier_tokens,
    explanation.missing_form_tokens,
    explanation.unrequested_variety,
    explanation.compound_penalty,
    explanation.unrequested_material_variants,
    explanation.unrequested_cooking_methods,
  ]);
}

/**
 * Returns the deterministic automatic selection for one review, or undefined
 * when the contract does not authorize one. The stable FDC-id tie-break can
 * never produce an automatic selection: a materially different candidate that
 * ties the top on the semantic ranking tuple fails the whole auto-selection.
 */
export function selectAutomaticMatch(review: IngredientReviewResult): AutomaticSelection | undefined {
  if (!isReviewLike(review)) return undefined;
  const normalized = typeof review.normalized_query === 'string' ? review.normalized_query : '';
  const candidates = Array.isArray(review.candidates) ? review.candidates : [];

  if (review.outcome === 'matched_exact') {
    const selected = candidates.find((candidate) => candidate.fdc_id === review.selected_fdc_id);
    if (!selected) return undefined;
    return Object.freeze({
      fdc_id: selected.fdc_id,
      match_class: selected.match_class,
      confidence: 'high' as const,
      explanation: explainCandidate(normalized, selected, reviewContext(review)),
    });
  }
  if (review.outcome !== 'review_required') return undefined;
  const top = candidates[0];
  if (!top) return undefined;
  if (normalized.length === 0) return undefined;
  const context = reviewContext(review);
  const explanation = explainCandidate(normalized, top, context);
  if (!explanation.automatic_eligible) return undefined;

  // RUNNER-UP AMBIGUITY: the FDC-id tie-break must never manufacture authority.
  const projection = projectionFor(normalized, context);
  const topKey = semanticKey(explanation, top);
  const topTokens = candidateTokensOf(top);
  for (let i = 1; i < candidates.length; i += 1) {
    const other = candidates[i];
    const otherExplanation = explainCandidate(normalized, other, context);
    if (semanticKey(otherExplanation, other) !== topKey) continue;
    if (candidateSubtypeDiffers(topTokens, candidateTokensOf(other), projection)) {
      return undefined;
    }
  }

  return Object.freeze({
    fdc_id: top.fdc_id,
    match_class: top.match_class,
    confidence: 'high' as const,
    explanation,
  });
}

/**
 * The safe SAME-FAMILY best-effort default candidates for one review, in ranking
 * order. A candidate qualifies when it satisfies the full core identity and no
 * material boundary is crossed; BENIGN ordinary variation (color/level variety,
 * non-material subtype) is tolerated. Returns an EMPTY array when:
 *   - the review is not `review_required`;
 *   - no candidate qualifies;
 *   - no otherwise-benign candidate shares the best candidate's food head.
 *
 * The set is intentionally coherent around ONE food: a candidate whose head noun
 * is not the same food (`Yogurt, plain, skim milk` for `milk`) is excluded, so
 * a wrong food can never be claimed as an automatic default or donate a portion.
 */
export function bestEffortDefaultCandidates(
  review: IngredientReviewResult
): ReadonlyArray<RankedCandidate> {
  if (!isReviewLike(review)) return [];
  if (review.outcome !== 'review_required') return [];
  const normalized = typeof review.normalized_query === 'string' ? review.normalized_query : '';
  if (normalized.length === 0) return [];
  const candidates = Array.isArray(review.candidates) ? review.candidates : [];
  const context = reviewContext(review);

  const eligible: RankedCandidate[] = [];
  for (const candidate of candidates) {
    if (explainCandidate(normalized, candidate, context).same_family_default_eligible) {
      eligible.push(candidate);
    }
  }
  if (eligible.length === 0) return [];

  // ONE-FOOD COHERENCE. The best candidate defines the food; only candidates
  // whose head noun mutually overlaps the best candidate's tokens are the same
  // food family (`Wheat flour, ...` vs `Flour, wheat, ...`; `Yogurt, ... milk`
  // is NOT `milk`). Material subtype/variety differences within that food are
  // BENIGN Level-2 defaults and no longer force review.
  const best = eligible[0];
  const bestTokens = candidateTokensOf(best);
  const coherent = eligible.filter((candidate) =>
    headTokensOverlap(bestTokens, candidateTokensOf(candidate))
  );
  return Object.freeze(coherent);
}

/**
 * The subset of best-effort default candidates that may be preferred purely for
 * PORTION availability. Unrequested product FORMS are already excluded by
 * `same_family_default_eligible`, and the one-food coherence filter is applied
 * by `bestEffortDefaultCandidates`, so this is the safe portion-tie set.
 */
export function bestEffortPortionTieCandidates(
  review: IngredientReviewResult
): ReadonlyArray<RankedCandidate> {
  return bestEffortDefaultCandidates(review);
}

/**
 * Returns the deterministic best-effort same-family default for one review, or
 * undefined when no safe default exists. This is the authority the one-click
 * analyzer uses for ordinary ingredients.
 */
export function selectBestEffortMatch(
  review: IngredientReviewResult
): AutomaticSelection | undefined {
  if (!isReviewLike(review)) return undefined;
  // A STRICT automatic selection (unique exact, or an unambiguous specific match
  // such as `00 flour` / `whole powdered milk`) is always preferred and never
  // relaxed. Best-effort only fills the gap where ordinary variation would
  // otherwise force review.
  const strict = selectAutomaticMatch(review);
  if (strict !== undefined) return strict;
  const normalized = typeof review.normalized_query === 'string' ? review.normalized_query : '';
  const eligible = bestEffortDefaultCandidates(review);
  if (eligible.length === 0) return undefined;
  const best = eligible[0];
  return Object.freeze({
    fdc_id: best.fdc_id,
    match_class: best.match_class,
    confidence: 'high' as const,
    explanation: explainCandidate(normalized, best, reviewContext(review)),
  });
}

/**
 * True when `fdcId` is a safe best-effort same-family default for `review`. The
 * one-click analyzer may choose any eligible same-family sibling (for example a
 * portion-bearing one), so the calculation engine validates the chosen candidate
 * against this bounded eligible set. A materially different food, a prepared
 * product, or a cultivar-ambiguous family can never qualify.
 */
export function isDeterministicBestEffortSelection(
  review: IngredientReviewResult,
  fdcId: number
): boolean {
  const eligible = bestEffortDefaultCandidates(review);
  return eligible.some((candidate) => candidate.fdc_id === fdcId);
}

/**
 * True when `fdcId` is a deterministic automatic selection for `review`:
 * either the STRICT automatic choice or a safe best-effort same-family default.
 * Used by the calculation engine to validate an `automatic_selection` marker so
 * a caller can never forge automatic authority for a materially different food.
 */
export function isDeterministicAutomaticSelection(
  review: IngredientReviewResult,
  fdcId: number
): boolean {
  const selection = selectAutomaticMatch(review);
  if (selection !== undefined && selection.fdc_id === fdcId) return true;
  return isDeterministicBestEffortSelection(review, fdcId);
}
