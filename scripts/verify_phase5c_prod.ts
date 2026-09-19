/**
 * The Kitchen Codex — Advanced Nutrition Phase 5C: consolidated Nutrition UI.
 *
 * Dependency-free real-browser acceptance for the consolidated Nutrition
 * surface. It builds nothing itself; run `bun run build` first. It starts the
 * compiled production server, pre-seeds a synthetic File System Access vault with
 * legacy / Advanced / conflicting / stale / unsupported recipes, drives the built
 * application in real headless Chrome over CDP, and proves the precedence rules:
 *
 *   A. legacy-only            -> legacy fallback, no write on view
 *   B. valid Advanced + legacy -> Advanced primary, conflicting legacy ignored
 *   C. stale Advanced + legacy -> stale Advanced primary, no legacy substitution
 *   D. unknown future schema   -> unsupported notice + labelled legacy fallback
 *   E. explicit Apply          -> consolidated surface switches to saved Advanced
 *
 * Usage: bun x tsx scripts/verify_phase5c_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown } from '../src/utils/markdownParser';
import { adaptRecipe } from '../src/core/nutritionV2/phase4/adapt';
import { decodeCodexNutrition, validateCodexNutritionV1 } from '../src/core/nutritionV2/validate';
import { DV_STANDARD_ID } from '../src/core/nutritionV2/dailyValues';
import type { CodexNutritionV1 } from '../src/core/nutritionV2/schema';
import type { ObsidianRecipe } from '../src/types';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4655);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9365);

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

// ---------------------------------------------------------------------------
// Fixtures (generated in Node, serialized with the production serializer)
// ---------------------------------------------------------------------------

function baseRecipe(title: string, overrides: Partial<ObsidianRecipe> = {}): ObsidianRecipe {
  return {
    id: title.toLowerCase().replace(/\s+/g, '-'),
    fileName: `${title}.md`,
    filePath: `${title}.md`,
    rawMarkdown: '',
    title,
    tags: ['food/recipes'],
    category: 'Dinner',
    cuisine: 'Test',
    difficulty: 'Easy',
    rating: 4,
    servings: 4,
    ingredients: [
      { original: '100 g Flour, wheat, white', amount: 100, unit: 'g', name: 'Flour, wheat, white' },
    ] as never,
    instructions: [{ stepNumber: 1, text: 'Bake.' }],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    frontmatter: {},
    ...overrides,
  } as ObsidianRecipe;
}

function advancedBlockFor(target: ObsidianRecipe, overrides: Partial<CodexNutritionV1> = {}): CodexNutritionV1 {
  const adaptation = adaptRecipe(target);
  const lineRefs = adaptation.ok ? adaptation.recipe.adapted.map((entry) => entry.line_ref) : ['ing:0:x'];
  return {
    schema: 1,
    basis: 'total',
    servings: adaptation.ok ? adaptation.recipe.base_servings : 4,
    status: 'partial',
    computed_at: '2026-09-14T00:00:00.000Z',
    ingredient_digest: `sha256:${'a'.repeat(64)}`,
    dv_standard: DV_STANDARD_ID,
    sources: ['usda_fdc'],
    source_releases: { usda_fdc: 'r' },
    nutrient_scope: ['calories'],
    nutrients: {
      calories: {
        amount: 364,
        unit: 'kcal',
        status: 'partial',
        coverage: 0.5,
        covered_ingredient_count: 1,
        measurable_ingredient_count: 2,
      },
    },
    ingredients: lineRefs.map((line_ref) => ({
      line_ref,
      source: 'usda_fdc' as const,
      source_food_id: '6001',
      source_release: 'r',
      match_status: 'confirmed' as const,
      resolved: true,
      user_confirmed: true,
    })),
    unresolved: [],
    ...overrides,
  };
}

function seedVaultFiles(): Record<string, string> {
  const files: Record<string, string> = {};

  // A. Legacy-only.
  files['Legacy Only.md'] = serializeRecipeToObsidianMarkdown(
    baseRecipe('Legacy Only', {
      nutrition: { calories: 9999, protein: 12, servings: 4 } as never,
      calories: '9999',
    })
  );

  // B. Conflicting: valid Advanced + strongly different legacy.
  const conflictBase = baseRecipe('Conflict Recipe');
  const conflictBlock = advancedBlockFor(conflictBase);
  files['Conflict Recipe.md'] = serializeRecipeToObsidianMarkdown(
    baseRecipe('Conflict Recipe', {
      nutrition: { calories: 9999, protein: 1, servings: 4 } as never,
      calories: '9999',
      codexNutrition: conflictBlock as never,
    })
  );

  // C. Stale: saved block for 2 servings, recipe now 4 servings.
  const staleBase = baseRecipe('Stale Recipe', { servings: 2 });
  const staleBlock = advancedBlockFor(staleBase, { servings: 2 });
  files['Stale Recipe.md'] = serializeRecipeToObsidianMarkdown(
    baseRecipe('Stale Recipe', {
      servings: 4,
      nutrition: { calories: 100, servings: 4 } as never,
      codexNutrition: staleBlock as never,
    })
  );

  // D. Unknown future schema + legacy.
  files['Unsupported Recipe.md'] = serializeRecipeToObsidianMarkdown(
    baseRecipe('Unsupported Recipe', {
      nutrition: { calories: 100, servings: 4 } as never,
      frontmatter: { codex_nutrition: { schema: 2, basis: 'total', futureField: true } },
    })
  );

  // G. Recognized Advanced block WITHOUT a calories nutrient + conflicting legacy.
  const noCalBase = baseRecipe('No Calories Recipe');
  const noCalBlock = { ...advancedBlockFor(noCalBase), status: 'partial' as const, nutrients: {} };
  files['No Calories Recipe.md'] = serializeRecipeToObsidianMarkdown(
    baseRecipe('No Calories Recipe', {
      nutrition: { calories: 9999, protein: 1, servings: 4 } as never,
      calories: '9999',
      codexNutrition: noCalBlock as never,
    })
  );

  return files;
}

const SYNTHETIC_VAULT = (seedJson: string) => `(() => {
  window.__kcVaultStore = ${seedJson};
  const files = window.__kcVaultStore;
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
    for (const n of Object.keys(files)) local.set(n, fileHandle(n));
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

const OPEN_DETAIL = (title: string) => `(() => {
  const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify(title)});
  const card = heading && heading.closest('.group');
  const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
  if (!button) return false;
  button.click();
  return true;
})()`;

const HEADER_CALORIES = `(() => {
  const label = Array.from(document.querySelectorAll('span')).find((s) => (s.textContent||'').trim() === 'Calories');
  const value = label && label.parentElement ? (label.parentElement.querySelector('.text-sm')?.textContent || '') : '';
  return value.trim();
})()`;

const SET_NATIVE_VALUE = `
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

const HAMBURGER_TITLE = 'Hamburger Acceptance 5C';
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

function selectCandidateExpression(ingredientLine: string, fdcId: number): string {
  return `(() => {
    const li = Array.from(document.querySelectorAll('[aria-label="Ingredient matching review"] li')).find((node) => (node.innerText || '').includes(${JSON.stringify(ingredientLine)}));
    if (!li) return false;
    const label = Array.from(li.querySelectorAll('label')).find((node) => (node.innerText || '').includes('FDC ${fdcId}'));
    if (!label) return false;
    const input = label.querySelector('input[type="radio"]');
    if (!input) return false;
    input.click();
    return true;
  })()`;
}

async function main(): Promise<void> {
  console.log('Phase 5C production browser consolidation acceptance');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const seedJson = JSON.stringify(seedVaultFiles());
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-phase5c-'));
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

    // Connect the pre-seeded synthetic vault through the public UI.
    await evaluate(cdp, SYNTHETIC_VAULT(seedJson));
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Connect Vault'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('#connect-vault-modal-card')`, 15000);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('#connect-vault-modal-card button')).find((x) => (x.textContent||'').includes('Live Directory Sync')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!Array.from(document.querySelectorAll('#connect-vault-modal-card button')).find((x) => (x.textContent||'').includes('Choose Local Obsidian Vault Folder'))`, 10000);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('#connect-vault-modal-card button')).find((x) => (x.textContent||'').includes('Choose Local Obsidian Vault Folder')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `(document.querySelector('#connect-vault-modal-card')?.innerText || '').includes('Connected')`, 20000);
    await evaluate(cdp, `(() => { const card = document.querySelector('#connect-vault-modal-card'); const b = card && Array.from(card.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === ''); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.querySelector('#connect-vault-modal-card')`, 10000);
    record('pre-seeded synthetic vault connected through the public UI', true);

    const beforeView = JSON.stringify(await evaluate(cdp, `window.__kcVaultStore`));


    // A. Legacy-only recipe.
    await evaluate(cdp, OPEN_DETAIL('Legacy Only'));
    await waitFor(cdp, `!!document.getElementById('recipe-nutrition-section')`, 15000);
    record('A. legacy-only: legacy Nutrition & Macros fallback shown', await evaluate(cdp, `!!document.getElementById('recipe-nutrition-card')`));
    record('A. legacy-only: Advanced does not present a competing nutrition table', !(await evaluate(cdp, `document.getElementById('advanced-nutrition-card')?.innerText.includes('Advisory nutrition preview')`)));
    record('A. legacy-only: header calories use legacy', (await evaluate(cdp, HEADER_CALORIES)).startsWith('9999'));
    await evaluate(cdp, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('back-to-vault-btn')`, 10000);
    await sleep(200);

    // B. Conflicting: Advanced + legacy.
    await evaluate(cdp, OPEN_DETAIL('Conflict Recipe'));
    await waitFor(cdp, `!!document.getElementById('recipe-nutrition-section')`, 15000);
    record('B. conflict: Advanced surface is primary', await evaluate(cdp, `!!document.getElementById('advanced-nutrition-card')`));
    record('B. conflict: legacy surface is not a competing peer', !(await evaluate(cdp, `!!document.getElementById('recipe-nutrition-card')`)));
    const conflictCalories = await evaluate(cdp, HEADER_CALORIES);
    record('B. conflict: header calories use Advanced (364), not legacy (9999)', conflictCalories.startsWith('364'), conflictCalories);
    await evaluate(cdp, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('back-to-vault-btn')`, 10000);
    await sleep(200);

    // C. Stale: saved block for 2 servings, recipe 4.
    await evaluate(cdp, OPEN_DETAIL('Stale Recipe'));
    await waitFor(cdp, `!!document.getElementById('recipe-nutrition-section')`, 15000);
    record('C. stale: stale notice shown', /may be out of date/i.test(await evaluate(cdp, `document.getElementById('recipe-nutrition-section').innerText`)));
    record('C. stale: Advanced remains primary', await evaluate(cdp, `!!document.getElementById('advanced-nutrition-card')`));
    record('C. stale: legacy does not silently replace Advanced', !(await evaluate(cdp, `!!document.getElementById('recipe-nutrition-card')`)));
    await evaluate(cdp, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('back-to-vault-btn')`, 10000);
    await sleep(200);

    // D. Unknown future schema.
    await evaluate(cdp, OPEN_DETAIL('Unsupported Recipe'));
    await waitFor(cdp, `!!document.getElementById('recipe-nutrition-section')`, 15000);
    const unsupportedText = await evaluate(cdp, `document.getElementById('recipe-nutrition-section').innerText`);
    record('D. unsupported: newer-format notice shown', /newer format/i.test(unsupportedText));
    record('D. unsupported: labelled legacy fallback shown', /Legacy estimate/i.test(unsupportedText));
    await evaluate(cdp, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('back-to-vault-btn')`, 10000);
    await sleep(200);

    // G. Recognized Advanced WITHOUT a calories nutrient + conflicting legacy.
    await evaluate(cdp, OPEN_DETAIL('No Calories Recipe'));
    await waitFor(cdp, `!!document.getElementById('recipe-nutrition-section')`, 15000);
    record('G. no-Advanced-calories: Advanced remains primary', await evaluate(cdp, `!!document.getElementById('advanced-nutrition-card')`));
    record('G. no-Advanced-calories: legacy is not a competing peer', !(await evaluate(cdp, `!!document.getElementById('recipe-nutrition-card')`)));
    const noCalHeader = String(await evaluate(cdp, HEADER_CALORIES));
    record('G. no-Advanced-calories: header does not fall back to legacy 9999', !noCalHeader.includes('9999'), noCalHeader);
    const noCalSection = String(await evaluate(cdp, `document.getElementById('recipe-nutrition-section').innerText`));
    record('G. no-Advanced-calories: legacy 9999 is not presented as primary', !noCalSection.includes('9999'));
    await evaluate(cdp, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('back-to-vault-btn')`, 10000);
    await sleep(200);

    // E. No nutrition write merely from viewing/toggling.
    const afterView = JSON.stringify(await evaluate(cdp, `window.__kcVaultStore`));
    record('E. viewing/toggling nutrition wrote nothing', afterView === beforeView);

    // F. Explicit Apply: create the hamburger, review, Apply, and verify the
    // consolidated surface becomes Advanced-primary with a partial saved result.
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('New Recipe Note')); if (b) b.click(); return !!b; })()`);
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
    await evaluate(cdp, `(() => { const b = document.getElementById('save-recipe-modal-btn'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!document.getElementById('save-recipe-modal-btn')`, 20000);
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(HAMBURGER_TITLE)})`, 20000);

    await evaluate(cdp, OPEN_DETAIL(HAMBURGER_TITLE));
    await waitFor(cdp, `!!document.getElementById('back-to-vault-btn')`, 15000);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Open Advanced Nutrition')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[role="dialog"]')`, 120000);
    await waitFor(cdp, `document.querySelectorAll('[aria-label="Ingredient matching review"] li').length >= 11`, 30000);
    const hamburgerSelections: ReadonlyArray<[string, number]> = [
      ['8 slices bacon', 168277],
      ['4 slices cheddar cheese', 328637],
      ['4 burger buns', 2707657],
      ['2 medium tomatoes, sliced', 2709719],
      ['4 pickles, sliced', 2710078],
    ];
    for (const [line, fdcId] of hamburgerSelections) {
      await evaluate(cdp, selectCandidateExpression(line, fdcId));
      await sleep(150);
    }
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Calculate Preview')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);
    record('F. advanced recipe: reviewed before Apply', true);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').includes('Apply to recipe')); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('will add a saved Advanced Nutrition block')`, 15000);
    await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Confirm Apply'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advanced Nutrition was saved to your recipe')`, 30000);
    record('F. advanced recipe: explicit Apply succeeded', true);

    const hamburgerMd = String((await evaluate(cdp, `window.__kcVaultStore[${JSON.stringify(HAMBURGER_TITLE + '.md')}]`)) || '');
    record('F. advanced recipe: persisted Markdown has exactly one codex_nutrition block', (hamburgerMd.match(/codex_nutrition/g) || []).length === 1);
    const parsedHamburger = parseObsidianRecipeMarkdown(hamburgerMd, `${HAMBURGER_TITLE}.md`, `${HAMBURGER_TITLE}.md`);
    const decodedHamburger = decodeCodexNutrition(parsedHamburger.codexNutrition);
    record('F. advanced recipe: persisted block is canonical schema v1', decodedHamburger.kind === 'v1');
    if (decodedHamburger.kind === 'v1') {
      record('F. advanced recipe: persisted block validates', validateCodexNutritionV1(decodedHamburger.value).ok === true);
      record('F. advanced recipe: partial status persisted', decodedHamburger.value.status === 'partial');
      const bacon = decodedHamburger.value.ingredients.find((entry) => entry.source_food_id === '168277');
      record('F. advanced recipe: bacon 224 g persisted', bacon?.amount?.value === 224);
      record('F. advanced recipe: tomatoes/pickles persisted unresolved', decodedHamburger.value.unresolved.length >= 2);
    }

    // Close the review dialog and verify the consolidated surface is Advanced-primary.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, 10000);
    await waitFor(cdp, `!!document.getElementById('recipe-nutrition-section')`, 10000);
    record('F. advanced recipe: consolidated surface is Advanced-primary', await evaluate(cdp, `!!document.getElementById('advanced-nutrition-card')`));
    record('F. advanced recipe: legacy surface not a competing peer', !(await evaluate(cdp, `!!document.getElementById('recipe-nutrition-card')`)));
    record('F. advanced recipe: saved Advanced summary shown', /Saved Advanced Nutrition/i.test(await evaluate(cdp, `document.getElementById('advanced-nutrition-card').innerText`)));

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
