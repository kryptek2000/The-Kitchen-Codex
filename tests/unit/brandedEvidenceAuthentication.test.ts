/**
 * SINC-2R2 — server-authenticated branded evidence.
 *
 * Reproduces both re-audit attacks:
 *   A. A forged local contribution with 999999 calories and a publicly computed
 *      digest cannot obtain trusted Apply authorization.
 *   B. A legitimate assertion for recipe A cannot be reused for recipe B, even
 *      with identical ingredient text and line reference.
 *
 * Also covers expiry, trust-context reset, wrong ingredient, and the legitimate
 * server-verified path. All keys/fixtures are synthetic.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  adaptUsdaBrandedFoodRecord,
  buildBrandedContribution,
} from '../../src/core/nutritionV2/brandedFoods';
import {
  authenticateBrandedContributionsForApply,
  BrandedApplyAuthentication,
  brandedApplyAuthenticationMatches,
  computeBrandedContributionDigest,
  isBrandedApplyAuthentication,
  verifyBrandedAssertion,
  resetBrandedEvidenceTrustForTests,
} from '../../src/core/nutritionV2/brandedEvidenceTrust';
import {
  validateAiNutrientContributions,
  type AiNutrientContribution,
} from '../../src/core/nutritionV2/aiContribution';
import {
  requestUsdaBrandedFoodLookup,
  verifyUsdaBrandedContributionsForApply,
} from '../../src/application/nutritionBrandedFoods';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import {
  makeAttackerAssertion,
  makeTestAssertion,
  makeTrustedContribution,
  pinTestSigningKey,
  TEST_ALTERNATE_KEY_ID,
  TEST_ALTERNATE_PUBLIC_KEY,
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_PUBLIC_KEY,
} from '../fixtures/brandedAssertion';
import {
  MOCK_BRANDED_GOCHUJANG_FDC_ID,
  mockBrandedDetail,
} from '../fixtures/usdaBrandedFixtures';

const LINE = '2 tbsp gochujang';
const LINE_REF = 'ing:gochujang';
const RECIPE_DIGEST = `sha256:${'a'.repeat(64)}`;
const REVIEW_IDENTITY = 'session-sinc2r2|recipe-sinc2r2|2';

function untrustedContribution() {
  const adapted = adaptUsdaBrandedFoodRecord(
    mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
    'gochujang'
  );
  if (!adapted.ok) throw new Error('fixture failed');
  const candidate = Object.freeze({ ...adapted.candidate, evidence_id: 'test-evidence-sinc2r2-0001' });
  const built = buildBrandedContribution(candidate, {
    line_ref: LINE_REF,
    ingredient_text: LINE,
    query: 'gochujang',
    amount: 2,
    unit: 'tbsp',
    measurement_kind: 'volume',
    quantity_ml: 29.5735295625,
  });
  if (!built.ok) throw new Error(`build failed: ${(built as { reason?: string }).reason}`);
  return built.contribution;
}

async function trustedContribution() {
  pinTestSigningKey();
  return makeTrustedContribution(untrustedContribution(), {
    recipeDigest: RECIPE_DIGEST,
    reviewIdentity: REVIEW_IDENTITY,
  });
}

async function validateWithAuthentication(
  contribution: AiNutrientContribution,
  recipeDigest = RECIPE_DIGEST,
) {
  const authentication = await authenticateBrandedContributionsForApply([contribution], {
    recipe_digest: recipeDigest,
    review_identity: REVIEW_IDENTITY,
  });
  if (!authentication.ok) return authentication;
  return validateAiNutrientContributions([contribution], {
    recipe_digest: recipeDigest,
    line_refs: [LINE_REF],
    line_text_by_ref: { [LINE_REF]: LINE },
    requireTrustedBranded: true,
    brandedAuthentication: authentication.authentication,
  });
}

beforeEach(() => resetBrandedEvidenceTrustForTests());

describe('SINC-2R2 Attack A — forged local contribution cannot be trusted', () => {
  it('rejects 999999 calories with a matching public digest and no server signature', async () => {
    const contribution = untrustedContribution();
    const forged: AiNutrientContribution = Object.freeze({
      ...contribution,
      nutrients: Object.freeze({
        ...contribution.nutrients,
        calories: Object.freeze({ amount: 999999, unit: 'kcal' as const }),
      }),
    });
    const publicDigest = computeBrandedContributionDigest(forged);
    const attacker = makeAttackerAssertion(forged, {
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    pinTestSigningKey();
    const marked = await verifyBrandedAssertion(forged, attacker, {
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    expect(marked).toBe(false);
    const checked = await validateWithAuthentication(forged);
    expect(checked.ok).toBe(false);
    // The forged row has no server-signed verification at all; if an attacker
    // fabricates one, it fails signature verification below.
    if (!checked.ok) {
      expect(['invalid_branded_source', 'branded_evidence_untrusted']).toContain((checked as { code: string }).code);
    }
    // A matching public digest is not authenticity.
    expect(publicDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(forged.usda_branded?.verification).toBeUndefined();
  });

  it('rejects a forged contribution even when a legitimate assertion is copied onto it', async () => {
    const legit = await trustedContribution();
    const forged: AiNutrientContribution = Object.freeze({
      ...legit,
      nutrients: Object.freeze({
        ...legit.nutrients,
        calories: Object.freeze({ amount: 999999, unit: 'kcal' as const }),
      }),
    });
    const checked = await validateWithAuthentication(forged);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect((checked as { code: string }).code).toBe('branded_evidence_untrusted');
  });
});

describe('SINC-2R2 Attack B — context-bound assertion cannot be reused', () => {
  it('rejects the same contribution/assertion under a different recipe/review identity', async () => {
    const trusted = await trustedContribution();
    const assertion = trusted.usda_branded?.verification;
    expect(assertion).toBeDefined();
    const otherContext = {
      recipeDigest: `sha256:${'b'.repeat(64)}`,
      reviewIdentity: 'other-session|other-recipe|2',
    };
    const accepted = await verifyBrandedAssertion(trusted, assertion, {
      recipe_digest: otherContext.recipeDigest,
      review_identity: otherContext.reviewIdentity,
    });
    expect(accepted).toBe(false);
  });

  it('rejects replay of a valid assertion onto a different line/contribution', async () => {
    const trusted = await trustedContribution();
    const assertion = trusted.usda_branded!.verification!;
    const replayed: AiNutrientContribution = Object.freeze({
      ...trusted,
      line_ref: 'ing:other',
      ingredient: '2 tbsp other paste',
      usda_branded: Object.freeze({ ...trusted.usda_branded, verification: assertion }),
    });
    const accepted = await verifyBrandedAssertion(replayed, assertion, {
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    expect(accepted).toBe(false);
    const checked = validateAiNutrientContributions([replayed], {
      recipe_digest: RECIPE_DIGEST,
      line_refs: ['ing:other'],
      line_text_by_ref: { 'ing:other': '2 tbsp other paste' },
      requireTrustedBranded: true,
    });
    expect(checked.ok).toBe(false);
  });
});

describe('SINC-2R2 assertion failure modes', () => {
  it('rejects an expired assertion', async () => {
    pinTestSigningKey();
    const contribution = untrustedContribution();
    const base = 1_000_000;
    const assertion = makeTestAssertion(contribution, {
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
      now: base,
      ttlMs: 10 * 60 * 1000,
    });
    const trusted = Object.freeze({
      ...contribution,
      usda_branded: Object.freeze({ ...contribution.usda_branded, verification: assertion }),
    });
    const accepted = await verifyBrandedAssertion(trusted, assertion, {
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
      now: base + 11 * 60 * 1000,
    });
    expect(accepted).toBe(false);
  });

  it('rejects every data mutation against a trusted contribution', async () => {
    const trusted = await trustedContribution();
    const mutations: AiNutrientContribution[] = [
      { ...trusted, nutrients: { ...trusted.nutrients, protein: { amount: 999, unit: 'g' } } },
      { ...trusted, usda_branded: { ...trusted.usda_branded, fdc_id: 123 } },
      { ...trusted, usda_branded: { ...trusted.usda_branded, brand_owner: 'Forged Brand' } },
      { ...trusted, usda_branded: { ...trusted.usda_branded, serving_size: 999 } },
      { ...trusted, usda_branded: { ...trusted.usda_branded, snapshot_digest: `sha256:${'b'.repeat(64)}` } },
      { ...trusted, usda_branded: { ...trusted.usda_branded, target: { ...trusted.usda_branded!.target!, quantity_ml: 500 } } },
    ];
    for (const mutated of mutations) {
      const checked = await validateWithAuthentication(mutated);
      expect(checked.ok).toBe(false);
    }
  });

  it('rejects a capability under a different recipe context', async () => {
    const trusted = await trustedContribution();
    const authentication = await authenticateBrandedContributionsForApply([trusted], {
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    expect(authentication.ok).toBe(true);
    if (!authentication.ok) return;
    const otherDigest = `sha256:${'b'.repeat(64)}`;
    expect(brandedApplyAuthenticationMatches(authentication.authentication, trusted, otherDigest)).toBe(false);
    const checked = validateAiNutrientContributions([trusted], {
      recipe_digest: otherDigest,
      line_refs: [LINE_REF],
      line_text_by_ref: { [LINE_REF]: LINE },
      requireTrustedBranded: true,
      brandedAuthentication: authentication.authentication,
    });
    expect(checked.ok).toBe(false);
  });

  it('rejects a fabricated capability object with a permissive matches method', async () => {
    const trusted = await trustedContribution();
    const forgedCapability = { matches: () => true };
    const checked = validateAiNutrientContributions([trusted], {
      recipe_digest: RECIPE_DIGEST,
      line_refs: [LINE_REF],
      line_text_by_ref: { [LINE_REF]: LINE },
      requireTrustedBranded: true,
      brandedAuthentication: forgedCapability as never,
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect((checked as { code: string }).code).toBe('branded_evidence_untrusted');
  });

  it('ignores an overridden capability method and matches only the exact contribution', async () => {
    const trusted = await trustedContribution();
    const authentication = await authenticateBrandedContributionsForApply([trusted], {
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    expect(authentication.ok).toBe(true);
    if (!authentication.ok) return;
    const tamperedCapability = authentication.authentication as unknown as { matches?: () => boolean };
    tamperedCapability.matches = () => true;
    const forged: AiNutrientContribution = Object.freeze({
      ...trusted,
      nutrients: Object.freeze({
        ...trusted.nutrients,
        calories: Object.freeze({ amount: 999999, unit: 'kcal' as const }),
      }),
    });
    expect(brandedApplyAuthenticationMatches(tamperedCapability, forged, RECIPE_DIGEST)).toBe(false);
    expect(brandedApplyAuthenticationMatches(tamperedCapability, trusted, RECIPE_DIGEST)).toBe(true);
  });

  it('cannot construct a capability through the exported class', async () => {
    const trusted = await trustedContribution();
    expect(() => new BrandedApplyAuthentication(Symbol('attacker'))).toThrow();
    const fabricated = Object.create(BrandedApplyAuthentication.prototype) as BrandedApplyAuthentication;
    expect(isBrandedApplyAuthentication(fabricated)).toBe(false);
    const checked = validateAiNutrientContributions([trusted], {
      recipe_digest: RECIPE_DIGEST,
      line_refs: [LINE_REF],
      line_text_by_ref: { [LINE_REF]: LINE },
      requireTrustedBranded: true,
      brandedAuthentication: fabricated,
    });
    expect(checked.ok).toBe(false);
  });

  it('rejects a validly signed contribution whose authored ingredient does not match the recipe line', async () => {
    pinTestSigningKey();
    const contribution = untrustedContribution();
    const mutated = Object.freeze({ ...contribution, ingredient: '2 tbsp a different product' });
    const assertion = makeTestAssertion(mutated, {
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    const trusted = Object.freeze({
      ...mutated,
      usda_branded: Object.freeze({ ...mutated.usda_branded, verification: assertion }),
    });
    const marked = await verifyBrandedAssertion(trusted, assertion, {
      recipe_digest: RECIPE_DIGEST,
      review_identity: REVIEW_IDENTITY,
    });
    expect(marked).toBe(true);
    const checked = await validateWithAuthentication(trusted);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect((checked as { code: string }).code).toBe('line_text_mismatch');
  });
});

describe('SINC-2R2 signing identity pinning', () => {
  function lookupNetwork(publicKey: string, keyId: string, calls: unknown[] = []) {
    const adapted = adaptUsdaBrandedFoodRecord(
      mockBrandedDetail(MOCK_BRANDED_GOCHUJANG_FDC_ID),
      'gochujang'
    );
    if (!adapted.ok) throw new Error('fixture failed');
    return {
      post: async (_path: string, body: unknown) => {
        calls.push(body);
        return {
          status: 200,
          ok: true,
          data: {
            ok: true,
            request_version: 'usda_branded_lookup_response_v1',
            line_ref: LINE_REF,
            query: 'gochujang',
            total_hits: 1,
            candidates: [adapted.candidate],
            cache_status: 'miss',
            retrieved_at: '2026-11-22T00:00:00.000Z',
            signing_public_key: publicKey,
            signing_key_id: keyId,
            limitations: ['Synthetic test limitation.'],
          },
        };
      },
      get: async () => ({ status: 404, ok: false, data: {} }),
      request: async () => ({ status: 404, ok: false, data: {} }),
    } as unknown as NetworkAdapter;
  }

  it('requires the configured build-time anchor and rejects a different server identity', async () => {
    const first = await requestUsdaBrandedFoodLookup({
      network: lookupNetwork(TEST_SIGNING_PUBLIC_KEY, TEST_SIGNING_KEY_ID),
      lineRef: LINE_REF,
      query: 'gochujang',
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.candidates).toHaveLength(1);

    // A restarted/changed server presents a different key. The session pin is
    // immutable, so the candidate response is rejected rather than silently
    // trusting new signing authority.
    const rotated = await requestUsdaBrandedFoodLookup({
      network: lookupNetwork(TEST_ALTERNATE_PUBLIC_KEY, TEST_ALTERNATE_KEY_ID),
      lineRef: LINE_REF,
      query: 'gochujang',
    });
    expect(rotated.ok).toBe(false);
    expect((rotated as { code?: string }).code).toBe('invalid_response');
  });

  it('rejects a verification response whose signing identity differs from the configured anchor', async () => {
    pinTestSigningKey();
    const contribution = untrustedContribution();
    const assertion = makeTestAssertion(contribution, {
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    const result = await verifyUsdaBrandedContributionsForApply({
      network: {
        post: async () => ({
          status: 200,
          ok: true,
          data: {
            ok: true,
            request_version: 'usda_branded_verification_response_v1',
            signing_public_key: TEST_ALTERNATE_PUBLIC_KEY,
            signing_key_id: TEST_ALTERNATE_KEY_ID,
            items: [{ line_ref: LINE_REF, contribution, verification: assertion }],
          },
        }),
        get: async () => ({ status: 404, ok: false, data: {} }),
        request: async () => ({ status: 404, ok: false, data: {} }),
      } as unknown as NetworkAdapter,
      contributions: [contribution],
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe('untrusted');
  });
});

describe('SINC-2R2 legitimate apply transport', () => {
  function fakeNetwork(response: Record<string, unknown>, calls: unknown[] = []) {
    return {
      post: async (_path: string, body: unknown) => {
        calls.push(body);
        return { status: 200, ok: true, data: response };
      },
      get: async () => ({ status: 404, ok: false, data: {} }),
      request: async () => ({ status: 404, ok: false, data: {} }),
    } as unknown as NetworkAdapter;
  }

  it('accepts a genuinely signed server assertion and marks the exact contribution', async () => {
    pinTestSigningKey();
    const contribution = untrustedContribution();
    const assertion = makeTestAssertion(contribution, {
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    const calls: unknown[] = [];
    const result = await verifyUsdaBrandedContributionsForApply({
      network: fakeNetwork({
        ok: true,
        request_version: 'usda_branded_verification_response_v1',
        signing_public_key: TEST_SIGNING_PUBLIC_KEY,
        signing_key_id: TEST_SIGNING_KEY_ID,
        items: [{
          line_ref: LINE_REF,
          contribution,
          verification: assertion,
        }],
      }, calls),
      contributions: [contribution],
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1);
    expect(result.contributions[0]?.usda_branded?.verification?.signature).toBe(assertion.signature);
    const checked = await validateWithAuthentication(result.contributions[0]!);
    expect(checked.ok).toBe(true);
  });

  it('rejects a server response that does not match the proposed contribution', async () => {
    pinTestSigningKey();
    const contribution = untrustedContribution();
    const mutated = {
      ...contribution,
      nutrients: { ...contribution.nutrients, calories: { amount: 999999, unit: 'kcal' } },
    };
    const assertion = makeTestAssertion(mutated as AiNutrientContribution, {
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    const result = await verifyUsdaBrandedContributionsForApply({
      network: fakeNetwork({
        ok: true,
        request_version: 'usda_branded_verification_response_v1',
        signing_public_key: TEST_SIGNING_PUBLIC_KEY,
        signing_key_id: TEST_SIGNING_KEY_ID,
        items: [{
          line_ref: LINE_REF,
          contribution: mutated,
          verification: assertion,
        }],
      }),
      contributions: [contribution],
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe('evidence_mismatch');
  });

  it('cannot obtain Apply trust for a 999999-calorie forgery through the verify endpoint', async () => {
    pinTestSigningKey();
    const contribution = untrustedContribution();
    const forged: AiNutrientContribution = Object.freeze({
      ...contribution,
      nutrients: Object.freeze({
        ...contribution.nutrients,
        calories: Object.freeze({ amount: 999999, unit: 'kcal' as const }),
      }),
    });
    // The attacker can compute any public digest and knows a real evidence id.
    const result = await verifyUsdaBrandedContributionsForApply({
      network: {
        post: async () => ({
          status: 409,
          ok: false,
          data: { ok: false, code: 'USDA_BRANDED_VERIFICATION_EVIDENCE_MISMATCH' },
        }),
        get: async () => ({ status: 404, ok: false, data: {} }),
        request: async () => ({ status: 404, ok: false, data: {} }),
      } as unknown as NetworkAdapter,
      contributions: [forged],
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe('evidence_mismatch');
    const checked = await validateWithAuthentication(forged);
    expect(checked.ok).toBe(false);
  });

  it('fails closed when the server-held evidence expired or the server forgot it', async () => {
    pinTestSigningKey();
    const contribution = untrustedContribution();
    const result = await verifyUsdaBrandedContributionsForApply({
      network: {
        post: async () => ({
          status: 409,
          ok: false,
          data: { ok: false, code: 'USDA_BRANDED_VERIFICATION_EXPIRED' },
        }),
        get: async () => ({ status: 404, ok: false, data: {} }),
        request: async () => ({ status: 404, ok: false, data: {} }),
      } as unknown as NetworkAdapter,
      contributions: [contribution],
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe('evidence_expired');
    const checked = await validateWithAuthentication(contribution);
    expect(checked.ok).toBe(false);
  });

  it('makes no network request when there is no branded contribution', async () => {
    const calls: unknown[] = [];
    const result = await verifyUsdaBrandedContributionsForApply({
      network: fakeNetwork({}, calls),
      contributions: [],
      recipeDigest: RECIPE_DIGEST,
      reviewIdentity: REVIEW_IDENTITY,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
