/**
 * CHARACTERIZATION: extracting the canonical identity digest changed NOTHING.
 *
 * `src/core/nutritionV2/calculation/identityEvidence.ts` is a pure MOVE of
 * logic that used to be private inside `calculate.ts`. These tests pin that
 * claim two independent ways:
 *
 *  1. GOLDEN VECTORS. The identity digests below were produced by the
 *     PRE-extraction calculator. The current calculator must still produce
 *     exactly these bytes. If extraction ever changed a field, its order, an
 *     omission rule, the normalization, the hashing or the digest encoding, a
 *     literal here changes and the test fails.
 *
 *  2. VERBATIM ORIGINAL LOGIC. A copy of the original `identityPayload` +
 *     `digestOf`, byte-for-byte as they were, is held in THIS TEST ONLY and
 *     shown to reproduce the same digests. This proves the move preserved
 *     semantics rather than merely that the current code is self-consistent.
 *     It is test code: production has exactly ONE implementation, pinned by
 *     the AI-3 isolation suite.
 */
import { describe, it, expect } from 'vitest';
import {
  createNutritionCalculationContext,
  calculateRecipeNutrition,
} from '../../src/core/nutritionV2/calculation/context';
import {
  computeIngredientIdentityDigest,
  ingredientIdentityPayload,
  digestOf,
} from '../../src/core/nutritionV2/calculation/identityEvidence';
import { canonicalStringify, sha256Hex } from '../../src/core/nutritionV2/usda/digest';
import type { MatchStatus } from '../../src/core/nutritionV2/calculation/types';
import { buildCalculationBundle, CALC_FOODS } from '../fixtures/usdaCalculationFixtures';

const SCOPE = ['calories', 'protein', 'carbohydrates', 'fat', 'sodium', 'fiber'] as const;

interface OriginalFacts {
  lineRef: string;
  originalText: string;
  amount: number | null;
  rawUnit: string | undefined;
  normalizedUnit: string;
  measurementKind: string;
  query: string;
  normalizedQuery: string;
  note: string | undefined;
  qualitative: boolean;
  matchStatus: string;
  fdcId: number | undefined;
  recordDigest: string | undefined;
  confirmationDigest: string | undefined;
}

/**
 * The ORIGINAL private implementation, copied verbatim from `calculate.ts` at
 * baseline 4a943997. Field list, field order, the optional omission rules and
 * the `sha256:` encoding are all load-bearing.
 */
function originalIdentityPayload(e: OriginalFacts) {
  return {
    line_ref: e.lineRef,
    original_text: e.originalText,
    amount: e.amount,
    ...(e.rawUnit !== undefined ? { raw_unit: e.rawUnit } : {}),
    normalized_unit: e.normalizedUnit,
    measurement_kind: e.measurementKind,
    query: e.query,
    normalized_query: e.normalizedQuery,
    ...(e.note !== undefined ? { note: e.note } : {}),
    qualitative: e.qualitative,
    match_status: e.matchStatus,
    ...(e.fdcId !== undefined ? { fdc_id: e.fdcId } : {}),
    ...(e.recordDigest !== undefined ? { record_digest: e.recordDigest } : {}),
    ...(e.confirmationDigest !== undefined ? { confirmation_digest: e.confirmationDigest } : {}),
  };
}
function originalDigestOf(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalStringify(payload))}`;
}

/** Digests produced by the PRE-extraction calculator at baseline 4a943997. */
const GOLDEN: ReadonlyArray<{ readonly id: string; readonly line: string; readonly digest: string }> = [
  { id: 'ordinary matched ingredient', line: '100 g Flour, wheat, white', digest: 'sha256:972125e97622190444caed0d3ec3ceb1c476803692fd0d01d3a406493d7695e2' },
  { id: 'direct authored mass line', line: '50 g Butter, salted', digest: 'sha256:d666c7ae05bff7cc04f39d766913ef52a389450afb5ef77deea7407f22c7b69c' },
  { id: 'a second unique-exact match', line: '10 g Salt, table', digest: 'sha256:449d0a4e181cdb0cc7de2e5a29e88b9f97ccddcb3f0ff82961ba6ac504d47444' },
  { id: 'a cooked (FNDDS) record', line: '75 g Cornmeal, cooked, FNDDS', digest: 'sha256:ca8418155a4ca71be6d01534a6a153f3ba504f0a194946d832696cd36e92c52a' },
  { id: 'a record with no usable quantity', line: 'Mystery, quantity not specified', digest: 'sha256:fb47bc2eab35493788d4297366dc61c93d96fa3a8aafcfce0ec72422da16c83c' },
  { id: 'a qualifier-bearing line', line: '1 large Egg, whole, raw, fresh', digest: 'sha256:39c81179c91a4317594d06a3f62daf349a3e9033fd65dfb81584dd75566d69f7' },
  { id: 'a second cornmeal identity', line: '20 g Cornmeal, whole-grain, yellow', digest: 'sha256:be3acca5171e067b0514e11c973ef1211bfcaf9ffd5208dc899400e807d4245a' },
  { id: 'a degermed cornmeal identity', line: '20 g Cornmeal, degermed, enriched, yellow', digest: 'sha256:82b3afcf07cdcc9e35e4be28f94a4c4f7464ec841288fabae35708ce5e2718d6' },
];

function genuineContext() {
  const bundle = buildCalculationBundle(CALC_FOODS);
  const result = createNutritionCalculationContext(bundle.manifest, bundle.records);
  if (!result.ok) throw new Error('context failed');
  return result.context;
}

describe('identity evidence extraction — golden vectors from the pre-extraction calculator', () => {
  for (const testCase of GOLDEN) {
    it(`${testCase.id} still produces its pre-extraction digest`, () => {
      const result = calculateRecipeNutrition(genuineContext(), {
        servings: 1,
        nutrient_scope: [...SCOPE],
        ingredients: [{ line_ref: 'a', ingredient: testCase.line }],
      }) as never as {
        ok: boolean;
        preview?: { ingredients?: ReadonlyArray<{ ingredient_identity_digest?: string }> };
      };
      expect(result.ok).toBe(true);
      const digest = result.preview?.ingredients?.[0]?.ingredient_identity_digest;
      expect(digest).toBe(testCase.digest);
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  }
});

describe('identity evidence extraction — the verbatim original logic is preserved', () => {
  const FACTS = {
    lineRef: 'ing:0:x',
    originalText: '100 g Flour, wheat, white',
    amount: 100,
    rawUnit: 'g',
    normalizedUnit: 'mass',
    measurementKind: 'mass',
    query: 'Flour, wheat, white',
    normalizedQuery: 'flour wheat white',
    note: undefined as string | undefined,
    qualitative: false,
    matchStatus: 'unique_exact' as MatchStatus,
    fdcId: 168237,
    recordDigest: 'rd',
    confirmationDigest: undefined as string | undefined,
  };

  it('the extracted payload is byte-identical to the original payload', () => {
    expect(ingredientIdentityPayload(FACTS)).toEqual(originalIdentityPayload(FACTS));
  });

  it('the extracted digest is byte-identical to the original digest', () => {
    expect(computeIngredientIdentityDigest(FACTS)).toBe(originalDigestOf(originalIdentityPayload(FACTS)));
  });

  it('the extracted digestOf is byte-identical to the original digestOf', () => {
    const payload = ingredientIdentityPayload(FACTS);
    expect(digestOf(payload)).toBe(originalDigestOf(payload));
  });

  it('the FIELD SET is load-bearing; literal key order is normalized by canonicalStringify', () => {
    // `canonicalStringify` sorts keys, so writing the same fields in a
    // different literal order yields the SAME digest. What is load-bearing is
    // the field SET and the omission rules -- proven by the next assertion.
    const shared = computeIngredientIdentityDigest(FACTS);
    const reordered = originalDigestOf({
      original_text: FACTS.originalText,
      line_ref: FACTS.lineRef,
      amount: FACTS.amount,
      raw_unit: FACTS.rawUnit,
      normalized_unit: FACTS.normalizedUnit,
      measurement_kind: FACTS.measurementKind,
      query: FACTS.query,
      normalized_query: FACTS.normalizedQuery,
      qualitative: FACTS.qualitative,
      match_status: FACTS.matchStatus,
      fdc_id: FACTS.fdcId,
      record_digest: FACTS.recordDigest,
    });
    expect(shared).toBe(reordered);

    // Renaming or dropping a field DOES move the digest.
    const withoutRecordDigest = originalDigestOf({
      line_ref: FACTS.lineRef,
      original_text: FACTS.originalText,
      amount: FACTS.amount,
      raw_unit: FACTS.rawUnit,
      normalized_unit: FACTS.normalizedUnit,
      measurement_kind: FACTS.measurementKind,
      query: FACTS.query,
      normalized_query: FACTS.normalizedQuery,
      qualitative: FACTS.qualitative,
      match_status: FACTS.matchStatus,
      fdc_id: FACTS.fdcId,
    });
    expect(withoutRecordDigest).not.toBe(shared);

    // The omission rules are load-bearing for a STRONGER reason than ordering:
    // `canonicalStringify` REFUSES an explicit `undefined` value, so an absent
    // optional field must be omitted from the object, never spread in as
    // `undefined`. The original implementation spreads conditionally, and so
    // does the extracted one.
    expect(() =>
      originalDigestOf({
        line_ref: FACTS.lineRef,
        original_text: FACTS.originalText,
        amount: FACTS.amount,
        raw_unit: FACTS.rawUnit,
        normalized_unit: FACTS.normalizedUnit,
        measurement_kind: FACTS.measurementKind,
        query: FACTS.query,
        normalized_query: FACTS.normalizedQuery,
        note: undefined,
        qualitative: FACTS.qualitative,
        match_status: FACTS.matchStatus,
        fdc_id: FACTS.fdcId,
        record_digest: FACTS.recordDigest,
        confirmation_digest: undefined,
      }),
    ).toThrow(/canonical_serialization_failed/);
  });

  it('optional fields are OMITTED, not emitted as undefined', () => {
    expect(Object.keys(ingredientIdentityPayload(FACTS))).toEqual([
      'line_ref',
      'original_text',
      'amount',
      'raw_unit',
      'normalized_unit',
      'measurement_kind',
      'query',
      'normalized_query',
      'qualitative',
      'match_status',
      'fdc_id',
      'record_digest',
    ]);
  });

  it('every identity-relevant change moves the digest (stale-evidence binding)', () => {
    const base = computeIngredientIdentityDigest(FACTS);
    const changes: ReadonlyArray<[string, typeof FACTS]> = [
      ['line text', { ...FACTS, originalText: '200 g Flour, wheat, white' }],
      ['amount', { ...FACTS, amount: 200 }],
      ['raw unit', { ...FACTS, rawUnit: 'kg' }],
      ['normalized query', { ...FACTS, normalizedQuery: 'flour' }],
      ['FDC id', { ...FACTS, fdcId: 168238 }],
      ['record digest', { ...FACTS, recordDigest: 'rd2' }],
      ['confirmation digest', { ...FACTS, confirmationDigest: 'cd' }],
      ['match status', { ...FACTS, matchStatus: 'user_confirmed' as typeof FACTS.matchStatus }],
      ['qualitative flag', { ...FACTS, qualitative: true }],
    ];
    for (const [what, changed] of changes) {
      expect(computeIngredientIdentityDigest(changed), `${what} must change the digest`).not.toBe(base);
    }
  });
});
