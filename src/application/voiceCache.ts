/**
 * Shared, bounded in-memory cache for prepared Heart narration clips.
 *
 * Populated from Recipe Detail and reused by Cooking Mode so that audio
 * prepared before entering Cooking Mode is not regenerated. In-flight
 * preparations are deduplicated by stable recipe, instruction, and voice
 * identity so Cooking Mode can join an existing preparation instead of
 * launching duplicate inference.
 *
 * Cooking Mode also publishes a focus signal. Obsolete Recipe Detail prewarm
 * work is cancelled while Cooking Mode is active, and a foreground consumer
 * joining an existing preparation asks the server to promote that exact
 * request instead of starting a duplicate inference.
 */

import { normalizeSpeechText } from './speechText';

export const VOICE_CACHE_MAX_ITEMS = 24;
export const VOICE_CACHE_MAX_BYTES = 24 * 1024 * 1024;

const clipCache = new Map<string, Blob>();
const clipBytes = { value: 0 };

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
};

const preparations = new Map<string, Preparation>();
let preparationSequence = 0;

type CookingFocus = { recipeId: string; stepIndex: number };
let cookingFocus: CookingFocus | null = null;
const focusListeners = new Set<() => void>();

export function voiceRecipeId(recipe: any): string {
  return recipe?.id || recipe?.filePath || recipe?.fileName || 'recipe';
}

export function voiceClipKey(recipe: any, index: number): string {
  const text = recipe?.instructions?.[index]?.text || '';
  return `${voiceRecipeId(recipe)}::${index}::${text}::af_heart`;
}

function notifyFocusListeners() {
  for (const listener of [...focusListeners]) {
    try { listener(); } catch {}
  }
}

function cancelObsoletePreparations(recipeId: string, keepIndices: Set<number>) {
  for (const preparation of preparations.values()) {
    if (preparation.recipeId !== recipeId) continue;
    const keep = keepIndices.has(preparation.index);
    // Keep the current/next preparation alive across the Detail -> Cooking
    // Mode handoff even if Detail releases its consumer before Cooking Mode
    // joins. Otherwise the fetch would be cancelled and restarted, producing
    // a duplicate native request for the same step.
    preparation.focusRetained = keep;
    if (!keep) {
      try { preparation.controller.abort(); } catch {}
    }
  }
}

/**
 * Cooking Mode calls this on mount and on every step change. It keeps the
 * current and next step preparations, cancels other Recipe Detail work for
 * the same recipe, and lets Detail stop/resume prewarming around the focus.
 */
export function setCookingVoiceFocus(recipe: any, stepIndex: number): void {
  const recipeId = voiceRecipeId(recipe);
  const keepIndices = new Set<number>([stepIndex, stepIndex + 1]);
  const changed = cookingFocus?.recipeId !== recipeId || cookingFocus?.stepIndex !== stepIndex;
  cookingFocus = { recipeId, stepIndex };
  cancelObsoletePreparations(recipeId, keepIndices);
  if (changed) notifyFocusListeners();
}

export function clearCookingVoiceFocus(recipe?: any): void {
  if (!cookingFocus) return;
  if (recipe && cookingFocus.recipeId !== voiceRecipeId(recipe)) return;
  cookingFocus = null;
  for (const preparation of preparations.values()) {
    preparation.focusRetained = false;
  }
  notifyFocusListeners();
}

export function isCookingVoiceFocusActive(recipe: any): boolean {
  return cookingFocus?.recipeId === voiceRecipeId(recipe);
}

export function subscribeCookingVoiceFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => { focusListeners.delete(listener); };
}

export function getCachedVoiceClip(recipe: any, index: number): Blob | undefined {
  const key = voiceClipKey(recipe, index);
  const clip = clipCache.get(key);
  if (!clip) return undefined;
  // LRU: move to the end on read.
  clipCache.delete(key);
  clipCache.set(key, clip);
  return clip;
}

export function setCachedVoiceClip(recipe: any, index: number, blob: Blob): void {
  const key = voiceClipKey(recipe, index);
  const previous = clipCache.get(key);
  if (previous) clipBytes.value -= previous.size;
  clipCache.set(key, blob);
  clipBytes.value += blob.size;
  while (clipCache.size > VOICE_CACHE_MAX_ITEMS || clipBytes.value > VOICE_CACHE_MAX_BYTES) {
    const firstKey = clipCache.keys().next().value;
    if (!firstKey) break;
    const old = clipCache.get(firstKey);
    if (old) clipBytes.value -= old.size;
    clipCache.delete(firstKey);
  }
}

export function clearVoiceCache(): void {
  for (const prep of preparations.values()) {
    try { prep.controller.abort(); } catch {}
  }
  clipCache.clear();
  clipBytes.value = 0;
  preparations.clear();
  cookingFocus = null;
  notifyFocusListeners();
}

type PrepareOptions = {
  signal?: AbortSignal;
  kind?: 'prepare' | 'foreground';
  requestId?: string;
  purpose?: 'detail' | 'cooking';
};

function normalizePrepareArgs(signalOrOptions?: AbortSignal | PrepareOptions): PrepareOptions {
  if (!signalOrOptions) return {};
  if (signalOrOptions instanceof AbortSignal) {
    return { signal: signalOrOptions };
  }
  return signalOrOptions;
}

function promotePreparation(prep: Preparation) {
  if (prep.promoted) return;
  prep.promoted = true;
  prep.kind = 'foreground';
  // Fire-and-forget: the speak request may still be in flight, so the bridge
  // remembers this request id and applies foreground priority on enqueue.
  void fetch('/api/voice/prioritize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: prep.requestId }),
  }).catch(() => {});
}

/** Promote an existing shared preparation without adding a consumer. */
export function promoteVoiceClip(recipe: any, index: number): void {
  const prep = preparations.get(voiceClipKey(recipe, index));
  if (prep) promotePreparation(prep);
}

export async function prepareVoiceClip(
  recipe: any,
  index: number,
  signalOrOptions?: AbortSignal | PrepareOptions,
): Promise<Blob | null> {
  const key = voiceClipKey(recipe, index);
  const cached = clipCache.get(key);
  if (cached) return cached;

  const { signal, kind, requestId, purpose = 'cooking' } = normalizePrepareArgs(signalOrOptions);
  const recipeId = voiceRecipeId(recipe);
  if (purpose === 'detail' && isCookingVoiceFocusActive(recipe)) return null;

  let prep = preparations.get(key);
  if (!prep) {
    const controller = new AbortController();
    const initialKind: 'prepare' | 'foreground' = kind === 'foreground' ? 'foreground' : 'prepare';
    prep = {
      controller,
      consumers: 0,
      kind: initialKind,
      requestId: requestId || `voice-prep-${Date.now()}-${++preparationSequence}`,
      recipeId,
      index,
      purpose,
      promoted: initialKind === 'foreground',
      focusRetained: false,
      promise: null as any,
    };
    const promise = (async () => {
      try {
        if (controller.signal.aborted) return null;
        const instruction = recipe?.instructions?.[index];
        if (!instruction) return null;
        const response = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TKC-Voice-Request': prep!.requestId,
            'X-TKC-Voice-Kind': prep!.kind,
          },
          body: JSON.stringify({ text: normalizeSpeechText(`Step ${index + 1}. ${instruction.text}`), voice: 'af_heart' }),
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (controller.signal.aborted) return null;
        setCachedVoiceClip(recipe, index, blob);
        return blob;
      } catch {
        return null;
      } finally {
        preparations.delete(key);
      }
    })();
    prep.promise = promise;
    preparations.set(key, prep);
  }

  prep.consumers += 1;
  if (kind === 'foreground' && prep.kind !== 'foreground') promotePreparation(prep);

  let consumerSettled = false;
  const settleConsumer = () => {
    if (consumerSettled) return;
    consumerSettled = true;
    prep.consumers = Math.max(0, prep.consumers - 1);
    if (prep.consumers <= 0 && !prep.focusRetained) {
      try { prep.controller.abort(); } catch {}
      preparations.delete(key);
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
