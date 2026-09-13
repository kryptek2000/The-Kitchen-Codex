/**
 * The Kitchen Codex — explicit zero-cost OpenRouter capability verification
 * (v0.8.x).
 *
 * A dynamically discovered OpenRouter text model may become executable ONLY
 * after an EXPLICIT user action tests a specific JSON transport profile and the
 * application validates its answer. This does not prove upstream enforcement. Catalog metadata
 * (`structured_outputs` / `response_format`) is a CANDIDATE signal only and is
 * NEVER trusted on its own.
 *
 * HARD ZERO-COST GATE (BEFORE any provider request):
 *   The CURRENT trusted catalog must prove, for the exact model:
 *     - it exists,
 *     - its pricing is fresh (`pricingFresh`),
 *     - its pricing is verified (`pricingVerified`),
 *     - `costClass === "free"` and `isFree === true`.
 *   Any failure returns a bounded pricing/model code with ZERO provider calls.
 *
 * PROBE CONTRACT (the same runtime mechanics as production):
 *   - explicit strict json_schema OR application-validated json_object profile
 *   - `provider: { require_parameters: true }`
 *   - a trivial `{ ok: boolean }` schema (no optional fields, no extra structure)
 *   - a minimum practical output-token budget and a bounded timeout.
 *   The response must be a valid chat completion whose message content parses as
 *   EXACTLY `{"ok":true}`. Plain text, Markdown-wrapped JSON, malformed JSON, and
 *   schema mismatches all FAIL. Provider responses are treated as untrusted and
 *   are size-bounded; raw provider text is never returned or logged.
 *
 * CREDENTIAL RULE:
 *   Verification requires the EXACT `openrouter` credential identity. Session
 *   credentials are scoped by exact provider id, so an `openrouter-image` (or any
 *   other) session key can NEVER satisfy a text verification. There is no
 *   credential aliasing, no env mutation, and no cross-provider fallback.
 *
 * ROUTER POLICY:
 *   `openrouter/free` (and other routers) are NEVER promoted to executable: a
 *   successful probe would only prove the CURRENT routing path, and OpenRouter's
 *   `require_parameters` does not guarantee every future request routes to a
 *   strict-schema-compatible model. Routers are rejected BEFORE any provider
 *   request with `MODEL_ROUTER_NOT_SUPPORTED`.
 *
 * SERVER MEMORY ONLY: a success is recorded in `capabilityVerificationStore.ts`
 * (process memory, fingerprint-bound, TTL-bounded). Nothing is persisted.
 */

import { MODEL_CONFIG } from "../modelConfig.js";
import { isOpenRouterProfile, APPLICATION_VALIDATED_JSON_PROFILE, type OpenRouterProfile } from '../../src/core/ai/openRouterProfile.js';
import { completionContent, structuredRequestFields, OPENROUTER_PROBE_TOKENS } from './openRouterOutput.js';
import { getTextSelection } from "./providerSelection.js";
import { isSessionByokSupportedDeployment } from "./sessionByokDeployment.js";
import { resolveCredential, isCredentialSource, type CredentialSource } from "./credentialResolver.js";
import {
  findOpenRouterCatalogModel,
  getOpenRouterCatalogSnapshot,
  openRouterModelFingerprint,
  isValidOpenRouterModelId,
  type OpenRouterCatalogModel,
} from "./openRouterCatalog.js";
import { OPENROUTER_CHAT_ENDPOINT } from "./openRouterProvider.js";
import {
  CAPABILITY_PROBE_VERSION,
  getCapabilityVerification,
  recordCapabilityVerification,
  STRICT_JSON_SCHEMA_PROFILE,
} from "./capabilityVerificationStore.js";

/** The one provider this surface can verify (never caller-controlled). */
export const CAPABILITY_VERIFICATION_PROVIDER_ID = "openrouter" as const;

/** Bounded timeout for the probe request (ms). */
export const CAPABILITY_PROBE_TIMEOUT_MS = MODEL_CONFIG.requestTimeoutMs;

/** Minimum practical output-token budget for the probe. */
export const CAPABILITY_PROBE_MAX_TOKENS = OPENROUTER_PROBE_TOKENS;

/** Hard ceiling on probe response bytes read. */
export const CAPABILITY_PROBE_MAX_RESPONSE_BYTES = 16 * 1024;

/** Bounded error codes for a verification attempt (never raw provider text). */
export type CapabilityVerificationErrorCode =
  | "INVALID_MODEL"
  | "MODEL_NOT_FOUND"
  | "MODEL_NOT_VERIFIED_FREE"
  | "MODEL_PRICING_UNVERIFIED"
  | "MODEL_PRICING_CHANGED"
  | "MODEL_ROUTER_NOT_SUPPORTED"
  | "OPERATOR_PIN"
  | "CREDENTIAL_SOURCE_INVALID"
  | "SESSION_CREDENTIAL_MISSING"
  | "CREDENTIAL_SOURCE_UNAVAILABLE"
  | "SESSION_BYOK_UNAVAILABLE"
  | "MODEL_CAPABILITY_UNVERIFIED";

/**
 * Bounded, non-secret PUBLIC classification for a failed provider probe. The
 * top-level `code` stays `MODEL_CAPABILITY_UNVERIFIED` (HTTP 422) so existing
 * clients keep working; this classification is additive diagnosis only. It never
 * carries raw provider text, headers, status text, or credentials.
 */
export type ProbeFailureClassification =
  | "PROBE_OUTPUT_TRUNCATED"
  | "PROBE_REFUSAL"
  | "PROBE_TOOL_CALL_ONLY"
  | "PROBE_CONTENT_PARTS_UNSUPPORTED"
  | "PROBE_WRONG_JSON_SHAPE"
  | "PROBE_WRONG_REQUIRED_VALUE"
  | "PROBE_EXTRA_PROPERTIES"
  | "PROBE_TRANSPORT_ERROR"
  | "PROBE_TIMEOUT"
  | "PROBE_AUTH"
  | "PROBE_RATE_LIMIT"
  | "PROBE_QUOTA"
  | "PROBE_UNAVAILABLE"
  | "PROBE_NO_COMPATIBLE_ENDPOINT"
  | "PROBE_HTTP_ERROR"
  | "PROBE_EMPTY_RESPONSE"
  | "PROBE_OVERSIZED"
  | "PROBE_MALFORMED_JSON"
  | "PROBE_SCHEMA_MISMATCH";

export type CapabilityVerificationResult =
  | {
      ok: true;
      providerId: typeof CAPABILITY_VERIFICATION_PROVIDER_ID;
      modelId: string;
      profile: string;
      verifiedAt: number;
      providerCalled: boolean;
    }
  | {
      ok: false;
      providerId: typeof CAPABILITY_VERIFICATION_PROVIDER_ID;
      modelId: string;
      code: CapabilityVerificationErrorCode;
      message: string;
      /** Present ONLY when the probe RAN and failed (`MODEL_CAPABILITY_UNVERIFIED`). */
      probeClassification?: ProbeFailureClassification;
      providerCalled: boolean;
    };

/** Bounded, provider-neutral messages (never raw provider text). */
const BOUNDED_MESSAGES: Record<CapabilityVerificationErrorCode, string> = {
  INVALID_MODEL: "The model id is not valid.",
  MODEL_NOT_FOUND: "This model is not in the current trusted OpenRouter catalog.",
  MODEL_NOT_VERIFIED_FREE: "This model could not be verified as free. It cannot be verified for Kitchen Codex.",
  MODEL_PRICING_UNVERIFIED: "This model's current pricing could not be verified. Refresh the catalog and try again.",
  MODEL_PRICING_CHANGED: "This model is no longer free. Review the current price before using it.",
  MODEL_ROUTER_NOT_SUPPORTED: "OpenRouter router models cannot be verified for reliable Kitchen Codex execution.",
  OPERATOR_PIN: "This surface is managed by the server operator; only the pinned provider/model can be verified.",
  CREDENTIAL_SOURCE_INVALID: "The requested credential source is invalid.",
  SESSION_CREDENTIAL_MISSING: "No session credential is configured for OpenRouter.",
  CREDENTIAL_SOURCE_UNAVAILABLE: "No OpenRouter server credential is configured.",
  SESSION_BYOK_UNAVAILABLE: "Session-only BYOK is not available in this deployment.",
  MODEL_CAPABILITY_UNVERIFIED: "The model has not verified the requested JSON compatibility profile.",
};

function boundedMessage(code: CapabilityVerificationErrorCode): string {
  return BOUNDED_MESSAGES[code];
}

/** Internal probe failure reasons (never raw provider text). */
export type ProbeFailureReason =
  | "output_truncated"
  | "refusal"
  | "tool_call_only"
  | "content_parts_unsupported"
  | "wrong_json_shape"
  | "wrong_required_value"
  | "extra_properties"
  | "transport_error"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "quota"
  | "unavailable"
  | "no_compatible_endpoint"
  | "http_error"
  | "empty_response"
  | "oversized"
  | "malformed_json"
  | "schema_mismatch";

/**
 * The COMPLETE internal -> public classification map. Every internal reason maps
 * to exactly one bounded public classification (verified by tests).
 */
export const PROBE_FAILURE_CLASSIFICATION: Record<ProbeFailureReason, ProbeFailureClassification> = {
  output_truncated: 'PROBE_OUTPUT_TRUNCATED',
  refusal: 'PROBE_REFUSAL',
  tool_call_only: 'PROBE_TOOL_CALL_ONLY',
  content_parts_unsupported: 'PROBE_CONTENT_PARTS_UNSUPPORTED',
  wrong_json_shape: 'PROBE_WRONG_JSON_SHAPE',
  wrong_required_value: 'PROBE_WRONG_REQUIRED_VALUE',
  extra_properties: 'PROBE_EXTRA_PROPERTIES',
  transport_error: "PROBE_TRANSPORT_ERROR",
  timeout: "PROBE_TIMEOUT",
  auth: "PROBE_AUTH",
  rate_limit: "PROBE_RATE_LIMIT",
  quota: "PROBE_QUOTA",
  unavailable: "PROBE_UNAVAILABLE",
  no_compatible_endpoint: "PROBE_NO_COMPATIBLE_ENDPOINT",
  http_error: "PROBE_HTTP_ERROR",
  empty_response: "PROBE_EMPTY_RESPONSE",
  oversized: "PROBE_OVERSIZED",
  malformed_json: "PROBE_MALFORMED_JSON",
  schema_mismatch: "PROBE_SCHEMA_MISMATCH",
};

/** Bounded, non-secret public message per classification (never raw provider text). */
export const PROBE_FAILURE_MESSAGES: Record<ProbeFailureClassification, string> = {
  PROBE_OUTPUT_TRUNCATED: 'The model exhausted its output budget before completing an answer. No mode was verified.',
  PROBE_REFUSAL: 'The model refused this verification request.',
  PROBE_TOOL_CALL_ONLY: 'The model returned a tool call instead of the required JSON answer.',
  PROBE_CONTENT_PARTS_UNSUPPORTED: 'The model returned content parts outside the supported Chat Completions contract.',
  PROBE_WRONG_JSON_SHAPE: 'The model returned JSON with the wrong object shape.',
  PROBE_WRONG_REQUIRED_VALUE: 'The model returned the wrong required verification value.',
  PROBE_EXTRA_PROPERTIES: 'The model returned unexpected JSON properties.',
  PROBE_TRANSPORT_ERROR: "Could not reach OpenRouter. Check the connection and try again.",
  PROBE_TIMEOUT: "OpenRouter did not respond in time. Try again.",
  PROBE_AUTH: "OpenRouter authentication failed or the session key expired. Update the session key and try again.",
  PROBE_RATE_LIMIT: "OpenRouter rate-limited this verification. Wait a moment before trying again.",
  PROBE_QUOTA: "The OpenRouter credential has insufficient quota or credit.",
  PROBE_UNAVAILABLE: "OpenRouter is temporarily unavailable. Try again shortly.",
  PROBE_NO_COMPATIBLE_ENDPOINT:
    "OpenRouter found no endpoint that supports the requested JSON profile for this model.",
  PROBE_HTTP_ERROR: "OpenRouter returned an unexpected error.",
  PROBE_EMPTY_RESPONSE: "OpenRouter returned an empty response.",
  PROBE_OVERSIZED: "OpenRouter returned a response larger than the allowed limit.",
  PROBE_MALFORMED_JSON: "OpenRouter returned malformed JSON.",
  PROBE_SCHEMA_MISMATCH: "The model did not return a complete supported JSON answer.",
};

/** Maps an internal probe failure reason to its bounded public classification. */
export function probeFailureClassification(reason: ProbeFailureReason): ProbeFailureClassification {
  return Object.hasOwn(PROBE_FAILURE_CLASSIFICATION, reason) ? PROBE_FAILURE_CLASSIFICATION[reason] : 'PROBE_HTTP_ERROR';
}

/** The bounded public message for a probe failure classification. */
export function probeFailureMessage(classification: ProbeFailureClassification): string {
  return Object.hasOwn(PROBE_FAILURE_MESSAGES, classification) ? PROBE_FAILURE_MESSAGES[classification] : PROBE_FAILURE_MESSAGES.PROBE_HTTP_ERROR;
}

/**
 * Maps a non-success HTTP status to the internal probe reason. 401/403 -> auth,
 * 402 -> quota, 404 -> no compatible endpoint (OpenRouter reports "no endpoints
 * support the provided parameters" as 404), 429 -> rate limit, 5xx -> unavailable,
 * anything else -> generic http_error. Never includes status text.
 */
export function probeFailureReasonForHttpStatus(status: number): ProbeFailureReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 404) return "no_compatible_endpoint";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "unavailable";
  return "http_error";
}

/** The trivial strict schema the probe must satisfy: exactly `{ "ok": true }`. */
export const CAPABILITY_PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

const CAPABILITY_PROBE_SCHEMA_NAME = "kitchen_codex_capability_probe";

/** A harmless, minimal probe prompt (never user content). */
const CAPABILITY_PROBE_PROMPT =
  'Return exactly this JSON object and nothing else: {"ok": true}';

/** The exact probe request body (same runtime mechanics as production). */
export function buildCapabilityProbeRequest(modelId: string, profile: OpenRouterProfile = STRICT_JSON_SCHEMA_PROFILE): Record<string, unknown> {
  return {
    model: modelId,
    messages: [{ role: "user", content: CAPABILITY_PROBE_PROMPT }],
    temperature: 0,
    ...structuredRequestFields(profile, CAPABILITY_PROBE_SCHEMA, CAPABILITY_PROBE_SCHEMA_NAME, CAPABILITY_PROBE_MAX_TOKENS),
  };
}

/** Bounded probe validation result (never raw provider text). */
export type ProbeValidation = { ok: true } | { ok: false; reason: ProbeFailureReason };

/**
 * Validates the probe's assistant message content against the EXACT contract.
 * Plain text, Markdown-wrapped JSON, malformed JSON, arrays/scalars, extra keys,
 * and `ok !== true` all fail. No "best effort" acceptance.
 */
export function validateCapabilityProbeContent(content: unknown): ProbeValidation {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, reason: "empty_response" };
  }
  const trimmed = content.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Covers plain text AND Markdown-fenced JSON (```json ... ```).
    return { ok: false, reason: "malformed_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "wrong_json_shape" };
  }
  const row = parsed as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some(k => k !== 'ok')) return { ok: false, reason: 'extra_properties' };
  if (!Object.hasOwn(row, 'ok')) return { ok: false, reason: 'wrong_json_shape' };
  if (row.ok !== true) return { ok: false, reason: 'wrong_required_value' };
  return { ok: true };
}

interface ProbeFetchResponse {
  ok: boolean;
  status: number;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void>; releaseLock?(): void } } | null;
}

export type CapabilityProbeFetchLike = (
  url: string,
  init: RequestInit
) => Promise<ProbeFetchResponse>;

function defaultProbeFetch(): CapabilityProbeFetchLike {
  return (url, init) => (globalThis as unknown as { fetch: CapabilityProbeFetchLike }).fetch(url, init);
}

/**
 * A bounded read failure carrying the exact internal reason so an unreadable
 * body, a stream error, and an overflow are NOT conflated. Never carries body
 * bytes or provider text.
 */
class ProbeReadError extends Error {
  readonly probeReason: ProbeFailureReason;
  constructor(probeReason: ProbeFailureReason, message: string) {
    super(message);
    this.name = "ProbeReadError";
    this.probeReason = probeReason;
  }
}

/** Reads at most `maxBytes` from a response stream (overflow -> ProbeReadError). */
async function readBoundedProbeText(res: ProbeFetchResponse, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    throw new ProbeReadError("transport_error", "Probe response was not readable.");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let read: { done: boolean; value?: Uint8Array };
      try {
        read = await reader.read();
      } catch {
        // A stream error mid-body is a transport-level failure, not an overflow.
        throw new ProbeReadError("transport_error", "Probe response stream failed.");
      }
      const { done, value } = read;
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        try {
          await reader.cancel?.();
        } catch {
          /* best-effort */
        }
        throw new ProbeReadError("oversized", "Probe response exceeded the size limit.");
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock?.();
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

async function runCapabilityProbe(options: {
  profile: OpenRouterProfile;
  modelId: string;
  credential: string;
  fetchFn: CapabilityProbeFetchLike;
}): Promise<ProbeValidation> {
  let res: ProbeFetchResponse;
  try {
    res = await options.fetchFn(OPENROUTER_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildCapabilityProbeRequest(options.modelId, options.profile)),
      redirect: 'error',
      signal: AbortSignal.timeout(CAPABILITY_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: unknown })?.name;
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "transport_error" };
  }

  if (!res.ok) {
    return { ok: false, reason: probeFailureReasonForHttpStatus(res.status) };
  }

  let text: string;
  try {
    text = await readBoundedProbeText(res, CAPABILITY_PROBE_MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof ProbeReadError) return { ok: false, reason: err.probeReason };
    return { ok: false, reason: "transport_error" };
  }
  // An EMPTY body is distinct from malformed JSON and from a malformed completion.
  if (!text || text.trim().length === 0) {
    return { ok: false, reason: "empty_response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  const extracted = completionContent(parsed);
  if (extracted.ok === false) return extracted;
  return validateCapabilityProbeContent(extracted.content);
}

export interface VerifyCapabilityOptions {
  profile?: OpenRouterProfile;
  modelId: string;
  /** Whose credential authorizes the probe. Defaults to server_environment. */
  credentialSource?: CredentialSource;
  /** Test seam: defaults to global fetch. Never a config surface. */
  fetchFn?: CapabilityProbeFetchLike;
  /** Test seam: verification timestamp. */
  now?: number;
}

/**
 * Runs the explicit, zero-cost capability verification for an OpenRouter text
 * model. Enforces the free-pricing gate + exact credential identity BEFORE any
 * provider request. On success, records a fingerprint-bound in-memory
 * verification. Never returns a secret or raw provider error.
 */
export async function verifyOpenRouterModelCapability(
  options: VerifyCapabilityOptions
): Promise<CapabilityVerificationResult> {
  const modelId = typeof options.modelId === "string" ? options.modelId.trim() : "";
  const providerId = CAPABILITY_VERIFICATION_PROVIDER_ID;
  const profile = options.profile ?? STRICT_JSON_SCHEMA_PROFILE;

  const fail = (
    code: CapabilityVerificationErrorCode,
    providerCalled: boolean,
    probeClassification?: ProbeFailureClassification
  ): CapabilityVerificationResult => ({
    ok: false,
    providerId,
    modelId,
    code,
    message: probeClassification ? probeFailureMessage(probeClassification) : boundedMessage(code),
    ...(probeClassification ? { probeClassification } : {}),
    providerCalled,
  });

  // 1. Exact, grammar-validated model id (no arbitrary URL/id surface).
  if (!isValidOpenRouterModelId(modelId)) return fail("INVALID_MODEL", false);
  if (!isOpenRouterProfile(profile)) return fail('INVALID_MODEL', false);

  // 2. Operator policy: a server-managed text pin restricts verification to the
  //    pinned provider/model. An invalid pin fails closed with ZERO provider calls.
  const selection = getTextSelection();
  if (selection.selectionMode === "server_managed") {
    if (!selection.valid || selection.selectedProviderId !== providerId) return fail("OPERATOR_PIN", false);
    if (selection.selectedModelId && selection.selectedModelId !== modelId) return fail("OPERATOR_PIN", false);
  }

  // 3. HARD ZERO-COST GATE — current trusted catalog truth only.
  const snapshot = getOpenRouterCatalogSnapshot();
  const model: OpenRouterCatalogModel | undefined = findOpenRouterCatalogModel(modelId);
  if (!model || !snapshot.textModels.some((m) => m.modelId === modelId)) {
    return fail("MODEL_NOT_FOUND", false);
  }
  // Routers are never promoted (see module docs).
  if (model.isRouter) return fail("MODEL_ROUTER_NOT_SUPPORTED", false);
  if (!snapshot.pricingFresh || !model.pricingVerified) {
    return fail("MODEL_PRICING_UNVERIFIED", false);
  }
  if (model.costClass !== "free" || model.isFree !== true) {
    // A previously verified model that is now non-free is a FREE -> PAID change;
    // an unacknowledged non-free model is simply not verified-free.
    const hadVerification = Boolean(getCapabilityVerification(providerId, modelId));
    return fail(hadVerification ? "MODEL_PRICING_CHANGED" : "MODEL_NOT_VERIFIED_FREE", false);
  }

  // Catalog metadata permits a probe, never execution. Enforce on the server too.
  if (!model.supportedParameters.includes('response_format') ||
    (profile !== APPLICATION_VALIDATED_JSON_PROFILE && !model.supportedParameters.includes('structured_outputs'))) {
    return fail('MODEL_CAPABILITY_UNVERIFIED', false);
  }
  // 4. EXACT credential identity (`openrouter` only). No aliasing / fallback.
  const source: CredentialSource = options.credentialSource ?? "server_environment";
  if (!isCredentialSource(source)) return fail("CREDENTIAL_SOURCE_INVALID", false);
  if (source === "session_only" && !isSessionByokSupportedDeployment()) {
    return fail("SESSION_BYOK_UNAVAILABLE", false);
  }
  const resolved = resolveCredential(providerId, source);
  if ("code" in resolved) {
    return fail(resolved.code, false);
  }

  // 5. The provider probe (the ONLY provider request in this flow).
  const fetchFn = options.fetchFn ?? defaultProbeFetch();
  const fingerprint = openRouterModelFingerprint(model);
  const probe = await runCapabilityProbe({ modelId, profile, credential: resolved.lease.secret, fetchFn });
  if (probe.ok === false) {
    return fail("MODEL_CAPABILITY_UNVERIFIED", true, probeFailureClassification(probe.reason));
  }

  // An in-flight catalog change cannot be promoted by an older successful probe.
  const current = findOpenRouterCatalogModel(modelId);
  if (!current || !getOpenRouterCatalogSnapshot().pricingFresh || !current.pricingVerified ||
      !current.isFree || current.costClass !== 'free' || openRouterModelFingerprint(current) !== fingerprint) {
    return fail('MODEL_PRICING_UNVERIFIED', true);
  }
  // 6. Record the success in server memory, bound to the current fingerprint.
  const verifiedAt = options.now ?? Date.now();
  recordCapabilityVerification({
    profile,
    providerId,
    modelId,
    catalogFingerprint: openRouterModelFingerprint(model),
    probeVersion: CAPABILITY_PROBE_VERSION,
    verifiedAt,
  });

  return {
    ok: true,
    providerId,
    modelId,
    profile,
    verifiedAt,
    providerCalled: true,
  };
}

/** Re-exported for tests/documentation; the profile this probe establishes. */
export { STRICT_JSON_SCHEMA_PROFILE };
