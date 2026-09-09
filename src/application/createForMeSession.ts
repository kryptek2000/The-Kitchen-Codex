/**
 * The Kitchen Codex — Create for Me modal session liveness (v0.7 Phase 2A correction 3).
 *
 * Guards against a late async completion repopulating modal state after the modal
 * session has been closed/discarded (or a new session opened). A Create-for-Me
 * session is invalidated when the modal opens, closes, or is discarded; any async
 * generation/save result that finishes AFTER its session was invalidated is
 * DROPPED (no dispatch), even though the underlying network request may still
 * complete and may cost money (it is NOT aborted).
 *
 * TRUTHFUL WORDING: the result is IGNORED after session invalidation; the provider
 * request is not cancelled. This is expected for Phase 2A (no AbortController).
 *
 * This is the exact helper the modal uses, so the production liveness logic is
 * testable without React/DOM.
 */

export interface CreateForMeSession {
  /** Current session epoch (advances on open/close/discard). */
  current(): number;
  /** Invalidates the session (drops in-flight results) and clears the busy guard. */
  advance(): void;
  /** True only when `epoch` is still the active session epoch. */
  isCurrent(epoch: number): boolean;
  /** Captures the epoch at the start of an operation. */
  begin(): number;
  /** Local in-flight (save) guard — reset by advance(). */
  isBusy(): boolean;
  setBusy(busy: boolean): void;
}

/**
 * Creates a per-modal-session liveness epoch + busy guard. `advance()` both
 * invalidates every in-flight operation (making `isCurrent(old)` false) and resets
 * the local busy flag, so a reopened modal never inherits a stale `saving` state.
 */
export function createCreateForMeSession(): CreateForMeSession {
  let epoch = 0;
  let busy = false;
  return {
    current: () => epoch,
    advance: () => {
      epoch += 1;
      busy = false;
    },
    isCurrent: (e) => e === epoch,
    begin: () => epoch,
    isBusy: () => busy,
    setBusy: (b) => {
      busy = b;
    },
  };
}

/**
 * Runs an async operation and calls `onResolved`/`onRejected` ONLY if the session
 * that started the operation is still current. If the session was invalidated
 * (close/discard/new session), the result is DROPPED (no callback, no state
 * mutation). The underlying request is not aborted.
 */
export async function runGuarded<T>(
  session: CreateForMeSession,
  operation: () => Promise<T>,
  onResolved: (value: T) => void,
  onRejected: (error: unknown) => void
): Promise<void> {
  const epoch = session.begin();
  try {
    const value = await operation();
    if (session.isCurrent(epoch)) onResolved(value);
  } catch (error) {
    if (session.isCurrent(epoch)) onRejected(error);
  }
}
