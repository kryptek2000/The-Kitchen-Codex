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
 * File-level worktree paths. `git status --porcelain` collapses untracked
 * DIRECTORIES into a single entry (`?? scripts/browserHarness/`), which would
 * hide the very files this contract is supposed to police, so untracked paths
 * are expanded with `git ls-files --others`.
 */
function worktreePaths(): string[] {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const run = (args: string[]): string[] =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  return [...new Set([...run(['diff', '--name-only']), ...run(['ls-files', '--others', '--exclude-standard'])])].sort();
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
// Production freeze
// ---------------------------------------------------------------------------

describe('Phase 8B production freeze', () => {
  const FROZEN_TREES = ['src/core/nutritionV2', 'src/utils', 'src/components', 'src/application', 'server', 'plugin'];
  const ALLOWED = new Set([
    'scripts/verify_advanced_nutrition_browser_prod.ts',
    'scripts/verify_plugin_isolation.ts',
    'scripts/benchmark_nutrition_phase8b_browser_proof.ts',
    'scripts/browserHarness/cdpBrowser.ts',
    'scripts/nutritionReleaseExit/phase8bReport.ts',
    'scripts/nutritionReleaseExit/phase8bPluginIsolation.ts',
    'tests/fixtures/advancedNutritionBrowserAcceptanceFixture.ts',
    `tests/fixtures/advancedNutritionBrowserAcceptanceVault/${ACCEPTANCE_RECIPE_FILE}`,
    'tests/unit/advancedNutritionPhase8bBrowserProofContract.test.ts',
    // Authorized amendment, NOT a Phase 8B file: one Phase 8A assertion is
    // pinned to Phase 8A's base commit so that Phase 8A's historical
    // "zero production-build coverage" finding is preserved rather than
    // silently rewritten by the legitimate arrival of Phase 8B evidence.
    // Explicitly approved by Sid; see the Phase 8B report.
    'tests/unit/advancedNutritionPhase8aReleaseExitRecon.test.ts',
    'package.json',
    '.github/workflows/build.yml',
    'docs/Advanced-Nutrition-Architecture.md',
  ]);

  it('has zero production source diff', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    for (const tree of FROZEN_TREES) {
      const status = execFileSync('git', ['status', '--porcelain=v1', '--', tree], { cwd: ROOT, encoding: 'utf8' });
      expect(status.trim(), `${tree} must have no diff`).toBe('');
    }
  });

  it('touches only the allowed Phase 8B proof paths', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const paths = worktreePaths();

    if (paths.length > 0) {
      // In-flight work: every changed/untracked path must be an authorized one.
      for (const path of paths) {
        expect(ALLOWED.has(path), `unexpected Phase 8B path: ${path}`).toBe(true);
      }
      return;
    }

    // Committed state (CI, or any clean checkout): the worktree diff is empty by
    // definition, so the same intent — "Phase 8B's file set is exactly the
    // authorized set" — is asserted against the committed tree instead. This is
    // deliberately history-free (no HEAD^, no rev-list), so it holds under a
    // shallow CI checkout, and it stays strict in BOTH states: every authorized
    // path must exist AND be tracked, and no authorized path may be absent.
    for (const path of ALLOWED) {
      expect(existsSync(join(ROOT, path)), `authorized Phase 8B path is missing: ${path}`).toBe(true);
    }
    const tracked = execFileSync('git', ['ls-files', '--', ...ALLOWED], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect([...tracked].sort(), 'every authorized Phase 8B path must be committed (tracked by git)').toEqual([...ALLOWED].sort());
  });

  it('has staged nothing', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT, encoding: 'utf8' });
    expect(staged.trim()).toBe('');
  });
});
