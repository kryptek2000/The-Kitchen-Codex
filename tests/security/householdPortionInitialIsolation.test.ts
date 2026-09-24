/**
 * The Kitchen Codex — Household-Portion Registry (registry-track Phase 5, repair):
 * security / isolation / verified-loader-only / non-integration proof.
 *
 * Proves the repaired data slice is:
 *   - pure and offline (no network, filesystem, environment, clock, randomness,
 *     persistence, or dynamic code);
 *   - dependency-bounded (reaches only the Phase 4 contract modules);
 *   - consumed by NO runtime module (matching, calculation, live rows, AI,
 *     Apply/persistence, schema, UI, server);
 *   - accessible ONLY through the lock-verifying loader (raw definitions are
 *     module-private and no barrel re-exports them);
 *   - deeply immutable (records, provenance, rationales, metadata);
 *   - behaviorally inert: the real pipeline's statuses and grams are pinned and
 *     unchanged by the dataset (no line gains grams from it).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

import * as initialData from '../../src/core/nutritionV2/household/initialData';
import * as initialLock from '../../src/core/nutritionV2/household/initialLock';
import * as initialProvenance from '../../src/core/nutritionV2/household/initialProvenance';
import { loadHouseholdInitialRegistry } from '../../src/core/nutritionV2/household/initialData';
import { HOUSEHOLD_INITIAL_REGISTRY_LOCK } from '../../src/core/nutritionV2/household/initialLock';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { selectAutomaticMatch, selectBestEffortMatch } from '../../src/core/nutritionV2/matching/confidence';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { analyzeRecipe } from '../../src/core/nutritionV2/phase4/analyzer';
import { buildReviewRows } from '../../src/core/nutritionV2/phase4/rows';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const HOUSEHOLD_DIR = resolve(ROOT, 'src/core/nutritionV2/household');
const BUNDLE_DIR = join(
  ROOT,
  'data/advanced-nutrition/usda/usda_fdc_87c5408a3e98838944a87be74824761e'
);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const PHASE5_FILES = [
  join(HOUSEHOLD_DIR, 'initialData.ts'),
  join(HOUSEHOLD_DIR, 'initialLock.ts'),
  join(HOUSEHOLD_DIR, 'initialProvenance.ts'),
];
const PHASE5_SOURCES = PHASE5_FILES.map((file) => ({
  file,
  source: stripComments(readFileSync(file, 'utf8')),
}));

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
  const patterns = [
    /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
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

describe('phase 5 repair — module purity and dependency boundary', () => {
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
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
    ];
    for (const { file, source } of PHASE5_SOURCES) {
      for (const token of tokens) {
        expect(source, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('reaches only the Phase 4 contract helpers (no matching/calculation/AI/UI/server)', () => {
    const graph = collectTransitiveGraph(PHASE5_FILES);
    const rels = new Set(
      Array.from(graph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'))
    );
    const expected = new Set([
      'src/core/nutritionV2/household/types.ts',
      'src/core/nutritionV2/household/normalize.ts',
      'src/core/nutritionV2/household/digest.ts',
      'src/core/nutritionV2/household/registry.ts',
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
    for (const rel of rels) {
      expect(rel).not.toMatch(
        /matching|calculation|phase4|phase5|application|components|server|provider|aiResolution/
      );
    }
  });

  it('is imported by no runtime module and re-exported from no barrel', () => {
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const root of [resolve(ROOT, 'src'), resolve(ROOT, 'server')]) {
      for (const file of listTsFiles(root)) {
        if (file.startsWith(HOUSEHOLD_DIR)) continue;
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          const resolved = resolveProjectSpecifier(file, match[1]);
          if (
            resolved &&
            (resolved.endsWith('/initialData.ts') ||
              resolved.endsWith('/initialLock.ts') ||
              resolved.endsWith('/initialProvenance.ts'))
          ) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8')).not.toMatch(
      /initial|household/i
    );
    expect(readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8')).not.toMatch(
      /initial|household/i
    );
  });

  it('exposes raw definitions from no runtime barrel (verified-loader-only access)', () => {
    const dataKeys = Object.keys(initialData).sort();
    expect(dataKeys).toEqual(
      [
        'HOUSEHOLD_INITIAL_REVIEWED_AT',
        'HOUSEHOLD_INITIAL_SOURCE_BUNDLE_RELEASE',
        'loadHouseholdInitialRegistry',
      ].sort()
    );
    const lockKeys = Object.keys(initialLock).sort();
    expect(lockKeys).toEqual(
      [
        'HOUSEHOLD_INITIAL_AGGREGATE_RELEASE_DIGEST',
        'HOUSEHOLD_INITIAL_PROVENANCE_DIGEST',
        'HOUSEHOLD_INITIAL_REGISTRY_LOCK',
        'HOUSEHOLD_INITIAL_REGISTRY_RELEASE',
      ].sort()
    );
    // The provenance module is pure machinery: no data arrays, no grams.
    const provenanceKeys = Object.keys(initialProvenance).sort();
    for (const key of provenanceKeys) {
      expect(key).not.toMatch(/^(RECORDS|PROVENANCE|EQUIVALENCE)$/);
    }
    const namespace = initialData as unknown as Record<string, unknown>;
    for (const key of dataKeys) {
      const value = namespace[key];
      expect(Array.isArray(value), `${key} must not be a raw array`).toBe(false);
      expect(
        (value as Record<string, unknown> | null)?.findByKey,
        `${key} must not be a registry singleton`
      ).toBeUndefined();
    }
    for (const key of [...dataKeys, ...lockKeys, ...provenanceKeys]) {
      expect(key).not.toMatch(/register|insert|update|replace|mutate|save|persist|apply/i);
    }
    expect(typeof initialData.loadHouseholdInitialRegistry).toBe('function');
  });

  it('returns a deeply frozen verified dataset only through the loader', () => {
    const first = loadHouseholdInitialRegistry();
    const second = loadHouseholdInitialRegistry();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.registry).not.toBe(second.registry);
    expect(first.registry.metadata()).toEqual(second.registry.metadata());

    expect(Object.isFrozen(first.dataset)).toBe(true);
    expect(Object.isFrozen(first.dataset.provenance())).toBe(true);
    expect(Object.isFrozen(first.dataset.equivalence())).toBe(true);
    expect(Object.isFrozen(first.registry.records())).toBe(true);
    for (const record of first.registry.records()) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.source)).toBe(true);
      expect(Object.isFrozen(record.usda_fdc_ids)).toBe(true);
    }
    for (const entry of first.dataset.provenance()) expect(Object.isFrozen(entry)).toBe(true);
    for (const entry of first.dataset.equivalence()) expect(Object.isFrozen(entry)).toBe(true);

    expect(() => {
      (first.dataset.provenance()[0] as unknown as Record<string, unknown>).source_fdc_id = 1;
    }).toThrow();
    expect(() => {
      (first.dataset.equivalence()[0] as unknown as Record<string, unknown>).positive_evidence =
        'mutated';
    }).toThrow();

    // Tampering with a returned holder cannot influence a later verified load.
    (first.registry as unknown as Record<string, unknown>).metadata = () => ({
      schema_version: 'household_portion_registry_v1',
      registry_release: 'evil',
      record_count: 0,
      registry_digest: 'a'.repeat(64),
    });
    const third = loadHouseholdInitialRegistry();
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.registry.metadata().registry_digest).toBe(
      HOUSEHOLD_INITIAL_REGISTRY_LOCK.registry_digest
    );
    expect(third.registry.size()).toBe(31);
  });

  it('ships no secret-bearing or credential material', () => {
    for (const { source } of PHASE5_SOURCES) {
      expect(source).not.toMatch(/api[_-]?key|secret|BEGIN (RSA|OPENSSH|PRIVATE)|bearer /i);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioral non-integration: the real pipeline is unchanged by Phase 5
// ---------------------------------------------------------------------------

interface SnapshotEntry {
  readonly line: string;
  readonly fdc: number | null;
  readonly status: string;
  readonly grams: number | null;
  readonly mass: string | null;
}

const SNAPSHOT: ReadonlyArray<SnapshotEntry> = Object.freeze([
  { line: '3 cloves garlic, minced', fdc: 169230, status: 'needs_amount', grams: null, mass: null },
  { line: '2 celery stalks, chopped', fdc: 169988, status: 'needs_amount', grams: null, mass: null },
  { line: '1 medium onion', fdc: 170000, status: 'matched', grams: 110, mass: 'count_portion' },
  { line: '2 medium tomatoes, sliced', fdc: 2709719, status: 'needs_amount', grams: null, mass: null },
  { line: '3 large carrots', fdc: 170393, status: 'matched', grams: 216, mass: 'count_portion' },
  { line: '1 red bell pepper', fdc: 2258590, status: 'needs_amount', grams: null, mass: null },
  { line: '1 medium head green cabbage', fdc: 2346407, status: 'needs_amount', grams: null, mass: null },
  { line: '2 medium potatoes', fdc: 2709382, status: 'needs_amount', grams: null, mass: null },
  { line: '1 stick unsalted butter', fdc: 789828, status: 'needs_amount', grams: null, mass: null },
  { line: '4 slices bacon', fdc: 168277, status: 'matched', grams: 112, mass: 'count_portion' },
  { line: '4 slices bread', fdc: 172686, status: 'matched', grams: 116, mass: 'count_portion' },
  { line: '2 slices white bread', fdc: 2707598, status: 'needs_amount', grams: null, mass: null },
  { line: '1 lemon', fdc: 2709168, status: 'needs_amount', grams: null, mass: null },
  { line: '3 large eggs', fdc: 2707152, status: 'matched', grams: 150, mass: 'count_portion' },
]);

let session: AdvancedNutritionSession;

beforeAll(async () => {
  const inputs = {
    files: USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(BUNDLE_DIR, name))),
    })),
  };
  const result = await composeAdvancedNutritionSessionFromBundle(inputs);
  if (!result.ok) {
    throw new Error(
      `bundle failed: ${(result as { failure: { code: string } }).failure.code}`
    );
  }
  session = result.session;
}, 180000);

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

describe('phase 5 repair — behavioral non-integration', () => {
  it('produces exactly the pinned pre-Phase-5 statuses and grams for ordinary lines', () => {
    const adaptation = adaptRecipe({
      title: 'Phase 5 Repair Non-Integration Snapshot',
      servings: 4,
      ingredients: SNAPSHOT.map((entry) => structuredLine(entry.line)),
    });
    if (!adaptation.ok) throw new Error('adapt failed');
    const adapted = adaptation.recipe.adapted;
    const rows = buildReviewRows(session, adapted);
    const analysis = analyzeRecipe(session, adapted, 4);
    for (let index = 0; index < SNAPSHOT.length; index += 1) {
      const expected = SNAPSHOT[index];
      const analyzer = analysis.rows[index];
      const evidence = analysis.preview?.ingredients[index];
      const best = selectBestEffortMatch(rows[index].review as never);
      const automatic = selectAutomaticMatch(rows[index].review as never);
      const selectedFdc = analyzer.selected_fdc_id ?? best?.fdc_id ?? automatic?.fdc_id ?? null;
      expect(selectedFdc, expected.line).toBe(expected.fdc);
      expect(analyzer.status, expected.line).toBe(expected.status);
      expect(evidence?.resolved_grams ?? null, expected.line).toBe(expected.grams);
      expect(evidence?.mass_source ?? null, expected.line).toBe(expected.mass);
    }
  });
});
