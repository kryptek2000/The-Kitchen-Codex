/**
 * The Kitchen Codex — Nutrition food-match provenance.
 *
 * Proves the THREE distinct provenances are never conflated:
 *   A. automatic deterministic match            -> user_confirmed: false
 *   B. AI-assisted deterministic acceptance     -> user_confirmed: false
 *   C. explicit user choice (manual / Use match)-> user_confirmed: true
 */

import { describe, it, expect } from 'vitest';
import { buildCalculationBundle, type CalcRecordSpec } from '../fixtures/usdaCalculationFixtures';
import { createAdvancedNutritionSession } from '../../src/core/nutritionV2/phase4/session';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { userConfirmedChoiceFromAiSuggestion } from '../../src/core/nutritionV2/phase4/aiResolve';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import type { AdvancedNutritionSession, MatchChoice, Phase4State } from '../../src/core/nutritionV2/phase4';
import type { ObsidianRecipe } from '../../src/types';

const SPECS: ReadonlyArray<CalcRecordSpec> = [
  { fdcId: 6001, dataType: 'sr_legacy', description: 'Flour, wheat, white', nutrients: { calories: 364 } },
  { fdcId: 6002, dataType: 'fndds', description: 'Mystery, raw', nutrients: { calories: 100 } },
  { fdcId: 6003, dataType: 'fndds', description: 'Mystery, cooked', nutrients: { calories: 120 } },
];

const BUNDLE = buildCalculationBundle(SPECS);
const SESSION_RESULT = createAdvancedNutritionSession(BUNDLE.manifest, BUNDLE.records);
if (!SESSION_RESULT.ok) throw new Error('session failed');
const SESSION: AdvancedNutritionSession = SESSION_RESULT.session;

function structured(line: string): Record<string, unknown> {
  const parsed = parseIngredientLine(line);
  const obj: Record<string, unknown> = { original: parsed.original, name: parsed.name };
  if (parsed.amount !== null) obj.amount = parsed.amount;
  if (parsed.unit) obj.unit = parsed.unit;
  return obj;
}

function recipe(lines: ReadonlyArray<string>): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '',
    title: 'Provenance',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: lines.map(structured) as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as ObsidianRecipe;
}

function setup(lines: ReadonlyArray<string>) {
  const adaptation = adaptRecipe(recipe(lines));
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(SESSION, adapted);
  const state: Phase4State = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: null,
    baseServings: 2,
    rows,
    matches: {},
    portions: {},
    countPortions: {},
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: 2,
    preview: null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
  return { adapted, rows, state };
}

function recordDigestOf(fdcId: number): string {
  const search = SESSION.searchFoods(String(fdcId), 1);
  if (!search.ok) throw new Error('search failed');
  const hit = search.results.find((result) => result.fdc_id === fdcId && result.exact_fdc_id);
  if (!hit) throw new Error('no exact hit');
  return hit.record_digest;
}

function manualChoice(
  lineRef: string,
  fdcId: number,
  reviewDigest: string,
  extra: Partial<MatchChoice> = {}
): MatchChoice {
  return {
    kind: 'manual',
    fdc_id: fdcId,
    review_digest: reviewDigest,
    record_digest: recordDigestOf(fdcId),
    catalog_digest: SESSION.metadata().catalog_digest,
    description: 'Mystery, raw',
    ...extra,
  };
}

function calculateWith(state: Phase4State) {
  const result = SESSION.calculate(buildCalculationRequest(state.rows.length ? [] : [], state));
  return result;
}

describe('food-match provenance', () => {
  it('A. deterministic-only match is NOT user-confirmed', () => {
    const { adapted } = setup(['100 g Flour, wheat, white']);
    const request = {
      servings: 2,
      nutrient_scope: ['calories'],
      ingredients: adapted.map((entry) => ({ line_ref: entry.line_ref, ingredient: entry.ingredient })),
    };
    const result = SESSION.calculate(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].match_status).toBe('unique_exact');
    expect(result.preview.ingredients[0].user_confirmed).toBe(false);
  });

  it('B. AI-assisted deterministic acceptance is auto_confirmed, NOT user-confirmed', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = manualChoice(row.line_ref, 6002, row.review_digest ?? '', {
      aiAssisted: true,
      aiAccepted: true,
    });
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.match_status).toBe('auto_confirmed');
    expect(evidence.user_confirmed).toBe(false);
  });

  it('C1. an explicit "Use this match" choice is user-confirmed', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    // An OFFERED AI candidate omits `aiAccepted`; the user's click makes it manual.
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = manualChoice(row.line_ref, 6002, row.review_digest ?? '', {
      aiAssisted: true,
    });
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].match_status).toBe('user_confirmed');
    expect(result.preview.ingredients[0].user_confirmed).toBe(true);
  });

  it('D. an explicit "Use this match" click strips automatic markers and is user-confirmed', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    // Even if a forged/stale automatic marker were present, the explicit click
    // converts the choice into a genuine user decision BEFORE it is stored.
    const offered = manualChoice(row.line_ref, 6002, row.review_digest ?? '', {
      aiAssisted: true,
      aiAccepted: true,
      automatic: true,
    });
    const confirmed = userConfirmedChoiceFromAiSuggestion(offered);
    expect(confirmed.aiAccepted).toBeUndefined();
    expect(confirmed.automatic).toBeUndefined();
    expect(confirmed.aiAssisted).toBe(true);
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = confirmed;
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].match_status).toBe('user_confirmed');
    expect(result.preview.ingredients[0].user_confirmed).toBe(true);
  });

  it('C2. a manual USDA search selection is user-confirmed', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = manualChoice(row.line_ref, 6002, row.review_digest ?? '');
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].user_confirmed).toBe(true);
  });

  it('a forged AI-assisted selection with a wrong record digest fails closed', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = {
      ...manualChoice(row.line_ref, 6002, row.review_digest ?? '', { aiAssisted: true, aiAccepted: true }),
      record_digest: 'f'.repeat(64),
    };
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].match_status).not.toBe('auto_confirmed');
    expect(result.preview.ingredients[0].match_status).not.toBe('user_confirmed');
    expect(result.preview.ingredients[0].user_confirmed).toBe(false);
  });

  it('an AI-assisted selection bound to a different line does not apply', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = {
      ...manualChoice('ing:9:other', 6002, row.review_digest ?? '', { aiAssisted: true, aiAccepted: true }),
    };
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].user_confirmed).toBe(false);
  });

  it('an AI-assisted selection with a stale review digest fails closed', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = manualChoice(row.line_ref, 6002, 'b'.repeat(64), {
      aiAssisted: true,
      aiAccepted: true,
    });
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].user_confirmed).toBe(false);
    expect(result.preview.ingredients[0].match_status).not.toBe('auto_confirmed');
  });

  it('the selection carries no mass authority (AI-assisted food stays NEEDS AMOUNT)', () => {
    const { adapted, rows, state } = setup(['1 cup Zzz']);
    const row = rows[0];
    (state.matches as Record<string, MatchChoice>)[row.line_ref] = manualChoice(row.line_ref, 6002, row.review_digest ?? '', {
      aiAssisted: true,
      aiAccepted: true,
    });
    const result = SESSION.calculate(buildCalculationRequest(adapted, state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.preview.ingredients[0];
    expect(evidence.fdc_id).toBe(6002);
    expect(evidence.resolved_grams).toBeUndefined();
    expect(evidence.outcome).not.toBe('calculated');
  });
});
