/**
 * The Kitchen Codex — capability verification store (v0.8.x).
 *
 * SERVER PROCESS MEMORY ONLY. A successful capability verification is recorded
 * here so a dynamically discovered model can become executable WITHOUT trusting
 * OpenRouter catalog metadata claims. It is deliberately a LEAF module (no
 * imports) so the catalog can consult it without a module cycle.
 *
 * NEVER PERSISTED. This store has no disk, localStorage, IndexedDB, Obsidian
 * vault, plugin data.json, or Markdown surface. A process restart clears it.
 *
 * TRUTH BINDING:
 *   A verification is valid ONLY while it is bound to:
 *     - the exact providerId + modelId,
 *     - the CURRENT catalog fingerprint (pricing + capability metadata), and
 *     - the CURRENT capability-probe version.
 *   A price change, a capability change, a probe-version bump, a TTL expiry, or
 *   a model disappearing from the trusted catalog all invalidate it. A stale
 *   verification can NEVER outlive pricing safety.
 */

/** The versioned capability profile a successful strict probe establishes. */
export const STRICT_JSON_SCHEMA_PROFILE = "strict_json_schema_v1";

/** The current capability-probe version. Bump to invalidate all verifications. */
export const CAPABILITY_PROBE_VERSION = STRICT_JSON_SCHEMA_PROFILE;

/** Bounded in-memory TTL for a successful verification (45 minutes). */
export const CAPABILITY_VERIFICATION_TTL_MS = 45 * 60 * 1000;

/** A server-memory capability-verification record (never persisted). */
export interface CapabilityVerificationRecord {
  providerId: string;
  modelId: string;
  /** Catalog fingerprint the verification was bound to. */
  catalogFingerprint: string;
  /** Capability-probe/profile version. */
  probeVersion: string;
  /** When the successful verification completed (epoch ms). */
  verifiedAt: number;
}

const store = new Map<string, CapabilityVerificationRecord>();

function keyFor(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/** Records (or refreshes) a successful verification. Server memory only. */
export function recordCapabilityVerification(record: CapabilityVerificationRecord): void {
  store.set(keyFor(record.providerId, record.modelId), { ...record });
}

/** Reads the raw record (for observability/tests), or undefined. */
export function getCapabilityVerification(
  providerId: string,
  modelId: string
): CapabilityVerificationRecord | undefined {
  const record = store.get(keyFor(providerId, modelId));
  return record ? { ...record } : undefined;
}

/**
 * True when a CURRENT, non-expired, fingerprint-bound verification exists for the
 * exact provider/model/profile. Any mismatch (fingerprint, version) or expiry
 * returns false. `now` is a test seam.
 */
export function isCapabilityVerified(
  providerId: string,
  modelId: string,
  currentFingerprint: string,
  now: number = Date.now()
): boolean {
  const record = store.get(keyFor(providerId, modelId));
  if (!record) return false;
  if (record.probeVersion !== CAPABILITY_PROBE_VERSION) return false;
  if (record.catalogFingerprint !== currentFingerprint) return false;
  if (!Number.isFinite(record.verifiedAt)) return false;
  const age = now - record.verifiedAt;
  if (age < 0 || age >= CAPABILITY_VERIFICATION_TTL_MS) return false;
  return true;
}

/** Removes a verification (used when a model is known to be invalid). */
export function invalidateCapabilityVerification(providerId: string, modelId: string): void {
  store.delete(keyFor(providerId, modelId));
}

/** Test seam: clears every verification record. Never call from production. */
export function clearCapabilityVerificationsForTests(): void {
  store.clear();
}

/** Observability: the number of records currently held (non-secret). */
export function capabilityVerificationCount(): number {
  return store.size;
}
