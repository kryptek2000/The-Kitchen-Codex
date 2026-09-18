/**
 * The Kitchen Codex — Advanced Nutrition Phase 3 isolation / authority guard.
 *
 * Proves the Phase 3 calculation layer is pure, offline, advisory-only, free of
 * calculation-layer cycles, and unwired from every production surface. Also
 * proves the calculation-context authority is lexically private and that Phase 2
 * authority encapsulation remains intact.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as contextModule from '../../src/core/nutritionV2/calculation/context';
import {
  calculateRecipeNutrition,
  createNutritionCalculationContext,
  reviewFoodPortions,
} from '../../src/core/nutritionV2/calculation/context';
import { advancedNutritionApplicationAuthorization } from '../../src/core/nutritionV2/validate';
import { canApplyNutritionEstimate } from '../../src/core/nutritionSanity';
import { buildCalculationBundle, CALC_FOODS } from '../fixtures/usdaCalculationFixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CALCULATION_DIR = resolve(ROOT, 'src/core/nutritionV2/calculation');
/** The explicit, allowed Phase 4 review/display boundary. */
const PHASE4_DIR = resolve(ROOT, 'src/core/nutritionV2/phase4');
/** The explicit, allowed Phase 5A Apply-authorization boundary (build-only). */
const PHASE5_DIR = resolve(ROOT, 'src/core/nutritionV2/phase5');

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

const CALCULATION_FILES = listFiles(CALCULATION_DIR);
const CALCULATION_SOURCES = CALCULATION_FILES.map((file) => ({ file, source: readFileSync(file, 'utf8') }));

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
const FORBIDDEN_TOKENS = [
  /codex_nutrition/,
  /encodeCodexNutrition/,
  /buildNutritionApplyPayload/,
  /applyAdvancedNutritionRoundTrip/,
  /nutritionForServings/,
];
const NONDETERMINISM_TOKENS = [/\bMath\.random\b/, /\bDate\.now\b/, /new\s+Date\s*\(/, /\bperformance\.now\b/];

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
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function collectTransitiveGraph(entries: ReadonlyArray<string>): Set<string> {
  const visited = new Set<string>();
  const queue = [...entries];
  const patterns = [
    /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
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

function genuineContext() {
  const bundle = buildCalculationBundle(CALC_FOODS);
  const result = createNutritionCalculationContext(bundle.manifest, bundle.records);
  if (!result.ok) throw new Error('context failed');
  return result.context;
}

describe('phase 3 calculation — lexical authority encapsulation', () => {
  it('the authority boundary module exports only the intentional public operations', () => {
    expect(Object.keys(contextModule).sort()).toEqual(
      [
        'calculateRecipeNutrition',
        'createNutritionCalculationContext',
        'reviewFoodCountPortions',
        'reviewFoodPortions',
      ].sort()
    );
    for (const key of Object.keys(contextModule)) {
      expect(key).not.toMatch(/register|authority|registry|contextAuthority|retrieve/i);
    }
  });

  it('no calculation module exports a context-registration/retrieval capability', async () => {
    const names = CALCULATION_FILES.map((file) => file.slice(CALCULATION_DIR.length + 1).replace(/\.ts$/, ''));
    for (const name of names) {
      const mod = (await import(`../../src/core/nutritionV2/calculation/${name}`)) as Record<string, unknown>;
      for (const key of Object.keys(mod)) {
        expect(key, `${name}.${key}`).not.toMatch(/register|authority|registry|contextAuthority|retrieve/i);
      }
    }
  });

  it('source audit: the context authority registry is a non-exported WeakMap in context.ts', () => {
    for (const file of CALCULATION_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const line of source.split('\n')) {
        if (!/^\s*export\b/.test(line)) continue;
        expect(line, file).not.toMatch(/register|authority|registry|WeakMap/i);
      }
      if (/new\s+WeakMap/.test(source)) {
        expect(file.endsWith('context.ts')).toBe(true);
        expect(source).not.toMatch(/export\s+(const|let|var)\s+\w*(AUTHORITY|REGISTRY)/);
      }
    }
  });

  it('rejects fake/clone/proxy/inherited contexts and keeps the genuine one working', () => {
    const context = genuineContext();
    const request = {
      servings: 1,
      nutrient_scope: ['calories'],
      ingredients: [{ line_ref: 'a', ingredient: '100 g Flour, wheat, white' }],
    };
    const fakes = [
      { metadata: () => context.metadata() },
      { ...context },
      new Proxy(context, {}),
      Object.create(context),
      {},
      null,
      42,
    ];
    for (const fake of fakes) {
      const result = calculateRecipeNutrition(fake, request);
      expect(result.ok, JSON.stringify(fake)).toBe(false);
      if (!result.ok) {
        expect((result as { ok: false; failure: { code: string } }).failure.code).toBe('invalid_context');
      }
    }
    expect(calculateRecipeNutrition(context, request).ok).toBe(true);
    expect(reviewFoodPortions(context, 3001).ok).toBe(true);
    expect(reviewFoodPortions(context, 999999).ok).toBe(false);
  });

  it('does not expose private records or authority', () => {
    const context = genuineContext();
    const mod = contextModule as unknown as Record<string, unknown>;
    for (const forbidden of ['resolveContextAuthority', 'registerContextAuthority', 'CONTEXT_AUTHORITY', 'authority', 'registry']) {
      expect(mod[forbidden], forbidden).toBeUndefined();
    }
    expect(Object.keys(context)).toEqual(['metadata']);
  });
});

describe('phase 3 calculation — isolation and purity', () => {
  it('contains no network, secret, persistence, or nondeterminism token', () => {
    for (const { file, source } of CALCULATION_SOURCES) {
      const stripped = stripComments(source);
      for (const token of [...NETWORK_TOKENS, ...SECRET_TOKENS, ...FORBIDDEN_TOKENS, ...NONDETERMINISM_TOKENS]) {
        expect(stripped, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('is imported ONLY by the explicit Phase 4 and Phase 5A boundaries', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server')];
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        if (file.startsWith(CALCULATION_DIR)) continue;
        if (file.startsWith(PHASE4_DIR)) continue; // allowed Phase 4 review/display path
        if (file.startsWith(PHASE5_DIR)) continue; // allowed Phase 5A build-only path
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          const resolved = resolveProjectSpecifier(file, match[1]);
          if (resolved && resolved.startsWith(CALCULATION_DIR)) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);

    // Positive control: the Phase 4 boundary DOES import Phase 3.
    let phase4Importers = 0;
    for (const file of listFiles(PHASE4_DIR)) {
      const source = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const resolved = resolveProjectSpecifier(file, match[1]);
        if (resolved && resolved.startsWith(CALCULATION_DIR)) {
          phase4Importers += 1;
          break;
        }
      }
    }
    expect(phase4Importers).toBeGreaterThan(0);

    // Positive control: the Phase 5A boundary DOES import the Phase 3 contracts.
    let phase5Importers = 0;
    for (const file of listFiles(PHASE5_DIR)) {
      const source = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const resolved = resolveProjectSpecifier(file, match[1]);
        if (resolved && resolved.startsWith(CALCULATION_DIR)) {
          phase5Importers += 1;
          break;
        }
      }
    }
    expect(phase5Importers).toBeGreaterThan(0);

    expect(readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8')).not.toMatch(/calculation/i);
    expect(readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8')).not.toMatch(/calculation/i);
    // Phase 4 is intentionally NOT re-exported from any public barrel.
    expect(readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8')).not.toMatch(/phase4/i);
    expect(readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8')).not.toMatch(/phase4/i);
  });

  it('reaches no calculation engine, UI, server, persistence, provider, or fixture module', () => {
    const graph = collectTransitiveGraph(CALCULATION_FILES);
    const rels = Array.from(graph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));
    for (const forbidden of FORBIDDEN_GRAPH_MODULES) expect(graph.has(forbidden), forbidden).toBe(false);
    for (const rel of rels) {
      for (const segment of FORBIDDEN_GRAPH_SEGMENTS) {
        expect(`/${rel}`.includes(segment), `${rel} matched ${segment}`).toBe(false);
      }
    }
    // Positive control: the calculation-free shared helpers are reachable.
    expect(rels).toContain('src/utils/ingredientSemantics.ts');
    expect(rels).toContain('src/utils/servingMath.ts');
    expect(graph.size).toBeLessThan(200);
  });

  it('keeps Phase 2 authority encapsulation intact', async () => {
    const phase2 = (await import('../../src/core/nutritionV2/matching/review')) as Record<string, unknown>;
    expect(phase2.registerCatalogAuthority).toBeUndefined();
    expect(phase2.getCatalogAuthority).toBeUndefined();
  });

  it('keeps application authorization globally disabled', () => {
    expect(advancedNutritionApplicationAuthorization()).toEqual({
      ok: false,
      reasons: ['automated_application_disabled_pending_provenance_persistence'],
    });
    const result = canApplyNutritionEstimate(
      { calories: 100, protein: 1, carbohydrates: 1, fat: 1, fiber: 0, sodium: 0 },
      undefined,
      1
    );
    expect(result.ok).toBe(false);
  });
});
