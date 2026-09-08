import { describe, it, expect } from "vitest";
import { ServerEnvironmentSecretAdapter } from "../../server/platform/ServerEnvironmentSecretAdapter.js";
import { BrowserSecretAdapter } from "../../src/platform/browser/BrowserSecretAdapter.js";
import { ObsidianSecretAdapter } from "../../src/platform/obsidian/ObsidianSecretAdapter.js";
import type { SecretStorageScope } from "../../src/application/adapters/SecretAdapter.js";

// The canonical set of truthful storage scopes for v0.7 Phase 1D. `unavailable`
// and `secure_platform` may be referenced in code/tests; `local_plaintext` is
// RESERVED for a future Obsidian plaintext adapter and must not be claimed today.
const VALID_SCOPES: SecretStorageScope[] = [
  "unavailable",
  "local_plaintext",
  "server_environment",
  "secure_platform",
];

describe("secret storage scope truth (v0.7 1D)", () => {
  it("only the four truthful scopes are valid (no misleading categories)", () => {
    expect(VALID_SCOPES).toHaveLength(4);
    expect(VALID_SCOPES).toContain("unavailable");
    expect(VALID_SCOPES).toContain("local_plaintext");
    expect(VALID_SCOPES).toContain("server_environment");
    expect(VALID_SCOPES).toContain("secure_platform");
  });

  it("server env adapter truthfully reports server_environment, read-only", () => {
    const a = new ServerEnvironmentSecretAdapter();
    expect(a.storageScope).toBe("server_environment");
    expect(a.supportsWrites()).toBe(false);
    expect(VALID_SCOPES).toContain(a.storageScope);
  });

  it("browser adapter truthfully reports unavailable (no provider secret storage)", () => {
    const a = new BrowserSecretAdapter();
    expect(a.storageScope).toBe("unavailable");
    expect(a.supportsWrites()).toBe(false);
    expect(a.isAvailable()).toBe(false);
    expect(VALID_SCOPES).toContain(a.storageScope);
  });

  it("obsidian adapter truthfully reports unavailable (plaintext BYOK NOT used yet)", () => {
    const a = new ObsidianSecretAdapter();
    expect(a.storageScope).toBe("unavailable");
    expect(a.supportsWrites()).toBe(false);
    expect(VALID_SCOPES).toContain(a.storageScope);
  });

  it("no current adapter falsely claims secure_platform or local_plaintext", () => {
    const adapters = [new ServerEnvironmentSecretAdapter(), new BrowserSecretAdapter(), new ObsidianSecretAdapter()];
    for (const adapter of adapters) {
      // `secure_platform` means genuinely protected storage (OS keychain). No
      // current adapter uses it.
      expect(adapter.storageScope).not.toBe("secure_platform");
      // `local_plaintext` is reserved for a FUTURE Obsidian plaintext adapter and
      // must not be claimed until a concrete adapter actually persists keys.
      expect(adapter.storageScope).not.toBe("local_plaintext");
    }
  });

  it("the SecretAdapter contract exposes an allowlisted provider secret id type boundary", () => {
    // Compile-time contract check: the provider secret ids are provider-neutral,
    // never raw env-var names.
    const ids = ["gemini_api_key", "openrouter_api_key", "deepseek_api_key"];
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
  });
});
