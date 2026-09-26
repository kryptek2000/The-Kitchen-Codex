/**
 * The Kitchen Codex — AI Advanced Nutrition: FUTURE bounded-estimate contract
 * skeleton (AI-0).
 *
 * PURE, offline. This module defines the SHAPE a future AI mass estimate must
 * take and the policy gates any future activation must satisfy. It is NOT a
 * mass estimator: `resolveAiBoundedEstimate` ALWAYS refuses with
 * `estimation_disabled`, and no food-specific tables, density guessing, or
 * grams are computed here.
 *
 * FUTURE ACTIVATION REQUIREMENTS (must all hold before estimation ships):
 *  - explicit lower/upper uncertainty bounds (never a bare scalar);
 *  - a declared representative policy;
 *  - the input semantics the estimate was based on;
 *  - the reason authenticated evidence was unavailable;
 *  - provider/model metadata where appropriate;
 *  - visibly weaker provenance (`ai_estimate`) than authenticated USDA/local
 *    portions — never masquerading as USDA-derived or exact;
 *  - deterministic validation of the proposal shape (this module);
 *  - explicit UI labeling (see AI_ESTIMATE_DISPLAY_LABEL);
 *  - Review before Apply (never automatic persistence).
 */

import { isPlainObject, toInertValue } from './schema';

export const AI_ESTIMATE_PROVENANCE_CLASS = 'ai_estimate' as const;
export const AI_ESTIMATE_POLICY_VERSION = 'nutrition_ai_estimate_policy_v1';
export const AI_ESTIMATE_DISPLAY_LABEL = 'AI estimate (not USDA-authenticated)';

/**
 * AI-0 ships estimation hard-disabled. This constant is the single switch a
 * future, explicitly reviewed phase would have to change (together with the
 * Review/UI gates above); no caller can enable it per-request.
 */
export const AI_ESTIMATION_AVAILABILITY = 'disabled' as const;

export const AI_ESTIMATE_REPRESENTATIVE_POLICIES = Object.freeze([
  'midpoint',
  'conservative_lower',
  'conservative_upper',
  'explicit',
] as const);
export type AiEstimateRepresentativePolicy = (typeof AI_ESTIMATE_REPRESENTATIVE_POLICIES)[number];

export const MAX_AI_ESTIMATE_BOUND_GRAMS = 1_000_000;
export const MAX_AI_ESTIMATE_INPUT_SEMANTICS = 8;
export const MAX_AI_ESTIMATE_TOKEN_LENGTH = 120;
export const MAX_AI_ESTIMATE_REASON_LENGTH = 300;
export const MAX_AI_ESTIMATE_NOTES_LENGTH = 300;
export const MAX_AI_ESTIMATE_PROVIDER_ID_LENGTH = 80;
export const MAX_AI_ESTIMATE_MODEL_ID_LENGTH = 160;

export interface AiEstimateProviderMetadata {
  readonly provider_id: string;
  readonly model_id: string;
}

/**
 * A well-formed FUTURE proposal. It carries only the estimate itself (bounded,
 * explicitly uncertain) plus its semantics/justification. It carries NO FDC id,
 * nutrient value, digest, schema version, authorization, or persistence field.
 */
export interface AiBoundedEstimateProposal {
  readonly policy_version: typeof AI_ESTIMATE_POLICY_VERSION;
  readonly provenance_class: typeof AI_ESTIMATE_PROVENANCE_CLASS;
  readonly line_ref: string;
  readonly lower_grams: number;
  readonly upper_grams: number;
  readonly representative_grams: number;
  readonly representative_policy: AiEstimateRepresentativePolicy;
  readonly input_semantics: ReadonlyArray<string>;
  readonly evidence_absent_reason: string;
  readonly provider?: AiEstimateProviderMetadata;
  readonly notes?: string;
}

export type AiBoundedEstimateValidationFailure =
  | 'invalid_proposal'
  | 'unsafe_proposal'
  | 'authority_field';

export type AiBoundedEstimateValidationResult =
  | { readonly ok: true; readonly proposal: AiBoundedEstimateProposal }
  | { readonly ok: false; readonly code: AiBoundedEstimateValidationFailure };

/** Keys an estimate proposal may NEVER carry (authority-shaped). */
const FORBIDDEN_ESTIMATE_KEYS: ReadonlySet<string> = new Set([
  'fdc_id',
  'food_id',
  'source_food_id',
  'nutrients',
  'calories',
  'protein',
  'fat',
  'carbs',
  'digest',
  'record_digest',
  'schema',
  'schema_version',
  'authority_class',
  'usda_derived',
  'source_portion_grams',
  'portion_index',
  'authorization',
  'application_authorized',
  'user_confirmed',
  'apply',
  'persist',
  'codex_nutrition',
]);

const PROPOSAL_KEYS = new Set([
  'policy_version',
  'provenance_class',
  'line_ref',
  'lower_grams',
  'upper_grams',
  'representative_grams',
  'representative_policy',
  'input_semantics',
  'evidence_absent_reason',
  'provider',
  'notes',
]);
const PROVIDER_KEYS = new Set(['provider_id', 'model_id']);

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function boundedGrams(value: unknown): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    Object.is(value, -0) ||
    value > MAX_AI_ESTIMATE_BOUND_GRAMS
  ) {
    return undefined;
  }
  return value;
}

/**
 * Structural validation for a FUTURE estimate proposal. Validating a proposal
 * never authorizes it: `resolveAiBoundedEstimate` still refuses while estimation
 * is disabled.
 */
export function validateAiBoundedEstimateProposal(raw: unknown): AiBoundedEstimateValidationResult {
  let materialized: unknown;
  try {
    const result = toInertValue(raw);
    if (!result.ok) return { ok: false, code: 'unsafe_proposal' };
    materialized = result.value;
  } catch {
    return { ok: false, code: 'unsafe_proposal' };
  }
  if (!isPlainObject(materialized)) return { ok: false, code: 'invalid_proposal' };
  for (const key of Object.keys(materialized)) {
    if (FORBIDDEN_ESTIMATE_KEYS.has(key)) return { ok: false, code: 'authority_field' };
    if (!PROPOSAL_KEYS.has(key)) return { ok: false, code: 'invalid_proposal' };
  }
  if (materialized.policy_version !== AI_ESTIMATE_POLICY_VERSION) {
    return { ok: false, code: 'invalid_proposal' };
  }
  if (materialized.provenance_class !== AI_ESTIMATE_PROVENANCE_CLASS) {
    // A proposal may never claim a stronger class (e.g. `usda_derived`).
    return { ok: false, code: 'authority_field' };
  }
  const lineRef = boundedString(materialized.line_ref, 200);
  if (lineRef === undefined) return { ok: false, code: 'invalid_proposal' };
  const lower = boundedGrams(materialized.lower_grams);
  const upper = boundedGrams(materialized.upper_grams);
  const representative = boundedGrams(materialized.representative_grams);
  if (lower === undefined || upper === undefined || representative === undefined) {
    return { ok: false, code: 'invalid_proposal' };
  }
  if (!(lower <= representative && representative <= upper)) {
    return { ok: false, code: 'invalid_proposal' };
  }
  if (
    typeof materialized.representative_policy !== 'string' ||
    !(AI_ESTIMATE_REPRESENTATIVE_POLICIES as ReadonlyArray<string>).includes(
      materialized.representative_policy
    )
  ) {
    return { ok: false, code: 'invalid_proposal' };
  }
  if (
    !Array.isArray(materialized.input_semantics) ||
    materialized.input_semantics.length === 0 ||
    materialized.input_semantics.length > MAX_AI_ESTIMATE_INPUT_SEMANTICS
  ) {
    return { ok: false, code: 'invalid_proposal' };
  }
  const inputSemantics: string[] = [];
  for (const token of materialized.input_semantics) {
    const bounded = boundedString(token, MAX_AI_ESTIMATE_TOKEN_LENGTH);
    if (bounded === undefined) return { ok: false, code: 'invalid_proposal' };
    inputSemantics.push(bounded);
  }
  const reason = boundedString(materialized.evidence_absent_reason, MAX_AI_ESTIMATE_REASON_LENGTH);
  if (reason === undefined) return { ok: false, code: 'invalid_proposal' };

  let provider: AiEstimateProviderMetadata | undefined;
  if (materialized.provider !== undefined && materialized.provider !== null) {
    if (!isPlainObject(materialized.provider)) return { ok: false, code: 'invalid_proposal' };
    for (const key of Object.keys(materialized.provider)) {
      if (!PROVIDER_KEYS.has(key)) return { ok: false, code: 'invalid_proposal' };
    }
    const providerId = boundedString(materialized.provider.provider_id, MAX_AI_ESTIMATE_PROVIDER_ID_LENGTH);
    const modelId = boundedString(materialized.provider.model_id, MAX_AI_ESTIMATE_MODEL_ID_LENGTH);
    if (providerId === undefined || modelId === undefined) return { ok: false, code: 'invalid_proposal' };
    provider = Object.freeze({ provider_id: providerId, model_id: modelId });
  }
  let notes: string | undefined;
  if (materialized.notes !== undefined && materialized.notes !== null) {
    notes = boundedString(materialized.notes, MAX_AI_ESTIMATE_NOTES_LENGTH);
    if (notes === undefined) return { ok: false, code: 'invalid_proposal' };
  }

  return {
    ok: true,
    proposal: Object.freeze({
      policy_version: AI_ESTIMATE_POLICY_VERSION,
      provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
      line_ref: lineRef,
      lower_grams: lower,
      upper_grams: upper,
      representative_grams: representative,
      representative_policy: materialized.representative_policy as AiEstimateRepresentativePolicy,
      input_semantics: Object.freeze(inputSemantics),
      evidence_absent_reason: reason,
      ...(provider !== undefined ? { provider } : {}),
      ...(notes !== undefined ? { notes } : {}),
    }),
  };
}

export type AiBoundedEstimateResolution =
  | { readonly ok: false; readonly code: 'estimation_disabled' };

/**
 * AI-0 ALWAYS refuses. Even a structurally perfect proposal is not an
 * authorization and production never guesses grams.
 */
export function resolveAiBoundedEstimate(_raw: unknown): AiBoundedEstimateResolution {
  return Object.freeze({ ok: false as const, code: 'estimation_disabled' as const });
}

/** AI estimation is hard-disabled in AI-0. */
export function isAiEstimationEnabled(): false {
  return false;
}

/**
 * True when a provenance class is deterministically authenticated (USDA/local
 * evidence). An `ai_estimate` is never authenticated authority.
 */
export function isAuthenticatedProvenanceClass(value: unknown): boolean {
  return value === 'usda_derived' || value === 'vetted_standard';
}

/** True only for the future, visibly-weaker AI estimate provenance class. */
export function isAiEstimateProvenanceClass(value: unknown): value is typeof AI_ESTIMATE_PROVENANCE_CLASS {
  return value === AI_ESTIMATE_PROVENANCE_CLASS;
}
