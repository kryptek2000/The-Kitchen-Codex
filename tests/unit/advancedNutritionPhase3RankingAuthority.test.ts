import { describe, it, expect } from 'vitest';

import { normalizeQuery } from '../../src/core/nutritionV2/matching/normalize';
import { rankCandidates } from '../../src/core/nutritionV2/matching/rank';
import {
  explainCandidate,
  selectAutomaticMatch,
  selectBestEffortMatch,
} from '../../src/core/nutritionV2/matching/confidence';
import {
  unrequestedSpecialtyCount,
  varietyContradictionCount,
  projectQueryText,
} from '../../src/core/nutritionV2/matching/query';
import { MAX_RESULT_LIMIT, type RankableEntry, type RankedCandidate } from '../../src/core/nutritionV2/matching/types';
import type { UsdaDataType } from '../../src/core/nutritionV2/usda/types';

/**
 * Phase 3 — smarter ranking and automatic-authority contract.
 *
 * Proves plain-before-specialty ordering, explicit variety contradiction
 * evidence, the LATE data-type tie-break (never ahead of semantic identity), and
 * the unchanged fail-closed authority model on synthetic records.
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

function candidate(ranked: RankableEntry, matchClass = 'all_query_tokens_present'): RankedCandidate {
  return {
    fdc_id: ranked.fdc_id,
    data_type: ranked.data_type,
    description: ranked.description,
    normalized_description: ranked.normalized_description,
    record_digest: ranked.record_digest,
    match_class: matchClass as RankedCandidate['match_class'],
    evidence: {
      exact_phrase: false,
      exact_token_multiset: false,
      matched_query_token_count: 1,
      missing_query_token_count: 0,
      extra_candidate_token_count: 0,
      order_agreement: true,
    },
  };
}

describe('phase 3 ranking — plain before unrequested specialty', () => {
  it('ranks a plain record above an unrequested specialty even when FDC order disagrees', () => {
    const plain = entry(90, 'sr_legacy', 'spaghetti');
    const spinach = entry(10, 'sr_legacy', 'spaghetti spinach dry');
    const ranked = rankCandidates(normalizeQuery('spaghetti'), [spinach, plain], MAX_RESULT_LIMIT);
    expect(ranked.map((c) => c.fdc_id)).toEqual([90, 10]);
  });

  it('preserves an explicitly requested specialty', () => {
    const spinach = entry(10, 'sr_legacy', 'spaghetti spinach dry');
    const plain = entry(90, 'sr_legacy', 'spaghetti');
    const ranked = rankCandidates(
      normalizeQuery('spinach spaghetti'),
      [plain, spinach],
      MAX_RESULT_LIMIT
    );
    expect(ranked[0].fdc_id).toBe(10);
  });

  it('withholds automatic authority for an unrequested specialty', () => {
    const chili = candidate(entry(10, 'fndds', 'tomato chili sauce'));
    const explanation = explainCandidate('tomato sauce', chili);
    expect(explanation.unrequested_specialty).toBe(1);
    expect(explanation.automatic_eligible).toBe(false);
    expect(explanation.reasons).toContain('unrequested_specialty');

    const plain = candidate(entry(20, 'sr_legacy', 'tomato products canned sauce'));
    // A bare `tomato sauce` does not request the canned state, so the plain
    // record still fails the state gate (fail closed); the specialty counter is
    // nevertheless 0 and the requested-canned line is eligible.
    expect(explainCandidate('tomato sauce', plain).unrequested_specialty).toBe(0);
    expect(explainCandidate('canned tomato sauce', plain).automatic_eligible).toBe(true);
  });

  it('treats an unrequested seed product as a specialty form', () => {
    const seed = entry(10, 'sr_legacy', 'spices dill seed');
    const weed = entry(20, 'sr_legacy', 'dill weed fresh');
    const ranked = rankCandidates(normalizeQuery('dill'), [seed, weed], MAX_RESULT_LIMIT);
    expect(ranked[0].fdc_id).toBe(20);
    expect(unrequestedSpecialtyCount(['spices', 'dill', 'seed'], projectQueryText('dill'))).toBe(1);
    expect(unrequestedSpecialtyCount(['dill', 'seed'], projectQueryText('dill seed'))).toBe(0);
    // Botanical dry-legume wording is not a specialty seed product.
    expect(
      unrequestedSpecialtyCount(
        ['beans', 'black', 'mature', 'seeds', 'raw'],
        projectQueryText('black beans')
      )
    ).toBe(0);
  });
});

describe('phase 3 ranking — explicit variety constraints', () => {
  it('demotes a contradicted variety below matching and silent candidates', () => {
    const red = entry(10, 'foundation', 'rice red unenriched dry raw');
    const white = entry(90, 'sr_legacy', 'rice white long grain raw');
    const ranked = rankCandidates(normalizeQuery('white rice'), [red, white], MAX_RESULT_LIMIT);
    expect(ranked.map((c) => c.fdc_id)).toEqual([90, 10]);
  });

  it('withholds automatic authority on an explicit variety contradiction', () => {
    const explanation = explainCandidate(
      'white rice',
      candidate(entry(10, 'foundation', 'rice red unenriched dry raw'))
    );
    expect(explanation.variety_contradiction).toBe(1);
    expect(explanation.automatic_eligible).toBe(false);
    expect(explanation.same_family_default_eligible).toBe(false);
    expect(explanation.reasons).toContain('variety_contradiction');
  });

  it('uses the variety contradiction as the sole blocker for an otherwise-plain candidate', () => {
    const red = candidate(entry(30, 'sr_legacy', 'rice red'));
    const explanation = explainCandidate('white rice', red);
    expect(explanation.variety_contradiction).toBe(1);
    // No state/form/subtype blocker exists on this synthetic candidate, so the
    // best-effort contract must reject it solely for the variety contradiction.
    expect(explanation.unrequested_material_variants).toBe(0);
    expect(explanation.preparation_form_contradiction).toBe(0);
    expect(explanation.same_family_default_eligible).toBe(false);
    const review = {
      outcome: 'review_required' as const,
      line_ref: 'white rice',
      original_text: 'white rice',
      query: 'white rice',
      normalized_query: 'white rice',
      query_tokens: ['white', 'rice'],
      bundle_release: 'test',
      catalog_digest: 'b'.repeat(64),
      normalization_version: 'usda_match_normalize_v2',
      ranking_version: 'usda_match_rank_v11',
      result_limit: 10,
      candidates: [red],
      review_digest: 'c'.repeat(64),
    } as never;
    expect(selectAutomaticMatch(review)).toBeUndefined();
    expect(selectBestEffortMatch(review)).toBeUndefined();
  });

  it('keeps a silent variety neutral and a generic marker exempt', () => {
    expect(
      varietyContradictionCount(['rice', 'raw'], projectQueryText('white rice'))
    ).toBe(0);
    expect(
      varietyContradictionCount(['rice', 'nfs'], projectQueryText('white rice'))
    ).toBe(0);
    expect(
      varietyContradictionCount(['rice', 'red'], projectQueryText('white rice'))
    ).toBe(1);
  });
});

describe('phase 3 ranking — late data-type tie-break', () => {
  it('prefers Foundation over FNDDS only on a full semantic tie', () => {
    const foundation = entry(10, 'foundation', 'milk');
    const fndds = entry(2, 'fndds', 'milk');
    const ranked = rankCandidates(normalizeQuery('milk'), [fndds, foundation], MAX_RESULT_LIMIT);
    expect(ranked.map((c) => c.data_type)).toEqual(['foundation', 'fndds']);
  });

  it('prefers SR Legacy over Foundation on a full semantic tie (portion-preserving)', () => {
    const sr = entry(10, 'sr_legacy', 'garlic raw');
    const foundation = entry(20, 'foundation', 'garlic raw');
    const ranked = rankCandidates(normalizeQuery('garlic'), [foundation, sr], MAX_RESULT_LIMIT);
    expect(ranked.map((c) => c.data_type)).toEqual(['sr_legacy', 'foundation']);
  });

  it('never lets data type outrank a semantic difference', () => {
    const cookedFoundation = entry(10, 'foundation', 'milk cooked');
    const plainFndds = entry(2, 'fndds', 'milk');
    const ranked = rankCandidates(
      normalizeQuery('milk'),
      [cookedFoundation, plainFndds],
      MAX_RESULT_LIMIT
    );
    expect(ranked.map((c) => c.fdc_id)).toEqual([2, 10]);
  });
});

describe('phase 3 ranking — determinism and adversarial bounds', () => {
  it('is independent of input order and deterministic across runs', () => {
    const entries = [
      entry(3, 'foundation', 'rice white long grain'),
      entry(1, 'fndds', 'rice white long grain'),
      entry(2, 'sr_legacy', 'rice white long grain'),
    ];
    const a = rankCandidates(normalizeQuery('white rice'), entries, MAX_RESULT_LIMIT);
    const b = rankCandidates(normalizeQuery('white rice'), [...entries].reverse(), MAX_RESULT_LIMIT);
    const c = rankCandidates(normalizeQuery('white rice'), entries, MAX_RESULT_LIMIT);
    expect(a.map((x) => x.fdc_id)).toEqual(b.map((x) => x.fdc_id));
    expect(a.map((x) => x.fdc_id)).toEqual(c.map((x) => x.fdc_id));
  });

  it('handles oversized, repeated, punctuated, and prototype-shaped tokens safely', () => {
    const hostile = entry(1, 'foundation', 'spaghetti spinach flavored seasoned');
    const repeated = entry(2, 'foundation', Array(2000).fill('flavored').join(' '));
    expect(() => rankCandidates(normalizeQuery('spaghetti'), [hostile, repeated], 5)).not.toThrow();
    const huge = new Array(5000).fill('crushed');
    expect(() => unrequestedSpecialtyCount(huge, projectQueryText('spaghetti'))).not.toThrow();
    expect(() =>
      varietyContradictionCount(['__proto__', 'constructor', 'red'], projectQueryText('white rice'))
    ).not.toThrow();
    expect((Object.prototype as unknown as { polluted?: boolean }).polluted).toBeUndefined();
    expect(() => rankCandidates(normalizeQuery('crushed—diced'), [hostile], 5)).not.toThrow();
    expect(() => rankCandidates(normalizeQuery(''), [hostile], 5)).not.toThrow();
    expect(rankCandidates(normalizeQuery(''), [hostile], 5)).toEqual([]);
  });

  it('never mutates caller entries and invents no automatic identity for a qualifier-only query', () => {
    const entries = [entry(1, 'foundation', 'salt low sodium')];
    const snapshot = JSON.stringify(entries);
    const ranked = rankCandidates(normalizeQuery('low sodium'), entries, MAX_RESULT_LIMIT);
    expect(JSON.stringify(entries)).toBe(snapshot);
    expect(ranked.length).toBeGreaterThanOrEqual(0);
    const projection = projectQueryText('low sodium');
    // `low` is a qualifier; `sodium` is a non-food token, so no food anchor
    // exists and no candidate can be authorized from this query.
    expect(projection.core_tokens).toEqual(['sodium']);
    expect(projection.anchor_groups.map((g) => [...g.accepted])).toEqual([['sodium']]);
  });

  it('keeps the runner-up ambiguity contract: a material subtype tie withholds authority', () => {
    const top = candidate(entry(10, 'sr_legacy', 'milk whole'));
    const runnerUp = candidate(entry(11, 'sr_legacy', 'milk nonfat'));
    const review = {
      outcome: 'review_required' as const,
      line_ref: 'milk',
      original_text: 'milk',
      query: 'milk',
      normalized_query: 'milk',
      query_tokens: ['milk'],
      bundle_release: 'test',
      catalog_digest: 'b'.repeat(64),
      normalization_version: 'usda_match_normalize_v2',
      ranking_version: 'usda_match_rank_v11',
      result_limit: 10,
      candidates: [top, runnerUp],
      review_digest: 'c'.repeat(64),
    } as never;
    expect(selectAutomaticMatch(review)).toBeUndefined();
  });

  it('keeps the existing strict/best-effort authority contracts reachable for plain records', () => {
    const plain = entry(10, 'sr_legacy', 'spaghetti');
    const review = {
      outcome: 'review_required' as const,
      line_ref: 'spaghetti',
      original_text: 'spaghetti',
      query: 'spaghetti',
      normalized_query: 'spaghetti',
      query_tokens: ['spaghetti'],
      bundle_release: 'test',
      catalog_digest: 'b'.repeat(64),
      normalization_version: 'usda_match_normalize_v2',
      ranking_version: 'usda_match_rank_v11',
      result_limit: 10,
      candidates: [candidate(plain, 'exact_phrase')],
      review_digest: 'c'.repeat(64),
    } as never;
    expect(selectAutomaticMatch(review)?.fdc_id).toBe(10);
    expect(selectBestEffortMatch(review)?.fdc_id).toBe(10);
  });
});
