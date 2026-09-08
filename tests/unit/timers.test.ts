/**
 * The Kitchen Codex — Pure Timer Engine (Timer Reliability phase).
 *
 * Deterministic tests for the wall-clock-correct timer model. `now` is always
 * injected; no real setTimeout waits, no flaky real-time assertions.
 */

import { describe, it, expect } from 'vitest';
import type { ActiveTimer } from '../../src/types';
import {
  createTimer,
  reconcileTimer,
  reconcileTimers,
  pauseTimer,
  resumeTimer,
  migrateLegacyTimer,
  upsertTimer,
  findTimerByKey,
  stepTimerKey,
} from '../../src/application/timers';

const NOW = 1_700_000_000_000;

function runningTimer(partial: Partial<ActiveTimer> = {}): ActiveTimer {
  return {
    id: 't1',
    recipeTitle: 'Lasagna',
    label: 'Step 1: Bake',
    totalSeconds: 60,
    remainingSeconds: 60,
    isRunning: true,
    createdAt: NOW,
    endsAt: NOW + 60_000,
    ...partial,
  };
}

describe('createTimer', () => {
  it('1: a running timer sets correct endsAt and remaining', () => {
    const t = createTimer({ id: 'x', recipeTitle: 'R', label: '10 min', totalSeconds: 600 }, NOW);
    expect(t.endsAt).toBe(NOW + 600 * 1000);
    expect(t.remainingSeconds).toBe(600);
    expect(t.isRunning).toBe(true);
  });
});

describe('reconcileTimer', () => {
  it('2: running before expiry keeps a wall-clock-derived remaining', () => {
    const t = runningTimer({ endsAt: NOW + 30_000, remainingSeconds: 60 });
    const r = reconcileTimer(t, NOW + 10_000);
    expect(r.timer.remainingSeconds).toBe(20); // 30s target - 10s elapsed = 20s
    expect(r.justCompleted).toBe(false);
  });

  it('3: running after expiry reconciles to 0 and marks completed', () => {
    const t = runningTimer({ endsAt: NOW + 5_000, remainingSeconds: 60 });
    const r = reconcileTimer(t, NOW + 10_000);
    expect(r.timer.remainingSeconds).toBe(0);
    expect(r.timer.isRunning).toBe(false);
    expect(r.justCompleted).toBe(true);
  });

  it('4: never goes negative', () => {
    const t = runningTimer({ endsAt: NOW - 100_000, remainingSeconds: 5 });
    const r1 = reconcileTimer(t, NOW);
    expect(r1.timer.remainingSeconds).toBe(0);
    const r2 = reconcileTimer(r1.timer, NOW + 200_000);
    expect(r2.timer.remainingSeconds).toBe(0);
  });

  it('5: a paused timer is unchanged', () => {
    const t = runningTimer({ isRunning: false, endsAt: undefined, remainingSeconds: 42 });
    const r = reconcileTimer(t, NOW + 5000);
    expect(r.timer).toEqual(t);
    expect(r.justCompleted).toBe(false);
  });

  it('6: reconcile is idempotent for the same now', () => {
    const t = runningTimer({ endsAt: NOW + 30_000, remainingSeconds: 60 });
    const r1 = reconcileTimer(t, NOW + 10_000).timer;
    const r2 = reconcileTimer(r1, NOW + 10_000).timer;
    expect(r1).toEqual(r2);
  });

  it('16: an unchanged paused timer preserves object identity across ticks', () => {
    const paused = runningTimer({ isRunning: false, endsAt: undefined, remainingSeconds: 30 });
    const r1 = reconcileTimer(paused, NOW);
    const r2 = reconcileTimer(r1.timer, NOW + 1000);
    expect(r1.timer).toBe(paused); // same reference, no churn
    expect(r2.timer).toBe(paused);
  });

  it('16: an unchanged completed timer preserves object identity across ticks', () => {
    const completed = runningTimer({ isRunning: false, endsAt: undefined, remainingSeconds: 0 });
    const r = reconcileTimer(completed, NOW);
    expect(r.timer).toBe(completed);
  });
});

describe('reconcileTimers', () => {
  it('10/12: multiple timers reconcile independently + delayed tick jumps correctly', () => {
    const a = runningTimer({ id: 'a', endsAt: NOW + 60_000, remainingSeconds: 60 });
    const b = runningTimer({ id: 'b', endsAt: NOW + 10_000, remainingSeconds: 10 });
    const c = runningTimer({ id: 'c', isRunning: false, endsAt: undefined, remainingSeconds: 30 });
    // 3 min later (sleep/throttle): a is further along, b completed, c frozen.
    const { timers, completed } = reconcileTimers([a, b, c], NOW + 180_000);
    expect(timers[0].remainingSeconds).toBe(0); // a done
    expect(timers[1].remainingSeconds).toBe(0); // b done
    expect(timers[2].remainingSeconds).toBe(30); // c frozen
    expect(completed).toBeGreaterThanOrEqual(1);
  });
});

describe('pauseTimer / resumeTimer', () => {
  it('7: resume creates a fresh endsAt from frozen remaining', () => {
    const paused = pauseTimer(runningTimer({ endsAt: NOW + 45_000, remainingSeconds: 60 }), NOW + 15_000);
    expect(paused.isRunning).toBe(false);
    expect(paused.endsAt).toBeUndefined();
    expect(paused.remainingSeconds).toBe(30); // 45s - 15s = 30s remaining

    const resumed = resumeTimer(paused, NOW + 100_000);
    expect(resumed.isRunning).toBe(true);
    expect(resumed.endsAt).toBe(NOW + 100_000 + 30 * 1000);
    expect(resumed.remainingSeconds).toBe(30);
  });

  it('8: a paused timer does not lose time while closed', () => {
    const paused = runningTimer({ isRunning: false, endsAt: undefined, remainingSeconds: 30 });
    const r = reconcileTimer(paused, NOW + 999_000);
    expect(r.timer.remainingSeconds).toBe(30);
  });
});

describe('migrateLegacyTimer', () => {
  it('8: legacy running timer without endsAt gains endsAt and preserves remaining', () => {
    const legacy = runningTimer({ endsAt: undefined, remainingSeconds: 45 });
    const migrated = migrateLegacyTimer(legacy, NOW);
    expect(migrated.endsAt).toBe(NOW + 45 * 1000);
    expect(migrated.remainingSeconds).toBe(45);
  });

  it('9: a legacy paused timer stays frozen', () => {
    const legacy = runningTimer({ isRunning: false, endsAt: undefined, remainingSeconds: 20 });
    const migrated = migrateLegacyTimer(legacy, NOW);
    expect(migrated.endsAt).toBeUndefined();
    expect(migrated.remainingSeconds).toBe(20);
    expect(migrated.isRunning).toBe(false);
  });

  it('15: malformed fields are normalized and never throw', () => {
    const bad = runningTimer({ remainingSeconds: Number.NaN, endsAt: 'nope' as unknown as number });
    const migrated = migrateLegacyTimer(bad, NOW);
    expect(Array.isArray(migrated.remainingSeconds) || migrated.remainingSeconds >= 0).toBe(true);
    expect(migrated.endsAt).toBeUndefined();
  });

  it('15: a running legacy timer at 0 is treated as completed', () => {
    const legacy = runningTimer({ endsAt: undefined, remainingSeconds: 0 });
    const migrated = migrateLegacyTimer(legacy, NOW);
    expect(migrated.isRunning).toBe(false);
    expect(migrated.remainingSeconds).toBe(0);
  });
});

describe('upsertTimer / findTimerByKey / stepTimerKey', () => {
  it('14: upsert preserves all fields and replaces by semanticKey (restart policy)', () => {
    const key = stepTimerKey('recipe-1', 3);
    const existing = runningTimer({ id: 'keep', semanticKey: key, remainingSeconds: 10 });
    const fresh = createTimer({ id: 'new', recipeTitle: 'R', label: 'Step 3: Bake', totalSeconds: 300, semanticKey: key }, NOW);
    const result = upsertTimer([existing], fresh, key);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('keep'); // id preserved for stable React keys
    expect(result[0].totalSeconds).toBe(300); // restarted
    expect(result[0].semanticKey).toBe(key);
  });

  it('prepends when no matching semanticKey', () => {
    const result = upsertTimer([], createTimer({ id: 'n', recipeTitle: 'R', label: 'x', totalSeconds: 60, semanticKey: 'k' }, NOW), 'k');
    expect(result).toHaveLength(1);
  });

  it('findTimerByKey returns the matching timer', () => {
    const key = stepTimerKey('rid', 2);
    const t = runningTimer({ id: 't', semanticKey: key });
    expect(findTimerByKey([t], key)).toBe(t);
    expect(findTimerByKey([t], 'other')).toBeUndefined();
  });
});
