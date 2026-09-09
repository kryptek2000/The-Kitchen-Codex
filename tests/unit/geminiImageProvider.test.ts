/**
 * The Kitchen Codex — GeminiImageProvider unit tests (v0.7 Phase 2B).
 *
 * The @google/genai SDK is mocked AT THE SDK BOUNDARY (the GoogleGenAI class),
 * exactly where `server/geminiClient.ts` constructs it, so the adapter logic,
 * shared key handling, candidate selection, error normalization, and the
 * untrusted-bytes validation boundary are all exercised with zero network I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

const generateContentMock = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
  // Mirrors the real enum value proven from the installed SDK.
  Modality: { IMAGE: "IMAGE" },
}));

import {
  GeminiImageProvider,
  DEFAULT_GEMINI_IMAGE_MODEL,
  MAX_GEMINI_IMAGE_BASE64_CHARS,
} from "../../server/ai/geminiImageProvider.js";
import { ProviderOperationError } from "../../server/ai/providerErrors.js";
import { ImageValidationError, ImageBlockedError, ImageNoImageError } from "../../server/ai/imageProvider.js";

// A real, valid 1x1 PNG (>= MIN_GENERATED_IMAGE_BYTES), same seam bytes the
// DeterministicImageProvider uses.
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SECRET_PROMPT = "SUPER_SECRET_IMAGE_PROMPT_SENTINEL photorealistic soup photo";

function sdkResponseWithParts(parts: unknown[], candidateCount = 1) {
  return {
    candidates: Array.from({ length: candidateCount }, (_, i) => ({
      content: { parts: i === 0 ? parts : [{ inlineData: { mimeType: "image/png", data: Buffer.from(VALID_PNG_BASE64, "base64").toString("base64") } }] },
    })),
  };
}

function inlineImage(mimeType: string, base64: string) {
  return { inlineData: { mimeType, data: base64 } };
}

describe("GeminiImageProvider", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeAll(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key-for-unit";
  });

  afterEach(() => {
    generateContentMock.mockReset();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  it("exposes a truthful identity and the proven default model", () => {
    const provider = new GeminiImageProvider();
    expect(provider.id).toBe("gemini-image");
    expect(provider.capabilities.imageGeneration).toBe(true);
    expect(DEFAULT_GEMINI_IMAGE_MODEL).toBe("gemini-2.5-flash-image");
  });

  it("is unavailable without a real key and unavailable without a placeholder key", () => {
    const provider = new GeminiImageProvider();
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";
    expect(provider.isAvailable()).toBe(false);
    delete process.env.GEMINI_API_KEY;
    expect(provider.isAvailable()).toBe(false);
    process.env.GEMINI_API_KEY = "test-gemini-key-for-unit";
    expect(provider.isAvailable()).toBe(true);
    // The provider never hands out the client/key itself.
    expect(JSON.stringify(provider)).not.toContain("test-gemini-key-for-unit");
  });

  it("generates valid bytes through the SDK boundary and returns a validated GeneratedImage", async () => {
    const provider = new GeminiImageProvider();
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/png", VALID_PNG_BASE64)]));

    const result = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });

    expect(result.provider).toBe("gemini-image");
    expect(result.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
    expect(result.contentType).toBe("image/png");
    expect(result.bytes[0]).toBe(0x89);
    expect(result.bytes[1]).toBe(0x50); // "P" of PNG

    // SDK call shape: proven generateContent + responseModalities IMAGE config.
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const call = generateContentMock.mock.calls[0][0];
    expect(call.model).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
    expect(call.contents).toBe(SECRET_PROMPT);
    expect(call.config.responseModalities).toEqual(["IMAGE"]);
  });

  it("chooses a candidate deterministically: first candidate in API order with an image part wins", async () => {
    const provider = new GeminiImageProvider();
    const secondPng = inlineImage("image/png", VALID_PNG_BASE64);
    // Candidate 1: safety-filtered / text-only (no image part). Candidate 2: image.
    generateContentMock.mockResolvedValueOnce({
      candidates: [
        { content: { parts: [{ text: "cannot help with that" }] }, finishReason: "PROHIBITED_CONTENT" },
        { content: { parts: [inlineImage("image/png", VALID_PNG_BASE64)] } },
      ],
    });

    const result = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });
    expect(result.contentType).toBe("image/png");
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it("rejects mismatched declared MIME vs actual bytes (INVALID_RESPONSE)", async () => {
    const provider = new GeminiImageProvider();
    // JPEG bytes declared as PNG -> container/signature disagreement.
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x01]);
    generateContentMock.mockResolvedValueOnce(
      sdkResponseWithParts([inlineImage("image/png", jpegBytes.toString("base64"))])
    );

    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      name: "ImageValidationError",
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects SVG and GIF declared output (validation boundary)", async () => {
    const provider = new GeminiImageProvider();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/svg+xml", svg.toString("base64"))]));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toBeInstanceOf(
      ImageValidationError
    );

    const gifBytes = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/gif", gifBytes.toString("base64"))]));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toBeInstanceOf(
      ImageValidationError
    );
  });

  it("maps a response with NO candidate/image to NO_IMAGE (distinct from a block and from invalid bytes)", async () => {
    const provider = new GeminiImageProvider();
    generateContentMock.mockResolvedValueOnce({ candidates: [] });
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      name: "ImageNoImageError",
      code: "NO_IMAGE",
      providerId: "gemini-image",
    });

    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([{ text: "no image here" }]));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      name: "ImageNoImageError",
      code: "NO_IMAGE",
    });
  });

  it("maps a blocked PROMPT (promptFeedback.blockReason) to BLOCKED", async () => {
    const provider = new GeminiImageProvider();
    generateContentMock.mockResolvedValueOnce({
      promptFeedback: { blockReason: "IMAGE_SAFETY" },
      candidates: [],
    });
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      name: "ImageBlockedError",
      code: "BLOCKED",
      providerId: "gemini-image",
    });
  });

  it("maps every candidate safety-filtered (no image) to BLOCKED", async () => {
    const provider = new GeminiImageProvider();
    generateContentMock.mockResolvedValueOnce({
      candidates: [
        { content: { parts: [{ text: "cannot help" }] }, finishReason: "SAFETY" },
        { content: { parts: [] }, finishReason: "IMAGE_SAFETY" },
      ],
    });
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      name: "ImageBlockedError",
      code: "BLOCKED",
    });
  });

  it("prefers an available image over a safety-filtered sibling candidate (still succeeds)", async () => {
    const provider = new GeminiImageProvider();
    generateContentMock.mockResolvedValueOnce({
      candidates: [
        { content: { parts: [inlineImage("image/png", VALID_PNG_BASE64)] }, finishReason: "STOP" },
        { content: { parts: [{ text: "blocked" }] }, finishReason: "IMAGE_SAFETY" },
      ],
    });
    const result = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });
    expect(result.contentType).toBe("image/png");
  });

  it("normalizes SDK failures into the shared provider error taxonomy", async () => {
    const provider = new GeminiImageProvider();

    generateContentMock.mockRejectedValueOnce(Object.assign(new Error("API key not valid"), { status: 401 }));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      code: "AUTH",
      providerId: "gemini-image",
    });

    generateContentMock.mockRejectedValueOnce(Object.assign(new Error("Resource has been exhausted"), { status: 429 }));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });

    generateContentMock.mockRejectedValueOnce(new Error("Quota exceeded for this project"));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      code: "QUOTA",
    });

    generateContentMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    generateContentMock.mockRejectedValueOnce(Object.assign(new Error("backend error"), { status: 503 }));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });

    generateContentMock.mockRejectedValueOnce(new Error("something unexpected"));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toBeInstanceOf(
      ProviderOperationError
    );
  });

  it("is UNAVAILABLE when the shared client has no real key", async () => {
    const provider = new GeminiImageProvider();
    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      // Provider was constructed while a key existed; availability must reflect
      // the CURRENT key state at call time.
      expect(provider.isAvailable()).toBe(false);
      await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
    } finally {
      process.env.GEMINI_API_KEY = original;
    }
  });

  it("requires a model (no silent default)", async () => {
    const provider = new GeminiImageProvider();
    await expect(provider.generateImage(SECRET_PROMPT, { model: "", prompt: SECRET_PROMPT })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("never returns, logs, or echoes the prompt", async () => {
    const provider = new GeminiImageProvider();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/png", VALID_PNG_BASE64)]));

    const result = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });

    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_IMAGE_PROMPT_SENTINEL");
    for (const spy of [warnSpy, errorSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("SUPER_SECRET_IMAGE_PROMPT_SENTINEL");
      }
    }
    // Error paths likewise: normalization redacts and never echoes the prompt.
    generateContentMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toSatisfy(
      (err: unknown) => err instanceof ProviderOperationError && !String(err.message).includes("SUPER_SECRET")
    );
  });

  it("logs SAFE diagnostics only on a no-image response: model/count/finishReason/blockReason — never prompt, key, or base64", async () => {
    const provider = new GeminiImageProvider();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    generateContentMock.mockResolvedValueOnce({
      promptFeedback: { blockReason: "SAFETY" },
      candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }],
    });
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      code: "BLOCKED",
    });
    // A diagnostic WAS emitted ...
    const warnTexts = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(warnTexts).toContain("candidateCount");
    expect(warnTexts).toContain("finishReasons");
    expect(warnTexts).toContain("blockReason");
    // ... but NEVER leakage of safe-disallowed content.
    for (const spy of [warnSpy, errorSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        const s = JSON.stringify(call);
        expect(s).not.toContain("SUPER_SECRET_IMAGE_PROMPT_SENTINEL");
        expect(s).not.toContain("test-gemini-key-for-unit");
        expect(s).not.toContain("iVBORw0KGgo"); // base64 image data
      }
    }
  });

  // ---- PRE-DECODE base64 length guard (audit hardening) --------------------

  // Builds a PNG-signature payload of EXACTLY `decodedBytes` bytes, then its
  // standard base64 encoding. The validation boundary only checks signature +
  // size bounds, so signature prefix + arbitrary filler is a valid container.
  function exactSizePngBase64(decodedBytes: number, padWithEquals: boolean): string {
    const bytes = new Uint8Array(decodedBytes);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const b64 = Buffer.from(bytes).toString("base64");
    if (padWithEquals && !b64.endsWith("==")) {
      // Recompute the properly padded encoding length form (4*ceil(D/3)) —
      // Buffer.from already emits padding, so this branch is defensive only.
      return b64;
    }
    return b64;
  }

  it("pre-decode guard cap is derived exactly: 4*floor(4MB/3)+2 = 5592406", () => {
    expect(MAX_GEMINI_IMAGE_BASE64_CHARS).toBe(4 * Math.floor(4 * 1024 * 1024 / 3) + 2);
    expect(MAX_GEMINI_IMAGE_BASE64_CHARS).toBe(5592406);
  });

  it("accepts a valid image whose decoded size sits exactly at the 4MB boundary", async () => {
    const provider = new GeminiImageProvider();
    const encoded = exactSizePngBase64(4 * 1024 * 1024, false);
    expect(encoded.length).toBeLessThanOrEqual(MAX_GEMINI_IMAGE_BASE64_CHARS + 4); // sanity: within encoded envelope
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/png", encoded)]));

    const result = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });
    expect(result.contentType).toBe("image/png");
    expect(result.bytes.length).toBe(4 * 1024 * 1024);
  });

  it("rejects an encoded payload exceeding the pre-decode limit BEFORE any Buffer.from decode", async () => {
    const provider = new GeminiImageProvider();
    // One significant char beyond the cap => worst-case decode exceeds 4MB.
    const oversized = "A".repeat(MAX_GEMINI_IMAGE_BASE64_CHARS + 1);
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/png", oversized)]));

    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT })).rejects.toMatchObject({
      name: "ImageValidationError",
      code: "INVALID_RESPONSE",
      providerId: "gemini-image",
    });
    // Proves the guard ran BEFORE any base64 decode allocation.
    const decodedCalls = fromSpy.mock.calls.filter((args: unknown[]) => args[1] === "base64");
    expect(decodedCalls).toHaveLength(0);
    // No raw payload fragment leaks into the error.
    try {
      await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(String(err?.message)).not.toContain("AAAA");
      expect(String(err?.message)).not.toContain(oversized.slice(0, 32));
    }
  });

  it("boundary: exactly-at-cap significant characters is accepted (worst-case decode == 4MB)", async () => {
    const provider = new GeminiImageProvider();
    // 4*floor(4MB/3)+4 = 5592404 significant chars decodes to exactly 4194304 bytes.
    const atCap = Buffer.from(new Uint8Array(4 * 1024 * 1024).map((_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] : 0xaa))).toString("base64");
    // Padded raw length is 4*ceil(D/3) = 5592408; significant chars (minus "==") = 5592406 == cap.
    expect(atCap.endsWith("==")).toBe(true);
    expect(atCap.length).toBe(4 * Math.ceil((4 * 1024 * 1024) / 3));
    expect(atCap.replace(/=/g, "").length).toBe(MAX_GEMINI_IMAGE_BASE64_CHARS);
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/png", atCap)]));

    const result = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });
    expect(result.bytes.length).toBe(4 * 1024 * 1024);
  });

  it("whitespace-tolerant: ASCII whitespace inside the payload does not count toward the cap and does not break decoding", async () => {
    const provider = new GeminiImageProvider();
    // Interleave newlines/spaces into a valid small payload (well under cap).
    const withWhitespace = VALID_PNG_BASE64.split("").reduce((acc, ch, i) => (i % 8 === 0 ? acc + "\n " + ch : acc + ch), "");
    generateContentMock.mockResolvedValueOnce(sdkResponseWithParts([inlineImage("image/png", withWhitespace)]));

    const result = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT });
    expect(result.contentType).toBe("image/png");
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes[0]).toBe(0x89);
    expect(result.bytes[1]).toBe(0x50);
  });

  it("oversized payload errors and logs contain no raw base64 payload", async () => {
    const provider = new GeminiImageProvider();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sentinelFragment = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=";
    generateContentMock.mockResolvedValueOnce(
      sdkResponseWithParts([inlineImage("image/png", sentinelFragment + "A".repeat(MAX_GEMINI_IMAGE_BASE64_CHARS + 100))])
    );

    const err: any = await provider.generateImage(SECRET_PROMPT, { model: DEFAULT_GEMINI_IMAGE_MODEL, prompt: SECRET_PROMPT }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageValidationError);
    const errText = String(err?.message ?? "");
    expect(errText).not.toContain("QUJDREVGR0hJ");
    for (const spy of [warnSpy, errorSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("QUJDREVGR0hJ");
      }
    }
  });
});
