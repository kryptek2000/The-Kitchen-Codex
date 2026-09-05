import React, { useMemo } from 'react';
import { Layers, ChevronRight, Utensils } from 'lucide-react';
import { ObsidianRecipe } from '../types';
import {
  RecipeRelationshipIndex,
  SimilarRecipeResult,
  findSimilarRecipes,
  recipeIdentity,
} from '../utils/recipeRelationships';

/**
 * Formats a culinary relevance score (0..1) as a restrained percentage. A tiny
 * positive score that rounds to 0% is shown as "<1%" rather than a misleading
 * "0%", so a genuine (if weak) relationship is never presented as absent.
 */
export function formatSimilarityPercent(score: number): string {
  const percent = Math.round(score * 100);
  return percent === 0 && score > 0 ? '<1%' : `${percent}%`;
}

/** A similar recipe resolved to a loaded recipe, with its similarity result. */
export interface RelatedRecipeEntry {
  recipe: ObsidianRecipe;
  sim: SimilarRecipeResult;
}

/**
 * Pure selector: returns the recipes CULINARILY similar to the recipe identified
 * by `currentIdentity`, resolved against `recipeByIdentity` (a map keyed by the
 * Step 6 stable recipe identity). Unresolvable references are skipped safely.
 *
 * The current recipe is already excluded by `findSimilarRecipes`. The order is
 * the deterministic culinary order (relevance score desc, then identity asc).
 */
export function selectSimilarRelations(
  currentIdentity: string,
  index: RecipeRelationshipIndex,
  recipeByIdentity: Map<string, ObsidianRecipe>
): RelatedRecipeEntry[] {
  return findSimilarRecipes(index, currentIdentity)
    .map((sim) => ({ recipe: recipeByIdentity.get(sim.recipeId), sim }))
    .filter((entry): entry is RelatedRecipeEntry => Boolean(entry.recipe));
}

interface RecipeRelationshipsPanelProps {
  recipe: ObsidianRecipe;
  index: RecipeRelationshipIndex;
  recipeByIdentity: Map<string, ObsidianRecipe>;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
}

/**
 * A compact "Similar Recipes" surface on the recipe detail.
 *
 * It communicates CULINARY relevance: the subtitle explains WHY a dish is
 * similar (same type / related family / cuisine / course / shared tags), with
 * shared-ingredient overlap shown only as a secondary detail. It reuses a single
 * deterministic relationship authority — no AI, no embeddings, no new dependency,
 * and it never writes anything back to a recipe or its Markdown.
 */
export function RecipeRelationshipsPanel({
  recipe,
  index,
  recipeByIdentity,
  onSelectRecipe,
}: RecipeRelationshipsPanelProps) {
  // `recipeByIdentity` is a stable map reference between renders for the same
  // vault, so this recomputes only when the loaded recipe set changes. The
  // current recipe is identified via `recipeIdentity` (id ?? filePath ??
  // fileName) — the same stable identity the index is keyed on, never title.
  const currentIdentity = recipeIdentity(recipe);
  const relations = useMemo(
    () => selectSimilarRelations(currentIdentity, index, recipeByIdentity),
    [currentIdentity, index, recipeByIdentity]
  );

  return (
    <section
      id="similar-recipes-section"
      className="bg-[#141414] rounded-2xl border border-white/5 p-5 shadow-xs"
    >
      <h3 className="text-base font-serif font-bold text-white pb-3 mb-3 border-b border-white/5 flex items-center gap-2">
        <Layers className="w-4 h-4 text-amber-400" />
        <span>Similar Recipes</span>
        <span className="ml-auto text-[11px] font-normal text-gray-500">
          Culinary similarity
        </span>
      </h3>

      {relations.length === 0 ? (
        <p className="text-xs text-gray-500 py-2">
          No strongly similar recipes found.
        </p>
      ) : (
        <ul className="space-y-2">
          {relations.map(({ recipe: related, sim }) => (
            <li key={related.id}>
              <button
                id={`similar-recipe-${related.id}`}
                onClick={() => onSelectRecipe(related)}
                className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl bg-[#171717] hover:bg-[#1C1C1C] border border-white/5 hover:border-amber-500/30 transition-all group text-left"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-semibold text-white group-hover:text-amber-300 truncate block">
                    {related.title}
                  </span>
                  <span className="text-[11px] text-gray-500 flex items-center gap-1.5">
                    <Utensils className="w-3 h-3 text-amber-400/70 shrink-0" />
                    <span className="truncate">{sim.reason}</span>
                  </span>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <span className="text-[11px] text-gray-600">
                    {sim.sharedCount > 0
                      ? `${sim.sharedCount} shared ingredient${sim.sharedCount === 1 ? '' : 's'}`
                      : ''}
                  </span>
                  <span className="text-[11px] font-mono text-amber-400">
                    {formatSimilarityPercent(sim.score)}
                  </span>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-500 group-hover:text-amber-400 transition-colors shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
