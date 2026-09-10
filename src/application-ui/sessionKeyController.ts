/**
 * The Kitchen Codex — Session Credentials controller (BYOK-5E).
 *
 * Platform-neutral, DOM-free state machine behind the SessionKeyPanel. It owns
 * the async orchestration (status / save / revoke / test) with STRICT ordering:
 *
 *   - PROVIDER GENERATION: bumped on provider switch + dispose. A completion is
 *     ignored unless the provider generation + providerId still match (closes
 *     cross-provider staleness and the A -> B -> A case).
 *   - OPERATION EPOCH: a monotonic counter bumped at the START of every
 *     state-affecting operation (refreshStatus / save / revoke / test) and on
 *     provider switch + dispose. A completion may update state ONLY while its
 *     captured epoch is still the current one, so NEWER USER INTENT ALWAYS WINS:
 *       save -> revoke  : the revoke supersedes the save.
 *       test -> revoke  : the revoke supersedes the test result.
 *       save#1 -> save#2: save#1 cannot clear save#2's key or state.
 *       refresh#1 -> refresh#2: refresh#1 cannot overwrite refresh#2.
 *       VERSION_CONFLICT refresh -> newer op: the newer op wins.
 *   - BUSY-STATE LIFECYCLE: each operation start resets the transient busy/result
 *     fields (its own busy flag is then set), so a stale completion can never
 *     clear a newer busy state nor restore a stale one.
 *
 * VERSION ISOLATION:
 *   - The opaque rotation version is stored WITH its providerId and is applied
 *     only after the operation epoch check passes; a stale status can never
 *     resurrect an obsolete version. It is never persisted.
 *
 * SECRET HYGIENE:
 *   - The typed key lives only in this in-memory state; it is cleared after a
 *     successful save, on revoke, on provider switch, on credential-source switch
 *     (`clearTypedKey`), and on dispose. It is never cached module-globally.
 */

import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import {
  fetchSessionKeyStatus,
  revokeSessionKey,
  saveSessionKey,
  testProviderConnection,
  type ConnectionTestView,
  type ProviderKind,
} from './sessionKey';

export interface SessionKeyProviderOption {
  providerId: string;
  name: string;
  kind: ProviderKind;
  models: { id: string; default: boolean }[];
}

export type SessionKeyStatusState = 'loading' | 'unavailable' | 'not-configured' | 'configured' | 'error';
export interface SessionKeyNotice {
  kind: 'error' | 'success';
  text: string;
}

export interface SessionKeyState {
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
}

/** The non-secret status patch + version produced by a status read. */
interface StatusRead {
  patch: Partial<SessionKeyState>;
  version: string | null;
}

function defaultModelFor(providers: SessionKeyProviderOption[], providerId: string): string {
  const provider = providers.find((p) => p.providerId === providerId);
  if (!provider || provider.models.length === 0) return '';
  return provider.models.find((m) => m.default)?.id ?? provider.models[0].id;
}

export class SessionKeyController {
  private state: SessionKeyState;
  private readonly listeners = new Set<() => void>();
  /** Provider identity generation; bumped on provider switch + dispose. */
  private generation = 0;
  /** Monotonic operation epoch; bumped at every operation start + switch + dispose. */
  private operationEpoch = 0;
  private disposed = false;
  /** The rotation version WITH the exact provider it belongs to (never shared). */
  private version: { providerId: string; version: string } | null = null;

  constructor(
    private readonly network: NetworkAdapter,
    private readonly providers: SessionKeyProviderOption[]
  ) {
    const first = providers[0]?.providerId ?? '';
    this.state = {
      selectedProviderId: first,
      selectedModelId: defaultModelFor(providers, first),
      apiKey: '',
      status: 'loading',
      saveState: 'idle',
      revokeState: 'idle',
      testState: 'idle',
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SessionKeyState => this.state;

  private setState(patch: Partial<SessionKeyState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Begins a state-affecting operation: bumps the operation epoch, resets the
   * transient busy/result fields, applies the operation's own patch, and returns
   * the new epoch. A later operation bumps the epoch again and supersedes this one.
   */
  private beginOperation(patch: Partial<SessionKeyState>): number {
    this.operationEpoch += 1;
    this.setState({
      saveState: 'idle',
      revokeState: 'idle',
      testState: 'idle',
      testResult: undefined,
      notice: undefined,
      ...patch,
    });
    return this.operationEpoch;
  }

  /**
   * True only when a completion still belongs to the active provider, its
   * generation, AND the current operation epoch.
   */
  private isCurrentOp(epoch: number, generation: number, providerId: string): boolean {
    return (
      !this.disposed &&
      epoch === this.operationEpoch &&
      generation === this.generation &&
      providerId === this.state.selectedProviderId
    );
  }

  /** Reads status WITHOUT mutating version/state (caller applies after epoch check). */
  private async readStatus(providerId: string): Promise<StatusRead> {
    const res = await fetchSessionKeyStatus(this.network);
    if (res.ok === false) {
      return { patch: { status: res.status === 503 ? 'unavailable' : 'error', expiresAt: undefined }, version: null };
    }
    const row = res.providers.find((p) => p.providerId === providerId);
    if (row && row.configured) {
      return { patch: { status: 'configured', expiresAt: row.expiresAt }, version: row.version ?? null };
    }
    return { patch: { status: 'not-configured', expiresAt: undefined }, version: null };
  }

  selectProvider(providerId: string): void {
    if (!providerId || providerId === this.state.selectedProviderId) return;
    // Invalidate ALL in-flight work (generation + epoch); reset version +
    // transient state; clear any typed key so it cannot leak across providers.
    this.generation += 1;
    this.operationEpoch += 1;
    this.version = null;
    this.setState({
      selectedProviderId: providerId,
      selectedModelId: defaultModelFor(this.providers, providerId),
      apiKey: '',
      status: 'loading',
      expiresAt: undefined,
      saveState: 'idle',
      revokeState: 'idle',
      testState: 'idle',
      testResult: undefined,
      notice: undefined,
    });
    void this.refreshStatus();
  }

  selectModel(modelId: string): void {
    this.setState({ selectedModelId: modelId });
  }

  setApiKey(value: string): void {
    this.setState({ apiKey: value });
  }

  /**
   * Clears the typed key + session-specific transient state WITHOUT touching the
   * server-side stored key. Used when the credential source switches away from
   * session_only (and by the component on unmount).
   */
  clearTypedKey(): void {
    if (!this.state.apiKey && !this.state.testResult && !this.state.notice) return;
    this.setState({ apiKey: '', testResult: undefined, notice: undefined });
  }

  /** Fetches status for the active provider (provider + epoch bound). */
  async refreshStatus(): Promise<void> {
    const generation = this.generation;
    const providerId = this.state.selectedProviderId;
    if (!providerId) return;
    const epoch = this.beginOperation({ status: 'loading' });
    const result = await this.readStatus(providerId);
    if (!this.isCurrentOp(epoch, generation, providerId)) return;
    this.version = result.version ? { providerId, version: result.version } : null;
    this.setState(result.patch);
  }

  /** Saves/rotates the active provider's session key. */
  async save(): Promise<void> {
    const generation = this.generation;
    const providerId = this.state.selectedProviderId;
    const apiKey = this.state.apiKey;
    if (!providerId || !apiKey.trim()) return;
    const epoch = this.beginOperation({ saveState: 'saving' });
    const expectedVersion =
      this.version && this.version.providerId === providerId ? this.version.version : undefined;
    const res = await saveSessionKey(this.network, providerId, apiKey, expectedVersion);
    // STALE completion: never clear a (possibly newer) key or mutate state.
    if (!this.isCurrentOp(epoch, generation, providerId)) return;
    if (res.ok) {
      const status = await this.readStatus(providerId);
      if (!this.isCurrentOp(epoch, generation, providerId)) return;
      this.version = status.version ? { providerId, version: status.version } : null;
      this.setState({
        ...status.patch,
        apiKey: '',
        saveState: 'idle',
        notice: { kind: 'success', text: 'Session key saved. It is stored only in server memory.' },
      });
      return;
    }
    if (res.code === 'VERSION_CONFLICT') {
      const status = await this.readStatus(providerId);
      if (!this.isCurrentOp(epoch, generation, providerId)) return;
      this.version = status.version ? { providerId, version: status.version } : null;
      this.setState({
        ...status.patch,
        saveState: 'idle',
        notice: { kind: 'error', text: 'The session key changed. Refresh the status and try again.' },
      });
      return;
    }
    // A failed (non-conflict) save keeps the typed key for explicit retry.
    this.setState({
      saveState: 'idle',
      notice: { kind: 'error', text: res.message ?? 'Could not save the session key.' },
    });
  }

  /** Revokes the active provider's session key. */
  async revoke(): Promise<void> {
    const generation = this.generation;
    const providerId = this.state.selectedProviderId;
    if (!providerId) return;
    const epoch = this.beginOperation({ revokeState: 'revoking' });
    const res = await revokeSessionKey(this.network, providerId);
    if (!this.isCurrentOp(epoch, generation, providerId)) return;
    // Revoke always clears the typed key + result, and NEVER switches source.
    const status = await this.readStatus(providerId);
    if (!this.isCurrentOp(epoch, generation, providerId)) return;
    this.version = status.version ? { providerId, version: status.version } : null;
    this.setState({
      ...status.patch,
      apiKey: '',
      testResult: undefined,
      revokeState: 'idle',
      notice: res.ok
        ? { kind: 'success', text: 'Session key revoked.' }
        : { kind: 'error', text: res.message ?? 'Could not revoke the session key.' },
    });
  }

  /** Runs an explicit session-credential connection test for the active provider. */
  async test(): Promise<void> {
    const generation = this.generation;
    const provider = this.providers.find((p) => p.providerId === this.state.selectedProviderId);
    if (!provider) return;
    const providerId = provider.providerId;
    const epoch = this.beginOperation({ testState: 'testing' });
    const res = await testProviderConnection(this.network, {
      providerId,
      kind: provider.kind,
      modelId: this.state.selectedModelId || undefined,
      credentialSource: 'session_only',
    });
    if (!this.isCurrentOp(epoch, generation, providerId)) return;
    this.setState({ testState: 'idle', testResult: res });
  }

  /** Invalidates in-flight work and clears the typed key (unmount safety). */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.operationEpoch += 1;
    this.state = { ...this.state, apiKey: '', testResult: undefined, notice: undefined };
    this.listeners.clear();
  }
}
