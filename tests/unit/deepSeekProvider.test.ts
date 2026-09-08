import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DeepSeekProvider,
  DEEPSEEK_MODEL_CAPABILITIES,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  DEEPSEEK_CHAT_ENDPOINT,
} from "../../server/ai/deepSeekProvider.js";
import type { DeepSeekFetchLike } from "../../server/ai/deepSeekProvider.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";
import {
  effectiveCapabilities,
  hasAllCapabilities,
  selectCandidates,
} from "../../server/ai/provider.js";
import type { AiCapabilities, AiProvider } from "../../server/ai/types.js";

const ENDPOINT = DEEPSEEK_CHAT_ENDPOINT;

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

describe("DeepSeekProvider (v0.7 1C) — adapter", () => {
  it("isAvailable is true only when a key is configured (server env)", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(new DeepSeekProvider().isAvailable()).toBe(false);
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-deepseek-test");
    expect(new DeepSeekProvider().isAvailable()).toBe(true);
  });

  it("POSTs ONLY to the fixed official endpoint with a Bearer auth header and JSON body", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-deepseek-test");
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn: DeepSeekFetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(okResponse({ choices: [{ message: { content: "hello" } }] }));
    };
    const provider = new DeepSeekProvider({ fetchFn });
    const out = await provider.generate("hi", { model: DEEPSEEK_FLASH_MODEL, temperature: 0 });
    expect(seenUrl).toBe(ENDPOINT);
    expect(seenUrl).not.toMatch(/openrouter|googleapis|localhost|0\.0\.0\.0/);
    expect((seenInit?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-deepseek-test");
    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(seenInit?.body)) as any;
    expect(body.model).toBe(DEEPSEEK_FLASH_MODEL);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBe(0);
    expect(out).toBe("hello");
  });

  it("does NOT accept a caller-controlled baseUrl/endpoint/host (no arbitrary endpoint)", () => {
    const provider = new DeepSeekProvider();
    // Only the fixed official endpoint is reachable; there is no config surface.
    expect((provider as any).baseUrl).toBeUndefined();
    expect((provider as any).endpoint).toBeUndefined();
    expect((provider as any).apiKey).toBeUndefined();
  });

  it("exposes plain generate text; no response_format schema is forced for text", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    let seenInit: RequestInit | undefined;
    const fetchFn: DeepSeekFetchLike = (_url, init) => {
      seenInit = init;
      return Promise.resolve(okResponse({ choices: [{ message: { content: "done" } }] }));
    };
    const provider = new DeepSeekProvider({ fetchFn });
    const out = await provider.generate("x", { model: DEEPSEEK_PRO_MODEL, temperature: 0.1 });
    expect(out).toBe("done");
    const body = JSON.parse(String(seenInit?.body)) as any;
    expect(body.response_format).toBeUndefined();
  });

  it("generateStructured refuses (UNSUPPORTED_CAPABILITY) — we never fake schema output", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    let called = false;
    const fetchFn: DeepSeekFetchLike = (_url, _init) => {
      called = true;
      return Promise.resolve(okResponse({ choices: [{ message: { content: "{}" } }] }));
    };
    const provider = new DeepSeekProvider({ fetchFn });
    const rejection = provider.generateStructured(
      "x",
      { type: "object", properties: { a: { type: "string" } } },
      { model: DEEPSEEK_FLASH_MODEL }
    );
    await expect(rejection).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(rejection).rejects.toBeInstanceOf(ProviderOperationError);
    expect(called).toBe(false); // no arbitrary request is ever made for structured output
  });

  it("maps missing content to INVALID_RESPONSE", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const provider = new DeepSeekProvider({ fetchFn: () => Promise.resolve(okResponse({ choices: [{ message: {} }] })) });
    await expect(provider.generate("x", { model: "m" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("maps 401/403 to AUTH and never leaks the key", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-deepseek-super-secret");
    const provider = new DeepSeekProvider({ fetchFn: () => Promise.resolve(errorResponse(401, "invalid api key")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderOperationError);
    expect(err.code).toBe("AUTH");
    expect(JSON.stringify(err)).not.toContain("sk-deepseek-super-secret");
  });

  it("maps 429 to RATE_LIMIT/QUOTA taxonomy", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const provider = new DeepSeekProvider({ fetchFn: () => Promise.resolve(errorResponse(429, "rate limit reached")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(["RATE_LIMIT", "QUOTA"]).toContain(err.code);
  });

  it("maps 402 (insufficient balance) to QUOTA", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const provider = new DeepSeekProvider({ fetchFn: () => Promise.resolve(errorResponse(402, "insufficient balance")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err.code).toBe("QUOTA");
  });

  it("maps transport timeout to TIMEOUT", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const provider = new DeepSeekProvider({
      fetchFn: () => Promise.reject(Object.assign(new Error("the operation was aborted"), { name: "AbortError" })),
    });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
  });

  it("maps connection failure (no response) to UNAVAILABLE", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const provider = new DeepSeekProvider({ fetchFn: () => Promise.reject(new Error("fetch failed")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err.code).toBe("UNAVAILABLE");
  });

  it("maps 5xx to UNAVAILABLE/PROVIDER_ERROR taxonomy", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const provider = new DeepSeekProvider({ fetchFn: () => Promise.resolve(errorResponse(503, "server overloaded")) });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(["UNAVAILABLE", "PROVIDER_ERROR"]).toContain(err.code);
  });

  it("always claims webSearch:false and exposes no searchWeb method", () => {
    const provider = new DeepSeekProvider();
    expect(provider.capabilities.webSearch).toBe(false);
    expect((provider as any).searchWeb).toBeUndefined();
  });

  it("returns ONLY the public content — reasoning_content is never surfaced", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const fetchFn: DeepSeekFetchLike = () =>
      Promise.resolve(okResponse({ choices: [{ message: { reasoning_content: "private reasoning", content: "final answer" } }] }));
    const provider = new DeepSeekProvider({ fetchFn });
    const out = await provider.generate("x", { model: DEEPSEEK_FLASH_MODEL });
    expect(out).toBe("final answer");
    expect(out).not.toContain("private reasoning");
  });

  it("does not leak reasoning_content when content is missing (maps to INVALID_RESPONSE)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const fetchFn: DeepSeekFetchLike = () =>
      Promise.resolve(okResponse({ choices: [{ message: { reasoning_content: "secret chain of thought", content: "" } }] }));
    const provider = new DeepSeekProvider({ fetchFn });
    const err = await provider.generate("x", { model: "m" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderOperationError);
    expect(err.code).toBe("INVALID_RESPONSE");
    // The reasoning_content must never appear in a serialized error/diagnostic.
    expect(JSON.stringify(err)).not.toContain("secret chain of thought");
  });
});

describe("DeepSeekProvider (v0.7 1C) — capability truth", () => {
  const FULL: AiCapabilities = { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true };
  const caps = (o: Partial<AiCapabilities> = {}): AiCapabilities => ({ ...FULL, ...o });

  function fakeProvider(id: string, capabilities: AiCapabilities, available = true): AiProvider {
    return {
      id,
      name: id,
      capabilities,
      isAvailable: () => available,
      testConnection: async () => available,
      generate: async () => "",
      generateStructured: async () => ({}) as any,
    };
  }

  it("conservative defaults: an unknown model claims nothing", () => {
    const ds = new DeepSeekProvider();
    const reg = { provider: ds, defaultCapabilities: { ...ds.capabilities }, modelCapabilities: DEEPSEEK_MODEL_CAPABILITIES };
    expect(hasAllCapabilities(effectiveCapabilities(reg, "deepseek-v4-unknown"), ["reasoning"])).toBe(false);
    expect(hasAllCapabilities(effectiveCapabilities(reg, "deepseek-v4-unknown"), ["structuredOutput"])).toBe(false);
    expect(hasAllCapabilities(effectiveCapabilities(reg, "deepseek-v4-unknown"), ["recipeGeneration"])).toBe(false);
    expect(hasAllCapabilities(effectiveCapabilities(reg, "deepseek-v4-unknown"), ["webSearch"])).toBe(false);
  });

  it("known curated models ONLY gain verified reasoning (never structuredOutput/webSearch)", () => {
    const ds = new DeepSeekProvider();
    const reg = { provider: ds, defaultCapabilities: { ...ds.capabilities }, modelCapabilities: DEEPSEEK_MODEL_CAPABILITIES };
    for (const model of [DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL]) {
      expect(hasAllCapabilities(effectiveCapabilities(reg, model), ["reasoning"])).toBe(true);
      expect(hasAllCapabilities(effectiveCapabilities(reg, model), ["structuredOutput"])).toBe(false);
      expect(hasAllCapabilities(effectiveCapabilities(reg, model), ["webSearch"])).toBe(false);
    }
  });

  it("a reasoning model does NOT magically gain structuredOutput", () => {
    const ds = new DeepSeekProvider();
    const regs = [{ provider: ds, defaultCapabilities: { ...ds.capabilities }, modelCapabilities: DEEPSEEK_MODEL_CAPABILITIES }];
    // Even the reasoning-capable flash/pro models are excluded from structured ops.
    const out = selectCandidates(regs, [{ provider: ds, model: DEEPSEEK_FLASH_MODEL }, { provider: ds, model: DEEPSEEK_PRO_MODEL }], ["structuredOutput"]);
    expect(out).toHaveLength(0);
  });

  it("structured-capable selection never includes DeepSeek (schema-constrained output NOT supported)", () => {
    const gem = fakeProvider("gemini", caps());
    const ds = new DeepSeekProvider();
    const regs = [
      { provider: gem, defaultCapabilities: caps(gem.capabilities) },
      { provider: ds, defaultCapabilities: { ...ds.capabilities }, modelCapabilities: DEEPSEEK_MODEL_CAPABILITIES },
    ];
    const out = selectCandidates(regs, [{ provider: gem, model: "g-m" }, { provider: ds, model: DEEPSEEK_FLASH_MODEL }], ["structuredOutput"]);
    expect(out.map((c) => c.provider.id)).toEqual(["gemini"]);
    expect(out.some((c) => c.provider.id === "deepseek")).toBe(false);
  });

  it("webSearch selection excludes DeepSeek entirely", () => {
    const gem = fakeProvider("gemini", caps());
    const ds = new DeepSeekProvider();
    const regs = [
      { provider: gem, defaultCapabilities: caps(gem.capabilities) },
      { provider: ds, defaultCapabilities: { ...ds.capabilities }, modelCapabilities: DEEPSEEK_MODEL_CAPABILITIES },
    ];
    const out = selectCandidates(regs, [{ provider: gem, model: "g-m" }, { provider: ds, model: DEEPSEEK_FLASH_MODEL }], ["webSearch"]);
    expect(out.map((c) => c.provider.id)).toEqual(["gemini"]);
    expect(out.some((c) => c.provider.id === "deepseek")).toBe(false);
  });
});
