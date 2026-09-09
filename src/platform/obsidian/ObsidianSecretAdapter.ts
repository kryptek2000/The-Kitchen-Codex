/**
 * The Kitchen Codex — Obsidian Secret Adapter (v0.7 Phase 1D).
 *
 * A TRUTHFUL, read-only/non-persistent `SecretAdapter` for the Obsidian plugin
 * shell. In v0.7 Phase 1E no provider key is persisted (NOT to plugin
 * `data.json`, NOT to vault Markdown, NOT to settings JSON, NOT to workspace
 * state), so this adapter:
 *   - reports `supportsWrites() === false`,
 *   - reports `storageScope === 'unavailable'` (no provider store is used yet),
 *   - returns `undefined` from `get()`,
 *   - throws `SecretUnavailableError` on `set()`/`remove()` so a write can NEVER
 *     be treated as silently successful (v0.7 Phase 1E hardening).
 *
 * A FUTURE Obsidian plaintext BYOK adapter may truthfully report
 * `storageScope === 'local_plaintext'` once it actually persists provider keys in
 * plugin data. That is NOT implemented in this phase — `local_plaintext` remains
 * reserved and must not be claimed until such an adapter exists.
 */

import { SecretUnavailableError, type SecretAdapter } from '../../application/adapters/SecretAdapter';

export class ObsidianSecretAdapter implements SecretAdapter {
  readonly storageScope = 'unavailable' as const;

  async get(_name: string): Promise<string | undefined> {
    // No provider secret is available in the Obsidian shell in this phase.
    return undefined;
  }

  async set(_name: string, _value: string): Promise<void> {
    // Writes are unsupported in the Obsidian shell in this phase; fail loudly.
    throw new SecretUnavailableError();
  }

  async remove(_name: string): Promise<void> {
    // Nothing was ever persisted, but a remove is still an unsupported write.
    throw new SecretUnavailableError();
  }

  isAvailable(): boolean {
    return false;
  }

  supportsWrites(): boolean {
    return false;
  }
}
