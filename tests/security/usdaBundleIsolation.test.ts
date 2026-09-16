/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5A isolation guard.
 *
 * Proves the generator/verifier are build-time/offline tooling only: no
 * production runtime imports them, they reach no UI/server/network/persistence
 * module, and no artifact is copied into any runtime output.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { advancedNutritionApplicationAuthorization } from '../../src/core/nutritionV2/validate';
import { canApplyNutritionEstimate } from '../../src/core/nutritionSanity';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BUNDLE_DIR = resolve(ROOT, 'scripts/usda_bundle');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const BUNDLE_SOURCES = listFiles(BUNDLE_DIR)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, source: readFileSync(file, 'utf8') }));

const FORBIDDEN_BUNDLE_TOKENS = [
  /from\s+['"]react['"]/,
  /\/components\//,
  /\/platform\//,
  /\/application\//,
  /\/hooks\//,
  /\/server\//,
  /markdownParser/,
  /vaultFileSystem/,
  /vaultAssets/,
  /vaultRecipe/,
  /\bfetch\s*\(/,
  /node:(http|https|net|dns|tls)/,
  /open_food_facts/i,
  /api\.data\.gov/,
];

describe('phase 4.5A isolation — build-time tooling only', () => {
  it('no production module imports the bundle tooling', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server'), resolve(ROOT, 'plugin')];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.mjs')) continue;
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          if (/usda_bundle|zip_extract|stream_json/.test(match[1])) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no production module or test helper imports a CLI entry module', () => {
    const roots = [resolve(ROOT, 'src'), resolve(ROOT, 'server'), resolve(ROOT, 'plugin'), resolve(ROOT, 'tests')];
    const entryFiles = new Set([
      resolve(BUNDLE_DIR, 'generate.cli.ts'),
      resolve(BUNDLE_DIR, 'verify.cli.ts'),
    ]);
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of listFiles(root)) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.mjs')) continue;
        if (entryFiles.has(file)) continue;
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          if (/generate\.cli|verify\.cli/.test(match[1])) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the release trust lock is platform-neutral data only', () => {
    const source = readFileSync(resolve(ROOT, 'src', 'core', 'nutritionV2', 'usda', 'releaseLock.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('no production runtime loads the generator/verifier or artifact tooling', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server'), resolve(ROOT, 'plugin')];
    const forbidden = /usda_bundle|zip_extract|stream_json|generate\.cli|verify\.cli/;
    const offenders: string[] = [];
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.mjs')) continue;
        if (forbidden.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the generator/verifier reach no UI, server, network, or persistence module', () => {
    for (const { file, source } of BUNDLE_SOURCES) {
      for (const token of FORBIDDEN_BUNDLE_TOKENS) {
        expect(source, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('no generated artifact is copied into a runtime output directory', () => {
    for (const runtimeDir of ['public', 'dist', 'plugin']) {
      const files = listFiles(resolve(ROOT, runtimeDir));
      for (const file of files) {
        expect(file.endsWith('.json.gz'), file).toBe(false);
      }
    }
  });

  it('the artifact lives only under data/advanced-nutrition', () => {
    const artifactFiles = listFiles(resolve(ROOT, 'data', 'advanced-nutrition'));
    expect(artifactFiles.length).toBeGreaterThan(0);
    for (const file of artifactFiles) {
      expect(file.startsWith(resolve(ROOT, 'data', 'advanced-nutrition'))).toBe(true);
    }
    // No raw archive or extracted JSON is present.
    for (const file of artifactFiles) {
      expect(file.endsWith('.zip'), file).toBe(false);
      expect(/\.json$/.test(file) && !file.endsWith('manifest.json') && !file.endsWith('artifact.json'), file).toBe(false);
    }
  });

  it('App does not inject a Phase 4 session (production remains honestly unavailable)', () => {
    const app = readFileSync(resolve(ROOT, 'src', 'App.tsx'), 'utf8');
    expect(app).not.toMatch(/advancedNutritionSession/);
  });

  it('machine application remains globally disabled', () => {
    expect(advancedNutritionApplicationAuthorization()).toEqual({
      ok: false,
      reasons: ['automated_application_disabled_pending_provenance_persistence'],
    });
    expect(
      canApplyNutritionEstimate({ calories: 100, protein: 1, carbohydrates: 1, fat: 1, fiber: 0, sodium: 0 }, undefined, 1).ok
    ).toBe(false);
  });
});
