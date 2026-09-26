/**
 * The Kitchen Codex — Advanced Nutrition: MANUAL DETERMINISTIC MODE regression
 * contract (AI-0).
 *
 * Permanent product invariant: the app remains fully usable with AI disabled.
 * Using the REAL pinned USDA bundle and NO AI path at all, this suite proves the
 * complete manual workflow:
 *
 *   1. Advanced Nutrition capabilities are Basic (no AI interpretation).
 *   2. Deterministic analysis still runs (all lines auto-resolved).
 *   3. The user can manually correct a food match.
 *   4. The user can enter a total weight manually.
 *   5. Verified source-portion controls continue to work.
 *   6. The user can clear an automatic resolution.
 *   7. Calculation succeeds.
 *   8. Review evidence is produced.
 *   9. Apply persists.
 *  10. Reload/hydration restores the reviewed state.
 *  11. No AI call is required anywhere in this workflow.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, vi } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import {
  INITIAL_PHASE4_STATE,
  adaptRecipe,
  analyzeRecipe,
  buildCalculationRequest,
  buildCountPortionChoice,
  buildPortionChoice,
  buildReviewRows,
  buildUserMassChoice,
  coverageSummary,
  hydrateWorkingReview,
  ingredientEvidenceViews,
  phase4Reducer,
  phase4SessionIdentity,
  projectLiveRows,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4Action,
  type Phase4Row,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import {
  isManualEditingAvailable,
  resolveNutritionCapabilities,
  BASIC_NUTRITION_CAPABILITIES,
} from '../../src/core/nutritionV2/nutritionCapabilities';
import { validateCodexNutritionV1 } from '../../src/core/nutritionV2/validate';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../../src/utils/markdownParser';
import { resolveRecipeVaultPath } from '../../src/core/vaultPath';
import {
  applyAdvancedNutrition,
  type AdvancedNutritionApplyResult,
} from '../../src/application/advancedNutritionApply';
import { resolveUnresolvedRowsWithAi } from '../../src/application/nutritionAiResolve';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { ObsidianRecipe } from '../../src/types';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';

const BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
}, 180000);

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { original: line };
  const p = parsed.parsed as {
    amount: number | null;
    raw_unit?: string;
    query: string;
  };
  return {
    original: line,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function testRecipe(lines: ReadonlyArray<string>): ObsidianRecipe {
  return {
    id: 'manual-mode',
    fileName: 'manual-mode.md',
    filePath: 'Recipes/manual-mode.md',
    rawMarkdown: '',
    title: 'Manual Mode',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: lines.map((line) => structured(line)) as never,
    instructions: [{ stepNumber: 1, text: 'Cook.' }] as never,
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: {},
  } as unknown as ObsidianRecipe;
}

/** Mirrors the modal's deterministic selection binding for build* helpers. */
function selectionForChoice(matchChoice: Record<string, unknown> | undefined, row: Phase4Row) {
  if (!matchChoice) return undefined;
  if (matchChoice.kind === 'manual') {
    return {
      kind: 'manual',
      fdc_id: matchChoice.fdc_id,
      record_digest: matchChoice.record_digest,
      catalog_digest: matchChoice.catalog_digest,
      line_ref: row.line_ref,
      review_digest: matchChoice.review_digest,
    };
  }
  if (row.outcome === 'review_required') {
    return matchChoice.kind === 'candidate'
      ? { kind: 'candidate', fdc_id: matchChoice.fdc_id, review_digest: matchChoice.review_digest }
      : { kind: 'none', review_digest: matchChoice.review_digest };
  }
  return undefined;
}

const LINE_CREAM = '2 cup heavy cream';
const LINE_GARLIC = '3 cloves garlic, minced';
const LINE_TOMATO = '2 medium tomatoes, sliced';

describe('manual deterministic Advanced Nutrition mode (AI disabled)', () => {
  it('proves points 1-11 end to end without any AI call', async () => {
    // --- 1. Basic capability: deterministic + manual editing, no AI --------
    const capabilities = resolveNutritionCapabilities();
    expect(capabilities.tier).toBe('basic');
    expect(capabilities.aiInterpretation).toBe(false);
    expect(capabilities.manualEditing).toBe(true);
    expect(isManualEditingAvailable(capabilities)).toBe(true);
    expect(isManualEditingAvailable(BASIC_NUTRITION_CAPABILITIES)).toBe(true);

    // --- Deterministic session + recipe ------------------------------------
    const target = testRecipe([LINE_CREAM, LINE_GARLIC, LINE_TOMATO]);
    const adaptation = adaptRecipe(target);
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const adapted: ReadonlyArray<AdaptedIngredient> = adaptation.recipe.adapted;
    const rows = buildReviewRows(session, adapted);
    expect(rows).toHaveLength(3);

    // --- 2. Deterministic analysis still runs ------------------------------
    const analysis = analyzeRecipe(session, adapted, 2);
    expect(analysis.preview).toBeDefined();
    let state: Phase4State = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows,
      baseServings: 2,
    } satisfies Phase4Action);
    state = phase4Reducer(state, {
      type: 'apply_analysis',
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions,
      preview: analysis.preview,
    });

    const liveFor = (value: Phase4State): ReadonlyArray<LiveRowState> => {
      const current = analyzeRecipe(session, adapted, 2);
      return projectLiveRows(
        value,
        new Map(current.rows.map((row) => [row.line_ref, row])),
        adapted,
        session,
        current.preview ? ingredientEvidenceViews(current.preview) : null,
        current.portions,
        current.countPortions
      );
    };

    const autoLive = liveFor(state);
    expect(autoLive).toHaveLength(3);
    for (const live of autoLive) {
      expect(live.status, live.line_ref).toBe('matched');
      expect(live.resolved_grams, live.line_ref).toBeGreaterThan(0);
    }
    const creamRef = rows[0].line_ref;
    const garlicRef = rows[1].line_ref;
    const tomatoRef = rows[2].line_ref;
    expect(autoLive[0].mass_source).toBe('source_portion');
    expect(autoLive[0].resolved_grams).toBe(480);

    // --- 6. Clear an automatic resolution (verified household choice) ------
    state = phase4Reducer(state, { type: 'clear_household_portion', lineRef: tomatoRef });
    expect(state.householdPortions[tomatoRef]).toBeUndefined();
    const clearedLive = liveFor(state);
    expect(clearedLive[2].resolved_grams).toBeUndefined();
    // The source-portion choice can also be cleared at the working-state level.
    state = phase4Reducer(state, { type: 'clear_portion', lineRef: creamRef });
    expect(state.portions[creamRef]).toBeUndefined();

    // --- 5. Verified source-portion control still works --------------------
    const creamMatch = state.matches[creamRef] as unknown as Record<string, unknown> | undefined;
    expect(creamMatch).toBeDefined();
    const creamFdc = creamMatch?.fdc_id as number;
    const portionReview = session.reviewPortions(creamFdc);
    expect(portionReview.ok).toBe(true);
    if (!portionReview.ok) return;
    const volumeCandidate = portionReview.review.candidates.find(
      (candidate) => candidate.kind === 'volume' && candidate.gram_weight > 0
    );
    expect(volumeCandidate).toBeDefined();
    if (!volumeCandidate) return;
    const creamPortion = buildPortionChoice(session, {
      lineRef: creamRef,
      ingredient: adapted[0].ingredient,
      review: rows[0].outcome === 'review_required' ? rows[0].review : undefined,
      selection: selectionForChoice(creamMatch, rows[0]),
      automaticSelection: creamMatch?.automatic === true,
      fdcId: creamFdc,
      portionIndex: volumeCandidate.index,
    });
    expect(creamPortion.ok).toBe(true);
    if (!creamPortion.ok) return;
    state = phase4Reducer(state, {
      type: 'select_portion',
      lineRef: creamRef,
      choice: creamPortion.choice,
    });
    const portionLive = liveFor(state);
    expect(portionLive[0].status).toBe('matched');
    expect(portionLive[0].resolved_grams).toBe(480);
    expect(portionLive[0].mass_source).toBe('source_portion');

    // --- 3. Manual food-match correction -----------------------------------
    // The household choice was cleared above; pick a DIFFERENT authenticated
    // candidate than the analyzer's automatic one.
    const originalTomatoFdc = (state.matches[tomatoRef] as { fdc_id?: number } | undefined)?.fdc_id;
    const tomatoSearch = session.searchFoods('tomatoes', 5);
    expect(tomatoSearch.ok).toBe(true);
    if (!tomatoSearch.ok) return;
    const alternative = tomatoSearch.results.find((hit) => hit.fdc_id !== originalTomatoFdc);
    expect(alternative).toBeDefined();
    if (!alternative) return;
    state = phase4Reducer(state, {
      type: 'select_match',
      lineRef: tomatoRef,
      choice: {
        kind: 'manual',
        fdc_id: alternative.fdc_id,
        review_digest: rows[2].review_digest ?? '',
        record_digest: alternative.record_digest,
        catalog_digest: session.metadata().catalog_digest,
        description: alternative.description,
      },
    });
    expect((state.matches[tomatoRef] as { fdc_id?: number }).fdc_id).toBe(alternative.fdc_id);

    // --- 4. Manual total weight (two independent lines) --------------------
    state = phase4Reducer(state, { type: 'clear_count_portion', lineRef: garlicRef });
    state = phase4Reducer(state, { type: 'clear_household_portion', lineRef: garlicRef });
    const garlicMatch = state.matches[garlicRef] as unknown as Record<string, unknown> | undefined;
    expect(garlicMatch).toBeDefined();
    const garlicFdc = garlicMatch?.fdc_id as number;
    const garlicMass = buildUserMassChoice(session, {
      lineRef: garlicRef,
      ingredient: adapted[1].ingredient,
      review: rows[1].outcome === 'review_required' ? rows[1].review : undefined,
      selection: selectionForChoice(garlicMatch, rows[1]),
      automaticSelection: garlicMatch?.automatic === true,
      fdcId: garlicFdc,
      quantity: 500,
      unit: 'g',
    });
    expect(garlicMass.ok).toBe(true);
    if (!garlicMass.ok) return;
    state = phase4Reducer(state, {
      type: 'select_user_mass',
      lineRef: garlicRef,
      choice: garlicMass.choice,
    });
    expect(state.userMasses[garlicRef]?.quantity).toBe(500);

    const tomatoMatch = state.matches[tomatoRef] as unknown as Record<string, unknown> | undefined;
    expect(tomatoMatch).toBeDefined();
    const tomatoMass = buildUserMassChoice(session, {
      lineRef: tomatoRef,
      ingredient: adapted[2].ingredient,
      review: rows[2].outcome === 'review_required' ? rows[2].review : undefined,
      selection: selectionForChoice(tomatoMatch, rows[2]),
      automaticSelection: tomatoMatch?.automatic === true,
      fdcId: alternative.fdc_id,
      quantity: 300,
      unit: 'g',
    });
    expect(tomatoMass.ok).toBe(true);
    if (!tomatoMass.ok) return;
    state = phase4Reducer(state, {
      type: 'select_user_mass',
      lineRef: tomatoRef,
      choice: tomatoMass.choice,
    });
    expect(state.userMasses[tomatoRef]?.quantity).toBe(300);

    // --- 7. Calculation succeeds (and the review preview is recorded) ------
    const seq = state.operationSeq;
    const calculationBase = buildCalculationRequest(adapted, state) as Record<string, unknown>;
    const calculated = session.calculate({
      ...calculationBase,
      nutrient_scope: ['calories', 'protein'],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    state = phase4Reducer(state, {
      type: 'preview_succeeded',
      seq,
      recipeKey: state.recipeKey as string,
      preview: calculated.preview,
    });
    const liveFinal = liveFor(state);
    expect(liveFinal[0].resolved_grams).toBe(480);
    expect(liveFinal[1].mass_source).toBe('user_mass');
    expect(liveFinal[1].resolved_grams).toBe(500);
    expect(liveFinal[2].selected_fdc_id).toBe(alternative.fdc_id);

    // --- 8. Review evidence works ------------------------------------------
    const views = ingredientEvidenceViews(calculated.preview);
    expect(views).toHaveLength(3);
    const review = coverageSummary(calculated.preview);
    expect(review.total_ingredients).toBe(3);
    expect(calculated.preview.totals.calories?.amount).toBeGreaterThan(0);

    // --- 9. Apply persists --------------------------------------------------
    const files = new Map<string, string>();
    const writes: ObsidianRecipe[] = [];
    const applied: AdvancedNutritionApplyResult = await applyAdvancedNutrition({
      session,
      recipe: target,
      state,
      write: async (updated: ObsidianRecipe) => {
        writes.push(updated);
        files.set(resolveRecipeVaultPath(updated), serializeRecipeToObsidianMarkdown(updated));
      },
      readBack: async (updated: ObsidianRecipe) => {
        const text = files.get(resolveRecipeVaultPath(updated));
        if (text === undefined) throw new Error('missing');
        return text;
      },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(writes).toHaveLength(1);
    const written = writes[0];
    const markdown = files.get(resolveRecipeVaultPath(written)) as string;
    expect(markdown).toContain('codex_nutrition');

    // --- 10. Reload/hydration restores the reviewed state -------------------
    const reparsed = parseObsidianRecipeMarkdown(markdown, written.fileName, written.filePath);
    const validation = validateCodexNutritionV1(reparsed.codexNutrition);
    expect(validation.ok).toBe(true);
    if (!validation.ok || !validation.value) return;
    const reopened = adaptRecipe(reparsed);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const reopenedAdapted = reopened.recipe.adapted;
    const reopenedRows = buildReviewRows(session, reopenedAdapted);
    const hydrated = hydrateWorkingReview({
      session,
      adapted: reopenedAdapted,
      rows: reopenedRows,
      savedBlock: validation.value,
    });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.hydrated_count).toBe(3);
    // The manual total weight survives reload exactly.
    expect(hydrated.userMasses[reopenedRows[1].line_ref]?.quantity).toBe(500);
    // The manually corrected tomato identity survives reload exactly.
    expect(hydrated.matches[reopenedRows[2].line_ref]?.fdc_id).toBe(alternative.fdc_id);
    // The verified source portion survives reload exactly.
    expect(hydrated.portions[reopenedRows[0].line_ref]).toBeDefined();

    // --- 11. No AI call was required anywhere ------------------------------
    const post = vi.fn();
    const network = { post } as unknown as NetworkAdapter;
    const aiAttempt = await resolveUnresolvedRowsWithAi({
      network,
      session,
      rows,
      adapted,
      capabilities: BASIC_NUTRITION_CAPABILITIES,
    });
    expect(post).not.toHaveBeenCalled();
    expect(aiAttempt.aiAttempted).toBe(false);
    expect(aiAttempt.ok).toBe(false);
  }, 120000);
});
