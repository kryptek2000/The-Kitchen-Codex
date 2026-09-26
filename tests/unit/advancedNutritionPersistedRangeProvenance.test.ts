/**
 * The Kitchen Codex — Advanced Nutrition: PERSISTED written-mass-range
 * provenance (schema v3) end-to-end regression.
 *
 * FLAG repair (persisted range provenance): a written mass range (`3-4 lb`) is
 * resolved through the documented deterministic MIDPOINT policy, and the
 * persisted `codex_nutrition` evidence must keep that provenance so a
 * block-only consumer can distinguish a midpoint-derived gram amount from an
 * exact author-written scalar (`3.5 lb`).
 *
 * Proves:
 *   - Analyze -> Review -> Apply -> serialize -> reload for `3-4 lb beef chuck
 *     roast`: schema v3, `range_representative` = written_mass_range/midpoint
 *     with both authored endpoints, the authored unit, and the SAME canonical
 *     grams as the stored `amount`; the original ingredient text survives; the
 *     nutrition totals are unchanged; the reopened UI row still describes the
 *     mass as a written-range midpoint;
 *   - `3.5 lb beef chuck roast` stays an exact schema-v1 scalar with NO range
 *     metadata and identical totals;
 *   - household-only results remain schema v2 (no silent v3 migration), and a
 *     household + range block is v3 retaining its household evidence;
 *   - legacy v1/v2 blocks without the marker remain readable, and re-Apply
 *     deterministically returns to the smallest truthful version;
 *   - the schema gate rejects every malformed marker coupling;
 *   - neither a caller-supplied preview, nor an AI-assisted selection, nor a
 *     hostile existing block can inject or alter the persisted provenance.
 *
 * The USDA session is the REAL pinned bundle. All lines are ordinary recipe
 * text; no food-specific production logic exists.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { projectLiveRows, type LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import { readStoredBlock } from '../../src/core/nutritionV2/phase4/stored';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5/authorize';
import {
  decodeCodexNutrition,
  encodeCodexNutrition,
  validateCodexNutrition,
  validateCodexNutritionV1,
  validateCodexNutritionV2,
  validateCodexNutritionV3,
} from '../../src/core/nutritionV2/validate';
import { resolveRecipeNutritionPresentation } from '../../src/core/nutritionV2/phase5c/presentation';
import { applyAdvancedNutrition } from '../../src/application/advancedNutritionApply';
import {
  parseObsidianRecipeMarkdown,
  serializeRecipeToObsidianMarkdown,
} from '../../src/utils/markdownParser';
import { resolveRecipeVaultPath } from '../../src/core/vaultPath';
import { liveMassText } from '../../src/components/AdvancedNutritionModal';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import type {
  CodexNutritionV1,
  CodexNutritionV2,
  CodexNutritionV3,
  WrittenMassRangeEvidence,
} from '../../src/core/nutritionV2/schema';
import type { ObsidianRecipe } from '../../src/types';

const BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

const RANGE_LINE = '3-4 lb beef chuck roast, cut into 2"-3" chunks';
const EXACT_LINE = '3.5 lb beef chuck roast';
const PROVOLONE_RANGE_LINE = '3 to 4 slices provolone (about 75 to 100 grams in total)';
const HOUSEHOLD_LINE = '3 cloves garlic, minced';
const SCOPE = ['calories', 'protein', 'fat'] as const;

/** `(3 + 4) / 2 * 453.59237` — the exact deterministic midpoint for `3-4 lb`. */
const MIDPOINT_3_4_LB = 1587.573295;

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) throw new Error('session failed');
  session = result.session;
}, 180000);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

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

function recipeFor(
  lines: ReadonlyArray<string>,
  overrides: Partial<ObsidianRecipe> = {}
): ObsidianRecipe {
  return {
    id: 'persisted-range',
    fileName: 'Persisted Range.md',
    filePath: 'Recipes/Persisted Range.md',
    rawMarkdown: '',
    title: 'Persisted Range',
    tags: ['food/recipes'],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: lines.map(structuredLine) as never,
    instructions: [{ stepNumber: 1, text: 'Cook.' }] as never,
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
    ...overrides,
  } as unknown as ObsidianRecipe;
}

interface Reviewed {
  readonly recipe: ObsidianRecipe;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly state: Phase4State;
}

/**
 * Builds a genuine reviewed state: deterministic analyzer matches are applied,
 * then the current preview is produced by the genuine session. This is exactly
 * the working state the Apply boundary re-proves.
 */
function buildReviewed(recipe: ObsidianRecipe): Reviewed {
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const baseServings = recipe.servings as number;
  const analysis = analyzeRecipe(session, adapted, baseServings);
  const rows = buildReviewRows(session, adapted);
  const base = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    baseServings,
    rows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: baseServings,
    preview: null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as unknown as Phase4State;
  const calculated = session.calculate({
    ...(buildCalculationRequest(adapted, base) as Record<string, unknown>),
    nutrient_scope: [...SCOPE],
  });
  if (!calculated.ok) {
    throw new Error(
      `calculation failed: ${(calculated as { ok: false; failure: { code: string } }).failure.code}`
    );
  }
  const state = {
    ...base,
    status: 'preview_current',
    preview: calculated.preview,
    previewKey: base.recipeKey,
  } as unknown as Phase4State;
  return { recipe, adapted, state };
}

function failureCodeOf(result: Awaited<ReturnType<typeof applyAdvancedNutrition>>): string {
  return result.ok ? 'ok' : (result as { ok: false; failure: { code: string } }).failure.code;
}

function authFailureCode(result: ReturnType<typeof authorizeNutritionPersistence>): string {
  return result.ok ? 'ok' : (result as { failure: { code: string } }).failure.code;
}

function authorize(reviewed: Reviewed) {
  const frontmatter = (reviewed.recipe as { frontmatter?: Record<string, unknown> }).frontmatter;
  const existingBlock = frontmatter?.codex_nutrition;
  return authorizeNutritionPersistence({
    session,
    recipe: reviewed.recipe,
    state: reviewed.state,
    ...(existingBlock !== undefined ? { existingBlock } : {}),
  });
}

function candidateOf(reviewed: Reviewed): CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3 {
  const result = authorize(reviewed);
  if (!result.ok) {
    throw new Error(
      `authorize failed: ${JSON.stringify((result as { failure: { code: string } }).failure)}`
    );
  }
  return result.candidate.block;
}

interface FakeVault {
  readonly files: Map<string, string>;
  readonly writes: ObsidianRecipe[];
  write(recipe: ObsidianRecipe): Promise<void>;
  readBack(recipe: ObsidianRecipe): Promise<string>;
}

function makeVault(): FakeVault {
  const files = new Map<string, string>();
  const writes: ObsidianRecipe[] = [];
  return {
    files,
    writes,
    async write(recipe: ObsidianRecipe) {
      writes.push(recipe);
      files.set(resolveRecipeVaultPath(recipe), serializeRecipeToObsidianMarkdown(recipe));
    },
    async readBack(recipe: ObsidianRecipe) {
      const text = files.get(resolveRecipeVaultPath(recipe));
      if (text === undefined) throw new Error('missing');
      return text;
    },
  };
}

async function applyAndPersist(reviewed: Reviewed): Promise<{ vault: FakeVault; markdown: string }> {
  const vault = makeVault();
  const result = await applyAdvancedNutrition({
    session,
    recipe: reviewed.recipe,
    state: reviewed.state,
    write: vault.write,
    readBack: vault.readBack,
    expectedMode: 'create',
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('apply failed');
  const markdown = vault.files.get(resolveRecipeVaultPath(reviewed.recipe));
  if (markdown === undefined) throw new Error('no persisted markdown');
  return { vault, markdown };
}

/** Re-decodes a persisted markdown file exactly as the application load path does. */
function reload(markdown: string, recipe: ObsidianRecipe) {
  const parsed = parseObsidianRecipeMarkdown(markdown, recipe.fileName, recipe.filePath);
  return parsed;
}

/** Re-projects the live rows of a reloaded recipe through genuine hydration. */
function liveRowsAfterReload(
  recipe: ObsidianRecipe,
  savedBlock: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3
): ReadonlyArray<LiveRowState> {
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const hydrated = hydrateWorkingReview({ session, adapted, rows, savedBlock });
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity(session.metadata()),
    rows,
    baseServings: adaptation.recipe.base_servings,
  });
  if (hydrated) {
    state = phase4Reducer(state, {
      type: 'hydrate',
      matches: hydrated.matches,
      portions: hydrated.portions,
      countPortions: hydrated.countPortions,
      userMasses: hydrated.userMasses,
      householdPortions: hydrated.householdPortions,
    });
  }
  const calculated = session.calculate(buildCalculationRequest(adapted, state));
  return projectLiveRows(
    state,
    new Map(),
    adapted,
    session,
    calculated.ok ? ingredientEvidenceViews(calculated.preview) : null,
    state.portions,
    state.countPortions
  );
}

function markerOf(
  block: CodexNutritionV1 | CodexNutritionV2 | CodexNutritionV3
): WrittenMassRangeEvidence | undefined {
  return (block.ingredients[0] as { range_representative?: WrittenMassRangeEvidence })
    .range_representative;
}

// ---------------------------------------------------------------------------
// BLOCKING — `3-4 lb` survives Analyze -> Review -> Apply -> serialize -> reload
// ---------------------------------------------------------------------------

describe('persisted range provenance — written range `3-4 lb`', () => {
  it('authorizes a schema-v3 candidate with canonical written-range evidence', () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const block = candidateOf(reviewed);
    expect(block.schema).toBe(3);
    const entry = block.ingredients[0] as {
      conversion_basis?: string;
      amount?: { value: number; unit: string };
      range_representative?: WrittenMassRangeEvidence;
    };
    expect(entry.conversion_basis).toBe('direct_mass');
    expect(entry.amount?.unit).toBe('g');
    expect(entry.amount?.value).toBeCloseTo(MIDPOINT_3_4_LB, 6);
    expect(entry.range_representative).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 3,
      upper: 4,
      unit: 'lb',
      representative_grams: entry.amount?.value,
    });
    expect(block.unresolved).toHaveLength(0);
    // Totals are exactly the reviewed preview totals (no calculation change).
    expect(block.nutrients.calories?.amount).toBe(reviewed.state.preview?.totals.calories?.amount);
    expect(validateCodexNutritionV3(block).ok).toBe(true);
  });

  it('survives Apply -> Markdown serialize/parse -> hydration with the endpoints, unit, policy, and grams intact', async () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const { markdown } = await applyAndPersist(reviewed);

    // The author's text is never rewritten.
    expect(markdown).toContain(RANGE_LINE);

    const parsed = reload(markdown, reviewed.recipe);
    const decoded = decodeCodexNutrition(parsed.codexNutrition);
    expect(decoded.kind).toBe('v3');
    if (decoded.kind !== 'v3') return;
    const marker = markerOf(decoded.value);
    expect(marker).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 3,
      upper: 4,
      unit: 'lb',
      representative_grams: decoded.value.ingredients[0].amount?.value,
    });
    expect(marker?.representative_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);
    expect(validateCodexNutritionV3(decoded.value).ok).toBe(true);

    // Block-only consumer: the stored block alone identifies the provenance.
    expect(marker?.amount_source).toBe('written_mass_range');
    expect(marker?.policy).toBe('midpoint');
    expect(marker?.lower).toBe(3);
    expect(marker?.upper).toBe(4);
    expect(marker?.unit).toBe('lb');
    expect(marker?.representative_grams).toBe(decoded.value.ingredients[0].amount?.value);

    // The stored block is still the recognizer/presentation authority.
    expect(readStoredBlock(parsed).kind).toBe('v3');
    const presentation = resolveRecipeNutritionPresentation(parsed);
    expect(presentation.kind).toBe('advanced_saved');
    expect(presentation.advanced?.schema).toBe(3);

    // Reopened UI: hydration + live projection still describes the range midpoint.
    const live = liveRowsAfterReload(parsed, decoded.value);
    expect(live[0].mass_source).toBe('direct_mass');
    expect(live[0].resolved_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);
    expect(live[0].mass_representative).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 3,
      upper: 4,
      unit: 'lb',
    });
    expect(liveMassText(live[0])).toContain('written range midpoint (3–4 lb)');
    expect(liveMassText(live[0])).toMatch(/^1587\.6 g/);
  });

  it('round-trips the encoded marker through the canonical codec deterministically', () => {
    const block = candidateOf(buildReviewed(recipeFor([RANGE_LINE]))) as CodexNutritionV3;
    const encoded = encodeCodexNutrition(block);
    const decoded = decodeCodexNutrition(encoded);
    expect(decoded.kind).toBe('v3');
    if (decoded.kind !== 'v3') return;
    expect(markerOf(decoded.value)).toEqual(markerOf(block));
    expect(encodeCodexNutrition(decoded.value)).toEqual(encoded);
  });

  it('carries the same evidence for a credible parenthetical total-mass range', () => {
    const block = candidateOf(buildReviewed(recipeFor([PROVOLONE_RANGE_LINE])));
    expect(block.schema).toBe(3);
    const marker = markerOf(block);
    expect(marker?.amount_source).toBe('written_mass_range');
    expect(marker?.policy).toBe('midpoint');
    expect(marker?.lower).toBe(75);
    expect(marker?.upper).toBe(100);
    expect(marker?.unit).toBe('grams');
    expect(marker?.representative_grams).toBeCloseTo(87.5, 6);
    expect(marker?.representative_grams).toBe(block.ingredients[0].amount?.value);
  });
});

// ---------------------------------------------------------------------------
// Exact authored scalar never gains range semantics
// ---------------------------------------------------------------------------

describe('persisted range provenance — exact authored scalar `3.5 lb`', () => {
  it('stays schema v1 direct mass with no marker and the same deterministic grams', () => {
    const block = candidateOf(buildReviewed(recipeFor([EXACT_LINE])));
    expect(block.schema).toBe(1);
    const entry = block.ingredients[0] as { range_representative?: unknown };
    expect(entry.range_representative).toBeUndefined();
    expect('range_representative' in entry).toBe(false);
    expect(block.ingredients[0].conversion_basis).toBe('direct_mass');
    expect(block.ingredients[0].amount?.value).toBeCloseTo(MIDPOINT_3_4_LB, 6);
  });

  it('is never promoted to midpoint semantics after Apply -> serialize -> reload', async () => {
    const reviewed = buildReviewed(recipeFor([EXACT_LINE]));
    const { markdown } = await applyAndPersist(reviewed);
    expect(markdown).toContain(EXACT_LINE);
    expect(markdown).not.toContain('range_representative');

    const parsed = reload(markdown, reviewed.recipe);
    const decoded = decodeCodexNutrition(parsed.codexNutrition);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind !== 'v1') return;
    expect(JSON.stringify(decoded.value)).not.toContain('range_representative');

    const live = liveRowsAfterReload(parsed, decoded.value);
    expect(live[0].mass_source).toBe('direct_mass');
    expect(live[0].resolved_grams).toBeCloseTo(MIDPOINT_3_4_LB, 6);
    expect(live[0].mass_representative).toBeUndefined();
    expect(liveMassText(live[0])).not.toContain('range midpoint');
  });

  it('keeps ordinary direct mass (`100 g`) marker-free and schema v1', () => {
    const block = candidateOf(buildReviewed(recipeFor(['100 g beef chuck roast'])));
    expect(block.schema).toBe(1);
    expect(markerOf(block)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Conditional write policy — v1 / v2 / v3, no silent migration
// ---------------------------------------------------------------------------

describe('persisted range provenance — conditional schema versions', () => {
  it('keeps a household-only result as schema v2 (no silent v3 promotion)', () => {
    const block = candidateOf(buildReviewed(recipeFor([HOUSEHOLD_LINE])));
    expect(block.schema).toBe(2);
    expect(block.ingredients[0].conversion_basis).toBe('household_portion');
    expect(markerOf(block)).toBeUndefined();
  });

  it('uses schema v3 when a household line and a written range coexist, retaining both', () => {
    const block = candidateOf(buildReviewed(recipeFor([RANGE_LINE, HOUSEHOLD_LINE])));
    expect(block.schema).toBe(3);
    const ranged = block.ingredients.find(
      (entry) => (entry as { range_representative?: unknown }).range_representative !== undefined
    );
    const household = block.ingredients.find(
      (entry) => entry.conversion_basis === 'household_portion'
    ) as { household_portion?: unknown } | undefined;
    expect(
      (ranged as { range_representative?: WrittenMassRangeEvidence } | undefined)
        ?.range_representative?.amount_source
    ).toBe('written_mass_range');
    expect(ranged?.conversion_basis).toBe('direct_mass');
    expect(household?.household_portion).toBeDefined();
  });

  it('deterministically returns to the smallest truthful version after the range line is dropped', () => {
    const rangedBlock = candidateOf(buildReviewed(recipeFor([RANGE_LINE, HOUSEHOLD_LINE])));
    expect(rangedBlock.schema).toBe(3);
    // The recipe is edited to an exact mass but the household line remains: the
    // next Apply is v2 (household retained, range evidence dropped).
    const edited = buildReviewed(recipeFor([EXACT_LINE, HOUSEHOLD_LINE]));
    const reApplied = candidateOf(edited);
    expect(reApplied.schema).toBe(2);
    expect(markerOf(reApplied)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Legacy compatibility — old blocks stay readable, no silent migration
// ---------------------------------------------------------------------------

describe('persisted range provenance — legacy compatibility', () => {
  it('reads a legacy v1 direct-mass block without inventing a marker', () => {
    const legacy: CodexNutritionV1 = {
      schema: 1,
      basis: 'total',
      servings: 4,
      status: 'complete',
      computed_at: '2026-01-01T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: 'fda_adult_4plus_2020',
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: 'legacy_release' },
      nutrient_scope: ['calories'],
      nutrients: {
        calories: {
          amount: 1587,
          unit: 'kcal',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 1,
        },
      },
      ingredients: [
        {
          line_ref: 'legacy-line',
          source: 'usda_fdc',
          source_food_id: '171077',
          source_release: 'legacy_release',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
          amount: { value: 1587, unit: 'g' },
          conversion_basis: 'direct_mass',
        },
      ],
      unresolved: [],
    };
    const decoded = decodeCodexNutrition(legacy);
    expect(decoded.kind).toBe('v1');
    if (decoded.kind !== 'v1') return;
    expect(markerOf(decoded.value)).toBeUndefined();
    expect(validateCodexNutritionV1(decoded.value).ok).toBe(true);
  });

  it('reads a legitimate legacy schema-v2 household block as v2 (never as v3)', () => {
    const block = candidateOf(buildReviewed(recipeFor([HOUSEHOLD_LINE])));
    const encoded = encodeCodexNutrition(block);
    const decoded = decodeCodexNutrition(encoded);
    expect(decoded.kind).toBe('v2');
    if (decoded.kind !== 'v2') return;
    expect(validateCodexNutritionV2(decoded.value).ok).toBe(true);
    expect(validateCodexNutrition(decoded.value).ok).toBe(true);
  });

  it('replaces a hostile pre-existing v3 block with the genuine exact-scalar v1 result', () => {
    const reviewed = buildReviewed(recipeFor([EXACT_LINE]));
    const lineRef = reviewed.adapted[0].line_ref;
    const hostile = {
      schema: 3,
      basis: 'total',
      servings: 4,
      status: 'complete',
      computed_at: '2026-01-01T00:00:00.000Z',
      ingredient_digest: `sha256:${'b'.repeat(64)}`,
      dv_standard: 'fda_adult_4plus_2020',
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: 'hostile_release' },
      nutrient_scope: ['calories'],
      nutrients: {
        calories: {
          amount: 9999,
          unit: 'kcal',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 1,
        },
      },
      ingredients: [
        {
          line_ref: lineRef,
          source: 'usda_fdc',
          source_food_id: '171077',
          source_release: 'hostile_release',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
          amount: { value: MIDPOINT_3_4_LB, unit: 'g' },
          conversion_basis: 'direct_mass',
          range_representative: {
            amount_source: 'written_mass_range',
            policy: 'midpoint',
            lower: 99,
            upper: 100,
            unit: 'lb',
            representative_grams: MIDPOINT_3_4_LB,
          },
        },
      ],
      unresolved: [],
    };
    const recipe = recipeFor([EXACT_LINE], { frontmatter: { codex_nutrition: hostile } });
    const result = authorizeNutritionPersistence({
      session,
      recipe,
      state: reviewed.state,
      existingBlock: hostile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.identity.mode).toBe('replace');
    expect(result.candidate.block.schema).toBe(1);
    expect(markerOf(result.candidate.block)).toBeUndefined();
    expect(result.candidate.block.nutrients.calories?.amount).not.toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// Digest / staleness / mutation sensitivity
// ---------------------------------------------------------------------------

describe('persisted range provenance — digest and mutation sensitivity', () => {
  const digestOf = (reviewed: Reviewed): string => {
    const result = authorize(reviewed);
    if (!result.ok) throw new Error('authorize failed');
    return result.candidate.identity.candidate_digest;
  };

  it('binds the provenance into the canonical candidate digest', () => {
    const exact = digestOf(buildReviewed(recipeFor([EXACT_LINE])));
    const range = digestOf(buildReviewed(recipeFor([RANGE_LINE])));
    const otherRange = digestOf(buildReviewed(recipeFor(['3-5 lb beef chuck roast'])));
    expect(range).not.toBe(exact);
    expect(otherRange).not.toBe(range);
    expect(otherRange).not.toBe(exact);
  });

  it('fails closed when the recipe changes between review and Apply (no write)', async () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const vault = makeVault();
    const result = await applyAdvancedNutrition({
      session,
      recipe: recipeFor([EXACT_LINE]),
      state: reviewed.state,
      write: vault.write,
    });
    expect(result.ok).toBe(false);
    expect(vault.writes).toHaveLength(0);
    expect(failureCodeOf(result)).toBe('stale_authorization');
  });

  it('detects a tampered persisted marker in the post-write verification', async () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const vault = makeVault();
    const result = await applyAdvancedNutrition({
      session,
      recipe: reviewed.recipe,
      state: reviewed.state,
      write: vault.write,
      expectedMode: 'create',
      readBack: async (recipe) => {
        const text = await vault.readBack(recipe);
        expect(text).toContain('upper: 4');
        return text.replace('upper: 4', 'upper: 5');
      },
    });
    expect(result.ok).toBe(false);
    expect(failureCodeOf(result)).toBe('post_write_verification_failed');
    // The bad write WAS performed, but the app never reports success.
    expect(vault.writes).toHaveLength(1);
  });

  it('reports a saved range block as current and a changed recipe as stale', () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const block = candidateOf(reviewed);
    const parsed = reload(serializeRecipeToObsidianMarkdown({
      ...reviewed.recipe,
      frontmatter: { codex_nutrition: encodeCodexNutrition(block) },
      codexNutrition: block,
    } as ObsidianRecipe), reviewed.recipe);
    expect(resolveRecipeNutritionPresentation(parsed).kind).toBe('advanced_saved');
    const changed = reload(
      serializeRecipeToObsidianMarkdown({
        ...recipeFor(['2 lb beef chuck roast']),
        frontmatter: { codex_nutrition: encodeCodexNutrition(block) },
        codexNutrition: block,
      } as ObsidianRecipe),
      reviewed.recipe
    );
    expect(resolveRecipeNutritionPresentation(changed).kind).toBe('advanced_stale');
  });
});

// ---------------------------------------------------------------------------
// AI / caller cannot author or alter the persisted provenance
// ---------------------------------------------------------------------------

describe('persisted range provenance — AI and caller injection fail closed', () => {
  it('ignores a forged range marker injected into the caller-supplied preview', () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const preview = reviewed.state.preview as unknown as {
      ingredients: ReadonlyArray<Record<string, unknown>>;
    };
    const forgedPreview = {
      ...(reviewed.state.preview as object),
      ingredients: preview.ingredients.map((entry) => ({
        ...entry,
        range_representative: {
          amount_source: 'written_mass_range',
          policy: 'midpoint',
          lower: 111,
          upper: 222,
          unit: 'kg',
          representative_grams: 1,
        },
      })),
    };
    const result = authorizeNutritionPersistence({
      session,
      recipe: reviewed.recipe,
      state: { ...reviewed.state, preview: forgedPreview } as unknown as Phase4State,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(markerOf(result.candidate.block)).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 3,
      upper: 4,
      unit: 'lb',
      representative_grams: result.candidate.block.ingredients[0].amount?.value,
    });
  });

  it('fails a divergent AI-assisted selection carrying forged provenance fields (nothing authorized)', () => {
    const reviewed = buildReviewed(recipeFor([EXACT_LINE]));
    const lineRef = reviewed.adapted[0].line_ref;
    const row = reviewed.state.rows[0];
    const review = row.review as
      | { candidates?: ReadonlyArray<{ fdc_id: number; record_digest: string }> }
      | undefined;
    const candidate = review?.candidates?.[0];
    expect(candidate?.record_digest).toMatch(/^[0-9a-f]{64}$/);
    if (!candidate) return;
    const forged = {
      kind: 'manual',
      fdc_id: candidate.fdc_id,
      record_digest: candidate.record_digest,
      catalog_digest: session.metadata().catalog_digest,
      line_ref: lineRef,
      review_digest: row.review_digest,
      ai_assisted: true,
      range_representative: {
        amount_source: 'written_mass_range',
        policy: 'midpoint',
        lower: 111,
        upper: 222,
        unit: 'kg',
        representative_grams: 1,
      },
    };
    // A selection that diverges from the reviewed preview can never authorize a
    // write, so no forged provenance can be persisted through it.
    const result = authorizeNutritionPersistence({
      session,
      recipe: reviewed.recipe,
      state: {
        ...reviewed.state,
        matches: { ...reviewed.state.matches, [lineRef]: forged },
      } as unknown as Phase4State,
    });
    expect(result.ok).toBe(false);
    expect(authFailureCode(result)).toBe('calculation_mismatch');
  });

  it('ignores a forged marker injected onto the genuine reviewed range selection', () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const lineRef = reviewed.adapted[0].line_ref;
    const existing = reviewed.state.matches[lineRef];
    expect(existing).toBeDefined();
    if (!existing) return;
    const forged = {
      ...(existing as object),
      range_representative: {
        amount_source: 'written_mass_range',
        policy: 'midpoint',
        lower: 111,
        upper: 222,
        unit: 'kg',
        representative_grams: 1,
      },
    };
    const result = authorizeNutritionPersistence({
      session,
      recipe: reviewed.recipe,
      state: {
        ...reviewed.state,
        matches: { ...reviewed.state.matches, [lineRef]: forged },
      } as unknown as Phase4State,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(markerOf(result.candidate.block)).toEqual({
      amount_source: 'written_mass_range',
      policy: 'midpoint',
      lower: 3,
      upper: 4,
      unit: 'lb',
      representative_grams: result.candidate.block.ingredients[0].amount?.value,
    });
  });

  it('writes provenance from the genuine re-derivation only', async () => {
    const reviewed = buildReviewed(recipeFor([RANGE_LINE]));
    const vault = makeVault();
    const result = await applyAdvancedNutrition({
      session,
      recipe: reviewed.recipe,
      state: reviewed.state,
      write: vault.write,
      expectedMode: 'create',
    });
    expect(result.ok).toBe(true);
    const written = vault.writes[0];
    const decoded = decodeCodexNutrition(written.codexNutrition);
    expect(decoded.kind).toBe('v3');
    if (decoded.kind !== 'v3') return;
    expect(markerOf(decoded.value)?.lower).toBe(3);
    expect(markerOf(decoded.value)?.upper).toBe(4);
    expect(markerOf(decoded.value)?.representative_grams).toBe(
      decoded.value.ingredients[0].amount?.value
    );
  });
});

// ---------------------------------------------------------------------------
// Schema gate — malformed marker couplings fail the whole block closed
// ---------------------------------------------------------------------------

describe('schema v3 — written-range evidence coupling is closed', () => {
  function validV3(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema: 3,
      basis: 'total',
      servings: 4,
      status: 'complete',
      computed_at: '2026-09-14T00:00:00.000Z',
      ingredient_digest: `sha256:${'a'.repeat(64)}`,
      dv_standard: 'fda_adult_4plus_2020',
      sources: ['usda_fdc'],
      source_releases: { usda_fdc: '2026-04' },
      nutrient_scope: ['calories'],
      nutrients: {
        calories: {
          amount: 540,
          unit: 'kcal',
          status: 'complete',
          coverage: 1,
          covered_ingredient_count: 1,
          measurable_ingredient_count: 1,
        },
      },
      ingredients: [
        {
          line_ref: '3-4 lb ground beef',
          source: 'usda_fdc',
          source_food_id: '171077',
          source_release: '2026-04',
          match_status: 'confirmed',
          resolved: true,
          user_confirmed: true,
          amount: { value: 1587.573295, unit: 'g' },
          conversion_basis: 'direct_mass',
          range_representative: {
            amount_source: 'written_mass_range',
            policy: 'midpoint',
            lower: 3,
            upper: 4,
            unit: 'lb',
            representative_grams: 1587.573295,
          },
        },
      ],
      unresolved: [],
      ...overrides,
    };
  }

  function entry(block: Record<string, unknown>): Record<string, unknown> {
    return (block.ingredients as Array<Record<string, unknown>>)[0];
  }

  it('accepts the canonical v3 marker and round-trips it', () => {
    expect(validateCodexNutritionV3(validV3()).ok).toBe(true);
    expect(validateCodexNutrition(validV3()).ok).toBe(true);
    const decoded = decodeCodexNutrition(validV3());
    expect(decoded.kind).toBe('v3');
    const encoded = encodeCodexNutrition(validV3() as never);
    expect(encodeCodexNutrition(encoded as never)).toEqual(encoded);
  });

  it('rejects every malformed marker coupling', () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      [
        'range marker on a source_portion basis',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            e.conversion_basis = 'source_portion';
            return e;
          })()],
        }),
      ],
      [
        'range marker on an unresolved line',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            e.resolved = false;
            return e;
          })()],
        }),
      ],
      [
        'lower endpoint greater than the upper endpoint',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            (e.range_representative as Record<string, unknown>).lower = 5;
            return e;
          })()],
        }),
      ],
      [
        'representative grams not equal to the stored amount',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            (e.range_representative as Record<string, unknown>).representative_grams = 1000;
            return e;
          })()],
        }),
      ],
      [
        'unknown marker field',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            (e.range_representative as Record<string, unknown>).future_field = 1;
            return e;
          })()],
        }),
      ],
      [
        'wrong amount source',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            (e.range_representative as Record<string, unknown>).amount_source = 'ai_estimate';
            return e;
          })()],
        }),
      ],
      [
        'wrong representative policy',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            (e.range_representative as Record<string, unknown>).policy = 'average';
            return e;
          })()],
        }),
      ],
      [
        'empty unit',
        validV3({
          ingredients: [(() => {
            const e = entry(validV3());
            (e.range_representative as Record<string, unknown>).unit = '  ';
            return e;
          })()],
        }),
      ],
    ];
    for (const [label, block] of cases) {
      const validation = validateCodexNutritionV3(block);
      expect(validation.ok, label).toBe(false);
      expect(validateCodexNutrition(block).ok, label).toBe(false);
    }
  });

  it('rejects a v1/v2 block carrying the v3-only marker (version-specific key set)', () => {
    const v3 = validV3();
    for (const schema of [1, 2] as const) {
      const block = { ...v3, schema };
      const validation = schema === 1 ? validateCodexNutritionV1(block) : validateCodexNutritionV2(block);
      expect(validation.ok, `schema ${schema}`).toBe(false);
      expect(validation.errors).toContain('ingredient_unknown_field');
      expect(decodeCodexNutrition(block).kind).toBe('malformed');
    }
  });

  it('refuses to encode an invalid v3 block', () => {
    const invalid = validV3({
      ingredients: [(() => {
        const e = entry(validV3());
        delete (e.range_representative as Record<string, unknown>).unit;
        return e;
      })()],
    });
    expect(() => encodeCodexNutrition(invalid as never)).toThrow('advanced_nutrition_invalid');
  });
});
