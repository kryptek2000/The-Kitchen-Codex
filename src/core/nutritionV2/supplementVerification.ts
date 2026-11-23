/**
 * SINC-4R2 — trusted verification of persisted supplemental nutrients.
 *
 * PURE, offline. This module is the boundary between parsing a saved v6 block
 * and activating its supplemental estimates. Persisted `source_nutrients` /
 * `source_amounts` are recovery metadata, not proof. A supplement is verified
 * ONLY against the genuine source-backed preview re-derived from the pinned
 * USDA session/catalog.
 */

import type { AdvisoryNutritionPreview } from './calculation/types';
import {
  validateAiNutrientSupplements,
  type AiNutrientSupplement,
  type NutrientSupplementSourceBinding,
} from './aiContribution';

export type SupplementQuarantineReason =
  | 'source_unavailable'
  | 'source_conflict'
  | 'source_mismatch'
  | 'duplicate'
  | 'invalid';

export interface QuarantinedSupplement {
  readonly supplement: AiNutrientSupplement;
  readonly reason: SupplementQuarantineReason;
  /** Bounded validator code, when available. */
  readonly code?: string;
}

export interface SupplementVerification {
  readonly verified: ReadonlyArray<AiNutrientSupplement>;
  readonly quarantined: ReadonlyArray<QuarantinedSupplement>;
  /**
   * `authoritative_preview` only when a genuine source-backed preview was
   * available and evaluated. `unavailable` means no supplement can be
   * activated from this block.
   */
  readonly evidence: 'authoritative_preview' | 'unavailable';
}

function bindingForPreview(preview: AdvisoryNutritionPreview): ReadonlyMap<string, NutrientSupplementSourceBinding> {
  const sourcesByRef = new Map<string, NutrientSupplementSourceBinding>();
  for (const entry of preview.ingredients) {
    if (entry.outcome !== 'calculated' || entry.fdc_id === undefined) continue;
    // A supplement may bind only to a USDA source-backed line, never to a line
    // whose mass came from an AI estimate.
    if (entry.mass_source === 'ai_estimate') continue;
    sourcesByRef.set(entry.line_ref, {
      nutrient_ids: entry.contributing_nutrients,
      source_food_id: String(entry.fdc_id),
      source_release: preview.bundle_release,
      ...(entry.resolved_grams !== undefined ? { weight_grams: entry.resolved_grams } : {}),
    });
  }
  return sourcesByRef;
}

function quarantineReason(code: string | undefined): SupplementQuarantineReason {
  if (code === 'source_already_has_nutrient') return 'source_conflict';
  if (
    code === 'unknown_line_ref' ||
    code === 'source_identity_mismatch' ||
    code === 'source_release_mismatch' ||
    code === 'weight_mismatch' ||
    code === 'missing_weight' ||
    code === 'line_text_mismatch' ||
    code === 'stale_recipe'
  ) {
    return 'source_mismatch';
  }
  return 'invalid';
}

/**
 * Verifies each persisted supplement against the genuine source-backed preview.
 * The preview MUST come from the pinned USDA session/catalog, never from saved
 * metadata. Each supplement is evaluated independently so one conflict does not
 * discard the rest of a legitimate review.
 */
export function verifySupplementsAgainstPreview(
  supplements: ReadonlyArray<AiNutrientSupplement>,
  preview: AdvisoryNutritionPreview | null,
  lineTextByRef: Readonly<Record<string, string>>,
  /**
   * Persisted block digest. This is a structural binding, not source evidence;
   * the source identity, release, weight, and nutrient conflict are verified
   * against the genuine preview above.
   */
  recipeDigest: string,
): SupplementVerification {
  if (preview === null) {
    return Object.freeze({
      verified: Object.freeze([]),
      quarantined: Object.freeze(supplements.map((supplement) => Object.freeze({
        supplement,
        reason: 'source_unavailable' as const,
      }))),
      evidence: 'unavailable' as const,
    });
  }
  const sourcesByRef = bindingForPreview(preview);
  const verified: AiNutrientSupplement[] = [];
  const quarantined: QuarantinedSupplement[] = [];
  const seen = new Set<string>();
  for (const supplement of supplements) {
    if (!sourcesByRef.has(supplement.line_ref)) {
      quarantined.push(Object.freeze({ supplement, reason: 'source_unavailable' as const }));
      continue;
    }
    const validated = validateAiNutrientSupplements([supplement], {
      recipe_digest: recipeDigest,
      line_text_by_ref: lineTextByRef,
      sources_by_ref: sourcesByRef,
    });
    if (!validated.ok) {
      const code = (validated as { code?: string }).code;
      quarantined.push(Object.freeze({
        supplement,
        reason: quarantineReason(code),
        ...(code !== undefined ? { code } : {}),
      }));
      continue;
    }
    const key = `${supplement.line_ref}\u0000${supplement.nutrient_id}`;
    if (seen.has(key)) {
      quarantined.push(Object.freeze({
        supplement,
        reason: 'duplicate' as const,
        code: 'duplicate_supplement',
      }));
      continue;
    }
    seen.add(key);
    verified.push(validated.supplements[0]!);
  }
  return Object.freeze({
    verified: Object.freeze(verified),
    quarantined: Object.freeze(quarantined),
    evidence: 'authoritative_preview' as const,
  });
}
