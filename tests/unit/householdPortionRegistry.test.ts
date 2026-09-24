/**
 * The Kitchen Codex — Household-Portion Registry Contract (registry-track Phase 4):
 * unit coverage.
 *
 * CONTRACT-ONLY: every fixture is unmistakably synthetic (food names carry a
 * `synthetic test` marker, FDC ids are in the 9000000+ range that the pinned
 * USDA bundle never uses). No fixture is production data and no test wires the
 * registry into matching, calculation, UI, AI, Apply, or persistence.
 *
 * Self-supersession and supersede cycles are cryptographically
 * unconstructible through the public API (a record digest binds the
 * `supersedes` field itself, so forging a self-reference or a mutual cycle is
 * a hash-preimage problem). The runtime guards are retained as
 * defense-in-depth; the suite proves malformed digests fail, dangling
 * cross-release references are tolerated but unresolved, and genuine
 * supersede chains coexist without replacement.
 */

import { describe, it, expect } from 'vitest';
import {
  HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
  HOUSEHOLD_FAILURE_MESSAGE,
  MAX_HOUSEHOLD_GRAMS_PER_UNIT,
  loadHouseholdPortionRegistry,
  validateHouseholdRecord,
  computeHouseholdRecordDigest,
  computeHouseholdRegistryDigest,
  type AuthenticatedHouseholdPortionRecord,
  type HouseholdFailureCode,
} from '../../src/core/nutritionV2/household/index';
import { canonicalStringify } from '../../src/core/nutritionV2/usda/digest';

const SCHEMA = HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION;
const RELEASE = 'synthetic_test_release_2026_09_a';

/** Minimal valid synthetic `usda_derived` record (raw, untrusted shape). */
function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: SCHEMA,
    food_key: 'synthetic test allium bulb',
    aliases: ['synthetic test bulb alias'],
    usda_fdc_ids: [9000001],
    household_unit: 'clove',
    size_class: null,
    grams_per_unit: 4,
    quantity_behavior: 'linear',
    requires_state: null,
    excluded_states: [],
    exclude_generic_identity: false,
    authority_class: 'usda_derived',
    bounds: null,
    source: {
      kind: 'usda_fdc',
      citation: 'Synthetic test citation for FDC 9000001.',
      url: null,
      accessed: null,
    },
    reviewed_at: '2026-09-24',
    supersedes: null,
    ...overrides,
  };
}

/** Distinct synthetic records for multi-record registries (distinct keys/labels). */
function distinctRecord(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validRecord({
    food_key: `synthetic test food ${index}`,
    aliases: [`synthetic test alias ${index}`],
    usda_fdc_ids: [9100000 + index],
    household_unit: 'item',
    grams_per_unit: 10 + (index % 9000),
    ...overrides,
  });
}

function validatedDigest(raw: unknown): string {
  const result = validateHouseholdRecord(raw);
  if (!result.ok) throw new Error(`fixture record invalid: ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  return (result as { ok: true; record: AuthenticatedHouseholdPortionRecord }).record.record_digest;
}

function buildLock(rawRecords: ReadonlyArray<unknown>, release: string = RELEASE) {
  const digests = rawRecords.map(validatedDigest);
  const registryDigest = computeHouseholdRegistryDigest(SCHEMA, release, digests);
  return {
    lock: {
      schema_version: SCHEMA,
      registry_release: release,
      record_count: rawRecords.length,
      registry_digest: registryDigest,
    },
    digests,
  };
}

function loadOk(rawRecords: ReadonlyArray<unknown>, release: string = RELEASE) {
  const { lock } = buildLock(rawRecords, release);
  const result = loadHouseholdPortionRegistry(rawRecords, lock);
  if (!result.ok) throw new Error(`expected load success, got ${(result as { ok: false; failure: { code: string } }).failure.code}`);
  return result as { ok: true; registry: import('../../src/core/nutritionV2/household/index').HouseholdPortionRegistry };
}

function failureCode(result: { ok: boolean; failure?: { code: string } }): string {
  expect(result.ok).toBe(false);
  return (result as { ok: false; failure: { code: string } }).failure.code;
}

describe('household registry — valid provenance classes', () => {
  it('loads a valid minimal usda_derived record with a locally computed digest', () => {
    const raw = validRecord();
    const validated = validateHouseholdRecord(raw);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.record.record_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(validated.record.household_unit).toBe('clove');
    expect(validated.record.usda_fdc_ids).toEqual([9000001]);

    const { registry } = loadOk([raw]);
    expect(registry.size()).toBe(1);
    expect(registry.metadata()).toEqual({
      schema_version: SCHEMA,
      registry_release: RELEASE,
      record_count: 1,
      registry_digest: registry.metadata().registry_digest,
    });
  });

  it('loads a valid vetted_standard record', () => {
    const raw = validRecord({
      food_key: 'synthetic test standard measure',
      aliases: [],
      usda_fdc_ids: [9000002],
      household_unit: 'slice',
      authority_class: 'vetted_standard',
      source: {
        kind: 'government_standard',
        citation: 'Synthetic test government standard citation.',
        url: 'https://example.test/synthetic-standard',
        accessed: '2026-09-20',
      },
    });
    const { registry } = loadOk([raw]);
    expect(registry.size()).toBe(1);
    const found = registry.findByKey({
      fdc_id: 9000002,
      household_unit: 'slice',
      size_class: null,
      requires_state: null,
    });
    expect(found.ok).toBe(true);
  });

  it('loads a valid bounded_estimate record (representation only, no authorization)', () => {
    const raw = validRecord({
      food_key: 'synthetic test estimated portion',
      aliases: [],
      usda_fdc_ids: [9000003],
      household_unit: 'piece',
      grams_per_unit: 30,
      authority_class: 'bounded_estimate',
      bounds: { min_grams: 20, max_grams: 45 },
      source: {
        kind: 'standards_body',
        citation: 'Synthetic test standards body citation.',
        url: null,
        accessed: null,
      },
    });
    const { registry } = loadOk([raw]);
    expect(registry.size()).toBe(1);
  });
});

describe('household registry — canonical normalization', () => {
  it('normalizes case, plurals, whitespace, and ordering to one canonical form', () => {
    const canonical = validateHouseholdRecord(validRecord());
    const variant = validateHouseholdRecord(
      validRecord({
        food_key: '  Synthetic   TEST Allium BULB ',
        aliases: ['SYNTHETIC   Test Bulb Alias'],
        usda_fdc_ids: [9000001, 9000001],
        household_unit: 'Cloves',
      })
    );
    expect(canonical.ok).toBe(true);
    expect(variant.ok).toBe(true);
    if (!canonical.ok || !variant.ok) return;
    expect(variant.record.food_key).toBe('synthetic test allium bulb');
    expect(variant.record.household_unit).toBe('clove');
    expect(variant.record.aliases).toEqual(['synthetic test bulb alias']);
    expect(variant.record.usda_fdc_ids).toEqual([9000001]);
    // Same semantic record -> same digest despite surface differences.
    expect(variant.record.record_digest).toBe(canonical.record.record_digest);
  });

  it('sorts FDC ids numerically and aliases/states deterministically', () => {
    const result = validateHouseholdRecord(
      validRecord({
        aliases: ['synthetic test zeta alias', 'synthetic test alpha alias'],
        usda_fdc_ids: [9000009, 9000002, 9000005],
        excluded_states: ['frozen', 'canned'],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.aliases).toEqual(['synthetic test alpha alias', 'synthetic test zeta alias']);
    expect(result.record.usda_fdc_ids).toEqual([9000002, 9000005, 9000009]);
    expect(result.record.excluded_states).toEqual(['canned', 'frozen']);
  });

  it('is independent of raw object key insertion order', () => {
    const forward = validRecord();
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(forward).reverse()) reversed[key] = forward[key];
    const a = validateHouseholdRecord(forward);
    const b = validateHouseholdRecord(reversed);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.record.record_digest).toBe(b.record.record_digest);
  });
});

describe('household registry — digest contracts', () => {
  it('is deterministic across repeated computation and input order', () => {
    const a = distinctRecord(1);
    const b = distinctRecord(2);
    const first = buildLock([a, b]);
    const second = buildLock([b, a]);
    expect(first.lock.registry_digest).toBe(second.lock.registry_digest);
    const direct = computeHouseholdRegistryDigest(SCHEMA, RELEASE, [first.digests[0], first.digests[1]]);
    expect(direct).toBe(first.lock.registry_digest);
  });

  it('changes the record digest for every semantic field', () => {
    const base = validatedDigest(validRecord());
    const cases: Array<[string, Record<string, unknown>]> = [
      ['food_key', { food_key: 'synthetic test allium root' }],
      ['alias', { aliases: ['synthetic test other alias'] }],
      ['fdc_id', { usda_fdc_ids: [9000007] }],
      ['unit', { household_unit: 'slice' }],
      ['size', { size_class: 'medium' }],
      ['grams', { grams_per_unit: 5 }],
      ['requires_state', { requires_state: 'raw' }],
      ['excluded_state', { excluded_states: ['drained'] }],
      ['generic_identity', { exclude_generic_identity: true }],
      ['source_citation', { source: { kind: 'usda_fdc', citation: 'Synthetic test other citation.', url: null, accessed: null } }],
      ['source_url', { source: { kind: 'usda_fdc', citation: 'Synthetic test citation for FDC 9000001.', url: 'https://example.test/synthetic', accessed: null } }],
      ['source_accessed', { source: { kind: 'usda_fdc', citation: 'Synthetic test citation for FDC 9000001.', url: null, accessed: '2026-09-20' } }],
      ['reviewed_at', { reviewed_at: '2026-09-23' }],
      ['supersedes', { supersedes: 'a'.repeat(64) }],
      ['bounds_window', {
        authority_class: 'bounded_estimate',
        grams_per_unit: 30,
        bounds: { min_grams: 20, max_grams: 45 },
        source: { kind: 'standards_body', citation: 'Synthetic test standards body citation.', url: null, accessed: null },
      }],
    ];
    for (const [label, overrides] of cases) {
      const digest = validatedDigest(validRecord(overrides));
      expect(digest, label).not.toBe(base);
    }

    // Fields with a single valid value still bind into the digest payload.
    const canonicalBase = validateHouseholdRecord(validRecord());
    expect(canonicalBase.ok).toBe(true);
    if (!canonicalBase.ok) return;
    const { record_digest: _ignored, ...semantic } = canonicalBase.record;
    const quantityVariant = computeHouseholdRecordDigest({ ...semantic, quantity_behavior: 'nonlinear' } as never);
    expect(quantityVariant).not.toBe(base);
    const schemaVariant = computeHouseholdRecordDigest({ ...semantic, schema_version: 'household_portion_registry_v2' } as never);
    expect(schemaVariant).not.toBe(base);
    const classVariant = computeHouseholdRecordDigest({ ...semantic, authority_class: 'vetted_standard' } as never);
    expect(classVariant).not.toBe(base);
    const kindVariant = computeHouseholdRecordDigest({
      ...semantic,
      source: { ...semantic.source, kind: 'government_standard' },
    });
    expect(kindVariant).not.toBe(base);
  });

  it('binds the release identifier into the registry digest', () => {
    const records = [distinctRecord(1), distinctRecord(2)];
    const a = buildLock(records, 'synthetic_test_release_a');
    const b = buildLock(records, 'synthetic_test_release_b');
    expect(a.lock.registry_digest).not.toBe(b.lock.registry_digest);
    // A lock with an altered release but a stale digest fails closed.
    const tampered = { ...a.lock, registry_release: 'synthetic_test_release_b' };
    const result = loadHouseholdPortionRegistry(records, tampered);
    expect(failureCode(result)).toBe('registry_digest_mismatch');
  });
});

describe('household registry — release lock and count', () => {
  it('verifies the exact release lock and rejects forged digests', () => {
    const records = [distinctRecord(1)];
    const { lock } = buildLock(records);
    expect(loadHouseholdPortionRegistry(records, lock).ok).toBe(true);
    const forged = { ...lock, registry_digest: 'b'.repeat(64) };
    expect(failureCode(loadHouseholdPortionRegistry(records, forged))).toBe('registry_digest_mismatch');
  });

  it('rejects a wrong record count', () => {
    const records = [distinctRecord(1), distinctRecord(2)];
    const { lock } = buildLock(records);
    expect(failureCode(loadHouseholdPortionRegistry(records, { ...lock, record_count: 1 }))).toBe(
      'record_count_mismatch'
    );
    expect(failureCode(loadHouseholdPortionRegistry(records, { ...lock, record_count: 3 }))).toBe(
      'record_count_mismatch'
    );
  });

  it('rejects a wrong schema version in records and in the lock', () => {
    const records = [distinctRecord(1)];
    const { lock } = buildLock(records);
    const badRecord = loadHouseholdPortionRegistry(
      [{ ...distinctRecord(1), schema_version: 'household_portion_registry_v2' }],
      lock
    );
    expect(failureCode(badRecord)).toBe('invalid_schema_version');
    const badLock = loadHouseholdPortionRegistry(records, { ...lock, schema_version: 'household_portion_registry_v2' });
    expect(failureCode(badLock)).toBe('invalid_schema_version');
  });
});

describe('household registry — immutable lookup', () => {
  it('finds records by exact FDC/unit/size/state dimensions', () => {
    const records = [
      distinctRecord(1, { household_unit: 'slice', size_class: 'large', requires_state: 'raw' }),
      distinctRecord(2, { household_unit: 'slice', size_class: null, requires_state: null }),
    ];
    const { registry } = loadOk(records);
    const hit = registry.findByKey({
      fdc_id: 9100001,
      household_unit: 'slices',
      size_class: 'large',
      requires_state: 'raw',
    });
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.record.size_class).toBe('large');
    const missSize = registry.findByKey({
      fdc_id: 9100001,
      household_unit: 'slice',
      size_class: null,
      requires_state: 'raw',
    });
    expect(failureCode(missSize)).toBe('not_found');
    const missState = registry.findByKey({
      fdc_id: 9100001,
      household_unit: 'slice',
      size_class: 'large',
      requires_state: 'cooked',
    });
    expect(failureCode(missState)).toBe('not_found');
  });

  it('finds records by digest for audit/provenance', () => {
    const records = [distinctRecord(1)];
    const { registry, } = loadOk(records);
    const { digests } = buildLock(records);
    const hit = registry.findByDigest(digests[0]);
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.record.food_key).toBe('synthetic test food 1');
    expect(failureCode(registry.findByDigest('c'.repeat(64)))).toBe('not_found');
    expect(failureCode(registry.findByDigest('not-a-digest'))).toBe('invalid_digest');
  });

  it('returns deeply frozen structures that later lookups cannot be influenced by', () => {
    const { registry } = loadOk([distinctRecord(1), distinctRecord(2)]);
    const records = registry.records();
    expect(Object.isFrozen(records)).toBe(true);
    for (const record of records) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.aliases)).toBe(true);
      expect(Object.isFrozen(record.usda_fdc_ids)).toBe(true);
      expect(Object.isFrozen(record.source)).toBe(true);
    }
    expect(() => {
      (records as Array<unknown>).push(validRecord());
    }).toThrow();
    expect(() => {
      ((records[0] as unknown as Record<string, unknown>).food_key as unknown) = 'mutated';
    }).toThrow();
    expect(registry.size()).toBe(2);
    const hit = registry.findByKey({
      fdc_id: 9100001,
      household_unit: 'item',
      size_class: null,
      requires_state: null,
    });
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(Object.isFrozen(hit.record)).toBe(true);
  });

  it('produces content-identical results on repeated loads', () => {
    const records = [distinctRecord(2), distinctRecord(1)];
    const first = loadOk(records);
    const second = loadOk(records);
    expect(canonicalStringify(first.registry.records())).toBe(canonicalStringify(second.registry.records()));
    expect(first.registry.metadata()).toEqual(second.registry.metadata());
  });
});

describe('household registry — supersedes and empty policy', () => {
  it('coexists superseded and superseding records without replacement', () => {
    const oldRaw = distinctRecord(1);
    const oldDigest = validatedDigest(oldRaw);
    const newRaw = distinctRecord(2, { supersedes: oldDigest });
    const { registry } = loadOk([oldRaw, newRaw]);
    expect(registry.size()).toBe(2);
    expect(registry.findByDigest(oldDigest).ok).toBe(true);
    const newDigest = validatedDigest(newRaw);
    const found = registry.findByDigest(newDigest);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.record.supersedes).toBe(oldDigest);
  });

  it('rejects malformed supersedes digests', () => {
    const { lock } = buildLock([validRecord()]);
    const bad = validRecord({
      food_key: 'synthetic test other food',
      aliases: [],
      usda_fdc_ids: [9000002],
      supersedes: 'xyz',
    });
    const result = loadHouseholdPortionRegistry([bad], lock);
    expect(failureCode(result)).toBe('invalid_record');
  });

  it('loads an explicitly empty registry (count zero) with honest empty lookups', () => {
    const { lock } = buildLock([]);
    const result = loadHouseholdPortionRegistry([], lock);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.size()).toBe(0);
    expect(result.registry.records()).toEqual([]);
    expect(result.registry.metadata().record_count).toBe(0);
    expect(
      failureCode(
        result.registry.findByKey({ fdc_id: 9000001, household_unit: 'clove', size_class: null, requires_state: null })
      )
    ).toBe('not_found');
  });
});

describe('household registry — maximum valid boundary values', () => {
  it('accepts maximum boundary values and rejects just-over values', () => {
    const maxed = validRecord({
      food_key: 'k'.repeat(200),
      aliases: Array.from({ length: 16 }, (_, i) => `synthetic test alias ${i}`),
      usda_fdc_ids: Array.from({ length: 16 }, (_, i) => 9200001 + i),
      grams_per_unit: MAX_HOUSEHOLD_GRAMS_PER_UNIT,
      excluded_states: ['raw', 'cooked', 'canned', 'drained', 'undrained', 'fresh', 'dried', 'frozen'],
      source: {
        kind: 'usda_fdc',
        citation: 'c'.repeat(500),
        url: `https://example.test/${'s'.repeat(300 - 'https://example.test/'.length)}`,
        accessed: '2024-02-29',
      },
    });
    expect(validateHouseholdRecord(maxed).ok).toBe(true);

    expect(validatedDigest(validRecord({ grams_per_unit: 0.000001 }))).toMatch(/^[0-9a-f]{64}$/);
    for (const grams of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_HOUSEHOLD_GRAMS_PER_UNIT + 1, 0.0000001]) {
      const result = validateHouseholdRecord(validRecord({ grams_per_unit: grams }));
      expect(failureCode(result), `grams=${String(grams)}`).toBe('invalid_grams');
    }
    expect(failureCode(validateHouseholdRecord(validRecord({ food_key: 'k'.repeat(201) })))).toBe('invalid_record');
    expect(
      failureCode(
        validateHouseholdRecord(validRecord({ aliases: Array.from({ length: 17 }, (_, i) => `synthetic alias ${i}`) }))
      )
    ).toBe('invalid_record');
    expect(
      failureCode(
        validateHouseholdRecord(validRecord({ usda_fdc_ids: Array.from({ length: 17 }, (_, i) => 9300001 + i) }))
      )
    ).toBe('invalid_record');
  });

  it('accepts a maximum-length release and rejects longer ones', () => {
    const records = [distinctRecord(1)];
    const release64 = 'r'.repeat(64);
    const { lock } = buildLock(records, release64);
    expect(loadHouseholdPortionRegistry(records, lock).ok).toBe(true);
    expect(loadHouseholdPortionRegistry(records, { ...lock, registry_release: 'r'.repeat(65) }).ok).toBe(false);
  });
});

describe('household registry — input safety and closed codes', () => {
  it('never mutates its input and accepts frozen input', () => {
    const raw = validRecord();
    const snapshot = JSON.parse(JSON.stringify(raw)) as unknown;
    const frozen = Object.freeze(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>);
    expect(validateHouseholdRecord(frozen).ok).toBe(true);
    const { lock } = buildLock([raw]);
    expect(loadHouseholdPortionRegistry([raw], lock).ok).toBe(true);
    expect(raw).toEqual(snapshot);
  });

  it('returns only closed failure codes with fixed input-redacted messages', () => {
    const failing: unknown[][] = [
      [validRecord({ household_unit: 'can' }), buildLock([validRecord()]).lock],
      [[{ ...validRecord(), grams_per_unit: -3 }], buildLock([validRecord()]).lock],
      [[validRecord()], { ...buildLock([validRecord()]).lock, record_count: 9 }],
    ];
    for (const [records, lock] of failing) {
      const result = loadHouseholdPortionRegistry(records, lock);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const { code, message } = (
        result as { ok: false; failure: { code: HouseholdFailureCode; message: string } }
      ).failure;
      expect(Object.keys(HOUSEHOLD_FAILURE_MESSAGE)).toContain(code);
      expect(message).toBe(HOUSEHOLD_FAILURE_MESSAGE[code as HouseholdFailureCode]);
      expect(message.length).toBeLessThanOrEqual(120);
      expect(message).not.toContain('synthetic');
    }
  });
});
