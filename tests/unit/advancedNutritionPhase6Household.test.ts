/**
 * Advanced Nutrition Phase 6 — verified household-portion integration.
 *
 * This suite separates TWO different claims that must never be conflated:
 *
 *  1. REGISTRY BINDING CONTRACT (`registry binding contract`): every published
 *     household record resolves ONLY under its exact authenticated key with the
 *     exact hardcoded grams/digest. This group uses CONTROLLED resolver inputs
 *     (a synthetic `household test food` phrase chosen to express the canonical
 *     unit/size/state) so the lookup contract can be exercised for all 31
 *     records. It does NOT claim that ordinary recipe lines naturally reach
 *     every record.
 *
 *  2. REAL PIPELINE REACHABILITY AND PRECEDENCE (`real pipeline reachability`):
 *     ordinary recipe lines flow through parse -> review -> analyzer ->
 *     calculation -> live projection, and the suite records which lines are
 *     household-reachable, which are correctly SHADOWED by a higher USDA
 *     authority, and which are blocked by identity review or parser limits.
 *     Shadowing is correct behavior; household resolution is never forced.
 *
 * It additionally proves the closed selection binding, the effective-mass
 * precedence, the analyzer's calculated-line guard, the container/range
 * fail-closed guards, household invalidation (including stale in-flight
 * responses), truthful persisted provenance (`user_confirmed` means "the user
 * authorized this reviewed result by Apply"), and the closed schema-v2
 * household contract with old/new reader compatibility.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { validateCanonicalRecord } from '../../src/core/nutritionV2/usda/record';
import { decodeBoundedGzip, decodeUtf8Strict } from '../../src/core/nutritionV2/runtime/gzip';
import { loadHouseholdInitialRegistry } from '../../src/core/nutritionV2/household/initialData';
import {
  HOUSEHOLD_PORTION_SELECTION_VERSION,
  computeHouseholdPortionSelectionDigest,
  deriveHouseholdLookupContext,
  resolveHouseholdPortion,
  type HouseholdPortionResolution,
  type HouseholdPortionSelection,
} from '../../src/core/nutritionV2/calculation/householdPortion';
import { resolveEffectiveMassDecision } from '../../src/core/nutritionV2/calculation/effectiveMass';
import type { NutrientId } from '../../src/core/nutritionV2/nutrients';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import {
  buildCalculationRequest,
  buildReviewRows,
  selectionFromMatchChoice,
} from '../../src/core/nutritionV2/phase4/rows';
import {
  projectLiveRows,
  summarizeLiveRows,
  type LiveRowState,
} from '../../src/core/nutritionV2/phase4/liveRow';
import {
  ingredientEvidenceViews,
  massSourceLabel,
  householdPortionEvidenceLabel,
} from '../../src/core/nutritionV2/phase4/display';
import {
  INITIAL_PHASE4_STATE,
  isPreviewCurrent,
  phase4Reducer,
} from '../../src/core/nutritionV2/phase4/state';
import { buildHouseholdPortionChoice } from '../../src/core/nutritionV2/phase4/householdPortion';
import { buildCountPortionChoice } from '../../src/core/nutritionV2/phase4/countPortion';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  HouseholdPortionChoice,
  MatchChoice,
  Phase4Row,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import type {
  CodexNutritionV1,
  CodexNutritionV2,
  CodexNutritionV3,
  HouseholdPortionEvidence,
  IngredientEvidenceV2,
} from '../../src/core/nutritionV2/schema';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5/authorize';
import { decodeCodexNutrition, encodeCodexNutrition } from '../../src/core/nutritionV2/validate';
import type { CanonicalUsdaFoodRecord } from '../../src/core/nutritionV2/usda/types';
import type { ObsidianRecipe } from '../../src/types';

const BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let session: AdvancedNutritionSession;
let bundle: Map<number, CanonicalUsdaFoodRecord>;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  for (const shard of USDA_BUNDLE_RELEASE_LOCK.shards) {
    const compressed = new Uint8Array(readFileSync(join(BUNDLE_DIR, shard.filename)));
    const decoded = await decodeBoundedGzip(compressed, 64 * 1024 * 1024);
    const text = decodeUtf8Strict(decoded);
    if (!text.ok) throw new Error('bundle utf8 invalid');
    const parsed = JSON.parse(text.text) as ReadonlyArray<unknown>;
    for (const raw of parsed) {
      const validated = validateCanonicalRecord(raw);
      if (!validated.ok) throw new Error('bundle record invalid');
      bundle = bundle ?? new Map();
      bundle.set(validated.record.fdc_id, validated.record);
    }
  }
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
}, 180000);

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

interface Flow {
  readonly recipe: ObsidianRecipe;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly analysis: ReturnType<typeof analyzeRecipe>;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly state: Phase4State;
  readonly lineRef: string;
}

function recipeFor(line: string): ObsidianRecipe {
  return {
    id: 'phase6',
    fileName: 'phase6.md',
    filePath: 'Recipes/phase6.md',
    rawMarkdown: '',
    title: 'Phase 6 Household',
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

function flow(line: string): Flow {
  const recipe = recipeFor(line);
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
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
  return { recipe, adapted, analysis, rows, state, lineRef: adapted[0].line_ref };
}

function project(flowValue: Flow, state: Phase4State): ReadonlyArray<LiveRowState> {
  const analysis = analyzeRecipe(session, flowValue.adapted, 1);
  const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
  return projectLiveRows(
    state,
    analyzedByRef,
    flowValue.adapted,
    session,
    analysis.preview ? ingredientEvidenceViews(analysis.preview) : null,
    analysis.portions,
    analysis.countPortions
  );
}

function liveOf(flowValue: Flow, state: Phase4State): LiveRowState {
  return project(flowValue, state)[0];
}

function calculate(flowValue: Flow, state: Phase4State) {
  return session.calculate(buildCalculationRequest(flowValue.adapted, state));
}

/** One authenticated line input with an optional household binding. */
function lineInput(flowValue: Flow, householdSelection?: unknown): Record<string, unknown> {
  const match = flowValue.state.matches[flowValue.lineRef];
  return {
    line_ref: flowValue.lineRef,
    ingredient: flowValue.adapted[0].ingredient,
    review: flowValue.rows[0].outcome === 'review_required' ? flowValue.rows[0].review : undefined,
    selection: match ? selectionFromMatchChoice(match, flowValue.lineRef) : undefined,
    ...(match?.automatic === true ? { automatic_selection: true } : {}),
    ...(householdSelection !== undefined
      ? { household_portion_selection: householdSelection }
      : {}),
  };
}

/** Version-neutral household evidence accessor for persisted-block assertions. */
function persistedHousehold(
  block: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3,
  index = 0
): HouseholdPortionEvidence | undefined {
  const entry = block.ingredients[index] as IngredientEvidenceV2 | undefined;
  return entry?.household_portion;
}

// ---------------------------------------------------------------------------
// Registry binding contract (controlled resolver inputs)
// ---------------------------------------------------------------------------

interface RegistryOracleEntry {
  readonly key: string;
  readonly fdcIds: ReadonlyArray<number>;
  readonly unit: string;
  readonly size: string | null;
  readonly state: string | null;
  readonly grams: number;
  readonly digest: string;
}

/**
 * HARDCODED, INDEPENDENT ORACLE for the 31 published records. None of these
 * values is imported from the production registry; the test compares the
 * production dataset and the resolver against these literals.
 */
const REGISTRY_ORACLE: ReadonlyArray<RegistryOracleEntry> = Object.freeze([
  { key: 'egg|item|jumbo|null', fdcIds: [171287], unit: 'item', size: 'jumbo', state: null, grams: 63, digest: '19dddec3084ffc9da83f93716d0c0b15022f7866e5795d0ca0497d026e5e0ec6' },
  { key: 'egg|item|large|null', fdcIds: [171287], unit: 'item', size: 'large', state: null, grams: 50, digest: 'c84406093c55f00c27054aec3ff69f4ebb1d9dbb46e11138582ccf887062ac11' },
  { key: 'egg|item|medium|null', fdcIds: [171287], unit: 'item', size: 'medium', state: null, grams: 44, digest: '1164793c9895b072af7a2eceeb6d95b4703fd18115f6b713256ab5421f9b7bab' },
  { key: 'egg|item|small|null', fdcIds: [171287], unit: 'item', size: 'small', state: null, grams: 38, digest: '45ac67a3d675309131330d58edfda3d9f06bb2de7d4376ed09aef655da28d604' },
  { key: 'egg|item|xl|null', fdcIds: [171287], unit: 'item', size: 'xl', state: null, grams: 56, digest: 'd9f939cf9e07f2a93b3fcf21988c4a53963976bdbf304a5e2c8163c7b0a703cd' },
  { key: 'garlic|clove|null|null', fdcIds: [169230, 2709786], unit: 'clove', size: null, state: null, grams: 3, digest: '693c1f4116a201e61ede6c6543c0a932082e721124fe7fc66875e52348b5592c' },
  { key: 'green bell pepper|item|large|null', fdcIds: [170427, 2258588], unit: 'item', size: 'large', state: null, grams: 164, digest: '5d23f9d25cdae270ad5147bb51c4dc13fc600b307856e5928e32e2c49dcdd324' },
  { key: 'green bell pepper|item|medium|null', fdcIds: [170427, 2258588], unit: 'item', size: 'medium', state: null, grams: 119, digest: 'fbd2c3035565efe1f510e78869215cbf67fcd8d1a4d2970ea0a8a73da21fa525' },
  { key: 'green bell pepper|item|small|null', fdcIds: [170427, 2258588], unit: 'item', size: 'small', state: null, grams: 74, digest: 'f16b7180cb8a71ad5e8f93df08b47e84e04d206ac78c8d262fb7a5f8429440e5' },
  { key: 'green cabbage|head|large|null', fdcIds: [169975, 2346407], unit: 'head', size: 'large', state: null, grams: 1248, digest: 'b4bad0d52a258ca43c457a5b61fd6eba5385dbf04986402cff3d80dabfbf9ea6' },
  { key: 'green cabbage|head|medium|null', fdcIds: [169975, 2346407], unit: 'head', size: 'medium', state: null, grams: 908, digest: 'd0e59f49310cd75e49bca5d45f8d219857bd1a2335144f9db33873b26788571b' },
  { key: 'green cabbage|head|small|null', fdcIds: [169975, 2346407], unit: 'head', size: 'small', state: null, grams: 714, digest: 'd98a7e30be4c265b5dee324e7f5dd62ed1013b378fae050e086bbc65a585c17a' },
  { key: 'peach|item|large|null', fdcIds: [169928, 2709249], unit: 'item', size: 'large', state: null, grams: 175, digest: 'e8c5c70316d47c2870d9ae904a97ddb0b9294f5561fe881a21f9dc98d79d7a39' },
  { key: 'peach|item|medium|null', fdcIds: [169928, 2709249], unit: 'item', size: 'medium', state: null, grams: 150, digest: '14c9687e01d96e7aab2e7fc16b35481aeb745eae65e0b14f72bbcf0e1f602b18' },
  { key: 'peach|item|small|null', fdcIds: [169928, 2709249], unit: 'item', size: 'small', state: null, grams: 130, digest: '13edfd8e0740f47c0ac51f648232d38257f2f0e7267821259fcdb10abd66539f' },
  { key: 'red bell pepper|item|large|null', fdcIds: [170108, 2258590], unit: 'item', size: 'large', state: null, grams: 164, digest: '5f7b4fc30a185d3b3c6ea5da82e8d134c39c9aac71762e7ff031560053a491cb' },
  { key: 'red bell pepper|item|medium|null', fdcIds: [170108, 2258590], unit: 'item', size: 'medium', state: null, grams: 119, digest: '4b7cde5511267ba06a11a68d6ed37febb7f17630140f3b2fd3b220d648ace02d' },
  { key: 'red bell pepper|item|small|null', fdcIds: [170108, 2258590], unit: 'item', size: 'small', state: null, grams: 74, digest: '95705c2c881c21acc4ea0f17f7772117a22120e77ff3d5216df53bd65460a8ba' },
  { key: 'red cabbage|head|large|null', fdcIds: [169977, 2346408], unit: 'head', size: 'large', state: null, grams: 1134, digest: '3503beb69508b821874c86a167a7ffca1440dfdf065dd059c7b073c4a44470fd' },
  { key: 'red cabbage|head|medium|null', fdcIds: [169977, 2346408], unit: 'head', size: 'medium', state: null, grams: 839, digest: '46682c29f77298b2c8265d8ceff70f857bfe1228521a3b34ed7b937b0471990d' },
  { key: 'red cabbage|head|small|null', fdcIds: [169977, 2346408], unit: 'head', size: 'small', state: null, grams: 567, digest: 'bf3d898d8e5ded13b5f71ac3b68d476af9b79205141ecbe0f5ff6e6e9c9f88bd' },
  { key: 'tomato|item|large|null', fdcIds: [170457, 2709719], unit: 'item', size: 'large', state: null, grams: 182, digest: '7ac575b8f37553944b4ce98bec865cde114ded9921dfeb8046d8277b2cc8630a' },
  { key: 'tomato|item|medium|null', fdcIds: [170457, 2709719], unit: 'item', size: 'medium', state: null, grams: 123, digest: 'f3e6148d03775cc5f4f1b6c3fd11c5c3873fc8b6d7494ac1687f1e90e2753bba' },
  { key: 'tomato|item|small|null', fdcIds: [170457, 2709719], unit: 'item', size: 'small', state: null, grams: 91, digest: 'f54bee0df876bd22e32aac98fe38b8cf59007f9fd8547ae29e49839b8f4d9105' },
  { key: 'unsalted butter|stick|null|null', fdcIds: [173430, 789828], unit: 'stick', size: null, state: null, grams: 113, digest: '3a51f63e644455964b2272777f6bf9d981cada02defba7c756ae5ce0f59e9fe7' },
  { key: 'white mushroom|item|large|null', fdcIds: [169251, 2709793], unit: 'item', size: 'large', state: null, grams: 23, digest: '8928819e774d82d298ffc78cd9042fd580edac7ef1186671ffe8c1149e4cc4f3' },
  { key: 'white mushroom|item|medium|null', fdcIds: [169251, 2709793], unit: 'item', size: 'medium', state: null, grams: 18, digest: 'a48f0b49f11f2b16ac06fa95e2f08d10c644b22f7809d547db44ea4a377517f5' },
  { key: 'white mushroom|item|small|null', fdcIds: [169251, 2709793], unit: 'item', size: 'small', state: null, grams: 10, digest: 'e0949671c975d17551d4e33088b648ba01488def3cccfac52a268040b3a51f5d' },
  { key: 'zucchini|item|large|null', fdcIds: [169291], unit: 'item', size: 'large', state: null, grams: 323, digest: '619228836600012d8e0916b0aa6422afee46fe09fd77e6952791f45ccc62be79' },
  { key: 'zucchini|item|medium|null', fdcIds: [169291], unit: 'item', size: 'medium', state: null, grams: 196, digest: '01c3bb69acd3707afed48615542269b76f46233afeb299826f44c67dd8ea11a7' },
  { key: 'zucchini|item|small|null', fdcIds: [169291], unit: 'item', size: 'small', state: null, grams: 118, digest: '4b6f3e8d0199865420af6c001bc81e243985fb2d10cbc5f0e25453e127ea04db' },
]);

/** The fixed registry-lock identities, also hardcoded independently. */
const REGISTRY_RELEASE_ORACLE = 'household_portion_initial_usda_v1';
const REGISTRY_DIGEST_ORACLE =
  '6ad593ef558ca9325197549f005da5b1eee822211f2ec6b5290f5c58fedc4ac4';
const PROVENANCE_DIGEST_ORACLE =
  'adba614327f9cb078ffd35d6abade50b25de180b43f4b373eea6ab8825694b31';
const AGGREGATE_RELEASE_DIGEST_ORACLE =
  'f8fed2230ac210c8dc2548f3a300134091c3a490ac6eb68add2766ac9b85b256';

/** Builds a CONTROLLED resolver input expressing one canonical key. */
function controlledInput(entry: RegistryOracleEntry): Record<string, unknown> {
  const name = entry.size !== null ? `${entry.size} household test food` : 'household test food';
  return {
    original: `1 ${name}`,
    amount: 1,
    ...(entry.unit !== 'item' ? { unit: entry.unit } : {}),
    name,
    line_ref: 'record-resolution',
  };
}

describe('phase 6 — registry binding contract (controlled resolver inputs)', () => {
  it('the production registry contains exactly the 31 hardcoded keys and lock identities', () => {
    const loaded = loadHouseholdInitialRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const records = loaded.registry.records();
    expect(records.length).toBe(REGISTRY_ORACLE.length);
    expect(REGISTRY_ORACLE.length).toBe(31);
    expect(loaded.dataset.registry_release).toBe(REGISTRY_RELEASE_ORACLE);
    expect(loaded.dataset.registry_digest).toBe(REGISTRY_DIGEST_ORACLE);
    expect(loaded.dataset.provenance_digest).toBe(PROVENANCE_DIGEST_ORACLE);
    expect(loaded.dataset.aggregate_release_digest).toBe(AGGREGATE_RELEASE_DIGEST_ORACLE);

    const byKey = new Map(
      records.map((record) => [
        `${record.food_key}|${record.household_unit}|${record.size_class ?? 'null'}|${
          record.requires_state ?? 'null'
        }`,
        record,
      ])
    );
    expect(byKey.size).toBe(REGISTRY_ORACLE.length);
    for (const entry of REGISTRY_ORACLE) {
      const record = byKey.get(entry.key);
      expect(record, entry.key).toBeDefined();
      if (!record) continue;
      expect(
        [...record.usda_fdc_ids],
        `${entry.key} fdc ids`
      ).toEqual([...entry.fdcIds]);
      expect(record.household_unit, `${entry.key} unit`).toBe(entry.unit);
      expect(record.size_class, `${entry.key} size`).toBe(entry.size);
      expect(record.requires_state, `${entry.key} state`).toBe(entry.state);
      expect(record.grams_per_unit, `${entry.key} grams`).toBe(entry.grams);
      expect(record.record_digest, `${entry.key} digest`).toBe(entry.digest);
      expect(record.authority_class, `${entry.key} authority`).toBe('usda_derived');
    }
  });

  it('every record resolves ONLY under its exact authenticated key with exact grams', () => {
    const loaded = loadHouseholdInitialRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    for (const entry of REGISTRY_ORACLE) {
      for (const fdcId of entry.fdcIds) {
        const usda = bundle.get(fdcId);
        expect(usda, `${entry.key} usda ${fdcId}`).toBeDefined();
        if (!usda) continue;
        const resolution = resolveHouseholdPortion({
          ingredient: controlledInput(entry),
          fdcId,
          usdaRecordDigest: usda.record_digest,
          bundleRelease: loaded.dataset.source_bundle_release,
        });
        expect(resolution, `${entry.key} fdc=${fdcId}`).toBeDefined();
        if (!resolution) continue;
        expect(resolution.household_record_key).toBe(entry.key);
        expect(resolution.usda_fdc_id).toBe(fdcId);
        expect(resolution.usda_record_digest).toBe(usda.record_digest);
        expect(resolution.household_record_digest).toBe(entry.digest);
        expect(resolution.household_unit).toBe(entry.unit);
        expect(resolution.size_class).toBe(entry.size);
        expect(resolution.requires_state).toBe(entry.state);
        expect(resolution.grams_per_unit).toBe(entry.grams);
        expect(resolution.resolved_grams).toBe(entry.grams);
        expect(resolution.registry_release).toBe(REGISTRY_RELEASE_ORACLE);
        expect(resolution.registry_digest).toBe(REGISTRY_DIGEST_ORACLE);
        expect(resolution.provenance_digest).toBe(PROVENANCE_DIGEST_ORACLE);
        expect(resolution.aggregate_release_digest).toBe(AGGREGATE_RELEASE_DIGEST_ORACLE);
        expect(resolution.authority_class).toBe('usda_derived');
        expect(resolution.derivation).toBe('authenticated_exact_conversion');
      }
    }
  });

  it('a controlled key never binds under a wrong unit, size, state, or unbound FDC', () => {
    const garlic = REGISTRY_ORACLE.find((entry) => entry.key === 'garlic|clove|null|null');
    const tomato = REGISTRY_ORACLE.find((entry) => entry.key === 'tomato|item|medium|null');
    expect(garlic && tomato).toBeDefined();
    if (!garlic || !tomato) return;
    const garlicUsda = bundle.get(169230);
    const tomatoUsda = bundle.get(170457);
    expect(garlicUsda && tomatoUsda).toBeDefined();
    if (!garlicUsda || !tomatoUsda) return;
    const resolve = (ingredient: unknown, fdcId: number, digest: string) =>
      resolveHouseholdPortion({
        ingredient,
        fdcId,
        usdaRecordDigest: digest,
        bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
      });

    expect(resolve(controlledInput(garlic), 999999, garlicUsda.record_digest)).toBeUndefined();
    expect(
      resolve(
        { original: '1 cooked clove household test food', amount: 1, unit: 'clove', name: 'cooked clove household test food' },
        169230,
        garlicUsda.record_digest
      )
    ).toBeUndefined();
    expect(
      resolve(
        { original: '1 huge household test food', amount: 1, name: 'huge household test food' },
        170457,
        tomatoUsda.record_digest
      )
    ).toBeUndefined();
    // The USDA record digest must be supplied and non-empty.
    expect(
      resolve(controlledInput(tomato), 170457, '')
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real pipeline reachability and precedence
// ---------------------------------------------------------------------------

type ReachabilityClass =
  | 'household_reachable'
  | 'shadowed_by_count_portion'
  | 'identity_review_blocked'
  | 'parser_limitation_blocked';

interface RealLineExpectation {
  readonly line: string;
  readonly classification: ReachabilityClass;
  readonly fdc: number | null;
  readonly massSource: string | null;
  readonly grams: number | null;
}

/**
 * REAL recipe lines through the REAL pipeline. `1 large egg`, `1 medium white
 * mushroom`, and `1 head large red cabbage` are SHADOWED by an authenticated
 * USDA count portion, and `1 medium zucchini` is blocked at IDENTITY review
 * (review_required, no deterministic selection) — in both cases no household
 * choice is created, which is the correct authority behavior, not a gap.
 * `1 large head red cabbage` is a PARSER limitation (see below).
 */
const REAL_LINE_EXPECTATIONS: ReadonlyArray<RealLineExpectation> = Object.freeze([
  { line: '3 cloves garlic', classification: 'household_reachable', fdc: 169230, massSource: 'household_portion', grams: 9 },
  { line: '3 garlic cloves, minced', classification: 'household_reachable', fdc: 169230, massSource: 'household_portion', grams: 9 },
  { line: '2 medium tomatoes, sliced', classification: 'household_reachable', fdc: 2709719, massSource: 'household_portion', grams: 246 },
  { line: '1 stick unsalted butter', classification: 'household_reachable', fdc: 789828, massSource: 'household_portion', grams: 113 },
  { line: '1 large egg', classification: 'shadowed_by_count_portion', fdc: 2707152, massSource: 'count_portion', grams: 50 },
  { line: '1 medium white mushroom', classification: 'shadowed_by_count_portion', fdc: 169251, massSource: 'count_portion', grams: 18 },
  { line: '1 medium zucchini', classification: 'identity_review_blocked', fdc: null, massSource: null, grams: null },
  { line: '1 medium peach', classification: 'household_reachable', fdc: 2709249, massSource: 'household_portion', grams: 150 },
  { line: '1 large red bell pepper', classification: 'household_reachable', fdc: 2258590, massSource: 'household_portion', grams: 164 },
  { line: '1 large green bell pepper', classification: 'household_reachable', fdc: 2258588, massSource: 'household_portion', grams: 164 },
  { line: '1 head large red cabbage', classification: 'shadowed_by_count_portion', fdc: 169977, massSource: 'count_portion', grams: 1134 },
  { line: '1 large head red cabbage', classification: 'parser_limitation_blocked', fdc: 169977, massSource: null, grams: null },
]);

describe('phase 6 — real pipeline reachability and precedence', () => {
  it('classifies every required ordinary line by identity and mass authority', () => {
    for (const expected of REAL_LINE_EXPECTATIONS) {
      const value = flow(expected.line);
      const analyzed = value.analysis.rows[0];
      const preview = value.analysis.preview?.ingredients[0];
      const live = liveOf(value, value.state);
      const calculated = calculate(value, value.state);
      expect(calculated.ok, expected.line).toBe(true);

      expect(analyzed.selected_fdc_id ?? null, `${expected.line} identity`).toBe(expected.fdc);
      expect(preview?.mass_source ?? null, `${expected.line} mass`).toBe(expected.massSource);
      expect(preview?.resolved_grams ?? null, `${expected.line} grams`).toBe(expected.grams);
      // Live projection and calculation agree exactly.
      expect(live.mass_source ?? null, `${expected.line} live mass`).toBe(expected.massSource);
      expect(live.resolved_grams ?? null, `${expected.line} live grams`).toBe(expected.grams);

      if (expected.classification === 'household_reachable') {
        expect(
          value.analysis.householdPortions[value.lineRef],
          `${expected.line} household choice`
        ).toBeDefined();
        expect(live.mass_source, expected.line).toBe('household_portion');
        expect(summarizeLiveRows(project(value, value.state)).matched, expected.line).toBe(1);
      } else if (expected.classification === 'shadowed_by_count_portion') {
        // The higher USDA count authority is active; a household choice must NOT
        // be created (no second mass source, no conflict).
        expect(
          value.analysis.householdPortions[value.lineRef],
          `${expected.line} must not create a household choice`
        ).toBeUndefined();
        expect(value.state.countPortions[value.lineRef], expected.line).toBeUndefined();
        expect(value.state.householdPortions[value.lineRef], expected.line).toBeUndefined();
        expect(summarizeLiveRows(project(value, value.state)).matched, expected.line).toBe(1);
      } else if (expected.classification === 'identity_review_blocked') {
        expect(analyzed.status, expected.line).toBe('matched_check');
        expect(
          value.analysis.householdPortions[value.lineRef],
          `${expected.line} identity is not authenticated, so no household authority`
        ).toBeUndefined();
        expect(live.status, expected.line).toBe('review_suggested');
        expect(live.resolved_grams, expected.line).toBeUndefined();
        expect(summarizeLiveRows(project(value, value.state)).needs_amount, expected.line).toBe(0);
      } else {
        // parser_limitation_blocked
        expect(
          value.analysis.householdPortions[value.lineRef],
          `${expected.line} parser limitation must not become household mass`
        ).toBeUndefined();
        expect(analyzed.status, expected.line).toBe('needs_amount');
        expect(preview?.outcome, expected.line).toBe('no_mass');
        expect(live.resolved_grams, expected.line).toBeUndefined();
      }
    }
  }, 120000);

  it('documents the parser limitation on adjective-before-unit lines', () => {
    // `1 large head red cabbage` parses `head` as a preparation qualifier (the
    // size adjective comes first), so no canonical count unit/size is derived.
    // The household resolver then treats the line as a size-only item request
    // and the item-mapping token scan refuses to reinterpret the named `head`
    // unit as one whole item: no mass is invented.
    expect(deriveHouseholdLookupContext(structuredLine('1 large head red cabbage'))).toBeUndefined();
    // The unit-first ordering parses a canonical `head` unit + `large` size, and
    // the count authority resolves it before household is ever considered.
    expect(deriveHouseholdLookupContext(structuredLine('1 head large red cabbage'))).toEqual({
      quantity: 1,
      household_unit: 'head',
      size_class: 'large',
      requires_state: null,
    });
  });

  it('resolves the three measured household lines with the pinned grams', () => {
    const measured: ReadonlyArray<[string, number, string]> = [
      ['3 cloves garlic, minced', 9, 'garlic|clove|null|null'],
      ['2 medium tomatoes, sliced', 246, 'tomato|item|medium|null'],
      ['1 stick unsalted butter', 113, 'unsalted butter|stick|null|null'],
    ];
    for (const [line, grams, key] of measured) {
      const value = flow(line);
      const calculated = calculate(value, value.state);
      expect(calculated.ok, line).toBe(true);
      if (!calculated.ok) continue;
      const evidence = calculated.preview.ingredients[0];
      expect(evidence.mass_source, line).toBe('household_portion');
      expect(evidence.resolved_grams, line).toBe(grams);
      expect(evidence.household_record_key, line).toBe(key);
      // NUTRIENT AUTHORITY: household provenance authorizes ONLY the mass. The
      // nutrient totals must still derive from the AUTHENTICATED USDA record's
      // per-100-g values applied to the household grams.
      const usda = bundle.get(evidence.fdc_id as number);
      expect(usda, line).toBeDefined();
      if (!usda) continue;
      const nutrientId = (Object.keys(usda.nutrients) as NutrientId[]).find(
        (id) => calculated.preview.totals[id] !== undefined
      );
      expect(nutrientId, line).toBeDefined();
      if (!nutrientId) continue;
      const nutrient = usda.nutrients[nutrientId];
      expect(nutrient, line).toBeDefined();
      if (!nutrient) continue;
      const expected = (nutrient.amount_per_100g * grams) / 100;
      const total = calculated.preview.totals[nutrientId]?.amount;
      expect(total, line).toBeDefined();
      if (typeof total !== 'number') continue;
      expect(Math.abs(total - expected), line).toBeLessThan(0.01);
    }
  });

  it('scales exactly with the recipe quantity and is deterministic on repeat', () => {
    const one = flow('1 clove garlic');
    const three = flow('3 cloves garlic');
    const first = calculate(three, three.state);
    const again = calculate(three, three.state);
    expect(one.analysis.preview?.ingredients[0].resolved_grams).toBe(3);
    expect(three.analysis.preview?.ingredients[0].resolved_grams).toBe(9);
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(first.preview.ingredients[0].resolved_grams).toBe(9);
      expect(again.preview.ingredients[0].resolved_grams).toBe(9);
      expect(again.preview.ingredients[0].household_selection_digest).toBe(
        first.preview.ingredients[0].household_selection_digest
      );
    }
  });

  it('derives its lookup context only through the existing canonical contracts', () => {
    expect(deriveHouseholdLookupContext(structuredLine('1-2 cloves garlic'))).toBeUndefined();
    expect(deriveHouseholdLookupContext(structuredLine('1 can tomatoes'))).toBeUndefined();
    expect(deriveHouseholdLookupContext(structuredLine('2 medium tomatoes'))).toEqual({
      quantity: 2,
      household_unit: 'item',
      size_class: 'medium',
      requires_state: null,
    });
    expect(deriveHouseholdLookupContext(structuredLine('3 cloves garlic'))).toEqual({
      quantity: 3,
      household_unit: 'clove',
      size_class: null,
      requires_state: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Effective-mass precedence
// ---------------------------------------------------------------------------

describe('phase 6 — effective-mass precedence', () => {
  it('keeps household as the lowest authority and fails conflicts closed', () => {
    const base = { directMassGrams: undefined as number | undefined };
    expect(
      resolveEffectiveMassDecision({
        ...base,
        hasUserMass: false,
        hasSourcePortion: false,
        hasCountPortion: false,
        hasHouseholdPortion: true,
      })
    ).toEqual({ kind: 'household_portion' });
    expect(
      resolveEffectiveMassDecision({
        ...base,
        hasUserMass: true,
        hasSourcePortion: false,
        hasCountPortion: false,
        hasHouseholdPortion: true,
      })
    ).toEqual({ kind: 'conflict', reason: 'multiple_sources' });
    expect(
      resolveEffectiveMassDecision({
        ...base,
        hasUserMass: false,
        hasSourcePortion: true,
        hasCountPortion: false,
        hasHouseholdPortion: true,
      })
    ).toEqual({ kind: 'conflict', reason: 'multiple_sources' });
    expect(
      resolveEffectiveMassDecision({
        ...base,
        hasUserMass: false,
        hasSourcePortion: false,
        hasCountPortion: true,
        hasHouseholdPortion: true,
      })
    ).toEqual({ kind: 'conflict', reason: 'multiple_sources' });
    expect(
      resolveEffectiveMassDecision({
        directMassGrams: 100,
        hasUserMass: false,
        hasSourcePortion: false,
        hasCountPortion: false,
        hasHouseholdPortion: true,
      })
    ).toEqual({ kind: 'conflict', reason: 'direct_mass_with_household_portion' });
    expect(
      resolveEffectiveMassDecision({
        directMassGrams: 100,
        hasUserMass: true,
        hasSourcePortion: true,
        hasCountPortion: false,
        hasHouseholdPortion: true,
      })
    ).toEqual({ kind: 'conflict', reason: 'direct_mass_with_multiple_alternates' });
  });

  it('never applies household when a higher stored source exists', () => {
    const garlic = flow('3 cloves garlic');
    expect(garlic.state.householdPortions[garlic.lineRef]).toBeDefined();
    const calculated = calculate(garlic, garlic.state);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(evidence.mass_source).toBe('household_portion');
    expect(evidence.resolved_grams).toBe(9);

    // Selecting a USDA count choice clears the household choice in the reducer,
    // and the calculator then resolves from the HIGHER authority.
    const match = garlic.state.matches[garlic.lineRef];
    const countReview = session.reviewCountPortions(
      garlic.adapted[0].ingredient,
      evidence.fdc_id as number,
      { unit: 'clove', size: null }
    );
    expect(countReview.ok).toBe(true);
    if (!countReview.ok) return;
    const built = buildCountPortionChoice(session, {
      lineRef: garlic.lineRef,
      ingredient: garlic.adapted[0].ingredient,
      review: garlic.rows[0].review,
      selection: match ? selectionFromMatchChoice(match, garlic.lineRef) : undefined,
      automaticSelection: match?.automatic === true,
      fdcId: evidence.fdc_id as number,
      portionIndex: countReview.review.candidates[0].index,
      countRequirementHint: { unit: 'clove', size: null },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const state = phase4Reducer(garlic.state, {
      type: 'select_count_portion',
      lineRef: garlic.lineRef,
      choice: built.choice,
    });
    expect(state.householdPortions[garlic.lineRef]).toBeUndefined();
    const countCalc = calculate(garlic, state);
    expect(countCalc.ok).toBe(true);
    if (!countCalc.ok) return;
    expect(countCalc.preview.ingredients[0].mass_source).toBe('count_portion');
    expect(countCalc.preview.ingredients[0].resolved_grams).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Selection binding / forgery
// ---------------------------------------------------------------------------

function validChoice(flowValue: Flow): HouseholdPortionChoice {
  const match = flowValue.state.matches[flowValue.lineRef];
  const built = buildHouseholdPortionChoice(session, {
    lineRef: flowValue.lineRef,
    ingredient: flowValue.adapted[0].ingredient,
    review: flowValue.rows[0].outcome === 'review_required' ? flowValue.rows[0].review : undefined,
    selection: match ? selectionFromMatchChoice(match, flowValue.lineRef) : undefined,
    automaticSelection: match?.automatic === true,
    fdcId: flowValue.analysis.rows[0].selected_fdc_id as number,
  });
  if (!built.ok) throw new Error('household choice build failed');
  return built.choice;
}

function selectionOf(choice: HouseholdPortionChoice): HouseholdPortionSelection {
  return choice.selection as HouseholdPortionSelection;
}

/**
 * Builds a genuinely authenticated manual `MatchChoice` for one line (record
 * digest from the pinned catalog), optionally marked AI-assisted. Used to test
 * the working-row provenance and the mass-source mutual exclusion.
 */
function manualMatchFor(
  flowValue: Flow,
  fdcId: number,
  options: { aiAccepted?: boolean } = {}
): MatchChoice {
  const search = session.searchFoods(String(fdcId), 1);
  if (!search.ok) throw new Error('search failed');
  const hit = search.results.find((result) => result.fdc_id === fdcId && result.exact_fdc_id);
  if (!hit) throw new Error('authenticated hit missing');
  return Object.freeze({
    kind: 'manual' as const,
    fdc_id: fdcId,
    review_digest: flowValue.rows[0].review_digest ?? '',
    record_digest: hit.record_digest,
    catalog_digest: session.metadata().catalog_digest,
    ...(options.aiAccepted === true ? { aiAccepted: true } : {}),
    description: hit.description,
  });
}

describe('phase 6 — selection binding and forgery', () => {
  it('stores a closed, digest-bound selection the calculator independently verifies', () => {
    const garlic = flow('3 cloves garlic');
    const choice = validChoice(garlic);
    const selection = selectionOf(choice);
    expect(selection.household_selection_version).toBe(HOUSEHOLD_PORTION_SELECTION_VERSION);
    expect(selection.line_ref).toBe(garlic.lineRef);
    expect(selection.usda_fdc_id).toBe(169230);
    expect(selection.registry_release).toBe(REGISTRY_RELEASE_ORACLE);
    expect(selection.registry_digest).toBe(REGISTRY_DIGEST_ORACLE);
    expect(selection.provenance_digest).toBe(PROVENANCE_DIGEST_ORACLE);
    expect(selection.aggregate_release_digest).toBe(AGGREGATE_RELEASE_DIGEST_ORACLE);
    expect(selection.household_record_key).toBe('garlic|clove|null|null');
    expect(selection.quantity).toBe(3);
    expect(selection.resolved_grams).toBe(9);
    expect(selection.selection_digest).toMatch(/^[0-9a-f]{64}$/);

    const result = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [lineInput(garlic, selection)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.ingredients[0].mass_source).toBe('household_portion');
    expect(result.preview.ingredients[0].resolved_grams).toBe(9);
    expect(result.preview.ingredients[0].household_record_key).toBe('garlic|clove|null|null');
  });

  it('withholds every single-field tampered/forged selection from the calculator', () => {
    const garlic = flow('3 cloves garlic');
    const selection = { ...selectionOf(validChoice(garlic)) } as Record<string, unknown>;
    const mutations: Array<[string, unknown]> = [
      ['line_ref', 'forged-line'],
      ['ingredient_identity_digest', 'forged-digest'],
      ['bundle_release', 'forged-release'],
      ['usda_fdc_id', 999999],
      ['usda_record_digest', 'f'.repeat(64)],
      ['registry_release', 'forged-registry'],
      ['registry_digest', 'f'.repeat(64)],
      ['provenance_digest', 'f'.repeat(64)],
      ['aggregate_release_digest', 'f'.repeat(64)],
      ['household_record_key', 'forged|key|null|null'],
      ['household_record_digest', 'f'.repeat(64)],
      ['household_unit', 'slice'],
      ['size_class', 'large'],
      ['requires_state', 'cooked'],
      ['quantity', 4],
      ['resolved_grams', 12],
      ['selection_digest', 'f'.repeat(64)],
    ];
    for (const [field, value] of mutations) {
      // Recompute the selection digest so the closed-shape digest check passes
      // and the SEMANTIC binding comparisons are genuinely exercised.
      const base = { ...selection };
      delete (base as Record<string, unknown>).selection_digest;
      const mutatedBase = { ...base, [field]: value };
      const digest =
        field === 'selection_digest'
          ? value
          : computeHouseholdPortionSelectionDigest(mutatedBase as never);
      const tampered = { ...mutatedBase, selection_digest: digest };
      const result = session.calculate({
        servings: 1,
        nutrient_scope: ['calories'],
        ingredients: [lineInput(garlic, tampered)],
      });
      expect(result.ok, field).toBe(false);
    }
  });

  it('withholds a forged selection from the live row, summary, hydration, and Apply identically', () => {
    const garlic = flow('3 cloves garlic');
    const choice = validChoice(garlic);
    const selection = { ...selectionOf(choice), resolved_grams: 12 };
    const forgedChoice: HouseholdPortionChoice = Object.freeze({
      ...choice,
      resolved_grams: 12,
      selection,
    });
    const state = phase4Reducer(garlic.state, {
      type: 'select_household_portion',
      lineRef: garlic.lineRef,
      choice: forgedChoice,
    });

    const live = liveOf(garlic, state);
    expect(live.resolved_grams).toBeUndefined();
    expect(live.mass_source).toBeUndefined();
    expect(live.status).toBe('needs_amount');
    const summary = summarizeLiveRows(project(garlic, state));
    expect(summary.matched).toBe(0);
    expect(summary.needs_amount).toBe(1);

    const calculated = calculate(garlic, state);
    expect(calculated.ok).toBe(false);

    // Hydration never restores a household choice whose binding cannot be
    // reproduced; and it never becomes a user mass.
    const authorized = authorizeReady(garlic, garlic.state);
    const block = authorize(garlic, authorized);
    const mutatedBlock = JSON.parse(JSON.stringify(block)) as CodexNutritionV2;
    const householdEvidence = persistedHousehold(mutatedBlock) as unknown as
      | Record<string, unknown>
      | undefined;
    if (householdEvidence) {
      householdEvidence.registry_release = 'forged-registry';
    }
    const hydrated = hydrateWorkingReview({
      session,
      adapted: garlic.adapted,
      rows: garlic.rows,
      savedBlock: mutatedBlock,
    });
    expect(hydrated?.householdPortions[garlic.lineRef]).toBeUndefined();
    expect(hydrated?.userMasses[garlic.lineRef]).toBeUndefined();
  });

  it('rejects a household selection combined with any higher source at the calculator', () => {
    const garlic = flow('3 cloves garlic');
    const selection = selectionOf(validChoice(garlic));
    const withCount = session.calculate({
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [
        {
          ...lineInput(garlic, selection),
          count_portion_selection: {
            count_portion_version: 'usda_count_portion_v2',
            calculation_version: 'usda_advisory_calc_v4',
            line_ref: garlic.lineRef,
            ingredient_identity_digest: 'x',
            bundle_release: 'x',
            catalog_digest: 'x',
            fdc_id: 169230,
            record_digest: 'x',
            candidates_digest: 'x',
            portion_index: 0,
            portion_amount: 1,
            gram_weight: 3,
            measure: 'undetermined',
            count_unit: 'clove',
            count_size: null,
            selection_digest: 'x',
          },
        },
      ],
    });
    expect(withCount.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-2: analyzer calculated-line guard
// ---------------------------------------------------------------------------

describe('phase 6 — analyzer calculated-line guard', () => {
  it('never creates a household choice for a line the first preview already resolved', () => {
    // direct recipe mass
    const direct = flow('100 g garlic');
    expect(direct.analysis.householdPortions[direct.lineRef]).toBeUndefined();
    expect(direct.analysis.preview?.ingredients[0].mass_source).toBe('direct_mass');
    expect(direct.analysis.preview?.ingredients[0].resolved_grams).toBe(100);
    expect(direct.state.householdPortions[direct.lineRef]).toBeUndefined();
    const directLive = liveOf(direct, direct.state);
    expect(directLive.mass_source).toBe('direct_mass');
    expect(directLive.resolved_grams).toBe(100);
    const directCalc = calculate(direct, direct.state);
    expect(directCalc.ok).toBe(true);
    if (directCalc.ok) expect(directCalc.preview.ingredients[0].mass_source).toBe('direct_mass');

    // USDA source portion
    const source = flow('1 cup garlic');
    expect(source.analysis.householdPortions[source.lineRef]).toBeUndefined();
    expect(source.analysis.preview?.ingredients[0].mass_source).toBe('source_portion');
    expect(source.analysis.preview?.ingredients[0].resolved_grams).toBe(136);
    expect(source.state.householdPortions[source.lineRef]).toBeUndefined();
    const sourceLive = liveOf(source, source.state);
    expect(sourceLive.mass_source).toBe('source_portion');
    expect(sourceLive.resolved_grams).toBe(136);
    const sourceCalc = calculate(source, source.state);
    expect(sourceCalc.ok).toBe(true);
    if (sourceCalc.ok) expect(sourceCalc.preview.ingredients[0].mass_source).toBe('source_portion');

    // USDA count portion (three independent shadowed lines)
    for (const [line, fdc, grams] of [
      ['1 large egg', 2707152, 50],
      ['1 medium white mushroom', 169251, 18],
      ['1 head large red cabbage', 169977, 1134],
    ] as ReadonlyArray<[string, number, number]>) {
      const value = flow(line);
      expect(value.analysis.householdPortions[value.lineRef], line).toBeUndefined();
      expect(value.analysis.rows[0].selected_fdc_id, line).toBe(fdc);
      expect(value.analysis.preview?.ingredients[0].mass_source, line).toBe('count_portion');
      expect(value.analysis.preview?.ingredients[0].resolved_grams, line).toBe(grams);
      expect(value.state.householdPortions[value.lineRef], line).toBeUndefined();
      const live = liveOf(value, value.state);
      expect(live.mass_source, line).toBe('count_portion');
      expect(live.resolved_grams, line).toBe(grams);
      const calculated = calculate(value, value.state);
      expect(calculated.ok, line).toBe(true);
      if (calculated.ok) {
        expect(calculated.preview.ingredients[0].mass_source, line).toBe('count_portion');
        expect(calculated.preview.ingredients[0].resolved_grams, line).toBe(grams);
      }
    }
  });

  it('never applies a household choice when a valid user mass is active for the line', () => {
    // The analyzer never sees stored user mass (it is a working-state edit), so
    // the equivalent guard is the effective-mass authority plus the reducer's
    // mutual exclusion: a valid user mass always wins over household, and the
    // reducer removes the household choice when the user mass is stored.
    const garlic = flow('3 cloves garlic');
    expect(garlic.state.householdPortions[garlic.lineRef]).toBeDefined();
    const match = garlic.state.matches[garlic.lineRef];
    const built = buildUserMassChoice(session, {
      lineRef: garlic.lineRef,
      ingredient: garlic.adapted[0].ingredient,
      review: garlic.rows[0].review,
      selection: match ? selectionFromMatchChoice(match, garlic.lineRef) : undefined,
      fdcId: 169230,
      quantity: 12,
      unit: 'g',
      automaticSelection: match?.automatic === true,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const state = phase4Reducer(garlic.state, {
      type: 'select_user_mass',
      lineRef: garlic.lineRef,
      choice: built.choice,
    });
    expect(state.householdPortions[garlic.lineRef]).toBeUndefined();
    const live = liveOf(garlic, state);
    expect(live.mass_source).toBe('user_mass');
    expect(live.resolved_grams).toBe(12);
    const calculated = calculate(garlic, state);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.preview.ingredients[0].mass_source).toBe('user_mass');
    expect(calculated.preview.ingredients[0].resolved_grams).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// F-3: container / range guards
// ---------------------------------------------------------------------------

const CONTAINER_RANGE_LINES: ReadonlyArray<string> = Object.freeze([
  '1-2 medium tomatoes',
  '1/2-1 medium tomato',
  '1 medium can tomatoes',
  '1 medium package tomatoes',
  '1 medium cup tomatoes',
  '1 medium slice tomato',
]);

describe('phase 6 — container and range guards', () => {
  it('yields no household choice and no grams for every guarded line', () => {
    const tomatoUsda = bundle.get(170457);
    expect(tomatoUsda).toBeDefined();
    if (!tomatoUsda) return;
    for (const line of CONTAINER_RANGE_LINES) {
      expect(deriveHouseholdLookupContext(structuredLine(line)), line).toBeUndefined();
      expect(
        resolveHouseholdPortion({
          ingredient: structuredLine(line),
          fdcId: 170457,
          usdaRecordDigest: tomatoUsda.record_digest,
          bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
        }),
        line
      ).toBeUndefined();

      const value = flow(line);
      expect(value.analysis.householdPortions[value.lineRef], line).toBeUndefined();
      expect(value.state.householdPortions[value.lineRef], line).toBeUndefined();
      const preview = value.analysis.preview?.ingredients[0];
      expect(preview?.mass_source ?? null, line).toBeNull();
      expect(preview?.resolved_grams ?? null, line).toBeNull();
      const live = liveOf(value, value.state);
      expect(live.resolved_grams, line).toBeUndefined();
    }
  });

  it('also fails the explicit container forms (container parsed as the unit)', () => {
    for (const line of ['1 can tomatoes', '1 package tomatoes']) {
      expect(deriveHouseholdLookupContext(structuredLine(line)), line).toBeUndefined();
      const value = flow(line);
      expect(value.analysis.householdPortions[value.lineRef], line).toBeUndefined();
      expect(value.analysis.preview?.ingredients[0].resolved_grams ?? null, line).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// State lifecycle + F-5 invalidation
// ---------------------------------------------------------------------------

describe('phase 6 — state lifecycle', () => {
  it('populates the household choice automatically and keeps sources mutually exclusive', () => {
    const garlic = flow('3 cloves garlic');
    const household = garlic.state.householdPortions[garlic.lineRef];
    expect(household).toBeDefined();
    expect(household?.automatic).toBe(true);
    expect(household?.resolved_grams).toBe(9);

    // Selecting a portion clears the household choice.
    const portionState = phase4Reducer(garlic.state, {
      type: 'clear_portion',
      lineRef: garlic.lineRef,
    });
    expect(portionState).toBe(garlic.state); // no portion stored; no-op

    // Clearing the household choice leaves the row unresolved.
    const cleared = phase4Reducer(garlic.state, {
      type: 'clear_household_portion',
      lineRef: garlic.lineRef,
    });
    expect(cleared.householdPortions[garlic.lineRef]).toBeUndefined();
    expect(liveOf(garlic, cleared).status).toBe('needs_amount');
    expect(calculate(garlic, cleared).ok).toBe(true);
    const clearedCalc = calculate(garlic, cleared);
    if (clearedCalc.ok) {
      expect(clearedCalc.preview.ingredients[0].resolved_grams).toBeUndefined();
    }

    // Re-selecting the household choice restores the mass.
    const reselected = phase4Reducer(cleared, {
      type: 'select_household_portion',
      lineRef: garlic.lineRef,
      choice: household as HouseholdPortionChoice,
    });
    expect(liveOf(garlic, reselected).resolved_grams).toBe(9);
  });

  it('never stores a household mass the calculator would reject (direct mass gate)', () => {
    const direct = flow('100 g garlic');
    expect(direct.state.householdPortions[direct.lineRef]).toBeUndefined();
    const built = buildHouseholdPortionChoice(session, {
      lineRef: direct.lineRef,
      ingredient: direct.adapted[0].ingredient,
      fdcId: 169230,
      automaticSelection: true,
    });
    expect(built.ok).toBe(false);
  });
});

describe('phase 6 — household-choice invalidation', () => {
  function assertLiveAndCalculatedAgree(value: Flow, state: Phase4State): void {
    const live = liveOf(value, state);
    const calculated = calculate(value, state);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const evidence = calculated.preview.ingredients[0];
    expect(live.mass_source ?? null).toBe(evidence.mass_source ?? null);
    expect(live.resolved_grams ?? null).toBe(evidence.resolved_grams ?? null);
  }

  it('clears the household choice on every higher-authority selection', () => {
    // Manual USDA match change.
    const garlic = flow('3 cloves garlic');
    const match = garlic.state.matches[garlic.lineRef];
    const countReview = session.reviewCountPortions(garlic.adapted[0].ingredient, 169230, {
      unit: 'clove',
      size: null,
    });
    expect(countReview.ok).toBe(true);
    if (!countReview.ok) return;
    const countBuilt = buildCountPortionChoice(session, {
      lineRef: garlic.lineRef,
      ingredient: garlic.adapted[0].ingredient,
      review: garlic.rows[0].review,
      selection: match ? selectionFromMatchChoice(match, garlic.lineRef) : undefined,
      automaticSelection: match?.automatic === true,
      fdcId: 169230,
      portionIndex: countReview.review.candidates[0].index,
      countRequirementHint: { unit: 'clove', size: null },
    });
    expect(countBuilt.ok).toBe(true);
    if (!countBuilt.ok) return;

    const userMassBuilt = buildUserMassChoice(session, {
      lineRef: garlic.lineRef,
      ingredient: garlic.adapted[0].ingredient,
      review: garlic.rows[0].review,
      selection: match ? selectionFromMatchChoice(match, garlic.lineRef) : undefined,
      fdcId: 169230,
      quantity: 12,
      unit: 'g',
      automaticSelection: match?.automatic === true,
    });
    expect(userMassBuilt.ok).toBe(true);
    if (!userMassBuilt.ok) return;

    const manualMatch = manualMatchFor(garlic, 169230);

    const actions: ReadonlyArray<[string, Parameters<typeof phase4Reducer>[1]]> = [
      ['select_match', { type: 'select_match', lineRef: garlic.lineRef, choice: manualMatch }],
      ['select_count_portion', { type: 'select_count_portion', lineRef: garlic.lineRef, choice: countBuilt.choice }],
      ['select_user_mass', { type: 'select_user_mass', lineRef: garlic.lineRef, choice: userMassBuilt.choice }],
    ];
    for (const [label, action] of actions) {
      const next = phase4Reducer(garlic.state, action);
      expect(next.householdPortions[garlic.lineRef], label).toBeUndefined();
      expect(next.status, label).toBe('preview_stale');
      assertLiveAndCalculatedAgree(garlic, next);
    }
  });

  it('invalidates on recipe quantity, unit, size, and state edits (new line identity)', () => {
    const base = flow('3 cloves garlic');
    expect(base.state.householdPortions[base.lineRef]).toBeDefined();

    const edits = [
      ['2 cloves garlic', 6],
      ['1 clove garlic', 3],
      ['3 garlic cloves, minced', 9],
    ] as ReadonlyArray<[string, number]>;
    for (const [line, grams] of edits) {
      const value = flow(line);
      expect(value.lineRef, line).not.toBe(base.lineRef);
      // The new line resolves through its OWN freshly verified choice; the old
      // choice's line_ref can never apply to it.
      expect(value.analysis.householdPortions[base.lineRef], line).toBeUndefined();
      expect(value.analysis.preview?.ingredients[0].resolved_grams, line).toBe(grams);
      expect(liveOf(value, value.state).resolved_grams, line).toBe(grams);
    }

    // Unit/state edits that cannot bind fail closed with no mass at all.
    for (const line of ['1 cup unsalted butter', '1 cooked stick unsalted butter']) {
      const value = flow(line);
      expect(value.analysis.householdPortions[value.lineRef], line).toBeUndefined();
      expect(value.analysis.preview?.ingredients[0].resolved_grams ?? null, line).toBeNull();
      expect(liveOf(value, value.state).resolved_grams, line).toBeUndefined();
    }
  });

  it('a re-analysis replaces the household map and never resurrects a cleared choice', () => {
    const garlic = flow('3 cloves garlic');
    const cleared = phase4Reducer(garlic.state, {
      type: 'clear_household_portion',
      lineRef: garlic.lineRef,
    });
    expect(cleared.householdPortions[garlic.lineRef]).toBeUndefined();

    // A plain analyzer run for the SAME recipe re-derives a fresh verified
    // choice; a stale action carrying the OLD object cannot override a newer
    // clear because the reducer replaces the whole map.
    const reanalyzed = phase4Reducer(cleared, {
      type: 'apply_analysis',
      matches: garlic.analysis.matches,
      portions: garlic.analysis.portions,
      countPortions: garlic.analysis.countPortions,
      householdPortions: garlic.analysis.householdPortions,
      preview: garlic.analysis.preview,
    });
    expect(reanalyzed.householdPortions[garlic.lineRef]).toBeDefined();
    expect(liveOf(garlic, reanalyzed).resolved_grams).toBe(9);

    const reanalyzedEmpty = phase4Reducer(reanalyzed, {
      type: 'apply_analysis',
      matches: garlic.analysis.matches,
      portions: garlic.analysis.portions,
      countPortions: garlic.analysis.countPortions,
      householdPortions: {},
      preview: garlic.analysis.preview,
    });
    expect(reanalyzedEmpty.householdPortions[garlic.lineRef]).toBeUndefined();
    expect(liveOf(garlic, reanalyzedEmpty).resolved_grams).toBeUndefined();
    assertLiveAndCalculatedAgree(garlic, reanalyzedEmpty);
  });

  it('resets all household state on recipe/session replacement', () => {
    const garlic = flow('3 cloves garlic');
    expect(garlic.state.householdPortions[garlic.lineRef]).toBeDefined();
    const replaced = phase4Reducer(garlic.state, {
      type: 'initialize',
      recipeKey: 'a-different-recipe',
      sessionIdentity: 'a-different-session',
      rows: garlic.rows,
      baseServings: 1,
    });
    expect(replaced.householdPortions).toEqual({});
    expect(replaced.userMasses).toEqual({});
    expect(replaced.recipeKey).toBe('a-different-recipe');
  });

  it('a stale in-flight analysis response never restores a cleared household choice', () => {
    const garlic = flow('3 cloves garlic');
    const cleared = phase4Reducer(garlic.state, {
      type: 'clear_household_portion',
      lineRef: garlic.lineRef,
    });
    expect(cleared.status).toBe('preview_stale');
    // Apply is not eligible while the preview is stale.
    expect(isPreviewCurrent(cleared)).toBe(false);

    // Stale preview result (older operation sequence) is ignored.
    const stalePreview = phase4Reducer(cleared, {
      type: 'preview_succeeded',
      seq: cleared.operationSeq - 1,
      recipeKey: cleared.recipeKey,
      preview: garlic.analysis.preview as never,
    });
    expect(stalePreview).toBe(cleared);
    expect(stalePreview.householdPortions[garlic.lineRef]).toBeUndefined();

    // A live-verified preview for the current sequence restores eligibility but
    // never a household choice.
    const calculated = calculate(garlic, cleared);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const current = phase4Reducer(cleared, {
      type: 'preview_succeeded',
      seq: cleared.operationSeq,
      recipeKey: cleared.recipeKey,
      preview: calculated.preview,
    });
    expect(isPreviewCurrent(current)).toBe(true);
    expect(current.householdPortions[garlic.lineRef]).toBeUndefined();
    expect(liveOf(garlic, current).resolved_grams).toBeUndefined();

    // Stale evidence from the PRE-clear preview must not resurrect the mass even
    // though the live projection is given that evidence.
    const staleEvidence = {
      line_ref: garlic.lineRef,
      original_text: '3 cloves garlic',
      outcome: 'calculated' as const,
      match_status: 'auto_confirmed' as const,
      user_confirmed: false,
      fdc_id: 169230,
      record_digest: undefined,
      mass_source: 'household_portion' as const,
      resolved_grams: 9,
      portion_index: undefined,
      count_ingredient_amount: undefined,
      count_portion_amount: undefined,
      count_gram_weight: undefined,
      count_unit: undefined,
      count_size: undefined,
      count_deterministic: undefined,
      user_mass_quantity: undefined,
      user_mass_unit: undefined,
      household_unit: 'clove',
      household_size_class: undefined,
      household_requires_state: undefined,
      household_authority_class: 'usda_derived',
      contributing_nutrients: [],
    };
    const liveWithStaleEvidence = projectLiveRows(
      current,
      new Map(garlic.analysis.rows.map((row) => [row.line_ref, row])),
      garlic.adapted,
      session,
      [staleEvidence]
    )[0];
    expect(liveWithStaleEvidence.resolved_grams).toBeUndefined();
    expect(liveWithStaleEvidence.mass_source).toBeUndefined();
    expect(liveWithStaleEvidence.status).toBe('needs_amount');
  });

  it('a stale AI response for an edited line never restores a household choice', () => {
    const garlic = flow('3 cloves garlic');
    const match = garlic.state.matches[garlic.lineRef];
    const edited = flow('2 cloves garlic');
    // The AI response targets the OLD line ref; the edited recipe no longer has
    // that row, so the reducer refuses the stale choice entirely.
    const staleChoice: MatchChoice = Object.freeze({
      kind: 'manual',
      fdc_id: 169230,
      review_digest: garlic.rows[0].review_digest ?? '',
      record_digest: match?.record_digest,
      catalog_digest: session.metadata().catalog_digest,
      aiAssisted: true,
      description: 'Garlic, raw',
    });
    const next = phase4Reducer(edited.state, {
      type: 'select_match',
      lineRef: garlic.lineRef,
      choice: staleChoice,
    });
    expect(next).toBe(edited.state);
    expect(next.householdPortions[edited.lineRef]).toBeDefined();
    expect(next.householdPortions[edited.lineRef]?.resolved_grams).toBe(6);
    expect(next.matches[edited.lineRef]?.fdc_id).toBe(169230);
  });
});

// ---------------------------------------------------------------------------
// Persistence / reopen / schema v2
// ---------------------------------------------------------------------------

function authorizeReady(flowValue: Flow, state: Phase4State): Phase4State {
  const calculated = calculate(flowValue, state);
  if (!calculated.ok) throw new Error('preview failed');
  return {
    ...state,
    status: 'preview_current',
    preview: calculated.preview,
    previewKey: state.recipeKey,
  } as Phase4State;
}

function authorize(flowValue: Flow, state: Phase4State): CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3 {
  const result = authorizeNutritionPersistence({
    session,
    recipe: flowValue.recipe,
    state,
  });
  if (!result.ok) {
    throw new Error(
      `authorize failed: ${JSON.stringify((result as { failure: { code: string } }).failure)}`
    );
  }
  return result.candidate.block;
}

describe('phase 6 — persistence, schema v2, and reopen', () => {
  it('persists a household line as canonical schema v2 with truthful provenance', () => {
    const garlic = flow('3 cloves garlic');
    const state = authorizeReady(garlic, garlic.state);
    const block = authorize(garlic, state);
    expect(block.schema).toBe(2);
    const evidence = block.ingredients.find((entry) => entry.line_ref === garlic.lineRef);
    expect(evidence?.conversion_basis).toBe('household_portion');
    expect(evidence?.amount?.value).toBe(9);
    const saved = persistedHousehold(block);
    expect(saved?.registry_release).toBe(REGISTRY_RELEASE_ORACLE);
    expect(saved?.record_key).toBe('garlic|clove|null|null');
    expect(saved?.household_unit).toBe('clove');
    expect(saved?.quantity).toBe(3);

    // Codec round-trip preserves the household evidence under schema v2.
    const encoded = encodeCodexNutrition(block);
    expect(encoded.schema).toBe(2);
    const decoded = decodeCodexNutrition(encoded);
    expect(decoded.kind).toBe('v2');
    if (decoded.kind !== 'v2') return;
    expect(persistedHousehold(decoded.value)?.record_key).toBe('garlic|clove|null|null');

    // Reopen re-authenticates the registry and restores the same household result.
    const hydrated = hydrateWorkingReview({
      session,
      adapted: garlic.adapted,
      rows: garlic.rows,
      savedBlock: block,
    });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    const restored = hydrated.householdPortions[garlic.lineRef];
    expect(restored).toBeDefined();
    expect(restored?.resolved_grams).toBe(9);
    expect(hydrated.userMasses[garlic.lineRef]).toBeUndefined();
    const reopenedState = phase4Reducer(garlic.state, {
      type: 'hydrate',
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      householdPortions: hydrated.householdPortions,
    });
    expect(liveOf(garlic, reopenedState).resolved_grams).toBe(9);
    expect(liveOf(garlic, reopenedState).mass_source).toBe('household_portion');
  });

  it('writes canonical schema v1 when no household line exists', () => {
    const direct = flow('100 g garlic');
    const directBlock = authorize(direct, authorizeReady(direct, direct.state));
    expect(directBlock.schema).toBe(1);
    expect(directBlock.ingredients[0].conversion_basis).toBe('direct_mass');
    expect(persistedHousehold(directBlock)).toBeUndefined();

    const userFlow = flow('3 cloves garlic');
    const userMatch = userFlow.state.matches[userFlow.lineRef];
    const userMass = buildUserMassChoice(session, {
      lineRef: userFlow.lineRef,
      ingredient: userFlow.adapted[0].ingredient,
      review: userFlow.rows[0].review,
      selection: userMatch ? selectionFromMatchChoice(userMatch, userFlow.lineRef) : undefined,
      fdcId: 169230,
      quantity: 7,
      unit: 'g',
      automaticSelection: userMatch?.automatic === true,
    });
    expect(userMass.ok).toBe(true);
    if (!userMass.ok) return;
    const userState = phase4Reducer(userFlow.state, {
      type: 'select_user_mass',
      lineRef: userFlow.lineRef,
      choice: userMass.choice,
    });
    const userBlock = authorize(userFlow, authorizeReady(userFlow, userState));
    expect(userBlock.schema).toBe(1);
    expect(userBlock.ingredients[0].conversion_basis).toBeUndefined();
    expect(persistedHousehold(userBlock)).toBeUndefined();
  });

  it('returns to canonical schema v1 when the household line is removed', () => {
    const garlic = flow('3 cloves garlic');
    const householdBlock = authorize(garlic, authorizeReady(garlic, garlic.state));
    expect(householdBlock.schema).toBe(2);

    const cleared = phase4Reducer(garlic.state, {
      type: 'clear_household_portion',
      lineRef: garlic.lineRef,
    });
    const reauthorized = authorize(garlic, authorizeReady(garlic, cleared));
    expect(reauthorized.schema).toBe(1);
    expect(persistedHousehold(reauthorized)).toBeUndefined();
    expect(reauthorized.ingredients[0]?.conversion_basis).toBeUndefined();
    expect(reauthorized.unresolved[0]?.reason).toBe('no_mass');

    // Deterministic: repeating the same transition yields the same schema.
    const again = authorize(garlic, authorizeReady(garlic, cleared));
    expect(again.schema).toBe(1);
  });

  it('leaves the row NEEDS AMOUNT (never user mass) when the household binding is stale', () => {
    const garlic = flow('3 cloves garlic');
    const block = authorize(garlic, authorizeReady(garlic, garlic.state));
    const mutations: Array<(block: CodexNutritionV2) => void> = [
      (b) => {
        const h = persistedHousehold(b) as unknown as Record<string, unknown> | undefined;
        if (h) h.registry_release = 'other_registry';
      },
      (b) => {
        const h = persistedHousehold(b) as unknown as Record<string, unknown> | undefined;
        if (h) h.record_digest = 'f'.repeat(64);
      },
      (b) => {
        const h = persistedHousehold(b) as unknown as Record<string, unknown> | undefined;
        if (h) h.quantity = 4;
      },
      (b) => {
        (b.ingredients[0] as unknown as Record<string, unknown>).amount = { value: 12, unit: 'g' };
      },
      (b) => {
        delete (b.ingredients[0] as unknown as Record<string, unknown>).household_portion;
      },
    ];
    for (const mutate of mutations) {
      const mutated = JSON.parse(JSON.stringify(block)) as CodexNutritionV2;
      mutate(mutated);
      const hydrated = hydrateWorkingReview({
        session,
        adapted: garlic.adapted,
        rows: garlic.rows,
        savedBlock: mutated,
      });
      // The food identity may restore, but the household mass must not — and it
      // never degrades into a user-entered mass or a USDA portion.
      expect(hydrated?.householdPortions[garlic.lineRef]).toBeUndefined();
      expect(hydrated?.userMasses[garlic.lineRef]).toBeUndefined();
      expect(hydrated?.portions[garlic.lineRef]).toBeUndefined();
      expect(hydrated?.countPortions[garlic.lineRef]).toBeUndefined();
    }
  });

  it('keeps genuine schema-v1 user mass, direct mass, and source portions compatible', () => {
    // User mass (basis omitted) persists under v1 and still reopens as user_mass.
    const userFlow = flow('3 cloves garlic');
    const userMatch = userFlow.state.matches[userFlow.lineRef];
    const built = buildUserMassChoice(session, {
      lineRef: userFlow.lineRef,
      ingredient: userFlow.adapted[0].ingredient,
      review: userFlow.rows[0].review,
      selection: userMatch ? selectionFromMatchChoice(userMatch, userFlow.lineRef) : undefined,
      fdcId: 169230,
      quantity: 7,
      unit: 'g',
      automaticSelection: userMatch?.automatic === true,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const state = phase4Reducer(userFlow.state, {
      type: 'select_user_mass',
      lineRef: userFlow.lineRef,
      choice: built.choice,
    });
    expect(state.householdPortions[userFlow.lineRef]).toBeUndefined();
    const block = authorize(userFlow, authorizeReady(userFlow, state));
    expect(block.schema).toBe(1);
    expect(block.ingredients[0].conversion_basis).toBeUndefined();
    const hydrated = hydrateWorkingReview({
      session,
      adapted: userFlow.adapted,
      rows: userFlow.rows,
      savedBlock: block,
    });
    expect(hydrated?.userMasses[userFlow.lineRef]).toBeDefined();
    expect(hydrated?.householdPortions[userFlow.lineRef]).toBeUndefined();

    // Direct mass persists as direct_mass under v1 and reopens with no working
    // mass choice.
    const directFlow = flow('100 g garlic');
    const directBlock = authorize(directFlow, authorizeReady(directFlow, directFlow.state));
    expect(directBlock.schema).toBe(1);
    expect(directBlock.ingredients[0].conversion_basis).toBe('direct_mass');
    const directHydrated = hydrateWorkingReview({
      session,
      adapted: directFlow.adapted,
      rows: directFlow.rows,
      savedBlock: directBlock,
    });
    expect(directHydrated?.householdPortions[directFlow.lineRef]).toBeUndefined();
  });

  it('fails closed on an unknown conversion basis or unknown household evidence field', () => {
    const garlic = flow('3 cloves garlic');
    const block = authorize(garlic, authorizeReady(garlic, garlic.state));
    const unknownBasis = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
    (unknownBasis.ingredients as Array<Record<string, unknown>>)[0].conversion_basis = 'density';
    const decodedUnknown = decodeCodexNutrition(unknownBasis);
    expect(decodedUnknown.kind).toBe('malformed');

    const unknownField = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
    const evidence = (unknownField.ingredients as Array<Record<string, unknown>>)[0];
    (evidence.household_portion as Record<string, unknown>).future_field = 1;
    const decodedField = decodeCodexNutrition(unknownField);
    expect(decodedField.kind).toBe('malformed');

    const missingEvidence = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
    delete ((missingEvidence.ingredients as Array<Record<string, unknown>>)[0]).household_portion;
    const decodedMissing = decodeCodexNutrition(missingEvidence);
    expect(decodedMissing.kind).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// F-6: persisted vs working provenance (`user_confirmed` semantics)
// ---------------------------------------------------------------------------

describe('phase 6 — user_confirmed semantics and provenance labels', () => {
  it('an automatic household resolution is never displayed as manual, user-entered, or AI', () => {
    const garlic = flow('3 cloves garlic');
    const live = liveOf(garlic, garlic.state);
    expect(live.mass_source).toBe('household_portion');
    // The garlic line is a review_required deterministic auto-candidate: its live
    // food authority is `automatic`, never `user_confirmed`.
    expect(live.food_authority).toBe('automatic');
    expect(garlic.state.userMasses[garlic.lineRef]).toBeUndefined();
    const label = massSourceLabel({
      line_ref: garlic.lineRef,
      original_text: '3 cloves garlic',
      outcome: 'calculated',
      match_status: 'unique_exact',
      user_confirmed: false,
      fdc_id: 169230,
      mass_source: 'household_portion',
      resolved_grams: 9,
      portion_index: undefined,
      count_ingredient_amount: undefined,
      count_portion_amount: undefined,
      count_gram_weight: undefined,
      count_unit: undefined,
      count_size: undefined,
      count_deterministic: undefined,
      user_mass_quantity: undefined,
      user_mass_unit: undefined,
      household_unit: live.household_unit,
      household_size_class: live.household_size_class,
      household_requires_state: live.household_requires_state,
      household_authority_class: live.household_authority_class,
      contributing_nutrients: [],
    });
    expect(label).toContain('Kitchen Codex household portion');
    expect(label).not.toMatch(/user-entered|user-confirmed|AI-assisted|USDA portion/i);
  });

  it('after Apply, persisted user_confirmed means "authorized by Apply" and not user mass', () => {
    const garlic = flow('3 cloves garlic');
    const block = authorize(garlic, authorizeReady(garlic, garlic.state));
    const evidence = block.ingredients[0];
    // The established persisted-schema contract: `confirmed` / `resolved: true`
    // / `user_confirmed: true` means "this evidence was part of the explicit
    // reviewed result the user authorized for Apply".
    expect(evidence.match_status).toBe('confirmed');
    expect(evidence.resolved).toBe(true);
    expect(evidence.user_confirmed).toBe(true);
    // It is NOT a user mass: the household basis + evidence are persisted, and
    // the grams are the household grams.
    expect(evidence.conversion_basis).toBe('household_portion');
    expect(evidence.amount).toEqual({ value: 9, unit: 'g' });
    expect(persistedHousehold(block)?.quantity).toBe(3);
    // The working formula for the same line is unrelated to the persisted field.
    expect(garlic.state.userMasses[garlic.lineRef]).toBeUndefined();
  });

  it('reopen restores household mass with no user mass and the household label', () => {
    const garlic = flow('3 cloves garlic');
    const block = authorize(garlic, authorizeReady(garlic, garlic.state));
    const hydrated = hydrateWorkingReview({
      session,
      adapted: garlic.adapted,
      rows: garlic.rows,
      savedBlock: block,
    });
    expect(hydrated).toBeDefined();
    if (!hydrated) return;
    expect(hydrated.userMasses[garlic.lineRef]).toBeUndefined();
    const reopened = phase4Reducer(garlic.state, {
      type: 'hydrate',
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      householdPortions: hydrated.householdPortions,
    });
    const live = liveOf(garlic, reopened);
    expect(live.mass_source).toBe('household_portion');
    expect(live.household_unit).toBe('clove');
    expect(live.household_authority_class).toBe('usda_derived');
    expect(live.resolved_grams).toBe(9);
    // Reopen must keep the truthful household label: the restored mass is never
    // presented as user-entered or USDA portion.
    const label = massSourceLabel({
      line_ref: live.line_ref,
      original_text: live.original_text,
      outcome: 'calculated',
      match_status: 'confirmed',
      user_confirmed: true,
      fdc_id: live.selected_fdc_id as number,
      mass_source: live.mass_source,
      resolved_grams: live.resolved_grams,
      portion_index: undefined,
      count_ingredient_amount: undefined,
      count_portion_amount: undefined,
      count_gram_weight: undefined,
      count_unit: undefined,
      count_size: undefined,
      count_deterministic: undefined,
      user_mass_quantity: undefined,
      user_mass_unit: undefined,
      household_unit: live.household_unit,
      household_size_class: live.household_size_class,
      household_requires_state: live.household_requires_state,
      household_authority_class: live.household_authority_class,
      contributing_nutrients: [],
    });
    expect(label).toContain('Kitchen Codex household portion');
    expect(label).not.toMatch(/user-entered|USDA portion|AI-assisted/i);
  });

  it('a manual user mass keeps the user-entered label and is never household', () => {
    const garlic = flow('3 cloves garlic');
    const match = garlic.state.matches[garlic.lineRef];
    const built = buildUserMassChoice(session, {
      lineRef: garlic.lineRef,
      ingredient: garlic.adapted[0].ingredient,
      review: garlic.rows[0].review,
      selection: match ? selectionFromMatchChoice(match, garlic.lineRef) : undefined,
      fdcId: 169230,
      quantity: 7,
      unit: 'g',
      automaticSelection: match?.automatic === true,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const state = phase4Reducer(garlic.state, {
      type: 'select_user_mass',
      lineRef: garlic.lineRef,
      choice: built.choice,
    });
    const live = liveOf(garlic, state);
    expect(live.mass_source).toBe('user_mass');
    expect(live.user_mass_quantity).toBe(7);
    expect(live.user_mass_unit).toBe('g');
    expect(state.householdPortions[garlic.lineRef]).toBeUndefined();
    // The manual user mass keeps its OWN label and is never called household.
    const label = massSourceLabel({
      line_ref: live.line_ref,
      original_text: live.original_text,
      outcome: 'calculated',
      match_status: 'confirmed',
      user_confirmed: true,
      fdc_id: live.selected_fdc_id as number,
      mass_source: live.mass_source,
      resolved_grams: live.resolved_grams,
      portion_index: undefined,
      count_ingredient_amount: undefined,
      count_portion_amount: undefined,
      count_gram_weight: undefined,
      count_unit: undefined,
      count_size: undefined,
      count_deterministic: undefined,
      user_mass_quantity: live.user_mass_quantity,
      user_mass_unit: live.user_mass_unit,
      household_unit: live.household_unit,
      household_size_class: live.household_size_class,
      household_requires_state: live.household_requires_state,
      household_authority_class: live.household_authority_class,
      contributing_nutrients: [],
    });
    expect(label).toBe('user-entered total weight · 7 g');
    expect(label).not.toMatch(/household/i);
    const block = authorize(garlic, authorizeReady(garlic, state));
    expect(persistedHousehold(block)).toBeUndefined();
    const hydrated = hydrateWorkingReview({
      session,
      adapted: garlic.adapted,
      rows: garlic.rows,
      savedBlock: block,
    });
    expect(hydrated?.userMasses[garlic.lineRef]).toBeDefined();
    expect(hydrated?.householdPortions[garlic.lineRef]).toBeUndefined();
  });

  it('a manual food choice plus household mass keeps distinct identity/mass provenance', () => {
    const garlic = flow('3 cloves garlic');
    const manualMatch = manualMatchFor(garlic, 169230);
    let state = phase4Reducer(garlic.state, {
      type: 'select_match',
      lineRef: garlic.lineRef,
      choice: manualMatch,
    });
    expect(state.householdPortions[garlic.lineRef]).toBeUndefined();
    // Rebuild the household mass for the explicitly chosen food.
    const rebuilt = buildHouseholdPortionChoice(session, {
      lineRef: garlic.lineRef,
      ingredient: garlic.adapted[0].ingredient,
      review: garlic.rows[0].review,
      selection: selectionFromMatchChoice(manualMatch, garlic.lineRef),
      fdcId: 169230,
    });
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    state = phase4Reducer(state, {
      type: 'select_household_portion',
      lineRef: garlic.lineRef,
      choice: rebuilt.choice,
    });
    const live = liveOf(garlic, state);
    expect(live.food_authority).toBe('user_confirmed');
    expect(live.mass_source).toBe('household_portion');
    expect(live.resolved_grams).toBe(9);

    const block = authorize(garlic, authorizeReady(garlic, state));
    // Persisted user_confirmed: true still means "authorized by Apply"; the mass
    // provenance remains household_portion.
    expect(block.ingredients[0].user_confirmed).toBe(true);
    expect(block.ingredients[0].conversion_basis).toBe('household_portion');
    expect(persistedHousehold(block)?.quantity).toBe(3);
  });

  it('AI-assisted food identity plus household mass stays AI-assisted for identity', () => {
    const garlic = flow('3 cloves garlic');
    const aiMatch = manualMatchFor(garlic, 169230, { aiAccepted: true });
    let state = phase4Reducer(garlic.state, {
      type: 'select_match',
      lineRef: garlic.lineRef,
      choice: aiMatch,
    });
    expect(state.householdPortions[garlic.lineRef]).toBeUndefined();
    const rebuilt = buildHouseholdPortionChoice(session, {
      lineRef: garlic.lineRef,
      ingredient: garlic.adapted[0].ingredient,
      review: garlic.rows[0].review,
      selection: selectionFromMatchChoice(aiMatch, garlic.lineRef),
      fdcId: 169230,
    });
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    state = phase4Reducer(state, {
      type: 'select_household_portion',
      lineRef: garlic.lineRef,
      choice: rebuilt.choice,
    });
    const live = liveOf(garlic, state);
    expect(live.food_authority).toBe('ai_assisted');
    expect(live.mass_source).toBe('household_portion');
    const calculated = calculate(garlic, state);
    expect(calculated.ok).toBe(true);
    if (calculated.ok) {
      expect(calculated.preview.ingredients[0].match_status).toBe('auto_confirmed');
      expect(calculated.preview.ingredients[0].user_confirmed).toBe(false);
      expect(calculated.preview.ingredients[0].mass_source).toBe('household_portion');
    }
  });

  it('an automatic (analyzer) candidate household line is not user-confirmed in the live row', () => {
    const garlic = flow('3 cloves garlic');
    // The garlic line is a review_required auto-candidate; its live food
    // authority must be `automatic`, never `user_confirmed`.
    const live = liveOf(garlic, garlic.state);
    expect(live.food_authority).toBe('automatic');
    const calculated = calculate(garlic, garlic.state);
    expect(calculated.ok).toBe(true);
    if (calculated.ok) {
      expect(calculated.preview.ingredients[0].match_status).toBe('auto_confirmed');
      expect(calculated.preview.ingredients[0].user_confirmed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Display evidence
// ---------------------------------------------------------------------------

describe('phase 6 — UI evidence language', () => {
  it('labels household evidence truthfully and never as USDA/user/AI data', () => {
    const base = {
      line_ref: 'l1',
      original_text: '3 cloves garlic',
      outcome: 'calculated',
      match_status: 'user_confirmed',
      user_confirmed: false,
      fdc_id: 169230,
      mass_source: 'household_portion',
      resolved_grams: 9,
      portion_index: undefined,
      count_ingredient_amount: undefined,
      count_portion_amount: undefined,
      count_gram_weight: undefined,
      count_unit: undefined,
      count_size: undefined,
      count_deterministic: undefined,
      user_mass_quantity: undefined,
      user_mass_unit: undefined,
      contributing_nutrients: [],
    } as const;
    const derived = {
      ...base,
      household_unit: 'clove',
      household_size_class: undefined,
      household_requires_state: undefined,
      household_authority_class: 'usda_derived',
    };
    const label = massSourceLabel(derived);
    expect(label).toContain('Kitchen Codex household portion');
    expect(label).toContain('clove');
    expect(label).not.toMatch(/USDA portion|user-entered|AI/i);
    expect(householdPortionEvidenceLabel(derived)).toBe('Kitchen Codex household portion · clove');
  });

  it('DISPLAY-BRANCH ONLY: a bounded_estimate label is synthetic-tested (no production record)', () => {
    // There is NO Phase 5 production record with authority_class
    // `bounded_estimate`: all 31 records are `usda_derived`. This test exercises
    // the future estimate DISPLAY branch only. There is no end-to-end production
    // estimate path; a future estimate record requires its own data review, lock
    // update, audit, and production acceptance test.
    const estimate = {
      line_ref: 'l1',
      original_text: 'synthetic estimate',
      outcome: 'calculated',
      match_status: 'confirmed',
      user_confirmed: false,
      fdc_id: 1,
      mass_source: 'household_portion',
      resolved_grams: 10,
      portion_index: undefined,
      count_ingredient_amount: undefined,
      count_portion_amount: undefined,
      count_gram_weight: undefined,
      count_unit: undefined,
      count_size: undefined,
      count_deterministic: undefined,
      user_mass_quantity: undefined,
      user_mass_unit: undefined,
      household_unit: 'item',
      household_size_class: undefined,
      household_requires_state: undefined,
      household_authority_class: 'bounded_estimate',
      contributing_nutrients: [],
    } as const;
    expect(householdPortionEvidenceLabel(estimate)).toContain('estimate');
    expect(householdPortionEvidenceLabel(estimate)).not.toMatch(/USDA portion|user-entered|AI/i);
  });
});
