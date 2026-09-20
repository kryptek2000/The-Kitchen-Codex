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
import { deriveAdvancedCompactNutrition, type NutritionPresentation } from '../core/nutritionV2/phase5c';

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
 * The consolidated Nutrition surface.
 *
 * TWO SEPARATE EXPERIENCES (product contract):
 *   - the ordinary compact `Nutrition & Macros` card is ALWAYS visible; when a
 *     recognized saved Advanced result exists its compact values are DERIVED
 *     from that saved block (single authority, no second stored dataset);
 *   - Advanced Nutrition is a SEPARATE secondary card for the reviewed USDA
 *     match/portion/Apply workflow.
 *
 * A saved Advanced result never hides or replaces the normal card. Stale,
 * unsupported, and malformed saved blocks are still surfaced explicitly, and the
 * Advanced workflow never writes on view.
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
  const advancedPreferred = presentation.advanced_preferred;
  // Compact normal values derived from the saved Advanced block (single
  // authority). Undefined when no recognized Advanced result exists, in which
  // case the normal card shows the recipe's own stored nutrition.
  const derivedNutrition = deriveAdvancedCompactNutrition(presentation);
  // A recognized but INCOMPLETE Advanced result must not be shown as
  // whole-recipe compact totals; the normal card shows an incomplete state.
  const advancedIncomplete =
    advancedPreferred && !presentation.advanced_complete
      ? {
          resolved: presentation.advanced_resolved_count,
          total: presentation.advanced_ingredient_count,
        }
      : undefined;
  const legacyVisible = onUpdateNutrition !== undefined;
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

      {/* The ordinary compact Nutrition & Macros presentation ALWAYS remains
          visible. When a recognized Advanced result exists its values are
          derived from that saved block. */}
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
            derivedNutrition={derivedNutrition}
            derivedSourceLabel={derivedNutrition ? 'Advanced Nutrition · USDA reviewed' : undefined}
            advancedIncomplete={advancedIncomplete}
            onUpdateNutrition={(nut) => onUpdateNutrition?.(nut)}
          />
        </div>
      )}

      {/* Advanced Nutrition stays a SEPARATE secondary card. */}
      <AdvancedNutritionCard
        recipe={recipe}
        session={advancedNutritionSession}
        servings={servings}
        bundleStatus={advancedNutritionBundleStatus}
        onLoadBundle={onLoadAdvancedNutritionBundle}
        onApplyAdvancedNutrition={onApplyAdvancedNutrition}
        savedAdvancedBlock={presentation.advanced}
      />
    </section>
  );
};

export default RecipeNutritionSection;
