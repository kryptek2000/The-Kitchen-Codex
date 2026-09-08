import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ServerEnvironmentSecretAdapter,
  SERVER_SECRET_ENV_ALLOWLIST,
  serverSecretEnvName,
  providerSecretIdForProvider,
  getServerSecretSync,
} from "../../server/platform/ServerEnvironmentSecretAdapter.js";
import type { ProviderSecretId } from "../../src/application/adapters/SecretAdapter.js";

const SENTINEL = "SUPER_SECRET_PHASE1D_SENTINEL";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANY_RANDOM_ENV_VAR;
});

describe("ServerEnvironmentSecretAdapter (v0.7 1D) — operator env, read-only", () => {
  it("exposes a truthful server_environment storage scope", () => {
    expect(new ServerEnvironmentSecretAdapter().storageScope).toBe("server_environment");
  });

  it("isAvailable is true when a process environment exists", () => {
    expect(typeof process).not.toBe("undefined");
    expect(new ServerEnvironmentSecretAdapter().isAvailable()).toBe(true);
  });

  it("reports supportsWrites false (read-only operator configuration)", () => {
    expect(new ServerEnvironmentSecretAdapter().supportsWrites()).toBe(false);
  });

  it("resolves ONLY allowlisted provider secret ids (server env)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-ds-value");
    expect(await new ServerEnvironmentSecretAdapter().get("deepseek_api_key")).toBe("sk-ds-value");
  });

  it("returns undefined for a missing allowlisted secret", async () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(await new ServerEnvironmentSecretAdapter().get("openrouter_api_key")).toBeUndefined();
  });

  it("CANNOT read an arbitrary environment-variable name", async () => {
    vi.stubEnv("ANY_RANDOM_ENV_VAR", SENTINEL);
    const adapter = new ServerEnvironmentSecretAdapter();
    // The arbitrary env NAME (even with a real value) is not an allowlisted id.
    expect(await adapter.get("ANY_RANDOM_ENV_VAR")).toBeUndefined();
    // The RAW env var name is not a provider-neutral id — never accepted.
    expect(await adapter.get("DEEPSEEK_API_KEY")).toBeUndefined();
    // Even when the underlying env holds a secret, the value is never returned
    // through a non-allowlisted name.
    vi.stubEnv("DEEPSEEK_API_KEY", SENTINEL);
    expect(await adapter.get("deepseek_api_key")).toBe(SENTINEL);
    expect(await adapter.get("ANY_RANDOM_ENV_VAR")).toBeUndefined();
  });

  it("set/remove are unsupported (they throw) and never mutate process.env", async () => {
    const adapter = new ServerEnvironmentSecretAdapter();
    await expect(adapter.set("deepseek_api_key", "x")).rejects.toThrow(/read-only/i);
    await expect(adapter.remove("deepseek_api_key")).rejects.toThrow(/read-only/i);
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("never leaks a secret value in serialization", async () => {
    vi.stubEnv("GEMINI_API_KEY", SENTINEL);
    const adapter = new ServerEnvironmentSecretAdapter();
    expect(JSON.stringify(adapter)).not.toContain(SENTINEL);
    // A resolved value is only returned as the get() result, never embedded in the
    // adapter's own serialized shape.
    const val = await adapter.get("gemini_api_key");
    expect(val).toBe(SENTINEL);
    expect(JSON.stringify(adapter)).not.toContain(SENTINEL);
  });

  it("accepts an injected env lookup (test seam) without touching process.env", async () => {
    const fakeEnv = new Map<string, string>([["OPENROUTER_API_KEY", "sk-injected"]]);
    const adapter = new ServerEnvironmentSecretAdapter((name) => fakeEnv.get(name));
    expect(await adapter.get("openrouter_api_key")).toBe("sk-injected");
    expect(await adapter.get("deepseek_api_key")).toBeUndefined();
  });
});

describe("server secret naming + allowlist (v0.7 1D)", () => {
  it("maps provider-neutral ids to the single server-side env allowlist", () => {
    expect(SERVER_SECRET_ENV_ALLOWLIST).toEqual({
      gemini_api_key: "GEMINI_API_KEY",
      openrouter_api_key: "OPENROUTER_API_KEY",
      deepseek_api_key: "DEEPSEEK_API_KEY",
    });
  });

  it("serverSecretEnvName resolves allowlisted ids and rejects unknown ids", () => {
    expect(serverSecretEnvName("deepseek_api_key")).toBe("DEEPSEEK_API_KEY");
    expect(serverSecretEnvName("gemini_api_key")).toBe("GEMINI_API_KEY");
    expect(serverSecretEnvName("not_a_secret_id" as ProviderSecretId)).toBeUndefined();
  });

  it("maps provider ids to secret ids (unknown provider -> undefined)", () => {
    expect(providerSecretIdForProvider("gemini")).toBe("gemini_api_key");
    expect(providerSecretIdForProvider("openrouter")).toBe("openrouter_api_key");
    expect(providerSecretIdForProvider("deepseek")).toBe("deepseek_api_key");
    expect(providerSecretIdForProvider("ghost")).toBeUndefined();
  });

  it("getServerSecretSync reads only allowlisted ids and trims", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "  sk-ds-trimmed  ");
    expect(getServerSecretSync("deepseek_api_key")).toBe("sk-ds-trimmed");
    expect(getServerSecretSync("openrouter_api_key")).toBeUndefined();
    expect(getServerSecretSync("ANY_RANDOM" as ProviderSecretId)).toBeUndefined();
  });
});
