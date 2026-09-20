/**
 * Advanced Nutrition — real-bundle working-review hydration.
 *
 * Proves previously reviewed evidence (USDA food choice + user-entered total
 * weight) hydrates from a saved block into the working review for an unchanged
 * recipe, using the real pinned bundle. The tomato 246 g / pickle 540 g case is
 * the documented hands-on acceptance.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import { projectLiveRow } from '../../src/core/nutritionV2/phase4/liveRow';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/types';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  session = result.session;
}, 180000);

function line(original: string): Record<string, unknown> {
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

describe('real-bundle working-review hydration', () => {
  it('restores tomato 246 g and pickle 540 g as reviewed user weights for an unchanged recipe', () => {
    const recipe = {
      title: 'Bacon Cheeseburger hydration',
      servings: 4,
      ingredients: [line('2 medium tomatoes'), line('3 pickles')],
    };
    const adaptation = adaptRecipe(recipe);
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(session, adapted);

    const tomato = session.searchFoods('tomatoes', 5);
    const pickle = session.searchFoods('pickles', 5);
    if (!tomato.ok || !pickle.ok) throw new Error('search failed');
    const tomatoHit = tomato.results[0];
    const pickleHit = pickle.results[0];

    const raw = {
      schema: 1 as const,
      basis: 'total' as const,
      servings: 4,
      status: 'complete' as const,
      computed_at: '2026-09-19T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: 'fda_adult_4plus_2020',
      sources: ['usda_fdc' as const],
      source_releases: { usda_fdc: session.metadata().bundle_release },
      nutrient_scope: ['calories' as const],
      nutrients: {
        calories: {
          amount: 500,
          unit: 'kcal' as const,
          status: 'complete' as const,
          coverage: 1,
          covered_ingredient_count: 2,
          measurable_ingredient_count: 2,
        },
      },
      ingredients: [
        {
          line_ref: rows[0].line_ref,
          source: 'usda_fdc' as const,
          source_food_id: String(tomatoHit.fdc_id),
          source_release: session.metadata().bundle_release,
          match_status: 'confirmed' as const,
          resolved: true,
          user_confirmed: true,
          amount: { value: 246, unit: 'g' as const },
        },
        {
          line_ref: rows[1].line_ref,
          source: 'usda_fdc' as const,
          source_food_id: String(pickleHit.fdc_id),
          source_release: session.metadata().bundle_release,
          match_status: 'confirmed' as const,
          resolved: true,
          user_confirmed: true,
          amount: { value: 540, unit: 'g' as const },
        },
      ],
      unresolved: [],
    };
    const validation = validateCodexNutritionV1(raw);
    expect(validation.ok).toBe(true);
    if (!validation.ok || !validation.value) return;

    const hydrated = hydrateWorkingReview({
      session,
      adapted,
      rows,
      savedBlock: validation.value,
    });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.hydrated_count).toBe(2);
    expect(hydrated.matches[rows[0].line_ref]).toBeDefined();
    expect(hydrated.userMasses[rows[0].line_ref]?.quantity).toBe(246);
    expect(hydrated.userMasses[rows[1].line_ref]?.quantity).toBe(540);

    const state = {
      version: '',
      status: 'ready',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: null,
      baseServings: 4,
      rows,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      basis: 'entire_recipe',
      selectedServings: 4,
      preview: null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    } as never;

    const tomatoLive = projectLiveRow({
      row: rows[0],
      analyzed: undefined,
      state,
      entry: adapted[0],
      session,
      evidence: undefined,
    });
    expect(tomatoLive.status).toBe('matched');
    expect(tomatoLive.resolved_grams).toBe(246);
    expect(tomatoLive.mass_source).toBe('user_mass');

    const pickleLive = projectLiveRow({
      row: rows[1],
      analyzed: undefined,
      state,
      entry: adapted[1],
      session,
      evidence: undefined,
    });
    expect(pickleLive.status).toBe('matched');
    expect(pickleLive.resolved_grams).toBe(540);
  });

  it('restores manually reviewed broccoli + garlic after reopen (hands-on repro)', () => {
    const recipe = {
      title: 'Broccoli Garlic',
      servings: 4,
      ingredients: [line('4 cup broccoli florets'), line('2 g garlic, minced')],
    };
    const adaptation = adaptRecipe(recipe);
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(session, adapted);

    const broccoli = session.searchFoods('broccoli', 5);
    const garlic = session.searchFoods('garlic', 5);
    if (!broccoli.ok || !garlic.ok) throw new Error('search failed');
    const broccoliHit = broccoli.results.find((hit) => /^broccoli, raw$/i.test(hit.description));
    const garlicHit = garlic.results.find((hit) => /^garlic, raw$/i.test(hit.description));
    expect(broccoliHit).toBeDefined();
    expect(garlicHit).toBeDefined();
    if (!broccoliHit || !garlicHit) return;

    const raw = {
      schema: 1 as const,
      basis: 'total' as const,
      servings: 4,
      status: 'complete' as const,
      computed_at: '2026-09-20T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: 'fda_adult_4plus_2020',
      sources: ['usda_fdc' as const],
      source_releases: { usda_fdc: session.metadata().bundle_release },
      nutrient_scope: ['calories' as const],
      nutrients: {
        calories: {
          amount: 100,
          unit: 'kcal' as const,
          status: 'complete' as const,
          coverage: 1,
          covered_ingredient_count: 2,
          measurable_ingredient_count: 2,
        },
      },
      ingredients: [
        {
          line_ref: rows[0].line_ref,
          source: 'usda_fdc' as const,
          source_food_id: String(broccoliHit.fdc_id),
          source_release: session.metadata().bundle_release,
          match_status: 'confirmed' as const,
          resolved: true,
          user_confirmed: true,
          amount: { value: 400, unit: 'g' as const },
        },
        {
          line_ref: rows[1].line_ref,
          source: 'usda_fdc' as const,
          source_food_id: String(garlicHit.fdc_id),
          source_release: session.metadata().bundle_release,
          match_status: 'confirmed' as const,
          resolved: true,
          user_confirmed: true,
          amount: { value: 2, unit: 'g' as const },
          conversion_basis: 'direct_mass' as const,
        },
      ],
      unresolved: [],
    };
    const validation = validateCodexNutritionV1(raw);
    expect(validation.ok).toBe(true);
    if (!validation.ok || !validation.value) return;

    const hydrated = hydrateWorkingReview({ session, adapted, rows, savedBlock: validation.value });
    expect(hydrated?.hydrated_count).toBe(2);
    if (!hydrated) return;
    // Broccoli restores as an explicit user-confirmed manual selection + 400 g.
    expect(hydrated.matches[rows[0].line_ref]?.kind).toBe('manual');
    expect(hydrated.userMasses[rows[0].line_ref]?.quantity).toBe(400);
    // Garlic restores as the same manual selection; its 2 g is direct recipe mass.
    expect(hydrated.matches[rows[1].line_ref]?.kind).toBe('manual');
    expect(String(hydrated.matches[rows[1].line_ref]?.fdc_id)).toBe(String(garlicHit.fdc_id));

    const state = {
      version: '',
      status: 'ready',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: null,
      baseServings: 4,
      rows,
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      basis: 'entire_recipe',
      selectedServings: 4,
      preview: null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    } as never;

    const broccoliLive = projectLiveRow({
      row: rows[0],
      analyzed: undefined,
      state,
      entry: adapted[0],
      session,
      evidence: undefined,
    });
    expect(broccoliLive.status).toBe('matched');
    expect(broccoliLive.selected_description).toMatch(/broccoli, raw/i);
    expect(broccoliLive.resolved_grams).toBe(400);
    expect(broccoliLive.food_authority).toBe('user_confirmed');

    const garlicLive = projectLiveRow({
      row: rows[1],
      analyzed: undefined,
      state,
      entry: adapted[1],
      session,
      evidence: undefined,
    });
    expect(garlicLive.status).toBe('matched');
    expect(garlicLive.selected_description).toMatch(/garlic, raw/i);
    expect(garlicLive.resolved_grams).toBe(2);
    expect(garlicLive.mass_source).toBe('direct_mass');
    expect(garlicLive.food_authority).toBe('user_confirmed');
  });

  it('does not hydrate a line whose line reference changed', () => {
    const recipe = { title: 'T', servings: 4, ingredients: [line('2 medium tomatoes')] };
    const adaptation = adaptRecipe(recipe);
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(session, adapted);
    const tomato = session.searchFoods('tomatoes', 5);
    if (!tomato.ok) throw new Error('search failed');

    const raw = {
      schema: 1 as const,
      basis: 'total' as const,
      servings: 4,
      status: 'complete' as const,
      computed_at: '2026-09-19T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: 'fda_adult_4plus_2020',
      sources: ['usda_fdc' as const],
      source_releases: { usda_fdc: session.metadata().bundle_release },
      nutrient_scope: ['calories' as const],
      nutrients: {},
      ingredients: [
        {
          line_ref: 'ing:0:stale-line-ref',
          source: 'usda_fdc' as const,
          source_food_id: String(tomato.results[0].fdc_id),
          source_release: session.metadata().bundle_release,
          match_status: 'confirmed' as const,
          resolved: true,
          user_confirmed: true,
          amount: { value: 246, unit: 'g' as const },
        },
      ],
      unresolved: [],
    };
    const validation = validateCodexNutritionV1(raw);
    if (!validation.ok || !validation.value) throw new Error('block invalid');
    const hydrated = hydrateWorkingReview({ session, adapted, rows, savedBlock: validation.value });
    expect(hydrated).toBeUndefined();
  });
});
