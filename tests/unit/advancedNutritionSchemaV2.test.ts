/**
 * Advanced Nutrition — schema v1/v2 versioned contract (I-1 repair).
 *
 * Proves the schema discriminator selects a VERSION-SPECIFIC validator:
 *   - v1 is the restored parent contract: no household basis, no household
 *     evidence key, unknown v1 keys/bases fail closed exactly as before;
 *   - v2 retains every v1 meaning and adds the closed household basis plus the
 *     closed household evidence object, coupled bidirectionally;
 *   - the parent-style v1 reader rejects household semantics marked as v1, and
 *     the new reader accepts both valid v1 and valid v2;
 *   - unknown/future schema versions are never interpreted.
 *
 * Apply -> reopen behavior for both versions is proven end to end against the
 * real pinned bundle in `advancedNutritionPhase6Household.test.ts` (v1 direct /
 * user mass, v2 household, stale household, household removal -> v1) and in
 * `advancedNutritionReopenProvenance.test.ts` (v1 source/count apply).
 */

import { describe, it, expect } from 'vitest';

import {
  CODEX_NUTRITION_SCHEMA_V1,
  CODEX_NUTRITION_SCHEMA_V2,
  type CodexNutritionV1,
  type CodexNutritionV2,
} from '../../src/core/nutritionV2/schema';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import {
  decodeCodexNutrition,
  encodeCodexNutrition,
  evaluateAdvancedNutritionEligibility,
  validateCodexNutrition,
  validateCodexNutritionV1,
  validateCodexNutritionV2,
} from '../../src/core/nutritionV2/validate';

const DIGEST = `sha256:${'a'.repeat(64)}`;

/** A valid canonical v1 block (no household semantics anywhere). */
function validV1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    basis: 'total',
    servings: 4,
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: DIGEST,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: '2026-04' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: {
        amount: 540,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
      },
    },
    ingredients: [
      {
        line_ref: '454 g ground beef',
        source: 'usda_fdc',
        source_food_id: '171077',
        source_release: '2026-04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

const VALID_HOUSEHOLD_EVIDENCE = Object.freeze({
  registry_release: 'household_portion_initial_usda_v1',
  record_key: 'garlic|clove|null|null',
  record_digest: 'b'.repeat(64),
  household_unit: 'clove',
  size_class: null,
  requires_state: null,
  quantity: 3,
  selection_digest: 'c'.repeat(64),
});

/** A valid canonical v2 block whose only line carries household provenance. */
function validV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const v1 = validV1();
  return {
    ...v1,
    schema: 2,
    ingredients: [
      {
        line_ref: '3 cloves garlic',
        source: 'usda_fdc',
        source_food_id: '169230',
        source_release: '2026-04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
        amount: { value: 9, unit: 'g' },
        conversion_basis: 'household_portion',
        household_portion: { ...VALID_HOUSEHOLD_EVIDENCE },
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

function householdEntry(block: Record<string, unknown>): Record<string, unknown> {
  return (block.ingredients as Array<Record<string, unknown>>)[0];
}

/** A valid canonical v3 block whose line carries a written-range midpoint. */
function validV3(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const v1 = validV1();
  return {
    ...v1,
    schema: 3,
    ingredients: [
      {
        line_ref: '3-4 lb ground beef',
        source: 'usda_fdc',
        source_food_id: '171077',
        source_release: '2026-04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
        amount: { value: 1587.573295, unit: 'g' },
        conversion_basis: 'direct_mass',
        range_representative: {
          amount_source: 'written_mass_range',
          policy: 'midpoint',
          lower: 3,
          upper: 4,
          unit: 'lb',
          representative_grams: 1587.573295,
        },
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

describe('schema v2 — restored v1 contract (parent-style reader)', () => {
  it('v1 still accepts the canonical v1 block and its valid bases', () => {
    for (const basis of ['direct_mass', 'source_portion'] as const) {
      const block = validV1({
        ingredients: [
          {
            line_ref: 'l1',
            source: 'usda_fdc',
            source_food_id: '171077',
            source_release: '2026-04',
            match_status: 'confirmed',
            resolved: true,
            user_confirmed: true,
            amount: { value: 100, unit: 'g' },
            conversion_basis: basis,
          },
        ],
      });
      const validation = validateCodexNutritionV1(block);
      expect(validation.ok, basis).toBe(true);
      expect(validation.value?.schema).toBe(CODEX_NUTRITION_SCHEMA_V1);
    }
  });

  it('v1 rejects a v2 block closed (invalid schema, never coerced)', () => {
    const validation = validateCodexNutritionV1(validV2());
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('invalid_schema');
  });

  it('v1 rejects a household conversion basis marked as schema 1', () => {
    const block = validV2({ schema: 1 });
    const validation = validateCodexNutritionV1(block);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('invalid_conversion_basis');
  });

  it('v1 rejects a household evidence object marked as schema 1', () => {
    const block = validV1({
      ingredients: [
        {
          line_ref: '3 cloves garlic',
          source: 'usda_fdc',
          source_food_id: '169230',
          source_release: '2026-04',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
          amount: { value: 9, unit: 'g' },
          household_portion: { ...VALID_HOUSEHOLD_EVIDENCE },
        },
      ],
    });
    const validation = validateCodexNutritionV1(block);
    expect(validation.ok).toBe(false);
    // The v1 evidence key set is closed: the unknown household key fails closed.
    expect(validation.errors).toContain('ingredient_unknown_field');
    // And the new reader treats the same block as malformed v1.
    const decoded = decodeCodexNutrition(block);
    expect(decoded.kind).toBe('malformed');
  });

  it('v1 still rejects an unknown basis, an unknown v1 field, and a valid v1 user-mass basis omission', () => {
    expect(
      validateCodexNutritionV1(
        validV1({
          ingredients: [
            {
              line_ref: 'l1',
              source: 'usda_fdc',
              source_food_id: '171077',
              source_release: '2026-04',
              match_status: 'confirmed',
              resolved: true,
              user_confirmed: true,
              conversion_basis: 'density',
            },
          ],
        })
      ).ok
    ).toBe(false);
    expect(validateCodexNutritionV1(validV1({ future_field: 1 })).ok).toBe(false);
    // Genuine v1 user mass remains represented by the OMITTED basis contract.
    const userMass = validV1({
      ingredients: [
        {
          line_ref: 'l1',
          source: 'usda_fdc',
          source_food_id: '171077',
          source_release: '2026-04',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
          amount: { value: 7, unit: 'g' },
        },
      ],
    });
    const validation = validateCodexNutritionV1(userMass);
    expect(validation.ok).toBe(true);
    expect((validation.value as CodexNutritionV1).ingredients[0].conversion_basis).toBeUndefined();
  });
});

describe('schema v2 — version-specific decoding', () => {
  it('the new reader accepts a valid historical v1 block unchanged', () => {
    const decoded = decodeCodexNutrition(validV1());
    expect(decoded.kind).toBe('v1');
    if (decoded.kind !== 'v1') return;
    expect(decoded.value.schema).toBe(1);
    const validation = validateCodexNutrition(validV1());
    expect(validation.ok).toBe(true);
  });

  it('the new reader accepts a valid v2 household block', () => {
    const decoded = decodeCodexNutrition(validV2());
    expect(decoded.kind).toBe('v2');
    if (decoded.kind !== 'v2') return;
    expect(decoded.value.schema).toBe(CODEX_NUTRITION_SCHEMA_V2);
    const entry = decoded.value.ingredients[0];
    expect(entry.conversion_basis).toBe('household_portion');
    expect(entry.household_portion?.record_key).toBe('garlic|clove|null|null');
    expect(validateCodexNutritionV2(validV2()).ok).toBe(true);
    expect(validateCodexNutrition(validV2()).ok).toBe(true);
  });

  it('the new reader rejects malformed v2 blocks field-by-field', () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['household basis without evidence', validV2({ ingredients: [(() => {
        const entry = householdEntry(validV2());
        delete entry.household_portion;
        return entry;
      })()] })],
      ['household evidence without basis', validV2({ ingredients: [(() => {
        const entry = householdEntry(validV2());
        delete entry.conversion_basis;
        return entry;
      })()] })],
      ['unknown household evidence field', validV2({ ingredients: [(() => {
        const entry = householdEntry(validV2());
        (entry.household_portion as Record<string, unknown>).future_field = 1;
        return entry;
      })()] })],
      ['unknown conversion basis', validV2({ ingredients: [(() => {
        const entry = householdEntry(validV2());
        entry.conversion_basis = 'density';
        return entry;
      })()] })],
      ['conflicting mass evidence (unresolved household line)', validV2({ ingredients: [(() => {
        const entry = householdEntry(validV2());
        entry.resolved = false;
        return entry;
      })()] })],
      ['conflicting mass evidence (no gram amount)', validV2({ ingredients: [(() => {
        const entry = householdEntry(validV2());
        delete entry.amount;
        return entry;
      })()] })],
      ['malformed household evidence shape', validV2({ ingredients: [(() => {
        const entry = householdEntry(validV2());
        entry.household_portion = { registry_release: '' };
        return entry;
      })()] })],
      ['unknown top-level v2 field', validV2({ future_field: 1 })],
    ];
    for (const [label, block] of cases) {
      expect(decodeCodexNutrition(block).kind, label).toBe('malformed');
      expect(validateCodexNutrition(block).ok, label).toBe(false);
    }
  });

  it('the v2 reader never interprets schema 3 as v2, and preserves an unknown future version', () => {
    // A v3 block carrying written-range evidence is invalid under v1/v2 (the
    // evidence key is unknown there) and decodes only as v3.
    const v3 = validV3();
    const decoded = decodeCodexNutrition(v3);
    expect(decoded.kind).toBe('v3');
    expect(validateCodexNutritionV2(v3).ok).toBe(false);
    expect(validateCodexNutritionV1(v3).ok).toBe(false);
    expect(validateCodexNutrition(v3).ok).toBe(true);
    // v3 RETAINS every v2 meaning: a household-only block labeled 3 is valid v3.
    expect(validateCodexNutrition(validV2({ schema: 3 })).ok).toBe(true);
    // An unknown FUTURE schema (4+) keeps the opaque-preservation contract.
    const future = validV2({ schema: 4 });
    const futureDecoded = decodeCodexNutrition(future);
    expect(futureDecoded.kind).toBe('opaque');
    if (futureDecoded.kind === 'opaque') expect(futureDecoded.value.schema).toBe(4);
    expect(validateCodexNutrition(future).ok).toBe(false);
    expect(decodeCodexNutrition(validV2({ schema: 'two' })).kind).toBe('malformed');
  });
});

describe('schema v2 — codec and advisory eligibility', () => {
  it('encodes v1 unchanged and round-trips v2 with household evidence', () => {
    const v1 = encodeCodexNutrition(validV1() as unknown as CodexNutritionV1);
    expect(v1.schema).toBe(1);
    const v2 = encodeCodexNutrition(validV2() as unknown as CodexNutritionV2);
    expect(v2.schema).toBe(2);
    const decoded = decodeCodexNutrition(v2);
    expect(decoded.kind).toBe('v2');
    if (decoded.kind !== 'v2') return;
    expect(decoded.value.ingredients[0].household_portion?.selection_digest).toBe('c'.repeat(64));
  });

  it('the schema version participates in the encoded candidate digest', () => {
    const v1 = encodeCodexNutrition(validV1() as unknown as CodexNutritionV1);
    const v2 = encodeCodexNutrition(validV2() as unknown as CodexNutritionV2);
    expect(JSON.stringify(v1)).not.toBe(JSON.stringify(v2));
    expect(v1.schema).not.toBe(v2.schema);
  });

  it('advisory eligibility understands both recognized versions and rejects household-as-v1', () => {
    // The synthetic v1 block has no amount-bearing resolved evidence, so it is
    // structurally valid even if not "complete"; eligibility is advisory only.
    expect(evaluateAdvancedNutritionEligibility(validV1()).reasons).not.toContain('invalid_block');
    expect(evaluateAdvancedNutritionEligibility(validV2()).reasons).not.toContain('invalid_block');
    expect(
      evaluateAdvancedNutritionEligibility(validV2({ schema: 1 })).reasons
    ).toContain('invalid_block');
  });
});
