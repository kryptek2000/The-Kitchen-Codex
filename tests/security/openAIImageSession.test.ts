import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * P2 — OpenAI image session-credential isolation + explicit reuse.
 *
 * Proves:
 *   - `openai-image` session_only executes with a REQUEST-SCOPED provider bound to
 *     the image id's own session secret (fixed OpenAI endpoint);
 *   - the OpenAI TEXT session key (`openai`) is NEVER consumed by `openai-image`
 *     (and vice versa);
 *   - the explicit reuse pair copies the key into a SEPARATE entry and either
 *     side remains independently revocable;
 *   - any non-reviewed pair is rejected with no target entry.
 *
 * No real provider/network call is made (mocked fetch).
 */

const SESSION = "SESSION_OPENAI_IMG_SENTINEL_P2";
const VALID_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
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
  const resolver = await import("../../server/ai/credentialResolver.js");
  return { effective, session, parse, resolver };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

function imageIntent(parse: Awaited<ReturnType<typeof imports>>["parse"], payload: Record<string, unknown>) {
  return parse.parseImageSelectionHeader({
    "x-kitchen-ai-image-selection": JSON.stringify(payload),
  });
}

describe("P2 — OpenAI image session execution isolation", () => {
  it("openai-image + session_only uses the IMAGE id's session key against the fixed endpoint", async () => {
    prepareEnv({});
    const calls: { url: string; auth?: string; body?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      calls.push({
        url: typeof input === "string" ? input : input.url,
        auth: init?.headers?.Authorization,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: VALID_PNG_B64 }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const { effective, session, parse } = await imports();
      session.setSessionSecret("openai-image", SESSION);
      const result = effective.resolveEffectiveImageSelection(
        imageIntent(parse, { mode: "user_selected", providerId: "openai-image", credentialSource: "session_only" })
      );
      expect(result.provider?.id).toBe("openai-image");
      expect(result.credentialSource).toBe("session_only");
      const img = await result.provider!.generateImage("prompt", {
        model: "gpt-image-2.6-flare",
        prompt: "prompt",
      });
      expect(img.contentType).toBe("image/png");
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0].auth).toBe(`Bearer ${SESSION}`);
    expect(calls[0].body).not.toContain(SESSION);
  });

  it("openai-image NEVER consumes the OpenAI TEXT session credential", async () => {
    prepareEnv({});
    const { effective, session, parse } = await imports();
    session.setSessionSecret("openai", SESSION); // TEXT id only
    const result = effective.resolveEffectiveImageSelection(
      imageIntent(parse, { mode: "user_selected", providerId: "openai-image", credentialSource: "session_only" })
    );
    expect(result.provider).toBeNull();
  });

  it("the OpenAI TEXT provider NEVER consumes the openai-image session credential", async () => {
    prepareEnv({});
    const { session, resolver } = await imports();
    session.setSessionSecret("openai-image", SESSION); // IMAGE id only
    expect(resolver.createSessionBoundTextProvider("openai")).toBeNull();
    expect(resolver.createSessionBoundImageProvider("openai-image")?.id).toBe("openai-image");
  });
});

describe("P2 — explicit session-key reuse between the OpenAI text/image ids", () => {
  it("copies the live key into a SEPARATE image entry; both stay independently revocable", async () => {
    prepareEnv({});
    const { session } = await imports();
    session.setSessionSecret("openai", SESSION);

    const status = session.reuseSessionSecret("openai", "openai-image");
    expect(status.providerId).toBe("openai-image");
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(SESSION);

    expect(session.getSessionSecret("openai")).toBe(SESSION);
    expect(session.getSessionSecret("openai-image")).toBe(SESSION);

    // Revoking the source must NOT revoke the copied target.
    session.revokeSessionSecret("openai");
    expect(session.getSessionSecret("openai")).toBeUndefined();
    expect(session.getSessionSecret("openai-image")).toBe(SESSION);

    // And the target can be revoked without touching a (new) source key.
    session.setSessionSecret("openai", SESSION);
    session.revokeSessionSecret("openai-image");
    expect(session.getSessionSecret("openai-image")).toBeUndefined();
    expect(session.getSessionSecret("openai")).toBe(SESSION);
  });

  it("reuse is available in the reverse direction (image -> text) for the reviewed pair", async () => {
    prepareEnv({});
    const { session } = await imports();
    session.setSessionSecret("openai-image", SESSION);
    const status = session.reuseSessionSecret("openai-image", "openai");
    expect(status.providerId).toBe("openai");
    expect(session.getSessionSecret("openai")).toBe(SESSION);
  });

  it("a missing source key fails with SESSION_CREDENTIAL_MISSING and creates NO target", async () => {
    prepareEnv({});
    const { session } = await imports();
    const err = (() => {
      try {
        session.reuseSessionSecret("openai", "openai-image");
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({ code: "SESSION_CREDENTIAL_MISSING" });
    expect(session.getSessionSecret("openai-image")).toBeUndefined();
  });

  it("rejects any non-reviewed pair (e.g. gemini -> openai-image) and creates NO target", async () => {
    prepareEnv({});
    const { session } = await imports();
    session.setSessionSecret("gemini", SESSION);
    const err = (() => {
      try {
        session.reuseSessionSecret("gemini", "openai-image");
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({ code: "PROVIDER_NOT_ALLOWED" });
    expect(session.getSessionSecret("openai-image")).toBeUndefined();
    expect(session.canReuseSessionSecret("gemini", "openai-image")).toBe(false);
    expect(session.canReuseSessionSecret("openai", "openai-image")).toBe(true);
  });
});
