import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import type { GoogleGenAI } from "@google/genai";
import { createApp } from "../../server/app.js";
import { kitchenDiscoverRateLimiter } from "../../server/rateLimiter.js";
import { getGemini } from "../../server/geminiClient.js";
import { MODEL_CONFIG } from "../../server/modelConfig.js";

vi.mock("../../server/geminiClient.js", () => ({
  getGemini: vi.fn(() => null),
}));

const validIntent = {
  version: 1,
  intent: "find_recipes",
  source: "web",
  constraints: { includeIngredients: ["gumbo"] },
  preferences: {},
  requiresClarification: false,
};

function mockGemini(payload: unknown) {
  vi.mocked(getGemini).mockReturnValue({
    models: {
      generateContent: async () => payload,
    },
  } as unknown as GoogleGenAI);
}

describe("Ask My Kitchen /api/kitchen/discover", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.KITCHEN_DISCOVER_RATE_LIMIT = "1000";
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

  const discover = (body: unknown, token?: string) =>
    fetch(`${baseUrl}/api/kitchen/discover`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("Y: requires a bearer token when one is configured", async () => {
    process.env.AI_ENDPOINT_TOKEN = "super-secret";
    const res = await discover({ question: "q", intent: validIntent });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("AA: rejects missing / non-string / oversized question", async () => {
    expect((await discover({})).status).toBe(400);
    expect((await discover({ question: 42, intent: validIntent })).status).toBe(400);
    expect(
      (await discover({ question: "a".repeat(501), intent: validIntent })).status
    ).toBe(400);
  });

  it("rejects an invalid intent", async () => {
    const res = await discover({ question: "q", intent: { intent: "nope" } });
    expect(res.status).toBe(400);
  });

  it("AE: never accepts a URL-fetch target (url is ignored), never fetches a user target", async () => {
    // Only status is surfaced; the server treats discovery as query-only. Supply a
    // url to prove it does not become a fetch target / is ignored.
    const res = await discover({ question: "q", intent: validIntent, url: "http://attacker.example/x" });
    // With no Gemini, the query-only path degrades to unavailable (not a fetch of the url).
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unavailable");
  });

  it("degrade: no Gemini -> unavailable (no fake results)", async () => {
    vi.mocked(getGemini).mockReturnValue(null);
    const res = await discover({ question: "find gumbo", intent: validIntent });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.source).toBe("web");
    expect(body.reason).toBe("unavailable");
    expect(body.results).toEqual([]);
  });

  it("success: provider grounding URLs become sanitized web results", async () => {
    mockGemini({
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://example.com/gumbo", title: "Real Gumbo", domain: "example.com" } },
          { web: { uri: "https://example.com/other", title: "Other", domain: "example.com" } },
        ],
      },
    });
    try {
      const res = await discover({ question: "find gumbo", intent: validIntent, maxResults: 8 });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.source).toBe("web");
      expect(body.results.map((r: { url: string }) => r.url)).toEqual([
        "https://example.com/gumbo",
        "https://example.com/other",
      ]);
      // No raw/nested vault-ish data leaks.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("rawMarkdown");
      expect(serialized).not.toContain("filePath");
      expect(serialized).not.toContain("recipeId");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("no hallucinated URLs: model text with a guessed URL but no grounding -> no results", async () => {
    mockGemini({ text: "Try https://foodblog.example/fake-gumbo for the recipe" });
    try {
      const res = await discover({ question: "find gumbo", intent: validIntent });
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("unavailable");
      expect(body.results).toEqual([]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("AC: provider error -> safe fixed failure, no leak", async () => {
    vi.mocked(getGemini).mockReturnValue({
      models: {
        generateContent: async () => {
          throw new Error("RESOURCE_EXHAUSTED secret-details");
        },
      },
    } as unknown as GoogleGenAI);
    try {
      const res = await discover({ question: "q", intent: validIntent });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("unavailable");
      expect(JSON.stringify(body)).not.toContain("RESOURCE_EXHAUSTED");
      expect(JSON.stringify(body)).not.toContain("secret-details");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("AB: oversized maxResults is bounded (never exceeds MAX_WEB_RESULTS)", async () => {
    mockGemini({
      groundingMetadata: {
        groundingChunks: Array.from({ length: 20 }, (_, i) => ({
          web: { uri: `https://example.com/r${i}`, title: `R${i}`, domain: "example.com" },
        })),
      },
    });
    try {
      const res = await discover({ question: "q", intent: validIntent, maxResults: 999 });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.results.length).toBeLessThanOrEqual(8);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  // --- v0.5.1: kitchen discovery model fallback chain (grounding-only) ---
  const modelAwareGemini = (handler: (params: { model: string }) => unknown) => {
    vi.mocked(getGemini).mockReturnValue({
      models: {
        generateContent: async (params: any) => handler(params),
      },
    } as unknown as GoogleGenAI);
  };
  const grounding = (urls: string[]) => ({
    groundingMetadata: {
      groundingChunks: urls.map((url) => ({ web: { uri: url, title: "R", domain: "example.com" } })),
    },
  });

  it("M: discovery primary produces grounding -> success", async () => {
    modelAwareGemini(() => grounding(["https://example.com/a", "https://example.com/b"]));
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.source).toBe("web");
      expect(body.results.map((r: { url: string }) => r.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("N: primary throws -> fallback grounding succeeds", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenDiscoveryPrimary) throw new Error("primary down");
      return grounding(["https://example.com/fallback"]);
    });
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.results.map((r: { url: string }) => r.url)).toEqual(["https://example.com/fallback"]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("O: primary returns zero grounding -> fallback grounding succeeds", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenDiscoveryPrimary) return { text: "just prose, no grounding" };
      return grounding(["https://example.com/fallback-ok"]);
    });
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.results.map((r: { url: string }) => r.url)).toEqual(["https://example.com/fallback-ok"]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("P: primary + fallback fail -> unavailable (no fake results)", async () => {
    modelAwareGemini(() => {
      throw new Error("all discovery models down");
    });
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("unavailable");
      expect(body.results).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("all discovery models down");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("Q/R: model-prose URLs with no grounding are NEVER accepted (all models -> zero results)", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenDiscoveryPrimary) {
        return { text: "try https://foodblog.example/fake-gumbo for the recipe" };
      }
      return { text: "also https://other.example/fake" };
    });
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      // No grounding in either model -> must NOT surface any URL.
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("unavailable");
      expect(body.results).toEqual([]);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("S: fallback grounding URLs still pass the sanitizer (http/https only)", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenDiscoveryPrimary) throw new Error("primary down");
      return grounding(["https://example.com/ok", "javascript:alert(1)", "http://example.com/http"]);
    });
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      expect(body.ok).toBe(true);
      const urls = body.results.map((r: { url: string }) => r.url);
      expect(urls).toContain("https://example.com/ok");
      expect(urls).toContain("http://example.com/http");
      expect(urls).not.toContain("javascript:alert(1)");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("T: model cannot return arbitrary local IDs", async () => {
    modelAwareGemini((p) => {
      if (p.model === MODEL_CONFIG.kitchenDiscoveryPrimary) throw new Error("primary down");
      return {
        ...grounding(["https://example.com/ok"]),
        recipeIds: ["local-1"],
        filePath: "/x.md",
      };
    });
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("local-1");
      expect(serialized).not.toContain("/x.md");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("U: provider diagnostics do not alter the client response", async () => {
    modelAwareGemini(() => {
      throw new Error("secret internal message");
    });
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      expect(body).toEqual({ ok: false, source: "web", results: [], reason: "unavailable" });
      expect(JSON.stringify(body)).not.toContain("secret internal message");
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });

  it("V: discovery primary config keeps googleSearch tool and does NOT force MINIMAL thinking", async () => {
    let seenConfig: any;
    vi.mocked(getGemini).mockReturnValue({
      models: {
        generateContent: async (params: any) => {
          if (params.model === MODEL_CONFIG.kitchenDiscoveryPrimary) {
            seenConfig = params.config;
            return grounding(["https://example.com/verified"]);
          }
          throw new Error("should not be reached");
        },
      },
    } as unknown as GoogleGenAI);
    try {
      const res = await discover({ question: "q", intent: validIntent });
      const body = await res.json();
      expect(body.ok).toBe(true);
      // googleSearch tool is preserved.
      expect(seenConfig.tools).toEqual([{ googleSearch: {} }]);
      // The unsupported forced MINIMAL thinking level must NOT be sent.
      expect(seenConfig.thinkingConfig).toBeUndefined();
      // temperature retained.
      expect(seenConfig.temperature).toBe(0);
    } finally {
      vi.mocked(getGemini).mockReturnValue(null);
    }
  });
});

describe("kitchenDiscoverRateLimiter", () => {
  it("Z: returns 429 with rate-limit headers once the configured window is exceeded", () => {
    const original = process.env.KITCHEN_DISCOVER_RATE_LIMIT;
    process.env.KITCHEN_DISCOVER_RATE_LIMIT = "2";

    const req: any = { ip: "203.0.113.21", socket: { remoteAddress: "203.0.113.21" } };
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

    const call = () => kitchenDiscoverRateLimiter(req, makeRes(), () => undefined);

    call();
    call();
    expect(statuses).toEqual([]);

    call();
    expect(statuses).toEqual([429]);
    expect(headers["RateLimit-Limit"]).toBe("2");
    expect(Number(headers["RateLimit-Remaining"])).toBe(0);

    if (original === undefined) delete process.env.KITCHEN_DISCOVER_RATE_LIMIT;
    else process.env.KITCHEN_DISCOVER_RATE_LIMIT = original;
  });
});
