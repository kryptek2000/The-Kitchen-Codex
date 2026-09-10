import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MODEL_CONFIG } from "../../server/modelConfig.js";
import { getGemini, getGeminiImage } from "../../server/geminiClient.js";

describe("shared Gemini client", () => {
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it("returns null when no API key is configured", () => {
    delete process.env.GEMINI_API_KEY;
    expect(getGemini()).toBeNull();
  });

  it("returns null for the placeholder key", () => {
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";
    expect(getGemini()).toBeNull();
  });

  it("reuses the same client instance while the key is unchanged", () => {
    process.env.GEMINI_API_KEY = "test-key-reuse";
    const a = getGemini();
    const b = getGemini();
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("recreates the client when the key rotates", () => {
    process.env.GEMINI_API_KEY = "test-key-a";
    const a = getGemini();
    process.env.GEMINI_API_KEY = "test-key-b";
    const b = getGemini();
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    // The cache holds one client for the current key; returning to a key
    // rebuilds it rather than leaking a stale shared instance.
    process.env.GEMINI_API_KEY = "test-key-a";
    const aAgain = getGemini();
    expect(aAgain).not.toBeNull();
    expect(aAgain).not.toBe(b);
    // And it is reused for the (now-current) key without rebuilding.
    expect(getGemini()).toBe(aAgain);
  });

  it("reads the key ONLY through the approved server-secret allowlist seam (BYOK-2)", () => {
    const source = readFileSync(new URL("../../server/geminiClient.ts", import.meta.url), "utf8");
    // No direct env access remains: the allowlisted provider-neutral secret id only.
    expect(source).not.toContain("process.env.GEMINI_API_KEY");
    expect(source).not.toContain("process.env[");
    expect(source).not.toContain("lastApiKey === key");
    expect(source).toContain('getServerSecretSync("gemini_api_key")');
  });
});

describe("Gemini IMAGE client timeout (BYOK-3 hardening)", () => {
  afterEach(() => {
    vi.doUnmock("@google/genai");
    vi.resetModules();
    delete process.env.GEMINI_API_KEY;
  });

  it("text client uses the 25s request ceiling; IMAGE client uses the dedicated 60s image timeout", async () => {
    vi.resetModules(); // re-evaluate geminiClient under the mock so construction is captured
    const captured: Array<{ httpOptions?: { timeout?: number } }> = [];
    vi.doMock("@google/genai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@google/genai")>();
      const Wrapped = class extends actual.GoogleGenAI {
        constructor(...args: any[]) {
          super(...args);
          captured.push(args[0] ?? {});
        }
      };
      return { ...actual, GoogleGenAI: Wrapped };
    });
    process.env.GEMINI_API_KEY = "image-timeout-key";
    const { getGemini, getGeminiImage } = await import("../../server/geminiClient.js");
    expect(getGeminiImage()).not.toBeNull();
    expect(getGemini()).not.toBeNull();
    expect(captured).toHaveLength(2);
    const timeouts = captured.map((c) => c.httpOptions?.timeout).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(timeouts).toEqual([MODEL_CONFIG.requestTimeoutMs, MODEL_CONFIG.imageGenerationTimeoutMs]);
    expect(MODEL_CONFIG.imageGenerationTimeoutMs).toBe(60_000);
  });

  it("image client is null without a key / placeholder, exactly like the text client", async () => {
    vi.resetModules();
    vi.doMock("@google/genai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@google/genai")>();
      return actual;
    });
    const { getGeminiImage } = await import("../../server/geminiClient.js");
    delete process.env.GEMINI_API_KEY;
    expect(getGeminiImage()).toBeNull();
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";
    expect(getGeminiImage()).toBeNull();
    process.env.GEMINI_API_KEY = "real-image-key";
    expect(getGeminiImage()).not.toBeNull();
  });
});
