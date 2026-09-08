/**
 * The Kitchen Codex — Obsidian plugin foundation (Phase 4D3B).
 *
 * Minimal Obsidian desktop plugin proving "one core, multiple shells":
 *   - ObsidianVaultAdapter over `app.vault`
 *   - ObsidianSettingsAdapter over plugin `loadData`/`saveData`
 *   - ObsidianNetworkAdapter over a configured backend origin
 *   - composition via `createAppServices`
 *   - a minimal React `RecipeWorkspace` mounted in an `ItemView`
 *
 * Backend URL is a NON-secret plugin setting (never a provider API key). BYOK /
 * Gemini/OpenRouter/DeepSeek key UI is intentionally deferred (v0.7). No browser
 * FSA, no vaultAssets, no AssetAdapter, no binary download.
 */

import { Plugin, ItemView, WorkspaceLeaf } from 'obsidian';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ObsidianVaultAdapter, ObsidianSettingsAdapter, ObsidianNetworkAdapter, ObsidianSecretAdapter } from '../src/platform/obsidian';
import { createAppServices } from '../src/application/createAppServices';
import type { AppServices } from '../src/application/createAppServices';
import { RecipeWorkspace } from '../src/application-ui/RecipeWorkspace';

const VIEW_TYPE = 'kitchen-codex-view';

interface KitchenCodexSettings {
  /** Backend origin for Kitchen Codex server calls (e.g. http://127.0.0.1:3000). NOT a secret key. */
  backendUrl: string;
}

const DEFAULT_SETTINGS: KitchenCodexSettings = { backendUrl: '' };

class KitchenCodexView extends ItemView {
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: KitchenCodexPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Kitchen Codex';
  }

  getIcon(): string {
    return 'chef-hat';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('kitchen-codex-view');

    const services: AppServices = createAppServices({
      vault: new ObsidianVaultAdapter(this.app.vault),
      settings: new ObsidianSettingsAdapter(this.plugin),
      network: this.plugin.networkAdapter,
      secret: new ObsidianSecretAdapter(),
    });

    this.root = createRoot(container);
    this.root.render(React.createElement(RecipeWorkspace, { services }));
  }

  async onClose(): Promise<void> {
    // React 19 createRoot has no sync unmount in older typings; call unmount().
    this.root?.unmount();
    this.root = null;
  }
}

export default class KitchenCodexPlugin extends Plugin {
  settings: KitchenCodexSettings = { ...DEFAULT_SETTINGS };
  networkAdapter = new ObsidianNetworkAdapter();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new KitchenCodexView(leaf, this));
    this.addRibbonIcon('chef-hat', 'Open Kitchen Codex', () => this.activateView());
    this.addCommand({
      id: 'open-kitchen-codex',
      name: 'Open Kitchen Codex',
      callback: () => this.activateView(),
    });
  }

  async onunload(): Promise<void> {
    // The ItemView's onClose unmounts React; nothing else to release.
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<KitchenCodexSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
    this.networkAdapter = new ObsidianNetworkAdapter({ baseUrl: this.settings.backendUrl || undefined });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }
}
