import { describe, it, expect, afterEach, vi } from "vitest";

const SENTINEL = "SUPER_SECRET_BYOK4_SENTINEL";
const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "KITCHEN_CODEX_TEXT_PROVIDER",
  "KITCHEN_CODEX_TEXT_MODEL",
  "KITCHEN_CODEX_IMAGE_PROVIDER",
  "KITCHEN_CODEX_IMAGE_MODEL",
] as const;

async function freshModule(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const connectionTest = await import("../../server/ai/connectionTest.js");
  connectionTest.resetConnectionTestConcurrencyForTests();
  return { connectionTest };
}

/** Stubs globalThis.fetch, recording (method,url,body) + returning the given status. */
function stubFetch(status: number, body = "{}") {
  const calls: { method: string; url: string; body?: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({
      method: (init?.method ?? "GET") as string,
      url: typeof input === "string" ? input : input.url,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.doUnmock("../../server/geminiClient.js");
  vi.resetModules();
});

describe("BYOK-4 — connectionTestKindForProvider", () => {
  it("text providers are network_probe when configured, unavailable otherwise", async () => {
    let { connectionTest } = await freshModule({});
    expect(connectionTest.connectionTestKindForProvider("gemini", "text")).toBe("unavailable");
    expect(connectionTest.connectionTestKindForProvider("openrouter", "text")).toBe("unavailable");
    expect(connectionTest.connectionTestKindForProvider("deepseek", "text")).toBe("unavailable");

    ({ connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL }));
    expect(connectionTest.connectionTestKindForProvider("gemini", "text")).toBe("network_probe");
    expect(connectionTest.connectionTestKindForProvider("openrouter", "text")).toBe("unavailable");
  });

  it("image providers are credential_check when configured, unavailable otherwise", async () => {
    let { connectionTest } = await freshModule({});
    expect(connectionTest.connectionTestKindForProvider("gemini-image", "image")).toBe("unavailable");
    expect(connectionTest.connectionTestKindForProvider("openrouter-image", "image")).toBe("unavailable");

    ({ connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL }));
    expect(connectionTest.connectionTestKindForProvider("gemini-image", "image")).toBe("credential_check");

    ({ connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL }));
    expect(connectionTest.connectionTestKindForProvider("openrouter-image", "image")).toBe("credential_check");
  });
});

describe("BYOK-4 — runConnectionTest bounded + fail-closed (no real network)", () => {
  it("unknown text provider => bounded PROVIDER_ERROR, never leaks a secret", async () => {
    const { connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const result = await connectionTest.runConnectionTest({ providerId: "ghost", kind: "text" });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.message.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expect(JSON.stringify(result)).not.toContain("API_KEY");
    }
  });

  it("unconfigured (no key) provider => fail-fast UNAVAILABLE with no network call", async () => {
    const { connectionTest } = await freshModule({});
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("UNAVAILABLE");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("OpenRouter text probe uses the FIXED /api/v1/key credential endpoint (no generation) and bounds auth failures", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubFetch(401, JSON.stringify({ error: 'secret raw body with key "' + SENTINEL + '"' }));
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe("AUTH");
        expect(result.model).toBe("openai/gpt-4o-mini");
        expect(result.credentialSource).toBe("server_environment");
        expect(JSON.stringify(result)).not.toContain(SENTINEL);
        expect(result.message).not.toContain("secret raw body");
      }
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("GET");
    expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/key");
  });

  it("DeepSeek text probe uses the allowlisted DeepSeek chat endpoint with a tiny max_tokens", async () => {
    const { connectionTest } = await freshModule({ DEEPSEEK_API_KEY: SENTINEL });
    const stub = stubFetch(503);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "deepseek", kind: "text" });
      expect(result.ok).toBe(false);
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toContain("deepseek");
    expect(JSON.parse(stub.calls[0].body!).max_tokens).toBe(8);
  });

  it("HTTP 200 with an EMPTY/malformed chat body is NOT a success", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    for (const body of ["", "{}", "not json", JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: "" } }] })]) {
      const stub = stubFetch(200, body);
      try {
        const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
        expect(result.ok, body).toBe(false);
        if (result.ok === false) expect(result.code, body).toBe("INVALID_RESPONSE");
      } finally {
        stub.restore();
      }
    }
  });

  it("never returns a secret value anywhere in the result payload", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubFetch(500, `{"raw": "${SENTINEL}"}`);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
      const json = JSON.stringify(result);
      expect(json).not.toContain(SENTINEL);
      expect(json).not.toContain("GEMINI_API_KEY");
      expect(json).not.toContain("OPENROUTER_API_KEY");
      expect(json).not.toContain("Bearer");
      expect(json).not.toContain("sk-");
    } finally {
      stub.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// GEMINI: fixed REST probes with bounded bodies (no SDK, no unbounded parse)
// ---------------------------------------------------------------------------

describe("BYOK-4 — Gemini probes use a fixed REST path with tiny requests", () => {
  it("text probe uses the fixed Generative Language origin + tiny maxOutputTokens, and validates the shape", async () => {
    const { connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const stub = stubFetch(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text" });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("POST");
    expect(stub.calls[0].url).toContain("https://generativelanguage.googleapis.com/");
    expect(stub.calls[0].url).toContain(":generateContent");
    const body = JSON.parse(stub.calls[0].body!);
    expect(body.generationConfig.maxOutputTokens).toBe(8);
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(256);
  });

  it("Gemini HTTP 200 with a malformed/empty body is NOT a success", async () => {
    const { connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    for (const body of ["", "{}", "not json", JSON.stringify({ candidates: [] })]) {
      const stub = stubFetch(200, body);
      try {
        const result = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text" });
        expect(result.ok, body).toBe(false);
        if (result.ok === false) expect(result.code, body).toBe("INVALID_RESPONSE");
      } finally {
        stub.restore();
      }
    }
  });

  it("Gemini image credential check is a bounded REST models list (no generation)", async () => {
    const { connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const stub = stubFetch(200, JSON.stringify({ models: [{ name: "models/gemini-3.7-flash" }] }));
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "gemini-image", kind: "image" });
      expect(result.ok).toBe(true);
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("GET");
    expect(stub.calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });
});

// ---------------------------------------------------------------------------
// OPENROUTER IMAGE CREDENTIAL: real /api/v1/key semantics (NOT /models)
// ---------------------------------------------------------------------------

describe("BYOK-4 — OpenRouter image credential check", () => {
  it("uses the FIXED /api/v1/key endpoint and succeeds on a valid minimal response", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubFetch(200, JSON.stringify({ data: { label: "sk-...", limit: 10, usage: 1 } }));
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter-image", kind: "image" });
      expect(result.ok).toBe(true);
      const json = JSON.stringify(result);
      expect(json).not.toContain("label");
      expect(json).not.toContain("limit");
      expect(json).not.toContain("usage");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("GET");
    expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/key");
    expect(stub.calls[0].url).not.toContain("/models");
  });

  it("a 401 fake key => AUTH failure (never credential success)", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubFetch(401, JSON.stringify({ error: { message: "invalid api key" } }));
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter-image", kind: "image" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("AUTH");
    } finally {
      stub.restore();
    }
    expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/key");
  });

  it("malformed success bodies and non-typed key metadata => INVALID_RESPONSE", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const bad = [
      "",
      "not json",
      "{}",
      JSON.stringify({ data: null }),
      JSON.stringify({ data: [] }), // array rejects
      JSON.stringify({ data: {} }), // empty object rejects
      JSON.stringify({ data: { label: 123 } }), // wrong typed field rejects
      JSON.stringify({ data: { limit: "ten" } }), // wrong typed field rejects
    ];
    for (const body of bad) {
      const stub = stubFetch(200, body);
      try {
        const result = await connectionTest.runConnectionTest({ providerId: "openrouter-image", kind: "image" });
        expect(result.ok, body).toBe(false);
        if (result.ok === false) expect(result.code, body).toBe("INVALID_RESPONSE");
      } finally {
        stub.restore();
      }
    }
  });

  it("accepts a minimal response proving authenticated key metadata (one typed field)", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    for (const data of [{ label: "key" }, { limit: null }, { usage: 0 }, { is_free_tier: false }]) {
      const stub = stubFetch(200, JSON.stringify({ data }));
      try {
        const result = await connectionTest.runConnectionTest({ providerId: "openrouter-image", kind: "image" });
        expect(result.ok, JSON.stringify(data)).toBe(true);
      } finally {
        stub.restore();
      }
    }
  });

  it("does NOT treat /models-as-credential-success as valid (endpoint is /key)", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubFetch(200, JSON.stringify({ data: { label: "x" } }));
    try {
      await connectionTest.runConnectionTest({ providerId: "openrouter-image", kind: "image" });
    } finally {
      stub.restore();
    }
    expect(stub.calls.map((c) => c.url)).not.toContain("https://openrouter.ai/api/v1/models");
  });
});

// ---------------------------------------------------------------------------
// UNIVERSAL RESPONSE-BYTE BOUNDS
// ---------------------------------------------------------------------------

function streamingResponse(chunks: string[], status = 200) {
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), wasCancelled: () => cancelled };
}

describe("BYOK-4 — universal probe response-byte bounds", () => {
  it("OpenRouter oversized SUCCESS body is rejected and the stream is cancelled", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const big = "x".repeat(64 * 1024);
    const { res, wasCancelled } = streamingResponse([big, big, big], 200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => res) as unknown as typeof globalThis.fetch;
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe("INVALID_RESPONSE");
        expect(result.message.length).toBeLessThanOrEqual(120);
      }
      expect(wasCancelled()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Gemini oversized SUCCESS body is rejected/cancelled before full retention", async () => {
    const { connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const big = "x".repeat(64 * 1024);
    const { res, wasCancelled } = streamingResponse([big, big, big], 200);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => res) as unknown as typeof globalThis.fetch;
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("INVALID_RESPONSE");
      expect(wasCancelled()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Gemini oversized ERROR body is bounded (classification never buffers the whole body)", async () => {
    const { connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const big = "x".repeat(64 * 1024);
    const { res, wasCancelled } = streamingResponse([big, big, big], 500);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => res) as unknown as typeof globalThis.fetch;
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe("PROVIDER_ERROR");
        expect(result.message.length).toBeLessThanOrEqual(120);
      }
      expect(wasCancelled()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("a non-streamable response FAILS CLOSED without ever calling res.text()", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    let textCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: null,
      text: async () => {
        textCalled = true;
        return "{}";
      },
    })) as unknown as typeof globalThis.fetch;
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("INVALID_RESPONSE");
      expect(textCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces a small GLOBAL in-flight ceiling (reject before provider call, no hidden retry)", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const max = connectionTest.CONNECTION_TEST_MAX_IN_FLIGHT;
    expect(max).toBeGreaterThanOrEqual(2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      await gate;
      return new Response(JSON.stringify({ data: { label: "x" } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const running = Array.from({ length: max + 1 }, () =>
        connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" })
      );
      expect(networkCalls).toBe(max);
      release();
      const settled = await Promise.all(running);
      const busy = settled.filter((r: any) => r.ok === false && r.code === "BUSY");
      expect(busy).toHaveLength(1);
      expect(connectionTest.getInFlightConnectionTestCount()).toBe(0);
    } finally {
      release?.();
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// OPERATOR POLICY: a server-managed pin restricts probes
// ---------------------------------------------------------------------------

describe("BYOK-4 — connection test honors the server-managed operator pin", () => {
  it("Gemini text pin + caller asks OpenRouter => rejected with ZERO OpenRouter traffic", async () => {
    const { connectionTest } = await freshModule({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "gemini",
      KITCHEN_CODEX_TEXT_MODEL: "gemini-3.7-flash",
    });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("OPERATOR_PIN");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("OpenRouter pin + caller asks Gemini => rejected with ZERO Gemini calls", async () => {
    const { connectionTest } = await freshModule({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
      KITCHEN_CODEX_TEXT_MODEL: "openai/gpt-4o-mini",
    });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("OPERATOR_PIN");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("pinned model mismatch => rejected before network", async () => {
    const { connectionTest } = await freshModule({
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
      KITCHEN_CODEX_TEXT_MODEL: "openai/gpt-4o-mini",
    });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text", modelId: "some-other-model" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("OPERATOR_PIN");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("an INVALID server-managed pin => fail closed with ZERO network traffic", async () => {
    const { connectionTest } = await freshModule({
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "ghost-provider",
    });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("OPERATOR_PIN");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("a matching pin => the probe is allowed (and uses the pinned model)", async () => {
    const { connectionTest } = await freshModule({
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_TEXT_PROVIDER: "openrouter",
      KITCHEN_CODEX_TEXT_MODEL: "openai/gpt-4o-mini",
    });
    const stub = stubFetch(200, JSON.stringify({ data: { label: "x" } }));
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text", modelId: "openai/gpt-4o-mini" });
      expect(result.ok).toBe(true);
      if (result.ok === true) {
        expect(result.model).toBe("openai/gpt-4o-mini");
        expect(result.credentialSource).toBe("server_environment");
      }
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(1);
  });

  it("an image server pin also restricts the image probe", async () => {
    const { connectionTest } = await freshModule({
      GEMINI_API_KEY: SENTINEL,
      OPENROUTER_API_KEY: SENTINEL,
      KITCHEN_CODEX_IMAGE_PROVIDER: "gemini-image",
    });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter-image", kind: "image" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("OPERATOR_PIN");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Curated MODEL ALLOWLIST (INVALID_MODEL)
// ---------------------------------------------------------------------------

describe("BYOK-4 FINAL — runConnectionTest curated model allowlist", () => {
  it("rebukes an ARBITRARY Gemini TEXT model with INVALID_MODEL and ZERO network calls", async () => {
    const { connectionTest } = await freshModule({ GEMINI_API_KEY: SENTINEL });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "gemini", kind: "text", modelId: "arbitrary-model-xyz" });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.code).toBe("INVALID_MODEL");
        expect(result.model).toBe("arbitrary-model-xyz");
        expect(JSON.stringify(result)).not.toContain("API_KEY");
      }
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("rebukes an ARBITRARY OpenRouter TEXT model with INVALID_MODEL and ZERO network calls", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter", kind: "text", modelId: "not-a-curated-llm" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("INVALID_MODEL");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("rebukes an ARBITRARY image model (openrouter-image) with INVALID_MODEL and ZERO network calls", async () => {
    const { connectionTest } = await freshModule({ OPENROUTER_API_KEY: SENTINEL });
    const stub = stubFetch(200);
    try {
      const result = await connectionTest.runConnectionTest({ providerId: "openrouter-image", kind: "image", modelId: "not-a-curated-image" });
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.code).toBe("INVALID_MODEL");
    } finally {
      stub.restore();
    }
    expect(stub.calls).toHaveLength(0);
  });
});
