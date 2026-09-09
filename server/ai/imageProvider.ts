/**
 * The Kitchen Codex — ImageProvider abstraction (v0.7 Phase 2B foundation).
 *
 * A SEPARATE, provider-neutral image-generation contract. Binary image generation
 * deliberately does NOT live on the text-generation `AiProvider` interface (its
 * methods are text/structured/search); forcing binary generation there would bloat
 * the text contract for every provider. Image providers plug in beside it.
 *
 * SERVER-SIDE ONLY. Provider credentials stay behind server env (same operator
 * secret boundary as the AI providers). No API key ever reaches the browser.
 *
 * SHARED INFRASTRUCTURE: reuses the existing provider error taxonomy
 * (`ProviderOperationError`, classify/normalize) and the shared generated-image
 * validation boundary (`src/core/recipeImage.validateGeneratedImage`) instead of
 * duplicating either.
 *
 * PHASE-2B NOTE: the production default provider is `GeminiImageProvider`
 * (`geminiImageProvider.ts`, proven SDK semantics); `DeterministicImageProvider`
 * below is an explicit, clearly-labeled TEST SEAM producing a real, valid PNG —
 * it exercises the full validation + preview-store path hermetically with zero
 * network I/O and must never be wired as a production default.
 */

import type { AssetBytes } from '../../src/application/adapters/AssetAdapter';
import {
  validateGeneratedImage,
  GENERATED_IMAGE_MIME_ALLOWLIST,
  type GeneratedImageMime,
} from '../../src/core/recipeImage.js';
import { ProviderOperationError } from './providerErrors.js';

/** Image-provider capabilities (owned by ImageProvider, NOT by AiCapabilities). */
export interface ImageProviderCapabilities {
  /** True when this provider can generate images at all. */
  imageGeneration: boolean;
  /** Generated MIME types this provider can emit (subset of the shared allowlist). */
  formats?: GeneratedImageMime[];
  /** Documented hard byte limit of the provider (defaults to the shared 4MB cap). */
  maxBytes?: number;
}

/** Options for a single image-generation request. */
export interface ImageGenerateOptions {
  /** Provider model id. REQUIRED (no silent default). */
  model: string;
  /**
   * Bounded, grounded recipe context already composed by the caller. Providers MUST
   * NOT accept arbitrary caller instructions that bypass the grounding rules.
   */
  prompt: string;
  temperature?: number;
}

/** A validated generated image (bytes + true container type). */
export interface GeneratedImage extends AssetBytes {
  /** Validated content type (agrees with the actual byte signature). */
  contentType: GeneratedImageMime;
  provider: string;
  model: string;
}

export interface ImageProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ImageProviderCapabilities;

  /** True when this provider can be used with the current configuration. */
  isAvailable(): boolean;

  /**
   * Generates one image. Returns VALIDATED bytes (container/MIME agreement enforced)
   * or throws a normalized provider error. Implementations MUST run the shared
   * validation boundary before returning.
   */
  generateImage(prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage>;
}

/** Maps generated-image validation failures onto normalized provider semantics. */
export class ImageValidationError extends ProviderOperationError {
  constructor(message: string, ctx: { providerId?: string; model?: string } = {}) {
    super("INVALID_RESPONSE", message, ctx);
    this.name = "ImageValidationError";
  }
}

/**
 * The provider refused/blocked generation for safety (prompt blocked, or every
 * candidate was safety-filtered). Preserved as a DISTINCT outcome so the UI can
 * tell "blocked" from "no image" / "upstream hiccup".
 */
export class ImageBlockedError extends ProviderOperationError {
  constructor(message: string, ctx: { providerId?: string; model?: string } = {}) {
    super("BLOCKED", message, ctx);
    this.name = "ImageBlockedError";
  }
}

/**
 * A successful response that contained NO inline image (e.g. text-only or empty
 * candidate). DISTINCT from a hard provider failure and from a block.
 */
export class ImageNoImageError extends ProviderOperationError {
  constructor(message: string, ctx: { providerId?: string; model?: string } = {}) {
    super("NO_IMAGE", message, ctx);
    this.name = "ImageNoImageError";
  }
}

/** Re-exported for endpoint/provider use without a new import surface. */
export { GENERATED_IMAGE_MIME_ALLOWLIST, validateGeneratedImage };

/** The deterministic Phase-2B seam: a real, valid 1x1 PNG, zero network I/O. */
const DETERMINISTIC_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function deterministicPngBytes(): Uint8Array {
  const binary = Buffer.from(DETERMINISTIC_PNG_BASE64, 'base64');
  return new Uint8Array(binary);
}

/**
 * Deterministic image provider (foundation seam). Emits a small VALID PNG so the
 * validation + preview-store + endpoint path is fully exercisable hermetically.
 * NOT a real model: it never interprets the prompt and never touches a network.
 */
export class DeterministicImageProvider implements ImageProvider {
  readonly id = 'deterministic-image';
  readonly name = 'Deterministic Image (Phase 2B seam)';
  readonly capabilities: ImageProviderCapabilities = {
    imageGeneration: true,
    formats: ['image/png'],
    maxBytes: 1024 * 1024,
  };

  isAvailable(): boolean {
    // Deterministic seam: always available, no configuration required.
    return true;
  }

  async generateImage(_prompt: string, options: ImageGenerateOptions): Promise<GeneratedImage> {
    if (!options?.model) {
      throw new ProviderOperationError("INVALID_RESPONSE", "Image model is required.", { providerId: this.id });
    }
    const bytes = deterministicPngBytes();
    const contentType = 'image/png';
    const validation = validateGeneratedImage({ bytes, contentType });
    if (!validation.valid) {
      throw new ImageValidationError(`Deterministic provider produced an invalid image: ${validation.error}`, {
        providerId: this.id,
        model: options.model,
      });
    }
    return { bytes, contentType: validation.detectedMime ?? contentType, provider: this.id, model: options.model };
  }
}
