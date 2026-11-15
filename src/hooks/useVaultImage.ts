import { useEffect, useState } from 'react';
import {
  syncResolveVaultAssetUrl,
  resolveVaultAssetUrl,
  cleanImageReference,
} from '../utils/vaultAssets';
import {
  isDisplayableBlobUrl,
  isRemoteOrDataReference,
  subscribeTemporaryPreviewUrls,
} from '../utils/assetProvenance';
import { DEFAULT_FOOD_IMAGES } from '../utils/imageHelper';
import { useVaultAssetScope } from './VaultAssetScopeContext';
import type { VaultAssetScope } from '../utils/vaultAssets';

interface ImageResolution {
  scope: VaultAssetScope | null;
  ref: string;
  fallback: string;
  url: string;
}

function initialDisplayUrl(
  imageRef: string | undefined,
  fallbackUrl: string,
  assetScope: VaultAssetScope | null
): string {
  if (!imageRef) return fallbackUrl;
  const clean = cleanImageReference(imageRef);
  if (!clean) return fallbackUrl;
  if (isRemoteOrDataReference(clean)) return clean;
  if (clean.startsWith('blob:')) {
    return isDisplayableBlobUrl(clean, assetScope) ? clean : fallbackUrl;
  }
  return syncResolveVaultAssetUrl(clean, assetScope) || fallbackUrl;
}

/**
 * R5 — reactive Vault image resolution.
 *
 * Scope identity, image identity, fallback and URL lifecycle are part of the
 * rendered state. A render after a provider/scope change never presents the
 * previous scope's URL: the derived value falls back to the current scope's
 * initial resolution until the effect installs the matching subscription. Late
 * async results are rejected after cleanup/scope deactivation, and same-scope
 * asset replacement/deactivation notifies subscribed consumers.
 */
export function useVaultImage(
  imageRef?: string,
  fallbackUrl: string = DEFAULT_FOOD_IMAGES.default,
  folderHandle?: any
): string {
  const assetScope = useVaultAssetScope();
  const ref = imageRef ?? '';
  const [resolution, setResolution] = useState<ImageResolution>(() => ({
    scope: assetScope,
    ref,
    fallback: fallbackUrl,
    url: initialDisplayUrl(imageRef, fallbackUrl, assetScope),
  }));

  const matchesCurrentIdentity =
    resolution.scope === assetScope &&
    resolution.ref === ref &&
    resolution.fallback === fallbackUrl;
  // Even before a subscription notification is painted, never return a blob
  // URL the current scope/preview registry no longer owns.
  const resolutionUrlIsLive =
    !resolution.url.startsWith('blob:') ||
    isDisplayableBlobUrl(resolution.url, assetScope);
  const displayUrl =
    matchesCurrentIdentity && resolutionUrlIsLive
      ? resolution.url
      : initialDisplayUrl(imageRef, fallbackUrl, assetScope);

  useEffect(() => {
    let cancelled = false;
    const setForCurrent = (url: string) => {
      if (cancelled) return;
      setResolution((previous) =>
        previous.scope === assetScope &&
        previous.ref === ref &&
        previous.fallback === fallbackUrl &&
        previous.url === url
          ? previous
          : { scope: assetScope, ref, fallback: fallbackUrl, url }
      );
    };

    // Establish the current scope/reference value before any async work. React
    // bails out when the state is already identical.
    setForCurrent(initialDisplayUrl(imageRef, fallbackUrl, assetScope));

    if (!imageRef) return;
    const clean = cleanImageReference(imageRef);
    if (!clean) return;
    if (isRemoteOrDataReference(clean)) return;

    const unsubscribePreview = clean.startsWith('blob:')
      ? subscribeTemporaryPreviewUrls(() => {
          if (cancelled) return;
          const next = syncResolveVaultAssetUrl(clean, assetScope);
          setForCurrent(next || fallbackUrl);
        })
      : null;

    if (!assetScope) return () => unsubscribePreview?.();

    // A blob is either scope-owned, a temporary preview, or unknown. Scope and
    // preview subscriptions above/below keep its lifecycle reactive.
    if (clean.startsWith('blob:')) {
      const unsubscribeScope = assetScope.subscribe(() => {
        if (cancelled) return;
        const next = syncResolveVaultAssetUrl(clean, assetScope);
        setForCurrent(next || fallbackUrl);
      });
      return () => {
        cancelled = true;
        unsubscribePreview?.();
        unsubscribeScope();
      };
    }

    if (!assetScope.isAccepting()) return () => unsubscribePreview?.();

    // If the asset is already registered, the subscription below handles later
    // replacement/deactivation; no async read is needed.
    const sync = syncResolveVaultAssetUrl(clean, assetScope);
    if (!sync) {
      resolveVaultAssetUrl(clean, folderHandle, assetScope).then((asyncResult) => {
        if (cancelled) return;
        // Recheck at application time: the scope may have been deactivated or
        // superseded while the file handle read was pending.
        if (!assetScope.isAccepting()) return;
        if (!asyncResult) return;
        setForCurrent(asyncResult);
      });
    }

    const unsubscribeScope = assetScope.subscribe(() => {
      if (cancelled) return;
      const next = syncResolveVaultAssetUrl(clean, assetScope);
      setForCurrent(next || fallbackUrl);
    });

    return () => {
      cancelled = true;
      unsubscribePreview?.();
      unsubscribeScope();
    };
  }, [imageRef, ref, fallbackUrl, folderHandle, assetScope]);

  return displayUrl;
}
