// @vitest-environment jsdom
/**
 * F3 final closure: the real App, real SHISO conversation engine, the browser
 * Vault adapter, and a disposable on-disk Vault. No local save boolean stands
 * in for the production authorization path.
 */
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import App from '../../src/App';
import { ShisoEntryProvider, useShiso, type ShisoEntryPoints } from '../../src/application-ui/shisoEntryPoints';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import { createBrowserVaultAdapter } from '../../src/platform/browser';
import { loadVaultContent } from '../../src/application/vaultContent';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4';
import type { RuntimeBundleResult } from '../../src/core/nutritionV2/runtime';
import { USDA_ATTRIBUTION } from '../../src/core/nutritionV2/usda/types';
import { NUTRITION_PRODUCT_ACCESS_VERSION } from '../../src/core/nutritionV2/nutritionProductAccess';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

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

const settingsValues = new Map<string, unknown>();
const settings: SettingsAdapter = {
  get: async <T = unknown>(key: string) => settingsValues.get(key) as T | undefined,
  set: async <T = unknown>(key: string, value: T) => { settingsValues.set(key, value); },
  remove: async (key: string) => { settingsValues.delete(key); },
};

class DiskFileHandle {
  readonly kind = 'file' as const;
  constructor(readonly name: string, private readonly path: string) {}

  async getFile() {
    return {
      text: async () => readFile(this.path, 'utf8'),
      arrayBuffer: async () => (await readFile(this.path)).buffer,
    };
  }

  async createWritable() {
    let pending = '';
    return {
      write: async (data: string | Uint8Array) => {
        pending = typeof data === 'string' ? data : new TextDecoder().decode(data);
      },
      close: async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, pending, 'utf8');
      },
      abort: async () => {},
    };
  }
}

class DiskDirectoryHandle {
  readonly kind = 'directory' as const;
  constructor(readonly name: string, private readonly path: string) {}

  async *values(): AsyncGenerator<DiskDirectoryHandle | DiskFileHandle> {
    for (const entry of await readdir(this.path, { withFileTypes: true })) {
      const child = join(this.path, entry.name);
      yield entry.isDirectory()
        ? new DiskDirectoryHandle(entry.name, child)
        : new DiskFileHandle(entry.name, child);
    }
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const child = join(this.path, name);
    try {
      const entries = await readdir(this.path, { withFileTypes: true });
      if (entries.some((entry) => entry.name === name && entry.isDirectory())) {
        throw new Error(`Expected file: ${name}`);
      }
      if (!entries.some((entry) => entry.name === name) && !options?.create) {
        const error = new Error(`Missing file: ${name}`);
        Object.defineProperty(error, 'name', { value: 'NotFoundError' });
        throw error;
      }
      if (options?.create) await writeFile(child, '', { flag: 'a' });
      return new DiskFileHandle(name, child);
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFoundError') throw error;
      throw error;
    }
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const child = join(this.path, name);
    try {
      const existing = await stat(child);
      if (!existing.isDirectory()) throw new Error(`Expected directory: ${name}`);
      return new DiskDirectoryHandle(name, child);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT' || !options?.create) throw error;
      await mkdir(child, { recursive: true });
      return new DiskDirectoryHandle(name, child);
    }
  }

  async removeEntry(name: string) {
    await rm(join(this.path, name), { recursive: true, force: false });
  }

  async queryPermission() {
    return 'granted';
  }

  async requestPermission() {
    return 'granted';
  }
}

function scriptedNetwork(script: readonly unknown[], otherResponses: Readonly<Record<string, unknown>>): NetworkAdapter {
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

function OpenGlobal() {
  const { open } = useShiso();
  useEffect(() => open('global'), [open]);
  return null;
}

function CaptureShiso({ onReady }: { readonly onReady: (value: ShisoEntryPoints) => void }) {
  const shiso = useShiso();
  useEffect(() => onReady(shiso), [onReady, shiso]);
  return null;
}

const roots: string[] = [];

describe('SHISO agent foundation real App save closure', () => {
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    settingsValues.clear();
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });

  it('runs conversation → USDA → Apply → explicit Save → on-disk reload through the real App', async () => {
    await hydrateAiSelections(settings);
    const rootPath = await mkdtemp(join('/tmp', 'tkc-shiso-agent-app-'));
    roots.push(rootPath);
    const recipePath = join(rootPath, 'Recipes', 'Dinner', 'Nutrition Fixture.md');
    await mkdir(dirname(recipePath), { recursive: true });
    await writeFile(recipePath, nutritionRecipeMarkdown, 'utf8');
    const root = new DiskDirectoryHandle('Disposable SHISO Vault', rootPath);
    (window as unknown as { showDirectoryPicker: () => Promise<DiskDirectoryHandle> }).showDirectoryPicker = async () => root;
    const initial = await loadVaultContent(createBrowserVaultAdapter(root));
    const recipeId = initial.recipes[0]?.id;
    if (recipeId === undefined) throw new Error('fixture recipe was not scanned');

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
    const network = scriptedNetwork([
      { ok: true, kind: 'tool_request', tool: 'search_vault_recipes', args: { tool: 'search_vault_recipes', query: 'Nutrition Fixture', field: 'title', limit: 20 } },
      { ok: true, kind: 'tool_request', tool: 'select_vault_recipe', args: { tool: 'select_vault_recipe', recipe_id: recipeId } },
      { ok: true, kind: 'tool_request', tool: 'load_usda_catalog', args: { tool: 'load_usda_catalog' } },
      { ok: true, kind: 'tool_request', tool: 'run_nutrition_analysis', args: { tool: 'run_nutrition_analysis' } },
      { ok: true, kind: 'reply', text: 'The authenticated nutrition review is ready.', proposals: [] },
      { ok: true, kind: 'tool_request', tool: 'apply_nutrition_review', args: { tool: 'apply_nutrition_review' } },
      { ok: true, kind: 'reply', text: 'Nutrition was applied to the unsaved working recipe.', proposals: [] },
      { ok: true, kind: 'tool_request', tool: 'save_working_recipe', args: { tool: 'save_working_recipe' } },
      { ok: true, kind: 'reply', text: 'The authorized nutrition correction was saved to the Vault.', proposals: [] },
    ], {
      '/api/nutrition/product-access': { ok: true, version: NUTRITION_PRODUCT_ACCESS_VERSION, tier: 'ai_advanced' },
      '/api/providers': { providers: [{ enabled: true, configured: true, available: true, capabilities: { structuredOutput: true } }] },
    });

    render(
      <ShisoEntryProvider>
        <App
          shisoNetworkAdapterOverride={network}
          shisoNutritionBundleLoaderOverride={loader}
          shisoSettingsAdapterOverride={settings}
        />
      </ShisoEntryProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vault' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Live Directory Sync' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Local Obsidian Vault Folder' }));
    await screen.findByText(/Connected live to vault "Disposable SHISO Vault"/);
    expect(screen.getByText('Nutrition Fixture')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Vault settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Chat with SHISO' }));

    const composer = await screen.findByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    const send = async (message: string, reply: string) => {
      fireEvent.change(composer, { target: { value: message } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText(reply);
    };

    await send('Analyze the complete nutrition for this recipe.', 'The authenticated nutrition review is ready.');
    await send('Apply the validated nutrition review.', 'Nutrition was applied to the unsaved working recipe.');
    await send('Save my changes.', 'The authorized nutrition correction was saved to the Vault.');
    expect(loader).toHaveBeenCalledTimes(1);

    const persisted = await loadVaultContent(createBrowserVaultAdapter(root));
    const saved = persisted.recipes.find((recipe) => recipe.title === 'Nutrition Fixture');
    expect(saved?.codexNutrition).toMatchObject({ status: 'complete', sources: ['usda_fdc'] });
    expect((saved?.codexNutrition as { readonly ingredients?: readonly unknown[] } | undefined)?.ingredients).toHaveLength(2);
  }, 90000);

  it('persists standing-authority nutrition through the real App, honors do-not-save, and restores the prior value', async () => {
    await hydrateAiSelections(settings);
    const rootPath = await mkdtemp(join('/tmp', 'tkc-shiso-authority-app-'));
    roots.push(rootPath);
    const recipePath = join(rootPath, 'Recipes', 'Dinner', 'Nutrition Fixture.md');
    await mkdir(dirname(recipePath), { recursive: true });
    await writeFile(recipePath, nutritionRecipeMarkdown, 'utf8');
    const root = new DiskDirectoryHandle('Disposable SHISO Authority Vault', rootPath);
    (window as unknown as { showDirectoryPicker: () => Promise<DiskDirectoryHandle> }).showDirectoryPicker = async () => root;

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
    const network = scriptedNetwork([
      { ok: true, kind: 'reply', text: 'No provider step was required.', proposals: [] },
    ], {
      '/api/nutrition/product-access': { ok: true, version: NUTRITION_PRODUCT_ACCESS_VERSION, tier: 'ai_advanced' },
      '/api/providers': { providers: [] },
    });

    render(
      <ShisoEntryProvider>
        <App
          shisoNetworkAdapterOverride={network}
          shisoNutritionBundleLoaderOverride={loader}
          shisoSettingsAdapterOverride={settings}
        />
      </ShisoEntryProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vault' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Live Directory Sync' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Local Obsidian Vault Folder' }));
    await screen.findByText(/Connected live to vault "Disposable SHISO Authority Vault"/);
    fireEvent.click(screen.getByRole('button', { name: 'Close Vault settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Nutrition Fixture' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Generate Nutrition' }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const authorityToggle = await screen.findByTestId('shiso-nutrition-authority-toggle') as HTMLInputElement;
    expect(authorityToggle.checked).toBe(false);
    fireEvent.click(authorityToggle);
    await waitFor(() => expect(authorityToggle.checked).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Close Advanced Nutrition' }));

    fireEvent.click(await screen.findByTestId('recipe-shiso-entry'));
    const composer = await screen.findByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Fix the missing ingredients in this nutrition review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('Standing nutrition authority applied the reviewed result'));

    let persisted = await loadVaultContent(createBrowserVaultAdapter(root));
    expect(persisted.recipes.find((recipe) => recipe.title === 'Nutrition Fixture')?.codexNutrition)
      .toMatchObject({ status: 'complete', sources: ['usda_fdc'] });

    fireEvent.click(screen.getByRole('button', { name: 'Close Shiso' }));
    const restore = await screen.findByRole('button', { name: 'Restore previous nutrition' });
    fireEvent.click(restore);
    await screen.findByText(/Restored the previous nutrition values/);
    persisted = await loadVaultContent(createBrowserVaultAdapter(root));
    expect(persisted.recipes.find((recipe) => recipe.title === 'Nutrition Fixture')?.codexNutrition).toBeUndefined();

    fireEvent.click(await screen.findByTestId('recipe-shiso-entry'));
    const noSaveComposer = await screen.findByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    const beforeNoSave = await readFile(recipePath, 'utf8');
    fireEvent.change(noSaveComposer, { target: { value: 'Complete the nutrition, but do not save.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('Nothing was applied or saved'));
    expect(await readFile(recipePath, 'utf8')).toBe(beforeNoSave);
  }, 120000);

  it('persists an immediate authenticated Honey selection through the real App without a timing delay', async () => {
    await hydrateAiSelections(settings);
    const rootPath = await mkdtemp(join('/tmp', 'tkc-shiso-execution-app-'));
    roots.push(rootPath);
    const recipePath = join(rootPath, 'Recipes', 'Dinner', 'Honey Selection Fixture.md');
    await mkdir(dirname(recipePath), { recursive: true });
    const markdown = [
      '---', 'title: "Honey Selection Fixture"', 'tags:', '  - food/recipes',
      'category: Dinner', 'servings: 4', '---', '# Honey Selection Fixture',
      '## Ingredients', '- 1/4 cup honey (or brown sugar)', '## Instructions', '1. Stir.', '',
    ].join('\n');
    await writeFile(recipePath, markdown, 'utf8');
    const root = new DiskDirectoryHandle('Disposable SHISO Execution Vault', rootPath);
    (window as unknown as { showDirectoryPicker: () => Promise<DiskDirectoryHandle> }).showDirectoryPicker = async () => root;

    const { manifest, records } = buildMatchingBundle([{
      fdcId: 169640,
      dataType: 'sr_legacy',
      description: 'Honey',
      portions: [{ amount: 1, measure: 'cup', gram_weight: 339, sequence: 1 }],
    }]);
    const created = createAdvancedNutritionSession(manifest, records);
    if (!created.ok) throw new Error('fixture USDA session failed');
    const loader = vi.fn(async (): Promise<RuntimeBundleResult> => ({
      ok: true,
      session: created.session,
      metadata: created.session.metadata(),
      attribution: USDA_ATTRIBUTION,
    }));
    const network = scriptedNetwork([
      { ok: true, kind: 'reply', text: 'Disposable test transport.', proposals: [] },
    ], {
      '/api/nutrition/product-access': { ok: true, version: NUTRITION_PRODUCT_ACCESS_VERSION, tier: 'ai_advanced' },
      '/api/providers': { providers: [] },
    });
    let current: ShisoEntryPoints | null = null;

    render(
      <ShisoEntryProvider>
        <App
          shisoNetworkAdapterOverride={network}
          shisoNutritionBundleLoaderOverride={loader}
          shisoSettingsAdapterOverride={settings}
        />
        <CaptureShiso onReady={(value) => { current = value; }} />
      </ShisoEntryProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Vault' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Live Directory Sync' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Local Obsidian Vault Folder' }));
    await screen.findByText(/Connected live to vault "Disposable SHISO Execution Vault"/);
    fireEvent.click(screen.getByRole('button', { name: 'Close Vault settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Honey Selection Fixture' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate Nutrition' }));
    await screen.findByRole('dialog', { name: 'Advanced Nutrition' });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(current?.canApplyNutritionSourceSelection).toBe(true);
      expect(current?.canApplyNutritionReview).toBe(true);
      expect(current?.snapshot?.reviewRows.length).toBe(1);
    });

    const recipe = (await loadVaultContent(createBrowserVaultAdapter(root))).recipes.find((entry) => entry.title === 'Honey Selection Fixture');
    if (!recipe) throw new Error('disposable recipe was not loaded');
    const adaptation = adaptRecipe(recipe);
    if (!adaptation.ok) throw new Error('recipe adaptation failed');
    const lineRef = adaptation.recipe.adapted[0]!.line_ref;
    const portions = created.session.reviewPortions(169640);
    if (!portions.ok) throw new Error('Honey portions missing');
    const honeyCup = portions.review.candidates.find((candidate) => candidate.gram_weight === 339 && /cup/i.test(candidate.display_label));
    if (!honeyCup) throw new Error('Authenticated Honey cup portion missing');

    let selected!: Awaited<ReturnType<ShisoEntryPoints['applyNutritionSourceSelection']>>;
    let applied!: Awaited<ReturnType<ShisoEntryPoints['applyNutritionReview']>>;
    let saved!: Awaited<ReturnType<ShisoEntryPoints['saveWorkingRecipe']>>;
    await act(async () => {
      selected = await current!.applyNutritionSourceSelection({ lineRef, fdcId: 169640, portionIndex: honeyCup.index });
      applied = await current!.applyNutritionReview();
      saved = await current!.saveWorkingRecipe({ via: 'ui' });
    });
    expect(selected.ok).toBe(true);
    expect(selected).toMatchObject({ fdc_id: 169640, resolved_grams: 84.75 });
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect(saved).toMatchObject({ ok: true, saved: true });

    const persisted = await loadVaultContent(createBrowserVaultAdapter(root));
    const nutrition = persisted.recipes.find((entry) => entry.title === 'Honey Selection Fixture')?.codexNutrition;
    expect(nutrition).toMatchObject({ status: 'complete', sources: ['usda_fdc'] });
    const serialized = JSON.stringify(nutrition);
    expect(serialized).toContain('"source_food_id":"169640"');
    expect(serialized).toContain('"value":84.75');
  }, 120000);
});
