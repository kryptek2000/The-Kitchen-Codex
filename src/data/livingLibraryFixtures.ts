/**
 * The Kitchen Codex — Living Library (UD-2C) synthetic design fixtures.
 *
 * IMPORTANT: These are SYNTHETIC DESIGN FIXTURES used to exercise the Living
 * Library discovery UI at the approved 2,048-model scale. They are NOT real
 * providers, NOT real models, and NOT connected to any execution, billing or
 * credential flow. Nothing here is executable, and no provider call is ever
 * made from this data. The whole library is clearly labelled as synthetic in
 * the UI.
 *
 * Generation is deterministic (seeded PRNG) so the catalog, counts and
 * pagination are stable across reloads and tests.
 */

export type LibraryModality = 'text' | 'image' | 'multimodal' | 'embedding';
export type LibraryCategory = 'reasoning' | 'creative' | 'code' | 'vision' | 'embedding' | 'general';
export type LibraryReadiness = 'capability_verified' | 'catalog_only' | 'unsupported' | 'not_configured';

export interface LibraryPricing {
  inputPer1M: number;
  outputPer1M: number;
  unit: string;
}

export interface LibraryCompatibility {
  operation: string;
  compatible: boolean;
  reason?: string;
}

export interface LibraryModel {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  category: LibraryCategory;
  modality: LibraryModality;
  description: string;
  contextWindow: number | null;
  pricing: LibraryPricing | null;
  capabilities: string[];
  readiness: LibraryReadiness;
  capabilityVerified: boolean;
  executionVerified: boolean;
  compatibility: LibraryCompatibility[];
}

const PROVIDERS: { id: string; name: string }[] = [
  { id: 'synth-atlas', name: 'Atlas Synthetic' },
  { id: 'synth-aurora', name: 'Aurora Synthetic' },
  { id: 'synth-boreal', name: 'Boreal Synthetic' },
  { id: 'synth-cinder', name: 'Cinder Synthetic' },
  { id: 'synth-delta', name: 'Delta Synthetic' },
  { id: 'synth-ember', name: 'Ember Synthetic' },
  { id: 'synth-fjord', name: 'Fjord Synthetic' },
  { id: 'synth-grove', name: 'Grove Synthetic' },
  { id: 'synth-halo', name: 'Halo Synthetic' },
  { id: 'synth-iris', name: 'Iris Synthetic' },
  { id: 'synth-jade', name: 'Jade Synthetic' },
  { id: 'synth-kite', name: 'Kite Synthetic' },
];

const CATEGORIES: LibraryCategory[] = ['reasoning', 'creative', 'code', 'vision', 'embedding', 'general'];
const MODALITIES: LibraryModality[] = ['text', 'image', 'multimodal', 'embedding'];
const READINESS: LibraryReadiness[] = ['capability_verified', 'catalog_only', 'unsupported', 'not_configured'];
const CAPABILITY_POOL = [
  'structured-output',
  'reasoning',
  'tool-use',
  'vision-input',
  'image-generation',
  'embeddings',
  'long-context',
  'code-generation',
];
const OPERATIONS = ['text-generation', 'image-generation', 'embedding', 'vision-analysis'];
const CONTEXT_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072, 200000, null];
const PRICE_OPTIONS = [
  { input: 0.1, output: 0.2 },
  { input: 0.5, output: 1.0 },
  { input: 1.0, output: 2.0 },
  { input: 3.0, output: 6.0 },
  { input: 5.0, output: 10.0 },
  { input: 15.0, output: 30.0 },
];

// Seeded PRNG (mulberry32) for deterministic output.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function buildModel(i: number, rng: () => number): LibraryModel {
  const provider = pick(rng, PROVIDERS);
  const category = pick(rng, CATEGORIES);
  const modality = pick(rng, MODALITIES);
  const readiness = pick(rng, READINESS);
  const capabilityVerified = readiness === 'capability_verified';
  const contextWindow = pick(rng, CONTEXT_OPTIONS);
  const hasPricing = rng() > 0.35;
  const price = hasPricing ? pick(rng, PRICE_OPTIONS) : null;
  const pricing: LibraryPricing | null = price
    ? { inputPer1M: price.input, outputPer1M: price.output, unit: 'USD per 1M tokens' }
    : null;

  // capabilities subset
  const capCount = 1 + Math.floor(rng() * 4);
  const caps = new Set<string>();
  while (caps.size < capCount) caps.add(pick(rng, CAPABILITY_POOL));
  const capabilities = Array.from(caps);

  // compatibility per operation
  const compatibility: LibraryCompatibility[] = OPERATIONS.map((op) => {
    let compatible = false;
    let reason: string | undefined;
    if (readiness === 'unsupported') {
      compatible = false;
      reason = 'Unsupported by this deployment.';
    } else if (readiness === 'not_configured') {
      compatible = false;
      reason = 'Provider not configured.';
    } else if (op === 'image-generation' && modality !== 'image' && modality !== 'multimodal') {
      compatible = false;
      reason = 'Model does not support image generation.';
    } else if (op === 'embedding' && modality !== 'embedding' && !capabilities.includes('embeddings')) {
      compatible = false;
      reason = 'Model does not support embeddings.';
    } else if (op === 'vision-analysis' && !capabilities.includes('vision-input') && modality !== 'multimodal' && modality !== 'image') {
      compatible = false;
      reason = 'Model does not support vision input.';
    } else {
      compatible = true;
    }
    return { operation: op, compatible, reason };
  });

  const adj = ['Nova', 'Prime', 'Lite', 'Pro', 'Max', 'Core', 'Edge', 'Ultra', 'Mini', 'Flex'];
  const name = `${provider.name.split(' ')[0]} ${pick(rng, adj)} ${i + 1}`;
  const description = `Synthetic design fixture (${category}) — ${modality} model from ${provider.name}. ` +
    `Provided for Living Library discovery UI exercise only; not a real, executable model.`;

  return {
    id: `synth-${provider.id}-${i}`,
    name,
    providerId: provider.id,
    providerName: provider.name,
    category,
    modality,
    description,
    contextWindow,
    pricing,
    capabilities,
    readiness,
    capabilityVerified,
    executionVerified: false,
    compatibility,
  };
}

let cached: LibraryModel[] | null = null;

export function getLivingLibraryFixtures(): LibraryModel[] {
  if (cached) return cached;
  const rng = makeRng(0x5eed1234);
  const out: LibraryModel[] = [];
  for (let i = 0; i < 2048; i++) out.push(buildModel(i, rng));
  cached = out;
  return cached;
}

export const LIVING_LIBRARY_FIXTURE_COUNT = 2048;
export const LIVING_LIBRARY_PAGE_SIZE = 12;
export const LIVING_LIBRARY_IS_SYNTHETIC = true;
