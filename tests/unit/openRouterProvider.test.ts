import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenRouterProvider } from "../../server/ai/openRouterProvider.js";
import type { AiJsonSchema } from "../../server/ai/types.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";
import type { OpenRouterFetchLike } from "../../server/ai/openRouterProvider.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function okResponse(content: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => content,
  };
}

function errorResponse(status: number, message?: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenRouterProvider (v0.7 1B)", () => {
  it("isAvailable is true only when a key is configured (server env)", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(new OpenRouterProvider().isAvailable()).toBe(false);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
    expect(new OpenRouterProvider().isAvailable()).toBe(true);
  });

  it("POSTs to the fixed official endpoint with a Bearer auth header and JSON body", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn: OpenRouterFetchLike = (url, init) => {
      seenUrl = url; seenInit = init;
      return Promise.resolve(okResponse({ choices: [{ message: { content: "hello" } }] }));
    };
    const provider = new OpenRouterProvider({ fetchFn });
    const out = await provider.generate("hi", { model: "openai/gpt-4o-mini", temperature: 0 });
    expect(seenUrl).toBe(ENDPOINT);
    expect((seenInit?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-or-v1-test");
    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(seenInit?.body)) as any;
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(out).toBe("hello");
  });

  it("honors the supplied AiJsonSchema via json_schema (strict) + require_parameters", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn: OpenRouterFetchLike = (url, init) => {
      seenUrl = url; seenInit = init;
      return Promise.resolve(okResponse({ choices: [{ message: { content: JSON.stringify({ answer: "ok", score: 3 }) } }] }));
    };
    const provider = new OpenRouterProvider({ fetchFn });
    const schema: AiJsonSchema = {
      type: "object",
      properties: { answer: { type: "string" }, score: { type: "number" } },
      required: ["answer", "score"],
    };
    const out = await provider.generateStructured<{ answer: string; score: number }>("x", schema, { model: "openai/gpt-4o-mini" });

    // Semantic contract: the schema is forwarded (not ignored).
    const body = JSON.parse(String(seenInit?.body)) as any;
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("structured_output");
    expect(body.response_format.json_schema.strict).toBe(true);
    const sent = body.response_format.json_schema.schema;
    expect(sent.type).toBe("object");
    expect(sent.properties.answer).toEqual({ type: "string" });
    expect(sent.properties.score).toEqual({ type: "number" });
    expect(sent.required).toEqual(["answer", "score"]);
    expect(sent.additionalProperties).toBe(false);
    // require_parameters ensures the upstream model accepts the structured params.
    expect(body.provider).toEqual({ require_parameters: true });
    // Fixed endpoint + model + auth preserved.
    expect(seenUrl).toBe(ENDPOINT);
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect((seenInit?.headers as Record<string, string>)["Authorization"]).toContain("Bearer");
    // Result still parsed from content.
    expect(out).toEqual({ answer: "ok", score: 3 });
  });

  it("conveys object/array/enum/description schema details to OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    let seenInit: RequestInit | undefined;
    const fetchFn: OpenRouterFetchLike = (_url, init) => {
      seenInit = init;
      return Promise.resolve(okResponse({ choices: [{ message: { content: "{}" } }] }));
    };
    const provider = new OpenRouterProvider({ fetchFn });
    const schema: AiJsonSchema = {
      type: "object",
      description: "root",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["high", "low"], description: "level" },
        nested: { type: "object", properties: { v: { type: "integer" } }, required: ["v"] },
      },
      required: ["tags"],
    };
    await provider.generateStructured("x", schema, { model: "m" });
    const sent = (JSON.parse(String(seenInit?.body)) as any).response_format.json_schema.schema;
    // OpenAI strict: `required` lists EVERY property key.
    expect(sent.required).toEqual(["tags", "confidence", "nested"]);
    // Explicitly-required property -> not nullable.
    expect(sent.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    // Optional properties -> nullable wrappers (optional-equivalent).
    expect(sent.properties.confidence).toEqual({
      anyOf: [{ type: "string", enum: ["high", "low"], description: "level" }, { type: "null" }],
    });
    expect(sent.properties.nested.anyOf[0]).toEqual({
      type: "object",
      properties: { v: { type: "integer" } },
      additionalProperties: false,
      required: ["v"],
    });
    expect(sent.properties.nested.anyOf[1]).toEqual({ type: "null" });
    expect(sent.description).toBe("root");
  });

  it("maps missing content to INVALID_RESPONSE", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(okResponse({ choices: [{ message: {} }] })) });
    await expect(provider.generate("x", { model: "m" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps malformed structured JSON to INVALID_RESPONSE", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(okResponse({ choices: [{ message: { content: "{ not json" } }] })) });
    await expect(provider.generateStructured("x", { type: "object", properties: {} }, { model: "m" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps 401/403 to AUTH and never leaks the key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-super-secret");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(errorResponse(401, "invalid api key")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderOperationError);
    expect(err.code).toBe("AUTH");
    expect(JSON.stringify(err)).not.toContain("sk-or-v1-super-secret");
  });

  it("maps 429 to RATE_LIMIT/QUOTA taxonomy", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(errorResponse(429, "rate limit exceeded")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err.code).toBe("RATE_LIMIT");
  });

  it("maps transport timeout to TIMEOUT", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({
      fetchFn: () => Promise.reject(Object.assign(new Error("the operation was aborted"), { name: "AbortError" })),
    });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
  });

  it("maps connection failure (no response) to UNAVAILABLE", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.reject(new Error("fetch failed")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err.code).toBe("UNAVAILABLE");
  });

  it("maps 5xx to UNAVAILABLE/PROVIDER_ERROR taxonomy", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(errorResponse(503, "service unavailable")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(["UNAVAILABLE", "PROVIDER_ERROR"]).toContain(err.code);
  });

  it("always claims webSearch:false and exposes no searchWeb method", () => {
    const provider = new OpenRouterProvider();
    expect(provider.capabilities.webSearch).toBe(false);
    expect((provider as any).searchWeb).toBeUndefined();
  });
});
