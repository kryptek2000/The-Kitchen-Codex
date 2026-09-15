/**
 * The Kitchen Codex — Advanced Nutrition v1 (Phase 0) barrel.
 *
 * PURE, platform-neutral contracts and helpers only: canonical units, the
 * closed nutrient registry, the pinned FDA Daily Value helper, the schema-v1
 * types/bounds, and evidence validation + codec. Phase 0 defines and validates
 * the contract; it does NOT calculate, display, persist, or authorize anything.
 */

export * from './units';
export * from './nutrients';
export * from './dailyValues';
export * from './schema';
export * from './validate';
