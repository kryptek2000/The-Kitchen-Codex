/**
 * The Kitchen Codex — Advanced Nutrition: TRUE full-catalog manual USDA search.
 *
 * PURE, deterministic, offline. This is the manual-search discovery engine. It
 * is deliberately SEPARATE from the automatic candidate generator:
 *
 *   - it does NOT use anchors, family authority, confidence, eligibility
 *     reasoning, or review status;
 *   - it searches EVERY eligible record in the pinned catalog;
 *   - it is user-directed discovery, not automatic authority.
 *
 * The result is discovery data only. A selection made from it is independently
 * authenticated against the pinned bundle by the calculation engine.
 *
 * SEARCH CONTRACT (deterministic and honest)
 * ------------------------------------------
 *   - an explicit FDC id (`169697` or `fdc 169697`) matches that record first;
 *   - otherwise a query matches a record only when EVERY query token is present
 *     (morphologically tolerant, token-order independent). This AND semantics is
 *     deliberate: manual search never silently substitutes a different food
 *     (e.g. `kosher salt` does not return plain table salt when no kosher-salt
 *     record exists — it returns no match and says so).
 *   - a small, bounded, source-controlled synonym map (`burger` -> `hamburger`)
 *     improves recall without broadening identity unsafely.
 *
 * PERFORMANCE
 * -----------
 * A per-catalog inverted token index is built ONCE and cached in a module-local
 * WeakMap keyed by the frozen entries array, so interactive searches do not
 * rebuild structures. A search is a bounded posting-list union plus a coverage
 * re-check over the candidate subset only.
 */

import {
  MANUAL_SEARCH_DEFAULT_LIMIT,
  MANUAL_SEARCH_MAX_LIMIT,
  type ManualSearchHit,
  type ManualSearchOutcome,
  type NormalizedQuery,
  type RankableEntry,
} from './types';
import { tokensMatch } from './query';

export const MANUAL_SEARCH_VERSION = 'usda_manual_search_v1';

/**
 * Bounded, source-controlled manual-search synonyms. These improve recall for
 * ordinary home-recipe wording without changing food identity. They never
 * fabricate a record that is not in the pinned catalog.
 */
const MANUAL_SYNONYMS: Readonly<Record<string, string>> = Object.freeze({
  burger: 'hamburger',
  burgers: 'hamburger',
});

/**
 * Closed composed/dish-form tokens used ONLY to rank plain component records
 * above assembled dishes in manual discovery (`Roll, white, hamburger bun` above
 * `Double hamburger, ..., 2 patties`). Requested tokens are never penalized.
 */
const MANUAL_COMPOSED_TOKENS: ReadonlySet<string> = new Set([
  'sandwich',
  'burger',
  'hamburger',
  'cheeseburger',
  'patty',
  'patties',
  'slider',
  'wrap',
  'taco',
  'burrito',
  'pizza',
  'double',
  'triple',
  'fast',
  'restaurant',
  'school',
  'cafeteria',
  'meal',
  'entree',
  'platter',
  'combo',
]);

/**
 * An opaque, deterministic per-catalog inverted token index. Built ONCE by the
 * catalog owner (review.ts) and reused for every manual search, so interactive
 * searches never rebuild structures. It carries no authority.
 */
export interface ManualSearchIndex {
  readonly postings: ReadonlyMap<string, ReadonlyArray<number>>;
}

/** Builds the inverted token index for one eligible entries array. */
export function createManualSearchIndex(
  entries: ReadonlyArray<RankableEntry>
): ManualSearchIndex {
  const mutable = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i += 1) {
    for (const token of entries[i].normalized_tokens) {
      let list = mutable.get(token);
      if (list === undefined) {
        list = [];
        mutable.set(token, list);
      }
      list.push(i);
    }
  }
  return { postings: mutable };
}

/** Clamps a manual-search limit into the documented safe range. */
export function clampManualSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    return MANUAL_SEARCH_DEFAULT_LIMIT;
  }
  return Math.min(limit, MANUAL_SEARCH_MAX_LIMIT);
}

/**
 * Candidate tokens that `tokensMatch(queryToken, candidateToken)` would accept,
 * generated from the query token. Mirrors the closed plural rule exactly.
 */
function tokenVariants(token: string): ReadonlyArray<string> {
  const out = new Set<string>([token, `${token}s`, `${token}es`]);
  if (token.endsWith('y')) out.add(`${token.slice(0, -1)}ies`);
  if (token.endsWith('s')) out.add(token.slice(0, -1));
  if (token.endsWith('es')) out.add(token.slice(0, -2));
  if (token.endsWith('ies')) out.add(`${token.slice(0, -3)}y`);
  return [...out];
}

function applySynonyms(tokens: ReadonlyArray<string>): string[] {
  return tokens.map((token) => MANUAL_SYNONYMS[token] ?? token);
}

/** Parses an explicit FDC id query (`169697` or `fdc 169697`). */
function parseFdcQuery(rawTokens: ReadonlyArray<string>): number | undefined {
  if (rawTokens.length === 1 && /^\d+$/.test(rawTokens[0])) {
    const value = Number(rawTokens[0]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (rawTokens.length === 2 && rawTokens[0] === 'fdc' && /^\d+$/.test(rawTokens[1])) {
    const value = Number(rawTokens[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  return undefined;
}

function isSubsequence(query: ReadonlyArray<string>, candidate: ReadonlyArray<string>): boolean {
  let qi = 0;
  for (const token of candidate) {
    if (qi < query.length && token === query[qi]) qi += 1;
  }
  return qi === query.length;
}

function composedPenaltyCount(
  candidateTokens: ReadonlyArray<string>,
  requestedTokens: ReadonlyArray<string>
): number {
  let penalty = 0;
  for (const token of candidateTokens) {
    if (!MANUAL_COMPOSED_TOKENS.has(token)) continue;
    if (requestedTokens.some((requested) => tokensMatch(token, requested))) continue;
    penalty += 1;
  }
  return penalty;
}

interface Scored {
  readonly entry: RankableEntry;
  readonly exactFdc: boolean;
  readonly exactDescription: boolean;
  readonly phrasePrefix: boolean;
  readonly orderAgreement: boolean;
  readonly composedPenalty: number;
  readonly extraTokens: number;
}

function compareScored(a: Scored, b: Scored): number {
  if (a.exactFdc !== b.exactFdc) return a.exactFdc ? -1 : 1;
  if (a.exactDescription !== b.exactDescription) return a.exactDescription ? -1 : 1;
  if (a.phrasePrefix !== b.phrasePrefix) return a.phrasePrefix ? -1 : 1;
  // Plain/common preference BEFORE token order: a compact plain record
  // (`Cheese, cheddar`) must outrank a verbose composed one
  // (`Cheese spread, American or Cheddar cheese base`) even when only the
  // verbose record happens to preserve query token order.
  if (a.composedPenalty !== b.composedPenalty) return a.composedPenalty - b.composedPenalty;
  if (a.extraTokens !== b.extraTokens) return a.extraTokens - b.extraTokens;
  if (a.orderAgreement !== b.orderAgreement) return a.orderAgreement ? -1 : 1;
  return a.entry.fdc_id - b.entry.fdc_id;
}

function toHit(scored: Scored, queryTokenCount: number): ManualSearchHit {
  return Object.freeze({
    fdc_id: scored.entry.fdc_id,
    data_type: scored.entry.data_type,
    description: scored.entry.description,
    normalized_description: scored.entry.normalized_description,
    record_digest: scored.entry.record_digest,
    matched_token_count: queryTokenCount,
    query_token_count: queryTokenCount,
    exact_description: scored.exactDescription,
    exact_fdc_id: scored.exactFdc,
  });
}

/**
 * Ranks every eligible catalog record for one normalized manual query. Never
 * throws; an empty/valueless query yields an empty outcome.
 */
export function searchManualCatalog(
  normalized: NormalizedQuery,
  entries: ReadonlyArray<RankableEntry>,
  index: ManualSearchIndex,
  limit: unknown = MANUAL_SEARCH_DEFAULT_LIMIT
): ManualSearchOutcome {
  const capped = clampManualSearchLimit(limit);
  if (!normalized || !Array.isArray(normalized.tokens) || normalized.tokens.length === 0) {
    return { hits: Object.freeze([]), total: 0 };
  }
  const fdcQuery = parseFdcQuery(normalized.tokens);
  const queryTokens = applySynonyms(normalized.tokens);

  const scored: Scored[] = [];
  const seen = new Set<number>();

  // 1. Exact FDC id (ranked first).
  if (fdcQuery !== undefined) {
    for (const entry of entries) {
      if (entry.fdc_id !== fdcQuery) continue;
      seen.add(entry.fdc_id);
      scored.push({
        entry,
        exactFdc: true,
        exactDescription: false,
        phrasePrefix: false,
        orderAgreement: true,
        composedPenalty: 0,
        extraTokens: 0,
      });
    }
  }

  // 2. Token AND search over the full eligible catalog.
  const candidateSet = new Set<number>();
  for (const token of queryTokens) {
    for (const variant of tokenVariants(token)) {
      const list = index.postings.get(variant);
      if (list === undefined) continue;
      for (const position of list) candidateSet.add(position);
    }
  }
  for (const position of candidateSet) {
    const entry = entries[position];
    if (seen.has(entry.fdc_id)) continue;
    let coverage = 0;
    for (const queryToken of queryTokens) {
      if (entry.normalized_tokens.some((candidate) => tokensMatch(candidate, queryToken))) {
        coverage += 1;
      }
    }
    if (coverage < queryTokens.length) continue;
    seen.add(entry.fdc_id);
    scored.push({
      entry,
      exactFdc: false,
      exactDescription: entry.normalized_description === normalized.text,
      phrasePrefix:
        normalized.text.length > 0 && entry.normalized_description.startsWith(normalized.text),
      orderAgreement: isSubsequence(queryTokens, entry.normalized_tokens),
      composedPenalty: composedPenaltyCount(entry.normalized_tokens, queryTokens),
      extraTokens: Math.max(0, entry.normalized_tokens.length - coverage),
    });
  }

  scored.sort(compareScored);
  const total = scored.length;
  return {
    hits: Object.freeze(scored.slice(0, capped).map((item) => toHit(item, queryTokens.length))),
    total,
  };
}
