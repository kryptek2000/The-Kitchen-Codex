import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractProviderError, logModelAttempt } from "../../server/providerDiagnostics.js";

describe("providerDiagnostics: extractProviderError", () => {
  it("extracts bounded name/status/code/message fields only", () => {
    const err = Object.assign(new Error("boom"), {
      status: 404,
      code: "NOT_FOUND",
    }) as unknown as Record<string, unknown>;
    const d = extractProviderError(err);
    expect(d.name).toBe("Error");
    expect(d.status).toBe(404);
    expect(d.code).toBe("NOT_FOUND");
    expect(d.message).toBe("boom");
  });

  it("redacts bearer secrets and API-key-like strings", () => {
    const d = extractProviderError({
      name: "Error",
      message: "invalid key sk-abc123def456ghi and Bearer sekrit-token with AIza1234567890ABCDEF",
    });
    expect(d.message).not.toContain("sk-abc123def456ghi");
    expect(d.message).not.toContain("sekrit-token");
    expect(d.message).not.toContain("AIza1234567890ABCDEF");
  });

  it("never serializes the whole provider object", () => {
    const payload = extractProviderError({ message: "x", config: { apiKey: "SECRET" }, data: { huge: "y" } });
    expect(Object.keys(payload).sort()).toEqual(["message"]);
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });

  it("bounds an overlong message and a non-object", () => {
    const d = extractProviderError({ message: "m".repeat(10000) });
    expect(d.message!.length).toBeLessThanOrEqual(300);
    expect(extractProviderError("just a string").message).toBe("just a string");
    expect(extractProviderError(null)).toEqual({});
  });
});

describe("providerDiagnostics: logModelAttempt (no secret leakage)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs a bounded, redacted line and never the error object", () => {
    const err = Object.assign(new Error("model not found"), { status: 404, code: "NOT_FOUND" });
    logModelAttempt("interpret", "gemini-3.7-flash", err);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain("[Kitchen interpret] model attempt failed");
    expect(line).toContain("model=gemini-3.7-flash");
    expect(line).toContain("status=404");
    expect(line).toContain("code=NOT_FOUND");
    expect(line).toContain("message=model not found");
  });

  it("does not emit secret values even if present on the error", () => {
    const err = Object.assign(new Error("api key sk-abc123456 skipped"), {
      apiKey: "sk-abc1234567890",
      headers: { authorization: "Bearer sekrit" },
    });
    logModelAttempt("discover", "gemini-3.1-flash-lite", err);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("sk-abc1234567890");
    expect(line).not.toContain("Bearer sekrit");
    expect(line).not.toContain("authorization");
  });
});
