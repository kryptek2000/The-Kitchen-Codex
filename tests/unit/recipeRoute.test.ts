/**
 * The Kitchen Codex — stable recipe-detail route restoration.
 *
 * Pure route grammar + round-trip coverage. The App-level restoration behavior
 * is exercised separately in `recipeRouteRestoration.test.tsx`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildGalleryRoute,
  buildRecipeRoute,
  parseRecipeRoute,
} from '../../src/utils/recipeRoute';

describe('recipe route grammar', () => {
  it('builds and parses a recipe route (round trip)', () => {
    const id = 'Recipes/Dinner/Taco Night.md';
    const route = buildRecipeRoute(id);
    expect(route.startsWith('#/recipe/')).toBe(true);
    expect(parseRecipeRoute(route)).toEqual({ kind: 'recipe', id });
  });

  it('preserves spaces and special characters in recipe ids', () => {
    for (const id of [
      'My Recipe #1.md',
      'café/über-bowl.md',
      'a&b=c?d.md',
      '日本語のレシピ.md',
      'emoji 🍜 soup.md',
    ]) {
      expect(parseRecipeRoute(buildRecipeRoute(id))).toEqual({ kind: 'recipe', id });
    }
  });

  it('treats the gallery route as gallery', () => {
    expect(parseRecipeRoute(buildGalleryRoute())).toEqual({ kind: 'gallery' });
  });

  it('treats unknown / malformed fragments as gallery (never a different recipe)', () => {
    expect(parseRecipeRoute('')).toEqual({ kind: 'gallery' });
    expect(parseRecipeRoute('#')).toEqual({ kind: 'gallery' });
    expect(parseRecipeRoute('#/recipe/')).toEqual({ kind: 'gallery' });
    expect(parseRecipeRoute('#/recipe/%E0%A4%A')).toEqual({ kind: 'gallery' });
    expect(parseRecipeRoute('#/other/thing')).toEqual({ kind: 'gallery' });
    expect(parseRecipeRoute(undefined)).toEqual({ kind: 'gallery' });
    expect(parseRecipeRoute(42)).toEqual({ kind: 'gallery' });
  });

  it('is deterministic and injective for distinct ids', () => {
    const a = buildRecipeRoute('x');
    const b = buildRecipeRoute('y');
    expect(a).not.toBe(b);
    expect(parseRecipeRoute(a)).not.toEqual(parseRecipeRoute(b));
  });
});
