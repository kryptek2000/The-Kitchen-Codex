/**
 * The Kitchen Codex — Advanced Nutrition Phase 5A isolation / no-write guard.
 *
 * Phase 5A constructs an in-memory `codex_nutrition` persistence candidate and a
 * closed Apply authorization result. It MUST NOT persist anything and MUST NOT
 * expose an Apply/Save control. This suite proves:
 *   - source purity (no network, storage, vault, or filesystem write tokens);
 *   - the dependency direction (Phase 5A -> Phase 4 -> Phase 1–3 pure modules);
 *   - the UI components expose no Apply/Save/Persist control and never write.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PHASE5_DIR = resolve(ROOT, 'src/core/nutritionV2/phase5');
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

const PHASE5_FILES = listFiles(PHASE5_DIR);
const PHASE5_SOURCES = PHASE5_FILES.map((file) => ({ file, source: readFileSync(file, 'utf8') }));
const COMPONENT_SOURCES = COMPONENTS.map((file) => ({ file, source: readFileSync(file, 'utf8') }));

const NETWORK_TOKENS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
  /\baxios\b/,
  /\bnode:(http|https|net|dns|tls|fs|path)\b/,
];

/** Storage/vault/filesystem write surfaces that Phase 5A must never touch. */
const WRITE_TOKENS = [
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bcaches\b/,
  /\bserviceWorker\b/,
  /FileSystem(File|Directory)Handle/,
  /\bshowSaveFilePicker\b/,
  /\bwriteFile\b/,
  /\bwriteTextFile\b/,
  /\bvault\.(create|modify|write|delete)/,
  /serializeRecipeToObsidianMarkdown/,
  /applyAdvancedNutritionRoundTrip/,
  /buildNutritionApplyPayload/,
  /\bprocess\s*\.\s*env\b/,
];

const SECRET_TOKENS = [/api[_-]?key/i, /GEMINI_API_KEY/, /api\.data\.gov/];

/** The UI must never present an Apply/Save/Persist control. */
const FORBIDDEN_CONTROL_LABELS = /\b(Apply|Save|Persist|Write to Vault|Update Recipe)\b/i;

describe('phase 5A isolation — source purity', () => {
  it('contains no network, secret, or write token', () => {
    for (const { file, source } of [...PHASE5_SOURCES, ...COMPONENT_SOURCES]) {
      const stripped = stripComments(source);
      for (const token of [...NETWORK_TOKENS, ...SECRET_TOKENS, ...WRITE_TOKENS]) {
        expect(stripped, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('contains only the expected pure modules', () => {
    const names = PHASE5_FILES.map((file) => file.slice(PHASE5_DIR.length + 1)).sort();
    expect(names).toEqual(['authorize.ts', 'index.ts', 'types.ts'].sort());
    for (const file of PHASE5_FILES) expect(file.endsWith('.ts')).toBe(true);
  });

  it('never imports React or UI from the pure authorization module', () => {
    for (const { file, source } of PHASE5_SOURCES) {
      expect(source, file).not.toMatch(/from\s+['"]react['"]/);
      expect(source, file).not.toMatch(/from\s+['"][^'"]*components\//);
    }
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
});

describe('phase 5A isolation — dependency graph direction', () => {
  const phase5Graph = collectTransitiveGraph(PHASE5_FILES);
  const phase5Rels = Array.from(phase5Graph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));

  it('reaches the intended pure Phase 4 authority and Phase 1–3 modules (positive control)', () => {
    expect(phase5Rels).toContain('src/core/nutritionV2/phase4/adapt.ts');
    expect(phase5Rels).toContain('src/core/nutritionV2/phase4/rows.ts');
    expect(phase5Rels).toContain('src/core/nutritionV2/validate.ts');
    expect(phase5Rels.some((rel) => rel.startsWith('src/core/nutritionV2/usda/'))).toBe(true);
  });

  it('never reaches persistence, vault, server, platform, provider, or fixture modules', () => {
    const forbidden = [
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
      'representativeImage',
      'App.tsx',
      'main.tsx',
      `${sep}tests${sep}`,
    ];
    for (const rel of phase5Rels) {
      for (const segment of forbidden) {
        expect(`/${rel}`.includes(segment), `${rel} matched ${segment}`).toBe(false);
      }
    }
  });

  it('the reverse direction fails: Phase 1–4 never import Phase 5A', () => {
    const lowerLayers = [
      resolve(ROOT, 'src/core/nutritionV2/usda'),
      resolve(ROOT, 'src/core/nutritionV2/matching'),
      resolve(ROOT, 'src/core/nutritionV2/calculation'),
      resolve(ROOT, 'src/core/nutritionV2/phase4'),
    ];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const dir of lowerLayers) {
      for (const file of listFiles(dir)) {
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          const resolved = resolveProjectSpecifier(file, match[1]);
          expect(resolved && resolved.startsWith(PHASE5_DIR), `${file} must not import Phase 5A`).toBe(false);
        }
      }
    }
  });

  it('remains bounded against cycles', () => {
    expect(phase5Graph.size).toBeLessThan(220);
  });
});

describe('phase 5A isolation — no Apply UI and no write authority', () => {
  it('the Advanced Nutrition UI offers no Apply/Save/Persist control', () => {
    for (const { file, source } of COMPONENT_SOURCES) {
      const stripped = stripComments(source);
      // No control label in button text or aria-label.
      const buttonTexts = [...stripped.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]);
      for (const button of buttonTexts) {
        expect(button, `${file} has a forbidden control`).not.toMatch(FORBIDDEN_CONTROL_LABELS);
      }
      expect(stripped).not.toMatch(/codex_nutrition/);
    }
  });

  it('the UI reaches Phase 5A but no write surface', () => {
    const uiGraph = collectTransitiveGraph(COMPONENTS);
    const uiRels = Array.from(uiGraph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));
    expect(uiRels).toContain('src/core/nutritionV2/phase5/index.ts');
    for (const rel of uiRels) {
      for (const segment of ['/server/', '/platform/', 'vaultFileSystem', 'vaultAssets', 'markdownParser']) {
        expect(`/${rel}`.includes(segment), `${rel} matched ${segment}`).toBe(false);
      }
    }
  });

  it('the phase 5A barrel exposes only the authorization builder and its contract', () => {
    const barrel = stripComments(readFileSync(resolve(PHASE5_DIR, 'index.ts'), 'utf8'));
    expect(barrel).toContain("export { authorizeNutritionPersistence } from './authorize'");
    expect(barrel).not.toMatch(/serializeRecipeToObsidianMarkdown|writeFile|localStorage/);
  });
});
