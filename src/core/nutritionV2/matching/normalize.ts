/**
 * The Kitchen Codex — Advanced Nutrition Phase 2: conservative query
 * normalization (matching only).
 *
 * PURE, deterministic, locale-independent. This is the ONE documented
 * normalization contract for Phase 2 matching. It is deliberately conservative:
 * it never stems, singularizes, deletes stop words, or drops nutritionally
 * significant qualifiers (raw/cooked, salted/unsalted, sweetened/unsweetened,
 * whole/skim, lean/ground, canned/drained, enriched/unenriched, with/without
 * skin, dry/prepared, ...). Those words survive tokenization so they can keep
 * distinct foods distinct.
 *
 * Pinned operations, in order:
 *   1. Obsidian wikilink label extraction:
 *        `!?[[Target|Alias]]` -> `Alias`;  `!?[[Target]]` -> `Target`;
 *        `!?[[Target#Heading]]` -> `Target`.
 *   2. Unicode NFC normalization (`String.prototype.normalize('NFC')`).
 *   3. Non-locale lowercase (`String.prototype.toLowerCase()`).
 *   4. Punctuation/symbol separation: runs of non-letter/non-number/non-space
 *      code points become a single space (Unicode-aware, `\p{L}`/`\p{N}`).
 *   5. Whitespace collapse + trim.
 *   6. Bounded tokenization on single spaces.
 *
 * No locale-sensitive case conversion (`toLocaleLowerCase`) is used, and no
 * implicit normalization form other than NFC is applied.
 */

import {
  MAX_QUERY_TOKENS,
  MAX_TOKEN_LENGTH,
  type NormalizedQuery,
} from './types';

const WIKILINK_PATTERN = /!?\[\[([^\]]*)\]\]/g;
const NON_ALPHANUMERIC_RUN = /[^\p{L}\p{N}\s]+/gu;

/** Extracts the display label from one Obsidian wikilink body. */
function wikilinkLabel(inner: string): string {
  const pipe = inner.indexOf('|');
  if (pipe >= 0) return inner.slice(pipe + 1);
  const hash = inner.indexOf('#');
  return hash >= 0 ? inner.slice(0, hash) : inner;
}

/** Removes Obsidian wikilink markup, keeping the human-readable label. */
export function stripWikilinks(text: string): string {
  return text.replace(WIKILINK_PATTERN, (_match, inner: string) => wikilinkLabel(inner));
}

/**
 * Normalizes one bounded string into the canonical matching phrase and tokens.
 * Deterministic for identical input; independent of locale, time, and state.
 */
export function normalizeQuery(text: string): NormalizedQuery {
  const stripped = stripWikilinks(String(text));
  const normalized = stripped
    .normalize('NFC')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = normalized.length === 0 ? [] : normalized.split(' ');
  return { text: normalized, tokens };
}

export type NormalizeQueryResult =
  | { ok: true; query: NormalizedQuery }
  | { ok: false; code: 'empty_query' | 'invalid_query' };

/**
 * Normalizes and bounds a query. Empty normalized text fails (`empty_query`);
 * too many tokens or an over-long token fails (`invalid_query`). Oversized raw
 * text must be rejected by the caller BEFORE this point (it is never truncated
 * here).
 */
export function normalizeQueryChecked(text: string): NormalizeQueryResult {
  const query = normalizeQuery(text);
  if (query.text.length === 0) return { ok: false, code: 'empty_query' };
  if (query.tokens.length > MAX_QUERY_TOKENS) return { ok: false, code: 'invalid_query' };
  for (const token of query.tokens) {
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, code: 'invalid_query' };
  }
  return { ok: true, query };
}
