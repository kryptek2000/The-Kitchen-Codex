import { describe, it, expect } from 'vitest';
import {
  parseFractionToDecimal,
  formatAmount,
  cleanRecipeTitle,
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
} from '../../src/utils/markdownParser';

describe('Markdown Parser & Serializer', () => {
  describe('parseFractionToDecimal', () => {
    it('parses integers correctly', () => {
      expect(parseFractionToDecimal('2')).toBe(2);
      expect(parseFractionToDecimal('10')).toBe(10);
    });

    it('parses unicode fractions correctly', () => {
      expect(parseFractionToDecimal('½')).toBe(0.5);
      expect(parseFractionToDecimal('1 ½')).toBe(1.5);
      expect(parseFractionToDecimal('2 ¾')).toBe(2.75);
      expect(parseFractionToDecimal('¼')).toBe(0.25);
    });

    it('parses ASCII fractions correctly', () => {
      expect(parseFractionToDecimal('1/2')).toBe(0.5);
      expect(parseFractionToDecimal('3/4')).toBe(0.75);
      expect(parseFractionToDecimal('1 1/2')).toBe(1.5);
      expect(parseFractionToDecimal('2 1/4')).toBe(2.25);
    });

    it('returns null for empty strings or invalid input', () => {
      expect(parseFractionToDecimal('')).toBeNull();
      expect(parseFractionToDecimal('abc')).toBeNull();
    });
  });

  describe('formatAmount', () => {
    it('formats common cooking fractions', () => {
      expect(formatAmount(0.5)).toBe('1/2');
      expect(formatAmount(1.5)).toBe('1 1/2');
      expect(formatAmount(0.25)).toBe('1/4');
      expect(formatAmount(2.75)).toBe('2 3/4');
      expect(formatAmount(3)).toBe('3');
    });

    it('returns empty string for zero or negative values', () => {
      expect(formatAmount(0)).toBe('');
      expect(formatAmount(-1)).toBe('');
    });
  });

  describe('cleanRecipeTitle', () => {
    it('cleans wikilinks in titles', () => {
      expect(cleanRecipeTitle('[[Classic Margherita Pizza]]')).toBe('Classic Margherita Pizza');
      expect(cleanRecipeTitle('[[Classic Margherita Pizza|Margherita Pizza]]')).toBe('Margherita Pizza');
    });

    it('cleans markdown links in titles', () => {
      expect(cleanRecipeTitle('[Tacos](https://example.com/recipe)')).toBe('Tacos');
    });

    it('falls back to fileName without extension if title is blank', () => {
      expect(cleanRecipeTitle('', 'Chicken Tikka Masala.md')).toBe('Chicken Tikka Masala');
    });
  });

  describe('parseObsidianRecipeMarkdown & serializeRecipeToObsidianMarkdown', () => {
    const rawMarkdown = `---
title: Homemade Sourdough Bread
tags:
  - baking
  - bread
cuisine: French
category: Baking & Breads
servings: 8
prepTime: 30 mins
cookTime: 45 mins
difficulty: Medium
rating: 5
---

# Homemade Sourdough Bread

A rustic artisan loaf with a golden crispy crust.

## Ingredients
- 500g [[Bread Flour]]
- 350g Water
- 100g Active Sourdough Starter
- 10g Salt

## Instructions
1. Mix flour, water, and sourdough starter.
2. Rest for 30 minutes, then add salt.
3. Shape into a round boule and bake at 450°F (230°C) for 45 minutes.

## Notes
Allow the loaf to cool completely on a wire rack before slicing.
`;

    it('parses valid recipe markdown into an ObsidianRecipe object', () => {
      const parsed = parseObsidianRecipeMarkdown(rawMarkdown, 'sourdough.md', 'Recipes/sourdough.md');
      expect(parsed).not.toBeNull();
      if (!parsed) return;

      expect(parsed.title).toBe('Homemade Sourdough Bread');
      expect(parsed.tags).toContain('baking');
      expect(parsed.tags).toContain('bread');
      expect(parsed.servings).toBe(8);
      expect(parsed.ingredients.length).toBe(4);
      expect(parsed.instructions.length).toBe(3);
      expect(parsed.wikilinks).toContain('Bread Flour');
      expect(parsed.notes).toContain('Allow the loaf to cool completely');
    });

    it('preserves essential fields during serialization', () => {
      const parsed = parseObsidianRecipeMarkdown(rawMarkdown, 'sourdough.md', 'Recipes/sourdough.md');
      expect(parsed).not.toBeNull();
      if (!parsed) return;

      const serialized = serializeRecipeToObsidianMarkdown(parsed);
      expect(serialized).toContain('title: Homemade Sourdough Bread');
      expect(serialized).toContain('500g');
      expect(serialized).toContain('Mix flour, water, and sourdough starter.');
    });
  });
});
