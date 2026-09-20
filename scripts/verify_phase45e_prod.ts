/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5E: production browser
 * acceptance.
 *
 * Dependency-free real-browser acceptance for authenticated count-portion
 * resolution. It builds nothing itself; run `bun run build` first. It starts the
 * compiled production server, drives the built application in real headless
 * Chrome over CDP, creates the exact hamburger recipe through the genuine public
 * recipe editor, opens Advanced Nutrition through an explicit user action,
 * authenticates the fixed five-asset USDA bundle, selects the reviewed foods, and
 * proves the derived count mass and the honest unresolved cases.
 *
 * Usage: bun x tsx scripts/verify_phase45e_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4653);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9363);

const HAMBURGER_TITLE = 'Hamburger Acceptance 45E';
const HAMBURGER_INGREDIENTS = [
  '1 pound ground beef (80/20), formed into 4 patties',
  '1 teaspoon kosher salt',
  '0.5 teaspoon ground black pepper',
  '8 slices bacon',
  '4 slices cheddar cheese',
  '4 burger buns',
  '1 cup shredded lettuce',
  '2 medium tomatoes, sliced',
  '4 pickles, sliced',
  '2 tablespoons mayonnaise',
  '1 tablespoon ketchup',
];

const CHAIN_PATTERN = /McDonald|Burger King|Wendy|KFC|Taco Bell|Pizza Hut|Domino|Subway|Chick-fil|Popeyes|Arby|Little Caesars|Papa John|Cracker Barrel|Olive Garden|Carrabba|Applebee|Denny/i;

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

const SET_NATIVE_VALUE = `
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

/**
 * Post-Phase-5 remediation: detailed candidate/portion tools are compact by
 * default and live behind each row's Edit control. This opens the row's Edit
 * expansion, then selects the requested candidate radio.
 */
async function selectCandidate(cdp: Cdp, ingredientLine: string, fdcId: number): Promise<boolean> {
  const opened = await evaluate(cdp, `(() => {
    const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    if (!row) return false;
    const btn = row.querySelector('[data-testid="advanced-nutrition-edit"]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
  })()`);
  if (opened !== true) return false;
  await sleep(200);
  // The candidate list is collapsed behind the explicit Change food control
  // whenever a food is already resolved (auto-suggested OR user-selected). Each
  // attempt either expands it (async React render) or selects the target radio.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result: string = await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
      if (!row) return 'no-row';
      const label = Array.from(row.querySelectorAll('label')).find((node) => (node.innerText || '').includes('FDC ${fdcId}'));
      if (label) {
        const input = label.querySelector('input[type="radio"]');
        if (!input) return 'no-input';
        input.click();
        return 'ok';
      }
      const change = row.querySelector('[data-testid="advanced-nutrition-change-food"]');
      if (change) {
        change.click();
        return 'expanding';
      }
      return 'no-label';
    })()`);
    if (result === 'ok') return true;
    await sleep(200);
  }
  return false;
}

function rowTextExpression(ingredientLine: string): string {
  return `(() => {
    const li = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    return li ? (li.innerText || '') : '';
  })()`;
}

async function main(): Promise<void> {
  console.log('Phase 4.5E production browser acceptance (authenticated count portions)');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const downloads = mkdtempSync(join(tmpdir(), 'kc-phase45e-dl-'));
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-phase45e-'));
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
      // Older Chrome: downloads may be blocked; the editor save still resolves.
    }

    const externalNutritionRequests: string[] = [];
    const bundleAssetRequests: string[] = [];
    const consoleErrors: string[] = [];
    const networkFailures: string[] = [];
    cdp.on('Network.loadingFailed', (params: any) => {
      networkFailures.push(`${params.errorText || 'failed'} ${params.type || ''}`.slice(0, 120));
    });
    cdp.on('Network.requestWillBeSent', (params: any) => {
      const url = String(params.request.url);
      if (/\/assets\/(artifact-|manifest-|records\.)/.test(url)) bundleAssetRequests.push(url);
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url).origin === `http://127.0.0.1:${APP_PORT}`;
      } catch {
        sameOrigin = url.startsWith('data:') || url.startsWith('blob:');
      }
      if (!sameOrigin && /usda|fdc|openfoodfacts|api\.data\.gov|\/api\//i.test(url)) {
        externalNutritionRequests.push(url);
      }
    });
    cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.type === 'error') consoleErrors.push(JSON.stringify(params.args ?? []).slice(0, 200));
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(300);

    // 1. Create the exact hamburger recipe through the genuine public editor.
    await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('New Recipe Note'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(cdp, `!!document.querySelector('input[placeholder="e.g. Sourdough Rosemary Focaccia"]')`, 20000);

    await evaluate(cdp, `(() => {
      ${SET_NATIVE_VALUE}
      const title = document.querySelector('input[placeholder="e.g. Sourdough Rosemary Focaccia"]');
      const servings = document.querySelector('input[placeholder="e.g. 4"]');
      const textareas = Array.from(document.querySelectorAll('textarea'));
      const ingredients = textareas.find((t) => (t.placeholder||'').includes('Olive Oil')) || textareas[0];
      if (!title || !servings || !ingredients) return false;
      setNativeValue(title, ${JSON.stringify(HAMBURGER_TITLE)});
      setNativeValue(servings, '4');
      setNativeValue(ingredients, ${JSON.stringify(HAMBURGER_INGREDIENTS.join('\n'))});
      return true;
    })()`);
    await sleep(300);

    await evaluate(cdp, `(() => {
      const b = document.getElementById('save-recipe-modal-btn');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(cdp, `!document.getElementById('save-recipe-modal-btn')`, 20000);
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(HAMBURGER_TITLE)})`, 20000);
    record('hamburger recipe created through the public editor', true);

    // 2. Open the recipe detail, then Advanced Nutrition (explicit user action).
    await evaluate(cdp, `(() => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify(HAMBURGER_TITLE)});
      const card = heading && heading.closest('.group');
      const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advanced Nutrition')`, 15000);
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]') || Array.from(document.querySelectorAll('button')).find((x) => /Open (Saved )?Advanced (Report|Nutrition)|Generate Nutrition/.test((x.textContent||''))); if (b) b.click(); return !!b; })()`);
    let dialogOpened = false;
    const dialogDeadline = Date.now() + 120000;
    while (Date.now() < dialogDeadline) {
      if (await evaluate(cdp, `!!document.querySelector('[role="dialog"]')`)) {
        dialogOpened = true;
        break;
      }
      await sleep(1000);
    }
    if (!dialogOpened) {
      const cardText = await evaluate(cdp, `(document.getElementById('advanced-nutrition-card')?.innerText || '').slice(0, 300)`);
      throw new Error(
        `dialog timeout; card=${JSON.stringify(cardText)}; failures=${JSON.stringify(networkFailures.slice(0, 3))}`
      );
    }
    await waitFor(cdp, `document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length >= 11`, 30000);
    record('Advanced Nutrition opened and all eleven ingredient sections rendered', true);

    const initialText: string = await evaluate(cdp, `(document.querySelector('[role="dialog"]')?.innerText || '')`);
    record('no `slice s` is presented', !/slice s\b/.test(initialText));
    record('no `tablespoon s` is presented', !/tablespoon s\b/.test(initialText));
    record('original ingredient lines remain human-readable', HAMBURGER_INGREDIENTS.every((line) => initialText.includes(line)));

    // 3. Select the reviewed foods for the count ingredients.
    const selections: ReadonlyArray<[string, number]> = [
      ['8 slices bacon', 168277],
      ['4 slices cheddar cheese', 328637],
      ['4 burger buns', 2707657],
      ['2 medium tomatoes, sliced', 2709719],
      ['4 pickles, sliced', 2710078],
    ];
    // Only one row's detailed tools are expanded at a time, so each row's text
    // is captured immediately after its selection.
    const rowTexts: Record<string, string> = {};
    for (const [line, fdcId] of selections) {
      const ok = await selectCandidate(cdp, line, fdcId);
      record(`selected USDA food FDC ${fdcId} for "${line}"`, ok === true);
      await sleep(250);
      rowTexts[line] = await evaluate(cdp, rowTextExpression(line));
    }

    const baconRow = rowTexts['8 slices bacon'] ?? '';
    record(
      'bacon shows the deterministic count derivation (8 slices × 28 g per slice = 224 g)',
      /8 slices × 28 g per slice = 224 g/.test(baconRow),
      baconRow.slice(0, 240)
    );
    const cheddarRow = rowTexts['4 slices cheddar cheese'] ?? '';
    record(
      'cheddar shows the deterministic count derivation (4 slices × 17 g per slice = 68 g)',
      /4 slices × 17 g per slice = 68 g/.test(cheddarRow),
      cheddarRow.slice(0, 240)
    );
    const bunRow = rowTexts['4 burger buns'] ?? '';
    record(
      'burger buns show the deterministic count derivation (4 buns × 52 g per bun = 208 g)',
      /4 buns × 52 g per bun = 208 g/.test(bunRow),
      bunRow.slice(0, 240)
    );
    const tomatoRow = rowTexts['2 medium tomatoes, sliced'] ?? '';
    record(
      'tomatoes honestly report no compatible authenticated count portion',
      /No compatible authenticated count portion/.test(tomatoRow),
      tomatoRow.slice(0, 240)
    );
    const pickleRow = rowTexts['4 pickles, sliced'] ?? '';
    record(
      'pickles honestly report no compatible authenticated count portion',
      /No compatible authenticated count portion/.test(pickleRow),
      pickleRow.slice(0, 240)
    );

    // 4. Calculate the advisory preview (explicit user action).
    await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Calculate Preview') || (x.textContent||'').includes('Recalculate Preview'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);
    const dialogText: string = await evaluate(cdp, `(document.querySelector('[role="dialog"]')?.innerText || '')`);
    const evidenceText: string = await evaluate(cdp, `(() => {
      const node = Array.from(document.querySelectorAll('h4')).find((h) => (h.textContent||'').trim() === 'Ingredient evidence');
      return node ? (node.parentElement?.innerText || '') : '';
    })()`);

    record('the preview is labelled as an advisory preview', /Advisory nutrition preview/.test(dialogText));
    record('bacon evidence is an authenticated USDA count portion', /8 slices bacon.*USDA count portion/s.test(evidenceText), evidenceText.slice(0, 300));
    record('bacon derivation shows 224 g', /8 slices × 28 g per slice = 224 g/.test(evidenceText), evidenceText.slice(0, 300));
    record('cheddar derivation shows 68 g', /4 slices × 17 g per slice = 68 g/.test(evidenceText), evidenceText.slice(0, 300));
    record('burger buns derivation shows 208 g', /4 buns × 52 g per bun = 208 g/.test(evidenceText), evidenceText.slice(0, 300));
    record('tomatoes remain unresolved (no invented mass)', !/2 medium tomatoes.*USDA count portion/s.test(evidenceText));
    record('pickles remain unresolved (no invented mass)', !/4 pickles.*USDA count portion/s.test(evidenceText));

    // 5. Irrelevant examples absent.
    record('no `without salt` filler is presented', !/without salt/i.test(dialogText));
    record('no shredded non-lettuce food is presented for lettuce', !/Parmesan/i.test(dialogText));
    record('no unrelated salad/pie filler is presented for mayonnaise', !/Tuna salad|Egg salad|Potato salad|Pie/i.test(dialogText));

    // 6. No restaurant-chain candidate anywhere.
    record('no restaurant-chain candidate appears anywhere', !CHAIN_PATTERN.test(dialogText));

    // 7. Phase 5B adds an EXPLICIT Apply control; there is still no automatic
    // Save/Persist/Write action, and no write occurs without an explicit click.
    record(
      'an explicit Apply control exists with no automatic Save/Persist action',
      /\bApply\b/i.test(dialogText) && !/\bSave\b|\bPersist\b|Write to Vault/i.test(dialogText)
    );
    record('no codex_nutrition is constructed', !(await evaluate(cdp, `document.body.innerText.includes('codex_nutrition')`)));

    // 8. No external request; fixed same-origin bundle assets.
    record('the five USDA bundle assets are requested same-origin', bundleAssetRequests.length === 5 && bundleAssetRequests.every((u) => u.startsWith(`http://127.0.0.1:${APP_PORT}/assets/`)), bundleAssetRequests.join(','));
    record('no external nutrition/USDA/API request occurred', externalNutritionRequests.length === 0, externalNutritionRequests.join(','));
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
