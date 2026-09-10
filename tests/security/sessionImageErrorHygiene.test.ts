/**
 * The Kitchen Codex v0.7.x — BYOK-5F security cleanup regression.
 *
 * OPENROUTER ERROR RETENTION (non-2xx body AND transport exceptions).
 *
 * Upstream error bodies AND fetch/transport exceptions are attacker-controlled /
 * may echo the outbound Authorization bearer. The raw text must NEVER survive in
 * any observable error surface (message / cause / rawCause / enumerable props /
 * JSON / util.inspect / logs / mapped HTTP response).
 *
 * These tests FAIL on the pre-fix implementation (which retained the raw
 * upstream message and/or the raw thrown transport error as an ENUMERABLE
 * `rawCause`).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import util from "node:util";
import {
  OpenRouterImageProvider,
  OPENROUTER_IMAGE_DEFAULT_MODEL,
  type OpenRouterImageFetchLike,
  type OpenRouterImageFetchResponse,
} from "../../server/ai/openRouterImageProvider.js";
import { ProviderOperationError, toProviderDiagnostic } from "../../server/ai/providerErrors.js";
import { mapImageProviderErrorToHttp } from "../../server/app.js";

const SENTINEL = "SESSION-BEARER-SHOULD-NEVER-LEAK";
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function errorResponse(body: unknown, status = 401): OpenRouterImageFetchResponse {
  return { ok: false, status, headers: { get: () => null }, json: async () => body };
}

function dataResponse(b64: string, mediaType = "image/png"): OpenRouterImageFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ created: 1, data: [{ b64_json: b64, media_type: mediaType }], usage: {} }),
  };
}

function collectLogs(): string[] {
  const logs: string[] = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
  }
  return logs;
}

function observableSurfaces(err: any): Record<string, string> {
  return {
    message: String(err?.message ?? ""),
    string: String(err),
    cause: String(err?.cause?.message ?? err?.cause ?? ""),
    rawCause: String(err?.rawCause?.message ?? err?.rawCause ?? ""),
    keys: JSON.stringify(Object.keys(err ?? {})),
    json: JSON.stringify(err),
    jsonWrapped: JSON.stringify({ error: err }),
    inspect: util.inspect(err, { depth: 6 }),
    inspectHidden: util.inspect(err, { showHidden: true, depth: 6 }),
    diagnostic: JSON.stringify(toProviderDiagnostic(err)),
    httpResponse: JSON.stringify(mapImageProviderErrorToHttp(err) ?? {}),
  };
}

function expectNoSentinel(err: any, logs: string[]) {
  const surfaces = observableSurfaces(err);
  for (const [name, text] of Object.entries(surfaces)) {
    expect(text, `bearer leaked via ${name}`).not.toContain(SENTINEL);
  }
  expect(logs.join("\n"), "bearer leaked via console").not.toContain(SENTINEL);
}

async function captureFailure(provider: OpenRouterImageProvider) {
  const logs = collectLogs();
  const err: any = await provider
    .generateImage("a prompt", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "a prompt" })
    .catch((e) => e);
  expect(err).toBeTruthy();
  return { err, logs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BYOK-5F cleanup — OpenRouter non-2xx error-body retention", () => {
  it("never retains an upstream error message that echoes the session bearer", async () => {
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(
      errorResponse(
        { error: { code: "invalid_api_key", message: `Invalid credentials: Authorization: Bearer ${SENTINEL}` } },
        401
      )
    );
    const provider = new OpenRouterImageProvider({ fetchFn, credential: SENTINEL });
    const { err, logs } = await captureFailure(provider);

    const [url, init] = fetchFn.mock.calls[0];
    const reqInit = init as RequestInit;
    const headers = reqInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${SENTINEL}`);
    expect(String(url)).not.toContain(SENTINEL);
    expect(String(reqInit.body)).not.toContain(SENTINEL);
    for (const [name, value] of Object.entries(headers)) {
      if (name === "Authorization") continue;
      expect(String(value), `header ${name}`).not.toContain(SENTINEL);
    }

    expectNoSentinel(err, logs);
    expect(err).toBeInstanceOf(ProviderOperationError);
    expect(err.code).toBe("AUTH");
    expect(err.status).toBe(401);
  });

  it("strips the session bearer even when it appears verbatim WITHOUT the Bearer prefix", async () => {
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockResolvedValue(
      errorResponse({ error: { code: 401, message: `key rejected: ${SENTINEL}` } }, 401)
    );
    const provider = new OpenRouterImageProvider({ fetchFn, credential: SENTINEL });
    const { err, logs } = await captureFailure(provider);
    expectNoSentinel(err, logs);
  });

  it("malformed / non-JSON non-2xx body: the parse error text cannot survive retention", async () => {
    // The provider never reads `.text()`; the only way body content could reach it
    // is a `.json()` rejection message. `asJson` swallows that error entirely.
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockResolvedValue({
      ok: false,
      status: 502,
      headers: { get: () => null },
      json: async () => {
        throw new Error(`Unexpected token, body was: Authorization: Bearer ${SENTINEL}`);
      },
    });
    const provider = new OpenRouterImageProvider({ fetchFn, credential: SENTINEL });
    const { err, logs } = await captureFailure(provider);
    expectNoSentinel(err, logs);
    expect(err.code).toBe("UNAVAILABLE"); // 502 gateway path preserved
  });
});

describe("BYOK-5F cleanup — OpenRouter transport-exception retention", () => {
  it("A. fetch rejection: a transport exception echoing the bearer is never retained", async () => {
    const fetchFn = vi
      .fn<OpenRouterImageFetchLike>()
      .mockRejectedValue(new Error(`request failed: Authorization: Bearer ${SENTINEL}`));
    const provider = new OpenRouterImageProvider({ fetchFn, credential: SENTINEL });
    const { err, logs } = await captureFailure(provider);

    expectNoSentinel(err, logs);
    // Connection failure taxonomy preserved (PROVIDER_ERROR -> UNAVAILABLE).
    expect(err.code).toBe("UNAVAILABLE");

    // The credential was still sent where required.
    const [, init] = fetchFn.mock.calls[0];
    expect((init as RequestInit).headers?.["Authorization"]).toBe(`Bearer ${SENTINEL}`);
  });

  it("B. timeout / AbortError: an abort exception echoing the bearer is never retained (TIMEOUT preserved)", async () => {
    const abortError = Object.assign(new Error(`timed out: Authorization: Bearer ${SENTINEL}`), {
      name: "AbortError",
    });
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockRejectedValue(abortError);
    const provider = new OpenRouterImageProvider({ fetchFn, credential: SENTINEL });
    const { err, logs } = await captureFailure(provider);

    expectNoSentinel(err, logs);
    expect(err.code).toBe("TIMEOUT");
  });

  it("transport failure with NO message attaches no cause", async () => {
    const fetchFn = vi.fn<OpenRouterImageFetchLike>().mockRejectedValue(new Error(""));
    const provider = new OpenRouterImageProvider({ fetchFn, credential: SENTINEL });
    const { err } = await captureFailure(provider);
    expect((err as any).rawCause).toBeUndefined();
  });
});

describe("BYOK-5F cleanup — ProviderOperationError defense-in-depth", () => {
  it("rawCause is non-enumerable, non-writable, non-configurable; cause still reachable", () => {
    const e = new ProviderOperationError(
      "AUTH",
      "bounded",
      { providerId: "openrouter-image" },
      new Error(`boom ${SENTINEL}`)
    );
    const desc = Object.getOwnPropertyDescriptor(e, "rawCause")!;
    expect(desc.enumerable).toBe(false);
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);
    expect(Object.keys(e)).not.toContain("rawCause");
    expect(JSON.stringify(e)).not.toContain("rawCause");
    expect((e.cause as Error)?.message).toContain("boom");
    expect(util.inspect(e, { showHidden: false, depth: 1 })).not.toContain("boom");
  });
});

describe("BYOK-5F cleanup — credential placement on success", () => {
  it("success: the session bearer is sent ONLY in the Authorization header", async () => {
    const fetchFn = vi
      .fn<OpenRouterImageFetchLike>()
      .mockResolvedValue(dataResponse(VALID_PNG_BASE64, "image/png"));
    const provider = new OpenRouterImageProvider({ fetchFn, credential: SENTINEL });
    const result = await provider.generateImage("p", { model: OPENROUTER_IMAGE_DEFAULT_MODEL, prompt: "p" });
    expect(result.contentType).toBe("image/png");

    const [url, init] = fetchFn.mock.calls[0];
    const reqInit = init as RequestInit;
    const headers = reqInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${SENTINEL}`);
    expect(String(url)).not.toContain(SENTINEL);
    expect(String(reqInit.body)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    for (const [name, value] of Object.entries(headers)) {
      if (name === "Authorization") continue;
      expect(String(value), `header ${name}`).not.toContain(SENTINEL);
    }
  });
});
