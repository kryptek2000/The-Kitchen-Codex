/**
 * The Kitchen Codex — OpenAI image-generation provider (P2).
 *
 * A real `ImageProvider` backed by OpenAI's official Images API. It plugs into
 * the same `ImageProvider` contract as `GeminiImageProvider` and
 * `OpenRouterImageProvider`, the same provider error taxonomy, the same shared
 * generated-image validation boundary, and the same transient preview pipeline.
 * SERVER-SIDE ONLY.
 *
 * VERIFIED API SHAPE (OpenAI Images API documentation, checked 2026-11-16 — not
 * guessed):
 *   - Endpoint: POST `https://api.openai.com/v1/images/generations` (fixed,
 *     never caller-controlled).
 *   - Curated models: `gpt-image-2.6-flare` (fast iteration; TKC default) and
 *     `gpt-image-2.6-sunburst` (detailed visual work). Both are listed by the
 *     official Images API model union.
 *   - Request: JSON `{ model, prompt, n, size, output_format }`. `n: 1` keeps the
 *     output single-image; `size: "1024x1024"` is a documented standard size;
 *     `output_format: "png"` is the documented default for GPT Image models.
 *     `response_format` is NOT sent: it is documented as unsupported for GPT
 *     Image models (they always return base64).
 *   - Success: `{ created, data: [ { b64_json } ], output_format?, usage? }`.
 *     GPT Image models return base64 only (`url` is documented as unsupported).
 *   - Errors: `{ error: { message, type, param, code } }`.
 *
 * SECURITY / SCOPE (mirrors `openAIProvider.ts` / `openRouterImageProvider.ts`):
 *   - The endpoint is FIXED to OpenAI's official base URL. No caller-controlled
 *     baseUrl/endpoint/host is accepted (no arbitrary endpoint, no SSRF surface).
 *   - The key comes ONLY from the server-side operator environment via
 *     `getServerSecretSync("openai_api_key")` (the allowlisted `OPENAI_API_KEY`),
 *     or an EXPLICIT request-scoped session credential. A session credential is
 *     used EXCLUSIVELY when supplied; there is NO environment fallback.
 *   - The key is never returned, logged, persisted, or placed in diagnostics.
 *   - NO streaming, NO automatic retries, NO provider/model fallback.
 *   - The prompt, key, and base64 payload are never logged or echoed.
 *
 * TRUST BOUNDARY: returned bytes are UNTRUSTED until `validateGeneratedImage`
 * (jpeg/png/webp/avif allowlist + container-signature agreement + size bounds)
 * passes. SVG/GIF are rejected. A PRE-DECODE base64 length guard (mathematically
 * derived from the 4 MB decoded cap) runs BEFORE any Buffer.from() allocation via
 * the SHARED guard in `src/core/recipeImage.ts`.
 */

import { MODEL_CONFIG } from "../modelConfig.js";
import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import { redactSecrets } from "../providerDiagnostics.js";
import {
  ProviderOperationError,
  callerCancellationError,
  classifyProviderError,
  throwIfCallerCancelled,
  throwIfProviderRequestAborted,
  type ProviderErrorCode,
} from "./providerErrors.js";
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

/** OpenAI's fixed, official API base (never configurable). */
export const OPENAI_IMAGE_API_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_IMAGE_ENDPOINT = `${OPENAI_IMAGE_API_BASE_URL}/images/generations`;

/**
 * Curated OpenAI image models (SMALL, explicitly verified set — never scraped).
 * `flare` is the faster iteration model; `sunburst` targets detailed visual work.
 * The FIRST entry is the provider default.
 */
export const OPENAI_IMAGE_DEFAULT_MODEL = "gpt-image-2.6-flare";

export const OPENAI_IMAGE_MODELS: readonly string[] = [
  OPENAI_IMAGE_DEFAULT_MODEL,
  "gpt-image-2.6-sunburst",
];

/** Bounded generation parameters (single image, documented standard size). */
export const OPENAI_IMAGE_SIZE = "1024x1024";
export const OPENAI_IMAGE_OUTPUT_FORMAT = "png";

/** Hard ceiling for a success response body before JSON allocation. */
export const OPENAI_IMAGE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Bounded ceiling for an upstream error body used only for classification. */
const OPENAI_IMAGE_MAX_ERROR_BYTES = 4 * 1024;

/** Fetch seam: production uses global fetch; tests inject a Response factory. */
export type OpenAIImageFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAIImageProviderOptions {
  /** Test-only seam; defaults to the global fetch. Never a config surface. */
  fetchFn?: OpenAIImageFetchLike;
  /**
   * P2 credential source: an EXPLICIT session credential. When present it is
   * used INSTEAD of the operator environment key (never a fallback). The
   * provider instance is request-scoped; no global cache retains it.
   */
  credential?: string;
}

function defaultFetch(): OpenAIImageFetchLike {
  return (url, init) => (globalThis as any).fetch(url, init);
}

/** True when the model is in the curated executable set. */
export function isCuratedOpenAIImageModel(model: string): boolean {
  return OPENAI_IMAGE_MODELS.includes(model);
}

/**
 * Reads at most `maxBytes` of a Response body without fully buffering it. A body
 * over the ceiling is cancelled and rejected as INVALID_RESPONSE.
 */
async function readBoundedText(
  res: Response,
  maxBytes: number,
  ctx: { providerId: string; model?: string }
): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    throw new ProviderOperationError("INVALID_RESPONSE", "OpenAI returned an unreadable response.", ctx);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
        throw new ProviderOperationError("INVALID_RESPONSE", "OpenAI response exceeded the size limit.", ctx);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Best-effort Retry-After from response headers (never trusted blindly). */
function retryAfterFrom(res: Response): string | undefined {
  try {
    const value = res.headers?.get("Retry-After");
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds a bounded, SANITIZED diagnostic from untrusted error text. The exact
 * in-use credential is removed by literal replacement, then shared secret
 * redaction is applied. The RAW text is NEVER retained.
 */
function sanitizeDiagnosticText(rawText: unknown, credential: string | undefined): string {
  let text = typeof rawText === "string" ? rawText : "";
  if (!text) return "";
  if (credential) text = text.split(credential).join("<redacted>");
  return redactSecrets(text).slice(0, 300);
}

interface ParsedOpenAIError {
  code?: string;
  type?: string;
  message?: string;
}

function readOpenAIError(parsed: unknown): ParsedOpenAIError {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return {};
  const row = error as Record<string, unknown>;
  return {
    ...(typeof row.code === "string" ? { code: row.code.slice(0, 160) } : {}),
    ...(typeof row.type === "string" ? { type: row.type.slice(0, 160) } : {}),
    ...(typeof row.message === "string" ? { message: row.message.slice(0, 500) } : {}),
  };
}

function isOrganizationVerificationError(error: ParsedOpenAIError): boolean {
  const value = `${error.code ?? ""} ${error.type ?? ""} ${error.message ?? ""}`.toLowerCase();
  return (
    value.includes("organization_must_be_verified") ||
    value.includes("organization_verification") ||
    value.includes("organization could not be verified") ||
    (value.includes("organization") && value.includes("verif"))
  );
}

/**
 * Maps an OpenAI error body + HTTP status to a normalized code. The upstream
 * message is used ONLY transiently for classification; only the normalized code
 * and a bounded fixed message escape.
 */
function classifyOpenAIImageError(
  status: number,
  error: ParsedOpenAIError
): ProviderErrorCode {
  const value = `${error.code ?? ""} ${error.type ?? ""} ${error.message ?? ""}`.toLowerCase();

  // Organization verification is an ACCOUNT eligibility gate, not a generic
  // auth failure: surface it distinctly so the UI can explain the exact fix.
  if (isOrganizationVerificationError(error)) return "ORG_VERIFICATION_REQUIRED";

  if (
    value.includes("billing_hard_limit_reached") ||
    value.includes("insufficient_quota") ||
    value.includes("credit_balance") ||
    value.includes("spend_limit") ||
    value.includes("usage_limit")
  ) {
    return "QUOTA";
  }
  if (value.includes("moderation_blocked") || value.includes("content_policy_violation")) {
    return "BLOCKED";
  }
  if (value.includes("content_filter") || value.includes("moderation")) {
    return "BLOCKED";
  }
  if (
    value.includes("model_not_found") ||
    value.includes("model_not_available") ||
    value.includes("does not exist") ||
    value.includes("unsupported model")
  ) {
    return "UNSUPPORTED_CAPABILITY";
  }
  if (value.includes("invalid_api_key") || value.includes("incorrect api key")) {
    return "AUTH";
  }
  if (value.includes("rate_limit") || value.includes("slow_down")) return "RATE_LIMIT";
  if (value.includes("server_error") || value.includes("overloaded") || value.includes("unavailable")) {
    return "UNAVAILABLE";
  }

  if (status === 401 || status === 403) return "AUTH";
  if (status === 402 || status === 429) return status === 402 ? "QUOTA" : "RATE_LIMIT";
  if (status === 404) return "UNSUPPORTED_CAPABILITY";
  if (status === 408) return "TIMEOUT";
  if (status === 413) return "INVALID_RESPONSE";
  if (status >= 500) return "UNAVAILABLE";
  return "PROVIDER_ERROR";
}

/** The one implemented provider: OpenAI Images API generation. */
export class OpenAIImageProvider implements ImageProvider {
  readonly id = "openai-image";
  readonly name = "OpenAI Image";

  readonly capabilities: ImageProviderCapabilities = {
    imageGeneration: true,
    // TKC explicitly requests PNG (the documented GPT Image default). Any other
    // container that still arrives must pass the shared validation boundary.
    formats: ["image/png"],
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
  };

  private readonly fetchFn: OpenAIImageFetchLike;
  private readonly credential?: string;

  constructor(options: OpenAIImageProviderOptions = {}) {
    this.fetchFn = options.fetchFn ?? defaultFetch();
    // Defense-in-depth: keep the credential non-enumerable so accidental object
    // inspection/spread cannot surface it.
    Object.defineProperty(this, "credential", {
      value: options.credential,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  /** True when a session credential is present, or a real operator key exists. */
  isAvailable(): boolean {
    if (this.credential) return true;
    return Boolean(getServerSecretSync("openai_api_key"));
  }

  private requireKey(): string {
    // A session credential is used EXCLUSIVELY when supplied — never env fallback.
    const key = this.credential ?? getServerSecretSync("openai_api_key");
    if (!key) {
      throw new ProviderOperationError("UNAVAILABLE", "OpenAI Image is not available (no API key).", {
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
    // Curated-set enforcement BEFORE any credential read or network dispatch: an
    // arbitrary model id can never spend against an unknown OpenAI image model.
    if (!isCuratedOpenAIImageModel(model)) {
      throw new ProviderOperationError(
        "UNSUPPORTED_CAPABILITY",
        "Unsupported OpenAI image model.",
        { providerId: this.id, model }
      );
    }

    throwIfCallerCancelled(options.signal, { providerId: this.id, model });
    const key = this.requireKey();

    const body = {
      model,
      prompt,
      n: 1,
      size: OPENAI_IMAGE_SIZE,
      output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
    };

    const timeoutSignal = AbortSignal.timeout(MODEL_CONFIG.imageGenerationTimeoutMs);
    const providerSignal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

    let res: Response;
    try {
      res = await this.fetchFn(OPENAI_IMAGE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: providerSignal,
      });
    } catch (err) {
      if (providerSignal.aborted) {
        throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model });
      }
      if (options.signal?.aborted) {
        throw callerCancellationError({ providerId: this.id, model }, err);
      }
      const code = classifyProviderError(err);
      const transportMessage = err instanceof Error ? err.message : typeof err === "string" ? err : "";
      const sanitized = sanitizeDiagnosticText(transportMessage, key);
      throw new ProviderOperationError(
        code === "PROVIDER_ERROR" ? "UNAVAILABLE" : code,
        "OpenAI image request failed.",
        { providerId: this.id, model },
        sanitized ? new Error(sanitized) : undefined
      );
    }

    if (!res.ok) {
      let parsed: unknown = undefined;
      try {
        const errorText = await readBoundedText(res, OPENAI_IMAGE_MAX_ERROR_BYTES, {
          providerId: this.id,
          model,
        });
        parsed = errorText ? JSON.parse(errorText) : undefined;
      } catch {
        parsed = undefined;
      }
      throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model });
      const error = readOpenAIError(parsed);
      const code = classifyOpenAIImageError(res.status, error);
      // Never construct an Error from the raw upstream message. A bounded,
      // sanitized diagnostic keeps debugging value without retaining secrets.
      const sanitized = sanitizeDiagnosticText(error.message, key);
      const normalized = new ProviderOperationError(
        code,
        `OpenAI image request failed (HTTP ${res.status}).`,
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

    let parsed: unknown;
    try {
      const text = await readBoundedText(res, OPENAI_IMAGE_MAX_RESPONSE_BYTES, {
        providerId: this.id,
        model,
      });
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      if (providerSignal.aborted) {
        throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model });
      }
      if (err instanceof ProviderOperationError) throw err;
      throw new ProviderOperationError("INVALID_RESPONSE", "OpenAI returned invalid JSON.", {
        providerId: this.id,
        model,
      });
    }
    throwIfProviderRequestAborted(options.signal, timeoutSignal, { providerId: this.id, model });

    const extracted = this.extractFirstImage(parsed, model);
    if (!extracted) {
      // A success response with no usable base64 image -> NO_IMAGE (distinct).
      throw new ImageNoImageError("OpenAI returned no image for this recipe.", {
        providerId: this.id,
        model,
      });
    }

    // Untrusted bytes -> shared validation boundary. GPT Image `b64_json`
    // entries carry no media type, so the container is sniffed from the bytes
    // and must agree with itself (SVG/GIF are rejected).
    const declared = sniffGeneratedImageMime(extracted.bytes) ?? "";
    const validation = validateGeneratedImage({ bytes: extracted.bytes, contentType: declared });
    if (!validation.valid) {
      throw new ImageValidationError(`OpenAI image rejected: ${validation.error}`, {
        providerId: this.id,
        model,
      });
    }

    return {
      bytes: extracted.bytes,
      contentType: validation.detectedMime ?? (declared as GeneratedImageMime),
      provider: this.id,
      model,
    };
  }

  /**
   * Deterministic selection: FIRST `data` entry (API order) carrying a non-empty
   * `b64_json` string wins. The PRE-DECODE guard runs BEFORE any Buffer.from()
   * allocation, so an oversized/malicious payload is rejected as INVALID_RESPONSE
   * (endpoint: INVALID_IMAGE) without allocating decoded bytes. The payload
   * string itself is NEVER logged.
   */
  private extractFirstImage(parsed: unknown, model: string): { bytes: Uint8Array } | undefined {
    if (!parsed || typeof parsed !== "object") return undefined;
    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) return undefined;
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const b64 = (entry as { b64_json?: unknown })?.b64_json;
      if (typeof b64 !== "string" || b64.length === 0) continue;
      if (countSignificantBase64Chars(b64) > MAX_GENERATED_IMAGE_BASE64_CHARS) {
        throw new ImageValidationError(
          `OpenAI image rejected: encoded payload exceeds the pre-decode limit (${MAX_GENERATED_IMAGE_BASE64_CHARS} significant base64 characters).`,
          { providerId: this.id, model }
        );
      }
      return { bytes: new Uint8Array(Buffer.from(b64, "base64")) };
    }
    return undefined;
  }
}

/** Curated-type helper: treats `OPENAI_IMAGE_MODELS` as the image model set. */
export type OpenAIImageModelId = (typeof OPENAI_IMAGE_MODELS)[number];
