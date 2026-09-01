import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recoverMetadataAlgorithmically, recoverRecipeMetadata } from "../../server/metadataRecovery.js";
import { mergeRecoveredMetadata } from "../../src/utils/vaultIntelligence.js";
import { ObsidianRecipe, RecoveredRecipeMetadata } from "../../src/types";

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
