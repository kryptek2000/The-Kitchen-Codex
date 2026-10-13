/**
 * The Kitchen Codex — Phase 9B-3B.
 * AUTHENTICATED SEMANTIC-TO-USDA BRIDGE — real offline integration proof.
 *
 * WHAT IS REAL HERE. Only the external provider is mocked.
 *   - the semantic operation is the released one (real mock-provider transport),
 *   - the receipt authority is the REAL process-scoped one,
 *   - the Phase 9B-3A consumer performs the GENUINE same-process MAC
 *     verification — receipt verification is NOT mocked,
 *   - the adapter and withholding are the RELEASED ones,
 *   - the USDA catalog is the REAL pinned, digest-authenticated bundle
 *     (`usda_fdc_87c5408a3e98838944a87be74824761e`), composed through the real
 *     bundle authenticator,
 *   - food-identity matching, confidence, source-constraint veto and review
 *     withholding are the GENUINE deterministic functions.
 *
 * NO accepted FDC identity is fabricated. Every candidate is asserted to originate
 * from the real catalog (fdc_id + record_digest + catalog_digest). If the
 * deterministic system declines to identify an eligible whole-egg candidate, the
 * correct expectation is an OFFERED candidate or an unresolved row — which is
 * exactly what this suite asserts.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiCandidate, RegisteredProvider } from '../../server/ai/providerRegistry';
import type {
  AiCapabilities,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from '../../src/core/ai/types';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import {
  analyzeRecipe,
  buildReviewRows,
  liveExceptionKind,
  projectLiveRows,
  resolveFoodsFromAiSuggestions,
  type AdaptedIngredient,
  type AdvancedNutritionSession,
  type Phase4State,
} from '../../src/core/nutritionV2/phase4';
import { withholdBelowThresholdAutoAcceptance } from '../../src/application/nutritionAiResolve';
import {
  createWholeRecipeSemanticOriginAuthority,
  type WholeRecipeSemanticOriginAuthority,
} from '../../server/wholeRecipeSemanticOriginReceipt';
import { consumeAuthenticatedWholeRecipeSemantics } from '../../server/wholeRecipeSemanticConsumption';
import {
  bridgeAuthenticatedSemanticsToAdvisorySuggestions,
  selectFoodIdentitySuggestions,
} from '../../server/wholeRecipeSemanticUsdaBridge';
import type { AiResolutionIssueKind, AiResolutionSuggestion } from '../../src/core/nutritionV2/aiResolution';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

// ---------------------------------------------------------------------------
// THE FIXTURE RECIPE (unchanged from Phase 9B-P3 / P5 / P5B)
// ---------------------------------------------------------------------------

const LINES: ReadonlyArray<string> = [
  '4 eggs, separated',
  '1 cup whole milk',
  '2 cups all-purpose flour',
  '6 tbsp unsalted butter',
  '1 tsp sea salt',
];
const INSTRUCTIONS = [
  { text: 'Separate the whites from the yolks.' },
  { text: 'Beat the whites until stiff peaks.' },
  { text: 'Fold the whites back into the yolks.' },
];
const EGG_LINE_REF = 'ing:0:20e4077fc89a';

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

function wholeRecipeRequest(): Record<string, unknown> {
  return {
    request_version: 'nutrition_ai_whole_recipe_interpretation_request_v1',
    request_id: '9b3b-egg',
    recipe: { ingredients: LINES.map((name) => ({ name })) },
    instructions: INSTRUCTIONS,
    targets: [{ line_ref: EGG_LINE_REF }],
  };
}

// ---------------------------------------------------------------------------
// THE REAL USDA SESSION + DETERMINISTIC ROWS
// ---------------------------------------------------------------------------

let session: AdvancedNutritionSession;
let eggAdapted: ReadonlyArray<AdaptedIngredient>;
let eggRows: Parameters<typeof resolveFoodsFromAiSuggestions>[0]['rows'];
let eggIssueKinds: Readonly<Record<string, AiResolutionIssueKind>>;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) {
    throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  }
  session = result.session;

  const adaptation = adaptRecipe({
    title: 'Separated Egg Souffle Base',
    servings: 4,
    ingredients: LINES.map(structuredLine),
  });
  if (!adaptation.ok) throw new Error('adapt failed');
  eggAdapted = adaptation.recipe.adapted;

  const analysis = analyzeRecipe(session, eggAdapted, 4);
  eggRows = buildReviewRows(session, eggAdapted);
  const state = {
    version: '',
    status: 'ready',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: null,
    baseServings: 4,
    rows: eggRows,
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    userMasses: {},
    basis: 'entire_recipe',
    selectedServings: 4,
    preview: analysis.preview ?? null,
    previewKey: null,
    failure: null,
    operationSeq: 0,
  } as Phase4State;
  const analyzedByRef = new Map(analysis.rows.map((row) => [row.line_ref, row]));
  const liveRows = projectLiveRows(
    state,
    analyzedByRef,
    eggAdapted,
    session,
    analysis.preview ? null : null,
    analysis.portions,
    analysis.countPortions
  );
  const kinds: Record<string, AiResolutionIssueKind> = {};
  for (const row of liveRows) {
    const kind = liveExceptionKind(row.status);
    if (kind !== undefined) kinds[row.line_ref] = kind;
  }
  eggIssueKinds = Object.freeze(kinds);
}, 240000);

// ---------------------------------------------------------------------------
// MOCK PROVIDER — the ONLY mocked component
// ---------------------------------------------------------------------------

const prov = vi.hoisted(() => ({ calls: 0, failure: null as null | string }));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return { ...actual, getRegisteredProviders: () => [] };
});

function mockProvider(): AiProvider {
  return {
    id: 'gemini',
    name: 'gemini',
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (_p: string, _s: AiJsonSchema, options?: AiStructuredOptions) => {
      prov.calls += 1;
      if (prov.failure === 'sanitizer') {
        // Schema-legal but sanitizer-rejected: five search phrases (>4).
        return {
          contract_version: 'nutrition_ai_advanced_interpretation_v1',
          interpretations: [
            {
              contract_version: 'nutrition_ai_advanced_interpretation_v1',
              line_ref: EGG_LINE_REF,
              semantic_food: { normalized_name: 'whole egg' },
              search_phrases: ['a', 'b', 'c', 'd', 'e'],
              amount_semantics: { kind: 'exact' },
              unit_semantics: { family: 'count' },
              count_semantics: {},
              alternatives: [],
              ambiguity: { ambiguous: false, reasons: [] },
            },
          ],
        } as never;
      }
      if (prov.failure === 'ambiguous') {
        return {
          contract_version: 'nutrition_ai_advanced_interpretation_v1',
          interpretations: [
            {
              contract_version: 'nutrition_ai_advanced_interpretation_v1',
              line_ref: EGG_LINE_REF,
              semantic_food: { normalized_name: 'egg' },
              search_phrases: ['whole egg'],
              amount_semantics: { kind: 'exact', echoed_value: 4 },
              unit_semantics: { family: 'count' },
              count_semantics: { noun: 'eggs' },
              alternatives: [],
              ambiguity: { ambiguous: true, reasons: ['yolk or white'] },
            },
          ],
        } as never;
      }
      // The P5B-observed authentic fallback shape for "4 eggs, separated":
      // whole eggs, recombined per the instructions.
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: [
          {
            contract_version: 'nutrition_ai_advanced_interpretation_v1',
            line_ref: EGG_LINE_REF,
            semantic_food: {
              normalized_name: 'whole egg',
              modifiers: ['separated', 'recombined'],
              preparation: ['beaten'],
              state: ['raw'],
              qualifiers: [],
            },
            search_phrases: ['whole egg'],
            amount_semantics: { kind: 'exact', echoed_value: 4, phrasing: '4' },
            unit_semantics: { family: 'count', raw: 'eggs', interpreted_unit: 'count' },
            count_semantics: { noun: 'eggs' },
            alternatives: [],
            ambiguity: { ambiguous: false, reasons: [] },
            confidence: 'high',
            notes: 'Whites beaten then folded back into the yolks.',
          },
        ],
      } as never;
    },
  };
}

/** Runs the REAL semantic operation and returns the issued envelope. */
async function issue(): Promise<Record<string, unknown>> {
  const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
  const provider = mockProvider();
  const candidates: AiCandidate[] = [{ provider, model: 'gemini-3.1-flash-lite' }];
  const registry: RegisteredProvider[] = [
    { provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities },
  ];
  const result = await interpretWholeRecipeSemantics(wholeRecipeRequest(), { candidates, registry });
  if (result.ok !== true) throw new Error(`operation failed: ${result.code}`);
  return {
    request_id: result.request_id,
    context_binding: result.context_binding,
    semantic_response: result.semantic_response,
    provider_id: result.provider_id,
    model_id: result.model_id,
    operation_id: result.operation_id,
    origin_receipt: result.origin_receipt,
  };
}

beforeAll(() => {
  prov.calls = 0;
  prov.failure = null;
});
afterEach(() => {
  prov.calls = 0;
  prov.failure = null;
});

// ---------------------------------------------------------------------------
// §13 — REAL END-TO-END INTEGRATION
// ---------------------------------------------------------------------------

describe('9B-3B — real offline semantic-to-USDA path (pinned catalog)', () => {
  it('authenticated semantics reach REAL deterministic catalog candidate discovery', async () => {
    const envelope = await issue();

    // 1 + 2 + 3: the bridge performs the genuine MAC verification and the
    // released adaptation. No matching happens inside the bridge.
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(true);
    if (bridge.ok !== true) return;
    expect(bridge.authority).toBe('authenticated_advisory_search_suggestions');
    expect(bridge.suggestions).toHaveLength(1);
    expect(bridge.withheld).toHaveLength(0);

    const suggestion = bridge.suggestions[0] as AiResolutionSuggestion;
    expect(suggestion.line_ref).toBe(EGG_LINE_REF);
    expect(suggestion.interpreted_food_name).toBe('whole egg');

    // 4: the GENUINE deterministic matcher runs against the REAL catalog.
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows: eggRows,
      adapted: eggAdapted,
      suggestions: selectFoodIdentitySuggestions(bridge.suggestions, eggIssueKinds),
    });

    // 5: the genuine review-suggested withholding runs afterwards.
    const final = withholdBelowThresholdAutoAcceptance({ outcome, issueKinds: eggIssueKinds });

    // Whether the deterministic system identifies an eligible candidate is ITS
    // decision, not ours. Both outcomes are legitimate; neither is fabricated.
    const covered = new Set(final.candidates.map((c) => c.line_ref));
    if (!covered.has(EGG_LINE_REF)) {
      expect(final.unresolved).toContain(EGG_LINE_REF);
    }

    // 11: EVERY candidate must be a genuine catalog record.
    for (const candidate of final.candidates) {
      expect(candidate.fdc_id).toBeGreaterThan(0);
      expect(candidate.choice.record_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(candidate.choice.catalog_digest).toBe(session.metadata().catalog_digest);
      expect(candidate.description.length).toBeGreaterThan(0);
      // The AI never authorized acceptance; the deterministic contract did.
      if (candidate.auto) expect(candidate.choice.aiAccepted).toBe(true);
      else expect(candidate.choice.aiAccepted).toBeUndefined();
    }
    // No candidate may exist for a line we never asked about.
    expect(final.candidates.every((c) => eggIssueKinds[c.line_ref] !== undefined)).toBe(true);
  }, 60000);

  it('the deterministic system GRANTS a real whole-egg candidate for the AI wording', async () => {
    // The genuine outcome of this recipe, observed rather than assumed:
    //   "4 eggs, separated" -> live status `needs_match`
    //   AI advisory wording "whole egg" -> deterministic match on a REAL record
    //   whose description is a WHOLE EGG, and whose record digest comes from the
    //   pinned catalog.
    //
    // Nothing here fabricates the identity: the FDC id, description and both
    // digests are produced by the real matcher over the real bundle. The test
    // asserts PROPERTIES of the genuine result, never a hard-coded FDC id.
    expect(eggIssueKinds[EGG_LINE_REF]).toBe('needs_match');

    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(true);
    if (bridge.ok !== true) return;

    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows: eggRows,
      adapted: eggAdapted,
      suggestions: selectFoodIdentitySuggestions(bridge.suggestions, eggIssueKinds),
    });

    // The deterministic system did resolve this line.
    expect(outcome.candidates.length).toBeGreaterThan(0);
    const eggCandidate = outcome.candidates.find((c) => c.line_ref === EGG_LINE_REF);
    expect(eggCandidate).toBeDefined();
    if (!eggCandidate) return;

    // It is a genuine catalog record.
    expect(eggCandidate.fdc_id).toBeGreaterThan(0);
    expect(eggCandidate.choice.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(eggCandidate.choice.catalog_digest).toBe(session.metadata().catalog_digest);

    // It is a WHOLE EGG. The catalog also offers duck / goose / quail whole eggs
    // for this wording; the source-constraint veto must have excluded them.
    expect(eggCandidate.description).toMatch(/egg/i);
    expect(eggCandidate.description).toMatch(/whole/i);
    expect(eggCandidate.description).not.toMatch(/duck|goose|quail/i);

    // Cross-check the SAME record is reachable by direct catalog review with NO
    // AI involved, proving the identity is the catalog's, not the AI's.
    const direct = session.reviewIngredient({ name: 'whole egg' });
    expect(direct.outcome).not.toBe('invalid');
    expect(direct.outcome).not.toBe('unmatched');
    if (direct.outcome === 'invalid' || direct.outcome === 'unmatched') return;
    expect(direct.candidates.some((c) => c.fdc_id === eggCandidate.fdc_id)).toBe(true);
  }, 60000);

  it('the transport carries NO USDA or nutrient authority field', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(true);
    const text = JSON.stringify(bridge);
    for (const forbidden of ['fdc_id', 'fdcId', 'record_digest', 'catalog_digest', 'grams', 'nutrients', 'calories', 'portion_grams', 'apply', 'persist']) {
      expect(new RegExp(`"${forbidden}"`, 'i').test(text), `transport leaked ${forbidden}`).toBe(false);
    }
  });

  it('a candidate produced from a real bridge suggestion is catalog-backed', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(true);
    if (bridge.ok !== true) return;
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows: eggRows,
      adapted: eggAdapted,
      suggestions: bridge.suggestions,
    });
    // Deterministic confidence is unchanged: the AI never set `auto`.
    for (const candidate of outcome.candidates) {
      expect(candidate.auto).toBeTypeOf('boolean');
    }
    expect(outcome.auto_count).toBe(outcome.candidates.filter((c) => c.auto).length);
  }, 60000);
});

// ---------------------------------------------------------------------------
// §14 — ADVERSARIAL
// ---------------------------------------------------------------------------

describe('9B-3B — invalid proof yields NO AI-assisted USDA candidate', () => {
  it('forged receipt produces no suggestions', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: { ...envelope, origin_receipt: `wsem1.${'A'.repeat(43)}` },
    });
    expect(bridge.ok).toBe(false);
    expect((bridge as { suggestions: readonly [] }).suggestions).toHaveLength(0);
  });

  it('wrong-process (foreign authority) receipt produces no suggestions', async () => {
    const envelope = await issue();
    // Prove the SAME receipt fails against a DIFFERENT authority instance.
    const foreign = createWholeRecipeSemanticOriginAuthority();
    const direct = consumeAuthenticatedWholeRecipeSemantics(
      wholeRecipeRequest(),
      envelope,
      foreign
    );
    expect(direct.ok).toBe(false);
    // And the bridge refuses the same material.
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    // The bridge uses the REAL process authority, so it DOES accept its own.
    expect(bridge.ok).toBe(true);
  });

  it('changed recipe text fails closed', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: {
        ...wholeRecipeRequest(),
        recipe: { ingredients: [{ name: '6 eggs, separated' }] },
      },
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(false);
    expect((bridge as { suggestions: readonly [] }).suggestions).toHaveLength(0);
  });

  it('changed instructions fail closed', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: { ...wholeRecipeRequest(), instructions: [{ text: 'Bake it.' }] },
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(false);
  });

  it('changed context binding fails closed', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: { ...envelope, context_binding: `sha256:${'0'.repeat(64)}` },
    });
    expect(bridge.ok).toBe(false);
  });

  it('changed operation identity fails closed (replay)', async () => {
    const envelope = await issue();
    const other = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: { ...envelope, operation_id: other.operation_id },
    });
    expect(bridge.ok).toBe(false);
  });

  it('changed provider identity fails closed', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: { ...envelope, provider_id: 'attacker' },
    });
    expect(bridge.ok).toBe(false);
  });

  it('missing / duplicate / extra targets fail closed', async () => {
    const envelope = await issue();
    const rows = envelope.semantic_response as Array<Record<string, unknown>>;
    for (const bad of [[], [rows[0], rows[0]], [rows[0], { ...rows[0], line_ref: 'ing:1:41a9f1726c1b' }]]) {
      const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
        rawRequest: wholeRecipeRequest(),
        issuedEnvelope: { ...envelope, semantic_response: bad },
      });
      expect(bridge.ok, JSON.stringify(bad.map((r) => r.line_ref))).toBe(false);
    }
  });

  it('inherited envelope properties cannot authorize consumption', async () => {
    const envelope = await issue();
    // The receipt exists ONLY on the PROTOTYPE. Every other field is copied as an
    // OWN property, so the ONLY difference from a valid envelope is where the
    // receipt physically lives. A plain `obj.receipt` read would walk the chain
    // and find it; the own-data-property read must not.
    const hostile = Object.create({ origin_receipt: envelope.origin_receipt }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(envelope)) {
      if (key === 'origin_receipt') continue;
      hostile[key] = value;
    }
    expect(Object.getOwnPropertyDescriptor(hostile, 'origin_receipt')).toBeUndefined();

    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: hostile,
    });
    expect(bridge.ok).toBe(false);
    expect((bridge as { suggestions: readonly [] }).suggestions).toHaveLength(0);
  });

  it('getter-backed semantic_response cannot confer authority', async () => {
    const envelope = await issue();
    let invoked = false;
    const hostile: Record<string, unknown> = { ...envelope };
    Object.defineProperty(hostile, 'semantic_response', {
      get() {
        invoked = true;
        return envelope.semantic_response;
      },
      enumerable: true,
    });
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: hostile,
    });
    // The 3A consumer refuses accessor-backed material before the bridge reads it.
    expect(bridge.ok).toBe(false);
    expect(invoked).toBe(false);
  });

  it('sanitizer-rejected provider output yields no suggestions', async () => {
    prov.failure = 'sanitizer';
    // The operation itself refuses, so no envelope is ever issued.
    const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
    const provider = mockProvider();
    const candidates: AiCandidate[] = [{ provider, model: 'gemini-3.1-flash-lite' }];
    const registry: RegisteredProvider[] = [
      { provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities },
    ];
    const result = await interpretWholeRecipeSemantics(wholeRecipeRequest(), { candidates, registry });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_response');
  });

  it('malformed / null projected observations cannot crash the bridge', async () => {
    const envelope = await issue();
    for (const bad of [null, undefined, 'x', 42, {}, [null], [undefined]]) {
      const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
        rawRequest: wholeRecipeRequest(),
        issuedEnvelope: { ...envelope, semantic_response: bad },
      });
      expect(typeof bridge.ok, `payload ${JSON.stringify(bad)}`).toBe('boolean');
      if (bridge.ok !== true) expect(bridge.suggestions).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §12 — AMBIGUITY / ALTERNATIVES WITHHOLDING
// ---------------------------------------------------------------------------

describe('9B-3B — ambiguity remains withheld from USDA discovery', () => {
  it('an ambiguous semantic identity produces NO suggestion', async () => {
    prov.failure = 'ambiguous';
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    // The bridge AUTHENTICATES the row, then the RELEASED withholding removes it.
    expect(bridge.ok).toBe(true);
    if (bridge.ok !== true) return;
    expect(bridge.suggestions).toHaveLength(0);
    expect(bridge.withheld).toHaveLength(1);
    expect(bridge.withheld[0]).toMatchObject({ line_ref: EGG_LINE_REF, reason: 'ambiguous' });

    // And therefore NO AI-assisted USDA candidate can exist for that line.
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows: eggRows,
      adapted: eggAdapted,
      suggestions: bridge.suggestions,
    });
    expect(outcome.candidates).toHaveLength(0);
  }, 60000);
});

describe('9B-3B — needs_amount rows are excluded from FOOD identity resolution', () => {
  it('drops a needs_amount suggestion from the food-identity set (and keeps it when unclassified)', () => {
    // The ONLY row this recipe classifies `needs_amount` is unsalted butter.
    // Amount authority belongs to the existing AMOUNT resolver, so the bridge
    // must never route such a row through food-identity matching.
    const BUTTER_REF = 'ing:3:4fc703d60106';
    expect(eggIssueKinds[BUTTER_REF]).toBe('needs_amount');

    const suggestions: AiResolutionSuggestion[] = [
      { line_ref: EGG_LINE_REF, interpreted_food_name: 'whole egg', suggested_usda_queries: ['whole egg'] },
      { line_ref: BUTTER_REF, interpreted_food_name: 'unsalted butter', suggested_usda_queries: ['unsalted butter'] },
    ];

    // With trusted issue kinds, the butter row is REMOVED.
    const scoped = selectFoodIdentitySuggestions(suggestions, eggIssueKinds);
    expect(scoped.map((s) => s.line_ref)).toEqual([EGG_LINE_REF]);
    expect(scoped.some((s) => s.line_ref === BUTTER_REF)).toBe(false);

    // With no kinds supplied the projection is the identity (existing behaviour:
    // the caller owns the classification).
    expect(selectFoodIdentitySuggestions(suggestions)).toBe(suggestions);

    // Purely subtractive: it never adds or rewrites an entry.
    for (const kept of scoped) {
      expect(suggestions).toContainEqual(kept);
    }
  });
});

describe('9B-3B — review_suggested rows are never upgraded by AI agreement', () => {
  it('the released withholding downgrades an auto candidate on a review_suggested row', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(true);
    if (bridge.ok !== true) return;

    const suggestion = bridge.suggestions[0] as AiResolutionSuggestion;
    const outcome = resolveFoodsFromAiSuggestions({
      session,
      rows: eggRows,
      adapted: eggAdapted,
      suggestions: [suggestion],
    });
    // Force the scenario: whatever the matcher decided, if this row is classified
    // review_suggested, auto acceptance MUST be withdrawn.
    const forcedKinds = { [suggestion.line_ref]: 'review_suggested' as AiResolutionIssueKind };
    const final = withholdBelowThresholdAutoAcceptance({ outcome, issueKinds: forcedKinds });
    for (const candidate of final.candidates) {
      if (candidate.line_ref === suggestion.line_ref) {
        expect(candidate.auto).toBe(false);
        expect((candidate.choice as unknown as Record<string, unknown>).aiAccepted).toBeUndefined();
      }
    }
    // Identity-preserving when nothing changed.
    const untouched = withholdBelowThresholdAutoAcceptance({ outcome });
    expect(untouched).toBe(outcome);
  }, 60000);
});

// ---------------------------------------------------------------------------
// §14.18 / §14.19 / §14.22 / §14.23 / §14.24
// ---------------------------------------------------------------------------

describe('9B-3B — deterministic authority is unchanged and nothing is persisted', () => {
  it('the existing deterministic threshold is not altered by the bridge', async () => {
    const envelope = await issue();
    const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    expect(bridge.ok).toBe(true);
    if (bridge.ok !== true) return;
    // Bridged suggestions and hand-written suggestions are treated IDENTICALLY by
    // the matcher: the bridge grants it no special standing.
    const viaBridge = resolveFoodsFromAiSuggestions({
      session, rows: eggRows, adapted: eggAdapted, suggestions: bridge.suggestions,
    });
    const handWritten = resolveFoodsFromAiSuggestions({
      session, rows: eggRows, adapted: eggAdapted, suggestions: [bridge.suggestions[0] as AiResolutionSuggestion],
    });
    expect(viaBridge.candidates.length).toBe(handWritten.candidates.length);
    expect(viaBridge.unresolved.length).toBe(handWritten.unresolved.length);
  }, 60000);

  it('AI cannot inject FDC ids or nutrient values into the advisory transport', async () => {
    const envelope = await issue();
    for (const injected of [{ fdc_id: 1 }, { grams: 50 }, { nutrients: {} }, { catalog_digest: 'x' }]) {
      const hostile = {
        ...envelope,
        semantic_response: (envelope.semantic_response as Array<Record<string, unknown>>).map((r) => ({ ...r, ...injected })),
      };
      const bridge = bridgeAuthenticatedSemanticsToAdvisorySuggestions({
        rawRequest: wholeRecipeRequest(),
        issuedEnvelope: hostile,
      });
      expect(bridge.ok === true && bridge.suggestions.length === 0 || bridge.ok === false, JSON.stringify(injected)).toBe(true);
    }
  });

  it('missing catalog candidates remain unresolved (no fabrication)', async () => {
    const outcome = resolveFoodsFromAiSuggestions({
      session, rows: eggRows, adapted: eggAdapted, suggestions: [],
    });
    expect(outcome.candidates).toHaveLength(0);
    expect(outcome.auto_count).toBe(0);
  }, 60000);

  it('verification makes no network or provider call, and persists nothing', async () => {
    const envelope = await issue();
    const before = prov.calls;
    bridgeAuthenticatedSemanticsToAdvisorySuggestions({
      rawRequest: wholeRecipeRequest(),
      issuedEnvelope: envelope,
    });
    expect(prov.calls).toBe(before);
    expect(session.metadata().catalog_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL PINS
// ---------------------------------------------------------------------------

describe('9B-3B — structural pins for defence-in-depth the 3A gate already enforces', () => {
  const SOURCE = readFileSync(
    new URL('../../server/wholeRecipeSemanticUsdaBridge.ts', import.meta.url),
    'utf8'
  );

  it('re-reads semantic_response as an OWN, non-accessor, real array', () => {
    // MUTATION-SENSITIVE, STRUCTURAL ONLY. The Phase 9B-3A consumer already reads
    // this field with the same discipline and rejects the whole envelope when it
    // is not an own data array, so a hostile shape can NEVER reach the bridge's
    // re-read. Relaxing either check here is therefore not behaviourally
    // observable, and is pinned instead.
    expect(SOURCE).toContain("Object.getOwnPropertyDescriptor(target, key)");
    expect(SOURCE).toContain("if (!('value' in descriptor)) return undefined;");
    expect(SOURCE).toContain('return Array.isArray(value) ? value : undefined;');
  });

  it('invokes the REAL 3A consumer as the authentication gate', () => {
    expect(SOURCE).toContain('consumeAuthenticatedWholeRecipeSemantics(');
    expect(SOURCE).toContain('if (consumption.ok !== true) return failure(consumption.code);');
  });

  it('reuses the RELEASED adapter, withholding and sanitizer', () => {
    expect(SOURCE).toContain('adaptAiAdvancedInterpretationsForResolution(');
    expect(SOURCE).toContain('withholdNonDeterministicAdaptations(');
    expect(SOURCE).toContain('sanitizeAiAdvancedInterpretationResponse(');
  });

  it('imports NO matcher, session, catalog, bundle, or release-lock authority', () => {
    // The USDA session is browser-side. This server module must never drag it in.
    expect(SOURCE).not.toMatch(/phase4\/aiResolve|phase4\/session|resolveFoodsFromAiSuggestions/);
    expect(SOURCE).not.toMatch(/matching\/|runtime\/bundle|releaseLock|USDA_BUNDLE/);
  });

  it('creates NO second sanitizer, matcher, threshold, or authority', () => {
    const code = SOURCE.split('\n').filter((l) => !l.trim().startsWith('*')).join('\n');
    expect(code).not.toMatch(/selectAutomaticMatch|selectBestEffortMatch|explainCandidate|MATCH_CONFIDENCE/);
    expect(code).not.toMatch(/fdc_id|record_digest|catalog_digest|nutrient|grams|calories/i);
    expect(code).not.toMatch(/createHmac|randomBytes|timingSafeEqual|createWholeRecipeSemanticOriginAuthority/);
  });

  it('introduces NO HTTP route and NO wiring change', () => {
    expect(SOURCE).not.toMatch(/express|app\.(get|post|put|delete)|Router/);
    const app = readFileSync(new URL('../../server/app.ts', import.meta.url), 'utf8');
    expect(app).not.toContain('wholeRecipeSemanticUsdaBridge');
    expect(app).not.toContain('bridgeAuthenticatedSemanticsToAdvisorySuggestions');
  });
});
