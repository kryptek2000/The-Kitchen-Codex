/**
 * The Kitchen Codex — Obsidian Plugin Build (Phase 4D3B).
 *
 * Bundles plugin/main.ts into plugin/main.js (the file Obsidian loads from the
 * plugin folder) using the esbuild already present in the repo. The `obsidian`
 * package is externalized (Obsidian provides it at runtime); React and the
 * platform-neutral application/core code are bundled.
 *
 * Run: `bun run build:plugin`
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

async function main() {
  await build({
    entryPoints: [resolve(__dirname, 'main.ts')],
    bundle: true,
    external: ['obsidian'],
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    outfile: resolve(__dirname, 'main.js'),
    sourcemap: 'inline',
    tsconfig: resolve(ROOT, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
