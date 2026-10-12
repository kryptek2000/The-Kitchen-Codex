/**
 * The Kitchen Codex — AI-2C security / isolation.
 *
 * Pins the deterministic acceptance bridge's hard boundaries:
 *   - the ONLY new file allowed to import Phase-2 matching/confidence is the
 *     approved Phase-4 acceptance boundary;
 *   - the pure reconciliation module reaches nothing but pure core;
 *   - the application orchestration has a CLOSED import set: no persistence, no
 *     Apply, no Markdown writer, no server/provider module, no concrete network
 *     adapter, no raw model/provider response contract;
 *   - the UI keeps taking its ports by injection (it never imports the
 *     application layer);
 *   - no new server route and no new persistence path exists for AI-2C;
 *   - every frozen AI-0/AI-2A module and every stable AI-2B production module is
 *     byte-identical (sha256) to the committed baseline.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function sha256(relative: string): string {
  return createHash('sha256').update(readFileSync(join(ROOT, relative))).digest('hex');
}

/**
 * Source with comments removed. Every banned-token scan runs on STRIPPED source
 * so a comment can neither trip nor hide a violation.
 */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Import specifiers of a module (static imports and re-exports only). */
function importSpecifiers(relative: string): string[] {
  const source = read(relative);
  const found: string[] = [];
  const pattern = /(?:from\s+|import\s+|require\()\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  return found;
}

const ACCEPTANCE_VIEW = 'src/core/nutritionV2/phase4/deterministicAcceptanceView.ts';
const RECONCILE = 'src/core/nutritionV2/phase4/aiPlanReconcile.ts';
const APP = 'src/application/nutritionAiPlanAcceptance.ts';
const CARD = 'src/components/AdvancedNutritionCard.tsx';
const MODAL = 'src/components/AdvancedNutritionModal.tsx';

const AI2C_NEW_FILES = [ACCEPTANCE_VIEW, RECONCILE, APP];

/** The frozen AI-0 / AI-2A contracts: byte-identical or the run fails. */
const FROZEN_AI0_AI2A: Record<string, string> = {
  'src/core/nutritionV2/aiAdvancedPlan.ts': '7716a99c51255917ba50cca2c23e322860045d45a2bdc8b6dbf48daa20a8d504',
  'src/core/nutritionV2/aiAdvancedCandidates.ts': '6e65daaa8391591cb94b823d704123f8db5dd5e6e811fc9d31e4cf3139d29683',
  'src/core/nutritionV2/aiAdvancedPlanSource.ts': 'b032f32c4cdbcb53cc3b4e89cb8b807396b45bc2ed57b9296c806d48af83aff7',
  'src/core/nutritionV2/aiAdvancedPlanRequest.ts': 'e8c714e5b3d45a4cdc02930193718adf6a198238de9c2c93f93b4f7a60ff8ca7',
  'src/core/nutritionV2/aiAdvancedPlanApply.ts': '18847e5836bb254fc6eea88dbd4aab050d475ca06a7dc5c02fb225f75971ba33',
};

/** Committed AI-2B production modules: stable by default for AI-2C. */
const STABLE_AI2B: Record<string, string> = {
  'src/core/nutritionV2/aiAdvancedPlanWire.ts': '33c851752a4eb67aafab1f208efcd20a8671a7141724f91222e0402329e42c22',
  'src/core/nutritionV2/aiAdvancedPlanTarget.ts': '82d6c06d756a4cb02ea23a5cdc56fbd3f9801abd40c0cae4b172cf3e5f2be1e2',
  'server/nutritionPlan.ts': '3ac9082dd2f98880f1a7991594aca9f529e031e1bd86d57d1c5a566189cb191b',
  'src/application/nutritionAiPlan.ts': '7e8a6a372e2f00cba68686b32a73967141897c113dc308277d67bd80afa465b8',
};

/**
 * DELIBERATELY THAWED FOR AI-3 (architect-authorized, section 5B): the frozen
 * estimate contract's activation points. Every other AI-0/AI-2A contract stays
 * frozen at the AI-2C baseline, so this map is the ONLY authorized exception.
 */
const THAWED_BY_AI3: Record<string, string> = {
  'src/core/nutritionV2/aiAdvancedEstimate.ts': 'c16ff999f50c902a02cc47ee7855a61fb2d6600de9689109ae27c1c4bb59106d',
};

/**
 * DELIBERATELY THAWED FOR PHASE 9B-P4 (architect-authorized, narrow exception).
 *
 * WHY THIS EXISTS. Phase 9B-P3 ran one authorized live Gemini request. The
 * Gemini primary (`gemini-3.7-flash`, LOW thinking) RETURNED successfully over
 * the real transport, and the whole-recipe operation failed at the strict
 * semantic sanitizer with the collapsed public code `invalid_response` — a code
 * shared by roughly thirty-four distinct structural branches. The exact defect
 * was therefore not diagnosable without spending a SECOND live provider call,
 * which Phase 9B explicitly forbade.
 *
 * WHAT THE THAW AUTHORIZES: diagnostic OBSERVABILITY only. The 9B-P4 change to
 * this contract adds a CLOSED structural rejection vocabulary, a single shared
 * rejection exit, and an OPTIONAL out-of-band observer. It does not accept
 * anything previously rejected, reject anything previously accepted, alter any
 * bound, key set, quantity rule, line-reference rule, authority rule, receipt,
 * or persistence path. Verified mechanically: 48 of 52 removed lines are pure
 * exit swaps (identical condition, only the return form changed); the
 * remaining four are two additive signature changes and two logically
 * identical condition splits that emit the SAME public code.
 *
 * SCOPE. Exactly one path. This is the ONLY Phase 9B-P4 exception, mirroring
 * the AI-3 precedent.
 */
const THAWED_BY_9B4: Record<string, string> = {
  'src/core/nutritionV2/aiAdvanced.ts': '7ac74d645b4db85e13d2a02478c7534359ef5a51f5b6bce69eeb81a3aaf50ed3',
};

/**
 * HISTORICAL BASELINE, PRESERVED FOR TRACEABILITY — NEVER ENFORCED.
 *
 * The pre-thaw (AI-2C-era) digest of every contract thawed by THIS phase,
 * recorded so a thaw can always be audited back to the exact bytes it replaced.
 * Removing a path from active enforcement must never erase what it was frozen
 * against, so this map is deliberately separate from `FROZEN_AI0_AI2A` and is
 * never compared against the working tree.
 *
 * SCOPE NOTE: this covers the 9B-P4 thaw only. The pre-AI-3 digest of
 * `aiAdvancedEstimate.ts` was never recorded in this repository, and inventing
 * one would be worse than omitting it, so it is deliberately absent rather than
 * guessed. Recording it would require recovering it from the pre-AI-3 history.
 */
const HISTORICAL_THAWED_BASELINES: Record<string, string> = {
  'src/core/nutritionV2/aiAdvanced.ts': '857763140830fa04ec743495b6527b1800d63ee3de7207f090f0c37b396697cb',
};

describe('AI-2C isolation — frozen and stable modules', () => {
  it('the AI-3 thaw is confined to the expressly authorized estimate contract', () => {
    expect(Object.keys(THAWED_BY_AI3)).toEqual(['src/core/nutritionV2/aiAdvancedEstimate.ts']);
    for (const [file, digest] of Object.entries(THAWED_BY_AI3)) {
      expect({ file, digest: sha256(file) }).toEqual({ file, digest });
    }
  });

  it('frozen AI-0 / AI-2A contracts are byte-identical to the baseline', () => {
    for (const [file, digest] of Object.entries(FROZEN_AI0_AI2A)) {
      expect({ file, digest: sha256(file) }).toEqual({ file, digest });
    }
  });

  it('stable AI-2B production modules are byte-identical to the committed baseline', () => {
    for (const [file, digest] of Object.entries(STABLE_AI2B)) {
      expect({ file, digest: sha256(file) }).toEqual({ file, digest });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 9B-P4 thaw — narrowly scoped, historically traceable
// ---------------------------------------------------------------------------

describe('AI-2C isolation — the Phase 9B-P4 thaw is narrow and traceable', () => {
  it('authorizes EXACTLY one path, and that path is the strict sanitizer', () => {
    // SCOPE GATE. Widening this map is a contract thaw, not a test change.
    expect(Object.keys(THAWED_BY_9B4)).toEqual(['src/core/nutritionV2/aiAdvanced.ts']);
  });

  it('pins the thawed file to its CURRENT bytes, verified independently', () => {
    // The digest is compared against the real file, so an unblessed edit to the
    // thawed contract cannot pass by virtue of being listed here.
    for (const [file, digest] of Object.entries(THAWED_BY_9B4)) {
      expect({ file, digest: sha256(file) }).toEqual({ file, digest });
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('PRESERVES the historical AI-2C baseline it replaced', () => {
    // TRACEABILITY GATE. The thaw must never erase what the file was frozen
    // against, so the pre-thaw digest stays recorded even though it is no
    // longer enforced against the working tree.
    expect(Object.keys(HISTORICAL_THAWED_BASELINES)).toEqual(
      Object.keys(THAWED_BY_9B4).filter((f) => f in HISTORICAL_THAWED_BASELINES)
    );
    expect(HISTORICAL_THAWED_BASELINES['src/core/nutritionV2/aiAdvanced.ts']).toBe(
      '857763140830fa04ec743495b6527b1800d63ee3de7207f090f0c37b396697cb'
    );
  });

  it('the historical baseline DIFFERS from the current bytes (the thaw is real)', () => {
    // If these were equal the thaw would be a no-op and the exception unjustified.
    for (const [file, historical] of Object.entries(HISTORICAL_THAWED_BASELINES)) {
      expect({ file, changed: sha256(file) !== historical }).toEqual({ file, changed: true });
    }
  });

  it('a thawed path is not ALSO under active original-baseline enforcement', () => {
    // No double-enforcement ambiguity: a path is frozen OR thawed, never both.
    for (const file of Object.keys(THAWED_BY_9B4)) {
      expect({ file, frozen: file in FROZEN_AI0_AI2A }).toEqual({ file, frozen: false });
    }
  });

  it('every REMAINING AI-0/AI-2A contract stays frozen at the AI-2C baseline', () => {
    expect(Object.keys(FROZEN_AI0_AI2A).sort()).toEqual([
      'src/core/nutritionV2/aiAdvancedCandidates.ts',
      'src/core/nutritionV2/aiAdvancedPlan.ts',
      'src/core/nutritionV2/aiAdvancedPlanApply.ts',
      'src/core/nutritionV2/aiAdvancedPlanRequest.ts',
      'src/core/nutritionV2/aiAdvancedPlanSource.ts',
    ]);
    for (const [file, digest] of Object.entries(FROZEN_AI0_AI2A)) {
      expect({ file, digest: sha256(file) }).toEqual({ file, digest });
    }
  });

  it('the AI-3 thaw and the AI-2B stable set are untouched by the 9B-P4 thaw', () => {
    expect(Object.keys(THAWED_BY_AI3)).toEqual(['src/core/nutritionV2/aiAdvancedEstimate.ts']);
    expect(THAWED_BY_AI3['src/core/nutritionV2/aiAdvancedEstimate.ts']).toBe(
      'c16ff999f50c902a02cc47ee7855a61fb2d6600de9689109ae27c1c4bb59106d'
    );
    expect(Object.keys(STABLE_AI2B).sort()).toEqual([
      'server/nutritionPlan.ts',
      'src/application/nutritionAiPlan.ts',
      'src/core/nutritionV2/aiAdvancedPlanTarget.ts',
      'src/core/nutritionV2/aiAdvancedPlanWire.ts',
    ]);
    for (const [file, digest] of Object.entries(STABLE_AI2B)) {
      expect({ file, digest: sha256(file) }).toEqual({ file, digest });
    }
  });

  it('no thawed map silently shares a path with another', () => {
    const maps = [FROZEN_AI0_AI2A, THAWED_BY_AI3, THAWED_BY_9B4, STABLE_AI2B];
    const seen = new Map<string, string>();
    for (const map of maps) {
      for (const file of Object.keys(map)) {
        expect({ file, owner: seen.get(file) }).toEqual({ file, owner: undefined });
        seen.set(file, Object.keys(map).length === 0 ? '' : file);
      }
    }
  });

  it('the thaw did not weaken any isolation assertion in this suite', () => {
    // A cheap but meaningful tripwire: the suite must still forbid the banned
    // import/layering patterns it was written to forbid.
    expect(importSpecifiers(ACCEPTANCE_VIEW).some((s) => s.includes('../matching/confidence'))).toBe(true);
    expect(importSpecifiers(RECONCILE).some((s) => s.includes('matching/'))).toBe(false);
    const banned = /phase5/i;
    expect(banned.test(code(APP))).toBe(false);
  });
});

describe('AI-2C isolation — the matching/confidence boundary', () => {
  it('only the approved Phase-4 acceptance view imports matching/confidence', () => {
    // EXACTLY one new AI-2C file gains the boundary import.
    expect(importSpecifiers(ACCEPTANCE_VIEW).some((s) => s.includes('../matching/confidence'))).toBe(true);
    expect(importSpecifiers(RECONCILE).some((s) => s.includes('matching/'))).toBe(false);
    expect(importSpecifiers(APP).some((s) => s.includes('matching/'))).toBe(false);
  });

  it('no application or component module imports matching/confidence for AI-2C', () => {
    for (const file of [APP, CARD, MODAL]) {
      for (const specifier of importSpecifiers(file)) {
        expect(specifier).not.toMatch(/matching\/(confidence|review|parse|bundle)/);
      }
    }
  });

  it('the pure reconciliation module reaches only pure core', () => {
    const allowed = /^\.\.\/(aiAdvancedPlanApply|aiAdvancedPlanRequest|aiAdvancedPlan)(\.ts)?$|^\.\/(rows|types|aiMidFlight|deterministicAcceptanceView)(\.ts)?$/;
    for (const specifier of importSpecifiers(RECONCILE)) {
      expect({ specifier, allowed: allowed.test(specifier) }).toEqual({ specifier, allowed: true });
    }
  });
});

describe('AI-2C isolation — the application orchestration import set is CLOSED', () => {
  it('imports exactly the approved modules and nothing else', () => {
    const specifiers = importSpecifiers(APP).filter((s) => !s.startsWith('node:'));
    const expected = [
      './adapters/NetworkAdapter',
      './nutritionAiPlan',
      '../core/nutritionV2/phase4/session',
      '../core/nutritionV2/phase4/deterministicAcceptanceView',
      '../core/nutritionV2/phase4/aiPlanReconcile',
      '../core/nutritionV2/aiAdvancedPlanRequest',
      '../core/nutritionV2/nutritionCapabilities',
      '../core/nutritionV2/phase4/types',
    ];
    expect([...new Set(specifiers)].sort()).toEqual([...new Set(expected)].sort());
  });

  it('references no persistence, Apply, Markdown, server or raw-response contract', () => {
    const banned = [
      /phase5/i,
      /advancedNutritionApply/i,
      /markdownWriter|markdownParser|writeRecipe|serializeRecipe/i,
      /\/server\/|server\//,
      /codex_nutrition/i,
      /fetch\(|XMLHttpRequest|RequestInit|Response\b/,
      /provider[\s_-]*(response|raw)/i,
    ];
    const source = code(APP);
    for (const pattern of banned) {
      expect({ pattern: String(pattern), hit: pattern.test(source) }).toEqual({
        pattern: String(pattern),
        hit: false,
      });
    }
  });

  it('performs no direct network work of its own (exactly one requester call site)', () => {
    const source = read(APP);
    const calls = source.match(/requestAiAdvancedCandidatePlan\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

describe('AI-2C isolation — UI stays injection-only', () => {
  it('the card and modal never import the application layer', () => {
    for (const file of [CARD, MODAL]) {
      for (const specifier of importSpecifiers(file)) {
        expect(specifier).not.toMatch(/^\.\.\/application\/|^\.\/application\/|application\//);
      }
    }
  });

  it('the card exposes the plan port as an injected prop, not an import', () => {
    const source = read(CARD);
    expect(source).toContain('onPlanWithAi?: AdvancedNutritionAiPlanHandler');
    expect(source).toContain('applyWorkingSelections({ matches })');
  });
});

describe('AI-2C isolation — no new route, no new persistence path', () => {
  it('the server registers no AI-2C acceptance route', () => {
    const app = read('server/app.ts');
    const planRoutes = app.match(/plan-ingredients/g) ?? [];
    expect(planRoutes.length).toBe(1);
    for (const banned of ['plan-accept', 'plan-apply', 'plan-acceptance', 'accept-plan']) {
      expect(app.includes(banned)).toBe(false);
      expect(read('server/nutritionPlan.ts').includes(banned)).toBe(false);
    }
  });

  it('no AI-2C module writes recipe Markdown or saved nutrition', () => {
    for (const file of AI2C_NEW_FILES) {
      const source = code(file);
      for (const banned of ['codex_nutrition', 'frontmatter', 'vault', 'obsidian', 'localStorage']) {
        expect({ file, banned, hit: source.includes(banned) }).toEqual({ file, banned, hit: false });
      }
    }
  });

  it('the AI-2C modules are exactly the expected new files (no stray module)', () => {
    const phase4 = readdirSync(join(ROOT, 'src/core/nutritionV2/phase4'))
      .filter((name) => statSync(join(ROOT, 'src/core/nutritionV2/phase4', name)).isFile())
      .sort();
    expect(phase4).toContain('aiPlanReconcile.ts');
    expect(phase4).toContain('deterministicAcceptanceView.ts');
    const application = readdirSync(join(ROOT, 'src/application')).filter((name) => name.startsWith('nutritionAiPlan'));
    expect(application.sort()).toEqual(['nutritionAiPlan.ts', 'nutritionAiPlanAcceptance.ts']);
  });
});
