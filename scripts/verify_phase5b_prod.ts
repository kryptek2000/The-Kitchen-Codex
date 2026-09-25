/**
 * The Kitchen Codex — Advanced Nutrition Phase 5B: production browser Apply.
 *
 * Dependency-free real-browser acceptance for the explicit Apply write. It builds
 * nothing itself; run `bun run build` first. It starts the compiled production
 * server, drives the built application in real headless Chrome over CDP, connects
 * a synthetic File System Access vault (headless directory picking is not
 * automatable), creates the exact hamburger recipe through the public editor,
 * establishes reviewed Advanced Nutrition, and then:
 *   - proves nothing is written before an explicit Apply;
 *   - proves a match mutation invalidates eligibility and writes nothing;
 *   - explicitly Applies and proves exactly one canonical `codex_nutrition`
 *     block is written to the vault;
 *   - re-parses the persisted Markdown and proves unrelated content survived.
 *
 * Usage: bun x tsx scripts/verify_phase5b_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseObsidianRecipeMarkdown } from '../src/utils/markdownParser';
import { decodeCodexNutrition, validateCodexNutrition } from '../src/core/nutritionV2/validate';
import type { CodexNutritionV1, CodexNutritionV2 } from '../src/core/nutritionV2/schema';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4654);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9364);

const HAMBURGER_TITLE = 'Hamburger Acceptance 5B';
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

const SYNTHETIC_VAULT = `(() => {
  window.__kcVaultFiles = {};
  const files = window.__kcVaultFiles;
  function fileHandle(name) {
    return {
      kind: 'file',
      name,
      async getFile() { return { text: async () => (name in files ? files[name] : '') }; },
      async createWritable() {
        let buf = '';
        return {
          async write(data) { buf += typeof data === 'string' ? data : ''; },
          async close() { files[name] = buf; },
          async abort() {},
        };
      },
    };
  }
  function dirHandle(name) {
    const local = new Map();
    return {
      kind: 'directory',
      name,
      async *values() { for (const f of local.values()) yield f; },
      async getFileHandle(n, opts) {
        if (!local.has(n)) {
          if (!opts || !opts.create) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
          local.set(n, fileHandle(n));
        }
        return local.get(n);
      },
      async getDirectoryHandle(n, opts) {
        if (!opts || !opts.create) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
        return dirHandle(n);
      },
      async removeEntry(n) { local.delete(n); },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
    };
  }
  window.__kcVault = dirHandle('SyntheticVault');
  window.showDirectoryPicker = async () => window.__kcVault;
  return true;
})()`;

/** Opens a row's compact Edit expansion (detailed tools are hidden by default). */
async function openRowEdit(cdp: Cdp, ingredientLine: string): Promise<boolean> {
  const opened = await evaluate(cdp, `(() => {
    const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    if (!row) return false;
    const btn = row.querySelector('[data-testid="advanced-nutrition-edit"]');
    if (!btn) return false;
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
  })()`);
  if (opened !== true) return false;
  await sleep(150);
  return true;
}

async function selectCandidate(cdp: Cdp, ingredientLine: string, fdcId: number): Promise<boolean> {
  if (!(await openRowEdit(cdp, ingredientLine))) return false;
  await sleep(200);
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

async function selectOtherCandidate(cdp: Cdp, ingredientLine: string): Promise<boolean> {
  if (!(await openRowEdit(cdp, ingredientLine))) return false;
  await sleep(200);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result: string = await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
      if (!row) return 'no-row';
      // Only FOOD candidates (labels annotated with an FDC id) are authority
      // mutations; portion radios must never be mistaken for a match change.
      const inputs = Array.from(row.querySelectorAll('label'))
        .filter((label) => (label.innerText || '').includes('FDC '))
        .map((label) => label.querySelector('input[type="radio"]'))
        .filter((input) => input !== null);
      if (inputs.length === 0) {
        const change = row.querySelector('[data-testid="advanced-nutrition-change-food"]');
        if (change) {
          change.click();
          return 'expanding';
        }
        return 'no-inputs';
      }
      const checked = inputs.find((i) => i.checked);
      const target = inputs.find((i) => i !== checked);
      if (!target) return 'no-target';
      target.click();
      return 'ok';
    })()`);
    if (result === 'ok') return true;
    await sleep(200);
  }
  return false;
}

async function main(): Promise<void> {
  console.log('Phase 5B production browser Apply acceptance');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-phase5b-'));
  const chrome = spawn(
    CHROME,
    [
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
    ],
    { stdio: 'ignore' }
  );

  let cdp: Cdp | null = null;
  try {
    await waitForHttp(`http://127.0.0.1:${APP_PORT}/api/health`);
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const target = await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })
    ).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolveOpen, reject) => {
      ws.addEventListener('open', () => resolveOpen(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws_error')), { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const consoleErrors: string[] = [];
    cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.type === 'error') consoleErrors.push(JSON.stringify(params.args ?? []).slice(0, 200));
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(300);

    // 1. Install the synthetic vault + connect it through the public UI.
    await evaluate(cdp, SYNTHETIC_VAULT);
    await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Connect Vault');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(cdp, `!!document.querySelector('#connect-vault-modal-card')`, 15000);
    await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('#connect-vault-modal-card button')).find((x) => (x.textContent||'').includes('Live Directory Sync'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(cdp, `!!Array.from(document.querySelectorAll('#connect-vault-modal-card button')).find((x) => (x.textContent||'').includes('Choose Local Obsidian Vault Folder'))`, 10000);
    await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('#connect-vault-modal-card button')).find((x) => (x.textContent||'').includes('Choose Local Obsidian Vault Folder'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await waitFor(cdp, `(document.querySelector('#connect-vault-modal-card')?.innerText || '').includes('Connected')`, 20000);
    await evaluate(cdp, `(() => {
      const card = document.querySelector('#connect-vault-modal-card');
      const b = card && Array.from(card.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '');
      if (b) b.click();
      return !!b;
    })()`);
    await waitFor(cdp, `!document.querySelector('#connect-vault-modal-card')`, 10000);
    record('synthetic vault connected through the public UI', true);

    // 2. Create the exact hamburger recipe through the genuine public editor.
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
    await evaluate(cdp, `(() => { const b = document.getElementById('save-recipe-modal-btn'); if (!b) return false; b.click(); return true; })()`);
    await waitFor(cdp, `!document.getElementById('save-recipe-modal-btn')`, 20000);
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(HAMBURGER_TITLE)})`, 20000);
    record('hamburger recipe created through the public editor and written to the vault', true);

    const storedFiles: Record<string, string> = await evaluate(cdp, `window.__kcVaultFiles`);
    const storedNames = Object.keys(storedFiles);
    record('the recipe Markdown exists in the vault before Apply', storedNames.some((n) => storedFiles[n].includes(HAMBURGER_TITLE)));
    record(
      'no codex_nutrition exists before Apply',
      storedNames.every((n) => !storedFiles[n].includes('codex_nutrition'))
    );

    // 3. Open the recipe detail, then Advanced Nutrition (explicit user action).
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
    if (!dialogOpened) throw new Error('Advanced Nutrition dialog did not open');
    await waitFor(cdp, `document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length >= 11`, 30000);
    record('Advanced Nutrition opened and all eleven ingredient sections rendered', true);

    const selections: ReadonlyArray<[string, number]> = [
      ['8 slices bacon', 168277],
      ['4 slices cheddar cheese', 328637],
      ['4 burger buns', 2707657],
      ['2 medium tomatoes, sliced', 2709719],
      ['4 pickles, sliced', 2710078],
    ];
    for (const [line, fdcId] of selections) {
      const ok = await selectCandidate(cdp, line, fdcId);
      record(`selected USDA food FDC ${fdcId} for "${line}"`, ok === true);
      await sleep(200);
    }

    // 4. Calculate the advisory preview (explicit user action).
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Calculate Preview') || (x.textContent||'').includes('Recalculate Preview')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);

    const applyButtonEnabled = await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Apply to recipe'));
      return !!b && !b.disabled;
    })()`);
    record('Apply is enabled for the eligible reviewed result', applyButtonEnabled === true);

    const noWriteAfterCalculate: Record<string, string> = await evaluate(cdp, `window.__kcVaultFiles`);
    record(
      'no write occurs merely by calculating',
      Object.keys(noWriteAfterCalculate).every((n) => !noWriteAfterCalculate[n].includes('codex_nutrition'))
    );

    // 5. TOCTOU: mutate an authority dependency (change a selected match) after
    //    eligibility, and prove Apply disables and nothing is written.
    const mutated = await selectOtherCandidate(cdp, '1 cup shredded lettuce');
    record('a match mutation is applied to an unresolved row', mutated === true);
    await sleep(300);
    const applyDisabledAfterMutation = await evaluate(cdp, `(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Apply to recipe'));
      return !!b && b.disabled;
    })()`);
    record('Apply is disabled after an authority mutation', applyDisabledAfterMutation === true);
    const afterMutation: Record<string, string> = await evaluate(cdp, `window.__kcVaultFiles`);
    record(
      'no write occurs after an authority mutation',
      Object.keys(afterMutation).every((n) => !afterMutation[n].includes('codex_nutrition'))
    );

    // Re-select the original match and recalculate to restore eligibility.
    await selectCandidate(cdp, '1 cup shredded lettuce', 2709789);
    await sleep(200);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Calculate Preview') || (x.textContent||'').includes('Recalculate Preview')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);

    // 6. Explicit Apply with confirmation.
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Apply to recipe')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('will add a saved Advanced Nutrition block')`, 15000);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Confirm Apply'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advanced Nutrition was saved to your recipe')`, 30000);
    record('explicit Apply reported success', true);

    // 7. Exactly one canonical block is written; unrelated content survives.
    const afterApply: Record<string, string> = await evaluate(cdp, `window.__kcVaultFiles`);
    const recipeNames = Object.keys(afterApply).filter((n) => afterApply[n].includes(HAMBURGER_TITLE));
    record('exactly one recipe file was written', recipeNames.length === 1);
    const persisted = recipeNames.length > 0 ? afterApply[recipeNames[0]] : '';
    const occurrences = (persisted.match(/codex_nutrition/g) || []).length;
    record('exactly one codex_nutrition block is present', occurrences === 1, `count=${occurrences}`);

    let decodedBlock: CodexNutritionV1 | CodexNutritionV2 | null = null;
    if (persisted) {
      const parsed = parseObsidianRecipeMarkdown(persisted, recipeNames[0], recipeNames[0]);
      const decoded = decodeCodexNutrition(parsed.codexNutrition);
      if (decoded.kind === 'v1' || decoded.kind === 'v2') decodedBlock = decoded.value;
      // Phase 6: the hamburger scenario includes tomatoes, whose verified
      // household portion makes the whole block canonical schema v2. Both
      // recognized versions are accepted and validated under their own contract.
      record(
        'the persisted block re-parses as a recognized canonical schema (v1/v2)',
        decoded.kind === 'v1' || decoded.kind === 'v2'
      );
      record(
        'the persisted block validates under its own version',
        (decoded.kind === 'v1' || decoded.kind === 'v2') &&
          validateCodexNutrition(decoded.value).ok === true
      );
      record('unrelated title survives', persisted.includes(`# ${HAMBURGER_TITLE}`));
      record('unrelated ingredient lines survive', persisted.includes(HAMBURGER_INGREDIENTS[0]));
    }

    if (decodedBlock) {
      const byLine = decodedBlock.ingredients;
      const bacon = byLine.find((entry) => entry.source_food_id === '168277');
      const cheddar = byLine.find((entry) => entry.source_food_id === '328637');
      const buns = byLine.find((entry) => entry.source_food_id === '2707657');
      record('bacon 224 g persisted', bacon?.amount?.value === 224);
      record('cheddar 68 g persisted', cheddar?.amount?.value === 68);
      record('buns 208 g persisted', buns?.amount?.value === 208);
      record('tomatoes/pickles persisted as unresolved', decodedBlock.unresolved.length >= 2);
      record('the block is totals-only (basis=total)', decodedBlock.basis === 'total');
    }

    record('no console error occurred', consoleErrors.length === 0, consoleErrors.join(' | '));

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    try {
      cdp?.send('Browser.close');
    } catch {
      /* ignore */
    }
    server.kill();
    chrome.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : 'verification_failed');
  process.exit(1);
});
