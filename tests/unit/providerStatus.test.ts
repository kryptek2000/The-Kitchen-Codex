import { describe, it, expect, vi, afterEach } from "vitest";
import type { ProviderStatus } from "../../server/ai/providerStatus.js";

const SENTINEL = "SUPER_SECRET_PHASE1D_SENTINEL";

async function freshStatus(env: Record<string, string>): Promise<ProviderStatus[]> {
  vi.resetModules();
  for (const k of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[k];
  Object.assign(process.env, env);
  const mod = await import("../../server/ai/providerStatus.js");
  return mod.getAiProviderStatus();
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[k];
  vi.resetModules();
});

describe("provider status (v0.7 1D) — boolean/capability metadata only", () => {
  it("preserves registry order Gemini -> OpenRouter -> DeepSeek", async () => {
    const status = await freshStatus({ DEEPSEEK_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL, GEMINI_API_KEY: SENTINEL });
    expect(status.map((s) => s.providerId)).toEqual(["gemini", "openrouter", "deepseek"]);
  });

  it("none configured => Gemini enabled-but-unavailable; OpenRouter/DeepSeek inert", async () => {
    const status = await freshStatus({});
    const byId = Object.fromEntries(status.map((s) => [s.providerId, s]));
    expect(byId["gemini"]).toMatchObject({ configured: false, enabled: true, available: false });
    expect(byId["openrouter"]).toMatchObject({ configured: false, enabled: false, available: false });
    expect(byId["deepseek"]).toMatchObject({ configured: false, enabled: false, available: false });
  });

  it("Gemini only => configured/available; OpenRouter & DeepSeek not configured", async () => {
    const status = await freshStatus({ GEMINI_API_KEY: SENTINEL });
    const byId = Object.fromEntries(status.map((s) => [s.providerId, s]));
    expect(byId["gemini"]).toMatchObject({ configured: true, enabled: true, available: true });
    expect(byId["openrouter"]).toMatchObject({ configured: false, enabled: false, available: false });
    expect(byId["deepseek"]).toMatchObject({ configured: false, enabled: false, available: false });
  });

  it("Gemini + OpenRouter => both available; DeepSeek still inert", async () => {
    const status = await freshStatus({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL });
    const byId = Object.fromEntries(status.map((s) => [s.providerId, s]));
    expect(byId["gemini"]).toMatchObject({ configured: true, enabled: true, available: true });
    expect(byId["openrouter"]).toMatchObject({ configured: true, enabled: true, available: true });
    expect(byId["deepseek"]).toMatchObject({ configured: false, enabled: false, available: false });
  });

  it("all three configured => all configured/enabled/available", async () => {
    const status = await freshStatus({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL, DEEPSEEK_API_KEY: SENTINEL });
    const byId = Object.fromEntries(status.map((s) => [s.providerId, s]));
    for (const id of ["gemini", "openrouter", "deepseek"]) {
      expect(byId[id]).toMatchObject({ configured: true, enabled: true, available: true });
    }
  });

  it("runtime signals are strict booleans", async () => {
    const status = await freshStatus({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL, DEEPSEEK_API_KEY: SENTINEL });
    for (const s of status) {
      expect(typeof s.configured).toBe("boolean");
      expect(typeof s.enabled).toBe("boolean");
      expect(typeof s.available).toBe("boolean");
      expect(typeof s.supportsSecretWrites).toBe("boolean");
      expect(s.storageScope).toBe("server_environment");
    }
  });

  it("capabilities are registry-owned defaults (never user-editable; correct truth)", async () => {
    const status = await freshStatus({ GEMINI_API_KEY: SENTINEL });
    const byId = Object.fromEntries(status.map((s) => [s.providerId, s]));
    expect(byId["gemini"].capabilities).toEqual({
      reasoning: true,
      structuredOutput: true,
      recipeGeneration: true,
      webSearch: true,
    });
    // OpenRouter and DeepSeek default baselines claim nothing without curated models.
    expect(Object.values(byId["openrouter"].capabilities).every((v) => v === false)).toBe(true);
    expect(Object.values(byId["deepseek"].capabilities).every((v) => v === false)).toBe(true);
  });

  it("NEVER leaks a secret value or a masked substring in the status object", async () => {
    const longSecret = `${SENTINEL}-abcdef1234567890`;
    const status = await freshStatus({ GEMINI_API_KEY: longSecret, OPENROUTER_API_KEY: longSecret, DEEPSEEK_API_KEY: longSecret });
    const json = JSON.stringify(status);
    expect(json).not.toContain(longSecret);
    expect(json).not.toContain(SENTINEL);
    // No secret-shaped fields are allowed in the status shape at all.
    const forbiddenKeys = ["key", "token", "secret", "authorization", "apiKey", "value"];
    for (const s of status) {
      for (const k of Object.keys(s)) {
        expect(forbiddenKeys.includes(k), `status must not contain a secret-shaped field "${k}"`).toBe(false);
      }
    }
  });
});
