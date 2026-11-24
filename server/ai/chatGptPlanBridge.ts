/**
 * The Kitchen Codex — native ChatGPT plan bridge (SHISO-C1.5).
 *
 * The Electron main process owns the ChatGPT OAuth session. The browser never
 * receives a token. This module is the SERVER-SIDE client for the narrow
 * loopback bridge exposed by that trusted process:
 *
 *   Electron main  ── loopback + per-process bearer token ──>  local server
 *
 * SECURITY / TRUTH:
 *   - The bridge is configured ONLY by the desktop launcher through the two
 *     fixed environment variables below. They are absent in web deployments, so
 *     the provider is not registered there at all.
 *   - The URL is validated as a loopback HTTP endpoint. No caller-controlled
 *     endpoint, host, or port is accepted.
 *   - The token is never returned to the browser, logged, or placed in a
 *     catalog/status payload.
 *   - No API key is involved. This is ChatGPT plan usage (OAuth) only.
 *   - Model IDs are always the account's live, server-verified catalog. An
 *     arbitrary client-supplied model ID is never executable.
 *   - A disconnected/expired/entitled-out account resolves to NO execution. It
 *     never falls back to Gemini or another paid API provider.
 */

import { ProviderOperationError } from "./providerErrors.js";

/** Fixed, non-general environment names written by the Electron main process. */
export const CHATGPT_PLAN_BRIDGE_URL_ENV = "TKC_CHATGPT_PLAN_BRIDGE_URL";
export const CHATGPT_PLAN_BRIDGE_TOKEN_ENV = "TKC_CHATGPT_PLAN_BRIDGE_TOKEN";

/** The exact provider id exposed in the server catalog. */
export const CHATGPT_PLAN_PROVIDER_ID = "chatgpt-plan";

const MAX_MODELS = 64;
const MAX_MODEL_ID_CHARS = 128;
const MAX_BRIDGE_RESPONSE_BYTES = 512 * 1024;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_KEY_PATTERN = /^acct_[a-f0-9]{32}$/;

export interface ChatGptPlanBridgeConfig {
  readonly url: string;
  readonly token: string;
}

export interface ChatGptPlanModel {
  readonly id: string;
  readonly name: string;
}

interface ChatGptPlanCatalogCache {
  models: ChatGptPlanModel[];
  connected: boolean;
  planEnabled: boolean;
  activeAccountKey: string | null;
  fetchedAt: number;
}

let cache: ChatGptPlanCatalogCache = {
  models: [],
  connected: false,
  planEnabled: false,
  activeAccountKey: null,
  fetchedAt: 0,
};

/**
 * Reads the two fixed env names and validates the loopback origin. Returns null
 * for absent, malformed, or non-loopback configuration. This is deliberately
 * synchronous and network-free so registry construction stays deterministic.
 */
export function getChatGptPlanBridgeConfig(): ChatGptPlanBridgeConfig | null {
  // Desktop-only authority. A hosted/web deployment that happens to define the
  // bridge env names still cannot register the native provider.
  if (String(process.env?.TKC_DESKTOP_RUNTIME || "") !== "1") return null;
  const rawUrl = typeof process.env?.[CHATGPT_PLAN_BRIDGE_URL_ENV] === "string"
    ? process.env[CHATGPT_PLAN_BRIDGE_URL_ENV]!.trim()
    : "";
  const token = typeof process.env?.[CHATGPT_PLAN_BRIDGE_TOKEN_ENV] === "string"
    ? process.env[CHATGPT_PLAN_BRIDGE_TOKEN_ENV]!.trim()
    : "";
  if (!rawUrl || !token) return null;
  if (token.length < 32 || token.length > 256) return null;
  if (/[\s\x00-\x1f\x7f]/.test(token)) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "127.0.0.1") return null;
  if (!parsed.port || !/^\d{2,5}$/.test(parsed.port)) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  return { url: parsed.origin, token };
}

/** True when this deployment is the native desktop app with the ChatGPT bridge. */
export function isChatGptPlanBridgeConfigured(): boolean {
  return getChatGptPlanBridgeConfig() !== null;
}

/** True only for the account-key shape the Electron service generates. */
export function isValidChatGptPlanAccountKey(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_KEY_PATTERN.test(value);
}

function sanitizeModels(raw: unknown): ChatGptPlanModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatGptPlanModel[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const value = row as { id?: unknown; name?: unknown };
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!MODEL_ID_PATTERN.test(id) || id.length > MAX_MODEL_ID_CHARS) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof value.name === "string" && value.name.trim()
      ? value.name.trim().slice(0, 160)
      : id;
    out.push({ id, name });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

interface BridgeEnvelope {
  ok?: unknown;
  connected?: unknown;
  planEnabled?: unknown;
  activeAccountKey?: unknown;
  models?: unknown;
  value?: unknown;
  error?: unknown;
}

function bridgeError(error: unknown, fallback: string): ProviderOperationError {
  const row = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const code = typeof row.code === "string" ? row.code : "";
  const message = typeof row.message === "string" && row.message.trim()
    ? row.message.trim().slice(0, 400)
    : fallback;
  switch (code) {
    case "CANCELLED":
      return new ProviderOperationError("CANCELLED", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    case "TIMEOUT":
      return new ProviderOperationError("TIMEOUT", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    case "SUBSCRIPTION_LIMIT":
      return new ProviderOperationError("QUOTA", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    case "USAGE_UNAVAILABLE":
    case "NETWORK":
      return new ProviderOperationError("UNAVAILABLE", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    case "REAUTH_REQUIRED":
    case "NOT_CONNECTED":
    case "PLAN_DISABLED":
    case "NOT_ELIGIBLE":
      return new ProviderOperationError("AUTH", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    case "UNSUPPORTED_MODEL":
    case "UNSUPPORTED_CAPABILITY":
    case "INVALID_REQUEST":
      return new ProviderOperationError("UNSUPPORTED_CAPABILITY", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    case "INVALID_MODEL_CATALOG":
    case "NO_MODELS":
    case "STREAM_INCOMPLETE":
    case "RESPONSE_INCOMPLETE":
      return new ProviderOperationError("INVALID_RESPONSE", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    case "RESPONSE_FAILED":
      return new ProviderOperationError("PROVIDER_ERROR", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
    default:
      return new ProviderOperationError("PROVIDER_ERROR", message, { providerId: CHATGPT_PLAN_PROVIDER_ID });
  }
}

async function readBoundedJson(res: Response): Promise<BridgeEnvelope> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BRIDGE_RESPONSE_BYTES) {
    throw new ProviderOperationError("INVALID_RESPONSE", "The ChatGPT plan bridge response was too large.", {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }
  const text = await res.text();
  if (text.length > MAX_BRIDGE_RESPONSE_BYTES) {
    throw new ProviderOperationError("INVALID_RESPONSE", "The ChatGPT plan bridge response was too large.", {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as BridgeEnvelope) : {};
  } catch {
    throw new ProviderOperationError("INVALID_RESPONSE", "The ChatGPT plan bridge returned unreadable data.", {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }
}

async function bridgeRequest(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number; signal?: AbortSignal },
): Promise<BridgeEnvelope> {
  const config = getChatGptPlanBridgeConfig();
  if (!config) {
    throw new ProviderOperationError("UNAVAILABLE", "The ChatGPT plan bridge is not configured.", {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 130_000);
  const signal = init.signal
    ? (typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, timeout]) : init.signal)
    : timeout;
  let res: Response;
  try {
    res = await fetch(`${config.url}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal,
    });
  } catch (error) {
    if (init.signal?.aborted) {
      throw new ProviderOperationError("CANCELLED", "The ChatGPT plan request was cancelled.", {
        providerId: CHATGPT_PLAN_PROVIDER_ID,
      });
    }
    if (error && (error as { name?: string }).name === "TimeoutError") {
      throw new ProviderOperationError("TIMEOUT", "The ChatGPT plan bridge timed out.", {
        providerId: CHATGPT_PLAN_PROVIDER_ID,
      });
    }
    throw new ProviderOperationError("NETWORK", "The ChatGPT plan bridge could not be reached.", {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }
  let payload: BridgeEnvelope;
  try {
    payload = await readBoundedJson(res);
  } catch (error) {
    if (error instanceof ProviderOperationError) throw error;
    throw new ProviderOperationError("INVALID_RESPONSE", "The ChatGPT plan bridge returned unreadable data.", {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }
  if (payload.ok !== true) {
    throw bridgeError(payload.error, "The ChatGPT plan request did not succeed.");
  }
  return payload;
}

/**
 * Refreshes the bounded catalog/connection truth from the bridge. Safe to call
 * from the provider catalog route: it never throws and never spends provider
 * usage. A disconnected or unentitled account yields an explicit empty cache.
 */
export async function refreshChatGptPlanCatalog(options: { maxAgeMs?: number } = {}): Promise<void> {
  const maxAgeMs = options.maxAgeMs;
  if (
    typeof maxAgeMs === 'number' &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    cache.fetchedAt > 0 &&
    Date.now() - cache.fetchedAt <= maxAgeMs
  ) {
    return;
  }
  if (!isChatGptPlanBridgeConfigured()) {
    cache = { models: [], connected: false, planEnabled: false, activeAccountKey: null, fetchedAt: 0 };
    return;
  }
  try {
    const payload = await bridgeRequest("/v1/models", { method: "GET", timeoutMs: 20_000 });
    const connected = payload.connected === true;
    const planEnabled = payload.planEnabled === true;
    const activeAccountKey = isValidChatGptPlanAccountKey(payload.activeAccountKey)
      ? payload.activeAccountKey
      : null;
    const models = connected && planEnabled ? sanitizeModels(payload.models) : [];
    cache = {
      models,
      connected,
      planEnabled,
      activeAccountKey,
      fetchedAt: Date.now(),
    };
  } catch {
    // Fail closed: no models and no execution authority. A transient bridge
    // failure must never be interpreted as connected/entitled.
    cache = { models: [], connected: false, planEnabled: false, activeAccountKey: null, fetchedAt: Date.now() };
  }
}

/** The current models this account may execute. Empty when unavailable. */
export function chatGptPlanModelIds(): string[] {
  return cache.models.map((row) => row.id);
}

/** Non-secret display rows for the catalog. */
export function chatGptPlanModelRows(): ChatGptPlanModel[] {
  return cache.models.map((row) => ({ ...row }));
}

export interface ChatGptPlanConnectionSnapshot {
  readonly connected: boolean;
  readonly planEnabled: boolean;
  readonly activeAccountKey: string | null;
  readonly fetchedAt: number;
}

/** Read-only connection truth for status/catalog rows. */
export function getChatGptPlanConnectionSnapshot(): ChatGptPlanConnectionSnapshot {
  return {
    connected: cache.connected,
    planEnabled: cache.planEnabled,
    activeAccountKey: cache.activeAccountKey,
    fetchedAt: cache.fetchedAt,
  };
}

/** True when the bridge has a live, plan-enabled account for this account key. */
export function isChatGptPlanAvailable(accountKey?: string): boolean {
  if (!isChatGptPlanBridgeConfigured()) return false;
  if (!cache.connected || !cache.planEnabled) return false;
  if (accountKey && cache.activeAccountKey !== accountKey) return false;
  return true;
}

/** Runs one bounded inference through the trusted Electron bridge. */
export async function inferWithChatGptPlan(options: {
  readonly accountKey?: string;
  readonly model: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<string> {
  const payload = await bridgeRequest("/v1/infer", {
    method: "POST",
    timeoutMs: options.timeoutMs ?? 130_000,
    signal: options.signal,
    body: {
      ...(options.accountKey ? { accountKey: options.accountKey } : {}),
      model: options.model,
      input: [{ role: "user", content: options.prompt }],
    },
  });
  const value = payload.value as { text?: unknown } | undefined;
  const text = typeof value?.text === "string" ? value.text : "";
  if (!text.trim()) {
    throw new ProviderOperationError("INVALID_RESPONSE", "The ChatGPT plan returned an empty response.", {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }
  return text;
}

/** Test-only reset (never used by production callers). */
export function resetChatGptPlanCatalogForTests(): void {
  cache = { models: [], connected: false, planEnabled: false, activeAccountKey: null, fetchedAt: 0 };
}
