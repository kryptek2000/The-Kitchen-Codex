/**
 * The Kitchen Codex — Advanced Nutrition Phase 2: deterministic ranking.
 *
 * PURE, offline. Ranking is fully specified and explainable. It uses an integer
 * comparison tuple (no floating-point scores) and never uses nutrient values or
 * data-type preference. The only presentation tie-break is the numeric FDC id,
 * which is stable but NEVER converts a semantic tie into an automatic selection
 * (see `review.ts`).
 *
 * CLOSED MATCH CLASSES (most specific first):
 *   exact_phrase            normalized phrase equality
 *   exact_token_multiset    same token multiset, different order/spacing
 *   all_query_tokens_present every query token present (candidate has extras)
 *   partial_token_overlap   at least one query token present
 *   no_match                no query token present (excluded from results)
 *
 * ORDERING TUPLE (ascending):
 *   [class_rank, missing_query_tokens, extra_candidate_tokens,
 *    order_disagreement (0 agrees / 1 disagrees), fdc_id]
 */

import {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  type MatchClass,
  type NormalizedQuery,
  type RankableEntry,
  type RankedCandidate,
  type RankingEvidence,
} from './types';

const CLASS_RANK: Readonly<Record<MatchClass, number>> = Object.freeze({
  exact_phrase: 0,
  exact_token_multiset: 1,
  all_query_tokens_present: 2,
  partial_token_overlap: 3,
  no_match: 4,
});

function countTokens(tokens: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function sameMultiset(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const counts = countTokens(a);
  for (const token of b) {
    const remaining = counts.get(token);
    if (remaining === undefined || remaining === 0) return false;
    counts.set(token, remaining - 1);
  }
  return true;
}

/** True when `query` appears as an ordered subsequence of `candidate`. */
function isSubsequence(query: ReadonlyArray<string>, candidate: ReadonlyArray<string>): boolean {
  let qi = 0;
  for (const token of candidate) {
    if (qi < query.length && token === query[qi]) qi += 1;
  }
  return qi === query.length;
}

interface Evaluated {
  readonly entry: RankableEntry;
  readonly matchClass: MatchClass;
  readonly evidence: RankingEvidence;
}

function evaluate(query: NormalizedQuery, entry: RankableEntry): Evaluated {
  const queryTokens = query.tokens;
  const candidateTokens = entry.normalized_tokens;
  const queryCounts = countTokens(queryTokens);
  const candidateCounts = countTokens(candidateTokens);

  let matched = 0;
  for (const [token, count] of queryCounts) {
    matched += Math.min(count, candidateCounts.get(token) ?? 0);
  }
  const missing = queryTokens.length - matched;
  const extra = candidateTokens.length - matched;
  const exactPhrase = query.text.length > 0 && query.text === entry.normalized_description;
  const exactTokenMultiset = sameMultiset(queryTokens, candidateTokens);

  let matchClass: MatchClass;
  if (exactPhrase) matchClass = 'exact_phrase';
  else if (exactTokenMultiset) matchClass = 'exact_token_multiset';
  else if (missing === 0) matchClass = 'all_query_tokens_present';
  else if (matched > 0) matchClass = 'partial_token_overlap';
  else matchClass = 'no_match';

  return {
    entry,
    matchClass,
    evidence: {
      exact_phrase: exactPhrase,
      exact_token_multiset: exactTokenMultiset,
      matched_query_token_count: matched,
      missing_query_token_count: missing,
      extra_candidate_token_count: extra,
      order_agreement: isSubsequence(queryTokens, candidateTokens),
    },
  };
}

/** Clamps a requested result limit into the documented safe range. */
export function clampResultLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    return DEFAULT_RESULT_LIMIT;
  }
  return Math.min(limit, MAX_RESULT_LIMIT);
}

function compareEvaluated(a: Evaluated, b: Evaluated): number {
  const classDelta = CLASS_RANK[a.matchClass] - CLASS_RANK[b.matchClass];
  if (classDelta !== 0) return classDelta;
  const missingDelta =
    a.evidence.missing_query_token_count - b.evidence.missing_query_token_count;
  if (missingDelta !== 0) return missingDelta;
  const extraDelta =
    a.evidence.extra_candidate_token_count - b.evidence.extra_candidate_token_count;
  if (extraDelta !== 0) return extraDelta;
  const orderDelta =
    (a.evidence.order_agreement ? 0 : 1) - (b.evidence.order_agreement ? 0 : 1);
  if (orderDelta !== 0) return orderDelta;
  return a.entry.fdc_id - b.entry.fdc_id;
}

/**
 * Ranks catalog entries for one normalized query and returns at most `limit`
 * bounded candidates. Entries with no query-token overlap are excluded. The
 * result is independent of input entry order.
 */
export function rankCandidates(
  query: NormalizedQuery,
  entries: ReadonlyArray<RankableEntry>,
  limit: unknown = DEFAULT_RESULT_LIMIT
): ReadonlyArray<RankedCandidate> {
  const capped = clampResultLimit(limit);
  const evaluated: Evaluated[] = [];
  for (const entry of entries) {
    const result = evaluate(query, entry);
    if (result.matchClass === 'no_match') continue;
    evaluated.push(result);
  }
  evaluated.sort(compareEvaluated);
  return Object.freeze(
    evaluated.slice(0, capped).map((result) =>
      Object.freeze({
        fdc_id: result.entry.fdc_id,
        data_type: result.entry.data_type,
        description: result.entry.description,
        normalized_description: result.entry.normalized_description,
        record_digest: result.entry.record_digest,
        match_class: result.matchClass,
        evidence: Object.freeze({ ...result.evidence }),
      })
    )
  );
}
