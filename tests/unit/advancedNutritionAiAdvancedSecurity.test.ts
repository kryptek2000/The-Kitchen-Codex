/**
 * The Kitchen Codex — AI Advanced Nutrition (AI-0) security / adversarial
 * suite.
 *
 * Every case is a MUTATION of a valid payload: the tests demonstrate that the
 * boundaries actually guard FDC identity, grams, nutrients, schema/Apply/
 * provenance authority, candidate refs, stale responses, mid-flight user
 * authority, and the AI-disabled path. Nothing here relies on live providers.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  AI_ADVANCED_CONTRACT_VERSION,
  reconcileAiAdvancedAmount,
  sanitizeAiAdvancedInterpretationResponse,
} from '../../src/core/nutritionV2/aiAdvanced';
import {
  buildAiAdvancedCandidateSet,
  type AiAdvancedLocalCandidate,
} from '../../src/core/nutritionV2/aiAdvancedCandidates';
import {
  AI_ADVANCED_PLAN_VERSION,
  sanitizeAiAdvancedPlanResponse,
} from '../../src/core/nutritionV2/aiAdvancedPlan';
import {
  BASIC_NUTRITION_CAPABILITIES,
  resolveNutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities';
import {
  conflictedWorkingLineRefs,
  mergeAiHouseholdPortions,
  stableChoiceKey,
  workingChoiceFingerprint,
} from '../../src/core/nutritionV2/phase4/aiMidFlight';
import {
  AI_RESOLUTION_INVALID_MESSAGE,
  AI_RESOLUTION_UNAVAILABLE_MESSAGE,
  resolveUnresolvedRowsWithAi,
} from '../../src/application/nutritionAiResolve';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { HouseholdPortionChoice, MatchChoice, Phase4State } from '../../src/core/nutritionV2/phase4';

// ---------------------------------------------------------------------------
// Shared valid payloads (each test mutates exactly one thing)
// ---------------------------------------------------------------------------

function validEnvelope(): Record<string, unknown> {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    interpretations: [
      {
        line_ref: 'line-1',
        semantic_food: {
          normalized_name: 'unsalted butter',
          modifiers: ['unsalted'],
          preparation: [],
          state: [],
          qualifiers: [],
        },
        search_phrases: ['unsalted butter'],
        amount_semantics: { kind: 'exact', echoed_value: 2 },
        unit_semantics: { raw: 'tbsp', family: 'volume', interpreted_unit: 'tablespoon' },
        count_semantics: {},
        alternatives: [],
        ambiguity: { ambiguous: false, reasons: [] },
      },
    ],
  };
}

const ALLOWED = { allowedLineRefs: ['line-1'] };

function validPlan(): Record<string, unknown> {
  return {
    plan_version: AI_ADVANCED_PLAN_VERSION,
    plans: [
      {
        line_ref: 'line-1',
        candidate_ref: 'c1',
        measure_kind: 'source_portion',
        portion_ref: 'p1',
        review_required: false,
        ambiguity_reasons: [],
      },
    ],
  };
}

const PLAN_ALLOWANCES = {
  allowedLineRefs: ['line-1'],
  allowedCandidateRefsByLine: { 'line-1': ['c1', 'c2'] },
  allowedPortionRefsByLine: { 'line-1': ['p1'] },
};

const AUTHORITY_KEYS = [
  'fdc_id',
  'grams',
  'gram_weight',
  'nutrients',
  'calories',
  'schema_version',
  'authorization',
  'apply',
  'user_confirmed',
  'provenance',
  'range_representative',
  'persist',
  'selection_digest',
  'resolved_grams',
] as const;

// ---------------------------------------------------------------------------
// Interpretation sanitizer
// ---------------------------------------------------------------------------

describe('AI-0 security — interpretation sanitizer', () => {
  it('baseline payload is accepted (the mutations below are the difference)', () => {
    expect(sanitizeAiAdvancedInterpretationResponse(validEnvelope(), ALLOWED).ok).toBe(true);
  });

  it('rejects unknown interpretation keys, including prototype pollution', () => {
    const envelope = validEnvelope();
    (envelope.interpretations as Record<string, unknown>[])[0].mystery = 'value';
    expect(sanitizeAiAdvancedInterpretationResponse(envelope, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const protoEnvelope = validEnvelope();
    (protoEnvelope.interpretations as Record<string, unknown>[])[0].__proto__ = { polluted: true };
    const protoResult = sanitizeAiAdvancedInterpretationResponse(protoEnvelope, ALLOWED);
    expect(protoResult.ok).toBe(false);

    const constructorEnvelope = validEnvelope();
    Object.defineProperty(
      (constructorEnvelope.interpretations as unknown[])[0] as object,
      'constructor',
      { value: 'x', enumerable: true, configurable: true }
    );
    // A reserved/dangerous key is refused by the inert materializer first; either
    // way the whole response fails closed.
    expect(sanitizeAiAdvancedInterpretationResponse(constructorEnvelope, ALLOWED)).toEqual({
      ok: false,
      code: 'unsafe_response',
    });
  });

  it('rejects a non-plain (class / getter / proxy) payload as unsafe', () => {
    class Evil {
      line_ref = 'line-1';
    }
    const classEnvelope = {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: [new Evil()],
    };
    expect(sanitizeAiAdvancedInterpretationResponse(classEnvelope, ALLOWED)).toEqual({
      ok: false,
      code: 'unsafe_response',
    });

    const getterPayload = {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      get interpretations() {
        return [];
      },
    };
    expect(sanitizeAiAdvancedInterpretationResponse(getterPayload, ALLOWED).ok).toBe(false);
  });

  for (const key of AUTHORITY_KEYS) {
    it(`rejects authority-shaped key injection: ${key}`, () => {
      const envelope = validEnvelope();
      (envelope.interpretations as Record<string, unknown>[])[0][key] = 123;
      expect(sanitizeAiAdvancedInterpretationResponse(envelope, ALLOWED)).toEqual({
        ok: false,
        code: 'authority_field',
      });
    });
  }

  it('rejects authority-shaped keys nested inside semantic sub-objects', () => {
    const envelope = validEnvelope();
    (
      (envelope.interpretations as Record<string, unknown>[])[0].semantic_food as Record<string, unknown>
    ).grams = 113;
    expect(sanitizeAiAdvancedInterpretationResponse(envelope, ALLOWED)).toEqual({
      ok: false,
      code: 'authority_field',
    });
  });

  it('rejects oversized strings, excessive tokens, alternatives, and rows', () => {
    const longName = validEnvelope();
    (longName.interpretations as Record<string, unknown>[])[0].semantic_food = {
      normalized_name: 'x'.repeat(121),
    };
    expect(sanitizeAiAdvancedInterpretationResponse(longName, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const manyTokens = validEnvelope();
    (manyTokens.interpretations as Record<string, unknown>[])[0].semantic_food = {
      modifiers: Array.from({ length: 13 }, (_, index) => `m${index}`),
    };
    expect(sanitizeAiAdvancedInterpretationResponse(manyTokens, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const manyAlternatives = validEnvelope();
    (manyAlternatives.interpretations as Record<string, unknown>[])[0].alternatives = Array.from(
      { length: 5 },
      (_, index) => ({ normalized_name: `alt ${index}` })
    );
    expect(sanitizeAiAdvancedInterpretationResponse(manyAlternatives, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const manyRows = {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      interpretations: Array.from({ length: 26 }, (_, index) => ({
        line_ref: `line-${index}`,
        semantic_food: { normalized_name: 'onion' },
      })),
    };
    expect(
      sanitizeAiAdvancedInterpretationResponse(manyRows, {
        allowedLineRefs: manyRows.interpretations.map((entry) => entry.line_ref),
      })
    ).toEqual({ ok: false, code: 'invalid_response' });
  });

  it('rejects unknown and duplicate line refs', () => {
    const unknown = validEnvelope();
    (unknown.interpretations as Record<string, unknown>[])[0].line_ref = 'not-supplied';
    expect(sanitizeAiAdvancedInterpretationResponse(unknown, ALLOWED)).toEqual({
      ok: false,
      code: 'unknown_line_ref',
    });

    const duplicate = validEnvelope();
    (duplicate.interpretations as Record<string, unknown>[])[1] = {
      ...(duplicate.interpretations as Record<string, unknown>[])[0],
    };
    expect(sanitizeAiAdvancedInterpretationResponse(duplicate, ALLOWED)).toEqual({
      ok: false,
      code: 'duplicate_line_ref',
    });
  });

  it('rejects internally inconsistent amount semantics', () => {
    const rangeWithoutEndpoints = validEnvelope();
    (rangeWithoutEndpoints.interpretations as Record<string, unknown>[])[0].amount_semantics = {
      kind: 'range',
    };
    expect(sanitizeAiAdvancedInterpretationResponse(rangeWithoutEndpoints, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const endpointsOnExact = validEnvelope();
    (endpointsOnExact.interpretations as Record<string, unknown>[])[0].amount_semantics = {
      kind: 'exact',
      range_lower: 1,
      range_upper: 2,
    };
    expect(sanitizeAiAdvancedInterpretationResponse(endpointsOnExact, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const invertedRange = validEnvelope();
    (invertedRange.interpretations as Record<string, unknown>[])[0].amount_semantics = {
      kind: 'range',
      range_lower: 5,
      range_upper: 2,
    };
    expect(sanitizeAiAdvancedInterpretationResponse(invertedRange, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });
  });

  it('rejects malicious provider metadata on the interpretation', () => {
    const envelope = validEnvelope();
    (envelope.interpretations as Record<string, unknown>[])[0].provider = {
      provider_id: 'evil',
      model_id: 'x',
    };
    expect(sanitizeAiAdvancedInterpretationResponse(envelope, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const wrongShape = validEnvelope();
    (wrongShape.interpretations as Record<string, unknown>[])[0].unit_semantics = {
      family: 'volume',
      raw: { nested: { deeply: true } },
    };
    expect(sanitizeAiAdvancedInterpretationResponse(wrongShape, ALLOWED)).toEqual({
      ok: false,
      code: 'invalid_response',
    });
  });

  it('rejects an unsupported per-entry contract version', () => {
    const envelope = validEnvelope();
    (envelope.interpretations as Record<string, unknown>[])[0].contract_version =
      'nutrition_ai_advanced_interpretation_v99';
    expect(sanitizeAiAdvancedInterpretationResponse(envelope, ALLOWED)).toEqual({
      ok: false,
      code: 'unsupported_contract_version',
    });
  });
});

// ---------------------------------------------------------------------------
// Plan sanitizer
// ---------------------------------------------------------------------------

describe('AI-0 security — resolution plan sanitizer', () => {
  it('baseline plan is accepted', () => {
    expect(sanitizeAiAdvancedPlanResponse(validPlan(), PLAN_ALLOWANCES).ok).toBe(true);
  });

  for (const key of AUTHORITY_KEYS) {
    it(`rejects plan authority injection: ${key}`, () => {
      const plan = validPlan();
      (plan.plans as Record<string, unknown>[])[0][key] = 99;
      expect(sanitizeAiAdvancedPlanResponse(plan, PLAN_ALLOWANCES)).toEqual({
        ok: false,
        code: 'authority_field',
      });
    });
  }

  it('rejects unknown plan keys and unknown envelope keys', () => {
    const unknownPlanKey = validPlan();
    (unknownPlanKey.plans as Record<string, unknown>[])[0].mystery = true;
    expect(sanitizeAiAdvancedPlanResponse(unknownPlanKey, PLAN_ALLOWANCES)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const unknownEnvelopeKey = validPlan();
    unknownEnvelopeKey.extra = true;
    expect(sanitizeAiAdvancedPlanResponse(unknownEnvelopeKey, PLAN_ALLOWANCES)).toEqual({
      ok: false,
      code: 'invalid_response',
    });
  });

  it('rejects unsupported plan versions and prototype-shaped plans', () => {
    const wrongVersion = validPlan();
    wrongVersion.plan_version = 'nutrition_ai_advanced_plan_v0';
    expect(sanitizeAiAdvancedPlanResponse(wrongVersion, PLAN_ALLOWANCES)).toEqual({
      ok: false,
      code: 'unsupported_plan_version',
    });

    const proto = validPlan();
    (proto.plans as Record<string, unknown>[])[0].__proto__ = { polluted: true };
    expect(sanitizeAiAdvancedPlanResponse(proto, PLAN_ALLOWANCES).ok).toBe(false);
  });

  it('rejects candidate/portion refs that were never supplied', () => {
    const unknownCandidate = validPlan();
    (unknownCandidate.plans as Record<string, unknown>[])[0].candidate_ref = 'c9';
    expect(sanitizeAiAdvancedPlanResponse(unknownCandidate, PLAN_ALLOWANCES)).toEqual({
      ok: false,
      code: 'unknown_candidate_ref',
    });

    const unknownPortion = validPlan();
    (unknownPortion.plans as Record<string, unknown>[])[0].portion_ref = 'p9';
    expect(sanitizeAiAdvancedPlanResponse(unknownPortion, PLAN_ALLOWANCES)).toEqual({
      ok: false,
      code: 'unknown_portion_ref',
    });

    // Supplying a ref when no candidate set exists at all also fails closed.
    const noSet = validPlan();
    expect(
      sanitizeAiAdvancedPlanResponse(noSet, { allowedLineRefs: ['line-1'] })
    ).toEqual({ ok: false, code: 'unknown_candidate_ref' });
  });

  it('rejects oversized plans and excessive ambiguity reasons', () => {
    const manyPlans = validPlan();
    manyPlans.plans = Array.from({ length: 26 }, () => ({
      line_ref: 'line-1',
      measure_kind: 'unknown',
      review_required: true,
    }));
    expect(sanitizeAiAdvancedPlanResponse(manyPlans, PLAN_ALLOWANCES)).toEqual({
      ok: false,
      code: 'invalid_response',
    });

    const manyReasons = validPlan();
    (manyReasons.plans as Record<string, unknown>[])[0].ambiguity_reasons = Array.from(
      { length: 7 },
      (_, index) => `reason ${index}`
    );
    expect(sanitizeAiAdvancedPlanResponse(manyReasons, PLAN_ALLOWANCES)).toEqual({
      ok: false,
      code: 'invalid_response',
    });
  });
});

// ---------------------------------------------------------------------------
// Candidate-bound orchestration
// ---------------------------------------------------------------------------

describe('AI-0 security — candidate binding', () => {
  const CANDIDATES: ReadonlyArray<AiAdvancedLocalCandidate> = [
    { fdc_id: 111, description: 'Alpha' },
    { fdc_id: 222, description: 'Beta' },
  ];

  it('rejects duplicate local candidates at request construction', () => {
    expect(
      buildAiAdvancedCandidateSet({
        lineRef: 'x',
        candidates: [
          { fdc_id: 111, description: 'Alpha' },
          { fdc_id: 111, description: 'Alpha duplicate' },
        ],
      })
    ).toEqual({ ok: false, code: 'duplicate_candidate' });
  });

  it('never exposes FDC ids or digests to the provider view', () => {
    const built = buildAiAdvancedCandidateSet({
      lineRef: 'x',
      candidates: CANDIDATES.map((candidate, index) => ({
        ...candidate,
        record_digest: `sha256:${String(index).repeat(64)}`,
      })),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const text = JSON.stringify(built.set.views);
    expect(text).not.toContain('111');
    expect(text).not.toContain('sha256');
  });
});

// ---------------------------------------------------------------------------
// Source contradiction
// ---------------------------------------------------------------------------

describe('AI-0 security — source amount contradiction', () => {
  it('a scalar echo that contradicts the authored exact amount is refused', () => {
    const envelope = validEnvelope();
    (envelope.interpretations as Record<string, unknown>[])[0].amount_semantics = {
      kind: 'exact',
      echoed_value: 12,
    };
    const sanitized = sanitizeAiAdvancedInterpretationResponse(envelope, ALLOWED);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    // Deterministic reconciliation is what refuses it.
    expect(
      reconcileAiAdvancedAmount(sanitized.interpretations[0].amount_semantics, {
        quantity_kind: 'exact',
        amount: 2,
        measurement_kind: 'volume',
      })
    ).toEqual({ ok: false, code: 'amount_contradicts_source' });
  });
});

// ---------------------------------------------------------------------------
// Stale response + mid-flight user authority
// ---------------------------------------------------------------------------

function emptyState(): Phase4State {
  return {
    version: 'phase4',
    status: 'ready',
    recipeKey: 'recipe',
    sessionIdentity: 'session',
    baseServings: 1,
    rows: [],
    matches: {},
    portions: {},
    countPortions: {},
    userMasses: {},
    householdPortions: {},
    basis: 'per_serving',
    selectedServings: 1,
    preview: null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
}

const MATCH: MatchChoice = {
  kind: 'manual',
  fdc_id: 111,
  review_digest: 'r',
  record_digest: 'd',
  catalog_digest: 'c',
  description: 'Alpha',
};

const HOUSEHOLD = {
  kind: 'household',
  record_key: 'alpha|item|medium|null',
  record_digest: 'x'.repeat(64),
  authority_class: 'usda_derived',
  resolved_grams: 100,
  user_confirmed: true,
} as unknown as HouseholdPortionChoice;

describe('AI-0 security — stale response and mid-flight authority', () => {
  it('a mid-flight manual mass correction invalidates the stale AI result', () => {
    const start = emptyState();
    const captured = new Map([['line-1', workingChoiceFingerprint(start, 'line-1')]]);

    const corrected: Phase4State = {
      ...start,
      userMasses: {
        'line-1': {
          kind: 'user_mass',
          grams: 500,
          entered_text: '500 g',
        } as never,
      },
    };
    expect(workingChoiceFingerprint(corrected, 'line-1')).not.toBe(captured.get('line-1'));
    expect([...conflictedWorkingLineRefs(corrected, captured)]).toEqual(['line-1']);
  });

  it('a mid-flight Clear cannot be resurrected by an AI household merge', () => {
    const started: Phase4State = {
      ...emptyState(),
      householdPortions: { 'line-1': HOUSEHOLD },
    };
    const captured = new Map([['line-1', workingChoiceFingerprint(started, 'line-1')]]);

    // User clears the household choice while the request is in flight.
    const cleared: Phase4State = { ...started, householdPortions: {} };
    const conflicted = conflictedWorkingLineRefs(cleared, captured);
    expect([...conflicted]).toEqual(['line-1']);

    const merged = mergeAiHouseholdPortions({
      base: cleared,
      countPortions: {},
      resolved: [{ line_ref: 'line-1', choice: HOUSEHOLD }],
      conflicted,
    });
    expect(merged['line-1']).toBeUndefined();
  });

  it('an AI household merge refuses to overwrite a higher-authority mass source', () => {
    const base: Phase4State = {
      ...emptyState(),
      userMasses: {
        'line-1': { kind: 'user_mass', grams: 500, entered_text: '500 g' } as never,
      },
    };
    const merged = mergeAiHouseholdPortions({
      base,
      countPortions: {},
      resolved: [{ line_ref: 'line-1', choice: HOUSEHOLD }],
      conflicted: new Set(),
    });
    expect(merged['line-1']).toBeUndefined();
  });

  it('stableChoiceKey is order-independent but sensitive to real edits', () => {
    expect(stableChoiceKey({ a: 1, b: 2 })).toBe(stableChoiceKey({ b: 2, a: 1 }));
    expect(stableChoiceKey({ a: 1 })).not.toBe(stableChoiceKey({ a: 2 }));
  });
});

// ---------------------------------------------------------------------------
// AI disabled (capability gate + no network)
// ---------------------------------------------------------------------------

describe('AI-0 security — AI disabled', () => {
  it('with Basic capabilities the application performs no network call at all', async () => {
    const post = vi.fn();
    const network = { post } as unknown as NetworkAdapter;
    const result = await resolveUnresolvedRowsWithAi({
      network,
      session: {} as never,
      rows: [
        {
          line_ref: 'line-1',
          original_text: '1 onion',
          query: 'onion',
          outcome: 'unmatched',
        } as never,
      ],
      adapted: [],
      capabilities: BASIC_NUTRITION_CAPABILITIES,
    });
    expect(post).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.aiAttempted).toBe(false);
    expect(result.message).toBe(AI_RESOLUTION_UNAVAILABLE_MESSAGE);
    expect(result.outcome.candidates).toEqual([]);
    expect(result.amounts.resolved).toEqual([]);
    expect(result.households.resolved).toEqual([]);
  });

  it('an unconfigured/unreachable provider resolves to Basic capabilities', () => {
    expect(resolveNutritionCapabilities({ aiConfigured: true, aiReachable: false }).tier).toBe('basic');
    expect(resolveNutritionCapabilities({}).tier).toBe('basic');
  });

  it('re-sanitizes externally supplied canonical interpretations at the application seam', async () => {
    const post = vi.fn();
    const forbidden = {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      line_ref: 'line-1',
      semantic_food: { normalized_name: 'onion' },
      search_phrases: ['onion'],
      amount_semantics: { kind: 'exact', echoed_value: 1 },
      unit_semantics: { family: 'household' },
      count_semantics: {},
      alternatives: [],
      ambiguity: { ambiguous: false, reasons: [] },
      // Authority-shaped injection smuggled through the canonical path.
      grams: 100,
    };
    const result = await resolveUnresolvedRowsWithAi({
      network: { post } as unknown as NetworkAdapter,
      session: {} as never,
      rows: [
        {
          line_ref: 'line-1',
          original_text: '1 onion',
          query: 'onion',
          outcome: 'unmatched',
        } as never,
      ],
      adapted: [],
      capabilities: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
      interpretations: [forbidden as never],
    });
    expect(post).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.aiAttempted).toBe(false);
    expect(result.message).toBe(AI_RESOLUTION_INVALID_MESSAGE);
  });

  // FINDING B (final AI-0 audit repair): application-seam re-sanitization at a
  // MEANINGFUL nesting depth, not just a top-level key. Each payload is a
  // canonical-looking interpretation whose forbidden authority value is buried
  // inside a permitted sub-object, so only a genuine deep rejection (rather than
  // a shallow key-set check) can catch it.
  function nestedAuthorityInterpretation(which: number): Record<string, unknown> {
    const base: Record<string, unknown> = {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      line_ref: 'line-1',
      semantic_food: { normalized_name: 'onion' },
      search_phrases: ['onion'],
      amount_semantics: { kind: 'exact', echoed_value: 1 },
      unit_semantics: { family: 'household' },
      count_semantics: {},
      alternatives: [],
      ambiguity: { ambiguous: false, reasons: [] },
    };
    if (which === 0) base.semantic_food = { normalized_name: 'onion', grams: 110 };
    if (which === 1) base.alternatives = [{ normalized_name: 'olive oil', fdc_id: 171413 }];
    if (which === 2) base.count_semantics = { noun: 'clove', provenance: { persisted_provenance: 'usda' } };
    if (which === 3) base.unit_semantics = { family: 'count', authorization: { apply_token: 'x' } };
    if (which === 4) base.alternatives = [{ normalized_name: 'butter', notes: { grams: 14, fdc_id: 1 } }];
    return base;
  }

  it('rejects WHOLE canonical input with authority values nested at depth (no partial trust)', async () => {
    for (let which = 0; which < 5; which += 1) {
      const post = vi.fn();
      const result = await resolveUnresolvedRowsWithAi({
        network: { post } as unknown as NetworkAdapter,
        session: {} as never,
        rows: [
          {
            line_ref: 'line-1',
            original_text: '1 onion',
            query: 'onion',
            outcome: 'unmatched',
          } as never,
        ],
        adapted: [],
        capabilities: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
        interpretations: [nestedAuthorityInterpretation(which) as never],
      });

      // 1. No network / secondary provider call is triggered merely by rejection.
      expect(post).not.toHaveBeenCalled();
      // 2. The WHOLE input is rejected (never stripped-and-continued).
      expect(result.ok).toBe(false);
      expect(result.aiAttempted).toBe(false);
      expect(result.message).toBe(AI_RESOLUTION_INVALID_MESSAGE);
      expect(result.interpretedCount).toBe(0);
      // 3. No deterministic resolution was applied from the rejected input.
      expect(result.outcome.candidates).toEqual([]);
      expect(result.outcome.unresolved).toEqual([]);
      expect(result.outcome.auto_count).toBe(0);
      expect(result.amounts.resolved).toEqual([]);
      expect(result.amounts.offers).toEqual([]);
      expect(result.amounts.auto_count).toBe(0);
      expect(result.households.resolved).toEqual([]);
      expect(result.households.unresolved).toEqual([]);
      expect(result.households.auto_count).toBe(0);
      // 4. No state / persistence / Apply authority is produced.
      expect(Object.keys(result)).not.toContain('applied');
      expect(Object.keys(result)).not.toContain('authorization');
      expect(Object.keys(result)).not.toContain('persisted');
      expect(JSON.stringify(result)).not.toContain('171413');
      expect(JSON.stringify(result)).not.toContain('apply_token');
    }
  });

  it('rejects a nested authority payload with provenance and authorization variants', async () => {
    const injected = [
      { persisted_provenance: 'usda_derived' },
      { range_provenance: 'written_range' },
      { authorization: 'apply' },
      { apply_token: 'token' },
      { user_confirmed: true },
      { serving_override: 4 },
      { nutrient_amounts: { calories: 1 } },
      { source_portion_grams: 14 },
      { portion_index: 0 },
      { schema_version: 3 },
      { selection_digest: 'abc' },
    ];
    for (const smuggled of injected) {
      const post = vi.fn();
      const interpretation = nestedAuthorityInterpretation(0) as Record<string, unknown>;
      interpretation.semantic_food = { normalized_name: 'onion', ...smuggled };
      const result = await resolveUnresolvedRowsWithAi({
        network: { post } as unknown as NetworkAdapter,
        session: {} as never,
        rows: [{ line_ref: 'line-1', original_text: '1 onion', query: 'onion', outcome: 'unmatched' } as never],
        adapted: [],
        capabilities: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
        interpretations: [interpretation as never],
      });
      expect(post).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.message).toBe(AI_RESOLUTION_INVALID_MESSAGE);
      expect(result.outcome.candidates).toEqual([]);
    }
  });
});
