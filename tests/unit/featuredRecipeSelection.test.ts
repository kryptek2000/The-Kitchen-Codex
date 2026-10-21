import { describe, it, expect } from 'vitest';
import { selectFeaturedRecipe, splitFeatured } from '../../src/utils/featuredRecipe';

describe('Featured recipe selection (RV-2 / UD-2A)', () => {
  const recipes = [
    { id: 'a', isFavorite: false, title: 'A' },
    { id: 'b', isFavorite: true, title: 'B' },
    { id: 'c', isFavorite: true, title: 'C' },
    { id: 'd', isFavorite: false, title: 'D' },
  ];

  it('prefers the first eligible favorite in current order', () => {
    expect(selectFeaturedRecipe(recipes)?.id).toBe('b');
  });

  it('falls back to the first recipe when no favorites exist', () => {
    const noFav = recipes.map((r) => ({ ...r, isFavorite: false }));
    expect(selectFeaturedRecipe(noFav)?.id).toBe('a');
  });

  it('returns undefined for an empty collection', () => {
    expect(selectFeaturedRecipe([])).toBeUndefined();
  });

  it('splitFeatured excludes only the selected instance, not all sharing an id', () => {
    const dup = [
      { id: 'x', isFavorite: true, title: 'X1' },
      { id: 'x', isFavorite: false, title: 'X2' },
    ];
    const { featured, rest } = splitFeatured(dup);
    expect(featured?.title).toBe('X1');
    expect(rest).toHaveLength(1);
    expect(rest[0].title).toBe('X2');
  });

  it('handles multiple favorites deterministically (first in order)', () => {
    const { featured, rest } = splitFeatured(recipes);
    expect(featured?.id).toBe('b');
    expect(rest.map((r) => r.id)).toEqual(['a', 'c', 'd']);
  });

  it('strict favorite selection: truthy non-boolean does not override stable fallback', () => {
    const loose = [
      { id: 'y', isFavorite: false, title: 'Y' },
      { id: 'x', isFavorite: 1 as any, title: 'X' },
    ];
    // 1 is not strictly true, so the stable fallback (first recipe 'y') wins.
    // A faulty truthiness-based implementation would select 'x'.
    expect(selectFeaturedRecipe(loose as any)?.id).toBe('y');
  });

  it('does not mutate the input array', () => {
    const input = recipes.map((r) => ({ ...r }));
    const before = input.map((r) => r.id);
    splitFeatured(input);
    expect(input.map((r) => r.id)).toEqual(before);
  });

  it('empty input yields empty rest', () => {
    const { featured, rest } = splitFeatured([]);
    expect(featured).toBeUndefined();
    expect(rest).toEqual([]);
  });

  it('stable fallback when all favorites removed', () => {
    const withoutFav = recipes.map((r) => ({ ...r, isFavorite: false }));
    expect(selectFeaturedRecipe(withoutFav)?.id).toBe('a');
  });

  it('respects current sort/filter order (first favorite in order wins)', () => {
    const sorted = [...recipes].reverse();
    expect(selectFeaturedRecipe(sorted)?.id).toBe('c');
  });

  it('no-favorite split: first recipe featured, rest contains every other exactly once', () => {
    const input = [
      { id: 'a', isFavorite: false, title: 'A' },
      { id: 'b', isFavorite: false, title: 'B' },
      { id: 'c', isFavorite: false, title: 'C' },
    ];
    const before = input.map((r) => ({ ...r }));
    const { featured, rest } = splitFeatured(input);
    expect(featured?.id).toBe('a');
    expect(rest).toHaveLength(input.length - 1);
    expect(rest.map((r) => r.id)).toEqual(['b', 'c']);
    expect(rest.some((r) => r.id === featured?.id)).toBe(false);
    // no mutation
    expect(input.map((r) => r.id)).toEqual(before.map((r) => r.id));
    input.forEach((r, i) => {
      expect(r).toEqual(before[i]);
    });
  });
});