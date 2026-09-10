/**
 * The Kitchen Codex — Session Credentials panel (BYOK-5E).
 *
 * User-facing management of SESSION-ONLY BYOK keys. All async orchestration lives
 * in the platform-neutral `SessionKeyController` (provider-bound + unmount-safe);
 * this component only renders its state and forwards user intent.
 *
 * SECURITY / TRUTH:
 *   - The typed key lives ONLY in the controller's in-memory state and is cleared
 *     after a successful save, on revoke, on provider change, on credential-source
 *     switch, and on unmount. It is NEVER persisted and is sent ONLY to
 *     POST /api/providers/session-key.
 *   - The server never returns the key, so the UI NEVER re-displays it (no masked
 *     fragment, prefix, suffix, or hash).
 *   - Session-only BYOK is enabled only when the SERVER reports it is supported.
 *   - Image providers: session credential VALIDATION is available, but session
 *     image GENERATION is not enabled yet — stated truthfully.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import {
  SessionKeyController,
  type SessionKeyNotice,
  type SessionKeyProviderOption,
  type SessionKeyState,
  type SessionKeyStatusState,
} from './sessionKeyController';
import type { ConnectionTestView } from './sessionKey';

export type { SessionKeyProviderOption } from './sessionKeyController';
export type SessionKeyStatusStateAlias = SessionKeyStatusState;

/** Human-readable, non-secret expiry text (never reveals key material). */
export function sessionExpiryText(expiresAt: string | undefined, now: number = Date.now()): string | undefined {
  if (!expiresAt) return undefined;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return undefined;
  const ms = ts - now;
  if (ms <= 0) return 'Expired';
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `Expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `Expires in ${hours} h`;
}

/** Presentational props (pure; SSR-testable). */
export interface SessionKeyPanelViewProps {
  sessionByokSupported: boolean;
  providers: SessionKeyProviderOption[];
  selectedProviderId: string;
  selectedModelId: string;
  apiKey: string;
  status: SessionKeyStatusState;
  expiresAt?: string;
  saveState: 'idle' | 'saving';
  revokeState: 'idle' | 'revoking';
  testState: 'idle' | 'testing';
  testResult?: ConnectionTestView;
  notice?: SessionKeyNotice;
  onSelectProvider: (providerId: string) => void;
  onSelectModel: (modelId: string) => void;
  onChangeApiKey: (value: string) => void;
  onSave: () => void;
  onRevoke: () => void;
  onTest: () => void;
}

/** Presentational session-credentials card (no hooks). */
export function SessionKeyPanelView(props: SessionKeyPanelViewProps) {
  const selectedProvider = props.providers.find((p) => p.providerId === props.selectedProviderId);
  const isImage = selectedProvider?.kind === 'image';
  const configured = props.status === 'configured';
  const unavailable = !props.sessionByokSupported || props.status === 'unavailable';
  const busy = props.saveState === 'saving' || props.revokeState === 'revoking';
  const canSave = !unavailable && props.apiKey.trim().length > 0 && !busy;
  const canTest = !unavailable && !busy && props.testState !== 'testing' && configured;

  return (
    <section
      data-session-key-panel="true"
      className="max-w-7xl mx-auto px-4 sm:px-6 pt-4 border-t border-white/5 space-y-4"
    >
      <div>
        <h3 className="font-serif font-semibold text-sm text-white">Session API Keys</h3>
        <p className="text-xs text-gray-400 mt-1 max-w-2xl">
          Store an API key in this server process memory only. It expires automatically and is lost
          when the server restarts. The key is never saved to your browser, vault, or this
          preference store.
        </p>
      </div>

      {!props.sessionByokSupported && (
        <div
          data-session-unavailable="true"
          className="text-[11px] rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 px-3 py-2"
        >
          Session-only BYOK is available only in local, single-user deployments.
        </div>
      )}

      <div className="border border-white/10 rounded-2xl bg-[#141414] p-4 space-y-4 max-w-2xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Provider</span>
            <select
              data-session-provider-select="true"
              value={props.selectedProviderId}
              onChange={(e) => props.onSelectProvider(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
            >
              <option value="">Choose a provider…</option>
              {props.providers.map((p) => (
                <option key={`${p.kind}:${p.providerId}`} value={p.providerId}>
                  {p.name} ({p.providerId})
                </option>
              ))}
            </select>
          </label>

          {selectedProvider && selectedProvider.models.length > 0 && (
            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Model</span>
              <select
                data-session-model-select="true"
                value={props.selectedModelId}
                onChange={(e) => props.onSelectModel(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
              >
                {selectedProvider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.default ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {isImage && (
          <div className="text-[11px] rounded-lg border border-white/10 bg-white/[0.03] text-gray-300 px-3 py-2">
            Session key validation is available for this image provider. Session-key image
            generation is not enabled yet.
          </div>
        )}

        {!selectedProvider ? (
          <div className="text-[12px] text-gray-500">Choose a provider to manage its session key.</div>
        ) : (
          <>
            <div className="space-y-1">
              <label
                htmlFor="session-api-key-input"
                className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold"
              >
                Session API key
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="session-api-key-input"
                  data-session-key-input="true"
                  type="password"
                  name="session-api-key"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder="Enter API key"
                  value={props.apiKey}
                  onChange={(e) => props.onChangeApiKey(e.target.value)}
                  disabled={unavailable || busy}
                  className="flex-1 min-w-[12rem] bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] text-gray-200"
                />
                <button
                  type="button"
                  data-session-save="true"
                  onClick={props.onSave}
                  disabled={!canSave}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-gray-200 hover:bg-white/15 border border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {props.saveState === 'saving' ? 'Saving…' : configured ? 'Update session key' : 'Save session key'}
                </button>
                {configured && (
                  <button
                    type="button"
                    data-session-revoke="true"
                    onClick={props.onRevoke}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 text-gray-300 hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {props.revokeState === 'revoking' ? 'Revoking…' : 'Revoke session key'}
                  </button>
                )}
              </div>
              <div className="text-[11px] text-gray-500">
                Stored only in server memory. Lost on restart. Never re-displayed.
              </div>
            </div>

            <div
              className="text-[11px]"
              data-session-status={props.status}
              role="status"
              aria-live="polite"
            >
              {props.status === 'loading' && <span className="text-gray-400">Checking session key…</span>}
              {props.status === 'unavailable' && <span className="text-amber-300">Unavailable in this deployment.</span>}
              {props.status === 'error' && <span className="text-red-300">Could not read session key status.</span>}
              {props.status === 'not-configured' && <span className="text-gray-400">Not configured</span>}
              {props.status === 'configured' && (
                <span className="text-emerald-300">
                  Configured for this session
                  {sessionExpiryText(props.expiresAt) ? ` · ${sessionExpiryText(props.expiresAt)}` : ''}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-session-test="true"
                onClick={props.onTest}
                disabled={!canTest}
                title={!configured ? 'Save a session key before testing the connection.' : undefined}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-gray-200 hover:bg-white/15 border border-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {props.testState === 'testing' ? 'Testing…' : 'Test Connection'}
              </button>
              {!configured && (
                <span className="text-[11px] text-gray-500">Save a session key before testing the connection.</span>
              )}
            </div>

            {props.testResult && (
              <div
                data-session-test-result={props.testResult.ok ? 'success' : 'failure'}
                role="status"
                aria-live="polite"
                className={`text-[11px] ${props.testResult.ok ? 'text-emerald-300' : 'text-red-300'}`}
              >
                {props.testResult.ok
                  ? `Credential check passed${props.testResult.model ? ` · ${props.testResult.model}` : ''}${
                      props.testResult.latencyMs !== undefined ? ` · ${props.testResult.latencyMs} ms` : ''
                    }`
                  : `${props.testResult.message ?? 'Connection test failed.'}${
                      props.testResult.code ? ` (${props.testResult.code})` : ''
                    }`}
              </div>
            )}

            {props.notice && (
              <div
                data-session-notice={props.notice.kind}
                role={props.notice.kind === 'error' ? 'alert' : 'status'}
                aria-live={props.notice.kind === 'error' ? 'assertive' : 'polite'}
                className={`text-[11px] rounded-lg px-3 py-2 border ${
                  props.notice.kind === 'error'
                    ? 'border-red-500/30 bg-red-500/10 text-red-200'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                }`}
              >
                {props.notice.text}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Stateful container: owns one `SessionKeyController` (created lazily, disposed
 * on unmount) and renders its state. `clearKeySignal` increments when the text
 * credential source switches away from session_only, clearing the typed key.
 */
export function SessionKeyPanel({
  network,
  sessionByokSupported,
  providers,
  clearKeySignal = 0,
}: {
  network: NetworkAdapter;
  sessionByokSupported: boolean;
  providers: SessionKeyProviderOption[];
  clearKeySignal?: number;
}) {
  const controllerRef = useRef<SessionKeyController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new SessionKeyController(network, providers);
  }
  const controller = controllerRef.current;
  const [state, setState] = useState<SessionKeyState>(controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  // Kick off the initial status fetch once.
  useEffect(() => {
    void controller.refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear the typed key when the credential source switches away from session_only.
  useEffect(() => {
    if (clearKeySignal > 0) controller.clearTypedKey();
  }, [clearKeySignal, controller]);

  return (
    <SessionKeyPanelView
      sessionByokSupported={sessionByokSupported}
      providers={providers}
      selectedProviderId={state.selectedProviderId}
      selectedModelId={state.selectedModelId}
      apiKey={state.apiKey}
      status={state.status}
      expiresAt={state.expiresAt}
      saveState={state.saveState}
      revokeState={state.revokeState}
      testState={state.testState}
      testResult={state.testResult}
      notice={state.notice}
      onSelectProvider={(id) => controller.selectProvider(id)}
      onSelectModel={(id) => controller.selectModel(id)}
      onChangeApiKey={(v) => controller.setApiKey(v)}
      onSave={() => void controller.save()}
      onRevoke={() => void controller.revoke()}
      onTest={() => void controller.test()}
    />
  );
}
