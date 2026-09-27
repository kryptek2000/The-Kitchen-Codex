/**
 * The Kitchen Codex — Advanced Nutrition AI-2B: canonical plan WIRE shape.
 *
 * PURE, platform-neutral, provider-free. ONE owner for the frozen
 * `nutrition_ai_advanced_plan_v1` WIRE representation, shared by the server
 * adapter and the application requester so the two sides cannot drift.
 *
 * WHY THIS MODULE EXISTS (the serialization trap)
 * ----------------------------------------------
 * `sanitizeAiAdvancedPlanResponse` returns NORMALIZED INTERNAL plan objects that
 * each carry a `plan_version` property (see `./aiAdvancedPlan`). On the wire,
 * however, `plan_version` is ENVELOPE-ONLY: a plan entry carrying it is an
 * unknown entry key and is rejected (`invalid_response`).
 *
 * Therefore sanitized internal plans must NEVER be JSON-serialized directly.
 * `toAiAdvancedPlanWirePayload` rebuilds every entry FIELD-BY-FIELD from the
 * frozen wire key set, which makes the internal `plan_version` structurally
 * impossible to emit. `readAiAdvancedPlanWirePayload` is the strict reader for
 * the application side: envelope-only `plan_version`, no `request_id`, no
 * unknown/authority-shaped key, no `undefined` leakage.
 *
 * Neither function mutates state, touches a provider, or grants authority.
 */

import { isPlainObject } from './schema';
import {
  AI_ADVANCED_PLAN_VERSION,
  MAX_AI_ADVANCED_PLAN_NOTES_LENGTH,
  MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH,
  MAX_AI_ADVANCED_PLANS,
  type AiAdvancedPlanMeasureKind,
  type AiAdvancedResolutionPlan,
} from './aiAdvancedPlan';
import {
  AI_ADVANCED_CONFIDENCE_VALUES,
  type AiAdvancedConfidence,
} from './aiAdvanced';

/** Envelope keys of the wire payload. `plan_version` lives HERE and only here. */
export const AI_ADVANCED_PLAN_WIRE_ENVELOPE_KEYS = Object.freeze(['plan_version', 'plans'] as const);

/** Wire keys of one plan entry. Deliberately EXCLUDES `plan_version`. */
export const AI_ADVANCED_PLAN_WIRE_ENTRY_KEYS = Object.freeze([
  'line_ref',
  'candidate_ref',
  'measure_kind',
  'portion_ref',
  'review_required',
  'ambiguity_reasons',
  'confidence',
  'notes',
] as const);

/** One plan entry in WIRE form (no internal `plan_version`). */
export interface AiAdvancedPlanWireEntry {
  readonly line_ref: string;
  readonly candidate_ref?: string;
  readonly measure_kind: AiAdvancedPlanMeasureKind;
  readonly portion_ref?: string;
  readonly review_required: boolean;
  readonly ambiguity_reasons: ReadonlyArray<string>;
  readonly confidence?: AiAdvancedConfidence;
  readonly notes?: string;
}

/** The canonical wire payload: envelope `plan_version` + wire entries. */
export interface AiAdvancedPlanWirePayload {
  readonly plan_version: typeof AI_ADVANCED_PLAN_VERSION;
  readonly plans: ReadonlyArray<AiAdvancedPlanWireEntry>;
}

export type AiAdvancedPlanWireReadFailureCode = 'invalid_response' | 'unsupported_plan_version';

export type AiAdvancedPlanWireReadResult =
  | { readonly ok: true; readonly payload: AiAdvancedPlanWirePayload }
  | { readonly ok: false; readonly code: AiAdvancedPlanWireReadFailureCode };

const PLAN_VERSION_MAX_LENGTH = 120;
const LINE_REF_MAX_LENGTH = 200;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Rebuilds sanitized INTERNAL plans into the frozen WIRE payload. Every optional
 * field is copied only when present, so no `undefined` is ever serialized, and
 * the internal per-entry `plan_version` cannot appear in the output — the entry
 * is constructed from an explicit key list rather than by spreading the input.
 */
export function toAiAdvancedPlanWirePayload(
  plans: ReadonlyArray<AiAdvancedResolutionPlan>
): AiAdvancedPlanWirePayload {
  const entries: AiAdvancedPlanWireEntry[] = plans.map((plan) =>
    Object.freeze({
      line_ref: plan.line_ref,
      measure_kind: plan.measure_kind,
      review_required: plan.review_required,
      ambiguity_reasons: Object.freeze([...plan.ambiguity_reasons]),
      ...(plan.candidate_ref !== undefined ? { candidate_ref: plan.candidate_ref } : {}),
      ...(plan.portion_ref !== undefined ? { portion_ref: plan.portion_ref } : {}),
      ...(plan.confidence !== undefined ? { confidence: plan.confidence } : {}),
      ...(plan.notes !== undefined ? { notes: plan.notes } : {}),
    })
  );
  return Object.freeze({
    plan_version: AI_ADVANCED_PLAN_VERSION,
    plans: Object.freeze(entries),
  });
}

/**
 * Strict reader for a wire payload (application side). Never throws. Any
 * envelope-level `plan_version` inside an entry, any unknown/authority-shaped
 * key, a wrong version, a malformed entry, or an over-cap entry count fails the
 * WHOLE payload — the caller then re-sanitizes the accepted payload anyway.
 */
export function readAiAdvancedPlanWirePayload(raw: unknown): AiAdvancedPlanWireReadResult {
  if (!isPlainObject(raw)) return { ok: false, code: 'invalid_response' };
  for (const key of Object.keys(raw)) {
    if (key !== 'plan_version' && key !== 'plans') return { ok: false, code: 'invalid_response' };
  }
  const version = raw['plan_version'];
  if (typeof version !== 'string' || version.length === 0 || version.length > PLAN_VERSION_MAX_LENGTH) {
    return { ok: false, code: 'invalid_response' };
  }
  if (version !== AI_ADVANCED_PLAN_VERSION) return { ok: false, code: 'unsupported_plan_version' };
  const rawPlans = raw['plans'];
  if (!Array.isArray(rawPlans) || rawPlans.length > MAX_AI_ADVANCED_PLANS) {
    return { ok: false, code: 'invalid_response' };
  }

  const entries: AiAdvancedPlanWireEntry[] = [];
  for (const entry of rawPlans) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_response' };
    for (const key of Object.keys(entry)) {
      if (!(AI_ADVANCED_PLAN_WIRE_ENTRY_KEYS as ReadonlyArray<string>).includes(key)) {
        return { ok: false, code: 'invalid_response' };
      }
    }
    const lineRef = boundedText(entry['line_ref'], LINE_REF_MAX_LENGTH);
    if (lineRef === undefined) return { ok: false, code: 'invalid_response' };
    const measureKind = entry['measure_kind'];
    if (typeof measureKind !== 'string') return { ok: false, code: 'invalid_response' };
    if (typeof entry['review_required'] !== 'boolean') return { ok: false, code: 'invalid_response' };

    const rawReasons = entry['ambiguity_reasons'];
    const reasons: string[] = [];
    if (rawReasons !== undefined && rawReasons !== null) {
      if (!Array.isArray(rawReasons)) return { ok: false, code: 'invalid_response' };
      for (const reason of rawReasons) {
        const bounded = boundedText(reason, MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH);
        if (bounded === undefined) return { ok: false, code: 'invalid_response' };
        reasons.push(bounded);
      }
    }

    let candidateRef: string | undefined;
    if (entry['candidate_ref'] !== undefined && entry['candidate_ref'] !== null) {
      candidateRef = boundedText(entry['candidate_ref'], MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH);
      if (candidateRef === undefined) return { ok: false, code: 'invalid_response' };
    }
    let portionRef: string | undefined;
    if (entry['portion_ref'] !== undefined && entry['portion_ref'] !== null) {
      portionRef = boundedText(entry['portion_ref'], MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH);
      if (portionRef === undefined) return { ok: false, code: 'invalid_response' };
    }
    let confidence: AiAdvancedConfidence | undefined;
    if (entry['confidence'] !== undefined && entry['confidence'] !== null) {
      if (
        typeof entry['confidence'] !== 'string' ||
        !(AI_ADVANCED_CONFIDENCE_VALUES as ReadonlyArray<string>).includes(entry['confidence'])
      ) {
        return { ok: false, code: 'invalid_response' };
      }
      confidence = entry['confidence'] as AiAdvancedConfidence;
    }
    let notes: string | undefined;
    if (entry['notes'] !== undefined && entry['notes'] !== null) {
      notes = boundedText(entry['notes'], MAX_AI_ADVANCED_PLAN_NOTES_LENGTH);
      if (notes === undefined) return { ok: false, code: 'invalid_response' };
    }

    entries.push(
      Object.freeze({
        line_ref: lineRef,
        measure_kind: measureKind as AiAdvancedPlanMeasureKind,
        review_required: entry['review_required'],
        ambiguity_reasons: Object.freeze(reasons),
        ...(candidateRef !== undefined ? { candidate_ref: candidateRef } : {}),
        ...(portionRef !== undefined ? { portion_ref: portionRef } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(notes !== undefined ? { notes } : {}),
      })
    );
  }

  return { ok: true, payload: Object.freeze({ plan_version: AI_ADVANCED_PLAN_VERSION, plans: Object.freeze(entries) }) };
}
