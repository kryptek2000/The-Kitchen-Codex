/**
 * AN-SEM-1 — semantic contract classification fixtures.
 *
 * PURE/offline. These prove the boundary between usable semantic content,
 * explicitly declared non-resolution, insufficient semantic information, and
 * source-contradicted quantities. No provider is called.
 */
import { describe, it, expect } from 'vitest';

import {
  AI_ADVANCED_CONTRACT_VERSION,
  adaptAiAdvancedInterpretationsForResolution,
  hasExplicitAiAdvancedNonResolution,
  hasUsableAiAdvancedSemanticContent,
  sanitizeAiAdvancedInterpretationResponse,
  withholdNonDeterministicAdaptations,
  type AiAdvancedIngredientInterpretation,
} from '../../src/core/nutritionV2/aiAdvanced';

const LINE = 'ing:0:sem1';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: LINE,
    ...overrides,
  };
}

function sanitizeOne(raw: Record<string, unknown>): AiAdvancedIngredientInterpretation {
  const result = sanitizeAiAdvancedInterpretationResponse(
    { contract_version: AI_ADVANCED_CONTRACT_VERSION, interpretations: [raw] },
    { allowedLineRefs: [LINE] }
  );
  if (!result.ok) throw new Error(`unexpected sanitizer rejection: ${(result as { code?: string }).code ?? 'unknown'}`);
  const interpretation = result.interpretations[0];
  if (!interpretation) throw new Error('missing interpretation');
  return interpretation;
}

describe('AN-SEM-1 — semantic content classification', () => {
  it('accepts a nonempty normalized food identity as usable', () => {
    const interpretation = sanitizeOne(row({ semantic_food: { normalized_name: 'half and half' } }));
    expect(hasUsableAiAdvancedSemanticContent(interpretation)).toBe(true);
    expect(hasExplicitAiAdvancedNonResolution(interpretation)).toBe(false);
  });

  it('accepts a nonempty search phrase as usable without a normalized name', () => {
    const interpretation = sanitizeOne(row({ search_phrases: ['half and half'] }));
    expect(interpretation.semantic_food.normalized_name).toBeUndefined();
    expect(hasUsableAiAdvancedSemanticContent(interpretation)).toBe(true);
  });

  it('classifies explicit ambiguity as meaningful non-resolution and withholds its suggestion', () => {
    const interpretation = sanitizeOne(
      row({
        semantic_food: { normalized_name: 'cream' },
        search_phrases: ['cream'],
        ambiguity: { ambiguous: true, reasons: ['half and half or light cream'] },
      })
    );
    expect(hasExplicitAiAdvancedNonResolution(interpretation)).toBe(true);
    const adapted = adaptAiAdvancedInterpretationsForResolution({ interpretations: [interpretation] });
    const eligible = withholdNonDeterministicAdaptations({ interpretations: [interpretation], outcome: adapted });
    expect(eligible.suggestions).toHaveLength(0);
    expect(eligible.withheld).toEqual([{ line_ref: LINE, reason: 'ambiguous' }]);
  });

  it('classifies explicit alternatives as meaningful non-resolution and withholds its suggestion', () => {
    const interpretation = sanitizeOne(
      row({
        semantic_food: { normalized_name: 'tomato puree' },
        search_phrases: ['tomato puree'],
        alternatives: [{ normalized_name: 'tomato passata' }],
      })
    );
    expect(hasExplicitAiAdvancedNonResolution(interpretation)).toBe(true);
    const adapted = adaptAiAdvancedInterpretationsForResolution({ interpretations: [interpretation] });
    const eligible = withholdNonDeterministicAdaptations({ interpretations: [interpretation], outcome: adapted });
    expect(eligible.suggestions).toHaveLength(0);
    expect(eligible.withheld).toEqual([{ line_ref: LINE, reason: 'alternatives' }]);
  });

  it('classifies a structurally valid but semantically empty row as inadaptable', () => {
    const interpretation = sanitizeOne(row());
    expect(hasUsableAiAdvancedSemanticContent(interpretation)).toBe(false);
    expect(hasExplicitAiAdvancedNonResolution(interpretation)).toBe(false);
    const adapted = adaptAiAdvancedInterpretationsForResolution({ interpretations: [interpretation] });
    expect(adapted.suggestions).toHaveLength(0);
    expect(adapted.inadaptable).toEqual([LINE]);
    expect(adapted.contradicted).toHaveLength(0);
  });

  it('classifies a source-contradicted quantity and never creates a suggestion', () => {
    const interpretation = sanitizeOne(
      row({
        semantic_food: { normalized_name: 'half and half' },
        search_phrases: ['half and half'],
        amount_semantics: { kind: 'exact', echoed_value: 99 },
      })
    );
    const adapted = adaptAiAdvancedInterpretationsForResolution({
      interpretations: [interpretation],
      authoritativeByLineRef: new Map([
        [
          LINE,
          {
            quantity_kind: 'exact',
            amount: 1,
            measurement_kind: 'volume',
          },
        ],
      ]),
    });
    expect(adapted.suggestions).toHaveLength(0);
    expect(adapted.contradicted).toEqual([LINE]);
  });

  it('classifies two target rows independently: one usable, one insufficient', () => {
    const result = sanitizeAiAdvancedInterpretationResponse(
      {
        contract_version: AI_ADVANCED_CONTRACT_VERSION,
        interpretations: [
          row({ line_ref: 'ing:0:usable', semantic_food: { normalized_name: 'butter' } }),
          row({ line_ref: 'ing:1:empty' }),
        ],
      },
      { allowedLineRefs: ['ing:0:usable', 'ing:1:empty'] }
    );
    if (!result.ok) throw new Error('unexpected sanitizer rejection');
    const [usable, empty] = result.interpretations;
    if (!usable || !empty) throw new Error('missing interpretations');
    const adapted = adaptAiAdvancedInterpretationsForResolution({
      interpretations: [usable, empty],
    });
    expect(adapted.suggestions.map((entry) => entry.line_ref)).toEqual(['ing:0:usable']);
    expect(adapted.inadaptable).toEqual(['ing:1:empty']);
  });
});
