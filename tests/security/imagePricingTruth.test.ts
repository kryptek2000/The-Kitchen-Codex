import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Phase 2 — server-owned image pricing truth.
 *
 * Proves that "zero" is claimed ONLY from current, verified, all-zero OpenRouter
 * pricing; that Gemini image is always variable (account-determined); and that
 * unverified/paid models require an explicit per-generation confirmation.
 */

function imageModel(pricing: Record<string, unknown>, id = "google/gemini-2.5-flash-image") {
  return {
    id,
    name: "Image Model",
    context_length: 8192,
    architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    pricing,
    supported_parameters: ["temperature"],
  };
}

function jsonFetch(payload: unknown) {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
}

async function fresh() {
  vi.resetModules();
  const catalog = await import("../../server/ai/openRouterCatalog.js");
  const pricing = await import("../../server/ai/imagePricing.js");
  return { catalog, pricing };
}

afterEach(() => {
  vi.resetModules();
});

describe("imagePricingTruth — truthful cost classification", () => {
  it("Gemini image is VARIABLE and requires confirmation (account-determined)", async () => {
    const { pricing } = await fresh();
    const truth = pricing.imagePricingTruth("gemini-image", "gemini-2.5-flash-image");
    expect(truth.costClass).toBe("variable");
    expect(truth.requiresConfirmation).toBe(true);
    expect(truth.label).toMatch(/Google account/i);
    expect(truth.label).not.toMatch(/zero/i);
  });

  it("OpenRouter image without fresh verified pricing is VARIABLE (never FREE)", async () => {
    const { pricing } = await fresh();
    const truth = pricing.imagePricingTruth("openrouter-image", "google/gemini-2.5-flash-image");
    expect(truth.costClass).toBe("variable");
    expect(truth.requiresConfirmation).toBe(true);
    expect(truth.label).not.toMatch(/zero/i);
  });

  it("an UNKNOWN/future provider FAILS CLOSED (variable + confirmation, never zero)", async () => {
    const { pricing } = await fresh();
    for (const providerId of ["some-future-image-provider", "mock-image", "", "OpenRouter-Image"]) {
      const truth = pricing.imagePricingTruth(providerId, "some/model");
      expect(truth.costClass).toBe("variable");
      expect(truth.requiresConfirmation).toBe(true);
      expect(truth.label).not.toMatch(/zero/i);
    }
  });

  it("only the explicit deterministic test seam is zero-price (and it is not a production provider)", async () => {
    const { pricing } = await fresh();
    const truth = pricing.imagePricingTruth("deterministic-image", "deterministic-2b1");
    expect(truth.costClass).toBe("zero");
    expect(truth.requiresConfirmation).toBe(false);
  });

  it("a verified all-zero image model is ZERO and skips confirmation", async () => {
    const { catalog, pricing } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [imageModel({ prompt: "0", completion: "0", image_output: "0" }, "img/free")],
      }) as never,
    });
    const truth = pricing.imagePricingTruth("openrouter-image", "img/free");
    expect(truth.costClass).toBe("zero");
    expect(truth.requiresConfirmation).toBe(false);
    expect(truth.label).toBe("Verified zero price");
    expect(truth.pricingFingerprint).toBeTruthy();
  });

  it("a non-zero image-output price is PAID and requires confirmation", async () => {
    const { catalog, pricing } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [imageModel({ prompt: "0.00001", completion: "0.00003", image_output: "0.00006" }, "img/paid")],
      }) as never,
    });
    const truth = pricing.imagePricingTruth("openrouter-image", "img/paid");
    expect(truth.costClass).toBe("paid");
    expect(truth.requiresConfirmation).toBe(true);
    expect(truth.label).toMatch(/Paid/);
    expect(truth.pricingFingerprint).toBeTruthy();
  });

  it("a missing image-output component is VARIABLE (incomplete, never zero, never paid)", async () => {
    const { catalog, pricing } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [imageModel({ prompt: "0", completion: "0" }, "img/missing")],
      }) as never,
    });
    const truth = pricing.imagePricingTruth("openrouter-image", "img/missing");
    expect(truth.costClass).toBe("variable");
    expect(truth.requiresConfirmation).toBe(true);
  });

  it("a verified non-zero component is PAID (affirmative pricing evidence)", async () => {
    const { catalog, pricing } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [imageModel({ prompt: "0.00001", completion: "0", image_output: "0" }, "img/text-paid")],
      }) as never,
    });
    const truth = pricing.imagePricingTruth("openrouter-image", "img/text-paid");
    expect(truth.costClass).toBe("paid");
    expect(truth.requiresConfirmation).toBe(true);
  });

  it("the pricing fingerprint changes when the price changes", async () => {
    const { catalog, pricing } = await fresh();
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [imageModel({ prompt: "0", completion: "0", image_output: "0.00006" }, "img/x")],
      }) as never,
    });
    const first = pricing.imagePricingTruth("openrouter-image", "img/x");
    catalog.resetOpenRouterCatalogForTests();
    await catalog.refreshOpenRouterCatalog({
      force: true,
      fetchFn: jsonFetch({
        data: [imageModel({ prompt: "0", completion: "0", image_output: "0.00009" }, "img/x")],
      }) as never,
    });
    const second = pricing.imagePricingTruth("openrouter-image", "img/x");
    expect(first.pricingFingerprint).not.toBe(second.pricingFingerprint);
  });
});
