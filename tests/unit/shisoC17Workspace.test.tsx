// @vitest-environment jsdom
/**
 * SHISO-C1.7 S1/S2 — sidebar placement and the full-page workspace.
 * Both presentations render the SAME engine; no provider or Vault is touched.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SideNav } from '../../src/components/SideNav';
import { ShisoModal } from '../../src/components/ShisoModal';
import { ShisoWorkspace } from '../../src/components/ShisoWorkspace';
import { ShisoEntryProvider } from '../../src/application-ui/shisoEntryPoints';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { VaultSyncStatus } from '../../src/types';
import { hydrateAiSelections } from '../../src/application/aiSelection';

beforeAll(async () => {
  await hydrateAiSelections({ get: async () => null } as never);
});
afterEach(() => cleanup());

const vaultStatus: VaultSyncStatus = {
  isConnected: false,
  vaultPath: '',
  accessType: 'starter_vault',
};

function nav(onOpenShisoWorkspace: () => void) {
  return (
    <SideNav
      activeTab="grid"
      setActiveTab={() => {}}
      vaultStatus={vaultStatus}
      recipeCount={9}
      noteCount={0}
      onReconnectVault={() => {}}
      onOpenConnectVaultModal={() => {}}
      onOpenNewRecipeModal={() => {}}
      onOpenAskMyKitchen={() => {}}
      onOpenCreateForMe={() => {}}
      onOpenRecipeGrabber={() => {}}
      onOpenVaultIntelligence={() => {}}
      onShisoOpen={() => {}}
      onOpenShisoWorkspace={onOpenShisoWorkspace}
      onFavorites={() => {}}
    />
  );
}

function replyNetwork(): NetworkAdapter {
  return {
    post: async () => ({
      status: 200,
      ok: true,
      data: { ok: true, kind: 'reply', text: 'Workspace baseline reply.', proposals: [], model_invocations_used: 1, tool_calls_used: 0 },
    }),
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
}

describe('S1 — sidebar placement', () => {
  it('groups Chat with SHISO with the existing AI and companion tools', () => {
    const { container } = render(nav(() => {}));
    const navEl = container.querySelector('nav[aria-label="Primary"]')!;
    const buttons = [...navEl.querySelectorAll('button')];
    const ids = buttons.map((b) => b.id || (b.textContent || '').trim());
    const aiStudio = ids.indexOf('nav-ai-studio');
    const shiso = ids.indexOf('nav-chat-with-shiso');
    expect(aiStudio).toBeGreaterThanOrEqual(0);
    expect(shiso).toBe(aiStudio + 1);
    expect(navEl.textContent).toContain('AI & Companion');
    expect(navEl.querySelectorAll('#nav-chat-with-shiso')).toHaveLength(1);
    for (const id of [
      'nav-recipe-vault',
      'nav-favorites',
      'nav-dataview-table',
      'nav-meal-planner',
      'nav-shopping-list',
      'nav-ai-studio',
      'nav-chat-with-shiso',
      'nav-themes',
    ]) {
      expect(navEl.querySelector(`#${id}`), `missing ${id}`).toBeTruthy();
    }
    expect(buttons[shiso].textContent).toContain('Chat with SHISO');
  });

  it('opens the workspace from the new sidebar hook', () => {
    const onOpen = vi.fn();
    render(nav(onOpen));
    fireEvent.click(screen.getByLabelText('Chat with SHISO'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('S2 — workspace and compact modal share one engine', () => {
  function Host({ fullPage, withHistory = false }: { fullPage: boolean; withHistory?: boolean }) {
    const shared = {
      network: replyNetwork(),
      recipe: null,
      nutritionSession: null,
      nutritionRows: [],
      nutritionReviewRows: [],
      nutritionSummary: null,
      nutritionUnsaved: false,
    } as const;
    const history = {
      conversations: [],
      activeKey: null,
      searchQuery: '',
      searchResults: [],
      onSearchChange: () => {},
      onNew: () => {},
      onResume: () => {},
      onRename: () => {},
      onDelete: () => {},
    } as const;
    return (
      <ShisoEntryProvider>
        {fullPage
          ? <ShisoWorkspace isOpen onClose={() => {}} conversationHistory={withHistory ? history : undefined} {...shared} />
          : <ShisoModal isOpen onClose={() => {}} onExpandToWorkspace={() => {}} {...shared} />}
      </ShisoEntryProvider>
    );
  }

  it('renders premium workspace chrome and a working composer', async () => {
    const { container } = render(<Host fullPage />);
    expect(container.querySelector('.kc-shiso-workspace')).toBeTruthy();
    expect(container.querySelector('.kc-shiso-workspace-shell')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Chat with SHISO' })).toBeTruthy();
    expect(screen.getByLabelText('Close SHISO workspace')).toBeTruthy();
    expect(screen.getByPlaceholderText('Ask Shiso…').getAttribute('rows')).toBe('1');
    fireEvent.change(screen.getByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(document.body.textContent).toContain('Workspace baseline reply.'));
  });

  it('anchors the product hero and Vault return action above the conversation rail', () => {
    const { container } = render(<Host fullPage withHistory />);
    const rail = container.querySelector('.kc-shiso-rail-shell');
    expect(rail?.querySelector('.kc-shiso-global-head')).toBeTruthy();
    expect(rail?.querySelector('[data-testid="shiso-back-to-vault"]')).toBeNull();
    expect(rail?.querySelector('[data-testid="shiso-history-rail"]')).toBeTruthy();
    expect(container.querySelector('.kc-shiso-workspace-main')).toBeTruthy();
    expect(container.querySelector('.kc-shiso-workspace-actions [data-testid="shiso-back-to-vault"]')).toBeTruthy();
  });

  it('preserves the compact overlay and its expand control', () => {
    const { container } = render(<Host fullPage={false} />);
    expect(container.querySelector('.kc-shiso-workspace')).toBeNull();
    expect(screen.getByLabelText('Open full SHISO workspace')).toBeTruthy();
    expect(screen.getByLabelText('Close Shiso')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Chat with Shiso' })).toBeTruthy();
  });

  it('provides a real return-to-vault action for the workspace chrome', () => {
    const onBack = vi.fn();
    render(
      <ShisoEntryProvider>
        <ShisoWorkspace isOpen onClose={() => {}} onBackToVault={onBack} network={replyNetwork()} recipe={null} nutritionSession={null} nutritionRows={[]} nutritionReviewRows={[]} nutritionSummary={null} nutritionUnsaved={false} />
      </ShisoEntryProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to My Recipe Vault' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    const backButton = screen.getByRole('button', { name: 'Back to My Recipe Vault' });
    fireEvent.keyDown(backButton, { key: 'Enter' });
    fireEvent.keyDown(backButton, { key: ' ' });
    expect(onBack).toHaveBeenCalledTimes(3);
    expect(document.querySelector('.kc-shiso-window-controls')).toBeNull();
    expect(document.querySelector('.kc-shiso-global-nav')).toBeNull();
    expect(document.querySelector('[aria-label="Account"]')).toBeNull();
  });

  it('uses one engine: the workspace is a thin presentation of ShisoModal', () => {
    const root = join(__dirname, '../..');
    const workspace = readFileSync(join(root, 'src/components/ShisoWorkspace.tsx'), 'utf8');
    expect(workspace).toContain('ShisoModal');
    expect(workspace).toContain('presentation="fullpage"');
    expect(workspace).not.toMatch(/useState|runShisoConversationTurn|saveWorkingRecipe/);
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    expect(app).toContain('isOpen={shiso.isOpen && !isShisoWorkspaceOpen}');
    expect(app).toContain('isOpen={isShisoWorkspaceOpen}');
    expect(app).toContain('onBackToVault={returnToRecipeVault}');
  });
});
