/**
 * The Kitchen Codex — BrowserSettingsAdapter (Phase 4D2A).
 *
 * Tests the localStorage-backed SettingsAdapter against an injected fake
 * storage. No real browser/DOM harness. Covers: round-trips, remove, missing,
 * malformed-JSON behavior (legacy bare-string preservation), and the fact that
 * the module does not touch global localStorage at import time.
 */

import { describe, it, expect } from 'vitest';
import {
  BrowserSettingsAdapter,
  StorageLike,
} from '../../src/platform/browser';

function fakeStorage(initial: Record<string, string> = {}): {
  storage: StorageLike;
  store: Record<string, string>;
} {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    storage: {
      getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  };
}

describe('BrowserSettingsAdapter', () => {
  it('set/get round-trips a string', async () => {
    const { storage } = fakeStorage();
    const a = new BrowserSettingsAdapter(storage);
    await a.set('ui.theme', 'nordic');
    expect(await a.get('ui.theme')).toBe('nordic');
  });

  it('round-trips an object', async () => {
    const { storage } = fakeStorage();
    const a = new BrowserSettingsAdapter(storage);
    await a.set('ui.filters', { search: 'x', tags: ['a', 'b'] });
    expect(await a.get('ui.filters')).toEqual({ search: 'x', tags: ['a', 'b'] });
  });

  it('round-trips numbers and booleans', async () => {
    const { storage } = fakeStorage();
    const a = new BrowserSettingsAdapter(storage);
    await a.set('ui.rating', 5);
    await a.set('ui.fav', true);
    expect(await a.get('ui.rating')).toBe(5);
    expect(await a.get('ui.fav')).toBe(true);
  });

  it('remove deletes the key (get -> undefined)', async () => {
    const { storage } = fakeStorage();
    const a = new BrowserSettingsAdapter(storage);
    await a.set('k', 'v');
    expect(await a.get('k')).toBe('v');
    await a.remove('k');
    expect(await a.get('k')).toBeUndefined();
  });

  it('missing key returns undefined', async () => {
    const a = new BrowserSettingsAdapter(fakeStorage().storage);
    expect(await a.get('nope')).toBeUndefined();
  });

  it('returns a raw string for legacy bare-string values (migration-safe)', async () => {
    // Old code wrote theme/tab as bare strings (not JSON).
    const { storage } = fakeStorage({ obsidian_vault_theme: 'nordic', obsidian_active_tab: 'grid' });
    const a = new BrowserSettingsAdapter(storage);
    expect(await a.get('obsidian_vault_theme')).toBe('nordic');
    expect(await a.get('obsidian_active_tab')).toBe('grid');
    // Now a write via the adapter upgrades to JSON and still round-trips.
    await a.set('obsidian_vault_theme', 'parchment');
    expect(await a.get('obsidian_vault_theme')).toBe('parchment');
  });

  it('returns a raw string for malformed (non-JSON) stored values (defined, never throws)', async () => {
    const { storage } = fakeStorage({ 'ui.config': '{not json' });
    const a = new BrowserSettingsAdapter(storage);
    expect(await a.get('ui.config')).toBe('{not json');
  });

  it('emits undefined when storage returns null', async () => {
    const a = new BrowserSettingsAdapter(fakeStorage({ 'k': null as unknown as string }).storage);
    expect(await a.get('k')).toBeUndefined();
  });

  it('does not touch global localStorage at module import; a no-window default get is safe', async () => {
    // Vitest runs in Node (no window). Constructing without an injected storage
    // must fall back to a no-op storage and never throw on import/get.
    const a = new BrowserSettingsAdapter();
    expect(await a.get('anything')).toBeUndefined();
    await expect(a.set('k', 'v')).resolves.toBeUndefined();
    await expect(a.remove('k')).resolves.toBeUndefined();
  });

  it('round-trips an ActiveTimer array exactly (remainingSeconds + fields preserved)', async () => {
    const { storage } = fakeStorage();
    const a = new BrowserSettingsAdapter(storage);
    const timers = [
      {
        id: 't1',
        recipeTitle: 'Lasagna',
        label: '25 min',
        totalSeconds: 1500,
        remainingSeconds: 900,
        isRunning: true,
        createdAt: 1700000000000,
      },
    ];
    await a.set('obsidian_active_cooking_timers', timers);
    const loaded = await a.get<typeof timers>('obsidian_active_cooking_timers');
    expect(loaded).toEqual(timers);
    expect(loaded?.[0].remainingSeconds).toBe(900);
  });

  it('loads the legacy JSON-serialized timer array representation (committed format)', async () => {
    // Committed code wrote JSON.stringify(activeTimers) directly to the key.
    const legacy = JSON.stringify([
      { id: 't1', recipeTitle: 'Ramen', label: '10 min', totalSeconds: 600, remainingSeconds: 400, isRunning: true, createdAt: 1700000000000 },
    ]);
    const { storage } = fakeStorage({ obsidian_active_cooking_timers: legacy });
    const a = new BrowserSettingsAdapter(storage);
    const loaded = await a.get<Array<{ remainingSeconds: number }>>('obsidian_active_cooking_timers');
    expect(loaded).toHaveLength(1);
    expect(loaded?.[0].remainingSeconds).toBe(400);
  });

  it('persists the wall-clock endsAt field (upgraded timer schema)', async () => {
    const { storage } = fakeStorage();
    const a = new BrowserSettingsAdapter(storage);
    const timers = [
      { id: 't1', recipeTitle: 'Lasagna', label: 'Step 1: Bake', totalSeconds: 60, remainingSeconds: 45, isRunning: true, createdAt: 1700000000000, endsAt: 1700000000000 + 45 * 1000, semanticKey: 'rid::step:1' },
    ];
    await a.set('obsidian_active_cooking_timers', timers);
    const loaded = await a.get<Array<{ endsAt?: number; semanticKey?: string }>>('obsidian_active_cooking_timers');
    expect(loaded?.[0].endsAt).toBe(1700000000000 + 45 * 1000);
    expect(loaded?.[0].semanticKey).toBe('rid::step:1');
  });
});
