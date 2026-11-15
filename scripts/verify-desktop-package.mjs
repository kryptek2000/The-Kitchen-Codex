#!/usr/bin/env node
/**
 * Verify the packaged Linux desktop candidate.
 *
 * - confirms the executable and runtime files exist;
 * - confirms packaged desktop sources are byte-identical to the worktree;
 * - loads the packaged native Vault helper and runs a disposable write/read/remove;
 * - writes a small manifest for CI artifacts (never the 1.6 GB package itself).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bundle = path.resolve(process.argv[2] || '');
const manifestPath = path.resolve(process.argv[3] || '');
const sourceRoot = process.cwd();

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireFile(file) {
  if (!fs.existsSync(file)) fail(`Missing packaged file: ${file}`);
  return file;
}

if (!bundle || !fs.existsSync(bundle) || !fs.statSync(bundle).isDirectory()) {
  fail(`Packaged desktop directory not found: ${bundle}`);
}
if (!manifestPath) fail('A manifest output path is required.');

const appDir = path.join(bundle, 'resources', 'app');
const packagedDesktop = path.join(appDir, 'desktop');
const executable = path.join(bundle, 'TheKitchenCodex');
requireFile(executable);
fs.accessSync(executable, fs.constants.X_OK);
requireFile(path.join(appDir, 'dist', 'server.cjs'));
requireFile(path.join(packagedDesktop, 'native', 'tkc_vault.node'));

const comparedFiles = [
  'main.cjs',
  'preload.cjs',
  'fsSafety.cjs',
  'security.cjs',
  'vaultState.cjs',
  'vaultFs.cjs',
  'native/tkc_vault.node',
];
for (const relative of comparedFiles) {
  const source = requireFile(path.join(sourceRoot, 'desktop', relative));
  const packaged = requireFile(path.join(packagedDesktop, relative));
  if (!fs.readFileSync(source).equals(fs.readFileSync(packaged))) {
    fail(`Packaged desktop file differs from source: ${relative}`);
  }
}

const helperPath = path.join(packagedDesktop, 'native', 'tkc_vault.node');
const helper = require(helperPath);
const requiredExports = [
  'readText',
  'readBinary',
  'writeText',
  'writeBinary',
  'writeTextIfUnchanged',
  'list',
  'stat',
  'exists',
  'mkdir',
  'remove',
];
for (const name of requiredExports) {
  if (typeof helper[name] !== 'function') fail(`Packaged native helper is missing ${name}().`);
}

// Exercise the packaged wrapper and helper against a disposable Vault.
const packagedFsSafety = require(path.join(packagedDesktop, 'fsSafety.cjs'));
const packagedVaultFs = require(path.join(packagedDesktop, 'vaultFs.cjs'));
const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tkc-package-native-'));
try {
  const allowedRoots = new Set();
  const identities = new Map();
  const real = packagedFsSafety.authorizeRoot(disposableRoot, allowedRoots, identities);
  const identity = identities.get(real);
  packagedVaultFs.writeText(real, 'ci/verify.txt', 'packaged-native-ok', identity);
  const readBack = packagedVaultFs.readText(real, 'ci/verify.txt', identity);
  if (readBack !== 'packaged-native-ok') fail('Packaged native helper write/read self-test failed.');
  packagedVaultFs.remove(real, 'ci/verify.txt', identity);
} finally {
  fs.rmSync(disposableRoot, { recursive: true, force: true });
}

const manifest = [
  'The Kitchen Codex — Linux desktop package verification',
  `package=${bundle}`,
  `app_version=${JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version}`,
  `native_helper_sha256=${sha256(helperPath)}`,
  `main_sha256=${sha256(path.join(packagedDesktop, 'main.cjs'))}`,
  `preload_sha256=${sha256(path.join(packagedDesktop, 'preload.cjs'))}`,
  `fsSafety_sha256=${sha256(path.join(packagedDesktop, 'fsSafety.cjs'))}`,
  `vaultFs_sha256=${sha256(path.join(packagedDesktop, 'vaultFs.cjs'))}`,
  `native_helper_exports=${requiredExports.length}`,
  'native_self_test=passed',
  `git_sha=${process.env.GITHUB_SHA || 'local'}`,
  `runner_os=${process.env.RUNNER_OS || process.platform}`,
  `verified_at=${new Date().toISOString()}`,
  '',
].join('\n');
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, manifest, 'utf8');
console.log(manifest);
console.log(`✓ Packaged desktop verified. Manifest: ${manifestPath}`);
