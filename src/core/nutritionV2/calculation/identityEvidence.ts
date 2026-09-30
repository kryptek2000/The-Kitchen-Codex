/**
 * CANONICAL INGREDIENT IDENTITY EVIDENCE — the single shared owner.
 *
 * This module is a pure EXTRACTION of logic that previously lived privately
 * inside `calculation/calculate.ts`. Nothing about the semantics changed:
 *
 *   - the same field list, in the same order;
 *   - the same optional-field omission rules;
 *   - the same `canonicalStringify` + `sha256Hex` hashing;
 *   - the same `sha256:` digest encoding.
 *
 * WHY IT EXISTS. The identity digest binds one recipe line to its normalized
 * ingredient identity and its authenticated USDA match. Two boundaries need it
 * and must agree byte-for-byte:
 *
 *   1. the CALCULATOR, which recomputes it and compares it against the AI-3
 *      selection evidence, failing closed on mismatch;
 *   2. PHASE 4, which derives the non-persisted per-line identity evidence the
 *      offer-first UI needs before it can present a selectable estimate.
 *
 * Because the identity payload contains no mass source and no AI-estimate
 * selection, the digest is logically derivable BEFORE any AI-3 selection
 * exists. The two consumers are therefore not circular: they share one
 * primitive, and the calculator remains the final independent verifier. Sharing
 * the digest does NOT make the AI-3 selection trusted.
 *
 * It is deliberately NOT re-exported from the public nutritionV2 barrel: it is
 * internal to the calculation/Phase-4 boundary.
 */
import { canonicalStringify, sha256Hex } from '../usda/digest';
import type { MatchStatus } from './types';

/** The canonical `sha256:<hex>` digest of a canonicalized payload. */
export function digestOf(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalStringify(payload))}`;
}

/**
 * Exactly the fields the calculator has always hashed, and nothing else.
 *
 * Adding, removing, renaming or reordering a field here CHANGES every identity
 * digest in the product. `identityEvidenceCharacterization.test.ts` pins that.
 */
export interface IngredientIdentityFacts {
  readonly lineRef: string;
  readonly originalText: string;
  readonly amount: number | null;
  readonly rawUnit: string | undefined;
  readonly normalizedUnit: string;
  readonly measurementKind: string;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly note: string | undefined;
  readonly qualitative: boolean;
  readonly matchStatus: MatchStatus;
  readonly fdcId: number | undefined;
  readonly recordDigest: string | undefined;
  readonly confirmationDigest: string | undefined;
}

/** The canonical identity payload. Field order and omission rules are load-bearing. */
export function ingredientIdentityPayload(facts: IngredientIdentityFacts) {
  return {
    line_ref: facts.lineRef,
    original_text: facts.originalText,
    amount: facts.amount,
    ...(facts.rawUnit !== undefined ? { raw_unit: facts.rawUnit } : {}),
    normalized_unit: facts.normalizedUnit,
    measurement_kind: facts.measurementKind,
    query: facts.query,
    normalized_query: facts.normalizedQuery,
    ...(facts.note !== undefined ? { note: facts.note } : {}),
    qualitative: facts.qualitative,
    match_status: facts.matchStatus,
    ...(facts.fdcId !== undefined ? { fdc_id: facts.fdcId } : {}),
    ...(facts.recordDigest !== undefined ? { record_digest: facts.recordDigest } : {}),
    ...(facts.confirmationDigest !== undefined ? { confirmation_digest: facts.confirmationDigest } : {}),
  };
}

/** The canonical ingredient identity digest. */
export function computeIngredientIdentityDigest(facts: IngredientIdentityFacts): string {
  return digestOf(ingredientIdentityPayload(facts));
}
