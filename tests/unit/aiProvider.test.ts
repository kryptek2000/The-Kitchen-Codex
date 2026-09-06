import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { getGemini } from "../../server/geminiClient.js";
import {
  GeminiProvider,
  getAiProvider,
  getDefaultAiProvider,
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

  it("registry returns undefined for unknown/empty provider ids", () => {
    expect(getAiProvider("openrouter")).toBeUndefined();
    expect(getAiProvider("deepseek")).toBeUndefined();
    expect(getAiProvider("")).toBeUndefined();
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
    expect(provider.generate("hi")).rejects.toThrow();
    expect(
      provider.generateStructured("hi", { type: "object", properties: {} })
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
    await provider.generateStructured("search", { type: "object", properties: {} }, { webSearch: true });
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
    await provider.generateStructured("x", { type: "object", properties: {} });
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
      {}
    );
    const tags = seen.config.responseSchema.properties.tags;
    expect(tags.type).toBe("ARRAY");
    expect(tags.items).toEqual({ type: "STRING" });
  });
});
