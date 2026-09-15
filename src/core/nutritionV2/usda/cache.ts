/**
 * The Kitchen Codex — Advanced Nutrition Phase 1: bounded in-memory cache.
 *
 * PURE, platform-neutral. A PERFORMANCE LAYER ONLY, never an authority source.
 * It caches validated canonical records keyed by bundle release + FDC id and
 * verifies the stored canonical digest on read. Raw USDA input is never cached.
 *
 * BOUNDS & EVICTION
 * -----------------
 *   - entry count and total UTF-8 serialized bytes are bounded by caller options
 *     clamped to hard maxima;
 *   - a single oversized entry is rejected, never truncated;
 *   - deterministic LRU eviction (Map insertion order, re-inserted on access);
 *   - replacement and eviction update byte accounting exactly;
 *   - release-specific invalidation and explicit clear.
 *
 * NO timers, no hidden persistence, no IndexedDB/localStorage/filesystem/vault
 * writes, no cross-user or cross-vault namespace, and no cache-driven trust
 * upgrade (a malformed record can never enter the cache).
 */

import { serializedBlockBytes } from '../schema';
import { validateCanonicalRecord } from './record';
import { type CanonicalUsdaFoodRecord } from './types';

export const MAX_USDA_CACHE_ENTRIES_HARD = 256;
export const MAX_USDA_CACHE_BYTES_HARD = 4 * 1024 * 1024;
export const MAX_USDA_CACHE_ENTRY_BYTES = 256 * 1024;
export const MIN_USDA_CACHE_BYTES = 1024;
export const DEFAULT_USDA_CACHE_ENTRIES = 64;
export const DEFAULT_USDA_CACHE_BYTES = 1024 * 1024;

export type UsdaCacheFailureCode = 'invalid_record' | 'entry_too_large';
export type UsdaCacheSetResult = { ok: true } | { ok: false; code: UsdaCacheFailureCode };
export type UsdaCacheGetResult =
  | { ok: true; record: CanonicalUsdaFoodRecord }
  | { ok: false; code: 'not_found' };

export interface UsdaCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface UsdaCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly size: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface UsdaRecordCache {
  get(bundleRelease: string, fdcId: number): UsdaCacheGetResult;
  set(record: unknown): UsdaCacheSetResult;
  has(bundleRelease: string, fdcId: number): boolean;
  invalidateRelease(bundleRelease: string): number;
  clear(): void;
  size(): number;
  bytes(): number;
  stats(): UsdaCacheStats;
}

interface CacheEntry {
  readonly record: CanonicalUsdaFoodRecord;
  readonly digest: string;
  readonly bytes: number;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return fallback;
  return value > max ? max : value;
}

function makeKey(bundleRelease: string, fdcId: number): string {
  return `${bundleRelease}::${fdcId}`;
}

/**
 * Creates a bounded in-memory cache for trusted records. Options are clamped to
 * safe hard maxima; an entry larger than the per-entry bound or the total byte
 * bound is rejected.
 */
export function createUsdaRecordCache(options: UsdaCacheOptions = {}): UsdaRecordCache {
  const maxEntries = clamp(options.maxEntries, 1, MAX_USDA_CACHE_ENTRIES_HARD, DEFAULT_USDA_CACHE_ENTRIES);
  const maxBytes = clamp(options.maxBytes, MIN_USDA_CACHE_BYTES, MAX_USDA_CACHE_BYTES_HARD, DEFAULT_USDA_CACHE_BYTES);

  const entries = new Map<string, CacheEntry>();
  let totalBytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  function remove(key: string): void {
    const entry = entries.get(key);
    if (entry) {
      totalBytes -= entry.bytes;
      entries.delete(key);
    }
  }

  function evictUntil(neededEntries: number, neededBytes: number): boolean {
    while ((entries.size > neededEntries || totalBytes + neededBytes > maxBytes) && entries.size > 0) {
      const lru = entries.keys().next().value as string | undefined;
      if (lru === undefined) break;
      remove(lru);
      evictions += 1;
    }
    return entries.size <= neededEntries && totalBytes + neededBytes <= maxBytes;
  }

  return Object.freeze({
    get(bundleRelease: string, fdcId: number): UsdaCacheGetResult {
      if (typeof bundleRelease !== 'string') {
        misses += 1;
        return { ok: false, code: 'not_found' };
      }
      const key = makeKey(bundleRelease, fdcId);
      const entry = entries.get(key);
      if (!entry || entry.record.record_digest !== entry.digest) {
        misses += 1;
        return { ok: false, code: 'not_found' };
      }
      hits += 1;
      entries.delete(key);
      entries.set(key, entry); // move to MRU end
      return { ok: true, record: entry.record };
    },

    set(record: unknown): UsdaCacheSetResult {
      const validation = validateCanonicalRecord(record);
      if (!validation.ok) return { ok: false, code: 'invalid_record' };
      const canonical = validation.record;
      const bytes = serializedBlockBytes(canonical, MAX_USDA_CACHE_ENTRY_BYTES);
      if (!Number.isFinite(bytes) || bytes > MAX_USDA_CACHE_ENTRY_BYTES || bytes > maxBytes) {
        return { ok: false, code: 'entry_too_large' };
      }
      const key = makeKey(canonical.bundle_release, canonical.fdc_id);
      remove(key); // replacement: drop stale bytes before re-inserting.
      if (!evictUntil(maxEntries - 1, bytes)) {
        return { ok: false, code: 'entry_too_large' };
      }
      entries.set(key, { record: canonical, digest: canonical.record_digest, bytes });
      totalBytes += bytes;
      return { ok: true };
    },

    has(bundleRelease: string, fdcId: number): boolean {
      const entry = entries.get(makeKey(bundleRelease, fdcId));
      return entry !== undefined && entry.record.record_digest === entry.digest;
    },

    invalidateRelease(bundleRelease: string): number {
      let removed = 0;
      const prefix = `${bundleRelease}::`;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) {
          remove(key);
          removed += 1;
        }
      }
      return removed;
    },

    clear(): void {
      entries.clear();
      totalBytes = 0;
      hits = 0;
      misses = 0;
      evictions = 0;
    },

    size(): number {
      return entries.size;
    },

    bytes(): number {
      return totalBytes;
    },

    stats(): UsdaCacheStats {
      return Object.freeze({
        hits,
        misses,
        evictions,
        size: entries.size,
        bytes: totalBytes,
        maxEntries,
        maxBytes,
      });
    },
  });
}
