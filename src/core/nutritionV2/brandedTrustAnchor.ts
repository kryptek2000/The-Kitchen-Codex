/**
 * The Kitchen Codex — SINC-2R4 branded signing trust anchor.
 *
 * The trusted server signing identity is a BUILD-TIME constant, not a value a
 * caller can register at runtime. It is a public key (never a secret) injected
 * by the build:
 *
 *   client build: VITE_USDA_BRANDED_SIGNING_PUBLIC_KEY / _KEY_ID -> define
 *   test build:   the fixed synthetic fixture key -> define
 *
 * The application server signs with the matching private key from
 * `USDA_BRANDED_SIGNING_PRIVATE_KEY`. Rotation is explicit: update both the
 * server private key and the client build-time public key, then rebuild.
 *
 * There is no lookup-response registration, no public setter, and no runtime
 * env fallback. If the anchor is absent or malformed, branded Apply is
 * unavailable and the app fails closed.
 */

declare const __TKC_BRANDED_SIGNING_PUBLIC_KEY__: string | undefined;
declare const __TKC_BRANDED_SIGNING_KEY_ID__: string | undefined;

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

function validBase64(value: string): boolean {
  if (value.length < 40) return false;
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}

const rawPublicKey = bounded(
  typeof __TKC_BRANDED_SIGNING_PUBLIC_KEY__ === 'string'
    ? __TKC_BRANDED_SIGNING_PUBLIC_KEY__
    : undefined,
  4096,
);
const rawKeyId = bounded(
  typeof __TKC_BRANDED_SIGNING_KEY_ID__ === 'string'
    ? __TKC_BRANDED_SIGNING_KEY_ID__
    : undefined,
  64,
);
const configured =
  rawPublicKey !== undefined &&
  validBase64(rawPublicKey) &&
  rawKeyId !== undefined &&
  rawKeyId.length >= 8;

/** The immutable build-time anchor. Null means branded Apply is unavailable. */
export const TRUSTED_BRANDED_SIGNING_PUBLIC_KEY: string | null = configured ? rawPublicKey! : null;
export const TRUSTED_BRANDED_SIGNING_KEY_ID: string | null = configured ? rawKeyId! : null;
export const BRANDED_TRUST_ANCHOR_CONFIGURED = configured;

/** True only when the presented identity is EXACTLY the build-time anchor. */
export function matchesTrustedSigningAnchor(publicKey: unknown, keyId: unknown): boolean {
  return (
    configured &&
    publicKey === TRUSTED_BRANDED_SIGNING_PUBLIC_KEY &&
    keyId === TRUSTED_BRANDED_SIGNING_KEY_ID
  );
}
