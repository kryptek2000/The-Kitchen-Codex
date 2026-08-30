import { describe, it, expect } from "vitest";
import { MODEL_CONFIG } from "../../server/modelConfig.js";

/**
 * Guards the central Gemini model configuration against silent drift:
 * primary/fallback identifiers must stay internally consistent and no stale
 * model identifier (e.g. the retired gemini-3.6-flash) may creep back in.
 */
describe("MODEL_CONFIG", () => {
  it("exposes the expected recipe-grabber cascade identifiers", () => {
    expect(MODEL_CONFIG.recipeGrabberPrimary).toBe("gemini-3.7-flash");
    expect(MODEL_CONFIG.recipeGrabberFallback).toBe("gemini-3.1-flash-lite");
    expect(MODEL_CONFIG.recipeGrabberAlias).toBe("gemini-flash-latest");
  });

  it("exposes the expected nutrition cascade identifiers", () => {
    expect(MODEL_CONFIG.nutritionPrimary).toBe("gemini-3.7-flash");
    expect(MODEL_CONFIG.nutritionFallback).toBe("gemini-3.1-flash-lite");
  });

  it("exposes the expected metadata recovery cascade identifiers", () => {
    expect(MODEL_CONFIG.metadataRecoveryPrimary).toBe("gemini-3.7-flash");
    expect(MODEL_CONFIG.metadataRecoveryFallback).toBe("gemini-3.1-flash-lite");
  });

  it("uses distinct primary and fallback identifiers within each cascade", () => {
    expect(MODEL_CONFIG.recipeGrabberPrimary).not.toBe(MODEL_CONFIG.recipeGrabberFallback);
    expect(MODEL_CONFIG.nutritionPrimary).not.toBe(MODEL_CONFIG.nutritionFallback);
    expect(MODEL_CONFIG.metadataRecoveryPrimary).not.toBe(MODEL_CONFIG.metadataRecoveryFallback);
  });

  it("configures a sane, positive request timeout", () => {
    expect(MODEL_CONFIG.requestTimeoutMs).toBeGreaterThan(0);
    expect(MODEL_CONFIG.requestTimeoutMs).toBeLessThanOrEqual(120_000);
  });

  it("contains no stale retired model identifiers", () => {
    const serialized = JSON.stringify(MODEL_CONFIG);
    expect(serialized).not.toContain("gemini-3.6-flash");
  });
});
