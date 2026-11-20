/**
 * The Kitchen Codex — desktop runtime (Electron main process, R6 desktop foundation).
 *
 * Responsibilities:
 *   - start the EXISTING local Node/Express production server on loopback;
 *   - create one secure BrowserWindow loading that local application;
 *   - expose a narrow, allowlisted native filesystem IPC bridge;
 *   - own the managed Recipe Vault location and durable starter-initialization
 *     marker;
 *   - shut the backend down with the desktop app.
 *
 * It does NOT reimplement recipes, nutrition, SHISO, AI Studio, voice, or
 * Markdown logic. Those remain in the shared application/server.
 */

'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  assertRootIdentity,
  authorizeRoot,
  canonicalExistingRoot,
  normalizeRelative,
} = require('./fsSafety.cjs');
const {
  assertTrustedIpcSender,
  installContextMenu,
  installNavigationGuards,
} = require('./security.cjs');
const {
  commitAcceptedVault,
  createDesktopVaultState,
  resolveOpenableVault,
} = require('./vaultState.cjs');
const { isEnabled: isChatGptSubscriptionEnabled } = require('./chatgpt/config.cjs');
const { ChatGptCredentialStore } = require('./chatgpt/credentialStore.cjs');
const { ChatGptOAuthClient } = require('./chatgpt/oauth.cjs');
const { ChatGptSubscriptionService } = require('./chatgpt/service.cjs');
const { publicError } = require('./chatgpt/errors.cjs');
const { createSafeStorageAdapter } = require('./chatgpt/safeStorageAdapter.cjs');

// Electron's Linux auto-detection does not select libsecret under Hyprland.
// When the experimental integration is explicitly enabled, request the real
// OS keyring; the credential store still fails closed if it is unavailable.
if (process.platform === 'linux' && isChatGptSubscriptionEnabled()) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

const IS_DEV = !app.isPackaged;
const APP_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');
const SERVER_VOICE_DIR = path.join(APP_ROOT, 'dist', 'voice');
const MARKER_DIR = '.kitchen-codex';
const MARKER_FILE = 'initialization.json';
const STATE_FILE = 'desktop-vault.json';

let mainWindow = null;
let serverProcess = null;
let serverOrigin = null;
let quitting = false;
let managedVaultRoot = null;
let activeVaultRoot = null;
let statePath = null;
let vaultState = null;
let vaultFs = null;
let desktopSessionToken = null;
let chatgptService = null;
const allowedRoots = new Set();
const rootIdentities = new Map();

function isolateDocumentsRoot() {
  const override = String(process.env.TKC_DESKTOP_DOCUMENTS_ROOT || '').trim();
  if (override) return path.resolve(override);
  try {
    return app.getPath('documents');
  } catch {
    return path.join(app.getPath('userData'), 'Documents');
  }
}

function computeManagedVaultRoot() {
  return path.join(isolateDocumentsRoot(), 'The Kitchen Codex', 'My Recipe Vault');
}

function readState() {
  return vaultState ? vaultState.readState() : {};
}

function ensureAllowedVaultRoot(requestedRoot) {
  const real = canonicalExistingRoot(requestedRoot, allowedRoots);
  const identity = assertRootIdentity(real, rootIdentities);
  return { path: real, identity };
}

function isManaged(root) {
  try {
    return fs.realpathSync(root) === fs.realpathSync(managedVaultRoot);
  } catch {
    return path.resolve(root) === path.resolve(managedVaultRoot);
  }
}

function hasAnyMarkdownSync(root, identity) {
  const stack = [''];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = vaultFs.list(root, current, identity);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === MARKER_DIR) continue;
      const relative = current ? `${current}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') stack.push(relative);
      else if (/\.(md|markdown)$/i.test(entry.name)) return true;
    }
  }
  return false;
}

function initializationStatus(root, identity) {
  try {
    const parsed = JSON.parse(
      vaultFs.readText(root, `${MARKER_DIR}/${MARKER_FILE}`, identity)
    );
    return parsed?.status === 'complete'
      ? 'complete'
      : parsed?.status === 'initializing'
        ? 'initializing'
        : 'unknown';
  } catch {
    return 'missing';
  }
}

function vaultInfo(root) {
  if (!root) return null;
  const resolved = path.resolve(root);
  try {
    if (!fs.existsSync(resolved)) {
      return {
        path: resolved,
        exists: false,
        initialized: false,
        isManaged: isManaged(resolved),
        name: path.basename(resolved),
      };
    }
    const real = authorizeRoot(resolved, allowedRoots, rootIdentities);
    const identity = rootIdentities.get(real);
    const status = initializationStatus(real, identity);
    return {
      path: real,
      exists: true,
      initialized: status === 'complete',
      initialization: status,
      hasMarkdown: hasAnyMarkdownSync(real, identity),
      isManaged: isManaged(real),
      name: path.basename(real),
    };
  } catch {
    return {
      path: resolved,
      exists: false,
      initialized: false,
      hasMarkdown: false,
      isManaged: isManaged(resolved),
      name: path.basename(resolved),
    };
  }
}

function listMarkdownFilesRecursive(root, identity, relative = '') {
  let entries;
  try {
    entries = vaultFs.list(root, relative, identity);
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (entry.name === MARKER_DIR) continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      results.push(...listMarkdownFilesRecursive(root, identity, rel));
    } else if (/\.(md|markdown)$/i.test(entry.name)) {
      results.push(rel);
    }
  }
  return results;
}

// Keep a stable loopback origin so renderer localStorage/IndexedDB settings
// survive desktop restarts. 3040 belongs to the owner's installed legacy app.
const DESKTOP_PORT = Number(process.env.TKC_DESKTOP_PORT || 38471);

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        reject(new Error(`The desktop application port ${port} is already in use. Close the other instance and try again.`));
      } else {
        reject(error);
      }
    });
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
  });
}

function waitForHealth(origin, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (child.exitCode !== null) {
        reject(new Error(`The local application server exited during startup (code ${child.exitCode}).`));
        return;
      }
      const req = http.get(`${origin}/api/health`, { timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('timeout', () => req.destroy());
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error('The local application server did not become ready.'));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

async function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Production server bundle is missing: ${SERVER_ENTRY}. Run the production build before launching the desktop candidate.`);
  }
  const port = await assertPortAvailable(DESKTOP_PORT);
  serverOrigin = `http://127.0.0.1:${port}`;
  desktopSessionToken = crypto.randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    TKC_DESKTOP_RUNTIME: '1',
    TKC_DESKTOP_USER_DATA: app.getPath('userData'),
    TKC_DESKTOP_SESSION_TOKEN: desktopSessionToken,
    // Node child processes spawned by the server (native voice) must stay
    // Node processes rather than opening another Electron window.
    ELECTRON_RUN_AS_NODE: '1',
  };
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess = child;
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  child.once('exit', (code) => {
    if (!quitting) console.warn(`[desktop] local server exited with code ${code}`);
    serverProcess = null;
  });
  await waitForHealth(serverOrigin, child);
  // Keep the voice asset root adjacent to the bundled server for packaged runs.
  if (!fs.existsSync(SERVER_VOICE_DIR)) {
    console.warn('[desktop] voice asset directory missing from build:', SERVER_VOICE_DIR);
  }
}

function stopBackend() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  try {
    child.kill('SIGTERM');
  } catch {
    // best effort
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
    }
  }, 2000).unref();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#0C0C0C',
    title: 'The Kitchen Codex',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      additionalArguments: [`--tkc-app-origin=${serverOrigin}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  installNavigationGuards(mainWindow.webContents, serverOrigin, (kind, url) => {
    console.warn(`[desktop] blocked ${kind}:`, url);
  });
  installContextMenu(mainWindow.webContents, serverOrigin, Menu, mainWindow);

  mainWindow.loadURL(`${serverOrigin}/`).catch((error) => {
    dialog.showErrorBox('The Kitchen Codex could not open', error?.message || String(error));
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openPathBounded(target, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve('The system file manager did not confirm opening the Vault folder.');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(shell.openPath(target)).then(
      (error) => {
        clearTimeout(timer);
        resolve(error || '');
      },
      (error) => {
        clearTimeout(timer);
        resolve(error?.message || String(error));
      }
    );
  });
}

async function openActiveVaultFolder() {
  let root;
  try {
    root = resolveOpenableVault({ activeVaultRoot, allowedRoots, rootIdentities });
  } catch (error) {
    return { opened: false, message: error?.message || String(error) };
  }
  const error = await openPathBounded(root);
  return error ? { opened: false, message: error } : { opened: true };
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Vault Folder',
          click: () => {
            void openActiveVaultFolder().then((result) => {
              if (!result.opened) {
                void dialog.showMessageBox({
                  type: 'info',
                  title: 'My Recipe Vault',
                  message: result.message || 'No personal Recipe Vault is active yet.',
                });
              }
            });
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, ...(IS_DEV ? [{ role: 'toggleDevTools' }] : []), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'About The Kitchen Codex', click: () => dialog.showMessageBox({ type: 'info', title: 'The Kitchen Codex', message: `Version ${app.getVersion()}\nLocal-first Recipe Vault desktop candidate.` }) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, serverOrigin, mainWindow ? mainWindow.webContents : null);
    return handler(event, ...args);
  });
}

function chatGptStatus() {
  return chatgptService
    ? chatgptService.status()
    : {
        enabled: false,
        secureStorage: false,
        sessionOnly: true,
        signInRequiredAfterRestart: true,
        legacyCredentials: 'none',
        connected: false,
        accounts: [],
        activeAccount: null,
        models: [],
        error: null,
      };
}

async function chatGptResult(handler) {
  if (!chatgptService) {
    return {
      ok: false,
      error: {
        code: 'DISABLED',
        message: 'The ChatGPT subscription integration is disabled in this build.',
      },
    };
  }
  try {
    return { ok: true, value: await handler(chatgptService) };
  } catch (error) {
    return { ok: false, error: publicError(error) };
  }
}

function initializeChatGptSubscription() {
  if (!isChatGptSubscriptionEnabled()) return;
  try {
    const store = new ChatGptCredentialStore({
      dir: path.join(app.getPath('userData'), 'chatgpt-subscription'),
      encryption: createSafeStorageAdapter(safeStorage),
    });
    chatgptService = new ChatGptSubscriptionService({
      enabled: true,
      store,
      oauth: new ChatGptOAuthClient(),
      openExternal: (url) => shell.openExternal(url),
      logger: (event) => {
        const code = event && event.code ? ` (${event.code})` : '';
        const name = event && event.event ? event.event : 'event';
        console.warn(`[chatgpt] ${name}${code}`);
      },
    });
    chatgptService.init();
  } catch {
    chatgptService = null;
    console.warn('[chatgpt] integration initialization failed');
  }
}

function registerIpc() {
  trustedHandle('desktop:getVaultInfo', async () => {
    const state = readState();
    let candidate = null;
    if (typeof state.lastVaultPath === 'string' && state.lastVaultPath.trim()) {
      try {
        if (fs.existsSync(state.lastVaultPath)) {
          candidate = authorizeRoot(state.lastVaultPath, allowedRoots, rootIdentities);
        }
      } catch (error) {
        console.warn('[desktop] remembered Vault is no longer usable:', error?.message || error);
      }
    }
    if (!candidate && fs.existsSync(managedVaultRoot)) {
      try {
        candidate = authorizeRoot(managedVaultRoot, allowedRoots, rootIdentities);
      } catch (error) {
        console.warn('[desktop] managed Vault is no longer usable:', error?.message || error);
      }
    }
    return vaultInfo(candidate || managedVaultRoot);
  });

  trustedHandle('desktop:ensureManagedVault', async () => {
    fs.mkdirSync(managedVaultRoot, { recursive: true });
    if (fs.lstatSync(managedVaultRoot).isSymbolicLink()) {
      throw new Error('The managed Vault path must not be a symbolic link.');
    }
    const real = authorizeRoot(managedVaultRoot, allowedRoots, rootIdentities);
    return vaultInfo(real);
  });

  trustedHandle('desktop:chooseVaultDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a Recipe Vault folder',
      defaultPath: isolateDocumentsRoot(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    // AUTHORIZE ONLY. The renderer persists this candidate through
    // desktop:setActiveVault after its scan/transition is accepted.
    const real = authorizeRoot(result.filePaths[0], allowedRoots, rootIdentities, {
      refreshIdentity: true,
    });
    return vaultInfo(real);
  });

  trustedHandle('desktop:setActiveVault', async (_event, requestedRoot) => {
    try {
      const real = commitAcceptedVault({
        requestedRoot,
        allowedRoots,
        state: vaultState,
        rootIdentities,
      });
      activeVaultRoot = real;
      return vaultInfo(real);
    } catch (error) {
      // A state-write failure still identifies the authorized session root the
      // renderer accepted. Keep Open Vault Folder aligned with the open window,
      // while the persisted restart authority remains the previous Vault.
      if (error && error.desktopVaultRoot) activeVaultRoot = error.desktopVaultRoot;
      throw error;
    }
  });

  trustedHandle('desktop:openVaultFolder', async () => openActiveVaultFolder());

  trustedHandle('desktop:beginInitialization', async (_event, requestedRoot) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    const status = initializationStatus(root, identity);
    if (status === 'complete') return { action: 'already', root };
    if (status === 'initializing') return { action: 'resume', root };
    const existingMarkdown = listMarkdownFilesRecursive(root, identity);
    if (existingMarkdown.length > 0) return { action: 'existing', root };

    vaultFs.mkdir(root, MARKER_DIR, identity);
    try {
      vaultFs.writeText(
        root,
        `${MARKER_DIR}/${MARKER_FILE}`,
        JSON.stringify({ status: 'initializing', createdAt: new Date().toISOString() }, null, 2),
        identity,
        { exclusive: true }
      );
      return { action: 'claimed', root };
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        const nextStatus = initializationStatus(root, identity);
        if (nextStatus === 'complete') return { action: 'already', root };
        if (nextStatus === 'initializing') return { action: 'resume', root };
        throw new Error('The Vault initialization marker is not a regular file.');
      }
      throw error;
    }
  });

  trustedHandle('desktop:completeInitialization', async (_event, requestedRoot) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    vaultFs.mkdir(root, MARKER_DIR, identity);
    vaultFs.writeText(
      root,
      `${MARKER_DIR}/${MARKER_FILE}`,
      JSON.stringify({ status: 'complete', completedAt: new Date().toISOString() }, null, 2),
      identity
    );
    return { completed: true };
  });

  trustedHandle('desktop:list', async (_event, requestedRoot, relative) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    return vaultFs.list(root, normalizeRelative(relative), identity);
  });

  trustedHandle('desktop:stat', async (_event, requestedRoot, relative) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    return vaultFs.stat(root, normalizeRelative(relative), identity);
  });

  trustedHandle('desktop:exists', async (_event, requestedRoot, relative) => {
    try {
      const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
      return vaultFs.exists(root, normalizeRelative(relative), identity);
    } catch {
      return false;
    }
  });

  trustedHandle('desktop:readText', async (_event, requestedRoot, relative) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    return vaultFs.readText(root, normalizeRelative(relative), identity);
  });

  trustedHandle('desktop:readBinary', async (_event, requestedRoot, relative) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    return vaultFs.readBinary(root, normalizeRelative(relative), identity).toString('base64');
  });

  trustedHandle('desktop:writeText', async (_event, requestedRoot, relative, content) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    vaultFs.writeText(root, normalizeRelative(relative), content, identity);
    return { written: true };
  });

  trustedHandle('desktop:writeBinary', async (_event, requestedRoot, relative, base64) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    vaultFs.writeBinary(
      root,
      normalizeRelative(relative),
      Buffer.from(String(base64 ?? ''), 'base64'),
      identity
    );
    return { written: true };
  });

  trustedHandle('desktop:writeTextIfUnchanged', async (_event, requestedRoot, relative, content, expected) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    vaultFs.writeTextIfUnchanged(
      root,
      normalizeRelative(relative),
      content,
      expected,
      identity
    );
    return { written: true };
  });

  trustedHandle('desktop:mkdir', async (_event, requestedRoot, relative) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    vaultFs.mkdir(root, normalizeRelative(relative), identity);
    return { created: true };
  });

  trustedHandle('desktop:remove', async (_event, requestedRoot, relative) => {
    const { path: root, identity } = ensureAllowedVaultRoot(requestedRoot);
    vaultFs.remove(root, normalizeRelative(relative), identity);
    return { removed: true };
  });

  trustedHandle('desktop:getAppInfo', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
  }));

  trustedHandle('chatgpt:status', async () => chatGptStatus());

  trustedHandle('chatgpt:connect', async (_event, options) =>
    chatGptResult((service) =>
      service.connect({
        accountKey: typeof options?.accountKey === 'string' ? options.accountKey : undefined,
        forceConsent: Boolean(options?.forceConsent),
      })
    )
  );

  trustedHandle('chatgpt:cancelConnect', async () =>
    chatGptResult((service) => ({ cancelled: service.cancelConnect() }))
  );

  trustedHandle('chatgpt:reconnect', async (_event, accountKey) =>
    chatGptResult((service) =>
      service.reconnect(typeof accountKey === 'string' ? accountKey : undefined)
    )
  );

  trustedHandle('chatgpt:selectAccount', async (_event, accountKey) =>
    chatGptResult((service) =>
      service.selectAccount(typeof accountKey === 'string' ? accountKey : '')
    )
  );

  trustedHandle('chatgpt:disconnect', async (_event, accountKey) =>
    chatGptResult((service) =>
      service.disconnect(typeof accountKey === 'string' ? accountKey : undefined)
    )
  );

  trustedHandle('chatgpt:models', async (_event, options) =>
    chatGptResult((service) =>
      service.models(
        typeof options?.accountKey === 'string' ? options.accountKey : undefined,
        { force: Boolean(options?.force) }
      )
    )
  );

  trustedHandle('chatgpt:infer', async (_event, request) =>
    chatGptResult((service) =>
      service.infer({
        accountKey: typeof request?.accountKey === 'string' ? request.accountKey : undefined,
        model: typeof request?.model === 'string' ? request.model : '',
        input: request?.input,
        instructions: typeof request?.instructions === 'string' ? request.instructions : undefined,
        requestId: typeof request?.requestId === 'string' ? request.requestId : undefined,
      })
    )
  );

  trustedHandle('chatgpt:cancel', async (_event, requestId) =>
    chatGptResult((service) => ({ cancelled: service.cancel(requestId) }))
  );

  trustedHandle('chatgpt:manageUsage', async () =>
    chatGptResult((service) => service.manageUsage())
  );
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function boot() {
  managedVaultRoot = computeManagedVaultRoot();
  statePath = path.join(app.getPath('userData'), STATE_FILE);
  vaultState = createDesktopVaultState(statePath);
  vaultState.loadPersistedVaultPath();
  try {
    vaultFs = require('./vaultFs.cjs');
  } catch (error) {
    dialog.showErrorBox(
      'The Kitchen Codex filesystem helper could not load',
      `${error?.message || String(error)}\n\nRun: npm run build:desktop:native`
    );
    app.quit();
    return;
  }
  initializeChatGptSubscription();
  try {
    await startBackend();
  } catch (error) {
    dialog.showErrorBox('The Kitchen Codex could not start', error?.message || String(error));
    app.quit();
    return;
  }
  registerIpc();
  buildMenu();
  try {
    await session.defaultSession.cookies.set({
      url: serverOrigin,
      name: 'tkc_desktop_session',
      value: desktopSessionToken,
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
    });
  } catch (error) {
    console.warn('[desktop] could not set the desktop session cookie:', error?.message || error);
  }
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(boot);
  app.on('activate', () => {
    if (!mainWindow && serverOrigin) createWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    try {
      chatgptService?.shutdown();
    } catch {
      /* best effort */
    }
    stopBackend();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
