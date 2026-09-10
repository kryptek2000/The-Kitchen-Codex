import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createApp } from "../../server/app.js";
import { DeterministicImageProvider } from "../../server/ai/imageProvider.js";

describe("Express server wiring", () => {
  let server: http.Server;
  let baseUrl: string;
  // Separate instance with the explicit DeterministicImageProvider TEST SEAM so
  // the image-generation endpoint flow is exercisable hermetically while the
  // default (production) app keeps the real Gemini provider.
  let seamServer: http.Server;
  let seamBaseUrl: string;

  beforeAll(async () => {
    // Keep the connection-test limiter from cross-test interference; the
    // rate-limit regression sets its own low limit explicitly.
    process.env.PROVIDER_TEST_RATE_LIMIT = "1000";
    const app = createApp({ isProduction: false });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const seamApp = createApp({ isProduction: false, imageProvider: new DeterministicImageProvider() });
    seamServer = http.createServer(seamApp);
    await new Promise<void>((resolve) => seamServer.listen(0, "127.0.0.1", resolve));
    const seamAddr = seamServer.address() as AddressInfo;
    seamBaseUrl = `http://127.0.0.1:${seamAddr.port}`;
  });

  afterAll(async () => {
    delete process.env.PROVIDER_TEST_RATE_LIMIT;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => seamServer.close(() => resolve()));
  });

  let originalToken: string | undefined;
  let lastImageToken = "";
  const KITCHEN_SELECTION_ENV = ["KITCHEN_CODEX_TEXT_PROVIDER", "KITCHEN_CODEX_TEXT_MODEL", "KITCHEN_CODEX_IMAGE_PROVIDER", "KITCHEN_CODEX_IMAGE_MODEL"] as const;
  beforeEach(() => {
    originalToken = process.env.AI_ENDPOINT_TOKEN;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.AI_ENDPOINT_TOKEN;
    else process.env.AI_ENDPOINT_TOKEN = originalToken;
    for (const k of KITCHEN_SELECTION_ENV) delete process.env[k];
  });

  it("serves the health endpoint with the canonical release version", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("emits security headers on API responses", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("returns JSON (not an HTML error page) for a malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/estimate-nutrition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{ "ingredients": [ ',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON payload");
  });

  it("returns JSON 404 for an unknown API route", async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("requires a bearer token on AI endpoints when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/estimate-nutrition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ingredients: ["1 cup flour"] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("accepts a valid bearer token and validates the route payload", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/estimate-nutrition`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer super-secret",
      },
      body: JSON.stringify({ ingredients: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("provide a list of ingredients");
  });

  it("returns a read-only provider status surface with booleans and NO secrets", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${baseUrl}/api/providers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThan(0);
    for (const p of body.providers) {
      expect(typeof p.providerId).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(typeof p.configured).toBe("boolean");
      expect(typeof p.enabled).toBe("boolean");
      expect(typeof p.available).toBe("boolean");
      expect(typeof p.supportsSecretWrites).toBe("boolean");
      expect(p.storageScope).toBe("server_environment");
      // No secret-shaped fields may appear in the status object.
      expect(p).not.toHaveProperty("key");
      expect(p).not.toHaveProperty("token");
      expect(p).not.toHaveProperty("secret");
      expect(p).not.toHaveProperty("apiKey");
      expect(p).not.toHaveProperty("value");
    }
    const json = JSON.stringify(body);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("OPENROUTER_API_KEY");
    expect(json).not.toContain("DEEPSEEK_API_KEY");
  });

  it("gates /api/providers behind the AI endpoint token when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/providers`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns a read-only provider + model catalog with NO secrets (BYOK-1)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${baseUrl}/api/providers/catalog`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog).toBeDefined();
    expect(Array.isArray(body.catalog.textProviders)).toBe(true);
    expect(Array.isArray(body.catalog.imageProviders)).toBe(true);
    const { textProviders, imageProviders } = body.catalog;
    expect(textProviders.length).toBeGreaterThan(0);
    expect(imageProviders.length).toBeGreaterThan(0);

    for (const p of textProviders) {
      expect(typeof p.providerId).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(typeof p.configured).toBe("boolean");
      expect(typeof p.enabled).toBe("boolean");
      expect(typeof p.available).toBe("boolean");
      expect(typeof p.supportsSecretWrites).toBe("boolean");
      expect(p.storageScope).toBe("server_environment");
      expect(Array.isArray(p.models)).toBe(true);
      for (const m of p.models) {
        expect(typeof m.id).toBe("string");
        expect(typeof m.default).toBe("boolean");
        expect(typeof m.capabilities).toBe("object");
        for (const key of ["reasoning", "structuredOutput", "recipeGeneration", "webSearch"]) {
          expect(typeof m.capabilities[key]).toBe("boolean");
        }
      }
      expect(p).not.toHaveProperty("key");
      expect(p).not.toHaveProperty("token");
      expect(p).not.toHaveProperty("secret");
      expect(p).not.toHaveProperty("apiKey");
      expect(p).not.toHaveProperty("value");
    }

    const image = imageProviders[0];
    expect(typeof image.providerId).toBe("string");
    expect(typeof image.name).toBe("string");
    expect(typeof image.imageGeneration).toBe("boolean");
    expect(Array.isArray(image.formats)).toBe(true);
    for (const format of image.formats) {
      expect(["image/jpeg", "image/png", "image/webp", "image/avif"]).toContain(format);
    }
    expect(typeof image.maxBytes).toBe("number");
    for (const m of image.models) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.default).toBe("boolean");
    }

    const json = JSON.stringify(body);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("OPENROUTER_API_KEY");
    expect(json).not.toContain("DEEPSEEK_API_KEY");
    expect(json).not.toContain("GEMINI_API_KEY");

    // BYOK-2: selection truth is present, read-only, well-formed, and secret-free.
    const { selection } = body.catalog;
    expect(selection).toBeDefined();
    for (const side of ["text", "image"] as const) {
      const block = selection[side];
      expect(["server_default", "server_managed"]).toContain(block.selectionMode);
      expect(typeof block.valid).toBe("boolean");
      if (block.selectionMode === "server_managed") {
        expect(typeof block.selectedProviderId).toBe("string");
      }
      expect(block).not.toHaveProperty("key");
      expect(block).not.toHaveProperty("secret");
      expect(block).not.toHaveProperty("apiKey");
      expect(block).not.toHaveProperty("token");
    }
    expect(json).not.toContain("KITCHEN_CODEX");
  });

  it("reflects server-managed selection env truthfully in the catalog (BYOK-2)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    process.env.KITCHEN_CODEX_TEXT_PROVIDER = "gemini";
    process.env.KITCHEN_CODEX_IMAGE_PROVIDER = "gemini-image";
    const res = await fetch(`${baseUrl}/api/providers/catalog`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog.selection.text).toMatchObject({
      selectionMode: "server_managed",
      selectedProviderId: "gemini",
      valid: true,
    });
    expect(body.catalog.selection.image).toMatchObject({
      selectionMode: "server_managed",
      selectedProviderId: "gemini-image",
      valid: true,
    });
    const json = JSON.stringify(body.catalog.selection);
    expect(json).not.toContain("KITCHEN_CODEX");
  });

  it("reports valid:false for an unknown pinned provider (truth, no cross-provider fallback)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    process.env.KITCHEN_CODEX_TEXT_PROVIDER = "not-a-provider";
    const res = await fetch(`${baseUrl}/api/providers/catalog`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog.selection.text).toMatchObject({
      selectionMode: "server_managed",
      selectedProviderId: "not-a-provider",
      valid: false,
    });
  });

  it("gates /api/providers/catalog behind the AI endpoint token when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/providers/catalog`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  // ---- BYOK-4: provider connection test route ------------------------------

  it("POST /api/providers/test-connection requires the AI endpoint token when configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "gemini", kind: "text" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("POST /api/providers/test-connection rejects a missing providerId", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "text" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("providerId");
  });

  it("POST /api/providers/test-connection returns a bounded secret-free result for an unknown provider", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "not-a-provider", kind: "text" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.code).toBe("string");
    expect(typeof body.message).toBe("string");
    const json = JSON.stringify(body);
    expect(json).not.toContain("API_KEY");
    expect(json).not.toContain("Bearer");
    expect(json).not.toContain("sk-");
  });

  it("POST /api/providers/test-connection rejects an ARBITRARY model id with a bounded 4xx (INVALID_MODEL) and no secret leak", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "SUPER_SECRET_BYOK4HARDEN_TESTKEY";
    try {
      const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "gemini", kind: "text", modelId: "totally-arbitrary-model" }),
      });
      // Bounded 4xx for a client-side validation failure (verified pre-network).
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("INVALID_MODEL");
      expect(body.model).toBe("totally-arbitrary-model");
      const json = JSON.stringify(body);
      expect(json).not.toContain("SUPER_SECRET_BYOK4HARDEN_TESTKEY");
      expect(json).not.toContain("API_KEY");
      expect(json).not.toContain("Bearer");
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });

  it("POST /api/providers/test-connection rejects an UNKNOWN kind with a bounded 400 (never normalized to text)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "gemini", kind: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("kind");
    // Missing kind is equally invalid (no silent text default).
    const missing = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "gemini" }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("kind");
  });

  it("POST /api/providers/test-connection still accepts the canonical text and image kinds", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    for (const kind of ["text", "image"] as const) {
      const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "not-a-provider", kind }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(typeof body.code).toBe("string");
    }
  });

  it("POST /api/providers/test-connection is rate-limited (429) under a burst", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const original = process.env.PROVIDER_TEST_RATE_LIMIT;
    process.env.PROVIDER_TEST_RATE_LIMIT = "3";
    try {
      let saw429 = false;
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId: "not-a-provider", kind: "text" }),
        });
        if (res.status === 429) {
          saw429 = true;
          const body = await res.json();
          expect(body.error).toContain("connection test");
          expect(res.headers.get("Retry-After")).toBeTruthy();
          break;
        }
      }
      expect(saw429).toBe(true);
    } finally {
      if (original === undefined) delete process.env.PROVIDER_TEST_RATE_LIMIT;
      else process.env.PROVIDER_TEST_RATE_LIMIT = original;
    }
  });

  it("POST /api/providers/test-connection rejects WRONG-TYPE providerId/modelId/kind with a bounded 400", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const wrongProvider = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: 123, kind: "text" }),
    });
    expect(wrongProvider.status).toBe(400);
    expect((await wrongProvider.json()).error).toContain("providerId");

    const wrongModel = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "gemini", kind: "text", modelId: { bad: true } }),
    });
    expect(wrongModel.status).toBe(400);
    expect((await wrongModel.json()).error).toContain("modelId");

    const wrongKind = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "gemini", kind: 7 }),
    });
    expect(wrongKind.status).toBe(400);
    expect((await wrongKind.json()).error).toContain("kind");
  });

  it("POST /api/providers/test-connection rejects OVERSIZED ids with a bounded 400 (no truncation)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const oversizedProvider = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "p".repeat(65), kind: "text" }),
    });
    expect(oversizedProvider.status).toBe(400);
    const providerBody = await oversizedProvider.json();
    expect(providerBody.error).toContain("providerId");
    // The oversized value is NEVER echoed back truncated/valid.
    expect(JSON.stringify(providerBody)).not.toContain("p".repeat(65));

    const oversizedModel = await fetch(`${baseUrl}/api/providers/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "gemini", kind: "text", modelId: "m".repeat(129) }),
    });
    expect(oversizedModel.status).toBe(400);
    expect((await oversizedModel.json()).error).toContain("modelId");
  });

  it("POST /api/providers/test-connection honors a server-managed pin (cannot probe another provider)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const original = process.env.KITCHEN_CODEX_TEXT_PROVIDER;
    process.env.KITCHEN_CODEX_TEXT_PROVIDER = "gemini";
    try {
      const res = await fetch(`${baseUrl}/api/providers/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "openrouter", kind: "text" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("OPERATOR_PIN");
      // Bounded, secret-free.
      expect(JSON.stringify(body)).not.toContain("Bearer");
      expect(JSON.stringify(body)).not.toContain("sk-");
    } finally {
      if (original === undefined) delete process.env.KITCHEN_CODEX_TEXT_PROVIDER;
      else process.env.KITCHEN_CODEX_TEXT_PROVIDER = original;
    }
  });

  it("POST /api/recipes/generate requires the AI endpoint token when configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/recipes/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a dinner" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("POST /api/recipes/generate rejects an empty prompt with INVALID_REQUEST (400)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${baseUrl}/api/recipes/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "  " }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("POST /api/recipes/generate returns truthful unsupported-capability (no provider) and never saves", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    // Force NO configured/usable provider so no network/AI call is attempted.
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const res = await fetch(`${baseUrl}/api/recipes/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a SUPER_SECRET_CREATE_PROMPT_SENTINEL dinner" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("UNSUPPORTED_CAPABILITY");
    // No fabricated draft and never a saved recipe / prompt leak.
    expect(body.draft).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("SUPER_SECRET_CREATE_PROMPT_SENTINEL");
  });

  // ---- Vault Intelligence Image Recovery foundation (2B) -------------------

  it("POST /api/recipes/image/generate requires the AI endpoint token when configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/recipes/image/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Soup" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("POST /api/recipes/image/generate rejects a request with no title", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${seamBaseUrl}/api/recipes/image/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("POST /api/recipes/image/generate (production default) is 503 IMAGE_PROVIDER_NOT_CONFIGURED without a real GEMINI_API_KEY and never falls back to the deterministic seam", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    // Placeholder key: getGemini() returns null, exactly like an unset key.
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";
    try {
      const res = await fetch(`${baseUrl}/api/recipes/image/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Hearty Soup" }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("IMAGE_PROVIDER_NOT_CONFIGURED");
      // No fabricated preview, no deterministic fallback leak.
      expect(body.token).toBeUndefined();
      expect(body.provider).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });

  it("POST /api/recipes/image/generate (test seam) returns token metadata only (never base64 bytes)", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const res = await fetch(`${seamBaseUrl}/api/recipes/image/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hearty Soup", ingredients: ["potato", "leek"], cuisine: "French", recipeContentHash: "a".repeat(64) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.contentType).toBe("image/png");
    expect(typeof body.bytes).toBe("number");
    expect(body.provider).toBe("deterministic-image");
    expect(body.model).toBe("deterministic-2b1");
    expect(typeof body.expiresAt).toBe("number");
    expect(body.recipeContentHash).toBe("a".repeat(64));
    // Data minimization + privacy: no raw bytes, no data URL, no prompt echo.
    expect(JSON.stringify(body)).not.toContain("data:image");
    expect(JSON.stringify(body)).not.toContain("Hearty Soup");
    expect(JSON.stringify(body)).not.toContain("SUPER_SECRET_");
    lastImageToken = body.token as string;
  });

  it("GET /api/recipes/image/preview/:token streams exact bytes with safe headers", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    expect(lastImageToken).toBeTruthy();
    const res = await fetch(`${seamBaseUrl}/api/recipes/image/preview/${lastImageToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const length = Number(res.headers.get("content-length"));
    expect(length).toBeGreaterThan(0);
    const buffer = new Uint8Array(await res.arrayBuffer());
    expect(buffer.length).toBe(length);
    // Real PNG container (multi-read allowed).
    expect([...buffer.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const second = await fetch(`${seamBaseUrl}/api/recipes/image/preview/${lastImageToken}`);
    expect(second.status).toBe(200);
  });

  it("GET /api/recipes/image/preview rejects unknown tokens and never treats the token as a path", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const unknown = await fetch(`${baseUrl}/api/recipes/image/preview/${"z".repeat(64)}`);
    expect(unknown.status).toBe(404);
    // Traversal-shaped tokens are just opaque lookups: no path access.
    const traversal = await fetch(`${baseUrl}/api/recipes/image/preview/..%2F..%2Fetc%2Fpasswd`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain("root:");
  });

  it("GET /api/recipes/image/preview is gated by the AI endpoint token when configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${baseUrl}/api/recipes/image/preview/${"z".repeat(64)}`);
    expect(res.status).toBe(401);
  });

  it("DELETE /api/recipes/image/preview/:token is gated by the AI endpoint token when configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await fetch(`${seamBaseUrl}/api/recipes/image/preview/${"z".repeat(64)}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/recipes/image/preview/:token invalidates the token (preview lifecycle after save) and is oracle-free for unknown tokens", async () => {
    delete process.env.AI_ENDPOINT_TOKEN;
    const gen = await fetch(`${seamBaseUrl}/api/recipes/image/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hearty Soup" }),
    });
    expect(gen.status).toBe(200);
    const genBody = await gen.json();
    const token = genBody.token as string;

    const first = await fetch(`${seamBaseUrl}/api/recipes/image/preview/${token}`);
    expect(first.status).toBe(200);

    const del = await fetch(`${seamBaseUrl}/api/recipes/image/preview/${token}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const afterDelete = await fetch(`${seamBaseUrl}/api/recipes/image/preview/${token}`);
    expect(afterDelete.status).toBe(404);

    // Unknown/expired tokens: same safe response, no existence oracle.
    const unknownDel = await fetch(`${seamBaseUrl}/api/recipes/image/preview/${"z".repeat(64)}`, { method: "DELETE" });
    expect(unknownDel.status).toBe(200);
    expect(await unknownDel.json()).toEqual({ ok: true });
  });
});
