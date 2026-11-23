/**
 * SHISO-C1.5 — local ChatGPT plan bridge security and shape.
 *
 * No Electron, OAuth, or live provider is involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChatGptPlanBridge } = require('../../desktop/chatgpt/bridge.cjs');

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const openBridges: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (openBridges.length) {
    const bridge = openBridges.pop()!;
    await bridge.close();
  }
});

function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    status: () => ({
      connected: true,
      activeAccount: {
        accountKey: ACCOUNT,
        planEnabled: true,
        signedOut: false,
      },
      models: [],
    }),
    models: vi.fn(async () => [
      { id: 'gpt-plan-test', name: 'ChatGPT Plan Test', secret: 'must-not-cross' },
    ]),
    infer: vi.fn(async ({ accountKey, model, input, requestId }) => ({
      requestId,
      accountKey,
      model,
      input,
      text: 'bounded reply',
      completed: true,
    })),
    cancel: vi.fn(() => false),
    ...overrides,
  };
}

async function start(service: unknown) {
  const bridge = await createChatGptPlanBridge({ service });
  if (!bridge) throw new Error('Bridge did not start.');
  openBridges.push(bridge);
  return bridge;
}

describe('ChatGPT plan bridge', () => {
  it('requires its per-process bearer token', async () => {
    const bridge = await start(fakeService());
    const none = await fetch(`${bridge.url}/v1/models`);
    expect(none.status).toBe(401);
    const wrong = await fetch(`${bridge.url}/v1/models`, {
      headers: { authorization: `Bearer ${'b'.repeat(64)}` },
    });
    expect(wrong.status).toBe(401);
  });

  it('exposes only sanitized live models', async () => {
    const bridge = await start(fakeService());
    const res = await fetch(`${bridge.url}/v1/models`, {
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      connected: true,
      planEnabled: true,
      activeAccountKey: ACCOUNT,
      models: [{ id: 'gpt-plan-test', name: 'ChatGPT Plan Test' }],
    });
    expect(JSON.stringify(body)).not.toContain('must-not-cross');
  });

  it('returns a disconnected catalog instead of inventing entitlement', async () => {
    const bridge = await start(
      fakeService({
        status: () => ({
          connected: false,
          activeAccount: null,
          models: [],
        }),
      })
    );
    const res = await fetch(`${bridge.url}/v1/models`, {
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      connected: false,
      planEnabled: false,
      models: [],
    });
  });

  it('executes one bounded inference request', async () => {
    const service = fakeService();
    const bridge = await start(service);
    const res = await fetch(`${bridge.url}/v1/infer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridge.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accountKey: ACCOUNT,
        model: 'gpt-plan-test',
        input: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      value: { model: 'gpt-plan-test', text: 'bounded reply', completed: true },
    });
    expect(service.infer).toHaveBeenCalledTimes(1);
    expect(service.infer.mock.calls[0][0]).toMatchObject({
      accountKey: ACCOUNT,
      model: 'gpt-plan-test',
      input: [{ role: 'user', content: 'hello' }],
    });
  });

  it('rejects malformed bodies and unknown paths', async () => {
    const bridge = await start(fakeService());
    const bad = await fetch(`${bridge.url}/v1/infer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridge.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${bridge.url}/v1/nope`, {
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    expect(missing.status).toBe(404);
  });
});
