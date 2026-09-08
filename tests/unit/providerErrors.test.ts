import { describe, it, expect } from "vitest";
import {
  classifyProviderError,
  normalizeProviderError,
  ProviderOperationError,
  isFallbackEligible,
  toProviderDiagnostic,
  FALLBACK_ELIGIBLE_ERROR_CODES,
} from "../../server/ai/providerErrors.js";

function typedErr(code: string, msg: string, status?: number) {
  return Object.assign(new Error(msg), { status, code });
}

describe("provider error taxonomy (v0.7 1A)", () => {
  it("classifies auth-like errors", () => {
    expect(classifyProviderError(typedErr("401", "unauthorized", 401))).toBe("AUTH");
    expect(classifyProviderError(new Error("invalid api key"))).toBe("AUTH");
    expect(classifyProviderError(typedErr("", "permission denied"))).toBe("AUTH");
  });

  it("classifies quota / rate limit", () => {
    expect(classifyProviderError(typedErr("", "quota exceeded"))).toBe("QUOTA");
    expect(classifyProviderError(typedErr("", "rate limit hit", 429))).toBe("RATE_LIMIT");
    expect(classifyProviderError(new Error("too many requests, try again soon"))).toBe("RATE_LIMIT");
  });

  it("classifies timeout / abort", () => {
    expect(classifyProviderError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("TIMEOUT");
    expect(classifyProviderError(new Error("request timed out"))).toBe("TIMEOUT");
  });

  it("classifies unavailable / gateway-style", () => {
    expect(classifyProviderError(typedErr("", "service unavailable", 503))).toBe("UNAVAILABLE");
    expect(classifyProviderError(new Error("AI provider is not available."))).toBe("UNAVAILABLE");
  });

  it("classifies invalid response", () => {
    expect(classifyProviderError(new Error("Empty response returned from AI provider."))).toBe("INVALID_RESPONSE");
    expect(classifyProviderError(new Error("Could not parse JSON"))).toBe("INVALID_RESPONSE");
  });

  it("falls back to PROVIDER_ERROR for unknown errors", () => {
    expect(classifyProviderError(new Error("something odd"))).toBe("PROVIDER_ERROR");
  });

  it("preserves an already-normalized error", () => {
    const e = new ProviderOperationError("QUOTA", "q");
    expect(normalizeProviderError(e)).toBe(e);
  });

  it("normalizeProviderError attaches provider/model context and keeps a non-enumerable cause", () => {
    const raw = new Error("boom");
    const n = normalizeProviderError(raw, { providerId: "gemini", model: "m" });
    expect(n).toBeInstanceOf(ProviderOperationError);
    expect(n.code).toBe("PROVIDER_ERROR");
    expect(n.providerId).toBe("gemini");
    expect(n.model).toBe("m");
    expect(n.cause).toBe(raw);
    // cause is NOT enumerable -> never serializes.
    expect(JSON.stringify(n)).not.toContain("boom");
    expect(Object.keys(n)).not.toContain("cause");
  });

  it("redacts secret patterns in the normalized message", () => {
    const n = normalizeProviderError(new Error("key=GEMINI_API_KEY secret Bearer abc123 sk-ABCDEF123456"));
    // The actual secret TOKENS must never survive redaction.
    expect(n.message).not.toContain("ABCDEF123456");
    expect(n.message).not.toContain("abc123");
    expect(n.message).not.toContain("AIza");
    // ...and the message is still human-readable with the secrets replaced.
    expect(n.message).toContain("Bearer <redacted>");
    expect(n.message).toContain("GEMINI_API_KEY=<redacted>");
  });

  it("toProviderDiagnostic returns a sanitized, serializable summary", () => {
    const n = normalizeProviderError(new Error("secret sk-ABCDEF123456 boom"), { providerId: "p", model: "m" });
    const d = toProviderDiagnostic(n);
    expect(d.code).toBe("PROVIDER_ERROR");
    expect(d.providerId).toBe("p");
    expect(d.model).toBe("m");
    expect(JSON.stringify(d)).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
  });

  it("marks the expected codes as fallback-eligible (and AUTH/UNSUPPORTED are not)", () => {
    const eligible = ["QUOTA", "RATE_LIMIT", "UNAVAILABLE", "TIMEOUT", "INVALID_RESPONSE", "PROVIDER_ERROR"];
    for (const code of eligible) expect(isFallbackEligible(code as any), code).toBe(true);
    expect(isFallbackEligible("AUTH")).toBe(false);
    expect(isFallbackEligible("UNSUPPORTED_CAPABILITY")).toBe(false);
    expect(FALLBACK_ELIGIBLE_ERROR_CODES.has("AUTH")).toBe(false);
  });
});
