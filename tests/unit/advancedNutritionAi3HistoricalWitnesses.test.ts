/**
 * AI-3 — HISTORICAL M41–M61 CAUSAL WITNESSES (clean tree).
 *
 * Each test drives the CURRENT production guard that implements the
 * architect's authoritative historical meaning, and asserts that meaning
 * directly through result semantics (not source inspection).
 *
 * Coverage here:
 *   M41 / M42 / M57  shared current guard family: resolveEffectiveMassDecision
 *   M44a / M44b      numeric validity + MAX_AI_ESTIMATE_RANGE_RATIO
 *   M45              midpoint agreement (NOT ownership)
 *   M46 / M47a / M47b  model nutrient / FDC / portion authority
 *   M50              provenance is never laundered to authenticated
 *   M58              deterministic code owns the representative grams
 *
 * M48 / M49 / M52 / M53 / M55 are witnessed in their existing dedicated files
 * (see scripts/ai3_mutation_manifest.json -> mapped_witness_file).
 */
import { describe, it, expect } from 'vitest';

import { resolveEffectiveMassDecision } from '../../src/core/nutritionV2/calculation/effectiveMass';
import {
  validateAiEstimateForWorkingState,
  deterministicMidpointGrams,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import {
  AI_ESTIMATE_POLICY_VERSION,
  AI_ESTIMATE_PROVENANCE_CLASS,
  MAX_AI_ESTIMATE_BOUND_GRAMS,
} from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { MAX_AI_ESTIMATE_RANGE_RATIO } from '../../src/core/nutritionV2/aiEstimateBounds';

const LINE = 'ing:0:historical';

/** A minimal, production-shaped raw model response. */
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

function rejectReason(raw: unknown): string {
  const result = validateAiEstimateForWorkingState(raw, LINE);
  if (result.ok === true) throw new Error('expected the proposal to be REFUSED, but it was accepted');
  return result.reason;
}

// ===========================================================================
// M41 / M42 / M57 — ONE shared current guard family, THREE historical scenarios
// ===========================================================================

describe('M41/M42/M57 — shared current guard: effective-mass AI/stronger conflict', () => {
  const NONE = {
    directMassGrams: undefined,
    hasUserMass: false,
    hasSourcePortion: false,
    hasCountPortion: false,
    hasHouseholdPortion: false,
  } as const;

  it('[AI3-M41-HIST] M41: an AI estimate NEVER wins over a non-user stronger authority (source portion)', () => {
    const decision = resolveEffectiveMassDecision({
      ...NONE,
      hasSourcePortion: true,
      hasAiEstimate: true,
    });
    // The historical invariant: the estimate does not silently become mass.
    expect(decision.kind).toBe('conflict');
    if (decision.kind === 'conflict') {
      expect(decision.reason).toBe('ai_estimate_with_stronger_source');
    }
  });

  it('M41: the same holds for count portion and for the verified household portion', () => {
    for (const stronger of ['hasCountPortion', 'hasHouseholdPortion'] as const) {
      const decision = resolveEffectiveMassDecision({ ...NONE, [stronger]: true, hasAiEstimate: true });
      expect(decision.kind).toBe('conflict');
    }
  });

  it('M41: the AI estimate is the lowest authority — it wins only when ALONE', () => {
    const alone = resolveEffectiveMassDecision({ ...NONE, hasAiEstimate: true });
    expect(alone.kind).toBe('ai_estimate');
  });

  it('[AI3-M42-HIST] M42: USER MASS IS NEVER OVERWRITTEN by an AI estimate', () => {
    const decision = resolveEffectiveMassDecision({
      ...NONE,
      hasUserMass: true,
      hasAiEstimate: true,
    });
    expect(decision.kind).toBe('conflict');
    if (decision.kind === 'conflict') {
      expect(decision.reason).toBe('ai_estimate_with_stronger_source');
    }
    // The estimate is never returned as the effective mass for that line.
    expect(decision.kind).not.toBe('ai_estimate');
  });

  it('[AI3-M57-HIST] M57: coexistence is represented as a CONFLICT, never as a valid state', () => {
    // A scenario distinct from M42: a USDA count portion coexists with the
    // estimate. The historical invariant is the umbrella one: coexistence with
    // an incompatible mass authority is NOT a valid non-conflicting state.
    const coexisting = resolveEffectiveMassDecision({
      ...NONE,
      hasCountPortion: true,
      hasAiEstimate: true,
    });
    expect(coexisting.kind).toBe('conflict');

    // Three simultaneous claims (two stronger + estimate) is still a conflict,
    // and is NOT silently resolved in the estimate's favour.
    const threeWay = resolveEffectiveMassDecision({
      ...NONE,
      hasUserMass: true,
      hasSourcePortion: true,
      hasAiEstimate: true,
    });
    expect(threeWay.kind).toBe('conflict');
  });

  it('M57: authored direct mass plus an estimate is its own named conflict', () => {
    const decision = resolveEffectiveMassDecision({
      ...NONE,
      directMassGrams: 120,
      hasAiEstimate: true,
    });
    expect(decision.kind).toBe('conflict');
    if (decision.kind === 'conflict') {
      expect(decision.reason).toBe('direct_mass_with_ai_estimate');
    }
  });
});

// ===========================================================================
// M44 — TYPE-B: numeric validity (a) and max range ratio (b)
// ===========================================================================

describe('M44 — TYPE-B numeric bounds', () => {
  it('[AI3-M44-NONFINITE-HIST] M44 NONFINITE non-destructive pin: non-finite bounds are refused through the real production path', () => {
    // NON-DESTRUCTIVE REDUNDANT-DEFENSE PIN.
    //
    // This is a BEHAVIOURAL pin, not a destructive obligation. It proves the
    // historical invariant — the engine must continue rejecting non-finite
    // estimate bounds — and it deliberately does NOT claim that
    // `!Number.isFinite` is the sole defence. Direct production probing proves
    // the clause is redundant defense-in-depth: NaN is refused by the ordering
    // relation guard, +Infinity by MAX_AI_ESTIMATE_BOUND_GRAMS, -Infinity by
    // the positivity guard. Removing the clause changes no observable
    // behaviour, so this obligation carries no destructive mutation verdict.
    //
    // Representative non-finite values across all three independent refusals.
    expect(rejectReason(proposal({ lower_grams: Number.NaN }))).toBe('invalid_proposal');
    expect(rejectReason(proposal({ upper_grams: Number.NaN }))).toBe('invalid_proposal');
    expect(rejectReason(proposal({ representative_grams: Number.NaN }))).toBe('invalid_proposal');
    expect(rejectReason(proposal({ upper_grams: Number.POSITIVE_INFINITY }))).toBe('invalid_proposal');
    expect(rejectReason(proposal({ lower_grams: Number.NEGATIVE_INFINITY }))).toBe('invalid_proposal');
    // All three bounds non-finite simultaneously.
    expect(rejectReason(proposal({
      lower_grams: Number.NaN,
      upper_grams: Number.NaN,
      representative_grams: Number.NaN,
    }))).toBe('invalid_proposal');
    // ANTI-VACUITY: a well-formed finite proposal IS accepted, so the refusals
    // above are real refusals and not a permanently-dead validation path.
    expect(validateAiEstimateForWorkingState(proposal({}), LINE).ok).toBe(true);
  });

  it('[AI3-M44-NONPOSITIVE-HIST] M44 non-positive bound is refused', () => {
    expect(rejectReason(proposal({ lower_grams: 0 }))).toBe('invalid_proposal');
    expect(rejectReason(proposal({ upper_grams: -5 }))).toBe('invalid_proposal');
  });

  it('M44 (unscoped, retained): a bound beyond the canonical gram ceiling is refused', () => {
    // The FROZEN SANITIZER runs first and is stricter: it drops an
    // over-ceiling gram value as an invalid proposal before the AI-3
    // validation layer's out_of_bounds check is ever reached. Either way the
    // bound is refused and never clamped into validity.
    const reason = rejectReason(proposal({ lower_grams: MAX_AI_ESTIMATE_BOUND_GRAMS + 1 }));
    expect(['invalid_proposal', 'out_of_bounds']).toContain(reason);
  });

  it('[AI3-M44-RATIO-HIST] M44 ratio: a range wider than 4x is REFUSED, never clamped', () => {
    expect(MAX_AI_ESTIMATE_RANGE_RATIO).toBe(4);
    // 500/100 = 5x -> refused.
    expect(rejectReason(proposal({ lower_grams: 100, upper_grams: 500, representative_grams: 300 }))).toBe(
      'range_ratio_exceeded'
    );
  });

  it('M44 ratio: exactly 4x is ACCEPTED, so the bound is a real threshold and not dead code', () => {
    const atLimit = validateAiEstimateForWorkingState(
      proposal({ lower_grams: 100, upper_grams: 400, representative_grams: 250 }),
      LINE
    );
    expect(atLimit.ok).toBe(true);
  });
});

// ===========================================================================
// M45 — midpoint AGREEMENT (ownership is M58)
// ===========================================================================

describe('M45 — non-midpoint / conflicting midpoint', () => {
  it('[AI3-M45-HIST] a model representative that disagrees with the deterministic midpoint is refused', () => {
    expect(rejectReason(proposal({ representative_grams: 199 }))).toBe('midpoint_mismatch');
  });

  it('the refusal is not a clamp: a disagreeing model value never becomes the evidence', () => {
    const result = validateAiEstimateForWorkingState(
      proposal({ lower_grams: 100, upper_grams: 200, representative_grams: 101 }),
      LINE
    );
    expect(result.ok).toBe(false);
  });

  it('a representative that agrees is accepted (the guard discriminates, not blanket-refuses)', () => {
    expect(validateAiEstimateForWorkingState(proposal(), LINE).ok).toBe(true);
  });
});

// ===========================================================================
// M46 / M47 — model nutrient / FDC / portion authority (TYPE-B scenarios)
// ===========================================================================

describe('M46 — model nutrient authority', () => {
  it('[AI3-M46-HIST] a nutrient-shaped authority field is rejected as an authority field', () => {
    expect(rejectReason(proposal({ nutrients: { calories: 300 } }))).toBe('authority_field');
    expect(rejectReason(proposal({ calories: 300 }))).toBe('authority_field');
    expect(rejectReason(proposal({ codex_nutrition: { protein: 12 } }))).toBe('authority_field');
  });

  it('nutrient text in an allowed ADVISORY key is accepted but grants NO authority', () => {
    // `notes` is a bounded advisory string and is deliberately allowed. Carrying
    // nutrient-shaped TEXT in it must not yield nutrient authority: the proposal
    // still validates as an ai_estimate and contributes no nutrient value.
    const result = validateAiEstimateForWorkingState(
      proposal({ notes: 'codex_nutrition={"calories":300}' }),
      LINE
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.evidence.provenance).toBe('ai_estimate');
      expect(Object.keys(result.evidence)).not.toContain('nutrients');
      expect(Object.keys(result.evidence)).not.toContain('calories');
    }
  });
});

describe('M47 — model FDC / portion authority (TYPE-B)', () => {
  it('[AI3-M47A-HIST] M47a: a model-provided fdc_id is rejected as an authority field', () => {
    expect(rejectReason(proposal({ fdc_id: 2709223 }))).toBe('authority_field');
    expect(rejectReason(proposal({ food_id: 2709223 }))).toBe('authority_field');
  });

  it('[AI3-M47B-HIST] M47b: a model-provided USDA portion is rejected as an authority field', () => {
    expect(rejectReason(proposal({ source_portion_grams: 150 }))).toBe('authority_field');
    expect(rejectReason(proposal({ portion_index: 2 }))).toBe('authority_field');
  });

  it('M47: a model claiming USDA derivation is rejected', () => {
    expect(rejectReason(proposal({ usda_derived: true }))).toBe('authority_field');
  });
});

// ===========================================================================
// M50 — the estimate is never mislabelled as authenticated USDA authority
// ===========================================================================

describe('M50 — mislabel authenticated', () => {
  it('an authenticated provenance class is refused as an authority field', () => {
    expect(rejectReason(proposal({ provenance_class: 'usda_authenticated' }))).toBe('authority_field');
  });

  it('the accepted evidence is stamped ai_estimate, never an authenticated class', () => {
    const result = validateAiEstimateForWorkingState(proposal(), LINE);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.evidence.provenance).toBe('ai_estimate');
      expect(result.evidence.provenance).not.toBe('usda_authenticated');
    }
  });
});

// ===========================================================================
// M58 — deterministic code OWNS the representative grams
// ===========================================================================

describe('M58 — model representative never owns the authoritative midpoint', () => {
  it('the returned representative is the locally derived midpoint, byte for byte', () => {
    const lower = 120;
    const upper = 260;
    const result = validateAiEstimateForWorkingState(
      proposal({
        lower_grams: lower,
        upper_grams: upper,
        representative_grams: deterministicMidpointGrams(lower, upper),
      }),
      LINE
    );
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.evidence.representative_grams).toBe(deterministicMidpointGrams(lower, upper));
      expect(result.evidence.representative_policy).toBe('midpoint');
    }
  });

  it('a model representative that DISAGREES is refused, never substituted as authoritative', () => {
    // This is the load-bearing half of M58: the model value never reaches the
    // evidence, so it can never own representative grams.
    const claimed = 199; // inside [100,200] but NOT the midpoint of 150
    const result = validateAiEstimateForWorkingState(
      proposal({ lower_grams: 100, upper_grams: 200, representative_grams: claimed }),
      LINE
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('midpoint_mismatch');
  });

  it('M58/M45 INDEPENDENCE LIMIT: ownership and agreement share one code path', () => {
    // Reported honestly rather than fabricating independence: the ONLY way to
    // observe ownership (M58) is via a value that agrees, and the ONLY way the
    // model value is prevented from owning (M58) is the agreement refusal
    // (M45). Both are proven above; they are not separately isolable.
    expect(typeof deterministicMidpointGrams(100, 200)).toBe('number');
  });
});
