import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Sparkles, X, AlertCircle, Settings, Check, RefreshCw } from 'lucide-react';
import {
  RepresentativeImageChooser,
  type RepresentativeImageChooserProps,
} from './RepresentativeImageChooser';
import type { RecipeImageGenerationQuote } from '../application/recipeImageRecovery';

/**
 * The Kitchen Codex — two-mode recipe image chooser (Phase 2).
 *
 * A single dialog with CLEARLY SEPARATED modes:
 *   - "Licensed Search — Free" (default; no API key required; unchanged flow)
 *   - "Generate with AI" (explicit opt-in; provider/model/pricing shown before
 *     generation; one confirmation for paid/variable)
 *
 * Opening the dialog, switching modes, and typing make ZERO provider calls. The
 * only provider call is the explicit Generate/Confirm action.
 */

export type RecipeImageChooserMode = 'licensed' | 'ai';

export interface AiImagePanelState {
  phase: 'idle' | 'quoting' | 'confirming' | 'generating' | 'preview' | 'error';
  quote?: RecipeImageGenerationQuote | null;
  preview?: { provider: string; model: string; previewUrl: string } | null;
  message?: string | null;
  messageKind?: 'info' | 'error';
  /** False when no image provider is configured; shows the setup action. */
  providerConfigured?: boolean;
}

export interface RecipeImageChooserProps {
  defaultMode?: RecipeImageChooserMode;
  licensed: Omit<RepresentativeImageChooserProps, 'embedded'>;
  ai: AiImagePanelState;
  onAiGenerate: () => void;
  onAiConfirm: () => void;
  onAiAccept: () => void;
  onAiRegenerate: () => void;
  onAiCancelPreview: () => void;
  onOpenAiSettings?: () => void;
  onCancel: () => void;
}

function credentialLabel(source: RecipeImageGenerationQuote['credentialSource']): string {
  return source === 'session_only' ? 'Using your temporary API key' : 'Using server API key';
}

export function AiImagePanel({
  state,
  onGenerate,
  onConfirm,
  onAccept,
  onRegenerate,
  onCancelPreview,
  onOpenSettings,
}: {
  state: AiImagePanelState;
  onGenerate: () => void;
  onConfirm: () => void;
  onAccept: () => void;
  onRegenerate: () => void;
  onCancelPreview: () => void;
  onOpenSettings?: () => void;
}) {
  const { phase, quote, preview, message, messageKind, providerConfigured } = state;
  const busy = phase === 'quoting' || phase === 'generating';

  if (providerConfigured === false) {
    return (
      <div
        data-testid="ai-image-unconfigured"
        className="p-4 rounded-xl bg-[#0C0C0C] border border-dashed border-white/10 space-y-3 text-center"
      >
        <Settings className="w-6 h-6 mx-auto text-gray-500" />
        <p className="text-xs text-gray-400">
          No image generation provider is configured. Set up an image provider in AI Settings to generate images.
        </p>
        <button
          type="button"
          data-testid="open-ai-settings"
          onClick={onOpenSettings}
          disabled={!onOpenSettings}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-black text-xs font-bold transition-colors disabled:opacity-50"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Set up image AI</span>
        </button>
        <p className="text-[10px] text-gray-600">
          Licensed search remains free and available without any API key.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="ai-image-panel" className="space-y-3">
      <p className="text-[11px] text-gray-400">
        Generate a new recipe image with AI. The provider and exact model are shown before generation, and pricing is
        disclosed truthfully. Nothing is saved until you accept the preview and save the recipe.
      </p>

      {message && (
        <div
          role={messageKind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`p-3 rounded-xl text-xs flex items-start gap-2 ${
            messageKind === 'error'
              ? 'bg-rose-950/40 border border-rose-800/40 text-rose-300'
              : 'bg-sky-950/40 border border-sky-800/40 text-sky-200'
          }`}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>{message}</p>
        </div>
      )}

      {(phase === 'confirming' || preview) && quote && (
        <div
          data-testid="ai-image-quote"
          className="p-3 rounded-xl bg-[#0F0F0F] border border-amber-500/20 space-y-1"
        >
          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-300">
            {phase === 'confirming' ? 'Confirm generation' : 'Generated with'}
          </div>
          <div className="text-[11px] text-gray-200">{quote.provider.name}</div>
          <div className="text-[11px] text-gray-400 font-mono">{quote.model}</div>
          <div className="text-[10px] text-gray-500">{credentialLabel(quote.credentialSource)}</div>
          <div className="text-[11px] text-amber-300">{quote.costLabel}</div>
        </div>
      )}

      {busy && (
        <div data-testid="ai-image-loading" className="text-center py-6 px-4 rounded-xl bg-[#0E0E0E] border border-white/10">
          <p className="text-xs text-gray-400">
            {phase === 'quoting' ? 'Preparing image generation…' : 'Generating image…'}
          </p>
        </div>
      )}

      {phase === 'preview' && preview && (
        <div className="space-y-2.5 p-3 rounded-xl bg-[#0C0C0C] border border-purple-500/20">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300">AI-generated preview</span>
            <span className="text-[10px] text-gray-500">nothing saved yet</span>
          </div>
          <img
            src={preview.previewUrl}
            alt="AI-generated recipe preview"
            data-testid="ai-image-preview"
            className="max-h-56 rounded-lg border border-white/10 w-full object-contain bg-black/40"
          />
          <div className="text-[10px] text-gray-500 font-mono">
            {preview.provider} · {preview.model}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancelPreview}
              data-testid="ai-image-cancel"
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-white rounded-lg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onRegenerate}
              data-testid="ai-image-regenerate"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-white/10 hover:bg-white/15 text-white transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Regenerate</span>
            </button>
            <button
              type="button"
              onClick={onAccept}
              data-testid="ai-image-use"
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black transition-colors"
            >
              <Check className="w-4 h-4" />
              <span>Use This Image</span>
            </button>
          </div>
        </div>
      )}

      {(phase === 'idle' || phase === 'error') && (
        <button
          type="button"
          data-testid="ai-image-generate"
          onClick={onGenerate}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-500 hover:bg-purple-400 text-black text-xs font-bold transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Generate with AI</span>
        </button>
      )}

      {phase === 'confirming' && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancelPreview}
            data-testid="ai-image-cancel"
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="ai-image-confirm"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Confirm &amp; Generate</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function RecipeImageChooser({
  defaultMode = 'licensed',
  licensed,
  ai,
  onAiGenerate,
  onAiConfirm,
  onAiAccept,
  onAiRegenerate,
  onAiCancelPreview,
  onOpenAiSettings,
  onCancel,
}: RecipeImageChooserProps) {
  const [mode, setMode] = useState<RecipeImageChooserMode>(defaultMode);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Escape closes without generating/saving; initial focus is predictable;
  // Tab/Shift+Tab is trapped inside the dialog; focus returns to the opener on
  // close (I6). Mount-only: parent re-renders (inline callback identities)
  // must never steal focus back.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const focusTab = (next: RecipeImageChooserMode) => {
      setMode(next);
      requestAnimationFrame(() => {
        dialogRef.current
          ?.querySelector<HTMLElement>(`[data-testid="image-mode-${next === 'licensed' ? 'licensed' : 'ai'}"]`)
          ?.focus();
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      const target = event.target as HTMLElement | null;
      const inTablist = !!target?.closest?.('[role="tablist"]');
      if (inTablist && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault();
        focusTab(modeRef.current === 'licensed' ? 'ai' : 'licensed');
        return;
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  const title = mode === 'ai' ? 'Generate with AI' : 'Choose a Representative Recipe Image';

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="bg-[#141414] rounded-2xl border border-white/10 max-w-3xl w-full p-5 sm:p-6 shadow-2xl space-y-4 my-auto max-h-[92vh] flex flex-col text-gray-200 focus:outline-none"
      >
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 text-sky-300 flex items-center justify-center">
              <ImageIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-serif font-bold text-white">{title}</h2>
              <p className="text-[11px] text-gray-400">
                {mode === 'ai'
                  ? 'AI generation uses the selected provider and model. Paid or variable pricing is confirmed before each generation.'
                  : 'Representative recipe image — results may resemble this recipe but are not guaranteed to depict the exact generated dish.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Clearly separated modes (arrow keys move between tabs; switching
            makes ZERO provider calls). */}
        <div
          role="tablist"
          aria-label="Image source"
          className="flex bg-[#0C0C0C] p-1 rounded-lg border border-white/5 text-xs"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'licensed'}
            tabIndex={mode === 'licensed' ? 0 : -1}
            data-testid="image-mode-licensed"
            onClick={() => setMode('licensed')}
            className={`flex-1 px-3 py-1.5 rounded-md transition-all ${
              mode === 'licensed'
                ? 'bg-white/10 text-sky-300 border border-white/10 font-semibold'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Licensed Search — Free
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'ai'}
            tabIndex={mode === 'ai' ? 0 : -1}
            data-testid="image-mode-ai"
            onClick={() => setMode('ai')}
            className={`flex-1 px-3 py-1.5 rounded-md transition-all ${
              mode === 'ai'
                ? 'bg-white/10 text-purple-300 border border-white/10 font-semibold'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Generate with AI
          </button>
        </div>

        <div className="overflow-y-auto flex-1 pr-1">
          {mode === 'licensed' ? (
            <RepresentativeImageChooser embedded {...licensed} />
          ) : (
            <AiImagePanel
              state={ai}
              onGenerate={onAiGenerate}
              onConfirm={onAiConfirm}
              onAccept={onAiAccept}
              onRegenerate={onAiRegenerate}
              onCancelPreview={onAiCancelPreview}
              onOpenSettings={onOpenAiSettings}
            />
          )}
        </div>
      </div>
    </div>
  );
}
