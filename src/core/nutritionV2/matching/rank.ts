/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5D: deterministic ranking.
 *
 * PURE, offline. Ranking is fully specified and explainable. It uses an integer
 * comparison tuple (no floating-point scores) and never uses nutrient values.
 * The only presentation tie-breaks are a LATE data-type order (Phase 3) and the
 * numeric FDC id; neither can convert a semantic tie into an automatic selection
 * (see `review.ts`).
 *
 * CLOSED MATCH CLASSES (most specific first):
 *   exact_phrase            normalized phrase equality
 *   exact_token_multiset    same token multiset, different order/spacing
 *   all_query_tokens_present every food-identity token present (candidate extras)
 *   partial_token_overlap   at least one food-identity token present
 *   no_match                no required anchor present (excluded from results)
 *
 * ANCHOR ENFORCEMENT
 * ------------------
 * Every candidate must contain a token (or approved morphological equivalent)
 * from EACH required anchor group derived by the query projection. A candidate
 * that only shares a preparation word (`ground`, `shredded`) is therefore never
 * returned. A bounded contradiction window (`without salt`, `no salt`,
 * `salt free`) removes negated candidates unless the query itself requests the
 * negation.
 *
 * ORDERING TUPLE (ascending, Phase 5 semantics as of rank v11):
 *   [class_rank,
 *    missing_core_identity_tokens,
 *    family_mismatch,                // composed product/dish head
 *    prepared_product_forms,         // survey dish built from the food (stick/mush)
 *    unrequested_cooking_methods,    // cooked/fried/baked not requested (prefer raw)
 *    qualifier_conflicts,            // candidate variant/form tokens not requested
 *    qualifier_opposition,           // candidate contradicts a requested qualifier
 *    -qualifier_agreement,           // requested qualifier/form/numeric present
 *    missing_qualifier_tokens,       // requested qualifier absent
 *    missing_form_tokens,            // requested form absent
 *    -refinement_agreement,          // optional refinement present
 *    -alternative_agreement,         // OR-alternative branch satisfied
 *    unrequested_forms,              // composed product form not requested
 *    unrequested_specialty,          // Phase 3: flavored/fortified/seed/... specialty
 *    unrequested_material_variants,  // candidate state not requested (dried/canned)
 *    compound_penalty,               // adjacent unknown compound modifier
 *    unrequested_variety,            // specific variety not requested (blue/roma)
 *    variety_contradiction,          // Phase 3: different explicit variety
 *    material_variety,               // named cultivar (tan/pinto/black/wild)
 *    unrequested_subtype,            // level/type subtype not requested
 *    contradiction(0/1),
 *    extra_candidate_tokens,
 *    -generic_marker,                // prefer the plain/unspecified family member
 *    order_disagreement (0 agrees / 1 disagrees),
 *    data_type_tie_break (sr_legacy < foundation < fndds),
 *    fdc_id]
 *
 * v3 (post-Phase-5 smoke-test remediation) adds core-identity coverage, qualifier
 * opposition, requested qualifier/form coverage, and the bounded compound-food
 * penalty. `flakes`/`powder`/`and`/`total` can no longer become the required
 * anchor, and `peanut butter` no longer outranks plain butter.
 *
 * v4 adds the bounded prepared-product demotion: a SURVEY (FNDDS) dish built
 * from a staple (`Cornmeal stick`, `Cornmeal mush`) no longer outranks plain
 * staple records merely because the staple name appears in the record. A
 * foundational/SR-Legacy form of the same food (`Butter, stick, unsalted`) is
 * unaffected.
 *
 * v11 (Phase 3) adds the plain-before-specialty demotion, the explicit variety
 * contradiction demotion, and the late data-type tie-break. See the comparator
 * comments for the exact intent of each dimension.
 */

import {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  type MatchClass,
  type NormalizedQuery,
  type RankableEntry,
  type RankedCandidate,
  type RankingEvidence,
} from './types';
import {
  alternativeAgreementCount,
  candidateContradicts,
  compoundPenaltyCount,
  familyMismatchCount,
  genericMarkerCount,
  missingCoreTokenCount,
  missingFormTokenCount,
  missingQualifierTokenCount,
  preparedProductFormCount,
  projectQueryText,
  qualifierAgreementCount,
  qualifierConflictCount,
  qualifierOppositionCount,
  queryRequestsNegation,
  refinementAgreementCount,
  tokensEquivalent,
  tokensMatch,
  unrequestedCookingMethodCount,
  unrequestedFormTokenCount,
  unrequestedMaterialVariantCount,
  unrequestedMaterialVarietyCount,
  unrequestedSpecialtyCount,
  unrequestedSubtypeCount,
  unrequestedVarietyCount,
  varietyContradictionCount,
  type IngredientQueryProjection,
} from './query';

const CLASS_RANK: Readonly<Record<MatchClass, number>> = Object.freeze({
  exact_phrase: 0,
  exact_token_multiset: 1,
  all_query_tokens_present: 2,
  partial_token_overlap: 3,
  no_match: 4,
});

/**
 * LATE DATA-TYPE TIE-BREAK (Phase 3). Used ONLY after every semantic dimension
 * (identity coverage, family, prepared form, specialty, state/form, variety,
 * compound, subtype, extra tokens, generic marker, order agreement) has tied, so
 * it can never outrank food identity. Order: SR Legacy first because its
 * authenticated household portions remain the source of the existing
 * count-portion mass authority (Foundation records often carry only a RACC
 * portion); Foundation second (analytical records), FNDDS last (survey dishes).
 * The tie-break never participates in automatic authority by itself: the
 * runner-up ambiguity contract still decides whether a tie may auto-select.
 */
const DATA_TYPE_TIE_BREAK: Readonly<Record<string, number>> = Object.freeze({
  sr_legacy: 0,
  foundation: 1,
  fndds: 2,
});

function dataTypeRank(dataType: string): number {
  const rank = DATA_TYPE_TIE_BREAK[dataType];
  return rank === undefined ? 3 : rank;
}

function countTokens(tokens: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function sameMultiset(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const counts = countTokens(a);
  for (const token of b) {
    const remaining = counts.get(token);
    if (remaining === undefined || remaining === 0) return false;
    counts.set(token, remaining - 1);
  }
  return true;
}

/** True when `query` appears as an ordered subsequence of `candidate`. */
function isSubsequence(query: ReadonlyArray<string>, candidate: ReadonlyArray<string>): boolean {
  let qi = 0;
  for (const token of candidate) {
    if (qi < query.length && token === query[qi]) qi += 1;
  }
  return qi === query.length;
}

function candidateHasToken(candidate: ReadonlyArray<string>, wanted: string): boolean {
  for (const token of candidate) {
    if (tokensEquivalent(token, wanted)) return true;
  }
  return false;
}

function anchorsSatisfied(
  projection: IngredientQueryProjection,
  candidateTokens: ReadonlyArray<string>
): boolean {
  if (projection.anchor_groups.length === 0) return false;
  for (const group of projection.anchor_groups) {
    let ok = false;
    for (const accepted of group.accepted) {
      if (candidateHasToken(candidateTokens, accepted)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}

interface Evaluated {
  readonly entry: RankableEntry;
  readonly matchClass: MatchClass;
  readonly evidence: RankingEvidence;
  readonly missingCoreTokens: number;
  readonly familyMismatch: number;
  readonly preparedProduct: number;
  readonly unrequestedCooking: number;
  readonly qualifierConflicts: number;
  readonly qualifierOpposition: number;
  readonly qualifierAgreement: number;
  readonly missingQualifierTokens: number;
  readonly missingFormTokens: number;
  readonly unrequestedForms: number;
  readonly refinementAgreement: number;
  readonly alternativeAgreement: number;
  readonly unrequestedVariety: number;
  readonly varietyContradiction: number;
  readonly unrequestedSpecialty: number;
  readonly materialVariety: number;
  readonly unrequestedSubtype: number;
  readonly compoundPenalty: number;
  readonly unrequestedMaterialVariants: number;
  readonly genericMarker: number;
  readonly contradiction: boolean;
}

const NO_MATCH: Evaluated = Object.freeze({
  entry: undefined as unknown as RankableEntry,
  matchClass: 'no_match' as const,
  evidence: Object.freeze({
    exact_phrase: false,
    exact_token_multiset: false,
    matched_query_token_count: 0,
    missing_query_token_count: 0,
    extra_candidate_token_count: 0,
    order_agreement: false,
  }),
  missingCoreTokens: 0,
  familyMismatch: 0,
  preparedProduct: 0,
  unrequestedCooking: 0,
  qualifierConflicts: 0,
  qualifierOpposition: 0,
  qualifierAgreement: 0,
  missingQualifierTokens: 0,
  missingFormTokens: 0,
  unrequestedForms: 0,
  refinementAgreement: 0,
  alternativeAgreement: 0,
  unrequestedVariety: 0,
  varietyContradiction: 0,
  unrequestedSpecialty: 0,
  materialVariety: 0,
  unrequestedSubtype: 0,
  compoundPenalty: 0,
  unrequestedMaterialVariants: 0,
  genericMarker: 0,
  contradiction: false,
});

function evaluate(
  query: NormalizedQuery,
  projection: IngredientQueryProjection,
  entry: RankableEntry
): Evaluated {
  const candidateTokens = entry.normalized_tokens;
  const identityTokens = projection.food_tokens;

  if (identityTokens.length === 0 || !anchorsSatisfied(projection, candidateTokens)) {
    return NO_MATCH;
  }

  const queryNegates = queryRequestsNegation(projection);
  const contradiction = !queryNegates && candidateContradicts(candidateTokens, identityTokens);
  if (contradiction) {
    return NO_MATCH;
  }

  const candidateCounts = countTokens(candidateTokens);
  let matched = 0;
  for (const token of identityTokens) {
    if (candidateHasToken(candidateTokens, token)) matched += 1;
  }
  const missing = identityTokens.length - matched;
  const extra = Math.max(0, candidateTokens.length - matched);
  const exactPhrase = query.text.length > 0 && query.text === entry.normalized_description;
  const exactTokenMultiset = sameMultiset(query.tokens, candidateTokens);

  let matchClass: MatchClass;
  if (exactPhrase) matchClass = 'exact_phrase';
  else if (exactTokenMultiset) matchClass = 'exact_token_multiset';
  else if (missing === 0) matchClass = 'all_query_tokens_present';
  else if (matched > 0) matchClass = 'partial_token_overlap';
  else matchClass = 'no_match';

  if (matchClass === 'no_match') return NO_MATCH;

  let qualifierAgreement = 0;
  for (const numeric of projection.numeric_qualifiers) {
    if ((candidateCounts.get(numeric) ?? 0) > 0) qualifierAgreement += 1;
  }
  qualifierAgreement += qualifierAgreementCount(candidateTokens, projection);

  return {
    entry,
    matchClass,
    evidence: {
      exact_phrase: exactPhrase,
      exact_token_multiset: exactTokenMultiset,
      matched_query_token_count: matched,
      missing_query_token_count: missing,
      extra_candidate_token_count: extra,
      order_agreement: isSubsequence(identityTokens, candidateTokens),
    },
    missingCoreTokens: missingCoreTokenCount(candidateTokens, projection),
    familyMismatch: familyMismatchCount(candidateTokens, projection),
    preparedProduct: preparedProductFormCount(candidateTokens, projection, entry.data_type),
    unrequestedCooking: unrequestedCookingMethodCount(candidateTokens, projection),
    qualifierConflicts: qualifierConflictCount(candidateTokens, projection),
    qualifierOpposition: qualifierOppositionCount(candidateTokens, projection),
    qualifierAgreement,
    missingQualifierTokens: missingQualifierTokenCount(candidateTokens, projection),
    missingFormTokens: missingFormTokenCount(candidateTokens, projection),
    unrequestedForms: unrequestedFormTokenCount(candidateTokens, projection),
    refinementAgreement: refinementAgreementCount(candidateTokens, projection),
    alternativeAgreement: alternativeAgreementCount(candidateTokens, projection),
    unrequestedVariety: unrequestedVarietyCount(candidateTokens, projection),
    varietyContradiction: varietyContradictionCount(candidateTokens, projection),
    unrequestedSpecialty: unrequestedSpecialtyCount(candidateTokens, projection),
    materialVariety: unrequestedMaterialVarietyCount(candidateTokens, projection),
    unrequestedSubtype: unrequestedSubtypeCount(candidateTokens, projection),
    compoundPenalty: compoundPenaltyCount(candidateTokens, projection),
    unrequestedMaterialVariants: unrequestedMaterialVariantCount(candidateTokens, projection),
    genericMarker: genericMarkerCount(candidateTokens),
    contradiction: false,
  };
}

/** Clamps a requested result limit into the documented safe range. */
export function clampResultLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    return DEFAULT_RESULT_LIMIT;
  }
  return Math.min(limit, MAX_RESULT_LIMIT);
}

function compareEvaluated(a: Evaluated, b: Evaluated): number {
  const classDelta = CLASS_RANK[a.matchClass] - CLASS_RANK[b.matchClass];
  if (classDelta !== 0) return classDelta;
  // CORE FOOD IDENTITY coverage dominates: the plain food beats a candidate
  // that merely shares the head noun as part of a different compound.
  const coreDelta = a.missingCoreTokens - b.missingCoreTokens;
  if (coreDelta !== 0) return coreDelta;
  // A composed product/dish head is not the requested raw food family.
  const familyDelta = a.familyMismatch - b.familyMismatch;
  if (familyDelta !== 0) return familyDelta;
  // A PREPARED PRODUCT built from the food (`Cornmeal stick`, `Cornmeal mush`)
  // is not the plain staple family and must not outrank it merely because the
  // staple name appears in the record. Ranked before variety/material so the
  // plain (possibly color-qualified) family member wins.
  const preparedDelta = a.preparedProduct - b.preparedProduct;
  if (preparedDelta !== 0) return preparedDelta;
  // An UNREQUESTED cooking/preparation state (`Rice, cooked` for a bare `rice`,
  // `Egg, whole, fried` for a bare `egg`) is demoted below the raw/plain state,
  // so the one-click default surfaces the base food. An explicitly requested
  // method contributes 0 and is unaffected.
  const cookingDelta = a.unrequestedCooking - b.unrequestedCooking;
  if (cookingDelta !== 0) return cookingDelta;
  const conflictDelta = a.qualifierConflicts - b.qualifierConflicts;
  if (conflictDelta !== 0) return conflictDelta;
  // A candidate that contradicts a requested qualifier (`salted` for
  // `unsalted`) loses to one that does not.
  const oppositionDelta = a.qualifierOpposition - b.qualifierOpposition;
  if (oppositionDelta !== 0) return oppositionDelta;
  const agreementDelta = b.qualifierAgreement - a.qualifierAgreement;
  if (agreementDelta !== 0) return agreementDelta;
  // A requested qualifier/form that is simply absent is demoted after a
  // contradicted one, so `garlic salt` never silently becomes plain `salt`.
  const missingQualifierDelta = a.missingQualifierTokens - b.missingQualifierTokens;
  if (missingQualifierDelta !== 0) return missingQualifierDelta;
  const missingFormDelta = a.missingFormTokens - b.missingFormTokens;
  if (missingFormDelta !== 0) return missingFormDelta;
  // An OPTIONAL refinement the query requested (`sea`/`kosher`/`fine`/`coarse`)
  // is a PREFERENCE: a real refinement record outranks the generic sibling, but
  // its absence never blocks the deterministic generic fallback.
  const refinementDelta = b.refinementAgreement - a.refinementAgreement;
  if (refinementDelta !== 0) return refinementDelta;
  // An OR-alternative branch the candidate satisfies (`brioche bun` for
  // `brioche or potato burger buns`) is preferred over the generic shared-head
  // fallback, without making the fallback unreachable.
  const alternativeDelta = b.alternativeAgreement - a.alternativeAgreement;
  if (alternativeDelta !== 0) return alternativeDelta;
  // A candidate carrying an UNREQUESTED prepared/dish FORM (`Double hamburger,
  // ..., 2 patties` for `burger buns`, `Cheese sandwich` for `cheese`) is a
  // composed product, not the requested component; it is demoted below the plain
  // component even when it contains the component word.
  const unrequestedFormDelta = a.unrequestedForms - b.unrequestedForms;
  if (unrequestedFormDelta !== 0) return unrequestedFormDelta;
  // PLAIN BEFORE UNREQUESTED SPECIALTY (Phase 3): after composed product FORMS
  // are demoted, a consumer specialty variant of the same family
  // (`Spaghetti, spinach, dry`, `Spices, dill seed`, `Tomato chili sauce`) is
  // demoted below the plain family member BEFORE material-state and compound
  // dimensions, so it can never outrank a plain record merely by carrying fewer
  // extra tokens. An explicitly requested specialty contributes 0.
  const specialtyDelta = a.unrequestedSpecialty - b.unrequestedSpecialty;
  if (specialtyDelta !== 0) return specialtyDelta;
  // A materially altered unrequested variant (`Apple, dried` for `apple`) is
  // demoted below the ordinary food, but is never excluded from review.
  const variantDelta = a.unrequestedMaterialVariants - b.unrequestedMaterialVariants;
  if (variantDelta !== 0) return variantDelta;
  // A composed/compound candidate (`Rice pilaf` / `Rice milk` for `rice`,
  // `Bread, NS as to major flour` for `flour`) is demoted below the plain family
  // member BEFORE variety, so a plain but color-qualified staple (`Rice, white,
  // long-grain, raw`) outranks a prepared/compound product.
  const compoundDelta = a.compoundPenalty - b.compoundPenalty;
  if (compoundDelta !== 0) return compoundDelta;
  // A specific unrequested variety (`Cheese, blue` for `cheese`) is demoted
  // below the generic family member.
  const varietyDelta = a.unrequestedVariety - b.unrequestedVariety;
  if (varietyDelta !== 0) return varietyDelta;
  // An EXPLICIT VARIETY CONTRADICTION (`Rice, red` for `white rice`) is worse
  // than a merely unrequested variety and is demoted below records that either
  // match or are silent about variety.
  const varietyContradictionDelta = a.varietyContradiction - b.varietyContradiction;
  if (varietyContradictionDelta !== 0) return varietyContradictionDelta;
  // A named MATERIAL cultivar (`Rice, black`, `Wild rice`, `Beans, Dry, Tan`)
  // is a different food within the family and is demoted below the ordinary
  // plain/white/brown family member.
  const materialVarietyDelta = a.materialVariety - b.materialVariety;
  if (materialVarietyDelta !== 0) return materialVarietyDelta;
  // GENERIC / PLAIN PREFERENCE. An unrequested level/type subtype (`Flour, 00`,
  // `Flour, whole wheat`, `Cream, heavy`, `Milk, dry, whole`) is demoted below
  // the plain/generic family record BEFORE the presentation-only extra-token and
  // order dimensions. This is the systemic "generic preference occurs too late"
  // repair: verbose or awkward USDA wording can never push the genuine
  // generic/all-purpose/plain candidate behind a specific sibling.
  const subtypeDelta = a.unrequestedSubtype - b.unrequestedSubtype;
  if (subtypeDelta !== 0) return subtypeDelta;
  const contradictionDelta = (a.contradiction ? 1 : 0) - (b.contradiction ? 1 : 0);
  if (contradictionDelta !== 0) return contradictionDelta;
  const extraDelta =
    a.evidence.extra_candidate_token_count - b.evidence.extra_candidate_token_count;
  if (extraDelta !== 0) return extraDelta;
  // The explicit generic/unspecified marker (NFS/NS) is the final semantic
  // preference, so it can never override a state/variety/subtype preference.
  const genericDelta = b.genericMarker - a.genericMarker;
  if (genericDelta !== 0) return genericDelta;
  const orderDelta =
    (a.evidence.order_agreement ? 0 : 1) - (b.evidence.order_agreement ? 0 : 1);
  if (orderDelta !== 0) return orderDelta;
  // LATE data-type tie-break: only after every semantic/presentation dimension
  // has tied, so it can never outrank food identity.
  const dataTypeDelta = dataTypeRank(a.entry.data_type) - dataTypeRank(b.entry.data_type);
  if (dataTypeDelta !== 0) return dataTypeDelta;
  return a.entry.fdc_id - b.entry.fdc_id;
}

/**
 * Ranks catalog entries for one normalized query and returns at most `limit`
 * bounded candidates. Entries that lack a required anchor, contradict the query,
 * or share no food-identity token are excluded. The result is independent of
 * input entry order.
 */
export function rankCandidates(
  query: NormalizedQuery,
  entries: ReadonlyArray<RankableEntry>,
  limit: unknown = DEFAULT_RESULT_LIMIT
): ReadonlyArray<RankedCandidate> {
  const capped = clampResultLimit(limit);
  const projection = projectQueryText(query.text);
  const evaluated: Evaluated[] = [];
  for (const entry of entries) {
    const result = evaluate(query, projection, entry);
    if (result.matchClass === 'no_match') continue;
    evaluated.push(result);
  }
  evaluated.sort(compareEvaluated);
  return Object.freeze(
    evaluated.slice(0, capped).map((result) =>
      Object.freeze({
        fdc_id: result.entry.fdc_id,
        data_type: result.entry.data_type,
        description: result.entry.description,
        normalized_description: result.entry.normalized_description,
        record_digest: result.entry.record_digest,
        match_class: result.matchClass,
        evidence: Object.freeze({ ...result.evidence }),
      })
    )
  );
}
