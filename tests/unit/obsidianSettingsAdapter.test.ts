import { describe, it, expect } from 'vitest';
import { ObsidianSettingsAdapter } from '../../src/platform/obsidian/ObsidianSettingsAdapter';
import type { SettingsStore } from '../../src/platform/obsidian/ObsidianSettingsAdapter';

// --- loadData()/saveData() plugin fake (persisted object store) ---

class FakePluginStore implements SettingsStore {
  private data: unknown;
  constructor(initial?: unknown) {
    this.data = initial ?? {};
  }
  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }
  snapshot(): unknown {
    return this.data;
  }
}

describe('ObsidianSettingsAdapter (Phase 4D3B)', () => {
  it('returns undefined for a missing key', async () => {
    const store = new FakePluginStore();
    const adapter = new ObsidianSettingsAdapter(store);
    expect(await adapter.get('missing')).toBeUndefined();
  });

  it('stores a primitive under the namespace and reads it back', async () => {
    const store = new FakePluginStore();
    const adapter = new ObsidianSettingsAdapter(store);
    await adapter.set('obsidian_active_tab', 'detail');
    expect(await adapter.get('obsidian_active_tab')).toBe('detail');
  });

  it('stores a structured timer list and overwrites it', async () => {
    const store = new FakePluginStore();
    const adapter = new ObsidianSettingsAdapter(store);
    const timers = [{ id: 'a', remainingSeconds: 30 }];
    await adapter.set('obsidian_active_cooking_timers', timers);
    expect(await adapter.get('obsidian_active_cooking_timers')).toEqual(timers);
    await adapter.set('obsidian_active_cooking_timers', []);
    expect(await adapter.get('obsidian_active_cooking_timers')).toEqual([]);
  });

  it('removes a key', async () => {
    const store = new FakePluginStore();
    const adapter = new ObsidianSettingsAdapter(store);
    await adapter.set('obsidian_vault_theme', 'nordic');
    await adapter.remove('obsidian_vault_theme');
    expect(await adapter.get('obsidian_vault_theme')).toBeUndefined();
  });

  it('keeps unrelated top-level plugin data intact and namespaced', async () => {
    const store = new FakePluginStore({ backendUrl: 'http://127.0.0.1:3000' });
    const adapter = new ObsidianSettingsAdapter(store, 'kitchen_codex');
    await adapter.set('obsidian_active_tab', 'list');
    // The plugin's own backendUrl setting must be preserved untouched.
    const snapshot = store.snapshot() as Record<string, unknown>;
    expect(snapshot['backendUrl']).toBe('http://127.0.0.1:3000');
    expect(snapshot['kitchen_codex']).toEqual({ obsidian_active_tab: 'list' });
  });
});
