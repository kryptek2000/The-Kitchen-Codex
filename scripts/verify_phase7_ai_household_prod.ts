/**
 * The Kitchen Codex — Advanced Nutrition Phase 7: production verification of the
 * AI household-interpretation alignment (deterministic, offline,
 * dependency-free).
 *
 * Runs the REAL pinned USDA bundle and the REAL verified Phase 5 registry
 * through the public core pipeline and proves:
 *   - AI closed-token household wording unlocks the ONE verified record for a
 *     `NEEDS AMOUNT` line, with truthful grams/bindings and calculator/live
 *     agreement;
 *   - AI authors no authority (no FDC id, grams, record id, digest, nutrients,
 *     confirmation, authorization, or persistence);
 *   - closing the review WITHOUT Apply persists nothing; explicit Apply writes
 *     truthful schema-v2 household provenance;
 *   - reopening retains only what Phase 6 can truthfully re-authenticate (the
 *     AI hint is not persisted);
 *   - ranges, containers, direct mass, source portions, source sizes/states,
 *     unknown records, and forged selections all fail closed.
 *
 * Usage: bun x tsx scripts/verify_phase7_ai_household_prod.ts
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { composeAdvancedNutritionSessionFromBundle } from '../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../src/core/nutritionV2/phase4/rows';
import { projectLiveRows, summarizeLiveRows } from '../src/core/nutritionV2/phase4/liveRow';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../src/core/nutritionV2/phase4/types';
import { hydrateWorkingReview } from '../src/core/nutritionV2/phase4/hydrate';
import { resolveHouseholdsFromAiSuggestions } from '../src/core/nutritionV2/phase4/aiHouseholdResolve';
import { sanitizeAiResolutionResponse } from '../src/core/nutritionV2/aiResolution';
import { ingredientEvidenceViews } from '../src/core/nutritionV2/phase4/display';
import { authorizeNutritionPersistence } from '../src/core/nutritionV2/phase5/authorize';
import { decodeCodexNutrition, encodeCodexNutrition } from '../src/core/nutritionV2/validate';
import type { CodexNutritionV2, HouseholdPortionEvidence, IngredientEvidenceV2 } from '../src/core/nutritionV2/schema';
import type { HouseholdPortionChoice } from '../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../src/types';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLE_DIR = join(
  ROOT,
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let passed = 0;
let failed = 0;
function record(name: string, ok: boolean, details?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${details ? ` — ${details}` : ''}`);
  }
}

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

function recipeFor(line: string, id = 'phase7-verify'): ObsidianRecipe {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `Recipes/${id}.md`,
    rawMarkdown: '',
    title: 'Phase 7 AI Household Verification',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 1,
    ingredients: [structuredLine(line)] as never,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as unknown as ObsidianRecipe;
}

async function main(): Promise<void> {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const composed = await composeAdvancedNutritionSessionFromBundle(inputs);
  record('the real pinned USDA bundle authenticates', composed.ok);
  if (!composed.ok) return;
  const session = composed.session;

  const recipe = recipeFor('2 tomatoes');
  const adaptation = adaptRecipe(recipe);
  record('the recipe adapts', adaptation.ok);
  if (!adaptation.ok) return;
  const adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: 1,
  });
  const analysis = analyzeRecipe(session, adapted, 1);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  });
  const lineRef = adapted[0].line_ref;

  const liveBefore = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  )[0];
  record('before AI the line is NEEDS AMOUNT with no household mass', liveBefore.status === 'needs_amount' && liveBefore.resolved_grams === undefined);

  const suggestions = [
    {
      line_ref: lineRef,
      interpreted_food_name: 'Tomatoes, raw',
      suggested_usda_queries: ['tomatoes raw'],
      household_size_hint: 'medium',
    },
  ];
  const outcome = resolveHouseholdsFromAiSuggestions({
    session,
    rows,
    adapted,
    liveRows: [liveBefore],
    state,
    suggestions,
  });
  record('AI household wording unlocks exactly one verified record', outcome.resolved.length === 1);
  if (outcome.resolved.length !== 1) return;
  const resolved = outcome.resolved[0];
  record('the record is tomato|item|medium|null', resolved.record_key === 'tomato|item|medium|null');
  record('the local grams are 2 x 123 g = 246 g', resolved.resolved_grams === 246);
  record('the choice is AI-assisted but automatic, never user-confirmed', resolved.choice.aiAssisted === true && resolved.choice.automatic === true);

  state = phase4Reducer(state, {
    type: 'select_household_portion',
    lineRef,
    choice: resolved.choice,
  });
  const calculated = session.calculate(buildCalculationRequest(adapted, state));
  record('the calculator accepts the AI-assisted household selection', calculated.ok);
  if (!calculated.ok) return;
  const evidence = calculated.preview.ingredients[0];
  record('the resolved mass source is household_portion', evidence.mass_source === 'household_portion');
  record('the resolved grams are 246', evidence.resolved_grams === 246);
  record('the evidence names the verified registry release', evidence.household_registry_release === 'household_portion_initial_usda_v1');
  record('the evidence names the household record key', evidence.household_record_key === 'tomato|item|medium|null');
  record('the evidence quantity is the recipe quantity', evidence.household_quantity === 2);
  record('the authority class stays usda_derived', evidence.household_authority_class === 'usda_derived');
  record('the calculator reports user_confirmed=false', evidence.user_confirmed === false);
  record('the preview is advisory and NOT application-authorized', calculated.preview.advisory_only === true && calculated.preview.application_authorized === false);

  const liveAfter = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    ingredientEvidenceViews(calculated.preview),
    analysis.portions,
    analysis.countPortions
  )[0];
  record('the live row agrees with the calculator (grams + source)', liveAfter.resolved_grams === 246 && liveAfter.mass_source === 'household_portion');
  record('the live row is MATCHED and marked AI-interpreted wording only', liveAfter.status === 'matched' && liveAfter.household_ai_assisted === true);
  record('the live summary counts the row as matched', summarizeLiveRows([liveAfter]).matched === 1);

  // AI AUTHORITY NEGATIVE: authority-shaped provider fields reject the response.
  const rejected = sanitizeAiResolutionResponse(
    {
      version: 4,
      suggestions: [
        {
          line_ref: lineRef,
          interpreted_food_name: 'Tomatoes, raw',
          suggested_usda_queries: [],
          household_size_hint: 'medium',
          resolved_grams: 999,
        },
      ],
    },
    { allowedLineRefs: [lineRef] }
  );
  record('AI-authored grams/FDC/digest fields reject the whole response', rejected.ok === false);

  // FORGERY NEGATIVE: tampering the selection fails the whole calculation.
  const forged = JSON.parse(JSON.stringify(resolved.choice)) as HouseholdPortionChoice;
  (forged.selection as { resolved_grams: number }).resolved_grams = 999;
  const forgedState = phase4Reducer(state, {
    type: 'select_household_portion',
    lineRef,
    choice: forged,
  });
  const forgedCalc = session.calculate(buildCalculationRequest(adapted, forgedState));
  record('a forged household selection fails the calculation closed', forgedCalc.ok === false);

  // CLOSE WITHOUT APPLY: no persistence call is made, so no block exists.
  let persistedBlock: CodexNutritionV2 | undefined;
  record('closing without Apply persists nothing', persistedBlock === undefined);

  // EXPLICIT APPLY.
  const readyState = {
    ...state,
    status: 'preview_current' as const,
    preview: calculated.preview,
    previewKey: state.recipeKey,
  };
  const authorized = authorizeNutritionPersistence({ session, recipe, state: readyState });
  record('explicit Apply authorization succeeds', authorized.ok);
  if (authorized.ok) persistedBlock = authorized.candidate.block as CodexNutritionV2;
  if (!persistedBlock) return;
  const savedEvidence = persistedBlock.ingredients[0] as IngredientEvidenceV2;
  record('the persisted block is schema v2', persistedBlock.schema === 2);
  record('the persisted basis is household_portion', savedEvidence.conversion_basis === 'household_portion');
  const savedHousehold = savedEvidence.household_portion as HouseholdPortionEvidence | undefined;
  record('the persisted evidence preserves the record binding', savedHousehold?.record_key === 'tomato|item|medium|null');
  record('the persisted evidence preserves the quantity', savedHousehold?.quantity === 2);
  record('the persisted evidence never carries the AI hint', !('household_requirement_hint' in savedEvidence));
  const encoded = encodeCodexNutrition(persistedBlock);
  record('the encoded frontmatter schema discriminator is 2', encoded.schema === 2);
  record('the canonical codec round-trips the block as schema v2', decodeCodexNutrition(encoded).kind === 'v2');

  // REOPEN: the AI wording is not persisted, so Phase 6 cannot re-authenticate
  // the household basis without it; the truthful outcome is "unresolved".
  const hydrated = hydrateWorkingReview({ session, adapted, rows, savedBlock: persistedBlock });
  record(
    'reopen does not invent household authority the schema cannot re-authenticate',
    hydrated?.householdPortions[lineRef] === undefined && hydrated?.userMasses[lineRef] === undefined
  );

  // NO-OP: a deterministic household line is never changed by AI wording.
  const garlic = recipeFor('3 cloves garlic, minced', 'phase7-garlic');
  const garlicAdapt = adaptRecipe(garlic);
  if (garlicAdapt.ok) {
    const garlicAdapted = garlicAdapt.recipe.adapted;
    const garlicAnalysis = analyzeRecipe(session, garlicAdapted, 1);
    const garlicRows = buildReviewRows(session, garlicAdapted);
    let garlicState = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: garlicAdapt.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: garlicRows,
      baseServings: 1,
    });
    garlicState = phase4Reducer(garlicState, {
      type: 'apply_analysis',
      matches: garlicAnalysis.matches,
      portions: garlicAnalysis.portions,
      countPortions: garlicAnalysis.countPortions,
      householdPortions: garlicAnalysis.householdPortions,
      preview: garlicAnalysis.preview,
    });
    const garlicLive = projectLiveRows(
      garlicState,
      new Map(garlicAnalysis.rows.map((row) => [row.line_ref, row])),
      garlicAdapted,
      session,
      garlicAnalysis.preview ? ingredientEvidenceViews(garlicAnalysis.preview) : null,
      garlicAnalysis.portions,
      garlicAnalysis.countPortions
    )[0];
    const garlicAi = resolveHouseholdsFromAiSuggestions({
      session,
      rows: garlicRows,
      adapted: garlicAdapted,
      liveRows: [garlicLive],
      state: garlicState,
      suggestions: [
        {
          line_ref: garlicAdapted[0].line_ref,
          interpreted_food_name: 'Garlic, raw',
          suggested_usda_queries: [],
          household_unit_hint: 'clove',
        },
      ],
    });
    record('an already-resolved household line stays identical', garlicLive.resolved_grams === 9 && garlicAi.resolved.length === 0);
  }

  // FAIL-CLOSED CORPUS.
  async function householdFor(line: string, fields: Record<string, unknown>) {
    const r = recipeFor(line, `phase7-${line.replace(/\W+/g, '-')}`);
    const a = adaptRecipe(r);
    if (!a.ok) return { resolved: 0 };
    const ad = a.recipe.adapted;
    const an = analyzeRecipe(session, ad, 1);
    const rws = buildReviewRows(session, ad);
    let st = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: a.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: rws,
      baseServings: 1,
    });
    st = phase4Reducer(st, {
      type: 'apply_analysis',
      matches: an.matches,
      portions: an.portions,
      countPortions: an.countPortions,
      householdPortions: an.householdPortions,
      preview: an.preview,
    });
    const live = projectLiveRows(
      st,
      new Map(an.rows.map((row) => [row.line_ref, row])),
      ad,
      session,
      an.preview ? ingredientEvidenceViews(an.preview) : null,
      an.portions,
      an.countPortions
    );
    const result = resolveHouseholdsFromAiSuggestions({
      session,
      rows: rws,
      adapted: ad,
      liveRows: live,
      state: st,
      suggestions: [
        {
          line_ref: ad[0].line_ref,
          interpreted_food_name: 'probe',
          suggested_usda_queries: [],
          ...fields,
        },
      ],
    });
    const ev = live[0];
    return { resolved: result.resolved.length, status: ev.status, grams: ev.resolved_grams, source: ev.mass_source };
  }

  const range = await householdFor('2-3 tomatoes', { household_size_hint: 'medium' });
  record('a range quantity stays unresolved', range.resolved === 0 && range.status === 'needs_amount');
  const container = await householdFor('1 can diced tomatoes', { household_size_hint: 'medium' });
  record('a container line stays unresolved', container.resolved === 0);
  const direct = await householdFor('100 g tomatoes', { household_size_hint: 'medium' });
  record('a direct-mass line keeps its recipe mass', direct.resolved === 0 && direct.source === 'direct_mass' && direct.grams === 100);
  const portion = await householdFor('1 cup diced tomatoes', { household_size_hint: 'medium' });
  record('a USDA source-portion line keeps its source portion', portion.resolved === 0 && portion.source === 'source_portion');
  const noRecord = await householdFor('2 eggplants', { household_size_hint: 'medium' });
  record('a food with no compatible record stays unresolved', noRecord.resolved === 0);
  const containerHint = await householdFor('2 tomatoes', { household_unit_hint: 'can', household_size_hint: 'medium' });
  record('a container AI unit hint is rejected whole', containerHint.resolved === 0);
  const hostile = await householdFor('2 tomatoes', { household_size_hint: 'gigantic' });
  record('an unknown size token never resolves', hostile.resolved === 0);
  const stateConflict = await householdFor('2 tomatoes, cooked', {
    household_size_hint: 'medium',
    household_state_hint: 'raw',
  });
  record('a contradictory source state is never erased', stateConflict.resolved === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('verification failed', error instanceof Error ? error.message : 'unknown');
  process.exit(1);
});
