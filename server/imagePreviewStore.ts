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

export const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_PREVIEW_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface ImagePreviewRecord {
  bytes: Uint8Array;
  contentType: GeneratedImageMime;
  provider: string;
  model: string;
  createdAt: number;
  expiresAt: number;
}

export interface ImagePreviewMetadata {
  token: string;
  contentType: GeneratedImageMime;
  bytes: number;
  provider: string;
  model: string;
  createdAt: number;
  expiresAt: number;
}

export class PreviewStoreCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewStoreCapacityError';
  }
}

export interface ImagePreviewStoreOptions {
  ttlMs?: number;
  maxTotalBytes?: number;
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
  private totalBytes = 0;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private stopCleanup: (() => void) | undefined;

  constructor(options: ImagePreviewStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_PREVIEW_MAX_TOTAL_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.createToken =
      options.createToken ??
      (() => randomBytes(32).toString('base64url'));
    const interval = Math.max(1000, Math.floor(this.ttlMs / 4));
    const cleanup = options.scheduleCleanup ?? defaultScheduleCleanup;
    this.stopCleanup = cleanup(() => this.sweep(), interval);
  }

  /** Stores validated preview bytes and returns opaque token metadata. */
  insert(input: {
    bytes: Uint8Array;
    contentType: GeneratedImageMime;
    provider: string;
    model: string;
  }): ImagePreviewMetadata {
    const now = this.now();
    this.sweep();
    const size = input.bytes.length;
    if (size <= 0) throw new PreviewStoreCapacityError('Preview bytes must not be empty.');
    if (this.totalBytes + size > this.maxTotalBytes) {
      throw new PreviewStoreCapacityError('Image preview store is at capacity.');
    }
    // Account BEFORE mutating: a token collision/failure must not corrupt accounting.
    const token = this.createToken();
    if (!token || this.records.has(token)) {
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
    };
    this.records.set(token, record);
    return this.toMetadata(record);
  }

  /** Multi-read lookup until expiry; expired/unknown tokens are inaccessible. */
  get(token: string): ImagePreviewRecord | undefined {
    const record = this.records.get(token);
    if (!record) return undefined;
    if (this.now() >= record.expiresAt) {
      this.remove(token);
      return undefined;
    }
    return record;
  }

  /** Removes one record (adjusts byte accounting). */
  remove(token: string): boolean {
    const record = this.records.get(token);
    if (!record) return false;
    this.records.delete(token);
    this.totalBytes = Math.max(0, this.totalBytes - record.bytes.length);
    return true;
  }

  /** Removes every record and resets byte accounting. */
  clear(): void {
    this.records.clear();
    this.totalBytes = 0;
  }

  /** Bounded observability for tests/ops (no bytes exposed). */
  stats(): { count: number; totalBytes: number } {
    return { count: this.records.size, totalBytes: this.totalBytes };
  }

  /** Sweeps expired records (also invoked lazily on insert). */
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
    };
  }
}

/** Default cleanup scheduler: unref'd interval (never hangs process teardown). */
function defaultScheduleCleanup(cleanup: () => void, intervalMs: number): () => void {
  const timer = setInterval(() => cleanup(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
