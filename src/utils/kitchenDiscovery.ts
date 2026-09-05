/**
 * The Kitchen Codex — Ask My Kitchen Web Discovery Contract + Source Separation
 * (v0.5.0 Step 5)
 *
 * Pure contract layer for EXPLICIT web discovery. It defines:
 *   - `KitchenWebResult`: a discovery-only card, NEVER a local Recipe.
 *   - `KitchenDiscoveryRequest`: the strict, discovery-safe request shape.
 *   - a strict web-result sanitizer (http/https only, bounded, unknown fields
 *     stripped, deduped by normalized URL, capped).
 *   - the deterministic source-policy gate (vault / vault_then_web / web) and
 *     the vault_then_web weak-result offer policy.
 *   - provider-backed URL extraction (from Gemini grounding metadata only — the
 *     model is never allowed to invent a URL).
 *
 * TRUST / PRIVACY:
 *   - A `KitchenWebResult` may NEVER carry a local recipeId, file path, vault
 *     membership, Obsidian metadata, or a canonical Recipe object. Web identity
 *     (`webResultId` / `id`) is isolated from local recipe identity.
 *   - Discovery requests never carry the vault, raw recipes, Markdown, notes,
 *     frontmatter, file paths, or trusted local IDs.
 *   - Discovery is query-only. The endpoint never fetches an arbitrary URL; a
 *     discovered URL is an untrusted display/handoff value until Grab Recipe
 *     validates it.
 *   - No web result may enter local candidate/ranking/similarity membership.
 *
 * Pure & local: no network/Gemini import. The live provider is server-side
 * (`server/kitchenDiscover.ts`); this module only defines the contract and
 * sanitizes untrusted input/output.
 */

import type { KitchenIntent } from './kitchenIntent';
import type { PreparedKitchenExecution } from './kitchenIntentPolicy';

export const MAX_WEB_RESULTS = 8;
export const WEAK_LOCAL_RESULT_THRESHOLD = 2;
export const MAX_DISCOVERY_QUESTION_LENGTH = 500;
export const MIN_DISCOVERY_RESULTS = 1;

const MAX_TITLE_LEN = 160;
const MAX_URL_LEN = 2048;
const MAX_SOURCE_LEN = 120;
const MAX_SNIPPET_LEN = 300;
const MAX_ID_LEN = 2048;

/** A discovered web recipe candidate. NOT a Recipe and NOT a vault member. */
export interface KitchenWebResult {
  /** Opaque discovery-card identifier; NEVER a trusted local recipe identity. */
  id: string;
  title: string;
  url: string;
  sourceName?: string;
  snippet?: string;
  imageUrl?: string;
}

/** The strict, discovery-safe request sent to /api/kitchen/discover. */
export interface KitchenDiscoveryRequest {
  question: string;
  intent: KitchenIntent;
  maxResults?: number;
}

/** The normalized discovery response contract. */
export interface KitchenDiscoveryResponse {
  ok: boolean;
  source: 'web';
  results: KitchenWebResult[];
  reason?: 'unavailable';
}

/**
 * The MINIMAL handoff into the existing Grab Recipe importer. It carries ONLY
 * the untrusted source URL (display/context title). A discovered URL stays
 * untrusted until the existing importer re-validates it. No webResultId, snippet,
 * imageUrl, sourceName-as-authority, recipeId, vault metadata, or parsed recipe
 * content is transferred.
 */
export interface KitchenWebImportHandoff {
  sourceUrl: string;
  sourceTitle?: string;
}

/** Deterministic authorization verdict for executing web discovery. */
export type DiscoveryAuthorization = 'forbidden' | 'requires_escalation' | 'enabled';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().slice(0, max);
  return s || undefined;
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) return undefined;
  return Math.max(min, Math.min(max, num));
}

/** Normalizes an http/https URL, or undefined for any other/unsafe scheme. */
function sanitizeHttpUrl(value: unknown): string | undefined {
  const raw = trimString(value, MAX_URL_LEN);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * Sanitizes an untrusted web-result object. Only http/https URLs survive;
 * scheme tricks (javascript:, data:, file:) are rejected; unknown/unsafe fields
 * are stripped; strings are bounded. Returns undefined for an invalid entry.
 */
export function sanitizeWebResult(raw: unknown): KitchenWebResult | undefined {
  if (!isPlainObject(raw)) return undefined;
  const url = sanitizeHttpUrl(raw['url']);
  if (!url) return undefined;
  const id = trimString(raw['id'], MAX_ID_LEN) ?? url;
  const title = trimString(raw['title'], MAX_TITLE_LEN) ?? url;
  const sourceName = trimString(raw['sourceName'], MAX_SOURCE_LEN);
  const snippet = trimString(raw['snippet'], MAX_SNIPPET_LEN);
  const imageUrl = sanitizeHttpUrl(raw['imageUrl']);
  return {
    id,
    title,
    url,
    ...(sourceName ? { sourceName } : {}),
    ...(snippet ? { snippet } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

/**
 * Sanitizes an untrusted web-result list: http/https only, deduped by the
 * normalized URL, bounded, unknown fields stripped, no local identity allowed.
 */
export function sanitizeWebResults(
  rawList: unknown,
  opts: { maxResults?: number } = {}
): KitchenWebResult[] {
  const cap = opts.maxResults ?? MAX_WEB_RESULTS;
  if (!Array.isArray(rawList)) return [];
  const out: KitchenWebResult[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (out.length >= cap) break;
    const web = sanitizeWebResult(item);
    if (!web) continue;
    if (seen.has(web.url)) continue;
    seen.add(web.url);
    out.push(web);
  }
  return out;
}

/** Validates the untrusted /api/kitchen/discover response shape. */
export function isKitchenDiscoveryResponse(
  payload: unknown
): payload is { ok: true; source: 'web'; results: unknown[]; reason?: string } {
  if (!isPlainObject(payload)) return false;
  const p = payload as Record<string, unknown>;
  return p['ok'] === true && p['source'] === 'web' && Array.isArray(p['results']);
}

/**
 * Builds the minimal Grab Recipe handoff from a discovery result. Only a
 * sanitized (http/https) sourceUrl plus an optional bounded sourceTitle survive;
 * everything else (snippet, image, sourceName, webResultId, local identity) is
 * intentionally dropped. Returns undefined for a malformed/non-http result.
 */
export function buildWebImportHandoff(result: unknown): KitchenWebImportHandoff | undefined {
  const web = sanitizeWebResult(result);
  if (!web) return undefined;
  const handoff: KitchenWebImportHandoff = { sourceUrl: web.url };
  if (web.title) handoff.sourceTitle = web.title;
  return handoff;
}

/** A safe, fixed, non-sensitive unavailable/failure discovery response. */
export function webDiscoveryUnavailable(): KitchenDiscoveryResponse {
  return { ok: false, source: 'web', results: [], reason: 'unavailable' };
}

// ---------------------------------------------------------------------------
// Source-policy gate + weak-result offer policy
// ---------------------------------------------------------------------------

function permissionOf(prepared: PreparedKitchenExecution): string | undefined {
  if (!prepared.ok) return undefined;
  return prepared.sourcePolicy.webDiscoveryPermission;
}

/** Deterministic verdict for whether web discovery may run now. */
export function getDiscoveryAuthorization(prepared: PreparedKitchenExecution): DiscoveryAuthorization {
  switch (permissionOf(prepared)) {
    case 'explicitly_requested':
      return 'enabled';
    case 'offer_if_weak':
      return 'requires_escalation';
    case 'forbidden':
    default:
      return 'forbidden';
  }
}

/** Whether the current intent should still run LOCAL vault retrieval. */
export function shouldRunLocalRetrieval(prepared: PreparedKitchenExecution): boolean {
  if (!prepared.ok) return false;
  return prepared.sourcePolicy.initialSource === 'vault';
}

/** Deterministic weak-local-results rule. */
export function isWeakLocalResult(localCount: number): boolean {
  return Number.isFinite(localCount) && localCount <= WEAK_LOCAL_RESULT_THRESHOLD;
}

/**
 * Whether the UI may offer explicit web discovery for a vault_then_web intent
 * given the local result count. Offer-only: firing discovery is the user's
 * explicit escalation action; it never auto-executes here.
 */
export function canOfferWebDiscovery(
  prepared: PreparedKitchenExecution,
  localCount: number
): boolean {
  return permissionOf(prepared) === 'offer_if_weak' && isWeakLocalResult(localCount);
}

// ---------------------------------------------------------------------------
// Discovery request + explicit escalation intent derivation
// ---------------------------------------------------------------------------

/**
 * Derives an explicit WEB discovery intent from a sanitized intent: forces
 * source='web' and strips all trusted-identity/reference-bearing fields so no
 * local recipe identity can reach the discovery request.
 */
export function toWebDiscoveryIntent(intent: KitchenIntent): KitchenIntent {
  const constraints = { ...intent.constraints };
  delete constraints.similarToRecipeId;
  const { references, ...rest } = intent;
  return { ...rest, source: 'web', constraints };
}

/**
 * Builds the strict, deterministic discovery request. Only the question, a
 * discovery-safe web intent, and a bounded maxResults are serialized. No trusted
 * local IDs, no vault content. Purely deterministic and JSON-serializable.
 */
export function buildKitchenDiscoveryRequest(
  question: string,
  intent: KitchenIntent,
  maxResults?: number
): KitchenDiscoveryRequest {
  const safeQuestion = String(question ?? '').trim().slice(0, MAX_DISCOVERY_QUESTION_LENGTH);
  const request: KitchenDiscoveryRequest = {
    question: safeQuestion,
    intent: toWebDiscoveryIntent(intent),
  };
  const bounded = clampInt(maxResults, MIN_DISCOVERY_RESULTS, MAX_WEB_RESULTS);
  if (bounded !== undefined) request.maxResults = bounded;
  return request;
}

// ---------------------------------------------------------------------------
// Provider-backed URL extraction (server-side only reads grounding metadata)
// ---------------------------------------------------------------------------

/**
 * Extracts discovery candidates from Gemini's GROUNDING metadata (grounding
 * chunks), NOT from model text. This is the provider-backed URL guarantee: if
 * the provider did not surface a real web URL, nothing survives, so a model can
 * never invent a recipe URL. Returns raw candidate objects for
 * `sanitizeWebResults` to validate/dedupe/cap.
 */
export function extractWebResultsFromGrounding(
  rawProviderResponse: unknown
): Array<Record<string, unknown>> {
  if (!isPlainObject(rawProviderResponse)) return [];
  const metadata = (rawProviderResponse as Record<string, unknown>)['groundingMetadata'];
  if (!isPlainObject(metadata)) return [];
  const chunks = (metadata as Record<string, unknown>)['groundingChunks'];
  if (!Array.isArray(chunks)) return [];

  const out: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    if (!isPlainObject(chunk)) continue;
    const web = (chunk as Record<string, unknown>)['web'];
    if (!isPlainObject(web)) continue;
    const uri = (web as Record<string, unknown>)['uri'];
    if (typeof uri !== 'string' || !uri.trim()) continue;
    out.push({
      id: uri,
      url: uri,
      title: (web as Record<string, unknown>)['title'],
      sourceName: (web as Record<string, unknown>)['domain'],
    });
  }
  return out;
}
