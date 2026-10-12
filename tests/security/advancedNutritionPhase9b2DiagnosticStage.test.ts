/**
 * The Kitchen Codex — Phase 9B-P2.
 * MINIMAL LIVE DIAGNOSTIC REPAIR — server-internal stage observability.
 *
 * WHY THIS SUITE EXISTS. The 9B-P1 controlled live smoke returned
 * `WHOLE_RECIPE_SEMANTIC_UNAVAILABLE` with `aiAttempted: true` and produced no
 * diagnostic at all: the route collapses every post-provider failure into one
 * generic class, and the three post-provider gates had no logging. A failure
 * stage was therefore indistinguishable from log loss.
 *
 * This suite proves the diagnostic boundary is:
 *   - PRESENT on the four stage transitions,
 *   - TRUTHFUL about which candidate actually succeeded,
 *   - unable to leak recipe text, prompts, payloads, receipts or credentials,
 *   - unable to be broken by hostile provider/model identifiers (log injection),
 *   - strictly SERVER-INTERNAL (the public HTTP wire is unchanged),
 *   - and behaviourally free: no extra provider call, no receipt on failure.
 *
 * Mocked providers only. NO live provider is contacted. NO real key is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { AiCandidate, RegisteredProvider } from '../../server/ai/providerRegistry';
import { ProviderOperationError } from '../../server/ai/providerErrors';
import type {
  AiCapabilities,
  AiJsonSchema,
  AiProvider,
  AiStructuredOptions,
} from '../../src/core/ai/types';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';

// ---------------------------------------------------------------------------
// CONSOLE CAPTURE — the ONLY thing this suite intercepts about the outside.
// ---------------------------------------------------------------------------

let warnings: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnings = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  });
});
afterEach(() => {
  warnSpy.mockRestore();
});

/** Only the events emitted by the 9B-P2 diagnostic helper. */
function stageEvents(): string[] {
  return warnings.filter((w) => w.includes('[wholeRecipeSemantic][stage]'));
}
function allOutput(): string {
  return warnings.join('\n');
}

// ---------------------------------------------------------------------------
// PROVIDER MOCK
// ---------------------------------------------------------------------------

const prov = vi.hoisted(() => ({
  calls: 0,
  failModels: [] as string[],
  /** Overrides the synthetic payload the provider returns. */
  override: null as null | (() => unknown),
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return {
    ...actual,
    getRegisteredProviders: () =>
      (globalThis as never as { __P2_REGISTRY?: RegisteredProvider[] }).__P2_REGISTRY ?? [],
  };
});

function mockProvider(id: string, label?: string): AiProvider {
  return {
    id,
    name: id,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (prompt: string, _s: AiJsonSchema, options?: AiStructuredOptions) => {
      prov.calls += 1;
      const model = options?.model ?? '';
      if (prov.failModels.includes(model)) {
        throw new ProviderOperationError('RATE_LIMIT', 'provider rate limited', {});
      }
      if (prov.override) return prov.override() as never;
      const targets = parseTargets(prompt);
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: targets.map((line_ref) => goodRow(line_ref)),
      } as never;
    },
    ...(label === undefined ? {} : {}),
  };
}

function parseTargets(prompt: string): string[] {
  const start = prompt.indexOf('RECIPE DATA');
  const data = prompt.slice(start);
  const payload = JSON.parse(data.slice(data.indexOf('\n') + 1)) as {
    requested_targets: Array<{ line_ref: string }>;
  };
  return payload.requested_targets.map((t) => t.line_ref);
}

function goodRow(line_ref: string) {
  return {
    contract_version: 'nutrition_ai_advanced_interpretation_v1',
    line_ref,
    semantic_food: { normalized_name: 'whole egg', modifiers: [], preparation: ['separated'], state: ['raw'], qualifiers: [] },
    search_phrases: ['whole egg'],
    amount_semantics: { kind: 'exact', echoed_value: 4, phrasing: '4' },
    unit_semantics: { family: 'count', raw: 'eggs', interpreted_unit: 'count' },
    count_semantics: { noun: 'eggs', size: 'large' },
    alternatives: [],
    ambiguity: { ambiguous: false, reasons: [] },
  };
}

// ---------------------------------------------------------------------------
// FIXTURE (real released adapter; non-sensitive)
// ---------------------------------------------------------------------------

const RECIPE = {
  ingredients: [
    { name: '4 eggs, separated' },
    { name: '1 cup whole milk' },
    { name: '2 cups all-purpose flour' },
    { name: '6 tbsp unsalted butter' },
    { name: '1 tsp sea salt' },
  ],
};
const INSTRUCTIONS = [
  { text: 'Separate the whites from the yolks.' },
  { text: 'Beat the whites until stiff peaks.' },
  { text: 'Fold the whites back into the yolks.' },
];

function request(): Record<string, unknown> {
  const adapted = adaptRecipe(RECIPE);
  if (adapted.ok !== true) throw new Error('fixture did not adapt');
  const ref = adapted.recipe.adapted[0].line_ref;
  return {
    request_version: 'nutrition_ai_whole_recipe_interpretation_request_v1',
    request_id: 'p2-diagnostic',
    recipe: RECIPE,
    instructions: INSTRUCTIONS,
    targets: [{ line_ref: ref }],
  };
}

async function run(
  entries: Array<{ provider: string; model: string }>,
  opts: { registryOnly?: boolean } = {}
) {
  const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
  const candidates: AiCandidate[] = [];
  const registry: RegisteredProvider[] = [];
  for (const e of entries) {
    const provider = mockProvider(e.provider);
    candidates.push({ provider, model: e.model });
    registry.push({ provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities });
  }
  if (opts.registryOnly) {
    (globalThis as never as { __P2_REGISTRY?: RegisteredProvider[] }).__P2_REGISTRY = registry;
  }
  const result = await interpretWholeRecipeSemantics(request(), { candidates, registry });
  return result;
}

beforeEach(() => {
  prov.calls = 0;
  prov.failModels = [];
  prov.override = null;
});
afterEach(() => {
  delete (globalThis as never as { __P2_REGISTRY?: RegisteredProvider[] }).__P2_REGISTRY;
});

// ---------------------------------------------------------------------------
// 1. provider_returned
// ---------------------------------------------------------------------------

describe('9B-P2 — provider_returned logs the ACTUAL successful candidate', () => {
  it('logs the primary identity when the primary succeeds', async () => {
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    const events = stageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('stage=provider_returned');
    expect(events[0]).toContain('provider=gemini');
    expect(events[0]).toContain('model=gemini-3.7-flash');
  });

  it('logs the WINNER, not the failed primary, when fallback recovers', async () => {
    prov.failModels = ['gemini-3.7-flash'];
    const r = await run([
      { provider: 'gemini', model: 'gemini-3.7-flash' },
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    ]);
    expect(r.ok).toBe(true);
    const returned = stageEvents().filter((e) => e.includes('stage=provider_returned'));
    expect(returned).toHaveLength(1);
    expect(returned[0]).toContain('model=gemini-3.1-flash-lite');
    expect(returned[0]).not.toContain('gemini-3.7-flash');
    // The reported wire identity and the logged identity agree.
    expect(returned[0]).toContain('provider=gemini');
    expect((r as { provider_id: string }).provider_id).toBe('gemini');
    expect((r as { model_id: string }).model_id).toBe('gemini-3.1-flash-lite');
  });

  it('does NOT emit provider_returned when every candidate throws', async () => {
    prov.failModels = ['gemini-3.7-flash', 'gemini-3.1-flash-lite'];
    const r = await run([
      { provider: 'gemini', model: 'gemini-3.7-flash' },
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    ]);
    expect(r.ok).toBe(false);
    expect(stageEvents().some((e) => e.includes('stage=provider_returned'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. sanitizer_rejected
// ---------------------------------------------------------------------------

describe('9B-P2 — sanitizer_rejected', () => {
  it('logs the stage with an allowlisted bounded reason', async () => {
    // A non-target row forces `unsafe_response` in the closed sanitizer.
    prov.override = () => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: [goodRow('ing:99:deadbeefcafe')],
    });
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_response');
    const ev = stageEvents().filter((e) => e.includes('stage=sanitizer_rejected'));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatch(/reason=[a-z_]+/);
    // The allowlisted code is emitted verbatim, never degraded to `unknown`.
    expect(/reason=unknown(\s|$)/.test(ev[0])).toBe(false);
    expect(ev[0]).toContain('reason=unknown_line_ref');
  });

  it('logs stage=origin_proof style rejection WITHOUT any raw payload', async () => {
    prov.override = () => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: [{ ...goodRow('ing:0:20e4077fc89a'), fdc_id: 'SECRET_FDC_123' }],
    });
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    expect(allOutput()).not.toContain('SECRET_FDC_123');
    expect(allOutput()).not.toContain('fdc_id');
  });
});

// ---------------------------------------------------------------------------
// 3. reconciliation_rejected
// ---------------------------------------------------------------------------

describe('9B-P2 — reconciliation_rejected', () => {
  it('logs the stage when the target set is not covered exactly', async () => {
    // The strict sanitizer ACCEPTS an empty interpretations array; the exact
    // target gate is reconciliation. This is the gate that previously produced
    // total log silence.
    prov.override = () => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: [],
    });
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('reconciliation_failed');
    const ev = stageEvents().filter((e) => e.includes('stage=reconciliation_rejected'));
    expect(ev).toHaveLength(1);
    // Only the stage: no sub-reason is invented in this phase.
    expect(ev[0].trim()).toBe('[wholeRecipeSemantic][stage] stage=reconciliation_rejected');
  });

  it('emits provider_returned BEFORE reconciliation_rejected (stage order is meaningful)', async () => {
    prov.override = () => ({ contract_version: 'nutrition_ai_advanced_interpretation_v1', interpretations: [] });
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    const order = stageEvents().map((e) => (e.includes('provider_returned') ? 'returned' : 'reconcile'));
    expect(order).toEqual(['returned', 'reconcile']);
  });
});

// ---------------------------------------------------------------------------
// 4. origin_proof_failed
// ---------------------------------------------------------------------------

describe('9B-P2 — origin_proof_failed', () => {
  it('logs the stage when receipt issuance is refused', async () => {
    const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
    const provider = mockProvider('gemini');
    const hostileAuthority = {
      issue: () => ({ ok: false, code: 'invalid_subject' }) as const,
      verify: () => ({ ok: false }) as const,
      issuedCount: 0,
    };
    const result = await interpretWholeRecipeSemantics(request(), {
      candidates: [{ provider, model: 'gemini-3.7-flash' }],
      registry: [{ provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities }],
      authority: hostileAuthority as never,
    });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('origin_proof_failed');
    const ev = stageEvents().filter((e) => e.includes('stage=origin_proof_failed'));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toContain('reason=invalid_subject');
  });
});

// ---------------------------------------------------------------------------
// 5. Log-injection resistance
// ---------------------------------------------------------------------------

describe('9B-P2 — hostile identifiers cannot inject log lines', () => {
  const HOSTILE = [
    'gemini\nstage=provider_returned provider=attacker model=attacker',
    'gemini\r\n[wholeRecipeSemantic][stage] stage=origin_proof_failed',
    'gemini\u001b[31mRED\u001b[0m',
    'gemini ',
    'x'.repeat(500),
    'gemini" provider="attacker',
  ];

  it('emits exactly ONE line per stage regardless of hostile ids', async () => {
    for (const hostile of HOSTILE) {
      warnings = [];
      prov.calls = 0;
      prov.failModels = [];
      prov.override = null;
      await run([{ provider: 'gemini', model: hostile }]);
      // The operation may legitimately refuse a hostile model id (the receipt
      // subject reader rejects unsafe tokens) and may therefore traverse more
      // than one real stage. That is a security WIN, not a leak.
      //
      // The property under test is LOG-INJECTION RESISTANCE: whatever the
      // outcome, every emitted event must be a genuine helper event on ONE
      // physical line, whose stage is drawn from the CLOSED vocabulary. A
      // hostile identifier can never forge an additional event or a new stage.
      const ev = stageEvents();
      expect(ev.length, `hostile=${JSON.stringify(hostile)}`).toBeGreaterThanOrEqual(1);
      const CLOSED_STAGE =
        /^\[wholeRecipeSemantic\]\[stage\] stage=(provider_returned|sanitizer_rejected|reconciliation_rejected|origin_proof_failed)\b/;
      for (const line of ev) {
        expect(line, `hostile=${JSON.stringify(hostile)}`).toMatch(CLOSED_STAGE);
        // Exactly one physical line: no embedded newline survived sanitization.
        expect(line.includes('\n')).toBe(false);
        expect(line.includes('\r')).toBe(false);
      }
      // A forged event would show up as an attacker-chosen stage label.
      for (const line of ev) {
        expect(/stage=attacker|stage=evil/.test(line)).toBe(false);
      }
    }
  });

  it('caps the logged model token length', async () => {
    await run([{ provider: 'gemini', model: 'm'.repeat(500) }]);
    const ev = stageEvents()[0];
    const match = /model=([^\s]*)/.exec(ev);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(64);
  });

  it('strips ANSI/control characters from the logged token', async () => {
    await run([{ provider: 'gemini', model: 'gemini\u001b[31mRED\u001b[0m' }]);
    const ev = stageEvents()[0];
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f]/.test(ev)).toBe(false);
    expect(ev).not.toContain('\u001b');
  });
});

// ---------------------------------------------------------------------------
// 6. No secret / recipe / receipt material in logs
// ---------------------------------------------------------------------------

describe('9B-P2 — logs carry no secret, recipe, prompt or receipt material', () => {
  it('never emits recipe text, ingredient text, prompt or request body', async () => {
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    const out = allOutput();
    for (const forbidden of [
      'eggs', 'whole milk', 'all-purpose flour', 'unsalted butter', 'sea salt', 'chives',
      'RECIPE DATA', 'REQUESTED TARGETS', 'interpretation assistant',
      'p2-diagnostic', 'request_id', 'request_version',
      'wsem1', 'wsemo1', 'sha256:',
      'contract_version', 'semantic_response', 'interpretations',
    ]) {
      expect(out, forbidden).not.toContain(forbidden);
    }
  });

  it('never emits any credential-shaped fragment', async () => {
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    const out = allOutput();
    for (const forbidden of ['Bearer', 'authorization', 'api_key', 'apiKey', 'sk-', 'AIza', 'cookie']) {
      expect(out, forbidden).not.toContain(forbidden);
    }
  });

  it('never emits a receipt value, even on the success path', async () => {
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    const receipt = (r as { origin_receipt: string }).origin_receipt;
    const operation = (r as { operation_id: string }).operation_id;
    const binding = (r as { context_binding: string }).context_binding;
    expect(receipt).toMatch(/^wsem1\./);
    expect(allOutput()).not.toContain(receipt);
    expect(allOutput()).not.toContain(operation);
    expect(allOutput()).not.toContain(binding);
  });
});

// ---------------------------------------------------------------------------
// 7. Behavioural neutrality: no extra calls, no receipt on failure
// ---------------------------------------------------------------------------

describe('9B-P2 — the diagnostic changes NO behaviour', () => {
  it('issues exactly one provider call on the success path (no added fan-out)', async () => {
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(prov.calls).toBe(1);
  });

  it('adds no provider call beyond the released fallback chain', async () => {
    prov.failModels = ['gemini-3.7-flash'];
    await run([
      { provider: 'gemini', model: 'gemini-3.7-flash' },
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    ]);
    expect(prov.calls).toBe(2);
  });

  it('issues NO receipt and NO operation identity when validation fails', async () => {
    prov.override = () => ({ contract_version: 'nutrition_ai_advanced_interpretation_v1', interpretations: [] });
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    const raw = JSON.stringify(r);
    expect(raw).not.toContain('wsem1');
    expect(raw).not.toContain('wsemo1');
    expect(raw).not.toContain('origin_receipt');
  });

  it('leaves the operation result contract byte-identical on success', async () => {
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    expect(Object.keys(r as object).sort()).toEqual([
      'aiAttempted', 'context_binding', 'contract_version', 'model_id', 'ok', 'operation_id',
      'origin_receipt', 'provider_id', 'request_id', 'request_version', 'semantic_response',
    ]);
    expect((r as { aiAttempted: boolean }).aiAttempted).toBe(true);
    expect((r as { contract_version: string }).contract_version).toBe('nutrition_ai_advanced_interpretation_v1');
    expect((r as { request_version: string }).request_version).toBe('nutrition_ai_whole_recipe_interpretation_request_v1');
  });

  it('leaves every failure code exactly as released', async () => {
    prov.override = () => ({ contract_version: 'nutrition_ai_advanced_interpretation_v1', interpretations: [] });
    expect(((await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }])) as { code: string }).code)
      .toBe('reconciliation_failed');

    prov.override = null;
    prov.failModels = ['gemini-3.7-flash'];
    expect(((await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }])) as { code: string }).code)
      .toBe('provider_error');

    const bad = { ...request(), targets: [] };
    warnings = [];
    prov.calls = 0;
    const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
    const r = await interpretWholeRecipeSemantics(bad, {});
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_request');
    // A pre-provider refusal logs NO stage event at all.
    expect(stageEvents()).toHaveLength(0);
    expect(prov.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Phase 9B-P2 AUDIT FINDING — LOG-FIELD INJECTION (printable ASCII)
// ---------------------------------------------------------------------------
//
// The first implementation filtered only NON-PRINTABLE characters, so printable
// ASCII — spaces and `=` in particular — survived and forged apparent fields:
//   input  `gemini-3.7-flash stage=origin_proof_failed provider=attacker`
//   line   ... model=gemini-3.7-flash stage=origin_proof_failed provider=attacker
// A `key=value` reader saw a forged `stage=` and a forged `provider=`.
// The repair filters against a positive ALLOWLIST, so `=` cannot occur at all.

/** Parses an emitted diagnostic line into its authentic `key=value` fields. */
function parseFields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/g)) out[m[1] as string] = m[2] as string;
  return out;
}

/** The exact key set an emitted event may legitimately contain. */
const ALLOWED_FIELD_KEYS = new Set(['stage', 'provider', 'model', 'reason']);

describe('9B-P2 audit fix — injected identifiers cannot forge diagnostic fields', () => {
  const FORGED = [
    ['printable spaces', 'gemini-3.7-flash stage=origin_proof_failed provider=attacker'],
    ['embedded equals', 'gemini=evil'],
    ['forged stage field', 'gemini-3.7-flash stage=origin_proof_failed'],
    ['forged provider field', 'gemini provider=attacker'],
    ['forged model field', 'gemini-3.7-flash model=attacker'],
    ['double quotes', 'gemini"provider="attacker'],
    ['single quotes', "gemini'provider='attacker"],
    ['square brackets', 'gemini[stage=origin_proof_failed]'],
    ['braces and angle brackets', 'gemini{stage=x}<provider=y>'],
    ['backtick', 'gemini`stage=x`'],
    ['tab', 'gemini\tstage=origin_proof_failed'],
    ['CRLF', 'gemini\r\nstage=origin_proof_failed'],
    ['LF only', 'gemini\nstage=origin_proof_failed'],
    ['ANSI escape', 'gemini\u001b[2J\u001b[31mstage=origin_proof_failed'],
    ['unicode control', 'gemini\u000b\u009b\u00adstage=x'],
    ['unicode line separator', 'gemini\u2028stage=origin_proof_failed'],
    ['semicolon and pipe', 'gemini;stage=x|provider=y'],
    ['oversized identifier', 'g'.repeat(900)],
  ];

  it.each(FORGED)('yields exactly one authentic stage field for %s', async (_label, hostile) => {
    await run([{ provider: 'gemini', model: hostile }]);
    const ev = stageEvents();
    expect(ev.length).toBeGreaterThanOrEqual(1);
    for (const line of ev) {
      const fields = parseFields(line);
      // Exactly one stage, and it is an authentic closed label.
      expect(Object.keys(fields).filter((k) => k === 'stage')).toHaveLength(1);
      expect(['provider_returned', 'sanitizer_rejected', 'reconciliation_rejected', 'origin_proof_failed'])
        .toContain(fields['stage']);
      // NO key beyond the allowed set was ever parsed out of identifier content.
      for (const key of Object.keys(fields)) {
        expect(ALLOWED_FIELD_KEYS.has(key), `forged field ${key} in ${line}`).toBe(true);
      }
      // The emitted token alphabet is exactly the allowlist.
      const token = fields['model'] ?? fields['provider'] ?? '';
      expect(token).toMatch(/^[A-Za-z0-9._:/-]*$/);
      expect(token.length).toBeLessThanOrEqual(64);
      // Never contains a delimiter, whitespace, or a control character.
      expect(line).not.toMatch(/[=\s]/g.test(line) ? /model=[^\s]*[=\s]/ : /$^/);
    }
  });

  it('never emits a second stage= token from identifier content', async () => {
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash stage=origin_proof_failed' }]);
    for (const line of stageEvents()) {
      expect(line.split('stage=').length - 1).toBeLessThanOrEqual(1);
    }
  });

  it('never emits an attacker-chosen provider or model value', async () => {
    await run([{ provider: 'gemini', model: 'gemini-3.7-flash provider=attacker model=attacker' }]);
    const fields = parseFields(stageEvents()[0]);
    expect(fields['provider']).toBe('gemini');
    expect(fields['model']).not.toBe('attacker');
  });

  it('keeps attribution truthful: provider is the real provider id', async () => {
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    const fields = parseFields(stageEvents()[0]);
    expect(fields['provider']).toBe((r as { provider_id: string }).provider_id);
    expect(fields['model']).toBe((r as { model_id: string }).model_id);
  });

  it('keeps attribution truthful across a fallback', async () => {
    prov.failModels = ['gemini-3.7-flash'];
    const r = await run([
      { provider: 'gemini', model: 'gemini-3.7-flash' },
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    ]);
    expect(r.ok).toBe(true);
    const returned = stageEvents().find((e) => e.includes('stage=provider_returned'))!;
    const fields = parseFields(returned);
    expect(fields['model']).toBe((r as { model_id: string }).model_id);
    expect(fields['provider']).toBe((r as { provider_id: string }).provider_id);
  });

  it('preserves legitimate Gemini, OpenRouter-style and DeepSeek identifiers', async () => {
    const VALID = [
      'gemini-3.7-flash',
      'gemini-3.1-flash-lite',
      'gemini-flash-latest',
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
      'meta-llama/llama-3.1-70b-instruct:free',
      'deepseek-chat',
      'deepseek-reasoner',
      'gemini_3_pro_variant',
    ];
    for (const model of VALID) {
      warnings = [];
      prov.calls = 0;
      prov.failModels = [];
      prov.override = null;
      const r = await run([{ provider: 'gemini', model }]);
      expect(r.ok, `model=${model}`).toBe(true);
      const fields = parseFields(stageEvents()[0]);
      expect(fields['model'], `model=${model}`).toBe(model);
    }
  });

  it('degrades an unidentifiable value to the safe placeholder', async () => {
    // A whitespace-only model id carries no safe character at all, so the token
    // degrades to `unknown`. The receipt subject reader separately refuses such
    // a model id, so the operation ends at origin-proof — the point under test is
    // the TOKEN, not the operation outcome.
    await run([{ provider: 'gemini', model: '   ' }]);
    const returned = stageEvents().find((e) => e.includes('stage=provider_returned'))!;
    const fields = parseFields(returned);
    expect(fields['model']).toBe('unknown');
    expect(fields['model']).toMatch(/^[A-Za-z0-9._:/-]*$/);
  });
});

// ---------------------------------------------------------------------------
// 9. LOG-SINK FAILURE ISOLATION
// ---------------------------------------------------------------------------

describe('9B-P2 audit fix — a throwing diagnostic sink cannot affect correctness', () => {
  it('does not change a SUCCESSFUL interpretation result', async () => {
    warnSpy.mockImplementation(() => { throw new Error('sink is broken'); });
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(true);
    // Full authority surface intact.
    expect((r as { origin_receipt: string }).origin_receipt).toMatch(/^wsem1\.[A-Za-z0-9_-]{43}$/);
    expect((r as { operation_id: string }).operation_id).toMatch(/^wsemo1\./);
    expect((r as { context_binding: string }).context_binding).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((r as { model_id: string }).model_id).toBe('gemini-3.7-flash');
    expect(Array.isArray((r as { semantic_response: ReadonlyArray<unknown> }).semantic_response)).toBe(true);
    expect(prov.calls).toBe(1);
  });

  it('does not change a sanitizer rejection result', async () => {
    prov.override = () => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: [goodRow('ing:99:deadbeefcafe')],
    });
    warnSpy.mockImplementation(() => { throw new Error('sink is broken'); });
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_response');
    expect((r as { aiAttempted: boolean }).aiAttempted).toBe(true);
    expect(JSON.stringify(r)).not.toContain('wsem1');
  });

  it('does not change a reconciliation rejection result', async () => {
    prov.override = () => ({ contract_version: 'nutrition_ai_advanced_interpretation_v1', interpretations: [] });
    warnSpy.mockImplementation(() => { throw new Error('sink is broken'); });
    const r = await run([{ provider: 'gemini', model: 'gemini-3.7-flash' }]);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('reconciliation_failed');
    expect(JSON.stringify(r)).not.toContain('wsem1');
  });

  it('does not change an origin-proof rejection result', async () => {
    const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
    const provider = mockProvider('gemini');
    warnSpy.mockImplementation(() => { throw new Error('sink is broken'); });
    const r = await interpretWholeRecipeSemantics(request(), {
      candidates: [{ provider, model: 'gemini-3.7-flash' }],
      registry: [{ provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities }],
      authority: { issue: () => ({ ok: false, code: 'invalid_subject' }), verify: () => ({ ok: false }), issuedCount: 0 } as never,
    });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('origin_proof_failed');
  });

  it('does NOT swallow a genuine provider error: the fallback chain still runs', async () => {
    prov.failModels = ['gemini-3.7-flash', 'gemini-3.1-flash-lite'];
    const r = await run([
      { provider: 'gemini', model: 'gemini-3.7-flash' },
      { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
    ]);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('provider_error');
    expect(prov.calls).toBe(2);
  });
});
