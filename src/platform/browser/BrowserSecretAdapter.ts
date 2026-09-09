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
 *   - throws `SecretUnavailableError` on `set()`/`remove()` so a write can NEVER
 *     be treated as silently successful (v0.7 Phase 1E hardening), and never uses
 *     localStorage / sessionStorage / IndexedDB / settings / vault Markdown for
 *     any provider key.
 *
 * Browser provider-key entry is out of scope (v0.7 Phase 1E); this adapter only
 * provides a truthful, composition-ready unavailable boundary so a future surface
 * can read `supportsWrites() === false` rather than silently persisting a key.
 */

import { SecretUnavailableError, type SecretAdapter } from '../../application/adapters/SecretAdapter';

export class BrowserSecretAdapter implements SecretAdapter {
  readonly storageScope = 'unavailable' as const;

  async get(_name: string): Promise<string | undefined> {
    // No provider secret is available to the browser page.
    return undefined;
  }

  async set(_name: string, _value: string): Promise<void> {
    // Writes are unsupported on the browser shell; fail loudly instead of
    // silently pretending a provider key was persisted.
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
