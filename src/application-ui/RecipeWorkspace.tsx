/**
 * The Kitchen Codex — Minimal Reusable Application UI Root (Phase 4D3B).
 *
 * A deliberately SMALL React surface that proves "one core, multiple shells":
 * given composed application services, it loads the vault through the VaultAdapter
 * pipeline, lists recipes, opens a detail view, and saves an edited note back
 * through the canonical parse -> serializer -> adapter write path.
 *
 * It is platform-agnostic: it receives adapter instances via props and never
 * imports browser FSA, vaultAssets, useVaultImage, or folderHandle. In the
 * browser this would be replaced/wrapped by a richer root (4D3C); here it only
 * proves the architecture on Obsidian.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { ObsidianRecipe } from '../types';
import type { AppServices } from '../application/createAppServices';
import { loadVaultContent } from '../application/vaultContent';
import { saveRecipeWithVaultAdapter } from '../application/vaultRecipe';
import { parseObsidianRecipeMarkdown } from '../utils/markdownParser';

interface RecipeWorkspaceProps {
  services: AppServices;
}

type ViewState = 'loading' | 'list' | 'detail' | 'error';

const LIST_STYLE: React.CSSProperties = { fontFamily: 'sans-serif', padding: '16px', color: 'var(--text-normal)' };
const BTN: React.CSSProperties = {
  padding: '4px 10px', margin: '4px', cursor: 'pointer', borderRadius: '4px',
  border: '1px solid var(--background-modifier-border)', background: 'var(--background-secondary)',
};
const TEXTAREA: React.CSSProperties = { width: '100%', minHeight: '320px', boxSizing: 'border-box', fontFamily: 'monospace' };
const FIELD: React.CSSProperties = { color: 'var(--text-muted)', fontSize: '12px' };

export function RecipeWorkspace({ services }: RecipeWorkspaceProps) {
  const vault = services.adapters.vault;
  const settings = services.adapters.settings;

  const [view, setView] = useState<ViewState>('loading');
  const [recipes, setRecipes] = useState<ObsidianRecipe[]>([]);
  const [selected, setSelected] = useState<ObsidianRecipe | null>(null);
  const [editedMarkdown, setEditedMarkdown] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setView('loading');
      const scan = await loadVaultContent(vault);
      setRecipes(scan.recipes);
      setSelected(null);
      setView('list');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vault.');
      setView('error');
    }
  }, [vault]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Settings proof: read a persisted tab value on mount, write it on selection.
  const [, setPersistedTab] = useState<'list' | 'detail'>('list');
  useEffect(() => {
    if (!settings) return;
    settings.get<'list' | 'detail'>('obsidian_active_tab').then((v) => setPersistedTab(v ?? 'list')).catch(() => {});
  }, [settings]);

  const openRecipe = useCallback((recipe: ObsidianRecipe) => {
    setSelected(recipe);
    setEditedMarkdown(recipe.rawMarkdown);
    setView('detail');
    if (settings) {
      settings.set('obsidian_active_tab', 'detail').catch(() => {});
    }
  }, [settings]);

  const backToList = useCallback(() => {
    setSelected(null);
    setView('list');
    if (settings) {
      settings.set('obsidian_active_tab', 'list').catch(() => {});
    }
  }, [settings]);

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      // Canonical round-trip: the editor edits raw Markdown; we re-parse it (the
      // SAME parser/serializer the browser app uses) and write via the adapter.
      const reparsed = parseObsidianRecipeMarkdown(editedMarkdown, selected.fileName, selected.filePath);
      const updated: ObsidianRecipe = { ...reparsed, id: selected.id, fileName: selected.fileName, filePath: selected.filePath };
      await saveRecipeWithVaultAdapter(vault, updated);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save recipe.');
    } finally {
      setSaving(false);
    }
  }, [selected, editedMarkdown, vault, reload]);

  if (view === 'loading') return <div style={LIST_STYLE}>Loading recipes…</div>;
  if (view === 'error') {
    return (
      <div style={LIST_STYLE}>
        <p style={{ color: 'var(--text-error)' }}>{error ?? 'Error'}</p>
        <button style={BTN} onClick={() => void reload()}>Retry</button>
      </div>
    );
  }

  // Detail + edit (raw Markdown), which exercises the parse/serialize path.
  if (view === 'detail' && selected) {
    return (
      <div style={LIST_STYLE}>
        <h2>{selected.title}</h2>
        <div style={FIELD}>{selected.filePath}</div>
        {selected.ingredients.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <strong>Ingredients</strong>
            <ul>{selected.ingredients.map((ing, i) => <li key={i}>{ing.original}</li>)}</ul>
          </div>
        )}
        <textarea
          id="recipe-markdown-editor"
          style={TEXTAREA}
          value={editedMarkdown}
          onChange={(e) => setEditedMarkdown(e.target.value)}
        />
        <div style={{ marginTop: '8px' }}>
          <button id="recipe-save" style={BTN} disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save to vault'}
          </button>
          <button style={BTN} disabled={saving} onClick={backToList}>Back</button>
        </div>
        {error && <p style={{ color: 'var(--text-error)' }}>{error}</p>}
      </div>
    );
  }

  // List.
  return (
    <div style={LIST_STYLE}>
      <h2>My Recipes ({recipes.length})</h2>
      <div>{recipes.map((recipe) => (
        <div key={recipe.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--background-modifier-border)' }}>
          <button style={{ ...BTN, textAlign: 'left' }} onClick={() => openRecipe(recipe)}>
            {recipe.title}
          </button>
        </div>
      ))}</div>
    </div>
  );
}

export default RecipeWorkspace;
