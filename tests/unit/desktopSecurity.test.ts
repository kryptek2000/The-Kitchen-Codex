/**
 * F1-B2/B3 — exact application-origin policy, IPC sender validation, and the
 * argument-free Open Vault Folder bridge.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const security = require('../../desktop/security.cjs') as {
  assertTrustedIpcSender(event: unknown, appOrigin: string, webContents?: unknown): void;
  installNavigationGuards(
    webContents: unknown,
    appOrigin: string,
    onBlocked?: (kind: string, url: string) => void
  ): void;
  isSameOrigin(targetUrl: string, appOrigin: string): boolean;
  isTrustedIpcSender(event: unknown, appOrigin: string, webContents?: unknown): boolean;
};

const APP_ORIGIN = 'http://127.0.0.1:38471';
const ROOT = path.resolve(process.cwd());

function fakeEvent(options: {
  url?: string;
  frameUrl?: string;
  parent?: unknown;
  destroyed?: boolean;
  sender?: unknown;
  mainFrame?: unknown;
}) {
  const url = options.url ?? APP_ORIGIN;
  const frameUrl = options.frameUrl ?? url;
  const mainFrame = options.mainFrame ?? { url, parent: null, destroyed: false };
  const sender = options.sender ?? {
    mainFrame,
    getURL: () => url,
  };
  return {
    sender,
    senderFrame:
      options.mainFrame && options.parent !== undefined
        ? { url: frameUrl, parent: options.parent, destroyed: options.destroyed ?? false }
        : options.parent !== undefined || options.destroyed !== undefined
          ? { url: frameUrl, parent: options.parent ?? null, destroyed: options.destroyed ?? false }
          : mainFrame,
  };
}

describe('F1-B3 — exact application origin', () => {
  it.each([
    `${APP_ORIGIN}/`,
    `${APP_ORIGIN}/index.html#/recipe/1`,
    `${APP_ORIGIN}/?x=1`,
  ])('accepts an exact-origin application URL: %s', (url) => {
    expect(security.isSameOrigin(url, APP_ORIGIN)).toBe(true);
  });

  it.each([
    ['userinfo', `http://127.0.0.1:38471@evil.example/steal`],
    ['hostname suffix', `http://127.0.0.1:38471.evil.example/steal`],
    ['alternate port', `http://127.0.0.1:38472/steal`],
    ['alternate host', `http://127.0.0.2:38471/steal`],
    ['alternate protocol', `https://127.0.0.1:38471/steal`],
    ['file scheme', `file:///tmp/steal.html`],
    ['javascript scheme', `javascript:alert(document.cookie)`],
    ['data scheme', `data:text/html,<script>alert(1)</script>`],
    ['blob scheme', `blob:${APP_ORIGIN}/steal`],
    ['malformed', `http://%`],
    ['empty', ''],
  ])('rejects a foreign or malformed URL (%s)', (_label, url) => {
    expect(security.isSameOrigin(url, APP_ORIGIN)).toBe(false);
  });

  it('installs guards for navigation, redirects, subframes, window creation, and webviews', () => {
    const webContents = new EventEmitter() as any;
    let windowOpenHandler: ((details: { url?: string }) => { action: string }) | null = null;
    webContents.setWindowOpenHandler = (handler: typeof windowOpenHandler) => {
      windowOpenHandler = handler;
    };
    webContents.close = vi.fn();
    const blocked = vi.fn();
    security.installNavigationGuards(webContents, APP_ORIGIN, blocked);

    const sameNavigation = { url: `${APP_ORIGIN}/index.html`, isMainFrame: true, preventDefault: vi.fn() };
    webContents.emit('will-navigate', sameNavigation);
    expect(sameNavigation.preventDefault).not.toHaveBeenCalled();

    const userinfo = {
      url: 'http://127.0.0.1:38471@evil.example/steal',
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    webContents.emit('will-navigate', userinfo);
    expect(userinfo.preventDefault).toHaveBeenCalledTimes(1);

    const redirect = {
      url: 'https://evil.example/steal',
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    webContents.emit('will-redirect', redirect);
    expect(redirect.preventDefault).toHaveBeenCalledTimes(1);

    const subframe = {
      url: 'http://evil.example/frame',
      isMainFrame: false,
      preventDefault: vi.fn(),
    };
    webContents.emit('will-frame-navigate', subframe);
    expect(subframe.preventDefault).toHaveBeenCalledTimes(1);

    expect(windowOpenHandler?.({ url: 'https://evil.example/popup' })).toEqual({
      action: 'deny',
    });

    const webview = { preventDefault: vi.fn() };
    webContents.emit('will-attach-webview', webview);
    expect(webview.preventDefault).toHaveBeenCalledTimes(1);

    webContents.emit('did-navigate', {}, 'https://evil.example/committed');
    expect(webContents.close).toHaveBeenCalledTimes(1);

    expect(blocked).toHaveBeenCalled();
  });

  it('accepts only the expected top frame at the exact application origin', () => {
    const webContents = { id: 'main-window' };
    const same = fakeEvent({}) as any;
    same.sender = webContents;
    same.senderFrame = { url: `${APP_ORIGIN}/`, parent: null, destroyed: false };
    (webContents as any).mainFrame = same.senderFrame;
    (webContents as any).getURL = () => `${APP_ORIGIN}/`;
    expect(security.isTrustedIpcSender(same, APP_ORIGIN, webContents)).toBe(true);

    const foreign = fakeEvent({ url: 'https://evil.example/' }) as any;
    foreign.sender = webContents;
    expect(security.isTrustedIpcSender(foreign, APP_ORIGIN, webContents)).toBe(false);

    const wrongWindow = fakeEvent({}) as any;
    wrongWindow.sender = { id: 'other-window' };
    expect(security.isTrustedIpcSender(wrongWindow, APP_ORIGIN, webContents)).toBe(false);

    const subframe = fakeEvent({ parent: {} }) as any;
    subframe.sender = webContents;
    expect(security.isTrustedIpcSender(subframe, APP_ORIGIN, webContents)).toBe(false);

    const destroyed = fakeEvent({ destroyed: true }) as any;
    destroyed.sender = webContents;
    expect(security.isTrustedIpcSender(destroyed, APP_ORIGIN, webContents)).toBe(false);
  });

  it('throws a typed error for an unauthorized sender', () => {
    let thrown: any;
    try {
      security.assertTrustedIpcSender(fakeEvent({ url: 'https://evil.example/' }), APP_ORIGIN);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('DESKTOP_IPC_UNAUTHORIZED');
  });
});

describe('F1-B2 — argument-free Open Vault Folder bridge', () => {
  function loadPreload(options: {
    topLevel?: boolean;
    origin?: string;
    includeOriginArgument?: boolean;
  } = {}) {
    const source = fs.readFileSync(path.join(ROOT, 'desktop/preload.cjs'), 'utf8');
    const calls: unknown[][] = [];
    let exposed: any;
    const topLevel = options.topLevel ?? true;
    const origin = options.origin ?? APP_ORIGIN;
    const includeOriginArgument = options.includeOriginArgument ?? true;
    const windowObject: any = {
      location: { origin },
    };
    windowObject.top = topLevel ? windowObject : {};
    const context = {
      require: (id: string) => {
        if (id !== 'electron') throw new Error(`Unexpected preload require: ${id}`);
        return {
          contextBridge: {
            exposeInMainWorld: (_key: string, api: any) => {
              exposed = api;
            },
          },
          ipcRenderer: {
            invoke: (...args: unknown[]) => {
              calls.push(args);
              return Promise.resolve({ opened: true });
            },
          },
        };
      },
      window: windowObject,
      process: {
        platform: 'linux',
        argv: [
          'electron',
          ...(includeOriginArgument ? [`--tkc-app-origin=${APP_ORIGIN}`] : []),
        ],
      },
      console,
    };
    vm.runInNewContext(source, context);
    return { exposed, calls };
  }

  it('exposes an Open Vault Folder operation that cannot carry a path', async () => {
    const { exposed, calls } = loadPreload();
    expect(exposed).toBeTruthy();
    expect(typeof exposed.openVaultFolder).toBe('function');
    expect(exposed.openVaultFolder.length).toBe(0);

    // Even a hostile caller that passes an extra argument cannot forward it.
    await exposed.openVaultFolder('/etc');
    expect(calls).toEqual([['desktop:openVaultFolder']]);
  });

  it('does not expose the privileged bridge to a nested frame', () => {
    const { exposed } = loadPreload({ topLevel: false });
    expect(exposed).toBeUndefined();
  });

  it('does not expose the privileged bridge to a foreign top-level document', () => {
    const { exposed } = loadPreload({ origin: 'https://evil.example' });
    expect(exposed).toBeUndefined();
  });

  it('fails closed when the main-process origin capability is absent', () => {
    const { exposed } = loadPreload({ includeOriginArgument: false });
    expect(exposed).toBeUndefined();
  });

  it('main resolves the active Vault and never accepts a renderer path', () => {
    const source = fs.readFileSync(path.join(ROOT, 'desktop/main.cjs'), 'utf8');
    const openHandler = source.slice(
      source.indexOf("trustedHandle('desktop:openVaultFolder'"),
      source.indexOf("trustedHandle('desktop:beginInitialization'")
    );
    expect(openHandler).toContain('openActiveVaultFolder');
    expect(openHandler).not.toContain('requestedRoot');
    expect(openHandler).not.toContain('lastVaultPath');
    expect(openHandler).not.toContain('managedVaultRoot');

    const picker = source.slice(
      source.indexOf("trustedHandle('desktop:chooseVaultDirectory'"),
      source.indexOf("trustedHandle('desktop:setActiveVault'")
    );
    expect(picker).toContain('authorizeRoot');
    expect(picker).not.toContain('commitAcceptedVault');
    expect(picker).not.toContain('persistActiveVault');
    expect(picker).not.toContain('writeState');

    const commit = source.slice(
      source.indexOf("trustedHandle('desktop:setActiveVault'"),
      source.indexOf("trustedHandle('desktop:openVaultFolder'")
    );
    expect(commit).toContain('commitAcceptedVault');
    expect(commit).toContain('activeVaultRoot = real');

    expect((source.match(/ipcMain\.handle\(/g) || []).length).toBe(1);
    expect(source).toContain('assertTrustedIpcSender');
    expect(source).toContain('installNavigationGuards');
    expect(source).toContain('--tkc-app-origin=${serverOrigin}');
    expect(source).not.toContain('startsWith(serverOrigin)');

    const preload = fs.readFileSync(path.join(ROOT, 'desktop/preload.cjs'), 'utf8');
    expect(preload).toContain('window.location.origin');
    expect(preload).toContain('--tkc-app-origin=');
  });
});
