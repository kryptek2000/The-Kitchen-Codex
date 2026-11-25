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
import type { ShisoAnalysisOutcome } from '../core/shiso/protocol';

export interface ShisoNutritionReviewController {
  readonly recipe: ObsidianRecipe;
  readonly session: AdvancedNutritionSession;
  readonly analyze: (signal?: AbortSignal) => ShisoAnalysisOutcome;
  readonly acceptAiNutrition: (
    contributions: readonly AiNutrientContribution[],
    supplements?: readonly AiNutrientSupplement[],
  ) => boolean;
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
    return projectLiveRows(
      state,
      analyzedByRef,
      adapted,
      session,
      state.preview ? ingredientEvidenceViews(state.preview) : null,
      analysis.portions,
      analysis.countPortions,
    );
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
    getState: () => state,
    getSnapshot,
  };
}
