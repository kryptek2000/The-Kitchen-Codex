/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C isolation guard.
 *
 * Phase 5C is presentation/workflow consolidation only. This suite proves the
 * pure precedence selector stays pure (no write/storage/network/provider access,
 * deterministic), is not re-exported from public barrels, and that the
 * consolidated UI gains no nutrition write authority and no Phase 6 behavior.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PHASE5C_DIR = resolve(ROOT, 'src/core/nutritionV2/phase5c');
const SECTION = resolve(ROOT, 'src/components/RecipeNutritionSection.tsx');

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

const NETWORK_TOKENS = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\/api\//, /\baxios\b/];
const WRITE_TOKENS = [
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bcaches\b/,
  /\bserviceWorker\b/,
  /\bshowDirectoryPicker\b/,
  /\bcreateWritable\b/,
  /\bwriteFile\b/,
  /serializeRecipeToObsidianMarkdown/,
  /advancedNutritionApply/,
];
const SECRET_TOKENS = [/api[_-]?key/i, /GEMINI_API_KEY/, /OPENROUTER/, /process\s*\.\s*env/];
const NONDETERMINISM_TOKENS = [/\bMath\.random\b/, /\bDate\.now\b/, /new\s+Date\s*\(/, /\bperformance\.now\b/];
const PHASE6_TOKENS = [/\bscanVault\b/, /\bbulk[A-Z]/, /\bmigrat/, /\bnutritionIndex\b/, /VaultIntelligence/];

describe('phase 5C isolation — pure selector', () => {
  it('contains no network, write, storage, secret, or nondeterminism token', () => {
    for (const file of listFiles(PHASE5C_DIR)) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      for (const token of [...NETWORK_TOKENS, ...WRITE_TOKENS, ...SECRET_TOKENS, ...NONDETERMINISM_TOKENS]) {
        expect(stripped, `${file} matched ${token}`).not.toMatch(token);
      }
    }
  });

  it('is not re-exported from the public core barrels', () => {
    const nutritionBarrel = readFileSync(resolve(ROOT, 'src/core/nutritionV2/index.ts'), 'utf8');
    const coreBarrel = readFileSync(resolve(ROOT, 'src/core/index.ts'), 'utf8');
    for (const source of [nutritionBarrel, coreBarrel]) {
      expect(source).not.toMatch(/phase5c/);
      expect(source).not.toMatch(/resolveRecipeNutritionPresentation/);
    }
  });

  it('does not import application/platform/UI modules', () => {
    const importRe = /(?:from|import)\s*(?:\(\s*)?\s*['"]([^'"]+)['"]/g;
    for (const file of listFiles(PHASE5C_DIR)) {
      const source = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((match = importRe.exec(source)) !== null) {
        const resolved = resolveProjectSpecifier(file, match[1]);
        if (resolved) {
          for (const segment of ['/application/', '/platform/', '/components/', '/browser/']) {
            expect(resolved.includes(segment), `${file} imported ${resolved}`).toBe(false);
          }
        }
      }
    }
  });

  it('the consolidated section gains no write authority and no Phase 6 behavior', () => {
    const stripped = stripComments(readFileSync(SECTION, 'utf8'));
    for (const token of [...NETWORK_TOKENS, ...WRITE_TOKENS, ...SECRET_TOKENS, ...PHASE6_TOKENS]) {
      expect(stripped, `${SECTION} matched ${token}`).not.toMatch(token);
    }
    // It composes the existing nutrition cards; it never constructs a block.
    expect(stripped).toContain('AdvancedNutritionCard');
    expect(stripped).toContain('RecipeNutritionCard');
    expect(stripped).not.toMatch(/authorizeNutritionPersistence|applyAdvancedNutrition|encodeCodexNutrition/);
  });

  it('the selector is read-only: no mutation helper is present', () => {
    const source = stripComments(readFileSync(resolve(PHASE5C_DIR, 'presentation.ts'), 'utf8'));
    // No in-place mutation of an input object. (Local accumulator arrays are
    // allowed; dynamic non-destruction is proven by the unit tests.)
    expect(source).not.toMatch(/Object\.assign\s*\(/);
    expect(source).not.toMatch(/delete\s+[a-zA-Z_$]/);
  });
});
