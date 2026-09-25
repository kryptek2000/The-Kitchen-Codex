/**
 * The Kitchen Codex — AI amount-interpretation contract security.
 *
 * Proves the extended AI resolver contract remains CLOSED: bounded advisory
 * fields only, no mass/nutrient/FDC/Apply authority, a trusted issue-kind enum,
 * and whole-response rejection for any forbidden/unknown field.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_AI_RESOLUTION_HINT_LENGTH,
  MAX_AI_RESOLUTION_NOTE_LENGTH,
  MAX_AI_RESOLUTION_PORTION_HINT_LENGTH,
  MAX_AI_RESOLUTION_QUANTITY,
  MAX_AI_RESOLUTION_QUERIES,
  buildAiResolutionRequestRows,
  buildAiResolutionSchema,
  sanitizeAiResolutionResponse,
} from '../../src/core/nutritionV2/aiResolution';
import { HOUSEHOLD_SIZE_CLASSES, HOUSEHOLD_STATES } from '../../src/core/nutritionV2/household/normalize';
import { householdCountNouns } from '../../src/utils/householdUnits';
import { sanitizeResolveRows, NUTRITION_RESOLVE_INSTRUCTIONS } from '../../server/nutritionResolve';

const ALLOWED = ['ing:0:aaa', 'ing:1:bbb'];

function envelope(suggestion: Record<string, unknown>) {
  return { version: 1, suggestions: [{ line_ref: 'ing:0:aaa', ...suggestion }] };
}

function sanitize(suggestion: Record<string, unknown>) {
  return sanitizeAiResolutionResponse(envelope(suggestion), { allowedLineRefs: ALLOWED });
}

const BASE = {
  interpreted_food_name: 'Garlic, raw',
  suggested_usda_queries: ['garlic raw'],
};

describe('AI amount contract — bounded advisory fields', () => {
  it('accepts the bounded interpretation fields', () => {
    const result = sanitize({
      ...BASE,
      normalized_food_query: 'garlic raw',
      preparation_hint: 'minced',
      quantity_value: 3,
      quantity_unit_hint: 'cloves',
      count_descriptor_hint: 'clove',
      portion_search_hint: 'clove',
      explanation: 'Three cloves, minced.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const suggestion = result.suggestions[0];
    expect(suggestion.quantity_value).toBe(3);
    expect(suggestion.count_descriptor_hint).toBe('clove');
    expect(suggestion.portion_search_hint).toBe('clove');
    expect(Object.isFrozen(suggestion)).toBe(true);
  });

  it('declares the bounded advisory fields in the provider schema', () => {
    const schema = buildAiResolutionSchema();
    const item = (schema.properties.suggestions as { items: { properties: Record<string, unknown> } }).items;
    expect(Object.keys(item.properties).sort()).toEqual([
      'confidence',
      'count_descriptor_hint',
      'explanation',
      'household_size_hint',
      'household_state_hint',
      'household_unit_hint',
      'interpreted_food_name',
      'line_ref',
      'normalized_food_query',
      'notes',
      'portion_search_hint',
      'preparation_hint',
      'quantity_unit_hint',
      'quantity_value',
      'suggested_usda_queries',
    ]);
  });
});

describe('AI amount contract — authority is impossible', () => {
  const FORBIDDEN: ReadonlyArray<Record<string, unknown>> = [
    { fdc_id: 169230 },
    { fdcId: 169230 },
    { source_food_id: '169230' },
    { grams: 9 },
    { mass_g: 9 },
    { mass: 9 },
    { calories: 100 },
    { nutrients: { calories: 1 } },
    { totals: { calories: 1 } },
    { source_release: 'usda_fdc_x' },
    { portion_index: 1 },
    { gram_weight: 3 },
    { record_digest: 'f'.repeat(64) },
    { catalog_digest: 'f'.repeat(64) },
    { apply_token: 'x' },
    { authorization: true },
  ];

  it('rejects every mass/nutrient/FDC/portion/digest/Apply field wholesale', () => {
    for (const extra of FORBIDDEN) {
      const result = sanitize({ ...BASE, ...extra });
      expect(result.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it('rejects a unit hint that smuggles numeric mass wording', () => {
    // The unit hint is a bounded string; numeric mass has its own forbidden key.
    expect(sanitize({ ...BASE, quantity_unit_hint: 3 }).ok).toBe(false);
    expect(sanitize({ ...BASE, count_descriptor_hint: { grams: 3 } }).ok).toBe(false);
  });
});

describe('AI amount contract — bounds and malformed values', () => {
  it('rejects oversized or malformed bounded strings', () => {
    expect(sanitize({ ...BASE, normalized_food_query: 'x'.repeat(500) }).ok).toBe(false);
    expect(sanitize({ ...BASE, preparation_hint: 'x'.repeat(MAX_AI_RESOLUTION_HINT_LENGTH + 1) }).ok).toBe(false);
    expect(sanitize({ ...BASE, quantity_unit_hint: 'x'.repeat(MAX_AI_RESOLUTION_HINT_LENGTH + 1) }).ok).toBe(false);
    expect(sanitize({ ...BASE, count_descriptor_hint: 'x'.repeat(MAX_AI_RESOLUTION_HINT_LENGTH + 1) }).ok).toBe(false);
    expect(
      sanitize({ ...BASE, portion_search_hint: 'x'.repeat(MAX_AI_RESOLUTION_PORTION_HINT_LENGTH + 1) }).ok
    ).toBe(false);
    expect(sanitize({ ...BASE, explanation: 'x'.repeat(MAX_AI_RESOLUTION_NOTE_LENGTH + 1) }).ok).toBe(false);
    expect(sanitize({ ...BASE, preparation_hint: '' }).ok).toBe(false);
  });

  it('rejects non-finite / non-positive / oversized quantity values', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_AI_RESOLUTION_QUANTITY + 1]) {
      expect(sanitize({ ...BASE, quantity_value: value }).ok, String(value)).toBe(false);
    }
    expect(sanitize({ ...BASE, quantity_value: '3' }).ok).toBe(false);
  });

  it('rejects an unknown suggestion key wholesale', () => {
    expect(sanitize({ ...BASE, unexpected: 'x' }).ok).toBe(false);
  });

  it('still bounds the query array', () => {
    expect(
      sanitize({
        ...BASE,
        suggested_usda_queries: Array.from({ length: MAX_AI_RESOLUTION_QUERIES + 1 }, (_, i) => `q${i}`),
      }).ok
    ).toBe(false);
  });
});

describe('AI amount contract — trusted issue kind', () => {
  it('accepts a bounded issue kind in the request and carries it to the resolver row', () => {
    const rows = buildAiResolutionRequestRows([
      { line_ref: 'ing:0:aaa', ingredient_text: '3 garlic cloves, minced', issue_kind: 'needs_amount' },
      { line_ref: 'ing:1:bbb', ingredient_text: '1 zucchini, chopped', issue_kind: 'review_suggested' },
    ]);
    expect(rows.map((row) => row.issue_kind)).toEqual(['needs_amount', 'review_suggested']);
  });

  it('never invents an issue kind (unknown values are omitted, not coerced)', () => {
    const rows = buildAiResolutionRequestRows([
      {
        line_ref: 'ing:0:aaa',
        ingredient_text: 'x',
        issue_kind: 'totally_made_up' as never,
      },
    ]);
    expect(rows[0].issue_kind).toBeUndefined();
  });

  it('server-side sanitization accepts valid issue kinds and rejects malformed ones', () => {
    expect(
      sanitizeResolveRows([
        { line_ref: 'a', ingredient_text: '3 garlic cloves', issue_kind: 'needs_amount' },
      ])?.[0].issue_kind
    ).toBe('needs_amount');
    expect(
      sanitizeResolveRows([{ line_ref: 'a', ingredient_text: 'x', issue_kind: 'needs_mass' }])
    ).toBeUndefined();
    expect(
      sanitizeResolveRows([{ line_ref: 'a', ingredient_text: 'x', issue_kind: 7 }])
    ).toBeUndefined();
  });

  it('server-side request rows remain closed against authority fields', () => {
    expect(
      sanitizeResolveRows([{ line_ref: 'a', ingredient_text: 'x', count_descriptor_hint: 'clove' }])
    ).toBeUndefined();
    expect(
      sanitizeResolveRows([{ line_ref: 'a', ingredient_text: 'x', grams: 9 }])
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FLAG F-5 — the server household prompt vocabulary is generated from the ONE
// canonical owner and can never omit an accepted token.
// ---------------------------------------------------------------------------

describe('AI amount contract — household prompt vocabulary (F-5)', () => {
  it('renders the complete canonical size/state/unit vocabularies as exact lists', () => {
    const prompt = NUTRITION_RESOLVE_INSTRUCTIONS;
    for (const size of HOUSEHOLD_SIZE_CLASSES) {
      expect(prompt, `size ${size} missing from the prompt`).toContain(size);
    }
    for (const state of HOUSEHOLD_STATES) {
      expect(prompt, `state ${state} missing from the prompt`).toContain(state);
    }
    for (const noun of householdCountNouns()) {
      expect(prompt, `unit ${noun} missing from the prompt`).toContain(noun);
    }
    // The previously omitted accepted sizes must never silently disappear from
    // an allegedly exhaustive list.
    expect(prompt).toContain('petite');
    expect(prompt).toContain('xxl');
    // The vocabulary is presented as EXACT, not illustrative.
    expect(prompt).toMatch(/household unit words are exactly:/i);
    expect(prompt).toMatch(/household size words are exactly:/i);
    expect(prompt).toMatch(/household state words are exactly:/i);
  });

  it('binds the exhaustive prompt size list token-for-token to the canonical owner', () => {
    const match = /household size words are exactly:\s*([^.]*)\./i.exec(
      NUTRITION_RESOLVE_INSTRUCTIONS
    );
    expect(match).not.toBeNull();
    if (!match) return;
    const listed = match[1]
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    expect([...listed].sort()).toEqual([...HOUSEHOLD_SIZE_CLASSES].sort());
  });
});
