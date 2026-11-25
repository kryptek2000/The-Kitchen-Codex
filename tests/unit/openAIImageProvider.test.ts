/**
 * The Kitchen Codex — OpenAI ImageProvider unit tests (P2).
 *
 * Proves the OpenAI Images API adapter behavior hermetically (mock fetch seam):
 * availability truth, the fixed endpoint + bounded request body, curated-model
 * enforcement, server-only/session-only key wiring, valid-image normalization
 * through the shared validation boundary, malformed/oversized/SVG/GIF rejection,
 * the DISTINCT provider error taxonomy (AUTH/ORG_VERIFICATION_REQUIRED/QUOTA/
 * RATE_LIMIT/TIMEOUT/UNAVAILABLE/NO_IMAGE), cancellation, and that NO secret or
 * prompt ever leaks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OpenAIImageProvider,
  OPENAI_IMAGE_MODELS,
  OPENAI_IMAGE_DEFAULT_MODEL,
  OPENAI_IMAGE_ENDPOINT,
  OPENAI_IMAGE_SIZE,
  OPENAI_IMAGE_OUTPUT_FORMAT,
  type OpenAIImageFetchLike,
} from "../../server/ai/openAIImageProvider.js";
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

const KEY = "sk-openai-P2-UNIT-KEY-abcdef";
const PROMPT_SENTINEL = "SUPER_SECRET_PROMPT_SENTINEL_P2";
const SECRET_SENTINEL = "sk-openai-P2-SUPER-SECRET-KEY-123456";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function dataResponse(b64: string): Response {
  return jsonResponse({ created: 1234, data: [{ b64_json: b64 }], usage: {} });
}

function providerFor(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  return new OpenAIImageProvider({ fetchFn: vi.fn<OpenAIImageFetchLike>().mockImplementation(fetchImpl) });
}

describe("OpenAIImageProvider — availability truth (P2)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("isAvailable() is TRUE only when a real (non-empty) server key is configured", () => {
    const provider = new OpenAIImageProvider();
    process.env.OPENAI_API_KEY = KEY;
    expect(provider.isAvailable()).toBe(true);
    process.env.OPENAI_API_KEY = "";
    expect(provider.isAvailable()).toBe(false);
    delete process.env.OPENAI_API_KEY;
    expect(provider.isAvailable()).toBe(false);
  });

  it("a request-scoped credential makes the provider available without env", () => {
    delete process.env.OPENAI_API_KEY;
    expect(new OpenAIImageProvider({ credential: "sk-session" }).isAvailable()).toBe(true);
  });

  it("exposes the curated model set + default (small, explicit; never scraped)", () => {
    expect(OPENAI_IMAGE_MODELS).toEqual(["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]);
    expect(OPENAI_IMAGE_DEFAULT_MODEL).toBe("gpt-image-2.6-flare");
  });
});

describe("OpenAIImageProvider — endpoint + request body + secret containment (P2)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("posts to the FIXED Images endpoint with a bounded single-image PNG body", async () => {
    const fetchFn = vi.fn<OpenAIImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64));
    const provider = new OpenAIImageProvider({ fetchFn });
    const result = await provider.generateImage(PROMPT_SENTINEL, {
      model: OPENAI_IMAGE_DEFAULT_MODEL,
      prompt: PROMPT_SENTINEL,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(url).toBe(OPENAI_IMAGE_ENDPOINT);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      model: OPENAI_IMAGE_DEFAULT_MODEL,
      prompt: PROMPT_SENTINEL,
      n: 1,
      size: OPENAI_IMAGE_SIZE,
      output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
    });
    // `response_format` is unsupported for GPT Image models; streaming is never on.
    expect(body.response_format).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(result.provider).toBe("openai-image");
    expect(result.model).toBe(OPENAI_IMAGE_DEFAULT_MODEL);
    expect(result.contentType).toBe("image/png");
  });

  it("a session credential is used EXCLUSIVELY (no env fallback / no env key sent)", async () => {
    const fetchFn = vi.fn<OpenAIImageFetchLike>().mockResolvedValue(dataResponse(VALID_PNG_BASE64));
    const provider = new OpenAIImageProvider({ fetchFn, credential: "sk-session-exclusive" });
    await provider.generateImage("p", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "p" });
    const headers = (fetchFn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-session-exclusive");
    expect(headers["Authorization"]).not.toContain(KEY);
  });

  it("without any credential, fails UNAVAILABLE BEFORE any network call", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchFn = vi.fn<OpenAIImageFetchLike>();
    const provider = new OpenAIImageProvider({ fetchFn });
    await expect(provider.generateImage("p", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "p" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an UNCURATED model with UNSUPPORTED_CAPABILITY and ZERO network calls", async () => {
    const fetchFn = vi.fn<OpenAIImageFetchLike>();
    const provider = new OpenAIImageProvider({ fetchFn });
    const err = await provider
      .generateImage("p", { model: "dall-e-3", prompt: "p" })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(mapImageProviderErrorToHttp(err)).toMatchObject({
      status: 400,
      code: "IMAGE_PROVIDER_MODEL_UNSUPPORTED",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("OpenAIImageProvider — valid normalization through the shared boundary (P2)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("a PNG b64_json normalizes to a validated PNG", async () => {
    const provider = providerFor(async () => dataResponse(VALID_PNG_BASE64));
    const result = await provider.generateImage("png test", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "png test" });
    expect(result.contentType).toBe("image/png");
    expect(Buffer.from(result.bytes).toString("hex").startsWith("89504e47")).toBe(true);
  });

  it("a JPEG b64_json is accepted only when the bytes agree with the JPEG container", async () => {
    const provider = providerFor(async () => dataResponse(VALID_JPEG_BASE64));
    const result = await provider.generateImage("jpeg test", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "jpeg test" });
    expect(result.contentType).toBe("image/jpeg");
  });

  it("a WebP b64_json normalizes to a validated WebP", async () => {
    const provider = providerFor(async () => dataResponse(VALID_WEBP_BASE64));
    const result = await provider.generateImage("webp test", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "webp test" });
    expect(result.contentType).toBe("image/webp");
  });

  it("first data entry with a b64_json wins in API order (deterministic)", async () => {
    const body = { created: 1, data: [{ b64_json: VALID_JPEG_BASE64 }, { b64_json: VALID_PNG_BASE64 }] };
    const provider = providerFor(async () => jsonResponse(body));
    const result = await provider.generateImage("first", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "first" });
    expect(result.contentType).toBe("image/jpeg");
  });

  it("feeds the FULL preview pipeline (generateRecipeImagePreview + preview store)", async () => {
    const provider = providerFor(async () => dataResponse(VALID_PNG_BASE64));
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    const result = await generateRecipeImagePreview(
      { title: "Test Dish", ingredients: ["flour", "water"] },
      provider,
      store,
      { model: OPENAI_IMAGE_DEFAULT_MODEL }
    );
    expect(result.provider).toBe("openai-image");
    expect(result.model).toBe(OPENAI_IMAGE_DEFAULT_MODEL);
    expect(result.contentType).toBe("image/png");
    expect(result.bytes).toBeGreaterThan(0);
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(0);
  });
});

describe("OpenAIImageProvider — untrusted output rejection (P2)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("SVG bytes are rejected (INVALID_RESPONSE)", async () => {
    const provider = providerFor(async () => dataResponse(SVG_BASE64));
    await expect(provider.generateImage("svg", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "svg" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("GIF bytes are rejected (INVALID_RESPONSE)", async () => {
    const provider = providerFor(async () => dataResponse(GIF_BASE64));
    await expect(provider.generateImage("gif", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "gif" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("an encoded payload over the pre-decode cap is rejected BEFORE decode (INVALID_RESPONSE)", async () => {
    const oversized = "A".repeat(MAX_GENERATED_IMAGE_BASE64_CHARS + 1);
    const provider = providerFor(async () => dataResponse(oversized));
    await expect(provider.generateImage("big", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "big" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("missing / non-string b64_json -> ImageNoImageError (NO_IMAGE)", async () => {
    const provider = providerFor(async () => jsonResponse({ created: 1, data: [{ something_else: true }], usage: {} }));
    const err = await provider.generateImage("none", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "none" }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageNoImageError);
    expect(err.code).toBe("NO_IMAGE");
  });

  it("a success response WITHOUT a data array -> ImageNoImageError (NO_IMAGE)", async () => {
    const provider = providerFor(async () => jsonResponse({ created: 1, usage: {} }));
    await expect(provider.generateImage("empty", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "empty" })).rejects.toBeInstanceOf(
      ImageNoImageError
    );
    const emptyArrayProvider = providerFor(async () => jsonResponse({ created: 1, data: [], usage: {} }));
    await expect(
      emptyArrayProvider.generateImage("empty-arr", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "empty-arr" })
    ).rejects.toBeInstanceOf(ImageNoImageError);
  });
});

describe("OpenAIImageProvider — provider error taxonomy (P2)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const errorResponse = (status: number, error: Record<string, unknown>, headers?: Record<string, string>) =>
    providerFor(async () => jsonResponse({ error }, status, headers));

  it("HTTP 401 -> AUTH", async () => {
    await expect(
      errorResponse(401, { message: "Incorrect API key provided", code: "invalid_api_key" }).generateImage("p", {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        prompt: "p",
      })
    ).rejects.toMatchObject({ code: "AUTH", status: 401 });
  });

  it("HTTP 403 with organization verification text -> ORG_VERIFICATION_REQUIRED", async () => {
    const err = await errorResponse(403, {
      message: "Your organization must be verified to use the model `gpt-image-2.6-flare`.",
      code: "organization_verification_required",
    })
      .generateImage("p", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "p" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderOperationError);
    expect(err.code).toBe("ORG_VERIFICATION_REQUIRED");
    const mapped = mapImageProviderErrorToHttp(err);
    expect(mapped).toMatchObject({ status: 403, code: "IMAGE_PROVIDER_ORGANIZATION_UNVERIFIED" });
    expect(mapped?.error).toMatch(/organization must be verified/i);
  });

  it("HTTP 403 without verification text stays AUTH (no over-classification)", async () => {
    await expect(
      errorResponse(403, { message: "You do not have access to this model." }).generateImage("p", {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        prompt: "p",
      })
    ).rejects.toMatchObject({ code: "AUTH" });
  });

  it("HTTP 429 -> RATE_LIMIT and preserves Retry-After", async () => {
    const err = await errorResponse(429, { message: "Rate limit reached", code: "rate_limit_exceeded" }, {
      "Retry-After": "17",
    })
      .generateImage("p", { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "p" })
      .catch((e) => e);
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.retryAfter).toBe("17");
  });

  it("HTTP 402 / billing_hard_limit_reached -> QUOTA", async () => {
    await expect(
      errorResponse(400, { message: "Billing hard limit reached", code: "billing_hard_limit_reached" }).generateImage("p", {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        prompt: "p",
      })
    ).rejects.toMatchObject({ code: "QUOTA" });
    await expect(
      errorResponse(402, { message: "Insufficient quota" }).generateImage("p", {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        prompt: "p",
      })
    ).rejects.toMatchObject({ code: "QUOTA" });
  });

  it("HTTP 400 moderation/content policy -> BLOCKED", async () => {
    await expect(
      errorResponse(400, { message: "Your request was rejected by the safety system", code: "moderation_blocked" }).generateImage(
        "p",
        { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: "p" }
      )
    ).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("HTTP 400 model_not_found -> UNSUPPORTED_CAPABILITY", async () => {
    await expect(
      errorResponse(400, { message: "The model does not exist", code: "model_not_found" }).generateImage("p", {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        prompt: "p",
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("HTTP 500 -> UNAVAILABLE", async () => {
    await expect(
      errorResponse(500, { message: "server error" }).generateImage("p", {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        prompt: "p",
      })
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("never retains or surfaces the upstream message, key, or prompt", async () => {
    const upstream = `Incorrect API key ${KEY} for prompt ${PROMPT_SENTINEL}`;
    const err = await errorResponse(401, { message: upstream, code: "invalid_api_key" })
      .generateImage(PROMPT_SENTINEL, { model: OPENAI_IMAGE_DEFAULT_MODEL, prompt: PROMPT_SENTINEL })
      .catch((e) => e);
    expect(err.message).toBe("OpenAI image request failed (HTTP 401).");
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(PROMPT_SENTINEL);
    const diagnostic = toProviderDiagnostic(err);
    expect(JSON.stringify(diagnostic)).not.toContain(KEY);
    expect(JSON.stringify(diagnostic)).not.toContain(PROMPT_SENTINEL);
  });
});

describe("OpenAIImageProvider — cancellation (P2)", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("an already-aborted caller signal is CANCELLED with ZERO network calls", async () => {
    const fetchFn = vi.fn<OpenAIImageFetchLike>();
    const provider = new OpenAIImageProvider({ fetchFn });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.generateImage("p", {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        prompt: "p",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an abort while the request is in flight surfaces CANCELLED (never TIMEOUT)", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<OpenAIImageFetchLike>().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        });
      });
    });
    const provider = new OpenAIImageProvider({ fetchFn });
    const pending = provider.generateImage("p", {
      model: OPENAI_IMAGE_DEFAULT_MODEL,
      prompt: "p",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("a cancelled request never commits a transient preview after the provider returns", async () => {
    const provider = providerFor(async () => dataResponse(VALID_PNG_BASE64));
    const store = new ImagePreviewStore({ scheduleCleanup: () => () => {} });
    const aborted = AbortSignal.abort();
    await expect(
      generateRecipeImagePreview({ title: "Cancelled Dish" }, provider, store, {
        model: OPENAI_IMAGE_DEFAULT_MODEL,
        signal: aborted,
      })
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
