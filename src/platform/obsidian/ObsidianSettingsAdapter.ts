/**
 * The Kitchen Codex — Obsidian Settings Adapter (Phase 4D3B).
 *
 * Concrete implementation of the application `SettingsAdapter` port backed by
 * the Obsidian plugin `loadData()` / `saveData()` object store. It persists
 * app state (theme, active tab, active timers) under ONE namespaced object so
 * it never collides with the plugin's own settings (e.g. the backend URL).
 *
 * DESIGN:
 *   - The plugin `loadData`/`saveData` pair is INJECTED (type-only from
 *     Obsidian) so the adapter is runtime-clean of Obsidian and unit-testable in
 *     Node with a plain-object fake.
 *   - All app-state keys live under a single namespace (`kitchen_codex` by
 *     default) inside the plugin's persisted object; any other top-level plugin
 *     data is preserved untouched.
 *   - Values are stored as-is (structured objects/arrays are ordinary JSON),
 *     so persisted timer objects survive round-trips.
 *   - NO subscriptions, NO migrations framework, NO batching, NO secret storage.
 *     This adapter MUST NEVER store AI provider keys.
 *
 * Required existing keys work unchanged:
 *   - `obsidian_vault_theme`
 *   - `obsidian_active_tab`
 *   - `obsidian_active_cooking_timers`
 */

import type { SettingsAdapter } from '../../application/adapters/SettingsAdapter';

/** The minimal Obsidian plugin storage surface this adapter needs. */
export interface SettingsStore {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ObsidianSettingsAdapter implements SettingsAdapter {
  constructor(private readonly store: SettingsStore, private readonly namespace = 'kitchen_codex') {}

  private async readScope(): Promise<Record<string, unknown>> {
    const data = await this.store.loadData();
    if (!isPlainObject(data)) return {};
    const scope = data[this.namespace];
    return isPlainObject(scope) ? scope : {};
  }

  private async withScope(update: (scope: Record<string, unknown>) => void): Promise<void> {
    const loaded = await this.store.loadData();
    const data: Record<string, unknown> = isPlainObject(loaded) ? loaded : {};
    const existing: unknown = data[this.namespace];
    const current: Record<string, unknown> = isPlainObject(existing) ? existing : {};
    const scope: Record<string, unknown> = { ...current };
    update(scope);
    data[this.namespace] = scope;
    await this.store.saveData(data);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const scope = await this.readScope();
    const value = scope[key];
    return value === undefined ? undefined : (value as T);
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.withScope((scope) => {
      scope[key] = value;
    });
  }

  async remove(key: string): Promise<void> {
    await this.withScope((scope) => {
      delete scope[key];
    });
  }
}
