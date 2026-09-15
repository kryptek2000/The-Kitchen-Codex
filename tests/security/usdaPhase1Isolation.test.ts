/**
 * The Kitchen Codex — Advanced Nutrition Phase 1 isolation / no-network guard.
 *
 * Proves the Phase 1 USDA modules are key-free, network-free, persistence-free,
 * and unwired from every production surface. Combines a static source scan with
 * a runtime flow under a stubbed `fetch`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { adaptUsdaFood } from '../../src/core/nutritionV2/usda/adapter';
import { createUsdaRecordStore } from '../../src/core/nutritionV2/usda/store';
import { createUsdaRecordCache } from '../../src/core/nutritionV2/usda/cache';
import { advancedNutritionApplicationAuthorization } from '../../src/core/nutritionV2/validate';
import { canApplyNutritionEstimate } from '../../src/core/nutritionSanity';
import { buildBundle, FOUNDATION_RAW } from '../fixtures/usdaFixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const USDA_DIR = resolve(ROOT, 'src/core/nutritionV2/usda');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const USDA_FILES = listFiles(USDA_DIR);
const USDA_SOURCES = USDA_FILES.map((file) => ({ file, source: readFileSync(file, 'utf8') }));

const NETWORK_TOKENS: ReadonlyArray<RegExp> = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
  /\baxios\b/,
  /\bnode:(http|https|net|dns|tls)\b/,
  /from\s+['"](http|https|net|dns|tls)['"]/,
  /require\s*\(\s*['"](http|https|net|dns|tls)['"]/,
];

const SECRET_TOKENS: ReadonlyArray<RegExp> = [
  /api[_-]?key/i,
  /DEMO_KEY/,
  /api\.data\.gov/,
  /X-Api-Key/i,
  /process\s*\.\s*env/,
  /localStorage/,
  /sessionStorage/,
  /indexedDB/,
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usda phase 1 — no network, no keys, no persistence', () => {
  it('contains no network client or network-call token', () => {
    for (const { file, source } of USDA_SOURCES) {
      const stripped = stripComments(source);
      for (const token of NETWORK_TOKENS) {
        expect(stripped, `${file} must not match ${token}`).not.toMatch(token);
      }
    }
  });

  it('contains no API key, credential, env, or browser-storage token', () => {
    for (const { file, source } of USDA_SOURCES) {
      const stripped = stripComments(source);
      for (const token of SECRET_TOKENS) {
        expect(stripped, `${file} must not match ${token}`).not.toMatch(token);
      }
    }
  });

  it('never calls fetch during a full adapter/store/cache flow', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const bundle = buildBundle([{ dataType: 'foundation', raw: FOUNDATION_RAW }]);
    const adapted = adaptUsdaFood(FOUNDATION_RAW, {
      bundle_release: bundle.bundleRelease,
      upstream_release: bundle.manifest.components[0].upstream_release,
      data_type: 'foundation',
      nutrient_map_version: bundle.manifest.nutrient_map_version,
    });
    expect(adapted.ok).toBe(true);
    const store = createUsdaRecordStore(bundle.manifest, bundle.records);
    expect(store.ok).toBe(true);
    if (store.ok) store.store.lookup(bundle.bundleRelease, bundle.records[0].fdc_id);
    const cache = createUsdaRecordCache();
    cache.set(bundle.records[0]);
    cache.get(bundle.bundleRelease, bundle.records[0].fdc_id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never references the codex_nutrition block or its persistence helpers', () => {
    for (const { file, source } of USDA_SOURCES) {
      expect(source, `${file} must not reference codex_nutrition`).not.toMatch(/codex_nutrition/);
      expect(source).not.toMatch(/applyAdvancedNutritionRoundTrip/);
    }
  });

  it('is not imported by any production surface', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server')];
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        if (file.startsWith(USDA_DIR)) continue;
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          if (/nutritionV2\/usda/.test(match[1])) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is not re-exported from the Phase 0 / core barrels', () => {
    const nutritionBarrel = readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8');
    const coreBarrel = readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8');
    expect(nutritionBarrel).not.toMatch(/usda/i);
    expect(coreBarrel).not.toMatch(/usda/i);
  });
});

describe('usda phase 1 — application authorization stays disabled', () => {
  it('keeps advanced-nutrition application disabled', () => {
    expect(advancedNutritionApplicationAuthorization()).toEqual({
      ok: false,
      reasons: ['automated_application_disabled_pending_provenance_persistence'],
    });
  });

  it('keeps the centralized machine-nutrition gate disabled', () => {
    const result = canApplyNutritionEstimate(
      { calories: 100, protein: 1, carbohydrates: 1, fat: 1, fiber: 0, sodium: 0 },
      undefined,
      1
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
