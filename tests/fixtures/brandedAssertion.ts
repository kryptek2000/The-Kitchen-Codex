/**
 * SINC-2R2 TEST FIXTURE — synthetic ECDSA signing authority.
 *
 * This is not a production key and is never used by the application server.
 * It lets deterministic tests sign/verify assertions without exposing any
 * server secret. SYNTHETIC FIXTURES ONLY.
 */

import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalStringify } from '../../src/core/nutritionV2/usda/digest';
import {
  BRANDED_ASSERTION_VERSION,
  brandedAssertionPayload,
  verifyBrandedAssertion,
  authenticateBrandedContributionsForApply,
} from '../../src/core/nutritionV2/brandedEvidenceTrust';
import { computeBrandedContributionDigest } from '../../src/core/nutritionV2/brandedEvidenceTrust';
import { matchesTrustedSigningAnchor } from '../../src/core/nutritionV2/brandedTrustAnchor';
import type { AiBrandedVerification, AiNutrientContribution } from '../../src/core/nutritionV2/aiContribution';
import testKey from './brandedTestKey.json';

const keyPair = {
  privateKey: createPrivateKey({
    key: Buffer.from(testKey.private_key_pkcs8_base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  }),
};
export const TEST_SIGNING_PUBLIC_KEY = testKey.public_key;
export const TEST_SIGNING_KEY_ID = testKey.key_id;

const alternateKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const alternatePublicDer = alternateKeyPair.publicKey.export({ type: 'spki', format: 'der' });
export const TEST_ALTERNATE_PUBLIC_KEY = Buffer.from(alternatePublicDer).toString('base64');
export const TEST_ALTERNATE_KEY_ID = createHash('sha256').update(alternatePublicDer).digest('hex').slice(0, 16);

export interface TestAssertionContext {
  readonly recipeDigest: string;
  readonly reviewIdentity: string;
  readonly now?: number;
  readonly ttlMs?: number;
}

function signWithCurrentKey(payload: Record<string, unknown>): string {
  return sign('sha256', Buffer.from(canonicalStringify(payload), 'utf8'), {
    key: keyPair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
}

/**
 * The test build's trust anchor must be the synthetic fixture key. This function
 * CANNOT register or change a key; it only asserts the build-time anchor.
 */
export function pinTestSigningKey(): void {
  if (!matchesTrustedSigningAnchor(TEST_SIGNING_PUBLIC_KEY, TEST_SIGNING_KEY_ID)) {
    throw new Error('test trust anchor is not configured to the synthetic fixture key');
  }
}

export function makeTestAssertion(
  contribution: AiNutrientContribution,
  context: TestAssertionContext
): AiBrandedVerification {
  const now = context.now ?? Date.now();
  const expires = now + (context.ttlMs ?? 10 * 60 * 1000);
  const base = {
    version: BRANDED_ASSERTION_VERSION,
    key_id: TEST_SIGNING_KEY_ID,
    signature: '',
    canonical_digest: computeBrandedContributionDigest(contribution),
    recipe_digest: context.recipeDigest,
    review_identity: context.reviewIdentity,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(expires).toISOString(),
  } as const;
  const signature = signWithCurrentKey(brandedAssertionPayload(contribution, base));
  return Object.freeze({ ...base, signature });
}

export async function makeTrustedContribution(
  contribution: AiNutrientContribution,
  context: TestAssertionContext
): Promise<AiNutrientContribution> {
  pinTestSigningKey();
  const assertion = makeTestAssertion(contribution, context);
  const trusted: AiNutrientContribution = Object.freeze({
    ...contribution,
    usda_branded: Object.freeze({
      ...contribution.usda_branded,
      verification: assertion,
    }),
  });
  const valid = await verifyBrandedAssertion(trusted, assertion, {
    recipe_digest: context.recipeDigest,
    review_identity: context.reviewIdentity,
    now: context.now,
  });
  if (!valid) throw new Error('test assertion verification failed');
  return trusted;
}

/** Mints the per-Apply capability used by Phase 5 authorization tests. */
export async function makeApplyAuthentication(
  contribution: AiNutrientContribution,
  context: TestAssertionContext
) {
  const result = await authenticateBrandedContributionsForApply([contribution], {
    recipe_digest: context.recipeDigest,
    review_identity: context.reviewIdentity,
    ...(context.now !== undefined ? { now: context.now } : {}),
  });
  if (!result.ok) throw new Error('test Apply authentication failed');
  return result.authentication;
}

/** A valid assertion from a DIFFERENT signing identity (rotation test). */
export function makeAlternateAssertion(
  contribution: AiNutrientContribution,
  context: TestAssertionContext
): AiBrandedVerification {
  const now = context.now ?? Date.now();
  const base = {
    version: BRANDED_ASSERTION_VERSION,
    key_id: TEST_ALTERNATE_KEY_ID,
    signature: '',
    canonical_digest: computeBrandedContributionDigest(contribution),
    recipe_digest: context.recipeDigest,
    review_identity: context.reviewIdentity,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + (context.ttlMs ?? 10 * 60 * 1000)).toISOString(),
  } as const;
  const signature = sign(
    'sha256',
    Buffer.from(canonicalStringify(brandedAssertionPayload(contribution, base)), 'utf8'),
    { key: alternateKeyPair.privateKey, dsaEncoding: 'ieee-p1363' }
  ).toString('base64');
  return Object.freeze({ ...base, signature });
}

/** A deliberately different attacker key, used only for forgery tests. */
export function makeAttackerAssertion(
  contribution: AiNutrientContribution,
  context: TestAssertionContext
): AiBrandedVerification {
  const attacker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = context.now ?? Date.now();
  const base = {
    version: BRANDED_ASSERTION_VERSION,
    key_id: TEST_SIGNING_KEY_ID,
    signature: '',
    canonical_digest: computeBrandedContributionDigest(contribution),
    recipe_digest: context.recipeDigest,
    review_identity: context.reviewIdentity,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + (context.ttlMs ?? 10 * 60 * 1000)).toISOString(),
  } as const;
  const signature = sign(
    'sha256',
    Buffer.from(canonicalStringify(brandedAssertionPayload(contribution, base)), 'utf8'),
    { key: attacker.privateKey, dsaEncoding: 'ieee-p1363' }
  ).toString('base64');
  return Object.freeze({ ...base, signature });
}
