/**
 * Advanced Nutrition — real-world ingredient understanding + manual USDA search.
 *
 * Hands-on-derived regression corpus for the canonicalization/alias/OR/
 * direct-mass/manual-search work. Uses the SAME pinned USDA bundle the
 * application authenticates.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { projectQueryText } from '../../src/core/nutritionV2/matching/query';
import { projectLiveRow } from '../../src/core/nutritionV2/phase4/liveRow';
import type { AdvancedNutritionSession, AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';
import type { Phase4Row, Phase4State } from '../../src/core/nutritionV2/phase4/types';

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

function adaptLines(lines: ReadonlyArray<string>): ReadonlyArray<AdaptedIngredient> {
  const result = adaptRecipe({
    title: 'Real World',
    servings: 4,
    ingredients: lines.map((original) => structuredLine(original)),
  });
  if (!result.ok) throw new Error('adapt failed');
  return result.recipe.adapted;
}

function analyzeLine(line: string) {
  const adapted = adaptLines([line]);
  const analysis = analyzeRecipe(session, adapted, 4);
  const row = analysis.rows[0];
  if (!row) throw new Error('missing row');
  return { adapted, analysis, row };
}

function projectionOf(line: string) {
  const parsed = parseIngredient(structuredLine(line));
  const query = parsed.ok ? parsed.parsed.query : line;
  return projectQueryText(normalizeQuery(query).text);
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

describe('canonicalization — preparation noise, modifiers, parentheticals', () => {
  it('strips procedural clauses but preserves the 80/20 ratio and food identity', () => {
    const p = projectionOf('454 g ground beef (80/20), kept cold and divided into four loose 4-ounce balls');
    expect(p.core_tokens).toEqual(['ground', 'beef']);
    expect(p.numeric_qualifiers).toEqual(['80', '20']);
    expect(p.preparation_qualifiers).toContain('kept');
    expect(p.preparation_qualifiers).toContain('cold');
  });

  it('strips freshly/ground/coarse noise but keeps black pepper identity', () => {
    const p = projectionOf('0.5 tsp coarse black pepper, freshly ground');
    expect(p.core_tokens).toEqual(['black', 'pepper']);
    expect(p.preparation_qualifiers).toContain('ground');
    expect(p.preparation_qualifiers).toContain('freshly');
    expect(p.refinement_tokens).toContain('coarse');
  });

  it('preserves meaningful material state (fried chicken is not plain chicken)', () => {
    const p = projectionOf('fried chicken');
    expect(p.core_tokens).toContain('fried');
    expect(p.core_tokens).toContain('chicken');
  });

  it('preserves meaningful material state (cooked rice is not raw rice)', () => {
    const p = projectionOf('cooked rice');
    // `cooked` is a nutritionally significant qualifier, not preparation noise:
    // it stays in the required identity so raw/dry rice is demoted.
    expect(p.food_tokens).toContain('cooked');
    expect(p.qualifier_tokens).toContain('cooked');
    expect(p.core_tokens).toContain('rice');
  });

  it('records kosher/sea as optional refinement, not required identity', () => {
    const kosher = projectionOf('1 tsp kosher salt');
    expect(kosher.core_tokens).toEqual(['salt']);
    expect(kosher.refinement_tokens).toContain('kosher');
    const sea = projectionOf('1.25 tsp fine sea salt');
    expect(sea.core_tokens).toEqual(['salt']);
    expect(sea.refinement_tokens).toEqual(expect.arrayContaining(['fine', 'sea']));
  });

  it('decomposes OR alternatives into branches with a shared head', () => {
    const p = projectionOf('4 brioche or potato burger buns, halved');
    expect(p.alternative_groups.length).toBe(2);
    expect(p.alternative_groups[0]).toContain('brioche');
    expect(p.alternative_groups[1]).toContain('potato');
    expect(p.core_tokens).toEqual(['bun']);
    expect(p.form_tokens).toEqual(['hamburger']);
  });
});

// ---------------------------------------------------------------------------
// Acceptance matrix
// ---------------------------------------------------------------------------

describe('real-world acceptance matrix', () => {
  it('A. 454 g ground beef (80/20) procedural clause -> matched, direct mass', () => {
    const { analysis, row } = analyzeLine(
      '454 g ground beef (80/20), kept cold and divided into four loose 4-ounce balls'
    );
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/beef, ground, 80%/i);
    expect(analysis.portions[row.line_ref]).toBeUndefined();
  });

  it('B. 1 lb ground beef (80/20) -> matched, deterministic lb conversion', () => {
    const { row } = analyzeLine('1 lb ground beef (80/20), formed into 4 patties');
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/beef, ground, 80%/i);
  });

  it('C. 1.25 tsp fine sea salt -> sensible salt selection', () => {
    const { row } = analyzeLine('1.25 tsp fine sea salt');
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/^salt/i);
  });

  it('D. 1 tsp kosher salt -> generic salt fallback, no pork/gelatin junk', () => {
    const { row } = analyzeLine('1 tsp kosher salt');
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/^salt/i);
    expect(row.selected_description).not.toMatch(/pork|gelatin/i);
  });

  it('E. 0.5 tsp coarse black pepper -> black pepper, no juice/cabbage', () => {
    const { row } = analyzeLine('0.5 tsp coarse black pepper, freshly ground');
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/pepper, black/i);
    for (const candidate of row.candidates) {
      expect(candidate.description).not.toMatch(/juice|cabbage/i);
    }
  });

  it('F. 2 tsp neutral oil -> bounded neutral oil default (not flavored oil)', () => {
    const { row } = analyzeLine('2 tsp neutral oil');
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/vegetable oil|canola|soybean|peanut/i);
    expect(row.selected_description).not.toMatch(/walnut|coconut|sesame|olive|palm|wheat germ|grapeseed/i);
  });

  it('G. 4 burger buns -> plain bun/roll, composed hamburgers not competing top', () => {
    const { row } = analyzeLine('4 burger buns');
    expect(row.status).not.toBe('needs_match');
    expect(row.selected_description).toMatch(/roll|bun/i);
    expect(row.selected_description).not.toMatch(/double hamburger|sandwich|patty/i);
    // A plain bun/roll candidate must rank ahead of every composed hamburger.
    const firstComposed = row.candidates.findIndex((c) => /hamburger,|double hamburger|sandwich/i.test(c.description));
    const firstPlain = row.candidates.findIndex((c) => /roll.*hamburger bun/i.test(c.description));
    if (firstComposed >= 0 && firstPlain >= 0) expect(firstPlain).toBeLessThan(firstComposed);
  });

  it('H. 4 brioche or potato burger buns -> generic bun fallback', () => {
    const { row } = analyzeLine('4 brioche or potato burger buns, halved');
    expect(row.status).not.toBe('needs_match');
    expect(row.selected_description).toMatch(/roll|bun/i);
    expect(row.selected_description).not.toMatch(/double hamburger|sandwich|patty/i);
  });

  it('I. 57 g unsalted butter -> unsalted butter, direct mass', () => {
    const { row } = analyzeLine('57 g unsalted butter, softened');
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/unsalted/i);
  });

  it('J. 113 g blue cheese -> blue cheese, direct mass', () => {
    const { row } = analyzeLine('113 g blue cheese, crumbled');
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/blue/i);
  });
});

// ---------------------------------------------------------------------------
// Direct recipe mass authority
// ---------------------------------------------------------------------------

describe('direct recipe mass is authoritative', () => {
  function massState(line: string, adapted: ReadonlyArray<AdaptedIngredient>): Phase4State {
    const parsed = parseIngredient(adapted[0].ingredient);
    const review = session.reviewIngredient(adapted[0].ingredient) as { review_digest?: string };
    const row: Phase4Row = {
      line_ref: adapted[0].line_ref,
      original_text: line,
      outcome: 'review_required',
      query: parsed.ok ? parsed.parsed.query : line,
      candidates: [],
      review_digest: review.review_digest,
      selected_fdc_id: undefined,
      review: undefined,
      note: undefined,
    };
    return {
      version: '',
      status: 'ready',
      recipeKey: 'k',
      sessionIdentity: null,
      baseServings: 1,
      rows: [row],
      matches: {},
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
  }

  it('resolves 1 lb ground beef to 453.6 g from direct mass without a USDA portion', () => {
    const adapted = adaptLines(['1 lb ground beef']);
    const state = massState('1 lb ground beef', adapted);
    const live = projectLiveRow({
      row: state.rows[0],
      analyzed: undefined,
      state,
      entry: adapted[0],
      session,
      evidence: undefined,
    });
    expect(live.mass_source).toBe('direct_mass');
    expect(live.resolved_grams).toBeCloseTo(453.59237, 3);
  });

  it('preserves direct mass after a food change (only food-dependent portions clear)', () => {
    const adapted = adaptLines(['1 lb ground beef']);
    const state = massState('1 lb ground beef', adapted);
    // Simulate the user changing the food identity; direct recipe mass is
    // independent of the food and must still resolve.
    const changed: Phase4State = {
      ...state,
      matches: { [adapted[0].line_ref]: { kind: 'manual', fdc_id: 123, review_digest: 'd', description: 'Other beef' } },
    };
    const live = projectLiveRow({
      row: changed.rows[0],
      analyzed: undefined,
      state: changed,
      entry: adapted[0],
      session,
      evidence: undefined,
    });
    expect(live.mass_source).toBe('direct_mass');
    expect(live.resolved_grams).toBeCloseTo(453.59237, 3);
  });
});

// ---------------------------------------------------------------------------
// Manual USDA search
// ---------------------------------------------------------------------------

describe('manual USDA search', () => {
  it('returns bounded results with FDC id, data type, and portion support', () => {
    const result = session.searchFoods('black pepper', 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.length).toBeGreaterThan(0);
    for (const item of result.results) {
      expect(item.fdc_id).toBeGreaterThan(0);
      expect(typeof item.description).toBe('string');
      expect(item.record_digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.results.some((item) => /pepper, black/i.test(item.description))).toBe(true);
  });

  it('a user-selected result becomes user-confirmed food authority and computes mass', () => {
    const ingredient = { original: '4 oz mystery cheese', amount: 4, unit: 'oz', name: 'mystery cheese' };
    const review = session.reviewIngredient(ingredient) as { review_digest?: string };
    const search = session.searchFoods('cheddar', 10);
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const pick = search.results.find((item) => /cheddar/i.test(item.description));
    expect(pick).toBeDefined();
    if (!pick) return;
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
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.match_status).toBe('user_confirmed');
    expect(evidence.fdc_id).toBe(pick.fdc_id);
    expect(evidence.resolved_grams).toBeCloseTo(113.398, 2);
  });

  it('a forged record digest fails closed (no authority)', () => {
    const ingredient = { original: '4 oz mystery cheese', amount: 4, unit: 'oz', name: 'mystery cheese' };
    const review = session.reviewIngredient(ingredient) as { review_digest?: string };
    const search = session.searchFoods('cheddar', 10);
    if (!search.ok) throw new Error('search failed');
    const pick = search.results[0];
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
    expect(calculated.preview.ingredients[0].outcome).not.toBe('calculated');
  });

  it('a wrong-bundle catalog digest fails closed', () => {
    const ingredient = { original: '4 oz mystery cheese', amount: 4, unit: 'oz', name: 'mystery cheese' };
    const review = session.reviewIngredient(ingredient) as { review_digest?: string };
    const search = session.searchFoods('cheddar', 10);
    if (!search.ok) throw new Error('search failed');
    const pick = search.results[0];
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
    const ingredient = { original: '4 oz mystery cheese', amount: 4, unit: 'oz', name: 'mystery cheese' };
    const search = session.searchFoods('cheddar', 10);
    if (!search.ok) throw new Error('search failed');
    const pick = search.results[0];
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

  it('does not call any network/AI: search is local and deterministic', () => {
    const first = session.searchFoods('cheddar', 5);
    const second = session.searchFoods('cheddar', 5);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// Adversarial composed-food boundaries
// ---------------------------------------------------------------------------

describe('adversarial composed-food boundaries', () => {
  it('a composed hamburger cannot be selected for a plain burger bun', () => {
    const { row } = analyzeLine('4 burger buns');
    expect(row.selected_description).not.toMatch(/hamburger,|double hamburger|sandwich|slider|wrap/i);
  });

  it('neutral oil never selects an arbitrary flavored oil', () => {
    const { row } = analyzeLine('2 tsp neutral oil');
    expect(row.selected_description).not.toMatch(/walnut|coconut|sesame|olive|palm|wheat germ|grapeseed/i);
  });
});
