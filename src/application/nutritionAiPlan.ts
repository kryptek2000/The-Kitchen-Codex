/**
 * The Kitchen Codex — application-layer AI Advanced candidate PLANNING requester
 * (AI-2B).
 *
 * Round trip (provider-neutral, provider-free at this layer):
 *
 *   AI-2A request context (opaque refs + request identity)
 *     -> capability gate (ZERO network in Basic/manual mode)
 *     -> POST /api/nutrition/plan-ingredients  (transport envelope)
 *     -> application request-id binding check
 *     -> strict wire-payload reader
 *     -> canonical RE-sanitization (defense in depth: the server already
 *        sanitized; the application never trusts a boundary it can re-check)
 *     -> AI-2B live policy (measure_kind === "unknown", no portion_ref)
 *     -> inert canonical WIRE plan
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not apply a plan, does not
 * call `validateAndApplyAiAdvancedPlan`, does not touch working Phase 4 state,
 * does not persist, does not render, does not select a portion, and grants no
 * nutrition authority. AI-2C owns connecting a live plan to the deterministic
 * acceptance port and app state.
 *
 * The value returned is a frozen WIRE-form plan (`plan_version` on the ENVELOPE
 * only, never inside an entry), so it can be handed to the AI-2A validator later
 * with no shape surgery.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import { buildAiSelectionRequestOptions } from './aiSelection';
import {
  AI_ADVANCED_PLAN_REQUEST_VERSION,
  AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS,
  MAX_AI_ADVANCED_PLAN_LINES,
  type AiAdvancedPlanRequestContext,
} from '../core/nutritionV2/aiAdvancedPlanRequest';
import {
  MAX_AI_ADVANCED_PLANS,
  sanitizeAiAdvancedPlanResponse,
  type AiAdvancedResolutionPlan,
} from '../core/nutritionV2/aiAdvancedPlan';
import { isPlainObject } from '../core/nutritionV2/schema';
import type { NutritionCapabilities } from '../core/nutritionV2/nutritionCapabilities';
import {
  readAiAdvancedPlanWirePayload,
  toAiAdvancedPlanWirePayload,
  type AiAdvancedPlanWirePayload,
} from '../core/nutritionV2/aiAdvancedPlanWire';
import {
  readAiAdvancedPlanTargetBinding,
  sanitizeAiAdvancedPlanTargets,
  type AiAdvancedPlanTarget,
  type AiAdvancedPlanTargetBinding,
} from '../core/nutritionV2/aiAdvancedPlanTarget';

/** The dedicated AI-2B planning endpoint (never the interpretation endpoint). */
export const NUTRITION_PLAN_ENDPOINT = '/api/nutrition/plan-ingredients';

/** The ONLY `measure_kind` the live AI-2B route accepts. */
const AI_2B_LIVE_MEASURE_KIND = 'unknown' as const;

export const AI_PLAN_UNAVAILABLE_MESSAGE =
  'AI planning is unavailable. You can continue with the deterministic analyzer and manual review.';
export const AI_PLAN_INVALID_MESSAGE =
  'The AI planner returned an unusable response. Continue with the deterministic analyzer and manual review.';
export const AI_PLAN_STALE_MESSAGE =
  'The AI planner returned a response for a different request. Continue with the deterministic analyzer and manual review.';
export const AI_PLAN_TARGET_MESSAGE =
  'No usable planning target was available for every ingredient line. Continue with the deterministic analyzer and manual review.';
/**
 * CLOSURE 2 — a target binding whose interpretation fingerprint disagrees with the
 * AI-2A line source it belongs to was built against a DIFFERENT interpretation, so the
 * plan would be answering a question the source no longer asks. Fail closed.
 */
export const AI_PLAN_FINGERPRINT_MESSAGE =
  'The AI planner request was built against a different AI-1 interpretation. Continue with the deterministic analyzer and manual review.';

export type AiAdvancedCandidatePlanFailureCode =
  | 'unavailable'
  | 'provider_error'
  | 'stale_request'
  | 'invalid_response';

export type AiAdvancedCandidatePlanResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly plan: AiAdvancedPlanWirePayload;
      readonly aiAttempted: true;
    }
  | {
      readonly ok: false;
      readonly code: AiAdvancedCandidatePlanFailureCode;
      readonly message: string;
      readonly aiAttempted: boolean;
    };

export interface AiAdvancedCandidatePlanArgs {
  /** The already-built AI-2A request context (opaque refs + request identity). */
  readonly context: AiAdvancedPlanRequestContext;
  readonly network: NetworkAdapter;
  /** The centralized capability model. Planning is an AI-advanced capability. */
  readonly capabilities: NutritionCapabilities;
  /**
   * The bounded semantic PLANNING TARGETS for this request's lines — the wording
   * and canonical semantics the model compares candidates against. Exactly one
   * target per requested line ref is required: without them the planner would be
   * semantically blind (see `aiAdvancedPlanTarget`). AI-2C decides whether a
   * target came from authored ingredient text or from a sanitized AI-1 query; this
   * requester only requires that the coverage be exact.
   *
   * Supply EITHER `targets` (plain) OR `targetBindings` (each binding carries its
   * target plus the LOCAL interpretation fingerprint it was derived from) — not both.
   */
  readonly targets?: ReadonlyArray<AiAdvancedPlanTarget>;
  /**
   * CLOSURE 2 — target bindings: the same targets, each optionally carrying the AI-1
   * interpretation fingerprint it came from. The fingerprint is LOCAL binding metadata:
   * it is compared against the AI-2A line source below and never placed in the
   * provider-facing transport.
   */
  readonly targetBindings?: ReadonlyArray<AiAdvancedPlanTargetBinding>;
}

/**
 * The centralized capability decision for candidate PLANNING. Basic/manual mode
 * (or any non-AI-advanced tier) yields ZERO plan network calls — the route is
 * never contacted and no provider attempt is made.
 */
export function isAiCandidatePlanAvailable(capabilities: NutritionCapabilities): boolean {
  return capabilities.tier === 'ai_advanced' && capabilities.aiCandidateOrchestration === true;
}

function failure(
  code: AiAdvancedCandidatePlanFailureCode,
  message: string,
  aiAttempted: boolean
): AiAdvancedCandidatePlanResult {
  return { ok: false, code, message, aiAttempted };
}

/**
 * Requests ONE live candidate plan for an AI-2A request context. Never throws;
 * never resolves nutrition; never mutates state. Any failure returns a bounded
 * code + message and NO plan, so the deterministic/manual workflow is untouched.
 */
export async function requestAiAdvancedCandidatePlan(
  args: AiAdvancedCandidatePlanArgs
): Promise<AiAdvancedCandidatePlanResult> {
  const { context, network, capabilities } = args;

  // (1) Capability gate BEFORE any network access.
  if (!isAiCandidatePlanAvailable(capabilities)) {
    return failure('unavailable', AI_PLAN_UNAVAILABLE_MESSAGE, false);
  }

  const requestId = context.request_id;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return failure('stale_request', AI_PLAN_STALE_MESSAGE, false);
  }

  // (2) Planning-target coverage BEFORE any network access: every requested line
  // must have exactly one usable target, otherwise the provider would be asked to
  // choose without knowing what it is choosing for. The targets are re-read here
  // (defense in depth) so a malformed target never reaches the transport.
  const bindings = args.targetBindings;
  const plainTargets = args.targets;
  if (bindings !== undefined && plainTargets !== undefined) {
    // Ambiguous input: the caller must supply one or the other.
    return failure('invalid_response', AI_PLAN_TARGET_MESSAGE, false);
  }
  const suppliedTargets: ReadonlyArray<AiAdvancedPlanTarget> | undefined =
    bindings === undefined ? plainTargets : undefined;
  if (bindings === undefined && suppliedTargets === undefined) {
    return failure('invalid_response', AI_PLAN_TARGET_MESSAGE, false);
  }

  // The local fingerprint carried by each binding (never sent anywhere).
  const localFingerprintsByLine = new Map<string, string>();
  let targetsToValidate: ReadonlyArray<AiAdvancedPlanTarget>;
  if (bindings !== undefined) {
    if (!Array.isArray(bindings)) {
      return failure('invalid_response', AI_PLAN_TARGET_MESSAGE, false);
    }
    const collected: AiAdvancedPlanTarget[] = [];
    for (const binding of bindings) {
      // Re-read every binding: a malformed binding (or a binding whose target is not
      // canonical) fails closed here, before any network access.
      const read = readAiAdvancedPlanTargetBinding(binding);
      if (read.ok !== true) {
        return failure('invalid_response', AI_PLAN_TARGET_MESSAGE, false);
      }
      collected.push(read.binding.target);
      if (read.binding.interpretation_fingerprint !== undefined) {
        localFingerprintsByLine.set(read.binding.target.line_ref, read.binding.interpretation_fingerprint);
      }
    }
    targetsToValidate = collected;
  } else {
    targetsToValidate = suppliedTargets ?? [];
  }

  const targets = sanitizeAiAdvancedPlanTargets(targetsToValidate, context.allowed_line_refs);
  if (targets.ok !== true) {
    return failure('invalid_response', AI_PLAN_TARGET_MESSAGE, false);
  }
  // The validated targets, by line, for the local ambiguity/alternative policy below.
  const targetByLine = new Map(targets.targets.map((target) => [target.line_ref, target]));

  // (2b) CLOSURE 2 — FINGERPRINT BINDING CHECK, before ANY provider/network
  // execution. For each exact line ref: the AI-2A plan-line source may carry an
  // interpretation fingerprint, and the AI-2B binding may carry one. If BOTH exist
  // they must match exactly; a mismatch means this request was built against a
  // different interpretation, so the whole request fails closed with ZERO network
  // calls. When only one side carries a fingerprint, nothing is invented and nothing
  // fails: a missing fingerprint is not a disagreement.
  for (const lineRef of context.allowed_line_refs) {
    const sourceFingerprint = context.line(lineRef)?.interpretation_fingerprint;
    const localFingerprint = localFingerprintsByLine.get(lineRef);
    if (sourceFingerprint === undefined || localFingerprint === undefined) continue;
    if (sourceFingerprint !== localFingerprint) {
      return failure('stale_request', AI_PLAN_FINGERPRINT_MESSAGE, false);
    }
  }

  // (3) Transport request. `request_id` is transport identity ONLY; the provider
  // request itself carries line refs, opaque candidate refs, display
  // descriptions and semantic tags — and nothing else.
  let response;
  try {
    response = await network.post<{
      ok?: boolean;
      request_id?: unknown;
      plan?: unknown;
    }>(
      NUTRITION_PLAN_ENDPOINT,
      {
        request_version: AI_ADVANCED_PLAN_REQUEST_VERSION,
        request_id: requestId,
        plan_request: context.provider_request,
        planning_targets: targets.targets,
      },
      await buildAiSelectionRequestOptions()
    );
  } catch {
    return failure('provider_error', AI_PLAN_UNAVAILABLE_MESSAGE, true);
  }

  if (!response || response.ok !== true || !isPlainObject(response.data)) {
    return failure('provider_error', AI_PLAN_UNAVAILABLE_MESSAGE, true);
  }
  const data = response.data as Record<string, unknown>;
  if (data['ok'] !== true) {
    return failure('provider_error', AI_PLAN_UNAVAILABLE_MESSAGE, true);
  }

  // (3) Request-identity binding: the server echoes the id it VALIDATED. A
  // missing, wrong, or replayed id is stale/invalid and yields NO plan.
  const echoed = data['request_id'];
  if (typeof echoed !== 'string' || echoed.length === 0 || echoed !== requestId) {
    return failure('stale_request', AI_PLAN_STALE_MESSAGE, true);
  }

  // (4) Strict wire reader: envelope-only `plan_version`, closed entry keys, no
  // request id inside the plan, no per-entry `plan_version`.
  const wire = readAiAdvancedPlanWirePayload(data['plan']);
  if (wire.ok !== true) {
    return failure('invalid_response', AI_PLAN_INVALID_MESSAGE, true);
  }

  // (5) Canonical RE-sanitization against THIS request's allowances, with the
  // frozen EMPTY portion allowance (portion firewall).
  const sanitized = sanitizeAiAdvancedPlanResponse(wire.payload, {
    allowedLineRefs: context.allowed_line_refs,
    allowedCandidateRefsByLine: context.allowed_candidate_refs_by_line,
    allowedPortionRefsByLine: AI_ADVANCED_PLAN_ALLOWED_PORTION_REFS,
    maxRows: Math.min(MAX_AI_ADVANCED_PLANS, MAX_AI_ADVANCED_PLAN_LINES),
  });
  if (sanitized.ok !== true) {
    return failure('invalid_response', AI_PLAN_INVALID_MESSAGE, true);
  }
  const accepted = sanitized as {
    readonly ok: true;
    readonly plans: ReadonlyArray<AiAdvancedResolutionPlan>;
  };

  // (6) AI-2B live policy, re-enforced locally: a non-`unknown` measure kind or
  // any portion ref rejects the WHOLE response (no partial trust).
  for (const plan of accepted.plans) {
    if (plan.measure_kind !== AI_2B_LIVE_MEASURE_KIND) {
      return failure('invalid_response', AI_PLAN_INVALID_MESSAGE, true);
    }
    if (plan.portion_ref !== undefined) {
      return failure('invalid_response', AI_PLAN_INVALID_MESSAGE, true);
    }
  }

  // (6b) CLOSURE 3 (APPLICATION BOUNDARY) — ambiguity / alternative enforcement,
  // implemented INDEPENDENTLY of the server's identical rule: this must hold even when
  // the response is forged, so it cannot rely on the server having applied it. For any
  // line whose target is ambiguous or carries authored alternatives, the entry loses
  // its candidate authority entirely and becomes an explicit review row.
  const enforcedPlans = accepted.plans.map((entry) => {
    const target = targetByLine.get(entry.line_ref);
    if (target === undefined) return entry;
    const ambiguous = target.ambiguity?.ambiguous === true;
    const hasAlternatives = (target.alternatives?.length ?? 0) > 0;
    if (!ambiguous && !hasAlternatives) return entry;
    const { candidate_ref: _stripped, ...rest } = entry;
    return { ...rest, review_required: true } as typeof entry;
  });

  // (7) Rebuild the canonical WIRE form (envelope-only `plan_version`). The
  // sanitizer's internal per-entry `plan_version` representation is never
  // exposed.
  const plan = toAiAdvancedPlanWirePayload(enforcedPlans);

  return { ok: true, requestId, plan, aiAttempted: true };
}
