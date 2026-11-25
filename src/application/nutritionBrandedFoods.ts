/**
 * The Kitchen Codex — application transport for the explicit USDA Branded Foods
 * lookup (SINC-2).
 *
 * The browser sends ONLY the selected food term and an opaque line reference.
 * It never sends the recipe, the Vault, or the recipe quantity. Every returned
 * candidate is revalidated and digest-checked against the core branded-food
 * contract before the UI may display or use it.
 *
 * Nothing here selects, applies, or persists a product. Selection and acceptance
 * remain explicit user actions in the existing Advanced Nutrition review.
 */

import type { NetworkAdapter } from './adapters/NetworkAdapter';
import {
  sanitizeBrandedLookupResponse,
  USDA_BRANDED_LOOKUP_REQUEST_VERSION,
  USDA_BRANDED_VERIFICATION_REQUEST_VERSION,
  USDA_BRANDED_VERIFICATION_RESPONSE_VERSION,
  type UsdaBrandedFoodCandidate,
} from '../core/nutritionV2/brandedFoods';
import {
  BRANDED_ASSERTION_VERSION,
  computeBrandedContributionDigest,
  verifyBrandedAssertion,
} from '../core/nutritionV2/brandedEvidenceTrust';
import {
  BRANDED_TRUST_ANCHOR_CONFIGURED,
  matchesTrustedSigningAnchor,
} from '../core/nutritionV2/brandedTrustAnchor';
import type { AiBrandedVerification, AiNutrientContribution } from '../core/nutritionV2/aiContribution';

export const USDA_BRANDED_LOOKUP_ENDPOINT = '/api/nutrition/branded-foods/search';
export const USDA_BRANDED_VERIFY_ENDPOINT = '/api/nutrition/branded-foods/verify';

const MAX_RESPONSE_BYTES = 256 * 1024;

export interface BrandedLookupRequestArgs {
  readonly network: NetworkAdapter;
  readonly lineRef: string;
  readonly query: string;
  readonly signal?: AbortSignal;
}

export type NutritionBrandedLookupResult =
  | {
      readonly ok: true;
      readonly candidates: ReadonlyArray<UsdaBrandedFoodCandidate>;
      readonly query: string;
      readonly totalHits: number;
      readonly cacheStatus: 'hit' | 'miss';
      readonly retrievedAt: string;
      readonly limitations: ReadonlyArray<string>;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

function boundedMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 400 && !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : fallback;
}

function failure(code: string, message: string, retryAfterSeconds?: number): NutritionBrandedLookupResult {
  return {
    ok: false,
    code,
    message,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

export async function requestUsdaBrandedFoodLookup(
  args: BrandedLookupRequestArgs
): Promise<NutritionBrandedLookupResult> {
  let response;
  try {
    response = await args.network.post<Record<string, unknown>>(
      USDA_BRANDED_LOOKUP_ENDPOINT,
      {
        request_version: USDA_BRANDED_LOOKUP_REQUEST_VERSION,
        line_ref: args.lineRef,
        query: args.query,
      },
      args.signal !== undefined ? { signal: args.signal } : undefined
    );
  } catch {
    return failure(
      'unavailable',
      'USDA Branded Foods lookup is unavailable. The ingredient remains unresolved.'
    );
  }

  if (!response || response.ok !== true) {
    const code = typeof response?.data?.['code'] === 'string' ? response.data['code'] : 'unavailable';
    const retryAfter = response?.data?.['retryAfterSeconds'];
    switch (code) {
      case 'USDA_BRANDED_LOOKUP_NOT_CONFIGURED':
        return failure(
          'not_configured',
          'USDA Branded Foods lookup is not configured on this server. The ingredient remains unresolved.'
        );
      case 'USDA_BRANDED_LOOKUP_RATE_LIMITED':
        return failure(
          'rate_limited',
          'USDA Branded Foods lookup is temporarily rate limited. Please wait before trying again.',
          typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0
            ? retryAfter
            : undefined
        );
      case 'USDA_BRANDED_LOOKUP_AUTH_FAILED':
        return failure(
          'auth_failed',
          'USDA Branded Foods lookup is not authorized by the server configuration. The ingredient remains unresolved.'
        );
      case 'USDA_BRANDED_LOOKUP_TIMEOUT':
        return failure(
          'timeout',
          'USDA Branded Foods lookup timed out. The ingredient remains unresolved.'
        );
      case 'USDA_BRANDED_LOOKUP_NOT_FOUND':
        return failure(
          'not_found',
          'No USDA Branded Foods record was found for that request. The ingredient remains unresolved.'
        );
      case 'USDA_BRANDED_LOOKUP_INVALID_REQUEST':
        return failure(
          'invalid_request',
          'The USDA Branded Foods request could not be read safely.'
        );
      case 'USDA_BRANDED_LOOKUP_INVALID_RESPONSE':
        return failure(
          'invalid_response',
          'USDA Branded Foods returned an unusable response. The ingredient remains unresolved.'
        );
      default:
        return failure(
          'unavailable',
          'USDA Branded Foods lookup is temporarily unavailable. The ingredient remains unresolved.'
        );
    }
  }

  let serialized = '';
  try {
    serialized = JSON.stringify(response.data ?? null);
  } catch {
    serialized = '';
  }
  if (!serialized || serialized.length > MAX_RESPONSE_BYTES) {
    return failure('invalid_response', 'USDA Branded Foods returned an unusable response.');
  }

  const checked = sanitizeBrandedLookupResponse(response.data, args.lineRef, args.query);
  if (!checked.ok) {
    return failure('invalid_response', 'USDA Branded Foods returned an unusable response.');
  }
  const lookup = checked.response;
  if (!matchesTrustedSigningAnchor(lookup.signing_public_key, lookup.signing_key_id)) {
    return failure(
      'invalid_response',
      'USDA Branded Foods returned a signing identity that does not match the configured trust anchor.'
    );
  }
  const count = lookup.candidates.length;
  return {
    ok: true,
    candidates: lookup.candidates,
    query: lookup.query,
    totalHits: lookup.total_hits,
    cacheStatus: lookup.cache_status,
    retrievedAt: lookup.retrieved_at,
    limitations: lookup.limitations,
    message: count > 0
      ? `${count} USDA Branded Foods candidate${count === 1 ? '' : 's'} ready for review. Nothing is selected or applied automatically.`
      : 'No suitable USDA Branded Foods records were found. The ingredient remains unresolved.',
  };
}


export interface BrandedVerificationArgs {
  readonly network: NetworkAdapter;
  readonly contributions: ReadonlyArray<AiNutrientContribution>;
  readonly recipeDigest: string;
  readonly reviewIdentity: string;
  readonly signal?: AbortSignal;
}

export type BrandedVerificationResult =
  | { readonly ok: true; readonly contributions: ReadonlyArray<AiNutrientContribution> }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Explicit Apply-time server verification. The server recomputes the branded
 * contribution from its own held source snapshot, signs an assertion bound to
 * this exact recipe/review/target, and returns it. The browser verifies the
 * server's ECDSA signature against the immutable build-time trust anchor. A
 * browser-created digest, UUID, registry entry, or capability is never
 * authority.
 */
export async function verifyUsdaBrandedContributionsForApply(
  args: BrandedVerificationArgs
): Promise<BrandedVerificationResult> {
  const branded = args.contributions.filter((entry) => entry.source_kind === 'usda_branded');
  if (branded.length === 0) return { ok: true, contributions: [] };
  if (!BRANDED_TRUST_ANCHOR_CONFIGURED) {
    return {
      ok: false,
      code: 'untrusted',
      message: 'No trusted branded signing identity is configured for this build. Branded Apply is unavailable.',
    };
  }
  const items: Array<Record<string, unknown>> = [];
  for (const contribution of branded) {
    const target = contribution.usda_branded?.target;
    const evidenceId = contribution.usda_branded?.evidence_id;
    if (!target || typeof evidenceId !== 'string' || evidenceId.length < 8) {
      return {
        ok: false,
        code: 'untrusted',
        message: 'The branded evidence is missing its server-held source identity. Search again before applying.',
      };
    }
    items.push({
      evidence_id: evidenceId,
      target: {
        line_ref: contribution.line_ref,
        ingredient_text: contribution.ingredient,
        query: target.query,
        amount: target.amount,
        unit: target.unit,
        measurement_kind: target.measurement_kind,
        ...(target.quantity_grams !== undefined ? { quantity_grams: target.quantity_grams } : {}),
        ...(target.quantity_ml !== undefined ? { quantity_ml: target.quantity_ml } : {}),
      },
      proposed_digest: computeBrandedContributionDigest(contribution),
    });
  }
  let response;
  try {
    response = await args.network.post<Record<string, unknown>>(
      USDA_BRANDED_VERIFY_ENDPOINT,
      {
        request_version: USDA_BRANDED_VERIFICATION_REQUEST_VERSION,
        recipe_digest: args.recipeDigest,
        review_identity: args.reviewIdentity,
        items,
      },
      args.signal !== undefined ? { signal: args.signal } : undefined
    );
  } catch {
    return {
      ok: false,
      code: 'unavailable',
      message: 'USDA Branded evidence could not be re-verified. Nothing was applied.',
    };
  }
  if (!response || response.ok !== true) {
    const code = typeof response?.data?.['code'] === 'string' ? response.data['code'] : 'unavailable';
    if (code === 'USDA_BRANDED_VERIFICATION_NOT_CONFIGURED') {
      return { ok: false, code: 'not_configured', message: 'USDA Branded Foods signing is not configured on this server. Branded Apply is unavailable.' };
    }
    if (code === 'USDA_BRANDED_VERIFICATION_EXPIRED') {
      return { ok: false, code: 'evidence_expired', message: 'The branded source evidence expired. Search again before applying.' };
    }
    if (code === 'USDA_BRANDED_VERIFICATION_EVIDENCE_MISMATCH') {
      return { ok: false, code: 'evidence_mismatch', message: 'The branded evidence changed and was not applied. Review the product again.' };
    }
    if (code === 'USDA_BRANDED_VERIFICATION_UNSUPPORTED_TARGET') {
      return { ok: false, code: 'unsupported_target', message: 'This branded product cannot be scaled for the current ingredient quantity.' };
    }
    if (code === 'USDA_BRANDED_VERIFICATION_INVALID_REQUEST') {
      return { ok: false, code: 'invalid_request', message: 'The branded evidence could not be verified safely. Nothing was applied.' };
    }
    return { ok: false, code: 'unavailable', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
  }
  if (response.data?.['request_version'] !== USDA_BRANDED_VERIFICATION_RESPONSE_VERSION) {
    return { ok: false, code: 'invalid_response', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
  }
  const signingPublicKey = response.data?.['signing_public_key'];
  const signingKeyId = response.data?.['signing_key_id'];
  if (
    typeof signingPublicKey !== 'string' ||
    typeof signingKeyId !== 'string' ||
    !matchesTrustedSigningAnchor(signingPublicKey, signingKeyId)
  ) {
    return {
      ok: false,
      code: 'untrusted',
      message: 'The branded signing identity does not match the configured trust anchor. Search again before applying.',
    };
  }
  const rawItems = response.data?.['items'];
  if (!Array.isArray(rawItems) || rawItems.length !== branded.length) {
    return { ok: false, code: 'invalid_response', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
  }
  const byLine = new Map<string, AiNutrientContribution>();
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return { ok: false, code: 'invalid_response', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
    }
    const item = rawItem as Record<string, unknown>;
    const lineRef = item.line_ref;
    const contributionRaw = item.contribution;
    const verificationRaw = item.verification;
    if (typeof lineRef !== 'string' || !contributionRaw || typeof contributionRaw !== 'object' || Array.isArray(contributionRaw) ||
        !verificationRaw || typeof verificationRaw !== 'object' || Array.isArray(verificationRaw) ||
        byLine.has(lineRef)) {
      return { ok: false, code: 'invalid_response', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
    }
    const original = branded.find((entry) => entry.line_ref === lineRef);
    if (!original) {
      return { ok: false, code: 'invalid_response', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
    }
    const verification = verificationRaw as Record<string, unknown>;
    if (
      verification.version !== BRANDED_ASSERTION_VERSION ||
      typeof verification.key_id !== 'string' ||
      typeof verification.signature !== 'string' ||
      typeof verification.canonical_digest !== 'string' ||
      typeof verification.recipe_digest !== 'string' ||
      typeof verification.review_identity !== 'string' ||
      typeof verification.issued_at !== 'string' ||
      typeof verification.expires_at !== 'string'
    ) {
      return { ok: false, code: 'invalid_response', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
    }
    const serverContribution = contributionRaw as AiNutrientContribution;
    const serverDigest = computeBrandedContributionDigest(serverContribution);
    if (serverDigest !== verification.canonical_digest || serverDigest !== computeBrandedContributionDigest(original)) {
      return { ok: false, code: 'evidence_mismatch', message: 'The branded evidence changed and was not applied. Review the product again.' };
    }
    const assertion = verification as unknown as AiBrandedVerification;
    const verified: AiNutrientContribution = Object.freeze({
      ...serverContribution,
      usda_branded: Object.freeze({
        ...serverContribution.usda_branded,
        verification: assertion,
      }),
    });
    const valid = await verifyBrandedAssertion(verified, assertion, {
      recipe_digest: args.recipeDigest,
      review_identity: args.reviewIdentity,
    });
    if (!valid) {
      return { ok: false, code: 'untrusted', message: 'The branded evidence could not be authenticated. Search again before applying.' };
    }
    byLine.set(lineRef, verified);
  }
  const verifiedContributions: AiNutrientContribution[] = [];
  for (const entry of branded) {
    const verified = byLine.get(entry.line_ref);
    if (!verified) {
      return { ok: false, code: 'invalid_response', message: 'USDA Branded evidence could not be re-verified. Nothing was applied.' };
    }
    verifiedContributions.push(verified);
  }
  return { ok: true, contributions: Object.freeze(verifiedContributions) };
}
