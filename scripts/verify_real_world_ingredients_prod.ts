/**
 * The Kitchen Codex — Advanced Nutrition real-world ingredient + manual USDA
 * search + recipe-route production browser acceptance.
 *
 * Dependency-free real-browser acceptance over the real pinned USDA bundle. It
 * builds nothing itself; run `bun run build` first. It starts the compiled
 * production server, drives the built application in real headless Chrome over
 * CDP, and proves:
 *   1. `454 g ground beef (80/20), kept cold and divided into four loose
 *      4-ounce balls` -> MATCHED with the correct 80/20 beef identity and a
 *      direct 454 g mass (no USDA portion);
 *   2. `0.5 tsp coarse black pepper, freshly ground` -> black pepper (no
 *      juice/cabbage candidates);
 *   3. `2 tsp neutral oil` -> a bounded neutral oil (not a flavored oil);
 *   4. `4 burger buns` -> a plain bun/roll (never a composed hamburger);
 *   5. manual USDA search on an already-matched row replaces the food and marks
 *      it user-selected;
 *   6. opening a recipe detail updates the route and a hard refresh restores the
 *      SAME recipe detail (not the gallery).
 *
 * Usage: bun x tsx scripts/verify_real_world_ingredients_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4658);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9368);

const TITLE = 'Real World Acceptance';
const INGREDIENTS = [
  '454 g ground beef (80/20), kept cold and divided into four loose 4-ounce balls',
  '0.5 tsp coarse black pepper, freshly ground',
  '2 tsp neutral oil',
  '4 burger buns',
];

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
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
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

const SET_NATIVE_VALUE = `
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

function rowExpression(ingredientLine: string): string {
  return `(() => {
    const li = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    return li ? (li.innerText || '') : '';
  })()`;
}

async function openRowEdit(cdp: Cdp, ingredientLine: string): Promise<boolean> {
  const opened = await evaluate(cdp, `(() => {
    const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    if (!row) return false;
    const btn = row.querySelector('[data-testid="advanced-nutrition-edit"]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
  })()`);
  await sleep(250);
  return opened === true;
}

async function rowSearch(cdp: Cdp, ingredientLine: string, query: string): Promise<string[]> {
  await openRowEdit(cdp, ingredientLine);
  await evaluate(cdp, `(() => {
    const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    const b = row && row.querySelector('[data-testid="advanced-nutrition-search-usda"]');
    if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    return !!b;
  })()`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-search-input"]')`, 10000);
  await evaluate(cdp, `(() => {
    ${SET_NATIVE_VALUE}
    const input = document.querySelector('[data-testid="advanced-nutrition-search-input"]');
    if (!input) return false;
    setNativeValue(input, ${JSON.stringify(query)});
    return true;
  })()`);
  await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-search-run"]'); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  return (
    (await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('[data-testid^="advanced-nutrition-use-usda-"]')).map((b) => (b.closest('li') || b.parentElement).innerText)`
    )) ?? []
  );
}

async function main(): Promise<void> {
  console.log('Advanced Nutrition real-world ingredient + manual search + route acceptance');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const downloads = mkdtempSync(join(tmpdir(), 'kc-rw-dl-'));
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-rw-'));
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
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    } catch {
      // ignore
    }

    const consoleErrors: string[] = [];
    cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.type === 'error') consoleErrors.push(JSON.stringify(params.args ?? []).slice(0, 200));
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(300);

    // Create the real-world recipe through the genuine public editor.
    await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('New Recipe Note'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(cdp, `!!document.querySelector('input[placeholder="e.g. Sourdough Rosemary Focaccia"]')`, 20000);
    await evaluate(cdp, `(() => {
      ${SET_NATIVE_VALUE}
      const titleInput = document.querySelector('input[placeholder="e.g. Sourdough Rosemary Focaccia"]');
      const servings = document.querySelector('input[placeholder="e.g. 4"]');
      const textareas = Array.from(document.querySelectorAll('textarea'));
      const ingredientsArea = textareas.find((t) => (t.placeholder||'').includes('Olive Oil')) || textareas[0];
      if (!titleInput || !servings || !ingredientsArea) return false;
      setNativeValue(titleInput, ${JSON.stringify(TITLE)});
      setNativeValue(servings, '4');
      setNativeValue(ingredientsArea, ${JSON.stringify(INGREDIENTS.join('\n'))});
      return true;
    })()`);
    await sleep(300);
    await evaluate(cdp, `(() => { const b = document.getElementById('save-recipe-modal-btn'); if (!b) return false; b.click(); return true; })()`);
    await waitFor(cdp, `!document.getElementById('save-recipe-modal-btn')`, 20000);
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(TITLE)})`, 20000);

    await evaluate(cdp, `(() => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify(TITLE)});
      const card = heading && heading.closest('.group');
      const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advanced Nutrition')`, 15000);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Open Advanced Nutrition')); if (b) b.click(); return !!b; })()`);
    const deadline = Date.now() + 120000;
    for (;;) {
      if (await evaluate(cdp, `!!document.querySelector('[role="dialog"]')`)) break;
      if (Date.now() > deadline) throw new Error('advanced dialog timeout');
      await sleep(1000);
    }
    await waitFor(cdp, `document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length >= 4`, 30000);

    // 1. Direct recipe mass + 80/20 identity.
    const beefRow = await evaluate(cdp, rowExpression('ground beef'));
    record('ground beef (80/20) is matched', /matched/i.test(beefRow) && !/needs/i.test(beefRow.split('\n')[0] ?? ''), beefRow.slice(0, 200));
    record('ground beef resolves a direct 454 g mass', /454 g/.test(beefRow), beefRow.slice(0, 200));
    record('ground beef keeps the 80% identity', /80%/.test(beefRow), beefRow.slice(0, 200));

    // 2. Black pepper fidelity.
    const pepperRow = await evaluate(cdp, rowExpression('black pepper'));
    record('coarse black pepper is matched to black pepper', /matched/i.test(pepperRow) && /pepper, black/i.test(pepperRow), pepperRow.slice(0, 200));

    // 3. Neutral oil default.
    const oilRow = await evaluate(cdp, rowExpression('neutral oil'));
    record('neutral oil is matched', /matched/i.test(oilRow), oilRow.slice(0, 200));
    record(
      'neutral oil selects a bounded neutral oil (not flavored)',
      /vegetable oil|canola|soybean|peanut/i.test(oilRow) && !/walnut|coconut|sesame|olive|palm|wheat germ|grapeseed/i.test(oilRow),
      oilRow.slice(0, 200)
    );

    // 4. Plain burger bun.
    const bunRow = await evaluate(cdp, rowExpression('burger buns'));
    record('burger buns is not needs-match', !/needs match/i.test(bunRow), bunRow.slice(0, 200));
    record('burger buns selects a plain roll/bun', /roll|bun/i.test(bunRow), bunRow.slice(0, 200));
    record('burger buns never selects a composed hamburger', !/double hamburger|sandwich|patty/i.test(bunRow), bunRow.slice(0, 200));

    // 5. Manual USDA search on the already-matched black pepper row.
    await openRowEdit(cdp, 'black pepper');
    await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes('black pepper'));
      const b = row && row.querySelector('[data-testid="advanced-nutrition-search-usda"]');
      if (b) b.click();
      return !!b;
    })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-search-input"]')`, 10000);
    await evaluate(cdp, `(() => {
      ${SET_NATIVE_VALUE}
      const input = document.querySelector('[data-testid="advanced-nutrition-search-input"]');
      if (!input) return false;
      setNativeValue(input, 'white pepper');
      return true;
    })()`);
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-search-run"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `Array.from(document.querySelectorAll('button')).some((b) => (b.textContent||'').includes('Use this USDA food'))`, 10000);
    await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Use this USDA food'));
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(400);
    const pepperAfter = await evaluate(cdp, rowExpression('black pepper'));
    record(
      'manual USDA search replaces the food and marks it user-selected',
      /user-selected from USDA search/i.test(pepperAfter) && /pepper/i.test(pepperAfter),
      pepperAfter.slice(0, 220)
    );

    // 5b. TRUE FULL-CATALOG search: find black pepper and a record the automatic
    // bun matcher would never surface (Brioche).
    const pepperResults = await rowSearch(cdp, 'burger buns', 'black pepper');
    record(
      'full-catalog search finds Spices, pepper, black',
      pepperResults.some((line) => /pepper, black/i.test(line)),
      pepperResults.slice(0, 2).join(' || ').slice(0, 200)
    );
    const briocheResults = await rowSearch(cdp, 'burger buns', 'brioche');
    record(
      'full-catalog search finds Brioche even though automatic bun matching would not',
      briocheResults.some((line) => /brioche/i.test(line)),
      briocheResults.slice(0, 2).join(' || ').slice(0, 200)
    );

    // 5c. Direct recipe mass survives a manual food replacement.
    const beefResults = await rowSearch(cdp, 'ground beef', 'ground beef');
    record('full-catalog search finds ground beef records', beefResults.length > 0, `${beefResults.length} results`);
    await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes('ground beef'));
      const buttons = row ? Array.from(row.querySelectorAll('[data-testid^="advanced-nutrition-use-usda-"]')) : [];
      const target = buttons.find((b) => !/80%/.test((b.closest('li') || b.parentElement).innerText));
      if (target) target.click();
      return !!target;
    })()`);
    await sleep(400);
    const beefAfter = await evaluate(cdp, rowExpression('ground beef'));
    record(
      'direct recipe mass survives a manual food replacement',
      /454 g/.test(beefAfter) && /matched/i.test(beefAfter),
      beefAfter.slice(0, 220)
    );

    // 6. Recipe-route hard refresh on a starter recipe detail.
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Close'); if (b) b.click(); return true; })()`);
    await sleep(300);
    // Return to the gallery, then open a starter recipe detail.
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Back to')); if (b) b.click(); return !!b; })()`);
    await sleep(400);
    await evaluate(cdp, `(() => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === 'Skillet Cornmeal Porridge');
      const card = heading && heading.closest('.group');
      const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advanced Nutrition')`, 15000);
    const routeHash = await evaluate(cdp, `window.location.hash`);
    record('opening a recipe updates the browser route', typeof routeHash === 'string' && routeHash.includes('recipe'), String(routeHash));
    await cdp.send('Page.reload', { ignoreCache: false });
    await waitFor(cdp, `!!document.getElementById('back-to-vault-btn')`, 25000);
    const routeHashAfter = await evaluate(cdp, `window.location.hash`);
    const detailVisible = await evaluate(cdp, `!!document.getElementById('back-to-vault-btn')`);
    record('hard refresh restores the same recipe route', routeHashAfter === routeHash, `${routeHash} -> ${routeHashAfter}`);
    record('hard refresh keeps the recipe detail view (not the gallery)', detailVisible === true);

    record('no console error occurred', consoleErrors.length === 0, consoleErrors.join(' | '));
    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    try { cdp?.send('Browser.close'); } catch { /* ignore */ }
    server.kill();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
    try { rmSync(downloads, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : 'verification_failed');
  process.exit(1);
});
