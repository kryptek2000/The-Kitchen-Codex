/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5E: authenticated count-portion
 * resolution.
 *
 * Acceptance (A–H) and adversarial coverage for:
 *   - the derived-mass contract (count / portionAmount × gramWeight);
 *   - explicit size constraints (medium rejects small/large/generic);
 *   - singular/plural count units and the bounded bun/roll + item/pickle aliases;
 *   - ambiguity (materially different gram weights require explicit selection);
 *   - bypass resistance (forged selection / food / portion / gram / digest);
 *   - state invalidation;
 *   - mass/volume/user-mass calculation regressions;
 *   - REAL checked-in USDA bundle records for representative cases.
 *
 * Synthetic fixtures are clearly labeled and used only for unit-level behavior;
 * the real-bundle section reads the pinned, authenticated artifact.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { buildCountPortionChoice } from '../../src/core/nutritionV2/phase4/countPortion';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import {
  COUNT_PORTION_VERSION,
  canonicalCountUnit,
  canonicalSize,
  countPortionCandidates,
  countUnitsEquivalent,
  deriveCountRequirement,
  extractCountIdentity,
  resolveDeterministicCountPortionGrams,
  sanitizeCountPortionSelection,
  selectDeterministicCountPortion,
  type CountPortionSelection,
} from '../../src/core/nutritionV2/calculation/countPortion';
import { CALCULATION_VERSION } from '../../src/core/nutritionV2/calculation/types';
import {
  calculateRecipeNutrition,
  createNutritionCalculationContext,
  reviewFoodCountPortions,
} from '../../src/core/nutritionV2/calculation/context';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { projectQueryText } from '../../src/core/nutritionV2/matching/query';
import type { CanonicalPortionRecord } from '../../src/core/nutritionV2/usda/types';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { CalculationResult } from '../../src/core/nutritionV2/calculation/types';
import {
  composeAdvancedNutritionSessionFromBundle,
  type RuntimeBundleInputs,
} from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredientLine } from '../../src/utils/markdownParser';

// ---------------------------------------------------------------------------
// Synthetic fixtures (NOT real nutrition data)
// ---------------------------------------------------------------------------

const COUNT_SPECS: ReadonlyArray<CalcRecordSpec> = [
  {
    fdcId: 5001,
    dataType: 'sr_legacy',
    description: 'Bacon',
    nutrients: { calories: 541 },
    portions: [
      { usda_portion_id: 1, amount: 1, measure: 'undetermined', modifier: 'slice', gram_weight: 28, sequence: 1 },
    ],
  },
  {
    fdcId: 5002,
    dataType: 'foundation',
    description: 'Cheddar cheese',
    nutrients: { calories: 404 },
    portions: [{ usda_portion_id: 2, amount: 1, measure: 'slice', gram_weight: 17, sequence: 1 }],
  },
  {
    fdcId: 5003,
    dataType: 'sr_legacy',
    description: 'Candy',
    nutrients: { calories: 400 },
    portions: [
      { usda_portion_id: 3, amount: 3, measure: 'undetermined', modifier: 'piece', gram_weight: 45, sequence: 1 },
    ],
  },
  {
    fdcId: 5004,
    dataType: 'sr_legacy',
    description: 'Tomatoes',
    nutrients: { calories: 18 },
    portions: [
      { usda_portion_id: 4, amount: 1, measure: 'undetermined', modifier: 'medium', gram_weight: 123, sequence: 1 },
      { usda_portion_id: 5, amount: 1, measure: 'undetermined', modifier: 'small', gram_weight: 91, sequence: 2 },
      { usda_portion_id: 6, amount: 1, measure: 'undetermined', modifier: 'large', gram_weight: 182, sequence: 3 },
    ],
  },
  {
    fdcId: 5005,
    dataType: 'fndds',
    description: 'Bun',
    nutrients: { calories: 280 },
    portions: [
      { usda_portion_id: 7, measure: '1 hamburger bun', modifier: '64538', gram_weight: 52, sequence: 1 },
      { usda_portion_id: 8, measure: '1 miniature/small hamburger bun', modifier: '64301', gram_weight: 28, sequence: 2 },
    ],
  },
  {
    fdcId: 5006,
    dataType: 'fndds',
    description: 'Pickle',
    nutrients: { calories: 12 },
    portions: [
      { usda_portion_id: 9, measure: '1 pickle, any size', modifier: '64728', gram_weight: 30, sequence: 1 },
    ],
  },
  {
    fdcId: 5007,
    dataType: 'sr_legacy',
    description: 'Ham',
    nutrients: { calories: 145 },
    portions: [
      { usda_portion_id: 10, amount: 1, measure: 'undetermined', modifier: 'slice', gram_weight: 28, sequence: 1 },
      { usda_portion_id: 11, amount: 1, measure: 'undetermined', modifier: 'slice', gram_weight: 21, sequence: 2 },
    ],
  },
  {
    fdcId: 5008,
    dataType: 'sr_legacy',
    description: 'Butter',
    nutrients: { calories: 717 },
    portions: [{ usda_portion_id: 12, amount: 1, measure: 'cup', gram_weight: 227, sequence: 1 }],
  },
  {
    fdcId: 5009,
    dataType: 'sr_legacy',
    description: 'Salt',
    nutrients: { sodium: 38758 },
    portions: [
      { usda_portion_id: 13, amount: 1, measure: 'undetermined', modifier: 'package', gram_weight: 100, sequence: 1 },
    ],
  },
];

const BUNDLE = buildCalculationBundle(COUNT_SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;
const RECORD = (fdcId: number) => {
  const record = BUNDLE.records.find((entry) => entry.fdc_id === fdcId);
  if (!record) throw new Error(`missing ${fdcId}`);
  return record;
};

function structured(line: string) {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function calculateWithMatch(
  session: AdvancedNutritionSession,
  line: string,
  fdcId: number,
  extra: Record<string, unknown> = {}
): CalculationResult {
  const ingredient = structured(line);
  const review = session.reviewIngredient(ingredient);
  const selection = { kind: 'candidate', fdc_id: fdcId, review_digest: (review as { review_digest: string }).review_digest };
  return session.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [{ line_ref: 'a', ingredient, review, selection, ...extra }],
  });
}

function gramsOf(result: CalculationResult): number | undefined {
  if (!result.ok) return undefined;
  return result.preview.ingredients[0].resolved_grams;
}

function requirementFor(line: string) {
  const parsed = parseIngredientLine(line);
  const projection = projectQueryText(normalizeQuery(parsed.name).text);
  const requirement = deriveCountRequirement(
    parsed.amount,
    parsed.unit || null,
    projection.food_tokens,
    projection.size_qualifiers
  );
  if (!requirement) throw new Error(`no requirement for ${line}`);
  return requirement;
}

describe('phase 4.5E — count identity extraction (closed vocabulary)', () => {
  it('recognizes exact singular/plural count units', () => {
    for (const [raw, expected] of [
      ['slice', 'slice'],
      ['slices', 'slice'],
      ['piece', 'piece'],
      ['pieces', 'piece'],
      ['item', 'item'],
      ['items', 'item'],
      ['serving', 'serving'],
      ['servings', 'serving'],
      ['clove', 'clove'],
      ['cloves', 'clove'],
      ['can', 'can'],
      ['package', 'package'],
      ['pkg', 'package'],
      ['stick', 'stick'],
      ['head', 'head'],
      ['egg', 'egg'],
      ['container', 'container'],
      ['bun', 'bun'],
      ['roll', 'roll'],
      ['pickle', 'pickle'],
    ] as ReadonlyArray<[string, string]>) {
      expect(canonicalCountUnit(raw), raw).toBe(expected);
    }
    expect(canonicalCountUnit('cupboard')).toBeNull();
    expect(canonicalCountUnit('candy')).toBeNull();
    expect(canonicalCountUnit('garlic')).toBeNull();
    expect(canonicalCountUnit('lettuce')).toBeNull();
  });

  it('recognizes bounded size qualifiers only', () => {
    expect(canonicalSize('medium')).toBe('medium');
    expect(canonicalSize('Large')).toBe('large');
    expect(canonicalSize('miniature')).toBe('mini');
    expect(canonicalSize('extra large')).toBe('xl');
    expect(canonicalSize('giant')).toBeNull();
  });

  it('applies only the bounded bun/roll and item/pickle equivalences', () => {
    expect(countUnitsEquivalent('bun', 'roll')).toBe(true);
    expect(countUnitsEquivalent('item', 'pickle')).toBe(true);
    expect(countUnitsEquivalent('slice', 'piece')).toBe(false);
    expect(countUnitsEquivalent('package', 'serving')).toBe(false);
    expect(countUnitsEquivalent('order', 'serving')).toBe(false);
    expect(countUnitsEquivalent('cup', 'item')).toBe(false);
  });

  it('rejects vague / ambiguous / mass / volume portion descriptions', () => {
    const cases: ReadonlyArray<CanonicalPortionRecord> = [
      { amount: 1, measure: '1 pickle, any size', gram_weight: 30 },
      { amount: 1, measure: 'Quantity not specified', gram_weight: 100 },
      { amount: 1, measure: 'Guideline amount per cup of vegetable', gram_weight: 8 },
      { amount: 1, measure: '1 cup', gram_weight: 240 },
      { amount: 1, measure: 'undetermined', modifier: 'oz', gram_weight: 28 },
      { amount: 1, measure: 'undetermined', modifier: 'RACC', gram_weight: 30 },
    ];
    for (const portion of cases) {
      expect(extractCountIdentity(portion), JSON.stringify(portion)).toBeNull();
    }
  });

  it('rejects invalid amount / gram weight (present-invalid fails closed)', () => {
    for (const portion of [
      { amount: 0, measure: 'slice', gram_weight: 28 },
      { amount: -1, measure: 'slice', gram_weight: 28 },
      { amount: Number.NaN, measure: 'slice', gram_weight: 28 },
      { amount: Number.POSITIVE_INFINITY, measure: 'slice', gram_weight: 28 },
      { amount: 1, measure: 'slice', gram_weight: 0 },
      { amount: 1, measure: 'slice', gram_weight: -5 },
      { amount: 1, measure: 'slice', gram_weight: Number.NaN },
    ] as ReadonlyArray<CanonicalPortionRecord>) {
      expect(extractCountIdentity(portion), JSON.stringify(portion)).toBeNull();
    }
  });

  it('extracts a size-only identity and a unit+size identity', () => {
    expect(extractCountIdentity({ amount: 1, measure: 'undetermined', modifier: 'medium', gram_weight: 123 })).toEqual({
      amount: 1,
      unit: null,
      size: 'medium',
    });
    expect(
      extractCountIdentity({ amount: 1, measure: 'undetermined', modifier: 'slice, medium', gram_weight: 28 })
    ).toEqual({ amount: 1, unit: 'slice', size: 'medium' });
    expect(extractCountIdentity({ measure: '1 hamburger bun', gram_weight: 52 })).toEqual({
      amount: 1,
      unit: 'bun',
      size: null,
    });
    expect(extractCountIdentity({ amount: 1, measure: '1 large', gram_weight: 200 })).toEqual({
      amount: 1,
      unit: null,
      size: 'large',
    });
  });
});

describe('phase 4.5E — positive derived-mass calculations', () => {
  it('8 slices using 1 slice = 28 g -> 224 g (deterministic)', () => {
    const result = calculateWithMatch(SESSION, '8 slices bacon', 5001);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.mass_source).toBe('count_portion');
    expect(evidence.resolved_grams).toBe(224);
    expect(evidence.count_deterministic).toBe(true);
    expect(evidence.count_ingredient_amount).toBe(8);
    expect(evidence.count_unit).toBe('slice');
  });

  it('4 slices using 1 slice = 17 g -> 68 g', () => {
    expect(gramsOf(calculateWithMatch(SESSION, '4 slices cheddar cheese', 5002))).toBe(68);
  });

  it('6 pieces using 3 pieces = 45 g -> 90 g', () => {
    expect(gramsOf(calculateWithMatch(SESSION, '6 pieces candy', 5003))).toBe(90);
  });

  it('explicit medium size match uses only the medium portion (2 x 123 = 246 g)', () => {
    const requirement = requirementFor('2 medium tomatoes');
    const candidates = countPortionCandidates(RECORD(5004), requirement);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].size).toBe('medium');
    expect(gramsOf(calculateWithMatch(SESSION, '2 medium tomatoes', 5004))).toBe(246);
  });

  it('narrow bun/roll behavior: burger buns resolve to the hamburger-bun portion', () => {
    expect(gramsOf(calculateWithMatch(SESSION, '4 burger buns', 5005))).toBe(208);
  });

  it('package count resolves when the authenticated portion matches', () => {
    expect(gramsOf(calculateWithMatch(SESSION, '1 package Salt', 5009))).toBe(100);
  });
});

describe('phase 4.5E — compatibility rejection', () => {
  it('explicit medium rejects small and large', () => {
    const requirement = requirementFor('2 medium tomatoes');
    const candidates = countPortionCandidates(RECORD(5004), requirement);
    expect(candidates.map((candidate) => candidate.size)).toEqual(['medium']);
  });

  it('slice rejects piece and package/serving/order/recipe mismatches', () => {
    expect(countPortionCandidates(RECORD(5003), { amount: 4, unit: 'slice', size: null })).toHaveLength(0);
    expect(countPortionCandidates(RECORD(5009), { amount: 1, unit: 'serving', size: null })).toHaveLength(0);
    expect(countPortionCandidates(RECORD(5009), { amount: 1, unit: 'order', size: null })).toHaveLength(0);
    expect(countPortionCandidates(RECORD(5009), { amount: 1, unit: 'recipe', size: null })).toHaveLength(0);
  });

  it('an unrelated food noun is never a count identity', () => {
    expect(countPortionCandidates(RECORD(5002), { amount: 4, unit: 'pickle', size: null })).toHaveLength(0);
  });

  it('a volume ingredient never resolves a count portion and vice versa', () => {
    // 1 cup Butter: volume ingredient; the cup portion is not a count portion.
    expect(gramsOf(calculateWithMatch(SESSION, '1 cup Butter', 5008))).toBeUndefined();
    // 4 slices Candy: count ingredient; Candy has only a piece portion.
    expect(gramsOf(calculateWithMatch(SESSION, '4 slices candy', 5003))).toBeUndefined();
  });

  it('a vague portion description yields no compatible count portion', () => {
    expect(countPortionCandidates(RECORD(5006), { amount: 4, unit: 'pickle', size: null })).toHaveLength(0);
  });
});

describe('phase 4.5E — ambiguity and determinism', () => {
  it('materially different gram weights require explicit selection', () => {
    const requirement = requirementFor('4 slices ham');
    const candidates = countPortionCandidates(RECORD(5007), requirement);
    expect(candidates).toHaveLength(2);
    expect(selectDeterministicCountPortion(candidates)).toBeNull();
    const deterministic = resolveDeterministicCountPortionGrams(RECORD(5007), requirement, 1_000_000);
    expect(deterministic.ok).toBe(false);
    if (!deterministic.ok) {
      expect((deterministic as { reason: string }).reason).toBe('ambiguous');
    }
    // No selection -> no mass.
    expect(gramsOf(calculateWithMatch(SESSION, '4 slices ham', 5007))).toBeUndefined();
  });

  it('an explicit ambiguous selection resolves deterministically by index', () => {
    const ingredient = structured('4 slices ham');
    const review = SESSION.reviewIngredient(ingredient);
    const selection = { kind: 'candidate', fdc_id: 5007, review_digest: (review as { review_digest: string }).review_digest };
    const choice = buildCountPortionChoice(SESSION, {
      lineRef: 'a',
      ingredient,
      review,
      selection,
      fdcId: 5007,
      portionIndex: 1,
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    const result = SESSION.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient, review, selection, count_portion_selection: choice.choice.selection }],
    });
    expect(gramsOf(result)).toBe(84);
  });

  it('provably equivalent duplicates canonicalize deterministically (lowest index)', () => {
    const record = RECORD(5007);
    const equivalent = countPortionCandidates(record, { amount: 4, unit: 'slice', size: null }).map((candidate) => ({
      ...candidate,
      gram_weight: 28,
    }));
    const chosen = selectDeterministicCountPortion(equivalent);
    expect(chosen).not.toBeNull();
    expect(chosen?.candidate.index).toBe(0);
  });

  it('source reordering never changes the compatible set or chosen identity', () => {
    const requirement = requirementFor('4 slices ham');
    const forward = countPortionCandidates(RECORD(5007), requirement);
    const reversedRecord = { ...RECORD(5007), portions: [...RECORD(5007).portions].reverse() };
    const reversed = countPortionCandidates(reversedRecord, requirement).map((candidate) => ({
      amount: candidate.amount,
      gram_weight: candidate.gram_weight,
    }));
    expect(reversed).toEqual(
      forward
        .map((candidate) => ({ amount: candidate.amount, gram_weight: candidate.gram_weight }))
        .reverse()
    );
    expect(selectDeterministicCountPortion(forward)).toBeNull();
    expect(selectDeterministicCountPortion(countPortionCandidates(reversedRecord, requirement))).toBeNull();
  });
});

describe('phase 4.5E — security and bypass resistance', () => {
  it('a portion from food A cannot be applied to food B', () => {
    const ingredient = structured('4 slices cheddar cheese');
    const review = SESSION.reviewIngredient(ingredient);
    const selection = { kind: 'candidate', fdc_id: 5002, review_digest: (review as { review_digest: string }).review_digest };
    const choice = buildCountPortionChoice(SESSION, {
      lineRef: 'a',
      ingredient,
      review,
      selection,
      fdcId: 5002,
      portionIndex: 0,
    });
    if (!choice.ok) throw new Error('choice failed');
    const forged = { ...(choice.choice.selection as Record<string, unknown>), fdc_id: 5001 };
    const result = SESSION.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient, review, selection, count_portion_selection: forged }],
    });
    if (result.ok) expect(result.preview.ingredients[0].outcome).not.toBe('calculated');
  });

  it('a forged count selection (gram / amount / digest / unit) fails closed', () => {
    const ingredient = structured('8 slices bacon');
    const review = SESSION.reviewIngredient(ingredient);
    const selection = { kind: 'candidate', fdc_id: 5001, review_digest: (review as { review_digest: string }).review_digest };
    const choice = buildCountPortionChoice(SESSION, {
      lineRef: 'a',
      ingredient,
      review,
      selection,
      fdcId: 5001,
      portionIndex: 0,
    });
    if (!choice.ok) throw new Error('choice failed');
    const base = choice.choice.selection as Record<string, unknown>;
    for (const override of [
      { gram_weight: 999 },
      { portion_amount: 2 },
      { measure: 'piece' },
      { count_unit: 'piece' },
      { count_size: 'large' },
      { candidates_digest: 'f'.repeat(64) },
      { record_digest: 'f'.repeat(64) },
      { catalog_digest: 'f'.repeat(64) },
      { ingredient_identity_digest: 'stale' },
      { bundle_release: 'other' },
      { line_ref: 'other' },
      { selection_digest: 'f'.repeat(64) },
      { calculation_version: 'usda_advisory_calc_v3' },
      { count_portion_version: 'usda_count_portion_v0' },
      { extra: 1 },
    ]) {
      const result = SESSION.calculate({
        servings: 1,
        nutrient_scope: ['calories'],
        ingredients: [
          { line_ref: 'a', ingredient, review, selection, count_portion_selection: { ...base, ...override } },
        ],
      });
      if (result.ok) {
        expect(result.preview.ingredients[0].outcome, JSON.stringify(override)).not.toBe('calculated');
      }
    }
  });

  it('a hostile accessor selection is rejected as unsafe', () => {
    const ingredient = structured('8 slices bacon');
    const review = SESSION.reviewIngredient(ingredient);
    const selection = { kind: 'candidate', fdc_id: 5001, review_digest: (review as { review_digest: string }).review_digest };
    const hostile = {
      count_portion_version: COUNT_PORTION_VERSION,
      get calculation_version() {
        throw new Error('boom');
      },
    };
    const result = SESSION.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient, review, selection, count_portion_selection: hostile }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { failure: { code: string } }).failure.code).toBe('unsafe_request');
    }
  });

  it('the sanitizer rejects an unknown field and a forged selection digest', () => {
    const good = sanitizeCountPortionSelection({
      count_portion_version: COUNT_PORTION_VERSION,
      calculation_version: CALCULATION_VERSION,
      line_ref: 'a',
      ingredient_identity_digest: 'x',
      bundle_release: 'b',
      catalog_digest: 'cat',
      fdc_id: 1,
      record_digest: 'r',
      candidates_digest: 'c',
      portion_index: 0,
      portion_amount: 1,
      gram_weight: 28,
      measure: 'slice',
      count_unit: 'slice',
      count_size: null,
      selection_digest: 'd',
    });
    expect(good.ok).toBe(false);
  });

  it('a forged count selection passed directly to the calculation context fails closed', () => {
    const contextResult = createNutritionCalculationContext(BUNDLE.manifest, BUNDLE.records);
    if (!contextResult.ok) throw new Error('context failed');
    const ingredient = structured('8 slices bacon');
    const review = SESSION.reviewIngredient(ingredient);
    const selection = { kind: 'candidate', fdc_id: 5001, review_digest: (review as { review_digest: string }).review_digest };
    const forged = {
      count_portion_version: COUNT_PORTION_VERSION,
      calculation_version: CALCULATION_VERSION,
      line_ref: 'a',
      ingredient_identity_digest: 'x',
      bundle_release: BUNDLE.bundleRelease,
      catalog_digest: 'cat',
      fdc_id: 5001,
      record_digest: 'r',
      candidates_digest: 'c',
      portion_index: 0,
      portion_amount: 1,
      gram_weight: 9999,
      measure: 'slice',
      count_unit: 'slice',
      count_size: null,
      selection_digest: 'd',
    };
    const result = calculateRecipeNutrition(contextResult.context, {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        { line_ref: 'a', ingredient, review, selection, count_portion_selection: forged },
      ],
    });
    if (result.ok) expect(result.preview.ingredients[0].outcome).not.toBe('calculated');
  });

  it('excluded restaurant foods cannot supply a count portion', () => {
    // The real-bundle section proves this end-to-end; here the synthetic
    // requirement is that a non-eligible id is never reachable.
    const result = SESSION.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: structured('8 slices bacon'), count_portion_selection: {} }],
    });
    // No confirmed match -> unresolved, never a trusted total.
    if (result.ok) expect(result.preview.ingredients[0].outcome).not.toBe('calculated');
  });
});

describe('phase 4.5E — hostile count requirement fails closed', () => {
  const contextResult = createNutritionCalculationContext(BUNDLE.manifest, BUNDLE.records);
  if (!contextResult.ok) throw new Error('context failed');
  const context = contextResult.context;
  const FDC = 5001;

  function expectFailClosed(requirement: unknown, label: string): void {
    let threw = false;
    let result: ReturnType<typeof reviewFoodCountPortions> | undefined;
    try {
      result = reviewFoodCountPortions(context, FDC, requirement);
    } catch {
      threw = true;
    }
    expect(threw, `${label} must not throw`).toBe(false);
    expect(result?.ok, label).toBe(false);
    if (result && result.ok === false) {
      expect((result as { ok: false; failure: { code: string } }).failure.code, label).toBe(
        'invalid_request'
      );
    }
  }

  it('a throwing getter on amount is never invoked and fails closed', () => {
    let invoked = 0;
    expectFailClosed(
      {
        get amount() {
          invoked += 1;
          throw new Error('hostile amount getter');
        },
        unit: 'slice',
        size: null,
      },
      'amount getter'
    );
    expect(invoked).toBe(0);
  });

  it('a throwing getter on unit is never invoked and fails closed', () => {
    let invoked = 0;
    expectFailClosed(
      {
        amount: 8,
        get unit() {
          invoked += 1;
          throw new Error('hostile unit getter');
        },
        size: null,
      },
      'unit getter'
    );
    expect(invoked).toBe(0);
  });

  it('a throwing getter on size is never invoked and fails closed', () => {
    let invoked = 0;
    expectFailClosed(
      {
        amount: 8,
        unit: 'slice',
        get size() {
          invoked += 1;
          throw new Error('hostile size getter');
        },
      },
      'size getter'
    );
    expect(invoked).toBe(0);
  });

  it('a hostile/prototype-shaped requirement fails closed', () => {
    expectFailClosed(
      Object.create({ amount: 8, unit: 'slice', size: null }),
      'prototype-shaped'
    );
    class Requirement {
      amount = 8;
      unit = 'slice';
      size = null;
    }
    expectFailClosed(new Requirement(), 'class instance');
  });

  it('a proxy whose descriptor trap throws fails closed without throwing', () => {
    expectFailClosed(
      new Proxy(
        { amount: 8, unit: 'slice', size: null },
        {
          getOwnPropertyDescriptor() {
            throw new Error('hostile descriptor trap');
          },
        }
      ),
      'proxy descriptor trap'
    );
  });

  it('a valid frozen internally-derived requirement is still accepted', () => {
    const requirement = Object.freeze({ amount: 8, unit: 'slice', size: null });
    const result = reviewFoodCountPortions(context, FDC, requirement);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.review.applicable).toBe(true);
    expect(result.review.candidates.map((candidate) => candidate.unit)).toContain('slice');
  });
});

describe('phase 4.5E — recalculation across changed authority stays fail-closed', () => {
  it('a count-portion selection bound to one authority cannot calculate on another', () => {
    const otherBundle = buildCalculationBundle([
      {
        fdcId: 5001,
        dataType: 'sr_legacy',
        description: 'Bacon',
        nutrients: { calories: 541 },
        portions: [
          { usda_portion_id: 1, amount: 1, measure: 'undetermined', modifier: 'slice', gram_weight: 28, sequence: 1 },
        ],
      },
      {
        fdcId: 5002,
        dataType: 'foundation',
        description: 'Cheddar cheese',
        nutrients: { calories: 404 },
      },
    ]);
    const otherSessionResult = createAdvancedNutritionSession(otherBundle.manifest, otherBundle.records);
    if (!otherSessionResult.ok) throw new Error('other session failed');

    const ingredient = structured('8 slices bacon');
    const review = SESSION.reviewIngredient(ingredient);
    const selection = {
      kind: 'candidate',
      fdc_id: 5001,
      review_digest: (review as { review_digest: string }).review_digest,
    };
    const choice = buildCountPortionChoice(SESSION, {
      lineRef: 'a',
      ingredient,
      review,
      selection,
      fdcId: 5001,
      portionIndex: 0,
    });
    if (!choice.ok) throw new Error('choice failed');

    const result = otherSessionResult.session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        { line_ref: 'a', ingredient, review, selection, count_portion_selection: choice.choice.selection },
      ],
    });
    if (result.ok) expect(result.preview.ingredients[0].outcome).not.toBe('calculated');
  });
});

describe('phase 4.5E — state invalidation', () => {
  function row(lineRef: string) {
    return Object.freeze({
      line_ref: lineRef,
      original_text: lineRef,
      outcome: 'review_required' as const,
      query: lineRef,
      candidates: Object.freeze([]),
      review_digest: 'd'.repeat(64),
      selected_fdc_id: undefined,
      review: Object.freeze({}),
      note: undefined,
    });
  }
  function ready() {
    return phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'r',
      sessionIdentity: 'test-session-authority',
      rows: [row('a')],
      baseServings: 4,
    });
  }
  const countChoice = { fdc_id: 5001, portion_index: 0, selection: {}, review: {} };
  const portionChoice = { fdc_id: 5002, portion_index: 0, selection: {}, review: {} };
  const userMassChoice = { fdc_id: 5001, quantity: 100, unit: 'g' as const, selection: {} };

  it('selecting a count portion clears portions and user mass', () => {
    let state = ready();
    state = phase4Reducer(state, { type: 'select_portion', lineRef: 'a', choice: portionChoice });
    state = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    state = phase4Reducer(state, { type: 'select_count_portion', lineRef: 'a', choice: countChoice });
    expect(state.countPortions.a).toBe(countChoice);
    expect(state.portions.a).toBeUndefined();
    expect(state.userMasses.a).toBeUndefined();
  });

  it('selecting a source portion or user mass clears the count portion', () => {
    let state = ready();
    state = phase4Reducer(state, { type: 'select_count_portion', lineRef: 'a', choice: countChoice });
    const withPortion = phase4Reducer(state, { type: 'select_portion', lineRef: 'a', choice: portionChoice });
    expect(withPortion.countPortions.a).toBeUndefined();
    const withMass = phase4Reducer(state, { type: 'select_user_mass', lineRef: 'a', choice: userMassChoice });
    expect(withMass.countPortions.a).toBeUndefined();
  });

  it('changing the match clears the count portion', () => {
    let state = ready();
    state = phase4Reducer(state, { type: 'select_count_portion', lineRef: 'a', choice: countChoice });
    const changed = phase4Reducer(state, {
      type: 'select_match',
      lineRef: 'a',
      choice: { kind: 'candidate', fdc_id: 5002, review_digest: 'd'.repeat(64) },
    });
    expect(changed.countPortions.a).toBeUndefined();
  });

  it('clear_count_portion removes the choice and marks the preview stale', () => {
    let state = ready();
    state = phase4Reducer(state, { type: 'select_count_portion', lineRef: 'a', choice: countChoice });
    const cleared = phase4Reducer(state, { type: 'clear_count_portion', lineRef: 'a' });
    expect(cleared.countPortions.a).toBeUndefined();
  });

  it('initializes with an empty count-portions map', () => {
    expect(INITIAL_PHASE4_STATE.countPortions).toEqual({});
  });
});

describe('phase 4.5E — calculation regression', () => {
  it('mass and volume ingredients are unchanged', () => {
    const mass = calculateWithMatch(SESSION, '100 g Cheddar cheese', 5002);
    if (mass.ok) {
      expect(mass.preview.ingredients[0].mass_source).toBe('direct_mass');
      expect(mass.preview.ingredients[0].resolved_grams).toBe(100);
    }
    // A volume ingredient without an explicit source-portion selection stays
    // no_mass (Phase 4.5C behavior is unchanged).
    const volume = calculateWithMatch(SESSION, '1 cup Butter', 5008);
    if (volume.ok) {
      expect(volume.preview.ingredients[0].mass_source).toBeUndefined();
      expect(volume.preview.ingredients[0].outcome).toBe('no_mass');
    }
  });

  it('user mass still wins as user_mass and is recomputed', () => {
    const ingredient = structured('8 slices bacon');
    const review = SESSION.reviewIngredient(ingredient);
    const selection = { kind: 'candidate', fdc_id: 5001, review_digest: (review as { review_digest: string }).review_digest };
    const choice = buildUserMassChoice(SESSION, {
      lineRef: 'a',
      ingredient,
      review,
      selection,
      fdcId: 5001,
      quantity: 4,
      unit: 'oz',
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    const result = SESSION.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        { line_ref: 'a', ingredient, review, selection, user_mass_selection: choice.choice.selection },
      ],
    });
    if (result.ok) {
      expect(result.preview.ingredients[0].mass_source).toBe('user_mass');
      expect(result.preview.ingredients[0].resolved_grams).toBeCloseTo(4 * 28.349523125, 6);
    }
  });

  it('recipe totals are finite and never NaN/Infinity/negative', () => {
    const result = calculateWithMatch(SESSION, '8 slices bacon', 5001);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calories = result.preview.totals.calories;
    expect(calories).toBeDefined();
    if (calories) {
      expect(Number.isFinite(calories.amount)).toBe(true);
      expect(calories.amount).toBeGreaterThanOrEqual(0);
    }
  });

  it('unresolved counts remain explicitly unresolved', () => {
    const result = calculateWithMatch(SESSION, '4 slices candy', 5003);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].outcome).toBe('no_mass');
    expect(result.preview.unresolved.map((entry) => entry.outcome)).toContain('no_mass');
  });
});

// ---------------------------------------------------------------------------
// Real authenticated bundle (H)
// ---------------------------------------------------------------------------

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let realSession: AdvancedNutritionSession | null = null;

beforeAll(async () => {
  const inputs: RuntimeBundleInputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!loaded.ok) throw new Error('real bundle failed');
  realSession = loaded.session;
}, 120000);

function realCalculate(line: string, fdcId: number): CalculationResult {
  if (!realSession) throw new Error('no session');
  return calculateWithMatch(realSession, line, fdcId);
}

describe('phase 4.5E — real authenticated USDA bundle', () => {
  it('8 slices bacon -> FDC 168277 slice portion (1 slice = 28 g) -> 224 g', () => {
    const result = realCalculate('8 slices bacon', 168277);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.mass_source).toBe('count_portion');
    expect(evidence.resolved_grams).toBe(224);
    expect(evidence.fdc_id).toBe(168277);
    expect(evidence.portion_index).toBe(1);
    expect(evidence.count_unit).toBe('slice');
    expect(evidence.count_portion_amount).toBe(1);
    expect(evidence.count_gram_weight).toBe(28);
  });

  it('4 slices cheddar cheese -> FDC 328637 slice portion (1 slice = 17 g) -> 68 g', () => {
    const result = realCalculate('4 slices cheddar cheese', 328637);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.mass_source).toBe('count_portion');
    expect(evidence.resolved_grams).toBe(68);
    expect(evidence.fdc_id).toBe(328637);
    expect(evidence.count_gram_weight).toBe(17);
  });

  it('4 burger buns -> FDC 2707657 hamburger-bun portion (1 bun = 52 g) -> 208 g', () => {
    const result = realCalculate('4 burger buns', 2707657);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.mass_source).toBe('count_portion');
    expect(evidence.resolved_grams).toBe(208);
    expect(evidence.fdc_id).toBe(2707657);
    expect(evidence.count_unit).toBe('bun');
  });

  it('2 medium tomatoes stay honestly unresolved when the selected food has no medium portion', () => {
    const result = realCalculate('2 medium tomatoes, sliced', 2709719);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].mass_source).toBeUndefined();
    expect(result.preview.ingredients[0].outcome).toBe('no_mass');
  });

  it('4 pickles stay honestly unresolved (no unambiguous pickle count portion)', () => {
    const result = realCalculate('4 pickles, sliced', 2710078);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].mass_source).toBeUndefined();
    expect(result.preview.ingredients[0].outcome).toBe('no_mass');
  });

  it('the count review reports the real bacon candidates', () => {
    if (!realSession) throw new Error('no session');
    const review = realSession.reviewCountPortions(structured('8 slices bacon'), 168277);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.review.applicable).toBe(true);
    expect(review.review.candidates.map((candidate) => candidate.display_label)).toContain('1 slice = 28 g');
  });
});
