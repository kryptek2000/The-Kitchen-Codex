/**
 * The Kitchen Codex — Advanced Nutrition Phase 2: isolated matching barrel.
 *
 * PURE, platform-neutral, offline, review-only. This barrel is intentionally NOT
 * re-exported from `src/core/nutritionV2/index.ts` or `src/core/index.ts`: no
 * production surface imports Phase 2, and no UI/route/provider/persistence path
 * may depend on it. Callers (and tests) import these modules explicitly.
 */

export * from './types';
export * from './normalize';
export * from './parse';
export * from './rank';
export * from './review';
