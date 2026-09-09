import { describe, it, expect } from "vitest";
import { BrowserSecretAdapter } from "../../src/platform/browser/BrowserSecretAdapter.js";
import { ObsidianSecretAdapter } from "../../src/platform/obsidian/ObsidianSecretAdapter.js";
import { SecretUnavailableError } from "../../src/application/adapters/SecretAdapter.js";

const SENTINEL = "SUPER_SECRET_PHASE1E_SENTINEL";

describe("unavailable secret adapter hardening (v0.7 1E) — browser", () => {
  const adapter = new BrowserSecretAdapter();

  it("supportsWrites is false and storageScope is unavailable", () => {
    expect(adapter.supportsWrites()).toBe(false);
    expect(adapter.storageScope).toBe("unavailable");
    expect(adapter.isAvailable()).toBe(false);
  });

  it("get returns undefined", async () => {
    expect(await adapter.get("deepseek_api_key")).toBeUndefined();
  });

  it("set rejects with the platform-neutral unavailable error", async () => {
    const err = await adapter.set("deepseek_api_key", SENTINEL).catch((e) => e);
    expect(err).toBeInstanceOf(SecretUnavailableError);
    expect(err).toBeInstanceOf(Error);
  });

  it("remove rejects with the platform-neutral unavailable error", async () => {
    const err = await adapter.remove("deepseek_api_key").catch((e) => e);
    expect(err).toBeInstanceOf(SecretUnavailableError);
  });

  it("the thrown error never contains the secret value or the caller value", async () => {
    const err = await adapter.set("deepseek_api_key", SENTINEL).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain(SENTINEL);
    expect(String(err.message)).not.toContain(SENTINEL);
    expect(String(err.message)).not.toContain("deepseek_api_key");
  });
});

describe("unavailable secret adapter hardening (v0.7 1E) — obsidian", () => {
  const adapter = new ObsidianSecretAdapter();

  it("supportsWrites is false and storageScope is unavailable", () => {
    expect(adapter.supportsWrites()).toBe(false);
    expect(adapter.storageScope).toBe("unavailable");
    expect(adapter.isAvailable()).toBe(false);
  });

  it("get returns undefined", async () => {
    expect(await adapter.get("gemini_api_key")).toBeUndefined();
  });

  it("set/remove reject with the platform-neutral unavailable error", async () => {
    expect(adapter.set("gemini_api_key", SENTINEL)).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(adapter.remove("gemini_api_key")).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it("the thrown error never contains the secret value or the caller value", async () => {
    const err = await adapter.set("gemini_api_key", SENTINEL).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain(SENTINEL);
    expect(String(err.message)).not.toContain(SENTINEL);
    expect(String(err.message)).not.toContain("gemini_api_key");
  });
});
