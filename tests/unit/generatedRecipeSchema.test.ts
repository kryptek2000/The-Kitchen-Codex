import { describe, it, expect } from "vitest";
import {
  buildGeneratedRecipeSchema,
  normalizeGeneratedRecipeDraft,
  validateGeneratedRecipeDraft,
  MAX_GENERATED_INGREDIENTS,
  MAX_GENERATED_STEPS,
  type GeneratedRecipeDraft,
} from "../../src/schema/generatedRecipe.js";
import type { AiJsonSchema } from "../../src/core/ai/types.js";

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    title: "Hearty Chicken & Rice Skillet",
    ingredients: [
      { amount: 2, unit: "cup", name: "chicken broth", preparation: "warm" },
      { name: "salt" },
      "olive oil",
    ],
    steps: ["Heat the oil in a large skillet.", "Add the chicken and sear until golden."],
    ...overrides,
  };
}

describe("GeneratedRecipeDraft — schema + validation (v0.7 Phase 2A)", () => {
  it("schema requires title, ingredients, steps and closes the envelope", () => {
    const s = buildGeneratedRecipeSchema();
    expect(s.type).toBe("object");
    if (s.type === "object") {
      expect(s.required).toEqual(["title", "ingredients", "steps"]);
    }
  });

  it("accepts a valid minimal draft", () => {
    const v = validateGeneratedRecipeDraft(validDraft());
    expect(v.passed).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("accepts optional metadata and returns a normalized draft", () => {
    const v = validateGeneratedRecipeDraft(validDraft({
      servings: 4,
      prepTime: "15 mins",
      cookTime: "30 mins",
      cuisine: "Mexican",
      tags: ["dinner", "one-pan"],
      difficulty: "Easy",
    }));
    expect(v.passed).toBe(true);
    const d = normalizeGeneratedRecipeDraft(validDraft({
      servings: 4,
      prepTime: "15 mins",
      cookTime: "30 mins",
      cuisine: "Mexican",
      tags: ["dinner", "one-pan"],
      difficulty: "Easy",
    }));
    expect(d.title).toBe("Hearty Chicken & Rice Skillet");
    expect(d.servings).toBe(4);
    expect(d.tags).toEqual(["dinner", "one-pan"]);
    expect(d.cuisine).toBe("Mexican");
  });

  it("rejects unknown/extra properties (no shape drift)", () => {
    const v = validateGeneratedRecipeDraft(validDraft({ sourceUrl: "https://example.com/fake" }));
    expect(v.passed).toBe(false);
    expect(v.errors.some((e) => e.includes("sourceUrl"))).toBe(true);
  });

  it("rejects missing title", () => {
    expect(validateGeneratedRecipeDraft(validDraft({ title: "" })).passed).toBe(false);
  });

  it("rejects missing ingredients", () => {
    expect(validateGeneratedRecipeDraft(validDraft({ ingredients: [] })).passed).toBe(false);
    expect(validateGeneratedRecipeDraft(validDraft({ ingredients: undefined })).passed).toBe(false);
  });

  it("rejects missing steps", () => {
    expect(validateGeneratedRecipeDraft(validDraft({ steps: [] })).passed).toBe(false);
  });

  it("rejects a malformed ingredient (missing name)", () => {
    const v = validateGeneratedRecipeDraft(validDraft({ ingredients: [{ amount: 1 }] }));
    expect(v.passed).toBe(false);
    expect(v.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects a malformed step (missing text)", () => {
    const v = validateGeneratedRecipeDraft(validDraft({ steps: [{ timerMinutes: 10 }] }));
    expect(v.passed).toBe(false);
    expect(v.errors.some((e) => e.includes("text"))).toBe(true);
  });

  it("rejects out-of-bounds array sizes and servings", () => {
    expect(validateGeneratedRecipeDraft(validDraft({
      ingredients: Array.from({ length: MAX_GENERATED_INGREDIENTS + 1 }, () => ({ name: "x" })),
    })).passed).toBe(false);
    expect(validateGeneratedRecipeDraft(validDraft({
      steps: Array.from({ length: MAX_GENERATED_STEPS + 1 }, () => ({ text: "x" })),
    })).passed).toBe(false);
    expect(validateGeneratedRecipeDraft(validDraft({ servings: 500 })).passed).toBe(false);
  });

  it("normalize trims, drops empty entries, and never synthesizes missing required fields", () => {
    const d = normalizeGeneratedRecipeDraft(validDraft({
      title: "  Trimmed Title  ",
      ingredients: [{ name: "  chicken  " }, ""],
      steps: [` 1. Boil water. `, " "],
    }));
    expect(d.title).toBe("Trimmed Title");
    expect(d.ingredients.map((i) => i.name)).toEqual(["chicken"]);
    expect(d.steps).toHaveLength(1);
    // Missing required fields are rejected, never fabricated.
    expect(() => normalizeGeneratedRecipeDraft({ ingredients: [{ name: "x" }], steps: ["y"] })).toThrow(/title/i);
  });

  it("normalization never produces a wikilink on an ingredient", () => {
    const d = normalizeGeneratedRecipeDraft(validDraft());
    for (const ing of d.ingredients) {
      const record = ing as unknown as Record<string, unknown>;
      expect(record["wikilink"]).toBeUndefined();
      expect(record["wikilinkTarget"]).toBeUndefined();
    }
  });

  it("buildGeneratedRecipeSchema is a valid AiJsonSchema object", () => {
    const s: AiJsonSchema = buildGeneratedRecipeSchema();
    expect(s.type).toBe("object");
    if (s.type === "object") {
      expect(s.properties["title"]).toBeDefined();
      expect(s.properties["ingredients"]).toBeDefined();
      expect(s.properties["steps"]).toBeDefined();
      expect(s.required).toContain("title");
    }
  });
});
