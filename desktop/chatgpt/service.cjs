/**
 * Trusted native ChatGPT subscription service.
 *
 * Session-only credential authority:
 *   - OAuth access, refresh, and ID tokens exist only in this process;
 *   - every account has a monotonic in-memory `generation`;
 *   - disconnect increments it, clears credentials synchronously, aborts
 *     outstanding refresh/inference work, and can never be overwritten by a
 *     late refresh result;
 *   - refresh commits only if the captured account identity and generation
 *     still match and the account is still signed in;
 *   - application restart starts disconnected; no credential record is loaded;
 *   - inference registers its cancellation record before the first await.
 *
 * Tokens never leave the Electron main process. The renderer receives only
 * account labels, plan state, model metadata, and completed text.
 */

'use strict';

const crypto = require('node:crypto');
const {
  AGENT_NAME,
  IDENTITY_SCOPES,
  PLAN_SCOPES,
  REQUESTED_SCOPES,
  USAGE_URL,
} = require('./config.cjs');
const {
  ChatGptIntegrationError,
  errorFor,
  mapOAuthError,
  publicError,
} = require('./errors.cjs');
const { verifyIdToken } = require('./jwt.cjs');
const { isValidModelSlug } = require('./oauth.cjs');
const { createLoopbackCallbackServer } = require('./loopback.cjs');
const { createPkce, randomToken } = require('./pkce.cjs');

const MODEL_CACHE_MS = 5 * 60 * 1000;
const ACCESS_REFRESH_WINDOW_MS = 2 * 60 * 1000;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 40_000;
const MAX_TOTAL_INPUT_CHARS = 100_000;
const MAX_INSTRUCTIONS_CHARS = 20_000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function accountKeyFor(subject, clientId) {
  return `acct_${sha256(`${subject}\n${clientId}`).slice(0, 32)}`;
}

const ALLOWED_SCOPES = new Set([...IDENTITY_SCOPES, ...PLAN_SCOPES]);
const SCOPE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SCOPE_STRING = 2048;

function parseGrantedScopes(value) {
  if (typeof value !== 'string') {
    return { valid: false, scopes: [], reason: 'scope_missing_or_not_string' };
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > MAX_SCOPE_STRING) {
    return { valid: false, scopes: [], reason: 'scope_empty_oversized_or_untrimmed' };
  }
  if (/[^\x20-\x7E]/.test(trimmed)) {
    return { valid: false, scopes: [], reason: 'scope_non_ascii' };
  }
  const parts = trimmed.split(' ');
  if (parts.length === 0 || parts.length > 32 || parts.some((part) => part === '')) {
    return { valid: false, scopes: [], reason: 'scope_count_invalid' };
  }
  if (parts.some((part) => !SCOPE_TOKEN.test(part))) {
    return { valid: false, scopes: [], reason: 'scope_grammar_invalid' };
  }
  if (new Set(parts).size !== parts.length) {
    return { valid: false, scopes: [], reason: 'scope_duplicate' };
  }
  if (parts.some((part) => !ALLOWED_SCOPES.has(part))) {
    return { valid: false, scopes: [], reason: 'scope_unknown' };
  }
  return { valid: true, scopes: parts, reason: '' };
}

function hasPlanUsageScopes(scopes) {
  return Array.isArray(scopes) && PLAN_SCOPES.every((scope) => scopes.includes(scope));
}

function sameScopeSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((scope) => expected.has(scope));
}

/**
 * Only the token endpoint's top-level `scope` is authoritative. Access-token
 * payloads are never decoded for admission.
 */
function scopesFromTokenResponse(tokens) {
  return parseGrantedScopes(tokens?.scope);
}

function publicAccount(account, activeKey) {
  return {
    accountKey: account.accountKey,
    email: account.email || '',
    planEnabled: Boolean(account.planEnabled),
    signedOut: Boolean(account.signedOut),
    active: account.accountKey === activeKey,
    savedAt: account.savedAt,
  };
}

function validateRequest({ model, input, instructions }) {
  if (!isValidModelSlug(model)) {
    throw errorFor('INVALID_REQUEST', 'A valid ChatGPT model is required.');
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) {
    throw errorFor('INVALID_REQUEST', 'The ChatGPT input history is invalid.');
  }
  let total = 0;
  const normalized = input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw errorFor('INVALID_REQUEST', 'The ChatGPT input history is invalid.');
    }
    if (item.role !== 'user' && item.role !== 'assistant') {
      throw errorFor('INVALID_REQUEST', 'Only user and assistant history messages are supported.');
    }
    if (typeof item.content !== 'string' || item.content.length > MAX_MESSAGE_CHARS) {
      throw errorFor('INVALID_REQUEST', 'A ChatGPT input message is invalid.');
    }
    total += item.content.length;
    return { role: item.role, content: item.content };
  });
  if (total > MAX_TOTAL_INPUT_CHARS) {
    throw errorFor('INVALID_REQUEST', 'The ChatGPT input history is too large.');
  }
  if (instructions !== undefined) {
    if (typeof instructions !== 'string' || instructions.length > MAX_INSTRUCTIONS_CHARS) {
      throw errorFor('INVALID_REQUEST', 'The ChatGPT instructions are invalid.');
    }
  }
  return { input: normalized, instructions };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw errorFor('CANCELLED');
}

function combineSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  return active[0];
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function waitForAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(errorFor('CANCELLED'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, errorFor('CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

class ChatGptSubscriptionService {
  constructor({
    enabled = false,
    store,
    oauth,
    openExternal,
    logger = () => {},
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.enabled = Boolean(enabled);
    this.store = store;
    this.oauth = oauth;
    this.openExternal = openExternal;
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    this.storageError = null;
    this.refreshLocks = new Map();
    this.modelCache = new Map();
    this.requests = new Map();
    this.pendingConnect = null;
    this.lastError = null;
  }

  init() {
    if (!this.enabled) return this.status();
    try {
      this.store.init();
      this.storageError = null;
      this.modelCache.clear();
      this.lastError = null;
      const legacy = this.store.getLegacyStatus?.();
      if (legacy?.failed?.length) {
        this.logger({ event: 'chatgpt.legacy_credentials_inert' });
      }
    } catch (error) {
      this.storageError = {
        code: error?.code || 'SECURE_STORAGE_UNAVAILABLE',
        message:
          error?.code === 'SECURE_STORAGE_UNAVAILABLE'
            ? error.message
            : 'ChatGPT session metadata could not be initialized safely.',
      };
      this.logger({ event: 'chatgpt.storage_unavailable', code: this.storageError.code });
    }
    return this.status();
  }

  assertEnabled() {
    if (!this.enabled) throw errorFor('DISABLED');
    if (this.storageError) throw errorFor('SECURE_STORAGE_UNAVAILABLE', this.storageError.message);
  }

  state() {
    return this.store.getState();
  }

  activeAccount() {
    if (!this.enabled || this.storageError) return null;
    const state = this.state();
    if (!state.activeAccountKey) return null;
    return state.accounts[state.activeAccountKey] || null;
  }

  accountFor(accountKey) {
    const state = this.state();
    const key = typeof accountKey === 'string' && accountKey ? accountKey : state.activeAccountKey;
    const account = key ? state.accounts[key] : null;
    if (!account) throw errorFor('NOT_CONNECTED');
    return account;
  }

  abortPendingConnect() {
    try {
      this.pendingConnect?.controller.abort();
    } catch {
      /* best effort */
    }
  }

  abortAccountOperations(accountKey) {
    for (const record of this.requests.values()) {
      if (record.accountKey === accountKey) record.controller.abort();
    }
    const lock = this.refreshLocks.get(accountKey);
    try {
      lock?.controller.abort();
    } catch {
      /* best effort */
    }
  }

  abortAllInference() {
    for (const record of this.requests.values()) record.controller.abort();
  }

  /**
   * Invalidate only the in-memory session. There is no restart-visible
   * credential authority to repair: no token was persisted, so a late refresh
   * or a failed metadata write cannot restore an authenticated account.
   *
   * This is deliberately also used for refresh scope changes. A refresh is
   * allowed to retain an existing grant, but it may not add or reduce authority
   * without an explicit browser reauthorization.
   */
  invalidateAccount({ accountKey, generation, refreshToken, reason }) {
    const currentState = this.state();
    const current = currentState.accounts[accountKey];
    if (
      !current ||
      current.generation !== generation ||
      current.refreshToken !== refreshToken ||
      current.signedOut
    ) {
      return false;
    }

    const nextState = cloneState(currentState);
    const next = nextState.accounts[accountKey];
    next.generation = (Number.isInteger(next.generation) ? next.generation : 1) + 1;
    next.accessToken = null;
    next.refreshToken = null;
    next.idToken = null;
    next.expiresAt = 0;
    next.planEnabled = false;
    next.grantValid = false;
    next.scopes = [];
    next.signedOut = true;
    next.savedAt = new Date(this.now()).toISOString();
    if (nextState.activeAccountKey === accountKey) nextState.activeAccountKey = null;

    // Synchronous generation advance and token clearing. Abort afterward so a
    // peer that ignores its signal still fails the generation/entitlement
    // recheck before publication.
    this.store.setSessionState(nextState);
    this.abortAccountOperations(accountKey);
    this.modelCache.delete(accountKey);
    this.logger({ event: 'chatgpt.invalidated', reason: String(reason || 'unknown').slice(0, 80) });
    return true;
  }

  status() {
    if (!this.enabled) {
      return {
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
    if (this.storageError) {
      return {
        enabled: true,
        secureStorage: false,
        sessionOnly: true,
        signInRequiredAfterRestart: true,
        legacyCredentials: this.store?.getLegacyStatus?.()?.inert ? 'present_inert' : 'none',
        connected: false,
        accounts: [],
        activeAccount: null,
        models: [],
        error: this.storageError,
      };
    }
    const state = this.state();
    const accounts = Object.values(state.accounts)
      .filter((account) => !account.signedOut)
      .map((account) => publicAccount(account, state.activeAccountKey))
      .sort((a, b) => Number(b.active) - Number(a.active) || String(a.email).localeCompare(String(b.email)));
    const active = this.activeAccount();
    const cached = state.activeAccountKey ? this.modelCache.get(state.activeAccountKey) : null;
    const legacy = this.store.getLegacyStatus?.();
    return {
      enabled: true,
      secureStorage: true,
      sessionOnly: true,
      signInRequiredAfterRestart: true,
      legacyCredentials: legacy?.inert ? 'present_inert' : legacy?.present?.length ? 'removed' : 'none',
      connected: Boolean(active && !active.signedOut),
      accounts,
      activeAccount: active
        ? {
            accountKey: active.accountKey,
            email: active.email || '',
            planEnabled: Boolean(active.planEnabled),
            scopes: Array.isArray(active.scopes) ? [...active.scopes] : [],
            signedOut: Boolean(active.signedOut),
            expiresAt: active.expiresAt || 0,
          }
        : null,
      models: cached && this.now() - cached.fetchedAt < MODEL_CACHE_MS ? cached.models : [],
      error: this.lastError,
    };
  }

  async validateIdToken(tokens, { clientId, nonce, expectedSubject, signal }) {
    const verify = async (forceJwks) => {
      throwIfAborted(signal);
      const jwks = await this.oauth.getJwks(forceJwks, signal);
      throwIfAborted(signal);
      return verifyIdToken({
        token: tokens.id_token,
        jwks,
        issuer: 'https://auth.openai.com',
        audience: clientId,
        nonce,
        expectedSubject,
        now: Math.floor(this.now() / 1000),
      });
    };
    try {
      return await verify(false);
    } catch (error) {
      if (signal?.aborted) throw errorFor('CANCELLED');
      if (error instanceof ChatGptIntegrationError) throw error;
      if (/signing key/i.test(String(error?.message || ''))) {
        try {
          return await verify(true);
        } catch (retryError) {
          if (retryError instanceof ChatGptIntegrationError) throw retryError;
          throw errorFor('ID_TOKEN_INVALID', retryError.message);
        }
      }
      throw errorFor('ID_TOKEN_INVALID', error.message);
    }
  }

  async connect({ accountKey, forceConsent = false } = {}) {
    this.assertEnabled();
    if (this.pendingConnect) {
      throw errorFor('OPERATION_IN_PROGRESS', 'Another ChatGPT sign-in is already in progress.');
    }

    const controller = new AbortController();
    const signal = controller.signal;
    const operation = {
      id: randomToken(12),
      controller,
      accountKey: typeof accountKey === 'string' ? accountKey : null,
    };
    this.pendingConnect = operation;
    let listener = null;

    try {
      const state = this.state();
      const existing = accountKey ? state.accounts[accountKey] : null;
      if (accountKey && (!existing || existing.signedOut)) throw errorFor('NOT_CONNECTED');
      const priorGeneration = existing?.generation || 0;
      const registration = this.store.getRegistration();
      const registeredClientId = existing?.clientId || registration?.clientId || '';

      const pkce = createPkce(randomToken(64));
      const stateValue = randomToken(32);
      const nonce = randomToken(32);
      throwIfAborted(signal);
      listener = await createLoopbackCallbackServer({
        expectedState: stateValue,
        path: '/auth/callback',
        signal,
      });
      // Handle a cancellation that lands before the wait is awaited below.
      listener.wait.catch(() => {});

      const clientId = registeredClientId || 'dynamic_agent_client';
      const url = this.oauth.buildAuthorizationUrl({
        clientId,
        redirectUri: listener.redirectUri,
        state: stateValue,
        nonce,
        challenge: pkce.challenge,
        hostId: this.store.getHostId(),
        agentNameHint: registeredClientId ? undefined : AGENT_NAME,
        idTokenHint: existing?.idToken || undefined,
        loginHint: existing?.email || undefined,
        forceConsent: Boolean(existing && (forceConsent || !existing.planEnabled)),
      });
      throwIfAborted(signal);
      try {
        await this.openExternal(url);
      } catch {
        if (signal.aborted) throw errorFor('CANCELLED');
        throw errorFor('NETWORK', 'The system browser could not be opened for ChatGPT sign-in.');
      }
      throwIfAborted(signal);
      const callback = await listener.wait;
      throwIfAborted(signal);

      if (callback.error) {
        throw mapOAuthError(400, { error: callback.error, error_description: callback.error_description });
      }
      if (!callback.code) throw errorFor('AUTHENTICATION_FAILED', 'The sign-in callback did not include a code.');

      let issuedClientId = registeredClientId;
      if (registeredClientId) {
        if (callback.client_id && callback.client_id !== registeredClientId) {
          throw errorFor('OAUTH_CLIENT_MISMATCH');
        }
      } else {
        if (!callback.client_id || callback.client_id === 'dynamic_agent_client') {
          throw errorFor('AUTHENTICATION_FAILED', 'ChatGPT did not return an issued client registration.');
        }
        if (callback.client_id.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(callback.client_id)) {
          throw errorFor('AUTHENTICATION_FAILED', 'ChatGPT returned an invalid client registration.');
        }
        issuedClientId = callback.client_id;
      }

      const tokens = await this.oauth.exchangeCode({
        code: callback.code,
        clientId: issuedClientId,
        codeVerifier: pkce.verifier,
        redirectUri: listener.redirectUri,
        signal,
      });
      throwIfAborted(signal);
      if (!tokens || typeof tokens.id_token !== 'string' || !tokens.id_token) {
        throw errorFor('ID_TOKEN_INVALID', 'ChatGPT did not return an ID token.');
      }
      const claims = await this.validateIdToken(tokens, {
        clientId: issuedClientId,
        nonce,
        expectedSubject: existing?.subject,
        signal,
      });
      throwIfAborted(signal);

      const grant = scopesFromTokenResponse(tokens);
      const scopes = grant.valid ? grant.scopes : [];
      const planEnabled = grant.valid && hasPlanUsageScopes(scopes);
      const accessToken = typeof tokens.access_token === 'string' && tokens.access_token ? tokens.access_token : null;
      if (planEnabled && !accessToken) {
        throw errorFor('PLAN_DISABLED', 'ChatGPT did not return a plan access token.');
      }
      const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null;
      const expiresIn = Number(tokens.expires_in);
      const expiresAt = this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
      const key = accountKeyFor(claims.sub, issuedClientId);
      const nowIso = new Date(this.now()).toISOString();

      const latestState = this.state();
      const latestExisting = latestState.accounts[key] || null;
      if (existing) {
        if (!latestExisting || latestExisting.generation !== priorGeneration) {
          throw errorFor('REAUTH_REQUIRED', 'The selected ChatGPT account changed during sign-in.');
        }
      }
      throwIfAborted(signal);
      if (this.pendingConnect !== operation) throw errorFor('CANCELLED');

      const account = {
        accountKey: key,
        email: typeof claims.email === 'string' ? claims.email : existing?.email || '',
        issuer: claims.iss,
        subject: claims.sub,
        clientId: issuedClientId,
        generation: (latestExisting?.generation || priorGeneration || 0) + 1,
        idToken: tokens.id_token,
        accessToken,
        refreshToken,
        tokenType: String(tokens.token_type || 'Bearer').slice(0, 40),
        expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600,
        expiresAt,
        earliestRefreshAt: typeof tokens.earliest_refresh_at === 'string' ? tokens.earliest_refresh_at : '',
        scopes,
        grantValid: grant.valid,
        planEnabled,
        signedOut: false,
        savedAt: nowIso,
        lastValidatedAt: nowIso,
      };
      const nextState = cloneState(latestState);
      nextState.accounts[key] = account;
      nextState.registration = { clientId: issuedClientId };
      nextState.activeAccountKey = key;
      this.abortAllInference();
      this.store.setSessionState(nextState);
      this.modelCache.delete(key);
      this.lastError = null;
      this.logger({ event: 'chatgpt.connected', planEnabled });
      return this.status();
    } catch (error) {
      if (signal.aborted) throw errorFor('CANCELLED');
      throw error;
    } finally {
      if (this.pendingConnect === operation) this.pendingConnect = null;
      try {
        listener?.close();
      } catch {
        /* best effort */
      }
    }
  }

  reconnect(accountKey) {
    return this.connect({ accountKey, forceConsent: true });
  }

  cancelConnect() {
    if (!this.pendingConnect) return false;
    this.pendingConnect.controller.abort();
    return true;
  }

  selectAccount(accountKey) {
    this.assertEnabled();
    const account = this.accountFor(accountKey);
    if (account.signedOut) throw errorFor('REAUTH_REQUIRED');
    this.abortPendingConnect();
    this.abortAllInference();
    const state = cloneState(this.state());
    state.activeAccountKey = account.accountKey;
    this.store.setSessionState(state);
    this.lastError = null;
    return this.status();
  }

  async disconnect(accountKey) {
    this.assertEnabled();
    const state = this.state();
    const account = this.accountFor(accountKey);
    if (account.signedOut) throw errorFor('REAUTH_REQUIRED');
    const key = account.accountKey;
    const clientId = account.clientId;
    const refreshToken = account.refreshToken;

    this.abortPendingConnect();
    this.abortAccountOperations(key);

    // Logical invalidation is complete synchronously in memory before the
    // remote-revocation attempt. No token or reusable account record was ever
    // persisted, so a storage failure cannot revive this generation.
    const nextState = cloneState(state);
    const nextAccount = nextState.accounts[key];
    nextAccount.generation = (Number.isInteger(nextAccount.generation) ? nextAccount.generation : 1) + 1;
    nextAccount.accessToken = null;
    nextAccount.refreshToken = null;
    nextAccount.idToken = null;
    nextAccount.expiresAt = 0;
    nextAccount.planEnabled = false;
    nextAccount.grantValid = false;
    nextAccount.scopes = [];
    nextAccount.signedOut = true;
    nextAccount.savedAt = new Date(this.now()).toISOString();
    if (nextState.activeAccountKey === key) nextState.activeAccountKey = null;
    this.store.setSessionState(nextState);
    this.modelCache.delete(key);

    let confirmed = !refreshToken;
    if (refreshToken) {
      for (let attempt = 0; attempt < 3 && !confirmed; attempt += 1) {
        try {
          const result = await this.oauth.revoke({ clientId, refreshToken });
          confirmed = Boolean(result.confirmed);
          if (confirmed) break;
        } catch {
          /* retry bounded; never expose token material */
        }
        if (attempt < 2) await this.sleep(250 * 2 ** attempt);
      }
    }

    const warning = confirmed
      ? null
      : {
          code: 'REVOCATION_UNCONFIRMED',
          message: 'Remote revocation was not confirmed. The local session was cleared.',
        };
    this.lastError = warning;
    return {
      status: this.status(),
      remoteRevocationConfirmed: confirmed,
      localPersistence: 'session_memory',
      warning,
    };
  }

  async refreshAccount(accountKey, { force = false, signal: externalSignal } = {}) {
    this.assertEnabled();
    const key = accountKey || this.state().activeAccountKey;
    if (!key) throw errorFor('NOT_CONNECTED');
    const existingLock = this.refreshLocks.get(key);
    if (existingLock) return waitForAbort(existingLock.promise, externalSignal);

    const state = this.state();
    const account = state.accounts[key];
    if (!account) throw errorFor('NOT_CONNECTED');
    if (account.signedOut || !account.refreshToken) throw errorFor('REAUTH_REQUIRED');
    if (!force && account.expiresAt - this.now() > ACCESS_REFRESH_WINDOW_MS) {
      return account.accessToken;
    }

    const generation = account.generation;
    const capturedRefreshToken = account.refreshToken;
    const capturedClientId = account.clientId;
    const capturedSubject = account.subject;
    const capturedScopes = Array.isArray(account.scopes) ? [...account.scopes] : [];
    const capturedGrantValid = Boolean(account.grantValid);
    const controller = new AbortController();
    const signal = combineSignals(externalSignal, controller.signal);

    const ensureCurrent = () => {
      const latest = this.state().accounts[key];
      if (
        !latest ||
        latest.generation !== generation ||
        latest.signedOut ||
        latest.refreshToken !== capturedRefreshToken
      ) {
        throw errorFor('REAUTH_REQUIRED', 'The ChatGPT account changed during refresh.');
      }
      if (signal?.aborted) throw errorFor('CANCELLED');
      return latest;
    };

    const task = (async () => {
      throwIfAborted(signal);
      let tokens;
      try {
        tokens = await this.oauth.refresh({
          clientId: capturedClientId,
          refreshToken: capturedRefreshToken,
          signal,
        });
      } catch (error) {
        const latest = this.state().accounts[key];
        if (signal?.aborted && (!latest || latest.generation !== generation || latest.signedOut)) {
          throw errorFor('REAUTH_REQUIRED', 'The ChatGPT account was disconnected or replaced during refresh.');
        }
        if (error?.code === 'REAUTH_REQUIRED' || error?.code === 'AUTHENTICATION_FAILED') {
          this.invalidateAccount({
            accountKey: key,
            generation,
            refreshToken: capturedRefreshToken,
            reason: 'refresh_authentication_failed',
          });
        }
        throw error;
      }

      ensureCurrent();
      if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
        throw errorFor('REFRESH_FAILED', 'ChatGPT did not return a renewed access token.');
      }
      if (typeof tokens.id_token === 'string' && tokens.id_token) {
        await this.validateIdToken(tokens, {
          clientId: capturedClientId,
          expectedSubject: capturedSubject,
          signal,
        });
      }

      // Authoritative commit guard. No await is permitted between this check and
      // the synchronous in-memory commit below.
      const latestState = this.state();
      ensureCurrent();
      const nextState = cloneState(latestState);
      const next = nextState.accounts[key];

      const hasNewScope = Object.prototype.hasOwnProperty.call(tokens, 'scope');
      const grant = hasNewScope
        ? parseGrantedScopes(tokens.scope)
        : { valid: capturedGrantValid, scopes: capturedGrantValid ? capturedScopes : [] };
      if (hasNewScope && (!grant.valid || !sameScopeSet(grant.scopes, capturedScopes))) {
        this.invalidateAccount({
          accountKey: key,
          generation,
          refreshToken: capturedRefreshToken,
          reason: grant.valid ? 'refresh_scope_changed' : 'refresh_scope_invalid',
        });
        throw errorFor(
          'REAUTH_REQUIRED',
          'ChatGPT permissions changed during refresh. Reconnect to authorize the current grant.'
        );
      }
      const scopes = grant.valid ? grant.scopes : [];
      const planEnabled = grant.valid && hasPlanUsageScopes(scopes);
      const expiresIn = Number(tokens.expires_in);
      next.accessToken = tokens.access_token;
      next.refreshToken =
        typeof tokens.refresh_token === 'string' && tokens.refresh_token
          ? tokens.refresh_token
          : next.refreshToken;
      next.idToken =
        typeof tokens.id_token === 'string' && tokens.id_token ? tokens.id_token : next.idToken;
      next.tokenType = String(tokens.token_type || next.tokenType || 'Bearer').slice(0, 40);
      next.expiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
      next.expiresAt = this.now() + next.expiresIn * 1000;
      next.earliestRefreshAt =
        typeof tokens.earliest_refresh_at === 'string' ? tokens.earliest_refresh_at : next.earliestRefreshAt;
      next.scopes = scopes;
      next.grantValid = grant.valid;
      next.planEnabled = planEnabled;
      next.signedOut = false;
      next.savedAt = new Date(this.now()).toISOString();
      this.store.setSessionState(nextState);
      this.modelCache.delete(key);
      return next.accessToken;
    })();

    const lock = { promise: task, controller };
    const releaseLock = () => {
      if (this.refreshLocks.get(key) === lock) this.refreshLocks.delete(key);
    };
    this.refreshLocks.set(key, lock);
    task.then(releaseLock, releaseLock);
    return waitForAbort(task, externalSignal);
  }

  async models(accountKey, { force = false, signal } = {}) {
    this.assertEnabled();
    throwIfAborted(signal);
    const key = accountKey || this.state().activeAccountKey;
    const account = this.accountFor(key);
    if (!account.grantValid || !account.planEnabled || account.signedOut) throw errorFor('PLAN_DISABLED');
    const generation = account.generation;
    const cached = this.modelCache.get(key);
    if (
      !force &&
      cached &&
      cached.generation === generation &&
      this.now() - cached.fetchedAt < MODEL_CACHE_MS
    ) {
      return cached.models;
    }
    const accessToken = await this.refreshAccount(key, { signal });
    throwIfAborted(signal);
    let latest = this.state().accounts[key];
    if (!latest || latest.generation !== generation || latest.signedOut) {
      throw errorFor('REAUTH_REQUIRED', 'The ChatGPT account changed during model discovery.');
    }
    if (!latest.grantValid || !latest.planEnabled) throw errorFor('PLAN_DISABLED');
    const models = await this.oauth.listModels(accessToken, { signal });
    throwIfAborted(signal);
    if (!Array.isArray(models) || models.length === 0) throw errorFor('NO_MODELS');
    latest = this.state().accounts[key];
    if (!latest || latest.generation !== generation || latest.signedOut) {
      throw errorFor('REAUTH_REQUIRED', 'The ChatGPT account changed during model discovery.');
    }
    if (!latest.grantValid || !latest.planEnabled) throw errorFor('PLAN_DISABLED');
    this.modelCache.set(key, { fetchedAt: this.now(), generation, models });
    this.lastError = null;
    return models;
  }

  async infer({ accountKey, model, input, instructions, requestId } = {}) {
    this.assertEnabled();
    const key = accountKey || this.state().activeAccountKey;
    const account = this.accountFor(key);
    if (!account.grantValid || !account.planEnabled || account.signedOut) {
      throw errorFor('PLAN_DISABLED');
    }
    const generation = account.generation;
    const normalized = validateRequest({ model, input, instructions });

    const id = String(requestId || crypto.randomUUID()).slice(0, 120);
    if (!id || this.requests.has(id)) throw errorFor('INVALID_REQUEST', 'Duplicate ChatGPT request identifier.');
    const controller = new AbortController();
    const record = { controller, accountKey: key };
    this.requests.set(id, record);

    const requireEntitled = () => {
      const latest = this.state().accounts[key];
      if (!latest || latest.generation !== generation || latest.signedOut) {
        throw errorFor('REAUTH_REQUIRED', 'The ChatGPT account changed during inference.');
      }
      if (!latest.grantValid || !latest.planEnabled) throw errorFor('PLAN_DISABLED');
      throwIfAborted(controller.signal);
    };

    try {
      throwIfAborted(controller.signal);
      // Revalidate account-specific catalog and eligibility at execution time.
      const models = await this.models(key, { force: true, signal: controller.signal });
      requireEntitled();
      if (!models.some((entry) => entry.id === model)) throw errorFor('UNSUPPORTED_MODEL');
      const accessToken = await this.refreshAccount(key, { signal: controller.signal });
      requireEntitled();
      if (this.requests.get(id) !== record) throw errorFor('CANCELLED');

      const result = await this.oauth.streamResponse({
        accessToken,
        model,
        input: normalized.input,
        instructions: normalized.instructions,
        signal: controller.signal,
        onDelta: () => {},
      });
      // A stream can resolve after the refresh/invalidation path has revoked
      // its session. Re-check the generation and entitlement before exposing
      // any accumulated output as a successful completion.
      requireEntitled();
      this.lastError = null;
      return { requestId: id, model, text: result.text, completed: true };
    } catch (error) {
      if (controller.signal.aborted && error?.code !== 'CANCELLED') {
        throw errorFor('CANCELLED');
      }
      const publicValue = publicError(error);
      this.lastError = publicValue;
      throw error;
    } finally {
      this.requests.delete(id);
    }
  }

  cancel(requestId) {
    const record = this.requests.get(String(requestId || ''));
    if (!record) return false;
    record.controller.abort();
    return true;
  }

  async manageUsage() {
    this.assertEnabled();
    await this.openExternal(USAGE_URL);
    return { opened: true };
  }

  clearSession() {
    if (!this.enabled || this.storageError) return;
    const state = cloneState(this.state());
    state.accounts = {};
    state.activeAccountKey = null;
    this.store.setSessionState(state);
    this.modelCache.clear();
    this.lastError = null;
  }

  shutdown() {
    this.abortPendingConnect();
    this.pendingConnect = null;
    this.abortAllInference();
    for (const lock of this.refreshLocks.values()) {
      try {
        lock.controller.abort();
      } catch {
        /* best effort */
      }
    }
    this.requests.clear();
    this.clearSession();
  }
}

module.exports = {
  ChatGptSubscriptionService,
  MODEL_CACHE_MS,
  PLAN_SCOPES,
  REQUESTED_SCOPES,
  accountKeyFor,
  hasPlanUsageScopes,
  sameScopeSet,
  parseGrantedScopes,
  publicAccount,
  scopesFromTokenResponse,
  validateRequest,
};
