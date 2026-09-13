/**
 * The Kitchen Codex — OpenRouter dynamic model catalog (v0.8.0, remediated).
 *
 * A SERVER-OWNED, bounded, cached discovery layer over OpenRouter's public model
 * catalog (`GET https://openrouter.ai/api/v1/models`). It normalizes the live
 * upstream payload into a secret-free Kitchen Codex representation.
 *
 * REMEDIATION HARDENING (Terra audit):
 *   - openrouter/free is NEVER force-inserted or labeled FREE without a current/
 *     last-known VERIFIED live record. The fallback snapshot preserves only the
 *     server-owned curated model, with `pricingVerified:false` (never FREE).
 *   - Conservative pricing: FREE requires EVERY price-bearing field in the
 *     upstream pricing object to be a definitively zero finite number. Any
 *     non-zero, negative, malformed, NaN/Infinity, object/array/override, or
 *     unknown price-bearing field yields VARIABLE / non-free.
 *   - All external metadata is bounded (model count, id/name length, parameter
 *     and modality list lengths, string length).
 *   - Duplicate ids are handled deterministically: exact duplicates dedupe;
 *     conflicting duplicates reject the id entirely (never FREE).
 *   - Parameter names alone do NOT prove strict json_schema support. Only a
 *     server-owned VERIFIED allowlist is `structuredVerified`; arbitrary dynamic
 *     models are catalog candidates only and are NOT selectable for structured
 *     Kitchen Codex operations.
 *   - Dynamic image-output models are NOT assumed compatible with the current
 *     `/api/v1/images` transport; only the curated image allowlist is executable.
 *
 * SECURITY: fixed trusted endpoint, no redirects, bounded timeout/body, no API
 * key, no persistence, never throws to callers, never logs raw upstream bodies.
 */

import { OPENROUTER_STRUCTURED_MODEL } from "./openRouterProvider.js";
import {
  OPENROUTER_IMAGE_MODELS,
} from "./openRouterImageProvider.js";
import { isCapabilityVerified, getCapabilityVerification, STRICT_JSON_SCHEMA_PROFILE } from "./capabilityVerificationStore.js";
import type { OpenRouterProfile } from '../../src/core/ai/openRouterProfile.js';

/** OpenRouter's fixed, official model-catalog endpoint (never configurable). */
export const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

/** Bounded network + cache policy. */
export const OPENROUTER_CATALOG_TIMEOUT_MS = 6_000;
export const OPENROUTER_CATALOG_MAX_BYTES = 5 * 1024 * 1024;
export const OPENROUTER_CATALOG_TTL_MS = 10 * 60 * 1000;

/** The confirmed free router id (only honored when live-verified). */
export const OPENROUTER_FREE_ROUTER_ID = "openrouter/free";
export const OPENROUTER_FREE_ROUTER_NAME = "OpenRouter Free Router";

/** Normalization bounds (IMPORTANT-1). */
export const OPENROUTER_CATALOG_BOUNDS = {
  maxModels: 1500,
  maxIdLength: 200,
  maxNameLength: 300,
  maxSupportedParameters: 64,
  maxModalities: 16,
  maxStringLength: 200,
} as const;

/** The minimum input context length we call "large" for a compact badge. */
const LARGE_CONTEXT_THRESHOLD = 100_000;

/**
 * Server-owned VERIFIED strict-structured allowlist. Only models here are
 * `structuredVerified`; the live catalog's `structured_outputs` +
 * `response_format` parameter names are treated as a CANDIDATE signal only.
 */
const VERIFIED_STRICT_STRUCTURED_MODELS = new Set<string>([OPENROUTER_STRUCTURED_MODEL]);

/** True when the model is on the server-owned verified strict-structured allowlist. */
export function isVerifiedStrictStructuredModel(modelId: string): boolean {
  return VERIFIED_STRICT_STRUCTURED_MODELS.has(modelId);
}

/** A per-token USD price with an explicit "unknown/variable" marker. */
export interface OpenRouterPricing {
  promptPerToken: number | null;
  completionPerToken: number | null;
  imageOutputPerToken: number | null;
  variable: boolean;
}

export type OpenRouterCostClass = "free" | "budget" | "paid" | "variable";

export interface OpenRouterModelCapabilities {
  /** Catalog CANDIDATE signal (parameters present) — NOT a strict-support proof. */
  structuredOutput: boolean;
  reasoning: boolean;
  vision: boolean;
  largeContext: boolean;
  imageGeneration: boolean;
}

export interface OpenRouterCatalogModel {
  modelId: string;
  displayName: string;
  contextLength: number;
  supportedParameters: string[];
  inputModalities: string[];
  outputModalities: string[];
  pricing: OpenRouterPricing;
  isFree: boolean;
  /** True only when every pricing field was parsed finite from a live record. */
  pricingVerified: boolean;
  isRouter: boolean;
  costClass: OpenRouterCostClass;
  capabilities: OpenRouterModelCapabilities;
  /** Server-owned verified strict-structured compatibility. */
  structuredVerified: boolean;
  /** True when this model may execute on the current Kitchen Codex transport. */
  executionCompatible: boolean;
}

export type OpenRouterCatalogSource = "live" | "cached" | "curated_fallback";

export interface OpenRouterCatalogSnapshot {
  source: OpenRouterCatalogSource;
  fetchedAt: number;
  /** True when the price truth is within the cache TTL (live or fresh cache). */
  pricingFresh: boolean;
  textModels: OpenRouterCatalogModel[];
  imageModels: OpenRouterCatalogModel[];
}

// ---------------------------------------------------------------------------
// Pricing classification (conservative)
// ---------------------------------------------------------------------------

/** Parses an OpenRouter per-token price string. Negative/unknown -> null. */
export function parsePerTokenPrice(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function perTokenToPerMillion(perToken: number | null): number | null {
  if (perToken === null || !Number.isFinite(perToken)) return null;
  return perToken * 1_000_000;
}

export function formatPerMillionUsd(perToken: number | null): string {
  const perMillion = perTokenToPerMillion(perToken);
  if (perMillion === null) return "Variable";
  if (perMillion === 0) return "$0";
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`;
  if (perMillion < 1) return `$${perMillion.toFixed(3)}`;
  if (perMillion < 100) return `$${perMillion.toFixed(2)}`;
  return `$${Math.round(perMillion)}`;
}

interface PricingClassification {
  pricing: OpenRouterPricing;
  /** Every price field parsed finite (so a zero verdict is trustworthy). */
  verified: boolean;
  /** All applicable fields are zero. */
  allZero: boolean;
}

/**
 * Recognized price-bearing fields (the only keys we can safely interpret). Any
 * OTHER key in the upstream pricing object makes the verdict VARIABLE (unknown
 * unit) — never FREE.
 */
const RECOGNIZED_PRICING_FIELDS = new Set<string>([
  "prompt",
  "completion",
  "request",
  "image",
  "image_output",
  "audio",
  "audio_output",
  "input_cache",
  "input_cache_read",
  "input_cache_write",
  "cache_read",
  "cache_write",
  "internal_reasoning",
  "reasoning",
  "web_search",
]);

/**
 * Classifies an untrusted upstream pricing object conservatively. EVERY key is
 * treated as price-bearing: an UNRECOGNIZED key, object/array/override
 * structure, missing/null, malformed, NaN/Infinity, or negative value makes the
 * verdict unverified (VARIABLE).
 */
export function classifyOpenRouterPricing(raw: unknown): PricingClassification {
  const pricing: OpenRouterPricing = {
    promptPerToken: null,
    completionPerToken: null,
    imageOutputPerToken: null,
    variable: false,
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { pricing: { ...pricing, variable: true }, verified: false, allZero: false };
  }
  const row = raw as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length === 0) {
    return { pricing: { ...pricing, variable: true }, verified: false, allZero: false };
  }
  let verified = true;
  let allZero = true;
  for (const key of keys) {
    const value = row[key];
    if (!RECOGNIZED_PRICING_FIELDS.has(key)) {
      // Unknown price-bearing field -> cannot be safely interpreted.
      verified = false;
      continue;
    }
    if (value === null || value === undefined) {
      verified = false;
      continue;
    }
    if (typeof value === "object") {
      // Override / tiered / unknown price structure -> cannot be safely read.
      verified = false;
      continue;
    }
    const parsed = parsePerTokenPrice(value);
    if (parsed === null) {
      verified = false;
      continue;
    }
    if (parsed !== 0) allZero = false;
    if (key === "prompt") pricing.promptPerToken = parsed;
    else if (key === "completion") pricing.completionPerToken = parsed;
    else if (key === "image_output") pricing.imageOutputPerToken = parsed;
  }
  pricing.variable = !verified;
  return { pricing, verified, allZero: verified && allZero };
}

/** Classifies a model's user-facing cost (free requires a verified zero verdict). */
export function classifyOpenRouterCost(
  pricing: OpenRouterPricing,
  isFree: boolean
): OpenRouterCostClass {
  if (isFree) return "free";
  if (pricing.variable || pricing.promptPerToken === null || pricing.completionPerToken === null) {
    return "variable";
  }
  const promptPerM = pricing.promptPerToken * 1_000_000;
  const completionPerM = pricing.completionPerToken * 1_000_000;
  if (promptPerM <= 1 && completionPerM <= 4) return "budget";
  return "paid";
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function asStringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    if (typeof item === "string" && item.trim()) out.push(item.trim().slice(0, OPENROUTER_CATALOG_BOUNDS.maxStringLength));
  }
  return out;
}

function asFiniteNonNegativeNumber(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Conservative model-id grammar (no whitespace/control characters). */
const MODEL_ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

export function isValidOpenRouterModelId(id: string): boolean {
  if (!id || id.length > OPENROUTER_CATALOG_BOUNDS.maxIdLength) return false;
  return MODEL_ID_GRAMMAR.test(id);
}

/** True when the id is an OpenRouter router/alias that must not be selected directly. */
export function isOpenRouterRouterId(id: string): boolean {
  return id === OPENROUTER_FREE_ROUTER_ID || id.startsWith("openrouter/auto");
}

/**
 * Normalizes ONE upstream model entry. Returns null for malformed/unsafe entries
 * (alias redirects `~`, `:online` web-plugin models, invalid ids, non-chat text).
 */
export function normalizeOpenRouterModel(raw: unknown): OpenRouterCatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const modelId = typeof row["id"] === "string" ? row["id"].trim() : "";
  if (!isValidOpenRouterModelId(modelId)) return null;
  if (modelId.startsWith("~") || modelId.includes(":online")) return null;

  const architecture =
    typeof row["architecture"] === "object" && row["architecture"] !== null
      ? (row["architecture"] as Record<string, unknown>)
      : {};
  const outputModalities = asStringArray(
    architecture["output_modalities"],
    OPENROUTER_CATALOG_BOUNDS.maxModalities
  );
  const inputModalities = asStringArray(
    architecture["input_modalities"],
    OPENROUTER_CATALOG_BOUNDS.maxModalities
  );
  const supportedParameters = asStringArray(
    row["supported_parameters"],
    OPENROUTER_CATALOG_BOUNDS.maxSupportedParameters
  );

  const classification = classifyOpenRouterPricing(row["pricing"]);
  const isImage = outputModalities.includes("image");

  // FREE requires a VERIFIED zero verdict across every applicable component.
  const textFree =
    classification.verified &&
    classification.allZero &&
    classification.pricing.promptPerToken === 0 &&
    classification.pricing.completionPerToken === 0;
  const imageFree =
    textFree && classification.pricing.imageOutputPerToken === 0;
  const isFree = isImage ? imageFree : textFree;

  const isRouter = isOpenRouterRouterId(modelId);
  const structuredCandidate =
    supportedParameters.includes("structured_outputs") &&
    supportedParameters.includes("response_format");
  const reasoning =
    supportedParameters.includes("reasoning") || supportedParameters.includes("include_reasoning");
  const contextLength = asFiniteNonNegativeNumber(row["context_length"]);
  const structuredVerified = isVerifiedStrictStructuredModel(modelId);
  const executionCompatible = isImage
    ? (OPENROUTER_IMAGE_MODELS as readonly string[]).includes(modelId)
    : structuredVerified;

  const rawName = typeof row["name"] === "string" && row["name"].trim() ? row["name"].trim() : modelId;

  return {
    modelId,
    displayName: rawName.slice(0, OPENROUTER_CATALOG_BOUNDS.maxNameLength),
    contextLength,
    supportedParameters,
    inputModalities,
    outputModalities,
    pricing: classification.pricing,
    isFree,
    pricingVerified: classification.verified,
    isRouter,
    costClass: classifyOpenRouterCost(classification.pricing, isFree),
    capabilities: {
      structuredOutput: structuredCandidate,
      reasoning,
      vision: inputModalities.includes("image"),
      largeContext: contextLength >= LARGE_CONTEXT_THRESHOLD,
      imageGeneration: isImage,
    },
    structuredVerified,
    executionCompatible,
  };
}

/**
 * True when a model's OUTPUT is ordinary text: it emits text and does NOT emit
 * audio or image. INPUT modalities are deliberately irrelevant — an image/video
 * INPUT model that outputs only text is still ordinary text. This is the primary
 * modality rule for ordinary text discovery (it removes audio-generation models
 * such as Google Lyria and image-output models from the text surface).
 */
export function isOrdinaryTextOutputModel(model: OpenRouterCatalogModel): boolean {
  const out = model.outputModalities;
  return out.includes("text") && !out.includes("audio") && !out.includes("image");
}

/** A text model is DISCOVERABLE when it emits ordinary text and advertises a chat surface. */
export function isCompatibleOpenRouterTextModel(model: OpenRouterCatalogModel): boolean {
  if (!isOrdinaryTextOutputModel(model)) return false;
  const params = model.supportedParameters;
  return (
    params.includes("max_tokens") ||
    params.includes("max_completion_tokens") ||
    params.includes("temperature")
  );
}

/**
 * The stable per-model catalog fingerprint a capability verification is bound to.
 * It covers the pricing truth AND the capability-relevant metadata, so a price
 * change, a FREE -> PAID transition, or a capability/metadata change all change
 * the fingerprint and invalidate any stored verification.
 */
export function openRouterModelFingerprint(model: OpenRouterCatalogModel): string {
  return JSON.stringify({
    modelId: model.modelId,
    pricing: model.pricing,
    isFree: model.isFree,
    pricingVerified: model.pricingVerified,
    costClass: model.costClass,
    capabilities: model.capabilities,
    supportedParameters: model.supportedParameters,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    contextLength: model.contextLength,
    isRouter: model.isRouter,
  });
}

/**
 * True when a dynamically discovered text model has a CURRENT, fingerprint-bound
 * successful capability verification. Requires the trusted catalog price truth to
 * be FRESH and the model to be VERIFIED FREE right now. Routers are NEVER
 * eligible (their request-to-request routing cannot be pinned to a compatible
 * model). This is the ONLY way a non-allowlisted dynamic model becomes
 * executable — browser/client claims can never set it.
 */
export function isCapabilityVerifiedOpenRouterTextModel(
  model: OpenRouterCatalogModel,
  now: number = Date.now()
): boolean {
  if (model.isRouter || model.capabilities.imageGeneration) return false;
  if (!model.isFree || model.costClass !== "free" || !model.pricingVerified) return false;
  if (!getOpenRouterCatalogSnapshot().pricingFresh) return false;
  return isCapabilityVerified("openrouter", model.modelId, openRouterModelFingerprint(model), now);
}

/**
 * A text model is SELECTABLE when it is EITHER on the server-owned VERIFIED
 * strict-structured allowlist OR it has a CURRENT successful runtime capability
 * verification bound to fresh, verified-FREE pricing. Parameter names alone are
 * never trusted. (The verified allowlist is authoritative, so the fallback
 * curated model stays selectable even though it carries no discovered parameter
 * metadata.)
 */
export function isSelectableOpenRouterTextModel(model: OpenRouterCatalogModel): boolean {
  return model.structuredVerified || isCapabilityVerifiedOpenRouterTextModel(model);
}

/**
 * SERVER-OWNED candidate/eligibility signal for an explicit verification. This is
 * a PREFILTER ONLY — it never makes a model executable and never substitutes for
 * runtime verification. A model is an eligible candidate only when ALL current
 * trusted catalog facts hold:
 *   - currently verified FREE pricing (fresh snapshot + verified + costClass free);
 *   - non-router;
 *   - ordinary text OUTPUT (no audio/image output);
 *   - advertises BOTH `response_format` and `structured_outputs`.
 * Client/catalog metadata is never proof of runtime compatibility.
 */
export function isOpenRouterStrictStructuredCandidate(model: OpenRouterCatalogModel): boolean {
  return isOpenRouterJsonCandidate(model) && model.supportedParameters.includes('structured_outputs');
}

export function isOpenRouterJsonCandidate(model: OpenRouterCatalogModel): boolean {
  if (model.isRouter) return false;
  if (!model.isFree || model.costClass !== "free" || !model.pricingVerified) return false;
  if (!getOpenRouterCatalogSnapshot().pricingFresh) return false;
  if (!isOrdinaryTextOutputModel(model)) return false;
  const params = model.supportedParameters;
  return params.includes("response_format");
}

/** Resolve by CURRENT server snapshot and record; never by a client profile hint. */
export function verifiedOpenRouterProfile(modelId: string): OpenRouterProfile | undefined {
  const model = getOpenRouterCatalogSnapshot().textModels.find(m => m.modelId === modelId);
  if (!model || !isCapabilityVerifiedOpenRouterTextModel(model)) return undefined;
  return getCapabilityVerification('openrouter', modelId)?.profile ?? STRICT_JSON_SCHEMA_PROFILE;
}

/** An image model is DISCOVERABLE when it emits images (not a variable router). */
export function isCompatibleOpenRouterImageModel(model: OpenRouterCatalogModel): boolean {
  return model.outputModalities.includes("image") && !model.isRouter && !model.pricing.variable;
}

/** An image model is EXECUTABLE only on the curated `/images` transport allowlist. */
export function isExecutableOpenRouterImageModel(model: OpenRouterCatalogModel): boolean {
  return isCompatibleOpenRouterImageModel(model) && model.executionCompatible;
}

/** Structural signature used for deterministic duplicate detection. */
function modelSignature(model: OpenRouterCatalogModel): string {
  return JSON.stringify({
    pricing: model.pricing,
    input: model.inputModalities,
    output: model.outputModalities,
    params: model.supportedParameters,
    isFree: model.isFree,
    costClass: model.costClass,
    capabilities: model.capabilities,
    structuredVerified: model.structuredVerified,
    executionCompatible: model.executionCompatible,
    contextLength: model.contextLength,
  });
}

/**
 * Deterministic duplicate policy: identical duplicates dedupe to one; any id with
 * CONFLICTING entries is rejected entirely (never ambiguous, never FREE).
 */
export function dedupeOpenRouterModels(models: OpenRouterCatalogModel[]): OpenRouterCatalogModel[] {
  const groups = new Map<string, OpenRouterCatalogModel[]>();
  for (const model of models) {
    const list = groups.get(model.modelId);
    if (list) list.push(model);
    else groups.set(model.modelId, [model]);
  }
  const out: OpenRouterCatalogModel[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const signature = modelSignature(first);
    let identical = true;
    for (let i = 1; i < group.length; i++) {
      if (modelSignature(group[i]) !== signature) {
        identical = false;
        break;
      }
    }
    if (identical) out.push(first);
    // conflicting -> reject the id entirely.
  }
  return out;
}

/** Normalizes a full upstream payload into de-duplicated text + image lists. */
export function normalizeOpenRouterCatalogPayload(payload: unknown): {
  textModels: OpenRouterCatalogModel[];
  imageModels: OpenRouterCatalogModel[];
} {
  const data =
    typeof payload === "object" && payload !== null
      ? (payload as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) throw new Error("OpenRouter catalog payload was not a data array.");
  const bounded = data.slice(0, OPENROUTER_CATALOG_BOUNDS.maxModels);
  const all: OpenRouterCatalogModel[] = [];
  for (const entry of bounded) {
    const model = normalizeOpenRouterModel(entry);
    if (model) all.push(model);
  }
  const deduped = dedupeOpenRouterModels(all);
  return {
    textModels: deduped.filter(isCompatibleOpenRouterTextModel),
    imageModels: deduped.filter(isCompatibleOpenRouterImageModel),
  };
}

// ---------------------------------------------------------------------------
// Bounded fetch
// ---------------------------------------------------------------------------

interface BoundedBodyReader {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?(): Promise<void>;
    releaseLock?(): void;
  };
}

export interface OpenRouterCatalogFetchResponse {
  ok: boolean;
  status: number;
  body?: BoundedBodyReader | null;
  text?: () => Promise<string>;
}

export type OpenRouterCatalogFetchLike = (
  url: string,
  init: RequestInit
) => Promise<OpenRouterCatalogFetchResponse>;

function defaultFetch(): OpenRouterCatalogFetchLike {
  return (url, init) => (globalThis as unknown as { fetch: OpenRouterCatalogFetchLike }).fetch(url, init);
}

async function readBoundedText(
  res: OpenRouterCatalogFetchResponse,
  maxBytes: number
): Promise<string> {
  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const remaining = maxBytes - total;
        if (value.byteLength > remaining) {
          try {
            await reader.cancel?.();
          } catch {
            /* best-effort */
          }
          throw new Error("OpenRouter catalog exceeded the size limit.");
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }
  if (typeof res.text === "function") {
    const text = await res.text();
    if (text.length > maxBytes) throw new Error("OpenRouter catalog exceeded the size limit.");
    return text;
  }
  throw new Error("OpenRouter catalog response was not readable.");
}

// ---------------------------------------------------------------------------
// Cache + fallback
// ---------------------------------------------------------------------------

let snapshot: OpenRouterCatalogSnapshot | null = null;
let inflight: Promise<OpenRouterCatalogSnapshot> | null = null;

/**
 * The CURATED fallback snapshot. It preserves ONLY the server-owned curated
 * structured model. It NEVER advertises openrouter/free (or any dynamic model)
 * as verified FREE, and its models carry `pricingVerified:false`.
 */
export function buildBaselineSnapshot(now: number = Date.now()): OpenRouterCatalogSnapshot {
  const curated: OpenRouterCatalogModel = {
    modelId: OPENROUTER_STRUCTURED_MODEL,
    displayName: OPENROUTER_STRUCTURED_MODEL,
    contextLength: 0,
    supportedParameters: [],
    inputModalities: [],
    outputModalities: ["text"],
    pricing: { promptPerToken: null, completionPerToken: null, imageOutputPerToken: null, variable: true },
    isFree: false,
    pricingVerified: false,
    isRouter: false,
    costClass: "variable",
    capabilities: {
      structuredOutput: true,
      reasoning: false,
      vision: false,
      largeContext: false,
      imageGeneration: false,
    },
    structuredVerified: true,
    executionCompatible: true,
  };
  return {
    source: "curated_fallback",
    fetchedAt: now,
    pricingFresh: false,
    textModels: [curated],
    imageModels: [],
  };
}

export function getOpenRouterCatalogSnapshot(): OpenRouterCatalogSnapshot {
  if (!snapshot) return buildBaselineSnapshot();
  const age = Date.now() - snapshot.fetchedAt;
  // Price truth expires even if no refresh event occurs. Never resurrect a
  // failed refresh's stale pricing merely because its original timestamp is young.
  return snapshot.pricingFresh && age >= 0 && age < OPENROUTER_CATALOG_TTL_MS
    ? snapshot
    : { ...snapshot, pricingFresh: false };
}

export function resetOpenRouterCatalogForTests(): void {
  snapshot = null;
  inflight = null;
}

export interface RefreshOpenRouterCatalogOptions {
  force?: boolean;
  fetchFn?: OpenRouterCatalogFetchLike;
  now?: number;
}

async function performFetch(
  fetchFn: OpenRouterCatalogFetchLike,
  now: number
): Promise<OpenRouterCatalogSnapshot> {
  // A failed refresh retains the last-known snapshot but marks its price truth as
  // NOT fresh, so a FREE-acknowledged selection fails closed rather than
  // executing under a stale zero-cost assumption.
  const staleFallback = (): OpenRouterCatalogSnapshot =>
    snapshot ? { ...snapshot, source: "cached", pricingFresh: false } : buildBaselineSnapshot(now);
  try {
    const res = await fetchFn(OPENROUTER_MODELS_ENDPOINT, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OPENROUTER_CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) return staleFallback();
    const text = await readBoundedText(res, OPENROUTER_CATALOG_MAX_BYTES);
    const payload = JSON.parse(text) as unknown;
    const normalized = normalizeOpenRouterCatalogPayload(payload);
    return {
      source: "live",
      fetchedAt: now,
      pricingFresh: true,
      textModels: normalized.textModels,
      imageModels: normalized.imageModels,
    };
  } catch {
    return staleFallback();
  }
}

/**
 * Refreshes the catalog when stale (or forced). On ANY failure the last-known
 * snapshot is retained (marked NOT pricing-fresh) or the curated fallback is
 * used. This never throws.
 */
export async function refreshOpenRouterCatalog(
  options: RefreshOpenRouterCatalogOptions = {}
): Promise<OpenRouterCatalogSnapshot> {
  const now = options.now ?? Date.now();
  if (!options.force && snapshot?.pricingFresh && now >= snapshot.fetchedAt &&
      now - snapshot.fetchedAt < OPENROUTER_CATALOG_TTL_MS) {
    return { ...snapshot, source: "cached" };
  }
  if (inflight) return inflight;
  const fetchFn =
    options.fetchFn ?? (process.env.NODE_ENV === "test" ? undefined : defaultFetch());
  if (!fetchFn) {
    if (snapshot) return { ...snapshot, source: "cached", pricingFresh: false };
    return buildBaselineSnapshot(now);
  }
  inflight = performFetch(fetchFn, now)
    .then((next) => {
      snapshot = next;
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------------------
// Synchronous accessors
// ---------------------------------------------------------------------------

/**
 * Selectable OpenRouter text model ids. ONLY server-owned VERIFIED strict
 * structured models. openrouter/free is NEVER force-inserted.
 */
export function openRouterSelectableTextModelIds(): string[] {
  return getOpenRouterCatalogSnapshot()
    .textModels.filter(isSelectableOpenRouterTextModel)
    .map((m) => m.modelId);
}

/** All discovered compatible OpenRouter text model ids (informational). */
export function openRouterTextModelIds(): string[] {
  return getOpenRouterCatalogSnapshot().textModels.map((m) => m.modelId);
}

/** All discovered compatible OpenRouter image model ids (informational). */
export function openRouterImageModelIds(): string[] {
  return getOpenRouterCatalogSnapshot().imageModels.map((m) => m.modelId);
}

/**
 * EXECUTABLE OpenRouter image model ids: the curated `/api/v1/images` transport
 * allowlist (always) plus any discovered model that is BOTH image-output and on
 * that same verified allowlist. Generic image-output models are never included.
 */
export function openRouterSelectableImageModelIds(): string[] {
  const ids = getOpenRouterCatalogSnapshot()
    .imageModels.filter(isExecutableOpenRouterImageModel)
    .map((m) => m.modelId);
  for (const id of OPENROUTER_IMAGE_MODELS as readonly string[]) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Dynamic capability truth for an OpenRouter text model. `structuredOutput` is
 * TRUE only for the server-owned VERIFIED allowlist OR a model with a CURRENT
 * runtime capability verification. Arbitrary catalog candidates are NOT trusted
 * for structured Kitchen Codex operations. recipeGeneration and webSearch are
 * never claimed: a trivial strict-schema probe does not prove recipe-invention
 * quality, and OpenRouter has no grounded web search.
 */
export function openRouterDynamicCapabilities(
  modelId: string
): Partial<{ reasoning: boolean; structuredOutput: boolean; recipeGeneration: boolean; webSearch: boolean }> | undefined {
  const model = getOpenRouterCatalogSnapshot().textModels.find((m) => m.modelId === modelId);
  if (!model) return undefined;
  return {
    reasoning: model.capabilities.reasoning,
    structuredOutput: isSelectableOpenRouterTextModel(model),
    recipeGeneration: false,
    webSearch: false,
  };
}

export function findOpenRouterCatalogModel(modelId: string): OpenRouterCatalogModel | undefined {
  const snap = getOpenRouterCatalogSnapshot();
  return (
    snap.textModels.find((m) => m.modelId === modelId) ??
    snap.imageModels.find((m) => m.modelId === modelId)
  );
}

// ---------------------------------------------------------------------------
// Free -> paid spend protection
// ---------------------------------------------------------------------------

export type PricingGuardCode = "MODEL_PRICING_CHANGED" | "MODEL_PRICING_UNVERIFIED";

export interface PricingGuardOk {
  ok: true;
}
export interface PricingGuardBlocked {
  ok: false;
  code: PricingGuardCode;
  message: string;
}

/**
 * Spend guard for a user selection that was acknowledged as FREE. If the current
 * trusted catalog cannot establish fresh verified FREE truth for the exact model,
 * the selection is BLOCKED (fail closed). Only relevant to OpenRouter surfaces.
 */
export function openRouterPricingGuard(
  providerId: string,
  modelId: string | undefined,
  declaredCostClass: string | undefined
): PricingGuardOk | PricingGuardBlocked {
  if (providerId !== "openrouter" && providerId !== "openrouter-image") return { ok: true };
  if (declaredCostClass !== "free") return { ok: true };
  const snap = getOpenRouterCatalogSnapshot();
  const model = modelId ? findOpenRouterCatalogModel(modelId) : undefined;
  if (!model || !snap.pricingFresh || !model.pricingVerified) {
    return {
      ok: false,
      code: "MODEL_PRICING_UNVERIFIED",
      message: "This model's current pricing could not be verified. Re-select it after a successful catalog refresh.",
    };
  }
  if (model.costClass !== "free") {
    return {
      ok: false,
      code: "MODEL_PRICING_CHANGED",
      message: "This model is no longer free. Review the current price and re-select it if you still want to use it.",
    };
  }
  return { ok: true };
}

/** Exposed for documentation/tests. */
export const OPENROUTER_CATALOG_LIMITS = {
  timeoutMs: OPENROUTER_CATALOG_TIMEOUT_MS,
  maxBytes: OPENROUTER_CATALOG_MAX_BYTES,
  ttlMs: OPENROUTER_CATALOG_TTL_MS,
} as const;
