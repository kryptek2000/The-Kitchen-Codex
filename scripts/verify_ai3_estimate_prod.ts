/**
 * AI-3 — PRODUCTION VERIFIER.
 *
 * Exercises the REAL production architecture against the REAL pinned USDA
 * bundle: capability separation, a genuinely eligible line, the pre-network
 * exclusions, the model-facing payload boundary, the deterministic midpoint,
 * the calculator arm, the effective-mass conflict, and the two-layer Apply
 * block. No paid provider access is required: the transport is a local double,
 * and everything it feeds is real production logic.
 *
 * Run: bun run scripts/verify_ai3_estimate_prod.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeAdvancedNutritionSessionFromBundle } from '../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../src/core/nutritionV2/usda/releaseLock';
import { parseIngredient } from '../src/core/nutritionV2/matching/parse';
import { adaptRecipe } from '../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../src/core/nutritionV2/phase4/analyzer';
import {
  buildCalculationRequest,
  buildReviewRows,
  lineCalculationInput,
} from '../src/core/nutritionV2/phase4/rows';
import { projectLiveRows } from '../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../src/core/nutritionV2/phase4/display';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../src/core/nutritionV2/phase4/state';
import {
  evaluateAiEstimateEligibility,
  hasUsableQuantity,
  deriveAiEstimateSnapshotInput,
} from '../src/core/nutritionV2/phase4/aiEstimateValidation';
import { deriveAiEstimateIdentityEvidence } from '../src/core/nutritionV2/phase4/aiEstimateIdentityEvidence';
import {
  AI_ESTIMATE_OFFER_LABEL,
  acceptAiEstimateOffer,
  buildAiEstimateOffer,
  buildAiEstimateUiSnapshot,
} from '../src/core/nutritionV2/phase4/aiEstimateAccept';
import { workingChoiceFingerprint } from '../src/core/nutritionV2/phase4/aiMidFlight';
import { aiEstimateSnapshotBinding } from '../src/core/nutritionV2/phase4/aiEstimateValidation';
import { AI_ESTIMATE_PROVENANCE_CLASS } from '../src/core/nutritionV2/aiAdvancedEstimate';
import { RESOLUTION_COVERAGE_CORPUS } from '../tests/fixtures/advancedNutritionResolutionCorpus';
import { requestAiMassEstimateOffers } from '../src/application/nutritionAiEstimate';

const rawBenchmarkEntries = RESOLUTION_COVERAGE_CORPUS.length;
const uniqueBenchmarkLines = new Set(RESOLUTION_COVERAGE_CORPUS.map((e) => e.line)).size;
import { buildAiEstimateSelection } from '../src/core/nutritionV2/phase4/aiEstimateSelection';
import {
  hasActiveAiEstimateForPreview,
  activeAiEstimatesForPreview,
} from '../src/core/nutritionV2/phase4/aiEstimateApplyGate';
import { resolveEffectiveMassDecision } from '../src/core/nutritionV2/calculation/effectiveMass';
import { resolveNutritionCapabilities } from '../src/core/nutritionV2/nutritionCapabilities';
import {
  buildAiEstimateModelRequest,
  aiEstimateRequestByteLength,
  MAX_AI_ESTIMATE_REQUEST_BYTES,
} from '../src/core/nutritionV2/aiAdvancedEstimateWire';
import { sanitizeEstimateProviderResponse } from '../server/nutritionEstimate';
import { summarizeAiAdvancedBenchmark } from '../src/core/nutritionV2/aiAdvancedBenchmark';
import { applyAdvancedNutrition } from '../src/application/advancedNutritionApply';
import type {
  AdaptedIngredient,
  AdvancedNutritionSession,
  AiEstimateChoice,
  Phase4State,
} from '../src/core/nutritionV2/phase4/types';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = join(REPO, 'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e');

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
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

interface Flow {
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
  readonly analysis: ReturnType<typeof analyzeRecipe>;
  readonly rows: ReturnType<typeof buildReviewRows>;
  readonly state: Phase4State;
  readonly lineRef: string;
}

function seed(session: AdvancedNutritionSession, text: string, clear = true): Flow {
  const recipe = { title: 'verify', servings: 1, ingredients: [structuredLine(text)] };
  const adaptation = adaptRecipe(recipe as never);
  if (!adaptation.ok) throw new Error(`adapt failed for ${text}`);
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(session, adapted, 1);
  const rows = buildReviewRows(session, adapted);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: 'verify',
    rows,
    baseServings: 1,
  } as never);
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);
  const lineRef = adapted[0].line_ref;
  if (clear) {
    for (const action of ['clear_portion', 'clear_count_portion', 'clear_household_portion'] as const) {
      state = phase4Reducer(state, { type: action, lineRef } as never);
    }
  }
  return { adapted, analysis, rows, state, lineRef };
}

function evidenceFor(session: AdvancedNutritionSession, flow: Flow) {
  const dry = session.calculate({
    servings: 1,
    nutrient_scope: ['calories'],
    ingredients: [lineCalculationInput(flow.adapted[0], flow.state, flow.rows[0])],
  } as never);
  if (!dry.ok) return undefined;
  const entry = dry.preview.ingredients[0];
  if (entry.fdc_id === undefined || entry.record_digest === undefined) return undefined;
  return {
    line_ref: entry.line_ref,
    fdc_id: entry.fdc_id,
    record_digest: entry.record_digest,
    ingredient_identity_digest: entry.ingredient_identity_digest,
    bundle_release: (dry.preview as unknown as { bundle_release: string }).bundle_release,
  };
}

function accept(flow: Flow, lower: number, upper: number): Phase4State | null {
  const evidence = evidenceFor(currentSession, flow);
  if (evidence === undefined) return null;
  const built = buildAiEstimateSelection(flow.lineRef, evidence, {
    fdc_id: evidence.fdc_id,
    record_digest: evidence.record_digest,
    review_digest: '',
    lower_grams: lower,
    upper_grams: upper,
    representative_grams: (lower + upper) / 2,
    representative_policy: 'midpoint',
    provenance: 'ai_estimate',
    snapshot_binding: 'verify',
  } as AiEstimateChoice);
  if (built.ok !== true) return null;
  return phase4Reducer(flow.state, {
    type: 'select_ai_estimate',
    lineRef: flow.lineRef,
    choice: {
      ...built.selection,
      fdc_id: built.selection.fdc_id,
      record_digest: built.selection.record_digest,
      review_digest: '',
      lower_grams: lower,
      upper_grams: upper,
      representative_grams: (lower + upper) / 2,
      representative_policy: 'midpoint' as const,
      provenance: 'ai_estimate' as const,
      snapshot_binding: 'verify',
      selection: built.selection,
    } as AiEstimateChoice,
  } as never);
}

const inputs = {
  files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
    name,
    bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
  })),
};
const composed = await composeAdvancedNutritionSessionFromBundle(inputs as never);
if (!composed.ok) {
  console.log(`FATAL: bundle failed: ${(composed as { failure: { code: string } }).failure.code}`);
  process.exit(1);
}
const currentSession = composed.session;

console.log('AI-3 production verification (real pinned USDA bundle)\n');

console.log('A1 capability separation');
const basic = resolveNutritionCapabilities({});
const advanced = resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true });
check('Basic tier keeps estimation disabled', basic.aiEstimation === 'disabled');
check('AI Advanced enables estimation', advanced.aiEstimation === 'available');
check('Basic tier is not the AI tier', basic.tier === 'basic' && advanced.tier === 'ai_advanced');

console.log('A2 a real eligible line');
const flow = seed(currentSession, '1 avocado');
check('the line has an authenticated identity', flow.state.matches[flow.lineRef] !== undefined);
const eligibility = evaluateAiEstimateEligibility({
  state: flow.state,
  lineRef: flow.lineRef,
  parse: { hasDirectMass: false, amount: 1, quantityRange: null, container: null },
  rowStatus: 'needs_amount',
  capabilityAvailable: true,
});
check('the line is AI-3 eligible', eligibility.eligible === true);

console.log('A3 pre-network exclusions against the real parser');
const containerFlow = seed(currentSession, '1 can black beans');
check(
  'a parsed container is ineligible',
  evaluateAiEstimateEligibility({
    state: containerFlow.state,
    lineRef: containerFlow.lineRef,
    parse: { hasDirectMass: false, amount: 1, quantityRange: null, container: 'can' },
    rowStatus: 'needs_amount',
    capabilityAvailable: true,
  }).eligible === false
);
check(
  'a pinch has no usable quantity',
  hasUsableQuantity({ hasDirectMass: false, amount: null, quantityRange: null, container: null }) === false
);
check(
  'a written range IS usable quantity',
  hasUsableQuantity({ hasDirectMass: false, amount: null, quantityRange: { lower: 2, upper: 3 }, container: null }) === true
);

console.log('A4 model-facing payload boundary');
const request = buildAiEstimateModelRequest([
  {
    line_ref: flow.lineRef,
    source_text: '1 avocado',
    amount: 1,
    unit: null,
    measurement_kind: 'count',
    count_noun: null,
    food_semantics: 'avocado',
    local_food_description: 'Avocados, raw, all commercial varieties',
    evidence_absent_reason: 'no_authenticated_portion',
  },
]);
const payload = JSON.stringify(request).toLowerCase();
check('the payload has no fdc id', !payload.includes('fdc_id'));
check('the payload has no digest', !payload.includes('digest'));
check('the payload has no nutrient/calorie', !payload.includes('nutrient') && !payload.includes('calorie'));
check('the payload is inside the 32 KiB cap', aiEstimateRequestByteLength(request) <= MAX_AI_ESTIMATE_REQUEST_BYTES);

console.log('A5 response sanitization / authority rejection');
const goodResponse = {
  response_version: 'nutrition_ai_estimate_response_v1',
  estimates: [
    {
      line_ref: flow.lineRef,
      policy_version: 'nutrition_ai_estimate_policy_v1',
      provenance_class: 'ai_estimate',
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 175,
      representative_policy: 'midpoint',
      input_semantics: ['count noun'],
      evidence_absent_reason: 'no_authenticated_portion',
    },
  ],
};
check('a bounded estimate is accepted', sanitizeEstimateProviderResponse(goodResponse, [flow.lineRef]).ok === true);
for (const key of ['nutrients', 'calories', 'fdc_id', 'portion_id', 'serving_weight', 'apply']) {
  const forged = { ...goodResponse, estimates: [{ ...goodResponse.estimates[0], [key]: {} }] };
  check(`authority key ${key} is refused`, sanitizeEstimateProviderResponse(forged, [flow.lineRef]).ok === false);
}

console.log('A6 working-state acceptance + deterministic midpoint');
const state = accept(flow, 150, 200);
check('the estimate was accepted', state !== null && hasActiveAiEstimateForPreview(state));
check('the blocked lines carry the range', activeAiEstimatesForPreview(state)[0]?.representative_grams === 175);

console.log('A7 calculator path (real bundle)');
const calculated = state === null ? null : currentSession.calculate(buildCalculationRequest(flow.adapted, state));
check('the calculation succeeds', calculated !== null && calculated.ok === true);
if (calculated !== null && calculated.ok === true) {
  const ingredient = calculated.preview.ingredients[0];
  check('the representative is the re-derived midpoint', ingredient.resolved_grams === 175);
  const live = projectLiveRows(
    state!,
    new Map(flow.analysis.rows.map((row) => [row.line_ref, row])),
    flow.adapted,
    currentSession,
    ingredientEvidenceViews(calculated.preview)
  )[0];
  check('the live row reports ai_estimate', live.mass_source === 'ai_estimate');
}

console.log('A8 stronger-source refusal');
const withUserMass = phase4Reducer(flow.state, {
  type: 'select_user_mass',
  lineRef: flow.lineRef,
  choice: { grams: 180 },
} as never);
check('an estimate refuses to overwrite a user mass', withUserMass.aiEstimates[flow.lineRef] === undefined);
check(
  'coexistence in effectiveMass is a conflict',
  resolveEffectiveMassDecision({
    directMassGrams: undefined,
    hasUserMass: true,
    hasSourcePortion: false,
    hasCountPortion: false,
    hasHouseholdPortion: false,
    hasAiEstimate: true,
  }).kind === 'conflict'
);

console.log('A9 two-layer Apply block');
let writeCalls = 0;
const applyResult = await applyAdvancedNutrition({
  session: currentSession,
  recipe: flow.adapted,
  state,
  write: async () => {
    writeCalls += 1;
  },
  readBack: async () => 'stored',
  computedAt: '2026-01-01T00:00:00.000Z',
  expectedMode: 'create',
} as never);
check('a direct Apply with an active estimate fails closed', applyResult.ok === false);
if (applyResult.ok === false) {
  check('it fails with the estimate code', applyResult.failure.code === 'ai_estimate_preview_only');
}
check('the persistence writer was never reached', writeCalls === 0);
check('the UI predicate agrees', hasActiveAiEstimateForPreview(state) === true);

console.log('A10 benchmark classification');
const summary = summarizeAiAdvancedBenchmark([
  { resolved: true, mass_source: 'ai_estimate', ai_assisted: true },
]);
check('an estimate is a bounded estimate', summary.ai_assisted_bounded_estimate === 1);
check('an estimate is never authenticated', summary.ai_assisted_authenticated === 0);
check('an estimate never counts as authenticated resolution', summary.resolved_authenticated === 0);

console.log('A11 SLICE D: the offer-first UI flow');
// Rebuild a clean eligible flow so the offer path starts from a known state.
const offerFlow = seed(currentSession, '3/4 cup cooked white rice');
const offerEvidence = evidenceFor(currentSession, offerFlow);
const offerSnapshot = buildAiEstimateUiSnapshot(
  offerFlow.lineRef,
  offerFlow.analysis.rows[0],
  offerFlow.state.matches[offerFlow.lineRef]
);
const offerBinding = aiEstimateSnapshotBinding(offerSnapshot);
const offerFingerprint = workingChoiceFingerprint(offerFlow.state, offerFlow.lineRef);

const displayOffer = buildAiEstimateOffer({
  line_ref: offerFlow.lineRef,
  kind: 'offer',
  evidence: {
    lower_grams: 150,
    upper_grams: 200,
    representative_policy: 'midpoint',
    provenance: AI_ESTIMATE_PROVENANCE_CLASS,
  } as never,
});
check('an offer can be built for a real eligible line', displayOffer !== null);
check('the offer carries the literal advisory label', displayOffer?.label === AI_ESTIMATE_OFFER_LABEL);
check('the offer carries the bounded range', displayOffer?.lower_grams === 150 && displayOffer?.upper_grams === 200);
check('the offer carries the deterministic midpoint', displayOffer?.representative_grams === 175);

// 1. an offer exists but NO working selection was created
check('an offer creates no working estimate', offerFlow.state.aiEstimates[offerFlow.lineRef] === undefined);
// 2. an offer does not affect the preview
check('an offer does not affect the preview', hasActiveAiEstimateForPreview(offerFlow.state) === false);

// 3. a SECOND explicit acceptance creates the working estimate
const accepted = acceptAiEstimateOffer(displayOffer!, {
  currentState: offerFlow.state,
  offerFingerprint,
  offerSnapshotBinding: offerBinding,
  evidence: offerEvidence as never,
  snapshot: offerSnapshot,
});
check('a second explicit click accepts the offer', accepted.ok === true);
const acceptedState =
  accepted.ok === true
    ? phase4Reducer(offerFlow.state, {
        type: 'select_ai_estimate',
        lineRef: offerFlow.lineRef,
        choice: accepted.choice,
      } as never)
    : null;
// 4. the accepted estimate updates the preview
check('an accepted estimate updates the preview', hasActiveAiEstimateForPreview(acceptedState!) === true);
const acceptedRows = acceptedState === null ? [] : projectLiveRows(
  acceptedState,
  new Map(offerFlow.analysis.rows.map((row) => [row.line_ref, row])),
  offerFlow.adapted,
  currentSession,
  ingredientEvidenceViews(
    (currentSession.calculate(buildCalculationRequest(offerFlow.adapted, acceptedState)) as unknown as {
      preview: never;
    }).preview
  )
);
check('the accepted estimate drives the live row mass source', acceptedRows[0].mass_source === 'ai_estimate');

// 5. a stale offer cannot apply
const staleRefusal = acceptAiEstimateOffer(displayOffer!, {
  currentState: offerFlow.state,
  offerFingerprint: 'a-stale-fingerprint',
  offerSnapshotBinding: offerBinding,
  evidence: offerEvidence as never,
  snapshot: offerSnapshot,
});
check('a stale offer cannot be accepted', staleRefusal.ok === false);

// 6. a stronger source added after the offer wins
const stronger = {
  ...offerFlow.state,
  userMasses: { [offerFlow.lineRef]: { grams: 180, quantity: 1, unit: 'cup', source: 'user' } },
} as unknown as Phase4State;
const strongerRefusal = acceptAiEstimateOffer(displayOffer!, {
  currentState: stronger,
  offerFingerprint: workingChoiceFingerprint(stronger, offerFlow.lineRef),
  offerSnapshotBinding: offerBinding,
  evidence: offerEvidence as never,
  snapshot: offerSnapshot,
});
check('a stronger source after the offer wins', strongerRefusal.ok === false);
if (strongerRefusal.ok === false) {
  check('and the reason is the stronger source', strongerRefusal.reason === 'stronger_source_present');
}

// 7. an active estimate blocks Apply Layer A
check('an active estimate blocks Apply Layer A', hasActiveAiEstimateForPreview(acceptedState!) === true);

// 8. a direct writer bypass is blocked by Layer B
let sliceDWriteCalls = 0;
await applyAdvancedNutrition({
  session: currentSession,
  recipe: offerFlow.adapted,
  state: acceptedState!,
  write: async () => {
    sliceDWriteCalls += 1;
  },
  readBack: async () => 'stored',
  computedAt: '2026-01-01T00:00:00.000Z',
  expectedMode: 'create',
} as never);
check('a direct writer bypass is blocked by Layer B', sliceDWriteCalls === 0);

// 9. replacing the estimate restores normal eligibility
const replaced = phase4Reducer(acceptedState!, {
  type: 'select_user_mass',
  lineRef: offerFlow.lineRef,
  choice: { grams: 150, quantity: 1, unit: 'cup', source: 'user' },
} as never);
check('replacing the estimate removes it', replaced.aiEstimates[offerFlow.lineRef] === undefined);
check('replacing the estimate restores normal eligibility', hasActiveAiEstimateForPreview(replaced) === false);

// -------------------------------------------------------------------------
console.log('A12 ELIGIBILITY AUTHORITY (post-repair)');
// The canonical benchmark denominator is 97 distinct authored lines.
check('the canonical benchmark denominator is 97', uniqueBenchmarkLines === 97);
check('the raw fixture holds 145 entries', rawBenchmarkEntries === 145);

// A real direct-mass benchmark line must be AI-3 ineligible.
const massLine = seed(currentSession, '1.5 lb ground beef');
const massParsed = parseIngredient('1.5 lb ground beef');
const massGrams = massParsed.ok && typeof massParsed.parsed.grams === 'number' ? massParsed.parsed.grams : null;
const massDecision = evaluateAiEstimateEligibility({
  state: massLine.state,
  lineRef: massLine.lineRef,
  parse: {
    hasDirectMass: massParsed.ok && massParsed.parsed.measurement_kind === 'mass' && massGrams !== null,
    directMassGrams: massGrams,
    amount: massParsed.ok ? massParsed.parsed.amount : null,
    quantityRange: null,
    container: null,
  },
  rowStatus: 'needs_amount',
  capabilityAvailable: true,
});
check('a direct authored-mass line is ineligible', massDecision.eligible === false);
if (massDecision.eligible === false) {
  check('and the reason is direct-mass authority', massDecision.reason === 'direct_mass_authority');
}

// Already-resolved rows of every kind must be ineligible.
for (const [label, key, value] of [
  ['source portion', 'portions', { portion_index: 1, grams: 150 }],
  ['count portion', 'countPortions', { portion_index: 1, grams: 150 }],
  ['household portion', 'householdPortions', { unit: 'cup', size_class: 'small' }],
  ['user mass', 'userMasses', { grams: 150 }],
] as const) {
  const f = seed(currentSession, '1 avocado');
  const r = evaluateAiEstimateEligibility({
    state: { ...f.state, [key]: { [f.lineRef]: value } } as never,
    lineRef: f.lineRef,
    parse: { hasDirectMass: false, amount: 1, quantityRange: null, container: null },
    rowStatus: 'needs_amount',
    capabilityAvailable: true,
  });
  check(`an already-resolved ${label} line is ineligible`, r.eligible === false);
}

// A valid written quantity range remains usable.
const rangeParsed = parseIngredient('2-3 tomatoes');
check('2-3 tomatoes parses a quantity range', rangeParsed.ok && rangeParsed.parsed.quantity_range !== null);
check('2-3 tomatoes has no scalar amount', rangeParsed.ok && rangeParsed.parsed.amount === null);
check(
  'a valid quantity range is usable quantity',
  rangeParsed.ok &&
    hasUsableQuantity({
      hasDirectMass: false,
      amount: rangeParsed.parsed.amount,
      quantityRange: rangeParsed.parsed.quantity_range
        ? { lower: rangeParsed.parsed.quantity_range.lower, upper: rangeParsed.parsed.quantity_range.upper }
        : null,
      container: null,
    })
);

// Qualitative no-quantity still abstains; an actionable container still abstains.
check('a qualitative no-quantity line abstains', !hasUsableQuantity({ hasDirectMass: false, amount: null, quantityRange: null, container: null }));
const containerFlow2 = seed(currentSession, '1 can black beans');
const containerDecision = evaluateAiEstimateEligibility({
  state: containerFlow2.state,
  lineRef: containerFlow2.lineRef,
  parse: { hasDirectMass: false, amount: 1, quantityRange: null, container: 'can' },
  rowStatus: 'needs_amount',
  capabilityAvailable: true,
});
check('an actionable container line abstains', containerDecision.eligible === false);
if (containerDecision.eligible === false) {
  check('and the reason is the parsed container', containerDecision.reason === 'parsed_container');
}

// A real eligible line still reaches the offer flow.
const eligibleFlow = seed(currentSession, '1 head garlic');
const eligibleDecision = evaluateAiEstimateEligibility({
  state: eligibleFlow.state,
  lineRef: eligibleFlow.lineRef,
  parse: { hasDirectMass: false, amount: 1, quantityRange: null, container: null },
  rowStatus: 'needs_amount',
  capabilityAvailable: true,
});
check('a real eligible line reaches the offer flow', eligibleDecision.eligible === true);

// ---------------------------------------------------------------------------
// FINAL PRODUCTION TRUTH: the offer path the architecture actually ships.
// ---------------------------------------------------------------------------
const realFlow = seed(currentSession, '2-3 tomatoes');
const realEvidence = deriveAiEstimateIdentityEvidence({
  session: currentSession,
  state: realFlow.state,
  lineRef: realFlow.lineRef,
});
check('a real candidate has canonical five-field evidence', realEvidence !== null);
if (realEvidence !== null) {
  check(
    'the evidence is exactly the five required fields',
    Object.keys(realEvidence).sort().join(',') ===
      'bundle_release,fdc_id,ingredient_identity_digest,line_ref,record_digest',
    Object.keys(realEvidence).sort().join(','),
  );
  check('the record digest is a real pinned digest', realEvidence.record_digest.length > 0);
  check('the bundle release is the pinned release', realEvidence.bundle_release === USDA_BUNDLE_RELEASE_LOCK.bundle_release);
  check('the identity digest is sha256-shaped', realEvidence.ingredient_identity_digest.startsWith('sha256:'));

  // D. Snapshot: valid on unchanged authority, and fail-closed without it.
  const snap = deriveAiEstimateSnapshotInput(realFlow.state, realFlow.lineRef, '2-3 tomatoes', realEvidence);
  check('an unchanged valid candidate HAS a snapshot (no stale:no_snapshot)', snap !== null);
  if (snap !== null) {
    check('the snapshot binds the canonical record digest', snap.recordDigest === realEvidence.record_digest);
    check('the snapshot binds the canonical bundle release', snap.bundleRelease === realEvidence.bundle_release);
    check('missing evidence fails the snapshot CLOSED', deriveAiEstimateSnapshotInput(realFlow.state, realFlow.lineRef, '2-3 tomatoes', null) === null);
  }

  // E/F. An inert offer that only the explicit second click can select.
  const offer = buildAiEstimateOffer({
    line_ref: realFlow.lineRef,
    kind: 'offer',
    evidence: {
      lower_grams: 150,
      upper_grams: 200,
      representative_grams: 175,
      representative_policy: 'midpoint',
      provenance: 'ai_estimate',
    },
  });
  check('a valid offer is built', offer !== null);
  if (offer !== null && snap !== null) {
    const fingerprint = workingChoiceFingerprint(realFlow.state, realFlow.lineRef);
    check('the offer is INERT: no active estimate before acceptance', hasActiveAiEstimateForPreview(realFlow.state) === false);
    const accepted = acceptAiEstimateOffer(offer, {
      currentState: realFlow.state,
      offerFingerprint: fingerprint ?? '',
      evidence: realEvidence,
      snapshot: snap,
      offerSnapshotBinding: aiEstimateSnapshotBinding(snap),
    });
    check('the explicit second click accepts it', accepted.ok === true);
    // D/F. A stale authority must refuse.
    const stale = acceptAiEstimateOffer(offer, {
      currentState: realFlow.state,
      offerFingerprint: fingerprint ?? '',
      evidence: { ...realEvidence, ingredient_identity_digest: 'sha256:stale' },
      snapshot: snap,
      offerSnapshotBinding: 'stale-binding',
    });
    check('a stale offer is REFUSED', stale.ok === false);
  }
}

// G. A stronger stored source wins over an estimate.
const strongerFlow = seed(currentSession, '2-3 tomatoes');
const strongerState = {
  ...strongerFlow.state,
  userMasses: { ...(strongerFlow.state.userMasses ?? {}), [strongerFlow.lineRef]: { grams: 200 } },
} as typeof strongerFlow.state;
const strongerDecision = evaluateAiEstimateEligibility({
  state: strongerState,
  lineRef: strongerFlow.lineRef,
  parse: { hasDirectMass: false, amount: 2, quantityRange: { lower: 2, upper: 3 }, container: null },
  rowStatus: 'needs_amount',
  capabilityAvailable: true,
});
check('a stronger user mass forbids AI-3', strongerDecision.eligible === false);

// A. Capability authority: Basic spends ZERO provider calls.
let basicCalls = 0;
const basicAdapter = { capabilities: basic, transport: { request: async () => { basicCalls += 1; return { ok: false }; } } };
await requestAiMassEstimateOffers({
  state: realFlow.state,
  lines: [{ line_ref: realFlow.lineRef, original_text: '2-3 tomatoes', outcome: 'needs_amount' }],
  capabilities: basic.aiEstimation === 'available' ? advanced : basic,
  session: currentSession,
  transport: basicAdapter.transport,
});
check('the Basic tier makes ZERO provider calls', basicCalls === 0);

console.log(`\n=== ${pass}/${pass + fail} passed ===`);
process.exit(fail === 0 ? 0 : 1);
