import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ModelPicker } from '../../src/application-ui/ModelPicker.js';
import {
  freeVerificationLabel,
  groupModels,
  modelBadges,
  probeFailureMessage,
  PROBE_FAILURE_CLASSIFICATIONS,
  PROBE_FAILURE_FALLBACK_MESSAGE,
  type ProbeFailureClassification,
  type SurfaceModelOption,
} from '../../src/application-ui/modelPicker.js';

/**
 * v0.8.x — capability-verification UI states. Rendering the picker must NEVER
 * trigger verification; the control is explicit, click-only, and offered ONLY for
 * server-marked strict-structured candidates. Failure copy is rendered from the
 * bounded classification union, never from raw text.
 */

/** A FREE discovered model the server marks as a strict-structured candidate. */
const FREE_CANDIDATE: SurfaceModelOption = {
  id: 'dynamic/candidate',
  default: false,
  isFree: true,
  pricingVerified: true,
  costClass: 'free',
  compatibility: 'experimental',
  strictStructuredCandidate: true,
};

/** A FREE discovered model WITHOUT strict structured-output metadata. */
const FREE_INCOMPATIBLE: SurfaceModelOption = {
  id: 'dynamic/incompatible',
  default: false,
  isFree: true,
  pricingVerified: true,
  costClass: 'free',
  compatibility: 'unsupported',
  strictStructuredCandidate: false,
};

const PAID_DISCOVERED: SurfaceModelOption = {
  id: 'dynamic/paid',
  default: false,
  isFree: false,
  pricingVerified: true,
  costClass: 'paid',
  compatibility: 'experimental',
  strictStructuredCandidate: false,
};

describe('freeVerificationLabel', () => {
  it('renders the four concise FREE verification states', () => {
    expect(freeVerificationLabel(FREE_CANDIDATE, undefined)).toBe('FREE · Not verified');
    expect(freeVerificationLabel(FREE_CANDIDATE, { state: 'verifying' })).toBe('FREE · Verifying…');
    expect(freeVerificationLabel(FREE_CANDIDATE, { state: 'verified' })).toBe('FREE · Verified');
    expect(freeVerificationLabel(FREE_CANDIDATE, { state: 'failed' })).toBe('FREE · Verification failed');
  });
});

describe('modelBadges', () => {
  it('surfaces a Verified badge only for capability-verified models', () => {
    expect(modelBadges(FREE_CANDIDATE)).not.toContain('Verified');
    expect(modelBadges({ ...FREE_CANDIDATE, capabilityVerified: true })).toContain('Verified');
  });
});

describe('probeFailureMessage', () => {
  it('maps every bounded classification to a distinct, non-empty safe message', () => {
    const seen = new Set<string>();
    for (const classification of PROBE_FAILURE_CLASSIFICATIONS) {
      const message = probeFailureMessage(classification);
      expect(message.length).toBeGreaterThan(0);
      expect(seen.has(message)).toBe(false);
      seen.add(message);
    }
  });

  it('falls back to a generic bounded message for absent/unknown classifications', () => {
    expect(probeFailureMessage(undefined)).toBe(PROBE_FAILURE_FALLBACK_MESSAGE);
    expect(probeFailureMessage('RAW_PROVIDER_TEXT')).toBe(PROBE_FAILURE_FALLBACK_MESSAGE);
    expect(probeFailureMessage('sk-or-v1-SECRET')).toBe(PROBE_FAILURE_FALLBACK_MESSAGE);
  });
});

describe('ModelPicker verification controls', () => {
  it('offers JSON-only candidates one explicitly labelled probe, never auto-runs, and labels verified profiles honestly', () => {
    const onVerifyModel = vi.fn();
    const html = renderToString(<ModelPicker kind="text" models={[]}
      discoveredModels={[{ ...FREE_INCOMPATIBLE, jsonCandidate: true }]}
      onChange={() => {}} defaultOpen onVerifyModel={onVerifyModel} />);
    expect(html).toContain('data-model-verify-json="dynamic/incompatible"');
    expect(html).not.toContain('data-model-verify="dynamic/incompatible"');
    expect(html).toContain('Verify application-validated JSON');
    expect(html).toContain('One free probe.');
    expect(html).toContain('No provider schema-enforcement claim.');
    expect(onVerifyModel).not.toHaveBeenCalled();
    expect(modelBadges({ ...FREE_CANDIDATE, capabilityVerified: true, verifiedProfile: 'application_validated_json_v1' }))
      .toContain('Application-validated JSON');
    expect(modelBadges({ ...FREE_CANDIDATE, capabilityVerified: true, verifiedProfile: 'strict_json_schema_v1' }))
      .toContain('Strict schema request · application checked');
  });
  it('never invokes verification during render, and shows an explicit Verify control only for eligible candidates', () => {
    const onVerifyModel = vi.fn();
    const html = renderToString(
      <ModelPicker
        kind="text"
        models={[]}
        discoveredModels={[FREE_CANDIDATE]}
        onChange={() => {}}
        defaultOpen
        onVerifyModel={onVerifyModel}
      />
    );
    expect(onVerifyModel).not.toHaveBeenCalled();
    expect(html).toContain('FREE · Not verified');
    expect(html).toContain('Verify for Kitchen Codex');
    expect(html).toContain('data-model-verify="dynamic/candidate"');
  });

  it('does not offer verification for an incompatible FREE model and explains why', () => {
    const onVerifyModel = vi.fn();
    const html = renderToString(
      <ModelPicker
        kind="text"
        models={[]}
        discoveredModels={[FREE_INCOMPATIBLE]}
        onChange={() => {}}
        defaultOpen
        onVerifyModel={onVerifyModel}
      />
    );
    expect(onVerifyModel).not.toHaveBeenCalled();
    expect(html).not.toContain('Verify for Kitchen Codex');
    expect(html).not.toContain('data-model-verify="dynamic/incompatible"');
    expect(html).toContain('data-model-incompatible="dynamic/incompatible"');
    expect(html).toContain('Strict structured output is unsupported by this model.');
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
        discoveredModels={[FREE_CANDIDATE]}
        onChange={() => {}}
        defaultOpen
        onVerifyModel={onVerifyModel}
        verifications={{ 'dynamic/candidate': { state: 'verifying' } }}
      />
    );
    expect(onVerifyModel).not.toHaveBeenCalled();
    expect(html).toContain('FREE · Verifying…');
  });

  it('renders the bounded classification message and never raw server/provider text', () => {
    const classifications = PROBE_FAILURE_CLASSIFICATIONS;
    for (const classification of classifications as readonly ProbeFailureClassification[]) {
      const html = renderToString(
        <ModelPicker
          kind="text"
          models={[]}
          discoveredModels={[FREE_CANDIDATE]}
          onChange={() => {}}
          defaultOpen
          onVerifyModel={() => {}}
          verifications={{
            'dynamic/candidate': {
              state: 'failed',
              classification,
              // A raw string is present but MUST NOT be rendered when a
              // classification is supplied.
              message: 'RAW_PROVIDER_BODY sk-or-v1-LEAK_SENTINEL',
            },
          }}
        />
      );
      expect(html).toContain(probeFailureMessage(classification));
      expect(html).not.toContain('RAW_PROVIDER_BODY');
      expect(html).not.toContain('sk-or-v1-LEAK_SENTINEL');
    }
  });
});

describe('verified models move into the selectable Free group', () => {
  it('a selectable FREE model is grouped as free (server moves it out of discovered)', () => {
    const selectable: SurfaceModelOption = {
      id: 'dynamic/candidate',
      default: false,
      isFree: true,
      pricingVerified: true,
      costClass: 'free',
      capabilityVerified: true,
      executionCompatible: true,
      compatibility: 'compatible',
      strictStructuredCandidate: true,
    };
    expect(groupModels([selectable], 'free').map((m) => m.id)).toContain('dynamic/candidate');
    expect(modelBadges(selectable)).toContain('Verified');
  });
});
