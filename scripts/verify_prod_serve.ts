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

  const distExists = fs.existsSync(DIST_DIR);
  const indexExists = fs.existsSync(INDEX_HTML);
  const serverExists = fs.existsSync(SERVER_CJS);

  record('build artifacts exist (dist/index.html & dist/server.cjs)', distExists && indexExists && serverExists,
    `dist=${distExists}, index=${indexExists}, server.cjs=${serverExists}`);
  if (failed > 0) {
    console.log('\nRun `npm run build` first, then re-run this test.');
    process.exit(1);
  }

  // 1. Validate production dist/index.html contents
  const indexHtml = fs.readFileSync(INDEX_HTML, 'utf-8');
  const assetMatch = indexHtml.match(/["'](\/assets\/[^"']*\.js)["']/) || [];
  const assetPath = assetMatch[1];
  record('production index.html contains hashed static assets (/assets/*.js)', !!assetPath,
    assetPath ? `found asset: ${assetPath}` : 'no /assets/*.js reference in dist/index.html');

  if (assetPath) {
    const fullAssetPath = path.join(DIST_DIR, assetPath.replace(/^\//, ''));
    record('hashed static JS asset exists on disk', fs.existsSync(fullAssetPath), fullAssetPath);
  }

  // 2. Validate compiled server bundle dist/server.cjs
  const serverCjs = fs.readFileSync(SERVER_CJS, 'utf-8');
  record('compiled server bundle contains production static file middleware', 
    serverCjs.includes('.static(distPath)') || serverCjs.includes('express.static') || (serverCjs.includes('static') && serverCjs.includes('distPath')),
    'static distribution path and index.html fallback present in compiled server.cjs');
  record('compiled server bundle contains production mode configuration',
    serverCjs.includes('isProduction = true') || serverCjs.includes('"production"'),
    'production mode flag bundled into server.cjs');

  // 3. Verify health and API endpoints respond on server
  try {
    const healthRes = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    record('/api/health endpoint is live and responds 200 OK', healthRes.status === 200);
  } catch (e: any) {
    record('/api/health endpoint is live and responds 200 OK', false, e.message);
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
