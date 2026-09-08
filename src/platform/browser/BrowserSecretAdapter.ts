/**
 * The Kitchen Codex — Browser (PWA) Secret Adapter (v0.7 Phase 1D).
 *
 * A TRUTHFUL, read-only/non-persistent implementation of the application
 * `SecretAdapter` port for the browser/PWA shell. The browser MUST NOT persist
 * AI provider keys, so this adapter deliberately:
 *   - reports `supportsWrites() === false`,
 *   - reports `storageScope === 'unavailable'` (no genuinely protected or even
 *     plaintext provider store is available to the page),
 *   - returns `undefined` from `get()`,
 *   - no-ops `set()`/`remove()` and never uses localStorage / sessionStorage /
 *     IndexedDB / settings / vault Markdown for any provider key.
 *
 * Browser provider-key entry is out of scope (v0.7 Phase 1D); this adapter only
 * provides a truthful, composition-ready unavailable boundary so a future surface
 * can read `supportsWrites() === false` rather than silently persisting a key.
 */

import type { SecretAdapter } from '../../application/adapters/SecretAdapter';

export class BrowserSecretAdapter implements SecretAdapter {
  readonly storageScope = 'unavailable' as const;

  async get(_name: string): Promise<string | undefined> {
    // No provider secret is available to the browser page.
    return undefined;
  }

  async set(_name: string, _value: string): Promise<void> {
    // No-op: the browser shell must never persist provider keys.
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
