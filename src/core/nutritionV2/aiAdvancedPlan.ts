/**
 * The Kitchen Codex — AI Advanced Nutrition: proposed resolution plan contract.
 *
 * PURE, provider-neutral, offline. INTERPRETATION and PROPOSED PLAN are separate
 * contracts (see `./aiAdvanced.ts`). An interpretation describes what the AI
 * believes the words mean. A plan says, within the deterministically supplied
 * candidate/portion sets, which opaque refs the AI proposes — and nothing more.
 *
 * A plan may NEVER carry: invented grams, invented database ids, nutrient
 * totals, schema/authorization/provenance fields, or Apply permission. Every
 * plan is a PROPOSAL the deterministic core remains free to reject whole.
 */

import { isPlainObject, toInertValue } from './schema';
import {
  AI_ADVANCED_CONFIDENCE_VALUES,
  AI_ADVANCED_FORBIDDEN_AUTHORITY_KEYS,
  type AiAdvancedConfidence,
} from './aiAdvanced';
import type { AiAdvancedLocalCandidate } from './aiAdvancedCandidates';

export const AI_ADVANCED_PLAN_VERSION = 'nutrition_ai_advanced_plan_v1';
export const MAX_AI_ADVANCED_PLANS = 25;
export const MAX_AI_ADVANCED_PLAN_NOTES_LENGTH = 300;
export const MAX_AI_ADVANCED_PLAN_AMBIGUITY_REASONS = 6;
export const MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH = 60;

/** How the AI believes the source measures the ingredient. */
export const AI_ADVANCED_MEASURE_KINDS = Object.freeze([
  'source_portion',
  'count',
  'household',
  'mass',
  'unknown',
] as const);
export type AiAdvancedPlanMeasureKind = (typeof AI_ADVANCED_MEASURE_KINDS)[number];

export interface AiAdvancedResolutionPlan {
  readonly plan_version: typeof AI_ADVANCED_PLAN_VERSION;
  readonly line_ref: string;
  /** Opaque, request-scoped ref from the supplied candidate set. */
  readonly candidate_ref?: string;
  readonly measure_kind: AiAdvancedPlanMeasureKind;
  /** Opaque, request-scoped ref from the supplied portion set for this line. */
  readonly portion_ref?: string;
  /** True when the deterministic core must still ask the user (default safety). */
  readonly review_required: boolean;
  readonly ambiguity_reasons: ReadonlyArray<string>;
  readonly confidence?: AiAdvancedConfidence;
  readonly notes?: string;
}

export type AiAdvancedPlanFailureCode =
  | 'invalid_response'
  | 'unsafe_response'
  | 'oversized_response'
  | 'unsupported_plan_version'
  | 'authority_field'
  | 'unknown_line_ref'
  | 'duplicate_line_ref'
  | 'unknown_candidate_ref'
  | 'unknown_portion_ref';

export interface AiAdvancedPlanSanitizeOptions {
  /** The exact line_refs the caller asked about. */
  readonly allowedLineRefs: ReadonlyArray<string>;
  /**
   * Request-scoped opaque candidate refs by line. A candidate_ref not in the
   * supplied set (or supplied when no set exists) is rejected.
   */
  readonly allowedCandidateRefsByLine?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Request-scoped opaque portion refs by line. */
  readonly allowedPortionRefsByLine?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly maxRows?: number;
}

export type AiAdvancedPlanSanitizeResult =
  | { readonly ok: true; readonly plans: ReadonlyArray<AiAdvancedResolutionPlan> }
  | { readonly ok: false; readonly code: AiAdvancedPlanFailureCode };

const PLAN_ENVELOPE_KEYS = new Set(['plan_version', 'plans']);
const PLAN_KEYS = new Set([
  'line_ref',
  'candidate_ref',
  'measure_kind',
  'portion_ref',
  'review_required',
  'ambiguity_reasons',
  'confidence',
  'notes',
]);

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function isForbiddenAuthorityKey(key: string): boolean {
  return AI_ADVANCED_FORBIDDEN_AUTHORITY_KEYS.has(key);
}

/** Rejects any object (at any depth) carrying an authority-shaped key. */
function containsForbiddenAuthorityKey(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenAuthorityKey(entry, depth + 1));
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isForbiddenAuthorityKey(key)) return true;
    if (containsForbiddenAuthorityKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Strictly sanitizes one raw proposed-resolution-plan response. Never throws.
 * Any authority/unknown field rejects the WHOLE response; any ref the caller did
 * not supply rejects the WHOLE response.
 */
export function sanitizeAiAdvancedPlanResponse(
  raw: unknown,
  options: AiAdvancedPlanSanitizeOptions
): AiAdvancedPlanSanitizeResult {
  let materialized: unknown;
  try {
    const result = toInertValue(raw);
    if (!result.ok) {
      const reason = (result as { ok: false; reason: string }).reason;
      return { ok: false, code: reason === 'oversized' ? 'oversized_response' : 'unsafe_response' };
    }
    materialized = result.value;
  } catch {
    return { ok: false, code: 'unsafe_response' };
  }

  if (!isPlainObject(materialized)) return { ok: false, code: 'invalid_response' };
  for (const key of Object.keys(materialized)) {
    if (!PLAN_ENVELOPE_KEYS.has(key)) {
      return { ok: false, code: isForbiddenAuthorityKey(key) ? 'authority_field' : 'invalid_response' };
    }
  }
  if (materialized.plan_version !== AI_ADVANCED_PLAN_VERSION) {
    return { ok: false, code: 'unsupported_plan_version' };
  }
  if (!Array.isArray(materialized.plans)) return { ok: false, code: 'invalid_response' };
  const maxRows = Math.min(
    typeof options.maxRows === 'number' && Number.isSafeInteger(options.maxRows) && options.maxRows > 0
      ? options.maxRows
      : MAX_AI_ADVANCED_PLANS,
    MAX_AI_ADVANCED_PLANS
  );
  if (materialized.plans.length > maxRows) return { ok: false, code: 'invalid_response' };

  const allowed = new Set(options.allowedLineRefs);
  const seen = new Set<string>();
  const plans: AiAdvancedResolutionPlan[] = [];

  for (const entry of materialized.plans) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_response' };
    if (containsForbiddenAuthorityKey(entry)) return { ok: false, code: 'authority_field' };
    for (const key of Object.keys(entry)) {
      if (!PLAN_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
    }

    const lineRef = boundedString(entry.line_ref, 200);
    if (lineRef === undefined) return { ok: false, code: 'invalid_response' };
    if (!allowed.has(lineRef)) return { ok: false, code: 'unknown_line_ref' };
    if (seen.has(lineRef)) return { ok: false, code: 'duplicate_line_ref' };
    seen.add(lineRef);

    if (!isOneOf(AI_ADVANCED_MEASURE_KINDS, entry.measure_kind)) {
      return { ok: false, code: 'invalid_response' };
    }
    if (typeof entry.review_required !== 'boolean') return { ok: false, code: 'invalid_response' };

    let candidateRef: string | undefined;
    if (entry.candidate_ref !== undefined && entry.candidate_ref !== null) {
      candidateRef = boundedString(entry.candidate_ref, MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH);
      if (candidateRef === undefined) return { ok: false, code: 'invalid_response' };
      const allowedForLine = options.allowedCandidateRefsByLine?.[lineRef] ?? [];
      if (!allowedForLine.includes(candidateRef)) return { ok: false, code: 'unknown_candidate_ref' };
    }

    let portionRef: string | undefined;
    if (entry.portion_ref !== undefined && entry.portion_ref !== null) {
      portionRef = boundedString(entry.portion_ref, MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH);
      if (portionRef === undefined) return { ok: false, code: 'invalid_response' };
      const allowedForLine = options.allowedPortionRefsByLine?.[lineRef] ?? [];
      if (!allowedForLine.includes(portionRef)) return { ok: false, code: 'unknown_portion_ref' };
    }

    const reasons: string[] = [];
    if (entry.ambiguity_reasons !== undefined && entry.ambiguity_reasons !== null) {
      if (
        !Array.isArray(entry.ambiguity_reasons) ||
        entry.ambiguity_reasons.length > MAX_AI_ADVANCED_PLAN_AMBIGUITY_REASONS
      ) {
        return { ok: false, code: 'invalid_response' };
      }
      for (const reason of entry.ambiguity_reasons) {
        const bounded = boundedString(reason, MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH);
        if (bounded === undefined) return { ok: false, code: 'invalid_response' };
        reasons.push(bounded);
      }
    }

    let confidence: AiAdvancedConfidence | undefined;
    if (entry.confidence !== undefined && entry.confidence !== null) {
      if (!isOneOf(AI_ADVANCED_CONFIDENCE_VALUES, entry.confidence)) {
        return { ok: false, code: 'invalid_response' };
      }
      confidence = entry.confidence;
    }

    let notes: string | undefined;
    if (entry.notes !== undefined && entry.notes !== null) {
      notes = boundedString(entry.notes, MAX_AI_ADVANCED_PLAN_NOTES_LENGTH);
      if (notes === undefined) return { ok: false, code: 'invalid_response' };
    }

    plans.push(
      Object.freeze({
        plan_version: AI_ADVANCED_PLAN_VERSION,
        line_ref: lineRef,
        measure_kind: entry.measure_kind as AiAdvancedPlanMeasureKind,
        review_required: entry.review_required,
        ambiguity_reasons: Object.freeze(reasons),
        ...(candidateRef !== undefined ? { candidate_ref: candidateRef } : {}),
        ...(portionRef !== undefined ? { portion_ref: portionRef } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(notes !== undefined ? { notes } : {}),
      })
    );
  }

  return { ok: true, plans: Object.freeze(plans) };
}

function isOneOf<T extends string>(values: ReadonlyArray<T>, value: unknown): value is T {
  return typeof value === 'string' && (values as ReadonlyArray<string>).includes(value);
}

/** Provider-neutral structured-output schema for the plan contract. */
export function buildAiAdvancedPlanSchema(): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  return {
    type: 'object',
    properties: {
      plan_version: { type: 'string' },
      plans: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_ref: { type: 'string' },
            candidate_ref: { type: 'string' },
            measure_kind: { type: 'string', enum: [...AI_ADVANCED_MEASURE_KINDS] },
            portion_ref: { type: 'string' },
            review_required: { type: 'boolean' },
            ambiguity_reasons: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'string', enum: [...AI_ADVANCED_CONFIDENCE_VALUES] },
            notes: { type: 'string' },
          },
          required: ['line_ref', 'measure_kind', 'review_required'],
        },
      },
    },
    required: ['plan_version', 'plans'],
  };
}

export type AiAdvancedPlanCandidateResolution =
  | { readonly ok: true; readonly candidate: AiAdvancedLocalCandidate }
  | { readonly ok: false; readonly code: 'no_candidate_proposed' | 'unknown_candidate_ref' };

/**
 * Deterministically maps a plan's opaque candidate ref back to the locally
 * owned candidate. A plan proposing no candidate, or a ref outside the supplied
 * set, fails closed. This is a proposal mapping only: the caller MUST still run
 * the existing identity/measurement gates on the returned candidate.
 */
export function resolvePlanCandidate(input: {
  readonly plan: AiAdvancedResolutionPlan;
  readonly candidateSet: { resolve(ref: string): AiAdvancedLocalCandidate | undefined };
}): AiAdvancedPlanCandidateResolution {
  const ref = input.plan.candidate_ref;
  if (ref === undefined) return { ok: false, code: 'no_candidate_proposed' };
  const candidate = input.candidateSet.resolve(ref);
  if (candidate === undefined) return { ok: false, code: 'unknown_candidate_ref' };
  return { ok: true, candidate };
}
