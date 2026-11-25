import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPkce, challengeFor } = require('../../desktop/chatgpt/pkce.cjs');
const { verifyIdToken } = require('../../desktop/chatgpt/jwt.cjs');
const { ChatGptCredentialStore } = require('../../desktop/chatgpt/credentialStore.cjs');
const { createLoopbackCallbackServer } = require('../../desktop/chatgpt/loopback.cjs');
const { ChatGptOAuthClient } = require('../../desktop/chatgpt/oauth.cjs');
const { ChatGptSubscriptionService, parseGrantedScopes, hasPlanUsageScopes } = require('../../desktop/chatgpt/service.cjs');
const { publicError } = require('../../desktop/chatgpt/errors.cjs');
const { createSafeStorageAdapter } = require('../../desktop/chatgpt/safeStorageAdapter.cjs');
const { isEnabled: isChatGptEnabled } = require('../../desktop/chatgpt/config.cjs');

const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'oaiapp_test_123';
const ACCESS_TOKEN = 'access-token-secret-value';
const REFRESH_TOKEN = 'refresh-token-secret-value';
const ID_TOKEN_SECRET = 'id-token-secret-value';

const dirs: string[] = [];
let keyPair: crypto.KeyPairKeyObjectResult;
let publicJwk: Record<string, unknown>;

function b64(value: Buffer | string) {
  return Buffer.from(value).toString('base64url');
}

function signJwt(payload: Record<string, unknown>, privateKey = keyPair.privateKey) {
  const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' };
  const encodedHeader = b64(JSON.stringify(header));
  const encodedPayload = b64(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64(signature)}`;
}

function future(seconds = 3600) {
  return Math.floor(Date.now() / 1000) + seconds;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'subject-1',
    email: 'tester@example.com',
    iat: Math.floor(Date.now() / 1000),
    exp: future(),
    nonce: 'nonce-value',
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: Array<Record<string, unknown> | string>) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        const value = typeof event === 'string' ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${value}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function diagnosticResponse(
  contentType: string | null,
  body: string | null,
  status = 200,
  extraHeaders: Record<string, string> = {}
) {
  const headers = new Headers(extraHeaders);
  if (contentType) headers.set('content-type', contentType);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: body === null ? null : new Response(body).body,
  };
}

function diagnosticResponseWithRawRequestId(
  contentType: string,
  body: string,
  requestId: string
) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string) {
        if (name === 'content-type') return contentType;
        if (name === 'x-request-id') return requestId;
        return null;
      },
    },
    body: new Response(body).body,
  };
}

async function shapeFailure(response: any): Promise<any> {
  const client = new ChatGptOAuthClient({ fetchFn: async () => response });
  try {
    await client.streamResponse({
      accessToken: 'synthetic-not-a-real-token',
      model: 'gpt-5.6-luna',
      input: [{ role: 'user', content: 'hello' }],
      onDelta: () => {},
    });
  } catch (error) {
    return error;
  }
  throw new Error('Expected a response-shape rejection.');
}

function fakeEncryption() {
  return {
    available: () => true,
    unavailableReason: () => '',
    encrypt: (value: string) => Buffer.from(value, 'utf8'),
    decrypt: (value: Buffer) => Buffer.from(value).toString('utf8'),
    describe: () => 'test-keyring',
  };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkc-chatgpt-test-'));
  dirs.push(dir);
  return dir;
}

function legacyAccount(key = `acct_${'a'.repeat(32)}`) {
  return {
    accountKey: key,
    email: 'legacy@example.invalid',
    issuer: ISSUER,
    subject: 'legacy-subject',
    clientId: CLIENT_ID,
    generation: 1,
    idToken: ID_TOKEN_SECRET,
    accessToken: 'legacy-access-token',
    refreshToken: 'legacy-refresh-token',
    tokenType: 'Bearer',
    expiresIn: 3600,
    expiresAt: Date.now() + 3600000,
    earliestRefreshAt: '',
    scopes: [
      'openid',
      'profile',
      'email',
      'offline_access',
      'resource.invoke',
      'chatgpt.tokens.use.direct',
    ],
    grantValid: true,
    planEnabled: true,
    signedOut: false,
    savedAt: new Date().toISOString(),
    lastValidatedAt: new Date().toISOString(),
  };
}

function writeLegacyCredentialRecord(dir: string, hostId: string, account = legacyAccount()) {
  const plain = JSON.stringify({
    version: 1,
    hostId,
    activeAccountKey: account.accountKey,
    accounts: { [account.accountKey]: account },
  });
  const envelope = {
    version: 1,
    backend: 'test-keyring',
    savedAt: new Date().toISOString(),
    data: Buffer.from(plain, 'utf8').toString('base64'),
  };
  fs.writeFileSync(path.join(dir, 'credentials.bin'), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  return account;
}

function restartedService(store: any, oauth: any = {}) {
  const service = new ChatGptSubscriptionService({
    enabled: true,
    store,
    oauth,
    openExternal: async () => {
      throw new Error('OAuth must not start during restart.');
    },
  });
  service.init();
  return service;
}

function callbackFetch(redirectUri: string, params: Record<string, string>) {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams(params).toString();
  return new Promise<number>((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('error', reject);
  });
}

function createBarrier() {
  let releaseResolve: (() => void) | null = null;
  let startedResolve: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  return {
    promise,
    started,
    start: () => startedResolve?.(),
    release: () => releaseResolve?.(),
  };
}

type Barrier = ReturnType<typeof createBarrier>;

function makeHarness(options: {
  planScope?: boolean;
  tokenClientId?: string;
  accessTokenPlanClaims?: boolean;
  dir?: string;
} = {}) {
  const planScope = options.planScope !== false;
  const tokenClientId = options.tokenClientId || CLIENT_ID;
  const accessToken = options.accessTokenPlanClaims
    ? `h.${b64(JSON.stringify({ scope: 'offline_access resource.invoke chatgpt.tokens.use.direct' }))}.s`
    : ACCESS_TOKEN;
  let pendingNonce = '';
  let pendingChallenge = '';
  let pendingRedirect = '';
  let authorizationCodeCalls = 0;
  let refreshCalls = 0;
  let responsesCalls = 0;
  let modelsCalls = 0;
  let lastResponsesBody: any = null;
  let tokenResponseOverride: Record<string, unknown> | null = null;
  let modelsOverride: Array<Record<string, unknown>> | null = null;
  let refreshScopeOverride: string | null = null;
  let responsesFactory: (() => Response) | null = null;
  let responsesStartedResolve: (() => void) | null = null;
  const responsesStarted = new Promise<void>((resolve) => {
    responsesStartedResolve = resolve;
  });
  let refreshBarrier: Barrier | null = null;
  let modelsBarrier: Barrier | null = null;
  let tokenBarrier: Barrier | null = null;
  let openExternalBarrier: Barrier | null = null;
  let lastAuthorizeUrl = '';

  const fetchFn = async (url: string, init: any = {}) => {
    const target = String(url);
    if (target === 'https://auth.openai.com/.well-known/openid-configuration') {
      return jsonResponse({
        issuer: ISSUER,
        jwks_uri: 'https://auth.openai.com/jwks',
        token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
        revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
      });
    }
    if (target === 'https://auth.openai.com/jwks') {
      return jsonResponse({ keys: [publicJwk] });
    }
    if (target === 'https://auth.openai.com/api/accounts/oauth/token') {
      const params = new URLSearchParams(String(init.body || ''));
      if (params.get('grant_type') === 'authorization_code') {
        if (tokenBarrier) {
          tokenBarrier.start();
          await tokenBarrier.promise;
        }
        authorizationCodeCalls += 1;
        expect(params.get('client_id')).toBe(tokenClientId);
        expect(params.get('code')).toBe('auth-code-1');
        expect(params.get('resource')).toBe('https://api.openai.com/v1');
        expect(params.get('redirect_uri')).toBe(pendingRedirect);
        expect(challengeFor(params.get('code_verifier') || '')).toBe(pendingChallenge);
        return jsonResponse(
          tokenResponseOverride || {
            access_token: accessToken,
            refresh_token: REFRESH_TOKEN,
            id_token: signJwt(
              validPayload({
                nonce: pendingNonce,
                aud: tokenClientId,
              })
            ),
            token_type: 'Bearer',
            expires_in: 3600,
            scope: planScope
              ? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
              : 'openid profile email offline_access resource.invoke',
          }
        );
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (refreshBarrier) {
          refreshBarrier.start();
          await refreshBarrier.promise;
        }
        refreshCalls += 1;
        expect(params.get('client_id')).toBe(tokenClientId);
        expect(params.get('refresh_token')).toBe(REFRESH_TOKEN);
        return jsonResponse({
          access_token: `${accessToken}-rotated-${refreshCalls}`,
          refresh_token: `${REFRESH_TOKEN}-rotated-${refreshCalls}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope:
            refreshScopeOverride !== null
              ? refreshScopeOverride
              : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        });
      }
      return jsonResponse({ error: 'invalid_grant' }, 400);
    }
    if (target === 'https://auth.openai.com/api/accounts/oauth/revoke') {
      return new Response('', { status: 200 });
    }
    if (target === 'https://api.openai.com/v1/models') {
      if (modelsBarrier) {
        modelsBarrier.start();
        await modelsBarrier.promise;
      }
      modelsCalls += 1;
      expect(String(init.headers?.Authorization || '')).toBe(`Bearer ${accessToken}`);
      return jsonResponse({
        models: modelsOverride || [
          { slug: 'test-model', display_name: 'Test Model', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'unmarked-model', display_name: 'Unmarked' },
          { slug: 'unknown-visibility', display_name: 'Unknown', visibility: 'organization' },
          { display_name: 'Malformed without id', visibility: 'list' },
          { id: 'fallback-id', display_name: 'Fallback only', visibility: 'list' },
          { slug: 123, display_name: 'Numeric slug', visibility: 'list' },
          { slug: 'bad slug', display_name: 'Space slug', visibility: 'list' },
        ],
      });
    }
    if (target === 'https://api.openai.com/v1/responses') {
      responsesCalls += 1;
      lastResponsesBody = JSON.parse(String(init.body || '{}'));
      responsesStartedResolve?.();
      if (responsesFactory) return responsesFactory();
      return sseResponse([
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.completed', response: { status: 'completed' } },
      ]);
    }
    throw new Error(`Unexpected fetch URL: ${target}`);
  };

  const oauth = new ChatGptOAuthClient({ fetchFn });
  const store = new ChatGptCredentialStore({
    dir: options.dir || tempDir(),
    encryption: fakeEncryption(),
  });
  let callbackClientId = tokenClientId;
  let callbackStateOverride: string | null = null;
  let callbackError: string | null = null;
  const service = new ChatGptSubscriptionService({
    enabled: true,
    store,
    oauth,
    openExternal: async (authorizeUrl: string) => {
      lastAuthorizeUrl = authorizeUrl;
      if (openExternalBarrier) {
        openExternalBarrier.start();
        await openExternalBarrier.promise;
      }
      const url = new URL(authorizeUrl);
      pendingNonce = url.searchParams.get('nonce') || '';
      pendingChallenge = url.searchParams.get('code_challenge') || '';
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
      expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
      expect(url.searchParams.get('redirect_uri')).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/
      );
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      pendingRedirect = redirectUri;
      const state = callbackStateOverride || url.searchParams.get('state') || '';
      const params: Record<string, string> = { state };
      if (callbackError) params.error = callbackError;
      else {
        params.code = 'auth-code-1';
        if (callbackClientId) params.client_id = callbackClientId;
      }
      const status = await callbackFetch(redirectUri, params);
      expect(status).toBe(200);
    },
    now: () => Date.now(),
    sleep: async () => {},
  });
  service.init();

  return {
    service,
    store,
    oauth,
    fetchFn,
    setCallbackState: (value: string | null) => {
      callbackStateOverride = value;
    },
    setCallbackError: (value: string | null) => {
      callbackError = value;
    },
    setCallbackClientId: (value: string) => {
      callbackClientId = value;
    },
    setTokenResponse: (value: Record<string, unknown> | null) => {
      tokenResponseOverride = value;
    },
    setRefreshScope: (value: string | null) => {
      refreshScopeOverride = value;
    },
    setModels: (value: Array<Record<string, unknown>> | null) => {
      modelsOverride = value;
    },
    setResponsesFactory: (factory: () => Response) => {
      responsesFactory = factory;
    },
    setRefreshBarrier: (barrier: Barrier | null) => {
      refreshBarrier = barrier;
    },
    setModelsBarrier: (barrier: Barrier | null) => {
      modelsBarrier = barrier;
    },
    setTokenBarrier: (barrier: Barrier | null) => {
      tokenBarrier = barrier;
    },
    setOpenExternalBarrier: (barrier: Barrier | null) => {
      openExternalBarrier = barrier;
    },
    responsesStarted,
    counts: () => ({ authorizationCodeCalls, refreshCalls, responsesCalls, modelsCalls }),
    lastResponsesBody: () => lastResponsesBody,
    lastAuthorizeUrl: () => lastAuthorizeUrl,
  };
}

describe('ChatGPT subscription integration', () => {
  keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicJwk = {
    ...keyPair.publicKey.export({ format: 'jwk' }),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is disabled unless the explicit environment flag is set', () => {
    expect(isChatGptEnabled({})).toBe(false);
    expect(isChatGptEnabled({ TKC_CHATGPT_SUBSCRIPTION: '0' })).toBe(false);
    expect(isChatGptEnabled({ TKC_CHATGPT_SUBSCRIPTION: '1' })).toBe(true);
  });

  it('uses the RFC 7636 PKCE S256 example', () => {
    expect(
      challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(createPkce('a'.repeat(43)).challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('verifies a valid ID token and rejects tampering, wrong audience, issuer, nonce and expiry', () => {
    const token = signJwt(validPayload({ nonce: 'expected-nonce' }));
    const claims = verifyIdToken({
      token,
      jwks: { keys: [publicJwk] },
      issuer: ISSUER,
      audience: CLIENT_ID,
      nonce: 'expected-nonce',
    });
    expect(claims.sub).toBe('subject-1');

    const parts = token.split('.');
    const tampered = `${parts[0]}.${b64(JSON.stringify(validPayload({ sub: 'attacker' })))}.${parts[2]}`;
    expect(() =>
      verifyIdToken({
        token: tampered,
        jwks: { keys: [publicJwk] },
        issuer: ISSUER,
        audience: CLIENT_ID,
        nonce: 'expected-nonce',
      })
    ).toThrow(/signature/);
    for (const override of [
      { aud: 'other-client' },
      { iss: 'https://evil.example' },
      { nonce: 'other-nonce' },
      { exp: future(-120) },
    ]) {
      expect(() =>
        verifyIdToken({
          token: signJwt(validPayload(override)),
          jwks: { keys: [publicJwk] },
          issuer: ISSUER,
          audience: CLIENT_ID,
          nonce: 'expected-nonce',
        })
      ).toThrow();
    }
  });

  it('requires azp for a multi-audience ID token and binds it to this client', () => {
    const verify = (claims: Record<string, unknown>) =>
      verifyIdToken({
        token: signJwt(validPayload({ nonce: 'expected-nonce', ...claims })),
        jwks: { keys: [publicJwk] },
        issuer: ISSUER,
        audience: CLIENT_ID,
        nonce: 'expected-nonce',
      });

    expect(() => verify({ aud: [CLIENT_ID, 'other-client'] })).toThrow(/authorized party/i);
    expect(() => verify({ aud: [CLIENT_ID, 'other-client'], azp: 'other-client' })).toThrow(
      /authorized party/i
    );
    expect(verify({ aud: [CLIENT_ID, 'other-client'], azp: CLIENT_ID }).sub).toBe('subject-1');
  });

  it('persists only the host identity and non-secret client registration', () => {
    const dir = tempDir();
    const store = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    const state = store.init();
    expect(state.hostId).toMatch(/^urn:uuid:/);
    expect(state.accounts).toEqual({});
    state.registration = { clientId: CLIENT_ID };
    state.accounts.acct_test = {
      accountKey: 'acct_test',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      idToken: ID_TOKEN_SECRET,
    };
    store.setSessionState(state);
    expect(fs.statSync(path.join(dir, 'registration.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'host.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(dir, 'credentials.bin'))).toBe(false);
    for (const name of fs.readdirSync(dir)) {
      const content = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(content).not.toContain(ACCESS_TOKEN);
      expect(content).not.toContain(REFRESH_TOKEN);
      expect(content).not.toContain(ID_TOKEN_SECRET);
    }
    const reloaded = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    const next = reloaded.init();
    expect(next.hostId).toBe(state.hostId);
    expect(next.registration).toEqual({ clientId: CLIENT_ID });
    expect(next.accounts).toEqual({});
  });

  it('rejects a callback with the wrong state without consuming the attempt', async () => {
    const listener = await createLoopbackCallbackServer({ expectedState: 'correct-state' });
    try {
      expect(await callbackFetch(listener.redirectUri, { code: 'x', state: 'wrong-state' })).toBe(400);
      expect(await callbackFetch(listener.redirectUri, { code: 'x', state: 'correct-state' })).toBe(200);
      await expect(listener.wait).resolves.toMatchObject({ code: 'x' });
    } finally {
      listener.close();
    }
  });

  it('allocates distinct loopback callback ports and isolates callback attempts', async () => {
    const first = await createLoopbackCallbackServer({ expectedState: 'first-state' });
    const second = await createLoopbackCallbackServer({ expectedState: 'second-state' });
    second.wait.catch(() => {});
    try {
      expect(first.redirectUri).not.toBe(second.redirectUri);
      expect(
        await callbackFetch(first.redirectUri, { code: 'x', state: 'second-state' })
      ).toBe(400);
      expect(
        await callbackFetch(first.redirectUri.replace('/auth/callback', '/wrong-path'), {
          code: 'x',
          state: 'first-state',
        })
      ).toBe(404);
      expect(
        await callbackFetch(first.redirectUri, { code: 'x', state: 'first-state' })
      ).toBe(200);
      await expect(first.wait).resolves.toMatchObject({ code: 'x' });
    } finally {
      first.close();
      second.close();
    }
  });

  it('connects with dynamic registration and never exposes tokens through status', async () => {
    const harness = makeHarness();
    const status = await harness.service.connect();
    expect(status.connected).toBe(true);
    expect(status.activeAccount?.planEnabled).toBe(true);
    expect(JSON.stringify(status)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(status)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(status)).not.toContain(ID_TOKEN_SECRET);
    expect(harness.counts().authorizationCodeCalls).toBe(1);
  });

  it('rejects a returning callback that substitutes a different client registration', async () => {
    const harness = makeHarness();
    const first = await harness.service.connect();
    const key = first.activeAccount?.accountKey || '';
    harness.setCallbackClientId('oaiapp_attacker');
    await expect(harness.service.reconnect(key)).rejects.toMatchObject({
      code: 'OAUTH_CLIENT_MISMATCH',
    });
  });

  it('sends a stable ext_agent_host_id and only uses agent_name_hint on first registration', async () => {
    const harness = makeHarness();
    const first = await harness.service.connect();
    const firstUrl = new URL(harness.lastAuthorizeUrl());
    expect(firstUrl.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(firstUrl.searchParams.get('agent_name_hint')).toBe('The Kitchen Codex');
    const key = first.activeAccount?.accountKey || '';
    await harness.service.reconnect(key);
    const secondUrl = new URL(harness.lastAuthorizeUrl());
    expect(secondUrl.searchParams.get('ext_agent_host_id')).toBe(
      firstUrl.searchParams.get('ext_agent_host_id')
    );
    expect(secondUrl.searchParams.get('agent_name_hint')).toBeNull();
  });

  it('fails closed on a malformed persisted host identity', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'host.json'), '{"hostId":"not-a-host"}');
    const store = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    expect(() => store.init()).toThrow(/host identity/i);
  });

  it('handles declined plan consent without creating inference access', async () => {
    const harness = makeHarness();
    harness.setCallbackError('access_denied');
    await expect(harness.service.connect()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(harness.counts().responsesCalls).toBe(0);
  });

  it('keeps identity connected but disables plan usage when the plan scope is missing', async () => {
    const harness = makeHarness({ planScope: false });
    const status = await harness.service.connect();
    expect(status.connected).toBe(true);
    expect(status.activeAccount?.planEnabled).toBe(false);
    await expect(harness.service.models()).rejects.toMatchObject({ code: 'PLAN_DISABLED' });
    await expect(
      harness.service.infer({
        model: 'test-model',
        input: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toMatchObject({ code: 'PLAN_DISABLED' });
  });

  it('ignores plan scopes that exist only in unverified access-token claims', async () => {
    const harness = makeHarness({ planScope: false, accessTokenPlanClaims: true });
    const status = await harness.service.connect();
    expect(status.activeAccount?.planEnabled).toBe(false);
    const account = Object.values(harness.store.getState().accounts)[0] as any;
    expect(account.scopes).not.toContain('chatgpt.tokens.use.direct');
    await expect(harness.service.models()).rejects.toMatchObject({ code: 'PLAN_DISABLED' });
  });

  it('accepts only strict, duplicate-free documented scope grants', () => {
    const full = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
    const valid = parseGrantedScopes(full);
    expect(valid.valid).toBe(true);
    expect(hasPlanUsageScopes(valid.scopes)).toBe(true);
    const identityOnly = parseGrantedScopes('openid profile email offline_access resource.invoke');
    expect(identityOnly.valid).toBe(true);
    expect(hasPlanUsageScopes(identityOnly.scopes)).toBe(false);
    for (const bad of [
      `${full} offline_access`,
      `${full} unknown.scope`,
      'openid profile email offline_access resource.invoke, chatgpt.tokens.use.direct',
      `${full}\nopenid`,
      `${full}  `,
      ['openid', 'profile'],
      '',
    ]) {
      const parsed = parseGrantedScopes(bad);
      expect(parsed.valid, String(bad)).toBe(false);
      expect(hasPlanUsageScopes(parsed.scopes), String(bad)).toBe(false);
    }
  });

  it('invalidates the in-memory session when refresh returns a reduced explicit scope', async () => {
    const harness = makeHarness();
    const connected = await harness.service.connect();
    const key = connected.activeAccount?.accountKey || '';
    const state = harness.store.getState();
    state.accounts[key].expiresAt = 0;
    harness.store.setSessionState(state);
    harness.setRefreshScope('openid profile email offline_access resource.invoke');
    await expect(
      harness.service.infer({
        model: 'test-model',
        input: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(harness.counts().responsesCalls).toBe(0);
    expect(harness.store.getState().accounts[key].planEnabled).toBe(false);
    expect(harness.store.getState().accounts[key].signedOut).toBe(true);
    expect(fs.existsSync(path.join(harness.store.dir, 'credentials.bin'))).toBe(false);
  });

  it('rejects refresh scope expansion until an explicit browser reauthorization', async () => {
    const harness = makeHarness({ planScope: false });
    const connected = await harness.service.connect();
    const key = connected.activeAccount?.accountKey || '';
    const state = harness.store.getState();
    state.accounts[key].expiresAt = 0;
    harness.store.setSessionState(state);
    harness.setRefreshScope(
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
    );

    await expect(harness.service.refreshAccount(key, { force: true })).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    const after = harness.store.getState().accounts[key];
    expect(after.signedOut).toBe(true);
    expect(after.planEnabled).toBe(false);
    expect(after.scopes).toEqual([]);
  });

  it('cannot restore a disconnected session after a late refresh completion', async () => {
    const harness = makeHarness();
    const connected = await harness.service.connect();
    const key = connected.activeAccount?.accountKey || '';
    const state = harness.store.getState();
    const before = state.accounts[key].generation;
    state.accounts[key].expiresAt = 0;
    harness.store.setSessionState(state);

    const barrier = createBarrier();
    harness.setRefreshBarrier(barrier);
    const pending = harness.service.refreshAccount(key, { force: true });
    await barrier.started;
    const disconnected = await harness.service.disconnect(key);
    expect(disconnected.status.activeAccount).toBeNull();
    expect(disconnected.localPersistence).toBe('session_memory');
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });

    const after = harness.store.getState().accounts[key];
    expect(after.generation).toBeGreaterThan(before);
    expect(after.signedOut).toBe(true);
    expect(after.accessToken).toBeNull();
    expect(after.refreshToken).toBeNull();
    expect(after.planEnabled).toBe(false);

    const restarted = restartedService(
      new ChatGptCredentialStore({ dir: harness.store.dir, encryption: fakeEncryption() })
    );
    expect(restarted.store.getState().accounts).toEqual({});
    expect(restarted.store.getState().activeAccountKey).toBeNull();
    expect(restarted.status().connected).toBe(false);
  });

  it('starts disconnected after restart even when a legacy encrypted record exists', () => {
    const dir = tempDir();
    const seed = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    const seedState = seed.init();
    const legacy = writeLegacyCredentialRecord(dir, seedState.hostId);

    const store = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    const state = store.init();
    expect(state.accounts).toEqual({});
    expect(state.activeAccountKey).toBeNull();
    expect(store.getLegacyStatus().removed).toContain('credentials.bin');
    expect(fs.existsSync(path.join(dir, 'credentials.bin'))).toBe(false);

    const service = restartedService(store);
    expect(service.status().connected).toBe(false);
    expect(service.status().accounts).toEqual([]);
    expect(() => service.accountFor(legacy.accountKey)).toThrow(/No ChatGPT subscription account/i);
  });

  it('treats a legacy encrypted record as inert when deletion fails', () => {
    const dir = tempDir();
    const seed = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    const seedState = seed.init();
    const legacy = writeLegacyCredentialRecord(dir, seedState.hostId);
    const failCleanup = () => ({
      present: ['credentials.bin'],
      removed: [],
      failed: [{ name: 'credentials.bin', code: 'EACCES' }],
      inert: true,
    });
    const store = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    store.cleanupLegacyCredentials = failCleanup;
    const state = store.init();
    expect(state.accounts).toEqual({});
    expect(store.getLegacyStatus()).toMatchObject({ inert: true });
    expect(fs.existsSync(path.join(dir, 'credentials.bin'))).toBe(true);

    const service = restartedService(store);
    const status = service.status();
    expect(status.connected).toBe(false);
    expect(status.accounts).toEqual([]);
    expect(status.legacyCredentials).toBe('present_inert');
    expect(service.store.getState().accounts).toEqual({});
    expect(legacy.refreshToken).toBe('legacy-refresh-token');
  });

  it('clears session authority on refresh authentication failure and restarts disconnected', async () => {
    const harness = makeHarness();
    const connected = await harness.service.connect();
    const key = connected.activeAccount?.accountKey || '';
    const originalRefresh = harness.oauth.refresh.bind(harness.oauth);
    const state = harness.store.getState();
    state.accounts[key].expiresAt = 0;
    harness.store.setSessionState(state);
    harness.oauth.refresh = async () => {
      throw Object.assign(new Error('invalid grant'), { code: 'AUTHENTICATION_FAILED' });
    };

    await expect(harness.service.refreshAccount(key, { force: true })).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    expect(harness.store.getState().accounts[key].signedOut).toBe(true);
    expect(harness.store.getState().accounts[key].accessToken).toBeNull();
    expect(harness.store.getState().accounts[key].refreshToken).toBeNull();
    harness.oauth.refresh = originalRefresh;

    const restarted = restartedService(
      new ChatGptCredentialStore({ dir: harness.store.dir, encryption: fakeEncryption() }),
      harness.oauth
    );
    expect(restarted.store.getState().accounts).toEqual({});
    expect(restarted.status().connected).toBe(false);
  });

  it('writes no token material anywhere in the session directory', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    const key = harness.service.status().activeAccount?.accountKey || '';
    const state = harness.store.getState();
    state.accounts[key].expiresAt = 0;
    harness.store.setSessionState(state);
    await harness.service.refreshAccount(key, { force: true });

    const readAll = (root: string): string =>
      fs
        .readdirSync(root, { withFileTypes: true })
        .map((entry) => {
          const full = path.join(root, entry.name);
          return entry.isDirectory() ? readAll(full) : fs.readFileSync(full, 'utf8');
        })
        .join('\n');
    const disk = readAll(harness.store.dir);
    for (const secret of [
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      ID_TOKEN_SECRET,
      'rotated',
      'legacy-access-token',
      'legacy-refresh-token',
      'tester@example.com',
      'subject-1',
    ]) {
      expect(disk).not.toContain(secret);
    }
    expect(fs.readdirSync(harness.store.dir).sort()).toEqual(['host.json', 'registration.json']);
  });

  it('reuses the persisted client registration but never restores the account', async () => {
    const first = makeHarness();
    const connected = await first.service.connect();
    expect(first.store.getRegistration()).toEqual({ clientId: CLIENT_ID });
    const hostId = first.store.getHostId();
    const dir = first.store.dir;

    const second = makeHarness({ dir });
    const status = second.service.status();
    expect(status.connected).toBe(false);
    expect(status.accounts).toEqual([]);
    expect(second.store.getHostId()).toBe(hostId);
    const reconnected = await second.service.connect();
    expect(reconnected.connected).toBe(true);
    const url = new URL(second.lastAuthorizeUrl());
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('ext_agent_host_id')).toBe(hostId);
    expect(url.searchParams.get('agent_name_hint')).toBeNull();
    expect(connected.activeAccount?.accountKey).toBe(reconnected.activeAccount?.accountKey);
  });

  it('fails closed on a corrupt client registration and ignores corrupt legacy records', () => {
    const dir = tempDir();
    const seed = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    seed.init();
    fs.writeFileSync(path.join(dir, 'registration.json'), '{broken');
    const corrupt = new ChatGptCredentialStore({ dir, encryption: fakeEncryption() });
    expect(() => corrupt.init()).toThrow(/registration/i);

    const legacyDir = tempDir();
    fs.writeFileSync(path.join(legacyDir, 'credentials.bin'), '{broken');
    const legacyStore = new ChatGptCredentialStore({
      dir: legacyDir,
      encryption: fakeEncryption(),
    });
    legacyStore.cleanupLegacyCredentials = () => ({
      present: ['credentials.bin'],
      removed: [],
      failed: [{ name: 'credentials.bin', code: 'EACCES' }],
      inert: true,
    });
    expect(() => legacyStore.init()).not.toThrow();
    expect(legacyStore.getState().accounts).toEqual({});
  });

  it('does not leak refresh results across account switching', async () => {
    const harness = makeHarness();
    const first = await harness.service.connect();
    const keyA = first.activeAccount?.accountKey || '';
    const state = harness.store.getState();
    const keyB = `acct_${'b'.repeat(32)}`;
    state.accounts[keyB] = {
      ...state.accounts[keyA],
      accountKey: keyB,
      email: 'second@example.com',
      subject: 'subject-2',
      clientId: 'oaiapp_second',
      generation: 1,
      signedOut: false,
    };
    state.activeAccountKey = keyB;
    harness.store.setSessionState(state);
    harness.service.selectAccount(keyB);

    const barrier = createBarrier();
    harness.setRefreshBarrier(barrier);
    const refresh = harness.service.refreshAccount(keyA, { force: true });
    await barrier.started;
    harness.service.selectAccount(keyB);
    barrier.release();
    await refresh;

    const after = harness.store.getState();
    expect(after.activeAccountKey).toBe(keyB);
    expect(after.accounts[keyB].email).toBe('second@example.com');
    expect(after.accounts[keyB].accessToken).toBe(state.accounts[keyB].accessToken);
    expect(after.accounts[keyA].accessToken).toContain('rotated');
  });

  it('cancels inference before admission during model discovery', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    const barrier = createBarrier();
    harness.setModelsBarrier(barrier);
    const pending = harness.service.infer({
      requestId: 'cancel-model-discovery',
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
    });
    await barrier.started;
    expect(harness.service.cancel('cancel-model-discovery')).toBe(true);
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(harness.counts().responsesCalls).toBe(0);
  });

  it('cancels inference before admission during token refresh', async () => {
    const harness = makeHarness();
    const connected = await harness.service.connect();
    const key = connected.activeAccount?.accountKey || '';
    const state = harness.store.getState();
    state.accounts[key].expiresAt = 0;
    harness.store.setSessionState(state);
    const barrier = createBarrier();
    harness.setRefreshBarrier(barrier);
    const pending = harness.service.infer({
      requestId: 'cancel-refresh',
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
    });
    await barrier.started;
    expect(harness.service.cancel('cancel-refresh')).toBe(true);
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(harness.counts().responsesCalls).toBe(0);
  });

  it('aborts sign-in during callback waiting and does not create an account', async () => {
    const harness = makeHarness();
    const barrier = createBarrier();
    harness.setOpenExternalBarrier(barrier);
    const pending = harness.service.connect();
    await barrier.started;
    expect(harness.service.cancelConnect()).toBe(true);
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Object.keys(harness.store.getState().accounts)).toHaveLength(0);
  });

  it('aborts sign-in during token exchange and does not create an account', async () => {
    const harness = makeHarness();
    const barrier = createBarrier();
    harness.setTokenBarrier(barrier);
    const pending = harness.service.connect();
    await barrier.started;
    expect(harness.service.cancelConnect()).toBe(true);
    barrier.release();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Object.keys(harness.store.getState().accounts)).toHaveLength(0);
  });

  it('returns false for cancellation of unknown or inactive operations', () => {
    const harness = makeHarness();
    expect(harness.service.cancel('missing')).toBe(false);
    expect(harness.service.cancelConnect()).toBe(false);
  });

  it('refreshes rotated tokens once under concurrency', async () => {
    const harness = makeHarness();
    const status = await harness.service.connect();
    const state = harness.store.getState();
    const key = status.activeAccount?.accountKey || '';
    state.accounts[key].accessToken = 'stale-access-token';
    state.accounts[key].expiresAt = 0;
    harness.store.setSessionState(state);
    const [first, second] = await Promise.all([
      harness.service.refreshAccount(key, { force: true }),
      harness.service.refreshAccount(key, { force: true }),
    ]);
    expect(first).toBe(second);
    expect(first).toContain('rotated');
    expect(harness.counts().refreshCalls).toBe(1);
    expect(harness.store.getState().accounts[key].refreshToken).toContain('rotated-1');
  });

  it('uses only account-listed models and sends the documented Responses body', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    const models = await harness.service.models();
    expect(models.map((row: any) => row.id)).toEqual(['test-model']);
    await expect(
      harness.service.infer({
        model: 'hidden-model',
        input: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' });
    expect(harness.counts().responsesCalls).toBe(0);

    const result = await harness.service.infer({
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.text).toBe('Hello');
    expect(harness.lastResponsesBody()).toEqual({
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
      store: false,
      stream: true,
    });
  });

  it('executes a listed slug using the same grammar as catalog admission', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    harness.setModels([
      { slug: 'vendor/model-1.2:beta', display_name: 'Vendor Model', visibility: 'list' },
    ]);
    const models = await harness.service.models();
    expect(models.map((row: any) => row.id)).toEqual(['vendor/model-1.2:beta']);
    const result = await harness.service.infer({
      model: 'vendor/model-1.2:beta',
      input: [{ role: 'user', content: 'Hello' }],
    });
    expect(result).toMatchObject({ model: 'vendor/model-1.2:beta', completed: true });
    expect(harness.counts().responsesCalls).toBe(1);
  });

  it('rejects duplicate and fallback-only model catalog entries', async () => {
    const client = new ChatGptOAuthClient({
      fetchFn: async (url: string) => {
        if (String(url) === 'https://api.openai.com/v1/models') {
          return jsonResponse({
            models: [
              { slug: 'valid-model', display_name: 'Valid', visibility: 'list' },
              { slug: 'valid-model', display_name: 'Duplicate', visibility: 'list' },
            ],
          });
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await expect(client.listModels('token')).rejects.toMatchObject({
      code: 'INVALID_MODEL_CATALOG',
    });

    const fallbackClient = new ChatGptOAuthClient({
      fetchFn: async () => jsonResponse({
        models: [{ id: 'fallback-id', visibility: 'list' }],
      }),
    });
    await expect(fallbackClient.listModels('token')).resolves.toEqual([]);
  });

  it('rejects a duplicate beyond the display cap and path-like model slugs', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      slug: `model-${index}`,
      visibility: 'list',
    }));
    rows.push({ slug: 'model-0', visibility: 'list' });
    const duplicateAfterCap = new ChatGptOAuthClient({
      fetchFn: async () => jsonResponse({ models: rows }),
    });
    await expect(duplicateAfterCap.listModels('token')).rejects.toMatchObject({
      code: 'INVALID_MODEL_CATALOG',
    });

    const pathLikeSlug = new ChatGptOAuthClient({
      fetchFn: async () =>
        jsonResponse({
          models: [{ slug: 'model-../escape', visibility: 'list' }],
        }),
    });
    await expect(pathLikeSlug.listModels('token')).resolves.toEqual([]);
  });

  it('rejects a failed stream after partial text and accepts nothing', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    await harness.service.models();
    harness.setResponsesFactory(() =>
      sseResponse([
        { type: 'response.output_text.delta', delta: 'Partial' },
        {
          type: 'response.failed',
          response: { status: 429, error: { code: 'subscription_sharing_usage_limit_exceeded' } },
        },
      ])
    );
    await expect(
      harness.service.infer({
        model: 'test-model',
        input: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_LIMIT' });
  });

  it('maps a transport interruption to NETWORK without accepting partial text', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    await harness.service.models();
    harness.setResponsesFactory(() => {
      throw new Error('connection reset');
    });
    await expect(
      harness.service.infer({
        model: 'test-model',
        input: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects incomplete streams and never returns partial text', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    await harness.service.models();
    harness.setResponsesFactory(() =>
      sseResponse([{ type: 'response.output_text.delta', delta: 'Partial' }])
    );
    await expect(
      harness.service.infer({
        model: 'test-model',
        input: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toMatchObject({ code: 'STREAM_INCOMPLETE' });
  });

  it('classifies a 2xx JSON safe provider error without exposing provider text', async () => {
    const secret = 'sk-diagnostic-secret-value';
    const error = await shapeFailure(
      diagnosticResponse(
        'application/json; charset=utf-8',
        JSON.stringify({ error: { code: 'model_not_found', message: secret, detail: secret } }),
        200,
        { 'x-request-id': 'req_diag_123' }
      )
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200, retryable: false });
    expect(error.message).toContain('200');
    expect(error.message).toContain('JSON error');
    expect(error.message).toContain('model_not_found');
    expect(error.message).not.toContain('req_diag_123');
    expect(error.message).toContain('Nothing was accepted.');
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('never reflects request-id header values into errors or renderer-facing diagnostics', async () => {
    const values = [
      'req_SECRET-PROMPT-ACCOUNT-TOKEN-DO-NOT-LEAK',
      'owner@example.com',
      'Bearer sk-bearer-token-do-not-leak',
      'Authorization: Bearer sk-authorization-do-not-leak',
      'req_line\ninjection',
      'req_\u0000control',
      `req_${'A'.repeat(20000)}`,
      'req_日本語',
      'req_SECRET%2DPROMPT-ACCOUNT-TOKEN',
      'req_diag_123',
    ];
    for (const value of values) {
      const error = await shapeFailure(
        diagnosticResponseWithRawRequestId(
          'application/json',
          JSON.stringify({ error: { code: 'model_not_found' } }),
          value
        )
      );
      const rendererError = publicError(error);
      expect(error.code).toBe('RESPONSE_FAILED');
      expect(error.message).not.toContain(value);
      expect(JSON.stringify(error)).not.toContain(value);
      expect(JSON.stringify(rendererError)).not.toContain(value);
      expect(rendererError.message).not.toContain(value);
      expect(rendererError.message).toContain('model_not_found');
    }
  });

  it('classifies an unrecognized 2xx JSON error without echoing code or request id secrets', async () => {
    const secret = 'sk-unrecognized-secret-value';
    const error = await shapeFailure(
      diagnosticResponse(
        'application/problem+json',
        JSON.stringify({ error: { code: secret, message: secret } }),
        200,
        { 'x-request-id': secret }
      )
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('unrecognized provider code');
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('classifies a 2xx JSON response without an error without exposing its body', async () => {
    const secret = 'sk-json-body-secret';
    const error = await shapeFailure(
      diagnosticResponse('application/json', JSON.stringify({ detail: secret, status: 'completed' }))
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('JSON response');
    expect(error.message).not.toContain(secret);
  });

  it('classifies a 2xx HTML response without exposing its body', async () => {
    const secret = 'sk-html-secret';
    const error = await shapeFailure(
      diagnosticResponse('text/html; charset=utf-8', `<html>${secret}</html>`)
    );
    expect(error).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(error.message).toContain('HTML response');
    expect(error.message).not.toContain(secret);
  });

  it('classifies 204 empty, missing content type, oversized, malformed, and other responses', async () => {
    const secret = 'sk-shape-secret';
    const empty = await shapeFailure(diagnosticResponse('application/json', null, 204));
    expect(empty).toMatchObject({ code: 'RESPONSE_FAILED', status: 204 });
    expect(empty.message).toContain('204 empty');

    const missing = await shapeFailure(
      diagnosticResponse(null, JSON.stringify({ error: { code: secret } }))
    );
    expect(missing).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(missing.message).toContain('no content type');
    expect(missing.message).not.toContain(secret);

    const oversized = await shapeFailure(
      diagnosticResponse(
        'application/json',
        JSON.stringify({ error: { code: secret } }),
        200,
        { 'content-length': '8193' }
      )
    );
    expect(oversized).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(oversized.message).toContain('exceeded the diagnostic size limit');
    expect(oversized.message).not.toContain(secret);

    const malformed = await shapeFailure(
      diagnosticResponse('application/json', `{"error":${secret}`)
    );
    expect(malformed).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(malformed.message).toContain('malformed');
    expect(malformed.message).not.toContain(secret);

    const other = await shapeFailure(
      diagnosticResponse('application/octet-stream', secret)
    );
    expect(other).toMatchObject({ code: 'RESPONSE_FAILED', status: 200 });
    expect(other.message).toContain('non-JSON response');
    expect(other.message).not.toContain(secret);
  });

  it('accepts a valid SSE response.completed response', async () => {
    const client = new ChatGptOAuthClient({
      fetchFn: async () =>
        sseResponse([
          { type: 'response.output_text.delta', delta: 'TKC CONNECTION OK' },
          { type: 'response.completed', response: { status: 'completed' } },
        ]),
    });
    await expect(
      client.streamResponse({
        accessToken: 'synthetic-not-a-real-token',
        model: 'gpt-5.6-luna',
        input: [{ role: 'user', content: 'hello' }],
        onDelta: () => {},
      })
    ).resolves.toMatchObject({ text: 'TKC CONNECTION OK', model: 'gpt-5.6-luna' });
  });

  it('cancels a live stream without accepting partial output', async () => {
    const harness = makeHarness();
    await harness.service.connect();
    await harness.service.models();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    harness.setResponsesFactory(() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial' })}\n\n`
            )
          );
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const requestId = 'cancel-test';
    const pending = harness.service.infer({
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
      requestId,
    });
    await harness.responsesStarted;
    expect(harness.service.cancel(requestId)).toBe(true);
    try {
      controllerRef?.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    } catch {
      /* stream may already be closed */
    }
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('aborts a live inference when reconnect replaces the active session', async () => {
    const harness = makeHarness();
    const connected = await harness.service.connect();
    const key = connected.activeAccount?.accountKey || '';
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    harness.setResponsesFactory(() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial' })}\n\n`
            )
          );
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const pending = harness.service.infer({
      requestId: 'reconnect-abort',
      accountKey: key,
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
    });
    await harness.responsesStarted;
    await harness.service.reconnect(key);
    try {
      controllerRef?.close();
    } catch {
      /* stream may already be closed */
    }
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(harness.counts().responsesCalls).toBe(1);
  });

  it('never publishes a completed response after refresh invalidates its session', async () => {
    const harness = makeHarness();
    const connected = await harness.service.connect();
    const key = connected.activeAccount?.accountKey || '';
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    harness.setResponsesFactory(() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial' })}\n\n`
            )
          );
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const pending = harness.service.infer({
      requestId: 'refresh-invalidation-abort',
      accountKey: key,
      model: 'test-model',
      input: [{ role: 'user', content: 'Hello' }],
    });
    await harness.responsesStarted;
    harness.oauth.refresh = async () => {
      throw Object.assign(new Error('invalid grant'), { code: 'AUTHENTICATION_FAILED' });
    };
    await expect(harness.service.refreshAccount(key, { force: true })).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
    const encoder = new TextEncoder();
    controllerRef?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`
      )
    );
    controllerRef?.close();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('fails closed when only basic_text credential obfuscation is available', () => {
    const adapter = createSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString: () => Buffer.from('x'),
      decryptString: () => 'x',
    });
    expect(adapter.available()).toBe(false);
    expect(adapter.unavailableReason()).toMatch(/basic_text/);
  });

  it('reports secure storage unavailable without exposing credentials or starting OAuth', async () => {
    const store = new ChatGptCredentialStore({
      dir: tempDir(),
      encryption: { ...fakeEncryption(), available: () => false },
    });
    const service = new ChatGptSubscriptionService({
      enabled: true,
      store,
      oauth: {},
      openExternal: async () => {
        throw new Error('OAuth must not start.');
      },
    });
    const status = service.init();
    expect(status.enabled).toBe(true);
    expect(status.secureStorage).toBe(false);
    expect(status.error?.code).toBe('SECURE_STORAGE_UNAVAILABLE');
    await expect(service.connect()).rejects.toMatchObject({
      code: 'SECURE_STORAGE_UNAVAILABLE',
    });
  });

  it('exposes no token fields through the preload bridge', () => {
    const preload = fs.readFileSync(path.join(process.cwd(), 'desktop', 'preload.cjs'), 'utf8');
    expect(preload).toMatch(/chatgpt:\s*{/);
    expect(preload).not.toMatch(/accessToken|refreshToken|idToken|access_token|refresh_token|id_token/);
  });

  it('contains no unofficial endpoints, DevKit imports, or API-key fallback', () => {
    const root = process.cwd();
    const files = fs.readdirSync(path.join(root, 'desktop', 'chatgpt'));
    const source = files
      .filter((file) => file.endsWith('.cjs'))
      .map((file) => fs.readFileSync(path.join(root, 'desktop', 'chatgpt', file), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/https?:\/\/[^'"\s]*backend-api|https?:\/\/chatgpt\.com\/backend/i);
    expect(source).not.toMatch(/OPENAI_API_KEY|@siwc\/|sign-in-with-chatgpt-devkit/i);
    expect(source).not.toMatch(/client_secret/);
  });
});
