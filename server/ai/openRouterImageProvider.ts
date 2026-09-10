/**
 * The Kitchen Codex — OpenRouter image-generation provider (BYOK-3).
 *
 * A real `ImageProvider` backed by OpenRouter's FIXED image endpoint. It plugs
 * into the same `ImageProvider` contract as `GeminiImageProvider`, the same
 * provider error taxonomy, and the same shared generated-image validation
 * boundary. SERVER-SIDE ONLY.
 *
 * VERIFIED API SHAPE (OpenRouter `/api/v1/images`, not guessed):
 *   - Endpoint: POST `https://openrouter.ai/api/v1/images` (fixed, never
 *     caller-controlled).
 *   - Request: JSON `{ model, prompt, ... }` (output_format / resolution /
 *     aspect_ratio / n are OPTIONAL; we send only model + prompt).
 *   - Success: `{ created, data: [ { b64_json, media_type? } ], usage }`.
 *     Output is BASE64 (`b64_json`) with an optional `media_type`
 *     (typically `image/png`).
 *   - Errors: OpenAI-style `{ error: { code, message } }`. HTTP 400 may carry a
 *     wrapped provider-overloaded `error.code` 529. Documented statuses:
 *     400/401/402/403/404/413/429/500/502/524/529.
 *   - Streaming (SSE `image_generation.partial_image`) is NOT used.
 *
 * SECURITY / SCOPE (must never be weakened — mirrors `openRouterProvider.ts`):
 *   - The endpoint is FIXED to OpenRouter's official base URL. No caller-
 *     controlled baseUrl/endpoint/host is accepted (no arbitrary endpoint
 *     capability, no SSRF surface).
 *   - The key comes ONLY from the server-side operator environment via
 *     `getServerSecretSync("openrouter_api_key")` (the allowlisted
 *     `OPENROUTER_API_KEY`). It is never in VITE_*, browser, settings,
 *     Markdown, logs, diagnostics, or returned to the UI.
 *   - `NetworkAdapter` is NOT involved (AI-provider transport, not app-backend).
 *   - NO streaming, NO automatic retries.
 *
 * TRUST BOUNDARY (shared, identical to Gemini): returned bytes are UNTRUSTED
 * until `validateGeneratedImage` (jpeg/png/webp/avif allowlist + container-
 * signature agreement + size bounds) passes. SVG/GIF are rejected. Failures are
 * normalized through the shared provider error taxonomy. A PRE-DECODE base64
 * length guard (mathematically derived from the 4 MB decoded cap) runs BEFORE
 * any Buffer.from() allocation via the SHARED guard in `src/core/recipeImage.ts`.
 *
 * OUTPUT `media_type` is parsed untrusted; when OpenRouter omits it, the bytes
 * are sniffed via `sniffGeneratedImageMime` and validated for self-agreement.
 * The prompt, the key, and the base64 payload are NEVER logged or echoed.
 */

import { MODEL_CONFIG } from "../modelConfig.js";
import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import { redactSecrets } from "../providerDiagnostics.js";
import { classifyProviderError, ProviderOperationError, type ProviderErrorCode } from "./providerErrors.js";
import {
  ImageValidationError,
  ImageNoImageError,
  type GeneratedImage,
  type ImageGenerateOptions,
  type ImageProvider,
  type ImageProviderCapabilities,
} from "./imageProvider.js";
import {
  MAX_GENERATED_IMAGE_BYTES,
  MAX_GENERATED_IMAGE_BASE64_CHARS,
  countSignificantBase64Chars,
  sniffGeneratedImageMime,
  validateGeneratedImage,
  type GeneratedImageMime,
} from "../../src/core/recipeImage.js";

/** OpenRouter's fixed, official image-generation endpoint (never configurable). */
const OPENROUTER_IMAGE_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_IMAGE_ENDPOINT = `${OPENROUTER_IMAGE_BASE_URL}/images`;

/**
 * Curated OpenRouter image-generation models (SMALL, verified set — no
 * scraping). Selected from the OpenRouter `/images` model catalog:
 *   - `google/gemini-2.5-flash-image` — the default image model used in
 *     OpenRouter's own `/images` documentation example.
 *   - `bytedance-seed/seedream-4.5` — the flagship seedream image model.
 * ALL other models are unknown to the curated set: `imageGeneration` claims
 * nothing, and an unknown model is never selectable through server-managed
 * image selection. The FIRST entry is the default.
 */
export const OPENROUTER_IMAGE_DEFAULT_MODEL = "google/gemini-2.5-flash-image";

export const OPENROUTER_IMAGE_MODELS: readonly string[] = [
  OPENROUTER_IMAGE_DEFAULT_MODEL,
  "bytedance-seed/seedream-4.5",
];

/** Fetch seam (small, typed window into the response). */
export interface OpenRouterImageFetchResponse {
  ok: boolean;
  status: number;
  /** Upper-case header names; value may be null (matching the Fetch API). */
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type OpenRouterImageFetchLike = (url: string, init: RequestInit) => Promise<OpenRouterImageFetchResponse>;

export interface OpenRouterImageProviderOptions {
  /** Test-only seam; defaults to the global fetch. Never a config surface. */
  fetchFn?: OpenRouterImageFetchLike;
  /**
   * BYOK-5F: an EXPLICIT session credential. When present it is used INSTEAD of
   * the operator env key (never a fallback). The provider instance is
   * request-scoped; no global cache retains the credential.
   */
  credential?: string;
}

function defaultFetch(): OpenRouterImageFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init) as Promise<OpenRouterImageFetchResponse>;
}

/** Safe JSON parse of an untrusted response body (never throws). */
async function asJson<T>(res: OpenRouterImageFetchResponse): Promise<T | undefined> {
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Best-effort Retry-After from the response headers (never trusted blindly). */
function retryAfterFrom(res: OpenRouterImageFetchResponse): string | undefined {
  try {
    const value = res?.headers?.get("Retry-After");
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * BYOK-5F SECURITY: builds a bounded, SANITIZED diagnostic from untrusted
 * upstream/transport error text. The exact in-use credential is removed by
 * literal replacement (format-independent, unlike regex redaction), then shared
 * secret redaction is applied. The RAW text is NEVER retained. Returns an empty
 * string when there is nothing safe to keep.
 */
function sanitizeDiagnosticText(rawText: unknown, credential: string | undefined): string {
  let text = typeof rawText === "string" ? rawText : "";
  if (!text) return "";
  if (credential) text = text.split(credential).join("<redacted>");
  return redactSecrets(text).slice(0, 300);
}

/**
 * Maps an OpenRouter image error body + HTTP status to a normalized code.
 * Precedence: the documented wrapped `error.code` (529 = Provider Overloaded)
 * first, then the shared HTTP/message classifier. The upstream message is used
 * ONLY transiently for classification and is never retained or surfaced; only
 * the normalized code + bounded fixed message escape.
 */
function classifyOpenRouterImageError(status: number, errorCode: unknown, rawMessage: string): ProviderErrorCode {
  // 529 is OpenRouter's documented provider-overloaded marker (commonly wrapped
  // in an HTTP 400 body, but also documented as a DIRECT HTTP status); an
  // overloaded provider is UNAVAILABLE, not a client bug. 500/502/503/524 are
  // upstream/gateway failures too.
  if (
    (typeof errorCode === "number" && errorCode === 529) ||
    [500, 502, 503, 524, 529].includes(status)
  ) {
    return "UNAVAILABLE";
  }
  const error = Object.assign(new Error(rawMessage || `HTTP ${status}`), { status });
  return classifyProviderError(error);
}

/** The one implemented provider: OpenRouter image generation. */
export class OpenRouterImageProvider implements ImageProvider {
  readonly id = "openrouter-image";
  readonly name = "OpenRouter Image";

  readonly capabilities: ImageProviderCapabilities = {
    imageGeneration: true,
    // OpenRouter image models produce RASTER images; the exact container is
    // reported via `media_type` (typically image/png). Only formats within the
    // shared generated-image allowlist are declared. SVN/GIF never declared.
    formats: ["image/png", "image/jpeg", "image/webp"],
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
  };

  private readonly fetchFn: OpenRouterImageFetchLike;
  private readonly credential?: string;

  constructor(options: OpenRouterImageProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch();
    this.credential = options.credential;
  }

  /** True when a session credential is present, or a real operator key exists. */
  isAvailable(): boolean {
    if (this.credential) return true;
    return Boolean(getServerSecretSync("openrouter_api_key"));
  }

  private requireKey(): string {
    // A session credential is used EXCLUSIVELY when supplied — never env fallback.
    const key = this.credential ?? getServerSecretSync("openrouter_api_key");
    if (!key) {
      throw new ProviderOperationError("UNAVAILABLE", "OpenRouter Image is not available (no API key).", {
        providerId: this.id,
      });
    }
    return key;
  }

  async generateImage(prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage> {
    if (!options?.model) {
      throw new ProviderOperationError("INVALID_RESPONSE", "Image model is required.", { providerId: this.id });
    }
    const model = options.model;
    const key = this.requireKey();
    const body: Record<string, unknown> = { model, prompt };

    let res: OpenRouterImageFetchResponse;
    try {
      res = await this.fetchFn(OPENROUTER_IMAGE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MODEL_CONFIG.imageGenerationTimeoutMs),
      });
    } catch (err) {
      // Transport-level failure / timeout. Connection failures map to
      // UNAVAILABLE; timeouts/aborts to TIMEOUT. `classifyProviderError` reads
      // name/message/status ONLY transiently.
      const code = classifyProviderError(err);
      // SECURITY (BYOK-5F): a fetch implementation MAY include the outbound
      // Authorization header (or other credential-bearing request metadata) in
      // its exception text. NEVER retain the raw thrown transport exception.
      // Retain only a bounded, sanitized diagnostic (exact in-use credential
      // removed + shared redaction); omit the cause entirely when nothing safe
      // remains. ProviderOperationError stores the cause non-enumerably.
      const transportMessage =
        err instanceof Error ? err.message : typeof err === "string" ? err : "";
      const sanitized = sanitizeDiagnosticText(transportMessage, key);
      throw new ProviderOperationError(
        code === "PROVIDER_ERROR" ? "UNAVAILABLE" : code,
        "OpenRouter image request failed.",
        { providerId: this.id, model },
        sanitized ? new Error(sanitized) : undefined
      );
    }

    if (!res.ok) {
      const parsed = await asJson<{ error?: { code?: unknown; message?: string } }>(res);
      const rawMessage = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
      // The upstream message is untrusted and MAY echo the Authorization bearer.
      // It is used ONLY transiently to classify; it is never retained raw.
      const code = classifyOpenRouterImageError(res.status, parsed?.error?.code, rawMessage);
      // SECURITY (BYOK-5F): NEVER construct `new Error(rawMessage)`. The internal
      // cause is a BOUNDED, SANITIZED diagnostic with the exact in-use credential
      // removed by literal replacement (format-independent) plus shared
      // redaction. `ProviderOperationError` stores it non-enumerably. The public
      // message is fixed and provider-agnostic.
      const sanitized = sanitizeDiagnosticText(rawMessage, key);
      const normalized = new ProviderOperationError(
        code,
        `OpenRouter image request failed (HTTP ${res.status}).`,
        { providerId: this.id, model },
        sanitized ? new Error(sanitized) : undefined
      );
      // Preserve the upstream HTTP status so Retry-After semantics hold for 429.
      if (typeof res.status === "number" && res.status !== 0) {
        Object.defineProperty(normalized, "status", { value: res.status, enumerable: true, writable: false });
      }
      const retryAfter = retryAfterFrom(res);
      if (retryAfter) {
        Object.defineProperty(normalized, "retryAfter", { value: retryAfter, enumerable: false, writable: false });
      }
      throw normalized;
    }

    const parsed = await asJson<{ data?: unknown }>(res);
    const extracted = this.extractFirstImage(parsed?.data, model);
    if (!extracted) {
      // A success response with no usable base64 image -> NO_IMAGE (distinct).
      throw new ImageNoImageError("OpenRouter returned no image for this recipe.", {
        providerId: this.id,
        model,
      });
    }

    // Untrusted bytes -> shared validation boundary before anything else. When
    // OpenRouter omits `media_type`, sniff the decoded bytes so the declared
    // type still must AGREE with the actual container.
    const declared = extracted.mediaType
      ? extracted.mediaType
      : sniffGeneratedImageMime(extracted.bytes) ?? "";
    const validation = validateGeneratedImage({ bytes: extracted.bytes, contentType: declared });
    if (!validation.valid) {
      // Malformed / mismatched / oversized / SVG / GIF -> INVALID_IMAGE path.
      throw new ImageValidationError(`OpenRouter image rejected: ${validation.error}`, {
        providerId: this.id,
        model,
      });
    }

    return {
      bytes: extracted.bytes,
      // `detectedMime` always agrees with the bytes (validated above); fall back
      // to the declared/sniffed type only when the signature was indeterminate.
      contentType: (validation.detectedMime ?? (declared as GeneratedImageMime)),
      provider: this.id,
      model,
    };
  }

  /**
   * Deterministic selection: FIRST `data` entry (API order) carrying a non-empty
   * `b64_json` string wins. Entries without a base64 image are skipped. The
   * PRE-DECODE guard (shared, mathematically derived from the 4 MB cap) runs
   * BEFORE any Buffer.from() allocation, so an oversized/malicious payload is
   * rejected as INVALID_RESPONSE (endpoint: INVALID_IMAGE) without allocating
   * decoded bytes. The payload string itself is NEVER logged.
   */
  private extractFirstImage(
    data: unknown,
    model: string
  ): { bytes: Uint8Array; mediaType: string } | undefined {
    if (!Array.isArray(data)) return undefined;
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const b64 = (entry as { b64_json?: unknown })?.b64_json;
      const mediaType = (entry as { media_type?: unknown })?.media_type;
      if (typeof b64 !== "string" || b64.length === 0) continue;
      if (countSignificantBase64Chars(b64) > MAX_GENERATED_IMAGE_BASE64_CHARS) {
        throw new ImageValidationError(
          `OpenRouter image rejected: encoded payload exceeds the pre-decode limit (${MAX_GENERATED_IMAGE_BASE64_CHARS} significant base64 characters).`,
          { providerId: this.id, model }
        );
      }
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const declared = typeof mediaType === "string" && mediaType.trim() ? mediaType.trim() : "";
      return { bytes, mediaType: declared };
    }
    return undefined;
  }
}

/** Curated-type helper: treats `OPENROUTER_IMAGE_MODELS` as the image model set. */
export type OpenRouterImageModelId = (typeof OPENROUTER_IMAGE_MODELS)[number];