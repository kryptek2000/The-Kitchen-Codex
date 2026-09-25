/**
 * The Kitchen Codex — unified AI exception eligibility + live status summary.
 *
 * Proves the single live-status authority: eligibility for AI help is derived
 * from the SAME current live rows that render the ingredient list, for ANY
 * actionable exception (needs match, review suggested, needs amount), and the
 * summary counts exactly match the rendered statuses.
 */

import { describe, it, expect } from 'vitest';
import {
  actionableExceptionRows,
  liveExceptionKind,
  summarizeLiveRows,
  type LiveRowState,
  type LiveRowStatus,
  type Phase4Row,
} from '../../src/core/nutritionV2/phase4';

function live(lineRef: string, status: LiveRowStatus): LiveRowState {
  return Object.freeze({
    line_ref: lineRef,
    original_text: `line ${lineRef}`,
    status,
    food_authority: 'none',
    selected_fdc_id: undefined,
    selected_description: undefined,
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
}

function row(lineRef: string): Phase4Row {
  return Object.freeze({
    line_ref: lineRef,
    original_text: `line ${lineRef}`,
    outcome: 'review_required',
    query: `line ${lineRef}`,
    candidates: Object.freeze([]),
    review_digest: 'a'.repeat(64),
    selected_fdc_id: undefined,
    review: undefined,
    note: undefined,
  });
}

function rowsFor(liveRows: ReadonlyArray<LiveRowState>): ReadonlyArray<Phase4Row> {
  return Object.freeze(liveRows.map((entry) => row(entry.line_ref)));
}

describe('live status summary — single authority', () => {
  it('counts every status from the live rows exactly', () => {
    const liveRows = [
      live('a', 'matched'),
      live('b', 'matched'),
      live('c', 'review_suggested'),
      live('d', 'needs_amount'),
      live('e', 'needs_amount'),
      live('f', 'needs_match'),
      live('g', 'qualitative'),
    ];
    const summary = summarizeLiveRows(liveRows);
    expect(summary).toEqual({
      total: 7,
      matched: 2,
      review_suggested: 1,
      needs_amount: 2,
      needs_match: 1,
      qualitative: 1,
      actionable: 4,
    });
  });

  it('is a pure function of the current rows (no stale counters)', () => {
    const before = summarizeLiveRows([live('a', 'needs_amount'), live('b', 'matched')]);
    expect(before.actionable).toBe(1);
    const after = summarizeLiveRows([live('a', 'matched'), live('b', 'matched')]);
    expect(after.actionable).toBe(0);
    expect(summarizeLiveRows([]).actionable).toBe(0);
  });
});

describe('unified actionable-exception eligibility', () => {
  it('AI is available with needs_match only', () => {
    const liveRows = [live('a', 'needs_match')];
    expect(actionableExceptionRows(rowsFor(liveRows), liveRows).map((r) => r.line_ref)).toEqual(['a']);
    expect(liveExceptionKind('needs_match')).toBe('needs_match');
  });

  it('AI is available with needs_amount only (zero needs match)', () => {
    const liveRows = [live('a', 'needs_amount')];
    const summary = summarizeLiveRows(liveRows);
    expect(summary.needs_match).toBe(0);
    expect(summary.actionable).toBe(1);
    expect(actionableExceptionRows(rowsFor(liveRows), liveRows).map((r) => r.line_ref)).toEqual(['a']);
    expect(liveExceptionKind('needs_amount')).toBe('needs_amount');
  });

  it('AI is available with review_suggested only (zero needs match)', () => {
    const liveRows = [live('a', 'review_suggested')];
    const summary = summarizeLiveRows(liveRows);
    expect(summary.needs_match).toBe(0);
    expect(summary.actionable).toBe(1);
    expect(actionableExceptionRows(rowsFor(liveRows), liveRows).map((r) => r.line_ref)).toEqual(['a']);
    expect(liveExceptionKind('review_suggested')).toBe('review_suggested');
  });

  it('AI is available for mixed exceptions and never includes resolved rows', () => {
    const liveRows = [
      live('a', 'needs_match'),
      live('b', 'review_suggested'),
      live('c', 'needs_amount'),
      live('d', 'matched'),
      live('e', 'qualitative'),
    ];
    const eligible = actionableExceptionRows(rowsFor(liveRows), liveRows);
    expect(eligible.map((r) => r.line_ref)).toEqual(['a', 'b', 'c']);
  });

  it('AI is unavailable when every row is matched or qualitative', () => {
    const liveRows = [live('a', 'matched'), live('b', 'qualitative'), live('c', 'matched')];
    expect(summarizeLiveRows(liveRows).actionable).toBe(0);
    expect(actionableExceptionRows(rowsFor(liveRows), liveRows)).toEqual([]);
    expect(liveExceptionKind('matched')).toBeUndefined();
    expect(liveExceptionKind('qualitative')).toBeUndefined();
  });
});
