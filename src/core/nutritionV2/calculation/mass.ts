/**
 * The Kitchen Codex — Advanced Nutrition Phase 3/4.5C: mass and portion resolution.
 *
 * PURE. Mass may be derived only from:
 *   1. `direct_mass`    — a recognized recipe mass unit (g/kg/oz/lb).
 *   2. `source_portion` — an explicitly selected canonical USDA portion whose
 *                         dimension is COMPATIBLE with the recipe measurement
 *                         (volume↔volume scaled by exact canonical volume, or
 *                         mass↔mass). No density, count-weight, or invented
 *                         amount is ever used.
 *   3. `user_mass`      — an explicitly entered total ingredient-line weight.
 *
 * Portion authority comes from reconstructing the selection against the current
 * canonical record and independently recomputing the canonical portion semantics
 * (never trusting caller-supplied normalized amounts, units, volumes, labels, or
 * gram weights).
 */

import { canonicalStringify, sha256Hex } from '../usda/digest';
import type { CanonicalUsdaFoodRecord } from '../usda/types';
import {
  CALCULATION_VERSION,
  MAX_CALCULATION_GRAMS,
  type PortionCandidate,
  type PortionReview,
  type PortionSelection,
  type UserMassSelection,
} from './types';
import {
  normalizePortionSemantics,
  portionCompatibility,
  resolvePortionMassFromSemantics,
  PORTION_SEMANTICS_VERSION,
  type PortionMeasurement,
} from './portionSemantics';
import { convertMassToGrams, type NormalizedUnit } from '../../../utils/measurements';

/** Bounded canonical portion candidates for one matched food. */
export function portionCandidates(record: CanonicalUsdaFoodRecord): ReadonlyArray<PortionCandidate> {
  return Object.freeze(
    record.portions.map((portion, index) => {
      const normalized = normalizePortionSemantics(portion, index);
      return Object.freeze({
        index,
        measure: portion.measure,
        ...(portion.amount !== undefined ? { amount: portion.amount } : {}),
        gram_weight: portion.gram_weight,
        ...(portion.modifier !== undefined ? { modifier: portion.modifier } : {}),
        ...(portion.sequence !== undefined ? { sequence: portion.sequence } : {}),
        semantics_version: normalized.semantics_version,
        kind: normalized.kind,
        unit: normalized.unit,
        effective_amount: normalized.amount,
        volume_ml: normalized.volume_ml,
        amount_source: normalized.amount_source,
        descriptor: normalized.descriptor,
        display_label: normalized.display_label,
      });
    })
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
      portion_semantics_version: PORTION_SEMANTICS_VERSION,
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
    portion_semantics_version: PORTION_SEMANTICS_VERSION,
    bundle_release: bundleRelease,
    fdc_id: record.fdc_id,
    record_digest: record.record_digest,
    candidates,
    candidates_digest: computePortionCandidatesDigest(record, candidates),
  });
}

export type PortionMassResolution =
  | { ok: true; grams: number }
  | { ok: false; reason: 'stale' | 'no_amount' | 'incompatible' | 'overflow' };

/**
 * Resolves a source-portion mass only when the selection is reconstructed
 * exactly against the current record, the recomputed canonical semantics match
 * the selection binding, and the portion dimension is COMPATIBLE with the
 * recipe measurement. Otherwise it fails closed.
 */
export function resolvePortionMassGrams(
  record: CanonicalUsdaFoodRecord,
  selection: PortionSelection,
  measurement: PortionMeasurement,
  bundleRelease: string,
  lineRef: string,
  identityDigest: string
): PortionMassResolution {
  if (
    selection.calculation_version !== CALCULATION_VERSION ||
    selection.portion_semantics_version !== PORTION_SEMANTICS_VERSION ||
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

  const normalized = normalizePortionSemantics(portion, selection.portion_index);
  if (normalized.kind === 'unusable' || normalized.amount === null || normalized.gram_weight === null) {
    return { ok: false, reason: 'no_amount' };
  }
  if (
    selection.semantics_kind !== normalized.kind ||
    selection.semantics_unit !== normalized.unit ||
    selection.semantics_volume_ml !== normalized.volume_ml ||
    selection.semantics_amount !== normalized.amount ||
    selection.semantics_gram_weight !== normalized.gram_weight ||
    selection.portion_amount !== normalized.amount
  ) {
    return { ok: false, reason: 'stale' };
  }

  if (portionCompatibility(normalized, measurement.kind) !== 'compatible') {
    return { ok: false, reason: 'incompatible' };
  }

  const grams = resolvePortionMassFromSemantics(normalized, measurement, MAX_CALCULATION_GRAMS);
  if (grams === undefined) return { ok: false, reason: 'overflow' };
  return { ok: true, grams };
}

export type UserMassResolution =
  | { ok: true; grams: number }
  | { ok: false; reason: 'stale' | 'invalid' | 'overflow' };

const USER_MASS_UNITS: ReadonlySet<string> = new Set(['g', 'oz', 'lb']);

/** Recomputed deterministic digest binding a user-mass selection. */
export function computeUserMassSelectionDigest(selection: Omit<UserMassSelection, 'selection_digest'>): string {
  return sha256Hex(canonicalStringify(selection));
}

/**
 * Recomputes a user-entered total-weight selection from authenticated bindings.
 * The caller-supplied `grams` is never trusted; grams are recomputed from
 * `quantity` × `unit`. Fails closed on stale bindings, unsupported units, or
 * invalid/non-finite/overflowing quantities.
 */
export function resolveUserMassGrams(
  selection: UserMassSelection,
  record: CanonicalUsdaFoodRecord,
  bundleRelease: string,
  lineRef: string,
  identityDigest: string
): UserMassResolution {
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
  if (
    typeof selection.quantity !== 'number' ||
    !Number.isFinite(selection.quantity) ||
    selection.quantity <= 0 ||
    Object.is(selection.quantity, -0) ||
    typeof selection.unit !== 'string' ||
    !USER_MASS_UNITS.has(selection.unit)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const grams = convertMassToGrams(selection.quantity, selection.unit as NormalizedUnit);
  if (grams === undefined || !Number.isFinite(grams) || grams <= 0 || Object.is(grams, -0)) {
    return { ok: false, reason: 'invalid' };
  }
  if (grams > MAX_CALCULATION_GRAMS) return { ok: false, reason: 'overflow' };
  const expected = computeUserMassSelectionDigest({
    calculation_version: selection.calculation_version,
    line_ref: selection.line_ref,
    ingredient_identity_digest: selection.ingredient_identity_digest,
    bundle_release: selection.bundle_release,
    fdc_id: selection.fdc_id,
    record_digest: selection.record_digest,
    quantity: selection.quantity,
    unit: selection.unit,
    grams,
  });
  if (selection.selection_digest !== expected) return { ok: false, reason: 'stale' };
  if (selection.grams !== grams) return { ok: false, reason: 'stale' };
  return { ok: true, grams };
}
