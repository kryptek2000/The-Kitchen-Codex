import * as fs from 'fs';
import * as path from 'path';

/**
 * The Kitchen Codex — Brand + Blood Moon theme production verification.
 *
 * Verifies the BUILT (dist/) artifact, and — when a production server is
 * reachable on :3000 — the SERVED bundle too. This is the closest available
 * substitute for a browser smoke test in this repo (there is no Playwright/DOM
 * E2E harness; see AGENTS.md). It proves the theme + brand shipped to prod:
 *
 *   1. dist/index.html links the SVG favicon and the hashed CSS/JS assets exist
 *   2. the built CSS contains the [data-theme="blood-moon"] token set
 *   3. the built CSS contains the token-driven brand mark rules
 *   4. the built JS bundle contains the blood-moon theme registration
 *   5. (server) `/`, `/favicon.svg`, and the CSS asset are served and carry the
 *      same tokens — i.e. what a browser would actually download
 *
 * Run: `bun run build` then `bun x tsx scripts/verify_brand_theme_prod.ts`
 * (server optional; set BASE_URL to override http://localhost:3000).
 */

const DIST_DIR = path.join(process.cwd(), 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const BASE = process.env.BASE_URL || 'http://localhost:3000';

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

const BLOOD_MOON_TOKENS = [
  '--bg-root: #0B090A',
  '--bg-surface: #131011',
  '--bg-elevated: #1A1416',
  '--accent: #B72A3A',
  '--accent-text: #D9665A',
  '--text-primary: #F2ECE7',
];

/** Minifiers strip whitespace and lowercase hex; compare on a normalized form. */
function normalize(cssText: string): string {
  return cssText.replace(/\s+/g, '').toLowerCase();
}
const BLOOD_MOON_SCOPE = /\[data-theme=["']?blood-moon["']?\]/;

async function main() {
  console.log('============================================================');
  console.log('🎨 BRAND + BLOOD MOON PRODUCTION VERIFICATION');
  console.log('============================================================\n');

  if (!fs.existsSync(INDEX_HTML)) {
    console.error('dist/index.html not found. Run `bun run build` first.');
    process.exit(1);
  }

  const indexHtml = fs.readFileSync(INDEX_HTML, 'utf-8');

  // --- 1. Static artifact wiring -------------------------------------------
  console.log('📦 1. BUILT ARTIFACT WIRING');
  record('dist/index.html links the SVG favicon', /rel="icon"[^>]*href="\/favicon\.svg"/.test(indexHtml));
  record('dist/favicon.svg exists', fs.existsSync(path.join(DIST_DIR, 'favicon.svg')));

  const cssHref = (indexHtml.match(/href="(\/assets\/[^"]+\.css)"/) || [])[1];
  const jsHref = (indexHtml.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
  record('dist/index.html references a hashed CSS asset', !!cssHref, cssHref);
  record('dist/index.html references a hashed JS asset', !!jsHref, jsHref);

  const cssPath = cssHref ? path.join(DIST_DIR, cssHref.replace(/^\//, '')) : '';
  const jsPath = jsHref ? path.join(DIST_DIR, jsHref.replace(/^\//, '')) : '';
  const cssOk = !!cssPath && fs.existsSync(cssPath);
  const jsOk = !!jsPath && fs.existsSync(jsPath);
  record('hashed CSS asset exists on disk', cssOk, cssPath);
  record('hashed JS asset exists on disk', jsOk, jsPath);

  // --- 2 & 3. Built CSS tokens + brand rules -------------------------------
  console.log('\n🎨 2 & 3. BUILT CSS — BLOOD MOON TOKENS + BRAND RULES');
  const css = cssOk ? fs.readFileSync(cssPath, 'utf-8') : '';
  const normCss = normalize(css);
  record('CSS defines the [data-theme="blood-moon"] scope', BLOOD_MOON_SCOPE.test(normCss));
  for (const token of BLOOD_MOON_TOKENS) {
    record(`CSS contains token "${token}"`, normCss.includes(normalize(token)));
  }
  record('CSS defines token-driven brand body rule (.kc-brand-mark__body)', css.includes('.kc-brand-mark__body'));
  record('CSS defines token-driven brand accent rule (.kc-brand-mark__accent)', css.includes('.kc-brand-mark__accent'));
  record('brand accent rule uses var(--accent-text)', /\.kc-brand-mark__accent\{[^}]*var\(--accent-text/.test(normalize(css)));

  // --- 4. Built JS theme registration --------------------------------------
  console.log('\n🧩 4. BUILT JS — THEME REGISTRATION');
  const js = jsOk ? fs.readFileSync(jsPath, 'utf-8') : '';
  record('JS bundle contains the blood-moon theme id', js.includes('blood-moon'));
  record('JS bundle contains the theme display name', js.includes('The Blood Moon'));
  record('JS bundle contains the descriptor badge', js.includes("Developer's Edition"));

  // --- 5. Served bundle (optional) -----------------------------------------
  console.log('\n🌐 5. SERVED PRODUCTION BUNDLE (optional; server on :3000)');
  let serverUp = false;
  try {
    const root = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2500) });
    serverUp = root.status === 200;
    if (serverUp) {
      const html = await root.text();
      record('served / returns the built app shell', html.includes('<div id="root">'));
      record('served / references the favicon', html.includes('/favicon.svg'));

      const favicon = await fetch(`${BASE}/favicon.svg`, { signal: AbortSignal.timeout(2500) });
      record('served /favicon.svg returns 200', favicon.status === 200, `status=${favicon.status}`);
      const faviconSvg = await favicon.text();
      record('served favicon is the pot/steam SVG', faviconSvg.includes('<svg') && faviconSvg.includes('The Kitchen Codex'));

      if (cssHref) {
        const servedCss = await fetch(`${BASE}${cssHref}`, { signal: AbortSignal.timeout(2500) });
        record('served CSS asset returns 200', servedCss.status === 200, `status=${servedCss.status}`);
        const text = await servedCss.text();
        record('served CSS carries the blood-moon token set', BLOOD_MOON_TOKENS.every((t) => normalize(text).includes(normalize(t))));
      }
    }
  } catch (e: any) {
    serverUp = false;
  }
  if (!serverUp) {
    console.log('  ℹ️  [SKIP] no server on :3000 — artifact checks above still ran.');
  }

  console.log('\n============================================================');
  console.log(`BRAND/THEME PROD SUMMARY: ${passed + failed} TESTS | ${passed} PASSED | ${failed} FAILED`);
  console.log('============================================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error in brand/theme prod verification:', err);
  process.exit(1);
});
