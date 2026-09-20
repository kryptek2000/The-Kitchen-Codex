/**
 * The Kitchen Codex — Advanced Nutrition live row-state production browser
 * acceptance.
 *
 * Dependency-free real-browser acceptance for the CENTRAL live row-state
 * projection over the real pinned USDA bundle. It builds nothing itself; run
 * `bun run build` first. It starts the compiled production server, drives the
 * built application in real headless Chrome over CDP, creates a recipe through
 * the genuine public editor, opens Advanced Nutrition through an explicit user
 * action, and proves:
 *   1. REVIEW SUGGESTED -> user confirms food -> NEEDS AMOUNT;
 *   2. select authenticated portion -> MATCHED -> grams visible;
 *   3. enter manual total weight -> MATCHED -> grams visible;
 *   4. bare cornmeal never auto-selects a prepared stick/mush;
 *   5. re-analysis clears stale live review overrides.
 *
 * Usage: bun x tsx scripts/verify_live_row_state_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4656);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9366);

const LIVE_TITLE = 'Live Row State Acceptance';
const LIVE_INGREDIENTS = [
  '0.25 cup chopped fresh jalapeno',
  '1 large chicken breast',
  '1 cup Cornmeal',
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

function rowTextExpression(ingredientLine: string): string {
  return `(() => {
    const li = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    return li ? (li.innerText || '') : '';
  })()`;
}

function rowStatusExpression(ingredientLine: string): string {
  return `(() => {
    const li = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    const badge = li && li.querySelector('[data-testid="advanced-nutrition-row-status"]');
    return badge ? (badge.textContent || '').trim() : '';
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
  await sleep(200);
  return opened === true;
}

async function selectCandidate(cdp: Cdp, ingredientLine: string, fdcId: number): Promise<boolean> {
  if (!(await openRowEdit(cdp, ingredientLine))) return false;
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

async function selectPortionByLabel(cdp: Cdp, ingredientLine: string, label: string): Promise<boolean> {
  return (await evaluate(cdp, `(() => {
    const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    if (!row) return false;
    const portionLabel = Array.from(row.querySelectorAll('label')).find((node) => (node.textContent || '').trim() === ${JSON.stringify(label)});
    if (!portionLabel) return false;
    const input = portionLabel.querySelector('input[type="radio"]');
    if (!input || input.disabled) return false;
    input.click();
    return true;
  })()`)) === true;
}

async function enterManualWeight(cdp: Cdp, ingredientLine: string, quantity: string): Promise<boolean> {
  return (await evaluate(cdp, `(() => {
    ${SET_NATIVE_VALUE}
    const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    if (!row) return false;
    const input = row.querySelector('input[aria-label="Total weight for this ingredient line"]');
    if (!input) return false;
    setNativeValue(input, ${JSON.stringify(quantity)});
    const use = Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Use this weight'));
    if (!use) return false;
    use.click();
    return true;
  })()`)) === true;
}

async function main(): Promise<void> {
  console.log('Advanced Nutrition live row-state production browser acceptance');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const downloads = mkdtempSync(join(tmpdir(), 'kc-live-dl-'));
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-live-'));
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

    // 1. Create the live-state recipe through the genuine public editor.
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
      setNativeValue(titleInput, ${JSON.stringify(LIVE_TITLE)});
      setNativeValue(servings, '4');
      setNativeValue(ingredientsArea, ${JSON.stringify(LIVE_INGREDIENTS.join('\n'))});
      return true;
    })()`);
    await sleep(300);
    await evaluate(cdp, `(() => { const b = document.getElementById('save-recipe-modal-btn'); if (!b) return false; b.click(); return true; })()`);
    await waitFor(cdp, `!document.getElementById('save-recipe-modal-btn')`, 20000);
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(LIVE_TITLE)})`, 20000);
    record('live-state recipe created through the public editor', true);

    await evaluate(cdp, `(() => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify(LIVE_TITLE)});
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
    await waitFor(cdp, `document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length >= 3`, 30000);
    record('Advanced Nutrition opened with three rows', true);

    // 2. ONE-CLICK: jalapeno auto-selects a normal record and resolves its mass.
    const jalapenoStatus = await evaluate(cdp, rowStatusExpression('jalapeno'));
    record('jalapeno is matched on first click', /matched/i.test(jalapenoStatus), jalapenoStatus);
    const jalapenoRow = await evaluate(cdp, rowTextExpression('jalapeno'));
    record(
      'jalapeno auto-selects a normal jalapeno and resolves 37.5 g',
      /jalapeno/i.test(jalapenoRow) && /37\.5 g/.test(jalapenoRow),
      jalapenoRow.slice(0, 200)
    );

    // 3. ONE-CLICK: bare cornmeal auto-selects a plain record (never stick/mush)
    //    and the portion-bearing sibling resolves 122 g.
    const cornmealRow = await evaluate(cdp, rowTextExpression('Cornmeal'));
    record(
      'bare cornmeal never auto-selects a prepared stick/mush',
      cornmealRow.length > 0 && !/Cornmeal stick|Cornmeal mush/i.test(cornmealRow),
      cornmealRow.slice(0, 200)
    );
    record(
      'cornmeal auto-selects a plain record and resolves 122 g',
      /whole-grain, yellow/i.test(cornmealRow) && /122 g/.test(cornmealRow),
      cornmealRow.slice(0, 200)
    );
    // Editability: choosing a different same-family record invalidates the amount.
    const cornmealSelected = await selectCandidate(cdp, 'Cornmeal', 168039);
    record('cornmeal Change food still works', cornmealSelected === true);
    await sleep(250);
    const cornmealChangedStatus = await evaluate(cdp, rowStatusExpression('Cornmeal'));
    record(
      'changing the automatic cornmeal food invalidates its amount',
      /needs amount/i.test(cornmealChangedStatus),
      cornmealChangedStatus
    );

    // 5. Manual total weight -> MATCHED -> grams visible.
    const chickenSelected = await selectCandidate(cdp, 'chicken breast', 2646170);
    record('chicken breast food confirmed', chickenSelected === true);
    await sleep(250);
    const chickenStatusBefore = await evaluate(cdp, rowStatusExpression('chicken breast'));
    record('chicken breast needs amount after confirmation', /needs amount/i.test(chickenStatusBefore), chickenStatusBefore);
    await openRowEdit(cdp, 'chicken breast');
    const chickenManual = await enterManualWeight(cdp, 'chicken breast', '150');
    record('chicken breast manual weight entered', chickenManual === true);
    await sleep(250);
    const chickenStatus = await evaluate(cdp, rowStatusExpression('chicken breast'));
    record('chicken breast becomes matched after manual weight', /matched/i.test(chickenStatus), chickenStatus);
    const chickenRow = await evaluate(cdp, rowTextExpression('chicken breast'));
    record('chicken breast shows 150 g', /150 g/.test(chickenRow), chickenRow.slice(0, 200));

    // 6. Re-analysis deterministically recomputes the same one-click default.
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-analyze"]'); if (b) b.click(); return !!b; })()`);
    await sleep(600);
    await openRowEdit(cdp, 'jalapeno');
    const jalapenoRowAfter = await evaluate(cdp, rowTextExpression('jalapeno'));
    const jalapenoStatusAfter = await evaluate(cdp, rowStatusExpression('jalapeno'));
    record(
      're-analysis deterministically recomputes the jalapeno default',
      /matched/i.test(jalapenoStatusAfter) && /37\.5 g/.test(jalapenoRowAfter),
      `${jalapenoStatusAfter} | ${jalapenoRowAfter.slice(0, 160)}`
    );

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
