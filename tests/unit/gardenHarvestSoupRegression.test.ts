/**
 * The Kitchen Codex — Garden Harvest Vegetable Soup regression fixture.
 *
 * The real recipe shape observed in production:
 *   2 tbsp olive oil, 1 yellow onion diced, 3 carrots sliced, 2 celery stalks
 *   chopped, 3 garlic cloves minced, 6 cup vegetable broth, 14.5 oz diced
 *   tomatoes, 1 zucchini chopped, 1 tsp dried thyme, 0.25 cup fresh parsley.
 *
 * Proves the unified AI exception-resolution invariants against the SAME pinned
 * USDA bundle the application authenticates:
 *   - the live status summary equals the rendered live row statuses (the
 *     status-count repair) even though it differs from the analyzer snapshot;
 *   - AI help is offered despite ZERO needs-match rows;
 *   - garlic resolves through an authenticated USDA count portion only;
 *   - broth/zucchini suggestions still go through deterministic local
 *     verification (no forced candidate);
 *   - arbitrary AI grams are rejected and Apply remains explicit;
 *   - nothing here writes or persists anything.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import {
  actionableExceptionRows,
  projectLiveRows,
  summarizeLiveRows,
} from '../../src/core/nutritionV2/phase4/liveRow';
import { resolveAmountsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiAmountResolve';
import { resolveFoodsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiResolve';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { sanitizeAiResolutionResponse } from '../../src/core/nutritionV2/aiResolution';
import {
  MAX_SERIALIZED_BYTES,
  serializedBlockBytes,
  toInertValue,
} from '../../src/core/nutritionV2/schema';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type {
  AdvancedNutritionSession,
  Phase4State,
} from '../../src/core/nutritionV2/phase4';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

const LINES: ReadonlyArray<string> = [
  '2 tbsp olive oil',
  '1 yellow onion, diced',
  '3 carrots, sliced',
  '2 celery stalks, chopped',
  '3 garlic cloves, minced',
  '6 cup vegetable broth',
  '14.5 oz diced tomatoes',
  '1 zucchini, chopped',
  '1 tsp dried thyme',
  '0.25 cup fresh parsley',
];

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) {
    throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  }
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

/**
 * The invariant real-data setup for the 10-line Garden Harvest recipe: the real
 * pinned-bundle adapt + analyze + review-rows + live projection. It is
 * deterministic and read-only, but legitimately costs more than a second, so
 * running it inside every test body repeatedly consumed Vitest's default 5000 ms
 * per-test budget under full-suite CPU contention (deterministically
 * reproducible with all cores occupied).
 *
 * TEST-STABILITY REPAIR (no coverage change): the setup runs ONCE in the bounded
 * file-scoped hook below, outside the per-test timeout clock. Every behavioral
 * assertion remains in its original test body, and every per-test state
 * derivation (`clearedState`, `merged`, ...) is built from spread copies, so the
 * shared fixture is never mutated by a test.
 */
function buildGardenHarvest() {
  const adaptation = adaptRecipe({
    title: 'Garden Harvest Vegetable Soup',
    servings: 4,
    ingredients: LINES.map((line) => structuredLine(line)),
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 4);
  const rows = buildReviewRows(session, adapted);
  const state = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: null,
    baseServings: 4,
    rows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: 4,
    preview: analysis.preview ?? null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
  const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
  const liveRows = projectLiveRows(
    state,
    analyzedByRef,
    adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  );
  return Object.freeze({ adaptation, adapted, analysis, rows, state, liveRows });
}

let gardenHarvestFixture: ReturnType<typeof buildGardenHarvest> | undefined;

beforeAll(() => {
  gardenHarvestFixture = buildGardenHarvest();
}, 120000);

function gardenHarvest(): ReturnType<typeof buildGardenHarvest> {
  if (gardenHarvestFixture === undefined) {
    throw new Error('garden harvest fixture not initialized');
  }
  return gardenHarvestFixture;
}

describe('Garden Harvest Vegetable Soup — live status authority', () => {
  it('the live status summary equals the rendered live rows exactly', () => {
    const { analysis, liveRows } = gardenHarvest();
    const summary = summarizeLiveRows(liveRows);

    const tallies = {
      matched: liveRows.filter((row) => row.status === 'matched').length,
      review_suggested: liveRows.filter((row) => row.status === 'review_suggested').length,
      needs_amount: liveRows.filter((row) => row.status === 'needs_amount').length,
      needs_match: liveRows.filter((row) => row.status === 'needs_match').length,
      qualitative: liveRows.filter((row) => row.status === 'qualitative').length,
    };
    expect(summary.total).toBe(LINES.length);
    expect({
      matched: summary.matched,
      review_suggested: summary.review_suggested,
      needs_amount: summary.needs_amount,
      needs_match: summary.needs_match,
      qualitative: summary.qualitative,
    }).toEqual(tallies);

    // The analyzer snapshot is a DIFFERENT authority; the live summary must not
    // be derived from it (this is the repaired divergence).
    expect(summary.matched).toBe(
      analysis.rows.filter((row) => row.status === 'matched').length
    );
    // Zero needs-match, yet actionable work remains.
    expect(summary.needs_match).toBe(0);
    expect(summary.actionable).toBeGreaterThan(0);
  });

  it('offers AI help for the actionable rows despite zero needs-match', () => {
    const { rows, liveRows } = gardenHarvest();
    const eligible = actionableExceptionRows(rows, liveRows);
    expect(eligible.length).toBeGreaterThan(0);
    const texts = eligible.map((row) => row.original_text).join(' | ');
    // Phase 6: garlic resolves deterministically through the verified household
    // fallback, so it is no longer an actionable exception; the genuinely
    // unresolved lines remain offered.
    expect(texts).not.toMatch(/garlic/i);
    expect(texts).toMatch(/vegetable broth/i);
    expect(texts).toMatch(/zucchini/i);
    const garlic = liveRows.find((row) => /garlic/i.test(row.original_text));
    expect(garlic?.status).toBe('matched');
    expect(garlic?.mass_source).toBe('household_portion');
    expect(garlic?.resolved_grams).toBe(9);
  });
});

describe('Garden Harvest Vegetable Soup — AI amount path', () => {
  it('resolves 3 garlic cloves through an authenticated USDA clove portion', () => {
    const { adapted, analysis, rows, state } = gardenHarvest();
    // Phase 6: clear the deterministic household fallback so the AI-assisted
    // COUNT path is exercised on a genuine needs_amount row.
    const clearedState: Phase4State = { ...state, householdPortions: {} } as Phase4State;
    const liveRows = projectLiveRows(
      clearedState,
      new Map(analysis.rows.map((row) => [row.line_ref, row])),
      adapted,
      session,
      analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
      analysis.portions,
      analysis.countPortions
    );
    const garlic = liveRows.find((row) => /garlic/i.test(row.original_text));
    if (!garlic) throw new Error('missing garlic row');
    expect(garlic.status).toBe('needs_amount');

    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state: clearedState,
      suggestions: [
        {
          line_ref: garlic.line_ref,
          interpreted_food_name: 'Garlic, raw',
          suggested_usda_queries: ['garlic raw'],
          quantity_value: 3,
          quantity_unit_hint: 'cloves',
          count_descriptor_hint: 'clove',
          portion_search_hint: 'clove',
          preparation_hint: 'minced',
        },
      ],
    });
    expect(outcome.resolved).toHaveLength(1);
    expect(outcome.resolved[0].resolved_grams).toBe(9);
    expect(outcome.resolved[0].choice.aiAssisted).toBe(true);

    const merged: Phase4State = {
      ...clearedState,
      countPortions: { ...clearedState.countPortions, [garlic.line_ref]: outcome.resolved[0].choice },
    } as Phase4State;
    const calculated = session.calculate(buildCalculationRequest(adapted, merged));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients.find((entry) => entry.line_ref === garlic.line_ref);
    if (!evidence) throw new Error('missing evidence');
    expect(evidence.resolved_grams).toBe(9);
    expect(evidence.mass_source).toBe('count_portion');
    expect(evidence.user_confirmed).toBe(false);
    // Apply remains explicit: AI assistance never authorizes persistence.
    expect(calculated.preview.application_authorized).toBe(false);
    // The AI path never mutated the caller's working state.
    expect(clearedState.countPortions[garlic.line_ref]).toBeUndefined();
  });

  it('does not invent grams when the AI interpretation has no closed count unit', () => {
    const { adapted, rows, state, liveRows } = gardenHarvest();
    const onion = liveRows.find((row) => /onion/i.test(row.original_text));
    if (!onion) throw new Error('missing onion row');
    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [
        {
          line_ref: onion.line_ref,
          interpreted_food_name: 'Onions, yellow, raw',
          suggested_usda_queries: ['onions yellow raw'],
          quantity_value: 1,
          quantity_unit_hint: 'onion',
          count_descriptor_hint: 'onion',
          portion_search_hint: 'onion',
        },
      ],
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(outcome.unresolved).toContain(onion.line_ref);
  });
});

describe('Garden Harvest Vegetable Soup — AI food identity path', () => {
  it('broth/zucchini suggestions still pass through deterministic local verification', () => {
    const { adapted, rows, liveRows } = gardenHarvest();
    const broth = liveRows.find((row) => /vegetable broth/i.test(row.original_text));
    const zucchini = liveRows.find((row) => /zucchini/i.test(row.original_text));
    if (!broth || !zucchini) throw new Error('missing rows');
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows,
      adapted,
      suggestions: [
        {
          line_ref: broth.line_ref,
          interpreted_food_name: 'Vegetable broth',
          suggested_usda_queries: ['vegetable broth', 'vegetable stock'],
        },
        {
          line_ref: zucchini.line_ref,
          interpreted_food_name: 'Zucchini',
          suggested_usda_queries: ['zucchini raw'],
        },
      ],
    });
    // Every produced candidate must be a genuine pinned-catalog record bound to
    // the ORIGINAL row's review digest; no candidate is ever forced.
    for (const candidate of outcome.candidates) {
      expect(candidate.fdc_id).toBeGreaterThan(0);
      expect(candidate.choice.record_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(candidate.choice.catalog_digest).toBe(session.metadata().catalog_digest);
      if (candidate.auto) expect(candidate.choice.aiAccepted).toBe(true);
      else expect(candidate.choice.aiAccepted).toBeUndefined();
    }
    const covered = new Set(outcome.candidates.map((candidate) => candidate.line_ref));
    for (const lineRef of [broth.line_ref, zucchini.line_ref]) {
      if (!covered.has(lineRef)) expect(outcome.unresolved).toContain(lineRef);
    }
  });

  it('rejects an AI response carrying an arbitrary gram value', () => {
    const result = sanitizeAiResolutionResponse(
      {
        version: 1,
        suggestions: [
          {
            line_ref: 'ing:4:0000',
            interpreted_food_name: 'Garlic, raw',
            suggested_usda_queries: ['garlic raw'],
            grams: 9,
          },
        ],
      },
      { allowedLineRefs: ['ing:4:0000'] }
    );
    expect(result.ok).toBe(false);
  });
});

/**
 * THE PRODUCTION LIVE-STATE REGRESSION. A realistic multi-line recipe whose
 * baseline calculation request is large (many confirmed reviews). Before the
 * repair, merging a few accepted AI resolutions pushed the serialized request
 * past the 64 KiB materialization bound, so the WHOLE calculation failed closed
 * and `applyWorkingSelections` silently applied NOTHING while the UI message
 * already counted the proposals as "resolved automatically".
 */
describe('AI exception live-state application — serialization bound + real transitions', () => {
  const LARGE_LINES: ReadonlyArray<string> = [
    '2 cups cooked long-grain rice (cooled)',
    '1.5 lb ground beef',
    '1 tbsp Worcestershire sauce',
    '1 egg',
    '1 yellow onion, diced',
    '2 tbsp fresh parsley, chopped',
    '3 cloves garlic, minced',
    '1 tsp salt',
    '1/2 tsp black pepper',
    '1 tsp dried dill',
    '1 tsp onion powder',
    '1/4-1/2 tsp chili flakes (optional)',
    '3 cans tomato sauce',
    '1 medium head green cabbage',
    '1/2 cup water',
    'fresh dill for garnish',
  ];

  function largeRecipe() {
    const adaptation = adaptRecipe({
      title: 'Cabbage Beef Skillet',
      servings: 6,
      ingredients: LARGE_LINES.map((line) => structuredLine(line)),
    });
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 6);
    const rows = buildReviewRows(session, adapted);
    const state = {
      version: '',
      status: 'ready',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: null,
      baseServings: 6,
      rows,
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      userMasses: {},
      basis: 'entire_recipe',
      selectedServings: 6,
      preview: analysis.preview ?? null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    } as Phase4State;
    const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
    const liveRows = projectLiveRows(
      state,
      analyzedByRef,
      adapted,
      session,
      analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
      analysis.portions,
      analysis.countPortions
    );
    return { adaptation, adapted, analysis, rows, state, analyzedByRef, liveRows };
  }

  it('resolves 3 garlic cloves to MATCHED 9 g in the same live state used by evidence/preview/counts', { timeout: 30000 }, () => {
    const { adapted, analysis, rows, state, analyzedByRef, liveRows } = largeRecipe();
    const garlic = liveRows.find((row) => /garlic/i.test(row.original_text));
    if (!garlic) throw new Error('missing garlic row');
    expect(garlic.status).toBe('needs_amount');
    // The baseline request is already large: the bounded review reference must
    // keep the MERGED request materializable, or the whole calculation fails
    // closed and the accepted resolution is silently lost.
    const baselineBytes = serializedBlockBytes(
      buildCalculationRequest(adapted, state),
      Number.MAX_SAFE_INTEGER
    );
    expect(baselineBytes).toBeGreaterThan(10_000);

    const outcome = resolveAmountsFromAiSuggestions({
      session,
      rows,
      adapted,
      liveRows,
      state,
      suggestions: [
        {
          line_ref: garlic.line_ref,
          interpreted_food_name: 'Garlic, raw',
          suggested_usda_queries: ['garlic raw'],
          quantity_value: 3,
          quantity_unit_hint: 'cloves',
          count_descriptor_hint: 'clove',
          portion_search_hint: 'clove',
          preparation_hint: 'minced',
        },
      ],
    });
    expect(outcome.resolved).toHaveLength(1);
    expect(outcome.resolved[0].resolved_grams).toBe(9);

    // EXACTLY the UI merge path: copy the maps, add the accepted choice, apply.
    const merged = {
      ...state,
      countPortions: {
        ...state.countPortions,
        [garlic.line_ref]: outcome.resolved[0].choice,
      },
    } as Phase4State;
    const request = buildCalculationRequest(adapted, merged);
    expect(toInertValue(request).ok).toBe(true);
    expect(serializedBlockBytes(request, Number.MAX_SAFE_INTEGER)).toBeLessThan(
      MAX_SERIALIZED_BYTES
    );

    const calculated = session.calculate(request);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;

    const applied = { ...merged, preview: calculated.preview } as Phase4State;
    const afterLiveRows = projectLiveRows(
      applied,
      analyzedByRef,
      adapted,
      session,
      ingredientEvidenceViews(calculated.preview),
      analysis.portions,
      analysis.countPortions
    );
    const afterGarlic = afterLiveRows.find((row) => row.line_ref === garlic.line_ref);
    if (!afterGarlic) throw new Error('missing garlic after');
    expect(afterGarlic.status).toBe('matched');
    expect(afterGarlic.resolved_grams).toBe(9);
    expect(afterGarlic.mass_source).toBe('count_portion');
    const evidence = calculated.preview.ingredients.find(
      (entry) => entry.line_ref === garlic.line_ref
    );
    expect(evidence?.outcome).toBe('calculated');
    expect(evidence?.resolved_grams).toBe(9);
    expect(evidence?.user_confirmed).toBe(false);

    // TRUTHFUL COUNTS DERIVED AFTER MUTATION: one targeted row genuinely
    // transitioned needs_amount -> matched, and the actionable count dropped.
    const targetedRefs = new Set([garlic.line_ref]);
    const resolvedAutomatically = afterLiveRows.filter(
      (row) => targetedRefs.has(row.line_ref) && row.status === 'matched'
    ).length;
    expect(resolvedAutomatically).toBe(1);
    expect(summarizeLiveRows(afterLiveRows).actionable).toBe(
      summarizeLiveRows(liveRows).actionable - 1
    );
  });
});
