import { describe, it, expect } from "vitest";
import type { AiCapabilities, AiProvider } from "../../server/ai/types.js";
import {
  resolveRoleCandidates,
  roleModelsForProvider,
  getRegisteredProviders,
  selectCandidates,
  OpenRouterProvider,
  OPENROUTER_STRUCTURED_MODEL,
} from "../../server/ai/provider.js";
import { MODEL_CONFIG } from "../../server/modelConfig.js";
import type { RegisteredProvider } from "../../server/ai/provider.js";

const FULL: AiCapabilities = { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true };
const caps = (o: Partial<AiCapabilities> = {}): AiCapabilities => ({ ...FULL, ...o });

function fakeProvider(id: string, capabilities: AiCapabilities = caps(), available = true): AiProvider {
  return {
    id, name: id, capabilities,
    isAvailable: () => available,
    testConnection: async () => available,
    generate: async () => "",
    generateStructured: async () => ({}) as any,
  };
}

function regs(gem: AiProvider, or: AiProvider): RegisteredProvider[] {
  return [
    { provider: gem, defaultCapabilities: caps(gem.capabilities) },
    { provider: or, defaultCapabilities: caps(or.capabilities) },
  ];
}

describe("resolveRoleCandidates (v0.7 1B)", () => {
  it("preserves Gemini role models for an operation", () => {
    // Nutrition -> Gemini primary + fallback (exact MODEL_CONFIG order).
    expect(roleModelsForProvider("gemini", "nutrition")).toEqual([MODEL_CONFIG.nutritionPrimary, MODEL_CONFIG.nutritionFallback]);
  });

  it("resolves OpenRouter role models for an operation", () => {
    expect(roleModelsForProvider("openrouter", "nutrition")).toEqual([OPENROUTER_STRUCTURED_MODEL]);
  });

  it("resolves ordered candidates across providers (Gemini first)", () => {
    const gem = fakeProvider("gemini", caps());
    const or = fakeProvider("openrouter", caps());
    const cands = resolveRoleCandidates("nutrition", regs(gem, or));
    expect(cands.map((c) => c.provider.id)).toEqual(["gemini", "gemini", "openrouter"]);
    expect(cands[0].model).toBe(MODEL_CONFIG.nutritionPrimary);
    expect(cands[1].model).toBe(MODEL_CONFIG.nutritionFallback);
    expect(cands[2].model).toBe(OPENROUTER_STRUCTURED_MODEL);
  });

  it("skips an unconfigured provider safely (disabled without a key)", () => {
    const reg = getRegisteredProviders();
    const orDesc = reg.find((r) => r.provider.id === "openrouter");
    // With no OPENROUTER_API_KEY set, OpenRouter is disabled -> not resolved.
    expect(orDesc?.enabled).toBe(false);
    const cands = resolveRoleCandidates("nutrition");
    expect(cands.every((c) => c.provider.id !== "openrouter")).toBe(true);
    expect(cands.map((c) => c.model)).toEqual([MODEL_CONFIG.nutritionPrimary, MODEL_CONFIG.nutritionFallback]);
  });

  it("kitchenDiscover selection NEVER admits OpenRouter (webSearch capability gate)", () => {
    const gem = fakeProvider("gemini", caps());
    const or = new OpenRouterProvider();
    const regs2 = [
      { provider: gem, defaultCapabilities: caps(gem.capabilities) },
      { provider: or, defaultCapabilities: caps(or.capabilities), modelCapabilities: { [OPENROUTER_STRUCTURED_MODEL]: { structuredOutput: true } } },
    ];
    const capable = selectCandidates(regs2, resolveRoleCandidates("kitchenDiscover", regs2), ["webSearch"]);
    expect(capable.map((c) => c.provider.id)).toEqual(["gemini", "gemini"]);
    expect(capable.some((c) => c.provider.id === "openrouter")).toBe(false);
  });
});
