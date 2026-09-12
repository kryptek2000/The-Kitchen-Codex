/**
 * The Kitchen Codex — explicit zero-cost OpenRouter capability verification
 * (v0.8.x).
 *
 * A dynamically discovered OpenRouter text model may become executable ONLY
 * after an EXPLICIT user action proves, at runtime, that it satisfies the EXACT
 * strict JSON-schema contract Kitchen Codex uses. Catalog metadata
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
 *   - `response_format: { type: "json_schema", json_schema: { strict: true, schema } }`
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
export const CAPABILITY_PROBE_MAX_TOKENS = 16;

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
  MODEL_CAPABILITY_UNVERIFIED: "The model did not satisfy the strict structured-output contract.",
};

function boundedMessage(code: CapabilityVerificationErrorCode): string {
  return BOUNDED_MESSAGES[code];
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
export function buildCapabilityProbeRequest(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    messages: [{ role: "user", content: CAPABILITY_PROBE_PROMPT }],
    temperature: 0,
    max_tokens: CAPABILITY_PROBE_MAX_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: CAPABILITY_PROBE_SCHEMA_NAME,
        strict: true,
        schema: CAPABILITY_PROBE_SCHEMA,
      },
    },
    provider: { require_parameters: true },
  };
}

/** Bounded probe failure reasons (never raw provider text). */
export type ProbeFailureReason =
  | "transport_error"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "quota"
  | "unavailable"
  | "http_error"
  | "empty_response"
  | "oversized"
  | "malformed_json"
  | "schema_mismatch";

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
    return { ok: false, reason: "schema_mismatch" };
  }
  const row = parsed as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 1 || keys[0] !== "ok" || row["ok"] !== true) {
    return { ok: false, reason: "schema_mismatch" };
  }
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

/** Reads at most `maxBytes` from a response stream (overflow -> throw). */
async function readBoundedProbeText(res: ProbeFetchResponse, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    throw new Error("Probe response was not readable.");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        try {
          await reader.cancel?.();
        } catch {
          /* best-effort */
        }
        throw new Error("Probe response exceeded the size limit.");
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

function extractMessageContent(parsed: unknown): unknown {
  const body = (parsed ?? {}) as { choices?: unknown };
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = choices[0] as { message?: { content?: unknown } } | undefined;
  return choice?.message?.content;
}

async function runCapabilityProbe(options: {
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
      body: JSON.stringify(buildCapabilityProbeRequest(options.modelId)),
      signal: AbortSignal.timeout(CAPABILITY_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: unknown })?.name;
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "transport_error" };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
    if (res.status === 429) return { ok: false, reason: "rate_limit" };
    if (res.status === 402) return { ok: false, reason: "quota" };
    if (res.status >= 500) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "http_error" };
  }

  let text: string;
  try {
    text = await readBoundedProbeText(res, CAPABILITY_PROBE_MAX_RESPONSE_BYTES);
  } catch {
    return { ok: false, reason: "oversized" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  return validateCapabilityProbeContent(extractMessageContent(parsed));
}

export interface VerifyCapabilityOptions {
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

  const fail = (
    code: CapabilityVerificationErrorCode,
    providerCalled: boolean
  ): CapabilityVerificationResult => ({
    ok: false,
    providerId,
    modelId,
    code,
    message: boundedMessage(code),
    providerCalled,
  });

  // 1. Exact, grammar-validated model id (no arbitrary URL/id surface).
  if (!isValidOpenRouterModelId(modelId)) return fail("INVALID_MODEL", false);

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
  const probe = await runCapabilityProbe({ modelId, credential: resolved.lease.secret, fetchFn });
  if (!probe.ok) return fail("MODEL_CAPABILITY_UNVERIFIED", true);

  // 6. Record the success in server memory, bound to the current fingerprint.
  const verifiedAt = options.now ?? Date.now();
  recordCapabilityVerification({
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
    profile: STRICT_JSON_SCHEMA_PROFILE,
    verifiedAt,
    providerCalled: true,
  };
}

/** Re-exported for tests/documentation; the profile this probe establishes. */
export { STRICT_JSON_SCHEMA_PROFILE };
