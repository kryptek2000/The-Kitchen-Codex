/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: isolated barrel.
 *
 * PURE, platform-neutral, offline, ADVISORY REVIEW AND DISPLAY ONLY. This
 * barrel is intentionally NOT re-exported from `src/core/nutritionV2/index.ts`
 * or `src/core/index.ts`: the React presentation layer imports it explicitly.
 *
 * The internal session authority registry is module-local to `./session` and is
 * never exported.
 */

export * from './types';
export * from './adapt';
export * from './session';
export * from './state';
export * from './display';
export * from './stored';
export * from './portion';
export * from './userMass';
export * from './rows';
