/**
 * The Kitchen Codex — Household-Portion Registry Contract (registry-track Phase 4):
 * adversarial coverage plus security/isolation proof.
 *
 * All fixtures are unmistakably synthetic (`synthetic test` markers, FDC ids
 * 9000000+). This file proves hostile input fails closed, the module graph is
 * dependency-clean, no runtime consumer exists, no production data ships, no
 * security bound moved, and no mutable registration API exists.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION,
  loadHouseholdPortionRegistry,
  validateHouseholdRecord,
  computeHouseholdRegistryDigest,
  type HouseholdFailureCode,
  type HouseholdRegistryResult,
} from '../../src/core/nutritionV2/household/index';
import * as householdIndex from '../../src/core/nutritionV2/household/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const HOUSEHOLD_DIR = resolve(ROOT, 'src/core/nutritionV2/household');
const SCHEMA = HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION;
const RELEASE = 'synthetic_test_security_release';

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

function buildLock(rawRecords: ReadonlyArray<unknown>) {
  const digests = rawRecords.map((raw) => {
    const result = validateHouseholdRecord(raw);
    if (!result.ok) throw new Error('fixture invalid');
    return (result as { ok: true; record: { record_digest: string } }).record.record_digest;
  });
  return {
    schema_version: SCHEMA,
    registry_release: RELEASE,
    record_count: rawRecords.length,
    registry_digest: computeHouseholdRegistryDigest(SCHEMA, RELEASE, digests),
  };
}

function failureOf(result: HouseholdRegistryResult, label?: string): { code: HouseholdFailureCode; message: string } {
  // NOTE: the repo typechecks with `strict: false`, so discriminant narrowing
  // on the failure branch is unavailable; the assertion plus cast is sound.
  expect(result.ok, label).toBe(false);
  return (result as { ok: false; failure: { code: HouseholdFailureCode; message: string } }).failure;
}

function recordFails(overrides: Record<string, unknown>, expected: HouseholdFailureCode, label?: string): void {
  const good = validRecord();
  const lock = buildLock([good]);
  const bad = validRecord(overrides);
  const result = loadHouseholdPortionRegistry([bad], lock);
  const failure = failureOf(result, label ?? JSON.stringify(overrides));
  expect(failure.code, label ?? JSON.stringify(overrides)).toBe(expected);
  expect(failure.message).toBe(`household_${expected}`);
}

describe('household registry — adversarial record shapes', () => {
  it('rejects unknown keys at every nesting level', () => {
    recordFails({ extra_field: 1 }, 'invalid_record', 'top-level unknown key');
    recordFails(
      { source: { kind: 'usda_fdc', citation: 'Synthetic test citation.', url: null, accessed: null, extra: 1 } },
      'invalid_source',
      'source unknown key'
    );
    recordFails(
      {
        authority_class: 'bounded_estimate',
        grams_per_unit: 30,
        bounds: { min_grams: 20, max_grams: 45, extra: 1 },
        source: { kind: 'standards_body', citation: 'Synthetic test citation.', url: null, accessed: null },
      },
      'invalid_authority',
      'bounds unknown key'
    );
    const good = validRecord();
    const lock = buildLock([good]);
    const missing = { ...good };
    delete (missing as Record<string, unknown>).food_key;
    expect(loadHouseholdPortionRegistry([missing], lock).ok).toBe(false);
    expect(loadHouseholdPortionRegistry([good], { ...lock, unexpected: 1 }).ok).toBe(false);
  });

  it('rejects wrong scalar types and shape swaps', () => {
    recordFails({ grams_per_unit: '4' }, 'invalid_grams', 'string grams');
    recordFails({ grams_per_unit: true }, 'invalid_grams', 'boolean grams');
    recordFails({ household_unit: 5 }, 'invalid_unit', 'numeric unit');
    recordFails({ aliases: 'x' }, 'invalid_record', 'string aliases');
    recordFails({ aliases: {} }, 'invalid_record', 'object aliases');
    recordFails({ usda_fdc_ids: {} }, 'invalid_record', 'object fdc ids');
    recordFails({ usda_fdc_ids: '9000001' }, 'invalid_record', 'string fdc ids');
    recordFails({ usda_fdc_ids: [0] }, 'invalid_record', 'zero fdc id');
    recordFails({ usda_fdc_ids: [-3] }, 'invalid_record', 'negative fdc id');
    recordFails({ usda_fdc_ids: [1.5] }, 'invalid_record', 'fractional fdc id');
    recordFails({ usda_fdc_ids: [] }, 'invalid_record', 'empty fdc ids');
    recordFails({ source: [] }, 'invalid_source', 'array source');
    recordFails(
      {
        authority_class: 'bounded_estimate',
        grams_per_unit: 30,
        bounds: [],
        source: { kind: 'standards_body', citation: 'Synthetic test citation.', url: null, accessed: null },
      },
      'invalid_authority',
      'array bounds'
    );
    recordFails({ quantity_behavior: 'nonlinear' }, 'invalid_record', 'nonlinear behavior');
    recordFails({ exclude_generic_identity: 'yes' }, 'invalid_record', 'string boolean');
    recordFails({ size_class: 5 }, 'invalid_size', 'numeric size');
    recordFails({ requires_state: 5 }, 'invalid_state', 'numeric state');
  });

  it('rejects non-positive/non-finite grams and excessive grams', () => {
    for (const grams of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, -5, 10001, 1e9]) {
      recordFails({ grams_per_unit: grams }, 'invalid_grams', `grams=${String(grams)}`);
    }
  });

  it('rejects containers, mass/volume units, and unknown units', () => {
    for (const unit of ['can', 'cans', 'package', 'jar', 'box', 'bag', 'bottle', 'gram', 'g', 'kg', 'cup', 'ml', 'wibble', '']) {
      recordFails({ household_unit: unit }, 'invalid_unit', `unit=${unit}`);
    }
  });

  it('rejects bad sizes and states', () => {
    recordFails({ size_class: 'huge' }, 'invalid_size', 'unknown size');
    recordFails({ size_class: 'miniature' }, 'invalid_size', 'size alias not canonical');
    recordFails({ requires_state: 'rotten' }, 'invalid_state', 'unknown state');
    recordFails({ excluded_states: ['rotten'] }, 'invalid_state', 'unknown excluded state');
    recordFails({ requires_state: 'raw', excluded_states: ['raw'] }, 'invalid_state', 'required+excluded contradiction');
    recordFails({ requires_state: 'raw', excluded_states: ['cooked', 'raw'] }, 'invalid_state', 'contradiction in list');
  });

  it('rejects invalid bounds and class/bounds mismatches', () => {
    const estimateSource = { kind: 'standards_body', citation: 'Synthetic test citation.', url: null, accessed: null };
    const asEstimate = (bounds: unknown, grams = 30) =>
      validRecord({ authority_class: 'bounded_estimate', grams_per_unit: grams, bounds, source: estimateSource });
    const good = validRecord();
    const lock = buildLock([good]);
    const expectAuthority = (raw: unknown, label: string) => {
      const result = loadHouseholdPortionRegistry([raw], lock);
      expect(result.ok, label).toBe(false);
      expect(failureOf(result, label).code).toBe('invalid_authority');
    };
    expectAuthority(asEstimate({ min_grams: 45, max_grams: 20 }), 'reversed bounds');
    expectAuthority(asEstimate({ min_grams: 20, max_grams: 20 }), 'degenerate bounds');
    expectAuthority(asEstimate({ min_grams: 10, max_grams: 20 }, 4), 'bounds excluding estimate');
    expectAuthority(asEstimate({ min_grams: -5, max_grams: 20 }), 'negative bound');
    expectAuthority(asEstimate({ min_grams: 'a', max_grams: 20 }), 'string bound');
    recordFails({ bounds: { min_grams: 1, max_grams: 5 } }, 'invalid_authority', 'bounds on usda_derived');
    recordFails(
      {
        authority_class: 'vetted_standard',
        bounds: { min_grams: 1, max_grams: 5 },
        source: { kind: 'government_standard', citation: 'Synthetic test citation.', url: null, accessed: null },
      },
      'invalid_authority',
      'bounds on vetted_standard'
    );
    recordFails(
      {
        authority_class: 'bounded_estimate',
        bounds: null,
        source: { kind: 'government_standard', citation: 'Synthetic test citation.', url: null, accessed: null },
      },
      'invalid_authority',
      'missing bounds on estimate'
    );
    recordFails(
      { source: { kind: 'government_standard', citation: 'Synthetic test citation.', url: null, accessed: null } },
      'invalid_authority',
      'usda_derived with government source'
    );
    recordFails(
      {
        authority_class: 'vetted_standard',
        source: { kind: 'usda_fdc', citation: 'Synthetic test citation.', url: null, accessed: null },
      },
      'invalid_authority',
      'vetted_standard with usda source'
    );
    recordFails(
      {
        authority_class: 'bounded_estimate',
        grams_per_unit: 30,
        bounds: { min_grams: 20, max_grams: 45 },
        source: { kind: 'usda_fdc', citation: 'Synthetic test citation.', url: null, accessed: null },
      },
      'invalid_authority',
      'estimate with usda source'
    );
  });

  it('rejects bad sources, dates, and URLs', () => {
    recordFails({ source: { kind: 'web_recipe', citation: 'x', url: null, accessed: null } }, 'invalid_source', 'web source');
    recordFails({ source: { kind: 'manufacturer_package', citation: 'x', url: null, accessed: null } }, 'invalid_source', 'package source');
    recordFails({ source: { kind: 'usda_fdc', citation: '', url: null, accessed: null } }, 'invalid_source', 'empty citation');
    recordFails({ source: { kind: 'usda_fdc', citation: '   ', url: null, accessed: null } }, 'invalid_source', 'blank citation');
    recordFails({ source: { kind: 'usda_fdc', citation: 'c'.repeat(501), url: null, accessed: null } }, 'invalid_source', 'oversized citation');
    for (const url of [
      'http://example.test/synthetic',
      'file:///tmp/synthetic',
      'data:text/plain,synthetic',
      'https://user:pass@example.test/synthetic',
      'https://example.test/syn thetic',
      'https://example.test/' + 's'.repeat(300),
      'not a url',
      42,
    ]) {
      recordFails(
        { source: { kind: 'usda_fdc', citation: 'Synthetic test citation.', url, accessed: null } },
        'invalid_source',
        `url=${String(url).slice(0, 40)}`
      );
    }
    recordFails(
      { source: { kind: 'usda_fdc', citation: 'Synthetic test citation.', url: null, accessed: '20-09-2026' } },
      'invalid_source',
      'bad accessed format'
    );
    recordFails(
      { source: { kind: 'usda_fdc', citation: 'Synthetic test citation.', url: null, accessed: '2026-02-30' } },
      'invalid_source',
      'impossible accessed date'
    );
    for (const date of ['2026-13-01', '2026-00-10', '2026-02-29', '2026-04-31', '2026-09-24T00:00:00.000Z', '2026-9-4', '1899-01-01', '2101-01-01', 20260924]) {
      recordFails({ reviewed_at: date }, 'invalid_date', `date=${String(date)}`);
    }
    const leap = validateHouseholdRecord(validRecord({ reviewed_at: '2024-02-29' }));
    expect(leap.ok).toBe(true);
  });

  it('rejects bad labels, aliases, and FDC lists', () => {
    recordFails({ food_key: '' }, 'invalid_record', 'empty key');
    recordFails({ food_key: '   ' }, 'invalid_record', 'blank key');
    recordFails({ food_key: '__proto__' }, 'invalid_record', 'proto key');
    recordFails({ food_key: 'constructor' }, 'invalid_record', 'constructor key');
    recordFails({ food_key: 'k'.repeat(201) }, 'invalid_record', 'oversized key');
    recordFails({ food_key: Array.from({ length: 13 }, () => 'synthetic').join(' ') }, 'invalid_record', 'too many tokens');
    recordFails({ food_key: 'synthetic\0test' }, 'invalid_record', 'control character');
    recordFails({ aliases: [5] }, 'invalid_record', 'numeric alias');
    recordFails({ aliases: [''] }, 'invalid_record', 'empty alias');
    recordFails({ aliases: ['__proto__'] }, 'invalid_record', 'proto alias');
    recordFails(
      { aliases: Array.from({ length: 17 }, (_, i) => `synthetic alias ${i}`) },
      'invalid_record',
      'too many aliases'
    );
    recordFails({ usda_fdc_ids: ['9000001'] }, 'invalid_record', 'string fdc id');
    // Within-record duplicates after normalization are deduplicated (allowed).
    const deduped = validateHouseholdRecord(validRecord({ aliases: ['Synthetic Test Bulb Alias', 'synthetic test bulb alias'] }));
    expect(deduped.ok).toBe(true);
    const dedupedIds = validateHouseholdRecord(validRecord({ usda_fdc_ids: [9000001, 9000001] }));
    expect(dedupedIds.ok).toBe(true);
  });

  it('requires exact equality for declared record digests', () => {
    const good = validRecord();
    const lock = buildLock([good]);
    const validated = validateHouseholdRecord(good);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const digest = validated.record.record_digest;
    const exact = loadHouseholdPortionRegistry([{ ...good, record_digest: digest }], lock);
    expect(exact.ok).toBe(true);
    const forged = 'a'.repeat(63) + (digest.endsWith('a') ? 'b' : 'a');
    const forgedResult = loadHouseholdPortionRegistry([{ ...good, record_digest: forged }], lock);
    expect(forgedResult.ok).toBe(false);
    expect(failureOf(forgedResult).code).toBe('record_digest_mismatch');
    const malformed = loadHouseholdPortionRegistry([{ ...good, record_digest: 'xyz' }], lock);
    expect(malformed.ok).toBe(false);
    expect(failureOf(malformed).code).toBe('invalid_digest');
    const upper = loadHouseholdPortionRegistry([{ ...good, record_digest: digest.toUpperCase() }], lock);
    expect(upper.ok).toBe(false);
    expect(failureOf(upper).code).toBe('invalid_digest');
  });
});

describe('household registry — adversarial registry structure', () => {
  it('rejects duplicate records and conflicting lookup keys', () => {
    const a = distinctRecord(1);
    const lock = buildLock([a, a]);
    const dup = loadHouseholdPortionRegistry([a, a], lock);
    expect(dup.ok).toBe(false);
    expect(failureOf(dup).code).toBe('duplicate_record');

    const gramsA = distinctRecord(1, { grams_per_unit: 10 });
    const gramsB = distinctRecord(1, {
      food_key: 'synthetic test other food',
      aliases: ['synthetic test other alias'],
      grams_per_unit: 11,
    });
    const lock2 = buildLock([gramsA, gramsB]);
    const conflict = loadHouseholdPortionRegistry([gramsA, gramsB], lock2);
    expect(conflict.ok).toBe(false);
    expect(failureOf(conflict).code).toBe('duplicate_record');

    const derived = distinctRecord(1);
    const vetted = distinctRecord(1, {
      food_key: 'synthetic test vetted food',
      aliases: ['synthetic test vetted alias'],
      grams_per_unit: 12,
      authority_class: 'vetted_standard',
      source: { kind: 'government_standard', citation: 'Synthetic test citation.', url: null, accessed: null },
    });
    const lock3 = buildLock([derived, vetted]);
    const classConflict = loadHouseholdPortionRegistry([derived, vetted], lock3);
    expect(classConflict.ok).toBe(false);
    expect(failureOf(classConflict).code).toBe('duplicate_record');

    // Coexistable: same food identity, distinct units -> distinct lookup keys.
    const clove = validRecord();
    const slice = validRecord({ household_unit: 'slice', grams_per_unit: 28, aliases: [] });
    const { lock: coexistLock } = (() => {
      const digests = [clove, slice].map((raw) => {
        const result = validateHouseholdRecord(raw);
        if (!result.ok) throw new Error('fixture invalid');
        return (result as { ok: true; record: { record_digest: string } }).record.record_digest;
      });
      return {
        lock: {
          schema_version: SCHEMA,
          registry_release: RELEASE,
          record_count: 2,
          registry_digest: computeHouseholdRegistryDigest(SCHEMA, RELEASE, digests),
        },
      };
    })();
    const coexist = loadHouseholdPortionRegistry([clove, slice], coexistLock);
    expect(coexist.ok).toBe(true);
  });

  it('rejects alias collisions and food-key reuse with incompatible FDC constraints', () => {
    const a = distinctRecord(1, { aliases: ['synthetic test shared alias'] });
    const b = distinctRecord(2, { aliases: ['synthetic test shared alias'] });
    const lock = buildLock([a, b]);
    const collision = loadHouseholdPortionRegistry([a, b], lock);
    expect(collision.ok).toBe(false);
    expect(failureOf(collision).code).toBe('alias_collision');

    const c = distinctRecord(3);
    const d = distinctRecord(4, { aliases: ['synthetic test food 3'] });
    const lock2 = buildLock([c, d]);
    const labelCollision = loadHouseholdPortionRegistry([c, d], lock2);
    expect(labelCollision.ok).toBe(false);
    expect(failureOf(labelCollision).code).toBe('alias_collision');

    const e = distinctRecord(5, { food_key: 'synthetic test reused key' });
    const f = distinctRecord(6, { food_key: 'synthetic test reused key' });
    const lock3 = buildLock([e, f]);
    const reuse = loadHouseholdPortionRegistry([e, f], lock3);
    expect(reuse.ok).toBe(false);
    expect(failureOf(reuse).code).toBe('duplicate_record');
  });

  it('rejects hostile objects without invoking attacker code', () => {
    const good = validRecord();
    const lock = buildLock([good]);

    let invocations = 0;
    const getterRecord = validRecord();
    Object.defineProperty(getterRecord, 'grams_per_unit', {
      enumerable: true,
      configurable: true,
      get() {
        invocations += 1;
        return 4;
      },
    });
    const getterResult = loadHouseholdPortionRegistry([getterRecord], lock);
    expect(getterResult.ok).toBe(false);
    expect(failureOf(getterResult).code).toBe('invalid_record');
    expect(invocations).toBe(0);

    const symbolRecord = validRecord() as Record<string | symbol, unknown>;
    symbolRecord[Symbol('synthetic')] = 1;
    const symbolResult = loadHouseholdPortionRegistry([symbolRecord], lock);
    expect(symbolResult.ok).toBe(false);

    const protoRecord = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    Object.defineProperty(protoRecord, '__proto__', {
      value: { syntheticPolluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const protoResult = loadHouseholdPortionRegistry([protoRecord], lock);
    expect(protoResult.ok).toBe(false);
    expect(({} as Record<string, unknown>).syntheticPolluted).toBeUndefined();

    const cyclic = validRecord() as Record<string, unknown>;
    (cyclic as Record<string, unknown>).self = cyclic;
    const cyclicResult = loadHouseholdPortionRegistry([cyclic], lock);
    expect(cyclicResult.ok).toBe(false);

    let nested: unknown = 'synthetic test deep alias';
    for (let depth = 0; depth < 20; depth += 1) nested = [nested];
    const deepResult = loadHouseholdPortionRegistry([validRecord({ aliases: nested })], lock);
    expect(deepResult.ok).toBe(false);

    const throwingRecord = new Proxy(validRecord(), {
      getOwnPropertyDescriptor() {
        throw new Error('synthetic attacker trap');
      },
    });
    const proxyResult = loadHouseholdPortionRegistry([throwingRecord], lock);
    const proxyFailure = failureOf(proxyResult);
    expect(proxyFailure.message).toBe('household_invalid_record');
    expect(proxyFailure.message).not.toContain('attacker');

    const throwingArray = new Proxy([], {
      getPrototypeOf() {
        throw new Error('synthetic array trap');
      },
    });
    const arrayResult = loadHouseholdPortionRegistry(throwingArray, lock);
    expect(arrayResult.ok).toBe(false);
    expect(failureOf(arrayResult).code).toBe('invalid_input');
  });

  it('rejects excessive records and excessive total bytes', () => {
    const many = Array.from({ length: 1001 }, (_, i) => distinctRecord(i));
    const digests = many.map((raw) => {
      const result = validateHouseholdRecord(raw);
      if (!result.ok) throw new Error('fixture invalid');
      return (result as { ok: true; record: { record_digest: string } }).record.record_digest;
    });
    const bigLock = {
      schema_version: SCHEMA,
      registry_release: RELEASE,
      record_count: many.length,
      registry_digest: computeHouseholdRegistryDigest(SCHEMA, RELEASE, digests),
    };
    const tooMany = loadHouseholdPortionRegistry(many, bigLock);
    expect(tooMany.ok).toBe(false);
    expect(failureOf(tooMany).code).toBe('registry_too_large');

    const bulky = Array.from({ length: 900 }, (_, i) => {
      const base = `Synthetic test bulk citation ${i} `;
      return distinctRecord(5000 + i, {
        household_unit: 'piece',
        grams_per_unit: 100,
        source: { kind: 'usda_fdc', citation: base + 'x'.repeat(500 - base.length), url: null, accessed: null },
      });
    });
    const bulkyDigests = bulky.map((raw) => {
      const result = validateHouseholdRecord(raw);
      if (!result.ok) throw new Error('bulky fixture invalid');
      return (result as { ok: true; record: { record_digest: string } }).record.record_digest;
    });
    const bulkyLock = {
      schema_version: SCHEMA,
      registry_release: RELEASE,
      record_count: bulky.length,
      registry_digest: computeHouseholdRegistryDigest(SCHEMA, RELEASE, bulkyDigests),
    };
    const tooBig = loadHouseholdPortionRegistry(bulky, bulkyLock);
    expect(tooBig.ok).toBe(false);
    expect(failureOf(tooBig).code).toBe('registry_too_large');
  });

  it('rejects malformed locks and forged registry digests', () => {
    const records = [distinctRecord(1)];
    const lock = buildLock(records);
    expect(loadHouseholdPortionRegistry(records, { ...lock, registry_digest: 'd'.repeat(64) }).ok).toBe(false);
    const forged = loadHouseholdPortionRegistry(records, { ...lock, registry_digest: 'd'.repeat(64) });
    expect(failureOf(forged).code).toBe('registry_digest_mismatch');
    expect(loadHouseholdPortionRegistry(records, { ...lock, registry_digest: 'xyz' }).ok).toBe(false);
    expect(loadHouseholdPortionRegistry(records, { ...lock, registry_release: '' }).ok).toBe(false);
    expect(loadHouseholdPortionRegistry(records, { ...lock, registry_release: 'bad/release' }).ok).toBe(false);
    expect(loadHouseholdPortionRegistry(records, { ...lock, record_count: '1' }).ok).toBe(false);
    expect(loadHouseholdPortionRegistry(records, null).ok).toBe(false);
    expect(loadHouseholdPortionRegistry('x' as unknown, lock).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolation and purity
// ---------------------------------------------------------------------------

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const HOUSEHOLD_FILES = listFiles(HOUSEHOLD_DIR);
const HOUSEHOLD_SOURCES = HOUSEHOLD_FILES.map((file) => ({ file, source: stripComments(readFileSync(file, 'utf8')) }));

function resolveProjectSpecifier(fromFile: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith('@/')) base = resolve(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null;
  const candidates = [`${base}.ts`, join(base, 'index.ts')];
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const candidate of candidates) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function collectTransitiveGraph(entries: ReadonlyArray<string>): Set<string> {
  const visited = new Set<string>();
  const queue = [...entries];
  const patterns = [/(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const resolved = resolveProjectSpecifier(file, match[1]);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return visited;
}

describe('household registry — module purity', () => {
  it('contains no network, filesystem, environment, time, randomness, or persistence token', () => {
    const tokens = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\baxios\b/,
      /node:(fs|path|http|https|net|dns|tls|os|process|child_process)\b/,
      /process\s*\.\s*env/,
      /localStorage/,
      /sessionStorage/,
      /indexedDB/,
      /\bMath\.random\b/,
      /\bDate\.now\b/,
      /new\s+Date\s*\(/,
      /\bperformance\.now\b/,
      /globalThis\.crypto/,
      /codex_nutrition/,
      /vaultFileSystem/,
      /vaultAssets/,
      /nutritionEstimator/,
      /nutritionCache/,
    ];
    for (const { file, source } of HOUSEHOLD_SOURCES) {
      for (const token of tokens) {
        expect(source, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('reaches only the declared dependency-safe helpers', () => {
    const graph = collectTransitiveGraph(HOUSEHOLD_FILES);
    const rels = new Set(Array.from(graph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/')));
    const expected = new Set([
      'src/core/nutritionV2/household/index.ts',
      'src/core/nutritionV2/household/types.ts',
      'src/core/nutritionV2/household/normalize.ts',
      'src/core/nutritionV2/household/digest.ts',
      'src/core/nutritionV2/household/registry.ts',
      // Registry-track Phase 5 data slice (data/provenance only; contract deps only).
      'src/core/nutritionV2/household/initialData.ts',
      'src/core/nutritionV2/household/initialLock.ts',
      'src/core/nutritionV2/household/initialProvenance.ts',
      'src/core/nutritionV2/usda/digest.ts',
      'src/core/nutritionV2/units.ts',
      'src/core/nutritionV2/schema.ts',
      'src/core/nutritionV2/nutrients.ts',
      'src/utils/householdUnits.ts',
    ]);
    expect(rels).toEqual(expected);
  });

  it('reuses canonical helpers instead of duplicating implementations', () => {
    const all = HOUSEHOLD_SOURCES.map((entry) => entry.source).join('\n');
    for (const marker of [
      'toInertValue',
      'serializedBlockBytes',
      'canonicalStringify',
      'sha256Hex',
      'canonicalHouseholdUnit',
      'isValidNutrientAmount',
      'utf8ByteLength',
    ]) {
      expect(all, `missing reuse marker ${marker}`).toContain(marker);
    }
    expect(all).not.toMatch(/MAX_SERIALIZED_BYTES\s*=/);
    const schemaSource = readFileSync(resolve(ROOT, 'src/core/nutritionV2/schema.ts'), 'utf8');
    expect(schemaSource).toContain('MAX_SERIALIZED_BYTES = 64 * 1024');
  });
});

describe('household registry — consumer and barrel isolation', () => {
  it('is imported by no matching/calculation/UI/AI/persistence/server module', () => {
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const root of [resolve(ROOT, 'src'), resolve(ROOT, 'server')]) {
      for (const file of listFiles(root)) {
        if (file.startsWith(HOUSEHOLD_DIR)) continue;
        if (file.includes(`${'/'}tests${'/'}`)) continue;
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          const resolved = resolveProjectSpecifier(file, match[1]);
          if (resolved && resolved.startsWith(HOUSEHOLD_DIR)) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8')).not.toMatch(/household/i);
    expect(readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8')).not.toMatch(/household/i);
  });

  it('exposes a narrow read-only API with no mutable registration surface', () => {
    const keys = Object.keys(householdIndex).sort();
    expect(keys).toEqual(
      [
        'HOUSEHOLD_AUTHORITY_CLASSES',
        'HOUSEHOLD_DATE_PATTERN',
        'HOUSEHOLD_FAILURE_MESSAGE',
        'HOUSEHOLD_PORTION_REGISTRY_SCHEMA_VERSION',
        'HOUSEHOLD_RELEASE_PATTERN',
        'HOUSEHOLD_SHA256_HEX_PATTERN',
        'HOUSEHOLD_SIZE_CLASSES',
        'HOUSEHOLD_SOURCE_KINDS',
        'HOUSEHOLD_STATES',
        'MAX_HOUSEHOLD_ALIASES',
        'MAX_HOUSEHOLD_CITATION_BYTES',
        'MAX_HOUSEHOLD_EXCLUDED_STATES',
        'MAX_HOUSEHOLD_FDC_IDS',
        'MAX_HOUSEHOLD_FOOD_KEY_BYTES',
        'MAX_HOUSEHOLD_FOOD_KEY_TOKENS',
        'MAX_HOUSEHOLD_GRAMS_PER_UNIT',
        'MAX_HOUSEHOLD_REGISTRY_BYTES',
        'MAX_HOUSEHOLD_REGISTRY_RECORDS',
        'MAX_HOUSEHOLD_RELEASE_LENGTH',
        'MAX_HOUSEHOLD_URL_BYTES',
        'computeHouseholdRecordDigest',
        'computeHouseholdRegistryDigest',
        'householdFailure',
        'householdRecordCanonicalPayload',
        'loadHouseholdPortionRegistry',
        'sortHouseholdRecordsCanonical',
        'validateHouseholdRecord',
      ].sort()
    );
    for (const key of keys) {
      expect(key).not.toMatch(/register|insert|update|replace|mutate|save|persist|apply/i);
    }
    const namespace = householdIndex as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = namespace[key] as Record<string, unknown> | null;
      expect(value?.findByKey, `${key} must not be a registry singleton`).toBeUndefined();
    }
  });
});

describe('household registry — no production data', () => {
  it('ships zero real household-portion records or food-weight knowledge', () => {
    // The Phase 4 CONTRACT modules ship no data. Registry-track Phase 5 adds the
    // reviewed USDA-derived data slice in `initialData.ts` plus its pure
    // provenance/digest machinery (covered by the Phase 5 suites); these contract
    // modules must remain data-free.
    const contractSources = HOUSEHOLD_SOURCES.filter(
      ({ file }) =>
        !file.endsWith('initialData.ts') &&
        !file.endsWith('initialLock.ts') &&
        !file.endsWith('initialProvenance.ts')
    );
    const all = contractSources.map((entry) => entry.source).join('\n');
    for (const word of ['garlic', 'onion', 'carrot', 'celery', 'tomato', 'bread', 'bacon', 'cabbage', 'butter']) {
      expect(all, `real-food word ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
    }
    expect(all).not.toMatch(/\b(can|package|container|jar|box|bag|bottle)\b\s*(weight|gram)/i);
    expect(all).not.toMatch(/RECORDS\s*=\s*\[/);
    expect(all).not.toMatch(/defaultRegistry|DEFAULT_REGISTRY|singleton/i);
  });
});
