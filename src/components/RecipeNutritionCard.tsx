import React, { useState } from 'react';
import {
  Sparkles,
  Flame,
  Activity,
  Check,
  RefreshCw,
  AlertCircle,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { ObsidianRecipe, RecipeNutrition } from '../types';
import {
  normalizeServings,
  nutritionForServings,
  roundNutritionForDisplay,
  nutritionForRequestedServings,
  resolveRecipeBaseServings,
} from '../utils/nutrition';

interface RecipeNutritionCardProps {
  recipe: ObsidianRecipe;
  onUpdateNutrition: (nutrition: RecipeNutrition) => Promise<boolean | void> | void;
  servings?: number;
}

/** Human-readable provenance label; null when provenance is absent. */
function nutritionSourceLabel(source?: RecipeNutrition['source']): string | null {
  switch (source) {
    case 'ai_estimate': return 'AI Estimate';
    case 'offline_heuristic': return 'Offline Estimate';
    case 'user_defined': return 'User Defined';
    case 'source_metadata': return 'Source Nutrition';
    case 'database': return 'Database';
    default: return null;
  }
}

/** Human-readable confidence label; null when confidence is absent. */
function nutritionConfidenceLabel(confidence?: RecipeNutrition['confidence']): string | null {
  switch (confidence) {
    case 'high': return 'High confidence';
    case 'medium': return 'Medium confidence';
    case 'low': return 'Low confidence';
    case 'unknown': return 'Unknown confidence';
    default: return null;
  }
}

export const RecipeNutritionCard: React.FC<RecipeNutritionCardProps> = ({
  recipe,
  onUpdateNutrition,
  servings,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingEstimate, setPendingEstimate] = useState<RecipeNutrition | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const recipeBaseServings = resolveRecipeBaseServings(recipe.servings);
  const currentServings = normalizeServings(servings ?? recipe.servings, recipeBaseServings);
  const currentNutrition = recipe.nutrition;

  // Stored nutrition is the stable recipe-total baseline. The displayed value is
  // always the deterministic requested-serving result, produced by the SAME
  // shared display contract used by the top recipe-info Calories summary (via
  // nutritionForRequestedServings) so the two can never drift apart.
  const displayedNutrition = nutritionForRequestedServings(currentNutrition, currentServings);

  // A freshly estimated value from the backend is TOTAL nutrition for the base
  // batch. Scale it deterministically to the currently requested servings for
  // display, exactly like the persisted baseline.
  const displayedPending = pendingEstimate
    ? roundNutritionForDisplay(
        nutritionForServings(pendingEstimate, recipeBaseServings, currentServings)
      )
    : null;

  // Provenance labels (subtle; null when absent so nothing misleading is shown).
  const currentSourceLabel = nutritionSourceLabel(currentNutrition?.source);
  const currentConfidenceLabel = nutritionConfidenceLabel(currentNutrition?.confidence);
  const pendingSourceLabel = nutritionSourceLabel(pendingEstimate?.source);
  const pendingConfidenceLabel = nutritionConfidenceLabel(pendingEstimate?.confidence);
  const provenanceText = [currentSourceLabel, currentConfidenceLabel]
    .filter(Boolean)
    .join(' · ');

  // Macro calculations for ratio bar (ratios are scale-invariant)
  const protein = displayedNutrition?.protein || 0;
  const carbs = displayedNutrition?.carbohydrates || 0;
  const fat = displayedNutrition?.fat || 0;
  const totalMacroGrams = protein + carbs + fat;

  const proteinPct = totalMacroGrams > 0 ? Math.round((protein / totalMacroGrams) * 100) : 0;
  const carbsPct = totalMacroGrams > 0 ? Math.round((carbs / totalMacroGrams) * 100) : 0;
  const fatPct = totalMacroGrams > 0 ? Math.max(0, 100 - proteinPct - carbsPct) : 0;

  const handleEstimate = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    setSaveSuccess(false);

    try {
      const ingredientList = recipe.ingredients.map((ing) => ing.original || ing.name);

      const res = await fetch('/api/estimate-nutrition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: recipe.title,
          // The estimator is called against the recipe AS WRITTEN (unscaled base
          // ingredient batch). `servings` is accepted for API compatibility and is
          // never used as a nutrition denominator; we send the recipe's original
          // serving count for clarity.
          servings: recipeBaseServings,
          ingredients: ingredientList,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to estimate nutrition.');
      }

      setPendingEstimate(data.nutrition);
    } catch (err: any) {
      setErrorMsg(err.message || 'An unexpected error occurred while estimating nutrition.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyEstimate = async () => {
    if (!pendingEstimate) return;
    try {
      // Persist the STABLE recipe-total baseline plus its original serving
      // denominator. The displayed value is a deterministic derivation of this.
      await onUpdateNutrition({ ...pendingEstimate, servings: recipeBaseServings });
      setPendingEstimate(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save nutrition to vault.');
    }
  };

  const handleDiscardEstimate = () => {
    setPendingEstimate(null);
    setErrorMsg(null);
  };

  return (
    <div
      id="recipe-nutrition-card"
      className="bg-[#141414] rounded-2xl border border-white/5 p-5 shadow-xs text-gray-200"
    >
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-serif font-bold text-white flex items-center gap-1.5">
              <span>Nutrition & Macros</span>
              <span className="text-[10px] font-mono text-gray-400 font-normal">
                (for {currentServings} servings)
              </span>
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Estimate AI Trigger Button */}
          <button
            id="estimate-nutrition-ai-btn"
            onClick={handleEstimate}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 transition-all disabled:opacity-50 shadow-xs"
            title="Estimate nutritional values per serving using server-side Gemini AI"
          >
            {isLoading ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            <span>{isLoading ? 'Analyzing...' : currentNutrition ? 'Re-estimate' : 'Estimate Nutrition (AI)'}</span>
          </button>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors"
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="mb-3 p-3 rounded-xl bg-rose-950/40 border border-rose-800/40 text-rose-300 text-xs flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold">Nutrition Analysis Notice</p>
            <p className="text-[11px] text-rose-200/90 mt-0.5">{errorMsg}</p>
          </div>
        </div>
      )}

      {saveSuccess && (
        <div className="mb-3 p-2.5 rounded-xl bg-emerald-950/40 border border-emerald-800/40 text-emerald-300 text-xs flex items-center gap-2 animate-in fade-in">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Nutrition saved to recipe Obsidian Markdown frontmatter!</span>
        </div>
      )}

      {/* Pending Estimate Review Dialog */}
      {pendingEstimate && (
        <div className="mb-4 p-4 rounded-xl bg-[#1A1A1A] border border-amber-500/30 space-y-3 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-300 text-xs font-bold">
              <Sparkles className="w-4 h-4" />
              <span>AI Estimate Generated — Review & Apply</span>
            </div>
            <span className="text-[10px] font-mono text-gray-400">
              {currentServings} Servings
            </span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">Calories</span>
              <span className="text-sm font-bold text-white">{displayedPending?.calories ?? pendingEstimate.calories}</span>
              <span className="text-[10px] text-gray-500 block">kcal</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">Protein</span>
              <span className="text-sm font-bold text-emerald-400">{displayedPending?.protein ?? pendingEstimate.protein ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">Carbs</span>
              <span className="text-sm font-bold text-blue-400">{displayedPending?.carbohydrates ?? pendingEstimate.carbohydrates ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">Fat</span>
              <span className="text-sm font-bold text-amber-400">{displayedPending?.fat ?? pendingEstimate.fat ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">Fiber</span>
              <span className="text-sm font-bold text-purple-400">{displayedPending?.fiber ?? pendingEstimate.fiber ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">Sodium</span>
              <span className="text-sm font-bold text-orange-400">{displayedPending?.sodium ?? pendingEstimate.sodium ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">mg</span>
            </div>
          </div>

          {(pendingSourceLabel || pendingConfidenceLabel) && (
            <p className="text-[11px] text-gray-400 font-medium">
              {[pendingSourceLabel, pendingConfidenceLabel].filter(Boolean).join(' · ')}
            </p>
          )}

          {pendingEstimate.confidenceNote && (
            <p className="text-[11px] text-gray-400 italic">
              Note: {pendingEstimate.confidenceNote}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={handleDiscardEstimate}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              Discard
            </button>
            <button
              id="save-nutrition-btn"
              onClick={handleApplyEstimate}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-black transition-colors shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Save to Recipe Markdown</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Nutrition Visual Display */}
      {isExpanded && (
        <div className="space-y-4">
          {currentNutrition || (recipe.calories !== undefined && recipe.calories !== null) ? (
            <>
              {/* Provenance (subtle; omitted when absent) */}
              {provenanceText && (
                <div className="flex items-center justify-center">
                  <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wide bg-white/5 border border-white/5 rounded-full px-2 py-0.5">
                    {provenanceText}
                  </span>
                </div>
              )}
              {/* Macro Cards Grid */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">Calories</span>
                  <span className="text-base font-serif font-bold text-white">
                    {displayedNutrition?.calories ?? recipe.calories ?? '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">kcal</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">Protein</span>
                  <span className="text-base font-serif font-bold text-emerald-400">
                    {displayedNutrition?.protein !== undefined ? `${displayedNutrition.protein}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">{proteinPct > 0 ? `${proteinPct}%` : 'macro'}</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">Carbs</span>
                  <span className="text-base font-serif font-bold text-blue-400">
                    {displayedNutrition?.carbohydrates !== undefined ? `${displayedNutrition.carbohydrates}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">{carbsPct > 0 ? `${carbsPct}%` : 'macro'}</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">Fat</span>
                  <span className="text-base font-serif font-bold text-amber-400">
                    {displayedNutrition?.fat !== undefined ? `${displayedNutrition.fat}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">{fatPct > 0 ? `${fatPct}%` : 'macro'}</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">Fiber</span>
                  <span className="text-base font-serif font-bold text-purple-400">
                    {displayedNutrition?.fiber !== undefined ? `${displayedNutrition.fiber}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">dietary</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">Sodium</span>
                  <span className="text-base font-serif font-bold text-orange-400">
                    {displayedNutrition?.sodium !== undefined ? `${displayedNutrition.sodium}mg` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">mineral</span>
                </div>
              </div>

              {/* Macro Distribution Ratio Bar */}
              {totalMacroGrams > 0 && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[11px] font-mono">
                    <span className="text-emerald-400 font-medium">Protein {proteinPct}%</span>
                    <span className="text-blue-400 font-medium">Carbs {carbsPct}%</span>
                    <span className="text-amber-400 font-medium">Fat {fatPct}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full overflow-hidden bg-white/5 flex">
                    <div
                      style={{ width: `${proteinPct}%` }}
                      className="bg-emerald-500 h-full transition-all duration-500"
                      title={`Protein: ${protein}g (${proteinPct}%)`}
                    />
                    <div
                      style={{ width: `${carbsPct}%` }}
                      className="bg-blue-500 h-full transition-all duration-500"
                      title={`Carbohydrates: ${carbs}g (${carbsPct}%)`}
                    />
                    <div
                      style={{ width: `${fatPct}%` }}
                      className="bg-amber-500 h-full transition-all duration-500"
                      title={`Fat: ${fat}g (${fatPct}%)`}
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-5 px-4 rounded-xl bg-[#0E0E0E] border border-dashed border-white/10 space-y-2">
              <p className="text-xs text-gray-400">
                No nutrition metadata is recorded in this recipe's frontmatter yet.
              </p>
              <button
                onClick={handleEstimate}
                disabled={isLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Estimate with Gemini AI</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
