/**
 * The Kitchen Codex — Licensed representative-image client (Phase 1).
 *
 * Platform-neutral application flow for the EXPLICIT user-initiated
 * representative-image search + selection. It talks to the server-owned
 * candidate authority: the browser submits the deterministic recipe fields (for
 * search) and an OPAQUE candidate id (for selection) — never an authoritative
 * remote URL. The server revalidates and downloads through the hardened SSRF
 * image path.
 *
 * Phase 2 will add a sibling `Generate with AI` mode; this module deliberately
 * contains no AI/image-provider call.
 */

import type { ObsidianRecipe } from '../types';
import type { NetworkAdapter } from './adapters/NetworkAdapter';
import {
  MAX_REPRESENTATIVE_QUERY_INGREDIENTS,
  type RepresentativeImageCandidate,
  type RepresentativeImageProvenance,
} from '../core/representativeImage';

export const FIND_REPRESENTATIVE_IMAGE_PATH = '/api/recipes/image/find-representative';
export const SELECT_REPRESENTATIVE_IMAGE_PATH = '/api/recipes/image/select-representative';

export interface RepresentativeSearchInput {
  title: string;
  cuisine?: string;
  category?: string;
  tags?: string[];
  ingredients?: string[];
}

/** Bounded search input derived ONLY from recipe-owned display fields. */
export function buildRepresentativeSearchInput(recipe: ObsidianRecipe): RepresentativeSearchInput {
  const clean = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';
  const title = clean(recipe.title, 200);
  const cuisine = clean(recipe.cuisine, 60);
  const category = clean(recipe.category, 60);
  const tags = Array.isArray(recipe.tags)
    ? recipe.tags.map((t) => clean(t, 40)).filter(Boolean).slice(0, 8)
    : [];
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients
        .map((ing) => clean((ing as { name?: unknown })?.name, 80))
        .filter(Boolean)
        .slice(0, MAX_REPRESENTATIVE_QUERY_INGREDIENTS)
    : [];
  return {
    title,
    ...(cuisine ? { cuisine } : {}),
    ...(category ? { category } : {}),
    ...(tags.length ? { tags } : {}),
    ...(ingredients.length ? { ingredients } : {}),
  };
}

export interface RepresentativeSearchResult {
  query: string;
  candidates: RepresentativeImageCandidate[];
}

export class RepresentativeImageClientError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'RepresentativeImageClientError';
    this.status = status;
    this.code = code;
  }
}

function boundedError(res: { status: number; data?: unknown }, fallback: string): RepresentativeImageClientError {
  const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
  const message = typeof data['error'] === 'string' && data['error'] ? data['error'] : fallback;
  const code = typeof data['code'] === 'string' ? data['code'] : undefined;
  return new RepresentativeImageClientError(res.status, message, code);
}

function sanitizeCandidate(raw: unknown): RepresentativeImageCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row['id'] === 'string' ? row['id'] : '';
  const thumbnailPath = typeof row['thumbnailPath'] === 'string' ? row['thumbnailPath'] : '';
  const sourcePageUrl = typeof row['sourcePageUrl'] === 'string' ? row['sourcePageUrl'] : '';
  const license = typeof row['license'] === 'string' ? row['license'] : '';
  const source = row['source'];
  if (!id || !thumbnailPath || !sourcePageUrl || !license) return null;
  if (source !== 'openverse' && source !== 'wikimedia_commons') return null;
  // The thumbnail MUST be an app-local route (never an external host).
  if (!thumbnailPath.startsWith('/api/recipes/image/representative-thumbnail/')) return null;
  return {
    id,
    source,
    title: typeof row['title'] === 'string' ? row['title'].slice(0, 120) : 'Recipe image',
    thumbnailPath,
    sourcePageUrl,
    ...(typeof row['creator'] === 'string' && row['creator'] ? { creator: row['creator'].slice(0, 120) } : {}),
    license: license as RepresentativeImageCandidate['license'],
    licenseUrl: typeof row['licenseUrl'] === 'string' ? row['licenseUrl'] : '',
    licenseVersion: typeof row['licenseVersion'] === 'string' ? row['licenseVersion'] : 'unknown',
  };
}

/** Searches the approved sources for a representative image. User-initiated. */
export async function findRepresentativeImages(
  network: NetworkAdapter,
  input: RepresentativeSearchInput
): Promise<RepresentativeSearchResult> {
  const res = await network.post<unknown, RepresentativeSearchInput>(FIND_REPRESENTATIVE_IMAGE_PATH, input);
  if (!res.ok) throw boundedError(res, 'Representative image search is temporarily unavailable.');
  const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
  const query = typeof data['query'] === 'string' ? data['query'] : '';
  const rawCandidates = Array.isArray(data['candidates']) ? data['candidates'] : [];
  const candidates = rawCandidates
    .map(sanitizeCandidate)
    .filter((c): c is RepresentativeImageCandidate => c !== null)
    .slice(0, 6);
  return { query, candidates };
}

export interface SelectedRepresentativeImage {
  token: string;
  contentType: string;
  expiresAt: number;
  provenance: RepresentativeImageProvenance;
}

/** Selects a server-owned candidate by opaque id; never submits a remote URL. */
export async function selectRepresentativeImage(
  network: NetworkAdapter,
  candidateId: string
): Promise<SelectedRepresentativeImage> {
  const res = await network.post<unknown, { candidateId: string }>(SELECT_REPRESENTATIVE_IMAGE_PATH, {
    candidateId,
  });
  if (!res.ok) throw boundedError(res, 'That image could not be prepared.');
  const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
  const token = typeof data['token'] === 'string' ? data['token'] : '';
  const provenance = data['provenance'] as RepresentativeImageProvenance | undefined;
  if (!token || !provenance || provenance.kind !== 'representative') {
    throw new RepresentativeImageClientError(0, 'That image could not be prepared.');
  }
  return {
    token,
    contentType: typeof data['contentType'] === 'string' ? data['contentType'] : 'image/jpeg',
    expiresAt: typeof data['expiresAt'] === 'number' ? data['expiresAt'] : 0,
    provenance,
  };
}

/** Bounded user-facing message for any representative-image failure. */
export function mapRepresentativeImageError(error: unknown): string {
  if (error instanceof RepresentativeImageClientError) {
    if (error.status === 429 || error.code === 'RATE_LIMIT') {
      return 'Too many representative image requests. Please wait a moment and try again.';
    }
    if (error.code === 'IMAGE_SEARCH_UNAVAILABLE') {
      return 'Representative image search is temporarily unavailable. Please try again.';
    }
    if (error.code === 'IMAGE_QUERY_UNSAFE') {
      return 'This recipe does not contain safe visual search terms, so no external search was performed.';
    }
    if (error.code === 'CANDIDATE_NOT_FOUND') {
      return 'That image is no longer available. Please search again.';
    }
    if (error.code === 'LICENSE_NOT_ALLOWED') {
      return 'That image does not have a reusable license and cannot be used.';
    }
    if (error.code === 'INVALID_IMAGE' || error.code === 'DOWNLOAD_FAILED') {
      return 'That image could not be used. Your current image was kept.';
    }
    return 'Representative image search could not be completed. Your current image was kept.';
  }
  return 'Representative image search could not be completed. Your current image was kept.';
}
