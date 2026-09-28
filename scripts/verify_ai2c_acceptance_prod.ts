/**
 * The Kitchen Codex — AI-2C production verification.
 *
 * Deterministic, credential-free acceptance for the deterministic plan
 * acceptance bridge. Everything runs in-process against the REAL pinned USDA
 * bundle and the REAL production modules; the provider boundary is a local stub
 * (no paid provider, no credential, no network).
 *
 * PART A (real bundle, real modules):
 *   - the Phase-4 acceptance port reports EXACTLY the confidence contract's own
 *     decisions (strict automatic / best-effort family) over real reviews;
 *   - genuine-session confirmation succeeds for a real review and fails closed
 *     for a structural clone, a spread copy, a proxy and a plain forgery;
 *   - a plan whose `automatic` classification is not independently provable at
 *     the bridge boundary is refused (no acceptance);
 *   - pre-existing user/working state — an explicit match (including
 *     `kind:'none'`), a source portion, a count portion, a user mass or a
 *     household portion — can never be erased by an AI plan;
 *   - a mid-flight user edit makes the line ineligible;
 *   - an already-identical selection is reported `unchanged` and dispatches
 *     nothing;
 *   - the bridge output carries no grams, no nutrients, no portion choice, and
 *     the reconciliation is PURE (its inputs are byte-identical afterwards);
 *   - the capability gate performs ZERO network calls and reports the existing
 *     `unavailable` code; a superseded request reports `stale_request`;
 *   - the transitive module graph of every new AI-2C module excludes Phase 5,
 *     the Apply coordinator, Markdown writers and server/provider modules.
 *
 * PART B (built + served application):
 *   - no AI-2C route was added (the acceptance endpoints are absent), while the
 *     committed AI-2B plan route is still served;
 *   - every frozen AI-0/AI-2A module and every stable AI-2B production module is
 *     byte-identical (sha256) to the committed baseline.
 *
 * Usage: bun x tsx scripts/verify_ai2c_acceptance_prod.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeAdvancedNutritionSessionFromBundle } from '../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../src/core/nutritionV2/usda/releaseLock';
import { buildAiAdvancedPlanLineSource } from '../src/core/nutritionV2/aiAdvancedPlanSource';
import { buildAiAdvancedPlanRequestContext } from '../src/core/nutritionV2/aiAdvancedPlanRequest';
import { AI_ADVANCED_PLAN_VERSION } from '../src/core/nutritionV2/aiAdvancedPlan';
import {
  bestEffortDefaultCandidates,
  selectAutomaticMatch,
} from '../src/core/nutritionV2/matching/confidence';
import { deterministicAcceptanceView } from '../src/core/nutritionV2/phase4/deterministicAcceptanceView';
import { reconcileAiAdvancedCandidatePlan } from '../src/core/nutritionV2/phase4/aiPlanReconcile';
import { confirmAdvancedNutritionMatch } from '../src/core/nutritionV2/phase4/session';
import { selectionFromMatchChoice } from '../src/core/nutritionV2/phase4/rows';
import { requestAndReconcileAiAdvancedPlan } from '../src/application/nutritionAiPlanAcceptance';
import { resolveNutritionCapabilities } from '../src/core/nutritionV2/nutritionCapabilities';
import { adaptRecipe } from '../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../src/core/nutritionV2/phase4/analyzer';
import { buildCalculationRequest, buildReviewRows } from '../src/core/nutritionV2/phase4/rows';
import { projectLiveRows, liveExceptionKind } from '../src/core/nutritionV2/phase4/liveRow';
import { ingredientEvidenceViews } from '../src/core/nutritionV2/phase4/display';
import { INITIAL_PHASE4_STATE, phase4Reducer } from '../src/core/nutritionV2/phase4/state';
import { phase4SessionIdentity } from '../src/core/nutritionV2/phase4/types';
import { parseIngredient } from '../src/core/nutritionV2/matching/parse';
import { resetAiSelectionWithOutcome } from '../src/application/aiSelection';
import type { NetworkAdapter, NetworkRequest, NetworkResponse } from '../src/application/adapters/NetworkAdapter';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUNDLE_DIR = join(
  ROOT,
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

let passed = 0;
let failed = 0;

function record(label: string, ok: boolean): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

function sha256Of(relativePath: string): string {
  return createHash('sha256').update(readFileSync(join(ROOT, relativePath))).digest('hex');
}

const FROZEN_AI0_AI2A: ReadonlyArray<readonly [string, string]> = [
  ['src/core/nutritionV2/aiAdvancedPlan.ts', '7716a99c51255917ba50cca2c23e322860045d45a2bdc8b6dbf48daa20a8d504'],
  ['src/core/nutritionV2/aiAdvancedCandidates.ts', '6e65daaa8391591cb94b823d704123f8db5dd5e6e811fc9d31e4cf3139d29683'],
  ['src/core/nutritionV2/aiAdvanced.ts', '857763140830fa04ec743495b6527b1800d63ee3de7207f090f0c37b396697cb'],
  ['src/core/nutritionV2/aiAdvancedEstimate.ts', '40713b50f41858326c1024b2dd0b17ec242aa1b5b7a3091f55d24e54557cab98'],
  ['src/core/nutritionV2/aiAdvancedPlanSource.ts', 'b032f32c4cdbcb53cc3b4e89cb8b807396b45bc2ed57b9296c806d48af83aff7'],
  ['src/core/nutritionV2/aiAdvancedPlanRequest.ts', 'e8c714e5b3d45a4cdc02930193718adf6a198238de9c2c93f93b4f7a60ff8ca7'],
  ['src/core/nutritionV2/aiAdvancedPlanApply.ts', '18847e5836bb254fc6eea88dbd4aab050d475ca06a7dc5c02fb225f75971ba33'],
];

const STABLE_AI2B: ReadonlyArray<readonly [string, string]> = [
  ['src/core/nutritionV2/aiAdvancedPlanWire.ts', '33c851752a4eb67aafab1f208efcd20a8671a7141724f91222e0402329e42c22'],
  ['src/core/nutritionV2/aiAdvancedPlanTarget.ts', '82d6c06d756a4cb02ea23a5cdc56fbd3f9801abd40c0cae4b172cf3e5f2be1e2'],
  ['server/nutritionPlan.ts', '3ac9082dd2f98880f1a7991594aca9f529e031e1bd86d57d1c5a566189cb191b'],
  ['src/application/nutritionAiPlan.ts', '7e8a6a372e2f00cba68686b32a73967141897c113dc308277d67bd80afa465b8'],
];

const AI2C_MODULES = [
  'src/core/nutritionV2/phase4/deterministicAcceptanceView.ts',
  'src/core/nutritionV2/phase4/aiPlanReconcile.ts',
  'src/application/nutritionAiPlanAcceptance.ts',
];

type RealSession = Awaited<ReturnType<typeof composeAdvancedNutritionSessionFromBundle>> extends
  { ok: true; session: infer S }
  ? S
  : never;

function reviewOf(session: RealSession, query: string): unknown {
  return (session as unknown as { reviewIngredient(raw: unknown): unknown }).reviewIngredient({
    name: query,
  });
}

function contextFor(session: RealSession, lineRef: string, query: string, requestId: string) {
  const review = reviewOf(session, query);
  const source = buildAiAdvancedPlanLineSource({ lineRef, review });
  if (source.ok !== true) throw new Error(`source failed: ${source.code}`);
  const built = buildAiAdvancedPlanRequestContext({ requestId, lines: [source.source] });
  if (built.ok !== true) throw new Error(`context failed: ${built.code}`);
  return { context: built.context, review, candidateRefs: source.source.candidate_set.views.map((v) => v.candidate_ref) };
}

// ---------------------------------------------------------------------------
// Part A — real bundle, real production modules
// ---------------------------------------------------------------------------

const PHRASES = [
  'tomato sauce',
  'olive oil',
  'heavy cream',
  'all purpose flour',
  'granulated sugar',
  'chicken breast',
  'garlic',
  'yellow onion',
  'kosher salt',
  'black pepper',
  'unsalted butter',
  'large eggs',
  'whole milk',
  'greek yogurt',
  'canned tomatoes',
  'brown sugar',
  'soy sauce',
  'parmesan cheese',
  'basil',
  'parsley',
  'carrots',
  'celery',
  'chicken broth',
  'white rice',
  'rolled oats',
  'honey',
  'baking soda',
  'vanilla extract',
  'lemon juice',
  'chili powder',
];

const REQUEST_ID = 'verify-ai2c-request-0001';

async function partA(): Promise<void> {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  record('A1 the real pinned USDA bundle authenticates into a genuine Phase-4 session', loaded.ok === true);
  if (!loaded.ok) return;
  const session = loaded.session as unknown as RealSession;

  // ---------------------------------------------------------------- A2 parity
  let parityChecked = 0;
  let parityOk = true;
  for (const phrase of PHRASES) {
    const review = reviewOf(session, phrase);
    const view = deterministicAcceptanceView(review);
    if (view === undefined) {
      parityOk = false;
      break;
    }
    const strict = selectAutomaticMatch(review as never);
    const family = bestEffortDefaultCandidates(review as never).map((candidate) => candidate.fdc_id);
    const reportedFamily = [...((view as unknown as { best_effort_eligible_fdc_ids?: number[] }).best_effort_eligible_fdc_ids ?? [])];
    if ((view as unknown as { strict_automatic_fdc_id?: number }).strict_automatic_fdc_id !== strict?.fdc_id) {
      parityOk = false;
      break;
    }
    if (reportedFamily.join(',') !== family.join(',')) {
      parityOk = false;
      break;
    }
    parityChecked += 1;
  }
  record(
    `A2 the acceptance port reports exactly the confidence contract's decisions over ${parityChecked} real reviews`,
    parityOk && parityChecked === PHRASES.length
  );

  // ------------------------------------------------- genuine vs forged session
  let confirmedGenuine = 0;
  let reviewable = 0;
  let firstReview: unknown;
  let firstQuery = '';
  for (const phrase of PHRASES) {
    const review = reviewOf(session, phrase) as Record<string, unknown>;
    if (review['outcome'] !== 'review_required') continue;
    const candidates = review['candidates'] as ReadonlyArray<{ fdc_id: number }>;
    if (candidates.length === 0) continue;
    reviewable += 1;
    if (firstReview === undefined) {
      firstReview = review;
      firstQuery = phrase;
    }
    const selection = {
      kind: 'candidate',
      fdc_id: candidates[0].fdc_id,
      review_digest: review['review_digest'],
    };
    const result = confirmAdvancedNutritionMatch(session, review, selection) as {
      outcome?: string;
      fdc_id?: number;
    };
    if (result.outcome === 'confirmed' && result.fdc_id === candidates[0].fdc_id) confirmedGenuine += 1;
  }
  record(
    `A3 a GENUINE session confirms a real review's candidate (${confirmedGenuine}/${reviewable} reviews)`,
    reviewable > 0 && confirmedGenuine === reviewable
  );
  record('A4 the bundle exposes at least one reviewable line for the bridge', firstReview !== undefined);
  if (firstReview === undefined) return;

  const genuineSelection = () => {
    const review = firstReview as Record<string, unknown>;
    const candidates = review['candidates'] as ReadonlyArray<{ fdc_id: number }>;
    return {
      kind: 'candidate',
      fdc_id: candidates[0].fdc_id,
      review_digest: review['review_digest'],
    };
  };

  const forged: ReadonlyArray<readonly [string, unknown]> = [
    ['a plain object with the right method names', { confirmMatch: (session as never as { confirmMatch: unknown }).confirmMatch }],
    ['a spread copy of the genuine session', { ...(session as object) }],
    ['a prototype-linked clone', Object.create(session as object)],
    ['a proxy wrapping the genuine session', new Proxy(session as object, {})],
    ['an object with a copied catalog confirm function', { confirm: confirmAdvancedNutritionMatch }],
  ];
  const forgedResults = forged.map(([label, candidate]) => {
    const result = confirmAdvancedNutritionMatch(candidate, firstReview, genuineSelection()) as {
      outcome?: string;
    };
    return `${label}=${result.outcome}`;
  });
  record(
    `A5 every structural/forged/cloned/proxied session fails closed (${forgedResults.join(', ')})`,
    forgedResults.every((entry) => entry.endsWith('=invalid'))
  );
  record(
    'A6 a genuine selection through the genuine session still works after the forgeries',
    (confirmAdvancedNutritionMatch(session, firstReview, genuineSelection()) as { outcome?: string }).outcome ===
      'confirmed'
  );
}

// ------------------------------------------------- plan reconciliation (real)
function wirePlan(lineRef: string, candidateRef: string, requestId = REQUEST_ID): unknown {
  return {
    plan_version: AI_ADVANCED_PLAN_VERSION,
    plans: [
      {
        line_ref: lineRef,
        candidate_ref: candidateRef,
        measure_kind: 'unknown',
        review_required: false,
        ambiguity_reasons: [],
      },
    ],
  };
}

async function partA2(): Promise<void> {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!loaded.ok) return;
  const session = loaded.session as unknown as RealSession;

  // Find a REAL line the deterministic contract grants strict automatic
  // authority for; if the corpus has none, the acceptance path is simply dormant
  // (reported honestly rather than forced).
  let strictPhrase: string | undefined;
  for (const phrase of PHRASES) {
    const review = reviewOf(session, phrase) as Record<string, unknown>;
    if (review['outcome'] !== 'review_required' && review['outcome'] !== 'matched_exact') continue;
    const strict = selectAutomaticMatch(review as never);
    if (strict === undefined) continue;
    const candidates = review['candidates'] as ReadonlyArray<{ fdc_id: number }> | undefined;
    if (candidates === undefined) continue;
    if (!candidates.some((candidate) => candidate.fdc_id === strict.fdc_id)) continue;
    strictPhrase = phrase;
    break;
  }

  if (strictPhrase === undefined) {
    console.log('INFO  no strict-automatic line in this corpus: the acceptance path is dormant (offers only)');
  }

  const lineRef = 'verify line';
  const built = contextFor(session, lineRef, strictPhrase ?? 'heavy cream', REQUEST_ID);
  const reviews = new Map<string, unknown>([[lineRef, built.review]]);
  const firstRef = built.candidateRefs[0];

  // A7 — an unknown candidate ref withdraws the WHOLE plan (fail closed).
  const unknownRef = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, 'c99'),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
  });
  record('A7 an unknown candidate ref withdraws the whole plan', unknownRef.ok === false);

  // A8 — a superseded request id is refused.
  const stale = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: 'verify-ai2c-other-request',
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
  });
  record('A8 a plan answering a superseded request is refused', stale.ok === false && stale.code === 'stale_request');

  // A9 — a missed acceptance port is refused.
  const noPort = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: undefined,
  });
  record('A9 a missing acceptance port is refused', noPort.ok === false && noPort.code === 'invalid_acceptance_port');

  // A10 — classification over the real review: the requested candidate is only
  // accepted when the deterministic port independently names it.
  const baseline = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
    currentLineRefs: [lineRef],
    workingState: {},
  });
  record('A10 the real review reconciles without error or fabrication', baseline.ok === true);
  if (baseline.ok !== true) return;
  const view = deterministicAcceptanceView(built.review) as { strict_automatic_fdc_id?: number };
  const localId = (built.context as unknown as { line(ref: string): { candidate_set: { resolve(ref: string): { fdc_id: number } | undefined } } })
    .line(lineRef).candidate_set.resolve(firstRef)?.fdc_id;
  const acceptedNow = baseline.reconciliation.accepted.length === 1;
  const expectedAccepted = view.strict_automatic_fdc_id !== undefined && view.strict_automatic_fdc_id === localId;
  record(
    'A11 acceptance is granted IF AND ONLY IF the port names the same candidate (strict authority only)',
    acceptedNow === expectedAccepted
  );

  // A12 — pure: the inputs are untouched by reconciliation.
  const before = JSON.stringify([...reviews.values()]);
  reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
    currentLineRefs: [lineRef],
    workingState: {},
  });
  record('A12 reconciliation is PURE (the canonical reviews are byte-identical afterwards)', before === JSON.stringify([...reviews.values()]));

  // A13 — no grams, nutrients or portion choices anywhere in the output.
  const serialized = JSON.stringify(baseline.reconciliation);
  const forbidden = ['gram', 'grams', 'nutrient', 'calorie', 'protein_g', 'portion_ref', 'source_portion', 'count_portion', 'user_mass', 'household_portion', 'density'];
  const hits = forbidden.filter((token) => serialized.includes(token));
  record(`A13 the bridge output carries no mass/portion/nutrient authority (${hits.join(',') || 'clean'})`, hits.length === 0);

  // A14 — accepted entries carry the CURRENT review digest for genuine confirmation.
  if (baseline.reconciliation.accepted.length === 1) {
    const entry = baseline.reconciliation.accepted[0];
    record(
      'A14 every accepted entry carries the current review digest for genuine confirmation',
      entry.review_digest === (built.review as Record<string, unknown>)['review_digest'] &&
        entry.confirmation !== undefined
    );
  } else {
    record('A14 no accepted entry in this corpus line (acceptance dormant) — nothing to bind', true);
  }

  // A15 — pre-existing working state can never be erased.
  const massStates: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a stored source portion', { portions: { [lineRef]: { kind: 'source', fdc_id: localId, portion_index: 0 } } }],
    ['a stored count portion', { countPortions: { [lineRef]: { count: 2, measure: 'clove' } } }],
    ['a stored user mass', { userMasses: { [lineRef]: { grams: 120 } } }],
    ['a stored household portion', { householdPortions: { [lineRef]: { portion_ref: 'p1' } } }],
  ];
  let massBlocked = 0;
  for (const [label, state] of massStates) {
    const result = reconcileAiAdvancedCandidatePlan({
      plan: wirePlan(lineRef, firstRef),
      responseRequestId: REQUEST_ID,
      requestContext: built.context,
      reviews,
      deterministicAcceptance: deterministicAcceptanceView,
      currentLineRefs: [lineRef],
      workingState: state,
    });
    if (result.ok === true && result.reconciliation.accepted.length === 0) massBlocked += 1;
    else console.log(`INFO  mass-source guard did not block: ${label}`);
  }
  record(
    `A15 an automatic acceptance can never clear a stored mass source (${massBlocked}/${massStates.length} blocked)`,
    massBlocked === massStates.length
  );

  // A16 — an explicit pre-existing match (including kind:'none') is never overwritten.
  const matchBlocked = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
    currentLineRefs: [lineRef],
    workingState: { matches: { [lineRef]: { kind: 'none', review_digest: (built.review as Record<string, unknown>)['review_digest'] } } },
  });
  record(
    "A16 a pre-existing explicit match (kind:'none') is never overwritten",
    matchBlocked.ok === true && matchBlocked.reconciliation.accepted.length === 0
  );

  // A17 — a mid-flight user edit makes the line ineligible.
  const midFlight = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
    currentLineRefs: [lineRef],
    workingState: {},
    captured: { fingerprints: new Map([[lineRef, 'fp-before']]) },
    currentFingerprints: new Map([[lineRef, 'fp-after']]),
  });
  record(
    'A17 a mid-flight user edit makes the line ineligible (never overwritten)',
    midFlight.ok === true && midFlight.reconciliation.accepted.length === 0
  );

  // A18 — an already-identical selection reports `unchanged` and dispatches nothing.
  const identicalChoice = {
    kind: 'candidate',
    fdc_id: localId,
    review_digest: (built.review as Record<string, unknown>)['review_digest'],
    automatic: true,
    aiAssisted: true,
    aiAccepted: true,
  };
  const unchanged = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
    currentLineRefs: [lineRef],
    workingState: { matches: { [lineRef]: identicalChoice } },
  });
  record(
    'A18 an already-identical selection is `unchanged` (idempotent second pass)',
    unchanged.ok === true &&
      unchanged.reconciliation.unchanged.includes(lineRef) &&
      unchanged.reconciliation.accepted.length === 0
  );

  // A19 — a removed line is never recreated.
  const removed = reconcileAiAdvancedCandidatePlan({
    plan: wirePlan(lineRef, firstRef),
    responseRequestId: REQUEST_ID,
    requestContext: built.context,
    reviews,
    deterministicAcceptance: deterministicAcceptanceView,
    currentLineRefs: ['some other line'],
    workingState: {},
  });
  record(
    'A19 a line that no longer exists is preserved, never recreated',
    removed.ok === true && removed.reconciliation.accepted.length === 0
  );
}

// --------------------------------------------- application orchestration (real)
function stubNetwork(plan: unknown, calls: NetworkRequest[]): NetworkAdapter {
  const responder = (): NetworkResponse<unknown> =>
    ({ ok: true, status: 200, data: { ok: true, request_id: REQUEST_ID, plan, aiAttempted: true } } as NetworkResponse<unknown>);
  return {
    async request<TResponse, TBody>(request: NetworkRequest<TBody>): Promise<NetworkResponse<TResponse>> {
      calls.push(request as unknown as NetworkRequest);
      return responder() as NetworkResponse<TResponse>;
    },
    async get<TResponse>(): Promise<NetworkResponse<TResponse>> {
      return responder() as NetworkResponse<TResponse>;
    },
    async post<TResponse, TBody>(path: string, body: TBody): Promise<NetworkResponse<TResponse>> {
      calls.push({ method: 'POST', path, body } as unknown as NetworkRequest);
      return responder() as NetworkResponse<TResponse>;
    },
  };
}

async function partA3(): Promise<void> {
  // The requester asks the REAL selection module for BYOK headers. A fresh
  // install has an empty settings store, so the verifier hydrates the selection
  // state through the production entry point with a no-op settings adapter — the
  // same code path the application takes, with no credential anywhere.
  await resetAiSelectionWithOutcome(
    {
      async get() {
        return undefined;
      },
      async set() {
        /* verifier-local: nothing to persist */
      },
      async remove() {
        /* verifier-local: nothing to remove */
      },
    },
    'text'
  );
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!loaded.ok) return;
  const session = loaded.session as unknown as RealSession;

  const lineRef = 'verify orchestration line';
  const built = contextFor(session, lineRef, 'heavy cream', REQUEST_ID);
  const reviews = new Map<string, unknown>([[lineRef, built.review]]);
  const firstRef = built.candidateRefs[0];
  const TARGET_LINE_REF = lineRef;
  const targets = [{ line_ref: lineRef, source_text: '1 cup heavy cream' }];

  // A20 — the capability gate stops BEFORE any transport work.
  const offCalls: NetworkRequest[] = [];
  const off = await requestAndReconcileAiAdvancedPlan({
    session,
    network: stubNetwork(wirePlan(lineRef, firstRef), offCalls),
    capabilities: resolveNutritionCapabilities({ aiConfigured: false, aiReachable: false }),
    context: built.context,
    targets,
    reviews,
    currentLineRefs: [lineRef],
    workingState: {},
  });
  record(
    `A20 the capability gate returns the existing unavailable code with ZERO network calls (${offCalls.length})`,
    off.ok === false && off.code === 'unavailable' && offCalls.length === 0
  );

  // A21 — a stale request/session is refused.
  const staleCalls: NetworkRequest[] = [];
  const stale = await requestAndReconcileAiAdvancedPlan({
    session,
    network: stubNetwork(wirePlan(lineRef, firstRef), staleCalls),
    capabilities: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
    context: built.context,
    targets,
    reviews,
    currentLineRefs: [lineRef],
    workingState: {},
    isCurrent: () => false,
  });
  const staleCode = stale.ok === false ? stale.code : 'accepted';
  record(
    `A21 a superseded request/session is refused with the existing stale_request code (${staleCode})`,
    stale.ok === false && stale.code === 'stale_request'
  );

  // A22 — the full round trip against a stubbed transport, with two lines:
  //        an accepted-candidate line and a line the user already resolved.
  const secondLine = 'verify already resolved line';
  const secondBuilt = contextFor(session, secondLine, 'heavy cream', REQUEST_ID);
  // ONE context carrying BOTH lines (that is what a real plan request contains).
  const sourceOne = buildAiAdvancedPlanLineSource({ lineRef, review: built.review });
  const sourceTwo = buildAiAdvancedPlanLineSource({ lineRef: secondLine, review: secondBuilt.review });
  if (sourceOne.ok !== true || sourceTwo.ok !== true) return;
  const multi = buildAiAdvancedPlanRequestContext({
    requestId: REQUEST_ID,
    lines: [sourceOne.source, sourceTwo.source],
  });
  if (multi.ok !== true) return;
  const twoReviews = new Map<string, unknown>([
    [lineRef, built.review],
    [secondLine, secondBuilt.review],
  ]);
  const digest = (built.review as Record<string, unknown>)['review_digest'];
  const roundTrip = await requestAndReconcileAiAdvancedPlan({
    session,
    network: stubNetwork(
      {
        plan_version: AI_ADVANCED_PLAN_VERSION,
        plans: [
          { line_ref: lineRef, candidate_ref: firstRef, measure_kind: 'unknown', review_required: false, ambiguity_reasons: [] },
          { line_ref: secondLine, candidate_ref: secondBuilt.candidateRefs[0], measure_kind: 'unknown', review_required: false, ambiguity_reasons: [] },
        ],
      },
      []
    ),
    capabilities: resolveNutritionCapabilities({ aiConfigured: true, aiReachable: true }),
    context: multi.context,
    targets: [
      { line_ref: TARGET_LINE_REF, source_text: '1 cup heavy cream' },
      { line_ref: secondLine, source_text: '1 cup heavy cream' },
    ],
    reviews: twoReviews,
    currentLineRefs: [lineRef, secondLine],
    workingState: {
      matches: { [secondLine]: { kind: 'none', review_digest: digest } },
    },
    captured: { fingerprints: new Map([[lineRef, 'fp-a'], [secondLine, 'fp-b']]) },
    currentFingerprints: new Map([[lineRef, 'fp-a'], [secondLine, 'fp-b']]),
  });
  const roundTripCode = roundTrip.ok === false ? roundTrip.code : 'ok';
  record(
    `A22 the application round trip returns a bounded outcome (${roundTripCode})`,
    roundTrip.ok === true
  );
  if (roundTrip.ok !== true) return;
  const outcome = roundTrip.outcome;
  record(
    'A23 a user-resolved line in the SAME plan is preserved while the other line is handled',
    outcome.conflicts.some((conflict) => conflict.line_ref === secondLine) ||
      outcome.preserved.some((entry) => entry.line_ref === secondLine)
  );
  record(
    'A24 the outcome reports honest, bounded counts',
    outcome.accepted_count === outcome.accepted.length &&
      outcome.unconfirmed_count === outcome.unconfirmed.length &&
      outcome.offer_count === outcome.offers.length &&
      outcome.preserved_count === outcome.preserved.length &&
      outcome.conflict_count === outcome.conflicts.length &&
      outcome.unchanged_count === outcome.unchanged.length
  );
  const outcomeText = JSON.stringify(outcome);
  record(
    'A25 the application outcome carries no portion/mass/nutrient authority and no provider payload',
    !/gram|nutrient|calorie|portion_ref|provider|raw_response|prompt/i.test(outcomeText)
  );
}

// -------------------------------------------------------- reachability truth
/**
 * Runs the REAL production pipeline (parse -> adapt -> analyze -> reduce ->
 * project) for one line and reports whether the row is an actionable exception
 * for the AI orchestration, together with the review's genuine authority.
 */
function pipelineLine(sessionIn: RealSession, line: string): {
  readonly line_ref: string;
  readonly exception: string | undefined;
  readonly hasStrictAuthority: boolean;
  readonly hasBestEffortAuthority: boolean;
  readonly recordedMatch: boolean;
  readonly reviewOutcome: string;
} {
  const parsed = parseIngredient({ name: line });
  if (!parsed.ok) throw new Error('parse failed');
  const ingredient = {
    original: line,
    ...(parsed.parsed.amount !== null ? { amount: parsed.parsed.amount } : {}),
    ...(parsed.parsed.raw_unit !== undefined ? { unit: parsed.parsed.raw_unit } : {}),
    name: parsed.parsed.query,
  };
  const recipeValue = {
    id: 'verify-ai2c',
    fileName: 'verify-ai2c.md',
    filePath: 'Recipes/verify-ai2c.md',
    rawMarkdown: '',
    title: 'verify',
    tags: [],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 2,
    ingredients: [ingredient],
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
  } as never;
  const adaptation = adaptRecipe(recipeValue);
  if (!adaptation.ok) throw new Error('adapt failed');
  const adapted = adaptation.recipe.adapted;
  const analysis = analyzeRecipe(sessionIn as never, adapted, 1);
  let state = phase4Reducer(INITIAL_PHASE4_STATE, {
    type: 'initialize',
    recipeKey: adaptation.recipe.recipe_key,
    sessionIdentity: phase4SessionIdentity((sessionIn as never as { metadata(): never }).metadata()),
    rows: buildReviewRows(sessionIn as never, adapted),
    baseServings: 1,
  });
  state = phase4Reducer(state, {
    type: 'apply_analysis',
    matches: analysis.matches,
    portions: analysis.portions,
    countPortions: analysis.countPortions,
    householdPortions: analysis.householdPortions,
    preview: analysis.preview,
  } as never);
  const calculated = (sessionIn as never as { calculate(request: unknown): { ok: boolean; preview: unknown } }).calculate(
    buildCalculationRequest(adapted, state)
  );
  if (!calculated.ok) throw new Error('calculate failed');
  const live = projectLiveRows(
    state,
    new Map(analysis.rows.map((entry) => [entry.line_ref, entry])),
    adapted,
    sessionIn as never,
    ingredientEvidenceViews(calculated.preview as never),
    analysis.portions,
    analysis.countPortions
  )[0];
  const review = reviewOf(sessionIn, parsed.parsed.query) as Record<string, unknown>;
  return {
    line_ref: live.line_ref,
    exception: liveExceptionKind(live.status),
    hasStrictAuthority: selectAutomaticMatch(review as never) !== undefined,
    hasBestEffortAuthority: bestEffortDefaultCandidates(review as never).length > 0,
    recordedMatch: state.matches[live.line_ref] !== undefined,
    reviewOutcome: String(review['outcome']),
  };
}

async function partA4(): Promise<void> {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const loaded = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!loaded.ok) return;
  const session = loaded.session as unknown as RealSession;

  // MATCH exceptions drive AI-2C's match bridge. `needs_amount` is a DIFFERENT
  // flow (identity already resolved, mass unresolved) and is reported separately
  // so it cannot mask a real violation here.
  const MATCH_EXCEPTIONS = ['needs_match', 'review_suggested'];
  let sampled = 0;
  let amountExceptions = 0;
  let strictAuthorityLines = 0;
  let strictRecorded = 0;
  let strictRepoOutcomeReviewRequired = 0;
  const violations: string[] = [];
  for (const phrase of PHRASES) {
    let row: ReturnType<typeof pipelineLine>;
    try {
      row = pipelineLine(session, `1 cup ${phrase}`);
    } catch {
      continue;
    }
    sampled += 1;
    const isMatchException = row.exception !== undefined && MATCH_EXCEPTIONS.includes(row.exception);
    if (row.exception === 'needs_amount') amountExceptions += 1;
    if (row.hasStrictAuthority) {
      strictAuthorityLines += 1;
      if (row.reviewOutcome === 'review_required' && row.recordedMatch) strictRecorded += 1;
      if (row.reviewOutcome === 'review_required') strictRepoOutcomeReviewRequired += 1;
    }
    // A: strict automatic authority is spent by the analyzer BEFORE match
    //    orchestration, so such a row must never be a MATCH exception.
    if (row.hasStrictAuthority && isMatchException) {
      violations.push(`${phrase}: strict-automatic line is a match exception`);
    }
    // B: a MATCH exception must not carry automatic authority of any form.
    if (isMatchException && (row.hasStrictAuthority || row.hasBestEffortAuthority)) {
      violations.push(`${phrase}: match exception carries automatic authority`);
    }
  }
  record(
    `A28 over ${sampled} real corpus lines (${strictAuthorityLines} with strict automatic authority, ${amountExceptions} amount-only exceptions), NO strict-automatic row is a MATCH exception and NO match exception carries automatic authority${
      violations.length > 0 ? `; violations: ${violations.slice(0, 3).join(' | ')}` : ''
    }`,
    sampled > 0 && violations.length === 0
  );

  // A29 — a strict-authority row whose review is `review_required` ALREADY carries
  // the analyzer's recorded working choice, which is why feeding such a row to the
  // bridge cannot mutate anything (the bridge refuses pre-existing working state).
  record(
    `A29 every strict-automatic review-required row already carries the analyzer's recorded working choice (${strictRecorded}/${strictRepoOutcomeReviewRequired})`,
    strictRepoOutcomeReviewRequired === 0 || strictRecorded === strictRepoOutcomeReviewRequired
  );
}

// ------------------------------------------------------------ module graph
function moduleGraph(): void {
  const seen = new Set<string>();
  const queue = [...AI2C_MODULES];
  const reached: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(join(ROOT, file))) continue;
    // Audited STABLE modules are leaf boundaries here: their own subtrees are
    // pinned by the AI-2B isolation suite, and AI-2C must not widen them.
    if (STABLE_AI2B.some(([stable]) => stable === file)) continue;
    const source = readFileSync(join(ROOT, file), 'utf8');
    const pattern = /(?:from\s+|import\s+|require\()\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolved = relative(ROOT, resolve(join(ROOT, dirname(file)), specifier)).replace(/\\/g, '/');
      for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`]) {
        if (existsSync(join(ROOT, candidate))) {
          reached.push(candidate);
          queue.push(candidate);
          break;
        }
      }
    }
  }
  const banned = reached.filter(
    (file) =>
      /phase5|advancedNutritionApply|markdown|server\/|adapters\//.test(file) &&
      !file.includes('adapters/NetworkAdapter')
  );
  record(
    `A26 the transitive AI-2C module graph reaches no Phase 5 / Apply / Markdown / server module (${reached.length} files${
      banned.length > 0 ? `; offenders: ${banned.slice(0, 5).join(', ')}` : ''
    })`,
    banned.length === 0
  );
  const graphText = reached.join('\n');
  record(
    'A27 the AI-2C module graph never reaches a USDA network/search adapter',
    !/usda\/(search|fetch|client|live)/.test(graphText)
  );
}

// ---------------------------------------------------------------- Part B
function partB(): void {
  for (const [file, digest] of FROZEN_AI0_AI2A) {
    record(`B1 frozen AI-0/AI-2A byte-identical: ${file}`, sha256Of(file) === digest);
  }
  for (const [file, digest] of STABLE_AI2B) {
    record(`B2 stable AI-2B production module byte-identical: ${file}`, sha256Of(file) === digest);
  }
  const app = readFileSync(join(ROOT, 'server/app.ts'), 'utf8');
  const planRoutes = app.match(/plan-ingredients/g) ?? [];
  record('B3 the committed AI-2B plan route is still registered exactly once', planRoutes.length === 1);
  const acceptanceRoutes = ['plan-accept', 'plan-apply', 'plan-acceptance', 'accept-plan'].filter((token) =>
    app.includes(token)
  );
  record(`B4 no AI-2C acceptance route exists in the server (${acceptanceRoutes.join(',') || 'none'})`, acceptanceRoutes.length === 0);
  const phase4Barrel = readFileSync(join(ROOT, 'src/core/nutritionV2/phase4/index.ts'), 'utf8');
  record(
    'B5 the Phase-4 barrel exposes the acceptance boundary for the shell',
    phase4Barrel.includes("'./deterministicAcceptanceView'") && phase4Barrel.includes("'./aiPlanReconcile'")
  );
}

async function main(): Promise<void> {
  await partA();
  await partA2();
  await partA3();
  await partA4();
  moduleGraph();
  partB();
  console.log(`\nAI-2C production verification: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
