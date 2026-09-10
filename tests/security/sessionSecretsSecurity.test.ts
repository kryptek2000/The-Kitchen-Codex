import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  setSessionSecret,
  getSessionSecret,
  revokeSessionSecret,
  getSessionSecretStatus,
  resetSessionSecretsForTests,
  SessionSecretError,
} from "../../server/ai/sessionSecrets.js";

const SENTINEL = "SUPER_SECRET_SESSION_SENTINEL_9f3a";
const ENV_KEYS = [
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "HOST",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
] as const;

afterEach(() => {
  resetSessionSecretsForTests();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("BYOK-5A SECURITY — session secret containment", () => {
  it("never writes the secret into process.env", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const before = JSON.stringify(process.env);
    setSessionSecret("openrouter", SENTINEL);
    getSessionSecret("openrouter");
    getSessionSecretStatus("openrouter");
    revokeSessionSecret("openrouter");
    expect(JSON.stringify(process.env)).toBe(before);
    for (const value of Object.values(process.env)) {
      expect(String(value)).not.toContain(SENTINEL);
    }
  });

  it("never exposes the secret (or a fragment/hash) in status output", () => {
    const status = setSessionSecret("openrouter", SENTINEL);
    const json = JSON.stringify(status);
    expect(json).not.toContain(SENTINEL);
    // No prefix/suffix fragment.
    expect(json).not.toContain(SENTINEL.slice(0, 8));
    expect(json).not.toContain(SENTINEL.slice(-8));
    // No secret-shaped keys at all.
    expect(Object.keys(status)).not.toContain("secret");
    expect(Object.keys(status)).not.toContain("masked");
    expect(Object.keys(status)).not.toContain("hash");
    expect(Object.keys(status)).not.toContain("fingerprint");
  });

  it("never includes the secret in error messages", () => {
    let err: unknown;
    try {
      setSessionSecret("ghost-provider", SENTINEL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SessionSecretError);
    const message = String((err as Error).message);
    expect(message).not.toContain(SENTINEL);
    expect(JSON.stringify({ code: (err as SessionSecretError).code, message })).not.toContain(SENTINEL);
  });

  it("never logs the secret", () => {
    const methods = ["log", "warn", "error", "info", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    setSessionSecret("openrouter", SENTINEL);
    getSessionSecret("openrouter");
    getSessionSecretStatus("openrouter");
    revokeSessionSecret("openrouter");
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
    }
  });

  it("the store module has no persistence / browser / settings / vault code path", () => {
    const source = readFileSync(new URL("../../server/ai/sessionSecrets.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "SettingsAdapter",
      "writeFile",
      "data.json",
      "readFile",
      "fetch(",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // No environment-variable reads/writes of any kind in the store.
    expect(source).not.toMatch(/process\.env\s*\[/);
    expect(source).not.toMatch(/process\.env\s*\./);
    expect(source).not.toMatch(/process\.env\s*=/);
  });

  it("exposes no secret serialization method", async () => {
    const mod = await import("../../server/ai/sessionSecrets.js");
    for (const key of Object.keys(mod)) {
      expect(key.toLowerCase()).not.toContain("serialize");
      expect(key.toLowerCase()).not.toContain("tojson");
    }
    // The status type never carries the secret.
    const status = getSessionSecretStatus("openrouter");
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("a fresh module instance contains no previous secret (nothing persisted)", async () => {
    setSessionSecret("openrouter", SENTINEL);
    expect(getSessionSecret("openrouter")).toBe(SENTINEL);
    vi.resetModules();
    const fresh = await import("../../server/ai/sessionSecrets.js");
    // Assert BEFORE any reset helper so a hypothetical persisted/rehydrated
    // secret would be observed rather than erased by cleanup.
    expect(fresh.getSessionSecret("openrouter")).toBeUndefined();
    expect(fresh.getSessionSecretStatus("openrouter").configured).toBe(false);
    fresh.resetSessionSecretsForTests();
  });
});
