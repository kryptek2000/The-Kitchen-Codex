/**
 * The Kitchen Codex — AI Advanced Nutrition (AI-0) architecture + contract.
 *
 * Proves the canonical interpretation contract, the resolution-plan contract,
 * candidate-bound orchestration, provider neutrality, the capability boundary,
 * the future bounded-estimate skeleton, separate benchmark accounting, and the
 * smoke-corpus semantics — with the permanent invariant that AI never authors
 * nutrition authority.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AI_ADVANCED_AMOUNT_KINDS,
  AI_ADVANCED_CONFIDENCE_VALUES,
  AI_ADVANCED_CONTRACT_VERSION,
  AI_ADVANCED_UNIT_FAMILIES,
  adaptAiAdvancedInterpretationsForResolution,
  aiAdvancedInterpretationFromResolutionSuggestion,
  buildAiAdvancedInterpretationRequest,
  buildAiAdvancedInterpretationSchema,
  reconcileAiAdvancedAmount,
  sanitizeAiAdvancedInterpretationResponse,
  type AiAdvancedAuthoritativeAmountObservation,
  type AiAdvancedIngredientInterpretation,
  type AiAdvancedInterpretationPort,
} from '../../src/core/nutritionV2/aiAdvanced';
import {
  MAX_AI_ADVANCED_CANDIDATES,
  MAX_AI_ADVANCED_PORTION_OPTIONS,
  buildAiAdvancedCandidateSet,
  buildAiAdvancedPortionSet,
} from '../../src/core/nutritionV2/aiAdvancedCandidates';
import {
  AI_ADVANCED_PLAN_VERSION,
  MAX_AI_ADVANCED_PLANS,
  buildAiAdvancedPlanSchema,
  resolvePlanCandidate,
  sanitizeAiAdvancedPlanResponse,
} from '../../src/core/nutritionV2/aiAdvancedPlan';
import {
  BASIC_NUTRITION_CAPABILITIES,
  isAiInterpretationAvailable,
  isManualEditingAvailable,
  resolveNutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities';
import {
  AI_ESTIMATE_PROVENANCE_CLASS,
  AI_ESTIMATION_AVAILABILITY,
  isAiEstimateProvenanceClass,
  isAiEstimationEnabled,
  isAuthenticatedProvenanceClass,
  resolveAiBoundedEstimate,
  validateAiBoundedEstimateProposal,
} from '../../src/core/nutritionV2/aiAdvancedEstimate';
import {
  classifyAiAdvancedBenchmarkOutcome,
  summarizeAiAdvancedBenchmark,
} from '../../src/core/nutritionV2/aiAdvancedBenchmark';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { AI_ADVANCED_SMOKE_CORPUS } from '../fixtures/aiAdvancedSmokeCorpus';
import type { AiResolutionSuggestion } from '../../src/core/nutritionV2/aiResolution';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function observationFor(line: string): AiAdvancedAuthoritativeAmountObservation {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { quantity_kind: 'invalid', amount: null, measurement_kind: 'unknown' };
  const p = parsed.parsed as {
    quantity_kind: string;
    amount: number | null;
    measurement_kind: string;
    quantity_range?: { lower: number; upper: number };
    range_representative?: { lower: number; upper: number; amount_source: string };
    grams?: number;
  };
  return {
    quantity_kind: p.quantity_kind,
    amount: p.amount,
    measurement_kind: p.measurement_kind,
    ...(p.quantity_range !== undefined
      ? { quantity_range: { lower: p.quantity_range.lower, upper: p.quantity_range.upper } }
      : {}),
    ...(p.range_representative !== undefined
      ? { mass_range: { lower: p.range_representative.lower, upper: p.range_representative.upper } }
      : {}),
    ...(typeof p.grams === 'number' ? { representative_grams: p.grams } : {}),
  };
}

function interpretationForCase(entry: (typeof AI_ADVANCED_SMOKE_CORPUS)[number]): AiAdvancedIngredientInterpretation {
  const parsed = parseIngredient(entry.line);
  const parsedAmount = parsed.ok ? (parsed.parsed as { amount: number | null }).amount : null;
  const rawUnit = parsed.ok ? (parsed.parsed as { raw_unit?: string }).raw_unit : undefined;
  const e = entry.expectation;
  const amountSemantics =
    e.amount_kind === 'range'
      ? {
          kind: 'range' as const,
          ...(e.range_endpoints !== undefined
            ? { range_lower: e.range_endpoints.lower, range_upper: e.range_endpoints.upper }
            : {}),
        }
      : e.amount_kind === 'exact' && parsedAmount !== null
        ? { kind: 'exact' as const, echoed_value: parsedAmount }
        : { kind: e.amount_kind };
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: entry.family,
    semantic_food: {
      normalized_name: entry.semantic_food,
      modifiers: [],
      preparation: [],
      state: e.state !== undefined ? [e.state] : [],
      qualifiers: [],
    },
    search_phrases: [entry.semantic_food],
    amount_semantics: amountSemantics,
    unit_semantics: {
      family: e.unit_family,
      ...(rawUnit !== undefined ? { raw: rawUnit } : {}),
      ...(e.count_noun !== undefined && (e.unit_family === 'count' || e.unit_family === 'household')
        ? { interpreted_unit: e.count_noun }
        : {}),
    },
    count_semantics: {
      ...(e.count_noun !== undefined ? { noun: e.count_noun } : {}),
      ...(e.size !== undefined ? { size: e.size } : {}),
      ...(e.state !== undefined ? { state: e.state } : {}),
    },
    alternatives:
      e.alternative_count !== undefined
        ? Array.from({ length: e.alternative_count }, (_, index) =>
            Object.freeze({
              normalized_name: index === 0 ? entry.semantic_food : `${entry.semantic_food} alternative`,
            })
          )
        : [],
    ambiguity: {
      ambiguous: e.ambiguous === true,
      reasons: e.ambiguous === true ? ['authored alternatives'] : [],
    },
  };
}

const CORE_DIR = fileURLToPath(new URL('../../src/core/nutritionV2', import.meta.url));

// ---------------------------------------------------------------------------
// Canonical contract
// ---------------------------------------------------------------------------

describe('AI-0 canonical interpretation contract', () => {
  const VALID = {
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
        confidence: 'medium' as const,
        notes: 'interpreted as volume',
      },
    ],
  };

  it('accepts a well-formed interpretation and freezes the result', () => {
    const result = sanitizeAiAdvancedInterpretationResponse(VALID, { allowedLineRefs: ['line-1'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.interpretations).toHaveLength(1);
    const interpretation = result.interpretations[0];
    expect(interpretation.contract_version).toBe(AI_ADVANCED_CONTRACT_VERSION);
    expect(interpretation.line_ref).toBe('line-1');
    expect(interpretation.semantic_food.normalized_name).toBe('unsalted butter');
    expect(interpretation.amount_semantics).toEqual({ kind: 'exact', echoed_value: 2 });
    expect(Object.isFrozen(interpretation)).toBe(true);
    expect(Object.isFrozen(result.interpretations)).toBe(true);
  });

  it('rejects an unknown envelope key and an unsupported contract version', () => {
    expect(
      sanitizeAiAdvancedInterpretationResponse({ ...VALID, extra: true }, { allowedLineRefs: ['line-1'] })
    ).toEqual({ ok: false, code: 'invalid_response' });
    expect(
      sanitizeAiAdvancedInterpretationResponse(
        { ...VALID, contract_version: 'nutrition_ai_advanced_interpretation_v0' },
        { allowedLineRefs: ['line-1'] }
      )
    ).toEqual({ ok: false, code: 'unsupported_contract_version' });
  });

  it('never declares an authority field in the provider schema', () => {
    const schemaText = JSON.stringify(buildAiAdvancedInterpretationSchema());
    for (const forbidden of ['fdc_id', 'grams', 'gram_weight', 'nutrients', 'calories', 'digest', 'apply']) {
      expect(schemaText).not.toContain(forbidden);
    }
  });

  it('closes the amount/unit/confidence vocabularies', () => {
    expect([...AI_ADVANCED_AMOUNT_KINDS]).toEqual([
      'exact',
      'range',
      'approximate',
      'qualitative',
      'alternative',
      'unknown',
    ]);
    expect([...AI_ADVANCED_UNIT_FAMILIES]).toEqual(['mass', 'volume', 'count', 'household', 'unknown']);
    expect([...AI_ADVANCED_CONFIDENCE_VALUES]).toEqual(['high', 'medium', 'low']);
  });
});

// ---------------------------------------------------------------------------
// Provider-neutral port + bounded request
// ---------------------------------------------------------------------------

describe('AI-0 provider-neutral interpretation port', () => {
  it('passes raw provider output through the closed sanitizer only', async () => {
    const port: AiAdvancedInterpretationPort = {
      id: 'test-double',
      async interpret() {
        return {
          contract_version: AI_ADVANCED_CONTRACT_VERSION,
          interpretations: [{ line_ref: 'line-1', semantic_food: { normalized_name: 'onion' } }],
        };
      },
    };
    const request = buildAiAdvancedInterpretationRequest([
      { line_ref: 'line-1', ingredient_text: '1 onion', issue_kind: 'needs_match' },
    ]);
    expect(request.contract_version).toBe(AI_ADVANCED_CONTRACT_VERSION);
    const sanitized = sanitizeAiAdvancedInterpretationResponse(await port.interpret(request), {
      allowedLineRefs: request.rows.map((row) => row.line_ref),
    });
    expect(sanitized.ok).toBe(true);
  });

  it('bounds request rows and carries no vault content or credentials', () => {
    const request = buildAiAdvancedInterpretationRequest(
      Array.from({ length: 40 }, (_, index) => ({
        line_ref: `line-${index}`,
        ingredient_text: `ingredient ${index}`,
      }))
    );
    expect(request.rows.length).toBeLessThanOrEqual(25);
    const text = JSON.stringify(request);
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).not.toMatch(/vault/i);
  });
});

// ---------------------------------------------------------------------------
// Smoke corpus
// ---------------------------------------------------------------------------

describe('AI-0 smoke corpus semantics and safety', () => {
  it('covers every required hard-case family', () => {
    const families = new Set(AI_ADVANCED_SMOKE_CORPUS.map((entry) => entry.family));
    for (const required of [
      'unsalted_butter_sticks',
      'heavy_cream_volume',
      'chuck_roast_written_range',
      'provolone_parenthetical_total_mass_range',
      'onion',
      'garlic_cloves',
      'shallots',
      'oysters',
      'mortadella_slices',
      'pickles',
      'crushed_red_pepper_flakes',
      'cloves_ambiguity',
      'pinch',
      'handful',
      'fresh_herb_wording',
      'apple_cider_vinegar',
      'alternatives',
    ]) {
      expect(families.has(required), `missing smoke family ${required}`).toBe(true);
    }
  });

  for (const entry of AI_ADVANCED_SMOKE_CORPUS) {
    it(`pins ${entry.family}: ${entry.line}`, () => {
      const parsed = parseIngredient(entry.line);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const p = parsed.parsed as { quantity_kind: string; measurement_kind: string };
      if (entry.expectation.parsed_quantity_kind !== undefined) {
        expect(p.quantity_kind).toBe(entry.expectation.parsed_quantity_kind);
      }
      if (entry.expectation.parsed_measurement_kind !== undefined) {
        expect(p.measurement_kind).toBe(entry.expectation.parsed_measurement_kind);
      }

      const interpretation = interpretationForCase(entry);
      const sanitized = sanitizeAiAdvancedInterpretationResponse(
        { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: [interpretation] },
        { allowedLineRefs: [entry.family] }
      );
      expect(sanitized.ok, `sanitizer rejected ${entry.family}`).toBe(true);
      if (!sanitized.ok) return;

      // The uniform, permanent safety invariant: AI never authors mass.
      expect(entry.expectation.ai_must_not_author_mass).toBe(true);

      const authoritative = observationFor(entry.line);
      const reconciled = reconcileAiAdvancedAmount(interpretation.amount_semantics, authoritative);
      expect(reconciled.ok, `${entry.family} reconciliation failed`).toBe(true);

      const adapted = adaptAiAdvancedInterpretationsForResolution({
        interpretations: sanitized.interpretations,
        authoritativeByLineRef: new Map([[entry.family, authoritative]]),
      });
      expect(adapted.contradicted).toEqual([]);
      expect(adapted.suggestions).toHaveLength(1);
      const suggestion = adapted.suggestions[0];
      const serialized = JSON.stringify(suggestion);
      expect(serialized).not.toMatch(/fdc_id|gram_weight|"grams"|nutrients|digest|apply/i);
      if (entry.expectation.amount_kind === 'exact' && typeof authoritative.amount === 'number') {
        expect(suggestion.quantity_value).toBe(authoritative.amount);
      }
      if (entry.expectation.amount_kind === 'qualitative') {
        expect(suggestion.quantity_value).toBeUndefined();
      }
      // Alternatives are never collapsed into a fabricated single identity.
      if (entry.expectation.alternative_count !== undefined) {
        expect(sanitized.interpretations[0].alternatives).toHaveLength(
          entry.expectation.alternative_count
        );
        for (const alternative of sanitized.interpretations[0].alternatives) {
          expect(suggestion.suggested_usda_queries).not.toContain(alternative.normalized_name);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Reconciliation against the authored source
// ---------------------------------------------------------------------------

describe('AI-0 authored-amount reconciliation', () => {
  it('an exact authored scalar may never become a range', () => {
    const result = reconcileAiAdvancedAmount(
      { kind: 'range', range_lower: 3, range_upper: 4 },
      { quantity_kind: 'exact', amount: 3.5, measurement_kind: 'mass' }
    );
    expect(result).toEqual({ ok: false, code: 'exact_source_claimed_as_range' });
  });

  it('an authored range may never be collapsed into the AI scalar', () => {
    const result = reconcileAiAdvancedAmount(
      { kind: 'exact', echoed_value: 3 },
      {
        quantity_kind: 'range',
        amount: null,
        measurement_kind: 'mass',
        mass_range: { lower: 3, upper: 4 },
        representative_grams: 1587.5732950000001,
      }
    );
    expect(result).toEqual({ ok: false, code: 'range_source_collapsed_to_scalar' });
  });

  it('admits an echo of the deterministic representative but not the AI scalar', () => {
    const midpoint = 87.5;
    const admitted = reconcileAiAdvancedAmount(
      { kind: 'approximate', echoed_value: 87.5 },
      {
        quantity_kind: 'range',
        amount: null,
        measurement_kind: 'mass',
        mass_range: { lower: 75, upper: 100 },
        representative_grams: midpoint,
      }
    );
    expect(admitted).toEqual({ ok: true, echoed_value: midpoint });
    const refused = reconcileAiAdvancedAmount(
      { kind: 'exact', echoed_value: 80 },
      {
        quantity_kind: 'range',
        amount: null,
        measurement_kind: 'mass',
        mass_range: { lower: 75, upper: 100 },
        representative_grams: midpoint,
      }
    );
    expect(refused).toEqual({ ok: false, code: 'range_source_collapsed_to_scalar' });
  });

  it('refuses an invented scalar on a quantity-less line', () => {
    const result = reconcileAiAdvancedAmount(
      { kind: 'exact', echoed_value: 5 },
      { quantity_kind: 'absent', amount: null, measurement_kind: 'unknown' }
    );
    expect(result).toEqual({ ok: false, code: 'unconfirmed_quantity' });
  });

  it('drops a contradicted interpretation from adaptation', () => {
    const adapted = adaptAiAdvancedInterpretationsForResolution({
      interpretations: [
        {
          contract_version: AI_ADVANCED_CONTRACT_VERSION,
          line_ref: 'roast',
          semantic_food: {
            normalized_name: 'beef chuck roast',
            modifiers: [],
            preparation: [],
            state: [],
            qualifiers: [],
          },
          search_phrases: ['beef chuck roast'],
          amount_semantics: { kind: 'exact', echoed_value: 3.5 },
          unit_semantics: { family: 'mass' },
          count_semantics: {},
          alternatives: [],
          ambiguity: { ambiguous: false, reasons: [] },
        },
      ],
      authoritativeByLineRef: new Map([
        [
          'roast',
          {
            quantity_kind: 'range',
            amount: null,
            measurement_kind: 'mass',
            mass_range: { lower: 3, upper: 4 },
          },
        ],
      ]),
    });
    expect(adapted.contradicted).toEqual(['roast']);
    expect(adapted.suggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Candidate-bound orchestration + plan contract
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FINDING A (final AI-0 audit repair): DIRECT candidate-ref contract
//
// `sanitizeAiAdvancedPlanResponse` rejects an unknown ref BEFORE this mapping
// is ever reached, so an unknown ref is not a demonstrated production
// vulnerability. This block pins the low-level `resolve()` contract directly so
// the security-sensitive primitive cannot silently start resolving refs it was
// never handed (fallback, prefix matching, cross-request bleed).
// ---------------------------------------------------------------------------

describe('AI-0 direct candidate-ref contract (resolve/refFor)', () => {
  const SET_A = [
    { fdc_id: 1001, description: 'Butter, unsalted', semantic_tags: ['fat'] },
    { fdc_id: 1002, description: 'Butter, salted', semantic_tags: ['fat'] },
  ];

  /** A DIFFERENT request's candidate set (different foods, overlapping refs). */
  const SET_B = [
    { fdc_id: 2001, description: 'Olive oil', semantic_tags: ['fat'] },
    { fdc_id: 2002, description: 'Canola oil', semantic_tags: ['fat'] },
    { fdc_id: 2003, description: 'Lard', semantic_tags: ['fat'] },
  ];

  function built(candidates: ReadonlyArray<{ fdc_id: number; description: string; semantic_tags?: string[] }>) {
    const result = buildAiAdvancedCandidateSet({ lineRef: 'butter or oil', candidates });
    if (!result.ok) throw new Error('candidate set failed');
    return result.set;
  }

  it('resolves a valid ref to the EXACT expected local candidate', () => {
    const set = built(SET_A);
    expect(set.resolve('c1')).toEqual({
      fdc_id: 1001,
      description: 'Butter, unsalted',
      semantic_tags: Object.freeze(['fat']),
    });
    expect(set.resolve('c1')?.fdc_id).toBe(1001);
    expect(set.resolve('c2')?.fdc_id).toBe(1002);
    expect(set.refFor(1001)).toBe('c1');
    expect(set.refFor(1002)).toBe('c2');
    // `refFor` is the inverse mapping for THIS request only.
    expect(set.refFor(9999)).toBeUndefined();
  });

  it('returns undefined for an unknown but syntactically valid ref', () => {
    const set = built(SET_A);
    for (const ref of ['c3', 'c4', 'c0', 'c99', 'c1000000', 'p1']) {
      expect(set.resolve(ref)).toBeUndefined();
    }
  });

  it('cannot resolve a malformed or absent ref', () => {
    const set = built(SET_A);
    for (const ref of [
      '',
      ' ',
      'c',
      'C1',
      'c1 ',
      ' c1',
      'c1x',
      'c01',
      '1',
      'c-1',
      'c1.0',
      'c1\n',
    ]) {
      expect(set.resolve(ref as string)).toBeUndefined();
    }
    // Non-string inputs must never coerce into a hit.
    for (const bogus of [undefined, null, 1, 0, -1, true, false, {}, [], ['c1'], Symbol('c1'), () => 'c1']) {
      expect(set.resolve(bogus as never)).toBeUndefined();
    }
  });

  it('never resolves a ref from ANOTHER candidate set / request', () => {
    const setA = built(SET_A);
    const setB = built(SET_B);

    // The same opaque ref means DIFFERENT locals per request: refs carry no
    // meaning across requests, so neither set can reach the other's authority.
    expect(setA.resolve('c1')?.fdc_id).toBe(1001);
    expect(setB.resolve('c1')?.fdc_id).toBe(2001);
    expect(setA.resolve('c1')?.fdc_id).not.toBe(2001);
    expect(setB.resolve('c1')?.fdc_id).not.toBe(1001);

    // A ref that is valid in the larger set is absent from the smaller one.
    expect(setB.resolve('c3')).toBeDefined();
    expect(setA.resolve('c3')).toBeUndefined();

    // No local candidate from one set is reachable through the other.
    for (const view of setA.views) {
      expect(setB.resolve(view.candidate_ref)?.description).not.toBe(
        setA.resolve(view.candidate_ref)?.description
      );
    }
    // A set built with the same input tree still owns its own mapping.
    const setA2 = built(SET_A);
    expect(setA2.resolve('c2')?.fdc_id).toBe(1002);
    expect(setA2.resolve('c3')).toBeUndefined();
  });
});

describe('AI-0 candidate-bound orchestration', () => {
  const CANDIDATES = [
    { fdc_id: 1001, description: 'Butter, unsalted', semantic_tags: ['fat'] },
    { fdc_id: 1002, description: 'Butter, salted', semantic_tags: ['fat'] },
    { fdc_id: 1003, description: 'Margarine', semantic_tags: ['fat'] },
  ];

  it('exposes opaque request-scoped refs and hides local authority', () => {
    const built = buildAiAdvancedCandidateSet({ lineRef: 'butter', candidates: CANDIDATES });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.set.views.map((view) => view.candidate_ref)).toEqual(['c1', 'c2', 'c3']);
    expect(JSON.stringify(built.set.views)).not.toContain('1001');
    expect(built.set.resolve('c2')?.fdc_id).toBe(1002);
    expect(built.set.refFor(1003)).toBe('c3');
    expect(built.set.resolve('c99')).toBeUndefined();
  });

  it('rejects duplicate, oversized, empty, and invalid candidate sets', () => {
    expect(
      buildAiAdvancedCandidateSet({
        lineRef: 'x',
        candidates: [
          { fdc_id: 1, description: 'A' },
          { fdc_id: 1, description: 'B' },
        ],
      })
    ).toEqual({ ok: false, code: 'duplicate_candidate' });
    expect(buildAiAdvancedCandidateSet({ lineRef: 'x', candidates: [] })).toEqual({
      ok: false,
      code: 'no_candidates',
    });
    expect(
      buildAiAdvancedCandidateSet({
        lineRef: 'x',
        candidates: Array.from({ length: MAX_AI_ADVANCED_CANDIDATES + 1 }, (_, index) => ({
          fdc_id: index + 1,
          description: `food ${index}`,
        })),
      })
    ).toEqual({ ok: false, code: 'too_many_candidates' });
    expect(
      buildAiAdvancedCandidateSet({ lineRef: 'x', candidates: [{ fdc_id: -1, description: 'A' }] })
    ).toEqual({ ok: false, code: 'invalid_candidate' });
  });

  it('sanitizes plans against supplied refs only and maps them back locally', () => {
    const candidateSet = buildAiAdvancedCandidateSet({ lineRef: 'butter', candidates: CANDIDATES });
    expect(candidateSet.ok).toBe(true);
    if (!candidateSet.ok) return;
    const portionSet = buildAiAdvancedPortionSet({
      portions: [
        { portion_index: 0, display_label: '1 tbsp = 14.2 g', kind: 'volume' },
        { portion_index: 1, display_label: '1 stick = 113 g', kind: 'household' },
      ],
    });
    expect(portionSet.ok).toBe(true);
    if (!portionSet.ok) return;

    const allowances = {
      allowedLineRefs: ['butter'],
      allowedCandidateRefsByLine: { butter: candidateSet.set.views.map((view) => view.candidate_ref) },
      allowedPortionRefsByLine: { butter: portionSet.set.views.map((view) => view.portion_ref) },
    };

    const valid = sanitizeAiAdvancedPlanResponse(
      {
        plan_version: AI_ADVANCED_PLAN_VERSION,
        plans: [
          {
            line_ref: 'butter',
            candidate_ref: 'c2',
            measure_kind: 'source_portion',
            portion_ref: 'p1',
            review_required: false,
            ambiguity_reasons: [],
          },
        ],
      },
      allowances
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.plans).toHaveLength(1);
    const mapped = resolvePlanCandidate({ plan: valid.plans[0], candidateSet: candidateSet.set });
    expect(mapped.ok).toBe(true);
    if (mapped.ok) expect(mapped.candidate.fdc_id).toBe(1002);

    expect(
      sanitizeAiAdvancedPlanResponse(
        {
          plan_version: AI_ADVANCED_PLAN_VERSION,
          plans: [{ line_ref: 'butter', candidate_ref: 'c9', measure_kind: 'unknown', review_required: true }],
        },
        allowances
      )
    ).toEqual({ ok: false, code: 'unknown_candidate_ref' });

    expect(
      sanitizeAiAdvancedPlanResponse(
        {
          plan_version: AI_ADVANCED_PLAN_VERSION,
          plans: [
            { line_ref: 'butter', candidate_ref: 'c1', measure_kind: 'unknown', portion_ref: 'p9', review_required: true },
          ],
        },
        allowances
      )
    ).toEqual({ ok: false, code: 'unknown_portion_ref' });

    expect(
      sanitizeAiAdvancedPlanResponse(
        { plan_version: AI_ADVANCED_PLAN_VERSION, plans: [] },
        { allowedLineRefs: ['butter'] }
      )
    ).toEqual({ ok: true, plans: [] });
    expect(
      sanitizeAiAdvancedPlanResponse(
        {
          plan_version: AI_ADVANCED_PLAN_VERSION,
          plans: Array.from({ length: MAX_AI_ADVANCED_PLANS + 1 }, () => ({
            line_ref: 'butter',
            measure_kind: 'unknown',
            review_required: true,
          })),
        },
        allowances
      )
    ).toEqual({ ok: false, code: 'invalid_response' });
  });

  it('rejects duplicate portion options and never exposes portion indexes', () => {
    expect(
      buildAiAdvancedPortionSet({
        portions: [
          { portion_index: 0, display_label: 'a' },
          { portion_index: 0, display_label: 'b' },
        ],
      })
    ).toEqual({ ok: false, code: 'duplicate_portion' });
    const built = buildAiAdvancedPortionSet({
      portions: Array.from({ length: MAX_AI_ADVANCED_PORTION_OPTIONS + 1 }, (_, index) => ({
        portion_index: index,
        display_label: `p${index}`,
      })),
    });
    expect(built).toEqual({ ok: false, code: 'too_many_portions' });
  });

  it('the plan schema declares no authority field', () => {
    const text = JSON.stringify(buildAiAdvancedPlanSchema());
    for (const forbidden of ['fdc_id', 'grams', 'nutrients', 'digest', 'apply', 'authorization']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider-neutral boundary (static import scan)
// ---------------------------------------------------------------------------

describe('AI-0 provider neutrality', () => {
  it('the nutrition domain imports no provider SDK, server module, or runtime dependency', () => {
    const files = readdirSync(CORE_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath ?? CORE_DIR, entry.name));
    expect(files.length).toBeGreaterThan(50);
    const forbiddenImportPattern = /from\s+['"](?:@google\/genai|openai|@anthropic-ai\/[^'"]+|server\/[^'"]+|express|dotenv)['"]/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} must not import a provider SDK / server module`).not.toMatch(
        forbiddenImportPattern
      );
    }
  });

  it('the canonical interpretation module imports only pure contracts', () => {
    const source = readFileSync(join(CORE_DIR, 'aiAdvanced.ts'), 'utf8');
    const importLines = source.split('\n').filter((line) => /^import\b/.test(line.trim()));
    for (const line of importLines) {
      expect(line).toMatch(/from '\.\/(schema|aiResolution)'/);
    }
  });
});

// ---------------------------------------------------------------------------
// Capability / tier boundary
// ---------------------------------------------------------------------------

describe('AI-0 capability boundary', () => {
  it('Basic Nutrition keeps deterministic review and manual editing with no AI', () => {
    expect(BASIC_NUTRITION_CAPABILITIES.tier).toBe('basic');
    expect(BASIC_NUTRITION_CAPABILITIES.deterministicReview).toBe(true);
    expect(BASIC_NUTRITION_CAPABILITIES.manualEditing).toBe(true);
    expect(BASIC_NUTRITION_CAPABILITIES.aiInterpretation).toBe(false);
    expect(BASIC_NUTRITION_CAPABILITIES.aiCandidateOrchestration).toBe(false);
    expect(BASIC_NUTRITION_CAPABILITIES.aiEstimation).toBe('disabled');
    expect(isManualEditingAvailable(BASIC_NUTRITION_CAPABILITIES)).toBe(true);
    expect(isAiInterpretationAvailable(BASIC_NUTRITION_CAPABILITIES)).toBe(false);
  });

  it('fails safe: only configured AND reachable AI yields the AI tier', () => {
    expect(resolveNutritionCapabilities()).toBe(BASIC_NUTRITION_CAPABILITIES);
    expect(resolveNutritionCapabilities({ aiConfigured: true })).toBe(BASIC_NUTRITION_CAPABILITIES);
    expect(resolveNutritionCapabilities({ aiReachable: true })).toBe(BASIC_NUTRITION_CAPABILITIES);
    const ai = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
    expect(ai.tier).toBe('ai_advanced');
    expect(ai.aiInterpretation).toBe(true);
    expect(ai.aiCandidateOrchestration).toBe(true);
    // Manual editing is a permanent invariant; AI-0 never enables estimation.
    expect(isManualEditingAvailable(ai)).toBe(true);
    expect(ai.aiEstimation).toBe('disabled');
    expect(isAiInterpretationAvailable(resolveNutritionCapabilities())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Future bounded-estimate skeleton
// ---------------------------------------------------------------------------

describe('AI-0 future bounded-estimate skeleton', () => {
  const VALID_PROPOSAL = {
    policy_version: 'nutrition_ai_estimate_policy_v1',
    provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
    line_ref: 'line-1',
    lower_grams: 80,
    upper_grams: 120,
    representative_grams: 100,
    representative_policy: 'midpoint',
    input_semantics: ['1 handful spinach'],
    evidence_absent_reason: 'no authenticated portion for fresh spinach',
    provider: { provider_id: 'openrouter', model_id: 'example/model' },
    notes: 'uncertainty explicit',
  };

  it('validates the required future shape (bounds, policy, semantics, reason)', () => {
    const result = validateAiBoundedEstimateProposal(VALID_PROPOSAL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.provenance_class).toBe(AI_ESTIMATE_PROVENANCE_CLASS);
  });

  it('refuses malformed bounds and missing uncertainty', () => {
    const { lower_grams: _omittedLower, ...withoutLower } = VALID_PROPOSAL;
    expect(validateAiBoundedEstimateProposal(withoutLower)).toEqual({
      ok: false,
      code: 'invalid_proposal',
    });
    expect(validateAiBoundedEstimateProposal({ ...VALID_PROPOSAL, upper_grams: 50 })).toEqual({
      ok: false,
      code: 'invalid_proposal',
    });
    expect(validateAiBoundedEstimateProposal({ ...VALID_PROPOSAL, representative_grams: 500 })).toEqual({
      ok: false,
      code: 'invalid_proposal',
    });
    expect(validateAiBoundedEstimateProposal({ ...VALID_PROPOSAL, input_semantics: [] })).toEqual({
      ok: false,
      code: 'invalid_proposal',
    });
    expect(validateAiBoundedEstimateProposal({ ...VALID_PROPOSAL, evidence_absent_reason: '' })).toEqual({
      ok: false,
      code: 'invalid_proposal',
    });
  });

  it('never lets a proposal claim stronger provenance or authority fields', () => {
    expect(
      validateAiBoundedEstimateProposal({ ...VALID_PROPOSAL, provenance_class: 'usda_derived' })
    ).toEqual({ ok: false, code: 'authority_field' });
    expect(
      validateAiBoundedEstimateProposal({ ...VALID_PROPOSAL, authority_class: 'usda_derived' })
    ).toEqual({ ok: false, code: 'authority_field' });
    expect(validateAiBoundedEstimateProposal({ ...VALID_PROPOSAL, fdc_id: 12345 })).toEqual({
      ok: false,
      code: 'authority_field',
    });
    expect(isAuthenticatedProvenanceClass('ai_estimate')).toBe(false);
    expect(isAuthenticatedProvenanceClass('usda_derived')).toBe(true);
    expect(isAiEstimateProvenanceClass('ai_estimate')).toBe(true);
  });

  it('estimation is hard-disabled in AI-0 even for a perfect proposal', () => {
    expect(AI_ESTIMATION_AVAILABILITY).toBe('disabled');
    expect(isAiEstimationEnabled()).toBe(false);
    expect(resolveAiBoundedEstimate(VALID_PROPOSAL)).toEqual({ ok: false, code: 'estimation_disabled' });
  });
});

// ---------------------------------------------------------------------------
// Separate benchmark accounting
// ---------------------------------------------------------------------------

describe('AI-0 separate benchmark accounting', () => {
  it('never counts an AI interpretation alone as resolved', () => {
    expect(classifyAiAdvancedBenchmarkOutcome({ resolved: false, ai_assisted: true })).toBe('unresolved');
    expect(
      classifyAiAdvancedBenchmarkOutcome({ resolved: false, ai_assisted: true, review_required: true })
    ).toBe('still_review');
  });

  it('separates deterministic, authenticated-AI, and estimate resolutions', () => {
    expect(classifyAiAdvancedBenchmarkOutcome({ resolved: true, mass_source: 'direct_mass' })).toBe(
      'deterministic'
    );
    expect(
      classifyAiAdvancedBenchmarkOutcome({
        resolved: true,
        mass_source: 'source_portion',
        ai_assisted: true,
      })
    ).toBe('ai_assisted_authenticated');
    expect(
      classifyAiAdvancedBenchmarkOutcome({
        resolved: true,
        mass_source: 'household_portion',
        authority_class: 'bounded_estimate',
        ai_assisted: true,
      })
    ).toBe('ai_assisted_bounded_estimate');
    // An estimate is never counted as authenticated, even without AI.
    expect(
      classifyAiAdvancedBenchmarkOutcome({
        resolved: true,
        mass_source: 'household_portion',
        authority_class: 'bounded_estimate',
      })
    ).toBe('ai_assisted_bounded_estimate');
    // A "resolved" line with no provable deterministic mass source gets no credit.
    expect(classifyAiAdvancedBenchmarkOutcome({ resolved: true, ai_assisted: true })).toBe('unresolved');
  });

  it('summarizes the separate buckets without inflating the authenticated count', () => {
    const summary = summarizeAiAdvancedBenchmark([
      { resolved: true, mass_source: 'direct_mass' },
      { resolved: true, mass_source: 'source_portion' },
      { resolved: true, mass_source: 'source_portion', ai_assisted: true },
      { resolved: true, mass_source: 'ai_estimate', ai_assisted: true },
      { resolved: false, ai_assisted: true, review_required: true },
      { resolved: false },
    ]);
    expect(summary.total).toBe(6);
    expect(summary.deterministic).toBe(2);
    expect(summary.ai_assisted_authenticated).toBe(1);
    expect(summary.ai_assisted_bounded_estimate).toBe(1);
    expect(summary.still_review).toBe(1);
    expect(summary.unresolved).toBe(1);
    expect(summary.resolved_authenticated).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Phase 4/7 semantics are a subset of the canonical contract
// ---------------------------------------------------------------------------

describe('AI-0 Phase 7 semantics fit the canonical contract', () => {
  it('maps an existing advisory suggestion into canonical semantics losslessly enough', () => {
    const suggestion: AiResolutionSuggestion = {
      line_ref: 'garlic',
      interpreted_food_name: 'garlic',
      suggested_usda_queries: ['garlic raw'],
      normalized_food_query: 'garlic',
      preparation_hint: 'minced',
      quantity_value: 3,
      quantity_unit_hint: 'clove',
      count_descriptor_hint: 'clove',
      portion_search_hint: 'clove',
      household_size_hint: 'medium',
      confidence: 'high',
      explanation: 'three cloves',
    };
    const interpretation = aiAdvancedInterpretationFromResolutionSuggestion(suggestion);
    expect(interpretation.contract_version).toBe(AI_ADVANCED_CONTRACT_VERSION);
    expect(interpretation.line_ref).toBe('garlic');
    expect(interpretation.semantic_food.normalized_name).toBe('garlic');
    expect(interpretation.semantic_food.preparation).toEqual(['minced']);
    expect(interpretation.amount_semantics).toEqual({ kind: 'exact', echoed_value: 3 });
    expect(interpretation.count_semantics.noun).toBe('clove');
    expect(interpretation.count_semantics.size).toBe('medium');
    expect(interpretation.confidence).toBe('high');

    // The canonical semantics survive a sanitize round trip unchanged.
    const roundTrip = sanitizeAiAdvancedInterpretationResponse(
      { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: [interpretation] },
      { allowedLineRefs: ['garlic'] }
    );
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) {
      expect(roundTrip.interpretations[0]).toEqual(interpretation);
    }
  });
});
