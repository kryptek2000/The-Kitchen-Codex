/**
 * The Kitchen Codex — AI Advanced Nutrition: deterministic source observations
 * (AI-1).
 *
 * PURE, offline, provider-free. This module builds the
 * `AiAdvancedAuthoritativeAmountObservation` evidence the canonical
 * reconciliation consumes, FROM the genuine deterministic parse/state of the
 * recipe's own ingredient lines — never from provider output. The AI is never
 * asked for (and can never contribute to) this map: it is constructed before any
 * provider call and is what an AI amount interpretation is reconciled AGAINST.
 *
 * WHY IT LIVES HERE (and not in the public barrel): the projection is bound to
 * the deterministic Phase 1/Phase 4 structures, exactly like the Phase 4 barrel
 * (`./phase4`), which `index.ts` intentionally does not re-export.
 *
 * BOUNDARY: this module NEVER imports the Phase 2 matching module. The authored
 * measurement is read through the audited Phase 4 review/display boundary
 * (`phase4/rows.ingredientMeasurement`), which is the ONE allowed reader of the
 * frozen parser. Reusing that existing projection is also what the AI-1 spec
 * requires ("reuse the already adapted ingredient/parser structures rather than
 * reparsing a different way"): the AI never sees a second parser.
 */

import { ingredientMeasurement } from './phase4/rows';
import type { AdaptedIngredient, Phase4Row } from './phase4/types';
import type { AiAdvancedAuthoritativeAmountObservation } from './aiAdvanced';

/**
 * Projects ONE adapted ingredient into the canonical authoritative observation.
 *
 * Every field is derived deterministically:
 *  - `quantity_kind` is the canonical Phase 1 quantity classification
 *    (`exact` / `range` / `absent` / `invalid`);
 *  - `amount` carries the authored scalar ONLY for an exact quantity (a true
 *    authored range never collapses to one endpoint);
 *  - `quantity_range` carries the authored endpoints of a range;
 *  - `measurement_kind` is the canonical measurement class;
 *  - `mass_range` + `representative_grams` are populated ONLY from the
 *    documented written-MASS-range midpoint policy, so an exact scalar mass is
 *    always distinguishable from a range midpoint.
 *
 * A line that does not parse is reported as `invalid` with no amount, so an AI
 * echo can never be admitted for it.
 */
export function sourceAmountObservation(
  entry: AdaptedIngredient
): AiAdvancedAuthoritativeAmountObservation {
  const measurement = ingredientMeasurement(entry);
  if (measurement.quantity_kind === 'invalid') {
    return Object.freeze({
      quantity_kind: 'invalid' as const,
      amount: null,
      measurement_kind: 'unknown' as const,
    });
  }
  const representative = measurement.range_representative;
  const quantityRange = measurement.quantity_range;
  const massRange =
    representative !== undefined
      ? Object.freeze({ lower: representative.lower, upper: representative.upper })
      : null;
  return Object.freeze({
    quantity_kind: measurement.quantity_kind,
    amount: measurement.quantity_kind === 'exact' ? measurement.amount : null,
    ...(quantityRange !== undefined
      ? { quantity_range: Object.freeze({ lower: quantityRange.lower, upper: quantityRange.upper }) }
      : {}),
    measurement_kind: measurement.measurement_kind,
    ...(massRange !== null ? { mass_range: massRange } : {}),
    ...(representative !== undefined && typeof measurement.grams === 'number'
      ? { representative_grams: measurement.grams }
      : {}),
  });
}

/**
 * Builds the bounded `authoritativeByLineRef` map for the rows a request may
 * cover. Only rows that have a matching adapted ingredient are observed: a line
 * with no deterministic evidence simply has no entry, and a provider echo for it
 * can never be confirmed.
 */
export function buildAuthoritativeAmountObservations(input: {
  readonly rows: ReadonlyArray<Phase4Row>;
  readonly adapted: ReadonlyArray<AdaptedIngredient>;
}): ReadonlyMap<string, AiAdvancedAuthoritativeAmountObservation> {
  const adaptedByLineRef = new Map<string, AdaptedIngredient>();
  for (const entry of Array.isArray(input.adapted) ? input.adapted : []) {
    if (entry !== null && typeof entry === 'object' && typeof entry.line_ref === 'string') {
      adaptedByLineRef.set(entry.line_ref, entry);
    }
  }
  const out = new Map<string, AiAdvancedAuthoritativeAmountObservation>();
  for (const row of Array.isArray(input.rows) ? input.rows : []) {
    const entry = adaptedByLineRef.get(row.line_ref);
    if (entry === undefined) continue;
    out.set(row.line_ref, sourceAmountObservation(entry));
  }
  return out;
}
