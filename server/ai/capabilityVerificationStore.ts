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
import { STRICT_JSON_SCHEMA_PROFILE, isOpenRouterProfile, type OpenRouterProfile } from '../../src/core/ai/openRouterProfile.js';
export { STRICT_JSON_SCHEMA_PROFILE };

/** The current capability-probe version. Bump to invalidate all verifications. */
export const CAPABILITY_PROBE_VERSION = 'free_text_output_v2';

/** Bounded in-memory TTL for a successful verification (45 minutes). */
export const CAPABILITY_VERIFICATION_TTL_MS = 45 * 60 * 1000;

/**
 * The SEPARATE recipe-generation capability probe version. It is deliberately
 * distinct from the text-profile probe: a trivial `{ok:true}` profile probe can
 * NEVER grant recipe generation.
 */
export const RECIPE_GENERATION_PROBE_VERSION = 'recipe_generation_v1';

/** Bounded in-memory TTL for a successful recipe-generation verification (30 min). */
export const RECIPE_GENERATION_TTL_MS = 30 * 60 * 1000;

/** A server-memory capability-verification record (never persisted). */
export interface CapabilityVerificationRecord {
  /** New writes are explicit. Absent legacy records mean strict, never JSON mode. */
  profile?: OpenRouterProfile;
  providerId: string;
  modelId: string;
  /** Catalog fingerprint the verification was bound to. */
  catalogFingerprint: string;
  /** Capability-probe/profile version. */
  probeVersion: string;
  /** When the successful verification completed (epoch ms). */
  verifiedAt: number;
  /**
   * Monotonic, server-owned profile-verification INSTANCE. Every recorded
   * verification gets a new instance, so a dependent recipe authorization can be
   * bound to the exact profile verification it was proven against. A new profile
   * verification (even for the same model/profile) supersedes the old instance.
   */
  instance?: number;
}

/**
 * A SEPARATE, process-memory recipe-generation capability record. It is never
 * persisted and never overloads the text-profile record.
 */
export interface RecipeGenerationVerificationRecord {
  capability: 'recipe_generation_v1';
  providerId: string;
  modelId: string;
  /** The exact profile the recipe probe ran under. */
  profile: OpenRouterProfile;
  /** The exact profile-verification INSTANCE this authorization is bound to. */
  profileInstance: number;
  /** Safe opaque per-provider credential generation (never secret-derived). */
  credentialGeneration: number;
  /** The exact credential source used for the probe. */
  credentialSource: 'server_environment' | 'session_only';
  /** Catalog fingerprint the capability was bound to. */
  catalogFingerprint: string;
  /** Recipe-generation probe version. */
  probeVersion: string;
  /** When the successful recipe verification completed (epoch ms). */
  verifiedAt: number;
}

const store = new Map<string, CapabilityVerificationRecord>();
const recipeStore = new Map<string, RecipeGenerationVerificationRecord>();

/** Monotonic profile-verification instance counter (server-owned). */
let verificationInstanceCounter = 0;

/**
 * Safe, opaque, per-provider credential GENERATION. It is bumped whenever a
 * session credential is saved, replaced, revoked, expired, or cleared. It is NOT
 * derived from any secret; it is a lifecycle counter used to invalidate dependent
 * recipe authorization when the credential lifecycle changes.
 */
const credentialGenerations = new Map<string, number>();

export function bumpCredentialGeneration(providerId: string): void {
  if (typeof providerId !== 'string' || providerId.length === 0) return;
  credentialGenerations.set(providerId, (credentialGenerations.get(providerId) ?? 0) + 1);
}

export function getCredentialGeneration(providerId: string): number {
  return credentialGenerations.get(providerId) ?? 0;
}

export function clearCredentialGenerationsForTests(): void {
  credentialGenerations.clear();
}

function keyFor(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/**
 * Records (or refreshes) a successful verification. Server memory only. A new
 * instance is assigned unless the caller supplies one (test seam), so every
 * recorded verification is a distinct profile-verification instance.
 */
export function recordCapabilityVerification(record: CapabilityVerificationRecord): void {
  const instance =
    typeof record.instance === 'number' ? record.instance : ++verificationInstanceCounter;
  store.set(keyFor(record.providerId, record.modelId), { ...record, instance });
}

/** Records (or refreshes) a successful RECIPE-GENERATION verification. Memory only. */
export function recordRecipeGenerationVerification(
  record: RecipeGenerationVerificationRecord
): void {
  recipeStore.set(keyFor(record.providerId, record.modelId), { ...record });
}

/** Reads the raw recipe-generation record (observability/tests), or undefined. */
export function getRecipeGenerationVerification(
  providerId: string,
  modelId: string
): RecipeGenerationVerificationRecord | undefined {
  const record = recipeStore.get(keyFor(providerId, modelId));
  return record ? { ...record } : undefined;
}

/**
 * True when a CURRENT recipe-generation record exists and, when the corresponding
 * bindings are supplied, matches the exact profile-verification instance,
 * credential generation, and catalog fingerprint. `now` is a test seam.
 */
export function isRecipeGenerationVerified(
  providerId: string,
  modelId: string,
  currentFingerprint: string,
  opts: { profileInstance?: number; credentialGeneration?: number; now?: number } = {}
): boolean {
  const record = recipeStore.get(keyFor(providerId, modelId));
  if (!record) return false;
  if (record.capability !== 'recipe_generation_v1') return false;
  if (record.probeVersion !== RECIPE_GENERATION_PROBE_VERSION) return false;
  if (record.catalogFingerprint !== currentFingerprint) return false;
  if (!Number.isFinite(record.verifiedAt)) return false;
  if (opts.profileInstance !== undefined && record.profileInstance !== opts.profileInstance) return false;
  if (
    opts.credentialGeneration !== undefined &&
    record.credentialGeneration !== opts.credentialGeneration
  ) {
    return false;
  }
  const now = opts.now ?? Date.now();
  const age = now - record.verifiedAt;
  if (age < 0 || age >= RECIPE_GENERATION_TTL_MS) return false;
  return true;
}

/** Removes a recipe-generation verification. */
export function invalidateRecipeGenerationVerification(providerId: string, modelId: string): void {
  recipeStore.delete(keyFor(providerId, modelId));
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
  if (record.profile !== undefined && !isOpenRouterProfile(record.profile)) return false;
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
  recipeStore.delete(keyFor(providerId, modelId));
}

/** Test seam: clears every verification record. Never call from production. */
export function clearCapabilityVerificationsForTests(): void {
  store.clear();
  recipeStore.clear();
  verificationInstanceCounter = 0;
}

/** Observability: the number of records currently held (non-secret). */
export function capabilityVerificationCount(): number {
  return store.size;
}

/** Observability: the number of recipe-generation records currently held. */
export function recipeGenerationVerificationCount(): number {
  return recipeStore.size;
}
