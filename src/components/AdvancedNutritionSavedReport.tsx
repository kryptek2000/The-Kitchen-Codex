import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import type { CodexNutritionV1, CodexNutritionV2, CodexNutritionV3, CodexNutritionV4, CodexNutritionV5 } from '../core/nutritionV2/schema';

const DIALOG_FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface AdvancedNutritionSavedReportProps {
  isOpen: boolean;
  stale?: boolean;
  unsaved?: boolean;
  servingBasisAssumed?: boolean;
  onClose: () => void;
  /** Materialized, bounded recipe title (never a raw untrusted recipe). */
  title: string;
  /** The already-validated canonical saved block. */
  block: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3 | CodexNutritionV4 | CodexNutritionV5;
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
  stale = false,
  unsaved = false,
  servingBasisAssumed = false,
  onClose,
  title,
  block,
  onEdit,
}) => {
  const [basis, setBasis] = useState<BasisMode>('entire_recipe');
  const [selectedServings, setSelectedServings] = useState<number>(block.servings);
  // CLAMP the user-entered selected-serving count into the documented safe range
  // (positive integer 1..1000) BEFORE any derivation; an invalid/negative/NaN
  // input falls back to the stored denominator rather than producing a
  // non-finite display value.
  const effectiveSelectedServings =
    typeof selectedServings === 'number' &&
    Number.isFinite(selectedServings) &&
    selectedServings > 0
      ? Math.min(Math.round(selectedServings), 1000)
      : block.servings;
  const meta = useMemo(() => savedReportMeta(block), [block]);
  const nutrients = useMemo(
    () => deriveSavedReportNutrients(block, basis, effectiveSelectedServings),
    [block, basis, effectiveSelectedServings]
  );
  const groups = useMemo(() => savedReportGroups(), []);
  const missingNutrients = useMemo(
    () =>
      groups.flatMap((group) =>
        group.nutrients
          .map((id) => nutrients.find((entry) => entry.nutrient === id))
          .filter(
            (entry): entry is NonNullable<typeof entry> =>
              entry !== undefined && entry.coverage === 'missing'
          )
      ),
    [groups, nutrients]
  );

  // Accessible dialog behaviour: this read-only report is presented in a modal,
  // so it receives the same initial focus, Escape handling, Tab containment and
  // focus restoration as the analyzer. No nutrition behaviour is involved.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return undefined;
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const node = dialogRef.current;
    if (node) {
      node.focus({ preventScroll: true });
    }
    return () => {
      const restore = restoreFocusRef.current;
      if (restore && typeof restore.focus === 'function') restore.focus({ preventScroll: true });
    };
  }, [isOpen]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = Array.from(node.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-2 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${unsaved ? 'Working' : 'Saved'} Advanced Nutrition for ${title}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        onKeyDown={onKeyDown}
        tabIndex={-1}
        className="my-2 w-full max-w-4xl overflow-y-auto rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-primary,#F3F4F6)] shadow-2xl focus:outline-none sm:my-4 max-h-[94vh]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)]">
              <FlaskConical className="h-4.5 w-4.5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary,#9CA3AF)]">
                {unsaved ? 'Working advanced report' : 'Saved advanced report'}
              </p>
              <h2 className="font-serif text-[22px] leading-snug text-[var(--text-primary,#F3F4F6)]">
                Advanced Nutrition {unsaved ? 'applied — not saved' : 'saved'}
              </h2>
              <p className="truncate text-[13px] text-[var(--text-secondary,#9CA3AF)]">{title}</p>
              <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wide text-[var(--text-secondary,#9CA3AF)]">
                {block.schema === 5 ? 'Source-backed + AI-estimated · read-only' : 'USDA reviewed · read-only'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={unsaved ? 'Close working Advanced Nutrition report' : 'Close saved Advanced Nutrition report'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-elevated,#1E1E1E)] hover:text-[var(--text-primary,#F3F4F6)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-5 px-4 py-5 sm:px-5">
          {block.schema === 4 && (
            <div className="space-y-1 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] border-l-[var(--accent-text,#F59E0B)] bg-[var(--bg-elevated,#1E1E1E)] p-3 text-[13px] text-[var(--text-primary,#F3F4F6)]">
              <p>Includes accepted estimated quantities (not authenticated portions).</p>
              {block.ingredients.filter(e => e.quantity_estimate).map(e => <p key={e.line_ref} className="text-[12px] text-[var(--text-secondary,#9CA3AF)]">AI estimate · {e.line_ref}: {e.quantity_estimate!.lower_grams}–{e.quantity_estimate!.upper_grams} g · midpoint {e.quantity_estimate!.representative_grams} g</p>)}
            </div>
          )}

          {/* Status + base servings */}
          <div
            data-testid="saved-advanced-status"
            className={`rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] border-l-[3px] bg-[var(--bg-elevated,#1E1E1E)] p-4 text-[13px] ${
              stale ? 'border-l-[var(--accent-text,#F59E0B)]' : meta.complete ? 'border-l-[var(--accent,#F59E0B)]' : 'border-l-[var(--accent-text,#F59E0B)]'
            }`}
          >
            <p className="text-[15px] font-semibold text-[var(--text-primary,#F3F4F6)]">
              {stale ? 'Historical saved values — recalculate before using these totals' : meta.unresolved_count === 0 ? 'All ingredient lines accounted for' : 'Partial ingredient coverage'}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
              {meta.resolved_count + meta.excluded_count} of {meta.ingredient_count} ingredient line
              {meta.ingredient_count === 1 ? '' : 's'} accounted for
              {meta.excluded_count > 0 ? ` · ${meta.excluded_count} cooking wrapper excluded` : ''}
              {meta.unresolved_count > 0 ? ` · ${meta.unresolved_count} unresolved` : ''}
              {' · '}base {meta.servings} serving{meta.servings === 1 ? '' : 's'}
              {servingBasisAssumed ? ' · assumed because the recipe yield is unspecified' : ''}
            </p>
          </div>

          {block.schema === 5 && (
            <details className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)]" data-testid="saved-advanced-line-evidence">
              <summary className="min-h-[44px] cursor-pointer px-4 py-3 text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring,#F59E0B)]">
                Ingredient evidence · {meta.resolved_count} nutrition contributions · {meta.excluded_count} excluded · {meta.unresolved_count} unresolved
              </summary>
              <ul className="space-y-1.5 px-4 pb-3 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                {block.ingredients.map((entry) => (
                  <li key={`source-${entry.line_ref}`} data-testid="saved-line-source-backed">
                    <span className="text-[var(--text-primary,#F3F4F6)]">Source-backed</span> · {entry.line_ref} · USDA {entry.source_food_id}
                  </li>
                ))}
                {block.ai_contributions.map((entry) => (
                  <li key={`ai-${entry.line_ref}`} data-testid={`saved-line-${entry.disposition === 'excluded' ? 'excluded' : entry.classification}`}>
                    <span className="text-[var(--text-primary,#F3F4F6)]">
                      {entry.disposition === 'excluded' ? 'Excluded cooking wrapper' : entry.classification === 'ai_estimate' ? 'AI estimate' : 'Source-backed contribution'}
                    </span>
                    {' · '}{entry.ingredient}
                    {entry.disposition === 'excluded' ? ` · ${entry.exclusion_assumption}` : ` · ${entry.quantity_basis}`}
                  </li>
                ))}
                {block.unresolved.map((entry) => (
                  <li key={`unresolved-${entry.line_ref}`} data-testid="saved-line-unresolved">
                    <span className="text-[var(--text-primary,#F3F4F6)]">Unresolved</span> · {entry.line_ref} · {entry.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Display basis controls */}
          <section aria-label="Report display basis" className="space-y-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-[var(--text-primary,#F3F4F6)]">Display basis</span>
              <span className="text-[12px] text-[var(--text-secondary,#9CA3AF)]" data-testid="saved-advanced-basis-label">
                {basisLabel(basis, effectiveSelectedServings)}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="saved-advanced-basis">
              {(['entire_recipe', 'per_serving', 'selected_servings'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`saved-advanced-basis-${mode}`}
                  onClick={() => setBasis(mode)}
                  aria-pressed={basis === mode}
                  className={`min-h-[44px] rounded-lg border px-3 text-[13px] font-medium transition-colors ${
                    basis === mode
                      ? 'border-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--text-primary,#F3F4F6)]'
                      : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)]'
                  }`}
                >
                  {mode === 'entire_recipe'
                    ? 'Entire recipe'
                    : mode === 'per_serving'
                      ? 'Per serving'
                      : 'Selected servings'}
                </button>
              ))}
            </div>
            {basis === 'selected_servings' && (
              <label className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--text-secondary,#9CA3AF)]">
                <span>Servings</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={selectedServings}
                  onChange={(event) => setSelectedServings(Number(event.target.value))}
                  className="min-h-[44px] w-24 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-3 text-[var(--text-primary,#F3F4F6)]"
                />
              </label>
            )}
          </section>

          {/* Nutrient groups */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {groups.map((group) => {
              const rows = group.nutrients
                .map((id) => nutrients.find((entry) => entry.nutrient === id))
                .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
              const visible = rows.filter((entry) => entry.coverage !== 'missing');
              if (visible.length === 0) return null;
              return (
                <section key={group.id} className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-4 py-3">
                  <h3 className="mb-1.5 font-serif text-[15px] text-[var(--text-primary,#F3F4F6)]">
                    {group.label}
                  </h3>
                  <dl>
                    {visible.map((entry) => (
                      <div
                        key={entry.nutrient}
                        className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] py-1.5 text-[13px] last:border-b-0"
                      >
                        <dt className="min-w-0 text-[var(--text-secondary,#9CA3AF)]">{entry.label}</dt>
                        <dd className="flex shrink-0 flex-wrap items-baseline justify-end gap-2 text-right">
                          <span className="font-mono text-[var(--text-primary,#F3F4F6)]">
                            {formatAmount(entry.amount)} {entry.amount !== undefined ? entry.unit_label : ''}
                          </span>
                          <span className="w-[58px] text-right font-mono text-[12px] text-[var(--text-secondary,#9CA3AF)]">
                            {formatDailyValue(entry.percent_daily_value)} DV
                          </span>
                          {entry.coverage === 'partial' && (
                            <span
                              data-testid={`saved-advanced-partial-${entry.nutrient}`}
                              title="Known subtotal from partial ingredient coverage — the full recipe total is unknown."
                              className="rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-primary,#F3F4F6)]"
                            >
                              subtotal
                            </span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>

          {missingNutrients.length > 0 && (
            <section className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-4 py-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary,#9CA3AF)]">
                Not reported in this saved result
              </h3>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-primary,#F3F4F6)]">
                {missingNutrients.map((entry) => entry.label).join(' · ')}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                Missing nutrients remain missing. They are never treated as zero.
              </p>
            </section>
          )}

          {(nutrients.some((entry) => entry.coverage === 'partial')) && (
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
              Values marked <span className="rounded-full border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-primary,#F3F4F6)]">subtotal</span> are known subtotals from partial ingredient coverage — the full recipe total is unknown.
            </p>
          )}

          {/* Provenance */}
          <div className="space-y-1 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4 text-[13px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
            <p>
              Source: <span className="text-[var(--text-primary,#F3F4F6)]">{block.schema === 5 ? 'USDA FoodData Central + saved AI contributions' : 'USDA FoodData Central'}</span>
              {meta.usda_release ? (
                <>
                  {' '}
                  · bundle <span className="font-mono text-[var(--text-primary,#F3F4F6)]">{meta.usda_release}</span>
                </>
              ) : null}
            </p>
            <p>
              Entire-recipe totals stored · per-serving and selected-serving values are derived
              deterministically from the stored {meta.servings}-serving denominator.
            </p>
            {meta.computed_at && <p>Reviewed {meta.computed_at}</p>}
            {meta.unresolved_count > 0 && (
              <p className="text-[var(--text-primary,#F3F4F6)]">
                {meta.unresolved_count} unresolved ingredient line
                {meta.unresolved_count === 1 ? '' : 's'}.
              </p>
            )}
          </div>

          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{PHASE4_NOT_MEDICAL_ADVICE}</span>
          </p>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] pt-4">
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary,#9CA3AF)]">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Saved result · no automatic writes</span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 text-[13px] font-medium text-[var(--text-secondary,#9CA3AF)] transition-colors hover:bg-[var(--bg-root,#0C0C0C)] hover:text-[var(--text-primary,#F3F4F6)]"
              >
                Close
              </button>
              <button
                type="button"
                data-testid="saved-advanced-edit"
                onClick={onEdit}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-amber-500 px-4 text-[13px] font-semibold text-black transition-colors hover:bg-amber-400"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Edit / Re-analyze Nutrition</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
