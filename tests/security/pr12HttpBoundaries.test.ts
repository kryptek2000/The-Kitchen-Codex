import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app';
import { createDeploymentNutritionProductAccessAuthority } from '../../server/nutritionProductAccessAuthority';
import { resetRateLimitersForTests } from '../../server/rateLimiter';
import { runShisoTurn } from '../../server/shiso/conversationTurn';
import * as aiNutrition from '../../server/shiso/aiNutrition';
import { toInertValue, utf8ByteLength } from '../../src/core/nutritionV2/schema';
import { BASIC_NUTRITION_PRODUCT_ACCESS, AI_ADVANCED_NUTRITION_PRODUCT_ACCESS } from '../../src/core/nutritionV2/nutritionProductAccess';

vi.mock('../../server/shiso/conversationTurn', () => ({ runShisoTurn: vi.fn(async () => ({ ok: true, reply: 'mock' })) }));
vi.mock('../../server/geminiClient', () => ({ getGemini: vi.fn(() => null) }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); resetRateLimitersForTests(); });

async function withServer(run: (base: string, authority: { resolve: ReturnType<typeof vi.fn> }, app?: ReturnType<typeof createApp>) => Promise<void>, trustProxy = '') {
  vi.stubEnv('AI_ENDPOINT_TOKEN', '');
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubEnv('TRUST_PROXY', trustProxy);
  vi.stubEnv('NUTRITION_PLAN_RATE_LIMIT', '1000');
  vi.stubEnv('SHISO_CONVERSATION_RATE_LIMIT', '2');
  const deployment = createDeploymentNutritionProductAccessAuthority('ai_advanced');
  const authority = { resolve: vi.fn(deployment.resolve) };
  const app = createApp({ isProduction: false, nutritionProductAccessAuthority: authority });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, authority, app); }
  finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
}
async function withMultiClientServer(run: (port: number) => Promise<void>) {
  vi.stubEnv('AI_ENDPOINT_TOKEN', '');
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubEnv('TRUST_PROXY', '');
  const server = http.createServer(createApp({ isProduction: false }));
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as AddressInfo).port;
  try { await run(port); }
  finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
}
function getFromClient(port: number, localAddress: string, forwardedFor?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/health', method: 'GET', localAddress,
      headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {},
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
    req.on('error', reject);
    req.end();
  });
}
const post = (base: string, path: string, body: unknown, headers: Record<string,string> = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const valid = () => ({ request_version: 'nutrition_ai_advanced_plan_request_v1', request_id: 'req-boundary',
  plan_request: { contract_version: 'nutrition_ai_advanced_plan_v1', lines: [{ line_ref: 'sauce', candidates: [
    { candidate_ref: 'c1', display_description: 'Tomato sauce', semantic_tags: ['tomato'] },
  ] }] }, planning_targets: [{ line_ref: 'sauce', source_text: '1 cup tomato sauce' }],
});

describe('PR12 parameter tampering over real HTTP', () => {
  it('rejects arrays where strings are required and strings where arrays are required', async () => {
    await withServer(async base => {
      const mutations: Array<(body: any) => void> = [
        b => { b.request_id = ['req-boundary']; },
        b => { b.plan_request.lines = 'sauce'; },
        b => { b.plan_request.lines[0].line_ref = ['sauce']; },
        b => { b.plan_request.lines[0].candidates = 'c1'; },
        b => { b.plan_request.lines[0].candidates[0].display_description = ['Tomato sauce']; },
        b => { b.plan_request.lines[0].candidates[0].semantic_tags = 'tomato'; },
        b => { b.plan_request.lines[0].candidates[0].semantic_tags = [['tomato']]; },
        b => { b.planning_targets[0].source_text = ['1 cup tomato sauce']; },
      ];
      for (const mutate of mutations) {
        const body = valid(); mutate(body);
        const response = await post(base, '/api/nutrition/plan-ingredients', body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ ok: false });
      }
    });
  });
  it('gates SHISO nutrition for Basic and unavailable authority before the estimator', async () => {
    const estimator = vi.spyOn(aiNutrition, 'estimateRecipeNutrientsWithAi').mockResolvedValue({ ok: true, result: 'estimated' } as never);
    await withServer(async (base, authority) => {
      authority.resolve.mockResolvedValue({ status: 'resolved', access: BASIC_NUTRITION_PRODUCT_ACCESS });
      const basic = await post(base, '/api/shiso/nutrition', {});
      expect(basic.status).toBe(403);
      expect(await basic.json()).toMatchObject({ code: 'NUTRITION_AI_NOT_ENTITLED', aiAttempted: false });
      expect(estimator).not.toHaveBeenCalled();

      authority.resolve.mockResolvedValue({ status: 'unavailable' });
      const unavailable = await post(base, '/api/shiso/nutrition', {});
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ code: 'NUTRITION_PRODUCT_ACCESS_UNAVAILABLE', aiAttempted: false });
      expect(estimator).not.toHaveBeenCalled();
    });
    estimator.mockRestore();
  });
  it('allows a legitimately entitled SHISO nutrition request to reach its estimator', async () => {
    let estimatorSignal: AbortSignal | undefined;
    const estimator = vi.spyOn(aiNutrition, 'estimateRecipeNutrientsWithAi').mockImplementation((_raw, _selection, signal) => {
      estimatorSignal = signal;
      return Promise.resolve({ ok: true, result: 'estimated' } as never);
    });
    await withServer(async (base, authority) => {
      authority.resolve.mockResolvedValue({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS });
      const response = await post(base, '/api/shiso/nutrition', {});
      expect(response.status).toBe(200);
      expect(estimator).toHaveBeenCalledTimes(1);
      expect(estimatorSignal?.aborted).toBe(false); // a normal completed response never counts as cancellation
    });
    estimator.mockRestore();
  });
  it('cancels SHISO nutrition on a real client disconnect and cleans lifecycle listeners without writing a response', async () => {
    let observedSignal: AbortSignal | undefined;
    const estimator = vi.spyOn(aiNutrition, 'estimateRecipeNutrientsWithAi').mockImplementation((_raw, _selection, signal) => new Promise(resolve => {
      observedSignal = signal;
      signal?.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled' } as never), { once: true });
    }));
    await withServer(async (base, authority, app) => {
      authority.resolve.mockResolvedValue({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS });
      const reqProto = app!.request as any;
      const resProto = app!.response as any;
      const reqOnce = reqProto.once; const reqOff = reqProto.off;
      const resOnce = resProto.once; const resOff = resProto.off;
      const responseJson = resProto.json;
      let requestListenersAdded = 0; let requestListenersRemoved = 0;
      let responseListenersAdded = 0; let responseListenersRemoved = 0;
      let closedResponseAttempts = 0;
      reqProto.once = function (event: string, listener: (...args: unknown[]) => void) {
        if (event === 'aborted' && listener.name === 'abortOnRequestAborted') requestListenersAdded += 1;
        return reqOnce.call(this, event, listener);
      };
      reqProto.off = function (event: string, listener: (...args: unknown[]) => void) {
        if (event === 'aborted' && listener.name === 'abortOnRequestAborted') requestListenersRemoved += 1;
        return reqOff.call(this, event, listener);
      };
      resProto.once = function (event: string, listener: (...args: unknown[]) => void) {
        if (event === 'close' && listener.name === 'abortOnIncompleteResponseClose') responseListenersAdded += 1;
        return resOnce.call(this, event, listener);
      };
      resProto.off = function (event: string, listener: (...args: unknown[]) => void) {
        if (event === 'close' && listener.name === 'abortOnIncompleteResponseClose') responseListenersRemoved += 1;
        return resOff.call(this, event, listener);
      };
      resProto.json = function (...args: unknown[]) {
        if (this.destroyed) closedResponseAttempts += 1;
        return responseJson.apply(this, args);
      };
      try {
        const client = new AbortController();
        const pending = fetch(`${base}/api/shiso/nutrition`, {
          method: 'POST', signal: client.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        await vi.waitFor(() => expect(estimator).toHaveBeenCalledTimes(1));
        expect(observedSignal?.aborted).toBe(false);
        client.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
        expect(requestListenersAdded).toBe(1);
        expect(requestListenersRemoved).toBe(1);
        expect(responseListenersAdded).toBe(1);
        expect(responseListenersRemoved).toBe(1);
        expect(closedResponseAttempts).toBe(0);
      } finally {
        reqProto.once = reqOnce; reqProto.off = reqOff;
        resProto.once = resOnce; resProto.off = resOff; resProto.json = responseJson;
      }
    });
    estimator.mockRestore();
  });
  it.each([
    ['/api/shiso/turn', 'conversation'],
    ['/api/shiso/nutrition', 'nutrition'],
  ] as const)('%s does not dispatch after disconnect during pending entitlement resolution', async (path, kind) => {
    let estimatorCalls = 0;
    const estimator = vi.spyOn(aiNutrition, 'estimateRecipeNutrientsWithAi').mockImplementation(() => {
      estimatorCalls += 1;
      return Promise.resolve({ ok: true } as never);
    });
    const conversation = vi.mocked(runShisoTurn);
    conversation.mockClear();
    const access = deferred<{ status: 'resolved'; access: typeof AI_ADVANCED_NUTRITION_PRODUCT_ACCESS }>();
    let handlerEntered = false;
    let serverSawDisconnect!: () => void;
    const disconnectSeen = new Promise<void>(resolve => { serverSawDisconnect = resolve; });
    await withServer(async (base, authority, app) => {
      authority.resolve.mockImplementation(() => access.promise);
      const reqProto = app!.request as any;
      const resProto = app!.response as any;
      const reqOnce = reqProto.once;
      const resOnce = resProto.once;
      const originalJson = resProto.json;
      const routeStack = ((app as any)._router?.stack ?? (app as any).router?.stack);
      const routeLayer = routeStack.find((layer: any) => layer.route?.path === path);
      expect(routeLayer).toBeTruthy();
      const terminal = routeLayer.route.stack.at(-1);
      const originalHandler = terminal.handle;
      let responseAttemptsAfterClose = 0;
      resProto.json = function (...args: unknown[]) {
        if (this.destroyed) responseAttemptsAfterClose += 1;
        return originalJson.apply(this, args);
      };
      terminal.handle = function (...args: unknown[]) {
        handlerEntered = true;
        return originalHandler.apply(this, args);
      };
      reqProto.once = function (event: string, listener: (...args: unknown[]) => void) {
        return reqOnce.call(this, event, listener);
      };
      resProto.once = function (event: string, listener: (...args: unknown[]) => void) {
        if (event === 'close') resOnce.call(this, event, () => serverSawDisconnect());
        return resOnce.call(this, event, listener);
      };

      const url = new URL(`${base}${path}`);
      const client = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } });
      client.on('error', () => {});
      try {
        client.end(JSON.stringify(kind === 'conversation' ? { turn_version: 'shiso_turn_request_v1', user_message: 'Hi' } : {}));
        await vi.waitFor(() => expect(authority.resolve).toHaveBeenCalledTimes(1));
        client.destroy();
        await disconnectSeen;
        access.resolve({ status: 'resolved', access: AI_ADVANCED_NUTRITION_PRODUCT_ACCESS });
        await vi.waitFor(() => expect(handlerEntered).toBe(true));
        if (kind === 'conversation') expect(conversation).not.toHaveBeenCalled();
        else expect(estimatorCalls).toBe(0);
        expect(responseAttemptsAfterClose).toBe(0);
        expect(authority.resolve).toHaveBeenCalledTimes(1);
      } finally {
        terminal.handle = originalHandler;
        reqProto.once = reqOnce;
        resProto.once = resOnce;
        resProto.json = originalJson;
      }
    });
    estimator.mockRestore();
  });
  it('rejects the malformed array/string inputs on the exact SHISO nutrition SARIF source', async () => {
    await withServer(async base => {
      vi.stubEnv('SHISO_CONVERSATION_RATE_LIMIT', '1000');
      const recipe = { title: 'test', servings: 2, ingredients: [{ line_ref: 'L1', text: '2 apples' }], instructions: [] };
      for (const payload of [
        [], 'recipe', { recipe: [] },
        { recipe: { ...recipe, title: ['test'] } },
        { recipe: { ...recipe, servings: '2' } },
        { recipe: { ...recipe, ingredients: '2 apples' } },
        { recipe: { ...recipe, ingredients: [['2 apples']] } },
        { recipe: { ...recipe, ingredients: [{ line_ref: ['L1'], text: '2 apples' }] } },
        { recipe: { ...recipe, ingredients: [{ line_ref: 'L1', text: ['2 apples'] }] } },
        { recipe: { ...recipe, instructions: 'chop' } },
      ]) {
        const response = await post(base, '/api/shiso/nutrition', payload);
        expect(response.status).toBe(400);
      }
    });
  });
  it('preserves array values as inert arrays, with accurate string byte counts', () => {
    expect(toInertValue(['a', 'é'])).toMatchObject({ ok: true, value: ['a', 'é'] });
    expect(utf8ByteLength('aé😀')).toBe(7);
    expect(() => utf8ByteLength(['a'] as unknown as string)).toThrow(TypeError);
  });
});

describe('PR12 actual SHISO HTTP limiter', () => {
  it('blocks the third valid turn despite spoofed forwarding headers, before another provider turn', async () => {
    await withServer(async (base, authority) => {
      const body = { turn_version: 'shiso_turn_request_v1', user_message: 'hello' };
      for (let i=0; i<2; i++) expect((await post(base, '/api/shiso/turn', body, { 'X-Forwarded-For': `10.0.0.${i}` })).status).toBe(200);
      const blocked = await post(base, '/api/shiso/turn', body, { 'X-Forwarded-For': '8.8.8.8' });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('ratelimit-limit')).toBe('2');
      expect(blocked.headers.get('ratelimit-remaining')).toBe('0');
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(runShisoTurn).toHaveBeenCalledTimes(2);
      // A blocked turn must not invoke product authorization again.
      expect(authority.resolve).toHaveBeenCalledTimes(2);
    });
  });
  it('uses the safe default limit for invalid configuration and shares the SHISO bucket', async () => {
    await withServer(async base => {
      vi.stubEnv('SHISO_CONVERSATION_RATE_LIMIT', 'invalid');
      for (let i = 0; i < 60; i++) {
        const response = await post(base, '/api/shiso/turn', {});
        expect(response.status).toBe(400);
        expect(response.headers.get('ratelimit-limit')).toBe('60');
      }
      expect((await post(base, '/api/shiso/nutrition', {})).status).toBe(429);
      expect(runShisoTurn).not.toHaveBeenCalled();
    });
  });
  it('checks endpoint authentication before entitlement, with no model execution', async () => {
    await withServer(async (base, authority) => {
      vi.stubEnv('AI_ENDPOINT_TOKEN', 'test-only-token');
      const response = await post(base, '/api/shiso/turn', {});
      expect(response.status).toBe(401);
      expect(authority.resolve).not.toHaveBeenCalled();
      expect(runShisoTurn).not.toHaveBeenCalled();
    });
  });

});

describe('process-wide request ceiling', () => {
  it('returns a retryable 429 at 600 requests and keeps independent socket clients separate', async () => {
    await withMultiClientServer(async port => {
      for (let i = 0; i < 600; i++) {
        expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
      }
      const blocked = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(blocked.headers.get('ratelimit-policy')).toContain('600-in-1min');
      expect(await getFromClient(port, '127.0.0.2')).toBe(200);
    });
  });

  it('uses forwarded client identity only when a trusted proxy hop is configured', async () => {
    await withServer(async base => {
      const port = Number(new URL(base).port);
      for (let i = 0; i < 600; i++) {
        expect(await getFromClient(port, '127.0.0.1', '198.51.100.10')).toBe(200);
      }
      expect(await getFromClient(port, '127.0.0.1', '198.51.100.10')).toBe(429);
      expect(await getFromClient(port, '127.0.0.1', '198.51.100.11')).toBe(200);
    }, '1');
  });
});
