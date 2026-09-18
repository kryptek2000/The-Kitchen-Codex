/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: isolated calculation barrel.
 *
 * PURE, platform-neutral, offline, ADVISORY ONLY. This barrel is intentionally
 * NOT re-exported from `src/core/nutritionV2/index.ts` or `src/core/index.ts`:
 * no production surface imports Phase 3, and no UI/route/provider/persistence
 * path may depend on it. Callers (and tests) import these modules explicitly.
 *
 * The internal engine (`./calculate`) is intentionally NOT exported.
 */

export * from './types';
export * from './numeric';
export * from './servings';
export * from './dailyValues';
export * from './mass';
export * from './countPortion';
export * from './context';
