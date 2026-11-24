// @vitest-environment jsdom
/**
 * SHISO-C1.7 S3 — metadata-only conversation index and bounded search.
 *
 * Focused tests for safe legacy discovery, transcript preservation, rename /
 * delete / new, credential redaction, and search bounds. No live provider, no
 * real Vault, no personal data.
 */
import { describe, it, expect } from 'vitest';

import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';
import { BrowserSettingsAdapter } from '../../src/platform/browser/BrowserSettingsAdapter';
import {
  saveShisoConversation,
  shisoConversationStorageKey,
  SHISO_CONVERSATION_STORAGE_PREFIX,
} from '../../src/application/shisoConversationPersistence';
import {
  buildConversationCorpus,
  buildConversationIndex,
  createConversationRecord,
  decodeConversationStorageKey,
  deleteConversation,
  discoverConversationKeys,
  MAX_INDEXED_CONVERSATIONS,
  MAX_SEARCH_RESULTS,
  renameConversation,
  searchConversations,
  SHISO_CONVERSATION_INDEX_KEY,
} from '../../src/application/shisoConversationIndex';

interface MemorySettings extends SettingsAdapter {
  data: () => Map<string, unknown>;
  keys: () => string[];
}

function memorySettings(): MemorySettings {
  const data = new Map<string, unknown>();
  return {
    get: async <T,>(key: string): Promise<T | undefined> => data.get(key) as T | undefined,
    set: async <T,>(key: string, value: T): Promise<void> => { data.set(key, value); },
    remove: async (key: string): Promise<void> => { data.delete(key); },
    data: () => data,
    keys: () => [...data.keys()],
  };
}

async function seed(settings: MemorySettings, key: string, userText: string, updatedAt: string) {
  await settings.set(shisoConversationStorageKey(key), {
    version: 1,
    conversationKey: key,
    messages: [{ role: 'user', text: userText }],
    entries: [{ key: 'u1', role: 'user', text: userText, tools: [] }],
    findings: [],
    nextSeq: 1,
    updatedAt,
  });
}

describe('S3 — safe legacy discovery', () => {
  it('discovers only namespaced transcript keys and decodes identities', async () => {
    const settings = memorySettings();
    await seed(settings, 'global', 'hello', '2026-01-01T00:00:00.000Z');
    await seed(settings, 'recipe:Chicken/Tonight', 'pasta', '2026-01-02T00:00:00.000Z');
    await settings.set('obsidian_vault_theme', 'nordic');
    await settings.set(`${SHISO_CONVERSATION_STORAGE_PREFIX}-not-a-transcript`, 'junk');

    const keys = await discoverConversationKeys(settings);
    expect(keys).toEqual(expect.arrayContaining(['global', 'recipe:Chicken/Tonight']));
    expect(keys).not.toContain('obsidian_vault_theme');
    expect(keys.length).toBe(2);
    expect(decodeConversationStorageKey(shisoConversationStorageKey('recipe:Chicken/Tonight')))
      .toBe('recipe:Chicken/Tonight');
    expect(decodeConversationStorageKey('unrelated')).toBeNull();
  });

  it('discovery never reads transcript values', async () => {
    const settings = memorySettings();
    await seed(settings, 'global', 'secret payload', '2026-01-01T00:00:00.000Z');
    let reads = 0;
    const counting: SettingsAdapter = {
      get: async (key: string) => { if (key.startsWith(SHISO_CONVERSATION_STORAGE_PREFIX)) reads += 1; return undefined; },
      set: async () => {},
      remove: async () => {},
      keys: settings.keys,
    } as SettingsAdapter & { keys: () => string[] };
    await discoverConversationKeys(counting);
    expect(reads).toBe(0);
  });

  it('BrowserSettingsAdapter.key enumeration is read-only', () => {
    const data = new Map<string, string>([
      [shisoConversationStorageKey('global'), 'value'],
      ['theme', 'obsidian'],
    ]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
    };
    const adapter = new BrowserSettingsAdapter(storage);
    const before = new Map(data);
    const keys = adapter.keys();
    expect(keys).toContain(shisoConversationStorageKey('global'));
    expect(keys).toContain('theme');
    expect([...data.entries()]).toEqual([...before.entries()]);
  });
});

describe('S3 — index build without transcript rewrite', () => {
  it('builds metadata only and leaves legacy transcripts byte-identical', async () => {
    const settings = memorySettings();
    await seed(settings, 'global', 'What should I cook?', '2026-01-02T00:00:00.000Z');
    await seed(settings, 'recipe:Lasagna', 'more garlic please', '2026-01-03T00:00:00.000Z');
    const transcriptsBefore = new Map(
      [...settings.data().entries()]
        .filter(([key]) => key.startsWith(`${SHISO_CONVERSATION_STORAGE_PREFIX}:`))
        .map(([key, value]) => [key, JSON.stringify(value)]),
    );

    const index = await buildConversationIndex(settings);
    expect(index.version).toBe(1);
    expect(index.conversations.length).toBe(2);
    expect(index.conversations.map((c) => c.key)).toEqual(
      expect.arrayContaining(['global', 'recipe:Lasagna']),
    );
    expect(index.conversations.every((c) => !('messages' in c) && !('entries' in c))).toBe(true);
    const transcriptsAfter = new Map(
      [...settings.data().entries()]
        .filter(([key]) => key.startsWith(`${SHISO_CONVERSATION_STORAGE_PREFIX}:`))
        .map(([key, value]) => [key, JSON.stringify(value)]),
    );
    expect([...transcriptsAfter.entries()]).toEqual([...transcriptsBefore.entries()]);
  });

  it('preserves renames across reindex and caps the index', async () => {
    const settings = memorySettings();
    await seed(settings, 'global', 'one', '2026-01-01T00:00:00.000Z');
    let index = await buildConversationIndex(settings);
    index = await renameConversation(settings, 'global', 'Sunday noodles');
    index = await buildConversationIndex(settings);
    expect(index.conversations.find((c) => c.key === 'global')?.title).toBe('Sunday noodles');
    expect(index.conversations.length).toBeLessThanOrEqual(MAX_INDEXED_CONVERSATIONS);
  });

  it('new creates metadata only; delete removes transcript and index record', async () => {
    const settings = memorySettings();
    const { index: withNew, key } = await createConversationRecord(settings);
    expect(withNew.conversations.some((c) => c.key === key)).toBe(true);
    expect(settings.data().has(shisoConversationStorageKey(key))).toBe(false);

    await seed(settings, key, 'remember this', '2026-01-04T00:00:00.000Z');
    expect(settings.data().has(shisoConversationStorageKey(key))).toBe(true);
    const next = await deleteConversation(settings, key);
    expect(settings.data().has(shisoConversationStorageKey(key))).toBe(false);
    expect(next.conversations.some((c) => c.key === key)).toBe(false);
    expect(settings.data().has(SHISO_CONVERSATION_INDEX_KEY)).toBe(true);
  });
});

describe('S3 — bounded message search', () => {
  it('matches titles and messages, returns bounded snippets, and redacts secrets', async () => {
    const settings = memorySettings();
    await seed(settings, 'global', 'My api key sk-abcdefgh12345678 for the soup', '2026-01-01T00:00:00.000Z');
    await seed(settings, 'recipe:Cake', 'birthday cake with candles', '2026-01-02T00:00:00.000Z');
    await saveShisoConversation(settings, 'recipe:Cake', {
      messages: [{ role: 'user', text: 'birthday cake with candles' }],
      entries: [
        { key: 'u1', role: 'user', text: 'birthday cake with candles', tools: [] },
        { key: 'a1', role: 'assistant', text: 'Use the candle technique.', tools: [] },
      ],
      findings: [],
      nextSeq: 2,
    });
    const index = await buildConversationIndex(settings);
    const corpus = await buildConversationCorpus(settings, index);

    const byTitle = searchConversations(corpus, 'cake');
    expect(byTitle.length).toBeGreaterThan(0);
    expect(byTitle.some((r) => r.matchedIn === 'title')).toBe(true);

    const byMessage = searchConversations(corpus, 'candle technique');
    expect(byMessage.length).toBeGreaterThan(0);
    expect(byMessage.some((r) => r.matchedIn === 'message')).toBe(true);

    const secret = searchConversations(corpus, 'api key');
    expect(secret.length).toBeGreaterThan(0);
    expect(secret[0].snippet).not.toContain('sk-abcdefgh12345678');

    expect(searchConversations(corpus, '   ')).toEqual([]);
    expect(searchConversations(corpus, 'cake', 1).length).toBe(1);
    expect(MAX_SEARCH_RESULTS).toBeGreaterThan(0);
    expect(MAX_SEARCH_RESULTS).toBeLessThanOrEqual(12);
  });
});
