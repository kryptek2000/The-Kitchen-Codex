import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatGptOAuthClient } = require('../../desktop/chatgpt/oauth.cjs');

const SECRET = 'sk-r6-diagnostic-secret-do-not-leak';
const SSE_COMPLETED = [
  `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'TKC R6 LOCAL OK' })}\n\n`,
  `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
].join('');

let server: http.Server;
let base: string;

function send(res: http.ServerResponse, status: number, headers: Record<string, string>, body = '') {
  res.writeHead(status, headers);
  res.end(body);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = String(req.url || '');
    if (route === '/sse-with-type') {
      send(res, 200, { 'content-type': 'text/event-stream' }, SSE_COMPLETED);
      return;
    }
    if (route === '/sse-missing-type') {
      send(res, 200, {}, SSE_COMPLETED);
      return;
    }
    if (route === '/json-safe') {
      const body = JSON.stringify({ error: { code: 'model_not_found', message: SECRET } });
      send(res, 200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-request-id': 'req_SECRET-PROMPT-ACCOUNT-TOKEN-DO-NOT-LEAK',
      }, body);
      return;
    }
    if (route === '/json-ct') {
      send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ error: { code: 'model_not_found' } }));
      return;
    }
    if (route === '/html') {
      const body = `<html>${SECRET}</html>`;
      send(res, 200, { 'content-type': 'text/html', 'content-length': String(Buffer.byteLength(body)) }, body);
      return;
    }
    if (route === '/empty') {
      send(res, 200, { 'content-length': '0' }, '');
      return;
    }
    if (route === '/204') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (route === '/oversized') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '9000' });
      res.end(JSON.stringify({ detail: SECRET }));
      return;
    }
    if (route === '/chunked-oversized') {
      res.writeHead(200, {});
      res.write('A'.repeat(6000));
      res.write('B'.repeat(6000));
      res.end();
      return;
    }
    if (route === '/redirect') {
      res.writeHead(302, { location: '/json-safe' });
      res.end();
      return;
    }
    if (route === '/truncated') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"partial":');
      res.destroy();
      return;
    }
    if (route === '/stalled') {
      res.writeHead(200, {});
      res.write('data: ');
      // Deliberately never end; the diagnostic reader must time out.
      return;
    }
    if (route === '/cancel') {
      res.writeHead(200, {});
      res.write('data: ');
      return;
    }
    send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test server address.');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function failure(route: string, signal?: AbortSignal): Promise<any> {
  const client = new ChatGptOAuthClient({ responsesUrl: `${base}${route}` });
  try {
    await client.streamResponse({
      accessToken: 'synthetic-not-a-real-token',
      model: 'gpt-6.2-sol',
      input: [{ role: 'user', content: 'Reply with exactly: TKC CONNECTION OK' }],
      signal,
      onDelta: () => {},
    });
  } catch (error) {
    return error;
  }
  throw new Error(`Expected ${route} to fail closed.`);
}

function expectDiagnostic(message: string, bodyClass: string, readState: string) {
  expect(message).toContain('media=');
  expect(message).toContain(`body=${bodyClass}`);
  expect(message).toContain(`read=${readState}`);
  expect(message).toContain('redirect=');
  expect(message).toContain('origin=unexpected');
  expect(message).toContain('type=');
  expect(message).toContain('content_length=');
  expect(message).toContain('transfer_encoding=');
  expect(message).toContain('Nothing was accepted.');
}

describe('R6 unexpected-response diagnostics', () => {
  it('accepts legitimate SSE with the expected content type', async () => {
    const client = new ChatGptOAuthClient({ responsesUrl: `${base}/sse-with-type` });
    await expect(client.streamResponse({
      accessToken: 'synthetic-not-a-real-token',
      model: 'gpt-6.2-sol',
      input: [{ role: 'user', content: 'Reply with exactly: TKC CONNECTION OK' }],
      onDelta: () => {},
    })).resolves.toMatchObject({ text: 'TKC R6 LOCAL OK', model: 'gpt-6.2-sol' });
  });

  it('classifies SSE-like body when Content-Type is missing and does not accept it', async () => {
    const error = await failure('/sse-missing-type');
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('no content type');
    expectDiagnostic(error.message, 'sse-like', 'complete');
    expect(error.message).not.toContain('TKC R6 LOCAL OK');
  });

  it('classifies a JSON body with a safe provider code and redacts body/header secrets', async () => {
    const error = await failure('/json-safe');
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('provider=model_not_found');
    expect(error.message).toContain('content_length=present');
    expectDiagnostic(error.message, 'json', 'complete');
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(error.message).not.toContain('req_SECRET');
  });

  it('classifies application/json error bodies', async () => {
    const error = await failure('/json-ct');
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('JSON error');
    expectDiagnostic(error.message, 'json', 'complete');
  });

  it('classifies HTML and empty bodies without exposing content', async () => {
    const html = await failure('/html');
    expect(html).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expectDiagnostic(html.message, 'html', 'complete');
    expect(html.message).not.toContain(SECRET);

    const empty = await failure('/empty');
    expect(empty).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expectDiagnostic(empty.message, 'empty', 'complete');
  });

  it('classifies 204 empty and declared oversized bodies without reading the latter', async () => {
    const empty = await failure('/204');
    expect(empty).toMatchObject({ code: 'RESPONSE_FAILED', status: 204 });
    expectDiagnostic(empty.message, 'empty', 'empty');

    const oversized = await failure('/oversized');
    expect(oversized).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expectDiagnostic(oversized.message, 'other', 'oversized');
    expect(oversized.message).not.toContain(SECRET);
  });

  it('cancels chunked oversized bodies at the 8 KiB bound', async () => {
    const error = await failure('/chunked-oversized');
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expectDiagnostic(error.message, 'other', 'oversized');
  });

  it('classifies redirected final responses and marks unexpected origin', async () => {
    const error = await failure('/redirect');
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('redirect=yes');
    expectDiagnostic(error.message, 'json', 'complete');
  });

  it('rejects truncated transport safely and redacts its bytes', async () => {
    const error = await failure('/truncated');
    expect(error).toMatchObject({ code: 'NETWORK' });
    expect(error.message).not.toContain(SECRET);
  });

  it('classifies unreadable diagnostic bodies without exposing bytes', async () => {
    const response = {
      ok: true,
      status: 200,
      headers: { get: (name: string) => name === 'content-type' ? null : null },
      body: {
        getReader() {
          return {
            read: async () => { throw new Error(`unreadable ${SECRET}`); },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    };
    const client = new ChatGptOAuthClient({ fetchFn: async () => response });
    let error: any = null;
    try {
      await client.streamResponse({
        accessToken: 'synthetic-not-a-real-token',
        model: 'gpt-6.2-sol',
        input: [{ role: 'user', content: 'Reply with exactly: TKC CONNECTION OK' }],
        onDelta: () => {},
      });
    } catch (nextError) {
      error = nextError;
    }
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('body=other');
    expect(error.message).toContain('read=unreadable');
    expect(error.message).not.toContain(SECRET);
  });

  it('classifies an expected-origin mock response without exposing its URL', async () => {
    const response = {
      ok: true,
      status: 200,
      url: 'https://api.openai.com/v1/responses',
      redirected: false,
      type: 'basic',
      headers: {
        get: (name: string) => name === 'content-type' ? null : null,
      },
      body: null,
    };
    const client = new ChatGptOAuthClient({ fetchFn: async () => response });
    let error: any = null;
    try {
      await client.streamResponse({
        accessToken: 'synthetic-not-a-real-token',
        model: 'gpt-6.2-sol',
        input: [{ role: 'user', content: 'Reply with exactly: TKC CONNECTION OK' }],
        onDelta: () => {},
      });
    } catch (nextError) {
      error = nextError;
    }
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('body=empty');
    expect(error.message).toContain('read=empty');
    expect(error.message).toContain('redirect=no');
    expect(error.message).toContain('origin=expected');
    expect(error.message).toContain('type=basic');
    expect(error.message).not.toContain('api.openai.com');
  });


  it('never exposes a raw unexpected URL or response type', async () => {
    const response = {
      ok: true,
      status: 200,
      url: `https://evil.example/${SECRET}`,
      redirected: false,
      type: SECRET,
      headers: { get: (name: string) => name === 'content-type' ? null : null },
      body: null,
    };
    const client = new ChatGptOAuthClient({ fetchFn: async () => response });
    let error: any = null;
    try {
      await client.streamResponse({
        accessToken: 'synthetic-not-a-real-token',
        model: 'gpt-6.2-sol',
        input: [{ role: 'user', content: 'Reply with exactly: TKC CONNECTION OK' }],
        onDelta: () => {},
      });
    } catch (nextError) {
      error = nextError;
    }
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('origin=unexpected');
    expect(error.message).toContain('type=other');
    expect(error.message).not.toContain('evil.example');
    expect(error.message).not.toContain(SECRET);
  });

  it('classifies stalled bodies with a bounded diagnostic timeout', async () => {
    const error = await failure('/stalled');
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expectDiagnostic(error.message, 'other', 'stalled');
  }, 8000);

  it('preserves cancellation while reading a diagnostic body', async () => {
    const controller = new AbortController();
    const pending = failure('/cancel', controller.signal);
    setTimeout(() => controller.abort(), 150);
    const error = await pending;
    expect(error).toMatchObject({ code: 'CANCELLED' });
  });
});
