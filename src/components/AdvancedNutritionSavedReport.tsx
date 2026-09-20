import React, { useMemo, useState } from 'react';
import { X, ShieldCheck, FlaskConical, Pencil, Info } from 'lucide-react';
import {
  PHASE4_NOT_MEDICAL_ADVICE,
  basisLabel,
  formatAmount,
  formatDailyValue,
  type BasisMode,
} from '../core/nutritionV2/phase4';
import {
  deriveSavedReportNutrients,
  savedReportGroups,
  savedReportMeta,
} from '../core/nutritionV2/phase5c/savedReport';
import type { CodexNutritionV1 } from '../core/nutritionV2/schema';

interface AdvancedNutritionSavedReportProps {
  isOpen: boolean;
  onClose: () => void;
  /** Materialized, bounded recipe title (never a raw untrusted recipe). */
  title: string;
  /** The already-validated canonical saved block. */
  block: CodexNutritionV1;
  /** Opens the working analyzer/editor. */
  onEdit: () => void;
}

/**
 * The SAVED ADVANCED REPORT.
 *
 * A read-only view of the persisted reviewed USDA result. It renders entirely
 * from the validated canonical saved block: no USDA catalog authentication, no
 * bundle reconstruction, no matcher session, no automatic analysis, and no
 * portion re-verification are required to display it.
 */
export const AdvancedNutritionSavedReport: React.FC<AdvancedNutritionSavedReportProps> = ({
  isOpen,
  onClose,
  title,
  block,
  onEdit,
}) => {
  const [basis, setBasis] = useState<BasisMode>('entire_recipe');
  const [selectedServings, setSelectedServings] = useState<number>(block.servings);
  const meta = useMemo(() => savedReportMeta(block), [block]);
  const nutrients = useMemo(
    () => deriveSavedReportNutrients(block, basis, selectedServings),
    [block, basis, selectedServings]
  );
  const groups = useMemo(() => savedReportGroups(), []);

  if (!isOpen) return null;

  const selectedServingsValid =
    Number.isFinite(selectedServings) && selectedServings > 0 && selectedServings <= 1000;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={`Saved Advanced Nutrition for ${title}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl bg-[#0F0F0F] border border-indigo-500/20 rounded-2xl shadow-2xl my-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 border-b border-white/5">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 flex items-center justify-center shrink-0">
              <FlaskConical className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-serif font-bold text-white truncate">
                Advanced Nutrition saved
              </h2>
              <p className="text-[11px] text-gray-400 truncate">{title}</p>
              <p className="text-[10px] font-mono uppercase tracking-wide text-indigo-300 mt-0.5">
                USDA reviewed · read-only
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close saved Advanced Nutrition report"
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Status + base servings */}
          <div
            data-testid="saved-advanced-status"
            className={`p-3 rounded-xl border text-[11px] ${
              meta.complete
                ? 'bg-emerald-950/25 border-emerald-800/40 text-emerald-200'
                : 'bg-amber-950/25 border-amber-800/40 text-amber-200'
            }`}
          >
            <p className="font-semibold">
              {meta.complete ? 'Complete ingredient coverage' : 'Partial ingredient coverage'}
            </p>
            <p className="text-[11px] opacity-90">
              {meta.resolved_count} of {meta.ingredient_count} ingredient line
              {meta.ingredient_count === 1 ? '' : 's'} resolved
              {' · '}base {meta.servings} serving{meta.servings === 1 ? '' : 's'}
            </p>
          </div>

          {/* Display basis controls */}
          <div className="flex flex-wrap items-center gap-2" data-testid="saved-advanced-basis">
            <span className="text-[11px] text-gray-400">Display basis:</span>
            {(['entire_recipe', 'per_serving', 'selected_servings'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`saved-advanced-basis-${mode}`}
                onClick={() => setBasis(mode)}
                aria-pressed={basis === mode}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                  basis === mode
                    ? 'bg-indigo-500/25 border-indigo-400/40 text-indigo-100'
                    : 'bg-white/5 hover:bg-white/10 border-white/10 text-gray-300'
                }`}
              >
                {mode === 'entire_recipe'
                  ? 'Entire recipe'
                  : mode === 'per_serving'
                    ? 'Per serving'
                    : 'Selected servings'}
              </button>
            ))}
            {basis === 'selected_servings' && (
              <label className="flex items-center gap-1.5 text-[11px] text-gray-300">
                <span>Servings</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={selectedServings}
                  onChange={(event) => setSelectedServings(Number(event.target.value))}
                  className="w-20 px-2 py-1 rounded-lg bg-[#141414] border border-white/10 text-gray-100 text-xs"
                />
              </label>
            )}
            <span className="text-[11px] text-gray-500" data-testid="saved-advanced-basis-label">
              {basisLabel(basis, selectedServingsValid ? selectedServings : block.servings)}
            </span>
          </div>

          {/* Nutrient groups */}
          {groups.map((group) => {
            const rows = group.nutrients
              .map((id) => nutrients.find((entry) => entry.nutrient === id))
              .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
            const visible = rows.filter((entry) => entry.coverage !== 'missing');
            if (visible.length === 0) return null;
            return (
              <div key={group.id} className="space-y-1">
                <h3 className="text-[11px] font-semibold text-gray-300 uppercase tracking-wide">
                  {group.label}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  {rows.map((entry) => (
                    <div
                      key={entry.nutrient}
                      className="flex items-center justify-between gap-2 text-[11px] border-b border-white/5 py-0.5"
                    >
                      <span className="text-gray-300 truncate">{entry.label}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-white">
                          {formatAmount(entry.amount)} {entry.amount !== undefined ? entry.unit_label : ''}
                        </span>
                        <span className="text-gray-500 w-12 text-right">
                          {entry.coverage === 'missing' ? '' : formatDailyValue(entry.percent_daily_value)}
                        </span>
                        {entry.coverage === 'partial' && (
                          <span
                            data-testid={`saved-advanced-partial-${entry.nutrient}`}
                            className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-300"
                          >
                            partial
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Provenance */}
          <div className="p-3 rounded-xl bg-[#141414] border border-white/5 text-[11px] text-gray-400 space-y-0.5">
            <p>
              Source: <span className="text-gray-200">USDA FoodData Central</span>
              {meta.usda_release ? (
                <>
                  {' '}
                  · bundle <span className="font-mono text-gray-300">{meta.usda_release}</span>
                </>
              ) : null}
            </p>
            <p>
              Entire-recipe totals stored · per-serving and selected-serving values are derived
              deterministically from the stored {meta.servings}-serving denominator.
            </p>
            {meta.computed_at && <p>Reviewed {meta.computed_at}</p>}
            {meta.unresolved_count > 0 && (
              <p className="text-amber-300">
                {meta.unresolved_count} unresolved ingredient line
                {meta.unresolved_count === 1 ? '' : 's'}.
              </p>
            )}
          </div>

          <p className="text-[10px] text-gray-500 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{PHASE4_NOT_MEDICAL_ADVICE}</span>
          </p>

          <div className="flex items-center justify-between pt-1 border-t border-white/5">
            <span className="text-[10px] text-gray-500 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              <span>Saved result · no automatic writes</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                data-testid="saved-advanced-edit"
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-100 bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/40 transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>Edit / Re-analyze Nutrition</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdvancedNutritionSavedReport;
