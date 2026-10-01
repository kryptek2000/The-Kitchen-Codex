/**
 * The Kitchen Codex — Advanced Nutrition AI-4D2: explicit USER ACCEPTANCE +
 * session-only accepted recipe context.
 *
 * PURE, offline, immutable, session-only, non-persistent, provider-free. This
 * module turns an INERT AI-4D1 review plan into a workflow where a HUMAN
 * explicitly accepts or dismisses individual AI interpretations.
 *
 * THE PERMANENT RULE
 *   MODEL OUTPUT IS NEVER ACCEPTED AUTOMATICALLY. The required chain is:
 *     AI proposes
 *       -> deterministic AI-4D1 reconciliation says CURRENT
 *       -> USER reviews
 *       -> USER explicitly accepts a specific interpretation
 *       -> session-only accepted context exists
 *   There is no confidence threshold that bypasses the user, no `high`-confidence
 *   shortcut, no bulk "accept all", and no AI-4B signal that can cause acceptance.
 *   A decision is keyed ONLY by `line_ref`: the canonical interpretation always
 *   comes from the AI-4D1 review plan, never from a caller-authored payload.
 *
 * A SEPARATE AUTHORITY DOMAIN
 *   AI-4 acceptance is NOT nutrition working state. `Phase4State` and its reducer
 *   own matches, portions, count portions, user masses, household portions, AI-3
 *   estimates and the preview; this module touches none of them, imports none of
 *   them, and adds no action to that reducer. Nothing here is dispatched,
 *   persisted, or hydrated.
 *
 * SESSION IDENTITY — BOTH, ALWAYS
 *   The session binds `request_id` AND `context_binding`.
 *     `context_binding` proves the recipe semantic context is unchanged.
 *     `request_id` proves the user's decisions belong to THIS interpretation
 *     operation. A second AI run over an identical recipe may return a different
 *     interpretation, so a new request id means a NEW review session and prior
 *     decisions must NOT silently transfer.
 *
 * WHOLE-CONTEXT STALENESS
 *   AI-4 is whole-recipe interpretation, so acceptance is whole-context too: every
 *   action re-verifies the expected identity. A review that has gone stale cannot
 *   be accepted, dismissed or undone — the action fails closed and no-op, even if a
 *   stale UI somehow delivers it.
 *
 * MINIMAL OVERLAY + BYTE-TRUTHFUL UNDO
 *   The immutable reconciliation is the source of truth; the session is only an
 *   overlay of explicit user choices (`accepted` | `dismissed`). Absence of an
 *   entry means "still pending". Because the underlying plan is never mutated,
 *   UNDO restores the exact original row: pending -> accepted -> undo is
 *   byte-equivalent to pending, with no timestamps, counters or generated ids that
 *   could prevent truthful restoration.
 *
 * NO DIRECT SWITCH (v1)
 *   A pending row may become accepted OR dismissed. Once decided, the only next
 *   move is Undo back to pending. accepted -> dismissed and dismissed -> accepted
 *   without an Undo are refused, so user intent stays explicit and restoration
 *   stays deterministic.
 *
 * ACCEPTANCE CAPABILITY
 *   Only a `reviewable` row may be accepted. An `abstained` row (the model
 *   supplied a canonical `abstain_reason`) and an `uninterpreted` row (the model
 *   said nothing) may NEVER be accepted, and no D2 code invents an interpretation
 *   for either.
 *
 * ACCEPTED SEMANTICS ARE CONSERVATIVE
 *   The accepted projection carries exactly the semantic claims the user
 *   accepted: `line_ref`, `role`, `relations`, `preparation_hints`. `confidence`
 *   and `explanation` remain display metadata and deliberately do NOT become
 *   operational authority merely because they were in the model response, and
 *   `abstain_reason` can never appear in an accepted entry.
 *
 * ACCEPTING A ROW ACCEPTS THAT ROW'S RELATIONS
 *   Accepting an interpretation accepts the canonical relation assertions ON THAT
 *   ROW. A relation target does not need its own interpretation accepted to exist
 *   as a target, and its own interpretation stays independently pending. The
 *   target is already guaranteed to be a CURRENT valid target, and the whole
 *   relation graph has already passed AI-4A/AI-4D1 validation.
 *
 * DISMISS SEMANTICS
 *   Dismiss means only "do not use this AI interpretation in this session's
 *   accepted context". It is a user review choice, NOT semantic authority: it does
 *   not assert the opposite reading, does not claim anything is consumed, does not
 *   say the AI was wrong, and suppresses nothing.
 *
 * ZERO NUTRITION AUTHORITY — YET
 *   Accepted context has NO downstream consumer in this phase. It does not alter
 *   AI-3 eligibility, AI-3 suppression, mass estimation, grams, matching, FDC
 *   identity, portions, nutrients, calculations, effective mass, persistence or
 *   Apply. A future, separately authorized phase may consume it, and must re-prove
 *   currentness and preserve existing nutrition authority.
 */

import { isPlainObject, toInertValue } from './schema';
import {
  AI_RECIPE_CONTEXT_ABSTAIN_REASONS,
  AI_RECIPE_CONTEXT_CONFIDENCE_VALUES,
  AI_RECIPE_CONTEXT_PREPARATION_HINTS,
  AI_RECIPE_CONTEXT_RELATIONS,
  AI_RECIPE_CONTEXT_ROLES,
  MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH,
  MAX_RECIPE_CONTEXT_LINE_REF_LENGTH,
  MAX_RECIPE_CONTEXT_PREPARATION_HINTS,
  MAX_RECIPE_CONTEXT_PREPARATION_HINT_LENGTH,
  MAX_RECIPE_CONTEXT_RELATIONS,
MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH,
  type AiRecipeContextAbstainReason,
  type AiRecipeContextConfidence,
  type AiRecipeContextPreparationHint,
  type AiRecipeContextRelation,
  type AiRecipeContextRole,
} from './phase4/recipeContextContract';
import {
  AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES,
  AI_RECIPE_CONTEXT_RECONCILE_VERSION,
  type RecipeContextReconcileRow,
  type RecipeContextReconciliation,
} from './aiRecipeContextReconcile';

/** Closed review-session contract version. */
export const AI_RECIPE_CONTEXT_SESSION_VERSION = 'nutrition_ai_recipe_context_session_v1' as const;

/** Closed session-only accepted-context contract version. */
export const AI_RECIPE_CONTEXT_ACCEPTED_VERSION =
  'nutrition_ai_recipe_context_accepted_v1' as const;

/** The CLOSED decision vocabulary. Absence of an entry means "pending". */
export const AI_RECIPE_CONTEXT_DECISIONS = Object.freeze(['accepted', 'dismissed'] as const);
export type AiRecipeContextDecision = (typeof AI_RECIPE_CONTEXT_DECISIONS)[number];

/** Closed display-status vocabulary for a review row. */
export const AI_RECIPE_CONTEXT_REVIEW_STATUSES = Object.freeze([
  'pending',
  'accepted',
  'dismissed',
  'abstained',
  'uninterpreted',
] as const);
export type AiRecipeContextReviewStatus = (typeof AI_RECIPE_CONTEXT_REVIEW_STATUSES)[number];

const MAX_REQUEST_ID_LENGTH = 120;
const MAX_CONTEXT_BINDING_LENGTH = 80;
const MAX_ROWS = 32;

const SESSION_KEYS: ReadonlySet<string> = new Set([
  'session_version',
  'request_id',
  'context_binding',
  'reconciliation',
  'decisions',
]);
const RECONCILIATION_KEYS: ReadonlySet<string> = new Set([
  'reconciliation_version',
  'request_id',
  'context_binding',
  'status',
  'rows',
  'reviewable_count',
  'abstained_count',
  'uninterpreted_count',
]);
const ROW_KEYS: ReadonlySet<string> = new Set([
  'category',
  'line_ref',
  'source_text',
  'interpretation',
  'abstain_reason',
]);
const INTERPRETATION_KEYS: ReadonlySet<string> = new Set([
  'line_ref',
  'role',
  'relations',
  'preparation_hints',
  'confidence',
  'abstain_reason',
  'explanation',
]);
const RELATION_KEYS: ReadonlySet<string> = new Set(['kind', 'target_ref']);

/**
 * The SESSION-ONLY accepted context. It is INERT DATA with no consumer in this
 * phase, and it is never persisted, hydrated or sent anywhere.
 */
export interface AcceptedRecipeContextEntry {
  readonly line_ref: string;
  readonly role: AiRecipeContextRole;
  /** Canonical relation assertions the user accepted WITH this row. */
  readonly relations: ReadonlyArray<AiRecipeContextRelation>;
  readonly preparation_hints: ReadonlyArray<AiRecipeContextPreparationHint>;
}

export interface AcceptedRecipeContextSession {
  readonly accepted_version: typeof AI_RECIPE_CONTEXT_ACCEPTED_VERSION;
  readonly request_id: string;
  readonly context_binding: string;
  /** Only EXPLICITLY accepted canonical reviewable interpretations. */
  readonly accepted: ReadonlyArray<AcceptedRecipeContextEntry>;
}

/** The immutable review session: the D1 plan plus the user's decision overlay. */
export interface RecipeContextReviewSession {
  readonly session_version: typeof AI_RECIPE_CONTEXT_SESSION_VERSION;
  readonly request_id: string;
  readonly context_binding: string;
  /** SOURCE TRUTH. Never mutated by Accept/Dismiss/Undo. */
  readonly reconciliation: RecipeContextReconciliation;
  /** Overlay of EXPLICIT user choices only. Absent entry = still pending. */
  readonly decisions: Readonly<Record<string, AiRecipeContextDecision>>;
}

export type RecipeContextSessionFailureCode =
  /** The reconciliation is not a CURRENT AI-4D1 plan for this exact identity. */
  | 'not_current'
  /** The action did not name a line that exists in the current review. */
  | 'unknown_row'
  /** The row is not accept-capable (abstained, uninterpreted, or not reviewable). */
  | 'not_acceptable'
  /** A direct switch (accepted -> dismissed / dismissed -> accepted) or a repeat. */
  | 'already_decided'
  /** Undo with no decision to undo. */
  | 'nothing_to_undo'
  /** Structurally unusable input. */
  | 'invalid_input';

export type RecipeContextSessionResult =
  | { readonly ok: true; readonly session: RecipeContextReviewSession }
  | { readonly ok: false; readonly code: RecipeContextSessionFailureCode };

// ---------------------------------------------------------------------------
// Bounded, shared display copy.
//
// Review state is communicated in TEXT, never by colour alone, and every label is
// closed to the vocabularies above. The accepted-context note states the session
// boundary to the user directly.
// ---------------------------------------------------------------------------

/** The explicit control that starts a review. Never automatic. */
export const AI_RECIPE_CONTEXT_REVIEW_LABEL = 'Review recipe context with AI';

/** The section heading shown once the review surface exists. */
export const AI_RECIPE_CONTEXT_SECTION_LABEL = 'AI recipe context review';

/** Marks every model-produced field as an interpretation, not a fact. */
export const AI_RECIPE_CONTEXT_INTERPRETATION_LABEL = 'AI interpretation';

/** What acceptance and dismissal mean to the user. */
export const AI_RECIPE_CONTEXT_NOTE =
  'Accepted context is used for this review session only. It never changes nutrition values, AI amounts, or what gets saved.';

export const AI_RECIPE_CONTEXT_ACCEPT_LABEL = 'Accept';
export const AI_RECIPE_CONTEXT_DISMISS_LABEL = 'Dismiss';
export const AI_RECIPE_CONTEXT_UNDO_LABEL = 'Undo';
export const AI_RECIPE_CONTEXT_CLEAR_REVIEW_LABEL = 'Clear review';

/** Closed per-row status copy. Never colour-only. */
export const AI_RECIPE_CONTEXT_STATUS_LABEL: Readonly<
  Record<AiRecipeContextReviewStatus, string>
> = Object.freeze({
  pending: 'Awaiting your review',
  accepted: 'Accepted for this session',
  dismissed: 'Dismissed',
  abstained: 'AI abstained from this line',
  uninterpreted: 'AI did not interpret this line',
});

/** Closed abstention copy, keyed by the model's own canonical reason. */
export const AI_RECIPE_CONTEXT_ABSTAIN_LABEL: Readonly<Record<AiRecipeContextAbstainReason, string>> =
  Object.freeze({
    no_recipe_context: 'no recipe context available',
    insufficient_evidence: 'not enough evidence',
    contradictory_context: 'contradictory context',
    ambiguous_role: 'ambiguous role',
    already_deterministic: 'already unambiguous',
    untrusted_context: 'untrusted context',
  });

/** Human-readable form of any closed vocabulary term. */
export function formatRecipeContextTerm(value: string): string {
  return value.replace(/_/g, ' ');
}

export type RecipeContextReviewViewResult =
  | { readonly ok: true; readonly view: RecipeContextReviewView }
  | { readonly ok: false; readonly code: RecipeContextSessionFailureCode };

export type AcceptedRecipeContextResult =
  | { readonly ok: true; readonly accepted: AcceptedRecipeContextSession }
  | { readonly ok: false; readonly code: RecipeContextSessionFailureCode };

/** One display row. Pure view data: it decides nothing. */
export interface RecipeContextReviewRowView {
  readonly line_ref: string;
  readonly source_text: string;
  readonly status: AiRecipeContextReviewStatus;
  readonly role?: AiRecipeContextRole;
  readonly preparation_hints: ReadonlyArray<AiRecipeContextPreparationHint>;
  readonly relations: ReadonlyArray<AiRecipeContextRelation>;
  /** ADVISORY display metadata only; never operational authority. */
  readonly confidence?: AiRecipeContextConfidence;
  /** Advisory display metadata only. */
  readonly explanation?: string;
  readonly abstain_reason?: AiRecipeContextAbstainReason;
  /** Only `reviewable` rows can ever be accepted. */
  readonly accept_capable: boolean;
  readonly dismiss_capable: boolean;
  /** Only a decided row can be undone. */
  readonly undo_capable: boolean;
}

export interface RecipeContextReviewView {
  readonly session_version: typeof AI_RECIPE_CONTEXT_SESSION_VERSION;
  readonly request_id: string;
  readonly context_binding: string;
  readonly rows: ReadonlyArray<RecipeContextReviewRowView>;
  readonly pending_count: number;
  readonly accepted_count: number;
  readonly dismissed_count: number;
  readonly abstained_count: number;
  readonly uninterpreted_count: number;
}

/** The identity a caller believes is current. Every action re-checks it. */
export interface RecipeContextSessionIdentity {
  readonly requestId: unknown;
  readonly contextBinding: unknown;
}

function fail(code: RecipeContextSessionFailureCode): { ok: false; code: RecipeContextSessionFailureCode } {
  return { ok: false, code };
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function oneOf(value: unknown, vocabulary: ReadonlyArray<string>): string | undefined {
  const text = boundedString(value, MAX_RECIPE_CONTEXT_PREPARATION_HINT_LENGTH);
  if (text === undefined) return undefined;
  return (vocabulary as ReadonlyArray<string>).includes(text) ? text : undefined;
}

function canonicalizeRelations(raw: unknown): AiRecipeContextRelation[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_RECIPE_CONTEXT_RELATIONS) return undefined;
  const out: AiRecipeContextRelation[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return undefined;
    for (const key of Object.keys(entry)) {
      if (!RELATION_KEYS.has(key)) return undefined;
    }
    const kind = oneOf(entry['kind'], AI_RECIPE_CONTEXT_RELATIONS);
    const targetRef = boundedString(entry['target_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
    if (kind === undefined || targetRef === undefined) return undefined;
    out.push(
      Object.freeze({
        kind: kind as AiRecipeContextRelation['kind'],
        target_ref: targetRef,
      })
    );
  }
  return out;
}

function canonicalizeInterpretation(raw: unknown): RecipeContextReconcileRow['interpretation'] | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) {
    if (!INTERPRETATION_KEYS.has(key)) return undefined;
  }
  const lineRef = boundedString(raw['line_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  const role = oneOf(raw['role'], AI_RECIPE_CONTEXT_ROLES);
  if (lineRef === undefined || role === undefined) return undefined;
  const relations = canonicalizeRelations(raw['relations']);
  if (relations === undefined) return undefined;

  const rawHints = raw['preparation_hints'];
  const preparationHints: AiRecipeContextPreparationHint[] = [];
  if (rawHints !== undefined && rawHints !== null) {
    if (!Array.isArray(rawHints) || rawHints.length > MAX_RECIPE_CONTEXT_PREPARATION_HINTS) {
      return undefined;
    }
    for (const hint of rawHints) {
      const bounded = oneOf(hint, AI_RECIPE_CONTEXT_PREPARATION_HINTS);
      if (bounded === undefined) return undefined;
      preparationHints.push(bounded as AiRecipeContextPreparationHint);
    }
  }

  let confidence: AiRecipeContextConfidence | undefined;
  if (raw['confidence'] !== undefined && raw['confidence'] !== null) {
    const value = oneOf(raw['confidence'], AI_RECIPE_CONTEXT_CONFIDENCE_VALUES);
    if (value === undefined) return undefined;
    confidence = value as AiRecipeContextConfidence;
  }
  let abstainReason: AiRecipeContextAbstainReason | undefined;
  if (raw['abstain_reason'] !== undefined && raw['abstain_reason'] !== null) {
    const value = oneOf(raw['abstain_reason'], AI_RECIPE_CONTEXT_ABSTAIN_REASONS);
    if (value === undefined) return undefined;
    abstainReason = value as AiRecipeContextAbstainReason;
  }
  let explanation: string | undefined;
  if (raw['explanation'] !== undefined && raw['explanation'] !== null) {
    const value = boundedString(raw['explanation'], MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH);
    if (value === undefined) return undefined;
    explanation = value;
  }

  return Object.freeze({
    line_ref: lineRef,
    role: role as AiRecipeContextRole,
    relations: Object.freeze(relations),
    preparation_hints: Object.freeze(preparationHints),
    ...(confidence === undefined ? {} : { confidence }),
    ...(abstainReason === undefined ? {} : { abstain_reason: abstainReason }),
    ...(explanation === undefined ? {} : { explanation }),
  });
}

/**
 * Re-validates an AI-4D1 reconciliation that arrived from the network. The
 * server already validated it; this boundary re-establishes it, because the
 * reconciliation is the SOURCE TRUTH every decision is read from.
 */
function canonicalizeReconciliation(
  raw: unknown
): RecipeContextReconciliation | undefined {
  if (!isPlainObject(raw)) return undefined;
  for (const key of Object.keys(raw)) {
    if (!RECONCILIATION_KEYS.has(key)) return undefined;
  }
  if (raw['reconciliation_version'] !== AI_RECIPE_CONTEXT_RECONCILE_VERSION) return undefined;
  // Only a CURRENT plan may seed a review session. The status vocabulary is
  // closed to exactly one member, so "accepted"/"stale" cannot be expressed.
  if (raw['status'] !== 'current') return undefined;
  const requestId = boundedString(raw['request_id'], MAX_REQUEST_ID_LENGTH);
  const contextBinding = boundedString(raw['context_binding'], MAX_CONTEXT_BINDING_LENGTH);
  if (requestId === undefined || contextBinding === undefined) return undefined;

  const rawRows = raw['rows'];
  if (!Array.isArray(rawRows) || rawRows.length === 0 || rawRows.length > MAX_ROWS) return undefined;

  const rows: RecipeContextReconcileRow[] = [];
  const seen = new Set<string>();
  for (const entry of rawRows) {
    if (!isPlainObject(entry)) return undefined;
    for (const key of Object.keys(entry)) {
      if (!ROW_KEYS.has(key)) return undefined;
    }
    const category = oneOf(entry['category'], AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES);
    const lineRef = boundedString(entry['line_ref'], MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
    const sourceText = boundedString(entry['source_text'], MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH);
    if (category === undefined || lineRef === undefined || sourceText === undefined) return undefined;
    if (seen.has(lineRef)) return undefined;
    seen.add(lineRef);

    // Category/interpetation consistency is re-proved here: a reviewable or
    // abstained row must carry an interpretation, and `uninterpreted` must not.
    let interpretation: RecipeContextReconcileRow['interpretation'];
    let abstainReason: AiRecipeContextAbstainReason | undefined;
    if (category === 'uninterpreted') {
      if (entry['interpretation'] !== undefined || entry['abstain_reason'] !== undefined) return undefined;
    } else {
      interpretation = canonicalizeInterpretation(entry['interpretation']);
      if (interpretation === undefined) return undefined;
      if (interpretation.line_ref !== lineRef) return undefined;
      if (interpretation.abstain_reason !== undefined) {
        if (category !== 'abstained') return undefined;
        abstainReason = interpretation.abstain_reason;
      } else if (category === 'abstained') {
        return undefined;
      }
    }
    rows.push(
      Object.freeze({
        category: category as RecipeContextReconcileRow['category'],
        line_ref: lineRef,
        source_text: sourceText,
        ...(interpretation === undefined ? {} : { interpretation }),
        ...(abstainReason === undefined ? {} : { abstain_reason: abstainReason }),
      })
    );
  }

  return Object.freeze({
    reconciliation_version: AI_RECIPE_CONTEXT_RECONCILE_VERSION,
    request_id: requestId,
    context_binding: contextBinding,
    status: 'current' as const,
    rows: Object.freeze(rows),
    reviewable_count: rows.filter((row) => row.category === 'reviewable').length,
    abstained_count: rows.filter((row) => row.category === 'abstained').length,
    uninterpreted_count: rows.filter((row) => row.category === 'uninterpreted').length,
  });
}

function identityMatches(
  session: RecipeContextReviewSession,
  expected: RecipeContextSessionIdentity | undefined
): boolean {
  if (expected === undefined || expected === null) return false;
  const requestId = boundedString(expected.requestId, MAX_REQUEST_ID_LENGTH);
  const contextBinding = boundedString(expected.contextBinding, MAX_CONTEXT_BINDING_LENGTH);
  if (requestId === undefined || contextBinding === undefined) return false;
  return requestId === session.request_id && contextBinding === session.context_binding;
}

/**
 * The ONLY way to create a review session: a CURRENT AI-4D1 reconciliation whose
 * identity matches what the caller believes is current.
 *
 * A stale, mismatched, non-CURRENT or structurally invalid reconciliation can
 * never initialize a session, so there is nothing to accept, dismiss or undo.
 */
export function createRecipeContextReviewSession(input: {
  readonly reconciliation: unknown;
  readonly expected: RecipeContextSessionIdentity;
}): RecipeContextSessionResult {
  // The reconciliation crossed a network boundary: materialize before reading.
  const inert = toInertValue(input.reconciliation);
  if (!inert.ok) return fail('invalid_input');
  const reconciliation = canonicalizeReconciliation(inert.value);
  if (reconciliation === undefined) return fail('not_current');

  const requestId = boundedString(input.expected?.requestId, MAX_REQUEST_ID_LENGTH);
  const contextBinding = boundedString(input.expected?.contextBinding, MAX_CONTEXT_BINDING_LENGTH);
  if (requestId === undefined || contextBinding === undefined) return fail('invalid_input');
  // BOTH identities must hold: the same context AND the same operation.
  if (requestId !== reconciliation.request_id) return fail('not_current');
  if (contextBinding !== reconciliation.context_binding) return fail('not_current');

  return {
    ok: true,
    session: Object.freeze({
      session_version: AI_RECIPE_CONTEXT_SESSION_VERSION,
      request_id: reconciliation.request_id,
      context_binding: reconciliation.context_binding,
      reconciliation,
      // An EMPTY overlay: nothing is decided until the user decides.
      decisions: Object.freeze({}),
    }),
  };
}

function currentSession(
  session: unknown,
  expected: RecipeContextSessionIdentity | undefined
): RecipeContextReviewSession | undefined {
  if (!isPlainObject(session)) return undefined;
  for (const key of Object.keys(session)) {
    if (!SESSION_KEYS.has(key)) return undefined;
  }
  if (session['session_version'] !== AI_RECIPE_CONTEXT_SESSION_VERSION) return undefined;
  const reconciliation = canonicalizeReconciliation(session['reconciliation']);
  if (reconciliation === undefined) return undefined;
  const rawDecisions = session['decisions'];
  if (rawDecisions === undefined || rawDecisions === null) return undefined;
  if (!isPlainObject(rawDecisions)) return undefined;
  const decisions: Record<string, AiRecipeContextDecision> = {};
  for (const [lineRef, decision] of Object.entries(rawDecisions)) {
    if (lineRef.length === 0 || lineRef.length > MAX_RECIPE_CONTEXT_LINE_REF_LENGTH) return undefined;
    if (typeof decision !== 'string') return undefined;
    if (!(AI_RECIPE_CONTEXT_DECISIONS as ReadonlyArray<string>).includes(decision)) return undefined;
    // A decision may only name a row that exists in the current review.
    if (!reconciliation.rows.some((row) => row.line_ref === lineRef)) return undefined;
    decisions[lineRef] = decision as AiRecipeContextDecision;
  }
  const requestId = boundedString(session['request_id'], MAX_REQUEST_ID_LENGTH);
  const contextBinding = boundedString(session['context_binding'], MAX_CONTEXT_BINDING_LENGTH);
  if (requestId === undefined || contextBinding === undefined) return undefined;
  if (requestId !== reconciliation.request_id || contextBinding !== reconciliation.context_binding) {
    return undefined;
  }
  const built: RecipeContextReviewSession = Object.freeze({
    session_version: AI_RECIPE_CONTEXT_SESSION_VERSION,
    request_id: requestId,
    context_binding: contextBinding,
    reconciliation,
    decisions: Object.freeze(decisions),
  });
  return identityMatches(built, expected) ? built : undefined;
}

function withDecisions(
  session: RecipeContextReviewSession,
  decisions: Record<string, AiRecipeContextDecision>
): RecipeContextReviewSession {
  return Object.freeze({
    session_version: AI_RECIPE_CONTEXT_SESSION_VERSION,
    request_id: session.request_id,
    context_binding: session.context_binding,
    reconciliation: session.reconciliation,
    decisions: Object.freeze(decisions),
  });
}

/**
 * ACCEPT one row. The action carries ONLY `line_ref`: the canonical
 * interpretation is read from the CURRENT review plan, so no caller can supply a
 * replacement role, relation, hint, confidence or explanation.
 */
export function acceptRecipeContextRow(
  session: unknown,
  lineRef: unknown,
  expected?: RecipeContextSessionIdentity
): RecipeContextSessionResult {
  const current = currentSession(session, expected);
  if (current === undefined) return fail('not_current');
  const ref = boundedString(lineRef, MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  if (ref === undefined) return fail('invalid_input');
  const row = current.reconciliation.rows.find((entry) => entry.line_ref === ref);
  if (row === undefined) return fail('unknown_row');
  // Only a pending REVIEWABLE row may be accepted: never abstained, never
  // uninterpreted, and never a row the model declined to interpret.
  if (row.category !== 'reviewable' || row.interpretation === undefined) {
    return fail('not_acceptable');
  }
  // No direct switch: a decided row must be UNDONE first.
  if (current.decisions[ref] !== undefined) return fail('already_decided');
  return { ok: true, session: withDecisions(current, { ...current.decisions, [ref]: 'accepted' }) };
}

/**
 * DISMISS one row. Dismiss is a USER REVIEW CHOICE, not semantic authority: it
 * asserts nothing, suppresses nothing, and only removes the row from this
 * session's accepted context.
 */
export function dismissRecipeContextRow(
  session: unknown,
  lineRef: unknown,
  expected?: RecipeContextSessionIdentity
): RecipeContextSessionResult {
  const current = currentSession(session, expected);
  if (current === undefined) return fail('not_current');
  const ref = boundedString(lineRef, MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  if (ref === undefined) return fail('invalid_input');
  const row = current.reconciliation.rows.find((entry) => entry.line_ref === ref);
  if (row === undefined) return fail('unknown_row');
  if (row.category !== 'reviewable' || row.interpretation === undefined) {
    return fail('not_acceptable');
  }
  if (current.decisions[ref] !== undefined) return fail('already_decided');
  return { ok: true, session: withDecisions(current, { ...current.decisions, [ref]: 'dismissed' }) };
}

/**
 * UNDO one decision, restoring the row to its exact original pending state. The
 * underlying reconciliation is never mutated, so the restored review output is
 * byte-equivalent to the pre-decision state — there is no history to corrupt.
 */
export function undoRecipeContextRow(
  session: unknown,
  lineRef: unknown,
  expected?: RecipeContextSessionIdentity
): RecipeContextSessionResult {
  const current = currentSession(session, expected);
  if (current === undefined) return fail('not_current');
  const ref = boundedString(lineRef, MAX_RECIPE_CONTEXT_LINE_REF_LENGTH);
  if (ref === undefined) return fail('invalid_input');
  if (!current.reconciliation.rows.some((row) => row.line_ref === ref)) return fail('unknown_row');
  if (current.decisions[ref] === undefined) return fail('nothing_to_undo');
  const next = { ...current.decisions };
  delete next[ref];
  return { ok: true, session: withDecisions(current, next) };
}

/** The display projection. Decides nothing; carries no authority. */
export function recipeContextReviewView(
  session: unknown,
  expected?: RecipeContextSessionIdentity
): RecipeContextReviewViewResult {
  const current = currentSession(session, expected);
  if (current === undefined) return fail('not_current');

  let pending = 0;
  let accepted = 0;
  let dismissed = 0;
  let abstained = 0;
  let uninterpreted = 0;

  const rows: RecipeContextReviewRowView[] = current.reconciliation.rows.map((row) => {
    const decision = current.decisions[row.line_ref];
    const interpretation = row.interpretation;
    let status: AiRecipeContextReviewStatus;
    if (decision === 'accepted') {
      status = 'accepted';
      accepted += 1;
    } else if (decision === 'dismissed') {
      status = 'dismissed';
      dismissed += 1;
    } else if (row.category === 'abstained') {
      status = 'abstained';
      abstained += 1;
    } else if (row.category === 'uninterpreted') {
      status = 'uninterpreted';
      uninterpreted += 1;
    } else {
      status = 'pending';
      pending += 1;
    }
    const decided = decision !== undefined;
    const reviewable = row.category === 'reviewable' && interpretation !== undefined;
    return Object.freeze({
      line_ref: row.line_ref,
      source_text: row.source_text,
      status,
      ...(interpretation?.role === undefined ? {} : { role: interpretation.role }),
      preparation_hints: Object.freeze([...(interpretation?.preparation_hints ?? [])]),
      relations: Object.freeze([...(interpretation?.relations ?? [])]),
      ...(interpretation?.confidence === undefined ? {} : { confidence: interpretation.confidence }),
      ...(interpretation?.explanation === undefined ? {} : { explanation: interpretation.explanation }),
      ...(row.abstain_reason === undefined ? {} : { abstain_reason: row.abstain_reason }),
      accept_capable: reviewable && !decided,
      dismiss_capable: reviewable && !decided,
      undo_capable: decided,
    });
  });

  return {
    ok: true,
    view: Object.freeze({
      session_version: AI_RECIPE_CONTEXT_SESSION_VERSION,
      request_id: current.request_id,
      context_binding: current.context_binding,
      rows: Object.freeze(rows),
      pending_count: pending,
      accepted_count: accepted,
      dismissed_count: dismissed,
      abstained_count: abstained,
      uninterpreted_count: uninterpreted,
    }),
  };
}

/**
 * The ONE session-only accepted-context projection.
 *
 * It contains only EXPLICITLY accepted canonical reviewable interpretations, and
 * only the semantic claims the user actually accepted: `line_ref`, `role`,
 * `relations`, `preparation_hints`. `confidence` and `explanation` are display
 * metadata and deliberately do not become operational authority; `abstain_reason`
 * can never appear here.
 *
 * THERE IS NO DOWNSTREAM CONSUMER YET. This value is inert: it is not persisted,
 * not sent to any route, and not read by nutrition calculation, AI-3, effective
 * mass, Apply or persistence.
 */
export function projectAcceptedRecipeContext(
  session: unknown,
  expected?: RecipeContextSessionIdentity
): AcceptedRecipeContextResult {
  const current = currentSession(session, expected);
  if (current === undefined) return fail('not_current');

  const accepted: AcceptedRecipeContextEntry[] = [];
  // CURRENT deterministic plan order, never decision order.
  for (const row of current.reconciliation.rows) {
    if (current.decisions[row.line_ref] !== 'accepted') continue;
    const interpretation = row.interpretation;
    // Defense in depth: an accepted entry can only ever come from a reviewable
    // row that carries an interpretation with no abstention.
    if (row.category !== 'reviewable' || interpretation === undefined) continue;
    if (interpretation.abstain_reason !== undefined) continue;
    accepted.push(
      Object.freeze({
        line_ref: interpretation.line_ref,
        role: interpretation.role,
        relations: Object.freeze([...interpretation.relations]),
        preparation_hints: Object.freeze([...interpretation.preparation_hints]),
      })
    );
  }

  return {
    ok: true,
    accepted: Object.freeze({
      accepted_version: AI_RECIPE_CONTEXT_ACCEPTED_VERSION,
      request_id: current.request_id,
      context_binding: current.context_binding,
      accepted: Object.freeze(accepted),
    }),
  };
}

/** True only when the session still belongs to the given identity. */
export function isRecipeContextReviewSessionCurrent(
  session: unknown,
  expected: RecipeContextSessionIdentity
): boolean {
  return currentSession(session, expected) !== undefined;
}

/**
 * A new AI-4 request id ALWAYS starts a new review session, even when the recipe
 * context is byte-identical: a second AI run may return a different
 * interpretation, so prior decisions must not silently transfer.
 */
export function isSameRecipeContextReview(
  session: unknown,
  next: { readonly request_id: unknown; readonly context_binding: unknown }
): boolean {
  if (!isPlainObject(session)) return false;
  const requestId = boundedString(next?.request_id, MAX_REQUEST_ID_LENGTH);
  const contextBinding = boundedString(next?.context_binding, MAX_CONTEXT_BINDING_LENGTH);
  if (requestId === undefined || contextBinding === undefined) return false;
  return (
    session['request_id'] === requestId && session['context_binding'] === contextBinding
  );
}
