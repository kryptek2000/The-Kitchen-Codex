/**
 * The Kitchen Codex — Phase 9B-3A.
 * AUTHENTICATED SEMANTIC CONSUMPTION BOUNDARY.
 *
 * WHY THIS EXISTS. Phase 9B-P5B produced the first real HTTP 200 whole-recipe
 * semantic response: a `wsem1` receipt plus a `wsemo1` operation identity were
 * issued after the strict sanitizer and exact-target reconciliation succeeded.
 * That response is only trustworthy if somebody CHECKS the proof. The issuing
 * process can verify it; nothing outside could, because the signing key is
 * process-local by design and no verification route exists yet.
 *
 * Until those semantics are connected to deterministic USDA matching, there is a
 * real gap: any client can POST an object that *looks* like a canonical signed
 * semantic result, and nothing refuses it. This module is the missing boundary.
 *
 * WHAT THIS IS. The smallest server-side consumer that turns an already-issued
 * whole-recipe semantic result into ADVISORY observations, and only after a GENUINE
 * same-process cryptographic verification.
 *
 * WHAT THIS IS NOT.
 *   - It is NOT an HTTP route. No route is added, so no unaudited public
 *     surface is introduced here. See the report for the proposed route contract.
 *   - It is NOT a matcher, a resolver, or a second nutrition engine.
 *   - It NEVER selects a USDA/FDC record, a gram weight, a portion weight, a
 *     nutrient value, a calorie total, or a confidence threshold, and it never
 *     authorizes application or persistence. Those stay under the existing
 *     deterministic matching, portion, review and calculation systems.
 *
 * THE TRUST RULE. A client-submitted object is NEVER authorized for having the
 * right shape. The server re-derives the context itself and asks the SAME
 * process-scoped authority that issued the proof to verify the MAC. Only the
 * canonical subject returned BY that verification is ever consumed downstream,
 * so hostile input cannot ride through a successful check.
 */

import { getProcessSemanticOriginAuthority } from './wholeRecipeSemanticAuthority.js';
import type { WholeRecipeSemanticOriginAuthority } from './wholeRecipeSemanticOriginReceipt.js';
import { materializeWholeRecipeInterpretationContext } from './wholeRecipeInterpretRequest.js';
import type { AiAdvancedIngredientInterpretation } from '../src/core/nutritionV2/aiAdvanced.js';

// ---------------------------------------------------------------------------
// Bounded failure codes
// ---------------------------------------------------------------------------

/**
 * Closed failure vocabulary. Every code means "no observation was produced".
 *
 * `unauthenticated` deliberately COLLAPSES every proof failure — forged receipt,
 * foreign authority, tampered semantics, malformed receipt, replayed operation
 * identity with changed material. Distinguishing them here would be a MAC oracle.
 */
export type SemanticConsumptionFailureCode =
  | 'invalid_request'
  | 'stale_context'
  | 'target_mismatch'
  | 'unauthenticated';

/** The closed set of keys a submitted consumption envelope may carry. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'request_id',
  'context_binding',
  'semantic_response',
  'provider_id',
  'model_id',
  'operation_id',
  'origin_receipt',
]);

/** Upper bounds mirroring the released request contract, so nothing unbounded is read. */
const MAX_SUBMITTED_ROWS = 25;
const MAX_SUBMITTED_ROW_TEXT = 120;
const MAX_SUBMITTED_ROW_NOTES = 300;
const MAX_SUBMITTED_LIST = 12;
const MAX_SUBMITTED_ID = 64;

// ---------------------------------------------------------------------------
// Result contracts
// ---------------------------------------------------------------------------

/**
 * ONE authenticated advisory observation.
 *
 * This is SEMANTIC ONLY and is deliberately nutrition-authority-free: there is
 * no FDC id, no catalog record, no gram/mass/portion, no nutrient, no calorie
 * field, and no "selected" or "matched" concept anywhere in this shape. The
 * deterministic systems remain the only owners of all of those.
 */
export interface AuthenticatedSemanticObservation {
  readonly line_ref: string;
  /** Food-identity wording, as interpreted. Never a catalog identity. */
  readonly normalized_name?: string;
  readonly modifiers: readonly string[];
  readonly preparation: readonly string[];
  readonly state: readonly string[];
  readonly qualifiers: readonly string[];
  /** Generic search WORDINGS for deterministic candidate discovery. Never a match. */
  readonly search_phrases: readonly string[];
  readonly amount_kind: string;
  readonly authored_amount?: number;
  readonly authored_unit?: string;
  readonly echoed_value?: number;
  readonly unit_family: string;
  readonly unit_raw?: string;
  readonly unit_interpreted?: string;
  readonly count_noun?: string;
  readonly count_size?: string;
  readonly count_state?: string;
  readonly alternatives: readonly string[];
  readonly ambiguous: boolean;
  readonly ambiguity_reasons: readonly string[];
  /** Advisory model confidence. Never a matching or auto-accept threshold. */
  readonly confidence?: string;
  readonly notes?: string;
}

export interface AuthenticatedSemanticConsumption {
  readonly ok: true;
  /**
   * Always this literal. Present so a downstream caller cannot mistake an
   * authenticated semantic observation for a nutrition resolution.
   */
  readonly authority: 'advisory_semantic_observations';
  /** Server-verified execution identity. */
  readonly provider_id: string;
  readonly model_id: string;
  readonly operation_id: string;
  readonly context_binding: string;
  readonly request_id: string;
  readonly observations: readonly AuthenticatedSemanticObservation[];
}

export type SemanticConsumptionResult =
  | AuthenticatedSemanticConsumption
  | {
      readonly ok: false;
      readonly code: SemanticConsumptionFailureCode;
      /** True when a proof was presented and genuinely checked. */
      readonly verified: false;
    };

// ---------------------------------------------------------------------------
// Hostile input helpers — never throw
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sentinel distinguishing "absent" from a legitimately `undefined` value. */
const ABSENT = Symbol('absent');

/**
 * Reads an OWN DATA property, and ONLY that.
 *
 * This mirrors `dataProperty()` in the released origin-receipt module exactly,
 * and it is a deliberate security boundary rather than a style choice. A plain
 * `obj.key` read would:
 *   - walk the PROTOTYPE CHAIN, so an object created with
 *     `Object.create({ origin_receipt: ... })` could present an inherited value
 *     that never existed as its own data; and
 *   - INVOKE a getter, letting attacker code run inside this function.
 *
 * An inherited value, an accessor, or a throwing descriptor all read as ABSENT,
 * so a hostile envelope can only ever supply own, plain, inert data.
 */
function dataProperty(target: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return ABSENT;
  }
  if (descriptor === undefined) return ABSENT;
  if (!('value' in descriptor)) return ABSENT; // accessor: refuse, never invoke
  return descriptor.value;
}

/** `dataProperty` narrowed to a bounded, trimmed, non-empty string. */
function readOwnString(target: object, key: string, max: number): string | undefined {
  const value = dataProperty(target, key);
  if (value === ABSENT || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/** `dataProperty` narrowed to an own array within bounds. */
function readOwnArray(target: object, key: string, max: number): unknown[] | undefined {
  const value = dataProperty(target, key);
  if (value === ABSENT || !Array.isArray(value) || value.length > max) return undefined;
  return value;
}

function readString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function readBoundedList(value: unknown, max: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const text = readString(entry, maxLength);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The consumption boundary
// ---------------------------------------------------------------------------

/**
 * Consumes an issued whole-recipe semantic result, but ONLY after a genuine
 * same-process cryptographic verification.
 *
 * The caller supplies the ORIGINAL whole-recipe request (so the server can
 * re-derive the context itself — client-derived context is never trusted) plus
 * the issued response envelope, which is treated as fully HOSTILE.
 *
 * NEVER THROWS. Every failure is a bounded code and yields ZERO observations.
 *
 * `authority` is injectable only so tests can prove that a SECOND authority
 * cannot verify a receipt issued by another. Production uses the process-scoped
 * authority — the same instance the issuing operation used.
 */
export function consumeAuthenticatedWholeRecipeSemantics(
  rawRequest: unknown,
  issuedEnvelope: unknown,
  authority: WholeRecipeSemanticOriginAuthority = getProcessSemanticOriginAuthority()
): SemanticConsumptionResult {
  // --- 1. server-owned context re-derivation (F-02) -------------------------
  // Zero observations are produced before this succeeds. The client never
  // supplies the context that authorizes its own semantics.
  const materialized = materializeWholeRecipeInterpretationContext(rawRequest);
  if (materialized.ok === false) return { ok: false, code: 'invalid_request', verified: false };
  const context = materialized.context;
  const requestedLineRefs = context.provider_context.targets.map((target) => target.line_ref);

  // --- 2. closed hostile envelope read --------------------------------------
  if (!isRecord(issuedEnvelope)) return { ok: false, code: 'invalid_request', verified: false };
  for (const key of Object.keys(issuedEnvelope)) {
    if (!ENVELOPE_KEYS.has(key)) return { ok: false, code: 'invalid_request', verified: false };
  }

  const requestId = readOwnString(issuedEnvelope, 'request_id', MAX_SUBMITTED_ID);
  const contextBinding = readOwnString(issuedEnvelope, 'context_binding', 128);
  const providerId = readOwnString(issuedEnvelope, 'provider_id', MAX_SUBMITTED_ID);
  const modelId = readOwnString(issuedEnvelope, 'model_id', MAX_SUBMITTED_ID);
  const operationId = readOwnString(issuedEnvelope, 'operation_id', 96);
  if (
    requestId === undefined ||
    contextBinding === undefined ||
    providerId === undefined ||
    modelId === undefined ||
    operationId === undefined
  ) {
    return { ok: false, code: 'invalid_request', verified: false };
  }

  const rows = readOwnArray(issuedEnvelope, 'semantic_response', MAX_SUBMITTED_ROWS);
  if (rows === undefined || rows.length === 0) {
    return { ok: false, code: 'invalid_request', verified: false };
  }
  const submittedRefs: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return { ok: false, code: 'invalid_request', verified: false };
    const ref = readOwnString(row, 'line_ref', 200);
    if (ref === undefined) return { ok: false, code: 'invalid_request', verified: false };
    submittedRefs.push(ref);
  }

  // --- 3. freshness: the submitted binding/request must be the CURRENT one ---
  // Checked against the SERVER'S OWN re-derivation, never against a value the
  // client asserts about itself. A stale recipe fails closed here.
  if (contextBinding !== context.context_binding || requestId !== context.request_id) {
    return { ok: false, code: 'stale_context', verified: false };
  }

  // --- 4. exact requested-target set ----------------------------------------
  if (
    submittedRefs.length !== requestedLineRefs.length ||
    !submittedRefs.every((ref) => requestedLineRefs.includes(ref))
  ) {
    return { ok: false, code: 'target_mismatch', verified: false };
  }

  // --- 5. GENUINE cryptographic verification --------------------------------
  // The subject is built from the SERVER'S re-derived context plus the hostile
  // submitted material. `verify` re-reads the whole subject through the released
  // strict canonical read before any MAC is compared, so malformed input is
  // never authenticated, and the compared material is never caller-controlled.
  const verified = authority.verify(dataProperty(issuedEnvelope, 'origin_receipt'), {
    context,
    interpretations: rows,
    provider_id: providerId,
    model_id: modelId,
    operation_id: operationId,
  });
  if (!verified.ok) return { ok: false, code: 'unauthenticated', verified: false };

  // --- 6. consume ONLY the verified canonical origin ------------------------
  // `verified.origin` is the authority's own canonical re-read. Downstream never
  // sees the client's submitted object.
  const origin = verified.origin;
  const observations = origin.interpretations.map(projectObservation);
  if (observations === null) return { ok: false, code: 'unauthenticated', verified: false };

  return {
    ok: true,
    authority: 'advisory_semantic_observations',
    provider_id: origin.provider_id,
    model_id: origin.model_id,
    operation_id: origin.operation_id,
    context_binding: origin.context_binding,
    request_id: origin.request_id,
    observations,
  };
}

/**
 * Projects ONE authenticated canonical interpretation into a bounded advisory
 * observation.
 *
 * Reads ONLY the sanitizer's own canonical fields. It cannot emit an FDC id,
 * catalog record, mass, portion, nutrient or calorie, because no such field
 * exists in the canonical origin and none is derived here. Returns null rather
 * than inventing a value if the canonical row is not projectable.
 */
function projectObservation(
  row: AiAdvancedIngredientInterpretation
): AuthenticatedSemanticObservation | null {
  try {
    const food = row.semantic_food;
    const amount = row.amount_semantics;
    const unit = row.unit_semantics;
    const count = row.count_semantics;
    const ambiguity = row.ambiguity;
    const lineRef = readString(row.line_ref, 200);
    if (lineRef === undefined) return null;

    return Object.freeze({
      line_ref: lineRef,
      ...(food.normalized_name !== undefined
        ? { normalized_name: readString(food.normalized_name, MAX_SUBMITTED_ROW_TEXT) }
        : {}),
      modifiers: freezeList(food.modifiers),
      preparation: freezeList(food.preparation),
      state: freezeList(food.state),
      qualifiers: freezeList(food.qualifiers),
      search_phrases: freezeList(row.search_phrases),
      amount_kind: amount.kind,
      ...(typeof amount.echoed_value === 'number' ? { echoed_value: amount.echoed_value } : {}),
      unit_family: unit.family,
      ...(unit.raw !== undefined ? { unit_raw: readString(unit.raw, MAX_SUBMITTED_ROW_TEXT) } : {}),
      ...(unit.interpreted_unit !== undefined
        ? { unit_interpreted: readString(unit.interpreted_unit, MAX_SUBMITTED_ROW_TEXT) }
        : {}),
      ...(count.noun !== undefined ? { count_noun: count.noun } : {}),
      ...(count.size !== undefined ? { count_size: count.size } : {}),
      ...(count.state !== undefined ? { count_state: count.state } : {}),
      alternatives: Object.freeze(row.alternatives.map((alt) => alt.normalized_name)),
      ambiguous: ambiguity.ambiguous === true,
      ambiguity_reasons: freezeList(ambiguity.reasons),
      ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
      ...(row.notes !== undefined ? { notes: readString(row.notes, MAX_SUBMITTED_ROW_NOTES) } : {}),
    } as AuthenticatedSemanticObservation);
  } catch {
    return null;
  }
}

function freezeList(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = readString(value, MAX_SUBMITTED_ROW_TEXT);
    if (text !== undefined) out.push(text);
    if (out.length >= MAX_SUBMITTED_LIST) break;
  }
  return Object.freeze(out);
}
