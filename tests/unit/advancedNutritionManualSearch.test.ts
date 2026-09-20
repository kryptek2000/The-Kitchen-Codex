/**
 * Advanced Nutrition — TRUE full-catalog manual USDA search.
 *
 * Proves manual search is a full-dataset discovery tool, independent of the
 * automatic candidate generator, and that a selection made from it is still
 * authenticated by the calculation engine. Uses the real pinned bundle.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildPortionChoice } from '../../src/core/nutritionV2/phase4/portion';
import { projectLiveRow } from '../../src/core/nutritionV2/phase4/liveRow';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession, AdaptedIngredient, Phase4Row, Phase4State } from '../../src/core/nutritionV2/phase4/types';

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

function search(query: string, limit = 20) {
  const result = session.searchFoods(query, limit);
  if (!result.ok) throw new Error('search failed');
  return result;
}

function descriptions(query: string, limit = 20): string[] {
  return search(query, limit).results.map((hit) => hit.description);
}

describe('full-catalog manual search — acceptance matrix', () => {
  it('searches the complete eligible catalog (count exceeds the review candidate limit)', () => {
    const result = search('vegetable oil', 100);
    expect(result.total).toBeGreaterThan(10);
    // The automatic review candidate limit is 10; the full catalog search is not.
    expect(result.results.length).toBeGreaterThan(10);
    for (const hit of result.results) {
      expect(hit.record_digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('finds black pepper by "black pepper"', () => {
    const hits = search('black pepper');
    expect(hits.results[0].description).toMatch(/pepper, black/i);
    expect(hits.results[0].portion_summary).toBeTruthy();
  });

  it('finds black pepper by "pepper black" (token-order independent)', () => {
    const hits = search('pepper black');
    expect(hits.results[0].description).toMatch(/pepper, black/i);
  });

  it('finds a known record by exact FDC id (169697) and ranks it first', () => {
    for (const query of ['169697', 'FDC 169697']) {
      const hits = search(query);
      expect(hits.results.length).toBeGreaterThan(0);
      expect(hits.results[0].fdc_id).toBe(169697);
      expect(hits.results[0].description).toMatch(/Cornmeal, whole-grain, yellow/i);
      expect(hits.results[0].exact_fdc_id).toBe(true);
    }
  });

  it('finds a record by FDC id that automatic matching cannot resolve', () => {
    const automatic = session.reviewIngredient({ name: '169697' });
    expect(automatic.outcome).not.toBe('matched_exact');
    const manual = search('169697');
    expect(manual.results[0].fdc_id).toBe(169697);
  });

  it('finds hamburger bun and ranks plain rolls above composed hamburgers', () => {
    const hits = search('hamburger bun');
    expect(hits.results.length).toBeGreaterThan(0);
    expect(hits.results[0].description).toMatch(/roll.*hamburger bun/i);
    const plainIndex = hits.results.findIndex((hit) => /roll.*hamburger bun/i.test(hit.description));
    const composedIndex = hits.results.findIndex((hit) => /hamburger, on .* bun|double hamburger/i.test(hit.description));
    if (composedIndex >= 0) expect(plainIndex).toBeLessThan(composedIndex);
  });

  it('finds bun records from "burger bun" (bounded synonym)', () => {
    const hits = search('burger bun');
    expect(hits.results.some((hit) => /roll.*hamburger bun/i.test(hit.description))).toBe(true);
  });

  it('finds Brioche even though automatic bun matching would not use it', () => {
    const hits = search('brioche');
    expect(hits.results.some((hit) => /^brioche$/i.test(hit.description))).toBe(true);
  });

  it('searches vegetable oil, canola oil, and sesame oil from the full catalog', () => {
    expect(descriptions('vegetable oil')).toContain('Vegetable oil, NFS');
    expect(descriptions('canola oil').some((d) => /canola/i.test(d))).toBe(true);
    expect(descriptions('sesame oil').some((d) => /sesame/i.test(d))).toBe(true);
  });

  it('allows manual discovery of sesame oil even though neutral-oil auto policy excludes it', () => {
    const hits = search('sesame oil');
    expect(hits.results.some((hit) => /sesame oil|oil, sesame/i.test(hit.description))).toBe(true);
  });

  it('returns no match for kosher salt (no such record exists) rather than substituting table salt', () => {
    const hits = search('kosher salt');
    expect(hits.results).toEqual([]);
    expect(hits.total).toBe(0);
  });

  it('returns no match for sea salt (no such record exists)', () => {
    const hits = search('sea salt');
    expect(hits.results).toEqual([]);
    expect(hits.total).toBe(0);
  });

  it('returns a clear empty result for a nonsense query', () => {
    const hits = search('zzzz nonexistent qwerty');
    expect(hits.results).toEqual([]);
    expect(hits.total).toBe(0);
  });

  it('bounds the result count and reports truncation / total', () => {
    const hits = search('oil', 5);
    expect(hits.results.length).toBeLessThanOrEqual(5);
    expect(hits.total).toBeGreaterThanOrEqual(hits.results.length);
    expect(hits.truncated).toBe(hits.total > hits.results.length);
    expect(hits.limit).toBe(5);
  });

  it('is deterministic for identical queries', () => {
    expect(search('cheddar cheese')).toEqual(search('cheddar cheese'));
  });

  it('exposes discovery-safe fields only (no nutrients / authority)', () => {
    const hit = search('cheddar cheese').results[0] as unknown as Record<string, unknown>;
    expect(hit).not.toHaveProperty('nutrients');
    expect(hit).not.toHaveProperty('automatic');
    expect(hit).not.toHaveProperty('selection');
  });
});

describe('manual search — selection authority and live state', () => {
  function ingredientLine(original: string) {
    const parsed = parseIngredient(original);
    if (!parsed.ok) throw new Error('parse failed');
    const p = parsed.parsed;
    return {
      original,
      ...(p.amount !== null ? { amount: p.amount } : {}),
      ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
      name: p.query,
    };
  }

  it('a valid manual selection authenticates and resolves mass', () => {
    const ingredient = ingredientLine('4 oz mystery cheese');
    const review = session.reviewIngredient(ingredient) as { review_digest?: string };
    const pick = search('cheddar cheese').results[0];
    const calculated = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'ing:0:test',
          ingredient,
          selection: {
            kind: 'manual',
            fdc_id: pick.fdc_id,
            record_digest: pick.record_digest,
            catalog_digest: session.metadata().catalog_digest,
            line_ref: 'ing:0:test',
            review_digest: review.review_digest,
          },
        },
      ],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].match_status).toBe('user_confirmed');
    expect(calculated.preview.ingredients[0].resolved_grams).toBeGreaterThan(0);
  });

  it('a forged record digest from a real search hit fails closed', () => {
    const ingredient = ingredientLine('4 oz mystery cheese');
    const review = session.reviewIngredient(ingredient) as { review_digest?: string };
    const pick = search('cheddar cheese').results[0];
    const calculated = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'ing:0:test',
          ingredient,
          selection: {
            kind: 'manual',
            fdc_id: pick.fdc_id,
            record_digest: '0'.repeat(64),
            catalog_digest: session.metadata().catalog_digest,
            line_ref: 'ing:0:test',
            review_digest: review.review_digest,
          },
        },
      ],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].match_status).not.toBe('user_confirmed');
  });

  it('a wrong catalog digest fails closed', () => {
    const ingredient = ingredientLine('4 oz mystery cheese');
    const review = session.reviewIngredient(ingredient) as { review_digest?: string };
    const pick = search('cheddar cheese').results[0];
    const calculated = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'ing:0:test',
          ingredient,
          selection: {
            kind: 'manual',
            fdc_id: pick.fdc_id,
            record_digest: pick.record_digest,
            catalog_digest: 'a'.repeat(64),
            line_ref: 'ing:0:test',
            review_digest: review.review_digest,
          },
        },
      ],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].match_status).not.toBe('user_confirmed');
  });

  it('a stale review digest fails closed', () => {
    const ingredient = ingredientLine('4 oz mystery cheese');
    const pick = search('cheddar cheese').results[0];
    const calculated = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          line_ref: 'ing:0:test',
          ingredient,
          selection: {
            kind: 'manual',
            fdc_id: pick.fdc_id,
            record_digest: pick.record_digest,
            catalog_digest: session.metadata().catalog_digest,
            line_ref: 'ing:0:test',
            review_digest: 'b'.repeat(64),
          },
        },
      ],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].match_status).not.toBe('user_confirmed');
  });

  it('a manual selection on a matched row computes with a compatible authenticated portion', () => {
    const ingredient = ingredientLine('1 tsp mystery spice');
    const review = session.reviewIngredient(ingredient) as { review_digest?: string };
    const pepper = search('black pepper').results[0];
    const portionReview = session.reviewPortions(pepper.fdc_id);
    expect(portionReview.ok).toBe(true);
    if (!portionReview.ok) return;
    const portion = portionReview.review.candidates.find((c) => c.gram_weight > 0 && c.kind === 'volume');
    if (!portion) return;
    const choice = buildPortionChoice(session, {
      lineRef: 'ing:0:test',
      ingredient,
      selection: {
        kind: 'manual',
        fdc_id: pepper.fdc_id,
        record_digest: pepper.record_digest,
        catalog_digest: session.metadata().catalog_digest,
        line_ref: 'ing:0:test',
        review_digest: review.review_digest,
      },
      fdcId: pepper.fdc_id,
      portionIndex: portion.index,
    });
    expect(choice.ok).toBe(true);
  });

  it('direct recipe mass survives a manual food replacement', () => {
    const adaptedResult = adaptRecipe({
      title: 'T',
      servings: 1,
      ingredients: [ingredientLine('1 lb ground beef')],
    });
    if (!adaptedResult.ok) throw new Error('adapt failed');
    const adapted = adaptedResult.recipe.adapted as ReadonlyArray<AdaptedIngredient>;
    const parsed = parseIngredient(adapted[0].ingredient);
    const review = session.reviewIngredient(adapted[0].ingredient) as { review_digest?: string };
    const row: Phase4Row = {
      line_ref: adapted[0].line_ref,
      original_text: '1 lb ground beef',
      outcome: 'review_required',
      query: parsed.ok ? parsed.parsed.query : 'ground beef',
      candidates: [],
      review_digest: review.review_digest,
      selected_fdc_id: undefined,
      review: undefined,
      note: undefined,
    };
    const state: Phase4State = {
      version: '',
      status: 'ready',
      recipeKey: 'k',
      sessionIdentity: null,
      baseServings: 1,
      rows: [row],
      matches: {
        [adapted[0].line_ref]: {
          kind: 'manual',
          fdc_id: 123,
          review_digest: 'd',
          description: 'Replacement beef',
        },
      },
      portions: {},
      countPortions: {},
      userMasses: {},
      basis: 'entire_recipe',
      selectedServings: 1,
      preview: null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    };
    const live = projectLiveRow({
      row,
      analyzed: undefined,
      state,
      entry: adapted[0],
      session,
      evidence: undefined,
    });
    expect(live.mass_source).toBe('direct_mass');
    expect(live.resolved_grams).toBeCloseTo(453.59237, 3);
  });

  it('search alone never changes the session authority or grants a selection', () => {
    const before = session.metadata().catalog_digest;
    const hits = search('black pepper');
    expect(hits.results.length).toBeGreaterThan(0);
    expect(session.metadata().catalog_digest).toBe(before);
    // The discovery hit carries no authority to select on its own.
    expect((hits.results[0] as unknown as Record<string, unknown>).automatic).toBeUndefined();
  });
});
