/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: trusted USDA barrel.
 *
 * PURE, platform-neutral. This barrel is intentionally NOT re-exported from
 * `src/core/nutritionV2/index.ts` or `src/core/index.ts`: Phase 1 must not be
 * wired into any production surface or create runtime behavior. Callers (and
 * tests) import these modules explicitly.
 */

export * from './digest';
export * from './types';
export * from './nutrientMap';
export * from './raw';
export * from './transport';
export * from './record';
export * from './manifest';
export * from './adapter';
export * from './store';
export * from './cache';
