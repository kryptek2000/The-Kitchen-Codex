/**
 * AI-3 — M56b DIRECT CONTAINER-ABSTENTION WITNESS.
 *
 * The existing eligibility witness does NOT cover M56b: every `container` field
 * in that file is `null`, so bypassing the container guard leaves it entirely
 * green. That is a missing predicate, not a redundant defense — proven by the
 * fact that bypassing BOTH container guards still left it green.
 *
 * This witness drives the real `evaluateAiEstimateEligibility` container branch
 * directly, with an ANTI-VACUITY CONTROL proving the container field is the
 * discriminating input rather than a blanket refusal.
 */
import { describe, it, expect } from 'vitest';

import { evaluateAiEstimateEligibility } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { AI_ESTIMATE_ROW_ACTIONABLE } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/state';

const LINE = 'ing:0:m56b';

function stateWithMatch(): Phase4State {
  const seeded = {
    ...INITIAL_PHASE4_STATE,
    status: 'ready',
    recipeKey: 'm56b',
    sessionIdentity: 'm56b',
    rows: [{ line_ref: LINE, original_text: '3 cans tomato sauce', query: 'tomato sauce', resolved_grams: null }],
    matches: { [LINE]: { fdc_id: 171287, review_digest: 'c'.repeat(64) } },
  } as unknown as Phase4State;
  return phase4Reducer(seeded, { type: 'noop' } as never);
}

function evaluate(container: string | null, over: Record<string, unknown> = {}) {
  return evaluateAiEstimateEligibility({
    state: stateWithMatch(),
    lineRef: LINE,
    parse: {
      hasDirectMass: false,
      directMassGrams: null,
      amount: null,
      quantityRange: { lower: 100, upper: 200 },
      container,
      ...over,
    },
    rowStatus: AI_ESTIMATE_ROW_ACTIONABLE,
    capabilityAvailable: true,
  });
}

describe('M56b — container/package/can abstention (TYPE-B second predicate)', () => {
  it('ANTI-VACUITY CONTROL: identical facts with container: null are NOT refused as a container', () => {
    const r = evaluate(null);
    expect(r.eligible).toBe(true);
    if (r.eligible !== true) throw new Error('container null must not abstain, got ' + String(r.reason));
  });

  it('[AI3-M56B-HIST] M56b: a parsed container noun abstains with reason parsed_container', () => {
    for (const container of ['can', 'cans', 'package', 'jar', 'bottle', 'bag', 'box', 'tub']) {
      const r = evaluate(container);
      expect(r.eligible).toBe(false);
      if (r.eligible !== false) return;
      expect(r.reason).toBe('parsed_container');
    }
  });

  it('M56b: the container guard is the discriminator, not a by-product of the state', () => {
    // Production evaluates usable-quantity FIRST (step 10) and the container
    // guard LAST (step 11), so a container line with a usable range is refused
    // by the container branch specifically. This pins that ordering truthfully.
    const r = evaluate('can');
    expect(r.eligible).toBe(false);
    if (r.eligible !== false) return;
    expect(r.reason).toBe('parsed_container');
  });
});
