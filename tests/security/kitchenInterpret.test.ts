import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createApp } from "../../server/app.js";
import { kitchenInterpretRateLimiter } from "../../server/rateLimiter.js";

describe("Ask My Kitchen /api/kitchen/interpret", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Force the deterministic interpretation path: never attempt a Gemini call.
    delete process.env.GEMINI_API_KEY;
    process.env.KITCHEN_RATE_LIMIT = "1000";
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

  const interpret = (body: unknown, token?: string) =>
    fetch(`${baseUrl}/api/kitchen/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("rejects a missing question", async () => {
    const res = await interpret({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("question");
  });

  it("rejects a non-string question", async () => {
    const res = await interpret({ question: 42 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("rejects an oversized question", async () => {
    const res = await interpret({ question: "a".repeat(501) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("requires a bearer token when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await interpret({ question: "under 30 minutes" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("interprets a clear question deterministically", async () => {
    const res = await interpret({ question: "under 30 minutes" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("deterministic");
    expect(body.query.maxTotalMinutes).toBe(30);
  });

  it("returns a safe 422 for an uninterpretable question", async () => {
    const res = await interpret({ question: "what is the meaning of life" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("ignores any extra payload and never accepts recipe data", async () => {
    const res = await interpret({ question: "with eggs", recipes: [{ id: "x" }], ingredients: ["milk"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.query.includeIngredients).toEqual(["eggs"]);
    expect("recipes" in body.query).toBe(false);
    expect("ingredients" in body.query).toBe(false);
  });
});

describe("kitchenInterpretRateLimiter", () => {
  it("returns 429 with rate-limit headers once the configured window is exceeded", () => {
    const original = process.env.KITCHEN_RATE_LIMIT;
    process.env.KITCHEN_RATE_LIMIT = "2";

    // Unique IP so this does not collide with the HTTP-server tests above.
    const req: any = { ip: "198.51.100.7", socket: { remoteAddress: "198.51.100.7" } };
    const headers: Record<string, string> = {};
    const statuses: number[] = [];

    const makeRes: any = () => ({
      setHeader: (key: string, value: string) => {
        headers[key] = String(value);
      },
      status: (code: number) => {
        statuses.push(code);
        return { json: () => undefined };
      },
      json: () => undefined,
    });

    const call = () => kitchenInterpretRateLimiter(req, makeRes(), () => undefined);

    // Two requests within the window pass (next is called); the third is limited.
    call();
    call();
    expect(statuses).toEqual([]);

    call();
    expect(statuses).toEqual([429]);
    expect(headers["RateLimit-Limit"]).toBe("2");
    expect(Number(headers["RateLimit-Remaining"])).toBe(0);

    if (original === undefined) delete process.env.KITCHEN_RATE_LIMIT;
    else process.env.KITCHEN_RATE_LIMIT = original;
  });
});
