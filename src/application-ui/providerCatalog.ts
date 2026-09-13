/**
 * The Kitchen Codex — Provider Model Catalog View Model (BYOK-1).
 *
 * Client-side, platform-neutral logic for the read-only Provider Model Catalog
 * UI. It mirrors the SERVER catalog (`server/ai/providerCatalog.ts`) without
 * importing server code, so the browser bundle never pulls in server-only
 * modules or secrets.
 *
 * FAIL-CLOSED DESIGN (mirrors `providerStatus.ts`):
 *   - Every field is validated and ONLY allowlisted fields are copied into the
 *     client view-model; a secret-shaped field can never survive normalization.
 *   - Unknown capability keys normalize to `false`; unknown model fields are
 *     dropped.
 *   - Image `formats` are restricted to the shared generated-image allowlist; an
 *     image provider whose formats are entirely unknown is rejected.
 *   - A fundamentally malformed payload throws so the UI renders a bounded
 *     "catalog unavailable" state instead of fabricating providers/models.
 */

import type { NetworkAdapter, NetworkResponse } from '../application/adapters/NetworkAdapter';
import { isOpenRouterProfile, type OpenRouterProfile } from '../core/ai/openRouterProfile';
import type { SecretStorageScope } from '../application/adapters/SecretAdapter';
import type { AiCapabilities } from '../core/ai/types';
import {
  GENERATED_IMAGE_MIME_ALLOWLIST,
  type GeneratedImageMime,
} from '../core/recipeImage';

/** The single application-backed catalog path (read-only). */
export const PROVIDER_CATALOG_API_PATH = '/api/providers/catalog';

/**
 * v0.8.x explicit OpenRouter capability-verification path (server-validated).
 * The provider is FIXED to `openrouter`; only the model id is caller-supplied.
 */
export const OPENROUTER_MODEL_VERIFY_API_PATH = '/api/providers/openrouter/models';

/** Builds the exact verification path for one model id (segments encoded). */
export function openRouterModelVerifyPath(modelId: string): string {
  const encoded = modelId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${OPENROUTER_MODEL_VERIFY_API_PATH}/${encoded}/verify`;
}

/** The probe surface the server performs for a provider (non-secret, non-proprietary). */
export type ConnectionTestKindView = 'network_probe' | 'credential_check' | 'unavailable';

/** Normalized per-token pricing view (dynamic catalog; never a secret). */
export interface CatalogPricingView {
  promptPerToken: number | null;
  completionPerToken: number | null;
  imageOutputPerToken: number | null;
  variable: boolean;
}

/** User-facing cost class. */
export type CatalogCostClassView = 'free' | 'budget' | 'paid' | 'variable';

/** A view-model text model row (only allowlisted fields). */
export interface ProviderCatalogTextModelView {
  id: string;
  /** True when this model is the primary (first) role candidate for an operation. */
  default: boolean;
  /** Per-model effective capabilities (server-owned truth). */
  capabilities: AiCapabilities;
  /** Non-secret display name (dynamic catalog; falls back to the id). */
  displayName?: string;
  contextLength?: number;
  pricing?: CatalogPricingView;
  isFree?: boolean;
  /** True only when every pricing field parsed finite from a live record. */
  pricingVerified?: boolean;
  /** Server-owned verified strict-structured compatibility. */
  structuredVerified?: boolean;
  /** True when a CURRENT runtime capability verification made this model executable. */
  capabilityVerified?: boolean;
  /**
   * SERVER-OWNED candidate prefilter (never execution authority): currently
   * verified FREE, fresh, non-router, ordinary text output, and advertises BOTH
   * response_format + structured_outputs. Runtime verification is still required.
   */
  strictStructuredCandidate?: boolean;
  jsonCandidate?: boolean;
  verifiedProfile?: OpenRouterProfile;
  /** True when the model may execute on the current Kitchen Codex transport. */
  executionCompatible?: boolean;
  /** UI compatibility state. */
  compatibility?: 'compatible' | 'experimental' | 'unsupported';
  isRouter?: boolean;
  costClass?: CatalogCostClassView;
  inputModalities?: string[];
  outputModalities?: string[];
  vision?: boolean;
  largeContext?: boolean;
}

/** A view-model text provider (only allowlisted fields). */
export interface ProviderCatalogTextProviderView {
  providerId: string;
  name: string;
  configured: boolean;
  enabled: boolean;
  available: boolean;
  storageScope: SecretStorageScope;
  supportsSecretWrites: boolean;
  /** The server connection-test surface for this provider. */
  connectionTest: ConnectionTestKindView;
  /** True when the user may select this provider on this surface. */
  selectable: boolean;
  /**
   * BYOK-5F: server-owned capability — this provider can be authorized by an exact
   * provider-scoped session credential, so it is selectable with
   * `credentialSource=session_only` even when the operator environment key is
   * absent. Fail-closed false when the server omits it.
   */
  sessionKeySupported: boolean;
  models: ProviderCatalogTextModelView[];
  /** v0.8.0: discovered but NON-selectable informational models (never executable). */
  discoveredModels?: ProviderCatalogTextModelView[];
}

/** A view-model image model row. */
export interface ProviderCatalogImageModelView {
  id: string;
  default: boolean;
  displayName?: string;
  pricing?: CatalogPricingView;
  isFree?: boolean;
  pricingVerified?: boolean;
  compatibility?: 'compatible' | 'experimental' | 'unsupported';
  costClass?: CatalogCostClassView;
}

/** A view-model image provider (only allowlisted fields). */
export interface ProviderCatalogImageProviderView {
  providerId: string;
  name: string;
  configured: boolean;
  enabled: boolean;
  available: boolean;
  /** The server connection-test surface for this provider. */
  connectionTest: ConnectionTestKindView;
  /** True when the user may select this provider on this surface. */
  selectable: boolean;
  /**
   * BYOK-5F: server-owned capability — this image provider can be authorized by
   * an exact provider-scoped session credential, independent of the operator
   * environment key. Fail-closed false when the server omits it.
   */
  sessionKeySupported: boolean;
  /** True when this provider may generate images. */
  imageGeneration: boolean;
  /** Allowlisted generated MIME types (unknown formats are never surfaced). */
  formats: GeneratedImageMime[];
  /** Provider-documented hard byte limit. */
  maxBytes: number;
  models: ProviderCatalogImageModelView[];
}

/** The effective server-managed selection mode (read-only, non-secret). */
export type SelectionModeView = 'server_default' | 'server_managed';

/** Client-facing selection truth (mirrors the server; never a secret value). */
export interface ProviderSelectionView {
  selectionMode: SelectionModeView;
  /** Present only when server-managed (provider pin). */
  selectedProviderId?: string;
  /** Present only when server-managed (optional model pin). */
  selectedModelId?: string;
  /** False when a pin is invalid — the runtime then fails closed (never uses another provider). */
  valid: boolean;
}

/** The client-facing provider + model catalog view. */
export interface ProviderCatalogView {
  textProviders: ProviderCatalogTextProviderView[];
  imageProviders: ProviderCatalogImageProviderView[];
  selection: {
    text: ProviderSelectionView;
    image: ProviderSelectionView;
    /**
     * True when the user is currently PERMITTED to override a surface:
     * honored only when there is NO valid server-managed pin. When false, the
     * UI must present the selection as read-only (server-managed).
     */
    userSelectionAllowed: { text: boolean; image: boolean };
    /**
     * Runtime PROVIDER-AVAILABILITY truth (distinct from config-valid `valid`):
     * whether the effective provider is configured/available right now. This is
     * deliberately NOT an operation-readiness claim — a provider may be
     * available yet unable to satisfy a specific operation's capability
     * contract. The UI labels it "Runtime provider available/unavailable".
     * Fail-closed default when the server does not expose it.
     */
    executable: { text: boolean; image: boolean };
  };
  /**
   * BYOK-5E: server-reported deployment capability for session-only BYOK.
   * Optional; treat `true` as supported and anything else as fail-closed.
   */
  sessionByokSupported?: boolean;
  /**
   * v0.8.0: non-secret dynamic OpenRouter catalog observability. Optional and
   * fail-closed; absent when the server does not expose it.
   */
  dynamicCatalog?: {
    source: 'live' | 'cached' | 'curated_fallback';
    fetchedAt: number;
    pricingFresh: boolean;
    textModelCount: number;
    freeTextModelCount: number;
    verifiedFreeTextCount: number;
    selectableTextCount: number;
    imageModelCount: number;
    freeImageModelCount: number;
    selectableImageCount: number;
    freeRouterVerified: boolean;
  };
}

/** The raw response shape from `GET /api/providers/catalog`. */
interface ProviderCatalogResponse {
  catalog?: unknown;
}

const TEXT_CAPABILITY_KEYS: (keyof AiCapabilities)[] = [
  'reasoning',
  'structuredOutput',
  'recipeGeneration',
  'webSearch',
];

/**
 * The truthful storage scopes accepted by the catalog view (mirrors the
 * SecretAdapter contract). The current server catalog emits only
 * `server_environment` for provider rows, but `unavailable` is a valid scope and
 * is retained so a truthful future payload is never silently dropped; an
 * UNKNOWN scope still fails closed (the row is rejected).
 */
const KNOWN_STORAGE_SCOPES: SecretStorageScope[] = [
  'server_environment',
  'secure_platform',
  'local_plaintext',
  'session_only',
  'unavailable',
];

/** The probe surface allowlist (mirror of the server catalog truth). */
const KNOWN_CONNECTION_TEST_KINDS: ConnectionTestKindView[] = [
  'network_probe',
  'credential_check',
  'unavailable',
];

function normalizeConnectionTestKind(raw: unknown): ConnectionTestKindView | null {
  if (typeof raw === 'string' && (KNOWN_CONNECTION_TEST_KINDS as string[]).includes(raw)) {
    return raw as ConnectionTestKindView;
  }
  return null;
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function asBoolean(v: unknown): boolean {
  return v === true;
}

/** Validates + normalizes one selection-truth block (text or image). */
function normalizeSelection(raw: unknown): ProviderSelectionView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const block = raw as Record<string, unknown>;
  if (block['selectionMode'] !== 'server_default' && block['selectionMode'] !== 'server_managed') return null;
  if (!isBoolean(block['valid'])) return null;
  const view: ProviderSelectionView = {
    selectionMode: block['selectionMode'],
    valid: block['valid'],
  };
  if (typeof block['selectedProviderId'] === 'string' && block['selectedProviderId'].length > 0) {
    view.selectedProviderId = block['selectedProviderId'];
  }
  if (typeof block['selectedModelId'] === 'string' && block['selectedModelId'].length > 0) {
    view.selectedModelId = block['selectedModelId'];
  }
  return view;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

const COST_CLASSES: CatalogCostClassView[] = ['free', 'budget', 'paid', 'variable'];

function normalizeCostClass(raw: unknown): CatalogCostClassView | undefined {
  return typeof raw === 'string' && (COST_CLASSES as string[]).includes(raw)
    ? (raw as CatalogCostClassView)
    : undefined;
}

/** Normalizes an optional, non-secret per-token pricing block. */
function normalizePricing(raw: unknown): CatalogPricingView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  const component = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    promptPerToken: component(row['promptPerToken']),
    completionPerToken: component(row['completionPerToken']),
    imageOutputPerToken: component(row['imageOutputPerToken']),
    variable: row['variable'] === true,
  };
}

function normalizeModalities(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) if (typeof item === 'string' && item) out.push(item);
  return out;
}

/** Normalizes a text model row, keeping ONLY allowlisted fields. */
function normalizeTextModel(raw: unknown): ProviderCatalogTextModelView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['id'] !== 'string' || row['id'].length === 0 || !isBoolean(row['default'])) return null;
  const capsRaw = row['capabilities'];
  const capabilities: AiCapabilities = {
    reasoning: false,
    structuredOutput: false,
    recipeGeneration: false,
    webSearch: false,
  };
  if (typeof capsRaw === 'object' && capsRaw !== null) {
    const caps = capsRaw as Record<string, unknown>;
    for (const key of TEXT_CAPABILITY_KEYS) {
      capabilities[key] = caps[key as string] === true;
    }
  }
  const model: ProviderCatalogTextModelView = { id: row['id'], default: row['default'], capabilities };
  if (typeof row['displayName'] === 'string' && row['displayName'].length > 0) {
    model.displayName = row['displayName'];
  }
  if (isFiniteNumber(row['contextLength'])) model.contextLength = row['contextLength'];
  const pricing = normalizePricing(row['pricing']);
  if (pricing) model.pricing = pricing;
  if (typeof row['isFree'] === 'boolean') model.isFree = row['isFree'];
  if (typeof row['pricingVerified'] === 'boolean') model.pricingVerified = row['pricingVerified'];
  if (typeof row['structuredVerified'] === 'boolean') model.structuredVerified = row['structuredVerified'];
  if (typeof row['capabilityVerified'] === 'boolean') model.capabilityVerified = row['capabilityVerified'];
  if (typeof row['strictStructuredCandidate'] === 'boolean') model.strictStructuredCandidate = row['strictStructuredCandidate'];
  if (typeof row['jsonCandidate'] === 'boolean') model.jsonCandidate = row['jsonCandidate'];
  if (isOpenRouterProfile(row['verifiedProfile'])) model.verifiedProfile = row['verifiedProfile'];
  if (typeof row['executionCompatible'] === 'boolean') model.executionCompatible = row['executionCompatible'];
  if (
    row['compatibility'] === 'compatible' ||
    row['compatibility'] === 'experimental' ||
    row['compatibility'] === 'unsupported'
  ) {
    model.compatibility = row['compatibility'];
  }
  if (typeof row['isRouter'] === 'boolean') model.isRouter = row['isRouter'];
  const costClass = normalizeCostClass(row['costClass']);
  if (costClass) model.costClass = costClass;
  const inputModalities = normalizeModalities(row['inputModalities']);
  if (inputModalities) model.inputModalities = inputModalities;
  const outputModalities = normalizeModalities(row['outputModalities']);
  if (outputModalities) model.outputModalities = outputModalities;
  if (typeof row['vision'] === 'boolean') model.vision = row['vision'];
  if (typeof row['largeContext'] === 'boolean') model.largeContext = row['largeContext'];
  return model;
}

/** Normalizes a text provider row, keeping ONLY allowlisted fields. */
function normalizeTextProvider(raw: unknown): ProviderCatalogTextProviderView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['providerId'] !== 'string' || typeof row['name'] !== 'string') return null;
  const storageScope = row['storageScope'] as SecretStorageScope;
  if (!KNOWN_STORAGE_SCOPES.includes(storageScope)) return null;
  const connectionTest = normalizeConnectionTestKind(row['connectionTest']);
  if (!connectionTest) return null;
  if (
    !isBoolean(row['configured']) ||
    !isBoolean(row['enabled']) ||
    !isBoolean(row['available']) ||
    !isBoolean(row['supportsSecretWrites']) ||
    !isBoolean(row['selectable'])
  ) {
    return null;
  }
  if (!Array.isArray(row['models'])) return null;
  const models: ProviderCatalogTextModelView[] = [];
  for (const item of row['models']) {
    const model = normalizeTextModel(item);
    if (model) models.push(model);
  }
  const discoveredModels: ProviderCatalogTextModelView[] = [];
  if (Array.isArray(row['discoveredModels'])) {
    for (const item of row['discoveredModels']) {
      const model = normalizeTextModel(item);
      if (model) discoveredModels.push(model);
    }
  }
  return {
    providerId: row['providerId'],
    name: row['name'],
    configured: row['configured'],
    enabled: row['enabled'],
    available: row['available'],
    storageScope,
    supportsSecretWrites: row['supportsSecretWrites'],
    connectionTest,
    selectable: row['selectable'],
    // Fail-closed: an absent/malformed server capability is NOT session-capable.
    sessionKeySupported: row['sessionKeySupported'] === true,
    models,
    ...(discoveredModels.length > 0 ? { discoveredModels } : {}),
  };
}

/** Normalizes an image provider row, keeping ONLY allowlisted fields + formats. */
function normalizeImageProvider(raw: unknown): ProviderCatalogImageProviderView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['providerId'] !== 'string' || typeof row['name'] !== 'string') return null;
  const connectionTest = normalizeConnectionTestKind(row['connectionTest']);
  if (!connectionTest) return null;
  if (
    !isBoolean(row['configured']) ||
    !isBoolean(row['enabled']) ||
    !isBoolean(row['available']) ||
    !isBoolean(row['imageGeneration']) ||
    !isBoolean(row['selectable'])
  ) {
    return null;
  }
  if (!isFiniteNumber(row['maxBytes'])) return null;
  const rawFormats = row['formats'];
  if (!Array.isArray(rawFormats)) return null;
  const formats: GeneratedImageMime[] = [];
  for (const format of rawFormats) {
    if (typeof format === 'string' && (GENERATED_IMAGE_MIME_ALLOWLIST as readonly string[]).includes(format)) {
      // Strictly typed: `format` is known to be an allowlisted mime member.
      formats.push(format as GeneratedImageMime);
    }
  }
  // Fail-closed: an image provider declaring NO known formats is untrustworthy.
  if (formats.length === 0) return null;
  if (!Array.isArray(row['models'])) return null;
  const models: ProviderCatalogImageModelView[] = [];
  for (const item of row['models']) {
    if (typeof item !== 'object' || item === null) continue;
    const model = item as Record<string, unknown>;
    if (typeof model['id'] === 'string' && model['id'].length > 0 && isBoolean(model['default'])) {
      const view: ProviderCatalogImageModelView = { id: model['id'], default: model['default'] };
      if (typeof model['displayName'] === 'string' && model['displayName'].length > 0) {
        view.displayName = model['displayName'];
      }
      const pricing = normalizePricing(model['pricing']);
      if (pricing) view.pricing = pricing;
      if (typeof model['isFree'] === 'boolean') view.isFree = model['isFree'];
      if (typeof model['pricingVerified'] === 'boolean') view.pricingVerified = model['pricingVerified'];
      if (
        model['compatibility'] === 'compatible' ||
        model['compatibility'] === 'experimental' ||
        model['compatibility'] === 'unsupported'
      ) {
        view.compatibility = model['compatibility'];
      }
      const costClass = normalizeCostClass(model['costClass']);
      if (costClass) view.costClass = costClass;
      models.push(view);
    }
  }
  return {
    providerId: row['providerId'],
    name: row['name'],
    configured: row['configured'],
    enabled: row['enabled'],
    available: row['available'],
    connectionTest,
    selectable: row['selectable'],
    // Fail-closed: an absent/malformed server capability is NOT session-capable.
    sessionKeySupported: row['sessionKeySupported'] === true,
    imageGeneration: row['imageGeneration'],
    formats,
    maxBytes: row['maxBytes'],
    models,
  };
}

/**
 * Validates + normalizes the whole `/api/providers/catalog` payload. Throws when
 * the payload is fundamentally malformed or contains NO valid provider, so the UI
 * can render a bounded "catalog unavailable" state instead of fabricating rows.
 */
export function normalizeProviderCatalog(payload: unknown): ProviderCatalogView {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Provider catalog response was not an object.');
  }
  const catalog = (payload as ProviderCatalogResponse).catalog;
  if (typeof catalog !== 'object' || catalog === null) {
    throw new Error('Provider catalog response did not include a catalog object.');
  }
  const catalogRow = catalog as Record<string, unknown>;
  const rawText = catalogRow['textProviders'];
  const rawImage = catalogRow['imageProviders'];
  if (!Array.isArray(rawText) || !Array.isArray(rawImage)) {
    throw new Error('Provider catalog response was missing provider arrays.');
  }
  const selectionRow = catalogRow['selection'];
  if (typeof selectionRow !== 'object' || selectionRow === null || Array.isArray(selectionRow)) {
    throw new Error('Provider catalog response was missing selection truth.');
  }
  const selectionBlock = selectionRow as Record<string, unknown>;
  const text = normalizeSelection(selectionBlock['text']);
  const image = normalizeSelection(selectionBlock['image']);
  if (!text || !image) {
    throw new Error('Provider catalog response was missing selection truth.');
  }
  // Fail-closed: unless the server EXPLICITLY confirms user selection is
  // allowed for a surface (no valid server-managed pin), the UI must NOT offer
  // selection overrides.
  const allowedBlock =
    typeof selectionBlock['userSelectionAllowed'] === 'object' && selectionBlock['userSelectionAllowed'] !== null
      ? (selectionBlock['userSelectionAllowed'] as Record<string, unknown>)
      : {};
  const userSelectionAllowed = {
    text: allowedBlock['text'] === true,
    image: allowedBlock['image'] === true,
  };
  // Runtime executability (fail-closed: absent/malformed -> false).
  const executableBlock =
    typeof selectionBlock['executable'] === 'object' && selectionBlock['executable'] !== null
      ? (selectionBlock['executable'] as Record<string, unknown>)
      : {};
  const executable = {
    text: executableBlock['text'] === true,
    image: executableBlock['image'] === true,
  };
  const textProviders: ProviderCatalogTextProviderView[] = [];
  for (const item of rawText) {
    const row = normalizeTextProvider(item);
    if (row) textProviders.push(row);
  }
  const imageProviders: ProviderCatalogImageProviderView[] = [];
  for (const item of rawImage) {
    const row = normalizeImageProvider(item);
    if (row) imageProviders.push(row);
  }
  if (textProviders.length === 0 && imageProviders.length === 0) {
    throw new Error('Provider catalog response contained no valid providers.');
  }
  // Deployment capability: fail closed (false) unless the server explicitly says true.
  const sessionByokSupported = catalogRow['sessionByokSupported'] === true;
  const dynamicCatalog = normalizeDynamicCatalog(catalogRow['dynamicCatalog']);
  return {
    textProviders,
    imageProviders,
    selection: { text, image, userSelectionAllowed, executable },
    sessionByokSupported,
    ...(dynamicCatalog ? { dynamicCatalog } : {}),
  };
}

/** Normalizes the optional non-secret dynamic-catalog observability block. */
function normalizeDynamicCatalog(raw: unknown): ProviderCatalogView['dynamicCatalog'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  const source =
    row['source'] === 'live' || row['source'] === 'cached' || row['source'] === 'curated_fallback'
      ? row['source']
      : undefined;
  if (!source) return undefined;
  const count = (v: unknown): number => (isFiniteNumber(v) ? Math.floor(v) : 0);
  return {
    source,
    fetchedAt: isFiniteNumber(row['fetchedAt']) ? row['fetchedAt'] : 0,
    pricingFresh: row['pricingFresh'] === true,
    textModelCount: count(row['textModelCount']),
    freeTextModelCount: count(row['freeTextModelCount']),
    verifiedFreeTextCount: count(row['verifiedFreeTextCount']),
    selectableTextCount: count(row['selectableTextCount']),
    imageModelCount: count(row['imageModelCount']),
    freeImageModelCount: count(row['freeImageModelCount']),
    selectableImageCount: count(row['selectableImageCount']),
    freeRouterVerified: row['freeRouterVerified'] === true,
  };
}

/**
 * Fetches the provider + model catalog through the application `NetworkAdapter`
 * (no direct fetch, no arbitrary URL). Throws on a non-2xx response or malformed
 * payload so the UI renders a bounded state instead of fabricating catalog data.
 */
export async function fetchProviderCatalog(network: NetworkAdapter): Promise<ProviderCatalogView> {
  const res: NetworkResponse<ProviderCatalogResponse> = await network.get<ProviderCatalogResponse>(
    PROVIDER_CATALOG_API_PATH
  );
  if (!res.ok) {
    throw new Error(`Provider catalog request failed (HTTP ${res.status}).`);
  }
  if (res.data === undefined) {
    throw new Error('Provider catalog request returned no data.');
  }
  return normalizeProviderCatalog(res.data);
}
