/**
 * The Kitchen Codex — Licensed representative-image search + selection (Phase 1).
 *
 * SERVER-SIDE ONLY. Public metadata APIs are fetched through the hardened
 * `safeFetchJson` SSRF path; the selected candidate's bytes AND its thumbnail
 * are downloaded through the EXISTING hardened `safeFetchImage` path (no
 * parallel weaker downloader). The browser NEVER supplies or receives an
 * authoritative download/thumbnail URL: it submits/receives opaque
 * server-owned candidate ids and app-local routes.
 *
 * CANDIDATE AUTHORITY is bound to a SERVER-DERIVED requester identity (never
 * client-supplied). Cross-requester access fails closed without revealing
 * existence. Successful selection consumes the candidate.
 */

import { randomBytes } from 'node:crypto';
import {
  MAX_REPRESENTATIVE_RESULTS,
  normalizeRepresentativeLicense,
  sanitizeRepresentativeText,
  isSafeHttpUrl,
  type RepresentativeImageCandidate,
  type RepresentativeImageSource,
  type StoredRepresentativeCandidate,
  type RepresentativeImageProvenance,
  representativeThumbnailPath,
} from '../src/core/representativeImage.js';
import { validateGeneratedImage, type GeneratedImageMime } from '../src/core/recipeImage.js';
import { safeFetchJson, safeFetchImage } from './ssrfGuard.js';

export const OPENVERSE_ENDPOINT = 'https://api.openverse.org/v1/images/';
export const WIKIMEDIA_COMMONS_ENDPOINT = 'https://commons.wikimedia.org/w/api.php';

/** Bounded metadata API response size (2 MB) and timeout (8 s). */
export const REPRESENTATIVE_METADATA_MAX_BYTES = 2 * 1024 * 1024;
export const REPRESENTATIVE_METADATA_TIMEOUT_MS = 8000;
/** Candidate records are short-lived and size-bounded. */
export const REPRESENTATIVE_CANDIDATE_TTL_MS = 10 * 60 * 1000;
export const MAX_STORED_CANDIDATES = 120;
/** Per-requester cap so one requester cannot consume the global budget. */
export const MAX_STORED_CANDIDATES_PER_REQUESTER = 24;
/**
 * Upstream sample size examined before LOCAL filtering. A broader sample
 * improves recall (disallowed/malformed results are skipped, not counted)
 * while the PUBLIC result count stays capped at MAX_REPRESENTATIVE_RESULTS.
 * Single request, no pagination loop.
 */
export const REPRESENTATIVE_UPSTREAM_PAGE_SIZE = 24;

export type RepresentativeJsonFetch = (url: string) => Promise<unknown>;

function defaultJsonFetch(): RepresentativeJsonFetch {
  return (url) => safeFetchJson(url, { maxBytes: REPRESENTATIVE_METADATA_MAX_BYTES, timeoutMs: REPRESENTATIVE_METADATA_TIMEOUT_MS });
}

/** Bounded, opaque, requester-bound candidate store (TTL + count bounded). */
export class RepresentativeImageCandidateStore {
  private readonly records = new Map<string, StoredRepresentativeCandidate>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxPerRequester: number;
  private readonly createId: () => string;

  constructor(options: { now?: () => number; ttlMs?: number; maxEntries?: number; maxPerRequester?: number; createId?: () => string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? REPRESENTATIVE_CANDIDATE_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_STORED_CANDIDATES;
    this.maxPerRequester = options.maxPerRequester ?? MAX_STORED_CANDIDATES_PER_REQUESTER;
    this.createId = options.createId ?? (() => randomBytes(24).toString('base64url'));
  }

  private countFor(requesterId: string): number {
    let n = 0;
    for (const record of this.records.values()) if (record.requesterId === requesterId) n++;
    return n;
  }

  /**
   * Stores candidates under fresh opaque ids for a specific requester. Never
   * evicts OTHER requesters' candidates: when the per-requester or global limit
   * is reached, new candidates for this requester are simply not stored.
   */
  insertAll(
    requesterId: string,
    candidates: Array<Omit<StoredRepresentativeCandidate, 'id' | 'requesterId' | 'expiresAt'>>
  ): RepresentativeImageCandidate[] {
    this.sweep();
    const expiresAt = this.now() + this.ttlMs;
    const out: RepresentativeImageCandidate[] = [];
    let requesterCount = this.countFor(requesterId);
    for (const candidate of candidates) {
      if (this.records.size >= this.maxEntries) break;
      if (requesterCount >= this.maxPerRequester) break;
      const id = this.createId();
      if (!id || this.records.has(id)) continue;
      const stored: StoredRepresentativeCandidate = { ...candidate, id, requesterId, expiresAt };
      this.records.set(id, stored);
      requesterCount++;
      out.push(toPublicCandidate(stored));
    }
    return out;
  }

  /** Requester-bound lookup: a mismatched requester sees "not found". */
  get(id: string, requesterId: string): StoredRepresentativeCandidate | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.requesterId !== requesterId) return undefined;
    if (this.now() >= record.expiresAt) {
      this.records.delete(id);
      return undefined;
    }
    return record;
  }

  remove(id: string, requesterId: string): boolean {
    const record = this.records.get(id);
    if (!record || record.requesterId !== requesterId) return false;
    return this.records.delete(id);
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.records.size;
  }

  sizeFor(requesterId: string): number {
    return this.countFor(requesterId);
  }

  clear(): void {
    this.records.clear();
  }
}

function toPublicCandidate(stored: StoredRepresentativeCandidate): RepresentativeImageCandidate {
  return {
    id: stored.id,
    source: stored.source,
    title: stored.title,
    // App-local route ONLY: the browser never receives the external thumbnail URL.
    thumbnailPath: representativeThumbnailPath(stored.id),
    sourcePageUrl: stored.sourcePageUrl,
    ...(stored.creator ? { creator: stored.creator } : {}),
    license: stored.license,
    licenseUrl: stored.licenseUrl,
    licenseVersion: stored.licenseVersion,
  };
}

interface RawCandidate {
  title: unknown;
  thumbnailUrl: unknown;
  remoteUrl: unknown;
  sourcePageUrl: unknown;
  creator: unknown;
  license: unknown;
}

/** Normalizes one upstream result into a safe stored candidate, or null. */
function normalizeRawCandidate(
  source: RepresentativeImageSource,
  query: string,
  raw: RawCandidate
): Omit<StoredRepresentativeCandidate, 'id' | 'requesterId' | 'expiresAt'> | null {
  const license = normalizeRepresentativeLicense(raw.license);
  if (!license) return null;
  if (!isSafeHttpUrl(raw.remoteUrl) || !isSafeHttpUrl(raw.thumbnailUrl) || !isSafeHttpUrl(raw.sourcePageUrl)) {
    return null;
  }
  return {
    source,
    query,
    title: sanitizeRepresentativeText(raw.title) || 'Recipe image',
    thumbnailUrl: raw.thumbnailUrl,
    remoteUrl: raw.remoteUrl,
    sourcePageUrl: raw.sourcePageUrl,
    creator: sanitizeRepresentativeText(raw.creator) || undefined,
    license: license.id,
    licenseUrl: license.url,
    licenseVersion: license.version,
  };
}

function openverseResults(payload: unknown): RawCandidate[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return results.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const licenseFamily = typeof row['license'] === 'string' ? row['license'] : '';
    const licenseVersion = typeof row['license_version'] === 'string' ? row['license_version'] : '';
    const license = licenseFamily
      ? `${licenseFamily}${licenseVersion ? ` ${licenseVersion}` : ''}`
      : row['license_url'];
    return {
      title: row['title'],
      thumbnailUrl: row['thumbnail'],
      remoteUrl: row['url'],
      sourcePageUrl: row['foreign_landing_url'] ?? row['source_url'] ?? row['url'],
      creator: row['creator'],
      license,
    };
  });
}

function wikimediaResults(payload: unknown): RawCandidate[] {
  const pages = (payload as { query?: { pages?: unknown } })?.query?.pages;
  if (!pages || typeof pages !== 'object') return [];
  const out: RawCandidate[] = [];
  for (const page of Object.values(pages as Record<string, unknown>)) {
    const row = (page ?? {}) as Record<string, unknown>;
    const imageinfo = Array.isArray(row['imageinfo']) ? (row['imageinfo'][0] as Record<string, unknown>) : undefined;
    if (!imageinfo) continue;
    const ext = (imageinfo['extmetadata'] ?? {}) as Record<string, { value?: unknown }>;
    out.push({
      title: row['title'],
      thumbnailUrl: imageinfo['thumburl'] ?? imageinfo['url'],
      remoteUrl: imageinfo['url'] ?? imageinfo['thumburl'],
      sourcePageUrl: imageinfo['descriptionurl'] ?? imageinfo['url'],
      creator: ext['Artist']?.value,
      license: ext['LicenseShortName']?.value ?? ext['License']?.value ?? ext['UsageTerms']?.value,
    });
  }
  return out;
}

export interface RepresentativeImageSearchDeps {
  fetchJson?: RepresentativeJsonFetch;
  /** Max candidates RETURNED (bounded to MAX_REPRESENTATIVE_RESULTS). */
  limit?: number;
  /** Upstream sample size examined (bounded, single request per source). */
  pageSize?: number;
}

/**
 * Searches the approved sources. An EMPTY/unsafe query makes ZERO external
 * calls. Openverse is primary; Wikimedia Commons is used ONLY when Openverse
 * yields no safe candidate. Never retries in a storm, never broadens to
 * unknown-license sources, never returns raw upstream errors.
 */
export async function searchRepresentativeImages(
  query: string,
  deps: RepresentativeImageSearchDeps = {}
): Promise<Array<Omit<StoredRepresentativeCandidate, 'id' | 'requesterId' | 'expiresAt'>>> {
  const fetchJson = deps.fetchJson ?? defaultJsonFetch();
  const outputLimit = Math.max(1, Math.min(deps.limit ?? MAX_REPRESENTATIVE_RESULTS, MAX_REPRESENTATIVE_RESULTS));
  // Examine a BROADER upstream sample than we return, so locally-rejected
  // (disallowed/malformed) results do not starve recall. Still ONE request per
  // source, no pagination loop.
  const upstreamPageSize = Math.max(
    outputLimit,
    Math.min(deps.pageSize ?? REPRESENTATIVE_UPSTREAM_PAGE_SIZE, 50)
  );
  const cleanQuery = sanitizeRepresentativeText(query, 120);
  if (!cleanQuery) return [];

  const collect = async (
    source: RepresentativeImageSource,
    url: string,
    map: (payload: unknown) => RawCandidate[]
  ): Promise<Array<Omit<StoredRepresentativeCandidate, 'id' | 'requesterId' | 'expiresAt'>>> => {
    const payload = await fetchJson(url);
    const normalized: Array<Omit<StoredRepresentativeCandidate, 'id' | 'requesterId' | 'expiresAt'>> = [];
    // Scan the WHOLE returned sample, skipping locally-rejected results, and
    // stop only once we have enough safe candidates.
    for (const raw of map(payload)) {
      const candidate = normalizeRawCandidate(source, cleanQuery, raw);
      if (candidate) normalized.push(candidate);
      if (normalized.length >= outputLimit) break;
    }
    return normalized;
  };

  let candidates: Array<Omit<StoredRepresentativeCandidate, 'id' | 'requesterId' | 'expiresAt'>> = [];
  try {
    // Request only locally-allowed licenses upstream where supported; local
    // filtering below remains MANDATORY (upstream metadata is not authority).
    const openverseUrl =
      `${OPENVERSE_ENDPOINT}?q=${encodeURIComponent(cleanQuery)}` +
      `&license=cc0,pdm,by,by-sa&page_size=${upstreamPageSize}`;
    candidates = await collect('openverse', openverseUrl, openverseResults);
  } catch {
    candidates = [];
  }

  if (candidates.length === 0) {
    try {
      const wikimediaUrl =
        `${WIKIMEDIA_COMMONS_ENDPOINT}?action=query&format=json&generator=search` +
        `&gsrsearch=${encodeURIComponent(cleanQuery)}&gsrnamespace=6&gsrlimit=${upstreamPageSize}` +
        `&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=480`;
      candidates = await collect('wikimedia_commons', wikimediaUrl, wikimediaResults);
    } catch {
      candidates = [];
    }
  }

  return candidates.slice(0, outputLimit);
}

export type RepresentativeImageFetch = (
  url: string
) => Promise<{ buffer: Buffer; contentType: string }>;

export interface RepresentativeSelectionDeps {
  store: RepresentativeImageCandidateStore;
  /** Server-derived requester identity (never client-supplied). */
  requesterId: string;
  fetchImage?: RepresentativeImageFetch;
  now?: () => number;
}

export interface SelectedRepresentativeImage {
  bytes: Uint8Array;
  contentType: GeneratedImageMime;
  provenance: RepresentativeImageProvenance;
}

export class RepresentativeImageSelectionError extends Error {
  readonly code:
    | 'CANDIDATE_NOT_FOUND'
    | 'CANDIDATE_EXPIRED'
    | 'LICENSE_NOT_ALLOWED'
    | 'DOWNLOAD_FAILED'
    | 'INVALID_IMAGE';
  constructor(code: RepresentativeImageSelectionError['code'], message: string) {
    super(message);
    this.name = 'RepresentativeImageSelectionError';
    this.code = code;
  }
}

function defaultFetchImage(): RepresentativeImageFetch {
  return async (url) => {
    const result = await safeFetchImage(url);
    return { buffer: result.buffer, contentType: result.contentType };
  };
}

/**
 * Selects a stored candidate by opaque id, revalidates it, downloads the EXACT
 * stored remote URL through the hardened SSRF image path, and validates the
 * bytes. The client never supplies the download URL. A SUCCESSFUL selection
 * CONSUMES the candidate; a failed selection leaves it usable until TTL.
 */
export async function selectRepresentativeImage(
  candidateId: unknown,
  deps: RepresentativeSelectionDeps
): Promise<SelectedRepresentativeImage> {
  if (typeof candidateId !== 'string' || !candidateId || candidateId.length > 256) {
    throw new RepresentativeImageSelectionError('CANDIDATE_NOT_FOUND', 'The selected image is no longer available.');
  }
  const candidate = deps.store.get(candidateId, deps.requesterId);
  if (!candidate) {
    throw new RepresentativeImageSelectionError('CANDIDATE_NOT_FOUND', 'The selected image is no longer available.');
  }
  // Revalidate the stored metadata at selection time (defense in depth).
  const license = normalizeRepresentativeLicense(candidate.license);
  if (!license || license.id !== candidate.license) {
    throw new RepresentativeImageSelectionError('LICENSE_NOT_ALLOWED', 'That image does not have a reusable license.');
  }
  if (!isSafeHttpUrl(candidate.remoteUrl)) {
    throw new RepresentativeImageSelectionError('DOWNLOAD_FAILED', 'That image could not be downloaded.');
  }

  let downloaded: { buffer: Buffer; contentType: string };
  try {
    downloaded = await (deps.fetchImage ?? defaultFetchImage())(candidate.remoteUrl);
  } catch {
    throw new RepresentativeImageSelectionError('DOWNLOAD_FAILED', 'That image could not be downloaded.');
  }

  const validation = validateGeneratedImage({ bytes: new Uint8Array(downloaded.buffer), contentType: downloaded.contentType });
  if (!validation.valid || !validation.detectedMime) {
    throw new RepresentativeImageSelectionError('INVALID_IMAGE', 'That image is not a usable, supported image file.');
  }

  const selectedAt = new Date((deps.now ?? (() => Date.now()))()).toISOString();
  const provenance: RepresentativeImageProvenance = {
    kind: 'representative',
    provenanceVersion: 'representative_v1',
    source: candidate.source,
    sourcePageUrl: candidate.sourcePageUrl,
    ...(candidate.creator ? { creator: candidate.creator } : {}),
    license: candidate.license,
    licenseUrl: candidate.licenseUrl,
    licenseVersion: candidate.licenseVersion,
    selectedAt,
  };

  // Successful selection CONSUMES the candidate (one-time use).
  deps.store.remove(candidateId, deps.requesterId);

  return {
    bytes: new Uint8Array(downloaded.buffer),
    contentType: validation.detectedMime,
    provenance,
  };
}

export interface RepresentativeThumbnail {
  bytes: Uint8Array;
  contentType: GeneratedImageMime;
}

/**
 * Fetches a candidate's THUMBNAIL through the hardened SSRF image path and
 * validates it. Requester-bound; does NOT consume the candidate.
 */
export async function fetchRepresentativeThumbnail(
  candidateId: unknown,
  deps: RepresentativeSelectionDeps
): Promise<RepresentativeThumbnail> {
  if (typeof candidateId !== 'string' || !candidateId || candidateId.length > 256) {
    throw new RepresentativeImageSelectionError('CANDIDATE_NOT_FOUND', 'That image is no longer available.');
  }
  const candidate = deps.store.get(candidateId, deps.requesterId);
  if (!candidate) {
    throw new RepresentativeImageSelectionError('CANDIDATE_NOT_FOUND', 'That image is no longer available.');
  }
  if (!isSafeHttpUrl(candidate.thumbnailUrl)) {
    throw new RepresentativeImageSelectionError('DOWNLOAD_FAILED', 'That image could not be loaded.');
  }

  let downloaded: { buffer: Buffer; contentType: string };
  try {
    downloaded = await (deps.fetchImage ?? defaultFetchImage())(candidate.thumbnailUrl);
  } catch {
    throw new RepresentativeImageSelectionError('DOWNLOAD_FAILED', 'That image could not be loaded.');
  }
  const validation = validateGeneratedImage({ bytes: new Uint8Array(downloaded.buffer), contentType: downloaded.contentType });
  if (!validation.valid || !validation.detectedMime) {
    throw new RepresentativeImageSelectionError('INVALID_IMAGE', 'That image is not a usable, supported image file.');
  }
  return { bytes: new Uint8Array(downloaded.buffer), contentType: validation.detectedMime };
}
