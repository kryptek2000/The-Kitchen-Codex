import { describe, it, expect, vi } from "vitest";
import type { AiCapabilities, AiProvider } from "../../server/ai/types.js";
import {
  GeminiProvider,
  OpenRouterProvider,
  OPENROUTER_MODEL_CAPABILITIES,
  OPENROUTER_STRUCTURED_MODEL,
  getRegisteredProviders,
  getAiProvider,
  getDefaultAiProvider,
  selectCandidates,
  selectAiCandidates,
  effectiveCapabilities,
  hasAllCapabilities,
} from "../../server/ai/provider.js";
import type { RegisteredProvider, AiCandidate } from "../../server/ai/provider.js";

// Simulate a configured Gemini key so the real Gemini provider reports available.
vi.mock("../../server/geminiClient.js", () => ({ getGemini: vi.fn(() => ({ models: {} })) }));

// --- fakes -----------------------------------------------------------------

const FULL: AiCapabilities = { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true };
const caps = (overrides: Partial<AiCapabilities> = {}): AiCapabilities => ({ ...FULL, ...overrides });

function fakeProvider(id: string, capabilities: AiCapabilities, available = true): AiProvider {
  const provider: AiProvider = {
    id,
    name: id,
    capabilities,
    isAvailable: () => available,
    testConnection: async () => available,
    generate: async () => "",
    generateStructured: async () => ({}) as any,
  };
  return provider;
}

function descriptors(...descs: Array<Omit<RegisteredProvider, "provider"> & { provider: AiProvider }>): RegisteredProvider[] {
  return descs.map((d) => ({ ...d }));
}

const candidate = (provider: AiProvider, model = "m"): AiCandidate => ({ provider, model });

describe("provider registry + capability selection (v0.7 1A)", () => {
  it("registers Gemini as the default provider (zero-config compatibility)", () => {
    const reg = getRegisteredProviders();
    // Gemini + OpenRouter are registered; provider ORDER is the selection order.
    expect(reg).toHaveLength(2);
    expect(reg[0].provider).toBeInstanceOf(GeminiProvider);
    expect(reg[1].provider.id).toBe("openrouter");
    expect(getDefaultAiProvider()).toBe(reg[0].provider);
    expect(getAiProvider("gemini")).toBeInstanceOf(GeminiProvider);
    expect(getAiProvider("openrouter")).toBeDefined();
  });

  it("a per-model override can WIDEN a capability for a specific model", () => {
    const reg = { provider: fakeProvider("or", caps({ structuredOutput: false })), defaultCapabilities: caps({ structuredOutput: false }), modelCapabilities: { "or/strong": { structuredOutput: true } } };
    expect(effectiveCapabilities(reg, "or/strong").structuredOutput).toBe(true); // widened
    expect(effectiveCapabilities(reg, "or/unknown").structuredOutput).toBe(false); // baseline (not overclaimed)
  });

  it("provider levels default capability from truth are authoritative", () => {
    expect(effectiveCapabilities({ provider: fakeProvider("g", caps()), defaultCapabilities: caps() }, "m")).toEqual(FULL);
  });

  it("a per-model override narrows (does not widen) effective capabilities", () => {
    const reg = { provider: fakeProvider("g", caps()), defaultCapabilities: caps(), modelCapabilities: { "lite": { webSearch: false } } };
    expect(effectiveCapabilities(reg, "pro").webSearch).toBe(true); // unaffected model keeps default
    expect(effectiveCapabilities(reg, "lite").webSearch).toBe(false); // narrowed
    expect(effectiveCapabilities(reg, "lite")).toEqual({ ...FULL, webSearch: false });
  });

  it("hasAllCapabilities requires every capability", () => {
    expect(hasAllCapabilities(caps(), ["structuredOutput", "webSearch"])).toBe(true);
    expect(hasAllCapabilities(caps({ webSearch: false }), ["webSearch"])).toBe(false);
  });

  it("selection preserves configured provider order", () => {
    const a = fakeProvider("a", caps());
    const b = fakeProvider("b", caps());
    const regs = descriptors({ provider: a, defaultCapabilities: caps() }, { provider: b, defaultCapabilities: caps() });
    const out = selectCandidates(regs, [candidate(a, "m1"), candidate(b, "m2")], []);
    expect(out.map((c) => c.provider.id)).toEqual(["a", "b"]);
  });

  it("skips unknown providers safely", () => {
    const a = fakeProvider("a", caps());
    const ghost = fakeProvider("ghost", caps());
    const regs = descriptors({ provider: a, defaultCapabilities: caps() });
    const out = selectCandidates(regs, [candidate(a), candidate(ghost)], []);
    expect(out).toHaveLength(1);
    expect(out[0].provider.id).toBe("a");
  });

  it("skips disabled providers", () => {
    const a = fakeProvider("a", caps());
    const b = fakeProvider("b", caps());
    const regs = descriptors({ provider: a, defaultCapabilities: caps(), enabled: true }, { provider: b, defaultCapabilities: caps(), enabled: false });
    const out = selectCandidates(regs, [candidate(a), candidate(b)], []);
    expect(out.map((c) => c.provider.id)).toEqual(["a"]);
  });

  it("skips unavailable providers", () => {
    const a = fakeProvider("a", caps(), true);
    const b = fakeProvider("b", caps(), false);
    const regs = descriptors({ provider: a, defaultCapabilities: caps() }, { provider: b, defaultCapabilities: caps() });
    const out = selectCandidates(regs, [candidate(a), candidate(b)], []);
    expect(out.map((c) => c.provider.id)).toEqual(["a"]);
  });

  it("enforces required capability (model lacking it is never selected)", () => {
    const a = fakeProvider("a", caps({ structuredOutput: false }));
    const b = fakeProvider("b", caps({ structuredOutput: true }));
    const regs = descriptors({ provider: a, defaultCapabilities: caps({ structuredOutput: false }) }, { provider: b, defaultCapabilities: caps({ structuredOutput: true }) });
    const out = selectCandidates(regs, [candidate(a), candidate(b)], ["structuredOutput"]);
    expect(out.map((c) => c.provider.id)).toEqual(["b"]);
  });

  it("an unknown model does not magically gain capabilities", () => {
    const a = fakeProvider("a", caps());
    const regs = descriptors({ provider: a, defaultCapabilities: caps(), modelCapabilities: { "known": { webSearch: false } } });
    // model "unknown" uses provider defaults (all caps) => webSearch true
    expect(hasAllCapabilities(effectiveCapabilities(regs[0], "unknown"), ["webSearch"])).toBe(true);
  });

  it("a candidate model that lacks a required capability is skipped even if provider default has it", () => {
    const a = fakeProvider("a", caps());
    const regs = descriptors({ provider: a, defaultCapabilities: caps(), modelCapabilities: { "lite": { webSearch: false } } });
    const out = selectCandidates(regs, [candidate(a, "pro"), candidate(a, "lite")], ["webSearch"]);
    expect(out.map((c) => c.model)).toEqual(["pro"]);
  });

  it("zero-config: Gemini is selected for structuredOutput and webSearch when configured", () => {
    const provider = getDefaultAiProvider();
    expect(provider.isAvailable()).toBe(true);
    expect(selectAiCandidates([candidate(provider, "gemini-3.7-flash")], ["structuredOutput"])).toHaveLength(1);
    expect(selectAiCandidates([candidate(provider, "gemini-3.7-flash")], ["webSearch"])).toHaveLength(1);
  });

  it("provider descriptors carry NO raw secrets or baseUrl (server config is capability-only)", () => {
    const regs = getRegisteredProviders();
    for (const r of regs) {
      expect(JSON.stringify(r)).not.toMatch(/GEMINI_API_KEY|OPENROUTER_API_KEY|AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9_-]{6,}|baseUrl|apiKey|apikey|secret|Bearer|http:\/\/|https:\/\//);
    }
  });

  it("OpenRouter baseline is conservative (unknown models claim nothing)", () => {
    const or = new OpenRouterProvider();
    expect(or.capabilities).toEqual({ reasoning: false, structuredOutput: false, recipeGeneration: false, webSearch: false });
  });

  it("OpenRouter curated structured-capable model is selected for structuredOutput; unknown model is not", () => {
    const or = new OpenRouterProvider();
    const reg = { provider: or, defaultCapabilities: { ...or.capabilities }, modelCapabilities: OPENROUTER_MODEL_CAPABILITIES };
    // curated model: structuredOutput true
    expect(hasAllCapabilities(effectiveCapabilities(reg, OPENROUTER_STRUCTURED_MODEL), ["structuredOutput"])).toBe(true);
    // unknown model: baseline (false) -> cannot overclaim
    expect(hasAllCapabilities(effectiveCapabilities(reg, "unknown/unknown-model"), ["structuredOutput"])).toBe(false);
  });

  it("webSearch selection NEVER admits an OpenRouter candidate (any model)", () => {
    const or = new OpenRouterProvider();
    const regs = [{ provider: or, defaultCapabilities: { ...or.capabilities }, modelCapabilities: OPENROUTER_MODEL_CAPABILITIES }];
    // Even the curated structured model has webSearch:false.
    const out = selectCandidates(regs, [{ provider: or, model: OPENROUTER_STRUCTURED_MODEL }], ["webSearch"]);
    expect(out).toHaveLength(0);
  });
});
