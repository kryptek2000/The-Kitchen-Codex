// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import React, { useEffect, useMemo, useRef } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { createVoiceCache } from '../../src/application/voiceCache';
import type { VoiceCacheService } from '../../src/application/voiceCache';

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

function makeDeferredNetwork() {
  const calls: Array<{ path: string; body: any; signal?: AbortSignal }> = [];
  let resolveNext: ((value: any) => void) | null = null;
  let rejectNext: ((value: any) => void) | null = null;
  const adapter: any = {
    postBytes: vi.fn((p: string, body: any, options: any) => {
      calls.push({ path: p, body, signal: options?.signal });
      return new Promise((resolve, reject) => {
        resolveNext = resolve as (value: any) => void;
        rejectNext = reject;
        const signal = options?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          rejectNext = null;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => {
          rejectNext = null;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }),
    post: vi.fn(async () => ({ ok: true, data: {} })),
    get: vi.fn(async () => ({ ok: true, data: {} })),
    request: vi.fn(async () => ({ status: 200, ok: true, data: {} })),
    getBytes: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1]), contentType: 'audio/wav' })),
  };
  return {
    adapter,
    calls,
    resolve: (bytes = new Uint8Array([9])) => {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r?.({ ok: true, bytes, contentType: 'audio/wav' });
    },
    hasPending: () => resolveNext !== null,
  };
}

// Host mirrors App.tsx voice-service ownership EXACTLY (see src/App.tsx
// voiceMountedRef / voiceDisposalTimerRef / prevVoiceServiceRef effect).
// Static tests below assert App.tsx contains this same ownership contract.
function TestHost({ network, expose }: { network: any; expose: (s: VoiceCacheService) => void }) {
  const voiceService = useMemo(() => createVoiceCache(network), [network]);
  const voiceMountedRef = useRef(false);
  const voiceDisposalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevVoiceServiceRef = useRef<VoiceCacheService | null>(null);
  useEffect(() => {
    voiceMountedRef.current = true;
    if (voiceDisposalTimerRef.current) {
      clearTimeout(voiceDisposalTimerRef.current);
      voiceDisposalTimerRef.current = null;
    }
    const prev = prevVoiceServiceRef.current;
    if (prev && prev !== voiceService) {
      try { prev.dispose(); } catch {}
    }
    prevVoiceServiceRef.current = voiceService;
    expose(voiceService);
    return () => {
      voiceMountedRef.current = false;
      if (voiceDisposalTimerRef.current) clearTimeout(voiceDisposalTimerRef.current);
      const serviceToDispose = voiceService;
      voiceDisposalTimerRef.current = setTimeout(() => {
        voiceDisposalTimerRef.current = null;
        if (!voiceMountedRef.current) {
          try { serviceToDispose.dispose(); } catch {}
        }
      }, 0);
    };
  }, [voiceService]);
  return <div data-testid="host">host</div>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const recipe = { id: 'app.md', instructions: [{ text: 'Mix.' }] };

describe('App voice service ownership lifecycle', () => {
  it('disposes on genuine unmount and aborts active work', async () => {
    vi.useFakeTimers();
    const net = makeDeferredNetwork();
    let service: VoiceCacheService | null = null;
    const { unmount } = render(<TestHost network={net.adapter} expose={(s) => { service = s; }} />);
    const svc = service as unknown as VoiceCacheService;
    expect(svc.isDisposed()).toBe(false);
    const pending = svc.prepareVoiceClip(recipe as any, 0);
    await act(async () => { await Promise.resolve(); });
    expect(net.adapter.postBytes).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { vi.runAllTimers(); });
    expect(svc.isDisposed()).toBe(true);
    expect(net.calls[0]?.signal?.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('preserves the same usable service across ordinary rerenders', async () => {
    const net = makeDeferredNetwork();
    const services: VoiceCacheService[] = [];
    const { rerender } = render(<TestHost network={net.adapter} expose={(s) => { services.push(s); }} />);
    const first = services[0] as unknown as VoiceCacheService;
    rerender(<TestHost network={net.adapter} expose={(s) => { services.push(s); }} />);
    rerender(<TestHost network={net.adapter} expose={(s) => { services.push(s); }} />);
    expect(first.isDisposed()).toBe(false);
    // Rerender must not create a new service instance.
    const unique = new Set(services as any);
    expect(unique.size).toBe(1);
    net.resolve();
    // Start and complete work on the preserved service to prove usability.
    // (prepare was already not started; use a fresh prepare that completes.)
    const p = first.prepareVoiceClip(recipe as any, 0);
    await act(async () => { await Promise.resolve(); });
    net.resolve();
    await expect(p).resolves.toBeTruthy();
  });

  it('does not dispose the active service during StrictMode replay', async () => {
    vi.useFakeTimers();
    const net = makeDeferredNetwork();
    let service: VoiceCacheService | null = null;
    render(
      <React.StrictMode>
        <TestHost network={net.adapter} expose={(s) => { service = s; }} />
      </React.StrictMode>,
    );
    await act(async () => { vi.runAllTimers(); });
    const svc = service as unknown as VoiceCacheService;
    expect(svc.isDisposed()).toBe(false);
    const p = svc.prepareVoiceClip(recipe as any, 0);
    await act(async () => { await Promise.resolve(); });
    expect(net.adapter.postBytes).toHaveBeenCalledTimes(1);
    net.resolve();
    await expect(p).resolves.toBeTruthy();
    vi.useRealTimers();
  });

  it('remounts with a fresh usable service after unmount', async () => {
    vi.useFakeTimers();
    const net = makeDeferredNetwork();
    const services: VoiceCacheService[] = [];
    const first = render(<TestHost network={net.adapter} expose={(s) => { services.push(s); }} />);
    const oldService = services[0] as unknown as VoiceCacheService;
    first.unmount();
    await act(async () => { vi.runAllTimers(); });
    expect(oldService.isDisposed()).toBe(true);

    render(<TestHost network={net.adapter} expose={(s) => { services.push(s); }} />);
    await act(async () => { vi.runAllTimers(); });
    const newService = services[services.length - 1] as unknown as VoiceCacheService;
    expect(newService).not.toBe(oldService);
    expect(newService.isDisposed()).toBe(false);
    const p = newService.prepareVoiceClip(recipe as any, 0);
    await act(async () => { await Promise.resolve(); });
    net.resolve();
    await expect(p).resolves.toBeTruthy();
    vi.useRealTimers();
  });

  it('makes late completion after unmount harmless', async () => {
    vi.useFakeTimers();
    const net = makeDeferredNetwork();
    let service: VoiceCacheService | null = null;
    const { unmount } = render(<TestHost network={net.adapter} expose={(s) => { service = s; }} />);
    const svc = service as unknown as VoiceCacheService;
    const pending = svc.prepareVoiceClip(recipe as any, 0);
    await act(async () => { await Promise.resolve(); });
    unmount();
    await act(async () => { vi.runAllTimers(); });
    expect(svc.isDisposed()).toBe(true);
    // Network resolves late (ignoring abort). Must not repopulate disposed cache.
    net.resolve();
    await expect(pending).resolves.toBeNull();
    expect(svc.getCachedVoiceClip(recipe as any, 0)).toBeUndefined();
    vi.useRealTimers();
  });

  it('App.tsx contains the ownership disposal contract', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(source).toContain('voiceService');
    expect(source).toContain('serviceToDispose.dispose');
    expect(source).toContain('voiceDisposalTimerRef');
    expect(source).toContain('voiceMountedRef');
    expect(source).toContain('prevVoiceServiceRef');
    expect(source).toContain('useMemo(() => createVoiceCache(networkAdapter)');
    expect(source).toContain('useEffect(() => {');
  });
});
