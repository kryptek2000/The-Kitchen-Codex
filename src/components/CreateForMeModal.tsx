/**
 * The Kitchen Codex — Create for Me modal (v0.7 Phase 2A).
 *
 * Explicit-invention UI. Flow: prompt + compact constraints -> Generate (draft
 * returned by the server, nothing saved) -> preview/edit a clearly-labeled
 * "Generated Draft / Not saved yet" -> explicit Save (via the existing recipe
 * write path). Generate NEVER saves, and the server NEVER returns a prompt or
 * any secret.
 */

import React, { useMemo, useReducer, useRef, useState } from 'react';
import { Sparkles, X, Loader2 } from 'lucide-react';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import type { ObsidianRecipe } from '../types';
import {
  normalizeGeneratedRecipeDraft,
  type GeneratedRecipeDraft,
  type GeneratedRecipeProvenance,
  type GeneratedIngredient,
  type GeneratedStep,
} from '../schema/generatedRecipe';
import {
  requestGeneratedRecipe,
  CreateForMeConstraintsInput,
  CreateRecipeClientError,
} from '../utils/createForMe';
import {
  generatedDraftToObsidianRecipe,
  GeneratedRecipePathCollisionError,
  GENERATED_RECIPE_COLLISION_MESSAGE,
} from '../application/createForMe';
import {
  createForMeReducer,
  initialCreateForMeState,
} from '../application/createForMeState';
import {
  createCreateForMeSession,
  runGuarded,
} from '../application/createForMeSession';
import { SignatureRecipeCard } from './SignatureRecipeCard';

interface CreateForMeModalProps {
  isOpen: boolean;
  onClose: () => void;
  network: NetworkAdapter;
  onSaveRecipe: (recipe: ObsidianRecipe) => void | Promise<void>;
}

/** Presentational error state (exported for rendering tests). */
export function CreateForMeError({ message, onRetry, onClose }: { message: string; onRetry: () => void; onClose: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-white">{message}</p>
      <div className="flex gap-2">
        <button onClick={onRetry} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-300 border border-amber-500/30">
          Try again
        </button>
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-gray-200 border border-white/10">
          Close
        </button>
      </div>
    </div>
  );
}

/** Presentational draft preview/editor (exported for rendering tests). */
export function CreateForMeDraftView({
  draft,
  provenance,
  onChange,
}: {
  draft: GeneratedRecipeDraft;
  provenance: GeneratedRecipeProvenance;
  onChange?: (draft: GeneratedRecipeDraft) => void;
}) {
  const editable = typeof onChange === 'function';
  const update = (next: GeneratedRecipeDraft) => onChange?.(next);
  const fieldClass =
    'min-h-[40px] w-full rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] px-2.5 py-2 text-sm text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-muted,#6B7280)] focus:border-[var(--accent-text,#F59E0B)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text,#F59E0B)]/25 disabled:opacity-60';
  const labelClass =
    'text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted,#6B7280)]';

  const setStringField = (
    key: 'description' | 'prepTime' | 'cookTime' | 'totalTime' | 'notes',
    value: string
  ) => {
    const next = { ...draft } as Record<string, unknown>;
    if (value.trim()) next[key] = value;
    else delete next[key];
    update(next as unknown as GeneratedRecipeDraft);
  };

  const updateServings = (value: string) => {
    const next = { ...draft } as Record<string, unknown>;
    if (!value.trim()) delete next.servings;
    else {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) next.servings = parsed;
    }
    update(next as unknown as GeneratedRecipeDraft);
  };

  const updateIngredient = (index: number, patch: Partial<GeneratedIngredient>) => {
    const ingredients = draft.ingredients.map((ingredient, i) =>
      i === index ? { ...ingredient, ...patch } : ingredient
    );
    update({ ...draft, ingredients });
  };

  const updateStep = (index: number, patch: Partial<GeneratedStep>) => {
    const steps = draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
    update({ ...draft, steps });
  };

  const hasMetadata =
    draft.servings !== undefined ||
    draft.prepTime !== undefined ||
    draft.cookTime !== undefined ||
    draft.totalTime !== undefined;

  return (
    <div className="space-y-4" data-create-for-me-draft="true">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-200">
          Generated Draft
        </span>
        <span className="rounded-md border border-[var(--accent-text,#F59E0B)]/30 bg-[var(--accent-text,#F59E0B)]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent-text,#F59E0B)]">
          Not saved yet
        </span>
        <span className="text-xs text-[var(--text-muted,#6B7280)]">
          AI-generated by {provenance.providerId}
        </span>
      </div>

      <div className="rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-4 sm:p-6 space-y-6">
        <div className="space-y-2">
          <label className="sr-only" htmlFor="create-me-title">Recipe title</label>
          <textarea
            id="create-me-title"
            aria-label="Recipe title"
            value={draft.title}
            readOnly={!editable}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            onChange={(e) => update({ ...draft, title: e.target.value.replace(/\s*\n+\s*/g, ' ') })}
            className="w-full resize-none overflow-hidden border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-transparent pb-2 font-serif text-2xl leading-tight text-[var(--text-primary,#F3F4F6)] focus:border-[var(--accent-text,#F59E0B)] focus:outline-none sm:text-3xl [field-sizing:content]"
          />
          {draft.description !== undefined && (
            <label className="block space-y-1">
              <span className={labelClass}>Description</span>
              <textarea
                id="create-me-description"
                aria-label="Recipe description"
                value={draft.description ?? ''}
                readOnly={!editable}
                rows={2}
                onChange={(e) => setStringField('description', e.target.value)}
                className={`${fieldClass} resize-y`}
              />
            </label>
          )}
        </div>

        {hasMetadata && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {draft.servings !== undefined && (
              <label className="space-y-1">
                <span className={labelClass}>Servings</span>
                <input
                  aria-label="Servings"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={draft.servings}
                  readOnly={!editable}
                  onChange={(e) => updateServings(e.target.value)}
                  className={fieldClass}
                />
              </label>
            )}
            {draft.prepTime !== undefined && (
              <label className="space-y-1">
                <span className={labelClass}>Prep time</span>
                <input
                  aria-label="Prep time"
                  value={draft.prepTime}
                  readOnly={!editable}
                  onChange={(e) => setStringField('prepTime', e.target.value)}
                  className={fieldClass}
                />
              </label>
            )}
            {draft.cookTime !== undefined && (
              <label className="space-y-1">
                <span className={labelClass}>Cook time</span>
                <input
                  aria-label="Cook time"
                  value={draft.cookTime}
                  readOnly={!editable}
                  onChange={(e) => setStringField('cookTime', e.target.value)}
                  className={fieldClass}
                />
              </label>
            )}
            {draft.totalTime !== undefined && (
              <label className="space-y-1">
                <span className={labelClass}>Total time</span>
                <input
                  aria-label="Total time"
                  value={draft.totalTime}
                  readOnly={!editable}
                  onChange={(e) => setStringField('totalTime', e.target.value)}
                  className={fieldClass}
                />
              </label>
            )}
          </div>
        )}

        <section id="create-me-ingredients" aria-labelledby="create-me-ingredients-heading" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <h3 id="create-me-ingredients-heading" className="font-serif text-xl text-[var(--text-primary,#F3F4F6)]">
              Ingredients
            </h3>
            <span className="text-[11px] text-[var(--text-muted,#6B7280)]">
              Amount · unit · ingredient · preparation
            </span>
          </div>
          <div className="space-y-2">
            {draft.ingredients.map((ingredient, index) => (
              <div
                key={`ingredient-${index}`}
                data-ingredient-row={index}
                className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-2.5 sm:grid-cols-[4.5rem_5.5rem_minmax(0,1fr)_minmax(0,0.85fr)_auto] sm:items-center"
              >
                <input
                  aria-label={`Ingredient ${index + 1} amount`}
                  inputMode="decimal"
                  placeholder="Amount"
                  value={ingredient.amount ?? ''}
                  readOnly={!editable}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (!value.trim()) updateIngredient(index, { amount: undefined });
                    else {
                      const parsed = Number(value);
                      if (Number.isFinite(parsed)) updateIngredient(index, { amount: parsed });
                    }
                  }}
                  className={fieldClass}
                />
                <input
                  aria-label={`Ingredient ${index + 1} unit`}
                  placeholder="Unit"
                  value={ingredient.unit ?? ''}
                  readOnly={!editable}
                  onChange={(e) => updateIngredient(index, { unit: e.target.value })}
                  className={fieldClass}
                />
                <input
                  aria-label={`Ingredient ${index + 1} name`}
                  placeholder="Ingredient"
                  value={ingredient.name}
                  readOnly={!editable}
                  onChange={(e) => updateIngredient(index, { name: e.target.value })}
                  className={`${fieldClass} col-span-2 sm:col-span-1`}
                />
                <input
                  aria-label={`Ingredient ${index + 1} preparation`}
                  placeholder="Preparation"
                  value={ingredient.preparation ?? ''}
                  readOnly={!editable}
                  onChange={(e) => updateIngredient(index, { preparation: e.target.value })}
                  className={`${fieldClass} col-span-2 sm:col-span-1`}
                />
                <label className="col-span-2 inline-flex min-h-[40px] items-center gap-2 text-xs text-[var(--text-secondary,#9CA3AF)] sm:col-span-1 sm:justify-self-end">
                  <input
                    aria-label={`Ingredient ${index + 1} optional`}
                    type="checkbox"
                    checked={ingredient.optional === true}
                    disabled={!editable}
                    onChange={(e) => updateIngredient(index, { optional: e.target.checked })}
                    className="h-4 w-4 accent-[var(--accent-text,#F59E0B)]"
                  />
                  Optional
                </label>
              </div>
            ))}
          </div>
        </section>

        <section id="create-me-steps" aria-labelledby="create-me-steps-heading" className="space-y-3">
          <h3 id="create-me-steps-heading" className="font-serif text-xl text-[var(--text-primary,#F3F4F6)]">
            Preparation
          </h3>
          <ol className="space-y-4">
            {draft.steps.map((step, index) => (
              <li key={`step-${index}`} data-step-row={index} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--accent-text,#F59E0B)]/30 bg-[var(--accent-text,#F59E0B)]/10 text-xs font-semibold text-[var(--accent-text,#F59E0B)]"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  <textarea
                    aria-label={`Step ${index + 1} instruction`}
                    value={step.text}
                    readOnly={!editable}
                    rows={Math.min(6, Math.max(2, Math.ceil(step.text.length / 90)))}
                    onChange={(e) => updateStep(index, { text: e.target.value })}
                    className={`${fieldClass} resize-y leading-relaxed`}
                  />
                  <label className="inline-flex items-center gap-2 text-xs text-[var(--text-muted,#6B7280)]">
                    Timer
                    <input
                      aria-label={`Step ${index + 1} timer minutes`}
                      type="number"
                      min={0}
                      step={1}
                      placeholder="—"
                      value={step.timerMinutes ?? ''}
                      readOnly={!editable}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (!value.trim()) updateStep(index, { timerMinutes: undefined });
                        else {
                          const parsed = Number(value);
                          if (Number.isFinite(parsed)) updateStep(index, { timerMinutes: parsed });
                        }
                      }}
                      className="min-h-[40px] w-20 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-root,#0C0C0C)] px-2 text-sm text-[var(--text-primary,#F3F4F6)] focus:border-[var(--accent-text,#F59E0B)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text,#F59E0B)]/25"
                    />
                    min
                  </label>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {draft.notes !== undefined && (
          <label className="block space-y-1">
            <span className={labelClass}>Notes</span>
            <textarea
              aria-label="Recipe notes"
              value={draft.notes ?? ''}
              readOnly={!editable}
              rows={3}
              onChange={(e) => setStringField('notes', e.target.value)}
              className={`${fieldClass} resize-y`}
            />
          </label>
        )}
      </div>
    </div>
  );
}

/** Bounded user-facing message for a generation failure. Exported for tests. */
export function createForMeErrorMessage(err: unknown): string {
  if (err instanceof CreateRecipeClientError && err.code === 'RECIPE_GENERATION_NOT_VERIFIED') {
    return 'This free model is verified for structured text but not for recipe creation. Verify recipe creation in AI Settings first.';
  }
  if (err instanceof CreateRecipeClientError && err.code === 'CHATGPT_PLAN_UNAVAILABLE') {
    return (
      err.message ||
      'ChatGPT plan is selected but is not connected or its plan usage is unavailable. Reconnect it in AI Studio → ChatGPT plan. No other provider was used.'
    );
  }
  if (err instanceof CreateRecipeClientError && err.code === 'CHATGPT_PLAN_INVALID_RESPONSE') {
    return (
      err.message ||
      'ChatGPT plan returned a recipe draft that could not be validated. Nothing was saved; no other provider was used.'
    );
  }
  if (err instanceof CreateRecipeClientError && err.code === 'UNSUPPORTED_CAPABILITY') {
    return 'No configured AI provider supports recipe generation.';
  }
  return "Couldn't generate a recipe right now.";
}

/** Compact elapsed-time label for truthful in-progress feedback. */
export function formatElapsedSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function CreateForMeModal({ isOpen, onClose, network, onSaveRecipe }: CreateForMeModalProps) {
  const [state, dispatch] = useReducer(createForMeReducer, initialCreateForMeState);
  const status = state.status;
  const error = state.error;
  const draft = state.draft;
  const provenance = state.provenance;
  const saving = state.saving;
  const [prompt, setPrompt] = useState('');
  const [servings, setServings] = useState('');
  const [maxTotalMinutes, setMaxTotalMinutes] = useState('');
  const [cuisine, setCuisine] = useState('');
  const [course, setCourse] = useState('');
  const [dietary, setDietary] = useState('');
  const [exclude, setExclude] = useState('');
  const [editedDraft, setEditedDraft] = useState<GeneratedRecipeDraft | null>(null);
  // SHISO-C1.6-F3: a validated draft opens as a read-only cookbook card. The
  // existing structured editor is revealed only by the explicit Edit action.
  const [viewMode, setViewMode] = useState<'card' | 'edit'>('card');
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastGenerationMs, setLastGenerationMs] = useState<number | null>(null);
  // Session liveness + re-entrancy guard: invalidates in-flight generation/save
  // results when the modal opens/closes/discards, and resets the local busy flag.
  const session = useRef(createCreateForMeSession());

  // Session boundary: any open/close transition advances the epoch (invalidating
  // in-flight results and clearing the busy guard) and resets to a clean state, so
  // a reopened modal starts fresh and a late completion from a closed session is
  // never dispatched.
  const prevOpen = useRef(isOpen);
  React.useEffect(() => {
    if (prevOpen.current !== isOpen) {
      prevOpen.current = isOpen;
      session.current.advance();
      dispatch({ type: 'CLOSE' });
      setEditedDraft(null);
      setViewMode('card');
      setGenerationStartedAt(null);
      setElapsedMs(0);
      setLastGenerationMs(null);
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (generationStartedAt === null) return;
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - generationStartedAt);
    }, 250);
    return () => window.clearInterval(interval);
  }, [generationStartedAt]);

  if (!isOpen) return null;

  const constraints: CreateForMeConstraintsInput = {};
  const servingsNum = parseInt(servings, 10);
  if (!isNaN(servingsNum)) constraints.servings = servingsNum;
  const minsNum = parseInt(maxTotalMinutes, 10);
  if (!isNaN(minsNum)) constraints.maxTotalMinutes = minsNum;
  if (cuisine) constraints.cuisine = cuisine;
  if (course) constraints.course = course;
  if (dietary) constraints.dietary = dietary;
  if (exclude) constraints.excludeIngredients = exclude;

  const generate = async () => {
    if (!prompt.trim()) return;
    const startedAt = Date.now();
    setGenerationStartedAt(startedAt);
    setElapsedMs(0);
    setLastGenerationMs(null);
    setEditedDraft(null);
    setViewMode('card');
    // A new generation attempt clears any stale error immediately.
    dispatch({ type: 'START_GENERATION' });
    await runGuarded(
      session.current,
      () => requestGeneratedRecipe(network, prompt, constraints),
      (result) => {
        setEditedDraft(result.draft);
        setLastGenerationMs(Date.now() - startedAt);
        dispatch({ type: 'GENERATION_SUCCESS', draft: result.draft, provenance: result.provenance });
      },
      (err) => {
        setLastGenerationMs(Date.now() - startedAt);
        dispatch({ type: 'GENERATION_FAILURE', message: createForMeErrorMessage(err) });
      }
    );
    setGenerationStartedAt(null);
  };

  const save = async () => {
    if (!draft || !provenance) return;
    if (session.current.isBusy()) return; // reject a duplicate submission while saving
    session.current.setBusy(true);
    let edited: GeneratedRecipeDraft;
    try {
      // Validate the complete edited draft before any Vault write. This preserves
      // preparation/optional/timer fields and rejects empty required fields or
      // any malformed edited shape; no partial draft is saved.
      edited = normalizeGeneratedRecipeDraft(editedDraft ?? draft);
    } catch {
      dispatch({
        type: 'SAVE_FAILURE',
        message: 'Please complete the recipe title, every ingredient name, and every step before saving.',
      });
      session.current.setBusy(false);
      return;
    }
    const recipe = generatedDraftToObsidianRecipe({ draft: edited, provenance });
    dispatch({ type: 'BEGIN_SAVE' });
    await runGuarded(
      session.current,
      async () => { await onSaveRecipe(recipe); },
      () => {
        session.current.setBusy(false);
        dispatch({ type: 'SAVE_SUCCESS' });
        onClose();
        setPrompt('');
      },
      (err) => {
        session.current.setBusy(false);
        // A save collision must never discard the draft — show a bounded message and
        // keep every edit so the user can rename and try again.
        const message =
          err instanceof GeneratedRecipePathCollisionError
            ? GENERATED_RECIPE_COLLISION_MESSAGE
            : "Couldn't save the recipe right now.";
        dispatch({ type: 'SAVE_COLLISION', message });
      }
    );
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70" role="dialog" aria-modal="true" aria-label="Create with SHISO">
      <div className="max-h-[90vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-2xl border border-white/10 bg-[#0F0F0F] p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-serif font-bold text-base text-white">
            <Sparkles className="w-4 h-4 text-amber-400" />
            Create with SHISO
          </h2>
          <button onClick={() => { session.current.advance(); dispatch({ type: 'CLOSE' }); onClose(); }} aria-label="Close" className="text-gray-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-gray-400">
          Ask for an invented recipe with your own prompt and constraints. The result is a Generated
          Draft you can edit — nothing is saved to your vault until you press Save.
        </p>

        {status === 'error' ? (
          <div className="space-y-2">
            {lastGenerationMs !== null && (
              <p role="status" className="text-xs text-[var(--text-muted,#6B7280)]">
                Generation stopped after {formatElapsedSeconds(lastGenerationMs)}. No draft was saved.
              </p>
            )}
            <CreateForMeError
              message={error}
              onRetry={() => {
                session.current.advance();
                dispatch({ type: 'DISCARD' });
                setEditedDraft(null);
                setViewMode('card');
                setLastGenerationMs(null);
              }}
              onClose={() => {
                session.current.advance();
                dispatch({ type: 'CLOSE' });
                setEditedDraft(null);
                setViewMode('card');
                setLastGenerationMs(null);
                onClose();
              }}
            />
          </div>
        ) : status === 'draft' && draft && provenance ? (
          <div className="space-y-3">
            {lastGenerationMs !== null && (
              <p role="status" className="text-xs text-[var(--text-muted,#6B7280)]">
                Validated draft ready in {formatElapsedSeconds(lastGenerationMs)}.
              </p>
            )}
            {viewMode === 'card' ? (
              <SignatureRecipeCard draft={editedDraft ?? draft} provenance={provenance} />
            ) : (
              <CreateForMeDraftView
                draft={editedDraft ?? draft}
                provenance={provenance}
                onChange={setEditedDraft}
              />
            )}
            {error && (
              <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{error}</p>
            )}
            <div className="kc-src-foot">
              <div className="kc-src-assure">
                Nothing is saved until you choose <strong>Save to Vault</strong>. Discard closes this draft.
              </div>
              <div className="kc-src-actions">
                {viewMode === 'card' ? (
                  <button
                    onClick={() => setViewMode('edit')}
                    aria-label="Edit Recipe"
                    className="kc-src-btn kc-src-btn-edit"
                  >
                    ✎ Edit Recipe
                  </button>
                ) : (
                  <button
                    onClick={() => setViewMode('card')}
                    aria-label="View recipe card"
                    className="kc-src-btn kc-src-btn-edit"
                  >
                    View recipe
                  </button>
                )}
                <button
                  onClick={() => {
                    session.current.advance();
                    dispatch({ type: 'DISCARD' });
                    setEditedDraft(null);
                    setViewMode('card');
                    setLastGenerationMs(null);
                  }}
                  disabled={saving}
                  className="kc-src-btn kc-src-btn-discard"
                >
                  Discard
                </button>
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="kc-src-btn kc-src-btn-save inline-flex items-center gap-2"
                >
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {saving ? 'Saving…' : 'Save to Vault'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm text-gray-300">
              Prompt
              <textarea
                id="create-me-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Create a hearty chicken dinner with pantry staples, ready in about 30 minutes…"
                rows={4}
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-[#0C0C0C] px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-400/25"
              />
            </label>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <input value={servings} onChange={(e) => setServings(e.target.value)} placeholder="Servings" className="min-h-[44px] rounded-lg border border-white/10 bg-[#0C0C0C] px-3 text-sm text-gray-200 placeholder-gray-500 focus:border-amber-500/60 focus:outline-none" />
              <input value={maxTotalMinutes} onChange={(e) => setMaxTotalMinutes(e.target.value)} placeholder="Max time (min)" className="min-h-[44px] rounded-lg border border-white/10 bg-[#0C0C0C] px-3 text-sm text-gray-200 placeholder-gray-500 focus:border-amber-500/60 focus:outline-none" />
              <input value={cuisine} onChange={(e) => setCuisine(e.target.value)} placeholder="Cuisine" className="min-h-[44px] rounded-lg border border-white/10 bg-[#0C0C0C] px-3 text-sm text-gray-200 placeholder-gray-500 focus:border-amber-500/60 focus:outline-none" />
              <input value={course} onChange={(e) => setCourse(e.target.value)} placeholder="Course" className="min-h-[44px] rounded-lg border border-white/10 bg-[#0C0C0C] px-3 text-sm text-gray-200 placeholder-gray-500 focus:border-amber-500/60 focus:outline-none" />
              <input value={dietary} onChange={(e) => setDietary(e.target.value)} placeholder="Dietary (comma sep.)" className="min-h-[44px] rounded-lg border border-white/10 bg-[#0C0C0C] px-3 text-sm text-gray-200 placeholder-gray-500 focus:border-amber-500/60 focus:outline-none" />
              <input value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="Exclude ingredients" className="min-h-[44px] rounded-lg border border-white/10 bg-[#0C0C0C] px-3 text-sm text-gray-200 placeholder-gray-500 focus:border-amber-500/60 focus:outline-none" />
            </div>

            <button
              onClick={() => void generate()}
              disabled={status === 'generating' || !prompt.trim()}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === 'generating' && <Loader2 className="w-4 h-4 animate-spin" />}
              {status === 'generating'
                ? `Generating recipe… ${formatElapsedSeconds(elapsedMs)}`
                : 'Generate'}
            </button>
            {status === 'generating' && (
              <p role="status" data-generation-elapsed="true" className="text-xs text-gray-400">
                Waiting for a validated draft. Nothing is saved while this runs.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default CreateForMeModal;
