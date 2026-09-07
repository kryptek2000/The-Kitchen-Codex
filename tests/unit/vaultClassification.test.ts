/**
 * The Kitchen Codex — Vault Markdown Classification Parity (Phase 4C3A).
 *
 * Domain-only tests for `classifyVaultMarkdown` using representative Markdown
 * sources. Proves the shared, platform-neutral classifier reproduces the same
 * classification and content fields as the (now-reused) legacy logic:
 *   root + nested recipes, ordinary notes, Meal Plan.md, Shopping List.md,
 *   custom frontmatter, wikilinks, and unknown metadata.
 *
 * No FileSystemHandle, no window, no DOM, no vaultAssets — purely the canonical
 * markdown parser.
 */

import { describe, it, expect } from 'vitest';
import { classifyVaultMarkdown } from '../../src/core/vaultClassification';

const RECIPE_MD = `---
title: "Lasagna"
cuisine: "Italian"
category: "Dinner"
tags:
  - food/recipes
  - italian
rating: 4
source: "https://example.com/lasagna"
author: "Chef Anna"
x_custom_metadata: "kept-verbatim"
---

# Lasagna

Serve with [[Tomatoes]] and [[Fresh Basil]].

## 🥘 Ingredients
- 1 cup flour

## 🍳 Instructions
1. Bake at 350.
`;

const NOTE_MD = `---
title: "Garlic Guide"
tags:
  - technique
---

# Garlic Guide

A reference note about garlic.
`;

const MEAL_PLAN_MD = `---
type: meal-plan
---

## Monday
- **Dinner**: [[Lasagna]]
`;

const SHOPPING_LIST_MD = `---
type: shopping-list
---

## Produce
- [ ] tomatoes
- [ ] basil
`;

describe('vault markdown classification (Phase 4C3A)', () => {
  it('classifies a nested recipe and preserves filePath + fileName', () => {
    const result = classifyVaultMarkdown({
      path: 'Recipes/Italian/Lasagna.md',
      name: 'Lasagna.md',
      markdown: RECIPE_MD,
    });
    expect(result.kind).toBe('recipe');
    if (result.kind !== 'recipe') return;
    // Logical identity/location is owned by the vault-relative filePath.
    expect(result.recipe.filePath).toBe('Recipes/Italian/Lasagna.md');
    expect(result.recipe.fileName).toBe('Lasagna.md');
    expect(result.recipe.title).toBe('Lasagna');
    expect(result.recipe.cuisine).toBe('Italian');
    expect(result.recipe.category).toBe('Dinner');
    expect(result.recipe.ingredients.length).toBe(1);
    expect(result.recipe.instructions.length).toBe(1);
  });

  it('preserves custom frontmatter, wikilinks and unknown metadata', () => {
    const result = classifyVaultMarkdown({
      path: 'Recipes/Lasagna.md',
      name: 'Lasagna.md',
      markdown: RECIPE_MD,
    });
    expect(result.kind).toBe('recipe');
    if (result.kind !== 'recipe') return;
    expect(result.recipe.frontmatter?.['x_custom_metadata']).toBe('kept-verbatim');
    expect(result.recipe.frontmatter?.['author']).toBe('Chef Anna');
    expect(result.recipe.wikilinks).toEqual(expect.arrayContaining(['Tomatoes', 'Fresh Basil']));
  });

  it('classifies a root recipe', () => {
    const result = classifyVaultMarkdown({ path: 'Lasagna.md', name: 'Lasagna.md', markdown: RECIPE_MD });
    expect(result.kind).toBe('recipe');
    if (result.kind !== 'recipe') return;
    expect(result.recipe.filePath).toBe('Lasagna.md');
    expect(result.recipe.fileName).toBe('Lasagna.md');
  });

  it('classifies an ordinary note (no ingredients/instructions, no recipe tag)', () => {
    const result = classifyVaultMarkdown({ path: 'Notes/Garlic Guide.md', name: 'Garlic Guide.md', markdown: NOTE_MD });
    expect(result.kind).toBe('note');
    if (result.kind !== 'note') return;
    expect(result.note.filePath).toBe('Notes/Garlic Guide.md');
    expect(result.note.fileName).toBe('Garlic Guide.md');
    expect(result.note.title).toBe('Garlic Guide');
  });

  it('classifies Meal Plan.md exactly as before (never as a recipe)', () => {
    const result = classifyVaultMarkdown({ path: 'Meal Plan.md', name: 'Meal Plan.md', markdown: MEAL_PLAN_MD });
    expect(result.kind).toBe('mealPlan');
    if (result.kind !== 'mealPlan') return;
    expect(Array.isArray(result.mealPlan)).toBe(true);
    expect(result.mealPlan[0].dayName).toBe('Monday');
    expect(result.mealPlan[0].dinner?.recipeTitle).toBe('Lasagna');
  });

  it('classifies Shopping List.md exactly as before', () => {
    const result = classifyVaultMarkdown({
      path: 'Shopping List.md',
      name: 'Shopping List.md',
      markdown: SHOPPING_LIST_MD,
    });
    expect(result.kind).toBe('shoppingList');
    if (result.kind !== 'shoppingList') return;
    expect(result.shoppingList[0].category).toBe('Produce');
    expect(result.shoppingList[0].items.map((i) => i.text)).toEqual(['tomatoes', 'basil']);
  });

  it('detects meal-plan/shopping-list by lower-cased filename', () => {
    const alt = {
      path: 'Meal-Plan.md',
      name: 'Meal-Plan.md',
      markdown: MEAL_PLAN_MD,
    };
    expect(classifyVaultMarkdown(alt).kind).toBe('mealPlan');
    const altShop = { path: 'shopping-list.md', name: 'shopping-list.md', markdown: SHOPPING_LIST_MD };
    expect(classifyVaultMarkdown(altShop).kind).toBe('shoppingList');
  });

  it('is pure: classification carries no FileSystemHandle', () => {
    const result = classifyVaultMarkdown({ path: 'Recipes/Lasagna.md', name: 'Lasagna.md', markdown: RECIPE_MD });
    if (result.kind === 'recipe') {
      expect(result.recipe.fileHandle).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain('FileSystem');
  });
});
