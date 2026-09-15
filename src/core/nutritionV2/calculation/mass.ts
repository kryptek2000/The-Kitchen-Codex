/**
 * The Kitchen Codex — Advanced Nutrition Phase 3: mass and portion resolution.
 *
 * PURE. Only two mass sources are allowed: `direct_mass` (the existing
 * deterministic g/kg/oz/lb conversion) and `source_portion` (an explicitly
 * reviewed portion of the selected canonical USDA record). No density, no count
 * weight, no invented portion amount, no volume-as-mass.
 *
 * Portion authority comes from reconstructing the selection against the current
 * canonical record (not from the unkeyed digest, which only provides snapshot
 * integrity).
 */

import { canonicalStringify, sha256Hex } from '../usda/digest';
import type { CanonicalUsdaFoodRecord } from '../usda/types';
import {
  CALCULATION_VERSION,
  MAX_CALCULATION_GRAMS,
  type PortionCandidate,
  type PortionReview,
  type PortionSelection,
} from './types';

/** Bounded canonical portion candidates for one matched food. */
export function portionCandidates(record: CanonicalUsdaFoodRecord): ReadonlyArray<PortionCandidate> {
  return Object.freeze(
    record.portions.map((portion, index) =>
      Object.freeze({
        index,
        measure: portion.measure,
        ...(portion.amount !== undefined ? { amount: portion.amount } : {}),
        gram_weight: portion.gram_weight,
        ...(portion.modifier !== undefined ? { modifier: portion.modifier } : {}),
        ...(portion.sequence !== undefined ? { sequence: portion.sequence } : {}),
      })
    )
  );
}

/** Deterministic digest binding the current record's portion candidate set. */
export function computePortionCandidatesDigest(
  record: CanonicalUsdaFoodRecord,
  candidates: ReadonlyArray<PortionCandidate>
): string {
  return sha256Hex(
    canonicalStringify({
      calculation_version: CALCULATION_VERSION,
      fdc_id: record.fdc_id,
      record_digest: record.record_digest,
      candidates,
    })
  );
}

/** Pure portion-review result listing canonical candidates for the matched food. */
export function buildPortionReview(
  record: CanonicalUsdaFoodRecord,
  bundleRelease: string
): PortionReview {
  const candidates = portionCandidates(record);
  return Object.freeze({
    calculation_version: CALCULATION_VERSION,
    bundle_release: bundleRelease,
    fdc_id: record.fdc_id,
    record_digest: record.record_digest,
    candidates,
    candidates_digest: computePortionCandidatesDigest(record, candidates),
  });
}

export type PortionMassResolution =
  | { ok: true; grams: number }
  | { ok: false; reason: 'stale' | 'no_amount' | 'overflow' };

/**
 * Resolves a source-portion mass: `ingredientAmount / portionAmount × gramWeight`
 * — only when the selection is reconstructed exactly against the current record
 * and every input is present, valid, positive, and bounded. Otherwise it fails
 * closed (`stale` / `no_amount` / `overflow`).
 */
export function resolvePortionMassGrams(
  record: CanonicalUsdaFoodRecord,
  selection: PortionSelection,
  ingredientAmount: number,
  bundleRelease: string,
  lineRef: string,
  identityDigest: string
): PortionMassResolution {
  if (
    selection.calculation_version !== CALCULATION_VERSION ||
    selection.line_ref !== lineRef ||
    selection.ingredient_identity_digest !== identityDigest ||
    selection.bundle_release !== bundleRelease ||
    selection.fdc_id !== record.fdc_id ||
    selection.record_digest !== record.record_digest
  ) {
    return { ok: false, reason: 'stale' };
  }

  const candidates = portionCandidates(record);
  if (selection.candidates_digest !== computePortionCandidatesDigest(record, candidates)) {
    return { ok: false, reason: 'stale' };
  }

  const portion = record.portions[selection.portion_index];
  if (!portion) return { ok: false, reason: 'stale' };
  if (selection.measure !== portion.measure) return { ok: false, reason: 'stale' };
  if (selection.gram_weight !== portion.gram_weight) return { ok: false, reason: 'stale' };
  if ((selection.modifier ?? undefined) !== (portion.modifier ?? undefined)) {
    return { ok: false, reason: 'stale' };
  }
  if (portion.amount === undefined || !(portion.amount > 0) || !Number.isFinite(portion.amount)) {
    return { ok: false, reason: 'no_amount' };
  }
  if (selection.portion_amount !== portion.amount) return { ok: false, reason: 'stale' };

  if (!Number.isFinite(ingredientAmount) || ingredientAmount < 0 || Object.is(ingredientAmount, -0)) {
    return { ok: false, reason: 'stale' };
  }

  const grams = (ingredientAmount / portion.amount) * portion.gram_weight;
  if (!Number.isFinite(grams) || grams < 0 || Object.is(grams, -0)) {
    return { ok: false, reason: 'overflow' };
  }
  if (grams > MAX_CALCULATION_GRAMS) return { ok: false, reason: 'overflow' };
  return { ok: true, grams };
}
