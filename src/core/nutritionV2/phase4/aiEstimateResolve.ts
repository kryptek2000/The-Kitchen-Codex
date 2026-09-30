/**
 * The Kitchen Codex — Advanced Nutrition: AI-3 pure bounded-estimate
 * reconciliation.
 *
 * PURE, offline, deterministic, platform-neutral. This module turns validated
 * per-line estimate evidence into INERT outcome buckets. It never dispatches a
 * reducer action, never mutates state, never persists, never touches the UI and
 * never performs I/O. The UI owns the reducer dispatch (the existing injection
 * pattern), exactly as AI-2C's bridge does.
 *
 * The guard order is deliberate and each guard is independently testable:
 *   0. line existence            -- a removed line is preserved, never recreated
 *   1. mid-flight fingerprint    -- a newer user/deterministic decision wins
 *   2. eligibility re-check      -- identity + stronger-source firewall
 *   3. snapshot binding          -- a changed semantic input makes it stale
 *   4. idempotency               -- an identical accepted estimate is `unchanged`
 */

import {
  aiEstimateSnapshotBinding,
  deterministicMidpointGrams,
  type AiEstimateAbstentionReason,
  type AiEstimateBoundedEvidence,
  type AiEstimateIneligibleReason,
  type AiEstimateParseFacts,
  type AiEstimateRejectionReason,
  type AiEstimateSnapshotInput,
  effectiveMassDecisionFor,
  evaluateAiEstimateEligibility,
} from './aiEstimateValidation';
import { workingChoiceFingerprint } from './aiMidFlight';
import { buildAiEstimateSelection, type AiEstimateSelectionEvidence } from './aiEstimateSelection';
import type { AiEstimateChoice, AiEstimateRangeEvidence, Phase4State } from './types';

/** One validated estimate awaiting reconciliation. */
export interface AiEstimateCandidate {
  readonly line_ref: string;
  readonly evidence: AiEstimateBoundedEvidence;
  /** Bound from the CURRENT authenticated match; never model-authored. */
  readonly fdc_id: number;
  readonly record_digest: string;
  readonly review_digest: string;
}

export type AiEstimateReconcileKind =
  /** The line may be offered to the user. Nothing is written. */
  | 'offer'
  /** A stronger or user-explicit mass source exists: the estimate LOSES. */
  | 'stronger_source'
  /** The user (or a stronger source) changed this line after the request. */
  | 'user_acted'
  /** The semantic inputs changed: the estimate is stale. */
  | 'stale'
  /** Deterministic pre-network abstention (no usable quantity / container). */
  | 'abstained'
  /** An identical estimate is already the working choice: a true no-op. */
  | 'unchanged'
  /** The line is gone; it is never recreated. */
  | 'missing';

export interface AiEstimateReconcileEntry {
  readonly line_ref: string;
  readonly kind: AiEstimateReconcileKind;
  readonly detail?: string;
  /** Present only for `offer`; the locally derived, bounded evidence. */
  readonly evidence?: AiEstimateBoundedEvidence;
  /** Present only for `unchanged`; the current working choice. */
  readonly current?: AiEstimateChoice;
}

export interface AiEstimateReconcileResult {
  readonly entries: ReadonlyArray<AiEstimateReconcileEntry>;
  readonly offer_count: number;
  readonly unchanged_count: number;
  readonly refused_count: number;
}

export interface AiEstimateReconcileInput {
  /** The state as it is NOW (re-read immediately before application). */
  readonly currentState: Phase4State;
  /** Fingerprints captured when the request started. */
  readonly capturedFingerprints: ReadonlyMap<string, string>;
  /** The deterministic parse facts, re-derived locally for each line. */
  readonly parses: ReadonlyMap<string, AiEstimateParseFacts>;
  /** The current line issue kinds (re-derived locally). */
  readonly issueKinds: Readonly<Record<string, string>>;
  /** The snapshot inputs used to bind each candidate. */
  readonly snapshots: ReadonlyMap<string, AiEstimateSnapshotInput>;
  readonly candidates: ReadonlyArray<AiEstimateCandidate>;
  readonly capabilityAvailable: boolean;
}

function sameEstimate(a: AiEstimateChoice, evidence: AiEstimateBoundedEvidence): boolean {
  return (
    a.lower_grams === evidence.lower_grams &&
    a.upper_grams === evidence.upper_grams &&
    a.representative_grams === evidence.representative_grams &&
    a.representative_policy === 'midpoint' &&
    a.provenance === 'ai_estimate'
  );
}

function abstainFor(parse: AiEstimateParseFacts | undefined): AiEstimateAbstentionReason | null {
  if (parse === undefined) return 'no_usable_quantity';
  if (parse.container !== null && parse.container !== undefined) return 'parsed_container';
  const range = parse.quantityRange;
  const hasQuantity =
    parse.hasDirectMass ||
    (typeof parse.amount === 'number' && Number.isFinite(parse.amount) && parse.amount > 0) ||
    (range !== null &&
      range !== undefined &&
      Number.isFinite(range.lower) &&
      Number.isFinite(range.upper) &&
      range.lower > 0 &&
      range.upper >= range.lower);
  return hasQuantity ? null : 'no_usable_quantity';
}

/**
 * Reconciles validated estimate candidates against the CURRENT state.
 *
 * Every refusal is per-line: a stale or conflicted line never aborts the rest
 * of the response, and an identical estimate is a true no-op (no operation
 * sequence bump is implied by this module at all -- it dispatches nothing).
 */
export function reconcileAiBoundedEstimates(
  input: AiEstimateReconcileInput
): AiEstimateReconcileResult {
  const entries: AiEstimateReconcileEntry[] = [];

  for (const candidate of input.candidates) {
    const lineRef = candidate.line_ref;
    const parse = input.parses.get(lineRef);
    const snapshot = input.snapshots.get(lineRef);
    if (snapshot === undefined) {
      entries.push({ line_ref: lineRef, kind: 'stale', detail: 'no_snapshot' });
      continue;
    }

    // 0. Line existence: a removed line is preserved, never recreated.
    if (!input.currentState.rows.some((row) => row.line_ref === lineRef)) {
      entries.push({ line_ref: lineRef, kind: 'missing' });
      continue;
    }

    // 1. Mid-flight user/deterministic authority. A changed working-choice
    //    fingerprint (or a line with NO capture) means the stale AI result
    //    must not overwrite the user's newer decision.
    const captured = input.capturedFingerprints.get(lineRef);
    if (captured === undefined) {
      entries.push({ line_ref: lineRef, kind: 'user_acted', detail: 'no_capture' });
      continue;
    }
    if (workingChoiceFingerprint(input.currentState, lineRef) !== captured) {
      entries.push({ line_ref: lineRef, kind: 'user_acted' });
      continue;
    }

    // 2. Eligibility re-check: the line must still be a CURRENT actionable
    //    amount exception, the identity must still be authenticated, authored
    //    mass must still be absent, and the stronger-source firewall must hold.
    const eligibility = evaluateAiEstimateEligibility({
      state: input.currentState,
      lineRef,
      parse: parse ?? { hasDirectMass: false, amount: null, quantityRange: null, container: null },
      // The AUTHORITATIVE current live-row status, supplied by the caller from
      // the live projection. A missing entry fails CLOSED: an unknown row is
      // never assumed actionable.
      rowStatus: input.issueKinds[lineRef] ?? 'unknown',
      capabilityAvailable: input.capabilityAvailable,
    });
    if (eligibility.eligible !== true) {
      if (eligibility.reason === 'direct_mass_authority') {
        entries.push({ line_ref: lineRef, kind: 'abstained', detail: 'direct_mass_authority' });
        continue;
      }
      if (eligibility.reason === 'not_actionable') {
        entries.push({ line_ref: lineRef, kind: 'abstained', detail: 'not_actionable' });
        continue;
      }
      if (eligibility.reason === 'stronger_mass_source') {
        entries.push({ line_ref: lineRef, kind: 'stronger_source' });
        continue;
      }
      if (eligibility.reason === 'no_usable_quantity' || eligibility.reason === 'parsed_container') {
        const abstention = abstainFor(parse);
        entries.push({
          line_ref: lineRef,
          kind: 'abstained',
          detail: (abstention ?? 'no_usable_quantity') as string,
        });
        continue;
      }
      entries.push({
        line_ref: lineRef,
        kind: 'abstained',
        detail: eligibility.reason satisfies AiEstimateIneligibleReason,
      });
      continue;
    }

    // 3. Snapshot binding: the estimate must still be bound to the exact
    //    semantic inputs it was derived from.
    const currentBinding = aiEstimateSnapshotBinding(snapshot);
    const existing = input.currentState.aiEstimates?.[lineRef];

    // 4. Idempotency first (an identical accepted estimate is a true no-op),
    //    then staleness of any OTHER existing estimate.
    if (existing !== undefined) {
      if (sameEstimate(existing, candidate.evidence)) {
        entries.push({ line_ref: lineRef, kind: 'unchanged', current: existing });
        continue;
      }
      entries.push({ line_ref: lineRef, kind: 'stale', detail: 'estimate_changed' });
      continue;
    }

    // The candidate must still match the CURRENT identity binding.
    const currentMatch = input.currentState.matches?.[lineRef];
    if (
      currentMatch === undefined ||
      currentMatch.fdc_id !== candidate.fdc_id ||
      currentMatch.review_digest !== candidate.review_digest
    ) {
      entries.push({ line_ref: lineRef, kind: 'stale', detail: 'identity_changed' });
      continue;
    }

    entries.push({ line_ref: lineRef, kind: 'offer', evidence: candidate.evidence });
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    offer_count: entries.filter((e) => e.kind === 'offer').length,
    unchanged_count: entries.filter((e) => e.kind === 'unchanged').length,
    refused_count: entries.filter((e) => e.kind !== 'offer' && e.kind !== 'unchanged').length,
  });
}

/**
 * Builds the working choice a user acceptance produces. The model never
 * authors the identity, the digests, the snapshot binding or the calculation
 * grams: all of those are bound or derived locally.
 */
export function buildAiEstimateChoice(
  candidate: AiEstimateCandidate,
  snapshot: AiEstimateSnapshotInput,
  /**
   * The authenticated dry-run evidence for this line. It is REQUIRED: without
   * it there is no Phase 3 selection, and an accepted estimate must never
   * reach the calculator unbound.
   */
  evidence: AiEstimateSelectionEvidence
): AiEstimateChoice | null {
  const range: AiEstimateRangeEvidence = {
    lower_grams: candidate.evidence.lower_grams,
    upper_grams: candidate.evidence.upper_grams,
    // Re-derived locally, never taken from the model.
    representative_grams: deterministicMidpointGrams(
      candidate.evidence.lower_grams,
      candidate.evidence.upper_grams
    ),
    representative_policy: 'midpoint',
    provenance: 'ai_estimate',
  };
  const built = buildAiEstimateSelection(evidence.line_ref, evidence, {
    ...range,
    fdc_id: candidate.fdc_id,
    record_digest: candidate.record_digest,
    review_digest: candidate.review_digest,
    snapshot_binding: aiEstimateSnapshotBinding(snapshot),
  } as AiEstimateChoice);
  if (built.ok !== true) return null;
  return Object.freeze({
    ...range,
    fdc_id: candidate.fdc_id,
    record_digest: candidate.record_digest,
    review_digest: candidate.review_digest,
    snapshot_binding: aiEstimateSnapshotBinding(snapshot),
    selection: built.selection,
  });
}

export type { AiEstimateRejectionReason };
