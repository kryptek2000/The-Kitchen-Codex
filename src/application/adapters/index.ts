/**
 * The Kitchen Codex — Platform/Application Adapter Contracts (Phase 4C1).
 *
 * Adapter PORTS (contracts) only. These are application-facing interfaces for
 * platform seams; NO concrete platform adapter implementations live here in this
 * phase. Concrete adapters (browser File System Access / Obsidian Vault / PWA
 * storage / server / hosted) will implement these contracts later.
 */
export * from './VaultAdapter';
export * from './SettingsAdapter';
export * from './SecretAdapter';
export * from './NetworkAdapter';
export * from './AssetAdapter';
