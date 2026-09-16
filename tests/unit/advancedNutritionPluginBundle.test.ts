/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: plugin bundle exclusion.
 *
 * Builds the Obsidian plugin bundle in-process (same options as
 * `plugin/build.mjs`, but to a temporary output) and proves it contains NONE of
 * the three USDA gzip payloads or their locked byte signatures. The plugin shell
 * must not gain any bundle-loading behavior in this phase.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { describe, it, expect } from 'vitest';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';

const ROOT = resolve(__dirname, '../..');
const BUNDLE_DIR = join(ROOT, 'data', 'advanced-nutrition', 'usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);

describe('phase 4.5B — plugin bundle excludes the USDA payload', () => {
  it('contains none of the three gzip payloads or locked byte signatures', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'kc-plugin-bundle-'));
    const outfile = join(outDir, 'main.js');
    try {
      await build({
        entryPoints: [resolve(ROOT, 'plugin/main.ts')],
        bundle: true,
        external: ['obsidian'],
        format: 'cjs',
        platform: 'browser',
        target: 'es2020',
        jsx: 'automatic',
        outfile,
        sourcemap: 'inline',
        tsconfig: resolve(ROOT, 'tsconfig.json'),
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'silent',
      });
      const bytes = readFileSync(outfile);
      const text = bytes.toString('latin1');

      expect(text).not.toMatch(/data:application\/gzip;base64/);
      expect(text).not.toContain('advancedNutritionBundleAssets');
      expect(text).not.toContain('records.foundation.json.gz');
      expect(bytes.includes(Buffer.from('1f8b08', 'hex'))).toBe(false);

      for (const shard of USDA_BUNDLE_RELEASE_LOCK.shards) {
        const prefix = readFileSync(join(BUNDLE_DIR, shard.filename)).toString('base64').slice(0, 256);
        expect(text, `${shard.filename} payload`).not.toContain(prefix);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60000);
});
