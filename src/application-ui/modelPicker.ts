/**
 * The Kitchen Codex — OpenRouter model picker helpers (v0.8.0).
 *
 * Pure, platform-neutral helpers behind the free-first model picker. They are
 * deliberately DOM-free so the classification, pricing display, search, and
 * ordering are directly unit-testable and never depend on a browser.
 *
 * TRUTH:
 *   - Cost classification and pricing display come ONLY from normalized catalog
 *     pricing. Free is never inferred from a display name.
 *   - Pricing is per-token upstream; display converts to per-MILLION tokens.
 *   - A model with unknown/variable pricing is labeled "Variable pricing" — an
 *     exact number is never invented.
 */

import type { AiCapabilities } from '../core/ai/types';
import { openRouterProfileLabel, type OpenRouterProfile } from '../core/ai/openRouterProfile';
import type { CatalogCostClassView, CatalogPricingView } from './providerCatalog';

/** A model option as surfaced by the catalog to the picker. */
export interface SurfaceModelOption {
  id: string;
  default: boolean;
  capabilities?: AiCapabilities;
  displayName?: string;
  contextLength?: number;
  pricing?: CatalogPricingView;
  isFree?: boolean;
  pricingVerified?: boolean;
  structuredVerified?: boolean;
  /** True when a CURRENT runtime capability verification made this model executable. */
  capabilityVerified?: boolean;
  /**
   * SERVER-OWNED candidate prefilter (never execution authority): the model may
   * be offered an explicit "Verify for Kitchen Codex" action. Runtime
   * verification is still mandatory before execution.
   */
  strictStructuredCandidate?: boolean;
  jsonCandidate?: boolean;
  verifiedProfile?: OpenRouterProfile;
  executionCompatible?: boolean;
  compatibility?: 'compatible' | 'experimental' | 'unsupported';
  isRouter?: boolean;
  costClass?: CatalogCostClassView;
  inputModalities?: string[];
  outputModalities?: string[];
  vision?: boolean;
  largeContext?: boolean;
}

/** The picker's grouping tabs. */
export type ModelPickerGroup = 'free' | 'budget' | 'all';

/** Classifies a model's cost class, preferring explicit server truth. */
export function modelCostClass(model: SurfaceModelOption): CatalogCostClassView {
  // Never surface FREE when pricing was not verified from a live record.
  if (model.isFree && model.pricingVerified === false) return 'variable';
  if (model.costClass) {
    if (model.costClass === 'free' && model.pricingVerified === false) return 'variable';
    return model.costClass;
  }
  if (model.isFree) return 'free';
  const p = model.pricing;
  if (!p || p.variable || p.promptPerToken === null || p.completionPerToken === null) {
    return 'variable';
  }
  const promptPerM = p.promptPerToken * 1_000_000;
  const completionPerM = p.completionPerToken * 1_000_000;
  if (promptPerM <= 1 && completionPerM <= 4) return 'budget';
  return 'paid';
}

/** Formats a per-token USD price as a per-million USD string. */
export function formatPerMillion(perToken: number | null | undefined): string {
  if (perToken === null || perToken === undefined || !Number.isFinite(perToken)) return '—';
  const perM = perToken * 1_000_000;
  if (perM === 0) return '$0';
  if (perM < 0.01) return `$${perM.toFixed(4)}`;
  if (perM < 1) return `$${perM.toFixed(3)}`;
  if (perM < 100) return `$${perM.toFixed(2)}`;
  return `$${Math.round(perM)}`;
}

/** A concise, truthful price label for a model row. */
export function formatModelPrice(model: SurfaceModelOption): string {
  const cls = modelCostClass(model);
  if (cls === 'free') return 'FREE';
  if (cls === 'variable') return 'Variable pricing';
  const p = model.pricing;
  if (!p) return 'Variable pricing';
  return `${formatPerMillion(p.promptPerToken)}/M in · ${formatPerMillion(p.completionPerToken)}/M out`;
}

/**
 * A truthful price label for an IMAGE model. Image pricing is not flattened into
 * a fake universal "$x/image": when the catalog reports a per-token image-output
 * price it is shown as such; otherwise the label is "Variable pricing".
 */
export function formatImageModelPrice(model: SurfaceModelOption): string {
  const cls = modelCostClass(model);
  if (cls === 'free') return 'FREE';
  const p = model.pricing;
  if (!p || p.variable || p.imageOutputPerToken === null || p.imageOutputPerToken === undefined) {
    return 'Variable pricing';
  }
  return `${formatPerMillion(p.imageOutputPerToken)}/M output`;
}

/** Compact capability badges derived ONLY from catalog metadata. */
export function modelBadges(model: SurfaceModelOption): string[] {
  const badges: string[] = [];
  if (modelCostClass(model) === 'free') badges.push('FREE');
  if (model.pricingVerified === false) badges.push('Pricing unverified');
  if (model.capabilities?.reasoning) badges.push('Reasoning');
  if (model.structuredVerified) badges.push('Structured Output');
  if (model.capabilityVerified) badges.push('Verified');
  if (model.verifiedProfile) badges.push(openRouterProfileLabel(model.verifiedProfile));
  if (model.vision) badges.push('Vision');
  if (model.largeContext) badges.push('Large Context');
  if (model.compatibility === 'experimental') badges.push('Experimental');
  if (model.compatibility === 'unsupported') badges.push('Unsupported');
  return badges;
}

/** Case-insensitive local search by display name or model id. */
export function searchModels(
  models: SurfaceModelOption[],
  query: string
): SurfaceModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q)
  );
}

/** Filters by picker group (free / budget / all). */
export function groupModels(
  models: SurfaceModelOption[],
  group: ModelPickerGroup
): SurfaceModelOption[] {
  if (group === 'all') return models;
  if (group === 'free') return models.filter((m) => modelCostClass(m) === 'free');
  return models.filter((m) => modelCostClass(m) === 'budget');
}

function costRank(model: SurfaceModelOption): number {
  const cls = modelCostClass(model);
  if (cls === 'free') return 0;
  if (cls === 'budget') return 1;
  if (cls === 'paid') return 2;
  return 3;
}

/** The price used to order models within a cost class (image output when known). */
function priceSortKey(model: SurfaceModelOption): number {
  const p = model.pricing;
  if (!p) return Number.POSITIVE_INFINITY;
  return (
    p.imageOutputPerToken ?? p.promptPerToken ?? Number.POSITIVE_INFINITY
  );
}

/** FREE first, then BUDGET, then PAID, then variable; cheaper first within a class. */
export function sortModelsFreeFirst(models: SurfaceModelOption[]): SurfaceModelOption[] {
  return [...models].sort((a, b) => {
    const rank = costRank(a) - costRank(b);
    if (rank !== 0) return rank;
    const ap = priceSortKey(a);
    const bp = priceSortKey(b);
    if (ap !== bp) return ap - bp;
    return a.id.localeCompare(b.id);
  });
}

/** The full picker pipeline: group -> search -> free-first sort. */
export function pickerModels(
  models: SurfaceModelOption[],
  options: { query?: string; group?: ModelPickerGroup } = {}
): SurfaceModelOption[] {
  return sortModelsFreeFirst(
    searchModels(groupModels(models, options.group ?? 'all'), options.query ?? '')
  );
}

/** Count of free models in a set (used for the "no free image models" truth). */
export function countFreeModels(models: SurfaceModelOption[]): number {
  return models.filter((m) => modelCostClass(m) === 'free').length;
}

/** The per-model capability-verification UI state (never persisted). */
export type ModelVerificationState = 'idle' | 'verifying' | 'verified' | 'failed';

/** A bounded, non-secret verification view for one model. */
export interface ModelVerificationView {
  state: ModelVerificationState;
  /** Bounded failure text (never a raw provider error). */
  message?: string;
  /** Bounded public probe classification (mirror of the server union). */
  classification?: ProbeFailureClassification;
}

/** A concise "FREE · <verification state>" label for a discovered model row. */
export function freeVerificationLabel(
  model: SurfaceModelOption,
  verification: ModelVerificationView | undefined
): string {
  const state = verification?.state ?? 'idle';
  if (state === 'verifying') return 'FREE · Verifying…';
  if (state === 'verified') return 'FREE · Verified';
  if (state === 'failed') return 'FREE · Verification failed';
  return 'FREE · Not verified';
}

/**
 * The bounded, non-secret PUBLIC probe-failure classification (mirror of the
 * server-owned union in `server/ai/capabilityVerification.ts`). The client
 * renders ONLY these classifications so arbitrary upstream text can never reach
 * the UI.
 */
export const PROBE_FAILURE_CLASSIFICATIONS = [
  'PROBE_OUTPUT_TRUNCATED',
  'PROBE_REFUSAL',
  'PROBE_TOOL_CALL_ONLY',
  'PROBE_CONTENT_PARTS_UNSUPPORTED',
  'PROBE_WRONG_JSON_SHAPE',
  'PROBE_WRONG_REQUIRED_VALUE',
  'PROBE_EXTRA_PROPERTIES',
  'PROBE_TRANSPORT_ERROR',
  'PROBE_TIMEOUT',
  'PROBE_AUTH',
  'PROBE_RATE_LIMIT',
  'PROBE_QUOTA',
  'PROBE_UNAVAILABLE',
  'PROBE_NO_COMPATIBLE_ENDPOINT',
  'PROBE_HTTP_ERROR',
  'PROBE_EMPTY_RESPONSE',
  'PROBE_OVERSIZED',
  'PROBE_MALFORMED_JSON',
  'PROBE_SCHEMA_MISMATCH',
] as const;

export type ProbeFailureClassification = (typeof PROBE_FAILURE_CLASSIFICATIONS)[number];

/** True when a value is one of the bounded public classifications. */
export function isProbeFailureClassification(value: unknown): value is ProbeFailureClassification {
  return (
    typeof value === 'string' &&
    (PROBE_FAILURE_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

/** Bounded, non-secret user-facing messages (never raw provider text). */
const PROBE_FAILURE_MESSAGES: Record<ProbeFailureClassification, string> = {
  PROBE_OUTPUT_TRUNCATED: 'The model exhausted its output budget before completing an answer. No mode was verified.',
  PROBE_REFUSAL: 'The model refused this verification request.',
  PROBE_TOOL_CALL_ONLY: 'The model returned a tool call instead of the required JSON answer.',
  PROBE_CONTENT_PARTS_UNSUPPORTED: 'The model returned content parts outside the supported Chat Completions contract.',
  PROBE_WRONG_JSON_SHAPE: 'The model returned JSON with the wrong object shape.',
  PROBE_WRONG_REQUIRED_VALUE: 'The model returned the wrong required verification value.',
  PROBE_EXTRA_PROPERTIES: 'The model returned unexpected JSON properties.',
  PROBE_TRANSPORT_ERROR: 'Could not reach OpenRouter. Check the connection and try again.',
  PROBE_TIMEOUT: 'OpenRouter did not respond in time. Try again.',
  PROBE_AUTH: 'OpenRouter authentication failed or the session key expired. Update the session key and try again.',
  PROBE_RATE_LIMIT: 'OpenRouter rate-limited this verification. Wait a moment before trying again.',
  PROBE_QUOTA: 'The OpenRouter credential has insufficient quota or credit.',
  PROBE_UNAVAILABLE: 'OpenRouter is temporarily unavailable. Try again shortly.',
  PROBE_NO_COMPATIBLE_ENDPOINT:
    'OpenRouter found no endpoint that supports the requested JSON profile for this model.',
  PROBE_HTTP_ERROR: 'OpenRouter returned an unexpected error.',
  PROBE_EMPTY_RESPONSE: 'OpenRouter returned an empty response.',
  PROBE_OVERSIZED: 'OpenRouter returned a response larger than the allowed limit.',
  PROBE_MALFORMED_JSON: 'OpenRouter returned malformed JSON.',
  PROBE_SCHEMA_MISMATCH: 'The model did not return a complete supported JSON answer.',
};

/** The generic bounded fallback when a classification is absent/unknown. */
export const PROBE_FAILURE_FALLBACK_MESSAGE =
  'Verification failed. No JSON compatibility profile was verified.';

/**
 * The bounded UI message for a verification failure. Only known classifications
 * render a specific message; anything else (or an unknown string) renders the
 * generic bounded fallback — a raw server/provider message is NEVER rendered.
 */
export function probeFailureMessage(classification: unknown): string {
  return isProbeFailureClassification(classification)
    ? PROBE_FAILURE_MESSAGES[classification]
    : PROBE_FAILURE_FALLBACK_MESSAGE;
}
