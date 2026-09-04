/**
 * The Kitchen Codex — Ask My Kitchen Natural-Language Query Interpreter
 * (v0.4.0 Step 2)
 *
 * This is a THIN interpretation boundary between natural language and the
 * deterministic Step 1 retrieval engine. It turns a question into a structured
 * `KitchenQuery` so `searchKitchenRecipes` remains the ONLY authority on which
 * recipes exist or match.
 *
 * PRODUCT RULES HONORED:
 *   - The interpreter only produces QUERY STRUCTURE. It never returns recipes,
 *     never invents ingredients, never infers recipe metadata, never suggests
 *     substitutions, never generates IDs it was not told, and never does web
 *     search or answer the question.
 *   - AI is OPTIONAL and always wrapped by deterministic sanitization. The model
 *     output is untrusted DATA: every field is coerced/validated here, unknown
 *     fields are dropped, and the model can never bypass the schema.
 *   - The Step 1 engine remains authoritative for ingredient identity. This layer
 *     does NOT normalize/fuzzy-fold ingredients ("cream" stays "cream"; it is
 *     never turned into "cream cheese"). Exact user-provided terms are preserved
 *     for Step 1 to resolve deterministically.
 *   - PROVENANCE NEUTRALITY: the interpreter never claims a value was
 *     "user-declared" or "from your vault". It only emits filter constraints.
 *   - PRIVACY: this module takes ONLY the user's question. It never touches
 *     recipe/vault data; no recipe content passes through interpretation.
 *   - Pure & local: no network, no Gemini import, no server request. The AI
 *     adapter is INJECTED (`InterpretDeps.aiInterpret`) so the orchestration is
 *     hermetically testable and the Gemini dependency stays server-side only.
 */

import type { KitchenQuery } from './kitchenSearch';

export type InterpretationSource = 'ai' | 'deterministic';

/**
 * The result of interpreting a natural-language question. On success `query`
 * holds a validated `KitchenQuery`; on failure it is `undefined` with `error`.
 * `source` records whether the query came from the AI adapter or the
 * deterministic fallback parser.
 */
export interface KitchenQueryInterpretation {
  ok: boolean;
  query?: KitchenQuery;
  error?: string;
  source: InterpretationSource;
}

/** Injected dependencies so the orchestration can be tested without network. */
export interface InterpretDeps {
  /**
   * AI structured-output adapter. Receives the question verbatim and must return
   * a JSON-serializable value (or throw). Its output is validated by
   * `sanitizeInterpretedQuery`; it is treated as untrusted data.
   */
  aiInterpret?: (question: string) => unknown | Promise<unknown>;
}

export const MAX_QUESTION_LENGTH = 500;
const MAX_ARRAY_ITEMS = 60;
const MAX_STRING_LEN = 120;
const MAX_TEXT_FIELD_LEN = 200;

/** String-list fields that map to `KitchenQuery` arrays. */
const ARRAY_FIELDS = [
  'includeIngredients',
  'excludeIngredients',
  'tags',
  'cuisines',
  'courses',
  'difficulties',
] as const;

/** Non-negative integer minute-bounds that map to `KitchenQuery` numbers. */
const NUM_FIELDS = ['maxPrepMinutes', 'maxCookMinutes', 'maxTotalMinutes'] as const;

const QUERY_FIELD_KEYS = new Set<string>([
  ...ARRAY_FIELDS,
  ...NUM_FIELDS,
  'minRating',
  'favoritesOnly',
  'similarToRecipeId',
  'limit',
  'text',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAnyQueryField(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((key) => QUERY_FIELD_KEYS.has(key));
}

/** Trims, drops empties, dedupes (case-insensitive), and caps a string list. */
function toStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (item === null || item === undefined) continue;
    let str: string;
    if (typeof item === 'string') str = item;
    else if (typeof item === 'number') str = String(item);
    else continue;
    const trimmed = str.trim().slice(0, MAX_STRING_LEN);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

/** A whole non-negative minute number, or undefined for invalid/negative/NaN/Inf. */
function toNonNegativeMinutes(value: unknown): number | undefined {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num)) return undefined;
  if (num < 0) return undefined;
  // Minutes are whole; a fractional bound is rounded deterministically.
  return Math.round(num);
}

/** A whole rating in 1..5, or undefined when invalid. No clamping. */
function toMinRating(value: unknown): number | undefined {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num)) return undefined;
  // Rating scale is 0..5; a minimum must be a whole 1..5 (0 is a no-op, >5 invalid).
  if (!Number.isInteger(num) || num < 1 || num > 5) return undefined;
  return num;
}

/**
 * Deterministically validates/sanitizes a raw model (or any) object into a
 * `KitchenQuery`. Only known fields are copied; every value is coerced and
 * constrained; unknown fields are ignored; the raw input is never mutated.
 *
 * Sanitizer rules:
 *   - strings trimmed, empties removed, arrays deduped (case-insensitive) + capped
 *   - minute bounds: whole, finite, non-negative; NaN / Infinity / negative dropped
 *   - minRating: whole number 1..5; anything else dropped (no clamping)
 *   - favoritesOnly: only a literal `true` is honored
 *   - similarToRecipeId: a trimmed non-empty string is passed through
 *   - limit: whole non-negative number; negative / NaN -> omitted (Step 1 "no limit")
 *   - `text` is intentionally dropped (reserved for Step 1, not a filter here)
 */
export function sanitizeInterpretedQuery(rawInput: unknown): KitchenQuery {
  let raw = rawInput;

  // Very cheap unwrap for the single common wrapper shape ({ query: {...} } or
  // { kitchenQuery: {...} }) so a model that wraps despite a flat schema is fine.
  if (
    isPlainObject(raw) &&
    isPlainObject(raw['query']) &&
    !hasAnyQueryField(raw)
  ) {
    raw = raw['query'];
  } else if (
    isPlainObject(raw) &&
    isPlainObject(raw['kitchenQuery']) &&
    !hasAnyQueryField(raw)
  ) {
    raw = raw['kitchenQuery'];
  }

  if (!isPlainObject(raw)) return {};

  const query: KitchenQuery = {};

  for (const field of ARRAY_FIELDS) {
    const arr = toStringArray(raw[field], MAX_ARRAY_ITEMS);
    if (arr) (query as Record<string, unknown>)[field] = arr;
  }

  for (const field of NUM_FIELDS) {
    const minutes = toNonNegativeMinutes(raw[field]);
    if (minutes !== undefined) (query as Record<string, unknown>)[field] = minutes;
  }

  const minRating = toMinRating(raw['minRating']);
  if (minRating !== undefined) query.minRating = minRating;

  if (raw['favoritesOnly'] === true) query.favoritesOnly = true;

  if (typeof raw['similarToRecipeId'] === 'string') {
    const id = raw['similarToRecipeId'].trim().slice(0, MAX_TEXT_FIELD_LEN);
    if (id) query.similarToRecipeId = id;
  }

  const limit = toNonNegativeMinutes(raw['limit']);
  if (limit !== undefined) query.limit = limit;

  return query;
}

/** True when a query carries at least one actionable retrieval constraint. */
export function isMeaningfulQuery(query: KitchenQuery): boolean {
  // `limit` alone is bookkeeping, not a retrieval intent, so it is deliberately
  // NOT counted: a query with only a limit is not meaningful by itself.
  return Boolean(
    (query.includeIngredients && query.includeIngredients.length > 0) ||
      (query.excludeIngredients && query.excludeIngredients.length > 0) ||
      (query.tags && query.tags.length > 0) ||
      (query.cuisines && query.cuisines.length > 0) ||
      (query.courses && query.courses.length > 0) ||
      (query.difficulties && query.difficulties.length > 0) ||
      query.maxPrepMinutes !== undefined ||
      query.maxCookMinutes !== undefined ||
      query.maxTotalMinutes !== undefined ||
      query.minRating !== undefined ||
      query.favoritesOnly === true ||
      (typeof query.similarToRecipeId === 'string' &&
        query.similarToRecipeId.length > 0)
  );
}

export function isEmptyInterpretedQuery(query: KitchenQuery): boolean {
  return !isMeaningfulQuery(query);
}

// ---------------------------------------------------------------------------
// Conservative deterministic fallback parser (optional, very limited)
// ---------------------------------------------------------------------------
// This deliberately handles only extremely obvious, low-risk patterns. It is a
// fallback for when AI is unavailable; it is NOT a pseudo-NLP system and it is
// intentionally conservative (it never invents thresholds such as "quick"->30
// minutes or "healthy"->nutritional filters).

const CUISINE_MAP: ReadonlyArray<readonly [string, string]> = [
  ['italian', 'Italian'],
  ['mexican', 'Mexican'],
  ['thai', 'Thai'],
  ['japanese', 'Japanese'],
  ['chinese', 'Chinese'],
  ['french', 'French'],
  ['indian', 'Indian'],
  ['greek', 'Greek'],
  ['american', 'American'],
  ['spanish', 'Spanish'],
  ['korean', 'Korean'],
  ['vietnamese', 'Vietnamese'],
  ['mediterranean', 'Mediterranean'],
  ['moroccan', 'Moroccan'],
] as const;

// Only unambiguous course terms (ambiguous ingredient/course words like
// "soup"/"salad"/"bread"/"pasta" are intentionally NOT folded by the fallback).
const COURSE_MAP: ReadonlyArray<readonly [string, string]> = [
  ['dessert', 'Dessert'],
  ['desserts', 'Dessert'],
  ['breakfast', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
  ['appetizer', 'Appetizer'],
  ['appetizers', 'Appetizer'],
  ['snack', 'Snack'],
  ['snacks', 'Snack'],
  ['main course', 'Main Course'],
  ['entree', 'Main Course'],
] as const;

const DIFFICULTY_MAP: ReadonlyArray<readonly [string, string]> = [
  ['easy', 'Easy'],
  ['simple', 'Easy'],
  ['simplest', 'Easy'],
  ['beginner', 'Easy'],
  ['hard', 'Hard'],
  ['challenging', 'Hard'],
  ['advanced', 'Hard'],
  ['expert', 'Hard'],
] as const;

// "hard"/"easy" are common cooking-preparation words ("hard boiled eggs",
// "over easy eggs"). When a difficulty word is part of one of these culinary
// phrases it must NOT be folded into a difficulty filter.
const DIFFICULTY_PHRASE_EXCLUSIONS: Record<string, RegExp> = {
  hard: /\bhard[\s-]?boiled\b/i,
  easy: /\b(?:over\s+easy|easy\s+over)\b/i,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(text);
}

/** Splits a captured ingredient phrase into discrete conservative terms. */
function splitTerms(phrase: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of phrase.split(/\s+(?:and|or)\s+|,|&/i)) {
    const term = raw
      .replace(/[.,;:!?]+$/g, '')
      .replace(/^\s*(?:with|without|no|excluding)\s+/i, '')
      .trim()
      .slice(0, MAX_STRING_LEN);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_ARRAY_ITEMS) break;
  }
  return out;
}

function findTerms(text: string, keywordPattern: RegExp, stop: string): string[] {
  const pattern = new RegExp(
    `${keywordPattern.source}\\s+([^.;!?]+?)(?=\\s+(?:${stop})\\b|\\.|!|\\?|$)`,
    'i'
  );
  const match = text.match(pattern);
  if (!match || !match[1]) return [];
  return splitTerms(match[1]);
}

/**
 * Conservative deterministic parser for a small set of extremely obvious
 * question patterns. Returns a (possibly empty) `KitchenQuery`; callers should
 * treat an empty result as "no confident interpretation".
 */
export function deterministicInterpret(question: string): KitchenQuery {
  const text = String(question ?? '').trim();
  const q: KitchenQuery = {};
  if (!text) return q;
  const lower = text.toLowerCase();

  // --- Ingredient include / exclude (exact user terms only) ---
  // `for` is a conservative clause boundary ("with chicken for dinner" -> "chicken").
  const includeStop =
    'but|without|excluding|no|for|under|less than|within|rated|rating|at least|minimum|favorite|similar';
  const excludeStop =
    'but|with|for|under|less than|within|rated|rating|at least|minimum|favorite|similar';

  const includes = findTerms(lower, /\bwith\b/, includeStop);
  const exceptWithout = findTerms(lower, /\bwithout\b/, excludeStop);
  const exceptExcluding = findTerms(lower, /\bexcluding\b/, excludeStop);

  // "but no milk" / "but without milk" -> exclude.
  const butNo = lower.match(/\bbut\s+(?:no|without|not)\s+([^.;!?]+?)(?=\s+but\b|\s+with\b|\s+under\b|\s+less than\b|\s+within\b|\s+rated\b|\s+at least\b|\s+minimum\b|\s+favorite\b|\.|!|\?|$)/i);
  let excludes = [...exceptWithout, ...exceptExcluding];
  if (butNo && butNo[1]) excludes = [...excludes, ...splitTerms(butNo[1])];

  // Dedupe excludes (case-insensitive) and remove any include term that also
  // appears as an exclude (exclusion wins).
  const dedupeCaseInsensitive = (items: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };
  excludes = dedupeCaseInsensitive(excludes);
  const excludeSet = new Set(excludes.map((s) => s.toLowerCase()));
  const cleanedIncludes = dedupeCaseInsensitive(includes).filter(
    (s) => !excludeSet.has(s.toLowerCase())
  );

  if (cleanedIncludes.length) q['includeIngredients'] = cleanedIncludes;
  if (excludes.length) q['excludeIngredients'] = excludes;

  // --- Time bounds ---
  let remainingTime = lower;
  const prepMatch = remainingTime.match(/\bprep(?:\s*time)?\s+(?:under|less than|within)\s+(\d+)/i);
  if (prepMatch) {
    const v = toNonNegativeMinutes(prepMatch[1]);
    if (v !== undefined) q.maxPrepMinutes = v;
    remainingTime = remainingTime.replace(prepMatch[0], '');
  }
  const cookMatch = remainingTime.match(/\bcook(?:\s*time)?\s+(?:under|less than|within)\s+(\d+)/i);
  if (cookMatch) {
    const v = toNonNegativeMinutes(cookMatch[1]);
    if (v !== undefined) q.maxCookMinutes = v;
    remainingTime = remainingTime.replace(cookMatch[0], '');
  }
  const totalMatch =
    remainingTime.match(/\b(?:total\s*time|total)\s+(?:under|less than|within)\s+(\d+)/i) ||
    remainingTime.match(/(?:under|less than|within)\s+(\d+)/i) ||
    remainingTime.match(/(\d+)\s*(?:minutes?|mins?|min)?\s*(?:or less|or fewer)\b/i);
  if (totalMatch) {
    const v = toNonNegativeMinutes(totalMatch[1]);
    if (v !== undefined && q.maxPrepMinutes === undefined && q.maxCookMinutes === undefined) {
      q.maxTotalMinutes = v;
    }
  }

  // --- min rating ---
  // Rating context is REQUIRED. A bare "at least N" / "minimum N" is never a
  // rating ("at least 2 servings", "minimum 4 people" are counts, not ratings),
  // so only explicit rating/star phrasing counts.
  let minRating: number | undefined;
  for (const pattern of [
    /\b(?:rated|rating)\s+(?:at\s+)?(?:least\s+)?(\d+)\b/i,
    /\b(\d+)\s*(?:or more|\+)?\s*stars?\b/i,
    /\b(\d+)\s*\/\s*5\b/i,
  ]) {
    const m = lower.match(pattern);
    if (m) {
      const v = toMinRating(m[1]);
      if (v !== undefined) {
        minRating = v;
        break;
      }
    }
  }
  if (minRating !== undefined) q.minRating = minRating;

  // --- favorites ---
  // Require saved-recipe intent. The plural "favorites" always refers to the
  // saved list ("my favorites"); a singular "favorite" only counts when the
  // question also references "recipe(s)". Generic "favorite ingredient" /
  // "my favorite thing to cook" must NOT trigger favoritesOnly.
  if (/\bfavorites\b/i.test(lower) || (/\bfavorite\b/i.test(lower) && /\brecipes?\b/i.test(lower))) {
    q.favoritesOnly = true;
  }

  // --- cuisines ---
  const cuisines: string[] = [];
  for (const [key, canonical] of CUISINE_MAP) {
    if (containsPhrase(lower, key)) cuisines.push(canonical);
  }
  if (cuisines.length) q.cuisines = Array.from(new Set(cuisines));

  // --- courses ---
  const courses: string[] = [];
  for (const [key, canonical] of COURSE_MAP) {
    if (containsPhrase(lower, key)) courses.push(canonical);
  }
  if (courses.length) q.courses = Array.from(new Set(courses));

  // --- difficulty ---
  const difficulties: string[] = [];
  for (const [key, canonical] of DIFFICULTY_MAP) {
    if (DIFFICULTY_PHRASE_EXCLUSIONS[key]?.test(lower)) continue;
    if (containsPhrase(lower, key)) difficulties.push(canonical);
  }
  if (difficulties.length) q.difficulties = Array.from(new Set(difficulties));

  return q;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Interprets a natural-language question into a validated `KitchenQuery`.
 *
 * Precedence: if an AI adapter is supplied, its output is sanitized first; a
 * usable sanitized query wins. Otherwise (or on AI failure/empty output) the
 * conservative deterministic parser runs. If neither yields a meaningful query,
 * a safe failure is returned — the question is never turned into an ingredient
 * query, and no recipes are ever produced here.
 */
export async function interpretKitchenQuery(
  question: string,
  deps: InterpretDeps = {}
): Promise<KitchenQueryInterpretation> {
  const text = String(question ?? '').trim();

  if (!text) {
    return { ok: false, source: 'deterministic', error: 'Question is empty.' };
  }
  if (text.length > MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      source: 'deterministic',
      error: `Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters.`,
    };
  }

  if (deps.aiInterpret) {
    try {
      const raw = await deps.aiInterpret(text);
      const query = sanitizeInterpretedQuery(raw);
      if (isMeaningfulQuery(query)) {
        return { ok: true, query, source: 'ai' };
      }
    } catch {
      // AI failure -> fall through to the deterministic path.
    }
  }

  const deterministic = deterministicInterpret(text);
  if (isMeaningfulQuery(deterministic)) {
    return { ok: true, query: deterministic, source: 'deterministic' };
  }

  return {
    ok: false,
    source: 'deterministic',
    error: 'Could not interpret the question into a structured recipe query.',
  };
}
