#!/usr/bin/env node
/**
 * The Kitchen Codex — portable Linux desktop package builder.
 *
 * Stages the EXISTING production application (dist/server.cjs + built assets),
 * the secure Electron shell, package metadata and the installed runtime
 * dependencies. It never modifies source or the owner's Vault.
 *
 * Requires the dev dependencies declared in package.json:
 *   electron, @electron/packager
 *
 * For an isolated validation run the packager module may be supplied with
 * TKC_PACKAGER_MODULE, and the Electron version with TKC_ELECTRON_VERSION.
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(ROOT, '.desktop-stage');
const OUT = process.env.TKC_DESKTOP_OUT
  ? resolve(process.env.TKC_DESKTOP_OUT)
  : join(ROOT, 'desktop-dist');

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!existsSync(join(ROOT, 'dist', 'server.cjs'))) {
  fail('Production build missing. Run `npm run build` first.');
}
if (!existsSync(join(ROOT, 'desktop', 'main.cjs'))) {
  fail('Desktop shell missing.');
}

// The native helper is the privileged filesystem primitive. Build it from the
// source in this tree (or use an explicitly supplied prebuilt binary) so the
// package never contains a stale helper.
let nativeBinary = process.env.TKC_NATIVE_VAULT_BINARY
  ? resolve(process.env.TKC_NATIVE_VAULT_BINARY)
  : join(ROOT, 'desktop', 'native', 'tkc_vault.node');
if (!process.env.TKC_SKIP_NATIVE_BUILD) {
  console.log('🔒 Building native Vault confinement helper...');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-desktop-native.mjs')], {
    stdio: 'inherit',
  });
  nativeBinary = process.env.TKC_NATIVE_VAULT_BINARY
    ? resolve(process.env.TKC_NATIVE_VAULT_BINARY)
    : join(ROOT, 'desktop', 'native', 'tkc_vault.node');
}
if (!existsSync(nativeBinary)) {
  fail('Native Vault confinement helper is missing. Run `npm run build:desktop:native`.');
}

console.log('📦 Staging desktop package...');
rmSync(STAGE, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const item of ['dist', 'desktop', 'package.json']) {
  cpSync(join(ROOT, item), join(STAGE, item), { recursive: true });
}
mkdirSync(join(STAGE, 'desktop', 'native'), { recursive: true });
cpSync(nativeBinary, join(STAGE, 'desktop', 'native', 'tkc_vault.node'));
if (!existsSync(join(ROOT, 'node_modules'))) {
  fail('node_modules is missing. Install production dependencies before packaging.');
}
console.log('   copying runtime dependencies (this is the long step)...');
cpSync(join(ROOT, 'node_modules'), join(STAGE, 'node_modules'), {
  recursive: true,
  dereference: true,
  filter: (source) => !source.includes('/.cache/'),
});

// Portable Electron packaging without a second packaging framework:
// copy the official Electron runtime, remove the default app, and place the
// staged Kitchen Codex application at resources/app. This is the same layout
// Electron itself uses and produces a real runnable Linux desktop package.
const require = createRequire(import.meta.url);
let electronDist = process.env.TKC_ELECTRON_DIST;
if (!electronDist) {
  try {
    electronDist = join(dirname(require.resolve('electron')), 'dist');
  } catch (error) {
    fail('Electron is not installed. Install the declared dev dependency or set TKC_ELECTRON_DIST.');
  }
}
if (!existsSync(join(electronDist, 'electron'))) {
  fail(`Electron runtime not found at ${electronDist}.`);
}

const bundleDir = join(OUT, 'TheKitchenCodex-linux-x64');
console.log(`🚀 Copying Electron runtime from ${electronDist}...`);
cpSync(electronDist, bundleDir, { recursive: true, dereference: true });
rmSync(join(bundleDir, 'resources', 'default_app.asar'), { force: true });
console.log('📚 Installing the staged application at resources/app...');
cpSync(STAGE, join(bundleDir, 'resources', 'app'), { recursive: true, dereference: true });
const electronBinary = join(bundleDir, 'electron');
const appBinary = join(bundleDir, 'TheKitchenCodex');
if (existsSync(electronBinary)) cpSync(electronBinary, appBinary);
try {
  const { chmodSync } = await import('node:fs');
  chmodSync(appBinary, 0o755);
  chmodSync(join(bundleDir, 'chrome-sandbox'), 0o4755);
} catch {
  // Non-root staging cannot grant setuid; documented packaging limitation.
}
cpSync(join(ROOT, 'desktop', 'the-kitchen-codex.desktop'), join(bundleDir, 'the-kitchen-codex.desktop'));

writeFileSync(
  join(OUT, 'README-DESKTOP.txt'),
  [
    'The Kitchen Codex — standalone desktop candidate',
    '',
    'Run: ./TheKitchenCodex-linux-x64/TheKitchenCodex',
    '',
    'The app stores its managed Recipe Vault under:',
    '  <Documents>/The Kitchen Codex/My Recipe Vault',
    '',
    'No cloud account is required. No owner data is included in this package.',
    '',
  ].join('\n'),
  'utf8'
);
console.log(`\n✓ Desktop package written to ${OUT}`);
