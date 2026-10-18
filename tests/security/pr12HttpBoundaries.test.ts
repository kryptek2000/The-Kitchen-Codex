import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app';
import { createDeploymentNutritionProductAccessAuthority } from '../../server/nutritionProductAccessAuthority';
import { resetRateLimitersForTests } from '../../server/rateLimiter';
import { runShisoTurn } from '../../server/shiso/conversationTurn';
import { toInertValue, utf8ByteLength } from '../../src/core/nutritionV2/schema';

vi.mock('../../server/shiso/conversationTurn', () => ({ runShisoTurn: vi.fn(async () => ({ ok: true, reply: 'mock' })) }));
vi.mock('../../server/geminiClient', () => ({ getGemini: vi.fn(() => null) }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); resetRateLimitersForTests(); });

async function withServer(run: (base: string, authority: { resolve: ReturnType<typeof vi.fn> }) => Promise<void>, trustProxy = '') {
  vi.stubEnv('AI_ENDPOINT_TOKEN', '');
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubEnv('TRUST_PROXY', trustProxy);
  vi.stubEnv('NUTRITION_PLAN_RATE_LIMIT', '1000');
  vi.stubEnv('SHISO_CONVERSATION_RATE_LIMIT', '2');
  const deployment = createDeploymentNutritionProductAccessAuthority('ai_advanced');
  const authority = { resolve: vi.fn(deployment.resolve) };
  const server = http.createServer(createApp({ isProduction: false, nutritionProductAccessAuthority: authority }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, authority); }
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
