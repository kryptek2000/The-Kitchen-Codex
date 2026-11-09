/**
 * Shared, bounded in-memory cache for prepared Heart narration clips.
 *
 * Each application instance owns one VoiceCache. The instance is created by the
 * application composition layer and shared by Recipe Detail and Cooking Mode so
 * that audio prepared before entering Cooking Mode is not regenerated.
 */

import { normalizeSpeechText } from './speechText';
import type { NetworkAdapter } from './adapters/NetworkAdapter';

export const VOICE_CACHE_MAX_ITEMS = 24;
export const VOICE_CACHE_MAX_BYTES = 24 * 1024 * 1024;

type Preparation = {
  controller: AbortController;
  promise: Promise<Blob | null>;
  consumers: number;
  kind: 'prepare' | 'foreground';
  requestId: string;
  recipeId: string;
  index: number;
  purpose: 'detail' | 'cooking';
  promoted: boolean;
  focusRetained: boolean;
  network: NetworkAdapter | null;
};

type CookingFocus = { recipeId: string; stepIndex: number };

export interface VoiceCacheService {
  network: NetworkAdapter | null;
  setNetworkAdapter(adapter: NetworkAdapter | null): void;
  voiceRecipeId(recipe: any): string;
  voiceClipKey(recipe: any, index: number): string;
  getCachedVoiceClip(recipe: any, index: number): Blob | undefined;
  setCachedVoiceClip(recipe: any, index: number, blob: Blob): void;
  clearVoiceCache(): void;
  setCookingVoiceFocus(recipe: any, stepIndex: number): void;
  clearCookingVoiceFocus(recipe?: any): void;
  isCookingVoiceFocusActive(recipe: any): boolean;
  subscribeCookingVoiceFocus(listener: () => void): () => void;
  prepareVoiceClip(recipe: any, index: number, signalOrOptions?: AbortSignal | PrepareOptions): Promise<Blob | null>;
  promoteVoiceClip(recipe: any, index: number, network?: NetworkAdapter | null): void;
  dispose(): void;
  isDisposed(): boolean;
}

type PrepareOptions = {
  signal?: AbortSignal;
  kind?: 'prepare' | 'foreground';
  requestId?: string;
  purpose?: 'detail' | 'cooking';
  network?: NetworkAdapter | null;
};

export class VoiceCache implements VoiceCacheService {
  network: NetworkAdapter | null;
  private clipCache = new Map<string, Blob>();
  private clipBytes = { value: 0 };
  private preparations = new Map<string, Preparation>();
  private preparationSequence = 0;
  private cookingFocus: CookingFocus | null = null;
  private focusListeners = new Set<() => void>();
  private disposed = false;

  constructor(network: NetworkAdapter | null = null) {
    this.network = network;
  }

  setNetworkAdapter(adapter: NetworkAdapter | null): void {
    this.network = adapter;
  }

  voiceRecipeId(recipe: any): string {
    return recipe?.id || recipe?.filePath || recipe?.fileName || 'recipe';
  }

  voiceClipKey(recipe: any, index: number): string {
    const text = recipe?.instructions?.[index]?.text || '';
    return `${this.voiceRecipeId(recipe)}::${index}::${text}::af_heart`;
  }

  private notifyFocusListeners() {
    for (const listener of [...this.focusListeners]) {
      try { listener(); } catch {}
    }
  }

  private cancelObsoletePreparations(recipeId: string, keepIndices: Set<number>) {
    for (const preparation of this.preparations.values()) {
      if (preparation.recipeId !== recipeId) continue;
      const keep = keepIndices.has(preparation.index);
      preparation.focusRetained = keep;
      if (!keep) {
        try { preparation.controller.abort(); } catch {}
      }
    }
  }

  setCookingVoiceFocus(recipe: any, stepIndex: number): void {
    const recipeId = this.voiceRecipeId(recipe);
    const keepIndices = new Set<number>([stepIndex, stepIndex + 1]);
    const changed = this.cookingFocus?.recipeId !== recipeId || this.cookingFocus?.stepIndex !== stepIndex;
    this.cookingFocus = { recipeId, stepIndex };
    this.cancelObsoletePreparations(recipeId, keepIndices);
    if (changed) this.notifyFocusListeners();
  }

  clearCookingVoiceFocus(recipe?: any): void {
    if (!this.cookingFocus) return;
    if (recipe && this.cookingFocus.recipeId !== this.voiceRecipeId(recipe)) return;
    this.cookingFocus = null;
    for (const preparation of this.preparations.values()) {
      preparation.focusRetained = false;
    }
    this.notifyFocusListeners();
  }

  isCookingVoiceFocusActive(recipe: any): boolean {
    return this.cookingFocus?.recipeId === this.voiceRecipeId(recipe);
  }

  subscribeCookingVoiceFocus(listener: () => void): () => void {
    this.focusListeners.add(listener);
    return () => { this.focusListeners.delete(listener); };
  }

  getCachedVoiceClip(recipe: any, index: number): Blob | undefined {
    const key = this.voiceClipKey(recipe, index);
    const clip = this.clipCache.get(key);
    if (!clip) return undefined;
    this.clipCache.delete(key);
    this.clipCache.set(key, clip);
    return clip;
  }

  setCachedVoiceClip(recipe: any, index: number, blob: Blob): void {
    const key = this.voiceClipKey(recipe, index);
    const previous = this.clipCache.get(key);
    if (previous) this.clipBytes.value -= previous.size;
    this.clipCache.set(key, blob);
    this.clipBytes.value += blob.size;
    while (this.clipCache.size > VOICE_CACHE_MAX_ITEMS || this.clipBytes.value > VOICE_CACHE_MAX_BYTES) {
      const firstKey = this.clipCache.keys().next().value;
      if (!firstKey) break;
      const old = this.clipCache.get(firstKey);
      if (old) this.clipBytes.value -= old.size;
      this.clipCache.delete(firstKey);
    }
  }

  clearVoiceCache(): void {
    for (const prep of this.preparations.values()) {
      try { prep.controller.abort(); } catch {}
    }
    this.clipCache.clear();
    this.clipBytes.value = 0;
    this.preparations.clear();
    this.cookingFocus = null;
    this.notifyFocusListeners();
  }

  dispose(): void {
    this.disposed = true;
    this.clearVoiceCache();
    this.focusListeners.clear();
    this.network = null;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private promotePreparation(prep: Preparation) {
    if (prep.promoted) return;
    prep.promoted = true;
    prep.kind = 'foreground';
    const network = prep.network ?? this.network;
    if (!network) return;
    void network.post('/api/voice/prioritize', { requestId: prep.requestId }, {
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  }

  promoteVoiceClip(recipe: any, index: number, network?: NetworkAdapter | null): void {
    const prep = this.preparations.get(this.voiceClipKey(recipe, index));
    if (prep) {
      if (network) prep.network = network;
      this.promotePreparation(prep);
    }
  }

  async prepareVoiceClip(
    recipe: any,
    index: number,
    signalOrOptions?: AbortSignal | PrepareOptions,
  ): Promise<Blob | null> {
    if (this.disposed) return null;
    const key = this.voiceClipKey(recipe, index);
    const cached = this.clipCache.get(key);
    if (cached) return cached;

    const { signal, kind, requestId, purpose = 'cooking', network } = this.normalizePrepareArgs(signalOrOptions);
    const recipeId = this.voiceRecipeId(recipe);
    if (purpose === 'detail' && this.isCookingVoiceFocusActive(recipe)) return null;

    let prep = this.preparations.get(key);
    if (!prep) {
      const controller = new AbortController();
      const initialKind: 'prepare' | 'foreground' = kind === 'foreground' ? 'foreground' : 'prepare';
      prep = {
        controller,
        consumers: 0,
        kind: initialKind,
        requestId: requestId || `voice-prep-${Date.now()}-${++this.preparationSequence}`,
        recipeId,
        index,
        purpose,
        promoted: initialKind === 'foreground',
        focusRetained: false,
        network: network ?? this.network,
        promise: null as any,
      };
      const promise = (async () => {
        try {
          if (controller.signal.aborted) return null;
          const instruction = recipe?.instructions?.[index];
          if (!instruction) return null;
          const network = prep!.network ?? this.network;
          if (!network) return null;
          const response = await network.postBytes('/api/voice/speak', {
            text: normalizeSpeechText(`Step ${index + 1}. ${instruction.text}`),
            voice: 'af_heart',
          }, {
            headers: {
              'X-TKC-Voice-Request': prep!.requestId,
              'X-TKC-Voice-Kind': prep!.kind,
            },
            signal: controller.signal,
          });
          if (!response.ok || !response.bytes) return null;
          // Prevent a late completion from an obsolete preparation (aborted
          // after losing its last consumer, cleared, or disposed) from
          // repopulating the cache or affecting a newer preparation.
          if (this.disposed) return null;
          if (controller.signal.aborted) return null;
          if (this.preparations.get(key) !== prep) return null;
          const blob = new Blob([response.bytes as any], { type: response.contentType || 'audio/wav' });
          this.setCachedVoiceClip(recipe, index, blob);
          return blob;
        } catch {
          return null;
        } finally {
          // Identity guard: only delete if the map still points to THIS
          // preparation. A late P1 completion must not delete a newer P2
          // for the same key.
          if (this.preparations.get(key) === prep) {
            this.preparations.delete(key);
          }
        }
      })();
      prep.promise = promise;
      this.preparations.set(key, prep);
    }

    prep.consumers += 1;
    if (kind === 'foreground' && prep.kind !== 'foreground') this.promotePreparation(prep);

    let consumerSettled = false;
    const settleConsumer = () => {
      if (consumerSettled) return;
      consumerSettled = true;
      prep.consumers = Math.max(0, prep.consumers - 1);
      if (prep.consumers <= 0 && !prep.focusRetained) {
        try { prep.controller.abort(); } catch {}
        // Identity guard: only delete if still current. The map may already
        // point to a newer preparation for the same key (P2) after this
        // preparation lost its consumers; deleting unconditionally would
        // erase P2 and force a duplicate P3.
        if (this.preparations.get(key) === prep) {
          this.preparations.delete(key);
        }
      }
    };

    if (signal) {
      if (signal.aborted) {
        settleConsumer();
        return null;
      }
      const onAbort = () => settleConsumer();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await prep.promise;
        return result;
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (!signal.aborted) settleConsumer();
      }
    }

    try {
      const result = await prep.promise;
      return result;
    } finally {
      settleConsumer();
    }
  }

  private normalizePrepareArgs(signalOrOptions?: AbortSignal | PrepareOptions): PrepareOptions {
    if (!signalOrOptions) return {};
    if (signalOrOptions instanceof AbortSignal) {
      return { signal: signalOrOptions };
    }
    return signalOrOptions;
  }
}

export function createVoiceCache(network: NetworkAdapter | null = null): VoiceCache {
  return new VoiceCache(network);
}

// Backward-compatible module-level helpers for existing tests and callers.
const defaultVoiceCache = createVoiceCache(null);

export function setVoiceNetworkAdapter(adapter: NetworkAdapter | null): void {
  defaultVoiceCache.setNetworkAdapter(adapter);
}

export function getVoiceNetworkAdapter(): NetworkAdapter | null {
  return defaultVoiceCache.network;
}

export function voiceRecipeId(recipe: any): string {
  return defaultVoiceCache.voiceRecipeId(recipe);
}

export function voiceClipKey(recipe: any, index: number): string {
  return defaultVoiceCache.voiceClipKey(recipe, index);
}

export function getCachedVoiceClip(recipe: any, index: number): Blob | undefined {
  return defaultVoiceCache.getCachedVoiceClip(recipe, index);
}

export function setCachedVoiceClip(recipe: any, index: number, blob: Blob): void {
  defaultVoiceCache.setCachedVoiceClip(recipe, index, blob);
}

export function clearVoiceCache(): void {
  defaultVoiceCache.clearVoiceCache();
}

export function setCookingVoiceFocus(recipe: any, stepIndex: number): void {
  defaultVoiceCache.setCookingVoiceFocus(recipe, stepIndex);
}

export function clearCookingVoiceFocus(recipe?: any): void {
  defaultVoiceCache.clearCookingVoiceFocus(recipe);
}

export function isCookingVoiceFocusActive(recipe: any): boolean {
  return defaultVoiceCache.isCookingVoiceFocusActive(recipe);
}

export function subscribeCookingVoiceFocus(listener: () => void): () => void {
  return defaultVoiceCache.subscribeCookingVoiceFocus(listener);
}

export function prepareVoiceClip(recipe: any, index: number, signalOrOptions?: AbortSignal | PrepareOptions): Promise<Blob | null> {
  return defaultVoiceCache.prepareVoiceClip(recipe, index, signalOrOptions);
}

export function promoteVoiceClip(recipe: any, index: number, network?: NetworkAdapter | null): void {
  defaultVoiceCache.promoteVoiceClip(recipe, index, network);
}