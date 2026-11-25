import { describe, it, expect, beforeAll } from "vitest";
import type { NetworkAdapter, NetworkResponse } from "../../src/application/adapters/NetworkAdapter.js";
import {
  AI_SELECTION_SETTINGS_KEY,
  hydrateAiSelections,
  saveAiSelectionWithOutcome,
  TEXT_SELECTION_HEADER,
} from "../../src/application/aiSelection.js";

// The application AI-selection layer fails closed until hydrated; hydrate the
// shared module once so the client flow can build request options.
beforeAll(async () => {
  await hydrateAiSelections({ get: async () => undefined });
});
import {
  buildCreateRecipeRequest,
  parseEditedDraftLines,
  parseGeneratedIngredientLine,
  parseGeneratedStepLine,
  requestGeneratedRecipe,
  CREATE_RECIPE_PATH,
  CreateRecipeClientError,
} from "../../src/utils/createForMe.js";
import type { GeneratedRecipeDraft } from "../../src/schema/generatedRecipe.js";

const SENTINEL = "SUPER_SECRET_CREATE_PROMPT_SENTINEL";

function postNetwork(data: unknown, ok = true, status = 200): NetworkAdapter {
  return {
    post: async <T, B>(_p: string, _body: B) => ({ status, ok, data: data as T }) as NetworkResponse<T>,
    get: async () => ({ status, ok, data: undefined }),
    request: async () => ({ status, ok, data: undefined }),
  } as unknown as NetworkAdapter;
}

const DRAFT = {
  title: "Skillet Dinner",
  ingredients: [{ name: "chicken" }],
  steps: ["Sear the chicken."],
};

describe("create for me client logic (v0.7 2A)", () => {
  it("buildCrea recipe request is bounded and never pushes whole-vault data", () => {
    const req = buildCreateRecipeRequest(SENTINEL + " dinner", {
      servings: 4,
      maxTotalMinutes: 30,
      cuisine: "Thai",
      course: "Dinner",
      dietary: "vegetarian, dairy-free",
      excludeIngredients: "peanuts",
    });
    expect(req.prompt).toContain(SENTINEL);
    expect(req.constraints?.servings).toBe(4);
    expect(req.constraints?.dietary).toEqual(["vegetarian", "dairy-free"]);
    expect(req.constraints?.excludeIngredients).toEqual(["peanuts"]);
    // No vault/recipe data fields.
    expect(Object.keys(req)).not.toContain("recipes");
    expect(Object.keys(req)).not.toContain("vault");
  });

  it("requestGeneratedRecipe POSTs to the app path (no direct URL) and returns a validated draft", async () => {
    let path = "";
    let sentBody: unknown;
    const network = {
      post: async (p: string, body: unknown) => {
        path = p;
        sentBody = body;
        return { status: 200, ok: true, data: { draft: DRAFT, provenance: { generated: true, providerId: "gemini", model: "g-m" } } };
      },
      get: async () => ({ status: 200, ok: true, data: undefined }),
      request: async () => ({ status: 200, ok: true, data: undefined }),
    } as unknown as NetworkAdapter;
    const result = await requestGeneratedRecipe(network, "a dinner", {});
    expect(path).toBe(CREATE_RECIPE_PATH);
    expect(path).toBe("/api/recipes/generate");
    expect(sentBody).not.toBeNull();
    expect(result.draft.title).toBe("Skillet Dinner");
    expect(result.provenance.providerId).toBe("gemini");
  });

  it("attaches the native ChatGPT plan selection header to Create for Me", async () => {
    const values = new Map<string, unknown>();
    const settings = {
      get: async (key: string) => values.get(key) as never,
      set: async (key: string, value: unknown) => { values.set(key, value); },
      remove: async (key: string) => { values.delete(key); },
    };
    await saveAiSelectionWithOutcome(
      settings,
      "text",
      "user_selected",
      "chatgpt-plan",
      "gpt-plan-test",
      "native_plan",
      undefined,
      "acct_0123456789abcdef0123456789abcdef",
    );
    let headers: Record<string, string> = {};
    const network = {
      post: async (_path: string, _body: unknown, options?: { headers?: Record<string, string> }) => {
        headers = options?.headers ?? {};
        return { status: 200, ok: true, data: { draft: DRAFT, provenance: { generated: true, providerId: "chatgpt-plan", model: "gpt-plan-test" } } };
      },
      get: async () => ({ status: 200, ok: true, data: undefined }),
      request: async () => ({ status: 200, ok: true, data: undefined }),
    } as unknown as NetworkAdapter;
    await requestGeneratedRecipe(network, "a dinner", {});
    expect(JSON.parse(headers[TEXT_SELECTION_HEADER])).toMatchObject({
      mode: "user_selected",
      providerId: "chatgpt-plan",
      modelId: "gpt-plan-test",
      credentialSource: "native_plan",
      accountKey: "acct_0123456789abcdef0123456789abcdef",
    });
    expect(values.has(AI_SELECTION_SETTINGS_KEY)).toBe(true);
  });

  it("sends the validated current draft on refinement through the same generation endpoint", async () => {
    let sentBody: any;
    const network = {
      post: async (_path: string, body: unknown) => {
        sentBody = body;
        return { status: 200, ok: true, data: { draft: DRAFT, provenance: { generated: true, providerId: "openrouter", model: "selected-model" } } };
      },
      get: async () => ({ status: 200, ok: true, data: undefined }),
      request: async () => ({ status: 200, ok: true, data: undefined }),
    } as unknown as NetworkAdapter;
    const currentDraft: GeneratedRecipeDraft = { title: "Chicken Casserole", servings: 6, ingredients: [{ name: "chicken", amount: 2, unit: "lb" }], steps: [{ text: "Bake." }] };
    await requestGeneratedRecipe(network, "Make it dairy-free", {}, currentDraft);
    expect(sentBody).toMatchObject({ prompt: "Make it dairy-free", currentDraft });
  });

  it("returns a generic-safe error on a non-2xx response, preserving UNSUPPORTED_CAPABILITY code", async () => {
    await expect(requestGeneratedRecipe(postNetwork({ error: "No configured AI provider supports recipe generation.", code: "UNSUPPORTED_CAPABILITY" }, false, 503), "x", {})).rejects.toMatchObject({
      status: 503,
      code: "UNSUPPORTED_CAPABILITY",
    });
    await expect(requestGeneratedRecipe(postNetwork(undefined, false, 500), "x", {})).rejects.toBeInstanceOf(CreateRecipeClientError);
  });

  it("preserves the native ChatGPT plan error codes and bounded messages", async () => {
    await expect(
      requestGeneratedRecipe(
        postNetwork(
          {
            error:
              "ChatGPT plan is selected for recipe creation, but it is not connected or its plan usage is unavailable. No other provider was used.",
            code: "CHATGPT_PLAN_UNAVAILABLE",
          },
          false,
          503,
        ),
        "x",
        {},
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "CHATGPT_PLAN_UNAVAILABLE",
      message: expect.stringMatching(/not connected/i),
    });
    await expect(
      requestGeneratedRecipe(
        postNetwork(
          { error: "ChatGPT plan returned an invalid recipe draft.", code: "CHATGPT_PLAN_INVALID_RESPONSE" },
          false,
          502,
        ),
        "x",
        {},
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "CHATGPT_PLAN_INVALID_RESPONSE",
    });
  });

  it("throws on a malformed response (bad provenance / empty data)", async () => {
    await expect(requestGeneratedRecipe(postNetwork({ draft: DRAFT, provenance: { generated: false } }), "x", {})).rejects.toThrow();
    await expect(requestGeneratedRecipe(postNetwork({ provenance: { generated: true, providerId: "g", model: "m" } }), "x", {})).rejects.toThrow();
  });

  it("provider content can never leak the prompt into the client result", async () => {
    const result = await requestGeneratedRecipe(postNetwork({ draft: DRAFT, provenance: { generated: true, providerId: "g", model: "m" } }), SENTINEL + " prompt", {});
    expect(JSON.stringify(result.draft)).not.toContain(SENTINEL);
    expect(JSON.stringify(result.provenance)).not.toContain(SENTINEL);
  });

  it("parses edited ingredient/step lines without generating wikilinks or numbering artifacts", () => {
    const flour = parseGeneratedIngredientLine("2 cups flour");
    expect(flour?.amount).toBe(2);
    expect(flour?.unit).toBe("cups");
    expect(flour?.name).toContain("flour");
    const salt = parseGeneratedIngredientLine("1 tbsp salt");
    expect(salt?.amount).toBe(1);
    expect(salt?.unit).toBe("tbsp");
    expect(salt?.name).toContain("salt");
    // A wikilink typed by the user is stripped — never carried into a generated recipe.
    const linked = parseGeneratedIngredientLine("1 cup [[coconut milk]]");
    expect(linked?.name).toContain("coconut milk");
    expect(JSON.stringify(linked)).not.toContain("[[");
    expect(parseGeneratedStepLine("1. Zest the lemon.")).toEqual({ text: "Zest the lemon." });
    const edited: GeneratedRecipeDraft = {
      title: "T",
      ingredients: [{ name: "old" }],
      steps: [{ text: "old step" }],
    };
    const out = parseEditedDraftLines(edited, "1 cup pepper\n2 tbsp butter\n\n", "1. Mix the pepper.\n2. Melt the butter.");
    expect(out.ingredients.map((i) => i.name)).toEqual(["pepper", "butter"]);
    expect(out.steps.map((s) => s.text)).toEqual(["Mix the pepper.", "Melt the butter."]);
    for (const ing of out.ingredients) {
      expect((ing as unknown as Record<string, unknown>)["wikilink"]).toBeUndefined();
    }
    expect(JSON.stringify(out)).not.toContain("[[");
  });
});
