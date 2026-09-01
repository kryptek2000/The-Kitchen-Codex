import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createApp } from "../../server/app.js";

describe("Express server wiring", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp({ isProduction: false });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let originalToken: string | undefined;
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
});
