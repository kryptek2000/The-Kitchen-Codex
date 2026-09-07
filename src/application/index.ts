/**
 * The Kitchen Codex — Application Layer (Phase 4C1).
 *
 * Formal application-entrypoint boundary between the platform-neutral CORE and
 * the concrete PLATFORM ADAPTERS / UI.
 *
 * In Phase 4C1 this contains ONLY:
 *   - the platform/application adapter CONTRACTS (ports), and
 *   - the re-classified application / UI-wiring helper (askMyKitchenUi).
 *
 * It intentionally does NOT move orchestration/use-case logic yet (that is a
 * later application-layer step). Application may depend on core; core must NOT
 * depend on application (enforced by the coreBoundary conformance test).
 *
 * Depends on: core domain modules + adapter contracts.
 * Must NOT depend on: React/Express/DOM/Node-fs/@google/genai, concrete platform
 * adapters, or raw platform APIs (vaultFileSystem/vaultAssets/etc.).
 */
export * from './adapters';
export * from './askMyKitchenUi';
export * from './createAppServices';
export * from './vaultRecipe';
export * from './vaultContent';
