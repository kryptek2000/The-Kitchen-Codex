/**
 * SHISO-C1 — durable conversation continuity, bounded continuation memory,
 * local persistence, and retry semantics.
 *
 * Deterministic provider mocks only. No live provider or Vault write is used.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildShisoContinuation,
  initialShisoConversation,
  runShisoConversationTurn,
  type ShisoConversationState,
} from '../../src/application/shisoConversation';
import {
  clearShisoConversation,
  loadShisoConversation,
  saveShisoConversation,
  shisoConversationStorageKey,
} from '../../src/application/shisoConversationPersistence';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import { SHISO_LIMITS, type ShisoConversationContext } from '../../src/core/shiso/protocol';
import { readShisoTurnRequest } from '../../server/shiso/turnRequest';

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null });
});

function memorySettings(): SettingsAdapter & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key) => values.get(key) as never,
    set: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
}

function context(): ShisoConversationContext {
  return {
    recipe: { title: 'Continuity Test', servings: 4, ingredientCount: 1, stepCount: 1 },
    nutrition: {
      available: false,
      summary: null,
      unresolvedCount: 0,
      needsAmountCount: 0,
      needsMatchCount: 0,
      unsavedWorkingReview: false,
    },
    recipeKey: 'recipe-key',
    sessionIdentity: 'session-identity',
  };
}

function replyNetwork(replies: string[]): { adapter: NetworkAdapter; bodies: Array<Record<string, unknown>> } {
  let index = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const adapter = {
    post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
      bodies.push(body);
      const text = replies[Math.min(index, replies.length - 1)] ?? 'Okay.';
      index += 1;
      return {
        status: 200,
        ok: true,
        data: {
          ok: true,
          kind: 'reply',
          text,
          proposals: [],
          model_invocations_used: 1,
          tool_calls_used: 0,
        },
      };
    }),
    get: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
    request: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
  } as unknown as NetworkAdapter;
  return { adapter, bodies };
}

const emptyToolContext = {
  recipe: null,
  session: null,
  nutrition: null,
  researchEligibleRefs: [],
  brandedEligibleRefs: [],
} as never;

describe('SHISO-C1 — bounded long-history continuation', () => {
  it('retains a longer local transcript but sends only the recent window plus labelled continuation memory', async () => {
    const network = replyNetwork(['Acknowledged.']);
    let state: ShisoConversationState = initialShisoConversation();
    for (let turn = 1; turn <= 31; turn += 1) {
      const outcome = await runShisoConversationTurn(
        { network: network.adapter, context: context(), toolContext: emptyToolContext as never },
        state,
        `Turn ${turn}: remember that my goal is a quick weeknight dinner.`,
      );
      expect(outcome.ok).toBe(true);
      state = outcome.state;
    }
    expect(state.messages.length).toBeGreaterThan(48);
    expect(state.messages.length).toBeLessThanOrEqual(SHISO_LIMITS.maxStoredMessages);

    const lastBody = network.bodies.at(-1)!;
    const history = lastBody['history'] as Array<{ role: string; text: string }>;
    expect(history).toHaveLength(SHISO_LIMITS.maxHistoryMessages);
    const continuation = lastBody['continuation'] as {
      earlier_user_messages: string[];
      earlier_assistant_messages: string[];
      verified_findings: unknown[];
    };
    expect(continuation).toBeDefined();
    expect(continuation.earlier_user_messages.length).toBeGreaterThan(0);
    expect(continuation.earlier_user_messages).toContain(
      'Turn 14: remember that my goal is a quick weeknight dinner.',
    );
    expect(continuation.earlier_assistant_messages.length).toBeGreaterThan(0);
    expect(continuation.verified_findings).toEqual([]);
  });

  it('distinguishes user statements, model prose, and verified findings in continuation memory', () => {
    const state: ShisoConversationState = {
      messages: [
        { role: 'user' as const, text: 'Old goal: use less salt.' },
        { role: 'assistant' as const, text: 'Old model claim, not proof.' },
        ...Array.from({ length: SHISO_LIMITS.maxHistoryMessages }, (_, index) => ({
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          text: `message ${index}`,
        })),
      ],
      proposals: Object.freeze([]),
      findings: Object.freeze([{
        tool: 'get_current_recipe' as const,
        ok: true,
        summary: 'Recipe has 4 ingredients.',
      }]),
    };
    const continuation = buildShisoContinuation(state, 'Unsaved working recipe: 1 change.');
    expect(continuation).toBeDefined();
    expect(continuation!.earlier_user_messages).toContain('Old goal: use less salt.');
    expect(continuation!.earlier_assistant_messages).toContain('Old model claim, not proof.');
    expect(continuation!.verified_findings[0]).toMatchObject({
      tool: 'get_current_recipe',
      ok: true,
      summary: 'Recipe has 4 ingredients.',
    });
    expect(continuation!.working_state).toContain('Unsaved working recipe');
  });
});

describe('SHISO-C1 — server continuation validation', () => {
  it('bounds continuation memory at the wire boundary', () => {
    const parsed = readShisoTurnRequest({
      turn_version: 'shiso_turn_request_v1',
      user_message: 'continue',
      continuation: {
        earlier_user_messages: Array.from({ length: 20 }, (_, index) => `user ${index}`),
        earlier_assistant_messages: Array.from({ length: 20 }, (_, index) => `assistant ${index}`),
        verified_findings: Array.from({ length: 20 }, (_, index) => ({
          tool: 'get_current_recipe',
          ok: true,
          summary: `finding ${index}`,
        })),
        working_state: 'x'.repeat(1000),
      },
    });
    expect(parsed).not.toBeNull();
    const continuation = parsed!.continuation!;
    expect(continuation.earlier_user_messages).toHaveLength(SHISO_LIMITS.maxContinuationUserMessages);
    expect(continuation.earlier_assistant_messages).toHaveLength(SHISO_LIMITS.maxContinuationAssistantMessages);
    expect(continuation.verified_findings).toHaveLength(SHISO_LIMITS.maxContinuationFindings);
    expect(continuation.working_state).toHaveLength(SHISO_LIMITS.maxContinuationWorkingStateChars);
  });
});

describe('SHISO-C1 — local persistence and retry', () => {
  it('persists only bounded conversation content and never credentials, authorizations, or proposals', async () => {
    const settings = memorySettings();
    const state: ShisoConversationState = {
      messages: Object.freeze([
        { role: 'user', text: 'Remember my goal: quick dinners.' },
        { role: 'assistant', text: 'Understood.' },
      ]),
      proposals: Object.freeze([{ proposal_id: 'stale-proposal' } as never]),
      findings: Object.freeze([{ tool: 'get_current_recipe', ok: true, summary: '4 ingredients.' }]),
    };
    await saveShisoConversation(settings, 'recipe:Recipes/Test.md', {
      messages: state.messages,
      entries: [
        { key: 'u1', role: 'user', text: 'Remember my goal: quick dinners.', tools: [] },
        { key: 'a2', role: 'assistant', text: 'Understood.', tools: [] },
      ],
      findings: state.findings,
      nextSeq: 2,
    });
    const raw = settings.values.get(shisoConversationStorageKey('recipe:Recipes/Test.md'));
    expect(raw).toBeDefined();
    const serialized = JSON.stringify(raw);
    expect(serialized).toContain('quick dinners');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('stale-proposal');

    const loaded = await loadShisoConversation(settings, 'recipe:Recipes/Test.md');
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.findings[0]?.summary).toBe('4 ingredients.');
    expect(loaded?.nextSeq).toBe(2);
    await clearShisoConversation(settings, 'recipe:Recipes/Test.md');
    expect(await loadShisoConversation(settings, 'recipe:Recipes/Test.md')).toBeNull();
  });

  it('does not offer another mutation attempt when a verified edit succeeded before a provider failure', async () => {
    let call = 0;
    const adapter = {
      post: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            status: 200,
            ok: true,
            data: {
              ok: true,
              kind: 'tool_request',
              tool: 'apply_ingredient_edits',
              args: {
                tool: 'apply_ingredient_edits',
                edits: [{ line_ref: 'l1', new_name: 'turkey' }],
              },
              model_invocations_used: 1,
              tool_calls_used: 0,
            },
          };
        }
        return {
          status: 200,
          ok: true,
          data: {
            ok: false,
            code: 'provider_timeout',
            message: 'The provider timed out after the verified edit.',
            aiAttempted: true,
          },
        };
      }),
      get: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
      request: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
    } as unknown as NetworkAdapter;
    const applyIngredientEdits = vi.fn(async () => ({
      ok: true,
      applied: [{ line_ref: 'l1', before: '2 cups chicken', after: '2 cups turkey', changes: ['name: chicken → turkey'] }],
      refused: [],
      summary: 'Changed the chicken to turkey in the unsaved working copy.',
      working_unsaved: true,
      note: '',
    }));
    const outcome = await runShisoConversationTurn(
      {
        network: adapter,
        context: context(),
        toolContext: {
          recipe: {
            title: 'Continuity Test',
            servings: 4,
            ingredients: [{ text: '2 cups chicken', name: 'chicken', line_ref: 'l1' }],
            instructions: [],
          },
          session: null,
          nutrition: null,
          applyIngredientEdits,
          researchEligibleRefs: [],
          brandedEligibleRefs: [],
        } as never,
      },
      initialShisoConversation(),
      'Adjust the protein in this dish.',
    );
    expect(outcome.ok).toBe(true);
    expect(applyIngredientEdits).toHaveBeenCalledTimes(1);
    expect(outcome.message).toContain('Changed the chicken to turkey');
    expect(outcome.state.findings.some((finding) => finding.tool === 'apply_ingredient_edits' && finding.ok)).toBe(true);
  });

  it('applies explicit retention limits to locally stored messages and transcript entries', async () => {
    const settings = memorySettings();
    const messages = Array.from({ length: 240 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `stored message ${index}`,
    }));
    const entries = messages.map((message, index) => ({
      key: `${message.role}${index}`,
      role: message.role,
      text: message.text,
      tools: [],
    }));
    await saveShisoConversation(settings, 'recipe:Retention.md', {
      messages,
      entries,
      findings: [],
      nextSeq: 240,
    });
    const loaded = await loadShisoConversation(settings, 'recipe:Retention.md');
    expect(loaded?.messages.length).toBeLessThanOrEqual(SHISO_LIMITS.maxStoredMessages);
    expect(loaded?.entries.length).toBeLessThanOrEqual(120);
    expect(loaded?.messages.at(-1)?.text).toBe('stored message 239');
  });

  it('retries the retained user message without duplicating it and completes the turn', async () => {
    let calls = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = {
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        bodies.push(body);
        calls += 1;
        if (calls === 1) {
          return {
            status: 200,
            ok: true,
            data: {
              ok: false,
              code: 'provider_timeout',
              message: 'The AI provider took too long to answer this message.',
              aiAttempted: true,
            },
          };
        }
        return {
          status: 200,
          ok: true,
          data: {
            ok: true,
            kind: 'reply',
            text: 'Recovered answer.',
            proposals: [],
            model_invocations_used: 1,
            tool_calls_used: 0,
          },
        };
      }),
      get: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
      request: vi.fn(async () => ({ status: 404, ok: false, data: {} })),
    } as unknown as NetworkAdapter;

    const first = await runShisoConversationTurn(
      { network: adapter, context: context(), toolContext: emptyToolContext as never },
      initialShisoConversation(),
      'Recoverable question.',
    );
    expect(first.ok).toBe(false);
    expect(first.state.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const retried = await runShisoConversationTurn(
      { network: adapter, context: context(), toolContext: emptyToolContext as never, retry: true },
      first.state,
      'Recoverable question.',
    );
    expect(retried.ok).toBe(true);
    expect(retried.state.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(retried.state.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Recovered answer.' });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const history = body['history'] as Array<{ role: string }>;
      expect(history.filter((message) => message.role === 'user')).toHaveLength(1);
    }
  });
});
