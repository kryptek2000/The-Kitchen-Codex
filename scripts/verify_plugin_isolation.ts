/**
 * The Kitchen Codex — durable plugin-isolation verification CLI.
 *
 * Proves, as a repeatable repository command (and a CI step), that the emitted
 * Obsidian plugin bundle contains no Advanced Nutrition planning or browser-proof
 * code while still containing the plugin runtime it should contain.
 *
 * It reads `plugin/main.js` as an opaque emitted artifact and never modifies the
 * plugin build, so no production source changes and no isolation guard is
 * weakened.
 *
 * Usage:
 *   bun run build:plugin
 *   bun run test:plugin:isolation
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { checkPluginIsolation, isolationFailures } from './nutritionReleaseExit/phase8bPluginIsolation';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN_BUNDLE = join(ROOT, 'plugin', 'main.js');

function main(): void {
  console.log('Plugin isolation verification');
  if (!existsSync(PLUGIN_BUNDLE)) {
    console.error(
      `plugin/main.js is missing. Run \`bun run build:plugin\` first; isolation must be proven against the emitted artifact.`
    );
    process.exit(1);
  }
  const bundle = readFileSync(PLUGIN_BUNDLE, 'utf8');
  const results = checkPluginIsolation(bundle);
  for (const result of results) {
    const label = result.kind === 'required' ? 'contains required' : 'is free of';
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  plugin bundle ${label} "${result.marker}"`);
  }
  const failures = isolationFailures(results);
  console.log(`\n${results.length - failures.length} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
