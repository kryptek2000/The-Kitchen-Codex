/**
 * The Kitchen Codex — Transient Generated-Image Preview Store (v0.7 Phase 2B).
 *
 * A bounded, SERVER-SIDE, in-memory store for validated generated-image preview
 * bytes, addressed by an opaque cryptographically-random token. Nothing canonical
 * is mutated here; the store holds ONLY what preview retrieval needs.
 *
 * RECORD SHAPE (deliberately minimal):
 *   { bytes, contentType, provider, model, createdAt, expiresAt }
 *   - NO prompt (the raw prompt is transient to the provider call and never stored).
 *   - NO recipe title / path / user data.
 *   - The token itself is opaque and safe to log: it embeds nothing.
 *
 * BOUNDS: hard TTL (5 minutes) and a hard total-bytes cap (50 MB). Insertion that
 * would exceed the cap is REJECTED cleanly (no arbitrary eviction, no corruption of
 * accounting). Cleanup sweeps on access plus an optional timer that is `.unref()`ed
 * so it never keeps the test/process teardown hanging.
 *
 * TOKEN POLICY: multi-read until expiry (browser <img> retries stay reliable); the
 * token is never consumed by a read. Expiry invalidates access.
 */

import { randomBytes } from 'node:crypto';
import type { GeneratedImageMime } from '../src/core/recipeImage.js';
import type { RepresentativeImageProvenance } from '../src/core/representativeImage.js';

export const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_PREVIEW_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** Hard cap on stored + reserved ENTRIES (bounds entry-count abuse). */
export const DEFAULT_PREVIEW_MAX_ENTRIES = 256;
/**
 * Hard TTL for a capacity RESERVATION. It must exceed the provider generation
 * timeout (60s) so a reservation is never swept while a legitimate provider call
 * is still in flight; 2 minutes gives a safe margin.
 */
export const DEFAULT_PREVIEW_RESERVATION_TTL_MS = 2 * 60 * 1000;
/** Strict per-requester cap on outstanding capacity reservations. */
export const DEFAULT_PREVIEW_MAX_RESERVATIONS_PER_REQUESTER = 4;

export interface ImagePreviewRecord {
  bytes: Uint8Array;
  contentType: GeneratedImageMime;
  provider: string;
  model: string;
  createdAt: number;
  expiresAt: number;
  /**
   * Optional representative-image provenance (Phase 1). Present only for a
   * licensed representative image selected by the user; absent for AI generation.
   */
  provenance?: RepresentativeImageProvenance;
  /**
   * Requester owner (server-derived, never client-supplied). When present,
   * retrieval and deletion require the same requester: token possession alone
   * never crosses requester boundaries. Records inserted without an owner
   * (direct unit-test inserts) remain ownerless for backward compatibility.
   */
  owner?: string;
}

export interface ImagePreviewMetadata {
  token: string;
  contentType: GeneratedImageMime;
  bytes: number;
  provider: string;
  model: string;
  createdAt: number;
  expiresAt: number;
  provenance?: RepresentativeImageProvenance;
}

export class PreviewStoreCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewStoreCapacityError';
  }
}

/**
 * A bounded, process-memory CAPACITY RESERVATION for one in-flight generation.
 * It holds worst-case byte capacity (and one entry slot) BEFORE the provider is
 * called, so a full store can never charge for an image it cannot retain. It
 * contains NO image bytes and NO credentials.
 */
export interface ImagePreviewReservation {
  /** Opaque reservation token (process-memory only). */
  token: string;
  /** Worst-case bytes reserved. */
  reservedBytes: number;
  expiresAt: number;
}

export interface ImagePreviewStoreOptions {
  ttlMs?: number;
  maxTotalBytes?: number;
  /** Hard cap on stored + reserved entries. Defaults to 256. */
  maxEntries?: number;
  /** Reservation TTL. Defaults to 2 minutes (exceeds the 60s provider timeout). */
  reservationTtlMs?: number;
  /** Strict per-requester cap on outstanding reservations. Defaults to 4. */
  maxReservationsPerRequester?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable token source (tests); defaults to 32 bytes of crypto randomness. */
  createToken?: () => string;
  /**
   * Injectable periodic-cleanup scheduler. Defaults to a `setInterval(...).unref()`
   * sweep so a long-lived server self-cleans without hanging test teardown.
   */
  scheduleCleanup?: (cleanup: () => void, intervalMs: number) => () => void;
}

interface InternalRecord extends ImagePreviewRecord {
  token: string;
}

export class ImagePreviewStore {
  private records = new Map<string, InternalRecord>();
  private reservations = new Map<string, { token: string; reservedBytes: number; expiresAt: number; requesterId?: string }>();
  private totalBytes = 0;
  private reservedBytes = 0;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;
  private readonly reservationTtlMs: number;
  private readonly maxReservationsPerRequester: number;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private stopCleanup: (() => void) | undefined;

  constructor(options: ImagePreviewStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_PREVIEW_MAX_TOTAL_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_PREVIEW_MAX_ENTRIES;
    this.reservationTtlMs = options.reservationTtlMs ?? DEFAULT_PREVIEW_RESERVATION_TTL_MS;
    this.maxReservationsPerRequester = options.maxReservationsPerRequester ?? DEFAULT_PREVIEW_MAX_RESERVATIONS_PER_REQUESTER;
    this.now = options.now ?? (() => Date.now());
    this.createToken =
      options.createToken ??
      (() => randomBytes(32).toString('base64url'));
    const interval = Math.max(1000, Math.floor(this.ttlMs / 4));
    const cleanup = options.scheduleCleanup ?? defaultScheduleCleanup;
    this.stopCleanup = cleanup(() => this.sweep(), interval);
  }

  /**
   * Reserves worst-case capacity (and one entry slot) for an in-flight
   * generation. Throws `PreviewStoreCapacityError` when the store cannot
   * guarantee room, so the caller can fail closed BEFORE any provider call.
   * Reservations are bounded globally, per-requester (when a requester is
   * supplied), and by bytes: an entry slot held here can never be consumed by
   * a direct `insert()` (which counts reservations against the entry cap).
   */
  reserve(bytes: number, requesterId?: string): ImagePreviewReservation {
    this.sweep();
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > this.maxTotalBytes) {
      throw new PreviewStoreCapacityError('Reservation size is invalid.');
    }
    if (this.records.size + this.reservations.size >= this.maxEntries) {
      throw new PreviewStoreCapacityError('Image preview store is at entry capacity.');
    }
    if (this.totalBytes + this.reservedBytes + bytes > this.maxTotalBytes) {
      throw new PreviewStoreCapacityError('Image preview store is at capacity.');
    }
    if (requesterId) {
      let perRequester = 0;
      for (const held of this.reservations.values()) {
        if (held.requesterId === requesterId) perRequester += 1;
      }
      if (perRequester >= this.maxReservationsPerRequester) {
        throw new PreviewStoreCapacityError('Image preview reservations are at capacity for this requester.');
      }
    }
    const token = this.createToken();
    if (!token || this.reservations.has(token) || this.records.has(token)) {
      throw new PreviewStoreCapacityError('Could not allocate a unique reservation token.');
    }
    const now = this.now();
    this.reservations.set(token, {
      token,
      reservedBytes: bytes,
      expiresAt: now + this.reservationTtlMs,
      ...(requesterId ? { requesterId } : {}),
    });
    this.reservedBytes += bytes;
    return { token, reservedBytes: bytes, expiresAt: now + this.reservationTtlMs };
  }

  /**
   * Commits a reservation with the ACTUAL validated bytes: releases the unused
   * reserved capacity and stores the record. An unknown/expired reservation fails
   * closed (the caller must not have called the provider). The commit re-checks
   * caps through `insert`, so its own released reservation is never double-counted.
   */
  commit(
    reservation: ImagePreviewReservation | string,
    input: {
      bytes: Uint8Array;
      contentType: GeneratedImageMime;
      provider: string;
      model: string;
      provenance?: RepresentativeImageProvenance;
    },
    owner?: string
  ): ImagePreviewMetadata {
    const token = typeof reservation === 'string' ? reservation : reservation.token;
    if (!this.release(token)) {
      throw new PreviewStoreCapacityError('The preview reservation is no longer valid.');
    }
    // `insert` re-checks the byte/entry caps against the now-released capacity.
    return this.insert(input, owner);
  }

  /** Releases a reservation. Idempotent; returns true only when it was held. */
  release(reservation: ImagePreviewReservation | string): boolean {
    const token = typeof reservation === 'string' ? reservation : reservation.token;
    if (typeof token !== 'string' || !token) return false;
    const held = this.reservations.get(token);
    if (!held) return false;
    this.reservations.delete(token);
    this.reservedBytes = Math.max(0, this.reservedBytes - held.reservedBytes);
    return true;
  }

  /**
   * Stores validated preview bytes and returns opaque token metadata. The entry
   * cap counts OUTSTANDING reservations, so a direct insertion can never consume
   * an entry slot reserved for an in-flight generation (representative-insertion
   * race closed at the store boundary).
   */
  insert(input: {
    bytes: Uint8Array;
    contentType: GeneratedImageMime;
    provider: string;
    model: string;
    provenance?: RepresentativeImageProvenance;
  }, owner?: string): ImagePreviewMetadata {
    const now = this.now();
    this.sweep();
    const size = input.bytes.length;
    if (size <= 0) throw new PreviewStoreCapacityError('Preview bytes must not be empty.');
    if (this.records.size + this.reservations.size >= this.maxEntries) {
      throw new PreviewStoreCapacityError('Image preview store is at entry capacity.');
    }
    if (this.totalBytes + this.reservedBytes + size > this.maxTotalBytes) {
      throw new PreviewStoreCapacityError('Image preview store is at capacity.');
    }
    // Account BEFORE mutating: a token collision/failure must not corrupt accounting.
    const token = this.createToken();
    if (!token || this.records.has(token) || this.reservations.has(token)) {
      throw new PreviewStoreCapacityError('Could not allocate a unique preview token.');
    }
    this.totalBytes += size;
    const record: InternalRecord = {
      token,
      bytes: input.bytes,
      contentType: input.contentType,
      provider: input.provider,
      model: input.model,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(owner ? { owner } : {}),
    };
    this.records.set(token, record);
    return this.toMetadata(record);
  }

  /**
   * Multi-read lookup until expiry; expired/unknown tokens are inaccessible. A
   * record bound to a requester is invisible to any other requester (token
   * possession alone never crosses requester boundaries); ownerless records
   * remain readable for backward compatibility.
   */
  get(token: string, owner?: string): ImagePreviewRecord | undefined {
    const record = this.records.get(token);
    if (!record) return undefined;
    if (this.now() >= record.expiresAt) {
      this.remove(token);
      return undefined;
    }
    if (record.owner !== undefined && (owner === undefined || owner !== record.owner)) {
      return undefined;
    }
    return record;
  }

  /**
   * Removes one record (adjusts byte accounting). A requester-bound record is
   * removable only by its owner; mismatches report false (no existence oracle).
   */
  remove(token: string, owner?: string): boolean {
    const record = this.records.get(token);
    if (!record) return false;
    if (record.owner !== undefined && (owner === undefined || owner !== record.owner)) {
      return false;
    }
    this.records.delete(token);
    this.totalBytes = Math.max(0, this.totalBytes - record.bytes.length);
    return true;
  }

  /** Removes every record/reservation and resets byte accounting. */
  clear(): void {
    this.records.clear();
    this.reservations.clear();
    this.totalBytes = 0;
    this.reservedBytes = 0;
  }

  /** Bounded observability for tests/ops (no bytes/credentials exposed). */
  stats(): { count: number; totalBytes: number; reservedCount: number; reservedBytes: number } {
    return {
      count: this.records.size,
      totalBytes: this.totalBytes,
      reservedCount: this.reservations.size,
      reservedBytes: this.reservedBytes,
    };
  }
  /** Sweeps expired records AND reservations (also invoked lazily on access). */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [token, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(token);
        this.totalBytes = Math.max(0, this.totalBytes - record.bytes.length);
        removed += 1;
      }
    }
    for (const [token, reservation] of this.reservations) {
      if (now >= reservation.expiresAt) {
        this.reservations.delete(token);
        this.reservedBytes = Math.max(0, this.reservedBytes - reservation.reservedBytes);
        removed += 1;
      }
    }
    return removed;
  }

  /** Stops the periodic cleanup timer (test/process teardown). */
  dispose(): void {
    this.stopCleanup?.();
    this.stopCleanup = undefined;
    this.clear();
  }

  private toMetadata(record: InternalRecord): ImagePreviewMetadata {
    return {
      token: record.token,
      contentType: record.contentType,
      bytes: record.bytes.length,
      provider: record.provider,
      model: record.model,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.provenance ? { provenance: record.provenance } : {}),
    };
  }
}

/** Default cleanup scheduler: unref'd interval (never hangs process teardown). */
function defaultScheduleCleanup(cleanup: () => void, intervalMs: number): () => void {
  const timer = setInterval(() => cleanup(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
