/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: recipe adaptation (hardened).
 *
 * PURE, offline. This is the EXPORTED Phase 4 adaptation boundary. It treats its
 * runtime input as `unknown` regardless of the TypeScript annotation and NEVER
 * reads a recipe or ingredient property before materializing the narrow
 * adaptation envelope once into inert data:
 *   - the recipe envelope is read NARROWLY (only `title`, the identity fields,
 *     `servings`, and `ingredients`); unrelated recipe fields (full Markdown, file
 *     handles, frontmatter, platform objects) are never touched;
 *   - ingredient order is preserved;
 *   - deterministic, unique line references are assigned from the ingredient
 *     index AND a content digest, so array position alone is not authority after
 *     the recipe changes;
 *   - the original bounded ingredient text is preserved;
 *   - no volume→mass, count→mass, density, or note/preparation reinterpretation.
 *
 * Accessors/getters/setters, proxies/reflection failures, symbols, sparse arrays,
 * cycles, non-plain prototypes, functions, bigints, undefined-own fields,
 * dangerous keys, and oversized inputs fail closed with a fixed, bounded,
 * input-redacted Phase 4 failure. No attacker exception object or message can
 * escape. This module never parses measurements itself — the Phase 2 parser owns
 * that.
 */

import { sha256Hex } from '../usda/digest';
import { isPlainObject } from '../schema';
import {
  MAX_PHASE4_INGREDIENTS,
  phase4Failure,
  type AdaptedIngredient,
  type Phase4Failure,
} from './types';
import {
  hasDangerousOwnKey,
  hasSymbolKeys,
  materializeNarrow,
  readOwnDataField,
} from './materialize';

/** Per-field text bound for the narrow adaptation envelope. */
export const MAX_PHASE4_ADAPT_TEXT_LENGTH = 4096;

/** Envelope fields that may contribute stable recipe identity (precedence order). */
const RECIPE_IDENTITY_KEYS: ReadonlyArray<string> = ['filePath', 'id', 'fileName'];

/**
 * Closed whitelist of the authoritative adaptation shape (the repository's
 * `ParsedIngredient` fields). Unknown own fields fail closed; whitelisted fields
 * Phase 4 does not forward are still materialized so a getter on them cannot run.
 */
const INGREDIENT_KEYS: ReadonlySet<string> = new Set([
  'original',
  'amount',
  'unit',
  'name',
  'note',
  'wikilink',
  'wikilinkTarget',
  'wikilinkAlias',
  'isChecked',
]);

export interface AdaptedRecipe {
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly recipe_key: string;
  readonly title: string;
  readonly base_servings: number;
}

export type AdaptedRecipeResult =
  | { ok: true; recipe: AdaptedRecipe }
  | { ok: false; failure: Phase4Failure };

type FieldResult<T> = { ok: true; value: T } | { ok: false; failure: Phase4Failure };

function fail(code: Parameters<typeof phase4Failure>[0]): { ok: false; failure: Phase4Failure } {
  return { ok: false, failure: phase4Failure(code) };
}

function materializationFailure(unsafe: boolean): { ok: false; failure: Phase4Failure } {
  return fail(unsafe ? 'unsafe_request' : 'invalid_recipe');
}

/**
 * Re-wraps a failure branch as a fresh failure result. (Under this project's
 * non-strict null-checking, a boolean `ok` discriminant narrows reliably only in
 * the truthy direction, so failure branches are re-wrapped explicitly.)
 */
function asFailure(result: FieldResult<unknown>): { ok: false; failure: Phase4Failure } {
  return { ok: false, failure: (result as { ok: false; failure: Phase4Failure }).failure };
}

function lineRefFor(index: number, original: string): string {
  const digest = sha256Hex(original).slice(0, 12);
  return `ing:${index}:${digest}`;
}

/** Reads one optional bounded string field (absent/null -> undefined). */
function readOptionalStringField(object: object, key: string): FieldResult<string | undefined> {
  const field = readOwnDataField(object, key);
  if (!field.ok) return fail('unsafe_request');
  if (!field.present) return { ok: true, value: undefined };
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return materializationFailure(materialized.unsafe);
  const value = materialized.value;
  if (value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string') return fail('invalid_recipe');
  if (value.length > MAX_PHASE4_ADAPT_TEXT_LENGTH) return fail('invalid_recipe');
  return { ok: true, value };
}

/** Reads one optional amount field (absent -> absent; null/number -> preserved). */
function readOptionalAmountField(
  object: object
): FieldResult<{ present: boolean; value: number | null }> {
  const field = readOwnDataField(object, 'amount');
  if (!field.ok) return fail('unsafe_request');
  if (!field.present) return { ok: true, value: { present: false, value: null } };
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return materializationFailure(materialized.unsafe);
  const value = materialized.value;
  if (value === null) return { ok: true, value: { present: true, value: null } };
  if (typeof value !== 'number') return fail('invalid_recipe');
  // Preserve `-0`, `0`, and non-finite values so Phase 2 numeric validation owns
  // the decision; they are never coerced to absence.
  return { ok: true, value: { present: true, value } };
}

function readIdentity(object: object): FieldResult<string> {
  let identity = '';
  for (const key of RECIPE_IDENTITY_KEYS) {
    const field = readOptionalStringField(object, key);
    if (!field.ok) return field;
    if (identity === '' && field.value !== undefined && field.value !== '') identity = field.value;
  }
  return { ok: true, value: identity };
}

function readTitle(object: object): FieldResult<string> {
  const field = readOptionalStringField(object, 'title');
  if (!field.ok) return field;
  return { ok: true, value: field.value ?? '' };
}

function readBaseServings(object: object): FieldResult<number> {
  const field = readOwnDataField(object, 'servings');
  if (!field.ok) return fail('unsafe_request');
  if (!field.present) return { ok: true, value: 1 };
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return materializationFailure(materialized.unsafe);
  const value = materialized.value;
  if (value === null) return { ok: true, value: 1 };
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail('invalid_recipe');
  // Historical fallback for non-positive/invalid counts.
  if (value <= 0 || Object.is(value, -0)) return { ok: true, value: 1 };
  return { ok: true, value };
}

function readIngredients(object: object): FieldResult<ReadonlyArray<AdaptedIngredient>> {
  const field = readOwnDataField(object, 'ingredients');
  if (!field.ok) return fail('unsafe_request');
  if (!field.present) return fail('invalid_recipe');
  const materialized = materializeNarrow(field.value);
  if (!materialized.ok) return materializationFailure(materialized.unsafe);
  const value = materialized.value;
  if (!Array.isArray(value)) return fail('invalid_recipe');
  if (value.length === 0) return fail('invalid_recipe');
  if (value.length > MAX_PHASE4_INGREDIENTS) return fail('invalid_recipe');

  const adapted: AdaptedIngredient[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isPlainObject(entry)) return fail('unsafe_request');
    for (const key of Object.keys(entry)) {
      if (!INGREDIENT_KEYS.has(key)) return fail('unknown_field');
    }
    const original = readOptionalStringField(entry, 'original');
    if (!original.ok) return asFailure(original);
    const name = readOptionalStringField(entry, 'name');
    if (!name.ok) return asFailure(name);
    const unit = readOptionalStringField(entry, 'unit');
    if (!unit.ok) return asFailure(unit);
    const note = readOptionalStringField(entry, 'note');
    if (!note.ok) return asFailure(note);
    const amount = readOptionalAmountField(entry);
    if (!amount.ok) return asFailure(amount);

    const originalText = original.value ?? '';
    const baseText = originalText || name.value || '';
    const lineRef = lineRefFor(index, baseText);
    const ingredient = {
      original: originalText,
      ...(amount.value.present ? { amount: amount.value.value } : {}),
      ...(unit.value !== undefined ? { unit: unit.value } : {}),
      ...(name.value !== undefined ? { name: name.value } : {}),
      ...(note.value !== undefined ? { note: note.value } : {}),
      line_ref: lineRef,
    };
    adapted.push(Object.freeze({ line_ref: lineRef, ingredient: Object.freeze(ingredient) }));
  }
  return { ok: true, value: Object.freeze(adapted) };
}

/**
 * Adapts an untrusted recipe into bounded Phase 2/3 inputs. Returns a closed
 * result: `{ ok: true, recipe }` or `{ ok: false, failure }`. A hostile,
 * malformed, empty, or oversized recipe fails closed and is NEVER converted into
 * an empty successful adaptation.
 */
export function adaptRecipe(recipeRaw: unknown): AdaptedRecipeResult {
  try {
    if (!isPlainObject(recipeRaw)) return fail('invalid_recipe');
    if (hasSymbolKeys(recipeRaw)) return fail('unsafe_request');
    if (hasDangerousOwnKey(recipeRaw)) return fail('unsafe_request');

    const identity = readIdentity(recipeRaw);
    if (!identity.ok) return asFailure(identity);
    const title = readTitle(recipeRaw);
    if (!title.ok) return asFailure(title);
    const servings = readBaseServings(recipeRaw);
    if (!servings.ok) return asFailure(servings);
    const ingredients = readIngredients(recipeRaw);
    if (!ingredients.ok) return asFailure(ingredients);

    const digest = sha256Hex(ingredients.value.map((entry) => entry.line_ref).join('\n')).slice(0, 12);
    return {
      ok: true,
      recipe: Object.freeze({
        adapted: ingredients.value,
        recipe_key: `${identity.value}#${digest}`,
        title: title.value,
        base_servings: servings.value,
      }),
    };
  } catch {
    return fail('validation_error');
  }
}
