/**
 * The Kitchen Codex — SecretAdapter contract (Phase 4C1).
 *
 * HIGH-SENSITIVITY port for provider/service credentials (e.g. Gemini API key,
 * future BYOK / OpenRouter / DeepSeek keys). This is a CONTRACT ONLY — it reads
 * and writes NO actual key in this phase.
 *
 * SECURITY INVARIANTS (must be preserved by every implementation):
 *   - Provider keys must NEVER enter shared UI/browser state or be exposed
 *     through a frontend env var (no `VITE_*` key) or localStorage.
 *   - A browser/PWA concrete implementation is EXPECTED to reject writes
 *     (`supportsWrites() === false`) and to expose no key to the page; such an
 *     adapter may only report availability from a hosted/session context.
 *   - Server-side implementations read from process env / a secure store.
 *   - Obsidian plugin implementations use Obsidian's secure/plugin settings.
 *   - Future hosted per-user keys require auth/session and server-managed
 *     secret storage, NOT a browser-held value.
 *
 * The contract intentionally carries the storage scope so callers can steer
 * behavior (and so a browser/PWA target is visibly unsupported for writes).
 */

/** Where a secret is (or would be) held. */
export type SecretStorageScope =
  | 'server_env' // server process environment / server-managed store
  | 'secure_platform' // desktop/plugin secure settings, OS keychain
  | 'hosted_session' // authenticated, session/server-backed secret storage
  | 'unsupported'; // no safe storage (e.g. plain browser/PWA) -> writes must be rejected

export interface SecretAdapter {
  /** Reads a secret value (or `undefined` when absent). */
  get(name: string): Promise<string | undefined>;
  /** Writes a secret value. Implementations may reject (throw) when unsupported. */
  set(name: string, value: string): Promise<void>;
  /** Removes a secret value. */
  remove(name: string): Promise<void>;
  /** True when this adapter is reachable/usable in the current environment. */
  isAvailable(): boolean;
  /** True when writes are permitted. MUST be false for browser/PWA targets. */
  supportsWrites(): boolean;
  /** The storage scope this adapter represents. */
  readonly storageScope: SecretStorageScope;
}
