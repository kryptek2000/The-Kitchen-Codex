import { describe, it, expect } from "vitest";
import { parseFraction } from "../../src/schema/recipeValidator.js";
import { parseFractionToDecimal } from "../../src/utils/markdownParser.js";

describe("fraction parsing (single shared implementation)", () => {
  const cases: Array<[string, number]> = [
    ["1/2", 0.5],
    ["1 1/2", 1.5],
    ["1-1/2", 1.5],
    ["½", 0.5],
    ["1½", 1.5],
    ["1 ½", 1.5],
    ["3/4", 0.75],
    ["3", 3],
    ["1.25", 1.25],
    ["2 3/4", 2.75],
    ["⅓", 1 / 3],
    ["7/8", 0.875],
    ["1 ⅓", 1 + 1 / 3],
  ];

  it("handles the required fraction cases", () => {
    for (const [input, expected] of cases) {
      expect(parseFraction(input)).toBeCloseTo(expected, 6);
    }
  });

  it("delegates the markdown parser to the single canonical implementation", () => {
    // Both entry points must agree with the canonical parser for every input.
    for (const [input] of cases) {
      expect(parseFractionToDecimal(input)).toBe(parseFraction(input));
    }
    // And the canonical parser fixes the historical "1-1/2" = 1 bug.
    expect(parseFractionToDecimal("1-1/2")).toBeCloseTo(1.5, 6);
  });

  it("returns null for empty / non-numeric input", () => {
    expect(parseFraction("")).toBeNull();
    expect(parseFraction("  ")).toBeNull();
    expect(parseFractionToDecimal("")).toBeNull();
  });
});
