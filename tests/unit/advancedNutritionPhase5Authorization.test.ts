/**
 * The Kitchen Codex — Advanced Nutrition Phase 5A: Apply authorization and
 * persistence-candidate construction.
 *
 * Proves the trusted boundary between the advisory Phase 3/4 calculation and a
 * future Phase 5B Apply: the candidate is always reconstructed from genuine
 * authority, stale authority fails closed, forged caller data can never override
 * the calculation, and the emitted block is canonical schema v1 (totals only).
 *
 * Synthetic fixtures are clearly labeled and used only for unit-level behavior.
 */

import { describe, it, expect } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { buildPortionChoice } from '../../src/core/nutritionV2/phase4/portion';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import type {
  AdaptedRecipe,
  AdvancedNutritionSession,
  Phase4Action,
  Phase4Row,
  Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { AdvisoryNutritionPreview } from '../../src/core/nutritionV2/calculation/types';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import { decodeCodexNutrition, encodeCodexNutrition, validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import { MAX_SERIALIZED_BYTES, serializedBlockBytes, type CodexNutritionV1 } from '../../src/core/nutritionV2/schema';

// ---------------------------------------------------------------------------
// Synthetic fixtures (NOT real nutrition data)
// ---------------------------------------------------------------------------

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  {
    fdcId: 6001,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, white',
    nutrients: { calories: 364, protein: 10.3, fiber: 0 },
    portions: [{ usda_portion_id: 2, amount: 1, measure: 'cup', gram_weight: 125, sequence: 1 }],
  },
  {
    fdcId: 6004,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, whole-grain',
    nutrients: { calories: 340, protein: 13.2 },
  },
  {
    fdcId: 6002,
    dataType: 'sr_legacy',
    description: 'Bacon',
    nutrients: { calories: 541 },
    portions: [
      { usda_portion_id: 1, amount: 1, measure: 'undetermined', modifier: 'slice', gram_weight: 28, sequence: 1 },
    ],
  },
  {
    fdcId: 6005,
    dataType: 'foundation',
    description: 'Sugar, granulated',
    nutrients: { calories: 387 },
  },
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

const OTHER_BUNDLE = buildCalculationBundle([
  {
    fdcId: 6001,
    dataType: 'sr_legacy',
    description: 'Flour, wheat, white',
    nutrients: { calories: 999 },
  },
]);
const OTHER_SESSION_RESULT = createAdvancedNutritionSession(OTHER_BUNDLE.manifest, OTHER_BUNDLE.records);
if (!OTHER_SESSION_RESULT.ok) throw new Error('other session failed');
const OTHER_SESSION: AdvancedNutritionSession = OTHER_SESSION_RESULT.session;

const FIXED_TIME = '2026-09-18T00:00:00.000Z';

/** Mirrors the existing Phase 4 tests: derive amount/unit via the recipe parser. */
function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipeWith(
  ingredients: ReadonlyArray<Record<string, unknown>>,
  servings = 2,
  filePath = 'r.md'
): Record<string, unknown> {
  return { filePath, title: 'Phase 5A test recipe', servings, ingredients };
}

const FLOUR_LINE = '100 g Flour, wheat, white';
const VOLUME_LINE = '1 cup Flour, wheat, white';
const AMBIGUOUS_LINE = '100 g flour wheat';
const BACON_LINE = '8 slices bacon';

interface Setup {
  readonly adapted: AdaptedRecipe;
  readonly state: Phase4State;
  readonly preview: AdvisoryNutritionPreview;
  readonly recipe: Record<string, unknown>;
}

function calculatePreview(
  session: AdvancedNutritionSession,
  recipe: Record<string, unknown>,
  scope: ReadonlyArray<string>,
  select?: (ctx: { dispatch: (action: Phase4Action) => void; rows: ReadonlyArray<Phase4Row>; adapted: AdaptedRecipe }) => void
): Setup {
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe;
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adapted.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows: buildReviewRows(session, adapted.adapted),
    baseServings: adapted.base_servings,
  });
  const dispatch = (action: Phase4Action) => {
    state = phase4Reducer(state, action);
  };
  if (select) select({ dispatch, rows: state.rows, adapted });
  const seq = state.operationSeq;
  const base = buildCalculationRequest(adapted.adapted, state) as Record<string, unknown>;
  const result = session.calculate({ ...base, nutrient_scope: [...scope] });
  if (!result.ok) throw new Error(`calculation failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  dispatch({ type: 'preview_succeeded', seq, recipeKey: state.recipeKey as string, preview: result.preview });
  return { adapted, state, preview: result.preview, recipe };
}

function authorize(
  setup: Setup,
  overrides: Record<string, unknown> = {},
  session: AdvancedNutritionSession = SESSION
) {
  return authorizeNutritionPersistence({
    session,
    recipe: setup.recipe,
    state: setup.state,
    computedAt: FIXED_TIME,
    ...overrides,
  });
}

function candidateOf(result: ReturnType<typeof authorizeNutritionPersistence>) {
  if (!result.ok) {
    throw new Error(`expected authorized, got ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  }
  return result.candidate;
}

function failureCodeOf(result: ReturnType<typeof authorizeNutritionPersistence>): string {
  return result.ok ? 'ok' : (result as { ok: false; failure: { code: string } }).failure.code;
}

/** A fully-valid stored schema-v1 block, for existing-block decode tests. */
function storedV1(overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  return {
    schema: 1,
    basis: 'total',
    servings: 4,
    status: 'complete',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'usda_fdc_release_2026_04' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: {
        amount: 100,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
      },
    },
    ingredients: [
      {
        line_ref: 'flour',
        source: 'usda_fdc',
        source_food_id: '6001',
        source_release: 'usda_fdc_release_2026_04',
        match_status: 'confirmed',
        resolved: true,
        user_confirmed: true,
      },
    ],
    unresolved: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid authorization
// ---------------------------------------------------------------------------

describe('phase 5A — valid authorization', () => {
  it('authorizes a current complete calculation as a canonical totals-only block', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    expect(setup.preview.status).toBe('complete');

    const candidate = candidateOf(authorize(setup));
    expect(candidate.block.schema).toBe(1);
    expect(candidate.block.basis).toBe('total');
    expect(candidate.block.servings).toBe(2);
    expect(candidate.block.status).toBe('complete');
    expect(candidate.block.nutrient_scope).toEqual(['calories', 'protein']);
    expect(candidate.block.nutrients.calories?.amount).toBeCloseTo(364, 6);
    expect(candidate.block.nutrients.protein?.amount).toBeCloseTo(10.3, 6);
    expect(candidate.block.ingredient_digest).toBe(setup.preview.ingredient_digest);
    expect(candidate.identity.ingredient_digest).toBe(setup.preview.ingredient_digest);
    expect(candidate.identity.mode).toBe('create');
    expect(candidate.block.computed_at).toBe(FIXED_TIME);
  });

  it('persists ENTIRE-RECIPE totals, never per-serving values', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)], 2), ['calories', 'protein']);
    const candidate = candidateOf(authorize(setup));
    // The stored total is the full-recipe value, not total/servings.
    expect(candidate.block.nutrients.calories?.amount).toBeCloseTo(364, 6);
    expect(candidate.block.nutrients.calories?.amount).not.toBeCloseTo(182, 6);
    const serialized = JSON.stringify(candidate.encoded);
    expect(serialized).not.toMatch(/per_serving/);
    expect(candidate.encoded.basis).toBe('total');
  });

  it('authorizes a current partial calculation as a schema-valid partial block', () => {
    // `1 cup sugar` matches a food but has NO authenticated mass -> one
    // unresolved ingredient line -> the whole result is PARTIAL.
    const setup = calculatePreview(
      SESSION,
      recipeWith([structured(FLOUR_LINE), structured('1 cup sugar')]),
      ['calories', 'protein', 'fat']
    );
    expect(setup.preview.status).toBe('partial');
    expect(setup.preview.unresolved.length).toBeGreaterThan(0);
    const candidate = candidateOf(authorize(setup));
    expect(candidate.block.status).toBe('partial');
    expect(candidate.block.nutrients.fat).toBeUndefined();
    expect(validateCodexNutritionV1(candidate.block).ok).toBe(true);
  });

  it('a fully-resolved calculation is a schema-valid COMPLETE block even when a scoped nutrient is absent', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein', 'fat']);
    expect(setup.preview.unresolved.length).toBe(0);
    expect(setup.preview.status).toBe('complete');
    const candidate = candidateOf(authorize(setup));
    expect(candidate.block.status).toBe('complete');
    expect(candidate.block.nutrients.fat).toBeUndefined();
    expect(validateCodexNutritionV1(candidate.block).ok).toBe(true);
  });

  it('preserves an explicit source-reported zero as zero (never absent)', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'fiber']);
    expect(setup.preview.status).toBe('complete');
    const candidate = candidateOf(authorize(setup));
    expect(candidate.block.nutrients.fiber).toBeDefined();
    expect(candidate.block.nutrients.fiber?.amount).toBe(0);
    expect(Object.is(candidate.block.nutrients.fiber?.amount, -0)).toBe(false);
  });

  it('keeps absent nutrients absent (never synthesized as zero)', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein', 'fat']);
    const candidate = candidateOf(authorize(setup));
    expect('fat' in candidate.block.nutrients).toBe(false);
  });

  it('binds the correct USDA release and ingredient evidence', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const candidate = candidateOf(authorize(setup));
    const metadata = SESSION.metadata();
    expect(candidate.block.sources).toEqual(['usda_fdc']);
    expect(candidate.block.source_releases.usda_fdc).toBe(metadata.bundle_release);
    expect(candidate.block.ingredients).toHaveLength(1);
    const evidence = candidate.block.ingredients[0];
    expect(evidence.source).toBe('usda_fdc');
    expect(evidence.source_food_id).toBe('6001');
    expect(evidence.source_release).toBe(metadata.bundle_release);
    expect(evidence.resolved).toBe(true);
    expect(evidence.amount?.unit).toBe('g');
    expect(evidence.amount?.value).toBe(100);
    expect(candidate.identity.bundle_release).toBe(metadata.bundle_release);
    expect(candidate.identity.session_identity).toBe(phase4SessionIdentity(metadata));
  });

  it('canonically round-trips through the schema codec', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const candidate = candidateOf(authorize(setup));
    const encoded = encodeCodexNutrition(candidate.block);
    const decoded = decodeCodexNutrition(encoded);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind !== 'v1') return;
    expect(decoded.value).toEqual(candidate.block);
    expect(candidate.encoded).toEqual(encoded);
    // The final gate proves the serialized-byte bound.
    expect(serializedBlockBytes(candidate.encoded)).toBeLessThanOrEqual(MAX_SERIALIZED_BYTES);
  });

  it('resolves a deterministic count portion into a totals-only block', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(BACON_LINE)]), ['calories']);
    expect(setup.preview.ingredients[0].outcome).toBe('calculated');
    expect(setup.preview.ingredients[0].resolved_grams).toBe(224);
    const candidate = candidateOf(authorize(setup));
    expect(candidate.block.nutrients.calories?.amount).toBeCloseTo(1211.84, 6);
    expect(candidate.block.ingredients[0].source_food_id).toBe('6002');
  });

  it('resolves an explicit user-mass line without mislabelling provenance', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(BACON_LINE)]), ['calories'], ({ dispatch, adapted, rows }) => {
      const row = rows[0];
      const ingredient = adapted.adapted[0].ingredient;
      const review = SESSION.reviewIngredient(ingredient);
      const choice = buildUserMassChoice(SESSION, {
        lineRef: row.line_ref,
        ingredient,
        review,
        fdcId: 6002,
        quantity: 50,
        unit: 'g',
      });
      if (!choice.ok) throw new Error('user mass choice failed');
      dispatch({ type: 'select_user_mass', lineRef: row.line_ref, choice: choice.choice });
    });
    expect(setup.preview.ingredients[0].mass_source).toBe('user_mass');
    const candidate = candidateOf(authorize(setup));
    expect(candidate.block.ingredients[0].conversion_basis).toBeUndefined();
    expect(candidate.block.ingredients[0].source).toBe('usda_fdc');
  });
});

// ---------------------------------------------------------------------------
// Stale authority
// ---------------------------------------------------------------------------

describe('phase 5A — stale authority fails closed', () => {
  it('rejects an ingredient mutation after the preview was produced', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated = recipeWith(
      [{ original: '200 g Flour, wheat, white', name: 'Flour, wheat, white', amount: 200, unit: 'g' }],
      2
    );
    expect(failureCodeOf(authorize(setup, { recipe: mutated }))).toBe('stale_preview');
  });

  it('rejects a serving-denominator mutation', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)], 2), ['calories', 'protein']);
    const mutated = recipeWith([structured(FLOUR_LINE)], 4);
    expect(failureCodeOf(authorize(setup, { recipe: mutated }))).toBe('stale_preview');
  });

  it('rejects a match mutation that no longer matches the reviewed result', () => {
    let reviewDigest = '';
    const setup = calculatePreview(
      SESSION,
      recipeWith([structured(AMBIGUOUS_LINE)]),
      ['calories', 'protein'],
      ({ dispatch, rows }) => {
        const row = rows[0];
        reviewDigest = row.review_digest as string;
        dispatch({
          type: 'select_match',
          lineRef: row.line_ref,
          choice: { kind: 'candidate', fdc_id: 6001, review_digest: reviewDigest },
        });
      }
    );
    expect(setup.preview.ingredients[0].fdc_id).toBe(6001);

    const mutated: Phase4State = {
      ...setup.state,
      matches: {
        ...setup.state.matches,
        [setup.adapted.adapted[0].line_ref]: {
          kind: 'candidate',
          fdc_id: 6004,
          review_digest: reviewDigest,
        },
      },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).not.toBe('ok');
  });

  it('rejects a portion mutation', () => {
    let lineRef = '';
    const setup = calculatePreview(
      SESSION,
      recipeWith([structured(VOLUME_LINE)]),
      ['calories', 'protein'],
      ({ dispatch, adapted, rows }) => {
        lineRef = rows[0].line_ref;
        const ingredient = adapted.adapted[0].ingredient;
        const choice = buildPortionChoice(SESSION, {
          lineRef,
          ingredient,
          review: SESSION.reviewIngredient(ingredient),
          fdcId: 6001,
          portionIndex: 0,
        });
        if (!choice.ok) throw new Error('portion choice failed');
        dispatch({ type: 'select_portion', lineRef, choice: choice.choice });
      }
    );
    expect(setup.preview.ingredients[0].mass_source).toBe('source_portion');
    const mutated: Phase4State = {
      ...setup.state,
      portions: {
        ...setup.state.portions,
        [lineRef]: {
          fdc_id: 6001,
          portion_index: 0,
          selection: { calculation_version: 'stale' },
          review: {},
        },
      },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).not.toBe('ok');
  });

  it('rejects a count-portion mutation', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(BACON_LINE)]), ['calories']);
    const mutated: Phase4State = {
      ...setup.state,
      countPortions: {
        ...setup.state.countPortions,
        [setup.adapted.adapted[0].line_ref]: {
          fdc_id: 6002,
          portion_index: 0,
          selection: { count_portion_version: 'stale' },
          review: {},
        },
      },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).not.toBe('ok');
  });

  it('rejects a user-mass mutation', () => {
    let lineRef = '';
    const setup = calculatePreview(
      SESSION,
      recipeWith([structured(BACON_LINE)]),
      ['calories'],
      ({ dispatch, adapted, rows }) => {
        lineRef = rows[0].line_ref;
        const ingredient = adapted.adapted[0].ingredient;
        const choice = buildUserMassChoice(SESSION, {
          lineRef,
          ingredient,
          review: SESSION.reviewIngredient(ingredient),
          fdcId: 6002,
          quantity: 50,
          unit: 'g',
        });
        if (!choice.ok) throw new Error('user mass choice failed');
        dispatch({ type: 'select_user_mass', lineRef, choice: choice.choice });
      }
    );
    expect(setup.preview.ingredients[0].mass_source).toBe('user_mass');
    const mutated: Phase4State = {
      ...setup.state,
      userMasses: {
        ...setup.state.userMasses,
        [lineRef]: {
          fdc_id: 6002,
          quantity: 500,
          unit: 'g',
          selection: { calculation_version: 'stale' },
        },
      },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).not.toBe('ok');
  });

  it('rejects a session/bundle/catalog identity change', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    expect(failureCodeOf(authorize(setup, {}, OTHER_SESSION))).toBe('stale_preview');
  });

  it('rejects a calculation-version change in the reviewed preview', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated: Phase4State = {
      ...setup.state,
      preview: { ...setup.preview, calculation_version: 'usda_advisory_calc_v0' },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).toBe('calculation_mismatch');
  });

  it('rejects a preview explicitly marked stale', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated: Phase4State = { ...setup.state, status: 'preview_stale' };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).toBe('stale_preview');
  });

  it('rejects a state with no current preview', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated: Phase4State = { ...setup.state, preview: null };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).toBe('stale_preview');
  });
});

// ---------------------------------------------------------------------------
// Forgery resistance
// ---------------------------------------------------------------------------

describe('phase 5A — caller data can never override authority', () => {
  it('ignores a caller-supplied forged block and uses the calculation', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const forged = {
      schema: 1,
      basis: 'total',
      servings: 1,
      status: 'complete',
      computed_at: FIXED_TIME,
      ingredient_digest: `sha256:${'b'.repeat(64)}`,
      dv_standard: DV_STANDARD_ID,
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: 'forged' },
      nutrient_scope: ['calories'],
      nutrients: { calories: { amount: 1, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 1, measurable_ingredient_count: 1 } },
      ingredients: [],
      unresolved: [],
    };
    const candidate = candidateOf(authorize(setup, { candidate: forged, block: forged, encoded: forged }));
    expect(candidate.block.nutrients.calories?.amount).toBeCloseTo(364, 6);
    expect(candidate.block.ingredient_digest).toBe(setup.preview.ingredient_digest);
  });

  it('cannot override the source food identity or USDA release', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const candidate = candidateOf(
      authorize(setup, {
        source_food_id: '999999',
        source_release: 'forged_release',
        sources: ['user_manual'],
      })
    );
    expect(candidate.block.ingredients[0].source_food_id).toBe('6001');
    expect(candidate.block.ingredients[0].source_release).toBe(SESSION.metadata().bundle_release);
    expect(candidate.block.sources).toEqual(['usda_fdc']);
  });

  it('rejects a forged ingredient digest', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated: Phase4State = {
      ...setup.state,
      preview: { ...setup.preview, ingredient_digest: `sha256:${'c'.repeat(64)}` },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).toBe('calculation_mismatch');
  });

  it('rejects a forged bundle release in the reviewed preview', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated: Phase4State = {
      ...setup.state,
      preview: { ...setup.preview, bundle_release: 'forged' },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).toBe('calculation_mismatch');
  });

  it('ignores a forged authorization identity object', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const candidate = candidateOf(
      authorize(setup, {
        identity: { candidate_digest: 'forged' },
        authorization: { ok: true },
      })
    );
    expect(candidate.identity.candidate_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(candidate.identity.recipe_key).toBe(setup.adapted.recipe_key);
  });

  it('ignores a caller-supplied nutrient amount map', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const candidate = candidateOf(
      authorize(setup, { nutrients: { calories: { amount: 999999 } }, totals: { calories: { amount: 1 } } })
    );
    expect(candidate.block.nutrients.calories?.amount).toBeCloseTo(364, 6);
  });
});

// ---------------------------------------------------------------------------
// Schema gate and future-schema protection
// ---------------------------------------------------------------------------

describe('phase 5A — schema gate', () => {
  it('rejects an invalid serving denominator', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)], 2), ['calories', 'protein']);
    const mutated = recipeWith([structured(FLOUR_LINE)], 1001);
    expect(failureCodeOf(authorize(setup, { recipe: mutated }))).toBe('invalid_servings');
  });

  it('rejects missing, zero, negative, non-finite, -0, and non-numeric servings', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)], 2), ['calories', 'protein']);
    const invalidValues: ReadonlyArray<unknown> = [undefined, 0, -4, Number.NaN, Number.POSITIVE_INFINITY, -0, '4'];
    for (const value of invalidValues) {
      const recipe: Record<string, unknown> = {
        filePath: 'r.md',
        title: 'Phase 5A test recipe',
        ingredients: [structured(FLOUR_LINE)],
      };
      if (value !== undefined) recipe.servings = value;
      expect(failureCodeOf(authorize(setup, { recipe })), `servings=${String(value)}`).toBe('invalid_servings');
    }
  });

  it('rejects an unknown nutrient in the reviewed scope', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated: Phase4State = {
      ...setup.state,
      preview: { ...setup.preview, nutrient_scope: ['calories', 'unobtainium'] as never[] },
    };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).not.toBe('ok');
  });

  it('rejects a stored v1 block with negative zero', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const bad = storedV1({
      nutrients: {
        calories: {
          amount: -0,
          unit: 'kcal',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 1,
        },
      },
    });
    expect(failureCodeOf(authorize(setup, { existingBlock: bad }))).toBe('schema_invalid');
  });

  it('rejects a stored block with malformed evidence', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const bad = storedV1({ ingredients: [{ line_ref: 'x' } as never] });
    expect(failureCodeOf(authorize(setup, { existingBlock: bad }))).toBe('schema_invalid');
  });

  it('rejects a stored block with a source/release mismatch', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const bad = storedV1({
      ingredients: [
        {
          line_ref: 'flour',
          source: 'usda_fdc',
          source_food_id: '6001',
          source_release: 'other_release',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
        },
      ],
    });
    expect(failureCodeOf(authorize(setup, { existingBlock: bad }))).toBe('schema_invalid');
  });

  it('rejects an oversized stored block', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const bad = { schema: 1, note: 'x'.repeat(70_000) };
    expect(failureCodeOf(authorize(setup, { existingBlock: bad }))).toBe('schema_invalid');
  });

  it('recognizes an existing valid v1 block as a whole-block replace', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const candidate = candidateOf(authorize(setup, { existingBlock: storedV1() }));
    expect(candidate.identity.mode).toBe('replace');
    // The candidate is a whole new block, never a piecemeal merge of the old one.
    expect(candidate.block.servings).toBe(2);
    expect(candidate.block.nutrients.calories?.amount).toBeCloseTo(364, 6);
  });

  it('fails closed on an opaque future schema and never drops its data', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const future = { schema: 2, basis: 'total', futureField: { nested: [1, 2, 3] }, note: 'future' };
    const before = JSON.stringify(future);
    const result = authorize(setup, { existingBlock: future });
    expect(failureCodeOf(result)).toBe('unknown_future_schema');
    expect(JSON.stringify(future)).toBe(before);
  });

  it('rejects malformed existing data rather than silently replacing it', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    expect(failureCodeOf(authorize(setup, { existingBlock: { schema: 1, basis: 'per_serving' } }))).toBe(
      'schema_invalid'
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

describe('phase 5A — hostile input never escapes', () => {
  it('rejects a getter-based session without invoking it', () => {
    let invoked = 0;
    const request: Record<string, unknown> = {
      recipe: recipeWith([structured(FLOUR_LINE)]),
      state: {},
    };
    Object.defineProperty(request, 'session', {
      enumerable: true,
      get() {
        invoked += 1;
        return SESSION;
      },
    });
    const result = authorizeNutritionPersistence(request);
    expect(failureCodeOf(result)).toBe('unsafe_request');
    expect(invoked).toBe(0);
  });

  it('rejects a throwing proxy state without throwing', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('SECRET_MARKER');
        },
        ownKeys() {
          throw new Error('SECRET_MARKER');
        },
      }
    );
    let message = '';
    let result: ReturnType<typeof authorizeNutritionPersistence> | undefined;
    try {
      result = authorize(setup, { state: hostile });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('SECRET_MARKER');
    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
  });

  it('rejects a forged (non-genuine) session object', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const fake = {
      metadata: () => {
        throw new Error('forged session');
      },
    };
    expect(failureCodeOf(authorize(setup, {}, fake as unknown as AdvancedNutritionSession))).toBe(
      'unresolved_authority'
    );
  });

  it('rejects a state carrying a hostile selection map', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile');
        },
        getOwnPropertyDescriptor() {
          throw new Error('hostile');
        },
      }
    );
    const mutated = { ...setup.state, matches: hostile };
    expect(failureCodeOf(authorize(setup, { state: mutated }))).toBe('unsafe_request');
  });

  it('rejects a non-object request and a missing recipe', () => {
    expect(failureCodeOf(authorizeNutritionPersistence(null))).toBe('invalid_request');
    expect(failureCodeOf(authorizeNutritionPersistence('nope'))).toBe('invalid_request');
    expect(failureCodeOf(authorizeNutritionPersistence({ session: SESSION }))).toBe('invalid_request');
  });

  it('never echoes attacker-controlled values in failure messages', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const mutated: Phase4State = {
      ...setup.state,
      preview: { ...setup.preview, ingredient_digest: 'ATTACKER_MARKER' },
    };
    const result = authorize(setup, { state: mutated });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failure = (result as { ok: false; failure: { message: string } }).failure;
    expect(failure.message).not.toContain('ATTACKER_MARKER');
    expect(failure.message).toBe('phase5_calculation_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Genuine Phase 4 session authority (independent-audit repair)
// ---------------------------------------------------------------------------

describe('phase 5A — genuine session authority cannot be forged', () => {
  function forgedPreview(setup: Setup, totals: Record<string, unknown>): Record<string, unknown> {
    const metadata = SESSION.metadata();
    return {
      calculation_schema: 1,
      calculation_version: metadata.calculation_version,
      bundle_release: metadata.bundle_release,
      catalog_digest: metadata.catalog_digest,
      nutrient_map_version: metadata.nutrient_map_version,
      servings: setup.preview.servings,
      ingredient_digest: setup.preview.ingredient_digest,
      nutrient_scope: [...setup.preview.nutrient_scope],
      basis: 'total',
      status: 'complete',
      totals,
      ingredients: setup.preview.ingredients,
      unresolved: [],
      advisory_only: true,
      application_authorized: false,
    };
  }

  it('rejects a fully structurally-complete fake session and never invokes its methods', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const metadata = SESSION.metadata();
    let metadataCalls = 0;
    let calculateCalls = 0;
    let reviewCalls = 0;
    const forged = forgedPreview(setup, {
      calories: {
        amount: 12345.678,
        unit: 'kcal',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
      },
      protein: {
        amount: 999,
        unit: 'g',
        status: 'complete',
        coverage: 1,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 1,
      },
    });
    const fake = {
      metadata: () => {
        metadataCalls += 1;
        return metadata;
      },
      reviewIngredient: () => {
        reviewCalls += 1;
        return setup.state.rows[0].review;
      },
      reviewPortions: () => {
        reviewCalls += 1;
        return { ok: false, failure: { code: 'invalid_context', message: 'phase3_invalid_context' } };
      },
      reviewCountPortions: () => {
        reviewCalls += 1;
        return { ok: false, failure: { code: 'invalid_context', message: 'phase3_invalid_context' } };
      },
      confirmMatch: () => {
        reviewCalls += 1;
        return { outcome: 'invalid', failure: { code: 'invalid_catalog', message: 'phase2_invalid_catalog' } };
      },
      calculate: () => {
        calculateCalls += 1;
        return { ok: true, preview: forged };
      },
    };
    const result = authorize(setup, { session: fake as unknown as AdvancedNutritionSession });
    expect(result.ok).toBe(false);
    expect(failureCodeOf(result)).toBe('unresolved_authority');
    // The attacker-controlled authority methods were never invoked.
    expect(metadataCalls).toBe(0);
    expect(calculateCalls).toBe(0);
    expect(reviewCalls).toBe(0);
  });

  it('rejects a fake session copied from genuine metadata', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const metadata = SESSION.metadata();
    const fake = { metadata: () => metadata };
    expect(failureCodeOf(authorize(setup, { session: fake as unknown as AdvancedNutritionSession }))).toBe(
      'unresolved_authority'
    );
  });

  it('rejects attacker-chosen metadata values on a fake session', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const fake = {
      metadata: () => ({
        session_version: 'attacker',
        context_version: 'attacker',
        calculation_version: 'attacker',
        bundle_release: 'attacker',
        catalog_digest: 'attacker',
        nutrient_map_version: 'attacker',
        record_count: 0,
        source_record_count: 0,
        excluded_record_count: 0,
        data_types: [],
      }),
    };
    expect(failureCodeOf(authorize(setup, { session: fake as unknown as AdvancedNutritionSession }))).toBe(
      'unresolved_authority'
    );
  });

  it('rejects genuine method references bound to the wrong receiver', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const fake = {
      metadata: SESSION.metadata,
      calculate: SESSION.calculate,
      reviewIngredient: SESSION.reviewIngredient,
      reviewPortions: SESSION.reviewPortions,
      reviewCountPortions: SESSION.reviewCountPortions,
      confirmMatch: SESSION.confirmMatch,
    };
    expect(failureCodeOf(authorize(setup, { session: fake as unknown as AdvancedNutritionSession }))).toBe(
      'unresolved_authority'
    );
  });

  it('rejects an object inheriting from the genuine session prototype', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const fake = Object.create(SESSION) as AdvancedNutritionSession;
    expect(failureCodeOf(authorize(setup, { session: fake }))).toBe('unresolved_authority');
  });

  it('rejects a Proxy wrapping the genuine session', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const fake = new Proxy(SESSION, {}) as AdvancedNutritionSession;
    expect(failureCodeOf(authorize(setup, { session: fake }))).toBe('unresolved_authority');
  });

  it('rejects a fake whose authority methods throw, without throwing or leaking', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const fake = {
      metadata() {
        throw new Error('SECRET_METADATA');
      },
      calculate() {
        throw new Error('SECRET_CALCULATE');
      },
      reviewIngredient() {
        throw new Error('SECRET_REVIEW');
      },
      reviewPortions() {
        throw new Error('SECRET_REVIEW');
      },
      reviewCountPortions() {
        throw new Error('SECRET_REVIEW');
      },
      confirmMatch() {
        throw new Error('SECRET_REVIEW');
      },
    };
    let message = '';
    let result: ReturnType<typeof authorizeNutritionPersistence> | undefined;
    try {
      result = authorize(setup, { session: fake as unknown as AdvancedNutritionSession });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('');
    expect(result).toBeDefined();
    expect(failureCodeOf(result as ReturnType<typeof authorizeNutritionPersistence>)).toBe(
      'unresolved_authority'
    );
    expect(result?.ok).toBe(false);
  });

  it('still authorizes the genuine Phase 4 session unchanged', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const candidate = candidateOf(authorize(setup));
    expect(candidate.block.nutrients.calories?.amount).toBeCloseTo(364, 6);
    expect(candidate.identity.session_identity).toBe(phase4SessionIdentity(SESSION.metadata()));
  });
});

// ---------------------------------------------------------------------------
// Persistence identity re-verification
// ---------------------------------------------------------------------------

describe('phase 5A — persistence identity cannot be replayed across authority', () => {
  it('recipe A candidate and recipe B candidate carry different recipe keys', () => {
    const a = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const b = calculatePreview(
      SESSION,
      recipeWith([{ original: '50 g Flour, wheat, white', name: 'Flour, wheat, white', amount: 50, unit: 'g' }]),
      ['calories', 'protein']
    );
    const candidateA = candidateOf(authorize(a));
    const candidateB = candidateOf(authorize(b));
    expect(candidateA.identity.recipe_key).not.toBe(candidateB.identity.recipe_key);
    expect(candidateA.identity.ingredient_digest).not.toBe(candidateB.identity.ingredient_digest);
    // A recipe-A candidate cannot authorize against recipe B.
    expect(failureCodeOf(authorize(a, { recipe: b.recipe }))).toBe('stale_preview');
  });

  it('a fake session cannot mint an identity from attacker metadata', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const fake = {
      metadata: () => SESSION.metadata(),
      calculate: () => ({ ok: true, preview: setup.preview }),
    };
    const result = authorize(setup, { session: fake as unknown as AdvancedNutritionSession });
    expect(result.ok).toBe(false);
    expect('candidate' in (result as object)).toBe(false);
    expect(failureCodeOf(result)).toBe('unresolved_authority');
  });

  it('create vs replace mode is bound into the identity', () => {
    const setup = calculatePreview(SESSION, recipeWith([structured(FLOUR_LINE)]), ['calories', 'protein']);
    const create = candidateOf(authorize(setup));
    const replace = candidateOf(authorize(setup, { existingBlock: storedV1() }));
    expect(create.identity.mode).toBe('create');
    expect(replace.identity.mode).toBe('replace');
    // The whole block is recomputed identically, but the identity differs by mode.
    expect(create.identity.candidate_digest).toBe(replace.identity.candidate_digest);
    expect(create.identity).not.toEqual(replace.identity);
    // An opaque future block can never be replaced.
    expect(failureCodeOf(authorize(setup, { existingBlock: { schema: 3, note: 'future' } }))).toBe(
      'unknown_future_schema'
    );
  });
});
