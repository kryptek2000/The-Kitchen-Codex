import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, X, Check, AlertCircle, ExternalLink, Search } from 'lucide-react';
import type { RepresentativeImageCandidate } from '../core/representativeImage';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { validateGeneratedImage } from '../core/recipeImage';

/**
 * The Kitchen Codex — Representative Recipe Image chooser (Phase 1).
 *
 * EXPLICIT selection only: nothing is chosen until the user picks a candidate
 * and confirms with "Use This Image". A searched image is a REPRESENTATIVE
 * image — it may resemble the recipe but is never guaranteed to depict the
 * exact generated dish. Thumbnails are rendered ONLY from the app-local proxy
 * route (never a third-party host). Attribution (source, creator, license) is
 * always shown as escaped text/links. No AI generation control exists.
 *
 * Search is EXPLICIT: typing never searches; only the Search button or Enter
 * submits one bounded search. Broader suggestions merely fill the input.
 */

export interface RepresentativeImageChooserProps {
  candidates: RepresentativeImageCandidate[];
  /** Query the candidates were found with (shown for transparency). */
  query?: string;
  /** Current search terms (prefilled with the deterministic default). */
  searchTerms?: string;
  /** Up to three deterministic, privacy-sanitized broader suggestions. */
  suggestions?: string[];
  /**
   * Monotonic search generation. Every new search increments this, which
   * IMMEDIATELY invalidates any prior candidate selection/preview.
   */
  searchGeneration?: number;
  /** True while a search/selection is in flight. */
  busy?: boolean;
  /** Bounded message (info/error). */
  message?: string | null;
  messageKind?: 'info' | 'error';
  /** Explicit search action (button/Enter). Never called on keystroke. */
  onSearch?: (terms: string) => void;
  onSelect: (candidate: RepresentativeImageCandidate) => void;
  onCancel: () => void;
  /**
   * Authenticated app-backend transport for candidate thumbnails (F1). When
   * supplied (and exposing `getBytes`), thumbnails load ONLY through the SAME
   * authorized binary path as previews (current in-memory endpoint token) via
   * managed object URLs — a plain protected-route `<img src>` could not attach
   * authorization, so NO plain `thumbnailPath` `<img src>` fallback exists.
   * When `network`/`getBytes` is unavailable, each candidate renders a bounded
   * unavailable placeholder and NO thumbnail request is issued (fail closed).
   */
  network?: NetworkAdapter;
  /**
   * When true, renders ONLY the licensed-search body (no overlay, no header, no
   * Escape handler) so a parent dialog (the two-mode image chooser) owns the
   * frame, title, tabs, and keyboard handling. Default false preserves the
   * standalone dialog behavior.
   */
  embedded?: boolean;
}

/** The ONE authoritative no-results message (never duplicated). */
export const REPRESENTATIVE_NO_RESULTS_MESSAGE =
  'No reusable representative images were found for these search terms. Try a broader search. Your current image was kept.';

function licenseLabel(id: RepresentativeImageCandidate['license'], version?: string): string {
  const base =
    id === 'cc0'
      ? 'CC0'
      : id === 'public_domain'
      ? 'Public Domain'
      : id === 'cc_by'
      ? 'CC BY'
      : id === 'cc_by_sa'
      ? 'CC BY-SA'
      : 'Reusable license';
  if (id === 'public_domain') return base;
  if (version && version !== 'unknown') return `${base} ${version}`;
  return base;
}

export const RepresentativeImageChooser: React.FC<RepresentativeImageChooserProps> = ({
  candidates,
  query,
  searchTerms,
  suggestions = [],
  searchGeneration,
  busy = false,
  message,
  messageKind = 'info',
  onSearch,
  onSelect,
  onCancel,
  network,
  embedded = false,
}) => {
  const [preview, setPreview] = useState<RepresentativeImageCandidate | null>(null);
  const [terms, setTerms] = useState<string>(searchTerms ?? '');
  const dialogRef = useRef<HTMLDivElement>(null);
  // Authenticated thumbnail object URLs keyed by candidate id (F1), plus ids
  // whose authorized load failed (bounded placeholder instead of a retry or an
  // unauthenticated fallback).
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [thumbFailed, setThumbFailed] = useState<Record<string, boolean>>({});
  const thumbUrlsRef = useRef<Record<string, string>>({});
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    // Revoke the previous generation before loading the new one.
    for (const url of Object.values(thumbUrlsRef.current)) URL.revokeObjectURL(url);
    thumbUrlsRef.current = {};
    setThumbUrls({});
    setThumbFailed({});
    if (!network || typeof network.getBytes !== 'function' || candidates.length === 0) return;
    (async () => {
      const next: Record<string, string> = {};
      const failed: Record<string, boolean> = {};
      for (const candidate of candidates) {
        if (cancelled) return;
        try {
          const res = await network.getBytes!(candidate.thumbnailPath);
          if (cancelled) return;
          if (!res.ok || !res.bytes || res.bytes.length === 0) {
            failed[candidate.id] = true;
            continue;
          }
          const validation = validateGeneratedImage({ bytes: res.bytes, contentType: res.contentType || 'image/jpeg' });
          if (!validation.valid || !validation.detectedMime) {
            failed[candidate.id] = true;
            continue;
          }
          const url = URL.createObjectURL(new Blob([res.bytes.slice()], { type: validation.detectedMime }));
          created.push(url);
          next[candidate.id] = url;
        } catch {
          if (cancelled) return;
          failed[candidate.id] = true;
        }
      }
      if (cancelled) {
        for (const url of created) URL.revokeObjectURL(url);
        return;
      }
      // Commit: the ref now owns these URLs, so drop them from the pending
      // list (cleanup revokes each owner exactly once).
      thumbUrlsRef.current = next;
      created.length = 0;
      setThumbUrls(next);
      setThumbFailed(failed);
    })().catch(() => {
      /* bounded placeholders stay */
    });
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
      for (const url of Object.values(thumbUrlsRef.current)) URL.revokeObjectURL(url);
      thumbUrlsRef.current = {};
    };
  }, [candidates, network]);

  // Keep the input in sync with the sanitized default/updated terms, but never
  // search as a side effect of that update.
  useEffect(() => {
    setTerms(searchTerms ?? '');
  }, [searchTerms]);

  // A NEW search immediately invalidates ALL prior candidate-selection state:
  // the previewed candidate and the confirmation authority tied to the old
  // result set. This holds for every new search attempt, regardless of outcome.
  useEffect(() => {
    setPreview(null);
  }, [searchGeneration]);

  // Defense-in-depth: a preview is only confirmable while it still belongs to
  // the CURRENT result set.
  const selectedCandidate =
    preview && candidates.some((candidate) => candidate.id === preview.id) ? preview : null;

  // Escape-to-close without saving; focus the dialog on open; trap Tab inside
  // the dialog; restore focus to the opener on close (I6). Mount-only: parent
  // re-renders (inline `onCancel` identity changes) must never steal focus
  // back. In embedded mode the parent dialog owns keyboard handling and focus.
  useEffect(() => {
    if (embedded) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [embedded]);

  /**
   * The SINGLE canonical submit path. It is invoked only by the real form's
   * `onSubmit` (native implicit submission covers both the Search button and
   * Enter in the input). There is deliberately NO separate key handler, so
   * there is no second dispatch path to double-fire or to trip on IME
   * composition. Clearing the preview here means a new search can never leave
   * an old candidate confirmable, even before the generation prop re-renders.
   */
  const submitSearch = () => {
    const clean = terms.trim();
    if (!clean || busy || !onSearch) return;
    setPreview(null);
    onSearch(clean);
  };

  const showNoResults = !busy && !message && candidates.length === 0;
  // Thumbnails are loadable ONLY through the authenticated binary transport.
  // Without it there is NO plain `thumbnailPath` `<img src>` fallback: each
  // candidate shows a bounded unavailable placeholder and issues no request.
  const canLoadThumbnails = Boolean(network) && typeof network!.getBytes === 'function';

  return (
    <div
      className={
        embedded
          ? 'text-gray-200'
          : 'fixed inset-0 z-[60] bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto'
      }
    >
      <div
        ref={embedded ? undefined : dialogRef}
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : 'true'}
        aria-label={embedded ? undefined : 'Choose a Representative Recipe Image'}
        tabIndex={embedded ? undefined : -1}
        className={
          embedded
            ? 'space-y-4 flex flex-col text-gray-200'
            : 'bg-[#141414] rounded-2xl border border-white/10 max-w-3xl w-full p-5 sm:p-6 shadow-2xl space-y-4 my-auto max-h-[92vh] flex flex-col text-gray-200 focus:outline-none'
        }
      >
        {!embedded && (
          <div className="flex items-start justify-between gap-3 pb-3 border-b border-white/5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-300 flex items-center justify-center">
                <ImageIcon className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base font-serif font-bold text-white">Choose a Representative Recipe Image</h2>
                <p className="text-[11px] text-gray-400">
                  Representative recipe image — results may resemble this recipe but are not guaranteed to depict the
                  exact generated dish.
                </p>
                <p className="text-[10px] text-gray-500">
                  Search sends only a sanitized visual query to an external licensed-image catalog.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Explicit, editable search terms. Typing never searches. */}
        <form
          data-testid="representative-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
          className="flex flex-col sm:flex-row sm:items-end gap-2"
        >
          <div className="flex-1">
            <label htmlFor="representative-search-terms" className="block text-[10px] font-semibold text-gray-400 mb-1">
              Search terms
            </label>
            <input
              id="representative-search-terms"
              data-testid="representative-search-input"
              type="text"
              value={terms}
              onChange={(event) => setTerms(event.target.value)}
              disabled={busy}
              maxLength={120}
              placeholder="e.g. blue cheese burger"
              className="w-full px-3 py-2 rounded-xl bg-[#0E0E0E] border border-white/10 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-sky-500/50 disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            data-testid="representative-search-button"
            disabled={busy || !terms.trim()}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-black text-xs font-bold transition-colors disabled:opacity-50"
          >
            <Search className="w-3.5 h-3.5" />
            <span>{busy ? 'Searching…' : 'Search'}</span>
          </button>
        </form>

        {message && (
          <div
            role={messageKind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            className={`p-3 rounded-xl text-xs flex items-start gap-2 ${
              messageKind === 'error'
                ? 'bg-rose-950/40 border border-rose-800/40 text-rose-300'
                : 'bg-sky-950/40 border border-sky-800/40 text-sky-200'
            }`}
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p>{message}</p>
          </div>
        )}

        {busy && (
          <div data-testid="representative-loading" className="text-center py-8 px-4 rounded-xl bg-[#0E0E0E] border border-white/10">
            <p className="text-xs text-gray-400">Searching licensed image catalogs…</p>
          </div>
        )}

        {showNoResults && (
          <div className="text-center py-6 px-4 rounded-xl bg-[#0E0E0E] border border-dashed border-white/10 space-y-3">
            <p className="text-xs text-gray-400">{REPRESENTATIVE_NO_RESULTS_MESSAGE}</p>
            {suggestions.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] text-gray-500">Try a broader search:</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      data-testid="representative-suggestion"
                      onClick={() => setTerms(suggestion)}
                      className="px-3 py-1.5 rounded-lg text-[11px] bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-600">Suggestions fill the search box — press Search to use one.</p>
              </div>
            )}
          </div>
        )}

        {candidates.length > 0 && (
          <div className="overflow-y-auto pr-1">
            {query && <p className="text-[10px] font-mono text-gray-500 mb-2">Search: {query}</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {candidates.map((candidate) => {
                const selected = selectedCandidate?.id === candidate.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    data-testid="representative-candidate"
                    aria-pressed={selected}
                    aria-label={`Select representative image: ${candidate.title}`}
                    onClick={() => setPreview(candidate)}
                    className={`text-left rounded-xl overflow-hidden border transition-colors ${
                      selected
                        ? 'border-sky-400 ring-2 ring-sky-400 bg-sky-500/10'
                        : 'border-white/10 hover:border-white/25'
                    }`}
                  >
                    {/* App-local thumbnail ONLY (never a third-party host and
                        never a plain protected-route `src`): the authorized
                        object URL built from validated `NetworkAdapter.getBytes`
                        bytes. Without a binary transport there is a bounded
                        per-candidate placeholder and NO request at all. */}
                    {thumbUrls[candidate.id] ? (
                      <img
                        src={thumbUrls[candidate.id]}
                        alt={`Representative recipe image: ${candidate.title}`}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="w-full h-28 object-cover bg-black/40"
                      />
                    ) : canLoadThumbnails && !thumbFailed[candidate.id] ? (
                      <div
                        data-testid="representative-thumbnail-loading"
                        className="w-full h-28 bg-black/40 flex items-center justify-center text-[10px] text-gray-500"
                      >
                        Loading thumbnail…
                      </div>
                    ) : (
                      <div
                        data-testid="representative-thumbnail-unavailable"
                        role="status"
                        className="w-full h-28 bg-black/40 flex items-center justify-center text-[10px] text-gray-500"
                      >
                        Thumbnail unavailable
                      </div>
                    )}
                    <div className="p-2 space-y-0.5">
                      <p className="text-[11px] text-gray-200 line-clamp-2">{candidate.title}</p>
                      <p className="text-[10px] text-gray-400">
                        {candidate.source === 'openverse' ? 'Openverse' : 'Wikimedia Commons'}
                        {candidate.creator ? ` · ${candidate.creator}` : ''}
                      </p>
                      <p className="text-[10px] text-emerald-400">
                        {selected ? '✓ ' : ''}
                        {licenseLabel(candidate.license, candidate.licenseVersion)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selectedCandidate && (
          <div className="p-3 rounded-xl bg-[#0F0F0F] border border-white/10 space-y-1">
            <p className="text-[11px] text-gray-300 font-medium">Preview: {selectedCandidate.title}</p>
            <p className="text-[10px] text-gray-400">
              Source:{' '}
              <a
                href={selectedCandidate.sourcePageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-400 underline inline-flex items-center gap-0.5"
              >
                {selectedCandidate.source === 'openverse' ? 'Openverse' : 'Wikimedia Commons'}
                <ExternalLink className="w-3 h-3" />
              </a>
              {selectedCandidate.creator ? ` · Creator: ${selectedCandidate.creator}` : ''}
            </p>
            <p className="text-[10px] text-gray-400">
              License:{' '}
              <a
                href={selectedCandidate.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline"
              >
                {licenseLabel(selectedCandidate.license, selectedCandidate.licenseVersion)}
              </a>
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            Keep Current Image
          </button>
          <button
            type="button"
            data-testid="use-representative-image"
            onClick={() => selectedCandidate && onSelect(selectedCandidate)}
            disabled={!selectedCandidate || busy}
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-black text-xs font-bold shadow-md shadow-sky-500/20 transition-colors disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            <span>{busy ? 'Preparing…' : 'Use This Image'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
