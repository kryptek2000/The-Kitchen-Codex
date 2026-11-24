/**
 * The Kitchen Codex — SINC-2R4 per-Apply branded evidence authentication.
 *
 * The server signing identity is a BUILD-TIME public-key anchor, not a value a
 * caller can register. A branded contribution becomes usable for Apply ONLY
 * after the browser verifies the exact ECDSA P-256 assertion attached to that
 * contribution against that anchor:
 *
 *   - the exact canonical contribution and digest;
 *   - the exact branded source identity, serving basis, and target;
 *   - the exact recipe digest and review/session identity;
 *   - the immutable build-time signing key identity;
 *   - issue/expiry times.
 *
 * Verification mints a per-Apply capability. The capability data lives in a
 * module-private WeakMap; the exported class has no public factory and no
 * mutable authorization method. Only the internal verification path can mint a
 * capability, and Phase 5 matches it through a module-private verifier.
 *
 * There is deliberately no global digest trust set and no public key-registration
 * function. A digest alone never authorizes Apply, and a previous verification
 * cannot authorize a later Apply after the signature, expiry, key identity, or
 * context changes.
 */

import { canonicalStringify, sha256Hex } from './usda/digest';
import type { AiBrandedVerification, AiNutrientContribution } from './aiContribution';
import {
  BRANDED_TRUST_ANCHOR_CONFIGURED,
  TRUSTED_BRANDED_SIGNING_KEY_ID,
  TRUSTED_BRANDED_SIGNING_PUBLIC_KEY,
} from './brandedTrustAnchor';

export const BRANDED_ASSERTION_VERSION = 'usda_branded_assertion_v1' as const;

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Stable review identity binding the full session, recipe, and serving basis. */
export function brandedReviewIdentity(
  sessionIdentity: string,
  recipeKey: string,
  servings: number
): string {
  return `review_v1:${sha256Hex(canonicalStringify({
    session_identity: sessionIdentity,
    recipe_key: recipeKey,
    servings,
  }))}`;
}

function brandedPayload(contribution: AiNutrientContribution): Record<string, unknown> {
  const usdaBranded = contribution.usda_branded;
  const brandedWithoutVerification = usdaBranded === undefined
    ? undefined
    : (() => {
        const { verification: _verification, ...rest } = usdaBranded;
        return rest;
      })();
  return {
    line_ref: contribution.line_ref,
    ingredient: contribution.ingredient,
    quantity_basis: contribution.quantity_basis,
    ...(contribution.weight_grams !== undefined ? { weight_grams: contribution.weight_grams } : {}),
    disposition: contribution.disposition,
    exclusion_role: contribution.exclusion_role,
    exclusion_assumption: contribution.exclusion_assumption,
    classification: contribution.classification,
    ...(contribution.source_kind !== undefined ? { source_kind: contribution.source_kind } : {}),
    ...(brandedWithoutVerification !== undefined ? { usda_branded: brandedWithoutVerification } : {}),
    nutrients: contribution.nutrients,
    unknown_nutrients: contribution.unknown_nutrients,
    assumptions: contribution.assumptions,
    confidence: contribution.confidence,
    sources: contribution.sources,
  };
}

/** Canonical digest over the exact contribution values that must be signed. */
export function computeBrandedContributionDigest(contribution: AiNutrientContribution): string {
  return `sha256:${sha256Hex(canonicalStringify(brandedPayload(contribution)))}`;
}

/** Exact payload the server signs and the browser verifies. */
export function brandedAssertionPayload(
  contribution: AiNutrientContribution,
  verification: AiBrandedVerification
): Record<string, unknown> {
  return {
    v: verification.version,
    key_id: verification.key_id,
    line_ref: contribution.line_ref,
    ingredient: contribution.ingredient,
    target: contribution.usda_branded?.target,
    contribution_digest: verification.canonical_digest,
    evidence_id: contribution.usda_branded?.evidence_id,
    fdc_id: contribution.usda_branded?.fdc_id,
    snapshot_digest: contribution.usda_branded?.snapshot_digest,
    recipe_digest: verification.recipe_digest,
    review_identity: verification.review_identity,
    issued_at: verification.issued_at,
    expires_at: verification.expires_at,
  };
}

export interface BrandedAssertionContext {
  readonly recipe_digest: string;
  readonly review_identity: string;
  readonly now?: number;
}

interface AuthenticatedBrandedEntry {
  readonly line_ref: string;
  readonly canonical_digest: string;
  readonly signature: string;
  readonly key_id: string;
  readonly recipe_digest: string;
  readonly review_identity: string;
  readonly issued_at: string;
  readonly expires_at: string;
}

interface BrandedApplyAuthenticationData {
  readonly entries: ReadonlyMap<string, AuthenticatedBrandedEntry>;
  readonly recipeDigest: string;
  readonly reviewIdentity: string;
  readonly publicKey: string;
  readonly keyId: string;
}

const authenticatedCapabilities = new WeakSet<object>();
const capabilityData = new WeakMap<BrandedApplyAuthentication, BrandedApplyAuthenticationData>();
const MINT_TOKEN = Symbol('tkc.branded.apply.capability.mint');

/**
 * A per-Apply proof minted only by `authenticateBrandedContributionsForApply`.
 *
 * The constructor requires a module-private token. The object carries no
 * authorization data or mutable `matches` method; all data lives in a
 * module-private WeakMap. A fabricated instance cannot pass the WeakSet guard.
 */
export class BrandedApplyAuthentication {
  constructor(token: symbol) {
    if (token !== MINT_TOKEN) {
      throw new Error('BrandedApplyAuthentication cannot be constructed outside verification.');
    }
  }
}

/** True only for a capability minted by this module after signature verification. */
export function isBrandedApplyAuthentication(value: unknown): value is BrandedApplyAuthentication {
  return typeof value === 'object' && value !== null && authenticatedCapabilities.has(value);
}

/**
 * Internal matching function. Authorization uses this function, never a method
 * on the capability object, so an own-property method override cannot create
 * authority.
 */
export function brandedApplyAuthenticationMatches(
  authentication: unknown,
  contribution: AiNutrientContribution,
  recipeDigest: string,
  now: number = Date.now(),
): boolean {
  if (!isBrandedApplyAuthentication(authentication)) return false;
  const data = capabilityData.get(authentication);
  if (!data) return false;
  if (data.recipeDigest !== recipeDigest) return false;
  const entry = data.entries.get(contribution.line_ref);
  if (!entry) return false;
  const verification = contribution.usda_branded?.verification;
  if (!verification) return false;
  if (data.publicKey !== TRUSTED_BRANDED_SIGNING_PUBLIC_KEY) return false;
  if (data.keyId !== TRUSTED_BRANDED_SIGNING_KEY_ID) return false;
  if (verification.key_id !== entry.key_id) return false;
  if (verification.key_id !== data.keyId) return false;
  if (verification.signature !== entry.signature) return false;
  if (verification.canonical_digest !== entry.canonical_digest) return false;
  if (verification.recipe_digest !== data.recipeDigest) return false;
  if (verification.review_identity !== data.reviewIdentity) return false;
  if (computeBrandedContributionDigest(contribution) !== entry.canonical_digest) return false;
  const issuedAt = parseTimestamp(entry.issued_at);
  const expiresAt = parseTimestamp(entry.expires_at);
  if (issuedAt === undefined || expiresAt === undefined) return false;
  if (expiresAt <= now) return false;
  if (issuedAt > now + 5 * 60 * 1000) return false;
  if (expiresAt - issuedAt > 15 * 60 * 1000) return false;
  return true;
}

function mintBrandedApplyAuthentication(data: BrandedApplyAuthenticationData): BrandedApplyAuthentication {
  const capability = new BrandedApplyAuthentication(MINT_TOKEN);
  capabilityData.set(capability, Object.freeze({ ...data }));
  authenticatedCapabilities.add(capability);
  return capability;
}

/**
 * Verifies the server signature and exact context of one attached assertion.
 * This function is pure: it neither stores nor marks anything.
 */
export async function verifyBrandedAssertion(
  contribution: AiNutrientContribution,
  verification: AiBrandedVerification | undefined,
  context: BrandedAssertionContext,
): Promise<boolean> {
  if (!BRANDED_TRUST_ANCHOR_CONFIGURED || TRUSTED_BRANDED_SIGNING_PUBLIC_KEY === null || TRUSTED_BRANDED_SIGNING_KEY_ID === null) {
    return false;
  }
  if (!verification) return false;
  if (verification.version !== BRANDED_ASSERTION_VERSION) return false;
  if (verification.key_id !== TRUSTED_BRANDED_SIGNING_KEY_ID) return false;
  if (verification.recipe_digest !== context.recipe_digest) return false;
  if (verification.review_identity !== context.review_identity) return false;
  if (verification.canonical_digest !== computeBrandedContributionDigest(contribution)) return false;
  const evidenceId = contribution.usda_branded?.evidence_id;
  if (typeof evidenceId !== 'string' || evidenceId.length < 8) return false;
  const issuedAt = parseTimestamp(verification.issued_at);
  const expiresAt = parseTimestamp(verification.expires_at);
  if (issuedAt === undefined || expiresAt === undefined) return false;
  const now = context.now ?? Date.now();
  if (expiresAt <= now) return false;
  if (issuedAt > now + 5 * 60 * 1000) return false;
  if (expiresAt - issuedAt > 15 * 60 * 1000) return false;
  if (typeof verification.signature !== 'string' || verification.signature.length < 40 || verification.signature.length > 4096) {
    return false;
  }
  let signature: Uint8Array;
  let keyBytes: Uint8Array;
  try {
    signature = base64ToBytes(verification.signature);
    keyBytes = base64ToBytes(TRUSTED_BRANDED_SIGNING_PUBLIC_KEY);
  } catch {
    return false;
  }
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return false;
    const key = await subtle.importKey(
      'spki',
      keyBytes as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const payloadBytes = new TextEncoder().encode(canonicalStringify(brandedAssertionPayload(contribution, verification)));
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature as BufferSource,
      payloadBytes as BufferSource,
    );
  } catch {
    return false;
  }
}

export type BrandedApplyAuthenticationResult =
  | { readonly ok: true; readonly authentication: BrandedApplyAuthentication }
  | { readonly ok: false; readonly code: 'branded_evidence_untrusted' };

/**
 * Authenticates every branded contribution in a structurally validated Apply
 * candidate. The returned capability is consumed by the synchronous Phase 5
 * authorization in the SAME Apply operation. It is not a session cache.
 */
export async function authenticateBrandedContributionsForApply(
  contributions: ReadonlyArray<AiNutrientContribution>,
  context: BrandedAssertionContext,
): Promise<BrandedApplyAuthenticationResult> {
  if (
    !BRANDED_TRUST_ANCHOR_CONFIGURED ||
    TRUSTED_BRANDED_SIGNING_PUBLIC_KEY === null ||
    TRUSTED_BRANDED_SIGNING_KEY_ID === null
  ) {
    return { ok: false, code: 'branded_evidence_untrusted' };
  }
  const entries = new Map<string, AuthenticatedBrandedEntry>();
  for (const contribution of contributions) {
    if (contribution.source_kind !== 'usda_branded') continue;
    const verification = contribution.usda_branded?.verification;
    if (!verification) return { ok: false, code: 'branded_evidence_untrusted' };
    if (entries.has(contribution.line_ref)) return { ok: false, code: 'branded_evidence_untrusted' };
    const verified = await verifyBrandedAssertion(contribution, verification, context);
    if (!verified) return { ok: false, code: 'branded_evidence_untrusted' };
    entries.set(contribution.line_ref, Object.freeze({
      line_ref: contribution.line_ref,
      canonical_digest: verification.canonical_digest,
      signature: verification.signature,
      key_id: verification.key_id,
      recipe_digest: verification.recipe_digest,
      review_identity: verification.review_identity,
      issued_at: verification.issued_at,
      expires_at: verification.expires_at,
    }));
  }
  return {
    ok: true,
    authentication: mintBrandedApplyAuthentication({
      entries,
      recipeDigest: context.recipe_digest,
      reviewIdentity: context.review_identity,
      publicKey: TRUSTED_BRANDED_SIGNING_PUBLIC_KEY,
      keyId: TRUSTED_BRANDED_SIGNING_KEY_ID,
    }),
  };
}

/**
 * Test compatibility only. The trust anchor is a build-time constant and there
 * is no runtime registration or reset that can create authority.
 */
export function resetBrandedEvidenceTrustForTests(): void {
  // Intentionally empty.
}
