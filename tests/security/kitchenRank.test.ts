import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import type { GoogleGenAI } from "@google/genai";
import { createApp } from "../../server/app.js";
import { kitchenRankRateLimiter } from "../../server/rateLimiter.js";
import { getGemini } from "../../server/geminiClient.js";

// Mock the Gemini client so we can force the AI/no-AI paths WITHOUT any live
// network or API key. Returns null (no AI) by default, so the degraded path is
// exercised deterministically.
vi.mock("../../server/geminiClient.js", () => ({
  getGemini: vi.fn(() => null),
}));

const validCandidates = [
  { recipeId: "a", title: "Alpha", totalMinutes: 25, difficulty: "Easy", course: ["Dinner"] },
  { recipeId: "b", title: "Beta", totalMinutes: 45, difficulty: "Medium" },
];

const validIntent = {
  version: 1,
  intent: "meal_suggestion",
  source: "vault",
  constraints: {},
  preferences: { effort: "low" },
  requiresClarification: false,
};

function mockGemini(payload: unknown) {
  vi.mocked(getGemini).mockReturnValue({
    models: {
      generateContent: async () => ({ text: JSON.stringify(payload) }),
    },
  } as unknown as GoogleGenAI);
}

describe("Ask My Kitchen /api/kitchen/rank", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.KITCHEN_RANK_RATE_LIMIT = "1000";
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

  const rank = (body: unknown, token?: string) =>
    fetch(`${baseUrl}/api/kitchen/rank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("rejects a missing / non-string / oversized question", async () => {
    expect((await rank({})).status).toBe(400);
    expect((await rank({ question: 42, candidates: validCandidates })).status).toBe(400);
    expect(
      (await rank({ question: "a".repeat(501), candidates: validCandidates })).status
    ).toBe(400);
  });

  it("rejects a non-array, oversized, or empty candidates list", async () => {
    expect((await rank({ question: "q", candidates: "nope" })).status).toBe(400);
    expect(
      (await rank({ question: "q", candidates: Array.from({ length: 21 }, (_, i) => ({ recipeId: `r${i}` })) })).status
    ).toBe(400);
    expect((await rank({ question: "q", candidates: [] })).status).toBe(400);
  });

  it("requires a bearer token when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await rank({ question: "q", candidates: validCandidates });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("degrades to ok:false (200) when AI is unavailable (no Gemini)", async () => {
    vi.mocked(getGemini).mockReturnValue(null);
    const res = await rank({ question: "what should I make tonight", intent: validIntent, candidates: validCandidates });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.source).toBe("deterministic");
  });

  it("returns a sanitized ranked list (ok:true, source=ai) when AI works", async () => {
    mockGemini({ ranked: [{ recipeId: "b", score: 0.9 }, { recipeId: "a", score: 0.8 }] });
    try {
      const res = await rank({ question: "q", intent: validIntent, candidates: validCandidates });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.source).toBe("ai");
      expect(body.ranked.map((x: { recipeId: string }) => x.recipeId)).toEqual(["b", "a"]);
      expect(body.ranked[0].score).toBe(0.9);
      // No provider/vault data leaks.
      expect(JSON.stringify(body)).not.toContain("rawMarkdown");
      expect(JSON.stringify(body)).not.toContain("filePath");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("rejects AI output that only contains unknown IDs (ok:false)", async () => {
    mockGemini({ ranked: [{ recipeId: "evil-id", score: 0.9 }] });
    try {
      const res = await rank({ question: "q", intent: validIntent, candidates: validCandidates });
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.source).toBe("deterministic");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("never leaks provider errors on a thrown Gemini failure", async () => {
    vi.mocked(getGemini).mockReturnValue({
      models: {
        generateContent: async () => {
          throw new Error("RESOURCE_EXHAUSTED secret details");
        },
      },
    } as unknown as GoogleGenAI);
    try {
      const res = await rank({ question: "q", intent: validIntent, candidates: validCandidates });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.source).toBe("deterministic");
      expect(JSON.stringify(body)).not.toContain("RESOURCE_EXHAUSTED");
      expect(JSON.stringify(body)).not.toContain("secret details");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("does not widen membership: only supplied ids can appear", async () => {
    mockGemini({ ranked: [{ recipeId: "a", score: 0.9 }, { recipeId: "zzz", score: 0.5 }] });
    try {
      const res = await rank({ question: "q", intent: validIntent, candidates: validCandidates });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.ranked.map((x: { recipeId: string }) => x.recipeId)).toEqual(["a"]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });
});

describe("kitchenRankRateLimiter", () => {
  it("returns 429 with rate-limit headers once the configured window is exceeded", () => {
    const original = process.env.KITCHEN_RANK_RATE_LIMIT;
    process.env.KITCHEN_RANK_RATE_LIMIT = "2";

    const req: any = { ip: "203.0.113.11", socket: { remoteAddress: "203.0.113.11" } };
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

    const call = () => kitchenRankRateLimiter(req, makeRes(), () => undefined);

    call();
    call();
    expect(statuses).toEqual([]);

    call();
    expect(statuses).toEqual([429]);
    expect(headers["RateLimit-Limit"]).toBe("2");
    expect(Number(headers["RateLimit-Remaining"])).toBe(0);

    if (original === undefined) delete process.env.KITCHEN_RANK_RATE_LIMIT;
    else process.env.KITCHEN_RANK_RATE_LIMIT = original;
  });
});
