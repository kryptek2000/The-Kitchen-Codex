import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ChatGptOAuthClient,
  MAX_RESPONSE_TEXT,
  MAX_SSE_EVENT_BYTES,
} = require('../../desktop/chatgpt/oauth.cjs');

const EXPECTED_URL = 'https://api.openai.com/v1/responses';
const encoder = new TextEncoder();

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function sse(...events: Array<unknown | string>): string {
  return events
    .map((value) => (typeof value === 'string' ? value : event(value)))
    .join('');
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function frameOfBytes(totalBytes: number): string {
  const empty = event({ type: 'response.created', padding: '' });
  const paddingLength = totalBytes - Buffer.byteLength(empty);
  if (paddingLength < 0) throw new Error('Frame boundary is smaller than the envelope.');
  return event({ type: 'response.created', padding: 'x'.repeat(paddingLength) });
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function responseWith(
  body: ReadableStream<Uint8Array> | null,
  {
    status = 200,
    contentType = null,
    url = EXPECTED_URL,
    redirected = false,
  }: {
    status?: number;
    contentType?: string | null;
    url?: string;
    redirected?: boolean;
  } = {}
): Response {
  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'redirected', { value: redirected });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
}

function sseResponse(
  body: ReadableStream<Uint8Array> | string,
  options: Parameters<typeof responseWith>[1] = {}
): Response {
  const stream = typeof body === 'string' ? streamOf([bytes(body)]) : body;
  return responseWith(stream, options);
}

async function infer(
  response: Response,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; model: string }> {
  const client = new ChatGptOAuthClient({ fetchFn: async () => response });
  return client.streamResponse({
    accessToken: 'synthetic-access-token',
    model: 'gpt-6.2-sol',
    input: [{ role: 'user', content: 'Reply with exactly: TKC CONNECTION OK' }],
    signal,
    onDelta,
  });
}

async function failure(response: Response): Promise<any> {
  try {
    await infer(response);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the compatibility path to fail closed.');
}

describe('R7 missing-Content-Type SSE compatibility', () => {
  it('accepts a complete SSE stream from the expected origin when Content-Type is absent', async () => {
    const body = `event: response.created\n${sse(
      { type: 'response.output_text.delta', delta: 'TKC CONNECTION ' },
      { type: 'response.output_text.delta', delta: 'OK ✓' },
      { type: 'response.completed', response: { status: 'completed' } }
    )}`;
    // Split every byte boundary, including inside the multibyte character.
    const chunks = Array.from(bytes(body), (value) => Uint8Array.of(value));
    await expect(infer(sseResponse(streamOf(chunks)))).resolves.toEqual({
      text: 'TKC CONNECTION OK ✓',
      model: 'gpt-6.2-sol',
    });
  });

  it('replays a prefix and carry exactly once for bodies larger than 8 KiB', async () => {
    const delta = 'x'.repeat(64);
    const events: Array<Record<string, unknown>> = Array.from({ length: 200 }, () => ({
      type: 'response.output_text.delta',
      delta,
    }));
    events.push({ type: 'response.completed', response: { status: 'completed' } });
    const body = sse(...events);
    expect(body.length).toBeGreaterThan(8192);

    // One oversized chunk forces the prefix probe to retain 1 KiB and carry
    // the remainder into the parser without duplication or loss.
    const result = await infer(sseResponse(streamOf([bytes(body)])));
    expect(result.text).toBe(delta.repeat(200));
  });

  it('rejects a missing-Content-Type stream that ends before response.completed', async () => {
    const error = await failure(
      sseResponse(sse({ type: 'response.output_text.delta', delta: 'partial' }))
    );
    expect(error).toMatchObject({ code: 'STREAM_INCOMPLETE' });
    expect(error.message).toContain('Nothing was accepted');
  });

  it('does not accept fake completion text embedded in deltas or JSON', async () => {
    const deltaOnly = await failure(
      sseResponse(
        sse(
          { type: 'response.output_text.delta', delta: 'response.completed' },
          { type: 'response.output_text.delta', delta: ' still not done' }
        )
      )
    );
    expect(deltaOnly).toMatchObject({ code: 'STREAM_INCOMPLETE' });

    const json = await failure(
      sseResponse(JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }))
    );
    expect(json).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(json.message).toContain('no content type');
  });

  it('rejects HTML that contains an SSE-looking completion line', async () => {
    const html = `<html>\n${event({
      type: 'response.completed',
      response: { status: 'completed' },
    })}</html>`;
    const error = await failure(sseResponse(html));
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('no content type');
    expect(error.message).toContain('body=html');
    expect(error.message).not.toContain('response.completed');
  });

  it('rejects malformed or non-object events after an SSE-like prefix', async () => {
    const malformed = await failure(
      sseResponse(sse({ type: 'response.output_text.delta', delta: 'A' }) + 'data: {not-json}\n\n')
    );
    expect(malformed).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(malformed.message).toContain('malformed stream event');

    const nonObject = await failure(
      sseResponse(sse({ type: 'response.output_text.delta', delta: 'A' }) + 'data: "completed"\n\n')
    );
    expect(nonObject).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(nonObject.message).toContain('malformed stream event');

    const nonStringDelta = await failure(
      sseResponse(sse({ type: 'response.output_text.delta', delta: 42 }))
    );
    expect(nonStringDelta).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(nonStringDelta.message).toContain('malformed stream event');
  });

  it('rejects a malformed completion event and a non-terminal completion status', async () => {
    const missingResponse = await failure(
      sseResponse(sse({ type: 'response.completed' }))
    );
    expect(missingResponse).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(missingResponse.message).toContain('malformed completion event');

    const notTerminal = await failure(
      sseResponse(sse({ type: 'response.completed', response: { status: 'in_progress' } }))
    );
    expect(notTerminal).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(notTerminal.message).toContain('non-terminal completion event');

    const emptyResponse = await failure(
      sseResponse(sse({ type: 'response.completed', response: {} }))
    );
    expect(emptyResponse).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(emptyResponse.message).toContain('non-terminal completion event');
  });

  it('enforces the existing response text limit', async () => {
    const error = await failure(
      sseResponse(
        sse(
          { type: 'response.output_text.delta', delta: 'x'.repeat(MAX_RESPONSE_TEXT + 1) },
          { type: 'response.completed', response: { status: 'completed' } }
        )
      )
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(error.message).toContain('text limit');
  });

  it('continues rejecting explicit JSON, HTML, and text content types', async () => {
    const body = sse(
      { type: 'response.output_text.delta', delta: 'must not be accepted' },
      { type: 'response.completed', response: { status: 'completed' } }
    );

    for (const contentType of ['application/json', 'text/html', 'text/plain']) {
      const error = await failure(sseResponse(body, { contentType }));
      expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
      expect(error.message).toContain('Nothing was accepted');
    }
  });

  it('rejects missing-Content-Type responses after a redirect or from another origin', async () => {
    const body = sse(
      { type: 'response.output_text.delta', delta: 'not accepted' },
      { type: 'response.completed', response: { status: 'completed' } }
    );

    const redirected = await failure(sseResponse(body, { redirected: true }));
    expect(redirected).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(redirected.message).toContain('redirect=yes');

    const otherOrigin = await failure(
      sseResponse(body, { url: 'https://evil.example/v1/responses' })
    );
    expect(otherOrigin).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(otherOrigin.message).toContain('origin=unexpected');
  });

  it('maps a usage-limit failure that arrives after streaming begins', async () => {
    const error = await failure(
      sseResponse(
        sse(
          { type: 'response.output_text.delta', delta: 'partial' },
          {
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { code: 'subscription_sharing_usage_limit_exceeded' },
            },
          }
        )
      )
    );
    expect(error).toMatchObject({
      code: 'SUBSCRIPTION_LIMIT',
      manageUsage: true,
    });
  });

  it('cancels a disconnected compatibility stream without accepting partial output', async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const initial = Array.from({ length: 20 }, (_, index) => ({
      type: 'response.output_text.delta',
      delta: `chunk-${index}-${'x'.repeat(40)}`,
    }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(bytes(sse(...initial)));
        setTimeout(() => {
          controllerRef?.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, 100);
      },
    });
    const pending = infer(sseResponse(body), () => {});
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('redacts provider text and never exposes the access token', async () => {
    const secret = 'sk-r7-secret-do-not-leak';
    const error = await failure(
      sseResponse(
        JSON.stringify({ error: { code: 'model_not_found', message: secret } })
      )
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('provider=model_not_found');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('synthetic-access-token');
  });
});

describe('R7-F2 terminal integrity', () => {
  const modes = [
    { name: 'ordinary SSE', contentType: 'text/event-stream' },
    { name: 'missing Content-Type', contentType: null },
  ] as const;
  const completed = { type: 'response.completed', response: { status: 'completed' } };

  function respond(body: string, mode: (typeof modes)[number]) {
    return sseResponse(
      body,
      mode.contentType ? { contentType: mode.contentType } : {}
    );
  }

  for (const mode of modes) {
    it(`accepts LF- and CRLF-terminated completions on ${mode.name}`, async () => {
      for (const body of [
        `data: ${JSON.stringify(completed)}\n\n`,
        `data: ${JSON.stringify(completed)}\r\n\r\n`,
      ]) {
        await expect(infer(respond(body, mode))).resolves.toEqual({
          text: '',
          model: 'gpt-6.2-sol',
        });
      }
    });

    it(`rejects unterminated completions at EOF on ${mode.name}`, async () => {
      const bare = `data: ${JSON.stringify(completed)}`;
      for (const body of [bare, `${bare}\n`, `${bare}\r\n`]) {
        const error = await failure(respond(body, mode));
        expect(error).toMatchObject({ code: 'STREAM_INCOMPLETE' });
      }
    });

    it(`rejects a delta after completion on ${mode.name}`, async () => {
      const deltas: string[] = [];
      const body =
        sse({ type: 'response.output_text.delta', delta: 'before' }) +
        sse(completed) +
        sse({ type: 'response.output_text.delta', delta: 'after' });
      let error: any = null;
      try {
        await infer(respond(body, mode), (delta) => deltas.push(delta));
      } catch (nextError) {
        error = nextError;
      }
      expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
      expect(error.message).toContain('after the completion event');
      expect(deltas).toEqual(['before']);
    });

    it(`rejects duplicate and contradictory events after completion on ${mode.name}`, async () => {
      const bodies = [
        sse(completed) + sse(completed),
        sse(completed) +
          sse({
            type: 'response.failed',
            response: { status: 'failed', error: { code: 'server_error' } },
          }),
        sse(completed) + sse({ type: 'response.incomplete' }),
      ];
      for (const body of bodies) {
        const error = await failure(respond(body, mode));
        expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
        expect(error.message).toContain('after the completion event');
      }
    });

    it(`rejects non-terminal completion statuses on ${mode.name}`, async () => {
      for (const status of ['failed', 'incomplete']) {
        const error = await failure(
          respond(
            sse({ type: 'response.completed', response: { status } }),
            mode
          )
        );
        expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
        expect(error.message).toContain('non-terminal completion event');
      }
    });
  }

  it('accepts a completion split across every byte boundary', async () => {
    const body = `data: ${JSON.stringify(completed)}\r\n\r\n`;
    const chunks = Array.from(bytes(body), (value) => Uint8Array.of(value));
    await expect(
      infer(sseResponse(streamOf(chunks), { contentType: 'text/event-stream' }))
    ).resolves.toEqual({ text: '', model: 'gpt-6.2-sol' });
  });

  it('fails closed when a completion line is interrupted before its delimiter', async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(bytes(`data: ${JSON.stringify(completed)}\n`));
        setTimeout(() => {
          controllerRef?.error(Object.assign(new Error('reset'), { name: 'AbortError' }));
        }, 100);
      },
    });
    await expect(infer(sseResponse(body), () => {})).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });
});

describe('R7-F1 bounded SSE frame handling', () => {
  it('rejects a 4 MiB first chunk on the missing-Content-Type path', async () => {
    const chunk = bytes(`data: ${'x'.repeat(4 * 1024 * 1024)}`);
    const error = await failure(sseResponse(streamOf([chunk])));
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(error.message).toContain('exceeded the size limit');
  });

  it('rejects an oversized event on the ordinary SSE path', async () => {
    const error = await failure(
      sseResponse(frameOfBytes(MAX_SSE_EVENT_BYTES + 1), {
        contentType: 'text/event-stream',
      })
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(error.message).toContain('exceeded the size limit');
  });

  it('rejects an oversized event crossing multiple chunks', async () => {
    const encoded = bytes(frameOfBytes(MAX_SSE_EVENT_BYTES + 4096));
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < encoded.length; offset += 64 * 1024) {
      chunks.push(encoded.slice(offset, offset + 64 * 1024));
    }
    const error = await failure(
      sseResponse(streamOf(chunks), { contentType: 'text/event-stream' })
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(error.message).toContain('exceeded the size limit');
  });

  it('accepts an event exactly at the frame boundary', async () => {
    const frame = frameOfBytes(MAX_SSE_EVENT_BYTES);
    expect(Buffer.byteLength(frame)).toBe(MAX_SSE_EVENT_BYTES);
    const body =
      frame + sse({ type: 'response.completed', response: { status: 'completed' } });
    await expect(
      infer(sseResponse(body, { contentType: 'text/event-stream' }))
    ).resolves.toEqual({ text: '', model: 'gpt-6.2-sol' });
  });

  it('rejects an event one byte over the frame boundary', async () => {
    const frame = frameOfBytes(MAX_SSE_EVENT_BYTES + 1);
    expect(Buffer.byteLength(frame)).toBe(MAX_SSE_EVENT_BYTES + 1);
    const error = await failure(
      sseResponse(frame, { contentType: 'text/event-stream' })
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED' });
    expect(error.message).toContain('exceeded the size limit');
  });

  it('replays a prefix-crossing valid stream without duplication or loss', async () => {
    const first = 'A'.repeat(700);
    const second = 'B'.repeat(700);
    const body = sse(
      { type: 'response.output_text.delta', delta: first },
      { type: 'response.output_text.delta', delta: second },
      { type: 'response.output_text.delta', delta: '✓' },
      { type: 'response.completed', response: { status: 'completed' } }
    );
    const encoded = bytes(body);
    const chunks = [
      encoded.slice(0, 1000),
      encoded.slice(1000, 1400),
      encoded.slice(1400),
    ];
    const result = await infer(sseResponse(streamOf(chunks)));
    expect(result.text).toBe(first + second + '✓');
  });

  it('cancels while a large frame is still under the cap', async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(bytes(`data: ${'x'.repeat(900 * 1024)}`));
        setTimeout(() => {
          controllerRef?.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, 100);
      },
    });
    await expect(infer(sseResponse(body), () => {})).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });
});
