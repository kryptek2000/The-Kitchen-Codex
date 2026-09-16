/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A: generator identity + pinned constants.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { deriveBundleReleaseId } from '../../src/core/nutritionV2/usda/manifest';
import type { UsdaBundleManifest } from '../../src/core/nutritionV2/usda/types';
import {
  ARCHIVE_SPECS,
  GENERATOR_NAME,
  GENERATOR_SCHEMA_VERSION,
  PINNED_CREATED_AT,
  SHARD_ORDER,
} from '../../scripts/usda_bundle/constants';
import { expectedArtifactDir } from '../../scripts/usda_bundle/verify';

function skeleton(): UsdaBundleManifest {
  return {
    manifest_schema: 1,
    bundle_release: 'pending',
    generator: { name: GENERATOR_NAME, schema_version: GENERATOR_SCHEMA_VERSION },
    created_at: PINNED_CREATED_AT,
    data_types: [...SHARD_ORDER],
    components: SHARD_ORDER.map((dataType) => {
      const spec = ARCHIVE_SPECS.find((entry) => entry.data_type === dataType)!;
      return {
        data_type: spec.data_type,
        upstream_release: spec.upstream_release,
        source_url: spec.source_url,
        source_sha256: spec.sha256,
      };
    }),
    canonical_record_count: 1,
    rejected_record_count: 0,
    canonical_content_digest: '0'.repeat(64),
    nutrient_map_version: 'usda_fdc_nutrient_map_v2',
    canonicalization_version: 'usda_canonical_v1',
    attribution:
      'U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov.',
  } as UsdaBundleManifest;
}

describe('phase 4.5A generator identity', () => {
  it('derives a stable release id from the pinned inputs', () => {
    expect(deriveBundleReleaseId(skeleton())).toBe('usda_fdc_87c5408a3e98838944a87be74824761e');
  });

  it('changes the release when the generator schema changes', () => {
    const base = skeleton();
    const changed = { ...base, generator: { ...base.generator, schema_version: '2' } } as UsdaBundleManifest;
    expect(deriveBundleReleaseId(changed)).not.toBe(deriveBundleReleaseId(base));
  });

  it('changes the release when a source archive digest changes', () => {
    const base = skeleton();
    const changed = {
      ...base,
      components: base.components.map((component, index) =>
        index === 0 ? { ...component, source_sha256: 'f'.repeat(64) } : component
      ),
    } as UsdaBundleManifest;
    expect(deriveBundleReleaseId(changed)).not.toBe(deriveBundleReleaseId(base));
  });

  it('uses the pinned reproducible timestamp in the checked-in manifest', () => {
    const manifest = JSON.parse(readFileSync(join(expectedArtifactDir(), 'manifest.json'), 'utf8'));
    expect(manifest.created_at).toBe(PINNED_CREATED_AT);
    expect(manifest.bundle_release).toBe(deriveBundleReleaseId(manifest));
  });

  it('rejects swapped or wrongly named archives (skips if the pinned archives are absent)', () => {
    const foundation = '/tmp/FoodData_Central_foundation_food_json_2026-04-30.zip';
    const srLegacy = '/tmp/FoodData_Central_sr_legacy_food_json_2018-04.zip';
    const fndds = '/tmp/FoodData_Central_survey_food_json_2024-10-31.zip';
    if (![foundation, srLegacy, fndds].every((path) => existsSync(path))) return;

    const out = mkdtempSync(join(tmpdir(), 'kc-gen-neg-'));
    try {
      const result = spawnSync(
        'bun',
        [
          'x',
          'tsx',
          'scripts/usda_bundle/generate.cli.ts',
          '--foundation',
          srLegacy,
          '--sr-legacy',
          foundation,
          '--fndds',
          fndds,
          '--out',
          join(out, 'artifact'),
        ],
        { cwd: join(__dirname, '..', '..'), encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/archive_filename_mismatch|archive_digest_mismatch/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120000);
});
