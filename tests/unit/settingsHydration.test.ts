/**
 * The Kitchen Codex — Settings Hydration Merge (Phase 4D2A timer-perf smoke fix).
 *
 * Tests the pure hydration-merge never-overwrite rule, including the timer
 * scenario (active timers restored on refresh without being clobbered, and a
 * user-started timer never overwritten by a stale persisted value).
 */

import { describe, it, expect } from 'vitest';
import { mergeHydratedSetting } from '../../src/application/settingsHydration';

// Timer validation helpers mirroring App.tsx hydration.
const isThemeDefault = (t: string) => t === 'obsidian';
const isThemeValid = (t: string) => t === 'obsidian' || t === 'parchment' || t === 'nordic';
const isTimersDefault = (t: unknown) => Array.isArray(t) && (t as unknown[]).length === 0;
const isTimersValid = (t: unknown) => Array.isArray(t);

interface Timer {
  id: string;
  recipeTitle: string;
  label: string;
  totalSeconds: number;
  remainingSeconds: number;
  isRunning: boolean;
  createdAt: number;
}

const SAVED_TIMERS: Timer[] = [
  {
    id: 't1',
    recipeTitle: 'Lasagna',
    label: '25 min',
    totalSeconds: 1500,
    remainingSeconds: 900,
    isRunning: true,
    createdAt: 1700000000000,
  },
];

describe('mergeHydratedSetting', () => {
  it('applies a valid persisted value when the current value is still the default', () => {
    expect(mergeHydratedSetting('obsidian', 'nordic', isThemeDefault, isThemeValid)).toBe('nordic');
    expect(mergeHydratedSetting([], SAVED_TIMERS, isTimersDefault, isTimersValid)).toEqual(SAVED_TIMERS);
  });

  it('keeps the current value when it is NOT the default (user edit wins; never clobber)', () => {
    expect(mergeHydratedSetting('nordic', 'parchment', isThemeDefault, isThemeValid)).toBe('nordic');
    expect(mergeHydratedSetting(SAVED_TIMERS, [], isTimersDefault, isTimersValid)).toEqual(SAVED_TIMERS);
  });

  it('keeps the default if there is no valid persisted value', () => {
    expect(mergeHydratedSetting('obsidian', 'moonlight', isThemeDefault, isThemeValid)).toBe('obsidian');
    expect(mergeHydratedSetting('obsidian', undefined, isThemeDefault, isThemeValid)).toBe('obsidian');
    expect(mergeHydratedSetting([], 'garbage', isTimersDefault, isTimersValid)).toEqual([]);
    expect(mergeHydratedSetting([], undefined, isTimersDefault, isTimersValid)).toEqual([]);
  });

  it('timer merge: a user-started timer is never overwritten by a stale persisted list', () => {
    const userTimer: Timer = { ...SAVED_TIMERS[0], id: 'user', remainingSeconds: 300 };
    // current = [userTimer] (non-default) -> keep, even though a persisted list exists.
    expect(mergeHydratedSetting([userTimer], SAVED_TIMERS, isTimersDefault, isTimersValid)).toEqual([
      userTimer,
    ]);
  });
});
