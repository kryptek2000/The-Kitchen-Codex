import { describe, it, expect, afterEach } from "vitest";
import { getGemini } from "../../server/geminiClient.js";

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
});
