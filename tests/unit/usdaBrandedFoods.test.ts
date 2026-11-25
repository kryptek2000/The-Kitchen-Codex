/**
 * SINC-2 server USDA Branded Foods client — deterministic mocked API tests.
 *
 * No live USDA request is made. The fixtures are synthetic and clearly labeled.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  lookupUsdaBrandedFoods,
  resetUsdaBrandedCachesForTests,
  USDA_FDC_API_ORIGIN,
  verifyUsdaBrandedContributions,
} from '../../server/usdaBrandedFoods';
import { buildBrandedContribution } from '../../src/core/nutritionV2/brandedFoods';
import {
  BRANDED_ASSERTION_VERSION,
  brandedAssertionPayload,
  authenticateBrandedContributionsForApply,
  brandedApplyAuthenticationMatches,
  computeBrandedContributionDigest,
  resetBrandedEvidenceTrustForTests,
  verifyBrandedAssertion,
} from '../../src/core/nutritionV2/brandedEvidenceTrust';
import { canonicalStringify } from '../../src/core/nutritionV2/usda/digest';
import { matchesTrustedSigningAnchor } from '../../src/core/nutritionV2/brandedTrustAnchor';
import { createVerify } from 'node:crypto';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID,
  mockBrandedDetail,
  mockBrandedSearchResponse,
} from '../fixtures/usdaBrandedFixtures';

type FetchCall = { url: string; options: Record<string, unknown> };

function failureOf<T extends { ok: boolean }>(result: T): { code: string; retry_after_seconds?: number } {
  return result as unknown as { code: string; retry_after_seconds?: number };
}

function syntheticFetch(calls: FetchCall[]) {
  return async (url: string, options: Record<string, unknown>): Promise<unknown> => {
    calls.push({ url, options });
    if (url.includes('/foods/search')) return mockBrandedSearchResponse();
    const id = Number(url.match(/\/food\/(\d+)/)?.[1]);
    if (id === MOCK_BRANDED_GOCHUJANG_FDC_ID || id === MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID) {
      return mockBrandedDetail(id);
    }
    return {};
  };
}

beforeEach(() => resetUsdaBrandedCachesForTests());

describe('SINC-2 USDA branded lookup — configuration and query', () => {
  it('reports not configured without any network call when no key exists', async () => {
    const calls: FetchCall[] = [];
    const result = await lookupUsdaBrandedFoods('gochujang', {
      deps: { apiKey: '', fetchJson: syntheticFetch(calls) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failureOf(result).code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('rejects empty, control-character, URL-shaped, and overlong queries before fetch', async () => {
    const calls: FetchCall[] = [];
    const deps = { apiKey: 'test-key', fetchJson: syntheticFetch(calls) };
    for (const query of ['', '   ', 'goch\u0000ujang', 'https://evil.example/gochujang', 'x'.repeat(121)]) {
      const result = await lookupUsdaBrandedFoods(query, { deps });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(failureOf(result).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('SINC-2 USDA branded lookup — official search and detail flow', () => {
  it('searches only Branded records, validates details, and caches bounded snapshots', async () => {
    const calls: FetchCall[] = [];
    const deps = { apiKey: 'test-key', fetchJson: syntheticFetch(calls) };
    const first = await lookupUsdaBrandedFoods('gochujang', { deps });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cache_status).toBe('miss');
    expect(first.total_hits).toBe(3);
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates.map((candidate) => candidate.fdc_id)).toEqual([
      MOCK_BRANDED_GOCHUJANG_FDC_ID,
      MOCK_BRANDED_GOCHUJANG_SAUCE_FDC_ID,
    ]);
    expect(first.candidates.every((candidate) => candidate.source === 'usda_fdc_branded')).toBe(true);
    expect(first.candidates.every((candidate) => candidate.snapshot_digest.startsWith('sha256:'))).toBe(true);

    const search = calls.find((call) => call.url.includes('/foods/search'));
    expect(search).toBeDefined();
    expect(search?.url.startsWith(`${USDA_FDC_API_ORIGIN}/fdc/v1/foods/search`)).toBe(true);
    const searchUrl = new URL(search!.url);
    expect(searchUrl.searchParams.get('dataType')).toBe('Branded');
    expect(searchUrl.searchParams.get('query')).toBe('gochujang');
    expect(searchUrl.searchParams.get('api_key')).toBe('test-key');
    expect(search?.options.allowRedirects).toBe(false);

    const detailCalls = calls.filter((call) => call.url.includes('/food/'));
    expect(detailCalls).toHaveLength(2);
    expect(detailCalls.every((call) => call.options.allowRedirects === false)).toBe(true);

    const second = await lookupUsdaBrandedFoods('GOCHUJANG', { deps });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cache_status).toBe('hit');
    expect(calls).toHaveLength(3); // one search + two details, no repeat network work
  });

  it('returns an honest empty candidate set when the search has no branded hit', async () => {
    const calls: FetchCall[] = [];
    const result = await lookupUsdaBrandedFoods('nothing at all', {
      deps: {
        apiKey: 'test-key',
        fetchJson: async (url, options) => {
          calls.push({ url, options });
          return { foods: [], totalHits: 0 };
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates).toHaveLength(0);
      expect(result.total_hits).toBe(0);
    }
    expect(calls).toHaveLength(1);
  });
});

describe('SINC-2 USDA branded lookup — failure taxonomy', () => {
  function throwingFetch(code: string, status?: number, retryAfterSeconds?: number) {
    return async (): Promise<unknown> => {
      const error = new Error('synthetic upstream failure') as Error & Record<string, unknown>;
      error.code = code;
      if (status !== undefined) error.status = status;
      if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
      throw error;
    };
  }

  it('maps upstream auth, rate, timeout, redirect, and server failures without leaking details', async () => {
    const deps = (code: string, status?: number, retry?: number) => ({
      apiKey: 'test-key',
      fetchJson: throwingFetch(code, status, retry),
    });
    const auth = await lookupUsdaBrandedFoods('gochujang', { deps: deps('http_status', 401) });
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(failureOf(auth).code).toBe('auth_failed');

    const rate = await lookupUsdaBrandedFoods('gochujang', { deps: deps('http_status', 429, 120) });
    expect(rate.ok).toBe(false);
    if (!rate.ok) {
      expect(failureOf(rate).code).toBe('rate_limited');
      expect(failureOf(rate).retry_after_seconds).toBe(120);
    }

    const timeout = await lookupUsdaBrandedFoods('gochujang', { deps: deps('timeout') });
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(failureOf(timeout).code).toBe('timeout');

    const redirect = await lookupUsdaBrandedFoods('gochujang', { deps: deps('redirect_not_allowed', 302) });
    expect(redirect.ok).toBe(false);
    if (!redirect.ok) expect(failureOf(redirect).code).toBe('invalid_response');

    const server = await lookupUsdaBrandedFoods('gochujang', { deps: deps('http_status', 503) });
    expect(server.ok).toBe(false);
    if (!server.ok) expect(failureOf(server).code).toBe('unavailable');

    const malformed = await lookupUsdaBrandedFoods('gochujang', {
      deps: { apiKey: 'test-key', fetchJson: async () => ({ foods: 'not-an-array' }) },
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(failureOf(malformed).code).toBe('invalid_response');
  });

  it('does not silently hide a rate limit discovered during detail retrieval', async () => {
    let searchDone = false;
    const result = await lookupUsdaBrandedFoods('gochujang', {
      deps: {
        apiKey: 'test-key',
        fetchJson: async (url) => {
          if (url.includes('/foods/search')) {
            searchDone = true;
            return mockBrandedSearchResponse();
          }
          if (searchDone) {
            const error = new Error('synthetic rate limit') as Error & Record<string, unknown>;
            error.code = 'http_status';
            error.status = 429;
            error.retryAfterSeconds = 30;
            throw error;
          }
          return {};
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failureOf(result).code).toBe('rate_limited');
  });

  it('reports cancellation and never retries', async () => {
    let calls = 0;
    const controller = new AbortController();
    const pending = lookupUsdaBrandedFoods('gochujang', {
      signal: controller.signal,
      deps: {
        apiKey: 'test-key',
        fetchJson: async (_url, options) => {
          calls += 1;
          const signal = options.signal as AbortSignal | undefined;
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const error = new Error('cancelled') as Error & Record<string, unknown>;
              error.code = 'cancelled';
              reject(error);
            }, { once: true });
          });
        },
      },
    });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failureOf(result).code).toBe('cancelled');
    expect(calls).toBe(1);
  });
});


describe('SINC-2 branded evidence verification — server-held snapshot recomputation', () => {
  async function lookupAt(now: number) {
    const calls: FetchCall[] = [];
    const result = await lookupUsdaBrandedFoods('gochujang', {
      deps: { apiKey: 'test-key', fetchJson: syntheticFetch(calls), now: () => now },
    });
    if (!result.ok) throw new Error(`lookup failed: ${(result as { code: string }).code}`);
    return result;
  }

  function itemFor(result: Awaited<ReturnType<typeof lookupAt>>) {
    const candidate = result.candidates.find((entry) => entry.fdc_id === MOCK_BRANDED_GOCHUJANG_FDC_ID);
    if (!candidate?.evidence_id) throw new Error('missing evidence id');
    const built = buildBrandedContribution(candidate, {
      line_ref: 'ing:gochujang',
      ingredient_text: '2 tbsp gochujang',
      query: 'gochujang',
      amount: 2,
      unit: 'tbsp',
      measurement_kind: 'volume',
      quantity_ml: 29.5735295625,
    });
    if (!built.ok) throw new Error(`build failed: ${(built as { reason?: string }).reason}`);
    return {
      evidence_id: candidate.evidence_id,
      target: {
        line_ref: 'ing:gochujang',
        ingredient_text: '2 tbsp gochujang',
        query: 'gochujang',
        amount: 2,
        unit: 'tbsp',
        measurement_kind: 'volume',
        quantity_ml: 29.5735295625,
      },
      proposed_digest: computeBrandedContributionDigest(built.contribution),
      contribution: built.contribution,
    };
  }

  it('recomputes the canonical contribution from its own snapshot and issues verification', async () => {
    const now = 1_000_000;
    const lookup = await lookupAt(now);
    const item = itemFor(lookup);
    const result = verifyUsdaBrandedContributions({
      request_version: 'usda_branded_verification_request_v1',
      recipe_digest: `sha256:${'c'.repeat(64)}`,
      review_identity: 'server-test-session|server-test-recipe|4',
      items: [{ evidence_id: item.evidence_id, target: item.target, proposed_digest: item.proposed_digest }],
    }, { now: () => now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.line_ref).toBe('ing:gochujang');
    const verification = result.items[0]!.verification;
    expect(verification.version).toBe(BRANDED_ASSERTION_VERSION);
    expect(verification.canonical_digest).toBe(item.proposed_digest);
    expect(verification.recipe_digest).toBe(`sha256:${'c'.repeat(64)}`);
    expect(verification.review_identity).toBe('server-test-session|server-test-recipe|4');
    expect(verification.key_id).toBe(result.signing_key_id);
    expect(result.signing_public_key).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    const verifier = createVerify('sha256');
    verifier.update(canonicalStringify(brandedAssertionPayload(result.items[0]!.contribution, verification)));
    verifier.end();
    expect(verifier.verify(
      { key: Buffer.from(result.signing_public_key, 'base64'), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' },
      Buffer.from(verification.signature, 'base64')
    )).toBe(true);
    const mutatedPayload = canonicalStringify({ ...brandedAssertionPayload(result.items[0]!.contribution, verification), fdc_id: 1 });
    const badVerifier = createVerify('sha256');
    badVerifier.update(mutatedPayload);
    badVerifier.end();
    expect(badVerifier.verify(
      { key: Buffer.from(result.signing_public_key, 'base64'), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' },
      Buffer.from(verification.signature, 'base64')
    )).toBe(false);
    expect(result.items[0]?.contribution.nutrients.calories).toEqual({ amount: 60, unit: 'kcal' });
    expect(result.items[0]?.contribution.usda_branded?.evidence_id).toBe(item.evidence_id);
  });

  it('produces an assertion the browser WebCrypto verifier accepts', async () => {
    resetBrandedEvidenceTrustForTests();
    const now = 5_000_000;
    const lookup = await lookupAt(now);
    const item = itemFor(lookup);
    const result = verifyUsdaBrandedContributions({
      request_version: 'usda_branded_verification_request_v1',
      recipe_digest: `sha256:${'c'.repeat(64)}`,
      review_identity: 'server-test-session|server-test-recipe|4',
      items: [{ evidence_id: item.evidence_id, target: item.target, proposed_digest: item.proposed_digest }],
    }, { now: () => now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(matchesTrustedSigningAnchor(result.signing_public_key, result.signing_key_id)).toBe(true);
    const contribution = result.items[0]!.contribution;
    const verification = result.items[0]!.verification;
    const trusted = Object.freeze({
      ...contribution,
      usda_branded: Object.freeze({ ...contribution.usda_branded, verification }),
    });
    const recipeDigest = `sha256:${'c'.repeat(64)}`;
    const reviewIdentity = 'server-test-session|server-test-recipe|4';
    const accepted = await verifyBrandedAssertion(trusted, verification, {
      recipe_digest: recipeDigest,
      review_identity: reviewIdentity,
      now,
    });
    expect(accepted).toBe(true);
    const authentication = await authenticateBrandedContributionsForApply([trusted], {
      recipe_digest: recipeDigest,
      review_identity: reviewIdentity,
      now,
    });
    expect(authentication.ok).toBe(true);
    if (authentication.ok) {
      expect(brandedApplyAuthenticationMatches(authentication.authentication, trusted, recipeDigest, now)).toBe(true);
    }
  });

  it('rejects a proposed nutrient mutation even when the client keeps a well-formed digest', async () => {
    const now = 2_000_000;
    const lookup = await lookupAt(now);
    const item = itemFor(lookup);
    const tampered = {
      ...item.contribution,
      nutrients: { ...item.contribution.nutrients, calories: { amount: 999999, unit: 'kcal' as const } },
    };
    const tamperedDigest = computeBrandedContributionDigest(tampered);
    // The attacker can compute any public digest, but the server recomputes from
    // its own snapshot and rejects the mismatch.
    const result = verifyUsdaBrandedContributions({
      request_version: 'usda_branded_verification_request_v1',
      recipe_digest: `sha256:${'c'.repeat(64)}`,
      review_identity: 'server-test-session|server-test-recipe|4',
      items: [{ evidence_id: item.evidence_id, target: item.target, proposed_digest: tamperedDigest }],
    }, { now: () => now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result as { code: string }).code).toBe('evidence_mismatch');
  });

  it('rejects expired/unknown evidence and unsupported targets', async () => {
    const now = 3_000_000;
    const lookup = await lookupAt(now);
    const item = itemFor(lookup);
    const expired = verifyUsdaBrandedContributions({
      request_version: 'usda_branded_verification_request_v1',
      recipe_digest: `sha256:${'c'.repeat(64)}`,
      review_identity: 'server-test-session|server-test-recipe|4',
      items: [{ evidence_id: item.evidence_id, target: item.target, proposed_digest: item.proposed_digest }],
    }, { now: () => now + 2 * 60 * 60 * 1000 });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect((expired as { code: string }).code).toBe('evidence_expired');

    const unknown = verifyUsdaBrandedContributions({
      request_version: 'usda_branded_verification_request_v1',
      recipe_digest: `sha256:${'c'.repeat(64)}`,
      review_identity: 'server-test-session|server-test-recipe|4',
      items: [{ evidence_id: 'unknown-evidence-id-0001', target: item.target, proposed_digest: item.proposed_digest }],
    }, { now: () => now });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect((unknown as { code: string }).code).toBe('evidence_expired');

    const now2 = 4_000_000;
    const lookup2 = await lookupAt(now2);
    const item2 = itemFor(lookup2);
    const { quantity_ml: _omitMl, quantity_grams: _omitGrams, ...targetWithoutQuantity } = item2.target as typeof item2.target & { quantity_grams?: number };
    const unsupported = verifyUsdaBrandedContributions({
      request_version: 'usda_branded_verification_request_v1',
      recipe_digest: `sha256:${'c'.repeat(64)}`,
      review_identity: 'server-test-session|server-test-recipe|4',
      items: [{
        evidence_id: item2.evidence_id,
        target: { ...targetWithoutQuantity, measurement_kind: 'unknown' },
        proposed_digest: item2.proposed_digest,
      }],
    }, { now: () => now2 });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect((unsupported as { code: string }).code).toBe('unsupported_target');
  });
});
