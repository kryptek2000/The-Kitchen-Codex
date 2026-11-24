/**
 * SHISO-C1 — local-first conversation persistence.
 *
 * The conversation is stored through the application's existing SettingsAdapter
 * (localStorage in the standalone/desktop shell). It is device-local, bounded,
 * and NEVER contains provider credentials, session tokens, save authorizations,
 * or reusable capabilities. Proposals are deliberately not persisted: an old
 * proposal must never become actionable merely because a transcript was
 * restored.
 */

import type { SettingsAdapter } from './adapters/SettingsAdapter';
import {
  SHISO_LIMITS,
  isShisoToolName,
  type ShisoCollectedFinding,
  type ShisoConversationMessage,
} from '../core/shiso/protocol';

export const SHISO_CONVERSATION_STORAGE_VERSION = 1 as const;
export const SHISO_CONVERSATION_STORAGE_PREFIX = 'tkc_shiso_conversation_v1';
export const SHISO_ACTIVE_CONVERSATION_KEY = 'tkc_shiso_active_conversation_v1';
export const MAX_STORED_TRANSCRIPT_ENTRIES = 120;
export const MAX_STORED_CONVERSATION_BYTES = 256 * 1024;

// Deleted conversation keys are never reused. Keep tombstones scoped to the
// adapter instance so a new disposable profile starts with a clean lifecycle.
// The per-key queue orders a stale save already in flight before the delete,
// while saves attempted after the tombstone is installed are ignored.
const deletedConversationKeys = new WeakMap<SettingsAdapter, Set<string>>();
const persistenceQueues = new WeakMap<SettingsAdapter, Map<string, Promise<void>>>();

function deletedKeysFor(settings: SettingsAdapter): Set<string> {
  let keys = deletedConversationKeys.get(settings);
  if (!keys) {
    keys = new Set<string>();
    deletedConversationKeys.set(settings, keys);
  }
  return keys;
}

function enqueuePersistence(
  settings: SettingsAdapter,
  conversationKey: string,
  operation: () => Promise<void>,
): Promise<void> {
  let queues = persistenceQueues.get(settings);
  if (!queues) {
    queues = new Map<string, Promise<void>>();
    persistenceQueues.set(settings, queues);
  }
  const previous = queues.get(conversationKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(conversationKey, next);
  void next.then(() => {
    if (queues?.get(conversationKey) === next) queues.delete(conversationKey);
  }, () => {
    if (queues?.get(conversationKey) === next) queues.delete(conversationKey);
  });
  return next;
}

export interface ShisoStoredTranscriptEntry {
  readonly key: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly tools: readonly string[];
}

export interface ShisoStoredConversation {
  readonly version: typeof SHISO_CONVERSATION_STORAGE_VERSION;
  readonly conversationKey: string;
  readonly messages: readonly ShisoConversationMessage[];
  readonly entries: readonly ShisoStoredTranscriptEntry[];
  readonly findings: readonly ShisoCollectedFinding[];
  readonly nextSeq: number;
  readonly updatedAt: string;
}

export function shisoConversationStorageKey(conversationKey: string): string {
  return `${SHISO_CONVERSATION_STORAGE_PREFIX}:${encodeURIComponent(conversationKey)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

function readMessages(raw: unknown): ShisoConversationMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ShisoConversationMessage[] = [];
  for (const entry of raw.slice(-SHISO_LIMITS.maxStoredMessages)) {
    if (!isRecord(entry)) continue;
    const role = entry['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    const text = boundedText(entry['text'], role === 'user' ? SHISO_LIMITS.maxUserMessageChars : SHISO_LIMITS.maxAssistantMessageChars);
    if (text === undefined) continue;
    const proposalCount = typeof entry['proposalCount'] === 'number' && Number.isFinite(entry['proposalCount'])
      ? Math.max(0, Math.min(100, Math.floor(entry['proposalCount'])))
      : undefined;
    out.push({ role, text, ...(proposalCount !== undefined ? { proposalCount } : {}) });
  }
  return out;
}

function readEntries(raw: unknown): ShisoStoredTranscriptEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ShisoStoredTranscriptEntry[] = [];
  for (const entry of raw.slice(-MAX_STORED_TRANSCRIPT_ENTRIES)) {
    if (!isRecord(entry)) continue;
    const role = entry['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    const text = boundedText(entry['text'], role === 'user' ? SHISO_LIMITS.maxUserMessageChars : SHISO_LIMITS.maxAssistantMessageChars);
    if (text === undefined) continue;
    const key = boundedText(entry['key'], 80) ?? `restored-${out.length}`;
    const tools = Array.isArray(entry['tools'])
      ? entry['tools'].slice(0, 12).flatMap((tool) => typeof tool === 'string' && tool.trim().length > 0 ? [tool.trim().slice(0, 120)] : [])
      : [];
    out.push({ key, role, text, tools });
  }
  return out;
}

function readFindings(raw: unknown): ShisoCollectedFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ShisoCollectedFinding[] = [];
  for (const entry of raw.slice(-12)) {
    if (!isRecord(entry)) continue;
    const tool = entry['tool'];
    if (!isShisoToolName(tool)) continue;
    const summary = boundedText(entry['summary'], 400);
    if (summary === undefined) continue;
    out.push({ tool, ok: entry['ok'] === true, summary });
  }
  return out;
}

/** Loads a bounded stored conversation. Malformed/legacy data yields null. */
export async function loadShisoConversation(
  settings: SettingsAdapter,
  conversationKey: string,
): Promise<ShisoStoredConversation | null> {
  try {
    const raw = await settings.get<unknown>(shisoConversationStorageKey(conversationKey));
    if (!isRecord(raw) || raw['version'] !== SHISO_CONVERSATION_STORAGE_VERSION || raw['conversationKey'] !== conversationKey) {
      return null;
    }
    const messages = readMessages(raw['messages']);
    const entries = readEntries(raw['entries']);
    if (messages.length === 0 && entries.length === 0) return null;
    const storedNextSeq = typeof raw['nextSeq'] === 'number' && Number.isFinite(raw['nextSeq'])
      ? Math.max(0, Math.min(1_000_000, Math.floor(raw['nextSeq'])))
      : 0;
    let keySeq = 0;
    for (const entry of entries) {
      const match = /(\d+)$/.exec(entry.key);
      if (match) keySeq = Math.max(keySeq, Number(match[1]));
    }
    const nextSeq = Math.max(storedNextSeq, keySeq);
    return Object.freeze({
      version: SHISO_CONVERSATION_STORAGE_VERSION,
      conversationKey,
      messages: Object.freeze(messages),
      entries: Object.freeze(entries),
      findings: Object.freeze(readFindings(raw['findings'])),
      nextSeq,
      updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'].slice(0, 40) : '',
    });
  } catch {
    return null;
  }
}

function serializedSize(value: ShisoStoredConversation): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Saves a bounded snapshot. Oldest messages/entries are dropped until the
 * snapshot fits the local storage bound; failures are non-fatal and never
 * propagate into conversation authority.
 */
export async function saveShisoConversation(
  settings: SettingsAdapter,
  conversationKey: string,
  input: {
    readonly messages: readonly ShisoConversationMessage[];
    readonly entries: readonly ShisoStoredTranscriptEntry[];
    readonly findings: readonly ShisoCollectedFinding[];
    readonly nextSeq: number;
  },
): Promise<void> {
  if (input.messages.length === 0 && input.entries.length === 0) return;
  const deletedKeys = deletedKeysFor(settings);
  if (deletedKeys.has(conversationKey)) return;
  let messages = input.messages.slice(-SHISO_LIMITS.maxStoredMessages);
  let entries = input.entries.slice(-MAX_STORED_TRANSCRIPT_ENTRIES);
  const findings = input.findings.slice(-12);
  let snapshot: ShisoStoredConversation = Object.freeze({
    version: SHISO_CONVERSATION_STORAGE_VERSION,
    conversationKey,
    messages: Object.freeze([...messages]),
    entries: Object.freeze([...entries]),
    findings: Object.freeze([...findings]),
    nextSeq: Math.max(0, Math.min(1_000_000, Math.floor(input.nextSeq))),
    updatedAt: new Date().toISOString(),
  });
  while (serializedSize(snapshot) > MAX_STORED_CONVERSATION_BYTES && (messages.length > 1 || entries.length > 1)) {
    if (messages.length >= entries.length && messages.length > 1) messages = messages.slice(-Math.max(1, messages.length - 10));
    else if (entries.length > 1) entries = entries.slice(-Math.max(1, entries.length - 10));
    snapshot = Object.freeze({
      ...snapshot,
      messages: Object.freeze([...messages]),
      entries: Object.freeze([...entries]),
    });
  }
  if (serializedSize(snapshot) > MAX_STORED_CONVERSATION_BYTES) return;
  await enqueuePersistence(settings, conversationKey, async () => {
    if (deletedKeys.has(conversationKey)) return;
    try {
      await settings.set(shisoConversationStorageKey(conversationKey), snapshot);
    } catch {
      // Local conversation persistence is best-effort; it never affects authority.
    }
  });
}

/** Removes a stored conversation (used only by explicit tests/maintenance). */
export async function clearShisoConversation(settings: SettingsAdapter, conversationKey: string): Promise<void> {
  deletedKeysFor(settings).add(conversationKey);
  await enqueuePersistence(settings, conversationKey, async () => {
    try {
      await settings.remove(shisoConversationStorageKey(conversationKey));
    } catch {
      // best effort
    }
  });
}
