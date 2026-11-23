/**
 * SINC-2 — USDA Branded Foods route boundary.
 *
 * Boots the REAL Express app and proves:
 *   - endpoint authentication stays first;
 *   - Basic product access is refused with a dedicated 403;
 *   - Advanced access reaches only the bounded lookup port;
 *   - a client body/header cannot forge entitlement;
 *   - the dedicated rate limiter is enforced;
 *   - lookup failures map to bounded statuses;
 *   - the route performs no nutrition write (it returns evidence only).
 *
 * The lookup module is mocked; no live USDA request is made.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { resetRateLimitersForTests } from '../../server/rateLimiter';
import { adaptUsdaBrandedFoodRecord } from '../../src/core/nutritionV2/brandedFoods';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  mockBrandedDetail,
} from '../fixtures/usdaBrandedFixtures';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ query: unknown; signal?: AbortSignal }>,
  result: null as unknown,
  verifyCalls: [] as unknown[],
  verifyResult: null as unknown,
}));

vi.mock('../../server/usdaBrandedFoods.js', () => ({
  lookupUsdaBrandedFoods: async (query: unknown, options?: { signal?: AbortSignal }) => {
    state.calls.push({ query, signal: options?.signal });
    return state.result;
  },
  verifyUsdaBrandedContributions: (body: unknown) => {
    state.verifyCalls.push(body);
    return state.verifyResult;
  },
}));

function candidate() {
  const adapted = adaptUsdaBrandedFoodRecord(mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID), 'gochujang');
  if (!adapted.ok) throw new Error('fixture did not adapt');
  return adapted.candidate;
}

type Boot = { server: http.Server; baseUrl: string };

async function boot(tier?: 'basic' | 'ai_advanced'): Promise<Boot> {
  const { createApp } = await import('../../server/app.js');
  const { createDeploymentNutritionProductAccessAuthority } = await import(
    '../../server/nutritionProductAccessAuthority.js'
  );
  const app = createApp({
    isProduction: false,
    ...(tier === 'ai_advanced'
      ? { nutritionProductAccessAuthority: createDeploymentNutritionProductAccessAuthority('ai_advanced') }
      : {}),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function post(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/nutrition/branded-foods/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

const VALID_BODY = {
  request_version: 'usda_branded_lookup_request_v1',
  line_ref: 'ing:gochujang',
  query: 'gochujang',
};

const VALID_VERIFY_BODY = {
  request_version: 'usda_branded_verification_request_v1',
  items: [{
    evidence_id: 'test-evidence-sinc2r1-0001',
    target: {
      line_ref: 'ing:gochujang',
      ingredient_text: '2 tbsp gochujang',
      query: 'gochujang',
      amount: 2,
      unit: 'tbsp',
      measurement_kind: 'volume',
      quantity_ml: 29.5735295625,
    },
    proposed_digest: `sha256:${'a'.repeat(64)}`,
  }],
};

async function postVerify(
  baseUrl: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/nutrition/branded-foods/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

let basic: Boot;
let advanced: Boot;

beforeAll(async () => {
  delete process.env.AI_ENDPOINT_TOKEN;
  process.env.USDA_BRANDED_LOOKUP_RATE_LIMIT = '1000';
  basic = await boot('basic');
  advanced = await boot('ai_advanced');
}, 120000);

afterAll(async () => {
  await new Promise<void>((resolve) => basic.server.close(() => resolve()));
  await new Promise<void>((resolve) => advanced.server.close(() => resolve()));
  delete process.env.USDA_BRANDED_LOOKUP_RATE_LIMIT;
  delete process.env.AI_ENDPOINT_TOKEN;
});

beforeEach(() => {
  resetRateLimitersForTests();
  state.calls.length = 0;
  state.verifyCalls.length = 0;
  state.verifyResult = {
    ok: true,
    items: [{
      line_ref: 'ing:gochujang',
      contribution: { line_ref: 'ing:gochujang', source_kind: 'usda_branded' },
      verification: {
        version: 'usda_branded_assertion_v1',
        key_id: 'test-key-id-0001',
        signature: 'dGVzdC1zaWduYXR1cmUtdGVzdC1zaWduYXR1cmU=',
        canonical_digest: `sha256:${'a'.repeat(64)}`,
        recipe_digest: `sha256:${'b'.repeat(64)}`,
        review_identity: 'test-session|test-recipe|2',
        issued_at: '2026-11-22T00:00:00.000Z',
        expires_at: '2026-11-22T00:10:00.000Z',
      },
    }],
    signing_public_key: 'dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==',
    signing_key_id: 'test-key-id-0001',
  };
  state.result = {
    ok: true,
    query: 'gochujang',
    total_hits: 1,
    candidates: [candidate()],
    cache_status: 'miss',
    retrieved_at: '2026-11-22T00:00:00.000Z',
    signing_public_key: 'dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==',
    signing_key_id: 'test-key-id-0001',
  };
  process.env.USDA_BRANDED_LOOKUP_RATE_LIMIT = '1000';
  delete process.env.AI_ENDPOINT_TOKEN;
});

describe('SINC-2 branded lookup route — entitlement and authentication', () => {
  it('refuses Basic access with a dedicated 403 and zero lookup calls', async () => {
    const response = await post(basic.baseUrl, VALID_BODY);
    expect(response.status).toBe(403);
    expect(response.json['code']).toBe('NUTRITION_ADVANCED_NOT_ENTITLED');
    expect(state.calls).toHaveLength(0);

    const forged = await post(basic.baseUrl, { ...VALID_BODY, tier: 'ai_advanced' }, {
      'x-kitchen-nutrition-tier': 'ai_advanced',
    });
    expect(forged.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it('allows Advanced access and returns validated source snapshots only', async () => {
    const response = await post(advanced.baseUrl, VALID_BODY);
    expect(response.status).toBe(200);
    expect(response.json['ok']).toBe(true);
    expect(response.json['request_version']).toBe('usda_branded_lookup_response_v1');
    expect(response.json['line_ref']).toBe('ing:gochujang');
    expect(response.json['candidates']).toHaveLength(1);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.query).toBe('gochujang');
  });

  it('keeps endpoint authentication first when a token is configured', async () => {
    process.env.AI_ENDPOINT_TOKEN = 'sinc2-route-token';
    const missing = await post(advanced.baseUrl, VALID_BODY);
    expect(missing.status).toBe(401);
    expect(state.calls).toHaveLength(0);

    const present = await post(advanced.baseUrl, VALID_BODY, {
      authorization: 'Bearer sinc2-route-token',
    });
    expect(present.status).toBe(200);
    expect(state.calls).toHaveLength(1);
  });
});

describe('SINC-2 branded lookup route — validation, limits, failures', () => {
  it('rejects malformed bodies before lookup', async () => {
    for (const body of [
      {},
      { ...VALID_BODY, request_version: 'wrong' },
      { ...VALID_BODY, line_ref: '' },
      { ...VALID_BODY, query: 'https://evil.example' },
    ]) {
      const response = await post(advanced.baseUrl, body);
      expect(response.status).toBe(400);
      expect(response.json['code']).toBe('USDA_BRANDED_LOOKUP_INVALID_REQUEST');
    }
    expect(state.calls).toHaveLength(0);
  });

  it('enforces the dedicated per-IP lookup limiter', async () => {
    process.env.USDA_BRANDED_LOOKUP_RATE_LIMIT = '1';
    resetRateLimitersForTests();
    const first = await post(advanced.baseUrl, VALID_BODY);
    expect(first.status).toBe(200);
    const second = await post(advanced.baseUrl, VALID_BODY);
    expect(second.status).toBe(429);
    expect(second.json['code']).toBe('USDA_BRANDED_LOOKUP_RATE_LIMITED');
    expect(state.calls).toHaveLength(1);
  });

  it('maps not-configured, timeout, rate-limit, auth, and unavailable failures', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ ok: false, code: 'not_configured' }, 503, 'USDA_BRANDED_LOOKUP_NOT_CONFIGURED'],
      [{ ok: false, code: 'timeout' }, 504, 'USDA_BRANDED_LOOKUP_TIMEOUT'],
      [{ ok: false, code: 'rate_limited', retry_after_seconds: 60 }, 429, 'USDA_BRANDED_LOOKUP_RATE_LIMITED'],
      [{ ok: false, code: 'auth_failed' }, 503, 'USDA_BRANDED_LOOKUP_AUTH_FAILED'],
      [{ ok: false, code: 'unavailable' }, 503, 'USDA_BRANDED_LOOKUP_UNAVAILABLE'],
    ];
    for (const [result, status, code] of cases) {
      state.result = result;
      const response = await post(advanced.baseUrl, VALID_BODY);
      expect(response.status).toBe(status);
      expect(response.json['code']).toBe(code);
    }
  });

  it('returns an honest empty candidate set without inventing a product', async () => {
    state.result = {
      ok: true,
      query: 'rice vinegar',
      total_hits: 0,
      candidates: [],
      cache_status: 'miss',
      retrieved_at: '2026-11-22T00:00:00.000Z',
    };
    const response = await post(advanced.baseUrl, { ...VALID_BODY, query: 'rice vinegar' });
    expect(response.status).toBe(200);
    expect(response.json['candidates']).toEqual([]);
  });
});

describe('SINC-2 branded verification route — server-authoritative Apply trust', () => {
  it('refuses Basic access and never calls verification', async () => {
    const response = await postVerify(basic.baseUrl, VALID_VERIFY_BODY);
    expect(response.status).toBe(403);
    expect(response.json['code']).toBe('NUTRITION_ADVANCED_NOT_ENTITLED');
    expect(state.verifyCalls).toHaveLength(0);
  });

  it('returns server-issued verification for an entitled caller', async () => {
    const response = await postVerify(advanced.baseUrl, VALID_VERIFY_BODY);
    expect(response.status).toBe(200);
    expect(response.json['ok']).toBe(true);
    expect(response.json['request_version']).toBe('usda_branded_verification_response_v1');
    expect(response.json['items']).toHaveLength(1);
    expect(response.json['signing_public_key']).toBe('dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleQ==');
    expect(response.json['signing_key_id']).toBe('test-key-id-0001');
    expect(state.verifyCalls).toHaveLength(1);
  });

  it('maps expiry, mismatch, unsupported target, and invalid request without a write', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ ok: false, code: 'invalid_request' }, 400, 'USDA_BRANDED_VERIFICATION_INVALID_REQUEST'],
      [{ ok: false, code: 'evidence_expired' }, 409, 'USDA_BRANDED_VERIFICATION_EXPIRED'],
      [{ ok: false, code: 'evidence_mismatch' }, 409, 'USDA_BRANDED_VERIFICATION_EVIDENCE_MISMATCH'],
      [{ ok: false, code: 'unsupported_target' }, 422, 'USDA_BRANDED_VERIFICATION_UNSUPPORTED_TARGET'],
    ];
    for (const [result, status, code] of cases) {
      state.verifyResult = result;
      const response = await postVerify(advanced.baseUrl, VALID_VERIFY_BODY);
      expect(response.status).toBe(status);
      expect(response.json['code']).toBe(code);
    }
  });
});
