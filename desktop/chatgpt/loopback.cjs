/**
 * Single-use loopback OAuth callback listener.
 *
 * Binds only 127.0.0.1 on an ephemeral port. The exact path is fixed by the
 * caller (the documented /auth/callback). Invalid state never consumes the
 * pending authorization attempt.
 */

'use strict';

const http = require('node:http');
const { equalSecret } = require('./pkce.cjs');
const { errorFor } = require('./errors.cjs');

function htmlResponse(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="font-family:system-ui,sans-serif;background:#0c0c0c;color:#f3f4f6;padding:3rem;line-height:1.6">' +
    `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body></html>`;
}

function send(res, status, title, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(htmlResponse(title, body));
}

function createLoopbackCallbackServer({
  expectedState,
  path = '/auth/callback',
  timeoutMs = 5 * 60 * 1000,
  signal,
}) {
  if (!expectedState) throw new Error('Loopback callback requires an expected state.');
  if (signal?.aborted) return Promise.reject(errorFor('CANCELLED'));
  let settled = false;
  let timer = null;
  let resolveWait;
  let rejectWait;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== path) return send(res, 404, 'Not found', 'This callback path is not valid.');
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'Use the browser callback.');
      if (url.searchParams.getAll('state').length !== 1) {
        return send(res, 400, 'Invalid sign-in response', 'The sign-in response did not include one state value.');
      }
      if (!equalSecret(url.searchParams.get('state'), expectedState)) {
        return send(res, 400, 'Sign-in response rejected', 'The state value did not match this sign-in attempt.');
      }
      if (settled) return send(res, 409, 'Already completed', 'This sign-in attempt is already complete.');

      const duplicateKeys = ['code', 'error', 'client_id'].filter(
        (key) => url.searchParams.getAll(key).length > 1
      );
      if (duplicateKeys.length > 0) {
        settled = true;
        cleanup();
        rejectWait(errorFor('AUTHENTICATION_FAILED', 'The sign-in callback contained duplicate parameters.'));
        return send(res, 400, 'Invalid sign-in response', 'The sign-in response was malformed.');
      }

      const params = {};
      for (const key of ['code', 'state', 'error', 'error_description', 'client_id', 'scope']) {
        const value = url.searchParams.get(key);
        if (value !== null) params[key] = value;
      }
      if (!params.code && !params.error) {
        settled = true;
        cleanup();
        rejectWait(errorFor('AUTHENTICATION_FAILED', 'The sign-in callback did not include a code.'));
        return send(res, 400, 'Invalid sign-in response', 'The sign-in response did not include a code.');
      }

      settled = true;
      cleanup();
      if (params.error) {
        send(res, 200, 'Sign-in not completed', 'You can close this window and return to The Kitchen Codex.');
      } else {
        send(res, 200, 'Connected to The Kitchen Codex', 'You can close this window and return to the app.');
      }
      resolveWait(params);
    } catch {
      if (!res.headersSent) send(res, 400, 'Invalid request', 'The callback could not be read.');
    }
  });

  const close = () => {
    try {
      server.close();
    } catch {
      /* best effort */
    }
  };
  const removeAbort = () => {
    try {
      signal?.removeEventListener('abort', onAbort);
    } catch {
      /* best effort */
    }
  };
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    removeAbort();
    close();
  };
  const onAbort = () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectWait(errorFor('CANCELLED', 'ChatGPT sign-in was cancelled.'));
  };

  const wait = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const listening = new Promise((resolve, reject) => {
    const onServerError = (error) => {
      removeAbort();
      reject(error);
    };
    server.once('error', onServerError);
    signal?.addEventListener('abort', onAbort, { once: true });
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onServerError);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        cleanup();
        reject(errorFor('NETWORK', 'The local sign-in callback could not bind.'));
        return;
      }
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectWait(errorFor('TIMEOUT', 'ChatGPT sign-in was not completed in time.'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}${path}`,
        wait,
        close: () => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectWait(errorFor('CANCELLED', 'ChatGPT sign-in was cancelled.'));
        },
      });
    });
  });

  return listening;
}

module.exports = {
  createLoopbackCallbackServer,
};
