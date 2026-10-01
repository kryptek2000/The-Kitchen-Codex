/**
 * AI-4D2 — FOCUSED EXPLICIT-ACCEPTANCE + SESSION-ONLY ACCEPTED-CONTEXT TESTS.
 *
 * Covers the required cases A–Q:
 *   A. session creation (CURRENT only)      B. refusal to seed a review
 *   C. accept a reviewable row              D. abstained is not acceptable
 *   E. uninterpreted is not acceptable      F. dismiss has no semantic effect
 *   G. byte-truthful undo                   H. no direct switch
 *   I. minimal overlay                      J. minimal accepted projection
 *   K. line_ref-only acceptance             L. row-level relation acceptance
 *   M. stale actions fail closed            N. new request id = new review
 *   O. determinism + immutability           P. provider isolation
 *   Q. hostile input                        R. view/status counts
 *
 * NOTHING here is mocked: every reconciliation is produced by the REAL AI-4D1
 * reconciler over a REAL server-side derivation, so the plan under review is the
 * plan the product actually uses.
 */
import { describe, it, expect, vi } from 'vitest';

import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../../src/core/nutritionV2/aiRecipeContextRequest';
import { AI_RECIPE_CONTEXT_RECONCILE_VERSION } from '../../src/core/nutritionV2/aiRecipeContextReconcile';
import {
  AI_RECIPE_CONTEXT_ACCEPTED_VERSION,
  AI_RECIPE_CONTEXT_SESSION_VERSION,
  acceptRecipeContextRow,
  createRecipeContextReviewSession,
  dismissRecipeContextRow,
  isRecipeContextReviewSessionCurrent,
  isSameRecipeContextReview,
  projectAcceptedRecipeContext,
  recipeContextReviewView,
  undoRecipeContextRow,
  type AcceptedRecipeContextSession,
  type RecipeContextReviewSession,
  type RecipeContextReviewView,
} from '../../src/core/nutritionV2/aiRecipeContextSession';
import { reconcileRecipeContext } from '../../src/core/nutritionV2/aiRecipeContextReconcile';

// ---------------------------------------------------------------------------
// The provider is a PROVABILITY GUARD: if the acceptance core ever reached for
// it, the import would throw.
// ---------------------------------------------------------------------------
vi.mock('../../server/ai/provider.js', () => {
  throw new Error('AI-4D2 acceptance must never reach the provider');
});

const { deriveRecipeContextModelInput } = await import('../../server/recipeContextDerivation.js');

function codeOf(result: unknown): string {
  return String((result as { code?: string }).code);
}

const LINES: ReadonlyArray<string> = [
  '400 g chicken',
  '1/2 cup marinade',
  '2 tbsp parsley, for garnish',
  '2 cups dough',
];
const INSTRUCTIONS: ReadonlyArray<string> = [
  'Reserve half the chicken for the sauce',
  'Discard the marinade',
  'Garnish with parsley',
  'Divide the dough into two portions',
];

function recipe(lines: ReadonlyArray<string> = LINES): Record<string, unknown> {
  return {
    title: 'Acceptance probe',
    servings: 4,
    ingredients: lines.map((original) => ({ original })),
  };
}

function currentPlan(options: {
  readonly requestId?: string;
  readonly lines?: ReadonlyArray<string>;
  readonly instructions?: ReadonlyArray<string>;
  readonly interpretations?: ReadonlyArray<Record<string, unknown>>;
  readonly omit?: ReadonlyArray<number>;
  readonly abstain?: ReadonlyArray<number>;
} = {}) {
  const requestId = options.requestId ?? 'ai4d2-request-1';
  const lines = options.lines ?? LINES;
  const instructions = options.instructions ?? INSTRUCTIONS;
  const derived = deriveRecipeContextModelInput({
    recipe: recipe(lines),
    instructions: instructions.map((text) => ({ text })),
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId,
    recipeInstance: 'instance-1',
  });
  if (!derived.ok) throw new Error(`derivation failed: ${codeOf(derived)}`);
  const refs = derived.request.provider_request.targets.map((target) => target.line_ref);
  const omit = new Set(options.omit ?? []);
  const abstain = new Set(options.abstain ?? []);
  const interpretations = refs
    .map((ref, index) => ({ ref, index }))
    .filter(({ index }) => !omit.has(index))
    .map(({ ref, index }) => {
      if (abstain.has(index)) {
        return {
          line_ref: ref,
          role: 'main',
          relations: [],
          preparation_hints: [],
          abstain_reason: 'insufficient_evidence',
        };
      }
      return { line_ref: ref, role: 'main', relations: [], preparation_hints: [] };
    });
  const reconciled = reconcileRecipeContext({
    wire: {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: requestId,
      context_binding: derived.request.model_input_binding,
      proposal: {
        contract_version: 'nutrition_ai_recipe_context_v1',
        provenance_class: 'ai_recipe_context',
        interpretations: options.interpretations ?? interpretations,
      },
    },
    expectedRequestId: requestId,
    current: {
      context_binding: derived.request.model_input_binding,
      targets: derived.request.provider_request.targets.map((target) => ({
        line_ref: target.line_ref,
        source_text: target.source_text,
      })),
    },
  });
  if (!reconciled.ok) throw new Error(`reconciliation failed: ${codeOf(reconciled)}`);
  return reconciled.reconciliation;
}

function open(options: Parameters<typeof currentPlan>[0] = {}): {
  readonly session: RecipeContextReviewSession;
  readonly requestId: string;
  readonly contextBinding: string;
  readonly refs: ReadonlyArray<string>;
} {
  const requestId = options?.requestId ?? 'ai4d2-request-1';
  const plan = currentPlan({ ...options, requestId });
  const contextBinding = plan.context_binding;
  const created = createRecipeContextReviewSession({
    reconciliation: plan,
    expected: { requestId, contextBinding },
  });
  if (!created.ok) throw new Error(`session creation failed: ${codeOf(created)}`);
  return {
    session: created.session,
    requestId,
    contextBinding,
    refs: plan.rows.map((row) => row.line_ref),
  };
}

const identityOf = (open_: { requestId: string; contextBinding: string }) => ({
  requestId: open_.requestId,
  contextBinding: open_.contextBinding,
});

function viewOf(
  session: RecipeContextReviewSession,
  open_: { requestId: string; contextBinding: string }
): RecipeContextReviewView {
  const view = recipeContextReviewView(session, identityOf(open_));
  if (!view.ok) throw new Error(`view failed: ${codeOf(view)}`);
  return view.view;
}

function acceptedOf(
  session: RecipeContextReviewSession,
  open_: { requestId: string; contextBinding: string }
): AcceptedRecipeContextSession {
  const projected = projectAcceptedRecipeContext(session, identityOf(open_));
  if (!projected.ok) throw new Error(`projection failed: ${codeOf(projected)}`);
  return projected.accepted;
}

function accept(
  session: RecipeContextReviewSession,
  lineRef: string,
  open_: { requestId: string; contextBinding: string }
): RecipeContextReviewSession {
  const result = acceptRecipeContextRow(session, lineRef, identityOf(open_));
  if (!result.ok) throw new Error(`accept failed: ${codeOf(result)}`);
  return result.session;
}

function dismiss(
  session: RecipeContextReviewSession,
  lineRef: string,
  open_: { requestId: string; contextBinding: string }
): RecipeContextReviewSession {
  const result = dismissRecipeContextRow(session, lineRef, identityOf(open_));
  if (!result.ok) throw new Error(`dismiss failed: ${codeOf(result)}`);
  return result.session;
}

function undo(
  session: RecipeContextReviewSession,
  lineRef: string,
  open_: { requestId: string; contextBinding: string }
): RecipeContextReviewSession {
  const result = undoRecipeContextRow(session, lineRef, identityOf(open_));
  if (!result.ok) throw new Error(`undo failed: ${codeOf(result)}`);
  return result.session;
}

// ===========================================================================
// A. SESSION CREATION (CURRENT ONLY)
// ===========================================================================
describe('AI-4D2 A — a review session is created only from a CURRENT plan', () => {
  it('creates an immutable session with an empty decision overlay', () => {
    const opened = open();
    expect(opened.session.session_version).toBe(AI_RECIPE_CONTEXT_SESSION_VERSION);
    expect(opened.session.request_id).toBe(opened.requestId);
    expect(opened.session.context_binding).toBe(opened.contextBinding);
    // NOTHING is decided until the user decides.
    expect(opened.session.decisions).toEqual({});
    expect(viewOf(opened.session, opened).rows.every((row) => row.status === 'pending')).toBe(true);
  });

  it('the session carries the AI-4D1 plan verbatim as source truth', () => {
    const plan = currentPlan();
    const created = createRecipeContextReviewSession({
      reconciliation: plan,
      expected: { requestId: plan.request_id, contextBinding: plan.context_binding },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.session.reconciliation).toEqual(plan);
    expect(created.session.reconciliation.reconciliation_version).toBe(
      AI_RECIPE_CONTEXT_RECONCILE_VERSION
    );
  });

  it('every row of the review is present, in CURRENT deterministic order', () => {
    const opened = open();
    const view = viewOf(opened.session, opened);
    expect(view.rows).toHaveLength(opened.refs.length);
    expect(view.rows.map((row) => row.line_ref)).toEqual(opened.refs);
  });
});

// ===========================================================================
// B. REFUSAL TO SEED A REVIEW
// ===========================================================================
describe('AI-4D2 B — a review cannot be seeded without a matching CURRENT identity', () => {
  it('a different request id cannot seed a session', () => {
    const plan = currentPlan();
    const created = createRecipeContextReviewSession({
      reconciliation: plan,
      expected: { requestId: 'ai4d2-request-other', contextBinding: plan.context_binding },
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(codeOf(created)).toBe('not_current');
  });

  it('a different context binding cannot seed a session', () => {
    const plan = currentPlan();
    const created = createRecipeContextReviewSession({
      reconciliation: plan,
      expected: { requestId: plan.request_id, contextBinding: 'stale-binding' },
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(codeOf(created)).toBe('not_current');
  });

  it('a reconciliation carrying an unexpected key is refused outright', () => {
    const plan = currentPlan() as unknown as Record<string, unknown>;
    const forged = { ...plan, accepted: true };
    const created = createRecipeContextReviewSession({
      reconciliation: forged,
      expected: { requestId: plan['request_id'], contextBinding: plan['context_binding'] },
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(codeOf(created)).toBe('not_current');
  });

  it('a reviewable row carrying its own abstain_reason cannot be seeded', () => {
    const plan = currentPlan();
    const rows = plan.rows.map((row) =>
      row.category === 'reviewable'
        ? { ...row, interpretation: { ...row.interpretation, abstain_reason: 'insufficient_evidence' } }
        : row
    );
    const created = createRecipeContextReviewSession({
      reconciliation: { ...plan, rows, reviewable_count: rows.length, abstained_count: 0, uninterpreted_count: 0 },
      expected: { requestId: plan.request_id, contextBinding: plan.context_binding },
    });
    expect(created.ok).toBe(false);
  });
});

// ===========================================================================
// C. ACCEPT A REVIEWABLE ROW
// ===========================================================================
describe('AI-4D2 C — accepting a reviewable row requires the user', () => {
  it('accept produces session-only accepted context for exactly that row', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const projected = acceptedOf(accepted, opened);
    expect(projected.accepted_version).toBe(AI_RECIPE_CONTEXT_ACCEPTED_VERSION);
    expect(projected.request_id).toBe(opened.requestId);
    expect(projected.context_binding).toBe(opened.contextBinding);
    expect(projected.accepted).toHaveLength(1);
    expect(projected.accepted[0].line_ref).toBe(opened.refs[0]);
    expect(viewOf(accepted, opened).rows[0].status).toBe('accepted');
  });

  it('accepting one row does not accept its siblings', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const view = viewOf(accepted, opened);
    expect(view.accepted_count).toBe(1);
    expect(view.pending_count).toBe(opened.refs.length - 1);
    expect(view.rows.slice(1).every((row) => row.status === 'pending')).toBe(true);
  });

  it('an accepted interpretation is displayed as the user accepted it', () => {
    const opened = open({
      interpretations: [
        {
          line_ref: openedRef(),
          role: 'reserved',
          relations: [],
          preparation_hints: ['reserved'],
          confidence: 'high',
          explanation: 'the instruction says so',
        },
      ],
      omit: [1, 2, 3],
    });
    const accepted = accept(opened.session, opened.refs[0], opened);
    const row = viewOf(accepted, opened).rows[0];
    expect(row.status).toBe('accepted');
    expect(row.role).toBe('reserved');
    expect(row.preparation_hints).toEqual(['reserved']);
    // Advisory display metadata is still shown…
    expect(row.confidence).toBe('high');
    expect(row.explanation).toBe('the instruction says so');
  });

  /** The FIRST deterministic target's line ref, without opening a session first. */
  function openedRef(): string {
    return currentPlan().rows[0].line_ref;
  }

  it('a high-confidence interpretation is still pending until accepted', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    expect(acceptedOf(opened.session, opened).accepted).toHaveLength(0);
    expect(acceptedOf(accepted, opened).accepted).toHaveLength(1);
  });
});

// ===========================================================================
// D. ABSTAINED IS NOT ACCEPTABLE
// ===========================================================================
describe('AI-4D2 D — an abstained row may never be accepted', () => {
  it('abstaining a row removes it from acceptance capability', () => {
    const opened = open({ abstain: [1] });
    const row = viewOf(opened.session, opened).rows[1];
    expect(row.status).toBe('abstained');
    expect(row.accept_capable).toBe(false);
    expect(row.dismiss_capable).toBe(false);
    expect(row.undo_capable).toBe(false);
    expect(row.abstain_reason).toBe('insufficient_evidence');
  });

  it('accept is refused and leaves the session untouched', () => {
    const opened = open({ abstain: [1] });
    const result = acceptRecipeContextRow(opened.session, opened.refs[1], identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('not_acceptable');
    expect(opened.session.decisions).toEqual({});
    expect(acceptedOf(opened.session, opened).accepted).toHaveLength(0);
  });

  it('dismiss is refused for the same reason', () => {
    const opened = open({ abstain: [1] });
    const result = dismissRecipeContextRow(opened.session, opened.refs[1], identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('not_acceptable');
  });

  it('an abstention reason can never appear in accepted context', () => {
    const opened = open({ abstain: [0] });
    const projected = acceptedOf(opened.session, opened);
    expect(projected.accepted).toHaveLength(0);
    expect(JSON.stringify(projected)).not.toContain('abstain_reason');
    expect(JSON.stringify(projected)).not.toContain('insufficient_evidence');
  });
});

// ===========================================================================
// E. UNINTERPRETED IS NOT ACCEPTABLE
// ===========================================================================
describe('AI-4D2 E — an uninterpreted row may never be accepted', () => {
  it('an omitted line stays uninterpreted and is not acceptance-capable', () => {
    const opened = open({ omit: [2] });
    const row = viewOf(opened.session, opened).rows[2];
    expect(row.status).toBe('uninterpreted');
    expect(row.accept_capable).toBe(false);
    expect(row.role).toBeUndefined();
    expect(row.relations).toEqual([]);
    expect(row.preparation_hints).toEqual([]);
  });

  it('accept is refused, and nothing is inferred for the omitted line', () => {
    const opened = open({ omit: [2] });
    const result = acceptRecipeContextRow(opened.session, opened.refs[2], identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('not_acceptable');
    expect(acceptedOf(opened.session, opened).accepted).toHaveLength(0);
  });
});

// ===========================================================================
// F. DISMISS HAS NO SEMANTIC EFFECT
// ===========================================================================
describe('AI-4D2 F — dismiss is a review choice, never semantic authority', () => {
  it('a dismissed row leaves accepted context empty', () => {
    const opened = open();
    const dismissed = dismiss(opened.session, opened.refs[0], opened);
    expect(viewOf(dismissed, opened).rows[0].status).toBe('dismissed');
    expect(acceptedOf(dismissed, opened).accepted).toHaveLength(0);
  });

  it('dismiss asserts nothing about the line: no consumption, no negation, no suppression', () => {
    const opened = open();
    const dismissed = dismiss(opened.session, opened.refs[0], opened);
    const row = viewOf(dismissed, opened).rows[0];
    // The interpretation is still shown verbatim: dismissal is not a claim that
    // the interpretation is wrong, consumed, or superseded.
    expect(row.role).toBe('main');
    expect(row.status).toBe('dismissed');
    // A dismiss decision carries no semantic payload at all.
    expect(Object.keys(dismissed.decisions)).toEqual([opened.refs[0]]);
    expect(dismissed.decisions[opened.refs[0]]).toBe('dismissed');
    expect(JSON.stringify(dismissed.decisions[opened.refs[0]])).toBe('"dismissed"');
  });

  it('dismissing a row does not suppress or enable any sibling', () => {
    const opened = open();
    const dismissed = dismiss(opened.session, opened.refs[0], opened);
    const view = viewOf(dismissed, opened);
    expect(view.dismissed_count).toBe(1);
    expect(view.pending_count).toBe(opened.refs.length - 1);
    expect(view.accepted_count).toBe(0);
  });
});

// ===========================================================================
// G. BYTE-TRUTHFUL UNDO
// ===========================================================================
describe('AI-4D2 G — undo restores the row exactly', () => {
  it('accept then undo is byte-equivalent to never deciding', () => {
    const opened = open();
    const before = JSON.stringify(viewOf(opened.session, opened));
    const accepted = accept(opened.session, opened.refs[0], opened);
    expect(JSON.stringify(viewOf(accepted, opened))).not.toBe(before);
    const restored = undo(accepted, opened.refs[0], opened);
    expect(JSON.stringify(viewOf(restored, opened))).toBe(before);
    expect(restored.decisions).toEqual({});
  });

  it('dismiss then undo is byte-equivalent to never deciding', () => {
    const opened = open();
    const before = JSON.stringify(viewOf(opened.session, opened));
    const restored = undo(dismiss(opened.session, opened.refs[1], opened), opened.refs[1], opened);
    expect(JSON.stringify(viewOf(restored, opened))).toBe(before);
  });

  it('undo never damages the source plan it was layered over', () => {
    const opened = open();
    const plan = JSON.stringify(opened.session.reconciliation);
    const accepted = accept(opened.session, opened.refs[0], opened);
    const restored = undo(accepted, opened.refs[0], opened);
    expect(JSON.stringify(restored.reconciliation)).toBe(plan);
  });

  it('undo with nothing to undo is refused', () => {
    const opened = open();
    const result = undoRecipeContextRow(opened.session, opened.refs[0], identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('nothing_to_undo');
  });

  it('undoing an unknown line is refused', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const result = undoRecipeContextRow(accepted, 'line_does_not_exist', identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('unknown_row');
  });

  it('undo of a stale session is refused', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const result = undoRecipeContextRow(accepted, opened.refs[0], {
      requestId: opened.requestId,
      contextBinding: 'stale-binding',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('not_current');
  });
});

// ===========================================================================
// H. NO DIRECT SWITCH
// ===========================================================================
describe('AI-4D2 H — a decided row may only be changed through undo', () => {
  it('accepted then dismissed is refused', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const result = dismissRecipeContextRow(accepted, opened.refs[0], identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('already_decided');
    expect(accepted.decisions[opened.refs[0]]).toBe('accepted');
  });

  it('dismissed then accepted is refused', () => {
    const opened = open();
    const dismissed = dismiss(opened.session, opened.refs[0], opened);
    const result = acceptRecipeContextRow(dismissed, opened.refs[0], identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('already_decided');
    expect(dismissed.decisions[opened.refs[0]]).toBe('dismissed');
  });

  it('accepting twice is refused', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const result = acceptRecipeContextRow(accepted, opened.refs[0], identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('already_decided');
  });

  it('undo then re-accept works and is the only path back to accepted', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const pending = undo(accepted, opened.refs[0], opened);
    const reaccepted = accept(pending, opened.refs[0], opened);
    expect(viewOf(reaccepted, opened).rows[0].status).toBe('accepted');
    expect(acceptedOf(reaccepted, opened).accepted).toHaveLength(1);
  });
});

// ===========================================================================
// I. MINIMAL OVERLAY
// ===========================================================================
describe('AI-4D2 I — the overlay records only explicit user decisions', () => {
  it('accepted context is empty before any decision', () => {
    const opened = open();
    expect(acceptedOf(opened.session, opened).accepted).toEqual([]);
  });

  it('only decided rows appear, and pending rows are absent entirely', () => {
    const opened = open();
    let session = accept(opened.session, opened.refs[0], opened);
    session = dismiss(session, opened.refs[3], opened);
    const projected = acceptedOf(session, opened);
    expect(projected.accepted.map((entry) => entry.line_ref)).toEqual([opened.refs[0]]);
    expect(Object.keys(session.decisions).sort()).toEqual(
      [opened.refs[0], opened.refs[3]].sort()
    );
  });

  it('the overlay holds only the closed decision vocabulary', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    expect(
      Object.values(accepted.decisions).every(
        (decision) => decision === 'accepted' || decision === 'dismissed'
      )
    ).toBe(true);
  });

  it('a decision naming a row that is not in the review is refused as unknown', () => {
    const opened = open();
    const result = acceptRecipeContextRow(opened.session, 'no_such_line', identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('unknown_row');
  });
});

// ===========================================================================
// J. MINIMAL ACCEPTED PROJECTION
// ===========================================================================
describe('AI-4D2 J — accepted context carries only accepted semantics', () => {
  it('the projection has exactly the accepted-semantics keys', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const entry = acceptedOf(accepted, opened).accepted[0];
    expect(Object.keys(entry).sort()).toEqual([
      'line_ref',
      'preparation_hints',
      'relations',
      'role',
    ]);
  });

  it('confidence and explanation never become accepted authority', () => {
    const plan = currentPlan();
    const firstRef = plan.rows[0].line_ref;
    const opened = open({
      interpretations: [
        {
          line_ref: firstRef,
          role: 'garnish',
          relations: [],
          preparation_hints: ['garnish'],
          confidence: 'high',
          explanation: 'garnish appears last',
        },
      ],
      omit: [1, 2, 3],
    });
    const accepted = accept(opened.session, firstRef, opened);
    const entry = acceptedOf(accepted, opened).accepted[0];
    expect(entry.role).toBe('garnish');
    expect(entry.preparation_hints).toEqual(['garnish']);
    // High confidence does not travel with the accepted context.
    expect(entry).not.toHaveProperty('confidence');
    expect(entry).not.toHaveProperty('explanation');
    const serialized = JSON.stringify(acceptedOf(accepted, opened));
    expect(serialized).not.toContain('confidence');
    expect(serialized).not.toContain('garnish appears last');
  });

  it('accepted entries appear in CURRENT deterministic order, not decision order', () => {
    const opened = open();
    let session = accept(opened.session, opened.refs[3], opened);
    session = accept(session, opened.refs[0], opened);
    const projected = acceptedOf(session, opened);
    expect(projected.accepted.map((entry) => entry.line_ref)).toEqual([
      opened.refs[0],
      opened.refs[3],
    ]);
  });
});

// ===========================================================================
// K. LINE-REF-ONLY ACCEPTANCE
// ===========================================================================
describe('AI-4D2 K — an accept action carries only a line_ref', () => {
  it('the accepted interpretation is read from the plan, never from the caller', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    expect(acceptedOf(accepted, opened).accepted[0]).toEqual({
      line_ref: opened.refs[0],
      role: 'main',
      relations: [],
      preparation_hints: [],
    });
  });

  it('an accept attempt carrying a caller-authored interpretation is refused', () => {
    const opened = open();
    // The action accepts only a line ref; anything else is unusable input.
    const forged = {
      line_ref: opened.refs[0],
      role: 'component',
      relations: [],
      preparation_hints: [],
      confidence: 'high',
    };
    const result = acceptRecipeContextRow(opened.session, forged, identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('invalid_input');
    expect(opened.session.decisions).toEqual({});
  });

  it('a non-string line ref is refused', () => {
    const opened = open();
    for (const bogus of [42, null, undefined, {}, [], true]) {
      const result = acceptRecipeContextRow(opened.session, bogus, identityOf(opened));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codeOf(result)).toBe('invalid_input');
    }
  });
});

// ===========================================================================
// L. ROW-LEVEL RELATION ACCEPTANCE
// ===========================================================================
describe('AI-4D2 L — accepting a row accepts that row’s relation claims', () => {
  function relatingOpen(): {
    readonly session: RecipeContextReviewSession;
    readonly requestId: string;
    readonly contextBinding: string;
    readonly refs: ReadonlyArray<string>;
  } {
    const refs = currentPlan().rows.map((row) => row.line_ref);
    return open({
      interpretations: [
        {
          line_ref: refs[0],
          role: 'reserved',
          relations: [{ kind: 'reserved_from', target_ref: refs[1] }],
          preparation_hints: ['reserved'],
        },
        { line_ref: refs[1], role: 'main', relations: [], preparation_hints: [] },
      ],
      omit: [2, 3],
    });
  }

  it('the accepted row carries its relation; the target stays independently pending', () => {
    const opened = relatingOpen();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const projected = acceptedOf(accepted, opened);
    expect(projected.accepted).toHaveLength(1);
    expect(projected.accepted[0].relations).toEqual([
      { kind: 'reserved_from', target_ref: opened.refs[1] },
    ]);
    // The relation TARGET did not need its own interpretation accepted.
    const view = viewOf(accepted, opened);
    expect(view.rows[1].status).toBe('pending');
    expect(view.accepted_count).toBe(1);
  });

  it('accepting the target separately does not modify the other row', () => {
    const opened = relatingOpen();
    let session = accept(opened.session, opened.refs[0], opened);
    session = accept(session, opened.refs[1], opened);
    const projected = acceptedOf(session, opened);
    expect(projected.accepted.map((entry) => entry.line_ref)).toEqual([
      opened.refs[0],
      opened.refs[1],
    ]);
    expect(projected.accepted[0].relations).toEqual([
      { kind: 'reserved_from', target_ref: opened.refs[1] },
    ]);
    expect(projected.accepted[1].relations).toEqual([]);
  });

  it('dismissing the target does not retract the source row’s accepted relation', () => {
    const opened = relatingOpen();
    let session = accept(opened.session, opened.refs[0], opened);
    session = dismiss(session, opened.refs[1], opened);
    const projected = acceptedOf(session, opened);
    expect(projected.accepted).toHaveLength(1);
    expect(projected.accepted[0].relations).toEqual([
      { kind: 'reserved_from', target_ref: opened.refs[1] },
    ]);
  });
});

// ===========================================================================
// M. STALE ACTIONS FAIL CLOSED
// ===========================================================================
describe('AI-4D2 M — a stale review cannot be accepted, dismissed or undone', () => {
  it('accept against a changed context binding fails closed and changes nothing', () => {
    const opened = open();
    const result = acceptRecipeContextRow(opened.session, opened.refs[0], {
      requestId: opened.requestId,
      contextBinding: 'binding-after-edit',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('not_current');
    expect(opened.session.decisions).toEqual({});
    expect(acceptedOf(opened.session, opened).accepted).toHaveLength(0);
  });

  it('dismiss against a changed request id fails closed', () => {
    const opened = open();
    const result = dismissRecipeContextRow(opened.session, opened.refs[0], {
      requestId: 'a-new-request',
      contextBinding: opened.contextBinding,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('not_current');
  });

  it('an action with no identity expectation at all is refused', () => {
    const opened = open();
    expect(acceptRecipeContextRow(opened.session, opened.refs[0]).ok).toBe(false);
    expect(dismissRecipeContextRow(opened.session, opened.refs[0]).ok).toBe(false);
    expect(undoRecipeContextRow(opened.session, opened.refs[0]).ok).toBe(false);
  });

  it('a session is current only for its exact identity', () => {
    const opened = open();
    expect(isRecipeContextReviewSessionCurrent(opened.session, identityOf(opened))).toBe(true);
    expect(
      isRecipeContextReviewSessionCurrent(opened.session, {
        requestId: opened.requestId,
        contextBinding: 'binding-after-edit',
      })
    ).toBe(false);
    expect(
      isRecipeContextReviewSessionCurrent(opened.session, {
        requestId: 'a-new-request',
        contextBinding: opened.contextBinding,
      })
    ).toBe(false);
  });

  it('a stale session cannot be projected into accepted context', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const projected = projectAcceptedRecipeContext(accepted, {
      requestId: opened.requestId,
      contextBinding: 'binding-after-edit',
    });
    expect(projected.ok).toBe(false);
    if (projected.ok) return;
    expect(codeOf(projected)).toBe('not_current');
  });

  it('a stale session cannot be viewed either', () => {
    const opened = open();
    const view = recipeContextReviewView(opened.session, {
      requestId: opened.requestId,
      contextBinding: 'binding-after-edit',
    });
    expect(view.ok).toBe(false);
    if (view.ok) return;
    expect(codeOf(view)).toBe('not_current');
  });

  it('an edited recipe produces a different binding, so the old review is stale', () => {
    const opened = open();
    const edited = open({ lines: ['400 g chicken', '1 cup marinade', '2 cups dough'] });
    expect(edited.contextBinding).not.toBe(opened.contextBinding);
    expect(
      isRecipeContextReviewSessionCurrent(opened.session, {
        requestId: opened.requestId,
        contextBinding: edited.contextBinding,
      })
    ).toBe(false);
  });
});

// ===========================================================================
// N. NEW REQUEST ID = NEW REVIEW
// ===========================================================================
describe('AI-4D2 N — a second AI run never inherits prior decisions', () => {
  it('the same recipe under a new request id is not the same review', () => {
    const first = open({ requestId: 'run-1' });
    const second = open({ requestId: 'run-2' });
    // Identical recipe semantics, different operation.
    expect(second.contextBinding).toBe(first.contextBinding);
    expect(
      isSameRecipeContextReview(first.session, {
        request_id: second.requestId,
        context_binding: second.contextBinding,
      })
    ).toBe(false);
  });

  it('decisions from one run are not accepted context in another run', () => {
    const first = open({ requestId: 'run-1' });
    const accepted = accept(first.session, first.refs[0], first);
    expect(acceptedOf(accepted, first).accepted).toHaveLength(1);
    // The second run's session carries nothing from the first.
    const second = open({ requestId: 'run-2' });
    expect(acceptedOf(second.session, second).accepted).toHaveLength(0);
    expect(second.session.decisions).toEqual({});
  });

  it('the same request id and binding IS the same review', () => {
    const opened = open();
    expect(
      isSameRecipeContextReview(opened.session, {
        request_id: opened.requestId,
        context_binding: opened.contextBinding,
      })
    ).toBe(true);
  });
});

// ===========================================================================
// O. DETERMINISM + IMMUTABILITY
// ===========================================================================
describe('AI-4D2 O — sessions and projections are immutable and deterministic', () => {
  it('every decision produces a frozen session and a frozen projection', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.decisions)).toBe(true);
    expect(Object.isFrozen(accepted.reconciliation)).toBe(true);
    expect(Object.isFrozen(acceptedOf(accepted, opened))).toBe(true);
    expect(Object.isFrozen(acceptedOf(accepted, opened).accepted)).toBe(true);
  });

  it('the previous session is unchanged by a later decision', () => {
    const opened = open();
    const first = accept(opened.session, opened.refs[0], opened);
    const second = accept(first, opened.refs[1], opened);
    expect(first.decisions).toEqual({ [opened.refs[0]]: 'accepted' });
    expect(Object.keys(second.decisions)).toHaveLength(2);
  });

  it('a write attempt against the frozen overlay cannot leak state', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    try {
      (accepted.decisions as Record<string, string>)[opened.refs[1]] = 'accepted';
    } catch {
      // Frozen objects may throw in strict mode; either way nothing changes.
    }
    expect(Object.keys(accepted.decisions)).toEqual([opened.refs[0]]);
    expect(acceptedOf(accepted, opened).accepted).toHaveLength(1);
  });

  it('the same decision sequence yields byte-identical views and projections', () => {
    const build = () => {
      const opened = open();
      let session = accept(opened.session, opened.refs[0], opened);
      session = dismiss(session, opened.refs[1], opened);
      session = accept(session, opened.refs[2], opened);
      return {
        view: JSON.stringify(viewOf(session, opened)),
        accepted: JSON.stringify(acceptedOf(session, opened)),
      };
    };
    expect(build()).toEqual(build());
  });
});

// ===========================================================================
// P. PROVIDER ISOLATION
// ===========================================================================
describe('AI-4D2 P — acceptance is offline and provider-free', () => {
  it('accept, dismiss, undo, view and projection perform no network call', () => {
    const opened = open();
    const fetchSpy = vi.fn(() => {
      throw new Error('AI-4D2 acceptance must not perform any network call');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;
    try {
      let session = accept(opened.session, opened.refs[0], opened);
      session = dismiss(session, opened.refs[1], opened);
      session = undo(session, opened.refs[0], opened);
      viewOf(session, opened);
      acceptedOf(session, opened);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepted context carries no quantity, mass, nutrient or FDC authority', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    const serialized = JSON.stringify(acceptedOf(accepted, opened)).toLowerCase();
    for (const forbidden of [
      'grams',
      'grams_value',
      'fdc_id',
      'nutrient',
      'nutrients',
      'portion',
      'calories',
      'quantity',
      'mass',
      'percent_daily_value',
      'serving',
      'applied',
      'match_choice',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// Q. HOSTILE INPUT
// ===========================================================================
describe('AI-4D2 Q — hostile session input is refused', () => {
  it('a null, primitive or array session is refused', () => {
    const opened = open();
    for (const bogus of [null, undefined, 0, '', 'session', [], true]) {
      const result = acceptRecipeContextRow(bogus, opened.refs[0], identityOf(opened));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codeOf(result)).toBe('not_current');
    }
  });

  it('a session carrying an unexpected key is refused', () => {
    const opened = open();
    const forged = { ...opened.session, apply: true };
    const result = acceptRecipeContextRow(forged, opened.refs[0], identityOf(opened));
    expect(result.ok).toBe(false);
  });

  it('an overlay naming an unknown line is refused', () => {
    const opened = open();
    const forged = { ...opened.session, decisions: { not_a_real_line: 'accepted' } };
    const result = recipeContextReviewView(forged, identityOf(opened));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('not_current');
  });

  it('an overlay with a value outside the closed vocabulary is refused', () => {
    const opened = open();
    const forged = { ...opened.session, decisions: { [opened.refs[0]]: 'auto_accepted' } };
    const result = recipeContextReviewView(forged, identityOf(opened));
    expect(result.ok).toBe(false);
  });

  it('a get accessor on the reconciliation never executes', () => {
    const opened = open();
    let touched = false;
    const trap = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'status') {
            touched = true;
            return 'current';
          }
          return undefined;
        },
        ownKeys() {
          touched = true;
          return [];
        },
      }
    );
    void trap;
    // The real hostile shape: an accessor that throws if read.
    const hostile = {
      ...opened.session.reconciliation,
      get status(): string {
        touched = true;
        return 'current';
      },
    };
    const created = createRecipeContextReviewSession({
      reconciliation: hostile,
      expected: identityOf(opened),
    });
    // Materialization strips accessors rather than invoking them.
    expect(touched).toBe(false);
    expect(created.ok).toBe(false);
  });

  it('a session whose identity contradicts its plan is refused', () => {
    const opened = open();
    const forged = { ...opened.session, context_binding: 'forged-binding' };
    const result = recipeContextReviewView(forged, identityOf(opened));
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// R. VIEW + STATUS COUNTS
// ===========================================================================
describe('AI-4D2 R — the review view reports every row and status honestly', () => {
  it('counts cover every row exactly once', () => {
    const opened = open({ abstain: [3], omit: [2] });
    let session = accept(opened.session, opened.refs[0], opened);
    session = dismiss(session, opened.refs[1], opened);
    const view = viewOf(session, opened);
    expect(view.rows).toHaveLength(opened.refs.length);
    const total =
      view.accepted_count + view.dismissed_count + view.pending_count + view.abstained_count + view.uninterpreted_count;
    expect(total).toBe(view.rows.length);
    expect(view.accepted_count).toBe(1);
    expect(view.dismissed_count).toBe(1);
    expect(view.abstained_count).toBe(1);
    expect(view.uninterpreted_count).toBe(1);
    // Every other current target is still untouched and pending.
    expect(view.pending_count).toBe(opened.refs.length - 4);
  });

  it('undo makes a row acceptance-capable again', () => {
    const opened = open();
    const accepted = accept(opened.session, opened.refs[0], opened);
    expect(viewOf(accepted, opened).rows[0].accept_capable).toBe(false);
    expect(viewOf(accepted, opened).rows[0].undo_capable).toBe(true);
    const restored = undo(accepted, opened.refs[0], opened);
    expect(viewOf(restored, opened).rows[0].accept_capable).toBe(true);
    expect(viewOf(restored, opened).rows[0].undo_capable).toBe(false);
  });

  it('the view carries the identity a consumer can re-check', () => {
    const opened = open();
    const view = viewOf(opened.session, opened);
    expect(view.request_id).toBe(opened.requestId);
    expect(view.context_binding).toBe(opened.contextBinding);
  });
});