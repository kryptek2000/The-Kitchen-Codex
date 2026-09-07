/**
 * The Kitchen Codex — Browser Settings Adapter (Phase 4D2A).
 *
 * Concrete implementation of the application `SettingsAdapter` port backed by
 * `window.localStorage`. It is a local, device-scoped key/value store for UI
 * preferences (theme, active tab, active timers) — NEVER secrets.
 *
 * DESIGN:
 *   - Constructor-injected `StorageLike` dependency (defaults to
 *     `window.localStorage`, falling back to a no-op in non-browser test
 *     contexts). No `localStorage` access happens at module import time.
 *   - All values are JSON-serialized on write.
 *   - On read, valid JSON is parsed; if the stored value is NOT valid JSON it is
 *     returned as a raw string. This deliberately preserves pre-existing legacy
 *     bare-string settings (e.g. the old theme/tab values written directly with
 *     `localStorage.setItem('obsidian_vault_theme', 'nordic')`), so migrating to
 *     this adapter does NOT reset user preferences. The next write re-serializes
 *     to JSON (graceful one-way upgrade).
 *   - Malformed/empty/absent values never throw; they yield `undefined` (or the
 *     raw string). No secret-specific behavior, no migration framework, no
 *     subscriptions, no batch API, no IndexedDB.
 */

import type { SettingsAdapter } from '../../application/adapters/SettingsAdapter';

/** The minimal synchronous storage surface this adapter needs (browser-localStorage-shaped). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function noopStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

function defaultStorage(): StorageLike {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    return window.localStorage;
  }
  return noopStorage();
}

export class BrowserSettingsAdapter implements SettingsAdapter {
  private readonly storage: StorageLike;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultStorage();
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = this.storage.getItem(key);
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Not valid JSON. Return the raw string so legacy bare-string settings
      // (theme/tab written directly as a non-JSON string) are preserved.
      return raw as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.storage.setItem(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.storage.removeItem(key);
  }
}
