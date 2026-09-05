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
import type {
  KitchenIntent,
  KitchenIntentPreferences,
  KitchenIntentReference,
  KitchenIntentType,
  KitchenSource,
} from './kitchenIntent';
import { sanitizeKitchenIntent, isMeaningfulKitchenIntent } from './kitchenIntent';

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
  /**
   * True when an AI adapter was present for this question (the interpreter
   * attempted the AI path rather than running deterministic-only), whether or
   * not it succeeded.
   */
  aiAttempted?: boolean;
  /**
   * True when an AI adapter was present AND it did not yield a usable query (it
   * threw, returned something unusable, or returned a non-meaningful query), so
   * a downstream failure is an upstream/AI failure rather than the wording.
   */
  aiFailed?: boolean;
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
 * Converts a captured time number + optional unit word to whole minutes. A bare
 * number ("under 30") defaults to minutes; an explicit hour unit ("under 1 hour")
 * is scaled to 60 so hour-based questions are not silently treated as 1 minute.
 */
function minutesFromBound(numberStr: string, unit: string | undefined): number | undefined {
  const num = Number(numberStr);
  if (!Number.isFinite(num) || num < 0) return undefined;
  const u = String(unit ?? '').trim().toLowerCase();
  if (u.startsWith('hour') || u === 'hr' || u === 'hrs') return Math.round(num * 60);
  return Math.round(num);
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
//
// RELIABILITY RULES (v0.4.1):
//   - Possession and verb leads ("I have ...", "use(s)/using/contain(ing)") are
//     context-sensitive: reference phrases ("recipes like this", "this recipe
//     often"), generic non-food nouns ("time", "ideas"), and meta-object nouns
//     ("instructions", "notes", "steps", "photos") are never ingredients.
//   - Dangling conjunctions ("tomatoes and") are stripped.
//   - "<food noun> recipes" plainly names the subject (chicken/beef/...), so it
//     is kept together with any time bound rather than silently dropped.
//   - An UNSUPPORTED dish-family subject ("salad recipes"/"soup recipes"/
//     "pizza recipes"/...) that cannot be expressed as an ingredient is guarded:
//     if no supported ingredient was captured, the query is forced non-meaningful
//     so a surviving time/rating/favorites constraint never silently broadens the
//     user's intent to "everything in N minutes".
//
// KNOWN LIMITATION (documented honestly): dish-family subjects that are NOT
// ingredients — "salad recipes", "soup recipes" — have no dish-family filter in
// KitchenQuery yet, so they cannot be faithfully retrieved; the parser fails
// safely rather than silently broadening. Richer intent modelling is v0.5.0
// territory (the AI-driven KitchenIntent model).

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
  ['breakfasts', 'Breakfast'],
  ['brunch', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['lunches', 'Lunch'],
  ['dinner', 'Dinner'],
  ['dinners', 'Dinner'],
  ['appetizer', 'Appetizer'],
  ['appetizers', 'Appetizer'],
  ['snack', 'Snack'],
  ['snacks', 'Snack'],
  ['main course', 'Main Course'],
  ['entree', 'Main Course'],
  ['entrees', 'Main Course'],
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
      // Strip dangling conjunctions so "tomatoes and" -> "tomatoes" (not "and"),
      // and never let a bare "and"/"or"/"&" survive as an ingredient term.
      .replace(/\s*(?:and|or|&)$/i, '')
      .replace(/^(?:and|or|&)\s*/i, '')
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

// Clause boundaries for the "I have X" possession pattern. `and`/`or` stay OUT so
// they only join ingredients ("chicken and rice"); everything else terminates the
// ingredient clause so a trailing "what can I cook?" never pollutes the terms.
const HAVE_STOP =
  'with|but|without|excluding|for|in|under|less than|within|rated|rating|at least|minimum|favorite|similar|that|which|is|are|was|were|can|could|should|would|need|want|to|cook|make|left|ready|tonight|today|now|right|there|what|how|when|where|if|who';

/**
 * Captures the ingredient phrase after a possession lead ("I have X", "we have
 * X") for the obvious "I have chicken and rice, what can I cook?" phrasing.
 * The clause is bounded by a leading subject + `have` and by clause markers, so
 * it stays conservative: "Do I have anything with beef?" stops at `with` and
 * yields nothing here (the `with` extractor owns that one).
 */
function findHaveTerms(text: string): string[] {
  const pattern = new RegExp(
    `\\b(?:i|we|you|they)\\s+have\\s+([^.;!?]+?)(?=\\s+(?:${HAVE_STOP})\\b|\\s*,|\\s*\\.\\b|\\s*!|\\s*\\?|$)`,
    'i'
  );
  const match = text.match(pattern);
  if (!match || !match[1]) return [];
  return splitTerms(match[1]);
}

// Words the conservative fallback never treats as a requested ingredient: they
// are deictic/connective, generic-topic, or vague-qualifier words that slip in
// around a captured clause and would otherwise become a bogus filter.
const DISCARD_INGREDIENT_TERMS: ReadonlySet<string> = new Set([
  'anything', 'something', 'nothing', 'everything', 'any', 'some', 'all', 'many',
  'few', 'what', 'which', 'that', 'this', 'these', 'those', 'it', 'them',
  'there', 'here', 'stuff', 'thing', 'things', 'food', 'foods', 'ingredient',
  'ingredients', 'dish', 'dishes', 'recipe', 'recipes', 'meal', 'meals', 'left',
  'ready', 'quick', 'easy', 'fast', 'healthy', 'good', 'great', 'delicious',
  'nice', 'today', 'tonight', 'now', 'right', 'on', 'at', 'in', 'of', 'to',
  'from', 'with', 'without', 'for', 'and', 'or', 'but', 'can', 'could',
  'should', 'would', 'need', 'want', 'make', 'makes', 'cook', 'cooks', 'using',
  'use', 'uses', 'have', 'has', 'got', 'dinner', 'lunch', 'breakfast',
  'brunch', 'dessert', 'desserts', 'appetizer', 'snack', 'entree', 'main',
  'course', 'side',
  // Clearly NON-food generic/meta nouns: these are never an ingredient request
  // ("I have time for dinner", "contains instructions/notes/steps/photos").
  'time', 'idea', 'ideas', 'instruction', 'instructions', 'note', 'notes',
  'step', 'steps', 'photo', 'photos',
]);

/**
 * Reference/discourse words that mark a captured noun-phrase as NOT a food
 * ingredient: "recipes like this", "anything similar", "this recipe often",
 * "a few ideas". If ANY word of a captured term is in this set, the term is not
 * an ingredient request. Deliberately excludes determiners that prefix real
 * ingredients ("some chicken", "these beans") so they are never dropped.
 */
const DISCARD_REFERENCE_WORDS: ReadonlySet<string> = new Set([
  'this', 'that', 'these', 'those', 'it', 'its',
  'something', 'anything', 'nothing', 'everything',
  'like', 'similar',
  'recipe', 'recipes', 'dish', 'dishes', 'meal', 'meals',
  'food', 'foods', 'stuff', 'thing', 'things', 'idea', 'ideas', 'time',
]);

function isDiscardIngredientTerm(term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  if (DISCARD_INGREDIENT_TERMS.has(t)) return true;
  // A term that ends in a generic topic noun ("chicken recipes", "any mexican
  // recipes") is not a bare ingredient; that intent is handled by the
  // cuisine/course logic, not an ingredient filter.
  if (/\b(?:recipes?|dishes?|meals?|dinners?|desserts?|breakfasts?|lunches?|entrees?|appetizers?|snacks?|courses?)$/.test(t)) {
    return true;
  }
  // A term whose whole words are cuisine/course words ("mexican dinner") is a
  // topical phrase, not an ingredient.
  const words = t.split(/\W+/).filter(Boolean);
  const topicalWords = new Set<string>();
  for (const [, canonical] of CUISINE_MAP) topicalWords.add(canonical.toLowerCase());
  for (const [, canonical] of COURSE_MAP) topicalWords.add(canonical.toLowerCase());
  if (words.length && words.every((w) => topicalWords.has(w))) return true;
  // Reference/discourse markers ("this/that/it/similar/like/recipe/...") or
  // clearly non-food generic nouns never denote an ingredient. This is a
  // structural rule, not a fuzzy ingredient blacklist.
  if (words.some((w) => DISCARD_REFERENCE_WORDS.has(w))) return true;
  // A predicative/descriptive remark ("too heavy", "another taco") is not an
  // ingredient to exclude; it is a qualitative or dish-reference phrase.
  if (/^too\s+\w+\s*$/i.test(t)) return true;
  if (/^another\s+\w+\s*$/i.test(t)) return true;
  return false;
}

/**
 * Dish-family recipe-subject phrases that KitchenQuery CANNOT faithfully
 * represent (there is no dish-family field). A phrase like "salad recipes"
 * names the recipe subject, but the only way the current query could express
 * it would be a bogus ingredient ("salad"/"soup"), so the deterministic parser
 * must NOT let a surviving secondary constraint (time/rating/favorites/excl./…)
 * silently broaden the user's intent. Cake/breakfast-style words that already map
 * to `courses` (e.g. "dessert", "breakfast", "dinner") are intentionally NOT in
 * this set.
 */
const UNSUPPORTED_DISH_SUBJECT_PATTERN =
  /\b(?:salad|soup|stew|chili|casserole|burger|sandwich|pizza|pasta|cake|cookie|pie)s?\s+recipes?\b/i;

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
  // `for` and `in` are conservative clause boundaries
  // ("with chicken for dinner" -> "chicken"; "with rice in under 30" -> "rice").
  // `that`/`which`/`takes`/etc. keep a clause from over-capturing ("with
  // chocolate that takes under an hour" -> "chocolate", not "chocolate that
  // takes"). The possession ("I have ...") and verb ("using"/"use(s)"/"contain")
  // leads are the natural-language phrasings people actually use.
  const includeStop =
    'but|without|excluding|no|for|in|under|less than|within|rated|rating|at least|minimum|favorite|similar|that|which|is|are|was|were|takes|take|has|have|had|left|ready';
  const excludeStop =
    'but|with|for|in|under|less than|within|rated|rating|at least|minimum|favorite|similar';

  const includes = [
    ...findTerms(lower, /\bwith\b/, includeStop),
    ...findTerms(lower, /\busing\b/, includeStop),
    ...findTerms(lower, /\buse\b/, includeStop),
    ...findTerms(lower, /\buses\b/, includeStop),
    ...findTerms(lower, /\bcontain(?:s|ing)?\b/, includeStop),
    ...findHaveTerms(lower),
  ];

  // Recipe-SUBJECT food noun: "<protein> recipes" clearly names the recipe
  // subject and thus implies that ingredient ("What chicken recipes can I make
  // in under 30 minutes?" -> chicken). Only unambiguous INGREDIENT nouns are
  // accepted; dish-type subjects ("salad recipes"/"soup recipes") are NOT
  // ingredients and are deliberately left unhandled here (see the documented
  // limitation in the module doc / v0.5.0 intent model).
  const subjectFood = lower.match(/\b(chicken|beef|pork|turkey|steak|fish|shrimp|salmon|tofu|lamb)\s+recipes?\b/i);
  if (subjectFood && subjectFood[1]) includes.push(subjectFood[1]);

  const exceptWithout = findTerms(lower, /\bwithout\b/, excludeStop);
  const exceptExcluding = findTerms(lower, /\bexcluding\b/, excludeStop);

  // "but no milk" / "but without milk" -> exclude. `in`/`for` are conservative
  // clause boundaries ("but no milk in the fridge" -> "milk").
  const butNo = lower.match(/\bbut\s+(?:no|without|not)\s+([^.;!?]+?)(?=\s+but\b|\s+with\b|\s+in\b|\s+for\b|\s+under\b|\s+less than\b|\s+within\b|\s+rated\b|\s+at least\b|\s+minimum\b|\s+favorite\b|\.|!|\?|$)/i);
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
  const cleanedExcludes = dedupeCaseInsensitive(excludes).filter((s) => !isDiscardIngredientTerm(s));
  const excludeSet = new Set(cleanedExcludes.map((s) => s.toLowerCase()));
  const cleanedIncludes = dedupeCaseInsensitive(includes).filter(
    (s) => !excludeSet.has(s.toLowerCase()) && !isDiscardIngredientTerm(s)
  );

  if (cleanedIncludes.length) q['includeIngredients'] = cleanedIncludes;
  if (cleanedExcludes.length) q['excludeIngredients'] = cleanedExcludes;

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
    remainingTime.match(/\b(?:total\s+time\s+)?(?:under|less than|within|in)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|min)?\b/i) ||
    remainingTime.match(/(\d+)\s*(?:hours?|hrs?|minutes?|mins?|min)\b/i) ||
    remainingTime.match(/(\d+)\s*(?:or less|or fewer)\b/i);
  if (totalMatch) {
    const v = minutesFromBound(totalMatch[1], totalMatch[2]);
    if (v !== undefined && q.maxPrepMinutes === undefined && q.maxCookMinutes === undefined) {
      q.maxTotalMinutes = v;
    }
  }

  // Unit-word time bounds ("less than an hour") mostly appear as the bare total
  // bound and carry no prep/cook qualifier; map only the unambiguous hour unit.
  if (
    q.maxPrepMinutes === undefined &&
    q.maxCookMinutes === undefined &&
    q.maxTotalMinutes === undefined
  ) {
    const hourMatch = remainingTime.match(/\b(?:under|less than|within|in)\s+(?:an?\s+|one\s+)?hour\b/i);
    if (hourMatch) {
      q.maxTotalMinutes = 60;
    } else {
      const halfHour = remainingTime.match(/\b(?:under|less than|within|in)\s+(?:a\s+)?half(?:\s+an?)?\s+hour\b/i);
      if (halfHour) q.maxTotalMinutes = 30;
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

  // --- Unsupported dish-family subject guard ---
  // If the question explicitly names an unsupported dish-family subject
  // ("salad recipes"/"soup recipes"/"pizza recipes"/…) AND we captured NO
  // supported ingredient, then any surviving constraint (time/rating/favorites/
  // excludes/…) would silently broaden the intent to "everything in 30 min".
  // Fail safely by returning a non-meaningful query.
  if (
    UNSUPPORTED_DISH_SUBJECT_PATTERN.test(lower) &&
    !(q.includeIngredients && q.includeIngredients.length > 0)
  ) {
    return {};
  }

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

  let aiAttempted = false;
  let aiFailed = false;

  if (deps.aiInterpret) {
    aiAttempted = true;
    try {
      const raw = await deps.aiInterpret(text);
      const query = sanitizeInterpretedQuery(raw);
      if (isMeaningfulQuery(query)) {
        return { ok: true, query, source: 'ai', aiAttempted, aiFailed: false };
      }
      // AI responded but produced no usable constraint -> it is effectively a
      // failed interpretation, not an unresolvable wording.
      aiFailed = true;
    } catch {
      // AI failure -> fall through to the deterministic path.
      aiFailed = true;
    }
  }

  const deterministic = deterministicInterpret(text);
  if (isMeaningfulQuery(deterministic)) {
    return { ok: true, query: deterministic, source: 'deterministic', aiAttempted, aiFailed };
  }

  return {
    ok: false,
    source: 'deterministic',
    error: 'Could not interpret the question into a structured recipe query.',
    aiAttempted,
    aiFailed,
  };
}

// ---------------------------------------------------------------------------
// v0.5.0 — Semantic (KitchenIntent) interpretation
// ---------------------------------------------------------------------------
// This is the migration layer that produces a `KitchenIntent` instead of a raw
// `KitchenQuery`. It reuses the existing, conservative deterministic parser for
// the HARD constraints (never turning the fallback into a fuzzy NLP system) and
// adds a thin semantic label (intent type / source / references). The AI adapter
// is injected and its output is always wrapped by `sanitizeKitchenIntent`.
//
// TRUST: the interpretation result is SANITIZED semantic intent only. It contains
// no trusted recipe identities (targetRecipeId / similarToRecipeId / ... are
// stripped by `sanitizeKitchenIntent`). Trusted-context resolution + execution
// readiness happen on the CLIENT via `prepareKitchenIntentForExecution`.

/** A semantic (KitchenIntent) interpretation result. */
export interface KitchenIntentInterpretation {
  ok: boolean;
  intent?: KitchenIntent;
  error?: string;
  source: InterpretationSource;
  aiAttempted?: boolean;
  aiFailed?: boolean;
}

/** Injected dependencies for the semantic interpreter. */
export type InterpretIntentDeps = InterpretDeps;

// Small, conservative semantic cue sets — NOT a general NLP grammar.
const SIMILAR_CUE = /\b(similar to|like this|something like this|recipes? like this|resembling this)\b/i;
const ONLINE_CUE = /\b(online|on the web|from the web|on the internet|internet)\b/i;
const WEB_VERB_CUE = /\b(find|look|search|get|pick|show|browse|discover)\b/i;
const MEAL_SUGGESTION_CUE = /\b(today|tonight|what should i (make|cook|eat|have)|what can i (make|cook|eat|have)|i'?m hungry|im hungry|for (dinner|lunch|breakfast|dessert|brunch)|this week|tonight)\b/i;

/**
 * Produces a `KitchenIntent` from the existing deterministic fallback. Hard
 * constraints come from `deterministicInterpret`; a thin semantic label is added
 * conservatively (never inventing fuzzy preferences, never escalating to web
 * unless an explicit online cue is present).
 */
export function deterministicKitchenIntent(question: string): KitchenIntent {
  const text = String(question ?? '').trim();
  const lower = text.toLowerCase();
  const constraints = deterministicInterpret(text);

  let intent: KitchenIntentType = 'find_recipes';
  let source: KitchenSource = 'vault';
  let references: KitchenIntentReference | undefined;
  const preferences: KitchenIntentPreferences = {};

  if (SIMILAR_CUE.test(lower)) {
    intent = 'similar_recipe';
    references = { currentRecipe: true };
    source = 'vault';
  } else if (ONLINE_CUE.test(lower) && WEB_VERB_CUE.test(lower)) {
    intent = 'discover_online';
    source = 'web';
  } else if (MEAL_SUGGESTION_CUE.test(lower) && !isMeaningfulQuery(constraints)) {
    intent = 'meal_suggestion';
    source = 'vault';
  } else {
    // Default: a find-recipes request stays vault-local.
    intent = 'find_recipes';
    source = 'vault';
  }

  return {
    version: 1,
    intent,
    source,
    constraints,
    preferences,
    ...(references ? { references } : {}),
    requiresClarification: false,
  };
}

/**
 * Interprets a question into a SANITIZED `KitchenIntent`.
 *
 * Precedence is identical to the v0.4.1 query interpreter: if an AI adapter is
 * supplied and yields a usable (sanitized, meaningful) intent it wins; otherwise
 * (or on AI failure) the conservative deterministic semantic fallback runs; if
 * neither is meaningful the request fails safely. `aiAttempted` / `aiFailed`
 * preserve the existing reliability contract.
 */
export async function interpretKitchenIntent(
  question: string,
  deps: InterpretIntentDeps = {}
): Promise<KitchenIntentInterpretation> {
  const text = String(question ?? '').trim();

  if (!text) return { ok: false, source: 'deterministic', error: 'Question is empty.' };
  if (text.length > MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      source: 'deterministic',
      error: `Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters.`,
    };
  }

  let aiAttempted = false;
  let aiFailed = false;

  if (deps.aiInterpret) {
    aiAttempted = true;
    try {
      const raw = await deps.aiInterpret(text);
      const intent = sanitizeKitchenIntent(raw);
      if (intent && isMeaningfulKitchenIntent(intent)) {
        return { ok: true, intent, source: 'ai', aiAttempted, aiFailed: false };
      }
      aiFailed = true;
    } catch {
      aiFailed = true;
    }
  }

  const deterministic = deterministicKitchenIntent(text);
  if (isMeaningfulKitchenIntent(deterministic)) {
    return { ok: true, intent: deterministic, source: 'deterministic', aiAttempted, aiFailed };
  }

  return {
    ok: false,
    source: 'deterministic',
    error: 'Could not interpret the question into a structured kitchen intent.',
    aiAttempted,
    aiFailed,
  };
}
