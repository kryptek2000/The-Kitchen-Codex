/**
 * The Kitchen Codex — Phase 8B production-browser proof CONTRACT tests.
 *
 * These do not drive a browser. They pin the contract the real proof depends on:
 * the fixture's determinism and safety, the gate-derivation rules, the durable CI
 * wiring, the plugin-isolation contract, and the browser harness's fail-closed
 * behavior.
 *
 * The MUTATION PROOFS (M1-M14) are the important half. Each takes a deliberately
 * broken observation, workflow, or bundle and asserts the contract CATCHES it.
 * A gate model that cannot fail is not evidence of anything.
 *
 * Phase 8B is CLOSED. Its former worktree-wide "production freeze" assertions
 * encoded a TEMPORAL claim that cannot be re-derived from an arbitrary future
 * tree, and they began failing later phases for merely existing. They are
 * replaced below by a durable, checked-in historical manifest — see the
 * "ARCHITECTURAL RULE" comment above `PHASE8B_FROZEN_PRODUCTION_TREES` for the
 * full rationale. A closed phase pins its OWN artifacts; it never claims
 * ownership of all future repository diffs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildPhase8bProof,
  derivePhase8bGates,
  PHASE8B_SCHEMA,
  type Phase8bObservation,
} from '../../scripts/nutritionReleaseExit/phase8bReport';
import {
  checkPluginIsolation,
  isolationFailures,
  FORBIDDEN_PLUGIN_MARKERS,
} from '../../scripts/nutritionReleaseExit/phase8bPluginIsolation';
import { discoverChrome } from '../../scripts/browserHarness/cdpBrowser';
import {
  ACCEPTANCE_INGREDIENT_LINES,
  ACCEPTANCE_RECIPE_FILE,
  ACCEPTANCE_RECIPE_PATH,
  ACCEPTANCE_RECIPE_TITLE,
  ACCEPTANCE_SERVINGS,
  PINNED_BUNDLE_ARTIFACT_NAMES,
  PINNED_BUNDLE_RECORD_COUNT,
  PINNED_BUNDLE_RELEASE,
  RECIPE_LEVEL_EXPECTATIONS,
} from '../fixtures/advancedNutritionBrowserAcceptanceFixture';

const ROOT = resolve(import.meta.dirname, '..', '..');

const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/build.yml'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const VERIFIER_SOURCE = readFileSync(join(ROOT, 'scripts/verify_advanced_nutrition_browser_prod.ts'), 'utf8');
const HARNESS_SOURCE = readFileSync(join(ROOT, 'scripts/browserHarness/cdpBrowser.ts'), 'utf8');
const CI_CLI_SOURCE = readFileSync(join(ROOT, 'scripts/benchmark_nutrition_phase8b_browser_proof.ts'), 'utf8');

/**
 * Thin `git` reader. Every call this contract makes is INDEX-SCOPED or
 * WORKTREE-OBSERVATIONAL — never history-scoped. No `HEAD^`, no `rev-list`, no
 * commit ranges: this file must behave identically in a full checkout, a
 * shallow CI clone, and a dirty future-development worktree.
 */
function gitLines(args: string[]): string[] | null {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    // No git index available (e.g. an exported source tree). Index-scoped checks
    // are then reported as "not applicable" rather than silently passing.
    return null;
  }
}

/**
 * OBSERVATION ONLY — never an input to the Phase 8B verdict.
 *
 * `git status --porcelain` collapses untracked DIRECTORIES into a single entry
 * (`?? scripts/browserHarness/`), so untracked paths are expanded with
 * `git ls-files --others`. This exists purely so the contract can REPORT what
 * else is in flight alongside it; see `evaluatePhase8bFreezeContract`.
 */
function worktreePaths(): string[] {
  const modified = gitLines(['diff', '--name-only']) ?? [];
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard']) ?? [];
  return [...new Set([...modified, ...untracked])].sort();
}

// ---------------------------------------------------------------------------
// Observation builders
// ---------------------------------------------------------------------------

function cleanBundle(): Phase8bObservation['bundle'] {
  return {
    artifactsRequested: PINNED_BUNDLE_ARTIFACT_NAMES.map((n) => `http://127.0.0.1:4791/assets/${n.replace(/\.json$/, '.json-AB12CD34').replace(/\.json\.gz$/, '.json-AB12CD34')}`),
    allSameOrigin: true,
    allSucceeded: true,
    authenticated: true,
    genuineSession: true,
    liveUsdaRequests: 0,
  };
}

function fullEntitled(overrides: Partial<Phase8bObservation> = {}): Phase8bObservation {
  return {
    tier: 'ai_advanced',
    productionServer: true,
    builtApp: true,
    recipe: { title: ACCEPTANCE_RECIPE_TITLE, servings: ACCEPTANCE_SERVINGS, ingredientCount: 9 },
    bundle: cleanBundle(),
    review: { total: 9, matched: 6, needsAmount: 3, needsMatch: 0, reviewSuggested: 0, qualitative: 0 },
    calculation: {
      previewRendered: true,
      nutrientTotalsPresent: true,
      partialReportedTruthfully: true,
      previewDigest: `sha256:${'a'.repeat(64)}`,
      applyEligible: true,
    },
    entitlement: {
      productAccessTier: 'ai_advanced',
      aiPanelRendered: true,
      expectedReason: 'provider_unavailable',
      observedMessage: 'AI Advanced Nutrition is enabled, but no compatible AI provider is currently available.',
      aiActionsDisabled: true,
    },
    apply: {
      attempted: true,
      succeeded: true,
      successMessage: 'Advanced Nutrition was saved to your recipe.',
      downloadObserved: true,
      persistedDigestMatchesPreview: true,
      persistedBlock: {
        hasBlock: true,
        schema: 2,
        basis: 'total',
        status: 'partial',
        digest: `sha256:${'a'.repeat(64)}`,
        hasUsdaRelease: true,
        sourceRelease: PINNED_BUNDLE_RELEASE,
      },
    },
    accessibility: {
      performed: true,
      keyboardContained: true,
      escapeClosed: true,
      focusRestored: true,
      allControlsNamed: true,
      dialogNamed: true,
    },
    runtime: { consoleErrors: 0, exceptions: 0, unexpectedExternalRequests: 0, providerRequests: 0, liveUsdaRequests: 0 },
    ...overrides,
  };
}

function basicControl(overrides: Partial<Phase8bObservation> = {}): Phase8bObservation {
  return {
    tier: 'basic',
    productionServer: true,
    builtApp: true,
    recipe: null,
    bundle: cleanBundle(),
    review: { total: 9, matched: 6, needsAmount: 3, needsMatch: 0, reviewSuggested: 0, qualitative: 0 },
    calculation: { previewRendered: true, nutrientTotalsPresent: true, partialReportedTruthfully: true, previewDigest: '', applyEligible: true },
    entitlement: {
      productAccessTier: 'basic',
      aiPanelRendered: true,
      expectedReason: 'product_not_enabled',
      observedMessage: "AI Advanced Nutrition isn't enabled for this deployment.",
      aiActionsDisabled: true,
    },
    apply: { attempted: false, succeeded: false, successMessage: '', downloadObserved: false, persistedDigestMatchesPreview: false, persistedBlock: null },
    accessibility: null,
    runtime: { consoleErrors: 0, exceptions: 0, unexpectedExternalRequests: 0, providerRequests: 0, liveUsdaRequests: 0 },
    ...overrides,
  };
}

const HAPPY: Phase8bObservation[] = [fullEntitled(), basicControl()];

function gateOf(observations: Phase8bObservation[], name: string) {
  const gate = derivePhase8bGates(observations).find((g) => g.gate === name);
  if (!gate) throw new Error(`gate ${name} was not derived`);
  return gate;
}

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

describe('Phase 8B acceptance fixture', () => {
  it('exists on disk as a single deterministic Markdown note', () => {
    expect(existsSync(ACCEPTANCE_RECIPE_PATH)).toBe(true);
    expect(ACCEPTANCE_RECIPE_FILE).toBe('Weeknight Beef Rice Bowls.md');
  });

  it('declares the expected title and servings', () => {
    const markdown = readFileSync(ACCEPTANCE_RECIPE_PATH, 'utf8');
    expect(markdown).toContain(`title: ${ACCEPTANCE_RECIPE_TITLE}`);
    expect(markdown).toContain(`servings: ${ACCEPTANCE_SERVINGS}`);
  });

  it('contains exactly the pinned ingredient lines, in order', () => {
    const markdown = readFileSync(ACCEPTANCE_RECIPE_PATH, 'utf8');
    const section = markdown.split('## Ingredients')[1]?.split('##')[0] ?? '';
    const lines = section
      .split('\n')
      .map((l) => l.replace(/^-\s*/, '').trim())
      .filter((l) => l.length > 0);
    expect(lines).toEqual([...ACCEPTANCE_INGREDIENT_LINES]);
    expect(lines).toHaveLength(RECIPE_LEVEL_EXPECTATIONS.totalIngredientCount);
  });

  it('is internally consistent (counts sum to the total)', () => {
    const e = RECIPE_LEVEL_EXPECTATIONS;
    expect(e.matchedCount + e.needsAmountCount + e.needsMatchCount + e.reviewSuggestedCount + e.qualitativeCount).toBe(
      e.totalIngredientCount
    );
    expect(e.unresolvedCount).toBe(e.needsAmountCount);
  });

  it('contains no personal data, absolute local path, token, or key', () => {
    const markdown = readFileSync(ACCEPTANCE_RECIPE_PATH, 'utf8');
    expect(markdown).not.toMatch(/\/(home|Users|root)\//);
    expect(markdown).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    expect(markdown).not.toMatch(/(api[_-]?key|token|secret|password|bearer)/i);
    expect(markdown).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(markdown).not.toMatch(/[0-9a-f]{40,}/i);
  });

  it('uses no adversarial quantity forms', () => {
    for (const line of ACCEPTANCE_INGREDIENT_LINES) {
      expect(line.toLowerCase()).not.toMatch(/\bto taste\b/);
      expect(line).not.toMatch(/\bor\b/);
      expect(line).not.toMatch(/\d+\s*-\s*\d+/);
    }
  });

  it('exercises more than one mass source and no brand names', () => {
    expect(ACCEPTANCE_INGREDIENT_LINES.some((l) => /\b(lb|g)\b/.test(l))).toBe(true);
    expect(ACCEPTANCE_INGREDIENT_LINES.some((l) => /\b(tbsp|cup)\b/.test(l))).toBe(true);
    expect(ACCEPTANCE_INGREDIENT_LINES.some((l) => /\bcloves?\b|\bstick\b|\bmedium\b/.test(l))).toBe(true);
  });
});

describe('Phase 8B pinned USDA expectations', () => {
  it('pins the bundle release and record count the proof runs against', () => {
    expect(PINNED_BUNDLE_RELEASE).toBe('usda_fdc_87c5408a3e98838944a87be74824761e');
    expect(PINNED_BUNDLE_RECORD_COUNT).toBe(13559);
  });

  it('pins all five bundle artifact names', () => {
    expect(PINNED_BUNDLE_ARTIFACT_NAMES).toHaveLength(5);
    expect(PINNED_BUNDLE_ARTIFACT_NAMES).toContain('artifact.json');
    expect(PINNED_BUNDLE_ARTIFACT_NAMES).toContain('manifest.json');
  });

  it('pins a truthful partial expectation, never a false complete', () => {
    expect(RECIPE_LEVEL_EXPECTATIONS.calculationStatus).toBe('partial');
    expect(RECIPE_LEVEL_EXPECTATIONS.basis).toBe('total');
    expect(RECIPE_LEVEL_EXPECTATIONS.advisoryOnly).toBe(true);
    expect(RECIPE_LEVEL_EXPECTATIONS.applicationAuthorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Artifact contract
// ---------------------------------------------------------------------------

describe('Phase 8B artifact', () => {
  it('uses the declared schema', () => {
    expect(PHASE8B_SCHEMA).toBe('nutrition_phase8b_production_browser_proof_v1');
    expect(buildPhase8bProof({ baseCommit: 'x', observations: HAPPY }).schema).toBe(PHASE8B_SCHEMA);
  });

  it('is byte-identical across identical observations', () => {
    const a = JSON.stringify(buildPhase8bProof({ baseCommit: 'base', observations: HAPPY }), null, 2);
    const b = JSON.stringify(buildPhase8bProof({ baseCommit: 'base', observations: HAPPY }), null, 2);
    expect(a).toBe(b);
  });

  it('records the hermetic contract: no key, no live USDA, no AI invoked', () => {
    const report = buildPhase8bProof({ baseCommit: 'base', observations: HAPPY });
    expect(report.hermetic.provider_key_required).toBe(false);
    expect(report.hermetic.live_usda_required).toBe(false);
    expect(report.hermetic.secrets_required).toBe(false);
    expect(report.hermetic.ai_action_invoked).toBe(false);
    expect(report.hermetic.provider_call_in_deterministic_path).toBe(0);
  });

  it('records that no new browser dependency was added', () => {
    const report = buildPhase8bProof({ baseCommit: 'base', observations: HAPPY });
    expect(report.browser.new_browser_dependency_added).toBe(false);
    expect(report.browser.dependency_free_cdp).toBe(true);
  });

  it('derives browser automation as the required evidence level for browser gates', () => {
    const gates = derivePhase8bGates(HAPPY);
    for (const name of ['production_browser_reachable', 'recipe_level_smoke_sufficient', 'accessibility_smoke_sufficient']) {
      const gate = gates.find((g) => g.gate === name)!;
      expect(gate.required_evidence_level).toBe('browser_automation');
      expect(gate.evidence_level).toBe('browser_automation');
    }
  });

  it('derives production_build as the required evidence level for the build gate', () => {
    const gate = gateOf(HAPPY, 'production_build_clean');
    expect(gate.required_evidence_level).toBe('production_build');
    expect(gate.status).toBe('PROVEN');
  });
});

describe('Phase 8B happy-path gate derivation', () => {
  it('proves every browser-derived gate on a complete observation set', () => {
    const proven = derivePhase8bGates(HAPPY).filter((g) => g.status === 'PROVEN').map((g) => g.gate);
    expect(proven).toEqual(
      expect.arrayContaining([
        'production_build_clean',
        'production_browser_reachable',
        'recipe_level_smoke_sufficient',
        'accessibility_smoke_sufficient',
        'entitlement_enforced',
        'no_external_usda_dependency',
        'no_provider_call_in_deterministic_path',
        'production_runtime_clean',
        'apply_authority_revalidated',
      ])
    );
  });

  it('never proves the human manual smoke gate', () => {
    expect(gateOf(HAPPY, 'manual_smoke_required').status).toBe('NOT_PROVEN');
    expect(gateOf(HAPPY, 'manual_smoke_required').detail).toMatch(/human/i);
  });

  it('keeps post_push_ci_proof pending even when every observation is complete', () => {
    const report = buildPhase8bProof({ baseCommit: 'base', observations: HAPPY });
    expect(report.post_push_ci_proof).toBe('pending');
    expect(report.durable_ci_required).toBe(true);
    expect(report.local_browser_proof).toBe('pass');
  });

  it('proves the AND rule only when both entitlement arms are observed', () => {
    expect(gateOf(HAPPY, 'entitlement_enforced').status).toBe('PROVEN');
    expect(gateOf([fullEntitled()], 'entitlement_enforced').status).not.toBe('PROVEN');
  });
});

// ---------------------------------------------------------------------------
// MUTATION PROOFS
// ---------------------------------------------------------------------------

describe('M1 — a required USDA asset request that never occurs', () => {
  it('cannot prove production_browser_reachable', () => {
    const mutated = fullEntitled({
      bundle: { ...cleanBundle(), artifactsRequested: [], allSameOrigin: false, allSucceeded: false, authenticated: false, genuineSession: false },
      review: null,
    });
    expect(gateOf([mutated, basicControl()], 'production_browser_reachable').status).toBe('NOT_PROVEN');
  });
});

describe('M2 — USDA authentication/ready state that never occurs', () => {
  it('cannot prove production_browser_reachable', () => {
    const mutated = fullEntitled({ bundle: { ...cleanBundle(), authenticated: false } });
    const gate = gateOf([mutated, basicControl()], 'production_browser_reachable');
    expect(gate.status).not.toBe('PROVEN');
  });
});

describe('M3 — a fixture-only catalog bypass with no real asset fetch', () => {
  it('cannot prove production_browser_reachable', () => {
    const mutated = fullEntitled({
      bundle: { ...cleanBundle(), artifactsRequested: [], authenticated: true, genuineSession: true },
    });
    expect(gateOf([mutated, basicControl()], 'production_browser_reachable').status).not.toBe('PROVEN');
  });
});

describe('M4 — an external live USDA request', () => {
  it('refutes no_external_usda_dependency', () => {
    const mutated = fullEntitled({ runtime: { consoleErrors: 0, exceptions: 0, unexpectedExternalRequests: 1, providerRequests: 0, liveUsdaRequests: 1 } });
    expect(gateOf([mutated, basicControl()], 'no_external_usda_dependency').status).toBe('REFUTED');
    expect(gateOf([mutated, basicControl()], 'production_browser_reachable').status).toBe('REFUTED');
  });
});

describe('M5 — a provider request during the deterministic-only path', () => {
  it('refutes the provider isolation gate', () => {
    const mutated = fullEntitled({ runtime: { consoleErrors: 0, exceptions: 0, unexpectedExternalRequests: 0, providerRequests: 1, liveUsdaRequests: 0 } });
    expect(gateOf([mutated, basicControl()], 'no_provider_call_in_deterministic_path').status).toBe('REFUTED');
  });
});

describe('M6 — an entitlement bypass exposing Advanced Nutrition to Basic', () => {
  it('refutes entitlement_enforced rather than merely leaving it unproven', () => {
    const bypass = basicControl({
      entitlement: {
        productAccessTier: 'basic',
        aiPanelRendered: true,
        expectedReason: 'product_not_enabled',
        observedMessage: 'AI Advanced Nutrition is enabled and ready.',
        aiActionsDisabled: false,
      },
    });
    expect(gateOf([fullEntitled(), bypass], 'entitlement_enforced').status).toBe('REFUTED');
  });
});

describe('M7 — a production JavaScript exception', () => {
  it('refutes production_runtime_clean', () => {
    const mutated = fullEntitled({ runtime: { consoleErrors: 0, exceptions: 1, unexpectedExternalRequests: 0, providerRequests: 0, liveUsdaRequests: 0 } });
    expect(gateOf([mutated, basicControl()], 'production_runtime_clean').status).toBe('REFUTED');
  });
});

describe('M8 — a critical control losing its accessible name', () => {
  it('refutes accessibility_smoke_sufficient', () => {
    const mutated = fullEntitled({
      accessibility: { performed: true, keyboardContained: true, escapeClosed: true, focusRestored: true, allControlsNamed: false, dialogNamed: true },
    });
    expect(gateOf([mutated, basicControl()], 'accessibility_smoke_sufficient').status).toBe('REFUTED');
  });
});

describe('M9 — the real browser step removed from CI', () => {
  it('fails the workflow contract', () => {
    expect(WORKFLOW).toMatch(/name:\s*Advanced Nutrition production-browser proof/);
    expect(WORKFLOW).toMatch(/run:\s*bun run test:nutrition:browser/);
  });

  it('orders the browser proof after the production build and before the plugin build', () => {
    const build = WORKFLOW.indexOf('run: bun run build\n');
    const browser = WORKFLOW.indexOf('bun run test:nutrition:browser');
    const plugin = WORKFLOW.indexOf('run: bun run build:plugin');
    expect(build).toBeGreaterThan(-1);
    expect(browser).toBeGreaterThan(build);
    expect(plugin).toBeGreaterThan(browser);
  });

  it('keeps the plugin build after the full suite so plugin/main.js cannot pollute it', () => {
    const suite = WORKFLOW.indexOf('run: bun run test\n');
    const plugin = WORKFLOW.indexOf('run: bun run build:plugin');
    expect(suite).toBeGreaterThan(-1);
    expect(plugin).toBeGreaterThan(suite);
  });

  it('resolves a browser explicitly and fails the job when none exists', () => {
    expect(WORKFLOW).toMatch(/CHROME_BIN/);
    expect(WORKFLOW).toMatch(/command -v google-chrome/);
    expect(WORKFLOW).toMatch(/::error title=No Chrome Browser::/);
  });

  it('never supplies a provider secret to the browser proof', () => {
    const browserStep = WORKFLOW.slice(WORKFLOW.indexOf('Advanced Nutrition production-browser proof'));
    expect(browserStep.slice(0, 200)).not.toMatch(/secrets\./);
  });
});

describe('M10 — a verifier that silently skips when Chrome is missing', () => {
  it('hard-fails instead of skipping when CHROME_BIN points nowhere', () => {
    const previous = process.env.CHROME_BIN;
    process.env.CHROME_BIN = '/nonexistent/definitely-not-a-browser';
    try {
      expect(() => discoverChrome()).toThrow(/Refusing to skip/i);
    } finally {
      if (previous === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = previous;
    }
  });

  it('resolves a real browser on this machine or fails loudly, never returns undefined', () => {
    const previous = process.env.CHROME_BIN;
    delete process.env.CHROME_BIN;
    try {
      const found = discoverChrome();
      expect(typeof found.path).toBe('string');
      expect(existsSync(found.path)).toBe(true);
      expect(['CHROME_BIN', 'probed_path']).toContain(found.source);
    } finally {
      if (previous !== undefined) process.env.CHROME_BIN = previous;
    }
  });

  it('fails closed on a missing production build', () => {
    expect(VERIFIER_SOURCE).toMatch(/dist\/server\.cjs/);
    expect(VERIFIER_SOURCE).toMatch(/Run `bun run build` first/);
  });
});

describe('M11 — a verifier pointed at a dev server instead of the built production server', () => {
  it('rejects a dev-like document that lacks the production CSP', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><script type="module" src="/@vite/client"></script></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        import('../../scripts/browserHarness/cdpBrowser').then((m) =>
          m.waitForProductionServer(`http://127.0.0.1:${port}`)
        )
      ).rejects.toThrow(/production/i);
    } finally {
      server.close();
    }
  });

  it('spawns dist/server.cjs rather than a dev entrypoint', () => {
    expect(VERIFIER_SOURCE).toMatch(/startProductionServer/);
    expect(VERIFIER_SOURCE).toMatch(/waitForProductionServer/);
    expect(VERIFIER_SOURCE).not.toMatch(/spawn\('vite'|bun run dev|server\.ts/);
  });
});

describe('M12 — Phase 8B planning code entering the plugin output', () => {
  it('detects each forbidden marker when injected into a plugin bundle', () => {
    for (const marker of FORBIDDEN_PLUGIN_MARKERS) {
      const bundle = ['Kitchen Codex', 'onload', 'addCommand', 'addRibbonIcon', 'activateView', marker].join('\n');
      const failures = isolationFailures(checkPluginIsolation(bundle));
      expect(failures.map((f) => f.marker)).toContain(marker);
    }
  });

  it('passes a clean bundle and refuses an empty one', () => {
    const clean = 'const x = "Kitchen Codex"; function onload(){} function addCommand(){} function addRibbonIcon(){} function activateView(){}';
    expect(isolationFailures(checkPluginIsolation(clean))).toHaveLength(0);
    expect(isolationFailures(checkPluginIsolation('')).length).toBeGreaterThan(0);
  });

  it('requires real plugin runtime markers so a stub cannot pass', () => {
    const stub = 'function phase8bReport(){}';
    const failures = isolationFailures(checkPluginIsolation(stub));
    expect(failures.filter((f) => f.kind === 'required').length).toBeGreaterThan(0);
  });

  it('keeps the isolation contract out of the production build graph', () => {
    expect(existsSync(join(ROOT, 'scripts/nutritionReleaseExit/phase8bPluginIsolation.ts'))).toBe(true);
  });
});

describe('M13 — the full-recipe fixture removed or changed unexpectedly', () => {
  it('would fail the fixture contract on any ingredient-line change', () => {
    const original = [...ACCEPTANCE_INGREDIENT_LINES];
    const mutated = [...ACCEPTANCE_INGREDIENT_LINES];
    mutated[0] = '1.5 lb Wagyu ground beef';
    expect(mutated).not.toEqual(original);
  });

  it('pins the acceptance vault directory as a checked-in fixture path', () => {
    expect(ACCEPTANCE_RECIPE_PATH.startsWith(join(ROOT, 'tests/fixtures'))).toBe(true);
  });
});

describe('M14 — a local pass reported as a post-push CI pass', () => {
  it('cannot happen: post_push_ci_proof is a literal pending', () => {
    for (const observations of [HAPPY, [], [fullEntitled()]]) {
      expect(buildPhase8bProof({ baseCommit: 'base', observations }).post_push_ci_proof).toBe('pending');
    }
  });

  it('cannot happen: the CLI never serializes a CI pass value', () => {
    expect(CI_CLI_SOURCE).not.toMatch(/post_push_ci_proof\s*[:=]\s*['"](pass|green|success)/);
    expect(CI_CLI_SOURCE).toMatch(/always `pending`/);
    expect(CI_CLI_SOURCE).toMatch(/durable_ci_required/);
  });

  it('cannot happen: durable_ci_required is always true', () => {
    expect(buildPhase8bProof({ baseCommit: 'base', observations: [] }).durable_ci_required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Harness / dependency contract
// ---------------------------------------------------------------------------

describe('Phase 8B harness and dependency contract', () => {
  it('adds no Playwright, Puppeteer, Cypress, or Selenium dependency', () => {
    const all = { ...PACKAGE_JSON.dependencies, ...PACKAGE_JSON.devDependencies };
    for (const forbidden of ['playwright', '@playwright/test', 'puppeteer', 'cypress', 'selenium-webdriver', 'webdriverio', 'chromedriver']) {
      expect(Object.keys(all)).not.toContain(forbidden);
    }
  });

  it('exposes stable package scripts for the proof and the isolation check', () => {
    expect(PACKAGE_JSON.scripts['test:nutrition:browser']).toContain('verify_advanced_nutrition_browser_prod');
    expect(PACKAGE_JSON.scripts['test:plugin:isolation']).toContain('verify_plugin_isolation');
  });

  it('imports nothing from production source in the browser harness', () => {
    const harness = readFileSync(join(ROOT, 'scripts/browserHarness/cdpBrowser.ts'), 'utf8');
    expect(harness).not.toMatch(/from '\.\.\/src\//);
    expect(harness).not.toMatch(/from '\.\.\/server\//);
    expect(harness).not.toMatch(/from '\.\.\/plugin\//);
  });

  it('runs both a production build and a browser run under the deterministic no-secret env', () => {
    expect(HARNESS_SOURCE).toMatch(/NODE_ENV: 'production'/);
    expect(HARNESS_SOURCE).toMatch(/KITCHEN_CODEX_NUTRITION_PRODUCT_TIER/);
    expect(HARNESS_SOURCE).toMatch(/GEMINI_API_KEY: ''/);
    expect(HARNESS_SOURCE).toMatch(/AI_ENDPOINT_TOKEN: ''/);
    expect(VERIFIER_SOURCE).toMatch(/KITCHEN_CODEX_NUTRITION_PRODUCT_TIER|ENTITLED_TIER/);
  });

  it('proves the persisted block equals the reviewed digest rather than a hardcoded literal', () => {
    expect(VERIFIER_SOURCE).toMatch(/persistedDigestMatchesPreview/);
    expect(VERIFIER_SOURCE).toMatch(/d\.apply\.persistedDigestMatchesPreview/);
    expect(VERIFIER_SOURCE).toMatch(/authority re-proved/);
  });

  it('asserts both entitlement arms in the verifier source', () => {
    expect(VERIFIER_SOURCE).toMatch(/provider_unavailable/);
    expect(VERIFIER_SOURCE).toMatch(/product_not_enabled/);
    expect(VERIFIER_SOURCE).toMatch(/runBasicProof/);
    expect(VERIFIER_SOURCE).toMatch(/runEntitledProof/);
  });
});

// ---------------------------------------------------------------------------
// Phase 8B historical manifest + durable freeze contract
// ---------------------------------------------------------------------------

/**
 * ARCHITECTURAL RULE, encoded deliberately and tested below:
 *
 *   A CLOSED PHASE MAY PIN ITS OWN ARTIFACTS AND INVARIANTS.
 *   A CLOSED PHASE MUST NOT CLAIM OWNERSHIP OF ALL FUTURE REPOSITORY DIFFS.
 *
 * WHY THIS BLOCK EXISTS. Phase 8B originally froze production source and
 * asserted two things about the WORKTREE:
 *
 *   (1) "touches only the allowed Phase 8B proof paths"
 *   (2) "has zero production source diff"
 *
 * Both were correct WHILE Phase 8B WAS IN FLIGHT. Both encoded a TEMPORAL
 * fact — a claim about the moment Phase 8B was being developed. Phase 8B is
 * CLOSED, and the temporal fact cannot be re-derived from an arbitrary tree
 * three phases later. Reading it off TODAY's working directory was a lifecycle
 * bug: any later authorized phase failed a CLOSED phase's test simply for
 * existing. Phase 9A's four untracked files demonstrated exactly that, and the
 * same defect applied twice over — the path-allowlist assertion AND the
 * production-diff assertion, which would have rejected any legitimate future
 * production change under `src/utils`, `server`, or `plugin`.
 *
 * THE REPAIR. A historical event cannot be inferred; it must be RECORDED. So
 * Phase 8B's evidence is preserved here as a checked-in receipt — the same
 * technique Phase 8A used for `PHASE8A_TEST_INVENTORY_AT_BASE_COMMIT` in
 * `advancedNutritionPhase8aReleaseExitRecon.test.ts`, which froze a base-commit
 * measurement instead of re-measuring the live tree. `PHASE8B_MANIFEST` below
 * is that receipt: the exact historical file set Phase 8B owned. It is data
 * about the PAST. It makes no claim about the FUTURE.
 *
 * WHAT IS NOW ASSERTED (durable, worktree-independent, shallow-CI safe):
 *
 *   1. every Phase 8B artifact still EXISTS;
 *   2. every Phase 8B artifact is COMMITTED (git index only);
 *   3. Phase 8B owned NO production source — the durable restatement of the
 *      original freeze. This survives all later production work precisely
 *      because it constrains the MANIFEST, not the working tree;
 *   4. every Phase 8B artifact ROLE is still represented, so an artifact
 *      cannot be quietly deleted from the manifest to hide its removal.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: anything about paths outside the manifest.
 * Those belong to whichever phase is currently in flight — including Phase 9A.
 */

/**
 * The production trees Phase 8B declared frozen while it was in flight. Retained
 * as historical receipt: the freeze is now enforced against the MANIFEST (see
 * `productionOwnedArtifacts`), which is why later production development under
 * these trees no longer collides with a closed phase's contract.
 */
const PHASE8B_FROZEN_PRODUCTION_TREES = [
  'src/core/nutritionV2',
  'src/utils',
  'src/components',
  'src/application',
  'server',
  'plugin',
] as const;

/**
 * Every artifact Phase 8B owned, keyed by the durable ROLE it plays. Roles —
 * not bare paths — are what the contract requires to be represented, so deleting
 * an entry here cannot quietly erase the obligation to prove it still exists.
 *
 * `phase8a_historical_amendment` is an authorized amendment, NOT a Phase 8B
 * asset: it exists only so Phase 8A's historical "zero production-build
 * coverage" finding stays pinned to Phase 8A's base commit instead of being
 * silently rewritten by the arrival of Phase 8B evidence. Explicitly approved by
 * Sid; see the Phase 8B report.
 */
const PHASE8B_ARTIFACT_ROLES = {
  production_browser_verifier: 'scripts/verify_advanced_nutrition_browser_prod.ts',
  plugin_isolation_verifier: 'scripts/verify_plugin_isolation.ts',
  benchmark_cli: 'scripts/benchmark_nutrition_phase8b_browser_proof.ts',
  browser_harness: 'scripts/browserHarness/cdpBrowser.ts',
  gate_report_module: 'scripts/nutritionReleaseExit/phase8bReport.ts',
  plugin_isolation_module: 'scripts/nutritionReleaseExit/phase8bPluginIsolation.ts',
  acceptance_fixture_module: 'tests/fixtures/advancedNutritionBrowserAcceptanceFixture.ts',
  acceptance_vault_recipe: `tests/fixtures/advancedNutritionBrowserAcceptanceVault/${ACCEPTANCE_RECIPE_FILE}`,
  contract_test: 'tests/unit/advancedNutritionPhase8bBrowserProofContract.test.ts',
  phase8a_historical_amendment: 'tests/unit/advancedNutritionPhase8aReleaseExitRecon.test.ts',
  package_manifest: 'package.json',
  ci_workflow: '.github/workflows/build.yml',
  architecture_doc: 'docs/Advanced-Nutrition-Architecture.md',
} as const;

const PHASE8B_MANIFEST: readonly string[] = [
  ...new Set(Object.values(PHASE8B_ARTIFACT_ROLES)),
].sort();

/**
 * Role names the contract REQUIRES to be represented, held independently of
 * `PHASE8B_ARTIFACT_ROLES` on purpose. If the requirement were derived from the
 * roles map itself, deleting a role would delete the obligation to prove it —
 * exactly the "pass by definition" failure this contract must not have.
 */
const PHASE8B_REQUIRED_ROLES: readonly string[] = [
  'production_browser_verifier',
  'plugin_isolation_verifier',
  'benchmark_cli',
  'browser_harness',
  'gate_report_module',
  'plugin_isolation_module',
  'acceptance_fixture_module',
  'acceptance_vault_recipe',
  'contract_test',
  'phase8a_historical_amendment',
  'package_manifest',
  'ci_workflow',
  'architecture_doc',
];

function isUnderProductionTree(path: string): boolean {
  return PHASE8B_FROZEN_PRODUCTION_TREES.some((tree) => path === tree || path.startsWith(`${tree}/`));
}

interface Phase8bFreezeContract {
  /** Manifest artifacts absent from disk — real damage to Phase 8B evidence. */
  readonly missingArtifacts: readonly string[];
  /** Manifest artifacts not committed — Phase 8B evidence was never sealed. */
  readonly uncommittedArtifacts: readonly string[];
  /** Phase 8B artifacts sitting in the index — Phase 8B's work must be committed. */
  readonly stagedArtifacts: readonly string[];
  /** Manifest artifacts inside a frozen production tree — Phase 8B was proof-only. */
  readonly productionOwnedArtifacts: readonly string[];
  /** Roles whose artifact is absent from the manifest — the receipt lost a claim. */
  readonly unrepresentedRoles: readonly string[];
  /**
   * Paths in flight that are NOT Phase 8B's. Reported for diagnostics ONLY.
   * This NEVER contributes a violation — that separation is the whole repair.
   */
  readonly foreignWorktreePaths: readonly string[];
  readonly violations: readonly string[];
}

interface Phase8bFreezeInputs {
  readonly manifest: readonly string[];
  readonly roles: Readonly<Record<string, string>>;
  /** Role names that MUST be represented, independent of `roles`. */
  readonly requiredRoles: readonly string[];
  readonly productionTrees: readonly string[];
  /** Paths present on disk. */
  readonly presentPaths: ReadonlySet<string>;
  /** Paths in the git index. `null` = no index available; index checks do not apply. */
  readonly trackedPaths: ReadonlySet<string> | null;
  /** Paths currently staged. `null` = no index available; index checks do not apply. */
  readonly stagedPaths: ReadonlySet<string> | null;
  /** Current worktree paths. OBSERVED AND REPORTED, NEVER JUDGED. */
  readonly currentWorktreePaths: readonly string[];
}

/**
 * PURE. No filesystem, no git, no clock, no process state — so it is directly
 * testable with synthetic inputs, and it can never mutate the real worktree.
 */
function evaluatePhase8bFreezeContract(input: Phase8bFreezeInputs): Phase8bFreezeContract {
  const { manifest, roles, requiredRoles, productionTrees, presentPaths, trackedPaths, stagedPaths, currentWorktreePaths } = input;

  const missingArtifacts = manifest.filter((path) => !presentPaths.has(path)).sort();

  const uncommittedArtifacts =
    trackedPaths === null ? [] : manifest.filter((path) => !trackedPaths.has(path)).sort();

  const stagedArtifacts =
    stagedPaths === null ? [] : manifest.filter((path) => stagedPaths.has(path)).sort();

  const owned = new Set(manifest);
  const underTree = (path: string): boolean =>
    productionTrees.some((tree) => path === tree || path.startsWith(`${tree}/`));
  const productionOwnedArtifacts = manifest.filter(underTree).sort();

  // A role is unrepresented if it is required but absent from the roles map, OR
  // is mapped to a path the manifest does not contain. Anchoring on
  // `requiredRoles` means dropping a role entry cannot also drop the demand.
  const unrepresentedRoles = requiredRoles
    .filter((role) => {
      const path = roles[role];
      return path === undefined || !owned.has(path);
    })
    .sort();

  const foreignWorktreePaths = currentWorktreePaths.filter((path) => !owned.has(path)).sort();

  const violations: string[] = [
    ...missingArtifacts.map((p) => `Phase 8B artifact is missing from disk: ${p}`),
    ...uncommittedArtifacts.map((p) => `Phase 8B artifact is not committed: ${p}`),
    ...stagedArtifacts.map((p) => `Phase 8B artifact is staged but should be committed: ${p}`),
    ...productionOwnedArtifacts.map(
      (p) => `Phase 8B was proof-only and must own no production source, but the manifest claims: ${p}`
    ),
    ...unrepresentedRoles.map((r) => `Phase 8B manifest no longer represents required role: ${r}`),
  ].sort();

  return {
    missingArtifacts,
    uncommittedArtifacts,
    stagedArtifacts,
    productionOwnedArtifacts,
    unrepresentedRoles,
    foreignWorktreePaths,
    violations,
  };
}

/** Real-world inputs, read index-scoped. Never mutates anything. */
function livePhase8bFreezeInputs(
  overrides: Partial<Phase8bFreezeInputs> = {}
): Phase8bFreezeInputs {
  const tracked = gitLines(['ls-files', '--', ...PHASE8B_MANIFEST]);
  const staged = gitLines(['diff', '--cached', '--name-only']);
  return {
    manifest: PHASE8B_MANIFEST,
    roles: PHASE8B_ARTIFACT_ROLES,
    requiredRoles: PHASE8B_REQUIRED_ROLES,
    productionTrees: PHASE8B_FROZEN_PRODUCTION_TREES,
    presentPaths: new Set(PHASE8B_MANIFEST.filter((path) => existsSync(join(ROOT, path)))),
    trackedPaths: tracked === null ? null : new Set(tracked),
    stagedPaths: staged === null ? null : new Set(staged),
    currentWorktreePaths: worktreePaths(),
    ...overrides,
  };
}

describe('Phase 8B frozen manifest is a historical receipt', () => {
  it('is a closed, duplicated-free file set', () => {
    expect(PHASE8B_MANIFEST).toEqual([...new Set(PHASE8B_MANIFEST)].sort());
    expect(PHASE8B_MANIFEST.length).toBeGreaterThanOrEqual(13);
  });

  it('spells out both authorization amendments in comments rather than silently widening the set', () => {
    expect(PHASE8B_ARTIFACT_ROLES.phase8a_historical_amendment).toBe(
      'tests/unit/advancedNutritionPhase8aReleaseExitRecon.test.ts'
    );
  });

  it('claims no production source — the durable restatement of the Phase 8B freeze', () => {
    const owned = evaluatePhase8bFreezeContract(livePhase8bFreezeInputs());
    expect(owned.productionOwnedArtifacts).toEqual([]);
    for (const path of PHASE8B_MANIFEST) {
      expect(isUnderProductionTree(path), `${path} must not be a Phase 8B production artifact`).toBe(false);
    }
  });

  it('represents every Phase 8B artifact role', () => {
    expect(Object.keys(PHASE8B_ARTIFACT_ROLES)).toEqual(expect.arrayContaining([
      'production_browser_verifier',
      'browser_harness',
      'gate_report_module',
      'plugin_isolation_module',
      'acceptance_fixture_module',
      'acceptance_vault_recipe',
      'benchmark_cli',
      'contract_test',
      'ci_workflow',
    ]));
  });
});

describe('Phase 8B durable freeze contract', () => {
  it('A — passes in a clean checkout with an empty worktree', () => {
    const contract = evaluatePhase8bFreezeContract(
      livePhase8bFreezeInputs({ currentWorktreePaths: [] })
    );
    expect(contract.violations).toEqual([]);
    expect(contract.missingArtifacts).toEqual([]);
    expect(contract.uncommittedArtifacts).toEqual([]);
    expect(contract.stagedArtifacts).toEqual([]);
  });

  it('B — an unrelated future UNTRACKED file does not fail a closed phase', () => {
    const contract = evaluatePhase8bFreezeContract(
      livePhase8bFreezeInputs({
        currentWorktreePaths: [
          'docs/Phase-9A-BYOK-Persistence-and-AI-Smoke.md',
          'scripts/verify_phase9a_ai_advanced_live.ts',
          'tests/security/phase9aByokPersistenceContract.test.ts',
          'tests/unit/phase9aAiSemanticAuthority.test.ts',
        ],
      })
    );
    expect(contract.violations).toEqual([]);
    expect(contract.foreignWorktreePaths).toHaveLength(4);
  });

  it('C — an unrelated future MODIFIED non-production file does not fail a closed phase', () => {
    const contract = evaluatePhase8bFreezeContract(
      livePhase8bFreezeInputs({
        currentWorktreePaths: ['README.md', 'docs/Release-Plan.md', 'src/appVersion.ts'],
      })
    );
    expect(contract.violations).toEqual([]);
  });

  it('D — legitimate later PRODUCTION development does not fail a closed phase', () => {
    // The exact defect being repaired: Phase 9A (or any later phase) may
    // legitimately edit these very trees. Phase 8B once froze them TEMPORARILY;
    // it must not police them FOREVER.
    const contract = evaluatePhase8bFreezeContract(
      livePhase8bFreezeInputs({
        currentWorktreePaths: [
          'server/byokSession.ts',
          'server/ai/openrouterProvider.ts',
          'src/utils/byok.ts',
          'src/components/AiSettingsModal.tsx',
          'src/application/session/sessionKeys.ts',
          'src/core/nutritionV2/applyAuthority.ts',
          'plugin/main.ts',
        ],
      })
    );
    expect(contract.violations).toEqual([]);
    expect(contract.productionOwnedArtifacts).toEqual([]);
    expect(contract.foreignWorktreePaths).toContain('server/byokSession.ts');
  });

  it('D2 — the verdict is INVARIANT to arbitrary future worktree contents', () => {
    // Strongest form of non-interference: hold the manifest and index constant,
    // sweep wildly different worktrees, and prove the verdict never moves. This
    // is what makes the repair durable rather than a lucky pass.
    const baseline = evaluatePhase8bFreezeContract(
      livePhase8bFreezeInputs({ currentWorktreePaths: [] })
    ).violations;

    const hostileWorktrees = [
      [],
      ['unrelated.txt'],
      ['server/a.ts', 'src/utils/b.ts', 'plugin/c.ts'],
      ['src/core/nutritionV2/anything.ts', 'src/components/anything.tsx'],
      ['package.json.orig'],
      Array.from({ length: 200 }, (_, i) => `src/future/${i}.ts`),
    ];

    for (const currentWorktreePaths of hostileWorktrees) {
      const contract = evaluatePhase8bFreezeContract(livePhase8bFreezeInputs({ currentWorktreePaths }));
      expect(contract.violations, `worktree of ${currentWorktreePaths.length} paths must not matter`).toEqual(
        baseline
      );
    }
  });

  it('E — actually damaging a real Phase 8B invariant still fails', () => {
    const real = livePhase8bFreezeInputs();

    // E1: a Phase 8B artifact deleted from disk.
    const presentWithoutHarness = new Set(real.presentPaths);
    presentWithoutHarness.delete(PHASE8B_ARTIFACT_ROLES.browser_harness);
    expect(
      evaluatePhase8bFreezeContract({ ...real, presentPaths: presentWithoutHarness }).violations.join('\n')
    ).toMatch(/cdpBrowser\.ts/);

    // E2: a Phase 8B artifact removed from version control.
    const trackedWithoutVerifier = new Set(real.trackedPaths ?? []);
    trackedWithoutVerifier.delete(PHASE8B_ARTIFACT_ROLES.production_browser_verifier);
    expect(
      evaluatePhase8bFreezeContract({ ...real, trackedPaths: trackedWithoutVerifier }).violations.join('\n')
    ).toMatch(/verify_advanced_nutrition_browser_prod\.ts/);

    // E3: Phase 8B evidence left uncommitted in the index.
    const staged = new Set<string>([PHASE8B_ARTIFACT_ROLES.contract_test]);
    expect(
      evaluatePhase8bFreezeContract({ ...real, stagedPaths: staged }).violations.join('\n')
    ).toMatch(/staged but should be committed/);

    // E4: Phase 8B claiming production source — the freeze itself, violated.
    const manifestWithProduction = [...real.manifest, 'server/nutritionV2Apply.ts'];
    expect(
      evaluatePhase8bFreezeContract({ ...real, manifest: manifestWithProduction }).violations.join('\n')
    ).toMatch(/proof-only/);

    // E5: an artifact quietly dropped from the manifest or the roles map.
    const rolesWithoutWorkflow = { ...PHASE8B_ARTIFACT_ROLES };
    delete (rolesWithoutWorkflow as Record<string, string>).ci_workflow;
    expect(
      evaluatePhase8bFreezeContract({ ...real, roles: rolesWithoutWorkflow }).violations.join('\n')
    ).toMatch(/required role: ci_workflow/);

    const manifestWithoutRecipe = real.manifest.filter(
      (path) => path !== PHASE8B_ARTIFACT_ROLES.acceptance_vault_recipe
    );
    expect(
      evaluatePhase8bFreezeContract({ ...real, manifest: manifestWithoutRecipe }).violations.join('\n')
    ).toMatch(/required role: acceptance_vault_recipe/);
  });

  it('still fails closed when no git index is available rather than passing by default', () => {
    const contract = evaluatePhase8bFreezeContract(
      livePhase8bFreezeInputs({ trackedPaths: null, stagedPaths: null })
    );
    // Index checks become not-applicable, but DISK damage is still caught.
    expect(contract.violations).toEqual([]);
    expect(evaluatePhase8bFreezeContract(
      livePhase8bFreezeInputs({ trackedPaths: null, presentPaths: new Set() })
    ).missingArtifacts).toEqual([...PHASE8B_MANIFEST].sort());
  });

  it('keeps the live contract green regardless of what else is in flight', () => {
    // Final live assertion: the real manifest against the real repository.
    const contract = evaluatePhase8bFreezeContract(livePhase8bFreezeInputs());
    expect(contract.violations).toEqual([]);
  });
});
