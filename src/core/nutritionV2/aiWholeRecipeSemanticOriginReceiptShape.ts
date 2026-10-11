/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-2A.
 * WHOLE-RECIPE SEMANTIC-ORIGIN PROOF FORMAT.
 *
 * PURE, PLATFORM-NEUTRAL, CRYPTO-FREE, SERVER-AGNOSTIC. This module is the ONE
 * definition of the semantic-origin proof's WIRE FORMAT: the closed proof
 * version, the closed token prefix, the fixed MAC width, a bounded shape check,
 * and the opaque server-operation-id format.
 *
 * WHY THIS IS A DISTINCT CONTRACT FROM AI-4E
 *   AI-4E (`aiRecipeContextOriginReceiptShape.ts`) authenticates an AI-4C
 *   RECIPE-CONTEXT PROPOSAL wire for the AI-4 review/reconcile flow. Phase 9B-2A
 *   authenticates a WHOLE-RECIPE AI SEMANTIC INTERPRETATION for a different
 *   architectural boundary: a provider execution over 9B-1's whole-recipe
 *   request. Reusing the AI-4E wire would mislabel the evidence, so this module
 *   has its OWN version string, its OWN token prefix, its OWN key domain and its
 *   OWN operation-id format. The two never interoperate in either direction.
 *
 * WHY THE FORMAT IS SEPARATE FROM THE AUTHORITY
 *   The HMAC key and the signing/verification logic are SERVER-ONLY. Only the
 *   *shape* of the token is shared, so a client can bound-check and transport a
 *   proof it can never verify. One shared format definition means the client
 *   cannot drift from the parser the server actually enforces.
 *
 * WHAT A SEMANTIC-ORIGIN PROOF IS NOT
 *   This format proves nothing by itself. It is an opaque, versioned,
 *   fixed-length carrier for a server-computed MAC. It is NOT a provider
 *   signature, NOT a model signature, NOT food-identity or FDC authority, NOT
 *   nutrition provenance, NOT mass/nutrient authority, and NOT permission for
 *   deterministic matching, Apply or persistence. A semantic interpretation
 *   remains INERT until the deterministic USDA matcher resolves it, and the
 *   deterministic matcher remains the sole food-identity authority.
 *
 * OPAQUE BY CONSTRUCTION
 *   The token carries a prefix and a MAC and nothing else: no JSON, no signed
 *   payload, no key, no request id, no recipe text, no provider, no model, no
 *   path. A holder learns nothing from it beyond "this server issued a proof of
 *   this shape".
 */

// ---------------------------------------------------------------------------
// 1. Proof version + token format
// ---------------------------------------------------------------------------

/**
 * The ONE closed semantic-origin proof version. It PARTICIPATES IN THE SIGNED
 * MATERIAL, so a change to the authenticated material shape requires a new
 * version: an old proof can never be silently reinterpreted as a new one.
 */
export const WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_VERSION =
  'nutrition_ai_whole_recipe_semantic_origin_receipt_v1';

/**
 * The closed transport prefix. `wsem1` = whole recipe semantic, origin, v1.
 *
 * Deliberately distinct from AI-4E's `rctx1`. Note that both prefixes are 5
 * characters, so a semantic-origin token and an AI-4E token are the SAME
 * LENGTH: the prefix, not the length, is what separates the two domains.
 */
export const WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX = 'wsem1';

/** The MAC width in bytes. HMAC-SHA-256 is exactly 32 bytes. */
export const WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_BYTES = 32;

/** Unpadded base64url of 32 bytes: 43 characters. */
export const WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_CHARS = 43;

/**
 * The exact, FIXED proof length: `wsem1` + `.` + 43 base64url characters.
 *
 * A fixed length is part of the security argument: it makes the token
 * unbufferable, so no truncation, extension or trailing-data trick can survive
 * the parser.
 */
export const WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_LENGTH =
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX.length +
  1 +
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_CHARS;

/** Strict base64url alphabet: no `+`, `/`, `=` or any other character. */
const BASE64URL_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * Bounded shape check, safe to run on ANY surface.
 *
 * This is deliberately NOT verification: it proves nothing about origin and can
 * be satisfied by any string of the right shape. It exists so a client can
 * refuse an obviously malformed proof before spending a request, and so no
 * unbounded caller-supplied string is ever forwarded to the server.
 */
export function isWholeRecipeSemanticOriginReceiptShaped(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length !== WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_LENGTH) return false;
  const prefix = `${WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX}.`;
  if (!value.startsWith(prefix)) return false;
  const mac = value.slice(prefix.length);
  return mac.length === WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_CHARS && BASE64URL_SHAPE.test(mac);
}

// ---------------------------------------------------------------------------
// 2. Server-owned semantic operation id format
// ---------------------------------------------------------------------------

/**
 * The closed operation-id prefix. `wsemo1` = whole recipe semantic operation, v1.
 *
 * An operation id distinguishes two distinct server semantic executions even
 * when every other input happens to be equal. It is OPAQUE and carries no user
 * data, no provider credential data and no timestamp.
 */
export const WHOLE_RECIPE_SEMANTIC_OPERATION_ID_PREFIX = 'wsemo1';

/** Random bytes behind an operation id: 192 bits of `randomBytes`. */
export const WHOLE_RECIPE_SEMANTIC_OPERATION_ID_BYTES = 24;

/** Unpadded base64url of 24 bytes: 32 characters. */
export const WHOLE_RECIPE_SEMANTIC_OPERATION_ID_CHARS = 32;

/** The exact, FIXED operation-id length: `wsemo1` + `.` + 32 characters. */
export const WHOLE_RECIPE_SEMANTIC_OPERATION_ID_LENGTH =
  WHOLE_RECIPE_SEMANTIC_OPERATION_ID_PREFIX.length + 1 + WHOLE_RECIPE_SEMANTIC_OPERATION_ID_CHARS;

/**
 * Bounded shape check for a server-issued semantic operation id.
 *
 * This is a FORMAT check only. It proves no operation ever happened; the proof
 * over the authenticated material is what carries authority. A caller-supplied
 * string of the right shape is still only a candidate operation id.
 */
export function isWholeRecipeSemanticOperationIdShaped(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length !== WHOLE_RECIPE_SEMANTIC_OPERATION_ID_LENGTH) return false;
  const prefix = `${WHOLE_RECIPE_SEMANTIC_OPERATION_ID_PREFIX}.`;
  if (!value.startsWith(prefix)) return false;
  const random = value.slice(prefix.length);
  return (
    random.length === WHOLE_RECIPE_SEMANTIC_OPERATION_ID_CHARS && BASE64URL_SHAPE.test(random)
  );
}

// ---------------------------------------------------------------------------
// 3. Execution-identity bounds (shared by the authority and any surface)
// ---------------------------------------------------------------------------

/** Bound on the ACTUAL provider id and model id bound into the proof. */
export const MAX_WHOLE_RECIPE_SEMANTIC_EXECUTION_ID_LENGTH = 120;

/**
 * Safe identifier alphabet for provider and model ids.
 *
 * Deliberately excludes whitespace, control characters and separators that could
 * make an execution identity ambiguous inside the canonical material.
 */
export const WHOLE_RECIPE_SEMANTIC_EXECUTION_ID_SHAPE = /^[A-Za-z0-9._:@/-]+$/;