/**
 * The Kitchen Codex — Create for Me UI state machine (v0.7 Phase 2A correction 2).
 *
 * Pure, platform-neutral reducer describing the modal's lifecycle so the
 * generation/save error-state behavior can be tested deterministically (no React,
 * no DOM, no network). The important invariant this guards: a successful generation
 * NEVER leaves a stale failure message, and retrying clears any prior error.
 */

import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from '../schema/generatedRecipe';

export type CreateForMeStatus = 'prompt' | 'generating' | 'draft' | 'error';

export interface CreateForMeState {
  status: CreateForMeStatus;
  /** Bounded user-facing message. null = no message. */
  error: string | null;
  draft: GeneratedRecipeDraft | null;
  provenance: GeneratedRecipeProvenance | null;
  /** True only while a save is in flight (used to disable duplicate submits). */
  saving: boolean;
}

export const initialCreateForMeState: CreateForMeState = {
  status: 'prompt',
  error: null,
  draft: null,
  provenance: null,
  saving: false,
};

export type CreateForMeEvent =
  | { type: 'START_GENERATION' }
  | { type: 'GENERATION_SUCCESS'; draft: GeneratedRecipeDraft; provenance: GeneratedRecipeProvenance }
  | { type: 'GENERATION_FAILURE'; message: string }
  | { type: 'BEGIN_SAVE' }
  | { type: 'SAVE_COLLISION'; message: string }
  | { type: 'SAVE_FAILURE'; message: string }
  | { type: 'SAVE_SUCCESS' }
  | { type: 'DISCARD' }
  | { type: 'CLOSE' };

export function createForMeReducer(state: CreateForMeState, event: CreateForMeEvent): CreateForMeState {
  switch (event.type) {
    // A new generation attempt clears any stale error immediately and shows the
    // disabled "Generating…" state.
    case 'START_GENERATION':
      return { ...state, status: 'generating', error: null, saving: false };
    case 'GENERATION_SUCCESS':
      // Successful generation: draft shown, NO failure message (fixes Astra bug B).
      return { status: 'draft', error: null, draft: event.draft, provenance: event.provenance, saving: false };
    case 'GENERATION_FAILURE':
      return { ...state, status: 'error', error: event.message, saving: false };
    case 'BEGIN_SAVE':
      // Marking saving clears a prior save error so the UI is truthful about the
      // in-flight write; the draft stays editable.
      return { ...state, status: 'draft', saving: true, error: null };
    case 'SAVE_COLLISION':
      return { ...state, status: 'draft', saving: false, error: event.message };
    case 'SAVE_FAILURE':
      return { ...state, status: 'draft', saving: false, error: event.message };
    case 'SAVE_SUCCESS':
      return initialCreateForMeState;
    case 'DISCARD':
    case 'CLOSE':
      return initialCreateForMeState;
    default:
      return state;
  }
}
