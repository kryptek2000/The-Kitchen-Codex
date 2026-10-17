import { calculateProductionBasicNutrition } from '../browser/basicNutrition';
import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
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
import {
  isPartialMachineNutrition,
  normalizeServings,
  nutritionForServings,
  roundNutritionForDisplay,
  nutritionForRequestedServings,
  resolveRecipeBaseServings,
} from '../utils/nutrition';
import {
  basicEstimateToNutrition,
  type BasicNutritionEstimate,
} from '../application/basicNutrition';

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
  /** Nutrients whose saved Advanced amounts are known partial subtotals. */
  derivedPartialNutrients?: ReadonlyArray<'calories' | 'protein' | 'carbohydrates' | 'fat' | 'fiber' | 'sodium'>;
  /** Provenance label shown when `derivedNutrition` is used. */
  derivedSourceLabel?: string;
  /**
   * Set when a recognized saved Advanced block is INCOMPLETE. The compact card
   * must then clearly show an incomplete state rather than isolated partial
   * nutrient values masquerading as whole-recipe totals.
   */
  advancedIncomplete?: { resolved: number; total: number; unresolved?: number; excluded?: number; stale?: boolean };
  /**
   * Retained for callers from the Advanced-consolidation era. The card no
   * longer hosts a legacy AI estimator: its ONE action is the deterministic,
   * offline Basic Nutrition calculation, which works with or without Gemini.
   */
  hideLegacyEstimator?: boolean;
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
  network: _network,
  derivedNutrition,
  derivedPartialNutrients = [],
  derivedSourceLabel,
  advancedIncomplete,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [basicEstimate, setBasicEstimate] = useState<BasicNutritionEstimate | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const recipeBaseServings = resolveRecipeBaseServings(recipe.servings);
  const currentServings = normalizeServings(servings ?? recipe.servings, recipeBaseServings);
  const currentNutrition = recipe.nutrition;
  const recipeKey = JSON.stringify([recipe.id, recipe.filePath, recipe.servings, recipe.ingredients]);
  const currentKey = useRef(recipeKey);
  currentKey.current = recipeKey;
  const estimateKey = useRef<string | null>(null);
  useEffect(() => { setBasicEstimate(null); setIsLoading(false); }, [recipeKey]);
  const savedPartial = !derivedNutrition && isPartialMachineNutrition(currentNutrition);

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

  // A Basic estimate is WHOLE-RECIPE totals for the base batch; scale it to the
  // currently requested servings for display, exactly like a persisted baseline.
  const basicDisplayedTotals = basicEstimate
    ? (basicEstimate.coverage.complete ? basicEstimate.totals : basicEstimate.knownSubtotal)
    : null;
  const displayedBasic = basicEstimate && basicDisplayedTotals
    ? roundNutritionForDisplay(
        nutritionForServings(
          {
            ...(basicDisplayedTotals.calories !== null ? { calories: basicDisplayedTotals.calories } : {}),
            ...(basicDisplayedTotals.protein !== null ? { protein: basicDisplayedTotals.protein } : {}),
            ...(basicDisplayedTotals.carbohydrates !== null ? { carbohydrates: basicDisplayedTotals.carbohydrates } : {}),
            ...(basicDisplayedTotals.fat !== null ? { fat: basicDisplayedTotals.fat } : {}),
            ...(basicDisplayedTotals.fiber !== null ? { fiber: basicDisplayedTotals.fiber } : {}),
            ...(basicDisplayedTotals.sodium !== null ? { sodium: basicDisplayedTotals.sodium } : {}),
          },
          recipeBaseServings,
          currentServings,
        ),
      )
    : null;

  // Divide precise batch values before rounding; the tile values remain batch totals.
  const basicPerServing = basicDisplayedTotals
    ? roundNutritionForDisplay(Object.fromEntries(Object.entries(basicDisplayedTotals).filter(([, value]) => typeof value === 'number').map(([key, value]) => [key, (value as number) / recipeBaseServings])))
    : null;

  // Provenance labels (subtle; null when absent so nothing misleading is shown).
  const currentSourceLabel = nutritionSourceLabel(currentNutrition?.source);
  const currentConfidenceLabel = nutritionConfidenceLabel(currentNutrition?.confidence);
  const provenanceText = derivedNutrition
    ? (derivedSourceLabel ?? 'Advanced Nutrition · USDA reviewed')
    : [currentSourceLabel, currentConfidenceLabel].filter(Boolean).join(' · ');
  const partialNutrientSet = new Set(derivedPartialNutrients);

  // Macro calculations for ratio bar (ratios are scale-invariant)
  const protein = displayedNutrition?.protein || 0;
  const carbs = displayedNutrition?.carbohydrates || 0;
  const fat = displayedNutrition?.fat || 0;
  const totalMacroGrams = protein + carbs + fat;

  const proteinPct = totalMacroGrams > 0 ? Math.round((protein / totalMacroGrams) * 100) : 0;
  const carbsPct = totalMacroGrams > 0 ? Math.round((carbs / totalMacroGrams) * 100) : 0;
  const fatPct = totalMacroGrams > 0 ? Math.max(0, 100 - proteinPct - carbsPct) : 0;

  /**
   * The ONE Basic Nutrition action, shared with the Visual Recipe Editor
   * (same service). Deterministic + offline: the shared measurement parser,
   * the pinned USDA catalog, applicable portions, and disclosed quantity estimates. No
   * provider call. Nothing is saved here.
   */
  const handleEstimate = async () => {
    const capturedKey = currentKey.current;
    setIsLoading(true);
    setErrorMsg(null);
    setSaveSuccess(false);

    try {
      const ingredientList = recipe.ingredients.map((ing) => ing.original || ing.name);
      const estimate = await calculateProductionBasicNutrition({
        ingredients: ingredientList,
        servings: recipeBaseServings,
      });
      if (capturedKey !== currentKey.current) return;
      if (!estimate.ok) {
        throw new Error(estimate.message ?? 'Nutrition could not be calculated for this recipe.');
      }
      estimateKey.current = capturedKey;
      setBasicEstimate(estimate);
    } catch (err: any) {
      if (capturedKey !== currentKey.current) return;
      setErrorMsg(err.message || 'An unexpected error occurred while calculating nutrition.');
    } finally {
      if (capturedKey === currentKey.current) setIsLoading(false);
    }
  };

  /** Explicit user action: persist the stable whole-recipe totals baseline. */
  const handleApplyEstimate = async () => {
    const payload = basicEstimate ? basicEstimateToNutrition(basicEstimate, { allowPartial: true }) : null;
    if (!payload || estimateKey.current !== currentKey.current) return;
    try {
      const saved = await onUpdateNutrition(payload);
      if (saved === false) throw new Error('Nutrition was not saved.');
      setBasicEstimate(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save nutrition to vault.');
    }
  };

  const handleDiscardEstimate = () => {
    setBasicEstimate(null);
    setErrorMsg(null);
  };

  const estimateLineCount = basicEstimate?.coverage.total ?? 0;
  const estimateUnresolved = basicEstimate?.lines.filter((line) => line.status === 'unresolved') ?? [];

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
          {(!effectiveNutrition || savedPartial) && !derivedNutrition && (
            <button
              id="calculate-basic-nutrition-btn"
              data-testid="calculate-basic-nutrition-btn"
              onClick={handleEstimate}
              disabled={isLoading}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold text-amber-300 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 transition-all disabled:opacity-50 shadow-xs"
              title="Estimate per-serving nutrition from the curated local food reference — offline, no AI required"
            >
              {isLoading ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{isLoading ? 'Calculating…' : 'Calculate Basic Nutrition'}</span>
            </button>
          )}

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
            <p className="font-semibold">Nutrition Calculation Notice</p>
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

      {/* Basic estimate review (explicit save — never silent) */}
      {basicEstimate && (
        <div
          data-testid="basic-nutrition-review"
          className="mb-4 p-4 rounded-xl bg-[#1A1A1A] border border-amber-500/30 space-y-3 animate-in fade-in"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-amber-300 text-xs font-bold">
              <Sparkles className="w-4 h-4" />
              <span>{basicEstimate.coverage.complete ? 'Basic Nutrition Estimate — Review & Save' : 'Basic Nutrition Partial Subtotal — Review & Save'}</span>
            </div>
            <span className="text-[10px] font-mono text-gray-400">
              {currentServings === recipeBaseServings
                ? `Entire recipe · base ${recipeBaseServings} servings`
                : `Total for ${currentServings} servings · base ${recipeBaseServings}`}
            </span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">{basicEstimate.coverage.complete ? 'Calories' : 'Calories · subtotal'}</span>
              <span className="text-sm font-bold text-white">{displayedBasic?.calories ?? basicEstimate.totals.calories ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">kcal</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">{basicEstimate.coverage.complete ? 'Protein' : 'Protein · subtotal'}</span>
              <span className="text-sm font-bold text-emerald-400">{displayedBasic?.protein ?? basicEstimate.totals.protein ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">{basicEstimate.coverage.complete ? 'Carbs' : 'Carbs · subtotal'}</span>
              <span className="text-sm font-bold text-blue-400">{displayedBasic?.carbohydrates ?? basicEstimate.totals.carbohydrates ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">{basicEstimate.coverage.complete ? 'Fat' : 'Fat · subtotal'}</span>
              <span className="text-sm font-bold text-amber-400">{displayedBasic?.fat ?? basicEstimate.totals.fat ?? '—'}</span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">{basicEstimate.coverage.complete ? 'Fiber' : 'Fiber · subtotal'}</span>
              <span className="text-sm font-bold text-purple-400">
                {displayedBasic?.fiber ?? '—'}
              </span>
              <span className="text-[10px] text-gray-500 block">g</span>
            </div>
            <div className="p-2 rounded-lg bg-[#111] border border-white/5">
              <span className="text-[10px] text-gray-400 uppercase font-mono block">{basicEstimate.coverage.complete ? 'Sodium' : 'Sodium · subtotal'}</span>
              <span className="text-sm font-bold text-orange-400">
                {displayedBasic?.sodium ?? '—'}
              </span>
              <span className="text-[10px] text-gray-500 block">mg</span>
            </div>
          </div>

          <p className="text-[10px] font-mono text-gray-500 text-center">
            Per serving at {currentServings} servings{basicEstimate.coverage.complete ? '' : ' · partial subtotal'}: {basicPerServing?.calories ?? '—'} kcal
            {' · '}{basicPerServing?.protein ?? '—'} g protein
            {' · '}{basicEstimate.coverage.resolved}/{basicEstimate.coverage.total} ingredient lines covered
          </p>

          <p className="text-[11px] text-gray-400 font-medium">
            Offline Estimate · {basicEstimate.confidence === 'high' ? 'High confidence' : basicEstimate.confidence === 'medium' ? 'Medium confidence' : basicEstimate.confidence === 'low' ? 'Low confidence' : 'Unknown confidence'}
          </p>

          {!basicEstimate.coverage.complete && (
            <div
              data-testid="basic-nutrition-partial"
              className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/40 text-amber-200 text-xs flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p>
                  Partial estimate — {basicEstimate.coverage.resolved} of {estimateLineCount} ingredient lines contributed.
                  The figures above are known subtotals per serving. Unresolved lines are excluded; full recipe totals are unknown.
                </p>
                {estimateUnresolved.length > 0 && (
                  <ul className="list-disc list-inside space-y-0.5 text-[11px]">
                    {estimateUnresolved.slice(0, 5).map((line) => (
                      <li key={line.ingredient} className="break-words">{line.ingredient}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {basicEstimate.assumptions.length > 0 && (
            <details className="text-[11px] text-gray-400">
              <summary className="cursor-pointer text-gray-400 hover:text-gray-300">
                Portion assumptions ({basicEstimate.assumptions.length})
              </summary>
              <ul className="list-disc list-inside space-y-0.5 mt-1">
                {basicEstimate.assumptions.map((note) => (
                  <li key={note} className="break-words">{note}</li>
                ))}
              </ul>
            </details>
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
              data-testid="save-nutrition-btn"
              onClick={handleApplyEstimate}
              disabled={!basicEstimateToNutrition(basicEstimate, { allowPartial: true })}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-black transition-colors shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{basicEstimate.coverage.complete ? 'Save to Recipe Markdown' : 'Save labeled partial subtotal'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Nutrition Visual Display */}
      {isExpanded && (
        <div className="space-y-4">
          {savedPartial && <p className="text-xs text-amber-300" data-testid="saved-basic-partial">Saved partial subtotal — recipe totals are unknown. Recalculate and review before saving.</p>}
          {advancedIncomplete && (
            <div
              data-testid="nutrition-advanced-incomplete"
              className="p-3 rounded-xl bg-amber-950/25 border border-amber-800/40 space-y-1"
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-200">
                  {advancedIncomplete.stale ? 'Needs recalculation' : 'Partial estimate'}
                </span>
                <p className="text-xs font-semibold text-amber-200">Advanced nutrition incomplete</p>
              </div>
              <p className="text-[11px] text-amber-200/90">
                {advancedIncomplete.resolved + (advancedIncomplete.excluded ?? 0)} of {advancedIncomplete.total} ingredient line
                {advancedIncomplete.total === 1 ? '' : 's'} accounted for
                {advancedIncomplete.excluded ? ` · ${advancedIncomplete.excluded} wrapper excluded` : ''}.
              </p>
              <p className="text-[11px] text-gray-400">
                {advancedIncomplete.stale ? <>Saved evidence does not match the current recipe. Totals are unknown. Recalculate Advanced Nutrition.</> : advancedIncomplete.unresolved === 0 ? <>
                  Nutrient coverage is partial; known amounts are subtotals and missing nutrients remain unknown.
                </> : <>
                  Partial estimate — {advancedIncomplete.unresolved ?? Math.max(0, advancedIncomplete.total - advancedIncomplete.resolved - (advancedIncomplete.excluded ?? 0))} unresolved ingredient line{(advancedIncomplete.unresolved ?? Math.max(0, advancedIncomplete.total - advancedIncomplete.resolved - (advancedIncomplete.excluded ?? 0))) === 1 ? '' : 's'}.
                  Known amounts are subtotals; full recipe totals are unknown. Open Advanced Nutrition to finish review.
                </>}
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
              {!derivedNutrition && currentNutrition?.confidenceNote && (
                <p data-testid="saved-basic-evidence" className="text-[11px] text-gray-400">{currentNutrition.confidenceNote}</p>
              )}
              {/* Macro Cards Grid */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">{savedPartial || partialNutrientSet.has('calories') ? 'Calories · subtotal' : 'Calories'}</span>
                  <span className="text-base font-serif font-bold text-white">
                    {displayedNutrition?.calories ?? (derivedNutrition || savedPartial ? undefined : recipe.calories) ?? '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">kcal</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">{savedPartial || partialNutrientSet.has('protein') ? 'Protein · subtotal' : 'Protein'}</span>
                  <span className="text-base font-serif font-bold text-emerald-400">
                    {displayedNutrition?.protein !== undefined ? `${displayedNutrition.protein}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">{proteinPct > 0 ? `${proteinPct}% of macro grams` : 'macro'}</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">{savedPartial || partialNutrientSet.has('carbohydrates') ? 'Carbs · subtotal' : 'Carbs'}</span>
                  <span className="text-base font-serif font-bold text-blue-400">
                    {displayedNutrition?.carbohydrates !== undefined ? `${displayedNutrition.carbohydrates}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">{carbsPct > 0 ? `${carbsPct}% of macro grams` : 'macro'}</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">{savedPartial || partialNutrientSet.has('fat') ? 'Fat · subtotal' : 'Fat'}</span>
                  <span className="text-base font-serif font-bold text-amber-400">
                    {displayedNutrition?.fat !== undefined ? `${displayedNutrition.fat}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">{fatPct > 0 ? `${fatPct}% of macro grams` : 'macro'}</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">{savedPartial || partialNutrientSet.has('fiber') ? 'Fiber · subtotal' : 'Fiber'}</span>
                  <span className="text-base font-serif font-bold text-purple-400">
                    {displayedNutrition?.fiber !== undefined ? `${displayedNutrition.fiber}g` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">dietary</span>
                </div>

                <div className="p-2.5 rounded-xl bg-[#0E0E0E] border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase font-mono block">{savedPartial || partialNutrientSet.has('sodium') ? 'Sodium · subtotal' : 'Sodium'}</span>
                  <span className="text-base font-serif font-bold text-orange-400">
                    {displayedNutrition?.sodium !== undefined ? `${displayedNutrition.sodium}mg` : '—'}
                  </span>
                  <span className="text-[10px] text-gray-500 block">mineral</span>
                </div>
              </div>

              {/* Macro Distribution Ratio Bar */}
              <p className="text-[10px] text-gray-500">Macro percentages compare grams, not calories.</p>
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
                No nutrition is recorded for this recipe yet.
              </p>
              <p className="text-[11px] text-gray-500">
                Calculate a basic estimate from the pinned local USDA catalog — no AI
                required. Nothing is saved until you choose to save it.
              </p>
              <button
                id="calculate-basic-nutrition-empty-btn"
                data-testid="calculate-basic-nutrition-empty-btn"
                onClick={handleEstimate}
                disabled={isLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{isLoading ? 'Calculating…' : 'Calculate Basic Nutrition'}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
