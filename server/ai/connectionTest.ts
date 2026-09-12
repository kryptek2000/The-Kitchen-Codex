/**
 * The Kitchen Codex — provider connection-test runner (BYOK-4).
 *
 * Performs a REAL, bounded connection probe for the requested provider/model so
 * the user (and the operator) can verify a provider is reachable with the
 * current server configuration — NOT just that a key string is present.
 *
 * PROBE TYPES (non-secret, non-proprietary):
 *   - TEXT (`network_probe`): one lightweight, bounded request against the
 *     provider's FIXED endpoint on a curated model. Explicit tiny output-token
 *     ceiling, a tiny fixed prompt, a bounded timeout, and NO retries. The
 *     response body is read through a UNIVERSAL bounded streaming reader and its
 *     EXPECTED success shape is validated — HTTP 200 with an empty/malformed/
 *     oversized body is NOT a success.
 *   - IMAGE (`credential_check`): the spec forbids spending image-generation
 *     quota, so NO image is generated. For OpenRouter the check is a real
 *     authenticated call to the FIXED `GET https://openrouter.ai/api/v1/key`
 *     credential endpoint (NOT `/models`, which returns 200 even for an invalid
 *     bearer key). Account/quota/profile fields are DISCARDED — only
 *     credential-valid / invalid / bounded-error state leaves this module.
 *   - A provider with no operator key, disabled, or unavailable DOES NOT probe
 *     (fail-fast with bounded `code`).
 *
 * UNIVERSAL BYTE BOUNDS:
 *   - EVERY transport (OpenRouter, DeepSeek, and Gemini) uses the SAME bounded
 *     streaming reader (`readBoundedResponse`). A `max_tokens`/`maxOutputTokens`
 *     cap is NOT a byte-allocation cap, so the Gemini probes use a fixed REST
 *     path (the installed SDK exposes no custom-fetch hook) and the SAME
 *     server secret seam. Overflow is REJECTED, never silently truncated; the
 *     stream is cancelled at the ceiling.
 *   - There is NO `res.text()` full-buffer fallback: if streaming body access is
 *     unavailable the probe FAILS CLOSED.
 *
 * OPERATOR POLICY:
 *   - A VALID server-managed pin restricts the probe to the pinned provider (and
 *     pinned model, when set): a caller CANNOT probe another provider/model.
 *   - An INVALID server-managed pin FAILS CLOSED with ZERO provider network
 *     traffic.
 *   - With no pin, the existing validated user-visible testing is allowed.
 *
 * RESOURCE BOUNDS:
 *   - A small GLOBAL in-flight connection-test ceiling (in addition to the
 *     per-IP rate limit). When saturated, the request is rejected BEFORE any
 *     provider call, with a bounded response and NO hidden retry.
 *
 * SECURITY:
 *   - No API key, masked key, token, raw provider body, prompt, or base64
 *     ever leaves this module. Failures are normalized to bounded code + message.
 *   - Only fixed, allowlisted provider endpoints are reached (no arbitrary URL).
 *   - Time-bounded (MODEL_CONFIG.requestTimeoutMs), NO retries.
 */

import { MODEL_CONFIG } from "../modelConfig.js";
import { getServerSecretSync } from "../platform/ServerEnvironmentSecretAdapter.js";
import { classifyProviderError } from "./providerErrors.js";
import { getRegisteredProviders, findRegisteredProvider } from "./providerRegistry.js";
import { findRegisteredImageProvider } from "./imageProviderRegistry.js";
import { DEEPSEEK_CHAT_ENDPOINT } from "./deepSeekProvider.js";
import { roleModelsForProvider, selectableTextModels } from "./roleModels.js";
import { getTextSelection, getImageSelection } from "./providerSelection.js";
import { isSessionByokSupportedDeployment } from "./sessionByokDeployment.js";
import { resolveCredential, type CredentialSource } from "./credentialResolver.js";

/** Bounded connection-probe result (success or bounded failure — never raw errors). */
export type ConnectionTestResult =
  | { ok: true; providerId: string; model: string; credentialSource: CredentialSource; latencyMs: number }
  | {
      ok: false;
      providerId: string;
      model: string;
      credentialSource: CredentialSource;
      code: string;
      message: string;
    };

/** The probe type surfaced to the catalog (non-secret). */
export type ConnectionTestKind = "network_probe" | "credential_check" | "unavailable";

/** Maps a normalized code to a provider-NEUTRAL, bounded UI message. */
const BOUNDED_MESSAGES: Record<string, string> = {
  AUTH: "Authentication failed.",
  RATE_LIMIT: "Rate limited.",
  QUOTA: "Quota unavailable.",
  UNAVAILABLE: "Provider temporarily unavailable.",
  TIMEOUT: "Connection timed out.",
  INVALID_RESPONSE: "The provider returned an unusable response.",
  UNSUPPORTED_CAPABILITY: "This model is not supported for connection testing.",
  INVALID_MODEL: "The requested model is not in the server's curated model set for this provider.",
  BLOCKED: "Connection test was blocked.",
  OPERATOR_PIN: "This surface is managed by the server operator; only the pinned provider can be tested.",
  BUSY: "Too many connection tests are running. Please try again shortly.",
  PROVIDER_ERROR: "Could not reach the provider.",
  // BYOK-5D: session credential source failures (bounded, non-secret).
  // missing / expired / revoked all normalize to SESSION_CREDENTIAL_MISSING.
  SESSION_CREDENTIAL_MISSING: "No session credential is configured for this provider.",
  CREDENTIAL_SOURCE_INVALID: "The requested credential source is invalid.",
  // The operator/environment credential source is unavailable.
  CREDENTIAL_SOURCE_UNAVAILABLE: "The requested credential source is unavailable.",
  // Session-only BYOK is blocked by deployment policy (distinct from the above).
  SESSION_BYOK_UNAVAILABLE: "Session-only BYOK is not available in this deployment.",
};

function boundedMessage(code: string): string {
  return BOUNDED_MESSAGES[code] ?? BOUNDED_MESSAGES["PROVIDER_ERROR"];
}

/** Harmless, minimal probe prompt (never a user payload). */
const TEXT_PROBE_PROMPT = "Reply with the single word: ok";

/** Explicit tiny output-token ceiling for a text probe (never a real generation). */
const TEXT_PROBE_MAX_TOKENS = 8;

/** Hard ceiling on how many provider-response bytes a probe will read. */
const MAX_PROBE_RESPONSE_BYTES = 4096;

/** Small GLOBAL in-flight connection-test ceiling (in addition to per-IP limit). */
const MAX_IN_FLIGHT_CONNECTION_TESTS = 4;

/** Fixed OpenRouter credential-validation endpoint (never caller-controlled). */
const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";

/** Fixed Google Generative Language REST origin (never caller-controlled). */
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

let inFlightConnectionTests = 0;

/** Observability/test helper: the current number of in-flight probes. */
export function getInFlightConnectionTestCount(): number {
  return inFlightConnectionTests;
}

/** Test helper: reset the global in-flight counter between tests. */
export function resetConnectionTestConcurrencyForTests(): void {
  inFlightConnectionTests = 0;
}

// ---------------------------------------------------------------------------
// Internal error type (private, non-serializable, never leaked)
// ---------------------------------------------------------------------------

class ReadyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReadyError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Universal bounded HTTP reader (never fully buffers an arbitrarily large body)
// ---------------------------------------------------------------------------

/**
 * Reads at most `maxBytes` from a Response stream, cancelling the reader once
 * the ceiling is reached. Reports `truncated:true` when the body EXCEEDED the
 * ceiling. There is NO `res.text()` fallback: a response whose body is not
 * streamable FAILS CLOSED with a bounded error.
 */
async function readBoundedResponse(
  res: Response,
  maxBytes = MAX_PROBE_RESPONSE_BYTES
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    throw new ReadyError("INVALID_RESPONSE", "Provider response was not streamable.");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* best-effort abort */
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        // Distinguish an exactly-full body from an overflowing one, then abort.
        const next = await reader.read();
        if (!next.done) {
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            /* best-effort abort */
          }
        }
        break;
      }
    }
  } catch (err) {
    if (err instanceof ReadyError) throw err;
    // Stream error: use the bounded prefix already read (if any).
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
  return { text: new TextDecoder().decode(merged), truncated };
}

/** Reads a bounded prefix of an ERROR response for classification (never throws). */
async function readErrorText(res: Response): Promise<string> {
  try {
    return (await readBoundedResponse(res)).text;
  } catch {
    return "";
  }
}

function classifyHttp(status: number, text: string): ReadyError {
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key/i.test(text)) {
    return new ReadyError("AUTH", "Authentication failed.");
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) {
    return new ReadyError("RATE_LIMIT", "Rate limited.");
  }
  if (status === 402 || /quota|billing|capacity|insufficient.?balance/i.test(text)) {
    return new ReadyError("QUOTA", "Quota unavailable.");
  }
  if (status === 503 || status === 502 || /\bunavailable\b|\bnot available\b/i.test(text)) {
    return new ReadyError("UNAVAILABLE", "Provider temporarily unavailable.");
  }
  return new ReadyError("PROVIDER_ERROR", "Could not reach the provider.");
}

// ---------------------------------------------------------------------------
// Success-shape validators
// ---------------------------------------------------------------------------

/** Validates the OpenAI-compatible chat-completions success shape. */
function isChatCompletionSuccess(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { choices?: unknown };
    const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    return typeof content === "string" && content.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Validates the OpenRouter `GET /api/v1/key` authenticated credential-response
 * shape. Requires `data` to be a NON-ARRAY object containing at least one
 * expected TYPED field. Account/quota/profile values are never returned — only
 * shape validity is established.
 */
function isOpenRouterKeySuccess(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { data?: unknown };
    const data = parsed?.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
    const row = data as Record<string, unknown>;
    let sawTypedField = false;
    if (Object.prototype.hasOwnProperty.call(row, "label")) {
      if (typeof row["label"] !== "string") return false;
      sawTypedField = true;
    }
    if (Object.prototype.hasOwnProperty.call(row, "limit")) {
      if (typeof row["limit"] !== "number" && row["limit"] !== null) return false;
      sawTypedField = true;
    }
    if (Object.prototype.hasOwnProperty.call(row, "usage")) {
      if (typeof row["usage"] !== "number") return false;
      sawTypedField = true;
    }
    if (Object.prototype.hasOwnProperty.call(row, "is_free_tier")) {
      if (typeof row["is_free_tier"] !== "boolean") return false;
      sawTypedField = true;
    }
    return sawTypedField;
  } catch {
    return false;
  }
}

/** Validates the Gemini `models/{model}:generateContent` success shape. */
function isGeminiGenerateSuccess(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { candidates?: unknown };
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content?.parts;
    if (!Array.isArray(parts)) return false;
    return parts.some((p) => typeof (p as { text?: unknown })?.text === "string" && (p as { text: string }).text.trim().length > 0);
  } catch {
    return false;
  }
}

/** Validates the Gemini `models` list success shape. */
function isGeminiModelsSuccess(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { models?: unknown };
    return Array.isArray(parsed?.models);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Text probes (real, bounded network calls against the fixed provider endpoint)
// ---------------------------------------------------------------------------

/** The Gemini server operator key via the allowlisted secret seam (placeholder = unset). */
function geminiProbeKey(): string | undefined {
  const key = getServerSecretSync("gemini_api_key");
  return key && key !== "MY_GEMINI_API_KEY" ? key : undefined;
}

async function probeGeminiText(model: string, credential?: string): Promise<void> {
  // A supplied credential (session_only) is used EXCLUSIVELY; otherwise the
  // operator env seam is used (placeholder-aware) — never a fallback.
  const key = credential ?? geminiProbeKey();
  if (!key) throw new ReadyError("UNAVAILABLE", "Gemini is not configured.");
  const res = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: TEXT_PROBE_PROMPT }] }],
      generationConfig: { maxOutputTokens: TEXT_PROBE_MAX_TOKENS },
    }),
    signal: AbortSignal.timeout(MODEL_CONFIG.requestTimeoutMs),
  });
  if (!res.ok) {
    const text = await readErrorText(res);
    throw classifyHttp(res.status, text);
  }
  const { text, truncated } = await readBoundedResponse(res);
  if (truncated) throw new ReadyError("INVALID_RESPONSE", "Gemini response exceeded the size limit.");
  if (!isGeminiGenerateSuccess(text)) throw new ReadyError("INVALID_RESPONSE", "Gemini returned an unusable response.");
}

async function probeOpenRouterText(_model: string, credential?: string): Promise<void> {
  const key = credential ?? getServerSecretSync("openrouter_api_key");
  if (!key) throw new ReadyError("UNAVAILABLE", "OpenRouter is not configured.");
  // BYOK-5D: prefer a REAL authenticated credential validation that does NOT
  // generate content. The FIXED `/api/v1/key` endpoint is a real credential
  // check (`/models` returns 200 even for a fake key). The model is already
  // constrained by the server-owned curated allowlist.
  const res = await fetch(OPENROUTER_KEY_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(MODEL_CONFIG.requestTimeoutMs),
  });
  if (!res.ok) {
    const text = await readErrorText(res);
    throw classifyHttp(res.status, text);
  }
  const { text, truncated } = await readBoundedResponse(res);
  if (truncated) throw new ReadyError("INVALID_RESPONSE", "OpenRouter response exceeded the size limit.");
  if (!isOpenRouterKeySuccess(text)) {
    throw new ReadyError("INVALID_RESPONSE", "OpenRouter returned an unusable credential response.");
  }
}

async function probeDeepSeekText(model: string, credential?: string): Promise<void> {
  const key = credential ?? getServerSecretSync("deepseek_api_key");
  if (!key) throw new ReadyError("UNAVAILABLE", "DeepSeek is not configured.");
  const res = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: TEXT_PROBE_PROMPT }],
      max_tokens: TEXT_PROBE_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(MODEL_CONFIG.requestTimeoutMs),
  });
  if (!res.ok) {
    const text = await readErrorText(res);
    throw classifyHttp(res.status, text);
  }
  const { text, truncated } = await readBoundedResponse(res);
  if (truncated) throw new ReadyError("INVALID_RESPONSE", "DeepSeek response exceeded the size limit.");
  if (!isChatCompletionSuccess(text)) {
    throw new ReadyError("INVALID_RESPONSE", "DeepSeek returned an unusable response.");
  }
}

// ---------------------------------------------------------------------------
// Image probes (quota-free credential checks — NO image generation)
// ---------------------------------------------------------------------------

async function probeGeminiImage(credential?: string): Promise<void> {
  const key = credential ?? geminiProbeKey();
  if (!key) throw new ReadyError("UNAVAILABLE", "Gemini image is not configured.");
  // A bounded REST `models` list verifies the key/endpoint without spending
  // generation quota AND without the SDK's unbounded body parsing.
  const res = await fetch(`${GEMINI_API_BASE}/models`, {
    method: "GET",
    headers: { "x-goog-api-key": key },
    signal: AbortSignal.timeout(MODEL_CONFIG.requestTimeoutMs),
  });
  if (!res.ok) {
    const text = await readErrorText(res);
    throw classifyHttp(res.status, text);
  }
  const { text, truncated } = await readBoundedResponse(res);
  if (truncated) throw new ReadyError("INVALID_RESPONSE", "Gemini response exceeded the size limit.");
  if (!isGeminiModelsSuccess(text)) throw new ReadyError("INVALID_RESPONSE", "Gemini returned an unusable response.");
}

async function probeOpenRouterImage(credential?: string): Promise<void> {
  const key = credential ?? getServerSecretSync("openrouter_api_key");
  if (!key) throw new ReadyError("UNAVAILABLE", "OpenRouter image is not configured.");
  // REAL authenticated credential validation. `/models` returns 200 even for a
  // fake bearer key, so it is NOT a credential check; `/key` is. The response
  // body is parsed ONLY to confirm the expected shape, then discarded — no
  // account/quota/profile data is ever returned.
  const res = await fetch(OPENROUTER_KEY_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(MODEL_CONFIG.requestTimeoutMs),
  });
  if (!res.ok) {
    const text = await readErrorText(res);
    throw classifyHttp(res.status, text);
  }
  const { text, truncated } = await readBoundedResponse(res);
  if (truncated) throw new ReadyError("INVALID_RESPONSE", "OpenRouter response exceeded the size limit.");
  if (!isOpenRouterKeySuccess(text)) {
    throw new ReadyError("INVALID_RESPONSE", "OpenRouter returned an unusable credential response.");
  }
}

// ---------------------------------------------------------------------------
// Probe dispatch + error normalization
// ---------------------------------------------------------------------------

function probeText(providerId: string, model: string, credential?: string): Promise<void> {
  if (providerId === "gemini") return probeGeminiText(model, credential);
  if (providerId === "openrouter") return probeOpenRouterText(model, credential);
  if (providerId === "deepseek") return probeDeepSeekText(model, credential);
  return Promise.reject(new ReadyError("PROVIDER_ERROR", "Unknown text provider."));
}

function probeImage(providerId: string, credential?: string): Promise<void> {
  if (providerId === "gemini-image") return probeGeminiImage(credential);
  if (providerId === "openrouter-image") return probeOpenRouterImage(credential);
  return Promise.reject(new ReadyError("PROVIDER_ERROR", "Unknown image provider."));
}

function normalizeProbeError(err: unknown): string {
  if (err instanceof ReadyError) return err.code;
  const code = classifyProviderError(err);
  return BOUNDED_MESSAGES[code] ? code : "PROVIDER_ERROR";
}

/** Resolves the probe's curated model id, or undefined if the provider has none. */
function resolveProbeModel(providerId: string, kind: "text" | "image"): string | undefined {
  if (kind === "text") return roleModelsForProvider(providerId, "kitchenInterpret")[0] ?? undefined;
  const image = findRegisteredImageProvider(providerId);
  return image ? image.defaultModel : undefined;
}

/**
 * The SERVER-OWNED curated model set a provider+kind may be connection-tested
 * against. NEVER the client's model list and NEVER an arbitrary/unknown id.
 */
export function curatedConnectionTestModels(providerId: string, kind: "text" | "image"): string[] {
  if (kind === "text") {
    if (!findRegisteredProvider(getRegisteredProviders(), providerId)) return [];
    return selectableTextModels(providerId);
  }
  const registered = findRegisteredImageProvider(providerId);
  return registered ? [...(registered.models ?? [registered.defaultModel])] : [];
}

/**
 * The production probe type surface: network_probe for text, credential_check
 * for image, unavailable for unconfigured/disabled.
 */
export function connectionTestKindForProvider(
  providerId: string,
  kind: "text" | "image"
): ConnectionTestKind {
  const isConfiguredAndAvailable = (() => {
    if (kind === "text") {
      const reg = findRegisteredProvider(getRegisteredProviders(), providerId);
      return Boolean(reg && reg.enabled !== false && reg.provider.isAvailable());
    }
    const reg = findRegisteredImageProvider(providerId);
    return Boolean(reg && reg.enabled !== false && reg.provider.isAvailable());
  })();
  if (!isConfiguredAndAvailable) return "unavailable";
  return kind === "image" ? "credential_check" : "network_probe";
}

/**
 * Enforces the server-managed operator pin for a probe. Returns the model id to
 * probe (the pinned/default model) when allowed, or a bounded rejection when the
 * caller tries to probe a different provider/model or the pin is invalid.
 */
function enforceOperatorPin(
  providerId: string,
  kind: "text" | "image",
  modelId: string | undefined
): { allowed: true; modelId?: string; serverManaged: boolean } | { allowed: false } {
  const selection = kind === "text" ? getTextSelection() : getImageSelection();
  if (selection.selectionMode !== "server_managed") return { allowed: true, modelId, serverManaged: false };
  if (!selection.valid || !selection.selectedProviderId) return { allowed: false };
  if (providerId !== selection.selectedProviderId) return { allowed: false };
  const pinnedModel = selection.selectedModelId ?? resolveProbeModel(providerId, kind);
  if (modelId && pinnedModel && modelId !== pinnedModel) return { allowed: false };
  return { allowed: true, modelId: pinnedModel ?? modelId, serverManaged: true };
}

/**
 * Runs a bounded connection probe for a provider/model.
 * Validate provider presence + operator pin first (fail-fast without a network
 * call), then probe the curated model. NO retries. Returns a bounded result only.
 */
export async function runConnectionTest(options: {
  providerId: string;
  kind: "text" | "image";
  modelId?: string;
  /** BYOK-5D: whose credential to validate. Defaults to server_environment. */
  credentialSource?: CredentialSource;
}): Promise<ConnectionTestResult> {
  const { providerId, kind, modelId } = options;
  const requestedSource: CredentialSource = options.credentialSource ?? "server_environment";

  const fail = (
    code: string,
    credentialSource: CredentialSource,
    model: string = modelId ?? ""
  ): ConnectionTestResult => ({
    ok: false,
    providerId,
    model,
    credentialSource,
    code,
    message: boundedMessage(code),
  });

  // Fail-fast: provider registered?
  const reg =
    kind === "text"
      ? findRegisteredProvider(getRegisteredProviders(), providerId)
      : findRegisteredImageProvider(providerId);
  if (!reg) return fail("PROVIDER_ERROR", requestedSource);

  // OPERATOR POLICY: a server-managed pin restricts the probe to the pinned
  // provider/model AND FORCES server_environment credentials (a session key can
  // never replace the operator credential). An invalid pin fails closed. ZERO
  // provider traffic either way.
  const pinned = enforceOperatorPin(providerId, kind, modelId);
  if (!pinned.allowed) return fail("OPERATOR_PIN", requestedSource);

  // Effective credential source: a valid pin forces server_environment; the
  // caller's explicit credentialSource is honored ONLY when there is no pin.
  const effectiveSource: CredentialSource = pinned.serverManaged
    ? "server_environment"
    : requestedSource;

  // Session-only connection testing uses the SAME local/single-user deployment
  // guard as key storage/runtime. Hosted/non-loopback fails closed with a code
  // DISTINCT from the ordinary environment-credential-unavailable case.
  if (effectiveSource === "session_only" && !isSessionByokSupportedDeployment()) {
    return fail("SESSION_BYOK_UNAVAILABLE", effectiveSource, pinned.modelId ?? modelId ?? "");
  }

  // For server_environment, preserve the existing fail-fast availability check
  // (a session_only provider may be env-unavailable yet session-available).
  if (effectiveSource === "server_environment") {
    const testKind = connectionTestKindForProvider(providerId, kind);
    if (testKind === "unavailable") {
      return fail("UNAVAILABLE", effectiveSource, pinned.modelId ?? modelId ?? "");
    }
  }

  // MODEL ALLOWLIST (INVALID_MODEL): an explicit modelId MUST exist in the
  // server-owned curated model set for this provider/kind. Rejected BEFORE any
  // provider (or SDK) call.
  if (modelId && !curatedConnectionTestModels(providerId, kind).includes(modelId)) {
    return fail("INVALID_MODEL", effectiveSource, modelId);
  }

  const model = pinned.modelId ?? modelId ?? resolveProbeModel(providerId, kind) ?? "";
  if (!model) return fail("UNSUPPORTED_CAPABILITY", effectiveSource, model);

  // Resolve the EXACT credential for session_only (no env fallback, no
  // cross-provider lookup). server_environment probes read the env seam directly
  // so the existing placeholder/availability semantics are unchanged.
  let sessionCredential: string | undefined;
  if (effectiveSource === "session_only") {
    const resolved = resolveCredential(providerId, "session_only");
    if ("code" in resolved) return fail(resolved.code, effectiveSource, model);
    sessionCredential = resolved.lease.secret;
  }

  // GLOBAL CONCURRENCY CEILING: reject BEFORE any provider call when saturated.
  if (inFlightConnectionTests >= MAX_IN_FLIGHT_CONNECTION_TESTS) {
    return fail("BUSY", effectiveSource, model);
  }
  inFlightConnectionTests += 1;

  const start = Date.now();
  try {
    if (kind === "text") {
      await probeText(providerId, model, sessionCredential);
    } else {
      await probeImage(providerId, sessionCredential);
    }
    return {
      ok: true,
      providerId,
      model,
      credentialSource: effectiveSource,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const code = normalizeProbeError(err);
    return fail(code, effectiveSource, model);
  } finally {
    inFlightConnectionTests = Math.max(0, inFlightConnectionTests - 1);
  }
}

/** The global in-flight ceiling (exposed for tests/documentation). */
export const CONNECTION_TEST_MAX_IN_FLIGHT = MAX_IN_FLIGHT_CONNECTION_TESTS;

/** The per-response body byte ceiling (exposed for tests/documentation). */
export const CONNECTION_TEST_MAX_RESPONSE_BYTES = MAX_PROBE_RESPONSE_BYTES;

/** The fixed Gemini REST origin (exposed for tests/documentation). */
export const GEMINI_CONNECTION_TEST_ORIGIN = GEMINI_API_BASE;
