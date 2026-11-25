/**
 * Sign in with ChatGPT — OAuth public-client and Responses API transport.
 *
 * Implements the documented open-source flow only:
 *   - dynamic_agent_client registration through the system browser;
 *   - PKCE S256 + state + nonce;
 *   - loopback callback on 127.0.0.1;
 *   - no client secret;
 *   - POST https://api.openai.com/v1/responses with store:false, stream:true;
 *   - success only after response.completed.
 *
 * No ChatGPT backend-api endpoint, Codex credential, or unofficial workaround is
 * referenced.
 */

'use strict';

const {
  AUTHORIZE_URL,
  CALLBACK_PATH,
  DISCOVERY_URL,
  ISSUER,
  MODELS_URL,
  RESOURCE,
  RESPONSES_URL,
  REQUESTED_SCOPES,
  TOKEN_URL,
} = require('./config.cjs');
const {
  errorFor,
  mapOAuthError,
  mapSubscriptionCode,
  mapTransportError,
} = require('./errors.cjs');

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_SSE_PREFIX_BYTES = 1024;
// A single SSE frame is capped at 1 MiB of raw bytes, including its terminating
// blank line. The aggregate output budget is 200,000 characters (at most about
// 800 KiB as UTF-8); the Responses API emits small JSON delta frames, so 1 MiB
// leaves ample protocol headroom while preventing an unbounded frame buffer.
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const DIAGNOSTIC_TIMEOUT_MS = 3_000;
const MAX_MODELS = 100;
const MAX_RESPONSE_TEXT = 200_000;
const EXPECTED_RESPONSES_ORIGIN = new URL(RESPONSES_URL).origin;
const SAFE_RESPONSE_TYPES = new Set(['basic', 'cors', 'default', 'error', 'opaque', 'opaqueredirect']);
const SAFE_PROVIDER_CODES = new Set([
  'api_error',
  'authentication_error',
  'billing_hard_limit_reached',
  'chatpass_v2_invalid_authorization_context',
  'chatpass_v2_scope_not_authorized',
  'insufficient_quota',
  'invalid_request',
  'invalid_request_error',
  'invalid_value',
  'missing_required_parameter',
  'model_not_found',
  'not_found_error',
  'overloaded_error',
  'permission_error',
  'rate_limit_error',
  'rate_limit_exceeded',
  'server_error',
  'subscription_sharing_invalid_user',
  'subscription_sharing_route_not_supported',
  'subscription_sharing_unsupported_capability',
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_not_eligible',
  'subscription_sharing_user_unavailable',
  'unsupported_capability',
  'unsupported_model',
  'unsupported_parameter',
  'unsupported_value',
]);

// Slugs are provider identifiers, never paths. Keep the admitted language
// deliberately narrow and share it with request validation so a catalog value
// cannot become executable through a more permissive request grammar.
//
// Accepted forms: `gpt-4.1`, `vendor/model-1.2`,
// `vendor/model-1.2:preview`. Dot-dot, empty path components, repeated
// separators, backslashes, and arbitrary URI/path punctuation fail closed.
const MODEL_SLUG_PATTERN = /^(?=.{1,120}$)(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function isValidModelSlug(value) {
  return typeof value === 'string' && MODEL_SLUG_PATTERN.test(value);
}

function timeoutSignal(externalSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([externalSignal, timeout]);
  return externalSignal;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw errorFor('INVALID_REQUEST', 'The ChatGPT response exceeded its size bound.');
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best effort */
        }
        throw errorFor('INVALID_REQUEST', 'The ChatGPT response exceeded its size bound.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(response, maxBytes = MAX_JSON_BYTES) {
  const text = await readBounded(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw errorFor('INVALID_REQUEST', 'The ChatGPT service returned invalid JSON.');
  }
}

function mediaTypeClass(response) {
  const raw = String(response.headers?.get?.('content-type') || '').trim().toLowerCase();
  if (!raw) return 'missing';
  const type = raw.split(';', 1)[0].trim();
  if (type === 'text/event-stream') return 'sse';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

function safeProviderCode(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const nested = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error
    : null;
  for (const value of [nested?.code, nested?.type, payload.code, payload.type]) {
    if (typeof value === 'string' && SAFE_PROVIDER_CODES.has(value)) return value;
  }
  return '';
}

function looksLikeErrorPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.error !== undefined) return true;
  return payload.code !== undefined || payload.type !== undefined;
}

function cancelReader(reader) {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    /* best effort */
  }
}

function headerPresent(response, name) {
  const headers = response.headers;
  if (!headers) return false;
  if (typeof headers.has === 'function') return headers.has(name);
  const value = headers.get?.(name);
  return value !== undefined && value !== null && String(value) !== '';
}

function responseOriginClass(response) {
  if (typeof response.url !== 'string' || !response.url) return 'unknown';
  try {
    const origin = new URL(response.url).origin;
    return origin === EXPECTED_RESPONSES_ORIGIN ? 'expected' : 'unexpected';
  } catch {
    return 'unknown';
  }
}

function responseTypeClass(response) {
  const value = typeof response.type === 'string' ? response.type.toLowerCase() : '';
  return SAFE_RESPONSE_TYPES.has(value) ? value : 'other';
}

function isSseLike(text) {
  const trimmed = String(text || '').trimStart();
  return /(?:^|\n)(?:data|event|id|retry)(?::|$)/.test(trimmed) ||
    /(?:^|\n):/.test(trimmed);
}

function isHtmlLike(text) {
  return /^(?:<!doctype\s+html|<html\b)/i.test(text.trimStart());
}

function classifyBodyPrefix(text) {
  const trimmed = String(text || '').trimStart();
  if (!trimmed) return 'inconclusive';
  if (isSseLike(trimmed)) return 'sse-like';
  if (isHtmlLike(trimmed)) return 'html';
  if (/^[\[{]/.test(trimmed)) return 'json';
  return 'other';
}

// A missing-Content-Type response is only a compatibility candidate when its
// first non-whitespace bytes could begin a real SSE stream. The prefix is a
// gate, never proof: the full body is still parsed and must end with a valid
// response.completed event.
function isPlausibleSsePrefix(text) {
  const trimmed = String(text || '').trimStart();
  if (!trimmed) return false;
  if (isHtmlLike(trimmed)) return false;
  return /^(?::|(?:data|event|id|retry)(?::|\r?\n|$))/.test(trimmed);
}

function classifyRejectedPrefix(text) {
  const trimmed = String(text || '').trimStart();
  if (!trimmed) return 'inconclusive';
  if (isHtmlLike(trimmed)) return 'html';
  if (/^[\[{]/.test(trimmed)) return 'json';
  return 'other';
}

function classifyUnexpectedBody(text, media) {
  if (!text) {
    return { classification: 'empty', bodyClass: 'empty', bodyPrefix: 'inconclusive', readState: 'complete', code: '' };
  }
  if (isSseLike(text)) {
    return {
      classification: media === 'json' ? 'malformed' : media === 'missing' ? 'missing' : media,
      bodyClass: 'sse-like',
      bodyPrefix: 'sse-like',
      readState: 'complete',
      code: '',
    };
  }
  if (isHtmlLike(text)) {
    return {
      classification: media === 'json' ? 'malformed' : media === 'missing' ? 'missing' : 'html',
      bodyClass: 'html',
      bodyPrefix: 'html',
      readState: 'complete',
      code: '',
    };
  }
  if (media === 'json' || /^[\[{]/.test(text.trimStart())) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { classification: 'malformed', bodyClass: 'other', bodyPrefix: 'json', readState: 'complete', code: '' };
    }
    const code = safeProviderCode(payload);
    if (!looksLikeErrorPayload(payload)) {
      return { classification: 'json_without_error', bodyClass: 'json', bodyPrefix: 'json', readState: 'complete', code };
    }
    return {
      classification: code ? 'json_error' : 'json_error_unrecognized',
      bodyClass: 'json',
      bodyPrefix: 'json',
      readState: 'complete',
      code,
    };
  }
  return {
    classification: media === 'missing' ? 'missing' : media,
    bodyClass: 'other',
    bodyPrefix: 'other',
    readState: 'complete',
    code: '',
  };
}

async function readUnexpectedBody(response, media, signal) {
  if (signal?.aborted) throw errorFor('CANCELLED');
  const declared = Number(response.headers?.get?.('content-length') || 0);
  // Do not treat a large declared size as a reason to skip bounded reading.
  // The first MAX_DIAGNOSTIC_BYTES may still be safely retained and classified.
  const reader = response.body?.getReader?.();
  if (!reader) {
    return { classification: 'empty', bodyClass: 'empty', bodyPrefix: 'inconclusive', readState: 'empty', code: '' };
  }
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + DIAGNOSTIC_TIMEOUT_MS;
  let stalled = false;
  try {
    for (;;) {
      if (signal?.aborted) throw errorFor('CANCELLED');
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        stalled = true;
        break;
      }
      let timer;
      let result;
      try {
        result = await new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const timeout = new Error('diagnostic body timeout');
            timeout.code = 'TKC_DIAGNOSTIC_TIMEOUT';
            reject(timeout);
          }, remaining);
          reader.read().then(resolve, reject);
        });
      } finally {
        clearTimeout(timer);
      }
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > MAX_DIAGNOSTIC_BYTES) {
        stalled = false;
        cancelReader(reader);
        const previous = Buffer.concat(chunks);
        const allowed = MAX_DIAGNOSTIC_BYTES - previous.length;
        const prefixChunks = [previous];
        if (allowed > 0 && result.value) {
          prefixChunks.push(Buffer.from(result.value).subarray(0, allowed));
        }
        const prefix = Buffer.concat(prefixChunks).toString('utf8');
        return {
          classification: 'oversized',
          bodyClass: 'other',
          bodyPrefix: classifyBodyPrefix(prefix),
          readState: 'oversized',
          code: '',
        };
      }
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    cancelReader(reader);
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw errorFor('CANCELLED');
    }
    if (error?.code === 'TKC_DIAGNOSTIC_TIMEOUT' || error?.name === 'TimeoutError' || error?.code === 'TKC_TIMEOUT') {
      if (declared > MAX_DIAGNOSTIC_BYTES) {
        const prefix = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        return {
          classification: 'oversized',
          bodyClass: 'other',
          bodyPrefix: classifyBodyPrefix(prefix),
          readState: 'oversized',
          code: '',
        };
      }
      stalled = true;
    } else {
      return { classification: 'unreadable', bodyClass: 'other', bodyPrefix: 'inconclusive', readState: 'unreadable', code: '' };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  if (stalled) {
    cancelReader(reader);
    const prefix = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    if (declared > MAX_DIAGNOSTIC_BYTES) {
      return {
        classification: 'oversized',
        bodyClass: 'other',
        bodyPrefix: classifyBodyPrefix(prefix),
        readState: 'oversized',
        code: '',
      };
    }
    return { classification: 'stalled', bodyClass: 'other', bodyPrefix: classifyBodyPrefix(prefix), readState: 'stalled', code: '' };
  }
  if (total === 0) {
    return { classification: 'empty', bodyClass: 'empty', bodyPrefix: 'inconclusive', readState: 'complete', code: '' };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (declared > MAX_DIAGNOSTIC_BYTES) {
    return {
      classification: 'oversized',
      bodyClass: 'other',
      bodyPrefix: classifyBodyPrefix(text),
      readState: 'oversized',
      code: '',
    };
  }
  const result = classifyUnexpectedBody(text, media);
  return { ...result, bodyPrefix: result.bodyPrefix || classifyBodyPrefix(text) };
}

// Retain at most MAX_SSE_PREFIX_BYTES for classification. Any bytes that cross
// the boundary are returned as a read-only view, never copied into a new
// full-remainder buffer. The caller immediately replays the view into the
// bounded frame parser. This is a framing probe, not a body buffer.
async function readSsePrefix(reader, maxBytes, signal) {
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) throw errorFor('CANCELLED');
    const { done, value } = await reader.read();
    if (done) {
      return {
        chunks,
        carry: null,
        done: true,
        text: Buffer.concat(chunks).toString('utf8'),
      };
    }
    if (!value || value.byteLength === 0) continue;
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const remaining = maxBytes - total;
    if (bytes.length >= remaining) {
      chunks.push(Buffer.from(bytes.subarray(0, remaining)));
      return {
        chunks,
        carry: bytes.length > remaining ? bytes.subarray(remaining) : null,
        done: false,
        text: Buffer.concat(chunks).toString('utf8'),
      };
    }
    chunks.push(Buffer.from(bytes));
    total += bytes.length;
  }
}

function diagnosticSummary(response, media, result) {
  const redirect = response.redirected === true ? 'yes' : response.redirected === false ? 'no' : 'unknown';
  const provider = result.code ? `; provider=${result.code}` : '';
  return ` Diagnostic: media=${media}; body=${result.bodyClass}; body_prefix=${result.bodyPrefix || 'inconclusive'}; read=${result.readState}; redirect=${redirect}; origin=${responseOriginClass(response)}; type=${responseTypeClass(response)}; content_length=${headerPresent(response, 'content-length') ? 'present' : 'absent'}; transfer_encoding=${headerPresent(response, 'transfer-encoding') ? 'present' : 'absent'}${provider}.`;
}

function responseShapeMessage(status, media, result) {
  const suffix = ' Nothing was accepted.';
  if (status === 204 || result.classification === 'empty') {
    return `ChatGPT returned an unexpected ${status} empty response.${suffix}`;
  }
  if (media === 'missing') {
    return `ChatGPT returned an unexpected ${status} response with no content type.${suffix}`;
  }
  if (result.classification === 'oversized') {
    return `ChatGPT returned an unexpected ${status} ${media.toUpperCase()} response that exceeded the diagnostic size limit.${suffix}`;
  }
  if (result.classification === 'malformed') {
    return `ChatGPT returned an unexpected ${status} ${media.toUpperCase()} response that was malformed.${suffix}`;
  }
  if (result.classification === 'unreadable') {
    return `ChatGPT returned an unexpected ${status} ${media.toUpperCase()} response that could not be read.${suffix}`;
  }
  if (result.classification === 'json_error' && result.code) {
    return `ChatGPT returned an unexpected ${status} JSON error response (provider code: ${result.code}).${suffix}`;
  }
  if (result.classification === 'json_error_unrecognized') {
    return `ChatGPT returned an unexpected ${status} JSON error response (unrecognized provider code).${suffix}`;
  }
  if (result.classification === 'json_without_error') {
    return `ChatGPT returned an unexpected ${status} JSON response.${suffix}`;
  }
  if (media === 'html') {
    return `ChatGPT returned an unexpected ${status} HTML response.${suffix}`;
  }
  if (media === 'text') {
    return `ChatGPT returned an unexpected ${status} text response.${suffix}`;
  }
  return `ChatGPT returned an unexpected ${status} ${media === 'json' ? 'JSON' : 'non-JSON'} response.${suffix}`;
}

// The single SSE parser used by the normal text/event-stream path and by the
// missing-Content-Type compatibility path. Callers feed the exact byte stream;
// the parser owns decoding, line/frame framing, the per-frame byte cap, and all
// success/failure semantics.
function createSseParser(onDelta) {
  let text = '';
  let completed = false;
  let eventBytes = 0;
  let lineBytes = 0;
  let lineParts = [];
  let dataLines = [];
  let firstLine = true;

  const oversized = () => {
    throw errorFor('RESPONSE_FAILED', 'ChatGPT returned an SSE event that exceeded the size limit.');
  };

  const decodeLine = (parts, length) => {
    let line = length > 0 ? Buffer.concat(parts, length).toString('utf8') : '';
    if (firstLine) {
      firstLine = false;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    }
    return line;
  };

  const handleData = (data) => {
    if (!data || data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw errorFor('RESPONSE_FAILED', 'ChatGPT returned a malformed stream event.');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw errorFor('RESPONSE_FAILED', 'ChatGPT returned a malformed stream event.');
    }
    const type = String(event.type || '');
    // response.completed is the terminal semantic event. Any later data event,
    // including a late delta, duplicate completion, or contradictory terminal
    // status, must fail closed before it can change text or terminal state.
    if (completed) {
      throw errorFor('RESPONSE_FAILED', 'ChatGPT returned data after the completion event.');
    }
    if (type === 'response.output_text.delta') {
      if (event.delta !== undefined && typeof event.delta !== 'string') {
        throw errorFor('RESPONSE_FAILED', 'ChatGPT returned a malformed stream event.');
      }
      const delta = event.delta || '';
      if (delta) {
        text += delta;
        if (text.length > MAX_RESPONSE_TEXT) {
          throw errorFor('RESPONSE_FAILED', 'The ChatGPT response exceeded the text limit.');
        }
        onDelta?.(delta);
      }
      return;
    }
    if (type === 'response.completed') {
      const final = event.response;
      if (!final || typeof final !== 'object' || Array.isArray(final)) {
        throw errorFor('RESPONSE_FAILED', 'ChatGPT returned a malformed completion event.');
      }
      if (final.status !== 'completed') {
        throw errorFor('RESPONSE_FAILED', 'ChatGPT returned a non-terminal completion event.');
      }
      completed = true;
      const output = final.output;
      if (!text && Array.isArray(output)) {
        for (const item of output) {
          if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
          for (const part of item.content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') {
              text += part.text;
              if (text.length > MAX_RESPONSE_TEXT) {
                throw errorFor('RESPONSE_FAILED', 'The ChatGPT response exceeded the text limit.');
              }
            }
          }
        }
      }
      return;
    }
    if (type === 'response.failed') {
      const code = String(event?.response?.error?.code || event?.error?.code || '').slice(0, 120);
      throw mapSubscriptionCode(code, Number(event?.response?.status || 0) || undefined);
    }
    if (type === 'response.incomplete') {
      throw errorFor('RESPONSE_INCOMPLETE');
    }
    if (type === 'error') {
      const code = String(event?.error?.code || event?.code || '').slice(0, 120);
      throw mapSubscriptionCode(code, undefined);
    }
  };

  const finishEvent = () => {
    if (dataLines.length) {
      const data = dataLines.join('\n');
      dataLines = [];
      handleData(data);
    } else {
      dataLines = [];
    }
  };

  // eventBytes already includes this line's content and terminator. A CR at the
  // end of the line is part of CRLF; strip it from the decoded line only. Its
  // raw byte remains counted toward the frame limit.
  const finishLine = () => {
    let length = lineBytes;
    if (length > 0) {
      const last = lineParts[lineParts.length - 1];
      if (last[last.length - 1] === 0x0d) {
        if (last.length === 1) lineParts.pop();
        else lineParts[lineParts.length - 1] = last.subarray(0, last.length - 1);
        length -= 1;
      }
    }
    const line = decodeLine(lineParts, length);
    lineParts = [];
    lineBytes = 0;
    if (!line) {
      finishEvent();
      eventBytes = 0;
      return;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  };

  return {
    write(value) {
      if (!value || value.byteLength === 0) return;
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline < 0) {
          const length = bytes.length - offset;
          if (eventBytes + length > MAX_SSE_EVENT_BYTES) oversized();
          if (length > 0) {
            lineParts.push(Buffer.from(bytes.subarray(offset)));
            lineBytes += length;
            eventBytes += length;
          }
          return;
        }
        const contentLength = newline - offset;
        if (eventBytes + contentLength + 1 > MAX_SSE_EVENT_BYTES) oversized();
        if (contentLength > 0) {
          lineParts.push(Buffer.from(bytes.subarray(offset, newline)));
          lineBytes += contentLength;
        }
        eventBytes += contentLength + 1;
        finishLine();
        offset = newline + 1;
      }
    },
    end() {
      // A frame is dispatched only by a blank line in write(). EOF must not
      // dispatch an open data frame: an unterminated completion is therefore
      // never accepted, even when its JSON payload is otherwise valid.
      let openDataLine = false;
      if (lineBytes > 0) {
        const line = decodeLine(lineParts, lineBytes);
        lineParts = [];
        lineBytes = 0;
        openDataLine = line.startsWith('data:');
      }
      if (openDataLine || dataLines.length > 0) {
        throw errorFor('STREAM_INCOMPLETE');
      }
    },
    get text() {
      return text;
    },
    get completed() {
      return completed;
    },
  };
}

class ChatGptOAuthClient {
  constructor({
    fetchFn = (url, init) => globalThis.fetch(url, init),
    authorizeUrl = AUTHORIZE_URL,
    tokenUrl = TOKEN_URL,
    discoveryUrl = DISCOVERY_URL,
    modelsUrl = MODELS_URL,
    responsesUrl = RESPONSES_URL,
    scopes = REQUESTED_SCOPES,
    callbackPath = CALLBACK_PATH,
    now = () => Date.now(),
  } = {}) {
    this.fetchFn = fetchFn;
    this.authorizeUrl = authorizeUrl;
    this.tokenUrl = tokenUrl;
    this.discoveryUrl = discoveryUrl;
    this.modelsUrl = modelsUrl;
    this.responsesUrl = responsesUrl;
    this.scopes = [...scopes];
    this.callbackPath = callbackPath;
    this.now = now;
    this.discoveryPromise = null;
    this.jwksCache = null;
  }

  async discover(signal) {
    if (signal?.aborted) throw errorFor('CANCELLED');
    if (this.discoveryPromise) return this.discoveryPromise;
    const pending = (async () => {
      let response;
      try {
        response = await this.fetchFn(this.discoveryUrl, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: timeoutSignal(signal, 10_000),
        });
      } catch (error) {
        this.discoveryPromise = null;
        throw mapTransportError(error);
      }
      if (!response.ok) throw errorFor('NETWORK', 'OpenAI OIDC discovery could not be loaded.', { status: response.status });
      const doc = await readJson(response, 256 * 1024);
      const httpsUrl = (value) => {
        try {
          const url = new URL(String(value));
          return url.protocol === 'https:' && url.hostname === 'auth.openai.com' ? url.toString() : '';
        } catch {
          return '';
        }
      };
      const jwksUri = httpsUrl(doc.jwks_uri);
      const tokenEndpoint = httpsUrl(doc.token_endpoint);
      const revocationEndpoint = doc.revocation_endpoint ? httpsUrl(doc.revocation_endpoint) : '';
      if (doc.issuer !== ISSUER || !jwksUri || !tokenEndpoint) {
        this.discoveryPromise = null;
        throw errorFor('AUTHENTICATION_FAILED', 'OpenAI OIDC discovery is incomplete.');
      }
      return {
        issuer: doc.issuer,
        jwksUri,
        tokenEndpoint,
        revocationEndpoint,
      };
    })();
    this.discoveryPromise = pending.catch((error) => {
      this.discoveryPromise = null;
      throw error;
    });
    return this.discoveryPromise;
  }

  async getJwks(force = false, signal) {
    if (signal?.aborted) throw errorFor('CANCELLED');
    const now = this.now();
    if (!force && this.jwksCache && now - this.jwksCache.fetchedAt < 10 * 60 * 1000) {
      return this.jwksCache.jwks;
    }
    const discovery = await this.discover(signal);
    let response;
    try {
      response = await this.fetchFn(discovery.jwksUri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: timeoutSignal(signal, 10_000),
      });
    } catch (error) {
      throw mapTransportError(error);
    }
    if (signal?.aborted) throw errorFor('CANCELLED');
    if (!response.ok) throw errorFor('NETWORK', 'OpenAI signing keys could not be loaded.', { status: response.status });
    const jwks = await readJson(response, 512 * 1024);
    if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw errorFor('AUTHENTICATION_FAILED', 'OpenAI signing keys are malformed.');
    }
    this.jwksCache = { fetchedAt: now, jwks };
    return jwks;
  }

  buildAuthorizationUrl({
    clientId,
    redirectUri,
    state,
    nonce,
    challenge,
    agentNameHint,
    idTokenHint,
    loginHint,
    hostId,
    forceConsent = false,
  }) {
    if (
      typeof hostId !== 'string' ||
      !/^urn:(uuid:[0-9a-f-]{36}|ietf:params:oauth:jwk-thumbprint:.+|did:key:.+)$/i.test(hostId)
    ) {
      throw errorFor('AUTHENTICATION_FAILED', 'A valid ChatGPT host identity is required.');
    }
    const url = new URL(this.authorizeUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('ext_agent_host_id', hostId);
    if (agentNameHint) url.searchParams.set('agent_name_hint', agentNameHint);
    if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
    if (loginHint) url.searchParams.set('login_hint', loginHint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', this.scopes.join(' '));
    url.searchParams.set('resource', RESOURCE);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', challenge);
    if (forceConsent) url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  async tokenRequest(body, signal) {
    const discovery = await this.discover(signal);
    let response;
    try {
      response = await this.fetchFn(discovery.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(body).toString(),
        signal: timeoutSignal(signal, 20_000),
      });
    } catch (error) {
      throw mapTransportError(error);
    }
    if (!response.ok) {
      let payload = {};
      try {
        payload = await readJson(response, MAX_ERROR_BYTES);
      } catch {
        payload = {};
      }
      throw mapOAuthError(response.status, payload);
    }
    return readJson(response);
  }

  exchangeCode({ code, clientId, codeVerifier, redirectUri, signal }) {
    return this.tokenRequest(
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      },
      signal
    );
  }

  refresh({ clientId, refreshToken, signal }) {
    return this.tokenRequest(
      {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        resource: RESOURCE,
      },
      signal
    );
  }

  async revoke({ clientId, refreshToken }) {
    const discovery = await this.discover();
    if (!discovery.revocationEndpoint) {
      return { confirmed: false, reason: 'no_revocation_endpoint' };
    }
    let response;
    try {
      response = await this.fetchFn(discovery.revocationEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
          client_id: clientId,
        }).toString(),
        signal: timeoutSignal(undefined, 15_000),
      });
    } catch {
      return { confirmed: false, reason: 'network' };
    }
    if (response.status === 200 || response.status === 204) {
      return { confirmed: true };
    }
    return { confirmed: false, reason: `status_${response.status}` };
  }

  async listModels(accessToken, { signal } = {}) {
    if (signal?.aborted) throw errorFor('CANCELLED');
    let response;
    try {
      response = await this.fetchFn(this.modelsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: timeoutSignal(signal, 15_000),
      });
    } catch (error) {
      throw mapTransportError(error);
    }
    if (signal?.aborted) throw errorFor('CANCELLED');
    if (!response.ok) {
      const payload = await this.readErrorPayload(response);
      throw mapSubscriptionCode(payload.code, response.status);
    }
    const doc = await readJson(response);
    const rows = Array.isArray(doc?.models) ? doc.models : Array.isArray(doc?.data) ? doc.data : [];
    const models = [];
    const seen = new Set();
    for (const row of rows) {
      // The documented contract is explicit: only visibility === "list" is
      // executable. Missing, unknown, or hidden values fail closed.
      if (row?.visibility !== 'list') continue;
      // The official catalog selects by `slug`. Never substitute id/name or
      // normalize a malformed value into an executable identifier.
      if (!isValidModelSlug(row?.slug)) {
        continue;
      }
      if (seen.has(row.slug)) {
        throw errorFor('INVALID_MODEL_CATALOG', 'The ChatGPT catalog contains duplicate model slugs.');
      }
      seen.add(row.slug);
      // Inspect every eligible row before applying the display cap. Otherwise
      // a duplicate just beyond MAX_MODELS would silently escape the catalog
      // consistency check.
      if (models.length < MAX_MODELS) {
        models.push({
          id: row.slug,
          name:
            typeof row.display_name === 'string' && row.display_name.trim()
              ? row.display_name.trim().slice(0, 160)
              : row.slug,
        });
      }
    }
    return models;
  }

  async readErrorPayload(response) {
    try {
      const doc = await readJson(response, MAX_ERROR_BYTES);
      const error = doc?.error && typeof doc.error === 'object' ? doc.error : {};
      return {
        code: String(error.code || doc?.code || '').slice(0, 120),
        detail: String(error.message || doc?.detail || '').slice(0, 300),
      };
    } catch {
      return { code: '', detail: '' };
    }
  }

  async streamResponse({
    accessToken,
    model,
    input,
    instructions,
    signal,
    onDelta,
  }) {
    const body = { model, input, store: false, stream: true };
    if (typeof instructions === 'string' && instructions.trim()) body.instructions = instructions;
    let response;
    try {
      response = await this.fetchFn(this.responsesUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: timeoutSignal(signal, 120_000),
      });
    } catch (error) {
      throw mapTransportError(error);
    }
    if (!response.ok) {
      const payload = await this.readErrorPayload(response);
      throw mapSubscriptionCode(payload.code, response.status);
    }
    if (signal?.aborted) throw errorFor('CANCELLED');
    const media = mediaTypeClass(response);
    const missingMediaCompatibility =
      media === 'missing' &&
      response.status === 200 &&
      response.redirected === false &&
      responseOriginClass(response) === 'expected';
    if (media !== 'sse' && !missingMediaCompatibility) {
      const result = response.status === 204
        ? { classification: 'empty', bodyClass: 'empty', bodyPrefix: 'inconclusive', readState: 'empty', code: '' }
        : await readUnexpectedBody(response, media, signal);
      throw errorFor(
        'RESPONSE_FAILED',
        `${responseShapeMessage(response.status, media, result)}${diagnosticSummary(response, media, result)}`,
        { status: response.status }
      );
    }
    const reader = response.body?.getReader?.();
    if (!reader) {
      if (missingMediaCompatibility) {
        const result = {
          classification: 'empty',
          bodyClass: 'empty',
          bodyPrefix: 'inconclusive',
          readState: 'empty',
          code: '',
        };
        throw errorFor(
          'RESPONSE_FAILED',
          `${responseShapeMessage(response.status, media, result)}${diagnosticSummary(response, media, result)}`,
          { status: response.status }
        );
      }
      throw errorFor('RESPONSE_FAILED', 'ChatGPT returned no response stream.');
    }

    try {
      let prefix = null;
      if (missingMediaCompatibility) {
        prefix = await readSsePrefix(reader, MAX_SSE_PREFIX_BYTES, signal);
        if (!isPlausibleSsePrefix(prefix.text)) {
          cancelReader(reader);
          const bodyPrefix = classifyRejectedPrefix(prefix.text);
          let result;
          if (bodyPrefix === 'inconclusive') {
            result = {
              classification: 'empty',
              bodyClass: 'empty',
              bodyPrefix,
              readState: prefix.done ? 'complete' : 'prefix',
              code: '',
            };
          } else if (prefix.done && bodyPrefix === 'json') {
            result = classifyUnexpectedBody(prefix.text, media);
          } else {
            result = {
              classification: 'missing',
              bodyClass: bodyPrefix,
              bodyPrefix,
              readState: prefix.done ? 'complete' : 'prefix',
              code: '',
            };
          }
          throw errorFor(
            'RESPONSE_FAILED',
            `${responseShapeMessage(response.status, media, result)}${diagnosticSummary(response, media, result)}`,
            { status: response.status }
          );
        }
      }

      // Replay the exact consumed prefix, then the untouched remainder and the
      // live stream, through the same parser used by the normal SSE path.
      const parser = createSseParser(onDelta);
      if (prefix) {
        for (const chunk of prefix.chunks) parser.write(chunk);
        if (prefix.carry && prefix.carry.length) parser.write(prefix.carry);
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) parser.write(value);
      }
      parser.end();
      if (!parser.completed) throw errorFor('STREAM_INCOMPLETE');
      return { text: parser.text, model };
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        /* best effort */
      }
      if (error && error.name === 'ChatGptIntegrationError') throw error;
      if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
        throw errorFor('CANCELLED');
      }
      if (error && (error.name === 'TimeoutError' || error.code === 'TKC_TIMEOUT')) {
        throw errorFor('TIMEOUT', undefined, { retryable: true });
      }
      throw errorFor('NETWORK', undefined, { retryable: true, cause: error });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  ChatGptOAuthClient,
  MAX_MODELS,
  MAX_RESPONSE_TEXT,
  MAX_SSE_EVENT_BYTES,
  MODEL_SLUG_PATTERN,
  isValidModelSlug,
  readBounded,
  readJson,
  timeoutSignal,
};
