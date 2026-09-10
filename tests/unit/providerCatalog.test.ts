import { describe, it, expect, vi, afterEach } from "vitest";
import type { ProviderCatalog, ProviderCatalogTextProvider } from "../../server/ai/providerCatalog.js";

const SENTINEL = "SUPER_SECRET_BYOK1_SENTINEL";

const KITCHEN_CODEX_ENV_VARS = [
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
] as const;

export function clearKitchenCodexSelectionEnv(): void {
  for (const k of KITCHEN_CODEX_ENV_VARS) delete process.env[k];
}

async function freshCatalog(env: Record<string, string>): Promise<{
  catalog: ProviderCatalog;
  registry: Awaited<ReturnType<typeof import("../../server/ai/providerRegistry.js").getRegisteredProviders>>;
}> {
  vi.resetModules();
  for (const k of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[k];
  clearKitchenCodexSelectionEnv();
  Object.assign(process.env, env);
  const catalogMod = await import("../../server/ai/providerCatalog.js");
  const registryMod = await import("../../server/ai/providerRegistry.js");
  return { catalog: catalogMod.buildProviderCatalog(), registry: registryMod.getRegisteredProviders() };
}

function byProviderId(
  providers: { providerId: string }[]
): Record<string, (typeof providers)[number]> {
  return Object.fromEntries(providers.map((p) => [p.providerId, p]));
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[k];
  clearKitchenCodexSelectionEnv();
  vi.resetModules();
});

describe("provider catalog (BYOK-1) — shape and ordering", () => {
  it("lists text providers in registry order then the production image providers", async () => {
    const { catalog } = await freshCatalog({});
    expect(catalog.textProviders.map((p) => p.providerId)).toEqual(["gemini", "openrouter", "deepseek"]);
    // Registry order: Gemini image first, OpenRouter Image second (BYOK-3).
    expect(catalog.imageProviders.map((p) => p.providerId)).toEqual(["gemini-image", "openrouter-image"]);
  });

  it("exposes strict booleans + truthful storage scope (server_environment; no secret writes)", async () => {
    const { catalog } = await freshCatalog({}); // no env elsewhere
    for (const p of catalog.textProviders) {
      for (const k of ["configured", "enabled", "available", "supportsSecretWrites"] as const) {
        expect(typeof p[k]).toBe("boolean");
      }
      expect(p.storageScope).toBe("server_environment");
      expect(p.supportsSecretWrites).toBe(false);
    }
    for (const image of catalog.imageProviders) {
      for (const k of ["configured", "enabled", "available", "imageGeneration"] as const) {
        expect(typeof image[k]).toBe("boolean");
      }
    }
  });

  it("image providers are truthful (formats + byte cap + curated default models)", async () => {
    const { catalog } = await freshCatalog({});
    const gemini = catalog.imageProviders.find((p) => p.providerId === "gemini-image")!;
    expect(gemini.imageGeneration).toBe(true);
    expect(gemini.formats).toEqual(["image/png"]);
    expect(gemini.maxBytes).toBe(4 * 1024 * 1024);
    expect(gemini.models).toEqual([{ id: "gemini-2.5-flash-image", default: true }]);
    const openRouter = catalog.imageProviders.find((p) => p.providerId === "openrouter-image")!;
    expect(openRouter.imageGeneration).toBe(true);
    // OpenRouter image models produce raster containers; formats are within the allowlist.
    expect(openRouter.formats).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(openRouter.maxBytes).toBe(4 * 1024 * 1024);
    expect(openRouter.models).toEqual([
      { id: "google/gemini-2.5-flash-image", default: true },
      { id: "bytedance-seed/seedream-4.5", default: false },
    ]);
    // Deterministic: formats stay within the shared generated-image allowlist.
    for (const image of catalog.imageProviders) {
      expect(image.formats.every((f) => ["image/jpeg", "image/png", "image/webp", "image/avif"].includes(f))).toBe(true);
    }
  });
});

describe("provider catalog (BYOK-1) — configured/enabled/available mirror the registry", () => {
  it("no operator keys => Gemini enabled-but-unconfigured; OpenRouter/DeepSeek inert; images inactive", async () => {
    const { catalog } = await freshCatalog({});
    const text = byProviderId(catalog.textProviders);
    expect(text["gemini"]).toMatchObject({ configured: false, enabled: true, available: false });
    expect(text["openrouter"]).toMatchObject({ configured: false, enabled: false, available: false });
    expect(text["deepseek"]).toMatchObject({ configured: false, enabled: false, available: false });
    const image = byProviderId(catalog.imageProviders);
    // Gemini image is enabled-but-unconfigured; OpenRouter image is INERT without a key.
    expect(image["gemini-image"]).toMatchObject({ configured: false, enabled: true, available: false });
    expect(image["openrouter-image"]).toMatchObject({ configured: false, enabled: false, available: false });
  });

  it("all three keys configured => all text + image providers available", async () => {
    const { catalog } = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      DEEPSEEK_API_KEY: SENTINEL,
    });
    for (const p of catalog.textProviders) {
      expect(p).toMatchObject({ configured: true, enabled: true, available: true });
    }
    for (const image of catalog.imageProviders) {
      expect(image).toMatchObject({ configured: true, enabled: true, available: true });
    }
  });
});

describe("provider catalog (BYOK-1) — curated model truth", () => {
  it("Gemini lists its curated role models with the primary marked default and full capabilities", async () => {
    const { catalog } = await freshCatalog({ GEMINI_API_KEY: SENTINEL });
    const gemini = byProviderId(catalog.textProviders)["gemini"] as ProviderCatalogTextProvider;
    expect(gemini.models.map((m) => m.id)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
    ]);
    const primary = gemini.models.find((m) => m.default);
    expect(primary).toBeDefined();
    expect(primary!.id).toBe("gemini-3.7-flash");
    for (const m of gemini.models) {
      expect(m.capabilities).toEqual({
        reasoning: true,
        structuredOutput: true,
        recipeGeneration: true,
        webSearch: true,
      });
    }
  });

  it("OpenRouter has one curated model; per-model capabilities match the registry override", async () => {
    const { catalog } = await freshCatalog({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL });
    const openRouter = byProviderId(catalog.textProviders)["openrouter"] as ProviderCatalogTextProvider;
    expect(openRouter.models).toHaveLength(1);
    expect(openRouter.models[0]).toMatchObject({
      id: "openai/gpt-4o-mini",
      default: true,
      capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: true, webSearch: false },
    });
  });

  it("DeepSeek models are curated role models with reasoning but no structured output", async () => {
    const { catalog } = await freshCatalog({ GEMINI_API_KEY: SENTINEL, DEEPSEEK_API_KEY: SENTINEL });
    const deepSeek = byProviderId(catalog.textProviders)["deepseek"] as ProviderCatalogTextProvider;
    expect(deepSeek.models.map((m) => m.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    for (const m of deepSeek.models) {
      expect(m.capabilities).toEqual({
        reasoning: true,
        structuredOutput: false,
        recipeGeneration: false,
        webSearch: false,
      });
    }
  });

  it("curated models are structurally unique per provider (no duplicate model rows)", async () => {
    const { catalog } = await freshCatalog({ GEMINI_API_KEY: SENTINEL });
    for (const provider of catalog.textProviders) {
      const ids = provider.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("derives all catalog models from the curated role-model set (never invents models)", async () => {
    const { catalog, registry } = await freshCatalog({});
    const roleCandidates = await import("../../server/ai/roleCandidates.js");
    const operations = [
      "kitchenInterpret",
      "kitchenRank",
      "kitchenDiscover",
      "nutrition",
      "metadataRecovery",
      "recipeGrabber",
      "createRecipe",
    ] as const;
    for (const provider of catalog.textProviders) {
      const curated = new Set<string>();
      for (const operation of operations) {
        for (const id of roleCandidates.roleModelsForProvider(provider.providerId, operation)) curated.add(id);
      }
      if (provider.models.length === 0) {
        // Providers with no curated role models must be empty in the catalog.
        expect(curated.size).toBe(0);
        continue;
      }
      for (const model of provider.models) {
        expect(curated.has(model.id)).toBe(true);
      }
    }
    const reg = registry.find((r) => r.provider.id === "openrouter")!;
    const providerRegistry = await import("../../server/ai/providerRegistry.js");
    const unknown = providerRegistry.effectiveCapabilities(reg, "some/unknown-uncurated-model");
    expect(unknown).toEqual({ reasoning: false, structuredOutput: false, recipeGeneration: false, webSearch: false });
  });
});

describe("provider catalog (BYOK-1) — secret-free payload", () => {
  it("serializes WITHOUT env names, secret-shaped keys, or sentinel values", async () => {
    const { catalog } = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      DEEPSEEK_API_KEY: SENTINEL,
    });
    const rows = [...catalog.textProviders, ...catalog.imageProviders];
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        expect(["key", "token", "secret", "apiKey", "value", "maskedKey"].includes(k)).toBe(false);
      }
    }
    const json = JSON.stringify(catalog);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain("GEMINI_API_KEY");
    expect(json).not.toContain("OPENROUTER_API_KEY");
    expect(json).not.toContain("DEEPSEEK_API_KEY");
  });
});

describe("provider catalog (BYOK-2) — server-managed selection truth", () => {
  it("reports server_default for both text and image when no selection env is set", async () => {
    const { catalog } = await freshCatalog({});
    expect(catalog.selection.text).toEqual({ selectionMode: "server_default", valid: true });
    expect(catalog.selection.image).toEqual({ selectionMode: "server_default", valid: true });
  });

  it("reports a valid server-managed text provider pin in selection truth", async () => {
    const { catalog } = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      DEEPSEEK_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
    });
    expect(catalog.selection.text).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "openrouter",
      valid: true,
    });
    expect(catalog.selection.image).toEqual({ selectionMode: "server_default", valid: true });
  });

  it("reports a valid server-managed provider+model pin including the curated model", async () => {
    const { catalog } = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash",
    });
    expect(catalog.selection.text).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "gemini",
      selectedModelId: "gemini-3.7-flash",
      valid: true,
    });
  });

  it("reports valid:false truthfully for an unknown provider pin (runtime uses safe default)", async () => {
    const { catalog } = await freshCatalog({ KITCHEN_CODEX_TEXT_PROVIDER: "not-a-provider" });
    expect(catalog.selection.text).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "not-a-provider",
      selectedModelId: undefined,
      valid: false,
    });
  });

  it("reports valid:false truthfully for an unknown curated model pin", async () => {
    const { catalog } = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "not-a-curated-model",
    });
    expect(catalog.selection.text).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "gemini",
      selectedModelId: "not-a-curated-model",
      valid: false,
    });
  });

  it("reports image selection truth (provider/model pins mirror the image registry)", async () => {
    const { catalog } = await freshCatalog({
      KITCHEN_CODEX_IMAGE_PROVIDER: "gemini-image",
      KITCHEN_CODEX_IMAGE_MODEL: "gemini-2.5-flash-image",
    });
    expect(catalog.selection.image).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "gemini-image",
      selectedModelId: "gemini-2.5-flash-image",
      valid: true,
    });
  });

  it("reports valid server-managed OpenRouter Image selection (BYOK-3) once the key is configured", async () => {
    const { catalog } = await freshCatalog({
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
      KITCHEN_CODEX_IMAGE_MODEL: "bytedance-seed/seedream-4.5",
    });
    expect(catalog.selection.image).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "openrouter-image",
      selectedModelId: "bytedance-seed/seedream-4.5",
      valid: true,
    });
  });

  it("OpenRouter Image pin is invalid without a key OR with an uncurated model (truthful, no silent Gemini execution)", async () => {
    const noKey = await freshCatalog({
      KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
      KITCHEN_CODEX_IMAGE_MODEL: "google/gemini-2.5-flash-image",
    });
    expect(noKey.catalog.selection.image).toEqual({
      selectionMode: "server_managed",
      selectedProviderId: "openrouter-image",
      selectedModelId: "google/gemini-2.5-flash-image",
      valid: false,
    });
    const badModel = await freshCatalog({
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
      KITCHEN_CODEX_IMAGE_MODEL: "maybe/some-unknown-image-model",
    });
    expect(badModel.catalog.selection.image.valid).toBe(false);
  });

  it("selection payload stays secret-free (env var names and no sentinels)", async () => {
    const { catalog } = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash",
    });
    const json = JSON.stringify(catalog.selection);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain("KITCHEN_CODEX");
    expect(json).not.toContain("API_KEY");
  });
});

describe("provider catalog (BYOK-4) — connection-test + selection-extension truth", () => {
  it("exposes a bounded connectionTest kind and strict selectable boolean per provider", async () => {
    const { catalog } = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
    });
    const findText = (providerId: string) => catalog.textProviders.find((p) => p.providerId === providerId)!;
    for (const p of catalog.textProviders) {
      expect(["network_probe", "credential_check", "unavailable"]).toContain(p.connectionTest);
      expect(typeof p["selectable"]).toBe("boolean");
    }
    // Configured text providers are network_probe; unconfigured are unavailable.
    expect(findText("gemini").connectionTest).toBe("network_probe");
    expect(findText("deepseek").connectionTest).toBe("unavailable");
    expect(findText("openrouter").connectionTest).toBe("network_probe");

    const findImage = (providerId: string) => catalog.imageProviders.find((p) => p.providerId === providerId)!;
    expect(findImage("gemini-image").connectionTest).toBe("credential_check");
    expect(findImage("openrouter-image").connectionTest).toBe("credential_check");
    for (const im of catalog.imageProviders) {
      expect(["network_probe", "credential_check", "unavailable"]).toContain(im.connectionTest);
      expect(typeof im["selectable"]).toBe("boolean");
    }
  });

  it("unconfigured providers are NOT selectable; configured curated providers are", async () => {
    const noKeys = await freshCatalog({});
    for (const p of noKeys.catalog.textProviders) expect(p["selectable"]).toBe(false);
    for (const im of noKeys.catalog.imageProviders) expect(im["selectable"]).toBe(false);

    const withKeys = await freshCatalog({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL });
    for (const p of withKeys.catalog.textProviders) {
      expect(p["selectable"]).toBe(p.available && p.models.length > 0);
    }
    const image = byProviderId(withKeys.catalog.imageProviders);
    expect(image["gemini-image"]["selectable"]).toBe(true);
    expect(image["openrouter-image"]["selectable"]).toBe(true);
  });

  it("userSelectionAllowed is TRUE only when the selection is server_default (no valid pin)", async () => {
    const defaultCatalog = await freshCatalog({ GEMINI_API_KEY: SENTINEL });
    expect(defaultCatalog.catalog.selection.userSelectionAllowed).toEqual({ text: true, image: true });

    // A valid server-managed pin blocks user selection for that surface only.
    const pinned = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
    });
    expect(pinned.catalog.selection.userSelectionAllowed).toEqual({ text: false, image: true });

    // An INVALID pin also blocks user selection (fail-closed: user override can
    // never bypass a server pin, even an invalid one).
    const invalidPin = await freshCatalog({ KITCHEN_CODEX_TEXT_PROVIDER: "ghost" });
    expect(invalidPin.catalog.selection.userSelectionAllowed).toEqual({ text: false, image: true });
  });

  it("the selection JSON stays secret-free with the new userSelectionAllowed block", async () => {
    const { catalog } = await freshCatalog({ GEMINI_API_KEY: SENTINEL });
    const json = JSON.stringify(catalog.selection);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain("API_KEY");
    expect(json).toContain("userSelectionAllowed");
  });

  it("exposes RUNTIME executability separately from config-valid `valid`", async () => {
    // Gemini pinned with NO key: config-valid (registered/enabled) but NOT
    // runtime-executable. The two truths are exposed distinctly.
    const noKey = await freshCatalog({ KITCHEN_CODEX_TEXT_PROVIDER: "gemini" });
    expect(noKey.catalog.selection.text).toMatchObject({
      selectionMode: "server_managed",
      selectedProviderId: "gemini",
      valid: true,
    });
    expect(noKey.catalog.selection.executable.text).toBe(false);
    expect(noKey.catalog.selection.executable.image).toBe(false);

    // With the key configured the same pin becomes runtime-executable.
    const withKey = await freshCatalog({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
    });
    expect(withKey.catalog.selection.executable.text).toBe(true);
    expect(withKey.catalog.selection.executable.image).toBe(true);

    // An INVALID pin is neither valid nor executable.
    const invalid = await freshCatalog({ GEMINI_API_KEY: SENTINEL, KITCHEN_CODEX_TEXT_PROVIDER: "ghost" });
    expect(invalid.catalog.selection.text.valid).toBe(false);
    expect(invalid.catalog.selection.executable.text).toBe(false);
  });
});