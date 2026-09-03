import React, { useEffect, useMemo } from 'react';
import { X, Utensils, Search } from 'lucide-react';
import { ObsidianRecipe } from '../types';
import {
  RecipeRelationshipIndex,
  getRecipesUsingIngredient,
} from '../utils/recipeRelationships';

/**
 * Pure selector: returns the loaded recipes whose deterministic ingredient key
 * matches the `query`, excluding the recipe identified by `currentIdentity` and
 * skipping any identity that cannot be resolved to a loaded recipe.
 *
 * It relies entirely on the Step 6 deterministic index (exact relationship key):
 * no substring matching, no fuzzy/semantic search.
 */
export function selectIngredientRecipes(
  index: RecipeRelationshipIndex,
  query: string,
  currentIdentity: string,
  recipeByIdentity: Map<string, ObsidianRecipe>
): ObsidianRecipe[] {
  return getRecipesUsingIngredient(index, query)
    .filter((id) => id !== currentIdentity)
    .map((id) => recipeByIdentity.get(id))
    .filter((recipe): recipe is ObsidianRecipe => Boolean(recipe));
}

interface IngredientUsageModalProps {
  isOpen: boolean;
  /** Display text for the ingredient (e.g. the alias/display name). */
  display: string;
  /** The ingredient source text used to derive the deterministic key. */
  query: string;
  currentIdentity: string;
  index: RecipeRelationshipIndex;
  recipeByIdentity: Map<string, ObsidianRecipe>;
  onClose: () => void;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
}

/**
 * A compact modal listing recipes that use the same ingredient (by exact
 * Step 6 relationship identity). Lightweight, keyboard-accessible, and purely
 * derived from already-loaded local recipe data — no AI, no network, no
 * relationship metadata written to Markdown.
 */
export function IngredientUsageModal({
  isOpen,
  display,
  query,
  currentIdentity,
  index,
  recipeByIdentity,
  onClose,
  onSelectRecipe,
}: IngredientUsageModalProps) {
  const recipes = useMemo(
    () =>
      isOpen
        ? selectIngredientRecipes(index, query, currentIdentity, recipeByIdentity)
        : [],
    [isOpen, index, query, currentIdentity, recipeByIdentity]
  );

  // Close on Escape (mirrors the app's existing modal convenience).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      id="ingredient-usage-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Recipes using ${display}`}
        className="relative w-full max-w-md bg-[#141414] border border-white/15 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#171717]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
              <Utensils className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-[11px] text-gray-400 font-medium block">Recipes using</span>
              <h2 className="text-sm font-serif font-bold text-white truncate">{display}</h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-2 max-h-[60vh]">
          {recipes.length === 0 ? (
            <div className="py-8 text-center text-gray-500 text-xs space-y-1.5">
              <div className="w-10 h-10 mx-auto rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-amber-400">
                <Search className="w-5 h-5" />
              </div>
              <p>Not used by other recipes.</p>
            </div>
          ) : (
            recipes.map((recipe) => (
              <button
                key={recipe.id}
                id={`ingredient-recipe-${recipe.id}`}
                onClick={() => { onSelectRecipe(recipe); onClose(); }}
                className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl bg-[#171717] hover:bg-[#1C1C1C] border border-white/5 hover:border-amber-500/30 transition-all group text-left"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-semibold text-white group-hover:text-amber-300 truncate block">
                    {recipe.title}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {recipe.cookTime || recipe.totalTime || ''}
                  </span>
                </div>
                <Utensils className="w-4 h-4 text-gray-500 group-hover:text-amber-400 shrink-0 transition-colors" />
              </button>
            ))
          )}
        </div>

        <div className="px-6 py-3 border-t border-white/10 bg-[#171717] flex items-center justify-between text-xs text-gray-400">
          <span className="font-mono text-[11px]">Shared ingredient lookup</span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-200 font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
