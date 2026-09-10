/**
 * The Kitchen Codex — OpenRouter ImageProvider unit tests (BYOK-3).
 *
 * Proves the OpenRouter `/api/v1/images` adapter behavior hermetically (mock
 * fetch seam): availability truth, the fixed endpoint + server-only key wiring,
 * valid-image normalization through the shared validation boundary, malformed /
 * oversized / SVG / GIF / MIME-mismatch rejection, the DISTINCT provider error
 * taxonomy (AUTH/QUOTA/RATE_LIMIT+Retry-After/TIMEOUT/UNAVAILABLE/NO_IMAGE), and
 * that NO secret / prompt / base64 payload ever leaks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OpenRouterImageProvider,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_IMAGE_DEFAULT_MODEL,
  type OpenRouterImageFetchLike,
  type OpenRouterImageFetchResponse,
} from "../../server/ai/openRouterImageProvider.js";
import {
  ProviderOperationError,
  toProviderDiagnostic,
} from "../../server/ai/providerErrors.js";
import { ImageNoImageError } from "../../server/ai/imageProvider.js";
import { mapImageProviderErrorToHttp } from "../../server/app.js";
import { MAX_GENERATED_IMAGE_BASE64_CHARS } from "../../src/core/recipeImage.js";
import { generateRecipeImagePreview } from "../../server/recipeImage.js";
import { ImagePreviewStore } from "../../server/imagePreviewStore.js";

const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Minimal JPEG container (FF D8 FF + JFIF header) >= MIN_GENERATED_IMAGE_BYTES. */
const VALID_JPEG_BASE64 = Buffer.from("ffd8ffe000104a464946000101", "hex").toString("base64");

/** Minimal WebP container (RIFF....WEBP....). */
const VALID_WEBP_BASE64 = Buffer.from("524946460100000057454250505650380a", "hex").toString("base64");

const SVG_BASE64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64");
const GIF_BASE64 = Buffer.from("GIF89a0100\u0000\u0000").toString("base64");

const KEY = "sk-or-v1-BYOK3-TEST-KEY-abcdef";
const PROMPT_SENTINEL = "SUPER_SECRET_PROMPT_SENTINEL";
const SECRET_SENTINEL = "sk-or-v1-SUPER-SECRET-KEY-123456";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): OpenRouterImageFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  };
}

function dataResponse(b64: string, mediaType?: string): OpenRouterImageFetchResponse {
  return jsonResponse({ created: 1234, data: [{ b64_json: b64, ...(mediaType ? { media_type: mediaType } : {}) }], usage: {} });
}

describe("OpenRouterImageProvider — availability truth (BYOK-3)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it("isAvailable() is TRUE only when a real (non-empty) server key is configured", () => {
    const provider = new OpenRouterImageProvider();
    process.env.OPENROUTER_API_KEY = KEY;
    expect(provider.isAvailable()).toBe(true);
    process.env.OPENROUTER_API_KEY = "";
    expect(provider.isAvailable()).toBe(false); // .env placeholder is an empty value
    delete process.env.OPENROUTER_API_KEY;
    expect(provider.isAvailable()).toBe(false); // unset
  });

  it("exposes the curated model set + default (small, explicit; never scraped)", () => {
    expect(OPENROUTER_IMAGE_MODELS).toEqual(["google/gemini-2.5-flash-image", "bytedance-seed/seedream-4.5"]);
    expect(OPENROUTER_IMAGE_DEFAULT_MODEL).toBe("google/gemini-2.5-flash-image");
  });
});

describe("OpenRouterImageProvider — endpoint + secret containment (BYOK-3)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it("posts to the FIXED /api/v1/images endpoint with Bearer key + { model, prompt } body", async () => {
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64, "image/png"));
    const provider = new OpenRouterImageProvider({ fetchFn });
    const result = await provider.generateImage(PROMPT_SENTINEL, { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: PROMPT_SENTINEL });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: PROMPT_SENTINEL });
    expect(result.provider).toBe("openrouter-image");
    expect(result.model).toBe(OPENROUTER_IMAGE_DEFAULT_MODEL);
  });

  it("uses the DEDICATED 60s image-generation timeout (never the 25s text ceiling)", async () => {
    const { MODEL_CONFIG } = await import("../../server/modelConfig.js");
    expect(MODEL_CONFIG.imageGenerationTimeoutMs).toBe(60_000);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64, "image/png"));
    const provider = new OpenRouterImageProvider({ fetchFn });
    await provider.generateImage("t", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "t" });
    // The transport signal is the dedicated image timeout, not the text ceiling.
    expect(timeoutSpy).toHaveBeenCalledWith(MODEL_CONFIG.imageGenerationTimeoutMs);
    expect(timeoutSpy).not.toHaveBeenCalledWith(MODEL_CONFIG.requestTimeoutMs);
    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    timeoutSpy.mockRestore();
  });
});

describe("OpenRouterImageProvider — valid normalization through the shared boundary (BYOK-3)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it("a PNG b64_json with media_type image/png normalizes to a validated PNG", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64, "image/png")) });
    const result = await provider.generateImage("png test", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "png test" });
    expect(result.contentType).toBe("image/png");
    expect(Buffer.from(result.bytes).toString("hex").startsWith("89504e47")).toBe(true);
  });

  it("a JPEG b64_json with media_type image/jpeg normalizes to a validated JPEG", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_JPEG_BASE64, "image/jpeg")) });
    const result = await provider.generateImage("jpeg test", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "jpeg test" });
    expect(result.contentType).toBe("image/jpeg");
  });

  it("a WebP b64_json with media_type image/webp normalizes to a validated WebP", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_WEBP_BASE64, "image/webp")) });
    const result = await provider.generateImage("webp test", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "webp test" });
    expect(result.contentType).toBe("image/webp");
  });

  it("sniffs the bytes when OpenRouter omits media_type (self-declaring container)", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64)) });
    const result = await provider.generateImage("no mime", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "no mime" });
    expect(result.contentType).toBe("image/png"); // bytes agree with sniffed container
  });

  it("first data entry with a b64_json wins in API order (deterministic)", async () => {
    const first = Buffer.from("ffd8ffe000104a464946000101", "hex").toString("base64");
    const body = { created: 1, data: [{ b64_json: first }, { b64_json: VALID_PNG_BASE64 }], usage: {} };
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(jsonResponse(body)) });
    const result = await provider.generateImage("first", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "first" });
    expect(result.contentType).toBe("image/jpeg");
  });

  it("feeds the FULL preview pipeline (generateRecipeImagePreview + preview store)", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64, "image/png")) });
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    const result = await generateRecipeImagePreview(
      { title: "Test Dish", ingredients: ["flour", "water"] },
      provider,
      store,
      { model: OPENROUTER_IMAGE_DEFAULT_MODEL }
    );
    expect(result.provider).toBe("openrouter-image");
    expect(result.model).toBe(OPENROUTER_IMAGE_DEFAULT_MODEL);
    expect(result.contentType).toBe("image/png");
    expect(result.bytes).toBeGreaterThan(0);
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
  });
});

describe("OpenRouterImageProvider — untrusted output rejection (BYOK-3)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it("SVG (media_type image/svg+xml) is rejected (INVALID_RESPONSE)", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(SVG_BASE64, "image/svg+xml")) });
    await expect(provider.generateImage("svg", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "svg" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("GIF (media_type image/gif) is rejected (INVALID_RESPONSE)", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(GIF_BASE64, "image/gif")) });
    await expect(provider.generateImage("gif", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "gif" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("declared media_type that DISAGREES with the bytes is rejected (MIME/signature agreement)", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64, "image/jpeg")) });
    await expect(provider.generateImage("mismatch", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "mismatch" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("an encoded payload over the pre-decode cap is rejected BEFORE decode (INVALID_RESPONSE)", async () => {
    const oversized = "A".repeat(MAX_GENERATED_IMAGE_BASE64_CHARS + 1);
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(dataResponse(oversized, "image/png")) });
    await expect(provider.generateImage("big", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "big" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("missing / non-string b64_json -> ImageNoImageError (NO_IMAGE)", async () => {
    const provider = new OpenRouterImageProvider({
      fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(jsonResponse({ created: 1, data: [{ something_else: true }], usage: {} })),
    });
    const err = await provider.generateImage("none", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "none" }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageNoImageError);
    expect(err.code).toBe("NO_IMAGE");
  });

  it("SUCCESS response WITHOUT a usable data array -> ImageNoImageError (NO_IMAGE)", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(jsonResponse({ created: 1, usage: {} })) });
    await expect(provider.generateImage("empty", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "empty" })).rejects.toBeInstanceOf(ImageNoImageError);
    const emptyArrayProvider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(jsonResponse({ created: 1, data: [], usage: {} })) });
    await expect(emptyArrayProvider.generateImage("empty-arr", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "empty-arr" })).rejects.toBeInstanceOf(ImageNoImageError);
  });
});

describe("OpenRouterImageProvider — provider error taxonomy (BYOK-3)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  const providerFor = (res: () => Promise<OpenRouterImageFetchResponse>) => {
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockImplementation(res);
    return new OpenRouterImageProvider({ fetchFn });
  };

  it("HTTP 401 -> AUTH", async () => {
    const provider = providerFor(() => Promise.resolve(jsonResponse({ error: { message: "Invalid API key sentinel" } }, 401)));
    const err = await provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderOperationError);
    expect(err.code).toBe("AUTH");
    expect(err.status).toBe(401);
  });

  it("HTTP 402 -> QUOTA", async () => {
    const provider = providerFor(() => Promise.resolve(jsonResponse({ error: { message: "Insufficient credits" } }, 402)));
    await expect(provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" })).rejects.toMatchObject({ code: "QUOTA" });
  });

  it("HTTP 429 preserves the UPSTREAM Retry-After header (RATE_LIMIT)", async () => {
    const provider = providerFor(() =>
      Promise.resolve(jsonResponse({ error: { message: "Rate limited" } }, 429, { "Retry-After": "42" }))
    );
    const err = await provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" }).catch((e) => e);
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe("42");
    // End-to-end: the route preserves the upstream header over the fixed default.
    expect(mapImageProviderErrorToHttp(err)?.retryAfter).toBe("42");
  });

  it("HTTP 400 with wrapped provider-overloaded error.code 529 -> UNAVAILABLE", async () => {
    const provider = providerFor(() => Promise.resolve(jsonResponse({ error: { code: 529, message: "Provider Overloaded" } }, 400)));
    await expect(provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("DIRECT HTTP 529 status -> UNAVAILABLE (documented OpenRouter status, not just the wrapped envelope)", async () => {
    const provider = providerFor(() => Promise.resolve(jsonResponse({ error: { message: "Provider overloaded" } }, 529)));
    const err = await provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" }).catch((e) => e);
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.status).toBe(529);
  });

  it("HTTP 500 / 502 / 503 / 524 -> UNAVAILABLE (upstream/gateway)", async () => {
    for (const status of [500, 502, 503, 524]) {
      const provider = providerFor(() => Promise.resolve(jsonResponse({ error: { message: `boom ${status}` } }, status)));
      await expect(provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" })).rejects.toMatchObject({ code: "UNAVAILABLE", status });
    }
  });

  it("HTTP 404 -> PROVIDER_ERROR (unknown model, not a transient-outage category)", async () => {
    const provider = providerFor(() => Promise.resolve(jsonResponse({ error: { message: "Model not found" } }, 404)));
    await expect(provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("transport abort/timeout -> TIMEOUT", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const provider = new OpenRouterImageProvider({
      fetchFn: vi.fn<OpenRouterImageFetchLike>().mockRejectedValue(abortError),
    });
    await expect(provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("transport connection failure -> UNAVAILABLE (never a leaky PROVIDER_ERROR)", async () => {
    const provider = new OpenRouterImageProvider({
      fetchFn: vi.fn<OpenRouterImageFetchLike>().mockRejectedValue(new Error("fetch failed: ECONNREFUSED")),
    });
    await expect(provider.generateImage("x", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "x" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("model is required (no silent default)", async () => {
    const provider = new OpenRouterImageProvider({ fetchFn: vi.fn<OpenRouterImageFetchLike>() });
    await expect(provider.generateImage("x", { model: "", prompt: "x" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("NO secret / prompt / base64 leaks into normalized diagnostics", async () => {
    const provider = providerFor(() =>
      Promise.resolve(jsonResponse({ error: { message: `${SECRET_SENTINEL} and ${PROMPT_SENTINEL} and base64,AAAA leaks` } }, 401))
    );
    const err = await provider.generateImage(PROMPT_SENTINEL, { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: PROMPT_SENTINEL }).catch((e) => e);
    const diag = toProviderDiagnostic(err);
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain(PROMPT_SENTINEL);
    expect(serialized).not.toContain("base64,AAAA");
    expect(diag.code).toBe("AUTH");
  });
});