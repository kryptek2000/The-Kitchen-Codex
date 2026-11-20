/**
 * Bounded, token-free error taxonomy for the ChatGPT subscription integration.
 */

'use strict';

const { USAGE_URL } = require('./config.cjs');

class ChatGptIntegrationError extends Error {
  constructor(code, message, { status, retryable = false, manageUsage = false, cause } = {}) {
    super(message);
    this.name = 'ChatGptIntegrationError';
    this.code = code;
    this.status = status;
    this.retryable = Boolean(retryable);
    this.manageUsage = Boolean(manageUsage);
    if (cause) this.cause = cause;
  }
}

const ERROR_MESSAGES = Object.freeze({
  DISABLED: 'The ChatGPT subscription integration is disabled in this build.',
  SECURE_STORAGE_UNAVAILABLE:
    'Secure operating-system credential storage is unavailable, so ChatGPT credentials cannot be stored safely.',
  NOT_CONNECTED: 'No ChatGPT subscription account is connected.',
  OPERATION_IN_PROGRESS: 'Another ChatGPT sign-in is already in progress.',
  PLAN_DISABLED: 'This account has not granted ChatGPT plan usage.',
  ACCESS_DENIED: 'ChatGPT plan access was declined in the browser.',
  AUTHENTICATION_FAILED: 'ChatGPT sign-in could not be completed.',
  ID_TOKEN_INVALID: 'The ChatGPT identity token could not be verified.',
  OAUTH_STATE_INVALID: 'The ChatGPT sign-in response did not match this attempt.',
  OAUTH_NONCE_INVALID: 'The ChatGPT identity response did not match this attempt.',
  OAUTH_CLIENT_MISMATCH: 'The ChatGPT client registration did not match the selected account.',
  REFRESH_FAILED: 'The ChatGPT session could not be renewed. Sign in again.',
  REAUTH_REQUIRED: 'The ChatGPT session has expired. Reconnect the account.',
  SUBSCRIPTION_LIMIT: 'ChatGPT plan usage limit reached. Manage usage in ChatGPT settings.',
  USAGE_UNAVAILABLE: 'ChatGPT plan usage could not be checked. Try again later.',
  NOT_ELIGIBLE: 'This ChatGPT account or workspace is not eligible for plan usage in this app.',
  UNSUPPORTED_CAPABILITY: 'The selected ChatGPT model does not support this request.',
  UNSUPPORTED_MODEL: 'The selected model is not available to this ChatGPT account.',
  INVALID_MODEL_CATALOG: 'The ChatGPT account returned an invalid model catalog.',
  NO_MODELS: 'This ChatGPT account returned no available text models.',
  INVALID_REQUEST: 'The ChatGPT request is not valid.',
  NETWORK: 'The ChatGPT service could not be reached.',
  TIMEOUT: 'The ChatGPT request timed out.',
  CANCELLED: 'The ChatGPT request was cancelled.',
  STREAM_INCOMPLETE: 'The ChatGPT response ended before completion. Nothing was accepted.',
  RESPONSE_FAILED: 'ChatGPT could not complete the response.',
  RESPONSE_INCOMPLETE: 'ChatGPT did not complete the response. Nothing was accepted.',
  REVOCATION_UNCONFIRMED:
    'The local ChatGPT session was cleared, but remote revocation could not be confirmed.',
});

function errorFor(code, detail, options = {}) {
  return new ChatGptIntegrationError(code, detail || ERROR_MESSAGES[code] || 'ChatGPT request failed.', options);
}

function isAbortError(error) {
  return error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function mapTransportError(error) {
  if (isAbortError(error)) return errorFor('CANCELLED');
  if (error && (error.code === 'TKC_TIMEOUT' || error.name === 'TimeoutError')) {
    return errorFor('TIMEOUT', undefined, { retryable: true });
  }
  return errorFor('NETWORK', undefined, { retryable: true, cause: error });
}

function mapOAuthError(status, payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const code = String(raw.error || raw.code || '').slice(0, 120);
  const description = String(raw.error_description || raw.detail || '').slice(0, 300);
  if (code === 'access_denied') return errorFor('ACCESS_DENIED', undefined, { status });
  if (code === 'invalid_grant') {
    return errorFor('REAUTH_REQUIRED', description || undefined, { status });
  }
  if (code === 'invalid_client') {
    return errorFor('AUTHENTICATION_FAILED', 'The ChatGPT client registration is not valid.', { status });
  }
  if (status === 429) return errorFor('USAGE_UNAVAILABLE', undefined, { status, retryable: true });
  if (status >= 500) return errorFor('NETWORK', undefined, { status, retryable: true });
  return errorFor('AUTHENTICATION_FAILED', description || undefined, { status });
}

function mapSubscriptionCode(code, status) {
  const value = String(code || '');
  if (value === 'subscription_sharing_usage_limit_exceeded') {
    return errorFor('SUBSCRIPTION_LIMIT', undefined, { status, manageUsage: true });
  }
  if (value === 'subscription_sharing_usage_unavailable') {
    return errorFor('USAGE_UNAVAILABLE', undefined, { status, retryable: true });
  }
  if (value === 'subscription_sharing_user_not_eligible') {
    return errorFor('NOT_ELIGIBLE', undefined, { status });
  }
  if (value === 'subscription_sharing_unsupported_capability') {
    return errorFor('UNSUPPORTED_CAPABILITY', undefined, { status });
  }
  if (value === 'subscription_sharing_route_not_supported') {
    return errorFor('UNSUPPORTED_CAPABILITY', undefined, { status });
  }
  if (value === 'subscription_sharing_invalid_user') {
    return errorFor('REAUTH_REQUIRED', undefined, { status });
  }
  if (value === 'subscription_sharing_user_unavailable') {
    return errorFor('USAGE_UNAVAILABLE', undefined, { status, retryable: true });
  }
  if (value === 'chatpass_v2_scope_not_authorized' || value === 'chatpass_v2_invalid_authorization_context') {
    return errorFor('NOT_ELIGIBLE', undefined, { status });
  }
  if (status === 401) return errorFor('REAUTH_REQUIRED', undefined, { status });
  if (status === 403) return errorFor('NOT_ELIGIBLE', undefined, { status });
  if (status === 429) return errorFor('SUBSCRIPTION_LIMIT', undefined, { status, manageUsage: true });
  if (status === 503) return errorFor('USAGE_UNAVAILABLE', undefined, { status, retryable: true });
  return errorFor('RESPONSE_FAILED', undefined, { status });
}

function publicError(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'AUTHENTICATION_FAILED';
  const message =
    error && typeof error.message === 'string' && error.message
      ? error.message
      : ERROR_MESSAGES[code] || 'ChatGPT request failed.';
  return {
    code,
    message,
    status: typeof error?.status === 'number' ? error.status : undefined,
    retryable: Boolean(error?.retryable),
    manageUsage: Boolean(error?.manageUsage),
    manageUsageUrl: error?.manageUsage ? USAGE_URL : undefined,
  };
}

module.exports = {
  ChatGptIntegrationError,
  ERROR_MESSAGES,
  errorFor,
  mapOAuthError,
  mapSubscriptionCode,
  mapTransportError,
  publicError,
};
