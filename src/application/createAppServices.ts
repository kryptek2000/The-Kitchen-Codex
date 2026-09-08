/**
 * The Kitchen Codex — Application Composition Root (Phase 4C2 / 4D2A).
 *
 * A SMALL, implementation-agnostic seam that receives adapter instances and hands
 * them to the application layer. It proves the dependency-injection boundary
 * exists WITHOUT rewiring App.tsx or any UI yet.
 *
 * In Phase 4D2A `settings` and `network` become OPTIONAL concrete adapters
 * (browser localStorage + app-backend fetch). `vault` stays REQUIRED (it is the
 * one port the browser boundary depends on). Secrets/assets remain intentionally
 * absent (no speculative surface, no optional-method soup).
 *
 * This module imports ONLY the adapter CONTRACT types (application -> contracts).
 * It must NOT import `src/platform/*` (application must remain independent of any
 * concrete platform implementation), and it must not import `src/core`.
 */
import type { VaultAdapter } from './adapters/VaultAdapter';
import type { SettingsAdapter } from './adapters/SettingsAdapter';
import type { NetworkAdapter } from './adapters/NetworkAdapter';
import type { SecretAdapter } from './adapters/SecretAdapter';

/** The set of adapter instances the application can be composed with. */
export interface AppAdapters {
  /** Required: vault/recipe read-write access. */
  vault: VaultAdapter;
  /** Optional: keyed device/user settings persistence (never secrets). */
  settings?: SettingsAdapter;
  /** Optional: app-backend API transport (no arbitrary remote fetch). */
  network?: NetworkAdapter;
  /** Optional: secret-storage boundary. Truthful scope semantics per implementation. */
  secret?: SecretAdapter;
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
