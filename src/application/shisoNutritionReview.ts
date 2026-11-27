/**
 * Application-owned SHISO nutrition review.
 *
 * This is the same Phase 4 adaptation, analyzer, reducer and calculator used by
 * AdvancedNutritionCard, held behind a small imperative owner for a general
 * SHISO turn.  It exists so an asynchronous USDA load can be followed by an
 * analysis/apply operation without waiting for a component closure to refresh.
 * It never writes a Vault; the shell still owns Apply and Save.
 */

import type { ObsidianRecipe } from '../types';
import {
  INITIAL_PHASE4_STATE,
  adaptRecipe,
  analyzeRecipeFromRows,
  buildCalculationRequest,
  buildReviewRows,
  ingredientEvidenceViews,
  phase4Reducer,
  phase4SessionIdentity,
  projectLiveRows,
  type AdvancedNutritionSession,
  type AnalyzedRow,
  type LiveRowState,
  type Phase4State,
} from '../core/nutritionV2/phase4';
import { combineAiContributionsWithPreview, type AiNutrientContribution, type AiNutrientSupplement } from '../core/nutritionV2/aiContribution';
import { buildShisoNutrientCoverage, deriveNutritionCoverage, nutritionCoverageSummary } from '../core/shiso/nutritionCoverage';
import type { ShisoNutritionSnapshot } from '../application-ui/shisoEntryPoints';
import type { ShisoAnalysisOutcome, ShisoNutritionSourceSelectionOutcome } from '../core/shiso/protocol';
import { buildPortionChoice } from '../core/nutritionV2/phase4/portion';
import { selectionFromMatchChoice } from '../core/nutritionV2/phase4/rows';

export interface ShisoNutritionReviewController {
  readonly recipe: ObsidianRecipe;
  readonly session: AdvancedNutritionSession;
  readonly analyze: (signal?: AbortSignal) => ShisoAnalysisOutcome;
  readonly acceptAiNutrition: (
    contributions: readonly AiNutrientContribution[],
    supplements?: readonly AiNutrientSupplement[],
  ) => boolean;
  readonly selectUsdaNutritionSource: (input: {
    readonly lineRef: string;
    readonly fdcId: number;
    readonly portionIndex: number;
  }) => ShisoNutritionSourceSelectionOutcome;
  readonly getState: () => Phase4State;
  readonly getSnapshot: () => ShisoNutritionSnapshot | null;
}

function buildAnalysisOutcome(
  analysis: ReturnType<typeof analyzeRecipeFromRows>,
  signal?: AbortSignal,
): ShisoAnalysisOutcome {
  if (signal?.aborted) {
    return {
      ok: false,
      analyzed: false,
      summary: 'Nutrition analysis was cancelled.',
      matched: 0,
      needs_amount: 0,
      needs_match: 0,
      total_lines: analysis.rows.length,
      unresolved_line_refs: [],
      preview_state: 'absent',
      message: 'Nutrition analysis was cancelled.',
    };
  }
  const unresolved = analysis.rows
    .filter((row) => row.status === 'needs_amount' || row.status === 'needs_match' || row.status === 'unresolved')
    .map((row) => row.line_ref);
  return {
    ok: true,
    analyzed: true,
    summary: `${analysis.summary.matched} of ${analysis.summary.total} ingredient lines resolved`,
    matched: analysis.summary.matched,
    needs_amount: analysis.summary.needs_amount,
    needs_match: analysis.summary.needs_match + analysis.summary.unresolved,
    total_lines: analysis.summary.total,
    unresolved_line_refs: unresolved,
    preview_state: unresolved.length === 0 ? 'complete' : 'partial',
  };
}

export function createShisoNutritionReviewController(
  recipe: ObsidianRecipe,
  session: AdvancedNutritionSession,
): ShisoNutritionReviewController | null {
  const adaptedResult = adaptRecipe(recipe);
  if (!adaptedResult.ok) return null;
  const adapted = adaptedResult.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const identity = phase4SessionIdentity(session.metadata());
  const recipeKey = adaptedResult.recipe.recipe_key;
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey,
    sessionIdentity: identity,
    rows,
    baseServings: adaptedResult.recipe.base_servings,
  });
  let analysis = analyzeRecipeFromRows(session, adapted, rows, adaptedResult.recipe.base_servings);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  });

  const recalculate = (): boolean => {
    const calculated = session.calculate(buildCalculationRequest(adapted, state));
    if (!calculated.ok) return false;
    const nutrition = state.aiNutrition;
    const preview = nutrition && nutrition.recipe_key === recipeKey && nutrition.servings === state.baseServings
      ? combineAiContributionsWithPreview(calculated.preview, nutrition.contributions, nutrition.supplements)
      : calculated.preview;
    state = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq: state.operationSeq,
      recipeKey,
      preview,
    });
    return state.status === 'preview_current';
  };

  const getLiveRows = (): readonly LiveRowState[] => {
    const analyzedByRef = new Map<string, AnalyzedRow>(analysis.rows.map((row) => [row.line_ref, row]));
    const rows = projectLiveRows(
      state,
      analyzedByRef,
      adapted,
      session,
      state.preview ? ingredientEvidenceViews(state.preview) : null,
      analysis.portions,
      analysis.countPortions,
    );
    // The core calculator preserves an automatically discovered equal-
    // alternative as raw diagnostic evidence, but SHISO's working review must
    // present that line as unresolved until the user chooses a branch. This is
    // a presentation-level projection only; Phase 5 independently enforces the
    // same boundary before Apply/Save.
    return rows.map((row) => {
      const evidence = state.preview?.ingredients.find((entry) => entry.line_ref === row.line_ref);
      if (evidence?.outcome !== 'ambiguous' || evidence.match_status === 'user_confirmed') return row;
      return {
        ...row,
        status: 'needs_match' as const,
        resolved_grams: undefined,
        mass_source: undefined,
        portion_index: undefined,
      };
    });
  };

  const getSnapshot = (): ShisoNutritionSnapshot => {
    const rowsForDisplay = getLiveRows();
    const contributions = state.aiNutrition?.recipe_key === recipeKey && state.aiNutrition.servings === state.baseServings
      ? state.aiNutrition.contributions
      : [];
    const coverage = deriveNutritionCoverage(rowsForDisplay, contributions);
    const nutrientCoverage = buildShisoNutrientCoverage(state.preview);
    return {
      rows: rowsForDisplay,
      summary: nutritionCoverageSummary(coverage),
      unsaved: state.status === 'preview_stale' || state.status === 'preview_current',
      recipeKey,
      sessionIdentity: identity,
      reviewRows: state.rows,
      aiContributions: contributions,
      recipeDigest: state.preview?.ingredient_digest ?? null,
      reviewIdentity: `${identity}|${recipeKey}|${state.baseServings}`,
      nutrientCoverage,
    };
  };

  return {
    recipe,
    session,
    analyze: (signal) => {
      if (signal?.aborted) return buildAnalysisOutcome(analysis, signal);
      analysis = analyzeRecipeFromRows(session, adapted, state.rows, adaptedResult.recipe.base_servings);
      state = phase4Reducer(state, {
        type: 'apply_analysis',
        matches: analysis.matches,
        portions: analysis.portions,
        countPortions: analysis.countPortions,
        householdPortions: analysis.householdPortions,
        preview: analysis.preview,
      });
      return buildAnalysisOutcome(analysis, signal);
    },
    acceptAiNutrition: (contributions, supplements) => {
      const next = phase4Reducer(state, {
        type: 'accept_ai_nutrition',
        recipeKey,
        servings: state.baseServings,
        contributions,
        ...(supplements !== undefined ? { supplements } : {}),
      });
      if (next === state) return false;
      state = next;
      return recalculate();
    },
    selectUsdaNutritionSource: ({ lineRef, fdcId, portionIndex }) => {
      const row = state.rows.find((candidate) => candidate.line_ref === lineRef);
      const entry = adapted.find((candidate) => candidate.line_ref === lineRef);
      const fail = (code: string, summary: string): ShisoNutritionSourceSelectionOutcome => ({
        ok: false,
        line_ref: lineRef,
        summary,
        recalculation: 'absent',
        working_unsaved: state.status === 'preview_stale' || state.status === 'preview_current',
        code,
      });
      if (!row || !entry) return fail('stale_recipe', 'The ingredient line is no longer part of the current nutrition review.');
      if (!Number.isSafeInteger(fdcId) || fdcId <= 0 || !Number.isSafeInteger(portionIndex) || portionIndex < 0) {
        return fail('invalid_request', 'The USDA food or portion selection is invalid.');
      }
      const exact = session.searchFoods(String(fdcId), 5);
      const hit = exact.ok ? exact.results.find((result) => result.fdc_id === fdcId && result.exact_fdc_id) : undefined;
      if (!hit) return fail('invalid_selection', 'That USDA record is not available in the authenticated catalog.');
      const match = Object.freeze({
        kind: 'manual' as const,
        fdc_id: fdcId,
        review_digest: row.review_digest ?? '',
        record_digest: hit.record_digest,
        catalog_digest: session.metadata().catalog_digest,
        selectionOrigin: 'shiso_user_directed' as const,
        description: hit.description,
      });
      const selection = selectionFromMatchChoice(match, lineRef);
      const portion = buildPortionChoice(session, {
        lineRef,
        ingredient: entry.ingredient,
        review: row.review,
        selection,
        fdcId,
        portionIndex,
      });
      if (!portion.ok) return fail('invalid_selection', 'That USDA portion could not be authenticated for this ingredient.');
      let next = phase4Reducer(state, { type: 'select_match', lineRef, choice: match });
      next = phase4Reducer(next, { type: 'select_portion', lineRef, choice: portion.choice });
      const calculated = session.calculate(buildCalculationRequest(adapted, next));
      if (!calculated.ok) return fail('invalid_selection', 'The authenticated nutrition review rejected that source selection.');
      const evidence = calculated.preview.ingredients.find((candidate) => candidate.line_ref === lineRef);
      if (!evidence || evidence.fdc_id !== fdcId || evidence.resolved_grams === undefined) {
        return fail('invalid_selection', 'The selected USDA source did not produce a verified ingredient amount.');
      }
      next = phase4Reducer(next, {
        type: 'apply_analysis',
        matches: next.matches,
        portions: next.portions,
        countPortions: next.countPortions,
        householdPortions: next.householdPortions,
        preview: calculated.preview,
      });
      state = next;
      const portionResult = session.reviewPortions(fdcId);
      const portionCandidate = portionResult.ok
        ? portionResult.review.candidates.find((candidate) => candidate.index === portionIndex)
        : undefined;
      return {
        ok: true,
        line_ref: lineRef,
        fdc_id: fdcId,
        description: hit.description,
        resolved_grams: evidence.resolved_grams,
        ...(portionCandidate ? { portion: portionCandidate.display_label } : {}),
        summary: `Verified ${hit.description} for ${lineRef}: ${portionCandidate?.display_label ?? 'authenticated USDA portion'} → ${evidence.resolved_grams} g. The working nutrition review was recalculated; nothing was saved.`,
        recalculation: calculated.preview.status === 'complete' ? 'complete' : 'partial',
        working_unsaved: true,
      };
    },
    getState: () => state,
    getSnapshot,
  };
}
