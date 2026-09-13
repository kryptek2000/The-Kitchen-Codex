import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenRouterProvider, OPENROUTER_STRUCTURED_MODEL } from "../../server/ai/openRouterProvider.js";
import type { AiJsonSchema } from "../../server/ai/types.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";
import type { OpenRouterFetchLike } from "../../server/ai/openRouterProvider.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function okResponse(content: unknown) {
  return new Response(JSON.stringify(content));
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
      return Promise.resolve(okResponse({ choices: [{ message: { content: "{\"tags\":[] }" } }] }));
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
    await provider.generateStructured("x", schema, { model: OPENROUTER_STRUCTURED_MODEL });
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
    await expect(provider.generate("x", { model: OPENROUTER_STRUCTURED_MODEL })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps malformed structured JSON to INVALID_RESPONSE", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(okResponse({ choices: [{ message: { content: "{ not json" } }] })) });
    await expect(provider.generateStructured("x", { type: "object", properties: {} }, { model: OPENROUTER_STRUCTURED_MODEL })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps 401/403 to AUTH and never leaks the key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-super-secret");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(errorResponse(401, "invalid api key")) });
    const err = await provider.generate("x", { model: OPENROUTER_STRUCTURED_MODEL }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderOperationError);
    expect(err.code).toBe("AUTH");
    expect(JSON.stringify(err)).not.toContain("sk-or-v1-super-secret");
  });

  it("maps 429 to RATE_LIMIT/QUOTA taxonomy", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(errorResponse(429, "rate limit exceeded")) });
    const err = await provider.generate("x", { model: OPENROUTER_STRUCTURED_MODEL }).catch((e) => e);
    expect(err.code).toBe("RATE_LIMIT");
  });

  it("maps transport timeout to TIMEOUT", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({
      fetchFn: () => Promise.reject(Object.assign(new Error("the operation was aborted"), { name: "AbortError" })),
    });
    const err = await provider.generate("x", { model: OPENROUTER_STRUCTURED_MODEL }).catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
  });

  it("maps connection failure (no response) to UNAVAILABLE", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.reject(new Error("fetch failed")) });
    const err = await provider.generate("x", { model: OPENROUTER_STRUCTURED_MODEL }).catch((e) => e);
    expect(err.code).toBe("UNAVAILABLE");
  });

  it("maps 5xx to UNAVAILABLE/PROVIDER_ERROR taxonomy", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const provider = new OpenRouterProvider({ fetchFn: () => Promise.resolve(errorResponse(503, "service unavailable")) });
    const err = await provider.generate("x", { model: OPENROUTER_STRUCTURED_MODEL }).catch((e) => e);
    expect(["UNAVAILABLE", "PROVIDER_ERROR"]).toContain(err.code);
  });

  it("always claims webSearch:false and exposes no searchWeb method", () => {
    const provider = new OpenRouterProvider();
    expect(provider.capabilities.webSearch).toBe(false);
    expect((provider as any).searchWeb).toBeUndefined();
  });
});

describe("curated/server-default structured request preserves baseline fields (regression)", () => {
  function captureRequest() {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    let seenInit: RequestInit | undefined;
    const fetchFn: OpenRouterFetchLike = (_url, init) => {
      seenInit = init;
      return Promise.resolve(okResponse({ choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }] }));
    };
    return { provider: new OpenRouterProvider({ fetchFn }), body: () => JSON.parse(String(seenInit?.body)) };
  }

  it("does NOT add max_tokens or reasoning merely because a schema is present", async () => {
    const { provider, body } = captureRequest();
    const schema: AiJsonSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    await provider.generateStructured("x", schema, { model: OPENROUTER_STRUCTURED_MODEL });
    const sent = body();
    // The regression: these were unconditionally added by the dynamic patch.
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.reasoning).toBeUndefined();
    // Every other baseline field is preserved.
    expect(sent.model).toBe(OPENROUTER_STRUCTURED_MODEL);
    expect(sent.messages).toEqual([{ role: "user", content: "x" }]);
    expect(sent.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "structured_output", strict: true, schema: expect.any(Object) },
    });
    expect(sent.provider).toEqual({ require_parameters: true });
  });

  it("forwards a large structured schema without adding a token cap (request shape only)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    // A large schema representative of Grab Recipe / metadata recovery. NOTE: this
    // proves the REQUEST shape only; response-size behavior is covered separately
    // by the >256 KiB curated-response test below.
    const schema: AiJsonSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field${i}`, { type: "string" } as const])
      ),
      required: Array.from({ length: 40 }, (_, i) => `field${i}`),
    };
    const content = JSON.stringify(
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, `v${i}`]))
    );
    let seenInit: RequestInit | undefined;
    const fetchFn: OpenRouterFetchLike = (_url, init) => {
      seenInit = init;
      return Promise.resolve(okResponse({ choices: [{ message: { content } }] }));
    };
    await new OpenRouterProvider({ fetchFn }).generateStructured("x", schema, {
      model: OPENROUTER_STRUCTURED_MODEL,
    });
    const sent = JSON.parse(String(seenInit?.body));
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.reasoning).toBeUndefined();
    expect(Object.keys(sent.response_format.json_schema.schema.properties)).toHaveLength(40);
  });

  it("accepts a curated response larger than the dynamic 256 KiB ceiling (baseline reader)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    // A real encoded response > 256 KiB with a large assistant content string.
    const big = "x".repeat(300 * 1024);
    const encoded = JSON.stringify({ choices: [{ message: { content: big } }] });
    const encodedBytes = new TextEncoder().encode(encoded).byteLength;
    expect(encodedBytes).toBeGreaterThan(256 * 1024);
    const fetchFn: OpenRouterFetchLike = () => Promise.resolve(new Response(encoded));
    const out = await new OpenRouterProvider({ fetchFn }).generate("hi", {
      model: OPENROUTER_STRUCTURED_MODEL,
    });
    // The curated path uses the baseline JSON reader (no streamed byte ceiling).
    expect(out).toBe(big);
    expect(out.length).toBe(big.length);
  });

  it("keeps plain (non-structured) curated generation on baseline fields", async () => {
    const { provider, body } = captureRequest();
    await provider.generate("hi", { model: OPENROUTER_STRUCTURED_MODEL, temperature: 0 });
    const sent = body();
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.reasoning).toBeUndefined();
    expect(sent.response_format).toBeUndefined();
    expect(sent.provider).toBeUndefined();
    expect(sent.temperature).toBe(0);
  });

  it("rejects an unverified dynamic model before any fetch (no client-forged activation)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const fetchFn = vi.fn();
    const provider = new OpenRouterProvider({ fetchFn: fetchFn as unknown as OpenRouterFetchLike });
    const schema: AiJsonSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    await expect(
      provider.generateStructured("x", schema, {
        model: "some/unverified:free",
        providerOptions: { profile: "strict_json_schema_v1" },
      } as any)
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
