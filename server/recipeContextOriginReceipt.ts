/**
 * The Kitchen Codex — Advanced Nutrition AI-4E: SERVER-AUTHENTICATED AI-4C ORIGIN
 * RECEIPT authority.
 *
 * WHAT THIS CLOSES
 *   AI-4D2's audit (I-1) found that the AI-4 context binding proves freshness and
 *   the request id proves correlation, but NEITHER proves the proposal actually came
 *   through the authorized AI-4C provider execution path. A knowledgeable
 *   authenticated caller could reproduce the deterministic binding, choose a request
 *   id, fabricate a contract-valid proposal and post a plausible-looking AI-4C wire
 *   straight to reconciliation. This module makes that impossible for the PUBLIC
 *   reconciliation flow: a wire only survives the origin gate if THIS server issued
 *   it after the authorized AI-4C path succeeded.
 *
 * TRUST BOUNDARY — WHAT THE RECEIPT PROVES
 *   PROVES: "this exact wire was issued by this server's authorized AI-4C execution
 *   path, after provider bounds, the AI-4A proposal sanitizer, line-ref validation,
 *   relation-graph validation and the canonical wire rebuild all accepted it."
 *   DOES NOT PROVE: anything about the external provider. This is NOT a provider
 *   signature, NOT a model signature and NOT nutrition provenance. The HMAC is over
 *   OUR server's canonicalization of the wire.
 *
 * THE SECRET
 *   A cryptographically random 256-bit key from `node:crypto`, generated once when
 *   the authority instance is created. It is NEVER: derived from a provider key,
 *   from `AI_ENDPOINT_TOKEN`, from a user BYOK key, from any client-visible value,
 *   from `Math.random`, or from an unkeyed hash. It never leaves this process: not
 *   into a response, a log, an error message, the client bundle, or persisted data.
 *
 *   The access token authenticates the CALLER. This key authenticates SERVER ORIGIN.
 *   Those are different trust boundaries and are deliberately not the same secret.
 *
 * SINGLE PROCESS, BY DESIGN
 *   `createApp()` creates exactly ONE authority instance and both routes share it,
 *   so there is no second signing or verifying implementation to drift. The key is
 *   process-local by design: a server restart invalidates every outstanding receipt,
 *   which is exactly the session-only lifetime AI-4D2's review session already has.
 *   See the AI-4E architecture note for the multi-instance limitation.
 *
 * ONE CANONICALIZATION OWNER
 *   `recipeContextOriginReceiptPayload` is the single builder used by BOTH `issue`
 *   and `verify`. It rebuilds the wire FIELD-BY-FIELD from the closed wire contract
 *   and never spreads a caller object, so a future wire property cannot be signed
 *   implicitly and no caller-supplied key can ride along. Array order is preserved,
 *   because model-output order IS part of the canonical wire semantics.
 *
 * KEPT PURE ELSEWHERE
 *   AI-4D1 (`aiRecipeContextReconcile.ts`) and the server reconcile adapter
 *   (`recipeContextReconcile.ts`) contain NO cryptography and NO secret material.
 *   Origin authentication happens here, at the server boundary, BEFORE the public
 *   reconcile flow enters D1.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isPlainObject } from '../src/core/nutritionV2/schema.js';
import { canonicalStringify } from '../src/core/nutritionV2/usda/digest.js';
import {
  readAiRecipeContextWirePayload,
  type AiRecipeContextWireInterpretation,
  type AiRecipeContextWirePayload,
  type AiRecipeContextWireRelation,
} from '../src/core/nutritionV2/aiRecipeContextWire.js';
import {
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_BYTES,
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_CHARS,
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX,
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION,
} from '../src/core/nutritionV2/aiRecipeContextOriginReceiptShape.js';

const RECEIPT_PREFIX_WITH_SEPARATOR = `${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.`;

/** Strict base64url alphabet, mirroring the shared format module. */
const BASE64URL_SHAPE = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// 1. THE SIGNED PAYLOAD — one builder, used by issue AND verify
// ---------------------------------------------------------------------------

/**
 * The canonical signed payload for a wire.
 *
 * Field-by-field rebuild from the closed wire contract. It binds the receipt
 * version, the AI-4 request version, the request id, the context binding and the
 * COMPLETE canonical proposal: contract version, provenance class, and every
 * interpretation with its line ref, role, relations (kind AND target), preparation
 * hints, confidence, abstain reason and explanation.
 *
 * Signing only `request_id + context_binding` is deliberately NOT done: that would
 * leave the proposal replaceable. Signing a caller-supplied digest is also not done:
 * the server builds this payload itself from the validated wire.
 *
 * Optional fields are included only when present, so "absent" is canonical and a
 * `null` can never be confused with an omitted field. `canonicalStringify` sorts
 * keys, so property order here carries no meaning and no `undefined` can appear.
 *
 * REQUIRES A CANONICAL WIRE. The authority always supplies one, because `issue` and
 * `verify` both strict-read through the released wire contract first. A caller that
 * hands this function a raw payload bypasses the contract's normalization (a
 * `confidence: null` would sign as `null` rather than as absent), so the canonical
 * read is not optional in the authority and must not be skipped anywhere else.
 */
export function recipeContextOriginReceiptPayload(wire: AiRecipeContextWirePayload): unknown {
  const interpretations = wire.proposal.interpretations.map(
    (entry: AiRecipeContextWireInterpretation) => {
      const relations = entry.relations.map((relation: AiRecipeContextWireRelation) => ({
        kind: relation.kind,
        target_ref: relation.target_ref,
      }));
      return {
        line_ref: entry.line_ref,
        role: entry.role,
        relations,
        preparation_hints: [...entry.preparation_hints],
        ...(entry.confidence === undefined ? {} : { confidence: entry.confidence }),
        ...(entry.abstain_reason === undefined ? {} : { abstain_reason: entry.abstain_reason }),
        ...(entry.explanation === undefined ? {} : { explanation: entry.explanation }),
      };
    }
  );

  return {
    receipt_version: AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION,
    request_version: wire.request_version,
    request_id: wire.request_id,
    context_binding: wire.context_binding,
    proposal: {
      contract_version: wire.proposal.contract_version,
      provenance_class: wire.proposal.provenance_class,
      interpretations,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. THE AUTHORITY
// ---------------------------------------------------------------------------

export type RecipeContextOriginIssueResult =
  | { readonly ok: true; readonly receipt: string }
  | { readonly ok: false; readonly code: 'invalid_wire' };

export type RecipeContextOriginVerifyResult =
  | { readonly ok: true; readonly wire: AiRecipeContextWirePayload }
  | { readonly ok: false };

export interface RecipeContextOriginReceiptAuthority {
  /** Signs a canonical wire. Refuses anything the wire contract will not accept. */
  issue(wire: unknown): RecipeContextOriginIssueResult;
  /**
   * Authenticates a receipt against the EXACT submitted wire.
   *
   * Never throws and never distinguishes its failure modes: a malformed receipt, a
   * receipt for a different wire and a receipt from another authority all return
   * `{ ok: false }`. On success it returns the CANONICAL wire it authenticated, so
   * the caller never has to forward the raw hostile payload downstream.
   */
  verify(receipt: unknown, wire: unknown): RecipeContextOriginVerifyResult;
  /** How many receipts this authority has issued. Diagnostics only; never the key. */
  readonly issuedCount: number;
}

/**
 * Parses a receipt into its MAC bytes, or `null`. Fails closed on every malformed
 * shape BEFORE any comparison, so no parser detail can be inferred from acceptance.
 */
function parseReceiptMac(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const expectedLength =
    RECEIPT_PREFIX_WITH_SEPARATOR.length + AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_CHARS;
  if (value.length !== expectedLength) return null;
  if (!value.startsWith(RECEIPT_PREFIX_WITH_SEPARATOR)) return null;
  const encoded = value.slice(RECEIPT_PREFIX_WITH_SEPARATOR.length);
  if (!BASE64URL_SHAPE.test(encoded)) return null;
  let mac: Buffer;
  try {
    mac = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (mac.length !== AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_BYTES) return null;
  // `Buffer.from(x, 'base64url')` is lenient about non-canonical trailing bits, so
  // require an EXACT round trip. This rejects every alias encoding of one MAC.
  if (mac.toString('base64url') !== encoded) return null;
  return mac;
}

/**
 * Creates ONE receipt authority for ONE application instance.
 *
 * The secret is generated here and never leaves. There is deliberately no option to
 * inject a key: a caller-supplied secret is exactly the shortcut this phase exists
 * to prevent, and the "a new authority cannot verify an old receipt" property is
 * proven for free because every authority gets its own random key.
 */
export function createRecipeContextOriginReceiptAuthority(): RecipeContextOriginReceiptAuthority {
  const secret = randomBytes(32);
  let issued = 0;

  const computeMac = (wire: AiRecipeContextWirePayload): Buffer =>
    createHmac('sha256', secret)
      .update(canonicalStringify(recipeContextOriginReceiptPayload(wire)), 'utf8')
      .digest();

  return {
    issue(wire: unknown): RecipeContextOriginIssueResult {
      // Issuance is only ever called from the AI-4C route, AFTER provider bounds,
      // the AI-4A proposal sanitizer, line-ref validation, relation-graph validation
      // and the canonical wire rebuild. Re-reading through the RELEASED wire
      // contract here means even a malformed internal wire cannot be signed.
      const read = readAiRecipeContextWirePayload(wire);
      if (!read.ok) return { ok: false, code: 'invalid_wire' };
      const receipt = `${RECEIPT_PREFIX_WITH_SEPARATOR}${computeMac(read.payload).toString('base64url')}`;
      issued += 1;
      return { ok: true, receipt };
    },

    verify(receipt: unknown, wire: unknown): RecipeContextOriginVerifyResult {
      const provided = parseReceiptMac(receipt);
      if (provided === null) return { ok: false };
      // The submitted wire is HOSTILE. Materialize it safely and strict-read it with
      // the released contract BEFORE any MAC is computed: a malformed wire is never
      // authenticated, and the canonical payload is built from the canonical read,
      // never from the caller's own objects.
      const read = readAiRecipeContextWirePayload(wire);
      if (!read.ok) return { ok: false };
      const expected = computeMac(read.payload);
      if (expected.length !== provided.length) return { ok: false };
      // The security boundary is a CONSTANT-TIME comparison, never `===`.
      if (!timingSafeEqual(expected, provided)) return { ok: false };
      return { ok: true, wire: read.payload };
    },

    get issuedCount(): number {
      return issued;
    },
  };
}

// ---------------------------------------------------------------------------
// 3. THE PUBLIC ORIGIN ENVELOPE
// ---------------------------------------------------------------------------

/**
 * Closed keys of the PUBLIC reconcile request. This is the existing D1 body plus
 * the one new transport-authentication field.
 *
 * A `context`/`envelope`/`binding`/`line_refs` key is still refused by name, exactly
 * as before. The receipt is a SIBLING of `wire`, never a member of it, so the
 * released AI-4C wire contract and the AI-4A proposal contract are unchanged.
 */
const ORIGIN_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'wire',
  'expected_request_id',
  'recipe',
  'instructions',
  'recipe_instance',
  'origin_receipt',
]);

export type RecipeContextOriginEnvelopeFailureCode = 'invalid_input' | 'origin_unverified';

export type RecipeContextOriginEnvelopeResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly code: RecipeContextOriginEnvelopeFailureCode };

/**
 * The origin gate: closed-key validation, receipt verification, and a field-by-field
 * REBUILD of the existing D1 reconcile body.
 *
 * The receipt is consumed HERE and never flows downward, so `recipeContextReconcile`
 * keeps its exact closed five-key request shape and its pure, offline, provider-free
 * contract. `origin_receipt` contains no `binding` or `version` substring, so it is
 * compatible with that adapter's key-set guarantees.
 */
export function readRecipeContextOriginEnvelope(
  rawBody: unknown,
  authority: RecipeContextOriginReceiptAuthority
): RecipeContextOriginEnvelopeResult {
  if (!isPlainObject(rawBody)) return { ok: false, code: 'invalid_input' };
  for (const key of Object.keys(rawBody)) {
    if (!ORIGIN_ENVELOPE_KEYS.has(key)) return { ok: false, code: 'invalid_input' };
  }
  if (!('wire' in rawBody) || !('recipe' in rawBody)) {
    return { ok: false, code: 'invalid_input' };
  }
  const expectedRequestId = rawBody['expected_request_id'];
  if (typeof expectedRequestId !== 'string' || expectedRequestId.trim().length === 0) {
    return { ok: false, code: 'invalid_input' };
  }

  // ORIGIN AUTHENTICATION. A missing receipt and an invalid receipt are the SAME
  // public failure: a caller learns nothing about which, and neither reveals a MAC,
  // a secret, a payload or a parser detail.
  if (!('origin_receipt' in rawBody)) return { ok: false, code: 'origin_unverified' };
  const origin = authority.verify(rawBody['origin_receipt'], rawBody['wire']);
  if (!origin.ok) return { ok: false, code: 'origin_unverified' };

  // Field-by-field rebuild of the EXISTING D1 body. The receipt is dropped here, and
  // the wire handed to D1 is the CANONICAL wire the authority authenticated rather
  // than the raw hostile payload.
  const body: Record<string, unknown> = {
    wire: origin.wire,
    expected_request_id: expectedRequestId,
    recipe: rawBody['recipe'],
  };
  if ('instructions' in rawBody) body['instructions'] = rawBody['instructions'];
  if ('recipe_instance' in rawBody) body['recipe_instance'] = rawBody['recipe_instance'];
  return { ok: true, body };
}