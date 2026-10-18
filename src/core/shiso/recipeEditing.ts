/**
 * The Kitchen Codex — SHISO H-2 authorized ingredient editing (core).
 *
 * PURE, OFFLINE, deterministic. This is the ONE general ingredient-editing
 * engine Shiso uses. It contains NO ingredient-specific logic: every recipe,
 * every unit, every food is handled by the same rules.
 *
 * WHAT IT DOES
 * ------------
 * Takes the CURRENT recipe and a bounded list of FIELD-SCOPED edits
 * (`new_name`, `new_amount`, `new_unit`, `new_preparation`) and returns a NEW
 * recipe whose ingredient lines are re-rendered deterministically. A field the
 * edit does not name is preserved from the authored line:
 *
 *   - an edit that only changes the NAME can never change the quantity;
 *   - "2 lb chicken thighs" stays "2 lb chicken thighs" — it is never
 *     converted into a USDA serving description;
 *   - an explicit `new_amount`/`new_unit` IS applied, because the user asked
 *     for that change.
 *
 * AUTHORITY BOUNDARY
 * ------------------
 * This module can ONLY produce a new immutable recipe value. It:
 *   - never writes to disk, the vault, or storage (no import can reach them);
 *   - never calls a model, the network, or the USDA session;
 *   - never computes or invents a gram weight or a nutrient value;
 *   - never mutates its inputs (the original recipe object is untouched).
 *
 * Line references are re-derived from the CURRENT recipe with the SAME
 * adaptation authority the nutrition engine uses (`adaptRecipe`), so a stale
 * reference (an ingredient that changed since it was read) fails closed as
 * `unknown_line_ref` rather than editing the wrong line.
 */

import { adaptRecipe, MAX_PHASE4_INGREDIENTS } from '../nutritionV2/phase4';
import { formatAmount, parseIngredientLine } from '../../utils/markdownParser';
import {
  SHISO_LIMITS,
  type ShisoIngredientEditArgs,
  type ShisoRecipeEditApplied,
  type ShisoRecipeEditRefused,
} from './protocol';

/** The minimal structural ingredient this module edits (a superset is fine). */
export interface ShisoEditableIngredient {
  readonly original?: string;
  readonly amount?: number | null;
  readonly unit?: string;
  readonly name?: string;
  readonly note?: string;
  readonly wikilink?: string;
  readonly wikilinkTarget?: string;
  readonly wikilinkAlias?: string;
  readonly isChecked?: boolean;
}

export interface ShisoEditableRecipe {
  readonly ingredients: ReadonlyArray<ShisoEditableIngredient>;
}

/** The internal per-edit ledger the application keeps for undo. Never model-facing. */
export interface ShisoRecipeEditLedgerEntry {
  readonly line_ref: string;
  /** Index of the ingredient in the recipe (stable across edits). */
  readonly index: number;
  /** The whole ingredient object as it was BEFORE this edit (undo snapshot). */
  readonly previous: ShisoEditableIngredient;
  /** Bounded display change list. */
  readonly changes: readonly string[];
}

export interface ShisoRecipeEditSuccess {
  readonly ok: true;
  /** A NEW recipe value. The input object is never mutated. */
  readonly recipe: Record<string, unknown>;
  readonly applied: readonly ShisoRecipeEditApplied[];
  readonly refused: readonly ShisoRecipeEditRefused[];
  /** Undo snapshots for every applied edit, in application order. */
  readonly ledger: readonly ShisoRecipeEditLedgerEntry[];
  readonly summary: string;
}

export interface ShisoRecipeEditFailure {
  readonly ok: false;
  readonly message: string;
}

export type ShisoRecipeEditResult = ShisoRecipeEditSuccess | ShisoRecipeEditFailure;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function refuse(lineRef: string, reason: string, message: string): ShisoRecipeEditRefused {
  return Object.freeze({ line_ref: lineRef, reason, message });
}

/**
 * Structurally validates ONE raw edit. Returns a bounded, normalized edit or a
 * refusal reason. This is re-run in the browser because the browser is the
 * authority boundary and never trusts that the server's closed schema check
 * happened.
 */
export function normalizeShisoIngredientEdit(
  raw: unknown,
): { ok: true; edit: ShisoIngredientEditArgs } | { ok: false; reason: string; message: string; line_ref: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_arguments', message: 'An edit must be an object.', line_ref: '' };
  }
  const record = raw as Record<string, unknown>;
  const lineRefRaw = record['line_ref'];
  const lineRef = typeof lineRefRaw === 'string' ? lineRefRaw.trim() : '';
  if (lineRef.length === 0 || lineRef.length > 200) {
    return { ok: false, reason: 'invalid_arguments', message: 'An edit is missing its ingredient reference.', line_ref: lineRef };
  }

  const edit: Record<string, unknown> = { line_ref: lineRef };
  const hasName = record['new_name'] !== undefined;
  const hasAmount = record['new_amount'] !== undefined;
  const hasUnit = record['new_unit'] !== undefined;
  const hasPreparation = record['new_preparation'] !== undefined;
  if (!hasName && !hasAmount && !hasUnit && !hasPreparation) {
    return {
      ok: false,
      reason: 'invalid_arguments',
      message: 'An edit must change at least one of: name, amount, unit, preparation.',
      line_ref: lineRef,
    };
  }

  if (hasName) {
    const value = record['new_name'];
    if (typeof value !== 'string') {
      return { ok: false, reason: 'invalid_name', message: 'The new name must be text.', line_ref: lineRef };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'invalid_name', message: 'The new name cannot be empty.', line_ref: lineRef };
    }
    if (trimmed.length > SHISO_LIMITS.maxIngredientEditNameChars) {
      return { ok: false, reason: 'invalid_name', message: 'The new name is too long.', line_ref: lineRef };
    }
    if (CONTROL_CHARS.test(trimmed)) {
      return { ok: false, reason: 'invalid_name', message: 'The new name contains control characters.', line_ref: lineRef };
    }
    edit['new_name'] = trimmed;
  }

  if (hasAmount) {
    const value = record['new_amount'];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100000) {
      return {
        ok: false,
        reason: 'invalid_amount',
        message: 'The new amount must be a positive, finite number.',
        line_ref: lineRef,
      };
    }
    edit['new_amount'] = value;
  }

  if (hasUnit) {
    const value = record['new_unit'];
    if (typeof value !== 'string') {
      return { ok: false, reason: 'invalid_unit', message: 'The new unit must be text.', line_ref: lineRef };
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > SHISO_LIMITS.maxIngredientEditUnitChars) {
      return { ok: false, reason: 'invalid_unit', message: 'The new unit is too long.', line_ref: lineRef };
    }
    if (CONTROL_CHARS.test(trimmed)) {
      return { ok: false, reason: 'invalid_unit', message: 'The new unit contains control characters.', line_ref: lineRef };
    }
    edit['new_unit'] = trimmed;
  }

  if (hasPreparation) {
    const value = record['new_preparation'];
    if (typeof value !== 'string') {
      return { ok: false, reason: 'invalid_preparation', message: 'The new preparation must be text.', line_ref: lineRef };
    }
    const trimmed = value.trim();
    if (trimmed.length > SHISO_LIMITS.maxIngredientEditPreparationChars) {
      return { ok: false, reason: 'invalid_preparation', message: 'The new preparation is too long.', line_ref: lineRef };
    }
    if (CONTROL_CHARS.test(trimmed)) {
      return {
        ok: false,
        reason: 'invalid_preparation',
        message: 'The new preparation contains control characters.',
        line_ref: lineRef,
      };
    }
    edit['new_preparation'] = trimmed;
  }

  return { ok: true, edit: Object.freeze(edit) as unknown as ShisoIngredientEditArgs };
}

/** Strips a checklist prefix, exactly like the shared line renderer. */
function stripChecklistPrefix(text: string): string {
  return text.replace(/^[-*+]\s*(\[[ xX]\]\s*)?/, '').trim();
}

/** Everything after the first comma is the authored PREPARATION text. */
function splitPreparation(name: string): { base: string; preparation: string | null } {
  const comma = name.indexOf(',');
  if (comma < 0) return { base: name.trim(), preparation: null };
  return { base: name.slice(0, comma).trim(), preparation: name.slice(comma + 1).trim() || null };
}

/**
 * Applies a bounded batch of structured edits to the current recipe.
 *
 * All-or-nothing at the RECIPE level is deliberately NOT used: each edit is
 * independent, so one unsupported line (stale reference, invalid value, no-op)
 * is refused and reported while the supported edits apply. The returned
 * `report` is the bounded, model-safe account; the `ledger` is the internal
 * undo record and never leaves the application.
 */
export function applyShisoIngredientEdits(
  recipe: unknown,
  rawEdits: readonly unknown[],
): ShisoRecipeEditResult {
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return { ok: false, message: 'No recipe is open to edit.' };
  }
  const source = recipe as Record<string, unknown>;
  const ingredientsRaw = source['ingredients'];
  if (!Array.isArray(ingredientsRaw) || ingredientsRaw.length === 0) {
    return { ok: false, message: 'This recipe has no ingredients to edit.' };
  }
  if (ingredientsRaw.length > MAX_PHASE4_INGREDIENTS) {
    return { ok: false, message: 'This recipe is too large to edit safely.' };
  }

  const edits = Array.isArray(rawEdits) ? rawEdits : [];
  if (edits.length === 0) {
    return { ok: false, message: 'No edits were requested.' };
  }
  if (edits.length > SHISO_LIMITS.maxIngredientEditsPerCall) {
    return { ok: false, message: 'Too many edits were requested in one operation.' };
  }

  // The SAME adaptation authority the nutrition engine uses derives the line
  // references this batch is addressed by. A recipe that cannot be adapted is
  // never edited.
  const adaptation = adaptRecipe(recipe);
  if (!adaptation.ok) {
    return { ok: false, message: "This recipe's ingredients could not be read safely." };
  }
  const adapted = adaptation.recipe.adapted;

  const ingredients: ShisoEditableIngredient[] = ingredientsRaw.map(
    (entry) => entry as ShisoEditableIngredient,
  );
  const applied: ShisoRecipeEditApplied[] = [];
  const refused: ShisoRecipeEditRefused[] = [];
  const ledger: ShisoRecipeEditLedgerEntry[] = [];
  const alreadyEdited = new Set<string>();

  for (const raw of edits) {
    const normalized = normalizeShisoIngredientEdit(raw);
    if (normalized.ok !== true) {
      refused.push(refuse(normalized.line_ref, normalized.reason, normalized.message));
      continue;
    }
    const edit = normalized.edit;
    const adaptedIndex = adapted.findIndex((entry) => entry.line_ref === edit.line_ref);
    if (adaptedIndex < 0) {
      refused.push(
        refuse(
          edit.line_ref,
          'unknown_line_ref',
          'That ingredient is no longer part of this recipe (it may have changed since it was read).',
        ),
      );
      continue;
    }
    if (alreadyEdited.has(edit.line_ref)) {
      refused.push(
        refuse(edit.line_ref, 'duplicate_edit', 'This ingredient was already edited in this operation.'),
      );
      continue;
    }
    const index = adaptedIndex;
    const current = ingredients[index];
    if (current === undefined) {
      refused.push(refuse(edit.line_ref, 'unknown_line_ref', 'That ingredient is unavailable.'));
      continue;
    }

    const authored = (typeof current.original === 'string' ? current.original : '').trim();
    const fallbackBase = [current.amount != null ? String(current.amount) : '', current.unit ?? '', current.name ?? '']
      .filter((part) => part.length > 0)
      .join(' ');
    const baseText = stripChecklistPrefix(authored.length > 0 ? authored : fallbackBase);
    if (baseText.length === 0) {
      refused.push(refuse(edit.line_ref, 'unreadable_line', 'That ingredient line could not be read.'));
      continue;
    }

    const parsed = parseIngredientLine(baseText);
    const changes: string[] = [];

    // ---- name -----------------------------------------------------------------
    let name = parsed.name;
    let wikilink: string | undefined = parsed.wikilink;
    let wikilinkTarget: string | undefined = parsed.wikilinkTarget;
    let wikilinkAlias: string | undefined = parsed.wikilinkAlias;
    if (edit.new_name !== undefined) {
      if (edit.new_name !== parsed.name) {
        changes.push(`name: "${parsed.name}" → "${edit.new_name}"`);
      }
      name = edit.new_name;
      // A replacement name breaks the old wikilink binding unless the new name
      // carries its own wikilink. A stale `[[Chicken]]` link must not survive a
      // rename to turkey.
      if (!name.includes('[[')) {
        wikilink = undefined;
        wikilinkTarget = undefined;
        wikilinkAlias = undefined;
      }
    }

    // ---- preparation (the part after the first comma) -------------------------
    let preparation = splitPreparation(name).preparation;
    if (edit.new_preparation !== undefined) {
      const base = splitPreparation(name).base;
      const next = edit.new_preparation.length > 0 ? edit.new_preparation : null;
      if (next !== preparation) {
        changes.push(
          `preparation: ${preparation === null ? '(none)' : `"${preparation}"`} → ` +
            `${next === null ? '(none)' : `"${next}"`}`,
        );
      }
      name = next === null ? base : `${base}, ${next}`;
      preparation = next;
    }

    // ---- amount / unit --------------------------------------------------------
    const amount = edit.new_amount !== undefined ? edit.new_amount : (parsed.amount ?? null);
    if (edit.new_amount !== undefined && edit.new_amount !== (parsed.amount ?? null)) {
      changes.push(`amount: ${parsed.amount ?? '(none)'} → ${edit.new_amount}`);
    }
    const unit = edit.new_unit !== undefined ? edit.new_unit : parsed.unit ?? '';
    if (edit.new_unit !== undefined && edit.new_unit !== (parsed.unit ?? '')) {
      changes.push(`unit: ${parsed.unit ? `"${parsed.unit}"` : '(none)'} → ${edit.new_unit ? `"${edit.new_unit}"` : '(none)'}`);
    }

    // ---- deterministic re-render ---------------------------------------------
    const amountText = amount !== null && amount > 0 ? formatAmount(amount) : '';
    const renderedName = name.includes('[[')
      ? name
      : wikilinkTarget !== undefined
        ? wikilinkAlias !== undefined && wikilinkAlias !== wikilinkTarget
          ? `[[${wikilinkTarget}|${wikilinkAlias}]]`
          : `[[${wikilinkTarget}]]`
        : wikilink !== undefined
          ? wikilink.startsWith('[[')
            ? wikilink
            : `[[${wikilink}]]`
          : name;
    const nextText = [amountText, unit, renderedName].filter((part) => part.length > 0).join(' ').trim();

    if (nextText.length === 0) {
      refused.push(refuse(edit.line_ref, 'empty_result', 'That edit would produce an empty ingredient line.'));
      continue;
    }
    if (nextText === baseText) {
      refused.push(refuse(edit.line_ref, 'no_change', 'That edit would not change the ingredient line.'));
      continue;
    }

    const nextIngredient: ShisoEditableIngredient = Object.freeze({
      original: nextText,
      amount,
      ...(unit.length > 0 ? { unit } : {}),
      name,
      ...(preparation !== null ? { note: preparation } : {}),
      ...(wikilinkTarget !== undefined && !name.includes('[[') ? { wikilinkTarget } : {}),
      ...(wikilink !== undefined && !name.includes('[[') ? { wikilink } : {}),
      ...(wikilinkAlias !== undefined && !name.includes('[[') ? { wikilinkAlias } : {}),
      ...(current.isChecked === true ? { isChecked: true } : {}),
    });

    ledger.push(
      Object.freeze({
        line_ref: edit.line_ref,
        index,
        previous: current,
        changes: Object.freeze([...changes]),
      }),
    );
    ingredients[index] = nextIngredient;
    alreadyEdited.add(edit.line_ref);
    applied.push(
      Object.freeze({
        line_ref: edit.line_ref,
        before: baseText,
        after: nextText,
        changes: Object.freeze([...changes]),
      }),
    );
  }

  const nextRecipe: Record<string, unknown> = {
    ...source,
    ingredients: Object.freeze([...ingredients]),
    // The authored Markdown is a CACHED rendering of the previous ingredient
    // list; it must never shadow the edited fields. The existing serializer
    // rebuilds it on save.
    rawMarkdown: '',
  };

  const appliedCount = applied.length;
  const refusedCount = refused.length;
  const summary =
    appliedCount === 0
      ? refusedCount === 1
        ? `No change was made: ${refused[0]?.message ?? 'the edit was refused.'}`
        : `No changes were made (${refusedCount} edit(s) were refused).`
      : `Applied ${appliedCount} ingredient change(s) to the UNSAVED working copy` +
        (refusedCount > 0 ? `; ${refusedCount} edit(s) were refused.` : '.');

  return {
    ok: true,
    recipe: nextRecipe,
    applied: Object.freeze(applied),
    refused: Object.freeze(refused),
    ledger: Object.freeze(ledger),
    summary,
  };
}
