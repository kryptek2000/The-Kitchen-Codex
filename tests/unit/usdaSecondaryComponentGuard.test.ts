/**
 * The Kitchen Codex — Advanced Nutrition Phase 0A: secondary-component identity
 * guard unit + adversarial coverage.
 *
 * Proves the general deterministic rule: a candidate whose primary food is
 * absent from the query cannot gain automatic authority merely because the query
 * matches a relational/flavor component. The guard is bounded, marker-driven,
 * Unicode-normalized upstream, and free of regex/taxonomy/AI.
 */

import { describe, it, expect } from 'vitest';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import {
  familyMismatchCount,
  projectQueryText,
  secondaryComponentOnlyMatchCount,
} from '../../src/core/nutritionV2/matching/query';

const SARDINE = 'Fish, sardine, Pacific, canned in tomato sauce, drained solids with bone';
const GRITS = 'Cereals, QUAKER, Instant Grits, Country Bacon flavor, dry';
const BACON = 'Pork, cured, bacon, unprepared';
const TOMATO_SAUCE = 'Tomato products, canned, sauce';
const TOMATO_SAUCE_SALT = 'Tomato, sauce, canned, with salt added';
const EGGPLANT = 'Eggplant with cheese and tomato sauce';
const SPAGHETTI_DISH = 'Spaghetti, with meatballs in tomato sauce, canned';
const STUFFED_CHICKEN = 'Chicken, breast, filled with cheese';
const CHEESE = 'Cheese, cheddar';

function projection(query: string) {
  return projectQueryText(normalizeQuery(query).text);
}

function tokens(description: string) {
  return normalizeQuery(description).tokens;
}

function guard(query: string, description: string): number {
  return secondaryComponentOnlyMatchCount(tokens(description), projection(query));
}

describe('secondary-component guard — confirmed defect', () => {
  it('flags a candidate whose primary food is absent for a secondary-only query', () => {
    expect(guard('canned tomato sauce', SARDINE)).toBe(1);
    expect(guard('tomato sauce', SARDINE)).toBe(1);
    expect(guard('tomato sauce', EGGPLANT)).toBe(1);
    expect(guard('tomato sauce', SPAGHETTI_DISH)).toBe(1);
  });

  it('the flag disables automatic authority through the existing family-mismatch contract', () => {
    expect(familyMismatchCount(tokens(SARDINE), projection('canned tomato sauce'))).toBe(1);
    expect(familyMismatchCount(tokens(SARDINE), projection('sardines in tomato sauce'))).toBe(0);
  });
});

describe('secondary-component guard — legitimate primary-food queries', () => {
  it('never flags when the query names the candidate primary food', () => {
    expect(guard('sardines in tomato sauce', SARDINE)).toBe(0);
    expect(guard('canned sardines in tomato sauce', SARDINE)).toBe(0);
    expect(guard('fish in tomato sauce', SARDINE)).toBe(0);
    expect(guard('sardine', SARDINE)).toBe(0);
  });

  it('never flags an ordinary tomato-product record for tomato sauce queries', () => {
    expect(guard('tomato sauce', TOMATO_SAUCE)).toBe(0);
    expect(guard('canned tomato sauce', TOMATO_SAUCE)).toBe(0);
    expect(guard('tomato sauce', TOMATO_SAUCE_SALT)).toBe(0);
    expect(guard('tomato sauce with basil', TOMATO_SAUCE_SALT)).toBe(0);
  });

  it('never flags a candidate with no relational or flavor marker', () => {
    expect(guard('bacon', BACON)).toBe(0);
    expect(guard('cheese', CHEESE)).toBe(0);
  });

  it('keeps a flavor record eligible when the query names its primary food', () => {
    expect(guard('bacon', GRITS)).toBe(1);
    expect(guard('grits', GRITS)).toBe(0);
    expect(guard('bacon-flavored cereal', GRITS)).toBe(0);
  });

  it('does not act when the query carries no food identity tokens', () => {
    expect(guard('canned', SARDINE)).toBe(0);
    expect(guard('', SARDINE)).toBe(0);
  });

  it('flags a generic component-only query that names no primary food', () => {
    expect(guard('sauce', SARDINE)).toBe(1);
  });
});

describe('secondary-component guard — adversarial shapes', () => {
  it('handles repeated relational markers', () => {
    expect(guard('tomato sauce', 'Fish, sardine, in in in tomato sauce')).toBe(1);
    expect(guard('sardine', 'Fish, sardine, in in in tomato sauce')).toBe(0);
  });

  it('handles punctuation and hyphen variants through canonical normalization', () => {
    expect(guard('canned tomato sauce', 'Fish, sardine, canned-in-tomato-sauce')).toBe(1);
    expect(guard('tomato sauce', 'Fish, sardine, canned (in) tomato — sauce')).toBe(1);
  });

  it('handles comma-separated USDA descriptions and filled/containing markers', () => {
    expect(guard('cheese', STUFFED_CHICKEN)).toBe(1);
    expect(guard('chicken', STUFFED_CHICKEN)).toBe(0);
    expect(guard('cheese', 'Crackers, containing cheese, baked')).toBe(1);
    expect(guard('crackers', 'Crackers, containing cheese, baked')).toBe(0);
  });

  it('protects the primary food when the query names it after the marker', () => {
    expect(guard('tomato sauce', 'Sauce, tomato, with basil, canned')).toBe(0);
    expect(guard('sauce with tomato', 'Sauce, tomato, with basil, canned')).toBe(0);
  });

  it('is closed to prototype-key and hostile tokens', () => {
    expect(guard('tomato sauce', '__proto__ constructor tomato sauce')).toBe(0);
    expect(guard('tomato sauce', 'Fish in __proto__ tomato sauce')).toBe(1);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('stays bounded on an oversized candidate token list', () => {
    const long = `Fish, sardine, ${Array.from({ length: 400 }, (_v, i) => `token${i}`).join(', ')}, in tomato sauce`;
    const started = Date.now();
    expect(() => guard('tomato sauce', long)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('is mutation-sensitive: flipping the query to the primary food clears the flag', () => {
    const query = (value: string) => guard(value, SARDINE);
    expect(query('tomato sauce')).toBe(1);
    expect(query('sardine tomato sauce')).toBe(0);
  });
});

/**
 * Closed-marker coverage matrix. Every relational and flavor marker in the
 * production vocabulary is exercised in ISOLATION (the candidate contains no
 * other marker), so each case fails if its marker is dropped from the guard.
 * Each case proves the secondary-only query produces a mismatch while the
 * corresponding primary-food query is not suppressed by the guard.
 */
describe('secondary-component guard — closed marker coverage', () => {
  interface MarkerCase {
    readonly marker: string;
    readonly candidate: string;
    readonly secondaryQuery: string;
    readonly primaryQuery: string;
  }

  const RELATIONAL_MARKER_CASES: ReadonlyArray<MarkerCase> = [
    { marker: 'in', candidate: 'Chicken, breast, in tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
    { marker: 'with', candidate: 'Chicken, breast, with tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
    { marker: 'filled', candidate: 'Chicken, breast, filled tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
    { marker: 'stuffed', candidate: 'Chicken, breast, stuffed tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
    { marker: 'containing', candidate: 'Chicken, breast, containing tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
    { marker: 'contains', candidate: 'Chicken, breast, contains tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
    { marker: 'coated', candidate: 'Chicken, breast, coated tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
    { marker: 'topped', candidate: 'Chicken, breast, topped tomato', secondaryQuery: 'tomato', primaryQuery: 'chicken' },
  ];

  const FLAVOR_MARKER_CASES: ReadonlyArray<MarkerCase> = [
    { marker: 'flavor', candidate: 'Cereal, bacon flavor', secondaryQuery: 'bacon', primaryQuery: 'cereal' },
    { marker: 'flavors', candidate: 'Cereal, bacon flavors', secondaryQuery: 'bacon', primaryQuery: 'cereal' },
    { marker: 'flavored', candidate: 'Cereal, bacon flavored', secondaryQuery: 'bacon', primaryQuery: 'cereal' },
    { marker: 'flavour', candidate: 'Cereal, bacon flavour', secondaryQuery: 'bacon', primaryQuery: 'cereal' },
    { marker: 'flavours', candidate: 'Cereal, bacon flavours', secondaryQuery: 'bacon', primaryQuery: 'cereal' },
    { marker: 'flavoured', candidate: 'Cereal, bacon flavoured', secondaryQuery: 'bacon', primaryQuery: 'cereal' },
  ];

  for (const testCase of RELATIONAL_MARKER_CASES) {
    it(`relational marker \`${testCase.marker}\`: secondary-only overlap is a mismatch, primary food is not suppressed`, () => {
      expect(guard(testCase.secondaryQuery, testCase.candidate)).toBe(1);
      expect(
        familyMismatchCount(tokens(testCase.candidate), projection(testCase.secondaryQuery))
      ).toBe(1);
      expect(guard(testCase.primaryQuery, testCase.candidate)).toBe(0);
    });
  }

  for (const testCase of FLAVOR_MARKER_CASES) {
    it(`flavor marker \`${testCase.marker}\`: secondary-only overlap is a mismatch, primary food is not suppressed`, () => {
      expect(guard(testCase.secondaryQuery, testCase.candidate)).toBe(1);
      expect(
        familyMismatchCount(tokens(testCase.candidate), projection(testCase.secondaryQuery))
      ).toBe(1);
      expect(guard(testCase.primaryQuery, testCase.candidate)).toBe(0);
    });
  }
});
