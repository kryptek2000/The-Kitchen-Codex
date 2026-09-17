/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5D: deterministic ranking.
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
 *   all_query_tokens_present every food-identity token present (candidate extras)
 *   partial_token_overlap   at least one food-identity token present
 *   no_match                no required anchor present (excluded from results)
 *
 * ANCHOR ENFORCEMENT
 * ------------------
 * Every candidate must contain a token (or approved morphological equivalent)
 * from EACH required anchor group derived by the query projection. A candidate
 * that only shares a preparation word (`ground`, `shredded`) is therefore never
 * returned. A bounded contradiction window (`without salt`, `no salt`,
 * `salt free`) removes negated candidates unless the query itself requests the
 * negation.
 *
 * ORDERING TUPLE (ascending):
 *   [class_rank, missing_identity_tokens, qualifier_conflicts,
 *    -qualifier_agreement, contradiction(0/1), extra_candidate_tokens,
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
import {
  candidateContradicts,
  projectQueryText,
  qualifierConflictCount,
  queryRequestsNegation,
  tokensMatch,
  type IngredientQueryProjection,
} from './query';

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

function candidateHasToken(candidate: ReadonlyArray<string>, wanted: string): boolean {
  for (const token of candidate) {
    if (tokensMatch(token, wanted)) return true;
  }
  return false;
}

function anchorsSatisfied(
  projection: IngredientQueryProjection,
  candidateTokens: ReadonlyArray<string>
): boolean {
  if (projection.anchor_groups.length === 0) return false;
  for (const group of projection.anchor_groups) {
    let ok = false;
    for (const accepted of group.accepted) {
      if (candidateHasToken(candidateTokens, accepted)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}

interface Evaluated {
  readonly entry: RankableEntry;
  readonly matchClass: MatchClass;
  readonly evidence: RankingEvidence;
  readonly qualifierConflicts: number;
  readonly qualifierAgreement: number;
  readonly contradiction: boolean;
}

const NO_MATCH: Evaluated = Object.freeze({
  entry: undefined as unknown as RankableEntry,
  matchClass: 'no_match' as const,
  evidence: Object.freeze({
    exact_phrase: false,
    exact_token_multiset: false,
    matched_query_token_count: 0,
    missing_query_token_count: 0,
    extra_candidate_token_count: 0,
    order_agreement: false,
  }),
  qualifierConflicts: 0,
  qualifierAgreement: 0,
  contradiction: false,
});

function evaluate(
  query: NormalizedQuery,
  projection: IngredientQueryProjection,
  entry: RankableEntry
): Evaluated {
  const candidateTokens = entry.normalized_tokens;
  const identityTokens = projection.food_tokens;

  if (identityTokens.length === 0 || !anchorsSatisfied(projection, candidateTokens)) {
    return NO_MATCH;
  }

  const queryNegates = queryRequestsNegation(projection);
  const contradiction = !queryNegates && candidateContradicts(candidateTokens, identityTokens);
  if (contradiction) {
    return NO_MATCH;
  }

  const candidateCounts = countTokens(candidateTokens);
  let matched = 0;
  for (const token of identityTokens) {
    if (candidateHasToken(candidateTokens, token)) matched += 1;
  }
  const missing = identityTokens.length - matched;
  const extra = Math.max(0, candidateTokens.length - matched);
  const exactPhrase = query.text.length > 0 && query.text === entry.normalized_description;
  const exactTokenMultiset = sameMultiset(query.tokens, candidateTokens);

  let matchClass: MatchClass;
  if (exactPhrase) matchClass = 'exact_phrase';
  else if (exactTokenMultiset) matchClass = 'exact_token_multiset';
  else if (missing === 0) matchClass = 'all_query_tokens_present';
  else if (matched > 0) matchClass = 'partial_token_overlap';
  else matchClass = 'no_match';

  if (matchClass === 'no_match') return NO_MATCH;

  let qualifierAgreement = 0;
  for (const numeric of projection.numeric_qualifiers) {
    if ((candidateCounts.get(numeric) ?? 0) > 0) qualifierAgreement += 1;
  }

  return {
    entry,
    matchClass,
    evidence: {
      exact_phrase: exactPhrase,
      exact_token_multiset: exactTokenMultiset,
      matched_query_token_count: matched,
      missing_query_token_count: missing,
      extra_candidate_token_count: extra,
      order_agreement: isSubsequence(identityTokens, candidateTokens),
    },
    qualifierConflicts: qualifierConflictCount(candidateTokens, projection),
    qualifierAgreement,
    contradiction: false,
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
  const conflictDelta = a.qualifierConflicts - b.qualifierConflicts;
  if (conflictDelta !== 0) return conflictDelta;
  const agreementDelta = b.qualifierAgreement - a.qualifierAgreement;
  if (agreementDelta !== 0) return agreementDelta;
  const contradictionDelta = (a.contradiction ? 1 : 0) - (b.contradiction ? 1 : 0);
  if (contradictionDelta !== 0) return contradictionDelta;
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
 * bounded candidates. Entries that lack a required anchor, contradict the query,
 * or share no food-identity token are excluded. The result is independent of
 * input entry order.
 */
export function rankCandidates(
  query: NormalizedQuery,
  entries: ReadonlyArray<RankableEntry>,
  limit: unknown = DEFAULT_RESULT_LIMIT
): ReadonlyArray<RankedCandidate> {
  const capped = clampResultLimit(limit);
  const projection = projectQueryText(query.text);
  const evaluated: Evaluated[] = [];
  for (const entry of entries) {
    const result = evaluate(query, projection, entry);
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
