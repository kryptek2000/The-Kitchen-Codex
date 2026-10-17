import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "TEST_ONLY_GEMINI_SECRET_SENTINEL";
const MODEL = "gemini-3.1-flash-lite";

async function freshConnectionTest() {
  vi.resetModules();
  process.env.GEMINI_API_KEY = SECRET;
  const connectionTest = await import("../../server/ai/connectionTest.js");
  connectionTest.resetConnectionTestConcurrencyForTests();
  return connectionTest;
}

function mockResponse(status: number, body: string) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
  return () => { globalThis.fetch = original; };
}

async function probeWithStatus(status: number, body: string) {
  const connectionTest = await freshConnectionTest();
  const restore = mockResponse(status, body);
  try {
    return await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text", modelId: MODEL });
  } finally {
    restore();
  }
}

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("provider connection-test diagnostics", () => {
  it.each([
    [400, "INVALID_ARGUMENT", "INVALID_REQUEST"],
    [401, "UNAUTHENTICATED", "AUTHENTICATION_FAILED"],
    [403, "PERMISSION_DENIED", "AUTHORIZATION_FAILED"],
    [404, "NOT_FOUND", "INVALID_MODEL"],
    [429, "RESOURCE_EXHAUSTED", "QUOTA_EXHAUSTED"],
    [500, "INTERNAL", "UPSTREAM_ERROR"],
  ] as const)("classifies HTTP %i using a bounded provider code", async (status, providerCode, expected) => {
    const raw = JSON.stringify({ error: { code: status, status: providerCode, message: `sensitive body ${SECRET}` } });
    const result = await probeWithStatus(status, raw);
    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.code).toBe(expected);
    expect(result.diagnostic).toEqual({ stage: "upstream_http", httpStatus: status, providerCode });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("sensitive body");
  });

  it("distinguishes a 429 rate limit from quota exhaustion when evidence says rate limit", async () => {
    const result = await probeWithStatus(429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Rate limit exceeded" } }));
    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.diagnostic?.httpStatus).toBe(429);
  });

  it("classifies timeout and network/DNS failures without including exception text", async () => {
    const connectionTest = await freshConnectionTest();
    const original = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => { throw new DOMException(`timeout ${SECRET}`, "TimeoutError"); }) as unknown as typeof fetch;
      const timeout = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text", modelId: MODEL });
      expect(timeout).toMatchObject({ ok: false, code: "TIMEOUT", diagnostic: { stage: "transport" } });
      globalThis.fetch = vi.fn(async () => { throw new TypeError(`getaddrinfo ENOTFOUND ${SECRET}`); }) as unknown as typeof fetch;
      const network = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text", modelId: MODEL });
      expect(network).toMatchObject({ ok: false, code: "NETWORK_ERROR", diagnostic: { stage: "transport" } });
      expect(JSON.stringify([timeout, network])).not.toContain(SECRET);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("separates response parsing failures from unexpected response shapes", async () => {
    const malformed = await probeWithStatus(200, "not-json");
    expect(malformed).toMatchObject({ ok: false, code: "RESPONSE_PARSE_ERROR", diagnostic: { stage: "response_parse" } });
    const unexpected = await probeWithStatus(200, JSON.stringify({ candidates: [] }));
    expect(unexpected).toMatchObject({ ok: false, code: "INVALID_RESPONSE", diagnostic: { stage: "response_validation" } });
  });

  it("uses bounded unknown-upstream output for unrecognized exceptions", async () => {
    const connectionTest = await freshConnectionTest();
    const original = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => { throw new Error(`private upstream detail ${SECRET}`); }) as unknown as typeof fetch;
      const result = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text", modelId: MODEL });
      expect(result).toMatchObject({ ok: false, code: "UNKNOWN_UPSTREAM", diagnostic: { stage: "unknown" } });
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain("private upstream detail");
    } finally {
      globalThis.fetch = original;
    }
  });
});
