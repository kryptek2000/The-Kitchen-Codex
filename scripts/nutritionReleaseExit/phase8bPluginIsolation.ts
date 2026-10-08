/**
 * The Kitchen Codex — Phase 8B plugin-isolation contract.
 *
 * A PURE checker over the emitted `plugin/main.js` text. Keeping it separate
 * from the CLI lets the focused contract test drive mutations (M12) directly.
 *
 * TEST-ONLY: not imported by any production module and never part of the
 * application or plugin build graph.
 */

/**
 * Markers that MUST be present, proving the emitted bundle is a real plugin
 * build rather than an empty or stubbed file that trivially "passes" isolation.
 *
 * These are real Obsidian plugin API symbols observed in the emitted (minified)
 * bundle. `addCommand` is used rather than `registerCommand` because Obsidian's
 * Plugin API exposes `this.addCommand(...)`; the bundle is minified, so symbol
 * names survive only where they are genuine API/property names.
 */
export const REQUIRED_PLUGIN_MARKERS: ReadonlyArray<string> = [
  'Kitchen Codex',
  'onload',
  'addCommand',
  'addRibbonIcon',
  'activateView',
];

export const FORBIDDEN_PLUGIN_MARKERS: ReadonlyArray<string> = [
  'phase8aRecon',
  'phase8aReport',
  'phase8bReport',
  'nutrition_phase8a_release_exit_recon_v1',
  'nutrition_phase8b_production_browser_proof_v1',
  'benchmark_nutrition_phase8a_release_exit',
  'benchmark_nutrition_phase8b_browser_proof',
  'verify_advanced_nutrition_browser_prod',
  'cdpBrowser',
  'advancedNutritionPhase8aReleaseExitRecon',
  'advancedNutritionPhase8bBrowserProofContract',
];

export interface IsolationResult {
  readonly kind: 'required' | 'forbidden';
  readonly marker: string;
  readonly ok: boolean;
}

export function checkPluginIsolation(bundle: string): IsolationResult[] {
  const results: IsolationResult[] = [];
  if (bundle.length === 0) {
    return [{ kind: 'required', marker: '<non-empty bundle>', ok: false }];
  }
  for (const marker of REQUIRED_PLUGIN_MARKERS) {
    results.push({ kind: 'required', marker, ok: bundle.includes(marker) });
  }
  for (const marker of FORBIDDEN_PLUGIN_MARKERS) {
    results.push({ kind: 'forbidden', marker, ok: !bundle.includes(marker) });
  }
  return results;
}

export function isolationFailures(results: ReadonlyArray<IsolationResult>): IsolationResult[] {
  return results.filter((r) => !r.ok);
}
