import { describe, it, expect, afterEach, vi } from "vitest";
import { DEFAULT_GEMINI_IMAGE_MODEL } from "../../server/ai/geminiImageProvider.js";
import { OPENROUTER_IMAGE_MODELS, OPENROUTER_IMAGE_DEFAULT_MODEL } from "../../server/ai/openRouterImageProvider.js";

type RegistryModule = typeof import("../../server/ai/imageProviderRegistry.js");

const ENV_KEYS = ["OPENROUTER_API_KEY", "GEMINI_API_KEY"] as const;

async function freshRegistry(env: Record<string, string>): Promise<RegistryModule> {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return await import("../../server/ai/imageProviderRegistry.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

describe("image provider registry (BYOK-2 / BYOK-3)", () => {
  it("registers Gemini FIRST + OpenRouter Image SECOND (never the deterministic seam)", async () => {
    const mod = await freshRegistry({});
    const rows = mod.getRegisteredImageProviders();
    expect(rows.length).toBe(2);
    // Order is deterministic: Gemini first preserves zero-config behavior.
    // (Class identity is module-cache-fresh after vi.resetModules; assert by id.)
    expect(rows[0].provider.id).toBe("gemini-image");
    expect(rows[0].provider.name).toBe("Google Gemini Image");
    expect(rows[0].defaultModel).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
    expect(rows[0].enabled).toBe(true);
    expect(rows[1].provider.id).toBe("openrouter-image");
    expect(rows[1].provider.name).toBe("OpenRouter Image");
    expect(rows[1].enabled).toBe(false);
    // Never the deterministic seam in any row.
    for (const row of rows) {
      expect(row.provider.id).not.toBe("deterministic-image");
    }
  });

  it("OpenRouter Image is INERT (enabled:false) unless OPENROUTER_API_KEY is configured", async () => {
    let mod = await freshRegistry({ OPENROUTER_API_KEY: "sk-or-v1-fake-not-placeholder" });
    expect(mod.getRegisteredImageProviders().find((r) => r.provider.id === "openrouter-image")!.enabled).toBe(true);

    mod = await freshRegistry({});
    expect(mod.getRegisteredImageProviders().find((r) => r.provider.id === "openrouter-image")!.enabled).toBe(false);

    mod = await freshRegistry({ OPENROUTER_API_KEY: "" });
    expect(mod.getRegisteredImageProviders().find((r) => r.provider.id === "openrouter-image")!.enabled).toBe(false);
  });

  it("curated image models: OpenRouter exposes its curated list; Gemini falls back to its default", async () => {
    const mod = await freshRegistry({ OPENROUTER_API_KEY: "sk-or-v1-fake-not-placeholder" });
    expect(mod.curatedImageModels(mod.findRegisteredImageProvider("openrouter-image"))).toEqual(new Set(OPENROUTER_IMAGE_MODELS));
    expect(OPENROUTER_IMAGE_MODELS[0]).toBe(OPENROUTER_IMAGE_DEFAULT_MODEL);
    expect(mod.curatedImageModels(mod.findRegisteredImageProvider("gemini-image"))).toEqual(new Set([DEFAULT_GEMINI_IMAGE_MODEL]));
    expect(mod.curatedImageModels(undefined).size).toBe(0);
  });

  it("default pair is the real Gemini provider + its proven default model", async () => {
    const mod = await freshRegistry({});
    const pair = mod.getDefaultImageProviderPair();
    expect(pair.provider.id).toBe("gemini-image");
    expect(pair.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
  });

  it("finds registered image providers by id; unknown ids return undefined safely", async () => {
    const mod = await freshRegistry({});
    expect(mod.findRegisteredImageProvider("gemini-image")?.provider.id).toBe("gemini-image");
    expect(mod.findRegisteredImageProvider("openrouter-image")?.provider.id).toBe("openrouter-image");
    expect(mod.findRegisteredImageProvider("openrouter")?.provider).toBeUndefined();
    expect(mod.findRegisteredImageProvider(undefined)).toBeUndefined();
    expect(mod.getImageProvider("gemini-image")?.id).toBe("gemini-image");
    expect(mod.getImageProvider("openrouter-image")?.id).toBe("openrouter-image");
    expect(mod.getImageProvider("nope")).toBeUndefined();
  });
});