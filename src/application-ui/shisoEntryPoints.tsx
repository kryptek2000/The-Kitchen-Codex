/**
 * The Kitchen Codex — SHISO entry points.
 *
 * SHISO has three entry points (global, recipe detail, Advanced Nutrition) and
 * ONE conversation. Rather than thread an `onOpenShiso` callback through four
 * component prop chains, every entry point calls `useShiso().open(...)` and the
 * provider decides whether the single Shiso surface is showing.
 *
 * It carries no authority of its own. It holds the PORTS the application
 * registers: the Advanced Nutrition owner registers the nutrition appliers, and
 * the application shell registers the recipe-edit/save applier. Shiso can ask;
 * the registered owner decides and performs. An absent port fails closed with a
 * bounded message rather than a simulated success.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { LiveRowState } from '../core/nutritionV2/phase4/liveRow';
import type { Phase4Row } from '../core/nutritionV2/phase4';
import {
  INITIAL_SAVE_AUTHORIZATION_STATE,
  beginSaveAuthorization,
  clearSaveAuthorization,
  completeSaveAuthorization,
  issueSaveAuthorization,
  type ShisoSaveAuthorizationState,
  type ShisoSaveGrant,
} from '../core/shiso/saveAuthorization';
import type {
  ShisoAnalysisOutcome,
  ShisoBoundProposal,
  ShisoIngredientEditArgs,
  ShisoNutritionCorrectionsOutcome,
  ShisoRecipeEditOutcome,
  ShisoRecipeSaveOutcome,
} from '../core/shiso/protocol';
import type { ShisoApplyResult } from '../core/shiso/proposalActions';
import type { AiNutrientContribution } from '../core/nutritionV2/aiContribution';

export interface ShisoNutritionAnalysisOutcome {
  readonly ok: boolean;
  readonly contributionCount: number;
  readonly message: string;
}

export type ShisoEntrySource = 'global' | 'recipe' | 'nutrition' | 'create';

export interface ShisoNutritionSnapshot {
  readonly rows: readonly LiveRowState[];
  readonly summary: string | null;
  readonly unsaved: boolean;
  /**
   * The GENUINE Phase 4 identities, published by the Advanced Nutrition owner
   * that holds the working review. Shiso's proposals bind to these; inventing or
   * defaulting an identity here would let a proposal bind to the wrong session.
   */
  readonly recipeKey: string | null;
  readonly sessionIdentity: string | null;
  /** The authoritative Phase 4 rows, used to disclose REAL USDA identities. */
  readonly reviewRows: readonly Phase4Row[];
  /** AI contributions explicitly accepted into this exact unsaved review. */
  readonly aiContributions?: readonly AiNutrientContribution[];
}

/**
 * H-2. The bounded, application-produced summary of the UNSAVED working recipe
 * (Shiso's applied ingredient edits). This is what the one visible banner and
 * the explicit Save / Discard controls render. It never carries authority.
 */
export interface ShisoWorkingRecipeSummary {
  readonly unsaved: boolean;
  /** App-owned durability state; display-only, never save authority. */
  readonly nutrition_unsaved?: boolean;
  readonly change_count: number;
  /** Human-readable change lines, oldest first, bounded by the applier. */
  readonly changes: readonly string[];
}

/**
 * H-2. The recipe-edit port registered by the application shell (the owner of
 * the recipe list, the working copy and the canonical save path):
 *
 *   - `applyEdits` applies structured edits to the UNSAVED working copy;
 *   - `save` persists the working copy through the EXISTING save path, and
 *     REQUIRES a verified save grant: the applier independently re-verifies
 *     authorization and the recipe binding before any write;
 *   - `discard` throws the working copy away (the undo path).
 */
export interface ShisoRecipeEditApplier {
  readonly applyEdits: (edits: readonly ShisoIngredientEditArgs[]) => Promise<ShisoRecipeEditOutcome>;
  readonly save: (grant: ShisoSaveGrant) => Promise<ShisoRecipeSaveOutcome>;
  readonly discard: () => void;
}

/**
 * H-2 SECURITY — how a save was initiated.
 *
 *   - `'ui'`: a genuine Save control in the application UI. The trusted user
 *     event IS the authorization.
 *   - `'assistant'` (default): Shiso asked for the save. It is honored ONLY
 *     when the CURRENT user turn issued a save authorization at send time.
 */
export interface ShisoSaveRequest {
  readonly via?: 'ui' | 'assistant';
}

export interface ShisoEntryPoints {
  readonly open: (source: ShisoEntrySource) => void;
  /** Opens SHISO and starts a complete recipe-nutrition request from a trusted UI action. */
  readonly openForNutritionAnalysis: () => void;
  /** Monotonic UI request id; SHISO consumes each nutrition launch exactly once. */
  readonly nutritionAnalysisRequest: number;
  /** Run the registered structured nutrition path without leaving the review. */
  readonly runNutritionAnalysis: (() => Promise<ShisoNutritionAnalysisOutcome>) | null;
  readonly registerNutritionAnalysisRunner: (
    runner: () => Promise<ShisoNutritionAnalysisOutcome>,
  ) => () => void;
  readonly close: () => void;
  readonly isOpen: boolean;
  readonly source: ShisoEntrySource;
  readonly publishNutrition: (snapshot: ShisoNutritionSnapshot | null) => void;
  readonly snapshot: ShisoNutritionSnapshot | null;
  /**
   * Applies a user-confirmed Shiso proposal to the UNSAVED working review.
   * Registered by Advanced Nutrition, which owns the reducer and the
   * authoritative transitions. Absent means no applier, and the UI must then
   * report the proposal as not applied rather than pretending.
   */
  readonly applyProposal: (bound: ShisoBoundProposal) => Promise<ShisoApplyResult>;
  readonly canApplyProposal: boolean;
  /** Registers the authoritative applier. Returns an unregister function. */
  readonly registerApplier: (
    applier: (bound: ShisoBoundProposal) => Promise<ShisoApplyResult>,
  ) => () => void;
  /**
   * Runs the EXISTING Advanced Nutrition analysis. Registered by the component
   * that owns the analyzer, the matcher and the calculator, so Shiso asks the
   * owner rather than reimplementing any of it. Absent means Advanced Nutrition
   * is not open, and Shiso is told so instead of simulating a result.
   */
  readonly runAnalysis: (() => Promise<ShisoAnalysisOutcome>) | null;
  readonly canRunAnalysis: boolean;
  readonly registerAnalysisApplier: (applier: () => Promise<ShisoAnalysisOutcome>) => () => void;

  // -------------------------------------------------------------------------
  // H-2 — authorized editing ports
  // -------------------------------------------------------------------------

  /** Applies structured edits to the UNSAVED working recipe. */
  readonly applyIngredientEdits: (
    edits: readonly ShisoIngredientEditArgs[],
  ) => Promise<ShisoRecipeEditOutcome>;
  readonly canApplyIngredientEdits: boolean;
  readonly registerRecipeEditApplier: (applier: ShisoRecipeEditApplier) => () => void;
  /**
   * Persists the UNSAVED working recipe through the existing save path.
   *
   * With `via: 'ui'` (the visible Save control) the trusted user event is the
   * authorization. Otherwise the save is honored ONLY when the CURRENT user
   * turn issued a save authorization via `issueSaveAuthorization`; a missing,
   * used, or recipe-mismatched authorization is refused with NO vault write.
   */
  readonly saveWorkingRecipe: (request?: ShisoSaveRequest) => Promise<ShisoRecipeSaveOutcome>;
  readonly canSaveWorkingRecipe: boolean;
  /**
   * H-2 SECURITY. Records the save intent of the user message that is about to
   * be sent, bound to the ACTIVE recipe identity and the current turn. Every
   * call REPLACES the previous authorization (including with "not authorized"),
   * so a new user turn can never inherit an old one. Called by the trusted
   * conversation surface at send time; the model has no path to it.
   */
  readonly issueSaveAuthorization: (input: {
    readonly authorized: boolean;
    readonly recipe_identity: string;
    readonly turn: number;
  }) => void;
  /** Invalidates any outstanding authorization (recipe switch / surface close). */
  readonly clearSaveAuthorization: () => void;
  /** Throws the working copy away. The visible undo path. */
  readonly discardWorkingRecipe: () => void;
  /** Published by the shell that owns the working copy. */
  readonly workingRecipe: ShisoWorkingRecipeSummary | null;
  readonly publishWorkingRecipe: (summary: ShisoWorkingRecipeSummary | null) => void;

  /** Applies every supported authenticated nutrition correction, then recalculates. */
  readonly applyNutritionCorrections: (
    lineRefs?: readonly string[],
  ) => Promise<ShisoNutritionCorrectionsOutcome>;
  readonly canApplyNutritionCorrections: boolean;
  readonly registerCorrectionsApplier: (
    applier: (lineRefs?: readonly string[]) => Promise<ShisoNutritionCorrectionsOutcome>,
  ) => () => void;
  readonly acceptAiNutrition: (contributions: readonly AiNutrientContribution[]) => boolean;
  readonly canAcceptAiNutrition: boolean;
  readonly registerAiNutritionApplier: (applier: (contributions: readonly AiNutrientContribution[]) => boolean) => () => void;
}

const INERT: ShisoEntryPoints = {
  open: () => {},
  openForNutritionAnalysis: () => {},
  nutritionAnalysisRequest: 0,
  runNutritionAnalysis: null,
  registerNutritionAnalysisRunner: () => () => {},
  close: () => {},
  isOpen: false,
  source: 'global',
  publishNutrition: () => {},
  snapshot: null,
  applyProposal: async () => ({ ok: false, reason: 'no_active_review', message: 'Open Advanced Nutrition first.' }),
  canApplyProposal: false,
  registerApplier: () => () => {},
  runAnalysis: null,
  canRunAnalysis: false,
  registerAnalysisApplier: () => () => {},
  applyIngredientEdits: async () => ({
    ok: false,
    applied: [],
    refused: [],
    summary: 'The recipe editor is not available.',
    working_unsaved: false,
    note: '',
  }),
  canApplyIngredientEdits: false,
  registerRecipeEditApplier: () => () => {},
  saveWorkingRecipe: async () => ({
    ok: false,
    saved: false,
    reason_code: 'no_owner',
    message: 'There is nothing to save.',
  }),
  canSaveWorkingRecipe: false,
  issueSaveAuthorization: () => {},
  clearSaveAuthorization: () => {},
  discardWorkingRecipe: () => {},
  workingRecipe: null,
  publishWorkingRecipe: () => {},
  applyNutritionCorrections: async () => ({
    ok: false,
    applied: [],
    unresolved: [],
    summary: 'The nutrition review owner is not available.',
    resolved_count: 0,
    total_count: 0,
    recalculation: 'absent',
    working_unsaved: false,
  }),
  canApplyNutritionCorrections: false,
  registerCorrectionsApplier: () => () => {},
  acceptAiNutrition: () => false,
  canAcceptAiNutrition: false,
  registerAiNutritionApplier: () => () => {},
};

const ShisoEntryContext = createContext<ShisoEntryPoints>(INERT);

export function ShisoEntryProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; source: ShisoEntrySource; nutritionAnalysisRequest: number }>({
    open: false,
    source: 'global',
    nutritionAnalysisRequest: 0,
  });
  const [snapshot, setSnapshot] = useState<ShisoNutritionSnapshot | null>(null);
  const [applier, setApplier] = useState<((b: ShisoBoundProposal) => Promise<ShisoApplyResult>) | null>(null);
  const [analysisApplier, setAnalysisApplier] = useState<(() => Promise<ShisoAnalysisOutcome>) | null>(null);
  const [nutritionAnalysisRunner, setNutritionAnalysisRunner] = useState<(() => Promise<ShisoNutritionAnalysisOutcome>) | null>(null);
  const [recipeEditApplier, setRecipeEditApplier] = useState<ShisoRecipeEditApplier | null>(null);
  const [correctionsApplier, setCorrectionsApplier] = useState<
    ((lineRefs?: readonly string[]) => Promise<ShisoNutritionCorrectionsOutcome>) | null
  >(null);
  const [aiNutritionApplier, setAiNutritionApplier] = useState<((contributions: readonly AiNutrientContribution[]) => boolean) | null>(null);
  const [workingRecipe, setWorkingRecipe] = useState<ShisoWorkingRecipeSummary | null>(null);
  /**
   * H-2 SECURITY — the single-slot, per-turn save authorization. It lives in a
   * ref because it is CONSUMED synchronously at the moment of the save decision;
   * no render is required for a security decision.
   */
  const saveAuthorizationRef = useRef<ShisoSaveAuthorizationState>(INITIAL_SAVE_AUTHORIZATION_STATE);

  const open = useCallback((source: ShisoEntrySource) => {
    setState((previous) => ({ ...previous, open: true, source }));
  }, []);
  const openForNutritionAnalysis = useCallback(() => {
    setState((previous) => ({
      ...previous,
      open: true,
      source: 'nutrition',
      nutritionAnalysisRequest: previous.nutritionAnalysisRequest + 1,
    }));
  }, []);
  const close = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);
  const publishNutrition = useCallback((next: ShisoNutritionSnapshot | null) => {
    setSnapshot(next);
  }, []);
  const publishWorkingRecipe = useCallback((next: ShisoWorkingRecipeSummary | null) => {
    setWorkingRecipe(next);
  }, []);
  const registerApplier = useCallback(
    (next: (bound: ShisoBoundProposal) => Promise<ShisoApplyResult>) => {
      setApplier(() => next);
      return () => setApplier(null);
    },
    [],
  );
  const registerAnalysisApplier = useCallback((next: () => Promise<ShisoAnalysisOutcome>) => {
    setAnalysisApplier(() => next);
    return () => setAnalysisApplier(null);
  }, []);
  const registerNutritionAnalysisRunner = useCallback((next: () => Promise<ShisoNutritionAnalysisOutcome>) => {
    setNutritionAnalysisRunner(() => next);
    return () => setNutritionAnalysisRunner((current) => current === next ? null : current);
  }, []);
  const runNutritionAnalysis = useCallback(async (): Promise<ShisoNutritionAnalysisOutcome> => {
    if (nutritionAnalysisRunner === null) {
      return { ok: false, contributionCount: 0, message: 'SHISO nutrition analysis is not available right now. You can calculate without AI.' };
    }
    return nutritionAnalysisRunner();
  }, [nutritionAnalysisRunner]);
  const registerRecipeEditApplier = useCallback((next: ShisoRecipeEditApplier) => {
    setRecipeEditApplier(next);
    return () => setRecipeEditApplier(null);
  }, []);
  const registerCorrectionsApplier = useCallback(
    (next: (lineRefs?: readonly string[]) => Promise<ShisoNutritionCorrectionsOutcome>) => {
      setCorrectionsApplier(() => next);
      return () => setCorrectionsApplier(null);
    },
    [],
  );
  const registerAiNutritionApplier = useCallback((next: (contributions: readonly AiNutrientContribution[]) => boolean) => {
    setAiNutritionApplier(() => next);
    return () => setAiNutritionApplier(null);
  }, []);
  const acceptAiNutrition = useCallback((contributions: readonly AiNutrientContribution[]) => aiNutritionApplier?.(contributions) ?? false, [aiNutritionApplier]);
  const runAnalysis = useCallback(async (): Promise<ShisoAnalysisOutcome> => {
    if (analysisApplier === null) {
      return {
        ok: false,
        analyzed: false,
        summary: 'Advanced Nutrition is not open for this recipe.',
        matched: 0,
        needs_amount: 0,
        needs_match: 0,
        total_lines: 0,
        unresolved_line_refs: [],
        preview_state: 'absent',
        message: 'Open Advanced Nutrition for this recipe and the analysis will run there.',
      };
    }
    return analysisApplier();
  }, [analysisApplier]);
  const applyProposal = useCallback(
    async (bound: ShisoBoundProposal) => {
      if (applier === null) {
        return {
          ok: false,
          reason: 'no_active_review',
          message: 'Open Advanced Nutrition to review and apply this suggestion.',
        } as ShisoApplyResult;
      }
      return applier(bound);
    },
    [applier],
  );
  const applyIngredientEdits = useCallback(
    async (edits: readonly ShisoIngredientEditArgs[]) => {
      if (recipeEditApplier === null) {
        return {
          ok: false,
          applied: [],
          refused: edits.map((edit) => ({
            line_ref: edit.line_ref,
            reason: 'no_edit_owner',
            message: 'No recipe is open to edit.',
          })),
          summary: 'No recipe is open to edit.',
          working_unsaved: false,
          note: '',
        } as ShisoRecipeEditOutcome;
      }
      return recipeEditApplier.applyEdits(edits);
    },
    [recipeEditApplier],
  );
  const saveWorkingRecipe = useCallback(
    async (request?: ShisoSaveRequest): Promise<ShisoRecipeSaveOutcome> => {
      if (recipeEditApplier === null) {
        return {
          ok: false,
          saved: false,
          reason_code: 'no_owner',
          message: 'There is nothing to save.',
        };
      }
      const via = request?.via ?? 'assistant';
      if (via === 'ui') {
        // A genuine Save control. The trusted user event IS the authorization;
        // the applier still re-verifies the grant structurally.
        return recipeEditApplier.save({
          authorized: true,
          via: 'ui',
          recipe_identity: '',
          turn: 0,
        });
      }
      // Assistant path: require a CURRENT, unconsumed authorization issued from
      // THE USER'S OWN MESSAGE of this turn. No authorization means no write.
      const decision = beginSaveAuthorization(saveAuthorizationRef.current);
      if (decision.ok !== true) {
        saveAuthorizationRef.current = decision.state;
        return {
          ok: false,
          saved: false,
          reason_code: 'not_authorized',
          message:
            decision.reason === 'in_flight'
              ? 'A save is already in progress.'
              : 'Saving needs your explicit instruction (for example “save my changes”) or the Save button. Nothing was saved.',
        };
      }
      saveAuthorizationRef.current = decision.state;
      let result: ShisoRecipeSaveOutcome;
      try {
        result = await recipeEditApplier.save(decision.grant);
      } catch {
        saveAuthorizationRef.current = completeSaveAuthorization(saveAuthorizationRef.current, false);
        return { ok: false, saved: false, reason_code: 'write_failed', message: 'The recipe could not be saved.' };
      }
      // A SUCCESSFUL save consumes this turn's authorization (replay prevention).
      // A failed or empty attempt does not burn it.
      saveAuthorizationRef.current = completeSaveAuthorization(saveAuthorizationRef.current, result.saved === true);
      return result;
    },
    [recipeEditApplier],
  );
  const issueSaveAuthorizationEntry = useCallback(
    (input: { readonly authorized: boolean; readonly recipe_identity: string; readonly turn: number }) => {
      saveAuthorizationRef.current = issueSaveAuthorization({
        state: saveAuthorizationRef.current,
        authorized: input.authorized,
        recipe_identity: input.recipe_identity,
        turn: input.turn,
      });
    },
    [],
  );
  const clearSaveAuthorizationEntry = useCallback(() => {
    saveAuthorizationRef.current = clearSaveAuthorization(saveAuthorizationRef.current);
  }, []);
  const discardWorkingRecipe = useCallback(() => {
    if (recipeEditApplier !== null) recipeEditApplier.discard();
  }, [recipeEditApplier]);
  const applyNutritionCorrections = useCallback(
    async (lineRefs?: readonly string[]) => {
      if (correctionsApplier === null) {
        return {
          ok: false,
          applied: [],
          unresolved: [],
          summary: 'The nutrition review is not open for this recipe.',
          resolved_count: 0,
          total_count: 0,
          recalculation: 'absent',
          working_unsaved: false,
        } as ShisoNutritionCorrectionsOutcome;
      }
      return correctionsApplier(lineRefs);
    },
    [correctionsApplier],
  );

  const value = useMemo<ShisoEntryPoints>(
    () => ({
      open,
      openForNutritionAnalysis,
      nutritionAnalysisRequest: state.nutritionAnalysisRequest,
      runNutritionAnalysis,
      registerNutritionAnalysisRunner,
      close,
      isOpen: state.open,
      source: state.source,
      publishNutrition,
      snapshot,
      applyProposal,
      canApplyProposal: applier !== null,
      registerApplier,
      runAnalysis,
      canRunAnalysis: analysisApplier !== null,
      registerAnalysisApplier,
      applyIngredientEdits,
      canApplyIngredientEdits: recipeEditApplier !== null,
      registerRecipeEditApplier,
      saveWorkingRecipe,
      canSaveWorkingRecipe: recipeEditApplier !== null,
      issueSaveAuthorization: issueSaveAuthorizationEntry,
      clearSaveAuthorization: clearSaveAuthorizationEntry,
      discardWorkingRecipe,
      workingRecipe,
      publishWorkingRecipe,
      applyNutritionCorrections,
      canApplyNutritionCorrections: correctionsApplier !== null,
      registerCorrectionsApplier,
      acceptAiNutrition,
      canAcceptAiNutrition: aiNutritionApplier !== null,
      registerAiNutritionApplier,
    }),
    [
      open, openForNutritionAnalysis, state.nutritionAnalysisRequest, runNutritionAnalysis, registerNutritionAnalysisRunner,
      close, state.open, state.source, publishNutrition, snapshot,
      applyProposal, applier, registerApplier, runAnalysis, analysisApplier,
      registerAnalysisApplier, applyIngredientEdits, recipeEditApplier,
      registerRecipeEditApplier, saveWorkingRecipe, issueSaveAuthorizationEntry,
      clearSaveAuthorizationEntry, discardWorkingRecipe,
      workingRecipe, publishWorkingRecipe, applyNutritionCorrections,
      correctionsApplier, registerCorrectionsApplier,
      acceptAiNutrition, aiNutritionApplier, registerAiNutritionApplier,
    ],
  );

  return <ShisoEntryContext.Provider value={value}>{children}</ShisoEntryContext.Provider>;
}

/** Every Shiso entry point. Outside the provider it is inert, never a crash. */
export function useShiso(): ShisoEntryPoints {
  return useContext(ShisoEntryContext);
}
