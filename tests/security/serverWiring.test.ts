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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => seamServer.close(() => resolve()));
  });

  let originalToken: string | undefined;
  let lastImageToken = "";
  beforeEach(() => {
    originalToken = process.env.AI_ENDPOINT_TOKEN;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.AI_ENDPOINT_TOKEN;
    else process.env.AI_ENDPOINT_TOKEN = originalToken;
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
