/**
 * The Kitchen Codex — credential source resolver (BYOK-5C).
 *
 * Resolves a `{ providerId, credentialSource }` pair into an EXACT credential
 * lease. This is the single server-owned boundary that decides WHOSE credential
 * authorizes a provider execution.
 *
 * SECURITY / TRUTH:
 *   - SELECTION (provider/model) and CREDENTIAL SOURCE are SEPARATE decisions.
 *     This module never infers one from the other.
 *   - A session credential is used EXCLUSIVELY for `session_only`: there is NO
 *     fallback to the operator environment key, and no cross-provider reuse.
 *   - An environment credential is used EXCLUSIVELY for `server_environment`:
 *     there is NO fallback to a session key.
 *   - Never mutates `process.env`; never writes a secret anywhere; never logs a
 *     secret; never returns a secret to client code (the lease is server-only).
 *   - The lease is short-lived and request-scoped. Provider clients built from a
 *     session lease are request-scoped and never cached globally, so a revoked
 *     session secret cannot be retained by a long-lived singleton.
 */

import {
  getServerSecretSync,
  providerSecretIdForProvider,
} from "../platform/ServerEnvironmentSecretAdapter.js";
import { getSessionSecret } from "./sessionSecrets.js";
import { GeminiProvider } from "./geminiProvider.js";
import { OpenRouterProvider } from "./openRouterProvider.js";
import { DeepSeekProvider } from "./deepSeekProvider.js";
import { GeminiImageProvider } from "./geminiImageProvider.js";
import { OpenRouterImageProvider } from "./openRouterImageProvider.js";
import type { AiProvider } from "./types.js";
import type { ImageProvider } from "./imageProvider.js";

/** The two non-secret credential sources. */
export type CredentialSource = "server_environment" | "session_only";

/**
 * Bounded, provider-neutral credential failure codes (never secret-derived).
 * NOTE: missing / expired / revoked all normalize to SESSION_CREDENTIAL_MISSING
 * (the session store intentionally does not expose lifecycle detail).
 */
export type CredentialErrorCode =
  | "SESSION_CREDENTIAL_MISSING"
  | "CREDENTIAL_SOURCE_INVALID"
  | "CREDENTIAL_SOURCE_UNAVAILABLE";

/** A short-lived credential lease (server-only; never returned to client code). */
export interface CredentialLease {
  providerId: string;
  source: CredentialSource;
  secret: string;
}

export type CredentialResolution =
  | { ok: true; lease: CredentialLease }
  | { ok: false; code: CredentialErrorCode };

/** True when a value is one of the two allowed credential sources. */
export function isCredentialSource(value: unknown): value is CredentialSource {
  return value === "server_environment" || value === "session_only";
}

/**
 * Resolves the exact credential for a provider + source. Fail-closed: a missing
 * credential yields a bounded error code and NEVER substitutes another source.
 */
export function resolveCredential(providerId: string, source: CredentialSource): CredentialResolution {
  if (source === "session_only") {
    // Exact provider-id scoping; expired/revoked entries read as missing.
    const secret = getSessionSecret(providerId);
    if (!secret) return { ok: false, code: "SESSION_CREDENTIAL_MISSING" };
    return { ok: true, lease: { providerId, source, secret } };
  }
  if (source === "server_environment") {
    const secretId = providerSecretIdForProvider(providerId);
    const secret = secretId ? getServerSecretSync(secretId) : undefined;
    if (!secret) return { ok: false, code: "CREDENTIAL_SOURCE_UNAVAILABLE" };
    return { ok: true, lease: { providerId, source, secret } };
  }
  return { ok: false, code: "CREDENTIAL_SOURCE_INVALID" };
}

/**
 * Builds a REQUEST-SCOPED text provider bound to an explicit session credential.
 * Returns `null` for a provider id with no safe session-bound text factory (e.g.
 * image providers in this slice) so the caller fails closed rather than falling
 * back to the environment credential.
 */
export function createCredentialBoundTextProvider(
  providerId: string,
  credential: string
): AiProvider | null {
  switch (providerId) {
    case "gemini":
      return new GeminiProvider({ credential });
    case "openrouter":
      return new OpenRouterProvider({ credential });
    case "deepseek":
      return new DeepSeekProvider({ credential });
    default:
      return null;
  }
}

/** True when a session credential can be safely bound to a TEXT provider. */
export function supportsSessionBoundTextProvider(providerId: string): boolean {
  return providerId === "gemini" || providerId === "openrouter" || providerId === "deepseek";
}

/**
 * Resolves the session secret for an EXACT provider id and returns a
 * request-scoped provider bound to it, or `null` when no live session credential
 * exists. NEVER falls back to the environment credential.
 */
export function createSessionBoundTextProvider(providerId: string): AiProvider | null {
  const secret = getSessionSecret(providerId);
  if (!secret) return null;
  return createCredentialBoundTextProvider(providerId, secret);
}

/**
 * BYOK-5F: builds a REQUEST-SCOPED IMAGE provider bound to an explicit session
 * credential. Exact image execution IDs only (`gemini-image` / `openrouter-image`);
 * text IDs are rejected. Returns `null` for an unsupported id so the caller fails
 * closed rather than falling back to the environment credential.
 */
export function createCredentialBoundImageProvider(
  providerId: string,
  credential: string
): ImageProvider | null {
  switch (providerId) {
    case "gemini-image":
      return new GeminiImageProvider({ credential });
    case "openrouter-image":
      return new OpenRouterImageProvider({ credential });
    default:
      return null;
  }
}

/** True when a session credential can be safely bound to an IMAGE provider. */
export function supportsSessionBoundImageProvider(providerId: string): boolean {
  return providerId === "gemini-image" || providerId === "openrouter-image";
}

/**
 * Resolves the session secret for an EXACT image provider id and returns a
 * request-scoped image provider bound to it, or `null` when no live session
 * credential exists. NEVER falls back to the environment credential and NEVER
 * reads a text provider's session secret.
 */
export function createSessionBoundImageProvider(providerId: string): ImageProvider | null {
  const secret = getSessionSecret(providerId);
  if (!secret) return null;
  return createCredentialBoundImageProvider(providerId, secret);
}
