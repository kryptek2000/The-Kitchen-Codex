import { describe, it, expect } from 'vitest';
import {
  CanonicalSerializationError,
  canonicalStringify,
  sha256Hex,
  tryCanonicalStringify,
} from '../../src/core/nutritionV2/usda/digest';
import {
  computeCanonicalRecordDigest,
  type CanonicalUsdaFoodRecordContent,
} from '../../src/core/nutritionV2/usda/record';
import {
  computeBundleIdentity,
  computeCanonicalContentDigest,
} from '../../src/core/nutritionV2/usda/manifest';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import { makeManifestBase } from '../fixtures/usdaFixtures';

/**
 * Finding 2 — strict, fail-closed canonical serialization. Distinct
 * authoritative inputs must never alias.
 */

function reasonOf(value: unknown): string {
  try {
    canonicalStringify(value);
    return 'NO_THROW';
  } catch (error) {
    return error instanceof CanonicalSerializationError ? error.reason : 'OTHER';
  }
}

function content(): CanonicalUsdaFoodRecordContent {
  return {
    source: 'usda_fdc',
    bundle_release: 'usda_fdc_contentfixture',
    upstream_release: '2026-04',
    fdc_id: 1,
    data_type: 'foundation',
    description: 'Synthetic content',
    food_category: 'Test category',
    nutrient_map_version: USDA_NUTRIENT_MAP_VERSION,
    basis: 'per_100_g',
    nutrients: {
      protein: {
        nutrient_id: 'protein',
        unit: 'g',
        amount_per_100g: 1,
        usda_nutrient_id: 1003,
        source_unit: 'G',
        converted: false,
      },
    },
    portions: [
      { usda_portion_id: 5, amount: 1, measure: 'cup', gram_weight: 100, modifier: 'x', sequence: 1 },
    ],
  };
}

describe('strict canonical serialization — unsupported values fail closed', () => {
  it('rejects undefined and never aliases it to null', () => {
    expect(reasonOf({ a: undefined })).toBe('unsupported_type');
    expect(reasonOf(undefined)).toBe('unsupported_type');
    expect(tryCanonicalStringify({ a: undefined })).toEqual({ ok: false, reason: 'unsupported_type' });
    // Distinct from explicit null.
    expect(canonicalStringify({ a: null })).toBe('{"a":null}');
    expect(canonicalStringify({ a: null })).not.toBe(canonicalStringify({ a: 0 }));
  });

  it('rejects -0 but accepts positive 0', () => {
    expect(reasonOf(-0)).toBe('negative_zero');
    expect(reasonOf({ a: -0 })).toBe('negative_zero');
    expect(canonicalStringify(0)).toBe('0');
    expect(canonicalStringify({ a: 0 })).toBe('{"a":0}');
  });

  it('rejects NaN and infinities', () => {
    expect(reasonOf(Number.NaN)).toBe('non_finite_number');
    expect(reasonOf(Number.POSITIVE_INFINITY)).toBe('non_finite_number');
    expect(reasonOf(Number.NEGATIVE_INFINITY)).toBe('non_finite_number');
  });

  it('rejects array holes, undefined entries, and keeps null distinct', () => {
    expect(reasonOf([1, , 3])).toBe('unusual_array');
    expect(reasonOf([undefined])).toBe('unsupported_type');
    expect(canonicalStringify([null])).toBe('[null]');
    expect(canonicalStringify([0])).toBe('[0]');
  });

  it('rejects unsupported objects and hostile reflection', () => {
    expect(reasonOf(new Date())).toBe('non_plain_prototype');
    expect(reasonOf(new Map())).toBe('non_plain_prototype');
    expect(reasonOf(new Set())).toBe('non_plain_prototype');
    expect(reasonOf(new Uint8Array([1, 2]))).toBe('non_plain_prototype');
    class Thing {
      value = 1;
    }
    expect(reasonOf(new Thing())).toBe('non_plain_prototype');
    expect(reasonOf(() => 1)).toBe('unsupported_type');
    expect(reasonOf(10n)).toBe('unsupported_type');
    expect(reasonOf(Symbol('x'))).toBe('unsupported_type');

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'a', { enumerable: true, get: () => 1 });
    expect(reasonOf(accessor)).toBe('accessor_or_hidden_property');

    const dangerous = JSON.parse('{"__proto__":1}');
    expect(reasonOf(dangerous)).toBe('dangerous_key');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(reasonOf(cyclic)).toBe('cycle');

    const symKey = { [Symbol('k')]: 1 };
    expect(reasonOf(symKey)).toBe('symbol_key');

    const hostileProxy = new Proxy({}, { ownKeys: () => { throw new Error('no'); } });
    expect(() => canonicalStringify(hostileProxy)).toThrow();
  });
});

describe('strict canonical serialization — deterministic ordering and strings', () => {
  it('sorts object keys deterministically and preserves array order', () => {
    expect(canonicalStringify({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
    // object vs array remain distinct
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify([1]));
    // string vs number remain distinct
    expect(canonicalStringify({ a: '1' })).not.toBe(canonicalStringify({ a: 1 }));
  });

  it('preserves exact string code units, escapes deterministically, and never normalizes', () => {
    const nfc = 'é'; // U+00E9
    const nfd = 'e\u0301'; // e + combining acute
    expect(canonicalStringify(nfc)).not.toBe(canonicalStringify(nfd));
    expect(canonicalStringify(nfc)).toBe(JSON.stringify(nfc));
    const loneSurrogate = '\ud800';
    const escaped = canonicalStringify(loneSurrogate);
    expect(escaped).toBe(JSON.stringify(loneSurrogate));
    expect(escaped).toBe('"\\ud800"');
  });

  it('keeps the verified SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
    );
    expect(sha256Hex('a'.repeat(1000000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
    );
  });
});

describe('digest coverage — every authoritative field affects identity', () => {
  it('changes the canonical record digest for every authoritative field', () => {
    const base = content();
    const baseline = computeCanonicalRecordDigest(base);
    const variants: Array<[string, CanonicalUsdaFoodRecordContent]> = [
      ['source', { ...base, source: 'other' as never }],
      ['bundle_release', { ...base, bundle_release: 'usda_fdc_other' }],
      ['upstream_release', { ...base, upstream_release: '2099-01' }],
      ['fdc_id', { ...base, fdc_id: 2 }],
      ['data_type', { ...base, data_type: 'fndds' }],
      ['description', { ...base, description: 'Changed' }],
      ['food_category', { ...base, food_category: 'Other' }],
      ['nutrient_map_version', { ...base, nutrient_map_version: 'v9' }],
      ['basis', { ...base, basis: 'total' as never }],
      [
        'nutrient amount',
        { ...base, nutrients: { protein: { ...base.nutrients.protein!, amount_per_100g: 2 } } },
      ],
      [
        'nutrient unit',
        { ...base, nutrients: { protein: { ...base.nutrients.protein!, unit: 'mg' } } },
      ],
      [
        'nutrient source id',
        { ...base, nutrients: { protein: { ...base.nutrients.protein!, usda_nutrient_id: 1004 } } },
      ],
      [
        'portion gram weight',
        { ...base, portions: [{ ...base.portions[0], gram_weight: 101 }] },
      ],
      [
        'portion measure',
        { ...base, portions: [{ ...base.portions[0], measure: 'bowl' }] },
      ],
      [
        'portion amount',
        { ...base, portions: [{ ...base.portions[0], amount: 2 }] },
      ],
      [
        'portion optional amount removed',
        { ...base, portions: [{ usda_portion_id: 5, measure: 'cup', gram_weight: 100, modifier: 'x', sequence: 1 }] },
      ],
      [
        'portion modifier',
        { ...base, portions: [{ ...base.portions[0], modifier: 'y' }] },
      ],
      [
        'portion sequence',
        { ...base, portions: [{ ...base.portions[0], sequence: 2 }] },
      ],
      [
        'portion id',
        { ...base, portions: [{ ...base.portions[0], usda_portion_id: 6 }] },
      ],
    ];
    for (const [label, variant] of variants) {
      expect(computeCanonicalRecordDigest(variant), label).not.toBe(baseline);
    }
  });

  it('changes bundle identity for every authoritative field and ignores non-authoritative ones', () => {
    const base = makeManifestBase(['foundation'], 1, '0'.repeat(64));
    const baseline = computeBundleIdentity(base);
    const variants: Array<[string, typeof base]> = [
      ['manifest_schema', { ...base, manifest_schema: 2 as never }],
      ['generator name', { ...base, generator: { ...base.generator, name: 'other' } }],
      ['generator schema', { ...base, generator: { ...base.generator, schema_version: '2' } }],
      ['data types', { ...base, data_types: ['foundation', 'fndds'] }],
      [
        'component release',
        { ...base, components: [{ ...base.components[0], upstream_release: '2099-01' }] },
      ],
      [
        'component url',
        { ...base, components: [{ ...base.components[0], source_url: 'https://fdc.nal.usda.gov/other.zip' }] },
      ],
      [
        'component digest',
        { ...base, components: [{ ...base.components[0], source_sha256: 'f'.repeat(64) }] },
      ],
      ['nutrient map', { ...base, nutrient_map_version: 'v9' }],
      ['canonicalization', { ...base, canonicalization_version: 'v9' }],
    ];
    for (const [label, variant] of variants) {
      expect(computeBundleIdentity(variant), label).not.toBe(baseline);
    }
    // Non-authoritative fields do not change identity.
    expect(computeBundleIdentity({ ...base, canonical_record_count: 5 })).toBe(baseline);
    expect(computeBundleIdentity({ ...base, rejected_record_count: 5 })).toBe(baseline);
    expect(computeBundleIdentity({ ...base, created_at: '2000-01-01T00:00:00.000Z' })).toBe(baseline);
    expect(computeBundleIdentity({ ...base, bundle_release: 'different' })).toBe(baseline);
  });

  it('keeps content digest independent of record order but sensitive to each record', () => {
    const a = { fdc_id: 1, record_digest: 'a'.repeat(64) };
    const b = { fdc_id: 2, record_digest: 'b'.repeat(64) };
    expect(computeCanonicalContentDigest([a, b])).toBe(computeCanonicalContentDigest([b, a]));
    expect(computeCanonicalContentDigest([a, b])).not.toBe(
      computeCanonicalContentDigest([{ ...a, record_digest: 'c'.repeat(64) }, b])
    );
    expect(computeCanonicalContentDigest([a])).not.toBe(computeCanonicalContentDigest([a, b]));
  });
});
