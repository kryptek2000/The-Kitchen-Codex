/**
 * The Kitchen Codex — Ask My Kitchen Semantic Intent Foundation (v0.5.0 Step 1)
 *
 * A versioned, higher-level SEMANTIC contract that sits ABOVE the deterministic
 * `KitchenQuery` hard-filter layer. `KitchenIntent` describes WHAT the user is
 * asking for ("suggest a meal", "compare these", "find something similar",
 * "discover online") plus soft preferences, while `constraints` remains the
 * existing `KitchenQuery` subset that drives deterministic local retrieval.
 *
 * IMPORTANT TRUST BOUNDARY:
 *   - `KitchenIntent` is MODEL-OWNED semantic structure. It must NEVER carry
 *     recipe identities, recipe membership, trusted recipe ids, or any
 *     `similarToRecipeId` authority. Those belong to the trusted UI/local layer
 *     (Step 2 `TrustedKitchenContext`), not to model-produced intent.
 *   - The sanitizer strips every identity-bearing / unknown field, and drains
 *     `similarToRecipeId` out of `constraints`, so a model can never elevate a
 *     guessed id into retrieval authority.
 *   - No recipe/vault data is touched here. This is types + sanitization +
 *     meaningfulness validation only. Nothing here wires into runtime Ask My
 *     Kitchen behaviour.
 *
 * SCOPE (Step 1): types, sanitizer, meaningfulness validation, focused tests.
 * No web discovery, no API routes, no prompt changes, no resolution logic.
 */

import type { KitchenQuery } from './kitchenSearch';
import { sanitizeInterpretedQuery, isMeaningfulQuery } from './kitchenQueryInterpreter';

export const KITCHEN_INTENT_VERSION = 1 as const;

export type KitchenIntentType =
  | 'find_recipes'
  | 'meal_suggestion'
  | 'similar_recipe'
  | 'pairing'
  | 'compare'
  | 'ingredient_use'
  | 'discover_online'
  | 'browse_category';

export type KitchenSource = 'vault' | 'vault_then_web' | 'web';

export type KitchenEffort = 'low' | 'medium' | 'high';

export type KitchenNovelty = 'prefer_familiar' | 'balanced' | 'prefer_new';

/** Soft, non-authoritative preferences. Ideal flavours, not hard filters. */
export interface KitchenIntentPreferences {
  effort?: KitchenEffort;
  mood?: string[];
  style?: string[];
  mealContext?: string[];
  dietary?: string[];
  novelty?: KitchenNovelty;
  avoidRepetition?: boolean;
  pairingGoal?: string;
}

/** Semantic cross-references to other recipes (semantic, NOT concrete ids). */
export interface KitchenIntentReference {
  currentRecipe?: boolean;
  comparisonTargets?: number;
}

/**
 * The top-level semantic intent. `constraints` is ALWAYS a sanitized
 * `KitchenQuery` (hard filters); it can be empty when the request is purely
 * preference-driven. `version` is a forward-compatibility guard.
 */
export interface KitchenIntent {
  readonly version: 1;
  intent: KitchenIntentType;
  source: KitchenSource;
  constraints: KitchenQuery;
  preferences: KitchenIntentPreferences;
  references?: KitchenIntentReference;
  requiresClarification: boolean;
  requestedResultCount?: number;
  confidence?: number;
  unresolvedTerms?: string[];
}

/**
 * Trusted, USER/UI-owned recipe context. This is SEPARATE from `KitchenIntent`
 * on purpose: it carries concrete recipe identities that the model must NEVER
 * be allowed to invent or inject. Resolution is Step 2; this is a type contract
 * only for Step 1.
 */
export interface TrustedKitchenContext {
  currentRecipeId?: string;
  selectedRecipeIds?: string[];
}

// ---------------------------------------------------------------------------
// Constants / caps (conservative, consistent with project style)
// ---------------------------------------------------------------------------
const INTENT_TYPES: ReadonlySet<string> = new Set<KitchenIntentType>([
  'find_recipes',
  'meal_suggestion',
  'similar_recipe',
  'pairing',
  'compare',
  'ingredient_use',
  'discover_online',
  'browse_category',
]);

const SOURCE_VALUES: ReadonlySet<string> = new Set<KitchenSource>(['vault', 'vault_then_web', 'web']);
const EFFORT_VALUES: ReadonlySet<string> = new Set<KitchenEffort>(['low', 'medium', 'high']);
const NOVELTY_VALUES: ReadonlySet<string> = new Set<KitchenNovelty>(['prefer_familiar', 'balanced', 'prefer_new']);

/** Cap for semantic string arrays (mood, style, mealContext, dietary, unresolvedTerms). */
export const MAX_STRING_LIST_ITEMS = 20;
/** Cap for an individual semantic string. */
export const MAX_STRING_LEN = 120;
/** Bounds for requestedResultCount. */
export const MIN_REQUESTED_RESULT_COUNT = 1;
export const MAX_REQUESTED_RESULT_COUNT = 20;
/** Bounds for comparisonTargets (a semantic target count). */
export const MIN_COMPARISON_TARGETS = 1;
export const MAX_COMPARISON_TARGETS = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts a number or a numeric string, clamping to [min, max]; undefined for non-finite/non-integer. */
function clampInt(value: unknown, min: number, max: number): number | undefined {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) return undefined;
  return Math.max(min, Math.min(max, num));
}

/** Accepts a finite number; clamps to [min, max]; undefined for NaN/Infinity/non-number. */
function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

/** Trims, dedupes (case-insensitive), drops empties, rejects non-strings, and caps a string list. */
function sanitizeStringList(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, MAX_STRING_LEN);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function sanitizePreferences(value: unknown): KitchenIntentPreferences {
  const prefs: KitchenIntentPreferences = {};
  if (!isPlainObject(value)) return prefs;

  const effort = enumValue(value['effort'], EFFORT_VALUES);
  if (effort) prefs.effort = effort as KitchenEffort;

  const mood = sanitizeStringList(value['mood'], MAX_STRING_LIST_ITEMS);
  if (mood) prefs.mood = mood;

  const style = sanitizeStringList(value['style'], MAX_STRING_LIST_ITEMS);
  if (style) prefs.style = style;

  const mealContext = sanitizeStringList(value['mealContext'], MAX_STRING_LIST_ITEMS);
  if (mealContext) prefs.mealContext = mealContext;

  const dietary = sanitizeStringList(value['dietary'], MAX_STRING_LIST_ITEMS);
  if (dietary) prefs.dietary = dietary;

  const novelty = enumValue(value['novelty'], NOVELTY_VALUES);
  if (novelty) prefs.novelty = novelty as KitchenNovelty;

  if (value['avoidRepetition'] === true) prefs.avoidRepetition = true;

  if (typeof value['pairingGoal'] === 'string') {
    const goal = value['pairingGoal'].trim().slice(0, MAX_STRING_LEN);
    if (goal) prefs.pairingGoal = goal;
  }

  return prefs;
}

function sanitizeReferences(value: unknown): KitchenIntentReference | undefined {
  if (!isPlainObject(value)) return undefined;
  const refs: KitchenIntentReference = {};
  if (value['currentRecipe'] === true) refs.currentRecipe = true;
  const comparisonTargets = clampInt(value['comparisonTargets'], MIN_COMPARISON_TARGETS, MAX_COMPARISON_TARGETS);
  if (comparisonTargets !== undefined) refs.comparisonTargets = comparisonTargets;
  return Object.keys(refs).length ? refs : undefined;
}

/**
 * Deterministically sanitizes raw (untrusted) model output into a valid
 * `KitchenIntent`, or returns null when the input is not structurally usable
 * (unknown intent, unknown source, bad version, or non-object).
 *
 * Rules: only known fields are copied; every value is coerced and bounded;
 * unknown/identity-bearing fields are dropped; a model-inferred
 * `similarToRecipeId` is always stripped out of `constraints`; the input is
 * never mutated. Semantic values are never invented.
 */
export function sanitizeKitchenIntent(input: unknown): KitchenIntent | null {
  if (!isPlainObject(input)) return null;

  const rawVersion = input['version'];
  if (rawVersion !== 1 && rawVersion !== '1') return null;

  const intent = typeof input['intent'] === 'string' ? input['intent'] : undefined;
  if (!intent || !INTENT_TYPES.has(intent)) return null;

  const source = typeof input['source'] === 'string' ? input['source'] : undefined;
  if (!source || !SOURCE_VALUES.has(source)) return null;

  // Constraints go through the existing authoritative KitchenQuery sanitizer,
  // then identity-bearing authority is drained from the model-owned view.
  const constraints = sanitizeInterpretedQuery(input['constraints']);
  delete (constraints as { similarToRecipeId?: string }).similarToRecipeId;

  const preferences = sanitizePreferences(input['preferences']);
  const references = sanitizeReferences(input['references']);

  const requiresClarification = input['requiresClarification'] === true;
  const requestedResultCount = clampInt(input['requestedResultCount'], MIN_REQUESTED_RESULT_COUNT, MAX_REQUESTED_RESULT_COUNT);
  const confidence = clampNumber(input['confidence'], 0, 1);
  const unresolvedTerms = sanitizeStringList(input['unresolvedTerms'], MAX_STRING_LIST_ITEMS);

  return {
    version: 1,
    intent: intent as KitchenIntentType,
    source: source as KitchenSource,
    constraints,
    preferences,
    ...(references ? { references } : {}),
    requiresClarification,
    ...(requestedResultCount !== undefined ? { requestedResultCount } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(unresolvedTerms && unresolvedTerms.length > 0 ? { unresolvedTerms } : {}),
  };
}

function hasAnyPreference(prefs: KitchenIntentPreferences): boolean {
  return Boolean(
    prefs.effort !== undefined ||
      (prefs.mood && prefs.mood.length > 0) ||
      (prefs.style && prefs.style.length > 0) ||
      (prefs.mealContext && prefs.mealContext.length > 0) ||
      (prefs.dietary && prefs.dietary.length > 0) ||
      prefs.novelty !== undefined ||
      prefs.avoidRepetition === true ||
      (prefs.pairingGoal && prefs.pairingGoal.length > 0)
  );
}

/**
 * Conservatively decides whether a SANITIZED `KitchenIntent` represents a
 * structurally usable semantic request. This is NOT an NLP parser — it only
 * checks that the intent type has enough semantic anchor to be acted on, so an
 * intent with no usable anchor is rejected rather than silently broadened.
 *
 * Explicit non-goal: this does not consider `requiresClarification` as a
 * "meaningful" signal on its own; a clarification request still needs a
 * semantic anchor to be actionable.
 */
export function isMeaningfulKitchenIntent(intent: KitchenIntent): boolean {
  if (!intent || !isPlainObject(intent)) return false;
  if (intent.version !== 1) return false;
  if (!INTENT_TYPES.has(intent.intent)) return false;
  if (!SOURCE_VALUES.has(intent.source)) return false;

  const constraints = intent.constraints ?? {};
  const preferences = intent.preferences ?? {};
  const references = intent.references;

  const constraintsMeaningful = isMeaningfulQuery(constraints);
  const hasPreference = hasAnyPreference(preferences);

  switch (intent.intent) {
    case 'meal_suggestion':
      return true;
    case 'discover_online':
      return true;
    case 'similar_recipe':
      return Boolean(references && references.currentRecipe === true);
    case 'pairing':
      return Boolean(references && references.currentRecipe === true);
    case 'compare':
      return Boolean(
        references && typeof references.comparisonTargets === 'number' && references.comparisonTargets >= 2
      );
    case 'ingredient_use':
      return Boolean(constraints.includeIngredients && constraints.includeIngredients.length > 0);
    case 'find_recipes':
      return constraintsMeaningful || hasPreference;
    case 'browse_category':
      return constraintsMeaningful || hasPreference;
    default:
      return false;
  }
}
