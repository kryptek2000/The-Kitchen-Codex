/**
 * Phase 9B-P1 — Gemini thinking-level compatibility policy tests.
 *
 * These are the tests that would FAIL if the compatibility decision were
 * removed, hard-coded, moved into a caller, or made non-model-aware. Every
 * assertion below is written to be mutation-sensitive on purpose.
 *
 * Root cause being locked down (Phase 9B-2C controlled real-provider smoke):
 *   primary  `gemini-3.7-flash` + `thinkingLevel: MINIMAL` -> HTTP 400
 *   fallback `gemini-3.1-flash-lite` + `MINIMAL`           -> SUCCESS
 *
 * NO live provider is contacted by this file.
 */

import { describe, expect, it } from "vitest";
import {
  GEMINI_THINKING_PROVIDER_ID,
  resolveThinkingProviderOptions,
} from "../../server/ai/thinkingPolicy.js";

const PRIMARY = "gemini-3.7-flash";
const PRIMARY_REPLACEMENT = "gemini-3.8-flash";
const FALLBACK = "gemini-3.1-flash-lite";

/** Reads the effective thinking level, or undefined when the option is omitted. */
function levelOf(providerId: string, model: string, desired?: "MINIMAL" | "LOW"): string | undefined {
  const opts = resolveThinkingProviderOptions(providerId, model, desired);
  const cfg = opts["thinkingConfig"] as { thinkingLevel?: unknown } | undefined;
  return typeof cfg?.thinkingLevel === "string" ? cfg.thinkingLevel : undefined;
}

describe("9B-P1 — the compatibility decision is provider-scoped", () => {
  it("exposes Gemini as the single thinking-aware provider id", () => {
    expect(GEMINI_THINKING_PROVIDER_ID).toBe("gemini");
  });

  it("NEVER attaches thinkingConfig to a non-Gemini provider, even for a Gemini model id", () => {
    // A different provider can legitimately expose a model with the same name.
    // Provider isolation is checked FIRST, so the Gemini fragment cannot leak.
    for (const providerId of ["openrouter", "deepseek", "gemini-image", "", "GEMINI", "gemini "]) {
      expect(levelOf(providerId, PRIMARY)).toBeUndefined();
      expect(resolveThinkingProviderOptions(providerId, PRIMARY)).toEqual({});
    }
  });

  it("does not treat a near-miss provider id as Gemini", () => {
    expect(levelOf("gemini-preview", PRIMARY)).toBeUndefined();
    expect(levelOf("googlegemini", PRIMARY)).toBeUndefined();
  });
});

describe("9B-P1 — 3.7 Flash (the confirmed-broken primary)", () => {
  it("never receives MINIMAL — the exact defect the smoke proved", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY, "MINIMAL")).not.toBe("MINIMAL");
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY)).not.toBe("MINIMAL");
  });

  it("receives the supported LOW level when MINIMAL is requested", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY, "MINIMAL")).toBe("LOW");
  });

  it("receives the supported LOW level when LOW is requested", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY, "LOW")).toBe("LOW");
  });

  it("defaults (no explicit desire) to a supported level, never MINIMAL", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY)).toBe("LOW");
  });

  it("produces a well-formed providerOptions object", () => {
    expect(resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, PRIMARY, "MINIMAL")).toEqual({
      thinkingConfig: { thinkingLevel: "LOW" },
    });
  });

  it("would have reproduced the provider 400 under the old hard-coded behavior", () => {
    // Guard-rail: if the policy ever started emitting MINIMAL for this model,
    // this is the exact wire the provider rejects.
    const emitted = resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, PRIMARY, "MINIMAL");
    expect(JSON.stringify(emitted)).not.toContain("MINIMAL");
  });
});

describe("9B-P1 — 3.8 Flash (documented as routed replacement, same limitation)", () => {
  it("is covered by the same incompatibility rule", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY_REPLACEMENT, "MINIMAL")).toBe("LOW");
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY_REPLACEMENT)).not.toBe("MINIMAL");
  });

  it("still accepts an explicit LOW unchanged", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, PRIMARY_REPLACEMENT, "LOW")).toBe("LOW");
  });
});

describe("9B-P1 — 3.1 Flash-Lite (the working fallback) keeps its supported config", () => {
  it("retains MINIMAL when MINIMAL is requested", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, FALLBACK, "MINIMAL")).toBe("MINIMAL");
  });

  it("retains MINIMAL under the default desire too", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, FALLBACK)).toBe("MINIMAL");
  });

  it("passes an explicit LOW through unchanged", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, FALLBACK, "LOW")).toBe("LOW");
  });

  it("emits the exact previously-hard-coded fragment (no behavior change for fallback)", () => {
    expect(resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, FALLBACK)).toEqual({
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    });
  });
});

describe("9B-P1 — unknown models omit rather than guess", () => {
  const UNKNOWN = [
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-3.7-flash-preview",
    "gemini-3.7-flash-lite",
    "gpt-4o-mini",
    "",
    "   ",
    "gemini-3.7-flash ",
  ];

  it("omits the explicit thinking option entirely", () => {
    for (const model of UNKNOWN) {
      expect(resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, model, "MINIMAL")).toEqual({});
      expect(levelOf(GEMINI_THINKING_PROVIDER_ID, model, "MINIMAL")).toBeUndefined();
    }
  });

  it("does not guess LOW for an unknown model either", () => {
    for (const model of UNKNOWN) {
      expect(levelOf(GEMINI_THINKING_PROVIDER_ID, model)).toBeUndefined();
    }
  });

  it("does not match by prefix, suffix or substring", () => {
    // A model id that merely CONTAINS or is CONTAINED BY a known id is unknown.
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, "gemini-3.7-flash-preview")).toBeUndefined();
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, "x-gemini-3.1-flash-lite")).toBeUndefined();
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, "google/gemini-3.1-flash-lite")).toBeUndefined();
  });

  it("still resolves the exact known ids", () => {
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, "gemini-3.7-flash")).toBe("LOW");
    expect(levelOf(GEMINI_THINKING_PROVIDER_ID, "gemini-3.1-flash-lite")).toBe("MINIMAL");
  });
});

describe("9B-P1 — only the two allowlisted levels are honoured", () => {
  it("omits the option for any other requested level rather than passing it through", () => {
    // `undefined` is deliberately absent: it triggers the documented `MINIMAL`
    // default and is covered by the Flash-Lite default tests above.
    for (const desired of ["MEDIUM", "HIGH", "NONE", "minimal", "", 0, null]) {
      expect(resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, FALLBACK, desired as never)).toEqual({});
      expect(resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, PRIMARY, desired as never)).toEqual({});
    }
  });
});

describe("9B-P1 — determinism", () => {
  it("is a pure function: repeated calls are identical", () => {
    const inputs: ReadonlyArray<[string, string]> = [
      [GEMINI_THINKING_PROVIDER_ID, PRIMARY],
      [GEMINI_THINKING_PROVIDER_ID, FALLBACK],
      ["openrouter", PRIMARY],
      [GEMINI_THINKING_PROVIDER_ID, "gemini-flash-latest"],
    ];
    for (const [providerId, model] of inputs) {
      const first = JSON.stringify(resolveThinkingProviderOptions(providerId, model));
      for (let i = 0; i < 5; i += 1) {
        expect(JSON.stringify(resolveThinkingProviderOptions(providerId, model))).toBe(first);
      }
    }
  });

  it("does not mutate or share state between calls", () => {
    const a = resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, PRIMARY, "MINIMAL");
    const b = resolveThinkingProviderOptions(GEMINI_THINKING_PROVIDER_ID, FALLBACK, "MINIMAL");
    expect(a["thinkingConfig"]).not.toBe(b["thinkingConfig"]);
  });
});
