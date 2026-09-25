/**
 * The Kitchen Codex — Advanced Nutrition Phase 4: explicit UI state machine.
 *
 * PURE, offline. A closed reducer over the review workflow:
 *   unavailable → ready → (preview_current | preview_stale) | invalid.
 *
 * Invariants enforced here (not in React):
 *   - changing a match invalidates its portion choice AND the preview;
 *   - changing a portion invalidates the preview;
 *   - changing the display basis or requested servings NEVER reruns matching and
 *     NEVER mutates the total baseline;
 *   - a stale calculation result (older operation sequence or a different
 *     recipe) can never overwrite newer state;
 *   - opening/closing the modal never persists or applies anything.
 */

import { isValidStrictServingCount } from '../calculation/servings';
import {
  PHASE4_STATE_VERSION,
  phase4Failure,
  type BasisMode,
  type CountPortionChoice,
  type HouseholdPortionChoice,
  type MatchChoice,
  type Phase4Action,
  type Phase4Row,
  type Phase4State,
  type PortionChoice,
} from './types';

export const INITIAL_PHASE4_STATE: Phase4State = Object.freeze({
  version: PHASE4_STATE_VERSION,
  status: 'unavailable',
  recipeKey: null,
  sessionIdentity: null,
  baseServings: 1,
  rows: Object.freeze([]),
  matches: Object.freeze({}),
  portions: Object.freeze({}),
  countPortions: Object.freeze({}),
  userMasses: Object.freeze({}),
  householdPortions: Object.freeze({}),
  basis: 'entire_recipe',
  selectedServings: 1,
  preview: null,
  previewKey: null,
  failure: null,
  operationSeq: 0,
});

function withPreviewStale(state: Phase4State): Phase4State {
  if (state.preview === null) return state;
  return { ...state, status: 'preview_stale' };
}

function isValidBaseServings(value: unknown): value is number {
  return isValidStrictServingCount(value);
}

export function phase4Reducer(state: Phase4State, action: Phase4Action): Phase4State {
  switch (action.type) {
    case 'initialize': {
      // Re-initialization is a no-op ONLY when both the recipe identity AND the
      // authoritative session identity are unchanged. If the session authority
      // changes while the recipe key stays identical, every selection and the
      // preview are invalidated.
      if (
        state.recipeKey === action.recipeKey &&
        state.sessionIdentity === action.sessionIdentity
      ) {
        return state;
      }
      const baseServings = isValidBaseServings(action.baseServings) ? action.baseServings : 1;
      return {
        ...INITIAL_PHASE4_STATE,
        status: 'ready',
        recipeKey: action.recipeKey,
        sessionIdentity: action.sessionIdentity,
        baseServings,
        selectedServings: baseServings,
        rows: action.rows,
        operationSeq: state.operationSeq + 1,
      };
    }

    case 'reset': {
      return {
        ...INITIAL_PHASE4_STATE,
        operationSeq: state.operationSeq + 1,
      };
    }

    case 'hydrate': {
      // Reconstruct the working review from a saved Advanced result for an
      // unchanged recipe. This is NOT a user edit: the working state is not
      // marked dirty, and no preview is invalidated (none exists yet).
      if (state.recipeKey === null) return state;
      return {
        ...state,
        matches: action.matches,
        portions: action.portions,
        countPortions: action.countPortions,
        userMasses: action.userMasses,
        householdPortions: action.householdPortions,
        failure: null,
      };
    }

    case 'select_match': {
      if (state.recipeKey === null) return state;
      if (!state.rows.some((row) => row.line_ref === action.lineRef)) return state;
      const matches = { ...state.matches, [action.lineRef]: action.choice };
      const portions = { ...state.portions };
      delete portions[action.lineRef];
      const countPortions = { ...state.countPortions };
      delete countPortions[action.lineRef];
      const userMasses = { ...state.userMasses };
      delete userMasses[action.lineRef];
      const householdPortions = { ...state.householdPortions };
      delete householdPortions[action.lineRef];
      const next: Phase4State = {
        ...state,
        matches,
        portions,
        countPortions,
        userMasses,
        householdPortions,
        failure: null,
        operationSeq: state.operationSeq + 1,
      };
      return withPreviewStale(next);
    }

    case 'select_portion': {
      if (state.recipeKey === null) return state;
      if (!state.rows.some((row) => row.line_ref === action.lineRef)) return state;
      const portions = { ...state.portions, [action.lineRef]: action.choice };
      // Mass sources are mutually exclusive.
      const countPortions = { ...state.countPortions };
      delete countPortions[action.lineRef];
      const userMasses = { ...state.userMasses };
      delete userMasses[action.lineRef];
      const householdPortions = { ...state.householdPortions };
      delete householdPortions[action.lineRef];
      const next: Phase4State = {
        ...state,
        portions,
        countPortions,
        userMasses,
        householdPortions,
        failure: null,
        operationSeq: state.operationSeq + 1,
      };
      return withPreviewStale(next);
    }

    case 'clear_portion': {
      if (!(action.lineRef in state.portions)) return state;
      const portions = { ...state.portions };
      delete portions[action.lineRef];
      const next: Phase4State = { ...state, portions, failure: null, operationSeq: state.operationSeq + 1 };
      return withPreviewStale(next);
    }

    case 'select_count_portion': {
      if (state.recipeKey === null) return state;
      if (!state.rows.some((row) => row.line_ref === action.lineRef)) return state;
      const countPortions = { ...state.countPortions, [action.lineRef]: action.choice };
      // Mass sources are mutually exclusive.
      const portions = { ...state.portions };
      delete portions[action.lineRef];
      const userMasses = { ...state.userMasses };
      delete userMasses[action.lineRef];
      const householdPortions = { ...state.householdPortions };
      delete householdPortions[action.lineRef];
      const next: Phase4State = {
        ...state,
        countPortions,
        portions,
        userMasses,
        householdPortions,
        failure: null,
        operationSeq: state.operationSeq + 1,
      };
      return withPreviewStale(next);
    }

    case 'clear_count_portion': {
      if (!(action.lineRef in state.countPortions)) return state;
      const countPortions = { ...state.countPortions };
      delete countPortions[action.lineRef];
      const next: Phase4State = { ...state, countPortions, failure: null, operationSeq: state.operationSeq + 1 };
      return withPreviewStale(next);
    }

    case 'select_user_mass': {
      if (state.recipeKey === null) return state;
      if (!state.rows.some((row) => row.line_ref === action.lineRef)) return state;
      const userMasses = { ...state.userMasses, [action.lineRef]: action.choice };
      // Mutually exclusive with the other mass sources.
      const portions = { ...state.portions };
      delete portions[action.lineRef];
      const countPortions = { ...state.countPortions };
      delete countPortions[action.lineRef];
      const householdPortions = { ...state.householdPortions };
      delete householdPortions[action.lineRef];
      const next: Phase4State = {
        ...state,
        userMasses,
        portions,
        countPortions,
        householdPortions,
        failure: null,
        operationSeq: state.operationSeq + 1,
      };
      return withPreviewStale(next);
    }

    case 'select_household_portion': {
      if (state.recipeKey === null) return state;
      if (!state.rows.some((row) => row.line_ref === action.lineRef)) return state;
      const householdPortions = { ...state.householdPortions, [action.lineRef]: action.choice };
      // Mass sources are mutually exclusive: a verified household portion only
      // applies when no higher-authority stored source is active.
      const portions = { ...state.portions };
      delete portions[action.lineRef];
      const countPortions = { ...state.countPortions };
      delete countPortions[action.lineRef];
      const userMasses = { ...state.userMasses };
      delete userMasses[action.lineRef];
      const next: Phase4State = {
        ...state,
        householdPortions,
        portions,
        countPortions,
        userMasses,
        failure: null,
        operationSeq: state.operationSeq + 1,
      };
      return withPreviewStale(next);
    }

    case 'clear_household_portion': {
      if (!(action.lineRef in state.householdPortions)) return state;
      const householdPortions = { ...state.householdPortions };
      delete householdPortions[action.lineRef];
      const next: Phase4State = {
        ...state,
        householdPortions,
        failure: null,
        operationSeq: state.operationSeq + 1,
      };
      return withPreviewStale(next);
    }

    case 'clear_user_mass': {
      if (!(action.lineRef in state.userMasses)) return state;
      const userMasses = { ...state.userMasses };
      delete userMasses[action.lineRef];
      const next: Phase4State = { ...state, userMasses, failure: null, operationSeq: state.operationSeq + 1 };
      return withPreviewStale(next);
    }

    case 'set_basis': {
      if (state.basis === action.basis) return state;
      // Display-only: never reruns matching and never mutates the total baseline.
      return { ...state, basis: action.basis };
    }

    case 'set_servings': {
      if (!isValidStrictServingCount(action.value)) {
        // Keep the last valid view; surface bounded feedback only.
        return { ...state, failure: phase4Failure('invalid_servings') };
      }
      if (state.selectedServings === action.value) return state;
      // Display-only: derived from the immutable total baseline.
      return { ...state, selectedServings: action.value, failure: null };
    }

    case 'apply_analysis': {
      if (state.recipeKey === null) return state;
      const next: Phase4State = {
        ...state,
        matches: action.matches,
        portions: action.portions,
        countPortions: action.countPortions,
        householdPortions: action.householdPortions,
        // A plain analyzer run clears user masses; a Re-analyze that preserves
        // reviewed user-entered weights carries them through explicitly.
        userMasses: action.userMasses ?? Object.freeze({}),
        failure: null,
        operationSeq: state.operationSeq + 1,
      };
      if (action.preview) {
        return {
          ...next,
          status: 'preview_current',
          preview: action.preview,
          previewKey: state.recipeKey,
        };
      }
      return { ...next, status: 'ready' };
    }

    case 'preview_succeeded': {
      if (action.seq !== state.operationSeq) return state;
      if (action.recipeKey !== state.recipeKey) return state;
      return {
        ...state,
        status: 'preview_current',
        preview: action.preview,
        previewKey: action.recipeKey,
        failure: null,
      };
    }

    case 'preview_failed': {
      if (action.seq !== state.operationSeq) return state;
      return { ...state, status: 'ready', failure: action.failure };
    }

    case 'dismiss_failure': {
      if (state.failure === null) return state;
      return { ...state, failure: null };
    }

    default:
      return state;
  }
}

/** True when the current preview is bound to the current recipe/inputs. */
export function isPreviewCurrent(state: Phase4State): boolean {
  return (
    state.status === 'preview_current' &&
    state.preview !== null &&
    state.previewKey !== null &&
    state.previewKey === state.recipeKey
  );
}

export type {
  Phase4Action,
  Phase4State,
  Phase4Row,
  MatchChoice,
  PortionChoice,
  CountPortionChoice,
  BasisMode,
};
