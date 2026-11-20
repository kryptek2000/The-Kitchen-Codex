/**
 * The Kitchen Codex — secure Electron preload bridge.
 *
 * Exposes only the narrow native Vault operations needed by the existing
 * File-System-Access-compatible renderer adapter. No Node, fs, child_process,
 * shell, provider secrets, or arbitrary IPC is exposed.
 *
 * The bridge is installed only in the top-level frame whose committed origin
 * exactly matches the main-process-issued application origin. A foreign or
 * nested frame gets no privileged API even if a future navigation policy bug
 * lets it load.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const APP_ORIGIN_ARGUMENT = '--tkc-app-origin=';

function expectedApplicationOrigin() {
  const argument = (process.argv || []).find((value) =>
    typeof value === 'string' && value.startsWith(APP_ORIGIN_ARGUMENT)
  );
  return argument ? argument.slice(APP_ORIGIN_ARGUMENT.length) : '';
}

function isTopLevelApplicationFrame() {
  try {
    const expectedOrigin = expectedApplicationOrigin();
    return (
      typeof window !== 'undefined' &&
      window.top === window &&
      Boolean(expectedOrigin) &&
      window.location.origin === expectedOrigin
    );
  } catch {
    return false;
  }
}

if (isTopLevelApplicationFrame()) {
  contextBridge.exposeInMainWorld('kitchenCodexDesktop', {
    isDesktop: true,
    platform: process.platform,
    getAppInfo: () => invoke('desktop:getAppInfo'),
    getVaultInfo: () => invoke('desktop:getVaultInfo'),
    ensureManagedVault: () => invoke('desktop:ensureManagedVault'),
    chooseVaultDirectory: () => invoke('desktop:chooseVaultDirectory'),
    setActiveVault: (root) => invoke('desktop:setActiveVault', root),
    // Argument-free by design: main resolves the currently accepted Vault.
    openVaultFolder: () => invoke('desktop:openVaultFolder'),
    beginInitialization: (root) => invoke('desktop:beginInitialization', root),
    completeInitialization: (root) => invoke('desktop:completeInitialization', root),
    list: (root, relative) => invoke('desktop:list', root, relative),
    stat: (root, relative) => invoke('desktop:stat', root, relative),
    exists: (root, relative) => invoke('desktop:exists', root, relative),
    readText: (root, relative) => invoke('desktop:readText', root, relative),
    readBinary: (root, relative) => invoke('desktop:readBinary', root, relative),
    writeText: (root, relative, content) => invoke('desktop:writeText', root, relative, content),
    writeBinary: (root, relative, base64) => invoke('desktop:writeBinary', root, relative, base64),
    writeTextIfUnchanged: (root, relative, content, expected) =>
      invoke('desktop:writeTextIfUnchanged', root, relative, content, expected),
    mkdir: (root, relative) => invoke('desktop:mkdir', root, relative),
    remove: (root, relative) => invoke('desktop:remove', root, relative),

    // Sign in with ChatGPT plan usage. Tokens remain in the Electron main
    // process; this bridge exposes only account state and completed text.
    chatgpt: {
      status: () => invoke('chatgpt:status'),
      connect: (options) => invoke('chatgpt:connect', options),
      cancelConnect: () => invoke('chatgpt:cancelConnect'),
      reconnect: (accountKey) => invoke('chatgpt:reconnect', accountKey),
      selectAccount: (accountKey) => invoke('chatgpt:selectAccount', accountKey),
      disconnect: (accountKey) => invoke('chatgpt:disconnect', accountKey),
      models: (options) => invoke('chatgpt:models', options),
      infer: (request) => invoke('chatgpt:infer', request),
      cancel: (requestId) => invoke('chatgpt:cancel', requestId),
      manageUsage: () => invoke('chatgpt:manageUsage'),
    },
  });
}
