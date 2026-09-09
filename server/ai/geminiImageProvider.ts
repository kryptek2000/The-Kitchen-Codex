/**
 * The Kitchen Codex — Gemini image-generation provider (v0.7 Phase 2B).
 *
 * A real ImageProvider backed by the SAME shared server-side Gemini client
 * (`server/geminiClient.ts`, keyed to `GEMINI_API_KEY` rotation) that all other
 * AI consumers use. The key never leaves the server; the provider never logs,
 * returns, or persists the prompt.
 *
 * PROVEN SDK SEMANTICS (verified against the installed @google/genai 2.19.0 —
 * nothing here is guessed):
 *   - `models.generateImages` (Imagen) is Vertex-only in this SDK: its non-Vertex
 *     branch throws "This method is only supported by the Gemini Enterprise Agent
 *     Platform (previously known as Vertex AI)" (dist/index.cjs). It is therefore
 *     unusable with a Gemini Developer API key (`new GoogleGenAI({ apiKey })`,
 *     exactly how `server/geminiClient.ts` configures the SDK).
 *   - The proven non-Vertex image-generation path is `models.generateContent` with
 *     `config.responseModalities: [Modality.IMAGE]` (`GenerateContentConfig`
 *     exposes `responseModalities?: Modality[]` and `imageConfig?`; the SDK's own
 *     deprecation notice for `generateImages` directs callers to generateContent
 *     with image models).
 *   - The default model id `gemini-2.5-flash-image` is proven: it is a member of
 *     the SDK's own `Model` type union (dist/genai.d.ts), alongside
 *     `gemini-3-pro-image` and `gemini-3.1-flash-image`.
 *   - Image bytes arrive as `candidates[].content.parts[].inlineData.data`
 *     (base64 string) with `inlineData.mimeType` (SDK `Blob` interface).
 *
 * MULTIPLE-CANDIDATE POLICY (deterministic): candidates are scanned in the exact
 * API response order; the FIRST candidate that contains an inline image part
 * wins. Candidates without an image part (e.g. safety-filtered, text-only) are
 * skipped. No shuffling, no scoring, no randomness.
 *
 * TRUST BOUNDARY: returned bytes are UNTRUSTED until `validateGeneratedImage`
 * (jpeg/png/webp/avif allowlist + container-signature agreement + size bounds)
 * passes. SVG/GIF are rejected. Failures are normalized through the shared
 * provider error taxonomy. A PRE-DECODE base64 length guard (mathematically
 * derived from the 4 MB decoded cap) runs BEFORE any Buffer.from() allocation so
 * an oversized/malicious payload cannot allocate hundreds of MB before rejection.
 */

import { Modality, type GenerateContentResponse } from "@google/genai";
import { getGemini } from "../geminiClient.js";
import {
  validateGeneratedImage,
  MAX_GENERATED_IMAGE_BYTES,
  type GeneratedImageMime,
} from "../../src/core/recipeImage.js";
import { normalizeProviderError, ProviderOperationError } from "./providerErrors.js";
import {
  ImageValidationError,
  ImageBlockedError,
  ImageNoImageError,
  type GeneratedImage,
  type ImageGenerateOptions,
  type ImageProvider,
  type ImageProviderCapabilities,
} from "./imageProvider.js";

/**
 * Default image model. Proven from the installed SDK's `Model` union type —
 * NOT invented. The caller (endpoint wiring) may still override per request.
 */
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

/** Candidate finish-reasons that indicate safety/filtering (Gemini FinishReason enum). */
const SAFETY_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "RECITATION",
  "IMAGE_RECITATION",
  "SPII",
  "PROHIBITED_INPUT_CONTENT",
]);

/**
 * Summary of an inspected generateContent response — used to distinguish a safe
 * block / a no-image result / a normal candidate BEFORE declaring generic failure.
 */
interface ResponseInspection {
  candidateCount: number;
  /** True when at least one candidate carried an inline image part. */
  hasInlineImage: boolean;
  /** True when the prompt itself was blocked (response.promptFeedback.blockReason). */
  promptBlocked: boolean;
  /** True when every candidate is safety-filtered (no image present). */
  safeBlocked: boolean;
  /** Unique finish-reasons observed (for diagnostics). */
  finishReasons: string[];
  /** response.promptFeedback.blockReason (if any), for diagnostics. */
  blockReason?: string;
}

function hasInlineImagePart(parts: unknown[] | undefined): boolean {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    const data = (part as { inlineData?: { data?: string } })?.inlineData?.data;
    if (typeof data === "string" && data.length > 0) return true;
  }
  return false;
}

function finishReasonOf(candidate: unknown): string {
  const fr = (candidate as { finishReason?: string })?.finishReason;
  return typeof fr === "string" && fr ? fr : "";
}

/**
 * PRE-DECODE GUARD — encoded-length cap, derived mathematically (not arbitrary).
 *
 * Standard base64 encodes 3 bytes into 4 characters. For a string of n
 * SIGNIFICANT base64 characters (excluding '=' padding and ASCII whitespace —
 * neither adds decoded bytes), the Node decoder yields at most
 * `3*floor(n/4) + 2` bytes. Solving `3*floor(n/4) + 2 <= MAX_GENERATED_IMAGE_BYTES`
 * gives `n <= 4*floor(MAX/3) + 2`:
 *
 *   4 * floor(4194304 / 3) + 2 = 5592406
 *
 * Checking the boundary: n = 5592406 decodes to at most 4194304 bytes (== cap,
 * accepted); n = 5592407 decodes to at most 4194305 bytes (> cap, rejected).
 * A properly padded encoding of an exactly-cap-sized payload has 5592404
 * significant chars + "==" — padding is excluded from the count, so it is
 * accepted, never falsely rejected.
 *
 * The count treats EVERY other character as significant. Node's decoder leniently
 * skips some invalid characters, so counting them OVER-rejects — the safe
 * direction. The cap is enforced BEFORE any Buffer.from() allocation, so an
 * oversized/malicious payload is rejected without a single decoded byte being
 * allocated. The payload string itself is NEVER logged.
 */
export const MAX_GEMINI_IMAGE_BASE64_CHARS =
  4 * Math.floor(MAX_GENERATED_IMAGE_BYTES / 3) + 2;

const BASE64_WHITESPACE = new Set([
  0x09, 0x0a, 0x0d, 0x20, 0x0b, 0x0c, // \t \n \r space \v \f
]);

/**
 * Counts significant base64 characters (everything except '=' padding and ASCII
 * whitespace) WITHOUT allocating or decoding anything. A single O(n) scan of the
 * already-in-memory response string; rejects before any decoded allocation.
 */
function countSignificantBase64Chars(encoded: string): number {
  let significant = 0;
  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    if (code === 0x3d /* '=' */ || BASE64_WHITESPACE.has(code)) continue;
    significant++;
  }
  return significant;
}

export class GeminiImageProvider implements ImageProvider {
  readonly id = "gemini-image";
  readonly name = "Google Gemini Image";

  readonly capabilities: ImageProviderCapabilities = {
    imageGeneration: true,
    // Gemini API does not support `outputMimeType` on imageConfig (per SDK
    // types), so the ONLY format we can guarantee is the model's default PNG
    // output. Any other container that still arrives must pass the shared
    // validation boundary exactly like PNG.
    formats: ["image/png"],
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
  };

  /** True only when a real GEMINI_API_KEY is configured server-side. */
  isAvailable(): boolean {
    return getGemini() !== null;
  }

  async generateImage(prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage> {
    if (!options?.model) {
      throw new ProviderOperationError("INVALID_RESPONSE", "Image model is required.", { providerId: this.id });
    }
    const client = getGemini();
    if (!client) {
      throw new ProviderOperationError("UNAVAILABLE", "Image provider is not available.", {
        providerId: this.id,
        model: options.model,
      });
    }

    let response: GenerateContentResponse;
    try {
      response = await client.models.generateContent({
        model: options.model,
        contents: prompt,
        config: {
          // Image-only output (proven GenerateContentConfig field).
          responseModalities: [Modality.IMAGE],
        },
      });
    } catch (err) {
      throw normalizeProviderError(err, { providerId: this.id, model: options.model });
    }

    // Inspect the actual response BEFORE declaring any failure, so distinct
    // outcomes (safe block / no image / normal candidate) are never collapsed.
    const inspection = this.inspectResponse(response);
    this.logSafeDiagnostics(options.model, inspection);

    if (inspection.promptBlocked) {
      // SAFETY: the prompt itself was blocked.
      throw new ImageBlockedError("Gemini blocked the image generation prompt.", {
        providerId: this.id,
        model: options.model,
      });
    }
    if (!inspection.hasInlineImage && inspection.safeBlocked) {
      // SAFETY: generation ran but every candidate was safety-filtered.
      throw new ImageBlockedError("Gemini blocked the generated image for this recipe.", {
        providerId: this.id,
        model: options.model,
      });
    }
    if (!inspection.hasInlineImage) {
      // A valid response with no inline image -> NO_IMAGE (distinct from a block).
      throw new ImageNoImageError("Gemini returned no image for this recipe.", {
        providerId: this.id,
        model: options.model,
      });
    }

    const extracted = this.extractFirstImage(response, options.model);
    if (!extracted) {
      // Should not happen after hasInlineImage, but keep a safe NO_IMAGE return.
      throw new ImageNoImageError("Gemini returned no usable image candidate.", {
        providerId: this.id,
        model: options.model,
      });
    }

    // Untrusted bytes -> shared validation boundary before anything else.
    const validation = validateGeneratedImage({ bytes: extracted.bytes, contentType: extracted.mimeType });
    if (!validation.valid) {
      // Malformed / mismatched / oversized -> INVALID_IMAGE (existing path).
      throw new ImageValidationError(`Gemini image rejected: ${validation.error}`, {
        providerId: this.id,
        model: options.model,
      });
    }

    return {
      bytes: extracted.bytes,
      contentType: validation.detectedMime ?? (extracted.mimeType as GeneratedImageMime),
      provider: this.id,
      model: options.model,
    };
  }

  /**
   * Inspects the raw generateContent response to classify its OUTCOME without
   * trusting a generic exception. Reads ONLY safe metadata (candidateCount,
   * finishReason, inline-image presence, promptFeedback.blockReason) — never the
   * prompt, never image bytes, never any base64.
   */
  private inspectResponse(response: GenerateContentResponse): ResponseInspection {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    const promptFeedback = response?.promptFeedback as
      | { blockReason?: string; blockReasonMessage?: string }
      | undefined;
    const blockReason = typeof promptFeedback?.blockReason === "string" && promptFeedback.blockReason
      ? promptFeedback.blockReason
      : undefined;

    let hasInlineImage = false;
    let anyCandidate = false;
    let anySafety = false;
    const finishReasons = new Set<string>();

    for (const candidate of candidates) {
      anyCandidate = true;
      const fr = finishReasonOf(candidate);
      if (fr) finishReasons.add(fr);
      if (fr && SAFETY_FINISH_REASONS.has(fr)) anySafety = true;
      if (!hasInlineImage && hasInlineImagePart((candidate as { content?: { parts?: unknown[] } })?.content?.parts)) {
        hasInlineImage = true;
      }
    }

    return {
      candidateCount: candidates.length,
      hasInlineImage,
      promptBlocked: Boolean(blockReason),
      safeBlocked: anyCandidate && !hasInlineImage && anySafety,
      finishReasons: Array.from(finishReasons),
      ...(blockReason ? { blockReason } : {}),
    };
  }

  /**
   * SAFE DIAGNOSTICS: logs ONLY non-sensitive metadata about a failed/empty image
   * response. NEVER logs the key, the prompt, image bytes/base64, or secrets.
   * model + normalized-outcome signals only.
   */
  private logSafeDiagnostics(model: string, inspection: ResponseInspection): void {
    try {
      console.warn("[gemini-image] generation outcome", JSON.stringify({
        model,
        candidateCount: inspection.candidateCount,
        hasInlineImage: inspection.hasInlineImage,
        promptBlocked: inspection.promptBlocked,
        safeBlocked: inspection.safeBlocked,
        ...(inspection.finishReasons.length ? { finishReasons: inspection.finishReasons } : {}),
        ...(inspection.blockReason ? { blockReason: inspection.blockReason } : {}),
      }));
    } catch {
      // diagnostics must never break generation or leak anything.
    }
  }

  /**
   * Deterministic candidate selection (documented policy above): first candidate
   * in API order containing an inline image part. Never logs; never echoes the
   * prompt or raw SDK response. The PRE-DECODE guard runs before any
   * Buffer.from() allocation, so an oversized payload is rejected as
   * INVALID_RESPONSE (endpoint: INVALID_IMAGE) without allocating decoded bytes.
   */
  private extractFirstImage(response: GenerateContentResponse, model: string): { bytes: Uint8Array; mimeType: string } | undefined {
    const candidates = response?.candidates;
    if (!Array.isArray(candidates)) return undefined;
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const data = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType;
        if (typeof data === "string" && data.length > 0 && typeof mimeType === "string" && mimeType) {
          // PRE-DECODE GUARD: enforce the encoded cap BEFORE Buffer.from() so no
          // oversized allocation can occur. No partial decode happens.
          if (countSignificantBase64Chars(data) > MAX_GEMINI_IMAGE_BASE64_CHARS) {
            throw new ImageValidationError(
              `Gemini image rejected: encoded payload exceeds the pre-decode limit (${MAX_GEMINI_IMAGE_BASE64_CHARS} significant base64 characters).`,
              { providerId: this.id, model }
            );
          }
          return { bytes: new Uint8Array(Buffer.from(data, "base64")), mimeType };
        }
      }
    }
    return undefined;
  }
}
