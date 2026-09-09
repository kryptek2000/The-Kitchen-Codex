/**
 * The Kitchen Codex — SecretAdapter contract (Phase 4C1 / v0.7 Phase 1D).
 *
 * HIGH-SENSITIVITY port for provider/service credentials (e.g. Gemini API key,
 * future BYOK / OpenRouter / DeepSeek keys). This is a CONTRACT ONLY — no
 * concrete key is read or written by this module.
 *
 * SECURITY / TRUTHFULNESS INVARIANTS (must be preserved by every implementation):
 *   - The storage scope an adapter claims MUST be truthful. `secure_platform`
 *     means genuinely protected storage (OS keychain / secure enclave /
 *     protected credential store / comparable encrypted platform-backed
 *     facility). It must NEVER be used to describe environment variables,
 *     plaintext plugin data.json, browser localStorage/IndexedDB, Markdown, or
 *     ordinary settings files.
 *   - Plaintext-local storage is called `local_plaintext` and is reserved for a
 *     future Obsidian plaintext BYOK adapter. No current adapter may claim it
 *     unless it actually persists there today.
 *   - Server environment keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
 *     `DEEPSEEK_API_KEY`) are OPERATOR CONFIGURATION of the running server, NOT
 *     per-user BYOK. They are read-only through this boundary (no mutation).
 *   - Provider keys must NEVER enter shared UI/browser state or be exposed
 *     through a frontend env var (no `VITE_*` key) or localStorage.
 *   - Browser/PWA concrete implementations MUST reject writes
 *     (`supportsWrites() === false`) and expose no key to the page.
 *   - Hosted per-user BYOK remains BLOCKED and is NOT represented by a scope in
 *     this phase (it requires auth/session identity, per-user secret isolation,
 *     protected/encrypted storage, and lifecycle/revocation semantics).
 *   - Adapters MUST NOT read arbitrary secret names: server implementations use
 *     an explicit allowlist of provider secret ids (see `ProviderSecretId`).
 *
 * The contract intentionally carries the storage scope so callers can steer
 * behavior (and so browser/PWA targets are visibly unsupported for writes).
 */

/**
 * Where a secret is (or would be) held. Exactly one of:
 *   - `unavailable`      — no secret storage exists (browser/PWA). Writes must
 *                          be rejected (`supportsWrites() === false`).
 *   - `local_plaintext`  — plaintext local persistence (e.g. a future Obsidian
 *                          plugin `data.json`). RESERVED; not used yet.
 *   - `server_environment` — the running server/operator's process environment
 *                          (read-only operator configuration, NOT per-user BYOK).
 *   - `secure_platform`  — genuinely protected platform storage (OS keychain,
 *                          secure enclave, encrypted credential store).
 */
export type SecretStorageScope =
  | 'unavailable'
  | 'local_plaintext'
  | 'server_environment'
  | 'secure_platform';

/**
 * Provider-neutral secret identifiers used at the application boundary. These are
 * NEVER raw environment-variable names: the mapping to concrete env variables
 * (GEMINI_API_KEY / OPENROUTER_API_KEY / DEEPSEEK_API_KEY) belongs SERVER-SIDE,
 * inside the server secret adapter. No env-variable name leaks into browser/UI
 * contracts except where shown solely as operator documentation.
 */
export type ProviderSecretId =
  | 'gemini_api_key'
  | 'openrouter_api_key'
  | 'deepseek_api_key';

export interface SecretAdapter {
  /** Reads a secret value (or `undefined` when absent). */
  get(name: string): Promise<string | undefined>;
  /** Writes a secret value. Implementations may reject (throw) when unsupported. */
  set(name: string, value: string): Promise<void>;
  /** Removes a secret value. */
  remove(name: string): Promise<void>;
  /** True when this adapter is reachable/usable in the current environment. */
  isAvailable(): boolean;
  /** True when writes are permitted. MUST be false for read-only/unsupported targets. */
  supportsWrites(): boolean;
  /** The storage scope this adapter represents. */
  readonly storageScope: SecretStorageScope;
}

/**
 * Thrown by a `SecretAdapter` when a write is attempted on a supply that does not
 * support writes (e.g. browser/PWA or Obsidian shells before a real store exists).
 *
 * It is a deterministic, platform-neutral error so a caller can never treat a
 * write as silently successful. The message deliberately carries NO secret value
 * and NO caller-supplied value.
 */
export class SecretUnavailableError extends Error {
  constructor() {
    super("Secret storage is unavailable on this platform; provider secret writes are not supported.");
    this.name = "SecretUnavailableError";
  }
}
