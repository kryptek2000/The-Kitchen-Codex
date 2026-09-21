/**
 * The Kitchen Codex — Brand + Blood Moon production browser acceptance.
 *
 * Dependency-free real-browser acceptance (headless Chrome over CDP, same
 * harness style as verify_live_row_state_prod.ts). It builds nothing itself; run
 * `bun run build` first. It starts the compiled production server, drives the
 * built application, and proves:
 *   1. the brand mark renders in the header (token-driven SVG);
 *   2. the Themes picker exposes "The Blood Moon" with its Developer's Edition
 *      descriptor;
 *   3. selecting Blood Moon applies data-theme="blood-moon" and the real token
 *      colors (near-black warm root, crimson accent);
 *   4. the mark is theme-aware (body vs steam colors differ);
 *   5. major surfaces (gallery, recipe detail, meal planner, shopping, themes)
 *      render with visible, non-transparent text under Blood Moon;
 *   6. the selection persists across a reload;
 *   7. switching to another theme applies and persists, and Blood Moon is
 *      restored on switch-back;
 *   8. narrow-layout branding stays present without page overflow.
 *
 * Screenshots are written to /tmp for review (not committed).
 *
 * Usage: bun x tsx scripts/verify_brand_theme_browser_prod.ts
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const APP_PORT = Number(process.env.KC_VERIFY_PORT || 4660);
const CDP_PORT = Number(process.env.KC_VERIFY_CDP_PORT || 9370);

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
    await sleep(120);
  }
}

async function screenshot(cdp: Cdp, file: string): Promise<void> {
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`  (screenshot) ${file}`);
  } catch {
    // best-effort
  }
}

async function hoverBackground(cdp: Cdp, id: string): Promise<{ rest: string; hov: string } | null> {
  const rect = await evaluate(cdp, `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) return null;
  await sleep(150);
  const rest = await evaluate(cdp, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).backgroundColor`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(rect.x), y: Math.round(rect.y) });
  await sleep(400);
  const hov = await evaluate(cdp, `getComputedStyle(document.getElementById(${JSON.stringify(id)})).backgroundColor`);
  return { rest, hov };
}

async function focusVisibleCheck(cdp: Cdp, prevId: string, id: string): Promise<{ focused: boolean; visible: boolean }> {
  await evaluate(cdp, `document.getElementById(${JSON.stringify(prevId)}).focus()`);
  await sleep(150);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(250);
  const active = await evaluate(cdp, `document.activeElement ? document.activeElement.id : ''`);
  const vis = await evaluate(cdp, `(() => { const el = document.getElementById(${JSON.stringify(id)}); return el ? el.matches(':focus-visible') : false; })()`);
  return { focused: active === id, visible: vis === true };
}

const THEME_EXPR = `document.documentElement.getAttribute('data-theme')`;
const BODY_BG_EXPR = `getComputedStyle(document.body).backgroundColor`;

async function main(): Promise<void> {
  console.log('Brand + Blood Moon production browser acceptance');
  if (!existsSync(join(ROOT, 'dist', 'server.cjs')) || !existsSync(CHROME)) {
    console.error('dist/server.cjs or Chrome missing. Run `bun run build` first.');
    process.exit(1);
  }

  const server = spawn('node', ['dist/server.cjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const profile = mkdtempSync(join(tmpdir(), 'kc-brand-'));
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

    const url = `http://127.0.0.1:${APP_PORT}/`;
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, `(document.body?document.body.innerText:'').includes('Recipe Gallery')`, 25000);
    await sleep(400);

    // --- 1. Brand mark in the header --------------------------------------
    const headerMark = await evaluate(cdp, `document.querySelectorAll('#obsidian-vault-header .kc-brand-mark__body').length`);
    record('brand mark renders in the header', headerMark >= 1, `count=${headerMark}`);
    const markHasCauldron = await evaluate(
      cdp,
      `(() => {
        const body = document.querySelector('#obsidian-vault-header .kc-brand-mark__body');
        const svg = body && body.closest('svg');
        if (!svg) return false;
        const accent = svg.querySelector('.kc-brand-mark__accent');
        return !!accent &&
          accent.querySelectorAll('path').length >= 2 &&
          body.querySelectorAll('path').length > 2;
      })()`
    );
    record('header mark uses the approved identity (full detail + steam)', markHasCauldron === true);
    const obsidianMeta = await evaluate(cdp, `(document.querySelector('meta[name="theme-color"]')||{}).content`);
    record('theme-color is the default Obsidian color on load', obsidianMeta === '#0C0C0C', obsidianMeta);
    await screenshot(cdp, '/tmp/kc-brand-header-obsidian.png');
    const headerAccent = await evaluate(
      cdp,
      `(() => { const el = document.querySelector('#obsidian-vault-header .kc-brand-mark__accent'); return el ? getComputedStyle(el).color : ''; })()`
    );
    const headerBody = await evaluate(
      cdp,
      `(() => { const el = document.querySelector('#obsidian-vault-header .kc-brand-mark__body'); return el ? getComputedStyle(el).color : ''; })()`
    );
    record(
      'brand mark is theme-aware (body vs steam colors differ, both opaque)',
      !!headerAccent && !!headerBody && headerAccent !== headerBody && !/rgba?\\(0, 0, 0, 0\\)/.test(headerAccent),
      `body=${headerBody} accent=${headerAccent}`
    );

    // --- 2. Theme picker exposes Blood Moon --------------------------------
    await evaluate(cdp, `document.getElementById('tab-themes').click()`);
    await waitFor(cdp, `!!document.getElementById('theme-card-blood-moon')`, 10000);
    const pickerText = await evaluate(cdp, `(document.body?document.body.innerText:'')`);
    record('theme picker lists The Blood Moon', pickerText.includes('The Blood Moon'));
    record("theme picker shows the Developer's Edition descriptor", /developer's edition/i.test(pickerText));
    await screenshot(cdp, '/tmp/kc-brand-themes-before.png');

    // --- 3. Apply Blood Moon ----------------------------------------------
    await evaluate(cdp, `document.getElementById('theme-card-blood-moon').click()`);
    await waitFor(cdp, `${THEME_EXPR} === 'blood-moon'`, 10000);
    record('applying Blood Moon sets data-theme="blood-moon"', (await evaluate(cdp, THEME_EXPR)) === 'blood-moon');
    // The shell animates background-color (transition-colors), so let it settle.
    await sleep(600);
    const bmBg = await evaluate(cdp, BODY_BG_EXPR);
    record('Blood Moon body background is the warm near-black token', bmBg === 'rgb(11, 9, 10)', bmBg);
    const bmAccent = await evaluate(
      cdp,
      `(() => { const el = document.querySelector('#obsidian-vault-header .kc-brand-mark__accent'); return el ? getComputedStyle(el).color : ''; })()`
    );
    record('Blood Moon steam renders crimson', bmAccent === 'rgb(217, 102, 90)', bmAccent);
    const bmHeader = await evaluate(
      cdp,
      `(() => { const el = document.getElementById('obsidian-vault-header'); return el ? getComputedStyle(el).backgroundColor : ''; })()`
    );
    record('Blood Moon header surface is graphite (not pure black)', bmHeader === 'rgb(19, 16, 17)', bmHeader);
    const bmMeta = await evaluate(cdp, `(document.querySelector('meta[name="theme-color"]')||{}).content`);
    record('theme-color follows Blood Moon when active', bmMeta === '#0B090A', bmMeta);
    await screenshot(cdp, '/tmp/kc-brand-header-bloodmoon.png');

    // --- 5. Major surfaces under Blood Moon --------------------------------
    const surfaceChecks: Array<{ name: string; step: () => Promise<void>; waitText: string }> = [
      {
        name: 'recipe gallery',
        step: async () => {
          await evaluate(cdp, `document.getElementById('tab-recipe-cards').click()`);
        },
        waitText: 'Recipe Gallery',
      },
      {
        name: 'recipe detail',
        step: async () => {
          await evaluate(cdp, `(() => {
            const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'Details');
            if (b) b.click();
            return !!b;
          })()`);
        },
        waitText: 'Ingredients',
      },
      {
        name: 'meal planner',
        step: async () => {
          await evaluate(cdp, `document.getElementById('tab-meal-planner').click()`);
        },
        waitText: 'Meal Plan',
      },
      {
        name: 'shopping list',
        step: async () => {
          await evaluate(cdp, `document.getElementById('tab-shopping-list').click()`);
        },
        waitText: 'Shopping',
      },
      {
        name: 'themes',
        step: async () => {
          await evaluate(cdp, `document.getElementById('tab-themes').click()`);
        },
        waitText: 'Themes',
      },
    ];

    for (const surface of surfaceChecks) {
      await surface.step();
      try {
        await waitFor(cdp, `(document.body?document.body.innerText:'').includes(${JSON.stringify(surface.waitText)})`, 15000);
      } catch {
        // fall through to the explicit assertion below
      }
      const visible = await evaluate(cdp, `(document.body?document.body.innerText:'').includes(${JSON.stringify(surface.waitText)})`);
      const opaque = await evaluate(
        cdp,
        `(() => { const c = getComputedStyle(document.body).color; return c && !/rgba?\\(0, 0, 0, 0\\)/.test(c); })()`
      );
      record(`Blood Moon renders the ${surface.name} surface with visible text`, visible && opaque);
    }
    await screenshot(cdp, '/tmp/kc-brand-bloodmoon-gallery.png');

    // --- 6. Persistence across reload -------------------------------------
    await evaluate(cdp, `document.getElementById('tab-themes').click()`);
    await sleep(300);
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, `(document.body?document.body.innerText:'').includes('Recipe Gallery')`, 25000);
    await waitFor(cdp, `${THEME_EXPR} === 'blood-moon'`, 10000);
    record('Blood Moon persists across reload', (await evaluate(cdp, THEME_EXPR)) === 'blood-moon');

    // --- 7. Switch away, reload, switch back ------------------------------
    await evaluate(cdp, `document.getElementById('tab-themes').click()`);
    await waitFor(cdp, `!!document.getElementById('theme-card-nordic')`, 10000);
    await evaluate(cdp, `document.getElementById('theme-card-nordic').click()`);
    await waitFor(cdp, `${THEME_EXPR} === 'nordic'`, 10000);
    record('switching to Nordic Sage applies', (await evaluate(cdp, THEME_EXPR)) === 'nordic');
    const nordicMeta = await evaluate(cdp, `(document.querySelector('meta[name="theme-color"]')||{}).content`);
    record('theme-color follows Nordic Sage when active', nordicMeta === '#0A120F', nordicMeta);
    await screenshot(cdp, '/tmp/kc-brand-header-nordic.png');
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, `(document.body?document.body.innerText:'').includes('Recipe Gallery')`, 25000);
    await waitFor(cdp, `${THEME_EXPR} === 'nordic'`, 10000);
    record('Nordic Sage persists across reload', (await evaluate(cdp, THEME_EXPR)) === 'nordic');
    await evaluate(cdp, `document.getElementById('tab-themes').click()`);
    await waitFor(cdp, `!!document.getElementById('theme-card-blood-moon')`, 10000);
    await evaluate(cdp, `document.getElementById('theme-card-blood-moon').click()`);
    await waitFor(cdp, `${THEME_EXPR} === 'blood-moon'`, 10000);
    record('switching back to Blood Moon works', (await evaluate(cdp, THEME_EXPR)) === 'blood-moon');

    // --- 7b. Brand readability on the light theme --------------------------
    await evaluate(cdp, `document.getElementById('tab-themes').click()`);
    await waitFor(cdp, `!!document.getElementById('theme-card-parchment')`, 10000);
    await evaluate(cdp, `document.getElementById('theme-card-parchment').click()`);
    await waitFor(cdp, `${THEME_EXPR} === 'parchment'`, 10000);
    await sleep(600);
    const lightMark = await evaluate(cdp, `(() => {
      const b = document.querySelector('#obsidian-vault-header .kc-brand-mark__body');
      const a = document.querySelector('#obsidian-vault-header .kc-brand-mark__accent');
      return { body: b ? getComputedStyle(b).color : '', accent: a ? getComputedStyle(a).color : '' };
    })()`);
    record(
      'brand mark adapts to the light Parchment theme',
      lightMark.body === 'rgb(28, 25, 23)' && lightMark.accent === 'rgb(194, 65, 12)',
      JSON.stringify(lightMark)
    );
    const parchmentMeta = await evaluate(cdp, `(document.querySelector('meta[name="theme-color"]')||{}).content`);
    record('theme-color follows Warm Parchment when active', parchmentMeta === '#F6F3EB', parchmentMeta);
    await screenshot(cdp, '/tmp/kc-brand-header-parchment.png');
    await evaluate(cdp, `document.getElementById('theme-card-blood-moon').click()`);
    await waitFor(cdp, `${THEME_EXPR} === 'blood-moon'`, 10000);

    // --- 7c. Active badge layering --------------------------------------
    await evaluate(cdp, `document.getElementById('theme-card-blood-moon').scrollIntoView({block:'center'})`);
    await sleep(300);
    const badgeCheck = await evaluate(cdp, `(() => {
      const card = document.getElementById('theme-card-blood-moon');
      if (!card) return { found: false };
      const b = Array.from(card.querySelectorAll('div')).find((d) => (d.textContent || '').trim() === 'ACTIVE');
      if (!b) return { found: false };
      const r = b.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        found: true,
        covered: !(el === b || b.contains(el)),
        inside: r.left >= cr.left - 2 && r.right <= cr.right + 2 && r.top >= cr.top - 2,
      };
    })()`);
    record('active badge is fully visible above the preview panel', badgeCheck.found && !badgeCheck.covered && badgeCheck.inside, JSON.stringify(badgeCheck));
    await screenshot(cdp, '/tmp/kc-brand-active-card.png');

    // --- 7d. Header hover states (Blood Moon) ---------------------------
    await evaluate(cdp, `window.scrollTo(0,0)`);
    await sleep(200);
    const askHover = await hoverBackground(cdp, 'ask-my-kitchen-header-btn');
    record('Ask My Kitchen brightens on hover (Blood Moon)', !!askHover && askHover.rest !== askHover.hov, JSON.stringify(askHover));
    await screenshot(cdp, '/tmp/kc-brand-hover-ask.png');
    const connectHover = await hoverBackground(cdp, 'connect-local-vault-btn');
    record('Connect Vault brightens on hover (Blood Moon)', !!connectHover && connectHover.rest !== connectHover.hov, JSON.stringify(connectHover));
    await screenshot(cdp, '/tmp/kc-brand-hover-connect.png');

    // --- 7e. Keyboard focus-visible -------------------------------------
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(150);
    const askFocus = await focusVisibleCheck(cdp, 'create-for-me-header-btn', 'ask-my-kitchen-header-btn');
    record('Ask My Kitchen is keyboard-focusable with focus-visible', askFocus.focused && askFocus.visible, JSON.stringify(askFocus));
    const connectFocus = await focusVisibleCheck(cdp, 'grab-recipe-header-btn', 'connect-local-vault-btn');
    record('Connect Vault is keyboard-focusable with focus-visible', connectFocus.focused && connectFocus.visible, JSON.stringify(connectFocus));

    // --- 7f. Hover states across the remaining themes -------------------
    for (const [themeId, label] of [['obsidian', 'Obsidian'], ['parchment', 'Parchment'], ['nordic', 'Nordic']] as const) {
      await evaluate(cdp, `document.getElementById('tab-themes').click()`);
      await waitFor(cdp, `!!document.getElementById('theme-card-${themeId}')`, 10000);
      await evaluate(cdp, `document.getElementById('theme-card-${themeId}').click()`);
      await waitFor(cdp, `${THEME_EXPR} === '${themeId}'`, 10000);
      await sleep(500);
      await evaluate(cdp, `window.scrollTo(0,0)`);
      await sleep(200);
      const a = await hoverBackground(cdp, 'ask-my-kitchen-header-btn');
      record(`Ask My Kitchen brightens on hover (${label})`, !!a && a.rest !== a.hov, JSON.stringify(a));
      const cc = await hoverBackground(cdp, 'connect-local-vault-btn');
      record(`Connect Vault brightens on hover (${label})`, !!cc && cc.rest !== cc.hov, JSON.stringify(cc));
    }
    // Restore Blood Moon for the narrow check.
    await evaluate(cdp, `document.getElementById('tab-themes').click()`);
    await waitFor(cdp, `!!document.getElementById('theme-card-blood-moon')`, 10000);
    await evaluate(cdp, `document.getElementById('theme-card-blood-moon').click()`);
    await waitFor(cdp, `${THEME_EXPR} === 'blood-moon'`, 10000);

    // --- 8. Narrow-layout branding ----------------------------------------
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
    const narrow = await evaluate(cdp, `(() => {
      const mark = document.querySelector('#obsidian-vault-header .kc-brand-mark__body');
      const markRect = mark ? mark.getBoundingClientRect() : null;
      const brandBlock = mark ? mark.closest('div.flex.items-center.gap-3') : null;
      const newBtn = document.getElementById('create-new-recipe-btn');
      const actions = newBtn ? newBtn.parentElement : null;
      const brandRect = brandBlock ? brandBlock.getBoundingClientRect() : null;
      const actionsRect = actions ? actions.getBoundingClientRect() : null;
      const overlaps = brandRect && actionsRect
        ? !(brandRect.right <= actionsRect.left || actionsRect.right <= brandRect.left ||
            brandRect.bottom <= actionsRect.top || actionsRect.bottom <= brandRect.top)
        : false;
      return {
        visible: !!markRect && markRect.width > 0,
        inViewport: !!markRect && markRect.left >= 0 && markRect.right <= window.innerWidth,
        overlapsActions: overlaps,
      };
    })()`);
    record('narrow layout keeps the brand mark visible', narrow.visible === true);
    record('narrow brand mark stays within the viewport', narrow.inViewport === true);
    record('narrow brand lockup does not crowd the header controls', narrow.overlapsActions === false);
    await screenshot(cdp, '/tmp/kc-brand-bloodmoon-narrow.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    record('no console error occurred', consoleErrors.length === 0, consoleErrors.join(' | '));
    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    try { cdp?.send('Browser.close'); } catch { /* ignore */ }
    server.kill();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : 'verification_failed');
  process.exit(1);
});
