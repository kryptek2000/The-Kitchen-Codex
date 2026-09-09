/**
 * The Kitchen Codex — Production image-provider wiring regression (v0.7 Phase 2B).
 *
 * Proves the REAL/default production app construction registers the Gemini image
 * provider (and never the deterministic test seam), and that availability is
 * truthful with respect to the server-side GEMINI_API_KEY.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveImageProvider } from "../../server/app.js";
import { GeminiImageProvider, DEFAULT_GEMINI_IMAGE_MODEL } from "../../server/ai/geminiImageProvider.js";
import { DeterministicImageProvider } from "../../server/ai/imageProvider.js";

describe("resolveImageProvider — default production wiring", () => {
  let originalKey: string | undefined;
  beforeEach(() => {
    originalKey = process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  it("with NO injected provider, the DEFAULT is the real GeminiImageProvider + its proven model (deterministic is never the production default)", () => {
    const { provider, modelOverride } = resolveImageProvider({});
    expect(provider).toBeInstanceOf(GeminiImageProvider);
    expect(provider.id).toBe("gemini-image");
    // The deterministic test seam must never be selected by default.
    expect(provider).not.toBeInstanceOf(DeterministicImageProvider);
    // Production model override is the proven Gemini image model.
    expect(modelOverride).toEqual({ model: DEFAULT_GEMINI_IMAGE_MODEL });
  });

  it("the deterministic provider is selected ONLY when explicitly injected (test seam)", () => {
    const seam = new DeterministicImageProvider();
    const { provider, modelOverride } = resolveImageProvider({ imageProvider: seam });
    expect(provider).toBe(seam);
    expect(provider.id).toBe("deterministic-image");
    // No production model override is imposed on the seam (it uses its own default).
    expect(modelOverride).toEqual({});
  });

  it("Gemini image provider availability is TRUE when a real server key is configured", () => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "FAKE_TEST_KEY_NOT_PLACEHOLDER";
    try {
      const { provider } = resolveImageProvider({});
      expect(provider.isAvailable()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });

  it("Gemini image provider availability is FALSE when the key is unset or still the placeholder", () => {
    const original = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY"; // placeholder
      expect(resolveImageProvider({}).provider.isAvailable()).toBe(false);
      delete process.env.GEMINI_API_KEY; // unset
      expect(resolveImageProvider({}).provider.isAvailable()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });
});
