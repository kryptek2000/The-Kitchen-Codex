import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setSessionSecret,
  getSessionSecret,
  revokeSessionSecret,
  getSessionSecretStatus,
  clearExpiredSessionSecrets,
  resetSessionSecretsForTests,
  isSessionSecretProviderAllowed,
  sessionSecretProviderAllowlist,
  SessionSecretError,
  SESSION_SECRET_ABSOLUTE_TTL_MS,
  SESSION_SECRET_IDLE_TTL_MS,
  MAX_SESSION_SECRET_BYTES,
  MAX_SESSION_SECRET_LENGTH,
} from "../../server/ai/sessionSecrets.js";
import { isSessionByokSupportedDeployment } from "../../server/ai/sessionByokDeployment.js";

const ENV_KEYS = [
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "HOST",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
] as const;

const MINUTE = 60 * 1000;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetSessionSecretsForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  resetSessionSecretsForTests();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.unstubAllEnvs();
});

describe("BYOK-5A — session secret provider allowlist", () => {
  it("allows exactly the registered text + image provider execution ids", () => {
    const allowlist = sessionSecretProviderAllowlist();
    for (const id of ["gemini", "openrouter", "deepseek", "gemini-image", "openrouter-image"]) {
      expect(allowlist).toContain(id);
      expect(isSessionSecretProviderAllowed(id)).toBe(true);
    }
    expect(isSessionSecretProviderAllowed("ghost")).toBe(false);
    expect(isSessionSecretProviderAllowed("")).toBe(false);
  });

  it("keeps text and image provider ids distinct (openrouter != openrouter-image)", () => {
    expect(isSessionSecretProviderAllowed("openrouter")).toBe(true);
    expect(isSessionSecretProviderAllowed("openrouter-image")).toBe(true);
    expect("openrouter").not.toBe("openrouter-image");
  });

  it("rejects provider-id aliases (exact match only; no trim/case-fold)", () => {
    for (const alias of ["GEMINI", "Gemini", " gemini", "gemini ", " openrouter", "openrouter-image ", "OPENROUTER"]) {
      expect(isSessionSecretProviderAllowed(alias), alias).toBe(false);
      expect(() => setSessionSecret(alias, "x"), alias).toThrowError(SessionSecretError);
    }
    // The exact registered id succeeds.
    expect(isSessionSecretProviderAllowed("gemini")).toBe(true);
  });
});

describe("BYOK-5A — SET", () => {
  it("stores a secret for an allowlisted provider and returns a non-secret status", () => {
    const status = setSessionSecret("openrouter", "sk-session-abc");
    expect(status).toEqual({
      providerId: "openrouter",
      storageScope: "session_only",
      configured: true,
      expiresAt: expect.any(String),
      version: expect.any(String),
    });
  });

  it("rejects an unknown provider (no arbitrary provider ids)", () => {
    expect(() => setSessionSecret("ghost", "x")).toThrowError(SessionSecretError);
    try {
      setSessionSecret("ghost", "x");
    } catch (e) {
      expect((e as SessionSecretError).code).toBe("PROVIDER_NOT_ALLOWED");
    }
    expect(getSessionSecret("ghost")).toBeUndefined();
  });

  it("rejects an empty secret", () => {
    expect(() => setSessionSecret("openrouter", "")).toThrowError(SessionSecretError);
    try {
      setSessionSecret("openrouter", "");
    } catch (e) {
      expect((e as SessionSecretError).code).toBe("INVALID_SECRET");
    }
  });

  it("rejects an oversized secret", () => {
    const oversized = "x".repeat(MAX_SESSION_SECRET_LENGTH + 1);
    expect(() => setSessionSecret("openrouter", oversized)).toThrowError(SessionSecretError);
    try {
      setSessionSecret("openrouter", oversized);
    } catch (e) {
      expect((e as SessionSecretError).code).toBe("SECRET_TOO_LONG");
    }
  });

  it("enforces the secret ceiling as UTF-8 BYTES (not JS string length)", () => {
    // 4096 ASCII bytes accepted.
    expect(() => setSessionSecret("gemini", "x".repeat(4096))).not.toThrow();
    expect(Buffer.byteLength(getSessionSecret("gemini") ?? "", "utf8")).toBe(4096);
    revokeSessionSecret("gemini");

    // 4097 ASCII bytes rejected.
    expect(() => setSessionSecret("gemini", "x".repeat(4097))).toThrowError(SessionSecretError);

    // A multibyte key whose CHAR count is under 4096 but whose BYTE count is over.
    const multibyteOver = "\u00e9".repeat(2049); // 2049 chars, 4098 UTF-8 bytes
    expect(multibyteOver.length).toBeLessThan(4096);
    expect(Buffer.byteLength(multibyteOver, "utf8")).toBeGreaterThan(4096);
    expect(() => setSessionSecret("gemini", multibyteOver)).toThrowError(SessionSecretError);
    expect(getSessionSecret("gemini")).toBeUndefined();

    // Exactly 4096 UTF-8 bytes accepted.
    const multibyteExact = "\u00e9".repeat(2048); // 2048 chars, 4096 UTF-8 bytes
    expect(Buffer.byteLength(multibyteExact, "utf8")).toBe(4096);
    expect(() => setSessionSecret("gemini", multibyteExact)).not.toThrow();
    expect(getSessionSecret("gemini")).toBe(multibyteExact);
  });

  it("the byte bound constant is 4096 and the legacy alias matches", () => {
    expect(MAX_SESSION_SECRET_BYTES).toBe(4096);
    expect(MAX_SESSION_SECRET_LENGTH).toBe(4096);
  });

  it("refuses writes in a hosted/unsupported deployment", () => {
    vi.stubEnv("K_SERVICE", "hosted-service");
    expect(() => setSessionSecret("openrouter", "x")).toThrowError(SessionSecretError);
    try {
      setSessionSecret("openrouter", "x");
    } catch (e) {
      expect((e as SessionSecretError).code).toBe("SESSION_BYOK_UNSUPPORTED");
    }
    expect(getSessionSecret("openrouter")).toBeUndefined();
  });
});

describe("BYOK-5A — READ + provider isolation", () => {
  it("the same provider can read its own secret", () => {
    setSessionSecret("openrouter", "sk-session-abc");
    expect(getSessionSecret("openrouter")).toBe("sk-session-abc");
  });

  it("another provider cannot receive it", () => {
    setSessionSecret("openrouter", "sk-session-abc");
    expect(getSessionSecret("gemini")).toBeUndefined();
    expect(getSessionSecret("deepseek")).toBeUndefined();
    expect(getSessionSecret("openrouter-image")).toBeUndefined();
  });

  it("openrouter and openrouter-image remain isolated", () => {
    setSessionSecret("openrouter", "text-key");
    setSessionSecret("openrouter-image", "image-key");
    expect(getSessionSecret("openrouter")).toBe("text-key");
    expect(getSessionSecret("openrouter-image")).toBe("image-key");
    revokeSessionSecret("openrouter");
    expect(getSessionSecret("openrouter")).toBeUndefined();
    expect(getSessionSecret("openrouter-image")).toBe("image-key");
  });
});

describe("BYOK-5A — LIFECYCLE", () => {
  it("absolute expiry removes the secret (even after idle refreshes)", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(14 * MINUTE);
    expect(getSessionSecret("openrouter")).toBe("a"); // idle refresh
    vi.advanceTimersByTime(14 * MINUTE);
    expect(getSessionSecret("openrouter")).toBe("a"); // idle refresh at 28 min
    vi.advanceTimersByTime(2 * MINUTE + 1); // 30 min + 1ms absolute
    expect(getSessionSecret("openrouter")).toBeUndefined();
    expect(getSessionSecretStatus("openrouter").configured).toBe(false);
  });

  it("idle expiry removes the secret", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(SESSION_SECRET_IDLE_TTL_MS + 1);
    expect(getSessionSecret("openrouter")).toBeUndefined();
  });

  it("exactly at the absolute TTL deadline the secret is expired", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(SESSION_SECRET_ABSOLUTE_TTL_MS);
    expect(getSessionSecret("openrouter")).toBeUndefined();
    expect(getSessionSecretStatus("openrouter").configured).toBe(false);
  });

  it("exactly at the idle TTL deadline the secret is expired", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(SESSION_SECRET_IDLE_TTL_MS);
    expect(getSessionSecret("openrouter")).toBeUndefined();
  });

  it("a successful access refreshes the idle timer", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(10 * MINUTE);
    expect(getSessionSecret("openrouter")).toBe("a"); // refresh lastUsedAt
    vi.advanceTimersByTime(10 * MINUTE); // 20 min since set, 10 min since refresh
    expect(getSessionSecret("openrouter")).toBe("a");
  });

  it("revoke removes the secret and is idempotent", () => {
    setSessionSecret("openrouter", "a");
    revokeSessionSecret("openrouter");
    expect(getSessionSecret("openrouter")).toBeUndefined();
    expect(getSessionSecretStatus("openrouter").configured).toBe(false);
    expect(() => revokeSessionSecret("openrouter")).not.toThrow();
    expect(() => revokeSessionSecret("openrouter")).not.toThrow();
  });

  it("first create without a version succeeds", () => {
    const status = setSessionSecret("openrouter", "a");
    expect(status.configured).toBe(true);
    expect(getSessionSecret("openrouter")).toBe("a");
  });

  it("a second set WITHOUT a version conflicts and leaves the secret unchanged", () => {
    setSessionSecret("openrouter", "a");
    expect(() => setSessionSecret("openrouter", "b")).toThrowError(SessionSecretError);
    try {
      setSessionSecret("openrouter", "b");
    } catch (e) {
      expect((e as SessionSecretError).code).toBe("VERSION_CONFLICT");
    }
    expect(getSessionSecret("openrouter")).toBe("a");
  });

  it("rotation succeeds with the correct expectedVersion", () => {
    const first = setSessionSecret("openrouter", "a");
    const second = setSessionSecret("openrouter", "b", first.version);
    expect(second.version).not.toBe(first.version);
    expect(getSessionSecret("openrouter")).toBe("b");
  });

  it("a stale expectedVersion is rejected and never overwrites a newer secret", () => {
    const first = setSessionSecret("openrouter", "a");
    const second = setSessionSecret("openrouter", "b", first.version); // rotate
    expect(() => setSessionSecret("openrouter", "c", first.version)).toThrowError(SessionSecretError);
    try {
      setSessionSecret("openrouter", "c", first.version);
    } catch (e) {
      expect((e as SessionSecretError).code).toBe("VERSION_CONFLICT");
    }
    expect(getSessionSecret("openrouter")).toBe("b");
    expect(getSessionSecretStatus("openrouter").version).toBe(second.version);
  });

  it("an expectedVersion with no existing secret is a conflict", () => {
    expect(() => setSessionSecret("openrouter", "a", "some-version")).toThrowError(SessionSecretError);
  });

  it("an EXPIRED entry allows a fresh create without the old version", () => {
    const first = setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(SESSION_SECRET_ABSOLUTE_TTL_MS + 1);
    expect(getSessionSecret("openrouter")).toBeUndefined();
    const fresh = setSessionSecret("openrouter", "b");
    expect(fresh.configured).toBe(true);
    expect(getSessionSecret("openrouter")).toBe("b");
    expect(fresh.version).not.toBe(first.version);
  });

  it("clearExpiredSessionSecrets removes only expired entries", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(SESSION_SECRET_IDLE_TTL_MS + 1);
    expect(clearExpiredSessionSecrets()).toBe(1);
    expect(getSessionSecretStatus("openrouter").configured).toBe(false);
  });

  it("a new store/process instance contains no previous secret (no persistence)", async () => {
    setSessionSecret("openrouter", "a");
    expect(getSessionSecret("openrouter")).toBe("a");
    vi.resetModules();
    const fresh = await import("../../server/ai/sessionSecrets.js");
    // Assert BEFORE any reset helper: a hypothetical persisted/rehydrated secret
    // must surface here rather than being erased by a cleanup call first.
    expect(fresh.getSessionSecret("openrouter")).toBeUndefined();
    expect(fresh.getSessionSecretStatus("openrouter").configured).toBe(false);
    fresh.resetSessionSecretsForTests();
  });
});

describe("BYOK-5A — STATUS", () => {
  it("reports configured true/false with session_only and no secret material", () => {
    const empty = getSessionSecretStatus("openrouter");
    expect(empty).toEqual({ providerId: "openrouter", storageScope: "session_only", configured: false });

    const configured = setSessionSecret("openrouter", "SUPER_SECRET_SESSION_SENTINEL");
    expect(configured.configured).toBe(true);
    expect(configured.storageScope).toBe("session_only");
    const json = JSON.stringify(configured);
    expect(json).not.toContain("SUPER_SECRET_SESSION_SENTINEL");
    expect(json).not.toContain("secret");
    expect(configured).not.toHaveProperty("secret");
  });

  it("status for an expired secret reports configured false", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(SESSION_SECRET_ABSOLUTE_TTL_MS + 1);
    expect(getSessionSecretStatus("openrouter").configured).toBe(false);
  });

  it("status does not refresh the idle timer", () => {
    setSessionSecret("openrouter", "a");
    vi.advanceTimersByTime(14 * MINUTE);
    getSessionSecretStatus("openrouter");
    vi.advanceTimersByTime(2 * MINUTE); // 16 min since set, but status must not refresh
    expect(getSessionSecret("openrouter")).toBeUndefined();
  });
});

describe("BYOK-5A — deployment guard", () => {
  it("isSessionByokSupportedDeployment truth table", () => {
    expect(isSessionByokSupportedDeployment({} as NodeJS.ProcessEnv)).toBe(true); // loopback default
    expect(isSessionByokSupportedDeployment({ HOST: "127.0.0.1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSessionByokSupportedDeployment({ HOST: "::1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSessionByokSupportedDeployment({ HOST: "localhost" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSessionByokSupportedDeployment({ HOST: "0.0.0.0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSessionByokSupportedDeployment({ K_SERVICE: "svc" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSessionByokSupportedDeployment({ K_REVISION: "r" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSessionByokSupportedDeployment({ K_CONFIGURATION: "c" } as NodeJS.ProcessEnv)).toBe(false);
    // Hosted indicators ALWAYS win over opt-in.
    expect(
      isSessionByokSupportedDeployment({ K_SERVICE: "svc", KITCHEN_CODEX_SESSION_BYOK: "1" } as NodeJS.ProcessEnv)
    ).toBe(false);
    // Kill switch always blocks, even with opt-in.
    expect(isSessionByokSupportedDeployment({ KITCHEN_CODEX_DISABLE_SESSION_BYOK: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isSessionByokSupportedDeployment({
        KITCHEN_CODEX_DISABLE_SESSION_BYOK: "1",
        KITCHEN_CODEX_SESSION_BYOK: "1",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    // Explicit opt-in on a loopback bind is allowed.
    expect(isSessionByokSupportedDeployment({ KITCHEN_CODEX_SESSION_BYOK: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isSessionByokSupportedDeployment({ KITCHEN_CODEX_SESSION_BYOK: "1", HOST: "127.0.0.1" } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      isSessionByokSupportedDeployment({ KITCHEN_CODEX_SESSION_BYOK: "1", HOST: "localhost" } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      isSessionByokSupportedDeployment({ KITCHEN_CODEX_SESSION_BYOK: "1", HOST: "::1" } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("explicit opt-in NEVER relaxes a non-loopback / wildcard / malformed HOST", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", "not a host", "127.0.0.1:3000"]) {
      expect(
        isSessionByokSupportedDeployment({ KITCHEN_CODEX_SESSION_BYOK: "1", HOST: host } as NodeJS.ProcessEnv),
        host
      ).toBe(false);
    }
  });

  it("AI_ENDPOINT_TOKEN is irrelevant to the deployment decision", () => {
    expect(isSessionByokSupportedDeployment({ AI_ENDPOINT_TOKEN: "secret-token" } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isSessionByokSupportedDeployment({ AI_ENDPOINT_TOKEN: "secret-token", HOST: "0.0.0.0" } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      isSessionByokSupportedDeployment({ AI_ENDPOINT_TOKEN: "secret-token", K_SERVICE: "svc" } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      isSessionByokSupportedDeployment({
        AI_ENDPOINT_TOKEN: "secret-token",
        KITCHEN_CODEX_DISABLE_SESSION_BYOK: "1",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});
