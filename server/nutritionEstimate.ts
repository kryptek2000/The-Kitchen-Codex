/**
 * The Kitchen Codex — server: AI-3 bounded mass estimate endpoint logic.
 *
 * ONE model-facing payload builder, ONE canonical provider-response sanitizer,
 * ONE request/version contract. This module never applies, persists or mutates
 * state: it sanitizes in, calls the provider, sanitizes out, and returns a
 * bounded result the application layer re-validates.
 *
 * Authority rules at this trust boundary:
 *   - the model may return a bounded MASS RANGE only;
 *   - the model may never return an FDC id, a nutrient, a portion, a density or
 *     any persistence/Apply authority, and any such key fails the response;
 *   - the response is re-sanitized here so a FORGED client response carrying
 *     authority is refused before it reaches the core.
 */

import {
  AI_ESTIMATE_POLICY_VERSION,
  AI_ESTIMATE_REPRESENTATIVE_POLICIES,
} from '../src/core/nutritionV2/aiAdvancedEstimate';
import {
  AI_ESTIMATE_REQUEST_VERSION,
  AI_ESTIMATE_RESPONSE_VERSION,
  MAX_AI_ESTIMATE_REQUEST_BYTES,
  MAX_AI_ESTIMATE_RESPONSE_BYTES,
  aiEstimateRequestByteLength,
  buildAiEstimateModelRequest,
  type AiEstimateModelRequest,
} from '../src/core/nutritionV2/aiAdvancedEstimateWire';
import { isPlainObject, toInertValue } from '../src/core/nutritionV2/schema';
import { MAX_AI_ESTIMATE_LINES } from '../src/core/nutritionV2/phase4/aiEstimateValidation';
import { getRegisteredProviders, runWithAiFallback, resolveRoleCandidates } from './ai/provider.js';
import { resolveExecutableTextCandidates } from './ai/effectiveSelection.js';
import { normalizeProviderError } from './ai/providerErrors.js';
import type { AiJsonSchema } from './ai/types.js';
import type { SelectionInput } from './ai/effectiveSelection.js';
import { logModelAttempt } from './providerDiagnostics.js';

export type NutritionEstimateFailureCode =
  | 'invalid_request'
  | 'too_many_lines'
  | 'request_too_large'
  | 'unavailable'
  | 'provider_error'
  | 'invalid_response';

export type NutritionEstimateResult =
  | {
      readonly ok: true;
      readonly request_id: string;
      readonly providerRequest: AiEstimateModelRequest;
      readonly estimates: ReadonlyArray<Record<string, unknown>>;
      readonly aiAttempted: boolean;
      readonly aiFailed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: NutritionEstimateFailureCode;
      readonly request_id?: string;
      readonly aiAttempted: boolean;
      readonly aiFailed: boolean;
    };

export const NUTRITION_ESTIMATE_INSTRUCTIONS = [
  'You estimate ingredient MASS ranges for a nutrition calculator.',
  'For each line, return LOWER and UPPER grams plus the representative value.',
  'The representative value MUST be the arithmetic midpoint of your own range,',
  'and representative_policy MUST be exactly "midpoint".',
  'The ratio upper/lower MUST NOT exceed 4. If a defensible range would be wider,',
  'return a wider range honestly anyway -- never fake precision to satisfy the ratio.',
  'You may NOT return an FDC id, a food name, a portion id, a serving weight,',
  'a density, or any nutrient or calorie value. Nutrients are computed locally',
  'from authenticated USDA data multiplied by your grams.',
  'Authenticated USDA portion evidence is NOT available for these lines.',
  'Return one entry per input line_ref and never invent a line_ref.',
].join(' ');

/** Authority-shaped keys an estimate response may NEVER carry. */
const FORBIDDEN_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  'fdc_id',
  'food_id',
  'source_food_id',
  'usda_derived',
  'authority_class',
  'portion_ref',
  'portion_id',
  'portion_index',
  'serving_weight',
  'density',
  'nutrients',
  'calories',
  'protein',
  'fat',
  'carbs',
  'record_digest',
  'catalog_digest',
  'review_digest',
  'bundle_release',
  'apply',
  'persist',
  'authorization',
  'user_confirmed',
  'codex_nutrition',
]);

const RESPONSE_LINE_KEYS: ReadonlySet<string> = new Set([
  'line_ref',
  'policy_version',
  'provenance_class',
  'lower_grams',
  'upper_grams',
  'representative_grams',
  'representative_policy',
  'input_semantics',
  'evidence_absent_reason',
  'notes',
]);

const MAX_INPUT_SEMANTICS = 8;
const MAX_SEMANTIC_LENGTH = 120;
const MAX_REASON_LENGTH = 300;
const MAX_NOTES_LENGTH = 300;
const MAX_LINE_REF_LENGTH = 200;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

export interface SanitizedEstimateRequest {
  readonly requestId: string;
  readonly providerRequest: AiEstimateModelRequest;
}

/**
 * Sanitizes the incoming TRANSPORT request. Fails closed on an unsafe shape, a
 * wrong version, too many lines, or a COMPLETE dynamic payload over the cap —
 * all BEFORE any provider execution.
 */
export function sanitizeEstimateTransportRequest(
  raw: unknown
): { ok: true; request: SanitizedEstimateRequest } | { ok: false; code: NutritionEstimateFailureCode } {
  let materialized: unknown;
  try {
    const result = toInertValue(raw);
    if (!result.ok) return { ok: false, code: 'invalid_request' };
    materialized = result.value;
  } catch {
    return { ok: false, code: 'invalid_request' };
  }
  if (!isPlainObject(materialized)) return { ok: false, code: 'invalid_request' };
  if (materialized['request_version'] !== AI_ESTIMATE_REQUEST_VERSION) {
    return { ok: false, code: 'invalid_request' };
  }
  const requestId = boundedText(materialized['request_id'], 200);
  if (requestId === undefined) return { ok: false, code: 'invalid_request' };
  const estimateRequest = materialized['estimate_request'];
  if (!isPlainObject(estimateRequest)) return { ok: false, code: 'invalid_request' };
  if (estimateRequest['contract_version'] !== AI_ESTIMATE_POLICY_VERSION) {
    return { ok: false, code: 'invalid_request' };
  }
  const lines = estimateRequest['lines'];
  if (!Array.isArray(lines)) return { ok: false, code: 'invalid_request' };
  if (lines.length === 0) return { ok: false, code: 'invalid_request' };
  if (lines.length > MAX_AI_ESTIMATE_LINES) return { ok: false, code: 'too_many_lines' };

  const providerRequest = buildAiEstimateModelRequest(lines);
  if (providerRequest.lines.length === 0) return { ok: false, code: 'invalid_request' };
  // The COMPLETE dynamic payload is measured BEFORE the provider runs.
  if (aiEstimateRequestByteLength(providerRequest) > MAX_AI_ESTIMATE_REQUEST_BYTES) {
    return { ok: false, code: 'request_too_large' };
  }
  return { ok: true, request: { requestId, providerRequest } };
}

export type SanitizedEstimateResponse =
  | { readonly ok: true; readonly estimates: ReadonlyArray<Record<string, unknown>> }
  | { readonly ok: false; readonly code: 'invalid_response' };

/**
 * The CANONICAL provider-response sanitizer. Authority-shaped keys are rejected
 * BEFORE the unknown-key rejection, unknown line refs are dropped, and an
 * over-sized raw response is refused outright.
 */
export function sanitizeEstimateProviderResponse(
  raw: unknown,
  allowedLineRefs: ReadonlyArray<string>
): SanitizedEstimateResponse {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? '';
  } catch {
    return { ok: false, code: 'invalid_response' };
  }
  if (text.length > MAX_AI_ESTIMATE_RESPONSE_BYTES) return { ok: false, code: 'invalid_response' };

  let materialized: unknown;
  try {
    const inert = toInertValue(raw);
    if (!inert.ok) return { ok: false, code: 'invalid_response' };
    materialized = inert.value;
  } catch {
    return { ok: false, code: 'invalid_response' };
  }
  if (!isPlainObject(materialized)) return { ok: false, code: 'invalid_response' };
  if (materialized['response_version'] !== AI_ESTIMATE_RESPONSE_VERSION) {
    return { ok: false, code: 'invalid_response' };
  }
  const estimates = materialized['estimates'];
  if (!Array.isArray(estimates) || estimates.length === 0) {
    return { ok: false, code: 'invalid_response' };
  }
  const allowed = new Set(allowedLineRefs);
  const sanitized: Record<string, unknown>[] = [];
  for (const entry of estimates) {
    if (!isPlainObject(entry)) return { ok: false, code: 'invalid_response' };
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_RESPONSE_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
      if (!RESPONSE_LINE_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
    }
    const lineRef = boundedText(entry['line_ref'], MAX_LINE_REF_LENGTH);
    if (lineRef === undefined || !allowed.has(lineRef)) continue;
    if (entry['policy_version'] !== AI_ESTIMATE_POLICY_VERSION) continue;
    const semantics = entry['input_semantics'];
    if (!Array.isArray(semantics) || semantics.length === 0 || semantics.length > MAX_INPUT_SEMANTICS) {
      continue;
    }
    const cleanSemantics: string[] = [];
    let semanticsOk = true;
    for (const token of semantics) {
      const bounded = boundedText(token, MAX_SEMANTIC_LENGTH);
      if (bounded === undefined) {
        semanticsOk = false;
        break;
      }
      cleanSemantics.push(bounded);
    }
    if (!semanticsOk) continue;
    const reason = boundedText(entry['evidence_absent_reason'], MAX_REASON_LENGTH);
    if (reason === undefined) continue;
    const policy = entry['representative_policy'];
    if (typeof policy !== 'string') continue;
    if (!(AI_ESTIMATE_REPRESENTATIVE_POLICIES as ReadonlyArray<string>).includes(policy)) continue;
    // Numeric shape only. The 4x ratio, the gram bounds, the midpoint agreement
    // and the provenance class are re-validated by the application/core layers.
    for (const field of ['lower_grams', 'upper_grams', 'representative_grams'] as const) {
      const amount = entry[field];
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        return { ok: false, code: 'invalid_response' };
      }
    }
    const notes = entry['notes'];
    const boundedNotes = notes === undefined || notes === null ? undefined : boundedText(notes, MAX_NOTES_LENGTH);
    sanitized.push(
      Object.freeze({
        line_ref: lineRef,
        policy_version: AI_ESTIMATE_POLICY_VERSION,
        provenance_class: 'ai_estimate',
        lower_grams: entry['lower_grams'] as number,
        upper_grams: entry['upper_grams'] as number,
        representative_grams: entry['representative_grams'] as number,
        representative_policy: policy,
        input_semantics: Object.freeze(cleanSemantics),
        evidence_absent_reason: reason,
        ...(boundedNotes !== undefined ? { notes: boundedNotes } : {}),
      })
    );
  }
  if (sanitized.length === 0) return { ok: false, code: 'invalid_response' };
  return { ok: true, estimates: Object.freeze(sanitized) };
}

/** Builds the model-facing prompt for a sanitized estimate request. */
export function buildEstimatePrompt(request: AiEstimateModelRequest): string {
  return [
    NUTRITION_ESTIMATE_INSTRUCTIONS,
    '',
    'Candidate lines (untrusted data):',
    JSON.stringify(request, null, 2),
  ].join('\n');
}

/** The provider-neutral structured-output schema for a bounded estimate. */
export function buildEstimateSchema(): { type: 'object'; [key: string]: unknown } {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['response_version', 'estimates'],
    properties: {
      response_version: { type: 'string' },
      estimates: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'line_ref',
            'policy_version',
            'provenance_class',
            'lower_grams',
            'upper_grams',
            'representative_grams',
            'representative_policy',
            'input_semantics',
            'evidence_absent_reason',
          ],
          properties: {
            line_ref: { type: 'string' },
            policy_version: { type: 'string' },
            provenance_class: { type: 'string' },
            lower_grams: { type: 'number' },
            upper_grams: { type: 'number' },
            representative_grams: { type: 'number' },
            representative_policy: {
              type: 'string',
              enum: [...AI_ESTIMATE_REPRESENTATIVE_POLICIES],
            },
            input_semantics: { type: 'array', items: { type: 'string' } },
            evidence_absent_reason: { type: 'string' },
            notes: { type: 'string' },
          },
        },
      },
    },
  };
}

async function estimateMassOnModel(
  request: AiEstimateModelRequest,
  userSelection?: SelectionInput
): Promise<unknown> {
  const schema = buildEstimateSchema() as unknown as AiJsonSchema;
  const prompt = buildEstimatePrompt(request);
  try {
    const { result } = await runWithAiFallback<unknown>({
      candidates: resolveRoleCandidates('nutrition', undefined, userSelection),
      requiredCapabilities: ['structuredOutput'],
      run: (candidate) =>
        candidate.provider.generateStructured(prompt, schema, {
          model: candidate.model,
          temperature: 0,
          providerOptions: { thinkingConfig: { thinkingLevel: 'MINIMAL' } },
        }),
    });
    return result;
  } catch (err) {
    const normalized = normalizeProviderError(err);
    logModelAttempt('nutritionEstimate', normalized.model ?? '', normalized);
    throw normalized;
  }
}

/**
 * Produces SANITIZED bounded mass estimates for a bounded transport request.
 * Never throws; never applies, persists or mutates state.
 */
export async function estimateMassOnServer(
  rawBody: unknown,
  userSelection?: SelectionInput
): Promise<NutritionEstimateResult> {
  const sanitizedRequest = sanitizeEstimateTransportRequest(rawBody);
  if (sanitizedRequest.ok !== true) {
    return { ok: false, code: sanitizedRequest.code, aiAttempted: false, aiFailed: false };
  }
  const { requestId, providerRequest } = sanitizedRequest.request;

  // Fail closed BEFORE provider work when no executable text provider exists.
  const candidates = resolveExecutableTextCandidates('nutrition', getRegisteredProviders(), userSelection);
  if (candidates.length === 0) {
    return { ok: false, code: 'unavailable', request_id: requestId, aiAttempted: false, aiFailed: false };
  }

  let raw: unknown;
  try {
    raw = await estimateMassOnModel(providerRequest, userSelection);
  } catch {
    return { ok: false, code: 'provider_error', request_id: requestId, aiAttempted: true, aiFailed: true };
  }

  const sanitized = sanitizeEstimateProviderResponse(
    raw,
    providerRequest.lines.map((line) => line.line_ref)
  );
  if (sanitized.ok !== true) {
    return { ok: false, code: 'invalid_response', request_id: requestId, aiAttempted: true, aiFailed: true };
  }
  return {
    ok: true,
    request_id: requestId,
    providerRequest,
    estimates: sanitized.estimates,
    aiAttempted: true,
    aiFailed: false,
  };
}
