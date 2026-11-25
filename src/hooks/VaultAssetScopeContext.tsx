/**
 * R4 — explicit active Vault asset scope.
 *
 * Components that display or pick Vault-local images read this context. It is
 * supplied ONLY by the App from the authoritative Vault session; there is no
 * process-global fallback. Standalone component tests receive `null` and must
 * provide an explicit scope when they need Vault assets.
 */

import React, { createContext, useContext } from 'react';
import type { VaultAssetScope } from '../utils/vaultAssets';

const VaultAssetScopeContext = createContext<VaultAssetScope | null>(null);

export function VaultAssetScopeProvider({
  scope,
  children,
}: {
  scope: VaultAssetScope;
  children: React.ReactNode;
}) {
  return (
    <VaultAssetScopeContext.Provider value={scope}>
      {children}
    </VaultAssetScopeContext.Provider>
  );
}

export function useVaultAssetScope(): VaultAssetScope | null {
  return useContext(VaultAssetScopeContext);
}
