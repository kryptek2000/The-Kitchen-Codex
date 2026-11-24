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

export interface ShisoRecipeView {
  readonly title: string;
  readonly servings: number | null;
  readonly ingredients: ReadonlyArray<{
    readonly text: string;
    readonly name: string;
    /** H-2 stable edit handle; null when the recipe cannot be adapted. */
    readonly line_ref?: string | null;
  }>;
  readonly instructions: ReadonlyArray<{ readonly text: string }>;
}

export interface ShisoRecipeLike {
  readonly title: string;
  readonly servings?: number | string;
  readonly ingredients: ReadonlyArray<{
    readonly name: string;
    readonly original?: string;
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
    const parts: string[] = [];
    if (typeof i.quantity === 'number' && Number.isFinite(i.quantity)) parts.push(String(i.quantity));
    if (typeof i.unit === 'string' && i.unit.length > 0) parts.push(i.unit);
    parts.push(name);
    const text = (authored.length > 0 ? authored : parts.join(' ').trim()).slice(0, 200);
    return {
      text,
      name,
      line_ref: typeof lineRefs[index] === 'string' ? lineRefs[index] : null,
    };
  });
  return {
    title: String(recipe.title ?? '').slice(0, 200),
    servings: parseServings(recipe.servings),
    ingredients,
    instructions: rawInstructions.slice(0, 60).map((s) => ({ text: String(s.text ?? '').slice(0, 400) })),
  };
}

export function useShisoRecipeContext(recipe: ShisoRecipeLike | { title: string } | null): ShisoRecipeView | null {
  return useMemo(
    () => toShisoRecipeView(recipe as ShisoRecipeLike | null),
    [recipe],
  );
}
