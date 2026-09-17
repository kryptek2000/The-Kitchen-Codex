import { describe, it, expect } from 'vitest';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { clampResultLimit, rankCandidates } from '../../src/core/nutritionV2/matching/rank';
import {
  MAX_RESULT_LIMIT,
  type RankableEntry,
} from '../../src/core/nutritionV2/matching/types';
import { createReviewCatalog, reviewIngredient } from '../../src/core/nutritionV2/matching/review';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';

/**
 * Phase 4.5D — anchor enforcement, contradictions, qualifier conflicts, aliases,
 * determinism, and no-padding.
 */

function entry(fdcId: number, description: string, dataType: UsdaDataType = 'fndds'): RankableEntry {
  const normalized = normalizeQuery(description);
  return {
    fdc_id: fdcId,
    data_type: dataType,
    description,
    normalized_description: normalized.text,
    normalized_tokens: normalized.tokens,
    record_digest: 'a'.repeat(64),
  };
}

function ids(query: string, entries: RankableEntry[], limit = MAX_RESULT_LIMIT): number[] {
  return rankCandidates(normalizeQuery(query), entries, limit).map((c) => c.fdc_id);
}

describe('phase 4.5d rank — required anchors', () => {
  it('excludes candidates that only share a preparation word', () => {
    const entries = [
      entry(1, 'Beef, ground, raw'),
      entry(2, 'Spices, pepper, black'),
      entry(3, 'Peppers, bell, green, raw'),
    ];
    // `ground` must not pull in ground beef for a black-pepper query.
    expect(ids('ground black pepper', entries)).toEqual([2, 3]);
  });

  it('excludes shredded non-lettuce foods for a lettuce query', () => {
    const entries = [entry(1, 'Cheese, parmesan, shredded'), entry(2, 'Lettuce, iceberg, raw')];
    expect(ids('shredded lettuce', entries)).toEqual([2]);
  });

  it('returns fewer than the limit rather than padding with weak results', () => {
    const entries = [entry(1, 'Beef, ground, raw'), entry(2, 'Pork, cured, bacon')];
    expect(ids('lettuce', entries)).toEqual([]);
    expect(ids('lettuce', entries, 10)).toHaveLength(0);
  });

  it('enforces the approved morphological equivalent for the anchor', () => {
    const entries = [entry(1, 'Tomato, roma'), entry(2, 'Tomatoes, raw'), entry(3, 'Rye flour')];
    const result = ids('medium tomatoes, sliced', entries);
    expect(result).toContain(1);
    expect(result).toContain(2);
    expect(result).not.toContain(3);
  });
});

describe('phase 4.5d rank — contradictions', () => {
  it('never rewards a negated occurrence', () => {
    const entries = [
      entry(1, 'Kale, frozen, cooked, without salt'),
      entry(2, 'Salt, table, iodized'),
      entry(3, 'Pumpkin, canned, without salt'),
      entry(4, 'Butter, stick, unsalted'),
    ];
    const result = ids('kosher salt', entries);
    expect(result).toEqual([2]);
  });

  it('honors an explicit negation requested by the query', () => {
    const entries = [entry(1, 'Butter, unsalted'), entry(2, 'Butter, salted')];
    const result = ids('unsalted butter', entries);
    expect(result[0]).toBe(1);
    expect(result).toContain(2);
  });

  it('never rewards a forward-negated occurrence (`salt not added`)', () => {
    const entries = [
      entry(1, 'Potatoes, french fried, salt not added in processing, frozen, unprepared'),
      entry(2, 'Salt, table'),
      entry(3, 'Gelatin desserts, dry mix, no salt added'),
    ];
    expect(ids('kosher salt', entries)).toEqual([2]);
  });

  it('does not treat a food prepared `with X` as X', () => {
    const entries = [
      entry(1, 'Tuna salad, made with mayonnaise'),
      entry(2, 'Mayonnaise, regular'),
      entry(3, 'Pumpkin, canned, with salt'),
    ];
    expect(ids('mayonnaise', entries)).toEqual([2]);
    expect(ids('salt', entries)).toEqual([]);
  });
});

describe('phase 4.5d rank — identity-changing qualifiers', () => {
  it('ranks generic bacon above meatless/turkey/beef/canadian/bits/reduced variants', () => {
    const entries = [
      entry(10, 'Pork, cured, bacon, unprepared'),
      entry(11, 'Bacon, meatless'),
      entry(12, 'Bacon, turkey, microwaved'),
      entry(13, 'Beef, bacon, cooked'),
      entry(14, 'Canadian bacon, unprepared'),
      entry(15, 'Bacon bits, meatless'),
      entry(16, 'Bacon, pre-sliced, reduced/low sodium, unprepared'),
    ];
    const result = ids('bacon', entries);
    expect(result[0]).toBe(10);
    for (const variant of [11, 12, 13, 14, 15, 16]) {
      expect(result.indexOf(variant)).toBeGreaterThan(result.indexOf(10));
    }
  });

  it('requests a variant explicitly and lets it win', () => {
    const entries = [entry(1, 'Bacon, turkey, microwaved'), entry(2, 'Pork, cured, bacon, unprepared')];
    expect(ids('turkey bacon', entries)[0]).toBe(1);
  });

  it('prefers the plain ingredient over a different dish form', () => {
    const entries = [
      entry(1, 'Bacon biscuit sandwich'),
      entry(2, 'Pork, cured, bacon, unprepared'),
      entry(3, 'Soup, tomato'),
      entry(4, 'Tomatoes, raw'),
    ];
    expect(ids('bacon', entries)[0]).toBe(2);
    expect(ids('tomatoes', entries)[0]).toBe(4);
  });
});

describe('phase 4.5d rank — qualifier agreement (numeric)', () => {
  it('prefers an explicitly requested ratio', () => {
    const entries = [
      entry(1, 'Beef, ground, raw'),
      entry(2, 'Beef, ground, 80% lean meat / 20% fat, raw'),
      entry(3, 'Beef, ground, 80% lean meat / 20% fat, patty, cooked'),
    ];
    const result = ids('ground beef 80 20', entries);
    expect(result[0]).toBe(2);
    expect(result.indexOf(2)).toBeLessThan(result.indexOf(1));
    expect(result.indexOf(2)).toBeLessThan(result.indexOf(3));
  });
});

describe('phase 4.5d rank — aliases', () => {
  it('uses the bounded burger-bun alias for retrieval evidence', () => {
    const entries = [
      entry(1, 'Roll, white, hamburger bun'),
      entry(2, 'Hamburger, NFS'),
      entry(3, 'Hamburger, on white bun, 1 small patty'),
    ];
    const result = ids('burger buns', entries);
    expect(result).toContain(1);
    expect(result).not.toContain(2);
  });

  it('never auto-authorizes an alias-derived exact match', () => {
    const { manifest, records } = buildMatchingBundle([
      { fdcId: 9001, dataType: 'fndds', description: 'Roll, white, hamburger bun' },
    ]);
    const catalogResult = createReviewCatalog(manifest, records);
    if (!catalogResult.ok) throw new Error('catalog failed');
    const review = reviewIngredient(catalogResult.catalog, { name: 'burger buns' });
    expect(review.outcome).toBe('review_required');
    expect(review.normalized_query).toBe('burger buns');
  });
});

describe('phase 4.5d rank — determinism and safety', () => {
  it('is independent of input order and uses a stable FDC tie-break', () => {
    const entries = [
      entry(3, 'Milk, whole'),
      entry(1, 'Milk, whole'),
      entry(2, 'Milk, whole'),
    ];
    const a = ids('milk whole', entries);
    const b = ids('milk whole', [...entries].reverse());
    expect(a).toEqual(b);
    expect(a).toEqual([1, 2, 3]);
  });

  it('caps results and clamps a manipulated limit', () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(i + 1, 'Milk, whole'));
    expect(ids('milk whole', entries, 3)).toHaveLength(3);
    expect(clampResultLimit(999)).toBe(MAX_RESULT_LIMIT);
    expect(clampResultLimit(-5)).toBe(10);
    expect(clampResultLimit(Number.NaN)).toBe(10);
  });

  it('carries no nutrient values and does not mutate inputs', () => {
    const entries = [entry(1, 'Milk, whole')];
    const before = JSON.stringify(entries);
    const result = rankCandidates(normalizeQuery('milk whole'), entries, 10);
    expect(JSON.stringify(result)).not.toMatch(/nutrient|calorie|protein|amount_per_100g/i);
    expect(JSON.stringify(entries)).toBe(before);
  });
});
