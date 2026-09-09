/**
 * The Kitchen Codex — normalized provider error taxonomy (v0.7 Phase 1A).
 *
 * A small, stable set of provider error categories so that:
 *   - user-facing layers never receive secret-bearing raw provider errors,
 *   - fallback decisions can key on a normalized `code`,
 *   - diagnostics stay sanitized.
 *
 * Provider-specific raw exceptions are preserved internally as a NON-ENUMERABLE
 * `cause` so they never serialize into diagnostics, settings, logs, or the UI.
 */

import { redactSecrets } from "../providerDiagnostics.js";

/** Normalized provider error categories. */
export type ProviderErrorCode =
  | "AUTH"
  | "QUOTA"
  | "RATE_LIMIT"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "UNSUPPORTED_CAPABILITY"
  | "INVALID_RESPONSE"
  | "PROVIDER_ERROR"
  | "NO_IMAGE"
  | "BLOCKED";

/** Errors that are eligible for automatic fallback to the next capable candidate. */
export const FALLBACK_ELIGIBLE_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "QUOTA",
  "RATE_LIMIT",
  "UNAVAILABLE",
  "TIMEOUT",
  "INVALID_RESPONSE",
  "PROVIDER_ERROR",
]);

export interface ProviderErrorContext {
  providerId?: string;
  model?: string;
}

/** A sanitized, serializable diagnostic describing a failed provider attempt. */
export interface ProviderDiagnostic {
  code?: ProviderErrorCode;
  providerId?: string;
  model?: string;
  status?: number;
  /** Sanitized (secrets redacted) human-readable detail. */
  message?: string;
}

/**
 * A typed provider error. `code` drives fallback/messaging; `providerId`/`model`
 * identify the attempt; `status` is a best-effort HTTP-ish status when known.
 * The raw provider exception is attached as a NON-ENUMERABLE `cause` so it is
 * preserved for internal debugging but never serialized.
 */
export class ProviderOperationError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId?: string;
  readonly model?: string;
  readonly status?: number;
  private readonly rawCause?: unknown;

  constructor(code: ProviderErrorCode, message: string, ctx: ProviderErrorContext = {}, cause?: unknown) {
    super(message || code);
    this.name = "ProviderOperationError";
    this.code = code;
    if (ctx.providerId) this.providerId = ctx.providerId;
    if (ctx.model) this.model = ctx.model;
    if (cause !== undefined) this.rawCause = cause;
  }

  get cause(): unknown | undefined {
    return this.rawCause;
  }
}

/** Extracts a best-effort numeric status/code from a raw error. */
function numericStatus(err: Record<string, unknown>): number | undefined {
  const s = err["status"];
  if (typeof s === "number") return s;
  const c = err["code"];
  if (typeof c === "number") return c;
  return undefined;
}

/** Conservative HTTP/abort/auth classification of a raw error (provider-agnostic). */
export function classifyProviderError(error: unknown): ProviderErrorCode {
  if (error instanceof ProviderOperationError) return error.code;

  const err = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const name = typeof err["name"] === "string" ? err["name"] : "";
  const message = typeof err["message"] === "string" ? err["message"] : String(error ?? "");
  const status = numericStatus(err);

  // Timeout / aborted request.
  if (name === "AbortError" || /timeout|timed out|aborted/i.test(message)) return "TIMEOUT";

  // Auth-like signals.
  if (status === 401 || status === 403) return "AUTH";
  if (/unauthorized|forbidden|invalid api key|api key.*invalid|permission|denied|not authorized/i.test(message)) {
    return "AUTH";
  }

  // Insufficient balance / credit exhaustion (DeepSeek 402, OpenAI-style 402).
  if (status === 402) return "QUOTA";

  // Quota / rate limiting.
  if (status === 429) return "RATE_LIMIT";
  if (/quota|rate.?limit|too many requests|429|exhausted|billing|capacity/i.test(message)) {
    return /cart|could|frequently|try again soon/i.test(message) ? "RATE_LIMIT" : "QUOTA";
  }

  // Unavailable / gateway-style ("not available" is the known Gemini message).
  if (status === 503 || status === 502 || /\bunavailable\b|\bnot available\b|service unavailable|down|maintenance/i.test(message)) {
    return "UNAVAILABLE";
  }

  // Invalid response (malformed/empty parse).
  if (/empty response|invalid json|malformed|could not parse|not valid json/i.test(message)) {
    return "INVALID_RESPONSE";
  }

  // Safety/blocked signals (conservative safety net for provider-exception text;
  // the Gemini image provider also inspects the RESPONSE itself for these).
  if (/\bblocked\b|blockreason|safety|prohibited content|cannot help with that|cannot generate|not able to (help|generate)|filtered|recitation/i.test(message)) {
    return "BLOCKED";
  }

  return "PROVIDER_ERROR";
}

/** Sanitizes a message for diagnostics (secrets redacted). */
function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    const m = String(error.message ?? "");
    return m ? redactSecrets(m.slice(0, 300)) : "";
  }
  if (typeof error === "string") return redactSecrets(error.slice(0, 300));
  return "";
}

/**
 * Normalizes any raw provider error into a `ProviderOperationError`. Preserves an
 * already-normalized error verbatim when present.
 */
export function normalizeProviderError(
  error: unknown,
  ctx: ProviderErrorContext = {}
): ProviderOperationError {
  if (error instanceof ProviderOperationError) {
    // Enrich with context if it was previously missing.
    if (!error.providerId && ctx.providerId) {
      return new ProviderOperationError(error.code, error.message, { ...ctx, model: error.model ?? ctx.model }, error);
    }
    return error;
  }

  const code = classifyProviderError(error);
  const errObj = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const status = numericStatus(errObj);
  const message = safeMessage(error) || code;

  const normalized = new ProviderOperationError(code, message, ctx, error);
  if (typeof status === "number") {
    Object.defineProperty(normalized, "status", { value: status, enumerable: true, writable: false });
  }
  return normalized;
}

/** Returns a sanitized, serializable diagnostic for a normalized error. */
export function toProviderDiagnostic(error: ProviderOperationError): ProviderDiagnostic {
  const diag: ProviderDiagnostic = { code: error.code };
  if (error.providerId) diag.providerId = error.providerId;
  if (error.model) diag.model = error.model;
  if (typeof error.status === "number") diag.status = error.status;
  const message = safeMessage(error);
  if (message) diag.message = message;
  return diag;
}

/** True when a normalized error code permits automatic fallback. */
export function isFallbackEligible(code: ProviderErrorCode): boolean {
  return FALLBACK_ELIGIBLE_ERROR_CODES.has(code);
}
