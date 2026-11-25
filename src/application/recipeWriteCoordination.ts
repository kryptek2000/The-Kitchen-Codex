/**
 * Shared recipe write coordination helpers.
 *
 * Used by App.tsx (commitRecipeWrite) and by deterministic concurrency tests.
 */

import type { ObsidianRecipe } from '../types';

export function normalizeRecipeWriteKey(recipe: ObsidianRecipe): string {
  const path = (recipe.filePath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  return path || recipe.id || recipe.fileName;
}

export function deepEqualRecipeValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

/**
 * Rebase `desired` onto `latest` using `base` to determine which fields the
 * operation actually intended to change. Only changed fields are applied, so a
 * queued operation cannot clobber fields committed by a predecessor.
 */
export function rebaseRecipeOntoLatest(
  latest: ObsidianRecipe | undefined,
  base: ObsidianRecipe | undefined,
  desired: ObsidianRecipe
): ObsidianRecipe {
  if (!latest) return desired;
  const result: ObsidianRecipe = { ...latest };
  for (const key of Object.keys(desired) as Array<keyof ObsidianRecipe>) {
    if (key === 'rawMarkdown') continue;
    const baseVal = base ? base[key] : undefined;
    const desiredVal = desired[key];
    if (!deepEqualRecipeValue(baseVal, desiredVal)) {
      (result as any)[key] = desiredVal;
    }
  }
  return result;
}

export function enqueueRecipeWrite(
  chains: Map<string, Promise<void>>,
  recipe: ObsidianRecipe,
  task: () => Promise<void>
): Promise<void> {
  const key = normalizeRecipeWriteKey(recipe);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  chains.set(key, next);
  return next;
}
