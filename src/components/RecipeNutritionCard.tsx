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
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from '../application/aiSelection';
import {
  normalizeServings,
  nutritionForServings,
  roundNutritionForDisplay,
  nutritionForRequestedServings,
  resolveRecipeBaseServings,
  nutritionEstimateHeading,
  NUTRITION_INCOMPLETE_MESSAGE,
  NUTRITION_AUTOSAVE_DISABLED_MESSAGE,
  buildNutritionApplyPayload,
} from '../utils/nutrition';
import {
  canApplyNutritionEstimate,
  evaluateMachineNutritionApplicability,
  type NutritionAssessment,
} from '../core/nutritionSanity';

/** A pending estimate may carry the additive machine-resolution assessment. */
type PendingNutritionEstimate = RecipeNutrition & { assessment?: NutritionAssessment };

interface RecipeNutritionCardProps {
  recipe: ObsidianRecipe;
  onUpdateNutrition: (nutrition: RecipeNutrition) => Promise<boolean | void> | void;
  servings?: number;
  network: NetworkAdapter;
  /**
   * Compact nutrition derived from a recognized saved Advanced block. When
   * present it is the display authority for this normal card (single authority,
   * no competing stored dataset). Absent for legacy-only/empty recipes.
   */
  derivedNutrition?: RecipeNutrition;
  /** Provenance label shown when `derivedNutrition` is used. */
  derivedSourceLabel?: string;
  /**
   * Set when a recognized saved Advanced block is INCOMPLETE. The compact card
   * must then clearly show an incomplete state rather than isolated partial
   * nutrient values masquerading as whole-recipe totals.
   */
  advancedIncomplete?: { resolved: number; total: number };
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
  network,
  derivedNutrition,
  derivedSourceLabel,
  advancedIncomplete,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingEstimate, setPendingEstimate] = useState<PendingNutritionEstimate | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const recipeBaseServings = resolveRecipeBaseServings(recipe.servings);
  const currentServings = normalizeServings(servings ?? recipe.servings, recipeBaseServings);
  const currentNutrition = recipe.nutrition;

  // The display authority is the Advanced-derived compact nutrition when a
  // recognized saved Advanced block exists; otherwise the recipe's own stored
  // nutrition. Never merged, never topped up from the other source.
  const effectiveNutrition = derivedNutrition ?? currentNutrition;

  // CURRENT-RECIPE-SCALE BASIS: the displayed values are the canonical saved
  // entire-recipe totals scaled by `currentServings / savedBaseServings` (the
  // shared serving contract), so changing the recipe serving control rescales
  // nutrition exactly like the ingredient quantities. The canonical saved block
  // is never mutated.
  const displayedNutrition = nutritionForRequestedServings(effectiveNutrition, currentServings);

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
  const provenanceText = derivedNutrition
    ? (derivedSourceLabel ?? 'Advanced Nutrition · USDA reviewed')
    : [currentSourceLabel, currentConfidenceLabel].filter(Boolean).join(' · ');

  // FAIL CLOSED: a pending machine estimate may only be applied when the
  // centralized applicability contract authorizes it. The contract requires an
  // explicit trusted assessment with complete structured provenance; automated
  // application is additionally disabled until provenance can be persisted.
  const pendingAssessment = pendingEstimate?.assessment;
  const pendingApplyCheck = pendingEstimate
    ? canApplyNutritionEstimate(pendingEstimate, pendingAssessment, recipeBaseServings)
    : { ok: false, reasons: [] as string[] };
  const canApplyPending = Boolean(pendingEstimate) && pendingApplyCheck.ok;
  const pendingRules = pendingEstimate
    ? evaluateMachineNutritionApplicability(pendingEstimate, pendingAssessment, recipeBaseServings)
    : { ok: false, reasons: [] as string[] };
  const pendingHeading = nutritionEstimateHeading(pendingEstimate?.source);
  const pendingProvenance = pendingAssessment?.provenance;
  const pendingUnresolved = pendingProvenance?.unresolvedIngredients ?? [];
  const pendingResolvedCount = pendingProvenance?.resolvedIngredients ?? 0;
  const pendingTotalCount = pendingProvenance?.totalIngredients ?? 0;

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

      const res = await network.post<{ success: boolean; error?: string; nutrition?: any }>(
        '/api/estimate-nutrition',
        {
          title: recipe.title,
          // The estimator is called against the recipe AS WRITTEN (unscaled base
          // ingredient batch). `servings` is accepted for API compatibility and is
          // never used as a nutrition denominator; we send the recipe's original
          // serving count for clarity.
          servings: recipeBaseServings,
          ingredients: ingredientList,
        },
        await buildAiSelectionRequestOptions()
      );

      const data = res.data;

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to estimate nutrition.');
      }

      setPendingEstimate(data.nutrition);
    } catch (err: any) {
      setErrorMsg(err.message || 'An unexpected error occurred while estimating nutrition.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyEstimate = async () => {
    // FAIL CLOSED: buildNutritionApplyPayload returns null for an incomplete or
    // sanity-invalid estimate, so nothing is ever written in that case.
    const payload = buildNutritionApplyPayload(pendingEstimate, pendingAssessment, recipeBaseServings);
    if (!payload) return;
    try {
      // Persist the STABLE recipe-total baseline plus its original serving
      // denominator. The displayed value is a deterministic derivation of this.
      await onUpdateNutrition(payload);
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
                ({derivedNutrition ? `current recipe: ${currentServings} serving${currentServings === 1 ? '' : 's'}` : `for ${currentServings} servings`})
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
              <span>{pendingHeading}</span>
            </div>
            <span className="text-[10px] font-mono text-gray-400">
              {currentServings === recipeBaseServings
                ? `Entire recipe · base ${recipeBaseServings} servings`
                : `Total for ${currentServings} servings · base ${recipeBaseServings}`}
            </span>
          </div>

          {canApplyPending || pendingRules.ok ? (
            <>
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

              <p className="text-[10px] font-mono text-gray-500 text-center">
                Per serving: {Math.round((pendingEstimate.calories ?? 0) / recipeBaseServings)} kcal
                {' · '}{Math.round(((pendingEstimate.protein ?? 0) / recipeBaseServings) * 10) / 10} g protein
              </p>

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

              {!canApplyPending && (
                <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/40 text-amber-200 text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p>{NUTRITION_AUTOSAVE_DISABLED_MESSAGE}</p>
                </div>
              )}
            </>
          ) : (
            <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/40 text-rose-200 text-xs space-y-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="font-semibold">{NUTRITION_INCOMPLETE_MESSAGE}</p>
              </div>
              {pendingProvenance && (
                <p className="text-[11px] text-rose-200/90">
                  {pendingResolvedCount}/{pendingTotalCount} ingredients matched in the curated local reference.
                </p>
              )}
              {pendingAssessment && pendingAssessment.trustedBasis !== true && (
                <p className="text-[11px] text-rose-200/90">
                  AI estimates are not matched in the curated local reference and cannot be applied automatically.
                </p>
              )}
              {pendingUnresolved.length > 0 && (
                <div className="text-[11px] text-rose-200/90">
                  <p className="font-medium">Unresolved ingredients:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {pendingUnresolved.map((line, idx) => (
                      <li key={idx} className="break-words">{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={handleDiscardEstimate}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              Discard
            </button>
            {canApplyPending && (
              <button
                id="save-nutrition-btn"
                onClick={handleApplyEstimate}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-black transition-colors shadow-sm"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Save to Recipe Markdown</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Nutrition Visual Display */}
      {isExpanded && (
        <div className="space-y-4">
          {advancedIncomplete && (
            <div
              data-testid="nutrition-advanced-incomplete"
              className="p-3 rounded-xl bg-amber-950/25 border border-amber-800/40 space-y-1"
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-200">
                  Partial estimate
                </span>
                <p className="text-xs font-semibold text-amber-200">Advanced nutrition incomplete</p>
              </div>
              <p className="text-[11px] text-amber-200/90">
                {advancedIncomplete.resolved} of {advancedIncomplete.total} ingredient line
                {advancedIncomplete.total === 1 ? '' : 's'} resolved.
              </p>
              <p className="text-[11px] text-gray-400">
                Partial estimate — {Math.max(0, advancedIncomplete.total - advancedIncomplete.resolved)}{' '}
                unresolved ingredient line
                {Math.max(0, advancedIncomplete.total - advancedIncomplete.resolved) === 1 ? '' : 's'} are
                excluded from these values. Open Advanced Nutrition to finish review.
              </p>
            </div>
          )}
          {effectiveNutrition || (recipe.calories !== undefined && recipe.calories !== null) ? (
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
                    {displayedNutrition?.calories ?? (derivedNutrition ? undefined : recipe.calories) ?? '—'}
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
