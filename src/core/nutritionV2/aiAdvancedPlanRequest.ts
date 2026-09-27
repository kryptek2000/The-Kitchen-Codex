/**
 * The Kitchen Codex — Advanced Nutrition AI-2A: bounded plan request context.
 *
 * PURE, platform-neutral, provider-free. Assembles already-produced
 * `AiAdvancedPlanLineSource`s into ONE bounded, request-scoped context:
 *
 *   local line sources (authoritative ref -> candidate maps)
 *     -> minimal provider-facing payload (opaque candidate views ONLY)
 *     -> hard 32 KiB UTF-8 serialized cap (fail closed)
 *
 * AUTHORITY BOUNDARY
 * ------------------
 *   - The REQUEST IDENTITY IS LOCAL/TRANSPORT CONTEXT. It is deliberately NOT a
 *     field of the frozen `nutrition_ai_advanced_plan_v1` contract: the caller
 *     supplies `requestId` (typically a deterministic test value or a
 *     transport-assigned nonce). This module performs NO randomness, NO clock
 *     reads, and NO I/O.
 *   - The provider-facing payload carries `line_ref` and the frozen opaque
 *     candidate views (`candidate_ref`, `display_description`, `semantic_tags`)
 *     and NOTHING else: no FDC ids, no `record_digest`, no `review_digest`, no
 *     `catalog_digest`, no `bundle_release`, no rank internals, no data-type
 *     preference, no partial/full USDA evidence structures, no recipe-wide
 *     context, no secrets, no persistence data.
 *   - ZERO portion refs are issued by AI-2A: `allowed_portion_refs_by_line` is
 *     the frozen EMPTY record, so any provider `portion_ref` fails closed.
 *   - Oversize, duplicate lines, unusable sources and empty candidate sets FAIL
 *     CLOSED. Lines and candidate sets are NEVER silently truncated.
 */

import { utf8ByteLength } from './schema';
import { MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH, AI_ADVANCED_PLAN_VERSION } from './aiAdvancedPlan';
import type { AiAdvancedCandidateView } from './aiAdvancedCandidates';
import type { AiAdvancedPlanLineSource } from './aiAdvancedPlanSource';
import { AI_ADVANCED_PLAN_SOURCE_VERSION } from './aiAdvancedPlanSource';

export const AI_ADVANCED_PLAN_REQUEST_VERSION = 'nutrition_ai_advanced_plan_request_v1';

/** Conservative bound: 12 lines keeps the payload far under the 64 KiB class. */
export const MAX_AI_ADVANCED_PLAN_LINES = 12;

/** Hard UTF-8 serialized cap for the provider-facing request payload. */
export const MAX_AI_ADVANCED_PLAN_REQUEST_BYTES = 32 * 1024;

export const MAX_AI_ADVANCED_REQUEST_ID_LENGTH = 120;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * AI-2A issues NO portion refs. This frozen empty allowance record is the
 * explicit portion firewall: `sanitizeAiAdvancedPlanResponse` rejects every
 * `portion_ref` against it (`unknown_portion_ref`).
 */
export const AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS: Readonly<
  Record<string, ReadonlyArray<string>>
> = Object.freeze({});

export interface AiAdvancedPlanProviderLine {
  readonly line_ref: string;
  readonly candidates: ReadonlyArray<AiAdvancedCandidateView>;
}

/** The minimal provider-facing plan request. Opaque views only. */
export interface AiAdvancedPlanProviderRequest {
  /** The frozen response contract this request asks for. */
  readonly contract_version: string;
  readonly lines: ReadonlyArray<AiAdvancedPlanProviderLine>;
}

export interface AiAdvancedPlanRequestContext {
  readonly request_version: typeof AI_ADVANCED_PLAN_REQUEST_VERSION;
  /** LOCAL/transport request identity (never part of the frozen plan contract). */
  readonly request_id: string;
  readonly provider_request: AiAdvancedPlanProviderRequest;
  /** Measured UTF-8 byte length of the serialized provider request. */
  readonly provider_request_bytes: number;
  readonly local_lines: ReadonlyArray<AiAdvancedPlanLineSource>;
  readonly allowed_line_refs: ReadonlyArray<string>;
  readonly allowed_candidate_refs_by_line: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Always the frozen EMPTY record for AI-2A (portion firewall). */
  readonly allowed_portion_refs_by_line: Readonly<Record<string, ReadonlyArray<string>>>;
  /** The authoritative local source for one line, if this request issued it. */
  line(lineRef: string): AiAdvancedPlanLineSource | undefined;
}

export type AiAdvancedPlanRequestFailureCode =
  | 'invalid_request_id'
  | 'no_lines'
  | 'too_many_lines'
  | 'duplicate_line_ref'
  | 'invalid_line_source'
  | 'request_too_large';

export type AiAdvancedPlanRequestResult =
  | { readonly ok: true; readonly context: AiAdvancedPlanRequestContext }
  | { readonly ok: false; readonly code: AiAdvancedPlanRequestFailureCode };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function boundedRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AI_ADVANCED_REQUEST_ID_LENGTH) return undefined;
  if (!REQUEST_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function isUsableSource(value: unknown): value is AiAdvancedPlanLineSource {
  const source = asRecord(value);
  if (source === undefined) return false;
  if (source['source_version'] !== AI_ADVANCED_PLAN_SOURCE_VERSION) return false;
  const lineRef = source['line_ref'];
  if (typeof lineRef !== 'string' || lineRef.trim().length === 0) return false;
  if (typeof source['review_digest'] !== 'string' || source['review_digest'].trim().length === 0) {
    return false;
  }
  const refs = source['candidate_refs'];
  if (!Array.isArray(refs) || refs.length === 0) return false;
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length === 0) return false;
    if (ref.length > MAX_AI_ADVANCED_PLAN_TOKEN_LENGTH) return false;
  }
  const set = asRecord(source['candidate_set']);
  if (set === undefined) return false;
  if (set['line_ref'] !== lineRef) return false;
  if (typeof set['resolve'] !== 'function') return false;
  if (!Array.isArray(set['views']) || (set['views'] as ReadonlyArray<unknown>).length === 0) {
    return false;
  }
  return true;
}

/**
 * Builds the bounded request context: caller-supplied request identity, at most
 * 12 lines, one provider-facing line per local source, and a hard 32 KiB UTF-8
 * cap on the serialized provider payload. Never throws.
 */
export function buildAiAdvancedPlanRequestContext(input: {
  readonly requestId: unknown;
  readonly lines: unknown;
}): AiAdvancedPlanRequestResult {
  const requestId = boundedRequestId(input.requestId);
  if (requestId === undefined) return { ok: false, code: 'invalid_request_id' };

  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (rawLines.length === 0) return { ok: false, code: 'no_lines' };
  if (rawLines.length > MAX_AI_ADVANCED_PLAN_LINES) return { ok: false, code: 'too_many_lines' };

  const localLines: AiAdvancedPlanLineSource[] = [];
  const providerLines: AiAdvancedPlanProviderLine[] = [];
  const allowedRefs: Record<string, ReadonlyArray<string>> = {};
  const seen = new Set<string>();

  for (const raw of rawLines) {
    if (!isUsableSource(raw)) return { ok: false, code: 'invalid_line_source' };
    if (seen.has(raw.line_ref)) return { ok: false, code: 'duplicate_line_ref' };
    seen.add(raw.line_ref);

    // The provider view is rebuilt explicitly from the frozen view fields only:
    // nothing else on the local source can leak into the payload.
    const candidates = Object.freeze(
      raw.candidate_set.views.map((view) =>
        Object.freeze({
          candidate_ref: view.candidate_ref,
          display_description: view.display_description,
          semantic_tags: view.semantic_tags,
        })
      )
    );
    providerLines.push(Object.freeze({ line_ref: raw.line_ref, candidates }));
    allowedRefs[raw.line_ref] = Object.freeze([...raw.candidate_refs]);
    localLines.push(raw);
  }

  const providerRequest: AiAdvancedPlanProviderRequest = Object.freeze({
    contract_version: AI_ADVANCED_PLAN_VERSION,
    lines: Object.freeze(providerLines),
  });

  // The payload is locally constructed, so serializing it is safe; the cap is
  // measured in UTF-8 bytes (never UTF-16 code units).
  const bytes = utf8ByteLength(JSON.stringify(providerRequest));
  if (bytes > MAX_AI_ADVANCED_PLAN_REQUEST_BYTES) return { ok: false, code: 'request_too_large' };

  const frozenLocalLines = Object.freeze(localLines);
  const byLine = new Map<string, AiAdvancedPlanLineSource>();
  for (const line of frozenLocalLines) byLine.set(line.line_ref, line);

  const context: AiAdvancedPlanRequestContext = Object.freeze({
    request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
    request_id: requestId,
    provider_request: providerRequest,
    provider_request_bytes: bytes,
    local_lines: frozenLocalLines,
    allowed_line_refs: Object.freeze(frozenLocalLines.map((line) => line.line_ref)),
    allowed_candidate_refs_by_line: Object.freeze(allowedRefs),
    allowed_portion_refs_by_line: AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS,
    line(lineRef: string): AiAdvancedPlanLineSource | undefined {
      return typeof lineRef === 'string' ? byLine.get(lineRef) : undefined;
    },
  });
  return { ok: true, context };
}
