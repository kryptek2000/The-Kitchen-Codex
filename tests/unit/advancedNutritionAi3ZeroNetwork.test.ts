/**
 * AI-3 — M53 DEDICATED BEHAVIOURAL ZERO-NETWORK WITNESS.
 *
 * This file exists because `advancedNutritionAi3ProductionReachability.test.ts`
 * contains SOURCE-TEXT PINS on `src/application/nutritionAiEstimate.ts`. Those
 * pins are valuable SECURITY tests, but they go red merely because the file
 * changed, so they are NOT valid historical mutation evidence: they cannot
 * distinguish a bypassed capability gate from any other edit.
 *
 * This witness is behavioural only: it asserts the transport call COUNT under an
 * unavailable capability. No source text, no source anchors, no structural pins.
 */
import { describe, it, expect, vi } from 'vitest';

import { requestAiMassEstimateOffers } from '../../src/application/nutritionAiEstimate';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/types';

const UNAVAILABLE = resolveNutritionCapabilities({ aiConfigured: false, aiReachable: false });

function state(): Phase4State {
  return phase4Reducer(
    {
      ...INITIAL_PHASE4_STATE,
      status: 'ready',
      recipeKey: 'm53',
      sessionIdentity: 'm53',
      rows: [{ line_ref: 'ing:0:m53', original_text: '2-3 tomatoes', query: 'tomatoes' }],
    } as never,
    { type: 'noop' } as never
  );
}

/** A transport that would be catastrophic to call. It records every call. */
function countingTransport() {
  const request = vi.fn(async () => ({ ok: true, request_id: 'never', estimates: [] }));
  return { request };
}

describe('M53 — capability-off means ZERO client network', () => {
  it('the resolved capability really is unavailable (precondition)', () => {
    expect(UNAVAILABLE.aiEstimation).not.toBe('available');
  });

  it('M53: the real application estimation path makes EXACTLY ZERO transport calls', async () => {
    const transport = countingTransport();
    const result = await requestAiMassEstimateOffers({
      state: state(),
      lines: [{ line_ref: 'ing:0:m53', original_text: '2-3 tomatoes', outcome: 'needs_amount' }],
      capabilities: UNAVAILABLE,
      // A session is not required for the capability refusal: the gate is
      // upstream of every evidence and transport step.
      session: undefined as never,
      transport,
    });

    // THE HISTORICAL INVARIANT, stated behaviourally and nothing else.
    expect(transport.request).toHaveBeenCalledTimes(0);
    expect(result.offers).toEqual([]);
  });

  // NOTE: the anti-vacuity control (an AVAILABLE capability DOES reach transport)
  // is deliberately NOT reproduced here. Reaching transport requires a real
  // pinned USDA session, and the evidence owner refuses before the transport
  // step when the session is absent -- so a local control would be asserting
  // reachability of the wrong layer. That role is already carried causally by
  // advancedNutritionAi3ProductionReachability.test.ts, which builds a real
  // session and proves the AI Advanced tier makes exactly one dedicated call.
  // Duplicating it here would only add a slow, weaker copy.
});
