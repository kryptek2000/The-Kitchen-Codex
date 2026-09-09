import { describe, it, expect } from "vitest";
import { generatedDraftToObsidianRecipe } from "../../src/application/createForMe.js";
import { serializeRecipeToObsidianMarkdown, parseObsidianRecipeMarkdown } from "../../src/utils/markdownParser.js";
import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from "../../src/schema/generatedRecipe.js";

const PROVENANCE: GeneratedRecipeProvenance = { generated: true, providerId: "gemini", model: "gemini-test" };

function draft(overrides: Partial<GeneratedRecipeDraft> = {}): GeneratedRecipeDraft {
  return {
    title: "One-Pan Lemon Chicken",
    description: "A bright, weeknight chicken dinner.",
    servings: 4,
    prepTime: "10 mins",
    cookTime: "25 mins",
    totalTime: "35 mins",
    cuisine: "Mediterranean",
    difficulty: "Easy",
    tags: ["dinner", "one-pan"],
    course: "Dinner",
    ingredients: [
      { amount: 2, unit: "tbsp", name: "olive oil" },
      { amount: 4, unit: "", name: "chicken thighs", preparation: "boneless" },
      { name: "salt" },
    ],
    steps: [
      { text: "Heat the oil in a large skillet." },
      { text: "Sear the chicken until golden, about 5 minutes per side.", timerMinutes: 10 },
    ],
    ...overrides,
  };
}

describe("generatedDraftToObsidianRecipe (v0.7 2A) — save adaptation", () => {
  it("assigns identity/path at the vault root and never lets the model choose it", () => {
    const recipe = generatedDraftToObsidianRecipe({ draft: draft(), provenance: PROVENANCE, now: () => new Date("2026-01-02T03:04:05.000Z") });
    expect(recipe.fileName).toBe("One-Pan Lemon Chicken.md");
    expect(recipe.filePath).toBe("One-Pan Lemon Chicken.md");
    expect(recipe.id).toBeTruthy();
    expect(recipe.title).toBe("One-Pan Lemon Chicken");
    expect(recipe.servings).toBe(4);
    expect(recipe.prepTime).toBe("10 mins");
  });

  it("adds namespaced codex_generated provenance (never ambiguous `generated`/`ai`/`source`)", () => {
    const recipe = generatedDraftToObsidianRecipe({ draft: draft(), provenance: PROVENANCE, now: () => new Date("2026-01-02T03:04:05.000Z") });
    expect(recipe.frontmatter?.codex_generated).toBe(true);
    expect(recipe.frontmatter?.codex_generated_provider).toBe("gemini");
    expect(recipe.frontmatter?.codex_generated_model).toBe("gemini-test");
    expect(recipe.frontmatter?.codex_generated_at).toBe("2026-01-02T03:04:05.000Z");
    expect(recipe.source).toBeUndefined();
  });

  it("never generates a fake source URL / author / imported-from origin", () => {
    const recipe = generatedDraftToObsidianRecipe({ draft: draft(), provenance: PROVENANCE });
    expect(recipe.source).toBeUndefined();
    const md = serializeRecipeToObsidianMarkdown(recipe);
    expect(md).not.toContain("source: http");
    expect(md).not.toContain("imported");
  });

  it("never generates ingredient wikilinks", () => {
    const recipe = generatedDraftToObsidianRecipe({ draft: draft(), provenance: PROVENANCE });
    for (const ing of recipe.ingredients) {
      expect(ing.wikilink).toBeUndefined();
      expect(ing.wikilinkTarget).toBeUndefined();
    }
    const md = serializeRecipeToObsidianMarkdown(recipe);
    expect(md).not.toContain("[[");
  });

  it("preserves user edits before save (title/ingredients/steps reflect edited values)", () => {
    const edited = draft({ title: "Lemon Herb Chicken (Edited)" });
    edited.ingredients = [{ name: "lemon zest" }, { name: "garlic cloves" }];
    edited.steps = [{ text: "Zest the lemon." }, { text: "Add garlic and simmer." }];
    const recipe = generatedDraftToObsidianRecipe({ draft: edited, provenance: PROVENANCE });
    expect(recipe.title).toBe("Lemon Herb Chicken (Edited)");
    expect(recipe.ingredients.map((i) => i.name)).toEqual(["lemon zest", "garlic cloves"]);
    expect(recipe.instructions.map((s) => s.text)).toEqual(["Zest the lemon.", "Add garlic and simmer."]);
    // Provenance survives user edits (means "originated from generation", not "untouched").
    expect(recipe.frontmatter?.codex_generated).toBe(true);
  });

  it("serializes codex_generated into Markdown and round-trips the prompt is absent", () => {
    const recipe = generatedDraftToObsidianRecipe({ draft: draft(), provenance: PROVENANCE });
    const md = serializeRecipeToObsidianMarkdown(recipe);
    expect(md).toContain("codex_generated: true");
    expect(md).toContain("codex_generated_provider: gemini");
    expect(md).not.toContain("SUPER_SECRET_CREATE_PROMPT_SENTINEL");
    // Round-trips through the canonical parser without a scan regression.
    const reparsed = parseObsidianRecipeMarkdown(md, "One-Pan Lemon Chicken.md", "One-Pan Lemon Chicken.md");
    expect(reparsed.title).toBe("One-Pan Lemon Chicken");
    expect(reparsed.ingredients.length).toBe(3);
    expect(reparsed.frontmatter?.codex_generated).toBe(true);
  });

  it("aligns the generated recipe id with the path-derived canonical identity (reparse matches)", () => {
    const recipe = generatedDraftToObsidianRecipe({ draft: draft(), provenance: PROVENANCE });
    expect(recipe.id).toBe(recipe.filePath);
    expect(recipe.filePath).toBe("One-Pan Lemon Chicken.md");
    // A later scan/reparse of the saved file must derive the SAME id — so the
    // generated in-memory identity and the canonical parser never diverge.
    const md = serializeRecipeToObsidianMarkdown(recipe);
    const reparsed = parseObsidianRecipeMarkdown(md, recipe.fileName, recipe.filePath);
    expect(reparsed.id).toBe(recipe.filePath);
  });
});
