import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ModelPicker } from '../../src/application-ui/ModelPicker.js';
import {
  freeVerificationLabel,
  modelBadges,
  type SurfaceModelOption,
} from '../../src/application-ui/modelPicker.js';

/**
 * v0.8.x — capability-verification UI states. Rendering the picker must NEVER
 * trigger verification; the control is explicit and click-only.
 */

const FREE_DISCOVERED: SurfaceModelOption = {
  id: 'dynamic/free',
  default: false,
  isFree: true,
  pricingVerified: true,
  costClass: 'free',
  compatibility: 'experimental',
};

const PAID_DISCOVERED: SurfaceModelOption = {
  id: 'dynamic/paid',
  default: false,
  isFree: false,
  pricingVerified: true,
  costClass: 'paid',
  compatibility: 'experimental',
};

describe('freeVerificationLabel', () => {
  it('renders the four concise FREE verification states', () => {
    expect(freeVerificationLabel(FREE_DISCOVERED, undefined)).toBe('FREE · Not verified');
    expect(freeVerificationLabel(FREE_DISCOVERED, { state: 'verifying' })).toBe('FREE · Verifying…');
    expect(freeVerificationLabel(FREE_DISCOVERED, { state: 'verified' })).toBe('FREE · Verified');
    expect(freeVerificationLabel(FREE_DISCOVERED, { state: 'failed' })).toBe('FREE · Verification failed');
  });
});

describe('modelBadges', () => {
  it('surfaces a Verified badge only for capability-verified models', () => {
    expect(modelBadges(FREE_DISCOVERED)).not.toContain('Verified');
    expect(modelBadges({ ...FREE_DISCOVERED, capabilityVerified: true })).toContain('Verified');
  });
});

describe('ModelPicker verification controls', () => {
  it('never invokes verification during render, and shows an explicit Verify control for FREE discovered text models', () => {
    const onVerifyModel = vi.fn();
    const html = renderToString(
      <ModelPicker
        kind="text"
        models={[]}
        discoveredModels={[FREE_DISCOVERED]}
        onChange={() => {}}
        defaultOpen
        onVerifyModel={onVerifyModel}
      />
    );
    expect(onVerifyModel).not.toHaveBeenCalled();
    expect(html).toContain('FREE · Not verified');
    expect(html).toContain('Verify for Kitchen Codex');
    expect(html).toContain('data-model-verify="dynamic/free"');
  });

  it('does not offer verification for a non-free discovered model', () => {
    const html = renderToString(
      <ModelPicker
        kind="text"
        models={[]}
        discoveredModels={[PAID_DISCOVERED]}
        onChange={() => {}}
        defaultOpen
        onVerifyModel={() => {}}
      />
    );
    expect(html).not.toContain('Verify for Kitchen Codex');
    expect(html).not.toContain('data-model-verify="dynamic/paid"');
  });

  it('reflects an in-progress verification without auto-running it', () => {
    const onVerifyModel = vi.fn();
    const html = renderToString(
      <ModelPicker
        kind="text"
        models={[]}
        discoveredModels={[FREE_DISCOVERED]}
        onChange={() => {}}
        defaultOpen
        onVerifyModel={onVerifyModel}
        verifications={{ 'dynamic/free': { state: 'verifying' } }}
      />
    );
    expect(onVerifyModel).not.toHaveBeenCalled();
    expect(html).toContain('FREE · Verifying…');
  });
});
