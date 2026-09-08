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

describe("cross-provider fallback (Gemini -> OpenRouter), v0.7 1B", () => {
  const gem = () => fakeProvider("gemini");
  const or = () => fakeProvider("openrouter");

  it("falls back Gemini -> OpenRouter on a fallback-eligible error", async () => {
    const g = gem();
    const o = or();
    const called: string[] = [];
    const r = await runWithAiFallback({
      candidates: [{ provider: g, model: "g-m" }, { provider: o, model: "or-m" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: g }, { provider: o }),
      run: async (c) => {
        called.push(c.provider.id);
        if (c.provider.id === "gemini") throw new ProviderOperationError("QUOTA", "quota", { providerId: "gemini", model: "g-m" });
        return `ok:${c.provider.id}`;
      },
    });
    expect(called).toEqual(["gemini", "openrouter"]);
    expect(r.result).toBe("ok:openrouter");
    expect(r.providerId).toBe("openrouter");
    expect(r.diagnostics[0].code).toBe("QUOTA");
  });

  it("AUTH does NOT fall back by default (a bad primary key is not silently masked)", async () => {
    const g = gem();
    const o = or();
    const run = vi.fn(async (c: AiCandidate) => {
      if (c.provider.id === "gemini") throw new ProviderOperationError("AUTH", "unauthorized", { providerId: "gemini", model: "g-m" });
      return `ok:${c.provider.id}`;
    });
    await expect(
      runWithAiFallback({ candidates: [{ provider: g, model: "g-m" }, { provider: o, model: "or-m" }], requiredCapabilities: ["structuredOutput"], registry: regs({ provider: g }, { provider: o }), run })
    ).rejects.toMatchObject({ code: "AUTH", providerId: "gemini" });
    expect(run).toHaveBeenCalledTimes(1); // openrouter never ran
  });

  it("AUTH fallback Gemini -> OpenRouter is permitted explicitly and the primary AUTH stays in diagnostics", async () => {
    const g = gem();
    const o = or();
    const r = await runWithAiFallback({
      candidates: [{ provider: g, model: "g-m" }, { provider: o, model: "or-m" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: g }, { provider: o }),
      allowAuthFallback: true,
      run: async (c) => {
        if (c.provider.id === "gemini") throw new ProviderOperationError("AUTH", "unauthorized", { providerId: "gemini", model: "g-m" });
        return `ok:${c.provider.id}`;
      },
    });
    expect(r.providerId).toBe("openrouter");
    // The primary Gemini AUTH failure MUST remain visible in diagnostics.
    expect(r.diagnostics).toEqual([expect.objectContaining({ code: "AUTH", providerId: "gemini" })]);
  });

  it("skips an OpenRouter model that lacks the required capability (never executed)", async () => {
    const g = gem();
    const weak = fakeProvider("openrouter", { structuredOutput: false });
    const run = vi.fn(async (c: AiCandidate) => {
      if (c.provider.id === "gemini") throw new ProviderOperationError("QUOTA", "q", { providerId: "gemini", model: "g-m" });
      return `ok:${c.provider.id}`;
    });
    await expect(
      runWithAiFallback({
        candidates: [{ provider: g, model: "g-m" }, { provider: weak, model: "weak-m" }],
        requiredCapabilities: ["structuredOutput"],
        registry: regs({ provider: g }, { provider: weak }),
        run,
      })
    ).rejects.toMatchObject({ code: "QUOTA" });
    // Weak openrouter (no structuredOutput) filtered out; only gemini ran.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].provider.id).toBe("gemini");
  });
});

describe("same-model transient retry (v0.7 1C) — opt-in via FallbackRetryPolicy", () => {
  it("retries the SAME candidate once (RATE_LIMIT then success), retains the first diagnostic", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const called: string[] = [];
    let delayCalls = 0;
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "m1" }, { provider: b, model: "m2" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      retry: { maxAttemptsPerCandidate: 2, backoffMs: 600, retryableCodes: ["RATE_LIMIT"], sleep: async () => { delayCalls++; } },
      run: async (c) => {
        called.push(c.model);
        if (called.length === 1) throw new ProviderOperationError("RATE_LIMIT", "rl", { providerId: "a", model: "m1" });
        return `ok:${c.model}`;
      },
    });
    expect(called).toEqual(["m1", "m1"]); // same candidate retried
    expect(delayCalls).toBe(1); // one backoff
    expect(r.providerId).toBe("a");
    expect(r.model).toBe("m1");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].code).toBe("RATE_LIMIT"); // attempt 1 retained
  });

  it("retries candidate A then moves to candidate B on exhaustion (exact order A,A,B)", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const called: string[] = [];
    let delayCalls = 0;
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "mA" }, { provider: b, model: "mB" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      retry: { maxAttemptsPerCandidate: 2, backoffMs: 600, retryableCodes: ["UNAVAILABLE"], sleep: async () => { delayCalls++; } },
      run: async (c) => {
        called.push(c.model);
        if (c.provider.id === "a") throw new ProviderOperationError("UNAVAILABLE", "x", { providerId: "a", model: c.model });
        return "ok:" + c.model;
      },
    });
    expect(called).toEqual(["mA", "mA", "mB"]);
    expect(delayCalls).toBe(1); // delay only for A's retry, not B
    expect(r.providerId).toBe("b");
    expect(r.diagnostics).toHaveLength(2); // A failed twice
    expect(r.diagnostics.map((d) => d.code)).toEqual(["UNAVAILABLE", "UNAVAILABLE"]);
  });

  it("AUTH is NEVER same-model retried (default: terminal, single attempt)", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const run = vi.fn(async (c: AiCandidate) => {
      if (c.provider.id === "a") throw new ProviderOperationError("AUTH", "unauthorized", { providerId: "a", model: c.model });
      return `ok:${c.provider.id}`;
    });
    await expect(
      runWithAiFallback({
        candidates: [{ provider: a, model: "mA" }, { provider: b, model: "mB" }],
        requiredCapabilities: ["structuredOutput"],
        registry: regs({ provider: a }, { provider: b }),
        retry: { maxAttemptsPerCandidate: 2, backoffMs: 600, retryableCodes: ["AUTH", "RATE_LIMIT"], sleep: async () => { throw new Error("must not sleep"); } },
        run,
      })
    ).rejects.toMatchObject({ code: "AUTH", providerId: "a" });
    expect(run).toHaveBeenCalledTimes(1); // no same-model auth retry
  });

  it("AUTH falls back to a different provider only when allowed; the primary AUTH stays in diagnostics", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const run = vi.fn(async (c: AiCandidate) => {
      if (c.provider.id === "a") throw new ProviderOperationError("AUTH", "unauthorized", { providerId: "a", model: c.model });
      return `ok:${c.provider.id}`;
    });
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "mA" }, { provider: b, model: "mB" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      allowAuthFallback: true,
      retry: { maxAttemptsPerCandidate: 2, backoffMs: 600, retryableCodes: ["AUTH"], sleep: async () => { throw new Error("must not sleep"); } },
      run,
    });
    expect(r.providerId).toBe("b");
    expect(run).toHaveBeenCalledTimes(2); // a once (auth, no retry) then b
    expect(r.diagnostics).toEqual([expect.objectContaining({ code: "AUTH", providerId: "a" })]);
  });

  it("QUOTA is NOT same-model retried (single attempt) but still falls back to the next provider", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    const called: string[] = [];
    let delayCalls = 0;
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "mA" }, { provider: b, model: "mB" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      retry: { maxAttemptsPerCandidate: 2, backoffMs: 600, retryableCodes: ["RATE_LIMIT", "UNAVAILABLE"], sleep: async () => { delayCalls++; } },
      run: async (c) => {
        called.push(c.model);
        if (c.provider.id === "a") throw new ProviderOperationError("QUOTA", "quota", { providerId: "a", model: c.model });
        return "ok:" + c.model;
      },
    });
    expect(called).toEqual(["mA", "mB"]); // a attempted ONCE (no retry)
    expect(delayCalls).toBe(0); // no same-model delay for quota
    expect(r.providerId).toBe("b");
  });

  it("UNSUPPORTED_CAPABILITY is never executed or retried regardless of retry policy", async () => {
    const incapable = fakeProvider("a", { structuredOutput: false });
    const run = vi.fn(async () => "ok");
    await expect(
      runWithAiFallback({
        candidates: [{ provider: incapable, model: "m1" }],
        requiredCapabilities: ["structuredOutput"],
        registry: regs({ provider: incapable }),
        retry: { maxAttemptsPerCandidate: 2, backoffMs: 600, retryableCodes: ["RATE_LIMIT"], sleep: async () => { throw new Error("must not sleep"); } },
        run,
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(run).not.toHaveBeenCalled();
  });

  it("default (no retry policy) is exactly ONE attempt per candidate", async () => {
    const a = fakeProvider("a");
    const run = vi.fn(async (c: AiCandidate) => {
      throw new ProviderOperationError("RATE_LIMIT", "rl", { providerId: c.provider.id, model: c.model });
    });
    await expect(
      runWithAiFallback({
        candidates: [{ provider: a, model: "m1" }],
        requiredCapabilities: ["structuredOutput"],
        registry: regs({ provider: a }),
        run,
      })
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(run).toHaveBeenCalledTimes(1); // no retry
  });

  it("invokes the injected sleep seam with backoffMs (no real wait)", async () => {
    const a = fakeProvider("a");
    const b = fakeProvider("b");
    let seenMs = -1;
    let calls = 0;
    const r = await runWithAiFallback({
      candidates: [{ provider: a, model: "mA" }, { provider: b, model: "mB" }],
      requiredCapabilities: ["structuredOutput"],
      registry: regs({ provider: a }, { provider: b }),
      retry: { maxAttemptsPerCandidate: 2, backoffMs: 600, retryableCodes: ["RATE_LIMIT"], sleep: async (ms) => { seenMs = ms; } },
      run: async (c) => {
        calls++;
        if (calls === 1) throw new ProviderOperationError("RATE_LIMIT", "rl", { providerId: "a", model: c.model });
        return "ok:" + c.model;
      },
    });
    expect(seenMs).toBe(600);
    expect(r.providerId).toBe("a");
  });
});
