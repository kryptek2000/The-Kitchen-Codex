/**
 * Electron origin and IPC sender policy for The Kitchen Codex desktop shell.
 *
 * Kept independent of Electron so the exact origin comparison and sender-frame
 * checks can be adversarially regression-tested in Node. The desktop shell only
 * accepts the exact loopback application origin; prefix/substring/userinfo
 * comparisons are forbidden.
 */

'use strict';

function originOf(value) {
  const url = new URL(String(value ?? ''));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported application URL protocol.');
  }
  if (url.username || url.password) {
    throw new Error('Application URLs must not contain credentials.');
  }
  return url.origin;
}

function isSameOrigin(targetUrl, appOrigin) {
  try {
    return originOf(targetUrl) === originOf(appOrigin);
  } catch {
    return false;
  }
}

/**
 * True only for the top frame of the expected BrowserWindow, whose committed
 * URL is the exact application origin. All IPC handlers use this; navigation
 * policy is a second, independent layer.
 */
/**
 * True only for an editable/selection context menu in the trust boundary.
 * Foreign frames, subframes, and destroyed frames never receive a menu.
 */
function isTrustedContextMenuTarget(params, appOrigin) {
  try {
    if (!params || !params.frame) return false;
    if (params.frame.parent) return false;
    if (params.frame.url && !isSameOrigin(params.frame.url, appOrigin)) return false;
    if (params.frameURL && !isSameOrigin(params.frameURL, appOrigin)) return false;
    if (params.pageURL && !isSameOrigin(params.pageURL, appOrigin)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Standard edit menu for editable fields. No privileged Electron actions are
 * exposed; roles only act on the focused renderer control.
 */
function contextMenuTemplate(params) {
  if (!params || typeof params !== 'object') return [];
  const flags = params.editFlags || {};
  const enabled = (key) => flags[key] !== false;
  if (params.isEditable) {
    return [
      { role: 'undo', enabled: enabled('canUndo') },
      { role: 'redo', enabled: enabled('canRedo') },
      { type: 'separator' },
      { role: 'cut', enabled: enabled('canCut') },
      { role: 'copy', enabled: enabled('canCopy') },
      { role: 'paste', enabled: enabled('canPaste') },
      { type: 'separator' },
      { role: 'selectAll', enabled: enabled('canSelectAll') },
    ];
  }
  if (typeof params.selectionText === 'string' && params.selectionText.trim()) {
    return [
      { role: 'copy', enabled: enabled('canCopy') },
      { type: 'separator' },
      { role: 'selectAll', enabled: enabled('canSelectAll') },
    ];
  }
  return [];
}

function installContextMenu(webContents, appOrigin, menuApi, window) {
  webContents.on('context-menu', (_event, params) => {
    if (!isTrustedContextMenuTarget(params, appOrigin)) return;
    const template = contextMenuTemplate(params);
    if (template.length === 0) return;
    try {
      menuApi.buildFromTemplate(template).popup({ window });
    } catch {
      // A menu failure must never affect the renderer or navigation policy.
    }
  });
}

function isTrustedIpcSender(event, appOrigin, expectedWebContents) {
  try {
    if (!event || !event.sender) return false;
    if (expectedWebContents && event.sender !== expectedWebContents) return false;

    const frame = event.senderFrame;
    if (!frame || frame.destroyed) return false;
    // Only the top-level application document may call the privileged bridge.
    if (frame.parent) return false;
    if (event.sender.mainFrame && frame !== event.sender.mainFrame) return false;

    if (!isSameOrigin(frame.url, appOrigin)) return false;
    if (typeof event.sender.getURL === 'function' && !isSameOrigin(event.sender.getURL(), appOrigin)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertTrustedIpcSender(event, appOrigin, expectedWebContents) {
  if (isTrustedIpcSender(event, appOrigin, expectedWebContents)) return;
  const error = new Error('The desktop IPC sender is not authorized for this application.');
  error.code = 'DESKTOP_IPC_UNAUTHORIZED';
  throw error;
}

/**
 * Install navigation, redirect, subframe-navigation, window-open, and webview
 * guards for one BrowserWindow. Same-origin application navigation remains
 * allowed; every foreign or malformed URL is blocked before commit.
 */
function installNavigationGuards(webContents, appOrigin, onBlocked) {
  const report = (kind, url) => {
    try {
      onBlocked?.(kind, url);
    } catch {
      // logging must never weaken the guard
    }
  };

  const guard = (details) => {
    const url = details && typeof details.url === 'string' ? details.url : '';
    if (isSameOrigin(url, appOrigin)) return;
    details.preventDefault();
    report('navigation', url);
  };

  webContents.on('will-navigate', guard);
  webContents.on('will-redirect', guard);
  webContents.on('will-frame-navigate', guard);

  webContents.setWindowOpenHandler((details) => {
    report('window-open', details && details.url);
    return { action: 'deny' };
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    report('webview', 'will-attach-webview');
  });

  // Defense in depth: if a foreign document somehow commits despite the
  // pre-commit guards, close the window rather than leaving the bridge there.
  webContents.on('did-navigate', (_event, url) => {
    if (!isSameOrigin(url, appOrigin)) {
      report('committed-navigation', url);
      try {
        webContents.close();
      } catch {
        // best effort
      }
    }
  });
}

module.exports = {
  assertTrustedIpcSender,
  contextMenuTemplate,
  installContextMenu,
  installNavigationGuards,
  isSameOrigin,
  isTrustedContextMenuTarget,
  isTrustedIpcSender,
  originOf,
};
