/**
 * The Kitchen Codex — Advanced Nutrition Phase 6: verified household-portion
 * resolution.
 *
 * PURE, offline, DETERMINISTIC. This is the ONE lookup authority that turns an
 * already-authenticated USDA food identity plus the recipe's own canonical
 * parsed context into a verified Kitchen Codex household-portion mass. It never
 * manufactures food identity, never guesses a package size/density/range
 * endpoint, and never uses AI or the network.
 *
 * AUTHORITY POSITION
 * ------------------
 * A household result is the LOWEST mass authority (below direct recipe mass,
 * explicit user mass, authenticated USDA source portion, and authenticated USDA
 * count portion). It applies only when the food identity is already
 * authenticated and no higher-authority mass source is active. The shared
 * effective-mass decision (`effectiveMass.ts`) owns that precedence; this module
 * owns only the exact conversion.
 *
 * AUTHENTICATED LOOKUP
 * --------------------
 * The registry is loaded ONLY through the Phase 5 verified loader
 * (`loadHouseholdInitialRegistry`), whose registry/provenance/aggregate digest
 * locks must all verify. Raw Phase 5 data is never imported here. The lookup is
 * an exact-key index built once from the authenticated immutable registry:
 *
 *   `${bound FDC id}|${canonical household unit}|${size|null}|${state|null}`
 *
 * The recipe context (unit, size, state, quantity) is derived with the EXISTING
 * canonical contracts — `parseIngredient`, `projectQueryText`, and
 * `deriveCountRequirement` — never by a second, independent interpretation.
 * A record declares exact bindings; every declared dimension must match, and
 * any missing/ambiguous dimension yields NO mass (never a default or midpoint).
 *
 * DIGEST BINDING
 * --------------
 * A resolution carries the USDA bundle release + USDA record digest, the
 * registry release + registry/provenance/aggregate digests, the household record
 * key + record digest, the canonical unit/size/state, the recipe quantity, and
 * the resolved grams. The closed selection object is bound by a deterministic
 * SHA-256 selection digest. The calculation engine independently re-derives the
 * resolution and requires exact equality; a stale, forged, cross-line,
 * cross-food, cross-quantity, or cross-release selection fails closed.
 */

import { canonicalHouseholdUnit } from '../../../utils/householdUnits';
import { getMeasurementKind, normalizeUnit } from '../../../utils/measurements';
import { normalizeQuery } from '../matching/normalize';
import { parseIngredient } from '../matching/parse';
import { projectQueryText } from '../matching/query';
import { canonicalStringify, sha256Hex } from '../usda/digest';
import { deriveCountRequirement } from './countPortion';
import { isValidNutrientAmount } from '../units';
import { MAX_CALCULATION_GRAMS } from './types';
import { loadHouseholdInitialRegistry } from '../household/initialData';

/** Closed household-portion selection contract version. */
export const HOUSEHOLD_PORTION_SELECTION_VERSION = 'household_portion_selection_v1';

/** The closed physical-state vocabulary the registry can declare. */
const HOUSEHOLD_STATES: ReadonlySet<string> = new Set([
  'raw',
  'cooked',
  'canned',
  'drained',
  'undrained',
  'fresh',
  'dried',
  'frozen',
]);

/** Derivation classification of one verified household record. */
export type HouseholdPortionDerivation = 'authenticated_exact_conversion' | 'bounded_estimate';

export interface HouseholdPortionResolution {
  readonly registry_release: string;
  readonly registry_digest: string;
  readonly provenance_digest: string;
  readonly aggregate_release_digest: string;
  readonly usda_fdc_id: number;
  readonly usda_record_digest: string;
  readonly household_record_key: string;
  readonly household_record_digest: string;
  readonly food_key: string;
  readonly household_unit: string;
  readonly size_class: string | null;
  readonly requires_state: string | null;
  readonly authority_class: string;
  readonly derivation: HouseholdPortionDerivation;
  readonly grams_per_unit: number;
  readonly quantity: number;
  readonly resolved_grams: number;
}

interface IndexedRegistryRecord {
  readonly fdcIds: ReadonlyArray<number>;
  readonly record_key: string;
  readonly food_key: string;
  readonly household_unit: string;
  readonly size_class: string | null;
  readonly requires_state: string | null;
  readonly grams_per_unit: number;
  readonly authority_class: string;
  readonly record_digest: string;
}

interface HouseholdPortionIndex {
  readonly registry_release: string;
  readonly registry_digest: string;
  readonly provenance_digest: string;
  readonly aggregate_release_digest: string;
  readonly byKey: ReadonlyMap<string, IndexedRegistryRecord>;
}

function indexKey(fdcId: number, unit: string, size: string | null, state: string | null): string {
  return `${fdcId}|${unit}|${size ?? 'null'}|${state ?? 'null'}`;
}

let cachedIndex: HouseholdPortionIndex | undefined;

/**
 * Builds (once) the exact-key index from the verified loader. Fails closed with
 * an empty index when the registry cannot be verified; the result is immutable
 * and contains no registration/update surface.
 */
function getHouseholdPortionIndex(): HouseholdPortionIndex {
  if (cachedIndex !== undefined) return cachedIndex;
  const empty: HouseholdPortionIndex = Object.freeze({
    registry_release: '',
    registry_digest: '',
    provenance_digest: '',
    aggregate_release_digest: '',
    byKey: new Map<string, IndexedRegistryRecord>(),
  });
  const loaded = loadHouseholdInitialRegistry();
  if (!loaded.ok) {
    cachedIndex = empty;
    return cachedIndex;
  }
  const byKey = new Map<string, IndexedRegistryRecord>();
  for (const record of loaded.registry.records()) {
    const indexed: IndexedRegistryRecord = Object.freeze({
      fdcIds: Object.freeze([...record.usda_fdc_ids]),
      record_key: `${record.food_key}|${record.household_unit}|${
        record.size_class ?? 'null'
      }|${record.requires_state ?? 'null'}`,
      food_key: record.food_key,
      household_unit: record.household_unit,
      size_class: record.size_class,
      requires_state: record.requires_state,
      grams_per_unit: record.grams_per_unit,
      authority_class: record.authority_class,
      record_digest: record.record_digest,
    });
    for (const fdcId of record.usda_fdc_ids) {
      const key = indexKey(fdcId, record.household_unit, record.size_class, record.requires_state);
      // The Phase 4 loader already rejects duplicate lookup keys; keep the FIRST
      // deterministically and never overwrite (defensive, cannot happen).
      if (!byKey.has(key)) byKey.set(key, indexed);
    }
  }
  cachedIndex = Object.freeze({
    registry_release: loaded.dataset.registry_release,
    registry_digest: loaded.dataset.registry_digest,
    provenance_digest: loaded.dataset.provenance_digest,
    aggregate_release_digest: loaded.dataset.aggregate_release_digest,
    byKey,
  });
  return cachedIndex;
}

/** Bounded lookup context derived with the existing canonical contracts. */
export interface HouseholdLookupContext {
  readonly quantity: number;
  readonly household_unit: string;
  readonly size_class: string | null;
  readonly requires_state: string | null;
}

/**
 * Derives the household lookup context for one recipe line, or `undefined` when
 * the line cannot satisfy the exact-binding contract:
 *  - a range quantity (no single quantity);
 *  - a missing/non-positive/non-exact quantity;
 *  - no canonical household count noun AND no size class (no `item` inference);
 *  - more than one distinct recognized physical state.
 *
 * GUARD LAYERING (Phase 6 repair, mutation-probed). The explicit container and
 * non-exact/range guards below are DELIBERATE DEFENSE IN DEPTH, not the single
 * enforcement point: for the ordinary guarded lines probed during the repair,
 * neutralizing either one alone still fails closed through an independent
 * downstream guard (a range parses with no amount, so the amount guard rejects
 * it; a size-first `can`/`package`/`cup`/`slice` line loses its container/unit
 * token, so the item-mapping token scan rejects it). Both layers are retained;
 * the behavioral tests pin the user-visible no-mass outcome regardless of which
 * layer fires.
 */
export function deriveHouseholdLookupContext(ingredient: unknown): HouseholdLookupContext | undefined {
  const parsedResult = parseIngredient(ingredient);
  if (!parsedResult.ok) return undefined;
  const parsed = parsedResult.parsed;
  // A generic container line (`can`, `package`, `jar`, …) is NEVER a household
  // count conversion, even when a size qualifier is present; the recipe-authored
  // package mass remains the only legitimate container evidence.
  if (parsed.container !== undefined) return undefined;
  if (parsed.quantity_kind !== 'exact') return undefined;
  if (typeof parsed.amount !== 'number' || !Number.isFinite(parsed.amount)) return undefined;
  if (parsed.amount <= 0 || Object.is(parsed.amount, -0)) return undefined;

  const projection = projectQueryText(normalizeQuery(parsed.query).text, {
    count_noun: parsed.count_noun,
    container: parsed.container,
  });
  const requirement = deriveCountRequirement(
    parsed.amount,
    parsed.raw_unit,
    projection.food_tokens,
    projection.size_qualifiers
  );
  if (!requirement) return undefined;

  // Canonical household unit: reuse the Phase 1 owner. A size-only whole-food
  // line (no count noun, an explicit size) has `item` semantics; a named unit
  // that is not a Phase 1 household count noun is never coerced.
  const canonicalUnit =
    requirement.unit !== null && canonicalHouseholdUnit(requirement.unit)?.kind === 'count'
      ? canonicalHouseholdUnit(requirement.unit)?.noun ?? null
      : null;
  const itemMappingRequested = canonicalUnit === null && requirement.unit === null && requirement.size !== null;
  if (itemMappingRequested) {
    // The size-only `item` mapping is allowed ONLY when the line names no unit
    // at all. A size qualifier appearing before a named unit (`1 medium can …`,
    // `1 medium cup …`, `1 medium slice …`) makes some parsers drop that unit
    // token from the query, which would silently reinterpret a container,
    // volume, mass, or count noun as one whole item. Such a line therefore
    // yields NO mass rather than a guessed item conversion.
    for (const token of normalizeQuery(parsed.query).text.split(' ')) {
      if (token.length === 0) continue;
      if (canonicalHouseholdUnit(token) !== null) return undefined;
      const measurementKind = getMeasurementKind(normalizeUnit(token));
      if (measurementKind === 'mass' || measurementKind === 'volume') return undefined;
    }
  }
  const householdUnit = canonicalUnit ?? (itemMappingRequested ? 'item' : null);
  if (householdUnit === null) return undefined;

  // Physical state: only the closed registry vocabulary, and only when the line
  // declares exactly one recognized state (multiple distinct states are
  // ambiguous and yield no mass). No state -> the null dimension.
  const states = new Set<string>();
  for (const token of projection.state_tokens) {
    if (HOUSEHOLD_STATES.has(token)) states.add(token);
  }
  if (states.size > 1) return undefined;
  const requiresState = states.size === 1 ? [...states][0] : null;

  return Object.freeze({
    quantity: parsed.amount,
    household_unit: householdUnit,
    size_class: requirement.size,
    requires_state: requiresState,
  });
}

/**
 * Resolves the verified household portion for one authenticated USDA food.
 * Returns `undefined` (no mass) for any missing, ambiguous, mismatched, or
 * non-finite case. The caller must already hold the authenticated record digest.
 */
export function resolveHouseholdPortion(input: {
  readonly ingredient: unknown;
  readonly fdcId: number;
  readonly usdaRecordDigest: string;
  readonly bundleRelease: string;
}): HouseholdPortionResolution | undefined {
  if (!Number.isSafeInteger(input.fdcId) || input.fdcId <= 0) return undefined;
  if (typeof input.usdaRecordDigest !== 'string' || input.usdaRecordDigest.length === 0) {
    return undefined;
  }
  if (typeof input.bundleRelease !== 'string' || input.bundleRelease.length === 0) return undefined;

  const context = deriveHouseholdLookupContext(input.ingredient);
  if (!context) return undefined;

  const index = getHouseholdPortionIndex();
  const record = index.byKey.get(
    indexKey(input.fdcId, context.household_unit, context.size_class, context.requires_state)
  );
  if (!record) return undefined;
  if (!record.fdcIds.includes(input.fdcId)) return undefined;
  if (!isValidNutrientAmount(record.grams_per_unit) || record.grams_per_unit <= 0) return undefined;

  const grams = context.quantity * record.grams_per_unit;
  if (!Number.isFinite(grams) || grams <= 0 || Object.is(grams, -0)) return undefined;
  if (grams > MAX_CALCULATION_GRAMS) return undefined;
  if (!isValidNutrientAmount(grams)) return undefined;

  const derivation: HouseholdPortionDerivation =
    record.authority_class === 'bounded_estimate' ? 'bounded_estimate' : 'authenticated_exact_conversion';

  return Object.freeze({
    registry_release: index.registry_release,
    registry_digest: index.registry_digest,
    provenance_digest: index.provenance_digest,
    aggregate_release_digest: index.aggregate_release_digest,
    usda_fdc_id: input.fdcId,
    usda_record_digest: input.usdaRecordDigest,
    household_record_key: record.record_key,
    household_record_digest: record.record_digest,
    food_key: record.food_key,
    household_unit: record.household_unit,
    size_class: record.size_class,
    requires_state: record.requires_state,
    authority_class: record.authority_class,
    derivation,
    grams_per_unit: record.grams_per_unit,
    quantity: context.quantity,
    resolved_grams: grams,
  });
}

/** Closed Phase 6 selection object binding one verified household result. */
export interface HouseholdPortionSelection {
  readonly household_selection_version: typeof HOUSEHOLD_PORTION_SELECTION_VERSION;
  readonly calculation_version: string;
  readonly line_ref: string;
  readonly ingredient_identity_digest: string;
  readonly bundle_release: string;
  readonly usda_fdc_id: number;
  readonly usda_record_digest: string;
  readonly registry_release: string;
  readonly registry_digest: string;
  readonly provenance_digest: string;
  readonly aggregate_release_digest: string;
  readonly household_record_key: string;
  readonly household_record_digest: string;
  readonly household_unit: string;
  readonly size_class: string | null;
  readonly requires_state: string | null;
  readonly quantity: number;
  readonly resolved_grams: number;
  readonly selection_digest: string;
}

/** Deterministic selection digest over every authoritative binding field. */
export function computeHouseholdPortionSelectionDigest(
  selection: Omit<HouseholdPortionSelection, 'selection_digest'>
): string {
  return sha256Hex(canonicalStringify(selection));
}

/**
 * Builds the closed selection object for one resolution + identity digest.
 * Returns `undefined` for a malformed identity digest.
 */
export function buildHouseholdPortionSelection(input: {
  readonly calculationVersion: string;
  readonly lineRef: string;
  readonly ingredientIdentityDigest: string;
  readonly bundleRelease: string;
  readonly resolution: HouseholdPortionResolution;
}): HouseholdPortionSelection | undefined {
  if (typeof input.ingredientIdentityDigest !== 'string' || input.ingredientIdentityDigest.length === 0) {
    return undefined;
  }
  if (typeof input.lineRef !== 'string' || input.lineRef.length === 0) return undefined;
  const resolution = input.resolution;
  const base = {
    household_selection_version: HOUSEHOLD_PORTION_SELECTION_VERSION,
    calculation_version: input.calculationVersion,
    line_ref: input.lineRef,
    ingredient_identity_digest: input.ingredientIdentityDigest,
    bundle_release: input.bundleRelease,
    usda_fdc_id: resolution.usda_fdc_id,
    usda_record_digest: resolution.usda_record_digest,
    registry_release: resolution.registry_release,
    registry_digest: resolution.registry_digest,
    provenance_digest: resolution.provenance_digest,
    aggregate_release_digest: resolution.aggregate_release_digest,
    household_record_key: resolution.household_record_key,
    household_record_digest: resolution.household_record_digest,
    household_unit: resolution.household_unit,
    size_class: resolution.size_class,
    requires_state: resolution.requires_state,
    quantity: resolution.quantity,
    resolved_grams: resolution.resolved_grams,
  } as const;
  return Object.freeze({ ...base, selection_digest: computeHouseholdPortionSelectionDigest(base) });
}

/**
 * Deterministic equality of a supplied selection against a freshly re-derived
 * resolution. Every binding field (including both digests and the selection
 * digest recomputed locally) must match exactly.
 */
export function householdSelectionMatchesResolution(input: {
  readonly selection: HouseholdPortionSelection;
  readonly resolution: HouseholdPortionResolution;
  readonly expectedIdentityDigest: string;
  readonly expectedLineRef: string;
  readonly expectedBundleRelease: string;
}): boolean {
  const selection = input.selection;
  if (selection.household_selection_version !== HOUSEHOLD_PORTION_SELECTION_VERSION) return false;
  if (selection.line_ref !== input.expectedLineRef) return false;
  if (selection.ingredient_identity_digest !== input.expectedIdentityDigest) return false;
  const { selection_digest: _declared, ...base } = selection as unknown as Record<string, unknown>;
  void _declared;
  const recomputed = sha256Hex(canonicalStringify(base));
  if (recomputed !== selection.selection_digest) return false;
  const resolution = input.resolution;
  return (
    selection.bundle_release === input.expectedBundleRelease &&
    selection.usda_fdc_id === resolution.usda_fdc_id &&
    selection.usda_record_digest === resolution.usda_record_digest &&
    selection.registry_release === resolution.registry_release &&
    selection.registry_digest === resolution.registry_digest &&
    selection.provenance_digest === resolution.provenance_digest &&
    selection.aggregate_release_digest === resolution.aggregate_release_digest &&
    selection.household_record_key === resolution.household_record_key &&
    selection.household_record_digest === resolution.household_record_digest &&
    selection.household_unit === resolution.household_unit &&
    selection.size_class === resolution.size_class &&
    selection.requires_state === resolution.requires_state &&
    selection.quantity === resolution.quantity &&
    selection.resolved_grams === resolution.resolved_grams
  );
}
