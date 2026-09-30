/**
 * AI-3 — bounded mass estimation: pure core proofs.
 *
 * Covers eligibility, the deterministic 4x range bound, the deterministic
 * midpoint, the frozen contract refusals, the additive effective-mass arm, and
 * the wire/authority-isolation boundary. All PURE: no network, no filesystem,
 * no vault, no persistence.
 */
import { describe, expect, it } from 'vitest';

import {
  AI_ESTIMATE_DISPLAY_LABEL,
  AI_ESTIMATE_POLICY_VERSION,
  AI_ESTIMATE_PROVENANCE_CLASS,
  MAX_AI_ESTIMATE_BOUND_GRAMS,
  AI_ESTIMATION_AVAILABILITY,
  isAiEstimationEnabled,
  validateAiBoundedEstimateProposal,
  isAuthenticatedProvenanceClass,
} from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { MAX_AI_ESTIMATE_RANGE_RATIO } from '../../src/core/nutritionV2/aiEstimateBounds';
import {
  MAX_AI_ESTIMATE_LINES,
  AI_ESTIMATE_ABSTENTION_REASONS,
  aiEstimateSnapshotBinding,
  deterministicMidpointGrams,
  evaluateAiEstimateEligibility,
  hasUsableQuantity,
  validateAiEstimateForWorkingState,
  type AiEstimateParseFacts,
} from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { resolveEffectiveMassDecision } from '../../src/core/nutritionV2/calculation/effectiveMass';
import {
  AI_ESTIMATE_REQUEST_VERSION,
  buildAiEstimateModelRequest,
  aiEstimateRequestByteLength,
  MAX_AI_ESTIMATE_REQUEST_BYTES,
} from '../../src/core/nutritionV2/aiAdvancedEstimateWire';

const AUTHENTICATED_MATCH = { fdc_id: 111111, record_digest: 'rd', review_digest: 'vd' };

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{ line_ref: 'L1', original_text: '2 tomatoes', query: 'tomatoes' }],
    matches: { L1: AUTHENTICATED_MATCH },
    ...overrides,
  } as never;
}

const GOOD_PARSE: AiEstimateParseFacts = {
  hasDirectMass: false,
  amount: 2,
  quantityRange: null,
  container: null,
};

function eligibility(parse: AiEstimateParseFacts, state: unknown = baseState()) {
  return evaluateAiEstimateEligibility({
    state: state as never,
    lineRef: 'L1',
    parse,
    rowStatus: 'needs_amount',
    capabilityAvailable: true,
  });
}

describe('AI-3 — deliberate thaw activation', () => {
  it('activates the frozen estimate contract without changing its identity', () => {
    expect(AI_ESTIMATION_AVAILABILITY).toBe('available');
    expect(isAiEstimationEnabled()).toBe(true);
    // The frozen semantics are unchanged by the activation.
    expect(AI_ESTIMATE_PROVENANCE_CLASS).toBe('ai_estimate');
    expect(AI_ESTIMATE_POLICY_VERSION).toBe('nutrition_ai_estimate_policy_v1');
    expect(AI_ESTIMATE_DISPLAY_LABEL).toBe('AI estimate (not USDA-authenticated)');
    expect(MAX_AI_ESTIMATE_BOUND_GRAMS).toBe(1_000_000);
  });
});

describe('AI-3 — eligibility (pre-network, deterministic)', () => {
  it('1. authenticated identity + unresolved mass is eligible', () => {
    expect(eligibility(GOOD_PARSE).eligible).toBe(true);
  });

  it('2. unresolved identity is forbidden', () => {
    const result = eligibility(GOOD_PARSE, baseState({ matches: {} }));
    expect(result).toEqual({ eligible: false, reason: 'identity_unresolved' });
  });

  it('3. a needs_match live row is not actionable, so AI-3 refuses it up front', () => {
    // Since the eligibility-authority repair, the CURRENT live-row status is
    // checked BEFORE identity: a `needs_match` row is not an actionable amount
    // exception at all, so the refusal is `not_actionable`. Identity remains
    // independently refused by test 2 above.
    const result = evaluateAiEstimateEligibility({
      state: baseState() as never,
      lineRef: 'L1',
      parse: GOOD_PARSE,
      rowStatus: 'needs_match',
      capabilityAvailable: true,
    });
    expect(result).toEqual({ eligible: false, reason: 'not_actionable' });
  });

  it('8. any parsed container/package/can line is forbidden', () => {
    const result = eligibility({ ...GOOD_PARSE, container: 'can' });
    expect(result).toEqual({ eligible: false, reason: 'parsed_container' });
  });

  it('9. no usable deterministic quantity is forbidden', () => {
    const result = eligibility({ ...GOOD_PARSE, amount: null, quantityRange: null });
    expect(result).toEqual({ eligible: false, reason: 'no_usable_quantity' });
  });

  it('a written quantity RANGE is usable quantity (not an abstention)', () => {
    expect(
      hasUsableQuantity({ hasDirectMass: false, amount: null, quantityRange: { lower: 2, upper: 3 }, container: null })
    ).toBe(true);
  });

  it('a missing line is forbidden', () => {
    const result = evaluateAiEstimateEligibility({
      state: baseState({ rows: [] }) as never,
      lineRef: 'L1',
      parse: GOOD_PARSE,
      rowStatus: 'needs_amount',
      capabilityAvailable: true,
    });
    expect(result).toEqual({ eligible: false, reason: 'line_missing' });
  });

  it('the abstention vocabulary stays small and closed (no nine speculative grammars)', () => {
    expect(AI_ESTIMATE_ABSTENTION_REASONS).toEqual(['no_usable_quantity', 'parsed_container']);
  });
});

describe('AI-3 — the one centrally-owned 4x range bound', () => {
  const ev = (lower: number, upper: number, rep?: number) =>
    ({
      line_ref: 'L1',
      policy_version: AI_ESTIMATE_POLICY_VERSION,
      provenance_class: 'ai_estimate',
      lower_grams: lower,
      upper_grams: upper,
      representative_grams: rep ?? (lower + upper) / 2,
      representative_policy: 'midpoint',
      input_semantics: ['count noun: none'],
      evidence_absent_reason: 'no_authenticated_portion',
    }) as never;
  const val = (raw: unknown) => validateAiEstimateForWorkingState(raw, 'L1');

  it('19. a ratio wider than 4 is refused, never clamped', () => {
    const result = val(ev(100, 401));
    expect(result.ok).toBe(false);
  });

  it('20. a ratio of exactly 4 is accepted', () => {
    expect(val(ev(100, 400)).ok).toBe(true);
  });

  it('the bound is exactly 4 and has a single owner', () => {
    expect(MAX_AI_ESTIMATE_RANGE_RATIO).toBe(4);
  });

  it('12/13/15/16. zero, negative, NaN and Infinity are refused', () => {
    expect(val(ev(0, 10)).ok).toBe(false);
    expect(val(ev(-1, 10)).ok).toBe(false);
    expect(val(ev(Number.NaN, 10)).ok).toBe(false);
    expect(val(ev(Number.POSITIVE_INFINITY, 10)).ok).toBe(false);
  });

  it('16. a bound above the canonical gram ceiling is refused', () => {
    expect(val(ev(1, MAX_AI_ESTIMATE_BOUND_GRAMS + 1)).ok).toBe(false);
  });

  it('17. an inverted range is refused', () => {
    expect(val(ev(300, 100)).ok).toBe(false);
  });

  it('18. a representative outside the range is refused', () => {
    expect(val(ev(100, 200, 500)).ok).toBe(false);
  });

  it('22. a model midpoint that disagrees with the deterministic midpoint is refused', () => {
    const result = val(ev(150, 200, 200));
    expect(result.ok).toBe(false);
  });

  it('23. the deterministic midpoint is derived locally and used', () => {
    expect(deterministicMidpointGrams(150, 200)).toBe(175);
    const result = val(ev(150, 200, 175));
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.evidence.representative_grams).toBe(175);
      expect(result.evidence.representative_policy).toBe('midpoint');
    }
  });

  it('21. a non-midpoint policy carries no AI-3 v1 authority', () => {
    const result = val({
      line_ref: 'L1',
      policy_version: AI_ESTIMATE_POLICY_VERSION,
      provenance_class: 'ai_estimate',
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 200,
      representative_policy: 'upper_bound',
      input_semantics: ['count noun: none'],
      evidence_absent_reason: 'no_authenticated_portion',
    });
    expect(result.ok).toBe(false);
  });
});

describe('AI-3 — model authority can never be claimed', () => {
  it('27. an authenticated provenance claim is refused', () => {
    expect(isAuthenticatedProvenanceClass('ai_estimate')).toBe(false);
    expect(isAuthenticatedProvenanceClass('usda_derived')).toBe(true);
    expect(isAuthenticatedProvenanceClass('vetted_standard')).toBe(true);
  });

  it('24/25/26. nutrient, FDC and portion authority keys stay forbidden', () => {
    for (const key of ['nutrients', 'fdc_id', 'portion_id', 'calories', 'density']) {
      const result = validateAiBoundedEstimateProposal({
        line_ref: 'L1',
        policy_version: AI_ESTIMATE_POLICY_VERSION,
        provenance_class: 'ai_estimate',
        lower_grams: 100,
        upper_grams: 200,
        representative_grams: 150,
        representative_policy: 'midpoint',
        input_semantics: ['count noun'],
        evidence_absent_reason: 'no_authenticated_portion',
        [key]: 'forged',
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('AI-3 — additive effective-mass arm (ai_estimate is lowest, exclusive)', () => {
  const claims = (over: Partial<Parameters<typeof resolveEffectiveMassDecision>[0]> = {}) => ({
    directMassGrams: undefined,
    hasUserMass: false,
    hasSourcePortion: false,
    hasCountPortion: false,
    hasHouseholdPortion: false,
    hasAiEstimate: false,
    ...over,
  });

  it('44. existing outcomes are unchanged when no estimate exists', () => {
    expect(resolveEffectiveMassDecision(claims({ directMassGrams: 100 })).kind).toBe('direct_mass');
    expect(resolveEffectiveMassDecision(claims({ hasUserMass: true })).kind).toBe('user_mass');
    expect(resolveEffectiveMassDecision(claims({ hasSourcePortion: true })).kind).toBe('source_portion');
    expect(resolveEffectiveMassDecision(claims({ hasCountPortion: true })).kind).toBe('count_portion');
    expect(
      resolveEffectiveMassDecision(claims({ hasHouseholdPortion: true })).kind
    ).toBe('household_portion');
    expect(resolveEffectiveMassDecision(claims()).kind).toBe('none');
  });

  it('an estimate alone resolves as the ai_estimate arm', () => {
    expect(resolveEffectiveMassDecision(claims({ hasAiEstimate: true })).kind).toBe('ai_estimate');
  });

  it('41/57. an estimate plus ANY stronger source is a conflict, not a silent win', () => {
    const stronger = [
      { directMassGrams: 100 },
      { hasUserMass: true },
      { hasSourcePortion: true },
      { hasCountPortion: true },
      { hasHouseholdPortion: true },
    ];
    for (const source of stronger) {
      const result = resolveEffectiveMassDecision(claims({ ...source, hasAiEstimate: true } as never));
      expect(result.kind).toBe('conflict');
    }
  });
});

describe('AI-3 — wire owner and model-payload authority isolation', () => {
  const goodLine = {
    line_ref: 'L1',
    source_text: '2 tomatoes',
    amount: 2,
    unit: null,
    measurement_kind: 'count',
    count_noun: null,
    food_semantics: 'tomatoes',
    local_food_description: 'Tomatoes, red, ripe, raw',
    evidence_absent_reason: 'no_authenticated_portion',
  };

  it('the model-facing payload carries no forbidden local authority field', () => {
    const request = buildAiEstimateModelRequest([goodLine]);
    const text = JSON.stringify(request);
    for (const forbidden of ['fdc_id', 'record_digest', 'review_digest', 'catalog_digest', 'bundle', 'nutrient', 'calorie', 'recipe_key', 'session']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('61. the line cap is 12', () => {
    expect(MAX_AI_ESTIMATE_LINES).toBe(12);
    const many = Array.from({ length: 40 }, (_, i) => ({ ...goodLine, line_ref: `L${i}` }));
    expect(buildAiEstimateModelRequest(many).lines.length).toBe(MAX_AI_ESTIMATE_LINES);
  });

  it('the request version contract is a single fixed literal', () => {
    expect(AI_ESTIMATE_REQUEST_VERSION).toBe('nutrition_ai_estimate_request_v1');
  });

  it('62. the complete dynamic payload is measured against a 32 KiB cap', () => {
    const request = buildAiEstimateModelRequest([goodLine]);
    expect(aiEstimateRequestByteLength(request)).toBeLessThan(MAX_AI_ESTIMATE_REQUEST_BYTES);
    expect(MAX_AI_ESTIMATE_REQUEST_BYTES).toBe(32 * 1024);
  });

  it('an over-long authored field is bounded, never silently forwarded whole', () => {
    const request = buildAiEstimateModelRequest([{ ...goodLine, source_text: 'x'.repeat(5000) }]);
    expect(request.lines[0]?.source_text.length).toBeLessThanOrEqual(240);
  });
});

describe('AI-3 — snapshot binding is local and semantic', () => {
  const base = {
    lineRef: 'L1',
    sourceText: '2 tomatoes',
    amount: 2,
    unit: null,
    countNoun: null,
    fdcId: 111111,
    recordDigest: 'rd',
    reviewDigest: 'vd',
    bundleRelease: 'b1',
    catalogDigest: 'cd',
    recipeKey: 'r1',
    sessionIdentity: 's1',
  };

  it('is deterministic and local', () => {
    expect(aiEstimateSnapshotBinding(base)).toBe(aiEstimateSnapshotBinding(base));
  });

  it('a changed authored text, amount, identity or session invalidates it', () => {
    const binding = aiEstimateSnapshotBinding(base);
    expect(aiEstimateSnapshotBinding({ ...base, sourceText: '3 tomatoes' })).not.toBe(binding);
    expect(aiEstimateSnapshotBinding({ ...base, amount: 3 })).not.toBe(binding);
    expect(aiEstimateSnapshotBinding({ ...base, unit: 'cup' })).not.toBe(binding);
    expect(aiEstimateSnapshotBinding({ ...base, fdcId: 222222 })).not.toBe(binding);
    expect(aiEstimateSnapshotBinding({ ...base, catalogDigest: 'cd2' })).not.toBe(binding);
    expect(aiEstimateSnapshotBinding({ ...base, recordDigest: 'rd2' })).not.toBe(binding);
    expect(aiEstimateSnapshotBinding({ ...base, sessionIdentity: 's2' })).not.toBe(binding);
  });
});
