/**
 * The Kitchen Codex — AN-ARCH-1 AI orchestration integration.
 *
 * Proves the ONE production sequence the Generate action now authorizes:
 *
 *   authored recipe -> deterministic baseline -> actionable exception set
 *   -> ONE whole-recipe AI interpretation request (provider mocked)
 *   -> browser re-sanitization -> REAL pinned USDA catalog + confidence contract
 *   -> authenticated source-portion mass -> deterministic calculation
 *   -> visible uncertainty for the one genuinely unproven ingredient.
 *
 * Only the provider transport is mocked. The USDA bundle, matcher, portion
 * authentication and calculator are the real production implementations.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import type { NetworkAdapter, NetworkResponse } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import { resolveUnresolvedRowsWithAi } from '../../src/application/nutritionAiResolve';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { decodeCodexNutrition } from '../../src/core/nutritionV2/validate';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import {
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
} from '../../src/utils/markdownParser';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import {
  liveExceptionKind,
  projectLiveRows,
} from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import {
  resolveNutritionCapabilities,
} from '../../src/core/nutritionV2/nutritionCapabilities';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AiResolutionIssueKind } from '../../src/core/nutritionV2/aiResolution';
import type {
  AdvancedNutritionSession,
  Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

const AI_ADVANCED_CAPABILITIES = resolveNutritionCapabilities({
  aiConfigured: true,
  aiReachable: true,
});

const LINES: ReadonlyArray<string> = [
  '2 tbsp unsalted butter',
  '1 cup half and half',
  '1 cup passata',
];

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

function cardRecipe(): ObsidianRecipe {
  return {
    id: 'an-arch-1',
    fileName: 'an-arch-1.md',
    filePath: 'Recipes/an-arch-1.md',
    rawMarkdown: '',
    title: 'Creamy Tomato Supper',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: LINES.map(structuredLine) as never,
    instructions: [
      { stepNumber: 1, text: 'Melt the butter in a wide pan.' },
      { stepNumber: 2, text: 'Stir in the passata and simmer.' },
      { stepNumber: 3, text: 'Finish with half and half off the heat.' },
    ],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as unknown as ObsidianRecipe;
}

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const result = await composeAdvancedNutritionSessionFromBundle({
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  });
  if (!result.ok) throw new Error('bundle failed');
  session = result.session;
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
}, 240000);

describe('AN-ARCH-1 — one Generate operation: deterministic baseline + whole-recipe AI interpretation', () => {
  it('resolves the deterministic line, uses AI to disambiguate the semantic line, and preserves the genuinely unproven line', async () => {
    const recipe = cardRecipe();
    const adaptation = adaptRecipe(recipe);
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 4);
    const rows = buildReviewRows(session, adapted);
    const state = {
      version: '',
      status: 'ready',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: null,
      baseServings: 4,
      rows,
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions,
      userMasses: {},
      basis: 'entire_recipe',
      selectedServings: 4,
      preview: analysis.preview ?? null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    } as Phase4State;
    const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
    const liveRows = projectLiveRows(
      state,
      analyzedByRef,
      adapted,
      session,
      analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
      analysis.portions,
      analysis.countPortions
    );

    // 1. Deterministic baseline: butter is already resolved. The semantic lines
    //    are NOT silently guessed as correct.
    const byText = (text: string) => {
      const found = liveRows.find((row) => row.original_text === text);
      if (!found) throw new Error(`missing live row: ${text}`);
      return found;
    };
    expect(byText('2 tbsp unsalted butter').status).toBe('matched');
    expect(byText('1 cup half and half').status).not.toBe('matched');
    expect(byText('1 cup passata').status).toBe('needs_match');

    // 2. The trusted issue classification the Generate orchestration sends.
    const issueKinds: Record<string, AiResolutionIssueKind> = {};
    for (const row of liveRows) {
      const kind = liveExceptionKind(row.status);
      if (kind !== undefined) issueKinds[row.line_ref] = kind;
    }
    const halfRef = byText('1 cup half and half').line_ref;
    const passataRef = byText('1 cup passata').line_ref;
    expect(issueKinds[halfRef]).toBeDefined();
    expect(issueKinds[passataRef]).toBe('needs_match');

    // 3. ONE whole-recipe request. Only the provider transport is mocked; the
    //    response is the same advisory search wording the real route returns.
    const requests: Array<Record<string, unknown>> = [];
    const network = {
      request: async () => ({ status: 500, ok: false, data: undefined }) as NetworkResponse,
      get: async () => ({ status: 500, ok: false, data: undefined }) as NetworkResponse,
      post: async (path: string, body: unknown) => {
        if (path !== '/api/nutrition/resolve-whole-recipe') {
          return { status: 404, ok: false, data: undefined } as NetworkResponse;
        }
        requests.push(body as Record<string, unknown>);
        return {
          status: 200,
          ok: true,
          data: {
            ok: true,
            contract_version: 'nutrition_ai_authenticated_advisory_suggestions_v1',
            suggestions: [
              {
                line_ref: halfRef,
                interpreted_food_name: 'Cream, fluid, half and half',
                suggested_usda_queries: ['cream fluid half and half'],
                confidence: 'high',
              },
              {
                line_ref: passataRef,
                interpreted_food_name: 'Tomato puree',
                suggested_usda_queries: ['tomato puree'],
                confidence: 'medium',
              },
            ],
            withheld: [],
          },
        } as NetworkResponse;
      },
    } as unknown as NetworkAdapter;

    const ai = await resolveUnresolvedRowsWithAi({
      network,
      session,
      rows,
      adapted,
      issueKinds,
      liveRows,
      state,
      capabilities: AI_ADVANCED_CAPABILITIES,
      liveCanonicalInterpretation: true,
      acceptValidatedSemanticMatches: true,
      wholeRecipe: {
        recipe: { ingredients: LINES.map((name) => ({ name })) },
        instructions: cardRecipe().instructions.map((step) => ({ text: step.text })),
        targets: liveRows
          .filter((row) => issueKinds[row.line_ref] !== undefined)
          .map((row) => ({ line_ref: row.line_ref })),
      },
    });

    expect(ai.ok).toBe(true);
    expect(requests).toHaveLength(1);
    // The request carries the WHOLE recipe and instructions, not just the
    // exception rows.
    const sent = requests[0] as {
      recipe: { ingredients: Array<{ name: string }> };
      instructions: Array<{ text: string }>;
      targets: Array<{ line_ref: string }>;
    };
    expect(sent.recipe.ingredients.map((entry) => entry.name)).toEqual([...LINES]);
    expect(sent.instructions.length).toBe(3);
    expect(sent.targets.map((entry) => entry.line_ref)).toEqual(
      expect.arrayContaining([halfRef, passataRef])
    );

    const halfCandidate = ai.outcome.candidates.find((entry) => entry.line_ref === halfRef);
    const passataCandidate = ai.outcome.candidates.find((entry) => entry.line_ref === passataRef);
    expect(halfCandidate?.auto).toBe(true);
    expect(halfCandidate?.fdc_id).toBe(171255);
    expect(halfCandidate?.description).toMatch(/Cream, fluid, half and half/);
    // A genuinely novel food with no deterministic identity remains an explicit
    // user choice or an honest unresolved line — AI may interpret it, but it
    // must never auto-spend authority or force a candidate.
    if (passataCandidate) {
      expect(passataCandidate.auto).toBe(false);
    } else {
      expect(ai.outcome.unresolved).toContain(passataRef);
    }

    // 4. Merge ONLY the deterministic-accepted AI candidate, exactly like the
    //    card's existing working-state path.
    expect(halfCandidate?.portion).toBeDefined();
    const merged = {
      ...state,
      matches: {
        ...state.matches,
        ...(halfCandidate ? { [halfRef]: halfCandidate.choice } : {}),
      },
      portions: {
        ...state.portions,
        ...(halfCandidate?.portion ? { [halfRef]: halfCandidate.portion } : {}),
      },
    } as Phase4State;
    const calculated = session.calculate(buildCalculationRequest(adapted, merged));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;

    const halfEvidence = calculated.preview.ingredients.find((entry) => entry.line_ref === halfRef);
    expect(halfEvidence?.fdc_id).toBe(171255);
    expect(halfEvidence?.resolved_grams).toBeCloseTo(242, 6);
    expect(halfEvidence?.mass_source).toBe('source_portion');
    expect(halfEvidence?.match_status).toBe('auto_confirmed');
    expect(halfEvidence?.user_confirmed).toBe(false);

    const passataEvidence = calculated.preview.ingredients.find(
      (entry) => entry.line_ref === passataRef
    );
    expect(passataEvidence?.outcome).not.toBe('calculated');
    expect(passataEvidence?.resolved_grams).toBeUndefined();

    // Deterministic totals include the authenticated contributions and never
    // invent a passata value. Per-serving is the same total divided by 4.
    const totalCalories = calculated.preview.totals.calories;
    expect(totalCalories?.amount).toBeGreaterThan(0);
    expect(totalCalories?.amount / calculated.preview.servings).toBeGreaterThan(0);
    expect(calculated.preview.application_authorized).toBe(false);
    // This is still a review result; Apply is the user's explicit decision.
    expect(calculated.preview.unresolved.some((entry) => entry.line_ref === passataRef)).toBe(true);

    // 5. EXPLICIT APPLY. Nothing above wrote anything. The user's Apply now
    //    persists the reviewed result through the existing Phase 5B path; the
    //    writer is in-memory and the reopened Markdown proves the saved outcome.
    const persistedState = {
      ...merged,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      status: 'preview_current',
      preview: calculated.preview,
      previewKey: adaptation.recipe.recipe_key,
      selectedServings: 4,
    } as Phase4State;
    const writes: ObsidianRecipe[] = [];
    const applied = await applyAdvancedNutrition({
      session,
      recipe,
      state: persistedState,
      expectedMode: 'create',
      write: async (updated: ObsidianRecipe) => {
        writes.push(updated);
      },
    });
    expect(applied.ok).toBe(true);
    expect(writes).toHaveLength(1);

    const markdown = serializeRecipeToObsidianMarkdown(writes[0]);
    const reopened = parseObsidianRecipeMarkdown(markdown, 'an-arch-1.md', 'Recipes/an-arch-1.md');
    const decoded = decodeCodexNutrition(reopened.codexNutrition);
    // No estimate/range/household/count evidence is needed here, so the existing
    // Apply path may legitimately choose schema v1. What matters is that the
    // persisted block is canonical, reproducible and unchanged on reopen.
    expect(decoded.kind).not.toBe('opaque');
    expect(decoded.kind).not.toBe('malformed');
    expect(decoded.kind).not.toBe('none');
    if (decoded.kind === 'opaque' || decoded.kind === 'malformed' || decoded.kind === 'none') return;
    const saved = decoded.value;
    expect(saved.basis).toBe('total');
    expect(saved.servings).toBe(4);
    expect(saved.status).toBe('partial');

    const savedHalf = saved.ingredients.find((entry) => entry.line_ref === halfRef);
    expect(savedHalf?.source_food_id).toBe('171255');
    expect(savedHalf?.amount?.value).toBe(242);
    expect(saved.unresolved.some((entry) => entry.line_ref === passataRef)).toBe(true);
    expect(saved.nutrients.calories?.amount).toBeCloseTo(totalCalories?.amount ?? -1, 6);
  }, 120000);
});
