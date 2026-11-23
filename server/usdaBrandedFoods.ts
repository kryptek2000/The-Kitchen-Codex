/**
 * The Kitchen Codex — bounded USDA FoodData Central Branded Foods lookup.
 *
 * SERVER-ONLY. This module is the ONLY place that reads the data.gov API key or
 * contacts the official USDA origin. It never accepts a caller-supplied URL,
 * never follows a redirect, never retries, and never exposes the key, an
 * upstream body, or an upstream error in its result.
 *
 * SEARCH FLOW
 *   one explicit user query
 *     -> official GET /fdc/v1/foods/search with dataType=Branded
 *       -> at most three matching FDC ids
 *         -> official GET /fdc/v1/food/{id} for each
 *           -> defensive branded-record adapter
 *             -> bounded, cached source snapshots
 *
 * The client never receives raw upstream data. Every candidate is already
 * canonicalized by `adaptUsdaBrandedFoodRecord` and carries its own snapshot
 * digest. Caching is process-local, bounded, and TTL-based; it is not a cloud
 * cache, account, or recipe store.
 */

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import {
  adaptUsdaBrandedFoodRecord,
  buildBrandedContribution,
  MAX_BRANDED_CANDIDATES,
  readBrandedVerificationRequest,
  sanitizeBrandedCandidate,
  sanitizeBrandedQuery,
  type BrandedLookupFailureCode,
  type UsdaBrandedFoodCandidate,
} from '../src/core/nutritionV2/brandedFoods.js';
import {
  BRANDED_ASSERTION_VERSION,
  brandedAssertionPayload,
  computeBrandedContributionDigest,
} from '../src/core/nutritionV2/brandedEvidenceTrust.js';
import { canonicalStringify } from '../src/core/nutritionV2/usda/digest.js';
import type { AiBrandedVerification, AiNutrientContribution } from '../src/core/nutritionV2/aiContribution.js';
import { isPlainObject, toInertValue } from '../src/core/nutritionV2/schema.js';
import { safeFetchJson } from './ssrfGuard.js';

export const USDA_FDC_API_ORIGIN = 'https://api.nal.usda.gov';
export const USDA_FDC_SEARCH_PATH = '/fdc/v1/foods/search';
export const USDA_FDC_FOOD_PATH = '/fdc/v1/food/';
export const USDA_FDC_API_KEY_ENV = 'USDA_FDC_API_KEY';

const MAX_SEARCH_RESULTS = 10;
const SEARCH_MAX_BYTES = 512 * 1024;
const DETAIL_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_SEARCH_CACHE = 32;
const MAX_DETAIL_CACHE = 128;
const EVIDENCE_TTL_MS = 60 * 60 * 1000;
const MAX_EVIDENCE_CACHE = 128;
const ASSERTION_TTL_MS = 10 * 60 * 1000;

interface SigningAuthority {
  readonly privateKey: ReturnType<typeof createPrivateKey>;
  readonly publicKey: string;
  readonly keyId: string;
}

function loadSigningAuthority(): SigningAuthority | null {
  const raw = typeof process !== 'undefined' ? process.env.USDA_BRANDED_SIGNING_PRIVATE_KEY : undefined;
  if (raw === undefined || raw.trim().length === 0) return null;
  const privateKey = createPrivateKey({ key: Buffer.from(raw.trim(), 'base64'), format: 'der', type: 'pkcs8' });
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(publicDer).toString('base64');
  const keyId = createHash('sha256').update(publicDer).digest('hex').slice(0, 16);
  return Object.freeze({ privateKey, publicKey, keyId });
}

const SIGNING = loadSigningAuthority();

function signAssertionPayload(payload: Record<string, unknown>, authority: SigningAuthority): string {
  return sign('sha256', Buffer.from(canonicalStringify(payload), 'utf8'), {
    key: authority.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
}

export interface UsdaBrandedLookupSuccess {
  readonly ok: true;
  readonly query: string;
  readonly total_hits: number;
  readonly candidates: ReadonlyArray<UsdaBrandedFoodCandidate>;
  readonly cache_status: 'hit' | 'miss';
  readonly retrieved_at: string;
  readonly signing_public_key: string;
  readonly signing_key_id: string;
}

export interface UsdaBrandedLookupFailure {
  readonly ok: false;
  readonly code: BrandedLookupFailureCode;
  readonly retry_after_seconds?: number;
}

export type UsdaBrandedLookupResult = UsdaBrandedLookupSuccess | UsdaBrandedLookupFailure;

export interface UsdaBrandedVerifiedItem {
  readonly line_ref: string;
  readonly contribution: AiNutrientContribution;
  readonly verification: AiBrandedVerification;
}

export type UsdaBrandedVerificationResult =
  | {
      readonly ok: true;
      readonly items: ReadonlyArray<UsdaBrandedVerifiedItem>;
      readonly signing_public_key: string;
      readonly signing_key_id: string;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid_request' | 'not_configured' | 'evidence_expired' | 'evidence_mismatch' | 'unsupported_target';
    };

type FetchJson = (
  url: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    allowRedirects?: boolean;
    signal?: AbortSignal;
  }
) => Promise<unknown>;

export interface UsdaBrandedLookupDeps {
  /** Test seam only. Production reads the server environment allowlisted key. */
  readonly apiKey?: string;
  /** Test seam only. Production uses the SSRF-pinned JSON fetch. */
  readonly fetchJson?: FetchJson;
  readonly now?: () => number;
}

interface SearchCacheEntry {
  readonly expiresAt: number;
  readonly totalHits: number;
  readonly candidates: ReadonlyArray<UsdaBrandedFoodCandidate>;
  readonly retrievedAt: string;
}

interface DetailCacheEntry {
  readonly expiresAt: number;
  readonly candidate: UsdaBrandedFoodCandidate;
}

const searchCache = new Map<string, SearchCacheEntry>();
const detailCache = new Map<number, DetailCacheEntry>();
const evidenceCache = new Map<string, { readonly expiresAt: number; readonly candidate: UsdaBrandedFoodCandidate }>();

/** Test seam: clears the bounded in-memory source cache. */
export function resetUsdaBrandedCachesForTests(): void {
  searchCache.clear();
  detailCache.clear();
  evidenceCache.clear();
}

/** Server-held handle for one verified source snapshot. */
function ensureEvidence(candidate: UsdaBrandedFoodCandidate, now: number): UsdaBrandedFoodCandidate {
  if (candidate.evidence_id !== undefined) {
    const existing = cacheGet(evidenceCache, candidate.evidence_id, now);
    if (existing) return existing.candidate;
  }
  const evidenceId = randomUUID();
  const withEvidence = Object.freeze({ ...candidate, evidence_id: evidenceId });
  cacheSet(evidenceCache, evidenceId, {
    expiresAt: now + EVIDENCE_TTL_MS,
    candidate: withEvidence,
  }, MAX_EVIDENCE_CACHE);
  return withEvidence;
}

function nowMs(deps: UsdaBrandedLookupDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function readConfiguredApiKey(): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const raw = process.env[USDA_FDC_API_KEY_ENV];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cacheGet<T extends { expiresAt: number }>(map: Map<string | number, T>, key: string | number, now: number): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    map.delete(key);
    return undefined;
  }
  // Refresh insertion order for a simple LRU eviction policy.
  map.delete(key);
  map.set(key, entry);
  return entry;
}

function cacheSet<T extends { expiresAt: number }>(
  map: Map<string | number, T>,
  key: string | number,
  value: T,
  maxEntries: number
): void {
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function mapLookupFailure(error: unknown): UsdaBrandedLookupFailure {
  const value = error as { code?: unknown; status?: unknown; retryAfterSeconds?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code : 'network';
  if (code === 'timeout') return { ok: false, code: 'timeout' };
  if (code === 'cancelled') return { ok: false, code: 'cancelled' };
  if (code === 'redirect_not_allowed' || code === 'redirect') return { ok: false, code: 'invalid_response' };
  if (code === 'oversized' || code === 'invalid_json' || code === 'content_type') {
    return { ok: false, code: 'invalid_response' };
  }
  if (code === 'http_status') {
    const status = typeof value?.status === 'number' ? value.status : 0;
    if (status === 401 || status === 403) return { ok: false, code: 'auth_failed' };
    if (status === 404) return { ok: false, code: 'not_found' };
    if (status === 429) {
      const retry = typeof value?.retryAfterSeconds === 'number' && Number.isSafeInteger(value.retryAfterSeconds)
        ? value.retryAfterSeconds
        : undefined;
      return { ok: false, code: 'rate_limited', ...(retry !== undefined ? { retry_after_seconds: retry } : {}) };
    }
    return { ok: false, code: 'unavailable' };
  }
  return { ok: false, code: 'unavailable' };
}

function readSearchFoodIds(raw: unknown): { ok: true; ids: number[]; totalHits: number } | { ok: false } {
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) return { ok: false };
  const value = materialized.value as Record<string, unknown>;
  if (!Array.isArray(value.foods)) return { ok: false };
  const totalHits = value.totalHits;
  if (typeof totalHits !== 'number' || !Number.isSafeInteger(totalHits) || totalHits < 0) return { ok: false };
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const food of value.foods) {
    if (ids.length >= MAX_BRANDED_CANDIDATES) break;
    if (!isPlainObject(food)) continue;
    const row = food as Record<string, unknown>;
    if (row.dataType !== 'Branded') continue;
    const fdcId = row.fdcId;
    if (typeof fdcId !== 'number' || !Number.isSafeInteger(fdcId) || fdcId <= 0 || seen.has(fdcId)) continue;
    seen.add(fdcId);
    ids.push(fdcId);
  }
  return { ok: true, ids, totalHits };
}

function buildSearchUrl(query: string, apiKey: string): string {
  const url = new URL(USDA_FDC_SEARCH_PATH, USDA_FDC_API_ORIGIN);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('query', query);
  url.searchParams.set('dataType', 'Branded');
  url.searchParams.set('pageSize', String(MAX_SEARCH_RESULTS));
  url.searchParams.set('pageNumber', '1');
  return url.toString();
}

function buildDetailUrl(fdcId: number, apiKey: string): string {
  const url = new URL(`${USDA_FDC_FOOD_PATH}${fdcId}`, USDA_FDC_API_ORIGIN);
  url.searchParams.set('api_key', apiKey);
  return url.toString();
}

/**
 * Executes one bounded, explicit branded-food lookup. There is no retry loop and
 * no fallback source. A failure never contains raw upstream data.
 */
export async function lookupUsdaBrandedFoods(
  rawQuery: unknown,
  options: { signal?: AbortSignal; deps?: UsdaBrandedLookupDeps } = {}
): Promise<UsdaBrandedLookupResult> {
  const query = sanitizeBrandedQuery(rawQuery);
  if (!query) return { ok: false, code: 'invalid_request' };
  const signing = SIGNING;
  if (signing === null) return { ok: false, code: 'not_configured' };
  const deps = options.deps ?? {};
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : readConfiguredApiKey();
  if (!apiKey || apiKey.trim().length === 0) return { ok: false, code: 'not_configured' };
  const fetchJson: FetchJson = deps.fetchJson ?? (safeFetchJson as unknown as FetchJson);
  const now = nowMs(deps);

  const searchKey = query.toLowerCase().replace(/\s+/g, ' ');
  const cachedSearch = cacheGet(searchCache, searchKey, now);
  if (cachedSearch) {
    return {
      ok: true,
      query,
      total_hits: cachedSearch.totalHits,
      candidates: Object.freeze(cachedSearch.candidates.map((candidate) => ensureEvidence(candidate, now))),
      cache_status: 'hit',
      retrieved_at: cachedSearch.retrievedAt,
      signing_public_key: signing.publicKey,
      signing_key_id: signing.keyId,
    };
  }

  if (options.signal?.aborted) return { ok: false, code: 'cancelled' };

  let searchRaw: unknown;
  try {
    searchRaw = await fetchJson(buildSearchUrl(query, apiKey), {
      maxBytes: SEARCH_MAX_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      allowRedirects: false,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return mapLookupFailure(error);
  }
  const search = readSearchFoodIds(searchRaw);
  if (!search.ok) return { ok: false, code: 'invalid_response' };
  if (search.ids.length === 0) {
    const retrievedAt = new Date(now).toISOString();
    cacheSet(searchCache, searchKey, {
      expiresAt: now + SEARCH_CACHE_TTL_MS,
      totalHits: search.totalHits,
      candidates: Object.freeze([]),
      retrievedAt,
    }, MAX_SEARCH_CACHE);
    return {
      ok: true,
      query,
      total_hits: search.totalHits,
      candidates: Object.freeze([]),
      cache_status: 'miss',
      retrieved_at: retrievedAt,
      signing_public_key: signing.publicKey,
      signing_key_id: signing.keyId,
    };
  }

  const candidates: UsdaBrandedFoodCandidate[] = [];
  for (const fdcId of search.ids) {
    if (options.signal?.aborted) return { ok: false, code: 'cancelled' };
    const cachedDetail = cacheGet(detailCache, fdcId, now);
    if (cachedDetail) {
      candidates.push(cachedDetail.candidate);
      continue;
    }
    let detailRaw: unknown;
    try {
      detailRaw = await fetchJson(buildDetailUrl(fdcId, apiKey), {
        maxBytes: DETAIL_MAX_BYTES,
        timeoutMs: REQUEST_TIMEOUT_MS,
        allowRedirects: false,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      const failure = mapLookupFailure(error);
      // A product-specific 404/invalid record is skippable; an upstream outage,
      // auth failure, timeout or rate limit is not silently hidden.
      if (failure.code === 'not_found' || failure.code === 'invalid_response') continue;
      return failure;
    }
    const adapted = adaptUsdaBrandedFoodRecord(detailRaw, query);
    if (!adapted.ok) continue;
    cacheSet(detailCache, fdcId, {
      expiresAt: now + DETAIL_CACHE_TTL_MS,
      candidate: adapted.candidate,
    }, MAX_DETAIL_CACHE);
    candidates.push(adapted.candidate);
  }

  if (candidates.length === 0) return { ok: false, code: 'invalid_response' };
  const retrievedAt = new Date(now).toISOString();
  const frozen = Object.freeze(candidates.map((candidate) => ensureEvidence(candidate, now)));
  cacheSet(searchCache, searchKey, {
    expiresAt: now + SEARCH_CACHE_TTL_MS,
    totalHits: search.totalHits,
    candidates: frozen,
    retrievedAt,
  }, MAX_SEARCH_CACHE);
  return {
    ok: true,
    query,
    total_hits: search.totalHits,
    candidates: frozen,
    cache_status: 'miss',
    retrieved_at: retrievedAt,
    signing_public_key: signing.publicKey,
    signing_key_id: signing.keyId,
  };
}


/**
 * Recomputes each proposed branded contribution from a server-held source
 * snapshot and the exact local target. The client's nutrient values are never
 * trusted. A mismatch is rejected; on success the server issues a verification
 * bound to the canonical contribution digest.
 */
export function verifyUsdaBrandedContributions(
  raw: unknown,
  options: { now?: () => number } = {}
): UsdaBrandedVerificationResult {
  const request = readBrandedVerificationRequest(raw);
  if (!request) return { ok: false, code: 'invalid_request' };
  const signing = SIGNING;
  if (signing === null) return { ok: false, code: 'not_configured' };
  const now = options.now ? options.now() : Date.now();
  const items: UsdaBrandedVerifiedItem[] = [];
  for (const item of request.items) {
    const stored = cacheGet(evidenceCache, item.evidence_id, now);
    if (!stored) return { ok: false, code: 'evidence_expired' };
    const candidate = sanitizeBrandedCandidate(stored.candidate);
    if (!candidate.ok) return { ok: false, code: 'evidence_expired' };
    const built = buildBrandedContribution(candidate.candidate, item.target);
    if (!built.ok) return { ok: false, code: 'unsupported_target' };
    const digest = computeBrandedContributionDigest(built.contribution);
    if (digest !== item.proposed_digest) return { ok: false, code: 'evidence_mismatch' };
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ASSERTION_TTL_MS).toISOString();
    const verificationBase = Object.freeze({
      version: BRANDED_ASSERTION_VERSION,
      key_id: signing.keyId,
      signature: '',
      canonical_digest: digest,
      recipe_digest: request.recipe_digest,
      review_identity: request.review_identity,
      issued_at: issuedAt,
      expires_at: expiresAt,
    });
    const signature = signAssertionPayload(brandedAssertionPayload(built.contribution, verificationBase), signing);
    items.push(Object.freeze({
      line_ref: item.target.line_ref,
      contribution: built.contribution,
      verification: Object.freeze({ ...verificationBase, signature }),
    }));
  }
  return {
    ok: true,
    items: Object.freeze(items),
    signing_public_key: signing.publicKey,
    signing_key_id: signing.keyId,
  };
}
