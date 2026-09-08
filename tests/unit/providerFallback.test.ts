import { describe, it, expect, vi } from "vitest";
import type { AiCapabilities, AiProvider } from "../../server/ai/types.js";
import { runWithAiFallback, selectCandidates } from "../../server/ai/provider.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";
import type { RegisteredProvider, AiCandidate } from "../../server/ai/provider.js";

const FULL: AiCapabilities = { reasoning: true, structuredOutput: true, recipeGeneration: true, webSearch: true };
const caps = (o: Partial<AiCapabilities> = {}): AiCapabilities => ({ ...FULL, ...o });

function fakeProvider(id: string, overrides: Partial<AiCapabilities> = {}, available = true): AiProvider {
  return {
    id,
    name: id,
    capabilities: caps(overrides),
    isAvailable: () => available,
    testConnection: async () => available,
    generate: async () => "",
    generateStructured: async () => ({}) as any,
  };
}

function regs(...descs: Array<{ provider: AiProvider; modelCapabilities?: RegisteredProvider["modelCapabilities"] }>): RegisteredProvider[] {
  return descs.map((d) => ({ provider: d.provider, defaultCapabilities: caps(d.provider.capabilities), ...(d.modelCapabilities ? { modelCapabilities: d.modelCapabilities } : {}) }));
}

describe("provider fallback policy (v0.7 1A)", () => {
  it("returns the first successful candidate, preserving order", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "m1" }, { provider: b, model: "m2" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      run: async (c) => `ok:${c.provider.id}:${c.model}`,
    });
    expect(r.result).toBe("ok:a:m1");
    expect(r.providerId).toBe("a");
    expect(r.model).toBe("m1");
    expect(r.diagnostics).toEqual([]);
  });

  const fallbackEligibleCases: Array<[string, string]> = [
    ["QUOTA", "quota"],
    ["RATE_LIMIT", "rate limit"],
    ["UNAVAILABLE", "unavailable"],
    ["TIMEOUT", "timeout"],
    ["INVALID_RESPONSE", "invalid"],
    ["PROVIDER_ERROR", "boom"],
  ];

  it.each(fallbackEligibleCases)("falls back from %s to the next capable provider", async (code, msg) => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "m1" }, { provider: b, model: "m2" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      run: async (c) => {
        if (c.provider.id === "a") throw new ProviderOperationError(code as any, msg, { providerId: "a", model: "m1" });
        return `ok:${c.model}`;
      },
    });
    expect(r.result).toBe("ok:m2");
    expect(r.providerId).toBe("b");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].code).toBe(code);
  });

  it("AUTH falls back only when a DIFFERENT provider remains and allowAuthFallback is set", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const run = async (c: AiCandidate) => {
      if (c.provider.id === "a") throw new ProviderOperationError("AUTH", "unauthorized", { providerId: "a", model: "m1" });
      return `ok:${c.model}`;
    };
    // default (allowAuthFallback not set): AUTH is terminal, m2 not run.
    await expect(
      runWithAiFallback({ candidates: [{ provider: a, model: "m1" }, { provider: b, model: "m2" }], requiredCapabilities: ["structuredOutput"], registry: regs({ provider: a }, { provider: b }), run })
    ).rejects.toMatchObject({ code: "AUTH", providerId: "a" });
    // allowAuthFallback true: AUTH falls back to a DIFFERENT provider.
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "m1" }, { provider: b, model: "m2" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      run,
      allowAuthFallback: true,
    });
    expect(r.result).toBe("ok:m2");
    expect(r.providerId).toBe("b");
    expect(r.diagnostics[0].code).toBe("AUTH"); // primary AUTH failure remains visible
  });

  it("never executes a candidate that lacks the required capability (UNSUPPORTED_CAPABILITY)", async () => {
    const a = fakeProvider("a", { structuredOutput: false });
    const run = vi.fn(async () => "ok");
    // Candidate 'a' lacks structuredOutput -> filtered out; no capable candidates exist.
    await expect(
      runWithAiFallback({ candidates: [{ provider: a, model: "m1" }], requiredCapabilities: ["structuredOutput"], registry: regs({ provider: a }), run })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(run).not.toHaveBeenCalled();
  });

  it("skips a disabled/unavailable candidate before execution", async () => {
    const a = fakeProvider("a");
    const down = fakeProvider("down");
    const b = fakeProvider("b");
    const run = vi.fn(async (c: AiCandidate) => `ok:${c.provider.id}`);
    const registry: RegisteredProvider[] = [
      { provider: a, defaultCapabilities: caps() },
      { provider: down, defaultCapabilities: caps(), enabled: false },
      { provider: b, defaultCapabilities: caps() },
    ];
    const out = selectCandidates(registry, [{ provider: a, model: "m" }, { provider: down, model: "m" }, { provider: b, model: "m" }], []);
    expect(out.map((c) => c.provider.id)).toEqual(["a", "b"]);
    const r = await runWithAiFallback({ candidates: [{ provider: down, model: "m" }, { provider: a, model: "m" }], requiredCapabilities: [], registry, run });
    expect(r.result).toBe("ok:a");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("throws a normalized terminal error when all capable candidates fail", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const run = async (c: AiCandidate) => {
      throw new ProviderOperationError("PROVIDER_ERROR", `failed ${c.model}`, { providerId: c.provider.id, model: c.model });
    };
    await expect(
      runWithAiFallback({ candidates: [{ provider: a, model: "m1" }, { provider: b, model: "m2" }], requiredCapabilities: [], registry: regs({ provider: a }, { provider: b }), run })
    ).rejects.toMatchObject({ name: "ProviderOperationError", code: "PROVIDER_ERROR" });
  });
});
