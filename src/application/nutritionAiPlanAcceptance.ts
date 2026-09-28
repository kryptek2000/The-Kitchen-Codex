/**
 * The Kitchen Codex — application-layer AI-2C acceptance orchestration.
 *
 * Orchestrates the deterministic bridge from a canonical AI-2B plan back into
 * the existing working review state, WITHOUT creating a parallel authority:
 *
 *   capability gate (existing)
 *     -> AI-2B `requestAiAdvancedCandidatePlan` (existing transport owner)
 *     -> Phase-4 `reconcileAiAdvancedCandidatePlan` (pure; classification +
 *        eligibility + mid-flight + working-state protection)
 *     -> genuine-session confirmation per accepted line (existing Phase-2
 *        `confirmIngredientReview`, reached only through the module-private
 *        Phase-4 session authority)
 *     -> inert accepted / unconfirmed / offer / preserved / conflict buckets
 *
 * WHAT THIS MODULE MAY NEVER DO
 * -----------------------------
 *   - persist anything, call Phase 5, write recipe Markdown or touch a vault;
 *   - dispatch a reducer action (the caller owns the working-state transition);
 *   - read raw provider output (it consumes the SANITIZED AI-2B payload only);
 *   - invent an FDC id, food identity, portion, gram, nutrient, density or
 *     serving weight;
 *   - overwrite or clear a user/working decision, or spend any authority the
 *     deterministic contract did not already grant.
 *
 * FAILURE VOCABULARY IS REUSED, NEVER EXTENDED: `unavailable` (capability),
 * `stale_request` (superseded request/recipe/session), `provider_error` and
 * `invalid_response` (from the existing requester). Per-line user conflicts stay
 * INTERNAL reconciliation results; per-line confirmation failures reuse the
 * existing Phase-2 confirmation codes.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import {
  AI_PLAN_INVALID_MESSAGE,
  AI_PLAN_STALE_MESSAGE,
  AI_PLAN_UNAVAILABLE_MESSAGE,
  isAiCandidatePlanAvailable,
  requestAiAdvancedCandidatePlan,
} from './nutritionAiPlan';
import { confirmAdvancedNutritionMatch } from '../core/nutritionV2/phase4/session';
import { deterministicAcceptanceView } from '../core/nutritionV2/phase4/deterministicAcceptanceView';
import {
  reconcileAiAdvancedCandidatePlan,
  type AiPlanReconcileConflict,
  type AiPlanReconciledOffer,
  type AiPlanReconciledPreserved,
  type AiPlanReconcileResult,
} from '../core/nutritionV2/phase4/aiPlanReconcile';
import type { AiAdvancedPlanRequestContext } from '../core/nutritionV2/aiAdvancedPlanRequest';
import type { NutritionCapabilities } from '../core/nutritionV2/nutritionCapabilities';
import type { MatchChoice } from '../core/nutritionV2/phase4/types';

export const AI_PLAN_ACCEPTANCE_VERSION = 'nutrition_ai_advanced_plan_acceptance_v1';

/** One accepted line that ALSO passed genuine-session confirmation. */
export interface AiPlanAcceptedLine {
  readonly line_ref: string;
  readonly candidate_ref: string;
  readonly fdc_id: number;
  readonly review_digest: string;
  /** Working-state descriptor for the caller's existing match transition. */
  readonly choice: MatchChoice;
}

/** One accepted line that the genuine session refused: NOT dispatched. */
export interface AiPlanUnconfirmedLine {
  readonly line_ref: string;
  /** An EXISTING Phase-2 confirmation code (never a new vocabulary). */
  readonly reason: string;
}

export interface AiPlanAcceptanceOutcome {
  readonly acceptance_version: typeof AI_PLAN_ACCEPTANCE_VERSION;
  readonly request_id: string;
  readonly accepted: ReadonlyArray<AiPlanAcceptedLine>;
  readonly unconfirmed: ReadonlyArray<AiPlanUnconfirmedLine>;
  readonly offers: ReadonlyArray<AiPlanReconciledOffer>;
  readonly preserved: ReadonlyArray<AiPlanReconciledPreserved>;
  readonly conflicts: ReadonlyArray<AiPlanReconcileConflict>;
  readonly unchanged: ReadonlyArray<string>;
  readonly accepted_count: number;
  readonly unconfirmed_count: number;
  readonly offer_count: number;
  readonly preserved_count: number;
  readonly conflict_count: number;
  readonly unchanged_count: number;
  /** AI-2A classification totals (automatic | offer | review). */
  readonly classified_automatic: number;
  readonly classified_offer: number;
  readonly classified_review: number;
  readonly aiAttempted: true;
}

export type AiPlanAcceptanceFailureCode =
  | 'unavailable'
  | 'provider_error'
  | 'stale_request'
  | 'invalid_response';

export type AiPlanAcceptanceResult =
  | { readonly ok: true; readonly outcome: AiPlanAcceptanceOutcome }
  | {
      readonly ok: false;
      readonly code: AiPlanAcceptanceFailureCode;
      readonly message: string;
      readonly aiAttempted: boolean;
    };

export interface AiPlanAcceptanceArgs {
  /** The genuine Phase-4 session RECEIVER (authority is resolved privately). */
  readonly session: unknown;
  readonly network: NetworkAdapter;
  readonly capabilities: NutritionCapabilities;
  /**
   * The AI-2A request context the caller built from the CURRENT reviews (the
   * exact same construction AI-2B uses). This module never re-derives identity.
   */
  readonly context: AiAdvancedPlanRequestContext;
  /** Planning targets for the plan request (required by the AI-2B contract). */
  readonly targets?: unknown;
  readonly targetBindings?: unknown;
  /** The CURRENT deterministic reviews, keyed by line ref. */
  readonly reviews: unknown;
  readonly issueKinds?: unknown;
  readonly interpretationFingerprints?: unknown;
  /** Line refs that exist NOW (a removed line is never recreated). */
  readonly currentLineRefs?: unknown;
  /** Current working state (read-only inputs to the eligibility rules). */
  readonly workingState?: {
    readonly matches?: unknown;
    readonly portions?: unknown;
    readonly countPortions?: unknown;
    readonly userMasses?: unknown;
    readonly householdPortions?: unknown;
  };
  /** Snapshot captured when the request STARTED (mid-flight user authority). */
  readonly captured?: {
    readonly fingerprints?: unknown;
    readonly matches?: unknown;
    readonly massSourceLineRefs?: unknown;
  };
  /** Working-choice fingerprints read NOW. */
  readonly currentFingerprints?: unknown;
  /**
   * Request/recipe/session currency check, evaluated AFTER the response and
   * BEFORE any confirmation. A superseded request yields `stale_request`.
   */
  readonly isCurrent?: () => boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function failure(
  code: AiPlanAcceptanceFailureCode,
  message: string,
  aiAttempted: boolean
): AiPlanAcceptanceResult {
  return { ok: false, code, message, aiAttempted };
}

/**
 * Requests ONE live AI-2B plan and reconciles it into inert, confirmed
 * deterministic acceptances. Never throws; never mutates; never persists.
 */
export async function requestAndReconcileAiAdvancedPlan(
  args: AiPlanAcceptanceArgs
): Promise<AiPlanAcceptanceResult> {
  // (1) CAPABILITY GATE — the SAME Advanced candidate-orchestration capability
  // AI-2B uses (no new flag). No capability means no network at all.
  if (!isAiCandidatePlanAvailable(args.capabilities)) {
    return failure('unavailable', AI_PLAN_UNAVAILABLE_MESSAGE, false);
  }

  const context = asRecord(args.context);
  if (context === undefined || typeof context['request_id'] !== 'string' || context['request_id'].length === 0) {
    // An unidentifiable request context cannot be bound to a response: reuse the
    // existing stale-request semantics rather than inventing a code.
    return failure('stale_request', AI_PLAN_STALE_MESSAGE, false);
  }
  const requestId = context['request_id'] as string;

  // (2) AI-2B TRANSPORT (existing owner: capability gate, target coverage,
  // closure checks, canonical sanitization).
  const requested = await requestAiAdvancedCandidatePlan({
    context: args.context,
    network: args.network,
    capabilities: args.capabilities,
    ...(args.targets !== undefined ? { targets: args.targets as never } : {}),
    ...(args.targetBindings !== undefined ? { targetBindings: args.targetBindings as never } : {}),
  });
  if (requested.ok !== true) {
    return failure(requested.code, requested.message, requested.aiAttempted);
  }

  // (3) REQUEST/RECIPE/SESSION CURRENCY — a superseded request is discarded
  // whole, before any confirmation or state work.
  if (args.isCurrent !== undefined && args.isCurrent() !== true) {
    return failure('stale_request', AI_PLAN_STALE_MESSAGE, true);
  }

  // (4) PURE RECONCILIATION against the CURRENT deterministic authority.
  const reconciled: AiPlanReconcileResult = reconcileAiAdvancedCandidatePlan({
    plan: requested.plan,
    responseRequestId: requested.requestId,
    requestContext: args.context,
    reviews: args.reviews,
    // The Phase-4 boundary port: this application module never imports Phase 2.
    deterministicAcceptance: deterministicAcceptanceView,
    ...(args.issueKinds !== undefined ? { issueKinds: args.issueKinds } : {}),
    ...(args.interpretationFingerprints !== undefined
      ? { interpretationFingerprints: args.interpretationFingerprints }
      : {}),
    ...(args.currentLineRefs !== undefined ? { currentLineRefs: args.currentLineRefs } : {}),
    ...(args.workingState !== undefined ? { workingState: args.workingState } : {}),
    ...(args.captured !== undefined ? { captured: args.captured } : {}),
    ...(args.currentFingerprints !== undefined ? { currentFingerprints: args.currentFingerprints } : {}),
  });
  if (reconciled.ok !== true) {
    return failure('invalid_response', AI_PLAN_INVALID_MESSAGE, true);
  }
  const reconciliation = reconciled.reconciliation;

  // (5) GENUINE-SESSION CONFIRMATION, per accepted line, against the CURRENT
  // review. An opaque ref resolved locally is NOT enough: only the existing
  // Phase-2 confirmation through genuine Phase-4 session authority may promote a
  // line into working state.
  const reviews = asLineMap(args.reviews);
  const accepted: AiPlanAcceptedLine[] = [];
  const unconfirmed: AiPlanUnconfirmedLine[] = [];

  for (const entry of reconciliation.accepted) {
    const review = reviews?.get(entry.line_ref);
    if (review === undefined) {
      unconfirmed.push(Object.freeze({ line_ref: entry.line_ref, reason: 'stale_review' }));
      continue;
    }
    const confirmation = confirmAdvancedNutritionMatch(args.session, review, entry.confirmation);
    if (confirmation.outcome !== 'confirmed') {
      const reason =
        confirmation.outcome === 'invalid'
          ? (confirmation as { failure?: { code?: string } }).failure?.code ?? 'invalid_review'
          : 'not_reviewable';
      unconfirmed.push(Object.freeze({ line_ref: entry.line_ref, reason }));
      continue;
    }
    const confirmedId = (confirmation as { fdc_id?: unknown }).fdc_id;
    if (confirmedId !== entry.fdc_id) {
      unconfirmed.push(Object.freeze({ line_ref: entry.line_ref, reason: 'candidate_not_in_review_set' }));
      continue;
    }
    accepted.push(
      Object.freeze({
        line_ref: entry.line_ref,
        candidate_ref: entry.candidate_ref,
        fdc_id: entry.fdc_id,
        review_digest: entry.review_digest,
        choice: entry.choice,
      })
    );
  }

  const outcome: AiPlanAcceptanceOutcome = Object.freeze({
    acceptance_version: AI_PLAN_ACCEPTANCE_VERSION,
    request_id: requestId,
    accepted: Object.freeze(accepted),
    unconfirmed: Object.freeze(unconfirmed),
    offers: reconciliation.offers,
    preserved: reconciliation.preserved,
    conflicts: reconciliation.conflicts,
    unchanged: reconciliation.unchanged,
    accepted_count: accepted.length,
    unconfirmed_count: unconfirmed.length,
    offer_count: reconciliation.offer_count,
    preserved_count: reconciliation.preserved_count,
    conflict_count: reconciliation.conflict_count,
    unchanged_count: reconciliation.unchanged_count,
    classified_automatic: reconciliation.classification.automatic_count,
    classified_offer: reconciliation.classification.offer_count,
    classified_review: reconciliation.classification.review_count,
    aiAttempted: true,
  });

  return { ok: true, outcome };
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
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const [key, entry] of Object.entries(record)) out.set(key, entry);
  return out;
}
