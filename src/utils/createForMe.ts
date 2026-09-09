/**
 * The Kitchen Codex — Create for Me client logic (v0.7 Phase 2A).
 *
 * Platform-neutral client-side helpers for the Create for Me flow:
 *   - builds the bounded generation request from a prompt + compact constraints,
 *   - POSTs it through the existing NetworkAdapter (NO direct fetch),
 *   - validates + re-normalizes the returned draft before it enters the UI,
 *   - parses edited ingredient/step lines back into the draft before save.
 *
 * The generation prompt is transient here too: it exists in request/UI state only
 * and is never persisted by these helpers.
 */

import type { NetworkAdapter, NetworkResponse } from '../application/adapters/NetworkAdapter';
import {
  normalizeGeneratedRecipeDraft,
  type CreateRecipeRequest,
  type GeneratedIngredient,
  type GeneratedRecipeDraft,
  type GeneratedRecipeProvenance,
  type GeneratedStep,
} from '../schema/generatedRecipe';
import { parseIngredientLine } from './markdownParser';

/** The application-backed generation path (read/write app transport). */
export const CREATE_RECIPE_PATH = '/api/recipes/generate';

/** A compact, user-facing constraint input. */
export interface CreateForMeConstraintsInput {
  servings?: number;
  maxTotalMinutes?: number;
  cuisine?: string;
  course?: string;
  dietary?: string;
  excludeIngredients?: string;
}

/** The client-facing generation result. */
export interface GeneratedRecipeClientResult {
  draft: GeneratedRecipeDraft;
  provenance: GeneratedRecipeProvenance;
}

/** A bounded client error carrying an optional status + safe code. */
export class CreateRecipeClientError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'CreateRecipeClientError';
    this.status = status;
    this.code = code;
  }
}

function splitTagList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[,\n]/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
}

/** Builds the bounded request the backend accepts (never whole-vault). */
export function buildCreateRecipeRequest(
  prompt: string,
  constraints: CreateForMeConstraintsInput = {}
): CreateRecipeRequest {
  const c: CreateRecipeRequest['constraints'] = {};
  if (typeof constraints.servings === 'number' && Number.isInteger(constraints.servings)) c!.servings = constraints.servings;
  if (typeof constraints.maxTotalMinutes === 'number' && Number.isInteger(constraints.maxTotalMinutes)) {
    c!.maxTotalMinutes = constraints.maxTotalMinutes;
  }
  const dietary = splitTagList(constraints.dietary);
  if (dietary.length) c!.dietary = dietary;
  const exclude = splitTagList(constraints.excludeIngredients);
  if (exclude.length) c!.excludeIngredients = exclude;
  if (constraints.cuisine) c!.cuisine = constraints.cuisine.trim();
  if (constraints.course) c!.course = constraints.course.trim();
  return {
    prompt: prompt.trim(),
    ...(Object.keys(c ?? {}).length ? { constraints: c } : {}),
  };
}

/** Parses a generated ingredient line (e.g. "2 cups flour") into a wikilink-free GeneratedIngredient. */
export function parseGeneratedIngredientLine(line: string): GeneratedIngredient | null {
  // Strip any wikilink anatomy BEFORE parsing so a user edit can never introduce
  // auto-Obsidian-linking into a generated recipe, then reuse the canonical
  // ingredient parser for amount/unit/name extraction.
  const withoutWikilinks = line.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$1');
  const parsed = parseIngredientLine(withoutWikilinks);
  if (!parsed.name && !withoutWikilinks.trim()) return null;
  const name = (parsed.name || parsed.original || '').trim();
  if (!name) return null;
  const ing: GeneratedIngredient = { name };
  if (parsed.amount != null) ing.amount = parsed.amount;
  if (parsed.unit) ing.unit = parsed.unit;
  if (parsed.note) ing.preparation = parsed.note;
  return ing;
}

/** Parses an edited step line (a number prefix like "1. " is tolerated) into a GeneratedStep. */
export function parseGeneratedStepLine(line: string): GeneratedStep | null {
  const text = line.replace(/^\s*\d+\.\s*/, '').trim();
  return text ? { text } : null;
}

/** Parses the idempotent text-areas back into draft ingredients/steps. */
export function parseEditedDraftLines(
  draft: GeneratedRecipeDraft,
  ingredientsText: string,
  stepsText: string
): GeneratedRecipeDraft {
  const ingredients = ingredientsText
    .split('\n')
    .map(parseGeneratedIngredientLine)
    .filter((x): x is GeneratedIngredient => x !== null);
  const steps = stepsText
    .split('\n')
    .map(parseGeneratedStepLine)
    .filter((x): x is GeneratedStep => x !== null);
  return { ...draft, ingredients, steps };
}

/**
 * POSTs a generation request through the NetworkAdapter and returns a validated
 * draft + provenance. Throws CreateRecipeClientError on a non-2xx response with a
 * safe message/code; never returns secrets, prompts, or a malformed draft.
 */
export async function requestGeneratedRecipe(
  network: NetworkAdapter,
  prompt: string,
  constraints: CreateForMeConstraintsInput = {}
): Promise<GeneratedRecipeClientResult> {
  const body = buildCreateRecipeRequest(prompt, constraints);
  const res: NetworkResponse<unknown> = await network.post<unknown, CreateRecipeRequest>(CREATE_RECIPE_PATH, body);
  if (!res.ok) {
    const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, string>;
    throw new CreateRecipeClientError(
      res.status,
      typeof data['error'] === 'string' && data['error'] ? data['error'] : 'Couldn\'t generate a recipe right now.',
      typeof data['code'] === 'string' ? data['code'] : undefined
    );
  }
  const payload = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
  const rawDraft = payload['draft'];
  const rawProv = (typeof payload['provenance'] === 'object' && payload['provenance'] !== null ? payload['provenance'] : {}) as Record<string, unknown>;
  if (rawProv['generated'] !== true || typeof rawProv['providerId'] !== 'string' || typeof rawProv['model'] !== 'string') {
    throw new CreateRecipeClientError(0, 'Provider status was malformed.');
  }
  const provenance: GeneratedRecipeProvenance = {
    generated: true,
    providerId: rawProv['providerId'],
    model: rawProv['model'],
  };
  // Re-validate on the client (never trust provider output blindly, even server-validated).
  const draft = normalizeGeneratedRecipeDraft(rawDraft);
  return { draft, provenance };
}
