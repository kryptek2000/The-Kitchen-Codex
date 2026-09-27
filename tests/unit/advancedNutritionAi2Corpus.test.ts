/**
 * The Kitchen Codex — AI-2A candidate authority corpus (REAL pinned bundle).
 *
 * Proves the AI-2A invariants against the genuine deterministic matcher on the
 * pinned USDA bundle:
 *   - the corpus is projected into opaque refs without leaking identity;
 *   - AI agreement NEVER creates automatic authority: a line becomes `automatic`
 *     only when the EXISTING deterministic rule already auto-accepts that exact
 *     candidate, otherwise it is an OFFER (or REVIEW);
 *   - declared ambiguity / `medium` confidence / `review_required` only subtract;
 *   - a `review_suggested` row can never be laundered into an automatic match;
 *   - the adversarial matrix fails closed on REAL reviews;
 *   - the provider payload stays opaque and inside the 32 KiB cap on real data.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import {
  isDeterministicBestEffortSelection,
  selectAutomaticMatch,
  selectBestEffortMatch,
} from '../../src/core/nutritionV2/matching/confidence';
import { buildAiAdvancedPlanLineSource } from '../../src/core/nutritionV2/aiAdvancedPlanSource';
import {
  MAX_AI_ADVANCED_PLAN_REQUEST_BYTES,
  buildAiAdvancedPlanRequestContext,
  type AiAdvancedPlanRequestContext,
} from '../../src/core/nutritionV2/aiAdvancedPlanRequest';
import {
  validateAndApplyAiAdvancedPlan,
  type AiAdvancedPlanLineOutcome,
} from '../../src/core/nutritionV2/aiAdvancedPlanApply';
import { AI_ADVANCED_PLAN_VERSION } from '../../src/core/nutritionV2/aiAdvancedPlan';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

/** The §12 corpus: clear, ambiguous, state-sensitive, household and alternative wording. */
const CORPUS: ReadonlyArray<string> = Object.freeze([
  // obvious single candidate
  'soy sauce',
  'honey',
  'vanilla extract',
  // meaningful ambiguity
  'tomato sauce',
  'sausage',
  'hamburger',
  'cream',
  'chili powder',
  // state-sensitive
  'chicken breast',
  'chicken breast, cooked',
  'canned tomatoes',
  'dried beans',
  'cooked beans',
  // household / count wording (candidate identity only in AI-2A)
  'bacon',
  'garlic cloves',
  'eggs',
  'black beans',
  'spinach',
  // alternatives
  'butter or olive oil',
]);

const REQUEST_ID = 'req-ai2a-corpus';

let session: AdvancedNutritionSession;
const reviews = new Map<string, Record<string, unknown>>();

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) {
    throw new Error(`bundle failed: ${(result as { failure: { code: string } }).failure.code}`);
  }
  session = result.session;
  for (const line of CORPUS) {
    reviews.set(line, session.reviewIngredient({ name: line }) as unknown as Record<string, unknown>);
  }
  // Policy-probe lines (NOT part of CORPUS counts): real-bundle ground truth for
  // the strict-vs-best-effort subtractive policy test below.
  for (const line of ['cornmeal', 'yellow cornmeal']) {
    reviews.set(line, session.reviewIngredient({ name: line }) as unknown as Record<string, unknown>);
  }
}, 180000);

function candidatesOf(line: string): ReadonlyArray<{ fdc_id: number; description: string }> {
  const review = reviews.get(line);
  const candidates = review?.['candidates'];
  if (!Array.isArray(candidates)) return [];
  return candidates as ReadonlyArray<{ fdc_id: number; description: string }>;
}

function sourceFor(line: string) {
  const built = buildAiAdvancedPlanLineSource({
    lineRef: line,
    review: reviews.get(line),
  });
  if (built.ok !== true) throw new Error(`source failed for ${line}: ${built.code}`);
  return built.source;
}

function contextFor(lines: ReadonlyArray<string>): AiAdvancedPlanRequestContext {
  const built = buildAiAdvancedPlanRequestContext({
    requestId: REQUEST_ID,
    lines: lines.map(sourceFor),
  });
  if (built.ok !== true) throw new Error(`context failed: ${built.code}`);
  return built.context;
}

function planFor(lineRef: string, overrides: Record<string, unknown> = {}) {
  return {
    line_ref: lineRef,
    candidate_ref: 'c1',
    measure_kind: 'source_portion',
    review_required: false,
    ambiguity_reasons: [] as string[],
    confidence: 'high',
    ...overrides,
  };
}

function envelope(plans: ReadonlyArray<Record<string, unknown>>) {
  return { plan_version: AI_ADVANCED_PLAN_VERSION, plans };
}

/**
 * The Phase 4 boundary port: the deterministic acceptance decision AI-2A may
 * consult (AI-2A itself never imports Phase 2 — see the isolation rule).
 */
function deterministicAcceptance(review: unknown) {
  const strict = selectAutomaticMatch(review as never);
  const bestEffortDefault = selectBestEffortMatch(review as never);
  // The FULL eligible family (every safe same-family sibling), not just the
  // default: `isDeterministicBestEffortSelection` is the existing predicate.
  const candidates =
    (review as { candidates?: ReadonlyArray<{ fdc_id: number }> } | undefined)?.candidates ?? [];
  const eligible = candidates
    .filter((candidate) => isDeterministicBestEffortSelection(review as never, candidate.fdc_id))
    .map((candidate) => candidate.fdc_id);
  return Object.freeze({
    ...(strict !== undefined ? { strict_automatic_fdc_id: strict.fdc_id } : {}),
    ...(bestEffortDefault !== undefined
      ? { best_effort_default_fdc_id: bestEffortDefault.fdc_id }
      : {}),
    best_effort_eligible_fdc_ids: eligible,
  });
}

function applyPlan(
  input: Omit<Parameters<typeof validateAndApplyAiAdvancedPlan>[0], 'deterministicAcceptance'>
) {
  return validateAndApplyAiAdvancedPlan({ ...input, deterministicAcceptance });
}

function applyOn(
  context: AiAdvancedPlanRequestContext,
  plans: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
) {
  return applyPlan({
    rawPlanResponse: envelope(plans),
    responseRequestId: REQUEST_ID,
    context,
    reviews,
    ...extra,
  });
}

/**
 * AI-2A caps a request at 12 lines, so the corpus is applied in chunks. Every
 * chunk is an independent request; outcomes are concatenated in corpus order.
 */
function applyOverCorpus(
  plansFor: (line: string) => Record<string, unknown>,
  extra: Record<string, unknown> = {}
): ReadonlyArray<AiAdvancedPlanLineOutcome> {
  const outcomes: AiAdvancedPlanLineOutcome[] = [];
  for (let index = 0; index < CORPUS.length; index += 12) {
    const chunk = CORPUS.slice(index, index + 12);
    const context = contextFor(chunk);
    const result = applyOn(context, chunk.map(plansFor), extra);
    if (result.ok !== true) throw new Error(`chunk apply failed: ${result.code}`);
    outcomes.push(...result.application.lines);
  }
  return Object.freeze(outcomes);
}

describe('AI-2A corpus — AI agreement never creates automatic authority', () => {
  it('matches the deterministic ground truth on every corpus line', () => {
    const outcomes = applyOverCorpus((line) => planFor(line));
    expect(outcomes).toHaveLength(CORPUS.length);

    let automatic = 0;
    let offer = 0;
    for (const outcome of outcomes) {
      const review = reviews.get(outcome.line_ref) as never;
      const strict = selectAutomaticMatch(review);
      const top = candidatesOf(outcome.line_ref)[0];
      const deterministicWouldAccept = strict !== undefined && strict.fdc_id === top?.fdc_id;
      if (deterministicWouldAccept) {
        expect(outcome.status, `${outcome.line_ref} should follow determinism`).toBe('automatic');
        expect(outcome.reason).toBe('deterministic_automatic');
        automatic += 1;
      } else {
        // AI agreement adds NOTHING: no promotion beyond the deterministic rules.
        expect(outcome.status, `${outcome.line_ref} must not be promoted by AI`).not.toBe('automatic');
        expect(outcome.status).toBe('offer');
        expect(outcome.matches_strict_automatic).toBe(false);
        expect(['below_deterministic_threshold', 'deterministic_best_effort_only']).toContain(
          outcome.reason
        );
        offer += 1;
      }
    }
    // The corpus must exercise BOTH paths on the real bundle.
    expect(automatic).toBeGreaterThan(0);
    expect(offer).toBeGreaterThan(0);
    expect(automatic + offer).toBe(CORPUS.length);
  });

  it('ambiguity, medium confidence and review_required only subtract authority', () => {
    const ambiguous = applyOverCorpus((line) =>
      planFor(line, { ambiguity_reasons: ['more than one candidate fits'] })
    );
    for (const outcome of ambiguous) {
      expect(outcome.status, `${outcome.line_ref} must not auto-accept on ambiguity`).toBe('offer');
      expect(outcome.reason).toBe('ambiguity_declared');
    }

    const medium = applyOverCorpus((line) => planFor(line, { confidence: 'medium' }));
    for (const outcome of medium) expect(outcome.status).toBe('offer');

    const declared = applyOverCorpus((line) => planFor(line, { review_required: true }));
    for (const outcome of declared) expect(outcome.status).toBe('offer');
  });

  it('ANTI-LAUNDERING: no review_suggested row is ever laundered into automatic', () => {
    const issueKinds = Object.fromEntries(CORPUS.map((line) => [line, 'review_suggested']));
    const outcomes = applyOverCorpus((line) => planFor(line), { issueKinds });
    for (const outcome of outcomes) {
      expect(outcome.status, `${outcome.line_ref} leaked automatic authority`).toBe('offer');
      expect(outcome.reason).toBe('review_suggested_issue_kind');
    }
    // The guard is demonstrably doing work: at least one corpus line WOULD have
    // been auto-accepted deterministically, and the review_suggested row vetoed it.
    expect(outcomes.some((outcome) => outcome.matches_strict_automatic)).toBe(true);
  });

  it('AI-SPECIFIC SUBTRACTIVE POLICY: a best-effort-only AI selection is an offer, a strict one is automatic', () => {
    // Real-bundle ground truth (probed, load-bearing — do NOT hand-edit):
    //   `cornmeal`        → strict: none,            best-effort: 167628
    //   `yellow cornmeal` → strict: 168039,          best-effort: 168039
    // Both targets are `c1` inside their own single-line request contexts, and
    // neither line carries an independently vetoing issue kind.
    for (const line of ['cornmeal', 'yellow cornmeal']) {
      const review = reviews.get(line) as never;
      const strict = selectAutomaticMatch(review);
      const bestEffort = selectBestEffortMatch(review);
      if (line === 'cornmeal') {
        expect(strict).toBeUndefined();
        expect(bestEffort?.fdc_id).toBe(167628);
      } else {
        expect(strict?.fdc_id).toBe(168039);
        expect(bestEffort?.fdc_id).toBe(168039);
      }
    }

    const cleanHighPlan = (line: string) =>
      planFor(line, { candidate_ref: 'c1', confidence: 'high', review_required: false, ambiguity_reasons: [] });

    // Best-effort-only AI selection: high confidence, no veto — still an offer.
    const bestEffortOnly = applyOn(contextFor(['cornmeal']), [cleanHighPlan('cornmeal')]);
    expect(bestEffortOnly.ok).toBe(true);
    if (bestEffortOnly.ok !== true) return;
    expect(bestEffortOnly.application.lines[0]).toMatchObject({
      line_ref: 'cornmeal',
      status: 'offer',
      reason: 'deterministic_best_effort_only',
      candidate_ref: 'c1',
      local_fdc_id: 167628,
      matches_strict_automatic: false,
      matches_best_effort_eligible: true,
    });

    // Neighboring strict AI selection under identical clean metadata: automatic.
    const strict = applyOn(contextFor(['yellow cornmeal']), [cleanHighPlan('yellow cornmeal')]);
    expect(strict.ok).toBe(true);
    if (strict.ok !== true) return;
    expect(strict.application.lines[0]).toMatchObject({
      line_ref: 'yellow cornmeal',
      status: 'automatic',
      reason: 'deterministic_automatic',
      candidate_ref: 'c1',
      local_fdc_id: 168039,
      matches_strict_automatic: true,
    });
  });

  it('BEST-EFFORT MEMBERSHIP: a NON-DEFAULT eligible sibling is an offer, not below threshold', () => {
    // Independently verified real-bundle ground truth (probed from the pinned
    // bundle through the production predicates; do NOT hand-edit):
    //   `cream` — strict `selectAutomaticMatch` selects nothing,
    //             the best-effort DEFAULT (`selectBestEffortMatch`) is 2705592,
    //             and c2 = 2346386 is a NON-DEFAULT member of the eligible family
    //             (`isDeterministicBestEffortSelection(cream, 2346386) === true`).
    const line = 'cream';
    const review = reviews.get(line) as never;
    const chosen = candidatesOf(line)[1]!;
    expect(chosen.fdc_id).toBe(2346386);
    expect(selectBestEffortMatch(review)?.fdc_id).toBe(2705592);
    expect(chosen.fdc_id).not.toBe(selectBestEffortMatch(review)?.fdc_id);
    expect(isDeterministicBestEffortSelection(review, chosen.fdc_id)).toBe(true);
    expect(selectAutomaticMatch(review)).toBeUndefined();

    const result = applyOn(contextFor([line]), [
      planFor(line, { candidate_ref: 'c2', confidence: 'high', review_required: false, ambiguity_reasons: [] }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    // Membership in the eligible FAMILY drives the label — never default equality.
    expect(result.application.lines[0]).toMatchObject({
      line_ref: line,
      status: 'offer',
      reason: 'deterministic_best_effort_only',
      candidate_ref: 'c2',
      local_fdc_id: 2346386,
      matches_strict_automatic: false,
      matches_best_effort_eligible: true,
    });
  });

  it('reports below_deterministic_threshold only for a candidate in NO acceptance set', () => {
    // `tomato sauce`: strict selects nothing AND the eligible best-effort family
    // is empty (selectBestEffortMatch is undefined ⇒ no eligible member exists),
    // so every candidate is genuinely below both deterministic sets.
    const line = 'tomato sauce';
    const review = reviews.get(line) as never;
    expect(selectAutomaticMatch(review)).toBeUndefined();
    expect(selectBestEffortMatch(review)).toBeUndefined();
    const candidates = candidatesOf(line);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => !isDeterministicBestEffortSelection(review, c.fdc_id))).toBe(true);

    const result = applyOn(contextFor([line]), [planFor(line)]);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.lines[0]).toMatchObject({
      line_ref: line,
      status: 'offer',
      reason: 'below_deterministic_threshold',
      candidate_ref: 'c1',
      local_fdc_id: candidates[0]!.fdc_id,
      matches_strict_automatic: false,
      matches_best_effort_eligible: false,
    });
  });

  it('an alternative wording can never be auto-selected across families', () => {
    const line = 'butter or olive oil';
    const context = contextFor([line]);
    // A plan that picks the FAMILY sibling of the deterministic top candidate is
    // at most an offer — never an automatic selection.
    const result = applyOn(context, [planFor(line, { candidate_ref: 'c2' })]);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.application.lines[0]!.status).not.toBe('automatic');
    expect(result.application.lines[0]!.status).toBe('offer');
  });
});

describe('AI-2A corpus — adversarial matrix fails closed on real reviews', () => {
  it('rejects unknown and cross-line refs, and discards the whole response', () => {
    const first = CORPUS[0]!;
    const second = CORPUS[3]!;
    const context = contextFor([first, second]);
    // `c99` was never issued for any line.
    expect(applyOn(context, [planFor(first, { candidate_ref: 'c99' })])).toEqual({
      ok: false,
      code: 'unknown_candidate_ref',
    });
    // A ref issued for line 1 but never for the (deliberately narrowed) line 2.
    const narrowed = {
      ...(reviews.get(second) as Record<string, unknown>),
      candidates: candidatesOf(second).slice(0, 3),
    };
    const narrowedSource = buildAiAdvancedPlanLineSource({ lineRef: second, review: narrowed });
    expect(narrowedSource.ok).toBe(true);
    if (narrowedSource.ok !== true) return;
    const narrowedContext = buildAiAdvancedPlanRequestContext({
      requestId: REQUEST_ID,
      lines: [sourceFor(first), narrowedSource.source],
    });
    expect(narrowedContext.ok).toBe(true);
    if (narrowedContext.ok !== true) return;
    const crossLine = applyPlan({
      rawPlanResponse: envelope([planFor(second, { candidate_ref: 'c5' })]),
      responseRequestId: REQUEST_ID,
      context: narrowedContext.context,
      reviews: new Map([
        [first, reviews.get(first)],
        [second, narrowed],
      ]),
    });
    expect(crossLine).toEqual({ ok: false, code: 'unknown_candidate_ref' });
  });

  it('rejects order, version, portion, authority and persistence-shaped payloads', () => {
    const line = CORPUS[0]!;
    const context = contextFor([line]);
    const run = (plans: ReadonlyArray<Record<string, unknown>>) => applyOn(context, plans);

    expect(
      applyPlan({
        rawPlanResponse: envelope([planFor(line)]),
        responseRequestId: 'req-other',
        context,
        reviews,
      })
    ).toEqual({ ok: false, code: 'stale_request' });
    expect(run([planFor(line), planFor(line)])).toEqual({ ok: false, code: 'duplicate_line_ref' });
    expect(
      applyPlan({
        rawPlanResponse: { plan_version: 'nutrition_ai_advanced_plan_v2', plans: [planFor(line)] },
        responseRequestId: REQUEST_ID,
        context,
        reviews,
      })
    ).toEqual({ ok: false, code: 'unsupported_plan_version' });
    expect(run([planFor(line, { portion_ref: 'p1' })])).toEqual({
      ok: false,
      code: 'unknown_portion_ref',
    });
    expect(run([planFor(line, { portion_index: 2 })])).toEqual({
      ok: false,
      code: 'authority_field',
    });
    expect(run([planFor(line, { fdc_id: candidatesOf(line)[0]!.fdc_id })])).toEqual({
      ok: false,
      code: 'authority_field',
    });
    expect(run([planFor(line, { grams: 120 })])).toEqual({ ok: false, code: 'authority_field' });
    expect(run([planFor(line, { nutrients: { kcal: 10 } })])).toEqual({
      ok: false,
      code: 'authority_field',
    });
    expect(run([planFor(line, { apply: true })])).toEqual({ ok: false, code: 'authority_field' });
    // `persist` is an authority-shaped key; `persistence` is merely unknown.
    expect(run([planFor(line, { persist: true })])).toEqual({ ok: false, code: 'authority_field' });
    expect(run([planFor(line, { persistence: 'save' })])).toEqual({
      ok: false,
      code: 'invalid_response',
    });
    expect(run([planFor(line, { ambiguity_reasons: [{ mass: 12 }] })])).toMatchObject({ ok: false });
    class PlanLike {
      plan_version = AI_ADVANCED_PLAN_VERSION;
      plans = [planFor(line)];
    }
    expect(
      applyPlan({
        rawPlanResponse: new PlanLike(),
        responseRequestId: REQUEST_ID,
        context,
        reviews,
      })
    ).toMatchObject({ ok: false });
  });

  it('reports review (never automatic) when the review digest is stale', () => {
    const line = CORPUS[0]!;
    const context = contextFor([line]);
    const stale = {
      ...(reviews.get(line) as Record<string, unknown>),
      review_digest: 'some-other-review-digest',
    };
    const result = applyPlan({
      rawPlanResponse: envelope([planFor(line)]),
      responseRequestId: REQUEST_ID,
      context,
      reviews: new Map([[line, stale]]),
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    const outcome: AiAdvancedPlanLineOutcome = result.application.lines[0]!;
    expect(outcome.status).toBe('review');
    expect(outcome.reason).toBe('stale_review');
  });
});

describe('AI-2A corpus — request bounds and identity containment on real data', () => {
  it('keeps the provider payload opaque, bounded and free of local identity', () => {
    const twelve = CORPUS.slice(0, 12);
    const context = contextFor(twelve);
    expect(context.provider_request_bytes).toBeLessThan(MAX_AI_ADVANCED_PLAN_REQUEST_BYTES);
    const payload = JSON.stringify(context.provider_request);
    for (const forbidden of ['fdc_id', 'record_digest', 'review_digest', 'catalog_digest', 'bundle_release', 'match_class', 'usda_fdc_']) {
      expect(payload.includes(forbidden), `payload leaks ${forbidden}`).toBe(false);
    }
    // Real FDC identity never appears anywhere in the provider payload.
    for (const line of twelve) {
      for (const candidate of candidatesOf(line)) {
        expect(payload.includes(String(candidate.fdc_id)), `payload leaks ${candidate.fdc_id}`).toBe(false);
      }
    }
    // Every provider candidate view is structurally opaque.
    for (const providerLine of context.provider_request.lines) {
      for (const view of providerLine.candidates) {
        expect(Object.keys(view).sort()).toEqual(['candidate_ref', 'display_description', 'semantic_tags']);
        expect(view.candidate_ref.startsWith('c')).toBe(true);
      }
    }
    // Fail closed above the bound: 13 lines are refused outright.
    const thirteen = buildAiAdvancedPlanRequestContext({
      requestId: REQUEST_ID,
      lines: [...twelve, CORPUS[12]!].map(sourceFor),
    });
    expect(thirteen).toEqual({ ok: false, code: 'too_many_lines' });
  });
});