/**
 * The Kitchen Codex — shared headless-browser harness (TEST-ONLY).
 *
 * Dependency-free real-browser automation for production acceptance proofs:
 * discovers a real Chrome/Chromium, launches the BUILT production server, opens
 * an isolated browser profile, and drives the page over the Chrome DevTools
 * Protocol using only Node/Bun built-ins (global WebSocket + fetch).
 *
 * This module is proof infrastructure only. It imports NOTHING from `src/`,
 * `server/`, or `plugin/`, is not part of the application build graph, and is
 * never bundled into `dist/` or `plugin/main.js`.
 *
 * Design rules that exist deliberately:
 *   - Fail closed. A missing browser or a missing production build is a hard
 *     failure, never a skip. A silently-skipped browser proof is inadmissible
 *     release evidence.
 *   - No test doubles. This harness only launches processes and speaks CDP; it
 *     never stubs application or server logic.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

/**
 * Chrome/Chromium locations checked, in order, when `CHROME_BIN` is unset.
 *
 * Deliberately NOT a single hardcoded path: GitHub Actions `ubuntu-latest`
 * images ship Google Chrome at `/usr/bin/google-chrome` (a symlink) while many
 * Linux distributions and the `/opt/google/chrome` layout differ. Every entry is
 * verified at runtime, and the first executable match wins.
 */
const CHROME_CANDIDATES: ReadonlyArray<string> = [
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/lib/chromium/chromium',
];

export interface ChromeDiscovery {
  /** Absolute path of the resolved browser binary. */
  readonly path: string;
  /** How the binary was resolved: an explicit CHROME_BIN or a probed path. */
  readonly source: 'CHROME_BIN' | 'probed_path';
}

/**
 * Resolve a real Chrome/Chromium binary or THROW.
 *
 * Never returns a fallback and never skips: callers treat an unresolved browser
 * as a failed proof.
 */
export function discoverChrome(): ChromeDiscovery {
  const explicit = process.env.CHROME_BIN;
  if (explicit && existsSync(explicit)) {
    return { path: explicit, source: 'CHROME_BIN' };
  }
  if (explicit) {
    throw new Error(
      `CHROME_BIN is set to "${explicit}" but that path does not exist. ` +
        `Refusing to skip the browser proof: a missing browser is a failed proof.`
    );
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return { path: candidate, source: 'probed_path' };
  }
  throw new Error(
    'No Chrome/Chromium binary found. Probed: ' +
      CHROME_CANDIDATES.join(', ') +
      '. Install Google Chrome in CI or set CHROME_BIN. Refusing to skip the browser proof.'
  );
}

// ---------------------------------------------------------------------------
// CDP transport
// ---------------------------------------------------------------------------

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

/** A minimal, dependency-free Chrome DevTools Protocol client. */
export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Array<(params: any) => void>>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const call = this.pending.get(message.id);
        if (call) {
          this.pending.delete(message.id);
          if (message.error) call.reject(new Error(`CDP error: ${JSON.stringify(message.error)}`));
          else call.resolve(message.result);
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
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method)!.push(listener);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export interface HttpProbe {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export async function probeHttp(url: string, timeoutMs = 15000): Promise<HttpProbe> {
  const response = await fetch(url, { redirect: 'manual' });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

export async function waitForHttp(url: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url} (${lastError})`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// Production server
// ---------------------------------------------------------------------------

export interface ProductionServerOptions {
  readonly root: string;
  readonly port: number;
  readonly productTier: 'basic' | 'ai_advanced';
}

export interface ProductionServer {
  readonly port: number;
  readonly origin: string;
  kill(): void;
}

/**
 * Spawn the BUILT production server (`dist/server.cjs`) on loopback.
 *
 * `dist/server.cjs` is spawned directly rather than any dev entrypoint, so a
 * verifier that runs against a dev server fails at this call instead of
 * silently proving the wrong thing.
 *
 * Provider secrets are explicitly emptied: the deterministic proof must never
 * depend on a live AI provider, and an empty key makes operational readiness
 * fail closed so the AND-ed entitlement rule is observable.
 */
export function startProductionServer(options: ProductionServerOptions): ProductionServer {
  const entry = join(options.root, 'dist', 'server.cjs');
  if (!existsSync(entry)) {
    throw new Error(
      `${entry} is missing. Run \`bun run build\` before the browser proof. ` +
        `Refusing to prove a production flow without a production build.`
    );
  }
  const child = spawn('node', ['dist/server.cjs'], {
    cwd: options.root,
    env: {
      ...process.env,
      PORT: String(options.port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      KITCHEN_CODEX_NUTRITION_PRODUCT_TIER: options.productTier,
      // Deterministic proof: no provider key, no endpoint token.
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      OPENROUTER_API_KEY: '',
      AI_ENDPOINT_TOKEN: '',
      // Never prompt or block on anything interactive.
      CI: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const origin = `http://127.0.0.1:${options.port}`;
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 40) stderr.shift();
  });
  child.once('error', (error) => {
    process.stderr.write(`production server failed to spawn: ${String(error)}\n`);
  });
  return {
    port: options.port,
    origin,
    kill(): void {
      child.kill();
    },
  };
}

/**
 * Wait for `/api/health` and prove the server is running in PRODUCTION mode.
 *
 * The production CSP (`default-src 'self'`) is disabled in dev, so its presence
 * is a genuine built-production discriminator rather than a heuristic.
 */
export async function waitForProductionServer(origin: string): Promise<HttpProbe> {
  await waitForHttp(`${origin}/api/health`);
  const page = await probeHttp(`${origin}/`);
  const csp = page.headers['content-security-policy'] ?? '';
  if (!csp.includes("default-src 'self'")) {
    throw new Error(
      `served document has no production Content-Security-Policy (got: ${csp || '<none>'}). ` +
        `A dev server serves the app without it; this proof requires the built production server.`
    );
  }
  if (/\/@vite\/client|\/src\/main\.tsx/.test(page.body)) {
    throw new Error('served document references the Vite dev client; this proof requires the built production app.');
  }
  if (!/\/assets\/index-[A-Za-z0-9_-]+\.(js|css)/.test(page.body)) {
    throw new Error('served document does not reference content-hashed built assets; this proof requires a production build.');
  }
  return page;
}

// ---------------------------------------------------------------------------
// Browser session
// ---------------------------------------------------------------------------

export interface BrowserSessionOptions {
  readonly chromePath: string;
  readonly cdpPort: number;
  readonly windowSize?: string;
}

export interface NetworkRecord {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly status?: number;
  readonly failed?: string;
}

export interface BrowserSession {
  readonly cdp: CdpClient;
  /** Every request the page attempted, in order. */
  readonly requests: NetworkRecord[];
  /** Page console errors (`console.error`). */
  readonly consoleErrors: string[];
  /** Uncaught page exceptions. */
  readonly exceptions: string[];
  /** Downloads the page initiated (filename + url). */
  readonly downloads: Array<{ guid: string; url: string; suggestedFilename: string; completed: boolean }>;
  /** Requests that failed at the network layer. */
  readonly networkFailures: NetworkRecord[];
  evaluate(expression: string): Promise<any>;
  waitFor(expression: string, timeoutMs?: number, label?: string): Promise<void>;
  key(key: string, code?: string, virtualKeyCode?: number): Promise<void>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}

const CHROME_FLAGS: ReadonlyArray<string> = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  // Keep the browser hermetic: no background services, no telemetry, no
  // update/safebrowsing pings. Without these the browser itself reaches out to
  // Chrome-operated endpoints, which would pollute "zero external requests".
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-pings',
  '--no-service-autorun',
  '--safebrowsing-disable-auto-update',
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
  '--window-size=1400,1200',
];

/**
 * Real AI-provider hosts. Deliberately exact: a loose substring such as
 * `googleapis` also matches Chrome-operated telemetry endpoints and would
 * misreport a browser-internal request as an application provider call.
 */
export const PROVIDER_HOST_PATTERNS: ReadonlyArray<string> = [
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.openai.com',
  'aiplatform.googleapis.com',
];

export async function launchBrowserSession(options: BrowserSessionOptions): Promise<BrowserSession> {
  const { chromePath, cdpPort } = options;
  const windowSize = options.windowSize ?? '1400,1200';
  const profile = mkdtempSync(join(tmpdir(), 'kc-browser-proof-'));
  const child: ChildProcess = spawn(
    chromePath,
    [
      ...CHROME_FLAGS,
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      windowSize.startsWith('--') ? windowSize : `--window-size=${windowSize}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const cleanupBrowser = async (): Promise<void> => {
    child.kill();
    await sleep(400);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* best effort */
    }
  };

  try {
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 30000);
    const target = await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })
    ).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', () => resolveOpen(), { once: true });
      ws.addEventListener('error', () => rejectOpen(new Error('CDP websocket failed to open')), { once: true });
    });
    const cdp = new CdpClient(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOM.enable');

    const requests: NetworkRecord[] = [];
    const consoleErrors: string[] = [];
    const exceptions: string[] = [];
    const networkFailures: NetworkRecord[] = [];
    const downloads: Array<{ guid: string; url: string; suggestedFilename: string; completed: boolean }> = [];

    cdp.on('Network.requestWillBeSent', (params: any) => {
      requests.push({
        url: params.request?.url ?? '',
        method: params.request?.method ?? 'GET',
        resourceType: params.type ?? 'Other',
      });
    });
    cdp.on('Network.responseReceived', (params: any) => {
      const record = requests.find((r) => r.url === params.response?.url && r.status === undefined);
      if (record) (record as { status?: number }).status = params.response?.status;
    });
    cdp.on('Network.loadingFailed', (params: any) => {
      networkFailures.push({ url: '', method: 'GET', resourceType: params.type ?? 'Other', failed: params.errorText });
    });
    cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.type !== 'error') return;
      const text = (params.args ?? [])
        .map((arg: any) => arg.value ?? arg.description ?? arg.type ?? '')
        .join(' ')
        .slice(0, 300);
      consoleErrors.push(text);
    });
    cdp.on('Runtime.exceptionThrown', (params: any) => {
      exceptions.push(
        String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown exception').slice(0, 300)
      );
    });
    cdp.on('Browser.downloadWillBegin', (params: any) => {
      downloads.push({
        guid: params.guid,
        url: params.url ?? '',
        suggestedFilename: params.suggestedFilename ?? '',
        completed: false,
      });
    });
    cdp.on('Browser.downloadProgress', (params: any) => {
      const entry = downloads.find((d) => d.guid === params.guid);
      if (entry && params.state === 'completed') entry.completed = true;
    });

    const evaluate = async (expression: string): Promise<any> => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `evaluate failed: ${String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 400)}`
        );
      }
      return result.result?.value;
    };

    const waitFor = async (expression: string, timeoutMs = 30000, label?: string): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await evaluate(expression)) return;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label ?? expression}`);
        }
        await sleep(150);
      }
    };

    const key = async (keyName: string, code?: string, virtualKeyCode?: number): Promise<void> => {
      const base = { key: keyName, code: code ?? keyName, windowsVirtualKeyCode: virtualKeyCode ?? 0 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(180);
    };

    const screenshot = async (file: string): Promise<void> => {
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
      } catch {
        /* screenshots are review aids, never evidence */
      }
    };

    const close = async (): Promise<void> => {
      try {
        await cdp.send('Browser.close');
      } catch {
        /* best effort */
      }
      cdp.close();
      await cleanupBrowser();
    };

    return {
      cdp,
      requests,
      consoleErrors,
      exceptions,
      networkFailures,
      downloads,
      evaluate,
      waitFor,
      key,
      screenshot,
      close,
    };
  } catch (error) {
    await cleanupBrowser();
    throw error;
  }
}
