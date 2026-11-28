/**
 * The Kitchen Codex — SHISO recipe context adapter.
 *
 * A recipe reaches Shiso through this ONE derivation so that every entry point
 * supplies the same shape, and so that the model never receives a raw vault note.
 *
 * H-2: each ingredient also carries the STABLE `line_ref` handle an edit is
 * addressed by. It is derived with the SAME adaptation authority the nutrition
 * engine uses (`adaptRecipe`), so the handle Shiso reads and the handle the
 * application re-derives are the same value — and a stale handle fails closed
 * when the recipe has changed since it was read. The handle is internal
 * plumbing: the model may use it, but the conversation prompt forbids showing
 * it to the user.
 *
 * Everything here is read-only. It cannot write, and it holds no authority.
 */

import { useMemo } from 'react';
import { adaptRecipe } from '../core/nutritionV2/phase4';
import { parseIngredient } from '../core/nutritionV2/matching/parse';

export interface ShisoRecipeView {
  readonly title: string;
  readonly description?: string;
  readonly servings: number | null;
  readonly category?: string;
  readonly cuisine?: string;
  readonly difficulty?: string;
  readonly tags?: readonly string[];
  readonly prepTime?: string;
  readonly cookTime?: string;
  readonly totalTime?: string;
  readonly ingredients: ReadonlyArray<{
    readonly text: string;
    readonly name: string;
    /** Canonical authored quantity, retained for nutrition actions. */
    readonly amount?: number;
    /** Canonical authored unit, retained for nutrition actions. */
    readonly unit?: string;
    /** Authored preparation after the first comma, when present. */
    readonly preparation?: string;
    /** H-2 stable edit handle; null when the recipe cannot be adapted. */
    readonly line_ref?: string | null;
  }>;
  readonly instructions: ReadonlyArray<{
    readonly text: string;
    /** Stable, non-secret step handle used by instruction reads. */
    readonly step_ref: string;
  }>;
}

export interface ShisoRecipeLike {
  readonly title: string;
  readonly description?: string;
  readonly servings?: number | string;
  readonly category?: string;
  readonly cuisine?: string;
  readonly difficulty?: string;
  readonly tags?: readonly string[];
  readonly prepTime?: string;
  readonly cookTime?: string;
  readonly totalTime?: string;
  readonly ingredients: ReadonlyArray<{
    readonly name: string;
    readonly original?: string;
    readonly note?: string;
    readonly quantity?: number;
    readonly amount?: number | null;
    readonly unit?: string;
  }>;
  readonly instructions: ReadonlyArray<{ readonly text: string }>;
}

function parseServings(raw: number | string | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw !== 'string') return null;
  const match = /(\d+)/.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Trims to a bounded, model-safe view. Long ingredient lists are capped. */
export function toShisoRecipeView(recipe: ShisoRecipeLike | null): ShisoRecipeView | null {
  if (recipe === null) return null;
  const rawIngredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const rawInstructions = Array.isArray(recipe.instructions) ? recipe.instructions : [];
  // The line handles come from the genuine adaptation boundary. When the recipe
  // cannot be adapted there are no handles, and every edit fails closed rather
  // than being addressed by array position alone.
  let lineRefs: ReadonlyArray<string> = [];
  try {
    const adaptation = adaptRecipe(recipe as unknown);
    if (adaptation.ok) lineRefs = adaptation.recipe.adapted.map((entry) => entry.line_ref);
  } catch {
    lineRefs = [];
  }
  const ingredients = rawIngredients.slice(0, 80).map((i, index) => {
    const name = typeof i.name === 'string' ? i.name.slice(0, 160) : '';
    const authored = typeof i.original === 'string' ? i.original.trim() : '';
    const structuredAmount =
      typeof i.amount === 'number' && Number.isFinite(i.amount)
        ? i.amount
        : typeof i.quantity === 'number' && Number.isFinite(i.quantity)
          ? i.quantity
          : undefined;
    const parsedStructured = parseIngredient({
      ...(authored.length > 0 ? { original: authored } : {}),
      ...(structuredAmount !== undefined ? { amount: structuredAmount } : {}),
      ...(typeof i.unit === 'string' && i.unit.length > 0 ? { unit: i.unit } : {}),
      ...(name.length > 0 ? { name } : {}),
    });
    const parsedAuthored = authored.length > 0 ? parseIngredient(authored) : null;
    const amount = structuredAmount ?? (
      parsedAuthored?.ok === true && parsedAuthored.parsed.amount !== null
        ? parsedAuthored.parsed.amount
        : parsedStructured.ok && parsedStructured.parsed.amount !== null
          ? parsedStructured.parsed.amount
          : undefined
    );
    const unit = typeof i.unit === 'string' && i.unit.length > 0
      ? i.unit
      : parsedAuthored?.ok === true
        ? parsedAuthored.parsed.raw_unit
        : parsedStructured.ok
          ? parsedStructured.parsed.raw_unit
          : i.unit;
    const parts: string[] = [];
    if (amount !== undefined) parts.push(String(amount));
    if (typeof unit === 'string' && unit.length > 0) parts.push(unit);
    parts.push(name);
    const text = (authored.length > 0 ? authored : parts.join(' ').trim()).slice(0, 200);
    return {
      text,
      name,
      ...(amount !== undefined ? { amount } : {}),
      ...(typeof unit === 'string' && unit.length > 0 ? { unit } : {}),
      ...(typeof i.note === 'string' && i.note.trim().length > 0 ? { preparation: i.note.trim().slice(0, 240) } : {}),
      line_ref: typeof lineRefs[index] === 'string' ? lineRefs[index] : null,
    };
  });
  return {
    title: String(recipe.title ?? '').slice(0, 200),
    ...(typeof recipe.description === 'string' && recipe.description.trim().length > 0
      ? { description: recipe.description.trim().slice(0, 1200) }
      : {}),
    servings: parseServings(recipe.servings),
    ...(typeof recipe.category === 'string' && recipe.category.trim().length > 0
      ? { category: recipe.category.trim().slice(0, 120) }
      : {}),
    ...(typeof recipe.cuisine === 'string' && recipe.cuisine.trim().length > 0
      ? { cuisine: recipe.cuisine.trim().slice(0, 120) }
      : {}),
    ...(typeof recipe.difficulty === 'string' && recipe.difficulty.trim().length > 0
      ? { difficulty: recipe.difficulty.trim().slice(0, 40) }
      : {}),
    ...(Array.isArray(recipe.tags) ? { tags: recipe.tags.slice(0, 30).map((tag) => String(tag).slice(0, 60)) } : {}),
    ...(typeof recipe.prepTime === 'string' && recipe.prepTime.trim().length > 0 ? { prepTime: recipe.prepTime.trim().slice(0, 40) } : {}),
    ...(typeof recipe.cookTime === 'string' && recipe.cookTime.trim().length > 0 ? { cookTime: recipe.cookTime.trim().slice(0, 40) } : {}),
    ...(typeof recipe.totalTime === 'string' && recipe.totalTime.trim().length > 0 ? { totalTime: recipe.totalTime.trim().slice(0, 40) } : {}),
    ingredients,
    // Instructions stay available for bounded retrieval. They are NEVER sent in
    // the conversation context automatically; the read capability pages them.
    instructions: rawInstructions.slice(0, 200).map((step, index) => ({
      text: String(step.text ?? '').slice(0, 4000),
      step_ref: `step:${index}`,
    })),
  };
}

export function useShisoRecipeContext(recipe: ShisoRecipeLike | { title: string } | null): ShisoRecipeView | null {
  return useMemo(
    () => toShisoRecipeView(recipe as ShisoRecipeLike | null),
    [recipe],
  );
}
