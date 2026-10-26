// @vitest-environment jsdom
/**
 * UD-2D.4 — Settings, Themes, Vault Connections & Shell presentation.
 *
 * Presentation-only regressions for the final design slice. These pin the
 * accessible theme state, the Vault dialog's real four panels, the preserved
 * file inputs and the mobile shell's active destination. No vault, filesystem,
 * provider or persistence behavior is exercised or mocked here.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { ThemesView } from '../../src/components/ThemesView';
import { ConnectVaultModal } from '../../src/components/ConnectVaultModal';
import { BottomNav } from '../../src/components/BottomNav';
import { VaultHeader } from '../../src/components/VaultHeader';
import { SideNav } from '../../src/components/SideNav';
import type { ObsidianRecipe, VaultSyncStatus } from '../../src/types';

afterEach(() => cleanup());

function vaultStatus(overrides: Partial<VaultSyncStatus> = {}): VaultSyncStatus {
  return {
    isConnected: false,
    vaultPath: 'My Recipe Vault / Kitchen Codex',
    accessType: 'starter_vault',
    connectionState: 'starter',
    ...overrides,
  } as VaultSyncStatus;
}

function recipe(id: string): ObsidianRecipe {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `Recipes/${id}.md`,
    rawMarkdown: '',
    title: id,
    tags: [],
    ingredients: [],
    instructions: [],
    callouts: [],
    wikilinks: [],
  } as unknown as ObsidianRecipe;
}

function renderVaultModal(status: VaultSyncStatus = vaultStatus()) {
  const setVaultStatus = vi.fn();
  const setRecipes = vi.fn();
  render(
    <ConnectVaultModal
      isOpen
      onClose={vi.fn()}
      vaultStatus={status}
      setVaultStatus={setVaultStatus}
      recipes={[recipe('Roast Chicken'), recipe('Lentil Soup')]}
      setRecipes={setRecipes}
      setMealPlan={vi.fn()}
      setShoppingCategories={vi.fn()}
      setNotes={vi.fn()}
      onDirectVaultConnected={vi.fn()}
    />
  );
  return { setVaultStatus, setRecipes };
}

describe('UD-2D.4 — Themes presentation', () => {
  it('renders all four themes with truthful current-theme state and apply controls', () => {
    const onSelectTheme = vi.fn();
    render(<ThemesView currentTheme="obsidian" onSelectTheme={onSelectTheme} />);

    for (const id of ['obsidian', 'parchment', 'nordic', 'blood-moon']) {
      expect(document.getElementById(`theme-card-${id}`)).toBeTruthy();
      expect(document.getElementById(`apply-theme-${id}-btn`)).toBeTruthy();
    }
    expect((document.getElementById('apply-theme-obsidian-btn') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect((document.getElementById('apply-theme-parchment-btn') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.getByText('The Blood Moon')).toBeTruthy();
    expect(screen.getByText("Developer's Edition")).toBeTruthy();

    fireEvent.click(screen.getByText('The Blood Moon'));
    expect(onSelectTheme).toHaveBeenCalledWith('blood-moon');
  });

  it('marks the active card with theme accent roles and keeps the brand mark', () => {
    const { container } = render(<ThemesView currentTheme="blood-moon" onSelectTheme={() => {}} />);
    const card = document.getElementById('theme-card-blood-moon')!;
    expect(card.className).toContain('var(--accent)');
    expect(card.className).toContain('var(--accent-subtle)');
    expect(card.className).toMatch(/ring-1/);
    expect(container.querySelectorAll('.kc-brand-mark__body').length).toBeGreaterThan(0);
  });
});

describe('UD-2D.4 — Vault connection presentation', () => {
  it('opens as an accessible modal with all four real Vault panels', () => {
    renderVaultModal();
    const dialog = screen.getByRole('dialog', { name: /Connect or manage your recipes/i });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Import Folder \/ Files/i }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Live Directory Sync/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Paste Markdown/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Vault Stats/i })).toBeTruthy();
    expect(document.getElementById('vault-panel-upload')).toBeTruthy();
    expect(document.querySelector('input[webkitdirectory]')).toBeTruthy();
    expect(document.querySelector('input[type="file"][accept]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();

    const uploadTab = screen.getByRole('tab', { name: /Import Folder \/ Files/i });
    uploadTab.focus();
    fireEvent.keyDown(uploadTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Live Directory Sync/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches panels without losing the connection truth or the manage actions', () => {
    renderVaultModal(vaultStatus({ connectionState: 'reauthorization_required', rememberedVaultName: 'My Recipe Vault' }));

    fireEvent.click(screen.getByRole('tab', { name: /Live Directory Sync/i }));
    expect(document.getElementById('vault-panel-direct')).toBeTruthy();
    expect(within(document.getElementById('vault-panel-direct')!).getByText(/needs permission to reopen/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Vault Stats/i }));
    expect(document.getElementById('vault-panel-manage')).toBeTruthy();
    expect(screen.getByText('Recipes currently loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Use starter library/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Export Markdown/i })).toBeTruthy();
  });

  it('does not present the starter library as the user’s connected Vault', () => {
    renderVaultModal();
    expect(screen.getAllByText('Starter library').length).toBeGreaterThan(0);
    expect(screen.queryByText('Local Vault connected')).toBeNull();
  });
});

describe('UD-2D.4 — mobile shell', () => {
  it('exposes the current destination and keeps all four bottom destinations', () => {
    render(<BottomNav activeTab="providers" onVault={vi.fn()} onStudio={vi.fn()} onShiso={vi.fn()} onMore={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: 'Mobile primary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Vault/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /AI Studio/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /SHISO/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /More/i }).getAttribute('aria-haspopup')).toBe('dialog');
  });
});
describe('UD-2D.4 — Vault status truthfulness', () => {
  const headerProps = {
    activeTab: 'grid' as const,
    setActiveTab: () => {},
    searchQuery: '',
    setSearchQuery: () => {},
    isFilterOpen: false,
    setIsFilterOpen: () => {},
    activeFilterCount: 0,
    onOpenConnectVaultModal: () => {},
    onOpenNewRecipeModal: () => {},
    onOpenRecipeGrabber: () => {},
    onOpenVaultIntelligence: () => {},
    onOpenAskMyKitchen: () => {},
    onOpenCreateForMe: () => {},
    onRefreshVault: () => {},
    recipeCount: 2,
    noteCount: 0,
    onReconnectVault: () => {},
  };

  it('distinguishes imported recipes from a live two-way Vault in the header', () => {
    const { unmount } = render(
      <VaultHeader {...headerProps} vaultStatus={vaultStatus({ isConnected: true, accessType: 'uploaded_folder' })} />
    );
    expect(screen.getByText('Recipes Loaded')).toBeTruthy();
    expect(screen.queryByText('Vault Linked')).toBeNull();
    unmount();

    render(
      <VaultHeader {...headerProps} vaultStatus={vaultStatus({ isConnected: true, accessType: 'filesystem_api' })} />
    );
    expect(screen.getByText('Vault Linked')).toBeTruthy();
  });

  it('keeps a remembered Vault explicitly reconnectable rather than calling it a starter Vault', () => {
    render(
      <VaultHeader
        {...headerProps}
        vaultStatus={vaultStatus({
          isConnected: false,
          accessType: 'starter_vault',
          connectionState: 'reauthorization_required',
          rememberedVaultName: 'My Recipe Vault',
        })}
      />
    );
    expect(screen.getByText('Reconnect Vault')).toBeTruthy();
    expect(screen.queryByText('Starter vault · 2 sample recipes')).toBeNull();
  });

  it('keeps the sidebar count separated from imported-vs-live status', () => {
    const sideProps = {
      activeTab: 'grid' as const,
      setActiveTab: () => {},
      noteCount: 0,
      onReconnectVault: () => {},
      onOpenConnectVaultModal: () => {},
      onOpenNewRecipeModal: () => {},
      onOpenAskMyKitchen: () => {},
      onOpenCreateForMe: () => {},
      onOpenRecipeGrabber: () => {},
      onOpenVaultIntelligence: () => {},
      onShisoOpen: () => {},
      onFavorites: () => {},
      recipeCount: 2,
    };
    const { unmount } = render(
      <SideNav {...sideProps} vaultStatus={vaultStatus({ isConnected: true, accessType: 'uploaded_folder' })} />
    );
    expect(document.getElementById('sidenav-vault-status-line')!.textContent).toBe('Recipes loaded · 2 recipes');
    unmount();
    render(
      <SideNav {...sideProps} vaultStatus={vaultStatus({ isConnected: true, accessType: 'filesystem_api' })} />
    );
    expect(document.getElementById('sidenav-vault-status-line')!.textContent).toBe('Vault linked · 2 recipes');
  });
});
