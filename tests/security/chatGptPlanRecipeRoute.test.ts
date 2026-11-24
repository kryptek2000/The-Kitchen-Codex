/**
 * SHISO-C1.6 — the real `/api/recipes/generate` route with the native ChatGPT
 * plan adapter. Deterministic loopback bridge only; no account or paid inference.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const TOKEN = 'e'.repeat(64);
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const MODEL = 'gpt-plan-test';
const TEXT_HEADER = 'x-kitchen-ai-text-selection';
const VALID = {
  title: 'Test Toast',
  ingredients: [{ name: 'bread' }, { name: 'butter' }],
  steps: [{ text: 'Toast the bread.' }, { text: 'Spread the butter.' }],
};

let bridge: http.Server;
let bridgeUrl = '';
let connected = true;
let planEnabled = true;
let inferenceText = JSON.stringify(VALID);
let inferCount = 0;
let externalCalls: string[] = [];
let appServer: http.Server | null = null;
let baseUrl = '';

function json(res: http.ServerResponse, value: unknown) {
  const body = JSON.stringify(value);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && !url.startsWith('http://127.0.0.1:')) {
      externalCalls.push(url);
      throw new Error('External provider call blocked by test');
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
  bridge = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
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
        inferCount += 1;
        json(res, {
          ok: true,
          value: { requestId: 'recipe-route-test', model: MODEL, text: inferenceText, completed: true },
        });
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const address = bridge.address() as AddressInfo;
  bridgeUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (appServer) await new Promise<void>((resolve) => appServer!.close(() => resolve()));
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

afterEach(async () => {
  if (appServer) {
    await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    appServer = null;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  inferCount = 0;
  externalCalls = [];
});

async function startApp() {
  vi.resetModules();
  for (const key of [
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'AI_ENDPOINT_TOKEN',
    'TKC_DESKTOP_SESSION_TOKEN',
    'KITCHEN_CODEX_TEXT_PROVIDER',
    'KITCHEN_CODEX_TEXT_MODEL',
    'KITCHEN_CODEX_IMAGE_PROVIDER',
    'KITCHEN_CODEX_IMAGE_MODEL',
  ]) {
    delete process.env[key];
  }
  vi.stubEnv('TKC_DESKTOP_RUNTIME', '1');
  vi.stubEnv('TKC_CHATGPT_PLAN_BRIDGE_URL', bridgeUrl);
  vi.stubEnv('TKC_CHATGPT_PLAN_BRIDGE_TOKEN', TOKEN);

  const { createApp } = await import('../../server/app.js');
  const { refreshChatGptPlanCatalog } = await import('../../server/ai/chatGptPlanBridge.js');
  await refreshChatGptPlanCatalog();
  const app = createApp({ isProduction: false });
  appServer = http.createServer(app);
  await new Promise<void>((resolve) => appServer!.listen(0, '127.0.0.1', resolve));
  const address = appServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function nativeHeader() {
  return {
    [TEXT_HEADER]: JSON.stringify({
      mode: 'user_selected',
      providerId: 'chatgpt-plan',
      modelId: MODEL,
      credentialSource: 'native_plan',
      accountKey: ACCOUNT,
    }),
  };
}

async function post(body: unknown) {
  const res = await fetch(`${baseUrl}/api/recipes/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...nativeHeader() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => undefined);
  return { res, data };
}

describe('native ChatGPT plan Create for Me route', () => {
  it('returns a complete editable draft with truthful provenance and one bridge call', async () => {
    connected = true;
    planEnabled = true;
    inferenceText = JSON.stringify(VALID);
    await startApp();
    const { res, data } = await post({ prompt: 'Make a simple toast recipe' });
    expect(res.status).toBe(200);
    expect(data).toEqual({
      draft: VALID,
      provenance: { generated: true, providerId: 'chatgpt-plan', model: MODEL },
    });
    expect(inferCount).toBe(1);
    expect(externalCalls).toEqual([]);
  });

  it('rejects an invalid native response with a clear bounded code', async () => {
    connected = true;
    planEnabled = true;
    inferenceText = 'not a JSON recipe';
    await startApp();
    const { res, data } = await post({ prompt: 'Make dinner' });
    expect(res.status).toBe(502);
    expect(data).toMatchObject({ code: 'CHATGPT_PLAN_INVALID_RESPONSE' });
    expect(String(data.error)).not.toContain('not a JSON recipe');
  });

  it('rejects unexpected nested properties with no draft and no fallback', async () => {
    connected = true;
    planEnabled = true;
    inferenceText = JSON.stringify({
      ...VALID,
      ingredients: [{ ...VALID.ingredients[0], hiddenField: 'must reject' }],
    });
    await startApp();
    const { res, data } = await post({ prompt: 'Make dinner' });
    expect(res.status).toBe(502);
    expect(data).toMatchObject({ code: 'CHATGPT_PLAN_INVALID_RESPONSE' });
    expect(data.draft).toBeUndefined();
    expect(inferCount).toBe(1);
    expect(externalCalls).toEqual([]);
  });

  it('reports disconnect clearly and does not call the bridge', async () => {
    connected = false;
    planEnabled = false;
    await startApp();
    const { res, data } = await post({ prompt: 'Make dinner' });
    expect(res.status).toBe(503);
    expect(data).toMatchObject({ code: 'CHATGPT_PLAN_UNAVAILABLE' });
    expect(inferCount).toBe(0);
  });
});
