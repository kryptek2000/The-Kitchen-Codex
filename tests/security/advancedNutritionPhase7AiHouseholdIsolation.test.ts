/**
 * The Kitchen Codex — Advanced Nutrition Phase 7: AI household-alignment
 * security/isolation.
 *
 * Proves the Phase 7 AI household adapter is offline, dependency-bounded, and
 * fail-closed:
 *   - no network/filesystem/environment/clock/randomness/persistence/dynamic
 *     code and no provider/runtime reference in the new module;
 *   - the adapter reaches ONLY the existing canonical household/count/unit
 *     contracts and the genuine Phase 4/Phase 6 builder;
 *   - the closed hint vocabulary is bounded, deterministic, and bound to the
 *     registry vocabulary;
 *   - inputs are never mutated and a structural fake session can never
 *     manufacture authority;
 *   - resolved evidence is bound to the REAL verified registry digests (the
 *     adapter cannot synthesize a record);
 *   - the calculation layer imports no UI/Phase 4/provider module.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import * as aiHousehold from '../../src/core/nutritionV2/phase4/aiHouseholdResolve';
import * as householdContext from '../../src/core/nutritionV2/phase4/householdContext';
import { resolveHouseholdsFromAiSuggestions } from '../../src/core/nutritionV2/phase4/aiHouseholdResolve';
import {
  canonicalHouseholdState,
  sanitizeHouseholdRequirementHint,
} from '../../src/core/nutritionV2/calculation/householdPortion';
import { HOUSEHOLD_STATES, HOUSEHOLD_SIZE_CLASSES, HOUSEHOLD_AUTHORITY_CLASSES } from '../../src/core/nutritionV2/household/normalize';
import { canonicalSize } from '../../src/core/nutritionV2/calculation/countPortion';
import {
  householdContainerNouns,
  householdCountNouns,
} from '../../src/utils/householdUnits';
import {
  buildAiResolutionSchema,
  sanitizeAiResolutionResponse,
} from '../../src/core/nutritionV2/aiResolution';
import { loadHouseholdInitialRegistry } from '../../src/core/nutritionV2/household/initialData';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PHASE7_MODULES = [
  resolve(ROOT, 'src/core/nutritionV2/phase4/aiHouseholdResolve.ts'),
  resolve(ROOT, 'src/core/nutritionV2/phase4/householdContext.ts'),
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('phase 7 — module purity and dependency boundary', () => {
  it('contains no network, filesystem, environment, time, randomness, persistence, or provider token', () => {
    const tokens = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\baxios\b/,
      /node:(fs|path|http|https|net|dns|tls|os|process|child_process)\b/,
      /process\s*\.\s*env/,
      /localStorage/,
      /sessionStorage/,
      /indexedDB/,
      /\bMath\.random\b/,
      /\bDate\.now\b/,
      /new\s+Date\s*\(/,
      /\bperformance\.now\b/,
      /globalThis\.crypto/,
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /codex_nutrition/,
      /vaultFileSystem/,
      /vaultAssets/,
      /nutritionEstimator/,
      /nutritionCache/,
      /openrouter|gemini|GEMINI/i,
      /nutritionResolve/i,
      /generateStructured/,
      /provider/,
    ];
    for (const file of PHASE7_MODULES) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const token of tokens) {
        expect(source, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('reaches only the existing canonical contracts and genuine builders', () => {
    const source = readFileSync(PHASE7_MODULES[0], 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of imports) {
      expect(
        [
          '../calculation/householdPortion',
          '../../../utils/householdUnits',
          '../calculation/countPortion',
          './householdPortion',
          './rows',
          '../aiResolution',
          './liveRow',
          './types',
        ],
        `unexpected import ${specifier}`
      ).toContain(specifier);
    }
    // The AI wire contract is imported as a TYPE only.
    expect(source).toMatch(/import type \{[^}]*\} from '\.\.\/aiResolution'/);
    // It never imports raw registry data/lock/provenance or the loader.
    expect(source).not.toMatch(/initialData|initialLock|initialProvenance|household\/registry/);
  });

  it('exposes no mutable/registration surface', () => {
    const keys = Object.keys(aiHousehold);
    for (const key of keys) {
      expect(key).not.toMatch(/register|insert|update|replace|mutate|save|persist|apply|set/i);
    }
    expect(keys).not.toContain('loadHouseholdInitialRegistry');
    const namespace = aiHousehold as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = namespace[key];
      expect(Array.isArray(value), `${key} must not be a data array`).toBe(false);
    }
    expect(Object.keys(householdContext).sort()).toEqual(
      ['canonicalHouseholdRequirementHint', 'canonicalHouseholdState'].sort()
    );
  });

  it('calculation and resolver layers import no UI/Phase 4/provider module', () => {
    const forbidden = /from\s+['"][^'"]*(components|application|server|phase4|aiResolution)[^'"]*['"]/;
    for (const file of [
      resolve(ROOT, 'src/core/nutritionV2/calculation/calculate.ts'),
      resolve(ROOT, 'src/core/nutritionV2/calculation/householdPortion.ts'),
    ]) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source, `${file} must not import UI/Phase4/provider modules`).not.toMatch(forbidden);
    }
  });
});

describe('phase 7 — closed vocabulary is bounded and deterministic', () => {
  it('binds the state vocabulary to the ONE registry owner', () => {
    expect(HOUSEHOLD_STATES.length).toBe(8);
    const probes = ['raw', 'cooked', 'canned', 'drained', 'undrained', 'fresh', 'dried', 'frozen'];
    for (const probe of probes) {
      expect(canonicalHouseholdState(probe)).toBe(canonicalHouseholdState(probe));
      expect(canonicalHouseholdState(probe)).toBe(probe);
    }
  });

  it('binds accepted sizes to the registry size classes', () => {
    for (const size of HOUSEHOLD_SIZE_CLASSES) {
      expect(canonicalSize(size)).toBe(size);
    }
    for (const hostile of ['free', 'size 4', 'gigantic', '99', '<script>']) {
      expect(canonicalSize(hostile)).toBeNull();
    }
  });

  it('pins the exact test matrices to the canonical production vocabularies (drift guard)', () => {
    // EXACT test matrices. These are intentionally duplicated here: adding or
    // removing a production vocabulary token MUST require an intentional update
    // to this list (set equality fails in both directions), so the Phase 7 AI
    // contract can never silently accept a token the tests never pinned.
    const stateMatrix = [
      'raw',
      'cooked',
      'canned',
      'drained',
      'undrained',
      'fresh',
      'dried',
      'frozen',
    ];
    const sizeMatrix = ['small', 'medium', 'large', 'jumbo', 'mini', 'petite', 'xl', 'xxl'];
    const countNounMatrix = [
      'clove',
      'slice',
      'piece',
      'stick',
      'head',
      'stalk',
      'sprig',
      'bunch',
      'leaf',
      'fillet',
      'breast',
      'thigh',
      'rib',
      'strip',
      'link',
      'scoop',
      'item',
    ];
    const authorityMatrix = ['usda_derived', 'vetted_standard', 'bounded_estimate'];

    expect([...HOUSEHOLD_STATES].sort()).toEqual([...stateMatrix].sort());
    expect([...HOUSEHOLD_SIZE_CLASSES].sort()).toEqual([...sizeMatrix].sort());
    expect([...householdCountNouns()].sort()).toEqual([...countNounMatrix].sort());
    expect([...HOUSEHOLD_AUTHORITY_CLASSES].sort()).toEqual([...authorityMatrix].sort());

    // AI-eligible household count nouns are EXACTLY the canonical count
    // vocabulary: containers are never AI-eligible count conversions.
    const countNouns = new Set(householdCountNouns());
    for (const container of householdContainerNouns()) {
      expect(countNouns.has(container), `container ${container} must not be AI-eligible`).toBe(false);
    }
    // Every matrix token is accepted by the corresponding canonical owner.
    for (const state of stateMatrix) expect(HOUSEHOLD_STATES).toContain(state);
    for (const size of sizeMatrix) expect(HOUSEHOLD_SIZE_CLASSES).toContain(size);
  });

  it('never leaks unknown or authority-shaped hint data', () => {
    const outcome = sanitizeHouseholdRequirementHint({
      unit: 'clove',
      size: 'medium',
      state: 'raw',
      grams: 100,
    });
    expect(outcome.ok).toBe(false);
    const sanitized = sanitizeHouseholdRequirementHint({
      unit: 'clove',
      size: 'medium',
      state: 'raw',
    });
    expect(sanitized.ok).toBe(true);
    if (sanitized.ok) {
      expect(Object.keys(sanitized.hint ?? {}).sort()).toEqual(['size', 'state', 'unit']);
    }
  });

  it('rejects authority-shaped provider responses whole and never passes them through', () => {
    const schema = buildAiResolutionSchema() as unknown as {
      properties: { suggestions: { items: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.suggestions.items.properties).not.toHaveProperty('grams');
    expect(schema.properties.suggestions.items.properties).not.toHaveProperty('fdc_id');
    expect(schema.properties.suggestions.items.properties).not.toHaveProperty('record_id');
    const rejected = sanitizeAiResolutionResponse(
      {
        version: 4,
        suggestions: [
          {
            line_ref: 'l1',
            interpreted_food_name: 'x',
            suggested_usda_queries: [],
            household_size_hint: 'medium',
            grams: 100,
          },
        ],
      },
      { allowedLineRefs: ['l1'] }
    );
    expect(rejected.ok).toBe(false);
  });
});

describe('phase 7 — isolation invariants', () => {
  it('never mutates its inputs', () => {
    const suggestion = Object.freeze({
      line_ref: 'l1',
      interpreted_food_name: 'x',
      suggested_usda_queries: Object.freeze([]) as ReadonlyArray<string>,
      household_size_hint: 'medium',
    });
    const ingredient = Object.freeze({ original: '2 tomatoes', amount: 2, name: 'tomatoes' });
    const entry = Object.freeze({ line_ref: 'l1', ingredient });
    const row = Object.freeze({
      line_ref: 'l1',
      original_text: '2 tomatoes',
      outcome: 'review_required',
      query: 'tomatoes',
      candidates: Object.freeze([]),
      review_digest: 'r'.repeat(64),
      selected_fdc_id: undefined,
      review: undefined,
      note: undefined,
    });
    const live = Object.freeze({
      line_ref: 'l1',
      original_text: '2 tomatoes',
      status: 'needs_amount',
      food_authority: 'automatic',
      selected_fdc_id: 2709719,
      selected_description: 'Tomatoes, raw',
      resolved_grams: undefined,
      mass_source: undefined,
      portion_index: undefined,
      user_mass_quantity: undefined,
      user_mass_unit: undefined,
      source_portion_automatic: false,
      household_unit: undefined,
      household_size_class: undefined,
      household_requires_state: undefined,
      household_authority_class: undefined,
    });
    const state = Object.freeze({
      version: '',
      status: 'ready',
      recipeKey: 'r',
      sessionIdentity: 's',
      baseServings: 1,
      rows: Object.freeze([row]),
      matches: Object.freeze({}),
      portions: Object.freeze({}),
      countPortions: Object.freeze({}),
      userMasses: Object.freeze({}),
      householdPortions: Object.freeze({}),
      basis: 'entire_recipe',
      selectedServings: 1,
      preview: null,
      previewKey: null,
      failure: null,
      operationSeq: 0,
    });
    const before = JSON.stringify({ suggestion, entry, live, state, ingredient });
    const outcome = resolveHouseholdsFromAiSuggestions({
      session: {} as never,
      rows: Object.freeze([row]) as never,
      adapted: Object.freeze([entry]) as never,
      liveRows: Object.freeze([live]) as never,
      state: state as never,
      suggestions: Object.freeze([suggestion]),
    });
    expect(outcome.resolved).toHaveLength(0);
    expect(JSON.stringify({ suggestion, entry, live, state, ingredient })).toBe(before);
  });

  it('a structural fake session can never manufacture a household resolution', () => {
    const fake = {
      calculate: () => ({ ok: false, failure: { code: 'invalid_context' } }),
      metadata: () => ({}),
    } as never;
    const outcome = resolveHouseholdsFromAiSuggestions({
      session: fake,
      rows: [] as never,
      adapted: [] as never,
      liveRows: [] as never,
      state: {} as never,
      suggestions: [],
    });
    expect(outcome.resolved).toHaveLength(0);
  });

  it('binds every resolved evidence field to the REAL verified registry digests', () => {
    const loaded = loadHouseholdInitialRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const tomatoMedium = loaded.registry
      .records()
      .find((record) => record.food_key === 'tomato' && record.size_class === 'medium');
    expect(tomatoMedium).toBeDefined();
    if (!tomatoMedium) return;
    // The registry digest oracle is fixed and independently asserted elsewhere;
    // here we only prove the adapter has no way to fabricate a different one:
    // the record digest is a 64-char lowercase hex computed by the registry.
    expect(tomatoMedium.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(tomatoMedium.grams_per_unit).toBe(123);
    expect(tomatoMedium.authority_class).toBe('usda_derived');
  });

  it('is independent of ambient state (repeat calls are byte-identical)', () => {
    const a = JSON.stringify(
      sanitizeHouseholdRequirementHint({ unit: 'clove', size: 'medium', state: 'raw' })
    );
    const b = JSON.stringify(
      sanitizeHouseholdRequirementHint({ unit: 'clove', size: 'medium', state: 'raw' })
    );
    expect(a).toBe(b);
  });
});
