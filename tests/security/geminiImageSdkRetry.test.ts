/**
 * P3-A-R2 — real @google/genai 2.19.0 retry-boundary regression.
 *
 * Uses the ACTUAL installed SDK with a deterministic global-fetch interception.
 * No real network request is made. Proves:
 *   - default SDK behavior retries a 500 (the vulnerability),
 *   - the provider's per-call `retries: { strategy: "none" }` limits a billable
 *     Nano Banana attempt to ONE outbound POST for 500, 429, 503, and network
 *     failure,
 *   - success remains one POST,
 *   - every Nano Banana model sends `store: false`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GeminiImageProvider,
  GEMINI_NANO_BANANA_21_MODEL,
  GEMINI_NANO_BANANA_2_MODEL,
  GEMINI_NANO_BANANA_2_LITE_MODEL,
  GEMINI_NANO_BANANA_PRO_MODEL,
} from "../../server/ai/geminiImageProvider.js";
import { createGeminiClientWithKey } from "../../server/geminiClient.js";

const KEY = "audit-gemini-retry-fake-key";
const PROMPT = "A calm culinary image retry-boundary probe";
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MODELS = [
  GEMINI_NANO_BANANA_21_MODEL,
  GEMINI_NANO_BANANA_2_MODEL,
  GEMINI_NANO_BANANA_2_LITE_MODEL,
  GEMINI_NANO_BANANA_PRO_MODEL,
] as const;

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "interaction-retry-test",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            { type: "image", mime_type: "image/png", data: VALID_PNG_BASE64 },
          ],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function errorResponse(status: number): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message: `simulated ${status}` } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

interface FetchCall {
  url: string;
  method?: string;
  body?: string;
}

let originalFetch: typeof globalThis.fetch;
let calls: FetchCall[] = [];

function installFetch(sequence: Array<Response | Error>) {
  calls = [];
  let index = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const rawBody = init?.body;
    let body: string | undefined;
    if (typeof rawBody === "string") {
      body = rawBody;
    } else if (rawBody) {
      try {
        body = await new Response(rawBody as BodyInit).text();
      } catch {
        body = undefined;
      }
    }
    if (!body && input && typeof input === "object" && typeof input.clone === "function") {
      try {
        body = await input.clone().text();
      } catch {
        body = undefined;
      }
    }
    calls.push({
      url: typeof input === "string" ? input : String(input?.url ?? input),
      method: init?.method ?? (typeof input === "object" ? input?.method : undefined),
      body,
    });
    const next = sequence[Math.min(index++, sequence.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

function requestBody(call: FetchCall): Record<string, unknown> {
  expect(call.body).toBeTruthy();
  return JSON.parse(call.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GEMINI_API_KEY;
  vi.restoreAllMocks();
});

describe("P3-A-R2 — real SDK retry boundary", () => {
  it("PROVES the SDK default retries a simulated 500 -> 200 sequence (two POSTs)", async () => {
    installFetch([errorResponse(500), successResponse()]);
    const client = createGeminiClientWithKey(KEY, 5_000);
    const result = await client.interactions.create({
      model: GEMINI_NANO_BANANA_21_MODEL,
      input: PROMPT,
      store: false,
    });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(2);
  }, 15_000);

  it("500 -> hypothetical 200 produces exactly ONE POST and an error through the provider", async () => {
    installFetch([errorResponse(500), successResponse()]);
    const provider = new GeminiImageProvider();
    await expect(
      provider.generateImage(PROMPT, { model: GEMINI_NANO_BANANA_21_MODEL, prompt: PROMPT })
    ).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(requestBody(calls[0])["store"]).toBe(false);
  });

  it("429 produces exactly ONE POST and an error", async () => {
    installFetch([errorResponse(429)]);
    const provider = new GeminiImageProvider();
    await expect(
      provider.generateImage(PROMPT, { model: GEMINI_NANO_BANANA_21_MODEL, prompt: PROMPT })
    ).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("503 produces exactly ONE POST and an error", async () => {
    installFetch([errorResponse(503)]);
    const provider = new GeminiImageProvider();
    await expect(
      provider.generateImage(PROMPT, { model: GEMINI_NANO_BANANA_21_MODEL, prompt: PROMPT })
    ).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("a network failure does not trigger an additional POST", async () => {
    installFetch([new TypeError("simulated network failure")]);
    const provider = new GeminiImageProvider();
    await expect(
      provider.generateImage(PROMPT, { model: GEMINI_NANO_BANANA_21_MODEL, prompt: PROMPT })
    ).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("a successful 200 response produces exactly ONE POST", async () => {
    installFetch([successResponse()]);
    const provider = new GeminiImageProvider();
    const result = await provider.generateImage(PROMPT, {
      model: GEMINI_NANO_BANANA_21_MODEL,
      prompt: PROMPT,
    });
    expect(result.contentType).toBe("image/png");
    expect(calls).toHaveLength(1);
  });

  it("all four Nano Banana models use no-retry and send store:false", async () => {
    for (const model of MODELS) {
      installFetch([successResponse()]);
      const provider = new GeminiImageProvider();
      const result = await provider.generateImage(PROMPT, { model, prompt: PROMPT });
      expect(result.model, model).toBe(model);
      expect(calls, model).toHaveLength(1);
      expect(requestBody(calls[0])["store"], model).toBe(false);
      // The SDK request is a POST to the fixed Interactions route.
      expect(calls[0].method, model).toBe("POST");
      expect(calls[0].url, model).toContain("/v1beta/interactions");
    }
  });
});
