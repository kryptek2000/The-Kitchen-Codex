import { describe, it, expect } from 'vitest';
import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { clampResultLimit, rankCandidates } from '../../src/core/nutritionV2/matching/rank';
import {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  type RankableEntry,
} from '../../src/core/nutritionV2/matching/types';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';

/**
 * Phase 2 — deterministic ranking. Integer tuple ordering; no nutrient values;
 * no data-type preference; FDC id is only a presentation tie-break.
 */

function entry(fdcId: number, dataType: UsdaDataType, description: string): RankableEntry {
  const normalized = normalizeQuery(description);
  return {
    fdc_id: fdcId,
    data_type: dataType,
    description,
    normalized_description: normalized.text,
    normalized_tokens: normalized.tokens,
    record_digest: 'a'.repeat(64),
  };
}

function classes(query: string, entries: RankableEntry[]) {
  return rankCandidates(normalizeQuery(query), entries, MAX_RESULT_LIMIT).map((c) => c.match_class);
}

describe('phase 2 rank — match classes', () => {
  it('ranks a unique exact phrase first', () => {
    const results = rankCandidates(
      normalizeQuery('Butter, salted'),
      [entry(1, 'foundation', 'Butter, salted'), entry(2, 'foundation', 'Butter, unsalted')],
      MAX_RESULT_LIMIT
    );
    expect(results[0].match_class).toBe('exact_phrase');
    expect(results[0].fdc_id).toBe(1);
    expect(results[1].match_class).toBe('partial_token_overlap');
  });

  it('detects exact token multiset without phrase equality', () => {
    const results = rankCandidates(
      normalizeQuery('ground beef'),
      [entry(1, 'sr_legacy', 'beef ground')],
      MAX_RESULT_LIMIT
    );
    expect(results[0].match_class).toBe('exact_token_multiset');
    expect(results[0].evidence.exact_phrase).toBe(false);
    expect(results[0].evidence.exact_token_multiset).toBe(true);
    expect(results[0].evidence.order_agreement).toBe(false);
  });

  it('detects all-query-tokens-present (candidate has extras)', () => {
    const results = rankCandidates(
      normalizeQuery('milk whole'),
      [entry(1, 'foundation', 'milk whole vitamin d')],
      MAX_RESULT_LIMIT
    );
    expect(results[0].match_class).toBe('all_query_tokens_present');
    expect(results[0].evidence.missing_query_token_count).toBe(0);
    expect(results[0].evidence.extra_candidate_token_count).toBe(2);
  });

  it('detects partial overlap and excludes unrelated candidates', () => {
    const results = rankCandidates(
      normalizeQuery('milk whole'),
      [entry(1, 'foundation', 'milk skim'), entry(2, 'foundation', 'butter salted')],
      MAX_RESULT_LIMIT
    );
    expect(results).toHaveLength(1);
    expect(results[0].match_class).toBe('partial_token_overlap');
    expect(results[0].fdc_id).toBe(1);
  });

  it('orders the closed classes exactly', () => {
    const query = normalizeQuery('butter salted');
    expect(
      classes('butter salted', [
        entry(4, 'foundation', 'butter salted'), // exact_phrase
        entry(3, 'foundation', 'salted butter'), // exact_token_multiset
        entry(2, 'foundation', 'butter salted cream'), // all_query_tokens_present
        entry(1, 'foundation', 'butter'), // partial_token_overlap
        entry(9, 'foundation', 'milk'), // no_match (excluded)
      ])
    ).toEqual([
      'exact_phrase',
      'exact_token_multiset',
      'all_query_tokens_present',
      'partial_token_overlap',
    ]);
  });
});

describe('phase 2 rank — determinism, ties, caps', () => {
  it('keeps duplicate exact matches as a semantically ambiguous tie (FDC id only)', () => {
    const results = rankCandidates(
      normalizeQuery('Sugar, granulated'),
      [entry(2002, 'fndds', 'Sugar, granulated'), entry(2001, 'fndds', 'Sugar, granulated')],
      MAX_RESULT_LIMIT
    );
    expect(results).toHaveLength(2);
    expect(results.every((c) => c.match_class === 'exact_phrase')).toBe(true);
    expect(results.map((c) => c.fdc_id)).toEqual([2001, 2002]);
  });

  it('does not prefer a data type; FDC id is the only tie-break', () => {
    const results = rankCandidates(
      normalizeQuery('milk'),
      [entry(10, 'foundation', 'milk'), entry(2, 'fndds', 'milk')],
      MAX_RESULT_LIMIT
    );
    expect(results.map((c) => c.fdc_id)).toEqual([2, 10]);
    expect(results.map((c) => c.data_type)).toEqual(['fndds', 'foundation']);
  });

  it('is independent of input entry order', () => {
    const entries = [
      entry(3, 'foundation', 'milk whole'),
      entry(1, 'foundation', 'milk'),
      entry(2, 'foundation', 'milk whole vitamin d'),
    ];
    const a = rankCandidates(normalizeQuery('milk whole'), entries, MAX_RESULT_LIMIT);
    const b = rankCandidates(normalizeQuery('milk whole'), [...entries].reverse(), MAX_RESULT_LIMIT);
    expect(a.map((c) => c.fdc_id)).toEqual(b.map((c) => c.fdc_id));
    expect(a.map((c) => c.match_class)).toEqual(b.map((c) => c.match_class));
  });

  it('caps results at the requested limit and the hard maximum', () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(i + 1, 'foundation', 'milk whole'));
    expect(rankCandidates(normalizeQuery('milk whole'), entries, 3)).toHaveLength(3);
    expect(rankCandidates(normalizeQuery('milk whole'), entries, 1000)).toHaveLength(MAX_RESULT_LIMIT);
    expect(clampResultLimit(undefined)).toBe(DEFAULT_RESULT_LIMIT);
    expect(clampResultLimit(-1)).toBe(DEFAULT_RESULT_LIMIT);
    expect(clampResultLimit(0)).toBe(DEFAULT_RESULT_LIMIT);
    expect(clampResultLimit(999)).toBe(MAX_RESULT_LIMIT);
  });
});

describe('phase 2 rank — immutability', () => {
  it('returns frozen candidates and does not mutate entries', () => {
    const entries = [entry(1, 'foundation', 'milk whole')];
    const before = JSON.stringify(entries);
    const results = rankCandidates(normalizeQuery('milk whole'), entries, MAX_RESULT_LIMIT);
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0])).toBe(true);
    expect(Object.isFrozen(results[0].evidence)).toBe(true);
    expect(() => {
      (results[0] as { fdc_id: number }).fdc_id = 999;
    }).toThrow();
    expect(JSON.stringify(entries)).toBe(before);
  });

  it('carries no nutrient values in candidate output', () => {
    const results = rankCandidates(
      normalizeQuery('milk'),
      [entry(1, 'foundation', 'milk')],
      MAX_RESULT_LIMIT
    );
    expect(JSON.stringify(results)).not.toMatch(/nutrient|calorie|protein|amount_per_100g/i);
  });
});
