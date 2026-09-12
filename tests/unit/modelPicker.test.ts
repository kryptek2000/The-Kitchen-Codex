import { describe, it, expect } from 'vitest';
import {
  countFreeModels,
  formatImageModelPrice,
  formatModelPrice,
  formatPerMillion,
  groupModels,
  modelBadges,
  modelCostClass,
  pickerModels,
  searchModels,
  sortModelsFreeFirst,
  type SurfaceModelOption,
} from '../../src/application-ui/modelPicker.js';

const FREE: SurfaceModelOption = {
  id: 'vendor/free-model:free',
  default: false,
  displayName: 'Vendor Free',
  isFree: true,
  costClass: 'free',
  capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: false, webSearch: false },
  pricing: { promptPerToken: 0, completionPerToken: 0, imageOutputPerToken: null, variable: false },
};

const BUDGET: SurfaceModelOption = {
  id: 'vendor/cheap-model',
  default: false,
  displayName: 'Vendor Cheap',
  costClass: 'budget',
  capabilities: { reasoning: false, structuredOutput: true, recipeGeneration: false, webSearch: false },
  pricing: { promptPerToken: 0.0000001, completionPerToken: 0.0000004, imageOutputPerToken: null, variable: false },
};

const PAID: SurfaceModelOption = {
  id: 'vendor/premium-model',
  default: true,
  displayName: 'Vendor Premium',
  costClass: 'paid',
  capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
  vision: true,
  largeContext: true,
  contextLength: 200000,
  pricing: { promptPerToken: 0.00001, completionPerToken: 0.00003, imageOutputPerToken: null, variable: false },
};

const VARIABLE: SurfaceModelOption = {
  id: 'openrouter/auto',
  default: false,
  displayName: 'Auto Router',
  isRouter: true,
  costClass: 'variable',
  pricing: { promptPerToken: null, completionPerToken: null, imageOutputPerToken: null, variable: true },
};

const IMAGE: SurfaceModelOption = {
  id: 'google/gemini-3-pro-image',
  default: true,
  displayName: 'Nano Banana Pro',
  costClass: 'paid',
  pricing: { promptPerToken: 0.000002, completionPerToken: 0.000012, imageOutputPerToken: 0.00012, variable: false },
};

const ALL = [PAID, FREE, VARIABLE, BUDGET];

describe('modelPicker — cost classification and pricing display', () => {
  it('classifies free / budget / paid / variable from normalized pricing', () => {
    expect(modelCostClass(FREE)).toBe('free');
    expect(modelCostClass(BUDGET)).toBe('budget');
    expect(modelCostClass(PAID)).toBe('paid');
    expect(modelCostClass(VARIABLE)).toBe('variable');
  });

  it('never infers free from a name: zero pricing is required', () => {
    const namedFreeButPaid: SurfaceModelOption = {
      id: 'vendor/free-token-model',
      displayName: 'Totally Free',
      default: false,
      isFree: false,
      pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imageOutputPerToken: null, variable: false },
    };
    expect(modelCostClass(namedFreeButPaid)).not.toBe('free');
    expect(formatModelPrice(namedFreeButPaid)).not.toBe('FREE');
  });

  it('converts per-token prices to per-million without multiplying incorrectly', () => {
    expect(formatPerMillion(0.00000015)).toBe('$0.150');
    expect(formatPerMillion(0.0000004)).toBe('$0.400');
    expect(formatPerMillion(0.00001)).toBe('$10.00');
    expect(formatPerMillion(0)).toBe('$0');
    expect(formatPerMillion(null)).toBe('—');
  });

  it('formats text prices as in/out per million and never promises an exact image price', () => {
    expect(formatModelPrice(BUDGET)).toBe('$0.100/M in · $0.400/M out');
    expect(formatModelPrice(FREE)).toBe('FREE');
    expect(formatModelPrice(VARIABLE)).toBe('Variable pricing');
    // Image pricing uses the image-output unit, not a fake universal $/image.
    expect(formatImageModelPrice(IMAGE)).toBe('$120/M output');
    const variableImage: SurfaceModelOption = {
      ...IMAGE,
      pricing: { ...IMAGE.pricing!, imageOutputPerToken: null },
    };
    expect(formatImageModelPrice(variableImage)).toBe('Variable pricing');
  });

  it('emits only catalog-proven badges', () => {
    expect(modelBadges(FREE)).toContain('FREE');
    // Structured Output is only claimed when the server VERIFIED it.
    expect(modelBadges(FREE)).not.toContain('Structured Output');
    expect(modelBadges(PAID)).toEqual(['Reasoning', 'Vision', 'Large Context']);
    expect(modelBadges(VARIABLE)).toEqual([]);
    // Unverified pricing is surfaced, and a free label is never shown.
    const unverifiedFree: SurfaceModelOption = { ...FREE, pricingVerified: false };
    expect(modelBadges(unverifiedFree)).toContain('Pricing unverified');
    expect(modelBadges(unverifiedFree)).not.toContain('FREE');
    expect(modelCostClass(unverifiedFree)).toBe('variable');
    const verified: SurfaceModelOption = { ...FREE, structuredVerified: true };
    expect(modelBadges(verified)).toContain('Structured Output');
  });
});

describe('modelPicker — free-first ordering, grouping, and search', () => {
  it('sorts FREE first, then BUDGET, then PAID, then variable', () => {
    expect(sortModelsFreeFirst(ALL).map((m) => m.id)).toEqual([
      FREE.id,
      BUDGET.id,
      PAID.id,
      VARIABLE.id,
    ]);
  });

  it('groups by free / budget / all', () => {
    expect(groupModels(ALL, 'free').map((m) => m.id)).toEqual([FREE.id]);
    expect(groupModels(ALL, 'budget').map((m) => m.id)).toEqual([BUDGET.id]);
    expect(groupModels(ALL, 'all')).toHaveLength(4);
  });

  it('searches case-insensitively by display name and model id', () => {
    expect(searchModels(ALL, 'VENDOR PREMIUM').map((m) => m.id)).toEqual([PAID.id]);
    expect(searchModels(ALL, 'premium-model').map((m) => m.id)).toEqual([PAID.id]);
    expect(searchModels(ALL, '').length).toBe(4);
  });

  it('the full pipeline is free-first and searchable', () => {
    expect(pickerModels(ALL, { group: 'all' }).map((m) => m.id)).toEqual([
      FREE.id,
      BUDGET.id,
      PAID.id,
      VARIABLE.id,
    ]);
    expect(pickerModels(ALL, { group: 'free', query: 'vendor' }).map((m) => m.id)).toEqual([FREE.id]);
    expect(countFreeModels(ALL)).toBe(1);
    expect(countFreeModels([PAID, VARIABLE])).toBe(0);
  });
});
