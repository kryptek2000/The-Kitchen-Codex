/**
 * AI-3 — M50 DIRECT PROVENANCE ANTI-LAUNDERING WITNESS.
 *
 * Historical invariant: an AI estimate must NEVER reach final accepted evidence
 * carrying an authenticated / USDA provenance class.
 *
 * This witness observes the FINAL accepted evidence field (`evidence.provenance`),
 * not a reason string, an intermediate proposal, or the request builder. The
 * repository-real authenticated classes are `usda_derived` and `vetted_standard`
 * (see `isAuthenticatedProvenanceClass`).
 *
 * ANTI-VACUITY CONTROL: the canonical `ai_estimate` class is ACCEPTED, so the
 * malicious cases are not merely proving that everything is rejected.
 */
import { describe, it, expect } from 'vitest';

import { validateAiEstimateForWorkingState, deterministicMidpointGrams } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { AI_ESTIMATE_POLICY_VERSION, AI_ESTIMATE_PROVENANCE_CLASS } from '../../src/core/nutritionV2/aiAdvancedEstimate';

const LINE = 'ing:0:m50';
const LOWER = 100;
const UPPER = 200;
const MID = deterministicMidpointGrams(LOWER, UPPER);

/** The repository-real classes `isAuthenticatedProvenanceClass` treats as authority. */
const AUTHENTICATED = ['usda_derived', 'vetted_standard'] as const;

function raw(provenance: string): Record<string, unknown> {
  return {
    policy_version: AI_ESTIMATE_POLICY_VERSION,
    provenance_class: provenance,
    line_ref: LINE,
    lower_grams: LOWER,
    upper_grams: UPPER,
    representative_grams: MID,
    representative_policy: 'midpoint',
    input_semantics: ['count'],
    evidence_absent_reason: 'none',
  };
}

describe('M50 — an AI estimate is never laundered into authenticated provenance', () => {
  it('ANTI-VACUITY CONTROL: the canonical ai_estimate class is ACCEPTED with canonical final provenance', () => {
    const r = validateAiEstimateForWorkingState(raw(AI_ESTIMATE_PROVENANCE_CLASS), LINE);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    // The FINAL accepted evidence field, which is what production consumes.
    expect(r.evidence.provenance).toBe('ai_estimate');
  });

  it('M50: a model claiming an AUTHENTICATED class never reaches final evidence', () => {
    for (const cls of AUTHENTICATED) {
      const r = validateAiEstimateForWorkingState(raw(cls), LINE);
      // Refused, and nothing carrying that class is emitted.
      expect(r.ok).toBe(false);
      if (r.ok === true) {
        throw new Error('laundering succeeded for ' + cls);
      }
      // The refusal is an authority refusal, not a tolerance clamp.
      expect(r.reason).toBe('authority_field');
    }
  });

  it('M50: ANY non-canonical class is refused; only ai_estimate is ever accepted', () => {
    for (const cls of [...AUTHENTICATED, 'USDA', 'usda', 'authenticated', 'user_mass', '']) {
      const r = validateAiEstimateForWorkingState(raw(cls), LINE);
      if (r.ok === true) throw new Error('accepted foreign provenance: ' + JSON.stringify(cls));
    }
  });

  it('M50: final evidence provenance is the constant ai_estimate, never derived from model input', () => {
    const r = validateAiEstimateForWorkingState(raw(AI_ESTIMATE_PROVENANCE_CLASS), LINE);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.evidence.provenance).toBe('ai_estimate');
    expect(r.evidence.provenance).not.toBe('usda_derived');
    expect(r.evidence.provenance).not.toBe('vetted_standard');
  });
});
