import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  LogOut,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { getChatGptBridge } from '../platform/desktop/desktopVault';
import type { ChatGptStatusView } from '../platform/desktop/desktopVault';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import type { SettingsAdapter } from '../application/adapters/SettingsAdapter';
import {
  getCachedAiSelections,
  hydrateAiSelections,
  resetAiSelectionWithOutcome,
  saveAiSelectionWithOutcome,
  type SavedSelection,
} from '../application/aiSelection';
import { fetchProviderCatalog } from '../application-ui/providerCatalog';

interface ErrorView {
  code: string;
  message: string;
  manageUsageUrl?: string;
}

interface ModelOption {
  id: string;
  name: string;
}

type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorView };

async function unwrap<T>(promise: Promise<BridgeResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.value;
  throw (result as { ok: false; error: ErrorView }).error;
}

function isCancelled(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as ErrorView).code === 'CANCELLED');
}

/**
 * AI Studio — explicit ChatGPT subscription authorization and basic text test.
 *
 * The renderer never receives OAuth tokens. All credential and inference work
 * stays in the trusted Electron main process through the narrow preload bridge.
 */
export function ChatGptSubscriptionPanel({
  network,
  settings,
  onTextAiRuntimeChanged,
  onSelectionChanged,
}: {
  network?: NetworkAdapter;
  settings?: SettingsAdapter;
  onTextAiRuntimeChanged?: () => void;
  onSelectionChanged?: () => void;
} = {}) {
  const bridge = useMemo(() => getChatGptBridge(), []);
  const [status, setStatus] = useState<ChatGptStatusView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState('');
  const [savedAccount, setSavedAccount] = useState('');
  const [prompt, setPrompt] = useState('Say exactly: Hello from The Kitchen Codex.');
  const [result, setResult] = useState('');
  const [requestId, setRequestId] = useState('');
  const [defaultSelection, setDefaultSelection] = useState<SavedSelection>(
    () => getCachedAiSelections().textAi
  );
  const [selectionNotice, setSelectionNotice] = useState('');
  const [serverManagedText, setServerManagedText] = useState(false);
  const [serverManagedLabel, setServerManagedLabel] = useState('');
  const [catalogTruthLoaded, setCatalogTruthLoaded] = useState(false);
  const [nativePlanCatalogReady, setNativePlanCatalogReady] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!bridge) return;
    try {
      const next = await bridge.status();
      setStatus(next);
    } catch {
      setError({ code: 'STATUS_UNAVAILABLE', message: 'ChatGPT subscription status could not be read.' });
    }
  }, [bridge]);

  const refreshCatalogTruth = useCallback(async (): Promise<{
    ok: boolean;
    hasProvider: boolean;
    models: string[];
  }> => {
    if (!network) return { ok: false, hasProvider: false, models: [] };
    try {
      const catalog = await fetchProviderCatalog(network);
      const allowed = catalog.selection.userSelectionAllowed.text;
      const nativeRow = catalog.textProviders.find((p) => p.providerId === 'chatgpt-plan');
      setCatalogTruthLoaded(true);
      setNativePlanCatalogReady(Boolean(nativeRow));
      setServerManagedText(!allowed);
      setServerManagedLabel(
        allowed
          ? ''
          : `${catalog.selection.text.selectedProviderId ?? 'server default'}${
              catalog.selection.text.selectedModelId
                ? ` / ${catalog.selection.text.selectedModelId}`
                : ''
            }`
      );
      return {
        ok: true,
        hasProvider: Boolean(nativeRow),
        models: nativeRow?.models.map((m) => m.id) ?? [],
      };
    } catch {
      // Leave the last known truth untouched. The dedicated ChatGPT panel still
      // reports its own live connection state; a failed catalog read never grants
      // selection authority.
      return { ok: false, hasProvider: false, models: [] };
    }
  }, [network]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    void refreshCatalogTruth();
  }, [refreshCatalogTruth]);

  useEffect(() => {
    let alive = true;
    if (!settings) {
      setDefaultSelection(getCachedAiSelections().textAi);
      return () => { alive = false; };
    }
    void hydrateAiSelections(settings)
      .then((selections) => {
        if (alive) setDefaultSelection(selections.textAi);
      })
      .catch(() => {
        if (alive) {
          setError({
            code: 'AI_SELECTION_UNAVAILABLE',
            message: 'The saved Text AI preference could not be read. No provider is charged until this is resolved.',
          });
        }
      });
    return () => { alive = false; };
  }, [settings]);

  const active = status?.activeAccount || null;
  const planReady = Boolean(active && active.planEnabled && !active.signedOut);

  useEffect(() => {
    if (active || !status?.accounts.length) return;
    setSavedAccount((current) => current || status.accounts[0].accountKey);
  }, [active, status?.accounts]);

  useEffect(() => {
    let alive = true;
    setModels([]);
    setModel('');
    setResult('');
    if (!bridge || !planReady) return () => { alive = false; };
    void (async () => {
      try {
        const rows = await unwrap(bridge.models());
        if (!alive) return;
        setModels(rows);
        const savedModel = defaultSelection.modelId;
        setModel(rows.some((row) => row.id === savedModel) ? savedModel! : rows[0]?.id || '');
      } catch (nextError) {
        if (!alive) return;
        setError(nextError as ErrorView);
      }
    })();
    return () => { alive = false; };
  }, [bridge, active?.accountKey, planReady, defaultSelection.modelId]);

  const chatGptDefault =
    defaultSelection.mode === 'user_selected' && defaultSelection.providerId === 'chatgpt-plan';
  const defaultAccountMatches =
    !defaultSelection.accountKey || defaultSelection.accountKey === active?.accountKey;
  const defaultModel = models.find((row) => row.id === defaultSelection.modelId);
  const defaultActive =
    chatGptDefault &&
    planReady &&
    defaultAccountMatches &&
    Boolean(defaultSelection.modelId) &&
    Boolean(defaultModel);
  const defaultModelLabel =
    defaultModel?.name || defaultSelection.modelId || 'no model selected';
  const defaultTextAiLabel = chatGptDefault
    ? `ChatGPT plan / ${defaultModelLabel}`
    : 'Server provider';

  if (!bridge || !status || !status.enabled) return null;

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice('');
    try {
      await task();
    } catch (nextError) {
      const value = nextError as ErrorView;
      if (!isCancelled(value)) {
        setError(value);
        // A failed request can mean the session expired or entitlement changed.
        // Refresh the non-secret truth rather than leaving a stale "connected".
        void refreshStatus();
        void refreshCatalogTruth();
      } else {
        setNotice('ChatGPT request cancelled. Nothing was accepted.');
      }
    } finally {
      setBusy(null);
    }
  };

  const connect = () => run('connect', async () => {
    const next = await unwrap(bridge.connect());
    setStatus(next);
    setNotice('ChatGPT account connected for this session.');
    void refreshCatalogTruth();
  });

  const reconnect = () => run('reconnect', async () => {
    const next = await unwrap(bridge.reconnect(active?.accountKey));
    setStatus(next);
    setNotice('ChatGPT connection renewed for this session.');
    void refreshCatalogTruth();
  });

  const addAccount = () => run('connect', async () => {
    const next = await unwrap(bridge.connect({}));
    setStatus(next);
    setNotice('Additional ChatGPT account connected for this session.');
    void refreshCatalogTruth();
  });

  const selectAccount = (accountKey: string) => run('account', async () => {
    const next = await unwrap(bridge.selectAccount(accountKey));
    setStatus(next);
    setNotice('Active ChatGPT account changed.');
    void refreshCatalogTruth();
  });

  const disconnect = () => {
    if (!active) return;
    if (!window.confirm('Sign out of this ChatGPT account in The Kitchen Codex?')) return;
    void run('disconnect', async () => {
      const response = await unwrap(bridge.disconnect(active.accountKey));
      setStatus(response.status);
      setModels([]);
      setResult('');
      setNotice(
        response.remoteRevocationConfirmed
          ? 'ChatGPT session disconnected.'
          : 'Local ChatGPT session cleared. Remote revocation was not confirmed.'
      );
      void refreshCatalogTruth();
    });
  };

  const manageUsage = () => run('usage', async () => {
    await unwrap(bridge.manageUsage());
  });

  const sendTest = () => run('infer', async () => {
    if (!model) throw { code: 'UNSUPPORTED_MODEL', message: 'Choose an available ChatGPT model.' };
    if (!prompt.trim()) throw { code: 'INVALID_REQUEST', message: 'Enter a prompt for the text test.' };
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `tkc-${Date.now()}`;
    setRequestId(id);
    setResult('');
    const response = await unwrap(
      bridge.infer({
        accountKey: active?.accountKey,
        model,
        input: [{ role: 'user', content: prompt.trim() }],
        requestId: id,
      })
    );
    setResult(response.text);
    setNotice('Response completed.');
  });

  const cancelTest = () => {
    if (!requestId) return;
    void bridge.cancel(requestId).catch(() => {});
  };

  const cancelConnect = () => {
    void bridge.cancelConnect().catch(() => {});
  };

  const useChatGptAsDefault = () => run('default', async () => {
    setSelectionNotice('');
    if (!settings) {
      throw { code: 'SETTINGS_UNAVAILABLE', message: 'AI preferences are not available in this shell.' };
    }
    if (serverManagedText) {
      throw {
        code: 'SERVER_MANAGED_TEXT',
        message: 'Text AI is server-managed on this deployment, so a local default cannot override it.',
      };
    }
    if (!active || !planReady) {
      throw {
        code: 'CHATGPT_NOT_CONNECTED',
        message: 'Connect an eligible ChatGPT plan account before making it the default.',
      };
    }
    if (!model) {
      throw { code: 'UNSUPPORTED_MODEL', message: 'Choose an available ChatGPT model.' };
    }
    // Refresh the server-side model/capability cache before saving the preference.
    const verified = await refreshCatalogTruth();
    if (!verified.ok || !verified.hasProvider) {
      throw {
        code: 'CATALOG_UNAVAILABLE',
        message: 'The local server does not expose the native ChatGPT plan bridge. Nothing was saved.',
      };
    }
    if (!verified.models.includes(model)) {
      throw {
        code: 'MODEL_UNVERIFIED',
        message: 'The server could not verify the selected ChatGPT model. Nothing was saved.',
      };
    }
    const outcome = await saveAiSelectionWithOutcome(
      settings,
      'text',
      'user_selected',
      'chatgpt-plan',
      model,
      'native_plan',
      undefined,
      active.accountKey
    );
    setDefaultSelection(outcome.selections.textAi);
    setSelectionNotice(
      outcome.persistenceFailed
        ? 'ChatGPT plan is the Default Text AI for this session, but the preference could not be saved.'
        : 'ChatGPT plan is now the Default Text AI for supported text requests.'
    );
    onTextAiRuntimeChanged?.();
    onSelectionChanged?.();
  });

  const resetDefaultTextAi = () => run('default', async () => {
    setSelectionNotice('');
    if (!settings) {
      throw { code: 'SETTINGS_UNAVAILABLE', message: 'AI preferences are not available in this shell.' };
    }
    const outcome = await resetAiSelectionWithOutcome(settings, 'text');
    setDefaultSelection(outcome.selections.textAi);
    setSelectionNotice(
      outcome.persistenceFailed
        ? 'The configured server provider is active for this session; the preference could not be saved.'
        : 'Switched back to the configured server provider.'
    );
    onTextAiRuntimeChanged?.();
    onSelectionChanged?.();
    void refreshCatalogTruth();
  });

  const defaultStatusText = !catalogTruthLoaded
    ? 'Text AI selection status could not be verified. No provider is charged until this is resolved.'
    : !nativePlanCatalogReady
    ? 'The local server does not expose the native ChatGPT plan bridge. Restart the desktop app with the ChatGPT feature enabled.'
    : serverManagedText
    ? `Text AI is server-managed (${serverManagedLabel || 'operator pin'}). A local default cannot override it.`
    : !chatGptDefault
    ? planReady
      ? 'ChatGPT plan is connected but is not the default. Server selection remains in effect.'
      : 'Connect an eligible ChatGPT account to make it the Default Text AI.'
    : !planReady
    ? 'Saved, but ChatGPT plan is not connected. Reconnect this account; no other provider will be used automatically.'
    : !defaultAccountMatches
    ? 'Saved for a different ChatGPT account. Reconnect or select that account; no other provider will be used automatically.'
    : !defaultSelection.modelId
    ? 'Saved without a model. Choose an available model and save the default again.'
    : defaultActive
    ? 'Active for supported text requests, including Shiso conversation.'
    : 'Saved, but the selected model is not currently available. Choose another model or reset.';

  const storageUnavailable = status.error?.code === 'SECURE_STORAGE_UNAVAILABLE';

  return (
    <div className="space-y-5" data-chatgpt-subscription="true">
      <div className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-5 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)]">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <h2 className="font-serif text-[22px] text-[var(--text-primary,#F3F4F6)]">
              Use ChatGPT subscription
            </h2>
            <p className="text-[13px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)]">
              Eligible ChatGPT Plus and Pro accounts can use plan usage for supported text requests.
              This is separate from an OpenAI API key and never falls back to separately billed API usage.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] p-4 space-y-2">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-primary,#F3F4F6)]">
            <ShieldCheck className="h-4 w-4 text-emerald-300" aria-hidden="true" />
            Local-only experimental connection
          </div>
          <p className="text-[11px] leading-[1.5] text-[var(--text-muted,#6B7280)]">
            OAuth runs in your system browser. Access, refresh, and ID tokens stay only in trusted
            Electron main-process memory for this session. They are never exposed to the React
            renderer, written to disk, or stored in the Recipe Vault. Sign-in is required again
            after the application restarts. Plain-text ChatGPT plan requests and Shiso conversation
            are supported; structured recipe and nutrition operations are not yet enabled for this
            connection.
          </p>
        </div>

        <div
          data-chatgpt-default-text-ai="true"
          className="rounded-xl border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] p-4 space-y-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted,#6B7280)]">
                Default Text AI
              </div>
              <div className="text-[14px] font-semibold text-[var(--text-primary,#F3F4F6)]">
                {defaultTextAiLabel}
              </div>
              <p
                data-chatgpt-default-status="true"
                role="status"
                className="mt-1 text-[11px] leading-[1.5] text-[var(--text-secondary,#9CA3AF)]"
              >
                {defaultStatusText}
              </p>
            </div>
            {chatGptDefault && defaultActive && (
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                Active
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-chatgpt-use-default="true"
              onClick={useChatGptAsDefault}
              disabled={Boolean(busy) || !planReady || !model || serverManagedText || !catalogTruthLoaded || !nativePlanCatalogReady || !settings}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[var(--accent,#F59E0B)] px-4 py-2 text-[13px] font-semibold text-[var(--color-on-accent,#0C0C0C)] disabled:opacity-60"
            >
              Use as Default Text AI
            </button>
            <button
              type="button"
              data-chatgpt-reset-default="true"
              onClick={resetDefaultTextAi}
              disabled={Boolean(busy) || !chatGptDefault || !settings}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] px-4 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)] disabled:opacity-60"
            >
              Use configured server provider
            </button>
          </div>
          {selectionNotice && (
            <p role="status" className="text-[12px] text-emerald-300">
              {selectionNotice}
            </p>
          )}
          {busy === 'default' && (
            <p role="status" className="text-[11px] text-[var(--text-muted,#6B7280)]">
              Updating the Default Text AI preference…
            </p>
          )}
        </div>

        {status.legacyCredentials === 'present_inert' && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-[12px] text-amber-100">
            An older credential file could not be deleted. It is not read and cannot authorize
            this session; sign out and restart still require a fresh sign-in.
          </div>
        )}

        {status.error && !storageUnavailable && (
          <ErrorBanner error={status.error} onManageUsage={manageUsage} />
        )}

        {storageUnavailable && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-[12px] text-red-200">
            {status.error?.message}
          </div>
        )}

        {!storageUnavailable && (
          <>
            {!active && status.accounts.length > 0 && (
              <div className="flex flex-wrap items-end gap-2 rounded-xl border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] p-4">
                <label className="block min-w-[240px] flex-1 space-y-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted,#6B7280)]">
                    This-session ChatGPT accounts
                  </span>
                  <select
                    value={savedAccount}
                    onChange={(event) => setSavedAccount(event.target.value)}
                    className="min-h-[44px] w-full rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] px-3 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)]"
                  >
                    {status.accounts.map((account) => (
                      <option key={account.accountKey} value={account.accountKey}>
                        {account.email || account.accountKey}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void selectAccount(savedAccount)}
                  disabled={Boolean(busy) || !savedAccount}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] px-4 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)] disabled:opacity-60"
                >
                  Use account
                </button>
              </div>
            )}

            {!active && (
              <div className="space-y-2">
                <p className="text-[12px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)]">
                  Sign-in is required after application restart. No OAuth credential is retained
                  between sessions.
                </p>
                <button
                  type="button"
                  onClick={connect}
                  disabled={Boolean(busy)}
                  className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-[var(--accent,#F59E0B)] px-5 py-2 text-[14px] font-semibold text-[var(--color-on-accent,#0C0C0C)] disabled:opacity-60"
                >
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  {busy === 'connect' ? 'Waiting for ChatGPT…' : 'Continue with ChatGPT'}
                </button>
              </div>
            )}

            {active && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                      planReady
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    {planReady ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                    {planReady ? 'Plan usage enabled' : 'Plan usage disabled'}
                  </span>
                  <span className="text-[12px] text-[var(--text-muted,#6B7280)]">
                    {active.email || 'ChatGPT account'} · Connected for this session
                  </span>
                </div>

                {status.accounts.length > 1 && (
                  <label className="block max-w-md space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted,#6B7280)]">
                      Connected account
                    </span>
                    <select
                      value={active.accountKey}
                      onChange={(event) => void selectAccount(event.target.value)}
                      disabled={Boolean(busy)}
                      className="min-h-[44px] w-full rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)]"
                    >
                      {status.accounts.map((account) => (
                        <option key={account.accountKey} value={account.accountKey}>
                          {account.email || account.accountKey}
                          {account.planEnabled ? '' : ' (plan disabled)'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {!planReady && (
                  <p className="text-[12px] leading-[1.55] text-amber-200">
                    This account is signed in, but ChatGPT plan usage was not granted. Reconnect to
                    request the documented plan-usage scopes. No API key is used automatically.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={reconnect}
                    disabled={Boolean(busy)}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)] disabled:opacity-60"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Reconnect
                  </button>
                  <button
                    type="button"
                    onClick={addAccount}
                    disabled={Boolean(busy)}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)] disabled:opacity-60"
                  >
                    Add another account
                  </button>
                  <button
                    type="button"
                    onClick={manageUsage}
                    disabled={Boolean(busy)}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)] disabled:opacity-60"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Manage usage
                  </button>
                  <button
                    type="button"
                    onClick={disconnect}
                    disabled={Boolean(busy)}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-[13px] text-red-200 disabled:opacity-60"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Disconnect / Sign out
                  </button>
                </div>

                {planReady && (
                  <div className="space-y-3 border-t border-[var(--color-rule,var(--bg-elevated))] pt-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="block min-w-[220px] flex-1 space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted,#6B7280)]">
                          Available model
                        </span>
                        <select
                          value={model}
                          onChange={(event) => setModel(event.target.value)}
                          disabled={Boolean(busy) || models.length === 0}
                          className="min-h-[44px] w-full rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)]"
                        >
                          {models.length === 0 && <option value="">No models returned</option>}
                          {models.map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.name} ({row.id})
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => void run('models', async () => {
                          const rows = await unwrap(bridge.models({ force: true }));
                          setModels(rows);
                          setModel(rows[0]?.id || '');
                        })}
                        disabled={Boolean(busy)}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-[12px] text-[var(--text-secondary,#9CA3AF)] disabled:opacity-60"
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        Refresh models
                      </button>
                    </div>

                    <label className="block space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted,#6B7280)]">
                        Basic text test
                      </span>
                      <textarea
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        rows={3}
                        disabled={Boolean(busy)}
                        className="w-full rounded-lg border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] px-3 py-2 text-[13px] text-[var(--text-primary,#F3F4F6)]"
                      />
                    </label>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={sendTest}
                        disabled={Boolean(busy) || !model}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[var(--accent,#F59E0B)] px-4 py-2 text-[13px] font-semibold text-[var(--color-on-accent,#0C0C0C)] disabled:opacity-60"
                      >
                        <Send className="h-4 w-4" aria-hidden="true" />
                        {busy === 'infer' ? 'Waiting for response.completed…' : 'Send test request'}
                      </button>
                      {busy === 'infer' && (
                        <button
                          type="button"
                          onClick={cancelTest}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-[13px] text-red-200"
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                          Cancel
                        </button>
                      )}
                    </div>

                    {result && (
                      <div className="rounded-xl border border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-elevated,#1E1E1E)] p-4">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted,#6B7280)]">
                          Completed response
                        </div>
                        <pre className="whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-[var(--text-primary,#F3F4F6)]">
                          {result}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {(busy === 'connect' || busy === 'reconnect') && (
              <button
                type="button"
                onClick={cancelConnect}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-[13px] text-red-200"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Cancel sign-in
              </button>
            )}
            {notice && <p className="text-[12px] text-emerald-300">{notice}</p>}
            {error && <ErrorBanner error={error} onManageUsage={manageUsage} />}
          </>
        )}
      </div>
    </div>
  );
}

function ErrorBanner({
  error,
  onManageUsage,
}: {
  error: ErrorView;
  onManageUsage: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-[12px] text-red-200">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-2">
          <p>{error.message}</p>
          <p className="font-mono text-[10px] text-red-300/80">{error.code}</p>
          {error.manageUsageUrl && (
            <button
              type="button"
              onClick={onManageUsage}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-400/30 px-3 py-1.5 text-[11px] font-medium text-red-100"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Manage usage
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
