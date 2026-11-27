import { canonicalStringify, sha256Hex } from '../nutritionV2/usda/digest';

export const SHISO_NUTRITION_AUTHORITY_SETTING = 'shiso_nutrition_authority_v1';

export interface ShisoNutritionAuthorityRecord {
  readonly version: 1;
  readonly enabled: true;
  readonly vault_scope: string;
  readonly granted_at: string;
}

export function nutritionAuthorityVaultScope(input: {
  readonly kind: string;
  readonly locator: string;
} | null): string {
  if (input === null || input.locator.trim().length === 0) return '';
  return `vault:${sha256Hex(canonicalStringify({
    kind: input.kind,
    locator: input.locator.trim(),
  }))}`;
}

export function parseNutritionAuthorityRecord(value: unknown): ShisoNutritionAuthorityRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    record['enabled'] !== true ||
    typeof record['vault_scope'] !== 'string' ||
    !/^vault:[0-9a-f]{64}$/.test(record['vault_scope']) ||
    typeof record['granted_at'] !== 'string' ||
    Number.isNaN(Date.parse(record['granted_at']))
  ) return null;
  return {
    version: 1,
    enabled: true,
    vault_scope: record['vault_scope'],
    granted_at: record['granted_at'],
  };
}

export function nutritionAuthorityEnabled(
  record: ShisoNutritionAuthorityRecord | null,
  currentVaultScope: string,
): boolean {
  return currentVaultScope.length > 0 && record?.enabled === true && record.vault_scope === currentVaultScope;
}

export function grantNutritionAuthority(vaultScope: string, now = new Date()): ShisoNutritionAuthorityRecord {
  if (!/^vault:[0-9a-f]{64}$/.test(vaultScope)) throw new Error('A writable Vault must be connected first.');
  return {
    version: 1,
    enabled: true,
    vault_scope: vaultScope,
    granted_at: now.toISOString(),
  };
}
