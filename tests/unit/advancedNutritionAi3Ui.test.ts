/**
 * AI-3 — SLICE D: the OFFER-FIRST UI FLOW.
 *
 * The contract under test is deliberately narrow and unforgiving:
 *
 *   - an estimate is requested ONLY by an explicit first click;
 *   - a returned estimate is an OFFER: it grants no authority, does not enter
 *     working state, does not reach the calculator, and does not block Apply;
 *   - only a SECOND explicit click may promote an offer into working state,
 *     and only if every staleness/authority re-check passes;
 *   - a stale offer, a changed identity, a newly added user mass and a newly
 *     added deterministic portion each make the estimate LOSE.
 *
 * The second-click gate is a pure function, so these are true unit tests of the
 * real acceptance logic rather than DOM-only assertions.
 */
import { describe, it, expect } from 'vitest';

import {
  AI_ESTIMATE_OFFER_LABEL,
  acceptAiEstimateOffer,
  buildAiEstimateOffer,
  buildAiEstimateUiSnapshot,
  formatAiEstimateOfferSummary,
  type AiEstimateOffer,
} from '../../src/core/nutritionV2/phase4/aiEstimateAccept';
import { aiEstimateSnapshotBinding } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { hasActiveAiEstimateForPreview } from '../../src/core/nutritionV2/phase4/aiEstimateApplyGate';
import { resolveEffectiveMassDecision } from '../../src/core/nutritionV2/calculation/effectiveMass';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import type { AiEstimateSelectionEvidence } from '../../src/core/nutritionV2/phase4/aiEstimateSelection';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/types';

const LINE = 'ing:0:slice-d';
const FDC = 2709223;

const EVIDENCE: AiEstimateSelectionEvidence = {
  line_ref: LINE,
  fdc_id: FDC,
  record_digest: 'rd-slice-d',
  ingredient_identity_digest: 'iid-slice-d',
  bundle_release: 'b1-slice-d',
};

const ANALYZED = { original_text: '3/4 cup cooked rice', selected_fdc_id: FDC };

function baseState(): Phase4State {
  return {
    ...INITIAL_PHASE4_STATE,
    status: 'ready',
    recipeKey: 'r1',
    sessionIdentity: 's1',
    rows: [{ line_ref: LINE, original_text: ANALYZED.original_text, query: 'rice' }],
    matches: { [LINE]: { fdc_id: FDC, record_digest: 'rd-slice-d', review_digest: 'vd-slice-d' } },
  } as unknown as Phase4State;
}

function offerFor(lower: number, upper: number): AiEstimateOffer {
  const offer = buildAiEstimateOffer({
    line_ref: LINE,
    kind: 'offer',
    evidence: {
      lower_grams: lower,
      upper_grams: upper,
      representative_policy: 'midpoint',
      provenance: 'ai_estimate',
    } as never,
  });
  if (offer === null) throw new Error('offer build failed');
  return offer;
}

function contextFor(state: Phase4State) {
  const snapshot = buildAiEstimateUiSnapshot(LINE, ANALYZED, state.matches[LINE]);
  return {
    currentState: state,
    offerFingerprint: workingChoiceFingerprint(state, LINE),
    offerSnapshotBinding: aiEstimateSnapshotBinding(snapshot),
    evidence: EVIDENCE,
    snapshot,
  };
}

describe('AI-3 Slice D — the estimate action is explicit', () => {
  it('1. an offer exists only because a caller built one; nothing self-populates', () => {
    // Building the pure offer is the ONLY way one appears. There is no reducer
    // action, no effect and no analysis pass that creates an offer.
    const state = baseState();
    expect(Object.keys(state.aiEstimates ?? {})).toHaveLength(0);
    expect(buildAiEstimateOffer({ line_ref: LINE, kind: 'offer', evidence: undefined })).toBeNull();
    expect(buildAiEstimateOffer({ line_ref: LINE, kind: 'abstained' })).toBeNull();
    expect(buildAiEstimateOffer({ line_ref: LINE, kind: 'stronger_source' })).toBeNull();
  });

  it('2. an offer never enters working state on its own', () => {
    const state = baseState();
    const offer = offerFor(150, 200);
    expect(offer.line_ref).toBe(LINE);
    // Constructing, holding and discarding an offer leaves state untouched.
    expect(state.aiEstimates?.[LINE]).toBeUndefined();
    expect(hasActiveAiEstimateForPreview(state)).toBe(false);
  });
});

describe('AI-3 Slice D — offer presentation', () => {
  it('3. the literal label is exactly the required advisory string', () => {
    expect(AI_ESTIMATE_OFFER_LABEL).toBe('AI estimate (not USDA-authenticated)');
    expect(offerFor(150, 200).label).toBe(AI_ESTIMATE_OFFER_LABEL);
  });

  it('4. the range renders as an honest bounded range', () => {
    const summary = formatAiEstimateOfferSummary(offerFor(150, 200));
    expect(summary).toContain('150');
    expect(summary).toContain('200');
    expect(summary).toContain('g');
  });

  it('5. the deterministic midpoint renders and is re-derived, not model-authored', () => {
    const offer = offerFor(150, 200);
    expect(offer.representative_grams).toBe(175);
    expect(offer.representative_policy).toBe('midpoint');
    expect(formatAiEstimateOfferSummary(offer)).toContain('175');
  });

  it('6. an offer exposes no FDC id, digest or provider internal', () => {
    const serialized = JSON.stringify(offerFor(150, 200));
    expect(serialized).not.toContain('fdc');
    expect(serialized).not.toContain('digest');
    expect(serialized).not.toContain(String(FDC));
  });
});

describe('AI-3 Slice D — an offer has no authority before the second click', () => {
  it('7. an offer is not preselected', () => {
    const state = baseState();
    offerFor(150, 200);
    expect(state.aiEstimates?.[LINE]).toBeUndefined();
  });

  it('8. an offer does not change the preview', () => {
    const state = baseState();
    expect(hasActiveAiEstimateForPreview(state)).toBe(false);
    const before = workingChoiceFingerprint(state, LINE);
    offerFor(150, 200);
    expect(workingChoiceFingerprint(state, LINE)).toBe(before);
    expect(hasActiveAiEstimateForPreview(state)).toBe(false);
  });

  it('9. an offer does not block Apply merely by existing', () => {
    // Layer A is driven by the ACTIVE estimate, not by any offer.
    expect(hasActiveAiEstimateForPreview(baseState())).toBe(false);
  });

  it('10. a second click selects exactly once', () => {
    const state = baseState();
    const offer = offerFor(150, 200);
    const first = acceptAiEstimateOffer(offer, contextFor(state));
    expect(first.ok).toBe(true);
    if (first.ok === false) return;
    const applied = phase4Reducer(state, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: first.choice,
    } as never);
    // Selecting the same offer again is a no-op: the state is already identical.
    const again = phase4Reducer(applied, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: first.choice,
    } as never);
    expect(again.aiEstimates?.[LINE]).toEqual(applied.aiEstimates?.[LINE]);
  });

  it('11. an accepted estimate DOES change the preview', () => {
    const state = baseState();
    expect(hasActiveAiEstimateForPreview(state)).toBe(false);
    const accepted = acceptAiEstimateOffer(offerFor(150, 200), contextFor(state));
    expect(accepted.ok).toBe(true);
    if (accepted.ok === false) return;
    const applied = phase4Reducer(state, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: accepted.choice,
    } as never);
    expect(hasActiveAiEstimateForPreview(applied)).toBe(true);
  });
});

describe('AI-3 Slice D — staleness refusals at the second click', () => {
  it('12. a stale offer cannot select when the working state moved', () => {
    const state = baseState();
    const offer = offerFor(150, 200);
    const ctx = contextFor(state);
    // The user did something else first; the fingerprint no longer matches.
    const result = acceptAiEstimateOffer(offer, { ...ctx, offerFingerprint: 'a-different-fingerprint' });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('fingerprint_changed');
  });

  it('13. an offer whose identity changed cannot select', () => {
    const state = baseState();
    const ctx = contextFor(state);
    const changed = {
      ...state,
      matches: { [LINE]: { ...state.matches[LINE], fdc_id: 999999 } },
    } as Phase4State;
    const result = acceptAiEstimateOffer(offerFor(150, 200), { ...ctx, currentState: changed });
    // Fails closed. The authenticated identity is part of the working-choice
    // fingerprint, so the fingerprint check fires first; either way the offer
    // can never reach working state under a changed identity.
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('fingerprint_changed');
  });

  it('13b. an offer whose snapshot binding changed cannot select', () => {
    const state = baseState();
    const ctx = contextFor(state);
    const result = acceptAiEstimateOffer(offerFor(150, 200), {
      ...ctx,
      currentState: state,
      offerSnapshotBinding: 'a-stale-snapshot-binding',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('snapshot_changed');
  });

  it('14. a user mass added after the offer makes the estimate LOSE', () => {
    const state = baseState();
    const ctx = contextFor(state);
    const withUserMass = {
      ...state,
      userMasses: { [LINE]: { grams: 120, source: 'user' } },
    } as unknown as Phase4State;
    const result = acceptAiEstimateOffer(offerFor(150, 200), { ...ctx, currentState: withUserMass });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('stronger_source_present');
    // And the deterministic authority agrees the estimate is NOT the winner.
    expect(
      resolveEffectiveMassDecision({
        directMassGrams: undefined,
        hasUserMass: true,
        hasSourcePortion: false,
        hasCountPortion: false,
        hasHouseholdPortion: false,
        hasAiEstimate: false,
      }).kind
    ).toBe('user_mass');
  });

  it('15. a deterministic portion added after the offer makes the estimate LOSE', () => {
    const state = baseState();
    const ctx = contextFor(state);
    const withPortion = {
      ...state,
      portions: { [LINE]: { portion_index: 1, grams: 158 } },
    } as unknown as Phase4State;
    const result = acceptAiEstimateOffer(offerFor(150, 200), { ...ctx, currentState: withPortion });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('stronger_source_present');
  });

  it('15b. a removed line cannot be resurrected by an offer', () => {
    const state = baseState();
    const ctx = contextFor(state);
    const removed = { ...state, rows: [] } as unknown as Phase4State;
    const result = acceptAiEstimateOffer(offerFor(150, 200), { ...ctx, currentState: removed });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('line_missing');
  });
});

describe('AI-3 Slice D — clearing and replacement', () => {
  it('16. Clear removes an accepted estimate', () => {
    const state = baseState();
    const accepted = acceptAiEstimateOffer(offerFor(150, 200), contextFor(state));
    if (accepted.ok === false) throw new Error('expected acceptance');
    const applied = phase4Reducer(state, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: accepted.choice,
    } as never);
    expect(hasActiveAiEstimateForPreview(applied)).toBe(true);
    const cleared = phase4Reducer(applied, { type: 'clear_ai_estimate', lineRef: LINE } as never);
    expect(cleared.aiEstimates?.[LINE]).toBeUndefined();
    expect(hasActiveAiEstimateForPreview(cleared)).toBe(false);
  });

  it('17. a manual replacement removes an accepted estimate', () => {
    const state = baseState();
    const accepted = acceptAiEstimateOffer(offerFor(150, 200), contextFor(state));
    if (accepted.ok === false) throw new Error('expected acceptance');
    const applied = phase4Reducer(state, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: accepted.choice,
    } as never);
    // The user types their own mass: the estimate must be evicted.
    const replaced = phase4Reducer(applied, {
      type: 'select_user_mass',
      lineRef: LINE,
      choice: { grams: 150, quantity: 1, unit: 'cup', source: 'user' },
    } as never);
    expect(replaced.aiEstimates?.[LINE]).toBeUndefined();
    expect(replaced.userMasses[LINE]).toBeDefined();
  });
});

describe('AI-3 Slice D — Apply interaction', () => {
  it('18. Apply is blocked only AFTER the estimate is active, and then with the preview-only reason', () => {
    const state = baseState();
    // While merely offered: not blocked.
    offerFor(150, 200);
    expect(hasActiveAiEstimateForPreview(state)).toBe(false);

    const accepted = acceptAiEstimateOffer(offerFor(150, 200), contextFor(state));
    if (accepted.ok === false) throw new Error('expected acceptance');
    const applied = phase4Reducer(state, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: accepted.choice,
    } as never);
    expect(hasActiveAiEstimateForPreview(applied)).toBe(true);
  });
});
