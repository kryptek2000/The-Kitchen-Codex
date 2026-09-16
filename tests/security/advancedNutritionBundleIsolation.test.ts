/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B isolation / security guard.
 *
 * Proves the browser runtime loader is fixed, local, offline, persistence-free,
 * fixture-free, and lock-bound:
 *   - the production entry point accepts no caller URL/directory/release lock/
 *     environment override/replacement byte source;
 *   - the runtime + asset source import no Node/fs/ZIP/Python/child/server/
 *     provider/persistence/vault/fixture module and perform no network fetch;
 *   - asset references are compile-time-owned local bundle files only;
 *   - errors are fixed, bounded, and input-redacted;
 *   - nothing is written to browser or vault persistence;
 *   - the Obsidian plugin graph never reaches the browser asset source.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { composeAdvancedNutritionSessionFromBundle } from '../../src/core/nutritionV2/runtime';
import { USDA_BUNDLE_RELEASE_LOCK } from '../../src/core/nutritionV2/usda/releaseLock';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(source)) !== null) specs.push(match[1]);
  return specs;
}

function resolveProjectSpecifier(fromFile: string, specifier: string): string | null {
  const clean = specifier.split('?')[0];
  const ALIAS = '@/';
  let base: string | null = null;
  if (clean.startsWith(ALIAS)) base = resolve(ROOT, clean.slice(ALIAS.length));
  else if (clean.startsWith('.')) base = resolve(dirname(fromFile), clean);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function collectGraph(entries: ReadonlyArray<string>): Set<string> {
  const visited = new Set<string>();
  const queue = [...entries];
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
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveProjectSpecifier(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return visited;
}

const RUNTIME_ENTRY = resolve(ROOT, 'src/core/nutritionV2/runtime/index.ts');
const LOADER = resolve(ROOT, 'src/browser/advancedNutritionBundle.ts');
const ASSETS = resolve(ROOT, 'src/application/advancedNutritionBundleAssets.ts');
const FETCH = resolve(ROOT, 'src/platform/browser/advancedNutritionBundleFetch.ts');
const HOOK = resolve(ROOT, 'src/application-ui/useAdvancedNutritionBundle.ts');
const PURE_RUNTIME_GRAPH = collectGraph([RUNTIME_ENTRY, LOADER, ASSETS]);
const PHASE45B_FILES = [
  ...listFiles(resolve(ROOT, 'src/core/nutritionV2/runtime')).filter((f) => f.endsWith('.ts')),
  LOADER,
  ASSETS,
  HOOK,
];
const ALLOWED_PLATFORM_FETCH_REL = 'src/platform/browser/advancedNutritionBundleFetch.ts';

const FORBIDDEN_SPECIFIER = [
  /^react$/,
  /^react-dom(\/|$)/,
  /^express$/,
  /^node:/,
  /^fs(\/|$)/,
  /^path$/,
  /^zlib$/,
  /^buffer$/,
  /^crypto$/,
  /^child_process$/,
  /^worker_threads$/,
  /^os$/,
  /^stream$/,
  /^http2?$/,
  /^https$/,
  /^@google\/genai$/,
];

const FORBIDDEN_PATH_SEGMENTS = [
  'usda_bundle',
  'zip_extract',
  'stream_json',
  'generate.cli',
  'verify.cli',
  '/server/',
  '/platform/',
  '/hooks/',
  'vaultFileSystem',
  'vaultAssets',
  'vaultRecipe',
  'vaultContent',
  'markdownParser',
  'imageHelper',
  'audioAlert',
  `${sep}tests${sep}`,
];

const FORBIDDEN_TOKENS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
  /\bprocess\s*[.\[]/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bcaches\b/,
  /\bserviceWorker\b/,
  /\bcodex_nutrition\b/,
  /\bapi\.data\.gov\b/,
];

describe('phase 4.5B isolation — fixed, local, offline loader', () => {
  it('the production entry point accepts no caller URL/dir/lock/env/replacement byte source', () => {
    const source = readFileSync(LOADER, 'utf8');
    // A fixed no-argument production loader.
    expect(source).toMatch(/export async function loadProductionAdvancedNutritionSession\(\)/);
    const stripped = stripComments(source);
    expect(stripped).not.toMatch(/process\s*[.\[]/);
    expect(stripped).not.toMatch(/\bfetch\s*\(/);
    expect(stripped).not.toMatch(/\bnew\s+URL\b/);
    expect(stripped).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    // The lock is the source-controlled import only, never a caller parameter.
    expect(stripped).not.toMatch(/USDA_BUNDLE_RELEASE_LOCK\s*[,)]/);
  });

  it('the asset module is a compile-time-owned URL map with no payload or fetch', () => {
    const source = readFileSync(ASSETS, 'utf8');
    const specs = importSpecifiers(source).filter((spec) => spec.includes('advanced-nutrition'));
    const expected = USDA_BUNDLE_RELEASE_LOCK.artifact_filenames.map(
      (name) => `../../data/advanced-nutrition/usda/${USDA_BUNDLE_RELEASE_LOCK.bundle_release}/${name}`
    );
    expect(specs.length).toBe(5);
    for (const spec of specs) {
      const clean = spec.split('?')[0];
      expect(expected).toContain(clean);
      expect(spec).toMatch(/\?url&no-inline$/);
    }
    // No payload, no dynamic import, no caller-supplied/network source.
    const stripped = stripComments(source);
    expect(stripped).not.toMatch(/base64|data:application|gzip;base64/);
    expect(stripped).not.toMatch(/import\s*\(\s*[^'"]/);
    expect(stripped).not.toMatch(/process\s*[.\[]|\bfetch\s*\(|\bnew\s+URL\b/);
  });

  it('the only network access is the fixed platform fetch module', () => {
    const fetchSource = stripComments(readFileSync(FETCH, 'utf8'));
    expect(fetchSource).toMatch(/\bfetch\b/);
    expect(fetchSource).toMatch(/redirect:\s*'error'/);
    expect(fetchSource).toMatch(/credentials:\s*'omit'/);
    expect(fetchSource).toMatch(/cache:\s*'no-store'/);
    expect(fetchSource).toMatch(/new URL\(/);
    expect(fetchSource).toMatch(/origin/);
    // No other Phase 4.5B module performs a bare fetch.
    for (const file of PHASE45B_FILES) {
      expect(stripComments(readFileSync(file, 'utf8')), file).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('no production module imports the offline bundle tooling', () => {
    const productionRoots = [resolve(ROOT, 'src'), resolve(ROOT, 'server'), resolve(ROOT, 'plugin')];
    const offenders: string[] = [];
    for (const root of productionRoots) {
      for (const file of listFiles(root)) {
        if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
        for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
          if (/usda_bundle|zip_extract|stream_json|generate\.cli|verify\.cli/.test(spec)) {
            offenders.push(file.slice(ROOT.length + 1));
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pure runtime/asset/loader graph imports no Node/fs/ZIP/Python/child/server/provider/persistence/vault/fixture module', () => {
    for (const file of PURE_RUNTIME_GRAPH) {
      if (file.includes(`${sep}node_modules${sep}`)) continue;
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      const isAllowedPlatformFetch = rel === ALLOWED_PLATFORM_FETCH_REL;
      for (const segment of FORBIDDEN_PATH_SEGMENTS) {
        // The ONE sanctioned browser transport is the fixed same-origin fetch.
        if (isAllowedPlatformFetch && segment === '/platform/') continue;
        expect(`/${rel}/`.includes(segment), `${rel} matched ${segment}`).toBe(false);
      }
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        for (const re of FORBIDDEN_SPECIFIER) {
          expect(re.test(spec), `${rel} imported ${spec}`).toBe(false);
        }
      }
    }
    // Exactly one platform module is reachable: the fixed fetch transport.
    const platformRels = Array.from(PURE_RUNTIME_GRAPH)
      .map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .filter((rel) => rel.includes('/platform/'));
    expect(platformRels).toEqual([ALLOWED_PLATFORM_FETCH_REL]);
  });

  it('the Phase 4.5B modules contain no network, secret, persistence, or nondeterminism token', () => {
    for (const file of PHASE45B_FILES) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      for (const token of FORBIDDEN_TOKENS) {
        expect(stripped, `${file.slice(ROOT.length + 1)} matched ${token}`).not.toMatch(token);
      }
      // No timers / locale- or timezone-dependent behavior in the load path.
      expect(stripped, `${file} timer`).not.toMatch(/\bsetTimeout\s*\(|\bsetInterval\s*\(/);
      expect(stripped, `${file} locale`).not.toMatch(/toLocaleLowerCase|toLocaleUpperCase|Intl\./);
    }
  });

  it('the React hook imports only React and pure core/application types', () => {
    const source = readFileSync(HOOK, 'utf8');
    for (const spec of importSpecifiers(source)) {
      const clean = spec.split('?')[0];
      const allowed =
        clean === 'react' ||
        clean.startsWith('./') ||
        clean.startsWith('../core/') ||
        clean.startsWith('../application/');
      expect(allowed, `${HOOK} imported ${spec}`).toBe(true);
    }
  });

  it('errors are fixed, bounded, and input-redacted', async () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'files', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('attacker-controlled-message');
      },
    });
    const result = await composeAdvancedNutritionSessionFromBundle(hostile);
    expect(result.ok).toBe(false);
    // The hostile getter is never invoked; the failure is a fixed code/message.
    const failure = (result as { failure: { code: string; message: string } }).failure;
    expect(failure.code).toBe('invalid_inputs');
    expect(failure.message).toBe('advanced_nutrition_bundle_invalid_inputs');
    expect(failure.message).not.toMatch(/attacker/);
    expect(failure.message.length).toBeLessThanOrEqual(120);
  });

  it('the Obsidian plugin graph never reaches the browser asset source or runtime composer', () => {
    const pluginGraph = collectGraph([resolve(ROOT, 'plugin/main.ts')]);
    const rels = Array.from(pluginGraph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));
    expect(rels).not.toContain('src/browser/advancedNutritionBundle.ts');
    expect(rels).not.toContain('src/application/advancedNutritionBundleAssets.ts');
    expect(rels).not.toContain('src/platform/browser/advancedNutritionBundleFetch.ts');
    expect(rels.some((rel) => rel.startsWith('src/core/nutritionV2/runtime/'))).toBe(false);
    // Positive control: the plugin still reaches its real composition modules.
    expect(rels).toContain('src/application/createAppServices.ts');
  });
});

describe('phase 4.5B isolation — decoded-shard validation is module-private', () => {
  const BUNDLE_SOURCE = readFileSync(resolve(ROOT, 'src/core/nutritionV2/runtime/bundle.ts'), 'utf8');

  it('exports no decoded-shard or canonical-record-returning helper from any runtime barrel', async () => {
    const barrel = (await import('../../src/core/nutritionV2/runtime/index')) as Record<string, unknown>;
    const keys = Object.keys(barrel);
    expect(keys).not.toContain('validateDecodedShard');
    expect(keys).not.toContain('RuntimeShardExpectation');
    expect(keys).not.toContain('DecodedShardValidation');
    // No exported helper name suggests shard/record authority.
    for (const key of keys) expect(key).not.toMatch(/shard|record/i);
    // The success composer is the only exported operation that builds authority.
    expect(typeof barrel.composeAdvancedNutritionSessionFromBundle).toBe('function');
  });

  it('the private helper has no export and no public import path', () => {
    expect(BUNDLE_SOURCE).not.toMatch(/export\s+(?:interface|type|function|const)\s+validateDecodedShard/);
    expect(BUNDLE_SOURCE).not.toMatch(/export\s+(?:interface|type)\s+(?:RuntimeShardExpectation|DecodedShardValidation)/);
    expect(BUNDLE_SOURCE).toMatch(/function\s+validateDecodedShard\(/);
    // No other production module can import it.
    for (const file of listFiles(resolve(ROOT, 'src'))) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      if (file === resolve(ROOT, 'src/core/nutritionV2/runtime/bundle.ts')) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/validateDecodedShard/);
    }
  });

  it('the production module has no override, lock-injection, or debug mechanism', () => {
    const stripped = stripComments(BUNDLE_SOURCE);
    expect(stripped).not.toMatch(/globalThis\s*[.\[]/);
    expect(stripped).not.toMatch(/process\s*[.\[]/);
    expect(stripped).not.toMatch(/\bwindow\b|\bdocument\b/);
    expect(stripped).not.toMatch(
      /setValidator|registerValidator|overrideLock|lockOverride|injectLock|__debug|__test|debugHook|setReleaseLock/
    );
    // The composer's signature accepts only `inputs` (no lock/validator argument).
    expect(BUNDLE_SOURCE).toMatch(
      /export async function composeAdvancedNutritionSessionFromBundle\(\s*inputs: unknown\s*\)/
    );
    expect(composeAdvancedNutritionSessionFromBundle.length).toBe(1);
  });
});
