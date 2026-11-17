import { describe, it, expect, vi } from "vitest";
import { BrowserNetworkAdapter } from "../../src/platform/browser/BrowserNetworkAdapter";

/**
 * P2-R1 — browser transport image-session bootstrap.
 *
 * The raw session token is an HttpOnly cookie; the adapter only performs the
 * same-origin bootstrap and relies on the browser cookie jar. No token is read,
 * stored, or added to headers/URLs.
 */

const TRUSTED = () => ({ Authorization: "Bearer endpoint-token" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("BrowserNetworkAdapter — image-session bootstrap", () => {
  it("bootstraps once before the first image call (same-origin, trusted auth) and not for text routes", async () => {
    const calls: { url: string; method?: string; headers?: Record<string, string>; credentials?: string }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        headers: (init?.headers as Record<string, string>) ?? {},
        credentials: init?.credentials,
      });
      if (url === "/api/session/bootstrap") return new Response("{}", { status: 200 });
      return jsonResponse({ ok: true });
    });
    const adapter = new BrowserNetworkAdapter({
      fetchFn,
      imageSessionBootstrap: true,
      authorizationHeaders: TRUSTED,
    });

    await adapter.post("/api/kitchen/interpret", { q: "x" });
    expect(calls.map((c) => c.url)).toEqual(["/api/kitchen/interpret"]);

    await adapter.post("/api/recipes/image/quote", { title: "x" });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/kitchen/interpret",
      "/api/session/bootstrap",
      "/api/recipes/image/quote",
    ]);
    const bootstrap = calls[1];
    expect(bootstrap.method).toBe("POST");
    expect(bootstrap.credentials).toBe("same-origin");
    expect(bootstrap.headers?.Authorization).toBe("Bearer endpoint-token");

    // A second image call reuses the established session (no second bootstrap).
    await adapter.getBytes("/api/recipes/image/preview/token-1");
    expect(calls.filter((c) => c.url === "/api/session/bootstrap")).toHaveLength(1);
    expect(calls.at(-1)?.url).toBe("/api/recipes/image/preview/token-1");
  });

  it("re-bootstraps ONCE after a 401, then retries the image request", async () => {
    let bootstrapCount = 0;
    let imageCount = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "/api/session/bootstrap") {
        bootstrapCount += 1;
        return new Response("{}", { status: 200 });
      }
      imageCount += 1;
      return imageCount === 1
        ? jsonResponse({ code: "IMAGE_SESSION_REQUIRED" }, 401)
        : jsonResponse({ ok: true });
    });
    const adapter = new BrowserNetworkAdapter({ fetchFn, imageSessionBootstrap: true });
    const res = await adapter.post("/api/recipes/image/quote", { title: "x" });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(bootstrapCount).toBe(2);
    expect(imageCount).toBe(2);
  });

  it("a refused bootstrap fails closed before the image request and is retryable later", async () => {
    let bootstrapStatus = 403;
    let imageCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "/api/session/bootstrap") return new Response("{}", { status: bootstrapStatus });
      imageCalls += 1;
      return jsonResponse({ ok: true });
    });
    const adapter = new BrowserNetworkAdapter({ fetchFn, imageSessionBootstrap: true });
    await expect(adapter.get("/api/recipes/image/quote")).rejects.toMatchObject({ status: 403 });
    expect(imageCalls).toBe(0);

    bootstrapStatus = 200;
    const res = await adapter.get("/api/recipes/image/quote");
    expect(res.status).toBe(200);
    expect(imageCalls).toBe(1);
  });

  it("defaults to NO bootstrap (tests/non-image shells unchanged)", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({ ok: true });
    });
    const adapter = new BrowserNetworkAdapter({ fetchFn });
    await adapter.post("/api/recipes/image/quote", { title: "x" });
    expect(calls).toEqual(["/api/recipes/image/quote"]);
  });
});
