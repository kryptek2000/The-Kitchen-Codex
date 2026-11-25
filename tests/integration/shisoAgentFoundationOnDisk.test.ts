/**
 * SHISO Agent Foundation — connected Vault inventory and persistence evidence.
 *
 * This suite uses a real temporary directory through the production
 * VaultAdapter/scan/serialization boundaries. It never touches the user's
 * personal Vault and never uses the starter collection as an inventory source.
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultMarkdownFile } from '../../src/application/adapters/VaultAdapter';
import { loadVaultContent } from '../../src/application/vaultContent';
import { saveRecipeWithVaultAdapter } from '../../src/application/vaultRecipe';
import { createShisoVaultCapability } from '../../src/application/shisoVaultCapabilities';
import { createShisoNutritionReviewController } from '../../src/application/shisoNutritionReview';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { DV_STANDARD_ID } from '../../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../../src/core/nutritionV2/schema';
import {
  beginSaveAuthorization,
  classifySaveIntent,
  completeSaveAuthorization,
  INITIAL_SAVE_AUTHORIZATION_STATE,
  issueSaveAuthorization,
  recipeIdentityOf,
  verifySaveGrant,
} from '../../src/core/shiso/saveAuthorization';
import type { ObsidianRecipe } from '../../src/types';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const roots: string[] = [];

const recipeMarkdown = (title: string, ingredient: string): string => `---
title: "${title}"
tags:
  - food/recipes
category: Dinner
servings: 2
---
# ${title}
## Ingredients
- 1 ${ingredient}
## Instructions
1. Cook until ready.
`;

const nutritionRecipeMarkdown = `---
title: "Nutrition Fixture"
tags:
  - food/recipes
category: Dinner
servings: 2
---
# Nutrition Fixture
## Ingredients
- 57 g unsalted butter
- 5 g salt
## Instructions
1. Mix and cook.
`;

async function walkMarkdown(root: string, current = root): Promise<VaultMarkdownFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: VaultMarkdownFile[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdown(root, absolute));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const path = relative(root, absolute).split('\\').join('/');
      files.push({ path, name: entry.name });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function diskVault(root: string): VaultAdapter {
  const absolutePath = (path: string): string => {
    const candidate = resolve(root, path);
    if (candidate !== root && !candidate.startsWith(root + '/')) throw new Error('unsafe vault path');
    return candidate;
  };
  return {
    async listMarkdownFiles() {
      return walkMarkdown(root);
    },
    async readText(path) {
      return readFile(absolutePath(path), 'utf8');
    },
    async writeText(path, content) {
      const target = absolutePath(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    },
    async delete(path) {
      await rm(absolutePath(path), { force: true });
    },
    async exists(path) {
      try {
        await readFile(absolutePath(path));
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function createDisposableVault(): Promise<{ root: string; vault: VaultAdapter }> {
  const root = await mkdtemp(join(tmpdir(), 'tkc-shiso-agent-'));
  roots.push(root);
  await mkdir(join(root, 'Recipes', 'Dinner'), { recursive: true });
  await writeFile(join(root, 'Recipes', 'Dinner', 'A.md'), recipeMarkdown('A', 'tomatoes'), 'utf8');
  await writeFile(join(root, 'Recipes', 'Dinner', 'B.md'), recipeMarkdown('B', 'scallions'), 'utf8');
  await writeFile(join(root, 'Recipes', 'Dinner', 'C.md'), recipeMarkdown('C', 'garlic'), 'utf8');
  await writeFile(join(root, 'Notes.md'), 'plain note\n', 'utf8');
  return { root, vault: diskVault(root) };
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('SHISO connected Vault authority', () => {
  it('counts the actual persisted recipe inventory and distinguishes it from starter data', async () => {
    const { vault } = await createDisposableVault();
    const scan = await loadVaultContent(vault);
    expect(scan.recipes).toHaveLength(3);
    expect(scan.notes).toHaveLength(1);

    const capability = createShisoVaultCapability({
      getRecipes: () => scan.recipes,
      getNoteCount: () => scan.notes.length,
      getIdentity: () => ({ id: 'filesystem-fixture-1', source: 'personal' as const }),
    });

    expect(capability.getStatus()).toMatchObject({
      source: 'personal',
      connected: true,
      recipe_count: 3,
      note_count: 1,
    });
    expect(capability.searchRecipes({ query: 'scallions', field: 'ingredient' }).total_matches).toBe(1);
    expect(capability.getRecipe(scan.recipes[0]!.id)?.file_path).toBe(scan.recipes[0]!.filePath);
  });

  it('writes a nutrition-bearing recipe through the canonical adapter and reads it unchanged after restart', async () => {
    const { vault } = await createDisposableVault();
    const before = await loadVaultContent(vault);
    const recipe = before.recipes[0]!;
    const corrected: ObsidianRecipe = {
      ...recipe,
      codexNutrition: {
        schema: 1,
        basis: 'total',
        servings: 2,
        status: 'complete',
        computed_at: '2026-11-25T00:00:00.000Z',
        ingredient_digest: 'sha256:' + 'a'.repeat(64),
        dv_standard: DV_STANDARD_ID,
        sources: ['usda_fdc'],
        source_releases: { usda_fdc: 'fixture-release' },
        nutrient_scope: ['calories'],
        nutrients: {
          calories: { amount: 123, unit: 'kcal', status: 'complete', coverage: 1, covered_ingredient_count: 1, measurable_ingredient_count: 1 },
        },
        ingredients: [{
          line_ref: 'flour',
          source: 'usda_fdc',
          source_food_id: 'fixture-food-1',
          source_release: 'fixture-release',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
        }],
        unresolved: [],
      } satisfies CodexNutritionV1,
    };
    let writes = 0;
    const persistWithGrant = async (grant: unknown): Promise<boolean> => {
      if (!verifySaveGrant(grant, recipeIdentityOf(corrected)).ok) return false;
      await saveRecipeWithVaultAdapter(vault, corrected);
      writes += 1;
      return true;
    };

    expect(await persistWithGrant(undefined)).toBe(false);
    expect(writes).toBe(0);

    const saveIntent = classifySaveIntent('Please save my changes');
    expect(saveIntent.authorized).toBe(true);
    expect(await persistWithGrant({
      authorized: true,
      via: 'assistant',
      recipe_identity: recipeIdentityOf(corrected),
      turn: 1,
    })).toBe(true);
    expect(writes).toBe(1);

    // A fresh scan is the restart boundary: no in-memory recipe snapshot is reused.
    const afterRestart = await loadVaultContent(vault);
    expect(afterRestart.recipes).toHaveLength(3);
    expect(afterRestart.recipes.find((entry) => entry.id === recipe.id)?.codexNutrition).toMatchObject({
      schema: 1,
      nutrients: { calories: { amount: 123 } },
    });
  });

  it('persists the general-chat Phase 4 review through Apply then an explicit authorized Save', async () => {
    const { root, vault } = await createDisposableVault();
    await writeFile(join(root, 'Recipes', 'Dinner', 'A.md'), nutritionRecipeMarkdown, 'utf8');
    const before = await loadVaultContent(vault);
    const recipe = before.recipes.find((entry) => entry.title === 'Nutrition Fixture');
    expect(recipe).toBeDefined();
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Butter, unsalted' },
      { fdcId: 7002, dataType: 'foundation', description: 'Salt, table' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok || recipe === undefined) throw new Error('nutrition fixture setup failed');
    const controller = createShisoNutritionReviewController(recipe, created.session);
    expect(controller).not.toBeNull();
    const analysis = controller!.analyze();
    expect(analysis.ok).toBe(true);
    expect(analysis.needs_amount).toBe(0);
    expect(analysis.needs_match).toBe(0);

    let working: ObsidianRecipe | null = null;
    const applied = await applyAdvancedNutrition({
      session: created.session,
      recipe,
      state: controller!.getState(),
      expectedMode: 'create',
      write: async (updated: ObsidianRecipe) => {
        working = updated;
      },
    });
    expect(applied.ok).toBe(true);
    const appliedBlock = working?.codexNutrition as { readonly status?: string; readonly ingredients?: readonly unknown[] } | undefined;
    expect(appliedBlock?.status).toBe('complete');

    const unauthorized = verifySaveGrant(undefined, recipeIdentityOf(working!));
    expect(unauthorized.ok).toBe(false);
    const saveIntent = classifySaveIntent('Please save my changes');
    expect(saveIntent.authorized).toBe(true);
    expect(verifySaveGrant({
      authorized: true,
      via: 'assistant',
      recipe_identity: recipeIdentityOf(working!),
      turn: 1,
    }, recipeIdentityOf(working!)).ok).toBe(true);
    await saveRecipeWithVaultAdapter(vault, working!);

    const restarted = await loadVaultContent(vault);
    const persisted = restarted.recipes.find((entry) => entry.id === recipe.id);
    expect(persisted?.codexNutrition).toMatchObject({
      status: 'complete',
      sources: ['usda_fdc'],
    });
    expect((persisted?.codexNutrition as { readonly ingredients?: readonly unknown[] } | undefined)?.ingredients).toHaveLength(2);
  });

  it('exercises the canonical capability handlers and save authority against a disposable on-disk Vault', async () => {
    const { root, vault } = await createDisposableVault();
    await writeFile(join(root, 'Recipes', 'Dinner', 'A.md'), nutritionRecipeMarkdown, 'utf8');
    const initial = await loadVaultContent(vault);
    const recipe = initial.recipes.find((entry) => entry.title === 'Nutrition Fixture');
    expect(recipe).toBeDefined();
    const capability = createShisoVaultCapability({
      getRecipes: () => initial.recipes,
      getNoteCount: () => initial.notes.length,
      getIdentity: () => ({ id: 'on-disk-fixture', source: 'personal' as const }),
    });
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 7001, dataType: 'foundation', description: 'Butter, unsalted' },
      { fdcId: 7002, dataType: 'foundation', description: 'Salt, table' },
    ]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok || recipe === undefined) throw new Error('nutrition fixture setup failed');

    let liveSession: typeof created.session | null = null;
    let controller: ReturnType<typeof createShisoNutritionReviewController> = null;
    let working: ObsidianRecipe = recipe;
    let authorizationState = INITIAL_SAVE_AUTHORIZATION_STATE;
    let writes = 0;
    const context: ShisoToolContext = {
      vault: capability,
      get session() {
        return liveSession;
      },
      get recipe() {
        const detail = capability.getSelectedRecipe();
        if (detail === null) return null;
        return {
          title: detail.title,
          servings: detail.servings,
          ingredients: detail.ingredients.map((line) => ({
            text: line.text,
            name: line.name,
            amount: line.amount,
            unit: line.unit,
            preparation: line.preparation,
            line_ref: line.line_ref,
          })),
          instructions: detail.instructions,
        };
      },
      get nutrition() {
        const snapshot = controller?.getSnapshot() ?? null;
        return snapshot === null ? null : {
          rows: snapshot.rows,
          aiContributions: snapshot.aiContributions,
          summary: snapshot.summary,
          unsaved: snapshot.unsaved,
          recipeDigest: snapshot.recipeDigest,
          reviewIdentity: snapshot.reviewIdentity,
          nutrientCoverage: snapshot.nutrientCoverage,
        };
      },
      loadBundle: async () => {
        liveSession = created.session;
        controller = createShisoNutritionReviewController(recipe, created.session);
        return liveSession;
      },
      runAnalysis: async (signal) => controller?.analyze(signal) ?? {
        ok: false,
        analyzed: false,
        summary: 'No review controller',
        matched: 0,
        needs_amount: 0,
        needs_match: 0,
        total_lines: 0,
        unresolved_line_refs: [],
        preview_state: 'absent' as const,
      },
      applyNutritionReview: async () => {
        if (controller === null) return { ok: false, applied: false, message: 'No review controller.' };
        const applied = await applyAdvancedNutrition({
          session: controller.session,
          recipe,
          state: controller.getState(),
          expectedMode: recipe.codexNutrition ? 'replace' : 'create',
          write: async (updated: ObsidianRecipe) => { working = updated; },
        });
        return { ok: applied.ok, applied: applied.ok, message: applied.ok ? 'Applied to working recipe.' : 'Apply failed.' };
      },
      saveWorkingRecipe: async () => {
        const decision = beginSaveAuthorization(authorizationState);
        if (!decision.ok) return { ok: false, saved: false, reason_code: 'not_authorized' as const, message: 'Saving needs explicit authorization.' };
        authorizationState = decision.state;
        const verified = verifySaveGrant(decision.grant, recipeIdentityOf(working));
        if (!verified.ok) {
          authorizationState = completeSaveAuthorization(authorizationState, false);
          return { ok: false, saved: false, reason_code: 'stale_recipe' as const, message: 'The active recipe changed.' };
        }
        await saveRecipeWithVaultAdapter(vault, working);
        writes += 1;
        authorizationState = completeSaveAuthorization(authorizationState, true);
        return { ok: true, saved: true, message: 'Saved to disposable Vault.' };
      },
    };

    const searched = await executeShisoTool({ tool: 'search_vault_recipes', query: 'Nutrition Fixture', field: 'title' }, context);
    expect(searched.ok).toBe(true);
    const selected = await executeShisoTool({ tool: 'select_vault_recipe', recipe_id: recipe.id }, context);
    const loaded = await executeShisoTool({ tool: 'load_usda_catalog' }, context);
    const analyzed = await executeShisoTool({ tool: 'run_nutrition_analysis' }, context);
    const applied = await executeShisoTool({ tool: 'apply_nutrition_review' }, context);
    const denied = await executeShisoTool({ tool: 'save_working_recipe' }, context);
    const saveIntent = classifySaveIntent('Save my changes.');
    authorizationState = issueSaveAuthorization({
      state: authorizationState,
      authorized: saveIntent.authorized,
      recipe_identity: recipeIdentityOf(working),
      turn: 1,
    });
    const saved = await executeShisoTool({ tool: 'save_working_recipe' }, context);

    expect(selected.ok).toBe(true);
    expect(loaded).toMatchObject({ ok: true });
    expect(analyzed).toMatchObject({ ok: true, data: { matched: 2, needs_amount: 0, needs_match: 0 } });
    expect(applied).toMatchObject({ ok: true, data: { applied: true, working_unsaved: true } });
    expect(denied).toMatchObject({ ok: false, code: 'save_not_authorized' });
    expect(saved).toMatchObject({ ok: true, data: { saved: true } });
    expect(writes).toBe(1);

    const restarted = await loadVaultContent(vault);
    const persisted = restarted.recipes.find((entry) => entry.id === recipe.id);
    expect(persisted?.codexNutrition).toMatchObject({ status: 'complete', sources: ['usda_fdc'] });
    expect((persisted?.codexNutrition as { readonly ingredients?: readonly unknown[] } | undefined)?.ingredients).toHaveLength(2);
  });
});
