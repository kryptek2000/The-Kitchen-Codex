/**
 * The Kitchen Codex — AI Advanced Nutrition: candidate-bound orchestration.
 *
 * PURE, offline. AI may assist with food selection ONLY among a bounded,
 * deterministically supplied candidate set. The provider never sees an FDC id,
 * digest, or any local authority: it sees opaque, request-scoped refs (`c1`,
 * `c2`, ...). Deterministic code maps an accepted ref back to the locally owned
 * authenticated candidate, and the existing identity/measurement gates still
 * decide whether that candidate can be used.
 *
 * HARD RULES
 * ----------
 *  - Unknown ref -> reject. Duplicate local candidate -> request construction
 *    rejects. Candidate absent from the supplied set -> reject.
 *  - AI cannot invent a candidate, reorder authority into existence, or widen
 *    the set.
 *  - An AI choice is a PROPOSAL: it never authorizes Apply and never bypasses
 *    the deterministic confidence matcher, count-portion review, household
 *    registry, or calculator.
 *  - Refs are scoped to the request; they carry no meaning across requests.
 */

export const AI_ADVANCED_CANDIDATE_REF_PREFIX = 'c';
export const AI_ADVANCED_PORTION_REF_PREFIX = 'p';
export const MAX_AI_ADVANCED_CANDIDATES = 12;
export const MAX_AI_ADVANCED_PORTION_OPTIONS = 8;

/** A locally owned, authenticated candidate (never exposed to the provider). */
export interface AiAdvancedLocalCandidate {
  readonly fdc_id: number;
  readonly description: string;
  readonly data_type?: string;
  readonly record_digest?: string;
  readonly semantic_tags?: ReadonlyArray<string>;
}

/** The provider-facing view: opaque ref + display/semantic metadata only. */
export interface AiAdvancedCandidateView {
  readonly candidate_ref: string;
  readonly display_description: string;
  readonly semantic_tags: ReadonlyArray<string>;
}

export type AiAdvancedCandidateSetFailureCode =
  | 'no_candidates'
  | 'too_many_candidates'
  | 'duplicate_candidate'
  | 'invalid_candidate';

export interface AiAdvancedCandidateSet {
  readonly line_ref: string;
  readonly views: ReadonlyArray<AiAdvancedCandidateView>;
  /** Maps an opaque ref back to the locally owned authenticated candidate. */
  resolve(ref: string): AiAdvancedLocalCandidate | undefined;
  /** The request-scoped ref for a local candidate, if supplied. */
  refFor(fdcId: number): string | undefined;
}

export type AiAdvancedCandidateSetResult =
  | { readonly ok: true; readonly set: AiAdvancedCandidateSet }
  | { readonly ok: false; readonly code: AiAdvancedCandidateSetFailureCode };

function finiteFdcId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Builds a request-scoped candidate set. Refs are assigned deterministically as
 * `c1..cN` in input order; input ordering confers NO authority, because the AI
 * choice still passes the existing deterministic gates and duplicate/absent
 * refs fail closed.
 */
export function buildAiAdvancedCandidateSet(input: {
  readonly lineRef: string;
  readonly candidates: ReadonlyArray<AiAdvancedLocalCandidate>;
}): AiAdvancedCandidateSetResult {
  const lineRef = typeof input.lineRef === 'string' ? input.lineRef.trim() : '';
  if (lineRef.length === 0) return { ok: false, code: 'invalid_candidate' };
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  if (candidates.length === 0) return { ok: false, code: 'no_candidates' };
  if (candidates.length > MAX_AI_ADVANCED_CANDIDATES) return { ok: false, code: 'too_many_candidates' };

  const views: AiAdvancedCandidateView[] = [];
  const localByRef = new Map<string, AiAdvancedLocalCandidate>();
  const refByFdcId = new Map<number, string>();
  const seenFdcIds = new Set<number>();

  for (const candidate of candidates) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      !finiteFdcId(candidate.fdc_id) ||
      typeof candidate.description !== 'string' ||
      candidate.description.trim().length === 0
    ) {
      return { ok: false, code: 'invalid_candidate' };
    }
    if (seenFdcIds.has(candidate.fdc_id)) return { ok: false, code: 'duplicate_candidate' };
    seenFdcIds.add(candidate.fdc_id);

    const ref = `${AI_ADVANCED_CANDIDATE_REF_PREFIX}${views.length + 1}`;
    const tags =
      Array.isArray(candidate.semantic_tags)
        ? Object.freeze(
            candidate.semantic_tags
              .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
              .slice(0, 8)
              .map((tag) => tag.trim().slice(0, 40))
          )
        : Object.freeze([]);
    const frozenLocal: AiAdvancedLocalCandidate = Object.freeze({
      fdc_id: candidate.fdc_id,
      description: candidate.description.trim().slice(0, 200),
      ...(typeof candidate.data_type === 'string' && candidate.data_type.trim().length > 0
        ? { data_type: candidate.data_type.trim().slice(0, 40) }
        : {}),
      ...(typeof candidate.record_digest === 'string' && candidate.record_digest.trim().length > 0
        ? { record_digest: candidate.record_digest.trim().slice(0, 200) }
        : {}),
      ...(tags.length > 0 ? { semantic_tags: tags } : {}),
    });
    localByRef.set(ref, frozenLocal);
    refByFdcId.set(candidate.fdc_id, ref);
    views.push(
      Object.freeze({
        candidate_ref: ref,
        display_description: frozenLocal.description,
        semantic_tags: tags,
      })
    );
  }

  const set: AiAdvancedCandidateSet = Object.freeze({
    line_ref: lineRef,
    views: Object.freeze(views),
    resolve(ref: string): AiAdvancedLocalCandidate | undefined {
      return typeof ref === 'string' ? localByRef.get(ref) : undefined;
    },
    refFor(fdcId: number): string | undefined {
      return refByFdcId.get(fdcId);
    },
  });
  return { ok: true, set };
}

// ---------------------------------------------------------------------------
// Portion options (same opaque-ref discipline)
// ---------------------------------------------------------------------------

export interface AiAdvancedLocalPortionOption {
  readonly portion_index: number;
  readonly display_label: string;
  readonly kind?: 'volume' | 'count' | 'household' | 'unknown';
}

export interface AiAdvancedPortionView {
  readonly portion_ref: string;
  readonly display_label: string;
  readonly kind: 'volume' | 'count' | 'household' | 'unknown';
}

export type AiAdvancedPortionSetResult =
  | { readonly ok: true; readonly set: AiAdvancedPortionSet }
  | { readonly ok: false; readonly code: 'no_portions' | 'too_many_portions' | 'duplicate_portion' | 'invalid_portion' };

export interface AiAdvancedPortionSet {
  readonly views: ReadonlyArray<AiAdvancedPortionView>;
  /** Maps an opaque portion ref back to the locally owned authenticated portion. */
  resolve(ref: string): AiAdvancedLocalPortionOption | undefined;
  refFor(portionIndex: number): string | undefined;
}

const PORTION_KINDS: ReadonlyArray<AiAdvancedLocalPortionOption['kind'] & string> = [
  'volume',
  'count',
  'household',
  'unknown',
];

/** Builds a request-scoped portion-option set with `p1..pN` opaque refs. */
export function buildAiAdvancedPortionSet(input: {
  readonly portions: ReadonlyArray<AiAdvancedLocalPortionOption>;
}): AiAdvancedPortionSetResult {
  const portions = Array.isArray(input.portions) ? input.portions : [];
  if (portions.length === 0) return { ok: false, code: 'no_portions' };
  if (portions.length > MAX_AI_ADVANCED_PORTION_OPTIONS) return { ok: false, code: 'too_many_portions' };

  const views: AiAdvancedPortionView[] = [];
  const localByRef = new Map<string, AiAdvancedLocalPortionOption>();
  const refByIndex = new Map<number, string>();
  const seenIndexes = new Set<number>();

  for (const portion of portions) {
    if (
      portion === null ||
      typeof portion !== 'object' ||
      typeof portion.portion_index !== 'number' ||
      !Number.isSafeInteger(portion.portion_index) ||
      portion.portion_index < 0 ||
      typeof portion.display_label !== 'string' ||
      portion.display_label.trim().length === 0
    ) {
      return { ok: false, code: 'invalid_portion' };
    }
    if (seenIndexes.has(portion.portion_index)) return { ok: false, code: 'duplicate_portion' };
    seenIndexes.add(portion.portion_index);

    const kind = portion.kind !== undefined && PORTION_KINDS.includes(portion.kind) ? portion.kind : 'unknown';
    const ref = `${AI_ADVANCED_PORTION_REF_PREFIX}${views.length + 1}`;
    const frozenLocal: AiAdvancedLocalPortionOption = Object.freeze({
      portion_index: portion.portion_index,
      display_label: portion.display_label.trim().slice(0, 200),
      kind,
    });
    localByRef.set(ref, frozenLocal);
    refByIndex.set(portion.portion_index, ref);
    views.push(
      Object.freeze({
        portion_ref: ref,
        display_label: frozenLocal.display_label,
        kind,
      })
    );
  }

  const set: AiAdvancedPortionSet = Object.freeze({
    views: Object.freeze(views),
    resolve(ref: string): AiAdvancedLocalPortionOption | undefined {
      return typeof ref === 'string' ? localByRef.get(ref) : undefined;
    },
    refFor(portionIndex: number): string | undefined {
      return refByIndex.get(portionIndex);
    },
  });
  return { ok: true, set };
}
