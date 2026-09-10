/**
 * The Kitchen Codex — Recipe Image Health + Generated-Image Validation (v0.7 Phase 2B1).
 *
 * Platform-neutral foundation for Vault Intelligence Image Recovery.
 *
 * IMAGE-HEALTH TRUTH: the canonical `recipe.image` field is inspected DIRECTLY.
 * `getRecipeImage()` is deliberately NOT used as image truth — it always has an
 * Unsplash stock fallback, which would mask recipes that genuinely have no image.
 *
 * NO REMOTE PROBING: remote references are classified by SYNTAX only (http/https
 * present or malformed). This pass performs ZERO network I/O — no HEAD/GET probes,
 * no SSRF-proxy calls, no content-type checks against remote URLs. Remote health is
 * a future, explicit, user-triggered action (local-first, privacy, latency, rate
 * limits, false negatives).
 *
 * GENERATED-BYTE VALIDATION: provider output is treated as UNTRUSTED binary until it
 * passes `validateGeneratedImage` (MIME allowlist + container/signature agreement +
 * bounded size). SVG is rejected unconditionally; GIF is excluded from generation.
 */

import type { AssetAdapter } from '../application/adapters/AssetAdapter';

// ---------------------------------------------------------------------------
// Image health
// ---------------------------------------------------------------------------

/** Deterministic local image-health states (Phase 2B1). */
export type RecipeImageHealthKind =
  | 'missing'
  | 'broken_local'
  | 'valid_local'
  | 'remote_present'
  | 'invalid_remote'
  | 'unverifiable_local';

export interface RecipeImageHealth {
  kind: RecipeImageHealthKind;
  /** The raw image reference that was assessed (when present). */
  imageRef?: string;
  reason?: string;
  /** Always true: this assessment never performs network I/O and never guesses. */
  deterministic: true;
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/** True for http/https URLs (syntactic scheme check only — no network). */
export function isHttpImageUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/**
 * Syntactic remote-reference validation (NO network I/O). A remote URL is
 * `remote_present` only for a well-formed http(s) URL; anything else is
 * `invalid_remote`.
 */
export function classifyRemoteImageRef(ref: string): 'remote_present' | 'invalid_remote' {
  if (!isHttpImageUrl(ref)) return 'invalid_remote';
  try {
    const url = new URL(ref);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid_remote';
    if (!url.hostname) return 'invalid_remote';
    return 'remote_present';
  } catch {
    return 'invalid_remote';
  }
}

export interface AssessRecipeImageHealthDeps {
  /**
   * Platform asset boundary used to verify LOCAL references (exists + optional
   * bytes signature check). When absent, a local reference cannot be verified
   * truthfully and is reported `unverifiable_local` (never guessed as broken).
   */
  asset?: AssetAdapter;
  /**
   * Optional signature validator for local asset bytes (defaults to the shared
   * generated-image validator, which accepts the same raster allowlist).
   */
  validateLocalBytes?: (bytes: Uint8Array) => boolean;
}

/**
 * Assesses the deterministic image health of a recipe by inspecting the canonical
 * `recipe.image` field directly (never via `getRecipeImage`).
 */
export async function assessRecipeImageHealth(
  recipe: { image?: string },
  deps: AssessRecipeImageHealthDeps = {}
): Promise<RecipeImageHealth> {
  const raw = recipe.image;
  const imageRef = typeof raw === 'string' ? raw.trim() : '';

  // MISSING: absent / undefined / null / blank / whitespace.
  if (isBlank(raw)) {
    return { kind: 'missing', deterministic: true, reason: 'No image is assigned to this recipe.' };
  }

  // Remote references: syntax-only classification (zero network I/O).
  if (isHttpImageUrl(imageRef)) {
    const remote = classifyRemoteImageRef(imageRef);
    return {
      kind: remote,
      imageRef,
      deterministic: true,
      reason:
        remote === 'remote_present'
          ? 'Remote image reference is present (not probed in this phase).'
          : 'Remote image reference is malformed or uses an unsupported scheme.',
    };
  }

  // data:/blob: refs are not canonical local vault assets; treat as invalid here.
  if (/^(data:|blob:)/i.test(imageRef)) {
    return { kind: 'invalid_remote', imageRef, deterministic: true, reason: 'Inline data/blob references are not canonical vault assets.' };
  }

  // Any other explicit scheme (ftp:, file:, javascript:, ...) is an invalid remote
  // reference; only scheme-less refs are treated as local vault paths.
  if (/^[a-z][a-z0-9+.-]*:/i.test(imageRef)) {
    return { kind: 'invalid_remote', imageRef, deterministic: true, reason: 'Unsupported image reference scheme.' };
  }

  // Local reference: verify through the platform asset boundary.
  const asset = deps.asset;
  if (!asset) {
    return {
      kind: 'unverifiable_local',
      imageRef,
      deterministic: true,
      reason: 'Local image reference present, but no vault asset access is available to verify it.',
    };
  }

  const exists = await asset.exists(imageRef);
  if (!exists) {
    return { kind: 'broken_local', imageRef, deterministic: true, reason: 'The referenced image file does not exist in the vault.' };
  }

  // Signature validation only when bytes are actually available through the
  // abstraction (read failures must not fabricate a "broken" verdict on their own).
  try {
    const bytes = await asset.read(imageRef);
    const validate = deps.validateLocalBytes ?? defaultLocalImageBytesValid;
    if (!validate(bytes)) {
      return { kind: 'broken_local', imageRef, deterministic: true, reason: 'The referenced image file is not a supported image.' };
    }
  } catch {
    return {
      kind: 'unverifiable_local',
      imageRef,
      deterministic: true,
      reason: 'The referenced image exists but could not be read for validation.',
    };
  }

  return { kind: 'valid_local', imageRef, deterministic: true, reason: 'Local image reference resolves to a supported image.' };
}

function defaultLocalImageBytesValid(bytes: Uint8Array): boolean {
  return validateGeneratedImage({ bytes, contentType: sniffGeneratedImageMime(bytes) ?? '' }).valid;
}

// ---------------------------------------------------------------------------
// Generated-image validation
// ---------------------------------------------------------------------------

/** MIME types accepted for NEW generated images (no SVG, no GIF in Phase 2B). */
export const GENERATED_IMAGE_MIME_ALLOWLIST = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;

export type GeneratedImageMime = (typeof GENERATED_IMAGE_MIME_ALLOWLIST)[number];

/** Hard cap for generated PREVIEW bytes in Phase 2B. */
export const MAX_GENERATED_IMAGE_BYTES = 4 * 1024 * 1024;
/** Minimum sensible non-empty image payload (smallest valid signature header). */
export const MIN_GENERATED_IMAGE_BYTES = 12;

export interface GeneratedImageInput {
  bytes: Uint8Array;
  /** Provider-declared MIME type (untrusted). */
  contentType: string;
}

export interface GeneratedImageValidation {
  valid: boolean;
  /** Detected container/MIME from the actual bytes (when determinable). */
  detectedMime?: GeneratedImageMime;
  error?: string;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

const JPEG_SOI = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = offset; i < offset + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * Detects the container/MIME identity from the actual bytes (no trust in metadata).
 * AVIF uses a REAL ISO-BMFF `ftyp` box check with compatible brands — never a
 * fake "00 00 00 means AVIF" signature.
 */
export function sniffGeneratedImageMime(bytes: Uint8Array): GeneratedImageMime | undefined {
  if (startsWith(bytes, JPEG_SOI)) return 'image/jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';

  // ISO BMFF: [size:4][ftyp:4][majorBrand:4][minorVersion:4][compatibleBrands...]
  if (bytes.length >= 12 && readAscii(bytes, 4, 4) === 'ftyp') {
    const boxSize = readU32BE(bytes, 0);
    if (boxSize < 12 || boxSize > bytes.length) return undefined;
    const major = readAscii(bytes, 8, 4);
    const compatCount = Math.max(0, Math.floor((boxSize - 16) / 4));
    const brands = [major];
    for (let i = 0; i < compatCount; i++) {
      brands.push(readAscii(bytes, 16 + i * 4, 4));
    }
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'image/avif';
  }
  return undefined;
}

function normalizeMime(contentType: string): string {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Validates UNTRUSTED generated image bytes:
 *   A. provider-declared MIME must be in the generated allowlist (jpeg/png/webp/avif)
 *   B. SVG rejected unconditionally; GIF rejected for generation
 *   C. bounded size (non-empty minimum, hard 4MB max)
 *   D. byte signature/container must AGREE with the declared MIME (no silent relabel)
 *   E. obviously truncated/malformed input rejected
 */
export function validateGeneratedImage(input: GeneratedImageInput): GeneratedImageValidation {
  const declared = normalizeMime(input.contentType);
  const bytes = input.bytes;

  if (!GENERATED_IMAGE_MIME_ALLOWLIST.includes(declared as GeneratedImageMime)) {
    return {
      valid: false,
      error: declared.includes('svg')
        ? 'Generated SVG images are not supported.'
        : declared.includes('gif')
        ? 'Generated GIF images are not supported in this phase.'
        : `Unsupported generated image type "${declared || 'unknown'}".`,
    };
  }
  if (!bytes || bytes.length === 0) {
    return { valid: false, error: 'Generated image is empty.' };
  }
  if (bytes.length < MIN_GENERATED_IMAGE_BYTES) {
    return { valid: false, error: 'Generated image is too small to be a valid image.' };
  }
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    return { valid: false, error: `Generated image exceeds the ${MAX_GENERATED_IMAGE_BYTES} byte limit.` };
  }

  const detected = sniffGeneratedImageMime(bytes);
  if (!detected) {
    return { valid: false, error: 'Generated image bytes are not a recognized supported image container.' };
  }
  if (detected !== declared) {
    return {
      valid: false,
      detectedMime: detected,
      error: `Generated image content does not match its declared type (declared ${declared}, bytes are ${detected}).`,
    };
  }
  return { valid: true, detectedMime: detected };
}

// ---------------------------------------------------------------------------
// Pre-decode base64 guard (shared by image providers)
// ---------------------------------------------------------------------------

/**
 * PRE-DECODE GUARD — encoded-length cap, derived mathematically (not arbitrary).
 *
 * Standard base64 encodes 3 bytes into 4 characters. For a string of n
 * SIGNIFICANT base64 characters (excluding '=' padding and ASCII whitespace —
 * neither adds decoded bytes), a decoder yields at most `3*floor(n/4) + 2` bytes.
 * Solving `3*floor(n/4) + 2 <= MAX_GENERATED_IMAGE_BYTES` gives
 * `n <= 4*floor(MAX/3) + 2`:
 *
 *   4 * floor(4194304 / 3) + 2 = 5592406
 *
 * Checking the boundary: n = 5592406 decodes to at most 4194304 bytes (== cap,
 * accepted); n = 5592407 decodes to at most 4194305 bytes (> cap, rejected).
 * A properly padded encoding of an exactly-cap-sized payload has 5592404
 * significant chars + "==" — padding is excluded from the count, so it is
 * accepted, never falsely rejected.
 *
 * The count treats EVERY other character as significant. Node's decoder leniently
 * skips some invalid characters, so counting them OVER-rejects — the safe
 * direction. The cap is enforced BEFORE any Buffer.from() allocation, so an
 * oversized/malicious payload is rejected without a single decoded byte being
 * allocated. The payload string itself is NEVER logged.
 */
export const MAX_GENERATED_IMAGE_BASE64_CHARS = 4 * Math.floor(MAX_GENERATED_IMAGE_BYTES / 3) + 2;

const BASE64_WHITESPACE = new Set([
  0x09, 0x0a, 0x0d, 0x20, 0x0b, 0x0c, // \t \n \r space \v \f
]);

/**
 * Counts significant base64 characters (everything except '=' padding and ASCII
 * whitespace) WITHOUT allocating or decoding anything. A single O(n) scan of the
 * already-in-memory response string; rejects before any decoded allocation.
 */
export function countSignificantBase64Chars(encoded: string): number {
  let significant = 0;
  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    if (code === 0x3d /* '=' */ || BASE64_WHITESPACE.has(code)) continue;
    significant++;
  }
  return significant;
}

// ---------------------------------------------------------------------------
// Conflict-detection foundation (for the later Save pass)
// ---------------------------------------------------------------------------

/** Algorithm used for the canonical recipe-content fingerprint. */
export const RECIPE_CONTENT_HASH_ALGORITHM = 'sha256';

/**
 * Opaque, canonical-content fingerprint captured at preview time so a later Save
 * can detect that the recipe's canonical Markdown changed underneath the preview.
 * The hash covers the FULL canonical Markdown (unknown frontmatter and freeform
 * content are canonical too) — never merely title/ingredients/instructions/image.
 * No absolute path is persisted.
 */
export interface RecipeVersionFingerprint {
  /** Hex SHA-256 of the recipe's canonical Markdown at preview time. */
  recipeContentHash: string;
}

/** Active canonical vault session identity (changes whenever the vault changes). */
export interface VaultSessionIdentity {
  /** Opaque session id; NOT a path, NOT a handle reference. */
  vaultSessionId: string;
}

/** Validates the opaque hex recipe-content hash shape (no semantics, no decode). */
export function isValidRecipeContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Validates the opaque vault-session id shape (bounded, no path semantics). */
export function isValidVaultSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}
