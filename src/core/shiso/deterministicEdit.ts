/**
 * The Kitchen Codex — SHISO H-2S deterministic simple-edit planning (core).
 *
 * PURE, OFFLINE, deterministic. ONE small, GENERAL planner for unmistakable
 * ingredient-edit commands such as:
 *
 *   "Change the 2 jalapeños to 3 jalapeños."
 *   "Change 1 cup whole milk to 2 cups."
 *   "Replace the ingredient name chicken with turkey."
 *   "Change 1 teaspoon of salt to 1/2 teaspoon."
 *
 * WHY THIS EXISTS: a weak (or loosely-constrained) provider can fail to build
 * valid `apply_ingredient_edits` arguments even when it knows exactly which
 * tool it wants; the human test showed it repeating empty-argument attempts
 * until the reasoning budget died. For commands whose intent is UNAMBIGUOUS,
 * the application can plan the field-scoped edit itself — with zero provider
 * calls — and hand it to the SAME editing authority.
 *
 * GUARANTEES
 * ----------
 *   - No ingredient-specific logic: any food, any unit, any recipe. Matching is
 *     token/diacritic/plural normalization plus the EXISTING measurement parser.
 *   - Refuses AMBIGUITY rather than guessing: zero matches, multiple matches,
 *     multi-intent sentences, and meta-verb phrases all return `ok: false` and
 *     the conversation falls through to the model path.
 *   - No authority of its own: it returns a candidate `ShisoIngredientEditArgs`
 *     addressed by the live `line_ref`; the existing application applier still
 *     revalidates the reference and performs every mutation.
 *   - It never saves and never talks to the Vault or a provider.
 */

import { parseIngredientLine } from '../../utils/markdownParser';
import type { ShisoIngredientEditArgs } from './protocol';

export interface DeterministicEditIngredient {
  readonly text: string;
  readonly name: string;
  readonly line_ref?: string | null;
}

export interface DeterministicEditPlan {
  readonly edit: ShisoIngredientEditArgs;
  /** The authored line this edit addresses, for display/verification. */
  readonly before: string;
}

export type DeterministicEditFailureReason =
  | 'not_an_edit_command'
  | 'no_target'
  | 'ambiguous_target'
  | 'unsupported_change';

export type DeterministicEditPlanResult =
  | { readonly ok: true; readonly plan: DeterministicEditPlan }
  | { readonly ok: false; readonly reason: DeterministicEditFailureReason };

// ---------------------------------------------------------------------------
// Text normalization (general — never ingredient-specific)
// ---------------------------------------------------------------------------

/** Lowercase, strip diacritics, split into word tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Very small plural folding so "breasts"/"breast" and "cups"/"cup" agree. */
function stemToken(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

function stemmedTokens(text: string): string[] {
  return tokenize(text).map(stemToken);
}

/** Canonical unit text, folding plurals and the common cooking aliases. */
function canonicalUnit(raw: string): string {
  const base = raw.trim().toLowerCase().replace(/\.$/, '');
  if (base.length === 0) return '';
  const alias: Record<string, string> = {
    tablespoon: 'tbsp',
    tablespoons: 'tbsp',
    tbsp: 'tbsp',
    tbs: 'tbsp',
    teaspoon: 'tsp',
    teaspoons: 'tsp',
    tsp: 'tsp',
    cup: 'cup',
    cups: 'cup',
    ounce: 'oz',
    ounces: 'oz',
    oz: 'oz',
    pound: 'lb',
    pounds: 'lb',
    lb: 'lb',
    lbs: 'lb',
    gram: 'g',
    grams: 'g',
    g: 'g',
    kilogram: 'kg',
    kilograms: 'kg',
    kg: 'kg',
    milliliter: 'ml',
    milliliters: 'ml',
    ml: 'ml',
    liter: 'l',
    liters: 'l',
    l: 'l',
    clove: 'clove',
    cloves: 'clove',
  };
  return alias[base] ?? stemToken(base);
}

/**
 * Splits ONE side of a command into quantity / unit / food text using the
 * SHARED measurement parser (never a second parser). The food text strips the
 * leading article and the quantity+unit prefix, so "the 2 jalapeños" and
 * "2 cups of milk" both yield the food alone.
 */
function splitSide(side: string): { amount: number | null; unit: string; food: string } {
  let rest = side.trim().replace(/^the\s+/i, '');
  const parsed = parseIngredientLine(rest);
  const amount = parsed.amount ?? null;
  const unit = (parsed.unit ?? '').trim();
  rest = rest.replace(/^\s*[-*+]\s*/, '');
  rest = rest.replace(
    /^(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔⅛⅜⅝⅞])\s*/i,
    '',
  );
  if (unit.length > 0) {
    const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rest = rest.replace(new RegExp(`^${escaped}\\b\\.?\\s*`, 'i'), '');
  }
  rest = rest.replace(/^of\s+/i, '').trim();
  // A pure quantity side ("3 cups") leaves nothing (or only stopwords) here.
  const food = rest.replace(/[.,;:!?]+$/g, '').trim();
  return { amount, unit, food };
}

/** Words that mean the "new" side is not a plain ingredient phrase. */
const NEW_SIDE_META =
  /\b(?:change|update|replace|swap|save|saving|saved|fix|calculate|recalculate|apply|remove|delete|then|also|please|thanks|thank)\b/i;

const MAX_NEW_SIDE_CHARS = 60;
const MAX_NEW_SIDE_TOKENS = 8;

/**
 * Extracts the command into (oldSide, newSide). Returns null when the message
 * is not a single, unmistakable edit command. Trailing save/please clauses are
 * stripped conservatively; any REMAINING save token refuses the command so the
 * full conversation flow (and the save-authorization gate) handles it.
 */
function extractCommand(message: string): { oldSide: string; newSide: string } | null {
  const text = message.trim();
  if (text.length === 0 || text.length > 300) return null;
  const match = /\b(?:change|update|replace|swap|set)\s+(.+?)\s+(?:to|with|for|into)\s+([^.!?]+)/i.exec(text);
  if (match === null) return null;
  let oldSide = (match[1] ?? '').replace(/[.!?]+$/, '').trim();
  let newSide = (match[2] ?? '').trim();
  // Conservative trailing-clause strip: "… to 3 jalapeños, and don't save."
  newSide = newSide
    .replace(
      /[,;]?\s*(?:and\s+)?(?:please\s+)?(?:do\s+not|don'?t|without|never)\s+save(?:\s+(?:it|this|anything|yet|my\s+changes|the\s+recipe))?\s*$/i,
      '',
    )
    .replace(/[\s,;.!]+$/, '')
    .trim();
  if (oldSide.length === 0 || newSide.length === 0) return null;
  if (/\bsav(?:e|es|ed|ing)\b/i.test(oldSide) || /\bsav(?:e|es|ed|ing)\b/i.test(newSide)) return null;
  // "the ingredient name chicken" → "chicken".
  oldSide = oldSide
    .replace(/^the\s+/i, '')
    .replace(/^(?:ingredient\s+name|ingredient|name)\s+/i, '')
    .trim();
  if (oldSide.length === 0) return null;
  if (newSide.length > MAX_NEW_SIDE_CHARS) return null;
  if (stemmedTokens(newSide).length > MAX_NEW_SIDE_TOKENS) return null;
  if (NEW_SIDE_META.test(newSide)) return null;
  return { oldSide, newSide };
}

/** True when `needle` appears as a contiguous run inside `haystack`. */
function findContiguousRun(haystack: string[], needle: string[]): { start: number; end: number } | null {
  if (needle.length === 0 || needle.length > haystack.length) return null;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return { start, end: start + needle.length };
  }
  return null;
}

function isSameFood(targetTokens: string[], foodTokens: string[]): boolean {
  return foodTokens.length > 0 && foodTokens.every((token) => targetTokens.includes(token));
}

/** True when both lists contain exactly the same tokens (any order). */
function sameTokenSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((token) => b.includes(token));
}

/**
 * Plans ONE unambiguous ingredient edit from a user message, or refuses.
 *
 * Refusal is not an error: the caller simply falls through to the normal model
 * conversation, which can ask for clarification.
 */
export function planDeterministicIngredientEdit(input: {
  readonly userMessage: string;
  readonly ingredients: ReadonlyArray<DeterministicEditIngredient>;
}): DeterministicEditPlanResult {
  const command = extractCommand(input.userMessage);
  if (command === null) return { ok: false, reason: 'not_an_edit_command' };

  const oldSide = splitSide(command.oldSide);
  const newSide = splitSide(command.newSide);
  const oldFoodTokens = stemmedTokens(oldSide.food);
  const newFoodTokens = stemmedTokens(newSide.food);

  // ---- find the ONE target ingredient ---------------------------------------
  interface Candidate {
    readonly line_ref: string;
    readonly text: string;
    readonly name: string;
    readonly nameTokens: string[];
    readonly rawNameTokens: string[];
    readonly amount: number | null;
    readonly unit: string;
  }
  const candidates: Candidate[] = [];
  for (const ingredient of input.ingredients) {
    const lineRef = typeof ingredient.line_ref === 'string' ? ingredient.line_ref : null;
    if (lineRef === null || lineRef.length === 0) continue;
    const authored = (ingredient.text || ingredient.name || '').trim();
    if (authored.length === 0) continue;
    const parsed = parseIngredientLine(authored);
    const name = (parsed.name ?? ingredient.name ?? '').trim();
    const nameTokens = stemmedTokens(name);
    const rawNameTokens = name.split(/\s+/).filter((token) => token.length > 0);

    // Food tokens must all be present in the ingredient's own name.
    if (oldFoodTokens.length > 0 && !oldFoodTokens.every((token) => nameTokens.includes(token))) continue;
    // The authored quantity must agree when BOTH sides carry one.
    const targetAmount = parsed.amount ?? null;
    if (oldSide.amount !== null) {
      if (targetAmount === null || Math.abs(targetAmount - oldSide.amount) > 0.001) continue;
    }
    // Units must agree when BOTH sides carry one.
    if (oldSide.unit.length > 0 && (parsed.unit ?? '').length > 0) {
      if (canonicalUnit(oldSide.unit) !== canonicalUnit(parsed.unit ?? '')) continue;
    }
    candidates.push({
      line_ref: lineRef,
      text: authored,
      name,
      nameTokens,
      rawNameTokens,
      amount: targetAmount,
      unit: (parsed.unit ?? '').trim(),
    });
  }

  if (candidates.length === 0) return { ok: false, reason: 'no_target' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous_target' };
  const target = candidates[0] as Candidate;

  // ---- build the field-scoped change ----------------------------------------
  const edit: Record<string, unknown> = { line_ref: target.line_ref };

  if (newFoodTokens.length === 0) {
    // Quantity-only side: "… to 3 cups." — the amount is the whole change.
    if (newSide.amount === null || !(newSide.amount > 0)) return { ok: false, reason: 'unsupported_change' };
    edit['new_amount'] = newSide.amount;
    // Adopt the user's own unit words when they gave them ("to 2 cups").
    if (newSide.unit.length > 0) edit['new_unit'] = newSide.unit;
  } else if (isSameFood(target.nameTokens, newFoodTokens)) {
    // Same food restated with a new quantity/unit: "… to 3 jalapeños."
    if (newSide.amount !== null && (newSide.amount > 0)) {
      if (target.amount === null || Math.abs(target.amount - newSide.amount) > 0.001) {
        edit['new_amount'] = newSide.amount;
      }
    }
    if (newSide.unit.length > 0) edit['new_unit'] = newSide.unit;
    // Adopt the user's own spelling ONLY when it is the same set of words
    // (e.g. "1 jalapeño" singularizes "jalapeños"); never when the user used
    // fewer words than the authored name, which would drop descriptors.
    if (
      newSide.food.length > 0 &&
      sameTokenSet(target.nameTokens, newFoodTokens) &&
      newSide.food.toLowerCase() !== target.name.toLowerCase()
    ) {
      edit['new_name'] = newSide.food;
    }
  } else {
    // Name replacement: "… chicken … with turkey." Replace exactly the matched
    // token run inside the AUTHORED name so descriptors and the quantity stay.
    const run = findContiguousRun(target.nameTokens, oldFoodTokens);
    if (run === null) return { ok: false, reason: 'unsupported_change' };
    const nextNameTokens = [
      ...target.rawNameTokens.slice(0, run.start),
      newSide.food,
      ...target.rawNameTokens.slice(run.end),
    ]
      .filter((token) => token.length > 0)
      .join(' ')
      .trim();
    if (nextNameTokens.length === 0) return { ok: false, reason: 'unsupported_change' };
    edit['new_name'] = nextNameTokens;
    if (newSide.amount !== null && newSide.amount > 0) {
      if (target.amount === null || Math.abs(target.amount - newSide.amount) > 0.001) {
        edit['new_amount'] = newSide.amount;
      }
    }
    if (newSide.unit.length > 0) edit['new_unit'] = newSide.unit;
  }

  // The change must actually change something (never a no-op proposal).
  const hasUsableChange =
    (typeof edit['new_name'] === 'string' && edit['new_name'].length > 0) ||
    (typeof edit['new_amount'] === 'number' && Number.isFinite(edit['new_amount']) && (edit['new_amount'] as number) > 0) ||
    (typeof edit['new_unit'] === 'string' && edit['new_unit'].length > 0);
  if (!hasUsableChange) return { ok: false, reason: 'unsupported_change' };

  return {
    ok: true,
    plan: {
      edit: Object.freeze(edit) as unknown as ShisoIngredientEditArgs,
      before: target.text,
    },
  };
}
