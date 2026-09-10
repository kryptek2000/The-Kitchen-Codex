import { describe, it, expect, afterEach, vi } from "vitest";
import { parseTextSelectionHeader, parseImageSelectionHeader } from "../../server/ai/parseSelectionMetadata.js";

const SENTINEL = "SUPER_SECRET_BYOK4_SENTINEL";
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
] as const;

async function freshModule(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const effectiveSelection = await import("../../server/ai/effectiveSelection.js");
  return { effectiveSelection };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// normalizeOperationSelection (pure, no env needed)
// ---------------------------------------------------------------------------

describe("BYOK-4 — normalizeOperationSelection", () => {
  it("returns {} for null / non-object / non-string fields", async () => {
    const { normalizeOperationSelection } = await import("../../server/ai/effectiveSelection.js");
    expect(normalizeOperationSelection(null)).toEqual({});
    expect(normalizeOperationSelection(42)).toEqual({});
    expect(normalizeOperationSelection("text")).toEqual({});
  });

  it("trims, bounds, and omits empty strings", async () => {
    const { normalizeOperationSelection } = await import("../../server/ai/effectiveSelection.js");
    expect(normalizeOperationSelection({ providerId: "  gemini  ", modelId: "  gemini-3.7-flash  " }))
      .toEqual({ providerId: "gemini", modelId: "gemini-3.7-flash" });
  });

  it("bounds string lengths (64 for providerId, 128 for modelId)", async () => {
    const { normalizeOperationSelection } = await import("../../server/ai/effectiveSelection.js");
    const result = normalizeOperationSelection({
      providerId: "x".repeat(128),
      modelId: "y".repeat(256),
    });
    expect(result.providerId!.length).toBe(64);
    expect(result.modelId!.length).toBe(128);
  });

  it("preserves an explicit mode and rejects unknown modes", async () => {
    const { normalizeOperationSelection } = await import("../../server/ai/effectiveSelection.js");
    expect(normalizeOperationSelection({ mode: "user_selected", providerId: "openrouter" })).toEqual({
      mode: "user_selected",
      providerId: "openrouter",
    });
    expect(normalizeOperationSelection({ mode: "server_default" })).toEqual({ mode: "server_default" });
    expect(normalizeOperationSelection({ mode: "server_managed", providerId: "gemini" })).toEqual({
      providerId: "gemini",
    });
    expect(normalizeOperationSelection({ mode: "bogus", providerId: "gemini" })).toEqual({ providerId: "gemini" });
  });
});

// ---------------------------------------------------------------------------
// validateUserTextSelection (controlled env via vi.resetModules)
// ---------------------------------------------------------------------------

describe("BYOK-4 — validateUserTextSelection precedence / fail-closed", () => {
  it("null / undefined request => null (fail-closed)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    expect(effectiveSelection.validateUserTextSelection(undefined, regs)).toBeNull();
    expect(effectiveSelection.validateUserTextSelection({}, regs)).toBeNull();
  });

  it("unknown provider => null (no cross-provider fallback)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    expect(effectiveSelection.validateUserTextSelection({ providerId: "ghost" }, regs)).toBeNull();
  });

  it("disabled provider => null (enabled gate)", async () => {
    const { effectiveSelection } = await freshModule({}); // all providers disabled
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    expect(effectiveSelection.validateUserTextSelection({ providerId: "gemini" }, regs)).toBeNull();
  });

  it("valid provider + curated model => resolved", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.validateUserTextSelection(
      { providerId: "gemini", modelId: "gemini-3.7-flash" },
      regs
    );
    expect(result).toEqual({ providerId: "gemini", modelId: "gemini-3.7-flash" });
  });

  it("valid provider + uncurated model => null (no uncurated model execution)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    expect(
      effectiveSelection.validateUserTextSelection(
        { providerId: "gemini", modelId: "totally-uncurated-model" },
        regs
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTextCandidateContext (precedence: server_managed > user_selected > server_default)
// ---------------------------------------------------------------------------

describe("BYOK-4 — resolveTextCandidateContext precedence", () => {
  it("server_managed valid pin => pinned provider/model only", async () => {
    const { effectiveSelection } = await freshModule({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
      KITCHEN_CODEX_TEXT_MODEL: "openai/gpt-4o-mini",
    });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      providerId: "gemini", modelId: "gemini-3.7-flash",
    });
    // Server pin wins: user selection is ignored.
    expect(result.source).toBe("server_managed");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].model).toBe("openai/gpt-4o-mini");
  });

  it("server_managed invalid pin => no candidates (deterministic fallback arms)", async () => {
    const { effectiveSelection } = await freshModule({ KITCHEN_CODEX_TEXT_PROVIDER: "ghost" });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, { providerId: "gemini" });
    expect(result.source).toBe("server_managed");
    expect(result.candidates).toHaveLength(0);
  });

  it("user selection honored when server_default", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      providerId: "gemini", modelId: "gemini-3.7-flash",
    });
    expect(result.source).toBe("user_selected");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].model).toBe("gemini-3.7-flash");
  });

  it("no user selection => server_default (all providers)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, undefined);
    expect(result.source).toBe("server_default");
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("EXPLICIT user selection that is stale/invalid FAILS CLOSED to NO candidates (never server default)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    // User picks an uncurated model => validateUserTextSelection returns null.
    // An explicit user pick must NOT silently become server default (Gemini).
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      mode: "user_selected",
      providerId: "gemini",
      modelId: "totally-uncurated-model",
    });
    expect(result.source).toBe("user_selected");
    expect(result.candidates).toHaveLength(0);
  });

  it("EXPLICIT user OpenRouter selection when OpenRouter is unavailable => ZERO Gemini candidates", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL }); // no OpenRouter key
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      mode: "user_selected",
      providerId: "openrouter",
      modelId: "openai/gpt-4o-mini",
    });
    // Fail closed: no candidate at all — Gemini is NOT a silent substitute.
    expect(result.source).toBe("user_selected");
    expect(result.candidates).toHaveLength(0);
  });

  it("EXPLICIT user DeepSeek selection when DeepSeek is unavailable => ZERO Gemini/OpenRouter candidates", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL }); // no DeepSeek key
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      mode: "user_selected",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    expect(result.source).toBe("user_selected");
    expect(result.candidates).toHaveLength(0);
  });

  it("EXPLICIT user selection that fails the operation capability gate => NO candidates", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    // kitchenDiscover requires webSearch; OpenRouter cannot satisfy it. The
    // explicit pick must fail closed, not hand off to Gemini.
    const result = effectiveSelection.resolveTextCandidateContext("kitchenDiscover", regs, {
      mode: "user_selected",
      providerId: "openrouter",
    });
    expect(result.source).toBe("user_selected");
    expect(result.candidates).toHaveLength(0);
  });

  it("explicit mode server_default (no provider) or absent header => normal server_default chain", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const empty = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {});
    expect(empty.source).toBe("server_default");
    expect(empty.candidates.length).toBeGreaterThanOrEqual(1);
    const explicitDefault = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      mode: "server_default",
    });
    expect(explicitDefault.source).toBe("server_default");
    expect(explicitDefault.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("valid server_managed pin still overrides an explicit user selection", async () => {
    const { effectiveSelection } = await freshModule({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash",
    });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      mode: "user_selected",
      providerId: "openrouter",
      modelId: "openai/gpt-4o-mini",
    });
    expect(result.source).toBe("server_managed");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].model).toBe("gemini-3.7-flash");
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveImageSelection (image surface fail-closed)
// ---------------------------------------------------------------------------

describe("BYOK-4 — resolveEffectiveImageSelection fail-closed", () => {
  it("EXPLICIT user image selection when OpenRouter image is unavailable => ZERO Gemini-image, provider null", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL }); // no OpenRouter key
    const result = effectiveSelection.resolveEffectiveImageSelection({
      mode: "user_selected",
      providerId: "openrouter-image",
      modelId: "google/gemini-2.5-flash-image",
    });
    expect(result.source).toBe("user_selected");
    expect(result.provider).toBeNull();
    expect(result.model).toBeUndefined();
  });

  it("EXPLICIT user image selection with an uncurated model => provider null (never Gemini-image)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const result = effectiveSelection.resolveEffectiveImageSelection({
      mode: "user_selected",
      providerId: "gemini-image",
      modelId: "totally-uncurated-image-model",
    });
    expect(result.source).toBe("user_selected");
    expect(result.provider).toBeNull();
  });

  it("VALID user image selection is honored when configured (no server-managed pin)", async () => {
    const { effectiveSelection } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const result = effectiveSelection.resolveEffectiveImageSelection({
      mode: "user_selected",
      providerId: "openrouter-image",
      modelId: "google/gemini-2.5-flash-image",
    });
    expect(result.source).toBe("user_selected");
    expect(result.provider?.id).toBe("openrouter-image");
  });

  it("no explicit user selection => safe server default (Gemini image)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const result = effectiveSelection.resolveEffectiveImageSelection(undefined);
    expect(result.source).toBe("server_default");
    expect(result.provider?.id).toBe("gemini-image");
  });

  it("explicit mode server_default (no provider) => server default chain restored", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const result = effectiveSelection.resolveEffectiveImageSelection({ mode: "server_default" });
    expect(result.source).toBe("server_default");
    expect(result.provider?.id).toBe("gemini-image");
  });

  it("BYOK-5F: an explicit session_only image intent with NO stored session key fails closed", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const result = effectiveSelection.resolveEffectiveImageSelection({
      kind: "EXPLICIT_SELECTED",
      providerId: "gemini-image",
      credentialSource: "session_only",
    });
    // Never silently falls back to the operator environment credential.
    expect(result.provider).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end wire format: the EXACT client header payload fails closed server-side
// ---------------------------------------------------------------------------

describe("BYOK-4 FINAL — client header wire format fails closed server-side", () => {
  it("a preserved stale OpenRouter TEXT header => ZERO Gemini candidates", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL }); // no OpenRouter
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const parsed = parseTextSelectionHeader({
      "x-kitchen-ai-text-selection": JSON.stringify({
        mode: "user_selected",
        providerId: "openrouter",
        modelId: "openai/gpt-4o-mini",
      }),
    });
    expect(parsed).toEqual({ kind: "EXPLICIT_SELECTED", providerId: "openrouter", modelId: "openai/gpt-4o-mini" });
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, parsed);
    expect(result.source).toBe("user_selected");
    expect(result.candidates).toHaveLength(0);
  });

  it("a preserved stale OpenRouter IMAGE header => provider null (ZERO Gemini-image)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL }); // no OpenRouter
    const parsed = parseImageSelectionHeader({
      "x-kitchen-ai-image-selection": JSON.stringify({
        mode: "user_selected",
        providerId: "openrouter-image",
        modelId: "google/gemini-2.5-flash-image",
      }),
    });
    const result = effectiveSelection.resolveEffectiveImageSelection(parsed);
    expect(result.source).toBe("user_selected");
    expect(result.provider).toBeNull();
  });

  it("an explicit server_default header restores the normal default chain", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const parsed = parseTextSelectionHeader({
      "x-kitchen-ai-text-selection": JSON.stringify({ mode: "server_default" }),
    });
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, parsed);
    expect(result.source).toBe("server_default");
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// STRICT INTENT: a PRESENT-but-malformed payload FAILS CLOSED (never default)
// ---------------------------------------------------------------------------

describe("BYOK-4 STRICT — INVALID selection intent fails closed (zero provider calls)", () => {
  const malformedHeaders: Record<string, string | string[]> = {
    malformed_json: "{not json",
    duplicate_header: ["a", "b"],
    invalid_mode: JSON.stringify({ mode: "server_managed", providerId: "gemini" }),
    model_only: JSON.stringify({ modelId: "gemini-3.7-flash" }),
    server_default_with_provider: JSON.stringify({ mode: "server_default", providerId: "gemini" }),
    malformed_field: JSON.stringify({ providerId: 123 }),
    missing_provider: JSON.stringify({ mode: "user_selected" }),
  };

  it("TEXT: every malformed present header resolves to ZERO candidates (deterministic fallback, never Gemini)", async () => {
    for (const [label, value] of Object.entries(malformedHeaders)) {
      const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
      const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
      const parsed = parseTextSelectionHeader({ "x-kitchen-ai-text-selection": value });
      expect(parsed.kind, label).toBe("INVALID");
      const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, parsed);
      expect(result.candidates, label).toHaveLength(0);
      expect(result.source, label).toBe("user_selected");
    }
  });

  it("TEXT: an oversized header resolves to ZERO candidates", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const oversized = JSON.stringify({ providerId: "x".repeat(2000) });
    const parsed = parseTextSelectionHeader({ "x-kitchen-ai-text-selection": oversized });
    expect(parsed.kind).toBe("INVALID");
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, parsed);
    expect(result.candidates).toHaveLength(0);
  });

  it("IMAGE: every malformed present header resolves to a NULL provider (zero image execution)", async () => {
    for (const [label, value] of Object.entries(malformedHeaders)) {
      const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
      const parsed = parseImageSelectionHeader({ "x-kitchen-ai-image-selection": value });
      expect(parsed.kind, label).toBe("INVALID");
      const result = effectiveSelection.resolveEffectiveImageSelection(parsed);
      expect(result.provider, label).toBeNull();
      expect(result.invalidIntent, label).toBe(true);
    }
  });

  it("INVALID client intent FAILS CLOSED even when a VALID server-managed pin exists (zero paid work)", async () => {
    const { effectiveSelection } = await freshModule({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash",
    });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    for (const reason of ["malformed_json", "duplicate_header", "oversized", "empty_payload", "empty_provider", "invalid_mode", "model_only"] as const) {
      const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, { kind: "INVALID", reason });
      expect(result.candidates, reason).toHaveLength(0);
      expect(result.source, reason).toBe("user_selected");
    }
  });

  it("IMAGE: INVALID client intent fails closed even with a VALID server-managed image pin", async () => {
    const { effectiveSelection } = await freshModule({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_IMAGE_PROVIDER: "gemini-image",
    });
    const result = effectiveSelection.resolveEffectiveImageSelection({ kind: "INVALID", reason: "empty_payload" });
    expect(result.provider).toBeNull();
    expect(result.invalidIntent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BYOK-5C: the LEGACY raw metadata path must FAIL CLOSED on a malformed
// present credentialSource (never silently dropped into server_environment).
// ---------------------------------------------------------------------------

describe("BYOK-5C — legacy credentialSource fails closed", () => {
  it("preserves valid credentialSource and keeps legacy semantics when absent", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    expect(
      effectiveSelection.coerceLegacyOperationSelection({
        mode: "user_selected",
        providerId: "openrouter",
        credentialSource: "session_only",
      })
    ).toEqual({
      invalid: false,
      metadata: { mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" },
    });
    expect(
      effectiveSelection.coerceLegacyOperationSelection({
        mode: "user_selected",
        providerId: "gemini",
        credentialSource: "server_environment",
      })
    ).toEqual({
      invalid: false,
      metadata: { mode: "user_selected", providerId: "gemini", credentialSource: "server_environment" },
    });
    // Absent credentialSource keeps the intended legacy semantics.
    expect(effectiveSelection.coerceLegacyOperationSelection({ providerId: "gemini" })).toEqual({
      invalid: false,
      metadata: { providerId: "gemini" },
    });
  });

  it("marks a PRESENT but invalid credentialSource as invalid (never silently omitted)", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    for (const bad of ["bogus", "", 7, {}, [], true, null]) {
      const coerced = effectiveSelection.coerceLegacyOperationSelection({
        mode: "user_selected",
        providerId: "openrouter",
        credentialSource: bad,
      });
      expect(coerced.invalid, JSON.stringify(bad)).toBe(true);
    }
  });

  it("zero provider execution from malformed legacy metadata", async () => {
    const { effectiveSelection } = await freshModule({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL });
    const regs = (await import("../../server/ai/providerRegistry.js")).getRegisteredProviders();
    const result = effectiveSelection.resolveTextCandidateContext("kitchenInterpret", regs, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "bogus" as unknown as "server_environment",
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.source).toBe("user_selected");
  });
});
