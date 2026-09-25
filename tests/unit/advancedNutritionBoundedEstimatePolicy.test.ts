/**
 * The Kitchen Codex — Advanced Nutrition Phase 7 FLAG F-4: bounded-estimate
 * authority policy pinned with a CONTROLLED SYNTHETIC registry.
 *
 * The production verified registry contains ZERO `bounded_estimate` records, so
 * this suite mocks the Phase 5 verified loader with one synthetic estimate
 * record (never production data) and proves the invariant:
 *
 *   AI hints cannot promote a bounded estimate into stronger or more automatic
 *   authority than the ordinary Phase 6 household path permits.
 *
 * The analyzer/ordinary Phase 6 path, the direct core builder, and the Phase 7
 * AI path all share the ONE canonical builder/authority boundary, so for the
 * same authenticated inputs they must agree on the estimate authority class and
 * on the `automatic` flag (which is derived from the authenticated food/match
 * authority, never forced by AI). An estimate is always visibly an estimate;
 * nothing may present it as an exact `usda_derived` conversion, and AI wording
 * may never make it more automatic than the working state's own authority.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../src/core/nutritionV2/household/initialData', () => {
  const record = Object.freeze({
    usda_fdc_ids: Object.freeze([990001]),
    food_key: 'synthetic eggplants',
    household_unit: 'item',
    size_class: 'medium',
    requires_state: null,
    grams_per_unit: 100,
    authority_class: 'bounded_estimate',
    record_digest: 'a'.repeat(64),
  });
  return {
    loadHouseholdInitialRegistry: () => ({
      ok: true,
      registry: Object.freeze({ records: () => Object.freeze([record]) }),
      dataset: Object.freeze({
        registry_release: 'household_estimate_synthetic_v1',
        registry_digest: 'b'.repeat(64),
        provenance_digest: 'c'.repeat(64),
        aggregate_release_digest: 'd'.repeat(64),
      }),
    }),
  };
});

import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { buildHouseholdPortionChoice } from '../../src/core/nutritionV2/phase4/householdPortion';
import { resolveHouseholdsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiHouseholdResolve';
import {
  INITIAL_PHASE4_STATE,
  adaptRecipe,
  analyzeRecipe,
  buildCalculationRequest,
  buildReviewRows,
  householdPortionEvidenceLabel,
  ingredientEvidenceViews,
  phase4Reducer,
  phase4SessionIdentity,
  projectLiveRows,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

const SPECS = [
  {
    fdcId: 990001,
    dataType: 'sr_legacy' as const,
    description: 'Synthetic eggplants',
    proteinAmount: 1,
    portions: [],
  },
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const result = createAdvancedNutritionSession(manifest, records);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
});

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredient(line);
  if (!parsed.ok) return { original: line };
  const p = parsed.parsed;
  return {
    original: line,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

function recipe(lines: ReadonlyArray<string>, id = 'estimate'): ObsidianRecipe {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `Recipes/${id}.md`,
    rawMarkdown: '',
    title: `Recipe ${id}`,
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: lines.map((line) => structured(line)) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

interface Flow {
  readonly recipe: ObsidianRecipe;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly analysis: ReturnType<typeof analyzeRecipe>;
  readonly rows: ReturnType<typeof buildReviewRows>;
  readonly state: Phase4State;
  readonly lineRef: string;
}

function flow(line: string): Flow {
  const target = recipe([line]);
  const adaptation = adaptRecipe(target);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 2);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: 2,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  });
  return { recipe: target, adapted, analysis, rows, state, lineRef: adapted[0].line_ref };
}

function liveFor(f: Flow, state: Phase4State) {
  const analysis = analyzeRecipe(session, f.adapted, 2);
  return projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    f.adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  );
}

describe('phase 7 F-4 — bounded-estimate authority policy (synthetic registry)', () => {
  it('the ordinary Phase 6 analyzer resolves the estimate only as an ESTIMATE', () => {
    const f = flow('2 medium synthetic eggplants');
    const choice = f.analysis.householdPortions[f.lineRef];
    expect(choice).toBeDefined();
    if (!choice) return;
    expect(choice.authority_class).toBe('bounded_estimate');
    expect(choice.record_key).toBe('synthetic eggplants|item|medium|null');
    expect(choice.resolved_grams).toBe(200);
    // `automatic` is the analyzer's own authenticated authority flag, unchanged.
    expect(choice.automatic).toBe(f.analysis.matches[f.lineRef]?.automatic === true);

    const live = liveFor(f, f.state).find((row) => row.line_ref === f.lineRef);
    expect(live?.status).toBe('matched');
    expect(live?.mass_source).toBe('household_portion');
    expect(live?.resolved_grams).toBe(200);
    expect(live?.household_authority_class).toBe('bounded_estimate');

    const calculated = session.calculate(buildCalculationRequest(f.adapted, f.state));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.household_authority_class).toBe('bounded_estimate');
    const view = ingredientEvidenceViews(calculated.preview)[0];
    expect(householdPortionEvidenceLabel(view)).toContain('estimate');
    expect(householdPortionEvidenceLabel(view)).not.toMatch(/USDA portion|user-entered|AI/i);
  });

  it('an AI hint on a user-confirmed food cannot make the estimate automatic or exact', () => {
    const f = flow('2 synthetic eggplants');
    // The AI request requires an authenticated food identity. The working state
    // holds the food identity as a USER choice (never analyzer-automatic).
    const search = session.searchFoods('990001', 5);
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const hit = search.results.find((result) => result.fdc_id === 990001);
    expect(hit).toBeDefined();
    if (!hit) return;
    const userState = phase4Reducer(f.state, {
      type: 'select_match',
      lineRef: f.lineRef,
      choice: {
        kind: 'manual',
        fdc_id: 990001,
        review_digest: f.rows[0].review_digest ?? '',
        record_digest: hit.record_digest,
        catalog_digest: session.metadata().catalog_digest,
        description: hit.description,
      },
    });
    const liveBefore = liveFor(f, userState);
    expect(liveBefore[0].food_authority).toBe('user_confirmed');
    expect(liveBefore[0].status).toBe('needs_amount');

    const outcome = resolveHouseholdsFromAiSuggestions({
      session,
      rows: f.rows,
      adapted: f.adapted,
      liveRows: liveBefore,
      state: userState,
      suggestions: [
        {
          line_ref: f.lineRef,
          interpreted_food_name: 'Synthetic eggplants',
          suggested_usda_queries: [],
          household_size_hint: 'medium',
        },
      ],
    });
    expect(outcome.resolved).toHaveLength(1);
    const choice = outcome.resolved[0].choice;
    // AI wording is display-only: the estimate stays an estimate, and the
    // `automatic` flag stays exactly the user-confirmed authority's flag (false)
    // — AI NEVER promotes a bounded estimate to automatic/exact authority.
    expect(choice.authority_class).toBe('bounded_estimate');
    expect(choice.automatic).toBe(false);
    expect(choice.aiAssisted).toBe(true);
    expect(outcome.resolved[0].resolved_grams).toBe(200);

    const applied = phase4Reducer(userState, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice,
    });
    const calculated = session.calculate(buildCalculationRequest(f.adapted, applied));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.household_authority_class).toBe('bounded_estimate');
    expect(evidence.resolved_grams).toBe(200);
    const live = liveFor(f, applied)[0];
    expect(live.mass_source).toBe('household_portion');
    expect(live.household_authority_class).toBe('bounded_estimate');
    expect(live.household_ai_assisted).toBe(true);
  });

  it('the core builder and the AI path agree on estimate authority for identical inputs', () => {
    const f = flow('2 synthetic eggplants');
    const search = session.searchFoods('990001', 5);
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const hit = search.results.find((result) => result.fdc_id === 990001);
    if (!hit) throw new Error('missing record');
    const match = { kind: 'candidate' as const, fdc_id: 990001, review_digest: f.rows[0].review_digest ?? '' };
    const userState = phase4Reducer(f.state, { type: 'select_match', lineRef: f.lineRef, choice: match });
    const liveBefore = liveFor(f, userState);

    const built = buildHouseholdPortionChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      review: f.rows[0].outcome === 'review_required' ? f.rows[0].review : undefined,
      selection: { kind: 'candidate', fdc_id: 990001, review_digest: f.rows[0].review_digest ?? '' },
      fdcId: 990001,
      householdRequirementHint: { unit: null, size: 'medium', state: null },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const outcome = resolveHouseholdsFromAiSuggestions({
      session,
      rows: f.rows,
      adapted: f.adapted,
      liveRows: liveBefore,
      state: userState,
      suggestions: [
        {
          line_ref: f.lineRef,
          interpreted_food_name: 'Synthetic eggplants',
          suggested_usda_queries: [],
          household_size_hint: 'medium',
        },
      ],
    });
    expect(outcome.resolved).toHaveLength(1);
    const aiChoice = outcome.resolved[0].choice;
    expect(aiChoice.authority_class).toBe(built.choice.authority_class);
    expect(aiChoice.automatic).toBe(built.choice.automatic);
    expect(aiChoice.resolved_grams).toBe(built.choice.resolved_grams);
    expect(aiChoice.record_key).toBe(built.choice.record_key);
  });
});
