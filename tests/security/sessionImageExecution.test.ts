import { describe, it, expect, afterEach, vi } from "vitest";
import { MODEL_CONFIG } from "../../server/modelConfig.js";

/**
 * BYOK-5F — session-only IMAGE generation runtime.
 *
 * Proves request-scoped image credential binding, exact provider isolation,
 * credential precedence, fail-closed behavior, and no secret leakage. No real
 * provider is called (mocked SDK/fetch).
 */

const SESSION = "SESSION_IMG_SENTINEL_5F";
const ENV = "ENV_IMG_SENTINEL_5F";
const VALID_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
  "K_SERVICE",
  "HOST",
] as const;

function prepareEnv(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

async function imports() {
  const effective = await import("../../server/ai/effectiveSelection.js");
  const session = await import("../../server/ai/sessionSecrets.js");
  const parse = await import("../../server/ai/parseSelectionMetadata.js");
  const registry = await import("../../server/ai/imageProviderRegistry.js");
  return { effective, session, parse, registry };
}

type Parse = Awaited<ReturnType<typeof imports>>["parse"];
function imageIntent(parse: Parse, payload: Record<string, unknown>) {
  return parse.parseImageSelectionHeader({
    "x-kitchen-ai-image-selection": JSON.stringify(payload),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock("../../server/geminiClient.js");
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

describe("BYOK-5F — session image execution", () => {
  it("A. gemini-image + session_only uses the SESSION credential via a request-scoped client with the IMAGE timeout", async () => {
    prepareEnv({});
    const captured: { key: string; timeout: number }[] = [];
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => null,
      getGeminiImage: () => null, // no operator env key
      createGeminiClientWithKey: (key: string, timeoutMs: number) => {
        captured.push({ key, timeout: timeoutMs });
        return {
          models: {
            generateContent: async () => ({
              candidates: [{ content: { parts: [{ inlineData: { data: VALID_PNG_B64, mimeType: "image/png" } }] } }],
            }),
          },
        };
      },
    }));
    try {
      const { effective, session, parse } = await imports();
      session.setSessionSecret("gemini-image", SESSION);
      const result = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "gemini-image", credentialSource: "session_only" })
      );
      expect(result.provider?.id).toBe("gemini-image");
      const img = await result.provider!.generateImage("prompt", { model: "gemini-2.5-flash-image", prompt: "prompt" });
      expect(img.provider).toBe("gemini-image");
      expect(img.contentType).toBe("image/png");
      // The SESSION key is used AND the IMAGE timeout (60s) — not the 25s text one.
      expect(captured).toEqual([{ key: SESSION, timeout: MODEL_CONFIG.imageGenerationTimeoutMs }]);
      expect(MODEL_CONFIG.imageGenerationTimeoutMs).not.toBe(MODEL_CONFIG.requestTimeoutMs);
    } finally {
      vi.doUnmock("../../server/geminiClient.js");
    }
  });

  it("B. openrouter-image + session_only sends the SESSION bearer to the FIXED image endpoint (body carries no key)", async () => {
    prepareEnv({});
    const calls: { url: string; auth?: string; body?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      calls.push({
        url: typeof input === "string" ? input : input.url,
        auth: init?.headers?.Authorization,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ data: [{ b64_json: VALID_PNG_B64, media_type: "image/png" }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const { effective, session, parse } = await imports();
      session.setSessionSecret("openrouter-image", SESSION);
      const result = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" })
      );
      expect(result.provider?.id).toBe("openrouter-image");
      const img = await result.provider!.generateImage("prompt", { model: "google/gemini-2.5-flash-image", prompt: "prompt" });
      expect(img.contentType).toBe("image/png");
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/images");
    expect(calls[0].auth).toBe(`Bearer ${SESSION}`);
    expect(calls[0].body).not.toContain(SESSION);
  });

  it("C. gemini-image never consumes the gemini TEXT session credential", async () => {
    prepareEnv({});
    const { effective, session, parse } = await imports();
    session.setSessionSecret("gemini", SESSION); // TEXT id only
    const result = effective.resolveEffectiveImageSelection(
      imageIntent(parse, { mode: "user_selected", providerId: "gemini-image", credentialSource: "session_only" })
    );
    expect(result.provider).toBeNull();
  });

  it("D. openrouter-image never consumes the openrouter TEXT session credential", async () => {
    prepareEnv({});
    const { effective, session, parse } = await imports();
    session.setSessionSecret("openrouter", SESSION); // TEXT id only
    const result = effective.resolveEffectiveImageSelection(
      imageIntent(parse, { mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" })
    );
    expect(result.provider).toBeNull();
  });

  it("E. missing image session key -> fail closed (provider null), ZERO env fallback", async () => {
    prepareEnv({ GEMINI_API_KEY: ENV, OPENROUTER_API_KEY: ENV }); // env keys present
    const { effective, parse } = await imports();
    const gemini = effective.resolveEffectiveImageSelection(
      imageIntent(parse, { mode: "user_selected", providerId: "gemini-image", credentialSource: "session_only" })
    );
    const openrouter = effective.resolveEffectiveImageSelection(
      imageIntent(parse, { mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" })
    );
    expect(gemini.provider).toBeNull();
    expect(openrouter.provider).toBeNull();
  });

  it("F. expired/revoked image session key -> fail closed", async () => {
    prepareEnv({});
    {
      const { effective, session, parse } = await imports();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      session.setSessionSecret("gemini-image", SESSION);
      vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));
      const expired = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "gemini-image", credentialSource: "session_only" })
      );
      expect(expired.provider).toBeNull();
    }
    prepareEnv({});
    {
      const { effective, session, parse } = await imports();
      session.setSessionSecret("openrouter-image", SESSION);
      session.revokeSessionSecret("openrouter-image");
      const revoked = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" })
      );
      expect(revoked.provider).toBeNull();
    }
  });

  it("G. operator pin wins: session key present is ignored; the pinned ENV credential is used", async () => {
    prepareEnv({
      OPENROUTER_API_KEY: ENV,
      KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
    });
    const calls: { auth?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: any, init?: any) => {
      calls.push({ auth: init?.headers?.Authorization });
      return new Response(JSON.stringify({ data: [{ b64_json: VALID_PNG_B64, media_type: "image/png" }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const { effective, session, parse } = await imports();
      session.setSessionSecret("openrouter-image", SESSION);
      const result = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "gemini-image", credentialSource: "session_only" })
      );
      expect(result.source).toBe("server_managed");
      expect(result.provider?.id).toBe("openrouter-image");
      await result.provider!.generateImage("prompt", { model: "google/gemini-2.5-flash-image", prompt: "prompt" });
    } finally {
      globalThis.fetch = original;
    }
    // The ENV credential is used; the session credential is NOT.
    expect(calls[0].auth).toBe(`Bearer ${ENV}`);
  });

  it("H. server_default never consumes a session credential (registry default used)", async () => {
    prepareEnv({});
    const { effective, session, registry } = await imports();
    session.setSessionSecret("gemini-image", SESSION);
    const result = effective.resolveEffectiveImageSelection(undefined);
    expect(result.source).toBe("server_default");
    // The registry singleton (env/default path) — not a session-bound instance.
    expect(result.provider).toBe(registry.getRegisteredImageProviders()[0].provider);
  });

  it("I. server_environment selection uses the ENV provider and never the session credential", async () => {
    prepareEnv({ GEMINI_API_KEY: ENV });
    const { effective, session, registry, parse } = await imports();
    session.setSessionSecret("gemini-image", SESSION);
    const result = effective.resolveEffectiveImageSelection(
      imageIntent(parse, { mode: "user_selected", providerId: "gemini-image", credentialSource: "server_environment" })
    );
    expect(result.source).toBe("user_selected");
    const registered = registry.getRegisteredImageProviders().find((r) => r.provider.id === "gemini-image")!;
    expect(result.provider).toBe(registered.provider);
  });

  it("K. an explicit session image provider AUTH failure does not fall through to another provider", async () => {
    prepareEnv({ GEMINI_API_KEY: ENV, OPENROUTER_API_KEY: ENV });
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      calls.push(typeof input === "string" ? input : input.url);
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const { effective, session, parse } = await imports();
      session.setSessionSecret("openrouter-image", SESSION);
      const result = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" })
      );
      await expect(
        result.provider!.generateImage("prompt", { model: "google/gemini-2.5-flash-image", prompt: "prompt" })
      ).rejects.toMatchObject({ code: "AUTH" });
    } finally {
      globalThis.fetch = original;
    }
    // Only the explicitly selected provider was contacted (no Gemini fallback).
    expect(calls).toEqual(["https://openrouter.ai/api/v1/images"]);
  });

  it("J. the session image key never appears in a successful result", async () => {
    prepareEnv({});
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: VALID_PNG_B64, media_type: "image/png" }] }), { status: 200 })) as unknown as typeof globalThis.fetch;
    try {
      const { effective, session, parse } = await imports();
      session.setSessionSecret("openrouter-image", SESSION);
      const result = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "openrouter-image", credentialSource: "session_only" })
      );
      const img = await result.provider!.generateImage("prompt", { model: "google/gemini-2.5-flash-image", prompt: "prompt" });
      expect(JSON.stringify(img)).not.toContain(SESSION);
    } finally {
      globalThis.fetch = original;
    }
  });
});
