/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5D: home-recipe catalog
 * eligibility policy.
 *
 * PURE, CLOSED, source-controlled, offline. This module is the ONE authority for
 * deciding whether an already-authenticated canonical USDA record is available
 * to the home-recipe ingredient matcher.
 *
 * TRUST ORDER (enforced by the caller, not here)
 * ----------------------------------------------
 * Eligibility is applied ONLY after the complete source artifact has passed
 * manifest validation, every canonical-record validation, the canonical record
 * count, the canonical content digest, the bundle release binding, the nutrient
 * map version binding, and the component release binding. A damaged, incomplete,
 * or forged artifact can never be made to look valid by this filter.
 *
 * POLICY
 * ------
 *   - every record whose exact canonical food category is `Fast Foods` or
 *     `Restaurant Foods` is excluded;
 *   - restaurant-chain-specific records outside those categories are excluded
 *     through a closed, source-controlled set of normalized chain markers
 *     derived from the complete pinned-bundle census;
 *   - restaurant-context descriptors (`restaurant`, `fast food`) are excluded;
 *   - retail grocery brands an ordinary consumer can buy remain ELIGIBLE. The
 *     policy never keys on uppercase text, apostrophes, or an open-ended
 *     heuristic.
 *
 * No caller input, environment variable, browser storage, network data, or
 * runtime configuration can alter this policy.
 */

import { canonicalStringify, sha256Hex } from '../usda/digest';
import { normalizeQuery } from './normalize';

/** Explicit eligibility-policy version (bound into catalog identity). */
export const ELIGIBILITY_POLICY_VERSION = 'usda_home_recipe_eligibility_v1';

export type EligibilityExclusionReason =
  | 'fast_food_category'
  | 'restaurant_food_category'
  | 'restaurant_chain_marker'
  | 'restaurant_context_marker';

/** Exact canonical food categories excluded in full. */
export const EXCLUDED_FOOD_CATEGORIES: ReadonlyArray<string> = Object.freeze([
  'Fast Foods',
  'Restaurant Foods',
]);

/**
 * Closed, source-controlled restaurant-chain markers derived from the complete
 * pinned-bundle census. Matched on the normalized description; the final marker
 * token may be a prefix of a description token (so `mcdonald` matches
 * `mcdonalds`).
 */
export const RESTAURANT_CHAIN_MARKERS: ReadonlyArray<string> = Object.freeze([
  'applebee',
  'arby',
  'burger king',
  'carrabba',
  'chick fil a',
  'cracker barrel',
  'denny',
  'domino',
  'kfc',
  'little caesars',
  'mcdonald',
  'olive garden',
  'on the border',
  'papa john',
  'pizza hut',
  'popeyes',
  'subway',
  't g i friday',
  'taco bell',
  'wendy',
]);

/**
 * Closed restaurant-CONTEXT descriptors. These are not chain names; they mark a
 * record as a restaurant/fast-food preparation rather than a home ingredient.
 */
export const RESTAURANT_CONTEXT_MARKERS: ReadonlyArray<string> = Object.freeze([
  'fast food',
  'restaurant',
]);

const CHAIN_MARKER_TOKENS: ReadonlyArray<ReadonlyArray<string>> = RESTAURANT_CHAIN_MARKERS.map((m) =>
  Object.freeze(m.split(' '))
);
const CONTEXT_MARKER_TOKENS: ReadonlyArray<ReadonlyArray<string>> = RESTAURANT_CONTEXT_MARKERS.map((m) =>
  Object.freeze(m.split(' '))
);
const CATEGORY_SET: ReadonlySet<string> = new Set(EXCLUDED_FOOD_CATEGORIES);

export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly reason: EligibilityExclusionReason | null;
  /** The normalized marker that caused a marker exclusion, else null. */
  readonly marker: string | null;
}

/** Normalizes a description for marker matching (same contract as matching). */
export function normalizeEligibilityDescription(description: string): string {
  return normalizeQuery(description).text;
}

function tokensMatchMarker(
  descriptionTokens: ReadonlyArray<string>,
  markerTokens: ReadonlyArray<string>
): boolean {
  if (markerTokens.length === 0 || descriptionTokens.length < markerTokens.length) return false;
  for (let i = 0; i + markerTokens.length <= descriptionTokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < markerTokens.length; j += 1) {
      const descriptionToken = descriptionTokens[i + j];
      const markerToken = markerTokens[j];
      const isLast = j === markerTokens.length - 1;
      if (descriptionToken === markerToken) continue;
      // The final marker token may be a prefix of the description token so that
      // possessives (`mcdonald` vs `mcdonalds`) are caught.
      if (isLast && descriptionToken.startsWith(markerToken)) continue;
      ok = false;
      break;
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Evaluates one authenticated canonical record against the closed home-recipe
 * eligibility policy. Pure and deterministic.
 */
export function evaluateEligibility(record: {
  readonly food_category?: string;
  readonly description: string;
}): EligibilityDecision {
  const category = record.food_category;
  if (typeof category === 'string') {
    if (category === 'Fast Foods') {
      return Object.freeze({ eligible: false, reason: 'fast_food_category', marker: null });
    }
    if (category === 'Restaurant Foods') {
      return Object.freeze({ eligible: false, reason: 'restaurant_food_category', marker: null });
    }
  }

  const normalized = normalizeEligibilityDescription(record.description);
  const descriptionTokens = normalized.length === 0 ? [] : normalized.split(' ');
  for (const markerTokens of CHAIN_MARKER_TOKENS) {
    if (tokensMatchMarker(descriptionTokens, markerTokens)) {
      return Object.freeze({
        eligible: false,
        reason: 'restaurant_chain_marker',
        marker: markerTokens.join(' '),
      });
    }
  }
  for (const markerTokens of CONTEXT_MARKER_TOKENS) {
    if (tokensMatchMarker(descriptionTokens, markerTokens)) {
      return Object.freeze({
        eligible: false,
        reason: 'restaurant_context_marker',
        marker: markerTokens.join(' '),
      });
    }
  }

  return Object.freeze({ eligible: true, reason: null, marker: null });
}

/** True when an exact canonical food category is excluded in full. */
export function isExcludedCategory(category: unknown): boolean {
  return typeof category === 'string' && CATEGORY_SET.has(category);
}

/**
 * Deterministic digest of the eligibility POLICY (not of any record). Binds the
 * version, the excluded categories, and the ordered marker sets.
 */
export function computeEligibilityPolicyDigest(): string {
  return sha256Hex(
    canonicalStringify({
      version: ELIGIBILITY_POLICY_VERSION,
      categories: [...EXCLUDED_FOOD_CATEGORIES].sort(),
      chain_markers: [...RESTAURANT_CHAIN_MARKERS].sort(),
      context_markers: [...RESTAURANT_CONTEXT_MARKERS].sort(),
    })
  );
}
