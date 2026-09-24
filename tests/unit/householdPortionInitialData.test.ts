/**
 * The Kitchen Codex — Household-Portion Registry (registry-track Phase 5, repair):
 * repaired dataset validity, provenance-lock, cross-FDC rationale, and policy.
 *
 * The oracle is the REAL pinned USDA bundle
 * (`usda_fdc_87c5408a3e98838944a87be74824761e`), loaded from the locked `.gz`
 * shards with the existing canonical record validator. Every production record
 * is independently re-derived from its cited source portion, and every
 * provenance/equivalence mutation is shown to change or invalidate the lock.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import {
  HOUSEHOLD_INITIAL_REVIEWED_AT,
  HOUSEHOLD_INITIAL_SOURCE_BUNDLE_RELEASE,
  loadHouseholdInitialRegistry,
  type HouseholdInitialVerifiedDataset,
} from '../../src/core/nutritionV2/household/initialData';
import {
  HOUSEHOLD_INITIAL_AGGREGATE_RELEASE_DIGEST,
  HOUSEHOLD_INITIAL_PROVENANCE_DIGEST,
  HOUSEHOLD_INITIAL_REGISTRY_LOCK,
  HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
} from '../../src/core/nutritionV2/household/initialLock';
import {
  HOUSEHOLD_AUTHORITY_CLASSES,
  HOUSEHOLD_SIZE_CLASSES,
} from '../../src/core/nutritionV2/household/normalize';
import {
  computeHouseholdInitialAggregateDigest,
  computeHouseholdInitialProvenanceDigest,
  validateHouseholdInitialProvenance,
  householdRecordKey,
  type HouseholdPortionEquivalenceRationale,
  type HouseholdPortionInitialProvenance,
} from '../../src/core/nutritionV2/household/initialProvenance';
import {
  HouseholdPortionRecordInput,
  HouseholdPortionRegistryLock,
} from '../../src/core/nutritionV2/household/types';
import {
  loadHouseholdPortionRegistry,
  validateHouseholdRecord,
} from '../../src/core/nutritionV2/household/registry';
import { computeHouseholdRegistryDigest } from '../../src/core/nutritionV2/household/digest';
import { decodeBoundedGzip, decodeUtf8Strict } from '../../src/core/nutritionV2/runtime/gzip';
import { validateCanonicalRecord } from '../../src/core/nutritionV2/usda/record';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import type { CanonicalUsdaFoodRecord } from '../../src/core/nutritionV2/usda/types';
import { canonicalStringify, sha256HexFromBytes } from '../../src/core/nutritionV2/usda/digest';
import {
  HOUSEHOLD_PHASE5_CANDIDATE_CENSUS,
  HOUSEHOLD_PHASE5_CENSUS_OUTCOMES,
  householdPhase5CensusKey,
  type HouseholdPhase5CensusFamily,
} from '../fixtures/householdPhase5CandidateCensus';

const BUNDLE_DIR = join(
  __dirname,
  '../../data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

/** Pinned literal expectations (a data edit without a reviewed lock edit fails). */
const EXPECTED_RECORD_COUNT = 31;
const EXPECTED_FOOD_COUNT = 11;
const EXPECTED_REGISTRY_DIGEST = '6ad593ef558ca9325197549f005da5b1eee822211f2ec6b5290f5c58fedc4ac4';
const EXPECTED_PROVENANCE_DIGEST = 'adba614327f9cb078ffd35d6abade50b25de180b43f4b373eea6ab8825694b31';
const EXPECTED_AGGREGATE_DIGEST = 'f8fed2230ac210c8dc2548f3a300134091c3a490ac6eb68add2766ac9b85b256';
const EXPECTED_MIN_GRAMS = 3;
const EXPECTED_MAX_GRAMS = 1248;

const COUNT_UNITS = new Set([
  'clove',
  'slice',
  'piece',
  'stick',
  'head',
  'stalk',
  'sprig',
  'bunch',
  'leaf',
  'fillet',
  'breast',
  'thigh',
  'rib',
  'strip',
  'link',
  'scoop',
  'item',
]);
const FORBIDDEN_UNITS = new Set([
  'can',
  'package',
  'jar',
  'box',
  'bag',
  'bottle',
  'g',
  'gram',
  'kg',
  'cup',
  'ml',
  'l',
  'tsp',
  'tbsp',
  'oz',
  'lb',
]);

const RECORD_KEYS = [
  'aliases',
  'authority_class',
  'bounds',
  'exclude_generic_identity',
  'excluded_states',
  'food_key',
  'grams_per_unit',
  'household_unit',
  'quantity_behavior',
  'requires_state',
  'reviewed_at',
  'schema_version',
  'size_class',
  'source',
  'supersedes',
  'usda_fdc_ids',
].sort();
const SOURCE_KEYS = ['accessed', 'citation', 'kind', 'url'].sort();

let bundle: Map<number, CanonicalUsdaFoodRecord>;
let dataset: HouseholdInitialVerifiedDataset;

beforeAll(async () => {
  const byId = new Map<number, CanonicalUsdaFoodRecord>();
  for (const shard of USDA_BUNDLE_RELEASE_LOCK.shards) {
    const compressed = new Uint8Array(readFileSync(join(BUNDLE_DIR, shard.filename)));
    expect(compressed.length).toBe(shard.compressed_bytes);
    expect(sha256HexFromBytes(compressed)).toBe(shard.compressed_sha256);
    const decoded = await decodeBoundedGzip(compressed, 64 * 1024 * 1024);
    expect(decoded.length).toBe(shard.uncompressed_bytes);
    expect(sha256HexFromBytes(decoded)).toBe(shard.uncompressed_sha256);
    const text = decodeUtf8Strict(decoded);
    expect(text.ok).toBe(true);
    if (!text.ok) continue;
    const parsed = JSON.parse(text.text) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    for (const raw of parsed as ReadonlyArray<unknown>) {
      const validated = validateCanonicalRecord(raw);
      expect(validated.ok).toBe(true);
      if (validated.ok) byId.set(validated.record.fdc_id, validated.record);
    }
  }
  bundle = byId;

  const loaded = loadHouseholdInitialRegistry();
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) {
    throw new Error(
      `initial registry failed: ${(loaded as { failure: { message: string } }).failure.message}`
    );
  }
  dataset = loaded.dataset;
}, 180000);

function verifiedRecords() {
  const loaded = loadHouseholdInitialRegistry();
  if (!loaded.ok) throw new Error('load failed');
  return loaded.registry.records();
}

function recordList(): ReadonlyArray<{
  food_key: string;
  household_unit: string;
  size_class: string | null;
  requires_state: string | null;
  grams_per_unit: number;
  usda_fdc_ids: ReadonlyArray<number>;
  record_digest: string;
  source: { citation: string };
}> {
  return verifiedRecords();
}

function provenanceList(): ReadonlyArray<HouseholdPortionInitialProvenance> {
  return dataset.provenance();
}

function equivalenceList(): ReadonlyArray<HouseholdPortionEquivalenceRationale> {
  return dataset.equivalence();
}

function provenanceFor(recordKey: string): HouseholdPortionInitialProvenance {
  const entry = provenanceList().find((candidate) => candidate.record_key === recordKey);
  if (!entry) throw new Error(`missing provenance for ${recordKey}`);
  return entry;
}

function clonedProvenance(
  mutate: (entry: HouseholdPortionInitialProvenance) => HouseholdPortionInitialProvenance
): ReadonlyArray<HouseholdPortionInitialProvenance> {
  const clone = provenanceList().map((entry) => ({ ...entry }));
  clone[0] = mutate(clone[0]);
  return clone as ReadonlyArray<HouseholdPortionInitialProvenance>;
}

function digestWith(
  provenance: ReadonlyArray<HouseholdPortionInitialProvenance>,
  equivalence: ReadonlyArray<HouseholdPortionEquivalenceRationale> = equivalenceList()
): string {
  return computeHouseholdInitialProvenanceDigest({
    registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
    records: recordList() as never,
    provenance,
    equivalence,
  });
}

/**
 * Bundle-independent re-derivation used by the provenance tests: recurses over
 * the real bundle for the source portion and compares every field exactly.
 */
function verifyProvenanceEntry(entry: HouseholdPortionInitialProvenance): boolean {
  if (entry.source_release !== HOUSEHOLD_INITIAL_SOURCE_BUNDLE_RELEASE) return false;
  const source = bundle.get(entry.source_fdc_id);
  if (!source) return false;
  if (source.record_digest !== entry.source_record_digest) return false;
  const portion = source.portions[entry.source_portion_index];
  if (!portion) return false;
  if (portion.amount !== entry.portion_amount) return false;
  if (portion.gram_weight !== entry.portion_gram_weight) return false;
  if (portion.measure !== entry.portion_measure) return false;
  if ((portion.modifier ?? null) !== entry.portion_modifier) return false;
  if (portion.amount !== 1) return false;
  if (portion.gram_weight !== entry.derived_grams_per_unit) return false;

  const record = verifiedRecords().find(
    (candidate) => householdRecordKey(candidate) === entry.record_key
  );
  if (!record) return false;
  if (record.grams_per_unit !== entry.derived_grams_per_unit) return false;
  if (record.usda_fdc_ids[0] !== entry.source_fdc_id) return false;
  if (!record.usda_fdc_ids.includes(entry.source_fdc_id)) return false;
  if (new Set(record.usda_fdc_ids).size !== record.usda_fdc_ids.length) return false;
  if (!record.usda_fdc_ids.every((fdc) => bundle.has(fdc))) return false;
  if (!record.source.citation.includes(`USDA FDC ${entry.citation_fdc_id}`)) return false;
  if (!record.source.citation.includes(entry.citation_portion_id)) return false;
  return true;
}

describe('phase 5 repair — verified-loader dataset validity', () => {
  it('loads exactly the repaired 31-record, 11-food dataset with the fixed locks', () => {
    const loaded = loadHouseholdInitialRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.registry.size()).toBe(EXPECTED_RECORD_COUNT);
    expect(loaded.registry.metadata()).toEqual({
      schema_version: 'household_portion_registry_v1',
      registry_release: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
      record_count: EXPECTED_RECORD_COUNT,
      registry_digest: EXPECTED_REGISTRY_DIGEST,
    });
    expect(dataset.record_count).toBe(EXPECTED_RECORD_COUNT);
    expect(dataset.registry_digest).toBe(EXPECTED_REGISTRY_DIGEST);
    expect(dataset.provenance_digest).toBe(EXPECTED_PROVENANCE_DIGEST);
    expect(dataset.aggregate_release_digest).toBe(EXPECTED_AGGREGATE_DIGEST);
    expect(dataset.source_bundle_release).toBe(HOUSEHOLD_INITIAL_SOURCE_BUNDLE_RELEASE);
    expect(dataset.reviewed_at).toBe(HOUSEHOLD_INITIAL_REVIEWED_AT);

    const foods = new Set(verifiedRecords().map((record) => record.food_key));
    expect(foods.size).toBe(EXPECTED_FOOD_COUNT);
    expect(provenanceList().length).toBe(EXPECTED_RECORD_COUNT);
    expect(equivalenceList().length).toBe(23);
  });

  it('pins the registry, provenance, and aggregate digests as literals', () => {
    expect(HOUSEHOLD_INITIAL_REGISTRY_LOCK).toEqual({
      schema_version: 'household_portion_registry_v1',
      registry_release: 'household_portion_initial_usda_v1',
      record_count: EXPECTED_RECORD_COUNT,
      registry_digest: EXPECTED_REGISTRY_DIGEST,
    });
    expect(HOUSEHOLD_INITIAL_PROVENANCE_DIGEST).toBe(EXPECTED_PROVENANCE_DIGEST);
    expect(HOUSEHOLD_INITIAL_AGGREGATE_RELEASE_DIGEST).toBe(EXPECTED_AGGREGATE_DIGEST);
    expect(HOUSEHOLD_INITIAL_REGISTRY_RELEASE).toBe('household_portion_initial_usda_v1');
  });

  it('computes exact current grams bounds', () => {
    const grams = verifiedRecords().map((record) => record.grams_per_unit);
    expect(grams.length).toBe(EXPECTED_RECORD_COUNT);
    expect(Math.min(...grams)).toBe(EXPECTED_MIN_GRAMS);
    expect(Math.max(...grams)).toBe(EXPECTED_MAX_GRAMS);
    for (const value of grams) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(10_000);
    }
    expect(EXPECTED_MAX_GRAMS).toBe(1248); // repaired from the previous ≤369 claim
  });

  it('is deterministic, content-identical, and order-independent', () => {
    const first = loadHouseholdInitialRegistry();
    const second = loadHouseholdInitialRegistry();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(canonicalStringify(first.registry.records())).toBe(
      canonicalStringify(second.registry.records())
    );
    expect(first.registry).not.toBe(second.registry);
    expect(first.dataset).toBe(second.dataset); // frozen reviewed constant

    const reversed = [...verifiedRecords()].reverse();
    const reversedResult = loadHouseholdPortionRegistry(reversed as never, HOUSEHOLD_INITIAL_REGISTRY_LOCK);
    expect(reversedResult.ok).toBe(true);
    if (!reversedResult.ok) return;
    expect(canonicalStringify(reversedResult.registry.records())).toBe(
      canonicalStringify(first.registry.records())
    );
  });
});

describe('phase 5 repair — provenance digest binding', () => {
  it('recomputes the pinned provenance and aggregate digests from the verified loader', () => {
    const input = {
      registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
      records: recordList() as never,
      provenance: provenanceList(),
      equivalence: equivalenceList(),
    };
    expect(validateHouseholdInitialProvenance(input)).toEqual({ ok: true });
    expect(computeHouseholdInitialProvenanceDigest(input)).toBe(EXPECTED_PROVENANCE_DIGEST);
    expect(
      computeHouseholdInitialAggregateDigest({
        registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
        recordCount: EXPECTED_RECORD_COUNT,
        registryDigest: EXPECTED_REGISTRY_DIGEST,
        provenanceDigest: EXPECTED_PROVENANCE_DIGEST,
      })
    ).toBe(EXPECTED_AGGREGATE_DIGEST);
  });

  it('invalidates the lock for every single provenance field mutation', () => {
    const fields: Array<[keyof HouseholdPortionInitialProvenance, (value: never) => never]> = [
      ['source_release', (v) => `${String(v)}_mutated` as never],
      ['source_fdc_id', (v) => ((v as number) + 1) as never],
      ['source_record_digest', () => 'a'.repeat(64) as never],
      ['source_portion_index', (v) => ((v as number) + 1) as never],
      ['source_portion_id', (v) => `${String(v)}x` as never],
      ['portion_amount', () => 2 as never],
      ['portion_gram_weight', (v) => ((v as number) + 1) as never],
      ['portion_measure', (v) => `${String(v)}x` as never],
      ['portion_modifier', (v) => (v === null ? 'mutated' : `${String(v)}x`) as never],
      ['derived_grams_per_unit', (v) => ((v as number) + 1) as never],
      ['citation_fdc_id', (v) => ((v as number) + 1) as never],
      ['citation_portion_id', (v) => `${String(v)}x` as never],
    ];
    for (const [field, mutate] of fields) {
      const mutated = clonedProvenance((entry) => ({
        ...entry,
        [field]: mutate(entry[field] as never),
      }));
      const input = {
        registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
        records: recordList() as never,
        provenance: mutated,
        equivalence: equivalenceList(),
      };
      const validation = validateHouseholdInitialProvenance(input);
      if (validation.ok) {
        expect(() => computeHouseholdInitialProvenanceDigest(input)).not.toThrow();
        expect(computeHouseholdInitialProvenanceDigest(input)).not.toBe(EXPECTED_PROVENANCE_DIGEST);
      }
    }
  });

  it('invalidates the lock for every single equivalence-rationale field mutation', () => {
    const fields: ReadonlyArray<keyof HouseholdPortionEquivalenceRationale> = [
      'record_key',
      'source_fdc_id',
      'source_description',
      'bound_fdc_id',
      'bound_description',
      'species_family',
      'state',
      'color_variety',
      'edible_form',
      'positive_evidence',
      'corroborating_portion',
      'data_type_difference',
      'nutrient_profile_delta',
      'conclusion',
    ];
    for (const field of fields) {
      const equivalence = equivalenceList().map((entry) => ({ ...entry }));
      const target = equivalence[0];
      const value = target[field];
      (equivalence[0] as Record<string, unknown>)[field] =
        typeof value === 'number' ? value + 1 : `${String(value)}_mutated`;
      const input = {
        registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
        records: recordList() as never,
        provenance: provenanceList(),
        equivalence,
      };
      const validation = validateHouseholdInitialProvenance(input);
      if (validation.ok) {
        expect(computeHouseholdInitialProvenanceDigest(input)).not.toBe(EXPECTED_PROVENANCE_DIGEST);
      }
    }
  });

  it('rejects unknown provenance/rationale fields and missing fields before hashing', () => {
    const unknownField = provenanceList().map((entry, index) =>
      index === 0 ? { ...entry, unexpected_field: 1 } : { ...entry }
    );
    expect(
      validateHouseholdInitialProvenance({
        registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
        records: recordList() as never,
        provenance: unknownField as never,
        equivalence: equivalenceList(),
      }).ok
    ).toBe(false);

    const missingField = provenanceList().map((entry, index) => {
      const clone = { ...entry } as Record<string, unknown>;
      if (index === 0) delete clone.portion_measure;
      return clone;
    });
    expect(
      validateHouseholdInitialProvenance({
        registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
        records: recordList() as never,
        provenance: missingField as never,
        equivalence: equivalenceList(),
      }).ok
    ).toBe(false);
  });

  it('implements the v1 division policy: every source amount is exactly one', () => {
    for (const entry of provenanceList()) {
      expect(entry.portion_amount).toBe(1);
      expect(entry.derived_grams_per_unit).toBe(entry.portion_gram_weight);
    }
    const nonOne = clonedProvenance((entry) => ({ ...entry, portion_amount: 2 as never }));
    expect(
      validateHouseholdInitialProvenance({
        registryRelease: HOUSEHOLD_INITIAL_REGISTRY_RELEASE,
        records: recordList() as never,
        provenance: nonOne,
        equivalence: equivalenceList(),
      })
    ).toEqual({ ok: false, reason: 'portion_amount_not_one' });
    expect(() => digestWith(nonOne)).toThrow();
  });

  it('re-derives every provenance entry from the real pinned bundle', () => {
    for (const entry of provenanceList()) {
      expect(verifyProvenanceEntry(entry), entry.record_key).toBe(true);
    }
  });

  it('aligns records and provenance one-to-one by the stable authority key', () => {
    const recordKeys = verifiedRecords().map((record) => householdRecordKey(record)).sort();
    const provenanceKeys = provenanceList().map((entry) => entry.record_key).sort();
    expect(provenanceKeys).toEqual(recordKeys);
  });
});

describe('phase 5 repair — cross-FDC equivalence rationale', () => {
  it('provides exactly one bounded, positive rationale for every bound FDC pairing', () => {
    const pairs = new Set<string>();
    for (const record of verifiedRecords()) {
      const entry = provenanceFor(householdRecordKey(record));
      for (const fdcId of record.usda_fdc_ids) {
        if (fdcId === entry.source_fdc_id) continue;
        pairs.add(`${householdRecordKey(record)}|${fdcId}`);
      }
    }
    const rationalePairs = new Set(
      equivalenceList().map((entry) => `${entry.record_key}|${entry.bound_fdc_id}`)
    );
    expect(rationalePairs.size).toBe(pairs.size);
    expect([...rationalePairs].sort()).toEqual([...pairs].sort());

    for (const rationale of equivalenceList()) {
      for (const [field, value] of Object.entries(rationale)) {
        if (typeof value === 'string') {
          expect(value.length, `${rationale.record_key}:${field}`).toBeGreaterThan(0);
          expect(value.length, `${rationale.record_key}:${field}`).toBeLessThanOrEqual(500);
          expect(value, `${rationale.record_key}:${field}`).not.toMatch(
            /[\u0000-\u001f\u007f-\u009f]/
          );
        }
      }
      // No rationale may rely solely on the absence of contradiction.
      expect(rationale.positive_evidence).not.toMatch(/^\s*(no|without|absence|nothing)\b/i);
      expect(rationale.positive_evidence).toMatch(
        /same|identical|equal|match|corroborat|declar|both|shared|describe/i
      );
      expect(rationale.nutrient_profile_delta).toMatch(/nutrients are never transferred/i);
      // Descriptions must match the pinned bundle exactly.
      const source = bundle.get(rationale.source_fdc_id);
      const bound = bundle.get(rationale.bound_fdc_id);
      expect(rationale.source_description).toBe(source?.description);
      expect(rationale.bound_description).toBe(bound?.description);
    }
  });

  it('documents the garlic, mushroom, and peach corroborating portions exactly', () => {
    const garlic = equivalenceList().find(
      (entry) => entry.source_fdc_id === 169230 && entry.bound_fdc_id === 2709786
    );
    expect(garlic?.corroborating_portion).toMatch(/amount omitted/i);
    expect(garlic?.nutrient_profile_delta).toMatch(/149 kcal/);
    expect(garlic?.nutrient_profile_delta).toMatch(/143 kcal/);
    const mushroom = equivalenceList().find(
      (entry) => entry.source_fdc_id === 169251 && entry.bound_fdc_id === 2709793
    );
    expect(mushroom?.corroborating_portion).toMatch(/18 g/);
    const peach = equivalenceList().find(
      (entry) => entry.source_fdc_id === 169928 && entry.bound_fdc_id === 2709249
    );
    expect(peach?.corroborating_portion).toMatch(/150 g/);
  });
});

describe('phase 5 repair — removed unsafe records and policy', () => {
  it('has no yellow onion, red onion, or lime lookup, and no null-size tomato lookup', () => {
    const loaded = loadHouseholdInitialRegistry();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const registry = loaded.registry;
    for (const [fdc, unit] of [
      [790646, 'item'],
      [790577, 'item'],
      [168155, 'item'],
    ] as Array<[number, string]>) {
      expect(
        registry.findByKey({ fdc_id: fdc, household_unit: unit, size_class: null, requires_state: null })
          .ok,
        `${fdc} must be absent`
      ).toBe(false);
    }
    expect(
      registry.findByKey({ fdc_id: 170457, household_unit: 'item', size_class: null, requires_state: null })
        .ok
    ).toBe(false);
    expect(verifiedRecords().some((record) => record.food_key === 'yellow onion')).toBe(false);
    expect(verifiedRecords().some((record) => record.food_key === 'red onion')).toBe(false);
    expect(verifiedRecords().some((record) => record.food_key === 'lime')).toBe(false);
  });

  it('keeps only usda_derived records with the exact contract shape and bounds', () => {
    for (const record of verifiedRecords()) {
      expect(record.authority_class).toBe('usda_derived');
      expect(record.bounds).toBeNull();
      expect(record.source.kind).toBe('usda_fdc');
      expect(record.quantity_behavior).toBe('linear');
      expect(record.exclude_generic_identity).toBe(false);
      expect(record.requires_state).toBeNull();
      expect(record.excluded_states).toEqual([]);
      expect(record.supersedes).toBeNull();
      expect(record.source.url).toBeNull();
      expect(record.source.accessed).toBeNull();
      expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS, 'record_digest'].sort());
      expect(Object.keys(record.source).sort()).toEqual(SOURCE_KEYS);
      expect(record.aliases).toEqual([]);
      expect(COUNT_UNITS.has(record.household_unit), record.household_unit).toBe(true);
      expect(FORBIDDEN_UNITS.has(record.household_unit)).toBe(false);
      if (record.size_class !== null) expect(HOUSEHOLD_SIZE_CLASSES).toContain(record.size_class);
      expect(record.grams_per_unit).toBeGreaterThan(0);
      expect(record.grams_per_unit).toBeLessThanOrEqual(10_000);
      expect(record.usda_fdc_ids.length).toBeGreaterThan(0);
      expect(record.usda_fdc_ids.length).toBeLessThanOrEqual(16);
      for (const id of record.usda_fdc_ids) {
        expect(Number.isSafeInteger(id)).toBe(true);
        expect(id).toBeGreaterThan(0);
      }
    }
    expect(HOUSEHOLD_AUTHORITY_CLASSES).toContain('usda_derived');
  });

  it('contains no density/package/web/manufacturer conversion material', () => {
    const serialized = JSON.stringify(verifiedRecords());
    expect(serialized).not.toMatch(/density|container weight|package size|net weight/i);
    expect(serialized).not.toMatch(/web_recipe|manufacturer_package|open_food_facts|user_manual/);
    expect(serialized).not.toMatch(/calories|protein|carbohydrate|sodium|nutrient/i);
    expect(serialized).not.toMatch(/bounded_estimate/);
  });

  it('returns deeply frozen records, provenance, and rationales', () => {
    const first = loadHouseholdInitialRegistry();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(Object.isFrozen(first.dataset)).toBe(true);
    expect(Object.isFrozen(first.dataset.provenance())).toBe(true);
    expect(Object.isFrozen(first.dataset.equivalence())).toBe(true);
    const records = first.registry.records();
    expect(Object.isFrozen(records)).toBe(true);
    for (const record of records) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.usda_fdc_ids)).toBe(true);
      expect(Object.isFrozen(record.source)).toBe(true);
    }
    for (const entry of first.dataset.provenance()) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    for (const entry of first.dataset.equivalence()) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(() => {
      (records as Array<unknown>).push({});
    }).toThrow();
    expect(() => {
      ((records[0] as unknown as Record<string, unknown>).grams_per_unit as unknown) = 1;
    }).toThrow();
    expect(() => {
      (first.dataset.provenance()[0] as unknown as Record<string, unknown>).source_fdc_id = 1;
    }).toThrow();
    expect(() => {
      (first.dataset.equivalence()[0] as unknown as Record<string, unknown>).conclusion = 'mutated';
    }).toThrow();

    // Tampering with a returned holder must not affect a later load.
    (first.registry as unknown as Record<string, unknown>).metadata = () => ({
      schema_version: 'household_portion_registry_v1',
      registry_release: 'evil',
      record_count: 0,
      registry_digest: 'a'.repeat(64),
    });
    const second = loadHouseholdInitialRegistry();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.registry.metadata().registry_digest).toBe(EXPECTED_REGISTRY_DIGEST);
  });
});

describe('phase 5 repair — record-level and lock negative detection', () => {
  it('fails closed on record mutation, removal, addition, and forged digests', () => {
    const base = () => verifiedRecords().map((record) => ({ ...record })) as Array<
      HouseholdPortionRecordInput
    >;
    const load = (records: ReadonlyArray<HouseholdPortionRecordInput>) =>
      loadHouseholdPortionRegistry(records, HOUSEHOLD_INITIAL_REGISTRY_LOCK as HouseholdPortionRegistryLock);

    const gramsChanged = base();
    gramsChanged[0] = { ...gramsChanged[0], grams_per_unit: gramsChanged[0].grams_per_unit + 1 };
    expect(load(gramsChanged).ok).toBe(false);

    const fdcChanged = base();
    fdcChanged[0] = { ...fdcChanged[0], usda_fdc_ids: [9999999, ...fdcChanged[0].usda_fdc_ids.slice(1)] };
    expect(load(fdcChanged).ok).toBe(false);

    const unitChanged = base();
    unitChanged[0] = { ...unitChanged[0], household_unit: 'slice' };
    expect(load(unitChanged).ok).toBe(false);

    const sizeRemoved = base();
    const sizedIndex = sizeRemoved.findIndex((record) => record.size_class !== null);
    sizeRemoved[sizedIndex] = { ...sizeRemoved[sizedIndex], size_class: null };
    expect(load(sizeRemoved).ok).toBe(false);

    expect(load(base().slice(1)).ok).toBe(false);

    const added = [
      ...base(),
      { ...base()[0], food_key: 'synthetic repair probe', usda_fdc_ids: [9000001] },
    ];
    expect(load(added).ok).toBe(false);

    const container = base();
    container[0] = { ...container[0], household_unit: 'can' };
    expect(load(container).ok).toBe(false);

    const estimate = base();
    estimate[0] = {
      ...estimate[0],
      authority_class: 'bounded_estimate',
      bounds: { min_grams: 1, max_grams: 5 },
    } as HouseholdPortionRecordInput;
    expect(load(estimate).ok).toBe(false);

    const forged = base() as Array<HouseholdPortionRecordInput & { record_digest?: string }>;
    forged[0] = { ...forged[0], record_digest: 'b'.repeat(64) };
    expect(load(forged as ReadonlyArray<HouseholdPortionRecordInput>).ok).toBe(false);
  });

  it('rejects a changed registry digest or count', () => {
    const changed = { ...HOUSEHOLD_INITIAL_REGISTRY_LOCK, registry_digest: 'c'.repeat(64) };
    expect(loadHouseholdPortionRegistry(verifiedRecords() as never, changed).ok).toBe(false);
    const wrongCount = { ...HOUSEHOLD_INITIAL_REGISTRY_LOCK, record_count: EXPECTED_RECORD_COUNT + 1 };
    expect(loadHouseholdPortionRegistry(verifiedRecords() as never, wrongCount).ok).toBe(false);
  });

  it('re-adding onion/lime generic records cannot satisfy the lock', () => {
    const readded = verifiedRecords().map((record) => ({ ...record })) as Array<
      HouseholdPortionRecordInput
    >;
    readded.push({
      schema_version: 'household_portion_registry_v1',
      food_key: 'lime',
      aliases: [],
      usda_fdc_ids: [168155],
      household_unit: 'item',
      size_class: null,
      grams_per_unit: 67,
      quantity_behavior: 'linear',
      requires_state: null,
      excluded_states: [],
      exclude_generic_identity: false,
      authority_class: 'usda_derived',
      bounds: null,
      source: {
        kind: 'usda_fdc',
        citation: 'USDA FDC 168155 Limes, raw; portion 82570 (1 x fruit (2" dia) = 67 g); bundle usda_fdc_87c5408a3e98838944a87be74824761e',
        url: null,
        accessed: null,
      },
      reviewed_at: '2026-09-24',
      supersedes: null,
    } as HouseholdPortionRecordInput);
    expect(
      loadHouseholdPortionRegistry(readded, HOUSEHOLD_INITIAL_REGISTRY_LOCK).ok
    ).toBe(false);
  });
});

describe('phase 5 repair — census coherence and language', () => {
  it('uses the closed outcome set with non-empty reasons', () => {
    for (const entry of HOUSEHOLD_PHASE5_CANDIDATE_CENSUS) {
      expect(HOUSEHOLD_PHASE5_CENSUS_OUTCOMES).toContain(entry.outcome);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('maps every included family to exact registry keys', () => {
    const includedKeys = new Set<string>();
    for (const entry of HOUSEHOLD_PHASE5_CANDIDATE_CENSUS) {
      if (entry.outcome === 'included') {
        expect(entry.families && entry.families.length > 0).toBe(true);
        for (const family of entry.families ?? []) includedKeys.add(householdPhase5CensusKey(family));
      } else {
        expect(entry.families ?? []).toEqual([]);
      }
    }
    const recordKeys = new Set(
      verifiedRecords().map((record) =>
        householdPhase5CensusKey({
          food_key: record.food_key,
          household_unit: record.household_unit,
          size_class: record.size_class,
          requires_state: record.requires_state,
          fdc_ids: record.usda_fdc_ids,
        } as HouseholdPhase5CensusFamily)
      )
    );
    expect([...includedKeys].sort()).toEqual([...recordKeys].sort());
    expect(recordKeys.size).toBe(EXPECTED_RECORD_COUNT);
  });

  it('recomputes every census outcome count coherently', () => {
    const counts: Record<string, number> = {};
    for (const entry of HOUSEHOLD_PHASE5_CANDIDATE_CENSUS) {
      counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
    }
    expect(counts.included).toBe(9);
    expect(counts.already_resolved).toBe(10);
    expect(counts.ambiguous_or_conflicting).toBe(7);
    expect(counts.state_or_size_mismatch).toBe(4);
    expect(counts.no_authenticated_portion).toBe(7);
    expect(counts.identity_unsuitable).toBe(5);
    expect(HOUSEHOLD_PHASE5_CANDIDATE_CENSUS.length).toBe(42);
  });

  it('prevents key collisions across state and FDC dimensions', () => {
    const base: HouseholdPhase5CensusFamily = {
      food_key: 'tomato',
      household_unit: 'item',
      size_class: 'medium',
      requires_state: null,
      fdc_ids: [170457, 2709719],
    };
    const withState: HouseholdPhase5CensusFamily = { ...base, requires_state: 'raw' };
    const withOtherFdc: HouseholdPhase5CensusFamily = { ...base, fdc_ids: [170457, 2709720] };
    expect(householdPhase5CensusKey(base)).not.toBe(householdPhase5CensusKey(withState));
    expect(householdPhase5CensusKey(base)).not.toBe(householdPhase5CensusKey(withOtherFdc));

    // Registry-level proof: two records identical except required state coexist
    // and both lookups answer, so a state collision cannot silently occur.
    const recordA: HouseholdPortionRecordInput = {
      schema_version: 'household_portion_registry_v1',
      food_key: 'state probe',
      aliases: [],
      usda_fdc_ids: [9000101],
      household_unit: 'item',
      size_class: null,
      grams_per_unit: 10,
      quantity_behavior: 'linear',
      requires_state: null,
      excluded_states: [],
      exclude_generic_identity: false,
      authority_class: 'usda_derived',
      bounds: null,
      source: { kind: 'usda_fdc', citation: 'probe', url: null, accessed: null },
      reviewed_at: '2026-09-24',
      supersedes: null,
    };
    const recordB: HouseholdPortionRecordInput = { ...recordA, requires_state: 'raw' };
    const recordDigestOf = (record: HouseholdPortionRecordInput): string => {
      const validated = validateHouseholdRecord(record);
      if (!validated.ok) throw new Error('state probe invalid');
      return validated.record.record_digest;
    };
    const lock = {
      schema_version: 'household_portion_registry_v1',
      registry_release: 'state_probe',
      record_count: 2,
      registry_digest: computeHouseholdRegistryDigest('household_portion_registry_v1', 'state_probe', [
        recordDigestOf(recordA),
        recordDigestOf(recordB),
      ]),
    } as HouseholdPortionRegistryLock;
    const loaded = loadHouseholdPortionRegistry([recordA, recordB], lock);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(
      loaded.registry.findByKey({ fdc_id: 9000101, household_unit: 'item', size_class: null, requires_state: null }).ok
    ).toBe(true);
    expect(
      loaded.registry.findByKey({ fdc_id: 9000101, household_unit: 'item', size_class: null, requires_state: 'raw' }).ok
    ).toBe(true);
  });

  it('states the cucumber, cabbage/cauliflower, onion/lime, and garlic facts accurately', () => {
    const byCandidate = (needle: string) =>
      HOUSEHOLD_PHASE5_CANDIDATE_CENSUS.find((entry) => entry.candidate.includes(needle));
    const cucumber = byCandidate('cucumber');
    expect(cucumber?.reason).toContain('168409');
    expect(cucumber?.reason).toContain('301 g');
    expect(cucumber?.reason).toMatch(/peeled raw cucumber FDC 169225/i);
    expect(cucumber?.reason).not.toMatch(/only amount-bearing.*is `peeled`/i);

    const cabbage = byCandidate('SR Legacy head sizes');
    expect(cabbage?.reason).toMatch(/confirmation/i);
    expect(cabbage?.reason).not.toMatch(/resolves directly/i);
    const cauliflower = byCandidate('cauliflower');
    expect(cauliflower?.reason).toMatch(/confirmation/i);
    expect(cauliflower?.reason).not.toMatch(/resolves directly/i);

    const yellowOnion = byCandidate('yellow, whole item');
    expect(yellowOnion?.outcome).toBe('ambiguous_or_conflicting');
    expect(yellowOnion?.reason).toMatch(/specimen/i);
    const redOnion = byCandidate('red, whole item');
    expect(redOnion?.outcome).toBe('ambiguous_or_conflicting');
    const lime = byCandidate('lime');
    expect(lime?.outcome).toBe('state_or_size_mismatch');
    expect(lime?.reason).toMatch(/2-inch|2" dia/);

    const garlic = byCandidate('garlic');
    expect(garlic?.reason).toContain('169230');
    expect(garlic?.reason).toContain('1 clove = 3 g');
    expect(garlic?.reason).toContain('3 cloves = 9 g');
    expect(garlic?.reason).toMatch(/amount-less/i);
    expect(garlic?.reason).toMatch(/survey-grouping/i);
  });
});
