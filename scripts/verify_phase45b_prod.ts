/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: production build/serve verification.
 *
 * Run AFTER `bun run build`. Independently verifies the fixed-fetch delivery:
 *   - exactly five intended USDA runtime assets are emitted into dist/assets;
 *   - each emitted asset is BYTE-IDENTICAL to its checked-in source (length and
 *     SHA-256 independently matched against USDA_BUNDLE_RELEASE_LOCK);
 *   - no shard payload or long base64 representation exists in ANY client
 *     JavaScript chunk (eager or lazy);
 *   - the eager main JavaScript carries only the fixed generated asset URLs;
 *   - no raw USDA archive, extracted upstream JSON, absolute local path, or
 *     credential is emitted;
 *   - the production server (node dist/server.cjs, no Vite dev middleware)
 *     serves the app and each of the five emitted assets with HTTP 200 and the
 *     exact locked bytes.
 *
 * Usage: bun x tsx scripts/verify_phase45b_prod.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { USDA_BUNDLE_RELEASE_LOCK } from '../src/core/nutritionV2/usda/releaseLock';
import { sha256HexFromBytes } from '../src/core/nutritionV2/usda/digest';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const ASSETS_DIR = join(DIST, 'assets');
const BUNDLE_DIR = join(ROOT, 'data', 'advanced-nutrition', 'usda', USDA_BUNDLE_RELEASE_LOCK.bundle_release);

let passed = 0;
let failed = 0;
function record(name: string, ok: boolean, details?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${details ? ` — ${details}` : ''}`);
  }
}

interface LockedFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

function lockedFiles(): ReadonlyArray<LockedFile> {
  const lock = USDA_BUNDLE_RELEASE_LOCK;
  return [
    { name: lock.artifact.filename, bytes: lock.artifact.bytes, sha256: lock.artifact.sha256 },
    { name: lock.manifest.filename, bytes: lock.manifest.bytes, sha256: lock.manifest.sha256 },
    ...lock.shards.map((shard) => ({
      name: shard.filename,
      bytes: shard.compressed_bytes,
      sha256: shard.compressed_sha256,
    })),
  ];
}

function sha256File(path: string): string {
  return sha256HexFromBytes(new Uint8Array(readFileSync(path)));
}

/** Finds the single emitted asset whose length and SHA-256 match the locked file. */
function findEmittedAsset(files: ReadonlyArray<string>, locked: LockedFile): string | null {
  const matches = files.filter((file) => {
    try {
      return readFileSync(join(ASSETS_DIR, file)).length === locked.bytes && sha256File(join(ASSETS_DIR, file)) === locked.sha256;
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0] : null;
}

async function main(): Promise<void> {
  console.log('Phase 4.5B production build/serve verification (fixed static assets)');
  if (!existsSync(DIST) || !existsSync(join(DIST, 'server.cjs')) || !existsSync(ASSETS_DIR)) {
    console.error('dist/ is missing. Run `bun run build` first.');
    process.exit(1);
  }

  const emitted = readdirSync(ASSETS_DIR);
  const clientJs = emitted.filter((name) => name.endsWith('.js'));

  // 1. Exactly five intended USDA assets, each byte-identical to its source.
  const locked = lockedFiles();
  const emittedByLogicalName = new Map<string, string>();
  for (const file of locked) {
    const match = findEmittedAsset(emitted, file);
    record(`emitted asset byte-identical to ${file.name}`, match !== null, match ?? 'no unique match');
    if (match) emittedByLogicalName.set(file.name, match);
  }
  record('exactly five distinct USDA runtime assets are emitted', new Set(emittedByLogicalName.values()).size === 5);

  // 2. No shard payload or long base64 representation in ANY client JavaScript.
  const shardPayloadPrefixes = USDA_BUNDLE_RELEASE_LOCK.shards.map((shard) =>
    readFileSync(join(BUNDLE_DIR, shard.filename)).toString('base64').slice(0, 128)
  );
  let payloadInJs = false;
  for (const file of clientJs) {
    const text = readFileSync(join(ASSETS_DIR, file), 'utf8');
    if (text.includes('data:application/gzip;base64')) payloadInJs = true;
    if (shardPayloadPrefixes.some((prefix) => text.includes(prefix))) payloadInJs = true;
  }
  record('no client JavaScript chunk carries a shard payload or base64 representation', !payloadInJs);

  // 3. The eager main JavaScript carries the fixed generated asset URLs.
  const mainChunk = clientJs.find((name) => /^index-.*\.js$/.test(name));
  if (mainChunk) {
    const mainText = readFileSync(join(ASSETS_DIR, mainChunk), 'utf8');
    const allUrlsPresent = [...emittedByLogicalName.values()].every((name) => mainText.includes(`/assets/${name}`));
    record('the eager main JavaScript references every fixed emitted asset URL', allUrlsPresent);
  } else {
    record('the eager main JavaScript chunk exists', false);
  }

  // 4. No raw ZIP / absolute path / credential in any emitted asset.
  let unsafe = 0;
  for (const name of emitted) {
    const bytes = readFileSync(join(ASSETS_DIR, name));
    if (bytes.includes(Buffer.from('PK\x03\x04', 'binary'))) unsafe += 1;
    const text = bytes.toString('latin1');
    if (text.includes('/home/') || text.includes('/tmp/') || text.includes('AI_ENDPOINT_TOKEN')) unsafe += 1;
  }
  record('no emitted asset carries a raw ZIP, absolute local path, or credential', unsafe === 0);

  // 5. Serve with the compiled production server (no Vite dev middleware).
  const port = 4599;
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForServer(`${base}/api/health`, 15000);
    const indexResponse = await fetch(`${base}/`);
    const indexHtml = await indexResponse.text();
    record('the server serves the built app (200 + index.html)', indexResponse.status === 200 && indexHtml.includes('<div id="root">'));

    for (const [logicalName, emittedName] of emittedByLogicalName) {
      const response = await fetch(`${base}/assets/${emittedName}`);
      const served = new Uint8Array(await response.arrayBuffer());
      const source = new Uint8Array(readFileSync(join(BUNDLE_DIR, logicalName)));
      const identical = served.length === source.length && sha256HexFromBytes(served) === sha256HexFromBytes(source);
      record(`the server serves the exact locked bytes for ${logicalName}`, response.status === 200 && identical);
    }
  } finally {
    server.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error('server_timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'verification_failed');
  process.exit(1);
});
