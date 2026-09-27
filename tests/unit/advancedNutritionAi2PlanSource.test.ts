/**
 * The Kitchen Codex — AI-2A deterministic plan source + bounded request context.
 *
 * Pure unit coverage: the plan source projects the EXACT deterministic review
 * candidates into opaque request-scoped refs (failing closed on anything it
 * cannot prove), and the request context assembles at most 12 lines into a
 * minimal provider payload under a hard 32 KiB UTF-8 cap with ZERO portion refs.
 */

import { describe, it, expect } from 'vitest';

import {
  AI_ADVANCED_PLAN_SOURCE_VERSION,
  MAX_AI_ADVANCED_FINGERPRINT_LENGTH,
  buildAiAdvancedPlanLineSource,
} from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import {
  AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS,
  AI_ADVANCED_PLAN_REQUEST_VERSION,
  MAX_AI_ADVANCED_PLAN_LINES,
  MAX_AI_ADVANCED_PLAN_REQUEST_BYTES,
  MAX_AI_ADVANCED_REQUEST_ID_LENGTH,
  buildAiAdvancedPlanRequestContext,
} from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import { MAX_AI_ADVANCED_CANDIDATES } from '../../src/core/nutritionV2/aiAdvancedCandidates';
import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';

const FDC_TOMATO_SAUCE = 170054;
const FDC_CRUSHED_TOMATOES = 170501;

function candidate(fdcId: number, description: string, recordDigest = `digest-${fdcId}`) {
  return {
    fdc_id: fdcId,
    data_type: 'sr_legacy_food',
    description,
    normalized_description: description.toLowerCase(),
    record_digest: recordDigest,
    match_class: 'all_query_tokens_present',
    evidence: {
      exact_phrase: false,
      exact_token_multiset: false,
      matched_query_token_count: 2,
      missing_query_token_count: 0,
      extra_candidate_token_count: 1,
      order_agreement: 1,
    },
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'review_required',
    line_ref: 'tomato sauce',
    original_text: 'tomato sauce',
    query: 'tomato sauce',
    normalized_query: 'tomato sauce',
    query_tokens: ['tomato', 'sauce'],
    bundle_release: 'usda_fdc_87c5408a3e98838944a87be74824761e',
    catalog_digest: 'catalog-digest',
    normalization_version: 'n1',
    ranking_version: 'r1',
    result_limit: 10,
    candidates: [
      candidate(FDC_TOMATO_SAUCE, 'Tomato products, canned, sauce'),
      candidate(FDC_CRUSHED_TOMATOES, 'Tomatoes, crushed, canned'),
    ],
    review_digest: 'review-digest-1',
    ...overrides,
  };
}

describe('AI-2A plan source — projects the exact deterministic candidates', () => {
  it('issues deterministic c1..cN refs and keeps real identity local', () => {
    const built = buildAiAdvancedPlanLineSource({ lineRef: 'tomato sauce', review: review() });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    const source = built.source;
    expect(source.source_version).toBe(AI_ADVANCED_PLAN_SOURCE_VERSION);
    expect(source.line_ref).toBe('tomato sauce');
    expect(source.review_digest).toBe('review-digest-1');
    expect(source.review_outcome).toBe('review_required');
    expect(source.candidate_refs).toEqual(['c1', 'c2']);
    expect(source.result_limit).toBe(10);
    // The provider view carries opaque refs and display text only.
    for (const view of source.candidate_set.views) {
      expect(Object.keys(view).sort()).toEqual(['candidate_ref', 'display_description', 'semantic_tags']);
    }
    // Local resolution keeps the authenticated identity and dedupe digest.
    expect(source.candidate_set.resolve('c1')).toMatchObject({
      fdc_id: FDC_TOMATO_SAUCE,
      description: 'Tomato products, canned, sauce',
      record_digest: `digest-${FDC_TOMATO_SAUCE}`,
    });
    expect(source.candidate_set.refFor(FDC_CRUSHED_TOMATOES)).toBe('c2');
    expect(source.candidate_set.resolve('c9')).toBeUndefined();
  });

  it('carries the trusted issue kind and an optional interpretation fingerprint', () => {
    const built = buildAiAdvancedPlanLineSource({
      lineRef: 'tomato sauce',
      review: review(),
      issueKind: 'review_suggested',
      interpretationFingerprint: 'fp-1',
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.source.issue_kind).toBe('review_suggested');
    expect(built.source.interpretation_fingerprint).toBe('fp-1');
  });

  it('fails closed on unusable reviews, missing digests and empty candidate sets', () => {
    expect(buildAiAdvancedPlanLineSource({ lineRef: 'x', review: null })).toEqual({ ok: false, code: 'unusable_review' });
    expect(
      buildAiAdvancedPlanLineSource({ lineRef: 'x', review: review({ outcome: 'unmatched' }) })
    ).toEqual({ ok: false, code: 'unusable_review' });
    expect(
      buildAiAdvancedPlanLineSource({ lineRef: 'x', review: review({ outcome: 'invalid' }) })
    ).toEqual({ ok: false, code: 'unusable_review' });
    expect(
      buildAiAdvancedPlanLineSource({ lineRef: 'x', review: review({ review_digest: undefined }) })
    ).toEqual({ ok: false, code: 'missing_review_digest' });
    expect(
      buildAiAdvancedPlanLineSource({ lineRef: 'x', review: review({ candidates: [] }) })
    ).toEqual({ ok: false, code: 'no_candidates' });
    expect(buildAiAdvancedPlanLineSource({ lineRef: '', review: review() })).toEqual({
      ok: false,
      code: 'invalid_line_ref',
    });
  });

  it('NEVER truncates an oversized candidate set — it fails closed', () => {
    const many = Array.from({ length: MAX_AI_ADVANCED_CANDIDATES + 1 }, (_, index) =>
      candidate(100000 + index, `Food ${index}`)
    );
    expect(
      buildAiAdvancedPlanLineSource({ lineRef: 'x', review: review({ candidates: many }) })
    ).toEqual({ ok: false, code: 'too_many_candidates' });
    // Exactly at the cap is still accepted.
    const atCap = many.slice(0, MAX_AI_ADVANCED_CANDIDATES);
    const built = buildAiAdvancedPlanLineSource({ lineRef: 'x', review: review({ candidates: atCap }) });
    expect(built.ok).toBe(true);
  });

  it('rejects duplicated or malformed candidates and invalid metadata', () => {
    expect(
      buildAiAdvancedPlanLineSource({
        lineRef: 'x',
        review: review({ candidates: [candidate(1, 'A'), candidate(1, 'B')] }),
      })
    ).toEqual({ ok: false, code: 'duplicate_candidate' });
    expect(
      buildAiAdvancedPlanLineSource({
        lineRef: 'x',
        review: review({ candidates: [candidate(0, 'A')] }),
      })
    ).toEqual({ ok: false, code: 'invalid_candidate' });
    expect(
      buildAiAdvancedPlanLineSource({ lineRef: 'x', review: review(), issueKind: 'needs_estimate' })
    ).toEqual({ ok: false, code: 'invalid_issue_kind' });
    expect(
      buildAiAdvancedPlanLineSource({
        lineRef: 'x',
        review: review(),
        interpretationFingerprint: 'f'.repeat(MAX_AI_ADVANCED_FINGERPRINT_LENGTH + 1),
      })
    ).toEqual({ ok: false, code: 'invalid_fingerprint' });
  });
});

describe('AI-2A request context — bounded, portion-free, opaque', () => {
  function source(lineRef: string, fdcId: number, description = `${lineRef} candidate`) {
    const built = buildAiAdvancedPlanLineSource({
      lineRef,
      review: review({
        line_ref: lineRef,
        candidates: [candidate(fdcId, description)],
        review_digest: `digest-${lineRef}`,
      }),
    });
    if (built.ok !== true) throw new Error('source construction failed');
    return built.source;
  }

  it('builds a minimal provider payload with opaque views only', () => {
    const built = buildAiAdvancedPlanRequestContext({
      requestId: 'req-1',
      lines: [source('tomato sauce', FDC_TOMATO_SAUCE), source('canned tomatoes', FDC_CRUSHED_TOMATOES)],
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    const context = built.context;
    expect(context.request_version).toBe(AI_ADVANCED_PLAN_REQUEST_VERSION);
    expect(context.request_id).toBe('req-1');
    expect(context.allowed_line_refs).toEqual(['tomato sauce', 'canned tomatoes']);
    expect(Object.keys(context.provider_request).sort()).toEqual(['contract_version', 'lines']);
    expect(context.provider_request.contract_version).toBe(AI_ADVANCED_PLAN_VERSION);
    expect(context.provider_request.lines.map((line) => line.line_ref)).toEqual([
      'tomato sauce',
      'canned tomatoes',
    ]);
    // LOCAL authority is retained and reachable by line.
    expect(context.line('tomato sauce')?.review_digest).toBe('digest-tomato sauce');
    expect(context.line('nope')).toBeUndefined();
    expect(context.allowed_candidate_refs_by_line['tomato sauce']).toEqual(['c1']);
    // PORTION FIREWALL: AI-2A issues zero portion refs.
    expect(context.allowed_portion_refs_by_line).toEqual({});
    expect(Object.keys(AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS)).toHaveLength(0);
  });

  it('leaks no FDC id, record digest, review digest, catalog digest or bundle release', () => {
    const built = buildAiAdvancedPlanRequestContext({
      requestId: 'req-leak',
      lines: [source('tomato sauce', 987654321, 'Some described food')],
    });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    const payload = JSON.stringify(built.context.provider_request);
    for (const forbidden of [
      '987654321',
      'fdc',
      'record_digest',
      'digest-',
      'review_digest',
      'catalog_digest',
      'bundle_release',
      'result_limit',
      'match_class',
      'evidence',
      'usda_fdc_',
    ]) {
      expect(payload.includes(forbidden), `payload leaks ${forbidden}`).toBe(false);
    }
  });

  it('validates the caller-provided request identity (no randomness of its own)', () => {
    const lines = [source('tomato sauce', FDC_TOMATO_SAUCE)];
    expect(buildAiAdvancedPlanRequestContext({ requestId: undefined, lines })).toEqual({
      ok: false,
      code: 'invalid_request_id',
    });
    expect(buildAiAdvancedPlanRequestContext({ requestId: '', lines })).toEqual({
      ok: false,
      code: 'invalid_request_id',
    });
    expect(buildAiAdvancedPlanRequestContext({ requestId: 'has space', lines })).toEqual({
      ok: false,
      code: 'invalid_request_id',
    });
    expect(
      buildAiAdvancedPlanRequestContext({ requestId: 'x'.repeat(MAX_AI_ADVANCED_REQUEST_ID_LENGTH + 1), lines })
    ).toEqual({ ok: false, code: 'invalid_request_id' });
  });

  it('is deterministic: identical inputs produce byte-identical payloads', () => {
    const first = buildAiAdvancedPlanRequestContext({ requestId: 'req-same', lines: [source('a', 1)] });
    const second = buildAiAdvancedPlanRequestContext({ requestId: 'req-same', lines: [source('a', 1)] });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok !== true || second.ok !== true) return;
    expect(JSON.stringify(second.context.provider_request)).toBe(
      JSON.stringify(first.context.provider_request)
    );
    expect(second.context.provider_request_bytes).toBe(first.context.provider_request_bytes);
  });

  it('enforces line bounds, uniqueness and source validity', () => {
    expect(buildAiAdvancedPlanRequestContext({ requestId: 'r', lines: [] })).toEqual({
      ok: false,
      code: 'no_lines',
    });
    const tooMany = Array.from({ length: MAX_AI_ADVANCED_PLAN_LINES + 1 }, (_, index) =>
      source(`line ${index}`, index + 1)
    );
    expect(buildAiAdvancedPlanRequestContext({ requestId: 'r', lines: tooMany })).toEqual({
      ok: false,
      code: 'too_many_lines',
    });
    expect(
      buildAiAdvancedPlanRequestContext({ requestId: 'r', lines: [source('a', 1), source('a', 2)] })
    ).toEqual({ ok: false, code: 'duplicate_line_ref' });
    expect(buildAiAdvancedPlanRequestContext({ requestId: 'r', lines: [{ line_ref: 'a' }] })).toEqual({
      ok: false,
      code: 'invalid_line_source',
    });
  });

  it('fails closed above the 32 KiB UTF-8 cap and never truncates', () => {
    const longDescription = 'D'.repeat(200);
    const heavy = Array.from({ length: MAX_AI_ADVANCED_PLAN_LINES }, (_, lineIndex) =>
      buildAiAdvancedPlanLineSource({
        lineRef: `line ${lineIndex}`,
        review: review({
          line_ref: `line ${lineIndex}`,
          candidates: Array.from({ length: MAX_AI_ADVANCED_CANDIDATES }, (_, index) =>
            candidate(lineIndex * 1000 + index + 1, longDescription)
          ),
        }),
      })
    ).map((built) => {
      if (built.ok !== true) throw new Error('source construction failed');
      return built.source;
    });
    expect(buildAiAdvancedPlanRequestContext({ requestId: 'r', lines: heavy })).toEqual({
      ok: false,
      code: 'request_too_large',
    });
    // The same shape with natural descriptions stays comfortably under the cap.
    const lean = [source('tomato sauce', FDC_TOMATO_SAUCE)];
    const built = buildAiAdvancedPlanRequestContext({ requestId: 'r', lines: lean });
    expect(built.ok).toBe(true);
    if (built.ok !== true) return;
    expect(built.context.provider_request_bytes).toBeLessThan(MAX_AI_ADVANCED_PLAN_REQUEST_BYTES);
    expect(built.context.provider_request_bytes).toBeGreaterThan(0);
  });
});
