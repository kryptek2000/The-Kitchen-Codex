import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createVoiceCache } from '../../src/application/voiceCache';
import type { VoiceCacheService } from '../../src/application/voiceCache';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';

type Pending = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  aborted: boolean;
};

let voiceService: VoiceCacheService;
const calls: Array<{ url: string; init: any }> = [];
let pending: Pending[] = [];
let mode: 'defer' | 'ok' | 'fail' = 'defer';

function installFetchMock() {
  vi.stubGlobal('fetch', vi.fn((url: string, init: any) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/api/voice/prioritize')) {
      return Promise.resolve({ ok: true, json: async () => ({ found: true }) });
    }
    if (mode === 'fail') {
      return Promise.resolve({ ok: false, status: 500, blob: async () => new Blob([]) });
    }
    if (mode === 'ok') {
      return Promise.resolve({ ok: true, blob: async () => new Blob(['RIFF-ok']) });
    }
    return new Promise((resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      const entry: Pending = { resolve, reject, aborted: false };
      pending.push(entry);
      if (signal?.aborted) {
        entry.aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal?.addEventListener('abort', () => {
        entry.aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  }));
}

function speakCalls() {
  return calls.filter((call) => call.url.includes('/api/voice/speak'));
}

function resolvePending(blob = new Blob(['RIFF-deferred'])) {
  for (const entry of pending) {
    if (!entry.aborted) entry.resolve({ ok: true, blob: async () => blob });
  }
  pending = [];
}

function createMockNetworkAdapter(): NetworkAdapter {
  const fetchFn = (url: string, init?: any) => (globalThis as any).fetch(url, init);
  return {
    request: async (request: any) => {
      const res = await fetchFn(request.path, {
        method: request.method,
        headers: request.headers,
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        signal: request.signal,
      });
      let data: unknown = undefined;
      try { data = await res.json(); } catch { data = undefined; }
      return { status: res.status, ok: res.ok, data };
    },
    get: async (path: string, options?: any) => {
      const res = await fetchFn(path, { method: 'GET', headers: options?.headers, signal: options?.signal });
      let data: unknown = undefined;
      try { data = await res.json(); } catch { data = undefined; }
      return { status: res.status, ok: res.ok, data };
    },
    post: async (path: string, body: any, options?: any) => {
      const res = await fetchFn(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      let data: unknown = undefined;
      try { data = await res.json(); } catch { data = undefined; }
      return { status: res.status, ok: res.ok, data };
    },
    getBytes: async (path: string, options?: any) => {
      const res = await fetchFn(path, { method: 'GET', headers: options?.headers, signal: options?.signal });
      const blob = await res.blob();
      const buffer = await blob.arrayBuffer();
      return { status: res.status, ok: res.ok, bytes: new Uint8Array(buffer), contentType: res.headers?.get?.('content-type') || undefined };
    },
    postBytes: async (path: string, body: any, options?: any) => {
      const res = await fetchFn(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      const blob = await res.blob();
      const buffer = await blob.arrayBuffer();
      return { status: res.status, ok: res.ok, bytes: new Uint8Array(buffer), contentType: res.headers?.get?.('content-type') || undefined };
    },
  } as NetworkAdapter;
}

beforeEach(() => {
  calls.length = 0;
  pending = [];
  mode = 'defer';
  installFetchMock();
  voiceService = createVoiceCache(createMockNetworkAdapter());
});

afterEach(() => {
  voiceService.clearVoiceCache();
  voiceService.clearCookingVoiceFocus();
  voiceService.dispose();
  vi.unstubAllGlobals();
});

describe('voice cache instance isolation', () => {
  it('does not share cached clips across instances', () => {
    const a = createVoiceCache(null);
    const b = createVoiceCache(null);
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    a.setCachedVoiceClip(recipe as any, 0, blob);
    expect(a.getCachedVoiceClip(recipe as any, 0)).toBe(blob);
    expect(b.getCachedVoiceClip(recipe as any, 0)).toBeUndefined();
    a.dispose();
    b.dispose();
  });

  it('does not share in-flight preparations across instances', async () => {
    const adapterA = {
      postBytes: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/wav' })),
      post: vi.fn(),
    } as any;
    const adapterB = {
      postBytes: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([4, 5, 6]), contentType: 'audio/wav' })),
      post: vi.fn(),
    } as any;
    const a = createVoiceCache(adapterA);
    const b = createVoiceCache(adapterB);
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const [ra, rb] = await Promise.all([
      a.prepareVoiceClip(recipe, 0),
      b.prepareVoiceClip(recipe, 0),
    ]);
    expect(ra).toBeTruthy();
    expect(rb).toBeTruthy();
    expect(adapterA.postBytes).toHaveBeenCalledTimes(1);
    expect(adapterB.postBytes).toHaveBeenCalledTimes(1);
    a.dispose();
    b.dispose();
  });

  it('fails safely after disposal', async () => {
    const adapter = {
      postBytes: vi.fn(async () => ({ ok: true, bytes: new Uint8Array([1]), contentType: 'audio/wav' })),
      post: vi.fn(),
    } as any;
    const service = createVoiceCache(adapter);
    service.dispose();
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    await expect(service.prepareVoiceClip(recipe, 0)).resolves.toBeNull();
    expect(adapter.postBytes).not.toHaveBeenCalled();
    service.dispose();
  });
});

afterEach(() => {
  voiceService.clearVoiceCache();
  voiceService.clearCookingVoiceFocus();
  vi.unstubAllGlobals();
});

describe('shared voice cache', () => {
  it('creates distinct keys per recipe and step', () => {
    const a = { id: 'a.md', instructions: [{ text: 'Mix.' }] };
    const b = { id: 'b.md', instructions: [{ text: 'Mix.' }] };
    expect(voiceService.voiceClipKey(a as any, 0)).not.toBe(voiceService.voiceClipKey(b as any, 0));
    expect(voiceService.voiceClipKey(a as any, 0)).not.toBe(voiceService.voiceClipKey(a as any, 1));
  });

  it('stores and retrieves clips', () => {
    const r = { id: 'r.md', instructions: [{ text: 'Cook.' }] };
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    voiceService.setCachedVoiceClip(r as any, 0, blob);
    expect(voiceService.getCachedVoiceClip(r as any, 0)).toBe(blob);
  });

  it('invalidates by instruction text', () => {
    const r1 = { id: 'r.md', instructions: [{ text: 'Cook.' }] };
    const r2 = { id: 'r.md', instructions: [{ text: 'Bake.' }] };
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    voiceService.setCachedVoiceClip(r1 as any, 0, blob);
    expect(voiceService.getCachedVoiceClip(r2 as any, 0)).toBeUndefined();
  });

  it('deduplicates concurrent same-step requests', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const a = voiceService.prepareVoiceClip(recipe, 0);
    const b = voiceService.prepareVoiceClip(recipe, 0);
    await Promise.resolve();
    expect(speakCalls()).toHaveLength(1);
    resolvePending();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(voiceService.getCachedVoiceClip(recipe, 0)).toBeTruthy();
  });

  it('serves a completed clip without a second native request', async () => {
    mode = 'ok';
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    await voiceService.prepareVoiceClip(recipe, 0);
    await voiceService.prepareVoiceClip(recipe, 0);
    expect(speakCalls()).toHaveLength(1);
  });

  it('keeps another consumer alive when one consumer aborts', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const controllerA = new AbortController();
    const a = voiceService.prepareVoiceClip(recipe, 0, { signal: controllerA.signal });
    const b = voiceService.prepareVoiceClip(recipe, 0);
    await Promise.resolve();
    controllerA.abort();
    expect(pending[0]?.aborted).toBe(false);
    resolvePending();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBeTruthy();
    expect(rb).toBeTruthy();
    expect(speakCalls()).toHaveLength(1);
  });

  it('aborts the native request when the final consumer aborts and allows a retry', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const a = new AbortController();
    const b = new AbortController();
    const pa = voiceService.prepareVoiceClip(recipe, 0, { signal: a.signal });
    const pb = voiceService.prepareVoiceClip(recipe, 0, { signal: b.signal });
    await Promise.resolve();
    a.abort();
    b.abort();
    expect(pending[0]?.aborted).toBe(true);
    await expect(pa).resolves.toBeNull();
    await expect(pb).resolves.toBeNull();
    expect(voiceService.getCachedVoiceClip(recipe, 0)).toBeUndefined();

    mode = 'ok';
    await expect(voiceService.prepareVoiceClip(recipe, 0)).resolves.toBeTruthy();
    expect(speakCalls()).toHaveLength(2);
  });

  it('recovers after a failed preparation', async () => {
    mode = 'fail';
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    await expect(voiceService.prepareVoiceClip(recipe, 0)).resolves.toBeNull();
    mode = 'ok';
    await expect(voiceService.prepareVoiceClip(recipe, 0)).resolves.toBeTruthy();
    expect(speakCalls()).toHaveLength(2);
  });

  it('promotes a foreground join of an existing background preparation', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const background = voiceService.prepareVoiceClip(recipe, 0, { kind: 'prepare', purpose: 'cooking' });
    await Promise.resolve();
    const foreground = voiceService.prepareVoiceClip(recipe, 0, { kind: 'foreground', purpose: 'cooking' });
    await Promise.resolve();
    const promote = calls.find((call) => call.url.includes('/api/voice/prioritize'));
    expect(promote).toBeTruthy();
    expect(String(promote?.init?.body)).toContain('voice-prep-');
    expect(speakCalls()).toHaveLength(1);
    resolvePending();
    await Promise.all([background, foreground]);
  });

  it('cancels obsolete Detail preparation when Cooking Mode focuses a later step', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'One.' }, { text: 'Two.' }, { text: 'Eight.' }] };
    const detailPrep = voiceService.prepareVoiceClip(recipe, 0, { purpose: 'detail' });
    await Promise.resolve();
    voiceService.setCookingVoiceFocus(recipe, 2);
    expect(voiceService.isCookingVoiceFocusActive(recipe)).toBe(true);
    expect(pending[0]?.aborted).toBe(true);
    await expect(detailPrep).resolves.toBeNull();
    voiceService.clearCookingVoiceFocus(recipe);
    expect(voiceService.isCookingVoiceFocusActive(recipe)).toBe(false);
  });

  it('does not cancel a current-step preparation during the Detail-to-Cooking handoff', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'One.' }] };
    const detailController = new AbortController();
    const detailPrep = voiceService.prepareVoiceClip(recipe, 0, { signal: detailController.signal, purpose: 'detail' });
    await Promise.resolve();
    voiceService.setCookingVoiceFocus(recipe, 0);
    detailController.abort();
    expect(pending[0]?.aborted).toBe(false);

    const foreground = voiceService.prepareVoiceClip(recipe, 0, { kind: 'foreground', purpose: 'cooking' });
    await Promise.resolve();
    expect(speakCalls()).toHaveLength(1);
    resolvePending();
    await Promise.allSettled([detailPrep, foreground]);
  });

  it('keeps the focused current-step preparation alive', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'One.' }, { text: 'Two.' }] };
    const current = voiceService.prepareVoiceClip(recipe, 1, { purpose: 'detail' });
    await Promise.resolve();
    voiceService.setCookingVoiceFocus(recipe, 1);
    expect(pending[0]?.aborted).toBe(false);
    resolvePending();
    await expect(current).resolves.toBeTruthy();
  });

  it('does not start new Detail preparation while Cooking Mode owns the recipe', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'One.' }] };
    voiceService.setCookingVoiceFocus(recipe, 0);
    await expect(voiceService.prepareVoiceClip(recipe, 0, { purpose: 'detail' })).resolves.toBeNull();
    expect(speakCalls()).toHaveLength(0);
  });

  it('keeps P2 when P1 completes late after abort (P1/P2/P3 race)', async () => {
    // Deterministic: deferred promises with controlled completion ordering,
    // no sleeps. P1 ignores abort and completes late; P2 must remain.
    let nextResolve: ((value: any) => void) | null = null;
    let callCount = 0;
    const adapter: any = {
      postBytes: vi.fn(() => {
        callCount += 1;
        return new Promise((resolve) => {
          nextResolve = resolve as (value: any) => void;
        });
      }),
      post: vi.fn(async () => ({ ok: true, data: {} })),
    };
    const service = createVoiceCache(adapter);
    const recipe = { id: 'race.md', instructions: [{ text: 'Mix.' }] };

    // P1 starts (call #1)
    const c1 = new AbortController();
    const p1 = service.prepareVoiceClip(recipe, 0, { signal: c1.signal });
    await Promise.resolve();
    expect(adapter.postBytes).toHaveBeenCalledTimes(1);
    const resolveP1 = nextResolve!;
    expect(nextResolve).not.toBeNull();

    // P1 loses its final consumer (abort). The map entry for P1 is deleted.
    c1.abort();
    await Promise.resolve();

    // P2 starts for the same key (call #2)
    const p2 = service.prepareVoiceClip(recipe, 0);
    await Promise.resolve();
    expect(adapter.postBytes).toHaveBeenCalledTimes(2);
    const resolveP2 = nextResolve!;
    expect(nextResolve).not.toBeNull();

    // P1 completes late, ignoring the abort signal. It must NOT delete P2,
    // overwrite P2, or repopulate the cache with obsolete state.
    resolveP1!({ ok: true, bytes: new Uint8Array([1]), contentType: 'audio/wav' });
    await expect(p1).resolves.toBeNull();

    // Third consumer joins P2 (still active) — no third network request.
    const p3Join = service.prepareVoiceClip(recipe, 0);
    await Promise.resolve();
    expect(adapter.postBytes).toHaveBeenCalledTimes(2);
    expect(callCount).toBe(2);

    // P2 completes; both P2 and the joining consumer receive the clip.
    resolveP2!({ ok: true, bytes: new Uint8Array([2]), contentType: 'audio/wav' });
    const [b2, b3] = await Promise.all([p2, p3Join]);
    expect(b2).toBeTruthy();
    expect(b3).toBe(b2);
    expect(service.getCachedVoiceClip(recipe as any, 0)).toBe(b2);
    service.dispose();
  });
});

describe('voice cache stale completion ownership', () => {
  it('does not let an aborted preparation delete its replacement', async () => {
    const pending: Array<{ resolve: (value: any) => void; reject: (reason?: any) => void; aborted: boolean }> = [];
    const adapter = {
      postBytes: vi.fn((_path: string, _body: any, options: any) => new Promise((resolve, reject) => {
        const entry = { resolve, reject, aborted: false };
        pending.push(entry);
        const signal = options?.signal as AbortSignal | undefined;
        const abort = () => {
          entry.aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      })),
      post: vi.fn(async () => ({ ok: true, data: {} })),
    } as any;
    const service = createVoiceCache(adapter);
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };

    const first = service.prepareVoiceClip(recipe as any, 0);
    await Promise.resolve();
    expect(adapter.postBytes).toHaveBeenCalledTimes(1);

    service.clearVoiceCache();
    await Promise.resolve();
    await Promise.resolve();

    const second = service.prepareVoiceClip(recipe as any, 0);
    await Promise.resolve();
    expect(adapter.postBytes).toHaveBeenCalledTimes(2);

    const late = pending[0];
    if (!late.aborted) {
      late.resolve({ ok: true, bytes: new Uint8Array([1]), contentType: 'audio/wav' });
    }
    await Promise.resolve();
    await Promise.resolve();

    const third = service.prepareVoiceClip(recipe as any, 0);
    await Promise.resolve();
    expect(adapter.postBytes).toHaveBeenCalledTimes(2);

    pending[1]?.resolve({ ok: true, bytes: new Uint8Array([2]), contentType: 'audio/wav' });
    await expect(second).resolves.toBeTruthy();
    await expect(third).resolves.toBeTruthy();
    service.dispose();
  });
});