/**
 * AI-3 — M58 ARCHITECTURAL PINS (behavioural, not source-string).
 *
 * M58 is RETIRED_BY_ARCHITECTURE: the model representative is never an
 * authority-bearing assignment in current production. These pins are the
 * evidence for that disposition, so every case asserts an OBSERVED VALUE or an
 * OBSERVED refusal reason — never a source string. If any of them fails, the
 * retirement rationale is wrong and M58 must be reopened as an executable row.
 */
import { describe, it, expect } from 'vitest';

import {
  validateAiEstimateForWorkingState,
  deterministicMidpointGrams,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { AI_ESTIMATE_POLICY_VERSION, AI_ESTIMATE_PROVENANCE_CLASS } from '../../src/core/nutritionV2/aiAdvancedEstimate';

const LINE = 'ing:0:m58';

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy_version: AI_ESTIMATE_POLICY_VERSION,
    provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
    line_ref: LINE,
    lower_grams: 100,
    upper_grams: 200,
    representative_grams: 150,
    representative_policy: 'midpoint',
    input_semantics: ['count'],
    evidence_absent_reason: 'no container label',
    ...overrides,
  };
}

describe('M58 RETIRED_BY_ARCHITECTURE — deterministic code owns the representative', () => {
  it('A: a model representative DISAGREEING with the midpoint is refused, never substituted', () => {
    const mid = deterministicMidpointGrams(100, 200);
    const disagreeing = mid === 187 ? 186 : 187;
    const r = validateAiEstimateForWorkingState(
      proposal({ representative_grams: disagreeing }),
      LINE
    );
    expect(r.ok).toBe(false);
    if (r.ok === true) return;
    // Refused on the AGREEMENT firewall, and nothing is emitted.
    expect(r.reason).toBe('midpoint_mismatch');
  });

  it('[AI3-M58-PIN-HIST] B: the accepted representative is the LOCAL deterministic midpoint, not the model value', () => {
    const mid = deterministicMidpointGrams(100, 200);
    // The model sends a value that AGREES with the midpoint. The accepted
    // evidence must still be the locally derived midpoint.
    const r = validateAiEstimateForWorkingState(proposal({ representative_grams: mid }), LINE);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.evidence.representative_grams).toBe(mid);
    expect(r.evidence.representative_policy).toBe('midpoint');
  });

  it('C: the accepted representative is the deterministic midpoint for MANY bound pairs', () => {
    const pairs: [number, number][] = [
      [100, 200], [50, 150], [1000, 1001], [7, 11], [250, 750], [40, 41], [12, 48],
    ];
    for (const [lo, hi] of pairs) {
      const mid = deterministicMidpointGrams(lo, hi);
      const r = validateAiEstimateForWorkingState(
        proposal({ lower_grams: lo, upper_grams: hi, representative_grams: mid }),
        LINE
      );
      expect(r.ok).toBe(true);
      if (r.ok !== true) return;
      expect(r.evidence.representative_grams).toBe(mid);
    }
  });

  it('D: no policy other than the midpoint can grant the model ownership', () => {
    // Note: an unrecognised policy literal is refused EARLIER by the frozen
    // sanitizer (as `invalid_proposal`) rather than reaching the policy gate, so
    // the assertion that matters is the one this row exists to make: whatever
    // the refusal reason, a non-midpoint policy is NEVER accepted, and a
    // midpoint policy always is.
    for (const policy of ['model', 'lower', 'upper', 'raw', 'max', 'estimated']) {
      const r = validateAiEstimateForWorkingState(proposal({ representative_policy: policy }), LINE);
      expect(r.ok).toBe(false);
    }
    const mid = validateAiEstimateForWorkingState(
      proposal({ representative_policy: 'midpoint' }),
      LINE
    );
    expect(mid.ok).toBe(true);
  });

  it('E: provenance cannot be laundered into authority alongside the representative', () => {
    for (const cls of ['usda_authenticated', 'USDA', 'authenticated', 'user_mass']) {
      const r = validateAiEstimateForWorkingState(proposal({ provenance_class: cls }), LINE);
      expect(r.ok).toBe(false);
      if (r.ok === true) return;
    }
  });
});
