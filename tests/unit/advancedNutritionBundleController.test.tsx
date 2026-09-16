// @vitest-environment jsdom
/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5B: lazy-load controller.
 *
 * Proves the ONE in-memory bundle load: no startup load, explicit-only loading,
 * shared in-flight requests, a single installed session, explicit retry, and no
 * stale installs across unmount/remount or StrictMode.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useAdvancedNutritionBundle } from '../../src/application-ui/useAdvancedNutritionBundle';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { RuntimeBundleResult } from '../../src/core/nutritionV2/runtime';

function fakeSession(): AdvancedNutritionSession {
  return {
    metadata: () => ({
      session_version: 'v',
      context_version: 'c',
      calculation_version: 'calc',
      bundle_release: 'usda_fdc_test',
      catalog_digest: 'd',
      nutrient_map_version: 'm',
      record_count: 1,
      data_types: ['foundation'],
    }),
  } as unknown as AdvancedNutritionSession;
}

function success(): RuntimeBundleResult {
  const session = fakeSession();
  return { ok: true, session, metadata: session.metadata(), attribution: 'attr' };
}

function failure(code: string): RuntimeBundleResult {
  return { ok: false, failure: { code, message: `msg_${code}` } as never };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => cleanup());

describe('phase 4.5B controller — lifecycle', () => {
  it('does not load at startup', () => {
    const loader = vi.fn(async () => success());
    const { result } = renderHook(() => useAdvancedNutritionBundle(loader));
    expect(result.current.status).toBe('idle');
    expect(result.current.session).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('one explicit load starts loading and installs one session', async () => {
    const loader = vi.fn(async () => success());
    const { result } = renderHook(() => useAdvancedNutritionBundle(loader));
    act(() => result.current.load());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.session).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('concurrent loads share one in-flight request', async () => {
    const pending = deferred<RuntimeBundleResult>();
    const loader = vi.fn(() => pending.promise);
    const { result } = renderHook(() => useAdvancedNutritionBundle(loader));
    act(() => {
      result.current.load();
      result.current.load();
      result.current.load();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(success());
      await pending.promise;
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a failed attempt installs no session and retry works', async () => {
    const loader = vi
      .fn<() => Promise<RuntimeBundleResult>>()
      .mockResolvedValueOnce(failure('artifact_digest_mismatch'))
      .mockResolvedValueOnce(success());
    const { result } = renderHook(() => useAdvancedNutritionBundle(loader));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.session).toBeNull();
    expect(result.current.failureCode).toBe('artifact_digest_mismatch');

    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.session).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('maps an unsupported runtime to the unsupported state', async () => {
    const loader = vi.fn(async () => failure('unsupported_runtime'));
    const { result } = renderHook(() => useAdvancedNutritionBundle(loader));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(result.current.session).toBeNull();
  });

  it('a rejected loader fails closed without a session', async () => {
    const loader = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useAdvancedNutritionBundle(loader));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.session).toBeNull();
    expect(result.current.failureCode).toBe('validation_error');
  });

  it('an unmounted owner cannot install a stale result', async () => {
    const pending = deferred<RuntimeBundleResult>();
    const loader = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() => useAdvancedNutritionBundle(loader));
    act(() => result.current.load());
    unmount();
    await act(async () => {
      pending.resolve(success());
      await pending.promise;
    });
    // No crash and no installed session on the discarded instance.
    expect(result.current.session).toBeNull();
  });

  it('StrictMode does not duplicate the load or session', async () => {
    const loader = vi.fn(async () => success());
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useAdvancedNutritionBundle(loader), { wrapper });
    act(() => result.current.load());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
