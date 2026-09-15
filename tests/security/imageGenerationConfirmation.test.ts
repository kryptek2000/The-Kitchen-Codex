import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ImagePreviewStore } from "../../server/imagePreviewStore.js";

/**
 * Phase 2 — server-enforced per-generation confirmation for paid/variable image
 * generation.
 *
 * Boots the REAL Express app with a pinned OpenRouter image provider and a
 * stubbed OpenRouter transport, then proves:
 *   - the quote makes ZERO provider calls and issues a single-use token;
 *   - generate without/with a forged/reused/mismatched token makes ZERO calls;
 *   - a valid token authorizes EXACTLY ONE provider call;
 *   - a consumed token never authorizes a second call;
 *   - a pricing-fingerprint change invalidates the token.
 */

const KEY = "sk-or-v1-PHASE2-CONFIRMATION-KEY";
const MODEL = "google/gemini-2.5-flash-image";
const IMAGE_HEADER = "x-kitchen-ai-image-selection";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
  "AI_ENDPOINT_TOKEN",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "HOST",
] as const;

const realFetch = globalThis.fetch.bind(globalThis);

function selectionHeader(overrides: Record<string, unknown> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [IMAGE_HEADER]: JSON.stringify({
      mode: "user_selected",
      providerId: "openrouter-image",
      modelId: MODEL,
      credentialSource: "server_environment",
      ...overrides,
    }),
  };
}

function openRouterStub(status = 429) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    calls.push(typeof input === "string" ? input : String((input as { url?: string })?.url));
    return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status });
  }) as unknown as typeof fetch;
  return { fetchMock, calls };
}

async function boot(env: Record<string, string>, fetchImpl?: typeof fetch, store?: ImagePreviewStore) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const { createApp } = await import("../../server/app.js");
  const app = createApp({ isProduction: false, ...(store ? { imagePreviewStore: store } : {}) });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function quote(baseUrl: string, headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const res = await realFetch(`${baseUrl}/api/recipes/image/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function generate(baseUrl: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await realFetch(`${baseUrl}/api/recipes/image/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("Phase 2 — image generation quote + confirmation enforcement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  it("quote makes ZERO provider calls and issues a token for a variable model", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup", recipeContentHash: "a".repeat(64) });
      expect(q.status).toBe(200);
      expect(q.body["requiresConfirmation"]).toBe(true);
      expect(q.body["costClass"]).toBe("variable");
      expect(typeof q.body["confirmationToken"]).toBe("string");
      expect(q.body["model"]).toBe(MODEL);
      // The quote never contacted the provider.
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("missing token -> 409 IMAGE_CONFIRMATION_REQUIRED with ZERO provider calls", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const res = await generate(app.baseUrl, selectionHeader(), { title: "Soup" });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_REQUIRED");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("forged token -> 409 IMAGE_CONFIRMATION_INVALID with ZERO provider calls", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const res = await generate(app.baseUrl, selectionHeader(), {
        title: "Soup",
        confirmationToken: "forged-token",
      });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a valid token authorizes EXACTLY ONE provider call; reuse is rejected", async () => {
    const stub = openRouterStub(429);
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const first = await generate(app.baseUrl, selectionHeader(), { title: "Soup", confirmationToken: token });
      // The provider executed once and returned a bounded rate-limit failure.
      expect(first.status).toBe(503);
      expect(first.body["code"]).toBe("IMAGE_PROVIDER_RATE_LIMIT");
      expect(stub.calls).toHaveLength(1);

      // The consumed token can NEVER authorize a second call.
      const second = await generate(app.baseUrl, selectionHeader(), { title: "Soup", confirmationToken: token });
      expect(second.status).toBe(409);
      expect(second.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("a substituted recipe (title swap) invalidates the token with ZERO provider calls", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      // Cross-recipe substitution: the server recomputes the canonical binding
      // from the ACTUAL generate fields — a client-supplied hash is not needed
      // for the mismatch to fail closed.
      const res = await generate(app.baseUrl, selectionHeader(), {
        title: "Completely Different Dish",
        confirmationToken: token,
      });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a quote without canonical inputs is rejected before any authorization", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const q = await quote(app.baseUrl, selectionHeader(), {});
      expect(q.status).toBe(400);
      expect(q.body["code"]).toBe("INVALID_REQUEST");
      expect(q.body["confirmationToken"]).toBeUndefined();
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a draft-scope quote cannot authorize a vault-scoped generation (explicit scopes)", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(app.baseUrl, selectionHeader(), {
        title: "Soup",
        vaultSessionId: "session-A",
        confirmationToken: token,
      });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a vault-session mismatch invalidates the token with ZERO provider calls", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup", vaultSessionId: "session-A" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(app.baseUrl, selectionHeader(), {
        title: "Soup",
        vaultSessionId: "session-B",
        confirmationToken: token,
      });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a model mismatch invalidates the token with ZERO provider calls", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(
        app.baseUrl,
        selectionHeader({ modelId: "bytedance-seed/seedream-4.5" }),
        { title: "Soup", confirmationToken: token }
      );
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a pricing-fingerprint change invalidates the token with ZERO provider calls", async () => {
    const stub = openRouterStub();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const catalog = await import("../../server/ai/openRouterCatalog.js");
      const paid = (imageOutput: string) => ({
        data: [
          {
            id: MODEL,
            name: "Image",
            context_length: 8192,
            architecture: { input_modalities: ["text"], output_modalities: ["image"] },
            pricing: { prompt: "0.00001", completion: "0.00003", image_output: imageOutput },
            supported_parameters: ["temperature"],
          },
        ],
      });
      catalog.resetOpenRouterCatalogForTests();
      await catalog.refreshOpenRouterCatalog({
        force: true,
        fetchFn: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(paid("0.00006")) })) as never,
      });
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      expect(q.body["costClass"]).toBe("paid");

      // Price changes before generate -> the bound fingerprint no longer matches.
      catalog.resetOpenRouterCatalogForTests();
      await catalog.refreshOpenRouterCatalog({
        force: true,
        fetchFn: (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(paid("0.00009")) })) as never,
      });
      const res = await generate(app.baseUrl, selectionHeader(), { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a verified zero-price model skips confirmation (no token required)", async () => {
    const stub = openRouterStub(429);
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const catalog = await import("../../server/ai/openRouterCatalog.js");
      catalog.resetOpenRouterCatalogForTests();
      await catalog.refreshOpenRouterCatalog({
        force: true,
        fetchFn: (async () => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [
                {
                  id: MODEL,
                  name: "Image",
                  context_length: 8192,
                  architecture: { input_modalities: ["text"], output_modalities: ["image"] },
                  pricing: { prompt: "0", completion: "0", image_output: "0" },
                  supported_parameters: ["temperature"],
                },
              ],
            }),
        })) as never,
      });
      const q = await quote(app.baseUrl, selectionHeader(), { title: "Soup" });
      expect(q.body["requiresConfirmation"]).toBe(false);
      expect(q.body["confirmationToken"]).toBeUndefined();
      const res = await generate(app.baseUrl, selectionHeader(), { title: "Soup" });
      // Provider executed (no token needed) and returned the bounded 429.
      expect(res.status).toBe(503);
      expect(stub.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("Phase 2 — authorization is bound to the exact credential generation", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  async function sessionSecrets() {
    return import("../../server/ai/sessionSecrets.js");
  }
  async function capabilityStore() {
    return import("../../server/ai/capabilityVerificationStore.js");
  }

  it("session key REPLACED after quote -> zero provider calls", async () => {
    const stub = openRouterStub(429);
    const app = await boot({}, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      const first = session.setSessionSecret("openrouter-image", "SESSION_KEY_A");
      const headers = selectionHeader({ credentialSource: "session_only" });
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      expect(typeof token).toBe("string");
      // Replace the session key (bumps the opaque credential generation).
      session.setSessionSecret("openrouter-image", "SESSION_KEY_B", first.version);
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("session key REVOKED after quote -> zero provider calls", async () => {
    const stub = openRouterStub(429);
    const app = await boot({}, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      session.setSessionSecret("openrouter-image", "SESSION_KEY_A");
      const headers = selectionHeader({ credentialSource: "session_only" });
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      session.revokeSessionSecret("openrouter-image");
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      // The session key is gone: the provider no longer resolves (fail closed).
      expect(res.status).toBe(503);
      expect(res.body["code"]).toBe("IMAGE_PROVIDER_NOT_CONFIGURED");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("an EXPIRY/LAZY-PURGE generation bump after quote -> zero provider calls", async () => {
    const stub = openRouterStub(429);
    const app = await boot({}, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      const capability = await capabilityStore();
      session.setSessionSecret("openrouter-image", "SESSION_KEY_A");
      const headers = selectionHeader({ credentialSource: "session_only" });
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      // Expiry and lazy purge both bump the same opaque generation.
      capability.bumpCredentialGeneration("openrouter-image");
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("session-only quote followed by SERVER-ENVIRONMENT selection -> zero calls", async () => {
    const stub = openRouterStub(429);
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      session.setSessionSecret("openrouter-image", "SESSION_KEY_A");
      const sessionHeaders = selectionHeader({ credentialSource: "session_only" });
      const q = await quote(app.baseUrl, sessionHeaders, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(
        app.baseUrl,
        selectionHeader({ credentialSource: "server_environment" }),
        { title: "Soup", confirmationToken: token }
      );
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("server-environment quote followed by SESSION-ONLY selection -> zero calls", async () => {
    const stub = openRouterStub(429);
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      const envHeaders = selectionHeader({ credentialSource: "server_environment" });
      const q = await quote(app.baseUrl, envHeaders, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      session.setSessionSecret("openrouter-image", "SESSION_KEY_A");
      const res = await generate(
        app.baseUrl,
        selectionHeader({ credentialSource: "session_only" }),
        { title: "Soup", confirmationToken: token }
      );
      expect(res.status).toBe(409);
      expect(res.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("ANOTHER provider's key rotation does not invalidate this provider's token", async () => {
    const stub = openRouterStub(429);
    const app = await boot({}, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      session.setSessionSecret("openrouter-image", "SESSION_KEY_A");
      const headers = selectionHeader({ credentialSource: "session_only" });
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      // Rotate a DIFFERENT image provider's session key.
      const gemini = session.setSessionSecret("gemini-image", "OTHER_KEY");
      session.setSessionSecret("gemini-image", "OTHER_KEY_2", gemini.version);
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(503); // provider executed (bounded 429), token accepted
      expect(res.body["code"]).toBe("IMAGE_PROVIDER_RATE_LIMIT");
      expect(stub.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("TEXT-provider key rotation does not affect an image-provider token", async () => {
    const stub = openRouterStub(429);
    const app = await boot({}, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      session.setSessionSecret("openrouter-image", "SESSION_KEY_A");
      const headers = selectionHeader({ credentialSource: "session_only" });
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      // Rotate the TEXT provider's session key (distinct provider id).
      session.setSessionSecret("openrouter", "TEXT_KEY");
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(503);
      expect(res.body["code"]).toBe("IMAGE_PROVIDER_RATE_LIMIT");
      expect(stub.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("environment credential generation stays stable across unrelated session activity", async () => {
    const stub = openRouterStub(429);
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock);
    try {
      const session = await sessionSecrets();
      const capability = await capabilityStore();
      const headers = selectionHeader({ credentialSource: "server_environment" });
      const generationBefore = capability.getCredentialGeneration("openrouter-image");
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      session.setSessionSecret("gemini-image", "OTHER_KEY");
      session.revokeSessionSecret("gemini-image");
      expect(capability.getCredentialGeneration("openrouter-image")).toBe(generationBefore);
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(503);
      expect(res.body["code"]).toBe("IMAGE_PROVIDER_RATE_LIMIT");
      expect(stub.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("Phase 2 — preview capacity reservation before a billable call", () => {
  const VALID_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  it("a FULL store -> 503 PREVIEW_CAPACITY, zero calls, and the token is NOT consumed (safe retry)", async () => {
    const stub = openRouterStub(429);
    const store = new ImagePreviewStore({ maxEntries: 1 });
    store.insert({ bytes: new Uint8Array(20), contentType: "image/png", provider: "x", model: "y" });
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock, store);
    try {
      const headers = selectionHeader({});
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const blocked = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(blocked.status).toBe(503);
      expect(blocked.body["code"]).toBe("PREVIEW_CAPACITY");
      expect(stub.calls).toHaveLength(0);

      // Free capacity: the SAME token still authorizes exactly one call.
      store.clear();
      const retry = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(retry.status).toBe(503);
      expect(retry.body["code"]).toBe("IMAGE_PROVIDER_RATE_LIMIT");
      expect(stub.calls).toHaveLength(1);
    } finally {
      store.dispose();
      await app.close();
    }
  });

  it("insufficient worst-case byte capacity -> zero provider calls", async () => {
    const stub = openRouterStub(429);
    const store = new ImagePreviewStore({ maxTotalBytes: 5 * 1024 * 1024 });
    store.insert({
      bytes: new Uint8Array(1024 * 1024 + 1),
      contentType: "image/png",
      provider: "x",
      model: "y",
    });
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock, store);
    try {
      const headers = selectionHeader({});
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(503);
      expect(res.body["code"]).toBe("PREVIEW_CAPACITY");
      expect(stub.calls).toHaveLength(0);
    } finally {
      store.dispose();
      await app.close();
    }
  });

  it("a provider failure releases the reservation (capacity not leaked)", async () => {
    const stub = openRouterStub(429);
    const store = new ImagePreviewStore();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, stub.fetchMock, store);
    try {
      const headers = selectionHeader({});
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(503);
      expect(store.stats().reservedBytes).toBe(0);
      expect(store.stats().reservedCount).toBe(0);
    } finally {
      store.dispose();
      await app.close();
    }
  });

  it("an invalid MIME/image releases the reservation", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: VALID_PNG_B64, media_type: "image/jpeg" }] }), {
        status: 200,
      })
    ) as unknown as typeof fetch;
    const store = new ImagePreviewStore();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, fetchMock, store);
    try {
      const headers = selectionHeader({});
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(502);
      expect(res.body["code"]).toBe("INVALID_IMAGE");
      expect(store.stats().reservedBytes).toBe(0);
      expect(store.stats().count).toBe(0);
    } finally {
      store.dispose();
      await app.close();
    }
  });

  it("a successful result commits the ACTUAL bytes and releases unused capacity", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: VALID_PNG_B64, media_type: "image/png" }] }), {
        status: 200,
      })
    ) as unknown as typeof fetch;
    const store = new ImagePreviewStore();
    const app = await boot({ OPENROUTER_API_KEY: KEY }, fetchMock, store);
    try {
      const headers = selectionHeader({});
      const q = await quote(app.baseUrl, headers, { title: "Soup" });
      const token = q.body["confirmationToken"] as string;
      const res = await generate(app.baseUrl, headers, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(200);
      expect(store.stats().count).toBe(1);
      expect(store.stats().reservedBytes).toBe(0);
      expect(store.stats().reservedCount).toBe(0);
      const expectedBytes = new Uint8Array(Buffer.from(VALID_PNG_B64, "base64")).length;
      expect(store.stats().totalBytes).toBe(expectedBytes);
    } finally {
      store.dispose();
      await app.close();
    }
  });
});
