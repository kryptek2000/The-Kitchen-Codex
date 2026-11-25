#!/usr/bin/env node
/**
 * Build the narrow N-API Vault filesystem confinement helper.
 *
 * The helper is the privileged filesystem primitive used by the desktop main
 * process. It is intentionally not a general Node filesystem module: its only
 * exports are Vault-relative text/binary operations, listing/stat/exists,
 * directory creation, conditional write, and removal.
 *
 * The resulting .node file is platform/arch specific. It must be produced on
 * the release build host (or supplied through TKC_NATIVE_VAULT_BINARY) and is
 * copied into the desktop package. The source is committed; the binary is a
 * generated artifact.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'desktop', 'native', 'tkc_vault.cc');
const OUTPUT = process.env.TKC_NATIVE_VAULT_BINARY
  ? resolve(process.env.TKC_NATIVE_VAULT_BINARY)
  : join(ROOT, 'desktop', 'native', 'tkc_vault.node');
const CXX = process.env.CXX || 'g++';

function nodeHeaderCandidates() {
  const candidates = [];
  if (process.env.TKC_NODE_HEADERS) candidates.push(process.env.TKC_NODE_HEADERS);
  candidates.push(join(dirname(process.execPath), '..', 'include', 'node'));
  const nodedir = process.config?.variables?.nodedir;
  if (nodedir) candidates.push(join(nodedir, 'include', 'node'));
  candidates.push('/usr/include/node');
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

const HEADERS = nodeHeaderCandidates().find((candidate) =>
  existsSync(join(candidate, 'node_api.h'))
);

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!existsSync(SOURCE)) fail(`Native Vault helper source is missing: ${SOURCE}`);
if (!HEADERS) {
  fail(
    `N-API headers not found. Set TKC_NODE_HEADERS to a directory containing node_api.h. Looked in: ${nodeHeaderCandidates().join(', ')}`
  );
}
if (!existsSync('/usr/include/linux/openat2.h')) {
  fail('Linux openat2.h not found. Install linux-libc-dev (or the distribution equivalent).');
}
mkdirSync(dirname(OUTPUT), { recursive: true });

const args = [
  '-std=c++17',
  '-O2',
  '-fPIC',
  '-shared',
  '-Wall',
  '-Wextra',
  '-Wl,-z,relro,-z,now',
  `-I${HEADERS}`,
  '-o',
  OUTPUT,
  SOURCE,
  '-static-libstdc++',
  '-static-libgcc',
  '-s',
];

console.log(`🔒 Building native Vault confinement helper with ${CXX} (N-API headers: ${HEADERS})...`);
try {
  execFileSync(CXX, args, { stdio: 'inherit' });
} catch (error) {
  fail(`Native Vault helper build failed: ${error?.message || error}`);
}
const size = statSync(OUTPUT).size;
console.log(`✓ Native Vault helper written to ${OUTPUT} (${size} bytes)`);
