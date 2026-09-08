/**
 * The Kitchen Codex — Obsidian Platform (Phase 4D3B).
 *
 * Concrete Obsidian integrations implementing the application adapter contracts.
 * These are type-only consumers of the Obsidian API (runtime values are injected
 * by the plugin bootstrap), so they are Node-loadable for unit tests.
 *
 * Dependency direction: platform/obsidian -> application/adapters (contracts).
 * The application and core layers must never import this platform module.
 */
export { ObsidianVaultAdapter } from './ObsidianVaultAdapter';
export { ObsidianSettingsAdapter } from './ObsidianSettingsAdapter';
export type { SettingsStore } from './ObsidianSettingsAdapter';
export { ObsidianNetworkAdapter, ObsidianNetworkError } from './ObsidianNetworkAdapter';
export type { ObsidianNetworkOptions, ObsidianFetchLike, ObsidianResponseLike } from './ObsidianNetworkAdapter';
