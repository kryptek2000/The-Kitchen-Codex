/**
 * SHISO-C1.7 S3/S4 — conversation history rail.
 *
 * Presentation only. It holds no engine, no provider, and no Vault authority:
 * every action is delegated to the App shell, which owns the metadata index and
 * the single shared conversation engine. Rename/delete are explicit user
 * actions; delete always requires an inline confirmation before dispatch.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, Search, Pencil, Trash2, Check, X, MessageCircle, ChevronDown, MoreHorizontal, Utensils } from 'lucide-react';

import type {
  ShisoConversationMeta,
  ShisoConversationSearchResult,
} from '../application/shisoConversationIndex';

export interface ShisoHistoryRailProps {
  readonly conversations: readonly ShisoConversationMeta[];
  readonly activeKey: string | null;
  readonly searchQuery: string;
  readonly searchResults: readonly ShisoConversationSearchResult[];
  readonly onSearchChange: (query: string) => void;
  readonly onNew: () => void;
  readonly onResume: (key: string) => void;
  readonly onRename: (key: string, title: string) => void;
  readonly onDelete: (key: string) => void;
  /** Disable mutations while a turn is in flight. */
  readonly busy?: boolean;
}

const SOURCE_LABEL: Record<ShisoConversationMeta['source'], string> = {
  global: 'General',
  create: 'Creation',
  recipe: 'Recipe',
  named: 'Saved',
};

function relativeTime(value: string): string {
  if (!value) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(time).toLocaleDateString();
}

export function ShisoHistoryRail({
  conversations,
  activeKey,
  searchQuery,
  searchResults,
  onSearchChange,
  onNew,
  onResume,
  onRename,
  onDelete,
  busy = false,
}: ShisoHistoryRailProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  // On a phone the chat is the primary focus: the history rail starts folded
  // into a single header bar and the owner chooses when to open it.
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 768,
  );
  const mobileViewportRef = useRef(
    typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 768,
  );
  const renameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingKey !== null) renameRef.current?.focus();
  }, [editingKey]);

  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth > 0 && window.innerWidth < 768;
      if (mobile === mobileViewportRef.current) return;
      mobileViewportRef.current = mobile;
      setCollapsed(mobile);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const beginRename = (meta: ShisoConversationMeta) => {
    if (busy) return;
    setConfirmingKey(null);
    setEditingKey(meta.key);
    setEditingTitle(meta.title);
  };

  const commitRename = () => {
    if (editingKey === null) return;
    const title = editingTitle.trim();
    if (title.length > 0) onRename(editingKey, title);
    setEditingKey(null);
  };

  const cancelRename = () => {
    setEditingKey(null);
    setEditingTitle('');
  };

  const beginDelete = (key: string) => {
    if (busy) return;
    setEditingKey(null);
    setConfirmingKey((current) => (current === key ? null : key));
  };

  const isSearching = searchQuery.trim().length > 0;

  return (
    <aside
      className={`kc-shiso-history flex flex-col shrink-0 overflow-hidden${collapsed ? ' is-collapsed' : ''}`}
      data-testid="shiso-history-rail"
      aria-label="Conversation history"
    >
      <div className="kc-shiso-history-head">
        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            data-testid="shiso-history-toggle"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-controls="shiso-history-body"
            aria-label={collapsed ? 'Expand conversation history' : 'Collapse conversation history'}
            title={collapsed ? 'Expand history' : 'Collapse history'}
            className="kc-shiso-history-icon-btn kc-shiso-history-toggle"
          >
            <ChevronDown className="w-3.5 h-3.5 kc-shiso-history-chevron" aria-hidden="true" />
          </button>
          <h2 className="kc-shiso-history-title">Conversations</h2>
        </div>
        <button
          type="button"
          data-testid="shiso-history-new"
          onClick={onNew}
          disabled={busy}
          className="kc-shiso-history-icon-btn"
          aria-label="New conversation"
          title="New conversation"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div id="shiso-history-body" className="kc-shiso-history-body" hidden={collapsed}>
      <div className="kc-shiso-history-search">
        <Search className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          data-testid="shiso-history-search"
          className="kc-shiso-history-search-input"
        />
        {isSearching && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="kc-shiso-history-clear"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="kc-shiso-history-list" role="list">
        {isSearching ? (
          searchResults.length === 0 ? (
            <p className="kc-shiso-history-empty" data-testid="shiso-history-no-results">
              No matches in titles or messages.
            </p>
          ) : (
            searchResults.map((result) => (
              <button
                key={`search-${result.key}`}
                type="button"
                role="listitem"
                data-testid="shiso-history-result"
                onClick={() => onResume(result.key)}
                className={`kc-shiso-history-item kc-shiso-history-result${activeKey === result.key ? ' is-active' : ''}`}
              >
                <span className="kc-shiso-history-item-title">{result.title}</span>
                <span className="kc-shiso-history-snippet">
                  {result.matchedIn === 'title' ? result.snippet : `“…${result.snippet}…”`}
                </span>
                <span className="kc-shiso-history-matched">{result.matchedIn === 'title' ? 'Title match' : 'Message match'}</span>
              </button>
            ))
          )
        ) : conversations.length === 0 ? (
          <p className="kc-shiso-history-empty" data-testid="shiso-history-empty">
            No conversations yet. Start a new one above.
          </p>
        ) : (
          conversations.map((meta) => (
            <div
              key={meta.key}
              role="listitem"
              data-testid="shiso-history-item"
              className={`kc-shiso-history-row${activeKey === meta.key ? ' is-active' : ''}`}
            >
              {editingKey === meta.key ? (
                <div className="kc-shiso-history-rename">
                  <input
                    ref={renameRef}
                    value={editingTitle}
                    maxLength={80}
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                      if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
                    }}
                    aria-label="Conversation title"
                    data-testid="shiso-history-rename-input"
                    className="kc-shiso-history-rename-input"
                  />
                  <button type="button" onClick={commitRename} aria-label="Save title" title="Save title" className="kc-shiso-history-icon-btn">
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={cancelRename} aria-label="Cancel rename" title="Cancel" className="kc-shiso-history-icon-btn">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : confirmingKey === meta.key ? (
                <div className="kc-shiso-history-confirm" data-testid="shiso-history-confirm">
                  <p className="kc-shiso-history-confirm-text">Delete “{meta.title}”? This cannot be undone.</p>
                  <div className="kc-shiso-history-confirm-actions">
                    <button type="button" onClick={() => onDelete(meta.key)} data-testid="shiso-history-delete-confirm" className="kc-shiso-history-danger-btn">
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirmingKey(null)} className="kc-shiso-history-plain-btn">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onResume(meta.key)}
                    aria-label={`Resume ${meta.title}`}
                    data-testid="shiso-history-resume"
                    className="kc-shiso-history-item-main"
                  >
                    <span className="kc-shiso-history-item-icon" aria-hidden="true">
                      {meta.source === 'recipe' ? <Utensils className="w-5 h-5" /> : <MessageCircle className="w-6 h-6" />}
                    </span>
                    <span className="kc-shiso-history-item-copy">
                      <span className="kc-shiso-history-item-top">
                        <span className="kc-shiso-history-item-title">{meta.title}</span>
                        <span className="kc-shiso-history-source">{SOURCE_LABEL[meta.source]}</span>
                      </span>
                      {meta.preview && <span className="kc-shiso-history-preview">“…{meta.preview}”</span>}
                      {relativeTime(meta.updatedAt) && <span className="kc-shiso-history-time">{relativeTime(meta.updatedAt)}</span>}
                    </span>
                    <MoreHorizontal className="kc-shiso-history-more" aria-hidden="true" />
                  </button>
                  <div className="kc-shiso-history-item-actions">
                    <button type="button" onClick={() => beginRename(meta)} disabled={busy} aria-label={`Rename ${meta.title}`} title="Rename" className="kc-shiso-history-icon-btn">
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button type="button" onClick={() => beginDelete(meta.key)} disabled={busy} aria-label={`Delete ${meta.title}`} title="Delete" data-testid="shiso-history-delete" className="kc-shiso-history-icon-btn kc-shiso-history-danger">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <p className="kc-shiso-history-foot">Stored on this device only.</p>
      </div>
    </aside>
  );
}
