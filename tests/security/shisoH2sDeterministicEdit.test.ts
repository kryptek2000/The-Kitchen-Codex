/**
 * The Kitchen Codex — SHISO H-2S real ingredient-edit execution.
 *
 * OFFLINE. No provider calls, no vault writes.
 *
 * The human browser test failed with repeated empty-argument edit calls:
 *   "Change the 2 jalapeños to 3 jalapeños. Do not save."
 * never changed the recipe. These tests pin the repair through GENUINE
 * production pathways:
 *
 *   - the real markdown parser builds the recipe (no hand-shaped fixtures);
 *   - the real Shiso recipe view derives the line handles;
 *   - the real core editing engine + working-copy bookkeeping mutate the copy;
 *   - the real conversation turn loop runs (scripted transport, no model).
 *
 * They also pin the strict-schema argument handling (null = absent) and the
 * terminal repeated-failure stop.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';
import { toShisoRecipeView } from '../../src/application-ui/useShisoRecipeContext';
import { applyShisoIngredientEdits } from '../../src/core/shiso/recipeEditing';
import { extendWorkingRecipe } from '../../src/core/shiso/workingRecipe';
import { planDeterministicIngredientEdit } from '../../src/core/shiso/deterministicEdit';
import { classifySaveIntent } from '../../src/core/shiso/saveAuthorization';
import {
  initialShisoConversation,
  runShisoConversationTurn,
} from '../../src/application/shisoConversation';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { parseShisoDecision } from '../../server/shiso/conversationTurn';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';

beforeAll(async () => {
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
});

// ---------------------------------------------------------------------------
// Fixtures: GENUINE parsing, no hand-built ingredient objects
// ---------------------------------------------------------------------------

const ENCHILADAS_MD = `---
title: Chicken Enchiladas Verdes
servings: 6
category: Dinner
cuisine: Mexican
---

# Chicken Enchiladas Verdes

## 🥘 Ingredients
- [ ] 2 cups shredded chicken breast
- [ ] 1 cup whole milk
- [ ] 2 tablespoons vegetable oil
- [ ] 1 cup shredded Monterey Jack cheese
- [ ] 1 cup salsa verde
- [ ] 6 corn tortillas
- [ ] 1 cup shredded cheddar cheese
- [ ] 1 cup chicken broth
- [ ] 2 tablespoons all-purpose flour
- [ ] 1/4 teaspoon ground cumin
- [ ] 1/2 teaspoon salt
- [ ] 2 jalapeños

## 🍳 Instructions
1. Cook it.
`;

function parseRecipe(md: string, file = 'Recipes/Recipe.md') {
  return parseObsidianRecipeMarkdown(md, file.split('/').pop() as string, file);
}

/** The REAL application applier chain (the same pair App.tsx uses). */
function createRealApplier(initial: Record<string, unknown>) {
  let raw = initial;
  let working: ReturnType<typeof extendWorkingRecipe> | null = null;
  const applyCalls: number[] = [];
  const saveCalls: number[] = [];
  const applyEdits = async (edits: readonly unknown[]) => {
    applyCalls.push(edits.length);
    const result = applyShisoIngredientEdits(raw, edits);
    if (result.ok !== true) {
      const failure = result as { message?: string };
      return {
        ok: false,
        applied: [],
        refused: [],
        summary: failure.message ?? 'The edit could not be applied.',
        working_unsaved: false,
        note: '',
      };
    }
    working = extendWorkingRecipe({
      current: working as never,
      base: initial as never,
      working: result.recipe as never,
      ledger: result.ledger.map((entry) => ({ index: entry.index, previous: entry.previous })),
      changeLines: result.applied.map((entry) => `${entry.before} → ${entry.after}`),
      maxChanges: 24,
    }) as never;
    raw = result.recipe;
    return {
      ok: true,
      applied: result.applied,
      refused: result.refused,
      summary: result.summary,
      working_unsaved: true,
      note: 'Saved: no.',
    };
  };
  return {
    applyEdits,
    save: async () => {
      saveCalls.push(1);
      return { ok: true, saved: true, message: 'Saved.' };
    },
    applyCalls,
    saveCalls,
    raw: () => raw,
    working: () => working,
  };
}

function toolContextFor(
  recipe: Record<string, unknown>,
  applier: { applyEdits: (edits: readonly unknown[]) => Promise<unknown> },
): ShisoToolContext {
  const view = toShisoRecipeView(recipe as never);
  if (view === null) throw new Error('fixture view failed');
  return {
    session: null,
    recipe: view,
    nutrition: null,
    applyIngredientEdits: applier.applyEdits as never,
  };
}

const CONVERSATION_CONTEXT = {
  recipe: null,
  nutrition: {
    available: false,
    summary: null,
    unresolvedCount: 0,
    needsAmountCount: 0,
    needsMatchCount: 0,
    unsavedWorkingReview: false,
  },
  recipeKey: 'k1',
  sessionIdentity: 's1',
} as const;

/** A transport that records (and can force) provider traffic. */
function transport(script: unknown[] = []): { network: NetworkAdapter; calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  const network = {
    post: async (path: string) => {
      if (path !== '/api/shiso/turn') return { status: 404, ok: false, data: {} };
      calls.push(1);
      const entry = script[Math.min(index, script.length - 1)];
      index += 1;
      return { status: 200, ok: true, data: entry ?? { ok: true, kind: 'reply', text: 'ok', proposals: [], model_invocations_used: 1, tool_calls_used: 0 } };
    },
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
  return { network, calls };
}

// ===========================================================================
// 1. THE EXACT HUMAN SCENARIO
// ===========================================================================

describe('H-2S — the exact human scenario', () => {
  it('"Change the 2 jalapeños to 3 jalapeños. Do not save." mutates the working copy with ZERO provider calls', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const { network, calls } = transport(); // empty script: ANY provider call would be visible

    const startedAt = Date.now();
    const outcome = await runShisoConversationTurn(
      {
        network,
        context: CONVERSATION_CONTEXT as never,
        toolContext: toolContextFor(recipe, applier),
      },
      initialShisoConversation(),
      'Change the 2 jalapeños to 3 jalapeños. Do not save.',
    );
    const elapsedMs = Date.now() - startedAt;

    // PERFORMANCE: the deterministic path uses NO provider round trip at all,
    // one edit through the real authority, and completes as a local CPU pass
    // (the bound is a sanity ceiling, never a stub-latency claim).
    expect(calls).toHaveLength(0);
    expect(applier.applyCalls).toEqual([1]);
    expect(elapsedMs).toBeLessThan(5000);
    expect(outcome.ok).toBe(true);
    expect(outcome.toolsUsed).toEqual(['apply_ingredient_edits']);

    // GENUINE MUTATION through the real editing engine.
    const working = applier.raw();
    const lines = (working['ingredients'] as Array<{ original: string; name: string }>).map((i) => i.original);
    expect(lines).toHaveLength(12);
    expect(lines).toContain('3 jalapeños');
    expect(lines).not.toContain('2 jalapeños');
    // Every OTHER line is byte-identical to the parsed source recipe.
    const sourceLines = ((recipe['ingredients'] as Array<{ original: string }>)).map((i) => i.original);
    for (let index = 0; index < sourceLines.length; index += 1) {
      if (sourceLines[index] === '2 jalapeños') continue;
      expect(lines[index]).toBe(sourceLines[index]);
    }

    // The user is told the exact change and the unsaved status; no save occurred.
    expect(outcome.message).toContain('2 jalapeños');
    expect(outcome.message).toContain('3 jalapeños');
    expect(outcome.message).toContain('Nothing has been saved');
    expect(applier.saveCalls).toHaveLength(0);
    // The "Do not save" instruction is a negated save — never an authorization.
    expect(classifySaveIntent('Change the 2 jalapeños to 3 jalapeños. Do not save.').authorized).toBe(false);
    // The application finding records WHAT happened (never model prose).
    expect(
      outcome.state.findings.some(
        (finding) => finding.tool === 'apply_ingredient_edits' && /Applied 1 ingredient change/.test(finding.summary),
      ),
    ).toBe(true);
  }, 60000);

  it('uses the CURRENT line reference derived from the live recipe view', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const view = toShisoRecipeView(recipe as never)!;
    const expectedRef = view.ingredients[11]!.line_ref as string;
    const plan = planDeterministicIngredientEdit({
      userMessage: 'Change the 2 jalapeños to 3 jalapeños. Do not save.',
      ingredients: view.ingredients,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok !== true) return;
    expect(plan.plan.edit.line_ref).toBe(expectedRef);
    // And the planner's ref is accepted by the REAL editing authority.
    const result = applyShisoIngredientEdits(recipe, [plan.plan.edit]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.applied[0]!.after).toBe('3 jalapeños');
  }, 60000);

  it('a SECOND conversational edit applies against the UPDATED working copy', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const { network } = transport();

    const first = await runShisoConversationTurn(
      { network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(applier.raw(), applier) },
      initialShisoConversation(),
      'Change the 2 jalapeños to 3 jalapeños. Do not save.',
    );
    expect(first.ok).toBe(true);
    const firstRef = (toShisoRecipeView(applier.raw() as never))!.ingredients[11]!.line_ref;

    const second = await runShisoConversationTurn(
      { network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(applier.raw(), applier) },
      first.state,
      'Change the 3 jalapeños to 1 jalapeño.',
    );
    expect(second.ok).toBe(true);
    const lines = (applier.raw()['ingredients'] as Array<{ original: string }>).map((i) => i.original);
    expect(lines).toContain('1 jalapeño');
    expect(lines).not.toContain('3 jalapeños');
    // The handle genuinely changed with the content (stale refs cannot survive).
    const secondRef = (toShisoRecipeView(applier.raw() as never))!.ingredients[11]!.line_ref;
    expect(secondRef).not.toBe(firstRef);
  }, 60000);
});

// ===========================================================================
// 2. GENERALITY — different foods, units, name replacement
// ===========================================================================

describe('H-2S — generality (no ingredient-specific logic)', () => {
  it('quantity-only change with a different unit word: "Change 1 cup whole milk to 2 cups."', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const outcome = await runShisoConversationTurn(
      { network: transport().network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(recipe, applier) },
      initialShisoConversation(),
      'Change 1 cup whole milk to 2 cups.',
    );
    expect(outcome.ok).toBe(true);
    const lines = (applier.raw()['ingredients'] as Array<{ original: string }>).map((i) => i.original);
    expect(lines).toContain('2 cups whole milk');
  }, 60000);

  it('unit alias: "Change 2 tablespoons vegetable oil to 3 tablespoons."', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const outcome = await runShisoConversationTurn(
      { network: transport().network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(recipe, applier) },
      initialShisoConversation(),
      'Change 2 tablespoons vegetable oil to 3 tablespoons.',
    );
    expect(outcome.ok).toBe(true);
    const lines = (applier.raw()['ingredients'] as Array<{ original: string }>).map((i) => i.original);
    expect(lines).toContain('3 tablespoons vegetable oil');
  }, 60000);

  it('name replacement preserves the quantity and the descriptors around the matched word', async () => {
    const md = `---
title: Simple
servings: 2
---
# Simple
## 🥘 Ingredients
- [ ] 2 cups shredded chicken breast
- [ ] 1 teaspoon salt
## 🍳 Instructions
1. Cook.
`;
    const recipe = parseRecipe(md) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const outcome = await runShisoConversationTurn(
      { network: transport().network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(recipe, applier) },
      initialShisoConversation(),
      'Replace the ingredient name chicken with turkey.',
    );
    expect(outcome.ok).toBe(true);
    const lines = (applier.raw()['ingredients'] as Array<{ original: string }>).map((i) => i.original);
    // Quantity untouched; only the matched word replaced.
    expect(lines).toContain('2 cups shredded turkey breast');
  }, 60000);

  it('fraction change: "Change 1/2 teaspoon of salt to 1/4 teaspoon."', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const outcome = await runShisoConversationTurn(
      { network: transport().network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(recipe, applier) },
      initialShisoConversation(),
      'Change 1/2 teaspoon of salt to 1/4 teaspoon.',
    );
    expect(outcome.ok).toBe(true);
    const lines = (applier.raw()['ingredients'] as Array<{ original: string }>).map((i) => i.original);
    expect(lines).toContain('1/4 teaspoon salt');
  }, 60000);
});

// ===========================================================================
// 3. REFUSALS — ambiguity falls through, never guesses
// ===========================================================================

describe('H-2S — ambiguity is refused, not guessed', () => {
  it('a name that matches TWO ingredients is ambiguous (chicken → chicken breast + chicken broth)', () => {
    const recipe = parseRecipe(ENCHILADAS_MD);
    const view = toShisoRecipeView(recipe as never)!;
    const plan = planDeterministicIngredientEdit({
      userMessage: 'Replace the ingredient name chicken with turkey.',
      ingredients: view.ingredients,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.reason).toBe('ambiguous_target');
  });

  it('duplicate ingredient names stay ambiguous through the real turn loop (no edit, model path engaged)', async () => {
    const md = `---
title: Dupes
servings: 2
---
# Dupes
## 🥘 Ingredients
- [ ] 1 cup sugar
- [ ] 1 cup sugar
## 🍳 Instructions
1. Cook.
`;
    const recipe = parseRecipe(md) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const { network, calls } = transport([
      { ok: true, kind: 'reply', text: 'Which sugar line do you mean?', proposals: [], model_invocations_used: 1, tool_calls_used: 0 },
    ]);
    const outcome = await runShisoConversationTurn(
      { network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(recipe, applier) },
      initialShisoConversation(),
      'Change 1 cup of sugar to 2 cups.',
    );
    // The deterministic path refused; the model path ran and ASKED.
    expect(calls).toHaveLength(1);
    expect(applier.applyCalls).toHaveLength(0);
    expect(outcome.message).toContain('Which sugar line');
  }, 60000);

  it('an unmatched ingredient falls through to the model', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const { network, calls } = transport([
      { ok: true, kind: 'reply', text: 'I could not find garlic in this recipe.', proposals: [], model_invocations_used: 1, tool_calls_used: 0 },
    ]);
    await runShisoConversationTurn(
      { network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(recipe, applier) },
      initialShisoConversation(),
      'Change 2 cloves of garlic to 3.',
    );
    expect(calls).toHaveLength(1);
    expect(applier.applyCalls).toHaveLength(0);
  }, 60000);

  it('a save-mentioning command is NEVER intercepted (the full save-safe flow handles it)', () => {
    const recipe = parseRecipe(ENCHILADAS_MD);
    const view = toShisoRecipeView(recipe as never)!;
    const plan = planDeterministicIngredientEdit({
      userMessage: 'Change the 2 jalapeños to 3 jalapeños and save my changes',
      ingredients: view.ingredients,
    });
    expect(plan.ok).toBe(false);
  });
});

// ===========================================================================
// 4. ARGUMENT CONTRACTS — strict-schema nulls, valid args, terminal failure
// ===========================================================================

describe('H-2S — provider argument contracts', () => {
  it('accepts a valid edit call and treats strict-mode nulls as absent fields', () => {
    const valid = parseShisoDecision({
      kind: 'tool_request',
      tool: 'apply_ingredient_edits',
      args: {
        tool: 'apply_ingredient_edits',
        // The strict-schema encoding: every arg key present, unused ones null.
        line_ref: null,
        line_refs: null,
        query: null,
        limit: null,
        fdc_id: null,
        cursor: null,
        include_ingredients: null,
        statuses: null,
        edits: [
          {
            line_ref: 'ing:11:1e96a6975028',
            new_name: null,
            new_amount: 3,
            new_unit: null,
            new_preparation: null,
          },
        ],
      },
    });
    expect(valid).not.toBeNull();
    if (valid === null || valid.kind !== 'tool_request') return;
    const edits = (valid.args as unknown as { edits: Array<Record<string, unknown>> }).edits;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ line_ref: 'ing:11:1e96a6975028', new_amount: 3 });
  });

  it('an entry with a null line_ref is dropped (never guessed) and cannot smuggle a change', () => {
    const decision = parseShisoDecision({
      kind: 'tool_request',
      tool: 'apply_ingredient_edits',
      args: {
        edits: [
          { line_ref: null, new_name: 'turkey', new_amount: null, new_unit: null, new_preparation: null },
        ],
      },
    });
    expect(decision).not.toBeNull();
    if (decision === null || decision.kind !== 'tool_request') return;
    expect((decision.args as unknown as { edits: unknown[] }).edits).toEqual([]);
  });

  it('valid arguments survive the browser tool contract and mutate through the stub authority', async () => {
    const seen: unknown[] = [];
    const obs = await executeShisoTool(
      {
        tool: 'apply_ingredient_edits',
        edits: [{ line_ref: 'ing:11:abc', new_amount: 3 }],
      },
      {
        session: null,
        recipe: {
          title: 'T',
          servings: 2,
          ingredients: [{ text: '2 jalapeños', name: 'jalapeños', line_ref: 'ing:11:abc' }],
          instructions: [],
        },
        nutrition: null,
        applyIngredientEdits: async (edits) => {
          seen.push(edits);
          return {
            ok: true,
            applied: [{ line_ref: 'ing:11:abc', before: '2 jalapeños', after: '3 jalapeños', changes: ['amount: 2 → 3'] }],
            refused: [],
            summary: 'Applied 1 ingredient change(s) to the UNSAVED working copy.',
            working_unsaved: true,
            note: 'Saved: no.',
          };
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(obs.ok).toBe(true);
    if (obs.ok) expect(obs.data['applied_count']).toBe(1);
  });

  it('REPEATED identical empty-argument failures are terminal (no budget death loop)', async () => {
    const { network, calls } = transport([
      { ok: true, kind: 'tool_request', tool: 'apply_ingredient_edits', args: { tool: 'apply_ingredient_edits' }, model_invocations_used: 1, tool_calls_used: 0 },
      { ok: true, kind: 'tool_request', tool: 'apply_ingredient_edits', args: { tool: 'apply_ingredient_edits' }, model_invocations_used: 2, tool_calls_used: 1 },
      { ok: true, kind: 'reply', text: 'should never be reached', proposals: [], model_invocations_used: 3, tool_calls_used: 2 },
    ]);
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    const outcome = await runShisoConversationTurn(
      { network, context: CONVERSATION_CONTEXT as never, toolContext: toolContextFor(recipe, applier) },
      initialShisoConversation(),
      'yes',
    );
    expect(outcome.ok).toBe(true);
    // Two provider calls, then terminal — NOT a third, not a budget death.
    expect(calls).toHaveLength(2);
    expect(outcome.message).toContain('nothing was changed');
    expect(applier.applyCalls).toHaveLength(0);
  }, 60000);

  it('the corrective empty-argument message names the exact required keys', async () => {
    const obs = await executeShisoTool(
      { tool: 'apply_ingredient_edits', edits: [] },
      {
        session: null,
        recipe: { title: 'T', servings: 2, ingredients: [{ text: 'x', name: 'x' }], instructions: [] },
        nutrition: null,
        applyIngredientEdits: async () => {
          throw new Error('must not be called');
        },
      },
    );
    expect(obs.ok).toBe(false);
    if (!obs.ok) {
      const message = (obs as { message?: string }).message ?? '';
      expect(message).toContain('line_ref');
      expect(message).toContain('new_name');
      expect(message).toContain('get_current_recipe');
    }
  });
});

// ===========================================================================
// 5. SAVE SAFETY — the deterministic path never saves
// ===========================================================================

describe('H-2S — save safety is preserved', () => {
  it('"Do not save" is honored: the deterministic edit runs and no save port is ever touched', async () => {
    const recipe = parseRecipe(ENCHILADAS_MD) as unknown as Record<string, unknown>;
    const applier = createRealApplier(recipe);
    let savePortCalls = 0;
    const context: ShisoToolContext = {
      ...toolContextFor(recipe, applier),
      saveWorkingRecipe: async () => {
        savePortCalls += 1;
        return { ok: true, saved: true, message: 'Saved.' };
      },
    };
    const outcome = await runShisoConversationTurn(
      { network: transport().network, context: CONVERSATION_CONTEXT as never, toolContext: context },
      initialShisoConversation(),
      'Change the 2 jalapeños to 3 jalapeños. Do not save.',
    );
    expect(outcome.ok).toBe(true);
    expect(savePortCalls).toBe(0);
    expect(applier.saveCalls).toHaveLength(0);
    expect(outcome.message).toContain('Nothing has been saved');
  }, 60000);

  it('bare affirmatives still never authorize a save', () => {
    for (const message of ['yes', 'ok', 'sure', 'go ahead', 'do it']) {
      expect(classifySaveIntent(message).authorized, message).toBe(false);
    }
  });
});
