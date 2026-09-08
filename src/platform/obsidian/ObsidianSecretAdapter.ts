/**
 * The Kitchen Codex — Obsidian Secret Adapter (v0.7 Phase 1D).
 *
 * A TRUTHFUL, read-only/non-persistent `SecretAdapter` for the Obsidian plugin
 * shell. In v0.7 Phase 1D no provider key is persisted (NOT to plugin
 * `data.json`, NOT to vault Markdown, NOT to settings JSON, NOT to workspace
 * state), so this adapter:
 *   - reports `supportsWrites() === false`,
 *   - reports `storageScope === 'unavailable'` (no provider store is used yet),
 *   - returns `undefined` from `get()`,
 *   - no-ops `set()`/`remove()`.
 *
 * A FUTURE Obsidian plaintext BYOK adapter may truthfully report
 * `storageScope === 'local_plaintext'` once it actually persists provider keys in
 * plugin data. That is NOT implemented in this phase — `local_plaintext` remains
 * reserved and must not be claimed until such an adapter exists.
 */

import type { SecretAdapter } from '../../application/adapters/SecretAdapter';

export class ObsidianSecretAdapter implements SecretAdapter {
  readonly storageScope = 'unavailable' as const;

  async get(_name: string): Promise<string | undefined> {
    // No provider secret is available in the Obsidian shell in this phase.
    return undefined;
  }

  async set(_name: string, _value: string): Promise<void> {
    // No-op: the Obsidian shell must not persist provider keys in this phase.
  }

  async remove(_name: string): Promise<void> {
    // No-op: nothing was ever persisted.
  }

  isAvailable(): boolean {
    return false;
  }

  supportsWrites(): boolean {
    return false;
  }
}
