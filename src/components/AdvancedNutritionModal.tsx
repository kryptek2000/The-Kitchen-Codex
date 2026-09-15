import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ShieldAlert, FlaskConical, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import {
  NUTRIENT_GROUPS,
  PHASE4_NOT_MEDICAL_ADVICE,
  basisLabel,
  buildPortionChoice,
  coverageSummary,
  deriveDisplayNutrients,
  formatAmount,
  formatDailyValue,
  ingredientEvidenceViews,
  ingredientNeedsPortion,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type BasisMode,
  type Phase4Action,
  type Phase4Row,
  type Phase4State,
} from '../core/nutritionV2/phase4';

interface AdvancedNutritionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Materialized, bounded recipe title (never a raw untrusted recipe). */
  title: string;
  session: AdvancedNutritionSession;
  adapted: ReadonlyArray<AdaptedIngredient>;
  state: Phase4State;
  dispatch: React.Dispatch<Phase4Action>;
  onCalculate: () => void;
  calculating: boolean;
}

const OUTCOME_LABEL: Record<string, string> = {
  matched_exact: 'Automatic unique-exact source match',
  review_required: 'Review required',
  unmatched: 'No source match',
  qualitative: 'Qualitative (not measurable)',
  invalid: 'Invalid ingredient line',
  none_selected: 'None of these selected',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function useDialogFocus(isOpen: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    restoreRef.current = (typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null) ?? null;
    const node = dialogRef.current;
    if (node) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    return () => {
      const restore = restoreRef.current;
      if (restore && typeof restore.focus === 'function') restore.focus();
    };
  }, [isOpen]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = dialogRef.current;
      if (!node) return;
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
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
    },
    [onClose]
  );

  return { dialogRef, onKeyDown };
}

interface PortionControlsProps {
  row: Phase4Row;
  fdcId: number;
  session: AdvancedNutritionSession;
  state: Phase4State;
  dispatch: React.Dispatch<Phase4Action>;
  adapted: ReadonlyArray<AdaptedIngredient>;
}

const PortionControls: React.FC<PortionControlsProps> = ({
  row,
  fdcId,
  session,
  state,
  dispatch,
  adapted,
}) => {
  const [candidates, setCandidates] = useState<ReadonlyArray<{
    index: number;
    measure: string;
    amount?: number;
    gram_weight: number;
    modifier?: string;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = state.portions[row.line_ref];
  const matchChoice = state.matches[row.line_ref];

  const load = () => {
    setError(null);
    const result = session.reviewPortions(fdcId);
    if (!result.ok) {
      setCandidates([]);
      setError('Portion review is unavailable for this food.');
      return;
    }
    setCandidates(result.review.candidates);
  };

  const choose = (portionIndex: number) => {
    setError(null);
    const entry = adapted.find((item) => item.line_ref === row.line_ref);
    if (!entry) return;
    const selection =
      row.outcome === 'review_required' && matchChoice
        ? matchChoice.kind === 'candidate'
          ? { kind: 'candidate', fdc_id: matchChoice.fdc_id, review_digest: matchChoice.review_digest }
          : { kind: 'none', review_digest: matchChoice.review_digest }
        : undefined;
    const result = buildPortionChoice(session, {
      lineRef: row.line_ref,
      ingredient: entry.ingredient,
      review: row.outcome === 'review_required' ? row.review : undefined,
      selection,
      fdcId,
      portionIndex,
    });
    if (!result.ok) {
      setError('That source portion has no usable amount. No mass can be derived.');
      return;
    }
    dispatch({ type: 'select_portion', lineRef: row.line_ref, choice: result.choice });
  };

  return (
    <div className="mt-2 pl-3 border-l border-white/10 space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={load}
          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-gray-200 transition-colors"
        >
          Review source portions
        </button>
        {current && (
          <span className="text-[11px] text-emerald-300 font-medium">
            Portion selected (index {current.portion_index})
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-amber-300">
          {error}
        </p>
      )}
      {candidates && (
        <fieldset className="space-y-1">
          <legend className="text-[11px] text-gray-400">
            Choose a canonical source portion for {row.original_text}
          </legend>
          {candidates.length === 0 && (
            <p className="text-[11px] text-gray-500">No canonical portions are available.</p>
          )}
          {candidates.map((candidate) => (
            <label
              key={candidate.index}
              className="flex items-start gap-2 text-[11px] text-gray-200 cursor-pointer"
            >
              <input
                type="radio"
                name={`portion-${row.line_ref}`}
                checked={current?.portion_index === candidate.index}
                onChange={() => choose(candidate.index)}
                className="mt-0.5"
              />
              <span>
                {candidate.amount !== undefined ? `${candidate.amount} ` : ''}
                {candidate.measure}
                {candidate.modifier ? ` (${candidate.modifier})` : ''} · {candidate.gram_weight} g
                {candidate.amount === undefined && (
                  <span className="text-amber-300"> · no source amount (unusable)</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
};

export const AdvancedNutritionModal: React.FC<AdvancedNutritionModalProps> = ({
  isOpen,
  onClose,
  title,
  session,
  adapted,
  state,
  dispatch,
  onCalculate,
  calculating,
}) => {
  const { dialogRef, onKeyDown } = useDialogFocus(isOpen, onClose);

  const preview = state.preview;
  const display = useMemo(
    () =>
      preview
        ? deriveDisplayNutrients(preview, state.basis, state.baseServings, state.selectedServings)
        : null,
    [preview, state.basis, state.baseServings, state.selectedServings]
  );
  const evidence = useMemo(() => (preview ? ingredientEvidenceViews(preview) : null), [preview]);
  const coverage = useMemo(() => (preview ? coverageSummary(preview) : null), [preview]);

  if (!isOpen) return null;

  const currentFdcId = (row: Phase4Row): number | undefined => {
    if (row.outcome === 'matched_exact') return row.selected_fdc_id;
    const choice = state.matches[row.line_ref];
    return choice && choice.kind === 'candidate' ? choice.fdc_id : undefined;
  };

  const stale = state.status === 'preview_stale';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-nutrition-title"
        aria-describedby="advanced-nutrition-desc"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-3xl bg-[#101010] border border-white/10 rounded-2xl shadow-2xl text-gray-200 max-h-[92vh] overflow-y-auto focus:outline-none"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10 bg-[#101010]/95 backdrop-blur">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-amber-400" />
            <h2 id="advanced-nutrition-title" className="text-base font-serif font-bold text-white">
              Advanced Nutrition
            </h2>
            <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
              Advisory
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Advanced Nutrition"
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <p id="advanced-nutrition-desc" className="text-[11px] text-gray-400">
            {PHASE4_NOT_MEDICAL_ADVICE}
          </p>

          {state.failure && (
            <div role="alert" className="p-3 rounded-xl bg-rose-950/40 border border-rose-800/40 text-rose-200 text-xs flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{state.failure.message}</span>
            </div>
          )}

          <section className="text-[11px] text-gray-400 font-mono">
            <span>Source: USDA FoodData Central · bundle {session.metadata().bundle_release.slice(0, 24)}…</span>
            <span className="mx-2">·</span>
            <span>{session.metadata().record_count} canonical records</span>
          </section>

          <section aria-label="Display basis" className="space-y-2">
            <h3 className="text-xs font-bold text-white">Display basis</h3>
            <div role="radiogroup" aria-label="Display basis" className="flex flex-wrap gap-3 text-xs">
              {(
                [
                  ['entire_recipe', 'Entire recipe'],
                  ['per_serving', 'Per serving'],
                  ['selected_servings', 'Selected servings'],
                ] as ReadonlyArray<[BasisMode, string]>
              ).map(([mode, label]) => (
                <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="advanced-basis"
                    value={mode}
                    checked={state.basis === mode}
                    onChange={() => dispatch({ type: 'set_basis', basis: mode })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {state.basis === 'selected_servings' && (
              <label className="flex items-center gap-2 text-xs">
                <span>Servings</span>
                <input
                  type="number"
                  aria-label="Requested servings"
                  value={state.selectedServings}
                  min={1}
                  max={1000}
                  onChange={(event) =>
                    dispatch({ type: 'set_servings', value: Number(event.target.value) })
                  }
                  className="w-20 px-2 py-1 rounded-lg bg-[#0C0C0C] border border-white/10 text-gray-100"
                />
              </label>
            )}
          </section>

          <section aria-label="Ingredient matching review" className="space-y-3">
            <h3 className="text-xs font-bold text-white">Ingredient matching review</h3>
            <ul className="space-y-3">
              {state.rows.map((row) => {
                const choice = state.matches[row.line_ref];
                const fdcId = currentFdcId(row);
                const entry = adapted.find((item) => item.line_ref === row.line_ref);
                const needsPortion = entry ? ingredientNeedsPortion(entry) : false;
                return (
                  <li key={row.line_ref} className="p-3 rounded-xl bg-[#141414] border border-white/5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-gray-100">{row.original_text || row.query}</span>
                      <span className="text-[10px] font-mono uppercase text-gray-400">
                        {OUTCOME_LABEL[row.outcome] ?? row.outcome}
                      </span>
                    </div>

                    {row.outcome === 'matched_exact' && (
                      <p className="mt-1 text-[11px] text-emerald-300">
                        Matched automatically as the single exact source description. This was not
                        manually confirmed by you.
                      </p>
                    )}

                    {row.outcome === 'review_required' && (
                      <fieldset className="mt-2 space-y-1">
                        <legend className="text-[11px] text-gray-400">
                          Choose the source food for {row.original_text}
                        </legend>
                        {row.candidates.map((candidate) => (
                          <label
                            key={candidate.fdc_id}
                            className="flex items-start gap-2 text-[11px] text-gray-200 cursor-pointer"
                          >
                            <input
                              type="radio"
                              name={`match-${row.line_ref}`}
                              checked={choice?.kind === 'candidate' && choice.fdc_id === candidate.fdc_id}
                              onChange={() =>
                                dispatch({
                                  type: 'select_match',
                                  lineRef: row.line_ref,
                                  choice: {
                                    kind: 'candidate',
                                    fdc_id: candidate.fdc_id,
                                    review_digest: row.review_digest ?? '',
                                  },
                                })
                              }
                              className="mt-0.5"
                            />
                            <span>
                              {candidate.description}{' '}
                              <span className="text-gray-400">
                                · {candidate.data_type} · FDC {candidate.fdc_id} · {candidate.rank_evidence}
                              </span>
                            </span>
                          </label>
                        ))}
                        <label className="flex items-start gap-2 text-[11px] text-gray-200 cursor-pointer">
                          <input
                            type="radio"
                            name={`match-${row.line_ref}`}
                            checked={choice?.kind === 'none'}
                            onChange={() =>
                              dispatch({
                                type: 'select_match',
                                lineRef: row.line_ref,
                                choice: { kind: 'none', review_digest: row.review_digest ?? '' },
                              })
                            }
                            className="mt-0.5"
                          />
                          <span>None of these</span>
                        </label>
                      </fieldset>
                    )}

                    {(row.outcome === 'unmatched' || row.outcome === 'invalid') && (
                      <p className="mt-1 text-[11px] text-amber-300">
                        {row.outcome === 'unmatched'
                          ? 'No USDA source candidate shares this ingredient. It contributes nothing.'
                          : 'This ingredient line could not be parsed safely. It contributes nothing.'}
                      </p>
                    )}
                    {row.outcome === 'qualitative' && (
                      <p className="mt-1 text-[11px] text-gray-400">
                        Qualitative ingredient — it is not treated as measurable and contributes no mass.
                      </p>
                    )}

                    {fdcId !== undefined && needsPortion && (
                      <PortionControls
                        row={row}
                        fdcId={fdcId}
                        session={session}
                        state={state}
                        dispatch={dispatch}
                        adapted={adapted}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={onCalculate}
              disabled={calculating}
              className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black disabled:opacity-50 transition-colors"
            >
              {calculating ? 'Calculating…' : 'Calculate Preview'}
            </button>
          </div>

          {preview && (
            <section aria-label="Advisory nutrition preview" className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <h3 className="text-xs font-bold text-white">Advisory nutrition preview</h3>
                {stale && (
                  <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    Stale — recalculate
                  </span>
                )}
              </div>
              <div className="text-[11px] text-gray-400 grid grid-cols-2 gap-x-4 gap-y-1">
                <span>Basis: {basisLabel(state.basis, state.selectedServings)}</span>
                <span>Status: {preview.status}</span>
                <span>Nutrients in scope: {preview.nutrient_scope.length}</span>
                <span>Unresolved ingredients: {preview.unresolved.length}</span>
                <span className="col-span-2 font-mono break-all">
                  Ingredient digest: {preview.ingredient_digest.slice(0, 32)}…
                </span>
              </div>

              {coverage && (
                <p className="text-[11px] text-gray-400">
                  Coverage: {coverage.status} · {coverage.unresolved_count} of {coverage.total_ingredients}{' '}
                  ingredient lines unresolved.
                </p>
              )}

              <div className="space-y-3">
                {NUTRIENT_GROUPS.map((group) => (
                  <div key={group.id}>
                    <h4 className="text-[11px] font-bold text-gray-300 uppercase tracking-wide mb-1">
                      {group.label}
                    </h4>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                      {(display ?? [])
                        .filter((nutrient) => group.nutrients.includes(nutrient.nutrient))
                        .map((nutrient) => (
                          <li
                            key={nutrient.nutrient}
                            className="flex items-center justify-between text-[11px] py-0.5 border-b border-white/5"
                          >
                            <span className="text-gray-300">{nutrient.label}</span>
                            <span className="font-mono text-gray-100">
                              {formatAmount(nutrient.amount)}
                              {nutrient.amount !== undefined ? ` ${nutrient.unit_label}` : ''}
                              <span className="text-gray-500 ml-2">
                                {formatDailyValue(nutrient.percent_daily_value)} DV
                              </span>
                              {nutrient.coverage === 'partial' && (
                                <span className="text-amber-300 ml-1">partial</span>
                              )}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>

              {evidence && (
                <div>
                  <h4 className="text-[11px] font-bold text-gray-300 uppercase tracking-wide mb-1">
                    Ingredient evidence
                  </h4>
                  <ul className="space-y-1">
                    {evidence.map((entry) => (
                      <li key={entry.line_ref} className="text-[11px] text-gray-400">
                        <span className="text-gray-200">{entry.original_text}</span> — {entry.outcome}
                        {entry.fdc_id !== undefined ? ` · FDC ${entry.fdc_id}` : ''}
                        {entry.mass_source ? ` · ${entry.mass_source}` : ''}
                        {entry.resolved_grams !== undefined ? ` · ${entry.resolved_grams} g` : ''}
                        {entry.user_confirmed ? ' · user-confirmed' : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.unresolved.length > 0 && (
                <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-[11px] text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">Some ingredient lines are unresolved.</p>
                    <ul className="list-disc list-inside">
                      {preview.unresolved.map((entry) => (
                        <li key={entry.line_ref}>
                          {entry.line_ref}: {entry.outcome}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <p className="text-[10px] text-gray-500 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  This advisory preview is derived from a pinned local USDA dataset. It is not saved to
                  the recipe, is not medical advice, and does not claim complete nutritional coverage.
                </span>
              </p>
            </section>
          )}

          <p className="text-[10px] text-gray-600">
            Recipe: {title}. Advanced Nutrition is advisory review only; nothing here is written
            to your vault.
          </p>
        </div>
      </div>
    </div>
  );
};
