/**
 * The Kitchen Codex — Server Environment Secret Adapter (v0.7 Phase 1D).
 *
 * A read-only, SERVER-SIDE `SecretAdapter` implementation that exposes the
 * operator's server process environment as the secret source. The keys it reads
 * (GEMINI_API_KEY / OPENROUTER_API_KEY / DEEPSEEK_API_KEY) are OPERATOR
 * CONFIGURATION of the running server — NOT per-user BYOK. This adapter NEVER
 * mutates `process.env`.
 *
 * SECURITY INVARIANTS:
 *   - The env-name mapping lives in ONE server-side place
 *     (`SERVER_SECRET_ENV_ALLOWLIST`). No arbitrary environment variable can be
 *     read: `get()` only resolves a name that maps to an allowlisted provider
 *     secret id, and any non-allowlisted name returns `undefined`.
 *   - Writes are unsupported (`supportsWrites() === false`; `set`/`remove`
 *     throw). Server environment is operator configuration, not writable store.
 *   - The storage scope is truthful: `server_environment`.
 *   - No secret value is ever echoed in an error or returned by any status
 *     object — this adapter only hands the value to an in-process consumer that
 *     uses it at the provider boundary.
 */

import type {
  ProviderSecretId,
  SecretAdapter,
} from '../../src/application/adapters/SecretAdapter';

/**
 * The single server-side mapping from provider-neutral secret ids to the concrete
 * operator environment-variable names. This is the ONLY place in the codebase
 * that knows these env names; providers, the registry, and provider status all
 * route through a server-side secret source built on this allowlist.
 */
export const SERVER_SECRET_ENV_ALLOWLIST: Record<ProviderSecretId, string> = {
  gemini_api_key: 'GEMINI_API_KEY',
  openrouter_api_key: 'OPENROUTER_API_KEY',
  deepseek_api_key: 'DEEPSEEK_API_KEY',
};

/**
 * Resolves a provider-neutral secret id to its operator environment-variable
 * name, or `undefined` when the id is not allowlisted. Callers should treat an
 * unknown id as "no secret configured" — never fall through to arbitrary env.
 */
export function serverSecretEnvName(id: ProviderSecretId): string | undefined {
  return SERVER_SECRET_ENV_ALLOWLIST[id];
}

/**
 * Maps an `AiProvider` id (gemini / openrouter / deepseek) to the provider-neutral
 * secret id used by the secret boundary, or `undefined` for providers with no
 * operator secret.
 */
export function providerSecretIdForProvider(providerId: string): ProviderSecretId | undefined {
  switch (providerId) {
    case 'gemini':
      return 'gemini_api_key';
    case 'openrouter':
      return 'openrouter_api_key';
    case 'deepseek':
      return 'deepseek_api_key';
    default:
      return undefined;
  }
}

/**
 * Synchronously reads an allowlisted server-env secret. Kept synchronous so the
 * AI providers' availability/shape checks (and the registry enablement) can call
 * it without introducing async churn into the `AiProvider` interface. Only the
 * allowlisted provider secret ids resolve to a value; never arbitrary env.
 */
export function getServerSecretSync(id: ProviderSecretId): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const envName = serverSecretEnvName(id);
  if (!envName) return undefined;
  const value = process.env[envName];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A read-only, allowlisted, server-env `SecretAdapter` implementation. It exposes
 * the operator config keys to in-process consumers but never writes, never reads
 * arbitrary env names, and never mutates the environment.
 */
export class ServerEnvironmentSecretAdapter implements SecretAdapter {
  readonly storageScope = 'server_environment' as const;

  /**
   * Optional test seam providing the underlying env lookup. Defaults to reading
   * `process.env`; inject a fake map to test without touching the real env.
   */
  constructor(private readonly envLookup?: (name: string) => string | undefined) {}

  private lookup(name: string): string | undefined {
    if (this.envLookup) return this.envLookup(name);
    return process.env[name];
  }

  async get(name: string): Promise<string | undefined> {
    // Only allowlisted provider secret ids may be read; anything else is a
    // deliberate no-read (no arbitrary environment-variable access).
    const envName = serverSecretEnvName(name as ProviderSecretId);
    if (!envName) return undefined;
    const value = this.lookup(envName);
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  async set(_name: string, _value: string): Promise<void> {
    throw new Error('Server environment secrets are read-only operator configuration.');
  }

  async remove(_name: string): Promise<void> {
    throw new Error('Server environment secrets are read-only operator configuration.');
  }

  isAvailable(): boolean {
    // The server-environment capability exists whenever a process environment is
    // present (which is the case for any Node server).
    return typeof process !== 'undefined' && Boolean(process.env);
  }

  supportsWrites(): boolean {
    return false;
  }
}
