/**
 * AI-3 FINAL RELEASE-GATE — DEDICATED PAYLOAD / PRIVACY GATE.
 *
 * The architect was explicit: do NOT assume "candidate evidence == model
 * transport payload". This gate traces the ACTUAL outbound serialization
 * (buildAiEstimateModelRequest) and asserts the exact permitted key set, then
 * asserts the absence of every prohibited authority/private field.
 */
import { describe, it, expect } from 'vitest';

import {
  buildAiEstimateModelRequest,
  canonicalizeAiEstimateRequestLine,
  MAX_AI_ESTIMATE_REQUEST_BYTES,
  MAX_AI_ESTIMATE_RESPONSE_BYTES,
  aiEstimateRequestByteLength,
} from '../../src/core/nutritionV2/aiAdvancedEstimateWire';
import { MAX_AI_ESTIMATE_LINES } from '../../src/core/nutritionV2/phase4/aiEstimateValidation';
import {
  MAX_AI_ESTIMATE_BOUND_GRAMS,
  AI_ESTIMATE_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/aiAdvancedEstimate';
import { MAX_AI_ESTIMATE_RANGE_RATIO } from '../../src/core/nutritionV2/aiEstimateBounds';

/** Every key the wire format is permitted to emit, per line. */
const ALLOWED_LINE_KEYS = [
  'line_ref',
  'source_text',
  'amount',
  'unit',
  'measurement_kind',
  'count_noun',
  'food_semantics',
  'local_food_description',
  'evidence_absent_reason',
];

/** Prohibited authority / private / secret fields. */
const PROHIBITED = [
  'fdc_id',
  'fdcId',
  'authenticated_fdc_id',
  'nutrient',
  'nutrients',
  'nutrient_values',
  'protein',
  'fat',
  'carbs',
  'portion',
  'authenticated_portion',
  'portion_g',
  'record_digest',
  'identity_digest',
  'snapshot_digest',
  'bundle_release',
  'usda_record',
  'full_record',
  'snapshot',
  'private',
  'user_id',
  'recipe_id',
  'api_key',
  'apikey',
  'secret',
  'token',
  'authorization',
  'vault',
  'cost',
  'tier',
];

/** A maximally hostile input line carrying every prohibited field. */
function hostileLine(): Record<string, unknown> {
  return {
    line_ref: 'ing:9:privacy',
    source_text: '1 can black beans',
    amount: 1,
    unit: 'can',
    measurement_kind: 'count',
    count_noun: 'can',
    food_semantics: 'black beans',
    local_food_description: 'Beans, black, mature, canned',
    evidence_absent_reason: 'no_authenticated_portion',
    // every prohibited field below must be STRIPPED
    fdc_id: 173686,
    fdcId: 173686,
    authenticated_fdc_id: 173686,
    nutrients: { protein: 8.86, fat: 0.4, carbs: 23.7 },
    nutrient_values: { protein: 8.86 },
    protein: 8.86,
    fat: 0.4,
    carbs: 23.7,
    portion: '1/2 cup',
    authenticated_portion: { fdc_id: 173686, grams: 86 },
    portion_g: 86,
    record_digest: 'a'.repeat(64),
    identity_digest: 'b'.repeat(64),
    snapshot_digest: 'c'.repeat(64),
    bundle_release: 'USDA_RELEASE_2024',
    usda_record: { fdc_id: 173686, nutrients: {} },
    full_record: { fdc_id: 173686 },
    snapshot: { record_digest: 'd'.repeat(64) },
    private_metadata: { user: 'sid' },
    user_id: 'user-1',
    recipe_id: 'recipe-1',
    // The two credential-shaped values below are DELIBERATE canaries: they
    // exist only to prove the canonicalizer strips such fields. They are not
    // real credentials and are named so no scanner can mistake them for one.
    api_key: 'CANARY_KEY_NOT_A_REAL_SECRET',
    secret: 'CANARY_SECRET_NOT_REAL',
    token: 'CANARY_BEARER_NOT_REAL',
    authorization: 'CANARY_BEARER_NOT_REAL',
    vault: 'private-vault',
    cost: 1,
    tier: 'pro',
  };
}

describe('AI-3 release gate — model transport payload / privacy', () => {
  it('envelope carries exactly contract_version, provenance_class, lines', () => {
    const req = buildAiEstimateModelRequest([hostileLine()]);
    expect(Object.keys(req).sort()).toEqual(
      ['contract_version', 'lines', 'provenance_class'],
    );
  });

  it('per-line payload carries EXACTLY the permitted key set, nothing more', () => {
    const req = buildAiEstimateModelRequest([hostileLine()]);
    expect(req.lines.length).toBe(1);
    const line = req.lines[0] as unknown as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual([...ALLOWED_LINE_KEYS].sort());
  });

  it('strips EVERY prohibited authority / private / secret field', () => {
    const req = buildAiEstimateModelRequest([hostileLine()]);
    const line = req.lines[0] as unknown as Record<string, unknown>;
    for (const key of PROHIBITED) {
      expect(line, `prohibited key present: ${key}`).not.toHaveProperty(key);
    }
  });

  it('the serialized bytes contain no prohibited key or secret value', () => {
    const req = buildAiEstimateModelRequest([hostileLine()]);
    const raw = JSON.stringify(req);
    for (const key of PROHIBITED) {
      expect(raw, `serialized payload leaked ${key}`).not.toContain(`"${key}"`);
    }
    expect(raw).not.toContain('CANARY_KEY_NOT_A_REAL_SECRET');
    expect(raw).not.toContain('CANARY_BEARER_NOT_REAL');
    expect(raw).not.toContain('173686');            // the fdc id value itself
    expect(raw).not.toContain('a'.repeat(64));      // the record digest value
    expect(raw).not.toContain('8.86');              // a nutrient value
  });

  it('the model is always told the NON-authenticated provenance class', () => {
    const req = buildAiEstimateModelRequest([hostileLine()]);
    expect(req.provenance_class).toBe(AI_ESTIMATE_PROVENANCE_CLASS);
    expect(req.provenance_class).not.toBe('usda_derived');
  });

  it('a raw unknown object never leaks: canonicalization is allowlist-built', () => {
    // Not one property is copied through; the object is rebuilt from scratch.
    const line = canonicalizeAiEstimateRequestLine(hostileLine());
    expect(line).toBeDefined();
    expect(Object.keys(line as object).sort()).toEqual([...ALLOWED_LINE_KEYS].sort());
  });

  it('an unusable evidence_absent_reason rejects the line entirely', () => {
    expect(
      canonicalizeAiEstimateRequestLine({ ...hostileLine(), evidence_absent_reason: 'whatever' }),
    ).toBeUndefined();
  });

  it('non-finite amounts are nulled, never forwarded', () => {
    const line = canonicalizeAiEstimateRequestLine({
      ...hostileLine(),
      amount: Number.NaN,
    });
    expect(line).toBeDefined();
    expect((line as { amount: number | null }).amount).toBeNull();
  });

  it('route limits hold on the built payload', () => {
    expect(MAX_AI_ESTIMATE_LINES).toBe(12);
    expect(MAX_AI_ESTIMATE_REQUEST_BYTES).toBe(32 * 1024);
    expect(MAX_AI_ESTIMATE_RESPONSE_BYTES).toBe(32 * 1024);
    expect(MAX_AI_ESTIMATE_BOUND_GRAMS).toBe(1_000_000);
    expect(MAX_AI_ESTIMATE_RANGE_RATIO).toBe(4);
  });

  it('a real 12-line payload stays inside the 32 KiB request bound', () => {
    const lines = Array.from({ length: MAX_AI_ESTIMATE_LINES }, (_, i) => ({
      ...hostileLine(),
      line_ref: `ing:${i}:privacy`,
      source_text: '1 (15 oz) can tomato sauce with a long authored preparation note',
      local_food_description: 'Sauce, tomato, canned, red, ripe, with salt added',
    }));
    const req = buildAiEstimateModelRequest(lines);
    expect(req.lines.length).toBe(MAX_AI_ESTIMATE_LINES);
    expect(aiEstimateRequestByteLength(req)).toBeLessThanOrEqual(MAX_AI_ESTIMATE_REQUEST_BYTES);
  });
});
