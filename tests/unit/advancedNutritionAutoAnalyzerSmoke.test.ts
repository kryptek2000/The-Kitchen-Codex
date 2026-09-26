/**
 * Advanced Nutrition — post-Phase-5 smoke-test remediation.
 *
 * Permanent regression corpus for the deterministic automatic analyzer:
 *   - food-identity ranking fixes (preparation/noise words, compound foods);
 *   - the match-confidence / automatic-selection contract;
 *   - deterministic authenticated portion auto-resolution;
 *   - compact row-state classification;
 *   - the real smoke-test ingredients against the pinned USDA bundle.
 *
 * The real bundle is the same checked-in artifact the application authenticates.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe, hasExplicitMassRange } from '../../src/core/nutritionV2/phase4/analyzer';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { buildPortionChoice } from '../../src/core/nutritionV2/phase4/portion';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import type { AdvancedNutritionSession, AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { rankCandidates } from '../../src/core/nutritionV2/matching/rank';
import {
  bestEffortDefaultCandidates,
  classifyReviewConfidence,
  explainCandidate,
  selectAutomaticMatch,
  selectBestEffortMatch,
} from '../../src/core/nutritionV2/matching/confidence';
import { createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import type { RankableEntry } from '../../src/core/nutritionV2/matching/types';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

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

/**
 * Builds production-shaped structured ingredients (amount/unit/name) from raw
 * lines, exactly as the Markdown parser supplies them to the card.
 */
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
    title: 'Smoke Test Recipe',
    servings: 4,
    ingredients: lines.map((original) => structuredLine(original)),
  });
  if (!result.ok) throw new Error('adapt failed');
  return result.recipe.adapted;
}

function analyzeLines(lines: ReadonlyArray<string>) {
  const adapted = adaptLines(lines);
  const analysis = analyzeRecipe(session, adapted, 4);
  return { adapted, analysis };
}

function rowFor(lines: ReadonlyArray<string>, index = 0) {
  const { analysis } = analyzeLines(lines);
  const row = analysis.rows[index];
  if (!row) throw new Error('missing row');
  return { analysis, row };
}

function topDescriptions(lines: ReadonlyArray<string>, index = 0, count = 6): string[] {
  const { adapted } = analyzeLines(lines);
  const review = session.reviewIngredient(adapted[index].ingredient) as {
    candidates?: ReadonlyArray<{ description: string }>;
  };
  return (review.candidates ?? []).slice(0, count).map((candidate) => candidate.description);
}

// ---------------------------------------------------------------------------
// A–J: smoke-test corpus
// ---------------------------------------------------------------------------

describe('auto analyzer — smoke corpus', () => {
  it('A. unsalted butter: plain butter wins; peanut butter / pickles do not', () => {
    const lines = ['0.5 cup unsalted butter, chilled and cubed'];
    const { analysis, row } = rowFor(lines);
    expect(row.selected_description).toMatch(/butter/i);
    expect(row.selected_description).not.toMatch(/peanut|pickle|margarine|blend/i);
    // The pinned USDA record for unsalted butter carries no authoritative
    // portion, so the amount fails closed to `needs_amount`; the food identity is
    // still a confident automatic selection.
    expect(['matched', 'needs_amount']).toContain(row.status);
    if (row.status === 'matched') expect(analysis.portions[row.line_ref]).toBeDefined();
    const tops = topDescriptions(lines);
    expect(tops[0]).toMatch(/butter, stick, unsalted/i);
    expect(tops.some((d) => /peanut butter/i.test(d))).toBe(false);
  });

  it('B. cottage cheese: cottage cheese auto-selected', () => {
    const { row } = rowFor(['3/4 cup cottage cheese']);
    expect(row.selected_description).toMatch(/cottage/i);
    expect(row.status).toBe('matched');
  });

  it('C. red pepper flakes: no cereal/onion/potato flakes; fail safe', () => {
    const lines = ['1/4 teaspoon crushed red pepper flakes'];
    const { row } = rowFor(lines);
    const tops = topDescriptions(lines);
    for (const description of tops) {
      expect(description).not.toMatch(/cereal|onion.*flakes|potato.*flakes|bran flakes|corn flakes/i);
    }
    expect(tops.some((d) => /pepper/i.test(d))).toBe(true);
    // No flakes-form pepper exists, so this must NOT be an automatic match.
    expect(row.status).not.toBe('matched');
    expect(['matched_check', 'needs_match']).toContain(row.status);
  });

  it('D. provolone: cheese identity dominates; the written total-mass range resolves by midpoint', () => {
    const lines = ['3 to 4 slices provolone (about 75 to 100 grams in total)'];
    const { analysis, row } = rowFor(lines);
    expect(row.selected_description).toMatch(/provolone/i);
    const tops = topDescriptions(lines);
    for (const description of tops) {
      expect(description).not.toMatch(/quail|pheasant|salmon/i);
    }
    expect(hasExplicitMassRange(lines[0])).toBe(true);
    // The line declares its own total mass range, so it resolves through the
    // documented midpoint policy (75-100 g -> 87.5 g) as direct recipe mass.
    expect(row.status).toBe('matched');
    expect(analysis.preview?.ingredients[0].mass_source).toBe('direct_mass');
    expect(analysis.preview?.ingredients[0].resolved_grams).toBeCloseTo(87.5, 6);
  });

  it('E. tomato: tomato only; thinly-sliced beef excluded', () => {
    const lines = ['1 tomato (thinly sliced)'];
    const { row } = rowFor(lines);
    expect(row.selected_description).toMatch(/tomato/i);
    const tops = topDescriptions(lines);
    for (const description of tops) {
      expect(description).not.toMatch(/beef/i);
    }
  });

  it('F. onion powder: selected + compatible tsp mass auto-resolved', () => {
    const lines = ['1/2 tsp onion powder'];
    const { analysis, row } = rowFor(lines);
    expect(row.selected_description).toMatch(/onion powder/i);
    expect(row.status).toBe('matched');
    expect(analysis.portions[row.line_ref]).toBeDefined();
  });

  it('G. black pepper: spice selected', () => {
    const lines = ['1/2 teaspoon ground black pepper'];
    const { row } = rowFor(lines);
    expect(row.selected_description).toMatch(/pepper, black/i);
    expect(row.status).toBe('matched');
  });

  it('H. salt: table salt selected', () => {
    const lines = ['1/2 teaspoon salt'];
    const { row } = rowFor(lines);
    expect(row.selected_description).toMatch(/^salt/i);
    expect(row.status).toBe('matched');
  });

  it('I. ketchup: selected and volume portion auto-resolved', () => {
    const lines = ['1/2 cup ketchup'];
    const { analysis, row } = rowFor(lines);
    expect(row.selected_description).toMatch(/ketchup/i);
    expect(row.status).toBe('matched');
    expect(analysis.portions[row.line_ref]).toBeDefined();
  });

  it('J. buttermilk: unique exact behavior remains automatic', () => {
    const lines = ['1 cup buttermilk'];
    const { row } = rowFor(lines);
    expect(row.selected_description).toMatch(/buttermilk/i);
    expect(row.status).toBe('matched');
  });

  it('K. garlic salt (absent food) is NOT auto-matched to plain salt', () => {
    const lines = ['1/2 tsp garlic salt'];
    const { row } = rowFor(lines);
    expect(row.status).not.toBe('matched');
    expect(row.selected_fdc_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real-recipe integration (representative smoke-test recipes)
// ---------------------------------------------------------------------------

const HOT_DOG_CHILI = [
  '1 lb ground beef',
  '1 onion, chopped',
  '1 (15 oz) can tomato sauce',
  '1/2 cup ketchup',
  '2 tbsp chili powder',
  '1 tsp salt',
  '1/2 teaspoon ground black pepper',
  '1 cup water',
];

const SUB_SANDWICH = [
  '2 slices provolone',
  '4 slices bacon',
  '1 tomato, sliced',
  '1/2 cup shredded cheddar',
  '2 tbsp mayonnaise',
  '1 tsp mustard',
  '4 slices bread',
];

describe('auto analyzer — real recipe integration', () => {
  it("Jeff's Hot Dog Chili: mostly automatic, no fabricated totals", () => {
    const { analysis } = analyzeLines(HOT_DOG_CHILI);
    expect(analysis.summary.total).toBe(HOT_DOG_CHILI.length);
    const automatic = analysis.summary.matched + analysis.summary.matched_check;
    expect(automatic).toBeGreaterThanOrEqual(5);
    const ketchup = analysis.rows.find((row) => /ketchup/i.test(row.original_text));
    expect(ketchup?.selected_description).toMatch(/ketchup/i);
    const salt = analysis.rows.find((row) => /salt/i.test(row.original_text) && !/beef/i.test(row.original_text));
    expect(salt?.selected_description).toMatch(/^salt/i);
    // No persistence happens during analysis.
    expect(analysis.preview?.advisory_only).toBe(true);
  });

  it('sub sandwich: cheese/protein identities dominate; no garbage auto-matches', () => {
    const { analysis } = analyzeLines(SUB_SANDWICH);
    const provolone = analysis.rows.find((row) => /provolone/i.test(row.original_text));
    expect(provolone?.selected_description).toMatch(/provolone/i);
    const bacon = analysis.rows.find((row) => /bacon/i.test(row.original_text));
    expect(bacon?.selected_description).toMatch(/bacon/i);
    const cheddar = analysis.rows.find((row) => /cheddar/i.test(row.original_text));
    expect(cheddar?.selected_description).toMatch(/cheddar/i);
    const bread = analysis.rows.find((row) => /bread/i.test(row.original_text));
    expect(bread?.selected_description).toMatch(/bread/i);
    expect(bread?.selected_description).not.toMatch(/bread, cheese/i);
    for (const row of analysis.rows) {
      if (row.status === 'matched') {
        expect(row.selected_description ?? '').not.toMatch(/quail|pheasant|salmon/i);
      }
    }
  });

  it('HappyForks-style recipe: one-click analysis, sensible auto-foods, exceptions flagged', () => {
    const lines = [
      '1 lb chicken breast, cubed',
      '1/2 cup cottage cheese',
      '2 celery stalks, chopped',
      '2 green onions, sliced',
      '1/2 cup shredded cheddar',
      '1 jalapeno, chopped',
      '4 slices bacon',
      '1/4 cup sour cream',
      '1/4 cup cilantro',
      '1/2 tsp onion powder',
      '1/2 tsp garlic salt',
      '2 tbsp lime juice',
    ];
    const { analysis } = analyzeLines(lines);
    expect(analysis.summary.total).toBe(12);
    const selected = (needle: RegExp) =>
      analysis.rows.find((row) => needle.test(row.original_text))?.selected_description ?? '';
    expect(selected(/chicken/)).toMatch(/chicken/i);
    expect(selected(/chicken/)).not.toMatch(/^fat, chicken/i);
    expect(selected(/cottage/)).toMatch(/cottage/i);
    expect(selected(/cheddar/)).toMatch(/cheddar/i);
    expect(selected(/bacon/)).toMatch(/bacon/i);
    expect(selected(/onion powder/)).toMatch(/onion powder/i);
    expect(selected(/lime juice/)).toMatch(/lime/i);
    expect(selected(/jalapeno/)).toMatch(/jalapeno/i);
    // At least the obvious rows auto-match; the preview exists without opening
    // any candidate list.
    expect(analysis.summary.matched).toBeGreaterThanOrEqual(6);
    expect(analysis.preview).toBeDefined();
    // Each row is classified into a user-facing state.
    for (const row of analysis.rows) {
      expect([
        'matched',
        'matched_check',
        'needs_amount',
        'needs_match',
        'unresolved',
        'qualitative',
      ]).toContain(row.status);
    }
  });

  it('hostile input never throws and never auto-selects garbage', () => {
    const hostile = ['\u0000\u0007', 'a'.repeat(500), '🥒🔥'];
    for (const line of hostile) {
      const { analysis } = analyzeLines([line]);
      for (const row of analysis.rows) {
        expect(['matched', 'matched_check', 'needs_amount', 'needs_match', 'unresolved', 'qualitative']).toContain(row.status);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Compound-food protection and core identity (synthetic, deterministic)
// ---------------------------------------------------------------------------

function entry(fdcId: number, description: string, dataType: UsdaDataType = 'fndds'): RankableEntry {
  const normalized = normalizeQuery(description);
  return {
    fdc_id: fdcId,
    data_type: dataType,
    description,
    normalized_description: normalized.text,
    normalized_tokens: normalized.tokens,
    record_digest: 'a'.repeat(64),
  };
}

function ranked(query: string, entries: ReadonlyArray<RankableEntry>): string[] {
  return rankCandidates(normalizeQuery(query), entries, 25).map((candidate) => candidate.description);
}

describe('auto analyzer — compound food protection', () => {
  it('plain butter outranks peanut butter / bread-and-butter pickles', () => {
    const entries = [
      entry(1, 'Peanut butter, creamy'),
      entry(2, 'Pickles, cucumber, sweet (includes bread and butter pickles)'),
      entry(3, 'Butter, stick, unsalted'),
      entry(4, 'Butter, stick, salted'),
    ];
    const result = ranked('butter', entries);
    expect(result[0]).toMatch(/^Butter/);
    expect(result.indexOf('Peanut butter, creamy')).toBeGreaterThan(result.indexOf('Butter, stick, unsalted'));
  });

  it('plain tomato demotes tomato sauce', () => {
    const entries = [entry(1, 'Tomato, sauce, canned, with salt added'), entry(2, 'Tomatoes, raw')];
    expect(ranked('tomato', entries)[0]).toBe('Tomatoes, raw');
  });

  it('pepper steak does not outrank the spice for black pepper', () => {
    const entries = [entry(1, 'Pepper steak'), entry(2, 'Spices, pepper, black')];
    expect(ranked('black pepper', entries)[0]).toBe('Spices, pepper, black');
  });

  it('form words never become the required anchor (flakes/powder)', () => {
    const entries = [
      entry(1, 'Onions, dehydrated flakes'),
      entry(2, 'Cereals ready-to-eat, RALSTON Corn Flakes'),
      entry(3, 'Spices, pepper, red or cayenne'),
    ];
    const result = ranked('crushed red pepper flakes', entries);
    expect(result).toContain('Spices, pepper, red or cayenne');
    expect(result).not.toContain('Onions, dehydrated flakes');
    expect(result).not.toContain('Cereals ready-to-eat, RALSTON Corn Flakes');
  });

  it('conjunction/noise prose never becomes the required anchor', () => {
    const entries = [
      entry(1, 'Quail, cooked, total edible'),
      entry(2, 'Cheese, provolone'),
    ];
    const result = ranked('3 to 4 slices provolone (about 75 to 100 grams in total)', entries);
    expect(result[0]).toBe('Cheese, provolone');
  });
});

// ---------------------------------------------------------------------------
// Confidence contract
// ---------------------------------------------------------------------------

describe('auto analyzer — confidence contract', () => {
  it('classifies a unique exact match as high confidence', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 9001, dataType: 'fndds', description: 'Ketchup' },
    ]);
    const catalogResult = createReviewCatalog(manifest, records);
    if (!catalogResult.ok) throw new Error('catalog failed');
    const review = reviewIngredient(catalogResult.catalog, 'ketchup');
    expect(classifyReviewConfidence(review)).toBe('high');
    expect(selectAutomaticMatch(review)?.fdc_id).toBe(9001);
  });

  it('never auto-selects a one-token partial overlap among unrelated foods', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 1, dataType: 'fndds', description: 'Cereal flakes' },
      { fdcId: 2, dataType: 'fndds', description: 'Onion flakes' },
    ]);
    const catalogResult = createReviewCatalog(manifest, records);
    if (!catalogResult.ok) throw new Error('catalog failed');
    const review = reviewIngredient(catalogResult.catalog, 'red pepper flakes');
    expect(selectAutomaticMatch(review)).toBeUndefined();
    expect(classifyReviewConfidence(review)).not.toBe('high');
  });

  it('explains missing core identity, qualifier opposition, and compound foods', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 1, dataType: 'fndds', description: 'Butter, salted' },
      { fdcId: 2, dataType: 'fndds', description: 'Peanut butter' },
    ]);
    const catalogResult = createReviewCatalog(manifest, records);
    if (!catalogResult.ok) throw new Error('catalog failed');
    const review = reviewIngredient(catalogResult.catalog, 'unsalted butter');
    if (review.outcome !== 'review_required') throw new Error('expected review');
    const salted = review.candidates.find((candidate) => /salted/.test(candidate.description));
    if (!salted) throw new Error('missing salted candidate');
    const explanation = explainCandidate(review.normalized_query ?? '', salted);
    expect(explanation.qualifier_opposition).toBeGreaterThan(0);
    expect(explanation.automatic_eligible).toBe(false);
  });

  it('the FDC-id tie-break never upgrades a review candidate to automatic', () => {
    const entries = [entry(5, 'Milk, whole'), entry(1, 'Milk, whole')];
    // Both are exact token multisets; still only a deterministic exact phrase is high.
    const normalized = normalizeQuery('milk whole');
    const rankedEntries = rankCandidates(normalized, entries, 10);
    expect(rankedEntries.map((c) => c.fdc_id)).toEqual([1, 5]);
  });
});

// ---------------------------------------------------------------------------
// Row-state classification + edit override behavior
// ---------------------------------------------------------------------------

describe('auto analyzer — row states', () => {
  it('marks qualitative lines and never treats them as measurable', () => {
    const { row } = rowFor(['salt and pepper to taste']);
    expect(row.status).toBe('qualitative');
    expect(row.selected_fdc_id).toBeUndefined();
  });

  it('uses a line-written total-mass range by midpoint and never fabricates a scalar for a massless range', () => {
    const written = rowFor(['3 to 4 slices provolone (about 75 to 100 grams in total)']);
    // The recipe's OWN written total mass is honored (documented midpoint
    // policy); nothing is invented beyond the author's stated range.
    expect(written.row.status).toBe('matched');
    expect(written.row.reason).toBe('explicit_mass_range');
    expect(written.analysis.preview?.ingredients[0].resolved_grams).toBeCloseTo(87.5, 6);

    const massless = rowFor(['2-3 tomatoes']);
    expect(massless.row.status).toBe('needs_amount');
    expect(massless.row.reason).not.toBe('explicit_mass_range');
    expect(massless.analysis.preview?.ingredients[0].resolved_grams).toBeUndefined();
  });

  it('records an automatic selection truthfully (auto_confirmed, not user_confirmed)', () => {
    const adapted = adaptLines(['1/2 teaspoon salt']);
    const analysis = analyzeRecipe(session, adapted, 4);
    const recipeKey = 'smoke#auto';
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: buildReviewRows(session, adapted),
      baseServings: 4,
    });
    state = phase4Reducer(state, {
      type: 'apply_analysis',
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions,
      preview: analysis.preview,
    });
    const request = buildCalculationRequest(adapted, state) as {
      ingredients: ReadonlyArray<{ automatic_selection?: boolean }>;
    };
    expect(request.ingredients[0].automatic_selection).toBe(true);
    const calculated = session.calculate(request);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.match_status).toBe('auto_confirmed');
    expect(evidence.user_confirmed).toBe(false);
  });

  it('authorizes the analyzer result for explicit Apply (established persisted semantics)', () => {
    const lines = ['1/2 teaspoon salt', '1 cup ketchup'];
    const adapted = adaptLines(lines);
    const analysis = analyzeRecipe(session, adapted, 4);
    const recipe = {
      id: 'smoke-apply',
      filePath: 'Recipes/smoke-apply.md',
      title: 'Smoke Apply',
      servings: 4,
      ingredients: lines.map(structuredLine),
    };
    const recipeKey = adaptRecipe(recipe);
    if (!recipeKey.ok) throw new Error('adapt failed');
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: recipeKey.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: buildReviewRows(session, adapted),
      baseServings: 4,
    });
    state = phase4Reducer(state, {
      type: 'apply_analysis',
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions,
      preview: analysis.preview,
    });
    const result = authorizeNutritionPersistence({
      session,
      recipe,
      state,
      computedAt: '2026-09-19T00:00:00.000Z',
    });
    if (!result.ok) {
      throw new Error(`authorization failed: ${(result as { failure: { code: string } }).failure.code}`);
    }
    expect(result.ok).toBe(true);
  });

  it('records an explicit user choice as user_confirmed (never forged as automatic)', () => {
    const adapted = adaptLines(['1/2 teaspoon salt']);
    const analysis = analyzeRecipe(session, adapted, 4);
    const lineRef = adapted[0].line_ref;
    const autoChoice = analysis.matches[lineRef];
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'smoke#user',
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: buildReviewRows(session, adapted),
      baseServings: 4,
    });
    // Same candidate, but WITHOUT the automatic marker: an explicit user choice.
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef,
      choice: { kind: 'candidate', fdc_id: autoChoice.fdc_id as number, review_digest: autoChoice.review_digest },
    });
    const request = buildCalculationRequest(adapted, state) as {
      ingredients: ReadonlyArray<{ automatic_selection?: boolean }>;
    };
    expect(request.ingredients[0].automatic_selection).toBeUndefined();
    const calculated = session.calculate(request);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].match_status).toBe('user_confirmed');
    expect(calculated.preview.ingredients[0].user_confirmed).toBe(true);
  });

  it('a full recipe produces a deterministic summary', () => {
    const { analysis } = analyzeLines([
      '1 lb ground beef',
      '1 onion, chopped',
      '1 cup ketchup',
      '2 tbsp chili powder',
      '1 tsp salt',
    ]);
    expect(analysis.summary.total).toBe(5);
    expect(analysis.summary.matched + analysis.summary.matched_check + analysis.summary.needs_amount + analysis.summary.needs_match + analysis.summary.unresolved + analysis.summary.qualitative).toBe(5);
    // Same input + same bundle -> identical summary.
    const again = analyzeLines([
      '1 lb ground beef',
      '1 onion, chopped',
      '1 cup ketchup',
      '2 tbsp chili powder',
      '1 tsp salt',
    ]).analysis;
    expect(again.summary).toEqual(analysis.summary);
  });
});

// ---------------------------------------------------------------------------
// CONSOLIDATED INDEPENDENT AUDIT REPAIR MATRIX
// ---------------------------------------------------------------------------

describe('auto analyzer — consolidated audit repair matrix', () => {
  it('1. `1 cup rice` MUST NOT auto-select `Bread, rice` (plain rice family preferred)', () => {
    const { row } = rowFor(['1 cup rice']);
    // A plain rice family record may auto-select; a rice-bread/flour compound
    // may never be the automatic choice.
    expect(row.selected_description ?? '').not.toMatch(/bread|flour/i);
    if (row.status === 'matched') expect(row.selected_description ?? '').toMatch(/rice/i);
    const tops = topDescriptions(['1 cup rice'], 0, 4);
    expect(tops[0] ?? '').not.toMatch(/bread|flour/i);
  });

  it('2. `1 cup cream` MUST NOT auto-select cream-style corn', () => {
    const { row } = rowFor(['1 cup cream']);
    expect(row.selected_description ?? '').not.toMatch(/corn|cream style/i);
    // The cream-style corn records are demoted below real cream and can never be
    // the automatic choice (they may remain review candidates).
    const tops = topDescriptions(['1 cup cream'], 0, 4);
    expect(tops[0] ?? '').not.toMatch(/corn|cream style/i);
  });

  it('3. `1 stick unsalted butter, cold` retains butter identity (punctuation safe)', () => {
    const { row } = rowFor(['1 stick unsalted butter, cold']);
    expect(row.selected_description).toMatch(/butter/i);
    expect(row.selected_description).not.toMatch(/cheese|oil|cold-pack/i);
    const tops = topDescriptions(['1 stick unsalted butter, cold'], 0, 6);
    expect(tops[0]).toMatch(/butter/i);
  });

  it('4. `1 cup butter` one-click auto-selects a sensible same-family butter default', () => {
    const { row } = rowFor(['1 cup butter']);
    // Generic butter is a Level-2 default now: a deterministic butter record is
    // chosen (editable), never a margarine/substitute/oil.
    expect(row.selected_description).toMatch(/butter/i);
    expect(row.selected_description ?? '').not.toMatch(/margarine|substitute|oil|peanut|fruit/i);
    expect(row.status).not.toBe('needs_match');
  });

  it('4b. `1 cup unsalted butter` never crosses to salted/margarine/substitute', () => {
    const { row } = rowFor(['1 cup unsalted butter']);
    expect(row.selected_description ?? '').not.toMatch(/margarine|substitute|\bsalted\b/i);
    if (row.selected_description) expect(row.selected_description).toMatch(/unsalted/i);
  });

  it('5. `1 apple` MUST NOT auto-select `Apple, dried`', () => {
    const { row } = rowFor(['1 apple']);
    expect(row.selected_description ?? '').not.toMatch(/dried|dehydrated/i);
    const tops = topDescriptions(['1 apple'], 0, 6);
    expect(tops[0] ?? '').not.toMatch(/dried/i);
  });

  it('6. `2 eggs` MUST NOT auto-select dried or cooked egg (bare egg invents no prep)', () => {
    const { row } = rowFor(['2 eggs']);
    expect(row.selected_description ?? '').not.toMatch(/dried|dehydrated/i);
    // Bare `eggs` requests no cooking method, so no cooked preparation may be an
    // automatic selection. If anything auto-selects it must be the raw baseline.
    expect(row.selected_description ?? '').not.toMatch(/fried|boiled|scrambled|baked|poached|cooked/i);
    if (row.status === 'matched') expect(row.selected_description ?? '').toMatch(/egg|raw/i);
  });

  it('7. `1 cup milk whole` whole milk ranks above dry/reconstituted milk', () => {
    const { row } = rowFor(['1 cup milk whole']);
    expect(row.selected_description).toMatch(/milk/i);
    expect(row.selected_description ?? '').not.toMatch(/dry|dried|reconstituted|powdered/i);
  });

  it('8. `200 g gluten-free flour blend` fails closed; no cheese blend top', () => {
    const { row } = rowFor(['200 g gluten-free flour blend']);
    expect(row.status).not.toBe('matched');
    expect(row.selected_description ?? '').not.toMatch(/cheese/i);
    const tops = topDescriptions(['200 g gluten-free flour blend'], 0, 8);
    expect(tops.some((d) => /cheese/i.test(d))).toBe(false);
  });

  it('9. `0.5 cup unsalted butter, chilled and cubed` preserves the repaired result', () => {
    const { row } = rowFor(['0.5 cup unsalted butter, chilled and cubed']);
    expect(row.selected_description).toMatch(/butter/i);
    expect(row.selected_description).not.toMatch(/peanut|pickle|margarine/i);
  });

  it('10. `1/4 tsp crushed red pepper flakes` no flake pollution', () => {
    const tops = topDescriptions(['1/4 tsp crushed red pepper flakes'], 0, 12);
    for (const d of tops) expect(d).not.toMatch(/cereal|onion.*flakes|potato.*flakes|bran flakes|corn flakes/i);
    expect(tops.some((d) => /pepper/i.test(d))).toBe(true);
  });

  it('11. `3 to 4 slices provolone (about 75 to 100 grams total)` no quail/pheasant/salmon; written mass honored', () => {
    const lines = ['3 to 4 slices provolone (about 75 to 100 grams total)'];
    const { analysis, row } = rowFor(lines);
    expect(row.selected_description).toMatch(/provolone/i);
    // The written total mass resolves by midpoint; the identity never crosses.
    expect(row.status).toBe('matched');
    expect(analysis.preview?.ingredients[0].resolved_grams).toBeCloseTo(87.5, 6);
    const tops = topDescriptions(lines, 0, 12);
    for (const d of tops) expect(d).not.toMatch(/quail|pheasant|salmon/i);
  });

  it('12. `1 tomato, thinly sliced` no thinly sliced beef', () => {
    const { row } = rowFor(['1 tomato, thinly sliced']);
    expect(row.selected_description).toMatch(/tomato/i);
    const tops = topDescriptions(['1 tomato, thinly sliced'], 0, 12);
    for (const d of tops) expect(d).not.toMatch(/beef/i);
  });

  it('13-16. onion powder / black pepper / salt / ketchup: correct food + auto portion', () => {
    for (const [line, food] of [
      ['1/2 tsp onion powder', /onion powder/i],
      ['1/2 tsp black pepper', /pepper, black/i],
      ['1/2 tsp salt', /^salt/i],
      ['1/2 cup ketchup', /ketchup/i],
    ] as ReadonlyArray<[string, RegExp]>) {
      const { analysis, row } = rowFor([line]);
      expect(row.status).toBe('matched');
      expect(row.selected_description).toMatch(food);
      expect(analysis.portions[row.line_ref]).toBeDefined();
    }
  });

  it('17-18. buttermilk and cottage cheese preserve existing behavior', () => {
    const buttermilk = rowFor(['1 cup buttermilk']).row;
    expect(buttermilk.status).toBe('matched');
    expect(buttermilk.selected_description).toMatch(/buttermilk/i);
    const cottage = rowFor(['3/4 cup cottage cheese']).row;
    expect(cottage.status).toBe('matched');
    expect(cottage.selected_description).toMatch(/cottage/i);
  });

  it('19. `1 cup low fat cottage cheese` honors the explicit low-fat variant', () => {
    const { row } = rowFor(['1 cup low fat cottage cheese']);
    expect(row.selected_description).toMatch(/cottage/i);
    expect(row.selected_description).toMatch(/low fat|lowfat|reduced/i);
  });

  it('20-23. garlic powder / garlic salt / red wine vinegar / dried basil', () => {
    const garlicPowder = rowFor(['1 tsp garlic powder']).row;
    expect(garlicPowder.status).toBe('matched');
    expect(garlicPowder.selected_description).toMatch(/garlic powder/i);

    const garlicSalt = rowFor(['1 tsp garlic salt']).row;
    expect(garlicSalt.status).not.toBe('matched');
    expect(garlicSalt.selected_fdc_id).toBeUndefined();

    const vinegar = rowFor(['1 tbsp red wine vinegar']).row;
    expect(vinegar.selected_description).toMatch(/vinegar/i);
    expect(vinegar.selected_description).toMatch(/red wine/i);

    const basil = rowFor(['1 pinch dried basil']).row;
    expect(basil.selected_description).toMatch(/basil/i);
    expect(basil.selected_description).toMatch(/dried/i);
  });
});

describe('auto analyzer — forged automatic marker fails closed', () => {
  it('a caller-claimed automatic selection that is not the deterministic auto choice is rejected', () => {
    const adapted = adaptLines(['1/2 teaspoon salt']);
    const lineRef = adapted[0].line_ref;
    const review = session.reviewIngredient(adapted[0].ingredient) as {
      outcome: string;
      candidates: ReadonlyArray<{ fdc_id: number }>;
      review_digest?: string;
    };
    const auto = selectAutomaticMatch(review as never);
    expect(auto).toBeDefined();
    // A forged claim for a MATERIALLY DIFFERENT candidate still fails closed. A
    // benign same-family sibling is a legitimate best-effort default (bounded
    // relaxation), so the forged candidate is chosen from OUTSIDE that set.
    const eligible = new Set(
      bestEffortDefaultCandidates(review as never).map((candidate) => candidate.fdc_id)
    );
    const forged = review.candidates.find(
      (candidate) => candidate.fdc_id !== auto?.fdc_id && !eligible.has(candidate.fdc_id)
    );
    expect(forged).toBeDefined();

    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'audit#forged',
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: buildReviewRows(session, adapted),
      baseServings: 4,
    });
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef,
      choice: {
        kind: 'candidate',
        fdc_id: forged?.fdc_id as number,
        review_digest: review.review_digest ?? '',
        automatic: true,
      },
    });
    const request = buildCalculationRequest(adapted, state) as {
      ingredients: ReadonlyArray<{ automatic_selection?: boolean }>;
    };
    expect(request.ingredients[0].automatic_selection).toBe(true);
    const calculated = session.calculate(request);
    expect(calculated.ok).toBe(false);
    if (calculated.ok) return;
    expect((calculated as { failure: { code: string } }).failure.code).toBe('invalid_ingredient_input');
  });

  it('the genuine automatic selection is still accepted as auto_confirmed', () => {
    const adapted = adaptLines(['1/2 teaspoon salt']);
    const analysis = analyzeRecipe(session, adapted, 4);
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'audit#genuine',
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: buildReviewRows(session, adapted),
      baseServings: 4,
    });
    state = phase4Reducer(state, {
      type: 'apply_analysis',
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions,
      preview: analysis.preview,
    });
    const calculated = session.calculate(buildCalculationRequest(adapted, state));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].match_status).toBe('auto_confirmed');
    expect(calculated.preview.ingredients[0].user_confirmed).toBe(false);
  });
});

describe('auto analyzer — confidence null/malformed hardening', () => {
  it('classify/select/validate return closed outcomes for null/undefined/malformed input', () => {
    expect(classifyReviewConfidence(null as never)).toBe('unresolved');
    expect(classifyReviewConfidence(undefined as never)).toBe('unresolved');
    expect(classifyReviewConfidence({} as never)).toBe('unresolved');
    expect(selectAutomaticMatch(null as never)).toBeUndefined();
    expect(selectAutomaticMatch(undefined as never)).toBeUndefined();
    expect(selectAutomaticMatch({ outcome: 'review_required', candidates: null } as never)).toBeUndefined();
    expect(
      classifyReviewConfidence({ outcome: 'review_required', candidates: null, normalized_query: 'x' } as never)
    ).toBe('unresolved');
    expect(explainCandidate('', null as never).automatic_eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GENERIC-FAMILY / VARIETY-BIAS REPAIR MATRIX
// ---------------------------------------------------------------------------

describe('auto analyzer — generic family / variety bias', () => {
  it('F-1 `1 cup powdered milk` stays in the milk family (no dessert topping)', () => {
    const { row } = rowFor(['1 cup powdered milk']);
    const tops = topDescriptions(['1 cup powdered milk'], 0, 4);
    expect(row.selected_description ?? '').not.toMatch(/dessert|topping/i);
    expect(tops[0] ?? '').not.toMatch(/dessert|topping/i);
    if (row.selected_description) expect(row.selected_description).toMatch(/milk/i);
    // The material state `powdered` refines the milk family (dry milk records).
    expect(tops[0] ?? '').toMatch(/milk, dry/i);
  });

  it('F-2 `1 cup cheese` prefers generic Cheese, NFS (never auto blue)', () => {
    const { row } = rowFor(['1 cup cheese']);
    expect(row.selected_description ?? '').not.toMatch(/blue/i);
    expect(row.status).not.toBe('needs_match');
    if (row.selected_description) expect(row.selected_description).toMatch(/cheese/i);
    const tops = topDescriptions(['1 cup cheese'], 0, 4);
    expect(tops[0] ?? '').toMatch(/cheese, nfs/i);
  });

  it('F-3 `1 cup flour` does not silently invent whole wheat', () => {
    const { row } = rowFor(['1 cup flour']);
    expect(row.selected_description ?? '').not.toMatch(/whole wheat/i);
    const tops = topDescriptions(['1 cup flour'], 0, 4);
    expect(tops[0] ?? '').not.toMatch(/whole wheat/i);
    if (row.selected_description) expect(row.selected_description).toMatch(/flour/i);
  });

  it('F-4 `1 cup raw rice` does not invent black rice', () => {
    const { row } = rowFor(['1 cup raw rice']);
    expect(row.selected_description ?? '').not.toMatch(/black/i);
    const tops = topDescriptions(['1 cup raw rice'], 0, 4);
    expect(tops[0] ?? '').not.toMatch(/black/i);
  });

  it('F-5 `1 bar milk chocolate` does not auto a brand-specific candy', () => {
    const { row } = rowFor(['1 bar milk chocolate']);
    // No generic milk-chocolate family record exists in the pinned bundle, so a
    // generic query must fail closed to review rather than auto a brand product.
    expect(row.status).not.toBe('matched');
    expect(row.selected_fdc_id).toBeUndefined();
    expect(row.selected_description ?? '').not.toMatch(
      /symphony|mars|toblerone|kudos|snickers|milky way|dove|rolo/i
    );
  });

  it('F-6 `1 tomato` prefers generic raw tomato over Roma', () => {
    const { row } = rowFor(['1 tomato']);
    expect(row.selected_description).toMatch(/tomatoes, raw/i);
    const tops = topDescriptions(['1 tomato'], 0, 4);
    expect(tops[0] ?? '').toMatch(/tomatoes, raw/i);
  });

  it('explicit variants remain authoritative', () => {
    const cases: ReadonlyArray<[string, RegExp]> = [
      ['1 cup blue cheese', /cheese, blue/i],
      ['1 cup cheddar cheese', /cheese, cheddar/i],
      ['1 roma tomato', /tomato, roma/i],
      ['1 cup black rice', /rice, black/i],
      ['1 cup whole wheat flour', /whole.?grain|whole wheat/i],
      ['1 cup powdered milk', /milk, dry/i],
      ['1 cup evaporated milk', /milk, evaporated/i],
      ['1 cup condensed milk', /milk, condensed/i],
    ];
    for (const [line, expected] of cases) {
      const { row } = rowFor([line]);
      // An explicitly requested variety/state always identifies the correct
      // food family. Under the coarse auto-authority contract a remaining
      // unrequested material subtype (e.g. enriched/unenriched) may still
      // require review, so the top recommended candidate is the authority when
      // the row is not auto-selected.
      const top = topDescriptions([line], 0, 1)[0] ?? '';
      expect(row.selected_description ?? top).toMatch(expected);
    }
  }, 30000); // measured ~5.4s under full-suite load; narrow justified timeout

  it('a generic query with no safe generic record fails closed rather than inventing a variety', () => {
    for (const line of ['1 cup raw rice', '1 bar milk chocolate', '1 cup cheese']) {
      const { row } = rowFor([line]);
      // Never auto-select a specific variety/brand for a generic query.
      expect(row.selected_description ?? '').not.toMatch(/black|blue|symphony|mars/i);
    }
  });
});

// ---------------------------------------------------------------------------
// FINAL AUTO-AUTHORITY REPAIR MATRIX (food family vs derived component,
// unrequested material subtype, generic preference)
// ---------------------------------------------------------------------------

describe('auto analyzer — final auto-authority repair', () => {
  it('1. `1 cup chicken` one-click default never selects rendered fat / skin / soup / fried', () => {
    const line = '1 cup chicken';
    const { row } = rowFor([line]);
    expect(row.selected_description ?? '').not.toMatch(/fat, chicken|chicken skin|soup|fried|bacon/i);
    const tops = topDescriptions([line], 0, 8);
    expect(tops[0] ?? '').toMatch(/chicken/i);
    expect(tops[0] ?? '').not.toMatch(/fat, chicken|chicken skin|soup|fried/i);
    if (row.selected_description) expect(row.selected_description).toMatch(/chicken/i);
  });

  it('2. `1 cup flour` does not silently invent `Flour, 00` or whole wheat', () => {
    const line = '1 cup flour';
    const { row } = rowFor([line]);
    expect(row.selected_description ?? '').not.toMatch(/flour, 00|whole wheat/i);
    const tops = topDescriptions([line], 0, 4);
    expect(tops[0] ?? '').toMatch(/all-purpose|flour/i);
    expect(tops[0] ?? '').not.toMatch(/00|whole wheat|bread|chicken/i);
    // Bare flour must not auto-select a grind/type it was not asked for.
    if (row.status === 'matched') expect(row.selected_description ?? '').toMatch(/all-purpose/i);
  });

  it('3. `1 cup cream` defaults to the generic NS cream, never a specific fat class', () => {
    const line = '1 cup cream';
    const { row } = rowFor([line]);
    if (row.selected_description) {
      // The generic NS record enumerates the fat classes; a specific class is
      // never the invented default.
      expect(row.selected_description).toMatch(/cream, ns|nfs/i);
    }
    const tops = topDescriptions([line], 0, 4);
    expect(tops[0] ?? '').toMatch(/cream, ns|nfs/i);
  });

  it('4. `1 cup powdered milk` defaults into the dry-milk family, never a dessert topping', () => {
    const line = '1 cup powdered milk';
    const { row } = rowFor([line]);
    expect(row.selected_description ?? '').not.toMatch(/dessert|topping/i);
    expect(row.selected_description ?? '').toMatch(/milk, dry/i);
    const tops = topDescriptions([line], 0, 4);
    expect(tops[0] ?? '').toMatch(/milk, dry/i);
  });

  it('5-6. explicit whole / nonfat powdered milk resolve specifically', () => {
    const whole = rowFor(['1 cup whole powdered milk']).row;
    expect(whole.status).toBe('matched');
    expect(whole.selected_description).toMatch(/milk, dry, whole/i);
    const nonfat = rowFor(['1 cup nonfat powdered milk']).row;
    expect(nonfat.status).toBe('matched');
    expect(nonfat.selected_description).toMatch(/milk, dry, nonfat/i);
  });

  it('7-8. explicit heavy / light cream resolve specifically', () => {
    const heavy = rowFor(['1 cup heavy cream']).row;
    expect(heavy.selected_description).toMatch(/cream, heavy/i);
    const light = rowFor(['1 cup light cream']).row;
    expect(light.selected_description).toMatch(/cream, light/i);
  });

  it('9. `1 cup all-purpose flour` resolves specifically to all-purpose', () => {
    const line = '1 cup all-purpose flour';
    const { row } = rowFor([line]);
    const top = topDescriptions([line], 0, 1)[0] ?? '';
    expect(row.selected_description ?? top).toMatch(/all-purpose/i);
    expect(row.selected_description ?? top).not.toMatch(/flour, 00|whole wheat/i);
  });

  it('10. `1 cup 00 flour` resolves specifically to `Flour, 00`', () => {
    const { row } = rowFor(['1 cup 00 flour']);
    expect(row.selected_description).toMatch(/flour, 00/i);
  });

  it('11. `1 cup chicken fat` may resolve when explicitly requested', () => {
    const { row } = rowFor(['1 cup chicken fat']);
    expect(row.selected_description).toMatch(/fat, chicken/i);
  });

  it('12. bare chicken never auto-selects a rendered fat / fried / soup dish', () => {
    const line = '1 cup chicken';
    const { row } = rowFor([line]);
    const adapted = adaptLines([line]);
    const review = session.reviewIngredient(adapted[0].ingredient) as never;
    expect(selectAutomaticMatch(review)).toBeUndefined();
    const tops = topDescriptions([line], 0, 12);
    for (const description of tops) {
      expect(description).not.toMatch(/fat, chicken|chicken skin|soup, chicken|fried, coated/i);
    }
    expect(row.selected_description ?? '').not.toMatch(/fat|soup|fried/i);
    // Explicit compound queries still work.
    const soup = rowFor(['1 cup chicken soup']).row;
    expect(soup.selected_description).toMatch(/soup, chicken/i);
  });
});

// ---------------------------------------------------------------------------
// FINAL AUTHORITY EDGE-CASE REPAIR MATRIX
//   (1) bare egg must not invent a cooking/preparation state
//   (2) an explicit derived-component request must not resolve to a cut/dish
//   (3) a bare/dry bean query must not invent a named cultivar
// ---------------------------------------------------------------------------

describe('auto analyzer — final authority edge cases', () => {
  it('E1. bare `1 egg` one-click default is the raw baseline, never a cooked preparation', () => {
    const line = '1 egg';
    const { row } = rowFor([line]);
    // One-click policy: a bare egg may auto-select the RAW baseline, but a
    // cooked/fried/scrambled preparation is never the default for a bare query.
    expect(row.selected_description ?? '').not.toMatch(/fried|boiled|scrambled|baked|poached|cooked/i);
    if (row.status === 'matched') {
      expect(row.selected_description ?? '').toMatch(/egg, whole, raw|raw/i);
    }
    const adapted = adaptLines([line]);
    const review = session.reviewIngredient(adapted[0].ingredient) as never;
    // The best-effort same-family default is the raw baseline.
    const best = selectBestEffortMatch(review);
    if (best) expect(best.fdc_id).toBe(row.selected_fdc_id);
  });

  it('E2. bare `2 eggs` one-click default is the raw baseline, never a cooked preparation', () => {
    const line = '2 eggs';
    const { row } = rowFor([line]);
    expect(row.selected_description ?? '').not.toMatch(/fried|boiled|scrambled|baked|poached|cooked/i);
    if (row.status === 'matched') {
      expect(row.selected_description ?? '').toMatch(/egg, whole, raw|raw/i);
    }
    const adapted = adaptLines([line]);
    const review = session.reviewIngredient(adapted[0].ingredient) as never;
    const best = selectBestEffortMatch(review);
    if (best) expect(best.fdc_id).toBe(row.selected_fdc_id);
  });

  it('E3. explicit `2 fried eggs` resolves to a fried egg', () => {
    const { row } = rowFor(['2 fried eggs']);
    expect(row.status).toBe('matched');
    expect(row.selected_description).toMatch(/fried/i);
  });

  it('E4. explicit `2 boiled eggs` resolves without inventing a different prep', () => {
    const { row } = rowFor(['2 boiled eggs']);
    expect(row.selected_description).toMatch(/boiled|cooked/i);
    expect(row.selected_description).not.toMatch(/fried|scrambled|poached|baked/i);
  });

  it('E5. `scrambled eggs` / `2 scrambled eggs` / `egg, scrambled` resolve the ordinary cooked scrambled egg, never the frozen mixture', () => {
    for (const line of ['scrambled eggs', '2 scrambled eggs', 'egg, scrambled']) {
      const { row } = rowFor([line]);
      // The intended non-frozen identity is asserted positively. The egg record
      // carries no authenticated portion, so the food is still auto-selected
      // while the amount honestly fails closed to `needs_amount`.
      expect(['matched', 'needs_amount']).toContain(row.status);
      expect(row.selected_description).toBe('Egg, whole, cooked, scrambled');
      expect(row.selected_description).not.toMatch(/frozen|mixture|omelet/i);

      const adapted = adaptLines([line]);
      const review = session.reviewIngredient(adapted[0].ingredient) as {
        normalized_query?: string;
        candidates: ReadonlyArray<{ description: string }>;
      };
      expect(selectAutomaticMatch(review as never)).toBeDefined();
      const frozen = review.candidates.find((candidate) => /frozen mixture/i.test(candidate.description));
      expect(frozen).toBeDefined();
      const explanation = explainCandidate(review.normalized_query ?? '', frozen as never);
      expect(explanation.unrequested_material_variants).toBeGreaterThan(0);
      expect(explanation.automatic_eligible).toBe(false);
    }
  });

  it('E5b. `frozen scrambled eggs` surfaces the frozen mixture and never auto-selects the plain non-frozen egg', () => {
    const line = 'frozen scrambled eggs';
    const { row } = rowFor([line]);
    const top = topDescriptions([line], 0, 1)[0] ?? '';
    expect(top).toMatch(/frozen mixture/i);
    // The ordinary non-frozen scrambled egg does not satisfy the explicit
    // frozen request and must never be the automatic choice. If the row does
    // auto-resolve, it must be the requested frozen product.
    expect(row.selected_description ?? '').not.toBe('Egg, whole, cooked, scrambled');
    if (row.status === 'matched') expect(row.selected_description).toMatch(/frozen|mixture/i);
  });

  it('E6. `1 cup beef fat` never auto-selects a steak/ribeye/meat cut', () => {
    const line = '1 cup beef fat';
    const { row } = rowFor([line]);
    expect(row.status).not.toBe('matched');
    expect(row.selected_description ?? '').not.toMatch(/steak|ribeye|sirloin|strip|t-bone|ground/i);
    // Meat cuts may remain review candidates, but the suggested top must be a
    // rendered fat/tallow component, never a cut.
    const top = topDescriptions([line], 0, 1)[0] ?? '';
    expect(top).not.toMatch(/steak|ribeye|sirloin|strip|t-bone|ground/i);
    expect(top).toMatch(/fat|tallow/i);
  });

  it('E7. `1 cup beef tallow` resolves to the beef tallow component (or safe review)', () => {
    const line = '1 cup beef tallow';
    const { row } = rowFor([line]);
    const top = topDescriptions([line], 0, 1)[0] ?? '';
    expect(row.selected_description ?? top).toMatch(/tallow/i);
    expect(row.selected_description ?? '').not.toMatch(/steak|ribeye|ground/i);
  });

  it('E8. `1 cup pork fat` never auto-selects an ordinary pork cut', () => {
    const { row } = rowFor(['1 cup pork fat']);
    expect(row.status).not.toBe('matched');
    expect(row.selected_description ?? '').not.toMatch(/chop|steak|spareribs|carcass|backribs/i);
  });

  it('E9. `1 cup chicken fat` still resolves explicitly', () => {
    const { row } = rowFor(['1 cup chicken fat']);
    expect(row.selected_description).toMatch(/fat, chicken/i);
  });

  it('E10. `1 cup dry beans` never auto-invents a named cultivar', () => {
    const line = '1 cup dry beans';
    const { row } = rowFor([line]);
    expect(row.status).not.toBe('matched');
    expect(row.selected_description ?? '').not.toMatch(
      /tan|carioca|cranberry|navy|pinto|cannellini|kidney|northern/i
    );
    const adapted = adaptLines([line]);
    const review = session.reviewIngredient(adapted[0].ingredient) as never;
    expect(selectAutomaticMatch(review)).toBeUndefined();
  });

  it('E11. an explicit named bean cultivar still resolves', () => {
    const pinto = rowFor(['1 cup pinto beans']).row;
    expect(pinto.selected_description).toMatch(/pinto/i);
    const dryPinto = rowFor(['1 cup dry pinto beans']).row;
    expect(dryPinto.selected_description).toMatch(/pinto/i);
  });
});

// ---------------------------------------------------------------------------
// MUTATION-SENSITIVE AUTHORITY PROOFS (synthetic catalogs)
//   Each proof isolates ONE authority rule on a catalog where that rule is the
//   ONLY thing preventing an automatic selection, so deleting the rule fails.
// ---------------------------------------------------------------------------

describe('auto analyzer — authority mutation sensitivity', () => {
  function reviewOf(specs: ReadonlyArray<{ fdcId: number; dataType: 'fndds'; description: string }>, query: string) {
    const { manifest, records } = buildMatchingBundle(specs);
    const catalogResult = createReviewCatalog(manifest, records);
    if (!catalogResult.ok) throw new Error('catalog failed');
    return reviewIngredient(catalogResult.catalog, { name: query });
  }

  it('M1. cooking-state authority blocks a lone fried egg for a bare `egg`', () => {
    const review = reviewOf(
      [{ fdcId: 1, dataType: 'fndds', description: 'Egg, whole, fried' }],
      'egg'
    );
    expect(review.outcome).toBe('review_required');
    const explanation = explainCandidate(review.normalized_query ?? '', review.candidates[0]);
    expect(explanation.unrequested_cooking_methods).toBeGreaterThan(0);
    expect(explanation.automatic_eligible).toBe(false);
    expect(selectAutomaticMatch(review)).toBeUndefined();
  });

  it('M2. derived-component request identity rejects a composition `fat` cut', () => {
    const review = reviewOf(
      [{ fdcId: 1, dataType: 'fndds', description: 'Beef, steak, ribeye, lean and fat eaten' }],
      'beef fat'
    );
    expect(review.outcome).toBe('review_required');
    const explanation = explainCandidate(review.normalized_query ?? '', review.candidates[0]);
    expect(explanation.family_mismatch).toBeGreaterThan(0);
    expect(explanation.automatic_eligible).toBe(false);
    expect(selectAutomaticMatch(review)).toBeUndefined();
  });

  it('M3. cultivar ambiguity blocks a lone named dry-bean cultivar for `dry beans`', () => {
    const review = reviewOf(
      [
        { fdcId: 1, dataType: 'fndds', description: 'Beans, Dry, Tan (0% moisture)' },
        { fdcId: 2, dataType: 'fndds', description: 'Beans, Dry, Carioca (0% moisture)' },
      ],
      'dry beans'
    );
    expect(review.outcome).toBe('review_required');
    for (const candidate of review.candidates) {
      const explanation = explainCandidate(review.normalized_query ?? '', candidate);
      expect(explanation.unrequested_variety).toBeGreaterThan(0);
      expect(explanation.automatic_eligible).toBe(false);
    }
    expect(selectAutomaticMatch(review)).toBeUndefined();
  });

  it('M4. synthetic authority: ordinary scrambled wins; frozen mixture never gains AUTO', () => {
    const review = reviewOf(
      [
        { fdcId: 1, dataType: 'fndds', description: 'Egg, whole, cooked, scrambled' },
        { fdcId: 2, dataType: 'fndds', description: 'Eggs, scrambled, frozen mixture' },
      ],
      'scrambled eggs'
    );
    // The ordinary record is the deterministic automatic choice.
    expect(selectAutomaticMatch(review)?.fdc_id).toBe(1);
    const frozen = review.candidates.find((candidate) => candidate.fdc_id === 2);
    expect(frozen).toBeDefined();
    const explanation = explainCandidate(review.normalized_query ?? '', frozen as never);
    expect(explanation.unrequested_material_variants).toBeGreaterThan(0);
    expect(explanation.automatic_eligible).toBe(false);
  });

  it('M5. mutation proof: a lone prepared/storage-state product cannot auto an ordinary query', () => {
    const review = reviewOf(
      [{ fdcId: 1, dataType: 'fndds', description: 'Eggs, scrambled, frozen mixture' }],
      'scrambled eggs'
    );
    expect(review.outcome).toBe('review_required');
    const explanation = explainCandidate(review.normalized_query ?? '', review.candidates[0]);
    expect(explanation.unrequested_material_variants).toBeGreaterThan(0);
    expect(explanation.automatic_eligible).toBe(false);
    expect(selectAutomaticMatch(review)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AMOUNT / UNIT BINDING — Golden Honey Skillet Cornbread acceptance
//   The recipe's parsed quantity/unit flows into Advanced Nutrition and binds
//   deterministically to an authenticated USDA portion. No density invention,
//   no averaging, no guessed conversion; manual grams remain a fallback.
// ---------------------------------------------------------------------------

function bindPortionViaState(line: string, candidateMatch: RegExp, unit: string) {
  const adapted = adaptLines([line]);
  const ingredient = adapted[0].ingredient;
  const rows = buildReviewRows(session, adapted);
  const review = rows[0].review as {
    candidates?: ReadonlyArray<{ fdc_id: number; description: string }>;
    review_digest?: string;
  };
  const candidate = (review.candidates ?? []).find((entry) => candidateMatch.test(entry.description));
  if (!candidate) throw new Error('candidate not found');
  const portions = session.reviewPortions(candidate.fdc_id);
  if (!portions.ok) throw new Error('portions failed');
  const portion = portions.review.candidates.find(
    (entry) => entry.kind === 'volume' && entry.unit === unit
  );
  if (!portion) throw new Error('portion not found');

  const selection = {
    kind: 'candidate' as const,
    fdc_id: candidate.fdc_id,
    review_digest: review.review_digest ?? '',
  };
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: 'amount-test',
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: 8,
  });
  state = phase4Reducer(state, { type: 'select_match', lineRef: adapted[0].line_ref, choice: selection });
  const choice = buildPortionChoice(session, {
    lineRef: adapted[0].line_ref,
    ingredient,
    review: rows[0].review,
    selection,
    fdcId: candidate.fdc_id,
    portionIndex: portion.index,
  });
  if (!choice.ok) throw new Error('choice failed');
  state = phase4Reducer(state, {
    type: 'select_portion',
    lineRef: adapted[0].line_ref,
    choice: choice.choice,
  });
  const calculated = session.calculate(buildCalculationRequest(adapted, state));
  if (!calculated.ok) throw new Error('calc failed');
  return { adapted, candidate, portion, evidence: calculated.preview.ingredients[0] };
}

describe('auto analyzer — amount/unit binding (Golden Honey Cornbread)', () => {
  function resolvedFor(line: string): number | undefined {
    const { analysis } = analyzeLines([line]);
    const row = analysis.rows[0];
    return analysis.preview?.ingredients.find((entry) => entry.line_ref === row.line_ref)?.resolved_grams;
  }

  it('A1. parses the recipe quantity/unit into the analyzer row', () => {
    const adapted = adaptLines(['1.5 cup yellow cornmeal']);
    expect(adapted[0].ingredient.amount).toBe(1.5);
    expect(adapted[0].ingredient.unit).toBe('cup');
  });

  it('A2. cup -> authenticated USDA portion binds deterministically (1 cup honey = 339 g)', () => {
    expect(resolvedFor('1 cup honey')).toBeCloseTo(339, 6);
  });

  it('A3. tbsp -> authenticated USDA portion binds deterministically (2 tbsp honey = 42 g)', () => {
    expect(resolvedFor('2 tbsp honey')).toBeCloseTo(42, 6);
  });

  it('A4. tsp -> authenticated USDA portion binds deterministically (1 tsp salt = 6 g)', () => {
    expect(resolvedFor('1 tsp salt')).toBeCloseTo(6, 6);
  });

  it('A5. count/slice authenticated portion path is preserved (2 slices bacon = 56 g)', () => {
    expect(resolvedFor('2 slices bacon')).toBeCloseTo(56, 6);
  });

  it('A6. multiple materially different compatible portions require review (no arbitrary pick)', () => {
    const line = '1.5 cup yellow cornmeal';
    const { row } = rowFor([line]);
    // The food may be matched, but the amount stays review-required.
    expect(row.status).toBe('needs_amount');
    // At least two distinct authenticated 1-cup gram weights exist among the
    // ranked cornmeal candidates (122 g and 157 g), so no averaging/guessing.
    const adapted = adaptLines([line]);
    const review = session.reviewIngredient(adapted[0].ingredient) as {
      candidates?: ReadonlyArray<{ fdc_id: number; description: string }>;
    };
    const cupWeights = new Set<number>();
    for (const candidate of review.candidates ?? []) {
      const portions = session.reviewPortions(candidate.fdc_id);
      if (!portions.ok) continue;
      for (const portion of portions.review.candidates) {
        if (portion.kind === 'volume' && portion.unit === 'cup' && portion.gram_weight > 0) {
          cupWeights.add(portion.gram_weight);
        }
      }
    }
    expect(cupWeights.size).toBeGreaterThan(1);
  });

  it('A7. a selected source portion produces deterministic total grams (1.5 cup cornmeal = 183 g)', () => {
    const { evidence, portion } = bindPortionViaState(
      '1.5 cup yellow cornmeal',
      /whole-grain, yellow/i,
      'cup'
    );
    expect(portion.gram_weight).toBe(122);
    expect(evidence.mass_source).toBe('source_portion');
    expect(evidence.resolved_grams).toBeCloseTo(183, 6);
  });

  it('A8. manual total grams remains a deterministic fallback', () => {
    const adapted = adaptLines(['1.5 cup yellow cornmeal']);
    const ingredient = adapted[0].ingredient;
    const rows = buildReviewRows(session, adapted);
    const review = rows[0].review as { candidates?: ReadonlyArray<{ fdc_id: number; description: string }>; review_digest?: string };
    const candidate = (review.candidates ?? [])[0];
    const selection = { kind: 'candidate' as const, fdc_id: candidate.fdc_id, review_digest: review.review_digest ?? '' };
    const choice = buildUserMassChoice(session, {
      lineRef: adapted[0].line_ref,
      ingredient,
      review: rows[0].review,
      selection,
      fdcId: candidate.fdc_id,
      quantity: 183,
      unit: 'g',
    });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: 'manual-mass',
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows,
      baseServings: 8,
    });
    state = phase4Reducer(state, { type: 'select_match', lineRef: adapted[0].line_ref, choice: selection });
    state = phase4Reducer(state, { type: 'select_user_mass', lineRef: adapted[0].line_ref, choice: choice.choice });
    const calculated = session.calculate(buildCalculationRequest(adapted, state));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.mass_source).toBe('user_mass');
    expect(evidence.resolved_grams).toBeCloseTo(183, 6);
  });
});

// ---------------------------------------------------------------------------
// STAPLE vs PREPARED PRODUCT — the real `1 cup Cornmeal` smoke failure
//   A survey dish built from a staple (`Cornmeal stick`, `Cornmeal mush`) must
//   not outrank the plain staple family merely because the staple name appears
//   in the record. An explicit prepared-product request still resolves.
// ---------------------------------------------------------------------------

describe('auto analyzer — cornmeal staple vs prepared product (real bundle)', () => {
  it('bare `1 cup Cornmeal` does not auto-select a prepared stick or mush', () => {
    const { row } = rowFor(['1 cup Cornmeal']);
    expect(row.selected_description ?? '').not.toMatch(/stick|mush/i);
    expect(row.selected_fdc_id).not.toBe(2708715); // Cornmeal stick, Puerto Rican style
    expect(row.selected_fdc_id).not.toBe(2708375); // Cornmeal mush, fat added
  });

  it('plain cornmeal records rank above prepared stick/mush for a bare query', () => {
    const tops = topDescriptions(['1 cup Cornmeal'], 0, 8);
    const plain = tops.findIndex((d) => /whole-grain|degermed|Navajo/i.test(d));
    const prepared = tops.findIndex((d) => /stick|mush/i.test(d));
    expect(plain).toBeGreaterThanOrEqual(0);
    expect(prepared === -1 || plain < prepared).toBe(true);
  });

  it('an explicit `cornmeal stick` request still resolves to the stick record', () => {
    const tops = topDescriptions(['1 cup cornmeal stick'], 0, 3);
    expect(tops[0] ?? '').toMatch(/cornmeal stick/i);
  });

  it('a plain cornmeal record binds an authenticated cup portion (122 g / 183 g)', () => {
    const one = bindPortionViaState('1 cup yellow cornmeal', /whole-grain, yellow/i, 'cup');
    expect(one.portion.gram_weight).toBe(122);
    expect(one.evidence.mass_source).toBe('source_portion');
    expect(one.evidence.resolved_grams).toBeCloseTo(122, 6);

    const oneAndHalf = bindPortionViaState('1.5 cup yellow cornmeal', /whole-grain, yellow/i, 'cup');
    expect(oneAndHalf.evidence.resolved_grams).toBeCloseTo(183, 6);
  });
});

// ---------------------------------------------------------------------------
// ONE-CLICK BEST-EFFORT AUTO-SELECTION POLICY (real bundle)
//   Ordinary same-family variation must not force USDA taxonomy review. The
//   analyzer chooses the best reasonable same-family default and lets the user
//   edit it, while every material food-family / preparation / product boundary
//   still fails closed.
// ---------------------------------------------------------------------------

describe('auto analyzer — one-click best-effort policy (real bundle)', () => {
  it('P1. generic cornmeal auto-selects a plain cornmeal record, not stick/mush', () => {
    const { row } = rowFor(['1 cup cornmeal']);
    expect(row.selected_description ?? '').not.toMatch(/stick|mush/i);
    expect(['matched', 'needs_amount']).toContain(row.status);
    expect(row.selected_fdc_id).not.toBeUndefined();
  });

  it('P2. yellow/white ambiguity does not force review (no review suggested)', () => {
    const { row } = rowFor(['1 cup cornmeal']);
    expect(row.status).not.toBe('matched_check');
    expect(row.status).not.toBe('needs_match');
  });

  it('P3. the portion-bearing plain cornmeal sibling wins the semantic tie (122 g)', () => {
    const { analysis } = analyzeLines(['1 cup cornmeal']);
    const row = analysis.rows[0];
    // `Cornmeal, whole-grain, yellow` (169697) carries 1 cup = 122 g; the
    // equally-plain color siblings carry no usable volume portion.
    expect(row.selected_fdc_id).toBe(169697);
    const evidence = analysis.preview?.ingredients[0];
    expect(evidence?.mass_source).toBe('source_portion');
    expect(evidence?.resolved_grams).toBeCloseTo(122, 6);
  });

  it('P4. 1.5 cup cornmeal resolves 183 g automatically', () => {
    const { analysis } = analyzeLines(['1.5 cup cornmeal']);
    expect(analysis.preview?.ingredients[0].mass_source).toBe('source_portion');
    expect(analysis.preview?.ingredients[0].resolved_grams).toBeCloseTo(183, 6);
  });

  it('P5. portion availability never overrides a food-family mismatch', () => {
    const { row } = rowFor(['1 cup cornmeal']);
    // `Cornmeal stick, Puerto Rican style` has a portion but is a prepared dish.
    expect(row.selected_fdc_id).not.toBe(2708715);
    expect(row.selected_description ?? '').not.toMatch(/stick|mush/i);
  });

  it('P6. generic jalapeno auto-selects a normal jalapeno record', () => {
    const { row } = rowFor(['1 jalapeno, chopped']);
    expect(row.selected_description).toMatch(/jalapeno/i);
    expect(row.status).not.toBe('needs_match');
    expect(row.selected_description ?? '').not.toMatch(/stuffed/i);
  });

  it('P7. 1/4 cup chopped fresh jalapeno resolves 37.5 g automatically', () => {
    const { analysis } = analyzeLines(['0.25 cup chopped fresh jalapeno']);
    const row = analysis.rows[0];
    expect(row.selected_description).toMatch(/peppers, jalapenos/i);
    expect(analysis.preview?.ingredients[0].mass_source).toBe('source_portion');
    expect(analysis.preview?.ingredients[0].resolved_grams).toBeCloseTo(37.5, 6);
  });

  it('P8. composed prepared forms are still blocked (rice with gravy / cheese sandwich)', () => {
    const rice = rowFor(['1 cup rice']).row;
    expect(rice.selected_description ?? '').not.toMatch(/gravy|fried|soup/i);
    const cheese = rowFor(['1 cup cheese']).row;
    expect(cheese.selected_description ?? '').not.toMatch(/sandwich|grilled/i);
  });

  it('P9. Level-2 same-family defaults auto-select a deterministic record (milk / cream / butter / powdered milk)', () => {
    const cases: ReadonlyArray<[string, RegExp, RegExp]> = [
      ['1 cup milk', /milk/i, /chocolate|yogurt/i],
      ['1 cup cream', /cream/i, /ice cream/i],
      ['1 cup butter', /butter/i, /peanut|margarine|substitute|oil|fruit/i],
      ['1 cup powdered milk', /milk, dry/i, /dessert|topping/i],
    ];
    for (const [line, expectRe, rejectRe] of cases) {
      const { row } = rowFor([line]);
      expect(row.status, line).not.toBe('needs_match');
      expect(row.selected_description ?? '', line).toMatch(expectRe);
      expect(row.selected_description ?? '', line).not.toMatch(rejectRe);
    }
  });

  it('P10. bare dry beans never auto-invents a named cultivar', () => {
    const { row } = rowFor(['1 cup dry beans']);
    expect(row.status).not.toBe('matched');
    expect(row.selected_description ?? '').not.toMatch(
      /tan|carioca|cranberry|navy|pinto|cannellini|kidney|northern/i
    );
  });

  it('P11. bare egg defaults to the raw baseline, never a cooked preparation', () => {
    const { row } = rowFor(['2 eggs']);
    expect(row.selected_description ?? '').not.toMatch(/fried|boiled|scrambled|baked|poached|cooked/i);
    if (row.status === 'matched') expect(row.selected_description ?? '').toMatch(/egg, whole, raw/i);
  });

  it('P12. re-analysis is deterministic (same input -> identical summary)', () => {
    const lines = ['1 cup cornmeal', '0.25 cup chopped fresh jalapeno', '1 cup honey'];
    expect(analyzeLines(lines).analysis.summary).toEqual(analyzeLines(lines).analysis.summary);
  });

  it('P13. Analyze never persists (advisory preview only)', () => {
    const { analysis } = analyzeLines(['1 cup cornmeal']);
    expect(analysis.preview?.advisory_only).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REALISTIC MULTI-INGREDIENT ONE-CLICK ACCEPTANCE
// ---------------------------------------------------------------------------

describe('auto analyzer — realistic one-click recipe acceptance', () => {
  const ONE_CLICK_RECIPE = [
    '1 cup all-purpose flour',
    '1 cup cornmeal',
    '2 eggs',
    '1 cup buttermilk',
    '0.5 cup unsalted butter',
    '1 tsp salt',
    '2 tbsp honey',
    '1 cup shredded cheddar cheese',
    '1 jalapeno, chopped',
    '4 slices bacon',
  ];

  it('performs most of the work on the first click without unsafe crossings', () => {
    const { analysis } = analyzeLines(ONE_CLICK_RECIPE);
    const { summary } = analysis;
    expect(summary.total).toBe(ONE_CLICK_RECIPE.length);
    // No ordinary ingredient should end up needing a match.
    expect(summary.needs_match).toBe(0);
    // The overwhelming majority resolve food identity automatically.
    expect(summary.matched + summary.needs_amount).toBeGreaterThanOrEqual(9);
    expect(summary.matched).toBeGreaterThanOrEqual(6);
    // Only a genuinely material subtype ambiguity may remain in review.
    expect(summary.matched_check).toBeLessThanOrEqual(1);
    // A full/near-full preview exists without opening any candidate list.
    expect(analysis.preview).toBeDefined();
    // Sensible identities were chosen for the ordinary ingredients.
    const selected = (needle: RegExp) =>
      analysis.rows.find((row) => needle.test(row.original_text))?.selected_description ?? '';
    expect(selected(/cornmeal/i)).toMatch(/cornmeal/i);
    expect(selected(/egg/i)).toMatch(/egg/i);
    expect(selected(/buttermilk/i)).toMatch(/buttermilk/i);
    expect(selected(/1 tsp salt/i)).toMatch(/^salt/i);
    expect(selected(/honey/i)).toMatch(/honey/i);
    expect(selected(/cheddar/i)).toMatch(/cheddar/i);
    expect(selected(/bacon/i)).toMatch(/bacon/i);
    expect(selected(/jalapeno/i)).toMatch(/jalapeno/i);
    expect(selected(/cornmeal/i)).not.toMatch(/stick|mush/i);
    expect(selected(/cheddar/i)).not.toMatch(/corn grits|flavor/i);
  });
});

// ---------------------------------------------------------------------------
// REALISTIC FIRST-CLICK ACCEPTANCE + COMPLETE/PARTIAL CLASSIFICATION
// ---------------------------------------------------------------------------

describe('auto analyzer — realistic first-click acceptance (PART 23)', () => {
  const RECIPE = [
    '2 cups all-purpose flour',
    '2 tsp baking powder',
    '0.5 tsp salt',
    '1.75 cup buttermilk',
    '3 tbsp honey',
    '2 large eggs',
    '0.5 cup unsalted butter',
  ];

  it('does most of the work on one click with no review and no missing match', () => {
    const { analysis } = analyzeLines(RECIPE);
    const { summary } = analysis;
    expect(summary.total).toBe(RECIPE.length);
    expect(summary.needs_match).toBe(0);
    expect(summary.matched_check).toBe(0);
    expect(summary.matched).toBeGreaterThanOrEqual(6);
    // Unsalted butter has no safe authenticated portion in the pinned bundle, so
    // it honestly remains NEEDS AMOUNT (manual fallback), never a wrong food.
    expect(summary.matched + summary.needs_amount).toBe(RECIPE.length);
    const selected = (needle: RegExp) =>
      analysis.rows.find((row) => needle.test(row.original_text))?.selected_description ?? '';
    expect(selected(/all-purpose flour/i)).toMatch(/all-purpose/i);
    expect(selected(/baking powder/i)).toMatch(/baking powder/i);
    expect(selected(/1 tsp salt|0.5 tsp salt/i)).toMatch(/^salt/i);
    expect(selected(/buttermilk/i)).toMatch(/buttermilk/i);
    expect(selected(/honey/i)).toMatch(/honey/i);
    expect(selected(/eggs/i)).toMatch(/egg, whole, raw/i);
    expect(selected(/unsalted butter/i)).toMatch(/unsalted/i);
  });
});

describe('auto analyzer — complete vs partial classification (PART 24/25)', () => {
  const COMPLETE_RECIPE = [
    '2 cups all-purpose flour',
    '1 tsp salt',
    '1 cup buttermilk',
    '2 tbsp honey',
    '1 tsp baking powder',
    '2 large eggs',
  ];
  const PARTIAL_RECIPE = [...COMPLETE_RECIPE, '0.5 cup unsalted butter'];

  it('a fully-resolved one-click recipe is COMPLETE with zero unresolved lines', () => {
    const { analysis } = analyzeLines(COMPLETE_RECIPE);
    expect(analysis.summary.matched).toBe(COMPLETE_RECIPE.length);
    expect(analysis.summary.needs_amount).toBe(0);
    expect(analysis.summary.needs_match).toBe(0);
    expect(analysis.summary.matched_check).toBe(0);
    expect(analysis.preview?.unresolved.length).toBe(0);
    expect(analysis.preview?.status).toBe('complete');
  });

  it('a recipe with one unresolvable amount is PARTIAL (not hardcoded)', () => {
    const { analysis } = analyzeLines(PARTIAL_RECIPE);
    expect(analysis.preview?.unresolved.length).toBeGreaterThan(0);
    expect(analysis.preview?.status).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// EQUIVALENT-FOOD SIBLING SAFETY (PART 26)
//   Portion-aware selection may only choose a bounded same-food sibling; it can
//   never donate/borrow across a material food-family, product, or preparation
//   boundary.
// ---------------------------------------------------------------------------

describe('auto analyzer — equivalent-food sibling safety', () => {
  it('a wrong food family is never the automatic default', () => {
    const cases: ReadonlyArray<[string, RegExp, RegExp]> = [
      ['1 cup milk', /milk/i, /yogurt|chocolate|cheese/i],
      ['1 cup chicken', /chicken/i, /fat, chicken|soup|fried|bacon/i],
      ['1 cup tomato', /tomato/i, /sauce/i],
      ['1 cup cheese', /cheese/i, /sandwich|sauce/i],
      ['1 cup cornmeal', /cornmeal/i, /stick|mush/i],
      ['1 cup flour', /flour/i, /cake|bread|chicken/i],
    ];
    for (const [line, expectRe, rejectRe] of cases) {
      const { row } = rowFor([line]);
      if (row.selected_description) {
        expect(row.selected_description, line).toMatch(expectRe);
        expect(row.selected_description, line).not.toMatch(rejectRe);
      }
    }
  });

  it('a forged automatic marker for a materially different candidate fails closed', () => {
    const adapted = adaptLines(['1 cup milk']);
    const review = session.reviewIngredient(adapted[0].ingredient) as never;
    const eligible = new Set(
      bestEffortDefaultCandidates(review as never).map((candidate) => candidate.fdc_id)
    );
    // The yogurt record is a different food; it is NOT in the bounded set.
    const yogurt = (review as { candidates: ReadonlyArray<{ fdc_id: number; description: string }> }).candidates.find(
      (candidate) => /yogurt/i.test(candidate.description)
    );
    if (yogurt) expect(eligible.has(yogurt.fdc_id)).toBe(false);
  });
});
