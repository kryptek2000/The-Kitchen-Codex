import type { ObsidianRecipe } from '../types';
import { decodeCodexNutrition } from '../core/nutritionV2/validate';

export const SHISO_NUTRITION_HISTORY_SETTING = 'shiso_nutrition_change_history_v1';
export const MAX_SHISO_NUTRITION_HISTORY = 20;

export interface ShisoNutritionChangeRecord {
  readonly id: string;
  readonly vault_scope: string;
  readonly recipe_identity: string;
  readonly recipe_title: string;
  readonly changed_at: string;
  readonly reason: string;
  readonly evidence: string;
  readonly previous: ObsidianRecipe['codexNutrition'];
  readonly next: ObsidianRecipe['codexNutrition'];
}

export function parseNutritionChangeHistory(value: unknown): readonly ShisoNutritionChangeRecord[] {
  if (!Array.isArray(value)) return [];
  return Object.freeze(value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record['id'] !== 'string' || record['id'].length > 160 ||
      typeof record['vault_scope'] !== 'string' || !/^vault:[0-9a-f]{64}$/.test(record['vault_scope']) ||
      typeof record['recipe_identity'] !== 'string' || record['recipe_identity'].length === 0 || record['recipe_identity'].length > 500 ||
      typeof record['recipe_title'] !== 'string' || record['recipe_title'].length > 300 ||
      typeof record['changed_at'] !== 'string' || Number.isNaN(Date.parse(record['changed_at'])) ||
      typeof record['reason'] !== 'string' || record['reason'].length > 500 ||
      typeof record['evidence'] !== 'string' || record['evidence'].length > 1000
    ) return [];
    const previousDecoded = decodeCodexNutrition(record['previous']);
    const nextDecoded = decodeCodexNutrition(record['next']);
    if (previousDecoded.kind === 'malformed' || nextDecoded.kind === 'malformed' || nextDecoded.kind === 'none') return [];
    return [{
      id: record['id'],
      vault_scope: record['vault_scope'],
      recipe_identity: record['recipe_identity'],
      recipe_title: record['recipe_title'],
      changed_at: record['changed_at'],
      reason: record['reason'],
      evidence: record['evidence'],
      previous: previousDecoded.kind === 'none' ? undefined : previousDecoded.value,
      next: nextDecoded.value,
    }];
  }).slice(-MAX_SHISO_NUTRITION_HISTORY));
}

export function appendNutritionChange(
  history: readonly ShisoNutritionChangeRecord[],
  record: ShisoNutritionChangeRecord,
): readonly ShisoNutritionChangeRecord[] {
  return Object.freeze([...history.filter((item) => item.id !== record.id), record].slice(-MAX_SHISO_NUTRITION_HISTORY));
}
