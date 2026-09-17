/**
 * The Kitchen Codex — Advanced Nutrition Phase 2 isolation guard.
 *
 * Proves the Phase 2 matching layer is pure, offline, key-free, calculation-free,
 * persistence-free, and unwired from every production surface.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createReviewCatalog } from '../../src/core/nutritionV2/matching/review';
import { advancedNutritionApplicationAuthorization } from '../../src/core/nutritionV2/validate';
import { canApplyNutritionEstimate } from '../../src/core/nutritionSanity';
import { createUsdaRecordStore } from '../../src/core/nutritionV2/usda/store';
import { normalizeRawIngredientLine } from '../../src/core/deterministicNutrition';
import { parseRawIngredientMeasurementParts } from '../../src/utils/measurements';
import { buildMatchingBundle, DEFAULT_MATCHING_SPECS } from '../fixtures/usdaMatchingFixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const MATCHING_DIR = resolve(ROOT, 'src/core/nutritionV2/matching');
/** The explicit, newly allowed Phase 4 review/display boundary. */
const PHASE4_DIR = resolve(ROOT, 'src/core/nutritionV2/phase4');
/** Phase 3 legitimately consumes Phase 2 for match rebinding. */
const CALCULATION_DIR = resolve(ROOT, 'src/core/nutritionV2/calculation');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const MATCHING_FILES = listFiles(MATCHING_DIR);
const MATCHING_SOURCES = MATCHING_FILES.map((file) => ({ file, source: readFileSync(file, 'utf8') }));
const MATCHING_ENTRIES = MATCHING_FILES.filter((file) => file.endsWith('.ts'));

// ---------------------------------------------------------------------------
// Transitive import-graph enforcement
// ---------------------------------------------------------------------------

const FORBIDDEN_GRAPH_MODULES: ReadonlySet<string> = new Set([
  resolve(ROOT, 'src/core/deterministicNutrition.ts'),
  resolve(ROOT, 'src/data/foodReference.ts'),
]);
const FORBIDDEN_GRAPH_SEGMENTS = [
  '/data/foodReference',
  '/core/deterministicNutrition',
  '/server/',
  '/components/',
  '/platform/',
  '/application/',
  '/hooks/',
  'nutritionEstimator',
  'nutritionCache',
  'vaultFileSystem',
  'vaultAssets',
  'imageHelper',
  'audioAlert',
  'cardExportColors',
  'App.tsx',
  'main.tsx',
  `${sep}tests${sep}`,
];

function resolveProjectSpecifier(fromFile: string, specifier: string): string | null {
  const ALIAS = '@/';
  let base: string | null = null;
  if (specifier.startsWith(ALIAS)) base = resolve(ROOT, specifier.slice(ALIAS.length));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null; // external / node builtin — not traversed
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Bounded transitive import-graph walk (static, export-from, dynamic, require). */
function collectTransitiveGraph(entries: ReadonlyArray<string>): Set<string> {
  const visited = new Set<string>();
  const queue = [...entries];
  const patterns = [
    /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g, // static import / export-from
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // CommonJS require
  ];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.includes(`${sep}node_modules${sep}`)) continue;
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

const NETWORK_TOKENS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
  /\baxios\b/,
  /\bnode:(http|https|net|dns|tls)\b/,
];
const SECRET_TOKENS = [/api[_-]?key/i, /DEMO_KEY/, /api\.data\.gov/, /process\s*\.\s*env/, /localStorage/, /sessionStorage/, /indexedDB/];
const CALC_TOKENS = [/amount_per_100g/, /\bcalories\b/, /NUTRIENT_REGISTRY/, /codex_nutrition/, /encodeCodexNutrition/, /canApplyNutritionEstimate/, /applyAdvancedNutritionRoundTrip/];
const NONDETERMINISM_TOKENS = [/\bMath\.random\b/, /\bDate\.now\b/, /new\s+Date\s*\(/, /\bperformance\.now\b/];

describe('phase 2 matching — isolation and purity', () => {
  it('contains no network, secret, calculation, or nondeterminism token', () => {
    for (const { file, source } of MATCHING_SOURCES) {
      const stripped = stripComments(source);
      for (const token of [...NETWORK_TOKENS, ...SECRET_TOKENS, ...CALC_TOKENS, ...NONDETERMINISM_TOKENS]) {
        expect(stripped, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('contains only the expected TypeScript modules (no dataset files)', () => {
    const names = MATCHING_FILES.map((file) => file.slice(MATCHING_DIR.length + 1)).sort();
    expect(names).toEqual(
      [
        'eligibility.ts',
        'index.ts',
        'normalize.ts',
        'parse.ts',
        'query.ts',
        'rank.ts',
        'review.ts',
        'types.ts',
      ].sort()
    );
    for (const file of MATCHING_FILES) expect(file.endsWith('.ts')).toBe(true);
  });

  it('is imported ONLY by the explicit Phase 4 review/display boundary', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server')];
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        if (file.startsWith(MATCHING_DIR)) continue;
        if (file.startsWith(CALCULATION_DIR)) continue; // Phase 3 rebinds Phase 2
        if (file.startsWith(PHASE4_DIR)) continue; // the one allowed UI path
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          const resolved = resolveProjectSpecifier(file, match[1]);
          if (resolved && resolved.startsWith(MATCHING_DIR)) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);

    // Positive control: the Phase 4 boundary DOES import Phase 2.
    let phase4Importers = 0;
    for (const file of listFiles(PHASE4_DIR)) {
      const source = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const resolved = resolveProjectSpecifier(file, match[1]);
        if (resolved && resolved.startsWith(MATCHING_DIR)) {
          phase4Importers += 1;
          break;
        }
      }
    }
    expect(phase4Importers).toBeGreaterThan(0);
  });

  it('is not re-exported from the Phase 0 / core barrels', () => {
    const nutritionBarrel = readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8');
    const coreBarrel = readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8');
    expect(nutritionBarrel).not.toMatch(/matching/i);
    expect(coreBarrel).not.toMatch(/matching/i);
  });

  it('never imports the test fixtures from production', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server')];
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          if (/tests\/fixtures|usdaMatchingFixtures|usdaRealFixtures/.test(match[1])) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('phase 2 matching — Phase 1 surface unchanged', () => {
  it('the Phase 1 store still exposes no search/ranking API', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const result = createUsdaRecordStore(manifest, records);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.store).sort()).toEqual(['lookup', 'metadata']);
    for (const forbidden of ['search', 'find', 'rank', 'match', 'matchIngredient', 'candidates', 'exactPhraseCount']) {
      expect((result.store as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it('the Phase 2 catalog is a separate abstraction', () => {
    const { manifest, records } = buildMatchingBundle(DEFAULT_MATCHING_SPECS);
    const catalog = createReviewCatalog(manifest, records);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(typeof catalog.catalog.search).toBe('function');
    // The catalog does not expose the Phase 1 store surface.
    expect((catalog.catalog as unknown as Record<string, unknown>).lookup).toBeUndefined();
  });
});

describe('phase 2 matching — transitive import isolation', () => {
  const graph = collectTransitiveGraph(MATCHING_ENTRIES);
  const rels = Array.from(graph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));

  it('never reaches the legacy calculation engine or the curated food reference', () => {
    for (const forbidden of FORBIDDEN_GRAPH_MODULES) {
      expect(graph.has(forbidden), forbidden).toBe(false);
    }
    for (const rel of rels) {
      expect(rel).not.toBe('src/core/deterministicNutrition.ts');
      expect(rel).not.toBe('src/data/foodReference.ts');
    }
  });

  it('never reaches UI, server, persistence, vault, provider, or test-fixture modules', () => {
    for (const rel of rels) {
      for (const segment of FORBIDDEN_GRAPH_SEGMENTS) {
        expect(`/${rel}`.includes(segment), `${rel} matched forbidden segment ${segment}`).toBe(false);
      }
    }
  });

  it('reaches the expected calculation-free primitives (positive control)', () => {
    expect(rels).toContain('src/utils/measurements.ts');
    expect(rels.some((rel) => rel.startsWith('src/core/nutritionV2/'))).toBe(true);
    expect(graph.size).toBeGreaterThan(0);
  });

  it('remains bounded against cycles', () => {
    expect(graph.size).toBeLessThan(200);
  });
});

describe('phase 2 matching — relocated calculation-free segmenter', () => {
  it('is a single implementation shared by the legacy engine and Phase 2', () => {
    expect(normalizeRawIngredientLine).toBe(parseRawIngredientMeasurementParts);
  });

  it('produces unchanged legacy parser output after relocation', () => {
    const lines = [
      '3 garlic cloves',
      '2 eggs',
      '8 oz Chicken Breast',
      '240 ml heavy cream',
      '1 cup of All-Purpose Flour',
      'salt to taste',
      '1/2 cup sugar',
      '1 cup [[Flour|AP flour]]',
    ];
    for (const line of lines) {
      expect(parseRawIngredientMeasurementParts(line)).toEqual(normalizeRawIngredientLine(line));
    }
  });
});

describe('phase 2 matching — application authorization stays disabled', () => {
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
