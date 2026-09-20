/**
 * The Kitchen Codex — Advanced Nutrition one-click completeness production
 * browser acceptance.
 *
 * Dependency-free real-browser acceptance (run `bun run build` first). It drives
 * the built application in real headless Chrome over CDP and proves the
 * one-click policy end-to-end against the pinned USDA bundle:
 *
 *   A. `2.5 cups all-purpose flour` auto-selects a portion-bearing all-purpose
 *      record and resolves its authenticated mass (312.5 g), MATCHED.
 *   B. `2 tsp baking powder` auto-selects and resolves its authenticated mass.
 *   C. `2 large eggs` auto-selects the whole/raw baseline and resolves the
 *      authenticated count mass.
 *   E. a single fully-resolved recipe: Analyze -> MATCHED -> Preview COMPLETE ->
 *      Apply -> Saved COMPLETE -> compact nutrition visible -> no partial warning
 *      -> no duplicate identical unsaved review.
 *   F. a recipe with one unresolvable amount remains correctly PARTIAL.
 *
 * Usage: bun x tsx scripts/verify_one_click_completeness_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4657);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9367);

const COMPLETE_TITLE = 'One Click Complete Acceptance';
const COMPLETE_INGREDIENTS = [
  '2.5 cups all-purpose flour',
  '2 tsp baking powder',
  '2 large eggs',
];
const PARTIAL_TITLE = 'One Click Partial Acceptance';
const PARTIAL_INGREDIENTS = [...COMPLETE_INGREDIENTS, '0.5 cup unsalted butter'];

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

async function createRecipe(cdp: Cdp, title: string, ingredients: ReadonlyArray<string>): Promise<void> {
  await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('New Recipe Note')); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `!!document.querySelector('input[placeholder="e.g. Sourdough Rosemary Focaccia"]')`, 20000);
  await evaluate(cdp, `(() => {
    ${SET_NATIVE_VALUE}
    const titleInput = document.querySelector('input[placeholder="e.g. Sourdough Rosemary Focaccia"]');
    const servings = document.querySelector('input[placeholder="e.g. 4"]');
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const ingredientsArea = textareas.find((t) => (t.placeholder||'').includes('Olive Oil')) || textareas[0];
    if (!titleInput || !servings || !ingredientsArea) return false;
    setNativeValue(titleInput, ${JSON.stringify(title)});
    setNativeValue(servings, '4');
    setNativeValue(ingredientsArea, ${JSON.stringify(ingredients.join('\n'))});
    return true;
  })()`);
  await sleep(300);
  await evaluate(cdp, `(() => { const b = document.getElementById('save-recipe-modal-btn'); if (!b) return false; b.click(); return true; })()`);
  await waitFor(cdp, `!document.getElementById('save-recipe-modal-btn')`, 20000);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(title)})`, 20000);
  await evaluate(cdp, `(() => {
    const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify(title)});
    const card = heading && heading.closest('.group');
    const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await waitFor(cdp, `document.body.innerText.includes('Advanced Nutrition')`, 15000);
}

async function openAdvancedAndAnalyze(cdp: Cdp, expectedRows: number): Promise<void> {
  await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]') || Array.from(document.querySelectorAll('button')).find((x) => /Open (Saved )?Advanced (Report|Nutrition)|Generate Nutrition/.test((x.textContent||''))); if (b) b.click(); return !!b; })()`);
  const deadline = Date.now() + 120000;
  for (;;) {
    if (await evaluate(cdp, `!!document.querySelector('[role="dialog"]')`)) break;
    if (Date.now() > deadline) throw new Error('advanced dialog timeout');
    await sleep(1000);
  }
  await waitFor(cdp, `document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length >= ${expectedRows}`, 30000);
  // One-click analyze.
  await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-analyze"]'); if (b) b.click(); return !!b; })()`);
  await sleep(500);
}

async function calculate(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /Calculate Preview|Recalculate Preview/.test(x.textContent||'')); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);
}

async function apply(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Apply to recipe')); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `document.body.innerText.includes('will add a saved Advanced Nutrition block')`, 15000);
  await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Confirm Apply'); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `document.body.innerText.includes('was saved to your recipe')`, 30000);
  await evaluate(cdp, `(() => { const b = document.querySelector('[aria-label="Close Advanced Nutrition"]'); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, 15000);
}

/** Opens the SAVED REPORT and then explicitly enters the working editor. */
async function openWorkingEditor(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]'); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="saved-advanced-status"]')`, 15000);
  await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="saved-advanced-edit"]'); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-analyze"]')`, 120000);
}

/** Applies a REPLACE (a saved block already exists). */
async function applyReplace(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Apply and replace saved nutrition')); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `document.body.innerText.includes('will replace the existing saved Advanced Nutrition block')`, 15000);
  await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Confirm Apply'); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `document.body.innerText.includes('was replaced and saved to your recipe')`, 30000);
  await evaluate(cdp, `(() => { const b = document.querySelector('[aria-label="Close Advanced Nutrition"]'); if (b) b.click(); return !!b; })()`);
  await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, 15000);
}

/** Expands one Advanced Nutrition ingredient row for editing. */
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

/**
 * Searches the full USDA catalog inside one row and selects a result. When
 * `requireUnusablePortion` is set, only a result whose text says it has no usable
 * authenticated portion is chosen (guaranteeing the mass stays unresolved).
 */
async function manualSelectFood(
  cdp: Cdp,
  ingredientLine: string,
  query: string,
  requireUnusablePortion = false
): Promise<string> {
  await openRowEdit(cdp, ingredientLine);
  await evaluate(cdp, `(() => {
    const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText||'').includes(${JSON.stringify(ingredientLine)}));
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
  await waitFor(cdp, `Array.from(document.querySelectorAll('[data-testid^="advanced-nutrition-use-usda-"]')).length > 0`, 120000);
  const picked = await evaluate(cdp, `(() => {
    const requireUnusable = ${requireUnusablePortion ? 'true' : 'false'};
    const buttons = Array.from(document.querySelectorAll('[data-testid^="advanced-nutrition-use-usda-"]'));
    const target = buttons.find((b) => {
      const li = b.closest('li') || b.parentElement;
      const text = li ? (li.innerText||'') : '';
      if (!requireUnusable) return true;
      return /no usable amount|no authenticated portion/i.test(text);
    });
    if (!target) return '';
    const li = target.closest('li') || target.parentElement;
    const text = li ? (li.innerText||'') : '';
    target.click();
    return text;
  })()`);
  await sleep(400);
  return String(picked || '');
}

/** Enters an explicit total weight for one ingredient row. */
async function enterManualWeight(cdp: Cdp, ingredientLine: string, quantity: string): Promise<boolean> {  return (await evaluate(cdp, `(() => {
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
  console.log('Advanced Nutrition one-click completeness production browser acceptance');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const downloads = mkdtempSync(join(tmpdir(), 'kc-oneclick-dl-'));
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-oneclick-'));
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

    const consoleErrors: string[] = [];
    cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.type === 'error') consoleErrors.push(JSON.stringify(params.args ?? []).slice(0, 200));
    });

    // --- Phase 1: COMPLETE one-click recipe (A, B, C, E). ---
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(300);
    await createRecipe(cdp, COMPLETE_TITLE, COMPLETE_INGREDIENTS);
    await openAdvancedAndAnalyze(cdp, COMPLETE_INGREDIENTS.length);

    const flourStatus = await evaluate(cdp, rowStatusExpression('all-purpose flour'));
    const flourRow = await evaluate(cdp, rowTextExpression('all-purpose flour'));
    record('A. 2.5 cups all-purpose flour is MATCHED', /matched/i.test(flourStatus), flourStatus);
    record('A. flour resolves the authenticated 312.5 g mass', /312\.5 g/.test(flourRow), flourRow.slice(0, 180));

    const bpStatus = await evaluate(cdp, rowStatusExpression('baking powder'));
    const bpRow = await evaluate(cdp, rowTextExpression('baking powder'));
    record('B. 2 tsp baking powder is MATCHED', /matched/i.test(bpStatus), bpStatus);
    record('B. baking powder resolves an authenticated mass', /\d+(\.\d+)? g/.test(bpRow), bpRow.slice(0, 180));

    const eggStatus = await evaluate(cdp, rowStatusExpression('eggs'));
    const eggRow = await evaluate(cdp, rowTextExpression('eggs'));
    record('C. 2 large eggs is MATCHED', /matched/i.test(eggStatus), eggStatus);
    record('C. eggs resolve to a whole/raw baseline count mass', /egg, whole, raw/i.test(eggRow) && /\d+(\.\d+)? g/.test(eggRow), eggRow.slice(0, 180));

    await calculate(cdp);
    const dialogText = await evaluate(cdp, `(document.querySelector('[role="dialog"]')?.innerText || '')`);
    record('E. preview is COMPLETE with zero unresolved lines', /Status: complete/.test(dialogText) && /0 of 3 ingredient lines unresolved/.test(dialogText));
    await apply(cdp);

    record('E. saved block is COMPLETE', await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-saved-complete"]')`));
    record('E. compact Nutrition & Macros is visible', await evaluate(cdp, `!!document.getElementById('recipe-nutrition-card')`));
    record('E. no incomplete warning on the compact card', !(await evaluate(cdp, `!!document.querySelector('[data-testid="nutrition-advanced-incomplete"]')`)));
    record('E. no duplicate identical unsaved review panel', !(await evaluate(cdp, `document.body.innerText.includes('Unsaved review — not applied')`)));

    // E2. CURRENT-RECIPE-SCALE compact presentation + saved report renders
    // without the analyzer. The saved report opens immediately from the persisted
    // block; the working analyzer text ("eligible home-recipe records") must be
    // absent. At base == current servings the compact card shows the base totals.
    const compactText = String(await evaluate(cdp, `document.getElementById('recipe-nutrition-card')?.innerText || ''`));
    record('E. compact card presents CURRENT-RECIPE-SCALE values', /current recipe: 4 servings/i.test(compactText), compactText.slice(0, 160));
    const openedSaved = await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]'); if (b) b.click(); return !!b; })()`);
    record('E. saved report opener available after Apply', openedSaved === true);
    await waitFor(cdp, `!!document.querySelector('[data-testid="saved-advanced-status"]')`, 15000);
    const savedReportText = String(
      await evaluate(
        cdp,
        `document.querySelector('[data-testid="saved-advanced-status"]')?.closest('[role="dialog"]')?.innerText || ''`
      )
    );
    record('E. saved report renders WITHOUT analyzer initialization', !/eligible home-recipe records/i.test(savedReportText));
    record('E. saved report shows Complete ingredient coverage', /Complete ingredient coverage/i.test(savedReportText));
    const entireCal = await evaluate(cdp, `(() => {
      const dialog = document.querySelector('[data-testid="saved-advanced-status"]')?.closest('[role="dialog"]');
      const m = dialog ? (dialog.innerText || '').match(/calories\\s*([0-9]+(?:\\.[0-9]+)?)/i) : null;
      return m ? Number(m[1]) : null;
    })()`);
    const compactCal = await evaluate(cdp, `(() => {
      const el = document.getElementById('recipe-nutrition-card');
      const m = el ? (el.innerText || '').match(/calories\\s*([0-9]+(?:\\.[0-9]+)?)/i) : null;
      return m ? Number(m[1]) : null;
    })()`);
    record(
      'E. compact calories equal the current-recipe totals (base scale)',
      typeof entireCal === 'number' && typeof compactCal === 'number' && Math.abs(compactCal - entireCal) < 1,
      `entire=${entireCal} compact=${compactCal}`
    );

    // E3. SERVING SCALE: the compact card and the recipe header follow the CURRENT
    // recipe scale (canonical base totals × current / saved base). Every value is
    // derived from the canonical base, so there is no cumulative drift.
    const readScale = async () => ({
      header: await evaluate(cdp, `(() => {
        const label = Array.from(document.querySelectorAll('span')).find((s) => (s.textContent||'').trim().startsWith('Calories'));
        const value = label && label.parentElement ? (label.parentElement.querySelector('.text-sm')?.textContent||'') : '';
        const m = value.match(/([0-9]+(?:\\.[0-9]+)?)/);
        return m ? Number(m[1]) : null;
      })()`),
      compact: await evaluate(cdp, `(() => {
        const el = document.getElementById('recipe-nutrition-card');
        const m = el ? (el.innerText || '').match(/calories\\s*([0-9]+(?:\\.[0-9]+)?)/i) : null;
        return m ? Number(m[1]) : null;
      })()`),
      macros: await evaluate(cdp, `(() => {
        const el = document.getElementById('recipe-nutrition-card');
        const m = el ? (el.innerText || '').match(/Protein (\\d+)%[\\s\\S]*?Carbs (\\d+)%[\\s\\S]*?Fat (\\d+)%/) : null;
        return m ? m[1] + '/' + m[2] + '/' + m[3] : '';
      })()`),
      ingredients: await evaluate(cdp, `(() => {
        const ul = Array.from(document.querySelectorAll('ul')).find((node) => /all-purpose flour/i.test(node.innerText || ''));
        return ul ? ul.innerText : '';
      })()`),
    });
    const baseScale = await readScale();
    // 4 -> 2
    await evaluate(cdp, `(() => { const b = document.getElementById('decrease-servings-btn'); b.click(); b.click(); return true; })()`);
    await sleep(300);
    const halfScale = await readScale();
    // 2 -> 8
    for (let i = 0; i < 6; i += 1) await evaluate(cdp, `document.getElementById('increase-servings-btn').click()`);
    await sleep(300);
    const doubleScale = await readScale();
    // 8 -> 4 (return to base)
    for (let i = 0; i < 4; i += 1) await evaluate(cdp, `document.getElementById('decrease-servings-btn').click()`);
    await sleep(300);
    const backScale = await readScale();

    record(
      'E. serving scale: half compact = 0.5x base',
      typeof halfScale.compact === 'number' && typeof baseScale.compact === 'number' && Math.abs(halfScale.compact - baseScale.compact / 2) < 1,
      `${baseScale.compact} -> ${halfScale.compact}`
    );
    record(
      'E. serving scale: double compact = 2x base',
      typeof doubleScale.compact === 'number' && typeof baseScale.compact === 'number' && Math.abs(doubleScale.compact - baseScale.compact * 2) < 1,
      `${baseScale.compact} -> ${doubleScale.compact}`
    );
    record(
      'E. serving scale: return to base is exact (no drift)',
      typeof backScale.compact === 'number' && typeof baseScale.compact === 'number' && Math.abs(backScale.compact - baseScale.compact) < 1,
      `${baseScale.compact} -> ${backScale.compact}`
    );
    record(
      'E. serving scale: header tracks the same basis',
      typeof halfScale.header === 'number' && typeof doubleScale.header === 'number' && typeof baseScale.header === 'number'
        && Math.abs(halfScale.header - baseScale.header / 2) < 1
        && Math.abs(doubleScale.header - baseScale.header * 2) < 1,
      `${baseScale.header}/${halfScale.header}/${doubleScale.header}`
    );
    record(
      'E. serving scale: macro percentages invariant',
      baseScale.macros.length > 0 && baseScale.macros === halfScale.macros && baseScale.macros === doubleScale.macros,
      `${baseScale.macros} | ${halfScale.macros} | ${doubleScale.macros}`
    );
    record(
      'E. serving scale: ingredient quantities scale with servings',
      halfScale.ingredients !== baseScale.ingredients && doubleScale.ingredients !== baseScale.ingredients,
      'ingredient list changed with servings'
    );

    // E4. POST-APPLY LIVE SYNC: applying a DIFFERENT working result (B) over the
    // saved result (A) immediately replaces A on every surface, with no reload.
    const aCal = baseScale.compact;
    const aHeader = baseScale.header;
    await openWorkingEditor(cdp);
    const flourOpened = await openRowEdit(cdp, 'all-purpose flour');
    record('E. replace: working flour row editable', flourOpened === true);
    const weightSet = await enterManualWeight(cdp, 'all-purpose flour', '400');
    record('E. replace: working manual weight applied', weightSet === true);
    await calculate(cdp);
    await applyReplace(cdp);
    await waitFor(cdp, `!!document.getElementById('recipe-nutrition-card')`, 10000);
    const bCal = await evaluate(cdp, `(() => {
      const el = document.getElementById('recipe-nutrition-card');
      const m = el ? (el.innerText || '').match(/calories\\s*([0-9]+(?:\\.[0-9]+)?)/i) : null;
      return m ? Number(m[1]) : null;
    })()`);
    const bHeader = await evaluate(cdp, `(() => {
      const label = Array.from(document.querySelectorAll('span')).find((s) => (s.textContent||'').trim().startsWith('Calories'));
      const value = label && label.parentElement ? (label.parentElement.querySelector('.text-sm')?.textContent||'') : '';
      const m = value.match(/([0-9]+(?:\\.[0-9]+)?)/);
      return m ? Number(m[1]) : null;
    })()`);
    record(
      'E. replace: saved/compact result immediately changed (no reload)',
      typeof bCal === 'number' && bCal !== aCal,
      `${aCal} -> ${bCal}`
    );
    record(
      'E. replace: header immediately updated',
      typeof bHeader === 'number' && typeof aHeader === 'number' && bHeader !== aHeader,
      `${aHeader} -> ${bHeader}`
    );
    const sectionText = String(await evaluate(cdp, `document.getElementById('recipe-nutrition-section')?.innerText || ''`));
    record('E. replace: the OLD saved value is gone from every surface', !sectionText.includes(String(aCal)), `old=${aCal}`);
    record(
      'E. replace: saved card still reports Complete coverage',
      /Complete ingredient coverage|Complete coverage/i.test(String(await evaluate(cdp, `document.getElementById('advanced-nutrition-card')?.innerText || ''`)))
    );
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="saved-advanced-status"]')`, 15000);
    const reportCal = await evaluate(cdp, `(() => {
      const dialog = document.querySelector('[data-testid="saved-advanced-status"]')?.closest('[role="dialog"]');
      const m = dialog ? (dialog.innerText || '').match(/calories\\s*([0-9]+(?:\\.[0-9]+)?)/i) : null;
      return m ? Number(m[1]) : null;
    })()`);
    record(
      'E. replace: Open Saved Advanced Report shows B',
      typeof reportCal === 'number' && typeof bCal === 'number' && Math.abs(reportCal - bCal) < 1,
      `report=${reportCal} compact=${bCal}`
    );
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Close'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, 10000);

    // E5. MANUAL REVIEW PERSISTENCE: leave the recipe and re-enter it (SPA
    // remount), then Edit / Re-analyze. The explicitly reviewed manual choice and
    // the user-entered 400 g must restore; Re-analyze must not discard them.
    await evaluate(cdp, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('back-to-vault-btn')`, 10000);
    await sleep(200);
    await evaluate(cdp, `(() => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify(COMPLETE_TITLE)});
      const card = heading && heading.closest('.group');
      const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, `!!document.getElementById('back-to-vault-btn')`, 15000);
    const remountCal = await evaluate(cdp, `(() => {
      const el = document.getElementById('recipe-nutrition-card');
      const m = el ? (el.innerText || '').match(/calories\\s*([0-9]+(?:\\.[0-9]+)?)/i) : null;
      return m ? Number(m[1]) : null;
    })()`);
    record(
      'E. manual persistence: saved result survives recipe re-entry',
      typeof remountCal === 'number' && typeof bCal === 'number' && Math.abs(remountCal - bCal) < 1,
      `${bCal} -> ${remountCal}`
    );
    await openWorkingEditor(cdp);
    await openRowEdit(cdp, 'all-purpose flour');
    const flourBefore = await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText || '').includes('all-purpose flour'));
      return row ? row.innerText : '';
    })()`);
    record(
      'E. manual persistence: reviewed 400 g + user-confirmed food restored on reopen',
      /400 g/.test(flourBefore) && /Matched/i.test(flourBefore),
      flourBefore.slice(0, 200)
    );
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-analyze"]'); if (b) b.click(); return !!b; })()`);
    await sleep(700);
    const flourAfter = await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText || '').includes('all-purpose flour'));
      return row ? row.innerText : '';
    })()`);
    record(
      'E. manual persistence: Re-analyze preserves the reviewed 400 g (never NEEDS MATCH/AMOUNT)',
      /400 g/.test(flourAfter) && /Matched/i.test(flourAfter),
      flourAfter.slice(0, 200)
    );
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-close-without-saving"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, 10000);

    // --- Phase 2: PARTIAL recipe (D, F). Reload resets the synthetic vault. ---
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(300);
    await createRecipe(cdp, PARTIAL_TITLE, PARTIAL_INGREDIENTS);
    await openAdvancedAndAnalyze(cdp, PARTIAL_INGREDIENTS.length);

    const butterRow = await evaluate(cdp, rowTextExpression('unsalted butter'));
    const butterStatus = await evaluate(cdp, rowStatusExpression('unsalted butter'));
    record('D. unsalted butter auto-selects a safe unsalted-butter identity', /unsalted butter/i.test(butterRow), butterRow.slice(0, 180));
    record('D. unsalted butter is never a wrong food or review', /matched|needs amount/i.test(butterStatus) && !/needs match|review suggested/i.test(butterStatus), butterStatus);

    await calculate(cdp);
    const partialDialogText = await evaluate(cdp, `(document.querySelector('[role="dialog"]')?.innerText || '')`);
    record('F. preview remains PARTIAL with unresolved lines', /Status: partial/.test(partialDialogText));
    await apply(cdp);
    record('F. saved block is PARTIAL', await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-saved-partial"]')`));
    record('F. compact card shows the incomplete state', await evaluate(cdp, `!!document.querySelector('[data-testid="nutrition-advanced-incomplete"]')`));
    const partialCompact = String(await evaluate(cdp, `document.getElementById('recipe-nutrition-card')?.innerText || ''`));
    record(
      'F. partial compact card shows calculated partial values with a partial label',
      /Partial estimate/i.test(partialCompact) && /kcal/i.test(partialCompact) && /ingredient line/i.test(partialCompact),
      partialCompact.slice(0, 240)
    );

    // --- G. FOOD-CONFIRMED / MASS-UNRESOLVED persistence ---------------------
    // A user-confirmed USDA food must survive Apply + reopen even when its mass
    // is still unresolved; food identity and mass resolution are independent.
    const IDENTITY_TITLE = 'Food Identity Browser';
    const IDENTITY_INGREDIENTS = ['1 cup broccoli florets', '2 g garlic, minced'];
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(300);
    await createRecipe(cdp, IDENTITY_TITLE, IDENTITY_INGREDIENTS);
    await openAdvancedAndAnalyze(cdp, IDENTITY_INGREDIENTS.length);

    const broccoliPick = await manualSelectFood(cdp, 'broccoli', 'broccoli', true);
    record(
      'G. food identity: selected a USDA food with no usable authenticated portion',
      broccoliPick.length > 0,
      broccoliPick.slice(0, 160)
    );
    const broccoliStatusBefore = await evaluate(cdp, rowStatusExpression('broccoli'));
    record(
      'G. food identity: confirmed food + unresolved mass shows NEEDS AMOUNT (not NEEDS MATCH)',
      /needs amount/i.test(broccoliStatusBefore),
      broccoliStatusBefore
    );

    const garlicPick = await manualSelectFood(cdp, 'garlic', 'garlic, raw', false);
    record('G. food identity: garlic control selected', garlicPick.length > 0, garlicPick.slice(0, 160));
    const garlicStatusBefore = await evaluate(cdp, rowStatusExpression('garlic'));
    record('G. food identity: garlic direct 2 g resolves MATCHED', /matched/i.test(garlicStatusBefore), garlicStatusBefore);

    await calculate(cdp);
    await apply(cdp);
    record(
      'G. food identity: partial saved block (food confirmed, mass unresolved)',
      await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-saved-partial"]')`)
    );

    // Leave and re-enter the recipe (remount) to force hydration from the saved block.
    await evaluate(cdp, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('back-to-vault-btn')`, 10000);
    await sleep(200);
    await evaluate(cdp, `(() => {
      const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify('Food Identity Browser')});
      const card = heading && heading.closest('.group');
      const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, `!!document.getElementById('back-to-vault-btn')`, 15000);
    await openWorkingEditor(cdp);
    await openRowEdit(cdp, 'broccoli');
    const broccoliReopen = await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText||'').includes('broccoli'));
      return row ? row.innerText : '';
    })()`);
    record(
      'G. food identity: same USDA food restored on reopen (never NEEDS MATCH)',
      /broccoli/i.test(broccoliReopen) && !/needs match/i.test(broccoliReopen),
      broccoliReopen.slice(0, 220)
    );
    const broccoliStatusReopen = await evaluate(cdp, rowStatusExpression('broccoli'));
    record('G. food identity: restored row remains NEEDS AMOUNT', /needs amount/i.test(broccoliStatusReopen), broccoliStatusReopen);
    const garlicStatusReopen = await evaluate(cdp, rowStatusExpression('garlic'));
    record('G. food identity: garlic control still MATCHED after reopen', /matched/i.test(garlicStatusReopen), garlicStatusReopen);

    // Resolve the mass, re-Apply, and confirm it persists.
    const weightAdded = await enterManualWeight(cdp, 'broccoli', '400');
    record('G. food identity: manual 400 g entered for the restored food', weightAdded === true);
    await calculate(cdp);
    await applyReplace(cdp);
    await openWorkingEditor(cdp);
    await openRowEdit(cdp, 'broccoli');
    const broccoliFinal = await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText||'').includes('broccoli'));
      return row ? row.innerText : '';
    })()`);
    record(
      'G. food identity: resolved food + 400 g restore MATCHED after re-Apply',
      /broccoli/i.test(broccoliFinal) && /400 g/.test(broccoliFinal) && /matched/i.test(broccoliFinal),
      broccoliFinal.slice(0, 220)
    );
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-close-without-saving"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, 10000);

    record('no console error occurred', consoleErrors.length === 0, consoleErrors.join(' | '));
    console.log(`\n${passed} passed, ${failed} failed`);  } finally {
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
