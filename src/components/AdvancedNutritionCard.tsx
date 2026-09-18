import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Activity, FlaskConical, Loader2, Lock, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ObsidianRecipe } from '../types';
import {
  INITIAL_PHASE4_STATE,
  PHASE4_BUNDLE_FAILED_MESSAGE,
  PHASE4_BUNDLE_RETRY_LABEL,
  PHASE4_IDLE_MESSAGE,
  PHASE4_LOADING_MESSAGE,
  PHASE4_UNAVAILABLE_MESSAGE,
  PHASE4_UNREADABLE_MESSAGE,
  PHASE4_UNSUPPORTED_MESSAGE,
  adaptRecipe,
  basisLabel,
  buildCalculationRequest,
  buildReviewRows,
  coverageSummary,
  deriveDisplayNutrients,
  formatAmount,
  phase4Failure,
  phase4Reducer,
  phase4SessionIdentity,
  readStoredBlock,
  type AdvancedNutritionSession,
  type AdaptedIngredient,
  type Phase4State,
} from '../core/nutritionV2/phase4';
import { authorizeNutritionPersistence } from '../core/nutritionV2/phase5';
import { AdvancedNutritionModal, type AdvancedNutritionApplyUi } from './AdvancedNutritionModal';

export type AdvancedNutritionBundleUiStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'failed'
  | 'unsupported';

/** Arguments for the explicit Phase 5B Apply handler (owned by the shell). */
export interface AdvancedNutritionApplyHandlerArgs {
  readonly session: AdvancedNutritionSession;
  readonly recipe: ObsidianRecipe;
  readonly state: Phase4State;
  readonly expectedMode: 'create' | 'replace';
}

export interface AdvancedNutritionApplyUiResult {
  readonly ok: boolean;
  readonly mode?: 'create' | 'replace';
  readonly message: string;
}

/**
 * The explicit Apply handler. The shell (App) implements it with the application
 * write coordinator + the existing vault write path. The card only renders the
 * control and the result; it never writes anything itself.
 */
export type AdvancedNutritionApplyHandler = (
  args: AdvancedNutritionApplyHandlerArgs
) => Promise<AdvancedNutritionApplyUiResult>;

interface AdvancedNutritionCardProps {
  recipe: ObsidianRecipe;
  session?: AdvancedNutritionSession | null;
  servings?: number;
  /** Phase 4.5B lazy local-bundle state (absent when no loader is wired). */
  bundleStatus?: AdvancedNutritionBundleUiStatus;
  /** Explicit user-triggered load. Absent when no loader is wired. */
  onLoadBundle?: () => void;
  /** Explicit Phase 5B Apply handler. Absent when no write path is wired. */
  onApplyAdvancedNutrition?: AdvancedNutritionApplyHandler;
}

type ApplyUiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming'; readonly mode: 'create' | 'replace' }
  | { readonly kind: 'applying' }
  | { readonly kind: 'success'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

const NO_INGREDIENTS: ReadonlyArray<AdaptedIngredient> = Object.freeze([]);

export const AdvancedNutritionCard: React.FC<AdvancedNutritionCardProps> = ({
  recipe,
  session = null,
  bundleStatus,
  onLoadBundle,
  onApplyAdvancedNutrition,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [applyState, setApplyState] = useState<ApplyUiState>({ kind: 'idle' });
  const [state, dispatch] = useReducer(phase4Reducer, INITIAL_PHASE4_STATE);
  const pendingOpen = useRef(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  // When a user-initiated load succeeds, focus the (now-rendered) opener and
  // open the review UI exactly once, so closing the modal restores focus to it.
  useEffect(() => {
    if (session && pendingOpen.current) {
      pendingOpen.current = false;
      openerRef.current?.focus();
      setIsOpen(true);
    }
  }, [session]);

  const handleOpenRequest = () => {
    if (session) {
      setIsOpen(true);
      return;
    }
    if (onLoadBundle) {
      pendingOpen.current = true;
      onLoadBundle();
    }
  };

  // Materialize the narrow adaptation envelope ONCE, safely, before any recipe
  // or ingredient property is used. The untrusted runtime recipe is never read
  // directly.
  const adaptation = useMemo(() => adaptRecipe(recipe), [recipe]);
  const adapted = adaptation.ok ? adaptation.recipe.adapted : NO_INGREDIENTS;
  const rows = useMemo(
    () => (session && adaptation.ok ? buildReviewRows(session, adapted) : []),
    [session, adaptation, adapted]
  );

  useEffect(() => {
    if (!session || !adaptation.ok) {
      dispatch({ type: 'reset' });
      return;
    }
    if (adapted.length === 0) return;
    dispatch({
      type: 'initialize',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows,
      baseServings: adaptation.recipe.base_servings,
    });
  }, [session, adaptation, adapted.length, rows]);

  const stored = useMemo(() => readStoredBlock(recipe), [recipe]);
  const preview = state.preview;
  const display = useMemo(
    () =>
      preview
        ? deriveDisplayNutrients(preview, state.basis, state.baseServings, state.selectedServings)
        : null,
    [preview, state.basis, state.baseServings, state.selectedServings]
  );
  const coverage = useMemo(() => (preview ? coverageSummary(preview) : null), [preview]);

  // Phase 5A: report whether the current reviewed result is currently eligible
  // for an explicit Apply. This NEVER writes anything. An opaque/malformed
  // existing block is never eligible (Apply must not replace it).
  const applyEligibility = useMemo(() => {
    if (!session || !adaptation.ok || state.status !== 'preview_current' || state.preview === null) {
      return null;
    }
    if (stored.kind === 'opaque') return false;
    return authorizeNutritionPersistence({ session, recipe, state }).ok;
  }, [session, recipe, adaptation, state, stored.kind]);

  const applyMode: 'create' | 'replace' | null =
    stored.kind === 'v1' ? 'replace' : stored.kind === 'none' ? 'create' : null;

  const handleRequestApply = () => {
    if (!onApplyAdvancedNutrition || applyEligibility !== true || applyMode === null) return;
    if (applyState.kind === 'applying' || applyState.kind === 'confirming') return;
    setApplyState({ kind: 'confirming', mode: applyMode });
  };

  const handleConfirmApply = async () => {
    if (!onApplyAdvancedNutrition || !session || !adaptation.ok) return;
    if (applyState.kind !== 'confirming') return;
    const expectedMode = applyState.mode;
    setApplyState({ kind: 'applying' });
    try {
      const result = await onApplyAdvancedNutrition({ session, recipe, state, expectedMode });
      setApplyState(
        result.ok
          ? { kind: 'success', message: result.message }
          : { kind: 'error', message: result.message }
      );
    } catch {
      setApplyState({ kind: 'error', message: 'Advanced Nutrition could not be applied.' });
    }
  };

  const handleCancelApply = () => {
    setApplyState((current) => (current.kind === 'confirming' ? { kind: 'idle' } : current));
  };

  const applyUi: AdvancedNutritionApplyUi | undefined = onApplyAdvancedNutrition
    ? {
        eligible: applyEligibility,
        mode: applyMode,
        status: applyState.kind,
        message: applyState.kind === 'success' || applyState.kind === 'error' ? applyState.message : null,
        onRequest: handleRequestApply,
        onConfirm: handleConfirmApply,
        onCancel: handleCancelApply,
      }
    : undefined;

  const handleCalculate = () => {
    if (!session || !adaptation.ok) return;
    setCalculating(true);
    const seq = state.operationSeq;
    const key = state.recipeKey ?? '';
    const request = buildCalculationRequest(adapted, state);
    const result = session.calculate(request);
    setCalculating(false);
    if (result.ok) {
      dispatch({ type: 'preview_succeeded', seq, recipeKey: key, preview: result.preview });
    } else {
      dispatch({ type: 'preview_failed', seq, failure: phase4Failure('validation_error') });
    }
  };

  const compact = display
    ? (['calories', 'protein', 'carbohydrates', 'fat'] as const).map((id) => {
        const row = display.find((entry) => entry.nutrient === id);
        return row;
      })
    : null;

  return (
    <div
      id="advanced-nutrition-card"
      className="bg-[#141414] rounded-2xl border border-indigo-500/20 p-5 shadow-xs text-gray-200"
    >
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 flex items-center justify-center">
            <FlaskConical className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-serif font-bold text-white flex items-center gap-1.5">
              <span>Advanced Nutrition</span>
              <span className="text-[10px] font-mono text-indigo-300 font-normal uppercase">Advisory</span>
            </h3>
            <p className="text-[10px] text-gray-500">
              Reviewed USDA source matching · separate from the simple nutrition card
            </p>
          </div>
        </div>
      </div>

      {!session && !onLoadBundle && (
        <div className="p-3 rounded-xl bg-[#0E0E0E] border border-dashed border-white/10 space-y-2">
          <p className="text-xs text-gray-300">{PHASE4_UNAVAILABLE_MESSAGE}</p>
          <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            <span>This is not an error in the recipe.</span>
          </p>
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-500 bg-white/5 border border-white/10 cursor-not-allowed"
          >
            <FlaskConical className="w-3.5 h-3.5" />
            <span>Open Advanced Nutrition</span>
          </button>
        </div>
      )}

      {!session && onLoadBundle && (
        <div className="p-3 rounded-xl bg-[#0E0E0E] border border-dashed border-white/10 space-y-2">
          <p className="text-xs text-gray-300" role="status" aria-live="polite">
            {bundleStatus === 'loading'
              ? PHASE4_LOADING_MESSAGE
              : bundleStatus === 'failed'
                ? PHASE4_BUNDLE_FAILED_MESSAGE
                : bundleStatus === 'unsupported'
                  ? PHASE4_UNSUPPORTED_MESSAGE
                  : PHASE4_IDLE_MESSAGE}
          </p>
          <p className="text-[11px] text-gray-500 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" />
            <span>This is not an error in the recipe.</span>
          </p>
          {bundleStatus === 'loading' ? (
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 bg-white/5 border border-white/10 cursor-wait"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Authenticating…</span>
            </button>
          ) : bundleStatus === 'failed' ? (
            <button
              type="button"
              onClick={handleOpenRequest}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{PHASE4_BUNDLE_RETRY_LABEL}</span>
            </button>
          ) : bundleStatus === 'unsupported' ? null : (
            <button
              type="button"
              onClick={handleOpenRequest}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 transition-colors"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>Open Advanced Nutrition</span>
            </button>
          )}
        </div>
      )}

      {session && !adaptation.ok && (
        <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-amber-200 text-xs flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{PHASE4_UNREADABLE_MESSAGE}</span>
        </div>
      )}

      {session && adaptation.ok && (
        <div className="space-y-3">
          {stored.kind === 'v1' && (
            <div className="p-3 rounded-xl bg-[#0E0E0E] border border-white/5">
              <p className="text-[10px] font-mono uppercase text-gray-500 mb-1">
                Saved advanced nutrition{stored.servings ? ` · base ${stored.servings} servings` : ''}
                {stored.status ? ` · ${stored.status}` : ''}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {(stored.values ?? []).map((value) => (
                  <span key={value.label} className="text-gray-300">
                    {value.label}: <span className="font-mono text-white">{value.amount}</span> {value.unit}
                  </span>
                ))}
                {(stored.values ?? []).length === 0 && (
                  <span className="text-gray-500">No recognized nutrient amounts.</span>
                )}
              </div>
            </div>
          )}
          {stored.kind === 'opaque' && (
            <div className="p-3 rounded-xl bg-[#0E0E0E] border border-white/5">
              <p className="text-[11px] text-gray-400">
                This recipe carries an unrecognized advanced-nutrition format. It is preserved but not
                interpreted or displayed as trusted data.
              </p>
            </div>
          )}

          {preview && compact && (
            <div className="p-3 rounded-xl bg-indigo-950/20 border border-indigo-500/20">
              <p className="text-[10px] font-mono uppercase text-indigo-300 mb-1">
                In-memory advisory preview · {basisLabel(state.basis, state.selectedServings)}
                {state.status === 'preview_stale' ? ' · stale' : ''}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {compact.map((nutrient) =>
                  nutrient ? (
                    <span key={nutrient.nutrient} className="text-gray-300">
                      {nutrient.label}:{' '}
                      <span className="font-mono text-white">{formatAmount(nutrient.amount)}</span>{' '}
                      {nutrient.amount !== undefined ? nutrient.unit_label : ''}
                    </span>
                  ) : null
                )}
              </div>
              {coverage && (
                <p className="text-[10px] text-gray-400 mt-1">
                  Coverage {coverage.status} · {coverage.unresolved_count} unresolved line(s)
                </p>
              )}
              <p className="text-[10px] text-gray-500 mt-1">
                Advisory only — never presented as saved recipe data.
              </p>
              {applyEligibility !== null && (
                <p
                  data-testid="advanced-nutrition-apply-eligibility"
                  className={`text-[10px] mt-1 ${applyEligibility ? 'text-emerald-300' : 'text-amber-300'}`}
                >
                  {applyEligibility
                    ? 'This reviewed result is eligible for a future Apply. Nothing is saved automatically.'
                    : 'This reviewed result is not eligible for Apply yet.'}
                </p>
              )}
            </div>
          )}

          {!preview && (
            <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-indigo-300" />
              <span>
                Review each ingredient's source match, then calculate an advisory preview. Nothing is
                calculated automatically.
              </span>
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-500 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              <span>Advisory · not saved · not medical advice</span>
            </span>
            <button
              type="button"
              ref={openerRef}
              onClick={() => setIsOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-200 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 transition-colors"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              <span>Open Advanced Nutrition</span>
            </button>
          </div>
        </div>
      )}

      {session && adaptation.ok && (
        <AdvancedNutritionModal
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          title={adaptation.recipe.title}
          session={session}
          adapted={adapted}
          state={state}
          dispatch={dispatch}
          onCalculate={handleCalculate}
          calculating={calculating}
          apply={applyUi}
        />
      )}
    </div>
  );
};
