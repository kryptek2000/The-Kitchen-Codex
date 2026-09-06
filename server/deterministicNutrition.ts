/**
 * The Kitchen Codex — Deterministic Nutrition (compatibility re-export shim).
 *
 * Phase 4B moved the pure deterministic food-aware nutrition engine into the
 * platform-neutral shared core (`src/core/deterministicNutrition.ts`), which
 * depends only on the shared core (measurements, food reference, schema).
 * This module is a LOGIC-FREE re-export shim so existing importers (server
 * estimator, server cache, and the deterministic-nutrition unit tests) keep
 * resolving the same implementation without a large import rewrite.
 */
export * from '../src/core/deterministicNutrition';
