/**
 * The Kitchen Codex — SHISO H-2N nutrition-correction STATE TRUTH.
 *
 * OFFLINE. No provider calls, no vault writes.
 *
 * The human test reported "corrections applied" while the post-operation review
 * was unchanged and a previously matched line had fallen back to "needs match".
 * These tests pin the state-truth contract:
 *
 *   1. only corrections that VERIFY resolved in the authoritative post
 *      projection are reported as applied;
 *   2. previously resolved lines can never regress (the operation is refused
 *      whole, and the working review stays exactly as it was);
 *   3. the reported before/after counts are the REAL projections;
 *   4. the tool observation forces truthful reporting (applied_count, failed,
 *      regressed, honesty note);
 *   5. corrections never save.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import {
  adaptRecipe,
  analyzeRecipe,
  buildCalculationRequest,
  buildReviewRows,
  ingredientEvidenceViews,
  phase4Reducer,
  phase4SessionIdentity,
  projectLiveRows,
  summarizeLiveRows,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4Row,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import { buildSupportedNutritionCorrections } from '../../src/core/shiso/nutritionCorrections';
import {
  decideCorrectionDispatch,
  evaluateCorrectionTransition,
} from '../../src/core/shiso/correctionTransition';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import { parseObsidianRecipeMarkdown } from '../../src/utils/markdownParser';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';

beforeAll(async () => {
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
});

const PINNED = join(__dirname, '../../data/advanced-nutrition/usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);

// ---------------------------------------------------------------------------
// Fabricated live rows for the pure evaluator
// ---------------------------------------------------------------------------

function liveRow(partial: {
  line_ref: string;
  original_text?: string;
  status: LiveRowState['status'];
  resolved_grams?: number;
  selected_fdc_id?: number;
}): LiveRowState {
  return {
    line_ref: partial.line_ref,
    original_text: partial.original_text ?? partial.line_ref,
    status: partial.status,
    resolved_grams: partial.resolved_grams,
    selected_fdc_id: partial.selected_fdc_id,
    selected_description: undefined,
    mass_source: undefined,
    portion_index: undefined,
    user_mass_quantity: undefined,
    user_mass_unit: undefined,
    source_portion_automatic: false,
    household_unit: undefined,
    household_size_class: undefined,
    household_requires_state: undefined,
    household_authority_class: undefined,
    food_authority: 'none',
  } as unknown as LiveRowState;
}

// ===========================================================================
// 1. The transition evaluator and the dispatch gate (pure)
// ===========================================================================

describe('H-2N — transition evaluation', () => {
  it('marks a correction verified ONLY when the after row is matched with a real mass', () => {
    const transition = evaluateCorrectionTransition({
      before: [
        liveRow({ line_ref: 'a', original_text: '1 cup chicken broth', status: 'review_suggested' }),
        liveRow({ line_ref: 'b', original_text: '1 onion', status: 'needs_amount', selected_fdc_id: 170000 }),
      ],
      after: [
        liveRow({ line_ref: 'a', original_text: '1 cup chicken broth', status: 'matched', resolved_grams: 249, selected_fdc_id: 174536 }),
        liveRow({ line_ref: 'b', original_text: '1 onion', status: 'needs_amount', selected_fdc_id: 170000 }),
      ],
      corrections: [
        { line_ref: 'a', label: '1 cup chicken broth', description: 'Soup, chicken broth · 1 cup = 249 g' },
        { line_ref: 'b', label: '1 onion', description: 'Onions, raw · 1 whole = 148 g' },
      ],
    });
    expect(transition.verified.map((entry) => entry.line_ref)).toEqual(['a']);
    expect(transition.verified[0]!.after_grams).toBe(249);
    expect(transition.failed.map((entry) => entry.line_ref)).toEqual(['b']);
    expect(transition.failed[0]!.reason).toMatch(/mass/i);
    expect(transition.regressed).toHaveLength(0);
    expect(transition.before.resolved).toBe(0);
    expect(transition.after.resolved).toBe(1);
  });

  it('flags a previously resolved line that becomes actionable as a regression', () => {
    const transition = evaluateCorrectionTransition({
      before: [
        liveRow({ line_ref: 'chicken', original_text: '2 lb chicken thighs', status: 'matched', resolved_grams: 907.2, selected_fdc_id: 2646171 }),
      ],
      after: [
        liveRow({ line_ref: 'chicken', original_text: '2 lb chicken thighs', status: 'needs_match' }),
      ],
      corrections: [],
    });
    expect(transition.regressed).toHaveLength(1);
    expect(transition.regressed[0]!.line_ref).toBe('chicken');
    expect(transition.regressed[0]!.change).toContain('matched');
    expect(transition.regressed[0]!.change).toContain('needs_match');

    const decision = decideCorrectionDispatch(transition);
    expect(decision.ok).toBe(false);
    if (decision.ok !== true) {
      expect(decision.reason).toBe('regression');
      expect(decision.regressed).toHaveLength(1);
    }
  });

  it('refuses the whole operation when any correction fails to verify', () => {
    const transition = evaluateCorrectionTransition({
      before: [liveRow({ line_ref: 'a', status: 'needs_amount' })],
      after: [liveRow({ line_ref: 'a', status: 'needs_amount' })],
      corrections: [{ line_ref: 'a', label: 'a', description: 'x' }],
    });
    const decision = decideCorrectionDispatch(transition);
    expect(decision.ok).toBe(false);
    if (decision.ok !== true) {
      expect(decision.reason).toBe('unverified');
      expect(decision.failed).toHaveLength(1);
    }
  });

  it('accepts a clean transition where every correction verified and nothing regressed', () => {
    const transition = evaluateCorrectionTransition({
      before: [
        liveRow({ line_ref: 'a', status: 'needs_amount' }),
        liveRow({ line_ref: 'keep', status: 'matched', resolved_grams: 100, selected_fdc_id: 1 }),
      ],
      after: [
        liveRow({ line_ref: 'a', status: 'matched', resolved_grams: 132, selected_fdc_id: 2 }),
        liveRow({ line_ref: 'keep', status: 'matched', resolved_grams: 100, selected_fdc_id: 1 }),
      ],
      corrections: [{ line_ref: 'a', label: 'a', description: 'Some food · 1 cup = 132 g' }],
    });
    const decision = decideCorrectionDispatch(transition);
    expect(decision.ok).toBe(true);
    expect(transition.after.resolved).toBe(2);
    // The unchanged line is NOT in the change list; the corrected line IS.
    expect(transition.changes.map((entry) => entry.line_ref)).toEqual(['a']);
    expect(transition.changes[0]!.change).toContain('132 g');
  });

  it('a qualitative line counts as resolved (never regressed by a mass-only pass)', () => {
    const transition = evaluateCorrectionTransition({
      before: [liveRow({ line_ref: 'q', status: 'qualitative' })],
      after: [liveRow({ line_ref: 'q', status: 'qualitative' })],
      corrections: [],
    });
    expect(transition.before.resolved).toBe(1);
    expect(transition.after.resolved).toBe(1);
    expect(transition.regressed).toHaveLength(0);
    expect(decideCorrectionDispatch(transition).ok).toBe(true);
  });
});

// ===========================================================================
// 2. Real-bundle integration: verified state transition with NO regression
// ===========================================================================

const ENCHILADAS_MD = `---
title: Chicken Enchiladas Verdes
servings: 6
---
# Chicken Enchiladas Verdes
## 🥘 Ingredients
- [ ] 2 lb chicken thighs
- [ ] 1 cup sour cream
- [ ] 1 onion
- [ ] 2 jalapeños
- [ ] 6 corn tortillas
- [ ] 1 cup salsa verde
- [ ] 1 cup chicken broth
- [ ] 1 cup shredded Monterey Jack cheese
- [ ] 2 tablespoons vegetable oil
- [ ] 2 tablespoons all-purpose flour
- [ ] 1/4 teaspoon ground cumin
- [ ] 1/2 teaspoon salt
## 🍳 Instructions
1. Cook it.
`;

describe('H-2N — real pipeline state truth (pinned bundle)', () => {
  let session: AdvancedNutritionSession;

  beforeAll(async () => {
    const inputs = {
      files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name: string) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(PINNED, name))),
      })),
    };
    const result = await composeAdvancedNutritionSessionFromBundle(inputs as never);
    if (!result.ok) throw new Error('bundle failed');
    session = result.session as AdvancedNutritionSession;
  }, 300000);

  function fixture() {
    const recipe = parseObsidianRecipeMarkdown(
      ENCHILADAS_MD,
      'Chicken-Enchiladas-Verdes.md',
      'Recipes/Chicken-Enchiladas-Verdes.md',
    );
    const adaptation = adaptRecipe(recipe as never) as never as {
      recipe: { adapted: AdaptedIngredient[]; recipe_key: string };
    };
    const adapted = adaptation.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 6);
    const reviewRows = buildReviewRows(session, adapted) as unknown as Phase4Row[];
    const state: Phase4State = {
      version: '', status: 'ready', recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      baseServings: 6, rows: reviewRows, matches: analysis.matches,
      portions: analysis.portions, countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions, userMasses: {},
      basis: 'entire_recipe', selectedServings: 6,
      preview: null, previewKey: null, failure: null, operationSeq: 0,
    } as never;
    const analyzedByRef = new Map(analysis.rows.map((r) => [r.line_ref, r]));
    const beforeLive = projectLiveRows(state, analyzedByRef, adapted, session, null, analysis.portions, analysis.countPortions);
    return { adapted, analysis, analyzedByRef, state, beforeLive };
  }

  /** The card-equivalent apply: build → reduce → calculate → project after. */
  function runCorrectionPipeline() {
    const f = fixture();
    const built = buildSupportedNutritionCorrections({
      session,
      liveRows: f.beforeLive,
      adapted: f.adapted,
      workingState: f.state,
    });
    let next = f.state;
    for (const correction of built.corrections) {
      for (const action of correction.actions) next = phase4Reducer(next, action);
    }
    const calculated = session.calculate(buildCalculationRequest(f.adapted, next));
    if (!calculated.ok) throw new Error('recalculation failed');
    const afterLive = projectLiveRows(
      next,
      f.analyzedByRef,
      f.adapted,
      session,
      ingredientEvidenceViews(calculated.preview),
      f.analysis.portions,
      f.analysis.countPortions,
    );
    const transition = evaluateCorrectionTransition({
      before: f.beforeLive,
      after: afterLive,
      corrections: built.corrections.map((c) => ({
        line_ref: c.line_ref,
        label: c.label,
        description: c.description,
      })),
    });
    return { f, built, next, calculated, afterLive, transition };
  }

  it('the reported before/after counts are the REAL projections, and every applied correction resolved', () => {
    const { f, built, transition } = runCorrectionPipeline();

    // The reported numbers come from the authoritative projections.
    const beforeSummary = summarizeLiveRows(f.beforeLive);
    expect(transition.before.resolved).toBe(beforeSummary.matched + beforeSummary.qualitative);
    expect(transition.before.total).toBe(12);
    expect(transition.before.resolved).toBeLessThan(12);

    // Corrections were built and every one VERIFIED in the post projection.
    expect(built.corrections.length).toBeGreaterThan(0);
    expect(transition.verified).toHaveLength(built.corrections.length);
    expect(transition.failed).toHaveLength(0);
    for (const applied of transition.verified) {
      expect(applied.after_grams).toBeGreaterThan(0);
    }
    // The after count genuinely improved BY the verified corrections.
    expect(transition.after.resolved).toBe(transition.before.resolved + transition.verified.length);
    expect(decideCorrectionDispatch(transition).ok).toBe(true);
  }, 300000);

  it('NEVER regresses a previously resolved line: matched rows keep their exact fdc and grams', () => {
    const { f, transition } = runCorrectionPipeline();
    expect(transition.regressed).toHaveLength(0);
    const beforeResolved = f.beforeLive.filter((row) => row.status === 'matched');
    expect(beforeResolved.length).toBeGreaterThan(0);
    for (const before of beforeResolved) {
      const after = transition.changes.find((entry) => entry.line_ref === before.line_ref);
      // A resolved line may only appear in `changes` if it IMPROVED (it never was
      // unresolved) — and its match identity/mass must be untouched.
      if (after !== undefined) {
        expect(after.after_status).toBe('matched');
        expect(after.before_grams).toBe(after.after_grams);
      }
    }
  }, 300000);

  it('every correction comes from the authenticated review candidate set (source authenticity)', () => {
    const { built } = runCorrectionPipeline();
    expect(built.corrections.length).toBeGreaterThan(0);
    for (const correction of built.corrections) {
      const matchAction = correction.actions.find((action) => action.type === 'select_match');
      if (matchAction === undefined) continue;
      const choice = (matchAction as unknown as { choice: { fdc_id?: number } }).choice;
      expect(typeof choice.fdc_id).toBe('number');
      // The FDC id must be a genuine candidate of that line's authenticated review.
      const review = session.reviewIngredient({ name: correction.label });
      if (review.outcome === 'review_required' || review.outcome === 'matched_exact') {
        expect(review.candidates.some((candidate) => candidate.fdc_id === choice.fdc_id)).toBe(true);
      }
    }
  }, 300000);

  it('does not touch the Vault save path (review Apply and recipe Save stay separate)', async () => {
    const f = fixture();
    let saveCalls = 0;
    // The corrections pipeline itself holds no save capability.
    const built = buildSupportedNutritionCorrections({
      session,
      liveRows: f.beforeLive,
      adapted: f.adapted,
      workingState: f.state,
    });
    expect(built.corrections.length).toBeGreaterThan(0);
    expect(saveCalls).toBe(0);

    // And the tool observation reports the review as UNSAVED.
    const obs = await executeShisoTool(
      { tool: 'apply_nutrition_corrections' },
      {
        session,
        recipe: { title: 'T', servings: 6, ingredients: [], instructions: [] },
        nutrition: { rows: f.beforeLive, summary: null, unsaved: false },
        applyNutritionCorrections: async () => ({
          ok: true,
          applied: [{ line_ref: 'a', label: 'a', description: 'x · 1 cup = 100 g' }],
          failed: [],
          regressed: [],
          changes: [],
          unresolved: [],
          summary: 'Verified 1 correction(s).',
          before_resolved_count: 5,
          resolved_count: 6,
          total_count: 12,
          recalculation: 'partial',
          working_unsaved: true,
        }),
        saveWorkingRecipe: async () => {
          saveCalls += 1;
          return { ok: true, saved: true, message: 'Saved.' };
        },
      } as ShisoToolContext,
    );
    expect(saveCalls).toBe(0);
    expect(obs.ok).toBe(true);
    if (obs.ok) expect(obs.data['working_unsaved']).toBe(true);
  }, 300000);
});

// ===========================================================================
// 3. The tool observation forces truthful reporting
// ===========================================================================

describe('H-2N — tool observation truthfulness', () => {
  const baseCtx = (outcome: Record<string, unknown>): ShisoToolContext => ({
    session: {} as never,
    recipe: { title: 'T', servings: 2, ingredients: [], instructions: [] },
    nutrition: { rows: [], summary: null, unsaved: false },
    applyNutritionCorrections: async () => outcome as never,
  });

  it('a refused operation reports applied_count 0 and forbids claiming corrections', async () => {
    const obs = await executeShisoTool(
      { tool: 'apply_nutrition_corrections' },
      baseCtx({
        ok: false,
        applied: [],
        failed: [{ line_ref: 'a', label: '1 onion', reason: 'The correction did not produce a usable mass.' }],
        regressed: [{ line_ref: 'chicken', label: '2 lb chicken thighs', reason: 'would change matched → needs_match (previously resolved)' }],
        changes: [],
        unresolved: [],
        summary: 'No correction was applied: the operation would have broken 1 previously resolved ingredient. The working review is unchanged.',
        before_resolved_count: 5,
        resolved_count: 5,
        total_count: 12,
        recalculation: 'absent',
        working_unsaved: false,
      }),
    );
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['applied_count']).toBe(0);
    expect((obs.data['regressed'] as unknown[]).length).toBe(1);
    expect(String(obs.data['honesty_note'])).toMatch(/nothing was corrected/i);
    expect(String(obs.summary)).toMatch(/No correction was applied/);
  });

  it('a verified operation reports the exact before→after counts and only verified lines as applied', async () => {
    const obs = await executeShisoTool(
      { tool: 'apply_nutrition_corrections' },
      baseCtx({
        ok: true,
        applied: [{ line_ref: 'a', label: '1 cup chicken broth', description: 'Soup, chicken broth · 1 cup = 249 g' }],
        failed: [],
        regressed: [],
        changes: [
          { line_ref: 'a', label: '1 cup chicken broth', change: 'review_suggested → matched (249 g)', before_status: 'review_suggested', after_status: 'matched' },
        ],
        unresolved: [{ line_ref: 'b', label: '1 onion', reason: 'No authenticated portion could resolve this ingredient.' }],
        summary: 'Verified 1 correction(s) against the recalculated review: resolved 5 → 6 of 12; 6 still unresolved.',
        before_resolved_count: 5,
        resolved_count: 6,
        total_count: 12,
        recalculation: 'partial',
        working_unsaved: true,
      }),
    );
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.data['applied_count']).toBe(1);
    expect(obs.data['before_resolved_count']).toBe(5);
    expect(obs.data['resolved_count']).toBe(6);
    expect(String(obs.data['honesty_note'])).toMatch(/authoritative recalculation/i);
    expect(String(obs.data['honesty_note'])).toMatch(/PARTIAL/i);
  });
});
