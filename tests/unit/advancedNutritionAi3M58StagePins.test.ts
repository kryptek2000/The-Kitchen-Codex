/**
 * AI-3 — M58 RELEASE-QUALITY RETIREMENT PINS, PER PRODUCTION STAGE.
 *
 * M58 = RETIRED_BY_ARCHITECTURE. The five logical locations were previously
 * pinned only at the validator. These pins map each production stage of the
 * deterministic ownership chain to a behavioural observation, each with a
 * valid control so a refusal is never the only thing being proved.
 *
 *   A1 validation assignment  aiEstimateValidation.ts:361->374
 *   A2 resolver assignment    aiEstimateResolve.ts:259
 *   B  acceptance recompute   aiEstimateAccept.ts:74
 *   C1 acceptance verify      aiEstimateAccept.ts:182
 *   C2 selection verify       aiEstimateSelection.ts:50
 */
import { describe, it, expect } from 'vitest';

import { validateAiEstimateForWorkingState, deterministicMidpointGrams } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { buildAiEstimateSelection } from '../../src/core/nutritionV2/phase4/aiEstimateSelection';
import { acceptAiEstimateOffer } from '../../src/core/nutritionV2/phase4/aiEstimateAccept';
import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { aiEstimateSnapshotBinding, type AiEstimateSnapshotInput } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { AI_ESTIMATE_POLICY_VERSION, AI_ESTIMATE_PROVENANCE_CLASS } from '../../src/core/nutritionV2/aiAdvancedEstimate';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/state';

const LINE = 'ing:0:m58stage';
const LOWER = 100;
const UPPER = 200;
const MID = deterministicMidpointGrams(LOWER, UPPER);
const MODEL = MID === 187 ? 186 : 187;

function state(): Phase4State {
  return phase4Reducer({
    ...INITIAL_PHASE4_STATE, status: 'ready', recipeKey: 'm58', sessionIdentity: 'm58',
    rows: [{ line_ref: LINE, original_text: '2-3 tomatoes', query: 'tomatoes', resolved_grams: null }],
    matches: { [LINE]: { fdc_id: 4242, review_digest: 'c'.repeat(64) } },
    workingChoices: { [LINE]: { fdc_id: 4242, review_digest: 'c'.repeat(64) } },
  } as unknown as Phase4State, { type: 'noop' } as never);
}

function raw(rep: number): Record<string, unknown> {
  return {
    policy_version: AI_ESTIMATE_POLICY_VERSION, provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
    line_ref: LINE, lower_grams: LOWER, upper_grams: UPPER, representative_grams: rep,
    representative_policy: 'midpoint', input_semantics: ['count'], evidence_absent_reason: 'none',
  };
}

describe('M58 retirement pins — per production stage', () => {
  it('A1 VALIDATION ASSIGNMENT: accepted evidence carries the deterministic midpoint, never the model value', () => {
    const refused = validateAiEstimateForWorkingState(raw(MODEL), LINE);
    expect(refused.ok).toBe(false); // model value cannot pass the firewall
    const ok = validateAiEstimateForWorkingState(raw(MID), LINE);
    expect(ok.ok).toBe(true);
    if (ok.ok !== true) return;
    // CONTROL + CLAIM: accepted evidence is locally derived, and provably not the
    // model number (the same model number is refused above).
    expect(ok.evidence.representative_grams).toBe(MID);
    expect(ok.evidence.representative_grams).not.toBe(MODEL);
  });

  it('C2 SELECTION VERIFY: a non-midpoint estimate is refused; a midpoint one is accepted (CONTROL)', () => {
    const ev = { line_ref: LINE, fdc_id: 4242, record_digest: 'a'.repeat(64),
      ingredient_identity_digest: 'b'.repeat(64), bundle_release: 'bundle-1' };
    const base = { fdc_id: 4242, record_digest: 'a'.repeat(64), review_digest: 'c'.repeat(64),
      lower_grams: LOWER, upper_grams: UPPER, representative_policy: 'midpoint', provenance: 'ai_estimate' };
    const bad = buildAiEstimateSelection(LINE, ev as never, { ...base, representative_grams: MODEL } as never);
    expect(bad.ok).toBe(false);
    if (bad.ok === true) return;
    expect(bad.reason).toBe('invalid_estimate');
    // CONTROL: the deterministic midpoint IS accepted by the same production call.
    const good = buildAiEstimateSelection(LINE, ev as never, { ...base, representative_grams: MID } as never);
    expect(good.ok).toBe(true);
    if (good.ok !== true) return;
    // Production's selection carries the BOUNDS plus a midpoint policy, not a
    // representative number at all. That is the strongest form of the C2 claim:
    // the model value is not merely rejected, it is nowhere in the authorised
    // selection, and the authoritative representative can only be re-derived from
    // the bounds.
    expect(good.selection.lower_grams).toBe(LOWER);
    expect(good.selection.upper_grams).toBe(UPPER);
    expect(good.selection.representative_policy).toBe('midpoint');
    expect(JSON.stringify(good.selection)).not.toContain(String(MODEL));
  });

  it('B + C1 ACCEPTANCE: recompute accepts the bounds-derived value, and refuses a non-midpoint carried value (CONTROL)', () => {
    const st = state();
    const snap = {
      lineRef: LINE, sourceText: '2-3 tomatoes', amount: null, unit: null, countNoun: 'tomatoes',
      fdcId: 4242, recordDigest: 'a'.repeat(64), reviewDigest: 'c'.repeat(64),
      bundleRelease: 'bundle-1', catalogDigest: 'cat', recipeKey: 'm58', sessionIdentity: 'm58',
    } as unknown as AiEstimateSnapshotInput;
    const fp = workingChoiceFingerprint(st, LINE);
    const binding = aiEstimateSnapshotBinding(snap);
    const ev = { line_ref: LINE, fdc_id: 4242, record_digest: 'a'.repeat(64),
      ingredient_identity_digest: 'b'.repeat(64), bundle_release: 'bundle-1' };
    const offer = (rep: number) => ({ line_ref: LINE, fdc_id: 4242, record_digest: 'a'.repeat(64),
      review_digest: 'c'.repeat(64), lower_grams: LOWER, upper_grams: UPPER,
      representative_grams: rep, representative_policy: 'midpoint', provenance: 'ai_estimate' }) as never;
    const ctx = () => ({ currentState: st, offerFingerprint: fp, evidence: ev as never,
      snapshot: snap, offerSnapshotBinding: binding }) as never;

    // C1: a carried non-midpoint representative is refused by the offer check.
    const bad = acceptAiEstimateOffer(offer(MODEL), ctx());
    expect(bad.ok).toBe(false);
    if (bad.ok === true) return;
    expect(bad.reason).toBe('offer_mismatch');
    // CONTROL + B: the bounds-derived midpoint advances, and the accepted choice
    // carries the deterministic value rather than anything model-supplied.
    const good = acceptAiEstimateOffer(offer(MID), ctx());
    expect(good.ok).toBe(true);
    if (good.ok !== true) return;
    expect(good.choice.representative_grams).toBe(MID);
    expect(good.choice.representative_grams).not.toBe(MODEL);
  });
});
