/**
 * The Kitchen Codex — Advanced Nutrition Phase 5B isolation / write-authority guard.
 *
 * Phase 5B introduces the ONLY Advanced Nutrition write capability. This suite
 * proves the capability is tightly scoped:
 *   - the Phase 5A core stays pure/no-write;
 *   - the Phase 5B coordinator is application-layer and platform-neutral (no
 *     direct File System Access / storage / network / provider APIs);
 *   - the actual persistence is injected through the existing recipe write path;
 *   - lower phases never depend on Phase 5B;
 *   - the Advanced Nutrition UI components never import the application layer
 *     (the Apply handler is injected as a prop);
 *   - no automatic/background write surface exists.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PHASE5_CORE_DIR = resolve(ROOT, 'src/core/nutritionV2/phase5');
const APPLY_MODULE = resolve(ROOT, 'src/application/advancedNutritionApply.ts');
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

const NETWORK_TOKENS = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bsendBeacon\b/, /\baxios\b/, /\/api\//];
const DIRECT_PLATFORM_TOKENS = [
  /\bshowDirectoryPicker\b/,
  /\bcreateWritable\b/,
  /\bFileSystem(File|Directory)Handle\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bcaches\b/,
  /\bserviceWorker\b/,
  /\bwindow\b/,
  /\bdocument\b/,
];
const SECRET_TOKENS = [/api[_-]?key/i, /GEMINI_API_KEY/, /OPENROUTER/, /process\s*\.\s*env/];
const AUTO_WRITE_TOKENS = [/\bsetInterval\b/, /\bsetTimeout\b/, /\bMutationObserver\b/, /\baddEventListener\b/];

describe('phase 5B isolation — write authority is tightly scoped', () => {
  it('the Phase 5A core still contains no write/storage/network token', () => {
    const forbidden = [
      ...NETWORK_TOKENS,
      ...DIRECT_PLATFORM_TOKENS,
      ...SECRET_TOKENS,
      /\bwriteFile\b/,
      /serializeRecipeToObsidianMarkdown/,
    ];
    for (const file of listFiles(PHASE5_CORE_DIR)) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      for (const token of forbidden) expect(stripped, `${file} matched ${token}`).not.toMatch(token);
    }
  });

  it('the Phase 5B coordinator is platform-neutral (no direct FSA/storage/network/provider API)', () => {
    const stripped = stripComments(readFileSync(APPLY_MODULE, 'utf8'));
    for (const token of [
      ...NETWORK_TOKENS,
      ...DIRECT_PLATFORM_TOKENS,
      ...SECRET_TOKENS,
      ...AUTO_WRITE_TOKENS,
    ]) {
      expect(stripped, `${APPLY_MODULE} matched ${token}`).not.toMatch(token);
    }
  });

  it('the Phase 5B coordinator never reaches platform/browser/UI modules', () => {
    const graph = collectTransitiveGraph([APPLY_MODULE]);
    const rels = Array.from(graph).map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'));
    for (const rel of rels) {
      for (const segment of ['/platform/', '/browser/', '/components/', '/application-ui/', 'vaultFileSystem', 'vaultAssets']) {
        expect(`/${rel}`.includes(segment), `${rel} matched ${segment}`).toBe(false);
      }
    }
    // Positive control: it reuses the canonical serializer + Phase 5A core.
    expect(rels).toContain('src/utils/markdownParser.ts');
    expect(rels).toContain('src/core/nutritionV2/phase5/index.ts');
  });

  it('lower phases never import the Phase 5B application coordinator', () => {
    const lowerLayers = [
      resolve(ROOT, 'src/core/nutritionV2'),
      resolve(ROOT, 'src/core'),
    ];
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const dir of lowerLayers) {
      for (const file of listFiles(dir)) {
        const source = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(source)) !== null) {
          expect(/advancedNutritionApply/.test(match[1]), `${file} must not import Phase 5B`).toBe(false);
        }
      }
    }
  });

  it('the Advanced Nutrition UI components never import the application layer', () => {
    for (const file of COMPONENTS) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"][^'"]*application\//);
    }
  });

  it('the Phase 5B coordinator is not re-exported from the public core barrels', () => {
    const nutritionBarrel = readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8');
    const coreBarrel = readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8');
    for (const source of [nutritionBarrel, coreBarrel]) {
      expect(source).not.toMatch(/advancedNutritionApply/);
      expect(source).not.toMatch(/applyAdvancedNutrition/);
    }
  });

  it('the Phase 5B coordinator writes only through the injected write port', () => {
    const source = stripComments(readFileSync(APPLY_MODULE, 'utf8'));
    // The only persistence call is the injected `write` port.
    expect(source).toContain('await (writeField.value as AdvancedNutritionWritePort)(updated)');
    expect(source).not.toMatch(/\bwriteText\s*\(/);
    expect(source).not.toMatch(/createWritable/);
  });
});
