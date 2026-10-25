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
  const servingBasisAssumed = !(typeof recipe.servings === 'number' && Number.isFinite(recipe.servings) && recipe.servings > 0);

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

  // Macro comparison bar. Ratios are scale-invariant and unchanged; the bar is
  // only drawn when ALL three macro values are known, so a missing nutrient is
  // never silently treated as zero and never fabricates a distribution.
  const protein = displayedNutrition?.protein;
  const carbs = displayedNutrition?.carbohydrates;
  const fat = displayedNutrition?.fat;
  const hasMacroComparison =
    typeof protein === 'number' &&
    Number.isFinite(protein) &&
    typeof carbs === 'number' &&
    Number.isFinite(carbs) &&
    typeof fat === 'number' &&
    Number.isFinite(fat);
  const totalMacroGrams = hasMacroComparison ? protein + carbs + fat : 0;

  const proteinPct = totalMacroGrams > 0 ? Math.round((protein / totalMacroGrams) * 100) : 0;
  const carbsPct = totalMacroGrams > 0 ? Math.round((carbs / totalMacroGrams) * 100) : 0;
  const fatPct = totalMacroGrams > 0 ? Math.max(0, 100 - proteinPct - carbsPct) : 0;

  // The displayed nutrient values are authoritative and untouched: a known
  // value renders, a missing value stays missing (never 0, never topped up).
  const caloriesValue =
    displayedNutrition?.calories ?? (derivedNutrition || savedPartial ? undefined : recipe.calories) ?? '—';
  const hasNutritionDisplay = Boolean(
    effectiveNutrition || (recipe.calories !== undefined && recipe.calories !== null)
  );
  const showCalculateAction = (!effectiveNutrition || savedPartial) && !derivedNutrition;
  const caloriesLabel =
    savedPartial || partialNutrientSet.has('calories') ? 'Calories · subtotal' : 'Calories';
  const proteinLabel =
    savedPartial || partialNutrientSet.has('protein') ? 'Protein · subtotal' : 'Protein';
  const carbsLabel =
    savedPartial || partialNutrientSet.has('carbohydrates') ? 'Carbs · subtotal' : 'Carbs';
  const fatLabel = savedPartial || partialNutrientSet.has('fat') ? 'Fat · subtotal' : 'Fat';
  const fiberLabel = savedPartial || partialNutrientSet.has('fiber') ? 'Fiber · subtotal' : 'Fiber';
  const sodiumLabel = savedPartial || partialNutrientSet.has('sodium') ? 'Sodium · subtotal' : 'Sodium';

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
        servings: recipe.servings,
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
    <article
      id="recipe-nutrition-card"
      className="overflow-hidden rounded-2xl border border-[var(--color-rule,var(--border-subtle,rgba(255,255,255,0.08)))] bg-[var(--bg-surface,#141414)] text-[var(--text-primary,#F3F4F6)] shadow-sm"
    >
      <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)]"
          >
            <Activity className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">
              Basic nutrition
            </p>
            <h3 className="flex flex-wrap items-baseline gap-x-2 font-serif text-[19px] leading-snug text-[var(--text-primary,#F3F4F6)]">
              <span>{'Nutrition & Macros'}</span>
              <span className="font-mono text-[11px] font-normal tracking-normal text-[var(--text-secondary,#9CA3AF)]">
                ({derivedNutrition ? `current recipe: ${currentServings} serving${currentServings === 1 ? '' : 's'}` : `for ${currentServings} servings`})
              </span>
            </h3>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          aria-controls="recipe-nutrition-card-body"
          aria-label={isExpanded ? 'Collapse nutrition details' : 'Expand nutrition details'}
          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-secondary,#9CA3AF)] transition-colors duration-[140ms] hover:bg-[var(--bg-elevated,#1E1E1E)] hover:text-[var(--text-primary,#F3F4F6)]"
        >
          {isExpanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        </button>
      </header>

      <div id="recipe-nutrition-card-body" className="space-y-4 px-5 pb-5">
        {servingBasisAssumed && (
          <p
            data-testid="basic-assumed-serving-basis"
            className="rounded-xl border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-primary,#F3F4F6)]"
          >
            Recipe yield is not authored. Per-serving calculations use an assumed 4-serving basis; set Servings in the recipe to replace this assumption.
          </p>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] p-3"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
            <div className="flex-1">
              <p className="text-xs font-semibold text-[var(--text-primary,#F3F4F6)]">Nutrition Calculation Notice</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">{errorMsg}</p>
            </div>
          </div>
        )}

        {saveSuccess && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2.5 text-xs text-[var(--text-primary,#F3F4F6)] motion-safe:animate-in motion-safe:fade-in"
          >
            <ShieldCheck className="h-4 w-4 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
            <span>Nutrition saved to recipe Obsidian Markdown frontmatter!</span>
          </div>
        )}

        {/* Basic estimate review (explicit save — never silent) */}
        {basicEstimate && (
          <div
            data-testid="basic-nutrition-review"
            className="space-y-3 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                <p className="text-xs font-semibold text-[var(--text-primary,#F3F4F6)]">
                  {basicEstimate.coverage.complete ? 'Basic Nutrition Estimate — Review & Save' : 'Basic Nutrition Partial Subtotal — Review & Save'}
                </p>
              </div>
              <span className="font-mono text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                {currentServings === recipeBaseServings
                  ? `Entire recipe · base ${recipeBaseServings} servings`
                  : `Total for ${currentServings} servings · base ${recipeBaseServings}`}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-left sm:grid-cols-3">
              <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-2">
                <span className="block font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{basicEstimate.coverage.complete ? 'Calories' : 'Calories · subtotal'}</span>
                <span className="mt-0.5 block font-mono text-sm font-semibold text-[var(--text-primary,#F3F4F6)]">{displayedBasic?.calories ?? basicEstimate.totals.calories ?? '—'}</span>
                <span className="block text-[11px] text-[var(--text-secondary,#9CA3AF)]">kcal</span>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-2">
                <span className="block font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{basicEstimate.coverage.complete ? 'Protein' : 'Protein · subtotal'}</span>
                <span className="mt-0.5 block font-mono text-sm font-semibold text-[var(--text-primary,#F3F4F6)]">{displayedBasic?.protein ?? basicEstimate.totals.protein ?? '—'}</span>
                <span className="block text-[11px] text-[var(--text-secondary,#9CA3AF)]">g</span>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-2">
                <span className="block font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{basicEstimate.coverage.complete ? 'Carbs' : 'Carbs · subtotal'}</span>
                <span className="mt-0.5 block font-mono text-sm font-semibold text-[var(--text-primary,#F3F4F6)]">{displayedBasic?.carbohydrates ?? basicEstimate.totals.carbohydrates ?? '—'}</span>
                <span className="block text-[11px] text-[var(--text-secondary,#9CA3AF)]">g</span>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-2">
                <span className="block font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{basicEstimate.coverage.complete ? 'Fat' : 'Fat · subtotal'}</span>
                <span className="mt-0.5 block font-mono text-sm font-semibold text-[var(--text-primary,#F3F4F6)]">{displayedBasic?.fat ?? basicEstimate.totals.fat ?? '—'}</span>
                <span className="block text-[11px] text-[var(--text-secondary,#9CA3AF)]">g</span>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-2">
                <span className="block font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{basicEstimate.coverage.complete ? 'Fiber' : 'Fiber · subtotal'}</span>
                <span className="mt-0.5 block font-mono text-sm font-semibold text-[var(--text-primary,#F3F4F6)]">{displayedBasic?.fiber ?? '—'}</span>
                <span className="block text-[11px] text-[var(--text-secondary,#9CA3AF)]">g</span>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-2">
                <span className="block font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{basicEstimate.coverage.complete ? 'Sodium' : 'Sodium · subtotal'}</span>
                <span className="mt-0.5 block font-mono text-sm font-semibold text-[var(--text-primary,#F3F4F6)]">{displayedBasic?.sodium ?? '—'}</span>
                <span className="block text-[11px] text-[var(--text-secondary,#9CA3AF)]">mg</span>
              </div>
            </div>

            <p className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
              Per serving at {currentServings} servings{basicEstimate.coverage.complete ? '' : ' · partial subtotal'}{typeof recipe.servings === 'number' && recipe.servings > 0 ? '' : ' · assumed 4-serving basis; recipe yield not authored'}: {basicPerServing?.calories ?? '—'} kcal
              {' · '}{basicPerServing?.protein ?? '—'} g protein
              {' · '}{basicEstimate.coverage.resolved}/{basicEstimate.coverage.total} ingredient lines covered
            </p>

            <p className="text-[11px] font-medium text-[var(--text-secondary,#9CA3AF)]">
              Offline Estimate · {basicEstimate.confidence === 'high' ? 'High confidence' : basicEstimate.confidence === 'medium' ? 'Medium confidence' : basicEstimate.confidence === 'low' ? 'Low confidence' : 'Unknown confidence'}
            </p>

            {!basicEstimate.coverage.complete && (
              <div
                data-testid="basic-nutrition-partial"
                className="flex items-start gap-2 rounded-xl border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-surface,#141414)] p-3 text-xs text-[var(--text-primary,#F3F4F6)]"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="leading-relaxed">
                    Partial estimate — {basicEstimate.coverage.resolved} of {estimateLineCount} ingredient lines contributed.
                    The figures above are known subtotals per serving. Unresolved lines are excluded; full recipe totals are unknown.
                  </p>
                  {estimateUnresolved.length > 0 && (
                    <ul className="list-disc list-inside space-y-0.5 text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                      {estimateUnresolved.slice(0, 5).map((line) => (
                        <li key={line.ingredient} className="break-words">{line.ingredient}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {basicEstimate.assumptions.length > 0 && (
              <details className="text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                <summary className="cursor-pointer text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]">
                  Portion assumptions ({basicEstimate.assumptions.length})
                </summary>
                <ul className="mt-1 list-disc list-inside space-y-0.5">
                  {basicEstimate.assumptions.map((note) => (
                    <li key={note} className="break-words">{note}</li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-3">
              <button
                type="button"
                onClick={handleDiscardEstimate}
                className="min-h-[44px] rounded-lg px-3 text-xs font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-surface,#141414)] hover:text-[var(--text-primary,#F3F4F6)]"
              >
                Discard
              </button>
              <button
                type="button"
                id="save-nutrition-btn"
                data-testid="save-nutrition-btn"
                onClick={handleApplyEstimate}
                disabled={!basicEstimateToNutrition(basicEstimate, { allowPartial: true })}
                className="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-transparent bg-amber-500 px-4 text-xs font-semibold text-black shadow-sm transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{basicEstimate.coverage.complete ? 'Save to Recipe Markdown' : 'Save labeled partial subtotal'}</span>
              </button>
            </div>
          </div>
        )}

        {showCalculateAction && hasNutritionDisplay && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              id="calculate-basic-nutrition-btn"
              data-testid="calculate-basic-nutrition-btn"
              onClick={handleEstimate}
              disabled={isLoading}
              title="Estimate per-serving nutrition from the curated local food reference — offline, no AI required"
              className="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 text-xs font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:border-[var(--accent-text,#F59E0B)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
              )}
              <span>{isLoading ? 'Calculating…' : 'Calculate Basic Nutrition'}</span>
            </button>
          </div>
        )}

        {isExpanded && (
          <div className="space-y-4">
            {savedPartial && (
              <p data-testid="saved-basic-partial" className="rounded-xl border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-xs leading-relaxed text-[var(--text-primary,#F3F4F6)]">
                Saved partial subtotal — recipe totals are unknown. Recalculate and review before saving.
              </p>
            )}
            {advancedIncomplete && (
              <div
                data-testid="nutrition-advanced-incomplete"
                className="space-y-1.5 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2 py-0.5 font-mono text-[11px] uppercase tracking-normal text-[var(--text-primary,#F3F4F6)]">
                    {advancedIncomplete.stale ? 'Needs recalculation' : 'Partial estimate'}
                  </span>
                  <p className="text-xs font-semibold text-[var(--text-primary,#F3F4F6)]">Advanced nutrition incomplete</p>
                </div>
                <p className="text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                  {advancedIncomplete.resolved + (advancedIncomplete.excluded ?? 0)} of {advancedIncomplete.total} ingredient line
                  {advancedIncomplete.total === 1 ? '' : 's'} accounted for
                  {advancedIncomplete.excluded ? ` · ${advancedIncomplete.excluded} wrapper excluded` : ''}.
                </p>
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                  {advancedIncomplete.stale ? <>Saved evidence does not match the current recipe. Totals are unknown. Recalculate Advanced Nutrition.</> : advancedIncomplete.unresolved === 0 ? <>
                    Nutrient coverage is partial; known amounts are subtotals and missing nutrients remain unknown.
                  </> : <>
                    Partial estimate — {advancedIncomplete.unresolved ?? Math.max(0, advancedIncomplete.total - advancedIncomplete.resolved - (advancedIncomplete.excluded ?? 0))} unresolved ingredient line{(advancedIncomplete.unresolved ?? Math.max(0, advancedIncomplete.total - advancedIncomplete.resolved - (advancedIncomplete.excluded ?? 0))) === 1 ? '' : 's'}.
                    Known amounts are subtotals; full recipe totals are unknown. Open Advanced Nutrition to finish review.
                  </>}
                </p>
              </div>
            )}

            {hasNutritionDisplay ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {provenanceText && (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--accent-text,#F59E0B)]" />
                        {provenanceText}
                      </span>
                    )}
                    <span className="rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-2.5 py-1 font-mono text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                      {currentServings} serving{currentServings === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>

                {!derivedNutrition && currentNutrition?.confidenceNote && (
                  <p data-testid="saved-basic-evidence" className="text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                    {currentNutrition.confidenceNote}
                  </p>
                )}

                <div className="space-y-3">
                  <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-4">
                    <div className="min-w-0">
                      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary,#9CA3AF)]">{caloriesLabel}</p>
                      <div className="mt-1.5 flex items-baseline gap-1.5">
                        <span className="font-serif text-[44px] leading-none text-[var(--text-primary,#F3F4F6)]">{caloriesValue}</span>
                        <span className="text-[13px] font-medium text-[var(--text-secondary,#9CA3AF)]">kcal</span>
                      </div>
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                      Total for {currentServings} serving{currentServings === 1 ? '' : 's'}
                    </p>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
                    <div className="min-w-0 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-3 py-2.5">
                      <dt className="font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{proteinLabel}</dt>
                      <dd className="mt-0.5 flex items-baseline gap-1">
                        <span className="font-mono text-[17px] font-semibold leading-tight text-[var(--text-primary,#F3F4F6)]">
                          {displayedNutrition?.protein !== undefined ? `${displayedNutrition.protein}g` : '—'}
                        </span>
                      </dd>
                      <dd className="mt-0.5 text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                        {displayedNutrition?.protein === undefined ? 'not recorded' : hasMacroComparison && proteinPct > 0 ? `${proteinPct}% of macro grams` : 'macro'}
                      </dd>
                    </div>

                    <div className="min-w-0 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-3 py-2.5">
                      <dt className="font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{carbsLabel}</dt>
                      <dd className="mt-0.5 flex items-baseline gap-1">
                        <span className="font-mono text-[17px] font-semibold leading-tight text-[var(--text-primary,#F3F4F6)]">
                          {displayedNutrition?.carbohydrates !== undefined ? `${displayedNutrition.carbohydrates}g` : '—'}
                        </span>
                      </dd>
                      <dd className="mt-0.5 text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                        {displayedNutrition?.carbohydrates === undefined ? 'not recorded' : hasMacroComparison && carbsPct > 0 ? `${carbsPct}% of macro grams` : 'macro'}
                      </dd>
                    </div>

                    <div className="min-w-0 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-3 py-2.5">
                      <dt className="font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{fatLabel}</dt>
                      <dd className="mt-0.5 flex items-baseline gap-1">
                        <span className="font-mono text-[17px] font-semibold leading-tight text-[var(--text-primary,#F3F4F6)]">
                          {displayedNutrition?.fat !== undefined ? `${displayedNutrition.fat}g` : '—'}
                        </span>
                      </dd>
                      <dd className="mt-0.5 text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                        {displayedNutrition?.fat === undefined ? 'not recorded' : hasMacroComparison && fatPct > 0 ? `${fatPct}% of macro grams` : 'macro'}
                      </dd>
                    </div>

                    <div className="min-w-0 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-3 py-2.5">
                      <dt className="font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{fiberLabel}</dt>
                      <dd className="mt-0.5 flex items-baseline gap-1">
                        <span className="font-mono text-[17px] font-semibold leading-tight text-[var(--text-primary,#F3F4F6)]">
                          {displayedNutrition?.fiber !== undefined ? `${displayedNutrition.fiber}g` : '—'}
                        </span>
                      </dd>
                      <dd className="mt-0.5 text-[11px] text-[var(--text-secondary,#9CA3AF)]">{displayedNutrition?.fiber === undefined ? 'not recorded' : 'dietary'}</dd>
                    </div>

                    <div className="min-w-0 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-3 py-2.5">
                      <dt className="font-mono text-[11px] uppercase tracking-normal text-[var(--text-secondary,#9CA3AF)]">{sodiumLabel}</dt>
                      <dd className="mt-0.5 flex items-baseline gap-1">
                        <span className="font-mono text-[17px] font-semibold leading-tight text-[var(--text-primary,#F3F4F6)]">
                          {displayedNutrition?.sodium !== undefined ? `${displayedNutrition.sodium}mg` : '—'}
                        </span>
                      </dd>
                      <dd className="mt-0.5 text-[11px] text-[var(--text-secondary,#9CA3AF)]">{displayedNutrition?.sodium === undefined ? 'not recorded' : 'mineral'}</dd>
                    </div>
                  </dl>
                </div>

                {hasMacroComparison && totalMacroGrams > 0 && !savedPartial && !partialNutrientSet.has('protein') && !partialNutrientSet.has('carbohydrates') && !partialNutrientSet.has('fat') && (
                  <div className="space-y-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="text-[11px] font-semibold text-[var(--text-primary,#F3F4F6)]">Macro distribution</p>
                      <p className="text-[11px] text-[var(--text-secondary,#9CA3AF)]">Macro percentages compare grams, not calories.</p>
                    </div>
                    <div
                      className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-surface,#141414)]"
                      role="img"
                      aria-label={`Macro distribution by grams: protein ${proteinPct} percent, carbohydrates ${carbsPct} percent, fat ${fatPct} percent`}
                    >
                      <div style={{ width: `${proteinPct}%` }} className="h-full bg-[var(--accent,#F59E0B)] transition-all duration-500 motion-reduce:transition-none" title={`Protein: ${protein}g (${proteinPct}%)`} />
                      <div style={{ width: `${carbsPct}%` }} className="h-full bg-[var(--accent,#F59E0B)] opacity-60 transition-all duration-500 motion-reduce:transition-none" title={`Carbohydrates: ${carbs}g (${carbsPct}%)`} />
                      <div style={{ width: `${fatPct}%` }} className="h-full bg-[var(--accent,#F59E0B)] opacity-30 transition-all duration-500 motion-reduce:transition-none" title={`Fat: ${fat}g (${fatPct}%)`} />
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--text-secondary,#9CA3AF)]">
                      <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--accent,#F59E0B)]" />Protein {proteinPct}%</span>
                      <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--accent,#F59E0B)] opacity-60" />Carbs {carbsPct}%</span>
                      <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--accent,#F59E0B)] opacity-30" />Fat {fatPct}%</span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2 rounded-xl border border-dashed border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-5 text-center">
                <p className="text-xs text-[var(--text-secondary,#9CA3AF)]">
                  No nutrition is recorded for this recipe yet.
                </p>
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                  Calculate a basic estimate from the pinned local USDA catalog — no AI
                  required. Nothing is saved until you choose to save it.
                </p>
                <button
                  type="button"
                  id="calculate-basic-nutrition-empty-btn"
                  data-testid="calculate-basic-nutrition-empty-btn"
                  onClick={handleEstimate}
                  disabled={isLoading}
                  className="mx-auto flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-4 text-xs font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:border-[var(--accent-text,#F59E0B)] disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />
                  <span>{isLoading ? 'Calculating…' : 'Calculate Basic Nutrition'}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
};
