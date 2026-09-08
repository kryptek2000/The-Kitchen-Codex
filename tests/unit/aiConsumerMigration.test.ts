import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recoverRecipeMetadata } from "../../server/metadataRecovery.js";
import { grabRecipeFromWeb } from "../../server/recipeGrabber.js";
import { getGemini } from "../../server/geminiClient.js";

// Gemini is mocked as available-but-failing so the supplier-neutral fallback
// engine routes the work to the next capable provider (OpenRouter).
vi.mock("../../server/geminiClient.js", () => ({
  getGemini: vi.fn(() => ({
    models: { generateContent: vi.fn(async () => { throw new Error("gemini down"); }) },
  })),
}));

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function openRouterResponse(content: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubOpenRouter(content: unknown) {
  fetchMock = vi.fn(async (url: string) => {
    if (url !== OPENROUTER_URL) throw new Error(`unexpected fetch: ${url}`);
    return openRouterResponse(content);
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
  vi.mocked(getGemini).mockReturnValue({
    models: { generateContent: vi.fn(async () => { throw new Error("gemini down"); }) },
  } as any);
  stubOpenRouter({});
  // recipeGrabber retries transient failures with a 600ms backoff; resolve sleeps
  // on a microtask so these consumer tests never actually wait.
  vi.stubGlobal("setTimeout", ((cb: () => void) => {
    Promise.resolve().then(() => {
      (cb as () => void)();
    });
    return 0;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  vi.unstubAllGlobals();
  vi.mocked(getGemini).mockReturnValue(null);
});

describe("metadataRecovery — provider-neutral migration (v0.7 1C #31)", () => {
  it("routes through resolveRoleCandidates + runWithAiFallback and uses the next capable provider (OpenRouter)", async () => {
    stubOpenRouter({
      category: { value: "Pasta", confidence: "medium", source: "culinary_inference", explanation: "Classified as Pasta" },
      prepTime: { value: "15 mins", confidence: "medium", source: "culinary_inference", explanation: "Estimated" },
    });
    const result = await recoverRecipeMetadata({ title: "T", ingredients: ["1 cup flour"], instructions: ["Mix."] });
    // Gemini failed; OpenRouter produced the recovered metadata.
    expect(result.category?.value).toBe("Pasta");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OPENROUTER_URL);
  });

  it("wrong-shaped / non-JSON provider output is rejected and falls through (no fabricated metadata)", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{ not json" } }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await recoverRecipeMetadata({ title: "T", ingredients: ["1 cup flour"], instructions: ["Mix."] });
    // Invalid structured output -> algorithmic fallback; no fabrication of cookTime/servings.
    expect(result.cookTime).toBeUndefined();
    expect(result.servings).toBeUndefined();
    expect(result.category?.value).toBeDefined();
  });

  it("missing metadata stays missing (zero-fabrication) across the provider path", async () => {
    stubOpenRouter({
      prepTime: { value: "15 mins", confidence: "medium", source: "culinary_inference", explanation: "est" },
    });
    const result = await recoverRecipeMetadata({ title: "T", ingredients: ["1 cup flour"], instructions: ["Mix."] });
    expect(result.prepTime?.value).toBe("15 mins");
    expect(result.cookTime).toBeUndefined();
    expect(result.servings).toBeUndefined();
  });
});

describe("recipeGrabber — provider-neutral migration (v0.7 1C #32)", () => {
  const SAMPLE_TEXT =
    "Creamy Garlic Pasta\n1 cup pasta, 2 cloves garlic, 1 tbsp olive oil\nInstructions:\n1. Cook pasta.\n2. Saute garlic.\n3. Combine.";

  it("routes through resolveRoleCandidates + runWithAiFallback and uses the next capable provider (OpenRouter)", async () => {
    stubOpenRouter({
      title: "Creamy Garlic Pasta",
      cuisine: "Italian",
      category: "Dinner",
      difficulty: "Easy",
      ingredients: [{ original: "1 cup pasta", amount: 1, unit: "cup", name: "pasta" }],
      instructions: [{ stepNumber: 1, text: "Cook pasta." }],
      tags: ["food/recipes"],
    });
    const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
    expect(result.title).toBe("Creamy Garlic Pasta");
    expect(result.cuisine).toBe("Italian");
    expect(result.sourceUrl).toBeUndefined(); // no AI-generated source URL fabricated
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OPENROUTER_URL);
  });

  it("AI output is still schema-normalized downstream (no bypass, no auto-save, zero-fabrication)", async () => {
    stubOpenRouter({
      title: "  ",
      cuisine: "",
      category: "",
      ingredients: null,
      instructions: [{ stepNumber: 1, text: "Do a thing." }],
    });
    const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
    expect(result.title).toBeTruthy(); // normalized default applied, not a blank title
    expect(result.cuisine).toBe("General");
    expect(result.ingredients).toEqual([]); // null -> [] (never fabricated placeholder)
    expect(result.instructions[0].text).toBe("Do a thing.");
    expect(result.servings).toBeUndefined();
    expect(result.prepTime).toBe("");
    // No second importer / no auto-save marker in output.
    expect(result.rawMarkdown).toBeDefined();
  });

  it("all provider roles fail -> deterministic heuristic fallback (no client-visible exception)", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await grabRecipeFromWeb({ rawText: SAMPLE_TEXT });
    expect(result.title).toBeTruthy();
    expect(result.ingredients.length).toBeGreaterThan(0);
  });
});
