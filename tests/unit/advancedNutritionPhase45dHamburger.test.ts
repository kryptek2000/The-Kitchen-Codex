import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  composeAdvancedNutritionSessionFromBundle,
  type RuntimeBundleInputs,
  type RuntimeBundleResult,
} from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { evaluateEligibility } from '../../src/core/nutritionV2/matching/eligibility';
import type { IngredientReviewResult } from '../../src/core/nutritionV2/matching/types';

/**
 * Phase 4.5D — the required hamburger acceptance corpus against the exact
 * checked-in USDA bundle. This is the authoritative end-to-end matching
 * acceptance (no calculation; count lines stay no_mass).
 */

const LOCK = USDA_BUNDLE_RELEASE_LOCK;
const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

const HAMBURGER_LINES: ReadonlyArray<string> = [
  '1 pound ground beef (80/20), formed into 4 patties',
  '1 teaspoon kosher salt',
  '0.5 teaspoon ground black pepper',
  '8 slices bacon',
  '4 slices cheddar cheese',
  '4 burger buns',
  '1 cup shredded lettuce',
  '2 medium tomatoes, sliced',
  '4 pickles, sliced',
  '2 tablespoons mayonnaise',
  '1 tablespoon ketchup',
];

function structured(line: string) {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

let loaded: RuntimeBundleResult;

beforeAll(async () => {
  const inputs: RuntimeBundleInputs = {
    files: LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
}, 120000);

function review(line: string): IngredientReviewResult {
  if (!loaded.ok) throw new Error('bundle failed');
  return loaded.session.reviewIngredient(structured(line));
}

function descriptions(reviewResult: IngredientReviewResult): string[] {
  return reviewResult.candidates.map((c) => c.description);
}

function rankOf(reviewResult: IngredientReviewResult, fdcId: number): number {
  return reviewResult.candidates.findIndex((c) => c.fdc_id === fdcId);
}

describe('phase 4.5d hamburger — parsing presentation', () => {
  it('never presents `slice s` / `tablespoon s` and keeps original lines', () => {
    for (const line of HAMBURGER_LINES) {
      const parsed = parseIngredientLine(line);
      expect(parsed.name, line).not.toMatch(/\bs\b/);
      expect(parsed.original, line).toBe(line.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim());
    }
    expect(parseIngredientLine('8 slices bacon').name).toBe('bacon');
    expect(parseIngredientLine('2 tablespoons mayonnaise').name).toBe('mayonnaise');
  });

  it('authenticates the complete source and exposes the eligible home-recipe catalog', () => {
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const metadata = loaded.session.metadata();
    expect(metadata.source_record_count).toBe(13559);
    expect(metadata.record_count).toBe(12924);
    expect(metadata.excluded_record_count).toBe(635);
  });
});

describe('phase 4.5d hamburger — candidate correctness', () => {
  it('ground beef: raw 80/20 records rank first; note is not identity', () => {
    const result = review(HAMBURGER_LINES[0]);
    expect(result.outcome).toBe('review_required');
    expect(result.normalized_query).toContain('formed into 4 patties');
    const raw8020 = rankOf(result, 174036);
    expect(raw8020).toBe(0);
    // Cooked patties and unrelated beef rank below the raw 80/20 record.
    for (const id of [171797, 171798, 2705853]) {
      const index = rankOf(result, id);
      if (index >= 0) expect(index).toBeGreaterThan(raw8020);
    }
  });

  it('kosher salt: actual salt records rank first; no `without salt` padding', () => {
    const result = review(HAMBURGER_LINES[1]);
    expect(result.outcome).toBe('review_required');
    const list = descriptions(result);
    expect(list[0]).toMatch(/^Salt, table/);
    for (const description of list) {
      expect(description).not.toMatch(/without salt|no salt added/i);
      expect(description).not.toMatch(/\b(butter|pumpkin|taro|nopales|crackers?)\b/i);
    }
  });

  it('black pepper: pepper records rank first; ground meats never appear', () => {
    const result = review(HAMBURGER_LINES[2]);
    expect(result.outcome).toBe('review_required');
    expect(result.candidates[0].description).toBe('Spices, pepper, black');
    for (const description of descriptions(result)) {
      expect(description).not.toMatch(/\b(beef|pork|ham|lamb|veal|chicken|turkey)\b/i);
    }
  });

  it('bacon: generic pork bacon ranks first; no chain, no variant outranks it', () => {
    const result = review(HAMBURGER_LINES[3]);
    expect(result.outcome).toBe('review_required');
    const generic = rankOf(result, 168277);
    expect(generic).toBe(0);
    for (const id of [169893, 171639, 167869, 2705856, 168382]) {
      const index = rankOf(result, id);
      if (index >= 0) expect(index).toBeGreaterThan(generic);
    }
    expect(descriptions(result).some((d) => /mcdonald|burger king|wendy/i.test(d))).toBe(false);
  });

  it('cheddar cheese: generic cheddar first; no USDA possessive advantage; no restaurant', () => {
    const result = review(HAMBURGER_LINES[4]);
    expect(result.outcome).toBe('review_required');
    const cheddar = result.candidates.findIndex((c) => c.description === 'Cheese, cheddar');
    expect(cheddar).toBe(0);
    const usdaRecord = result.candidates.findIndex((c) => /USDA/i.test(c.description));
    if (usdaRecord >= 0) expect(usdaRecord).toBeGreaterThan(cheddar);
    expect(descriptions(result).some((d) => /restaurant|appetizer/i.test(d))).toBe(false);
  });

  it('burger buns: hamburger bun/roll records first; Burger King absent', () => {
    const result = review(HAMBURGER_LINES[5]);
    expect(result.outcome).toBe('review_required');
    expect(result.candidates[0].description).toMatch(/hamburger bun/);
    expect(descriptions(result).some((d) => /burger king|mcdonald|wendy/i.test(d))).toBe(false);
  });

  it('lettuce: lettuce records first; shredded non-lettuce absent', () => {
    const result = review(HAMBURGER_LINES[6]);
    expect(result.outcome).toBe('review_required');
    expect(result.candidates[0].description).toMatch(/^Lettuce/);
    expect(descriptions(result).some((d) => /parmesan|cheese/i.test(d))).toBe(false);
  });

  it('tomatoes: raw tomato records first; medium/sliced stay context; rye/ham absent', () => {
    const result = review(HAMBURGER_LINES[7]);
    expect(result.outcome).toBe('review_required');
    expect(result.candidates[0].description).toBe('Tomatoes, raw');
    for (const description of descriptions(result)) {
      expect(description).not.toMatch(/rye flour|sliced ham/i);
    }
  });

  it('pickles: pickle records first; ham/cheese/strawberry/peach absent', () => {
    const result = review(HAMBURGER_LINES[8]);
    expect(result.outcome).toBe('review_required');
    expect(result.candidates[0].description).toMatch(/^Pickles/);
    for (const description of descriptions(result)) {
      expect(description).not.toMatch(/ham|cheese|strawberr|peach/i);
    }
  });

  it('mayonnaise: regular mayonnaise first; McDonald\'s and unrelated salads absent', () => {
    const result = review(HAMBURGER_LINES[9]);
    expect(result.outcome).toBe('review_required');
    expect(result.candidates[0].description).toBe('Mayonnaise, regular');
    for (const description of descriptions(result)) {
      expect(description).not.toMatch(/mcdonald|without mayonnaise|tuna salad|egg salad|potato salad/i);
    }
  });

  it('ketchup: unique exact eligible behavior is deterministic and restaurant-free', () => {
    const result = review(HAMBURGER_LINES[10]);
    expect(result.outcome).toBe('matched_exact');
    if (result.outcome === 'matched_exact') expect(result.selected_fdc_id).toBe(2709733);
    expect(descriptions(result).some((d) => /restaurant|mcdonald/i.test(d))).toBe(false);
  });

  it('never returns a restaurant-chain candidate for any ingredient', () => {
    for (const line of HAMBURGER_LINES) {
      const result = review(line);
      for (const candidate of result.candidates) {
        const decision = evaluateEligibility({ description: candidate.description });
        expect(decision.eligible, `${line} :: ${candidate.description}`).toBe(true);
      }
    }
  });
});
