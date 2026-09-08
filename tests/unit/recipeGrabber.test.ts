import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractJsonLd,
  extractMetaTags,
  formatDuration,
  parseRecipeYield,
  parseRecipeFromJsonLd,
  generateMarkdown,
  cleanHtmlToText,
  grabRecipeFromWeb,
} from "../../server/recipeGrabber";
import { WafProtectionError } from "../../server/ssrfGuard";
import { getGemini } from "../../server/geminiClient.js";
import { MODEL_CONFIG } from "../../server/modelConfig.js";

vi.mock("../../server/geminiClient.js", () => ({ getGemini: vi.fn(() => null) }));

describe("RecipeGrabber - Extraction & Parsing", () => {
  describe("formatDuration (Zero-Fabrication)", () => {
    it("returns empty string when duration is missing, undefined, or null", () => {
      expect(formatDuration(undefined)).toBe("");
      expect(formatDuration(null as any)).toBe("");
      expect(formatDuration("")).toBe("");
      expect(formatDuration("   ")).toBe("");
    });

    it("parses ISO 8601 duration strings accurately", () => {
      expect(formatDuration("PT20M")).toBe("20 mins");
      expect(formatDuration("PT1H")).toBe("1 hr");
      expect(formatDuration("PT2H")).toBe("2 hrs");
      expect(formatDuration("PT1H30M")).toBe("1 hr 30 mins");
      expect(formatDuration("PT2H15M")).toBe("2 hrs 15 mins");
      expect(formatDuration("P0DT0H45M0S")).toBe("45 mins");
      expect(formatDuration("P0DT1H0M0S")).toBe("1 hr");
    });

    it("parses numeric minutes accurately", () => {
      expect(formatDuration(15)).toBe("15 mins");
      expect(formatDuration(60)).toBe("1 hr");
      expect(formatDuration(90)).toBe("1 hr 30 mins");
      expect(formatDuration(120)).toBe("2 hrs");
    });

    it("returns clean strings as-is if already formatted", () => {
      expect(formatDuration("25 minutes")).toBe("25 minutes");
      expect(formatDuration("1 hour 15 mins")).toBe("1 hour 15 mins");
    });
  });

  describe("parseRecipeYield", () => {
    it("handles direct number values", () => {
      expect(parseRecipeYield(4)).toBe(4);
      expect(parseRecipeYield(8)).toBe(8);
      expect(parseRecipeYield(0)).toBeUndefined();
      expect(parseRecipeYield(undefined)).toBeUndefined();
      expect(parseRecipeYield(null)).toBeUndefined();
    });

    it("handles range strings by taking the minimum serving count", () => {
      expect(parseRecipeYield("4 to 6 servings")).toBe(4);
      expect(parseRecipeYield("6-8 servings")).toBe(6);
      expect(parseRecipeYield("serves 4 to 6")).toBe(4);
    });

    it("handles unit/portion descriptions", () => {
      expect(parseRecipeYield("1 loaf (8 slices)")).toBe(8);
      expect(parseRecipeYield("Makes 24 cookies")).toBe(24);
      expect(parseRecipeYield("12 muffins")).toBe(12);
      expect(parseRecipeYield("Serves 4")).toBe(4);
      expect(parseRecipeYield(["8 servings"])).toBe(8);
    });
  });

  describe("extractJsonLd", () => {
    it("extracts direct single JSON-LD objects", () => {
      const html = `
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Recipe",
                "name": "Classic Tacos"
              }
            </script>
          </head>
        </html>
      `;
      const blocks = extractJsonLd(html);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].name).toBe("Classic Tacos");
    });

    it("extracts nested @graph structures used by WordPress / Yoast SEO", () => {
      const html = `
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebPage", "name": "Site Page" },
              { "@type": "Recipe", "name": "Homemade Pasta", "recipeYield": "4 servings" }
            ]
          }
        </script>
      `;
      const blocks = extractJsonLd(html);
      const recipe = blocks.find((b) => b["@type"] === "Recipe");
      expect(recipe).toBeDefined();
      expect(recipe.name).toBe("Homemade Pasta");
    });

    it("handles multiple script tags and multi-type arrays", () => {
      const html = `
        <script type="application/ld+json">
          [
            { "@type": ["Recipe", "Product"], "name": "Artisan Bread" }
          ]
        </script>
        <script type="application/ld+json">
          { "@type": "Organization", "name": "Bakery Co" }
        </script>
      `;
      const blocks = extractJsonLd(html);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      const recipe = blocks.find((b) => Array.isArray(b["@type"]) && b["@type"].includes("Recipe"));
      expect(recipe).toBeDefined();
      expect(recipe.name).toBe("Artisan Bread");
    });
  });

  describe("parseRecipeFromJsonLd (Zero-Fabrication & Fidelity)", () => {
    it("extracts complete recipe without fabricating missing times", () => {
      const jsonLd = [
        {
          "@context": "https://schema.org",
          "@type": "Recipe",
          "name": "Simple Tomato Soup",
          "description": "A comforting bowl of soup.",
          "recipeIngredient": [
            "2 lbs ripe tomatoes, quartered",
            "1 yellow onion, diced",
            "3 cloves garlic",
            "2 cups vegetable broth"
          ],
          "recipeInstructions": [
            "Roast tomatoes and onions in oven.",
            "Blend with broth until smooth."
          ],
          "recipeYield": "4 servings"
        }
      ];

      const result = parseRecipeFromJsonLd(jsonLd, "https://example.com/tomato-soup");
      expect(result).not.toBeNull();
      if (!result) return;

      expect(result.title).toBe("Simple Tomato Soup");
      expect(result.servings).toBe(4);
      // Zero-fabrication check: missing times must NOT default to 15/30/45 mins
      expect(result.prepTime).toBe("");
      expect(result.cookTime).toBe("");
      expect(result.totalTime).toBe("");
      expect(result.ingredients).toHaveLength(4);
      expect(result.instructions).toHaveLength(2);
      expect(result.instructions[0].stepNumber).toBe(1);
      expect(result.instructions[1].stepNumber).toBe(2);

      // Verify no automatic ingredient wikilinks were created
      result.ingredients.forEach((ing) => {
        expect(ing.name).not.toContain("[[");
        expect(ing.name).not.toContain("]]");
      });

      // Verify YAML frontmatter has no fabricated times
      expect(result.rawMarkdown).not.toContain('prep_time: "15 mins"');
      expect(result.rawMarkdown).not.toContain('cook_time: "30 mins"');
    });

    it("extracts complex HowToSection and HowToStep instruction hierarchies", () => {
      const jsonLd = [
        {
          "@context": "https://schema.org",
          "@type": "Recipe",
          "name": "French Croissants",
          "prepTime": "PT45M",
          "cookTime": "PT20M",
          "totalTime": "PT1H5M",
          "recipeYield": "12 croissants",
          "recipeIngredient": [
            "500g bread flour",
            "300g cold unsalted butter",
            "10g salt"
          ],
          "recipeInstructions": [
            {
              "@type": "HowToSection",
              "name": "Dough Preparation",
              "itemListElement": [
                { "@type": "HowToStep", "text": "Mix flour, water, and yeast into a shaggy dough." },
                { "@type": "HowToStep", "text": "Knead for 8 minutes and chill for 1 hour." }
              ]
            },
            {
              "@type": "HowToSection",
              "name": "Lamination & Baking",
              "itemListElement": [
                { "@type": "HowToStep", "text": "Encase butter block and perform three letter turns." },
                { "@type": "HowToStep", "text": "Shape into crescents and bake at 200°C for 20 mins." }
              ]
            }
          ],
          "nutrition": {
            "calories": "320 kcal"
          }
        }
      ];

      const result = parseRecipeFromJsonLd(jsonLd, "https://example.com/croissants");
      expect(result).not.toBeNull();
      if (!result) return;

      expect(result.title).toBe("French Croissants");
      expect(result.prepTime).toBe("45 mins");
      expect(result.cookTime).toBe("20 mins");
      expect(result.totalTime).toBe("1 hr 5 mins");
      expect(result.servings).toBe(12);
      expect(result.calories).toBe("320 kcal");
      expect(result.instructions).toHaveLength(4);
      expect(result.instructions[0].text).toContain("Mix flour");
      expect(result.instructions[3].text).toContain("Shape into crescents");
    });
  });

  describe("Pipeline Priority & Offline Execution", () => {
    it("extracts recipe synchronously via JSON-LD without Gemini call when valid schema is present in HTML", async () => {
      const sampleHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Awesome Guacamole</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Recipe",
                "name": "Authentic Guacamole",
                "recipeYield": "6 servings",
                "prepTime": "PT10M",
                "recipeIngredient": [
                  "3 ripe avocados",
                  "1/2 cup diced white onion",
                  "1 tbsp fresh lime juice",
                  "1/4 cup chopped cilantro",
                  "1 tsp sea salt"
                ],
                "recipeInstructions": [
                  "Mash avocados in a bowl.",
                  "Stir in onion, lime juice, cilantro, and salt.",
                  "Serve immediately with tortilla chips."
                ]
              }
            </script>
          </head>
          <body><h1>Authentic Guacamole</h1></body>
        </html>
      `;

      const result = await grabRecipeFromWeb({ html: sampleHtml });
      expect(result.title).toBe("Authentic Guacamole");
      expect(result.prepTime).toBe("10 mins");
      expect(result.cookTime).toBe("");
      expect(result.servings).toBe(6);
      expect(result.ingredients).toHaveLength(5);
      expect(result.instructions).toHaveLength(3);
    });
  });

  describe("WAF Protection Detection", () => {
    it("instantiates WafProtectionError with code WAF_PROTECTION_BLOCKED", () => {
      const defaultErr = new WafProtectionError(403);
      expect(defaultErr.statusCode).toBe(403);
      expect(defaultErr.code).toBe("WAF_PROTECTION_BLOCKED");
      expect(defaultErr.message).toContain("403");

      const customErr = new WafProtectionError(402, "Cloudflare WAF Block (Payment Required / Blocked)");
      expect(customErr.statusCode).toBe(402);
      expect(customErr.code).toBe("WAF_PROTECTION_BLOCKED");
      expect(customErr.message).toBe("Cloudflare WAF Block (Payment Required / Blocked)");
    });
  });

  describe("ZERO-FABRICATION Data Fidelity", () => {
    it("Test A: missing yield -> servings undefined and no fabricated servings in Markdown", () => {
      const result = parseRecipeFromJsonLd([{
        "@type": "Recipe",
        name: "No Yield Recipe",
        recipeIngredient: ["2 cups flour"],
        recipeInstructions: ["Mix."],
      }]);

      expect(result).not.toBeNull();
      expect(result!.servings).toBeUndefined();
      expect(result!.rawMarkdown).not.toContain("servings:");
      expect(result!.rawMarkdown).not.toMatch(/servings:\s*\d/);
    });

    it("Test B: valid yield strings still resolve correctly", () => {
      const cases: Array<[string, number]> = [
        ["4 servings", 4],
        ["Serves 4", 4],
        ["4 to 6 servings", 4],
        ["4-6 servings", 4],
        ["Makes 24 cookies", 24],
      ];
      for (const [yieldStr, expected] of cases) {
        const r = parseRecipeFromJsonLd([{
          "@type": "Recipe",
          name: "Yielded Recipe",
          recipeYield: yieldStr,
          recipeIngredient: ["1 cup flour"],
          recipeInstructions: ["Mix."],
        }]);
        expect(r?.servings).toBe(expected);
      }
    });

    it("Test C: missing ingredients/instructions -> no fabricated placeholder content", async () => {
      const origKey = process.env.GEMINI_API_KEY;
      try {
        // Ensure deterministic offline fallback test without external network latency
        delete process.env.GEMINI_API_KEY;

        const viaJsonLd = parseRecipeFromJsonLd([{
          "@type": "Recipe",
          name: "Empty Recipe",
          recipeIngredient: [],
          recipeInstructions: [],
        }]);
        expect(viaJsonLd?.ingredients).toHaveLength(0);
        expect(viaJsonLd?.instructions).toHaveLength(0);

        // Heuristic fallback path: raw text that yields no structure
        const viaHeuristic = await grabRecipeFromWeb({ rawText: "Just a vague note with no structure to extract." });
        expect(viaHeuristic.ingredients).toHaveLength(0);
        expect(viaHeuristic.instructions).toHaveLength(0);

        for (const md of [viaJsonLd?.rawMarkdown ?? "", viaHeuristic.rawMarkdown]) {
          expect(md).not.toContain("Ingredients as noted");
          expect(md).not.toContain("Follow recipe steps as written.");
          expect(md).not.toContain("2 tbsp Olive Oil");
          expect(md).not.toContain("1 tsp Sea Salt");
          expect(md).not.toContain("Prepare ingredients");
        }
      } finally {
        if (origKey !== undefined) {
          process.env.GEMINI_API_KEY = origKey;
        }
      }
    });

    it("Test D: missing image -> no image key; present image preserved", () => {
      const noImage = parseRecipeFromJsonLd([{
        "@type": "Recipe",
        name: "No Image Recipe",
        recipeIngredient: ["1 cup flour"],
        recipeInstructions: ["Mix."],
      }]);
      expect(noImage?.rawMarkdown).not.toContain("image:");

      const withImage = parseRecipeFromJsonLd([{
        "@type": "Recipe",
        name: "With Image Recipe",
        image: "https://images.example.com/photo.jpg",
        recipeIngredient: ["1 cup flour"],
        recipeInstructions: ["Mix."],
      }]);
      expect(withImage?.rawMarkdown).toContain('image: "https://images.example.com/photo.jpg"');
    });
  });
});

describe("RecipeGrabber - provider abstraction parity (direct gemini removed)", () => {
  const SAMPLE_TEXT =
    "Creamy Garlic Pasta\n1 cup pasta, 2 cloves garlic, 1 tbsp olive oil\nInstructions:\n1. Cook pasta.\n2. Saute garlic.\n3. Combine.";

  const modelAwareGemini = (handler: (params: { model: string; config?: any }) => { text?: string } | never) => {
    const fakeGemini: any = {
      models: { generateContent: vi.fn().mockImplementation(async (params: any) => handler(params)) },
    };
    vi.mocked(getGemini).mockReturnValue(fakeGemini);
    return fakeGemini.models.generateContent;
  };

  beforeEach(() => {
    // recipeGrabber opts into a bounded same-model retry (backoff 600ms). Resolve
    // those sleeps on a microtask so unit tests never actually wait.
    vi.stubGlobal("setTimeout", ((cb: () => void) => {
      Promise.resolve().then(() => {
        (cb as () => void)();
      });
      return 0;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    vi.mocked(getGemini).mockReturnValue(null);
    delete process.env.GEMINI_API_KEY;
    vi.unstubAllGlobals();
  });

  it("P1: AI extraction routes through the provider (primary explicit, temp 0.1, MINIMAL thinking, schema parity)", async () => {
    const seen: any[] = [];
    modelAwareGemini((p) => {
      seen.push(p);
      return { text: JSON.stringify({
        title: "Creamy Garlic Pasta", description: "A creamy pasta.", cuisine: "Italian", category: "Dinner",
        difficulty: "Easy", prepTime: "10 mins", cookTime: "15 mins", totalTime: "25 mins", servings: 4,
        calories: "500", rating: 5, source: "test", image: "", tags: ["food/recipes", "cuisine/italian"],
        ingredients: [{ original: "1 cup pasta", amount: 1, unit: "cup", name: "pasta" }],
        instructions: [{ stepNumber: 1, text: "Cook pasta." }], callouts: [], notes: "",
      })};
    });
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      expect(result.title).toBe("Creamy Garlic Pasta");
      expect(result.servings).toBe(4);
      // Primary model issued FIRST and explicitly (no silent role-model default).
      expect(seen[0].model).toBe(MODEL_CONFIG.recipeGrabberPrimary);
      expect(seen[0].config.temperature).toBe(0.1);
      expect(seen[0].config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
      expect(seen[0].config.responseMimeType).toBe("application/json");
      const rs = seen[0].config.responseSchema;
      expect(rs.type).toBe("OBJECT");
      expect(rs.required).toEqual(["title", "cuisine", "category", "ingredients", "instructions"]);
      // INTEGER types (servings / stepNumber) preserved through the adapter.
      expect(rs.properties.servings).toEqual({ type: "INTEGER" });
      expect(rs.properties.instructions.items.properties.stepNumber).toEqual({ type: "INTEGER" });
      // Nested required + enum preserved.
      expect(rs.properties.ingredients.items.required).toEqual(["original", "name"]);
      expect(rs.properties.instructions.items.required).toEqual(["stepNumber", "text"]);
      expect(rs.properties.callouts.items.properties.type.enum).toEqual(["tip", "warning", "info", "note", "important"]);
      // Only the primary model was needed; fallback/alias not called.
      expect(seen.length).toBe(1);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P2: provider primary throws (transient) -> same-model retry -> fallback model attempted (order primary,fallback preserved)", async () => {
    const seenModels: string[] = [];
    modelAwareGemini((p) => {
      seenModels.push(p.model);
      if (p.model === MODEL_CONFIG.recipeGrabberPrimary) throw new Error("primary down");
      return { text: JSON.stringify({ title: "Pasta", cuisine: "Italian", category: "Dinner", ingredients: [], instructions: [] }) };
    });
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      expect(result.title).toBe("Pasta");
      // "primary down" classifies as UNAVAILABLE -> the restored retry runs the
      // SAME primary model twice before falling back to the fallback model.
      expect(seenModels).toEqual([
        MODEL_CONFIG.recipeGrabberPrimary,
        MODEL_CONFIG.recipeGrabberPrimary,
        MODEL_CONFIG.recipeGrabberFallback,
      ]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P3: provider yields invalid JSON -> heuristic fallback (no client-visible exception)", async () => {
    modelAwareGemini(() => ({ text: "{ not valid json" }));
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      expect(result.title).toBeTruthy();
      expect(result.ingredients.length).toBeGreaterThan(0);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P4: provider unavailable (no key) -> heuristic fallback with no AI attempt", async () => {
    let aiCalls = 0;
    modelAwareGemini(() => {
      aiCalls++;
      return { text: "{}" };
    });
    vi.mocked(getGemini).mockReturnValue(null);
    const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
    expect(result.title).toBeTruthy();
    expect(aiCalls).toBe(0);
  });

  it("P5: provider models fail -> heuristic fallback (no client-visible exception)", async () => {
    const seenModels: string[] = [];
    modelAwareGemini((p) => {
      seenModels.push(p.model);
      throw new Error("model down");
    });
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      expect(result.title).toBeTruthy();
      expect(seenModels).toContain(MODEL_CONFIG.recipeGrabberPrimary);
      expect(seenModels).toContain(MODEL_CONFIG.recipeGrabberFallback);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P6: missing source fields remain omitted (zero-fabrication) via the provider path", async () => {
    modelAwareGemini(() => ({
      text: JSON.stringify({ title: "Minimal", cuisine: "General", category: "Main Course", ingredients: [], instructions: [] }),
    }));
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      expect(result.title).toBe("Minimal");
      expect(result.servings).toBeUndefined();
      expect(result.prepTime).toBe("");
      expect(result.cookTime).toBe("");
      expect(result.calories).toBe("");
      expect(result.ingredients).toEqual([]);
      expect(result.instructions).toEqual([]);
      // No fabricated times/yield in the generated Markdown.
      expect(result.rawMarkdown).not.toContain("prep_time:");
      expect(result.rawMarkdown).not.toContain("cook_time:");
      expect(result.rawMarkdown).not.toMatch(/servings:\s*\d/);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P7: raw AI output still flows through normalization/validation (defaults applied, no bypass)", async () => {
    modelAwareGemini(() => ({
      text: JSON.stringify({ title: "  ", cuisine: "", category: "", ingredients: null, instructions: [{ stepNumber: 1, text: "Do a thing." }] }),
    }));
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      // title empty -> falls back to metaTags.title or "Imported Recipe".
      expect(result.title).toBeTruthy();
      // calories empty -> "" (not fabricated).
      expect(result.calories).toBe("");
      // cuisine empty -> "General" default.
      expect(result.cuisine).toBe("General");
      // ingredients null -> [] (never a fabricated placeholder).
      expect(result.ingredients).toEqual([]);
      // instructions present -> retained, stepNumber preserved (integer).
      expect(result.instructions[0].text).toBe("Do a thing.");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P8: transient retryable failure (429) on the primary model is retried and the SAME model then succeeds", async () => {
    let gCalls = 0;
    const seenModels: string[] = [];
    modelAwareGemini((p) => {
      seenModels.push(p.model);
      gCalls++;
      if (gCalls === 1) throw Object.assign(new Error("rate limit exceeded"), { status: 429 });
      return { text: JSON.stringify({ title: "Recovered", cuisine: "Italian", category: "Dinner", ingredients: [], instructions: [] }) };
    });
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      // The AI result is used — the deterministic heuristic is NOT reached.
      expect(result.title).toBe("Recovered");
      // Same primary model executed twice (transient retry restored), then success.
      expect(seenModels).toEqual([MODEL_CONFIG.recipeGrabberPrimary, MODEL_CONFIG.recipeGrabberPrimary]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P9: all candidates+retries fail -> deterministic heuristic fallback with sanitized terminal diagnostics", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let gCalls = 0;
    modelAwareGemini((p) => {
      gCalls++;
      if (gCalls % 2 === 1) throw Object.assign(new Error("rate limit exceeded"), { status: 429 });
      throw new Error("model down");
    });
    try {
      const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
      expect(result.title).toBeTruthy();
      expect(result.ingredients.length).toBeGreaterThan(0); // heuristic fallback recovered
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("[AI fallback][attempt]");
      expect(logged).toContain("[Kitchen grab]");
      expect(logged).toContain("code=");
      // No prompt / recipe content / key / request-body leakage in diagnostics.
      expect(logged).not.toContain("Creamy Garlic Pasta");
      expect(logged).not.toContain("DEEPSEEK_API_KEY");
      expect(logged).not.toContain("OPENROUTER_API_KEY");
      expect(logged).not.toContain("Reasoning content");
    } finally {
      warnSpy.mockRestore();
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });
});
