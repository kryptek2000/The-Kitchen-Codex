/**
 * The Kitchen Codex — Ask My Kitchen Grounded Conversational Answer Layer
 * (v0.4.0 Step 3)
 *
 * This is the grounded answer boundary. It turns a user question, its sanitized
 * `KitchenQuery`, and the DETERMINISTIC retrieval results into a natural,
 * useful, but strictly vault-bounded answer. The model only explains the
 * retrieved evidence; it does not own which recipes are relevant.
 *
 * PRODUCT RULES HONORED:
 *   - RETRIEVAL IS AUTHORITATIVE: the answer layer may only reference recipe
 *     identities present in the retrieved result set (allowlist). It never adds
 *     recipes, invents names, re-searches, widens filters, recommends external
 *     recipes, or fabricates substitutions/metadata/times/ratings.
 *   - STRUCTURED EVIDENCE: compact per-recipe evidence is derived from
 *     `KitchenSearchResult`; no full Markdown, notes, frontmatter, or raw
 *     instructions are transmitted.
 *   - GROUNDING-FIRST (Step 3): the final user-visible answer is ALWAYS
 *     deterministic — full retrieved membership in Step 1 order, a deterministic
 *     summary count from `evidence.length`, and evidence-backed per-recipe
 *     explanations. The optional AI adapter is retained for future safe phrasing
 *     but is NOT surfaced in Step 3 output, guaranteeing zero unsupported recipe
 *     claims. Untrusted-model-output plumbing (`sanitizeKitchenAnswer`,
 *     `orderItemsByEvidence`, allowlist) is still present and testable for when
 *     it is safely adopted.
 *   - DETERMINISTIC FALLBACK: a pure formatter produces a grounded answer from
 *     evidence, so Ask My Kitchen works without AI.
 *   - ORDER IS THE MODEL'S TO EXPLAIN, NOT OWN: returned items are normalized
 *     back to the deterministic retrieval order.
 *   - ZERO FABRICATION AND PROVENANCE-NEUTRAL: the formatter never claims
 *     parser-default fields (category/course "Main Course", cuisine "General",
 *     difficulty "Medium", rating 5) were user-declared; it states them only as
 *     neutral facts when present and otherwise omits them.
 *   - PRIVACY: only compact evidence for RETRIEVED recipes is passed to the
 *     model; no unrelated vault content leaves the local retrieval boundary.
 *   - PURE & LOCAL: no network/Gemini import; the AI adapter is INJECTED
 *     (`AnswerDeps.aiAnswer`) so orchestration is hermetically testable and the
 *     Gemini dependency stays server-side only.
 */

import type { KitchenQuery, KitchenSearchResult } from './kitchenSearch';
import { resolveCookMinutes, resolvePrepMinutes, resolveTotalMinutes } from './kitchenSearch';

export type AnswerSource = 'ai' | 'deterministic';

/**
 * Compact, valence-neutral evidence for a single retrieved recipe. Represents
 * only values actually produced by Step 1 / the stored recipe; unsupported or
 * missing values are omitted rather than invented.
 */
export interface KitchenAnswerRecipeEvidence {
  recipeIdentity: string;
  title: string;
  matchedIngredients: string[];
  matchedFields: string[];
  reasons: string[];
  similarity?: number;
  prepMinutes?: number;
  cookMinutes?: number;
  totalMinutes?: number;
  cuisine?: string;
  course?: string;
  difficulty?: string;
  rating?: number;
}

/** A single per-recipe answer entry (identity is the navigation key). */
export interface KitchenAnswerItem {
  recipeIdentity: string;
  title: string;
  explanation: string;
}

/** The grounded conversational answer. */
export interface KitchenAnswer {
  ok: boolean;
  noMatches: boolean;
  summary: string;
  items: KitchenAnswerItem[];
  source: AnswerSource;
  error?: string;
}

/** Input passed to the AI answer adapter. */
export interface AnswerInput {
  question: string;
  query: KitchenQuery;
  evidence: KitchenAnswerRecipeEvidence[];
}

/** Injected dependencies so orchestration runs without network/Gemini. */
export interface AnswerDeps {
  aiAnswer?: (input: AnswerInput) => unknown | Promise<unknown>;
}

export const MAX_ANSWER_RECIPES = 12;
const MAX_REASONS_PER_RECIPE = 4;
const MAX_STRING_LEN = 120;
const MAX_EXPLANATION_LENGTH = 220;
const MAX_SUMMARY_LENGTH = 300;
const MAX_IDENTITY_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().slice(0, max);
  return s || undefined;
}

function trimStringList(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const s = trimString(item, maxLen);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

function toNonNegative(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : undefined;
  if (num === undefined || isNaN(num) || !isFinite(num) || num < 0) return undefined;
  return num;
}

/** A normalized similarity score, only valid in [0, 1]; invalid values omitted. */
function toScore(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : undefined;
  if (num === undefined || isNaN(num) || !isFinite(num)) return undefined;
  if (num < 0 || num > 1) return undefined;
  return num;
}

/**
 * Builds compact evidence from trusted deterministic retrieval results.
 * Unsupported/missing values are omitted; only the deterministic reasons are
 * preserved. Capped for model-cost and payload size.
 */
export function buildAnswerEvidence(
  results: KitchenSearchResult[],
  opts: { maxRecipes?: number } = {}
): KitchenAnswerRecipeEvidence[] {
  const cap = opts.maxRecipes ?? MAX_ANSWER_RECIPES;
  const evidence: KitchenAnswerRecipeEvidence[] = [];
  for (const result of results ?? []) {
    if (evidence.length >= cap) break;
    const recipe = result.recipe;
    const identity = result.recipeIdentity;
    if (!identity) continue;
    const entry: KitchenAnswerRecipeEvidence = {
      recipeIdentity: identity,
      title: (recipe.title ?? identity).toString().slice(0, MAX_STRING_LEN) || identity,
      matchedIngredients: result.matchedIngredients.slice(0, MAX_REASONS_PER_RECIPE),
      matchedFields: result.matchedFields.slice(0, MAX_REASONS_PER_RECIPE),
      reasons: result.reasons.slice(0, MAX_REASONS_PER_RECIPE),
    };
    const sim = result.similarity?.score;
    if (typeof sim === 'number' && sim >= 0 && sim <= 1) entry.similarity = sim;
    const prep = resolvePrepMinutes(recipe);
    const cook = resolveCookMinutes(recipe);
    const total = resolveTotalMinutes(recipe);
    if (prep !== null) entry.prepMinutes = prep;
    if (cook !== null) entry.cookMinutes = cook;
    if (total !== null) entry.totalMinutes = total;
    if (recipe.cuisine) entry.cuisine = String(recipe.cuisine).slice(0, MAX_STRING_LEN);
    const course = recipe.category || recipe.course;
    if (course) entry.course = String(course).slice(0, MAX_STRING_LEN);
    if (recipe.difficulty) entry.difficulty = String(recipe.difficulty).slice(0, MAX_STRING_LEN);
    if (typeof recipe.rating === 'number') entry.rating = recipe.rating;
    evidence.push(entry);
  }
  return evidence;
}

/** The set of recipe identities that the answer model is allowed to reference. */
export function allowlistFromEvidence(evidence: KitchenAnswerRecipeEvidence[]): Set<string> {
  const allow = new Set<string>();
  for (const e of evidence ?? []) {
    if (e?.recipeIdentity) allow.add(e.recipeIdentity);
  }
  return allow;
}

/**
 * Sanitizes an untrusted AI evidence object (used for the client-supplied
 * `results` on /api/kitchen/answer). Unknown fields are dropped; every value is
 * coerced and bounded. Returns undefined for a structurally invalid entry.
 */
export function sanitizeAnswerEvidence(raw: unknown): KitchenAnswerRecipeEvidence | undefined {
  if (!isPlainObject(raw)) return undefined;
  const identity = trimString(raw['recipeIdentity'], MAX_IDENTITY_LENGTH);
  if (!identity) return undefined;
  const title = trimString(raw['title'], MAX_STRING_LEN) ?? identity;
  const entry: KitchenAnswerRecipeEvidence = {
    recipeIdentity: identity,
    title,
    matchedIngredients: trimStringList(raw['matchedIngredients'], MAX_REASONS_PER_RECIPE, MAX_STRING_LEN) ?? [],
    matchedFields: trimStringList(raw['matchedFields'], MAX_REASONS_PER_RECIPE, MAX_STRING_LEN) ?? [],
    reasons: trimStringList(raw['reasons'], MAX_REASONS_PER_RECIPE, MAX_STRING_LEN) ?? [],
  };
  const similarity = toScore(raw['similarity']);
  if (similarity !== undefined) entry.similarity = similarity;
  const prep = toNonNegative(raw['prepMinutes']);
  const cook = toNonNegative(raw['cookMinutes']);
  const total = toNonNegative(raw['totalMinutes']);
  if (prep !== undefined) entry.prepMinutes = prep;
  if (cook !== undefined) entry.cookMinutes = cook;
  if (total !== undefined) entry.totalMinutes = total;
  const cuisine = trimString(raw['cuisine'], MAX_STRING_LEN);
  const course = trimString(raw['course'], MAX_STRING_LEN);
  const difficulty = trimString(raw['difficulty'], MAX_STRING_LEN);
  const rating = toNonNegative(raw['rating']);
  if (cuisine) entry.cuisine = cuisine;
  if (course) entry.course = course;
  if (difficulty) entry.difficulty = difficulty;
  if (rating !== undefined && rating <= 5) entry.rating = rating;
  return entry;
}

/**
 * Validates a raw list of client-supplied evidence. Dedupes by identity,
 * respects the result cap, and drops invalid entries.
 */
export function sanitizeAnswerEvidenceList(
  rawList: unknown,
  opts: { maxRecipes?: number } = {}
): KitchenAnswerRecipeEvidence[] {
  const cap = opts.maxRecipes ?? MAX_ANSWER_RECIPES;
  if (!Array.isArray(rawList)) return [];
  const out: KitchenAnswerRecipeEvidence[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (out.length >= cap) break;
    const e = sanitizeAnswerEvidence(item);
    if (!e || seen.has(e.recipeIdentity)) continue;
    seen.add(e.recipeIdentity);
    out.push(e);
  }
  return out;
}

/**
 * Validates structured AI answer output, requiring every referenced recipe
 * identity to exist in the allowlist. Dedupes, bounds, and drops unknown IDs and
 * unknown fields. Returns undefined when no valid items remain (caller falls
 * back deterministically).
 */
export function sanitizeKitchenAnswer(
  raw: unknown,
  allowlist: ReadonlySet<string>,
  opts: { maxItems?: number } = {}
): { summary?: string; items: KitchenAnswerItem[] } | undefined {
  const maxItems = opts.maxItems ?? MAX_ANSWER_RECIPES;
  if (!isPlainObject(raw)) return undefined;
  const summary = trimString(raw['summary'], MAX_SUMMARY_LENGTH);
  const items: KitchenAnswerItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw['items'])) {
    for (const item of raw['items']) {
      if (items.length >= maxItems) break;
      if (!isPlainObject(item)) continue;
      const identity = trimString(item['recipeIdentity'], MAX_IDENTITY_LENGTH);
      if (!identity || !allowlist.has(identity)) continue;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const explanation = trimString(item['explanation'], MAX_EXPLANATION_LENGTH) ?? '';
      items.push({ recipeIdentity: identity, title: '', explanation });
    }
  }
  if (items.length === 0) return undefined;
  return { summary, items };
}

/** Reorders answer items back into deterministic evidence order. */
export function orderItemsByEvidence(
  items: KitchenAnswerItem[],
  evidence: KitchenAnswerRecipeEvidence[]
): KitchenAnswerItem[] {
  const order = new Map<string, number>();
  evidence.forEach((e, idx) => order.set(e.recipeIdentity, idx));
  const withTitle = items.map((item) => {
    const ev = evidence.find((e) => e.recipeIdentity === item.recipeIdentity);
    const title = ev?.title ?? item.recipeIdentity;
    return { ...item, title };
  });
  return withTitle.sort(
    (a, b) => (order.get(a.recipeIdentity) ?? 0) - (order.get(b.recipeIdentity) ?? 0)
  );
}

function countSummary(count: number): string {
  if (count === 0) return 'I couldn\'t find a matching recipe in your vault.';
  if (count === 1) return 'I found 1 matching recipe in your vault.';
  return `I found ${count} matching recipes in your vault.`;
}

/**
 * Pure deterministic fallback answer. Preserves retrieval order, states each
 * recipe's title, summarizes the Step 1 reasons, handles singular/plural and
 * zero-result counts, and never invents claims.
 */
export function deterministicAnswer(evidence: KitchenAnswerRecipeEvidence[]): KitchenAnswer {
  const items: KitchenAnswerItem[] = evidence.map((e) => ({
    recipeIdentity: e.recipeIdentity,
    title: e.title,
    explanation: e.reasons.slice(0, 2).join('; '),
  }));
  return {
    ok: true,
    noMatches: items.length === 0,
    summary: countSummary(items.length),
    items,
    source: 'deterministic',
  };
}

/** Grounded no-match answer. Never searches or invents alternatives. */
export function noMatchAnswer(): KitchenAnswer {
  return {
    ok: true,
    noMatches: true,
    summary: countSummary(0),
    items: [],
    source: 'deterministic',
  };
}

/**
 * Orchestrates the grounded answer.
 *
 * GROUNDING-FIRST (Step 3): the final user-visible answer is ALWAYS derived
 * deterministically from the retrieved evidence. Membership, ordering, summary
 * count, and per-recipe explanations all come from `deterministicAnswer`, so the
 * model can never omit/add/reorder retrieved recipes, change the match count,
 * or surface unsupported provenance/health claims. The optional AI adapter is
 * retained for future safe phrasing but is NOT surfaced in Step 3 output.
 *
 * Precedence:
 *   1. empty evidence -> deterministic no-match
 *   2. otherwise -> deterministic answer over the full evidence set
 */
export async function answerKitchenQuestion(
  question: string,
  query: KitchenQuery,
  evidence: KitchenAnswerRecipeEvidence[],
  deps: AnswerDeps = {}
): Promise<KitchenAnswer> {
  // `deps` (and `question`/`query`) are intentionally not used to shape the
  // final output; they remain part of the orchestration contract for a future
  // step that may safely phrase from validated evidence.
  if (!evidence || evidence.length === 0) {
    return noMatchAnswer();
  }
  return deterministicAnswer(evidence);
}
