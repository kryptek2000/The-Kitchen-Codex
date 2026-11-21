/**
 * The Kitchen Codex — AI-FIRST Advanced Nutrition: bounded candidate-evaluation
 * contract.
 *
 * PURE, platform-neutral, offline. This is the SECOND (and final) structured AI
 * pass in the AI-first Generate workflow:
 *
 *   whole-recipe interpretation (pass 1)
 *     -> local full-catalog USDA discovery
 *     -> THIS bounded candidate evaluation (pass 2)
 *     -> local deterministic verification / calculation
 *
 * The model never sees an FDC id, record digest, catalog digest, gram value,
 * portion index or nutrient value. It receives opaque, request-scoped candidate
 * refs (`c1`, `c2`, ...) that are meaningful only inside the exact target set
 * supplied by the caller. The server sanitizes the whole response; the browser
 * re-sanitizes it against its OWN locally owned candidate map before any local
 * record is resolved.
 *
 * AUTHORITY BOUNDARY
 * ------------------
 *   - A decision is a PROPOSAL. It never establishes food identity, mass,
 *     nutrition, Apply authority, or persistence.
 *   - `select` must name a candidate ref that was supplied for the SAME target.
 *     Unknown, duplicated, extra and missing refs fail the WHOLE response.
 *   - An empty candidate set can only produce `no_match` or `needs_review`.
 *   - The closed key sets make an authority-looking field (`fdc_id`,
 *     `record_digest`, `grams`, `nutrients`, `apply`, ...) a hard refusal.
 */

import { isPlainObject, toInertValue } from './schema';

export const AI_FIRST_CANDIDATE_EVALUATION_VERSION =
  'nutrition_ai_first_candidate_evaluation_v1' as const;
export const AI_FIRST_CANDIDATE_EVALUATION_REQUEST_VERSION =
  'nutrition_ai_first_candidate_evaluation_request_v1' as const;

export const MAX_AI_FIRST_TARGETS = 25;
export const MAX_AI_FIRST_CANDIDATES_PER_TARGET = 8;
export const MAX_AI_FIRST_CANDIDATE_REF_LENGTH = 12;
export const MAX_AI_FIRST_CANDIDATE_DESCRIPTION_LENGTH = 240;
export const MAX_AI_FIRST_CANDIDATE_DATA_TYPE_LENGTH = 32;
export const MAX_AI_FIRST_JUSTIFICATION_LENGTH = 320;
export const MAX_AI_FIRST_UNCERTAINTY_LENGTH = 320;
export const MAX_AI_FIRST_RESPONSE_BYTES = 32 * 1024;

export const AI_FIRST_DECISION_VALUES = Object.freeze([
  'select',
  'no_match',
  'needs_review',
] as const);

export type AiFirstDecisionValue = (typeof AI_FIRST_DECISION_VALUES)[number];

/** One bounded, opaque candidate view the model may evaluate. */
export interface AiFirstCandidateView {
  readonly candidate_ref: string;
  readonly description: string;
  readonly data_type: string;
  /**
   * Bounded, display-only authenticated portion hint from the local catalog
   * (e.g. `1 cup = 242 g`). It is NOT a model-supplied gram value and grants no
   * authority; it exists so the model can prefer a record the user can actually
   * measure when two descriptions are otherwise defensible.
   */
  readonly portion_summary?: string;
}

/** One target plus its request-scoped candidate set. */
export interface AiFirstTargetCandidates {
  readonly line_ref: string;
  readonly candidates: ReadonlyArray<AiFirstCandidateView>;
}

/** One sanitized model decision. */
export interface AiFirstCandidateDecision {
  readonly line_ref: string;
  readonly decision: AiFirstDecisionValue;
  /** Present ONLY for `select`; always one of the refs supplied for this target. */
  readonly candidate_ref: string | null;
  readonly justification: string;
  readonly uncertainty: string;
}

export type AiFirstEvaluationFailureCode =
  | 'invalid_request'
  | 'invalid_response'
  | 'unknown_line_ref'
  | 'duplicate_line_ref'
  | 'unknown_candidate_ref'
  | 'missing_line_ref';

export type AiFirstEvaluationSanitizeResult =
  | {
      readonly ok: true;
      readonly decisions: ReadonlyArray<AiFirstCandidateDecision>;
    }
  | { readonly ok: false; readonly code: AiFirstEvaluationFailureCode };

const RESPONSE_KEYS = new Set([
  'contract_version',
  'decisions',
]);

const DECISION_KEYS = new Set([
  'line_ref',
  'decision',
  'candidate_ref',
  'justification',
  'uncertainty',
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > max) return undefined;
  if (CONTROL_CHARACTERS.test(value)) return undefined;
  return value;
}

function boundedOptionalString(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  if (value.length > max) return undefined;
  if (CONTROL_CHARACTERS.test(value)) return undefined;
  return value;
}

function isDecisionValue(value: unknown): value is AiFirstDecisionValue {
  return value === 'select' || value === 'no_match' || value === 'needs_review';
}

/**
 * Sanitizes a model candidate-evaluation response against the EXACT request
 * candidate map.
 *
 * The whole response is refused if any structural obligation fails. That is
 * deliberate: a partially trusted decision set would make "the model answered
 * for this line" ambiguous, and ambiguity must never become selection authority.
 */
export function sanitizeAiFirstEvaluationResponse(
  raw: unknown,
  allowed: ReadonlyMap<string, ReadonlySet<string>>
): AiFirstEvaluationSanitizeResult {
  const materialized = toInertValue(raw);
  if (!materialized.ok || !isPlainObject(materialized.value)) {
    return { ok: false, code: 'invalid_response' };
  }
  const envelope = materialized.value;
  for (const key of Object.keys(envelope)) {
    if (!RESPONSE_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
  }
  if (envelope['contract_version'] !== AI_FIRST_CANDIDATE_EVALUATION_VERSION) {
    return { ok: false, code: 'invalid_response' };
  }
  const rows = envelope['decisions'];
  if (!Array.isArray(rows)) return { ok: false, code: 'invalid_response' };
  if (rows.length !== allowed.size) return { ok: false, code: 'invalid_response' };

  const seen = new Set<string>();
  const decisions: AiFirstCandidateDecision[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) return { ok: false, code: 'invalid_response' };
    for (const key of Object.keys(row)) {
      if (!DECISION_KEYS.has(key)) return { ok: false, code: 'invalid_response' };
    }
    const lineRef = boundedString(row['line_ref'], 200);
    if (lineRef === undefined) return { ok: false, code: 'invalid_response' };
    const allowedRefs = allowed.get(lineRef);
    if (allowedRefs === undefined) return { ok: false, code: 'unknown_line_ref' };
    if (seen.has(lineRef)) return { ok: false, code: 'duplicate_line_ref' };
    seen.add(lineRef);

    const decision = row['decision'];
    if (!isDecisionValue(decision)) return { ok: false, code: 'invalid_response' };
    const rawCandidateRef = row['candidate_ref'];
    if (
      rawCandidateRef !== undefined &&
      rawCandidateRef !== null &&
      typeof rawCandidateRef !== 'string'
    ) {
      return { ok: false, code: 'invalid_response' };
    }
    const candidateRef = typeof rawCandidateRef === 'string' ? rawCandidateRef.trim() : '';
    if (candidateRef.length > MAX_AI_FIRST_CANDIDATE_REF_LENGTH) {
      return { ok: false, code: 'invalid_response' };
    }
    if (decision === 'select') {
      if (candidateRef.length === 0 || !allowedRefs.has(candidateRef)) {
        return { ok: false, code: 'unknown_candidate_ref' };
      }
    } else if (candidateRef.length !== 0) {
      // A non-selection must not secretly name a record. Refuse rather than
      // silently discarding the ref, so an ambiguous answer can never be read as
      // a selection by a later consumer.
      return { ok: false, code: 'invalid_response' };
    }

    const justification = boundedString(row['justification'], MAX_AI_FIRST_JUSTIFICATION_LENGTH);
    if (justification === undefined) return { ok: false, code: 'invalid_response' };
    const uncertainty = boundedOptionalString(row['uncertainty'], MAX_AI_FIRST_UNCERTAINTY_LENGTH);
    if (uncertainty === undefined) return { ok: false, code: 'invalid_response' };

    decisions.push(
      Object.freeze({
        line_ref: lineRef,
        decision,
        candidate_ref: decision === 'select' ? candidateRef : null,
        justification: justification.trim(),
        uncertainty: (uncertainty ?? '').trim(),
      })
    );
  }

  if (seen.size !== allowed.size) return { ok: false, code: 'missing_line_ref' };
  return { ok: true, decisions: Object.freeze(decisions) };
}

/** Builds the exact request-scoped ref map the sanitizer enforces. */
export function aiFirstAllowedCandidateRefs(
  targets: ReadonlyArray<AiFirstTargetCandidates>
): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const target of targets) {
    map.set(target.line_ref, new Set(target.candidates.map((candidate) => candidate.candidate_ref)));
  }
  return map;
}
