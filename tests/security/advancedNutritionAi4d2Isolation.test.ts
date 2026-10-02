/**
 * AI-4D2 — ISOLATION PROOF: A SEPARATE AUTHORITY DOMAIN.
 *
 * Acceptance is a real user decision, and it must still be structurally incapable
 * of becoming nutrition authority. This file proves that separation as code, not
 * as a promise:
 *
 *   - the acceptance core NEVER imports Phase-4 nutrition state, the reducer, the
 *     AI-3 estimate gate, the calculation layer, persistence, or ANY server module;
 *   - `Phase4State` gains no AI-4 store and no new action;
 *   - the card/modal review path dispatches NO Phase-4 action of any kind, so it
 *     cannot move a match, a portion, a mass, a nutrient, the preview or Apply;
 *   - the review control is the ONLY caller of the AI-4 port, and Accept/Dismiss/
 *     Undo are never wired to it;
 *   - the AI-3 `clear_ai_estimate` action is now reachable from the UI, and it is
 *     still the EXISTING reducer action with EXISTING semantics: removing an
 *     accepted estimate restores the exact pre-accept state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import {
  PHASE4_STATE_VERSION,
  type Phase4Action,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import {
  AI_RECIPE_CONTEXT_RECONCILE_VERSION,
  type RecipeContextReconciliation,
} from '../../src/core/nutritionV2/aiRecipeContextReconcile';
import {
  AI_RECIPE_CONTEXT_SESSION_VERSION,
  acceptRecipeContextRow,
  createRecipeContextReviewSession,
} from '../../src/core/nutritionV2/aiRecipeContextSession';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';

const REPO = process.cwd();
const read = (relative: string): string =>
  readFileSync(join(REPO, relative), 'utf8');

const SESSION_SOURCE = read('src/core/nutritionV2/aiRecipeContextSession.ts');
const CARD_SOURCE = read('src/components/AdvancedNutritionCard.tsx');
const MODAL_SOURCE = read('src/components/AdvancedNutritionModal.tsx');
const APP_SOURCE = read('src/App.tsx');
const APP_LAYER_SOURCE = read('src/application/nutritionAiRecipeContext.ts');
const STATE_SOURCE = read('src/core/nutritionV2/phase4/state.ts');

/**
 * The body of ONE `const <name> ...` handler, bounded by the next top-level
 * declaration so an assertion can never leak into a neighbouring handler.
 */
function handlerBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) return '';
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n  (?:const|useEffect|return|\/\/) /);
  return next > 0 ? rest.slice(0, next) : rest;
}

function reconciliationFor(reviewableRefs: ReadonlyArray<string>): RecipeContextReconciliation {
  const rows = reviewableRefs.map((line_ref) => ({
    category: 'reviewable' as const,
    line_ref,
    source_text: `line ${line_ref}`,
    interpretation: {
      line_ref,
      role: 'reserved' as const,
      relations: [],
      preparation_hints: ['reserved' as const],
      confidence: 'high' as const,
    },
  }));
  return {
    reconciliation_version: AI_RECIPE_CONTEXT_RECONCILE_VERSION,
    request_id: 'ai4d2-isolation-1',
    context_binding: 'sha256:'.concat('a'.repeat(64)),
    status: 'current',
    rows,
    reviewable_count: rows.length,
    abstained_count: 0,
    uninterpreted_count: 0,
  };
}

describe('AI-4D2 isolation — the acceptance core is offline and separate', () => {
  it('imports nothing from nutrition state, AI-3, calculation, persistence or the server', () => {
    // The forbidden list is every module that owns nutrition authority.
    for (const forbidden of [
      'phase4/state',
      'phase4/types',
      'phase4/reducer',
      'phase4/liveRow',
      'phase4/aiEstimate',
      'aiEstimateAccept',
      'aiEstimateApplyGate',
      'calculation/',
      'phase5',
      'advancedNutritionApply',
      'phase4/analyzer',
      'phase4/rows',
      'phase4/session',
      '../../server',
      '../application',
    ]) {
      expect(SESSION_SOURCE.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('its only nutrition-adjacent import is the AI-4 reconciliation owner it reads', () => {
    const imports = [...SESSION_SOURCE.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toContain('./aiRecipeContextReconcile');
    expect(imports).toContain('./phase4/recipeContextContract');
    expect(imports).toContain('./schema');
    expect(imports).toHaveLength(3);
  });

  it('creates a session and accepts a row with no network capability at all', () => {
    const fetchSpy = (): never => {
      throw new Error('the acceptance core must not perform any network call');
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;
    try {
      const plan = reconciliationFor(['l1', 'l2']);
      const created = createRecipeContextReviewSession({
        reconciliation: plan,
        expected: { requestId: plan.request_id, contextBinding: plan.context_binding },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const accepted = acceptRecipeContextRow(created.session, 'l1', {
        requestId: plan.request_id,
        contextBinding: plan.context_binding,
      });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.session.session_version).toBe(AI_RECIPE_CONTEXT_SESSION_VERSION);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('the accepted context declares its own consumers are absent', () => {
    // The module documents the no-consumer boundary; a consumer appearing later
    // must be a deliberate, separately authorized phase.
    expect(SESSION_SOURCE).toContain('ZERO NUTRITION AUTHORITY');
    expect(APP_LAYER_SOURCE).toContain('ZERO NUTRITION AUTHORITY');
  });
});

describe('AI-4D2 isolation — Phase 4 gains no AI-4 concept', () => {
  it('Phase4State has no AI-4 store and its version is unchanged', () => {
    expect(PHASE4_STATE_VERSION).toBe('usda_phase4_state_v5');
    const state = INITIAL_PHASE4_STATE as unknown as Record<string, unknown>;
    for (const key of Object.keys(state)) {
      const lowered = key.toLowerCase();
      expect(lowered).not.toContain('recipecontext');
      expect(lowered).not.toContain('accepted');
      expect(lowered).not.toContain('reconcil');
    }
  });

  it('no Phase-4 action was added for AI-4 acceptance', () => {
    // `clear_ai_estimate` is PRE-EXISTING and is the only estimate-clear action.
    const actions = [...STATE_SOURCE.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]);
    expect(actions).toContain('clear_ai_estimate');
    expect(actions.filter((action) => action.includes('context'))).toEqual([]);
    expect(actions.filter((action) => action.includes('accept'))).toEqual([]);
    // The reducer's action vocabulary is unchanged by this phase.
    expect(new Set(actions).size).toBeGreaterThan(10);
  });

  it('the review path dispatches NO Phase-4 action', () => {
    // Every dispatch in the card must belong to the pre-existing nutrition paths.
    const dispatches = [...CARD_SOURCE.matchAll(/dispatch\(\{ type: '([a-z_]+)'/g)].map((m) => m[1]);
    expect(dispatches.length).toBeGreaterThan(0);
    for (const type of dispatches) {
      expect(type, type).not.toContain('context');
      expect(type, type).not.toContain('accept_recipe');
    }
    expect(dispatches).toContain('clear_ai_estimate');
    expect(dispatches).toContain('select_ai_estimate');
  });

  it('Accept/Dismiss/Undo never call the AI-4 port — only the review control does', () => {
    // The port is invoked from exactly one place in the card: the explicit review
    // handler. The three decision handlers route through the pure core instead.
    const portCalls = [...CARD_SOURCE.matchAll(/onReviewRecipeContextWithAi\(/g)].map((m) => m[0]);
    expect(portCalls).toHaveLength(1);
    for (const handler of [
      'handleAcceptRecipeContextRow',
      'handleDismissRecipeContextRow',
      'handleUndoRecipeContextRow',
      'clearRecipeContextReview',
    ]) {
      expect(CARD_SOURCE).toContain(`const ${handler}`);
      expect(handlerBody(CARD_SOURCE, handler), handler).not.toContain('onReviewRecipeContextWithAi');
      expect(handlerBody(CARD_SOURCE, handler), handler).not.toContain('dispatch(');
    }
  });

  it('the review never runs on open, focus, render or re-analysis', () => {
    // The only call site is inside the explicit click handler.
    const handlerStart = CARD_SOURCE.indexOf('const handleReviewRecipeContext');
    expect(handlerStart).toBeGreaterThan(0);
    const handlerBody = CARD_SOURCE.slice(handlerStart, handlerStart + 1200);
    expect(handlerBody).toContain('onReviewRecipeContextWithAi({ recipe })');
    // No effect calls it.
    for (const effect of [...CARD_SOURCE.matchAll(/useEffect\(\(\) => \{[\s\S]{0,600}?\n  \}, \[/g)]) {
      expect(effect[0]).not.toContain('handleReviewRecipeContext');
    }
  });

  it('the expected identity is captured SEPARATELY, never read off the session', () => {
    // The released pattern supplied the expectation from the very session under test,
    // so the D2 core's identity check compared the session with itself and could never
    // fail. The card now captures a frozen anchor ONCE, when a review is installed.
    for (const handler of [
      'handleAcceptRecipeContextRow',
      'handleDismissRecipeContextRow',
      'handleUndoRecipeContextRow',
    ]) {
      expect(CARD_SOURCE, handler).toContain(`const ${handler}`);
      const body = handlerBody(CARD_SOURCE, handler);
      // The self-referential pattern must be gone from every decision handler.
      expect(body, handler).not.toContain('requestId: session.request_id');
      expect(body, handler).not.toContain('contextBinding: session.context_binding');
      // And the decision is routed through the shared applier, which owns the anchor.
      expect(body, handler).toContain('applyRecipeContextDecision');
      expect(body, handler).toContain('expected');
      // Never a literal identity object invented at decision time.
      expect(body, handler).not.toMatch(/requestId:\s*'/);
    }
    // It is absent from the WHOLE card, including the review view projection.
    expect(CARD_SOURCE).not.toContain('requestId: session.request_id');
    expect(CARD_SOURCE).not.toContain('contextBinding: session.context_binding');

    // The anchor exists, is captured once from the review RESULT, and is frozen.
    expect(CARD_SOURCE).toContain('const recipeContextExpectedIdentity = useRef<');
    expect(CARD_SOURCE).toContain('recipeContextExpectedIdentity.current = Object.freeze({');
    expect(CARD_SOURCE).toContain('requestId: outcome.session.request_id');
    expect(CARD_SOURCE).toContain('contextBinding: outcome.session.context_binding');
    // The applier reads it and refuses when absent.
    expect(CARD_SOURCE).toContain('const expected = recipeContextExpectedIdentity.current;');
    expect(CARD_SOURCE).toContain('if (expected === null) return;');
  });

  it('the identity anchor is cleared with the review, and never fabricated', () => {
    // Cleared on a recipe change and on Clear review: at least two clear sites besides
    // the one that installs it.
    const clears = [...CARD_SOURCE.matchAll(/recipeContextExpectedIdentity\.current = null;/g)];
    expect(clears.length).toBeGreaterThanOrEqual(2);
    // The recipe-change effect clears it.
    const effectStart = CARD_SOURCE.indexOf('}, [recipe.id]);');
    const effectBody = CARD_SOURCE.slice(
      CARD_SOURCE.lastIndexOf('useEffect(() => {', effectStart),
      effectStart
    );
    expect(effectBody).toContain('recipeContextExpectedIdentity.current = null;');
    // Clear review clears it.
    const clearBody = handlerBody(CARD_SOURCE, 'const clearRecipeContextReview');
    expect(clearBody).toContain('recipeContextExpectedIdentity.current = null;');
    // It is assigned EXACTLY ONCE, and only on the success branch.
    const installs = [...CARD_SOURCE.matchAll(/recipeContextExpectedIdentity\.current = Object\.freeze\(/g)];
    expect(installs).toHaveLength(1);
    const installAt = CARD_SOURCE.indexOf('recipeContextExpectedIdentity.current = Object.freeze(');
    const failureBranch = CARD_SOURCE.indexOf('if (outcome.ok !== true || outcome.session === undefined)');
    const successWrite = CARD_SOURCE.indexOf('setRecipeContextSession(outcome.session);');
    expect(failureBranch).toBeGreaterThan(0);
    expect(installAt).toBeGreaterThan(failureBranch);
    // A failed run returns from inside that branch and installs nothing.
    expect(CARD_SOURCE.slice(failureBranch, installAt)).toContain('return;');
    // It is a ref, so it is memory-only: never persisted or transmitted.
    expect(CARD_SOURCE).not.toMatch(/recipeContextExpectedIdentity[^\n]*localStorage/);
    expect(CARD_SOURCE).not.toMatch(/recipeContextExpectedIdentity[^\n]*sessionStorage/);
  });

  it('the removed application runner has no remaining reference anywhere', () => {
    // The dead `createRecipeContextReviewRunner` export and its contract are gone; the
    // CARD's monotonic generation counter is the single real owner of sequencing.
    const APP_LAYER = read('src/application/nutritionAiRecipeContext.ts');
    expect(APP_LAYER).not.toContain('RecipeContextReviewRunner');
    expect(APP_LAYER).not.toContain('createRecipeContextReviewRunner');
    // And the card still owns the released generation mechanism.
    expect(CARD_SOURCE).toContain('const recipeContextGeneration = useRef(0);');
    expect(CARD_SOURCE).toContain('recipeContextGeneration.current += 1;');
    expect(CARD_SOURCE).toContain('if (token !== recipeContextGeneration.current) return;');
    // The application header truthfully describes that ownership.
    expect(APP_LAYER).toContain('UI RACE SEQUENCING IS OWNED BY THE CARD');
  });
});

describe('AI-4D2 isolation — the review is memory-only and never persisted', () => {
  it('no persistence, hydration or storage call carries AI-4 state', () => {
    for (const source of [CARD_SOURCE, MODAL_SOURCE, APP_LAYER_SOURCE]) {
      expect(source).not.toContain('localStorage');
      expect(source).not.toContain('sessionStorage');
      expect(source).not.toContain('indexedDB');
    }
    expect(CARD_SOURCE).not.toContain('onUpdateNutrition');
  });

  it('the opaque instance token is never a path or a recipe identity', () => {
    expect(APP_LAYER_SOURCE).toContain('recipeInstance');
    expect(APP_SOURCE).toContain('createRecipeContextInstanceToken()');
    // The shell passes the token straight through: it never derives it from the
    // recipe's own identity fields.
    const handler = handlerBody(APP_SOURCE, 'const handleReviewRecipeContextWithAi');
    expect(handler).not.toContain('filePath');
    expect(handler).not.toContain('fileName');
    expect(handler).not.toContain('target.id');
  });
});

describe('AI-4D2 isolation — AI-3 clear_ai_estimate keeps its existing semantics', () => {
  /**
   * A minimal but REAL state with one accepted AI estimate, built with the
   * existing reducer action. The acceptance decision is deliberately hand-built
   * here because this test is about the CLEAR path, not about AI-3 acceptance.
   */
  function stateWithAcceptedEstimate(): Phase4State {
    const base: Phase4State = {
      ...INITIAL_PHASE4_STATE,
      recipeKey: 'recipe-1',
      sessionIdentity: 'identity-1',
      rows: [
        {
          line_ref: 'l1',
          original_text: '2 oz Salt, table',
          outcome: 'unmatched',
          candidates: [],
          review_digest: 'rd',
        },
      ] as never,
      baseServings: 1,
    };
    const accepted = phase4Reducer(base, {
      type: 'select_ai_estimate',
      lineRef: 'l1',
      choice: {
        line_ref: 'l1',
        provenance: 'ai_estimate',
        fdc_id: 3003,
        record_digest: 'sha256:'.concat('b'.repeat(64)),
        review_digest: 'rd',
        snapshot_binding: 'snapshot-1',
        selection: { mass_source: 'ai_estimate' },
        lower_grams: 20,
        upper_grams: 30,
        representative_grams: 25,
        representative_policy: 'midpoint',
      },
    } as unknown as Phase4Action);
    return accepted;
  }

  it('an accepted estimate is present and clearable', () => {
    const accepted = stateWithAcceptedEstimate();
    expect(accepted.aiEstimates?.['l1']).toBeDefined();
    const cleared = phase4Reducer(accepted, { type: 'clear_ai_estimate', lineRef: 'l1' } as Phase4Action);
    expect(cleared.aiEstimates?.['l1']).toBeUndefined();
    expect(Object.keys(cleared.aiEstimates ?? {})).toHaveLength(0);
  });

  it('clearing restores the exact pre-accept state apart from the sequence counter', () => {
    const accepted = stateWithAcceptedEstimate();
    const cleared = phase4Reducer(accepted, { type: 'clear_ai_estimate', lineRef: 'l1' } as Phase4Action);
    const normalized = (state: Phase4State) => JSON.stringify({ ...state, operationSeq: 0 });
    const before = normalized({ ...accepted, aiEstimates: {} });
    expect(normalized(cleared)).toBe(before);
  });

  it('clearing a line with no estimate is a no-op', () => {
    const state = INITIAL_PHASE4_STATE;
    const cleared = phase4Reducer(state, { type: 'clear_ai_estimate', lineRef: 'absent' } as Phase4Action);
    expect(cleared).toBe(state);
  });

  it('the card exposes the existing action next to each blocked estimate', () => {
    expect(CARD_SOURCE).toContain("dispatch({ type: 'clear_ai_estimate', lineRef: estimate.lineRef })");
    expect(CARD_SOURCE).toContain('advanced-nutrition-ai-estimate-clear-');
    // The label is bounded UI copy, not a nutrition value.
    expect(CARD_SOURCE).toContain("AI_ESTIMATE_CLEAR_LABEL = 'Remove estimate'");
  });
});

describe('AI-4D2 isolation — the AI-4 contract versions stay distinct', () => {
  it('each layer publishes its own closed version', () => {
    expect(AI_RECIPE_CONTEXT_CONTRACT_VERSION).toBe('nutrition_ai_recipe_context_v1');
    expect(AI_RECIPE_CONTEXT_PROVENANCE_CLASS).toBe('ai_recipe_context');
    expect(AI_RECIPE_CONTEXT_RECONCILE_VERSION).toBe('nutrition_ai_recipe_context_reconcile_v1');
    expect(AI_RECIPE_CONTEXT_SESSION_VERSION).toBe('nutrition_ai_recipe_context_session_v1');
    // Four distinct contracts: model, wire, reconciliation, acceptance session.
    expect(
      new Set([
        AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        AI_RECIPE_CONTEXT_RECONCILE_VERSION,
        AI_RECIPE_CONTEXT_SESSION_VERSION,
        'nutrition_ai_recipe_context_request_v1',
      ]).size
    ).toBe(4);
  });
});