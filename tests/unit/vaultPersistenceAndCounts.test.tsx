// @vitest-environment jsdom
/**
 * The Kitchen Codex — UD-2A.2 Vault persistence & recipe-count regression tests.
 *
 * Covers the two owner-reported defects and their contracts:
 *
 *   1. A remembered Vault is restored when the browser still permits it, and
 *      an explicit "Reconnect Vault" gesture is offered when it does not.
 *      The starter Vault is NEVER presented as the user's connected Vault.
 *   2. The recipe total is identical in every location that claims to show the
 *      total, and notes are reported as notes — never as recipes.
 *
 * No filesystem, handle, IndexedDB, window or provider work is performed by
 * the pure helpers; the platform boundary is injected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import {
  connectionStateForRestoreAction,
  describeVaultConnection,
  needsReconnectAction,
  reconnectRememberedVault,
  resolveVaultRestoreAction,
} from '../../src/core/vaultConnection';
import { VaultHeader } from '../../src/components/VaultHeader';
import { SideNav } from '../../src/components/SideNav';
import { getStarterVaultRecipes } from '../../src/data/starterVault';

afterEach(() => cleanup());

function headerProps(overrides: Record<string, any> = {}) {
  return {
    vaultStatus: { isConnected: false, vaultPath: '/vault', accessType: 'starter_vault' } as any,
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
    recipeCount: 9,
    noteCount: 0,
    onReconnectVault: () => {},
    ...overrides,
  } as any;
}

function sideNavProps(overrides: Record<string, any> = {}) {
  return {
    activeTab: 'grid' as const,
    setActiveTab: () => {},
    vaultStatus: { isConnected: false, vaultPath: '/vault', accessType: 'starter_vault' } as any,
    recipeCount: 9,
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
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// 1-6. The restore decision and the reconnect flow
// ---------------------------------------------------------------------------

describe('Vault restore decision', () => {
  it('reconnects automatically when the browser still grants permission', () => {
    expect(resolveVaultRestoreAction(true, 'granted')).toEqual({ kind: 'reconnect' });
    expect(connectionStateForRestoreAction({ kind: 'reconnect' })).toBe('connected');
  });

  it('requires a user gesture when the Vault is remembered but permission is "prompt"', () => {
    expect(resolveVaultRestoreAction(true, 'prompt')).toEqual({ kind: 'request-authorization' });
    expect(connectionStateForRestoreAction({ kind: 'request-authorization' })).toBe('reauthorization_required');
  });

  it('reports denial distinctly when the browser refuses access', () => {
    expect(resolveVaultRestoreAction(true, 'denied')).toEqual({ kind: 'authorization-denied' });
    expect(connectionStateForRestoreAction({ kind: 'authorization-denied' })).toBe('permission_denied');
  });

  it('does nothing when no Vault is remembered', () => {
    expect(resolveVaultRestoreAction(false, 'granted')).toEqual({ kind: 'none' });
    expect(resolveVaultRestoreAction(false, 'prompt')).toEqual({ kind: 'none' });
    expect(connectionStateForRestoreAction({ kind: 'none' })).toBe('starter');
  });

  it('treats a stored handle that cannot report permission as unusable', () => {
    expect(resolveVaultRestoreAction(true, null)).toEqual({ kind: 'none' });
    expect(resolveVaultRestoreAction(true, undefined)).toEqual({ kind: 'none' });
  });

  it('offers the reconnect action only for a remembered Vault', () => {
    expect(needsReconnectAction('reauthorization_required')).toBe(true);
    expect(needsReconnectAction('permission_denied')).toBe(true);
    expect(needsReconnectAction('starter')).toBe(false);
    expect(needsReconnectAction('connected')).toBe(false);
  });
});

describe('Reconnect flow (user gesture)', () => {
  it('requests permission and loads the Vault when the user grants it', async () => {
    const calls: string[] = [];
    const outcome = await reconnectRememberedVault<{ ok: true }>({
      getHandle: async () => ({ requestPermission: async () => 'granted' }),
      requestPermission: async () => { calls.push('request'); return 'granted'; },
      load: async () => { calls.push('load'); return { ok: true }; },
    });
    expect(outcome.status).toBe('reconnected');
    expect(calls).toEqual(['request', 'load']);
  });

  it('does NOT load the Vault when the user declines', async () => {
    let loaded = false;
    const outcome = await reconnectRememberedVault({
      getHandle: async () => ({ requestPermission: async () => 'denied' }),
      requestPermission: async () => 'denied',
      load: async () => { loaded = true; return {}; },
    });
    expect(outcome.status).toBe('denied');
    expect(loaded).toBe(false);
  });

  it('reports a missing remembered handle without attempting a request', async () => {
    let requested = false;
    const outcome = await reconnectRememberedVault({
      getHandle: async () => null,
      requestPermission: async () => { requested = true; return 'granted'; },
      load: async () => ({}),
    });
    expect(outcome.status).toBe('no-handle');
    expect(requested).toBe(false);
  });

  it('reports an unusable handle (no requestPermission) without attempting a request', async () => {
    let requested = false;
    const outcome = await reconnectRememberedVault({
      getHandle: async () => ({}),
      requestPermission: async () => { requested = true; return 'granted'; },
      load: async () => ({}),
    });
    expect(outcome.status).toBe('unsupported');
    expect(requested).toBe(false);
  });

  it('never fabricates a granted permission when the browser throws', async () => {
    const outcome = await reconnectRememberedVault({
      getHandle: async () => ({ requestPermission: async () => { throw new Error('not allowed'); } }),
      requestPermission: async () => { throw new Error('not allowed'); },
      load: async () => ({}),
    });
    expect(outcome.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 6. The starter Vault is never presented as the user's Vault
// ---------------------------------------------------------------------------

describe('The starter Vault is never presented as the connected Vault', () => {
  it('offers an explicit "Reconnect Vault" action for a remembered Vault', () => {
    render(
      <VaultHeader
        {...headerProps({
          vaultStatus: {
            isConnected: false,
            vaultPath: 'Vault / My Recipe Vault',
            accessType: 'starter_vault',
            connectionState: 'reauthorization_required',
            rememberedVaultName: 'My Recipe Vault',
          },
        })}
      />
    );
    const strip = screen.getByText('Reconnect Vault').closest('#vault-status-strip')!;
    expect(strip).toBeTruthy();
    expect(strip.querySelector('#connect-vault-chip')).toBeNull();
    expect(strip.querySelector('#vault-linked-chip')).toBeNull();
    expect(strip.querySelector('#reconnect-vault-btn')).toBeTruthy();
  });

  it('runs the reconnect gesture from the "Reconnect Vault" button', () => {
    let called = 0;
    render(
      <VaultHeader
        {...headerProps({
          vaultStatus: {
            isConnected: false,
            vaultPath: 'Vault / My Recipe Vault',
            accessType: 'starter_vault',
            connectionState: 'reauthorization_required',
            rememberedVaultName: 'My Recipe Vault',
          },
          onReconnectVault: () => { called += 1; },
        })}
      />
    );
    fireEvent.click(screen.getByText('Reconnect Vault'));
    expect(called).toBe(1);
  });

  it('surfaces the reconnect action in the sidebar status line', () => {
    render(
      <SideNav
        {...sideNavProps({
          vaultStatus: {
            isConnected: false,
            vaultPath: 'Vault / My Recipe Vault',
            accessType: 'starter_vault',
            connectionState: 'reauthorization_required',
            rememberedVaultName: 'My Recipe Vault',
          },
        })}
      />
    );
    expect(screen.getByText('Reconnect your Vault')).toBeTruthy();
  });

  it('labels the starter Vault as sample data', () => {
    render(<SideNav {...sideNavProps()} />);
    expect(document.getElementById('sidenav-vault-status-line')!.textContent).toBe('Starter vault · 9 sample recipes');
  });

  it('describes the remembered Vault honestly in the status text', () => {
    const described = describeVaultConnection({
      state: 'reauthorization_required',
      recipeCount: 9,
      noteCount: 0,
      rememberedVaultName: 'My Recipe Vault',
    });
    expect(described.tone).toBe('attention');
    expect(described.detail).toMatch(/remembered/i);
    expect(described.label).toMatch(/My Recipe Vault/);
  });
});

// ---------------------------------------------------------------------------
// 7-9. Counting contract
// ---------------------------------------------------------------------------

describe('Recipe and note counts', () => {
  it('shows the recipe count in the header status strip', () => {
    render(<VaultHeader {...headerProps({ recipeCount: 9 })} />);
    expect(document.getElementById('vault-recipe-count')!.textContent).toBe('9 recipes');
  });

  it('uses the singular form for a single recipe', () => {
    render(<VaultHeader {...headerProps({ recipeCount: 1 })} />);
    expect(document.getElementById('vault-recipe-count')!.textContent).toBe('1 recipe');
  });

  it('follows the canonical collection when it changes (no stored count to drift)', () => {
    const { rerender } = render(<VaultHeader {...headerProps({ recipeCount: 9 })} />);
    expect(document.getElementById('vault-recipe-count')!.textContent).toBe('9 recipes');
    rerender(<VaultHeader {...headerProps({ recipeCount: 12 })} />);
    expect(document.getElementById('vault-recipe-count')!.textContent).toBe('12 recipes');
  });

  it('reports notes as notes in the sidebar, separately from the recipe total', () => {
    render(
      <SideNav
        {...sideNavProps({
          recipeCount: 9,
          noteCount: 6,
          vaultStatus: { isConnected: true, vaultPath: 'Vault / X', accessType: 'filesystem_api', connectionState: 'connected' },
        })}
      />
    );
    const line = document.getElementById('sidenav-vault-status-line')!;
    expect(line.textContent).toBe('Vault linked · 9 recipes · 6 notes');
  });

  it('omits the note count when there are none', () => {
    render(
      <SideNav
        {...sideNavProps({
          recipeCount: 9,
          noteCount: 0,
          vaultStatus: { isConnected: true, vaultPath: 'Vault / X', accessType: 'filesystem_api', connectionState: 'connected' },
        })}
      />
    );
    const line = document.getElementById('sidenav-vault-status-line')!;
    expect(line.textContent).toBe('Vault linked · 9 recipes');
  });

  it('never labels the note count as recipes', () => {
    const described = describeVaultConnection({ state: 'connected', recipeCount: 9, noteCount: 6 });
    expect(described.label).toBe('Vault linked · 9 recipes · 6 notes');
    expect(described.label).not.toMatch(/6 recipes/);
  });
});

// ---------------------------------------------------------------------------
// 10-11. Existing connection modes are unchanged
// ---------------------------------------------------------------------------

describe('Existing Vault connection modes are preserved', () => {
  it('still shows "Vault Linked" for a connected Vault', () => {
    render(
      <VaultHeader
        {...headerProps({
          vaultStatus: { isConnected: true, vaultPath: 'Vault / X', accessType: 'filesystem_api', connectionState: 'connected' },
        })}
      />
    );
    expect(screen.getByText('Vault Linked')).toBeTruthy();
    expect(screen.queryByText('Reconnect Vault')).toBeNull();
  });

  it('still shows "Connect Vault" for the starter Vault', () => {
    render(<VaultHeader {...headerProps()} />);
    const strip = document.getElementById('vault-status-strip')!;
    expect(strip.querySelector('#connect-vault-chip')).toBeTruthy();
    expect(strip.querySelector('#reconnect-vault-btn')).toBeNull();
  });

  it('still shows the connected vault status in the sidebar', () => {
    render(
      <SideNav
        {...sideNavProps({
          vaultStatus: { isConnected: true, vaultPath: 'Vault / X', accessType: 'filesystem_api', connectionState: 'connected' },
        })}
      />
    );
    expect(document.getElementById('sidenav-vault-status-line')!.textContent).toBe('Vault linked · 9 recipes');
  });

  it('derives the starter recipe total from the starter data, not a literal', () => {
    const starters = getStarterVaultRecipes();
    expect(starters.length).toBeGreaterThan(0);
    const described = describeVaultConnection({ state: 'starter', recipeCount: starters.length, noteCount: 0 });
    expect(described.label).toContain(String(starters.length));
  });
});
