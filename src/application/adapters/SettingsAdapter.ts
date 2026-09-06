/**
 * The Kitchen Codex — SettingsAdapter contract (Phase 4C1).
 *
 * Application-facing port for generic, keyed user settings persistence (UI
 * preferences, filter state, theme, provider *preferences* — never secrets).
 * It deliberately does NOT encode localStorage semantics: concrete adapters may
 * be localStorage (standalone/PWA), Obsidian plugin settings, or hosted
 * settings, and they hide that behind this contract.
 *
 * This is a CONTRACT ONLY. No concrete implementation exists in this phase.
 *
 * Out of scope (deferred): migration/versioning machinery, schema validation,
 * namespaces/capabilities, sync of settings (settings are low-value to sync).
 */

/**
 * All methods are Promise-based for cross-platform consistency. Even a trivial
 * localStorage-backed adapter can implement these as `Promise.resolve(...)`
 * wrappers, so callers always `await` and never special-case sync vs async.
 */
export interface SettingsAdapter {
  /** Reads a setting value (or `undefined` when absent). */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Writes a setting value. */
  set<T = unknown>(key: string, value: T): Promise<void>;
  /** Removes a setting value. */
  remove(key: string): Promise<void>;
}
