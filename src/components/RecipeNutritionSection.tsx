import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { ObsidianRecipe, RecipeNutrition } from '../types';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { RecipeNutritionCard } from './RecipeNutritionCard';
import {
  AdvancedNutritionCard,
  type AdvancedNutritionApplyHandler,
  type AdvancedNutritionBundleUiStatus,
} from './AdvancedNutritionCard';
import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4';
import type { NutritionPresentation } from '../core/nutritionV2/phase5c';

interface RecipeNutritionSectionProps {
  recipe: ObsidianRecipe;
  /** Precomputed pure precedence (shared with the recipe header calories). */
  presentation: NutritionPresentation;
  servings?: number;
  network: NetworkAdapter;
  onUpdateNutrition?: (nutrition: RecipeNutrition) => Promise<boolean | void> | void;
  advancedNutritionSession?: AdvancedNutritionSession | null;
  advancedNutritionBundleStatus?: AdvancedNutritionBundleUiStatus;
  onLoadAdvancedNutritionBundle?: () => void;
  onApplyAdvancedNutrition?: AdvancedNutritionApplyHandler;
}

/**
 * The SINGLE consolidated Nutrition surface. Precedence is decided by the pure
 * `resolveRecipeNutritionPresentation` selector:
 *   - a recognized saved Advanced result is the primary surface;
 *   - a stale saved Advanced result stays primary with an explicit stale notice
 *     (the legacy estimator never silently masks it);
 *   - an unknown/malformed saved block is reported and preserved, with the legacy
 *     estimate shown only as a clearly-labelled fallback;
 *   - otherwise the existing simple Nutrition & Macros / estimator is the
 *     fallback for legacy-only or empty recipes.
 */
export const RecipeNutritionSection: React.FC<RecipeNutritionSectionProps> = ({
  recipe,
  presentation,
  servings,
  network,
  onUpdateNutrition,
  advancedNutritionSession,
  advancedNutritionBundleStatus,
  onLoadAdvancedNutritionBundle,
  onApplyAdvancedNutrition,
}) => {
  const advancedPrimary = presentation.advanced_preferred;
  // The Advanced review/apply surface stays reachable for every recipe (so a
  // legacy/empty recipe can still be upgraded); it is a secondary affordance
  // unless a recognized saved block makes it the primary authority.
  const legacyVisible = !advancedPrimary && onUpdateNutrition !== undefined;
  const legacyFallbackNote =
    presentation.kind === 'advanced_unsupported' || presentation.kind === 'advanced_invalid';

  return (
    <section id="recipe-nutrition-section" aria-label="Nutrition" className="space-y-3">
      {presentation.kind === 'advanced_stale' && (
        <div
          role="status"
          className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-[11px] text-amber-200 flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Saved Advanced Nutrition may be out of date for the current recipe
            {presentation.stale_reasons.includes('servings_changed') ? ' (servings changed)' : ''}
            {presentation.stale_reasons.includes('ingredients_changed') ? ' (ingredients changed)' : ''}.
            Recalculate and Apply to update it.
          </span>
        </div>
      )}

      {presentation.kind === 'advanced_unsupported' && (
        <div
          role="status"
          className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-[11px] text-amber-200 flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Saved Advanced Nutrition uses a newer format this version cannot read. It is preserved and
            will not be replaced.
          </span>
        </div>
      )}

      {presentation.kind === 'advanced_invalid' && (
        <div
          role="status"
          className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-[11px] text-amber-200 flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Saved Advanced Nutrition data cannot be read safely. It is preserved and will not be
            replaced.
          </span>
        </div>
      )}

      {legacyVisible && (
        <div className="space-y-2">
          {legacyFallbackNote && (
            <p className="text-[10px] text-gray-500 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5" />
              <span>Legacy estimate — shown only because saved Advanced Nutrition is unavailable.</span>
            </p>
          )}
          <RecipeNutritionCard
            recipe={recipe}
            servings={servings}
            network={network}
            onUpdateNutrition={(nut) => onUpdateNutrition?.(nut)}
          />
        </div>
      )}

      {!advancedPrimary && (
        <p className="text-[10px] text-gray-500 flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5" />
          <span>Authenticated USDA nutrition — review and Apply to save a verified result.</span>
        </p>
      )}
      <AdvancedNutritionCard
        recipe={recipe}
        session={advancedNutritionSession}
        servings={servings}
        bundleStatus={advancedNutritionBundleStatus}
        onLoadBundle={onLoadAdvancedNutritionBundle}
        onApplyAdvancedNutrition={onApplyAdvancedNutrition}
      />
    </section>
  );
};

export default RecipeNutritionSection;
