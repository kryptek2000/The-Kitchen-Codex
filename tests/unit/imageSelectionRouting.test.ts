/**
 * The Kitchen Codex — Image selection ROUTE-LEVEL no-fallback + fail-closed
 * regression (BYOK-3 hardening, READ-ONLY audit fixes).
 *
 * Boots REAL Express apps (createApp) against ephemeral ports under explicit
 * server-managed selection env, exercising the FULL route path:
 *
 *   - pinned openrouter-image (key + curated model) + OpenRouter runtime
 *     AUTH / RATE_LIMIT / TIMEOUT failure -> DISTINCT IMAGE_PROVIDER_* response
 *     AND the Gemini SDK is NEVER invoked (zero generateContent calls).
 *   - EXPLICIT invalid image pins (unknown provider / credentialed-but-disabled
 *     provider) -> 503 IMAGE_PROVIDER_NOT_CONFIGURED with ZERO Gemini and ZERO
 *     OpenRouter traffic (fail closed — no silent Gemini fallback).
 *   - UNSET image selection -> real Gemini default executes (unchanged).
 *
 * The @google/genai SDK is mocked at the SDK boundary (counts generateContent
 * calls) and globalThis.fetch is stubbed for the OpenRouter transport, so no
 * network leaves the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_GEMINI_IMAGE_MODEL } from "../../server/ai/geminiImageProvider.js";

const generateContentMock = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  // Partial mock at the SDK boundary: keep every real export (ThinkingLevel,
  // Modality, ...) but route ALL GoogleGenAI construction through a class whose
  // generateContent is the counted mock, so Gemini invocation is provable.
  const GoogleGenAIClass = class {
    models = { generateContent: generateContentMock };
  };
  return { ...actual, GoogleGenAI: GoogleGenAIClass };
});

const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const KEY = "sk-or-v1-BYOK3-HARDENING-KEY";
const CURATED_MODEL = "google/gemini-2.5-flash-image";
const REQUEST_BODY = {
  title: "Hearty Soup",
  ingredients: ["potato", "leek"],
  cuisine: "French",
  recipeContentHash: "a".repeat(64),
};

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
  "AI_ENDPOINT_TOKEN",
] as const;

// Captured BEFORE any transport stub is installed: this is the ONLY fetch used
// to talk to the ephemeral test server. globalThis.fetch is rebindable to the
// OpenRouter transport mock inside `boot`.
const realFetch = globalThis.fetch.bind(globalThis);

let originalFetch: typeof globalThis.fetch;

async function boot(
  env: Record<string, string>,
  fetchImpl?: typeof fetch
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  vi.resetModules(); // fresh registry/selection/geminiClient/module graph for THIS env
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  if (fetchImpl) globalThis.fetch = fetchImpl as typeof fetch;
  const { createApp } = await import("../../server/app.js");
  const app = createApp({ isProduction: false });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function openRouterError(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    void init;
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
}

describe("route-level image selection: runtime failure NEVER invokes Gemini (BYOK-3 no-fallback proof)", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    generateContentMock.mockClear();
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  async function pinnedOpenRouter(fetchImpl?: typeof fetch) {
    return boot(
      {
        OPENROUTER_API_KEY: KEY,
        KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image",
        KITCHEN_CODEX_IMAGE_MODEL: CURATED_MODEL,
      },
      fetchImpl
    );
  }

  it("OpenRouter AUTH failure -> 502 IMAGE_PROVIDER_AUTH (deep: bounded body, fixed endpoint, zero Gemini)", async () => {
    const fetchMock = openRouterError(401, { error: { message: "Invalid API key sentinel" } });
    const app = await pinnedOpenRouter(fetchMock);
    try {
      const res = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.code).toBe("IMAGE_PROVIDER_AUTH");
      // Bounded, provider-neutral, secret-free copy.
      expect(body.error).toContain("could not be authorized");
      expect(body.error).not.toMatch(/Gemini|OpenRouter/i);
      expect(JSON.stringify(body)).not.toContain("sentinel");
      // Exactly ONE OpenRouter request to the FIXED endpoint with the server key.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(url).toBe("https://openrouter.ai/api/v1/images");
      // The pinned OpenRouter failure MUST NOT silently invoke Gemini.
      expect(generateContentMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("OpenRouter RATE_LIMIT failure -> 503 IMAGE_PROVIDER_RATE_LIMIT with upstream Retry-After, zero Gemini", async () => {
    const fetchMock = openRouterError(429, { error: { message: "Rate limited" } }, { "Retry-After": "42" });
    const app = await pinnedOpenRouter(fetchMock);
    try {
      const res = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("IMAGE_PROVIDER_RATE_LIMIT");
      expect(res.headers.get("retry-after")).toBe("42");
      expect(body.error).not.toMatch(/Gemini|OpenRouter/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(generateContentMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("OpenRouter TIMEOUT failure -> 503 IMAGE_PROVIDER_TIMEOUT, zero Gemini", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchMock = vi.fn(async () => {
      throw abort;
    }) as unknown as typeof fetch;
    const app = await pinnedOpenRouter(fetchMock);
    try {
      const res = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("IMAGE_PROVIDER_TIMEOUT");
      expect(body.error).not.toMatch(/Gemini|OpenRouter/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(generateContentMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("route-level image selection: EXPLICIT invalid pins FAIL CLOSED (zero Gemini, zero cost)", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    generateContentMock.mockClear();
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  it("unknown image provider pin -> 503 IMAGE_PROVIDER_NOT_CONFIGURED even when a Gemini key IS configured (no silent fallback)", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const app = await boot(
      { GEMINI_API_KEY: KEY, KITCHEN_CODEX_IMAGE_PROVIDER: "ghost-image", KITCHEN_CODEX_IMAGE_MODEL: "x" },
      fetchMock
    );
    try {
      const res = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("IMAGE_PROVIDER_NOT_CONFIGURED");
      expect(body.error).toContain("invalid");
      // Did not touch OpenRouter transport ... and DEFINITELY did not run Gemini
      // even though a valid GEMINI_API_KEY was present.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(generateContentMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("openrouter-image pinned WITHOUT its operator key -> 503 IMAGE_PROVIDER_NOT_CONFIGURED, zero Gemini zero OpenRouter", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const app = await boot(
      { GEMINI_API_KEY: KEY, KITCHEN_CODEX_IMAGE_PROVIDER: "openrouter-image", KITCHEN_CODEX_IMAGE_MODEL: CURATED_MODEL },
      fetchMock
    );
    try {
      const res = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("IMAGE_PROVIDER_NOT_CONFIGURED");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(generateContentMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("route-level image selection: UNSET selection preserves the Gemini default (unchanged)", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    generateContentMock.mockClear();
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  it("unset image selection with a real Gemini key generates via the real Gemini default (no OpenRouter traffic)", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    generateContentMock.mockResolvedValueOnce({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: VALID_PNG_BASE64 } }] } }],
    });
    const app = await boot({ GEMINI_API_KEY: KEY }, fetchMock);
    try {
      const res = await realFetch(`${app.baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST_BODY),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.provider).toBe("gemini-image");
      expect(body.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
      expect(body.contentType).toBe("image/png");
      // Gemini default was genuinely invoked (once)...
      expect(generateContentMock).toHaveBeenCalledTimes(1);
      // ...and OpenRouter was never touched (no surprise cross-provider cost).
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});