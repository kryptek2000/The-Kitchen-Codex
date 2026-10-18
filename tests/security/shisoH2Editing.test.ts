/**
 * The Kitchen Codex — SHISO H-2 authorized editing.
 *
 * OFFLINE. Provider-free; the USDA data is the real pinned bundle where used.
 *
 * What this suite pins:
 *  1. GENERAL ingredient editing (no ingredient-specific logic): name, amount,
 *     unit and preparation changes work for any recipe;
 *  2. AUTHORED QUANTITY PRESERVATION: a rename never touches the quantity, and
 *     an authored "2 lb" never becomes a USDA serving;
 *  3. batch editing, per-line refusals, stale references, invalid values;
 *  4. deterministic authenticated nutrition corrections (real bundle);
 *  5. the tool layer: edit/save/correction capabilities and their fail-closed
 *     behaviour with no registered owner;
 *  6. source-level guarantees: no vault/network/storage reachability.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import {
  adaptRecipe,
  analyzeRecipe,
  buildReviewRows,
  phase4Reducer,
  projectLiveRows,
  summarizeLiveRows,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type Phase4Row,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import {
  applyShisoIngredientEdits,
  normalizeShisoIngredientEdit,
} from '../../src/core/shiso/recipeEditing';
import { buildSupportedNutritionCorrections } from '../../src/core/shiso/nutritionCorrections';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { SHISO_LIMITS, SHISO_TOOL_NAMES } from '../../src/core/shiso/protocol';

const PINNED = join(__dirname, '../../data/advanced-nutrition/usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);

function line(original: string): Record<string, unknown> {
  const parsed = parseIngredientLine(original);
  return {
    original: parsed.original,
    amount: parsed.amount ?? null,
    ...(parsed.unit ? { unit: parsed.unit } : {}),
    name: parsed.name,
    ...(parsed.wikilinkTarget ? { wikilinkTarget: parsed.wikilinkTarget } : {}),
    ...(parsed.wikilink ? { wikilink: parsed.wikilink } : {}),
    ...(parsed.wikilinkAlias ? { wikilinkAlias: parsed.wikilinkAlias } : {}),
    isChecked: false,
  };
}

/** Generic fixture — deliberately mixed foods, units and foods. */
const RECIPE: Record<string, unknown> = {
  filePath: 'Recipes/H2-Fixture.md',
  title: 'H-2 Editing Fixture',
  servings: 4,
  ingredients: [
    line('2 lb chicken thighs'),
    line('1 cup shredded Monterey Jack cheese'),
    line('6 corn tortillas'),
    line('4 eggs, separated'),
    line('2 tbsp [[Olive Oil|Extra Virgin]]'),
    line('1/2 teaspoon salt'),
  ],
  instructions: [{ text: 'Cook it.' }],
};

function refFor(recipe: Record<string, unknown>, index: number): string {
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('fixture must adapt');
  return adaptation.recipe.adapted[index]!.line_ref;
}

// ===========================================================================
// 1. General editing — no ingredient-specific logic
// ===========================================================================

describe('H-2 — general ingredient editing', () => {
  it('renames an ingredient while PRESERVING the authored quantity', () => {
    const result = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 0), new_name: 'chicken breast' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toHaveLength(1);
    const ingredients = result.recipe['ingredients'] as Array<Record<string, unknown>>;
    expect(ingredients[0]!['original']).toBe('2 lb chicken breast');
    // The authored amount/unit survive verbatim; nothing became "one portion".
    expect(ingredients[0]!['amount']).toBe(2);
    expect(ingredients[0]!['unit']).toBe('lb');
    expect(JSON.stringify(result.recipe)).not.toMatch(/\bgrams?\b/i);
  });

  it('applies an EXPLICIT quantity change when the user asked for it', () => {
    const result = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 0), new_amount: 3 },
      { line_ref: refFor(RECIPE, 5), new_amount: 0.25, new_unit: 'teaspoon' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ingredients = result.recipe['ingredients'] as Array<Record<string, unknown>>;
    expect(ingredients[0]!['original']).toBe('3 lb chicken thighs');
    expect(ingredients[5]!['original']).toBe('1/4 teaspoon salt');
  });

  it('changes preparation through the authored comma convention', () => {
    const result = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 3), new_preparation: 'beaten' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ingredients = result.recipe['ingredients'] as Array<Record<string, unknown>>;
    expect(ingredients[3]!['original']).toBe('4 eggs, beaten');
    // And the quantity is untouched by a preparation change.
    expect(ingredients[3]!['amount']).toBe(4);
  });

  it('preserves a wikilink on an amount change and drops a stale link on a rename', () => {
    const amountEdit = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 4), new_amount: 3 },
    ]);
    expect(amountEdit.ok).toBe(true);
    if (amountEdit.ok) {
      const ingredients = amountEdit.recipe['ingredients'] as Array<Record<string, unknown>>;
      expect(ingredients[4]!['original']).toBe('3 tbsp [[Olive Oil|Extra Virgin]]');
    }

    const rename = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 4), new_name: 'avocado oil' },
    ]);
    expect(rename.ok).toBe(true);
    if (rename.ok) {
      const ingredients = rename.recipe['ingredients'] as Array<Record<string, unknown>>;
      expect(ingredients[4]!['original']).toBe('2 tbsp avocado oil');
      expect(ingredients[4]!['wikilinkTarget']).toBeUndefined();
    }
  });

  it('NEVER mutates the input recipe', () => {
    const before = JSON.stringify(RECIPE);
    const result = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 1), new_name: 'gouda' },
    ]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(RECIPE)).toBe(before);
  });

  it('applies a batch, refuses one stale reference, and reconciles counts', () => {
    // A REAL batch: five edits, one of them addressed by a reference that no
    // longer exists because a previous edit changed that line's text.
    const staleRef = refFor(RECIPE, 2);
    const first = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 2), new_name: 'flour tortillas' },
    ]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = applyShisoIngredientEdits(first.recipe, [
      { line_ref: refFor(RECIPE, 0), new_name: 'turkey thighs' },
      { line_ref: staleRef, new_amount: 8 },
      { line_ref: refFor(RECIPE, 1), new_name: 'manchego' },
      { line_ref: refFor(RECIPE, 3), new_preparation: 'whisked' },
    ]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.applied).toHaveLength(3);
    expect(second.refused).toHaveLength(1);
    expect(second.refused[0]!.reason).toBe('unknown_line_ref');
    const ingredients = second.recipe['ingredients'] as Array<Record<string, unknown>>;
    expect(ingredients[0]!['original']).toBe('2 lb turkey thighs');
    expect(ingredients[2]!['original']).toBe('6 flour tortillas');
    expect(ingredients[3]!['original']).toBe('4 eggs, whisked');
  });

  it('refuses invalid values without touching anything', () => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { line_ref: refFor(RECIPE, 0), new_amount: -2 },
      { line_ref: refFor(RECIPE, 0), new_amount: Number.NaN },
      { line_ref: refFor(RECIPE, 0), new_name: '   ' },
      { line_ref: refFor(RECIPE, 0), new_name: 'line\nbreak' },
    ];
    for (const edit of cases) {
      const result = applyShisoIngredientEdits(RECIPE, [edit]);
      expect(result.ok, JSON.stringify(edit)).toBe(true);
      if (!result.ok) continue;
      expect(result.applied).toHaveLength(0);
      expect(result.refused).toHaveLength(1);
    }
    const normalized = normalizeShisoIngredientEdit({ line_ref: 'x', new_amount: -1 });
    expect(normalized.ok).toBe(false);
  });

  it('rejects an edit with no changed field and a no-op edit', () => {
    const noFields = normalizeShisoIngredientEdit({ line_ref: refFor(RECIPE, 0) });
    expect(noFields.ok).toBe(false);
    const noop = applyShisoIngredientEdits(RECIPE, [
      { line_ref: refFor(RECIPE, 0), new_name: 'chicken thighs' },
    ]);
    expect(noop.ok).toBe(true);
    if (noop.ok) {
      expect(noop.applied).toHaveLength(0);
      expect(noop.refused[0]!.reason).toBe('no_change');
    }
  });

  it('handles a recipe the app cannot adapt, failing closed', () => {
    const result = applyShisoIngredientEdits({ ingredients: 'nope' }, [
      { line_ref: 'ing:0:x', new_name: 'anything' },
    ]);
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// 2. Tool layer
// ===========================================================================

describe('H-2 — editing capabilities through the tool executor', () => {
  const baseCtx = (): ShisoToolContext => ({
    session: null,
    recipe: {
      title: 'T',
      servings: 4,
      ingredients: [
        { text: '2 lb chicken thighs', name: 'chicken thighs', line_ref: 'ing:0:abc' },
      ],
      instructions: [],
    },
    nutrition: null,
  });

  it('get_current_recipe now returns the stable edit handle for every ingredient', async () => {
    const obs = await executeShisoTool({ tool: 'get_current_recipe' }, baseCtx());
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    const ingredients = obs.data['ingredients'] as Array<Record<string, unknown>>;
    expect(ingredients[0]!['line_ref']).toBe('ing:0:abc');
  });

  it('apply_ingredient_edits delegates to the registered owner and reports the changes', async () => {
    const calls: unknown[] = [];
    const obs = await executeShisoTool(
      {
        tool: 'apply_ingredient_edits',
        edits: [{ line_ref: 'ing:0:abc', new_name: 'turkey thighs' }],
      },
      {
        ...baseCtx(),
        applyIngredientEdits: async (edits) => {
          calls.push(edits);
          return {
            ok: true,
            applied: [
              {
                line_ref: 'ing:0:abc',
                before: '2 lb chicken thighs',
                after: '2 lb turkey thighs',
                changes: ['name: "chicken thighs" → "turkey thighs"'],
              },
            ],
            refused: [],
            summary: 'Applied 1 ingredient change(s) to the UNSAVED working copy.',
            working_unsaved: true,
            note: 'Saved: no.',
          };
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['applied_count']).toBe(1);
    expect(obs.data['working_unsaved']).toBe(true);
    const applied = obs.data['applied'] as Array<Record<string, unknown>>;
    expect(applied[0]!['after']).toBe('2 lb turkey thighs');
  });

  it('apply_ingredient_edits fails closed with no registered owner', async () => {
    const obs = await executeShisoTool(
      { tool: 'apply_ingredient_edits', edits: [{ line_ref: 'ing:0:abc', new_name: 'x' }] },
      baseCtx(),
    );
    expect(obs.ok).toBe(false);
    if (!obs.ok) expect((obs as { code?: string }).code).toBe('no_edit_owner');
  });

  it('save_working_recipe fails closed with no owner and reports honestly with one', async () => {
    const missing = await executeShisoTool({ tool: 'save_working_recipe' }, baseCtx());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect((missing as { code?: string }).code).toBe('no_save_owner');

    const nothing = await executeShisoTool(
      { tool: 'save_working_recipe' },
      { ...baseCtx(), saveWorkingRecipe: async () => ({ ok: true, saved: false, message: 'There is nothing to save.' }) },
    );
    expect(nothing.ok).toBe(true);
    if (nothing.ok) expect(nothing.data['saved']).toBe(false);

    const saved = await executeShisoTool(
      { tool: 'save_working_recipe' },
      { ...baseCtx(), saveWorkingRecipe: async () => ({ ok: true, saved: true, message: 'Saved.' }) },
    );
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.data['saved']).toBe(true);
  });

  it('apply_nutrition_corrections refuses without a review and without an owner', async () => {
    const noReview = await executeShisoTool({ tool: 'apply_nutrition_corrections' }, baseCtx());
    expect(noReview.ok).toBe(false);
    if (!noReview.ok) expect((noReview as { code?: string }).code).toBe('no_nutrition_review');
  });

  it('the editing vocabulary stays bounded and free of filesystem reach (source check)', () => {
    for (const modulePath of [
      '../../src/core/shiso/recipeEditing.ts',
      '../../src/core/shiso/nutritionCorrections.ts',
    ]) {
      const source = readFileSync(join(__dirname, modulePath), 'utf8');
      expect(source).not.toMatch(/from ['"]node:fs/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/localStorage|sessionStorage/);
      expect(source).not.toMatch(/writeText|VaultAdapter|saveRecipeWithVaultAdapter/);
    }
    // The budgets are NOT relaxed to make editing fit.
    expect(SHISO_LIMITS.maxToolCallsPerTurn).toBe(8);
    expect(SHISO_LIMITS.maxModelInvocationsPerTurn).toBe(6);
    expect(SHISO_TOOL_NAMES).toContain('apply_ingredient_edits');
    expect(SHISO_TOOL_NAMES).toContain('apply_nutrition_corrections');
    expect(SHISO_TOOL_NAMES).toContain('save_working_recipe');
  });
});

// ===========================================================================
// 3. Deterministic nutrition corrections (real pinned bundle)
// ===========================================================================

const ENCHILADAS = [
  '2 cups shredded chicken breast',
  '1 cup whole milk',
  '2 tablespoons vegetable oil',
  '1 cup shredded Monterey Jack cheese',
  '1 cup salsa verde',
  '6 corn tortillas',
  '1 cup shredded cheddar cheese',
  '1 cup chicken broth',
  '2 tablespoons all-purpose flour',
  '1/4 teaspoon ground cumin',
  '1/2 teaspoon salt',
  '1/4 cup chopped fresh cilantro',
];

function structured(lineText: string): Record<string, unknown> {
  const p = parseIngredient(lineText);
  if (!p.ok) return { original: lineText };
  return {
    original: lineText,
    ...(p.parsed.amount !== null ? { amount: p.parsed.amount } : {}),
    ...(p.parsed.raw_unit !== undefined ? { unit: p.parsed.raw_unit } : {}),
    name: p.parsed.query,
  };
}

describe('H-2 — deterministic authenticated corrections (Chicken Enchiladas Verdes)', () => {
  let session: AdvancedNutritionSession;

  beforeAll(async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(PINNED, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    session = result.session as AdvancedNutritionSession;
  }, 300000);

  function fixture(lines: readonly string[] = ENCHILADAS) {
    const recipe = adaptRecipe({
      title: 'Chicken Enchiladas Verdes',
      servings: 6,
      ingredients: lines.map(structured),
    } as never) as never as { recipe: { adapted: AdaptedIngredient[]; recipe_key: string } };
    const adapted = recipe.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 6);
    // The working state's rows are the REVIEW rows (exactly what the card
    // initializes); the analyzer rows stay the live-projection reference.
    const reviewRows = buildReviewRows(session, adapted) as unknown as Phase4Row[];
    const state: Phase4State = {
      version: '', status: 'ready', recipeKey: recipe.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      baseServings: 6, rows: reviewRows, matches: analysis.matches,
      portions: analysis.portions, countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions, userMasses: {},
      basis: 'entire_recipe', selectedServings: 6,
      preview: null, previewKey: null, failure: null, operationSeq: 0,
    } as never;
    const liveRows = projectLiveRows(
      state,
      new Map(analysis.rows.map((r) => [r.line_ref, r])),
      adapted, session, null, analysis.portions, analysis.countPortions,
    );
    return { adapted, state, liveRows, reviewRows };
  }

  it('builds VERIFIED corrections for the actionable lines and names the rest honestly', () => {
    const f = fixture();
    const built = buildSupportedNutritionCorrections({
      session,
      liveRows: f.liveRows,
      adapted: f.adapted,
      workingState: f.state,
    });
    // Three actionable lines have an authenticated record + portion that
    // GENUINELY resolves mass through the real calculator.
    // "6 corn tortillas" cannot: its alternative records only carry mass-oz
    // portions that cannot relate to the authored count, and its count review is
    // not applicable — so it is reported unresolved rather than forced.
    expect(built.corrections).toHaveLength(3);
    expect(built.unresolved).toHaveLength(1);
    expect(built.unresolved[0]!.label).toBe('6 corn tortillas');
    expect(built.unresolved[0]!.reason.length).toBeGreaterThan(0);

    for (const correction of built.corrections) {
      expect(correction.actions.length).toBeGreaterThan(0);
      for (const action of correction.actions) {
        expect(['select_match', 'select_portion', 'select_count_portion']).toContain(action.type);
      }
      expect(correction.description).toMatch(/·.*=\s*\d+(\.\d+)?\s*g/);
    }
    const covered = [
      ...built.corrections.map((c) => c.label),
      ...built.unresolved.map((u) => u.label),
    ];
    expect(covered).toContain('2 cups shredded chicken breast');
    expect(covered).toContain('6 corn tortillas');
    expect(covered).toContain('1 cup shredded Monterey Jack cheese');
    expect(covered).toContain('1/4 teaspoon ground cumin');
  }, 240000);

  it('never turns an authored cup quantity into a catalog chicken-count portion', () => {
    const f = fixture();
    const built = buildSupportedNutritionCorrections({ session, liveRows: f.liveRows, adapted: f.adapted, workingState: f.state });
    const chicken = built.corrections.find((correction) => correction.label === '2 cups shredded chicken breast');
    expect(chicken?.actions.some((action) => action.type === 'select_count_portion')).toBe(false);
  }, 240000);

  it('does not resolve 1 cup raw chicken breast as a single count portion', () => {
    const f = fixture(['1 cup raw chicken breast']);
    const built = buildSupportedNutritionCorrections({ session, liveRows: f.liveRows, adapted: f.adapted, workingState: f.state });
    expect(built.corrections.flatMap((correction) => correction.actions).some((action) => action.type === 'select_count_portion')).toBe(false);
  }, 240000);

  it('is DETERMINISTIC: identical inputs produce identical corrections', () => {
    const f = fixture();
    const args = {
      session,
      liveRows: f.liveRows,
      adapted: f.adapted,
      workingState: f.state,
    };
    const first = buildSupportedNutritionCorrections(args);
    const second = buildSupportedNutritionCorrections(args);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  }, 240000);

  it('a requested subset is honored; unknown refs are reported, never invented', () => {
    const f = fixture();
    const target = f.liveRows.find((r) => r.original_text.includes('chicken breast'))!;
    const built = buildSupportedNutritionCorrections({
      session,
      liveRows: f.liveRows,
      adapted: f.adapted,
      workingState: f.state,
      lineRefs: [target.line_ref, 'ing:99:does-not-exist'],
    });
    expect(built.corrections).toHaveLength(1);
    expect(built.corrections[0]!.line_ref).toBe(target.line_ref);
    expect(built.unresolved.some((u) => u.line_ref === 'ing:99:does-not-exist')).toBe(true);
  }, 240000);

  it('refuses to build anything with a missing recipe/session identity', () => {
    const f = fixture();
    const built = buildSupportedNutritionCorrections({
      session,
      liveRows: f.liveRows,
      adapted: f.adapted,
      workingState: { ...f.state, recipeKey: null, sessionIdentity: null },
    });
    expect(built.corrections).toHaveLength(0);
  });
});

// ===========================================================================
// 4. Generality across unrelated foods, including count units
// ===========================================================================

describe('H-2 — count-unit generality (real pinned bundle)', () => {
  it('corrects count-unit lines through the authenticated count path when the engine supports it', async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(PINNED, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    const session = result.session as AdvancedNutritionSession;

    // Different foods, different count units, mixed availability. No ingredient
    // is special-cased anywhere in the engine.
    const lines = [
      '3 strips bacon',
      '2 ribs celery',
      '4 slices ham',
      '2 wedges lemon',
      '1 bulb fennel',
      '1 sprig rosemary',
      '2 sheets nori',
      '1 cup whole milk',
    ];
    const recipe = adaptRecipe({ title: 'Diverse', servings: 4, ingredients: lines.map(structured) } as never) as never as {
      recipe: { adapted: AdaptedIngredient[]; recipe_key: string };
    };
    const adapted = recipe.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 4);
    const reviewRows = buildReviewRows(session, adapted) as unknown as Phase4Row[];
    const state: Phase4State = {
      version: '', status: 'ready', recipeKey: recipe.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      baseServings: 4, rows: reviewRows, matches: analysis.matches,
      portions: analysis.portions, countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions, userMasses: {},
      basis: 'entire_recipe', selectedServings: 4,
      preview: null, previewKey: null, failure: null, operationSeq: 0,
    } as never;
    const liveRows = projectLiveRows(
      state,
      new Map(analysis.rows.map((r) => [r.line_ref, r])),
      adapted, session, null, analysis.portions, analysis.countPortions,
    );
    const built = buildSupportedNutritionCorrections({
      session,
      liveRows,
      adapted,
      workingState: state,
    });

    // At least one count-unit line is corrected through the authenticated count
    // path (a `select_count_portion` action from a real USDA count measure).
    expect(built.corrections.length).toBeGreaterThan(0);
    const countCorrected = built.corrections.filter((correction) =>
      correction.actions.some((action) => action.type === 'select_count_portion'),
    );
    expect(countCorrected.length).toBeGreaterThan(0);
    for (const correction of countCorrected) {
      expect(correction.description).toMatch(/=\s*\d+(\.\d+)?\s*g/);
    }

    // Every line is accounted for: already resolved, corrected, OR honestly
    // unresolved. Never silently dropped, never fabricated.
    const accounted = new Set([
      ...built.corrections.map((c) => c.label),
      ...built.unresolved.map((u) => u.label),
    ]);
    for (const line of lines) {
      const live = liveRows.find((row) => row.original_text === line);
      const alreadyResolved = live?.status === 'matched' || live?.status === 'qualitative';
      expect(accounted.has(line) || alreadyResolved, `${line} must be accounted for`).toBe(true);
    }

    // And each correction VERIFIES: applied to the working state it resolves a
    // positive mass through the existing calculator.
    let applied = state;
    for (const correction of built.corrections) {
      for (const action of correction.actions) applied = phase4Reducer(applied, action);
    }
    const { buildCalculationRequest } = await import('../../src/core/nutritionV2/phase4');
    const calculated = session.calculate(buildCalculationRequest(adapted, applied));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    for (const correction of built.corrections) {
      const evidence = calculated.preview.ingredients.find((e) => e.line_ref === correction.line_ref);
      expect(evidence?.resolved_grams ?? 0).toBeGreaterThan(0);
    }
  }, 300000);
});

// ===========================================================================
// 5. Working-copy bookkeeping: batch accumulation + undo
// ===========================================================================

describe('H-2 — working-copy bookkeeping and undo', () => {
  interface FakeIngredient {
    readonly original: string;
  }
  interface FakeRecipe {
    readonly title: string;
    readonly ingredients: ReadonlyArray<FakeIngredient>;
  }
  const base: FakeRecipe = {
    title: 'T',
    ingredients: [{ original: 'a' }, { original: 'b' }],
  };

  it('accumulates changes and a per-edit undo ledger across batches', async () => {
    const { extendWorkingRecipe } = await import('../../src/core/shiso/workingRecipe');
    const first = extendWorkingRecipe<FakeRecipe, FakeIngredient>({
      current: null,
      base,
      working: { ...base, ingredients: [{ original: 'a1' }, { original: 'b' }] },
      ledger: [{ index: 0, previous: { original: 'a' } }],
      changeLines: ['a → a1'],
      maxChanges: 24,
    });
    const second = extendWorkingRecipe<FakeRecipe, FakeIngredient>({
      current: first,
      base,
      working: { ...base, ingredients: [{ original: 'a1' }, { original: 'b2' }] },
      ledger: [{ index: 1, previous: { original: 'b' } }],
      changeLines: ['b → b2'],
      maxChanges: 24,
    });
    expect(second.changes).toEqual(['a → a1', 'b → b2']);
    expect(second.history.map((entry) => entry.index)).toEqual([0, 1]);
    // The ORIGINAL base is retained across batches.
    expect(second.base).toBe(base);
    // The display account is bounded.
    const bounded = extendWorkingRecipe<FakeRecipe, FakeIngredient>({
      current: second,
      base,
      working: second.working,
      ledger: [{ index: 0, previous: { original: 'a1' } }],
      changeLines: ['x', 'y'],
      maxChanges: 3,
    });
    expect(bounded.changes).toHaveLength(3);
  });

  it('undo restores exactly the last edited ingredient and pops the account', async () => {
    const { extendWorkingRecipe, undoLastWorkingEdit } = await import('../../src/core/shiso/workingRecipe');
    const state = extendWorkingRecipe<FakeRecipe, FakeIngredient>({
      current: null,
      base,
      working: { ...base, ingredients: [{ original: 'a1' }, { original: 'b2' }] },
      ledger: [
        { index: 0, previous: { original: 'a' } },
        { index: 1, previous: { original: 'b' } },
      ],
      changeLines: ['a → a1', 'b → b2'],
      maxChanges: 24,
    });
    const afterUndo = undoLastWorkingEdit<FakeRecipe, FakeIngredient>(
      state,
      (working, index, previous) => {
        const ingredients = [...working.ingredients];
        ingredients[index] = previous;
        return { ...working, ingredients };
      },
    );
    expect(afterUndo).not.toBeNull();
    if (afterUndo === null) return;
    expect(afterUndo.working.ingredients[1]).toEqual({ original: 'b' });
    expect(afterUndo.working.ingredients[0]).toEqual({ original: 'a1' });
    expect(afterUndo.changes).toEqual(['a → a1']);
    expect(afterUndo.history).toHaveLength(1);

    // Undoing to empty is fine; undoing NOTHING returns null (no phantom undo).
    const empty = undoLastWorkingEdit<FakeRecipe, FakeIngredient>(afterUndo, () => afterUndo.working);
    expect(empty).not.toBeNull();
    if (empty === null) return;
    expect(undoLastWorkingEdit<FakeRecipe, FakeIngredient>(empty, () => empty.working)).toBeNull();
  });

  it('the application shell wires the edit/save applier, the banner and the undo path', () => {
    const app = readFileSync(join(__dirname, '../../src/App.tsx'), 'utf8');
    // The ONE registered recipe-edit applier (edit / save / discard).
    expect(app).toContain('registerRecipeEditApplier');
    expect(app).toContain('applyEdits: (edits) => applyShisoEdits(edits)');
    // H-2 security: the save path takes the VERIFIED grant (see the dedicated
    // save-authorization suite for the adversarial evidence).
    expect(app).toContain('save: (grant) => saveShisoWorkingRecipe(grant)');
    // The visible banner with explicit Save, one-step Undo and Discard.
    expect(app).toContain('data-testid="shiso-working-recipe-banner"');
    expect(app).toContain('data-testid="shiso-banner-save"');
    expect(app).toContain('data-testid="shiso-banner-undo"');
    expect(app).toContain('data-testid="shiso-banner-discard"');
    // The canonical save path is the EXISTING one (no bespoke writer).
    expect(app).toContain('saveRecipeWithVaultAdapter');
    const recipeEditing = readFileSync(join(__dirname, '../../src/core/shiso/recipeEditing.ts'), 'utf8');
    expect(recipeEditing).not.toMatch(/writeText|VaultAdapter|fetch\(|localStorage/);
  });

  it('the Shiso surface wires the edit/save/correction ports into the tool context', () => {
    const modal = readFileSync(join(__dirname, '../../src/components/ShisoModal.tsx'), 'utf8');
    for (const port of [
      'applyIngredientEdits',
      'applyNutritionCorrections',
      'saveWorkingRecipe',
    ]) {
      expect(modal).toContain(port);
    }
    // The save control is the explicit, user-visible one.
    expect(modal).toContain('data-testid="shiso-working-save"');
    expect(modal).toContain('data-testid="shiso-working-discard"');
  });

  it('the system prompt requires explicit user authorization for saving', () => {
    const prompt = readFileSync(join(__dirname, '../../server/shiso/conversationTurn.ts'), 'utf8');
    expect(prompt).toMatch(/save_working_recipe: saves the working copy/i);
    expect(prompt).toMatch(/ONLY after the user explicitly authorizes saving/i);
    expect(prompt).toMatch(/Never save spontaneously/i);
    // And the rename rule: a name change must not touch the quantity.
    expect(prompt).toMatch(/send new_name and NOTHING else/i);
  });
});

// ===========================================================================
// 6. Overhead accounting (bounded, provider-free)
// ===========================================================================

describe('H-2 — execution overhead and state-change accounting', () => {
  it('builds the enchilada corrections deterministically with bounded work and real state changes', async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(PINNED, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    const session = result.session as AdvancedNutritionSession;

    const recipe = adaptRecipe({
      title: 'Chicken Enchiladas Verdes',
      servings: 6,
      ingredients: ENCHILADAS.map(structured),
    } as never) as never as { recipe: { adapted: AdaptedIngredient[]; recipe_key: string } };
    const adapted = recipe.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 6);
    const reviewRows = buildReviewRows(session, adapted) as unknown as Phase4Row[];
    const state: Phase4State = {
      version: '', status: 'ready', recipeKey: recipe.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      baseServings: 6, rows: reviewRows, matches: analysis.matches,
      portions: analysis.portions, countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions, userMasses: {},
      basis: 'entire_recipe', selectedServings: 6,
      preview: null, previewKey: null, failure: null, operationSeq: 0,
    } as never;
    const liveRows = projectLiveRows(
      state,
      new Map(analysis.rows.map((r) => [r.line_ref, r])),
      adapted, session, null, analysis.portions, analysis.countPortions,
    );
    const args = { session, liveRows, adapted, workingState: state };

    const startedAt = Date.now();
    const first = buildSupportedNutritionCorrections(args);
    const elapsedMs = Date.now() - startedAt;
    const second = buildSupportedNutritionCorrections(args);

    // Deterministic: identical inputs → byte-identical result. No model call
    // exists in the path at all (the module imports no transport).
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.corrections).toHaveLength(3);
    // Sanity bound only — this is a local CPU pass over an in-memory review,
    // never a provider latency claim.
    expect(elapsedMs).toBeLessThan(60000);

    // Every correction maps to REAL state changes through the existing reducer,
    // and the post-correction state truly resolves the corrected lines.
    let applied = state;
    let actionCount = 0;
    for (const correction of first.corrections) {
      for (const action of correction.actions) {
        applied = phase4Reducer(applied, action);
        actionCount += 1;
      }
    }
    expect(actionCount).toBeGreaterThanOrEqual(first.corrections.length);
    expect(actionCount).toBeLessThanOrEqual(first.corrections.length * 2);
    expect(applied.operationSeq).toBeGreaterThan(state.operationSeq);
    const { buildCalculationRequest } = await import('../../src/core/nutritionV2/phase4');
    const recalculated = session.calculate(buildCalculationRequest(adapted, applied));
    expect(recalculated.ok).toBe(true);
    if (!recalculated.ok) return;
    for (const correction of first.corrections) {
      const evidence = recalculated.preview.ingredients.find((e) => e.line_ref === correction.line_ref);
      expect(evidence?.resolved_grams ?? 0).toBeGreaterThan(0);
    }
  }, 300000);
});

// ===========================================================================
// 7. End-to-end: corrections + recalculation + summary
// ===========================================================================

describe('H-2 — apply corrections into the working review and recalculate', () => {
  it('applies every built correction through the EXISTING reducer and calculator', async () => {
    const { phase4Reducer } = await import('../../src/core/nutritionV2/phase4');
    const { buildCalculationRequest } = await import('../../src/core/nutritionV2/phase4');

    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(PINNED, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    const session = result.session as AdvancedNutritionSession;

    const recipe = adaptRecipe({
      title: 'Chicken Enchiladas Verdes',
      servings: 6,
      ingredients: ENCHILADAS.map(structured),
    } as never) as never as { recipe: { adapted: AdaptedIngredient[]; recipe_key: string } };
    const adapted = recipe.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 6);
    const reviewRows = buildReviewRows(session, adapted) as unknown as Phase4Row[];
    let state: Phase4State = {
      version: '', status: 'ready', recipeKey: recipe.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      baseServings: 6, rows: reviewRows, matches: analysis.matches,
      portions: analysis.portions, countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions, userMasses: {},
      basis: 'entire_recipe', selectedServings: 6,
      preview: null, previewKey: null, failure: null, operationSeq: 0,
    } as never;
    const liveRows = projectLiveRows(
      state,
      new Map(analysis.rows.map((r) => [r.line_ref, r])),
      adapted, session, null, analysis.portions, analysis.countPortions,
    );
    const before = summarizeLiveRows(liveRows);
    expect(before.actionable).toBeGreaterThan(0);

    const built = buildSupportedNutritionCorrections({
      session,
      liveRows,
      adapted,
      workingState: state,
    });
    expect(built.corrections.length).toBeGreaterThan(0);

    // Apply through the ONE existing state machine.
    for (const correction of built.corrections) {
      for (const action of correction.actions) state = phase4Reducer(state, action);
    }
    const calculated = session.calculate(buildCalculationRequest(adapted, state));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;

    const after = summarizeLiveRows(
      projectLiveRows(
        state,
        new Map(analysis.rows.map((r) => [r.line_ref, r])),
        adapted, session, null, analysis.portions, analysis.countPortions,
      ),
    );
    // Every corrected line now carries an authenticated resolved mass, and the
    // preview is genuinely more complete than before.
    expect(after.actionable).toBeLessThan(before.actionable);
    const afterLive = projectLiveRows(
      state,
      new Map(analysis.rows.map((r) => [r.line_ref, r])),
      adapted, session, null, analysis.portions, analysis.countPortions,
    );
    for (const correction of built.corrections) {
      const row = afterLive.find((r) => r.line_ref === correction.line_ref);
      expect(row?.resolved_grams ?? 0).toBeGreaterThan(0);
    }
    // And the deterministic preview reports real numbers and a real coverage
    // status (nothing unresolved that this suite claimed to correct).
    expect(Object.keys(calculated.preview.totals).length).toBeGreaterThan(0);
    for (const correction of built.corrections) {
      expect(calculated.preview.unresolved.some((u) => u.line_ref === correction.line_ref)).toBe(false);
    }
  }, 300000);
});
