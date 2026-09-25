/**
 * The Kitchen Codex — Advanced Nutrition Phase 0B (Phase 6 extension): ONE
 * effective mass-source decision.
 *
 * PURE, offline, deterministic. This module owns the question every mass
 * consumer must answer identically: given the recipe's own direct mass and the
 * current working-state selections, which SINGLE source is the effective mass
 * authority?
 *
 * Contract (unchanged meanings, one order):
 *   1. A declared direct recipe mass (g/kg/oz/lb) is authoritative.
 *   2. An explicit user-entered total mass is the fallback when no direct mass
 *      exists.
 *   3. An authenticated USDA source portion follows.
 *   4. An authenticated USDA count portion follows.
 *   5. A verified Kitchen Codex household portion (Phase 6) follows.
 *
 * Exclusivity:
 *   - more than one non-direct selection (user mass / source portion / count
 *     portion / household portion) is a CONFLICT and fails closed;
 *   - a direct recipe mass is EXCLUSIVE with EVERY alternate mass choice. A
 *     line that declares its own mass already has complete mass authority, so
 *     any stored alternate choice is a CONFLICT and fails closed — it is never
 *     silently ignored, never displayed as active, and never persisted over the
 *     recipe mass. The UI does not offer alternate mass choices for such a
 *     line, and the core builders refuse to create them; this rule is the
 *     fail-closed backstop for forged, legacy, stale, or hand-built states.
 *
 * It never computes portion grams, never reads canonical records, and never
 * invents a source. The calculator (`calculate.ts`) and the live projection
 * (`phase4/liveRow.ts`) both consume this ONE decision.
 */

export type EffectiveMassConflictReason =
  | 'multiple_sources'
  | 'direct_mass_with_user_mass'
  | 'direct_mass_with_source_portion'
  | 'direct_mass_with_count_portion'
  | 'direct_mass_with_household_portion'
  | 'direct_mass_with_multiple_alternates';

export type EffectiveMassDecision =
  | { readonly kind: 'direct_mass'; readonly grams: number }
  | { readonly kind: 'user_mass' }
  | { readonly kind: 'source_portion' }
  | { readonly kind: 'count_portion' }
  | { readonly kind: 'household_portion' }
  | { readonly kind: 'none' }
  | { readonly kind: 'conflict'; readonly reason: EffectiveMassConflictReason };

export interface EffectiveMassClaims {
  /** The recipe's own declared mass in grams, when the line declares one. */
  readonly directMassGrams: number | undefined;
  readonly hasUserMass: boolean;
  readonly hasSourcePortion: boolean;
  readonly hasCountPortion: boolean;
  /** Verified Kitchen Codex household portion (Phase 6, lowest authority). */
  readonly hasHouseholdPortion: boolean;
}

/**
 * Resolves the ONE effective mass authority for a line. Deterministic and
 * closed; conflicts fail closed rather than silently preferring a source.
 */
export function resolveEffectiveMassDecision(claims: EffectiveMassClaims): EffectiveMassDecision {
  const nonDirectCount =
    (claims.hasUserMass ? 1 : 0) +
    (claims.hasSourcePortion ? 1 : 0) +
    (claims.hasCountPortion ? 1 : 0) +
    (claims.hasHouseholdPortion ? 1 : 0);
  if (claims.directMassGrams === undefined) {
    if (nonDirectCount > 1) {
      return { kind: 'conflict', reason: 'multiple_sources' };
    }
    if (claims.hasUserMass) return { kind: 'user_mass' };
    if (claims.hasSourcePortion) return { kind: 'source_portion' };
    if (claims.hasCountPortion) return { kind: 'count_portion' };
    if (claims.hasHouseholdPortion) return { kind: 'household_portion' };
    return { kind: 'none' };
  }
  // A declared direct recipe mass is exclusive with EVERY alternate choice.
  const alternates = nonDirectCount;
  if (alternates > 1) {
    return { kind: 'conflict', reason: 'direct_mass_with_multiple_alternates' };
  }
  if (claims.hasUserMass) {
    return { kind: 'conflict', reason: 'direct_mass_with_user_mass' };
  }
  if (claims.hasSourcePortion) {
    return { kind: 'conflict', reason: 'direct_mass_with_source_portion' };
  }
  if (claims.hasCountPortion) {
    return { kind: 'conflict', reason: 'direct_mass_with_count_portion' };
  }
  if (claims.hasHouseholdPortion) {
    return { kind: 'conflict', reason: 'direct_mass_with_household_portion' };
  }
  return { kind: 'direct_mass', grams: claims.directMassGrams };
}
