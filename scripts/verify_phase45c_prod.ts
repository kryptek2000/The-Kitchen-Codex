/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5C: production browser acceptance.
 *
 * Dependency-free real-browser acceptance for US customary portion resolution.
 * It builds nothing itself; run `bun run build` first. It starts the compiled
 * production server, drives the built application in real headless Chrome over
 * CDP, and proves the end-to-end cornmeal flow:
 *
 *   open the app -> open Advanced Nutrition (explicit user action)
 *   -> authenticate the fixed local USDA bundle
 *   -> use the `1 cup Cornmeal` ingredient of the starter recipe
 *   -> select FDC 169697 -> see `1 cup = 122 g`
 *   -> explicitly select the source portion -> explicitly calculate
 *   -> `source_portion` evidence with 122 g
 *   -> no Apply/Save/persistence and no external request.
 *
 * Usage: bun x tsx scripts/verify_phase45c_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4651);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9361);

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Array<(p: any) => void>>();
  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error('cdp_error'));
          else pending.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method: string, listener: (params: any) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method)!.push(listener);
  }
}

async function waitForHttp(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error('timeout');
    await sleep(200);
  }
}

async function evaluate(cdp: Cdp, expression: string): Promise<any> {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error('evaluate_failed');
  return result.result.value;
}

async function waitFor(cdp: Cdp, expression: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, expression)) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${expression}`);
    await sleep(100);
  }
}

async function main(): Promise<void> {
  console.log('Phase 4.5C production browser acceptance (US customary portion)');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-phase45c-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-extensions',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp: Cdp | null = null;
  try {
    await waitForHttp(`http://127.0.0.1:${APP_PORT}/api/health`);
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolveOpen, reject) => {
      ws.addEventListener('open', () => resolveOpen(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws_error')), { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    const externalNutritionRequests: string[] = [];
    const bundleAssetRequests: string[] = [];
    cdp.on('Network.requestWillBeSent', (params: any) => {
      const url = String(params.request.url);
      if (/\/assets\/(artifact-|manifest-|records\.)/.test(url)) bundleAssetRequests.push(url);
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url).origin === `http://127.0.0.1:${APP_PORT}`;
      } catch {
        sameOrigin = url.startsWith('data:');
      }
      if (!sameOrigin && /usda|fdc|openfoodfacts|api\.data\.gov|\/api\//i.test(url)) {
        externalNutritionRequests.push(url);
      }
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(500);

    // Open the cornmeal recipe via the visible Details control.
    await evaluate(cdp, `(() => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === 'Skillet Cornmeal Porridge');
      const card = heading && heading.closest('.group');
      const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advanced Nutrition')`, 15000);

    // Explicit user action opens Advanced Nutrition and loads the bundle.
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]') || Array.from(document.querySelectorAll('button')).find((x) => /Open (Saved )?Advanced (Report|Nutrition)|Generate Nutrition/.test((x.textContent||''))); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[role="dialog"]')`, 60000);
    await waitFor(cdp, `document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length >= 1`, 30000);

    // Post-Phase-5 remediation: detailed candidate/portion tools are compact by
    // default and live behind the row's Edit control; when a food is already
    // resolved the candidate list is behind `Change food`. Open the cornmeal row
    // and ensure FDC 169697 is selected (the one-click analyzer already chooses
    // it; this verifies the explicit user path as well).
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result: string = await evaluate(cdp, `(() => {
        const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => /cornmeal/i.test(n.innerText || ''));
        if (!row) return 'no-row';
        const btn = row.querySelector('[data-testid="advanced-nutrition-edit"]');
        if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
        const label = Array.from(row.querySelectorAll('label')).find((l) => (l.innerText||'').includes('FDC 169697'));
        if (label) {
          const radio = label.querySelector('input[type="radio"]');
          if (!radio) return 'no-input';
          radio.click();
          return 'ok';
        }
        const change = row.querySelector('[data-testid="advanced-nutrition-change-food"]');
        if (change) {
          change.click();
          return 'expanding';
        }
        return 'no-label';
      })()`);
      if (result === 'ok') break;
      await sleep(250);
    }

    // The compatible canonical cup portion is presented immediately with a
    // semantic label (never the `undetermined` placeholder).
    await waitFor(cdp, `Array.from(document.querySelectorAll('label')).some((l) => (l.textContent||'').trim() === '1 cup = 122 g' && l.querySelector('input[type="radio"]'))`, 20000);
    record('candidate portion shows the semantic label "1 cup = 122 g"', true);
    record('the SR Legacy placeholder "undetermined" is never shown', !(await evaluate(cdp, `document.body.innerText.includes('undetermined')`)));

    // Select the portion explicitly, then calculate explicitly.
    await evaluate(cdp, `(() => {
      const label = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent||'').trim() === '1 cup = 122 g' && l.querySelector('input[type="radio"]'));
      const radio = label && label.querySelector('input[type="radio"]');
      if (!radio) return false;
      radio.click();
      return true;
    })()`);
    // Wait for React to commit the explicit portion selection before calculating.
    await waitFor(cdp, `document.body.innerText.includes('Source portion selected')`, 10000);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Calculate Preview') || (x.textContent||'').includes('Recalculate Preview')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[aria-label="Advisory nutrition preview"]')`, 20000);

    const evidenceText = await evaluate(cdp, `(document.querySelector('[aria-label="Advisory nutrition preview"]')?.innerText || '')`);
    record('calculation produces USDA source-portion evidence', /USDA source portion · FDC 169697/.test(evidenceText), evidenceText.slice(0, 200));
    record('resolved source-portion mass is 122 g', /122 g/.test(evidenceText));
    record('preview is advisory and not medical advice', /not medical advice/i.test(evidenceText));
    // Phase 5B adds an EXPLICIT Apply control; there is still no automatic
    // Save/Persist/Write action.
    record('no automatic Save/Persist control is present', !/\bSave\b|\bPersist\b|\bWrite to Vault\b/i.test(evidenceText));
    record('no codex_nutrition is constructed', !(await evaluate(cdp, `document.body.innerText.includes('codex_nutrition')`)));
    record('the five USDA bundle assets are requested same-origin', bundleAssetRequests.length === 5 && bundleAssetRequests.every((u) => u.startsWith(`http://127.0.0.1:${APP_PORT}/assets/`)));
    record('no external nutrition/USDA/API request occurred', externalNutritionRequests.length === 0, externalNutritionRequests.join(','));

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    try { cdp?.send('Browser.close'); } catch { /* ignore */ }
    server.kill();
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'verification_failed');
  process.exit(1);
});
