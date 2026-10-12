/**
 * The Kitchen Codex — Phase 9B-P5A.
 * EXHAUSTED-FALLBACK DIAGNOSTICS — observability only.
 *
 * WHY THIS SUITE EXISTS. The 9B-P5 controlled live smoke consumed BOTH
 * authorized Gemini candidates and returned HTTP 503, but the server log named
 * only the FINAL candidate (`gemini-3.1-flash-lite`, 504 DEADLINE_EXCEEDED).
 * The PRIMARY candidate's failure was invisible, so "primary failed, then the
 * fallback failed" was indistinguishable from "only the fallback ever ran".
 *
 * `runWithAiFallback` already retains the full sanitized attempt trail:
 * `terminalError()` attaches it to the terminal `ProviderOperationError` as a
 * NON-ENUMERABLE own property. 9B-P5A only READS that data; the fallback runner
 * is NOT modified.
 *
 * This suite proves the diagnostic boundary is:
 *   - derived from the REAL trusted trail (never invented),
 *   - rejected unless it belongs to a genuine normalized terminal error,
 *   - closed-vocabulary (allowlisted codes only, no raw messages),
 *   - injection-proof (provider/model identifiers cannot forge log fields),
 *   - bounded (at most eight per-attempt events),
 *   - unable to alter provider execution, the result, or the HTTP contract.
 *
 * Mocked providers only. NO live provider is contacted. NO real key is used.
 * Nothing here is a claim about the original 9B-P5 in-memory trail, which was
 * lost when that process exited.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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
// CONSOLE CAPTURE
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

function stageEvents(): string[] {
  return warnings.filter((w) => w.includes('[wholeRecipeSemantic][stage]'));
}
function allOutput(): string {
  return warnings.join('\n');
}
function exhaustedEvents(): string[] {
  return stageEvents().filter((e) => e.includes('stage=fallback_exhausted'));
}
function attemptEvents(): string[] {
  return exhaustedEvents().filter((e) => /(^|\s)attempt=/.test(e));
}
/** Parses `key=value` pairs off one event line. */
function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of line.split(' ')) {
    const at = token.indexOf('=');
    if (at > 0) out[token.slice(0, at)] = token.slice(at + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PROVIDER MOCK
// ---------------------------------------------------------------------------

const prov = vi.hoisted(() => ({
  calls: 0,
  /** model id -> throw this factory */
  failModels: {} as Record<string, () => unknown>,
  /** when set, every model throws this factory */
  failAll: null as null | (() => unknown),
  /** override the successful payload */
  override: null as null | (() => unknown),
  /** provider id reported in normalized diagnostics */
  providerId: 'gemini',
}));

vi.mock('../../server/ai/providerRegistry.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../server/ai/providerRegistry.js');
  return { ...actual, getRegisteredProviders: () => [] };
});

function mockProvider(): AiProvider {
  return {
    id: prov.providerId,
    name: prov.providerId,
    capabilities: { reasoning: true, structuredOutput: true, recipeGeneration: false, webSearch: false },
    isAvailable: () => true,
    testConnection: async () => true,
    generate: async () => '',
    generateStructured: async (_p: string, _s: AiJsonSchema, options?: AiStructuredOptions) => {
      prov.calls += 1;
      const model = options?.model ?? '';
      if (prov.failAll) throw prov.failAll();
      const factory = prov.failModels[model];
      if (factory) throw factory();
      if (prov.override) return prov.override() as never;
      return {
        contract_version: 'nutrition_ai_advanced_interpretation_v1',
        interpretations: [
          {
            contract_version: 'nutrition_ai_advanced_interpretation_v1',
            line_ref: 'ing:0:20e4077fc89a',
            semantic_food: { normalized_name: 'whole egg', modifiers: [], preparation: [], state: [], qualifiers: [] },
            search_phrases: ['whole egg'],
            amount_semantics: { kind: 'exact', echoed_value: 4 },
            unit_semantics: { family: 'count' },
            count_semantics: {},
            alternatives: [],
            ambiguity: { ambiguous: false, reasons: [] },
          },
        ],
      } as never;
    },
  };
}

// ---------------------------------------------------------------------------
// FIXTURE (released adapter; non-sensitive)
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
  return {
    request_version: 'nutrition_ai_whole_recipe_interpretation_request_v1',
    request_id: 'p5a-diagnostic',
    recipe: RECIPE,
    instructions: INSTRUCTIONS,
    targets: [{ line_ref: adapted.recipe.adapted[0].line_ref }],
  };
}

const PRIMARY = 'gemini-3.7-flash';
const FALLBACK = 'gemini-3.1-flash-lite';

async function run(models: string[] = [PRIMARY, FALLBACK]) {
  const { interpretWholeRecipeSemantics } = await import('../../server/wholeRecipeSemanticInterpret.js');
  const candidates: AiCandidate[] = [];
  const registry: RegisteredProvider[] = [];
  for (const model of models) {
    const provider = mockProvider();
    candidates.push({ provider, model });
    registry.push({ provider, defaultCapabilities: { ...provider.capabilities } as AiCapabilities });
  }
  return interpretWholeRecipeSemantics(request(), { candidates, registry });
}

beforeEach(() => {
  prov.calls = 0;
  prov.failModels = {};
  prov.failAll = null;
  prov.override = null;
  prov.providerId = 'gemini';
});

// ---------------------------------------------------------------------------
// 1. TWO CANDIDATES FAIL — BOTH TRUSTED ATTEMPT CODES ARE REPORTED
// ---------------------------------------------------------------------------

describe('9B-P5A — an exhausted chain reports every trusted attempt', () => {
  it('reports BOTH the primary and the fallback failure', async () => {
    const withStatus = (code: string, message: string, status: number): ProviderOperationError => {
      // `providerId` must already be set, otherwise `normalizeProviderError`
      // builds a fresh instance and this one (and its status) is dropped.
      const err = new ProviderOperationError(code as never, message, {
        providerId: 'gemini',
        model: FALLBACK,
      });
      // The constructor does not read `ctx.status`; the runner sets it for raw
      // errors. Attach it the same way `normalizeProviderError` does.
      Object.defineProperty(err, 'status', { value: status, enumerable: true, writable: false });
      return err;
    };
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('RATE_LIMIT', 'primary rate limited', {}),
      [FALLBACK]: () => withStatus('PROVIDER_ERROR', 'deadline exceeded', 504),
    };
    const r = await run();
    expect(r.ok).toBe(false);

    const attempts = attemptEvents().map(fields);
    expect(attempts).toHaveLength(2);

    // Attempt 1 is the PRIMARY, attempt 2 the FALLBACK — the gap P5 exposed.
    expect(attempts[0]).toMatchObject({
      attempt: '1',
      code: 'RATE_LIMIT',
      provider: 'gemini',
      model: PRIMARY,
    });
    expect(attempts[1]).toMatchObject({
      attempt: '2',
      code: 'PROVIDER_ERROR',
      provider: 'gemini',
      model: FALLBACK,
      status: '504',
    });

    // The summary event leads, and counts exactly the emitted attempts.
    const summary = fields(exhaustedEvents()[0]);
    expect(summary.stage).toBe('fallback_exhausted');
    expect(summary.attempts).toBe('2');
    expect(summary.truncated).toBeUndefined();
  });

  it('emits NO attempt event when the terminal error is not the trusted type', async () => {
    // A non-configurable own `diagnostics` makes the runner's terminalError()
    // throw, so the operation catches a TypeError rather than the trusted
    // terminal error. An untrusted shape must yield ZERO attempt reports.
    prov.failAll = () => {
      const err = new ProviderOperationError('PROVIDER_ERROR', 'boom', { providerId: 'gemini', model: PRIMARY });
      Object.defineProperty(err, 'diagnostics', {
        value: [{ code: 'QUOTA', providerId: 'gemini', model: PRIMARY, message: 'SECRET_TRAIL' }],
        enumerable: true,
        writable: false,
        configurable: false,
      });
      return err;
    };
    const r = await run([PRIMARY]);
    expect(r.ok).toBe(false);
    expect(attemptEvents()).toHaveLength(0);
    // The forged trail content never reaches the log.
    expect(allOutput()).not.toContain('SECRET_TRAIL');
  });

  it('bounds the emitted trail to at most eight per-attempt events', async () => {
    prov.failAll = () => new ProviderOperationError('QUOTA', 'q', {});
    const many = Array.from({ length: 40 }, (_, i) => `m-${i}`);
    const r = await run(many);
    expect(r.ok).toBe(false);
    const attempts = attemptEvents();
    expect(attempts).toHaveLength(8);
    expect(fields(exhaustedEvents()[0]).attempts).toBe('8');
    // Truncation is declared, never silent.
    expect(fields(exhaustedEvents()[0]).truncated).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. SUCCESS PATHS ARE COMPLETELY UNCHANGED
// ---------------------------------------------------------------------------

describe('9B-P5A — successful runs are untouched', () => {
  it('primary fails, fallback succeeds: full success, no exhaustion event', async () => {
    prov.failModels = { [PRIMARY]: () => new ProviderOperationError('RATE_LIMIT', 'primary failed', {}) };
    const r = await run();
    expect(r.ok).toBe(true);
    // The recovered fallback still reports the winning identity, as before.
    expect((r as { provider_id: string }).provider_id).toBe('gemini');
    expect((r as { model_id: string }).model_id).toBe(FALLBACK);
    // NO exhaustion diagnostic on a recovered chain.
    expect(exhaustedEvents()).toHaveLength(0);
  });

  it('primary succeeds: no failure event is invented', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(exhaustedEvents()).toHaveLength(0);
    expect(attemptEvents()).toHaveLength(0);
    expect(stageEvents()).toHaveLength(1);
    expect(stageEvents()[0]).toContain('stage=provider_returned');
  });

  it('a valid run still yields a signed receipt', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    const success = r as { origin_receipt: string; operation_id: string };
    expect(success.origin_receipt.startsWith('wsem1.')).toBe(true);
    expect(success.operation_id.startsWith('wsemo1.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. ABSENT / MALFORMED TRAIL
// ---------------------------------------------------------------------------

describe('9B-P5A — absent and malformed trails are treated as absent', () => {
  it('a single failed candidate reports exactly one attempt and invents nothing', async () => {
    prov.failModels = { [PRIMARY]: () => new ProviderOperationError('UNAVAILABLE', 'unavailable', {}) };
    const r = await run([PRIMARY]);
    expect(r.ok).toBe(false);
    const attempts = attemptEvents().map(fields);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: '1', code: 'UNAVAILABLE', model: PRIMARY });
    // Nothing beyond the one real attempt.
    expect(prov.calls).toBe(1);
  });

  it('every emitted event carries a well-formed, single-line shape', async () => {
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('TIMEOUT', 'x', {}),
      [FALLBACK]: () => new ProviderOperationError('UNAVAILABLE', 'y', {}),
    };
    await run();
    for (const line of exhaustedEvents()) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\r');
      expect(fields(line).stage).toBe('fallback_exhausted');
      // Exactly one stage token per line.
      expect(line.split('stage=').length - 1).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 6 + 7. INJECTION AND UNKNOWN-VALUE RESISTANCE
// ---------------------------------------------------------------------------

describe('9B-P5A — identifiers and unknown values cannot inject or leak', () => {
  const HOSTILE = [
    'stage=origin_proof_failed provider=attacker',
    'gemini\nstage=attacker',
    'a'.repeat(500),
    'model=x code=BLOCKED',
    'gemini[31mRED',
    'code=QUOTA',
  ];

  it.each(HOSTILE)('a hostile model identifier cannot forge extra fields: %s', async (hostile) => {
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('QUOTA', 'primary failed', {}),
      [FALLBACK]: () => new ProviderOperationError('QUOTA', 'fallback failed', {}),
    };
    const r = await run([PRIMARY, hostile]);
    expect(r.ok).toBe(false);
    for (const line of attemptEvents()) {
      const f = fields(line);
      // Only the declared key set may ever appear.
      for (const key of Object.keys(f)) {
        expect(['stage', 'attempt', 'code', 'provider', 'model', 'status'], `forged ${key}`).toContain(key);
      }
      expect(f.stage).toBe('fallback_exhausted');
      // The token alphabet is exactly the P2 allowlist, and bounded.
      for (const key of ['provider', 'model']) {
        if (f[key] === undefined) continue;
        expect(f[key]).toMatch(/^[A-Za-z0-9._:/-]*$/);
        expect(f[key].length).toBeLessThanOrEqual(64);
      }
      // Exactly one stage token: a hostile id cannot forge another event.
      expect(line.split('stage=').length - 1).toBe(1);
    }
    expect(allOutput()).not.toContain('stage=attacker');
  });

  it('a hostile PROVIDER identifier cannot forge extra fields', async () => {
    prov.providerId = 'evil stage=attacker provider=forged';
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('QUOTA', 'p', {}),
      [FALLBACK]: () => new ProviderOperationError('QUOTA', 'f', {}),
    };
    const r = await run();
    expect(r.ok).toBe(false);
    for (const line of attemptEvents()) {
      expect(Object.keys(fields(line))).not.toContain('forged');
      expect(line.split('stage=').length - 1).toBe(1);
    }
    expect(allOutput()).not.toContain('provider=forged');
  });

  it('drops a non-HTTP or out-of-range status instead of emitting it', async () => {
    // `ProviderErrorContext` has no `status`; the runner sets it as an own
    // property, so the fixture does the same. `providerId` must be present or
    // `normalizeProviderError` rebuilds the error and drops the property.
    const withRawStatus = (value: unknown): ProviderOperationError => {
      const err = new ProviderOperationError('PROVIDER_ERROR', 'f', {
        providerId: 'gemini',
        model: FALLBACK,
      });
      Object.defineProperty(err, 'status', { value, enumerable: true, writable: false });
      return err;
    };
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('PROVIDER_ERROR', 'p', { providerId: 'gemini', model: PRIMARY }),
      [FALLBACK]: () => withRawStatus(99999),
    };
    const r = await run();
    expect(r.ok).toBe(false);
    const attempts = attemptEvents().map(fields);
    expect(attempts[0].status).toBeUndefined();
    expect(attempts[1].status).toBeUndefined();
  });

  it('drops a non-integer or non-numeric status', async () => {
    for (const bad of [99, 600, 504.5, Number.NaN, '504', null]) {
      warnings = [];
      prov.failModels = {
        [PRIMARY]: () => new ProviderOperationError('PROVIDER_ERROR', 'p', { providerId: 'gemini', model: PRIMARY }),
        [FALLBACK]: () => {
          const err = new ProviderOperationError('PROVIDER_ERROR', 'f', {
            providerId: 'gemini',
            model: FALLBACK,
          });
          Object.defineProperty(err, 'status', { value: bad, enumerable: true, writable: false });
          return err;
        },
      };
      await run();
      const attempt = attemptEvents().map(fields)[1];
      expect(attempt?.status, `status ${String(bad)} must be dropped`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. NO LEAKAGE
// ---------------------------------------------------------------------------

describe('9B-P5A — nothing sensitive reaches the log', () => {
  it('the fallback_exhausted events never carry a message or any recipe identity', async () => {
    const SECRETS = [
      'sk-live-abcdef1234567890',
      'eggs, separated',
      'whole milk',
      'Fold the whites back into the yolks.',
      'ing:0:20e4077fc89a',
      'p5a-diagnostic',
      'sha256:fc683c6e',
    ];
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('QUOTA', 'SECRET_PRIMARY_MESSAGE sk-live-abcdef1234567890', {}),
      [FALLBACK]: () => new ProviderOperationError('PROVIDER_ERROR', 'SECRET_FALLBACK_MESSAGE', {}),
    };
    const r = await run();
    expect(r.ok).toBe(false);

    // NOTE: the PRE-EXISTING redacted provider logger (`logModelAttempt`) does
    // emit a truncated, secret-redacted `message=` field. That is established
    // P2 behavior and is deliberately NOT changed here. What is asserted here is
    // that the NEW diagnostic channel carries NO message at all.
    for (const line of exhaustedEvents()) {
      expect(line).not.toContain('message=');
      for (const key of Object.keys(fields(line))) {
        expect(['stage', 'attempts', 'attempt', 'code', 'provider', 'model', 'status', 'truncated']).toContain(key);
      }
    }
    // No secret and no recipe/identity content reaches the new channel.
    const newChannel = exhaustedEvents().join('\n');
    for (const secret of SECRETS) {
      expect(newChannel, `leaked ${secret}`).not.toContain(secret);
    }
    // Credentials are redacted everywhere, including the pre-existing logger.
    expect(allOutput()).not.toContain('sk-live-abcdef1234567890');
    // The structural facts ARE reported.
    expect(newChannel).toContain('stage=fallback_exhausted');
    expect(newChannel).toContain('code=QUOTA');
    expect(newChannel).toContain('code=PROVIDER_ERROR');
  });

  it('never serializes the raw provider cause', async () => {
    const rawCause = new Error('RAW_CAUSE_MARKER sk-live-rawcause');
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('QUOTA', 'p', {}, rawCause),
      [FALLBACK]: () => new ProviderOperationError('QUOTA', 'f', {}, rawCause),
    };
    await run();
    expect(allOutput()).not.toContain('RAW_CAUSE_MARKER');
    expect(allOutput()).not.toContain('sk-live-rawcause');
  });
});

// ---------------------------------------------------------------------------
// 9. SINK ISOLATION
// ---------------------------------------------------------------------------

describe('9B-P5A — a broken diagnostic sink changes nothing', () => {
  it('a THROWING sink for the NEW stage logger leaves the result identical', async () => {
    // Scoped to the 9B stage channel. The PRE-EXISTING `logModelAttempt` helper
    // (server/providerDiagnostics.ts) is not sink-isolated — a pre-existing
    // P2 gap this phase deliberately does not change — so a globally throwing
    // console.warn would surface that older issue instead of this one.
    warnSpy.mockImplementation((...args: unknown[]) => {
      const line = args.map((a) => String(a)).join(' ');
      if (line.includes('[wholeRecipeSemantic][stage]')) throw new Error('stage sink exploded');
      warnings.push(line);
    });
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('QUOTA', 'p', {}),
      [FALLBACK]: () => new ProviderOperationError('PROVIDER_ERROR', 'f', {}),
    };
    const r = await run();
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('provider_error');
    expect((r as { aiAttempted: boolean }).aiAttempted).toBe(true);
    expect(Object.keys(r).sort()).toEqual(['aiAttempted', 'code', 'ok']);
  });
});

// ---------------------------------------------------------------------------
// 10 + 11. NO EXTRA PROVIDER WORK; PUBLIC BEHAVIOR UNCHANGED
// ---------------------------------------------------------------------------

describe('9B-P5A — provider execution and the public result are untouched', () => {
  it('makes exactly one attempt per candidate and no retries', async () => {
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('QUOTA', 'p', {}),
      [FALLBACK]: () => new ProviderOperationError('QUOTA', 'f', {}),
    };
    await run();
    expect(prov.calls).toBe(2);
  });

  it('the failure result shape is exactly the pre-existing one', async () => {
    prov.failModels = {
      [PRIMARY]: () => new ProviderOperationError('QUOTA', 'p', {}),
      [FALLBACK]: () => new ProviderOperationError('QUOTA', 'f', {}),
    };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['aiAttempted', 'code', 'ok']);
    expect((r as { code: string }).code).toBe('provider_error');
    expect((r as { aiAttempted: boolean }).aiAttempted).toBe(true);
    // No receipt, no operation id, no semantic payload on a provider failure.
    expect((r as { origin_receipt?: unknown }).origin_receipt).toBeUndefined();
    expect((r as { operation_id?: unknown }).operation_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. P4 SANITIZER SUB-REASONS CONTINUE TO WORK INDEPENDENTLY
// ---------------------------------------------------------------------------

describe('9B-P5A — P4 sanitizer sub-reasons still work', () => {
  it('a sanitizer rejection still reports its closed sub_reason', async () => {
    prov.override = () => ({
      contract_version: 'nutrition_ai_advanced_interpretation_v1',
      interpretations: [
        {
          contract_version: 'nutrition_ai_advanced_interpretation_v1',
          line_ref: 'ing:0:20e4077fc89a',
          semantic_food: { normalized_name: 'whole egg' },
          search_phrases: ['a', 'b', 'c', 'd', 'e'],
          amount_semantics: { kind: 'exact' },
          unit_semantics: { family: 'count' },
          count_semantics: {},
          alternatives: [],
          ambiguity: { ambiguous: false, reasons: [] },
        },
      ],
    });
    const r = await run([PRIMARY]);
    expect(r.ok).toBe(false);
    const event = stageEvents().find((e) => e.includes('stage=sanitizer_rejected'));
    expect(event).toContain('reason=invalid_response');
    expect(event).toContain('sub_reason=search_phrases_shape');
    // A sanitizer rejection is NOT a provider exhaustion.
    expect(exhaustedEvents()).toHaveLength(0);
  });

  it('provider_returned still fires exactly once on success', async () => {
    await run([PRIMARY]);
    expect(stageEvents().filter((e) => e.includes('stage=provider_returned'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL PINS
// ---------------------------------------------------------------------------

describe('9B-P5A — structural pins for the non-reachable trust guards', () => {
  const SOURCE = readFileSync(
    new URL('../../server/wholeRecipeSemanticInterpret.ts', import.meta.url),
    'utf8'
  );

  it('reads the trail only from a ProviderOperationError with a NON-ENUMERABLE own property', () => {
    // MUTATION-SENSITIVE. The trusted runner attaches the trail non-enumerably.
    // A test cannot inject a differently-shaped trail through the real runner,
    // so these two guards are pinned structurally rather than claimed as
    // behaviourally covered.
    expect(SOURCE).toContain('if (!(error instanceof ProviderOperationError)) return [];');
    expect(SOURCE).toContain(
      "if (descriptor === undefined || descriptor.enumerable !== false) return [];"
    );
    expect(SOURCE).toContain("Object.getOwnPropertyDescriptor(error, 'diagnostics')");
  });

  it('never reads the diagnostic message field', () => {
    // Slice ONLY this function's body, by brace matching, so unrelated later
    // code (e.g. the prompt builder's own JSON.stringify) is not in scope.
    const start = SOURCE.indexOf('function logFallbackExhausted(');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = SOURCE.indexOf('{', start);
    for (let i = end; i < SOURCE.length; i += 1) {
      if (SOURCE[i] === '{') depth += 1;
      else if (SOURCE[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = SOURCE.slice(start, end + 1);
    expect(body).toContain('// `entry.message` is deliberately NEVER read.');
    // No read of `entry.message` other than inside that comment.
    const codeOnly = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(codeOnly).not.toContain('entry.message');
    expect(codeOnly).not.toContain('JSON.stringify');
    expect(codeOnly).not.toContain('...entry');
  });

  it('uses the existing safeDiagnosticToken and the closed code allowlist', () => {
    expect(SOURCE).toContain('LOGGABLE_PROVIDER_ERROR_CODES.has(entry.code)');
    expect(SOURCE).toContain('fields.provider = safeDiagnosticToken(entry.providerId);');
    expect(SOURCE).toContain('fields.model = safeDiagnosticToken(entry.model);');
    expect(SOURCE).toContain('const MAX_FALLBACK_ATTEMPT_EVENTS = 8;');
  });

  it('keeps the fallback runner itself UNMODIFIED', () => {
    // The whole point of 9B-P5A: the shared runner already retained the data.
    const registry = readFileSync(
      new URL('../../server/ai/providerRegistry.ts', import.meta.url),
      'utf8'
    );
    expect(registry).toContain('throw terminalError(last, diagnostics);');
    expect(registry).toContain('enumerable: false');
  });

  it('reads the trail from the CAUGHT error, never from a re-normalized copy', () => {
    // MUTATION-SENSITIVE, STRUCTURAL ONLY. Swapping `error` for `normalized`
    // changes NOTHING today, because `normalizeProviderError(error)` is called
    // with no context here and therefore returns the SAME instance
    // (providerErrors.ts `return error`). It is pinned anyway because it is
    // latent fragility: if a context were ever passed, a fresh instance would
    // be built WITHOUT the non-enumerable trail and the diagnostic would
    // silently vanish. No behavioural test can distinguish the two today.
    expect(SOURCE).toContain('logFallbackExhausted(error);');
    expect(SOURCE).not.toContain('logFallbackExhausted(normalized);');
  });
});
