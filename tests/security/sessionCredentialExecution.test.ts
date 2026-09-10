import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * BYOK-5C — runtime credential source resolution + provider execution.
 *
 * These tests prove WHICH credential authorized an execution by inspecting the
 * outgoing Authorization header through a mocked transport, and prove the exact
 * precedence / fail-closed / isolation rules. No secret is printed.
 */

const SESSION = "SESSION_SENTINEL_5C_DO_NOT_LOG";
const ENV = "ENV_SENTINEL_5C_DO_NOT_LOG";
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
] as const;

const STRUCTURED_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } } as const;

async function fresh(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const provider = await import("../../server/ai/provider.js");
  const parse = await import("../../server/ai/parseSelectionMetadata.js");
  const session = await import("../../server/ai/sessionSecrets.js");
  const credential = await import("../../server/ai/credentialResolver.js");
  return { provider, parse, session, credential };
}

function textSelection(
  parse: Awaited<ReturnType<typeof fresh>>["parse"],
  payload: Record<string, unknown>
) {
  return parse.parseTextSelectionHeader({
    "x-kitchen-ai-text-selection": JSON.stringify(payload),
  });
}

function stubFetch(status = 200, body: unknown = { choices: [{ message: { content: '{"ok":true}' } }] }) {
  const original = globalThis.fetch;
  const calls: { url: string; auth?: string }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization ?? headers.authorization });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

describe("BYOK-5C — provider credential injection (inspect Authorization)", () => {
  it("a session-bound OpenRouter provider sends the SESSION key, never env", async () => {
    const { credential } = await fresh({ OPENROUTER_API_KEY: ENV });
    const p = credential.createCredentialBoundTextProvider("openrouter", SESSION);
    const stub = stubFetch();
    try {
      await p!.generateStructured("prompt", STRUCTURED_SCHEMA as any, { model: "openai/gpt-4o-mini" });
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });

  it("an env-bound OpenRouter provider sends the ENV key", async () => {
    const { provider } = await fresh({ OPENROUTER_API_KEY: ENV });
    const p = provider.getAiProvider("openrouter")!;
    const stub = stubFetch();
    try {
      await p.generateStructured("prompt", STRUCTURED_SCHEMA as any, { model: "openai/gpt-4o-mini" });
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${ENV}`);
  });

  it("a session-bound Gemini provider builds a request-scoped client with the SESSION key", async () => {
    vi.resetModules();
    const captured: string[] = [];
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => null,
      getGeminiImage: () => null,
      createGeminiClientWithKey: (key: string) => {
        captured.push(key);
        return { models: { generateContent: async () => ({ text: '{"ok":true}' }) } };
      },
    }));
    try {
      const { GeminiProvider } = await import("../../server/ai/geminiProvider.js");
      const p = new GeminiProvider({ credential: SESSION });
      await p.generateStructured("prompt", STRUCTURED_SCHEMA as any, { model: "gemini-3.7-flash" });
      expect(captured).toEqual([SESSION]);
    } finally {
      vi.doUnmock("../../server/geminiClient.js");
    }
  });

  it("a session-bound DeepSeek provider sends the SESSION key", async () => {
    const { credential } = await fresh({ DEEPSEEK_API_KEY: ENV });
    const p = credential.createCredentialBoundTextProvider("deepseek", SESSION);
    const stub = stubFetch();
    try {
      await p!.generate("prompt", { model: "deepseek-v4-flash" });
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });
});

describe("BYOK-5C — credential precedence", () => {
  it("A: operator pin forces server_environment and ignores a session key", async () => {
    const { provider, parse, session } = await fresh({
      OPENROUTER_API_KEY: ENV,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
      KITCHEN_CODEX_TEXT_MODEL: "openai/gpt-4o-mini",
    });
    session.setSessionSecret("openrouter", SESSION);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    const candidates = provider.resolveRoleCandidates("kitchenInterpret", undefined, sel);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].provider.id).toBe("openrouter");
    expect(candidates[0].credentialSource).toBe("server_environment");

    const stub = stubFetch();
    try {
      await provider.runWithAiFallback({
        candidates,
        requiredCapabilities: ["structuredOutput"],
        run: (c: any) => c.provider.generateStructured("p", STRUCTURED_SCHEMA as any, { model: c.model }),
      });
    } finally {
      stub.restore();
    }
    // The ENV key was used; the session key was NOT.
    expect(stub.calls[0].auth).toBe(`Bearer ${ENV}`);
  });

  it("B: user_selected + session_only uses ONLY the session key (no env key present)", async () => {
    const { provider, parse, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    const candidates = provider.resolveRoleCandidates("kitchenInterpret", undefined, sel);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].credentialSource).toBe("session_only");

    const stub = stubFetch();
    try {
      await provider.runWithAiFallback({
        candidates,
        requiredCapabilities: ["structuredOutput"],
        run: (c: any) => c.provider.generateStructured("p", STRUCTURED_SCHEMA as any, { model: c.model }),
      });
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });

  it("C: user_selected + server_environment uses ONLY the env key", async () => {
    const { provider, parse, session } = await fresh({ OPENROUTER_API_KEY: ENV });
    session.setSessionSecret("openrouter", SESSION);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "server_environment",
    });
    const candidates = provider.resolveRoleCandidates("kitchenInterpret", undefined, sel);
    expect(candidates[0].credentialSource).toBe("server_environment");

    const stub = stubFetch();
    try {
      await provider.runWithAiFallback({
        candidates,
        requiredCapabilities: ["structuredOutput"],
        run: (c: any) => c.provider.generateStructured("p", STRUCTURED_SCHEMA as any, { model: c.model }),
      });
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${ENV}`);
  });

  it("D: server_default NEVER consumes a session key", async () => {
    const { provider, session } = await fresh({}); // no operator keys
    session.setSessionSecret("openrouter", SESSION);
    const executable = provider.resolveExecutableTextCandidates("kitchenInterpret", undefined, undefined);
    // No env credential + no explicit selection -> no candidates; the session key
    // is NOT silently consumed by the default chain.
    expect(executable).toHaveLength(0);
  });
});

describe("BYOK-5C — fail closed (zero provider calls)", () => {
  it("missing session key -> zero candidates and no execution", async () => {
    const { provider, parse } = await fresh({});
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    expect(provider.resolveRoleCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
    expect(provider.resolveExecutableTextCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
  });

  it("expired session key -> zero candidates", async () => {
    const { provider, parse, session } = await fresh({});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    session.setSessionSecret("openrouter", SESSION);
    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    expect(provider.resolveRoleCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
  });

  it("revoked session key -> zero candidates (no cached client continues)", async () => {
    const { provider, parse, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    session.revokeSessionSecret("openrouter");
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    expect(provider.resolveRoleCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
  });

  it("invalid credentialSource -> INVALID intent -> zero candidates", async () => {
    const { provider, parse } = await fresh({});
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "bogus",
    });
    expect(sel.kind).toBe("INVALID");
    expect(provider.resolveRoleCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
  });

  it("session_only with server_default mode -> INVALID", async () => {
    const { parse } = await fresh({});
    const sel = parse.parseTextSelectionHeader({
      "x-kitchen-ai-text-selection": JSON.stringify({ mode: "server_default", credentialSource: "session_only" }),
    });
    expect(sel).toEqual({ kind: "INVALID", reason: "default_with_credential_source" });
  });

  it("no env fallback from session_only, no session fallback from server_environment", async () => {
    // session_only with NO session key but an ENV key present -> still no candidates.
    const a = await fresh({ OPENROUTER_API_KEY: ENV });
    const selA = textSelection(a.parse, { mode: "user_selected", providerId: "openrouter", credentialSource: "session_only" });
    expect(a.provider.resolveRoleCandidates("kitchenInterpret", undefined, selA)).toHaveLength(0);

    // server_environment with NO env key but a SESSION key present -> no candidates.
    const b = await fresh({});
    b.session.setSessionSecret("openrouter", SESSION);
    const selB = textSelection(b.parse, { mode: "user_selected", providerId: "openrouter", credentialSource: "server_environment" });
    expect(b.provider.resolveRoleCandidates("kitchenInterpret", undefined, selB)).toHaveLength(0);
  });
});

describe("BYOK-5C — provider isolation", () => {
  it("a session key for openrouter is never used for deepseek", async () => {
    const { provider, parse, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "deepseek",
      credentialSource: "session_only",
    });
    expect(provider.resolveRoleCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
  });

  it("a session key for gemini is never used for openrouter", async () => {
    const { provider, parse, session } = await fresh({});
    session.setSessionSecret("gemini", SESSION);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    expect(provider.resolveRoleCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
  });
});

describe("BYOK-5C — no operator key + no secret leak", () => {
  it("session_only execution works with NO operator env key", async () => {
    const { provider, parse, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    const executable = provider.resolveExecutableTextCandidates("kitchenInterpret", undefined, sel);
    expect(executable).toHaveLength(1);
    expect(executable[0].provider.isAvailable()).toBe(true);
  });

  it("does not mutate process.env and the sentinel never appears in an error", async () => {
    const { provider, parse, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const before = JSON.stringify(process.env);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });
    const candidates = provider.resolveRoleCandidates("kitchenInterpret", undefined, sel);
    const stub = stubFetch(401, { error: { message: "invalid api key" } });
    let caught: any;
    try {
      await provider.runWithAiFallback({
        candidates,
        requiredCapabilities: ["structuredOutput"],
        run: (c: any) => c.provider.generateStructured("p", STRUCTURED_SCHEMA as any, { model: c.model }),
      });
    } catch (err) {
      caught = err;
    } finally {
      stub.restore();
    }
    expect(caught).toBeTruthy();
    expect(String(caught?.message)).not.toContain(SESSION);
    expect(JSON.stringify({ code: caught?.code, message: caught?.message })).not.toContain(SESSION);
    expect(JSON.stringify(process.env)).toBe(before);
  });
});

describe("BYOK-5C — env-absent execution (execution path, not resolver-only)", () => {
  it("Gemini session_only executes with NO GEMINI_API_KEY via the full selection+fallback path", async () => {
    vi.resetModules();
    const captured: string[] = [];
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => null, // no operator env key
      getGeminiImage: () => null,
      createGeminiClientWithKey: (key: string) => {
        captured.push(key);
        return { models: { generateContent: async () => ({ text: '{"ok":true}' }) } };
      },
    }));
    try {
      const provider = await import("../../server/ai/provider.js");
      const parse = await import("../../server/ai/parseSelectionMetadata.js");
      const session = await import("../../server/ai/sessionSecrets.js");
      session.setSessionSecret("gemini", SESSION);
      const sel = parse.parseTextSelectionHeader({
        "x-kitchen-ai-text-selection": JSON.stringify({
          mode: "user_selected",
          providerId: "gemini",
          modelId: "gemini-3.7-flash",
          credentialSource: "session_only",
        }),
      });
      const executable = provider.resolveExecutableTextCandidates("kitchenInterpret", undefined, sel);
      expect(executable).toHaveLength(1);
      const { result } = await provider.runWithAiFallback({
        candidates: executable,
        requiredCapabilities: ["structuredOutput"],
        run: (c: any) => c.provider.generateStructured("p", STRUCTURED_SCHEMA as any, { model: c.model }),
      });
      expect(result).toEqual({ ok: true });
      // The SESSION key was used; the env key was never required.
      expect(captured).toEqual([SESSION]);
    } finally {
      vi.doUnmock("../../server/geminiClient.js");
    }
  });

  it("DeepSeek session_only executes with NO DEEPSEEK_API_KEY (session-bound provider)", async () => {
    // NOTE: DeepSeek cannot satisfy any current structured operation (no
    // schema-constrained output), so it is capability-filtered out of the
    // selection layer for every existing operation. This test exercises the SAME
    // session-bound factory the selection layer uses, through a mocked
    // transport, proving the session key authorizes execution with no env key.
    const { credential, session } = await fresh({}); // no operator env keys
    session.setSessionSecret("deepseek", SESSION);
    const p = credential.createSessionBoundTextProvider("deepseek");
    expect(p).not.toBeNull();
    expect(p!.isAvailable()).toBe(true);

    const stub = stubFetch(200, { choices: [{ message: { content: "hello" } }] });
    try {
      const text = await p!.generate("prompt", { model: "deepseek-v4-flash" });
      expect(text).toBe("hello");
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].auth).toBe(`Bearer ${SESSION}`);
  });
});

describe("BYOK-5C — revoke stops future execution", () => {
  it("execute once, revoke, next request fails closed with zero provider calls", async () => {
    const { provider, parse, session } = await fresh({});
    session.setSessionSecret("openrouter", SESSION);
    const sel = textSelection(parse, {
      mode: "user_selected",
      providerId: "openrouter",
      credentialSource: "session_only",
    });

    const first = provider.resolveRoleCandidates("kitchenInterpret", undefined, sel);
    expect(first).toHaveLength(1);
    const stub = stubFetch();
    try {
      await provider.runWithAiFallback({
        candidates: first,
        requiredCapabilities: ["structuredOutput"],
        run: (c: any) => c.provider.generateStructured("p", STRUCTURED_SCHEMA as any, { model: c.model }),
      });
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);

    // Revoke, then a NEW request must fail closed (a fresh candidate list, since
    // request-scoped providers are never cached globally).
    session.revokeSessionSecret("openrouter");
    expect(provider.resolveRoleCandidates("kitchenInterpret", undefined, sel)).toHaveLength(0);
  });
});
