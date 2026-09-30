/**
 * The Kitchen Codex — Advanced Nutrition: AI-3 bounded-estimate WIRE owner.
 *
 * PURE. This is the SINGLE owner of the estimate transport envelope. The
 * application layer builds it, the server sanitizes it, and nothing else in the
 * codebase may shape an estimate wire payload.
 *
 * The envelope carries request-scoped identity and the model-facing per-line
 * semantics ONLY. It deliberately carries NO FDC id, NO record/review/catalog/
 * bundle digest, NO nutrients, NO full USDA record, NO working-state internals,
 * NO recipe private metadata, NO vault/filesystem/user data, NO provider secret
 * and NO Apply/persistence data.
 */

import {
  AI_ESTIMATE_POLICY_VERSION,
  AI_ESTIMATE_PROVENANCE_CLASS,
  type AiEstimateRepresentativePolicy,
} from './aiAdvancedEstimate';
import { MAX_AI_ESTIMATE_LINES } from './phase4/aiEstimateValidation';

export const AI_ESTIMATE_REQUEST_VERSION = 'nutrition_ai_estimate_request_v1' as const;
export const AI_ESTIMATE_RESPONSE_VERSION = 'nutrition_ai_estimate_response_v1' as const;

export const MAX_AI_ESTIMATE_REQUEST_BYTES = 32 * 1024;
export const MAX_AI_ESTIMATE_RESPONSE_BYTES = 32 * 1024;
export const MAX_AI_ESTIMATE_LINE_REF_LENGTH = 200;
export const MAX_AI_ESTIMATE_SOURCE_TEXT_LENGTH = 240;
export const MAX_AI_ESTIMATE_FOOD_SEMANTICS_LENGTH = 120;
export const MAX_AI_ESTIMATE_LOCAL_DESCRIPTION_LENGTH = 200;

/** The deterministic, locally-owned statement of why estimation was eligible. */
export type AiEstimateEvidenceAbsentReason =
  | 'no_authenticated_portion'
  | 'no_count_portion'
  | 'no_household_record'
  | 'no_direct_mass';

/**
 * The bounded, per-line, model-facing estimate request line. Every field is
 * either opaque, authored, or a deterministic local parse/identity fact that
 * grants the model no authority.
 */
export interface AiEstimateRequestLine {
  /** Opaque local line reference; never a USDA id. */
  readonly line_ref: string;
  /** Bounded AUTHORED ingredient text (the deterministic source of truth). */
  readonly source_text: string;
  /** Deterministic parsed quantity semantics. */
  readonly amount: number | null;
  readonly unit: string | null;
  readonly measurement_kind: string;
  readonly count_noun: string | null;
  /** Bounded AUTHORED food semantics. */
  readonly food_semantics: string;
  /**
   * The bounded LOCAL USDA description of the ALREADY-AUTHENTICATED food. It
   * is included because an estimate depends on the resolved food's preparation
   * semantics; the identity is already bound locally, so the description grants
   * no authority and no identity is disclosed.
   */
  readonly local_food_description: string | null;
  /** Deterministically owned: why authenticated mass evidence was unavailable. */
  readonly evidence_absent_reason: AiEstimateEvidenceAbsentReason;
}

/** The model-facing estimate REQUEST (no local-only metadata, ever). */
export interface AiEstimateModelRequest {
  readonly contract_version: typeof AI_ESTIMATE_POLICY_VERSION;
  readonly provenance_class: typeof AI_ESTIMATE_PROVENANCE_CLASS;
  readonly lines: ReadonlyArray<AiEstimateRequestLine>;
}

/** The per-line MODEL RESPONSE shape (the frozen proposal, per line). */
export interface AiEstimateResponseLine {
  readonly line_ref: string;
  readonly policy_version: string;
  readonly provenance_class: string;
  readonly lower_grams: number;
  readonly upper_grams: number;
  readonly representative_grams: number;
  readonly representative_policy: AiEstimateRepresentativePolicy | string;
  readonly input_semantics: ReadonlyArray<string>;
  readonly evidence_absent_reason: string;
  readonly notes?: string;
}

export interface AiEstimateModelResponse {
  readonly response_version: typeof AI_ESTIMATE_RESPONSE_VERSION;
  readonly estimates: ReadonlyArray<AiEstimateResponseLine>;
}

/** The transport envelope: request-scoped identity + the model request. */
export interface AiEstimateTransportRequest {
  readonly request_version: typeof AI_ESTIMATE_REQUEST_VERSION;
  /** Transport-only; NEVER sent to the model. */
  readonly request_id: string;
  readonly estimate_request: AiEstimateModelRequest;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Canonicalises one locally-built request line; drops unbuildable lines. */
export function canonicalizeAiEstimateRequestLine(
  raw: unknown
): AiEstimateRequestLine | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const lineRef = boundedText(value['line_ref'], MAX_AI_ESTIMATE_LINE_REF_LENGTH);
  const sourceText = boundedText(value['source_text'], MAX_AI_ESTIMATE_SOURCE_TEXT_LENGTH);
  const foodSemantics = boundedText(value['food_semantics'], MAX_AI_ESTIMATE_FOOD_SEMANTICS_LENGTH);
  if (lineRef === null || sourceText === null || foodSemantics === null) return undefined;
  const reason = value['evidence_absent_reason'];
  if (
    reason !== 'no_authenticated_portion' &&
    reason !== 'no_count_portion' &&
    reason !== 'no_household_record' &&
    reason !== 'no_direct_mass'
  ) {
    return undefined;
  }
  const amount = value['amount'];
  const measurementKind = boundedText(value['measurement_kind'], 32);
  if (measurementKind === null) return undefined;
  return Object.freeze({
    line_ref: lineRef,
    source_text: sourceText,
    amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
    unit: boundedText(value['unit'], 32),
    measurement_kind: measurementKind,
    count_noun: boundedText(value['count_noun'], 40),
    food_semantics: foodSemantics,
    local_food_description: boundedText(
      value['local_food_description'],
      MAX_AI_ESTIMATE_LOCAL_DESCRIPTION_LENGTH
    ),
    evidence_absent_reason: reason,
  });
}

/**
 * Builds the model-facing request from already-canonical request lines. The
 * `request_id` is deliberately NOT a parameter here: it can never reach the
 * model-facing payload.
 */
export function buildAiEstimateModelRequest(
  lines: ReadonlyArray<unknown>
): AiEstimateModelRequest {
  const canonical: AiEstimateRequestLine[] = [];
  for (const raw of lines) {
    const line = canonicalizeAiEstimateRequestLine(raw);
    if (line !== undefined) canonical.push(line);
  }
  return Object.freeze({
    contract_version: AI_ESTIMATE_POLICY_VERSION,
    provenance_class: AI_ESTIMATE_PROVENANCE_CLASS,
    lines: Object.freeze(canonical.slice(0, MAX_AI_ESTIMATE_LINES)),
  });
}

/**
 * Measures the COMPLETE dynamic payload bytes that will actually be sent. The
 * cap is enforced against this value BEFORE any provider execution, so an
 * oversized request costs zero provider calls.
 */
export function aiEstimateRequestByteLength(request: AiEstimateModelRequest): number {
  return Buffer.byteLength(JSON.stringify(request), 'utf8');
}
