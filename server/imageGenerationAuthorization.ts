/**
 * The Kitchen Codex — Image-generation authorization store (Phase 2).
 *
 * A small, PROCESS-MEMORY, bounded, single-use authorization for a paid/variable
 * image generation. A client boolean (`costAcknowledged: true`) is NOT authority:
 * the server issues an opaque cryptographically-random token AFTER it has resolved
 * the effective image selection and the trusted pricing state, and the generate
 * route consumes that token atomically immediately before the sole provider call.
 *
 * BINDING: a token is bound to the requester identity (the existing trusted
 * client-IP policy), provider, exact model, credential source, cost class,
 * pricing fingerprint (when OpenRouter pricing exists), the SERVER-RECOMPUTED
 * canonical recipe binding, the explicit vault scope, issue/expiry time,
 * single-use state, and the authorization contract version. A client-supplied
 * hash is never authority: both quote and generate recompute the binding from
 * the validated generation fields with the shared canonical contract.
 *
 * NEVER STORED: credentials, credential hashes/fragments, prompts, recipe
 * contents, image bytes, or raw provider/catalog responses.
 *
 * BOUNDS: short TTL (5 min), strict per-requester and global capacity, synchronous
 * expiry. Invalid/expired/used/mismatched tokens all fail closed.
 */

import { randomBytes } from "node:crypto";
import type { CredentialSource } from "./ai/credentialResolver.js";
import type { ImageCostClass } from "./ai/imagePricing.js";

/** The authorization contract version (bump to invalidate old tokens). */
export const IMAGE_GENERATION_AUTH_CONTRACT_VERSION = "image_generation_auth_v1";

export const DEFAULT_IMAGE_GENERATION_AUTH_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_IMAGE_GENERATION_AUTH_MAX_PER_REQUESTER = 8;
export const DEFAULT_IMAGE_GENERATION_AUTH_MAX_GLOBAL = 64;

/** The server-owned quote binding used to issue and consume a token. */
export interface ImageGenerationAuthorizationBinding {
  providerId: string;
  modelId: string;
  credentialSource: CredentialSource;
  /**
   * The opaque, server-owned credential GENERATION for the exact provider at the
   * time the quote was issued. It is a lifecycle counter (never secret-derived):
   * session-key set/replace/revoke/expiry/purge bumps it, so a quote issued under
   * one credential lease can never authorize a call under a different one.
   */
  credentialGeneration: number;
  costClass: ImageCostClass;
  pricingFingerprint?: string;
  /**
   * Server-recomputed canonical binding over the validated generation fields
   * (title/ingredients/cuisine/course/description). REQUIRED — never omitted,
   * never client-supplied.
   */
  recipeBinding: string;
  /**
   * Explicit server-owned vault scope (`vault:<session>` or `draft:no-vault`).
   * REQUIRED — a draft token can never authorize a vault generation or reverse.
   */
  vaultScope: string;
}

export interface ImageGenerationAuthorization {
  token: string;
  expiresAt: number;
}

/** Why an authorization was rejected (all fail closed, zero provider calls). */
export type ImageGenerationAuthorizationFailure =
  | "MISSING"
  | "INVALID"
  | "EXPIRED"
  | "USED"
  | "REQUESTER_MISMATCH"
  | "MISMATCH"
  | "CAPACITY";

export type ImageGenerationAuthorizationConsume =
  | { ok: true }
  | { ok: false; reason: ImageGenerationAuthorizationFailure };

/** Thrown when the store cannot issue a token within its bounds. */
export class ImageGenerationAuthorizationCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationAuthorizationCapacityError";
  }
}

interface InternalRecord extends ImageGenerationAuthorizationBinding {
  token: string;
  requesterId: string;
  /** The exact authorization contract version this record was issued under. */
  contractVersion: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
}

export interface ImageGenerationAuthorizationStoreOptions {
  ttlMs?: number;
  maxPerRequester?: number;
  maxGlobal?: number;
  now?: () => number;
  createToken?: () => string;
  /**
   * TEST SEAM ONLY: overrides the contract version stamped on issued records, so
   * a legacy/unknown-version record can be exercised. Production never sets it
   * (defaults to the current `IMAGE_GENERATION_AUTH_CONTRACT_VERSION`).
   */
  contractVersion?: string;
}

function normalizeOptional(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * In-memory, single-use authorization store. Not persisted; lost on restart.
 */
export class ImageGenerationAuthorizationStore {
  private records = new Map<string, InternalRecord>();
  private readonly ttlMs: number;
  private readonly maxPerRequester: number;
  private readonly maxGlobal: number;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly issuedContractVersion: string;

  constructor(options: ImageGenerationAuthorizationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_IMAGE_GENERATION_AUTH_TTL_MS;
    this.maxPerRequester = options.maxPerRequester ?? DEFAULT_IMAGE_GENERATION_AUTH_MAX_PER_REQUESTER;
    this.maxGlobal = options.maxGlobal ?? DEFAULT_IMAGE_GENERATION_AUTH_MAX_GLOBAL;
    this.now = options.now ?? (() => Date.now());
    this.createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.issuedContractVersion = options.contractVersion ?? IMAGE_GENERATION_AUTH_CONTRACT_VERSION;
  }

  /** Removes every expired record; returns the number removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [token, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Issues a single-use token for a resolved paid/variable selection. Capacity is
   * strict: an over-capacity issue throws (the route maps it to a bounded 503).
   */
  issue(requesterId: string, binding: ImageGenerationAuthorizationBinding): ImageGenerationAuthorization {
    this.sweep();
    let perRequester = 0;
    for (const record of this.records.values()) {
      if (record.requesterId === requesterId) perRequester += 1;
    }
    if (perRequester >= this.maxPerRequester || this.records.size >= this.maxGlobal) {
      throw new ImageGenerationAuthorizationCapacityError("Image generation authorization is at capacity.");
    }
    const now = this.now();
    const token = this.createToken();
    if (!token || this.records.has(token)) {
      throw new ImageGenerationAuthorizationCapacityError("Could not allocate a unique authorization token.");
    }
    const record: InternalRecord = {
      token,
      requesterId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      credentialSource: binding.credentialSource,
      credentialGeneration: binding.credentialGeneration,
      costClass: binding.costClass,
      ...(normalizeOptional(binding.pricingFingerprint) ? { pricingFingerprint: binding.pricingFingerprint } : {}),
      recipeBinding: binding.recipeBinding,
      vaultScope: binding.vaultScope,
      contractVersion: this.issuedContractVersion,
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      used: false,
    };
    this.records.set(token, record);
    return { token, expiresAt: record.expiresAt };
  }

  /**
   * Verifies a token against the requester + expected binding and, only on a full
   * match, atomically marks it used. A mismatch/expiry/unknown/used token makes
   * zero provider calls and (for a binding mismatch) does NOT consume the token.
   */
  consume(
    token: unknown,
    requesterId: string,
    expected: ImageGenerationAuthorizationBinding
  ): ImageGenerationAuthorizationConsume {
    this.sweep();
    if (typeof token !== "string" || token.length === 0 || token.length > 512) {
      return { ok: false, reason: "MISSING" };
    }
    const record = this.records.get(token);
    if (!record) return { ok: false, reason: "INVALID" };
    if (this.now() >= record.expiresAt) {
      this.records.delete(token);
      return { ok: false, reason: "EXPIRED" };
    }
    if (record.used) return { ok: false, reason: "USED" };
    // Contract-version enforcement: a legacy/unknown record version never
    // authorizes a call. The current version is required exactly.
    if (record.contractVersion !== IMAGE_GENERATION_AUTH_CONTRACT_VERSION) {
      return { ok: false, reason: "MISMATCH" };
    }
    if (record.requesterId !== requesterId) return { ok: false, reason: "REQUESTER_MISMATCH" };

    const matches =
      record.providerId === expected.providerId &&
      record.modelId === expected.modelId &&
      record.credentialSource === expected.credentialSource &&
      record.credentialGeneration === expected.credentialGeneration &&
      record.costClass === expected.costClass &&
      normalizeOptional(record.pricingFingerprint) === normalizeOptional(expected.pricingFingerprint) &&
      record.recipeBinding === expected.recipeBinding &&
      record.vaultScope === expected.vaultScope;
    if (!matches) return { ok: false, reason: "MISMATCH" };

    // Atomic single-use consumption: synchronous, immediately before the provider call.
    record.used = true;
    return { ok: true };
  }

  /** Bounded observability (never exposes tokens). */
  stats(): { count: number } {
    return { count: this.records.size };
  }

  /** Removes every record (test/teardown only). */
  clear(): void {
    this.records.clear();
  }
}
