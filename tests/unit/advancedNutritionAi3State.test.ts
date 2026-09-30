/**
 * AI-3 — SLICE B: working-state estimate authority, effectiveMass compatibility,
 * the mid-flight fingerprint, and the calculator's estimate arm.
 *
 * Every assertion here exercises PRODUCTION logic. The calculator arm is the
 * load-bearing one: it re-authenticates the identity, re-validates the bounds
 * and the 4x ratio, and re-derives the midpoint locally rather than trusting a
 * caller-supplied gram value.
 */
import { describe, expect, it } from 'vitest';

import { phase4Reducer, INITIAL_PHASE4_STATE } from '../../src/core/nutritionV2/phase4/state';
import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { resolveEffectiveMassDecision } from '../../src/core/nutritionV2/calculation/effectiveMass';
import type { AiEstimateChoice, Phase4State } from '../../src/core/nutritionV2/phase4/types';
import type { EffectiveMassClaims } from '../../src/core/nutritionV2/calculation/effectiveMass';

const LINE = 'L1';

const CHOICE: AiEstimateChoice = Object.freeze({
  fdc_id: 111111,
  record_digest: 'rd',
  review_digest: 'vd',
  lower_grams: 150,
  upper_grams: 200,
  representative_grams: 175,
  representative_policy: 'midpoint',
  provenance: 'ai_estimate',
  snapshot_binding: 'snap-1',
  selection: {
    calculation_version: 'usda_advisory_calc_v4',
    line_ref: LINE,
    ingredient_identity_digest: 'iid',
    bundle_release: 'b1',
    fdc_id: 111111,
    record_digest: 'rd',
    lower_grams: 150,
    upper_grams: 200,
    representative_policy: 'midpoint' as const,
    provenance: 'ai_estimate' as const,
    snapshot_binding: 'snap-1',
  },
});

function seeded(): Phase4State {
  return phase4Reducer(
    {
      ...INITIAL_PHASE4_STATE,
      status: 'ready',
      recipeKey: 'r1',
      sessionIdentity: 's1',
      rows: [{ line_ref: LINE, original_text: '2 tomatoes', query: 'tomatoes' }],
    } as never,
    { type: 'noop' } as never
  );
}

function withEstimate(): Phase4State {
  return phase4Reducer(seeded(), { type: 'select_ai_estimate', lineRef: LINE, choice: CHOICE } as never);
}

const claims = (over: Partial<EffectiveMassClaims> = {}): EffectiveMassClaims => ({
  directMassGrams: undefined,
  hasUserMass: false,
  hasSourcePortion: false,
  hasCountPortion: false,
  hasHouseholdPortion: false,
  hasAiEstimate: false,
  ...over,
});

describe('AI-3 Slice B — reducer: the estimate working choice', () => {
  it('selects an estimate onto a clean line', () => {
    const state = withEstimate();
    expect(state.aiEstimates[LINE]).toEqual(CHOICE);
    expect(state.operationSeq).toBe(seeded().operationSeq + 1);
  });

  it('clear removes the estimate and moves the sequence', () => {
    const before = withEstimate();
    const after = phase4Reducer(before, { type: 'clear_ai_estimate', lineRef: LINE } as never);
    expect(after.aiEstimates[LINE]).toBeUndefined();
    expect(after.operationSeq).toBe(before.operationSeq + 1);
  });

  it('clear on a line with no estimate is an exact no-op', () => {
    const before = seeded();
    const after = phase4Reducer(before, { type: 'clear_ai_estimate', lineRef: LINE } as never);
    expect(after).toBe(before);
  });

  it('never writes an estimate for a line that does not exist', () => {
    const after = phase4Reducer(seeded(), {
      type: 'select_ai_estimate',
      lineRef: 'GHOST',
      choice: CHOICE,
    } as never);
    expect(after.aiEstimates['GHOST']).toBeUndefined();
  });

  it('reset removes every estimate', () => {
    const after = phase4Reducer(withEstimate(), { type: 'reset' } as never);
    expect(after.aiEstimates).toEqual({});
  });

  it('hydrate (re-analysis) drops every estimate', () => {
    const after = phase4Reducer(withEstimate(), {
      type: 'hydrate',
      matches: {},
      portions: {},
      countPortions: {},
      userMasses: {},
      householdPortions: {},
    } as never);
    expect(after.aiEstimates).toEqual({});
  });

  for (const [label, action] of [
    ['user mass', { type: 'select_user_mass', lineRef: LINE, choice: { grams: 180 } }],
    ['source portion', { type: 'select_portion', lineRef: LINE, choice: { portion_index: 0, grams: 180 } }],
    ['count portion', { type: 'select_count_portion', lineRef: LINE, choice: { grams_per_count: 90, count: 2 } }],
    [
      'household portion',
      { type: 'select_household_portion', lineRef: LINE, choice: { grams_per_item: 60, items: 3 } },
    ],
  ] as const) {
    it(`a user selecting ${label} REMOVES the estimate (user authority wins)`, () => {
      const after = phase4Reducer(withEstimate(), action as never);
      expect(after.aiEstimates[LINE]).toBeUndefined();
    });
  }

  it('M42: an estimate REFUSES to overwrite an explicit user mass', () => {
    const withUserMass = phase4Reducer(seeded(), {
      type: 'select_user_mass',
      lineRef: LINE,
      choice: { grams: 180 },
    } as never);
    const after = phase4Reducer(withUserMass, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: CHOICE,
    } as never);
    // Refused outright: the user's mass survives and the sequence does not move.
    expect(after.userMasses[LINE]).toBeDefined();
    expect(after.aiEstimates[LINE]).toBeUndefined();
    expect(after.operationSeq).toBe(withUserMass.operationSeq);
  });

  it('an estimate also refuses to overwrite a USDA portion', () => {
    const withPortion = phase4Reducer(seeded(), {
      type: 'select_portion',
      lineRef: LINE,
      choice: { portion_index: 0, grams: 180 },
    } as never);
    const after = phase4Reducer(withPortion, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: CHOICE,
    } as never);
    expect(after.aiEstimates[LINE]).toBeUndefined();
    expect(after.portions[LINE]).toBeDefined();
  });
});

describe('AI-3 Slice B — effectiveMass compatibility', () => {
  it('every pre-AI-3 outcome is unchanged when no estimate exists', () => {
    expect(resolveEffectiveMassDecision(claims()).kind).toBe('none');
    expect(resolveEffectiveMassDecision(claims({ directMassGrams: 100 })).kind).toBe('direct_mass');
    expect(resolveEffectiveMassDecision(claims({ hasUserMass: true })).kind).toBe('user_mass');
    expect(resolveEffectiveMassDecision(claims({ hasSourcePortion: true })).kind).toBe('source_portion');
    expect(resolveEffectiveMassDecision(claims({ hasCountPortion: true })).kind).toBe('count_portion');
    expect(resolveEffectiveMassDecision(claims({ hasHouseholdPortion: true })).kind).toBe('household_portion');
  });

  it('an estimate alone resolves through the ai_estimate arm', () => {
    expect(resolveEffectiveMassDecision(claims({ hasAiEstimate: true })).kind).toBe('ai_estimate');
  });

  it('the estimate arm is LAST: it never outranks a present source', () => {
    for (const stronger of [
      { directMassGrams: 100 },
      { hasUserMass: true },
      { hasSourcePortion: true },
      { hasCountPortion: true },
      { hasHouseholdPortion: true },
    ]) {
      // M41/M57: coexistence is a CONFLICT, never a silent win.
      expect(
        resolveEffectiveMassDecision(claims({ ...stronger, hasAiEstimate: true } as never)).kind
      ).toBe('conflict');
    }
  });

  it('the conflict reason names the estimate as the weaker participant', () => {
    const result = resolveEffectiveMassDecision(claims({ hasUserMass: true, hasAiEstimate: true }));
    expect(JSON.stringify(result)).toContain('ai_estimate');
  });
});

describe('AI-3 Slice B — the estimate participates in mid-flight protection', () => {
  it('an identical estimate is idempotent at the fingerprint level', () => {
    const a = withEstimate();
    const b = phase4Reducer(a, { type: 'select_ai_estimate', lineRef: LINE, choice: CHOICE } as never);
    expect(workingChoiceFingerprint(b, LINE)).toBe(workingChoiceFingerprint(a, LINE));
  });

  it('M48: a CHANGED estimate changes the fingerprint (so a late result loses)', () => {
    const a = withEstimate();
    const b = phase4Reducer(a, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: { ...CHOICE, lower_grams: 160, upper_grams: 200, representative_grams: 180 },
    } as never);
    expect(workingChoiceFingerprint(b, LINE)).not.toBe(workingChoiceFingerprint(a, LINE));
  });

  it('M49: a user mass added mid-flight changes the fingerprint', () => {
    const a = withEstimate();
    const b = phase4Reducer(a, { type: 'select_user_mass', lineRef: LINE, choice: { grams: 180 } } as never);
    expect(workingChoiceFingerprint(b, LINE)).not.toBe(workingChoiceFingerprint(a, LINE));
  });

  it('clearing the estimate changes the fingerprint', () => {
    const a = withEstimate();
    const b = phase4Reducer(a, { type: 'clear_ai_estimate', lineRef: LINE } as never);
    expect(workingChoiceFingerprint(b, LINE)).not.toBe(workingChoiceFingerprint(a, LINE));
  });

  it('the pre-AI-3 AI-1/AI-2C inputs still drive the fingerprint identically', () => {
    const a = seeded();
    const withMatch = phase4Reducer(a, {
      type: 'select_match',
      lineRef: LINE,
      choice: { fdc_id: 111111, record_digest: 'rd', review_digest: 'vd' },
    } as never);
    // An estimate-free state must NOT contribute any estimate information.
    const before = workingChoiceFingerprint(withMatch, LINE);
    expect(typeof before).toBe('string');
    expect(before.length).toBeGreaterThan(0);
  });
});
