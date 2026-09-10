/**
 * The Kitchen Codex — Image failure taxonomy end-to-end (v0.7 Phase 2B).
 *
 * Proves the distinct normalized provider outcomes are preserved from the
 * provider/API layer through to the HTTP response shape: QUOTA / RATE_LIMIT /
 * TIMEOUT / UNAVAILABLE / BLOCKED / NO_IMAGE / AUTH each map to their OWN code +
 * bounded message, and are NEVER collapsed into one broad "temporarily
 * unavailable". No raw provider text, prompt, key, or base64 leaks.
 */

import { describe, it, expect } from "vitest";
import { mapImageProviderErrorToHttp } from "../../server/app.js";
import {
  ImageBlockedError,
  ImageNoImageError,
  ImageValidationError,
} from "../../server/ai/imageProvider.js";
import { ProviderOperationError, classifyProviderError } from "../../server/ai/providerErrors.js";
import { GeminiImageProvider } from "../../server/ai/geminiImageProvider.js";

describe("mapImageProviderErrorToHttp — distinct end-to-end taxonomy", () => {
  it("QUOTA maps distinctly to IMAGE_PROVIDER_QUOTA (503)", () => {
    const err = new ProviderOperationError("QUOTA", "quota exceeded", { providerId: "gemini-image" });
    expect(mapImageProviderErrorToHttp(err)).toEqual({
      status: 503,
      error: "Image generation quota has been reached. Please try again later.",
      code: "IMAGE_PROVIDER_QUOTA",
    });
  });

  it("RATE_LIMIT maps to IMAGE_PROVIDER_RATE_LIMIT (503) and preserves Retry-After when status is 429", () => {
    const err = new ProviderOperationError("RATE_LIMIT", "too many requests", { providerId: "gemini-image" });
    Object.defineProperty(err, "status", { value: 429, enumerable: true });
    const mapped = mapImageProviderErrorToHttp(err);
    expect(mapped?.code).toBe("IMAGE_PROVIDER_RATE_LIMIT");
    expect(mapped?.status).toBe(503);
    expect(mapped?.retryAfter).toBe("60");
    expect(mapped?.error).toContain("rate limited");
  });

  it("TIMEOUT maps to IMAGE_PROVIDER_TIMEOUT (503)", () => {
    const err = new ProviderOperationError("TIMEOUT", "timed out", { providerId: "gemini-image" });
    expect(mapImageProviderErrorToHttp(err)?.code).toBe("IMAGE_PROVIDER_TIMEOUT");
  });

  it("UNAVAILABLE remains IMAGE_PROVIDER_TEMPORARILY_UNAVAILABLE (503) and is NOT collapsed into quota/timeout", () => {
    const err = new ProviderOperationError("UNAVAILABLE", "not available", { providerId: "gemini-image" });
    const mapped = mapImageProviderErrorToHttp(err);
    expect(mapped?.code).toBe("IMAGE_PROVIDER_TEMPORARILY_UNAVAILABLE");
    expect(mapped?.status).toBe(503);
    // Provider-neutral copy: never hardcodes a provider name into the message.
    expect(mapped?.error).toBe("Image generation is temporarily unavailable. Please try again shortly.");
    // Distinct — quota/rate-limit/timeout all differ.
    expect(mapImageProviderErrorToHttp(new ProviderOperationError("QUOTA", "q"))?.code).toBe("IMAGE_PROVIDER_QUOTA");
    expect(mapImageProviderErrorToHttp(new ProviderOperationError("RATE_LIMIT", "r"))?.code).toBe("IMAGE_PROVIDER_RATE_LIMIT");
    expect(mapImageProviderErrorToHttp(new ProviderOperationError("TIMEOUT", "t"))?.code).toBe("IMAGE_PROVIDER_TIMEOUT");
  });

  it("BLOCKED (prompt/safety) maps to IMAGE_PROVIDER_BLOCKED (502) with provider-neutral copy", () => {
    const err = new ImageBlockedError("blocked for safety", { providerId: "gemini-image" });
    const mapped = mapImageProviderErrorToHttp(err);
    expect(mapped).toMatchObject({
      status: 502,
      code: "IMAGE_PROVIDER_BLOCKED",
    });
    expect(mapped?.error).toBe("The image provider could not generate an image for this recipe. Try adjusting the recipe description or generating again.");
  });

  it("NO_IMAGE maps to IMAGE_PROVIDER_NO_IMAGE (502) with provider-neutral copy", () => {
    const err = new ImageNoImageError("no inline image", { providerId: "gemini-image" });
    const mapped = mapImageProviderErrorToHttp(err);
    expect(mapped).toMatchObject({
      status: 502,
      code: "IMAGE_PROVIDER_NO_IMAGE",
    });
    expect(mapped?.error).toBe("The image provider did not return an image for this recipe. Try generating again.");
  });

  it("provider-neutral user-facing messages NEVER hardcode a provider name (Gemini/OpenRouter)", () => {
    // Every mapped bounded message must be usable regardless of which provider is
    // pinned — no "Gemini ..." strings may surface while OpenRouter is selected.
    const cases = [
      new ProviderOperationError("UNAVAILABLE", "x", { providerId: "openrouter-image" }),
      new ProviderOperationError("QUOTA", "x", { providerId: "openrouter-image" }),
      new ProviderOperationError("RATE_LIMIT", "x", { providerId: "openrouter-image" }),
      new ProviderOperationError("TIMEOUT", "x", { providerId: "openrouter-image" }),
      new ProviderOperationError("AUTH", "x", { providerId: "openrouter-image" }),
      new ImageBlockedError("x", { providerId: "openrouter-image" }),
      new ImageNoImageError("x", { providerId: "openrouter-image" }),
    ];
    for (const err of cases) {
      const mapped = mapImageProviderErrorToHttp(err);
      expect(mapped).toBeDefined();
      expect(mapped?.error).toBeTruthy();
      expect(mapped?.error).not.toMatch(/Gemini|OpenRouter/i);
    }
  });

  it("AUTH maps to IMAGE_PROVIDER_AUTH (502)", () => {
    const err = new ProviderOperationError("AUTH", "forbidden", { providerId: "gemini-image" });
    expect(mapImageProviderErrorToHttp(err)?.code).toBe("IMAGE_PROVIDER_AUTH");
  });

  it("INVALID_RESPONSE / malformed image is handled by the existing INVALID_IMAGE branch, not remapped", () => {
    const err = new ImageValidationError("mismatch", { providerId: "gemini-image" });
    // The route special-cases INVALID_RESPONSE before mapImageProviderErrorToHttp.
    expect(err.code).toBe("INVALID_RESPONSE");
    expect(mapImageProviderErrorToHttp(err)).toBeUndefined();
  });

  it("bounded messages carry no raw provider text / prompt / key / base64", () => {
    const raw = "API key sk-SECRET invalid; SUPER_SECRET_PROMPT sentinel; data:image/png;base64,AAAA";
    const err = new ProviderOperationError("RATE_LIMIT", raw, { providerId: "gemini-image" });
    Object.defineProperty(err, "status", { value: 429, enumerable: true });
    const mapped = mapImageProviderErrorToHttp(err);
    expect(mapped).toBeDefined();
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("sk-SECRET");
    expect(serialized).not.toContain("SUPER_SECRET_PROMPT");
    expect(serialized).not.toContain("base64,AAAA");
    expect(mapped?.error).not.toContain(raw);
  });

  it("provider normalization (classifyProviderError) distinguishes AUTH/QUOTA/RATE_LIMIT/TIMEOUT/UNAVAILABLE/BLOCKED", () => {
    const provider = new GeminiImageProvider();
    // Proves a provider-level exception with a safety/blocked message normalizes to
    // BLOCKED (not collapsed), and the transient categories stay distinct.
    expect(provider.id).toBe("gemini-image");
    expect(classifyProviderError("The prompt was blocked by safety filters")).toBe("BLOCKED");
    expect(classifyProviderError(Object.assign(new Error("Resource exhausted"), { status: 429 }))).toBe("RATE_LIMIT");
    expect(classifyProviderError(new Error("Quota exceeded for project"))).toBe("QUOTA");
    expect(classifyProviderError(Object.assign(new Error("bad"), { status: 401 }))).toBe("AUTH");
    expect(classifyProviderError(Object.assign(new Error("down"), { status: 503 }))).toBe("UNAVAILABLE");
    expect(classifyProviderError(Object.assign(new Error("op aborted"), { name: "AbortError" }))).toBe("TIMEOUT");
  });
});
