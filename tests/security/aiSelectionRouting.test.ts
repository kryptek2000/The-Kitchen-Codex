import { describe, it, expect, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

/**
 * BYOK-4 AUDIT CORRECTION — ROUTE-LEVEL selection-header routing.
 *
 * Proves the per-request `x-kitchen-ai-text-selection` / `x-kitchen-ai-image-
 * selection` header reaches runtime provider resolution:
 *   - a VALID selected provider is executed even when Gemini is unavailable,
 *   - the ALTERNATE provider is NOT executed (no cross-provider execution),
 *   - an INVALID selection fails closed to the deterministic path.
 */

const SENTINEL = "SUPER_SECRET_BYOK4_ROUTING";
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "AI_ENDPOINT_TOKEN",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
] as const;

const TEXT_HEADER = "x-kitchen-ai-text-selection";
const IMAGE_HEADER = "x-kitchen-ai-image-selection";

async function startApp(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const { createApp } = await import("../../server/app.js");
  const app = createApp({ isProduction: false });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/**
 * Stubs global fetch so ONLY OpenRouter host traffic is intercepted; all other
 * requests (including the test's own localhost calls) pass through untouched.
 */
function stubOpenRouter(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (typeof url === "string" && url.startsWith("https://openrouter.ai/")) {
      calls.push({ url, method: (init?.method ?? "GET") as string });
      return handler(url, init);
    }
    return original(input, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A minimal valid KitchenIntent the OpenRouter structured probe can return. */
function intentContent(): string {
  return JSON.stringify({
    version: 1,
    intent: "find_recipes",
    source: "vault",
    constraints: { includeIngredients: ["chicken"] },
    preferences: {},
    requiresClarification: false,
  });
}

function openRouterTextResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: intentContent() } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../../server/geminiClient.js");
  vi.resetModules();
});

describe("BYOK-4 audit — TEXT selection header reaches runtime routing", () => {
  it("Gemini UNAVAILABLE + a VALID OpenRouter selection => OpenRouter executes (deterministic-only is NOT forced)", async () => {
    // GEMINI_API_KEY intentionally absent: the legacy default-provider gate would
    // have skipped AI entirely and gone deterministic.
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => openRouterTextResponse());
    try {
      const res = await fetch(`${baseUrl}/api/kitchen/interpret`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TEXT_HEADER]: JSON.stringify({
            mode: "user_selected",
            providerId: "openrouter",
            modelId: "openai/gpt-4o-mini",
          }),
        },
        body: JSON.stringify({ question: "what can I make with chicken" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.source).toBe("ai");
      expect(body.aiAttempted).toBe(true);

      // The SELECTED provider executed, against its FIXED endpoint.
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a selected OpenRouter provider executes and Gemini is NOT invoked when both are configured", async () => {
    let geminiCalls = 0;
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => ({
        models: {
          generateContent: async () => {
            geminiCalls += 1;
            return { text: intentContent() };
          },
          list: async () => ({}),
        },
      }),
      getGeminiImage: () => ({
        models: {
          generateContent: async () => {
            geminiCalls += 1;
            return { text: "" };
          },
          list: async () => ({}),
        },
      }),
    }));

    const { server, baseUrl } = await startApp({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
    });
    const stub = stubOpenRouter(async () => openRouterTextResponse());
    try {
      const res = await fetch(`${baseUrl}/api/kitchen/interpret`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TEXT_HEADER]: JSON.stringify({
            mode: "user_selected",
            providerId: "openrouter",
            modelId: "openai/gpt-4o-mini",
          }),
        },
        body: JSON.stringify({ question: "what can I make with chicken" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).source).toBe("ai");
      // Selected provider executed; the ALTERNATE (Gemini) provider did not.
      expect(stub.calls).toHaveLength(1);
      expect(geminiCalls).toBe(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("an INVALID explicit selection fails closed to the deterministic path (no cross-provider execution)", async () => {
    let geminiCalls = 0;
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => ({
        models: {
          generateContent: async () => {
            geminiCalls += 1;
            return { text: intentContent() };
          },
          list: async () => ({}),
        },
      }),
      getGeminiImage: () => ({ models: { list: async () => ({}) } }),
    }));

    const { server, baseUrl } = await startApp({ GEMINI_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => openRouterTextResponse());
    try {
      const res = await fetch(`${baseUrl}/api/kitchen/interpret`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TEXT_HEADER]: JSON.stringify({
            mode: "user_selected",
            providerId: "openrouter",
            modelId: "openai/gpt-4o-mini",
          }),
        },
        body: JSON.stringify({ question: "what can I make with chicken" }),
      });
      // OpenRouter is unavailable (no key) => explicit selection fails closed,
      // never silently running Gemini. Deterministic interpretation still works.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("deterministic");
      expect(body.aiAttempted).toBe(false);
      expect(stub.calls).toHaveLength(0);
      expect(geminiCalls).toBe(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("BYOK-4 audit — STRICT malformed selection intent fails closed at the route", () => {
  it("TEXT: a malformed present header never falls through to a paid provider", async () => {
    let geminiCalls = 0;
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => ({
        models: {
          generateContent: async () => {
            geminiCalls += 1;
            return { text: intentContent() };
          },
          list: async () => ({}),
        },
      }),
      getGeminiImage: () => ({ models: { list: async () => ({}) } }),
    }));

    const { server, baseUrl } = await startApp({ GEMINI_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => openRouterTextResponse());
    try {
      const res = await fetch(`${baseUrl}/api/kitchen/interpret`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TEXT_HEADER]: "{not json",
        },
        body: JSON.stringify({ question: "what can I make with chicken" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Fail closed to the deterministic path; neither provider executed.
      expect(body.source).toBe("deterministic");
      expect(body.aiAttempted).toBe(false);
      expect(geminiCalls).toBe(0);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("IMAGE: a malformed present header yields a bounded IMAGE_SELECTION_INVALID failure with ZERO provider calls", async () => {
    const { server, baseUrl } = await startApp({ GEMINI_API_KEY: SENTINEL, OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => new Response("{}", { status: 200 }));
    try {
      const res = await fetch(`${baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [IMAGE_HEADER]: JSON.stringify({ mode: "user_selected" }), // missing provider
        },
        body: JSON.stringify({ title: "Hearty Soup" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("IMAGE_SELECTION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("TEXT: malformed JSON + a VALID server pin still executes ZERO providers (pin cannot rescue INVALID)", async () => {
    let geminiCalls = 0;
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => ({
        models: {
          generateContent: async () => {
            geminiCalls += 1;
            return { text: intentContent() };
          },
          list: async () => ({}),
        },
      }),
      getGeminiImage: () => ({ models: { list: async () => ({}) } }),
    }));
    const { server, baseUrl } = await startApp({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash",
    });
    const stub = stubOpenRouter(async () => openRouterTextResponse());
    try {
      const res = await fetch(`${baseUrl}/api/kitchen/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [TEXT_HEADER]: "{not json" },
        body: JSON.stringify({ question: "what can I make with chicken" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("deterministic");
      expect(geminiCalls).toBe(0);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("TEXT: oversized header + a VALID server pin still executes ZERO providers", async () => {
    let geminiCalls = 0;
    vi.doMock("../../server/geminiClient.js", () => ({
      getGemini: () => ({
        models: {
          generateContent: async () => {
            geminiCalls += 1;
            return { text: intentContent() };
          },
          list: async () => ({}),
        },
      }),
      getGeminiImage: () => ({ models: { list: async () => ({}) } }),
    }));
    const { server, baseUrl } = await startApp({
      GEMINI_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
    });
    const stub = stubOpenRouter(async () => openRouterTextResponse());
    try {
      const res = await fetch(`${baseUrl}/api/kitchen/interpret`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TEXT_HEADER]: JSON.stringify({ providerId: "x".repeat(2000) }),
        },
        body: JSON.stringify({ question: "what can I make with chicken" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).source).toBe("deterministic");
      expect(geminiCalls).toBe(0);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("IMAGE: an empty-object header + a VALID image pin yields IMAGE_SELECTION_INVALID with ZERO calls", async () => {
    const { server, baseUrl } = await startApp({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_IMAGE_PROVIDER: "gemini-image",
    });
    const stub = stubOpenRouter(async () => new Response("{}", { status: 200 }));
    try {
      const res = await fetch(`${baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [IMAGE_HEADER]: "{}" },
        body: JSON.stringify({ title: "Hearty Soup" }),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("IMAGE_SELECTION_INVALID");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("BYOK-5D: an explicit session_only image intent cannot generate an image (image runtime deferred)", async () => {
    const { server, baseUrl } = await startApp({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
    });
    const stub = stubOpenRouter(async () => new Response("{}", { status: 200 }));
    try {
      const res = await fetch(`${baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [IMAGE_HEADER]: JSON.stringify({
            mode: "user_selected",
            providerId: "openrouter-image",
            credentialSource: "session_only",
          }),
        },
        body: JSON.stringify({ title: "Hearty Soup" }),
      });
      // Image session RUNTIME remains blocked: fail closed, no provider call.
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("IMAGE_PROVIDER_NOT_CONFIGURED");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("BYOK-4 audit — IMAGE selection header reaches runtime routing", () => {
  it("a VALID OpenRouter-image selection executes OpenRouter images (Gemini image is NOT used)", async () => {
    // No GEMINI_API_KEY: if the selection were ignored, the safe default
    // (Gemini image) would fail IMAGE_PROVIDER_NOT_CONFIGURED. Instead the
    // selected OpenRouter image provider executes (stubbed 429 -> bounded).
    const { server, baseUrl } = await startApp({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubOpenRouter(
      async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
    );
    try {
      const res = await fetch(`${baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [IMAGE_HEADER]: JSON.stringify({
            mode: "user_selected",
            providerId: "openrouter-image",
            modelId: "google/gemini-2.5-flash-image",
          }),
        },
        body: JSON.stringify({ title: "Hearty Soup" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      // Provider executed against its FIXED image endpoint (not the Gemini
      // default, which would have produced IMAGE_PROVIDER_NOT_CONFIGURED).
      expect(body.code).toBe("IMAGE_PROVIDER_RATE_LIMIT");
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/images");
      expect(stub.calls[0].method).toBe("POST");
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("an INVALID explicit image selection fails closed (no provider executes)", async () => {
    const { server, baseUrl } = await startApp({ GEMINI_API_KEY: SENTINEL });
    const stub = stubOpenRouter(async () => new Response("{}", { status: 200 }));
    try {
      const res = await fetch(`${baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [IMAGE_HEADER]: JSON.stringify({
            mode: "user_selected",
            providerId: "openrouter-image",
            modelId: "google/gemini-2.5-flash-image",
          }),
        },
        body: JSON.stringify({ title: "Hearty Soup" }),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("IMAGE_PROVIDER_NOT_CONFIGURED");
      // No provider executed at all.
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
