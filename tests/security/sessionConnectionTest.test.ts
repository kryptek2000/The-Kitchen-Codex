import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * BYOK-5D — session credential connection testing.
 *
 * Proves exact credential precedence, isolation, fail-closed behavior, and which
 * credential is actually sent (via a mocked transport). Never prints a secret.
 */

const SESSION = "SESSION_SENTINEL_5D_DO_NOT_LOG";
const ENV = "ENV_SENTINEL_5D_DO_NOT_LOG";
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
  "K_SERVICE",
  "HOST",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
] as const;

async function fresh(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const connectionTest = await import("../../server/ai/connectionTest.js");
  const session = await import("../../server/ai/sessionSecrets.js");
  connectionTest.resetConnectionTestConcurrencyForTests();
  return { connectionTest, session };
}

function stubFetch(status = 200, body: string | object = "{}") {
  const original = globalThis.fetch;
  const calls: { url: string; method?: string; auth?: string; googleKey?: string }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method,
      auth: headers.Authorization ?? headers.authorization,
      googleKey: headers["x-goog-api-key"],
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const OR_KEY_OK = JSON.stringify({ data: { label: "x" } });
const GEMINI_OK = JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
const DEEPSEEK_OK = JSON.stringify({ choices: [{ message: { content: "ok" } }] });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

describe("BYOK-5D — credential precedence", () => {
  it("A: operator pin + session key present -> ENV tested, session ignored", async () => {
    const { connectionTest, session } = await fresh({
      OPENROUTER_API_KEY: ENV,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
      KITCHEN_CODEX_TEXT_MODEL: "openai/gpt-4o-mini",
    });
    session.setSessionSecret("openrouter", SESSION);
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        modelId: "openai/gpt-4o-mini",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.credentialSource).toBe("server_environment");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].auth).toBe(`Bearer ${ENV}`);
  });

  it("B: user-selected + session_only -> exact SESSION credential tested", async () => {
    const { connectionTest, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.credentialSource).toBe("session_only");
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/key");
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });

  it("C: user-selected + server_environment -> exact ENV credential tested", async () => {
    const { connectionTest, session } = await fresh({ OPENROUTER_API_KEY: ENV });
    session.setSessionSecret("openrouter", SESSION);
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "server_environment",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.credentialSource).toBe("server_environment");
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${ENV}`);
  });

  it("D: session_only + missing key -> fail closed with ZERO env fallback", async () => {
    const { connectionTest } = await fresh({ OPENROUTER_API_KEY: ENV });
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe("SESSION_CREDENTIAL_MISSING");
        expect(result.credentialSource).toBe("session_only");
      }
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("E: session_only + expired key -> fail closed as SESSION_CREDENTIAL_MISSING (no expired code)", async () => {
    const { connectionTest, session } = await fresh({});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    session.setSessionSecret("openrouter", SESSION);
    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        // Expired normalizes to MISSING (lifecycle detail is not exposed).
        expect(result.code).toBe("SESSION_CREDENTIAL_MISSING");
      }
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("F: session_only + revoked key -> fail closed", async () => {
    const { connectionTest, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    session.revokeSessionSecret("openrouter");
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("SESSION_CREDENTIAL_MISSING");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("G: server_environment + env missing + session present -> fail closed, ZERO session fallback", async () => {
    const { connectionTest, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "server_environment",
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("UNAVAILABLE");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("I: cross-provider isolation — an openrouter session key never validates deepseek/gemini", async () => {
    const { connectionTest, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const stub = stubFetch(200, DEEPSEEK_OK);
    try {
      const deepseek = await connectionTest.runConnectionTest({
        providerId: "deepseek",
        kind: "text",
        credentialSource: "session_only",
      });
      const gemini = await connectionTest.runConnectionTest({
        providerId: "gemini",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(deepseek.ok).toBe(false);
      expect(gemini.ok).toBe(false);
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("J: session-only test works when the corresponding env key is completely absent", async () => {
    const { connectionTest, session } = await fresh({}); // no operator keys
    session.setSessionSecret("openrouter", SESSION);
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });
});

describe("BYOK-5D — outgoing credential per provider", () => {
  it("DeepSeek session_only sends the SESSION bearer (not env)", async () => {
    const { connectionTest, session } = await fresh({ DEEPSEEK_API_KEY: ENV });
    session.setSessionSecret("deepseek", SESSION);
    const stub = stubFetch(200, DEEPSEEK_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "deepseek",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });

  it("Gemini session_only sends the SESSION x-goog-api-key (not env)", async () => {
    const { connectionTest, session } = await fresh({ GEMINI_API_KEY: ENV });
    session.setSessionSecret("gemini", SESSION);
    const stub = stubFetch(200, GEMINI_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "gemini",
        kind: "text",
        modelId: "gemini-3.7-flash",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].googleKey).toBe(SESSION);
    expect(stub.calls[0].auth).toBeUndefined();
  });

  it("Gemini server_environment sends the ENV x-goog-api-key", async () => {
    const { connectionTest, session } = await fresh({ GEMINI_API_KEY: ENV });
    session.setSessionSecret("gemini", SESSION);
    const stub = stubFetch(200, GEMINI_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "gemini",
        kind: "text",
        credentialSource: "server_environment",
      });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].googleKey).toBe(ENV);
  });
});

describe("BYOK-5D — deployment guard + image", () => {
  it("session_only connection test is blocked in a hosted deployment (SESSION_BYOK_UNAVAILABLE)", async () => {
    const { connectionTest, session } = await fresh({});
    // Store the key while the deployment is supported, THEN flip to hosted.
    session.setSessionSecret("openrouter", SESSION);
    process.env.K_SERVICE = "hosted";
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe("SESSION_BYOK_UNAVAILABLE");
        expect(result.message).toBe("Session-only BYOK is not available in this deployment.");
        // No secret / internal detail leakage.
        expect(JSON.stringify(result)).not.toContain(SESSION);
      }
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("session_only is blocked with ZERO provider traffic for wildcard / LAN HOST and kill switch", async () => {
    for (const env of [
      { HOST: "0.0.0.0" },
      { HOST: "::" },
      { HOST: "192.168.1.10" },
      { KITCHEN_CODEX_DISABLE_SESSION_BYOK: "1" },
    ] as Record<string, string>[]) {
      const { connectionTest, session } = await fresh({});
      session.setSessionSecret("openrouter", SESSION);
      Object.assign(process.env, env);
      const stub = stubFetch(200, OR_KEY_OK);
      try {
        const result = await connectionTest.runConnectionTest({
          providerId: "openrouter",
          kind: "text",
          credentialSource: "session_only",
        });
        expect(result.ok, JSON.stringify(env)).toBe(false);
        if (result.ok === false) expect(result.code, JSON.stringify(env)).toBe("SESSION_BYOK_UNAVAILABLE");
      } finally {
        stub.restore();
      }
      expect(stub.calls, JSON.stringify(env)).toHaveLength(0);
    }
  });

  it("loopback/default-local session_only connection test still works", async () => {
    const { connectionTest, session } = await fresh({ HOST: "127.0.0.1" });
    session.setSessionSecret("openrouter", SESSION);
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
  });

  it("image session_only credential validation works (credential check only, no generation)", async () => {
    const { connectionTest, session } = await fresh({});
    session.setSessionSecret("openrouter-image", SESSION);
    const stub = stubFetch(200, OR_KEY_OK);
    try {
      const result = await connectionTest.runConnectionTest({
        providerId: "openrouter-image",
        kind: "image",
        credentialSource: "session_only",
      });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/key");
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });
});

describe("BYOK-5D — no secret leak", () => {
  it("never includes the sentinel in a result or an error and never mutates process.env", async () => {
    const { connectionTest, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const before = JSON.stringify(process.env);

    const okStub = stubFetch(200, OR_KEY_OK);
    let okResult: any;
    try {
      okResult = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
    } finally {
      okStub.restore();
    }
    expect(JSON.stringify(okResult)).not.toContain(SESSION);

    const authStub = stubFetch(401, JSON.stringify({ error: "invalid api key" }));
    let authResult: any;
    try {
      authResult = await connectionTest.runConnectionTest({
        providerId: "openrouter",
        kind: "text",
        credentialSource: "session_only",
      });
    } finally {
      authStub.restore();
    }
    expect(JSON.stringify(authResult)).not.toContain(SESSION);
    expect(JSON.stringify(process.env)).toBe(before);
  });
});
