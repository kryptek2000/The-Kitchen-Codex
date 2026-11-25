import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, RefreshCw, ExternalLink, CheckCircle2, AlertTriangle, WifiOff, Info } from 'lucide-react';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import { BUILD_VERSION, BUILD_COMMIT, BUILD_TIME } from '../buildInfo';

type UpdateChannel = 'stable' | 'development';

interface UpdateResult {
  channel: UpdateChannel;
  installed: { version: string; commit: string; buildTime?: string };
  latest: { version?: string; commit?: string; tag?: string; url?: string; publishedAt?: string } | null;
  status: 'up-to-date' | 'update-available' | 'unknown' | 'error';
  message: string;
  compareUrl?: string;
  checkedAt: string;
}

interface AboutUpdatesModalProps {
  isOpen: boolean;
  onClose: () => void;
  network: NetworkAdapter;
}

const SHORT_COMMIT = (c: string) => (c && c !== 'unknown' ? c.slice(0, 12) : 'unknown');

export function AboutUpdatesModal({ isOpen, onClose, network }: AboutUpdatesModalProps) {
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const res = await network.get<UpdateResult>(`/api/update-check?channel=${channel}`);
      if (res.ok && res.data) {
        setResult(res.data);
      } else {
        setResult({
          channel,
          installed: { version: BUILD_VERSION, commit: BUILD_COMMIT, buildTime: BUILD_TIME },
          latest: null,
          status: 'error',
          message: `Update check failed: HTTP ${res.status}`,
          checkedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      setResult({
        channel,
        installed: { version: BUILD_VERSION, commit: BUILD_COMMIT, buildTime: BUILD_TIME },
        latest: null,
        status: 'error',
        message: `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setChecking(false);
    }
  }, [channel, network]);

  useEffect(() => {
    if (!isOpen) {
      setResult(null);
      setChecking(false);
      return;
    }

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    // Initial focus
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const statusIcon =
    result?.status === 'up-to-date' ? <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden="true" /> :
    result?.status === 'update-available' ? <AlertTriangle className="h-5 w-5 text-amber-400" aria-hidden="true" /> :
    result?.status === 'error' ? <WifiOff className="h-5 w-5 text-red-400" aria-hidden="true" /> :
    <Info className="h-5 w-5 text-sky-400" aria-hidden="true" />;

  const releaseUrl = result?.latest?.url || result?.compareUrl;
  const statusText =
    result?.status === 'up-to-date' ? 'Up to date' :
    result?.status === 'update-available' ? 'Update available' :
    result?.status === 'unknown' ? 'Update status unknown' :
    result?.status === 'error' ? 'Update check failed' : '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-updates-title"
        aria-describedby="about-updates-description"
        className="w-full max-w-lg rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-primary,#F3F4F6)] shadow-2xl focus:outline-none"
        tabIndex={-1}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] px-5 py-4">
          <h2 id="about-updates-title" className="font-serif text-xl">About &amp; Updates</h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close About and Updates"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-secondary,#9CA3AF)] hover:bg-[var(--bg-elevated,#1E1E1E)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-text,#F59E0B)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <p id="about-updates-description" className="sr-only">
            Installed version and update status. Checking is read-only and does not install updates.
          </p>

          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted,#6B7280)]">Installed application</p>
            <p className="text-sm font-medium">{BUILD_VERSION}</p>
            <p className="font-mono text-xs text-[var(--text-secondary,#9CA3AF)]">
              Commit: {SHORT_COMMIT(BUILD_COMMIT)}
              {BUILD_TIME ? ` · Built ${BUILD_TIME}` : ''}
            </p>
          </div>

          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted,#6B7280)]">Update channel</span>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as UpdateChannel)}
                className="w-full min-h-[44px] rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-text,#F59E0B)]"
              >
                <option value="stable">Stable (latest GitHub release)</option>
                <option value="development">Owner development (latest approved main commit)</option>
              </select>
            </label>

            <button
              type="button"
              onClick={runCheck}
              disabled={checking}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[var(--accent-text,#F59E0B)] px-4 py-2 text-sm font-medium text-black disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
            >
              <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
              {checking ? 'Checking…' : 'Check for Updates'}
            </button>
          </div>

          <div aria-live="polite" aria-atomic="true" className="min-h-[1.25rem]">
            {checking && <p className="text-sm text-[var(--text-secondary,#9CA3AF)]">Checking for updates…</p>}
          </div>

          {result && (
            <div className="rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-4 space-y-2" role="status" aria-live="polite">
              <div className="flex items-center gap-2">
                {statusIcon}
                <p className="text-sm font-medium">{statusText}</p>
              </div>
              <p className="text-sm text-[var(--text-secondary,#9CA3AF)]">{result.message}</p>
              {result.latest?.tag && (
                <p className="text-xs text-[var(--text-secondary,#9CA3AF)]">
                  Latest stable: {result.latest.tag}
                  {result.latest.commit ? ` (${SHORT_COMMIT(result.latest.commit)})` : ''}
                </p>
              )}
              {result.latest?.commit && !result.latest?.tag && (
                <p className="text-xs text-[var(--text-secondary,#9CA3AF)]">
                  Latest development commit: {SHORT_COMMIT(result.latest.commit)}
                </p>
              )}
              {releaseUrl && (
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-[var(--accent-text,#F59E0B)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-text,#F59E0B)]"
                >
                  View release / comparison details <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
              <p className="text-[10px] text-[var(--text-muted,#6B7280)]">
                Checked {new Date(result.checkedAt).toLocaleString()}
              </p>
            </div>
          )}

          <p className="text-[11px] text-[var(--text-muted,#6B7280)]">
            Checking is read-only. No updates are downloaded or installed automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

export default AboutUpdatesModal;
