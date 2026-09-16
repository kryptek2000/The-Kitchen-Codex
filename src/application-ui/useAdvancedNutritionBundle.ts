/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: lazy-load React controller.
 *
 * Owns the ONE in-memory Advanced Nutrition bundle load for the application
 * page. It never loads at startup: a load begins only when `load()` is invoked
 * by an explicit user action. Concurrent `load()` calls share one in-flight
 * request, only one session is ever installed, and a result from a superseded
 * request or an unmounted owner is ignored (no stale installs).
 *
 * The session lives in memory only for the lifetime of the page. Nothing is
 * persisted (no IndexedDB / localStorage / Cache Storage / service worker /
 * vault / settings / Markdown).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4';
import type { RuntimeBundleResult } from '../core/nutritionV2/runtime';

export type AdvancedNutritionBundleStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'unsupported';

export interface AdvancedNutritionBundleView {
  readonly status: AdvancedNutritionBundleStatus;
  readonly session: AdvancedNutritionSession | null;
  /** Fixed, bounded failure code (never a raw error message). */
  readonly failureCode: string | null;
  readonly load: () => void;
}

interface BundleState {
  readonly status: AdvancedNutritionBundleStatus;
  readonly session: AdvancedNutritionSession | null;
  readonly failureCode: string | null;
}

const IDLE_STATE: BundleState = { status: 'idle', session: null, failureCode: null };

export function useAdvancedNutritionBundle(
  loader: () => Promise<RuntimeBundleResult>
): AdvancedNutritionBundleView {
  const [state, setState] = useState<BundleState>(IDLE_STATE);
  const inFlight = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (inFlight.current) return;
    const gen = generation.current + 1;
    generation.current = gen;
    setState({ status: 'loading', session: null, failureCode: null });

    const promise: Promise<void> = loader()
      .then((result) => {
        if (gen !== generation.current || !mounted.current) return;
        if (result.ok) {
          setState({ status: 'ready', session: result.session, failureCode: null });
          return;
        }
        const failure = (result as { readonly failure: { readonly code: string } }).failure;
        setState({
          status: failure.code === 'unsupported_runtime' ? 'unsupported' : 'failed',
          session: null,
          failureCode: failure.code,
        });
      })
      .catch(() => {
        if (gen !== generation.current || !mounted.current) return;
        setState({ status: 'failed', session: null, failureCode: 'validation_error' });
      })
      .finally(() => {
        if (inFlight.current === promise) inFlight.current = null;
      });

    inFlight.current = promise;
  }, [loader]);

  return {
    status: state.status,
    session: state.session,
    failureCode: state.failureCode,
    load,
  };
}
