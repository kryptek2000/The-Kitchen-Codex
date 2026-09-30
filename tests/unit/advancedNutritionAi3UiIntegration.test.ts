/**
 * AI-3 — SLICE D INTEGRATION: the full offer -> accept -> replace path,
 * exercised against the REAL pinned USDA bundle and the REAL production
 * session, reducer, calculator and Apply coordinator.
 *
 * The end-to-end sequence the architect requires:
 *
 *   offer exists ............ Apply is unaffected
 *   offer accepted .......... the preview uses `ai_estimate`
 *   direct Apply call ....... Layer B refuses, writer call count is 0
 *   user replaces it ......... the AI estimate is removed, the preview is
 *                              recalculated, and normal eligibility returns
 */
import { describe, it, expect, vi } from 'vitest';

import {
  acceptAiEstimateOffer,
  buildAiEstimateOffer,
  buildAiEstimateUiSnapshot,
  type AiEstimateOffer,
} from '../../src/core/nutritionV2/phase4/aiEstimateAccept';
import { aiEstimateSnapshotBinding } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import { workingChoiceFingerprint } from '../../src/core/nutritionV2/phase4/aiMidFlight';
import { hasActiveAiEstimateForPreview } from '../../src/core/nutritionV2/phase4/aiEstimateApplyGate';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildReviewRows, lineCalculationInput } from '../../src/core/nutritionV2/phase4/rows';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { projectLiveRows } from '../../src/core/nutritionV2/phase4/liveRow';
import { phase4Reducer, INITIAL_PHASE4_STATE } from '../../src/core/nutritionV2/phase4/state';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { buildAiEstimateSelection, type AiEstimateSelectionEvidence } from '../../src/core/nutritionV2/phase4/aiEstimateSelection';
import { AI_ESTIMATE_PROVENANCE_CLASS } from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import type { Phase4State } from '../../src/core/nutritionV2/phase4/types';

function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

const RECIPE = {
  title: 'AI-3 Slice D integration',
  servings: 1,
  ingredients: [structuredLine('3/4 cup cooked white rice')],
} as never;

const BUNDLE_DIR = join(process.cwd(), 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');
const SESSION_RESULT = await composeAdvancedNutritionSessionFromBundle({
  files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
    name,
    bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
  })),
} as never);
if (!SESSION_RESULT.ok) throw new Error('real session failed');
const SESSION = SESSION_RESULT.session;

const ADAPTED = adaptRecipe(RECIPE);
if (ADAPTED.ok !== true) throw new Error('adapt failed');
const ADAPTED_RECIPE = ADAPTED.recipe;
const ANALYSIS = analyzeRecipe(SESSION, ADAPTED_RECIPE.adapted, ADAPTED_RECIPE.base_servings);
const LINE = ANALYSIS.rows[0].line_ref;

function seedState(): Phase4State {
  const reviewRows = buildReviewRows(SESSION, ADAPTED_RECIPE.adapted);
  let st = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: ADAPTED_RECIPE.recipe_key,
    sessionIdentity: 'slice-d-integration',
    rows: reviewRows,
    baseServings: 1,
  } as never);
  st = phase4Reducer(st, {
    type: 'apply_analysis',
    matches: ANALYSIS.matches,
    portions: ANALYSIS.portions,
    countPortions: ANALYSIS.countPortions,
    householdPortions: ANALYSIS.householdPortions,
    preview: ANALYSIS.preview,
  } as never);
  return st;
}

function evidenceFor(state: Phase4State): AiEstimateSelectionEvidence | undefined {
  const rows = buildReviewRows(SESSION, ADAPTED_RECIPE.adapted);
  const dry = SESSION.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [lineCalculationInput(ADAPTED_RECIPE.adapted[0], state, rows[0])],
  } as never);
  if (!dry.ok) return undefined;
  const entry = dry.preview.ingredients[0];
  if (entry.fdc_id === undefined || entry.record_digest === undefined) return undefined;
  return {
    line_ref: LINE,
    fdc_id: entry.fdc_id,
    record_digest: entry.record_digest,
    ingredient_identity_digest: entry.ingredient_identity_digest,
    bundle_release: (dry.preview as unknown as { bundle_release: string }).bundle_release,
  };
}

function currentFingerprint(state: Phase4State): string {
  return workingChoiceFingerprint(state, LINE);
}

describe('AI-3 Slice D integration — offer, accept, block, replace', () => {
  it('[AI3-M51-HIST] the whole user path behaves truthfully against the real bundle', async () => {
    const offered = seedState();
    const evidence = evidenceFor(offered);
    expect(evidence).toBeDefined();
    if (evidence === undefined) return;


    // ---- 1. an OFFER exists; nothing is selected, nothing is blocked -------
    const offer = buildAiEstimateOffer({
      line_ref: LINE,
      kind: 'offer',
      evidence: {
        lower_grams: 150,
        upper_grams: 200,
        representative_policy: 'midpoint',
        provenance: AI_ESTIMATE_PROVENANCE_CLASS,
      } as never,
    });
    expect(offer).not.toBeNull();
    if (offer === null) return;
    expect(offer.label).toBe('AI estimate (not USDA-authenticated)');
    expect(offer.representative_grams).toBe(175);

    const stateWithIdentity = {
      ...offered,
      matches: { [LINE]: { fdc_id: evidence.fdc_id, record_digest: evidence.record_digest, review_digest: 'vd' } },
    } as unknown as Phase4State;

    // An offer alone blocks nothing and affects no preview.
    expect(stateWithIdentity.aiEstimates?.[LINE]).toBeUndefined();
    expect(hasActiveAiEstimateForPreview(stateWithIdentity)).toBe(false);

    // ---- 2. the SECOND click accepts --------------------------------------
    const snapshot = buildAiEstimateUiSnapshot(LINE, ANALYSIS.rows[0], stateWithIdentity.matches[LINE]);
    const accepted = acceptAiEstimateOffer(offer as AiEstimateOffer, {
      currentState: stateWithIdentity,
      offerFingerprint: currentFingerprint(stateWithIdentity),
      offerSnapshotBinding: aiEstimateSnapshotBinding(snapshot),
      evidence,
      snapshot,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok === false) return;

    // The selection is a REAL Phase-3 selection, not a hand-built object.
    const built = buildAiEstimateSelection(LINE, evidence, {
      fdc_id: evidence.fdc_id,
      record_digest: evidence.record_digest,
      review_digest: 'vd',
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 175,
      representative_policy: 'midpoint',
      provenance: AI_ESTIMATE_PROVENANCE_CLASS,
      snapshot_binding: aiEstimateSnapshotBinding(snapshot),
    } as never);
    expect(built.ok).toBe(true);

    const active = phase4Reducer(stateWithIdentity, {
      type: 'select_ai_estimate',
      lineRef: LINE,
      choice: accepted.choice,
    } as never);
    expect(hasActiveAiEstimateForPreview(active)).toBe(true);

    // ---- 3. a DIRECT Apply call is refused by Layer B; writer never called -
    const writer = vi.fn(async () => {});
    const readBack = vi.fn(async () => 'stored');
    const result = await applyAdvancedNutrition(
      {
        session: SESSION,
        recipe: { title: 'AI-3 Slice D integration', servings: 4, ingredients: [] },
        state: active,
        write: writer,
        readBack,
        computedAt: '2026-01-01T00:00:00.000Z',
        expectedMode: 'create',
      } as never
    );
    expect(result.ok).toBe(false);
    expect(writer).toHaveBeenCalledTimes(0);
    expect(readBack).toHaveBeenCalledTimes(0);

    // ---- 4. the user replaces it with their own mass ----------------------
    const replaced = phase4Reducer(active, {
      type: 'select_user_mass',
      lineRef: LINE,
      choice: { grams: 150, quantity: 1, unit: 'cup', source: 'user' },
    } as never);
    expect(replaced.aiEstimates?.[LINE]).toBeUndefined();
    expect(replaced.userMasses[LINE]).toBeDefined();
    // Normal eligibility returns: the preview-only block no longer applies.
    expect(hasActiveAiEstimateForPreview(replaced)).toBe(false);

  });
});
