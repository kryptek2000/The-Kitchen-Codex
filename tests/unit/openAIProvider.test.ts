import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OpenAIProvider,
  OPENAI_RESPONSES_ENDPOINT,
  OPENAI_DEFAULT_MODEL,
  OPENAI_FALLBACK_MODEL,
  OPENAI_TEXT_TIMEOUT_MS,
  OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
  OPENAI_MAX_RESPONSE_BYTES,
  type OpenAIFetchLike,
} from "../../server/ai/openAIProvider.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";
import type { AiJsonSchema } from "../../server/ai/types.js";

const SECRET = "sk-openai-test-super-secret";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function completed(text: string): Response {
  return jsonResponse({
    id: "resp_test",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  });
}

function responseWithStatus(
  status: string | null | undefined,
  text: string,
  extra: Record<string, unknown> = {}
): Response {
  return jsonResponse({
    ...(status !== undefined ? { status } : {}),
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    ...extra,
  });
}

function providerWith(fetchFn: OpenAIFetchLike, credential: string | undefined = SECRET) {
  return new OpenAIProvider({ fetchFn, credential });
}

const RECIPE_SCHEMA: AiJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          amount: { type: "number" },
        },
        required: ["name"],
      },
    },
  },
  required: ["title", "ingredients"],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAIProvider (P1) — transport and request truth", () => {
  it("POSTs only to the fixed Responses endpoint with a Bearer key and no caller URL surface", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const provider = providerWith(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return completed("ok");
    });

    const out = await provider.generate("hello", { model: OPENAI_DEFAULT_MODEL, temperature: 0.2 });
    expect(out).toBe("ok");
    expect(seenUrl).toBe(OPENAI_RESPONSES_ENDPOINT);
    expect(seenUrl).toBe("https://api.openai.com/v1/responses");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.redirect).toBe("error");
    expect((seenInit?.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${SECRET}`);
    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
    // GPT-6 rejects temperature above reasoning effort "none"; default low must
    // omit it even when the caller passed one.
    expect(body.temperature).toBeUndefined();
    expect((provider as any).baseUrl).toBeUndefined();
    expect((provider as any).endpoint).toBeUndefined();
    expect((provider as any).apiKey).toBeUndefined();
  });

  it("sends store:false, service_tier:default, bounded max_output_tokens, and conservative reasoning", async () => {
    let body: Record<string, any> = {};
    const provider = providerWith(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return completed("ok");
    });
    await provider.generate("hello", { model: OPENAI_DEFAULT_MODEL });
    expect(body.model).toBe(OPENAI_DEFAULT_MODEL);
    expect(body.input).toBe("hello");
    expect(body.store).toBe(false);
    expect(body.service_tier).toBe("default");
    expect(body.max_output_tokens).toBe(OPENAI_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.temperature).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.text).toBeUndefined();
  });

  it("only sends temperature when the caller explicitly selects effort none", async () => {
    let body: Record<string, any> = {};
    const provider = providerWith(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return completed("ok");
    });
    await provider.generate("hello", {
      model: OPENAI_DEFAULT_MODEL,
      temperature: 0.2,
      providerOptions: { reasoningEffort: "none" },
    });
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.temperature).toBe(0.2);
  });

  it("never lets providerOptions override privacy/cost controls or inject arbitrary fields", async () => {
    let body: Record<string, any> = {};
    const provider = providerWith(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return completed("ok");
    });
    await provider.generate("hello", {
      model: OPENAI_DEFAULT_MODEL,
      providerOptions: {
        store: true,
        service_tier: "fast",
        baseUrl: "https://evil.example",
        apiKey: "CANARY",
        maxOutputTokens: 512,
        reasoningEffort: "high",
      },
    });
    expect(body.store).toBe(false);
    expect(body.service_tier).toBe("default");
    expect(body.max_output_tokens).toBe(512);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.baseUrl).toBeUndefined();
    expect(body.apiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("CANARY");
    expect(JSON.stringify(body)).not.toContain("evil.example");
  });

  it("captures the exact timeout and uses a caller signal when supplied", async () => {
    expect(OPENAI_TEXT_TIMEOUT_MS).toBe(60_000);
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const provider = providerWith(async (_url, init) => {
      seenSignal = init.signal as AbortSignal;
      return completed("ok");
    });
    await provider.generate("hello", { model: OPENAI_DEFAULT_MODEL, signal: controller.signal });
    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
  });
});

describe("OpenAIProvider (P1) — strict structured output", () => {
  it("requests a strict json_schema with every object closed and every property required", async () => {
    let body: Record<string, any> = {};
    const provider = providerWith(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return completed(JSON.stringify({ title: "Soup", ingredients: [{ name: "Water" }] }));
    });

    const out = await provider.generateStructured("make soup", RECIPE_SCHEMA, {
      model: OPENAI_DEFAULT_MODEL,
    });
    expect(out).toEqual({ title: "Soup", ingredients: [{ name: "Water" }] });
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.name).toBe("structured_output");
    expect(body.text.format.strict).toBe(true);
    const schema = body.text.format.schema;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
    expect(schema.properties.description.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(schema.properties.ingredients.items.additionalProperties).toBe(false);
    expect(schema.properties.ingredients.items.required).toEqual(["name", "amount"]);
    expect(JSON.stringify(schema)).not.toMatch(/allOf|oneOf|patternProperties/);
  });

  it("rejects malformed JSON and schema mismatch explicitly", async () => {
    const malformed = providerWith(async () => completed("not json"));
    await expect(
      malformed.generateStructured("x", RECIPE_SCHEMA, { model: OPENAI_DEFAULT_MODEL })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", responseFailure: "malformed_json" });

    const mismatch = providerWith(async () => completed(JSON.stringify({ title: "Soup" })));
    await expect(
      mismatch.generateStructured("x", RECIPE_SCHEMA, { model: OPENAI_DEFAULT_MODEL })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", responseFailure: "schema_mismatch" });
  });

  it("accepts null for optional fields but not for required fields", async () => {
    const optional = providerWith(async () =>
      completed(JSON.stringify({ title: "Soup", description: null, ingredients: [] }))
    );
    await expect(
      optional.generateStructured("x", RECIPE_SCHEMA, { model: OPENAI_DEFAULT_MODEL })
    ).resolves.toEqual({ title: "Soup", description: null, ingredients: [] });

    const requiredNull = providerWith(async () =>
      completed(JSON.stringify({ title: null, ingredients: [] }))
    );
    await expect(
      requiredNull.generateStructured("x", RECIPE_SCHEMA, { model: OPENAI_DEFAULT_MODEL })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", responseFailure: "schema_mismatch" });
  });
});

describe("OpenAIProvider (P1) — response edge cases", () => {
  it("joins multiple output_text parts in API order", async () => {
    const provider = providerWith(async () =>
      jsonResponse({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "hello" },
              { type: "output_text", text: "world" },
            ],
          },
        ],
      })
    );
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).resolves.toBe("hello\nworld");
  });

  it("rejects EVERY non-completed status with valid-looking output_text (text and structured paths)", async () => {
    const statuses = [
      "queued",
      "in_progress",
      "incomplete",
      "failed",
      "cancelled",
      null,
      "future_status_never_seen",
      undefined, // missing status
    ] as const;

    for (const status of statuses) {
      const provider = providerWith(async () =>
        responseWithStatus(
          status,
          JSON.stringify({ title: "Must not be accepted", ingredients: [] }),
          status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}
        )
      );

      const textResult = await provider
        .generate("plain", { model: OPENAI_DEFAULT_MODEL })
        .then(() => "RESOLVED")
        .catch((error) => error);
      expect(textResult, `text path accepted status ${String(status)}`).toBeInstanceOf(
        ProviderOperationError
      );

      const structuredResult = await provider
        .generateStructured("structured", RECIPE_SCHEMA, { model: OPENAI_DEFAULT_MODEL })
        .then(() => "RESOLVED")
        .catch((error) => error);
      expect(
        structuredResult,
        `structured path accepted status ${String(status)}`
      ).toBeInstanceOf(ProviderOperationError);
    }
  });

  it("fails closed for missing and unknown statuses with a not-completed error", async () => {
    for (const status of [undefined, null, "future_status_never_seen"] as const) {
      const provider = providerWith(async () => responseWithStatus(status, "valid-looking text"));
      const error = await provider.generate("x", { model: OPENAI_DEFAULT_MODEL }).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderOperationError);
      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.message).toContain("not completed");
      expect(error.responseFailure).toBeUndefined();
    }
  });

  it("preserves incomplete, failed, and cancelled distinctions", async () => {
    const incomplete = providerWith(async () =>
      responseWithStatus("incomplete", "partial", {
        incomplete_details: { reason: "max_output_tokens" },
      })
    );
    await expect(incomplete.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      responseFailure: "output_truncated",
    });

    const failed = providerWith(async () =>
      responseWithStatus("failed", "stale text", { error: { code: "server_error" } })
    );
    await expect(failed.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    const cancelled = providerWith(async () => responseWithStatus("cancelled", "stale text"));
    await expect(cancelled.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("maps a refusal to BLOCKED and never returns an empty success", async () => {
    const provider = providerWith(async () =>
      jsonResponse({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "I can't help with that." }],
          },
        ],
      })
    );
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "BLOCKED",
      responseFailure: "refusal",
    });
  });

  it("maps max_output_tokens incomplete to output_truncated", async () => {
    const provider = providerWith(async () =>
      jsonResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      })
    );
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      responseFailure: "output_truncated",
    });
  });

  it("maps content_filter incomplete to BLOCKED", async () => {
    const provider = providerWith(async () =>
      jsonResponse({
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: [],
      })
    );
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "BLOCKED",
    });
  });

  it("maps a failed response / error body to a normalized error", async () => {
    const provider = providerWith(async () =>
      jsonResponse({
        status: "failed",
        error: { code: "server_error", message: "upstream exploded" },
        output: [],
      })
    );
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("maps tool-call-only and empty output to explicit invalid responses", async () => {
    const toolOnly = providerWith(async () =>
      jsonResponse({
        status: "completed",
        output: [{ type: "function_call", call_id: "c1", name: "x", arguments: "{}" }],
      })
    );
    await expect(toolOnly.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      responseFailure: "tool_call_only",
    });

    const empty = providerWith(async () => jsonResponse({ status: "completed", output: [] }));
    await expect(empty.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      responseFailure: "empty_response",
    });
  });

  it("rejects an oversized response before parsing", async () => {
    const provider = providerWith(async () =>
      new Response("x".repeat(OPENAI_MAX_RESPONSE_BYTES + 1), { status: 200 })
    );
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects invalid JSON from a successful response", async () => {
    const provider = providerWith(async () => new Response("not json", { status: 200 }));
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      responseFailure: "malformed_json",
    });
  });
});

describe("OpenAIProvider (P1) — upstream and cancellation errors", () => {
  it("maps 401/403 to AUTH without leaking the key", async () => {
    const provider = providerWith(async () =>
      jsonResponse({ error: { code: "invalid_api_key", message: `bad ${SECRET}` } }, 401)
    );
    const error = await provider.generate("x", { model: OPENAI_DEFAULT_MODEL }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderOperationError);
    expect(error.code).toBe("AUTH");
    expect(error.status).toBe(401);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String(error.stack)).not.toContain(SECRET);
  });

  it("distinguishes quota from rate limit on 429", async () => {
    const quota = providerWith(async () =>
      jsonResponse({ error: { code: "credit_balance_exhausted", message: "no credit" } }, 429)
    );
    await expect(quota.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "QUOTA",
    });

    const rate = providerWith(async () =>
      jsonResponse({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429)
    );
    await expect(rate.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
  });

  it("maps 5xx to UNAVAILABLE and preserves Retry-After off the serialized error", async () => {
    const provider = providerWith(async () =>
      new Response(JSON.stringify({ error: { code: "server_is_overloaded", message: "busy" } }), {
        status: 503,
        headers: { "Retry-After": "12", "Content-Type": "application/json" },
      })
    );
    const error = await provider.generate("x", { model: OPENAI_DEFAULT_MODEL }).catch((e) => e);
    expect(error.code).toBe("UNAVAILABLE");
    expect((error as any).retryAfter).toBe("12");
    expect(JSON.stringify(error)).not.toContain("12");
  });

  it("maps a transport AbortError to TIMEOUT when the caller did not abort", async () => {
    const provider = providerWith(async () => {
      throw Object.assign(new Error("the operation was aborted"), { name: "AbortError" });
    });
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("does not dispatch an already-cancelled call", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const provider = providerWith(async () => {
      calls += 1;
      return completed("no");
    });
    await expect(
      provider.generate("x", { model: OPENAI_DEFAULT_MODEL, signal: controller.signal })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(calls).toBe(0);
  });

  it("keeps caller cancellation terminal during a pending provider call", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = providerWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true }
          );
          started();
        })
    );
    const running = provider.generate("x", {
      model: OPENAI_DEFAULT_MODEL,
      signal: controller.signal,
    });
    await startedPromise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("keeps caller cancellation terminal while reading the response body", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = providerWith(async (_url, init) => {
      const response = {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              read: () => {
                started();
                return new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
                  init.signal?.addEventListener(
                    "abort",
                    () => reject(Object.assign(new Error("body read aborted"), { name: "AbortError" })),
                    { once: true }
                  );
                });
              },
              cancel: async () => {},
              releaseLock: () => {},
            };
          },
        },
      };
      return response as unknown as Response;
    });
    const running = provider.generate("x", {
      model: OPENAI_DEFAULT_MODEL,
      signal: controller.signal,
    });
    await startedPromise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("OpenAIProvider (P1) — credential isolation", () => {
  it("is available with a session credential even when no env key exists", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(new OpenAIProvider({ credential: SECRET }).isAvailable()).toBe(true);
    expect(new OpenAIProvider().isAvailable()).toBe(false);
  });

  it("uses the session credential exclusively and never falls back to the env key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env-key");
    let header = "";
    const provider = providerWith(async (_url, init) => {
      header = (init.headers as Record<string, string>)["Authorization"];
      return completed("ok");
    }, "sk-session-key");
    await provider.generate("x", { model: OPENAI_DEFAULT_MODEL });
    expect(header).toBe("Bearer sk-session-key");
    expect(header).not.toContain("sk-env-key");
  });

  it("fails closed when no credential exists (no env fallback from a session-bound provider)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const provider = new OpenAIProvider({ credential: undefined, fetchFn: async () => completed("no") });
    await expect(provider.generate("x", { model: OPENAI_DEFAULT_MODEL })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("does not expose keys through errors or serialized provider state", async () => {
    const provider = providerWith(async () =>
      jsonResponse({ error: { code: "invalid_api_key", message: `Bearer ${SECRET}` } }, 401)
    );
    const error = await provider.generate("x", { model: OPENAI_DEFAULT_MODEL }).catch((e) => e);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(JSON.stringify(provider)).not.toContain(SECRET);
  });
});
