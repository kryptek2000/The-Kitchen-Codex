/**
 * Advanced Nutrition Phase 7 — AI household interpretation alignment.
 *
 * Central real-data regression: the REAL pinned USDA bundle and the REAL
 * verified Phase 5 household registry flow through parse -> review -> analyzer
 * -> AI household hint verification -> genuine builder -> calculator -> live
 * projection. AI interprets only closed unit/size/state WORDING; every gram
 * comes from the authenticated registry record the local core re-derives.
 *
 * The suite also pins the closed hint vocabulary, the v4 AI wire contract, the
 * no-op/preservation behavior of existing authorities, every fail-closed case,
 * persistence/Apply/reopen behavior, and forgery resistance.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/application/aiSelection', () => ({
  buildAiSelectionRequestOptions: async () => ({}),
}));

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { loadHouseholdInitialRegistry } from '../../src/core/nutritionV2/household/initialData';
import { HOUSEHOLD_STATES, HOUSEHOLD_SIZE_CLASSES } from '../../src/core/nutritionV2/household/normalize';
import {
  canonicalHouseholdCountUnit,
  canonicalHouseholdState,
  deriveHouseholdLookupContext,
  resolveHouseholdPortion,
  sanitizeHouseholdRequirementHint,
  HOUSEHOLD_PORTION_SELECTION_VERSION,
} from '../../src/core/nutritionV2/calculation/householdPortion';
import { canonicalSize } from '../../src/core/nutritionV2/calculation/countPortion';
import {
  canonicalHouseholdUnit,
  householdContainerNouns,
  householdCountNouns,
} from '../../src/utils/householdUnits';
import {
  AI_RESOLUTION_VERSION,
  buildAiResolutionSchema,
  sanitizeAiResolutionResponse,
  type AiResolutionSuggestion,
} from '../../src/core/nutritionV2/aiResolution';
import {
  householdRequirementHintFromSuggestion,
  resolveHouseholdsFromAiSuggestions,
} from '../../src/core/nutritionV2/phase4/aiHouseholdResolve';
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
import { ingredientEvidenceViews } from '../../src/core/nutritionV2/phase4/display';
import {
  INITIAL_PHASE4_STATE,
  phase4Reducer,
} from '../../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../../src/core/nutritionV2/phase4/types';
import { hydrateWorkingReview } from '../../src/core/nutritionV2/phase4/hydrate';
import { readStoredBlock } from '../../src/core/nutritionV2/phase4/stored';
import { buildHouseholdPortionChoice } from '../../src/core/nutritionV2/phase4/householdPortion';
import { buildUserMassChoice } from '../../src/core/nutritionV2/phase4/userMass';
import { authorizeNutritionPersistence } from '../../src/core/nutritionV2/phase5/authorize';
import { encodeCodexNutrition, decodeCodexNutrition } from '../../src/core/nutritionV2/validate';
import type {
  CodexNutritionV2,
  HouseholdPortionEvidence,
  IngredientEvidenceV2,
} from '../../src/core/nutritionV2/schema';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { parseIngredientLine } from '../../src/utils/markdownParser';
import { resolveUnresolvedRowsWithAi } from '../../src/application/nutritionAiResolve';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { IngredientCalculationEvidence } from '../../src/core/nutritionV2/calculation/types';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  HouseholdPortionChoice,
  Phase4Row,
  Phase4State,
} from '../../src/core/nutritionV2/phase4/types';
import type { ObsidianRecipe } from '../../src/types';

const BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

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

function recipeFor(line: string, id = 'phase7'): ObsidianRecipe {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `Recipes/${id}.md`,
    rawMarkdown: '',
    title: 'Phase 7 AI Household',
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

interface Flow {
  readonly recipe: ObsidianRecipe;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly analysis: ReturnType<typeof analyzeRecipe>;
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly state: Phase4State;
  readonly lineRef: string;
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

function suggestionFor(
  lineRef: string,
  fields: Partial<AiResolutionSuggestion> = {}
): AiResolutionSuggestion {
  return Object.freeze({
    line_ref: lineRef,
    interpreted_food_name: 'probe',
    suggested_usda_queries: Object.freeze([]),
    ...fields,
  }) as AiResolutionSuggestion;
}

interface AiRun {
  readonly outcome: ReturnType<typeof resolveHouseholdsFromAiSuggestions>;
  readonly state: Phase4State | null;
  readonly live: LiveRowState | null;
  readonly evidence: IngredientCalculationEvidence | undefined;
}

/** Runs the household resolver on one line and, if resolved, applies it like the UI would. */
function runHouseholdAi(
  flowValue: Flow,
  fields: Partial<AiResolutionSuggestion>,
  options: { readonly apply?: boolean; readonly exclude?: ReadonlyArray<string> } = {}
): AiRun {
  const liveRows = project(flowValue, flowValue.state);
  const outcome = resolveHouseholdsFromAiSuggestions({
    session,
    rows: flowValue.rows,
    adapted: flowValue.adapted,
    liveRows,
    state: flowValue.state,
    suggestions: [suggestionFor(flowValue.lineRef, fields)],
    ...(options.exclude !== undefined ? { excludeLineRefs: options.exclude } : {}),
  });
  const resolved = outcome.resolved[0];
  if (!resolved || options.apply === false) {
    return { outcome, state: null, live: null, evidence: undefined };
  }
  const state = phase4Reducer(flowValue.state, {
    type: 'select_household_portion',
    lineRef: flowValue.lineRef,
    choice: resolved.choice,
  });
  const calculated = calculate(flowValue, state);
  return {
    outcome,
    state,
    live: liveOf(flowValue, state),
    evidence: calculated.ok ? calculated.preview.ingredients[0] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Closed hint vocabulary
// ---------------------------------------------------------------------------

describe('phase 7 — closed household hint vocabulary', () => {
  it('the state token vocabulary is the ONE registry state vocabulary', () => {
    expect(HOUSEHOLD_STATES.length).toBe(8);
    for (const state of HOUSEHOLD_STATES) {
      expect(canonicalHouseholdState(state)).toBe(state);
    }
    expect(canonicalHouseholdState('raw')).toBe('raw');
    expect(canonicalHouseholdState('COOKED')).toBe('cooked');
    expect(canonicalHouseholdState('charred')).toBeNull();
    expect(canonicalHouseholdState('  fresh  ')).toBe('fresh');
    expect(canonicalHouseholdState('')).toBeNull();
    expect(canonicalHouseholdState(null)).toBeNull();
    expect(canonicalHouseholdState(undefined)).toBeNull();
  });

  it('the size vocabulary outputs are the registry size classes only', () => {
    const produced = new Set([
      canonicalSize('small'),
      canonicalSize('MEDIUM'),
      canonicalSize('large'),
      canonicalSize('jumbo'),
      canonicalSize('miniature'),
      canonicalSize('petite'),
      canonicalSize('xlarge'),
      canonicalSize('extra large'),
      canonicalSize('xxl'),
    ]);
    for (const size of produced) {
      expect(size).not.toBeNull();
      expect(HOUSEHOLD_SIZE_CLASSES).toContain(size as string);
    }
    expect(canonicalSize('gigantic')).toBeNull();
    expect(canonicalSize('size 9')).toBeNull();
  });

  it('the unit vocabulary accepts only Phase 1 count nouns, never containers', () => {
    for (const noun of householdCountNouns()) {
      expect(canonicalHouseholdCountUnit(noun)).toBe(noun);
    }
    for (const container of householdContainerNouns()) {
      expect(canonicalHouseholdUnit(container)?.kind).toBe('container');
      expect(canonicalHouseholdCountUnit(container)).toBeNull();
    }
    expect(canonicalHouseholdCountUnit('bucket')).toBeNull();
    expect(canonicalHouseholdCountUnit('')).toBeNull();
    expect(canonicalHouseholdCountUnit(null)).toBeNull();
  });

  it('the hint sanitizer is closed, canonical, and mutation-free', () => {
    const raw = Object.freeze({ unit: 'cloves', size: 'extra large', state: 'COOKED' });
    const before = JSON.stringify(raw);
    const sanitized = sanitizeHouseholdRequirementHint(raw);
    expect(sanitized.ok).toBe(true);
    if (sanitized.ok) {
      expect(sanitized.hint).toEqual({ unit: 'clove', size: 'xl', state: 'cooked' });
      expect(Object.isFrozen(sanitized.hint)).toBe(true);
    }
    expect(JSON.stringify(raw)).toBe(before);

    expect(sanitizeHouseholdRequirementHint(undefined)).toEqual({ ok: true });
    expect(sanitizeHouseholdRequirementHint(null)).toEqual({ ok: true });

    // Closed failures: authority-shaped keys, unknown tokens, containers, and
    // non-string types all fail closed (never a partial hint).
    expect(sanitizeHouseholdRequirementHint({ grams: 100 }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ resolved_grams: 1 }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ unit: 'clove', grams: 100 }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ unit: 'can' }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ unit: 'bucket' }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ size: 'massive' }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ state: 'charred' }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ unit: 3 }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ size: true }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ state: ['raw'] }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint({ unit: { noun: 'clove' } }).ok).toBe(false);
    expect(sanitizeHouseholdRequirementHint('clove').ok).toBe(false);

    // Prototype-shaped input is harmless: it never pollutes and never resolves.
    const proto = Object.create({ __proto__: { unit: 'clove' } }) as Record<string, unknown>;
    expect(() => sanitizeHouseholdRequirementHint(proto)).not.toThrow();
    expect(({} as Record<string, unknown>).unit).toBeUndefined();
    expect(sanitizeHouseholdRequirementHint(proto).ok).toBe(false);
  });

  it('the suggestion adapter reduces unknown tokens and rejects container units', () => {
    const base = { interpreted_food_name: 'x', suggested_usda_queries: [] };
    const withHint = (fields: Record<string, unknown>) =>
      householdRequirementHintFromSuggestion(suggestionFor('l1', { ...base, ...fields }));

    expect(withHint({})).toBeUndefined();
    expect(withHint({ household_unit_hint: 'bucket' })).toBeUndefined();
    expect(withHint({ household_size_hint: 'gigantic' })).toBeUndefined();
    expect(withHint({ household_state_hint: 'charred' })).toBeUndefined();
    // A known CONTAINER unit rejects the whole hint (never a count conversion).
    expect(withHint({ household_unit_hint: 'can', household_size_hint: 'medium' })).toBeUndefined();
    // Unknown tokens are reduced to "no hint" per field.
    expect(withHint({ household_unit_hint: 'bucket', household_size_hint: 'medium' })).toEqual({
      unit: null,
      size: 'medium',
      state: null,
    });
    expect(withHint({ household_unit_hint: 'Cloves' })).toEqual({
      unit: 'clove',
      size: null,
      state: null,
    });
  });
});

// ---------------------------------------------------------------------------
// AI wire contract v4
// ---------------------------------------------------------------------------

describe('phase 7 — AI wire contract v4', () => {
  it('pins the new AI resolution version', () => {
    expect(AI_RESOLUTION_VERSION).toBe('nutrition_ai_resolution_v4');
  });

  it('declares the closed household hint fields in the provider schema', () => {
    const schema = buildAiResolutionSchema() as unknown as {
      properties: {
        suggestions: {
          items: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        };
      };
    };
    const props = schema.properties.suggestions.items.properties;
    expect(props).toHaveProperty('household_unit_hint');
    expect(props).toHaveProperty('household_size_hint');
    expect(props).toHaveProperty('household_state_hint');
    expect(schema.properties.suggestions.items.required).not.toContain('household_unit_hint');
  });

  it('sanitizes bounded household hints and rejects authority-shaped responses whole', () => {
    const ok = sanitizeAiResolutionResponse(
      {
        version: 4,
        suggestions: [
          {
            line_ref: 'l1',
            interpreted_food_name: 'Tomatoes, raw',
            suggested_usda_queries: ['tomatoes raw'],
            household_size_hint: 'medium',
            household_unit_hint: 'clove',
            household_state_hint: 'raw',
          },
        ],
      },
      { allowedLineRefs: ['l1'] }
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.suggestions[0].household_size_hint).toBe('medium');
      expect(ok.suggestions[0].household_unit_hint).toBe('clove');
      expect(ok.suggestions[0].household_state_hint).toBe('raw');
    }

    const authorityKeys = [
      'grams',
      'gram_weight',
      'resolved_grams',
      'mass',
      'fdc_id',
      'record_id',
      'household_record_key',
      'portion_index',
      'nutrients',
      'calories',
      'application_authorized',
      'user_confirmed',
      'selection_digest',
      'registry_release',
      'confidence' /* allowed field but never authority */,
    ];
    for (const key of authorityKeys.slice(0, -1)) {
      const rejected = sanitizeAiResolutionResponse(
        {
          version: 4,
          suggestions: [
            {
              line_ref: 'l1',
              interpreted_food_name: 'x',
              suggested_usda_queries: [],
              household_size_hint: 'medium',
              [key]: key === 'grams' ? 100 : 'forged',
            },
          ],
        },
        { allowedLineRefs: ['l1'] }
      );
      expect(rejected.ok, `authority key ${key} must reject whole response`).toBe(false);
    }

    const malformedHints: ReadonlyArray<Record<string, unknown>> = [
      { household_unit_hint: 3 },
      { household_unit_hint: true },
      { household_unit_hint: null /* null is absent, not malformed */ },
      { household_size_hint: ['medium'] },
      { household_state_hint: { value: 'raw' } },
      { household_size_hint: 'm'.repeat(200) },
    ];
    for (const fields of malformedHints) {
      const sanitized = sanitizeAiResolutionResponse(
        {
          version: 4,
          suggestions: [
            {
              line_ref: 'l1',
              interpreted_food_name: 'x',
              suggested_usda_queries: [],
              ...fields,
            },
          ],
        },
        { allowedLineRefs: ['l1'] }
      );
      if ('household_unit_hint' in fields && fields.household_unit_hint === null) {
        expect(sanitized.ok).toBe(true);
      } else {
        expect(sanitized.ok).toBe(false);
      }
    }

    const unknownRef = sanitizeAiResolutionResponse(
      {
        version: 4,
        suggestions: [
          { line_ref: 'other', interpreted_food_name: 'x', suggested_usda_queries: [] },
        ],
      },
      { allowedLineRefs: ['l1'] }
    );
    expect(unknownRef.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real-bundle corpus — baseline (before AI) classification
// ---------------------------------------------------------------------------

describe('phase 7 — real-bundle baseline corpus', () => {
  it('documents the deterministic before-AI outcome of every corpus line', () => {
    const cases: ReadonlyArray<{
      line: string;
      status: string;
      massSource?: string;
      grams?: number;
      householdKey?: string;
    }> = [
      { line: '3 cloves garlic, minced', status: 'matched', massSource: 'household_portion', grams: 9, householdKey: 'garlic|clove|null|null' },
      { line: '2 large tomatoes', status: 'matched', massSource: 'household_portion', grams: 364, householdKey: 'tomato|item|large|null' },
      { line: '1 stick unsalted butter', status: 'matched', massSource: 'household_portion', grams: 113, householdKey: 'unsalted butter|stick|null|null' },
      { line: '2 tomatoes', status: 'needs_amount' },
      { line: '2 green cabbages', status: 'needs_amount' },
      { line: '2 unsalted butter', status: 'needs_amount' },
      { line: '2 red cabbages', status: 'needs_amount' },
      { line: '2 eggplants', status: 'needs_amount' },
      { line: '2-3 tomatoes', status: 'needs_amount' },
      { line: '1 can diced tomatoes', status: 'review_suggested' },
      { line: '100 g tomatoes', status: 'matched', massSource: 'direct_mass', grams: 100 },
      { line: '1 cup diced tomatoes', status: 'matched', massSource: 'source_portion', grams: 180 },
      { line: '2 tomatoes, cooked', status: 'needs_amount' },
    ];
    for (const entry of cases) {
      const f = flow(entry.line);
      const live = liveOf(f, f.state);
      expect(live.status, entry.line).toBe(entry.status);
      if (entry.massSource !== undefined) {
        expect(live.mass_source, entry.line).toBe(entry.massSource);
        expect(live.resolved_grams, entry.line).toBe(entry.grams);
      }
      if (entry.householdKey !== undefined) {
        expect(f.state.householdPortions[f.lineRef]?.record_key, entry.line).toBe(
          entry.householdKey
        );
      }
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
// Positive cases — AI household wording unlocks one verified record
// ---------------------------------------------------------------------------

describe('phase 7 — positive real-data outcomes', () => {
  it('unlocks tomato|item|medium for "2 tomatoes" and stays calculator/live/parity truthful', () => {
    const f = flow('2 tomatoes');
    const before = liveOf(f, f.state);
    expect(before.status).toBe('needs_amount');
    expect(before.selected_fdc_id).toBe(2709719);

    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(1);
    const resolved = run.outcome.resolved[0];
    expect(resolved.record_key).toBe('tomato|item|medium|null');
    expect(resolved.authority_class).toBe('usda_derived');
    expect(resolved.resolved_grams).toBe(246);
    expect(resolved.fdc_id).toBe(before.selected_fdc_id);
    expect(resolved.choice.aiAssisted).toBe(true);
    expect(resolved.choice.automatic).toBe(true);

    expect(run.live?.status).toBe('matched');
    expect(run.live?.mass_source).toBe('household_portion');
    expect(run.live?.resolved_grams).toBe(246);
    expect(run.live?.selected_fdc_id).toBe(2709719);
    expect(run.live?.household_unit).toBe('item');
    expect(run.live?.household_size_class).toBe('medium');
    expect(run.live?.household_ai_assisted).toBe(true);
    expect(summarizeLiveRows([run.live as LiveRowState]).matched).toBe(1);

    expect(run.evidence?.mass_source).toBe('household_portion');
    expect(run.evidence?.resolved_grams).toBe(246);
    expect(run.evidence?.household_record_key).toBe('tomato|item|medium|null');
    expect(run.evidence?.household_registry_release).toBe('household_portion_initial_usda_v1');
    expect(run.evidence?.household_quantity).toBe(2);
    // AI never supplies confirmation or authorization.
    expect(run.evidence?.user_confirmed).toBe(false);
    const calculated = calculate(f, run.state as Phase4State);
    expect(calculated.ok).toBe(true);
    if (calculated.ok) {
      expect(calculated.preview.advisory_only).toBe(true);
      expect(calculated.preview.application_authorized).toBe(false);
      expect(calculated.preview.status).toBe('complete');
    }
    // Closing without Apply writes nothing.
    expect(readStoredBlock(f.recipe).kind).toBe('none');
  });

  it('unlocks green cabbage|head|medium for "2 green cabbages" only from the source identity', () => {
    const f = flow('2 green cabbages');
    const before = liveOf(f, f.state);
    expect(before.status).toBe('needs_amount');
    expect(before.selected_fdc_id).toBe(2346407);

    const run = runHouseholdAi(f, {
      household_unit_hint: 'head',
      household_size_hint: 'medium',
    });
    const resolved = run.outcome.resolved[0];
    expect(resolved?.record_key).toBe('green cabbage|head|medium|null');
    expect(resolved?.resolved_grams).toBe(1816);
    expect(run.live?.mass_source).toBe('household_portion');
    expect(run.live?.resolved_grams).toBe(1816);
  });

  it('binds the SOURCE variety (red cabbage), never an AI-chosen identity', () => {
    const f = flow('2 red cabbages');
    const run = runHouseholdAi(f, {
      household_unit_hint: 'head',
      household_size_hint: 'medium',
    });
    const resolved = run.outcome.resolved[0];
    expect(resolved?.record_key).toBe('red cabbage|head|medium|null');
    expect(resolved?.resolved_grams).toBe(1678);
    expect(run.live?.selected_fdc_id).toBe(liveOf(f, f.state).selected_fdc_id);
  });

  it('unlocks unsalted butter|stick for "2 unsalted butter"', () => {
    const f = flow('2 unsalted butter');
    const run = runHouseholdAi(f, { household_unit_hint: 'stick' });
    const resolved = run.outcome.resolved[0];
    expect(resolved?.record_key).toBe('unsalted butter|stick|null|null');
    expect(resolved?.resolved_grams).toBe(226);
    expect(run.live?.mass_source).toBe('household_portion');
  });

  it('honors an explicit AI size choice with distinct truthful grams (large vs medium)', () => {
    const medium = runHouseholdAi(flow('2 tomatoes'), { household_size_hint: 'medium' });
    const large = runHouseholdAi(flow('2 tomatoes'), { household_size_hint: 'large' });
    expect(medium.outcome.resolved[0].resolved_grams).toBe(246);
    expect(large.outcome.resolved[0].resolved_grams).toBe(364);
    expect(large.outcome.resolved[0].record_key).toBe('tomato|item|large|null');
  });

  it('never uses an echoed quantity as a gram value', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium', quantity_value: 2 });
    expect(run.outcome.resolved).toHaveLength(1);
    expect(run.outcome.resolved[0].resolved_grams).toBe(246);
    expect(run.evidence?.resolved_grams).toBe(246);
  });

  it('is deterministic and independent of suggestion extras on repeat calls', () => {
    const f = flow('2 tomatoes');
    const first = runHouseholdAi(f, { household_size_hint: 'medium' });
    const second = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(second.outcome.resolved[0].resolved_grams).toBe(
      first.outcome.resolved[0].resolved_grams
    );
    expect(liveOf(f, f.state).status).toBe('needs_amount');
  });
});

// ---------------------------------------------------------------------------
// No-op / preservation cases
// ---------------------------------------------------------------------------

describe('phase 7 — no-op and preservation cases', () => {
  it('leaves a deterministically resolved household line identical', () => {
    const f = flow('3 cloves garlic, minced');
    const before = liveOf(f, f.state);
    expect(before.mass_source).toBe('household_portion');
    expect(before.resolved_grams).toBe(9);
    const run = runHouseholdAi(f, { household_unit_hint: 'clove' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(run.outcome.unresolved).toContain(f.lineRef);
    expect(f.state.householdPortions[f.lineRef]?.resolved_grams).toBe(9);
  });

  it('keeps an existing user-entered total mass protected', () => {
    const f = flow('2 tomatoes');
    const match = f.state.matches[f.lineRef];
    const built = buildUserMassChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      ...(f.rows[0].outcome === 'review_required' ? { review: f.rows[0].review } : {}),
      ...(match !== undefined
        ? { selection: selectionFromMatchChoice(match, f.lineRef) }
        : {}),
      ...(match?.automatic === true ? { automaticSelection: true } : {}),
      fdcId: liveOf(f, f.state).selected_fdc_id as number,
      quantity: 500,
      unit: 'g',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const state = phase4Reducer(f.state, {
      type: 'select_user_mass',
      lineRef: f.lineRef,
      choice: built.choice,
    });
    const live = liveOf(f, state);
    expect(live.mass_source).toBe('user_mass');
    expect(live.resolved_grams).toBe(500);
    const outcome = resolveHouseholdsFromAiSuggestions({
      session,
      rows: f.rows,
      adapted: f.adapted,
      liveRows: project(f, state),
      state,
      suggestions: [suggestionFor(f.lineRef, { household_size_hint: 'medium' })],
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(state.userMasses[f.lineRef].quantity).toBe(500);
  });

  it('never replaces a previously selected verified household portion', () => {
    const f = flow('2 large tomatoes');
    const stored = f.state.householdPortions[f.lineRef];
    expect(stored?.record_key).toBe('tomato|item|large|null');
    const run = runHouseholdAi(f, { household_size_hint: 'small' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(f.state.householdPortions[f.lineRef]?.record_key).toBe('tomato|item|large|null');
    expect(f.state.householdPortions[f.lineRef]?.resolved_grams).toBe(364);
  });

  it('keeps USDA source portions preferred and untouched', () => {
    const f = flow('1 cup diced tomatoes');
    const before = liveOf(f, f.state);
    expect(before.mass_source).toBe('source_portion');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(liveOf(f, f.state).resolved_grams).toBe(before.resolved_grams);
  });

  it('keeps direct mass exclusive', () => {
    const f = flow('100 g tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(liveOf(f, f.state).mass_source).toBe('direct_mass');
    expect(liveOf(f, f.state).resolved_grams).toBe(100);
  });

  it('keeps explicit source size authoritative over a contradictory AI size', () => {
    const f = flow('2 large tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'small' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(liveOf(f, f.state).resolved_grams).toBe(364);
    // Direct canonical-context proof: the source size outranks the hint even
    // before the live row (already resolved) is considered.
    const context = deriveHouseholdLookupContext(
      { original: '2 large tomatoes', amount: 2, name: 'large tomatoes' },
      { unit: null, size: 'small', state: null }
    );
    expect(context?.size_class).toBe('large');
  });

  it('never weakens container lines', () => {
    const f = flow('1 can diced tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(liveOf(f, f.state).status).toBe('review_suggested');
    // The canonical lookup context refuses the container outright, including
    // the size-first form whose container token the parser can drop.
    expect(
      deriveHouseholdLookupContext({
        original: '1 can diced tomatoes',
        amount: 1,
        unit: 'can',
        name: 'diced tomatoes',
      })
    ).toBeUndefined();
    // The size-first form keeps its container token in the parsed query, so the
    // item-mapping token scan also refuses it.
    expect(
      deriveHouseholdLookupContext(
        { original: '1 medium can tomatoes', amount: 1, name: 'medium can tomatoes' },
        { unit: null, size: 'medium', state: null }
      )
    ).toBeUndefined();
  });

  it('does not weaken white-rice style variety constraints', () => {
    const f = flow('2 white rice');
    const before = liveOf(f, f.state);
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(liveOf(f, f.state).selected_fdc_id).toBe(before.selected_fdc_id);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed cases
// ---------------------------------------------------------------------------

describe('phase 7 — fail-closed cases', () => {
  it('never resolves a range quantity', () => {
    const f = flow('2-3 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(liveOf(f, f.state).status).toBe('needs_amount');
    expect(liveOf(f, f.state).resolved_grams).toBeUndefined();
  });

  it('never resolves a line with no compatible household record', () => {
    const f = flow('2 eggplants');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(liveOf(f, f.state).resolved_grams).toBeUndefined();
  });

  it('rejects an unsupported unit/size/state token without inventing grams', () => {
    const f = flow('2 tomatoes');
    for (const fields of [
      { household_unit_hint: 'bucket' },
      { household_size_hint: 'gigantic' },
      { household_state_hint: 'charred' },
      { household_unit_hint: 'ｍｅｄｉｕｍ' },
      { household_size_hint: 'medium\u200B' },
    ]) {
      const run = runHouseholdAi(f, fields);
      expect(run.outcome.resolved, JSON.stringify(fields)).toHaveLength(0);
      expect(liveOf(f, f.state).status).toBe('needs_amount');
    }
  });

  it('rejects a container unit hint even when the source is otherwise unlockable', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, {
      household_unit_hint: 'can',
      household_size_hint: 'medium',
    });
    expect(run.outcome.resolved).toHaveLength(0);
  });

  it('rejects an incomplete hint that cannot select exactly one record', () => {
    const f = flow('2 tomatoes');
    // `item` with no size cannot bind any tomato record.
    const run = runHouseholdAi(f, { household_unit_hint: 'item' });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(
      resolveHouseholdPortion({
        ingredient: f.adapted[0].ingredient,
        fdcId: 2709719,
        usdaRecordDigest: 'd'.repeat(64),
        bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
        hint: { unit: 'item', size: null, state: null },
      })
    ).toBeUndefined();
  });

  it('never erases a contradictory source state', () => {
    const f = flow('2 tomatoes, cooked');
    const run = runHouseholdAi(f, {
      household_size_hint: 'medium',
      household_state_hint: 'raw',
    });
    expect(run.outcome.resolved).toHaveLength(0);
    // The source state outranks the hint, so the only candidate key carries the
    // source state and finds no record.
    const context = deriveHouseholdLookupContext(f.adapted[0].ingredient, {
      unit: null,
      size: 'medium',
      state: 'raw',
    });
    expect(context?.requires_state).toBe('cooked');
  });

  it('flags a materially inconsistent AI quantity echo', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, {
      household_size_hint: 'medium',
      quantity_value: 99,
    });
    expect(run.outcome.resolved).toHaveLength(0);
    expect(run.outcome.inconsistent).toContain(f.lineRef);
  });

  it('skips a cross-line/cross-food AI response without touching other lines', () => {
    const f = flow('2 tomatoes');
    const outcome = resolveHouseholdsFromAiSuggestions({
      session,
      rows: f.rows,
      adapted: f.adapted,
      liveRows: project(f, f.state),
      state: f.state,
      suggestions: [suggestionFor('unknown-line', { household_size_hint: 'medium' })],
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(f.state.householdPortions[f.lineRef]).toBeUndefined();
  });

  it('respects caller exclusions (higher-authority working choices)', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' }, { exclude: [f.lineRef] });
    expect(run.outcome.resolved).toHaveLength(0);
  });

  it('fails closed for a structural fake session without throwing', () => {
    const f = flow('2 tomatoes');
    const fake = {} as AdvancedNutritionSession;
    const outcome = resolveHouseholdsFromAiSuggestions({
      session: fake,
      rows: f.rows,
      adapted: f.adapted,
      liveRows: project(f, f.state),
      state: f.state,
      suggestions: [suggestionFor(f.lineRef, { household_size_hint: 'medium' })],
    });
    expect(outcome.resolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Forgery / authority
// ---------------------------------------------------------------------------

describe('phase 7 — AI authors no authority', () => {
  it('rejects a forged gram weight in the selection at the calculator boundary', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const choice = run.outcome.resolved[0].choice;
    const tampered = JSON.parse(JSON.stringify(choice)) as HouseholdPortionChoice;
    (tampered.selection as { resolved_grams: number }).resolved_grams = 99999;
    const state = phase4Reducer(f.state, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice: tampered,
    });
    const calculated = calculate(f, state);
    expect(calculated.ok).toBe(false);
    expect(liveOf(f, state).resolved_grams).toBeUndefined();
    expect(liveOf(f, state).status).toBe('needs_amount');
  });

  it('rejects a forged FDC binding in the selection', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const choice = run.outcome.resolved[0].choice;
    const tampered = JSON.parse(JSON.stringify(choice)) as unknown as Record<string, unknown>;
    tampered.fdc_id = 169228;
    (tampered.selection as { usda_fdc_id: number }).usda_fdc_id = 169228;
    const state = phase4Reducer(f.state, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice: tampered as unknown as HouseholdPortionChoice,
    });
    expect(calculate(f, state).ok).toBe(false);
    expect(liveOf(f, state).resolved_grams).toBeUndefined();
  });

  it('rejects a forged record key / grams binding in the selection', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const choice = run.outcome.resolved[0].choice;
    const tampered = JSON.parse(JSON.stringify(choice)) as HouseholdPortionChoice;
    (tampered.selection as { household_record_key: string }).household_record_key =
      'tomato|item|large|null';
    const state = phase4Reducer(f.state, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice: tampered,
    });
    expect(calculate(f, state).ok).toBe(false);
    expect(liveOf(f, state).resolved_grams).toBeUndefined();
  });

  it('the builder verifies the exact selection version and every binding', () => {
    const f = flow('2 tomatoes');
    const match = f.state.matches[f.lineRef];
    const selectionInput =
      match !== undefined ? { selection: selectionFromMatchChoice(match, f.lineRef) } : {};
    const reviewInput =
      f.rows[0].outcome === 'review_required' ? { review: f.rows[0].review } : {};
    const automatic = match?.automatic === true ? { automaticSelection: true } : {};
    const built = buildHouseholdPortionChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      ...reviewInput,
      ...selectionInput,
      ...automatic,
      fdcId: 2709719,
      householdRequirementHint: { unit: null, size: 'medium', state: null },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const selection = built.choice.selection as { household_selection_version: string };
    expect(selection.household_selection_version).toBe(HOUSEHOLD_PORTION_SELECTION_VERSION);
    const badHint = buildHouseholdPortionChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      ...selectionInput,
      ...automatic,
      fdcId: 2709719,
      householdRequirementHint: { unit: 'bucket', size: 'medium', state: null },
    });
    // A typed (already-sanitized) hint with an unknown unit fails at the
    // registry lookup, never at a partial trust boundary.
    expect(badHint.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persistence, Apply, and reopen
// ---------------------------------------------------------------------------

describe('phase 7 — persistence, Apply, and reopen', () => {
  it('persists truthful household provenance only through explicit Apply', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const state = run.state as Phase4State;
    const calculated = calculate(f, state);
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    // No Apply yet: nothing persisted.
    expect(readStoredBlock(f.recipe).kind).toBe('none');

    const authorized = authorizeNutritionPersistence({
      session,
      recipe: f.recipe,
      state: {
        ...state,
        status: 'preview_current',
        preview: calculated.preview,
        previewKey: state.recipeKey,
      },
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    const block = authorized.candidate.block as CodexNutritionV2;
    expect(block.schema).toBe(2);
    const evidence = block.ingredients[0] as IngredientEvidenceV2;
    expect(evidence.conversion_basis).toBe('household_portion');
    const household = evidence.household_portion as HouseholdPortionEvidence;
    expect(household.record_key).toBe('tomato|item|medium|null');
    expect(household.registry_release).toBe('household_portion_initial_usda_v1');
    expect(household.quantity).toBe(2);
    expect(household.household_unit).toBe('item');
    // Authorization alone never wrote the recipe block.
    expect(readStoredBlock(f.recipe).kind).toBe('none');
    const encoded = encodeCodexNutrition(block);
    expect(encoded.schema).toBe(2);
    expect(decodeCodexNutrition(encoded).kind).toBe('v2');
  });

  it('reopening retains only what Phase 6 can truthfully re-authenticate', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const state = run.state as Phase4State;
    const calculated = calculate(f, state);
    if (!calculated.ok) throw new Error('expected preview');
    const authorized = authorizeNutritionPersistence({
      session,
      recipe: f.recipe,
      state: {
        ...state,
        status: 'preview_current',
        preview: calculated.preview,
        previewKey: state.recipeKey,
      },
    });
    if (!authorized.ok) throw new Error('expected authorization');
    const savedBlock = authorized.candidate.block as CodexNutritionV2;

    const hydrated = hydrateWorkingReview({
      session,
      adapted: f.adapted,
      rows: f.rows,
      savedBlock,
    });
    // The AI wording hint is NOT persisted, so the Phase 6 contract cannot
    // re-authenticate the household basis on reopen: it stays unresolved
    // instead of inventing authority. The saved block itself remains valid.
    expect(hydrated?.householdPortions[f.lineRef]).toBeUndefined();
    expect(hydrated?.userMasses[f.lineRef]).toBeUndefined();
    expect(decodeCodexNutrition(encodeCodexNutrition(savedBlock)).kind).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// Application-layer orchestration
// ---------------------------------------------------------------------------

describe('phase 7 — application-layer orchestration', () => {
  it('runs the verified-household pass through resolveUnresolvedRowsWithAi', async () => {
    const f = flow('2 tomatoes');
    const liveRows = project(f, f.state);
    const network = {
      request: vi.fn(),
      get: vi.fn(),
      post: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: {
          ok: true,
          version: AI_RESOLUTION_VERSION,
          suggestions: [
            {
              line_ref: f.lineRef,
              interpreted_food_name: 'Tomatoes, raw',
              suggested_usda_queries: ['tomatoes raw'],
              household_size_hint: 'medium',
            },
          ],
        },
      })),
    } as unknown as NetworkAdapter;

    const result = await resolveUnresolvedRowsWithAi({
      network,
      session,
      rows: f.rows,
      adapted: f.adapted,
      issueKinds: { [f.lineRef]: 'needs_amount' },
      liveRows,
      state: f.state,
    });
    expect(result.ok).toBe(true);
    expect(result.households.resolved).toHaveLength(1);
    expect(result.households.resolved[0].record_key).toBe('tomato|item|medium|null');
    expect(result.households.resolved[0].choice.aiAssisted).toBe(true);
    // AI grants no authority anywhere in the run result.
    expect(result.outcome.candidates).toHaveLength(0);
    expect(result.amounts.resolved).toHaveLength(0);
    expect(
      (result.households.resolved[0].choice.selection as { resolved_grams: number }).resolved_grams
    ).toBe(246);
  });
});

// ---------------------------------------------------------------------------
// Registry integrity + ambiguity
// ---------------------------------------------------------------------------

describe('phase 7 — registry integrity and ambiguity', () => {
  it('the verified registry has exactly one record per lookup key and no mutable surface', () => {
    const loaded = loadHouseholdInitialRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const keys = new Set<string>();
    for (const record of loaded.registry.records()) {
      const key = `${record.food_key}|${record.household_unit}|${record.size_class ?? 'null'}|${
        record.requires_state ?? 'null'
      }`;
      expect(keys.has(key), `duplicate registry key ${key}`).toBe(false);
      keys.add(key);
    }
    expect(keys.size).toBe(31);
  });

  it('never chooses among multiple records because a hint supplied a compatible word', () => {
    // An incomplete hint cannot bind: the exact-key lookup returns nothing and
    // the resolver does not fall back to a first/top/closest record.
    const f = flow('2 tomatoes');
    const missing = resolveHouseholdPortion({
      ingredient: f.adapted[0].ingredient,
      fdcId: 2709719,
      usdaRecordDigest: 'e'.repeat(64),
      bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
      hint: { unit: null, size: null, state: null },
    });
    expect(missing).toBeUndefined();
    const unitOnly = resolveHouseholdPortion({
      ingredient: f.adapted[0].ingredient,
      fdcId: 2709719,
      usdaRecordDigest: 'e'.repeat(64),
      bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
      hint: { unit: 'clove', size: null, state: null },
    });
    expect(unitOnly).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FLAG F-1 — truthful `automatic` semantics (audit repair)
// ---------------------------------------------------------------------------

describe('phase 7 — truthful automatic semantics (F-1)', () => {
  it('derives automatic from the authenticated match authority, never from AI assistance', () => {
    const f = flow('2 tomatoes');
    // The analyzer made the automatic food selection for this review-required line.
    expect(f.state.matches[f.lineRef]?.automatic).toBe(true);
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const resolved = run.outcome.resolved[0];
    expect(resolved).toBeDefined();
    expect(resolved.choice.automatic).toBe(true);
    expect(resolved.choice.aiAssisted).toBe(true);
    // `automatic` is exactly the authenticated authority's flag.
    expect(resolved.choice.automatic).toBe(f.state.matches[f.lineRef]?.automatic === true);
  });

  it('a user-confirmed food + AI wording is AI-assisted but NOT analyzer-automatic', () => {
    const f = flow('2 tomatoes');
    const search = session.searchFoods('2709719', 5);
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const hit = search.results.find((result) => result.fdc_id === 2709719);
    expect(hit).toBeDefined();
    if (!hit) return;
    // The user explicitly confirms the food identity (no automatic provenance).
    const userState = phase4Reducer(f.state, {
      type: 'select_match',
      lineRef: f.lineRef,
      choice: {
        kind: 'manual',
        fdc_id: 2709719,
        review_digest: f.rows[0].review_digest ?? '',
        record_digest: hit.record_digest,
        catalog_digest: session.metadata().catalog_digest,
        description: hit.description,
      },
    });
    const userLive = project(f, userState);
    expect(userLive[0].food_authority).toBe('user_confirmed');
    expect(userLive[0].status).toBe('needs_amount');

    const outcome = resolveHouseholdsFromAiSuggestions({
      session,
      rows: f.rows,
      adapted: f.adapted,
      liveRows: userLive,
      state: userState,
      suggestions: [suggestionFor(f.lineRef, { household_size_hint: 'medium' })],
    });
    expect(outcome.resolved).toHaveLength(1);
    const resolved = outcome.resolved[0];
    expect(resolved.choice.automatic).toBe(false);
    expect(resolved.choice.aiAssisted).toBe(true);
    expect(resolved.record_key).toBe('tomato|item|medium|null');
    expect(resolved.resolved_grams).toBe(246);

    const applied = phase4Reducer(userState, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice: resolved.choice,
    });
    const calculated = calculate(f, applied);
    expect(calculated.ok).toBe(true);
    const live = liveOf(f, applied);
    expect(live.status).toBe('matched');
    expect(live.food_authority).toBe('user_confirmed');
    expect(live.mass_source).toBe('household_portion');
    expect(live.resolved_grams).toBe(246);
    expect(live.household_ai_assisted).toBe(true);
  });

  it('the automatic display flag never changes any downstream calculation authority', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const choice = run.outcome.resolved[0].choice;
    const withAutomatic = phase4Reducer(f.state, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice: { ...choice, automatic: true } as HouseholdPortionChoice,
    });
    const withoutAutomatic = phase4Reducer(f.state, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice: { ...choice, automatic: false } as HouseholdPortionChoice,
    });
    const a = calculate(f, withAutomatic);
    const b = calculate(f, withoutAutomatic);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.preview.ingredients)).toBe(JSON.stringify(b.preview.ingredients));
    expect(a.preview.ingredient_digest).toBe(b.preview.ingredient_digest);
    expect(liveOf(f, withAutomatic).resolved_grams).toBe(liveOf(f, withoutAutomatic).resolved_grams);
  });
});

// ---------------------------------------------------------------------------
// FLAG F-2 — builder-level direct mass AND direct volume exclusion
// ---------------------------------------------------------------------------

describe('phase 7 — builder mass-and-volume exclusion (F-2)', () => {
  it('the core builder rejects a direct-volume line even with a household size hint', () => {
    const f = flow('1 cup diced tomatoes');
    const live = liveOf(f, f.state);
    // The canonical USDA source portion remains the effective authority.
    expect(live.status).toBe('matched');
    expect(live.mass_source).toBe('source_portion');
    expect(live.resolved_grams).toBe(180);

    const match = f.state.matches[f.lineRef];
    const built = buildHouseholdPortionChoice(session, {
      lineRef: f.lineRef,
      ingredient: f.adapted[0].ingredient,
      ...(f.rows[0].outcome === 'review_required' ? { review: f.rows[0].review } : {}),
      ...(match !== undefined ? { selection: selectionFromMatchChoice(match, f.lineRef) } : {}),
      ...(match?.automatic === true ? { automaticSelection: true } : {}),
      fdcId: live.selected_fdc_id as number,
      householdRequirementHint: { unit: null, size: 'medium', state: null },
    });
    // Without the builder volume guard the canonical lookup context WOULD bind
    // `tomato|item|medium|null` for this line (the parser consumes `cup`), so
    // this assertion is load-bearing.
    expect(
      deriveHouseholdLookupContext(f.adapted[0].ingredient, {
        unit: null,
        size: 'medium',
        state: null,
      })
    ).toBeDefined();
    expect(built.ok).toBe(false);
  });

  it('never creates a household choice for a direct-volume line (analyzer + AI + live agreement)', () => {
    const f = flow('1 cup diced tomatoes');
    expect(f.state.householdPortions[f.lineRef]).toBeUndefined();
    expect(liveOf(f, f.state).mass_source).toBe('source_portion');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    expect(run.outcome.resolved).toHaveLength(0);
    const calculated = calculate(f, f.state);
    expect(calculated.ok).toBe(true);
    if (calculated.ok) {
      const evidence = calculated.preview.ingredients[0];
      expect(evidence.mass_source).toBe('source_portion');
      expect(evidence.resolved_grams).toBe(180);
      expect(evidence.household_record_key).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// FLAG F-6 — calculation-side household hint fail mode
// ---------------------------------------------------------------------------

describe('phase 7 — calculation-side household hint fail mode (F-6)', () => {
  interface RequestShape {
    servings: number;
    nutrient_scope: ReadonlyArray<string>;
    ingredients: ReadonlyArray<Record<string, unknown>>;
  }

  function requestWithHint(f: Flow, state: Phase4State, hint: unknown): RequestShape {
    const request = buildCalculationRequest(f.adapted, state) as RequestShape;
    return {
      ...request,
      ingredients: request.ingredients.map((entry) => ({
        ...entry,
        household_requirement_hint: hint,
      })),
    };
  }

  const MALFORMED_HINTS: ReadonlyArray<readonly [string, unknown]> = [
    ['extra key', { unit: null, size: 'medium', state: null, grams: 100 }],
    ['container unit', { unit: 'can', size: 'medium', state: null }],
    ['unsupported size', { unit: null, size: 'gigantic', state: null }],
    ['unsupported state', { unit: null, size: 'medium', state: 'charred' }],
    ['nested object', { unit: null, size: { name: 'medium' }, state: null }],
    ['non-string value', { unit: 3, size: null, state: null }],
    ['oversized token', { unit: null, size: 'm'.repeat(5000), state: null }],
  ];

  it('a malformed stored hint fails the WHOLE calculation with the exact bounded classification', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const state = run.state as Phase4State;
    const validRequest = buildCalculationRequest(f.adapted, state) as RequestShape;
    expect(session.calculate(validRequest).ok).toBe(true);

    for (const [name, hint] of MALFORMED_HINTS) {
      const calculated = session.calculate(requestWithHint(f, state, hint));
      if (calculated.ok) throw new Error(`${name}: malformed hint unexpectedly succeeded`);
      const failure = (calculated as { ok: false; failure: { code: string } }).failure;
      expect(failure.code, name).toBe('invalid_portion_selection');
    }

    // Prototype-shaped input is rejected at the request materialization boundary
    // (non-plain prototype) with the exact bounded `invalid_request` code — it
    // never reaches the hint sanitizer as a partially trusted object.
    const proto = Object.create({ unit: 'clove', size: 'medium', state: null }) as Record<
      string,
      unknown
    >;
    const protoCalculated = session.calculate(requestWithHint(f, state, proto));
    if (protoCalculated.ok) throw new Error('prototype-shaped hint unexpectedly succeeded');
    const protoFailure = (protoCalculated as { ok: false; failure: { code: string } }).failure;
    expect(protoFailure.code).toBe('invalid_request');
  });

  it('a malformed stored hint never projects grams or MATCHED in the live row', () => {
    const f = flow('2 tomatoes');
    const run = runHouseholdAi(f, { household_size_hint: 'medium' });
    const choice = run.outcome.resolved[0].choice;
    const malformedChoice = {
      ...choice,
      householdRequirementHint: { unit: null, size: 'gigantic', state: null },
    } as HouseholdPortionChoice;
    const state = phase4Reducer(f.state, {
      type: 'select_household_portion',
      lineRef: f.lineRef,
      choice: malformedChoice,
    });
    const live = liveOf(f, state);
    expect(live.status).not.toBe('matched');
    expect(live.resolved_grams).toBeUndefined();
    expect(live.mass_source).toBeUndefined();
    expect(live.household_authority_class).toBeUndefined();
    const calculated = session.calculate(buildCalculationRequest(f.adapted, state));
    expect(calculated.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT I-1 — Phase 6-driven stale Phase 5C verifier maintenance
// ---------------------------------------------------------------------------

describe('phase 7 — hamburger household persistence regression (I-1)', () => {
  const HAMBURGER_LINES: ReadonlyArray<string> = [
    '1 pound ground beef (80/20), formed into 4 patties',
    '1 teaspoon kosher salt',
    '0.5 teaspoon ground black pepper',
    '8 slices bacon',
    '4 slices cheddar cheese',
    '4 burger buns',
    '1 cup shredded lettuce',
    '2 medium tomatoes, sliced',
    '4 pickles, sliced',
    '2 tablespoons mayonnaise',
    '1 tablespoon ketchup',
  ];

  function hamburgerRecipe(): ObsidianRecipe {
    return {
      id: 'hamburger-7',
      fileName: 'Hamburger.md',
      filePath: 'Recipes/Hamburger.md',
      rawMarkdown: '',
      title: 'Hamburger',
      tags: [],
      category: 'Dinner',
      cuisine: 'Test',
      difficulty: 'Easy',
      rating: 4,
      servings: 4,
      ingredients: HAMBURGER_LINES.map((line) => {
        const parsed = parseIngredientLine(line);
        return {
          original: parsed.original,
          name: parsed.name,
          ...(parsed.amount !== null ? { amount: parsed.amount } : {}),
          ...(parsed.unit ? { unit: parsed.unit } : {}),
        };
      }) as never,
      instructions: [],
      callouts: [],
      dataviewFields: {},
      wikilinks: [],
      frontmatter: {},
    } as unknown as ObsidianRecipe;
  }

  interface HamburgerFixture {
    readonly recipe: ObsidianRecipe;
    readonly state: Phase4State;
    readonly preview: NonNullable<Phase4State['preview']>;
  }

  /**
   * BOUNDED FILE-SCOPED FIXTURE (test-stability repair, no coverage change).
   *
   * The analyzer-driven hamburger review is deterministic and read-only, but its
   * real-bundle work (11-ingredient analyzer pass, review rows, and calculation)
   * legitimately costs multiple seconds; under full-suite parallel contention it
   * exceeded Vitest's default 5000 ms per-test timeout. The invariant setup runs
   * ONCE here, in a bounded hook outside the per-test timeout clock. The test
   * body still performs the authorization gate and every assertion unchanged.
   */
  let hamburgerFixture: HamburgerFixture | undefined;

  beforeAll(() => {
    const recipe = hamburgerRecipe();
    const adaptation = adaptRecipe(recipe);
    if (!adaptation.ok) throw new Error('hamburger adaptation failed');
    const adapted = adaptation.recipe.adapted;
    const analysis = analyzeRecipe(session, adapted, 4);
    let state = phase4Reducer(INITIAL_PHASE4_STATE, {
      type: 'initialize',
      recipeKey: adaptation.recipe.recipe_key,
      sessionIdentity: phase4SessionIdentity(session.metadata()),
      rows: buildReviewRows(session, adapted),
      baseServings: 4,
    });
    state = phase4Reducer(state, {
      type: 'apply_analysis',
      matches: analysis.matches,
      portions: analysis.portions,
      countPortions: analysis.countPortions,
      householdPortions: analysis.householdPortions,
      preview: analysis.preview,
    });
    const calculated = session.calculate(buildCalculationRequest(adapted, state));
    if (!calculated.ok) throw new Error('hamburger calculation failed');
    hamburgerFixture = Object.freeze({
      recipe,
      state,
      preview: calculated.preview,
    });
  }, 120000);

  it('persists the analyzer hamburger as schema v2 with truthful household provenance', () => {
    const fixture = hamburgerFixture as HamburgerFixture;
    const { recipe, state, preview } = fixture;
    const authorized = authorizeNutritionPersistence({
      session,
      recipe,
      state: {
        ...state,
        status: 'preview_current',
        preview,
        previewKey: state.recipeKey,
      },
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    const block = authorized.candidate.block as CodexNutritionV2;
    expect(block.schema).toBe(2);
    const tomato = block.ingredients.find((entry) => entry.source_food_id === '2709719');
    expect(tomato?.conversion_basis).toBe('household_portion');
    expect(tomato?.amount?.value).toBe(246);
    const household = tomato?.household_portion as HouseholdPortionEvidence | undefined;
    expect(household?.registry_release).toBe('household_portion_initial_usda_v1');
    expect(household?.record_key).toBe('tomato|item|medium|null');
    expect(household?.household_unit).toBe('item');
    expect(household?.size_class).toBe('medium');
    expect(household?.requires_state).toBeNull();
    expect(household?.quantity).toBe(2);
    expect(household?.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(household?.selection_digest).toMatch(/^[0-9a-f]{64}$/);
    const bacon = block.ingredients.find((entry) => entry.source_food_id === '168277');
    expect(bacon?.amount?.value).toBe(224);
    expect(block.unresolved).toHaveLength(1);
    expect(block.unresolved[0]?.reason).toBe('no_mass');
    const decoded = decodeCodexNutrition(encodeCodexNutrition(block));
    expect(decoded.kind).toBe('v2');
  });

  it('a non-household persisted recipe remains canonical schema v1', () => {
    const f = flow('100 g tomatoes');
    const calculated = session.calculate(buildCalculationRequest(f.adapted, f.state));
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    const authorized = authorizeNutritionPersistence({
      session,
      recipe: f.recipe,
      state: {
        ...f.state,
        status: 'preview_current',
        preview: calculated.preview,
        previewKey: f.state.recipeKey,
      },
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    expect(authorized.candidate.block.schema).toBe(1);
    expect(decodeCodexNutrition(encodeCodexNutrition(authorized.candidate.block)).kind).toBe('v1');
  });
});
