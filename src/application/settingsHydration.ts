/**
 * The Kitchen Codex — Settings Hydration Merge (Phase 4D2A smoke fix).
 *
 * A tiny pure helper used when hydrating persisted settings from the async
 * `SettingsAdapter` back into React state.
 *
 * The async adapter introduces a startup race: the user can change a value (e.g.
 * start a cooking timer) BEFORE the async hydration read completes. Hydration
 * must therefore NEVER overwrite a value the user already changed away from its
 * initial default. This function encodes that rule deterministically:
 *
 *   - if the current value is no longer the initial default, keep it (user edit
 *     wins — do not clobber it with a stale persisted value);
 *   - otherwise apply the persisted value when it is present and valid;
 *   - otherwise keep the current default.
 *
 * PURE — no React, no browser/platform, no `SettingsAdapter`. Testable in Node.
 */

export function mergeHydratedSetting<T>(
  current: T,
  saved: T | undefined,
  isDefault: (value: T) => boolean,
  isValid: (value: T) => boolean
): T {
  if (!isDefault(current)) return current;
  return saved !== undefined && isValid(saved) ? saved : current;
}
