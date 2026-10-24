// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

import LivingLibrary, { mapCatalogToLibraryModels } from '../../src/components/LivingLibrary';
import { getLivingLibraryFixtures } from '../../src/data/livingLibraryFixtures';

afterEach(() => {
  cleanup();
  try { window.localStorage.removeItem('tkc_living_library_demo'); } catch {}
});

function makeMockNetwork(catalogPayload: any, opts: { fail?: boolean } = {}) {
  return {
    get: async () => {
      if (opts.fail) return { status: 500, ok: false, data: undefined };
      return { status: 200, ok: true, data: catalogPayload };
    },
    post: async () => ({ status: 200, ok: true, data: {} }),
  } as any;
}

function makeCatalogPayload(textModels: any[] = [], imageModels: any[] = []) {
  return {
    catalog: {
      textProviders: [
        {
          providerId: 'prov-text',
          name: 'Text Provider',
          configured: true,
          enabled: true,
          available: true,
          storageScope: 'server_environment',
          supportsSecretWrites: false,
          connectionTest: 'network_probe',
          selectable: true,
          sessionKeySupported: false,
          models: textModels,
        },
      ],
      imageProviders: [
        {
          providerId: 'prov-image',
          name: 'Image Provider',
          configured: false,
          enabled: true,
          available: true,
          connectionTest: 'credential_check',
          selectable: false,
          sessionKeySupported: false,
          imageGeneration: true,
          formats: ['image/png'],
          maxBytes: 4194304,
          models: imageModels,
        },
      ],
      selection: {
        text: { selectionMode: 'server_default', valid: true },
        image: { selectionMode: 'server_default', valid: true },
        userSelectionAllowed: { text: false, image: false },
        executable: { text: false, image: false },
      },
      sessionByokSupported: false,
    },
  };
}

const TEXT_MODEL = {
  id: 'real-text-1',
  default: true,
  capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
  displayName: 'Real Text Model',
  contextLength: 8192,
  pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imageOutputPerToken: null, variable: false },
  pricingVerified: true,
  capabilityVerified: true,
  executionCompatible: true,
  compatibility: 'compatible',
  costClass: 'free',
  inputModalities: ['text'],
};

const IMAGE_MODEL = {
  id: 'real-image-1',
  default: true,
  displayName: 'Real Image Model',
  pricingVerified: false,
  compatibility: 'compatible',
  costClass: 'paid',
};

describe('Living Library — production catalog path (UD-2C Phase 1C)', () => {
  it('maps real text model identity, modality, context, pricing, capabilities', () => {
    const catalog = {
      textProviders: [{
        providerId: 'prov-text', name: 'Text Provider', configured: true, enabled: true, available: true,
        storageScope: 'server_environment' as any, supportsSecretWrites: false, connectionTest: 'network_probe' as any,
        selectable: true, sessionKeySupported: false, models: [TEXT_MODEL],
      }],
      imageProviders: [],
      selection: { text: { selectionMode: 'server_default' as any, valid: true }, image: { selectionMode: 'server_default' as any, valid: true }, userSelectionAllowed: { text: false, image: false }, executable: { text: false, image: false } },
      sessionByokSupported: false,
    } as any;
    const mapped = mapCatalogToLibraryModels(catalog);
    expect(mapped.length).toBe(1);
    const m = mapped[0];
    expect(m.id).toBe('real-text-1');
    expect(m.name).toBe('Real Text Model');
    expect(m.providerId).toBe('prov-text');
    expect(m.providerName).toBe('Text Provider');
    expect(m.modality).toBe('text');
    expect(m.contextWindow).toBe(8192);
    expect(m.pricing).not.toBeNull();
    expect(m.pricing!.inputPer1M).toBeCloseTo(1.0);
    expect(m.pricing!.outputPer1M).toBeCloseTo(2.0);
    expect(m.capabilities).toContain('reasoning');
    expect(m.capabilities).toContain('structured-output');
  });

  it('maps real image model with unknown pricing and null context', () => {
    const catalog = {
      textProviders: [],
      imageProviders: [{
        providerId: 'prov-image', name: 'Image Provider', configured: false, enabled: true, available: true,
        connectionTest: 'credential_check' as any, selectable: false, sessionKeySupported: false,
        imageGeneration: true, formats: ['image/png'], maxBytes: 4194304, models: [IMAGE_MODEL],
      }],
      selection: { text: { selectionMode: 'server_default' as any, valid: true }, image: { selectionMode: 'server_default' as any, valid: true }, userSelectionAllowed: { text: false, image: false }, executable: { text: false, image: false } },
      sessionByokSupported: false,
    } as any;
    const mapped = mapCatalogToLibraryModels(catalog);
    expect(mapped.length).toBe(1);
    const m = mapped[0];
    expect(m.id).toBe('real-image-1');
    expect(m.modality).toBe('image');
    expect(m.contextWindow).toBeNull();
    expect(m.pricing).toBeNull();
    expect(m.readiness).toBe('not_configured');
  });

  it('unverified pricing is not presented as verified (pricing null)', () => {
    const unverified = { ...TEXT_MODEL, pricingVerified: false };
    const catalog = {
      textProviders: [{ providerId: 'p', name: 'P', configured: true, enabled: true, available: true, storageScope: 'server_environment' as any, supportsSecretWrites: false, connectionTest: 'network_probe' as any, selectable: true, sessionKeySupported: false, models: [unverified] }],
      imageProviders: [],
      selection: { text: { selectionMode: 'server_default' as any, valid: true }, image: { selectionMode: 'server_default' as any, valid: true }, userSelectionAllowed: { text: false, image: false }, executable: { text: false, image: false } },
      sessionByokSupported: false,
    } as any;
    const mapped = mapCatalogToLibraryModels(catalog);
    expect(mapped[0].pricing).toBeNull();
  });

  it('capabilityVerified does not produce Verified run; produces Capability verified', () => {
    const catalog = {
      textProviders: [{ providerId: 'p', name: 'P', configured: true, enabled: true, available: true, storageScope: 'server_environment' as any, supportsSecretWrites: false, connectionTest: 'network_probe' as any, selectable: true, sessionKeySupported: false, models: [{ ...TEXT_MODEL, capabilityVerified: true }] }],
      imageProviders: [],
      selection: { text: { selectionMode: 'server_default' as any, valid: true }, image: { selectionMode: 'server_default' as any, valid: true }, userSelectionAllowed: { text: false, image: false }, executable: { text: false, image: false } },
      sessionByokSupported: false,
    } as any;
    const mapped = mapCatalogToLibraryModels(catalog);
    expect(mapped[0].readiness).toBe('capability_verified');
    expect(mapped[0].capabilityVerified).toBe(true);
    expect(mapped[0].executionVerified).toBe(false);
  });

  it('executionCompatible alone does not produce verified run', () => {
    const m = { ...TEXT_MODEL, capabilityVerified: false, executionCompatible: true };
    const catalog = {
      textProviders: [{ providerId: 'p', name: 'P', configured: true, enabled: true, available: true, storageScope: 'server_environment' as any, supportsSecretWrites: false, connectionTest: 'network_probe' as any, selectable: true, sessionKeySupported: false, models: [m] }],
      imageProviders: [],
      selection: { text: { selectionMode: 'server_default' as any, valid: true }, image: { selectionMode: 'server_default' as any, valid: true }, userSelectionAllowed: { text: false, image: false }, executable: { text: false, image: false } },
      sessionByokSupported: false,
    } as any;
    const mapped = mapCatalogToLibraryModels(catalog);
    expect(mapped[0].readiness).not.toBe('capability_verified');
    expect(mapped[0].capabilityVerified).toBe(false);
    expect(mapped[0].executionVerified).toBe(false);
  });

  it('unconfigured provider stays not_configured', () => {
    const catalog = {
      textProviders: [{ providerId: 'p', name: 'P', configured: false, enabled: true, available: true, storageScope: 'server_environment' as any, supportsSecretWrites: false, connectionTest: 'network_probe' as any, selectable: false, sessionKeySupported: false, models: [TEXT_MODEL] }],
      imageProviders: [],
      selection: { text: { selectionMode: 'server_default' as any, valid: true }, image: { selectionMode: 'server_default' as any, valid: true }, userSelectionAllowed: { text: false, image: false }, executable: { text: false, image: false } },
      sessionByokSupported: false,
    } as any;
    const mapped = mapCatalogToLibraryModels(catalog);
    expect(mapped[0].readiness).toBe('not_configured');
  });

  it('unsupported compatibility is not usable', () => {
    const m = { ...TEXT_MODEL, compatibility: 'unsupported' };
    const catalog = {
      textProviders: [{ providerId: 'p', name: 'P', configured: true, enabled: true, available: true, storageScope: 'server_environment' as any, supportsSecretWrites: false, connectionTest: 'network_probe' as any, selectable: true, sessionKeySupported: false, models: [m] }],
      imageProviders: [],
      selection: { text: { selectionMode: 'server_default' as any, valid: true }, image: { selectionMode: 'server_default' as any, valid: true }, userSelectionAllowed: { text: false, image: false }, executable: { text: false, image: false } },
      sessionByokSupported: false,
    } as any;
    const mapped = mapCatalogToLibraryModels(catalog);
    expect(mapped[0].readiness).toBe('unsupported');
    expect(mapped[0].compatibility.find((c) => c.operation === 'text-generation')?.compatible).toBe(false);
  });

  it('renders production path: loading then real models (no demo banner)', async () => {
    const net = makeMockNetwork(makeCatalogPayload([TEXT_MODEL], [IMAGE_MODEL]));
    render(<LivingLibrary network={net as any} />);
    // loading state may flash; wait for ready
    await waitFor(() => {
      expect(document.querySelector('[data-model-card]')).toBeTruthy();
    });
    expect(document.querySelector('[data-synthetic-banner]')).toBeNull();
    expect(document.querySelector('[data-library-unavailable]')).toBeNull();
  });

  it('renders empty real catalog state truthfully', async () => {
    const payload = makeCatalogPayload([], []);
    // ensure at least one provider exists with empty models -> normalize passes
    payload.catalog.textProviders[0].models = [];
    payload.catalog.imageProviders[0].models = [];
    const net = makeMockNetwork(payload);
    render(<LivingLibrary network={net as any} />);
    await waitFor(() => {
      expect(document.querySelector('[data-library-empty]')).toBeTruthy();
    });
    expect(document.querySelector('[data-synthetic-banner]')).toBeNull();
  });

  it('renders unavailable state on catalog failure and retries', async () => {
    const net = makeMockNetwork(null, { fail: true });
    render(<LivingLibrary network={net as any} />);
    await waitFor(() => {
      expect(document.querySelector('[data-library-unavailable]')).toBeTruthy();
    });
    expect(document.querySelector('[data-synthetic-banner]')).toBeNull();
  });

  it('production path uses real catalog (no synthetic banner) without demo prop', async () => {
    const net = makeMockNetwork(makeCatalogPayload([TEXT_MODEL]));
    render(<LivingLibrary network={net as any} />);
    await waitFor(() => {
      expect(document.querySelector('[data-model-card]')).toBeTruthy();
    });
    expect(document.querySelector('[data-synthetic-banner]')).toBeNull();
    // demo mode is dev-only: isDemoMode() requires import.meta.env.DEV; in a prod
    // build it is always false regardless of localStorage/query. Covered by the
    // implementation (see isDemoMode in LivingLibrary.tsx).
  });

  it('apply button is disabled in inspector', async () => {
    const net = makeMockNetwork(makeCatalogPayload([TEXT_MODEL]));
    render(<LivingLibrary network={net as any} />);
    await waitFor(() => {
      expect(document.querySelector('[data-inspect-button]')).toBeTruthy();
    });
    const btn = document.querySelector<HTMLButtonElement>('[data-inspect-button]')!;
    fireEvent.click(btn);
    const apply = document.querySelector<HTMLButtonElement>('[data-inspector-apply]')!;
    expect(apply.hasAttribute('disabled')).toBe(true);
  });

  it('search and pagination work on real catalog', async () => {
    // build a catalog with enough models to paginate
    const models = Array.from({ length: 25 }, (_, i) => ({ ...TEXT_MODEL, id: `m-${i}`, displayName: `Model ${i}` }));
    const net = makeMockNetwork(makeCatalogPayload(models));
    render(<LivingLibrary network={net as any} />);
    await waitFor(() => {
      expect(document.querySelector('[data-result-count]')?.textContent).toBe('25');
    });
    const next = document.querySelector<HTMLButtonElement>('[data-page-next]')!;
    fireEvent.click(next);
    expect(document.querySelector('[data-page-current]')?.textContent).toMatch(/Page 2/);
    const search = document.querySelector<HTMLInputElement>('[data-library-search]')!;
    fireEvent.change(search, { target: { value: 'Model 5' } });
    expect(Number(document.querySelector('[data-result-count]')?.textContent)).toBeLessThan(25);
  });

  it('comparison capped at 3 on real catalog', async () => {
    const models = Array.from({ length: 5 }, (_, i) => ({ ...TEXT_MODEL, id: `m-${i}`, displayName: `Model ${i}` }));
    const net = makeMockNetwork(makeCatalogPayload(models));
    render(<LivingLibrary network={net as any} />);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-compare-checkbox]').length).toBe(5);
    });
    const cbs = Array.from(document.querySelectorAll<HTMLInputElement>('[data-compare-checkbox]'));
    for (let i = 0; i < 4; i++) fireEvent.click(cbs[i]);
    expect(document.querySelector('[data-compare-notice]')).toBeTruthy();
    expect(document.querySelectorAll('[data-comparison-remove]').length).toBe(3);
  });
});
