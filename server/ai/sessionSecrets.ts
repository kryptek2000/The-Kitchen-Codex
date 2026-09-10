/**
 * The Kitchen Codex — in-memory SESSION-ONLY secret store (BYOK-5A).
 *
 * A SERVER-OWNED, in-process store for per-provider session credentials. The
 * secret exists ONLY in server process memory:
 *
 *   - never persisted (no disk / file / database / settings store)
 *   - never copied into `process.env`
 *   - never sent to the browser / vault / plugin store
 *   - lost on process restart
 *
 * SCOPE / TRUST:
 *   - Entries are keyed by EXACT provider execution id (never an arbitrary
 *     secret name, never an env-var name). Only provider ids present in the
 *     text/image provider registry are storable.
 *   - `openrouter` and `openrouter-image` are DISTINCT ids and remain isolated
 *     even though they share a vendor.
 *   - Writes are permitted only in an explicitly-trusted local/single-user
 *     deployment (see `isSessionByokSupportedDeployment`); a hosted multi-user
 *     deployment is blocked.
 *
 * LIFECYCLE:
 *   - Absolute TTL (30 minutes from creation) AND idle TTL (15 minutes since last
 *     successful read). An expired entry is removed before it can be returned.
 *   - A successful read refreshes the idle timer.
 *   - Rotation requires the caller's `expectedVersion` to match the current
 *     opaque version; a stale/missing version is a conflict and never overwrites
 *     a newer secret.
 *   - Revoke is idempotent and immediately prevents future reads.
 *
 * SECURITY:
 *   - No secret value is ever logged, serialized, hashed, or exposed in status.
 *   - Version tokens are random and NOT derived from the secret.
 *   - Status exposes only non-secret metadata (providerId, scope, configured,
 *     expiresAt, version).
 */

import { randomUUID } from "node:crypto";
import { getRegisteredProviders } from "./providerRegistry.js";
import { getRegisteredImageProviders } from "./imageProviderRegistry.js";
import { isSessionByokSupportedDeployment } from "./sessionByokDeployment.js";

/** Absolute session lifetime (30 minutes). */
export const SESSION_SECRET_ABSOLUTE_TTL_MS = 30 * 60 * 1000;
/** Idle session lifetime (15 minutes since last successful read). */
export const SESSION_SECRET_IDLE_TTL_MS = 15 * 60 * 1000;
/** Maximum accepted secret length (bounded, generous for real provider keys). */
export const MAX_SESSION_SECRET_LENGTH = 512;

/** A bounded, secret-free error code for session-secret failures. */
export type SessionSecretErrorCode =
  | "SESSION_BYOK_UNSUPPORTED"
  | "PROVIDER_NOT_ALLOWED"
  | "INVALID_SECRET"
  | "SECRET_TOO_LONG"
  | "VERSION_CONFLICT";

/**
 * Thrown by the session secret store. The message is a bounded, provider-neutral
 * explanation and NEVER contains a secret value.
 */
export class SessionSecretError extends Error {
  readonly code: SessionSecretErrorCode;
  constructor(code: SessionSecretErrorCode, message: string) {
    super(message);
    this.name = "SessionSecretError";
    this.code = code;
  }
}

/** The non-secret status shape for one provider's session secret. */
export interface SessionSecretStatus {
  providerId: string;
  storageScope: "session_only";
  configured: boolean;
  /** ISO timestamp of absolute expiry (present only when configured). */
  expiresAt?: string;
  /** Opaque rotation version (present only when configured; never secret-derived). */
  version?: string;
}

interface SessionSecretEntry {
  providerId: string;
  secret: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  version: string;
}

const store = new Map<string, SessionSecretEntry>();

/**
 * The allowlisted provider execution ids that may hold a session secret: exactly
 * the registered text providers + registered image providers. Text and image ids
 * stay DISTINCT (e.g. `openrouter` != `openrouter-image`).
 */
export function sessionSecretProviderAllowlist(): string[] {
  const ids = new Set<string>();
  for (const registered of getRegisteredProviders()) ids.add(registered.provider.id);
  for (const registered of getRegisteredImageProviders()) ids.add(registered.provider.id);
  return [...ids];
}

/** True when a provider id is an approved session-secret target. */
export function isSessionSecretProviderAllowed(providerId: string): boolean {
  return typeof providerId === "string" && sessionSecretProviderAllowlist().includes(providerId);
}

function isExpired(entry: SessionSecretEntry, now: number): boolean {
  return now >= entry.expiresAt || now - entry.lastUsedAt >= SESSION_SECRET_IDLE_TTL_MS;
}

function purgeExpired(now: number): number {
  let removed = 0;
  for (const [providerId, entry] of store) {
    if (isExpired(entry, now)) {
      store.delete(providerId);
      removed += 1;
    }
  }
  return removed;
}

function statusFromEntry(entry: SessionSecretEntry): SessionSecretStatus {
  return {
    providerId: entry.providerId,
    storageScope: "session_only",
    configured: true,
    expiresAt: new Date(entry.expiresAt).toISOString(),
    version: entry.version,
  };
}

/**
 * Stores (creates or rotates) a session secret for an allowlisted provider and
 * returns the non-secret status.
 *
 * REPLACEMENT RULE: creating a NEW entry needs no version. Replacing a LIVE
 * entry REQUIRES the matching `expectedVersion`; a missing or stale version is a
 * `VERSION_CONFLICT` and never overwrites the newer secret. An expired/revoked
 * entry is purged first, so a subsequent create is treated as fresh.
 *
 * Throws `SessionSecretError` for unsupported deployments, non-allowlisted
 * providers, invalid/oversized secrets, or version conflicts.
 */
export function setSessionSecret(
  providerId: string,
  secret: string,
  expectedVersion?: string
): SessionSecretStatus {
  if (!isSessionByokSupportedDeployment()) {
    throw new SessionSecretError(
      "SESSION_BYOK_UNSUPPORTED",
      "Session-only BYOK is not supported in this deployment."
    );
  }
  if (!isSessionSecretProviderAllowed(providerId)) {
    throw new SessionSecretError(
      "PROVIDER_NOT_ALLOWED",
      "Session secrets are not allowed for this provider."
    );
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new SessionSecretError("INVALID_SECRET", "A non-empty secret is required.");
  }
  if (secret.length > MAX_SESSION_SECRET_LENGTH) {
    throw new SessionSecretError("SECRET_TOO_LONG", "The secret exceeds the maximum length.");
  }

  const now = Date.now();
  purgeExpired(now);
  const existing = store.get(providerId);
  // REPLACEMENT REQUIRES THE LIVE VERSION. This invariant lives in the STORE,
  // not in future route code:
  //   - existing live entry: `expectedVersion` is REQUIRED and must match.
  //     A missing or stale version is a conflict; the newer secret is untouched.
  //   - no live entry (never created, expired, or revoked): a fresh create is
  //     allowed WITHOUT a version. A version supplied with no live entry is
  //     stale (the referenced entry is gone) and conflicts.
  if (existing) {
    if (expectedVersion === undefined || expectedVersion !== existing.version) {
      throw new SessionSecretError(
        "VERSION_CONFLICT",
        "The session secret changed; refresh and try again."
      );
    }
  } else if (expectedVersion !== undefined) {
    throw new SessionSecretError(
      "VERSION_CONFLICT",
      "The session secret changed; refresh and try again."
    );
  }

  const entry: SessionSecretEntry = {
    providerId,
    secret,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + SESSION_SECRET_ABSOLUTE_TTL_MS,
    version: randomUUID(),
  };
  store.set(providerId, entry);
  return statusFromEntry(entry);
}

/**
 * Reads the live secret for an allowlisted provider, refreshing its idle timer.
 * Returns `undefined` when absent, expired, or in an unsupported deployment.
 * The returned value is for the provider boundary ONLY and must never be logged,
 * serialized, or surfaced to the UI.
 */
export function getSessionSecret(providerId: string): string | undefined {
  if (typeof providerId !== "string") return undefined;
  if (!isSessionByokSupportedDeployment()) return undefined;
  const now = Date.now();
  const entry = store.get(providerId);
  if (!entry) return undefined;
  if (isExpired(entry, now)) {
    store.delete(providerId);
    return undefined;
  }
  entry.lastUsedAt = now;
  return entry.secret;
}

/** Revokes a provider's session secret. Idempotent; future reads return undefined. */
export function revokeSessionSecret(providerId: string): void {
  if (typeof providerId === "string") store.delete(providerId);
}

/**
 * Returns the non-secret status for one provider's session secret. An expired
 * entry is removed first, so `configured` is always truthful. Never exposes the
 * secret, a key fragment, or a secret-derived hash.
 */
export function getSessionSecretStatus(providerId: string): SessionSecretStatus {
  const base: SessionSecretStatus = {
    providerId,
    storageScope: "session_only",
    configured: false,
  };
  if (!isSessionByokSupportedDeployment() || typeof providerId !== "string") return base;
  const now = Date.now();
  const entry = store.get(providerId);
  if (!entry) return base;
  if (isExpired(entry, now)) {
    store.delete(providerId);
    return base;
  }
  return statusFromEntry(entry);
}

/** Removes every expired session secret. Returns the number removed. */
export function clearExpiredSessionSecrets(): number {
  return purgeExpired(Date.now());
}

/** Test seam: clears the entire in-memory store. Never call in production code. */
export function resetSessionSecretsForTests(): void {
  store.clear();
}
