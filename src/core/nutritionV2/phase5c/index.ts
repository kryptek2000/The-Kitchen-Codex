/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C: isolated barrel.
 *
 * PURE, platform-neutral, read-only nutrition-presentation selector. This barrel
 * is intentionally NOT re-exported from `src/core/nutritionV2/index.ts` or
 * `src/core/index.ts`: the React presentation layer and tests import it
 * explicitly. It centralizes Advanced-vs-legacy display precedence without any
 * write, migration, merge, network, or provider call.
 */

export * from './presentation';
export * from './savedReport';
