import { describe, it, expect, afterEach, vi } from "vitest";
import { getGemini } from "../../server/geminiClient.js";
import {
  GeminiProvider,
  OpenRouterProvider,
  getAiProvider,
  getDefaultAiProvider,
  getRegisteredProviders,
  findRegisteredProvider,
} from "../../server/ai/provider.js";

vi.mock("../../server/geminiClient.js", () => ({
  getGemini: vi.fn(() => null),
}));

function mockGemini(models: { generateContent: any }) {
  vi.mocked(getGemini).mockReturnValue({ models } as any);
}

describe("AiProvider foundation", () => {
  afterEach(() => {
    vi.mocked(getGemini).mockReturnValue(null);
  });

  it("registers Gemini as the default provider", () => {
    expect(getDefaultAiProvider()).toBeInstanceOf(GeminiProvider);
    expect(getDefaultAiProvider().id).toBe("gemini");
  });

  it("registry resolves a known provider (gemini)", () => {
    expect(getAiProvider("gemini")).toBeInstanceOf(GeminiProvider);
  });

  it("registry resolves the second registered provider (openrouter) but not unknown ids", () => {
    expect(getAiProvider("openrouter")).toBeInstanceOf(OpenRouterProvider);
    expect(getAiProvider("deepseek")).toBeUndefined(); // 1C, not yet registered
    expect(getAiProvider("")).toBeUndefined();
  });

  it("openrouter is inert (disabled) when no key is configured", () => {
    const orDesc = findRegisteredProvider(getRegisteredProviders(), "openrouter");
    expect(orDesc?.provider).toBeInstanceOf(OpenRouterProvider);
    expect(orDesc?.enabled).toBe(false); // inert without a key (zero-config Gemini preserved)
  });

  it("declares capability metadata (Gemini has structuredOutput + webSearch)", () => {
    const caps = getDefaultAiProvider().capabilities;
    expect(caps.reasoning).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.recipeGeneration).toBe(true);
    expect(caps.webSearch).toBe(true);
  });

  it("preserves unavailable/null semantics when no key is configured", () => {
    const provider = getDefaultAiProvider();
    expect(getGemini()).toBeNull();
    expect(provider.isAvailable()).toBe(false);
    expect(provider.testConnection()).resolves.toBe(false);
    expect(provider.generate("hi", { model: "m" })).rejects.toThrow();
    expect(
      provider.generateStructured("hi", { type: "object", properties: {} }, { model: "m" })
    ).rejects.toThrow();
  });

  it("does NOT leak any API key through the abstraction", () => {
    const serialized = JSON.stringify({
      id: getDefaultAiProvider().id,
      name: getDefaultAiProvider().name,
      capabilities: getDefaultAiProvider().capabilities,
    });
    expect(serialized).not.toMatch(/GEMINI_API_KEY|AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9]{16,}/);
    expect(Object.keys(getDefaultAiProvider().capabilities).sort()).toEqual([
      "reasoning",
      "recipeGeneration",
      "structuredOutput",
      "webSearch",
    ]);
  });

  it("generate delegates to the provider client and returns text", async () => {
    mockGemini({
      generateContent: async (params: any) => {
        expect(params.contents).toBe("hello");
        expect(params.model).toBe("model-x");
        expect(params.config.temperature).toBe(0);
        return { text: "  world  " };
      },
    });
    const provider = new GeminiProvider();
    const out = await provider.generate("hello", { model: "model-x", temperature: 0 });
    expect(out).toBe("world");
  });

  it("generateStructured maps the generic schema and parses JSON", async () => {
    let seen: any;
    mockGemini({
      generateContent: async (params: any) => {
        seen = params;
        return { text: JSON.stringify({ ok: true, count: 3 }) };
      },
    });
    const schema: { type: "object"; properties: Record<string, any>; required?: string[] } = {
      type: "object",
      properties: { ok: { type: "boolean" }, count: { type: "number" } },
      required: ["ok"],
    };
    const provider = new GeminiProvider();
    const out = await provider.generateStructured<{ ok: boolean; count: number }>(
      "do it",
      schema,
      { model: "model-s" }
    );
    expect(out).toEqual({ ok: true, count: 3 });
    // Structured output sets JSON mime + schema; no googleSearch by default.
    expect(seen.config.responseMimeType).toBe("application/json");
    expect(seen.config.responseSchema.type).toBe("OBJECT");
    expect(seen.config.responseSchema.properties.ok).toEqual({ type: "BOOLEAN" });
    expect(seen.config.responseSchema.properties.count).toEqual({ type: "NUMBER" });
    expect(seen.config.responseSchema.required).toEqual(["ok"]);
    expect(seen.config.tools).toBeUndefined();
  });

  it("webSearch option adds the Google-search grounding tool to structured calls", async () => {
    let seen: any;
    mockGemini({
      generateContent: async (params: any) => {
        seen = params;
        return { text: JSON.stringify({ url: "https://example.com" }) };
      },
    });
    const provider = new GeminiProvider();
    await provider.generateStructured(
      "search",
      { type: "object", properties: {} },
      { model: "model-ws", webSearch: true }
    );
    expect(seen.config.tools).toEqual([{ googleSearch: {} }]);
  });

  it("does not add googleSearch when webSearch is false/omitted", async () => {
    let seen: any;
    mockGemini({
      generateContent: async (params: any) => {
        seen = params;
        return { text: "{}" };
      },
    });
    const provider = new GeminiProvider();
    await provider.generateStructured("x", { type: "object", properties: {} }, { model: "model-xs" });
    expect(seen.config.tools).toBeUndefined();
  });

  it("maps array schema items", async () => {
    let seen: any;
    mockGemini({
      generateContent: async (params: any) => {
        seen = params;
        return { text: "{}" };
      },
    });
    const provider = new GeminiProvider();
    await provider.generateStructured(
      "x",
      { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
      { model: "model-ar" }
    );
    const tags = seen.config.responseSchema.properties.tags;
    expect(tags.type).toBe("ARRAY");
    expect(tags.items).toEqual({ type: "STRING" });
  });

  it("maps an integer schema node to a Gemini INTEGER type", async () => {
    let seen: any;
    mockGemini({
      generateContent: async (params: any) => {
        seen = params;
        return { text: "{}" };
      },
    });
    const provider = new GeminiProvider();
    await provider.generateStructured(
      "x",
      {
        type: "object",
        properties: { servings: { type: "integer" }, stepNumber: { type: "integer" } },
      },
      { model: "model-int" }
    );
    expect(seen.config.responseSchema.properties.servings).toEqual({ type: "INTEGER" });
    expect(seen.config.responseSchema.properties.stepNumber).toEqual({ type: "INTEGER" });
  });

  describe("AiJsonSchema description (Gate A)", () => {
    it("maps a string description to the Gemini schema description", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const provider = new GeminiProvider();
      await provider.generateStructured(
        "x",
        {
          type: "object",
          properties: { value: { type: "string", description: "A normalized time string" } },
        },
        { model: "m" }
      );
      expect(seen.config.responseSchema.properties.value).toEqual({
        type: "STRING",
        description: "A normalized time string",
      });
    });

    it("preserves nested descriptions recursively", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const provider = new GeminiProvider();
      await provider.generateStructured(
        "x",
        {
          type: "object",
          properties: {
            meta: {
              type: "object",
              description: "nested object",
              properties: { note: { type: "string", description: "inner note" } },
            },
          },
        },
        { model: "m" }
      );
      const meta = seen.config.responseSchema.properties.meta;
      expect(meta.description).toBe("nested object");
      expect(meta.properties.note).toEqual({ type: "STRING", description: "inner note" });
    });

    it("does not mutate the caller's schema", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const schema = Object.freeze({
        type: "object",
        properties: Object.freeze({ value: { type: "string", description: "d" } }),
      });
      const provider = new GeminiProvider();
      await provider.generateStructured("x", schema as any, { model: "m" });
      // Input unchanged; the mapped node is a separate object.
      expect(seen.config.responseSchema).not.toBe(schema);
      expect((schema as any).properties.value).toEqual({ type: "string", description: "d" });
    });

    it("maps a string enum with description", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const provider = new GeminiProvider();
      await provider.generateStructured(
        "x",
        {
          type: "object",
          properties: { confidence: { type: "string", enum: ["high", "low"], description: "level" } },
        },
        { model: "m" }
      );
      expect(seen.config.responseSchema.properties.confidence).toEqual({
        type: "STRING",
        enum: ["high", "low"],
        description: "level",
      });
    });
  });

  describe("provider-specific options (Gate B)", () => {
    it("maps a supported Gemini thinking level", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "ok" };
        },
      });
      const provider = new GeminiProvider();
      await provider.generate("x", {
        model: "m",
        providerOptions: { thinkingConfig: { thinkingLevel: "MINIMAL" } },
      });
      expect(seen.config.thinkingConfig).toBeDefined();
      expect(seen.config.thinkingConfig.thinkingLevel).toBe("MINIMAL");
    });

    it("no provider options => no thinkingConfig", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const provider = new GeminiProvider();
      await provider.generateStructured("x", { type: "object", properties: {} }, { model: "m" });
      expect(seen.config.thinkingConfig).toBeUndefined();
    });

    it("does not blindly spread unknown provider options", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const provider = new GeminiProvider();
      await provider.generateStructured("x", { type: "object", properties: {} }, {
        model: "m",
        providerOptions: {
          thinkingConfig: { thinkingLevel: "MINIMAL" },
          temperature: 99,
          responseMimeType: "text/plain",
          systemInstruction: "evil",
          apiKey: "secret",
        },
      });
      // Only the allowlisted thinking key survives; nothing else is spread in.
      expect(seen.config.responseMimeType).toBe("application/json");
      expect(seen.config.systemInstruction).toBeUndefined();
      expect(seen.config.temperature).toBeUndefined();
      expect(seen.config.thinkingConfig.thinkingLevel).toBe("MINIMAL");
      expect(JSON.stringify(seen)).not.toContain("secret");
    });

    it("webSearch behavior remains independent of provider options", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const provider = new GeminiProvider();
      await provider.generateStructured(
        "x",
        { type: "object", properties: {} },
        { model: "m", webSearch: true, providerOptions: { thinkingConfig: { thinkingLevel: "LOW" } } }
      );
      expect(seen.config.tools).toEqual([{ googleSearch: {} }]);
      expect(seen.config.thinkingConfig.thinkingLevel).toBe("LOW");
    });
  });

  describe("model routing safety (Gate C)", () => {
    it("uses the caller-provided model with no silent default fallback", async () => {
      let seen: any;
      mockGemini({
        generateContent: async (params: any) => {
          seen = params;
          return { text: "{}" };
        },
      });
      const provider = new GeminiProvider();
      // The provider no longer carries a `defaultModel` routed to nutritionPrimary.
      expect((provider as any).defaultModel).toBeUndefined();
      await provider.generateStructured(
        "x",
        { type: "object", properties: {} },
        { model: "role-model-abc" }
      );
      expect(seen.model).toBe("role-model-abc");
      // No reference to the nutrition role model enters a call that did not ask for it.
      expect(JSON.stringify(seen)).not.toContain("nutritionPrimary");
    });
  });

  it("generateStructured throws safely on invalid provider JSON", async () => {
    mockGemini({
      generateContent: async () => ({ text: "{ not json" }),
    });
    const provider = new GeminiProvider();
    await expect(
      provider.generateStructured("x", { type: "object", properties: {} }, { model: "m" })
    ).rejects.toThrow();
  });

  describe("searchWeb (grounded, provider neutral)", () => {
    it("Gemini advertises the webSearch capability and implements searchWeb", () => {
      const provider = getDefaultAiProvider();
      expect(provider.capabilities.webSearch).toBe(true);
      expect(typeof (provider as any).searchWeb).toBe("function");
    });

    it("translates provider grounding chunks into neutral AiSearchResult[]", async () => {
      const seen: any[] = [];
      mockGemini({
        generateContent: async (params: any) => {
          seen.push(params);
          return {
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://example.com/gumbo", title: "Real Gumbo", domain: "example.com" } },
                { web: { uri: "https://example.com/other" } },
              ],
            },
          };
        },
      });
      const provider = new GeminiProvider();
      const results = await provider.searchWeb("find gumbo", { model: "m", temperature: 0 });
      expect(seen[0].model).toBe("m");
      expect(seen[0].config.temperature).toBe(0);
      expect(seen[0].config.tools).toEqual([{ googleSearch: {} }]);
      expect(seen[0].config.thinkingConfig).toBeUndefined();
      expect(results).toEqual([
        { url: "https://example.com/gumbo", title: "Real Gumbo", sourceName: "example.com" },
        { url: "https://example.com/other" },
      ]);
    });

    it("returns [] when the provider yields no grounding (prose-only) — never parses prose URLs", async () => {
      mockGemini({
        generateContent: async () => ({ text: "try https://foodblog.example/fake for details" }),
      });
      const provider = new GeminiProvider();
      const results = await provider.searchWeb("q", { model: "m" });
      expect(results).toEqual([]);
    });

    it("returns only provider-backed sources verbatim (sanitizer applies http/https downstream)", async () => {
      mockGemini({
        generateContent: async () => ({
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "javascript:alert(1)" } },
              { web: { uri: "" } }, // dropped: empty uri is not a source
            ],
          },
        }),
      });
      const provider = new GeminiProvider();
      const results = await provider.searchWeb("q", { model: "m" });
      // searchWeb extracts provider-backed sources verbatim; the http/https
      // safety filter is the sanitizer's job in the discovery layer.
      expect(results).toEqual([{ url: "javascript:alert(1)" }]);
    });

    it("throws when unavailable (no key)", async () => {
      vi.mocked(getGemini).mockReturnValue(null);
      const provider = new GeminiProvider();
      await expect(provider.searchWeb("q", { model: "m" })).rejects.toThrow();
    });
  });
});
