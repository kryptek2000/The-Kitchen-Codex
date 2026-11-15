// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import App from '../../src/App';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '#/');
  delete (window as any).showDirectoryPicker;
});

class MockDir {
  kind = 'directory' as const;
  children = new Map<string, MockDir | MockFile>();
  name = 'Vault';
  permission: 'granted' | 'denied' | 'prompt' = 'granted';
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
  async requestPermission() { return this.permission; }
  async queryPermission() { return this.permission; }
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

function makeRootWithOneRecipe() {
  const root = new MockDir();
  const recipesDir = new MockDir();
  recipesDir.name = 'Recipes';
  root.children.set('Recipes', recipesDir);
  const file = new MockFile('Carbonara.md');
  file.content = '---\ntitle: "Carbonara"\ncuisine: "Italian"\ncategory: "Dinner"\nrating: 4\ndifficulty: Medium\nservings: 4\n---\n# Carbonara\nClassic.\n';
  recipesDir.children.set('Carbonara.md', file);
  return { root, file };
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

function closeVaultDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Close Vault settings' }));
}

describe('One Vault after connection', () => {
  it('shows only personal recipes, no permanent Signature navigation, and a zero-write decline', async () => {
    const { root } = makeRootWithOneRecipe();
    await connect(root);

    const offer = screen.getByTestId('signature-import-offer');
    expect(offer).toBeTruthy();
    expect(within(offer).getByText('Would you like to add the Signature Nine?')).toBeTruthy();
    expect(offer.textContent).toContain("won't overwrite your existing recipes");
    expect(document.getElementById('vault-collection-label')?.getAttribute('aria-label')).toBe('My Recipe Vault');
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 recipe');
    expect(document.getElementById('sidenav-vault-status-line')?.textContent).toBe('Vault linked · 1 recipe');
    expect(document.querySelectorAll('[data-testid="builtin-card-badge"]').length).toBe(0);
    expect(document.getElementById('featured-recipe')?.textContent).toContain('Carbonara');
    expect(document.getElementById('nav-signature-collection')).toBeNull();
    expect(document.getElementById('nav-personal-recipes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    expect(root.children.has('Signature Collection')).toBe(false);
    closeVaultDialog();
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('1 recipe');
    expect(document.querySelector('[data-testid="builtin-card-badge"]')).toBeNull();
  }, 30000);

  it('imports the Signature Nine only after explicit Add and opens verified copies as personal recipes', async () => {
    const { root } = makeRootWithOneRecipe();
    await connect(root);

    fireEvent.click(screen.getByTestId('add-signature-nine'));
    await waitFor(() => {
      const offer = screen.getByTestId('signature-import-offer');
      expect(within(offer).getByText(/recipes added/i)).toBeTruthy();
    }, { timeout: 20000 });

    const signatureDir = root.children.get('Signature Collection') as MockDir | undefined;
    expect(signatureDir).toBeTruthy();
    expect(signatureDir!.children.size).toBe(9);
    expect(document.getElementById('vault-recipe-count')?.textContent).toBe('10 recipes');
    expect(document.querySelectorAll('[data-testid="builtin-card-badge"]').length).toBe(0);

    closeVaultDialog();
    await waitFor(() => expect(document.getElementById('vault-recipe-count')?.textContent).toBe('10 recipes'));

    const importedTitle = screen.getByRole('button', { name: 'Artisan Sourdough Boule' });
    expect(importedTitle).toBeTruthy();
    fireEvent.click(importedTitle);
    await waitFor(() => expect(document.getElementById('recipe-detail-view')).toBeTruthy());
    expect(screen.queryByTestId('builtin-recipe-badge')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByTestId('builtin-nutrition-readonly')).toBeNull();
    expect(document.getElementById('calculate-basic-nutrition-btn') || document.getElementById('calculate-basic-nutrition-empty-btn')).toBeTruthy();
  }, 45000);

  it('rechecks read/write permission at click time and refuses a revoked grant', async () => {
    const { root } = makeRootWithOneRecipe();
    await connect(root);

    const offer = screen.getByTestId('signature-import-offer');
    expect(within(offer).getByTestId('add-signature-nine')).toBeTruthy();

    root.permission = 'denied';
    fireEvent.click(within(offer).getByTestId('add-signature-nine'));

    await waitFor(() => {
      expect(screen.getByTestId('vault-notice').textContent).toMatch(/write access to this Vault is denied/i);
    });
    expect(root.children.has('Signature Collection')).toBe(false);
    await waitFor(() => {
      const refreshed = screen.getByTestId('signature-import-offer');
      expect(within(refreshed).queryByTestId('add-signature-nine')).toBeNull();
      expect(refreshed.textContent).toMatch(/write access to this Vault is denied/i);
    });
  }, 45000);

  it('recovers the Add 9 action after permission is granted again', async () => {
    const { root } = makeRootWithOneRecipe();
    await connect(root);

    root.permission = 'denied';
    const offer = screen.getByTestId('signature-import-offer');
    fireEvent.click(within(offer).getByTestId('add-signature-nine'));
    await waitFor(() => expect(screen.getByTestId('vault-notice').textContent).toMatch(/denied/i));

    root.permission = 'granted';
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(within(screen.getByTestId('signature-import-offer')).getByTestId('add-signature-nine')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('add-signature-nine'));
    await waitFor(() => {
      const refreshed = screen.getByTestId('signature-import-offer');
      expect(refreshed.textContent).toMatch(/recipes added/i);
    }, { timeout: 20000 });
    expect(root.children.has('Signature Collection')).toBe(true);
  }, 45000);

  it('queues overlapping favorite toggles and persists final intent', async () => {
    const { root, file } = makeRootWithOneRecipe();
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
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    closeVaultDialog();

    const personalCard = document.getElementById('featured-recipe');
    expect(personalCard).toBeTruthy();
    fireEvent.click(within(personalCard as HTMLElement).getByRole('button', { name: /Add to favorites/i }));
    await new Promise((r) => setTimeout(r, 500));

    fireEvent.click(screen.getByRole('button', { name: /Remove from favorites/i }));
    releaseFirst();
    await waitFor(() => expect(file.content).toContain('isFavorite: false'), { timeout: 10000 });

    await waitFor(() => {
      expect(document.getElementById('featured-recipe')).toBeTruthy();
    });
  }, 30000);
});
