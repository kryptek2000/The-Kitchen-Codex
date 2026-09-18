/**
 * The Kitchen Codex — Advanced Nutrition Phase 5A: isolated barrel.
 *
 * PURE, platform-neutral, offline, ADVISORY-BUILD ONLY. This barrel is
 * intentionally NOT re-exported from `src/core/nutritionV2/index.ts` or
 * `src/core/index.ts`: the React presentation layer and tests import it
 * explicitly. It constructs an in-memory `codex_nutrition` candidate and a
 * closed Apply authorization result; it never writes anything.
 */

export * from './types';
export { authorizeNutritionPersistence } from './authorize';
