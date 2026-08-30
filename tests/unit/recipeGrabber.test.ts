import { describe, it, expect } from "vitest";
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
