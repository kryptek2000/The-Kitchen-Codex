/**
 * The Kitchen Codex — Application Timer Engine (Timer Reliability phase).
 *
 * A PURE, platform-neutral home for all timer state math. There is ONE timer
 * engine: timers started from Recipe Detail, Cooking Mode, and the custom/global
 * timer UI all live in `App.activeTimers`; this module owns the calculation only.
 *
 * Wall-clock correctness: a RUNNING timer carries an absolute `endsAt` (epoch
 * ms). Remaining time is derived from `endsAt - now` (clamped >= 0), never just
 * decremented by one per tick — so browser throttling, suspended tabs, laptop
 * sleep, and time while the app is closed are all accounted for. Paused timers
 * are frozen (no endsAt).
 *
 * NO: window, document, React, setInterval, localStorage, SettingsAdapter, or
 * browser APIs. The App/bootstrap edge owns the interval and Date.now.
 */

import type { ActiveTimer } from '../types';

function safeNum(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampSeconds(value: number): number {
  return Math.max(0, Math.floor(value));
}

/** A stable semantic key tying a timer to a surface (e.g. a Cooking Mode step). */
export function stepTimerKey(recipeId: string, stepNumber: number): string {
  return `${recipeId}::step:${stepNumber}`;
}

/**
 * Creates a fresh RUNNING timer of `totalSeconds`. `endsAt` is set so the
 * countdown is wall-clock correct from the start.
 */
export function createTimer(
  input: {
    id: string;
    recipeTitle: string;
    label: string;
    totalSeconds: number;
    createdAt?: number;
    semanticKey?: string;
  },
  now: number
): ActiveTimer {
  const total = clampSeconds(safeNum(input.totalSeconds, 0));
  const createdAt = safeNum(input.createdAt, now);
  return {
    id: input.id,
    recipeTitle: input.recipeTitle,
    label: input.label,
    totalSeconds: total,
    remainingSeconds: total,
    isRunning: true,
    createdAt,
    endsAt: now + Math.max(0, total) * 1000,
    semanticKey: input.semanticKey,
  };
}

/**
 * Reconciles a single timer against the current wall-clock time.
 * - Running + endsAt: remaining = max(0, ceil((endsAt - now)/1000)); marks the
 *   timer completed (isRunning=false) when it reaches 0.
 * - Paused: unchanged (frozen).
 * - Running + no endsAt (should only be legacy): falls back to a safe decrement
 *   so it never goes negative and never crashes.
 * `justCompleted` is true only on the single tick where this timer crosses to 0.
 */
export function reconcileTimer(timer: ActiveTimer, now: number): { timer: ActiveTimer; justCompleted: boolean } {
  if (!timer.isRunning) {
    return { timer: { ...timer, remainingSeconds: clampSeconds(safeNum(timer.remainingSeconds, 0)) }, justCompleted: false };
  }

  if (typeof timer.endsAt === 'number' && Number.isFinite(timer.endsAt)) {
    const remaining = Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
    const justCompleted = timer.remainingSeconds > 0 && remaining <= 0;
    return {
      timer: { ...timer, remainingSeconds: remaining, isRunning: remaining <= 0 ? false : true },
      justCompleted,
    };
  }

  // Legacy running timer with no endsAt: conservative decrement (never negative).
  const prev = clampSeconds(safeNum(timer.remainingSeconds, 0));
  const next = Math.max(0, prev - 1);
  const justCompleted = prev > 0 && next <= 0;
  return { timer: { ...timer, remainingSeconds: next, isRunning: next <= 0 ? false : true }, justCompleted };
}

/** Reconciles a list of timers; returns the updated list and a completion count. */
export function reconcileTimers(timers: ActiveTimer[], now: number): { timers: ActiveTimer[]; completed: number } {
  let completed = 0;
  const updated = timers.map((t) => {
    const r = reconcileTimer(t, now);
    if (r.justCompleted) completed += 1;
    return r.timer;
  });
  return { timers: updated, completed };
}

/** Pauses a timer at the current elapsed time (remaining frozen, endsAt cleared). */
export function pauseTimer(timer: ActiveTimer, now: number): ActiveTimer {
  const reconciled = reconcileTimer(timer, now).timer;
  return { ...reconciled, isRunning: false, endsAt: undefined };
}

/** Resumes a paused timer from its frozen remaining seconds (fresh endsAt). */
export function resumeTimer(timer: ActiveTimer, now: number): ActiveTimer {
  const remaining = clampSeconds(safeNum(timer.remainingSeconds, 0));
  return { ...timer, isRunning: true, endsAt: now + remaining * 1000 };
}

/**
 * Normalizes/migrates a persisted timer.
 * - A RUNNING legacy timer without `endsAt` is upgraded (endsAt = now + remaining),
 *   preserving `remainingSeconds` exactly (time spent closed before the upgrade
 *   cannot be reconstructed, which is acceptable).
 * - A PAUSED timer stays frozen.
 * - Malformed fields are normalized safely (never throws), and a stale non-numeric
 *   endsAt is dropped (treated as legacy).
 */
export function migrateLegacyTimer(timer: ActiveTimer, now: number): ActiveTimer {
  const totalSeconds = clampSeconds(safeNum(timer.totalSeconds, 0));
  const remainingSeconds = clampSeconds(safeNum(timer.remainingSeconds, 0));
  const isRunning = Boolean(timer.isRunning);
  // Drop a malformed endsAt so it is treated as legacy.
  const endsAt =
    typeof timer.endsAt === 'number' && Number.isFinite(timer.endsAt) ? timer.endsAt : undefined;

  const base: ActiveTimer = { ...timer, totalSeconds, remainingSeconds, isRunning, endsAt };

  if (base.isRunning && typeof base.endsAt !== 'number') {
    if (base.remainingSeconds > 0) {
      return { ...base, endsAt: now + remainingSeconds * 1000 };
    }
    return { ...base, isRunning: false, remainingSeconds: 0 };
  }
  if (!base.isRunning) {
    return { ...base, endsAt: undefined };
  }
  return base;
}

/**
 * Upserts a timer into the list. When a non-empty `semanticKey` is provided and
 * a timer with the same key exists, it is REPLACED in place (restart/replace
 * semantics, preserving its id so React keys stay stable); otherwise the new
 * timer is PREPENDED. This is the single duplicate-timer policy.
 */
export function upsertTimer(timers: ActiveTimer[], newTimer: ActiveTimer, semanticKey?: string): ActiveTimer[] {
  if (semanticKey) {
    const existing = timers.find((t) => t.semanticKey === semanticKey);
    if (existing) {
      return timers.map((t) => (t.semanticKey === semanticKey ? { ...newTimer, id: t.id } : t));
    }
  }
  return [newTimer, ...timers];
}

/** Finds the timer matching a semantic key (used for inline Cooking Mode display). */
export function findTimerByKey(timers: ActiveTimer[], semanticKey: string): ActiveTimer | undefined {
  return timers.find((t) => t.semanticKey === semanticKey);
}
