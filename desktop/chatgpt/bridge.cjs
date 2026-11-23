/**
 * Trusted native ChatGPT plan bridge for the local application server.
 *
 * The Electron main process already owns the OAuth session. The server process
 * is a separate child, so it needs a narrow way to ask for a completion without
 * ever seeing a token. This loopback-only HTTP bridge is that path:
 *
 *   local server  -- 127.0.0.1 + random bearer token -->  Electron main
 *
 * SECURITY:
 *   - binds 127.0.0.1 only, on an ephemeral port;
 *   - requires a 32-byte per-process bearer token in constant time;
 *   - accepts only bounded GET /v1/models and POST /v1/infer requests;
 *   - never returns tokens, account emails, prompts, or raw upstream bodies;
 *   - the bearer token is passed only to the server child environment and is
 *     never exposed through IPC, the renderer, logs, or settings.
 */

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { publicError } = require('./errors.cjs');

const MAX_BODY_BYTES = 192 * 1024;
const MAX_MODELS = 64;

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function readBoundedBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        finish(reject, new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => finish(reject, error));
  });
}

function parseJson(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sanitizeModelRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 160) : id,
    });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/**
 * Starts the loopback bridge. Returns `{ url, token, close }` once listening.
 * The bridge is disabled when the ChatGPT service is unavailable.
 */
function createChatGptPlanBridge({ service, logger = () => {} }) {
  if (!service) return Promise.resolve(null);
  const token = crypto.randomBytes(32).toString('hex');

  const server = http.createServer((req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Local bridge access only.' } });
      return;
    }
    const supplied = String(req.headers.authorization || '');
    const expected = `Bearer ${token}`;
    if (!constantTimeEqual(supplied, expected)) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Bridge authorization required.' } });
      return;
    }
    void handle(req, res).catch(() => {
      sendJson(res, 500, { ok: false, error: { code: 'BRIDGE_ERROR', message: 'The local ChatGPT bridge failed.' } });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      let status;
      try {
        status = service.status();
      } catch {
        sendJson(res, 200, {
          ok: true,
          connected: false,
          planEnabled: false,
          activeAccountKey: null,
          models: [],
        });
        return;
      }
      const active = status.activeAccount;
      if (!status.connected || !active || !active.planEnabled || active.signedOut) {
        sendJson(res, 200, {
          ok: true,
          connected: false,
          planEnabled: false,
          activeAccountKey: active?.accountKey || null,
          models: [],
        });
        return;
      }
      const requestedAccount = url.searchParams.get('accountKey') || undefined;
      try {
        logger({ event: 'chatgpt.bridge_models' });
        const models = await service.models(requestedAccount, { signal: AbortSignal.timeout(15_000) });
        sendJson(res, 200, {
          ok: true,
          connected: true,
          planEnabled: true,
          activeAccountKey: status.activeAccount.accountKey,
          models: sanitizeModelRows(models),
        });
      } catch (error) {
        // A model failure is returned as connection truth, not as a successful
        // empty catalog. The server cache still fails closed.
        sendJson(res, 200, {
          ok: false,
          connected: false,
          planEnabled: false,
          activeAccountKey: status.activeAccount.accountKey,
          models: [],
          error: publicError(error),
        });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/infer') {
      let raw;
      try {
        raw = await readBoundedBody(req);
      } catch {
        sendJson(res, 413, { ok: false, error: { code: 'INVALID_REQUEST', message: 'The ChatGPT request is too large.' } });
        return;
      }
      const body = parseJson(raw);
      if (!body) {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'The ChatGPT request is not valid.' } });
        return;
      }
      const requestId =
        typeof body.requestId === 'string' && body.requestId
          ? body.requestId
          : crypto.randomUUID();
      let closed = false;
      res.on('close', () => {
        if (res.writableEnded) return;
        closed = true;
        try {
          service.cancel(requestId);
        } catch {
          /* best effort */
        }
      });
      try {
        logger({ event: 'chatgpt.bridge_infer' });
        const value = await service.infer({
          accountKey: typeof body.accountKey === 'string' ? body.accountKey : undefined,
          model: typeof body.model === 'string' ? body.model : '',
          input: body.input,
          instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
          requestId,
        });
        if (!closed) sendJson(res, 200, { ok: true, value });
      } catch (error) {
        if (!closed) sendJson(res, 200, { ok: false, error: publicError(error) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown local bridge path.' } });
  }

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        try {
          server.close();
        } catch {
          /* best effort */
        }
        reject(new Error('The local ChatGPT bridge did not receive a loopback port.'));
        return;
      }
      const url = `http://127.0.0.1:${address.port}`;
      logger({ event: 'chatgpt.bridge_started' });
      resolve({
        url,
        token,
        close: () =>
          new Promise((done) => {
            try {
              server.close(() => done());
            } catch {
              done();
            }
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

module.exports = {
  createChatGptPlanBridge,
  MAX_BODY_BYTES,
};
