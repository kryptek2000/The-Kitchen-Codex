import { shisoNutritionFailureMessage } from '../application/shisoNutritionResponse';
/**
 * The Kitchen Codex — CHAT WITH SHISO.
 *
 * One surface, three entry points (global, recipe detail, Advanced Nutrition).
 * Every entry point supplies a CONTEXT to the same conversation; none of them
 * starts a different assistant.
 *
 * The UI is intentionally thin. It renders a transcript, sends a bounded turn to
 * the conversation orchestrator, and shows whatever capabilities Shiso actually
 * used. It never invents a reply and never displays a fabricated nutrition
 * value.
 *
 * H-2: Shiso may now EXECUTE authorized edits — ingredient changes, nutrition
 * corrections, and an explicit save. Everything it executes goes through the
 * application ports registered by the owners of that state; this component
 * itself writes nothing. Recipe changes live in an UNSAVED working copy and are
 * shown in one visible banner with an explicit Save and an undo (Discard).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Send, X, Wrench, CircleAlert, Undo2 } from 'lucide-react';

import {
  initialShisoConversation,
  runShisoConversationTurn,
  type ShisoConversationState,
} from '../application/shisoConversation';
import type { ShisoToolContext } from '../application/shisoTools';
import type { NetworkAdapter } from '../application/adapters/NetworkAdapter';
import type { AdvancedNutritionSession } from '../core/nutritionV2/phase4';
import type { LiveRowState } from '../core/nutritionV2/phase4/liveRow';
import type { Phase4Row } from '../core/nutritionV2/phase4';
import { validateAiNutrientContributions, sumAiNutrientContributions } from '../core/nutritionV2/aiContribution';
import { deriveNutritionCoverage, nutritionCoverageSummary } from '../core/shiso/nutritionCoverage';
import type { AiNutrientContribution } from '../core/nutritionV2/aiContribution';
import { buildAiSelectionRequestOptions } from '../application/aiSelection';

import { useShisoRecipeContext } from '../application-ui/useShisoRecipeContext';
import { useShiso, type ShisoNutritionAnalysisOutcome } from '../application-ui/shisoEntryPoints';
import type { ShisoBoundProposal } from '../core/shiso/protocol';
import { buildIdentityDisclosure } from '../core/shiso/disclosure';
import { classifySaveIntent, recipeIdentityOf } from '../core/shiso/saveAuthorization';
import { requestGeneratedRecipe, parseEditedDraftLines, CreateRecipeClientError } from '../utils/createForMe';
import { normalizeGeneratedRecipeDraft, type GeneratedRecipeDraft, type GeneratedRecipeProvenance } from '../schema/generatedRecipe';
import { GeneratedRecipePathCollisionError, GENERATED_RECIPE_COLLISION_MESSAGE } from '../application/createForMe';

export interface ShisoModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly network: NetworkAdapter;
  /**
   * The CURRENT display recipe (the UNSAVED working copy when Shiso edits
   * exist). Only bounded fields are read; the raw vault note never reaches the
   * model.
   */
  readonly recipe: {
    readonly title: string;
    readonly filePath?: string;
    readonly id?: string;
    readonly fileName?: string;
    readonly servings?: number | string;
    readonly ingredients?: ReadonlyArray<{
      readonly name: string;
      readonly original?: string;
      readonly quantity?: number;
      readonly amount?: number | null;
      readonly unit?: string;
    }>;
    readonly instructions?: ReadonlyArray<{ readonly text: string }>;
  } | null;
  readonly nutritionSession: AdvancedNutritionSession | null;
  /**
   * H-1F. Loads the authenticated USDA bundle through the application's OWN
   * controller. The catalogue is never loaded at startup, so without this a
   * recipe-page nutrition request could only fail.
   */
  readonly loadNutritionBundle?: (() => Promise<void>) | undefined;
  readonly nutritionRows: readonly LiveRowState[];
  readonly nutritionAiContributions?: readonly AiNutrientContribution[];
  /** The AUTHORITATIVE review rows. Proposals are disclosed from these, never from prose. */
  readonly nutritionReviewRows: readonly Phase4Row[];
  readonly nutritionSummary: string | null;
  readonly nutritionUnsaved: boolean;
  /** Save adapter for a newly generated draft; the application owns persistence. */
  readonly onSaveCreatedDraft?: (draft: GeneratedRecipeDraft, provenance: GeneratedRecipeProvenance) => Promise<void>;
}

interface TranscriptEntry {
  readonly key: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly tools: readonly string[];
}

const SERVING_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
});

/** Extract only plainly stated serving counts; ambiguous quantities stay in the prompt. */
export function explicitServingCount(message: string): number | undefined {
  const source = message.toLowerCase();
  const match = /\b(?:for|serves?|servings?)\s+(?:about\s+)?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b|\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:people|persons|servings|portions)\b/.exec(source);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const count = /^\d+$/.test(raw) ? Number(raw) : SERVING_WORDS[raw];
  return Number.isInteger(count) && count >= 1 && count <= 100 ? count : undefined;
}

export function ShisoModal({
  isOpen,
  onClose,
  network,
  recipe,
  nutritionSession,
  loadNutritionBundle,
  nutritionRows,
  nutritionAiContributions = [],
  nutritionReviewRows,
  nutritionSummary,
  nutritionUnsaved,
  onSaveCreatedDraft,
}: ShisoModalProps) {
  const [conversation, setConversation] = useState<ShisoConversationState>(initialShisoConversation);
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<ReadonlyArray<string>>([]);
  const [rejectedIds, setRejectedIds] = useState<ReadonlyArray<string>>([]);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyReport, setApplyReport] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveReport, setSaveReport] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [createdDraft, setCreatedDraft] = useState<GeneratedRecipeDraft | null>(null);
  const [createdProvenance, setCreatedProvenance] = useState<GeneratedRecipeProvenance | null>(null);
  const [priorCreatedDraft, setPriorCreatedDraft] = useState<{ draft: GeneratedRecipeDraft; provenance: GeneratedRecipeProvenance } | null>(null);
  const [createdTitle, setCreatedTitle] = useState('');
  const [createdDescription, setCreatedDescription] = useState('');
  const [createdServings, setCreatedServings] = useState('');
  const [createdIngredients, setCreatedIngredients] = useState('');
  const [createdSteps, setCreatedSteps] = useState('');
  const [createdSaveBusy, setCreatedSaveBusy] = useState(false);
  const [createdSaveMessage, setCreatedSaveMessage] = useState<string | null>(null);
  const [createdSaveError, setCreatedSaveError] = useState<string | null>(null);
  const shiso = useShiso();
  const creationMode = shiso.source === 'create';
  const seqRef = useRef(0);
  const activeTurnControllerRef = useRef<AbortController | null>(null);
  // H-2: the LATEST Shiso port surface. The conversation turn can outlive a
  // render (it awaits tool executions), so tools must never read a stale
  // closure of the ports — an edit applied mid-turn changes the recipe, and the
  // next tool in the SAME turn must see the new state.
  const shisoRef = useRef(shiso);
  shisoRef.current = shiso;
  // I-1: the identity is whatever the Advanced Nutrition OWNER published. It is
  // never defaulted or invented here — with no genuine session identity no
  // proposal can bind, which is the correct fail-closed behaviour.
  const recipeKey = shiso.snapshot?.recipeKey ?? null;
  const sessionIdentity = shiso.snapshot?.sessionIdentity ?? null;

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setStatus(null);
    }
  }, [isOpen]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries]);

  // Switching recipe must never leave the old conversation implying the old
  // ingredient context, so the transcript resets on a real identity change.
  //
  // H-2: the identity is the RECIPE's stable identity plus the nutrition
  // session identity — deliberately NOT the content-derived Phase 4 recipe key.
  // An authorized ingredient edit changes that key by design, and resetting the
  // conversation mid-flow would erase the very request the user is completing.
  // Staleness of individual proposals is still enforced by their own binding.
  const stableRecipeIdentity = recipeIdentityOf(recipe) || 'none';
  const identity = `${stableRecipeIdentity}|${sessionIdentity ?? 'none'}|${shiso.source}`;
  const lastIdentityRef = useRef(identity);
  useEffect(() => {
    if (lastIdentityRef.current !== identity) {
      activeTurnControllerRef.current?.abort();
      activeTurnControllerRef.current = null;
      lastIdentityRef.current = identity;
      seqRef.current += 1;
      setBusy(false);
      setStatus(null);
      setConversation(initialShisoConversation());
      setEntries([]);
      setStatus(null);
      setAppliedIds([]);
      setRejectedIds([]);
      setApplyReport(null);
      setApplyError(null);
      // H-2 SECURITY: switching the active recipe invalidates any outstanding
      // save authorization outright.
      shisoRef.current.clearSaveAuthorization();
    }
  }, [identity]);

  // H-2 SECURITY: closing the surface also invalidates any outstanding save
  // authorization, so a later reopen can never inherit one.
  useEffect(() => {
    if (!isOpen) {
      activeTurnControllerRef.current?.abort();
      activeTurnControllerRef.current = null;
      seqRef.current += 1;
      setBusy(false);
      setStatus(null);
      shisoRef.current.clearSaveAuthorization();
    }
  }, [isOpen]);

  useEffect(() => () => {
    activeTurnControllerRef.current?.abort();
    activeTurnControllerRef.current = null;
    // A remounted surface must never inherit authorization from a cancelled
    // turn, even if the owning provider outlives this modal component.
    shisoRef.current.clearSaveAuthorization();
  }, []);

  const recipeContext = useShisoRecipeContext(recipe);
  const nutritionRowsMatchRecipe = recipeContext !== null &&
    recipeContext.ingredients.length === nutritionRows.length &&
    recipeContext.ingredients.every((ingredient, index) => ingredient.line_ref === nutritionRows[index]?.line_ref);
  const nutritionAvailable = nutritionSession !== null && nutritionRows.length > 0 && nutritionRowsMatchRecipe;
  const nutritionCoverage = useMemo(
    () => nutritionAvailable ? deriveNutritionCoverage(nutritionRows, nutritionAiContributions) : deriveNutritionCoverage([]),
    [nutritionAvailable, nutritionRows, nutritionAiContributions]
  );
  const effectiveNutritionSummary = nutritionAvailable ? nutritionCoverageSummary(nutritionCoverage) : null;

  // H-2: the tool context exposes LIVE getters. The turn loop executes tools
  // between awaits, and an authorized edit applied mid-turn changes the recipe
  // and the nutrition review; the NEXT tool in the same turn must observe the
  // updated state rather than a stale snapshot captured at send time.
  const latest = useRef({
    session: nutritionSession,
    recipeContext,
    nutritionAvailable,
    nutritionRows,
    nutritionAiContributions,
    nutritionSummary,
    nutritionUnsaved,
    canEdit: shiso.canApplyIngredientEdits,
    canCorrect: shiso.canApplyNutritionCorrections,
    canSave: shiso.canSaveWorkingRecipe,
    loadNutritionBundle,
  });
  latest.current = {
    session: nutritionSession,
    recipeContext,
    nutritionAvailable,
    nutritionRows,
    nutritionAiContributions,
    nutritionSummary,
    nutritionUnsaved,
    canEdit: shiso.canApplyIngredientEdits,
    canCorrect: shiso.canApplyNutritionCorrections,
    canSave: shiso.canSaveWorkingRecipe,
    loadNutritionBundle,
  };

  const describeNutritionContributions = useCallback((additions: readonly AiNutrientContribution[]) => {
    const current = latest.current;
    const addedRefs = new Set(additions.map((line) => line.line_ref));
    const all = [
      ...additions,
      ...current.nutritionAiContributions.filter((line) => !addedRefs.has(line.line_ref)),
    ];
    const coverage = current.nutritionAvailable
      ? deriveNutritionCoverage(current.nutritionRows, all)
      : deriveNutritionCoverage([]);
    const usableAdded = coverage.lines.filter((line) => addedRefs.has(line.line_ref) && line.contribution).length;
    const detail = usableAdded > 0
      ? `${usableAdded} new usable contribution(s) are included.`
      : 'No new contribution supplied usable known nutrients; remaining gaps stay unresolved.';
    return { coverage, usableAdded, message: `${nutritionCoverageSummary(coverage)} ${detail}` };
  }, []);

  const toolContext = useMemo<ShisoToolContext>(
    () => ({
      get session() {
        return latest.current.session;
      },
      get recipe() {
        return latest.current.recipeContext;
      },
      get nutrition() {
        const current = latest.current;
        return current.nutritionAvailable
          ? {
              rows: current.nutritionRows,
              aiContributions: current.nutritionAiContributions,
              summary: current.nutritionAvailable
                ? nutritionCoverageSummary(deriveNutritionCoverage(current.nutritionRows, current.nutritionAiContributions))
                : null,
              unsaved: current.nutritionUnsaved,
            }
          : null;
      },
      // Lets Shiso run the REAL Advanced Nutrition analysis through its owner.
      // Without this the capability reports that Advanced Nutrition is not open
      // rather than inventing a result.
      runAnalysis: async () => shisoRef.current.runAnalysis(),
      runAiNutrition: async (signal) => {
        const currentRecipe = latest.current.recipeContext;
        if (!currentRecipe || currentRecipe.servings === null || currentRecipe.ingredients.length === 0) return { ok: false, message: 'Recipe ingredients or servings are unavailable.' };
        const requestSnapshot = JSON.stringify({ title: currentRecipe.title, servings: currentRecipe.servings, ingredients: currentRecipe.ingredients, instructions: currentRecipe.instructions });
        const response = await network.post<{ ok?: boolean; code?: string; reason?: string; recipe_digest?: string; contributions?: unknown }>(
          '/api/shiso/nutrition',
          { recipe: { title: currentRecipe.title, servings: currentRecipe.servings, ingredients: currentRecipe.ingredients.map((i) => ({ line_ref: i.line_ref, text: i.text })), instructions: currentRecipe.instructions.map((i) => i.text) } },
          { ...(await buildAiSelectionRequestOptions()), ...(signal ? { signal } : {}) },
        );
        if (signal?.aborted) return { ok: false, message: 'Nutrition estimation was cancelled.' };
        const stillCurrent = latest.current.recipeContext;
        if (!stillCurrent || JSON.stringify({ title: stillCurrent.title, servings: stillCurrent.servings, ingredients: stillCurrent.ingredients, instructions: stillCurrent.instructions }) !== requestSnapshot) return { ok: false, message: 'The recipe changed while SHISO was calculating; no stale estimate was used.' };
        if (!response.ok || response.data?.ok !== true || !response.data.recipe_digest) return { ok: false, message: shisoNutritionFailureMessage(response.data?.code, response.data?.reason) };
        const checked = validateAiNutrientContributions(response.data.contributions, {
          recipe_digest: response.data.recipe_digest,
          line_refs: currentRecipe.ingredients.map((i) => i.line_ref ?? '').filter(Boolean),
          line_text_by_ref: Object.fromEntries(currentRecipe.ingredients.filter((i) => i.line_ref).map((i) => [i.line_ref!, i.text])),
          instructions: currentRecipe.instructions.map((step) => step.text),
          requireExclusionContext: true,
        });
        if (!checked.ok) return { ok: false, message: 'The AI nutrition response did not match the current recipe.' };
        if (!shisoRef.current.acceptAiNutrition(checked.contributions)) return { ok: false, message: 'The Advanced Nutrition review is not open for this recipe; the estimate was not applied.' };
        return { ok: true, contributions: checked.contributions, totals: sumAiNutrientContributions(checked.contributions) };
      },
      // H-2: the ACTUAL edit/save/correction ports, resolved at call time. When
      // the owning surface is not mounted the ports are ABSENT, and the
      // capability reports that honestly instead of pretending.
      get applyIngredientEdits() {
        return latest.current.canEdit
          ? (edits: Parameters<NonNullable<ShisoToolContext['applyIngredientEdits']>>[0]) =>
              shisoRef.current.applyIngredientEdits(edits)
          : undefined;
      },
      get applyNutritionCorrections() {
        return latest.current.canCorrect
          ? (lineRefs: Parameters<NonNullable<ShisoToolContext['applyNutritionCorrections']>>[0]) =>
              shisoRef.current.applyNutritionCorrections(lineRefs)
          : undefined;
      },
      get saveWorkingRecipe() {
        return latest.current.canSave
          ? () => shisoRef.current.saveWorkingRecipe({ via: 'assistant' })
          : undefined;
      },
      // Lets Shiso clear the one genuine prerequisite itself, using the same
      // controller the user's own Load USDA data button calls.
      get loadBundle() {
        const loader = latest.current.loadNutritionBundle;
        return loader !== undefined ? async () => { await loader(); } : undefined;
      },
    }),
    [network],
  );

  // Advanced Nutrition can invoke the very same recipe-bound, validated AI
  // contribution path without opening the conversation overlay. The UI owner
  // renders progress and the resulting review in its own surface.
  const runNutritionAnalysis = useCallback(async (): Promise<ShisoNutritionAnalysisOutcome> => {
    if (toolContext.runAiNutrition === undefined) {
      return { ok: false, contributionCount: 0, message: 'SHISO cannot read this recipe for nutrition analysis. Calculate without AI or check the recipe ingredients.' };
    }
    const result = await toolContext.runAiNutrition();
    if (!result.ok) return { ok: false, contributionCount: 0, message: result.message ?? 'SHISO could not validate a nutrition result. Your existing review is unchanged.' };
    const described = describeNutritionContributions(result.contributions ?? []);
    return { ok: true, contributionCount: described.usableAdded, message: described.message };
  }, [describeNutritionContributions, toolContext]);
  useEffect(
    () => shiso.registerNutritionAnalysisRunner(runNutritionAnalysis),
    [shiso.registerNutritionAnalysisRunner, runNutritionAnalysis],
  );

  const editableCreatedDraft = useCallback((): GeneratedRecipeDraft => {
    if (!createdDraft) throw new Error('Create a recipe draft before saving or refining it.');
    const servings = createdServings.trim() ? Number(createdServings) : createdDraft.servings;
    if (servings !== undefined && (!Number.isInteger(servings) || servings < 1 || servings > 100)) {
      throw new Error('Servings must be a whole number between 1 and 100.');
    }
    return normalizeGeneratedRecipeDraft({
      ...parseEditedDraftLines(createdDraft, createdIngredients, createdSteps),
      title: createdTitle.trim() || createdDraft.title,
      description: createdDescription.trim() || undefined,
      ...(servings !== undefined ? { servings } : {}),
    });
  }, [createdDraft, createdTitle, createdDescription, createdServings, createdIngredients, createdSteps]);

  const saveCreatedDraftNow = useCallback(async (): Promise<boolean> => {
    if (!createdProvenance || !onSaveCreatedDraft || createdSaveBusy) return false;
    setCreatedSaveBusy(true);
    setCreatedSaveError(null);
    setCreatedSaveMessage(null);
    try {
      await onSaveCreatedDraft(editableCreatedDraft(), createdProvenance);
      setCreatedDraft(null);
      setCreatedProvenance(null);
      setPriorCreatedDraft(null);
      setCreatedSaveMessage('Recipe saved successfully to the Vault.');
      return true;
    } catch (error) {
      setCreatedSaveError(error instanceof GeneratedRecipePathCollisionError
        ? GENERATED_RECIPE_COLLISION_MESSAGE
        : error instanceof Error && error.message ? error.message : 'The recipe could not be saved. Your unsaved draft is still available.');
      return false;
    } finally {
      setCreatedSaveBusy(false);
    }
  }, [createdProvenance, onSaveCreatedDraft, createdSaveBusy, editableCreatedDraft]);

  const send = useCallback(async (requestedMessage?: string) => {
    const message = (requestedMessage ?? draft).trim();
    if (message.length === 0) return;
    // A new turn supersedes the old one. Abort is idempotent; the sequence guard
    // remains as defense against transports that resolve after abort.
    activeTurnControllerRef.current?.abort();
    const controller = new AbortController();
    activeTurnControllerRef.current = controller;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    if (requestedMessage === undefined) setDraft('');
    setBusy(true);
    setStatus(null);
    setEntries((prev) => [
      ...prev,
      { key: `u${seq}`, role: 'user' as const, text: message, tools: [] },
    ]);

    if (creationMode) {
      const saveAuthorized = classifySaveIntent(message).authorized;
      if (saveAuthorized && createdDraft && createdProvenance && onSaveCreatedDraft) {
        setStatus('Saving the reviewed recipe through the normal Vault path…');
        try {
          const saved = await saveCreatedDraftNow();
          setEntries((prev) => [...prev, { key: `a${seq}`, role: 'assistant', text: saved ? 'The reviewed recipe was saved successfully. You can create another recipe whenever you are ready.' : 'The recipe was not saved. Your draft remains available for review.', tools: saved ? ['explicit recipe save'] : [] }]);
        } catch (error) {
          const message = error instanceof GeneratedRecipePathCollisionError
            ? GENERATED_RECIPE_COLLISION_MESSAGE
            : error instanceof Error && error.message ? error.message : 'The recipe could not be saved. Your unsaved draft is still available.';
          setCreatedSaveError(message);
          setEntries((prev) => [...prev, { key: `a${seq}`, role: 'assistant', text: `${message} Your draft remains unsaved.`, tools: [] }]);
        } finally {
          if (seqRef.current === seq) {
            setBusy(false);
            setStatus(null);
          }
        }
        return;
      }

      setStatus(createdDraft ? 'Shiso is refining the same recipe draft…' : 'Shiso is creating a structured recipe draft…');
      try {
        const previous = createdDraft ? editableCreatedDraft() : undefined;
        const requestedServings = explicitServingCount(message);
        const constraints = requestedServings === undefined ? {} : { servings: requestedServings };
        const result = await requestGeneratedRecipe(network, message, constraints, previous, controller.signal);
        if (requestedServings !== undefined && result.draft.servings !== requestedServings) {
          throw new Error(`The selected model did not return a draft for ${requestedServings} servings. Your existing draft was kept unchanged; try stating the serving count again.`);
        }
        if (seqRef.current !== seq) return;
        if (createdDraft && createdProvenance) {
          setPriorCreatedDraft({ draft: previous!, provenance: createdProvenance });
        }
        setCreatedDraft(result.draft);
        setCreatedProvenance(result.provenance);
        setCreatedTitle(result.draft.title);
        setCreatedDescription(result.draft.description ?? '');
        setCreatedServings(result.draft.servings === undefined ? '' : String(result.draft.servings));
        setCreatedIngredients(result.draft.ingredients.map((i) => `${i.amount ?? ''} ${i.unit ?? ''} ${i.name}${i.preparation ? `, ${i.preparation}` : ''}`.trim()).join('\n'));
        setCreatedSteps(result.draft.steps.map((step) => step.text).join('\n'));
        setCreatedSaveError(null);
        setCreatedSaveMessage(null);
        setEntries((prev) => [...prev, {
          key: `a${seq}`,
          role: 'assistant',
          text: createdDraft
            ? `I updated the existing ${result.draft.title} draft using your request. Review or edit the ingredients and instructions below; nothing has been saved.`
            : `I created a structured ${result.draft.title} draft. Review or edit it below; nothing has been saved.`,
          tools: [`${result.provenance.providerId} · ${result.provenance.model}`, 'validated recipe draft'],
        }]);
        setStatus(null);
      } catch (error) {
        if (seqRef.current !== seq) return;
        const message = error instanceof CreateRecipeClientError && error.code === 'RECIPE_GENERATION_NOT_VERIFIED'
          ? 'This selected model can return structured text but has not been verified for recipe creation. Verify recipe creation for this model in AI Settings or choose a verified text model. No fallback was used.'
          : error instanceof CreateRecipeClientError && error.code === 'UNSUPPORTED_CAPABILITY'
            ? 'The current AI selection is not enabled for structured recipe creation. Choose a compatible model or complete its recipe-generation verification in AI Settings. No fallback was used.'
            : error instanceof Error && error.message
              ? `${error.message} Your current draft was kept unchanged.`
              : 'Shiso could not create or refine the recipe draft. Your current draft was kept unchanged.';
        setStatus(message);
      } finally {
        if (seqRef.current === seq) setBusy(false);
      }
      return;
    }

    // H-2 SECURITY: classify THIS user message with the trusted, deterministic
    // classifier and (re)issue the single-slot save authorization for this turn,
    // bound to the ACTIVE recipe. Every message replaces the slot — including a
    // message that does not ask to save, which clears any previous turn's
    // authorization. The model never sees or influences this decision.
    const saveIntent = classifySaveIntent(message);
    shisoRef.current.issueSaveAuthorization({
      authorized: saveIntent.authorized,
      recipe_identity: recipeIdentityOf(recipe),
      turn: seq,
    });

    const outcome = await runShisoConversationTurn(
      {
        network,
        context: {
          recipe:
            recipeContext === null
              ? null
              : {
                  title: recipeContext.title,
                  servings: recipeContext.servings,
                  ingredientCount: recipeContext.ingredients.length,
                  stepCount: recipeContext.instructions.length,
                },
          nutrition: {
            available: nutritionAvailable,
            summary: effectiveNutritionSummary,
            unresolvedCount: nutritionCoverage.unresolved,
            needsAmountCount: nutritionCoverage.needs_amount,
            needsMatchCount: nutritionCoverage.needs_match + nutritionCoverage.review_suggested,
            unsavedWorkingReview: nutritionUnsaved,
          },
          recipeKey,
          sessionIdentity,
        },
        toolContext,
        signal: controller.signal,
      },
      conversation,
      message,
    );

    // A superseded turn can never paint over a newer one.
    if (seqRef.current !== seq) return;
    if (outcome.cancelled) {
      setBusy(false);
      setStatus('This turn was cancelled.');
      return;
    }
    setConversation(outcome.state);
    setBusy(false);
    if (outcome.ok && outcome.message !== null) {
      const launchedNutritionAnalysis = requestedMessage?.startsWith(
        'Analyze the complete nutrition for this recipe.',
      ) === true;
      const nutritionFinding = launchedNutritionAnalysis
        ? [...outcome.state.findings].reverse().find((finding) => finding.tool === 'run_nutrition_analysis')
        : undefined;
      // Do not let a provider's free-form reply claim that nutrition ran when
      // the application has no successful analysis observation to confirm it.
      const confirmedMessage = launchedNutritionAnalysis && nutritionFinding?.ok !== true
        ? `I could not confirm a completed nutrition analysis. ${nutritionFinding?.summary ?? 'SHISO did not run the recipe nutrition tool.'} No new nutrition totals are confirmed. You can retry or use the local source pass in Advanced Nutrition.`
        : outcome.message;
      setEntries((prev) => [
        ...prev,
        {
          key: `a${seq}`,
          role: 'assistant' as const,
          text: confirmedMessage,
          tools: outcome.toolsUsed,
        },
      ]);
      setStatus(null);
    } else {
      setStatus(outcome.status ?? 'Shiso could not complete that request.');
    }
  }, [
    busy, conversation, draft, network, nutritionAvailable, nutritionRows, nutritionSummary,
    nutritionUnsaved, recipeContext, recipeKey, sessionIdentity, toolContext, creationMode,
    createdDraft, createdProvenance, onSaveCreatedDraft, createdTitle, createdDescription,
    createdServings, createdIngredients, createdSteps,
    editableCreatedDraft, saveCreatedDraftNow,
    nutritionCoverage, effectiveNutritionSummary,
  ]);

  // The Advanced Nutrition "Analyze with Shiso" action is a trusted, explicit
  // user request. Submit one whole-recipe task as soon as the shared SHISO
  // surface opens; ordinary openings never auto-send and every request id is
  // consumed once, even when the provider reports an actionable failure.
  const lastNutritionRequest = useRef(0);
  useEffect(() => {
    if (!isOpen || shiso.nutritionAnalysisRequest <= lastNutritionRequest.current) return;
    lastNutritionRequest.current = shiso.nutritionAnalysisRequest;
    // This explicit action is a single structured nutrition request. Sending it
    // through conversational Shiso first would make a second provider call
    // before the structured contribution request.
    const seq = ++seqRef.current;
    setBusy(true);
    setStatus('SHISO is analyzing the recipe and validating ingredient contributions…');
    setEntries((previous) => [
      ...previous,
      { key: `u${seq}`, role: 'user' as const, text: 'Analyze the complete nutrition for this recipe.', tools: [] },
    ]);
    void (async () => {
      let result: Awaited<ReturnType<NonNullable<ShisoToolContext['runAiNutrition']>>>;
      try {
        result = toolContext.runAiNutrition
          ? await toolContext.runAiNutrition()
          : { ok: false, message: 'The structured nutrition service is not available in this review.' };
      } catch {
        result = { ok: false, message: 'The structured nutrition request failed before a result was confirmed.' };
      }
      if (seqRef.current !== seq) return;
      const message = result.ok
        ? `${describeNutritionContributions(result.contributions ?? []).message} Inspect assumptions and unknown nutrients before Apply. Nothing has been saved.`
        : `SHISO could not complete the nutrition analysis. ${result.message ?? 'No new nutrition values were confirmed.'} No changes were saved.`;
      setEntries((previous) => [
        ...previous,
        { key: `a${seq}`, role: 'assistant' as const, text: message, tools: result.ok ? ['structured nutrition analysis'] : [] },
      ]);
      setStatus(null);
      setBusy(false);
    })();
  }, [describeNutritionContributions, isOpen, shiso.nutritionAnalysisRequest, toolContext]);

  /**
   * Explicit user confirmation. Natural language may lead here, but the change is
   * only ever made by pressing this control, and the authoritative transition is
   * performed by Advanced Nutrition — never by the model and never here.
   */
  const confirmProposal = async (bound: ShisoBoundProposal) => {
    if (applyBusy) return;
    setApplyBusy(true);
    setApplyError(null);
    setApplyReport(null);
    try {
      const result = await shiso.applyProposal(bound);
      if (result.ok) {
        setAppliedIds((prev) => [...prev, bound.proposal_id]);
        setRejectedIds((prev) => prev.filter((id) => id !== bound.proposal_id));
        setApplyReport(result.summary + ' ' + result.remaining);
      } else {
        setApplyError((result as { message: string }).message);
      }
    } catch {
      setApplyError('That suggestion could not be applied.');
    } finally {
      setApplyBusy(false);
    }
  };

  const dismissProposal = (bound: ShisoBoundProposal) => {
    setRejectedIds((prev) => [...prev, bound.proposal_id]);
    setAppliedIds((prev) => prev.filter((id) => id !== bound.proposal_id));
    setApplyReport(null);
    setApplyError(null);
  };

  /** Undo an ACCEPTED suggestion. This never reverts a decision the user made
   *  directly in Advanced Nutrition; it only clears the suggestion card, and it
   *  tells the user exactly how to undo the underlying selection. */
  const undoProposal = (bound: ShisoBoundProposal) => {
    setAppliedIds((prev) => prev.filter((id) => id !== bound.proposal_id));
    setRejectedIds((prev) => [...prev, bound.proposal_id]);
    setApplyReport(null);
    setApplyError('Suggestion withdrawn. The applied selection is still in your working review — use the existing controls in Advanced Nutrition to change or clear it.');
  };

  /**
   * H-2 explicit save authorization from the UI. This is the same port the
   * `save_working_recipe` capability uses; the application shell performs the
   * canonical write. Nothing here writes anything itself.
   */
  const saveWorking = async () => {
    if (saveBusy) return;
    setSaveBusy(true);
    setSaveError(null);
    setSaveReport(null);
    try {
      // H-2 SECURITY: this control is a genuine user Save action, so it is its
      // own authorization (`via: 'ui'`) — unlike the assistant tool path, which
      // requires the current turn's natural-language grant.
      const result = await shiso.saveWorkingRecipe({ via: 'ui' });
      if (result.saved) setSaveReport(result.message);
      else setSaveError(result.message);
    } catch {
      setSaveError('The recipe could not be saved.');
    } finally {
      setSaveBusy(false);
    }
  };

  if (!isOpen) return null;

  const recentProposals = conversation.proposals.slice(-12).reverse();

  /**
   * I-2: what the user is actually approving. Built ONLY from the authenticated
   * review row, so a model can never describe the replacement record for us.
   */
  const disclosureFor = (bound: ShisoBoundProposal) => {
    const proposal = bound.proposal;
    if (proposal.outcome !== 'verified_alternative_match') return null;
    const lineRef = proposal.line_ref;
    const row = nutritionReviewRows.find((r) => r.line_ref === lineRef);
    if (row === undefined) return null;
    const authored = row.original_text;
    const live = nutritionRows.find((r) => r.line_ref === proposal.line_ref);
    return buildIdentityDisclosure(row, authored, proposal.fdc_id, {
      fdc_id: live?.selected_fdc_id,
      description: live?.selected_description,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-3xl h-[85vh] bg-[#0C0C0C] border border-white/10 rounded-2xl flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <div>
              <h2 className="text-sm font-bold text-gray-100">{creationMode ? 'Create with Shiso' : 'Chat with Shiso'}</h2>
              <p className="text-[11px] text-gray-500">
                {creationMode
                  ? 'Recipe creation · editable draft · nothing is saved until you choose'
                  : recipeContext === null
                  ? 'General conversation'
                  : `Context: ${recipeContext.title}`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Shiso"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/5"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {entries.length === 0 && (
            <div className="text-center py-10">
              <Sparkles className="w-8 h-8 text-amber-400/60 mx-auto mb-3" />
              <p className="text-sm text-gray-300">{creationMode ? 'Tell Shiso what recipe you want to create.' : 'Ask Shiso about your recipes, nutrition or cooking.'}</p>
              <p className="text-xs text-gray-500 mt-2">
                {creationMode ? 'You can refine the same draft over multiple turns, review and edit it, then save explicitly.' : 'Shiso looks things up in your authenticated data before answering.'}
              </p>
            </div>
          )}

          {entries.map((entry) => (
            <div key={entry.key} className={entry.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  entry.role === 'user'
                    ? 'max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-amber-500 text-black text-sm whitespace-pre-wrap'
                    : 'max-w-[90%] px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-[#141414] border border-white/10 text-gray-200 text-sm whitespace-pre-wrap'
                }
              >
                {entry.text}
                {entry.tools.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-white/10 flex flex-wrap gap-1.5">
                    {entry.tools.map((tool) => (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-white/5 text-gray-400"
                      >
                        <Wrench className="w-2.5 h-2.5" />
                        {tool.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {busy && (
            <div className="flex justify-start">
              <div role="status" aria-live="polite" data-testid="shiso-progress" className="px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-[#141414] border border-amber-500/20 text-gray-300 text-sm">
                <span className="font-semibold text-amber-200">{status ?? (creationMode ? 'Shiso is working on your recipe…' : 'Shiso is analyzing the recipe…')}</span>
                {!creationMode && <span className="block text-[11px] text-gray-400 mt-0.5">Checking ingredient context, available portions, and nutrition evidence. Results are not saved.</span>}
              </div>
            </div>
          )}

          {status !== null && !busy && (
            <div className="flex items-start gap-2 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              <CircleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{status}</span>
            </div>
          )}

          {creationMode && createdDraft && createdProvenance && (
            <section data-testid="shiso-created-recipe-draft" aria-label="Unsaved recipe draft" className="rounded-xl border border-violet-400/30 bg-[#141414] p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-violet-200">Recipe draft</span>
                  <span className="text-[10px] rounded-full px-2 py-0.5 border border-amber-400/30 text-amber-200 bg-amber-500/10">UNSAVED</span>
                  <span className="text-[10px] text-gray-500">{createdProvenance.providerId} · {createdProvenance.model}</span>
                </div>
              </div>
              <label className="block text-[11px] text-gray-400">Title
                <input value={createdTitle} onChange={(event) => { setCreatedTitle(event.target.value); setPriorCreatedDraft(null); }} maxLength={120} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0c0c0c] px-2.5 py-2 text-sm text-gray-100" />
              </label>
              <label className="block text-[11px] text-gray-400">Description
                <textarea value={createdDescription} onChange={(event) => { setCreatedDescription(event.target.value); setPriorCreatedDraft(null); }} maxLength={600} rows={2} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0c0c0c] px-2.5 py-2 text-sm text-gray-100 resize-y" />
              </label>
              <label className="block text-[11px] text-gray-400">Servings
                <input type="number" min={1} max={100} step={1} value={createdServings} onChange={(event) => { setCreatedServings(event.target.value); setPriorCreatedDraft(null); }} className="mt-1 w-28 rounded-lg border border-white/10 bg-[#0c0c0c] px-2.5 py-2 text-sm text-gray-100" />
              </label>
              <label className="block text-[11px] text-gray-400">Ingredients · one per line
                <textarea value={createdIngredients} onChange={(event) => { setCreatedIngredients(event.target.value); setPriorCreatedDraft(null); }} rows={Math.min(12, Math.max(4, createdDraft.ingredients.length))} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0c0c0c] px-2.5 py-2 text-sm font-mono text-gray-100 resize-y" />
              </label>
              <label className="block text-[11px] text-gray-400">Instructions · one step per line
                <textarea value={createdSteps} onChange={(event) => { setCreatedSteps(event.target.value); setPriorCreatedDraft(null); }} rows={Math.min(12, Math.max(4, createdDraft.steps.length))} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0c0c0c] px-2.5 py-2 text-sm text-gray-100 resize-y" />
              </label>
              <p className="text-[10px] text-gray-500">Nutrition is not generated or verified here. The draft remains local until an explicit save.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" data-testid="shiso-created-save" disabled={createdSaveBusy || busy} onClick={() => void saveCreatedDraftNow()} className="rounded-lg bg-teal-500/20 border border-teal-400/40 px-3 py-1.5 text-xs font-semibold text-teal-100 disabled:opacity-40">{createdSaveBusy ? 'Saving…' : 'Save to Vault'}</button>
                <button type="button" disabled={!priorCreatedDraft || busy || createdSaveBusy} onClick={() => {
                  if (!priorCreatedDraft) return;
                  setCreatedDraft(priorCreatedDraft.draft);
                  setCreatedProvenance(priorCreatedDraft.provenance);
                  setCreatedTitle(priorCreatedDraft.draft.title);
                  setCreatedDescription(priorCreatedDraft.draft.description ?? '');
                  setCreatedServings(priorCreatedDraft.draft.servings === undefined ? '' : String(priorCreatedDraft.draft.servings));
                  setCreatedIngredients(priorCreatedDraft.draft.ingredients.map((i) => `${i.amount ?? ''} ${i.unit ?? ''} ${i.name}${i.preparation ? `, ${i.preparation}` : ''}`.trim()).join('\n'));
                  setCreatedSteps(priorCreatedDraft.draft.steps.map((step) => step.text).join('\n'));
                  setPriorCreatedDraft(null);
                }} className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-300 disabled:opacity-40"><Undo2 className="h-3 w-3" />Undo refinement</button>
                <button type="button" disabled={busy || createdSaveBusy} onClick={() => {
                  setCreatedDraft(null); setCreatedProvenance(null); setPriorCreatedDraft(null);
                  setCreatedTitle(''); setCreatedDescription(''); setCreatedServings(''); setCreatedIngredients(''); setCreatedSteps('');
                  setCreatedSaveError(null); setCreatedSaveMessage('Draft discarded. Nothing was written to the Vault.');
                }} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-300 disabled:opacity-40">Discard draft</button>
              </div>
              {createdSaveError && <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{createdSaveError}</p>}
              {createdSaveMessage && <p role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">{createdSaveMessage}</p>}
            </section>
          )}

          {creationMode && createdDraft === null && createdSaveMessage && (
            <p role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">{createdSaveMessage}</p>
          )}

          {/* H-2: the ONE visible account of Shiso's unauthorized-not-yet-saved
              recipe changes, with the explicit Save and the undo (Discard)
              path. Nothing is written to the vault until Save is pressed here
              (or the user asks Shiso to save). */}
          {shiso.workingRecipe !== null && shiso.workingRecipe.unsaved && (
            <div
              data-testid="shiso-working-recipe"
              className="text-xs bg-[#141414] border border-teal-500/30 rounded-lg px-3 py-2.5 space-y-2"
            >
              <p className="font-semibold text-teal-200">
                Recipe changes are not saved yet
                <span className="ml-1.5 font-normal text-gray-400">
                  ({shiso.workingRecipe.change_count} change{shiso.workingRecipe.change_count === 1 ? '' : 's'} in the working copy)
                </span>
              </p>
              <ul className="space-y-1">
                {shiso.workingRecipe.changes.slice(-6).map((change, index) => (
                  <li key={`${index}-${change}`} className="text-gray-300 leading-relaxed">• {change}</li>
                ))}
              </ul>
              <p className="text-[10px] text-gray-500">
                Your saved recipe is untouched until you save. The nutrition review recalculates from this working copy.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="shiso-working-save"
                  disabled={saveBusy || !shiso.canSaveWorkingRecipe}
                  onClick={() => void saveWorking()}
                  className="text-[11px] px-2 py-1 rounded-lg bg-teal-500/20 text-teal-200 border border-teal-500/40 hover:bg-teal-500/30 disabled:opacity-40"
                >
                  {saveBusy ? 'Saving…' : 'Save to vault'}
                </button>
                <button
                  type="button"
                  data-testid="shiso-working-discard"
                  onClick={() => {
                    shiso.discardWorkingRecipe();
                    setSaveReport(null);
                    setSaveError(null);
                  }}
                  className="text-[11px] px-2 py-1 rounded-lg border border-white/15 text-gray-300 hover:bg-white/5"
                >
                  Discard changes
                </button>
              </div>
              {saveReport !== null && (
                <p data-testid="shiso-working-report" className="text-[11px] text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2 py-1.5">
                  {saveReport}
                </p>
              )}
              {saveError !== null && (
                <p data-testid="shiso-working-error" className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1.5">
                  {saveError}
                </p>
              )}
            </div>
          )}

          {recentProposals.length > 0 && (
            <div className="border-t border-white/10 pt-3 space-y-2">
              <p className="text-[11px] font-semibold text-gray-400">
                Shiso's suggestions — review these in Advanced Nutrition. Shiso never changes your data by itself.
              </p>
              {recentProposals.map((bound) => (
                <div key={bound.proposal_id} className="text-xs bg-[#141414] border border-white/10 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-gray-200">{bound.proposal.ingredient_label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">
                      {bound.proposal.outcome.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p className="text-gray-400 leading-relaxed">{bound.proposal.explanation}</p>
                  {bound.proposal.question !== null && (
                    <p className="text-amber-300/90 mt-1">{bound.proposal.question}</p>
                  )}

                  {(() => {
                    const d = disclosureFor(bound);
                    if (d === null) return null;
                    if (d.ok !== true) {
                      return (
                        <p data-testid="shiso-disclosure-unavailable" className="mt-2 text-[11px] text-red-300/90 bg-red-500/10 border border-red-500/25 rounded-lg px-2 py-1.5">
                          {d.message}
                        </p>
                      );
                    }
                    return (
                      <div
                        data-testid="shiso-identity-disclosure"
                        className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 space-y-1"
                      >
                        <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
                          USDA identity you would approve
                        </p>
                        <p className="text-[11px] text-gray-300">
                          <span className="text-gray-500">Recipe says:</span>{' '}
                          <span data-testid="shiso-disclosure-authored">{d.authoredOriginal}</span>
                        </p>
                        <p className="text-[11px] text-gray-300">
                          <span className="text-gray-500">Currently selected:</span>{' '}
                          <span data-testid="shiso-disclosure-current">{d.currentDescription ?? 'no record selected'}</span>
                        </p>
                        <p className="text-[11px] text-gray-200">
                          <span className="text-gray-500">Proposed USDA record:</span>{' '}
                          <span data-testid="shiso-disclosure-proposed" className="font-semibold text-teal-200">
                            {d.proposedDescription}
                          </span>
                        </p>
                        {d.qualifierWarning !== null && (
                          <p
                            data-testid="shiso-qualifier-warning"
                            className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mt-1"
                          >
                            {d.qualifierWarning}
                          </p>
                        )}
                        <p className="text-[10px] text-gray-500 leading-snug">{d.nutrientNote}</p>
                      </div>
                    );
                  })()}

                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {appliedIds.includes(bound.proposal_id) ? (
                      <>
                        <span className="text-[11px] text-emerald-300">Applied to your working review</span>
                        <button
                          type="button"
                          onClick={() => undoProposal(bound)}
                          className="text-[11px] px-2 py-1 rounded-lg border border-white/15 text-gray-300 hover:bg-white/5"
                        >
                          Withdraw
                        </button>
                      </>
                    ) : rejectedIds.includes(bound.proposal_id) ? (
                      <span className="text-[11px] text-gray-500">Dismissed — nothing was changed</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          data-testid="shiso-proposal-apply"
                          disabled={applyBusy || !shiso.canApplyProposal}
                          onClick={() => void confirmProposal(bound)}
                          className="text-[11px] px-2 py-1 rounded-lg bg-teal-500/20 text-teal-200 border border-teal-500/40 hover:bg-teal-500/30 disabled:opacity-40"
                          title={
                            shiso.canApplyProposal
                              ? 'Apply this to your UNSAVED working review'
                              : 'Open Advanced Nutrition to apply suggestions'
                          }
                        >
                          Use this
                        </button>
                        <button
                          type="button"
                          data-testid="shiso-proposal-reject"
                          onClick={() => dismissProposal(bound)}
                          className="text-[11px] px-2 py-1 rounded-lg border border-white/15 text-gray-300 hover:bg-white/5"
                        >
                          No thanks
                        </button>
                        {!shiso.canApplyProposal && (
                          <span className="text-[10px] text-gray-500">
                            Open Advanced Nutrition to apply a suggestion.
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
              {applyReport !== null && (
                <p data-testid="shiso-apply-report" className="text-[11px] text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                  {applyReport}
                </p>
              )}
              {applyError !== null && (
                <p data-testid="shiso-apply-error" className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  {applyError}
                </p>
              )}
            </div>
          )}
        </div>

        <footer className="border-t border-white/10 px-5 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={creationMode ? 'Describe the recipe, or request a change to this draft…' : 'Ask Shiso…'}
              disabled={createdSaveBusy}
              className="flex-1 px-3 py-2 text-sm bg-[#141414] border border-white/10 rounded-xl text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-amber-500 resize-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={createdSaveBusy || draft.trim().length === 0}
              className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:hover:bg-amber-500 text-black rounded-xl flex items-center gap-1.5 text-sm font-bold"
            >
              <Send className="w-3.5 h-3.5" />
              {busy ? 'Replace turn' : 'Send'}
            </button>
          </form>
          <p className="text-[10px] text-gray-600 mt-2">
            {creationMode
              ? 'Shiso creates and refines one editable recipe draft. Nothing reaches your Vault until you choose Save to Vault or explicitly ask Shiso to save.'
              : "Shiso can change this recipe's working copy and nutrition review. Nothing reaches your Vault until an explicit Save."}
          </p>
        </footer>
      </div>
    </div>
  );
}
