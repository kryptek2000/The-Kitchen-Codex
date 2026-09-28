/**
 * The Kitchen Codex — Advanced Nutrition Phase 4 (AI-2C): pure plan
 * reconciliation.
 *
 * PURE, platform-neutral, offline, side-effect free. This module turns a
 * canonical AI-2B inert plan into INERT, bounded deterministic reconciliation
 * buckets:
 *
 *   accepted  — lines whose AI-2A classification is `automatic`, whose strict
 *               deterministic authority is independently re-confirmed here, and
 *               whose CURRENT working state is safe to transition;
 *   offers    — locally authenticated recommendations that must wait for an
 *               explicit user confirmation (never a state mutation);
 *   preserved — review/abstention results and lines that no longer exist;
 *   conflicts — lines the user already decided (mid-flight or beforehand);
 *   unchanged — lines whose current working selection is already identical.
 *
 * AUTHORITY BOUNDARY
 * ------------------
 *   - CLASSIFICATION IS NOT RE-DERIVED. `validateAndApplyAiAdvancedPlan` (the
 *     frozen AI-2A validator) owns automatic/offer/review; this module consumes
 *     its closed vocabulary and never re-implements it.
 *   - THE PORT IS RE-CHECKED INDEPENDENTLY. `automatic` additionally requires
 *     the injected deterministic acceptance port to name the SAME local FDC
 *     candidate, so the acceptance is provable at THIS boundary too, not only
 *     inside AI-2A.
 *   - AI MAY SPEND DETERMINISTIC AUTHORITY, NEVER USER AUTHORITY. A line that
 *     already carries an explicit working match choice (including
 *     `kind: 'none'`) or any stored mass source is NEVER auto-accepted: it
 *     becomes a conflict or an offer, and its state is left exactly as the user
 *     left it. `select_match` clears a line's portion/count/mass choices, so
 *     dispatching it over user state would silently destroy that decision.
 *   - NO MUTATION, NO DISPATCH, NO APPLY, NO PERSISTENCE, NO NETWORK, NO UI.
 *     The result is frozen inert data; the application layer owns confirmation
 *     and the working-state transition.
 *   - The emitted `choice` objects are working-state descriptors bound to the
 *     CURRENT review digest; the emitted `confirmation` objects are the Phase-2
 *     selection built by the EXISTING `selectionFromMatchChoice` (no second
 *     selection implementation).
 */

import {
  validateAndApplyAiAdvancedPlan,
  type AiAdvancedPlanApplication,
  type AiAdvancedPlanApplyFailureCode,
  type AiAdvancedPlanLineReason,
} from '../aiAdvancedPlanApply';
import { selectionFromMatchChoice } from './rows';
import type { MatchChoice } from './types';

export const AI_PLAN_RECONCILE_VERSION = 'nutrition_ai_advanced_plan_reconcile_v1';

/** Bounded, INTERNAL conflict classification (never a transport failure code). */
export type AiPlanReconcileConflictKind =
  | 'fingerprint_changed'
  | 'no_capture'
  | 'pre_existing_match'
  | 'pre_existing_mass_source';

export type AiPlanReconcilePreservedReason = AiAdvancedPlanLineReason | 'line_missing';

/** One line whose AI-2A `automatic` classification survived every §3 condition. */
export interface AiPlanReconciledAcceptance {
  readonly line_ref: string;
  readonly candidate_ref: string;
  /** Locally resolved FDC id, resolved by AI-2A from the opaque ref only. */
  readonly fdc_id: number;
  /** The CURRENT review digest this acceptance is bound to. */
  readonly review_digest: string;
  readonly reason: 'deterministic_automatic';
  /** Working-state descriptor for the existing match transition. */
  readonly choice: MatchChoice;
  /** The Phase-2 selection the application layer must confirm with a genuine session. */
  readonly confirmation: unknown;
}

/** A locally authenticated recommendation that is NOT a state transition. */
export interface AiPlanReconciledOffer {
  readonly line_ref: string;
  readonly candidate_ref: string;
  readonly fdc_id: number;
  readonly review_digest: string;
  readonly reason: AiAdvancedPlanLineReason;
  /**
   * DISPLAY-ONLY text: the authenticated record's own description, read from the
   * LINE'S LOCAL candidate set (never from model output). It carries no
   * authority — the calculator re-resolves the description from the record it
   * verifies.
   */
  readonly description?: string;
  readonly choice: MatchChoice;
}

export interface AiPlanReconciledPreserved {
  readonly line_ref: string;
  readonly reason: AiPlanReconcilePreservedReason;
}

export interface AiPlanReconcileConflict {
  readonly line_ref: string;
  readonly kind: AiPlanReconcileConflictKind;
  readonly reason: AiAdvancedPlanLineReason;
}

export interface AiPlanReconciliation {
  readonly reconcile_version: typeof AI_PLAN_RECONCILE_VERSION;
  readonly request_id: string;
  /** The frozen AI-2A classification this reconciliation consumed (inert). */
  readonly classification: AiAdvancedPlanApplication;
  readonly accepted: ReadonlyArray<AiPlanReconciledAcceptance>;
  readonly offers: ReadonlyArray<AiPlanReconciledOffer>;
  readonly preserved: ReadonlyArray<AiPlanReconciledPreserved>;
  readonly conflicts: ReadonlyArray<AiPlanReconcileConflict>;
  readonly unchanged: ReadonlyArray<string>;
  readonly accepted_count: number;
  readonly offer_count: number;
  readonly preserved_count: number;
  readonly conflict_count: number;
  readonly unchanged_count: number;
}

export type AiPlanReconcileResult =
  | { readonly ok: true; readonly reconciliation: AiPlanReconciliation }
  | { readonly ok: false; readonly code: AiAdvancedPlanApplyFailureCode };

export interface AiPlanReconcileInput {
  /** The canonical AI-2B wire payload. */
  readonly plan: unknown;
  /** Which request this plan answers. Missing/foreign ⇒ the whole plan is discarded. */
  readonly responseRequestId: unknown;
  /** The AI-2A request context the plan was issued for. */
  readonly requestContext: unknown;
  /** Current deterministic reviews (Map, `{line_ref, review}[]`, or record). */
  readonly reviews: unknown;
  /** The Phase-4 deterministic acceptance port (`deterministicAcceptanceView`). */
  readonly deterministicAcceptance: unknown;
  readonly issueKinds?: unknown;
  readonly interpretationFingerprints?: unknown;
  /** The line refs that exist NOW. A line outside this set is never recreated. */
  readonly currentLineRefs?: unknown;
  /** Current working state, read-only. */
  readonly workingState?: {
    readonly matches?: unknown;
    readonly portions?: unknown;
    readonly countPortions?: unknown;
    readonly userMasses?: unknown;
    readonly householdPortions?: unknown;
  };
  /** Snapshot captured when the request STARTED. */
  readonly captured?: {
    readonly fingerprints?: unknown;
    readonly matches?: unknown;
    readonly massSourceLineRefs?: unknown;
  };
  /** Working-choice fingerprints read NOW (same helper as the snapshot). */
  readonly currentFingerprints?: unknown;
}

// ---------------------------------------------------------------------------
// Bounded readers (Map | `{line_ref, value}[]` | plain record)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asLineMap(value: unknown): Map<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const out = new Map<string, unknown>();
  if (value instanceof Map) {
    for (const [key, entry] of (value as Map<unknown, unknown>).entries()) {
      if (typeof key !== 'string' || key.length === 0) return undefined;
      out.set(key, entry);
    }
    return out;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) out.set(key, entry);
    return out;
  }
  return undefined;
}

function asLineRefSet(value: unknown): Set<string> | undefined {
  if (value === undefined || value === null) return undefined;
  const out = new Set<string>();
  if (typeof value === 'string') {
    out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.length === 0) return undefined;
      out.add(entry);
    }
    return out;
  }
  if (isRecord(value) || value instanceof Set) {
    if (value instanceof Set) {
      for (const entry of value.values()) {
        if (typeof entry !== 'string') return undefined;
        out.add(entry);
      }
      return out;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) out.add(key);
    return out;
  }
  return undefined;
}

/** True when a working choice resolves the SAME candidate identity (AI markers ignored). */
function sameCandidateIdentity(current: unknown, proposed: MatchChoice): boolean {
  if (!isRecord(current)) return false;
  if (current['kind'] !== 'candidate') return false;
  if (current['fdc_id'] !== proposed.fdc_id) return false;
  if (current['review_digest'] !== proposed.review_digest) return false;
  // A manual selection is a DIFFERENT authority shape even for the same record.
  if (current['record_digest'] !== undefined) return false;
  if (current['catalog_digest'] !== undefined) return false;
  return true;
}

function reviewDigestOf(review: unknown): string | undefined {
  if (!isRecord(review)) return undefined;
  const digest = review['review_digest'];
  return typeof digest === 'string' && digest.length > 0 ? digest : undefined;
}

/**
 * DISPLAY-ONLY description for one candidate ref, read from the LINE'S LOCAL
 * candidate set (authenticated records only). Never taken from model output.
 */
function localDescriptionFor(
  requestContext: unknown,
  lineRef: string,
  candidateRef: string
): string | undefined {
  if (!isRecord(requestContext)) return undefined;
  const line = requestContext['line'];
  if (typeof line !== 'function') return undefined;
  try {
    const source = (line as (ref: string) => unknown).call(requestContext, lineRef);
    if (!isRecord(source)) return undefined;
    const candidateSet = source['candidate_set'];
    if (!isRecord(candidateSet) || !Array.isArray(candidateSet['views'])) return undefined;
    for (const view of candidateSet['views'] as ReadonlyArray<unknown>) {
      if (!isRecord(view)) continue;
      if (view['candidate_ref'] !== candidateRef) continue;
      const description = view['display_description'];
      if (typeof description === 'string' && description.trim().length > 0) return description.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function hasEntry(map: Map<string, unknown> | undefined, lineRef: string): boolean {
  if (map === undefined) return false;
  const value = map.get(lineRef);
  return value !== undefined && value !== null;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconciles one canonical AI-2B plan against the CURRENT deterministic
 * authority. Never throws. Never mutates. Returns inert buckets or a closed
 * whole-plan failure code reused from AI-2A.
 */
export function reconcileAiAdvancedCandidatePlan(
  input: AiPlanReconcileInput
): AiPlanReconcileResult {
  const classification = validateAndApplyAiAdvancedPlan({
    rawPlanResponse: input.plan,
    responseRequestId: input.responseRequestId,
    context: input.requestContext,
    reviews: input.reviews,
    deterministicAcceptance: input.deterministicAcceptance,
    ...(input.issueKinds !== undefined ? { issueKinds: input.issueKinds } : {}),
    ...(input.interpretationFingerprints !== undefined
      ? { interpretationFingerprints: input.interpretationFingerprints }
      : {}),
  });
  if (classification.ok !== true) return { ok: false, code: classification.code };

  const application = classification.application;
  const reviews = asLineMap(input.reviews);
  const currentLineRefs = asLineRefSet(input.currentLineRefs);
  const matches = asLineMap(input.workingState?.matches);
  const portions = asLineMap(input.workingState?.portions);
  const countPortions = asLineMap(input.workingState?.countPortions);
  const userMasses = asLineMap(input.workingState?.userMasses);
  const householdPortions = asLineMap(input.workingState?.householdPortions);
  const capturedFingerprints = asLineMap(input.captured?.fingerprints);
  const capturedMatches = asLineMap(input.captured?.matches);
  const capturedMassLines = asLineRefSet(input.captured?.massSourceLineRefs);
  const currentFingerprints = asLineMap(input.currentFingerprints);

  const port = input.deterministicAcceptance as
    | ((review: unknown) => { strict_automatic_fdc_id?: number } | undefined)
    | undefined;

  const accepted: AiPlanReconciledAcceptance[] = [];
  const offers: AiPlanReconciledOffer[] = [];
  const preserved: AiPlanReconciledPreserved[] = [];
  const conflicts: AiPlanReconcileConflict[] = [];
  const unchanged: string[] = [];

  for (const outcome of application.lines) {
    const lineRef = outcome.line_ref;

    // (0) LINE EXISTENCE: a line removed from the recipe is never recreated.
    if (currentLineRefs !== undefined && !currentLineRefs.has(lineRef)) {
      preserved.push(Object.freeze({ line_ref: lineRef, reason: 'line_missing' as const }));
      continue;
    }

    // (1) MID-FLIGHT USER AUTHORITY (applies to offers too: a user who acted on
    // the line while the plan was in flight is not nagged with a stale plan).
    if (capturedFingerprints !== undefined) {
      const captured = capturedFingerprints.get(lineRef);
      const current = currentFingerprints?.get(lineRef);
      if (typeof captured !== 'string' || typeof current !== 'string') {
        conflicts.push(Object.freeze({ line_ref: lineRef, kind: 'no_capture' as const, reason: outcome.reason }));
        continue;
      }
      if (captured !== current) {
        conflicts.push(
          Object.freeze({ line_ref: lineRef, kind: 'fingerprint_changed' as const, reason: outcome.reason })
        );
        continue;
      }
    }

    const review = reviews?.get(lineRef);
    const reviewDigest = reviewDigestOf(review);

    if (outcome.status === 'review') {
      preserved.push(Object.freeze({ line_ref: lineRef, reason: outcome.reason }));
      continue;
    }

    if (outcome.status === 'offer') {
      // Never a mutation: a locally authenticated recommendation only.
      if (outcome.candidate_ref === undefined || outcome.local_fdc_id === undefined || reviewDigest === undefined) {
        preserved.push(Object.freeze({ line_ref: lineRef, reason: outcome.reason }));
        continue;
      }
      const choice: MatchChoice = Object.freeze({
        kind: 'candidate' as const,
        fdc_id: outcome.local_fdc_id,
        review_digest: reviewDigest,
        // OFFER provenance: display-only, and NO acceptance marker — an explicit
        // "Use this match" must remain a genuine user confirmation.
        aiAssisted: true,
      });
      const description = localDescriptionFor(input.requestContext, lineRef, outcome.candidate_ref);
      offers.push(
        Object.freeze({
          line_ref: lineRef,
          candidate_ref: outcome.candidate_ref,
          fdc_id: outcome.local_fdc_id,
          review_digest: reviewDigest,
          reason: outcome.reason,
          ...(description !== undefined ? { description } : {}),
          choice,
        })
      );
      continue;
    }

    // outcome.status === 'automatic'
    const fdcId = outcome.local_fdc_id;
    const candidateRef = outcome.candidate_ref;
    if (candidateRef === undefined || fdcId === undefined || reviewDigest === undefined) {
      preserved.push(Object.freeze({ line_ref: lineRef, reason: 'review_unavailable' as const }));
      continue;
    }

    // (2) INDEPENDENT PORT RE-CHECK: `automatic` must be provable HERE, from the
    // SAME port, for the SAME locally resolved candidate.
    const view = typeof port === 'function' ? port(review) : undefined;
    if (
      outcome.matches_strict_automatic !== true ||
      view === undefined ||
      view.strict_automatic_fdc_id !== fdcId
    ) {
      preserved.push(Object.freeze({ line_ref: lineRef, reason: outcome.reason }));
      continue;
    }

    const proposed: MatchChoice = Object.freeze({
      kind: 'candidate' as const,
      fdc_id: fdcId,
      review_digest: reviewDigest,
      automatic: true,
      aiAssisted: true,
      aiAccepted: true,
    });

    // (3) IDEMPOTENCY: the same selection already present ⇒ nothing to dispatch.
    const currentMatch = matches?.get(lineRef);
    if (sameCandidateIdentity(currentMatch, proposed)) {
      unchanged.push(lineRef);
      continue;
    }

    // (4) USER/WORKING AUTHORITY IS NEVER OVERWRITTEN. An explicit choice —
    // including `kind: 'none'` — may have been made before or during the flight.
    if (currentMatch !== undefined && currentMatch !== null) {
      conflicts.push(
        Object.freeze({ line_ref: lineRef, kind: 'pre_existing_match' as const, reason: outcome.reason })
      );
      continue;
    }
    if (capturedMatches !== undefined && hasEntry(capturedMatches, lineRef)) {
      conflicts.push(
        Object.freeze({ line_ref: lineRef, kind: 'pre_existing_match' as const, reason: outcome.reason })
      );
      continue;
    }

    // (5) MASS FIREWALL: `select_match` clears a line's portion/count/mass
    // choices, so accepting here would silently erase an authenticated mass
    // decision. AI may not spend user authority.
    if (
      hasEntry(portions, lineRef) ||
      hasEntry(countPortions, lineRef) ||
      hasEntry(userMasses, lineRef) ||
      hasEntry(householdPortions, lineRef) ||
      (capturedMassLines !== undefined && capturedMassLines.has(lineRef))
    ) {
      conflicts.push(
        Object.freeze({ line_ref: lineRef, kind: 'pre_existing_mass_source' as const, reason: outcome.reason })
      );
      continue;
    }

    accepted.push(
      Object.freeze({
        line_ref: lineRef,
        candidate_ref: candidateRef,
        fdc_id: fdcId,
        review_digest: reviewDigest,
        reason: 'deterministic_automatic' as const,
        choice: proposed,
        confirmation: selectionFromMatchChoice(proposed, lineRef),
      })
    );
  }

  const reconciliation: AiPlanReconciliation = Object.freeze({
    reconcile_version: AI_PLAN_RECONCILE_VERSION,
    request_id: application.request_id,
    classification: application,
    accepted: Object.freeze(accepted),
    offers: Object.freeze(offers),
    preserved: Object.freeze(preserved),
    conflicts: Object.freeze(conflicts),
    unchanged: Object.freeze(unchanged),
    accepted_count: accepted.length,
    offer_count: offers.length,
    preserved_count: preserved.length,
    conflict_count: conflicts.length,
    unchanged_count: unchanged.length,
  });

  return { ok: true, reconciliation };
}
