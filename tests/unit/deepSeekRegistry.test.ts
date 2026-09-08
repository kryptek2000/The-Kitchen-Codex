import { describe, it, expect, vi, afterEach } from "vitest";
import type { AiCapabilities, AiProvider } from "../../server/ai/types.js";
import {
  resolveRoleCandidates,
  roleModelsForProvider,
  selectCandidates,
  runWithAiFallback,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  OPENROUTER_STRUCTURED_MODEL,
} from "../../server/ai/provider.js";
import { MODEL_CONFIG } from "../../server/modelConfig.js";
import type { RegisteredProvider, AiCandidate } from "../../server/ai/provider.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";

// Gemini is mocked as always available so registry/selection behavior is deterministic.
vi.mock("../../server/geminiClient.js", () => ({ getGemini: vi.fn(() => ({ models: {} })) }));

const FULL: AiCapabilities = { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true };
const caps = (o: Partial<AiCapabilities> = {}): AiCapabilities => ({ ...FULL, ...o });

function fakeProvider(id: string, capabilities: AiCapabilities = caps(), available = true): AiProvider {
  return {
    id,
    name: id,
    capabilities,
    isAvailable: () => available,
    testConnection: async () => available,
    generate: async () => "",
    generateStructured: async () => ({}) as any,
  };
}

async function freshRegistry(env: Record<string, string>): Promise<RegisteredProvider[]> {
  vi.resetModules();
  for (const k of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
  Object.assign(process.env, env);
  const mod = await import("../../server/ai/provider.js");
  return mod.getRegisteredProviders();
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

describe("provider registry order — Gemini -> OpenRouter -> DeepSeek (v0.7 1C)", () => {
  it("registers Gemini, OpenRouter, DeepSeek in deterministic order (no keys => Gemini-only executable)", async () => {
    const reg = await freshRegistry({});
    expect(reg.map((r) => r.provider.id)).toEqual(["gemini", "openrouter", "deepseek"]);
    expect(reg.find((r) => r.provider.id === "gemini")?.enabled).toBe(true);
    expect(reg.find((r) => r.provider.id === "openrouter")?.enabled).toBe(false); // no key
    expect(reg.find((r) => r.provider.id === "deepseek")?.enabled).toBe(false); // no key
  });

  it("no DeepSeek key => DeepSeek is disabled and behavior is unchanged (Gemini-only)", async () => {
    const reg = await freshRegistry({ OPENROUTER_API_KEY: "" });
    const ds = reg.find((r) => r.provider.id === "deepseek");
    expect(ds?.enabled).toBe(false);
    // Gemini remains the default executor for structured ops.
    const gem = reg.find((r) => r.provider.id === "gemini")!;
    const capable = selectCandidates(reg, resolveRoleCandidates("nutrition", reg), ["structuredOutput"]);
    expect(capable.every((c) => c.provider.id === "gemini")).toBe(true);
    expect(capable.length).toBeGreaterThan(0);
    expect(capable.some((c) => c.provider.id === "deepseek")).toBe(false);
  });

  it("only DeepSeek configured => Gemini first, OpenRouter disabled, DeepSeek enabled fallback", async () => {
    const reg = await freshRegistry({ DEEPSEEK_API_KEY: "sk-ds-test" });
    expect(reg.map((r) => r.provider.id)).toEqual(["gemini", "openrouter", "deepseek"]);
    expect(reg.find((r) => r.provider.id === "gemini")?.enabled).toBe(true);
    expect(reg.find((r) => r.provider.id === "openrouter")?.enabled).toBe(false);
    expect(reg.find((r) => r.provider.id === "deepseek")?.enabled).toBe(true);
  });

  it("both configured => deterministic 3-provider order (all enabled)", async () => {
    const reg = await freshRegistry({ OPENROUTER_API_KEY: "sk-or", DEEPSEEK_API_KEY: "sk-ds" });
    expect(reg.map((r) => r.provider.id)).toEqual(["gemini", "openrouter", "deepseek"]);
    expect(reg.every((r) => r.enabled === true)).toBe(true);
  });
});

describe("role candidate resolution — DeepSeek (v0.7 1C)", () => {
  const BASELINE_FALSE = { reasoning: false, structuredOutput: false, recipeGeneration: false, webSearch: false };
  const regs = (registerDeepSeek = true): RegisteredProvider[] => {
    const gem = fakeProvider("gemini", FULL);
    const or = fakeProvider("openrouter", BASELINE_FALSE);
    const reg: RegisteredProvider[] = [
      { provider: gem, defaultCapabilities: caps(gem.capabilities), enabled: true },
      { provider: or, defaultCapabilities: caps(or.capabilities), modelCapabilities: { [OPENROUTER_STRUCTURED_MODEL]: { structuredOutput: true } }, enabled: true },
    ];
    if (registerDeepSeek) {
      const ds = fakeProvider("deepseek", BASELINE_FALSE);
      reg.push({ provider: ds, defaultCapabilities: caps(ds.capabilities), modelCapabilities: { [DEEPSEEK_FLASH_MODEL]: { reasoning: true } }, enabled: true });
    }
    return reg;
  };

  it("maps DeepSeek role models per operation (flash then pro)", () => {
    for (const op of ["kitchenInterpret", "kitchenRank", "nutrition", "metadataRecovery", "recipeGrabber", "kitchenDiscover"] as const) {
      expect(roleModelsForProvider("deepseek", op)).toEqual([DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL]);
    }
    // Unknown provider -> no models.
    expect(roleModelsForProvider("ghost", "nutrition")).toEqual([]);
  });

  it("resolves ordered candidates across all three providers (Gemini -> OpenRouter -> DeepSeek)", () => {
    const cands = resolveRoleCandidates("nutrition", regs());
    expect(cands.map((c) => c.provider.id)).toEqual(["gemini", "gemini", "openrouter", "deepseek", "deepseek"]);
    expect(cands[0].model).toBe(MODEL_CONFIG.nutritionPrimary);
    expect(cands[1].model).toBe(MODEL_CONFIG.nutritionFallback);
    expect(cands[2].model).toBe(OPENROUTER_STRUCTURED_MODEL);
    expect(cands[3].model).toBe(DEEPSEEK_FLASH_MODEL);
    expect(cands[4].model).toBe(DEEPSEEK_PRO_MODEL);
  });

  it("structured-output selection filters DeepSeek OUT (no schema-constrained support)", () => {
    const capable = selectCandidates(regs(), resolveRoleCandidates("nutrition", regs()), ["structuredOutput"]);
    expect(capable.map((c) => c.provider.id)).toEqual(["gemini", "gemini", "openrouter"]);
    expect(capable.some((c) => c.provider.id === "deepseek")).toBe(false);
  });

  it("kitchenDiscover selection excludes BOTH OpenRouter AND DeepSeek (webSearch gate)", () => {
    const capable = selectCandidates(regs(), resolveRoleCandidates("kitchenDiscover", regs()), ["webSearch"]);
    expect(capable.map((c) => c.provider.id)).toEqual(["gemini", "gemini"]);
    expect(capable.some((c) => c.provider.id === "openrouter" || c.provider.id === "deepseek")).toBe(false);
  });

  it("metadataRecovery and recipeGrabber keep DeepSeek OUT after capability filtering", () => {
    for (const op of ["metadataRecovery", "recipeGrabber"] as const) {
      const capable = selectCandidates(regs(), resolveRoleCandidates(op, regs()), ["structuredOutput"]);
      expect(capable.some((c) => c.provider.id === "deepseek")).toBe(false);
    }
  });
});

describe("cross-provider fallback — Gemini -> OpenRouter -> DeepSeek (v0.7 1C)", () => {
  // Cross-provider fallback uses ALL-capable models so the ENGINE chain can be
  // exercised end-to-end (Gemini -> OpenRouter -> DeepSeek).
  const OR_CAPS = { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: false };
  const DS_CAPS = { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false };
  const gem = () => fakeProvider("gemini", FULL);
  const or = () => fakeProvider("openrouter", OR_CAPS);
  const deepseek = () => fakeProvider("deepseek", DS_CAPS);
  const regs = () => [
    { provider: gem(), defaultCapabilities: caps(FULL) },
    { provider: or(), defaultCapabilities: caps(OR_CAPS) },
    { provider: deepseek(), defaultCapabilities: caps(DS_CAPS) },
  ];

  it("Gemini failure -> OpenRouter success", async () => {
    const called: string[] = [];
    const r = await runWithAiFallback({
      candidates: [
        { provider: gem(), model: "g-m" },
        { provider: or(), model: "or-m" },
        { provider: deepseek(), model: "ds-m" },
      ],
      requiredCapabilities: ["structuredOutput"],
      registry: regs(),
      run: async (c) => {
        called.push(c.provider.id);
        if (c.provider.id === "gemini") throw new ProviderOperationError("QUOTA", "q", { providerId: "gemini", model: "g-m" });
        return `ok:${c.provider.id}`;
      },
    });
    expect(called).toEqual(["gemini", "openrouter"]);
    expect(r.providerId).toBe("openrouter");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].code).toBe("QUOTA");
  });

  it("Gemini failure -> OpenRouter failure -> DeepSeek success (all models capable)", async () => {
    const called: string[] = [];
    const r = await runWithAiFallback({
      candidates: [
        { provider: gem(), model: "g-m" },
        { provider: or(), model: "or-m" },
        { provider: deepseek(), model: "ds-m" },
      ],
      requiredCapabilities: ["structuredOutput"],
      registry: regs(),
      run: async (c) => {
        called.push(c.provider.id);
        if (c.provider.id === "gemini") throw new ProviderOperationError("UNAVAILABLE", "down", { providerId: "gemini", model: "g-m" });
        if (c.provider.id === "openrouter") throw new ProviderOperationError("PROVIDER_ERROR", "boom", { providerId: "openrouter", model: "or-m" });
        return `ok:${c.provider.id}`;
      },
    });
    expect(called).toEqual(["gemini", "openrouter", "deepseek"]);
    expect(r.providerId).toBe("deepseek");
    expect(r.model).toBe("ds-m");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["UNAVAILABLE", "PROVIDER_ERROR"]);
  });

  it("capability-mismatch provider is skipped WITHOUT execution", async () => {
    const incapable = fakeProvider("deepseek", { reasoning: false, structuredOutput: false, recipeGeneration: false, webSearch: false });
    const run = vi.fn(async (c: AiCandidate) => `ok:${c.provider.id}`);
    await expect(
      runWithAiFallback({
        candidates: [{ provider: incapable, model: "ds-m" }],
        requiredCapabilities: ["structuredOutput"],
        registry: [{ provider: incapable, defaultCapabilities: caps({ structuredOutput: false }) }],
        run,
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(run).not.toHaveBeenCalled();
  });

  it("all capable candidates fail -> normalized terminal PROVIDER_ERROR", async () => {
    const run = async (c: AiCandidate) => {
      throw new ProviderOperationError("PROVIDER_ERROR", `failed ${c.provider.id}`, { providerId: c.provider.id, model: c.model });
    };
    await expect(
      runWithAiFallback({
        candidates: [{ provider: gem(), model: "g-m" }, { provider: or(), model: "or-m" }, { provider: deepseek(), model: "ds-m" }],
        requiredCapabilities: [],
        registry: regs(),
        run,
      })
    ).rejects.toMatchObject({ name: "ProviderOperationError", code: "PROVIDER_ERROR" });
  });
});
