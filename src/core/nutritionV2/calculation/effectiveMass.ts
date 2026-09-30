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
 *   6. A BOUNDED AI mass estimate (AI-3) follows -- the lowest authority.
 *
 * AI ESTIMATE (AI-3): an estimate is a NON-DIRECT claim. It is therefore
 * mutually exclusive with every other source by the rules below: an estimate
 * alongside any stronger or user-explicit source is a CONFLICT, never a silent
 * preference, so a stronger source that appears later always wins.
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
  | 'direct_mass_with_ai_estimate'
  | 'direct_mass_with_multiple_alternates'
  | 'ai_estimate_with_stronger_source';

export type EffectiveMassDecision =
  | { readonly kind: 'direct_mass'; readonly grams: number }
  | { readonly kind: 'user_mass' }
  | { readonly kind: 'source_portion' }
  | { readonly kind: 'count_portion' }
  | { readonly kind: 'household_portion' }
  /** BOUNDED AI MASS ESTIMATE (AI-3). The LOWEST mass authority in the system. */
  | { readonly kind: 'ai_estimate' }
  | { readonly kind: 'none' }
  | { readonly kind: 'conflict'; readonly reason: EffectiveMassConflictReason };

export interface EffectiveMassClaims {
  /** The recipe's own declared mass in grams, when the line declares one. */
  readonly directMassGrams: number | undefined;
  readonly hasUserMass: boolean;
  readonly hasSourcePortion: boolean;
  readonly hasCountPortion: boolean;
  /** Verified Kitchen Codex household portion (Phase 6). */
  readonly hasHouseholdPortion: boolean;
  /**
   * A BOUNDED AI mass estimate (AI-3), the LOWEST mass authority: below direct
   * mass, user mass, USDA source portion, USDA count portion and the verified
   * household portion. It participates in the existing conflict rules rather
   * than bypassing them, so a stronger or user-explicit source that appears
   * later always wins and the estimate is refused. Absent/undefined means
   * "no estimate", which preserves every pre-AI-3 outcome exactly.
   */
  readonly hasAiEstimate?: boolean;
}

/**
 * Resolves the ONE effective mass authority for a line. Deterministic and
 * closed; conflicts fail closed rather than silently preferring a source.
 */
export function resolveEffectiveMassDecision(claims: EffectiveMassClaims): EffectiveMassDecision {
  // The AI estimate is a NON-DIRECT claim, so it joins the existing conflict
  // arithmetic instead of bypassing it. With `hasAiEstimate` false (the
  // pre-AI-3 case) every count below is identical to the historic behaviour.
  const hasAiEstimate = claims.hasAiEstimate === true;
  const nonDirectCount =
    (claims.hasUserMass ? 1 : 0) +
    (claims.hasSourcePortion ? 1 : 0) +
    (claims.hasCountPortion ? 1 : 0) +
    (claims.hasHouseholdPortion ? 1 : 0) +
    (hasAiEstimate ? 1 : 0);
  if (claims.directMassGrams === undefined) {
    if (nonDirectCount > 1) {
      // An estimate mixed with a stronger source is named explicitly so the
      // caller can report "a stronger source exists"; every other combination
      // keeps its historic reason.
      return hasAiEstimate && nonDirectCount === 2
        ? { kind: 'conflict', reason: 'ai_estimate_with_stronger_source' }
        : { kind: 'conflict', reason: 'multiple_sources' };
    }
    if (claims.hasUserMass) return { kind: 'user_mass' };
    if (claims.hasSourcePortion) return { kind: 'source_portion' };
    if (claims.hasCountPortion) return { kind: 'count_portion' };
    if (claims.hasHouseholdPortion) return { kind: 'household_portion' };
    if (hasAiEstimate) return { kind: 'ai_estimate' };
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
  if (hasAiEstimate) {
    return { kind: 'conflict', reason: 'direct_mass_with_ai_estimate' };
  }
  return { kind: 'direct_mass', grams: claims.directMassGrams };
}
