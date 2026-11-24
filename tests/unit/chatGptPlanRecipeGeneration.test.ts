/**
 * SHISO-C1.6 — ChatGPT plan Create for Me adapter.
 *
 * Deterministic loopback bridge fixture only. No owner account, OAuth flow, paid
 * inference, Vault, or browser is used.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import {
  CHATGPT_PLAN_BRIDGE_TOKEN_ENV,
  CHATGPT_PLAN_BRIDGE_URL_ENV,
  refreshChatGptPlanCatalog,
  resetChatGptPlanCatalogForTests,
} from '../../server/ai/chatGptPlanBridge';
import {
  buildNativePlanRecipePrompt,
  ChatGptPlanRecipeInvalidDraftError,
  ChatGptPlanRecipeUnavailableError,
  generateRecipeDraftOnServer,
  parseNativePlanRecipeDraft,
} from '../../server/createRecipe';
import { buildGeneratedRecipeSchema } from '../../src/schema/generatedRecipe';
import { isNativePlanRecipeSelection } from '../../server/ai/effectiveSelection';

const TOKEN = 'd'.repeat(64);
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const MODEL = 'gpt-plan-test';
const VALID_DRAFT = {
  title: 'Weeknight Lemon Rice',
  servings: 4,
  ingredients: [
    { amount: 2, unit: 'cup', name: 'rice' },
    { name: 'lemon zest' },
  ],
  steps: [{ text: 'Cook the rice.' }, { text: 'Fold in the lemon zest.' }],
};
const NORMALIZED_DRAFT = {
  ...VALID_DRAFT,
  steps: [{ text: 'Cook the rice.' }, { text: 'Fold in the lemon zest.' }],
};

let server: http.Server;
let baseUrl = '';
let connected = true;
let planEnabled = true;
let inferenceText = JSON.stringify(VALID_DRAFT);
let inferCount = 0;
let modelCalls = 0;
let lastPrompt = '';
let lastBody: Record<string, unknown> | null = null;

function json(res: http.ServerResponse, value: unknown) {
  const body = JSON.stringify(value);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      modelCalls += 1;
      json(res, {
        ok: true,
        connected,
        planEnabled,
        activeAccountKey: connected ? ACCOUNT : null,
        models: connected && planEnabled ? [{ id: MODEL, name: 'ChatGPT Plan Test' }] : [],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/infer') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          input?: Array<{ content?: string }>;
          accountKey?: string;
          model?: string;
        };
        inferCount += 1;
        lastBody = body as Record<string, unknown>;
        lastPrompt = body.input?.[0]?.content || '';
        json(res, {
          ok: true,
          value: {
            requestId: 'recipe-request',
            model: MODEL,
            text: inferenceText,
            completed: true,
          },
        });
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No bridge port.');
  baseUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('TKC_DESKTOP_RUNTIME', '1');
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_URL_ENV, baseUrl);
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_TOKEN_ENV, TOKEN);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetChatGptPlanCatalogForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  connected = true;
  planEnabled = true;
  inferenceText = JSON.stringify(VALID_DRAFT);
  inferCount = 0;
  modelCalls = 0;
  lastPrompt = '';
  lastBody = null;
  vi.stubEnv('TKC_DESKTOP_RUNTIME', '1');
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_URL_ENV, baseUrl);
  vi.stubEnv(CHATGPT_PLAN_BRIDGE_TOKEN_ENV, TOKEN);
  vi.stubEnv('KITCHEN_CODEX_TEXT_PROVIDER', '');
  vi.stubEnv('KITCHEN_CODEX_TEXT_MODEL', '');
  resetChatGptPlanCatalogForTests();
  await refreshChatGptPlanCatalog();
});

function nativeSelection() {
  return {
    kind: 'EXPLICIT_SELECTED' as const,
    providerId: 'chatgpt-plan',
    modelId: MODEL,
    credentialSource: 'native_plan' as const,
    accountKey: ACCOUNT,
  };
}

describe('ChatGPT plan Create for Me adapter', () => {
  it('builds a strict JSON prompt containing the full existing schema', () => {
    const prompt = buildNativePlanRecipePrompt(
      { prompt: 'Make a lemon rice dinner' },
      buildGeneratedRecipeSchema()
    );
    expect(prompt).toContain('Make a lemon rice dinner');
    expect(prompt).toContain('STRICT RESPONSE FORMAT');
    expect(prompt).toContain('Return exactly ONE JSON object');
    expect(prompt).toContain('Unknown fields are rejected');
    expect(prompt).toContain('"ingredients"');
  });

  it('accepts a complete valid draft and returns it with truthful provenance', async () => {
    expect(isNativePlanRecipeSelection(nativeSelection())).toBe(true);
    const result = await generateRecipeDraftOnServer(
      { prompt: 'Make a lemon rice dinner', constraints: { servings: 4 } },
      { userSelection: nativeSelection() }
    );
    expect(result).toEqual({
      draft: NORMALIZED_DRAFT,
      provenance: { generated: true, providerId: 'chatgpt-plan', model: MODEL },
    });
    expect(inferCount).toBe(1);
    // The just-refreshed panel catalog is reused; a redundant server-side
    // catalog refresh is skipped. The native execution path still revalidates the
    // account/model before inference.
    expect(modelCalls).toBe(1);
    expect(lastBody).toMatchObject({ accountKey: ACCOUNT, model: MODEL });
    expect(lastPrompt).toContain('STRICT RESPONSE FORMAT');
    expect(lastPrompt).toContain('Make a lemon rice dinner');
  });

  it('refreshes a cold native catalog before validating the selected account', async () => {
    resetChatGptPlanCatalogForTests();
    const result = await generateRecipeDraftOnServer(
      { prompt: 'Make a lemon rice dinner' },
      { userSelection: nativeSelection() }
    );
    expect(result.provenance).toEqual({ generated: true, providerId: 'chatgpt-plan', model: MODEL });
    expect(inferCount).toBe(1);
    expect(modelCalls).toBe(2); // cold cache: one explicit refresh + execution path
  });

  it('rejects prose and malformed JSON without extracting a partial recipe', async () => {
    inferenceText = 'Here is your recipe: {"title":"Leaked"}';
    await expect(
      generateRecipeDraftOnServer({ prompt: 'make dinner' }, { userSelection: nativeSelection() })
    ).rejects.toBeInstanceOf(ChatGptPlanRecipeInvalidDraftError);
    expect(() => parseNativePlanRecipeDraft('```json\n{}\n```')).toThrow(
      ChatGptPlanRecipeInvalidDraftError
    );
  });

  it('rejects schema-invalid and oversized drafts', async () => {
    inferenceText = JSON.stringify({ ...VALID_DRAFT, unexpected: 'field' });
    await expect(
      generateRecipeDraftOnServer({ prompt: 'make dinner' }, { userSelection: nativeSelection() })
    ).rejects.toBeInstanceOf(ChatGptPlanRecipeInvalidDraftError);

    inferenceText = `{"title":"${'x'.repeat(200_001)}"}`;
    await expect(
      generateRecipeDraftOnServer({ prompt: 'make dinner' }, { userSelection: nativeSelection() })
    ).rejects.toBeInstanceOf(ChatGptPlanRecipeInvalidDraftError);
  });

  it('rejects unexpected nested ingredient and step properties', async () => {
    inferenceText = JSON.stringify({
      ...VALID_DRAFT,
      ingredients: [{ ...VALID_DRAFT.ingredients[0], hiddenNote: 'reject me' }],
    });
    await expect(
      generateRecipeDraftOnServer({ prompt: 'make dinner' }, { userSelection: nativeSelection() })
    ).rejects.toBeInstanceOf(ChatGptPlanRecipeInvalidDraftError);

    inferenceText = JSON.stringify({
      ...VALID_DRAFT,
      steps: [{ ...VALID_DRAFT.steps[0], hiddenTimer: 10 }],
    });
    await expect(
      generateRecipeDraftOnServer({ prompt: 'make dinner' }, { userSelection: nativeSelection() })
    ).rejects.toBeInstanceOf(ChatGptPlanRecipeInvalidDraftError);
  });

  it('classifies invalid nested output timing without content', async () => {
    const timings: Array<Record<string, unknown>> = [];
    inferenceText = JSON.stringify({
      ...VALID_DRAFT,
      ingredients: [{ ...VALID_DRAFT.ingredients[0], hiddenNote: 'reject me' }],
    });
    await expect(
      generateRecipeDraftOnServer(
        { prompt: 'make dinner' },
        { userSelection: nativeSelection(), onTiming: (timing) => timings.push(timing as never) }
      )
    ).rejects.toBeInstanceOf(ChatGptPlanRecipeInvalidDraftError);
    expect(timings[0]).toMatchObject({ outcome: 'invalid_response', nativePlan: true });
    expect(typeof timings[0].parseMs).toBe('number');
    expect(JSON.stringify(timings[0])).not.toContain('reject me');
  });

  it('fails clearly when the account is disconnected and never calls the bridge', async () => {
    connected = false;
    planEnabled = false;
    await refreshChatGptPlanCatalog();
    await expect(
      generateRecipeDraftOnServer({ prompt: 'make dinner' }, { userSelection: nativeSelection() })
    ).rejects.toBeInstanceOf(ChatGptPlanRecipeUnavailableError);
    expect(inferCount).toBe(0);
  });

  it('does not let the native selection override a server-managed pin', async () => {
    vi.stubEnv('KITCHEN_CODEX_TEXT_PROVIDER', 'gemini');
    vi.stubEnv('KITCHEN_CODEX_TEXT_MODEL', 'gemini-3.7-flash');
    expect(isNativePlanRecipeSelection(nativeSelection())).toBe(false);
    await expect(
      generateRecipeDraftOnServer({ prompt: 'make dinner' }, { userSelection: nativeSelection() })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(inferCount).toBe(0);
  });

  it('honors cancellation before any bridge call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateRecipeDraftOnServer(
        { prompt: 'make dinner' },
        { userSelection: nativeSelection(), signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(inferCount).toBe(0);
  });
});
