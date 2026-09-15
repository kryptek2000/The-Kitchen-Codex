import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computeBundleIdentity,
  deriveBundleReleaseId,
  isOfficialUsdaSourceUrl,
  isSha256Hex,
  validateManifest,
} from '../../src/core/nutritionV2/usda/manifest';
import { USDA_NUTRIENT_MAP_VERSION } from '../../src/core/nutritionV2/usda/nutrientMap';
import {
  USDA_ATTRIBUTION,
  USDA_CANONICALIZATION_VERSION,
  type UsdaBundleManifest,
} from '../../src/core/nutritionV2/usda/types';
import { makeManifestBase, TEST_SOURCE_SHA } from '../fixtures/usdaFixtures';

/**
 * Phase 1 — release manifest contract. Mutation-sensitive: every rule is
 * asserted with a violating fixture.
 */

function validManifest(): UsdaBundleManifest {
  return makeManifestBase(['foundation', 'sr_legacy'], 2, 'b'.repeat(64));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usda manifest — valid and closed shape', () => {
  it('accepts a valid manifest and derives a bounded bundle release id', () => {
    const manifest = validManifest();
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    expect(manifest.bundle_release).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    expect(manifest.bundle_release).toBe(deriveBundleReleaseId(manifest));
    expect(manifest.bundle_release.length).toBeLessThanOrEqual(64);
  });

  it('rejects unknown top-level and nested fields', () => {
    const manifest = validManifest();
    expect(validateManifest({ ...manifest, unexpected: 1 }).ok).toBe(false);
    expect(
      validateManifest({ ...manifest, generator: { ...manifest.generator, extra: true } }).ok
    ).toBe(false);
    expect(
      validateManifest({
        ...manifest,
        components: [{ ...manifest.components[0], extra: true }, manifest.components[1]],
      }).ok
    ).toBe(false);
  });

  it('rejects missing required fields', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    for (const key of ['manifest_schema', 'bundle_release', 'generator', 'created_at', 'data_types', 'components', 'canonical_record_count', 'rejected_record_count', 'canonical_content_digest', 'nutrient_map_version', 'canonicalization_version', 'attribution']) {
      const copy: Record<string, unknown> = { ...manifest };
      delete copy[key];
      expect(validateManifest(copy).ok, `missing ${key} must fail`).toBe(false);
    }
  });

  it('rejects duplicate data types and component/type mismatches', () => {
    const manifest = validManifest();
    expect(validateManifest({ ...manifest, data_types: ['foundation', 'foundation'] }).ok).toBe(false);
    expect(
      validateManifest({
        ...manifest,
        components: [manifest.components[0], manifest.components[0]],
      }).ok
    ).toBe(false);
    expect(
      validateManifest({ ...manifest, data_types: ['foundation', 'sr_legacy', 'fndds'] }).ok
    ).toBe(false);
  });

  it('rejects invalid bundle release ids and identity mismatches', () => {
    const manifest = validManifest();
    expect(validateManifest({ ...manifest, bundle_release: '' }).ok).toBe(false);
    expect(validateManifest({ ...manifest, bundle_release: 'bad id!' }).ok).toBe(false);
    expect(validateManifest({ ...manifest, bundle_release: 'x'.repeat(65) }).ok).toBe(false);
    // Well-formed but not derived from the authoritative inputs.
    expect(validateManifest({ ...manifest, bundle_release: 'usda_fdc_deadbeef' }).ok).toBe(false);
  });

  it('rejects invalid source URL schemes, hosts, credentials, queries, and fragments', () => {
    const manifest = validManifest();
    const badUrls = [
      'http://fdc.nal.usda.gov/fdc-datasets/x.zip',
      'https://evil.example.com/fdc-datasets/x.zip',
      'https://user:pass@fdc.nal.usda.gov/x.zip',
      'https://fdc.nal.usda.gov/x.zip?key=1',
      'https://fdc.nal.usda.gov/x.zip#frag',
      'ftp://fdc.nal.usda.gov/x.zip',
      'not a url',
    ];
    for (const url of badUrls) {
      expect(isOfficialUsdaSourceUrl(url)).toBe(false);
      const result = validateManifest({
        ...manifest,
        components: [{ ...manifest.components[0], source_url: url }, manifest.components[1]],
      });
      expect(result.ok, `url ${url} must fail`).toBe(false);
    }
    expect(isOfficialUsdaSourceUrl('https://fdc.nal.usda.gov/fdc-datasets/x.zip')).toBe(true);
  });

  it('rejects invalid SHA-256 values (format, case, length)', () => {
    const manifest = validManifest();
    for (const hash of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `sha256:${'a'.repeat(64)}`]) {
      expect(isSha256Hex(hash)).toBe(false);
      const result = validateManifest({
        ...manifest,
        components: [{ ...manifest.components[0], source_sha256: hash }, manifest.components[1]],
      });
      expect(result.ok, `hash ${hash} must fail`).toBe(false);
    }
    expect(isSha256Hex(TEST_SOURCE_SHA)).toBe(true);
  });

  it('rejects negative, -0, unsafe, and inconsistent counts', () => {
    const manifest = validManifest();
    for (const count of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, 0]) {
      expect(validateManifest({ ...manifest, canonical_record_count: count }).ok).toBe(false);
    }
    for (const count of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateManifest({ ...manifest, rejected_record_count: count }).ok).toBe(false);
    }
  });

  it('rejects an oversized manifest', () => {
    const manifest = validManifest();
    const result = validateManifest({ ...manifest, attribution: 'x'.repeat(40 * 1024) });
    expect(result.ok).toBe(false);
    expect((result as { errors: string[] }).errors).toContain('manifest_too_large');
  });

  it('rejects unknown nutrient-map and canonicalization versions', () => {
    const manifest = validManifest();
    expect(validateManifest({ ...manifest, nutrient_map_version: 'unknown' }).ok).toBe(false);
    expect(validateManifest({ ...manifest, canonicalization_version: 'unknown' }).ok).toBe(false);
    expect(manifest.nutrient_map_version).toBe(USDA_NUTRIENT_MAP_VERSION);
    expect(manifest.canonicalization_version).toBe(USDA_CANONICALIZATION_VERSION);
    expect(manifest.attribution).toBe(USDA_ATTRIBUTION);
  });

  it('changes bundle identity when any authoritative input changes', () => {
    const base = validManifest();
    const baseline = computeBundleIdentity(base);

    const changedRelease = computeBundleIdentity({
      ...base,
      components: [{ ...base.components[0], upstream_release: '2099-01' }, base.components[1]],
    });
    const changedHash = computeBundleIdentity({
      ...base,
      components: [{ ...base.components[0], source_sha256: 'c'.repeat(64) }, base.components[1]],
    });
    const changedNutrientMap = computeBundleIdentity({ ...base, nutrient_map_version: 'v2' });
    const changedCanonicalization = computeBundleIdentity({ ...base, canonicalization_version: 'v2' });
    const changedGenerator = computeBundleIdentity({
      ...base,
      generator: { ...base.generator, schema_version: '2' },
    });

    for (const changed of [changedRelease, changedHash, changedNutrientMap, changedCanonicalization, changedGenerator]) {
      expect(changed).not.toBe(baseline);
    }
    // Non-authoritative fields (counts, timestamps, warnings) do not affect identity.
    expect(computeBundleIdentity({ ...base, canonical_record_count: 999 })).toBe(baseline);
    expect(computeBundleIdentity({ ...base, created_at: '2000-01-01T00:00:00.000Z' })).toBe(baseline);
  });

  it('never fetches a URL during manifest validation', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
