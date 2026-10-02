/**
 * The Kitchen Codex — Advanced Nutrition AI-4E: AI-4C ORIGIN RECEIPT FORMAT.
 *
 * PURE, platform-neutral, crypto-free, server-agnostic. This module is the ONE
 * definition of the receipt's WIRE FORMAT: the closed receipt version, the closed
 * token prefix, the fixed MAC width and a bounded shape check.
 *
 * WHY THE FORMAT IS SEPARATE FROM THE AUTHORITY
 *   The HMAC key and the signing/verification logic are SERVER-ONLY. Only the
 *   *shape* of the token is shared, so the client can bound-check and transport a
 *   receipt it can never verify. A single shared format definition means the
 *   client cannot drift from the parser the server actually enforces.
 *
 * WHAT A RECEIPT IS NOT
 *   This format proves nothing by itself. It is an opaque, versioned, fixed-length
 *   carrier for a server-computed MAC. It is NOT a provider signature, NOT a model
 *   signature, NOT nutrition provenance, NOT persistence authority and NOT
 *   permission for downstream consumption. `ai_recipe_context` remains
 *   NON-AUTHENTICATED NUTRITION PROVENANCE.
 *
 * OPAQUE BY CONSTRUCTION
 *   The token carries a prefix and a MAC and nothing else: no JSON, no signed
 *   payload, no key, no request id, no recipe text, no path. A holder learns
 *   nothing from it beyond "this server issued a receipt of this shape".
 */

/**
 * The ONE closed receipt version. It PARTICIPATES IN THE SIGNED PAYLOAD, so a
 * change to the payload shape requires a new version: an old receipt can never be
 * silently reinterpreted as a new one.
 */
export const AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION =
  'nutrition_ai_recipe_context_origin_receipt_v1';

/** The closed transport prefix. `rctx1` = recipe context, origin receipt, v1. */
export const AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX = 'rctx1';

/** The MAC width in bytes. HMAC-SHA-256 is exactly 32 bytes. */
export const AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_BYTES = 32;

/** Unpadded base64url of 32 bytes: 43 characters. */
export const AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_CHARS = 43;

/**
 * The exact, FIXED receipt length: `rctx1` + `.` + 43 base64url characters.
 *
 * A fixed length is part of the security argument: it makes the token unbufferable,
 * so no truncation, extension or trailing-data trick can survive the parser.
 */
export const AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_LENGTH =
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX.length + 1 + AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_CHARS;

/** Strict base64url alphabet: no `+`, `/`, `=` or any other character. */
const BASE64URL_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * Bounded shape check, safe to run on ANY surface.
 *
 * This is deliberately NOT verification: it proves nothing about origin and can be
 * satisfied by any string of the right shape. It exists so the client can refuse
 * an obviously malformed receipt before spending a request, and so no unbounded
 * caller-supplied string is ever forwarded to the server.
 */
export function isAiRecipeContextOriginReceiptShaped(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length !== AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_LENGTH) return false;
  const prefix = `${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.`;
  if (!value.startsWith(prefix)) return false;
  const mac = value.slice(prefix.length);
  return mac.length === AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_CHARS && BASE64URL_SHAPE.test(mac);
}