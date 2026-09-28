/**
 * The Kitchen Codex — AI-2C reachability proof (Slice E §3).
 *
 * Proves the CURRENT production invariant with the REAL deterministic analyzer,
 * the REAL reducer and the REAL Phase-4 review machinery (no source-string
 * inspection):
 *
 *   A. A row with strict deterministic automatic authority is ALREADY resolved by
 *      the analyzer: it is not an actionable exception, the analyzer has spent
 *      the authority and recorded an explicit working choice, and the bridge
 *      therefore refuses it as pre-existing working state.
 *
 *   B. A row that IS an actionable exception has NO strict automatic authority,
 *      so AI proposing a candidate cannot manufacture an `automatic` result: the
 *      canonical classifier yields `offer` and the bridge yields an OFFER.
 *
 * This is an architectural consequence of the existing analyzer composition —
 * documented as such, not as a defect. The strict-automatic acceptance branch
 * remains fully guarded, tested defense-in-depth for future compatible callers.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { projectLiveRows, liveExceptionKind } from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { selectAutomaticMatch, bestEffortDefaultCandidates } from '../../src/core/nutritionV2/matching/confidence';
import { deterministicAcceptanceView } from '../../src/core/nutritionV2/phase4/deterministicAcceptanceView';
import { reconcileAiAdvancedCandidatePlan } from '../../src/core/nutritionV2/phase4/aiPlanReconcile';
import { buildAiAdvancedPlanLineSource } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import { buildAiAdvancedPlanRequestContext } from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';
import type { AdvancedNutritionSession, Phase4State } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';

// Two families, deliberately different:
//   2001/2002 share an IDENTICAL description  -> strict deterministic authority
//   5030/5031 differ by form token             -> no automatic authority at all
const SPECS = [
  {
    fdcId: 2001,
    dataType: 'sr_legacy' as const,
    description: 'Sugar, granulated',
    proteinAmount: 0,
    portions: [{ amount: 1, measure: 'tsp', gram_weight: 4.2, sequence: 1 }],
  },
  {
    fdcId: 2002,
    dataType: 'sr_legacy' as const,
    description: 'Sugar, granulated',
    proteinAmount: 0,
    portions: [{ amount: 1, measure: 'tsp', gram_weight: 4.0, sequence: 1 }],
  },
  {
    fdcId: 5030,
    dataType: 'sr_legacy' as const,
    description: 'Berries, dried',
    proteinAmount: 2,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 100, sequence: 1 }],
  },
  {
    fdcId: 5031,
    dataType: 'sr_legacy' as const,
    description: 'Berries, frozen',
    proteinAmount: 1,
    portions: [{ amount: 1, measure: 'cup', gram_weight: 120, sequence: 1 }],
  },
];

let session: AdvancedNutritionSession;

beforeAll(() => {
  const { manifest, records } = buildMatchingBundle(SPECS);
  const created = createAdvancedNutritionSession(manifest, records);
  if (!created.ok) throw new Error('session failed');
  session = created.session;
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

function recipe(lines: ReadonlyArray<string>): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Reachability',
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

interface LiveLine {
  readonly line_ref: string;
  readonly original: string;
  readonly exception: string | undefined;
  readonly status: string;
  readonly state: Phase4State;
  readonly review: unknown;
  readonly selected_fdc_id: number | undefined;
}

/** The REAL production pipeline: parse -> adapt -> analyze -> reduce -> project. */
function liveLine(sessionIn: AdvancedNutritionSession, line: string): LiveLine {
  const recipeValue = recipe([line]);
  const adaptation = adaptRecipe(recipeValue);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(sessionIn, adapted, 1);
  const analysisRow = analysis.rows[0];
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(sessionIn.metadata()),
    rows: buildReviewRows(sessionIn, adapted),
    baseServings: 1,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);
  const calculated = sessionIn.calculate(buildCalculationRequest(adapted, state));
  if (!calculated.ok) throw new Error('calculate failed');
  const live = projectLiveRows(
    state,
    new Map(analysis.rows.map((analysisRowEntry) => [analysisRowEntry.line_ref, analysisRowEntry])),
    adapted,
    sessionIn,
    ingredientEvidenceViews(calculated.preview),
    analysis.portions,
    analysis.countPortions
  )[0];
  return {
    line_ref: live.line_ref,
    original: live.original_text,
    exception: liveExceptionKind(live.status),
    status: live.status,
    state,
    review: sessionIn.reviewIngredient({ name: structured(line)['name'] as string }),
    selected_fdc_id: analysisRow?.selected_fdc_id,
  };
}

function planWire(lineRef: string, candidateRef: string, requestId: string): unknown {
  return {
    plan_version: AI_ADVANCED_PLAN_VERSION,
    plans: [
      {
        line_ref: lineRef,
        candidate_ref: candidateRef,
        measure_kind: 'unknown',
        review_required: false,
        ambiguity_reasons: [],
      },
    ],
  };
}

describe('AI-2C reachability — the strict-automatic branch is dormant in production', () => {
  it('A. a strict deterministic automatic row is already resolved and is NOT an actionable exception', () => {
    const sugar = liveLine(session, '1 cup sugar');
    const review = sugar.review as Record<string, unknown>;

    // The review DOES grant strict automatic authority...
    const strict = selectAutomaticMatch(review as never);
    expect(strict).toBeDefined();
    expect(deterministicAcceptanceView(review)).toMatchObject({
      strict_automatic_fdc_id: strict?.fdc_id,
    });

    // ...and the analyzer has ALREADY spent it: the row is resolved, not an
    // exception that would ever reach AI-2C.
    expect(sugar.status).toBe('matched');
    expect(sugar.exception).toBeUndefined();
    expect(sugar.selected_fdc_id).toBe(strict?.fdc_id);

    // The analyzer recorded an explicit working choice for the line.
    const recorded = sugar.state.matches[sugar.line_ref];
    expect(recorded).toBeDefined();
    expect(recorded?.kind).toBe('candidate');
  });

  it('A2. even if such a row were fed to the bridge, its recorded authority blocks acceptance', () => {
    const sugar = liveLine(session, '1 cup sugar');
    const source = buildAiAdvancedPlanLineSource({ lineRef: sugar.line_ref, review: sugar.review });
    if (source.ok !== true) throw new Error(`source failed: ${source.code}`);
    const built = buildAiAdvancedPlanRequestContext({
      requestId: 'reach-a2',
      lines: [source.source],
    });
    if (built.ok !== true) throw new Error(`context failed: ${built.code}`);
    const ref = source.source.candidate_set.views[0].candidate_ref;

    const withAnalyzerState = reconcileAiAdvancedCandidatePlan({
      plan: planWire(sugar.line_ref, ref, 'reach-a2'),
      responseRequestId: 'reach-a2',
      requestContext: built.context,
      reviews: new Map([[sugar.line_ref, sugar.review]]),
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: [sugar.line_ref],
      workingState: { matches: sugar.state.matches },
    });

    expect(withAnalyzerState.ok).toBe(true);
    if (withAnalyzerState.ok !== true) return;
    // `automatic` may be classified, but the working choice the analyzer already
    // recorded is USER/WORKING AUTHORITY: the bridge dispatches nothing.
    expect(withAnalyzerState.reconciliation.accepted).toHaveLength(0);
    expect(
      withAnalyzerState.reconciliation.unchanged.includes(sugar.line_ref) ||
        withAnalyzerState.reconciliation.conflicts.some((c) => c.line_ref === sugar.line_ref)
    ).toBe(true);
  });

  it('B. an actionable exception has NO strict automatic authority whatsoever', () => {
    const berries = liveLine(session, '1 cup berries');
    const review = berries.review as Record<string, unknown>;

    // It IS an actionable exception the AI orchestration would be asked about.
    expect(berries.exception).toBeDefined();
    expect(['needs_match', 'review_suggested']).toContain(berries.status);

    // ...and the deterministic contract grants it NO automatic authority, in
    // either the strict or the safe best-effort form.
    expect(selectAutomaticMatch(review as never)).toBeUndefined();
    expect(bestEffortDefaultCandidates(review as never)).toHaveLength(0);
    const view = deterministicAcceptanceView(review) as Record<string, unknown>;
    expect(view['strict_automatic_fdc_id']).toBeUndefined();
    expect(view['best_effort_eligible_fdc_ids'] ?? []).toHaveLength(0);
    expect(berries.state.matches[berries.line_ref]).toBeUndefined();
  });

  it('B2. an AI proposal on an exception line produces an OFFER, never an acceptance', () => {
    const berries = liveLine(session, '1 cup berries');
    const source = buildAiAdvancedPlanLineSource({ lineRef: berries.line_ref, review: berries.review });
    if (source.ok !== true) throw new Error(`source failed: ${source.code}`);
    const built = buildAiAdvancedPlanRequestContext({
      requestId: 'reach-b2',
      lines: [source.source],
    });
    if (built.ok !== true) throw new Error(`context failed: ${built.code}`);
    const ref = source.source.candidate_set.views[0].candidate_ref;
    const localId = source.source.candidate_set.resolve(ref)?.fdc_id;

    const result = reconcileAiAdvancedCandidatePlan({
      plan: planWire(berries.line_ref, ref, 'reach-b2'),
      responseRequestId: 'reach-b2',
      requestContext: built.context,
      reviews: new Map([[berries.line_ref, berries.review]]),
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: [berries.line_ref],
      workingState: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    // The AI's proposed candidate is locally authenticated...
    expect(result.reconciliation.offers).toHaveLength(1);
    expect(result.reconciliation.offers[0].fdc_id).toBe(localId);
    // ...and it is ONLY an offer: no acceptance, no automatic classification.
    expect(result.reconciliation.accepted).toHaveLength(0);
    expect(result.reconciliation.classification.automatic_count).toBe(0);
    expect(result.reconciliation.classification.offer_count).toBe(1);
  });
});
