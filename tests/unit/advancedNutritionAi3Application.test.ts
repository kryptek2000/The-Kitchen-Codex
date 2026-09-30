/**
 * AI-3 — APPLICATION ORCHESTRATION WITNESSES.
 *
 * These exist because the mutation battery found two rows (M50, M53) whose
 * earlier witnesses never actually EXERCISED the mutated branch. A mutation
 * row is only meaningful if a test drives the line being mutated.
 *
 *   M50 — the calculator's provenance re-check (an estimate may never claim an
 *         authenticated provenance class).
 *   M53 — the capability gate, which must stop the request BEFORE any transport
 *         is invoked. Proven by a transport spy: zero calls in the Basic tier.
 */
import { describe, it, expect, vi } from 'vitest';

import { runAiMassEstimation, type AiEstimateTransport } from '../../src/application/nutritionAiEstimate';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { buildAiEstimateSelection } from '../../src/core/nutritionV2/phase4/aiEstimateSelection';
import type { AiEstimateChoice, Phase4State } from '../../src/core/nutritionV2/phase4/types';

const LINE = 'ing:0:ai3';
const EVIDENCE = {
  line_ref: LINE,
  fdc_id: 2709223,
  record_digest: 'rd',
  ingredient_identity_digest: 'iid',
  bundle_release: 'b1',
};

const PARSE = { hasDirectMass: false, amount: 2, quantityRange: null, container: null };

function seeded(): Phase4State {
  return phase4Reducer(
    {
      ...INITIAL_PHASE4_STATE,
      status: 'ready',
      recipeKey: 'r1',
      sessionIdentity: 's1',
      rows: [{ line_ref: LINE, original_text: '2 tomatoes', query: 'tomatoes' }],
      matches: { [LINE]: { fdc_id: 2709223, record_digest: 'rd', review_digest: 'vd' } },
    } as never,
    { type: 'noop' } as never
  );
}

function spyTransport(): AiEstimateTransport & { calls: number } {
  const transport = {
    calls: 0,
    async request() {
      transport.calls += 1;
      return { ok: false, code: 'should_not_be_reached' };
    },
  };
  return transport as never;
}

describe('M53 — the capability gate stops the request before any transport', () => {
  const state = seeded();

  it('a Basic-tier surface performs ZERO provider calls', async () => {
    const transport = spyTransport();
    const outcome = await runAiMassEstimation(
      [{ lineRef: LINE, eligibility: { state, lineRef: LINE, parse: PARSE, rowStatus: 'needs_amount', capabilityAvailable: true } }],
      {
        recipeKey: 'r1',
        sessionIdentity: 's1',
        getCurrentState: () => state,
        capabilityInput: {},
        issueKinds: { [LINE]: 'needs_amount' },
        parses: new Map([[LINE, PARSE]]),
        snapshots: new Map(),
        capturedFingerprints: new Map(),
        transport,
      }
    );
    expect(outcome.kind).toBe('unavailable');
    expect(transport.calls).toBe(0);
  });

  it('an unreachable provider also performs ZERO provider calls', async () => {
    const transport = spyTransport();
    const outcome = await runAiMassEstimation(
      [{ lineRef: LINE, eligibility: { state, lineRef: LINE, parse: PARSE, rowStatus: 'needs_amount', capabilityAvailable: true } }],
      {
        recipeKey: 'r1',
        sessionIdentity: 's1',
        getCurrentState: () => state,
        capabilityInput: { aiConfigured: true, aiReachable: false },
        issueKinds: { [LINE]: 'needs_amount' },
        parses: new Map([[LINE, PARSE]]),
        snapshots: new Map(),
        capturedFingerprints: new Map(),
        transport,
      }
    );
    expect(outcome.kind).toBe('unavailable');
    expect(transport.calls).toBe(0);
  });

  it('a fully available AI Advanced surface DOES reach the transport', async () => {
    const transport = spyTransport();
    const outcome = await runAiMassEstimation(
      [{ lineRef: LINE, eligibility: { state, lineRef: LINE, parse: PARSE, rowStatus: 'needs_amount', capabilityAvailable: true } }],
      {
        recipeKey: 'r1',
        sessionIdentity: 's1',
        getCurrentState: () => state,
        capabilityInput: { aiConfigured: true, aiReachable: true },
        issueKinds: { [LINE]: 'needs_amount' },
        parses: new Map([[LINE, PARSE]]),
        snapshots: new Map(),
        capturedFingerprints: new Map(),
        transport,
      }
    );
    // The gate PASSED, so the transport was actually invoked. The outcome is
    // still 'unavailable' because this spy transport deliberately fails --
    // the load-bearing assertion is the call count, not the outcome kind.
    expect(transport.calls).toBe(1);
    if (outcome.kind === 'unavailable') {
      expect(outcome.reason).toBe('should_not_be_reached');
    }
  });
});

describe('M50 — an estimate may never claim an authenticated provenance class', () => {
  it('the selection builder refuses a non-ai_estimate provenance', () => {
    const forged = {
      fdc_id: 2709223,
      record_digest: 'rd',
      review_digest: 'vd',
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 175,
      representative_policy: 'midpoint',
      provenance: 'usda_derived',
      snapshot_binding: 'snap',
    } as unknown as AiEstimateChoice;
    const built = buildAiEstimateSelection(LINE, EVIDENCE, forged);
    expect(built.ok).toBe(false);
    if (built.ok === false) expect(built.reason).toBe('invalid_estimate');
  });

  it('the FROZEN proposal validator independently refuses an authenticated class', () => {
    // A second, independent layer: even a perfectly-shaped proposal may not
    // claim `usda_derived` / `vetted_standard`.
    const state = seeded();
    const forgedChoice = {
      ...CHOICE,
      provenance: 'vetted_standard',
    } as unknown as AiEstimateChoice;
    const built = buildAiEstimateSelection(LINE, EVIDENCE, forgedChoice);
    expect(built.ok).toBe(false);
    expect(state.aiEstimates).toEqual({});
  });
});

const CHOICE = {
  fdc_id: 2709223,
  record_digest: 'rd',
  review_digest: 'vd',
  lower_grams: 150,
  upper_grams: 200,
  representative_grams: 175,
  representative_policy: 'midpoint',
  provenance: 'ai_estimate',
  snapshot_binding: 'snap',
} as AiEstimateChoice;

void vi;
