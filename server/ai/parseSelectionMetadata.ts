/**
 * The Kitchen Codex — selection metadata header parser (BYOK-4).
 *
 * Parses the per-request, NON-SECRET selection metadata from HTTP headers
 * (`x-kitchen-ai-text-selection` / `x-kitchen-ai-image-selection`) sent by the
 * client into a STRICT, DISCRIMINATED intent:
 *
 *   ABSENT            — no header (normal server_default behavior)
 *   EXPLICIT_DEFAULT  — the client explicitly reset this surface to server default
 *   EXPLICIT_SELECTED — a well-formed provider(/model) selection attempt
 *   INVALID           — a PRESENT but malformed/incoherent payload
 *
 * SECURITY / TRUST:
 *   - A present-but-malformed payload is NEVER silently normalized to ABSENT or
 *     EXPLICIT_DEFAULT. Doing so would let a corrupted/stale client fall through
 *     to the server-default paid-provider chain. Instead it becomes INVALID and
 *     the resolver FAILS CLOSED (text -> deterministic fallback; image -> a
 *     bounded no-provider failure). ZERO paid provider calls execute.
 *   - Malformed identifiers are REJECTED, never truncated into a valid-looking id.
 *   - Header values are bounded (length ceiling) BEFORE JSON parse.
 *   - An array-valued (duplicate) header is malformed for this use -> INVALID.
 *   - No secret, key, token, or raw provider text ever crosses this surface.
 *
 * LEGACY DECISION (documented): a PROVIDER-ONLY selection (providerId with no
 * modelId) is RETAINED as supported legacy behavior and validated explicitly by
 * the resolver (the provider must be registered/enabled/available and any model
 * must be curated). A MODEL-ONLY selection (modelId without providerId) is
 * INVALID — a model id is meaningless without its provider.
 */

import type { SelectedOperationMetadata } from "./effectiveSelection.js";

/** Maximum allowed header value length (bytes) to bound parse cost. */
const MAX_HEADER_LENGTH = 1024;

/** Maximum length for a single string field within the header payload. */
const MAX_FIELD_LENGTH = 128;

const TEXT_SELECTION_HEADER = "x-kitchen-ai-text-selection";
const IMAGE_SELECTION_HEADER = "x-kitchen-ai-image-selection";

/** Why a present selection payload was rejected. */
export type SelectionInvalidReason =
  | "duplicate_header"
  | "oversized"
  | "malformed_json"
  | "malformed_payload"
  | "empty_payload"
  | "invalid_mode"
  | "model_only"
  | "missing_provider"
  | "empty_provider"
  | "empty_model"
  | "default_with_ids"
  | "malformed_field";

/** The strict, discriminated selection intent. */
export type SelectionIntent =
  | { kind: "ABSENT" }
  | { kind: "EXPLICIT_DEFAULT" }
  | { kind: "EXPLICIT_SELECTED"; providerId: string; modelId?: string }
  | { kind: "INVALID"; reason: SelectionInvalidReason };

/**
 * A minimal abstraction over the HTTP request headers for testability.
 * Matches Express `req.headers` shape (lowercased keys, string | string[]).
 */
export interface SelectionHeaderSource {
  [key: string]: string | string[] | undefined;
}

/**
 * Parses and bounds one raw header value into a strict `SelectionIntent`.
 *
 * ONLY a truly absent header yields ABSENT. Any PRESENT header (even `{}`,
 * `{"providerId":""}`, or `{"mode":"server_default","providerId":""}`) is
 * validated explicitly and resolves to EXPLICIT_DEFAULT / EXPLICIT_SELECTED /
 * INVALID — never ABSENT merely because fields normalize empty.
 */
function parseSelectionHeader(raw: string | string[] | undefined): SelectionIntent {
  if (raw === undefined) return { kind: "ABSENT" };
  // A duplicate (array-valued) header is malformed for this single-value surface.
  if (Array.isArray(raw)) return { kind: "INVALID", reason: "duplicate_header" };
  // A present but empty header value is a malformed present payload.
  if (typeof raw !== "string" || raw.length === 0) return { kind: "INVALID", reason: "malformed_payload" };
  if (raw.length > MAX_HEADER_LENGTH) return { kind: "INVALID", reason: "oversized" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "INVALID", reason: "malformed_json" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "INVALID", reason: "malformed_payload" };
  }

  const row = parsed as Record<string, unknown>;

  // Mode: absent, `user_selected`, or `server_default`. Any other present value
  // (including a non-string) is an explicit invalid intent.
  const rawMode = row["mode"];
  if (rawMode !== undefined && rawMode !== "user_selected" && rawMode !== "server_default") {
    return { kind: "INVALID", reason: "invalid_mode" };
  }
  const mode = rawMode as "user_selected" | "server_default" | undefined;

  // Field PRESENCE (even with an empty value) is meaningful: a present field of
  // the wrong type is malformed and is never coerced.
  const providerPresent = Object.prototype.hasOwnProperty.call(row, "providerId");
  const modelPresent = Object.prototype.hasOwnProperty.call(row, "modelId");
  if (providerPresent && typeof row["providerId"] !== "string") {
    return { kind: "INVALID", reason: "malformed_field" };
  }
  if (modelPresent && typeof row["modelId"] !== "string") {
    return { kind: "INVALID", reason: "malformed_field" };
  }

  const providerId = typeof row["providerId"] === "string" ? row["providerId"].trim() : "";
  const modelId = typeof row["modelId"] === "string" ? row["modelId"].trim() : "";

  // Explicit server_default MUST NOT carry provider/model ids — even empty ones.
  if (mode === "server_default") {
    if (providerPresent || modelPresent) return { kind: "INVALID", reason: "default_with_ids" };
    return { kind: "EXPLICIT_DEFAULT" };
  }

  // Reject oversized identifiers — NEVER truncate a malformed id into a valid one.
  if (providerId.length > MAX_FIELD_LENGTH || modelId.length > MAX_FIELD_LENGTH) {
    return { kind: "INVALID", reason: "oversized" };
  }

  // No provider id:
  //   - a present modelId is a model-only selection -> INVALID
  //   - user_selected with no provider -> INVALID
  //   - an entirely empty present payload -> INVALID (never ABSENT)
  if (!providerPresent) {
    if (modelPresent) return { kind: "INVALID", reason: "model_only" };
    if (mode === "user_selected") return { kind: "INVALID", reason: "missing_provider" };
    return { kind: "INVALID", reason: "empty_payload" };
  }

  // Provider id present but empty.
  if (!providerId) return { kind: "INVALID", reason: "empty_provider" };
  // Model id present but empty is a malformed present field.
  if (modelPresent && !modelId) return { kind: "INVALID", reason: "empty_model" };

  return modelId
    ? { kind: "EXPLICIT_SELECTED", providerId, modelId }
    : { kind: "EXPLICIT_SELECTED", providerId };
}

function headerValue(headers: SelectionHeaderSource, name: string): string | string[] | undefined {
  return headers[name];
}

/** Parses the TEXT selection header into a strict `SelectionIntent`. */
export function parseTextSelectionHeader(headers: SelectionHeaderSource): SelectionIntent {
  return parseSelectionHeader(headerValue(headers, TEXT_SELECTION_HEADER));
}

/** Parses the IMAGE selection header into a strict `SelectionIntent`. */
export function parseImageSelectionHeader(headers: SelectionHeaderSource): SelectionIntent {
  return parseSelectionHeader(headerValue(headers, IMAGE_SELECTION_HEADER));
}

/** True when the intent represents an explicit user selection attempt (valid or not). */
export function isExplicitSelectionIntent(intent: SelectionIntent): boolean {
  return intent.kind === "EXPLICIT_SELECTED" || intent.kind === "INVALID";
}

/** Converts a valid selected intent into the bounded resolver metadata shape. */
export function selectionIntentToMetadata(intent: SelectionIntent): SelectedOperationMetadata | undefined {
  if (intent.kind !== "EXPLICIT_SELECTED") return undefined;
  const out: SelectedOperationMetadata = { mode: "user_selected", providerId: intent.providerId };
  if (intent.modelId) out.modelId = intent.modelId;
  return out;
}

/** Exported header names for documentation and testing. */
export const SELECTION_HEADER_NAMES = {
  text: TEXT_SELECTION_HEADER,
  image: IMAGE_SELECTION_HEADER,
} as const;

/** Exported bounds for documentation and testing. */
export const SELECTION_HEADER_BOUNDS = {
  maxHeaderLength: MAX_HEADER_LENGTH,
  maxFieldLength: MAX_FIELD_LENGTH,
} as const;
