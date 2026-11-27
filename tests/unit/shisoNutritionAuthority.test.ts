import { describe, expect, it } from 'vitest';

import {
  grantNutritionAuthority,
  nutritionAuthorityEnabled,
  nutritionAuthorityVaultScope,
  parseNutritionAuthorityRecord,
} from '../../src/core/shiso/nutritionAuthority';
import { projectIngredientAlternatives } from '../../src/core/nutritionV2/matching/query';

describe('SHISO standing nutrition authority', () => {
  it('is opt-in and bound to an opaque exact Vault scope', () => {
    const a = nutritionAuthorityVaultScope({ kind: 'filesystem', locator: '/vault/a' });
    const b = nutritionAuthorityVaultScope({ kind: 'filesystem', locator: '/vault/b' });
    expect(a).toMatch(/^vault:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(nutritionAuthorityEnabled(null, a)).toBe(false);
    const grant = grantNutritionAuthority(a, new Date('2026-11-27T12:00:00.000Z'));
    expect(nutritionAuthorityEnabled(grant, a)).toBe(true);
    expect(nutritionAuthorityEnabled(grant, b)).toBe(false);
    expect(parseNutritionAuthorityRecord(grant)).toEqual(grant);
    expect(parseNutritionAuthorityRecord({ ...grant, vault_scope: '/personal/path' })).toBeNull();
  });

  it('projects parenthetical primary alternatives separately from equal choices', () => {
    expect(projectIngredientAlternatives('1/4 cup honey (or brown sugar)')).toEqual({
      alternatives: ['honey', 'brown sugar'],
      primary_index: 0,
    });
    expect(projectIngredientAlternatives('1/4 cup honey or brown sugar')).toEqual({
      alternatives: ['honey', 'brown sugar'],
      primary_index: null,
    });
    expect(projectIngredientAlternatives('1 cup strawberries (cleaned and hulled, sliced)')).toBeNull();
  });
});
