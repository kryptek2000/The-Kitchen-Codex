// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from '../../src/App';
import { ShisoEntryProvider, useShiso } from '../../src/application-ui/shisoEntryPoints';
import { createShisoVaultCapability, type ShisoVaultIdentity } from '../../src/application/shisoVaultCapabilities';
import { createShisoNutritionReviewController } from '../../src/application/shisoNutritionReview';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { initialShisoConversation, runShisoConversationTurn } from '../../src/application/shisoConversation';
import { getStarterVaultRecipes } from '../../src/data/starterVault';
import type { ObsidianRecipe } from '../../src/types';
import { parseShisoDecision } from '../../server/shiso/conversationTurn';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { RuntimeBundleResult } from '../../src/core/nutritionV2/runtime';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { USDA_ATTRIBUTION } from '../../src/core/nutritionV2/usda/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { NUTRITION_PRODUCT_ACCESS_VERSION } from '../../src/core/nutritionV2/nutritionProductAccess';

function OpenGlobal() {
  const { open } = useShiso();
  useEffect(() => {
    open('global');
  }, [open]);
  return null;
}

function fixtureRecipes(count: number, prefix = 'fixture'): ObsidianRecipe[] {
  const base = getStarterVaultRecipes()[0];
  return Array.from({ length: count }, (_, index) => ({
    ...base,
    id: prefix + '-' + index,
    fileName: prefix + '-' + index + '.md',
    filePath: 'Recipes/' + prefix + '-' + index + '.md',
    title: 'Fixture Recipe ' + index,
    ingredients: [
      ...base.ingredients,
      { ...base.ingredients[0], name: index % 2 === 0 ? 'scallions' : 'tomatoes', original: '2 ' + (index % 2 === 0 ? 'scallions' : 'tomatoes') },
    ],
    tags: index % 2 === 0 ? ['weeknight'] : ['vegetarian'],
  }));
}

function nutritionRecipe(): ObsidianRecipe {
  const base = getStarterVaultRecipes()[0];
  return {
    ...base,
    id: 'nutrition-fixture',
    fileName: 'nutrition-fixture.md',
    filePath: 'Recipes/nutrition-fixture.md',
    title: 'Nutrition Fixture',
    servings: 2,
    ingredients: [
      { original: '57 g unsalted butter', amount: 57, unit: 'g', name: 'unsalted butter' },
      { original: '5 g salt', amount: 5, unit: 'g', name: 'salt' },
    ] as never,
  };
}

function scriptedNetwork(script: readonly unknown[], otherResponses: Readonly<Record<string, unknown>> = {}): NetworkAdapter {
  let index = 0;
  const response = async (path: string) => {
    if (path === '/api/shiso/turn') {
      const data = script[Math.min(index, script.length - 1)];
      index += 1;
      return { status: 200, ok: true, data };
    }
    return { status: 200, ok: true, data: otherResponses[path] ?? { ok: true, access: 'entitled', available: true } };
  };
  return {
    post: response as NetworkAdapter['post'],
    get: response as NetworkAdapter['get'],
    request: async (request) => response(request.path) as never,
  };
}

const deterministicSettings = {
  get: async () => null,
  set: async () => {},
  remove: async () => {},
};

function capabilityFor(recipes: ObsidianRecipe[], identity: ShisoVaultIdentity = { id: 'fixture-a', source: 'personal' }) {
  let currentRecipes = recipes;
  let currentIdentity = identity;
  return {
    capability: createShisoVaultCapability({
      getRecipes: () => currentRecipes,
      getNoteCount: () => 2,
      getIdentity: () => currentIdentity,
    }),
    switchVault(nextRecipes: ObsidianRecipe[], nextIdentity: ShisoVaultIdentity) {
      currentRecipes = nextRecipes;
      currentIdentity = nextIdentity;
    },
  };
}

describe('SHISO agent foundation Vault capability', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('reports an authoritative 88-recipe count, searches, retrieves, and selects without filesystem access', () => {
    const fixture = fixtureRecipes(88);
    const { capability, switchVault } = capabilityFor(fixture);

    expect(capability.getStatus()).toMatchObject({
      source: 'personal',
      connected: true,
      recipe_count: 88,
      note_count: 2,
    });

    const search = capability.searchRecipes({ query: 'scallions', field: 'ingredient' });
    expect(search.total_matches).toBe(44);
    expect(search.results[0]?.title).toMatch(/^Fixture Recipe/);

    const selected = capability.selectRecipe(search.results[0]!.id);
    expect(selected?.title).toBe('Fixture Recipe 0');
    expect(capability.getSelectedRecipe()?.title).toBe('Fixture Recipe 0');

    switchVault(fixtureRecipes(3, 'other'), { id: 'fixture-b', source: 'personal' });
    expect(capability.getStatus().recipe_count).toBe(3);
    expect(capability.getSelectedRecipe()).toBeNull();
  });

  it('executes the Vault tools through the closed SHISO dispatcher', async () => {
    const fixture = fixtureRecipes(88);
    const { capability } = capabilityFor(fixture);
    const context: ShisoToolContext = { vault: capability, session: null, recipe: null, nutrition: null };

    const status = await executeShisoTool({ tool: 'get_vault_status' }, context);
    expect(status).toMatchObject({ ok: true, data: { recipe_count: 88, source: 'personal' } });

    const search = await executeShisoTool({ tool: 'search_vault_recipes', query: 'scallions', field: 'ingredient' }, context);
    expect(search).toMatchObject({ ok: true, data: { total_matches: 44 } });

    const recipeId = search.ok && Array.isArray(search.data.results)
      ? (search.data.results[0] as { id: string }).id
      : '';
    const selected = await executeShisoTool({ tool: 'select_vault_recipe', recipe_id: recipeId }, context);
    expect(selected).toMatchObject({ ok: true });
    const current = await executeShisoTool({ tool: 'get_current_recipe' }, context);
    expect(current).toMatchObject({ ok: true, data: { title: 'Fixture Recipe 0' } });
    expect(current.ok && current.data.ingredients[0]?.line_ref).toMatch(/^ing:\d+:/);
  });

  it('answers the general-chat count from the capability before any provider call', async () => {
    const { capability } = capabilityFor(fixtureRecipes(88));
    const post = vi.fn();
    const outcome = await runShisoConversationTurn(
      {
        network: { post } as never,
        context: {
          recipe: null,
          nutrition: { available: false, summary: null, unresolvedCount: 0, needsAmountCount: 0, needsMatchCount: 0, unsavedWorkingReview: false },
          recipeKey: null,
          sessionIdentity: null,
        },
        toolContext: { vault: capability, session: null, recipe: null, nutrition: null },
      },
      initialShisoConversation(),
      'How many recipes are in my Vault?',
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe('Your active Vault contains 88 recipes.');
    expect(outcome.toolsUsed).toEqual(['get_vault_status']);
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps Vault capability requests closed and bounded at the provider boundary', () => {
    expect(parseShisoDecision({
      kind: 'tool_request',
      tool: 'search_vault_recipes',
      args: { query: '  scallions  ', field: 'ingredient', limit: 999 },
    })).toEqual({
      kind: 'tool_request',
      tool: 'search_vault_recipes',
      args: { tool: 'search_vault_recipes', query: 'scallions', field: 'ingredient', limit: 20 },
    });
    expect(parseShisoDecision({ kind: 'tool_request', tool: 'write_vault', args: {} })).toBeNull();
  });

  it('lets SHISO request the existing authenticated USDA loader with truthful status', async () => {
    const load = vi.fn(async () => {});
    const context: ShisoToolContext = {
      session: null,
      recipe: null,
      nutrition: null,
      catalogueStatus: 'loading',
      loadBundle: load,
    };
    const result = await executeShisoTool({ tool: 'load_usda_catalog' }, context);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      tool: 'load_usda_catalog',
      data: { catalogue_loaded: false, catalogue_status: 'loading', load_started: true },
    });
  });

  it('keeps the live USDA session and complete structured quantities across one tool turn', async () => {
    const recipe = nutritionRecipe();
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Butter, unsalted' },
      { fdcId: 7002, dataType: 'foundation', description: 'Salt, table' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture USDA session failed');
    let liveSession: typeof created.session | null = null;
    let analysisSawLiveSession = false;
    const context: ShisoToolContext = {
      get session() {
        return liveSession;
      },
      recipe: {
        title: recipe.title,
        servings: recipe.servings ?? null,
        ingredients: recipe.ingredients.map((ingredient, index) => ({
          text: ingredient.original,
          name: ingredient.name,
          amount: ingredient.amount,
          unit: ingredient.unit,
          line_ref: `ing:${index}:${ingredient.name}`,
        })),
        instructions: [],
      },
      nutrition: null,
      loadBundle: async () => {
        liveSession = created.session;
        return liveSession;
      },
      runAnalysis: async () => {
        analysisSawLiveSession = liveSession === created.session;
        return {
          ok: analysisSawLiveSession,
          analyzed: analysisSawLiveSession,
          summary: '2 of 2 ingredient lines resolved',
          matched: 2,
          needs_amount: 0,
          needs_match: 0,
          total_lines: 2,
          unresolved_line_refs: [],
          preview_state: 'complete' as const,
        };
      },
    };

    const load = await executeShisoTool({ tool: 'load_usda_catalog' }, context);
    const analysis = await executeShisoTool({ tool: 'run_nutrition_analysis' }, context);
    const detail = createShisoVaultCapability({
      getRecipes: () => [recipe],
      getNoteCount: () => 0,
      getIdentity: () => ({ id: 'fixture', source: 'personal' }),
    }).getRecipe(recipe.id);

    expect(load).toMatchObject({ ok: true, data: { catalogue_loaded: true, catalogue_status: 'ready' } });
    expect(analysis).toMatchObject({ ok: true, data: { needs_amount: 0, matched: 2 } });
    expect(analysisSawLiveSession).toBe(true);
    expect(detail?.ingredients.map((line) => ({ amount: line.amount, unit: line.unit }))).toEqual([
      { amount: 57, unit: 'g' },
      { amount: 5, unit: 'g' },
    ]);
  });

  it('does not let a failed Apply become a successful model claim', async () => {
    await hydrateAiSelections(deterministicSettings);
    let responseIndex = 0;
    const responses = [
      { ok: true, kind: 'tool_request', tool: 'apply_nutrition_review', args: { tool: 'apply_nutrition_review' } },
      { ok: true, kind: 'reply', text: 'Nutrition is complete, applied, and saved to your Vault.', proposals: [] },
    ];
    const network: NetworkAdapter = {
      post: async () => ({ status: 200, ok: true, data: responses[Math.min(responseIndex++, responses.length - 1)] }),
      get: async () => ({ status: 404, ok: false, data: {} }),
      request: async () => ({ status: 404, ok: false, data: {} }),
    } as unknown as NetworkAdapter;
    const outcome = await runShisoConversationTurn(
      {
        network,
        context: {
          recipe: { title: 'Nutrition Fixture', servings: 2, ingredientCount: 2, stepCount: 0 },
          nutrition: { available: false, summary: null, unresolvedCount: 0, needsAmountCount: 0, needsMatchCount: 0, unsavedWorkingReview: false },
          recipeKey: 'nutrition-fixture',
          sessionIdentity: 'fixture-session',
        },
        toolContext: {
          session: null,
          recipe: {
            title: 'Nutrition Fixture',
            servings: 2,
            ingredients: [{ text: '57 g unsalted butter', name: 'unsalted butter', amount: 57, unit: 'g', line_ref: 'ing:0:butter' }],
            instructions: [],
          },
          nutrition: null,
          applyNutritionReview: async () => ({ ok: false, applied: false, message: 'Apply failed at the authoritative nutrition boundary.' }),
        },
      },
      initialShisoConversation(),
      'Apply the nutrition review and save it to my Vault.',
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('I could not confirm the full requested operation');
    expect(outcome.message).toContain('Apply failed at the authoritative nutrition boundary.');
    expect(outcome.message).not.toContain('Nutrition is complete, applied, and saved');
  });

  it('creates the same Phase 4 review owner used by general SHISO without mounting the card', () => {
    const recipe = nutritionRecipe();
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Butter, unsalted' },
      { fdcId: 7002, dataType: 'foundation', description: 'Salt, table' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture USDA session failed');
    const controller = createShisoNutritionReviewController(recipe, created.session);
    expect(controller).not.toBeNull();
    const outcome = controller!.analyze();
    const snapshot = controller!.getSnapshot();
    expect(outcome.ok).toBe(true);
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.reviewRows).toHaveLength(2);
    expect(snapshot.recipeKey).toBeTruthy();
    expect(snapshot.sessionIdentity).toBeTruthy();
  });

  it('works in the real App composition with a disposable 88-recipe fixture', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, access: 'entitled', available: true }),
    } as unknown as Response));

    const { capability } = capabilityFor(fixtureRecipes(88));
    render(
      <ShisoEntryProvider>
        <OpenGlobal />
        <App shisoVaultCapabilityOverride={capability} />
      </ShisoEntryProvider>,
    );

    const composer = await screen.findByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'How many recipes are in my Vault?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Your active Vault contains 88 recipes.')).toBeTruthy();
    });
  }, 30000);

  it('selects a recipe, loads USDA, and invokes the existing review owner from general SHISO chat', async () => {
    await hydrateAiSelections(deterministicSettings);
    const recipe = nutritionRecipe();
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Butter, unsalted' },
      { fdcId: 7002, dataType: 'foundation', description: 'Salt, table' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture USDA session failed');
    const loader = vi.fn(async (): Promise<RuntimeBundleResult> => ({
      ok: true,
      session: created.session,
      metadata: created.session.metadata(),
      attribution: USDA_ATTRIBUTION,
    }));
    const { capability } = capabilityFor([recipe]);
    const network = scriptedNetwork([
      { ok: true, kind: 'tool_request', tool: 'search_vault_recipes', args: { tool: 'search_vault_recipes', query: 'Nutrition Fixture', field: 'title', limit: 20 } },
      { ok: true, kind: 'tool_request', tool: 'select_vault_recipe', args: { tool: 'select_vault_recipe', recipe_id: 'nutrition-fixture' } },
      { ok: true, kind: 'tool_request', tool: 'load_usda_catalog', args: { tool: 'load_usda_catalog' } },
      { ok: true, kind: 'tool_request', tool: 'run_nutrition_analysis', args: { tool: 'run_nutrition_analysis' } },
      { ok: true, kind: 'reply', text: 'Nutrition review initialized and calculated from the authenticated fixture catalog.', proposals: [] },
    ]);

    render(
      <ShisoEntryProvider>
        <OpenGlobal />
        <App
          shisoVaultCapabilityOverride={capability}
          shisoNetworkAdapterOverride={network}
          shisoNutritionBundleLoaderOverride={loader}
          shisoSettingsAdapterOverride={deterministicSettings}
        />
      </ShisoEntryProvider>,
    );

    const composer = await screen.findByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Analyze the complete nutrition for this recipe.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Nutrition review initialized and calculated from the authenticated fixture catalog.')).toBeTruthy();
    }, { timeout: 30000 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(capability.getSelectedRecipe()?.id).toBe('nutrition-fixture');
  }, 60000);

  it('runs the exact Mandu nutrition request from general chat without opening Advanced Nutrition', async () => {
    await hydrateAiSelections(deterministicSettings);
    const recipe = { ...nutritionRecipe(), title: 'Crispy Kimchi and Pork Mandu' };
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Butter, unsalted' },
      { fdcId: 7002, dataType: 'foundation', description: 'Salt, table' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture USDA session failed');
    const loader = vi.fn(async (): Promise<RuntimeBundleResult> => ({
      ok: true,
      session: created.session,
      metadata: created.session.metadata(),
      attribution: USDA_ATTRIBUTION,
    }));
    const { capability } = capabilityFor([recipe]);
    const network = scriptedNetwork([
      { ok: true, kind: 'tool_request', tool: 'search_vault_recipes', args: { tool: 'search_vault_recipes', query: 'Crispy Kimchi and Pork Mandu', field: 'title', limit: 20 } },
      { ok: true, kind: 'tool_request', tool: 'select_vault_recipe', args: { tool: 'select_vault_recipe', recipe_id: 'nutrition-fixture' } },
      { ok: true, kind: 'tool_request', tool: 'complete_nutrition', args: { tool: 'complete_nutrition' } },
      { ok: true, kind: 'reply', text: 'Mandu nutrition was analyzed from the authenticated USDA catalog; nothing was saved.', proposals: [] },
    ]);

    render(
      <ShisoEntryProvider>
        <OpenGlobal />
        <App
          shisoVaultCapabilityOverride={capability}
          shisoNetworkAdapterOverride={network}
          shisoNutritionBundleLoaderOverride={loader}
          shisoSettingsAdapterOverride={deterministicSettings}
        />
      </ShisoEntryProvider>,
    );

    const composer = await screen.findByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(composer, {
      target: {
        value: 'Analyze the nutrition for this Mandu recipe. Use USDA wherever possible, use reasonable estimated weights and AI estimates for anything unresolved, and show me the complete results. Do not save any changes yet.',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Mandu nutrition was analyzed from the authenticated USDA catalog; nothing was saved.')).toBeTruthy();
    }, { timeout: 30000 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(capability.getSelectedRecipe()?.title).toBe('Crispy Kimchi and Pork Mandu');
    expect(document.body.textContent).not.toContain('Open Advanced Nutrition');
  }, 60000);

  it('runs general SHISO through USDA, the shared review owner, and canonical Apply without opening Advanced Nutrition', async () => {
    await hydrateAiSelections(deterministicSettings);
    const recipe = { ...nutritionRecipe(), builtInId: undefined };
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Butter, unsalted' },
      { fdcId: 7002, dataType: 'foundation', description: 'Salt, table' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture USDA session failed');
    const loader = vi.fn(async (): Promise<RuntimeBundleResult> => ({
      ok: true,
      session: created.session,
      metadata: created.session.metadata(),
      attribution: USDA_ATTRIBUTION,
    }));
    const { capability } = capabilityFor([recipe]);
    const network = scriptedNetwork([
      { ok: true, kind: 'tool_request', tool: 'search_vault_recipes', args: { tool: 'search_vault_recipes', query: 'Nutrition Fixture', field: 'title', limit: 20 } },
      { ok: true, kind: 'tool_request', tool: 'select_vault_recipe', args: { tool: 'select_vault_recipe', recipe_id: 'nutrition-fixture' } },
      { ok: true, kind: 'tool_request', tool: 'load_usda_catalog', args: { tool: 'load_usda_catalog' } },
      { ok: true, kind: 'tool_request', tool: 'run_nutrition_analysis', args: { tool: 'run_nutrition_analysis' } },
      { ok: true, kind: 'reply', text: 'The authenticated nutrition review is ready.', proposals: [] },
      { ok: true, kind: 'tool_request', tool: 'apply_nutrition_review', args: { tool: 'apply_nutrition_review' } },
      { ok: true, kind: 'reply', text: 'Nutrition was applied to the unsaved working recipe.', proposals: [] },
    ], {
      '/api/nutrition/product-access': { ok: true, version: NUTRITION_PRODUCT_ACCESS_VERSION, tier: 'ai_advanced' },
      '/api/providers': { providers: [{ enabled: true, configured: true, available: true, capabilities: { structuredOutput: true } }] },
    });

    render(
      <ShisoEntryProvider>
        <OpenGlobal />
        <App
          shisoVaultCapabilityOverride={capability}
          shisoNetworkAdapterOverride={network}
          shisoNutritionBundleLoaderOverride={loader}
          shisoSettingsAdapterOverride={deterministicSettings}
        />
      </ShisoEntryProvider>,
    );

    const composer = await screen.findByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Analyze the complete nutrition for this recipe.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('The authenticated nutrition review is ready.')).toBeTruthy(), { timeout: 30000 });

    fireEvent.change(composer, { target: { value: 'Apply the validated nutrition review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('Nutrition was applied to the unsaved working recipe.')).toBeTruthy(), { timeout: 30000 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(capability.getSelectedRecipe()?.id).toBe('nutrition-fixture');
  }, 60000);
});
