/**
 * The Kitchen Codex — Application Composition Root (Phase 4C2).
 *
 * A SMALL, implementation-agnostic seam that receives adapter instances and hands
 * them to the application layer. It proves the dependency-injection boundary
 * exists WITHOUT rewiring App.tsx or any UI yet.
 *
 * Deliberately minimal: in Phase 4C2 the only concrete adapter is the browser
 * vault adapter, so `AppAdapters` requires only `vault`. Settings / Network /
 * Secret adapters have no concrete implementation yet and are intentionally left
 * OUT until they do (no optional-method soup, no speculative surface).
 *
 * This module imports ONLY the adapter CONTRACT types (application -> contracts).
 * It must NOT import `src/platform/*` (application must remain independent of any
 * concrete platform implementation), and it must not import `src/core`.
 */
import type { VaultAdapter } from './adapters/VaultAdapter';

/** The set of adapter instances the application can be composed with. */
export interface AppAdapters {
  vault: VaultAdapter;
}

/** The composed application services handed to orchestration/UI. */
export interface AppServices {
  adapters: AppAdapters;
}

/**
 * Composes application services from the provided adapter instances.
 *
 * Implementation-agnostic: callers pass in whatever concrete adapters match the
 * running platform (browser FSA today; Obsidian / PWA / server variants later).
 * This function performs NO platform or browser API call at import or call time.
 */
export function createAppServices(adapters: AppAdapters): AppServices {
  return { adapters };
}
