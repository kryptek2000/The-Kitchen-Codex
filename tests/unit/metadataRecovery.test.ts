import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { recoverMetadataAlgorithmically, recoverRecipeMetadata } from "../../server/metadataRecovery.js";
import { mergeRecoveredMetadata } from "../../src/utils/vaultIntelligence.js";
import { ObsidianRecipe, RecoveredRecipeMetadata } from "../../src/types";
import { getGemini } from "../../server/geminiClient.js";
import { MODEL_CONFIG } from "../../server/modelConfig.js";

vi.mock("../../server/geminiClient.js", () => ({
  getGemini: vi.fn(() => null),
}));

describe("metadata recovery — zero-fabrication & inference labelling", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.GEMINI_API_KEY;
    // Force the offline/algorithmic path so tests are hermetic (no network).
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  it("prefers absence over a fabricated cook time when there is no evidence", () => {
    const result = recoverMetadataAlgorithmically({
      title: "Mystery Dish",
      ingredients: ["1 cup flour", "2 eggs"],
      instructions: ["Mix everything together."],
    });
    expect(result.cookTime).toBeUndefined();
    expect(result.totalTime).toBeUndefined();
  });

  it("prefers absence over a fabricated serving count when none is stated", () => {
    const result = recoverMetadataAlgorithmically({
      title: "Mystery Dish",
      ingredients: ["1 cup flour"],
      instructions: ["Stir."],
    });
    expect(result.servings).toBeUndefined();
  });

  it("marks an explicit instruction duration as high-confidence explicit evidence", () => {
    const result = recoverMetadataAlgorithmically({
      title: "Roast Chicken",
      ingredients: ["1 whole chicken"],
      instructions: ["Bake for 45 minutes at 400 degrees."],
    });
    expect(result.cookTime?.value).toBe("45 mins");
    expect(result.cookTime?.confidence).toBe("high");
    expect(result.cookTime?.source).toBe("instructions_explicit");
    // totalTime = inferred prep (5 mins for one ingredient) + explicit cook (45).
    expect(result.totalTime?.value).toBe("50 mins");
    expect(result.totalTime?.source).toBe("culinary_inference");
  });

  it("keeps a clearly-stated yield as a high-confidence serving recovery", () => {
    const result = recoverMetadataAlgorithmically({
      title: "Brownies",
      ingredients: ["2 cups sugar"],
      instructions: ["Bake."],
      rawMarkdown: "---\nservings: 12\n---\n# Brownies",
    });
    expect(result.servings?.value).toBe(12);
    expect(result.servings?.confidence).toBe("high");
  });

  it("labels inference-only values as culinary inference with a hypothesis reason", () => {
    const result = recoverMetadataAlgorithmically({
      title: "Dry Rub",
      ingredients: ["2 tbsp paprika", "1 tbsp brown sugar"],
      instructions: ["Mix the seasonings."],
    });
    expect(result.cookTime?.value).toBe("0 mins");
    expect(result.cookTime?.source).toBe("culinary_inference");
    expect(result.cookTime?.confidence).toBe("medium");
    expect(result.cookTime?.explanation).toMatch(/requires no cooking time/);
    expect(result.servings?.value).toBe(12);
  });

  it("never overwrites an existing value for a field that was not accepted", () => {
    const recipe: ObsidianRecipe = {
      id: "r1",
      fileName: "r1.md",
      filePath: "Recipes/r1.md",
      rawMarkdown: "---\nprep_time: 15 mins\ncuisine: Italian\n---\n# Curry",
      title: "Coconut Curry",
      tags: ["food/recipes"],
      category: "Main Course",
      cuisine: "Italian",
      prepTime: "15 mins",
      cookTime: "25 mins",
      servings: 4,
      difficulty: "Medium",
      rating: 5,
      ingredients: [{ original: "1 cup coconut milk", name: "coconut milk" }],
      instructions: [{ stepNumber: 1, text: "Simmer." }],
      callouts: [],
      wikilinks: [],
      dataviewFields: {},
      frontmatter: { prep_time: "15 mins", cuisine: "Italian" },
    };

    const recovered: RecoveredRecipeMetadata = {
      cookTime: { value: "40 mins", confidence: "high", source: "instructions_explicit", explanation: "Explicit" },
      cuisine: { value: "Thai", confidence: "high", source: "body_parsed", explanation: "Detected" },
      servings: { value: 6, confidence: "high", source: "body_parsed", explanation: "Stated" },
    };

    // The user only accepts cuisine for merge — pre-existing cookTime and
    // servings must remain untouched.
    const merged = mergeRecoveredMetadata(recipe, recovered, ["cuisine"]);

    expect(merged.cuisine).toBe("Thai");
    expect(merged.cookTime).toBe("25 mins");
    expect(merged.servings).toBe(4);
    // The persisted source (rawMarkdown frontmatter) carries the accepted value
    // only; it never rewrites the unaccepted cook/serving fields.
    expect(merged.rawMarkdown).toContain("cuisine: Thai");
  });

  it("routes to the algorithmic fallback when no API key is configured", async () => {
    const result = await recoverRecipeMetadata({
      title: "Test Recipe",
      ingredients: ["1 cup flour"],
      instructions: ["Mix."],
    });
    expect(result.cookTime).toBeUndefined();
    expect(result.category?.value).toBeDefined();
  });
});

describe("metadata recovery — provider abstraction parity (direct gemini removed)", () => {
  const modelAwareGemini = (handler: (params: { model: string; config?: any }) => { text?: string } | never) => {
    vi.mocked(getGemini).mockReturnValue({
      models: { generateContent: async (params: any) => handler(params) },
    } as any);
  };

  afterEach(() => {
    vi.mocked(getGemini).mockReturnValue(null);
  });

  it("P1: routes through the provider (primary explicit, temp 0.1, MINIMAL thinking, schema descriptions + required preserved)", async () => {
    const seen: any[] = [];
    modelAwareGemini((p) => {
      seen.push(p);
      return { text: JSON.stringify({ prepTime: { value: "15 mins", confidence: "medium", source: "culinary_inference", explanation: "Estimated prep based on ingredients" } }) };
    });
    try {
      const result = await recoverRecipeMetadata({ title: "T", ingredients: ["1 cup flour"] });
      expect(result.prepTime?.value).toBe("15 mins");
      expect(seen[0].model).toBe(MODEL_CONFIG.metadataRecoveryPrimary);
      expect(seen[0].config.temperature).toBe(0.1);
      expect(seen[0].config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
      expect(seen[0].config.responseMimeType).toBe("application/json");
      const rs = seen[0].config.responseSchema;
      expect(rs.type).toBe("OBJECT");
      // required fields preserved.
      expect(rs.properties.prepTime.required).toEqual(["value", "confidence", "source", "explanation"]);
      expect(rs.properties.nutrition.properties.value.required).toEqual(["calories", "protein", "carbohydrates", "fat", "fiber", "sodium"]);
      // schema descriptions preserved.
      expect(rs.properties.prepTime.properties.value.description).toContain("Normalized prep time string");
      expect(rs.properties.servings.properties.value.description).toContain("Yield / number of servings");
      expect(rs.properties.suggestedTags.properties.value.description).toContain("Array of Obsidian tags");
      // enums preserved.
      expect(rs.properties.prepTime.properties.confidence.enum).toEqual(["high", "medium", "low"]);
      expect(rs.properties.difficulty.properties.value.enum).toEqual(["Easy", "Medium", "Hard"]);
      // Only the primary model was needed; fallback not called.
      expect(seen.length).toBe(1);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P2: provider primary throws -> explicit fallback model attempted (order preserved)", async () => {
    const seenModels: string[] = [];
    modelAwareGemini((p) => {
      seenModels.push(p.model);
      if (p.model === MODEL_CONFIG.metadataRecoveryPrimary) throw new Error("primary down");
      return { text: JSON.stringify({ category: { value: "Pasta", confidence: "medium", source: "culinary_inference", explanation: "Classified" } }) };
    });
    try {
      const result = await recoverRecipeMetadata({ title: "T", ingredients: ["1 cup flour"] });
      expect(result.category?.value).toBe("Pasta");
      expect(seenModels).toEqual([MODEL_CONFIG.metadataRecoveryPrimary, MODEL_CONFIG.metadataRecoveryFallback]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P3: provider yields invalid structured output -> algorithmic fallback", async () => {
    modelAwareGemini(() => ({ text: "{ not valid json" }));
    try {
      const result = await recoverRecipeMetadata({ title: "Test Recipe", ingredients: ["1 cup flour"] });
      expect(result.prepTime?.value).toBe("5 mins");
      expect(result.category?.value).toBeDefined();
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P4: provider unavailable (no key) -> algorithmic fallback with no AI attempt", async () => {
    let aiCalls = 0;
    modelAwareGemini(() => {
      aiCalls++;
      return { text: "{}" };
    });
    vi.mocked(getGemini).mockReturnValue(null);
    const result = await recoverRecipeMetadata({ title: "Test Recipe", ingredients: ["1 cup flour"] });
    expect(result.prepTime?.value).toBe("5 mins");
    expect(aiCalls).toBe(0);
  });

  it("P5: both provider models fail -> algorithmic fallback", async () => {
    const seenModels: string[] = [];
    modelAwareGemini((p) => {
      seenModels.push(p.model);
      throw new Error("all metadata recovery models down");
    });
    try {
      const result = await recoverRecipeMetadata({ title: "Test Recipe", ingredients: ["1 cup flour"] });
      expect(result.prepTime?.value).toBe("5 mins");
      expect(seenModels).toEqual([MODEL_CONFIG.metadataRecoveryPrimary, MODEL_CONFIG.metadataRecoveryFallback]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P6: AI output that omits a field is returned zero-fabricated (omission preserved)", async () => {
    modelAwareGemini(() => ({
      text: JSON.stringify({ prepTime: { value: "15 mins", confidence: "medium", source: "culinary_inference", explanation: "est" } }),
    }));
    try {
      const result = await recoverRecipeMetadata({ title: "T", ingredients: ["1 cup flour"] });
      expect(result.prepTime?.value).toBe("15 mins");
      expect(result.cookTime).toBeUndefined();
      expect(result.servings).toBeUndefined();
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });
});
