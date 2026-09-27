/**
 * The Kitchen Codex — Advanced Nutrition AI-2A: deterministic plan validator.
 *
 * PURE, platform-neutral, provider-free, side-effect free. Validates a raw or
 * already-sanitized `nutrition_ai_advanced_plan_v1` response against the EXACT
 * request-scoped context that was issued, resolves opaque refs through the LOCAL
 * candidate maps only, and classifies each line as
 *
 *   automatic | offer | review
 *
 * using the EXISTING deterministic production acceptance rules.
 *
 * AUTHORITY BOUNDARY (the whole point of AI-2A)
 * --------------------------------------------
 *   - AI NEVER CREATES AUTHORITY. `automatic` is returned only when the SAME
 *     candidate would ALREADY be accepted automatically by the STRICT existing
 *     deterministic rule for that bound review (`selectAutomaticMatch`). AI
 *     agreement adds zero authority; a candidate the strict rule would
 *     not auto-accept can at most become an OFFER requiring explicit user
 *     confirmation.
 *   - AI-SPECIFIC SUBTRACTIVE SAFETY POLICY (deliberate, documented). The
 *     ordinary deterministic system grants automatic authority more broadly:
 *     `isDeterministicAutomaticSelection` accepts either the
 *     strict automatic choice OR a safe best-effort same-family default. For
 *     an AI-SELECTED candidate, AI-2A intentionally spends only the strict
 *     branch: a best-effort-only AI candidate is classified `offer`
 *     (`deterministic_best_effort_only`) even though the ordinary
 *     deterministic analyzer could use it automatically. AI does not gain the
 *     right to spend the broader best-effort automatic authority merely
 *     because the deterministic analyzer may do so without AI. This does not
 *     redefine or weaken the deterministic matcher and does not alter
 *     Basic/manual behavior.
 *   - THREE DISTINCT DETERMINISTIC CLASSES (exact, not conflated):
 *       1. STRICT AUTOMATIC      -> `selectAutomaticMatch` (may stay automatic);
 *       2. BEST-EFFORT ELIGIBLE  -> the family accepted by the existing
 *          `isDeterministicBestEffortSelection`, which includes
 *          every safe same-family sibling, not only the DEFAULT returned by
 *          `selectBestEffortMatch`; any member of this family (default or
 *          non-default sibling) is an `offer` / `deterministic_best_effort_only`;
 *       3. BELOW BOTH SETS       -> `offer` / `below_deterministic_threshold`.
 *     `deterministic_best_effort_only` therefore means MEMBERSHIP IN THE
 *     DETERMINISTIC BEST-EFFORT ELIGIBLE FAMILY, never merely "equals the
 *     best-effort default".
 *   - AI CONFIDENCE IS SUBTRACTIVE ONLY. `medium` / `low` force an offer, and
 *     `high` can never promote: it merely fails to subtract.
 *   - ANTI-LAUNDERING: a line whose trusted issue kind is `review_suggested`
 *     (the deterministic matcher already refused to auto-accept) can never be
 *     returned as `automatic`, no matter what the provider says.
 *   - OPAQUE REFS ONLY: a candidate is resolved through `candidateSet.resolve`,
 *     never from an AI-authored FDC id (the contract has no such field) and
 *     never by re-querying the matcher with AI text.
 *   - A plan is discarded WHOLE on any request-identity or sanitizer failure, and
 *     PER LINE on any binding failure (stale review digest, changed
 *     interpretation fingerprint, candidate no longer in the bound review,
 *     record-digest mismatch).
 *   - ZERO portion refs are issued, so `portion_ref` always fails closed
 *     (`unknown_portion_ref`); no grams/mass/portion authority exists here.
 *   - Result objects are inert, frozen, local-only (they carry a local FDC id
 *     for the caller's deterministic path but are NEVER provider-facing), and no
 *     Phase4 state, persistence, storage, vault, server, UI or provider module
 *     is reachable from this module.
 *
 * DETERMINISTIC ACCEPTANCE PORT (layering)
 * ----------------------------------------
 *   The repository's audited Phase 2 isolation rule
 *   (`tests/security/usdaMatchingIsolation.test.ts`) allows `matching/*` to be
 *   imported ONLY by the Phase 4 review/display boundary (plus Phase 3/5C). This
 *   module is a pure core contract, so it must NOT import `matching/confidence`
 *   directly. Instead the caller injects `deterministicAcceptance`, a port that
 *   returns what the EXISTING predicates decided for a review:
 *
 *     {
 *       strict_automatic_fdc_id?: number,        // from selectAutomaticMatch
 *       best_effort_default_fdc_id?: number,     // from selectBestEffortMatch
 *       best_effort_eligible_fdc_ids?: readonly number[],
 *                                                // from the
 *                                                // isDeterministicBestEffortSelection
 *                                                // family over the review's candidates
 *     }
 *
 *   The STRICT branch is named explicitly so it can never be confused with the
 *   broader production predicate `isDeterministicAutomaticSelection` (strict
 *   OR safe best-effort same-family default). The best-effort surface is split
 *   in two so the label can never overstate OR understate the truth:
 *   `best_effort_default_fdc_id` is the single DEFAULT candidate
 *   `selectBestEffortMatch` returns, while `best_effort_eligible_fdc_ids` is the
 *   FULL eligible family accepted by `isDeterministicBestEffortSelection`. Only
 *   the family drives the label; the default is carried for telemetry. The
 *   canonical implementation is the Phase 4 boundary
 *   (`deterministicAcceptanceView`, wired by AI-2C); tests inject it directly.
 *   The port can only ever supply existing decisions — it is not a threshold
 *   hook: `automatic` is granted solely when `strict_automatic_fdc_id` equals the
 *   candidate that this plan resolved locally. No port, no automatic.
 */

import {
  MAX_AI_ADVANCED_PLANS,
  sanitizeAiAdvancedPlanResponse,
  type AiAdvancedPlanFailureCode,
} from './aiAdvancedPlan';
import { AI_RESOLUTION_ISSUE_KINDS, type AiResolutionIssueKind } from './aiResolution';
import { AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS, MAX_AI_ADVANCED_PLAN_LINES, type AiAdvancedPlanRequestContext } from './aiAdvancedPlanRequest';
import { AI_ADVANCED_PLAN_REQUEST_VERSION } from './aiAdvancedPlanRequest';

export const AI_ADVANCED_PLAN_APPLY_VERSION = 'nutrition_ai_advanced_plan_apply_v1';

export type AiAdvancedPlanApplyFailureCode =
  | AiAdvancedPlanFailureCode
  | 'stale_request'
  | 'invalid_context'
  | 'invalid_reviews'
  | 'invalid_acceptance_port'
  | 'ref_namespace';

/**
 * What the EXISTING deterministic confidence contract decided for one review.
 * Supplied by the Phase 4 boundary (the only layer allowed to import Phase 2).
 *
 * The strict branch is named `strict_automatic_fdc_id` (NOT `automatic_fdc_id`)
 * so it can never be confused with the broader production predicate
 * `isDeterministicAutomaticSelection` (strict OR safe best-effort default).
 */
export interface AiAdvancedDeterministicAcceptance {
  /** fdc_id the strict deterministic automatic rule would auto-accept, when one exists. */
  readonly strict_automatic_fdc_id?: number;
  /**
   * The single DEFAULT candidate `selectBestEffortMatch` returns, when
   * one exists. Informational: classification uses the eligible family below,
   * which contains this value, so a port reporting only the default loses the
   * label but can never gain authority.
   */
  readonly best_effort_default_fdc_id?: number;
  /**
   * The FULL deterministic best-effort eligible family: every candidate fdc_id
   * for which the existing `isDeterministicBestEffortSelection`
   * is true. AI-2A never re-derives this and never invents thresholds; a
   * missing/non-array value is treated as empty, which can only cost the
   * `deterministic_best_effort_only` label — never grant authority.
   */
  readonly best_effort_eligible_fdc_ids?: readonly number[];
}

/** The injected port. It may only report existing deterministic decisions. */
export type AiAdvancedDeterministicAcceptancePort = (
  review: unknown
) => AiAdvancedDeterministicAcceptance | undefined;

export type AiAdvancedPlanLineStatus = 'automatic' | 'offer' | 'review';

/** Closed reason vocabulary. Every outcome explains itself deterministically. */
export type AiAdvancedPlanLineReason =
  // automatic
  | 'deterministic_automatic'
  // offer (subtractive reasons, in priority order)
  | 'review_suggested_issue_kind'
  | 'review_required_declared'
  | 'ambiguity_declared'
  | 'confidence_not_high'
  | 'deterministic_best_effort_only'
  | 'below_deterministic_threshold'
  // review
  | 'no_plan'
  | 'no_candidate_proposed'
  | 'unknown_line_ref'
  | 'review_unavailable'
  | 'unusable_review'
  | 'stale_review'
  | 'stale_interpretation'
  | 'unknown_candidate_ref'
  | 'candidate_not_in_review'
  | 'record_digest_mismatch';

export interface AiAdvancedPlanLineOutcome {
  readonly line_ref: string;
  readonly status: AiAdvancedPlanLineStatus;
  readonly reason: AiAdvancedPlanLineReason;
  /** The opaque ref the provider proposed, when it proposed one. */
  readonly candidate_ref?: string;
  /**
   * LOCAL ONLY. The authenticated FDC id of the resolved candidate, for the
   * caller's deterministic path. Never serialize this towards a provider.
   */
  readonly local_fdc_id?: number;
  /** Would the SAME candidate be auto-accepted by the STRICT deterministic rule (`selectAutomaticMatch` only — not the broader `isDeterministicAutomaticSelection`)? */
  readonly matches_strict_automatic: boolean;
  /**
   * Is the SAME candidate a member of the deterministic BEST-EFFORT ELIGIBLE
   * family (the existing `isDeterministicBestEffortSelection`
   * set — every safe same-family sibling, not only
   * `selectBestEffortMatch`'s default)? Membership, not default equality, is
   * what `deterministic_best_effort_only` reports.
   */
  readonly matches_best_effort_eligible: boolean;
  /**
   * ADVISORY ONLY (echoed, never acted on): the provider's declared measure
   * kind. AI-2A issues no portion refs and grants no mass/portion authority.
   */
  readonly advisory_measure_kind?: string;
}

export interface AiAdvancedPlanApplication {
  readonly apply_version: typeof AI_ADVANCED_PLAN_APPLY_VERSION;
  readonly request_id: string;
  /** One outcome per REQUESTED line, in request order (complete statement). */
  readonly lines: ReadonlyArray<AiAdvancedPlanLineOutcome>;
  readonly automatic_count: number;
  readonly offer_count: number;
  readonly review_count: number;
}

export type AiAdvancedPlanApplyResult =
  | { readonly ok: true; readonly application: AiAdvancedPlanApplication }
  | { readonly ok: false; readonly code: AiAdvancedPlanApplyFailureCode };

type ReviewRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ReviewRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function isIssueKind(value: unknown): value is AiResolutionIssueKind {
  return (
    typeof value === 'string' && (AI_RESOLUTION_ISSUE_KINDS as ReadonlyArray<string>).includes(value)
  );
}

/** Structural guard for the request context this module was handed. */
function asUsableContext(value: unknown): AiAdvancedPlanRequestContext | undefined {
  if (!isRecord(value)) return undefined;
  if (value['request_version'] !== AI_ADVANCED_PLAN_REQUEST_VERSION) return undefined;
  if (typeof value['request_id'] !== 'string' || value['request_id'].length === 0) return undefined;
  if (typeof value['line'] !== 'function') return undefined;
  if (!Array.isArray(value['allowed_line_refs'])) return undefined;
  if (!isRecord(value['allowed_candidate_refs_by_line'])) return undefined;
  return value as unknown as AiAdvancedPlanRequestContext;
}

/**
 * EXPLICIT REF NAMESPACE GUARD (AI-2A own invariant, so the rule is local rather
 * than emergent from disjoint allowance records):
 *   - a candidate ref must start with `c`;
 *   - a portion ref must never start with `c`;
 *   - a `p`-ref in candidate position is rejected here, before the sanitizer.
 * Any portion ref at all is rejected by the sanitizer against the frozen EMPTY
 * portion allowance (`unknown_portion_ref`).
 */
function namespaceViolation(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const plans = raw['plans'];
  if (!Array.isArray(plans)) return false;
  for (const entry of plans) {
    if (!isRecord(entry)) continue;
    const candidateRef = entry['candidate_ref'];
    if (candidateRef !== undefined && candidateRef !== null) {
      if (typeof candidateRef !== 'string') return true;
      if (!candidateRef.startsWith('c')) return true;
    }
    const portionRef = entry['portion_ref'];
    if (portionRef !== undefined && portionRef !== null) {
      if (typeof portionRef !== 'string') return true;
      if (portionRef.startsWith('c')) return true;
    }
  }
  return false;
}

/** Accepts a Map, an array of `{line_ref, review}`, or a plain record. */
function reviewMap(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const out = new Map<string, unknown>();
  if (value instanceof Map) {
    for (const [key, entry] of value.entries()) {
      if (typeof key !== 'string' || key.length === 0) return undefined;
      out.set(key, entry);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) return undefined;
      const lineRef = entry['line_ref'];
      if (typeof lineRef !== 'string' || lineRef.length === 0) return undefined;
      out.set(lineRef, entry['review']);
    }
    return out;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) out.set(key, entry);
    return out;
  }
  return undefined;
}

function currentReviewCandidates(review: unknown): ReadonlyArray<ReviewRecord> {
  if (!isRecord(review)) return [];
  const candidates = review['candidates'];
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((entry): entry is ReviewRecord => isRecord(entry));
}

/**
 * Validates one sanitized plan against the bound deterministic review.
 * PURE: it inspects, it classifies, it never writes and never persists.
 */
function evaluateLine(input: {
  readonly lineRef: string;
  readonly acceptance: AiAdvancedDeterministicAcceptancePort;
  readonly plan: Record<string, unknown> | undefined;
  readonly source: { readonly review_digest: string; readonly interpretation_fingerprint?: string; readonly candidate_set: { resolve(ref: string): { fdc_id: number; record_digest?: string } | undefined } } | undefined;
  readonly review: unknown;
  readonly issueKind: AiResolutionIssueKind | undefined;
  readonly currentFingerprint: string | undefined;
}): AiAdvancedPlanLineOutcome {
  const { lineRef, plan, source, review, issueKind } = input;
  const base = { line_ref: lineRef, matches_strict_automatic: false, matches_best_effort_eligible: false } as const;
  const reviewOutcome = isRecord(review) ? review['outcome'] : undefined;

  if (plan === undefined) {
    return Object.freeze({ ...base, status: 'review', reason: 'no_plan' });
  }
  const measureKind = boundedText(plan['measure_kind'], 40);
  const declared = typeof plan['review_required'] === 'boolean' ? plan['review_required'] : undefined;
  const reasons = Array.isArray(plan['ambiguity_reasons']) ? plan['ambiguity_reasons'].length : 0;
  const confidence = plan['confidence'];
  const candidateRef = typeof plan['candidate_ref'] === 'string' ? plan['candidate_ref'] : undefined;
  const withPlan = {
    ...base,
    ...(measureKind !== undefined ? { advisory_measure_kind: measureKind } : {}),
  } as const;

  if (candidateRef === undefined) {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'no_candidate_proposed' });
  }
  if (source === undefined) {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'unknown_line_ref', candidate_ref: candidateRef });
  }
  if (reviewOutcome !== 'matched_exact' && reviewOutcome !== 'review_required') {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'unusable_review', candidate_ref: candidateRef });
  }
  const currentDigest = boundedText(isRecord(review) ? review['review_digest'] : undefined, 200);
  if (currentDigest === undefined || currentDigest !== source.review_digest) {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'stale_review', candidate_ref: candidateRef });
  }
  if (source.interpretation_fingerprint !== undefined && input.currentFingerprint !== source.interpretation_fingerprint) {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'stale_interpretation', candidate_ref: candidateRef });
  }

  const resolved = source.candidate_set.resolve(candidateRef);
  if (resolved === undefined) {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'unknown_candidate_ref', candidate_ref: candidateRef });
  }

  const bound = currentReviewCandidates(review).find((entry) => entry['fdc_id'] === resolved.fdc_id);
  if (bound === undefined) {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'candidate_not_in_review', candidate_ref: candidateRef });
  }
  if (resolved.record_digest !== undefined && bound['record_digest'] !== resolved.record_digest) {
    return Object.freeze({ ...withPlan, status: 'review', reason: 'record_digest_mismatch', candidate_ref: candidateRef });
  }

  // EXISTING DETERMINISTIC PRODUCTION RULES, via the injected port: no new
  // ranking, no new threshold, and no Phase 2 import from this pure contract.
  const acceptance = input.acceptance(review);
  const matchesAutomatic =
    acceptance !== undefined && acceptance.strict_automatic_fdc_id === resolved.fdc_id;
  // MEMBERSHIP IN THE ELIGIBLE FAMILY (not default equality): the existing
  // deterministic predicate accepts ANY safe same-family sibling, so a
  // non-default sibling must be labelled identically to the default.
  const eligible =
    acceptance !== undefined && Array.isArray(acceptance.best_effort_eligible_fdc_ids)
      ? acceptance.best_effort_eligible_fdc_ids
      : [];
  const matchesBestEffortEligible = eligible.includes(resolved.fdc_id);
  const shaped = {
    ...withPlan,
    candidate_ref: candidateRef,
    local_fdc_id: resolved.fdc_id,
    matches_strict_automatic: matchesAutomatic,
    matches_best_effort_eligible: matchesBestEffortEligible,
  } as const;

  const subtractive: AiAdvancedPlanLineReason | undefined =
    issueKind === 'review_suggested'
      ? 'review_suggested_issue_kind'
      : declared === true
        ? 'review_required_declared'
        : reasons > 0
          ? 'ambiguity_declared'
          : confidence === 'medium' || confidence === 'low'
            ? 'confidence_not_high'
            : undefined;

  if (matchesAutomatic && subtractive === undefined) {
    return Object.freeze({ ...shaped, status: 'automatic', reason: 'deterministic_automatic' });
  }
  const reason: AiAdvancedPlanLineReason =
    subtractive ??
    (matchesBestEffortEligible ? 'deterministic_best_effort_only' : 'below_deterministic_threshold');
  return Object.freeze({ ...shaped, status: 'offer', reason });
}

/**
 * Validates and classifies one plan response against its request context.
 * Never throws. Returns inert results only.
 */
export function validateAndApplyAiAdvancedPlan(input: {
  readonly rawPlanResponse: unknown;
  readonly responseRequestId: unknown;
  readonly context: unknown;
  /** Current deterministic reviews: Map, `{line_ref, review}[]`, or record. */
  readonly reviews: unknown;
  /**
   * REQUIRED port reporting what the existing deterministic predicates decided.
   * Absent or non-callable: the whole response is discarded, because AI-2A can
   * never grant `automatic` without the genuine deterministic decision.
   */
  readonly deterministicAcceptance: unknown;
  readonly issueKinds?: unknown;
  /** Current interpretation fingerprints, when the source carried one. */
  readonly interpretationFingerprints?: unknown;
}): AiAdvancedPlanApplyResult {
  const context = asUsableContext(input.context);
  if (context === undefined) return { ok: false, code: 'invalid_context' };
  if (typeof input.deterministicAcceptance !== 'function') {
    return { ok: false, code: 'invalid_acceptance_port' };
  }
  const acceptance = input.deterministicAcceptance as AiAdvancedDeterministicAcceptancePort;

  // (1) REQUEST IDENTITY: a response for another request is discarded WHOLE.
  if (typeof input.responseRequestId !== 'string' || input.responseRequestId !== context.request_id) {
    return { ok: false, code: 'stale_request' };
  }

  // (2) REF NAMESPACE (AI-2A-local invariant), before any trust is granted.
  let namespaceBad = false;
  try {
    namespaceBad = namespaceViolation(input.rawPlanResponse);
  } catch {
    return { ok: false, code: 'unsafe_response' };
  }
  if (namespaceBad) return { ok: false, code: 'ref_namespace' };

  // (3) CANONICAL RE-SANITIZATION: exact allowed line refs, exact per-line
  // candidate refs, and the frozen EMPTY portion allowance (portion firewall).
  const sanitized = sanitizeAiAdvancedPlanResponse(input.rawPlanResponse, {
    allowedLineRefs: context.allowed_line_refs,
    allowedCandidateRefsByLine: context.allowed_candidate_refs_by_line,
    allowedPortionRefsByLine: AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS,
    maxRows: Math.min(MAX_AI_ADVANCED_PLANS, MAX_AI_ADVANCED_PLAN_LINES),
  });
  if (sanitized.ok !== true) return { ok: false, code: sanitized.code };

  const reviews = reviewMap(input.reviews);
  if (reviews === undefined) return { ok: false, code: 'invalid_reviews' };

  const issueKinds = isRecord(input.issueKinds) ? input.issueKinds : {};
  const fingerprints = isRecord(input.interpretationFingerprints) ? input.interpretationFingerprints : {};

  const plans = sanitized.plans as unknown as ReadonlyArray<Record<string, unknown>>;
  const outcomes: AiAdvancedPlanLineOutcome[] = [];
  for (const line of context.local_lines) {
    const plan = plans.find((entry) => entry['line_ref'] === line.line_ref);
    const rawIssueKind = issueKinds[line.line_ref];
    const issueKind = isIssueKind(rawIssueKind) ? rawIssueKind : line.issue_kind;
    const currentFingerprint = boundedText(fingerprints[line.line_ref], 200);
    outcomes.push(
      evaluateLine({
        lineRef: line.line_ref,
        acceptance,
        plan: plan as Record<string, unknown> | undefined,
        source: line,
        review: reviews.get(line.line_ref),
        issueKind,
        currentFingerprint,
      })
    );
  }

  const frozenOutcomes = Object.freeze(outcomes);
  const application: AiAdvancedPlanApplication = Object.freeze({
    apply_version: AI_ADVANCED_PLAN_APPLY_VERSION,
    request_id: context.request_id,
    lines: frozenOutcomes,
    automatic_count: frozenOutcomes.filter((entry) => entry.status === 'automatic').length,
    offer_count: frozenOutcomes.filter((entry) => entry.status === 'offer').length,
    review_count: frozenOutcomes.filter((entry) => entry.status === 'review').length,
  });
  return { ok: true, application };
}