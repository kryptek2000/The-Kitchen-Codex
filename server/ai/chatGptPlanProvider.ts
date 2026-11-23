/**
 * The Kitchen Codex — ChatGPT plan text provider (SHISO-C1.5).
 *
 * A narrow AiProvider adapter over the trusted native bridge. This provider:
 *   - exists ONLY when the desktop main process configured the loopback bridge;
 *   - uses ChatGPT plan OAuth usage through the Electron process;
 *   - advertises PLAIN TEXT only. Structured output is not claimed until the
 *     officially supported Responses contract is demonstrated compatible;
 *   - never reads an API key and never falls back to another provider.
 */

import { ProviderOperationError } from "./providerErrors.js";
import type {
  AiCapabilities,
  AiGenerateOptions,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from "./types.js";
import {
  CHATGPT_PLAN_PROVIDER_ID,
  inferWithChatGptPlan,
  isChatGptPlanAvailable,
  isChatGptPlanBridgeConfigured,
  isValidChatGptPlanAccountKey,
} from "./chatGptPlanBridge.js";

/** Plain text reasoning only; no schema/tool contract is claimed. */
const CHATGPT_PLAN_CAPABILITIES: AiCapabilities = {
  reasoning: true,
  structuredOutput: false,
  recipeGeneration: false,
  webSearch: false,
};

export interface ChatGptPlanProviderOptions {
  /** Exact native account selected by the user. Non-secret metadata. */
  readonly accountKey?: string;
  /** Test-only request seam; production uses the loopback bridge. */
  readonly inferFn?: (options: {
    accountKey?: string;
    model: string;
    prompt: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<string>;
}

export class ChatGptPlanProvider implements AiProvider {
  readonly id = CHATGPT_PLAN_PROVIDER_ID;
  readonly name = "ChatGPT plan";
  readonly capabilities = CHATGPT_PLAN_CAPABILITIES;
  private readonly accountKey?: string;
  private readonly inferFn: NonNullable<ChatGptPlanProviderOptions["inferFn"]>;

  constructor(options: ChatGptPlanProviderOptions = {}) {
    this.accountKey = isValidChatGptPlanAccountKey(options.accountKey)
      ? options.accountKey
      : undefined;
    this.inferFn = options.inferFn ?? inferWithChatGptPlan;
  }

  isAvailable(): boolean {
    if (!isChatGptPlanBridgeConfigured()) return false;
    return isChatGptPlanAvailable(this.accountKey);
  }

  async testConnection(): Promise<boolean> {
    return this.isAvailable();
  }

  async generate(prompt: string, options: AiGenerateOptions = { model: "" }): Promise<string> {
    if (!this.isAvailable()) {
      throw new ProviderOperationError(
        "AUTH",
        "ChatGPT plan is not connected or its plan usage is unavailable. Reconnect it in AI Studio.",
        { providerId: this.id, model: options.model },
      );
    }
    return this.inferFn({
      ...(this.accountKey ? { accountKey: this.accountKey } : {}),
      model: options.model,
      prompt,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  async generateStructured<T = unknown>(
    _prompt: string,
    _schema: AiJsonSchema,
    options: AiStructuredOptions = { model: "" },
  ): Promise<T> {
    throw new ProviderOperationError(
      "UNSUPPORTED_CAPABILITY",
      "ChatGPT plan does not yet have a verified structured-output contract in The Kitchen Codex.",
      { providerId: this.id, model: options.model },
    );
  }
}

/** Builds a request-scoped provider bound to one exact native account. */
export function createChatGptPlanProvider(
  accountKey?: string,
): ChatGptPlanProvider | null {
  if (!isChatGptPlanBridgeConfigured()) return null;
  if (!isValidChatGptPlanAccountKey(accountKey)) return null;
  return new ChatGptPlanProvider({ accountKey });
}
