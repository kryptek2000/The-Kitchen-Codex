import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { createApp } from "../../server/app.js";
import { kitchenAnswerRateLimiter } from "../../server/rateLimiter.js";

const validEvidence = [
  { recipeIdentity: "chicken-rice", title: "Chicken Rice", reasons: ['contains "chicken"', 'contains "rice"'], totalMinutes: 25 },
  { recipeIdentity: "rice-only", title: "Rice Only", reasons: ['contains "rice"'] },
];

describe("Ask My Kitchen /api/kitchen/answer", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Force deterministic answer path: never attempt a Gemini call.
    delete process.env.GEMINI_API_KEY;
    process.env.KITCHEN_ANSWER_RATE_LIMIT = "1000";
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

  const answer = (body: unknown, token?: string) =>
    fetch(`${baseUrl}/api/kitchen/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("returns JSON 400 for malformed JSON", async () => {
    const res = await answer('{ "results": [ ');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON payload");
  });

  it("rejects a missing question", async () => {
    const res = await answer({ query: {}, results: validEvidence });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("question");
  });

  it("rejects a non-string question and a non-array results", async () => {
    expect((await answer({ question: 42, query: {}, results: validEvidence })).status).toBe(400);
    expect((await answer({ question: "q", query: {}, results: "nope" })).status).toBe(400);
    expect((await answer({ question: "q", query: "nope", results: validEvidence })).status).toBe(400);
  });

  it("rejects an oversized question and oversized results list", async () => {
    expect((await answer({ question: "a".repeat(501), query: {}, results: validEvidence })).status).toBe(400);
    const many = Array.from({ length: 20 }, (_, i) => ({ recipeIdentity: `r${i}`, title: `R${i}` }));
    expect((await answer({ question: "q", query: {}, results: many })).status).toBe(400);
  });

  it("requires a bearer token when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await helpAnswer({ question: "q", query: {}, results: validEvidence });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("grounds a deterministic answer and preserves evidence order", async () => {
    const res = await helpAnswer({ question: "what can I make with rice", query: {}, results: validEvidence });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.noMatches).toBe(false);
    expect(body.source).toBe("deterministic");
    expect(body.summary).toBe("I found 2 matching recipes in your vault.");
    expect(body.items.map((i: { recipeIdentity: string }) => i.recipeIdentity)).toEqual([
      "chicken-rice",
      "rice-only",
    ]);
    expect(body.items[0].title).toBe("Chicken Rice");
  });

  it("returns a grounded no-match when the evidence list is empty", async () => {
    const res = await helpAnswer({ question: "anything", query: {}, results: [] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.noMatches).toBe(true);
    expect(body.items).toEqual([]);
    expect(body.summary).toBe("I couldn't find a matching recipe in your vault.");
  });

  function helpAnswer(body: unknown, token?: string) {
    return answer(body, token);
  }
});

describe("kitchenAnswerRateLimiter", () => {
  it("returns 429 with rate-limit headers once the configured window is exceeded", () => {
    const original = process.env.KITCHEN_ANSWER_RATE_LIMIT;
    process.env.KITCHEN_ANSWER_RATE_LIMIT = "2";

    const req: any = { ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } };
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

    const call = () => kitchenAnswerRateLimiter(req, makeRes(), () => undefined);

    call();
    call();
    expect(statuses).toEqual([]);

    call();
    expect(statuses).toEqual([429]);
    expect(headers["RateLimit-Limit"]).toBe("2");
    expect(Number(headers["RateLimit-Remaining"])).toBe(0);

    if (original === undefined) delete process.env.KITCHEN_ANSWER_RATE_LIMIT;
    else process.env.KITCHEN_ANSWER_RATE_LIMIT = original;
  });
});
