/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: stored-block projection.
 *
 * PURE, offline, display-only. Recognized schema-v1 stored data is validated
 * before trusted display; malformed data is never shown as authoritative; an
 * unknown future schema is preserved opaquely and never interpreted.
 *
 * The block is materialized once into inert data before it is read, and the
 * recipe's `codexNutrition` field is read through a guarded own-data descriptor,
 * so a hostile accessor/proxy/reflection failure cannot escape or be rendered.
 */

import { isPlainObject, toInertValue } from '../schema';
import type { NutrientId } from '../nutrients';
import type { CanonicalUnit } from '../units';
import { readOwnDataField } from './materialize';

export interface StoredNutrientValue {
  readonly nutrient: NutrientId;
  readonly label: string;
  readonly amount: number;
  readonly unit: CanonicalUnit;
}

export interface StoredAdvancedSummary {
  readonly kind: 'none' | 'v1' | 'opaque';
  readonly status?: string;
  readonly servings?: number;
  readonly values: ReadonlyArray<StoredNutrientValue>;
}

const DISPLAY_NUTRIENTS: ReadonlyArray<[NutrientId, string]> = [
  ['calories', 'Calories'],
  ['protein', 'Protein'],
  ['carbohydrates', 'Carbohydrates'],
  ['fat', 'Fat'],
];

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
}

function opaque(): StoredAdvancedSummary {
  return Object.freeze({ kind: 'opaque', values: Object.freeze([]) });
}

function none(): StoredAdvancedSummary {
  return Object.freeze({ kind: 'none', values: Object.freeze([]) });
}

/**
 * Projects an already-decoded advanced-nutrition block for trusted display. Only
 * a recognized `schema: 1` / `basis: 'total'` block is interpreted; everything
 * else (opaque future schema or malformed data) is reported as opaque. The value
 * is materialized once into inert data before any property is read.
 */
export function summarizeStoredAdvanced(blockRaw: unknown): StoredAdvancedSummary {
  if (blockRaw === null || blockRaw === undefined) return none();
  const materialized = toInertValue(blockRaw);
  if (!materialized.ok) return opaque();
  const block = materialized.value;
  if (typeof block !== 'object') return opaque();

  const candidate = block as {
    kind?: unknown;
    schema?: unknown;
    basis?: unknown;
    status?: unknown;
    servings?: unknown;
    nutrients?: unknown;
  };
  if (candidate.kind === 'opaque') return opaque();
  if (candidate.schema !== 1 || candidate.basis !== 'total') return opaque();
  if (candidate.nutrients === null || typeof candidate.nutrients !== 'object') return opaque();

  const nutrients = candidate.nutrients as Record<string, unknown>;
  const values: StoredNutrientValue[] = [];
  for (const [id, label] of DISPLAY_NUTRIENTS) {
    const entry = nutrients[id];
    if (!entry || typeof entry !== 'object') continue;
    const amount = (entry as { amount?: unknown }).amount;
    const unit = (entry as { unit?: unknown }).unit;
    if (!isFiniteNonNegative(amount)) continue;
    if (typeof unit !== 'string') continue;
    values.push(Object.freeze({ nutrient: id, label, amount, unit: unit as CanonicalUnit }));
  }

  return Object.freeze({
    kind: 'v1',
    status: typeof candidate.status === 'string' ? candidate.status : undefined,
    servings: isFiniteNonNegative(candidate.servings) ? candidate.servings : undefined,
    values: Object.freeze(values),
  });
}

/**
 * Safely reads a recipe's `codexNutrition` field (through a guarded own-data
 * descriptor, never invoking an accessor) and projects it for display.
 */
export function readStoredBlock(recipeRaw: unknown): StoredAdvancedSummary {
  if (!isPlainObject(recipeRaw)) return opaque();
  const field = readOwnDataField(recipeRaw, 'codexNutrition');
  if (!field.ok) return opaque();
  if (!field.present) return none();
  return summarizeStoredAdvanced(field.value);
}
