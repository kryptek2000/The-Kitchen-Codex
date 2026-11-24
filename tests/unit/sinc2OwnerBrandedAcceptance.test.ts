/**
 * SINC-2 OWNER ACCEPTANCE — Gochujang Chicken Rice Bowls.
 *
 * Uses the REAL pinned USDA generic bundle for the 16/18 baseline and
 * SYNTHETIC, clearly labeled Branded API fixtures for the gochujang and rice
 * vinegar candidates. This proves the integration path and coverage change; it
 * is NOT a live USDA product match and must not be reported as one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import {
  adaptUsdaBrandedFoodRecord,
  buildBrandedContribution,
  type BrandedLookupTarget,
} from '../../src/core/nutritionV2/brandedFoods';
import {
  combineAiContributionsWithPreview,
  validateAiNutrientContributions,
} from '../../src/core/nutritionV2/aiContribution';
import {
  brandedReviewIdentity,
  resetBrandedEvidenceTrustForTests,
} from '../../src/core/nutritionV2/brandedEvidenceTrust';
import { makeApplyAuthentication, makeTrustedContribution } from '../fixtures/brandedAssertion';
import type { AdvancedNutritionSession, AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  MOCK_BRANDED_RICE_VINEGAR_FDC_ID,
  mockBrandedDetail,
} from '../fixtures/usdaBrandedFixtures';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda',
  USDA_BUNDLE_RELEASE_LOCK.bundle_release
);

const OWNER_LINES: ReadonlyArray<string> = [
  '680 g raw boneless skinless chicken thighs',
  '1 tbsp olive oil',
  '1 medium yellow onion (150 g)',
  '3 garlic cloves',
  '1 tbsp minced fresh ginger',
  '1 red bell pepper (150 g)',
  '1 medium carrot (70 g)',
  '100 g broccoli florets',
  '100 g sugar snap peas',
  '100 g cremini mushrooms',
  '2 tbsp gochujang (Korean chili paste)',
  '2 tbsp reduced-sodium soy sauce',
  '1 tbsp rice vinegar',
  '1 tbsp honey',
  '1 tsp toasted sesame oil',
  '200 g dry jasmine rice',
  '1 tbsp sesame seeds',
  '2 scallions (30 g)',
];

let session: AdvancedNutritionSession;

beforeEach(() => resetBrandedEvidenceTrustForTests());

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const composed = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!composed.ok) throw new Error(`bundle failed: ${(composed as { failure: { code: string } }).failure.code}`);
  session = composed.session;
}, 180000);

function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function setup() {
  const adapted = adaptRecipe({
    title: 'Gochujang Chicken Rice Bowls',
    servings: 4,
    ingredients: OWNER_LINES.map(structuredLine),
  });
  if (!adapted.ok) throw new Error('adapt failed');
  const analysis = analyzeRecipe(session, adapted.recipe.adapted, 4);
  if (!analysis) throw new Error('analysis failed');
  return { adapted: adapted.recipe.adapted, analysis };
}

function targetFor(adapted: ReadonlyArray<AdaptedIngredient>, lineText: string): BrandedLookupTarget {
  const entry = adapted.find((item) => item.ingredient.original === lineText);
  if (!entry) throw new Error('line not found');
  const parsed = parseIngredient(entry.ingredient);
  if (!parsed.ok) throw new Error('line parse failed');
  const p = parsed.parsed;
  return {
    line_ref: entry.line_ref,
    ingredient_text: entry.ingredient.original,
    query: p.query,
    amount: p.amount,
    unit: p.raw_unit ?? null,
    measurement_kind: p.measurement_kind,
    ...(p.grams !== undefined ? { quantity_grams: p.grams } : {}),
    ...(p.milliliters !== undefined ? { quantity_ml: p.milliliters } : {}),
  };
}

const OWNER_REVIEW_IDENTITY = brandedReviewIdentity('owner-session', 'owner-recipe', 4);

async function contributionFor(params: {
  adapted: ReadonlyArray<AdaptedIngredient>;
  lineText: string;
  fdcId: number;
  query: string;
  recipeDigest: string;
}) {
  const target = targetFor(params.adapted, params.lineText);
  const adaptedCandidate = adaptUsdaBrandedFoodRecord(mockBrandedDetail(params.fdcId), params.query);
  if (!adaptedCandidate.ok) throw new Error(`candidate failed: ${(adaptedCandidate as { code?: string }).code}`);
  const candidate = Object.freeze({
    ...adaptedCandidate.candidate,
    evidence_id: `test-evidence-owner-${params.fdcId}-${target.line_ref}`.slice(0, 80),
  });
  const built = buildBrandedContribution(candidate, target);
  if (!built.ok) throw new Error(`contribution failed: ${(built as { reason?: string }).reason}`);
  const trusted = await makeTrustedContribution(built.contribution, {
    recipeDigest: params.recipeDigest,
    reviewIdentity: OWNER_REVIEW_IDENTITY,
  });
  const authentication = await makeApplyAuthentication(trusted, {
    recipeDigest: params.recipeDigest,
    reviewIdentity: OWNER_REVIEW_IDENTITY,
  });
  const checked = validateAiNutrientContributions([trusted], {
    recipe_digest: params.recipeDigest,
    line_refs: [target.line_ref],
    line_text_by_ref: { [target.line_ref]: target.ingredient_text },
    requireTrustedBranded: true,
    brandedAuthentication: authentication,
  });
  if (!checked.ok) throw new Error(`validation failed: ${(checked as { code?: string }).code}`);
  return checked.contributions;
}

describe('SINC-2 owner acceptance — branded evidence changes coverage honestly', () => {
  it('starts from the accepted 16/18 generic baseline', () => {
    const { analysis } = setup();
    expect(analysis.summary.matched).toBe(16);
    expect(analysis.summary.needs_match).toBe(2);
    expect(analysis.preview?.totals.calories).toMatchObject({
      covered_ingredient_count: 16,
      measurable_ingredient_count: 18,
      status: 'partial',
    });
    expect(analysis.preview?.totals.calories?.amount).toBeCloseTo(2300.723333, 5);
  }, 60_000);

  it('adds one explicitly selected synthetic gochujang product and leaves rice vinegar unresolved', async () => {
    const { adapted, analysis } = setup();
    const contributions = await contributionFor({
      adapted,
      lineText: '2 tbsp gochujang (Korean chili paste)',
      fdcId: MOCK_BRANDED_GOCHUJANG_FDC_ID,
      query: 'gochujang',
      recipeDigest: analysis.preview!.ingredient_digest,
    });
    const combined = combineAiContributionsWithPreview(analysis.preview!, contributions);
    expect(combined.totals.calories).toMatchObject({
      covered_ingredient_count: 17,
      measurable_ingredient_count: 18,
      status: 'partial',
    });
    expect(combined.totals.calories?.amount).toBeCloseTo(2360.723333, 5);
    expect(combined.unresolved.map((entry) => entry.line_ref)).toHaveLength(1);
    expect(combined.ai_contributions?.[0]?.source_kind).toBe('usda_branded');
    expect(combined.ai_contributions?.[0]?.usda_branded?.fdc_id).toBe(MOCK_BRANDED_GOCHUJANG_FDC_ID);
    expect(combined.status).toBe('partial');
  }, 60_000);

  it('adds one explicitly selected synthetic rice vinegar product without inventing calories', async () => {
    const { adapted, analysis } = setup();
    const contributions = await contributionFor({
      adapted,
      lineText: '1 tbsp rice vinegar',
      fdcId: MOCK_BRANDED_RICE_VINEGAR_FDC_ID,
      query: 'rice vinegar',
      recipeDigest: analysis.preview!.ingredient_digest,
    });
    const combined = combineAiContributionsWithPreview(analysis.preview!, contributions);
    expect(combined.totals.calories).toMatchObject({
      covered_ingredient_count: 17,
      measurable_ingredient_count: 18,
      status: 'partial',
    });
    expect(combined.totals.calories?.amount).toBeCloseTo(2300.723333, 5);
    expect(combined.totals.carbohydrates?.amount).toBeGreaterThan(233.0938);
    expect(combined.unresolved.map((entry) => entry.line_ref)).toHaveLength(1);
    expect(combined.status).toBe('partial');
  }, 60_000);

  it('can cover both selected lines but still reports partial nutrient truth, not a false complete claim', async () => {
    const { adapted, analysis } = setup();
    const gochujang = await contributionFor({
      adapted,
      lineText: '2 tbsp gochujang (Korean chili paste)',
      fdcId: MOCK_BRANDED_GOCHUJANG_FDC_ID,
      query: 'gochujang',
      recipeDigest: analysis.preview!.ingredient_digest,
    });
    const riceVinegar = await contributionFor({
      adapted,
      lineText: '1 tbsp rice vinegar',
      fdcId: MOCK_BRANDED_RICE_VINEGAR_FDC_ID,
      query: 'rice vinegar',
      recipeDigest: analysis.preview!.ingredient_digest,
    });
    const combined = combineAiContributionsWithPreview(analysis.preview!, [...gochujang, ...riceVinegar]);
    expect(combined.unresolved).toHaveLength(0);
    expect(combined.totals.calories).toMatchObject({
      covered_ingredient_count: 18,
      measurable_ingredient_count: 18,
    });
    // The synthetic label does not publish every scoped nutrient, so the honest
    // status remains partial. The test must not convert coverage into a claim of
    // complete nutritional truth.
    expect(combined.status).toBe('partial');
    expect(combined.totals.calories?.amount).toBeCloseTo(2360.723333, 5);
  }, 60_000);
});
