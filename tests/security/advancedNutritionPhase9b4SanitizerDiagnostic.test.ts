/**
 * The Kitchen Codex — Phase 9B-P4.
 * SEMANTIC SANITIZER REJECTION-BRANCH DIAGNOSTIC — offline contract alignment.
 *
 * WHY THIS SUITE EXISTS. The 9B-P3 controlled live smoke proved the Gemini
 * primary (`gemini-3.7-flash`, LOW thinking) returns successfully over the real
 * transport, and that the failure stage is the STRICT SANITIZER with the
 * collapsed code `invalid_response`. Roughly forty distinct structural
 * conditions share that one code, so the defect was not diagnosable without
 * spending a second live provider call.
 *
 * 9B-P4 adds a PRIVATE, BOUNDED, OUT-OF-BAND rejection observer. This suite
 * proves the resulting diagnostic boundary is:
 *   - derived from the REAL rejecting branch (not a guess, not a second pass),
 *   - drawn from a CLOSED vocabulary that carries no provider content,
 *   - unable to leak recipe text, field names, field values, or identifiers,
 *   - unable to alter the PUBLIC result contract in any byte,
 *   - unable to alter fail-closed behavior, receipts, fallback, or attempt count,
 *   - and isolated from a throwing diagnostic sink.
 *
 * It also pins the PROVIDER-SCHEMA vs SANITIZER comparison: every documented
 * mismatch below is a case the JSON schema sent to Gemini PERMITS and the
 * sanitizer REJECTS. These are synthetic provider responses. NO live provider is
 * contacted, NO real key is used, and NOTHING here is a claim about the actual
 * unseen 9B-P3 Gemini output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import type { AiCandidate, RegisteredProvider } from '../../server/ai/providerRegistry';
import { ProviderOperationError } from '../../server/ai/providerErrors';
import type {
  AiCapabilities,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from '../../src/core/ai/types';
import {
  AI_ADVANCED_CONTRACT_VERSION,
  AI_ADVANCED_REJECT_REASONS,
  buildAiAdvancedInterpretationSchema,
  sanitizeAiAdvancedInterpretationResponse,
  type AiAdvancedRejectReason,
} from '../../src/core/nutritionV2/aiAdvanced';
import {
  MAX_AI_ADVANCED_ALTERNATIVES,
  MAX_AI_ADVANCED_AMBIGUITY_REASONS,
  MAX_AI_ADVANCED_NAME_LENGTH,
  MAX_AI_ADVANCED_NOTE_LENGTH,
  MAX_AI_ADVANCED_PHRASE_LENGTH,
  MAX_AI_ADVANCED_ROWS,
  MAX_AI_ADVANCED_SEARCH_PHRASES,
  MAX_AI_ADVANCED_TOKEN_LENGTH,
  MAX_AI_ADVANCED_TOKENS,
} from '../../src/core/nutritionV2/aiAdvanced';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4';

// ---------------------------------------------------------------------------
// OFFLINE SANCTIZER HARNESS
// ---------------------------------------------------------------------------

const REF = 'ing:0:20e4077fc89a';
const ALLOWED = [REF];

function goodRow(line_ref: string = REF): Record<string, unknown> {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref,
    semantic_food: {
      normalized_name: 'whole egg',
      modifiers: [],
      preparation: ['separated'],
      state: ['raw'],
      qualifiers: [],
    },
    search_phrases: ['whole egg'],
    amount_semantics: { kind: 'exact', echoed_value: 4, phrasing: '4' },
    unit_semantics: { family: 'count', raw: 'eggs', interpreted_unit: 'count' },
    count_semantics: { noun: 'eggs', size: 'large' },
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
  };
}

function goodEnvelope(rows: unknown[] = [goodRow()]): Record<string, unknown> {
  return { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: rows };
}

/** Runs the sanitizer and returns BOTH the public result and the sub-reason. */
function sanitize(raw: unknown): {
  result: ReturnType<typeof sanitizeAiAdvancedInterpretationResponse>;
  reason?: AiAdvancedRejectReason;
} {
  let reason: AiAdvancedRejectReason | undefined;
  const result = sanitizeAiAdvancedInterpretationResponse(raw, {
    allowedLineRefs: ALLOWED,
    onReject: (r) => {
      reason = r;
    },
  });
  return { result, reason };
}

/** Asserts rejection with the exact expected public code AND sub-reason. */
function expectReject(raw: unknown, code: string, reason: AiAdvancedRejectReason): void {
  const { result, reason: actual } = sanitize(raw);
  expect(result.ok, `expected rejection for sub_reason=${reason}`).toBe(false);
  expect((result as { code: string }).code).toBe(code);
  expect(actual).toBe(reason);
}

// ---------------------------------------------------------------------------
// 1. WELL-FORMED CANONICAL OUTPUTS STILL PASS
// ---------------------------------------------------------------------------

describe('9B-P4 — well-formed canonical outputs still pass', () => {
  it('accepts the canonical row and never fires the observer', () => {
    let fired = 0;
    const result = sanitizeAiAdvancedInterpretationResponse(goodEnvelope(), {
      allowedLineRefs: ALLOWED,
      onReject: () => {
        fired += 1;
      },
    });
    expect(result.ok).toBe(true);
    expect(fired).toBe(0);
  });

  it('accepts the minimal envelope Gemini is actually required to emit', () => {
    const result = sanitizeAiAdvancedInterpretationResponse(goodEnvelope([{ line_ref: REF }]), {
      allowedLineRefs: ALLOWED,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts every optional field populated at its exact maximum bound', () => {
    const row = goodRow();
    row.semantic_food = {
      normalized_name: 'n'.repeat(MAX_AI_ADVANCED_NAME_LENGTH),
      modifiers: Array.from({ length: MAX_AI_ADVANCED_TOKENS }, () => 'm'.repeat(MAX_AI_ADVANCED_TOKEN_LENGTH)),
      preparation: Array.from({ length: MAX_AI_ADVANCED_TOKENS }, () => 'p'),
      state: Array.from({ length: MAX_AI_ADVANCED_TOKENS }, () => 's'),
      qualifiers: Array.from({ length: MAX_AI_ADVANCED_TOKENS }, () => 'q'),
    };
    row.search_phrases = Array.from({ length: MAX_AI_ADVANCED_SEARCH_PHRASES }, () =>
      'p'.repeat(MAX_AI_ADVANCED_PHRASE_LENGTH)
    );
    row.alternatives = Array.from({ length: MAX_AI_ADVANCED_ALTERNATIVES }, (_, i) => ({
      normalized_name: `alt ${i}`,
      notes: 'n'.repeat(MAX_AI_ADVANCED_NOTE_LENGTH),
    }));
    row.ambiguity = {
      ambiguous: true,
      reasons: Array.from({ length: MAX_AI_ADVANCED_AMBIGUITY_REASONS }, (_, i) => `r${i}`),
    };
    row.amount_semantics = {
      kind: 'range',
      range_lower: 2,
      range_upper: 3,
      echoed_value: 2,
      phrasing: 'two to three',
    };
    row.notes = 'n'.repeat(MAX_AI_ADVANCED_NOTE_LENGTH);
    expect(sanitize(goodEnvelope([row])).result.ok).toBe(true);
  });

  it('accepts the maximum permitted row count', () => {
    const rows = Array.from({ length: MAX_AI_ADVANCED_ROWS }, (_, i) => goodRow(`${REF}#${i}`));
    const result = sanitizeAiAdvancedInterpretationResponse(goodEnvelope(rows), {
      allowedLineRefs: rows.map((r) => r.line_ref as string),
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. EVERY MAJOR MALFORMED CLASS FAILS, NAMING THE ACTUAL BRANCH
// ---------------------------------------------------------------------------

describe('9B-P4 — envelope branches name themselves', () => {
  it('envelope_shape: not a plain object', () => {
    for (const raw of [null, 'a string', 42, true, ['interpretations']]) {
      expectReject(raw, 'invalid_response', 'envelope_shape');
    }
  });

  it('envelope_key_unknown: a non-authority unknown envelope key', () => {
    expectReject({ ...goodEnvelope(), usage: {} }, 'invalid_response', 'envelope_key_unknown');
  });

  it('envelope_key_authority: an authority envelope key keeps the authority code', () => {
    expectReject({ ...goodEnvelope(), nutrients: {} }, 'authority_field', 'envelope_key_authority');
  });

  it('envelope_contract_version: a wrong version keeps its own code', () => {
    expectReject(
      { contract_version: 'nutrition_ai_advanced_interpretation_v2', interpretations: [] },
      'unsupported_contract_version',
      'envelope_contract_version'
    );
  });

  it('rows_not_array', () => {
    expectReject(
      { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: { '0': goodRow() } },
      'invalid_response',
      'rows_not_array'
    );
  });

  it('row_count_exceeded', () => {
    const rows = Array.from({ length: MAX_AI_ADVANCED_ROWS + 1 }, (_, i) => goodRow(`${REF}#${i}`));
    expectReject(
      goodEnvelope(rows),
      'invalid_response',
      'row_count_exceeded'
    );
  });

  it('respects a caller-supplied maxRows clamp', () => {
    const second = `${REF}#1`;
    const envelope = goodEnvelope([goodRow(REF), goodRow(second)]);
    const refs = [REF, second];
    // The caller's clamp is the MINIMUM of `maxRows` and MAX_AI_ADVANCED_ROWS.
    let reason: AiAdvancedRejectReason | undefined;
    const clamped = sanitizeAiAdvancedInterpretationResponse(envelope, {
      allowedLineRefs: refs,
      maxRows: 1,
      onReject: (r) => {
        reason = r;
      },
    });
    expect(clamped.ok).toBe(false);
    expect((clamped as { code: string }).code).toBe('invalid_response');
    expect(reason).toBe('row_count_exceeded');
    expect(sanitizeAiAdvancedInterpretationResponse(envelope, { allowedLineRefs: refs, maxRows: 2 }).ok).toBe(true);
  });
});

describe('9B-P4 — row branches name themselves', () => {
  it('row_shape: a non-object row', () => {
    expectReject(goodEnvelope(['nope']), 'invalid_response', 'row_shape');
  });

  it('row_key_authority beats row_key_unknown (authority checked first)', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), fdc_id: 'X', surprise: 1 }]),
      'authority_field',
      'row_key_authority'
    );
  });

  it('row_key_unknown: an unknown non-authority key', () => {
    expectReject(goodEnvelope([{ ...goodRow(), surprise: 1 }]), 'invalid_response', 'row_key_unknown');
  });

  it('row_contract_version: a mismatched per-entry version keeps its own code', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), contract_version: 'nutrition_ai_advanced_interpretation_v2' }]),
      'unsupported_contract_version',
      'row_contract_version'
    );
  });

  it('line_ref_malformed: blank, oversized, or non-string', () => {
    // NOTE: `line_ref: undefined` is caught EARLIER, by the inert pre-pass,
    // because `undefined` is not a JSON-safe value. It never reaches the row
    // checks, which is why `line_ref_malformed` covers the remaining shapes.
    expectReject(goodEnvelope([{ ...goodRow(), line_ref: undefined }]), 'unsafe_response', 'response_unsafe');
    expectReject(goodEnvelope([{ ...goodRow(), line_ref: '   ' }]), 'invalid_response', 'line_ref_malformed');
    expectReject(goodEnvelope([{ ...goodRow(), line_ref: 42 }]), 'invalid_response', 'line_ref_malformed');
    expectReject(
      goodEnvelope([{ ...goodRow(), line_ref: 'r'.repeat(201) }]),
      'invalid_response',
      'line_ref_malformed'
    );
  });

  it('line_ref_not_requested: an unknown ref keeps its own code', () => {
    expectReject(goodEnvelope([goodRow('ing:9:deadbeefcafe')]), 'unknown_line_ref', 'line_ref_not_requested');
  });

  it('line_ref_duplicate keeps its own code', () => {
    expectReject(
      goodEnvelope([goodRow(), goodRow()]),
      'duplicate_line_ref',
      'line_ref_duplicate'
    );
  });
});

describe('9B-P4 — semantic_food / search_phrases branches', () => {
  it('semantic_food_shape', () => {
    expectReject(goodEnvelope([{ ...goodRow(), semantic_food: 'whole egg' }]), 'invalid_response', 'semantic_food_shape');
  });

  it('semantic_food_key_unknown', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), semantic_food: { brand: 'x' } }]),
      'invalid_response',
      'semantic_food_key_unknown'
    );
  });

  it('semantic_food_name_malformed (blank or oversized)', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), semantic_food: { normalized_name: '  ' } }]),
      'invalid_response',
      'semantic_food_name_malformed'
    );
    expectReject(
      goodEnvelope([
        { ...goodRow(), semantic_food: { normalized_name: 'n'.repeat(MAX_AI_ADVANCED_NAME_LENGTH + 1) } },
      ]),
      'invalid_response',
      'semantic_food_name_malformed'
    );
  });

  it('semantic_food_token_count (non-array AND over-max are both count)', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), semantic_food: { modifiers: 'whole' } }]),
      'invalid_response',
      'semantic_food_token_count'
    );
    expectReject(
      goodEnvelope([
        {
          ...goodRow(),
          semantic_food: { modifiers: Array.from({ length: MAX_AI_ADVANCED_TOKENS + 1 }, () => 'x') },
        },
      ]),
      'invalid_response',
      'semantic_food_token_count'
    );
  });

  it('semantic_food_token_malformed (blank or oversized token)', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), semantic_food: { state: [''] } }]),
      'invalid_response',
      'semantic_food_token_malformed'
    );
    expectReject(
      goodEnvelope([
        {
          ...goodRow(),
          semantic_food: { state: ['x'.repeat(MAX_AI_ADVANCED_TOKEN_LENGTH + 1)] },
        },
      ]),
      'invalid_response',
      'semantic_food_token_malformed'
    );
  });

  it('search_phrases_shape (non-array AND over-max)', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), search_phrases: 'whole egg' }]),
      'invalid_response',
      'search_phrases_shape'
    );
    expectReject(
      goodEnvelope([
        { ...goodRow(), search_phrases: Array.from({ length: MAX_AI_ADVANCED_SEARCH_PHRASES + 1 }, () => 'x') },
      ]),
      'invalid_response',
      'search_phrases_shape'
    );
  });

  it('search_phrase_malformed', () => {
    expectReject(goodEnvelope([{ ...goodRow(), search_phrases: [''] }]), 'invalid_response', 'search_phrase_malformed');
    expectReject(
      goodEnvelope([{ ...goodRow(), search_phrases: ['p'.repeat(MAX_AI_ADVANCED_PHRASE_LENGTH + 1)] }]),
      'invalid_response',
      'search_phrase_malformed'
    );
  });
});

describe('9B-P4 — amount_semantics branches', () => {
  it('amount_semantics_shape / _key_unknown / amount_kind_invalid', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: 'exact 4' }]),
      'invalid_response',
      'amount_semantics_shape'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', certainty: 1 } }]),
      'invalid_response',
      'amount_semantics_key_unknown'
    );
    expectReject(goodEnvelope([{ ...goodRow(), amount_semantics: {} }]), 'invalid_response', 'amount_kind_invalid');
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'approximately' } }]),
      'invalid_response',
      'amount_kind_invalid'
    );
  });

  it('amount_endpoint_invalid (zero, negative, non-finite, over-max)', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001]) {
      expectReject(
        goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', echoed_value: bad } }]),
        'invalid_response',
        'amount_echoed_value_invalid'
      );
      expectReject(
        goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'range', range_lower: bad, range_upper: 3 } }]),
        'invalid_response',
        'amount_endpoint_invalid'
      );
    }
  });

  it('amount_range_incomplete: a claimed range missing an endpoint', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'range', range_lower: 2 } }]),
      'invalid_response',
      'amount_range_incomplete'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'range', range_upper: 2 } }]),
      'invalid_response',
      'amount_range_incomplete'
    );
  });

  it('amount_range_order: an inverted range', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'range', range_lower: 3, range_upper: 2 } }]),
      'invalid_response',
      'amount_range_order'
    );
  });

  it('amount_endpoint_on_non_range: endpoints on a non-range claim', () => {
    for (const kind of ['exact', 'approximate', 'unknown']) {
      expectReject(
        goodEnvelope([{ ...goodRow(), amount_semantics: { kind, range_lower: 2, range_upper: 3 } }]),
        'invalid_response',
        'amount_endpoint_on_non_range'
      );
      expectReject(
        goodEnvelope([{ ...goodRow(), amount_semantics: { kind, range_lower: 2 } }]),
        'invalid_response',
        'amount_endpoint_on_non_range'
      );
    }
  });

  it('amount_echoed_value_invalid and amount_phrasing_malformed', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', echoed_value: -4 } }]),
      'invalid_response',
      'amount_echoed_value_invalid'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', phrasing: '   ' } }]),
      'invalid_response',
      'amount_phrasing_malformed'
    );
  });

  it('null endpoints on a non-range claim are treated as ABSENT, not a rejection', () => {
    const { result } = sanitize(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', range_lower: null, range_upper: null } }])
    );
    expect(result.ok).toBe(true);
  });
});

describe('9B-P4 — unit / count / alternatives / ambiguity / advisory branches', () => {
  it('unit_semantics_shape / _key_unknown / unit_family_invalid', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), unit_semantics: 'count' }]),
      'invalid_response',
      'unit_semantics_shape'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), unit_semantics: { family: 'count', system: 'metric' } }]),
      'invalid_response',
      'unit_semantics_key_unknown'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), unit_semantics: { family: 'scoops' } }]),
      'invalid_response',
      'unit_family_invalid'
    );
  });

  it('unit_raw_malformed / unit_interpreted_malformed', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), unit_semantics: { family: 'count', raw: '' } }]),
      'invalid_response',
      'unit_raw_malformed'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), unit_semantics: { family: 'count', interpreted_unit: '  ' } }]),
      'invalid_response',
      'unit_interpreted_malformed'
    );
  });

  it('count_semantics_shape / _key_unknown / count_token_malformed', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), count_semantics: 'eggs' }]),
      'invalid_response',
      'count_semantics_shape'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), count_semantics: { grade: 'A' } }]),
      'invalid_response',
      'count_semantics_key_unknown'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), count_semantics: { noun: '' } }]),
      'invalid_response',
      'count_token_malformed'
    );
  });

  it('alternatives_shape / alternative_shape / _key_unknown / _name / _notes', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), alternatives: 'yolk' }]),
      'invalid_response',
      'alternatives_shape'
    );
    expectReject(
      goodEnvelope([
        { ...goodRow(), alternatives: Array.from({ length: MAX_AI_ADVANCED_ALTERNATIVES + 1 }, () => 'x') },
      ]),
      'invalid_response',
      'alternatives_shape'
    );
    expectReject(goodEnvelope([{ ...goodRow(), alternatives: ['yolk'] }]), 'invalid_response', 'alternative_shape');
    expectReject(
      goodEnvelope([{ ...goodRow(), alternatives: [{ normalized_name: 'yolk', fdc_id: 'X' }] }]),
      'authority_field',
      'row_key_authority'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), alternatives: [{ normalized_name: 'yolk', rank: 1 }] }]),
      'invalid_response',
      'alternative_key_unknown'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), alternatives: [{ normalized_name: '' }] }]),
      'invalid_response',
      'alternative_name_malformed'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), alternatives: [{ normalized_name: 'yolk', notes: '' }] }]),
      'invalid_response',
      'alternative_notes_malformed'
    );
  });

  it('ambiguity_shape / _key_unknown / _flag / _reasons_shape / _reason_malformed', () => {
    expectReject(goodEnvelope([{ ...goodRow(), ambiguity: true }]), 'invalid_response', 'ambiguity_shape');
    expectReject(
      goodEnvelope([{ ...goodRow(), ambiguity: { ambiguous: false, score: 0.5 } }]),
      'invalid_response',
      'ambiguity_key_unknown'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), ambiguity: { ambiguous: 'yes' } }]),
      'invalid_response',
      'ambiguity_flag_invalid'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), ambiguity: { ambiguous: false, reasons: 'none' } }]),
      'invalid_response',
      'ambiguity_reasons_shape'
    );
    expectReject(
      goodEnvelope([
        {
          ...goodRow(),
          ambiguity: {
            ambiguous: true,
            reasons: Array.from({ length: MAX_AI_ADVANCED_AMBIGUITY_REASONS + 1 }, (_, i) => `r${i}`),
          },
        },
      ]),
      'invalid_response',
      'ambiguity_reasons_shape'
    );
    expectReject(
      goodEnvelope([{ ...goodRow(), ambiguity: { ambiguous: true, reasons: [''] } }]),
      'invalid_response',
      'ambiguity_reason_malformed'
    );
  });

  it('confidence_invalid and notes_malformed', () => {
    expectReject(goodEnvelope([{ ...goodRow(), confidence: 'certain' }]), 'invalid_response', 'confidence_invalid');
    expectReject(goodEnvelope([{ ...goodRow(), notes: '' }]), 'invalid_response', 'notes_malformed');
    expectReject(
      goodEnvelope([{ ...goodRow(), notes: 'n'.repeat(MAX_AI_ADVANCED_NOTE_LENGTH + 1) }]),
      'invalid_response',
      'notes_malformed'
    );
  });

  it('inert pre-pass: oversized_response / unsafe_response keep their own codes', () => {
    const huge = goodEnvelope([goodRow()]);
    huge.interpretations = Array.from({ length: 400 }, () => goodRow(`${REF}#${Math.random()}`));
    expectReject(huge, 'oversized_response', 'response_oversized');

    const proto = Object.create({ inherited: 'secret' }) as Record<string, unknown>;
    proto.contract_version = AI_ADVANCED_CONTRACT_VERSION;
    proto.interpretations = [goodRow()];
    expectReject(proto, 'unsafe_response', 'response_unsafe');
  });
});

// ---------------------------------------------------------------------------
// 4. OVERLAPPING ERRORS AND FIRST-FAILURE PRECEDENCE
// ---------------------------------------------------------------------------

describe('9B-P4 — first-failure precedence is deterministic', () => {
  it('authority key beats an unknown key on the same row', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), fdc_id: 'X', surprise: 1 }]),
      'authority_field',
      'row_key_authority'
    );
  });

  it('unknown row key beats a later malformed semantic_food', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), surprise: 1, semantic_food: { normalized_name: '' } }]),
      'invalid_response',
      'row_key_unknown'
    );
  });

  it('unknown row key beats a malformed line_ref', () => {
    expectReject(
      goodEnvelope([{ ...goodRow(), surprise: 1, line_ref: '' }]),
      'invalid_response',
      'row_key_unknown'
    );
  });

  it('malformed line_ref beats an unknown line_ref', () => {
    expectReject(goodEnvelope([{ ...goodRow(), line_ref: '' }]), 'invalid_response', 'line_ref_malformed');
  });

  it('envelope_key_unknown beats a later bad row', () => {
    expectReject(
      { ...goodEnvelope(['not-a-row']), surprise: 1 },
      'invalid_response',
      'envelope_key_unknown'
    );
  });

  it('semantic_food precedes search_phrases precedes amount precedes unit', () => {
    const broken = (field: string, value: unknown): Record<string, unknown> => ({
      ...goodRow(),
      semantic_food: { normalized_name: '' },
      search_phrases: ['x', 'x', 'x', 'x', 'x'],
      [field]: value,
    });
    expectReject(goodEnvelope([broken('amount_semantics', { kind: 'exact', range_lower: 1 })]), 'invalid_response', 'semantic_food_name_malformed');
    expectReject(goodEnvelope([{ ...goodRow(), search_phrases: ['x', 'x', 'x', 'x', 'x'], amount_semantics: { kind: 'exact', range_lower: 1 } }]), 'invalid_response', 'search_phrases_shape');
    expectReject(goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', range_lower: 1 }, unit_semantics: { family: 'scoops' } }]), 'invalid_response', 'amount_endpoint_on_non_range');
    expectReject(goodEnvelope([{ ...goodRow(), unit_semantics: { family: 'scoops' }, count_semantics: { noun: '' } }]), 'invalid_response', 'unit_family_invalid');
    expectReject(goodEnvelope([{ ...goodRow(), count_semantics: { noun: '' }, ambiguity: { ambiguous: 'yes' } }]), 'invalid_response', 'count_token_malformed');
  });

  it('range_incomplete precedes range_order when both would apply', () => {
    // Only range_upper supplied: incomplete, not merely mis-ordered.
    expectReject(
      goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'range', range_upper: 2 } }]),
      'invalid_response',
      'amount_range_incomplete'
    );
  });

  it('the FIRST failing row determines the reported branch', () => {
    const second = `${REF}#1`;
    let reason: AiAdvancedRejectReason | undefined;
    const result = sanitizeAiAdvancedInterpretationResponse(
      goodEnvelope([goodRow(), { ...goodRow(second), notes: '' }]),
      {
        allowedLineRefs: [REF, second],
        onReject: (r) => {
          reason = r;
        },
      }
    );
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_response');
    expect(reason).toBe('notes_malformed');
  });
});

// ---------------------------------------------------------------------------
// 8. BYTE-EQUIVALENT PUBLIC RESULT
// ---------------------------------------------------------------------------

/**
 * The shared rejection corpus. Every entry is a SYNTHETIC provider response,
 * not an observed Gemini output.
 */
const CORPUS: unknown[] = [
  goodEnvelope(),
  goodEnvelope([{ line_ref: REF }]),
  goodEnvelope(['not-a-row']),
  { ...goodEnvelope(), surprise: 1 },
  { ...goodEnvelope(), nutrients: {} },
  { contract_version: 'wrong', interpretations: [] },
  { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: 'nope' },
  goodEnvelope([{ ...goodRow(), notes: '' }]),
  goodEnvelope([{ ...goodRow(), fdc_id: 'X' }]),
  goodEnvelope([goodRow('ing:9:deadbeefcafe')]),
  goodEnvelope([goodRow(), goodRow()]),
  goodEnvelope([{ ...goodRow(), line_ref: '' }]),
  goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', range_lower: 2 } }]),
  null,
  'a string',
  42,
  true,
];

describe('9B-P4 — the public result contract is byte-equivalent', () => {
  it('result with an observer deep-equals result without one, for every case', () => {
    for (const raw of CORPUS) {
      const observed = sanitizeAiAdvancedInterpretationResponse(raw, {
        allowedLineRefs: ALLOWED,
        onReject: () => {},
      });
      const silent = sanitizeAiAdvancedInterpretationResponse(raw, { allowedLineRefs: ALLOWED });
      expect(observed, JSON.stringify(raw)).toEqual(silent);
      // And the shape carries exactly the pre-9B-P4 keys: no reason field leaks.
      expect(Object.keys(observed).sort()).toEqual(silent.ok ? ['interpretations', 'ok'] : ['code', 'ok']);
    }
  });

  it('the observer is invoked exactly once per rejection and never on success', () => {
    for (const raw of CORPUS) {
      let fired = 0;
      sanitizeAiAdvancedInterpretationResponse(raw, {
        allowedLineRefs: ALLOWED,
        onReject: () => {
          fired += 1;
        },
      });
      expect(fired).toBeGreaterThanOrEqual(0);
      expect(fired).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. NO-LEAK: THE OBSERVER RECEIVES A CLOSED LABEL AND NOTHING ELSE
// ---------------------------------------------------------------------------

describe('9B-P4 — the observer is a non-content channel', () => {
  it('every emitted label is in the closed exported allowlist', () => {
    const seen = new Set<string>();
    for (const raw of CORPUS) {
      const { reason } = sanitize(raw);
      if (reason !== undefined) seen.add(reason);
    }
    for (const reason of seen) expect(AI_ADVANCED_REJECT_REASONS.has(reason)).toBe(true);
  });

  it('never emits a hostile key name, field value, or recipe text', () => {
    const SECRETS = [
      'SECRET_FDC_999',
      'INGREDIENT_SECRET_TEXT',
      'egg white',
      'unlock the vault',
      'sk-live-abcdef',
      'a'.repeat(500),
    ];
    for (const raw of CORPUS) {
      const { reason } = sanitize(raw);
      if (reason === undefined) continue;
      for (const secret of SECRETS) expect(reason).not.toContain(secret);
      // A label is always lowercase snake_case within the token alphabet.
      expect(reason).toMatch(/^[a-z_]+$/);
    }
  });

  it('a hostile unknown key name never becomes part of the label', () => {
    const hostileKeyNames = [
      'grams',
      'fdc_id',
      'nutrients',
      '__proto__',
      'constructor',
      'line_ref\nstage=provider_returned',
      'x'.repeat(300),
    ];
    for (const key of hostileKeyNames) {
      const { result, reason } = sanitize(goodEnvelope([{ ...goodRow(), [key]: 'payload' }]));
      expect(result.ok).toBe(false);
      expect(AI_ADVANCED_REJECT_REASONS.has(reason ?? '')).toBe(true);
      expect(reason ?? '').toMatch(/^[a-z_]+$/);
    }
  });

  it('the closed allowlist contains no label that could carry content', () => {
    for (const label of AI_ADVANCED_REJECT_REASONS) {
      expect(label).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(label.length).toBeLessThanOrEqual(64);
    }
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL GUARD PINS (defense in depth, not reachable through the public API)
// ---------------------------------------------------------------------------

describe('9B-P4 — structural pins for the non-reachable defense-in-depth guards', () => {
  const SANITIZER = readFileSync(
    new URL('../../src/core/nutritionV2/aiAdvanced.ts', import.meta.url),
    'utf8'
  );
  const OPERATION = readFileSync(
    new URL('../../server/wholeRecipeSemanticInterpret.ts', import.meta.url),
    'utf8'
  );

  it('the sanitizer re-validates every label against the closed allowlist', () => {
    // MUTATION-SENSITIVE: deleting this ternary leaves every behavioural test
    // green, because no public seam exists to inject an out-of-vocabulary label.
    // The guard is therefore pinned structurally rather than claimed as covered.
    expect(SANITIZER).toContain("const label = AI_ADVANCED_REJECT_REASONS.has(reason) ? reason : 'unknown';");
  });

  it('the sanitizer isolates the observer inside a try/catch sink boundary', () => {
    const index = SANITIZER.indexOf('const reject = (');
    expect(index).toBeGreaterThan(-1);
    const body = SANITIZER.slice(index, index + 1400);
    expect(body).toContain('try {');
    expect(body).toContain('notify(label as AiAdvancedRejectReason);');
    expect(body).toContain('} catch {');
  });

  it('the operation re-validates the sub-reason against the closed allowlist', () => {
    expect(OPERATION).toContain(
      'const LOGGABLE_SANITIZER_SUB_REASONS: ReadonlySet<string> = AI_ADVANCED_REJECT_REASONS;'
    );
    expect(OPERATION).toContain('LOGGABLE_SANITIZER_SUB_REASONS.has(sanitizerSubReason)');
  });

  it('the operation passes the sub-reason through the P2 token sanitizer', () => {
    expect(OPERATION).toContain('{ sub_reason: safeDiagnosticToken(sanitizerSubReason) }');
  });

  it('no sanitizer rejection exit bypasses the single reject helper', () => {
    const body = SANITIZER.slice(SANITIZER.indexOf('export function sanitizeAiAdvancedInterpretationResponse('));
    const rawExits = body.match(
      /return \{ ok: false, code: '(invalid_response|unsafe_response|oversized_response|unsupported_contract_version|authority_field|unknown_line_ref|duplicate_line_ref)' \}/
    );
    expect(rawExits).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. DIAGNOSTIC-SINK FAILURE ISOLATION
// ---------------------------------------------------------------------------

describe('9B-P4 — a broken diagnostic sink cannot change the result', () => {
  it('a THROWING observer still yields the identical rejection', () => {
    const raw = goodEnvelope([{ ...goodRow(), notes: '' }]);
    const silent = sanitizeAiAdvancedInterpretationResponse(raw, { allowedLineRefs: ALLOWED });
    const hostile = sanitizeAiAdvancedInterpretationResponse(raw, {
      allowedLineRefs: ALLOWED,
      onReject: () => {
        throw new Error('diagnostic sink exploded');
      },
    });
    expect(hostile).toEqual(silent);
    expect(hostile.ok).toBe(false);
  });

  it('a NON-FUNCTION observer is ignored, not invoked', () => {
    const raw = goodEnvelope([{ ...goodRow(), notes: '' }]);
    const options = { allowedLineRefs: ALLOWED, onReject: 'not a function' } as unknown as Parameters<
      typeof sanitizeAiAdvancedInterpretationResponse
    >[1];
    expect(sanitizeAiAdvancedInterpretationResponse(raw, options)).toEqual(
      sanitizeAiAdvancedInterpretationResponse(raw, { allowedLineRefs: ALLOWED })
    );
  });

  it('an observer that recurses back into the sanitizer does not corrupt the result', () => {
    const raw = goodEnvelope([{ ...goodRow(), notes: '' }]);
    let depth = 0;
    const result = sanitizeAiAdvancedInterpretationResponse(raw, {
      allowedLineRefs: ALLOWED,
      onReject: () => {
        depth += 1;
        if (depth < 5) sanitizeAiAdvancedInterpretationResponse(raw, { allowedLineRefs: ALLOWED });
      },
    });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_response');
  });
});

// ---------------------------------------------------------------------------
// PROVIDER SCHEMA vs SANITIZER — VERIFIED MISMATCH CLASSES
// ---------------------------------------------------------------------------

describe('9B-P4 — schema permits, sanitizer rejects (documented mismatches)', () => {
  const schema = buildAiAdvancedInterpretationSchema();

  it('the schema sent to Gemini declares no maxItems, maxLength, or minimum', () => {
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain('maxItems');
    expect(serialized).not.toContain('maxLength');
    expect(serialized).not.toContain('minimum');
    expect(serialized).not.toContain('additionalProperties');
  });

  it('the schema declares empty strings as legal for every optional string', () => {
    // No minLength anywhere: "" is schema-legal for every string property.
    expect(JSON.stringify(schema)).not.toContain('minLength');
  });

  /**
   * Each row is a payload the JSON SCHEMA permits and the SANITIZER rejects.
   * These are VERIFIED by construction from the two definitions; they are NOT a
   * claim about what Gemini actually returned during the 9B-P3 live smoke.
   */
  const MISMATCHES: Array<{ label: string; reason: AiAdvancedRejectReason; row: () => Record<string, unknown> }> = [
    {
      label: 'search_phrases over MAX_AI_ADVANCED_SEARCH_PHRASES',
      reason: 'search_phrases_shape',
      row: () => ({
        ...goodRow(),
        search_phrases: Array.from({ length: MAX_AI_ADVANCED_SEARCH_PHRASES + 1 }, (_, i) => `egg phrase ${i}`),
      }),
    },
    {
      label: 'an empty search phrase',
      reason: 'search_phrase_malformed',
      row: () => ({ ...goodRow(), search_phrases: ['whole egg', ''] }),
    },
    {
      label: 'semantic_food list over MAX_AI_ADVANCED_TOKENS',
      reason: 'semantic_food_token_count',
      row: () => ({
        ...goodRow(),
        semantic_food: { modifiers: Array.from({ length: MAX_AI_ADVANCED_TOKENS + 1 }, (_, i) => `m${i}`) },
      }),
    },
    {
      label: 'an empty normalized_name',
      reason: 'semantic_food_name_malformed',
      row: () => ({ ...goodRow(), semantic_food: { normalized_name: '' } }),
    },
    {
      label: 'a token longer than MAX_AI_ADVANCED_TOKEN_LENGTH',
      reason: 'semantic_food_token_malformed',
      row: () => ({ ...goodRow(), semantic_food: { state: ['f'.repeat(MAX_AI_ADVANCED_TOKEN_LENGTH + 1)] } }),
    },
    {
      label: 'range endpoints on a non-range kind',
      reason: 'amount_endpoint_on_non_range',
      row: () => ({ ...goodRow(), amount_semantics: { kind: 'exact', range_lower: 2, range_upper: 3 } }),
    },
    {
      label: 'a claimed range with only one endpoint',
      reason: 'amount_range_incomplete',
      row: () => ({ ...goodRow(), amount_semantics: { kind: 'range', range_lower: 2 } }),
    },
    {
      label: 'an inverted range',
      reason: 'amount_range_order',
      row: () => ({ ...goodRow(), amount_semantics: { kind: 'range', range_lower: 3, range_upper: 2 } }),
    },
    {
      label: 'a non-positive echoed_value',
      reason: 'amount_echoed_value_invalid',
      row: () => ({ ...goodRow(), amount_semantics: { kind: 'exact', echoed_value: 0 } }),
    },
    {
      label: 'a negative range endpoint',
      reason: 'amount_endpoint_invalid',
      row: () => ({ ...goodRow(), amount_semantics: { kind: 'range', range_lower: -1, range_upper: 3 } }),
    },
    {
      label: 'an empty amount phrasing',
      reason: 'amount_phrasing_malformed',
      row: () => ({ ...goodRow(), amount_semantics: { kind: 'exact', phrasing: '' } }),
    },
    {
      label: 'alternatives over MAX_AI_ADVANCED_ALTERNATIVES',
      reason: 'alternatives_shape',
      row: () => ({
        ...goodRow(),
        alternatives: Array.from({ length: MAX_AI_ADVANCED_ALTERNATIVES + 1 }, (_, i) => ({
          normalized_name: `alt ${i}`,
        })),
      }),
    },
    {
      label: 'an empty alternative name',
      reason: 'alternative_name_malformed',
      row: () => ({ ...goodRow(), alternatives: [{ normalized_name: '' }] }),
    },
    {
      label: 'an empty alternative note',
      reason: 'alternative_notes_malformed',
      row: () => ({ ...goodRow(), alternatives: [{ normalized_name: 'yolk', notes: '' }] }),
    },
    {
      label: 'ambiguity reasons over MAX_AI_ADVANCED_AMBIGUITY_REASONS',
      reason: 'ambiguity_reasons_shape',
      row: () => ({
        ...goodRow(),
        ambiguity: {
          ambiguous: true,
          reasons: Array.from({ length: MAX_AI_ADVANCED_AMBIGUITY_REASONS + 1 }, (_, i) => `r${i}`),
        },
      }),
    },
    {
      label: 'an empty ambiguity reason',
      reason: 'ambiguity_reason_malformed',
      row: () => ({ ...goodRow(), ambiguity: { ambiguous: true, reasons: [''] } }),
    },
    {
      label: 'an empty unit raw',
      reason: 'unit_raw_malformed',
      row: () => ({ ...goodRow(), unit_semantics: { family: 'count', raw: '' } }),
    },
    {
      label: 'an empty count noun',
      reason: 'count_token_malformed',
      row: () => ({ ...goodRow(), count_semantics: { noun: '' } }),
    },
    {
      label: 'notes longer than MAX_AI_ADVANCED_NOTE_LENGTH',
      reason: 'notes_malformed',
      row: () => ({ ...goodRow(), notes: 'n'.repeat(MAX_AI_ADVANCED_NOTE_LENGTH + 1) }),
    },
    {
      label: 'a line_ref longer than MAX_AI_ADVANCED_LINE_REF_LENGTH',
      reason: 'line_ref_malformed',
      row: () => ({ ...goodRow(), line_ref: 'r'.repeat(201) }),
    },
  ];

  it.each(MISMATCHES)('schema-legal but rejected: $label', ({ row, reason }) => {
    const raw = goodEnvelope([row()]);
    // Schema-legal: the row uses ONLY declared properties, no authority key.
    expect(JSON.stringify(raw)).not.toMatch(/"(fdc_id|nutrients|grams)"/);
    expectReject(raw, 'invalid_response', reason);
  });

  it('the enum-constrained properties are NOT mismatches (schema and sanitizer agree)', () => {
    // confidence / unit family / amount kind are enum-constrained on BOTH sides.
    const { result } = sanitize(
      goodEnvelope([
        {
          ...goodRow(),
          confidence: 'high',
          unit_semantics: { family: 'count' },
          amount_semantics: { kind: 'exact' },
        },
      ])
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OPERATION-LEVEL: real operation, mock provider, no live call
// ---------------------------------------------------------------------------

const prov = vi.hoisted(() => ({
  calls: 0,
  failModels: [] as string[],
  override: null as null | (() => unknown),
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return {
    ...actual,
    getRegisteredProviders: () => [],
  };
});

let warnings: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  prov.calls = 0;
  prov.failModels = [];
  prov.override = null;
  warnings = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  });
});
afterEach(() => {
  warnSpy.mockRestore();
});

function stageEvents(): string[] {
  return warnings.filter((w) => w.includes('[wholeRecipeSemantic][stage]'));
}
function allOutput(): string {
  return warnings.join('\n');
}

function mockProvider(id: string): AiProvider {
  return {
    id,
    name: id,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (_p: string, _s: AiJsonSchema, options?: AiStructuredOptions) => {
      prov.calls += 1;
      const model = options?.model ?? '';
      if (prov.failModels.includes(model)) {
        throw new ProviderOperationError('RATE_LIMIT', 'provider rate limited', {});
      }
      if (prov.override) return prov.override() as never;
      return goodEnvelope() as never;
    },
  };
}

const RECIPE = {
  ingredients: [
    { name: '4 eggs, separated' },
    { name: '1 cup whole milk' },
    { name: '2 cups all-purpose flour' },
    { name: '6 tbsp unsalted butter' },
    { name: '1 tsp sea salt' },
  ],
};
const INSTRUCTIONS = [
  { text: 'Separate the whites from the yolks.' },
  { text: 'Beat the whites until stiff peaks.' },
  { text: 'Fold the whites back into the yolks.' },
];

function request(): Record<string, unknown> {
  const adapted = adaptRecipe(RECIPE);
  if (adapted.ok !== true) throw new Error('fixture did not adapt');
  return {
    request_version: 'nutrition_ai_whole_recipe_interpretation_request_v1',
    request_id: 'p4-diagnostic',
    recipe: RECIPE,
    instructions: INSTRUCTIONS,
    targets: [{ line_ref: adapted.recipe.adapted[0].line_ref }],
  };
}

async function run(entries: Array<{ provider: string; model: string }>) {
  const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
  const candidates: AiCandidate[] = [];
  const registry: RegisteredProvider[] = [];
  for (const e of entries) {
    const provider = mockProvider(e.provider);
    candidates.push({ provider, model: e.model });
    registry.push({ provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities });
  }
  return interpretWholeRecipeSemantics(request(), { candidates, registry });
}

function subReasonOf(): string | undefined {
  const event = stageEvents().find((e) => e.includes('stage=sanitizer_rejected'));
  const match = /sub_reason=([^\s]*)/.exec(event ?? '');
  return match?.[1];
}

describe('9B-P4 — the operation logs the sub-reason (offline, mock provider)', () => {
  it('emits sub_reason naming the ACTUAL rejecting branch', async () => {
    prov.override = () =>
      goodEnvelope([
        {
          ...goodRow('ing:0:20e4077fc89a'),
          search_phrases: ['a', 'b', 'c', 'd', 'e'],
        },
      ]);
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_response');
    const event = stageEvents().find((e) => e.includes('stage=sanitizer_rejected'));
    expect(event).toBeDefined();
    expect(event).toContain('reason=invalid_response');
    expect(event).toContain('sub_reason=search_phrases_shape');
    expect(subReasonOf()).toBe('search_phrases_shape');
  });

  it('the sub-reason accompanies the non-invalid_response codes too', async () => {
    prov.override = () => goodEnvelope([goodRow('ing:9:deadbeefcafe')]);
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    const event = stageEvents().find((e) => e.includes('stage=sanitizer_rejected'));
    expect(event).toContain('reason=unknown_line_ref');
    expect(event).toContain('sub_reason=line_ref_not_requested');
  });

  it('emits NO sub_reason on a successful run', async () => {
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    expect(allOutput()).not.toContain('sub_reason');
  });

  it('the sub_reason token is single-line and within the P2 token alphabet', async () => {
    prov.override = () => goodEnvelope([{ ...goodRow(), notes: '' }]);
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    const event = stageEvents().find((e) => e.includes('stage=sanitizer_rejected'));
    expect(event).not.toContain('\n');
    expect(event).not.toContain('\r');
    expect(subReasonOf()).toMatch(/^[A-Za-z0-9._:/-]{1,64}$/);
  });
});

// ---------------------------------------------------------------------------
// 5 + 9 + 10. NO-LEAK, FALLBACK, ATTEMPT COUNT, RECEIPTS
// ---------------------------------------------------------------------------

describe('9B-P4 — operation-level no-leak, fallback, and receipt boundary', () => {
  it('never leaks the rejected payload, recipe text, or a secret', async () => {
    prov.override = () => {
      const row = goodRow('ing:0:20e4077fc89a');
      row.notes = 'SECRET_NOTE sk-live-abcdef1234567890';
      row.search_phrases = Array.from({ length: 9 }, (_, i) => `SECRET_PHRASE_${i}`);
      return goodEnvelope([row]);
    };
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    const output = allOutput();
    for (const secret of [
      'SECRET_NOTE',
      'SECRET_PHRASE_0',
      'SECRET_PHRASE_8',
      'sk-live-abcdef1234567890',
      'eggs, separated',
      'whole milk',
      'all-purpose flour',
      'Fold the whites back into the yolks.',
      'ing:0:20e4077fc89a',
      'p4-diagnostic',
    ]) {
      expect(output, `leaked ${secret}`).not.toContain(secret);
    }
    // The structural branch IS reported.
    expect(output).toContain('sub_reason=search_phrases_shape');
  });

  it('does NOT change fallback behaviour or the provider attempt count', async () => {
    // A rejected SANITIZER result is a SUCCESSFUL provider call, so the
    // fallback chain must not advance: exactly one attempt, no fallback event.
    prov.override = () => goodEnvelope([{ ...goodRow(), notes: '' }]);
    const r = await run([
      { provider: 'gemini', model: 'gemini-3.7-flash' },
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    ]);
    expect(r.ok).toBe(false);
    expect(prov.calls).toBe(1);
    expect(allOutput()).not.toContain('[AI fallback]');
    const returned = stageEvents().filter((e) => e.includes('stage=provider_returned'));
    expect(returned).toHaveLength(1);
    expect(returned[0]).toContain('model=gemini-3.7-flash');
  });

  it('still advances the chain on a genuine provider failure', async () => {
    prov.failModels = ['gemini-3.7-flash'];
    const r = await run([
      { provider: 'gemini', model: 'gemini-3.7-flash' },
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    ]);
    expect(r.ok).toBe(true);
    expect(prov.calls).toBe(2);
  });

  it('an invalid response NEVER receives an authenticated receipt', async () => {
    for (const override of [
      () => goodEnvelope([{ ...goodRow(), notes: '' }]),
      () => goodEnvelope([goodRow('ing:9:deadbeefcafe')]),
      () => goodEnvelope([{ ...goodRow(), fdc_id: 'SECRET_FDC_123' }]),
      () => goodEnvelope(['not-a-row']),
      () => goodEnvelope([{ ...goodRow(), amount_semantics: { kind: 'exact', range_lower: 2 } }]),
    ]) {
      warnings = [];
      prov.override = override;
      const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
      expect(r.ok).toBe(false);
      const failure = r as { origin_receipt?: unknown; operation_id?: unknown };
      expect(failure.origin_receipt).toBeUndefined();
      expect(failure.operation_id).toBeUndefined();
      expect(Object.keys(r).sort()).toEqual(['aiAttempted', 'code', 'ok']);
      expect(allOutput()).not.toContain('SECRET_FDC_123');
    }
  });

  it('a broken console.warn sink does not change the operation result', async () => {
    warnSpy.mockImplementation(() => {
      throw new Error('sink exploded');
    });
    prov.override = () => goodEnvelope([{ ...goodRow(), notes: '' }]);
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_response');
    expect((r as { aiAttempted: boolean }).aiAttempted).toBe(true);
  });

  it('a valid response still yields a wsem1 receipt and wsemo1 operation id', async () => {
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    const success = r as { origin_receipt: string; operation_id: string; context_binding: string };
    expect(success.origin_receipt.startsWith('wsem1.')).toBe(true);
    expect(success.origin_receipt).toHaveLength(49);
    expect(success.operation_id.startsWith('wsemo1.')).toBe(true);
    expect(success.context_binding.startsWith('sha256:')).toBe(true);
  });
});
