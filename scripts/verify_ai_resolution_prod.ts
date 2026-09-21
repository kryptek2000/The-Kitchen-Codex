/**
 * The Kitchen Codex — Advanced Nutrition AI-assisted USDA resolution
 * production browser acceptance.
 *
 * Drives the built application in real headless Chrome over CDP. The EXTERNAL AI
 * provider boundary is mocked at the app->server endpoint with CDP Fetch
 * interception (a canned advisory response); the pinned USDA catalog, the
 * deterministic matcher, the calculation, and the UI are the REAL ones.
 *
 * Proves:
 *   1. Generate Nutrition opens the deterministic working review (no AI call);
 *   2. an unresolved row shows NEEDS MATCH and the AI panel;
 *   3. Resolve with AI turns the advisory phrase into a genuine pinned-USDA
 *      candidate (never NEEDS MATCH again), with NO mass invented;
 *   4. the AI-unavailable path degrades to manual USDA search with a bounded
 *      message.
 *
 * Usage: bun x tsx scripts/verify_ai_resolution_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4659);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9369);

const TITLE = 'AI Resolution Acceptance';
const INGREDIENTS = ['1 cup Zzz', '100 g Flour, wheat, white'];

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
  await evaluate(cdp, `(() => { const b = document.getElementById('save-recipe-modal-btn'); if (b) b.click(); return !!b; })()`);
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

async function main(): Promise<void> {
  console.log('Advanced Nutrition AI-assisted USDA resolution production acceptance');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const downloads = mkdtempSync(join(tmpdir(), 'kc-ai-dl-'));
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-ai-'));
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

    // Mock ONLY the external AI boundary: intercept the app->server resolver
    // endpoint and fulfill it locally. The USDA catalog/calculation/UI stay real.
    let aiMode: 'suggest' | 'unavailable' = 'suggest';
    let aiRequestCount = 0;
    let holdMode = false;
    let held: { requestId: string; lines: ReadonlyArray<ResolveLine> } | null = null;

    interface ResolveLine {
      readonly line_ref?: string;
      readonly ingredient_text?: string;
      readonly amount?: number;
      readonly issue_kind?: string;
    }

    const suggestionFor = (line: ResolveLine): Record<string, unknown> => {
      const text = String(line.ingredient_text ?? '').toLowerCase();
      const base = { line_ref: line.line_ref };
      if (/garlic/.test(text)) {
        return {
          ...base,
          interpreted_food_name: 'Garlic, raw',
          suggested_usda_queries: ['garlic raw'],
          quantity_value: line.amount,
          quantity_unit_hint: 'cloves',
          count_descriptor_hint: 'clove',
          portion_search_hint: 'clove',
          explanation: 'Three cloves, minced.',
        };
      }
      if (/onion/.test(text)) {
        return {
          ...base,
          interpreted_food_name: 'Onions, yellow, raw',
          suggested_usda_queries: ['onions yellow raw'],
          quantity_value: line.amount,
          quantity_unit_hint: 'onion',
          count_descriptor_hint: 'onion',
          portion_search_hint: 'onion',
        };
      }
      if (/zucchini/.test(text)) {
        return {
          ...base,
          interpreted_food_name: 'Zucchini',
          suggested_usda_queries: ['zucchini raw'],
        };
      }
      if (/vegetable broth/.test(text)) {
        return {
          ...base,
          interpreted_food_name: 'Vegetable broth',
          suggested_usda_queries: ['vegetable broth', 'vegetable stock'],
        };
      }
      return {
        ...base,
        interpreted_food_name: 'Broccoli, raw',
        suggested_usda_queries: ['broccoli raw'],
        notes: 'The recipe wording refers to raw broccoli.',
        confidence: 'high',
      };
    };

    const fulfillSuggestion = async (
      requestId: string,
      lines: ReadonlyArray<ResolveLine>
    ) => {
      const payload = {
        ok: true,
        version: 'nutrition_ai_resolution_v1',
        suggestions: lines.map((line) => suggestionFor(line)),
      };
      await cdp!.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      });
    };

    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*resolve-ingredients*', requestStage: 'Request' }],
    });
    cdp.on('Fetch.requestPaused', (params: any) => {
      void (async () => {
        aiRequestCount += 1;
        let lines: ReadonlyArray<ResolveLine> = [];
        try {
          const body = JSON.parse(String(params.request?.postData ?? '{}'));
          lines = Array.isArray(body?.ingredients) ? body.ingredients : [];
        } catch {
          // ignore
        }
        if (holdMode) {
          held = { requestId: params.requestId, lines };
          return;
        }
        if (aiMode === 'unavailable') {
          await cdp!.send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: 503,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify({ ok: false })).toString('base64'),
          });
          return;
        }
        await fulfillSuggestion(params.requestId, lines);
      })();
    });

    const goToGallery = async (): Promise<void> => {
      await evaluate(cdp!, `(() => { const b = document.getElementById('back-to-vault-btn'); if (b) b.click(); return !!b; })()`);
      await waitFor(cdp!, `!document.getElementById('back-to-vault-btn')`, 10000);
      await sleep(200);
    };
    const openRecipeByTitle = async (title: string): Promise<void> => {
      await evaluate(cdp!, `(() => {
        const heading = Array.from(document.querySelectorAll('h3')).find((h) => (h.textContent||'').trim() === ${JSON.stringify(title)});
        const card = heading && heading.closest('.group');
        const button = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === 'Details');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      await waitFor(cdp!, `document.body.innerText.includes('Advanced Nutrition')`, 15000);
    };

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` });
    await waitFor(cdp, `!!document.body && document.body.innerText.includes('Skillet Cornmeal Porridge')`, 20000);
    await sleep(300);

    await createRecipe(cdp, TITLE, INGREDIENTS);

    // ONE-CLICK Generate Nutrition: the deterministic analyzer runs in the SAME
    // explicit action (no second Analyze click), and AI is NOT called.
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-analyze"]')`, 120000);
    await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);
    record('one-click Generate Nutrition ran the deterministic analyzer immediately', true);
    record('Generate Nutrition did NOT call AI', aiRequestCount === 0, `requests=${aiRequestCount}`);
    await sleep(300);

    const unresolvedBefore = await evaluate(cdp, rowTextExpression('Zzz'));
    record(
      'an unresolved row shows NEEDS MATCH before AI assistance',
      /needs match/i.test(unresolvedBefore),
      unresolvedBefore.slice(0, 200)
    );
    record(
      'the AI panel is offered for unresolved rows',
      await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]')`)
    );
    record(
      'the AI panel warns that the USDA catalog/matcher decide every match',
      /pinned USDA catalog/i.test(String(await evaluate(cdp, `document.querySelector('[data-testid="advanced-nutrition-ai"]')?.innerText || ''`)))
    );

    // Manual full-catalog search remains available on the unresolved row.
    await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText||'').includes('Zzz'));
      const b = row && row.querySelector('[data-testid="advanced-nutrition-edit"]');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
      return !!b;
    })()`);
    await sleep(300);
    record(
      'manual full-catalog USDA search is available on the unresolved row',
      await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-search-usda"]')`)
    );

    // AI-UNAVAILABLE DEGRADATION FIRST (while the row is still unresolved).
    aiMode = 'unavailable';
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.querySelector('[data-testid="advanced-nutrition-ai-message"]') && /unavailable/i.test(document.querySelector('[data-testid="advanced-nutrition-ai-message"]').innerText || '')`, 20000);
    record(
      'AI unavailable shows a bounded message',
      /unavailable/i.test(String(await evaluate(cdp, `document.querySelector('[data-testid="advanced-nutrition-ai-message"]')?.innerText || ''`)))
    );
    record(
      'AI unavailable keeps the deterministic row and the manual USDA search',
      /needs match/i.test(String(await evaluate(cdp, rowTextExpression('Zzz')))) &&
        (await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-search-usda"]')`))
    );

    // Resolve with AI: the advisory phrase is resolved against the REAL pinned catalog.
    aiMode = 'suggest';
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-message"]')`, 20000);
    await sleep(500);
    const unresolvedAfter = await evaluate(cdp, rowTextExpression('Zzz'));
    record(
      'AI-assisted resolution selects a genuine pinned-USDA food (no longer NEEDS MATCH)',
      /broccoli/i.test(unresolvedAfter) && !/needs match/i.test(unresolvedAfter),
      unresolvedAfter.slice(0, 220)
    );
    record(
      'no mass is invented by AI (row remains NEEDS AMOUNT or resolves via a real portion)',
      /needs amount|matched/i.test(unresolvedAfter),
      unresolvedAfter.slice(0, 220)
    );
    const aiMessage = String(await evaluate(cdp, `document.querySelector('[data-testid="advanced-nutrition-ai-message"]')?.innerText || ''`));
    record(
      'AI resolution reports a bounded advisory outcome',
      /resolved automatically|still need|could not find|no authenticated USDA resolution/i.test(aiMessage),
      aiMessage.slice(0, 160)
    );
    record(
      'the AI-assisted match is labelled as an AI-assisted USDA match (never user-selected)',
      /AI-assisted USDA match/i.test(unresolvedAfter) && !/user-selected from USDA search/i.test(unresolvedAfter),
      unresolvedAfter.slice(0, 220)
    );

    // --- RECIPE-BOUND AI LIFECYCLE (in-flight cross-recipe response) ----------
    // Two recipes with an IDENTICAL first ingredient (and therefore an identical
    // content-derived line_ref). An AI request started in A must never surface in
    // B after a mid-request recipe switch.
    const A2 = 'AI Bind A';
    const B2 = 'AI Bind B';
    const SAME_LINE = ['1 cup Zzz'];

    await goToGallery();
    await createRecipe(cdp, A2, SAME_LINE);
    // Create Recipe B with the SAME ingredient (identical content-derived line_ref).
    await goToGallery();
    await createRecipe(cdp, B2, SAME_LINE);
    await goToGallery();
    await openRecipeByTitle(A2);
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);
    await sleep(300);
    holdMode = true;
    const beforeHold = aiRequestCount;
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `true`, 1000);
    for (let i = 0; i < 40 && held === null; i += 1) await sleep(100);
    record('recipe-binding: AI request started for Recipe A is held in flight', held !== null && aiRequestCount === beforeHold + 1);

    // Switch to Recipe B (same ingredient/line_ref) while A's request is in flight.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(cdp, `!document.querySelector('[role="dialog"]')`, 10000);
    await goToGallery();
    await openRecipeByTitle(B2);

    // Fulfill A's held response now that B is current.
    const heldRequest = held as { requestId: string; lines: ReadonlyArray<ResolveLine> } | null;
    if (heldRequest) await fulfillSuggestion(heldRequest.requestId, heldRequest.lines);
    await sleep(500);

    // B must show NO AI state from A.
    record('recipe-binding: Recipe B shows no AI message from Recipe A', !(await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-message"]')`)));

    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `document.body.innerText.includes('Advisory nutrition preview')`, 30000);
    await sleep(300);
    await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText||'').includes('Zzz'));
      const b = row && row.querySelector('[data-testid="advanced-nutrition-edit"]');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
      return !!b;
    })()`);
    await sleep(300);
    const bRowText = String(await evaluate(cdp, rowTextExpression('Zzz')));
    record(
      'recipe-binding: Recipe B row is untouched (NEEDS MATCH, no selected food)',
      /needs match/i.test(bRowText) && !/broccoli/i.test(bRowText),
      bRowText.slice(0, 200)
    );
    record('recipe-binding: Recipe B shows no AI-assisted badge', !/AI-assisted/i.test(bRowText));

    // --- AI RE-ENTRY GUARD (rapid double-click = ONE request) -----------------
    holdMode = false;
    const beforeDouble = aiRequestCount;
    await evaluate(cdp, `(() => {
      const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]');
      if (b) { b.click(); b.click(); b.click(); }
      return !!b;
    })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-message"]')`, 20000);
    await sleep(400);
    record(
      'recipe-binding: rapid Resolve double-click made exactly ONE AI request',
      aiRequestCount === beforeDouble + 1,
      `before=${beforeDouble} after=${aiRequestCount}`
    );

    // === UNIFIED AI EXCEPTION RESOLUTION SCENARIOS (A-F) =====================
    // The same REAL built application + REAL pinned USDA catalog; only the
    // external provider boundary is mocked.

    const closeModalAndGoToGallery = async (): Promise<void> => {
      await evaluate(cdp!, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-close-without-saving"]'); if (b) b.click(); return !!b; })()`);
      await waitFor(cdp!, `!document.querySelector('[role="dialog"]')`, 10000);
      await goToGallery();
    };

    const openWorkingFor = async (recipeTitle: string, expectedRowCount: number): Promise<void> => {
      await openRecipeByTitle(recipeTitle);
      await evaluate(cdp!, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-open"]'); if (b) b.click(); return !!b; })()`);
      await waitFor(cdp!, `!!document.querySelector('[data-testid="advanced-nutrition-analyze"]')`, 120000);
      await waitFor(cdp!, `document.querySelectorAll('[data-testid="advanced-nutrition-row"]').length >= ${expectedRowCount}`, 30000);
      await waitFor(cdp!, `document.body.innerText.includes('Advisory nutrition preview')`, 60000);
      await sleep(300);
    };

    const summaryExpression = `(document.querySelector('[data-testid="advanced-nutrition-live-summary"]')?.innerText || '')`;

    /** Parses the live summary line into bounded status counts. */
    const parseSummary = (text: string) => {
      const read = (pattern: RegExp): number => {
        const match = text.match(pattern);
        return match ? Number(match[1]) : -1;
      };
      return {
        matched: read(/(\d+)\s+matched/i),
        review: read(/(\d+)\s+review suggested/i),
        amount: read(/(\d+)\s+need amount/i),
        match: read(/(\d+)\s+need match/i),
        qualitative: read(/(\d+)\s+qualitative/i),
      };
    };

    const renderedStatusCounts = async (): Promise<Record<string, number>> => {
      const raw = await evaluate(cdp, `(() => Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row-status"]')).map((n) => (n.innerText || '').trim().toLowerCase()))()`);
      // Keys are the RENDERED badge labels, lowercased.
      const counts: Record<string, number> = { matched: 0, 'review suggested': 0, 'needs amount': 0, 'needs match': 0, qualitative: 0 };
      for (const status of raw as ReadonlyArray<string>) {
        if (status in counts) counts[status] += 1;
      }
      return counts;
    };

    /** The rendered row statuses IN ROW ORDER (transitions are computed on it). */
    const renderedStatusList = async (): Promise<ReadonlyArray<string>> =>
      (await evaluate(cdp, `(() => Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row-status"]')).map((n) => (n.innerText || '').trim().toLowerCase()))()`)) as ReadonlyArray<string>;

    /** Parses `N of M ingredient lines unresolved` from the preview text. */
    const unresolvedLineCount = (text: string): number => {
      const match = text.match(/(\d+)\s+of\s+(\d+)\s+ingredient lines unresolved/i);
      return match ? Number(match[1]) : -1;
    };

    // --- Scenario A: needs_amount only, zero needs_match -> AI available ---
    await closeModalAndGoToGallery();
    await createRecipe(cdp, 'AI Amount', ['3 garlic cloves, minced']);
    await openWorkingFor('AI Amount', 1);
    const amountRowBefore = String(await evaluate(cdp, rowTextExpression('garlic')));
    record(
      'A. needs_amount-only row shows NEEDS AMOUNT',
      /needs amount/i.test(amountRowBefore),
      amountRowBefore.slice(0, 160)
    );
    const summaryBefore = String(await evaluate(cdp, summaryExpression));
    record('A. summary reports zero need-match rows', /0 need match/i.test(summaryBefore), summaryBefore);
    record('A. summary reports one need-amount row', /1 need amount/i.test(summaryBefore), summaryBefore);
    record(
      'A. bulk "Resolve remaining with AI" is visible and enabled (0 NEEDS MATCH)',
      await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); return !!b && b.disabled !== true; })()`)
    );
    await evaluate(cdp, `(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="advanced-nutrition-row"]')).find((n) => (n.innerText||'').includes('garlic'));
      const b = row && row.querySelector('[data-testid="advanced-nutrition-edit"]');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
      return !!b;
    })()`);
    await sleep(200);
    record(
      'A. row-level "Ask AI for help" is offered on the needs_amount row',
      await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-help"]')`)
    );

    // --- Scenario C: AI-assisted local USDA count resolution ---------------
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-message"]')`, 20000);
    await sleep(500);
    const amountRowAfter = String(await evaluate(cdp, rowTextExpression('garlic')));
    record(
      'C. garlic resolves to MATCHED via an authenticated USDA count portion',
      /matched/i.test(amountRowAfter) && /9 g/.test(amountRowAfter) && !/needs amount/i.test(amountRowAfter),
      amountRowAfter.slice(0, 220)
    );
    record(
      'C. the count resolution is labelled AI-assisted (never user-confirmed)',
      /AI-assisted USDA count portion/i.test(amountRowAfter) && !/user-confirmed/i.test(amountRowAfter),
      amountRowAfter.slice(0, 220)
    );
    const previewAfter = String(await evaluate(cdp, `document.querySelector('[aria-label="Advisory nutrition preview"]')?.innerText || ''`));
    record(
      'C. the preview recalculated automatically (no unresolved lines)',
      /0 of 1 ingredient lines unresolved/i.test(previewAfter),
      previewAfter.slice(0, 200)
    );
    record(
      'C. nothing was persisted (no Apply, no saved block)',
      !(await evaluate(cdp, `!!document.querySelector('[data-testid="advanced-saved-complete"]')`)) &&
        !/was saved to your recipe|was replaced and saved/i.test(String(await evaluate(cdp, `document.body.innerText`)))
    );

    // --- Scenario E: live summary matches rendered row statuses ------------
    const summaryAfter = String(await evaluate(cdp, summaryExpression));
    const statuses = await renderedStatusCounts();
    record(
      'E. summary equals the rendered live row statuses',
      parseSummary(summaryAfter).matched === statuses['matched'] &&
        parseSummary(summaryAfter).review === statuses['review suggested'] &&
        parseSummary(summaryAfter).amount === statuses['needs amount'] &&
        parseSummary(summaryAfter).match === statuses['needs match'] &&
        parseSummary(summaryAfter).qualitative === statuses.qualitative,
      `summary=${summaryAfter} statuses=${JSON.stringify(statuses)}`
    );

    // --- Scenario F: Apply remains explicit --------------------------------
    record(
      'F. Apply exists and remains an explicit, un-triggered action',
      (await evaluate(cdp, `document.body.innerText.includes('Apply advanced nutrition')`)) &&
        !(await evaluate(cdp, `document.body.innerText.includes('Advanced Nutrition was saved to your recipe.')`))
    );

    // --- Scenario D: unresolvable amount -> no invented grams --------------
    await closeModalAndGoToGallery();
    await createRecipe(cdp, 'AI NoPortion', ['1 yellow onion, diced']);
    await openWorkingFor('AI NoPortion', 1);
    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-message"]')`, 20000);
    await sleep(500);
    const onionRow = String(await evaluate(cdp, rowTextExpression('onion')));
    record(
      'D. an unresolvable amount stays NEEDS AMOUNT with NO invented grams',
      /needs amount/i.test(onionRow) && !/needs match/i.test(onionRow) && !/\d+(\.\d+)?\s*g\b/i.test(onionRow),
      onionRow.slice(0, 220)
    );
    const onionPreview = String(await evaluate(cdp, `document.querySelector('[aria-label="Advisory nutrition preview"]')?.innerText || ''`));
    record(
      'D. the advisory preview still reports the unresolved line',
      /1 of 1 ingredient lines unresolved/i.test(onionPreview),
      onionPreview.slice(0, 200)
    );

    // --- Scenario G: realistic multi-line live-state application ------------
    // THE PRODUCTION REGRESSION. The same REAL app + pinned catalog; only the
    // provider boundary is mocked. A large recipe whose baseline request is near
    // the serialization bound: every accepted AI resolution must land in the SAME
    // live state that renders the badges/evidence/preview, and the reported
    // success count must equal the ACTUAL row transitions.
    await closeModalAndGoToGallery();
    const LARGE = [
      '2 cups cooked long-grain rice (cooled)',
      '1.5 lb ground beef',
      '1 tbsp Worcestershire sauce',
      '1 egg',
      '1 yellow onion, diced',
      '2 tbsp fresh parsley, chopped',
      '3 cloves garlic, minced',
      '1 tsp salt',
      '1/2 tsp black pepper',
      '1 tsp dried dill',
      '1 tsp onion powder',
      '1/4-1/2 tsp chili flakes (optional)',
      '3 cans tomato sauce',
      '1 medium head green cabbage',
      '1/2 cup water',
      'fresh dill for garnish',
    ];
    await createRecipe(cdp, 'AI Large Live', LARGE);
    await openWorkingFor('AI Large Live', LARGE.length);
    const statusesBeforeG = await renderedStatusList();
    const previewBeforeG = String(await evaluate(cdp, `document.querySelector('[aria-label="Advisory nutrition preview"]')?.innerText || ''`));
    const garlicBeforeG = String(await evaluate(cdp, rowTextExpression('garlic')));
    record(
      'G. multi-line: garlic starts NEEDS AMOUNT',
      /needs amount/i.test(garlicBeforeG),
      garlicBeforeG.slice(0, 160)
    );
    record(
      'G. multi-line: preview reports unresolved lines before AI',
      unresolvedLineCount(previewBeforeG) > 0,
      previewBeforeG.slice(0, 160)
    );

    await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); if (b) b.click(); return !!b; })()`);
    await waitFor(cdp, `!!document.querySelector('[data-testid="advanced-nutrition-ai-message"]')`, 30000);
    await sleep(500);
    const statusesAfterG = await renderedStatusList();
    const garlicAfterG = String(await evaluate(cdp, rowTextExpression('garlic')));
    const previewAfterG = String(await evaluate(cdp, `document.querySelector('[aria-label="Advisory nutrition preview"]')?.innerText || ''`));
    record(
      'G. multi-line: rendered garlic row becomes MATCHED with 9 g',
      /matched/i.test(garlicAfterG) && /9 g/.test(garlicAfterG) && !/needs amount/i.test(garlicAfterG),
      garlicAfterG.slice(0, 220)
    );
    record(
      'G. multi-line: the count resolution is labelled AI-assisted (never user-confirmed)',
      /AI-assisted USDA count portion/i.test(garlicAfterG) && !/user-confirmed/i.test(garlicAfterG),
      garlicAfterG.slice(0, 220)
    );
    record(
      'G. multi-line: the preview recalculated DOWN from the new live state',
      unresolvedLineCount(previewAfterG) >= 0 &&
        unresolvedLineCount(previewAfterG) < unresolvedLineCount(previewBeforeG),
      `before=${unresolvedLineCount(previewBeforeG)} after=${unresolvedLineCount(previewAfterG)}`
    );

    // The reported automatic resolutions must equal the ACTUAL rendered-row
    // transitions (actionable -> matched); never the number of proposals.
    let transitionsG = 0;
    for (let i = 0; i < Math.min(statusesBeforeG.length, statusesAfterG.length); i += 1) {
      if (statusesBeforeG[i] !== 'matched' && statusesAfterG[i] === 'matched') transitionsG += 1;
    }
    const messageG = String(await evaluate(cdp, `document.querySelector('[data-testid="advanced-nutrition-ai-message"]')?.innerText || ''`));
    const reportedResolvedG = (() => {
      const match = messageG.match(/(\d+) resolved automatically/i);
      return match ? Number(match[1]) : 0;
    })();
    record(
      'G. the reported automatic-resolution count equals the real row transitions',
      transitionsG >= 1 && reportedResolvedG === transitionsG,
      `message="${messageG}" transitions=${transitionsG} before=[${statusesBeforeG.join(',')}] after=[${statusesAfterG.join(',')}]`
    );
    const summaryAfterG = parseSummary(String(await evaluate(cdp, summaryExpression)));
    const actionableAfterG = summaryAfterG.amount + summaryAfterG.review + summaryAfterG.match;
    console.log(
      `  NOTE  Scenario G observed: message="${messageG}" transitions=${transitionsG} actionable-after=${actionableAfterG}`
    );
    const reportedStillG = (() => {
      const match = messageG.match(/(\d+) still needs? review/i);
      return match ? Number(match[1]) : -1;
    })();
    record(
      'G. the reported "still need review" count equals the post-operation actionable live rows',
      reportedStillG === actionableAfterG,
      `message="${messageG}" actionable=${actionableAfterG} summary=${JSON.stringify(summaryAfterG)}`
    );
    record(
      'G. the live summary still equals the rendered row statuses after AI application',
      statusesAfterG.filter((status) => status === 'matched').length === summaryAfterG.matched &&
        statusesAfterG.filter((status) => status === 'needs amount').length === summaryAfterG.amount &&
        statusesAfterG.filter((status) => status === 'review suggested').length === summaryAfterG.review &&
        statusesAfterG.filter((status) => status === 'needs match').length === summaryAfterG.match,
      `summary=${JSON.stringify(summaryAfterG)} statuses=[${statusesAfterG.join(',')}]`
    );

    // --- Scenario B: review_suggested only, zero needs_match -> AI available
    await closeModalAndGoToGallery();
    await createRecipe(cdp, 'AI Review', ['1 zucchini, chopped']);
    await openWorkingFor('AI Review', 1);
    const reviewRow = String(await evaluate(cdp, rowTextExpression('zucchini')));
    record(
      'B. review_suggested-only row shows REVIEW SUGGESTED',
      /review suggested/i.test(reviewRow),
      reviewRow.slice(0, 180)
    );
    const reviewSummary = String(await evaluate(cdp, summaryExpression));
    record('B. summary reports zero need-match rows', /0 need match/i.test(reviewSummary), reviewSummary);
    record(
      'B. bulk "Resolve remaining with AI" is visible and enabled (0 NEEDS MATCH)',
      await evaluate(cdp, `(() => { const b = document.querySelector('[data-testid="advanced-nutrition-ai-resolve"]'); return !!b && b.disabled !== true; })()`)
    );
    await closeModalAndGoToGallery();

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
