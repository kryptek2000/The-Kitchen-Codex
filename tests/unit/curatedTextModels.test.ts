import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * BYOK-4 AUDIT CORRECTION — single curated-text-model truth.
 *
 * `curatedTextModels(providerId)` derives the union from AI_OPERATIONS +
 * roleModelsForProvider(). This regression asserts the SAME set is used by all
 * four consumers:
 *   1. provider catalog,
 *   2. connection-test allowlist,
 *   3. user-selection validation,
 *   4. server-managed pin validation.
 */

const SENTINEL = "SUPER_SECRET_BYOK4_MODELTRUTH";
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
] as const;

const PROVIDERS = ["gemini", "openrouter", "deepseek"] as const;

async function fresh() {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  // All keys configured so every provider is enabled + runtime-available, which
  // is required for the user-selection validator to honor a selection.
  process.env.GEMINI_API_KEY = SENTINEL;
  process.env.OPENROUTER_API_KEY = SENTINEL;
  process.env.DEEPSEEK_API_KEY = SENTINEL;
  const roleModels = await import("../../server/ai/roleModels.js");
  const catalogMod = await import("../../server/ai/providerCatalog.js");
  const connectionTest = await import("../../server/ai/connectionTest.js");
  const effectiveSelection = await import("../../server/ai/effectiveSelection.js");
  const providerSelection = await import("../../server/ai/providerSelection.js");
  const registry = await import("../../server/ai/providerRegistry.js");
  return { roleModels, catalogMod, connectionTest, effectiveSelection, providerSelection, registry };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

describe("BYOK-4 audit — curatedTextModels is the ONE shared text-model truth", () => {
  it("catalog === connection-test allowlist === user-selection allowlist === server-pin allowlist", async () => {
    const {
      roleModels,
      catalogMod,
      connectionTest,
      effectiveSelection,
      providerSelection,
      registry,
    } = await fresh();

    const catalog = catalogMod.buildProviderCatalog();
    const regs = registry.getRegisteredProviders();

    for (const providerId of PROVIDERS) {
      // v0.8.0: `selectableTextModels` is the single shared truth. For non-
      // OpenRouter providers it equals the curated role set; for OpenRouter it is
      // curated + the SERVER-OWNED normalized dynamic catalog (never client ids).
      const expected = roleModels.selectableTextModels(providerId);
      expect(expected.length).toBeGreaterThan(0);

      // 1. Provider catalog.
      const catalogRow = catalog.textProviders.find((p) => p.providerId === providerId)!;
      expect(catalogRow.models.map((m) => m.id)).toEqual(expected);

      // 2. Connection-test allowlist.
      expect(connectionTest.curatedConnectionTestModels(providerId, "text")).toEqual(expected);

      // 3. User-selection validation: every curated model resolves; an
      //    uncurated model fails closed.
      for (const modelId of expected) {
        expect(effectiveSelection.validateUserTextSelection({ providerId, modelId }, regs)).toEqual({
          providerId,
          modelId,
        });
      }
      expect(
        effectiveSelection.validateUserTextSelection(
          { providerId, modelId: "definitely-not-a-curated-model" },
          regs
        )
      ).toBeNull();

      // 4. Server-managed pin validation: every curated model is a valid pin; an
      //    uncurated model is truthfully invalid.
      process.env.KITCHEN_CODEX_TEXT_PROVIDER = providerId;
      process.env.KITCHEN_CODEX_TEXT_MODEL = expected[0];
      expect(providerSelection.getTextSelection().valid).toBe(true);
      process.env.KITCHEN_CODEX_TEXT_MODEL = "definitely-not-a-curated-model";
      expect(providerSelection.getTextSelection().valid).toBe(false);
      delete process.env.KITCHEN_CODEX_TEXT_MODEL;
    }
  });

  it("unknown providers yield an EMPTY curated set in all four consumers (fail closed)", async () => {
    const { roleModels, catalogMod, connectionTest, effectiveSelection, providerSelection, registry } =
      await fresh();
    expect(roleModels.curatedTextModels("ghost")).toEqual([]);

    const catalog = catalogMod.buildProviderCatalog();
    expect(catalog.textProviders.find((p) => p.providerId === "ghost")).toBeUndefined();
    expect(connectionTest.curatedConnectionTestModels("ghost", "text")).toEqual([]);
    expect(
      effectiveSelection.validateUserTextSelection(
        { providerId: "ghost", modelId: "whatever" },
        registry.getRegisteredProviders()
      )
    ).toBeNull();
    process.env.KITCHEN_CODEX_TEXT_PROVIDER = "ghost";
    expect(providerSelection.getTextSelection().valid).toBe(false);
  });

  it("never leaks a secret through curatedTextModels", async () => {
    const { roleModels } = await fresh();
    const serialized = JSON.stringify(PROVIDERS.map((p) => roleModels.curatedTextModels(p)));
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("API_KEY");
  });
});
