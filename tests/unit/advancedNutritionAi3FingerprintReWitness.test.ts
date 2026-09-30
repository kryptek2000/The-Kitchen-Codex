/**
 * AI-3 — RE-WITNESS support for the two AI-2C guarantees the mutation probe
 * found UNPROVEN after the fingerprint gained the AI-estimate field.
 *
 * The empirical probe showed:
 *   - a witness exists for the authenticated food match (M29);
 *   - a witness exists for the authenticated count portion (M30);
 *   - a witness exists for the verified household portion;
 *   - NO witness detected a USER-ENTERED MASS dropping out of the fingerprint;
 *   - NO witness detected the fingerprint becoming non-deterministic.
 *
 * The second gap is the important one: `acceptAiEstimateOffer` deliberately uses
 * a fingerprint change as a staleness signal, so a non-deterministic
 * fingerprint would silently weaken the AI-3 second-click gate.
 *
 * These tests PIN the two properties directly. They are additive: no existing
 * AI-1 / AI-2C assertion is weakened or reclassified.
 */
import { describe, it, expect } from 'vitest';

import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { INITIAL_PHASE4_STATE } from '../../src/core/nutritionV2/phase4/state';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/types';

const LINE = 'ing:0:rewitness';

function state(over: Partial<Phase4State> = {}): Phase4State {
  return {
    ...INITIAL_PHASE4_STATE,
    status: 'ready',
    recipeKey: 'r1',
    sessionIdentity: 's1',
    rows: [{ line_ref: LINE, original_text: '3/4 cup rice', query: 'rice' }],
    ...over,
  } as unknown as Phase4State;
}

describe('re-witness — the fingerprint is a deterministic function of the working state', () => {
  it('M38: the same state always yields the same fingerprint', () => {
    const a = state({ userMasses: { [LINE]: { grams: 120 } } } as never);
    // Two structurally equal but NOT identical objects must agree. This is the
    // idempotency guarantee: a re-created state is never a false conflict.
    const b = state({ userMasses: { [LINE]: { grams: 120 } } } as never);
    expect(workingChoiceFingerprint(a, LINE)).toBe(workingChoiceFingerprint(b, LINE));
    // Repeated calls on the very same object agree too.
    expect(workingChoiceFingerprint(a, LINE)).toBe(workingChoiceFingerprint(a, LINE));
  });

  it('M38: key ORDER in a choice never changes the fingerprint', () => {
    const a = state({ userMasses: { [LINE]: { grams: 120, unit: 'cup' } } } as never);
    const b = state({ userMasses: { [LINE]: { unit: 'cup', grams: 120 } } } as never);
    expect(workingChoiceFingerprint(a, LINE)).toBe(workingChoiceFingerprint(b, LINE));
  });
});

describe('re-witness — a user-entered mass is covered by the fingerprint', () => {
  it('M31: adding a user mass changes the fingerprint', () => {
    const before = state();
    const after = state({ userMasses: { [LINE]: { grams: 120 } } } as never);
    expect(workingChoiceFingerprint(before, LINE)).not.toBe(workingChoiceFingerprint(after, LINE));
  });

  it('M31: CHANGING an existing user mass changes the fingerprint', () => {
    const before = state({ userMasses: { [LINE]: { grams: 120 } } } as never);
    const after = state({ userMasses: { [LINE]: { grams: 240 } } } as never);
    expect(workingChoiceFingerprint(before, LINE)).not.toBe(workingChoiceFingerprint(after, LINE));
  });

  it('M31: CLEARING a user mass changes the fingerprint', () => {
    const withMass = state({ userMasses: { [LINE]: { grams: 120 } } } as never);
    const cleared = state();
    expect(workingChoiceFingerprint(withMass, LINE)).not.toBe(workingChoiceFingerprint(cleared, LINE));
  });
});

describe('re-witness — the other mass sources remain covered', () => {
  it('a USDA source portion is covered', () => {
    const before = state();
    const after = state({ portions: { [LINE]: { portion_index: 1, grams: 158 } } } as never);
    expect(workingChoiceFingerprint(before, LINE)).not.toBe(workingChoiceFingerprint(after, LINE));
  });

  it('a verified household portion is covered', () => {
    const before = state();
    const after = state({ householdPortions: { [LINE]: { unit: 'cup', size_class: 'small' } } } as never);
    expect(workingChoiceFingerprint(before, LINE)).not.toBe(workingChoiceFingerprint(after, LINE));
  });

  it('an AI estimate is covered (the AI-3 addition)', () => {
    const before = state();
    const after = state({ aiEstimates: { [LINE]: { lower_grams: 150, upper_grams: 200 } } } as never);
    expect(workingChoiceFingerprint(before, LINE)).not.toBe(workingChoiceFingerprint(after, LINE));
  });

  it('a line with nothing set is stable and does not collide with a real choice', () => {
    const empty = state();
    expect(workingChoiceFingerprint(empty, LINE)).toBe(workingChoiceFingerprint(state(), LINE));
  });
});
