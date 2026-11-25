/**
 * The Kitchen Codex — Sign in with ChatGPT subscription configuration.
 *
 * Local experimental integration. Disabled unless the native process is
 * explicitly started with TKC_CHATGPT_SUBSCRIPTION=1.
 *
 * This module contains no DevKit code. It implements only the documented
 * open-source OAuth and Responses API contract.
 */

'use strict';

const ENABLE_ENV = 'TKC_CHATGPT_SUBSCRIPTION';
const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const MODELS_URL = 'https://api.openai.com/v1/models';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const CALLBACK_PATH = '/auth/callback';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_NAME = 'The Kitchen Codex';

const IDENTITY_SCOPES = ['openid', 'profile', 'email'];
const PLAN_SCOPES = ['offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const REQUESTED_SCOPES = [...IDENTITY_SCOPES, ...PLAN_SCOPES];

const UNSUPPORTED_RESPONSE_FIELDS = Object.freeze([
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
]);

function isEnabled(env = process.env) {
  return String(env[ENABLE_ENV] || '') === '1';
}

module.exports = {
  AGENT_NAME,
  AUTHORIZE_URL,
  CALLBACK_PATH,
  CALLBACK_TIMEOUT_MS,
  DISCOVERY_URL,
  ENABLE_ENV,
  IDENTITY_SCOPES,
  ISSUER,
  MODELS_URL,
  PLAN_SCOPES,
  REQUESTED_SCOPES,
  RESOURCE,
  RESPONSES_URL,
  TOKEN_URL,
  UNSUPPORTED_RESPONSE_FIELDS,
  USAGE_URL,
  isEnabled,
};
