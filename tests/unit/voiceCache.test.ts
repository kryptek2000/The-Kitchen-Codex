import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  voiceClipKey,
  getCachedVoiceClip,
  setCachedVoiceClip,
  clearVoiceCache,
  prepareVoiceClip,
  setCookingVoiceFocus,
  clearCookingVoiceFocus,
  isCookingVoiceFocusActive,
} from '../../src/application/voiceCache';

type Pending = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  aborted: boolean;
};

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

beforeEach(() => {
  calls.length = 0;
  pending = [];
  mode = 'defer';
  clearVoiceCache();
  installFetchMock();
});

afterEach(() => {
  clearVoiceCache();
  clearCookingVoiceFocus();
  vi.unstubAllGlobals();
});

describe('shared voice cache', () => {
  it('creates distinct keys per recipe and step', () => {
    const a = { id: 'a.md', instructions: [{ text: 'Mix.' }] };
    const b = { id: 'b.md', instructions: [{ text: 'Mix.' }] };
    expect(voiceClipKey(a as any, 0)).not.toBe(voiceClipKey(b as any, 0));
    expect(voiceClipKey(a as any, 0)).not.toBe(voiceClipKey(a as any, 1));
  });

  it('stores and retrieves clips', () => {
    const r = { id: 'r.md', instructions: [{ text: 'Cook.' }] };
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    setCachedVoiceClip(r as any, 0, blob);
    expect(getCachedVoiceClip(r as any, 0)).toBe(blob);
  });

  it('invalidates by instruction text', () => {
    const r1 = { id: 'r.md', instructions: [{ text: 'Cook.' }] };
    const r2 = { id: 'r.md', instructions: [{ text: 'Bake.' }] };
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    setCachedVoiceClip(r1 as any, 0, blob);
    expect(getCachedVoiceClip(r2 as any, 0)).toBeUndefined();
  });

  it('deduplicates concurrent same-step requests', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const a = prepareVoiceClip(recipe, 0);
    const b = prepareVoiceClip(recipe, 0);
    await Promise.resolve();
    expect(speakCalls()).toHaveLength(1);
    resolvePending();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(getCachedVoiceClip(recipe, 0)).toBeTruthy();
  });

  it('serves a completed clip without a second native request', async () => {
    mode = 'ok';
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    await prepareVoiceClip(recipe, 0);
    await prepareVoiceClip(recipe, 0);
    expect(speakCalls()).toHaveLength(1);
  });

  it('keeps another consumer alive when one consumer aborts', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const controllerA = new AbortController();
    const a = prepareVoiceClip(recipe, 0, { signal: controllerA.signal });
    const b = prepareVoiceClip(recipe, 0);
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
    const pa = prepareVoiceClip(recipe, 0, { signal: a.signal });
    const pb = prepareVoiceClip(recipe, 0, { signal: b.signal });
    await Promise.resolve();
    a.abort();
    b.abort();
    expect(pending[0]?.aborted).toBe(true);
    await expect(pa).resolves.toBeNull();
    await expect(pb).resolves.toBeNull();
    expect(getCachedVoiceClip(recipe, 0)).toBeUndefined();

    mode = 'ok';
    await expect(prepareVoiceClip(recipe, 0)).resolves.toBeTruthy();
    expect(speakCalls()).toHaveLength(2);
  });

  it('recovers after a failed preparation', async () => {
    mode = 'fail';
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    await expect(prepareVoiceClip(recipe, 0)).resolves.toBeNull();
    mode = 'ok';
    await expect(prepareVoiceClip(recipe, 0)).resolves.toBeTruthy();
    expect(speakCalls()).toHaveLength(2);
  });

  it('promotes a foreground join of an existing background preparation', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'Mix.' }] };
    const background = prepareVoiceClip(recipe, 0, { kind: 'prepare', purpose: 'cooking' });
    await Promise.resolve();
    const foreground = prepareVoiceClip(recipe, 0, { kind: 'foreground', purpose: 'cooking' });
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
    const detailPrep = prepareVoiceClip(recipe, 0, { purpose: 'detail' });
    await Promise.resolve();
    setCookingVoiceFocus(recipe, 2);
    expect(isCookingVoiceFocusActive(recipe)).toBe(true);
    expect(pending[0]?.aborted).toBe(true);
    await expect(detailPrep).resolves.toBeNull();
    clearCookingVoiceFocus(recipe);
    expect(isCookingVoiceFocusActive(recipe)).toBe(false);
  });

  it('does not cancel a current-step preparation during the Detail-to-Cooking handoff', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'One.' }] };
    const detailController = new AbortController();
    const detailPrep = prepareVoiceClip(recipe, 0, { signal: detailController.signal, purpose: 'detail' });
    await Promise.resolve();
    setCookingVoiceFocus(recipe, 0);
    detailController.abort();
    expect(pending[0]?.aborted).toBe(false);

    const foreground = prepareVoiceClip(recipe, 0, { kind: 'foreground', purpose: 'cooking' });
    await Promise.resolve();
    expect(speakCalls()).toHaveLength(1);
    resolvePending();
    await Promise.allSettled([detailPrep, foreground]);
  });

  it('keeps the focused current-step preparation alive', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'One.' }, { text: 'Two.' }] };
    const current = prepareVoiceClip(recipe, 1, { purpose: 'detail' });
    await Promise.resolve();
    setCookingVoiceFocus(recipe, 1);
    expect(pending[0]?.aborted).toBe(false);
    resolvePending();
    await expect(current).resolves.toBeTruthy();
  });

  it('does not start new Detail preparation while Cooking Mode owns the recipe', async () => {
    const recipe = { id: 'r.md', instructions: [{ text: 'One.' }] };
    setCookingVoiceFocus(recipe, 0);
    await expect(prepareVoiceClip(recipe, 0, { purpose: 'detail' })).resolves.toBeNull();
    expect(speakCalls()).toHaveLength(0);
  });
});
