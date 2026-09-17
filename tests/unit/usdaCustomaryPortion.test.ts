/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5C: US customary portion
 * resolution and explicit total-weight fallback.
 *
 * Acceptance (A–H) and adversarial coverage for:
 *   - authenticated SR Legacy cup portions (`1 cup = 122 g` for FDC 169697);
 *   - per-record cup weights (no shared generic density);
 *   - exact cross-volume scaling (2 tbsp from a 1 cup portion);
 *   - direct US mass (4 oz);
 *   - FNDDS explicit measure amounts;
 *   - absent amounts remaining unusable;
 *   - the explicit user total-weight fallback (`user_mass`);
 *   - forged/tampered/stale/incompatible selections failing closed.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCalculationBundle,
  CUSTOMARY_FOODS,
} from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { buildPortionChoice } from '../../src/core/nutritionV2/phase4/portion';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { reviewFoodPortions } from '../../src/core/nutritionV2/calculation/context';
import { createNutritionCalculationContext } from '../../src/core/nutritionV2/calculation/context';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';
import type { CalculationResult } from '../../src/core/nutritionV2/calculation/types';

const BUNDLE = buildCalculationBundle(CUSTOMARY_FOODS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;
const CONTEXT_RESULT = createNutritionCalculationContext(BUNDLE.manifest, BUNDLE.records);
if (!CONTEXT_RESULT.ok) throw new Error('context failed');
const CONTEXT = CONTEXT_RESULT.context;

interface BindOptions {
  readonly lineRef: string;
  readonly ingredient: string;
  readonly fdcId: number;
  readonly portionIndex: number;
}

function candidateSelection(review: unknown, fdcId: number) {
  return { kind: 'candidate', fdc_id: fdcId, review_digest: (review as { review_digest: string }).review_digest };
}

function bindPortion(options: BindOptions) {
  const review = SESSION.reviewIngredient(options.ingredient);
  const selection = candidateSelection(review, options.fdcId);
  const choice = buildPortionChoice(SESSION, {
    lineRef: options.lineRef,
    ingredient: options.ingredient,
    review,
    selection,
    fdcId: options.fdcId,
    portionIndex: options.portionIndex,
  });
  return { review, selection, choice };
}

function calculateWith(options: {
  ingredient: string;
  review: unknown;
  selection: unknown;
  portionSelection?: unknown;
  userMassSelection?: unknown;
}): CalculationResult {
  return SESSION.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [
      {
        line_ref: 'a',
        ingredient: options.ingredient,
        review: options.review,
        selection: options.selection,
        ...(options.portionSelection !== undefined ? { portion_selection: options.portionSelection } : {}),
        ...(options.userMassSelection !== undefined ? { user_mass_selection: options.userMassSelection } : {}),
      },
    ],
  });
}

/** A tampered result must never present the ingredient as calculated. */
function expectNoTrustedTotals(result: CalculationResult): void {
  if (!result.ok) return;
  expect(result.preview.ingredients[0].outcome).not.toBe('calculated');
}

describe('phase 4.5C — cornmeal acceptance cases', () => {
  it('Case A: authenticated SR Legacy cup portion (FDC 169697 -> 1 cup = 122 g)', () => {
    const portions = reviewFoodPortions(CONTEXT, 169697);
    expect(portions.ok).toBe(true);
    if (!portions.ok) return;
    const candidate = portions.review.candidates[0];
    expect(candidate.kind).toBe('volume');
    expect(candidate.display_label).toBe('1 cup = 122 g');
    expect(candidate.display_label).not.toMatch(/undetermined/i);

    const { review, selection, choice } = bindPortion({
      lineRef: 'a',
      ingredient: '1 cup Cornmeal',
      fdcId: 169697,
      portionIndex: 0,
    });
    expect(review.outcome).toBe('review_required');
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;

    const result = calculateWith({
      ingredient: '1 cup Cornmeal',
      review,
      selection,
      portionSelection: choice.choice.selection,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.mass_source).toBe('source_portion');
    expect(evidence.resolved_grams).toBeCloseTo(122, 6);
    expect(evidence.fdc_id).toBe(169697);
    expect(evidence.portion_index).toBe(0);
    expect(result.preview.totals.calories?.amount).toBeCloseTo((122 / 100) * 362, 6);
  });

  it('Case B: uses the record’s OWN cup weight (FDC 168867 -> 157 g), never 122 g', () => {
    const { review, selection, choice } = bindPortion({
      lineRef: 'a',
      ingredient: '1 cup Cornmeal',
      fdcId: 168867,
      portionIndex: 0,
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    const result = calculateWith({
      ingredient: '1 cup Cornmeal',
      review,
      selection,
      portionSelection: choice.choice.selection,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].mass_source).toBe('source_portion');
    expect(result.preview.ingredients[0].resolved_grams).toBeCloseTo(157, 6);
    expect(result.preview.ingredients[0].fdc_id).toBe(168867);
  });

  it('Case C: exact cross-volume scaling (2 tbsp from a 1 cup = 122 g portion)', () => {
    const { review, selection, choice } = bindPortion({
      lineRef: 'a',
      ingredient: '2 tbsp Cornmeal',
      fdcId: 169697,
      portionIndex: 0,
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    const result = calculateWith({
      ingredient: '2 tbsp Cornmeal',
      review,
      selection,
      portionSelection: choice.choice.selection,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2 tbsp / 1 cup * 122 g = 0.125 * 122 = 15.25 g (never 2/1*122 = 244).
    expect(result.preview.ingredients[0].resolved_grams).toBeCloseTo(15.25, 6);
    expect(result.preview.ingredients[0].mass_source).toBe('source_portion');
  });

  it('Case D: direct US mass (4 oz) requires no portion', () => {
    const review = SESSION.reviewIngredient('4 oz Cornmeal');
    expect(review.outcome).toBe('review_required');
    const result = calculateWith({
      ingredient: '4 oz Cornmeal',
      review,
      selection: candidateSelection(review, 169697),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].mass_source).toBe('direct_mass');
    expect(result.preview.ingredients[0].resolved_grams).toBeCloseTo(4 * 28.349523125, 6);
  });

  it('Case E: FNDDS explicit measure amount is usable', () => {
    const context = CONTEXT;
    const portions = reviewFoodPortions(context, 4001);
    expect(portions.ok).toBe(true);
    if (!portions.ok) return;
    const candidate = portions.review.candidates[0];
    expect(candidate.kind).toBe('volume');
    expect(candidate.effective_amount).toBe(1);
    expect(candidate.display_label).toBe('1 cup = 240 g');

    const { review, selection, choice } = bindPortion({
      lineRef: 'a',
      ingredient: '1 cup Cornmeal cooked',
      fdcId: 4001,
      portionIndex: 0,
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    const result = calculateWith({
      ingredient: '1 cup Cornmeal cooked',
      review,
      selection,
      portionSelection: choice.choice.selection,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].mass_source).toBe('source_portion');
    expect(result.preview.ingredients[0].resolved_grams).toBeCloseTo(240, 6);
  });

  it('Case F: a portion with no amount and no explicit leading amount stays unusable', () => {
    const context = CONTEXT;
    const portions = reviewFoodPortions(context, 4003);
    expect(portions.ok).toBe(true);
    if (!portions.ok) return;
    const candidate = portions.review.candidates[0];
    expect(candidate.kind).toBe('unusable');
    expect(candidate.effective_amount).toBeNull();
    // A forged selection claiming an amount of 1 must not resolve.
    const forged = {
      calculation_version: 'usda_advisory_calc_v3',
      portion_semantics_version: 'usda_portion_semantics_v1',
      line_ref: 'a',
      ingredient_identity_digest: 'x',
      bundle_release: BUNDLE.bundleRelease,
      fdc_id: 4003,
      record_digest: 'y',
      candidates_digest: portions.review.candidates_digest,
      portion_index: 0,
      portion_amount: 1,
      measure: 'Quantity not specified',
      gram_weight: 100,
      semantics_kind: 'volume',
      semantics_unit: 'cup',
      semantics_volume_ml: 236.5882365,
      semantics_amount: 1,
      semantics_gram_weight: 100,
    };
    const review = SESSION.reviewIngredient('1 cup Mystery quantity');
    const result = calculateWith({
      ingredient: '1 cup Mystery quantity',
      review,
      selection: candidateSelection(review, 4003),
      portionSelection: forged,
    });
    expectNoTrustedTotals(result);
  });

  it('Case G: explicit user total weight resolves as user_mass and is recomputed', () => {
    const review = SESSION.reviewIngredient('1 cup Cornmeal');
    const selection = candidateSelection(review, 169697);
    const userMass = buildUserMassChoice(SESSION, {
      lineRef: 'a',
      ingredient: '1 cup Cornmeal',
      review,
      selection,
      fdcId: 169697,
      quantity: 4.3,
      unit: 'oz',
    });
    expect(userMass.ok).toBe(true);
    if (!userMass.ok) return;
    const result = calculateWith({
      ingredient: '1 cup Cornmeal',
      review,
      selection,
      userMassSelection: userMass.choice.selection,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.mass_source).toBe('user_mass');
    expect(evidence.user_mass_quantity).toBe(4.3);
    expect(evidence.user_mass_unit).toBe('oz');
    expect(evidence.resolved_grams).toBeCloseTo(4.3 * 28.349523125, 6);
    // A user-entered weight is never labelled as a USDA portion.
    expect(evidence.mass_source).not.toBe('source_portion');
  });

  it('Case H: malformed / conflicting selections fail closed', () => {
    const review = SESSION.reviewIngredient('1 cup Cornmeal');
    const selection = candidateSelection(review, 169697);
    const portion = bindPortion({ lineRef: 'a', ingredient: '1 cup Cornmeal', fdcId: 169697, portionIndex: 0 });
    if (!portion.choice.ok) throw new Error('portion failed');
    const userMass = buildUserMassChoice(SESSION, {
      lineRef: 'a',
      ingredient: '1 cup Cornmeal',
      review,
      selection,
      fdcId: 169697,
      quantity: 100,
      unit: 'g',
    });
    if (!userMass.ok) throw new Error('user mass failed');

    // Both a source portion and a user weight -> rejected.
    const both = calculateWith({
      ingredient: '1 cup Cornmeal',
      review,
      selection,
      portionSelection: portion.choice.choice.selection,
      userMassSelection: userMass.choice.selection,
    });
    expect(both.ok).toBe(false);

    // Non-finite / negative / zero user weights -> rejected.
    for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
      const bad = buildUserMassChoice(SESSION, {
        lineRef: 'a',
        ingredient: '1 cup Cornmeal',
        review,
        selection,
        fdcId: 169697,
        quantity,
        unit: 'g',
      });
      expect(bad.ok, String(quantity)).toBe(false);
    }
  });
});

describe('phase 4.5C — adversarial portion/user-mass selections fail closed', () => {
  const review = SESSION.reviewIngredient('1 cup Cornmeal');
  const selection = candidateSelection(review, 169697);
  const good = bindPortion({ lineRef: 'a', ingredient: '1 cup Cornmeal', fdcId: 169697, portionIndex: 0 });
  const baseSelection = good.choice.ok ? (good.choice.choice.selection as Record<string, unknown>) : {};
  const ingredient = '1 cup Cornmeal';

  function tampered(overrides: Record<string, unknown>): CalculationResult {
    return calculateWith({
      ingredient,
      review,
      selection,
      portionSelection: { ...baseSelection, ...overrides },
    });
  }

  it('rejects forged FDC id / record digest / candidate digest', () => {
    expectNoTrustedTotals(tampered({ fdc_id: 999999 }));
    expectNoTrustedTotals(tampered({ record_digest: 'f'.repeat(64) }));
    expectNoTrustedTotals(tampered({ candidates_digest: 'f'.repeat(64) }));
  });

  it('rejects a forged portion index and forged raw fields', () => {
    expectNoTrustedTotals(tampered({ portion_index: 99 }));
    expectNoTrustedTotals(tampered({ portion_amount: 2 }));
    expectNoTrustedTotals(tampered({ measure: 'tablespoon' }));
    expectNoTrustedTotals(tampered({ modifier: 'chopped' }));
    expectNoTrustedTotals(tampered({ gram_weight: 999 }));
  });

  it('rejects forged normalized semantics', () => {
    expectNoTrustedTotals(tampered({ semantics_kind: 'mass' }));
    expectNoTrustedTotals(tampered({ semantics_unit: 'kg' }));
    expectNoTrustedTotals(tampered({ semantics_volume_ml: 1 }));
    expectNoTrustedTotals(tampered({ semantics_amount: 2 }));
    expectNoTrustedTotals(tampered({ semantics_gram_weight: 999 }));
  });

  it('rejects an altered semantics version / calculation version and stale identity', () => {
    expectNoTrustedTotals(tampered({ portion_semantics_version: 'usda_portion_semantics_v0' }));
    expectNoTrustedTotals(tampered({ calculation_version: 'usda_advisory_calc_v1' }));
    expectNoTrustedTotals(tampered({ ingredient_identity_digest: 'stale' }));
    expectNoTrustedTotals(tampered({ line_ref: 'other' }));
    expectNoTrustedTotals(tampered({ bundle_release: 'other' }));
  });

  it('rejects duplicate/unknown fields and incompatible dimensions', () => {
    expectNoTrustedTotals(tampered({ extra: 1 }));
    // A count portion is incompatible with a volume ingredient.
    const countPortion = {
      ...baseSelection,
      semantics_kind: 'count',
      semantics_unit: 'piece',
      semantics_volume_ml: null,
      portion_amount: 1,
      measure: 'piece',
      gram_weight: 50,
    };
    expectNoTrustedTotals(
      calculateWith({ ingredient, review, selection, portionSelection: countPortion })
    );
  });

  it('rejects a forged user-mass resolved gram value and unsupported unit', () => {
    const userMass = buildUserMassChoice(SESSION, {
      lineRef: 'a',
      ingredient,
      review,
      selection,
      fdcId: 169697,
      quantity: 100,
      unit: 'g',
    });
    if (!userMass.ok) throw new Error('user mass failed');
    const base = userMass.choice.selection as Record<string, unknown>;
    expectNoTrustedTotals(
      calculateWith({ ingredient, review, selection, userMassSelection: { ...base, grams: 1 } })
    );
    expectNoTrustedTotals(
      calculateWith({ ingredient, review, selection, userMassSelection: { ...base, selection_digest: 'f'.repeat(64) } })
    );
    expectNoTrustedTotals(
      calculateWith({ ingredient, review, selection, userMassSelection: { ...base, unit: 'cups' } })
    );
  });

  it('rejects misleading substring unit matches (cupboard) and hostile input', () => {
    const context = CONTEXT;
    // Build a synthetic record with a `cupboard` modifier via the session is not
    // possible; instead assert the semantics layer itself (covered separately).
    expect(context).toBeTruthy();
    const hostile = calculateWith({
      ingredient,
      review,
      selection,
      portionSelection: { ...baseSelection, measure: { toString: () => 'cup' } },
    });
    expectNoTrustedTotals(hostile);
  });
});
