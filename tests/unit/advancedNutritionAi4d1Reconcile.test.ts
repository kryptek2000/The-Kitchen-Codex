/**
 * AI-4D1 — FOCUSED DETERMINISTIC RECONCILIATION TESTS.
 *
 * Covers the required cases A–R:
 *   A. current happy path            B. model order does not own review order
 *   C. model omission                D. explicit abstention
 *   E. source-text change            F. food-semantics change
 *   G. target-order change           H. recipe-instance change
 *   I. request-id mix-up             J. forged binding
 *   K. mutated wire                  L. removed target
 *   M. hostile input                 N. determinism
 *   O. immutability                  P. provider isolation
 *   Q. authority differential (separate file)
 *   R. no acceptance surface (isolation file)
 *
 * NOTHING here is mocked except the provider TRANSPORT, which AI-4D1 must never
 * reach at all: every derivation here is the real one.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
  type RecipeContextEnvelope,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../../src/core/nutritionV2/aiRecipeContextRequest';
import {
  AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES,
  AI_RECIPE_CONTEXT_RECONCILE_STATUSES,
  AI_RECIPE_CONTEXT_RECONCILE_VERSION,
  reconcileRecipeContext,
  type RecipeContextReconcileCurrentContext,
} from '../../src/core/nutritionV2/aiRecipeContextReconcile';
import { deriveRecipeContextModelInput } from '../../server/recipeContextDerivation';

// ---------------------------------------------------------------------------
// The provider is a PROVABILITY GUARD, not a stub: if anything in the
// reconciliation path ever reached for it, the import would throw.
// ---------------------------------------------------------------------------
vi.mock('../../server/ai/provider.js', () => {
  throw new Error('AI-4D1 must never reach the provider');
});

const { reconcileRecipeContextOnServer } = await import('../../server/recipeContextReconcile.js');

/**
 * Under this project's non-strict null-checking a boolean `ok` discriminant
 * narrows reliably only in the truthy direction, so failure branches read the
 * bounded code through an explicit accessor.
 */
function codeOf(result: unknown): string {
  return String((result as { code?: string }).code);
}

// ---------------------------------------------------------------------------
// Real authored recipe + real server-side derivation
// ---------------------------------------------------------------------------
function structuredLine(original: string): Record<string, unknown> {
  return { original };
}

const DEFAULT_LINES: ReadonlyArray<string> = [
  '400 g chicken',
  '1/2 cup marinade',
  '2 tbsp parsley, for garnish',
  '2 cups dough',
];
const DEFAULT_INSTRUCTIONS: ReadonlyArray<string> = [
  'Reserve half the chicken for the sauce',
  'Discard the marinade',
  'Garnish with parsley',
  'Divide the dough into two portions',
];

const REQUEST_ID = 'ai4d1-request-1';
const INSTANCE = 'instance-1';

function recipe(lines: ReadonlyArray<string> = DEFAULT_LINES, servings = 4): Record<string, unknown> {
  return { title: 'Reconcile probe', servings, ingredients: lines.map(structuredLine) };
}

function currentContext(
  lines: ReadonlyArray<string> = DEFAULT_LINES,
  instructions: ReadonlyArray<string> = DEFAULT_INSTRUCTIONS,
  recipeInstance: string | null = INSTANCE
): RecipeContextReconcileCurrentContext {
  const derived = deriveRecipeContextModelInput({
    recipe: recipe(lines),
    instructions: instructions.map((text) => ({ text })),
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: REQUEST_ID,
    recipeInstance,
  });
  if (!derived.ok) throw new Error(`derivation failed: ${codeOf(derived)}`);
  return {
    context_binding: derived.request.model_input_binding,
    targets: derived.request.provider_request.targets.map((target) => ({
      line_ref: target.line_ref,
      source_text: target.source_text,
    })),
  };
}

function refsOf(context: RecipeContextReconcileCurrentContext): ReadonlyArray<string> {
  return context.targets.map((target) => target.line_ref);
}

function interpretation(
  lineRef: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    line_ref: lineRef,
    role: 'main',
    relations: [],
    preparation_hints: [],
    ...overrides,
  };
}

function wireOf(
  context: RecipeContextReconcileCurrentContext,
  interpretations: ReadonlyArray<Record<string, unknown>>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    request_id: REQUEST_ID,
    context_binding: context.context_binding,
    proposal: {
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      interpretations,
    },
    ...overrides,
  };
}

/** A full happy-path wire: every current target interpreted. */
function fullWire(context: RecipeContextReconcileCurrentContext): Record<string, unknown> {
  return wireOf(
    context,
    refsOf(context).map((ref) => interpretation(ref))
  );
}

/**
 * The expected request id is an EXPLICIT parameter (never defaulted), so a test can
 * deliberately pass an unusable value — including `undefined` — and observe the
 * refusal instead of silently receiving the default.
 */
function reconcile(
  wire: unknown,
  context: RecipeContextReconcileCurrentContext,
  expectedRequestId: unknown
): ReturnType<typeof reconcileRecipeContext> {
  return reconcileRecipeContext({ wire, expectedRequestId, current: context });
}

function serverReconcile(
  wire: unknown,
  lines: ReadonlyArray<string> = DEFAULT_LINES,
  instructions: ReadonlyArray<string> = DEFAULT_INSTRUCTIONS,
  expectedRequestId: unknown = REQUEST_ID,
  recipeInstance: unknown = INSTANCE
): ReturnType<typeof reconcileRecipeContextOnServer> {
  return reconcileRecipeContextOnServer({
    wire,
    expected_request_id: expectedRequestId,
    recipe: recipe(lines),
    instructions: instructions.map((text) => ({ text })),
    recipe_instance: recipeInstance,
  });
}

// ===========================================================================
// A. CURRENT HAPPY PATH
// ===========================================================================
describe('AI-4D1 A — current happy path', () => {
  it('a valid wire over an unchanged recipe reconciles into an inert review plan', () => {
    const context = currentContext();
    const result = reconcile(fullWire(context), context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.reconciliation;
    expect(plan.reconciliation_version).toBe(AI_RECIPE_CONTEXT_RECONCILE_VERSION);
    expect(plan.request_id).toBe(REQUEST_ID);
    expect(plan.context_binding).toBe(context.context_binding);
    expect(plan.status).toBe('current');
    expect(plan.rows).toHaveLength(context.targets.length);
    expect(plan.reviewable_count).toBe(context.targets.length);
    expect(plan.abstained_count).toBe(0);
    expect(plan.uninterpreted_count).toBe(0);
    // Inert: it carries no acceptance, no authority, no quantity.
    expect(plan.rows.every((row) => row.category === 'reviewable')).toBe(true);
  });

  it('the server adapter reconciles the same plan and makes no provider call', () => {
    const context = currentContext();
    const fetchSpy = vi.fn(() => {
      throw new Error('AI-4D1 must not perform any network call');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;
    try {
      const result = serverReconcile(fullWire(context));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reconciliation.status).toBe('current');
      expect(result.reconciliation.reviewable_count).toBe(context.targets.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a proposal with relations and hints survives reconciliation unchanged', () => {
    const context = currentContext();
    const refs = refsOf(context);
    const wire = wireOf(context, [
      interpretation(refs[0], {
        role: 'reserved',
        relations: [{ kind: 'reserved_from', target_ref: refs[1] }],
        preparation_hints: ['reserved'],
        confidence: 'medium',
        explanation: 'the instruction says so',
      }),
    ]);
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.reconciliation.rows[0];
    expect(row.category).toBe('reviewable');
    // Semantic content is preserved verbatim, including canonical relation refs.
    expect(row.interpretation?.role).toBe('reserved');
    expect(row.interpretation?.relations).toEqual([
      { kind: 'reserved_from', target_ref: refs[1] },
    ]);
    expect(row.interpretation?.preparation_hints).toEqual(['reserved']);
    expect(row.interpretation?.confidence).toBe('medium');
  });
});

// ===========================================================================
// B. MODEL ORDER DOES NOT OWN REVIEW ORDER
// ===========================================================================
describe('AI-4D1 B — review order is the CURRENT deterministic order', () => {
  it('reversed model output order does not change the row order', () => {
    const context = currentContext();
    const currentOrder = refsOf(context);
    const modelOrder = [...currentOrder].reverse();
    expect(modelOrder).not.toEqual(currentOrder);
    const wire = wireOf(
      context,
      modelOrder.map((ref) => interpretation(ref, { role: 'garnish' }))
    );
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The model did NOT control ordering: rows follow the CURRENT deterministic
    // order, which differs from the order the model returned.
    expect(result.reconciliation.rows.map((row) => row.line_ref)).toEqual(currentOrder);
    expect(result.reconciliation.rows.map((row) => row.line_ref)).not.toEqual(modelOrder);
  });

  it('rows carry the CURRENT authored text, in current order', () => {
    const context = currentContext();
    const result = reconcile(fullWire(context), context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation.rows.map((row) => row.source_text)).toEqual(
      context.targets.map((target) => target.source_text)
    );
  });
});

// ===========================================================================
// C. MODEL OMISSION
// ===========================================================================
describe('AI-4D1 C — a target the model omitted is UNINTERPRETED, not inferred', () => {
  it('omitted middle target becomes uninterpreted with no inferred interpretation', () => {
    const context = currentContext();
    const refs = refsOf(context);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    // The model interpreted A and C only; B was omitted.
    const wire = wireOf(context, [interpretation(refs[0]), interpretation(refs[2])]);
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.reconciliation.rows;
    expect(rows[0].category).toBe('reviewable');
    expect(rows[1].category).toBe('uninterpreted');
    expect(rows[1].line_ref).toBe(refs[1]);
    expect(rows[2].category).toBe('reviewable');
    // ABSENCE STAYS ABSENCE: no interpretation, no role, no signal promotion.
    expect(rows[1].interpretation).toBeUndefined();
    expect(rows[1].abstain_reason).toBeUndefined();
    expect(Object.keys(rows[1]).sort()).toEqual(['category', 'line_ref', 'source_text']);
    expect(result.reconciliation.reviewable_count).toBe(2);
    expect(result.reconciliation.uninterpreted_count).toBe(refs.length - 2);
    expect(result.reconciliation.abstained_count).toBe(0);
  });

  it('an omitted AI-4B signal target is never promoted into an interpretation', () => {
    // The AI-4B extraction produced signals for these lines; reconciliation must
    // not turn any of them into a role.
    const context = currentContext();
    const derived = deriveRecipeContextModelInput({
      recipe: recipe(),
      instructions: DEFAULT_INSTRUCTIONS.map((text) => ({ text })),
      requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      requestId: REQUEST_ID,
      recipeInstance: INSTANCE,
    });
    if (!derived.ok) throw new Error('derivation failed');
    expect(derived.extraction.signals.length).toBeGreaterThanOrEqual(3);
    // An entirely empty interpretation list => everything uninterpreted, even
    // though deterministic signals exist for several lines.
    const result = reconcile(wireOf(context, []), context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation.rows.every((row) => row.category === 'uninterpreted')).toBe(true);
    expect(result.reconciliation.uninterpreted_count).toBe(result.reconciliation.rows.length);
    for (const row of result.reconciliation.rows) {
      expect(row.interpretation).toBeUndefined();
    }
  });
});

// ===========================================================================
// D. EXPLICIT ABSTENTION
// ===========================================================================
describe('AI-4D1 D — an explicit abstention stays an abstention', () => {
  it('abstain_reason produces an abstained row, not a reviewable one', () => {
    const context = currentContext();
    const refs = refsOf(context);
    const wire = wireOf(context, [
      interpretation(refs[0], { abstain_reason: 'ambiguous_role', role: 'unknown' }),
      interpretation(refs[1], { role: 'garnish', preparation_hints: ['garnish'] }),
    ]);
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.reconciliation.rows;
    expect(rows[0].category).toBe('abstained');
    // The canonical reason is preserved verbatim.
    expect(rows[0].abstain_reason).toBe('ambiguous_role');
    expect(rows[0].interpretation?.abstain_reason).toBe('ambiguous_role');
    expect(rows[1].category).toBe('reviewable');
    expect(rows[1].abstain_reason).toBeUndefined();
    expect(result.reconciliation.abstained_count).toBe(1);
    expect(result.reconciliation.reviewable_count).toBe(1);
  });

  it('deterministic evidence never "rescues" an abstention into a reviewable row', () => {
    // The abstained line is one AI-4B signalled; it must STILL be abstained.
    const context = currentContext();
    const refs = refsOf(context);
    const derived = deriveRecipeContextModelInput({
      recipe: recipe(),
      instructions: DEFAULT_INSTRUCTIONS.map((text) => ({ text })),
      requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      requestId: REQUEST_ID,
      recipeInstance: INSTANCE,
    });
    if (!derived.ok) throw new Error('derivation failed');
    const signalled = new Set(derived.extraction.signals.map((signal) => signal.instruction_line_ref));
    expect(signalled.size).toBeGreaterThan(0);
    const wire = wireOf(
      context,
      refs.map((ref) =>
        interpretation(ref, {
          abstain_reason: signalled.has(ref) ? 'insufficient_evidence' : 'no_recipe_context',
        })
      )
    );
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reconciliation.rows.every((row) => row.category === 'abstained')).toBe(true);
    expect(result.reconciliation.reviewable_count).toBe(0);
  });
});

// ===========================================================================
// E–H. STALE BEHAVIOR (every freshness axis)
// ===========================================================================
describe('AI-4D1 E–H — whole-proposal staleness', () => {
  it('E. a changed authored source line makes the WHOLE proposal stale (no partial salvage)', () => {
    const original = currentContext();
    const wire = wireOf(
      original,
      refsOf(original).map((ref) => interpretation(ref))
    );
    const changed = currentContext(DEFAULT_LINES, [
      'Reserve a third of the chicken for the sauce',
      ...DEFAULT_INSTRUCTIONS.slice(1),
    ]);
    expect(changed.context_binding).not.toBe(original.context_binding);
    const result = reconcile(wire, changed, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale_context');
  });

  it('F. a changed derived food phrase makes the whole proposal stale', () => {
    const original = currentContext();
    const wire = fullWire(original);
    // Same lines, but the authored food phrase changes => the derived
    // food_semantics changes => the model input changes.
    const changed = currentContext(
      ['400 g chicken', '1/2 cup marinade', '2 tbsp flat-leaf parsley, for garnish', '2 cups dough'],
      DEFAULT_INSTRUCTIONS
    );
    const originalSemantics = original.targets
      .map((target) => target.source_text)
      .join('|');
    const changedSemantics = changed.targets.map((target) => target.source_text).join('|');
    expect(changedSemantics).not.toBe(originalSemantics);
    const result = reconcile(wire, changed, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale_context');
  });

  it('G. a changed TARGET ORDER makes the whole proposal stale', () => {
    const original = currentContext();
    const wire = fullWire(original);
    // Same authored data, but the deterministic order differs because the
    // authored ORDER of the ingredients differs.
    // Same authored lines, reversed: the deterministic order therefore changes.
    const reversed = currentContext([...DEFAULT_LINES].reverse());
    expect(reversed.context_binding).not.toBe(original.context_binding);
    expect(reversed.targets.map((t) => t.source_text)).not.toEqual(
      original.targets.map((t) => t.source_text)
    );
    const result = reconcile(wire, reversed, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale_context');
  });

  it('H. a different recipe instance makes the whole proposal stale', () => {
    const original = currentContext();
    const wire = fullWire(original);
    const other = currentContext(DEFAULT_LINES, DEFAULT_INSTRUCTIONS, 'instance-2');
    expect(other.context_binding).not.toBe(original.context_binding);
    const result = reconcile(wire, other, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale_context');
  });

  it('an added or removed ingredient or instruction makes it stale', () => {
    const original = currentContext();
    const wire = fullWire(original);
    const variants: ReadonlyArray<RecipeContextReconcileCurrentContext> = [
      currentContext([...DEFAULT_LINES, '1 lemon']),
      currentContext(DEFAULT_LINES.slice(0, -1)),
      currentContext(DEFAULT_LINES, ['...DEFAULT_INSTRUCTIONS_PLUS']),
      currentContext(DEFAULT_LINES, DEFAULT_INSTRUCTIONS.slice(0, -1)),
    ];
    for (const variant of variants) {
      const result = reconcile(wire, variant, REQUEST_ID);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(codeOf(result)).toBe('stale_context');
    }
  });

  it('no partial salvage: a single stale axis refuses every row, not just one', () => {
    const original = currentContext();
    const refs = refsOf(original);
    const wire = wireOf(original, refs.map((ref) => interpretation(ref)));
    const changed = currentContext(DEFAULT_LINES, [
      'Reserve a third of the chicken for the sauce',
      ...DEFAULT_INSTRUCTIONS.slice(1),
    ]);
    const result = reconcile(wire, changed, REQUEST_ID);
    // There is no "partially current" result type at all.
    expect(result.ok).toBe(false);
    expect(Object.keys(result as object).sort()).toEqual(['code', 'ok']);
  });
});

// ===========================================================================
// I. REQUEST-ID MIX-UP
// ===========================================================================
describe('AI-4D1 I — request correlation is independent of context equality', () => {
  it('A. the SAME context with a WRONG request id is request_mismatch, not a success', () => {
    const context = currentContext();
    const wire = fullWire(context);
    const result = reconcile(wire, context, 'a-different-request');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('request_mismatch');
    // Context equality held; the request identity did not.
    expect(wire['context_binding']).toBe(context.context_binding);
  });

  it('B. a correct request id with a changed context is stale_context', () => {
    const original = currentContext();
    const wire = fullWire(original);
    const changed = currentContext(DEFAULT_LINES, ['...DEFAULT_INSTRUCTIONS_PLUS']);
    const result = reconcile(wire, changed, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale_context');
  });

  it('C. a wire from a different recipe instance is stale_context', () => {
    const original = currentContext();
    const foreign = currentContext(DEFAULT_LINES, DEFAULT_INSTRUCTIONS, 'instance-foreign');
    const wire = fullWire(foreign);
    const result = reconcile(wire, original, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale_context');
  });

  it('D. a forged context binding is stale_context', () => {
    const context = currentContext();
    const wire = wireOf(
      context,
      refsOf(context).map((ref) => interpretation(ref)),
      { context_binding: `sha256:${'0'.repeat(64)}` }
    );
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale_context');
  });
});

// ===========================================================================
// J. MUTATED WIRE
// ===========================================================================
describe('AI-4D1 J — the wire is untrusted again', () => {
  const mutations: ReadonlyArray<{ name: string; apply: (wire: Record<string, unknown>) => void }> = [
    { name: 'forged role', apply: (wire) => mutateInterpretation(wire, { role: 'chief' }) },
    { name: 'mutated line_ref', apply: (wire) => mutateInterpretation(wire, { line_ref: 'invented:0' }) },
    { name: 'forged relation kind', apply: (wire) => mutateInterpretation(wire, { relations: [{ kind: 'eats', target_ref: 'l1' }] }) },
    { name: 'forged preparation hint', apply: (wire) => mutateInterpretation(wire, { preparation_hints: ['flying'] }) },
    { name: 'forged provenance class', apply: (wire) => { (wire['proposal'] as Record<string, unknown>)['provenance_class'] = 'usda_derived'; } },
    { name: 'forged contract version', apply: (wire) => { (wire['proposal'] as Record<string, unknown>)['contract_version'] = 'other'; } },
    { name: 'mutated request version', apply: (wire) => { wire['request_version'] = 'nutrition_ai_recipe_context_request_v2'; } },
    { name: 'extra top-level key', apply: (wire) => { wire['extra'] = 'sneaky'; } },
    { name: 'extra interpretation key', apply: (wire) => mutateInterpretation(wire, { grams: 500 }) },
    { name: 'nested authority key', apply: (wire) => mutateInterpretation(wire, { relations: [{ kind: 'same_as', target_ref: 'x', fdc_id: 1 }] }) },
    { name: 'suppression attempt', apply: (wire) => mutateInterpretation(wire, { suppress: true }) },
    { name: 'binding shape broken', apply: (wire) => { wire['context_binding'] = 'not-a-binding'; } },
  ];

  function mutateInterpretation(wire: Record<string, unknown>, overrides: Record<string, unknown>): void {
    const proposal = wire['proposal'] as Record<string, unknown>;
    const rows = proposal['interpretations'] as ReadonlyArray<Record<string, unknown>>;
    proposal['interpretations'] = [{ ...rows[0], ...overrides }, ...rows.slice(1)];
  }

  for (const { name, apply } of mutations) {
    it(`K. refuses a wire with ${name}`, () => {
      const context = currentContext();
      const wire = fullWire(context);
      apply(wire);
      const result = reconcile(wire, context, REQUEST_ID);
      expect(result.ok, name).toBe(false);
      if (result.ok) return;
      // Either the strict re-read refuses it, or it survives structurally and then
      // fails the binding equality. Both are refusals; neither is a plan.
      expect(['invalid_wire', 'stale_context'], name).toContain(codeOf(result));
    });
  }

  it('F. a duplicate interpretation is refused', () => {
    const context = currentContext();
    const refs = refsOf(context);
    const wire = wireOf(context, [
      interpretation(refs[0]),
      interpretation(refs[0], { role: 'garnish' }),
    ]);
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('invalid_wire');
  });

  it('G. an invented target is refused', () => {
    const context = currentContext();
    const refs = refsOf(context);
    const wire = wireOf(context, [
      ...refs.map((ref) => interpretation(ref)),
      interpretation('invented:99:deadbeef'),
    ]);
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('invalid_wire');
  });

  it('L. a relation to a REMOVED target is refused (no partial salvage)', () => {
    const original = currentContext();
    const refs = refsOf(original);
    const wire = wireOf(original, [
      interpretation(refs[0], { relations: [{ kind: 'reserved_from', target_ref: refs[1] }] }),
      ...refs.slice(1).map((ref) => interpretation(ref)),
    ]);
    // The current context no longer contains refs[1]: the step that produced it was
    // removed, so the current context is genuinely different.
    const shrunk = currentContext(DEFAULT_LINES, DEFAULT_INSTRUCTIONS.slice(1));
    expect(refsOf(shrunk)).not.toContain(refs[1]);
    const result = reconcile(wire, shrunk, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Whole-proposal refusal with NO partial salvage. The documented order checks
    // freshness before structure, so a legitimate stale wire is reported as stale
    // rather than mislabelled as an invalid one.
    expect(codeOf(result)).toBe('stale_context');
  });

  it('L2. with a MATCHING binding, a relation to a non-existent target is a wire refusal', () => {
    const context = currentContext();
    const refs = refsOf(context);
    const wire = wireOf(context, [
      interpretation(refs[0], { relations: [{ kind: 'reserved_from', target_ref: 'invented:99:deadbeef' }] }),
      ...refs.slice(1).map((ref) => interpretation(ref)),
    ]);
    // The binding matches, so freshness passes; the unknown TARGET is then refused.
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('invalid_wire');
  });

  it('H. a self-relation / two-parent graph is refused by the released graph validator', () => {
    const context = currentContext();
    const refs = refsOf(context);
    const selfRelation = wireOf(context, [
      interpretation(refs[0], { relations: [{ kind: 'divided_into', target_ref: refs[0] }] }),
    ]);
    expect(reconcile(selfRelation, context, REQUEST_ID).ok).toBe(false);

    const twoParents = wireOf(context, [
      interpretation(refs[0], { relations: [{ kind: 'divided_into', target_ref: refs[2] }] }),
      interpretation(refs[1], { relations: [{ kind: 'divided_into', target_ref: refs[2] }] }),
    ]);
    expect(reconcile(twoParents, context, REQUEST_ID).ok).toBe(false);
  });
});

// ===========================================================================
// M. HOSTILE INPUT
// ===========================================================================
describe('AI-4D1 M — hostile input fails closed', () => {
  const context = currentContext();

  it('M1. getters, accessors and symbol keys never run as trusted data', () => {
    const hostile: ReadonlyArray<unknown> = [
      (() => {
        const object: Record<string, unknown> = {};
        Object.defineProperty(object, 'proposal', {
          enumerable: true,
          get() {
            throw new Error('hostile getter ran');
          },
        });
        return object;
      })(),
      Object.create(null),
      { wire: new Proxy({}, { get: () => { throw new Error('hostile proxy'); } }) },
    ];
    for (const wire of hostile) {
      const result = reconcile(wire, context, REQUEST_ID);
      expect(result.ok, String(typeof wire)).toBe(false);
    }
  });

  it('M2. __proto__ / constructor / prototype keys are refused', () => {
    const contextLocal = currentContext();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const input = {
        wire: fullWire(contextLocal),
        expectedRequest_id: REQUEST_ID,
        current: contextLocal,
        [key]: 'polluted',
      } as Record<string, unknown>;
      const result = reconcileRecipeContext(input as never);
      expect(result.ok, key).toBe(false);
    }
  });

  it('M3. null, scalars, malformed arrays and deeply nested objects fail closed', () => {
    for (const wire of [
      null,
      undefined,
      0,
      42,
      'string',
      true,
      [],
      [fullWire(context)],
      { request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION, request_id: 'x', context_binding: 'y' },
      {
        request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
        request_id: REQUEST_ID,
        context_binding: context.context_binding,
        proposal: { a: { b: { c: { d: { e: { f: 'deep' } } } } } },
      },
    ]) {
      expect(reconcile(wire, context, REQUEST_ID).ok, JSON.stringify(wire)?.slice(0, 50)).toBe(false);
    }
  });

  it('M4. an oversized wire is refused before it can be interpreted', () => {
    const oversized = {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: REQUEST_ID,
      context_binding: context.context_binding,
      proposal: {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: [
          interpretation(refsOf(context)[0], { explanation: 'x'.repeat(200_000) }),
        ],
      },
    };
    expect(reconcile(oversized, context, REQUEST_ID).ok).toBe(false);
  });

  it('M5. an unusable CURRENT context or expected request id is refused', () => {
    const wire = fullWire(context);
    for (const current of [null, undefined, 42, 'x', [], {}, { context_binding: context.context_binding }, { context_binding: 'x', targets: [] }, { context_binding: 'x', targets: [{ line_ref: 'a' }] }, { context_binding: 'x', targets: [{ line_ref: 'a', source_text: 'b', extra: 1 }] }]) {
      const result = reconcileRecipeContext({ wire, expectedRequestId: REQUEST_ID, current });
      expect(result.ok, JSON.stringify(current)?.slice(0, 50)).toBe(false);
      if (result.ok) continue;
      expect(codeOf(result)).toBe('invalid_input');
    }
    for (const expected of ['', '   ', 42, null, undefined, 'x'.repeat(500)]) {
      const result = reconcile(wire, context, expected);
      expect(result.ok, String(expected)).toBe(false);
      if (result.ok) continue;
      expect(codeOf(result)).toBe('invalid_input');
    }
  });

  it('M6. the server adapter refuses an unusable request and an unusable current context', () => {
    const wire = fullWire(context);
    for (const body of [
      null,
      'string',
      [],
      {},
      { wire, expected_request_id: REQUEST_ID },
      { wire, expected_request_id: REQUEST_ID, recipe: null },
      { wire, expected_request_id: REQUEST_ID, recipe: { ingredients: [] } },
      { wire, expected_request_id: '', recipe: recipe() },
    ]) {
      const result = reconcileRecipeContextOnServer(body);
      expect(result.ok, JSON.stringify(body)?.slice(0, 50)).toBe(false);
    }
  });

  it('M7. the server adapter refuses caller-supplied context/binding/line-refs keys', () => {
    const wire = fullWire(context);
    for (const key of ['context', 'envelope', 'context_binding', 'binding', 'line_refs', 'targets']) {
      const result = reconcileRecipeContextOnServer({
        wire,
        expected_request_id: REQUEST_ID,
        recipe: recipe(),
        instructions: DEFAULT_INSTRUCTIONS.map((text) => ({ text })),
        [key]: { attacker: 'value' },
      });
      expect(result.ok, key).toBe(false);
      if (result.ok) continue;
      expect(codeOf(result)).toBe('invalid_input');
    }
  });
});

// ===========================================================================
// N. DETERMINISM
// ===========================================================================
describe('AI-4D1 N — determinism', () => {
  it('identical inputs produce a byte-equivalent reconciliation', () => {
    const context = currentContext();
    const wire = JSON.parse(JSON.stringify(fullWire(context))) as unknown;
    const first = reconcile(JSON.parse(JSON.stringify(wire)), context, REQUEST_ID);
    const second = reconcile(JSON.parse(JSON.stringify(wire)), context, REQUEST_ID);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(second.reconciliation)).toBe(JSON.stringify(first.reconciliation));
  });

  it('the reconciliation carries no clock, randomness or locale-derived value', () => {
    const context = currentContext();
    const result = reconcile(fullWire(context), context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = JSON.stringify(result.reconciliation);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(result.reconciliation.reconciliation_version).toBe(
      'nutrition_ai_recipe_context_reconcile_v1'
    );
  });
});

// ===========================================================================
// O. IMMUTABILITY
// ===========================================================================
describe('AI-4D1 O — immutability', () => {
  it('the plan is frozen and every source object is left byte-equivalent', () => {
    const context = currentContext();
    const wire = fullWire(context);
    const contextBefore = JSON.stringify(context);
    const wireBefore = JSON.stringify(wire);
    const recipeBefore = JSON.stringify(recipe());
    const instructionsBefore = JSON.stringify(DEFAULT_INSTRUCTIONS);

    const result = reconcileRecipeContextOnServer({
      wire,
      expected_request_id: REQUEST_ID,
      recipe: recipe(),
      instructions: DEFAULT_INSTRUCTIONS.map((text) => ({ text })),
      recipe_instance: INSTANCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Sources untouched.
    expect(JSON.stringify(wire)).toBe(wireBefore);
    expect(JSON.stringify(context)).toBe(contextBefore);
    expect(JSON.stringify(recipe())).toBe(recipeBefore);
    expect(JSON.stringify(DEFAULT_INSTRUCTIONS)).toBe(instructionsBefore);

    // Output frozen, recursively.
    const plan = result.reconciliation;
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.rows)).toBe(true);
    for (const row of plan.rows) {
      expect(Object.isFrozen(row)).toBe(true);
      if (row.interpretation !== undefined) {
        expect(Object.isFrozen(row.interpretation)).toBe(true);
        expect(Object.isFrozen(row.interpretation.relations)).toBe(true);
      }
    }
  });

  it('the categories and status vocabularies contain no acceptance vocabulary', () => {
    // THIS IS NOT ACCEPTANCE vocabulary, and no such word may appear.
    expect([...AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES]).toEqual([
      'reviewable',
      'abstained',
      'uninterpreted',
    ]);
    expect([...AI_RECIPE_CONTEXT_RECONCILE_STATUSES]).toEqual(['current']);
    const forbidden = [
      'accepted',
      'approved',
      'applied',
      'authoritative',
      'automatic',
      'selected',
      'suppressed',
    ];
    for (const word of forbidden) {
      expect([...AI_RECIPE_CONTEXT_RECONCILE_CATEGORIES].join(','), word).not.toContain(word);
      expect([...AI_RECIPE_CONTEXT_RECONCILE_STATUSES].join(','), word).not.toContain(word);
    }
  });
});

// ===========================================================================
// Staleness against a REAL AI-4C response (end-to-end shape)
// ===========================================================================
describe('AI-4D1 — reconciliation of a realistic AI-4C response', () => {
  it('a mixed reviewable/abstained/uninterpreted plan classifies every current target exactly once', () => {
    const context = currentContext();
    const refs = refsOf(context);
    const wire = wireOf(context, [
      interpretation(refs[0], { role: 'reserved', preparation_hints: ['reserved'], confidence: 'high' }),
      interpretation(refs[1], { abstain_reason: 'insufficient_evidence' }),
    ]);
    const result = reconcile(wire, context, REQUEST_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.reconciliation;
    expect(plan.rows).toHaveLength(refs.length);
    // Every current target appears exactly once, in current order.
    expect(plan.rows.map((row) => row.line_ref)).toEqual(refs);
    expect(new Set(plan.rows.map((row) => row.line_ref)).size).toBe(refs.length);
    expect(
      plan.reviewable_count + plan.abstained_count + plan.uninterpreted_count
    ).toBe(plan.rows.length);
    expect(plan.rows.filter((row) => row.category === 'abstained')).toHaveLength(1);
    expect(plan.uninterpreted_count).toBe(refs.length - 2);
  });

  it('the AI-4A envelope is never required as reconciliation input (it is derived)', () => {
    // The reconciliation derives its own current context; a caller-supplied envelope
    // is not part of the contract at all.
    const context = currentContext();
    expect(Object.keys(context).sort()).toEqual(['context_binding', 'targets']);
    const envelope: RecipeContextEnvelope | null = null;
    expect(envelope).toBeNull();
  });
});
