// @vitest-environment jsdom
/**
 * R1 — folder imports are complete collection replacements.
 *
 * A folder selection must replace recipes, notes, Meal Plan, and Shopping List
 * even when the folder is empty. Parsing failures must leave the active
 * collection untouched. All imports here are read-only in-memory uploads; no
 * disk write is possible or claimed.
 */

import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../src/App';
import { ConnectVaultModal } from '../../src/components/ConnectVaultModal';
import type { MealPlanDay, ObsidianRecipe, ShoppingCategoryGroup, VaultNote, VaultSyncStatus } from '../../src/types';

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
  window.history.replaceState(null, '', '#/');
});

const OLD_RECIPE = {
  id: 'Old Recipe.md',
  title: 'Old Recipe',
  fileName: 'Old Recipe.md',
  filePath: 'Old Recipe.md',
  rawMarkdown: '',
  tags: [],
  ingredients: [],
  instructions: [],
  callouts: [],
  dataviewFields: {},
  wikilinks: [],
} as unknown as ObsidianRecipe;

const OLD_NOTE = {
  id: 'Old Note.md',
  title: 'Old Note',
  fileName: 'Old Note.md',
  filePath: 'Old Note.md',
  rawMarkdown: '',
  tags: [],
  content: '',
} as unknown as VaultNote;

const OLD_PLAN: MealPlanDay[] = [{ dayName: 'Monday', dinner: { recipeTitle: 'Old Recipe' } }];
const OLD_SHOPPING: ShoppingCategoryGroup[] = [
  { category: 'Old Category', items: [{ id: 'old-1', text: 'old item', recipeSources: ['Old Recipe'], isChecked: false }] },
];

function uploadFile(name: string, webkitRelativePath: string, content: string, fail = false): File {
  return {
    name,
    webkitRelativePath,
    text: async () => {
      if (fail) throw new Error('unreadable file');
      return content;
    },
  } as unknown as File;
}

const RECIPE_MD = `---
title: Fresh Pasta
cuisine: Italian
tags:
  - food/recipes
---
# Fresh Pasta
## Ingredients
- 2 cups flour
## Instructions
1. Knead and cook.
`;

const NOTE_MD = `---
title: "Kitchen Notes"
tags:
  - technique
---

# Kitchen Notes

A reference note about cooking technique.
`;

const MEAL_PLAN_MD = `---
type: meal-plan
---
## Monday
- **Dinner**: [[Fresh Pasta]]
`;

const SHOPPING_LIST_MD = `---
type: shopping-list
---
## Produce
- [ ] tomatoes
`;

interface HarnessState {
  recipes: ObsidianRecipe[];
  notes: VaultNote[];
  mealPlan: MealPlanDay[];
  shopping: ShoppingCategoryGroup[];
  activated: number;
  vaultStatus: VaultSyncStatus;
}

function Harness() {
  const [recipes, setRecipes] = useState<ObsidianRecipe[]>([OLD_RECIPE]);
  const [notes, setNotes] = useState<VaultNote[]>([OLD_NOTE]);
  const [mealPlan, setMealPlan] = useState<MealPlanDay[]>(OLD_PLAN);
  const [shopping, setShopping] = useState<ShoppingCategoryGroup[]>(OLD_SHOPPING);
  const [activated, setActivated] = useState(0);
  const [vaultStatus, setVaultStatus] = useState<VaultSyncStatus>({
    isConnected: false,
    vaultPath: 'Vault / Previous',
    accessType: 'uploaded_folder',
    connectionState: 'starter',
  });

  const state: HarnessState = { recipes, notes, mealPlan, shopping, activated, vaultStatus };
  return (
    <div>
      <output data-testid="harness-state">{JSON.stringify({
        recipeTitles: state.recipes.map((recipe) => recipe.title),
        noteTitles: state.notes.map((note) => note.title),
        planDays: state.mealPlan.map((day) => day.dayName),
        shoppingCategories: state.shopping.map((group) => group.category),
        activated: state.activated,
        accessType: state.vaultStatus.accessType,
        connectionState: state.vaultStatus.connectionState,
      })}</output>
      <ConnectVaultModal
        isOpen
        onClose={vi.fn()}
        vaultStatus={vaultStatus}
        setVaultStatus={setVaultStatus}
        recipes={recipes}
        setRecipes={setRecipes}
        setMealPlan={setMealPlan}
        setShoppingCategories={setShopping}
        setNotes={setNotes}
        onImportedCollectionActivated={() => setActivated((value) => value + 1)}
      />
    </div>
  );
}

function harnessState(): any {
  return JSON.parse(screen.getByTestId('harness-state').textContent || '{}');
}

function folderInput(): HTMLInputElement {
  return document.querySelector('input[webkitdirectory]') as HTMLInputElement;
}

function selectFolder(files: File[]): void {
  const input = folderInput();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('folder import replaces the complete active collection', () => {
  it('accepts an empty folder and removes all previous recipes and notes', async () => {
    render(<Harness />);
    selectFolder([]);

    await waitFor(() => expect(harnessState().activated).toBe(1));
    const state = harnessState();
    expect(state.recipeTitles).toEqual([]);
    expect(state.noteTitles).toEqual([]);
    expect(state.planDays).toEqual([]);
    expect(state.shoppingCategories).toEqual([]);
    expect(state.accessType).toBe('uploaded_folder');
    expect(screen.getByText(/selected folder is empty/i)).toBeTruthy();
    expect(screen.getByText(/No files were written/i)).toBeTruthy();
  });

  it('imports a notes-only folder as an empty recipe collection', async () => {
    render(<Harness />);
    selectFolder([uploadFile('Kitchen Notes.md', 'MyVault/Kitchen Notes.md', NOTE_MD)]);

    await waitFor(() => expect(harnessState().activated).toBe(1));
    const state = harnessState();
    expect(state.recipeTitles).toEqual([]);
    expect(state.noteTitles).toEqual(['Kitchen Notes']);
    expect(state.planDays).toEqual([]);
    expect(state.shoppingCategories).toEqual([]);
    expect(screen.getByText(/0 recipes and 1 note/i)).toBeTruthy();
    expect(screen.getByText(/no Meal Plan\.md/i)).toBeTruthy();
    expect(screen.getByText(/no Shopping List\.md/i)).toBeTruthy();
    expect(screen.getByText(/no files were written/i)).toBeTruthy();
  });

  it('replaces a Meal Plan-only import and clears old shopping data', async () => {
    render(<Harness />);
    selectFolder([uploadFile('Meal Plan.md', 'MyVault/Meal Plan.md', MEAL_PLAN_MD)]);

    await waitFor(() => expect(harnessState().activated).toBe(1));
    const state = harnessState();
    expect(state.recipeTitles).toEqual([]);
    expect(state.noteTitles).toEqual([]);
    expect(state.planDays).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    expect(state.shoppingCategories).toEqual([]);
    expect(screen.getByText(/Meal Plan\.md loaded/i)).toBeTruthy();
    expect(screen.getByText(/no Shopping List\.md/i)).toBeTruthy();
  });

  it('replaces a Shopping List-only import and clears the old plan', async () => {
    render(<Harness />);
    selectFolder([uploadFile('Shopping List.md', 'MyVault/Shopping List.md', SHOPPING_LIST_MD)]);

    await waitFor(() => expect(harnessState().activated).toBe(1));
    const state = harnessState();
    expect(state.recipeTitles).toEqual([]);
    expect(state.noteTitles).toEqual([]);
    expect(state.planDays).toEqual([]);
    expect(state.shoppingCategories).toEqual(['Produce']);
    expect(screen.getByText(/no Meal Plan\.md/i)).toBeTruthy();
    expect(screen.getByText(/Shopping List\.md loaded/i)).toBeTruthy();
  });

  it('imports ordinary personal recipes and clears prior plan/shopping data', async () => {
    render(<Harness />);
    selectFolder([uploadFile('Fresh Pasta.md', 'MyVault/Fresh Pasta.md', RECIPE_MD)]);

    await waitFor(() => expect(harnessState().activated).toBe(1));
    const state = harnessState();
    expect(state.recipeTitles).toEqual(['Fresh Pasta']);
    expect(state.noteTitles).toEqual([]);
    expect(state.planDays).toEqual([]);
    expect(state.shoppingCategories).toEqual([]);
  });

  it('replaces one imported collection with the next folder', async () => {
    render(<Harness />);
    selectFolder([uploadFile('Fresh Pasta.md', 'MyVault/Fresh Pasta.md', RECIPE_MD)]);
    await waitFor(() => expect(harnessState().recipeTitles).toEqual(['Fresh Pasta']));

    selectFolder([uploadFile('Kitchen Notes.md', 'OtherVault/Kitchen Notes.md', NOTE_MD)]);
    await waitFor(() => expect(harnessState().noteTitles).toEqual(['Kitchen Notes']));
    const state = harnessState();
    expect(state.recipeTitles).toEqual([]);
    expect(state.planDays).toEqual([]);
    expect(state.shoppingCategories).toEqual([]);
    expect(state.activated).toBe(2);
  });

  it('keeps the active collection intact when parsing fails', async () => {
    render(<Harness />);
    selectFolder([uploadFile('Broken.md', 'MyVault/Broken.md', '', true)]);

    await waitFor(() => expect(screen.getByText(/unreadable file/i)).toBeTruthy());
    const state = harnessState();
    expect(state.recipeTitles).toEqual(['Old Recipe']);
    expect(state.noteTitles).toEqual(['Old Note']);
    expect(state.planDays).toEqual(['Monday']);
    expect(state.shoppingCategories).toEqual(['Old Category']);
    expect(state.activated).toBe(0);
  });
});

describe('first-run to empty imported Vault transition', () => {
  it('shows no starter templates after an empty folder import', async () => {
    render(<App />);
    await screen.findByText('Artisan Sourdough Boule');
    await waitFor(() => expect(document.querySelectorAll('[data-testid="builtin-card-badge"]').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Connect Vault/i }));
    await waitFor(() => expect(document.querySelector('input[webkitdirectory]')).toBeTruthy());
    selectFolder([]);
    await waitFor(() => expect(screen.getByText(/selected folder is empty/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Close Vault settings' }));
    await waitFor(() => expect(document.getElementById('vault-recipe-count')?.textContent).toBe('0 recipes'));
    expect(document.getElementById('vault-page-title')?.textContent).toBe('My Recipe Vault');
    expect(document.querySelectorAll('[data-testid="builtin-card-badge"]').length).toBe(0);
    expect(screen.queryByText('Artisan Sourdough Boule')).toBeNull();
    expect(screen.getByText('No recipes in this Vault yet')).toBeTruthy();
  });
});
