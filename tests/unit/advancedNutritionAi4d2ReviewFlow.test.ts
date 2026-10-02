/**
 * AI-4D2 — FOCUSED APPLICATION-LAYER REVIEW-FLOW TESTS.
 *
 * Covers the explicit two-step flow (interpret -> reconcile), the bounded failure
 * mapping, and the generation sequencing that keeps overlapping runs from
 * replacing newer review state. The transport is a fake adapter: this file proves
 * what the application layer REQUESTS and how it maps outcomes, not HTTP
 * behaviour (see `tests/security/advancedNutritionAi4d2Route.test.ts`).
 */
import { describe, it, expect } from 'vitest';

import {
  NUTRITION_RECIPE_CONTEXT_ENDPOINT,
  NUTRITION_RECIPE_CONTEXT_RECONCILE_ENDPOINT,
  RECIPE_CONTEXT_BUSY_MESSAGE,
  RECIPE_CONTEXT_INVALID_MESSAGE,
  RECIPE_CONTEXT_STALE_MESSAGE,
  RECIPE_CONTEXT_UNAVAILABLE_MESSAGE,
  buildRecipeContextReconcileRequest,
  createRecipeContextInstanceToken,
  createRecipeContextRequestId,
  createRecipeContextReviewRunner,
  requestRecipeContextReview,
} from '../../src/application/nutritionAiRecipeContext';
import type { NetworkAdapter, NetworkResponse } from '../../src/application/adapters/NetworkAdapter';
import { AI_RECIPE_CONTEXT_REQUEST_VERSION } from '../../src/core/nutritionV2/aiRecipeContextRequest';
import { recipeContextReviewView } from '../../src/core/nutritionV2/aiRecipeContextSession';
import { deriveRecipeContextModelInput } from '../../server/recipeContextDerivation';
import { reconcileRecipeContext } from '../../src/core/nutritionV2/aiRecipeContextReconcile';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';

const REQUEST_ID = 'ai4d2-req-flow-1';
const INSTANCE = 'ai4d2-instance-1';

const LINES = ['400 g chicken', '2 tbsp parsley, for garnish'];
const INSTRUCTIONS = ['Garnish with parsley'];

/**
 * Under this project's non-strict null-checking a boolean `ok` discriminant
 * narrows reliably only in the truthy direction, so failure branches read the
 * bounded code through an explicit accessor.
 */
function codeOf(result: unknown): string {
  return String((result as { code?: string }).code);
}

function messageOf(result: unknown): string {
  return String((result as { message?: string }).message);
}

function authoredRecipe(): Record<string, unknown> {
  return {
    title: 'Review flow probe',
    servings: 2,
    ingredients: LINES.map((original) => ({ original })),
  };
}

function currentDerivation() {
  const derived = deriveRecipeContextModelInput({
    recipe: authoredRecipe(),
    instructions: INSTRUCTIONS.map((text) => ({ text })),
    requestVersion: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    requestId: REQUEST_ID,
    recipeInstance: INSTANCE,
  });
  if (!derived.ok) throw new Error('derivation failed');
  return {
    context_binding: derived.request.model_input_binding,
    targets: derived.request.provider_request.targets,
  };
}

/** A real CURRENT plan produced by the real reconciler over the real derivation. */
function currentReconciliation() {
  const current = currentDerivation();
  const result = reconcileRecipeContext({
    wire: {
      request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
      request_id: REQUEST_ID,
      context_binding: current.context_binding,
      proposal: {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        interpretations: current.targets.map((target) => ({
          line_ref: target.line_ref,
          role: 'garnish',
          relations: [],
          preparation_hints: ['garnish'],
        })),
      },
    },
    expectedRequestId: REQUEST_ID,
    current: {
      context_binding: current.context_binding,
      targets: current.targets.map((target) => ({
        line_ref: target.line_ref,
        source_text: target.source_text,
      })),
    },
  });
  if (!result.ok) throw new Error('reconciliation failed');
  return result.reconciliation;
}

function interpretResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    request_id: REQUEST_ID,
    proposal: {
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      interpretations: currentDerivation().targets.map((target) => ({
        line_ref: target.line_ref,
        role: 'garnish',
        relations: [],
        preparation_hints: ['garnish'],
      })),
    },
    context_binding: currentDerivation().context_binding,
    // AI-4E: the server now issues an origin receipt on success, and the client
    // requires a well-shaped one before it will build a reconcile request.
    origin_receipt: `rctx1.${'A'.repeat(43)}`,
    aiAttempted: true,
    ...overrides,
  };
}

interface Recorded {
  readonly path: string;
  readonly body: unknown;
}

function fakeNetwork(responses: ReadonlyArray<NetworkResponse<Record<string, unknown>>>) {
  const calls: Recorded[] = [];
  let index = 0;
  const adapter = {
    async request<TResponse = unknown, TBody = unknown>(request: {
      method: string;
      path: string;
      body?: TBody;
    }): Promise<NetworkResponse<TResponse>> {
      const response = responses[index] ?? { status: 500, ok: false };
      index += 1;
      calls.push({ path: request.path, body: request.body });
      return response as NetworkResponse<TResponse>;
    },
    async get<TResponse = unknown>(): Promise<NetworkResponse<TResponse>> {
      return { status: 500, ok: false } as NetworkResponse<TResponse>;
    },
    async post<TResponse = unknown, TBody = unknown>(
      path: string,
      body: TBody
    ): Promise<NetworkResponse<TResponse>> {
      const response = responses[index] ?? { status: 500, ok: false };
      index += 1;
      calls.push({ path, body });
      return response as NetworkResponse<TResponse>;
    },
  } as unknown as NetworkAdapter;
  return { adapter, calls };
}

const source = () => ({
  recipe: authoredRecipe(),
  instructions: INSTRUCTIONS.map((text) => ({ text })),
  recipeInstance: INSTANCE,
});

const run = (network: NetworkAdapter, requestId?: string) =>
  requestRecipeContextReview({
    network,
    source: source(),
    requestId: requestId === undefined ? REQUEST_ID : requestId,
  });

describe('AI-4D2 review flow — the explicit two-step chain', () => {
  it('interprets once, then reconciles once, and returns a review with no decisions', async () => {
    const { adapter, calls } = fakeNetwork([
      { status: 200, ok: true, data: interpretResponse() },
      { status: 200, ok: true, data: { ok: true, reconciliation: currentReconciliation() } },
    ]);
    const result = await run(adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.map((call) => call.path)).toEqual([
      NUTRITION_RECIPE_CONTEXT_ENDPOINT,
      NUTRITION_RECIPE_CONTEXT_RECONCILE_ENDPOINT,
    ]);
    // ONE provider-backed call and ONE deterministic call. No retry, no third call.
    expect(calls).toHaveLength(2);
    // NOTHING is accepted: the overlay starts empty.
    expect(result.session.decisions).toEqual({});
    expect(acceptedEntries(result.session)).toEqual([]);
  });

  it('the interpret request carries only authored source data plus transport identity', async () => {
    const { adapter, calls } = fakeNetwork([
      { status: 200, ok: true, data: interpretResponse() },
      { status: 200, ok: true, data: { ok: true, reconciliation: currentReconciliation() } },
    ]);
    await run(adapter);
    const interpretBody = calls[0].body as Record<string, unknown>;
    expect(Object.keys(interpretBody).sort()).toEqual([
      'instructions',
      'recipe',
      'recipe_instance',
      'request_id',
      'request_version',
    ]);
    expect(interpretBody['request_version']).toBe(AI_RECIPE_CONTEXT_REQUEST_VERSION);
    expect(interpretBody['request_id']).toBe(REQUEST_ID);
    // The model-facing context is server-derived: no envelope, binding or targets.
    expect(interpretBody).not.toHaveProperty('context');
    expect(interpretBody).not.toHaveProperty('envelope');
    expect(interpretBody).not.toHaveProperty('targets');
  });

  it('the reconcile request forwards the server-validated identity and the proposal verbatim', async () => {
    const { adapter, calls } = fakeNetwork([
      { status: 200, ok: true, data: interpretResponse() },
      { status: 200, ok: true, data: { ok: true, reconciliation: currentReconciliation() } },
    ]);
    await run(adapter);
    const reconcileBody = calls[1].body as Record<string, unknown>;
    expect(Object.keys(reconcileBody).sort()).toEqual([
      'expected_request_id',
      'instructions',
      'origin_receipt',
      'recipe',
      'recipe_instance',
      'wire',
    ]);
    expect(reconcileBody['expected_request_id']).toBe(REQUEST_ID);
    const wire = reconcileBody['wire'] as Record<string, unknown>;
    expect(wire['request_id']).toBe(REQUEST_ID);
    expect(wire['context_binding']).toBe(currentDerivation().context_binding);
    expect(wire['proposal']).toEqual((interpretResponse()['proposal']));
    // AI-4E: the receipt is transported UNCHANGED, as a sibling of the wire — never
    // inside the wire, never inside the proposal, never rewritten.
    expect(reconcileBody['origin_receipt']).toBe(interpretResponse()['origin_receipt']);
    expect(Object.keys(wire).sort()).toEqual([
      'context_binding',
      'proposal',
      'request_id',
      'request_version',
    ]);
    expect(JSON.stringify(wire['proposal'])).not.toContain('origin_receipt');
  });

  it('the client transports the receipt verbatim and never invents a verification flag', async () => {
    const { adapter, calls } = fakeNetwork([
      { status: 200, ok: true, data: interpretResponse() },
      { status: 200, ok: true, data: { ok: true, reconciliation: currentReconciliation() } },
    ]);
    await run(adapter);
    const body = calls[1].body as Record<string, unknown>;
    // No caller-controlled trust flag is ever sent: the server is the authority.
    for (const forbidden of ['origin_verified', 'originVerified', 'verified', 'authenticated']) {
      expect(body).not.toHaveProperty(forbidden);
      expect(JSON.stringify(body)).not.toContain(forbidden);
    }
  });

  it('a missing or malformed receipt means no reconcile request is attempted at all', async () => {
    for (const origin_receipt of [undefined, '', 'nope', 'rctx1.short', 42, {}, null]) {
      const { adapter, calls } = fakeNetwork([
        { status: 200, ok: true, data: interpretResponse({ origin_receipt }) },
        { status: 200, ok: true, data: { ok: true, reconciliation: currentReconciliation() } },
      ]);
      const result = await run(adapter);
      expect(result.ok).toBe(false);
      expect(codeOf(result)).toBe('unusable');
      // Exactly ONE call: interpretation only. The client never posts an
      // unauthenticated wire it cannot prove.
      expect(calls).toHaveLength(1);
    }
  });

  it('the recipe instance is opaque and memory-only, never a path or URL', async () => {
    const token = createRecipeContextInstanceToken(() => 0.5);
    expect(token).toMatch(/^ai4d2-[0-9a-f]{8}$/);
    expect(token).not.toContain('/');
    expect(token).not.toContain('\\');
    expect(token).not.toContain('.md');
    expect(token.toLowerCase()).not.toContain('http');
  });

  it('a request id is bounded and carries no recipe content', () => {
    const id = createRecipeContextRequestId(() => 0.25, 1_700_000_000_000);
    expect(id.startsWith('ai4d2-req-')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(120);
    expect(id).not.toContain('chicken');
  });

  it('an unusable request id is refused before any request is made', async () => {
    const { adapter, calls } = fakeNetwork([]);
    for (const bogus of ['', '   ', 'x'.repeat(200)]) {
      const result = await run(adapter, bogus);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codeOf(result)).toBe('invalid_request');
    }
    // A missing identity is refused the same way (no default is invented).
    const missing = await requestRecipeContextReview({
      network: adapter,
      source: source(),
      requestId: undefined as unknown as string,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(codeOf(missing)).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});

function acceptedEntries(session: unknown): ReadonlyArray<unknown> {
  // The projection is read through the public core API in the authority file; here
  // the overlay itself is the proof that nothing was accepted.
  return Object.values(
    (session as { decisions: Record<string, string> }).decisions
  ).filter((decision) => decision === 'accepted');
}

describe('AI-4D2 review flow — bounded failures', () => {
  it('an unavailable or failed interpretation is a bounded message with no review', async () => {
    for (const status of [400, 401, 503]) {
      const { adapter, calls } = fakeNetwork([{ status, ok: false }]);
      const result = await run(adapter);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codeOf(result)).toBe('unavailable');
      expect(messageOf(result)).toBe(RECIPE_CONTEXT_UNAVAILABLE_MESSAGE);
      // No reconciliation is attempted without an interpretation.
      expect(calls).toHaveLength(1);
    }
  });

  it('a transport throw is a bounded message, never a raw error', async () => {
    const adapter = {
      post: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:443 /secret/path');
      },
    } as unknown as NetworkAdapter;
    const result = await run(adapter);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(messageOf(result)).toBe(RECIPE_CONTEXT_UNAVAILABLE_MESSAGE);
    expect(messageOf(result)).not.toContain('10.0.0.5');
    expect(messageOf(result)).not.toContain('secret');
  });

  it('a rate-limited interpretation is reported as rate limited', async () => {
    const { adapter } = fakeNetwork([{ status: 429, ok: false }]);
    const result = await run(adapter);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('rate_limited');
    expect(messageOf(result)).toContain('Too many recipe-context reviews.');
  });

  it('a stale or mismatched reconciliation is reported with the re-run message', async () => {
    for (const status of [409]) {
      const { adapter } = fakeNetwork([
        { status: 200, ok: true, data: interpretResponse() },
        { status, ok: false },
      ]);
      const result = await run(adapter);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codeOf(result)).toBe('stale');
      expect(messageOf(result)).toBe(RECIPE_CONTEXT_STALE_MESSAGE);
    }
  });

  it('a malformed interpretation response never becomes a review', async () => {
    // Each case pairs the response with the number of requests it may cause: the
    // interpretation request always happens once, and a response without a usable
    // proposal never reaches the reconciliation step.
    const cases: ReadonlyArray<{ readonly data: unknown; readonly maxCalls: number }> = [
      { data: null, maxCalls: 1 },
      { data: 'ok', maxCalls: 1 },
      { data: {}, maxCalls: 1 },
      { data: { ok: true }, maxCalls: 1 },
      { data: { ok: true, request_id: REQUEST_ID }, maxCalls: 1 },
      { data: { ok: true, request_id: REQUEST_ID, context_binding: 'sha256:x' }, maxCalls: 1 },
      { data: interpretResponse({ request_id: 'someone-elses-request' }), maxCalls: 1 },
      { data: interpretResponse({ extra_key: true }), maxCalls: 1 },
      { data: interpretResponse({ proposal: 'not an object' }), maxCalls: 1 },
      { data: interpretResponse({ context_binding: 42 }), maxCalls: 1 },
      // A structurally complete but semantically unusable plan may be reconciled,
      // and reconciliation still yields no review.
      { data: interpretResponse({ proposal: {} }), maxCalls: 2 },
    ];
    for (const { data, maxCalls } of cases) {
      const { adapter, calls } = fakeNetwork([{ status: 200, ok: true, data: data as never }]);
      const result = await run(adapter);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(['unusable', 'stale', 'unavailable']).toContain(codeOf(result));
      expect(messageOf(result)).toBe(RECIPE_CONTEXT_INVALID_MESSAGE);
      expect(calls.length).toBeLessThanOrEqual(maxCalls);
    }
  });

  it('a malformed reconciliation response never becomes a review', async () => {
    for (const data of [
      null,
      {},
      { ok: true },
      { ok: true, reconciliation: { reconciliation_version: 'something_else' } },
      { ok: true, reconciliation: currentReconciliation(), extra: 1 },
    ]) {
      const { adapter } = fakeNetwork([
        { status: 200, ok: true, data: interpretResponse() },
        { status: 200, ok: true, data: data as never },
      ]);
      const result = await run(adapter);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(codeOf(result)).toBe('unusable');
    }
  });

  it('a non-current reconciliation is refused rather than reviewed', async () => {
    const { adapter } = fakeNetwork([
      { status: 200, ok: true, data: interpretResponse() },
      {
        status: 200,
        ok: true,
        data: {
          ok: true,
          // A plan whose binding does not match the interpretation's own context.
          reconciliation: {
            ...currentReconciliation(),
            context_binding: 'sha256:'.concat('0'.repeat(64)),
          },
        },
      },
    ]);
    const result = await run(adapter);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codeOf(result)).toBe('stale');
  });

  it('no failure path performs a retry or a second interpretation', async () => {
    const { adapter, calls } = fakeNetwork([
      { status: 503, ok: false },
      { status: 200, ok: true, data: interpretResponse() },
    ]);
    await run(adapter);
    expect(calls).toHaveLength(1);
  });
});

describe('AI-4D2 review flow — the reconcile request builder', () => {
  it('refuses a response that is not the closed AI-4C success shape', () => {
    const built = buildRecipeContextReconcileRequest({
      response: interpretResponse(),
      expectedRequestId: REQUEST_ID,
      source: source(),
    });
    expect(built.ok).toBe(true);
    for (const response of [
      null,
      'text',
      42,
      [],
      interpretResponse({ ok: false }),
      interpretResponse({ aiAttempted: false, unknown: 1 }),
      interpretResponse({ request_id: '' }),
      interpretResponse({ context_binding: 42 }),
      interpretResponse({ proposal: 'not an object' }),
      interpretResponse({ origin_receipt: undefined }),
      interpretResponse({ origin_receipt: 'rctx1.tooshort' }),
      interpretResponse({ origin_receipt: 42 }),
    ]) {
      const refused = buildRecipeContextReconcileRequest({
        response,
        expectedRequestId: REQUEST_ID,
        source: source(),
      });
      expect(refused.ok).toBe(false);
    }
  });
});

describe('AI-4D2 review flow — generation sequencing', () => {
  it('a newer run retires an older completion', () => {
    const runner = createRecipeContextReviewRunner();
    const first = runner.begin();
    expect(runner.isCurrent(first)).toBe(true);
    const second = runner.begin();
    // The first run finished late and must NOT be allowed to write state.
    expect(runner.isCurrent(first)).toBe(false);
    expect(runner.isCurrent(second)).toBe(true);
    expect(runner.generation).toBe(second);
  });

  it('invalidation retires every in-flight run', () => {
    const runner = createRecipeContextReviewRunner();
    const token = runner.begin();
    expect(runner.isCurrent(token)).toBe(true);
    runner.invalidate();
    expect(runner.isCurrent(token)).toBe(false);
    const next = runner.begin();
    expect(runner.isCurrent(next)).toBe(true);
  });

  it('a stale generation never produces review state', async () => {
    const { adapter } = fakeNetwork([
      { status: 200, ok: true, data: interpretResponse() },
      { status: 200, ok: true, data: { ok: true, reconciliation: currentReconciliation() } },
    ]);
    const runner = createRecipeContextReviewRunner();
    const token = runner.begin();
    const result = await run(adapter);
    // The UI's rule: a completed run is only allowed to write state while current.
    if (result.ok) expect(runner.isCurrent(token)).toBe(true);
    runner.invalidate();
    if (result.ok) {
      // After invalidation the same result must no longer be applicable.
      expect(runner.isCurrent(token)).toBe(false);
      const view = recipeContextReviewView(result.session, {
        requestId: REQUEST_ID,
        contextBinding: currentDerivation().context_binding,
      });
      expect(view.ok).toBe(true);
    }
  });

  it('each runner is independent', () => {
    const a = createRecipeContextReviewRunner();
    const b = createRecipeContextReviewRunner();
    const tokenA = a.begin();
    b.invalidate();
    expect(a.isCurrent(tokenA)).toBe(true);
  });
});

describe('AI-4D2 review flow — bounded copy', () => {
  it('the busy message is distinct from the unavailable message', () => {
    expect(RECIPE_CONTEXT_BUSY_MESSAGE).not.toBe(RECIPE_CONTEXT_UNAVAILABLE_MESSAGE);
    expect(RECIPE_CONTEXT_BUSY_MESSAGE).toContain('already running');
  });

  it('every bounded message is a single calm sentence with no provider detail', () => {
    for (const message of [
      RECIPE_CONTEXT_UNAVAILABLE_MESSAGE,
      RECIPE_CONTEXT_INVALID_MESSAGE,
      RECIPE_CONTEXT_STALE_MESSAGE,
      RECIPE_CONTEXT_BUSY_MESSAGE,
    ]) {
      expect(message.length).toBeLessThanOrEqual(120);
      expect(message).toMatch(/^[A-Z]/);
      expect(message.toLowerCase()).not.toContain('error');
      expect(message.toLowerCase()).not.toContain('stack');
      expect(message).not.toContain('undefined');
    }
  });
});