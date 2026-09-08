/**
 * The Kitchen Codex — Timer Engine Singularity Guard (Timer Reliability phase).
 *
 * Static guard proving there is exactly ONE authoritative timer engine.
 * CookingModeModal must NOT contain its own independent countdown (local step
 * timer / setInterval); it must drive the global engine via onStartTimer and
 * render from the global `activeTimers`.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const COOKING_MODAL = readFileSync(resolve(ROOT, 'src/components/CookingModeModal.tsx'), 'utf8');
const APP = readFileSync(resolve(ROOT, 'src/App.tsx'), 'utf8');

// The retired local-timer engine symbols must not exist in CookingModeModal.
const FORBIDDEN_LOCAL_TIMER = ['stepTimerSeconds', 'isStepTimerRunning', 'stepTimerRef'];
const FORBIDDEN_SETINTERVAL = /\bsetInterval\s*\(/;

describe('timer engine singularity (Timer Reliability phase)', () => {
  it('CookingModeModal contains no independent local timer engine', () => {
    for (const sym of FORBIDDEN_LOCAL_TIMER) {
      expect(COOKING_MODAL).not.toContain(sym);
    }
    expect(FORBIDDEN_SETINTERVAL.test(COOKING_MODAL)).toBe(false);
  });

  it('CookingModeModal drives the global engine via onStartTimer + activeTimers', () => {
    expect(COOKING_MODAL).toContain('onStartTimer');
    expect(COOKING_MODAL).toContain('activeTimers');
    expect(COOKING_MODAL).toContain('stepTimerKey');
  });

  it('the single interval engine lives in App.tsx (reconcile against wall clock)', () => {
    expect(APP).toContain('reconcileTimers');
    expect(APP).toContain('endsAt');
  });
});
