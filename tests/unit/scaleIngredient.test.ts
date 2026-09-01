import { describe, it, expect } from "vitest";
import { scaleIngredientText } from "../../src/utils/markdownParser.js";

describe("scaleIngredientText — deterministic serving scaling", () => {
  it("scales a mixed fraction up proportionally", () => {
    expect(scaleIngredientText("1 1/2 cups flour", 1, 2)).toBe("3 cups flour");
  });

  it("scales a whole count down", () => {
    expect(scaleIngredientText("4 cups flour", 2, 1)).toBe("2 cups flour");
  });

  it("scales a unicode fraction up to a whole number", () => {
    expect(scaleIngredientText("½ cup milk", 2, 4)).toBe("1 cup milk");
  });

  it("scales a bare quantity down to a fraction", () => {
    expect(scaleIngredientText("1 lb chicken", 2, 1)).toBe("1/2 lb chicken");
  });

  it("leaves the text unchanged when target equals current servings", () => {
    const line = "1 1/2 cups flour";
    expect(scaleIngredientText(line, 2, 2)).toBe(line);
  });

  it("preserves a line with no numeric amount (zero-fabrication)", () => {
    const line = "salt to taste";
    expect(scaleIngredientText(line, 4, 6)).toBe(line);
  });
});
