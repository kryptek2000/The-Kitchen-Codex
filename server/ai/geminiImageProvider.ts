/**
 * The Kitchen Codex — Gemini image-generation provider (v0.7 Phase 2B).
 *
 * A real ImageProvider backed by the server-side Gemini image client
 * (`server/geminiClient.ts` -> `getGeminiImage()`, keyed to `GEMINI_API_KEY`
 * rotation and carrying the dedicated 60s IMAGE timeout — NOT the 25s text
 * ceiling). The key never leaves the server; the provider never logs,
 * returns, or persists the prompt.
 *
 * PROVEN SDK / API SEMANTICS:
 *   - `models.generateImages` (Imagen) is Vertex-only in this SDK: its non-Vertex
 *     branch throws "This method is only supported by the Gemini Enterprise Agent
 *     Platform (previously known as Vertex AI)" (dist/index.cjs). It is therefore
 *     unusable with a Gemini Developer API key (`new GoogleGenAI({ apiKey })`,
 *     exactly how `server/geminiClient.ts` configures the SDK).
 *   - The legacy non-Vertex image-generation path is `models.generateContent` with
 *     `config.responseModalities: [Modality.IMAGE]` (`GenerateContentConfig`
 *     exposes `responseModalities?: Modality[]` and `imageConfig?`). It remains
 *     the transport for `gemini-2.5-flash-image`.
 *   - Current Nano Banana models use the official Interactions API. The installed
 *     `@google/genai` 2.19.0 exposes `client.interactions.create`; the response
 *     carries `output_image.data` (base64) plus an optional MIME type. TKC sends
 *     only the documented minimal model + input request and never fetches a
 *     returned URI.
 *   - The default model id `gemini-nano-banana-2.1` is documented by Google as the
 *     current high-efficiency Nano Banana workhorse. The curated set also keeps
 *     `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`,
 *     `gemini-3-pro-image`, and legacy `gemini-2.5-flash-image`.
 *   - Legacy image bytes arrive as `candidates[].content.parts[].inlineData.data`.
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

import { Modality, type GenerateContentResponse, type GoogleGenAI } from "@google/genai";
import { createGeminiClientWithKey, getGeminiImage } from "../geminiClient.js";
import { MODEL_CONFIG } from "../modelConfig.js";
import {
  validateGeneratedImage,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_GENERATED_IMAGE_BASE64_CHARS,
  countSignificantBase64Chars,
  sniffGeneratedImageMime,
  type GeneratedImageMime,
} from "../../src/core/recipeImage.js";

/**
 * Back-compat alias: the Gemini-specific encoded cap is now the SHARED guard
 * derived from `MAX_GENERATED_IMAGE_BYTES` (same value, single source of truth).
 */
export { MAX_GENERATED_IMAGE_BASE64_CHARS as MAX_GEMINI_IMAGE_BASE64_CHARS };
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
 * Default image model. Nano Banana 2.1 is the current high-efficiency Gemini
 * image workhorse and the model page's recommended primary model.
 */
export const GEMINI_NANO_BANANA_21_MODEL = "gemini-nano-banana-2.1";
export const GEMINI_NANO_BANANA_2_MODEL = "gemini-3.1-flash-image";
export const GEMINI_NANO_BANANA_2_LITE_MODEL = "gemini-3.1-flash-lite-image";
export const GEMINI_NANO_BANANA_PRO_MODEL = "gemini-3-pro-image";
export const LEGACY_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

/**
 * Curated supported image models. The legacy model remains selectable for
 * existing pinned configurations and accounts that still have access.
 */
export const GEMINI_IMAGE_MODELS: readonly string[] = [
  GEMINI_NANO_BANANA_21_MODEL,
  GEMINI_NANO_BANANA_2_MODEL,
  GEMINI_NANO_BANANA_2_LITE_MODEL,
  GEMINI_NANO_BANANA_PRO_MODEL,
  LEGACY_GEMINI_IMAGE_MODEL,
];

export const DEFAULT_GEMINI_IMAGE_MODEL = GEMINI_NANO_BANANA_21_MODEL;

/**
 * Nano Banana 2.1 and the current Nano Banana family use the Interactions API
 * (`client.interactions.create`), not legacy `models.generateContent`.
 */
export const GEMINI_INTERACTIONS_IMAGE_MODELS: ReadonlySet<string> = new Set([
  GEMINI_NANO_BANANA_21_MODEL,
  GEMINI_NANO_BANANA_2_MODEL,
  GEMINI_NANO_BANANA_2_LITE_MODEL,
  GEMINI_NANO_BANANA_PRO_MODEL,
]);

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
 * Docs for the shared pre-decode guard live in `src/core/recipeImage.ts`
 * (`MAX_GENERATED_IMAGE_BASE64_CHARS` / `countSignificantBase64Chars`). The cap
 * is enforced BEFORE any Buffer.from() allocation, so an oversized/malicious
 * payload is rejected without a single decoded byte being allocated. The payload
 * string itself is NEVER logged.
 */
/** BYOK-5F: request-scoped credential injection (session-only BYOK). */
export interface GeminiImageProviderOptions {
  /**
   * An EXPLICIT session credential. When present, the provider builds a
   * REQUEST-SCOPED Gemini client from it (using the dedicated IMAGE timeout) and
   * NEVER falls back to the operator env key. The instance is owned by one
   * request; no global cache retains it.
   */
  credential?: string;
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

  private readonly credential?: string;
  private sessionClient: GoogleGenAI | null = null;

  constructor(options: GeminiImageProviderOptions = {}) {
    this.credential = options.credential;
  }

  /** True when a session credential is present, or a real operator key exists. */
  isAvailable(): boolean {
    if (this.credential) return true;
    return getGeminiImage() !== null;
  }

  /**
   * Returns the request-scoped session client when an explicit credential is
   * present, otherwise the shared env-backed image client. The session client is
   * built with the dedicated IMAGE timeout (`imageGenerationTimeoutMs`, 60s) —
   * NEVER the 25s text ceiling.
   */
  private client(): GoogleGenAI | null {
    if (this.credential) {
      if (!this.sessionClient) {
        this.sessionClient = createGeminiClientWithKey(this.credential, MODEL_CONFIG.imageGenerationTimeoutMs);
      }
      return this.sessionClient;
    }
    return getGeminiImage();
  }

  async generateImage(prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage> {
    if (!options?.model) {
      throw new ProviderOperationError("INVALID_RESPONSE", "Image model is required.", { providerId: this.id });
    }
    const client = this.client();
    if (!client) {
      throw new ProviderOperationError("UNAVAILABLE", "Image provider is not available.", {
        providerId: this.id,
        model: options.model,
      });
    }

    if (GEMINI_INTERACTIONS_IMAGE_MODELS.has(options.model)) {
      return this.generateWithInteractions(client, prompt, options);
    }
    return this.generateWithGenerateContent(client, prompt, options);
  }

  /** Legacy Gemini image transport (proven for `gemini-2.5-flash-image`). */
  private async generateWithGenerateContent(
    client: GoogleGenAI,
    prompt: string,
    options: ImageGenerateOptions
  ): Promise<GeneratedImage> {
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
   * Nano Banana transport. The current official image-generation documentation
   * uses the Interactions API (`client.interactions.create`) and returns the
   * generated image as `output_image.data` (base64) with an optional MIME type.
   *
   * Requests explicitly set `store: false`: Google documents that Interactions
   * requests are stored by default, and TKC does not retain server-side
   * interaction history. A returned URI is NEVER fetched here: image URLs would
   * be an SSRF surface and are not part of the validated-bytes pipeline.
   *
   * A response may produce an image ONLY when its status is exactly `completed`.
   * All other states fail closed before any base64 extraction or decoding.
   */
  private async generateWithInteractions(
    client: GoogleGenAI,
    prompt: string,
    options: ImageGenerateOptions
  ): Promise<GeneratedImage> {
    let response: {
      status?: unknown;
      output_image?: { data?: unknown; mime_type?: unknown; uri?: unknown };
      errors?: unknown;
    };
    try {
      response = (await client.interactions.create(
        {
          model: options.model,
          input: prompt,
          store: false,
        },
        {
          retries: { strategy: "none" },
        }
      )) as unknown as {
        status?: unknown;
        output_image?: { data?: unknown; mime_type?: unknown; uri?: unknown };
        errors?: unknown;
      };
    } catch (err) {
      throw normalizeProviderError(err, { providerId: this.id, model: options.model });
    }

    // STRICT SUCCESS GATE: only an explicitly completed interaction may supply
    // an image. This check intentionally runs BEFORE output extraction/decode.
    const status = typeof response?.status === "string" ? response.status : "";
    if (status !== "completed") {
      const ctx = { providerId: this.id, model: options.model };
      if (status === "cancelled") {
        throw new ProviderOperationError("CANCELLED", "Gemini image interaction was cancelled.", ctx);
      }
      if (status === "failed") {
        throw new ProviderOperationError("PROVIDER_ERROR", "Gemini image interaction failed.", ctx);
      }
      if (status === "budget_exceeded") {
        throw new ProviderOperationError("QUOTA", "Gemini image interaction exceeded its budget.", ctx);
      }
      if (status === "incomplete") {
        throw new ProviderOperationError("INVALID_RESPONSE", "Gemini image interaction was incomplete.", ctx);
      }
      // queued / in_progress / requires_action / missing / null / unknown.
      throw new ProviderOperationError(
        "INVALID_RESPONSE",
        "Gemini image interaction did not complete.",
        ctx
      );
    }

    const image = response?.output_image;
    if (!image || typeof image.data !== "string" || image.data.length === 0) {
      // Includes URI-only delivery: never fetch an untrusted remote image.
      throw new ImageNoImageError("Gemini returned no inline image for this recipe.", {
        providerId: this.id,
        model: options.model,
      });
    }

    // PRE-DECODE GUARD: enforce the shared encoded cap BEFORE Buffer.from().
    if (countSignificantBase64Chars(image.data) > MAX_GENERATED_IMAGE_BASE64_CHARS) {
      throw new ImageValidationError(
        `Gemini image rejected: encoded payload exceeds the pre-decode limit (${MAX_GENERATED_IMAGE_BASE64_CHARS} significant base64 characters).`,
        { providerId: this.id, model: options.model }
      );
    }

    const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
    const declaredRaw = typeof image.mime_type === "string" ? image.mime_type.trim() : "";
    const declared = declaredRaw || sniffGeneratedImageMime(bytes) || "";
    const validation = validateGeneratedImage({ bytes, contentType: declared });
    if (!validation.valid) {
      throw new ImageValidationError(`Gemini image rejected: ${validation.error}`, {
        providerId: this.id,
        model: options.model,
      });
    }

    return {
      bytes,
      contentType: validation.detectedMime ?? (declared as GeneratedImageMime),
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
          // PRE-DECODE GUARD: enforce the shared encoded cap BEFORE Buffer.from()
          // so no oversized allocation can occur. No partial decode happens.
          if (countSignificantBase64Chars(data) > MAX_GENERATED_IMAGE_BASE64_CHARS) {
            throw new ImageValidationError(
              `Gemini image rejected: encoded payload exceeds the pre-decode limit (${MAX_GENERATED_IMAGE_BASE64_CHARS} significant base64 characters).`,
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
