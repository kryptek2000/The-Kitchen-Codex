// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import App from '../../src/App';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
  delete (window as any).showDirectoryPicker;
});

class MockDir {
  kind = 'directory' as const;
  children = new Map();
  name = 'Vault';
  async *values() { for (const c of this.children.values()) yield c; }
  async getFileHandle(n: string, o?: any) {
    if (!this.children.has(n)) {
      if (o?.create) {
        const f = new MockFile(n);
        this.children.set(n, f);
        return f;
      }
      throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
    }
    return this.children.get(n);
  }
  async getDirectoryHandle(n: string, o?: any) {
    if (!this.children.has(n)) {
      if (o?.create) {
        const d = new MockDir();
        d.name = n;
        this.children.set(n, d);
        return d;
      }
      throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
    }
    return this.children.get(n);
  }
  async removeEntry(n: string) { this.children.delete(n); }
  async requestPermission() { return 'granted'; }
  async queryPermission() { return 'granted'; }
}

class MockFile {
  kind = 'file' as const;
  content = '';
  constructor(public name: string) {}
  async getFile() { return { text: async () => this.content }; }
  async createWritable() {
    const self = this;
    return {
      write: async (data: string) => { self.content = data; },
      close: async () => {},
      abort: async () => {},
    };
  }
}

async function connect(root: MockDir) {
  (window as any).showDirectoryPicker = async () => root;
  render(<App />);
  await new Promise((r) => setTimeout(r, 2000));
  fireEvent.click(screen.getByRole('button', { name: /Connect Vault/i }));
  await new Promise((r) => setTimeout(r, 2000));
  fireEvent.click(screen.getAllByText(/Live Directory Sync/i)[0]);
  await new Promise((r) => setTimeout(r, 1000));
  fireEvent.click(screen.getByRole('button', { name: /Choose Local Obsidian Vault Folder/i }));
  await waitFor(() => {
    expect(document.body.textContent || '').toMatch(/Vault Linked/i);
  }, { timeout: 10000 });
}

describe('Favorites deterministic concurrency', () => {
  it('queues overlapping favorite toggles and persists final intent', async () => {
    const root = new MockDir();
    const recipesDir = new MockDir();
    recipesDir.name = 'Recipes';
    root.children.set('Recipes', recipesDir);
    const file = new MockFile('Carbonara.md');
    file.content = '---\ntitle: "Carbonara"\ncuisine: "Italian"\ncategory: "Dinner"\nrating: 4\ndifficulty: Medium\nservings: 4\n---\n# Carbonara\nClassic.\n';
    recipesDir.children.set('Carbonara.md', file);

    // Gate the first write so the second toggle queues behind it.
    let releaseFirst: () => void = () => {};
    let gated = true;
    const originalCreateWritable = file.createWritable.bind(file);
    file.createWritable = async () => {
      const w = await originalCreateWritable();
      return {
        write: async (data: string) => {
          if (gated) {
            gated = false;
            await new Promise<void>((res) => { releaseFirst = res; });
          }
          return w.write(data);
        },
        close: w.close,
        abort: w.abort,
      };
    };

    await connect(root);

    // Combined view keeps the two ownership counts distinguishable.
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Recipe Vault');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 built-in · 1 saved');
    expect(document.getElementById('sidenav-vault-status-line')?.textContent).toContain('1 recipe');
    expect(document.getElementById('sidenav-vault-status-line')?.textContent).toContain('9 built-in');
    expect(document.querySelectorAll('[data-testid="builtin-card-badge"]').length).toBeGreaterThan(0);

    // Personal view reports the one saved recipe only, never the built-ins.
    fireEvent.click(document.getElementById('nav-personal-recipes')!);
    await waitFor(() => {
      expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Saved Recipes');
      expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 saved recipe');
    });
    expect(document.getElementById('obsidian-vault-header')?.textContent).not.toContain('Signature Collection');
    fireEvent.click(document.getElementById('nav-recipe-vault')!);
    await waitFor(() => {
      expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Recipe Vault');
    });

    const personalCard = () => {
      const card = document.getElementById('recipe-card-Recipes/Carbonara.md');
      expect(card).toBeTruthy();
      return card as HTMLElement;
    };

    // Toggle ON (write held)
    fireEvent.click(within(personalCard()).getByRole('button', { name: /Add to favorites/i }));
    await new Promise((r) => setTimeout(r, 500));

    // Favoriting promotes the personal recipe to the featured spread, so the
    // Remove control is the single global favorite control at this point.
    fireEvent.click(screen.getByRole('button', { name: /Remove from favorites/i }));

    // Release first write
    releaseFirst();
    await waitFor(() => {
      expect(file.content).toContain('isFavorite: false');
    }, { timeout: 10000 });

    // UI converges to unfavorited and the personal card returns to the shelf.
    await waitFor(() => {
      expect(document.getElementById('recipe-card-Recipes/Carbonara.md')).toBeTruthy();
    });
  }, 30000);

  it('returns to the built-in view after disconnecting without stale personal labels', async () => {
    const root = new MockDir();
    const recipesDir = new MockDir();
    recipesDir.name = 'Recipes';
    root.children.set('Recipes', recipesDir);
    const file = new MockFile('Carbonara.md');
    file.content = '---\ntitle: "Carbonara"\nsource: "https://example.com/carbonara"\nservings: 4\ningredients: []\n---\n# Carbonara\n';
    recipesDir.children.set('Carbonara.md', file);

    await connect(root);
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Recipe Vault');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 built-in · 1 saved');

    fireEvent.click(document.getElementById('vault-linked-chip')!);
    await screen.findByRole('dialog', { name: /Connect or manage your recipes/i });
    fireEvent.click(screen.getByRole('tab', { name: /Vault Stats/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Use Signature Collection/i }));

    await waitFor(() => {
      expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('Signature Collection');
      expect(document.getElementById('vault-recipe-count')?.textContent).toBe('9 built-in recipes');
    });
    expect(document.getElementById('recipe-card-Recipes/Carbonara.md')).toBeNull();
    expect(document.getElementById('obsidian-vault-header')?.textContent).not.toContain('saved');
  }, 30000);
});
