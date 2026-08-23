import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for Finding #2: `npm run build && npm run start` must serve
 * the compiled production bundle (static files from dist/), NOT boot the Vite
 * dev middleware.
 *
 * The test:
 *   1. Requires dist/index.html + dist/server.cjs to exist (run `npm run build` first).
 *   2. Emulates `npm run start` (node dist/server.cjs) with no NODE_ENV set, so it
 *      exercises the exact documented production command.
 *   3. Asserts the root path serves the built index.html and that the Vite dev
 *      client endpoint is NOT served as a module (in dev it would return a JS
 *      module; in prod it falls through to the SPA index.html or 404).
 *   4. Asserts a real API route works (proves the Express server is alive).
 */

const DIST_DIR = path.join(process.cwd(), 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const SERVER_CJS = path.join(DIST_DIR, 'server.cjs');
const BASE = 'http://localhost:3000';

let passed = 0;
let failed = 0;
function record(name: string, ok: boolean, details?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  ❌ [FAIL] ${name}${details ? ` — ${details}` : ''}`);
  }
}

async function main() {
  console.log('============================================================');
  console.log('🔎 PRODUCTION-SERVE REGRESSION (npm run build && npm run start)');
  console.log('============================================================\n');

  record('build artifacts exist (run npm run build first)', fs.existsSync(INDEX_HTML) && fs.existsSync(SERVER_CJS),
    `dist exists=${fs.existsSync(DIST_DIR)}, index=${fs.existsSync(INDEX_HTML)}, server.cjs=${fs.existsSync(SERVER_CJS)}`);
  if (failed > 0) {
    console.log('\nRun `npm run build` first, then re-run this test.');
    process.exit(1);
  }

  console.log('Starting compiled server (node dist/server.cjs)...');
  const server = spawn('node', [SERVER_CJS], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  // Wait for the server to come up.
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
  }

  record('server started and /api/health responds', ready, log.split('\n').slice(-3).join(' | '));

  try {
    // Root serves the built index.html (SPA shell), text/html.
    const root = await fetch(`${BASE}/`).catch((e) => null);
    record('GET / returns 200 text/html', !!root && root.status === 200 && (root.headers.get('content-type') || '').includes('text/html'),
      root ? `status=${root.status} type=${root.headers.get('content-type')}` : 'no response');
    const rootHtml = root ? await root.text() : '';
    const assetMatch = rootHtml.match(/["'](\/assets\/[^"']*\.js)["']/) || [];
    const assetPath = assetMatch[1];
    record('GET / loads the built index.html (references hashed assets)', !!assetPath,
      assetPath ? `asset=${assetPath}` : 'no /assets/*.js reference in index');

    // Vite dev middleware must NOT be active. In dev, /@vite/client serves a JS
    // module (application/javascript). In prod, that route does not exist, so it
    // either 404s or falls through to index.html (text/html) — never JS.
    const vite = await fetch(`${BASE}/@vite/client`).catch((e) => null);
    const viteType = vite ? (vite.headers.get('content-type') || '') : 'no-response';
    record('Vite dev middleware NOT active (/@vite/client is not a JS module)', !viteType.includes('application/javascript'),
      `type=${viteType || 'no headers'}`);

    // A real built static asset serves as a JS module (proves dist/ is mounted).
    if (assetPath) {
      const asset = await fetch(`${BASE}${assetPath}`).catch((e) => null);
      record('built JS asset served from dist/ (application/javascript)', !!asset && asset.status === 200 && (asset.headers.get('content-type') || '').includes('javascript'),
        asset ? `status=${asset.status} type=${asset.headers.get('content-type')}` : 'no response');
    }
  } finally {
    server.kill('SIGKILL');
  }

  console.log('\n============================================================');
  console.log(`PROD-SERVE SUMMARY: ${passed + failed} TESTS | ${passed} PASSED | ${failed} FAILED`);
  console.log('============================================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error in prod-serve regression:', err);
  process.exit(1);
});
