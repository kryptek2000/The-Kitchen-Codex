/**
 * The Kitchen Codex — AI-2B planning target (SEMANTIC TARGET BINDING REPAIR).
 *
 * Proves the repaired planner is no longer semantically blind:
 *   - a target carries the bounded semantic description of WHAT the candidates are
 *     compared against, built either from authored wording alone or from a
 *     sanitized AI-1 interpretation (both supported, neither decided here);
 *   - the target is bounded by the canonical AI-1 limits and FAILS CLOSED rather
 *     than truncating;
 *   - the target carries NO authority: no FDC id, digest, grams, nutrient, portion,
 *     confidence, Apply or persistence field can appear at any depth;
 *   - target coverage of a request must be EXACT (one per line, no duplicates, no
 *     unknown line refs), and the canonical order is deterministic.
 */

import { describe, it, expect } from 'vitest';

import {
  AI_ADVANCED_PLAN_TARGET_BINDING_KEYS,
  AI_ADVANCED_PLAN_TARGET_KEYS,
  AI_ADVANCED_PLAN_TARGET_SEMANTIC_KEYS,
  AI_ADVANCED_PLAN_TARGET_VERSION,
  buildAiAdvancedPlanTarget,
  buildAiAdvancedPlanTargetBinding,
  buildAiAdvancedPlanTargets,
  readAiAdvancedPlanTarget,
  readAiAdvancedPlanTargetBinding,
  sanitizeAiAdvancedPlanTargets,
} from '../../src/core/nutritionV2/aiAdvancedPlanTarget';
import { MAX_AI_ADVANCED_FINGERPRINT_LENGTH } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import {
  MAX_AI_ADVANCED_ALTERNATIVES,
  MAX_AI_ADVANCED_AMBIGUITY_REASONS,
  MAX_AI_ADVANCED_DOCUMENT_TEXT,
  MAX_AI_ADVANCED_NAME_LENGTH,
  MAX_AI_ADVANCED_SEARCH_PHRASES,
  MAX_AI_ADVANCED_TOKENS,
  MAX_AI_ADVANCED_TOKEN_LENGTH,
} from '../../src/core/nutritionV2/aiAdvanced';
import {
  AI_ADVANCED_CONTRACT_VERSION,
  sanitizeAiAdvancedInterpretationResponse,
} from '../../src/core/nutritionV2/aiAdvanced';

/** A sanitized-looking AI-1 interpretation for the line. */
function interpretation(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: 'heavy cream',
    semantic_food: {
      normalized_name: 'cream, heavy',
      modifiers: ['heavy'],
      preparation: [],
      state: ['fluid'],
      qualifiers: [],
    },
    search_phrases: ['heavy cream', 'cream heavy whipping'],
    amount_semantics: { kind: 'exact', echoed_value: 1 },
    unit_semantics: { family: 'volume', interpreted_unit: 'cup' },
    count_semantics: {},
    alternatives: [{ normalized_name: 'whipping cream', notes: 'same food, different name' }],
    ambiguity: { ambiguous: false, reasons: [] },
    confidence: 'high',
    ...overrides,
  };
}

describe('AI-2B planning target — construction', () => {
  it('builds an authored-wording target with no semantics at all', () => {
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.target).toEqual({ line_ref: 'heavy cream', source_text: '1 cup heavy cream' });
    expect(Object.isFrozen(built.target)).toBe(true);
    expect(AI_ADVANCED_PLAN_TARGET_VERSION).toBe('nutrition_ai_advanced_plan_target_v1');
  });

  it('builds an AI-1-backed target carrying ONLY the canonical semantic subset', () => {
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation(),
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    const target = built.target;
    // The amount/unit/count/confidence authority of the interpretation is NOT part
    // of a planning target: it is a semantic description, not a quantity.
    expect(Object.keys(target).sort()).toEqual([...AI_ADVANCED_PLAN_TARGET_KEYS].sort());
    expect(JSON.stringify(target)).not.toContain('amount_semantics');
    expect(JSON.stringify(target)).not.toContain('unit_semantics');
    expect(JSON.stringify(target)).not.toContain('count_semantics');
    expect(JSON.stringify(target)).not.toContain('confidence');
    expect(JSON.stringify(target)).not.toContain('echoed_value');
    expect(target.semantic_food?.normalized_name).toBe('cream, heavy');
    expect(target.semantic_food?.modifiers).toEqual(['heavy']);
    expect(target.search_phrases).toEqual(['heavy cream', 'cream heavy whipping']);
    expect(target.alternatives?.[0]).toEqual({
      normalized_name: 'whipping cream',
      notes: 'same food, different name',
    });
    expect(target.ambiguity).toEqual({ ambiguous: false, reasons: [] });
    expect(Object.isFrozen(target.semantic_food)).toBe(true);
    expect(Object.isFrozen(target.semantic_food?.modifiers)).toBe(true);
  });

  it('keeps an EMPTY semantic husk out of the target but keeps real semantics', () => {
    const husk = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation({
        semantic_food: { modifiers: [], preparation: [], state: [], qualifiers: [] },
      }),
    });
    expect(husk.ok).toBe(true);
    if (husk.ok !== true) return;
    expect(husk.target.semantic_food).toBeUndefined();
    expect(husk.target.source_text).toBe('1 cup heavy cream');

    const nameOnly = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation({
        semantic_food: { normalized_name: 'cream', modifiers: [], preparation: [], state: [], qualifiers: [] },
      }),
    });
    expect(nameOnly.ok).toBe(true);
    if (nameOnly.ok !== true) return;
    expect(nameOnly.target.semantic_food?.normalized_name).toBe('cream');
  });

  it('captures ambiguity so the model can decline instead of guessing', () => {
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'cream',
      sourceText: '1 cup cream',
      interpretation: interpretation({
        line_ref: 'cream',
        semantic_food: { normalized_name: 'cream', modifiers: [], preparation: [], state: [], qualifiers: [] },
        ambiguity: { ambiguous: true, reasons: ['could be heavy cream, cream cheese or sour cream'] },
      }),
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.target.ambiguity).toEqual({
      ambiguous: true,
      reasons: ['could be heavy cream, cream cheese or sour cream'],
    });
  });
});

describe('AI-2B planning target — bounds fail closed (never truncate)', () => {
  const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['oversized source text', { sourceText: 'x'.repeat(MAX_AI_ADVANCED_DOCUMENT_TEXT + 1) }],
    ['empty source text', { sourceText: '   ' }],
    ['oversized line ref', { lineRef: 'l'.repeat(201) }],
    ['too many modifiers', { interpretation: interpretation({ semantic_food: { modifiers: Array.from({ length: MAX_AI_ADVANCED_TOKENS + 1 }, () => 'm') } }) }],
    ['oversized modifier token', { interpretation: interpretation({ semantic_food: { modifiers: ['m'.repeat(MAX_AI_ADVANCED_TOKEN_LENGTH + 1)] } }) }],
    ['oversized normalized name', { interpretation: interpretation({ semantic_food: { normalized_name: 'n'.repeat(MAX_AI_ADVANCED_NAME_LENGTH + 1) } }) }],
    ['too many search phrases', { interpretation: interpretation({ search_phrases: Array.from({ length: MAX_AI_ADVANCED_SEARCH_PHRASES + 1 }, () => 'p') }) }],
    ['too many ambiguity reasons', { interpretation: interpretation({ ambiguity: { ambiguous: true, reasons: Array.from({ length: MAX_AI_ADVANCED_AMBIGUITY_REASONS + 1 }, () => 'r') } }) }],
    ['too many alternatives', { interpretation: interpretation({ alternatives: Array.from({ length: MAX_AI_ADVANCED_ALTERNATIVES + 1 }, () => ({ normalized_name: 'x' })) }) }],
    ['ambiguous flag missing', { interpretation: interpretation({ ambiguity: { reasons: [] } }) }],
    ['malformed semantic block', { interpretation: interpretation({ semantic_food: 'cream' }) }],
    ['malformed modifiers', { interpretation: interpretation({ semantic_food: { modifiers: 'heavy' } }) }],
  ];

  it.each(cases)('rejects %s', (_label, overrides) => {
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      ...overrides,
    });
    expect(built.ok).toBe(false);
  });

  it('rejects an interpretation for a DIFFERENT line ref', () => {
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation({ line_ref: 'cream cheese' }),
    });
    expect(built).toEqual({ ok: false, code: 'unusable_interpretation' });
  });

  it('rejects an interpretation carrying an unknown (or authority) key', () => {
    const withFdc = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: { ...interpretation(), fdc_id: 170054 },
    });
    expect(withFdc).toEqual({ ok: false, code: 'unusable_interpretation' });
    const withGrams = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: { ...interpretation(), grams: 240 },
    });
    expect(withGrams.ok).toBe(false);
  });
});

describe('AI-2B planning target — authority firewall', () => {
  it('rejects any authority field in a target at every level', () => {
    const authorityTargets: ReadonlyArray<Record<string, unknown>> = [
      { line_ref: 'a', source_text: 's', fdc_id: 1 },
      { line_ref: 'a', source_text: 's', record_digest: 'd' },
      { line_ref: 'a', source_text: 's', grams: 100 },
      { line_ref: 'a', source_text: 's', nutrients: { calories: 1 } },
      { line_ref: 'a', source_text: 's', portion_ref: 'p1' },
      { line_ref: 'a', source_text: 's', confidence: 'high' },
      { line_ref: 'a', source_text: 's', authorization: 'granted' },
      { line_ref: 'a', source_text: 's', apply: true },
      { line_ref: 'a', source_text: 's', semantic_food: { normalized_name: 'x', fdc_id: 1 } },
      { line_ref: 'a', source_text: 's', ambiguity: { ambiguous: false, reasons: [], grams: 1 } },
      { line_ref: 'a', source_text: 's', alternatives: [{ normalized_name: 'x', fdc_id: 1 }] },
    ];
    for (const entry of authorityTargets) {
      const read = readAiAdvancedPlanTarget(entry);
      expect({ entry: Object.keys(entry).join(','), ok: read.ok }).toEqual({
        entry: Object.keys(entry).join(','),
        ok: false,
      });
    }
    // The closed key sets are the reason: they contain no authority key at all.
    expect([...AI_ADVANCED_PLAN_TARGET_KEYS]).not.toContain('fdc_id');
    expect([...AI_ADVANCED_PLAN_TARGET_SEMANTIC_KEYS]).not.toContain('confidence');
  });

  it('a planning target cannot widen a candidate set or grant a selection', () => {
    // Targets carry no refs and no acceptance values whatsoever.
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation(),
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    const serialized = JSON.stringify(built.target);
    for (const forbidden of [
      'candidate_ref',
      'strict_automatic_fdc_id',
      'best_effort',
      'measure_kind',
      'portion_ref',
      'review_required',
    ]) {
      expect({ forbidden, present: serialized.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });
});

describe('AI-2B planning target — LOCAL interpretation fingerprint binding (closure 2)', () => {
  it('retains the AI-1 interpretation fingerprint beside the target, never inside it', () => {
    const built = buildAiAdvancedPlanTargetBinding({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation(),
      interpretationFingerprint: 'fp-heavy-cream-1',
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.binding.interpretation_fingerprint).toBe('fp-heavy-cream-1');
    expect(built.binding.target.semantic_food?.normalized_name).toBe('cream, heavy');
    // The binding is closed, and the fingerprint is NOT a target key: the transport
    // and the prompt (built from `target` alone) cannot carry it.
    expect(Object.keys(built.binding).sort()).toEqual([...AI_ADVANCED_PLAN_TARGET_BINDING_KEYS].sort());
    expect(Object.keys(built.binding.target)).not.toContain('interpretation_fingerprint');
    expect(JSON.stringify(built.binding.target)).not.toContain('fp-heavy-cream-1');
    expect(Object.isFrozen(built.binding)).toBe(true);
  });

  it('omits the fingerprint for an authored-wording target (nothing to bind)', () => {
    const authored = buildAiAdvancedPlanTargetBinding({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
    });
    expect(authored.ok).toBe(true);
    if (authored.ok !== true) return;
    expect(authored.binding).toEqual({
      target: { line_ref: 'heavy cream', source_text: '1 cup heavy cream' },
    });
    expect('interpretation_fingerprint' in authored.binding).toBe(false);
  });

  it('bounds the fingerprint and fails closed instead of truncating', () => {
    const oversize = buildAiAdvancedPlanTargetBinding({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretationFingerprint: 'f'.repeat(MAX_AI_ADVANCED_FINGERPRINT_LENGTH + 1),
    });
    expect(oversize).toEqual({ ok: false, code: 'invalid_fingerprint' });
    const blank = buildAiAdvancedPlanTargetBinding({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretationFingerprint: '   ',
    });
    expect(blank).toEqual({ ok: false, code: 'invalid_fingerprint' });
    // Exactly at the bound is accepted (no off-by-one).
    const atBound = buildAiAdvancedPlanTargetBinding({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretationFingerprint: 'f'.repeat(MAX_AI_ADVANCED_FINGERPRINT_LENGTH),
    });
    expect(atBound.ok).toBe(true);
  });

  it('never invents a fingerprint: it echoes a bound value or rejects', () => {
    // No fingerprint supplied, interpretation present → still omitted (AI-2B does not
    // compute fingerprints; AI-2A owns that value).
    const built = buildAiAdvancedPlanTargetBinding({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation(),
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.binding.interpretation_fingerprint).toBeUndefined();
  });

  it('carries the target-builder failures through unchanged', () => {
    expect(
      buildAiAdvancedPlanTargetBinding({ lineRef: 'a', sourceText: '' })
    ).toEqual({ ok: false, code: 'invalid_source_text' });
    expect(
      buildAiAdvancedPlanTargetBinding({
        lineRef: 'a',
        sourceText: 'salt',
        interpretation: interpretation({ line_ref: 'other' }),
      })
    ).toEqual({ ok: false, code: 'unusable_interpretation' });
  });

  it('reads a binding strictly: closed keys, canonical target, bounded fingerprint', () => {
    const roundTrip = readAiAdvancedPlanTargetBinding({
      target: { line_ref: 'heavy cream', source_text: '1 cup heavy cream' },
      interpretation_fingerprint: 'fp-1',
    });
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok !== true) return;
    expect(roundTrip.binding.interpretation_fingerprint).toBe('fp-1');
    expect(Object.isFrozen(roundTrip.binding)).toBe(true);

    // No authority field, at binding level or nested in the target.
    for (const bad of [
      { target: { line_ref: 'a', source_text: 'salt' }, fdc_id: 1 },
      { target: { line_ref: 'a', source_text: 'salt', grams: 1 } },
      { target: { line_ref: 'a', source_text: 'salt' }, interpretation_fingerprint: 'x'.repeat(201) },
      { target: { line_ref: 'a', source_text: 'salt' }, interpretation_fingerprint: '  ' },
      { target: 'not a target' },
      { target: { line_ref: 'a', source_text: 'salt' }, confidence: 'high' },
      { target: { line_ref: 'a', source_text: 'salt' }, apply: true },
      'nope',
    ]) {
      expect({ bad: JSON.stringify(bad), ok: readAiAdvancedPlanTargetBinding(bad).ok }).toEqual({
        bad: JSON.stringify(bad),
        ok: false,
      });
    }
    expect(readAiAdvancedPlanTargetBinding({ target: { line_ref: 'a', source_text: 'salt' } }).ok).toBe(
      true
    );
  });
});

describe('AI-2B planning target — request coverage', () => {
  const target = (lineRef: string) =>
    ({ line_ref: lineRef, source_text: `wording for ${lineRef}` }) as never;

  it('accepts exactly one target per requested line and orders them canonically', () => {
    const result = sanitizeAiAdvancedPlanTargets(
      [target('second'), target('first')],
      ['first', 'second']
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.targets.map((entry) => entry.line_ref)).toEqual(['first', 'second']);
    expect(Object.isFrozen(result.targets)).toBe(true);
  });

  it('rejects missing, duplicated, and unknown-line targets', () => {
    expect(sanitizeAiAdvancedPlanTargets([], ['first'])).toEqual({
      ok: false,
      code: 'missing_target',
    });
    expect(sanitizeAiAdvancedPlanTargets([target('first')], ['first', 'second'])).toEqual({
      ok: false,
      code: 'missing_target',
    });
    expect(sanitizeAiAdvancedPlanTargets([target('first'), target('first')], ['first'])).toEqual({
      ok: false,
      code: 'duplicate_target',
    });
    expect(sanitizeAiAdvancedPlanTargets([target('first'), target('other')], ['first'])).toEqual({
      ok: false,
      code: 'unknown_target_line_ref',
    });
    expect(sanitizeAiAdvancedPlanTargets('nope', ['first'])).toEqual({
      ok: false,
      code: 'missing_target',
    });
  });

  it('builds many targets and rejects duplicates or malformed rows', () => {
    const built = buildAiAdvancedPlanTargets([
      { lineRef: 'a', sourceText: 'one' },
      { lineRef: 'b', sourceText: 'two', interpretation: interpretation({ line_ref: 'b' }) },
    ]);
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.targets.map((entry) => entry.line_ref)).toEqual(['a', 'b']);
    expect(built.targets[1]?.semantic_food?.normalized_name).toBe('cream, heavy');

    expect(buildAiAdvancedPlanTargets([])).toEqual({ ok: false, code: 'missing_target' });
    expect(
      buildAiAdvancedPlanTargets([
        { lineRef: 'a', sourceText: 'one' },
        { lineRef: 'a', sourceText: 'again' },
      ])
    ).toEqual({ ok: false, code: 'duplicate_target' });
    expect(buildAiAdvancedPlanTargets([{ lineRef: 'a', sourceText: 'one', extra: 1 }])).toEqual({
      ok: false,
      code: 'unknown_target_key',
    });
    expect(buildAiAdvancedPlanTargets([{ lineRef: '', sourceText: 'one' }])).toEqual({
      ok: false,
      code: 'invalid_line_ref',
    });
  });
});

describe('AI-2B planning target — LAYER B: canonical coverage is a duplicate-line backstop', () => {
  // HONEST ACCOUNTING: the server's early duplicate-line guard (LAYER A) is not the only
  // thing that refuses a duplicated line. Coverage (LAYER B) derives its expectations from
  // the SAME line list, so a repeated line ref can never be satisfied: one target cannot
  // cover an expectation list that names the ref twice. These are NON-MUTATING proofs of
  // that second layer, independent of any mutation row.
  const target = { line_ref: 'line-0', source_text: '1 cup food 0' } as never;

  it('rejects a duplicated EXPECTED line ref (one target cannot cover it twice) — `missing_target`', () => {
    const result = sanitizeAiAdvancedPlanTargets([target], ['line-0', 'line-0']);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('missing_target');
  });

  it('rejects two targets claiming the same line ref — `duplicate_target`', () => {
    const result = sanitizeAiAdvancedPlanTargets([target, target], ['line-0']);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('duplicate_target');
  });

  it('rejects a target for an unrequested line ref — `unknown_target_line_ref`', () => {
    // Every expected ref IS covered, and a surplus target names a line that was not
    // requested: the surplus is what coverage refuses.
    const result = sanitizeAiAdvancedPlanTargets(
      [target, { line_ref: 'line-1', source_text: '1 cup food 1' } as never],
      ['line-0']
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe('unknown_target_line_ref');
  });

  it('CONTROL: one target per DISTINCT line ref is accepted (the layer is not a blanket refusal)', () => {
    const result = sanitizeAiAdvancedPlanTargets([target], ['line-0']);
    expect(result.ok).toBe(true);
  });
});

describe('AI-2B planning target — CLOSURE 4 canonical AI-1 re-sanitization', () => {
  const canonical = (raw: unknown) =>
    sanitizeAiAdvancedInterpretationResponse(
      { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: [raw] },
      { allowedLineRefs: ['heavy cream'] }
    );

  it('CONTROL: the canonical AI-1 sanitizer accepts a canonical interpretation (gate is real, not vacuous)', () => {
    const accepted = canonical(interpretation());
    expect(accepted.ok).toBe(true);
    // …and the projection happens only after that acceptance.
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation(),
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.target.semantic_food?.normalized_name).toBe('cream, heavy');
  });

  it('REJECTS interpretations that duck typing would happily project but canonical AI-1 sanitization refuses', () => {
    const semanticFood = interpretation().semantic_food as Record<string, unknown>;
    const cases: ReadonlyArray<{ readonly why: string; readonly raw: Record<string, unknown> }> = [
      {
        why: 'carries a database identity next to usable semantics',
        raw: { ...interpretation(), fdc_id: 170054 },
      },
      {
        why: 'declares a contract version outside the AI-1 contract',
        raw: { ...interpretation(), contract_version: 'nutrition_ai_advanced_interpretation_v999' },
      },
      {
        why: 'has a malformed semantic block (modifiers is a string, not a list)',
        raw: { ...interpretation(), semantic_food: { ...semanticFood, modifiers: 'heavy' } },
      },
    ];
    for (const { why, raw } of cases) {
      // (a) The CANONICAL AI-1 sanitizer refuses it — this is the real gate, not a
      // home-made shape check that could drift from the frozen contract.
      expect({ why, canonical: canonical(raw).ok }).toEqual({ why, canonical: false });
      // (b) …so the target builder refuses it too, and projects nothing.
      const built = buildAiAdvancedPlanTarget({
        lineRef: 'heavy cream',
        sourceText: '1 cup heavy cream',
        interpretation: raw,
      });
      expect({ why, ok: built.ok }).toEqual({ why, ok: false });
      if (built.ok === false) expect(built.code).toBe('unusable_interpretation');
    }
  });

  it('projects ONLY the semantic subset — never amount/unit/count semantics or confidence', () => {
    const built = buildAiAdvancedPlanTarget({
      lineRef: 'heavy cream',
      sourceText: '1 cup heavy cream',
      interpretation: interpretation(),
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    const projected = JSON.stringify(built.target);
    for (const forbidden of [
      'amount_semantics',
      'unit_semantics',
      'count_semantics',
      'echoed_value',
      'interpreted_unit',
      'confidence',
    ]) {
      expect({ forbidden, present: projected.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});
