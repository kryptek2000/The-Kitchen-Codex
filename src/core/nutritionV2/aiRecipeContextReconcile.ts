/**
 * The Kitchen Codex — Advanced Nutrition AI-4D1: deterministic reconciliation
 * foundation (FRESHNESS + REQUEST CORRELATION + INERT REVIEW CLASSIFICATION).
 *
 * PURE, platform-neutral, offline, provider-free, side-effect free. This module
 * turns an UNTRUSTED AI-4C wire into an INERT, bounded deterministic review plan
 * — or into a bounded refusal. It performs NO provider call, reads no recipe, and
 * mutates nothing.
 *
 * > MODEL OUTPUT IS NEVER AUTHORITY BY ITSELF. AI-4D1 grants authority over
 * > nothing: not identity, not FDC identity, not matching, not mass, not grams,
 * > not portions, not nutrients, not servings, not effective mass, not AI-3
 * > eligibility, not suppression, not persistence, not Apply.
 *
 * THE WHOLE-PROPOSAL FRESHNESS RULE
 *   AI-4 is WHOLE-RECIPE interpretation. If the CURRENT context binding does not
 *   exactly match the binding captured in the wire, THE WHOLE PROPOSAL IS STALE.
 *   Individual rows are NEVER salvaged: one changed model-visible element can have
 *   changed how the model read every other line, so a per-row comparison would be
 *   a guess. A stale wire fails closed; it never degrades into a partial plan.
 *
 * TWO INDEPENDENT EQUALITY CHECKS, BOTH REQUIRED
 *   `context_binding` answers "was the semantic context IDENTICAL?" — the one
 *   existing AI-4C binding over contract version, recipe instance, ordered
 *   provider targets, line refs, authored text and food phrases. AI-4D1 does NOT
 *   invent another AI-4 digest and does NOT resurrect `snapshot_digest`.
 *   `request_id` answers "is this the response to THIS operation?" A wire from a
 *   different request over an identical context must not masquerade as this
 *   request's response, so context equality alone is never sufficient.
 *
 * THE WIRE IS UNTRUSTED AGAIN
 *   It was validated once inside AI-4C, but a client, a browser or a caller may
 *   have altered it since. It is re-materialized with the descriptor-based Phase 0
 *   materializer (accessors, symbol keys, cycles, non-plain prototypes and
 *   oversized values fail closed), then re-read with the RELEASED strict AI-4C
 *   wire reader against the CURRENT server-derived line refs, then re-checked with
 *   the RELEASED AI-4A relation-graph validator. AI-4D1 adds no second vocabulary,
 *   no second validator and no looser path.
 *
 * CLOSED REVIEW CATEGORIES — AND NO "ACCEPTED"
 *   `reviewable`    a current, valid AI interpretation with no explicit abstention.
 *                   THIS IS NOT ACCEPTANCE. It means "a user may now be shown
 *                   this"; nothing else. AI-4D1 does not know what a user accepts.
 *   `abstained`     the model explicitly supplied an `abstain_reason`, preserved
 *                   verbatim from the closed vocabulary.
 *   `uninterpreted` a current deterministic target the valid proposal did not
 *                   interpret. ABSENCE STAYS ABSENCE: no role is inferred, and no
 *                   AI-4B deterministic signal is ever converted into an AI-4A
 *                   interpretation field.
 *
 *   There is deliberately no `accepted`, `approved`, `applied`, `authoritative`,
 *   `automatic`, `selected` or `suppressed` category. Those words belong to
 *   AI-4D2's explicit user acceptance, and this module must not leave vocabulary
 *   behind that future code could mistake for a user-approved row.
 *
 * DETERMINISTIC ORDER, NOT MODEL ORDER
 *   Rows are emitted in the CURRENT AI-4B deterministic target order, so the model
 *   does not control review/UI ordering and an omitted target still has a
 *   deterministic position. Semantic content is never rewritten to reorder rows;
 *   relations keep their canonical target refs.
 *
 * NO AI-4B SIGNAL PROMOTION
 *   AI-4B signals are EVIDENCE of authored language, not semantic authority:
 *   `partial_use` does not become role `reserved`, `division` does not become
 *   `divided`, `garnish_only` never overwrites a model role, and `not_consumed`
 *   never suppresses anything. This module therefore does not carry the signal
 *   vocabulary at all.
 *
 * NO SEMANTIC ADJUDICATION
 *   The current closed vocabularies do not make every apparent mismatch
 *   contradictory: an ingredient can be `main` AND `divided`, a reserved ingredient
 *   can still be a main ingredient, a cooking medium can later be discarded. So
 *   AI-4D1 does NOT build a conflict matrix and does NOT label disagreement. Its
 *   refusals are structural only: stale context, request mismatch, invalid wire,
 *   invalid graph/reference, invalid current context. Everything else is preserved
 *   for a human to judge in AI-4D2.
 *
 * NO CLOCK, NO TTL
 *   Freshness is content/binding based. There is no timestamp, no expiry window
 *   and no nonce: the request id plus the deterministic context binding are
 *   sufficient, and a time-based rule would be both unreproducible and unauditable.
 */

import { isPlainObject, toInertValue } from './schema';
import { hasDangerousOwnKey, hasSymbolKeys, readOwnDataField } from './phase4/materialize';
import {
  MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH,
  validateAiRecipeContextRelationGraph,
  type AiRecipeContextAbstainReason,
  type AiRecipeContextInterpretation,
} from './phase4/recipeContextContract';
import { readAiRecipeContextWirePayload } from './aiRecipeContextWire';

/** Closed reconciliation contract version. Exact match required. */
export const AI_RECIPE_CONTEXT_RECONCILE_VERSION = 'nutrition_ai_recipe_context_reconcile_v1' as const;

/**
 * CLOSED status vocabulary with exactly ONE member.
 *
 * A non-current outcome is a bounded FAILURE, never a second status. Keeping the
 * status closed to `current` is what makes "accepted"/"stale" impossible to
 * express here.
 */
export const AI_RECIPE_CONTEXT_RECONCILE_STATUSES = Object.freeze(['current'] as const);
export type AiRecipeContextReconcileStatus = (typeof AI_RECIPE_CONTEXT_RECONCILE_STATUSES)[number];

/**
 * CLOSED review categories. `reviewable` is NOT acceptance; `uninterpreted` is
 * NOT an abstention.
 */
export const AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES = Object.freeze([
  'reviewable',
  'abstained',
  'uninterpreted',
] as const);
export type AiRecipeContextReconcileCategory = (typeof AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES)[number];

/**
 * Closed input keys. Anything else — authority-shaped or not — is refused.
 * Internal core parameters are camelCase (the same convention the AI-4C wire
 * reader uses for `allowedLineRefs`); the transport-shaped request keys stay
 * snake_case at the server adapter edge.
 */
const INPUT_KEYS: ReadonlySet<string> = new Set(['wire', 'expectedRequestId', 'current']);
const CURRENT_KEYS: ReadonlySet<string> = new Set(['context_binding', 'targets']);
const CURRENT_TARGET_KEYS: ReadonlySet<string> = new Set(['line_ref', 'source_text']);

const MAX_EXPECTED_REQUEST_ID_LENGTH = 120;
const MAX_CONTEXT_BINDING_LENGTH = 80;
const MAX_CURRENT_TARGETS = 32;
const MAX_REQUEST_ID_CHARS = 200;

export type RecipeContextReconcileFailureCode =
  /** The reconciliation input itself is unusable (shape, getters, symbols, bounds). */
  | 'invalid_input'
  /** The CURRENT recipe context could not be derived deterministically. */
  | 'invalid_context'
  /** The wire is not materializable, or fails strict revalidation. */
  | 'invalid_wire'
  /** The wire answers a DIFFERENT request id. */
  | 'request_mismatch'
  /** The wire's context binding does not match the CURRENT context binding. */
  | 'stale_context';

export type RecipeContextReconcileFailure = {
  readonly ok: false;
  readonly code: RecipeContextReconcileFailureCode;
};

/** One current deterministic target as the reconciler sees it. */
export interface RecipeContextReconcileCurrentTarget {
  readonly line_ref: string;
  readonly source_text: string;
}

/** The CURRENT derived context facts the reconciler is given. */
export interface RecipeContextReconcileCurrentContext {
  readonly context_binding: string;
  readonly targets: ReadonlyArray<RecipeContextReconcileCurrentTarget>;
}

/**
 * One INERT review row. It carries the CURRENT authored text and, when the model
 * interpreted the line, the validated AI-4A interpretation. It is a description,
 * never a decision.
 */
export interface RecipeContextReconcileRow {
  readonly category: AiRecipeContextReconcileCategory;
  readonly line_ref: string;
  /** The CURRENT authored text for this line (never a re-read of the wire). */
  readonly source_text: string;
  /** Present for `reviewable` and `abstained`; absent for `uninterpreted`. */
  readonly interpretation?: AiRecipeContextInterpretation;
  /** The model's own canonical abstention reason, preserved verbatim. */
  readonly abstain_reason?: AiRecipeContextAbstainReason;
}

/** The inert reconciliation result. Frozen data; no authority anywhere in it. */
export interface RecipeContextReconciliation {
  readonly reconciliation_version: typeof AI_RECIPE_CONTEXT_RECONCILE_VERSION;
  readonly request_id: string;
  /** The CURRENT context binding, recomputed at reconciliation time. */
  readonly context_binding: string;
  readonly status: AiRecipeContextReconcileStatus;
  /** Rows in CURRENT deterministic AI-4B target order, never model order. */
  readonly rows: ReadonlyArray<RecipeContextReconcileRow>;
  readonly reviewable_count: number;
  readonly abstained_count: number;
  readonly uninterpreted_count: number;
}

export type RecipeContextReconcileResult =
  | { readonly ok: true; readonly reconciliation: RecipeContextReconciliation }
  | RecipeContextReconcileFailure;

export interface RecipeContextReconcileInput {
  /** The untrusted AI-4C wire payload. */
  readonly wire: unknown;
  /** The request id THIS reconciliation expects to be answering. */
  readonly expectedRequestId: unknown;
  /** The CURRENT derived context facts (supplied by the single derivation owner). */
  readonly current: unknown;
}

function fail(code: RecipeContextReconcileFailureCode): RecipeContextReconcileFailure {
  return { ok: false, code };
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Reads the CURRENT context facts. The caller here is the server-side derivation
 * owner, never a browser, so the values are already canonical; they are still
 * bounded and closed, because "trusted caller" is exactly how authority leaks.
 */
function readCurrentContext(raw: unknown): RecipeContextReconcileCurrentContext | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) {
    if (!CURRENT_KEYS.has(key)) return undefined;
  }
  const binding = boundedString(raw['context_binding'], MAX_CONTEXT_BINDING_LENGTH);
  if (binding === undefined) return undefined;

  const rawTargets = raw['targets'];
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return undefined;
  if (rawTargets.length > MAX_CURRENT_TARGETS) return undefined;

  const targets: RecipeContextReconcileCurrentTarget[] = [];
  const seen = new Set<string>();
  for (const entry of rawTargets) {
    if (!isPlainObject(entry)) return undefined;
    for (const key of Object.keys(entry)) {
      if (!CURRENT_TARGET_KEYS.has(key)) return undefined;
    }
    const lineRef = boundedString(entry['line_ref'], MAX_REQUEST_ID_CHARS);
    if (lineRef === undefined || seen.has(lineRef)) return undefined;
    seen.add(lineRef);
    const sourceText = boundedString(entry['source_text'], MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH);
    if (sourceText === undefined) return undefined;
    targets.push(Object.freeze({ line_ref: lineRef, source_text: sourceText }));
  }

  return Object.freeze({ context_binding: binding, targets: Object.freeze(targets) });
}

/**
 * The ONE reconciliation entry point. Pure, deterministic, fail-closed.
 *
 * ORDER IS EXPLICIT AND LOAD-BEARING:
 *   1. validate the reconciliation input (shape, symbols, bounds);
 *   2. validate the expected request identity;
 *   3. read the CURRENT context facts (already derived by the single owner);
 *   4. re-materialize the UNTRUSTED wire (descriptor-based; accessors fail closed);
 *   5. read and bound the wire's own IDENTITY claims (`request_id`,
 *      `context_binding`); a malformed claim is a wire refusal, never a plan;
 *   6. require `wire.request_id == expected_request_id` — "is this the response to
 *      THIS operation?";
 *   7. require `wire.context_binding == current.context_binding` — "was the
 *      semantic context identical?" A mismatch makes the WHOLE proposal stale, and
 *      NOT ONE model interpretation is examined before that is established;
 *   8. strict-read the wire against the CURRENT line refs;
 *   9. re-check the relation graph;
 *  10. build the inert review plan in CURRENT deterministic order.
 *
 * WHY IDENTITY IS CHECKED BEFORE STRUCTURE
 *   Correlation and freshness describe WHICH RESPONSE this is; structure describes
 *   whether that response is well formed. Reporting a legitimate stale wire as
 *   "invalid wire" would be untruthful, and inspecting model interpretations before
 *   freshness is established would let model content influence the outcome at all.
 *   Both orders fail closed; this one is more honest, and more cautious.
 */
export function reconcileRecipeContext(input: RecipeContextReconcileInput): RecipeContextReconcileResult {
  // (1) Input shape.
  const envelope = input as unknown;
  if (!isPlainObject(envelope)) return fail('invalid_input');
  if (hasSymbolKeys(envelope) || hasDangerousOwnKey(envelope)) return fail('invalid_input');
  for (const key of Object.keys(envelope)) {
    if (!INPUT_KEYS.has(key)) return fail('invalid_input');
  }

  // (2) Expected request identity.
  const expectedRequestId = boundedString(
    input.expectedRequestId,
    MAX_EXPECTED_REQUEST_ID_LENGTH
  );
  if (expectedRequestId === undefined) return fail('invalid_input');

  // (3) CURRENT context facts.
  const current = readCurrentContext(input.current);
  if (current === undefined) return fail('invalid_input');

  // (4) The wire is untrusted AGAIN: materialize it before reading anything, so a
  // getter, symbol key, cycle, non-plain prototype or oversized value fails closed
  // without ever being invoked as trusted data.
  const wireField = readOwnDataField(input as object, 'wire');
  if (!wireField.ok) return fail('invalid_input');
  if (!wireField.present) return fail('invalid_input');
  const inert = toInertValue(wireField.value);
  if (!inert.ok) return fail('invalid_wire');

  // (5) The wire's own IDENTITY claims, read defensively BEFORE any model content
  // is examined. A malformed or unbound claim is a wire refusal.
  if (!isPlainObject(inert.value)) return fail('invalid_wire');
  const wireRecord = inert.value as Record<string, unknown>;
  const wireRequestId = boundedString(wireRecord['request_id'], MAX_EXPECTED_REQUEST_ID_LENGTH);
  const wireBinding = boundedString(wireRecord['context_binding'], MAX_CONTEXT_BINDING_LENGTH);
  if (wireRequestId === undefined || wireBinding === undefined) return fail('invalid_wire');

  // (6) Request correlation. A wire from another operation is NOT this
  // operation's response, even when the context is byte-identical.
  if (wireRequestId !== expectedRequestId) return fail('request_mismatch');

  // (7) Whole-proposal freshness. AI-4 is a WHOLE-RECIPE interpretation: one
  // changed model-visible element can have changed how the model read every other
  // line, so a mismatch refuses EVERY row. There is no partial salvage, and no
  // model interpretation was examined to reach this decision.
  if (wireBinding !== current.context_binding) return fail('stale_context');

  // (8) Strict re-read against the CURRENT line refs. A wire naming a target that
  // does not currently exist, a forged provenance class, an unknown key at any
  // depth, a duplicate line ref, or an out-of-bounds field is refused HERE.
  const allowedLineRefs = current.targets.map((target) => target.line_ref);
  const read = readAiRecipeContextWirePayload(inert.value, { allowedLineRefs });
  if (!read.ok) return fail('invalid_wire');
  const wire = read.payload;

  // (9) Relation-graph re-check: the strict reader establishes structure and
  // reference validity; the released AI-4A validator additionally establishes
  // self-relation, duplicate-relation, multiple-parent, cycle and depth rules.
  const graph = validateAiRecipeContextRelationGraph(
    wire.proposal.interpretations,
    allowedLineRefs
  );
  if (!graph.ok) return fail('invalid_wire');

  // (10) The inert review plan, in CURRENT deterministic target order.
  const byLine = new Map<string, AiRecipeContextInterpretation>();
  for (const entry of wire.proposal.interpretations) {
    byLine.set(entry.line_ref, entry);
  }

  const rows: RecipeContextReconcileRow[] = [];
  let reviewableCount = 0;
  let abstainedCount = 0;
  let uninterpretedCount = 0;
  for (const target of current.targets) {
    const interpretation = byLine.get(target.line_ref);
    if (interpretation === undefined) {
      // ABSENCE STAYS ABSENCE: no role is inferred and no AI-4B signal is promoted.
      uninterpretedCount += 1;
      rows.push(
        Object.freeze({
          category: 'uninterpreted' as const,
          line_ref: target.line_ref,
          source_text: target.source_text,
        })
      );
      continue;
    }
    if (interpretation.abstain_reason !== undefined) {
      // An explicit abstention stays an abstention, verbatim.
      abstainedCount += 1;
      rows.push(
        Object.freeze({
          category: 'abstained' as const,
          line_ref: target.line_ref,
          source_text: target.source_text,
          interpretation: Object.freeze({ ...interpretation, relations: Object.freeze([...interpretation.relations]) }),
          abstain_reason: interpretation.abstain_reason,
        })
      );
      continue;
    }
    reviewableCount += 1;
    rows.push(
      Object.freeze({
        category: 'reviewable' as const,
        line_ref: target.line_ref,
        source_text: target.source_text,
        interpretation: Object.freeze({ ...interpretation, relations: Object.freeze([...interpretation.relations]) }),
      })
    );
  }

  return {
    ok: true,
    reconciliation: Object.freeze({
      reconciliation_version: AI_RECIPE_CONTEXT_RECONCILE_VERSION,
      request_id: expectedRequestId,
      context_binding: current.context_binding,
      status: 'current' as const,
      rows: Object.freeze(rows),
      reviewable_count: reviewableCount,
      abstained_count: abstainedCount,
      uninterpreted_count: uninterpretedCount,
    }),
  };
}
