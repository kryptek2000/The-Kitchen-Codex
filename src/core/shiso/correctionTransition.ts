/**
 * The Kitchen Codex — SHISO H-2N nutrition-correction STATE TRUTH (core).
 *
 * PURE, OFFLINE, deterministic. Given the AUTHORITATIVE before/after live-row
 * projections of one correction operation, this module answers the only
 * questions that make reporting truthful:
 *
 *   - which corrections ACTUALLY ended resolved (verified applied);
 *   - which corrections did NOT (failed — never to be reported as applied);
 *   - which previously resolved lines REGRESSED (a correction must never break
 *     an already-matched ingredient);
 *   - what exactly changed, line by line.
 *
 * WHY THIS EXISTS (the human-test failure): SHISO reported "corrections applied"
 * while the post-operation review was unchanged and a matched line had fallen
 * back to "needs match". A tool executing is NOT evidence of a correction; only
 * the post-operation authoritative state is. The application now derives every
 * reported number from these two projections and refuses a transition that
 * would regress a previously resolved line.
 */

import { summarizeLiveRows } from '../nutritionV2/phase4';
import type { LiveRowState } from '../nutritionV2/phase4/liveRow';

/** One line-level change between the before and after projections. */
export interface ShisoCorrectionLineChange {
  readonly line_ref: string;
  readonly label: string;
  readonly before_status: string;
  readonly after_status: string;
  readonly before_grams: number | null;
  readonly after_grams: number | null;
  readonly change: string;
}

/** A transition that must NOT be applied (regression or unverified change). */
export interface ShisoCorrectionRefusal {
  readonly line_ref: string;
  readonly label: string;
  readonly reason: string;
}

export interface ShisoCorrectionTransition {
  readonly before: {
    readonly total: number;
    readonly resolved: number;
    readonly needs_amount: number;
    readonly needs_match: number;
    readonly review_suggested: number;
    readonly qualitative: number;
  };
  readonly after: ShisoCorrectionTransition['before'];
  /** Corrections whose line ENDED resolved with a real mass. */
  readonly verified: readonly {
    readonly line_ref: string;
    readonly label: string;
    readonly description: string;
    readonly after_grams: number;
  }[];
  /** Corrections whose line did NOT end resolved. Never reported as applied. */
  readonly failed: readonly ShisoCorrectionRefusal[];
  /** Previously resolved lines that would become actionable. */
  readonly regressed: readonly ShisoCorrectionLineChange[];
  /** Every line whose status or mass changed. */
  readonly changes: readonly ShisoCorrectionLineChange[];
}

function resolved(row: LiveRowState): boolean {
  return row.status === 'matched' || row.status === 'qualitative';
}

function summaryOf(rows: readonly LiveRowState[]): ShisoCorrectionTransition['before'] {
  const summary = summarizeLiveRows(rows);
  return Object.freeze({
    total: summary.total,
    resolved: summary.matched + summary.qualitative,
    needs_amount: summary.needs_amount,
    needs_match: summary.needs_match,
    review_suggested: summary.review_suggested,
    qualitative: summary.qualitative,
  });
}

function describeChange(before: LiveRowState, after: LiveRowState): string {
  const grams = (value: number | undefined): string =>
    typeof value === 'number' && value > 0 ? ` (${Math.round(value * 10) / 10} g)` : '';
  if (before.status === after.status && before.resolved_grams === after.resolved_grams) {
    return 'unchanged';
  }
  return `${before.status}${grams(before.resolved_grams)} → ${after.status}${grams(after.resolved_grams)}`;
}

/**
 * Evaluates ONE correction transition. The caller supplies the corrections it
 * attempted (built by the deterministic builder) and the two genuine
 * projections; this function holds no authority and changes nothing.
 */
export function evaluateCorrectionTransition(input: {
  readonly before: readonly LiveRowState[];
  readonly after: readonly LiveRowState[];
  readonly corrections: ReadonlyArray<{
    readonly line_ref: string;
    readonly label: string;
    readonly description: string;
  }>;
}): ShisoCorrectionTransition {
  const beforeByRef = new Map(input.before.map((row) => [row.line_ref, row]));
  const afterByRef = new Map(input.after.map((row) => [row.line_ref, row]));

  const changes: ShisoCorrectionLineChange[] = [];
  const regressed: ShisoCorrectionLineChange[] = [];
  for (const [lineRef, beforeRow] of beforeByRef) {
    const afterRow = afterByRef.get(lineRef);
    if (afterRow === undefined) continue;
    const changed =
      beforeRow.status !== afterRow.status ||
      beforeRow.resolved_grams !== afterRow.resolved_grams ||
      beforeRow.selected_fdc_id !== afterRow.selected_fdc_id;
    if (!changed) continue;
    const change = Object.freeze({
      line_ref: lineRef,
      label: afterRow.original_text.slice(0, 120),
      before_status: beforeRow.status,
      after_status: afterRow.status,
      before_grams: beforeRow.resolved_grams ?? null,
      after_grams: afterRow.resolved_grams ?? null,
      change: describeChange(beforeRow, afterRow),
    });
    changes.push(change);
    if (resolved(beforeRow) && !resolved(afterRow)) regressed.push(change);
  }

  const verified: Array<{
    line_ref: string;
    label: string;
    description: string;
    after_grams: number;
  }> = [];
  const failed: ShisoCorrectionRefusal[] = [];
  for (const correction of input.corrections) {
    const afterRow = afterByRef.get(correction.line_ref);
    const afterGrams = afterRow?.resolved_grams;
    if (
      afterRow !== undefined &&
      afterRow.status === 'matched' &&
      typeof afterGrams === 'number' &&
      afterGrams > 0
    ) {
      verified.push(
        Object.freeze({
          line_ref: correction.line_ref,
          label: correction.label,
          description: correction.description,
          after_grams: afterGrams,
        }),
      );
      continue;
    }
    failed.push(
      Object.freeze({
        line_ref: correction.line_ref,
        label: correction.label,
        reason:
          afterRow === undefined
            ? 'That ingredient is no longer part of the review.'
            : afterRow.status === 'needs_amount'
              ? 'The correction did not produce a usable mass.'
              : afterRow.status === 'needs_match'
                ? 'The correction did not produce a usable food match.'
                : afterRow.status === 'review_suggested'
                  ? 'The correction left the ingredient awaiting review.'
                  : 'The correction did not resolve the ingredient.',
      }),
    );
  }

  return Object.freeze({
    before: summaryOf(input.before),
    after: summaryOf(input.after),
    verified: Object.freeze(verified),
    failed: Object.freeze(failed),
    regressed: Object.freeze(regressed),
    changes: Object.freeze(changes),
  });
}

export type ShisoCorrectionDispatchDecision =
  | { readonly ok: true; readonly transition: ShisoCorrectionTransition }
  | {
      readonly ok: false;
      readonly reason: 'regression' | 'unverified' | 'stale';
      readonly regressed: readonly ShisoCorrectionLineChange[];
      readonly failed: readonly ShisoCorrectionRefusal[];
    };

/**
 * The dispatch gate. A correction operation is applied ONLY when every
 * attempted correction verifies in the post projection AND no previously
 * resolved line regresses. Anything else is refused WHOLE, leaving the working
 * review exactly as it was — truthful, and never worse than before.
 */
export function decideCorrectionDispatch(
  transition: ShisoCorrectionTransition,
): ShisoCorrectionDispatchDecision {
  if (transition.regressed.length > 0) {
    return {
      ok: false,
      reason: 'regression',
      regressed: transition.regressed,
      failed: transition.failed,
    };
  }
  if (transition.failed.length > 0) {
    return {
      ok: false,
      reason: 'unverified',
      regressed: transition.regressed,
      failed: transition.failed,
    };
  }
  return { ok: true, transition };
}
