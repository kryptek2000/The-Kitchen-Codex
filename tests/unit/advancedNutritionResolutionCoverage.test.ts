/**
 * The Kitchen Codex — Advanced Nutrition resolution-coverage regression.
 *
 * Real-bundle regression for the generalized resolution failure classes found
 * by the Phase 7 coverage benchmark:
 *   - explicit MASS RANGES resolve through the documented midpoint policy while
 *     the range endpoints remain the parse authority (no endpoint is silently
 *     chosen);
 *   - explicit SECONDARY parenthetical mass resolves through the same policy and
 *     never pollutes the food identity;
 *   - measurement-aware candidate resolution prefers an IDENTICAL-description
 *     duplicate USDA record that can satisfy the recipe's volume measurement;
 *   - count identities are not destroyed by parenthetical package descriptors;
 *   - semantic identity guards survive measurement compatibility (measurement
 *     resolvability never rescues a wrong food);
 *   - alternatives are never collapsed into a fabricated food identity;
 *   - genuinely non-authoritative amounts stay unresolved (no fabricated grams,
 *     no fake provenance).
 *
 * All identities/portions are the REAL pinned USDA bundle. Every assertion is
 * generalized; the listed lines are probes, not special cases.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { extractCountIdentity } from '../../src/core/nutritionV2/calculation/countPortion';
import { selectAutomaticMatch } from '../../src/core/nutritionV2/matching/confidence';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { liveMassText } from '../../src/components/AdvancedNutritionModal';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import type { IngredientReviewResult } from '../../src/core/nutritionV2/matching/types';
import type { RecipeAnalysis } from '../../src/core/nutritionV2/phase4/analyzer';
import type { ObsidianRecipe } from '../../src/types';

const BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
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
  if (!result.ok) throw new Error('session failed');
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

function recipeFor(line: string): ObsidianRecipe {
  return {
    id: 'coverage',
    fileName: 'coverage.md',
    filePath: 'Recipes/coverage.md',
    rawMarkdown: '',
    title: 'Coverage',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [structuredLine(line)] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as unknown as ObsidianRecipe;
}

interface Flow {
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly analysis: RecipeAnalysis;
  readonly state: Phase4State;
  readonly live: LiveRowState;
  readonly lineRef: string;
}

function flow(line: string): Flow {
  const recipe = recipeFor(line);
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: 1,
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
  const live = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    calculated.ok ? ingredientEvidenceViews(calculated.preview) : null,
    analysis.portions,
    analysis.countPortions
  )[0];
  return { adapted, analysis, state, live, lineRef: adapted[0].line_ref };
}

function parsedOf(f: Flow) {
  const parsed = parseIngredient(f.adapted[0].ingredient);
  if (!parsed.ok) throw new Error('parse failed');
  return parsed.parsed;
}

function reviewOf(f: Flow): IngredientReviewResult {
  return f.analysis.rows[0].review as IngredientReviewResult;
}

const MIDPOINT_3_4_LB = ((3 + 4) / 2) * 453.59237;

describe('resolution coverage — explicit mass ranges', () => {
  it('resolves a mass range through the midpoint policy and keeps the endpoints as the parse authority', () => {
    const f = flow('3-4 lb beef chuck roast, cut into 2"-3" chunks');
    const parsed = parsedOf(f);
    expect(parsed.quantity_kind).toBe('range');
    expect(parsed.quantity_range).toEqual({ lower: 3, upper: 4 });
    // No endpoint is silently chosen: the scalar amount stays null.
    expect(parsed.amount).toBeNull();
    expect(parsed.measurement_kind).toBe('mass');
    expect(parsed.grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);
    expect(f.live.status).toBe('matched');
    expect(f.live.mass_source).toBe('direct_mass');
    expect(f.live.resolved_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);
  });

  it('supports `to`, en/em dash and gram ranges without faking an endpoint', () => {
    const to = flow('3 to 4 lb beef chuck roast');
    expect(to.live.mass_source).toBe('direct_mass');
    expect(to.live.resolved_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);

    const enDash = flow('3–4 lb beef chuck roast');
    expect(enDash.live.mass_source).toBe('direct_mass');
    expect(enDash.live.resolved_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);

    const grams = flow('75-100 g tomatoes');
    const gramsParsed = parsedOf(grams);
    expect(gramsParsed.amount).toBeNull();
    expect(grams.live.mass_source).toBe('direct_mass');
    expect(grams.live.resolved_grams).toBeCloseTo(87.5, 6);
  });

  it('never converts a count/volume range into a fabricated scalar mass', () => {
    const count = flow('2-3 tomatoes');
    expect(parsedOf(count).quantity_kind).toBe('range');
    expect(parsedOf(count).measurement_kind).not.toBe('mass');
    expect(count.live.resolved_grams).toBeUndefined();

    const volume = flow('1-2 tbsp olive oil');
    expect(parsedOf(volume).quantity_kind).toBe('range');
    expect(volume.live.resolved_grams).toBeUndefined();
  });
});

describe('resolution coverage — explicit secondary mass', () => {
  it('resolves a parenthetical total-mass range and strips it from the food query', () => {
    const f = flow('3 to 4 slices provolone (about 75 to 100 grams in total)');
    const parsed = parsedOf(f);
    expect(parsed.measurement_kind).toBe('mass');
    expect(parsed.grams).toBeCloseTo(87.5, 6);
    expect(parsed.query).toBe('provolone');
    expect(f.live.status).toBe('matched');
    expect(f.live.mass_source).toBe('direct_mass');
    expect(f.live.resolved_grams).toBeCloseTo(87.5, 6);
  });

  it('resolves a parenthetical exact mass on a count line', () => {
    const f = flow('2 slices bacon (about 20 g)');
    expect(parsedOf(f).grams).toBe(20);
    expect(f.live.mass_source).toBe('direct_mass');
    expect(f.live.resolved_grams).toBe(20);
  });

  it('does not reinterpret a container package net mass as direct mass', () => {
    // The canonical parse represents `(15 oz)` truthfully but deliberately does
    // not convert it into mass authority; this regression pins that boundary.
    const f = flow('1 (15 oz) can tomato sauce');
    const parsed = parsedOf(f);
    expect(parsed.container).toBe('can');
    expect(parsed.package_net_mass).toBeDefined();
    expect(parsed.measurement_kind).not.toBe('mass');
    expect(parsed.grams).toBeUndefined();
  });
});

describe('resolution coverage — measurement-aware candidate resolution', () => {
  it('prefers an identical-description duplicate that can resolve the volume', () => {
    const f = flow('2 cup heavy cream');
    expect(f.live.status).toBe('matched');
    expect(f.live.mass_source).toBe('source_portion');
    expect(f.live.resolved_grams).toBe(480);
    expect(f.analysis.rows[0].selected_description).toBe('Cream, heavy');
  });

  it('resolves a count identity whose portion carries a package-size parenthetical', () => {
    const identity = extractCountIdentity({
      measure: '1 slice (15 per 8 oz package)',
      gram_weight: 15,
    } as never);
    expect(identity).toEqual({ amount: 1, unit: 'slice', size: null });

    const f = flow('6 slices mortadella');
    expect(f.live.status).toBe('matched');
    expect(f.live.mass_source).toBe('count_portion');
    expect(f.live.resolved_grams).toBe(90);
  });
});

describe('resolution coverage — semantic identity guard', () => {
  it('never resolves crushed red pepper flakes to a fresh bell pepper', () => {
    const f = flow('1/4 teaspoon crushed red pepper flakes');
    const review = reviewOf(f);
    const strict = selectAutomaticMatch(review);
    const selected = f.analysis.rows[0].selected_fdc_id;
    const selectedDescription = f.analysis.rows[0].selected_description ?? '';
    // Measurement compatibility must never rescue a missing requested form.
    expect(strict?.fdc_id).not.toBe(2258590);
    if (selected !== undefined) {
      expect(selectedDescription).not.toMatch(/bell/i);
    }
    if (f.live.status === 'matched') {
      expect(selectedDescription).toMatch(/cayenne|spices, pepper/i);
    } else {
      expect(f.live.mass_source).toBeUndefined();
    }
  });

  it('keeps a wrong-form candidate out of the automatic path even when a portion exists', () => {
    const f = flow('1/4 teaspoon crushed red pepper flakes');
    const bell = reviewOf(f).candidates.find((candidate) => candidate.fdc_id === 2258590);
    expect(bell?.description).toMatch(/bell/i);
    expect(f.analysis.rows[0].selected_fdc_id).not.toBe(2258590);
  });
});

describe('resolution coverage — alternatives and vague amounts', () => {
  it('never fabricates a single food identity for `X or Y` alternatives', () => {
    const f = flow('2 tsp whole cloves or 1/2 tbsp ground clove');
    const selectedDescription = f.analysis.rows[0].selected_description;
    if (selectedDescription !== undefined) {
      expect(selectedDescription).toMatch(/clove/i);
    }
    // No combined/"or" identity and no mass from an ambiguous alternative.
    expect(f.live.resolved_grams).toBeUndefined();
  });

  it('leaves genuinely vague amounts unresolved with no fabricated grams or provenance', () => {
    for (const line of ['pinch dried basil', 'pinch dried oregano']) {
      const f = flow(line);
      expect(f.live.status, line).not.toBe('matched');
      expect(f.live.resolved_grams, line).toBeUndefined();
      expect(f.live.mass_source, line).toBeUndefined();
      expect(f.state.householdPortions[f.lineRef], line).toBeUndefined();
    }
  });
});

describe('resolution coverage — authority order across classes', () => {
  it('uses the strongest truthful authenticated source for each newly covered class', () => {
    const roast = flow('3-4 lb beef chuck roast');
    expect(roast.live.mass_source).toBe('direct_mass');

    const provolone = flow('3 to 4 slices provolone (about 75 to 100 grams in total)');
    expect(provolone.live.mass_source).toBe('direct_mass');

    const cream = flow('2 cup heavy cream');
    expect(cream.live.mass_source).toBe('source_portion');

    const mortadella = flow('6 slices mortadella');
    expect(mortadella.live.mass_source).toBe('count_portion');

    const garlic = flow('3 cloves garlic, minced');
    expect(['household_portion', 'count_portion']).toContain(garlic.live.mass_source);
    expect(garlic.live.resolved_grams).toBe(9);

    const tomato = flow('2 medium tomatoes, sliced');
    expect(tomato.live.mass_source).toBe('household_portion');
    expect(tomato.live.resolved_grams).toBe(246);
  });
});

// ---------------------------------------------------------------------------
// BLOCKING-1 — nutrient annotations are NEVER ingredient mass
// ---------------------------------------------------------------------------

describe('resolution coverage — nutrient annotations are never ingredient mass', () => {
  const NUTRIENT_ANNOTATION_LINES: ReadonlyArray<string> = [
    '1 cup flour (20 g protein)',
    '2 tbsp peanut butter (8 g protein per serving)',
    '1 cup milk (about 30 g fat)',
    '1 cup yogurt (12 g carbs)',
    '1 serving cereal (5 g fiber)',
    '1 bar (200 calories, 10 g protein)',
  ];

  for (const line of NUTRIENT_ANNOTATION_LINES) {
    it(`never takes direct mass from a nutrient annotation: ${line}`, () => {
      const parsed = parsedOf(flow(line));
      expect(parsed.measurement_kind).not.toBe('mass');
      expect(parsed.range_representative).toBeUndefined();
      expect(parsed.grams).toBeUndefined();
      const f = flow(line);
      expect(f.live.mass_source).not.toBe('direct_mass');
      // The annotation's own gram value is never the resolved mass.
      const annotation = /\((\d+(?:\.\d+)?)\s*g\b/.exec(line);
      if (annotation) {
        expect(f.live.resolved_grams).not.toBe(Number(annotation[1]));
      }
    });
  }

  it('strips nutrient-annotation clauses from the food query', () => {
    expect(parsedOf(flow('1 cup flour (20 g protein)')).query).toBe('flour');
    expect(parsedOf(flow('2 tbsp peanut butter (8 g protein per serving)')).query).toBe(
      'peanut butter'
    );
    expect(parsedOf(flow('1 cup milk (about 30 g fat)')).query).toBe('milk');
  });

  it('still accepts credible written total-mass clauses (positive grammar)', () => {
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ['2 slices bacon (about 20 g)', 20, 'bacon'],
      ['1 cup flour (about 125 g)', 125, 'flour'],
      ['1 cup flour (approximately 125 g)', 125, 'flour'],
      ['1 cup flour (125 g total)', 125, 'flour'],
      ['1 cup flour (125 g drained)', 125, 'flour'],
    ];
    for (const [line, grams, query] of cases) {
      const parsed = parsedOf(flow(line));
      expect(parsed.measurement_kind, line).toBe('mass');
      expect(parsed.grams, line).toBeCloseTo(grams, 6);
      expect(parsed.query, line).toBe(query);
      // An exact written scalar is not marked as a range representative.
      expect(parsed.range_representative, line).toBeUndefined();
    }

    // A parenthical total-mass RANGE is the same written-range authority class as
    // a direct range: it resolves by midpoint and carries the same deterministic
    // representative marker (never a fabricated scalar).
    const totalRange = flow('3 to 4 slices provolone (about 75 to 100 grams in total)');
    const totalRangeParsed = parsedOf(totalRange);
    expect(totalRangeParsed.grams).toBeCloseTo(87.5, 6);
    expect(totalRangeParsed.range_representative).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 75,
      upper: 100,
      unit: 'grams',
      representative_grams: 87.5,
    });
    expect(totalRange.live.mass_representative).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 75,
      upper: 100,
      unit: 'grams',
    });

    const dashRange = parsedOf(flow('3 to 4 slices provolone (75–100 g total)'));
    expect(dashRange.grams).toBeCloseTo(87.5, 6);
    expect(dashRange.range_representative?.lower).toBe(75);
    expect(dashRange.range_representative?.upper).toBe(100);
  });

  it('does not turn unrelated parenthetical numerals into ingredient mass', () => {
    for (const line of [
      '1 cup flour (80/20)',
      '1 cup flour (optional)',
      '1 cup flour (2%)',
    ]) {
      const parsed = parsedOf(flow(line));
      expect(parsed.measurement_kind, line).not.toBe('mass');
      expect(parsed.grams, line).toBeUndefined();
      expect(parsed.range_representative, line).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// FLAG-1 — written mass-range representative provenance and display
// ---------------------------------------------------------------------------

describe('resolution coverage — written range representative provenance', () => {
  it('marks a midpoint-derived range mass distinctly from an exact scalar', () => {
    const ranged = flow('3-4 lb beef chuck roast, cut into 2"-3" chunks');
    const rangedParsed = parsedOf(ranged);
    expect(rangedParsed.quantity_kind).toBe('range');
    expect(rangedParsed.amount).toBeNull();
    const representative = rangedParsed.range_representative;
    expect(representative?.amount_source).toBe('written_mass_range');
    expect(representative?.policy).toBe('midpoint');
    expect(representative?.lower).toBe(3);
    expect(representative?.upper).toBe(4);
    expect(representative?.unit).toBe('lb');
    expect(representative?.representative_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);
    expect(ranged.live.mass_source).toBe('direct_mass');
    expect(ranged.live.mass_representative).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 3,
      upper: 4,
      unit: 'lb',
    });
    expect(ranged.live.resolved_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);

    const scalar = flow('3.5 lb beef chuck roast');
    const scalarParsed = parsedOf(scalar);
    expect(scalarParsed.quantity_kind).toBe('exact');
    expect(scalarParsed.amount).toBe(3.5);
    expect(scalarParsed.range_representative).toBeUndefined();
    expect(scalar.live.mass_representative).toBeUndefined();
    expect(scalar.live.resolved_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);
  });

  it('renders the deterministic midpoint with display rounding and no raw FP noise', () => {
    const text = liveMassText(flow('3-4 lb beef chuck roast').live) ?? '';
    expect(text).toContain('written range midpoint (3–4 lb)');
    expect(text).toMatch(/^1587\.6 g/);
    expect(text).not.toContain('1587.5732950000001');

    const scalarText = liveMassText(flow('3.5 lb beef chuck roast').live) ?? '';
    expect(scalarText).not.toContain('range midpoint');
    expect(scalarText).toMatch(/^1587\.6 g/);
  });
});
