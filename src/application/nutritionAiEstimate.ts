/**
 * The Kitchen Codex — application: AI-3 bounded mass estimation orchestration.
 *
 * Platform-neutral application port. It composes the PURE core layers in the
 * architect-approved order and performs the mid-flight re-reads. It has NO
 * network client, NO provider, NO reducer mutation and NO persistence/Apply
 * authority: the caller injects the transport port, and the UI owns state.
 *
 * Order of operations (each step is a gate on the next):
 *   1. capability gate BEFORE any transport
 *   2. deterministic eligibility per line
 *   3. request construction (bounded lines, bounded bytes)
 *   4. injected transport
 *   5. response sanitization
 *   6. request/session/recipe binding re-check
 *   7. snapshot binding
 *   8. per-line mid-flight conflict check
 *   9. stronger-source re-check
 *  10. pure reconciliation into OFFERS / abstained / conflicted / unchanged
 */

import {
  AI_ESTIMATE_POLICY_VERSION,
  AI_ESTIMATE_PROVENANCE_CLASS,
} from '../core/nutritionV2/aiAdvancedEstimate';
import { MAX_AI_ESTIMATE_RANGE_RATIO } from '../core/nutritionV2/aiEstimateBounds';
import {
  AI_ESTIMATE_REQUEST_VERSION,
  MAX_AI_ESTIMATE_REQUEST_BYTES,
  aiEstimateRequestByteLength,
  buildAiEstimateModelRequest,
  type AiEstimateRequestLine,
  type AiEstimateTransportRequest,
} from '../core/nutritionV2/aiAdvancedEstimateWire';
import {
  MAX_AI_ESTIMATE_LINES,
  evaluateAiEstimateEligibility,
  aiEstimateSnapshotBinding,
  type AiEstimateEligibilityInput,
  type AiEstimateAbstentionReason,
  type AiEstimateBoundedEvidence,
  type AiEstimateIneligibleReason,
  type AiEstimateParseFacts,
  type AiEstimateSnapshotInput,
} from '../core/nutritionV2/phase4/aiEstimateValidation';
import {
  reconcileAiBoundedEstimates,
  type AiEstimateCandidate,
  type AiEstimateReconcileResult,
} from '../core/nutritionV2/phase4/aiEstimateResolve';
import { resolveNutritionCapabilities, type NutritionCapabilities } from '../core/nutritionV2/nutritionCapabilities';
import { deriveAiEstimateProductionInput } from '../core/nutritionV2/phase4/aiEstimateValidation';
import {
  deriveAiEstimateIdentityEvidence,
  type AiEstimateIdentityEvidence,
} from '../core/nutritionV2/phase4/aiEstimateIdentityEvidence';
import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4/types';

/** The injected estimate transport port. This module performs NO network. */
export interface AiEstimateTransport {
  request(request: AiEstimateTransportRequest): Promise<{
    readonly ok: boolean;
    readonly request_id?: string;
    readonly estimates?: ReadonlyArray<Record<string, unknown>>;
    readonly code?: string;
  }>;
}

/** One line the caller asked us to estimate. */
export interface AiEstimateRequestTarget {
  readonly lineRef: string;
  readonly eligibility: AiEstimateEligibilityInput;
}

export interface AiEstimateOrchestrationDeps {
  readonly recipeKey: string;
  readonly sessionIdentity: string;
  /**
   * The ONE read-only accessor for the CURRENT Phase-4 state.
   *
   * It is a REQUIRED getter rather than a captured value because mid-flight
   * currentness is a load-bearing invariant (M49): authority-relevant state can
   * change WHILE the transport request is in flight, and the response must be
   * reconciled against the state that is NOW, not the state captured at
   * dispatch. A captured `currentState` value made that unobservable.
   *
   * It is supplied by the canonical live Phase-4 state owner only. It is never
   * derived from request, model, network, recipe or persisted data, it is never
   * optional, and it is not a second domain authority.
   */
  readonly getCurrentState: () => AiEstimateReconcileState;
  readonly capabilityInput: Parameters<typeof resolveNutritionCapabilities>[0];
  /**
   * An ALREADY-RESOLVED capability set from the production shell. When present
   * it is used verbatim instead of re-resolving from `capabilityInput`, so the
   * shell's single centralized decision is never re-derived or inverted.
   */
  readonly capabilities?: Readonly<ReturnType<typeof resolveNutritionCapabilities>>;
  /**
   * The CANONICAL identity evidence per line, from the ONE Phase-4/session
   * evidence owner. It is the single authority for the pinned record digest,
   * so there is no separate record-digest map and no second derivation path.
   * Absent entries simply fail closed downstream; nothing is invented.
   */
  readonly identityEvidence?: ReadonlyMap<string, AiEstimateIdentityEvidence>;
  readonly issueKinds: Readonly<Record<string, string>>;
  readonly parses: ReadonlyMap<string, AiEstimateParseFacts>;
  readonly snapshots: ReadonlyMap<string, AiEstimateSnapshotInput>;
  /** Fingerprints captured when the request started. */
  readonly capturedFingerprints: ReadonlyMap<string, string>;
  readonly transport: AiEstimateTransport;
}

type AiEstimateReconcileState = Parameters<typeof reconcileAiBoundedEstimates>[0]['currentState'];

export type AiEstimateRequestOutcome =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'no_eligible_lines'; readonly abstained: ReadonlyArray<AiEstimateAbstentionReport> }
  | {
      readonly kind: 'ok';
      readonly result: AiEstimateReconcileResult;
      readonly requestId: string;
    };

export interface AiEstimateAbstentionReport {
  readonly lineRef: string;
  /** The closed, deterministic local reason. Never model-authored prose. */
  readonly reason: AiEstimateAbstentionReason | AiEstimateIneligibleReason | 'unbuildable_request_line';
}

/**
 * Projects ONE sanitized response entry into local bounded evidence. The
 * numeric shape is already sanitized at the transport boundary; the 4x ratio,
 * the gram bounds, the midpoint agreement and the policy are re-validated by
 * the core reconcile layer, which refuses rather than clamps.
 */
function buildEvidenceFromEntry(
  lineRef: string,
  entry: Record<string, unknown>
): AiEstimateBoundedEvidence {
  return {
    line_ref: lineRef,
    lower_grams: entry['lower_grams'] as number,
    upper_grams: entry['upper_grams'] as number,
    representative_grams: entry['representative_grams'] as number,
    representative_policy: entry['representative_policy'] as 'midpoint',
    provenance: AI_ESTIMATE_PROVENANCE_CLASS,
  } as AiEstimateBoundedEvidence;
}

/**
 * Projects an ELIGIBLE line into its bounded model-facing request line. This is
 * the ONLY place the model payload is shaped; the caller never hands one over.
 */
function buildRequestLine(
  lineRef: string,
  eligibility: AiEstimateEligibilityInput
): AiEstimateRequestLine | undefined {
  const row = eligibility.state.rows.find((candidate) => candidate.line_ref === lineRef);
  const match = eligibility.state.matches?.[lineRef];
  if (row === undefined || match === undefined) return undefined;
  return {
    line_ref: lineRef,
    source_text: row.original_text,
    amount: eligibility.parse.amount,
    unit: null,
    measurement_kind: 'unknown',
    count_noun: null,
    food_semantics: row.query,
    local_food_description: match.description ?? null,
    evidence_absent_reason: 'no_authenticated_portion',
  } as AiEstimateRequestLine;
}

/**
 * Runs one explicit, user-invoked estimation request. Never persists, never
 * applies, and never auto-selects: it returns offers only.
 */
export async function runAiMassEstimation(
  targets: ReadonlyArray<AiEstimateRequestTarget>,
  deps: AiEstimateOrchestrationDeps
): Promise<AiEstimateRequestOutcome> {
  // 1. CAPABILITY GATE -- strictly before any transport work. The SAME
  // capability the route gate uses, so a disabled tier costs zero calls.
  const capabilities = deps.capabilities ?? resolveNutritionCapabilities(deps.capabilityInput);
  if (capabilities.aiEstimation !== 'available') {
    return { kind: 'unavailable', reason: 'estimation_capability_unavailable' };
  }

  // 1b. REQUEST-START STATE. Bound to the request so the response is known to
  // have been asked about THESE lines under THESE facts. This is deliberately
  // NOT the state used for currentness decisions after the await.
  const requestStartState = deps.getCurrentState();

  // 2. DETERMINISTIC ELIGIBILITY, plus 3. request construction.
  const requestLines: AiEstimateRequestLine[] = [];
  const eligibleRefs = new Set<string>();
  const abstained: AiEstimateAbstentionReport[] = [];
  for (const target of targets) {
    const eligibility = evaluateAiEstimateEligibility({
      ...target.eligibility,
      capabilityAvailable: true,
    });
    if (eligibility.eligible !== true) {
      abstained.push({ lineRef: target.lineRef, reason: eligibility.reason });
      continue;
    }
    const line = buildRequestLine(target.lineRef, target.eligibility);
    if (line === undefined) {
      abstained.push({ lineRef: target.lineRef, reason: 'unbuildable_request_line' });
      continue;
    }
    requestLines.push(line);
    eligibleRefs.add(target.lineRef);
  }
  if (requestLines.length === 0) {
    return { kind: 'no_eligible_lines', abstained };
  }
  if (requestLines.length > MAX_AI_ESTIMATE_LINES) {
    return { kind: 'unavailable', reason: 'too_many_lines' };
  }

  const modelRequest = buildAiEstimateModelRequest(requestLines);
  if (aiEstimateRequestByteLength(modelRequest) > MAX_AI_ESTIMATE_REQUEST_BYTES) {
    return { kind: 'unavailable', reason: 'request_too_large' };
  }
  const request: AiEstimateTransportRequest = {
    request_version: AI_ESTIMATE_REQUEST_VERSION,
    request_id: `${deps.recipeKey}:${deps.sessionIdentity}`,
    estimate_request: modelRequest,
  };

  // 4. TRANSPORT (injected; this module never performs network).
  const response = await deps.transport.request(request);
  if (response.ok !== true) return { kind: 'unavailable', reason: response.code ?? 'transport_failed' };

  // 5. RESPONSE SANITIZATION happened at the transport boundary; re-bind here.
  const rawEstimates = response.estimates ?? [];
  const candidates: AiEstimateCandidate[] = [];
  for (const entry of rawEstimates) {
    const ref = entry['line_ref'];
    if (typeof ref !== 'string' || !eligibleRefs.has(ref)) continue;
    // Request binding: only lines we actually asked about may come back.
    if (candidates.some((candidate) => candidate.line_ref === ref)) continue;
    if (entry['policy_version'] !== AI_ESTIMATE_POLICY_VERSION) continue;
    if (entry['provenance_class'] !== AI_ESTIMATE_PROVENANCE_CLASS) continue;
    // The identity bound to an offer is the CURRENT LOCAL match, never a
    // model-supplied one. The model returned a range and nothing else.
    // MID-FLIGHT CURRENTNESS (M49). Read the CURRENT state AFTER the transport
    // response has arrived, so an authority change made while the request was
    // in flight is honoured here and an A-era response cannot be laundered
    // into a valid offer.
    const currentState = deps.getCurrentState();
    const currentMatch = currentState.matches?.[ref];
    if (currentMatch === undefined || typeof currentMatch.fdc_id !== 'number') continue;
    // The pinned RECORD digest is NOT carried on Phase-4 match state (a
    // `MatchChoice` has no `record_digest`). The ONE authority for it is the
    // session's bounded pinned-record lookup, surfaced by the production
    // adapter. When it supplies one it is used; otherwise we fall back to the
    // match field so existing callers keep working. An absent digest fails
    // closed later in `buildAiEstimateSelection` -- never silently defaulted.
    // The pinned record digest comes from the ONE canonical evidence owner and
    // from nowhere else. A Phase-4 `MatchChoice` carries no `record_digest`, so
    // there is deliberately NO fallback read here: without canonical evidence
    // the digest stays empty and the selection fails closed downstream.
    const recordDigest = deps.identityEvidence?.get(ref)?.record_digest ?? '';
    candidates.push({
      line_ref: ref,
      evidence: buildEvidenceFromEntry(ref, entry),
      fdc_id: currentMatch.fdc_id,
      record_digest: recordDigest,
      review_digest: String(currentMatch.review_digest ?? ''),
    });
  }

  // 6. REQUEST/SESSION/RECIPE BINDING + 8./9. mid-flight re-reads.
  if (response.request_id !== undefined && response.request_id !== request.request_id) {
    return { kind: 'unavailable', reason: 'request_binding_mismatch' };
  }

  // 10. PURE RECONCILIATION. It re-derives the parse facts, the fingerprints and
  // the snapshot bindings from the CURRENT state, so a mid-flight change to a
  // match, an amount, a user mass, a portion or a prior estimate loses here.
  const result: AiEstimateReconcileResult = reconcileAiBoundedEstimates({
    // The state as it is NOW, re-read after the await. `requestStartState` is
    // deliberately NOT reused here.
    currentState: deps.getCurrentState(),
    capturedFingerprints: deps.capturedFingerprints,
    parses: deps.parses,
    issueKinds: deps.issueKinds,
    snapshots: deps.snapshots,
    candidates,
    capabilityAvailable: true,
  });
  return { kind: 'ok', result, requestId: response.request_id ?? request.request_id };
}

/**
 * PRODUCTION COMPOSITION ADAPTER (AI-3).
 *
 * This is the ONLY function the production parent (App) needs. It is a thin map
 * over the existing orchestration: it re-implements NO eligibility, request
 * construction, capability gating, transport, reconciliation, snapshot logic or
 * offer construction -- all of that stays in `runAiMassEstimation` and the
 * Phase-4 modules it calls.
 *
 * The production parent therefore imports only this approved application
 * boundary. It never imports the parser, the wire, the provider or the route.
 */
export async function requestAiMassEstimateOffers(input: {
  readonly state: Parameters<typeof deriveAiEstimateProductionInput>[0]['state'];
  readonly lines: ReadonlyArray<{ readonly line_ref: string; readonly original_text: string; readonly outcome: string }>;
  /**
   * THE capability decision, already resolved by the ONE centralized product /
   * shell capability owner. It is REQUIRED and TYPED, so this adapter cannot
   * open a second authority surface: there is no raw flag, no request-body
   * field, no model output and no UI prop that can promote a tier here. The
   * value is used verbatim and never re-derived here.
   */
  readonly capabilities: Readonly<NutritionCapabilities>;
  /**
   * Optional narrow latest-value accessor supplied by the composition shell so
   * a mid-flight authority change is observable. It must return the canonical
   * live Phase-4 state and nothing else.
   */
  readonly getCurrentState?: () => AiEstimateReconcileState;
  readonly transport: AiEstimateTransport;
  /**
   * The current Phase-4 session. It is the ONLY source of the five-field
   * selection evidence; the adapter never derives identity itself.
   */
  readonly session: AdvancedNutritionSession;
}): Promise<{
  readonly ok: true;
  readonly offers: ReadonlyArray<{
    readonly line_ref: string;
    readonly label: string;
    readonly lower_grams: number;
    readonly upper_grams: number;
    readonly representative_grams: number;
    readonly representative_policy: 'midpoint';
    readonly notes?: string;
    readonly evidence?: {
      readonly line_ref: string;
      readonly fdc_id: number;
      readonly record_digest: string;
      readonly ingredient_identity_digest: string;
      readonly bundle_release: string;
    };
  }>;
  readonly refused: ReadonlyArray<{ readonly line_ref: string; readonly reason: string }>;
  readonly message?: string;
}> {
  // CAPABILITY FIRST. A tier that cannot estimate must cost zero provider
  // calls and must not even reach the orchestration.
  // The shell's single centralized decision, used verbatim.
  const capabilities = input.capabilities;
  if (capabilities.aiEstimation !== 'available') {
    return { ok: true, offers: [], refused: [], message: 'AI estimation is not available for this tier.' };
  }

  // THE single Phase-4/session identity-evidence owner. It runs FIRST, before
  // any provider call, and it is the only source of the five-field evidence and
  // of the pinned record digest. A line whose evidence cannot be proven is
  // reported through the EXISTING refused channel and never becomes a
  // selectable, evidence-free offer.
  const evidence = new Map<string, AiEstimateIdentityEvidence>();
  const unproven = new Set<string>();
  for (const line of input.lines) {
    const derivedEvidence = deriveAiEstimateIdentityEvidence({
      session: input.session,
      state: input.state,
      lineRef: line.line_ref,
    });
    if (derivedEvidence === null) {
      unproven.add(line.line_ref);
      continue;
    }
    evidence.set(line.line_ref, derivedEvidence);
  }

  const targets: AiEstimateRequestTarget[] = [];
  const parses = new Map<string, AiEstimateParseFacts>();
  const snapshots = new Map<string, AiEstimateSnapshotInput>();
  const capturedFingerprints = new Map<string, string>();
  const issueKinds: Record<string, string> = {};
  for (const line of input.lines) {
    if (unproven.has(line.line_ref)) continue;
    const derived = deriveAiEstimateProductionInput({
      state: input.state,
      lineRef: line.line_ref,
      sourceText: line.original_text,
      rowStatus: line.outcome,
      capabilityAvailable: true,
      evidence: evidence.get(line.line_ref) ?? null,
    });
    issueKinds[line.line_ref] = line.outcome;
    parses.set(line.line_ref, derived.parse);
    if (derived.snapshot !== null) snapshots.set(line.line_ref, derived.snapshot);
    if (derived.fingerprint !== null) capturedFingerprints.set(line.line_ref, derived.fingerprint);
    targets.push({ lineRef: line.line_ref, eligibility: derived.eligibility });
  }

  const outcome = await runAiMassEstimation(targets, {
    recipeKey: input.state.recipeKey,
    sessionIdentity: input.state.sessionIdentity,
    // ONE read-only accessor onto the canonical live Phase-4 state. The shell
    // may pass a narrow latest-value ref so a mid-flight authority change is
    // observable; it tracks the SAME canonical state and is not a second
    // authority, is never persisted, and is never model/network/request
    // controlled. When the shell has no live ref, the composed state IS the
    // live state, so the closure returns it.
    getCurrentState: input.getCurrentState ?? ((): AiEstimateReconcileState => input.state),
    capabilityInput: {},
    capabilities: input.capabilities,
    // The ONE Phase-4/session evidence owner. It supplies BOTH the pinned
    // record digest and the snapshot's identity bindings -- one canonical
    // object per line, no parallel digest map, no new hashing.
    identityEvidence: evidence,
    issueKinds,
    parses,
    snapshots,
    capturedFingerprints,
    transport: input.transport,
  });

  if (outcome.kind === 'unavailable') {
    return { ok: true, offers: [], refused: [], message: 'AI estimation is not available right now.' };
  }
  if (outcome.kind === 'no_eligible_lines') {
    return {
      ok: true,
      offers: [],
      refused: outcome.abstained.map((a) => ({ line_ref: a.lineRef, reason: a.reason })),
    };
  }

  // OFFERS ONLY, AND ONLY WITH COMPLETE FIVE-FIELD EVIDENCE.
  //
  // An estimate is actionable ONLY when the Phase-4/session helper can prove
  // every field of the five-field selection contract:
  //   line_ref, fdc_id, record_digest, ingredient_identity_digest, bundle_release
  //
  // When the helper returns null the line is NOT emitted as an actionable offer.
  // It is reported as refused with the LOCAL reason `identity_evidence_unproven`
  // so the caller learns why, without inventing a new public error vocabulary
  // and without ever emitting a partial or evidence-free offer.
  const offers: Array<{
    line_ref: string;
    label: string;
    lower_grams: number;
    upper_grams: number;
    representative_grams: number;
    representative_policy: 'midpoint';
    evidence: {
      line_ref: string;
      fdc_id: number;
      record_digest: string;
      ingredient_identity_digest: string;
      bundle_release: string;
    };
  }> = [];
  const unprovenLines: Array<{ line_ref: string; reason: string }> = [];
  for (const lineRef of unproven) {
    unprovenLines.push({ line_ref: lineRef, reason: 'identity_evidence_unproven' });
  }

  for (const entry of outcome.result.entries) {
    if (entry.kind !== 'offer' || entry.evidence === undefined) continue;
    const lineRef = entry.line_ref;
    // Re-use the evidence the ONE Phase-4/session owner already derived for
    // this line, ahead of any provider call. It is identical by construction.
    const proven = evidence.get(lineRef);
    if (proven === undefined) {
      unprovenLines.push({ line_ref: lineRef, reason: 'identity_evidence_unproven' });
      continue;
    }
    // Still inert: this only ATTACHES authority. It does not select, dispatch,
    // write state, affect the preview or block Apply.
    offers.push({
      line_ref: lineRef,
      label: 'AI estimate (not USDA-authenticated)',
      lower_grams: entry.evidence.lower_grams,
      upper_grams: entry.evidence.upper_grams,
      representative_grams: entry.evidence.representative_grams,
      representative_policy: 'midpoint' as const,
      evidence: { line_ref: lineRef, ...proven },
    });
  }

  const refused = [
    ...unprovenLines,
    ...outcome.result.entries
      .filter((e) => e.kind !== 'offer')
      .map((e) => ({ line_ref: e.line_ref, reason: e.detail ?? e.kind })),
  ];
  return { ok: true, offers, refused };
}

export { aiEstimateSnapshotBinding };
export type { AiEstimateSnapshotInput };
