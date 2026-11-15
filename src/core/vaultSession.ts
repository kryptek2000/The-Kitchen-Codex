/**
 * The Kitchen Codex — Vault session authority (R2).
 *
 * ONE identity governs every Vault-scoped async operation. A session is not
 * inferred from a folder name or from adapter existence: it is a monotonically
 * issued identity that changes only when a transition is accepted.
 *
 * Invariants:
 *  - Results from a superseded session/transition are never accepted.
 *  - New writes cannot start while a transition is pending.
 *  - Already-started writes hold a lease; a transition waits for them to settle
 *    (bounded, so the UI cannot deadlock).
 *  - A scan is valid only for the session AND collection revision it began in.
 *  - A stale write/scan can never update a newer session's React state because
 *    callers check `isCurrent` before committing their results.
 *
 * This module is platform-neutral: no browser globals, no filesystem access.
 */

export type VaultSessionKind = 'starter' | 'filesystem' | 'uploaded';
export type VaultTransitionOrigin = 'user' | 'automatic' | 'shutdown';

export interface VaultSession {
  readonly id: number;
  readonly kind: VaultSessionKind;
  readonly writable: boolean;
}

export interface VaultTransition {
  readonly id: number;
  readonly targetKind: VaultSessionKind;
  readonly origin: VaultTransitionOrigin;
  /** Set when this transition is the committed form of a folder intent. */
  readonly collectionIntentId?: number;
  /** Automatic transitions abort if any user intent appeared after they began. */
  readonly userIntentEpochAtStart?: number;
}

/**
 * A folder-picker/drag-drop parse begins with an intent BEFORE its first await.
 * The newest intent owns ordering; a transition may only commit while its
 * intent is still the latest. A newer explicit user transition also invalidates
 * older intents.
 */
export interface VaultCollectionIntent {
  readonly id: number;
  readonly sessionId: number;
}

export interface VaultWriteLease {
  readonly session: VaultSession;
  release(): void;
}

export interface VaultScanToken {
  readonly sessionId: number;
  readonly revision: number;
}

export interface VaultTransitionResult {
  readonly accepted: boolean;
  readonly session?: VaultSession;
  /** True when all writes that belonged to the previous session settled. */
  readonly writesSettled: boolean;
}

export interface VaultTransitionOptions {
  /**
   * Maximum time to wait for already-started writes. A timed-out write is still
   * isolated to its old session; its completion is ignored by session checks.
   */
  readonly timeoutMs?: number;
}

export interface VaultSessionAuthority {
  current(): VaultSession;
  isCurrent(session: VaultSession | null | undefined): boolean;
  writesBlocked(): boolean;
  pendingTransition(): VaultTransition | null;
  /** Explicit user transition. Invalidates every older automatic/parse intent. */
  beginTransition(kind: VaultSessionKind): VaultTransition;
  /**
   * Automatic mount reconciliation. Returns null once ANY user intent exists
   * or another transition is pending; automatic activity may never supersede
   * explicit user selection.
   */
  beginAutomaticTransition(kind: VaultSessionKind): VaultTransition | null;
  /** Unmount-only barrier that always supersedes without changing user intent. */
  beginShutdownTransition(kind: VaultSessionKind): VaultTransition;
  /** Registers the latest folder-import intent before its first await. */
  beginCollectionIntent(): VaultCollectionIntent;
  isCollectionIntentCurrent(intent: VaultCollectionIntent | null | undefined): boolean;
  /** User transition authorized by an already-current collection intent. */
  beginCollectionTransition(
    intent: VaultCollectionIntent,
    kind: VaultSessionKind
  ): VaultTransition | null;
  /** Diagnostic/regression-test surface. */
  userIntentCount(): number;
  isTransitionCurrent(transition: VaultTransition | null | undefined): boolean;
  cancelTransition(transition: VaultTransition): boolean;
  commitTransition(
    transition: VaultTransition,
    apply: (session: VaultSession) => void,
    options?: VaultTransitionOptions
  ): Promise<VaultTransitionResult>;
  beginWrite(session?: VaultSession | null): VaultWriteLease | null;
  activeWriteCount(session?: VaultSession): number;
  waitForSessionWrites(session: VaultSession, timeoutMs?: number): Promise<boolean>;
  beginScan(session: VaultSession): VaultScanToken | null;
  isScanCurrent(token: VaultScanToken | null | undefined): boolean;
  markCollectionChanged(session: VaultSession): void;
  collectionRevision(session: VaultSession): number | null;
}

const DEFAULT_WRITE_SETTLE_TIMEOUT_MS = 15_000;

export function createVaultSessionAuthority(): VaultSessionAuthority {
  let nextSessionId = 1;
  let nextTransitionId = 1;
  let nextCollectionIntentId = 1;
  let latestCollectionIntentId = 0;
  let userIntentEpoch = 0;
  let currentSession: VaultSession = { id: nextSessionId++, kind: 'starter', writable: false };
  let activeTransition: VaultTransition | null = null;
  let collectionRevision = 0;
  const activeWrites = new Map<number, number>();
  const writeWaiters = new Map<number, Set<(settled: boolean) => void>>();

  const isCurrent = (session: VaultSession | null | undefined): boolean =>
    Boolean(session) && session!.id === currentSession.id;

  const resolveWaiters = (sessionId: number, settled: boolean) => {
    const waiters = writeWaiters.get(sessionId);
    if (!waiters) return;
    writeWaiters.delete(sessionId);
    for (const resolve of waiters) resolve(settled);
  };

  const waitForSessionWrites = (session: VaultSession, timeoutMs = DEFAULT_WRITE_SETTLE_TIMEOUT_MS): Promise<boolean> => {
    const count = activeWrites.get(session.id) ?? 0;
    if (count === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiters = writeWaiters.get(session.id) ?? new Set<(settled: boolean) => void>();
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) writeWaiters.delete(session.id);
        resolve(value);
      };
      waiters.add(finish);
      writeWaiters.set(session.id, waiters);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  };

  return {
    current: () => currentSession,
    isCurrent,
    writesBlocked: () => activeTransition !== null,
    pendingTransition: () => activeTransition,

    beginTransition(kind: VaultSessionKind): VaultTransition {
      // An explicit Vault selection is the strongest user intent. It
      // invalidates every pending folder parse and every automatic reconnect.
      userIntentEpoch += 1;
      latestCollectionIntentId = nextCollectionIntentId++;
      activeTransition = {
        id: nextTransitionId++,
        targetKind: kind,
        origin: 'user',
        userIntentEpochAtStart: userIntentEpoch,
      };
      return activeTransition;
    },

    beginAutomaticTransition(kind: VaultSessionKind): VaultTransition | null {
      // Automatic reconnect is a startup convenience, never an authority over
      // an explicit user choice or a folder parse that has already begun.
      if (userIntentEpoch > 0 || activeTransition !== null) return null;
      activeTransition = {
        id: nextTransitionId++,
        targetKind: kind,
        origin: 'automatic',
        userIntentEpochAtStart: userIntentEpoch,
      };
      return activeTransition;
    },

    beginShutdownTransition(kind: VaultSessionKind): VaultTransition {
      activeTransition = { id: nextTransitionId++, targetKind: kind, origin: 'shutdown' };
      return activeTransition;
    },

    beginCollectionIntent(): VaultCollectionIntent {
      const intent: VaultCollectionIntent = {
        id: nextCollectionIntentId++,
        sessionId: currentSession.id,
      };
      latestCollectionIntentId = intent.id;
      userIntentEpoch += 1;
      return intent;
    },

    isCollectionIntentCurrent(intent): boolean {
      return Boolean(intent) && intent!.id === latestCollectionIntentId;
    },

    beginCollectionTransition(intent, kind): VaultTransition | null {
      if (!intent || intent.id !== latestCollectionIntentId) return null;
      activeTransition = {
        id: nextTransitionId++,
        targetKind: kind,
        origin: 'user',
        collectionIntentId: intent.id,
        userIntentEpochAtStart: userIntentEpoch,
      };
      return activeTransition;
    },

    userIntentCount: () => userIntentEpoch,

    isTransitionCurrent: (transition) =>
      Boolean(transition) && activeTransition?.id === transition!.id,

    cancelTransition(transition: VaultTransition): boolean {
      if (activeTransition?.id !== transition.id) return false;
      activeTransition = null;
      return true;
    },

    async commitTransition(
      transition: VaultTransition,
      apply: (session: VaultSession) => void,
      options?: VaultTransitionOptions
    ): Promise<VaultTransitionResult> {
      const supersededByIntent = () =>
        (transition.collectionIntentId !== undefined &&
          transition.collectionIntentId !== latestCollectionIntentId) ||
        (transition.origin !== 'shutdown' &&
          transition.userIntentEpochAtStart !== userIntentEpoch);

      if (activeTransition?.id !== transition.id) {
        return { accepted: false, writesSettled: false };
      }
      if (supersededByIntent()) {
        activeTransition = null;
        return { accepted: false, writesSettled: false };
      }
      const previous = currentSession;
      const writesSettled = await waitForSessionWrites(
        previous,
        options?.timeoutMs ?? DEFAULT_WRITE_SETTLE_TIMEOUT_MS
      );
      if (activeTransition?.id !== transition.id) {
        return { accepted: false, writesSettled };
      }
      if (supersededByIntent()) {
        activeTransition = null;
        return { accepted: false, writesSettled };
      }

      const session: VaultSession = {
        id: nextSessionId++,
        kind: transition.targetKind,
        writable: transition.targetKind === 'filesystem',
      };
      // The new identity is installed BEFORE the synchronous apply so the
      // commit callback can verify it, while the pending transition still
      // blocks every new write. On failure the previous identity is restored.
      currentSession = session;
      try {
        apply(session);
      } catch (error) {
        currentSession = previous;
        if (activeTransition?.id === transition.id) activeTransition = null;
        throw error;
      }
      activeTransition = null;
      collectionRevision += 1;
      return { accepted: true, session, writesSettled };
    },

    beginWrite(session?: VaultSession | null): VaultWriteLease | null {
      if (!session || !isCurrent(session) || activeTransition !== null || !session.writable) {
        return null;
      }
      const id = session.id;
      activeWrites.set(id, (activeWrites.get(id) ?? 0) + 1);
      let released = false;
      return {
        session,
        release() {
          if (released) return;
          released = true;
          const remaining = (activeWrites.get(id) ?? 1) - 1;
          if (remaining <= 0) {
            activeWrites.delete(id);
            resolveWaiters(id, true);
          } else {
            activeWrites.set(id, remaining);
          }
        },
      };
    },

    activeWriteCount(session?: VaultSession): number {
      if (session) return activeWrites.get(session.id) ?? 0;
      let total = 0;
      for (const count of activeWrites.values()) total += count;
      return total;
    },

    waitForSessionWrites,

    beginScan(session: VaultSession): VaultScanToken | null {
      if (!isCurrent(session) || activeTransition !== null) return null;
      // Mutation/rescan boundary: a scan must not start while a write owns the
      // session. A scan that began earlier is invalidated by markCollectionChanged
      // when the write commits, so an older snapshot cannot become authoritative.
      if ((activeWrites.get(session.id) ?? 0) > 0) return null;
      return { sessionId: session.id, revision: collectionRevision };
    },

    isScanCurrent(token: VaultScanToken | null | undefined): boolean {
      return Boolean(token) && token!.sessionId === currentSession.id && token!.revision === collectionRevision;
    },

    markCollectionChanged(session: VaultSession): void {
      if (isCurrent(session)) collectionRevision += 1;
    },

    collectionRevision(session: VaultSession): number | null {
      return isCurrent(session) ? collectionRevision : null;
    },
  };
}
