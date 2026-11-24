/**
 * SHISO-C1.7 S3 — metadata-only conversation index.
 *
 * Legacy SHISO conversations already live under `tkc_shiso_conversation_v1:*`
 * in the device-local SettingsAdapter. This module DISCOVERS those keys and
 * reads each bounded transcript through the existing loader. It NEVER rewrites
 * a transcript, never changes the conversation authority model, and stores
 * only bounded metadata in its own key.
 */
import type { SettingsAdapter } from './adapters/SettingsAdapter';
import {
  SHISO_CONVERSATION_STORAGE_PREFIX,
  loadShisoConversation,
  clearShisoConversation,
} from './shisoConversationPersistence';

export const SHISO_CONVERSATION_INDEX_KEY = 'tkc_shiso_conversation_index_v1';
export const MAX_INDEXED_CONVERSATIONS = 50;
export const MAX_SEARCH_RESULTS = 12;
const MAX_PREVIEW_CHARS = 140;
const MAX_TITLE_CHARS = 80;
const MAX_SEARCH_SNIPPET = 160;
const MAX_CORPUS_ENTRIES = 40;

export type ShisoConversationSource = 'global' | 'recipe' | 'create' | 'named';

export interface ShisoConversationMeta {
  readonly key: string;
  readonly title: string;
  readonly source: ShisoConversationSource;
  readonly recipeIdentity: string | null;
  readonly updatedAt: string;
  readonly preview: string;
}

export interface ShisoConversationIndex {
  readonly version: 1;
  readonly conversations: readonly ShisoConversationMeta[];
  readonly indexedAt: string;
}

export interface ShisoConversationCorpusEntry {
  readonly meta: ShisoConversationMeta;
  readonly texts: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Removes obvious credential shapes from derived preview/snippet text. */
function redact(text: string): string {
  return text
    .replace(/\b(?:sk|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|token)\s*[:=]\s*\S+/gi, '[redacted]')
    .trim();
}

export function conversationSource(key: string): ShisoConversationSource {
  if (key === 'global') return 'global';
  if (key === 'create' || key.startsWith('create:')) return 'create';
  if (key.startsWith('recipe:')) return 'recipe';
  if (key.startsWith('global:')) return 'named';
  return 'named';
}

/**
 * Returns the recipe identity encoded in a recipe conversation key.
 * Instance keys use `::` after the stable recipe context, so deleting one
 * instance never makes that context key permanently unusable.
 */
export function conversationRecipeIdentity(key: string): string | null {
  if (!key.startsWith('recipe:')) return null;
  const identity = key.slice('recipe:'.length).split('::', 1)[0]?.trim() ?? '';
  return identity.length > 0 ? identity : null;
}

export function decodeConversationStorageKey(storageKey: string): string | null {
  const prefix = `${SHISO_CONVERSATION_STORAGE_PREFIX}:`;
  if (!storageKey.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(storageKey.slice(prefix.length));
  } catch {
    return null;
  }
}

/** Read-only discovery of legacy keys. Never reads or mutates their values. */
export async function discoverConversationKeys(settings: SettingsAdapter): Promise<string[]> {
  const withKeys = settings as SettingsAdapter & { keys?: () => string[] };
  if (typeof withKeys.keys !== 'function') return [];
  let keys: string[];
  try {
    keys = withKeys.keys();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const storageKey of keys) {
    if (typeof storageKey !== 'string') continue;
    const decoded = decodeConversationStorageKey(storageKey);
    if (decoded !== null && !out.includes(decoded)) out.push(decoded);
  }
  return out;
}

function readStoredIndex(raw: unknown): Map<string, ShisoConversationMeta> {
  const map = new Map<string, ShisoConversationMeta>();
  if (!isRecord(raw) || raw['version'] !== 1 || !Array.isArray(raw['conversations'])) return map;
  for (const item of raw['conversations']) {
    if (!isRecord(item) || typeof item['key'] !== 'string' || item['key'].length === 0) continue;
    map.set(item['key'], Object.freeze({
      key: item['key'],
      title: bounded(item['title'], MAX_TITLE_CHARS) || 'Conversation',
      source: conversationSource(item['key']),
      recipeIdentity: typeof item['recipeIdentity'] === 'string' ? item['recipeIdentity'].slice(0, 160) : null,
      updatedAt: bounded(item['updatedAt'], 40),
      preview: bounded(item['preview'], MAX_PREVIEW_CHARS),
    }));
  }
  return map;
}

async function writeIndex(settings: SettingsAdapter, index: ShisoConversationIndex): Promise<void> {
  try {
    await settings.set(SHISO_CONVERSATION_INDEX_KEY, index);
  } catch {
    // Metadata index is best-effort; it never affects conversation authority.
  }
}

/**
 * Builds (or refreshes) the metadata index. Existing titles are preserved so a
 * rename survives reindexing. Transcripts are only READ through the existing
 * bounded loader; this function never calls saveShisoConversation.
 */
export async function buildConversationIndex(settings: SettingsAdapter): Promise<ShisoConversationIndex> {
  const existing = readStoredIndex(await settings.get<unknown>(SHISO_CONVERSATION_INDEX_KEY).catch(() => undefined));
  const discovered = await discoverConversationKeys(settings);
  const keys = [...new Set([...existing.keys(), ...discovered])].slice(0, MAX_INDEXED_CONVERSATIONS * 2);
  const conversations: ShisoConversationMeta[] = [];
  for (const key of keys) {
    const stored = await loadShisoConversation(settings, key);
    if (stored === null) continue;
    const firstUser = stored.entries.find((entry) => entry.role === 'user')?.text
      ?? stored.messages.find((message) => message.role === 'user')?.text
      ?? '';
    const previous = existing.get(key);
    conversations.push(Object.freeze({
      key,
      title: previous?.title ?? (conversationSource(key) === 'global' ? 'General conversation'
        : conversationSource(key) === 'create' ? 'Recipe creation'
        : conversationSource(key) === 'recipe' ? bounded(conversationRecipeIdentity(key), MAX_TITLE_CHARS) || 'Recipe conversation'
        : 'New conversation'),
      source: conversationSource(key),
      recipeIdentity: conversationRecipeIdentity(key),
      updatedAt: stored.updatedAt || previous?.updatedAt || '',
      preview: redact(firstUser).slice(0, MAX_PREVIEW_CHARS),
    }));
  }
  conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const index: ShisoConversationIndex = Object.freeze({
    version: 1,
    conversations: Object.freeze(conversations.slice(0, MAX_INDEXED_CONVERSATIONS)),
    indexedAt: new Date().toISOString(),
  });
  await writeIndex(settings, index);
  return index;
}

export function defaultNewConversationKey(contextKey = 'global'): string {
  const random = Math.random().toString(36).slice(2, 10);
  if (contextKey === 'create') return `create:${Date.now().toString(36)}-${random}`;
  if (contextKey.startsWith('recipe:')) {
    return `${contextKey}::${Date.now().toString(36)}-${random}`;
  }
  return `global:${Date.now().toString(36)}-${random}`;
}

/** Adds a named conversation record. No transcript is created or rewritten. */
export async function createConversationRecord(settings: SettingsAdapter, contextKey = 'global'): Promise<{ index: ShisoConversationIndex; key: string }> {
  const key = defaultNewConversationKey(contextKey);
  const source = conversationSource(key);
  const index = await buildConversationIndex(settings);
  const meta: ShisoConversationMeta = Object.freeze({
    key,
    title: source === 'create' ? 'Recipe creation' : source === 'recipe' ? 'Recipe conversation' : 'New conversation',
    source,
    recipeIdentity: conversationRecipeIdentity(key),
    updatedAt: new Date().toISOString(),
    preview: '',
  });
  const next: ShisoConversationIndex = Object.freeze({
    version: 1,
    conversations: Object.freeze([meta, ...index.conversations].slice(0, MAX_INDEXED_CONVERSATIONS)),
    indexedAt: new Date().toISOString(),
  });
  await writeIndex(settings, next);
  return { index: next, key };
}

export async function renameConversation(settings: SettingsAdapter, key: string, rawTitle: string): Promise<ShisoConversationIndex> {
  const title = bounded(rawTitle, MAX_TITLE_CHARS) || 'Conversation';
  const index = await buildConversationIndex(settings);
  const next: ShisoConversationIndex = Object.freeze({
    version: 1,
    conversations: Object.freeze(index.conversations.map((meta) => meta.key === key ? Object.freeze({ ...meta, title }) : meta)),
    indexedAt: new Date().toISOString(),
  });
  await writeIndex(settings, next);
  return next;
}

/** Deletes both the transcript and its metadata record. Requires caller confirmation. */
export async function deleteConversation(settings: SettingsAdapter, key: string): Promise<ShisoConversationIndex> {
  await clearShisoConversation(settings, key);
  const index = await buildConversationIndex(settings);
  const next: ShisoConversationIndex = Object.freeze({
    version: 1,
    conversations: Object.freeze(index.conversations.filter((meta) => meta.key !== key)),
    indexedAt: new Date().toISOString(),
  });
  await writeIndex(settings, next);
  return next;
}

/** Builds a bounded search corpus once; searching itself is pure and offline. */
export async function buildConversationCorpus(settings: SettingsAdapter, index: ShisoConversationIndex): Promise<readonly ShisoConversationCorpusEntry[]> {
  const entries: ShisoConversationCorpusEntry[] = [];
  for (const meta of index.conversations.slice(0, MAX_INDEXED_CONVERSATIONS)) {
    const stored = await loadShisoConversation(settings, meta.key);
    if (stored === null) continue;
    const texts = stored.entries
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .slice(-MAX_CORPUS_ENTRIES)
      .map((entry) => entry.text);
    entries.push(Object.freeze({ meta, texts: Object.freeze(texts) }));
  }
  return entries;
}

export interface ShisoConversationSearchResult {
  readonly key: string;
  readonly title: string;
  readonly snippet: string;
  readonly matchedIn: 'title' | 'message';
}

export function searchConversations(
  corpus: readonly ShisoConversationCorpusEntry[],
  rawQuery: string,
  limit = MAX_SEARCH_RESULTS,
): readonly ShisoConversationSearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return [];
  const results: ShisoConversationSearchResult[] = [];
  for (const entry of corpus) {
    if (entry.meta.title.toLowerCase().includes(query)) {
      results.push({ key: entry.meta.key, title: entry.meta.title, snippet: entry.meta.preview, matchedIn: 'title' });
      if (results.length >= limit) break;
      continue;
    }
    for (const text of entry.texts) {
      const at = text.toLowerCase().indexOf(query);
      if (at < 0) continue;
      const start = Math.max(0, at - 40);
      results.push({
        key: entry.meta.key,
        title: entry.meta.title,
        snippet: redact(text.slice(start, start + MAX_SEARCH_SNIPPET)),
        matchedIn: 'message',
      });
      break;
    }
    if (results.length >= limit) break;
  }
  return results;
}
