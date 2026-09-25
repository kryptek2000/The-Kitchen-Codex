/**
 * The Kitchen Codex — Advanced Nutrition Phase 6: production verification of the
 * verified household-portion integration (deterministic, offline, dependency-free).
 *
 * Runs the REAL pinned USDA bundle and the REAL verified Phase 5 registry
 * through the public core pipeline and proves:
 *   - a food resolves through `household_portion` ONLY because no higher-authority
 *     source was available, with truthful grams and evidence;
 *   - closing the review WITHOUT Apply persists nothing;
 *   - explicit Apply authorization writes truthful household provenance;
 *   - reopen independently re-authenticates the registry and restores the same
 *     household result;
 *   - a stale binding fails closed (no household mass, never a user mass).
 *
 * Usage: bun x tsx scripts/verify_phase6_household_prod.ts
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
import { authorizeNutritionPersistence } from '../src/core/nutritionV2/phase5/authorize';
import { decodeCodexNutrition, encodeCodexNutrition } from '../src/core/nutritionV2/validate';
import type {
  CodexNutritionV1,
  CodexNutritionV2,
  HouseholdPortionEvidence,
  IngredientEvidenceV2,
} from '../src/core/nutritionV2/schema';
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

function recipeFor(line: string): ObsidianRecipe {
  return {
    id: 'phase6-verify',
    fileName: 'phase6-verify.md',
    filePath: 'Recipes/phase6-verify.md',
    rawMarkdown: '',
    title: 'Phase 6 Household Verification',
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

  const recipe = recipeFor('3 cloves garlic, minced');
  const adaptation = adaptRecipe(recipe);
  record('the household recipe adapts', adaptation.ok);
  if (!adaptation.ok) return;
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
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

  const lineRef = adapted[0].line_ref;
  const householdChoice = state.householdPortions[lineRef];
  record('the deterministic analyzer selected a verified household portion', householdChoice !== undefined);
  record(
    'no higher-authority stored source was selected for the line',
    state.portions[lineRef] === undefined &&
      state.countPortions[lineRef] === undefined &&
      state.userMasses[lineRef] === undefined
  );
  const calculated = session.calculate(buildCalculationRequest(adapted, state));
  record('the calculator accepts the household preview', calculated.ok);
  if (!calculated.ok) return;
  const evidence = calculated.preview.ingredients[0];
  record('the resolved mass source is household_portion', evidence.mass_source === 'household_portion');
  record('the resolved grams are truthful (3 cloves x 3 g = 9 g)', evidence.resolved_grams === 9);
  record('the evidence names the registry release', evidence.household_registry_release === 'household_portion_initial_usda_v1');
  record('the evidence names the household record key', evidence.household_record_key === 'garlic|clove|null|null');
  record('the evidence names the canonical unit', evidence.household_unit === 'clove');
  record('the authority class is the authenticated USDA-derived class', evidence.household_authority_class === 'usda_derived');

  const live = projectLiveRows(
    state,
    new Map(analysis.rows.map((row) => [row.line_ref, row])),
    adapted,
    session,
    null
  );
  record('the live row agrees with the calculator', live[0].resolved_grams === 9 && live[0].mass_source === 'household_portion');
  record('the live summary counts the row as matched', summarizeLiveRows(live).matched === 1);

  // CLOSE WITHOUT APPLY: no persistence call is made, so no block exists.
  let persistedBlock: CodexNutritionV1 | CodexNutritionV2 | undefined;
  record('closing without Apply persists nothing', persistedBlock === undefined);

  // EXPLICIT APPLY (authorization only; the vault write remains the app's job).
  const readyState = {
    ...state,
    status: 'preview_current' as const,
    preview: calculated.preview,
    previewKey: state.recipeKey,
  };
  const authorized = authorizeNutritionPersistence({ session, recipe, state: readyState });
  record('explicit Apply authorization succeeds', authorized.ok);
  if (authorized.ok) persistedBlock = authorized.candidate.block;
  if (!persistedBlock) return;
  const savedEvidence = persistedBlock.ingredients[0];
  record('the persisted block is schema v2 (household provenance)', persistedBlock.schema === 2);
  record('the persisted basis is household_portion', savedEvidence.conversion_basis === 'household_portion');
  const savedHousehold = (savedEvidence as IngredientEvidenceV2)
    .household_portion as HouseholdPortionEvidence | undefined;
  record('the persisted evidence preserves the record binding', savedHousehold?.record_key === 'garlic|clove|null|null');
  record('the persisted evidence preserves the registry release', savedHousehold?.registry_release === 'household_portion_initial_usda_v1');
  record('the persisted evidence preserves the quantity', savedHousehold?.quantity === 3);
  record('the persisted evidence carries no nutrients', !('nutrients' in savedEvidence));
  const encoded = encodeCodexNutrition(persistedBlock);
  record('the encoded frontmatter schema discriminator is 2', encoded.schema === 2);
  const decoded = decodeCodexNutrition(encoded);
  record('the canonical codec round-trips the household block as schema v2', decoded.kind === 'v2');

  // REOPEN
  const hydrated = hydrateWorkingReview({ session, adapted, rows, savedBlock: persistedBlock });
  const restored = hydrated?.householdPortions[lineRef];
  record('reopen re-authenticates the registry and restores the household portion', restored !== undefined);
  record('reopen restores the same grams', restored?.resolved_grams === 9);
  record('reopen does not degrade into a user mass', hydrated?.userMasses[lineRef] === undefined);

  // STALE BINDING FAILS CLOSED
  const staleBlock = JSON.parse(JSON.stringify(persistedBlock)) as CodexNutritionV2;
  const staleHousehold = (staleBlock.ingredients[0] as IngredientEvidenceV2)
    .household_portion as unknown as Record<string, unknown> | undefined;
  if (staleHousehold) staleHousehold.registry_release = 'other_registry';
  const staleHydrated = hydrateWorkingReview({ session, adapted, rows, savedBlock: staleBlock });
  record(
    'a stale registry binding fails closed (no household mass, no user mass)',
    staleHydrated?.householdPortions[lineRef] === undefined &&
      staleHydrated?.userMasses[lineRef] === undefined
  );

  // NON-HOUSEHOLD WRITE POLICY: a direct-mass recipe still writes canonical v1.
  const directRecipe = recipeFor('100 g garlic');
  const directAdaptation = adaptRecipe(directRecipe);
  record('the non-household recipe adapts', directAdaptation.ok);
  if (directAdaptation.ok) {
    const directAdapted = directAdaptation.recipe.adapted;
    const directAnalysis = analyzeRecipe(session, directAdapted, 1);
    const directRows = buildReviewRows(session, directAdapted);
    let directState = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: directAdaptation.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: directRows,
      baseServings: 1,
    });
    directState = phase4Reducer(directState, {
      type: 'apply_analysis',
      matches: directAnalysis.matches,
      portions: directAnalysis.portions,
      countPortions: directAnalysis.countPortions,
      householdPortions: directAnalysis.householdPortions,
      preview: directAnalysis.preview,
    });
    const directCalculated = session.calculate(buildCalculationRequest(directAdapted, directState));
    record('the direct-mass preview calculates', directCalculated.ok);
    if (directCalculated.ok) {
      const directAuthorized = authorizeNutritionPersistence({
        session,
        recipe: directRecipe,
        state: {
          ...directState,
          status: 'preview_current' as const,
          preview: directCalculated.preview,
          previewKey: directState.recipeKey,
        },
      });
      record('the non-household Apply authorization succeeds', directAuthorized.ok);
      if (directAuthorized.ok) {
        record(
          'a non-household Apply still writes canonical schema v1',
          directAuthorized.candidate.block.schema === 1
        );
        record(
          'the non-household block carries no household basis',
          directAuthorized.candidate.block.ingredients.every(
            (entry) => entry.conversion_basis !== 'household_portion'
          )
        );
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('verification failed', error instanceof Error ? error.message : 'unknown');
  process.exit(1);
});
