import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initialShisoConversation, runShisoConversationTurn } from '../../src/application/shisoConversation';
import type { NetworkAdapter, NetworkRequestOptions } from '../../src/application/adapters/NetworkAdapter';
import type { ShisoToolContext } from '../../src/application/shisoTools';
import type { ShisoTurnResponse } from '../../src/core/shiso/protocol';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';

const reply: ShisoTurnResponse = {
  ok: true, kind: 'reply', text: 'A current reply.', proposals: [],
  model_invocations_used: 1, tool_calls_used: 0,
};
const nutritionRequest: ShisoTurnResponse = {
  ok: true, kind: 'tool_request', tool: 'run_nutrition_analysis', args: { tool: 'run_nutrition_analysis' },
  model_invocations_used: 1, tool_calls_used: 0,
};
const saveRequest: ShisoTurnResponse = {
  ok: true, kind: 'tool_request', tool: 'save_working_recipe', args: { tool: 'save_working_recipe' },
  model_invocations_used: 1, tool_calls_used: 0,
};

beforeAll(async () => {
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
});

function network(post: (options?: NetworkRequestOptions) => Promise<unknown>): NetworkAdapter {
  return {
    post: (_path: string, _body: unknown, options?: NetworkRequestOptions) => post(options) as never,
    request: async () => ({ status: 200, ok: true }),
    get: async () => ({ status: 200, ok: true }),
  } as unknown as NetworkAdapter;
}

function run(adapter: NetworkAdapter, signal: AbortSignal, toolContext: ShisoToolContext = { session: null, recipe: null, nutrition: null }, userMessage = 'Hi Shiso') {
  return runShisoConversationTurn({
    network: adapter,
    signal,
    context: {
      recipe: null,
      nutrition: { available: false, summary: null, unresolvedCount: 0, needsAmountCount: 0, needsMatchCount: 0, unsavedWorkingReview: false },
      recipeKey: null,
      sessionIdentity: null,
    },
    toolContext,
  }, initialShisoConversation(), userMessage);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SHISO conversation cancellation lifecycle', () => {
  it('passes the owning AbortSignal through the application NetworkAdapter', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const outcome = await run(network(async (options) => {
      received = options?.signal;
      return { status: 200, ok: true, data: reply };
    }), controller.signal);
    expect(received).toBe(controller.signal);
    expect(outcome).toMatchObject({ ok: true, message: 'A current reply.' });
  });

  it('discards a late provider response and never begins its requested tool', async () => {
    const controller = new AbortController();
    const pending = deferred<unknown>();
    let requestStarted = false;
    let saves = 0;
    const tools = {
      session: null,
      recipe: { title: 'Valid recipe', servings: 2, ingredients: [{ line_ref: 'ing:1', name: 'eggs', text: '2 eggs' }], instructions: [] },
      nutrition: null,
      saveWorkingRecipe: async () => { saves += 1; return { ok: true } as never; },
    } as ShisoToolContext;
    const result = run(network(() => { requestStarted = true; return pending.promise; }), controller.signal, tools);
    await vi.waitFor(() => expect(requestStarted).toBe(true));
    controller.abort();
    controller.abort(); // cancellation is idempotent
    pending.resolve({ status: 200, ok: true, data: saveRequest });
    expect(await result).toMatchObject({ ok: false, cancelled: true, message: null, status: null });
    expect(saves).toBe(0);
  });

  it('does not start another iteration when a pending tool finishes after cancellation', async () => {
    const controller = new AbortController();
    let calls = 0;
    let toolStarted = false;
    let ownerReviewVersion = 0;
    const pending = deferred<{ ok: true; analyzed: true; summary: string; matched: number; needs_amount: number; needs_match: number; total_lines: number; unresolved_line_refs: readonly string[]; preview_state: 'complete' }>();
    let ownerFinished = false;
    void pending.promise.then(() => { ownerFinished = true; });
    const tools = {
      session: null,
      nutrition: null,
      recipe: { title: 'Valid recipe', servings: 2, ingredients: [{ line_ref: 'ing:1', name: 'eggs', text: '2 eggs' }], instructions: [] },
      runAnalysis: () => { toolStarted = true; return pending.promise.then((value) => { ownerReviewVersion += 1; return value; }); },
    } as ShisoToolContext;
    const outcome = run(network(async () => {
      calls += 1;
      return { status: 200, ok: true, data: nutritionRequest };
    }), controller.signal, tools);
    // The turn remains pending inside the already-started tool owner.
    await vi.waitFor(() => expect(toolStarted).toBe(true));
    expect(ownerFinished).toBe(false);
    controller.abort();
    pending.resolve({ ok: true, analyzed: true, summary: 'Analysis completed.', matched: 1, needs_amount: 0, needs_match: 0, total_lines: 1, unresolved_line_refs: [], preview_state: 'complete' });
    const finalOutcome = await outcome;
    expect(ownerReviewVersion).toBe(1); // completed owner work is retained despite turn cancellation
    expect(calls).toBe(1);
    expect(finalOutcome).toMatchObject({ ok: false, cancelled: true, message: null });
  });

  it('retains an already-authorized pending save after cancellation without claiming rollback', async () => {
    const controller = new AbortController();
    const pendingSave = deferred<{ ok: true; saved: true; message: string }>();
    let saveStarted = false;
    let persisted = false;
    const tools = {
      session: null,
      nutrition: null,
      recipe: { title: 'Valid recipe', servings: 2, ingredients: [{ line_ref: 'ing:1', name: 'eggs', text: '2 eggs' }], instructions: [] },
      saveWorkingRecipe: async () => {
        saveStarted = true;
        const result = await pendingSave.promise;
        persisted = result.saved;
        return result;
      },
    } as ShisoToolContext;
    const outcome = run(network(async () => ({ status: 200, ok: true, data: saveRequest })), controller.signal, tools, 'Save my changes.');
    await vi.waitFor(() => expect(saveStarted).toBe(true));
    controller.abort();
    pendingSave.resolve({ ok: true, saved: true, message: 'Saved.' });
    const result = await outcome;
    expect(persisted).toBe(true); // an authorized persistence operation cannot be rolled back here
    expect(result).toMatchObject({ ok: false, cancelled: true, message: null });
  });

  it('distinguishes ordinary provider failures from cancellation', async () => {
    const controller = new AbortController();
    const outcome = await run(network(async () => ({
      status: 503, ok: false,
      data: { ok: false, code: 'provider_timeout', message: 'The provider timed out.' },
    })), controller.signal);
    expect(outcome.ok).toBe(false);
    expect(outcome.cancelled).toBeUndefined();
    expect(outcome.status).toBe('The provider timed out.');
  });

  it('does not convert a provider response into success after cancellation during the wait', async () => {
    const controller = new AbortController();
    const pending = deferred<unknown>();
    let requestStarted = false;
    const result = run(network(() => { requestStarted = true; return pending.promise; }), controller.signal);
    await vi.waitFor(() => expect(requestStarted).toBe(true));
    controller.abort();
    pending.resolve({ status: 200, ok: true, data: reply });
    expect(await result).toMatchObject({ ok: false, cancelled: true, message: null });
  });
});
