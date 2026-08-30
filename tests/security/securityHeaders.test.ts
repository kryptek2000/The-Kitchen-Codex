import express from "express";
import { describe, it, expect, afterAll } from "vitest";
import type { Server } from "http";
import { createSecurityMiddleware } from "../../server/securityHeaders.js";

describe("createSecurityMiddleware", () => {
  function startTestServer(isProduction: boolean): Promise<{ server: Server; baseUrl: string }> {
    return new Promise((resolve) => {
      const app = express();
      app.use(createSecurityMiddleware(isProduction));
      app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
      const server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
  }

  async function getHeaders(baseUrl: string): Promise<Headers> {
    const res = await fetch(`${baseUrl}/api/health`);
    return res.headers;
  }

  const servers: Server[] = [];

  async function withServer(isProduction: boolean): Promise<string> {
    const { server, baseUrl } = await startTestServer(isProduction);
    servers.push(server);
    return baseUrl;
  }

  afterAll(async () => {
    await Promise.all(
      servers.map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve()))
      )
    );
  });

  it("sets X-Content-Type-Options to nosniff", async () => {
    const baseUrl = await withServer(true);
    const headers = await getHeaders(baseUrl);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("adds clickjacking protection via X-Frame-Options", async () => {
    const baseUrl = await withServer(true);
    const headers = await getHeaders(baseUrl);
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("adds clickjacking protection via CSP frame-ancestors in production", async () => {
    const baseUrl = await withServer(true);
    const headers = await getHeaders(baseUrl);
    const csp = headers.get("content-security-policy") || "";
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("sets a restrictive Referrer-Policy", async () => {
    const baseUrl = await withServer(true);
    const headers = await getHeaders(baseUrl);
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("emits a Content Security Policy in production", async () => {
    const baseUrl = await withServer(true);
    const headers = await getHeaders(baseUrl);
    const csp = headers.get("content-security-policy") || "";
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
  });

  it("does not emit a restrictive Content Security Policy in development", async () => {
    const baseUrl = await withServer(false);
    const headers = await getHeaders(baseUrl);
    // The Vite dev server relies on inline scripts/HMR, so no document CSP.
    expect(headers.get("content-security-policy")).toBeNull();
  });
});
