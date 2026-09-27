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

// AI Advanced Nutrition (AI-0): canonical provider-neutral interpretation +
// plan contracts, candidate-bound orchestration, the centralized capability
// boundary, the future bounded-estimate skeleton, and separate benchmark
// accounting. These are pure contracts; no provider SDK, no execution ability,
// and no nutrition authority is exported here.
export * from './aiAdvanced';
export * from './aiAdvancedCandidates';
export * from './aiAdvancedPlan';
// AI-2A candidate authority foundation: request context, deterministic plan
// source, and the deterministic plan validator. Pure, provider-free, and still
// authority-free: these modules classify (automatic | offer | review) using the
// existing deterministic rules and never write anything.
export * from './aiAdvancedPlanRequest';
export * from './aiAdvancedPlanSource';
export * from './aiAdvancedPlanApply';
export * from './nutritionCapabilities';
export * from './aiAdvancedEstimate';
export * from './aiAdvancedBenchmark';
