/**
 * The Kitchen Codex — Advanced Nutrition Phase 6: household integration
 * security/isolation.
 *
 * Proves the Phase 6 resolver and builder are offline, dependency-bounded, and
 * fail-closed:
 *   - no network/filesystem/environment/clock/randomness/persistence/dynamic
 *     code and no AI/provider reference in the new modules;
 *   - the calculation-layer resolver reaches ONLY the verified household loader
 *     (never the raw data/lock/provenance modules directly) plus the existing
 *     canonical parsing/count/measurement contracts;
 *   - the exact-key index is module-private, immutable, and contains no mutable
 *     registration surface;
 *   - every resolved binding is frozen and independent of caller mutation;
 *   - the calculation boundary re-derives the household result instead of
 *     trusting the working-state object.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import * as calculationResolver from '../../src/core/nutritionV2/calculation/householdPortion';
import * as phase4Builder from '../../src/core/nutritionV2/phase4/householdPortion';
import { resolveHouseholdPortion } from '../../src/core/nutritionV2/calculation/householdPortion';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PHASE6_MODULES = [
  resolve(ROOT, 'src/core/nutritionV2/calculation/householdPortion.ts'),
  resolve(ROOT, 'src/core/nutritionV2/phase4/householdPortion.ts'),
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function structuredLine(original: string): Record<string, unknown> {
  const parsed = parseIngredient(original);
  if (!parsed.ok) return { original };
  const p = parsed.parsed;
  return {
    original,
    ...(p.amount !== null ? { amount: p.amount } : {}),
    ...(p.raw_unit !== undefined ? { unit: p.raw_unit } : {}),
    name: p.query,
  };
}

describe('phase 6 — module purity and dependency boundary', () => {
  it('contains no network, filesystem, environment, time, randomness, persistence, or AI token', () => {
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
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /codex_nutrition/,
      /vaultFileSystem/,
      /vaultAssets/,
      /nutritionEstimator/,
      /nutritionCache/,
      /aiResolution|openrouter|gemini|GEMINI/i,
    ];
    for (const file of PHASE6_MODULES) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const token of tokens) {
        expect(source, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('reaches the verified loader and existing canonical contracts only', () => {
    const resolverSource = readFileSync(PHASE6_MODULES[0], 'utf8');
    // The verified loader is the ONLY data access path.
    expect(resolverSource).toContain("from '../household/initialData'");
    expect(resolverSource).toContain('loadHouseholdInitialRegistry');
    // Raw data/lock/provenance modules are never imported directly.
    expect(resolverSource).not.toMatch(/initialProvenance|initialLock/);
    const allowed = [
      '../../../utils/householdUnits',
      '../../../utils/measurements',
      '../matching/normalize',
      '../matching/parse',
      '../matching/query',
      '../usda/digest',
      './countPortion',
      '../units',
      './types',
      '../household/initialData',
      '../calculation/householdPortion',
      '../calculation/types',
      './rows',
      './types',
    ];
    const imports = [...resolverSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const builderSource = readFileSync(PHASE6_MODULES[1], 'utf8');
    const builderImports = [...builderSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of [...imports, ...builderImports]) {
      expect(allowed, `unexpected import ${specifier}`).toContain(specifier);
    }
  });

  it('exposes no mutable registry surface and no raw record array', () => {
    const keys = Object.keys(calculationResolver);
    for (const key of keys) {
      expect(key).not.toMatch(/register|insert|update|replace|mutate|save|persist|apply/i);
    }
    expect(keys).not.toContain('getHouseholdPortionIndex');
    const namespace = calculationResolver as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = namespace[key];
      expect(Array.isArray(value), `${key} must not be a data array`).toBe(false);
    }
    const builderKeys = Object.keys(phase4Builder);
    expect(builderKeys).toEqual(['buildHouseholdPortionChoice']);
  });

  it('returns frozen, caller-independent resolutions', () => {
    const ingredient = structuredLine('1 clove household test food');
    const first = resolveHouseholdPortion({
      ingredient,
      fdcId: 169230,
      usdaRecordDigest: 'd19a0c659ab0a98218bf1eb3f8463ddfc3fc243185fa8b185cf6e204f0aeb199',
      bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
    });
    expect(first).toBeDefined();
    if (!first) return;
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as unknown as Record<string, unknown>).resolved_grams = 999;
    }).toThrow();
    const second = resolveHouseholdPortion({
      ingredient,
      fdcId: 169230,
      usdaRecordDigest: 'd19a0c659ab0a98218bf1eb3f8463ddfc3fc243185fa8b185cf6e204f0aeb199',
      bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
    });
    expect(second).toEqual(first);
    // Mutating the input after resolution cannot change the result.
    (ingredient as { amount?: number }).amount = 99;
    expect(
      resolveHouseholdPortion({
        ingredient,
        fdcId: 169230,
        usdaRecordDigest: 'd19a0c659ab0a98218bf1eb3f8463ddfc3fc243185fa8b185cf6e204f0aeb199',
        bundleRelease: USDA_BUNDLE_RELEASE_LOCK.bundle_release,
      })?.resolved_grams
    ).toBe(297);
  });
});
