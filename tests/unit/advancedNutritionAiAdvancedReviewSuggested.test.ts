/**
 * AI-1 — REVIEW_SUGGESTED SEMANTIC INTERPRETATION (architect decision).
 *
 * The canonical semantic interpreter must support every TRUSTED actionable issue
 * kind, including `review_suggested` (a row where the deterministic matcher
 * found only a BELOW-THRESHOLD candidate). Widening the canonical scope must not
 * spend authority the deterministic core never granted:
 *
 *   - a below-threshold row IS eligible for canonical semantic interpretation;
 *   - the semantic reading is advisory and preserves source-defining wording;
 *   - an AI-driven automatic acceptance may NEVER upgrade that row (no
 *     below-threshold "laundering"); it stays an explicit user decision;
 *   - source modifiers/state/form/variety still outrank provider wording;
 *   - the legacy v4 path keeps its own scope and behavior exactly.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import {
  projectLiveRows,
  liveExceptionKind,
  actionableExceptionRows,
  type LiveRowState,
} from '../../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { aiResolutionEligibleRows } from '../../src/core/nutritionV2/phase4/aiResolve';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import {
  adaptAiAdvancedInterpretationsForResolution,
  withholdNonDeterministicAdaptations,
} from '../../src/core/nutritionV2/aiAdvanced';
import { buildAuthoritativeAmountObservations } from '../../src/core/nutritionV2/aiAdvancedSource';
import { resolveNutritionCapabilities } from '../../src/core/nutritionV2/nutritionCapabilities';
import type { AdvancedNutritionSession, Phase4Row } from '../../src/core/nutritionV2/phase4';
import type { AiResolutionIssueKind } from '../../src/core/nutritionV2/aiResolution';
import type { ObsidianRecipe } from '../../src/types';
import type { AdaptedIngredient } from '../../src/core/nutritionV2/phase4/types';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

vi.mock('../../src/application/aiSelection', () => ({
  buildAiSelectionRequestOptions: async () => ({}),
}));

import {
  AI_RESOLUTION_UNAVAILABLE_MESSAGE,
  NUTRITION_INTERPRET_ENDPOINT,
  requestAiIngredientResolution,
  resolveUnresolvedRowsWithAi,
  withholdBelowThresholdAutoAcceptance,
} from '../../src/application/nutritionAiResolve';

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  { fdcId: 8003, dataType: 'fndds', description: 'Milk, whole', nutrients: { calories: 61 } },
  { fdcId: 8004, dataType: 'fndds', description: 'Milk, skim', nutrients: { calories: 34 } },
  { fdcId: 8001, dataType: 'sr_legacy', description: 'Pepper, red, crushed', nutrients: { calories: 318 } },
  { fdcId: 8005, dataType: 'fndds', description: 'Mystery, raw', nutrients: { calories: 100 } },
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

const AI_CAPABILITIES = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });

const LINE = '1 cup skim milk powder';

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipeFor(line: string): ObsidianRecipe {
  return {
    id: 'review-suggested',
    fileName: 'review-suggested.md',
    filePath: 'Recipes/review-suggested.md',
    rawMarkdown: '',
    title: 'Review suggested',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [structured(line)],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as unknown as ObsidianRecipe;
}

interface Flow {
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly state: ReturnType<typeof phase4Reducer>;
  readonly liveRows: ReadonlyArray<LiveRowState>;
  readonly issueKinds: Readonly<Record<string, AiResolutionIssueKind>>;
  readonly lineRef: string;
}

/** The SAME live projection the Advanced Nutrition card uses. */
function flow(line: string): Flow {
  const adaptation = adaptRecipe(recipeFor(line));
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(SESSION, adapted, 1);
  const rows = buildReviewRows(SESSION, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(SESSION.metadata()),
    rows,
    baseServings: 1,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  });
  const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
  const liveRows = projectLiveRows(
    state,
    analyzedByRef,
    adapted,
    SESSION,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  );
  const issueKinds: Record<string, AiResolutionIssueKind> = {};
  for (const live of liveRows) {
    const kind = liveExceptionKind(live.status);
    if (kind !== undefined) issueKinds[live.line_ref] = kind;
  }
  return { adapted, rows, state, liveRows, issueKinds, lineRef: adapted[0].line_ref };
}

function reading(lineRef: string, name: string, phrases: ReadonlyArray<string>, confidence: 'high' | 'medium' = 'high') {
  return {
    contract_version: AI_ADVANCED_CONTRACT_VERSION,
    line_ref: lineRef,
    semantic_food: { normalized_name: name, modifiers: [], preparation: [], state: [], qualifiers: [] },
    search_phrases: [...phrases],
    amount_semantics: { kind: 'exact', echoed_value: 1 },
    unit_semantics: { family: 'volume', interpreted_unit: 'cup' },
    count_semantics: {},
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
    confidence,
  } as never;
}

interface Double {
  readonly network: NetworkAdapter;
  readonly calls: ReadonlyArray<{ path: string; ingredients: ReadonlyArray<Record<string, unknown>> }>;
  readonly postCount: number;
}

function networkDouble(interpretations: (rows: ReadonlyArray<Record<string, unknown>>) => ReadonlyArray<unknown>): Double {
  const calls: Array<{ path: string; ingredients: ReadonlyArray<Record<string, unknown>> }> = [];
  let postCount = 0;
  const network = {
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(async (path: string, body: unknown) => {
      postCount += 1;
      const ingredients = (body as { ingredients: ReadonlyArray<Record<string, unknown>> }).ingredients;
      calls.push({ path, ingredients });
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          contract_version: AI_ADVANCED_CONTRACT_VERSION,
          interpretations: interpretations(ingredients).filter(Boolean),
        },
      };
    }),
  } as unknown as NetworkAdapter;
  return {
    network,
    calls,
    get postCount() {
      return postCount;
    },
  };
}

function canonicalArgs(double: Double, flowValue: Flow, issueKinds: Readonly<Record<string, AiResolutionIssueKind>> | undefined) {
  return {
    network: double.network,
    session: SESSION,
    rows: flowValue.rows,
    adapted: flowValue.adapted,
    liveRows: flowValue.liveRows,
    state: flowValue.state,
    capabilities: AI_CAPABILITIES,
    liveCanonicalInterpretation: true as const,
    ...(issueKinds !== undefined ? { issueKinds } : {}),
  };
}

describe('AI-1 review_suggested — canonical eligibility', () => {
  it('the row under test really is a below-threshold review_suggested row', () => {
    const flowValue = flow(LINE);
    expect(flowValue.issueKinds[flowValue.lineRef]).toBe('review_suggested');
    // The DETERMINISTIC matcher offers nothing automatic for it…
    expect(aiResolutionEligibleRows(flowValue.rows)).toHaveLength(0);
    // …and it IS an actionable exception row (the card targets it).
    const actionable = actionableExceptionRows(flowValue.rows, flowValue.liveRows);
    expect(actionable.map((row) => row.line_ref)).toEqual([flowValue.lineRef]);
  });

  it('sends a review_suggested row to the canonical semantic interpreter', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble((rows) =>
      rows.map((row) => reading(String(row.line_ref), 'Milk, skim', ['skim milk']))
    );
    const result = await resolveUnresolvedRowsWithAi(canonicalArgs(double, flowValue, flowValue.issueKinds));

    expect(double.postCount).toBe(1);
    expect(double.calls[0].path).toBe(NUTRITION_INTERPRET_ENDPOINT);
    expect(double.calls[0].ingredients.map((row) => row.line_ref)).toEqual([flowValue.lineRef]);
    expect(result.ok).toBe(true);
    expect(result.aiAttempted).toBe(true);
    expect(result.semanticInterpretedCount).toBe(1);
  });

  it('classifies ONLY the trusted actionable kinds as canonical-eligible', async () => {
    const flowValue = flow(LINE);
    const unrelated = networkDouble((rows) =>
      rows.map((row) => reading(String(row.line_ref), 'Milk, skim', ['skim milk']))
    );
    // A line the trusted projection does NOT classify is never requested.
    const result = await resolveUnresolvedRowsWithAi(canonicalArgs(unrelated, flowValue, {}));
    expect(unrelated.postCount).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/nothing unresolved/i);
  });
});

describe('AI-1 review_suggested — no below-threshold laundering', () => {
  it('cannot upgrade the row: an AI-driven acceptance stays an explicit offer', async () => {
    const flowValue = flow(LINE);
    // The provider agrees with the deterministic below-threshold candidate and
    // supplies the exact wording the matcher WOULD accept automatically.
    const double = networkDouble((rows) =>
      rows.map((row) => reading(String(row.line_ref), 'Milk, skim', ['milk skim']))
    );
    const result = await resolveUnresolvedRowsWithAi(canonicalArgs(double, flowValue, flowValue.issueKinds));

    expect(result.ok).toBe(true);
    expect(result.outcome.auto_count).toBe(0);
    for (const candidate of result.outcome.candidates as unknown as ReadonlyArray<Record<string, unknown>>) {
      expect(candidate.auto).toBe(false);
      // An offered candidate carries no deterministic acceptance marker, so an
      // explicit "Use this match" remains a genuine USER confirmation.
      expect((candidate.choice as unknown as Record<string, unknown>).aiAccepted).toBeUndefined();
    }
  });

  it('the guard is what prevents the upgrade (classification is load-bearing)', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble((rows) =>
      rows.map((row) => reading(String(row.line_ref), 'Milk, skim', ['milk skim']))
    );
    // Same reading, same catalog, same matcher — only the TRUSTED classification
    // differs. Without the review_suggested classification the deterministic
    // acceptance is visible as an automatic one, which is exactly the upgrade
    // the guard withholds for a below-threshold row.
    const asNeedsMatch = await resolveUnresolvedRowsWithAi(
      canonicalArgs(double, flowValue, { [flowValue.lineRef]: 'needs_match' })
    );
    expect(asNeedsMatch.outcome.auto_count).toBe(1);

    const asReviewSuggested = await resolveUnresolvedRowsWithAi(
      canonicalArgs(double, flowValue, { [flowValue.lineRef]: 'review_suggested' })
    );
    expect(asReviewSuggested.outcome.auto_count).toBe(0);
  });

  it('never auto-resolves an AMOUNT for a review_suggested row', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble((rows) =>
      rows.map((row) => ({
        ...(reading(String(row.line_ref), 'Milk, skim', ['milk skim']) as Record<string, unknown>),
        count_semantics: { noun: 'cup' },
      }))
    );
    const result = await resolveUnresolvedRowsWithAi(canonicalArgs(double, flowValue, flowValue.issueKinds));
    expect(result.amounts.resolved).toEqual([]);
    expect(result.households.resolved).toEqual([]);
  });

  it('withholdBelowThresholdAutoAcceptance is purely subtractive and kind-scoped', () => {
    const candidate = (lineRef: string) => ({
      line_ref: lineRef,
      query: 'milk skim',
      fdc_id: 8004,
      description: 'Milk, skim',
      record_digest: 'd',
      auto: true,
      choice: { kind: 'manual' as const, fdc_id: 8004, aiAssisted: true, aiAccepted: true },
    });
    const outcome = {
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      unresolved: Object.freeze([]),
      auto_count: 3,
    } as never;
    const guarded = withholdBelowThresholdAutoAcceptance({
      outcome,
      issueKinds: { a: 'review_suggested', b: 'needs_match' },
    });
    expect(guarded.auto_count).toBe(2);
    expect((guarded.candidates[0] as { auto: boolean }).auto).toBe(false);
    expect(
      ((guarded.candidates[0] as unknown as { choice: Record<string, unknown> }).choice).aiAccepted
    ).toBeUndefined();
    expect((guarded.candidates[1] as { auto: boolean }).auto).toBe(true);
    // Unclassified lines keep their deterministic acceptance untouched.
    expect((guarded.candidates[2] as { auto: boolean }).auto).toBe(true);

    // No classification at all => the legacy outcome passes through unchanged.
    const untouched = withholdBelowThresholdAutoAcceptance({ outcome });
    expect(untouched).toBe(outcome);
    // Nothing to downgrade => identity is preserved (no needless copies).
    const noneBelowThreshold = withholdBelowThresholdAutoAcceptance({
      outcome,
      issueKinds: { a: 'needs_match' },
    });
    expect(noneBelowThreshold).toBe(outcome);
  });
});

describe('AI-1 review_suggested — source wording still outranks the provider', () => {
  it('preserves the food-defining modifier `skim` in the deterministic search surface', () => {
    const flowValue = flow(LINE);
    const authoritativeByLineRef = buildAuthoritativeAmountObservations({
      rows: flowValue.rows,
      adapted: flowValue.adapted,
    });
    const adapted = adaptAiAdvancedInterpretationsForResolution({
      interpretations: [reading(flowValue.lineRef, 'Milk, skim', ['skim milk', 'milk'])],
      authoritativeByLineRef,
    });
    const eligible = withholdNonDeterministicAdaptations({
      interpretations: [reading(flowValue.lineRef, 'Milk, skim', ['skim milk', 'milk'])],
      outcome: adapted,
    });
    expect(eligible.suggestions).toHaveLength(1);
    const suggestion = eligible.suggestions[0] as unknown as Record<string, unknown>;
    const surface = [
      suggestion.interpreted_food_name,
      suggestion.normalized_food_query,
      ...((suggestion.suggested_usda_queries as ReadonlyArray<string>) ?? []),
    ]
      .join(' | ')
      .toLowerCase();
    expect(surface).toContain('skim');
  });

  it('a high-confidence provider reading creates NO automatic acceptance for a below-threshold row', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble((rows) =>
      rows.map((row) => reading(String(row.line_ref), 'Milk, whole', ['whole milk'], 'high'))
    );
    const result = await resolveUnresolvedRowsWithAi(canonicalArgs(double, flowValue, flowValue.issueKinds));

    expect(result.ok).toBe(true);
    expect(result.outcome.auto_count).toBe(0);
    // Confidence grants nothing: any surviving candidate is a genuine
    // deterministic catalog binding presented as an OFFER for the user.
    for (const candidate of result.outcome.candidates as unknown as ReadonlyArray<Record<string, unknown>>) {
      expect([8003, 8004, 8005]).toContain(candidate.fdc_id);
      expect(candidate.auto).toBe(false);
      expect((candidate.choice as unknown as Record<string, unknown>).aiAccepted).toBeUndefined();
      expect(String(candidate.record_digest).length).toBeGreaterThan(0);
    }
    expect(result.amounts.resolved).toEqual([]);
  });

  it('a source PREPARATION/FORM constraint still vetoes a high-confidence candidate', async () => {
    // The closed Phase 2/3 counters define THIS contradiction explicitly
    // ("shredded" source versus a "crushed" candidate), so the deterministic
    // negative-source veto refuses it even at confidence: high.
    const flowValue = flow('1 cup Zzz, shredded');
    expect(flowValue.issueKinds[flowValue.lineRef]).toBe('needs_match');
    const double = networkDouble((rows) =>
      rows.map((row) => reading(String(row.line_ref), 'Pepper, red, crushed', ['crushed red pepper'], 'high'))
    );
    const result = await resolveUnresolvedRowsWithAi(canonicalArgs(double, flowValue, flowValue.issueKinds));
    expect(result.ok).toBe(true);
    expect(result.outcome.auto_count).toBe(0);
    for (const candidate of result.outcome.candidates as unknown as ReadonlyArray<Record<string, unknown>>) {
      expect(candidate.fdc_id).not.toBe(8001);
    }
  });

  it('a semantically IMPROVED query must still pass every existing gate', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble((rows) =>
      rows.map((row) => reading(String(row.line_ref), 'Milk, skim', ['milk skim']))
    );
    const result = await resolveUnresolvedRowsWithAi(canonicalArgs(double, flowValue, flowValue.issueKinds));
    // The deterministic pipeline still produced its own verification result for
    // the line: either an offer bound to a real catalog record with its genuine
    // digest, or no candidate at all. Nothing is invented.
    for (const candidate of result.outcome.candidates as unknown as ReadonlyArray<Record<string, unknown>>) {
      expect([8003, 8004, 8005]).toContain(candidate.fdc_id);
      expect(typeof candidate.record_digest).toBe('string');
      expect((candidate.record_digest as string).length).toBeGreaterThan(0);
    }
  });
});

describe('AI-1 review_suggested — the legacy v4 path is unchanged', () => {
  it('the legacy scope still excludes below-threshold rows', () => {
    const flowValue = flow(LINE);
    expect(aiResolutionEligibleRows(flowValue.rows)).toHaveLength(0);
  });

  it('the v4 request path makes no call for the review_suggested row', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble(() => []);
    const legacy = await requestAiIngredientResolution({
      network: double.network,
      rows: flowValue.rows,
      adapted: flowValue.adapted,
    });
    expect(double.postCount).toBe(0);
    expect(legacy.ok).toBe(false);
    expect(legacy.message).toMatch(/nothing unresolved/i);
  });

  it('the v4 orchestrator branch still speaks the v4 contract on the v4 route', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble(() => []);
    const legacyRun = await resolveUnresolvedRowsWithAi({
      network: double.network,
      session: SESSION,
      rows: flowValue.rows,
      adapted: flowValue.adapted,
      liveRows: flowValue.liveRows,
      state: flowValue.state,
      capabilities: AI_CAPABILITIES,
      issueKinds: flowValue.issueKinds,
    });
    // Unchanged AI-0 behavior: the legacy branch is untouched by AI-1 and still
    // uses the v4 endpoint/format (never the canonical interpretation route).
    expect(double.postCount).toBe(1);
    expect(double.calls[0].path).toBe('/api/nutrition/resolve-ingredients');
    expect(legacyRun.message ?? '').not.toBe(AI_RESOLUTION_UNAVAILABLE_MESSAGE);
  });

  it('the legacy path with NO trusted classification makes no call at all', async () => {
    const flowValue = flow(LINE);
    const double = networkDouble(() => []);
    const legacyRun = await resolveUnresolvedRowsWithAi({
      network: double.network,
      session: SESSION,
      rows: flowValue.rows,
      adapted: flowValue.adapted,
      liveRows: flowValue.liveRows,
      state: flowValue.state,
      capabilities: AI_CAPABILITIES,
    });
    expect(double.postCount).toBe(0);
    expect(legacyRun.ok).toBe(false);
    expect(legacyRun.message).toMatch(/nothing unresolved/i);
  });
});
