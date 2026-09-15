/**
 * The Kitchen Codex — Vault Intelligence Image Recovery client controller (v0.7 Phase 2B).
 *
 * Platform-neutral UI controller for the per-recipe image-issue surface:
 *
 *   finding -> Generate Image -> loading -> preview -> Save Image / Regenerate / Cancel
 *
 * HARD RULES:
 *   - CAPABILITY GATING: Generate exists ONLY when every required capability is
 *     present (writable connected vault + AssetAdapter + generation-capable
 *     wiring + explicit vaultSessionId). Surfaces that cannot truly save (e.g.
 *     Obsidian) receive NO support object and therefore NO action — never fake
 *     support.
 *   - NO AUTOMATIC / NO BATCH generation: every generation is one explicit
 *     controller call (one click).
 *   - UI STATE holds ONLY returned token metadata (token/contentType/provider/
 *     model) — never bytes, never base64/data URL. The preview renders via the
 *     authenticated preview endpoint path.
 *   - NO optimistic canonical state: onSaved fires ONLY after the canonical save
 *     flow completed both writes.
 *   - LIVENESS: reuses the Create-for-Me session/epoch + runGuarded pattern —
 *     close/cancel/reopen drops stale in-flight generation/save results.
 *   - ERRORS are mapped to bounded user-facing messages; raw provider errors,
 *     prompts, and secrets never reach the UI.
 */

import type { ObsidianRecipe } from '../types';
import type { AssetAdapter } from './adapters/AssetAdapter';
import type { NetworkAdapter } from './adapters/NetworkAdapter';
import type { GeneratedImageSaveResult } from './recipeImageSave';
import { RecipeImageSaveConflictError } from './recipeImageSave';
import { createCreateForMeSession, runGuarded } from './createForMeSession';
import { buildAiSelectionRequestOptions } from './aiSelection';

/** The application-backed image-generation path (same as the server wiring). */
export const GENERATE_RECIPE_IMAGE_PATH = '/api/recipes/image/generate';

/** The server-owned, zero-inference image-generation quote path (Phase 2). */
export const QUOTE_RECIPE_IMAGE_PATH = '/api/recipes/image/quote';

/** The three truthful image cost classes (mirror of the server). */
export type RecipeImageCostClass = 'zero' | 'paid' | 'variable';

/** Server-owned display metadata + (paid/variable) single-use confirmation token. */
export interface RecipeImageGenerationQuote {
  provider: { id: string; name: string };
  model: string;
  credentialSource: 'server_environment' | 'session_only';
  costClass: RecipeImageCostClass;
  costLabel: string;
  requiresConfirmation: boolean;
  confirmationToken?: string;
  confirmationExpiresAt?: number;
}

/** Authenticated transient-preview path for a token (bytes only; never base64-in-JSON). */
export function recipeImagePreviewPath(token: string): string {
  return `/api/recipes/image/preview/${encodeURIComponent(token)}`;
}

/** Creates a fresh, opaque, path-free vault session id (bounded per the save policy). */
export function createVaultSessionId(): string {
  const raw = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `session-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return raw.slice(0, 64);
}

/**
 * The shell-provided support object. Its PRESENCE is the capability gate: the
 * browser shell builds it only for a connected, writable (File System Access)
 * vault with an AssetAdapter, a live image-generation wiring, and an explicit
 * vault session id. Surfaces without full support (Obsidian plugin, starter
 * vault, uploaded folder) pass an unavailable reason instead — never fake support.
 */
export interface RecipeImageRecoverySupport {
  /** Explicit active vault session id (changes when the vault connection changes). */
  vaultSessionId: string;
  /** Asset boundary (required for save + local image-health classification). */
  asset: AssetAdapter;
  /** SHA-256 of the CURRENT canonical recipe Markdown (full text). */
  computeContentHash: (recipe: ObsidianRecipe) => Promise<string>;
  /**
   * Executes the canonical save through `saveGeneratedRecipeImageToVault`
   * (shell-wired with the real vault/asset adapters + trusted preview source).
   */
  saveImage(input: {
    recipePath: string;
    recipeTitle: string;
    token: string;
    activeVaultSessionId: string;
    /** Server-originated token metadata captured at generation time (UI state). */
    preview: {
      contentType: string;
      provider: string;
      model: string;
      recipeContentHash: string;
      vaultSessionId: string;
    };
  }): Promise<GeneratedImageSaveResult>;
}

/** True only when EVERY required capability is present. */
export function isImageRecoverySupported(support: RecipeImageRecoverySupport | undefined): support is RecipeImageRecoverySupport {
  return (
    !!support &&
    typeof support.vaultSessionId === 'string' &&
    support.vaultSessionId.length > 0 &&
    !!support.asset &&
    typeof support.asset.write === 'function' &&
    typeof support.computeContentHash === 'function' &&
    typeof support.saveImage === 'function'
  );
}

/** Controller/UI state. Holds ONLY token metadata, never image bytes. */
export type RecipeImageRecoveryPhase =
  | 'idle'
  | 'quoting'
  | 'confirming'
  | 'generating'
  | 'preview'
  | 'saving'
  | 'saved';

export interface RecipeImagePreviewTokenMetadata {
  token: string;
  contentType: string;
  provider: string;
  model: string;
  recipeContentHash: string;
  vaultSessionId: string;
}

export type RecipeImageRecoveryConflict =
  | 'RECIPE_CHANGED'
  | 'VAULT_CHANGED'
  | 'IMAGE_ALREADY_PRESENT'
  | 'PREVIEW_EXPIRED';

export interface RecipeImageRecoveryState {
  phase: RecipeImageRecoveryPhase;
  /**
   * The current server-owned quote (provider/model/credential/cost + single-use
   * confirmation token). Present while awaiting explicit confirmation.
   */
  quote?: RecipeImageGenerationQuote;
  preview?: RecipeImagePreviewTokenMetadata;
  /** Bounded user-facing message (info/error/success). */
  message?: string;
  messageKind?: 'info' | 'error' | 'success';
  conflict?: RecipeImageRecoveryConflict;
}

/** Builds the BOUNDED generation request from current canonical recipe fields. */
export function buildRecipeImageGenerateRequest(
  recipe: ObsidianRecipe,
  grounding: { vaultSessionId: string; contentHash: string }
): Record<string, unknown> {
  const clean = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients
        .map((ing) => clean((ing as { name?: unknown })?.name, 80))
        .filter(Boolean)
        .slice(0, 60)
    : [];
  return {
    title: clean(recipe.title, 200),
    ...(ingredients.length ? { ingredients } : {}),
    ...(clean(recipe.cuisine, 60) ? { cuisine: clean(recipe.cuisine, 60) } : {}),
    ...(clean(recipe.category, 60) ? { course: clean(recipe.category, 60) } : {}),
    ...(clean(recipe.description, 500) ? { description: clean(recipe.description, 500) } : {}),
    recipeContentHash: grounding.contentHash,
    vaultSessionId: grounding.vaultSessionId,
  };
}

/** Validated client-facing generation result (token metadata ONLY). */
export interface GeneratedRecipeImageClientResult extends RecipeImagePreviewTokenMetadata {
  expiresAt: number;
}

/**
 * POSTs the bounded generation request through the NetworkAdapter and returns the
 * validated token metadata. Throws `RecipeImageProviderClientError` on failure
 * with a bounded message + safe code — never raw provider output.
 */
export class RecipeImageProviderClientError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'RecipeImageProviderClientError';
    this.status = status;
    this.code = code;
  }
}

export async function requestGeneratedRecipeImage(
  network: NetworkAdapter,
  body: Record<string, unknown>,
  confirmationToken?: string
): Promise<GeneratedRecipeImageClientResult> {
  const payload: Record<string, unknown> = confirmationToken
    ? { ...body, confirmationToken }
    : body;
  const res = await network.post<unknown, Record<string, unknown>>(
    GENERATE_RECIPE_IMAGE_PATH,
    payload,
    await buildAiSelectionRequestOptions(undefined, undefined, 'image')
  );
  if (!res.ok) {
    const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
    throw new RecipeImageProviderClientError(
      res.status,
      typeof data['error'] === 'string' && data['error'] ? data['error'] : "Couldn't generate an image right now.",
      typeof data['code'] === 'string' ? data['code'] : undefined
    );
  }
  const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
  const token = typeof data['token'] === 'string' ? data['token'] : '';
  if (!token || token.length > 512) {
    throw new RecipeImageProviderClientError(0, 'The image preview could not be created. Please try again.');
  }
  const str = (key: string, fallback: string): string => {
    const value = data[key];
    return typeof value === 'string' && value ? value.slice(0, 100) : fallback;
  };
  return {
    token,
    contentType: str('contentType', 'image/png'),
    provider: str('provider', 'unknown'),
    model: str('model', 'unknown'),
    recipeContentHash: str('recipeContentHash', ''),
    vaultSessionId: str('vaultSessionId', ''),
    expiresAt: typeof data['expiresAt'] === 'number' ? data['expiresAt'] : 0,
  };
}

/**
 * Requests the server-owned image-generation quote. This makes ZERO provider
 * inference calls: the server resolves the effective provider/model + credential
 * source + trusted pricing truth and returns bounded display metadata and (for a
 * paid/variable model) an opaque single-use confirmation token.
 *
 * The caller MUST supply the SAME canonical generation inputs the generate call
 * will send (title/ingredients/cuisine/course/description): the server binds the
 * authorization to those exact fields (recomputed server-side at quote AND at
 * generate time), so a substituted cross-recipe request fails closed with zero
 * provider calls. Vault Intelligence also passes its vault session id (explicit
 * vault scope); the deliberate no-vault draft flow omits it (explicit
 * server-owned draft scope — never an omitted comparison).
 */
export async function requestImageGenerationQuote(
  network: NetworkAdapter,
  bindings: {
    title?: unknown;
    ingredients?: unknown;
    cuisine?: unknown;
    course?: unknown;
    description?: unknown;
    recipeContentHash?: unknown;
    vaultSessionId?: unknown;
  } = {}
): Promise<RecipeImageGenerationQuote> {
  const body: Record<string, unknown> = {};
  const cleanText = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const clean = value.trim().slice(0, max);
    return clean ? clean : undefined;
  };
  const title = cleanText(bindings.title, 200);
  if (title) body['title'] = title;
  if (Array.isArray(bindings.ingredients)) {
    const names = bindings.ingredients
      .filter((item): item is string => typeof item === 'string')
      .map((name) => name.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 60);
    if (names.length) body['ingredients'] = names;
  }
  const cuisine = cleanText(bindings.cuisine, 60);
  if (cuisine) body['cuisine'] = cuisine;
  const course = cleanText(bindings.course, 60);
  if (course) body['course'] = course;
  const description = cleanText(bindings.description, 500);
  if (description) body['description'] = description;
  if (typeof bindings.recipeContentHash === 'string' && bindings.recipeContentHash) {
    body['recipeContentHash'] = bindings.recipeContentHash;
  }
  if (typeof bindings.vaultSessionId === 'string' && bindings.vaultSessionId) {
    body['vaultSessionId'] = bindings.vaultSessionId;
  }
  const res = await network.post<unknown, Record<string, unknown>>(
    QUOTE_RECIPE_IMAGE_PATH,
    body,
    await buildAiSelectionRequestOptions(undefined, undefined, 'image')
  );
  const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
  if (!res.ok) {
    throw new RecipeImageProviderClientError(
      res.status,
      typeof data['error'] === 'string' && data['error'] ? data['error'] : 'Could not prepare image generation.',
      typeof data['code'] === 'string' ? data['code'] : undefined
    );
  }
  const providerRow = (typeof data['provider'] === 'object' && data['provider'] !== null ? data['provider'] : {}) as Record<string, unknown>;
  const providerId = typeof providerRow['id'] === 'string' ? providerRow['id'] : '';
  const model = typeof data['model'] === 'string' ? data['model'] : '';
  if (!providerId || !model) {
    throw new RecipeImageProviderClientError(0, 'Could not prepare image generation.');
  }
  const credentialSource = data['credentialSource'] === 'session_only' ? 'session_only' : 'server_environment';
  const costClass: RecipeImageCostClass =
    data['costClass'] === 'zero' || data['costClass'] === 'paid' || data['costClass'] === 'variable'
      ? data['costClass']
      : 'variable';
  const quote: RecipeImageGenerationQuote = {
    provider: { id: providerId, name: typeof providerRow['name'] === 'string' ? providerRow['name'].slice(0, 80) : providerId },
    model: model.slice(0, 128),
    credentialSource,
    costClass,
    costLabel:
      typeof data['costLabel'] === 'string' && data['costLabel']
        ? data['costLabel'].slice(0, 120)
        : 'Variable pricing — determined by your provider account',
    requiresConfirmation: data['requiresConfirmation'] === true,
  };
  if (typeof data['confirmationToken'] === 'string' && data['confirmationToken'] && data['confirmationToken'].length <= 512) {
    quote.confirmationToken = data['confirmationToken'];
  }
  if (typeof data['confirmationExpiresAt'] === 'number' && Number.isFinite(data['confirmationExpiresAt'])) {
    quote.confirmationExpiresAt = data['confirmationExpiresAt'];
  }
  return quote;
}

/**
 * Fetches transient generated-preview BYTES through the application
 * NetworkAdapter's authenticated binary path (never a bare fetch). Returns
 * undefined when the adapter has no binary path, or for an unknown/expired token
 * or transport failure. The caller revalidates MIME/signature/size before any
 * write and builds the object URL only from the validated bytes.
 */
export interface RecipeImagePreviewBytes {
  bytes: Uint8Array;
  contentType: string;
}

export async function fetchGeneratedPreviewBytes(
  network: NetworkAdapter,
  token: string
): Promise<RecipeImagePreviewBytes | undefined> {
  if (typeof token !== 'string' || !token || token.length > 512) return undefined;
  if (typeof network.getBytes !== 'function') return undefined;
  try {
    const res = await network.getBytes(recipeImagePreviewPath(token));
    if (!res.ok || !res.bytes || res.bytes.length === 0) return undefined;
    return { bytes: res.bytes, contentType: res.contentType || 'application/octet-stream' };
  } catch {
    return undefined;
  }
}

/**
 * Maps ANY failure (provider client error, save-flow conflict error, unexpected
 * error) onto a BOUNDED user-facing message (+ optional conflict kind). Raw
 * provider errors, prompts, and secrets never pass through.
 */
export function mapRecipeImageRecoveryError(error: unknown): {
  message: string;
  conflict?: RecipeImageRecoveryConflict;
} {
  if (error instanceof RecipeImageSaveConflictError) {
    switch (error.reason) {
      case 'RECIPE_CHANGED':
        return { message: 'The recipe changed since this image was generated. Please regenerate the image.', conflict: 'RECIPE_CHANGED' };
      case 'VAULT_CHANGED':
        return { message: 'The vault has changed since this image was generated. Please try again.', conflict: 'VAULT_CHANGED' };
      case 'IMAGE_ALREADY_PRESENT':
        return { message: 'This recipe already has a valid image. Remove it first if you want to replace it.', conflict: 'IMAGE_ALREADY_PRESENT' };
      case 'PREVIEW_UNAVAILABLE':
        return { message: 'The image preview has expired. Please generate it again.', conflict: 'PREVIEW_EXPIRED' };
      default:
        return { message: 'The image could not be saved. Please try again.' };
    }
  }
  if (error instanceof RecipeImageProviderClientError) {
    const code = error.code ?? '';
    if (error.status === 401 || error.status === 403 || code === 'UNAUTHORIZED') {
      return { message: 'You are not authorized to generate images on this server.' };
    }
    if (error.status === 429 || code === 'RATE_LIMIT') {
      return { message: 'Too many image generation requests. Please wait a moment before trying again.' };
    }
    if (code === 'QUOTA') {
      return { message: 'Image generation is temporarily out of quota. Please try again later.' };
    }
    if (code === 'IMAGE_PROVIDER_NOT_CONFIGURED') {
      return { message: 'No image generation provider is configured on the server.' };
    }
    if (code === 'IMAGE_PROVIDER_QUOTA') {
      return { message: 'Image generation quota has been reached. Please try again later.' };
    }
    if (code === 'IMAGE_PROVIDER_RATE_LIMIT') {
      return { message: 'Image generation is being rate limited. Please wait a moment and try again.' };
    }
    if (code === 'IMAGE_PROVIDER_TIMEOUT') {
      return { message: 'Image generation timed out. Please try again.' };
    }
    if (code === 'IMAGE_PROVIDER_TEMPORARILY_UNAVAILABLE') {
      return { message: 'Image generation is temporarily unavailable. Please try again shortly.' };
    }
    if (code === 'IMAGE_PROVIDER_NO_IMAGE') {
      return { message: 'The image provider did not return an image for this recipe. Try generating again.' };
    }
    if (code === 'IMAGE_PROVIDER_BLOCKED') {
      return { message: 'The image provider could not generate an image for this recipe. Try adjusting the recipe description or generating again.' };
    }
    if (code === 'IMAGE_PROVIDER_AUTH') {
      return { message: 'Image generation could not be authorized. Please check the server configuration.' };
    }
    if (code === 'IMAGE_CONFIRMATION_REQUIRED') {
      return { message: 'This image model requires an explicit confirmation. Review the provider and price, then confirm.' };
    }
    if (code === 'IMAGE_CONFIRMATION_INVALID') {
      return { message: 'The image generation confirmation expired or is no longer valid. Please request a new quote.' };
    }
    if (code === 'IMAGE_CONFIRMATION_CAPACITY') {
      return { message: 'Too many pending image confirmations. Please wait a moment and try again.' };
    }
    if (code === 'IMAGE_QUOTE_FAILED') {
      return { message: "Couldn't prepare image generation right now. Please try again." };
    }
    if (code === 'IMAGE_PREVIEW_UNAVAILABLE') {
      return { message: 'The image preview could not be loaded. Please try again.' };
    }
    if (code === 'INVALID_IMAGE') {
      return { message: 'The generated image was not usable. Please try again.' };
    }
    if (code === 'INVALID_REQUEST') {
      return { message: 'This recipe cannot be used for image generation.' };
    }
    if (error.status === 0 || /timeout|timed out|aborted/i.test(error.message)) {
      return { message: 'The image generation request timed out. Please try again.' };
    }
    if (code === 'PROVIDER_ERROR' || code === 'UNAVAILABLE') {
      return { message: 'The image generation service is temporarily unavailable. Please try again shortly.' };
    }
    return { message: "Couldn't generate an image right now." };
  }
  // Save-flow write failures (asset/Markdown I/O) and anything unexpected.
  return { message: 'The image could not be saved. Please try again.' };
}

export interface RecipeImageRecoveryControllerDeps {
  network: NetworkAdapter;
  support: RecipeImageRecoverySupport;
  /** State sink (the modal passes a React state setter wrapper). */
  onState: (state: RecipeImageRecoveryState) => void;
  /** Invoked ONLY after a successful canonical save (caller updates recipe state). */
  onSaved?: (result: GeneratedImageSaveResult) => void;
}

/**
 * The UI flow controller. Reuses the Create-for-Me session/epoch pattern:
 * `close()`/`cancel()` advance the epoch so late generation/save results are
 * DROPPED (no state repopulation). A single busy guard prevents duplicate
 * Generate AND duplicate Save (and cross-combination) while in flight.
 */
export class RecipeImageRecoveryController {
  private readonly session = createCreateForMeSession();
  private state: RecipeImageRecoveryState = { phase: 'idle' };

  constructor(private readonly deps: RecipeImageRecoveryControllerDeps) {}

  getState(): RecipeImageRecoveryState {
    return this.state;
  }

  private setState(patch: Partial<RecipeImageRecoveryState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  private resetState(): void {
    this.state = { phase: 'idle' };
    this.deps.onState(this.state);
  }

  isBusy(): boolean {
    return this.session.isBusy();
  }

  /**
   * Generate: one EXPLICIT user action. It first requests the server-owned quote
   * (zero provider calls). A verified-zero-price model proceeds directly to the
   * single provider call; a paid/variable model moves to `confirming` and waits
   * for an explicit `confirm()`. No canonical mutation either way.
   */
  async generate(recipe: ObsidianRecipe): Promise<void> {
    if (this.session.isBusy()) return; // duplicate Generate blocked (and Save/Generate cross-blocked)
    const support = this.deps.support;
    if (!isImageRecoverySupported(support)) return;
    this.session.setBusy(true);
    this.setState({ phase: 'quoting', message: undefined, conflict: undefined });
    const quoteResult = await this.guarded(() => this.resolveQuote(recipe));
    if (quoteResult.status === 'dropped') return; // session invalidated: drop
    if (quoteResult.status === 'error') {
      this.session.setBusy(false);
      const mapped = mapRecipeImageRecoveryError(quoteResult.error);
      this.setState({
        phase: this.state.preview ? 'preview' : 'idle',
        message: mapped.message,
        messageKind: 'error',
        conflict: mapped.conflict,
      });
      return;
    }
    const quote = quoteResult.value;
    if (quote.requiresConfirmation) {
      this.session.setBusy(false);
      this.setState({
        phase: 'confirming',
        quote,
        message: `${quote.costLabel}. Confirm to generate one image.`,
        messageKind: 'info',
        conflict: undefined,
      });
      return;
    }
    // Verified zero price: the explicit Generate action is the confirmation.
    await this.confirmInternal(recipe);
  }

  /**
   * Confirm: submits the single-use token from the current quote and performs at
   * most ONE provider call. A failed/consumed token clears the quote so a fresh
   * explicit quote + confirmation is required.
   */
  async confirm(recipe: ObsidianRecipe): Promise<void> {
    if (this.session.isBusy()) return;
    const support = this.deps.support;
    if (!isImageRecoverySupported(support)) return;
    this.session.setBusy(true);
    await this.confirmInternal(recipe);
  }

  /**
   * Regenerate: a NEW paid/variable generation, so it ALWAYS re-quotes and
   * requires a fresh explicit confirmation (a consumed token never authorizes a
   * second call). The old preview is replaced only after the new one succeeds.
   */
  async regenerate(recipe: ObsidianRecipe): Promise<void> {
    await this.generate(recipe);
  }

  /**
   * Liveness-guarded async operation. Returns `{ current: false }` when the
   * session was invalidated (close/cancel) while in flight, so the result is
   * dropped and no state is mutated.
   */
  private async guarded<T>(
    operation: () => Promise<T>
  ): Promise<{ status: 'dropped' } | { status: 'ok'; value: T } | { status: 'error'; error: unknown }> {
    const epoch = this.session.begin();
    try {
      const value = await operation();
      if (!this.session.isCurrent(epoch)) return { status: 'dropped' };
      return { status: 'ok', value };
    } catch (error) {
      if (!this.session.isCurrent(epoch)) return { status: 'dropped' };
      return { status: 'error', error };
    }
  }

  /** Resolves the server-owned quote (zero provider inference calls). */
  private async resolveQuote(recipe: ObsidianRecipe): Promise<RecipeImageGenerationQuote> {
    const support = this.deps.support;
    const contentHash = await support.computeContentHash(recipe);
    // The quote carries the SAME canonical inputs the generate call will send,
    // so the server binds the authorization to this exact recipe request.
    const fields = buildRecipeImageGenerateRequest(recipe, {
      vaultSessionId: support.vaultSessionId,
      contentHash,
    });
    return requestImageGenerationQuote(this.deps.network, {
      ...fields,
      recipeContentHash: contentHash,
      vaultSessionId: support.vaultSessionId,
    });
  }

  /**
   * Performs the single provider call using the current quote's token (busy
   * already held by the caller). On failure the quote is cleared so a consumed
   * token can never authorize a retry.
   */
  private async confirmInternal(recipe: ObsidianRecipe): Promise<void> {
    const support = this.deps.support;
    const quote = this.state.quote;
    const confirmationToken = quote?.requiresConfirmation ? quote.confirmationToken : undefined;
    const previousToken = this.state.preview?.token;
    this.setState({ phase: 'generating', message: undefined, conflict: undefined });
    const result = await this.guarded(async () => {
      const contentHash = await support.computeContentHash(recipe);
      const body = buildRecipeImageGenerateRequest(recipe, {
        vaultSessionId: support.vaultSessionId,
        contentHash,
      });
      return requestGeneratedRecipeImage(this.deps.network, body, confirmationToken);
    });
    if (result.status === 'dropped') return; // session invalidated: drop
    this.session.setBusy(false);
    if (result.status === 'error') {
      const mapped = mapRecipeImageRecoveryError(result.error);
      this.setState({
        phase: this.state.preview ? 'preview' : 'idle',
        quote: undefined,
        message: mapped.message,
        messageKind: 'error',
        conflict: mapped.conflict,
      });
      return;
    }
    const generated = result.value;
    // Replace the preview ONLY after success; abandon the old token best-effort
    // (canonical recipe remains untouched either way).
    if (previousToken && previousToken !== generated.token) {
      void this.invalidateToken(previousToken);
    }
    this.setState({
      phase: 'preview',
      quote: undefined,
      preview: generated,
      message: 'AI-generated preview — nothing is saved yet.',
      messageKind: 'info',
      conflict: undefined,
    });
  }

  /**
   * Save: explicit approval path into the canonical save flow. On conflict the
   * preview is PRESERVED when retry is safe (recipe/vault/image conflicts);
   * an expired preview is dropped back to idle.
   */
  async save(recipe: ObsidianRecipe): Promise<void> {
    if (this.session.isBusy()) return; // duplicate Save blocked
    const preview = this.state.preview;
    if (!preview) return;
    const support = this.deps.support;
    if (!isImageRecoverySupported(support)) return;
    this.session.setBusy(true);
    this.setState({ phase: 'saving', message: undefined, conflict: undefined });
    await runGuarded(
      this.session,
      () =>
        support.saveImage({
          recipePath: recipe.filePath || recipe.fileName || '',
          recipeTitle: recipe.title,
          token: preview.token,
          activeVaultSessionId: support.vaultSessionId,
          preview: {
            contentType: preview.contentType,
            provider: preview.provider,
            model: preview.model,
            recipeContentHash: preview.recipeContentHash,
            vaultSessionId: preview.vaultSessionId,
          },
        }),
      (result) => {
        this.session.setBusy(false);
        this.setState({
          phase: 'saved',
          preview: undefined,
          message: `Image saved to ${result.imagePath}.`,
          messageKind: 'success',
          conflict: undefined,
        });
        this.deps.onSaved?.(result);
      },
      (error) => {
        this.session.setBusy(false);
        const mapped = mapRecipeImageRecoveryError(error);
        if (mapped.conflict === 'PREVIEW_EXPIRED') {
          // The preview is gone: regenerate is required.
          this.setState({ phase: 'idle', preview: undefined, message: mapped.message, messageKind: 'error', conflict: mapped.conflict });
        } else {
          // Conflict with a still-valid preview: keep it so the user can retry
          // (regenerate after fixing) — no canonical mutation happened.
          this.setState({ phase: 'preview', message: mapped.message, messageKind: 'error', conflict: mapped.conflict });
        }
      }
    );
  }

  /**
   * Cancel: clears the preview UI, best-effort invalidates the token, and
   * advances the session so a late in-flight result can never repopulate state.
   * No canonical mutation.
   */
  async cancel(): Promise<void> {
    const token = this.state.preview?.token;
    this.session.advance();
    this.resetState();
    if (token) await this.invalidateToken(token);
  }

  /** Close: same liveness guarantee as cancel, without needing prior state. */
  close(): void {
    const token = this.state.preview?.token;
    this.session.advance();
    this.resetState();
    if (token) void this.invalidateToken(token);
  }

  /** Best-effort token invalidation (server preview-store delete). Never throws. */
  private async invalidateToken(token: string): Promise<void> {
    try {
      await this.deps.network.request({ method: 'DELETE', path: recipeImagePreviewPath(token) });
    } catch {
      // Non-fatal: the token still expires by TTL.
    }
  }
}
