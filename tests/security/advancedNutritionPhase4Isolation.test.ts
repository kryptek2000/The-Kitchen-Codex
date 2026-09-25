/**
 * The Kitchen Codex — Advanced Nutrition Phase 4 isolation / security guard.
 *
 * Proves the Phase 4 review/display layer is pure, offline, persistence-free,
 * fixture-free, and reachable only in the intended direction:
 *   UI components -> Phase 4 orchestration/session -> Phase 1–3 pure modules.
 * The reverse direction and every persistence/network path must fail.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { advancedNutritionApplicationAuthorization } from '../../src/core/nutritionV2/validate';
import { canApplyNutritionEstimate } from '../../src/core/nutritionSanity';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PHASE4_DIR = resolve(ROOT, 'src/core/nutritionV2/phase4');
const COMPONENTS = [
  resolve(ROOT, 'src/components/AdvancedNutritionCard.tsx'),
  resolve(ROOT, 'src/components/AdvancedNutritionModal.tsx'),
];

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

const PHASE4_FILES = listFiles(PHASE4_DIR);
const PHASE4_SOURCES = PHASE4_FILES.map((file) => ({ file, source: readFileSync(file, 'utf8') }));
const COMPONENT_SOURCES = COMPONENTS.map((file) => ({ file, source: readFileSync(file, 'utf8') }));

const FORBIDDEN_GRAPH_SEGMENTS = [
  '/data/foodReference',
  '/core/deterministicNutrition',
  '/server/',
  '/platform/',
  '/application/',
  '/hooks/',
  'markdownParser',
  'nutritionEstimator',
  'nutritionCache',
  'vaultFileSystem',
  'vaultAssets',
  'vaultContent',
  'vaultRecipe',
  'imageHelper',
  'audioAlert',
  'cardExportColors',
  'representativeImage',
  'App.tsx',
  'main.tsx',
  `${sep}tests${sep}`,
];

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
const PERSISTENCE_TOKENS = [
  /codex_nutrition/,
  /encodeCodexNutrition/,
  /applyAdvancedNutritionRoundTrip/,
  /buildNutritionApplyPayload/,
  /serializeRecipeToObsidianMarkdown/,
];
const NONDETERMINISM_TOKENS = [/\bMath\.random\b/, /\bDate\.now\b/, /new\s+Date\s*\(/, /\bperformance\.now\b/];

describe('phase 4 isolation — source purity', () => {
  it('contains no network, secret, persistence, or nondeterminism token', () => {
    for (const { file, source } of [...PHASE4_SOURCES, ...COMPONENT_SOURCES]) {
      const stripped = stripComments(source);
      for (const token of [...NETWORK_TOKENS, ...SECRET_TOKENS, ...PERSISTENCE_TOKENS, ...NONDETERMINISM_TOKENS]) {
        expect(stripped, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('contains only the expected pure modules (no dataset or asset files)', () => {
    const names = PHASE4_FILES.map((file) => file.slice(PHASE4_DIR.length + 1)).sort();
    expect(names).toEqual(
      [
        'adapt.ts',
        'aiAmountResolve.ts',
        'aiResolve.ts',
        'analyzer.ts',
        'countContext.ts',
        'countPortion.ts',
        'display.ts',
        'householdPortion.ts',
        'hydrate.ts',
        'index.ts',
        'liveRow.ts',
        'materialize.ts',
        'portion.ts',
        'rows.ts',
        'session.ts',
        'state.ts',
        'stored.ts',
        'types.ts',
        'userMass.ts',
      ].sort()
    );
    for (const file of PHASE4_FILES) expect(file.endsWith('.ts')).toBe(true);
  });

  it('never imports production test fixtures', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server')];
    const offenders: string[] = [];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          if (/tests\/fixtures|usdaCalculationFixtures|usdaMatchingFixtures|usdaFixtures/.test(match[1])) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not import React or UI from the pure orchestration modules', () => {
    for (const { file, source } of PHASE4_SOURCES) {
      expect(source, file).not.toMatch(/from\s+['"]react['"]/);
      expect(source, file).not.toMatch(/from\s+['"][^'"]*components\//);
    }
  });
});

describe('phase 4 isolation — dependency graph direction', () => {
  const phase4Graph = collectTransitiveGraph(PHASE4_FILES);
  const phase4Rels = Array.from(phase4Graph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));

  it('reaches the intended pure Phase 1–3 modules (positive control)', () => {
    expect(phase4Rels).toContain('src/core/nutritionV2/calculation/context.ts');
    expect(phase4Rels).toContain('src/core/nutritionV2/matching/review.ts');
    expect(phase4Rels.some((rel) => rel.startsWith('src/core/nutritionV2/usda/'))).toBe(true);
    expect(phase4Rels).toContain('src/utils/servingMath.ts');
    expect(phase4Rels).toContain('src/utils/ingredientSemantics.ts');
  });

  it('never reaches persistence, vault, server, platform, provider, or fixture modules', () => {
    for (const rel of phase4Rels) {
      for (const segment of FORBIDDEN_GRAPH_SEGMENTS) {
        expect(`/${rel}`.includes(segment), `${rel} matched ${segment}`).toBe(false);
      }
    }
  });

  it('never reaches the legacy calculation engine or curated food reference', () => {
    expect(phase4Graph.has(resolve(ROOT, 'src/core/deterministicNutrition.ts'))).toBe(false);
    expect(phase4Graph.has(resolve(ROOT, 'src/data/foodReference.ts'))).toBe(false);
  });

  it('the UI components reach Phase 4 and no forbidden module', () => {
    const uiGraph = collectTransitiveGraph(COMPONENTS);
    const uiRels = Array.from(uiGraph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));
    expect(uiRels).toContain('src/core/nutritionV2/phase4/index.ts');
    for (const rel of uiRels) {
      for (const segment of FORBIDDEN_GRAPH_SEGMENTS) {
        expect(`/${rel}`.includes(segment), `${rel} matched ${segment}`).toBe(false);
      }
    }
  });

  it('the reverse direction fails: Phase 1–3 never import Phase 4', () => {
    const lowerLayers = [
      resolve(ROOT, 'src/core/nutritionV2/usda'),
      resolve(ROOT, 'src/core/nutritionV2/matching'),
      resolve(ROOT, 'src/core/nutritionV2/calculation'),
    ];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const dir of lowerLayers) {
      for (const file of listFiles(dir)) {
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          const resolved = resolveProjectSpecifier(file, match[1]);
          expect(resolved && resolved.startsWith(PHASE4_DIR), `${file} must not import Phase 4`).toBe(false);
        }
      }
    }
  });

  it('remains bounded against cycles', () => {
    expect(phase4Graph.size).toBeLessThan(200);
  });
});

describe('phase 4 isolation — application gates stay disabled', () => {
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
