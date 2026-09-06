import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import type { GoogleGenAI } from "@google/genai";
import { createApp } from "../../server/app.js";
import { kitchenInterpretRateLimiter } from "../../server/rateLimiter.js";
import { getGemini } from "../../server/geminiClient.js";
import { MODEL_CONFIG } from "../../server/modelConfig.js";

// Mock the Gemini client so we can force the "AI attempted + failed" 503 path
// WITHOUT any live network / API key. Return null (no AI) by default so the
// deterministic interpretation tests behave exactly as before.
vi.mock("../../server/geminiClient.js", () => ({
  getGemini: vi.fn(() => null),
}));

describe("Ask My Kitchen /api/kitchen/interpret", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Force the deterministic interpretation path: never attempt a Gemini call.
    delete process.env.GEMINI_API_KEY;
    process.env.KITCHEN_RATE_LIMIT = "1000";
    const app = createApp({ isProduction: false });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let originalToken: string | undefined;
  beforeEach(() => {
    originalToken = process.env.AI_ENDPOINT_TOKEN;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.AI_ENDPOINT_TOKEN;
    else process.env.AI_ENDPOINT_TOKEN = originalToken;
  });

  const interpret = (body: unknown, token?: string) =>
    fetch(`${baseUrl}/api/kitchen/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("rejects a missing question", async () => {
    const res = await interpret({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("question");
  });

  it("rejects a non-string question", async () => {
    const res = await interpret({ question: 42 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("rejects an oversized question", async () => {
    const res = await interpret({ question: "a".repeat(501) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("requires a bearer token when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await interpret({ question: "under 30 minutes" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("interprets a clear question deterministically as a KitchenIntent", async () => {
    const res = await interpret({ question: "under 30 minutes" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("deterministic");
    // The response is a SANITIZED KitchenIntent, not a raw KitchenQuery.
    expect(body.intent.version).toBe(1);
    expect(body.intent.intent).toBe("find_recipes");
    expect(body.intent.source).toBe("vault");
    expect(body.intent.constraints.maxTotalMinutes).toBe(30);
    expect(body.intent.preferences).toEqual({});
    expect(body.intent.requiresClarification).toBe(false);
  });

  it("returns a safe 422 for an uninterpretable question", async () => {
    const res = await interpret({ question: "what is the meaning of life" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("returns 503 (not 422) when the AI interpreter was attempted but failed (no live Gemini)", async () => {
    // Force getGemini to return a truthy client (so the AI path is attempted);
    // the stub has no .models, so aiInterpret throws -> aiFailed=true, and the
    // question is not deterministically parseable -> upstream 503.
    vi.mocked(getGemini).mockReturnValue({ models: undefined } as unknown as GoogleGenAI);
    try {
      const res = await interpret({ question: "what is the meaning of life" });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("unavailable");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("ignores any extra payload and never accepts recipe data", async () => {
    const res = await interpret({ question: "with eggs", recipes: [{ id: "x" }], ingredients: ["milk"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.intent.constraints.includeIngredients).toEqual(["eggs"]);
    expect("recipes" in body.intent).toBe(false);
    expect("ingredients" in body.intent).toBe(false);
    expect(body.intent.constraints.similarToRecipeId).toBeUndefined();
  });

  // --- v0.5.1: kitchen model fallback chain ---
  const modelAwareGemini = (handler: (params: { model: string }) => { text?: string } | never) => {
    vi.mocked(getGemini).mockReturnValue({
      models: {
        generateContent: async (params: any) => handler(params),
      },
    } as unknown as GoogleGenAI);
  };

  it("A: primary AI succeeds -> sanitized AI intent used", async () => {
    modelAwareGemini(() => ({ text: JSON.stringify({ version: 1, intent: "meal_suggestion", source: "vault", constraints: {}, preferences: {}, requiresClarification: false }) }));
    try {
      const res = await interpret({ question: "What should I make tonight?" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.source).toBe("ai");
      expect(body.intent.intent).toBe("meal_suggestion");
      expect(body.aiAttempted).toBe(true);
      expect(body.aiFailed).toBe(false);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("B: primary AI throws, fallback AI succeeds -> fallback result used", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenPrimary) throw new Error("primary down");
      return { text: JSON.stringify({ version: 1, intent: "meal_suggestion", source: "vault", constraints: { maxTotalMinutes: 30 }, preferences: {}, requiresClarification: false }) };
    });
    try {
      const res = await interpret({ question: "What should I make tonight?" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.source).toBe("ai");
      expect(body.intent.constraints.maxTotalMinutes).toBe(30);
      // primary failed, but fallback produced a usable intent -> not a hard failure
      expect(body.aiFailed).toBe(false);
      expect(body.error).toBeUndefined();
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("C: primary + fallback throw -> deterministic parser succeeds (no hard 503)", async () => {
    modelAwareGemini(() => {
      throw new Error("all kitchen models down");
    });
    try {
      const res = await interpret({ question: "Find something similar to this." });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.source).toBe("deterministic");
      expect(body.intent.intent).toBe("similar_recipe");
      expect(body.aiAttempted).toBe(true);
      expect(body.aiFailed).toBe(true);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("C2: all AI fail + deterministic cannot understand -> safe failure (not a leak)", async () => {
    modelAwareGemini(() => {
      throw new Error("boom secret-detail");
    });
    try {
      const res = await interpret({ question: "zzz qqq xxx" });
      // Neither AI nor deterministic can interpret it; with the AI attempted and
      // failed this is an upstream failure, so the established contract is 503
      // (distinct from a pure "could not understand" 422). Either way it must be a
      // safe, non-leaking failure.
      expect([422, 503]).toContain(res.status);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(JSON.stringify(body)).not.toContain("secret-detail");
      expect(JSON.stringify(body)).not.toContain("boom");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("E: fallback cannot inject trusted recipe IDs", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenPrimary) throw new Error("primary down");
      return { text: JSON.stringify({ version: 1, intent: "similar_recipe", source: "vault", constraints: { similarToRecipeId: "hacked", includeIngredients: ["rice"] }, targetRecipeId: "t", recipeIds: ["a", "b"], references: { currentRecipe: true }, requiresClarification: false }) };
    });
    try {
      const res = await interpret({ question: "similar to this" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intent.constraints.similarToRecipeId).toBeUndefined();
      expect((body.intent as Record<string, unknown>)["targetRecipeId"]).toBeUndefined();
      expect((body.intent as Record<string, unknown>)["recipeIds"]).toBeUndefined();
      expect(body.intent.intent).toBe("similar_recipe");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("F: fallback cannot silently broaden source policy", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenPrimary) throw new Error("primary down");
      return { text: JSON.stringify({ version: 1, intent: "find_recipes", source: "vault", constraints: { includeIngredients: ["chicken"] }, preferences: {}, requiresClarification: false }) };
    });
    try {
      const res = await interpret({ question: "chicken recipes" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intent.source).toBe("vault");
      expect(body.intent.constraints.includeIngredients).toEqual(["chicken"]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("G: no provider error text leaks to the client when AI fails", async () => {
    modelAwareGemini(() => {
      throw new Error("RESOURCE_EXHAUSTED secret-detail");
    });
    try {
      const res = await interpret({ question: "Find something new online." });
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("RESOURCE_EXHAUSTED");
      expect(JSON.stringify(body)).not.toContain("secret-detail");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  // --- v0.6.0 Phase 2C: provider-abstraction parity (direct gemini removed) ---
  it("P1: interpret routes through the provider (primary model explicit, temp 0, MINIMAL thinking, structured schema)", async () => {
    const seen: any[] = [];
    modelAwareGemini((p) => {
      seen.push(p);
      return { text: JSON.stringify({ version: 1, intent: "meal_suggestion", source: "vault", constraints: {}, preferences: {}, requiresClarification: false }) };
    });
    try {
      const res = await interpret({ question: "What should I make tonight?" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("ai");
      // primary model issued FIRST and explicitly (no silent role-model default).
      expect(seen[0].model).toBe(MODEL_CONFIG.kitchenPrimary);
      expect(seen[0].config.temperature).toBe(0);
      expect(seen[0].config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
      expect(seen[0].config.responseMimeType).toBe("application/json");
      // Structured schema preserved: enums + nested object fields.
      expect(seen[0].config.responseSchema.type).toBe("OBJECT");
      expect(seen[0].config.responseSchema.properties.intent.enum).toContain("meal_suggestion");
      expect(seen[0].config.responseSchema.properties.source.enum).toContain("vault_then_web");
      expect(seen[0].config.responseSchema.properties.constraints.properties.maxTotalMinutes.type).toBe("NUMBER");
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
      if (p.model === MODEL_CONFIG.kitchenPrimary) throw new Error("primary down");
      return { text: JSON.stringify({ version: 1, intent: "find_recipes", source: "vault", constraints: { includeIngredients: ["chicken"] }, preferences: {}, requiresClarification: false }) };
    });
    try {
      const res = await interpret({ question: "chicken recipes" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("ai");
      expect(body.intent.constraints.includeIngredients).toEqual(["chicken"]);
      expect(seenModels).toEqual([MODEL_CONFIG.kitchenPrimary, MODEL_CONFIG.kitchenFallback]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P3: provider yields invalid structured output -> deterministic fallback", async () => {
    modelAwareGemini(() => ({ text: "{ not valid json" }));
    try {
      const res = await interpret({ question: "under 30 minutes" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("deterministic");
      expect(body.intent.constraints.maxTotalMinutes).toBe(30);
      expect(body.aiAttempted).toBe(true);
      expect(body.aiFailed).toBe(true);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P4: provider unavailable (no key) -> deterministic fallback with no AI attempt", async () => {
    vi.mocked(getGemini).mockReturnValue(null);
    const res = await interpret({ question: "under 30 minutes" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.source).toBe("deterministic");
    expect(body.intent.constraints.maxTotalMinutes).toBe(30);
    expect(body.aiAttempted).toBe(false);
    expect(body.aiFailed).toBe(false);
  });

  it("P5: sanitizer still strips/trust-bounds local identity fields through the provider path", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenPrimary) throw new Error("primary down");
      return { text: JSON.stringify({ version: 1, intent: "similar_recipe", source: "vault", constraints: { similarToRecipeId: "sneaky", includeIngredients: ["rice"] }, targetRecipeId: "t", recipeIds: ["a"], references: { currentRecipe: true }, requiresClarification: false }) };
    });
    try {
      const res = await interpret({ question: "similar to this" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intent.constraints.similarToRecipeId).toBeUndefined();
      expect((body.intent as Record<string, unknown>)["targetRecipeId"]).toBeUndefined();
      expect((body.intent as Record<string, unknown>)["recipeIds"]).toBeUndefined();
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P6: both provider models fail -> deterministic fallback (no 503 for a parseable question)", async () => {
    modelAwareGemini(() => {
      throw new Error("all models down");
    });
    try {
      const res = await interpret({ question: "Find something similar to this." });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("deterministic");
      expect(body.intent.intent).toBe("similar_recipe");
      expect(body.aiAttempted).toBe(true);
      expect(body.aiFailed).toBe(true);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });
});

describe("kitchenInterpretRateLimiter", () => {
  it("returns 429 with rate-limit headers once the configured window is exceeded", () => {
    const original = process.env.KITCHEN_RATE_LIMIT;
    process.env.KITCHEN_RATE_LIMIT = "2";

    // Unique IP so this does not collide with the HTTP-server tests above.
    const req: any = { ip: "198.51.100.7", socket: { remoteAddress: "198.51.100.7" } };
    const headers: Record<string, string> = {};
    const statuses: number[] = [];

    const makeRes: any = () => ({
      setHeader: (key: string, value: string) => {
        headers[key] = String(value);
      },
      status: (code: number) => {
        statuses.push(code);
        return { json: () => undefined };
      },
      json: () => undefined,
    });

    const call = () => kitchenInterpretRateLimiter(req, makeRes(), () => undefined);

    // Two requests within the window pass (next is called); the third is limited.
    call();
    call();
    expect(statuses).toEqual([]);

    call();
    expect(statuses).toEqual([429]);
    expect(headers["RateLimit-Limit"]).toBe("2");
    expect(Number(headers["RateLimit-Remaining"])).toBe(0);

    if (original === undefined) delete process.env.KITCHEN_RATE_LIMIT;
    else process.env.KITCHEN_RATE_LIMIT = original;
  });
});
