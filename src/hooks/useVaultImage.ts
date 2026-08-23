import { useState, useEffect } from 'react';
import {
  syncResolveVaultAssetUrl,
  resolveVaultAssetUrl,
  cleanImageReference,
  vaultAssets,
} from '../utils/vaultAssets';
import { DEFAULT_FOOD_IMAGES } from '../utils/imageHelper';

export function useVaultImage(
  imageRef?: string,
  fallbackUrl: string = DEFAULT_FOOD_IMAGES.default,
  folderHandle?: any
): string {
  const [resolvedUrl, setResolvedUrl] = useState<string>(() => {
    if (!imageRef) return fallbackUrl;
    const syncResult = syncResolveVaultAssetUrl(imageRef);
    if (syncResult) return syncResult;
    const clean = cleanImageReference(imageRef);
    if (
      clean.startsWith('http://') ||
      clean.startsWith('https://') ||
      clean.startsWith('data:') ||
      clean.startsWith('blob:')
    ) {
      return clean;
    }
    return fallbackUrl;
  });

  useEffect(() => {
    if (!imageRef) {
      setResolvedUrl(fallbackUrl);
      return;
    }

    const clean = cleanImageReference(imageRef);
    if (
      clean.startsWith('http://') ||
      clean.startsWith('https://') ||
      clean.startsWith('data:') ||
      clean.startsWith('blob:')
    ) {
      setResolvedUrl(clean);
      return;
    }

    // Try synchronous resolution first
    const sync = syncResolveVaultAssetUrl(clean);
    if (sync) {
      setResolvedUrl(sync);
      return;
    }

    // Attempt async resolution from handle
    let isMounted = true;
    resolveVaultAssetUrl(clean, folderHandle).then((asyncResult) => {
      if (isMounted && asyncResult) {
        setResolvedUrl(asyncResult);
      }
    });

    // Subscribe to asset registry updates
    const unsubscribe = vaultAssets.subscribe(() => {
      const updated = syncResolveVaultAssetUrl(clean);
      if (isMounted && updated) {
        setResolvedUrl(updated);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [imageRef, fallbackUrl, folderHandle]);

  return resolvedUrl;
}
