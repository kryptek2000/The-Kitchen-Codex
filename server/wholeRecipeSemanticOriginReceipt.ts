/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-2A.
 * SERVER-AUTHENTICATED WHOLE-RECIPE SEMANTIC-ORIGIN PROOF authority.
 *
 * WHAT THIS CLOSES
 *   Phase 9B-1 shipped a whole-recipe semantic REQUEST boundary and 9B-2Q made
 *   authored quantity model-visible. Neither proves anything about where a
 *   semantic interpretation CAME FROM. Without this module a client could
 *   eventually say "the model told me this food means whole egg", post a
 *   well-formed `nutrition_ai_advanced_interpretation_v1` payload to a semantic
 *   route, and have that assertion treated as model output — when nothing ever
 *   called a provider. This module makes that impossible: a semantic payload
 *   may only influence deterministic matching if THIS server issued a proof for
 *   THAT EXACT payload, for THAT EXACT request/context, under THAT EXACT
 *   provider/model execution.
 *
 * TRUST BOUNDARY — WHAT THE PROOF PROVES
 *   PROVES: "this server issued this exact sanitized semantic interpretation,
 *   for this exact whole-recipe request id and context binding, during this
 *   exact server-owned operation, using this exact actual provider and model."
 *   DOES NOT PROVE: anything about the external provider. This is NOT a provider
 *   signature and NOT a model signature. It is also NOT food identity, NOT FDC
 *   identity, NOT candidate selection, NOT mass or portion authority, NOT
 *   nutrient authority, NOT Apply authorization and NOT persistence
 *   authorization. The HMAC is over OUR server's canonicalization.
 *
 *   A semantic interpretation proven by this module is still INERT DATA. It
 *   becomes food identity only through the deterministic USDA matcher, which
 *   remains the sole food-identity authority. "This came from the model" and
 *   "this is correct" are different claims, and only the first is proven.
 *
 * THIS IS NOT AI-4E
 *   AI-4E authenticates an AI-4C recipe-context proposal wire for the AI-4
 *   review/reconcile flow. This authenticates a whole-recipe AI semantic
 *   interpretation over 9B-1's request. Different payload, different boundary,
 *   different purpose. This module has its own version
 *   (`nutrition_ai_whole_recipe_semantic_origin_receipt_v1`), its own token
 *   prefix (`wsem1`), its own operation-id format (`wsemo1`) and its OWN KEY.
 *   Neither token domain is accepted by the other.
 *
 * THE SECRET
 *   A cryptographically random 256-bit key from `node:crypto`, generated once
 *   when the authority instance is created. It is NEVER derived from the AI-4E
 *   receipt key, from a provider key, from `AI_ENDPOINT_TOKEN`, from a user BYOK
 *   key, from any client-visible value, or from `Math.random`. It never leaves
 *   this process: not into a response, a log, an error message, the client
 *   bundle, or persisted data.
 *
 *   There is deliberately NO key-injection option. A caller-supplied secret is
 *   exactly the shortcut this phase exists to prevent, and "a new authority
 *   cannot verify an old receipt" is proven for free because every authority
 *   generates its own random key.
 *
 * SINGLE PROCESS, BY DESIGN
 *   The key is process-local: a server restart invalidates every outstanding
 *   proof, and proofs issued by one independent instance do not validate on
 *   another. A future multi-instance deployment requires a shared signing
 *   secret or an equivalent shared verification architecture. That is not
 *   implemented here and is not pretended to work.
 *
 * ISSUE-AFTER-SANITIZE, ENFORCED BY CONSTRUCTION
 *   There is no "sign raw output" entry point. BOTH `issue` and `verify` route
 *   the candidate semantic payload through the EXISTING strict sanitizer
 *   (`sanitizeAiAdvancedInterpretationResponse`) with the released
 *   `nutrition_ai_advanced_interpretation_v1` contract, using the target line
 *   refs from the released whole-recipe context as the allowed set. The MAC is
 *   computed over the SANITIZER'S output, never over a caller's objects.
 *
 *   The safe order for Phase 9B-2B is therefore:
 *       raw provider response
 *         -> strict existing sanitizer
 *         -> target/ref reconciliation (any reordering happens HERE)
 *         -> canonical sanitized semantic response
 *         -> origin proof issue
 *   Passing raw provider output to `issue` is not merely discouraged: forbidden
 *   fields are rejected, and anything else is normalized before it can be signed.
 *
 * ORDERING BOUNDARY
 *   The canonical material preserves the EXACT array order the sanitizer
 *   produced and never sorts. Interpretation order can carry meaning, so it is
 *   authenticated rather than canonicalized away. Any reconciliation ordering
 *   must therefore be established BEFORE issuance (see 9B-2B); reordering after
 *   issuance invalidates the proof, which is the intended fail-closed behavior.
 *
 * REPLAY POSTURE
 *   The same exact proof over the same exact material verifies repeatedly, by
 *   design. There is NO TTL, NO nonce store and NO replay cache. Cross-request,
 *   cross-context, cross-provider/model and cross-operation replay all fail
 *   because those components are authenticated. Staleness is handled by the
 *   whole-recipe `context_binding`, not by expiring proofs.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isPlainObject } from '../src/core/nutritionV2/schema.js';
import { canonicalStringify } from '../src/core/nutritionV2/usda/digest.js';
import {
  AI_ADVANCED_CONTRACT_VERSION,
  sanitizeAiAdvancedInterpretationResponse,
  type AiAdvancedIngredientInterpretation,
} from '../src/core/nutritionV2/aiAdvanced.js';
import {
  MAX_WHOLE_RECIPE_REQUEST_ID_LENGTH,
  MAX_WHOLE_RECIPE_TARGET_REF_LENGTH,
  MAX_WHOLE_RECIPE_TARGETS,
  WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
  WHOLE_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../src/core/nutritionV2/aiWholeRecipeInterpretation.js';
import {
  isWholeRecipeSemanticOperationIdShaped,
  MAX_WHOLE_RECIPE_SEMANTIC_EXECUTION_ID_LENGTH,
  WHOLE_RECIPE_SEMANTIC_EXECUTION_ID_SHAPE,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_BYTES,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_CHARS,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_VERSION,
  WHOLE_RECIPE_SEMANTIC_OPERATION_ID_BYTES,
  WHOLE_RECIPE_SEMANTIC_OPERATION_ID_CHARS,
  WHOLE_RECIPE_SEMANTIC_OPERATION_ID_PREFIX,
} from '../src/core/nutritionV2/aiWholeRecipeSemanticOriginReceiptShape.js';

const RECEIPT_PREFIX_WITH_SEPARATOR = `${WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX}.`;

/** The released 9B-1 binding shape: `sha256:` + 64 lowercase hex characters. */
const CONTEXT_BINDING_SHAPE = /^sha256:[0-9a-f]{64}$/;

/** The released whole-recipe binding label, reproduced for material framing only. */
const ORIGIN_MATERIAL_LABEL = 'nutrition_ai_whole_recipe_semantic_origin_material_v1';

// ---------------------------------------------------------------------------
// 1. THE PROOF SUBJECT — what a caller presents to issue and to verify
// ---------------------------------------------------------------------------

/**
 * Everything the proof authenticates.
 *
 * `context` is the RELEASED 9B-1 derived context, not a loose set of ids. Taking
 * the whole context is deliberate: it is the single object that already carries
 * the effective request id, the freshness binding and the authoritative target
 * set, so this module never has to reconstruct or compete with any of them.
 *
 * `interpretations` is the candidate SANITIZED semantic response. The envelope
 * version is supplied by this module and cannot be chosen by the caller, so no
 * caller can ask for a different semantic contract to be proven.
 */
export interface WholeRecipeSemanticOriginSubject {
  readonly context: {
    readonly request_version: string;
    readonly request_id: string;
    readonly context_binding: string;
    readonly provider_context: { readonly targets: ReadonlyArray<{ readonly line_ref: string }> };
  };
  readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  readonly provider_id: string;
  readonly model_id: string;
  readonly operation_id: string;
}

/** The normalized, canonical subject both `issue` and `verify` authenticate. */
export interface CanonicalWholeRecipeSemanticOrigin {
  readonly request_version: string;
  readonly request_id: string;
  readonly context_binding: string;
  readonly contract_version: string;
  readonly interpretations: ReadonlyArray<AiAdvancedIngredientInterpretation>;
  readonly provider_id: string;
  readonly model_id: string;
  readonly operation_id: string;
}

// ---------------------------------------------------------------------------
// 2. RUNTIME GUARDS — types are not runtime security
// ---------------------------------------------------------------------------

/** Sentinel for "this own property does not exist", distinct from an undefined value. */
const ABSENT = Symbol('absent');

/**
 * Reads an OWN DATA property WITHOUT invoking an accessor.
 *
 * `Object.getOwnPropertyDescriptor` does not trigger a getter, so a hostile
 * object carrying an accessor can never execute code on the signing path; it is
 * simply refused. This is the only property-read helper used on untrusted input.
 */
function dataProperty(target: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return ABSENT;
  }
  if (descriptor === undefined) return ABSENT;
  if (!('value' in descriptor)) return ABSENT; // accessor (or non-enumerable data): refuse
  return descriptor.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  return value;
}

function stringList(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry, maxChars);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strictBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Provider / model identity: bounded and drawn from the safe identifier alphabet. */
function executionId(value: unknown): string | null {
  const text = boundedText(value, MAX_WHOLE_RECIPE_SEMANTIC_EXECUTION_ID_LENGTH);
  if (text === null) return null;
  if (!WHOLE_RECIPE_SEMANTIC_EXECUTION_ID_SHAPE.test(text)) return null;
  return text;
}

const SUBJECT_KEYS: ReadonlySet<string> = new Set([
  'context',
  'interpretations',
  'provider_id',
  'model_id',
  'operation_id',
]);

// ---------------------------------------------------------------------------
// 3. THE STRICT CANONICAL READ — one owner, used by issue AND verify
// ---------------------------------------------------------------------------

/**
 * Normalizes an UNTRUSTED subject into the exact canonical material both sides
 * authenticate. Never throws; every failure is a bounded `null`.
 *
 * The semantic payload is routed through the EXISTING strict sanitizer rather
 * than trusted or re-implemented. That is what makes signing raw provider output
 * impossible by accident: forbidden fields, unknown keys, wrong contract
 * versions, malformed targets and oversized strings are all refused here, and
 * anything merely unsanitized is normalized before it can be signed.
 */
function readCanonicalSubject(subject: unknown): CanonicalWholeRecipeSemanticOrigin | null {
  if (!isRecord(subject)) return null;
  try {
    for (const key of Object.keys(subject)) {
      if (!SUBJECT_KEYS.has(key)) return null;
    }

    // --- released whole-recipe context --------------------------------------
    const context = dataProperty(subject, 'context');
    if (context === ABSENT || !isRecord(context)) return null;

    const requestVersion = dataProperty(context, 'request_version');
    if (requestVersion !== WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION) return null;

    const requestId = boundedText(
      dataProperty(context, 'request_id'),
      MAX_WHOLE_RECIPE_REQUEST_ID_LENGTH
    );
    if (requestId === null) return null;

    const contextBinding = dataProperty(context, 'context_binding');
    if (typeof contextBinding !== 'string' || !CONTEXT_BINDING_SHAPE.test(contextBinding)) {
      return null;
    }

    const providerContext = dataProperty(context, 'provider_context');
    if (providerContext === ABSENT || !isRecord(providerContext)) return null;
    if (dataProperty(providerContext, 'provenance_class') !== WHOLE_RECIPE_CONTEXT_PROVENANCE_CLASS) {
      return null;
    }

    const targets = dataProperty(providerContext, 'targets');
    if (!Array.isArray(targets)) return null;
    if (targets.length === 0 || targets.length > MAX_WHOLE_RECIPE_TARGETS) return null;
    const allowedLineRefs: string[] = [];
    for (const target of targets) {
      if (!isRecord(target)) return null;
      const lineRef = boundedText(
        dataProperty(target, 'line_ref'),
        MAX_WHOLE_RECIPE_TARGET_REF_LENGTH
      );
      if (lineRef === null) return null;
      allowedLineRefs.push(lineRef);
    }

    // --- semantic payload, through the EXISTING strict sanitizer --------------
    // The envelope version is supplied here, so a caller cannot choose which
    // semantic contract gets proven.
    const sanitized = sanitizeAiAdvancedInterpretationResponse(
      {
        contract_version: AI_ADVANCED_CONTRACT_VERSION,
        interpretations: dataProperty(subject, 'interpretations'),
      },
      { allowedLineRefs }
    );
    if (!sanitized.ok) return null;
    // A semantic proof with no interpretation proves nothing and is never
    // something 9B-2B should be issuing.
    if (sanitized.interpretations.length === 0) return null;
    // Project once here purely as a RUNTIME SHAPE GATE. The MAC is computed from
    // the same projection inside `wholeRecipeSemanticOriginMaterial`, so a
    // response shape the sanitizer stops guaranteeing is refused here rather
    // than signed as `undefined`. The canonical subject keeps the sanitizer's
    // own typed output, which is what a downstream caller legitimately consumes.
    if (projectInterpretations(sanitized.interpretations) === null) return null;
    const interpretations = sanitized.interpretations;

    // --- execution identity --------------------------------------------------
    const providerId = executionId(dataProperty(subject, 'provider_id'));
    if (providerId === null) return null;
    const modelId = executionId(dataProperty(subject, 'model_id'));
    if (modelId === null) return null;
    const operationId = dataProperty(subject, 'operation_id');
    if (!isWholeRecipeSemanticOperationIdShaped(operationId)) return null;

    return Object.freeze({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      request_id: requestId,
      context_binding: contextBinding,
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: Object.freeze(interpretations),
      provider_id: providerId,
      model_id: modelId,
      operation_id: operationId as string,
    });
  } catch {
    // A hostile proxy or exotic object must never escape as a raw error.
    return null;
  }
}

/**
 * Field-by-field canonical projection of the sanitizer's interpretations.
 *
 * Rebuilt explicitly and never spread, so a future response field cannot be
 * signed implicitly and no caller-supplied key can ride along. Array order is
 * preserved exactly as the sanitizer produced it — ordering is authenticated,
 * never sorted away.
 *
 * This projection re-validates runtime types because the MAC depends on it:
 * a shape the sanitizer stops guaranteeing must fail here rather than sign as
 * `undefined`.
 */
function projectInterpretations(
  entries: ReadonlyArray<AiAdvancedIngredientInterpretation>
): ReadonlyArray<Record<string, unknown>> | null {
  const out: Record<string, unknown>[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) return null;

    const lineRef = boundedText(dataProperty(entry, 'line_ref'), MAX_WHOLE_RECIPE_TARGET_REF_LENGTH);
    if (lineRef === null) return null;

    // --- semantic_food ------------------------------------------------------
    const semanticFood = dataProperty(entry, 'semantic_food');
    if (semanticFood === ABSENT || !isRecord(semanticFood)) return null;
    const normalizedNameRaw = dataProperty(semanticFood, 'normalized_name');
    const normalizedName =
      normalizedNameRaw === ABSENT ? undefined : boundedText(normalizedNameRaw, 120);
    if (normalizedNameRaw !== ABSENT && normalizedName === null) return null;
    const modifiers = stringList(dataProperty(semanticFood, 'modifiers'), 12, 60);
    const preparation = stringList(dataProperty(semanticFood, 'preparation'), 12, 60);
    const state = stringList(dataProperty(semanticFood, 'state'), 12, 60);
    const qualifiers = stringList(dataProperty(semanticFood, 'qualifiers'), 12, 60);
    if (!modifiers || !preparation || !state || !qualifiers) return null;

    // --- search_phrases -----------------------------------------------------
    const searchPhrases = stringList(dataProperty(entry, 'search_phrases'), 4, 120);
    if (!searchPhrases) return null;

    // --- amount_semantics ---------------------------------------------------
    const amount = dataProperty(entry, 'amount_semantics');
    if (amount === ABSENT || !isRecord(amount)) return null;
    const kind = boundedText(dataProperty(amount, 'kind'), 40);
    if (kind === null) return null;
    const amountExtras: Record<string, unknown> = {};
    for (const key of ['range_lower', 'range_upper', 'echoed_value'] as const) {
      const raw = dataProperty(amount, key);
      if (raw === ABSENT) continue;
      const num = finiteNumber(raw);
      if (num === null) return null;
      amountExtras[key] = num;
    }
    const phrasingRaw = dataProperty(amount, 'phrasing');
    if (phrasingRaw !== ABSENT) {
      const phrasing = boundedText(phrasingRaw, 120);
      if (phrasing === null) return null;
      amountExtras['phrasing'] = phrasing;
    }

    // --- unit_semantics -----------------------------------------------------
    const unit = dataProperty(entry, 'unit_semantics');
    if (unit === ABSENT || !isRecord(unit)) return null;
    const family = boundedText(dataProperty(unit, 'family'), 40);
    if (family === null) return null;
    const unitExtras: Record<string, unknown> = {};
    for (const key of ['raw', 'interpreted_unit'] as const) {
      const raw = dataProperty(unit, key);
      if (raw === ABSENT) continue;
      const text = boundedText(raw, 60);
      if (text === null) return null;
      unitExtras[key] = text;
    }

    // --- count_semantics ----------------------------------------------------
    const count = dataProperty(entry, 'count_semantics');
    if (count === ABSENT || !isRecord(count)) return null;
    const countExtras: Record<string, unknown> = {};
    for (const key of ['noun', 'size', 'state'] as const) {
      const raw = dataProperty(count, key);
      if (raw === ABSENT) continue;
      const text = boundedText(raw, 60);
      if (text === null) return null;
      countExtras[key] = text;
    }

    // --- alternatives -------------------------------------------------------
    const alternativesRaw = dataProperty(entry, 'alternatives');
    if (!Array.isArray(alternativesRaw) || alternativesRaw.length > 4) return null;
    const alternatives: Record<string, unknown>[] = [];
    for (const alternative of alternativesRaw) {
      if (!isRecord(alternative)) return null;
      const name = boundedText(dataProperty(alternative, 'normalized_name'), 120);
      if (name === null) return null;
      const notesRaw = dataProperty(alternative, 'notes');
      if (notesRaw === ABSENT) {
        alternatives.push({ normalized_name: name });
        continue;
      }
      const notes = boundedText(notesRaw, 300);
      if (notes === null) return null;
      alternatives.push({ normalized_name: name, notes });
    }

    // --- ambiguity ----------------------------------------------------------
    const ambiguity = dataProperty(entry, 'ambiguity');
    if (ambiguity === ABSENT || !isRecord(ambiguity)) return null;
    const ambiguous = strictBoolean(dataProperty(ambiguity, 'ambiguous'));
    if (ambiguous === null) return null;
    const reasons = stringList(dataProperty(ambiguity, 'reasons'), 6, 60);
    if (!reasons) return null;

    // --- optional confidence / notes ----------------------------------------
    const confidenceRaw = dataProperty(entry, 'confidence');
    let confidence: string | null = null;
    if (confidenceRaw !== ABSENT) {
      confidence = boundedText(confidenceRaw, 20);
      if (confidence === null) return null;
    }
    const notesRaw = dataProperty(entry, 'notes');
    let notes: string | null = null;
    if (notesRaw !== ABSENT) {
      notes = boundedText(notesRaw, 300);
      if (notes === null) return null;
    }

    out.push({
      line_ref: lineRef,
      semantic_food: {
        ...(normalizedName !== undefined ? { normalized_name: normalizedName } : {}),
        modifiers,
        preparation,
        state,
        qualifiers,
      },
      search_phrases: searchPhrases,
      amount_semantics: { kind, ...amountExtras },
      unit_semantics: { family, ...unitExtras },
      count_semantics: { ...countExtras },
      alternatives,
      ambiguity: { ambiguous, reasons },
      ...(confidence !== null ? { confidence } : {}),
      ...(notes !== null ? { notes } : {}),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 4. THE CANONICAL ORIGIN MATERIAL — one builder, used by issue AND verify
// ---------------------------------------------------------------------------

/**
 * The exact authenticated material.
 *
 * Binds, at minimum, the eight required components:
 *   1. the semantic-origin proof/material version
 *   2. the whole-recipe request version
 *   3. the EFFECTIVE request id (the server-materialized value the operation used)
 *   4. the released whole-recipe `context_binding`
 *   5. the canonical sanitized `nutrition_ai_advanced_interpretation_v1` response
 *   6. the ACTUAL provider id
 *   7. the ACTUAL model id
 *   8. the server-owned semantic operation id
 *
 * It deliberately does NOT bind API keys, provider credentials, filesystem or
 * Vault paths, user identity, raw Markdown or arbitrary frontmatter.
 *
 * It also deliberately does NOT re-serialize the whole `provider_context`.
 * The binding already commits to it cryptographically (it is the hashed input
 * of `context_binding`), and duplicating that canonicalization here would create
 * a second owner that could silently drift from 9B-1. `provider_context` is read
 * only to obtain the sanitizer's allowed line refs. This is sound: any change to
 * the interpretations changes the MAC, and a fabricated provider context cannot
 * turn a signed payload into a different one. The 9B-2C route must still derive
 * context server-side rather than trusting a client-submitted context.
 *
 * `canonicalStringify` sorts object keys, so property insertion order here
 * carries no meaning, and array order — which IS meaningful — is preserved.
 */
export function wholeRecipeSemanticOriginMaterial(
  canonical: CanonicalWholeRecipeSemanticOrigin
): unknown {
  // The projection is the ONLY thing that is ever serialized, and it is derived
  // from the canonical read rather than from any caller object. It cannot be
  // `null` for material produced by `readCanonicalSubject`; the throw is a
  // fail-closed backstop, never a signature path.
  const interpretations = projectInterpretations(canonical.interpretations);
  if (interpretations === null) {
    throw new Error('unprojectable_origin_material');
  }
  return {
    material: ORIGIN_MATERIAL_LABEL,
    receipt_version: WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_VERSION,
    request_version: canonical.request_version,
    request_id: canonical.request_id,
    context_binding: canonical.context_binding,
    semantic_response: {
      contract_version: canonical.contract_version,
      interpretations,
    },
    provider_id: canonical.provider_id,
    model_id: canonical.model_id,
    operation_id: canonical.operation_id,
  };
}

// ---------------------------------------------------------------------------
// 5. THE AUTHORITY
// ---------------------------------------------------------------------------

export type WholeRecipeSemanticOriginIssueResult =
  | { readonly ok: true; readonly receipt: string }
  | { readonly ok: false; readonly code: 'invalid_subject' };

export type WholeRecipeSemanticOriginVerifyResult =
  | { readonly ok: true; readonly origin: CanonicalWholeRecipeSemanticOrigin }
  | { readonly ok: false };

export interface WholeRecipeSemanticOriginAuthority {
  /**
   * Issues a proof for an already-sanitized semantic result.
   *
   * Refuses anything the released semantic contract will not accept: the subject
   * is re-read through the strict sanitizer before anything is signed, so a
   * malformed, oversized, forbidden-field or non-canonical payload never yields
   * a receipt.
   */
  issue(subject: unknown): WholeRecipeSemanticOriginIssueResult;
  /**
   * Authenticates a proof against the EXACT submitted subject.
   *
   * Treats every input as hostile: the receipt is shape-checked and length-checked
   * BEFORE any cryptographic work, and the subject is canonicalized through the
   * same strict read before a MAC is compared. Never throws and never
   * distinguishes its failure modes. On success it returns the CANONICAL origin
   * it authenticated, so a caller never forwards raw hostile input downstream.
   */
  verify(receipt: unknown, subject: unknown): WholeRecipeSemanticOriginVerifyResult;
  /** How many proofs this authority has issued. Diagnostics only; never the key. */
  readonly issuedCount: number;
}

/**
 * Parses a proof into its MAC bytes, or `null`.
 *
 * Fails closed on every malformed shape BEFORE any comparison — wrong prefix,
 * wrong length, non-string, invalid base64url, extra segments, whitespace,
 * Unicode lookalikes, truncation — so no parser detail can be inferred from
 * acceptance. An AI-4E (`rctx1`) receipt fails here: the two domains are the same
 * length, so it is the PREFIX that separates them.
 */
function parseReceiptMac(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const expectedLength =
    RECEIPT_PREFIX_WITH_SEPARATOR.length + WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_CHARS;
  if (value.length !== expectedLength) return null;
  if (!value.startsWith(RECEIPT_PREFIX_WITH_SEPARATOR)) return null;
  const encoded = value.slice(RECEIPT_PREFIX_WITH_SEPARATOR.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let mac: Buffer;
  try {
    mac = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (mac.length !== WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_BYTES) return null;
  // `Buffer.from(x, 'base64url')` is lenient about non-canonical trailing bits, so
  // require an EXACT round trip. This rejects every alias encoding of one MAC.
  if (mac.toString('base64url') !== encoded) return null;
  return mac;
}

/**
 * Creates ONE semantic-origin authority for ONE application instance.
 *
 * The secret is generated here and never leaves. No key injection exists by
 * design: two authorities provably hold different keys, which is exactly the
 * restart / multi-instance property that must hold.
 */
export function createWholeRecipeSemanticOriginAuthority(): WholeRecipeSemanticOriginAuthority {
  const secret = randomBytes(32);
  let issued = 0;

  const computeMac = (canonical: CanonicalWholeRecipeSemanticOrigin): Buffer => {
    let serialized: string;
    try {
      serialized = canonicalStringify(wholeRecipeSemanticOriginMaterial(canonical));
    } catch {
      // Unreachable for sanitizer-produced material; refuse rather than sign.
      throw new Error('uncanonicalizable_origin_material');
    }
    return createHmac('sha256', secret).update(serialized, 'utf8').digest();
  };

  return {
    issue(subject: unknown): WholeRecipeSemanticOriginIssueResult {
      // The ONLY path to a receipt. Re-reading through the released sanitizer
      // means even a malformed internal subject cannot be signed.
      const canonical = readCanonicalSubject(subject);
      if (canonical === null) return { ok: false, code: 'invalid_subject' };
      let receipt: string;
      try {
        receipt = `${RECEIPT_PREFIX_WITH_SEPARATOR}${computeMac(canonical).toString('base64url')}`;
      } catch {
        return { ok: false, code: 'invalid_subject' };
      }
      issued += 1;
      return { ok: true, receipt };
    },

    verify(receipt: unknown, subject: unknown): WholeRecipeSemanticOriginVerifyResult {
      const provided = parseReceiptMac(receipt);
      if (provided === null) return { ok: false };
      // The submitted subject is HOSTILE. Canonicalize it with the SAME strict
      // read BEFORE any MAC is computed, so a malformed subject is never
      // authenticated and the compared material is never caller-controlled.
      const canonical = readCanonicalSubject(subject);
      if (canonical === null) return { ok: false };
      let expected: Buffer;
      try {
        expected = computeMac(canonical);
      } catch {
        return { ok: false };
      }
      if (expected.length !== provided.length) return { ok: false };
      // The security boundary is a CONSTANT-TIME comparison, never `===`.
      if (!timingSafeEqual(expected, provided)) return { ok: false };
      return { ok: true, origin: canonical };
    },

    get issuedCount(): number {
      return issued;
    },
  };
}

// ---------------------------------------------------------------------------
// 6. SERVER-OWNED SEMANTIC OPERATION ID
// ---------------------------------------------------------------------------

/**
 * Mints an opaque server-owned semantic operation id.
 *
 * Distinguishes two distinct server semantic executions even when every other
 * input happens to be equal, which is what stops one execution's proof from
 * being replayed as another's. 192 bits from `node:crypto`, bounded and opaque:
 * it embeds no user data, no provider data, no credential and no timestamp.
 *
 * 9B-2B mints this BEFORE provider dispatch and binds it in the proof AFTER
 * successful sanitization, so the proof attests to one specific dispatch.
 */
export function createWholeRecipeSemanticOperationId(): string {
  return `${WHOLE_RECIPE_SEMANTIC_OPERATION_ID_PREFIX}.${randomBytes(
    WHOLE_RECIPE_SEMANTIC_OPERATION_ID_BYTES
  ).toString('base64url')}`;
}