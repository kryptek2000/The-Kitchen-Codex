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
    let held: { requestId: string; lineRef: string } | null = null;

    const fulfillSuggestion = async (requestId: string, lineRef: string) => {
      const payload = {
        ok: true,
        version: 'nutrition_ai_resolution_v1',
        suggestions: lineRef
          ? [
              {
                line_ref: lineRef,
                interpreted_food_name: 'Broccoli, raw',
                suggested_usda_queries: ['broccoli raw'],
                notes: 'The recipe wording refers to raw broccoli.',
                confidence: 'high',
              },
            ]
          : [],
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
        let lineRef = '';
        try {
          const body = JSON.parse(String(params.request?.postData ?? '{}'));
          lineRef = body?.ingredients?.[0]?.line_ref ?? '';
        } catch {
          // ignore
        }
        if (holdMode) {
          held = { requestId: params.requestId, lineRef };
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
        await fulfillSuggestion(params.requestId, lineRef);
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
    record('AI resolution reports a bounded advisory outcome', /selected|suggested|could not find/i.test(aiMessage), aiMessage.slice(0, 160));
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
    const heldRequest = held as { requestId: string; lineRef: string } | null;
    if (heldRequest) await fulfillSuggestion(heldRequest.requestId, heldRequest.lineRef);
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
