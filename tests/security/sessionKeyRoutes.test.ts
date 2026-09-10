import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createApp } from "../../server/app.js";
import { resetRateLimitersForTests } from "../../server/rateLimiter.js";
import {
  resetSessionSecretsForTests,
  getSessionSecret,
  MAX_SESSION_SECRET_BYTES,
} from "../../server/ai/sessionSecrets.js";

const SENTINEL = "SUPER_SECRET_SESSION_KEY_SENTINEL_5b";
const ENV_KEYS = [
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "HOST",
  "AI_ENDPOINT_TOKEN",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
  "SESSION_KEY_SET_RATE_LIMIT",
  "SESSION_KEY_REVOKE_RATE_LIMIT",
  "SESSION_KEY_STATUS_RATE_LIMIT",
] as const;

const SET_PATH = "/api/providers/session-key";
const STATUS_PATH = "/api/providers/session-key/status";

let server: http.Server;
let baseUrl: string;

async function postKey(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${SET_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function deleteKey(providerId: string) {
  return fetch(`${baseUrl}${SET_PATH}/${providerId}`, { method: "DELETE" });
}
async function getStatus() {
  return fetch(`${baseUrl}${STATUS_PATH}`, { method: "GET" });
}

beforeAll(async () => {
  const app = createApp({ isProduction: false });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetSessionSecretsForTests();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SESSION_KEY_SET_RATE_LIMIT = "1000";
  process.env.SESSION_KEY_REVOKE_RATE_LIMIT = "1000";
  process.env.SESSION_KEY_STATUS_RATE_LIMIT = "1000";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BYOK-5B — POST /api/providers/session-key", () => {
  it("valid first create succeeds without a version and returns non-secret status", async () => {
    const res = await postKey({ providerId: "gemini", apiKey: "sk-abc" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      providerId: "gemini",
      storageScope: "session_only",
      configured: true,
      expiresAt: expect.any(String),
      version: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("sk-abc");
  });

  it("rejects an unknown provider", async () => {
    const res = await postKey({ providerId: "ghost", apiKey: "sk-abc" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PROVIDER_NOT_ALLOWED");
    expect(getSessionSecret("ghost")).toBeUndefined();
  });

  it("rejects a non-exact provider id (no trim/case normalization)", async () => {
    for (const providerId of ["GEMINI", " gemini", "gemini ", "openrouter-image "]) {
      const res = await postKey({ providerId, apiKey: "sk-abc" });
      expect(res.status, providerId).toBe(400);
      expect((await res.json()).code, providerId).toBe("PROVIDER_NOT_ALLOWED");
    }
  });

  it("rejects a wrong-type providerId / apiKey / expectedVersion", async () => {
    const wrongProvider = await postKey({ providerId: 123, apiKey: "sk" });
    expect(wrongProvider.status).toBe(400);
    expect((await wrongProvider.json()).code).toBe("INVALID_REQUEST");

    const wrongKey = await postKey({ providerId: "gemini", apiKey: { bad: true } });
    expect(wrongKey.status).toBe(400);
    expect((await wrongKey.json()).code).toBe("INVALID_REQUEST");

    const wrongVersion = await postKey({ providerId: "gemini", apiKey: "sk", expectedVersion: 7 });
    expect(wrongVersion.status).toBe(400);
    expect((await wrongVersion.json()).code).toBe("INVALID_REQUEST");
  });

  it("rejects an empty / whitespace-only key", async () => {
    for (const apiKey of ["", "   ", "\t\n"]) {
      const res = await postKey({ providerId: "gemini", apiKey });
      expect(res.status, JSON.stringify(apiKey)).toBe(400);
      expect((await res.json()).code, JSON.stringify(apiKey)).toBe("INVALID_SECRET");
    }
  });

  it("rejects a control-character key", async () => {
    const res = await postKey({ providerId: "gemini", apiKey: "abc\u0000def" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SECRET");
    expect(getSessionSecret("gemini")).toBeUndefined();
  });

  it("rejects an oversized key (<= body limit) with SECRET_TOO_LONG", async () => {
    const key = "x".repeat(MAX_SESSION_SECRET_BYTES + 1);
    const res = await postKey({ providerId: "gemini", apiKey: key });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("SECRET_TOO_LONG");
    expect(getSessionSecret("gemini")).toBeUndefined();
  });

  it("enforces the 4 KiB ceiling as UTF-8 BYTES", async () => {
    // Exactly 4096 ASCII bytes accepted.
    const asciiExact = await postKey({ providerId: "gemini", apiKey: "x".repeat(4096) });
    expect(asciiExact.status).toBe(200);
    resetSessionSecretsForTests();

    // 4097 ASCII bytes rejected and never stored.
    const asciiOver = await postKey({ providerId: "gemini", apiKey: "x".repeat(4097) });
    expect(asciiOver.status).toBe(413);
    expect((await asciiOver.json()).code).toBe("SECRET_TOO_LONG");
    expect(getSessionSecret("gemini")).toBeUndefined();

    // Multibyte key under 4096 CHARS but over 4096 BYTES rejected.
    const multibyteOver = "\u00e9".repeat(2049); // 2049 chars, 4098 bytes
    const rejected = await postKey({ providerId: "gemini", apiKey: multibyteOver });
    expect(rejected.status).toBe(413);
    expect((await rejected.json()).code).toBe("SECRET_TOO_LONG");
    expect(getSessionSecret("gemini")).toBeUndefined();

    // Exactly 4096 UTF-8 bytes accepted.
    const multibyteExact = "\u00e9".repeat(2048); // 4096 bytes
    const accepted = await postKey({ providerId: "gemini", apiKey: multibyteExact });
    expect(accepted.status).toBe(200);
    expect(getSessionSecret("gemini")).toBe(multibyteExact);
  });

  it("rejects malformed JSON with a bounded 400", async () => {
    const res = await fetch(`${baseUrl}${SET_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_REQUEST");
    expect(getSessionSecret("gemini")).toBeUndefined();
  });

  it("rejects a wrong Content-Type with a bounded 400", async () => {
    const res = await fetch(`${baseUrl}${SET_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ providerId: "gemini", apiKey: "sk-abc" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_REQUEST");
    expect(getSessionSecret("gemini")).toBeUndefined();
  });

  it("rejects an empty body with a bounded 400", async () => {
    const res = await fetch(`${baseUrl}${SET_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_REQUEST");
    expect(getSessionSecret("gemini")).toBeUndefined();
  });

  it("rejects an oversized BODY before storing the secret", async () => {
    const res = await postKey({ providerId: "gemini", apiKey: "x".repeat(9000) });
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("INVALID_REQUEST");
    expect(getSessionSecret("gemini")).toBeUndefined();
  });

  it("second create without expectedVersion -> 409 and the old secret is preserved", async () => {
    await postKey({ providerId: "gemini", apiKey: "sk-first" });
    const res = await postKey({ providerId: "gemini", apiKey: "sk-second" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("VERSION_CONFLICT");
    expect(getSessionSecret("gemini")).toBe("sk-first");
  });

  it("stale expectedVersion -> 409; correct expectedVersion rotates", async () => {
    const first = await (await postKey({ providerId: "gemini", apiKey: "sk-1" })).json();
    const rotated = await postKey({ providerId: "gemini", apiKey: "sk-2", expectedVersion: first.version });
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json();
    expect(rotatedBody.version).not.toBe(first.version);
    expect(getSessionSecret("gemini")).toBe("sk-2");

    const stale = await postKey({ providerId: "gemini", apiKey: "sk-3", expectedVersion: first.version });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("VERSION_CONFLICT");
    expect(getSessionSecret("gemini")).toBe("sk-2");
  });

  it("unsupported deployment -> 503 BYOK_SESSION_UNAVAILABLE (no store write)", async () => {
    process.env.K_SERVICE = "hosted-service";
    const res = await postKey({ providerId: "gemini", apiKey: "sk-abc" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("BYOK_SESSION_UNAVAILABLE");
    expect(getSessionSecret("gemini")).toBeUndefined();
  });
});

describe("BYOK-5B — GET /api/providers/session-key/status", () => {
  it("reports configured true for a live key and never exposes secret material", async () => {
    await postKey({ providerId: "gemini", apiKey: SENTINEL });
    const res = await getStatus();
    expect(res.status).toBe(200);
    const body = await res.json();
    const gemini = body.providers.find((p: any) => p.providerId === "gemini");
    expect(gemini).toEqual({
      providerId: "gemini",
      storageScope: "session_only",
      configured: true,
      expiresAt: expect.any(String),
      version: expect.any(String),
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain(SENTINEL.slice(0, 8));
    expect(json).not.toContain("secret");
    // All allowlisted providers are present; non-configured are false.
    const ids = body.providers.map((p: any) => p.providerId).sort();
    expect(ids).toEqual(["deepseek", "gemini", "gemini-image", "openrouter", "openrouter-image"]);
    expect(body.providers.find((p: any) => p.providerId === "openrouter").configured).toBe(false);
  });

  it("configured false after absolute expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await postKey({ providerId: "gemini", apiKey: "sk-1" });
    vi.setSystemTime(new Date("2026-01-01T00:31:00.000Z"));
    const body = await (await getStatus()).json();
    expect(body.providers.find((p: any) => p.providerId === "gemini").configured).toBe(false);
  });

  it("status lookup does NOT refresh the idle TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await postKey({ providerId: "gemini", apiKey: "sk-1" });
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    await getStatus(); // must NOT refresh lastUsedAt
    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
    const body = await (await getStatus()).json();
    expect(body.providers.find((p: any) => p.providerId === "gemini").configured).toBe(false);
  });

  it("unsupported deployment fails safely", async () => {
    process.env.K_SERVICE = "hosted-service";
    const res = await getStatus();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("BYOK_SESSION_UNAVAILABLE");
  });
});

describe("BYOK-5B — DELETE /api/providers/session-key/:providerId", () => {
  it("revokes a live key and is idempotent", async () => {
    await postKey({ providerId: "gemini", apiKey: "sk-1" });
    const first = await deleteKey("gemini");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ providerId: "gemini", configured: false });
    expect(getSessionSecret("gemini")).toBeUndefined();

    const second = await deleteKey("gemini");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ providerId: "gemini", configured: false });
  });

  it("rejects an unknown provider", async () => {
    const res = await deleteKey("ghost");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PROVIDER_NOT_ALLOWED");
  });

  it("rejects encoded / path-edge provider ids without mutating a live key", async () => {
    await postKey({ providerId: "gemini", apiKey: "sk-keep" });
    for (const encoded of ["%20gemini", "gemini%20", "%2Fgemini", "GEMINI", "%00", "%2e%2e", "gemini%2Fimage"]) {
      const res = await fetch(`${baseUrl}${SET_PATH}/${encoded}`, { method: "DELETE" });
      // Bounded rejection (route 400 or Express 404); never a mutation.
      expect([400, 404], encoded).toContain(res.status);
      if (res.status === 400) {
        expect((await res.json()).code, encoded).toBe("PROVIDER_NOT_ALLOWED");
      }
    }
    expect(getSessionSecret("gemini")).toBe("sk-keep");
  });

  it("unsupported deployment is blocked", async () => {
    process.env.K_SERVICE = "hosted-service";
    const res = await deleteKey("gemini");
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("BYOK_SESSION_UNAVAILABLE");
  });
});

describe("BYOK-5B — opt-in cannot enable session BYOK on a non-loopback bind", () => {
  const nonLoopbackHosts = ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", "not a host"];

  for (const host of nonLoopbackHosts) {
    it(`POST/GET/DELETE -> 503 for HOST=${host}`, async () => {
      process.env.KITCHEN_CODEX_SESSION_BYOK = "1";
      process.env.HOST = host;

      const post = await postKey({ providerId: "gemini", apiKey: "sk-abc" });
      expect(post.status).toBe(503);
      expect((await post.json()).code).toBe("BYOK_SESSION_UNAVAILABLE");

      const get = await getStatus();
      expect(get.status).toBe(503);
      expect((await get.json()).code).toBe("BYOK_SESSION_UNAVAILABLE");

      const del = await deleteKey("gemini");
      expect(del.status).toBe(503);
      expect((await del.json()).code).toBe("BYOK_SESSION_UNAVAILABLE");

      expect(getSessionSecret("gemini")).toBeUndefined();
    });
  }

  it("opt-in + loopback (127.0.0.1) is allowed", async () => {
    process.env.KITCHEN_CODEX_SESSION_BYOK = "1";
    process.env.HOST = "127.0.0.1";
    const res = await postKey({ providerId: "gemini", apiKey: "sk-abc" });
    expect(res.status).toBe(200);
  });

  it("opt-in + localhost is allowed", async () => {
    process.env.KITCHEN_CODEX_SESSION_BYOK = "1";
    process.env.HOST = "localhost";
    const res = await postKey({ providerId: "gemini", apiKey: "sk-abc" });
    expect(res.status).toBe(200);
  });

  it("hosted + opt-in -> 503; kill switch + opt-in -> 503", async () => {
    process.env.KITCHEN_CODEX_SESSION_BYOK = "1";
    process.env.K_SERVICE = "svc";
    expect((await postKey({ providerId: "gemini", apiKey: "sk" })).status).toBe(503);
    delete process.env.K_SERVICE;

    process.env.KITCHEN_CODEX_DISABLE_SESSION_BYOK = "1";
    expect((await postKey({ providerId: "gemini", apiKey: "sk" })).status).toBe(503);
  });
});

describe("BYOK-5B — default rate limits", () => {
  it("POST set/rotate default is 10/min", async () => {
    delete process.env.SESSION_KEY_SET_RATE_LIMIT;
    resetRateLimitersForTests();
    for (let i = 0; i < 10; i++) {
      const res = await postKey({ providerId: "gemini", apiKey: `sk-${i}` });
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    const eleventh = await postKey({ providerId: "gemini", apiKey: "sk-10" });
    expect(eleventh.status).toBe(429);
  });

  it("DELETE revoke default is 20/min", async () => {
    delete process.env.SESSION_KEY_REVOKE_RATE_LIMIT;
    resetRateLimitersForTests();
    for (let i = 0; i < 20; i++) {
      const res = await deleteKey("gemini");
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    const twentyFirst = await deleteKey("gemini");
    expect(twentyFirst.status).toBe(429);
  });

  it("GET status default is 60/min", async () => {
    delete process.env.SESSION_KEY_STATUS_RATE_LIMIT;
    resetRateLimitersForTests();
    for (let i = 0; i < 60; i++) {
      const res = await getStatus();
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    const sixtyFirst = await getStatus();
    expect(sixtyFirst.status).toBe(429);
  });
});

describe("BYOK-5B SECURITY", () => {
  it("the sentinel secret never appears in any response or error", async () => {
    const create = await (await postKey({ providerId: "gemini", apiKey: SENTINEL })).json();
    expect(JSON.stringify(create)).not.toContain(SENTINEL);

    // Version-conflict error path.
    const conflict = await postKey({ providerId: "gemini", apiKey: SENTINEL });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json();
    expect(JSON.stringify(conflictBody)).not.toContain(SENTINEL);

    // Status + revoke paths.
    expect(JSON.stringify(await (await getStatus()).json())).not.toContain(SENTINEL);
    expect(JSON.stringify(await (await deleteKey("gemini")).json())).not.toContain(SENTINEL);
  });

  it("does not mutate process.env", async () => {
    const before = JSON.stringify(process.env);
    await postKey({ providerId: "gemini", apiKey: SENTINEL });
    await getStatus();
    await deleteKey("gemini");
    expect(JSON.stringify(process.env)).toBe(before);
    for (const value of Object.values(process.env)) {
      expect(String(value)).not.toContain(SENTINEL);
    }
  });

  it("makes NO provider network call", async () => {
    const original = globalThis.fetch;
    const providerCalls: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url;
      if (typeof url === "string" && /openrouter\.ai|generativelanguage\.googleapis\.com|api\.deepseek\.com/.test(url)) {
        providerCalls.push(url);
        throw new Error("provider call blocked in test");
      }
      return original(input, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      await postKey({ providerId: "gemini", apiKey: "sk-abc" });
      await getStatus();
      await deleteKey("gemini");
    } finally {
      globalThis.fetch = original;
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("applies the existing AI auth middleware when AI_ENDPOINT_TOKEN is set", async () => {
    process.env.AI_ENDPOINT_TOKEN = "test-endpoint-token";
    const unauthorized = await postKey({ providerId: "gemini", apiKey: "sk-abc" });
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).code).toBe("UNAUTHORIZED");

    const authorized = await postKey(
      { providerId: "gemini", apiKey: "sk-abc" },
      { Authorization: "Bearer test-endpoint-token" }
    );
    expect(authorized.status).toBe(200);
  });

  it("enforces the mutation rate limit before the store handler", async () => {
    process.env.SESSION_KEY_SET_RATE_LIMIT = "2";
    let saw429 = false;
    let body: any = null;
    for (let i = 0; i < 6; i++) {
      const res = await postKey({ providerId: "gemini", apiKey: `sk-${i}` });
      if (res.status === 429) {
        saw429 = true;
        body = await res.json();
        break;
      }
    }
    expect(saw429).toBe(true);
    expect(body.error).toContain("session key");
    expect(typeof body.retryAfterSeconds).toBe("number");
    // The 429 response is the limiter's bounded response, never a handler payload.
    expect(body.configured).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sk-");
  });
});
