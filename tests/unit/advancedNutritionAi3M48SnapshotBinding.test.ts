/**
 * AI-3 — M48 DIRECT SNAPSHOT-BINDING WITNESS (SINGLE, stale offer snapshot binding).
 *
 * The historical staleness matrix is NOT this row's verdict witness: it never
 * reaches the mapped snapshot comparison. This witness drives the real
 * `acceptAiEstimateOffer` second-click gate directly and isolates ONE
 * snapshot-owned dimension (`catalogDigest`), holding everything else constant:
 *
 *   CONSTANT: line present, actionable, no stronger/user mass authority, working
 *             choice fingerprint, FDC identity, record/review/bundle/session/recipe
 *   VARIES:   catalogDigest only
 *
 * ANTI-VACUITY CONTROL (mandatory): with a MATCHING snapshot the same context
 * must ACCEPT. Without that, a stale test would prove nothing.
 */
import { describe, it, expect } from 'vitest';

import { acceptAiEstimateOffer } from '../../src/core/nutritionV2/phase4/aiEstimateAccept';
import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { aiEstimateSnapshotBinding, deterministicMidpointGrams } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/state';
import type { AiEstimateSnapshotInput } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';

const LINE = 'ing:0:m48';
const LOWER = 100;
const UPPER = 200;
const MID = deterministicMidpointGrams(LOWER, UPPER);

function state(): Phase4State {
  const seeded = {
    ...INITIAL_PHASE4_STATE,
    status: 'ready',
    recipeKey: 'm48',
    sessionIdentity: 'm48',
    rows: [
      { line_ref: LINE, original_text: '2-3 tomatoes', query: 'tomatoes', resolved_grams: null },
    ],
    matches: { [LINE]: { fdc_id: 4242, review_digest: 'c'.repeat(64) } },
    workingChoices: { [LINE]: { fdc_id: 4242, review_digest: 'c'.repeat(64) } },
  } as unknown as Phase4State;
  return phase4Reducer(seeded, { type: 'noop' } as never);
}

function snapshot(catalogDigest: string): AiEstimateSnapshotInput {
  return {
    lineRef: LINE,
    sourceText: '2-3 tomatoes',
    amount: null,
    unit: null,
    countNoun: 'tomatoes',
    fdcId: 4242,
    recordDigest: 'a'.repeat(64),
    reviewDigest: 'c'.repeat(64),
    bundleRelease: 'bundle-1',
    catalogDigest,
    recipeKey: 'm48',
    sessionIdentity: 'm48',
  } as unknown as AiEstimateSnapshotInput;
}

const OFFER = {
  line_ref: LINE,
  fdc_id: 4242,
  record_digest: 'a'.repeat(64),
  review_digest: 'c'.repeat(64),
  lower_grams: LOWER,
  upper_grams: UPPER,
  representative_grams: MID,
  representative_policy: 'midpoint',
  provenance: 'ai_estimate',
} as never;

const EVIDENCE = {
  line_ref: LINE,
  fdc_id: 4242,
  record_digest: 'a'.repeat(64),
  ingredient_identity_digest: 'b'.repeat(64),
  bundle_release: 'bundle-1',
} as never;

function context(catalogDigest: string, offerSnapshotBinding: string) {
  const st = state();
  return {
    currentState: st,
    offerFingerprint: workingChoiceFingerprint(st, LINE),
    evidence: EVIDENCE,
    snapshot: snapshot(catalogDigest),
    offerSnapshotBinding,
  } as never;
}

const ORIGINAL = snapshot('catalog-original');

describe('M48 — stale offer SNAPSHOT binding (SINGLE)', () => {
  it('ANTI-VACUITY CONTROL: a MATCHING snapshot binding is accepted', () => {
    const r = acceptAiEstimateOffer(OFFER, context('catalog-original', aiEstimateSnapshotBinding(ORIGINAL)));
    if (r.ok !== true) throw new Error('CONTROL REFUSED WITH: ' + String(r.reason));
    expect(r.ok).toBe(true);
  });

  it('the ONLY change is catalogDigest, and it really does change the binding', () => {
    // Proves the mutation dimension is live before relying on it below.
    expect(aiEstimateSnapshotBinding(snapshot('catalog-rotated'))).not.toBe(
      aiEstimateSnapshotBinding(ORIGINAL)
    );
  });

  it('[AI3-M48-HIST] M48: a stale snapshot binding is REFUSED as snapshot_changed', () => {
    // Everything else is byte-identical to the accepted control above: same line,
    // same actionable state, no stronger or user mass, same FDC identity, same
    // record/review/bundle/session/recipe. Only catalogDigest moved.
    const r = acceptAiEstimateOffer(OFFER, context('catalog-rotated', aiEstimateSnapshotBinding(ORIGINAL)));
    expect(r.ok).toBe(false);
    if (r.ok === true) return;
    expect(r.reason).toBe('snapshot_changed');
  });
});
