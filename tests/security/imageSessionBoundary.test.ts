import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ImagePreviewStore } from "../../server/imagePreviewStore.js";
import { ImageSessionAuthority } from "../../server/imageSessionAuthority.js";
import {
  bootstrapImageSession,
  forgedImageSessionCookie,
} from "../helpers/imageSessionTestClient.js";

/**
 * P2-R1 — end-to-end same-IP cross-session boundary.
 *
 * Two REAL HTTP clients (A/B) bootstrap independent server-issued sessions from
 * the SAME loopback IP. The test proves A's paid confirmation and generated
 * preview cannot be consumed/read/deleted by B, even with the exact token.
 * Provider transport is mocked; no live request leaves the process.
 */

const KEY = "sk-openai-P2R1-ROUTE-KEY";
const MODEL = "gpt-image-2.6-flare";
const IMAGE_HEADER = "x-kitchen-ai-image-selection";
const VALID_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
  "AI_ENDPOINT_TOKEN",
  "KITCHEN_CODEX_SESSION_BYOK",
  "KITCHEN_CODEX_DISABLE_SESSION_BYOK",
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "HOST",
  "TKC_DESKTOP_SESSION_TOKEN",
  "IMAGE_SESSION_BOOTSTRAP_RATE_LIMIT",
] as const;

const realFetch = globalThis.fetch.bind(globalThis);

interface BootedApp {
  baseUrl: string;
  close: () => Promise<void>;
}

function selectionHeader(overrides: Record<string, unknown> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [IMAGE_HEADER]: JSON.stringify({
      mode: "user_selected",
      providerId: "openai-image",
      modelId: MODEL,
      credentialSource: "server_environment",
      ...overrides,
    }),
  };
}

function openAIImageStub() {
  const calls: { url: string; auth?: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url);
    calls.push({
      url,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: VALID_PNG_B64 }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchMock, calls };
}

async function boot(
  env: Record<string, string> = {},
  options: { isProduction?: boolean; authority?: ImageSessionAuthority; store?: ImagePreviewStore; fetchImpl?: typeof fetch } = {}
): Promise<BootedApp> {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.IMAGE_SESSION_BOOTSTRAP_RATE_LIMIT = "1000";
  Object.assign(process.env, env);
  if (options.fetchImpl) globalThis.fetch = options.fetchImpl;
  const { createApp } = await import("../../server/app.js");
  const app = createApp({
    isProduction: options.isProduction === true,
    ...(options.authority ? { imageSessionAuthority: options.authority } : {}),
    ...(options.store ? { imagePreviewStore: options.store } : {}),
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function quote(baseUrl: string, cookie?: string, body: Record<string, unknown> = { title: "Soup" }) {
  const res = await realFetch(`${baseUrl}/api/recipes/image/quote`, {
    method: "POST",
    headers: { ...selectionHeader(), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function generate(baseUrl: string, cookie: string | undefined, body: Record<string, unknown>) {
  const res = await realFetch(`${baseUrl}/api/recipes/image/generate`, {
    method: "POST",
    headers: { ...selectionHeader(), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function previewGet(baseUrl: string, token: string, cookie?: string) {
  return realFetch(`${baseUrl}/api/recipes/image/preview/${token}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("P2-R1 — same-IP session A/B isolation", () => {
  it("issues independent session cookies with safe attributes and no token in JSON", async () => {
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { fetchImpl: stub.fetchMock });
    try {
      const a = await bootstrapImageSession(app.baseUrl, realFetch);
      const b = await bootstrapImageSession(app.baseUrl, realFetch);
      expect(a.cookie).not.toBe(b.cookie);
      for (const session of [a, b]) {
        expect(session.setCookie).toContain("HttpOnly");
        expect(session.setCookie).toContain("SameSite=Strict");
        expect(session.setCookie).toContain("Path=/api");
        expect(session.setCookie).toContain("Max-Age=");
      }
      const tokenA = a.cookie.split("=")[1];
      expect(JSON.stringify({ expiresAt: a.expiresAt })).not.toContain(tokenA);
    } finally {
      await app.close();
    }
  });

  it("A quotes/generates; B cannot consume A's confirmation even with the exact token", async () => {
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { fetchImpl: stub.fetchMock });
    try {
      const a = await bootstrapImageSession(app.baseUrl, realFetch);
      const b = await bootstrapImageSession(app.baseUrl, realFetch);
      const q = await quote(app.baseUrl, a.cookie);
      expect(q.status).toBe(200);
      const token = q.body["confirmationToken"] as string;
      expect(typeof token).toBe("string");

      // B possesses A's exact token but has its own session.
      const stolen = await generate(app.baseUrl, b.cookie, { title: "Soup", confirmationToken: token });
      expect(stolen.status).toBe(409);
      expect(stolen.body["code"]).toBe("IMAGE_CONFIRMATION_INVALID");
      expect(stub.calls).toHaveLength(0);

      // A still owns the confirmation and can complete exactly one call.
      const own = await generate(app.baseUrl, a.cookie, { title: "Soup", confirmationToken: token });
      expect(own.status).toBe(200);
      expect(stub.calls).toHaveLength(1);
      const previewToken = own.body["token"] as string;

      // B cannot read or delete A's preview; A remains able to read it.
      expect((await previewGet(app.baseUrl, previewToken, b.cookie)).status).toBe(404);
      const bDelete = await realFetch(`${app.baseUrl}/api/recipes/image/preview/${previewToken}`, {
        method: "DELETE",
        headers: { Cookie: b.cookie },
      });
      expect(bDelete.status).toBe(200); // idempotent, no existence oracle
      expect((await previewGet(app.baseUrl, previewToken, a.cookie)).status).toBe(200);
      const aDelete = await realFetch(`${app.baseUrl}/api/recipes/image/preview/${previewToken}`, {
        method: "DELETE",
        headers: { Cookie: a.cookie },
      });
      expect(aDelete.status).toBe(200);
      expect((await previewGet(app.baseUrl, previewToken, a.cookie)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("missing / forged / revoked sessions fail closed", async () => {
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { fetchImpl: stub.fetchMock });
    try {
      expect((await quote(app.baseUrl)).status).toBe(401);
      expect((await quote(app.baseUrl, forgedImageSessionCookie())).status).toBe(401);
      expect((await previewGet(app.baseUrl, "z".repeat(64))).status).toBe(401);

      const a = await bootstrapImageSession(app.baseUrl, realFetch);
      const q = await quote(app.baseUrl, a.cookie);
      const token = q.body["confirmationToken"] as string;

      const revoked = await realFetch(`${app.baseUrl}/api/session`, {
        method: "DELETE",
        headers: { Cookie: a.cookie },
      });
      expect(revoked.status).toBe(200);
      expect((await quote(app.baseUrl, a.cookie)).status).toBe(401);
      expect((await generate(app.baseUrl, a.cookie, { title: "Soup", confirmationToken: token })).status).toBe(401);
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("session expiry invalidates the associated confirmation (zero provider calls)", async () => {
    const clock = { now: 1_700_000_000_000 };
    const authority = new ImageSessionAuthority({
      now: () => clock.now,
      absoluteTtlMs: 10_000,
      idleTtlMs: 60_000,
    });
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { fetchImpl: stub.fetchMock, authority });
    try {
      const a = await bootstrapImageSession(app.baseUrl, realFetch);
      const q = await quote(app.baseUrl, a.cookie);
      const token = q.body["confirmationToken"] as string;
      clock.now += 10_001;
      const res = await generate(app.baseUrl, a.cookie, { title: "Soup", confirmationToken: token });
      expect(res.status).toBe(401);
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("replay and concurrent consumption authorize at most ONE provider call", async () => {
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { fetchImpl: stub.fetchMock });
    try {
      const a = await bootstrapImageSession(app.baseUrl, realFetch);
      const q = await quote(app.baseUrl, a.cookie);
      const token = q.body["confirmationToken"] as string;
      const [first, second] = await Promise.all([
        generate(app.baseUrl, a.cookie, { title: "Soup", confirmationToken: token }),
        generate(app.baseUrl, a.cookie, { title: "Soup", confirmationToken: token }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      expect(stub.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("refuses bootstrap without a same-origin Origin and refuses cross-site image requests", async () => {
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { fetchImpl: stub.fetchMock });
    try {
      const noOrigin = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(noOrigin.status).toBe(403);
      expect(((await noOrigin.json()) as { code?: string }).code).toBe("SESSION_BOOTSTRAP_FORBIDDEN");

      const evilOrigin = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
        body: "{}",
      });
      expect(evilOrigin.status).toBe(403);

      const a = await bootstrapImageSession(app.baseUrl, realFetch);
      const crossSite = await realFetch(`${app.baseUrl}/api/recipes/image/quote`, {
        method: "POST",
        headers: { ...selectionHeader(), Cookie: a.cookie, Origin: "http://evil.example" },
        body: JSON.stringify({ title: "Soup" }),
      });
      expect(crossSite.status).toBe(403);
      expect(((await crossSite.json()) as { code?: string }).code).toBe("IMAGE_SESSION_CROSS_ORIGIN");
    } finally {
      await app.close();
    }
  });

  it("production standalone loopback fails closed without a desktop authority", async () => {
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { isProduction: true, fetchImpl: stub.fetchMock });
    try {
      // Matching Host/Origin headers are not an access authority. This is the
      // original P2-R1 production standalone bypass reproduction.
      const bootstrap = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: new URL(app.baseUrl).host,
          Origin: app.baseUrl,
        },
        body: "{}",
      });
      expect(bootstrap.status).toBe(503);
      expect(((await bootstrap.json()) as { code?: string }).code).toBe("IMAGE_SESSION_UNAVAILABLE");

      const cookie = "tkc_image_session=previously-issued-token";
      const q = await quote(app.baseUrl, cookie);
      expect(q.status).toBe(503);
      const generated = await generate(app.baseUrl, cookie, {
        title: "Soup",
        confirmationToken: "previous-confirmation-token",
      });
      expect(generated.status).toBe(503);
      expect((await previewGet(app.baseUrl, "previous-preview-token", cookie)).status).toBe(503);
      const deleted = await realFetch(`${app.baseUrl}/api/recipes/image/preview/previous-preview-token`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(deleted.status).toBe(503);
      expect(stub.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("production Electron authority preserves the normal session and image flow", async () => {
    const desktopToken = "desktop-test-authority";
    const stub = openAIImageStub();
    const app = await boot(
      { OPENAI_API_KEY: KEY, TKC_DESKTOP_SESSION_TOKEN: desktopToken },
      { isProduction: true, fetchImpl: stub.fetchMock }
    );
    try {
      const denied = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: app.baseUrl },
        body: "{}",
      });
      expect(denied.status).toBe(403);

      const bootstrapped = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: app.baseUrl,
          Cookie: `tkc_desktop_session=${desktopToken}`,
        },
        body: "{}",
      });
      expect(bootstrapped.status).toBe(200);
      const setCookie = bootstrapped.headers.get("set-cookie") ?? "";
      const imageCookie = setCookie.split(";")[0];
      expect(imageCookie).toMatch(/^tkc_image_session=/);
      const cookie = `tkc_desktop_session=${desktopToken}; ${imageCookie}`;

      const q = await quote(app.baseUrl, cookie);
      expect(q.status).toBe(200);
      const generated = await generate(app.baseUrl, cookie, {
        title: "Soup",
        confirmationToken: q.body["confirmationToken"],
      });
      expect(generated.status).toBe(200);
      expect(stub.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("non-loopback bind configuration fails closed", async () => {
    const app = await boot({ OPENAI_API_KEY: KEY, HOST: "0.0.0.0" }, { isProduction: true });
    try {
      const res = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: app.baseUrl },
        body: "{}",
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("IMAGE_SESSION_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });

  it("when AI_ENDPOINT_TOKEN is configured, bootstrap requires the shared bearer authorization", async () => {
    const app = await boot({ OPENAI_API_KEY: KEY, AI_ENDPOINT_TOKEN: "shared-endpoint-token" }, { fetchImpl: openAIImageStub().fetchMock });
    try {
      const unauthenticated = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: app.baseUrl },
        body: "{}",
      });
      expect(unauthenticated.status).toBe(401);

      const authorized = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: app.baseUrl,
          Authorization: "Bearer shared-endpoint-token",
        },
        body: "{}",
      });
      expect(authorized.status).toBe(200);
      expect(authorized.headers.get("set-cookie")).toContain("tkc_image_session=");
    } finally {
      await app.close();
    }
  });

  it("hosted multi-user mode fails closed", async () => {
    const app = await boot({ OPENAI_API_KEY: KEY, K_SERVICE: "hosted" });
    try {
      const res = await realFetch(`${app.baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: app.baseUrl },
        body: "{}",
      });
      expect(res.status).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("does not log session cookies, confirmation tokens, or provider keys", async () => {
    const stub = openAIImageStub();
    const app = await boot({ OPENAI_API_KEY: KEY }, { fetchImpl: stub.fetchMock });
    const logged: string[] = [];
    const capture = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    try {
      const a = await bootstrapImageSession(app.baseUrl, realFetch);
      const q = await quote(app.baseUrl, a.cookie);
      const token = q.body["confirmationToken"] as string;
      await generate(app.baseUrl, a.cookie, { title: "Soup", confirmationToken: token });
      const cookieToken = a.cookie.split("=")[1];
      const output = logged.join("\n");
      expect(output).not.toContain(cookieToken);
      expect(output).not.toContain(token);
      expect(output).not.toContain(KEY);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      await app.close();
    }
  });
});
