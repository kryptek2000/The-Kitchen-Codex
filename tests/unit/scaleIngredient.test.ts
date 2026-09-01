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

  it("preserves correct spacing for a quantity with no unit", () => {
    expect(scaleIngredientText("2 eggs", 4, 2)).toBe("1 eggs");
  });

  it("preserves correct spacing for a multi-word noun with no unit", () => {
    expect(scaleIngredientText("4 chicken breasts", 2, 1)).toBe("2 chicken breasts");
  });

  it("singularizes a known unit when scaled to exactly one", () => {
    expect(scaleIngredientText("2 cups flour", 4, 2)).toBe("1 cup flour");
    expect(scaleIngredientText("2 tablespoons oil", 2, 1)).toBe("1 tablespoon oil");
    expect(scaleIngredientText("4 teaspoons sugar", 4, 1)).toBe("1 teaspoon sugar");
  });

  it("scales a fraction amount correctly", () => {
    expect(scaleIngredientText("1/2 cup sugar", 1, 2)).toBe("1 cup sugar");
  });

  it("preserves wikilinks while scaling the preceding quantity", () => {
    expect(scaleIngredientText("1/2 cup [[Chicken Broth]]", 1, 2)).toBe("1 cup [[Chicken Broth]]");
    expect(scaleIngredientText("2 [[Eggs]]", 4, 2)).toBe("1 [[Eggs]]");
  });
});
