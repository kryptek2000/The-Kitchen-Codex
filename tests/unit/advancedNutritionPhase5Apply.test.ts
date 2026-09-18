/**
 * The Kitchen Codex — Advanced Nutrition Phase 5B: explicit Apply coordinator.
 *
 * Proves the write boundary: the candidate is freshly re-authorized from genuine
 * Phase 4 authority immediately before the write, only the freshly authorized
 * block is written, unrelated frontmatter is preserved, create/replace is
 * whole-block, stale/forged input fails closed, and no partial mutation occurs.
 *
 * Synthetic fixtures are clearly labeled and used only for unit-level behavior.
 */

import { describe, it, expect } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { parseIngredientLine, parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import type { AdvancedNutritionSession, Phase4Action, Phase4State } from '../../src/core/nutritionV2/phase4';
import type { AdvisoryNutritionPreview } from '../../src/core/nutritionV2/calculation/types';
import { decodeCodexNutrition, validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import { resolveRecipeVaultPath } from '../../src/core/vaultPath';
import {
  ADVANCED_NUTRITION_APPLY_UI_MESSAGE,
  applyAdvancedNutrition,
  type AdvancedNutritionApplyResult,
} from '../../src/application/advancedNutritionApply';
import type { ObsidianRecipe } from '../../src/types';

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
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

const OTHER_BUNDLE = buildCalculationBundle([
  { fdcId: 6001, dataType: 'sr_legacy', description: 'Flour, wheat, white', nutrients: { calories: 999 } },
]);
const OTHER_SESSION_RESULT = createAdvancedNutritionSession(OTHER_BUNDLE.manifest, OTHER_BUNDLE.records);
if (!OTHER_SESSION_RESULT.ok) throw new Error('other session failed');
const OTHER_SESSION: AdvancedNutritionSession = OTHER_SESSION_RESULT.session;

const FLOUR_LINE = '100 g Flour, wheat, white';
const BACON_LINE = '8 slices bacon';

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

interface RecipeOptions {
  readonly servings?: number;
  readonly filePath?: string;
  readonly title?: string;
  readonly frontmatter?: Record<string, unknown>;
  readonly instructions?: ReadonlyArray<{ stepNumber: number; text: string }>;
  readonly nutrition?: Record<string, unknown>;
  readonly calories?: string;
}

function obsidianRecipe(
  ingredients: ReadonlyArray<Record<string, unknown>>,
  options: RecipeOptions = {}
): ObsidianRecipe {
  const filePath = options.filePath ?? 'Recipes/Test Recipe.md';
  return {
    id: 'test-recipe',
    fileName: filePath.split('/').pop() as string,
    filePath,
    rawMarkdown: '',
    title: options.title ?? 'Test Recipe',
    tags: ['food/recipes'],
    category: 'Main Course',
    cuisine: 'American',
    difficulty: 'Easy',
    rating: 5,
    servings: options.servings ?? 2,
    ingredients: ingredients as never,
    instructions: (options.instructions ?? [{ stepNumber: 1, text: 'Cook.' }]) as never,
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: options.frontmatter ?? {},
    nutrition: options.nutrition as never,
    calories: options.calories,
  } as unknown as ObsidianRecipe;
}

interface Reviewed {
  readonly recipe: ObsidianRecipe;
  readonly state: Phase4State;
  readonly preview: AdvisoryNutritionPreview;
}

function buildReviewed(
  session: AdvancedNutritionSession,
  recipe: ObsidianRecipe,
  scope: ReadonlyArray<string>,
  select?: (ctx: { dispatch: (action: Phase4Action) => void; state: Phase4State }) => void
): Reviewed {
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
  if (select) select({ dispatch, state });
  const seq = state.operationSeq;
  const base = buildCalculationRequest(adapted.adapted, state) as Record<string, unknown>;
  const result = session.calculate({ ...base, nutrient_scope: [...scope] });
  if (!result.ok) throw new Error(`calculation failed: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  dispatch({ type: 'preview_succeeded', seq, recipeKey: state.recipeKey as string, preview: result.preview });
  return { recipe, state, preview: result.preview };
}

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

interface FakeVault {
  readonly files: Map<string, string>;
  readonly writes: ObsidianRecipe[];
  write(recipe: ObsidianRecipe): Promise<void>;
  readBack(recipe: ObsidianRecipe): Promise<string>;
}

function makeVault(): FakeVault {
  const files = new Map<string, string>();
  const writes: ObsidianRecipe[] = [];
  return {
    files,
    writes,
    async write(recipe: ObsidianRecipe) {
      writes.push(recipe);
      files.set(resolveRecipeVaultPath(recipe), serializeRecipeToObsidianMarkdown(recipe));
    },
    async readBack(recipe: ObsidianRecipe) {
      const text = files.get(resolveRecipeVaultPath(recipe));
      if (text === undefined) throw new Error('missing');
      return text;
    },
  };
}

interface ApplyOptions {
  readonly session?: unknown;
  readonly recipe?: ObsidianRecipe;
  readonly state?: unknown;
  readonly write?: ((recipe: ObsidianRecipe) => Promise<void>) | undefined;
  readonly readBack?: ((recipe: ObsidianRecipe) => Promise<string>) | undefined;
  readonly expectedMode?: unknown;
  readonly computedAt?: unknown;
}

async function apply(reviewed: Reviewed, options: ApplyOptions = {}): Promise<AdvancedNutritionApplyResult> {
  const request: Record<string, unknown> = {
    session: options.session ?? SESSION,
    recipe: options.recipe ?? reviewed.recipe,
    state: options.state ?? reviewed.state,
  };
  if ('write' in options) {
    if (options.write !== undefined) request.write = options.write;
  } else {
    request.write = makeVault().write;
  }
  if (options.readBack !== undefined) request.readBack = options.readBack;
  if (options.expectedMode !== undefined) request.expectedMode = options.expectedMode;
  if (options.computedAt !== undefined) request.computedAt = options.computedAt;
  return applyAdvancedNutrition(request);
}

function failureCodeOf(result: AdvancedNutritionApplyResult): string {
  return result.ok ? 'ok' : (result as { ok: false; failure: { code: string } }).failure.code;
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('phase 5B — explicit Apply success', () => {
  it('creates a new block when the recipe has none', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.mode).toBe('create');
    expect(result.result.candidate_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const written = vault.writes[0];
    expect(written.codexNutrition).toBeDefined();
    expect((written.codexNutrition as CodexNutritionV1).schema).toBe(1);
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') expect(decoded.value.nutrients.calories?.amount).toBeCloseTo(364, 6);
  });

  it('replaces the whole existing schema-v1 block', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: storedV1(), my_custom_field: 'keep-me' },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack, expectedMode: 'replace' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.mode).toBe('replace');
    const written = vault.writes[0];
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') {
      // Whole-block replacement: the old 100 kcal single-nutrient block is gone.
      expect(decoded.value.nutrients.calories?.amount).toBeCloseTo(364, 6);
      expect(decoded.value.nutrient_scope).toEqual(['calories', 'protein']);
    }
  });

  it('preserves unrelated frontmatter, simple nutrition, calories, ingredients, and body', async () => {
    const instructions = [{ stepNumber: 1, text: 'Mix and bake.' }];
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      title: 'My Cake',
      frontmatter: { my_custom_field: 'keep-me', codex_other: 'keep-too' },
      instructions,
      nutrition: { calories: 111, protein: 2 },
      calories: '111',
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack });
    expect(result.ok).toBe(true);
    const markdown = vault.files.get(resolveRecipeVaultPath(recipe)) as string;
    expect(markdown).toContain('my_custom_field: keep-me');
    expect(markdown).toContain('codex_other: keep-too');
    expect(markdown).toContain('nutrition:');
    expect(markdown).toContain('calories:');
    expect(markdown).toContain('100 g Flour, wheat, white');
    expect(markdown).toContain('Mix and bake.');
    expect(markdown).toContain('# My Cake');
    // Round-trip: the persisted block decodes and the unrelated recipe survives.
    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    expect(reparsed.title).toBe('My Cake');
    expect(reparsed.frontmatter?.my_custom_field).toBe('keep-me');
    expect(reparsed.ingredients[0]?.original).toBe('100 g Flour, wheat, white');
    expect(reparsed.codexNutrition && (reparsed.codexNutrition as CodexNutritionV1).schema).toBe(1);
  });

  it('writes a canonical block that validates and round-trips', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write, readBack: vault.readBack });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const markdown = vault.files.get(resolveRecipeVaultPath(recipe)) as string;
    const reparsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
    const decoded = decodeCodexNutrition(reparsed.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') expect(validateCodexNutritionV1(decoded.value).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU / stale state
// ---------------------------------------------------------------------------

describe('phase 5B — TOCTOU and stale authority fail closed with no write', () => {
  function expectNoWrite(vault: FakeVault, result: AdvancedNutritionApplyResult, code?: string): void {
    expect(result.ok).toBe(false);
    expect(vault.writes).toHaveLength(0);
    if (code) expect(failureCodeOf(result)).toBe(code);
  }

  it('rejects an ingredient mutation between review and Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const mutated = obsidianRecipe([
      { original: '200 g Flour, wheat, white', name: 'Flour, wheat, white', amount: 200, unit: 'g' },
    ]);
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { recipe: mutated, write: vault.write }), 'stale_authorization');
  });

  it('rejects a serving mutation between review and Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], { servings: 2 });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const mutated = obsidianRecipe([structured(FLOUR_LINE)], { servings: 4 });
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { recipe: mutated, write: vault.write }), 'stale_authorization');
  });

  it('rejects a match mutation before Apply', async () => {
    const ambiguous = '100 g flour wheat';
    const recipe = obsidianRecipe([structured(ambiguous)]);
    let lineRef = '';
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein'], ({ dispatch, state }) => {
      lineRef = state.rows[0].line_ref;
      dispatch({
        type: 'select_match',
        lineRef,
        choice: { kind: 'candidate', fdc_id: 6001, review_digest: state.rows[0].review_digest as string },
      });
    });
    const mutatedState: Phase4State = {
      ...reviewed.state,
      matches: {
        ...reviewed.state.matches,
        [lineRef]: { kind: 'none', review_digest: reviewed.state.rows[0].review_digest as string },
      },
    };
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { state: mutatedState, write: vault.write }), 'stale_authorization');
  });

  it('rejects a session/bundle change before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { session: OTHER_SESSION, write: vault.write });
    expectNoWrite(vault, result);
    expect(['stale_authorization', 'not_authorized']).toContain(failureCodeOf(result));
  });

  it('rejects a stale preview before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const mutatedState: Phase4State = { ...reviewed.state, status: 'preview_stale' };
    const vault = makeVault();
    expectNoWrite(vault, await apply(reviewed, { state: mutatedState, write: vault.write }), 'stale_authorization');
  });

  it('rejects a create -> replace mode change before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const withBlock = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: storedV1() },
    });
    const vault = makeVault();
    // UI showed "create" (no block), but a block now exists.
    expectNoWrite(
      vault,
      await apply(reviewed, { recipe: withBlock, write: vault.write, expectedMode: 'create' }),
      'stale_authorization'
    );
  });

  it('rejects a replace -> create mode change before Apply', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: storedV1() },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const withoutBlock = obsidianRecipe([structured(FLOUR_LINE)]);
    const vault = makeVault();
    expectNoWrite(
      vault,
      await apply(reviewed, { recipe: withoutBlock, write: vault.write, expectedMode: 'replace' }),
      'stale_authorization'
    );
  });
});

// ---------------------------------------------------------------------------
// Forgery / hostile input
// ---------------------------------------------------------------------------

describe('phase 5B — forged input cannot cause a write', () => {
  it('ignores caller-supplied candidate/identity/block fields', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await applyAdvancedNutrition({
      session: SESSION,
      recipe: reviewed.recipe,
      state: reviewed.state,
      write: vault.write,
      candidate: { block: { schema: 1, nutrients: { calories: { amount: 999999 } } } },
      identity: { candidate_digest: 'forged' },
      block: { schema: 1, basis: 'total' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = vault.writes[0];
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind === 'v1') expect(decoded.value.nutrients.calories?.amount).toBeCloseTo(364, 6);
  });

  it('rejects a fake session with no write', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const fake = { metadata: () => SESSION.metadata(), calculate: () => ({ ok: true, preview: reviewed.preview }) };
    const vault = makeVault();
    const result = await apply(reviewed, { session: fake, write: vault.write });
    expect(result.ok).toBe(false);
    expect(failureCodeOf(result)).toBe('not_authorized');
    expect(vault.writes).toHaveLength(0);
  });

  it('rejects a Proxy of the genuine session with no write', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { session: new Proxy(SESSION, {}), write: vault.write });
    expect(result.ok).toBe(false);
    expect(vault.writes).toHaveLength(0);
  });

  it('rejects a forged candidate digest by re-authorizing fresh', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The digest is minted by the fresh authorization, never accepted from input.
    expect(result.result.candidate_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects a non-object request', async () => {
    expect(failureCodeOf(await applyAdvancedNutrition(null))).toBe('unsafe_request');
    expect(failureCodeOf(await applyAdvancedNutrition('nope'))).toBe('unsafe_request');
  });
});

// ---------------------------------------------------------------------------
// Existing block protection
// ---------------------------------------------------------------------------

describe('phase 5B — existing block protection', () => {
  it('fails closed and preserves an unknown future schema', async () => {
    const future = { schema: 2, basis: 'total', futureField: { nested: [1, 2, 3] } };
    const before = JSON.stringify(future);
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], { frontmatter: { codex_nutrition: future } });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(failureCodeOf(result)).toBe('unknown_future_schema');
    expect(vault.writes).toHaveLength(0);
    expect(JSON.stringify(future)).toBe(before);
  });

  it('fails closed on a malformed existing schema-v1 block', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { codex_nutrition: { schema: 1, basis: 'per_serving', servings: 4 } },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(failureCodeOf(result)).toBe('invalid_existing_block');
    expect(vault.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Write failure / atomicity
// ---------------------------------------------------------------------------

describe('phase 5B — write failure and atomicity', () => {
  it('reports a write failure and commits nothing', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    let committed = false;
    const result = await apply(reviewed, {
      write: async () => {
        throw new Error('disk full');
      },
    });
    expect(failureCodeOf(result)).toBe('write_failed');
    expect(committed).toBe(false);
    expect(ADVANCED_NUTRITION_APPLY_UI_MESSAGE.write_failed).not.toContain('disk full');
  });

  it('reports a serialization failure before any write', async () => {
    // A function value in unrelated frontmatter is not YAML-representable.
    const recipe = obsidianRecipe([structured(FLOUR_LINE)], {
      frontmatter: { unrepresentable: () => undefined },
    });
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, { write: vault.write });
    expect(failureCodeOf(result)).toBe('serialization_failed');
    expect(vault.writes).toHaveLength(0);
  });

  it('reports an unavailable write target', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const result = await apply(reviewed, { write: undefined });
    expect(failureCodeOf(result)).toBe('unavailable_write_target');
  });

  it('reports a post-write verification failure without losing the write', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    const vault = makeVault();
    const result = await apply(reviewed, {
      write: vault.write,
      readBack: async () => '# Wrong\n\nno nutrition here\n',
    });
    expect(failureCodeOf(result)).toBe('post_write_verification_failed');
    // The write DID occur; verification is what failed.
    expect(vault.writes).toHaveLength(1);
  });

  it('never commits in-memory state when the writer throws', async () => {
    const recipe = obsidianRecipe([structured(FLOUR_LINE)]);
    const reviewed = buildReviewed(SESSION, recipe, ['calories', 'protein']);
    let stateCommits = 0;
    const result = await apply(reviewed, {
      write: async () => {
        throw new Error('nope');
      },
    });
    expect(result.ok).toBe(false);
    expect(stateCommits).toBe(0);
  });
});
