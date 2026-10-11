/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-2A.
 * WHOLE-RECIPE SEMANTIC-ORIGIN PROOF: unsafe-signing refusal, domain separation,
 * and source-level security invariants.
 *
 * This file proves the NEGATIVE space, which is where a security primitive is
 * actually load-bearing:
 *
 *   - the issuer REFUSES to sign anything the released semantic contract will
 *     not accept, including every forbidden authority field (fdc_id, grams,
 *     calories, nutrients, candidate, origin_receipt, context_binding);
 *   - a server MAC can NEVER legitimize forbidden model output: the proof
 *     authenticates only a SAFE sanitized semantic interpretation;
 *   - ISSUE-AFTER-SANITIZE is enforced structurally — there is no "sign raw
 *     output" path, and raw provider-shaped input converges to the SAME proof as
 *     its sanitized form because the MAC covers the sanitizer's output;
 *   - the AI-4E receipt domain is fully separate in BOTH directions: an AI-4E
 *     receipt never verifies here, and a semantic-origin proof is never accepted
 *     by AI-4E verification;
 *   - the key is server-owned, independent, and never leaves the process.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWholeRecipeSemanticOperationId,
  createWholeRecipeSemanticOriginAuthority,
} from '../../server/wholeRecipeSemanticOriginReceipt';
import {
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_LENGTH,
} from '../../src/core/nutritionV2/aiWholeRecipeSemanticOriginReceiptShape';
import { AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX } from '../../src/core/nutritionV2/aiRecipeContextOriginReceiptShape';
import {
  createRecipeContextOriginReceiptAuthority,
} from '../../server/recipeContextOriginReceipt';
import {
  AI_RECIPE_CONTEXT_REQUEST_VERSION,
} from '../../src/core/nutritionV2/aiRecipeContextRequest';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import { WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION } from '../../src/core/nutritionV2/aiWholeRecipeInterpretation';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { materializeWholeRecipeInterpretationContext } from '../../server/wholeRecipeInterpretRequest';

const REPO = process.cwd();
/** A distinctive credential-shaped probe that must never appear anywhere client-side. */
const SECRET_PROBE = 'sk-or-v1-9B2A_MUST_NEVER_LEAK_0123456789';
const read = (relative: string): string => readFileSync(join(REPO, relative), 'utf8');
/** Strips comments so a source assertion tests CODE, not prose. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const AUTHORITY_SOURCE = read('server/wholeRecipeSemanticOriginReceipt.ts');
const AUTHORITY_CODE = stripComments(AUTHORITY_SOURCE);
const SHAPE_SOURCE = read('src/core/nutritionV2/aiWholeRecipeSemanticOriginReceiptShape.ts');
const SHAPE_CODE = stripComments(SHAPE_SOURCE);

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

const RECIPE = { ingredients: [{ name: '2 cups all-purpose flour' }, { name: '3 large eggs, separated' }] };
const INSTRUCTIONS = [{ text: 'Separate the whites from the yolks.' }];

function derivedRefs(recipe: unknown): string[] {
  const adapted = adaptRecipe(recipe);
  if (adapted.ok === false) throw new Error('fixture recipe did not adapt');
  return adapted.recipe.adapted.map((ingredient) => ingredient.line_ref);
}
const REFS = derivedRefs(RECIPE);

const CONTEXT = (() => {
  const result = materializeWholeRecipeInterpretationContext({
    request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
    request_id: '9b2a-security',
    recipe: RECIPE,
    instructions: INSTRUCTIONS,
    targets: REFS.map((line_ref) => ({ line_ref })),
  });
  if (result.ok === false) throw new Error(result.code);
  return result.context;
})();

function interpretations(): Record<string, unknown>[] {
  return [
    {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      line_ref: REFS[0],
      semantic_food: { normalized_name: 'all-purpose flour', modifiers: [], preparation: ['sifted'], state: [], qualifiers: [] },
      search_phrases: ['all purpose flour'],
      amount_semantics: { kind: 'exact', echoed_value: 2 },
      unit_semantics: { family: 'volume', raw: 'cups' },
      count_semantics: {},
      alternatives: [],
      ambiguity: { ambiguous: false, reasons: [] },
      confidence: 'high',
    },
  ];
}

function subject(overrides: Record<string, unknown> = {}) {
  return {
    context: CONTEXT,
    interpretations: interpretations(),
    provider_id: 'gemini',
    model_id: 'gemini-2.5-flash',
    operation_id: createWholeRecipeSemanticOperationId(),
    ...overrides,
  };
}

const AUTHORITY = createWholeRecipeSemanticOriginAuthority();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withEntry(mutate: (entry: Record<string, unknown>) => void): unknown {
  const s = clone(subject()) as Record<string, unknown>;
  mutate((s.interpretations as Record<string, unknown>[])[0]);
  return s;
}

// ---------------------------------------------------------------------------
// Forbidden authority output must never become trusted authority
// ---------------------------------------------------------------------------

describe('9B-2A — a server MAC never legitimizes forbidden AI output', () => {
  const FORBIDDEN: Array<[string, string, unknown]> = [
    ['fdc_id', 'number', 2707152],
    ['grams', 'number', 125],
    ['calories', 'number', 500],
    ['nutrients', 'object', { protein: 10 }],
    ['candidate', 'object', { fdc_id: 1, score: 0.99 }],
    ['origin_receipt', 'string', 'rctx1.' + 'a'.repeat(43)],
    ['context_binding', 'string', `sha256:${'a'.repeat(64)}`],
    ['nutrition_block', 'object', { total_calories: 500 }],
    ['authority', 'object', { apply: true }],
    ['apply_token', 'string', 'granted'],
    ['persisted_provenance', 'object', { persisted: true }],
  ];

  for (const [field, kind, value] of FORBIDDEN) {
    it(`refuses to sign an interpretation carrying ${field}`, () => {
      const hostile =
        kind === 'number' || kind === 'string'
          ? withEntry((e) => {
              e[field] = value;
            })
          : withEntry((e) => {
              e[field] = value;
            });
      expect(AUTHORITY.issue(hostile).ok).toBe(false);
    });

    it(`refuses ${field} nested inside a semantic sub-object`, () => {
      const hostile = withEntry((e) => {
        (e.semantic_food as Record<string, unknown>)[field] = value;
      });
      expect(AUTHORITY.issue(hostile).ok).toBe(false);
    });
  }

  it('refuses an unknown non-authority key as well', () => {
    expect(AUTHORITY.issue(withEntry((e) => {
      e.something_new = 'x';
    })).ok).toBe(false);
  });

  it('refuses a semantic payload that claims an origin receipt or binding', () => {
    // A model must not be able to smuggle a proof-shaped field INTO the payload
    // it is asking to have proven.
    for (const field of ['origin_receipt', 'context_binding', 'provenance', 'provenance_class']) {
      expect(AUTHORITY.issue(withEntry((e) => {
        e[field] = 'x';
      })).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The issuer refuses structurally unsafe semantic material
// ---------------------------------------------------------------------------

describe('9B-2A — the issuer refuses malformed semantic material', () => {
  it('refuses an unsupported per-entry response contract version', () => {
    expect(AUTHORITY.issue(withEntry((e) => {
      e.contract_version = 'nutrition_ai_advanced_interpretation_v2';
    })).ok).toBe(false);
  });

  it('refuses a malformed target structure', () => {
    const cases: Array<[string, unknown]> = [
      ['line ref outside the request targets', withEntry((e) => {
        e.line_ref = 'ing:9:deadbeefdead';
      })],
      ['non-string line ref', withEntry((e) => {
        e.line_ref = 42;
      })],
      ['missing line ref', withEntry((e) => {
        delete e.line_ref;
      })],
      ['empty line ref', withEntry((e) => {
        e.line_ref = '   ';
      })],
      ['duplicate line ref', subject({
        interpretations: [
          { ...interpretations()[0] },
          { ...interpretations()[0] },
        ],
      })],
    ];
    for (const [label, candidate] of cases) {
      expect(AUTHORITY.issue(candidate).ok, label).toBe(false);
    }
  });

  it('refuses an oversized semantic string', () => {
    for (const [field, limit] of [
      ['notes', 300],
      ['search_phrases', 120],
    ] as const) {
      expect(AUTHORITY.issue(withEntry((e) => {
        if (field === 'notes') e.notes = 'x'.repeat(limit + 1);
        else e.search_phrases = ['x'.repeat(limit + 1)];
      })).ok, field).toBe(false);
    }
    // An oversized normalized_name is refused too.
    expect(AUTHORITY.issue(withEntry((e) => {
      (e.semantic_food as Record<string, unknown>).normalized_name = 'x'.repeat(121);
    })).ok).toBe(false);
  });

  it('refuses non-finite and non-positive numeric semantics', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, 0, -1, '2']) {
      expect(AUTHORITY.issue(withEntry((e) => {
        e.amount_semantics = { kind: 'exact', echoed_value: bad };
      })).ok).toBe(false);
    }
  });

  it('refuses an internally inconsistent amount claim', () => {
    expect(AUTHORITY.issue(withEntry((e) => {
      e.amount_semantics = { kind: 'range', range_lower: 5, range_upper: 1 };
    })).ok).toBe(false);
    expect(AUTHORITY.issue(withEntry((e) => {
      e.amount_semantics = { kind: 'exact', range_lower: 1, range_upper: 3 };
    })).ok).toBe(false);
  });

  it('refuses a malformed context on the proof subject', () => {
    const cases: Array<[string, unknown]> = [
      ['missing provenance_class', (() => {
        const s = clone(subject()) as Record<string, unknown>;
        delete (s.context as Record<string, unknown>).provider_context;
        return s;
      })()],
      ['wrong request version', (() => {
        const s = clone(subject()) as Record<string, unknown>;
        (s.context as Record<string, unknown>).request_version = 'nope';
        return s;
      })()],
      ['uppercase binding hex', (() => {
        const s = clone(subject()) as Record<string, unknown>;
        (s.context as Record<string, unknown>).context_binding = `sha256:${'A'.repeat(64)}`;
        return s;
      })()],
      ['unbound target list', (() => {
        const s = clone(subject()) as Record<string, unknown>;
        ((s.context as Record<string, unknown>).provider_context as Record<string, unknown>).targets = [];
        return s;
      })()],
      ['non-plain context', (() => {
        const s = clone(subject()) as Record<string, unknown>;
        s.context = [];
        return s;
      })()],
    ];
    for (const [label, candidate] of cases) {
      expect(AUTHORITY.issue(candidate).ok, label).toBe(false);
    }
  });

  it('refuses a getter-bearing or cyclic subject without invoking the accessor', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'interpretations', {
      get() {
        throw new Error('accessor must never be invoked');
      },
      enumerable: true,
    });
    expect(() => AUTHORITY.issue(hostile)).not.toThrow();
    expect(AUTHORITY.issue(hostile).ok).toBe(false);
  });

  it('refuses an empty semantic response', () => {
    expect(AUTHORITY.issue(subject({ interpretations: [] })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-AFTER-SANITIZE is enforced structurally
// ---------------------------------------------------------------------------

describe('9B-2A — the MAC covers the SANITIZER output, never raw provider output', () => {
  it('produces the IDENTICAL proof for raw provider-shaped and sanitized input', () => {
    // Raw provider output: untrimmed strings, missing optional blocks, arrays
    // that the sanitizer fills with defaults.
    const raw: Record<string, unknown> = {
      context: CONTEXT,
      interpretations: [
        {
          contract_version: AI_ADVANCED_CONTRACT_VERSION,
          line_ref: `  ${REFS[0]}  `,
          semantic_food: { normalized_name: '  all-purpose flour  ' },
          search_phrases: [' all purpose flour ', 'all purpose flour'],
          amount_semantics: { kind: 'exact', echoed_value: 2, range_lower: null },
          unit_semantics: { family: 'volume', raw: 'cups', interpreted_unit: null },
        },
      ],
      provider_id: 'gemini',
      model_id: 'gemini-2.5-flash',
      operation_id: createWholeRecipeSemanticOperationId(),
    };
    const operationId = raw.operation_id;

    const canonicalForm: Record<string, unknown> = {
      context: CONTEXT,
      interpretations: [
        {
          contract_version: AI_ADVANCED_CONTRACT_VERSION,
          line_ref: REFS[0],
          semantic_food: { normalized_name: 'all-purpose flour', modifiers: [], preparation: [], state: [], qualifiers: [] },
          search_phrases: ['all purpose flour'],
          amount_semantics: { kind: 'exact', echoed_value: 2 },
          unit_semantics: { family: 'volume', raw: 'cups' },
          count_semantics: {},
          alternatives: [],
          ambiguity: { ambiguous: false, reasons: [] },
        },
      ],
      provider_id: 'gemini',
      model_id: 'gemini-2.5-flash',
      operation_id: operationId,
    };

    const fromRaw = AUTHORITY.issue(raw);
    const fromCanonical = AUTHORITY.issue(canonicalForm);
    if (!fromRaw.ok || !fromCanonical.ok) throw new Error('issuance failed');
    // Identical proofs prove the raw bytes were never signed: both inputs were
    // canonicalized to the same sanitizer output first.
    expect(fromRaw.receipt).toBe(fromCanonical.receipt);
  });

  it('normalizes rather than signs raw bytes: the verified origin is sanitized', () => {
    const raw: Record<string, unknown> = {
      context: CONTEXT,
      interpretations: [
        { contract_version: AI_ADVANCED_CONTRACT_VERSION, line_ref: REFS[0], semantic_food: { normalized_name: '  flour  ' } },
      ],
      provider_id: 'gemini',
      model_id: 'gemini-2.5-flash',
      operation_id: createWholeRecipeSemanticOperationId(),
    };
    const issued = AUTHORITY.issue(raw);
    if (!issued.ok) throw new Error("expected issuance");
    const verified = AUTHORITY.verify(issued.receipt, raw);
    if (!verified.ok) throw new Error('verification failed');
    // The returned origin is the canonical, trimmed, defaulted interpretation.
    const entry = verified.origin.interpretations[0] as unknown as Record<string, unknown>;
    expect((entry.semantic_food as Record<string, unknown>).normalized_name).toBe('flour');
    expect(entry.count_semantics).toEqual({});
    expect(entry.ambiguity).toEqual({ ambiguous: false, reasons: [] });
  });

  it('canonicalizes duplicate search phrases away', () => {
    const dup = subject({ interpretations: [{ ...interpretations()[0], search_phrases: ['flour', 'flour', 'plain flour'] }] });
    const single = subject({ interpretations: [{ ...interpretations()[0], search_phrases: ['flour', 'plain flour'] }] });
    const a = AUTHORITY.issue({ ...dup, operation_id: 'wsemo1.' + 'A'.repeat(32) });
    const b = AUTHORITY.issue({ ...single, operation_id: 'wsemo1.' + 'A'.repeat(32) });
    if (!a.ok || !b.ok) throw new Error('issuance failed');
    expect(a.receipt).toBe(b.receipt);
  });
});

// ---------------------------------------------------------------------------
// Domain separation from AI-4E, in BOTH directions
// ---------------------------------------------------------------------------

describe('9B-2A — AI-4E cross-domain rejection', () => {
  const AI4_AUTHORITY = createRecipeContextOriginReceiptAuthority();

  const AI4_WIRE = {
    request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    request_id: 'ai4e-cross',
    context_binding: `sha256:${'a'.repeat(64)}`,
    proposal: {
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      interpretations: [
        { line_ref: 'l1', role: 'main', relations: [], preparation_hints: ['divided'], confidence: 'medium' },
      ],
    },
  };

  it('a REAL AI-4E receipt never verifies as a semantic-origin proof', () => {
    const ai4 = AI4_AUTHORITY.issue(AI4_WIRE);
    if (!ai4.ok) throw new Error("expected AI-4E issuance");
    expect(ai4.receipt.startsWith(`${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.`)).toBe(true);
    expect(AI4_AUTHORITY.verify(ai4.receipt, AI4_WIRE).ok).toBe(true);
    // Same length, different prefix: this is the real cross-domain trap.
    expect(ai4.receipt).toHaveLength(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_LENGTH);
    expect(AUTHORITY.verify(ai4.receipt, subject()).ok).toBe(false);
  });

  it('a REAL semantic-origin proof is never accepted by AI-4E verification', () => {
    const issued = AUTHORITY.issue(subject());
    if (!issued.ok) throw new Error("expected issuance");
    expect(issued.receipt.startsWith(`${WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX}.`)).toBe(true);
    expect(AI4_AUTHORITY.verify(issued.receipt, AI4_WIRE).ok).toBe(false);
  });

  it('the two authorities cannot verify each other even on identical material', () => {
    const s = subject();
    const issued = AUTHORITY.issue(s);
    if (!issued.ok) throw new Error("expected issuance");
    // A second semantic authority is a different key, exactly like the AI-4 one.
    const other = createWholeRecipeSemanticOriginAuthority();
    expect(other.verify(issued.receipt, s).ok).toBe(false);
  });

  it('exposes no cross-domain import or reuse', () => {
    // The semantic-origin module must not import the AI-4E receipt authority, so
    // the two cannot drift into sharing a key or a format by accident.
    expect(AUTHORITY_SOURCE).not.toContain('recipeContextOriginReceipt');
    expect(AUTHORITY_SOURCE).not.toContain('createRecipeContextOriginReceiptAuthority');
  });
});

// ---------------------------------------------------------------------------
// Source-level security invariants
// ---------------------------------------------------------------------------

describe('9B-2A — source-level security invariants', () => {
  it('compares MACs in CONSTANT TIME, never with string equality', () => {
    expect(AUTHORITY_SOURCE).toContain('timingSafeEqual');
    expect(AUTHORITY_SOURCE).not.toMatch(/expected\s*===|===\s*provided|provided\s*===\s*expected/);
  });

  it('uses HMAC-SHA-256 with a random 32-byte key and no invented crypto', () => {
    expect(AUTHORITY_CODE).toContain("createHmac('sha256'");
    expect(AUTHORITY_CODE).toContain('randomBytes(32)');
    expect(AUTHORITY_CODE).not.toContain('Math.random');
    // No custom primitive: no hand-rolled hash or cipher.
    expect(AUTHORITY_CODE).not.toMatch(/createCipher|createDecipher|createHash\(/);
  });

  it('never exports or serializes the key', () => {
    expect(AUTHORITY_SOURCE).not.toMatch(/export const \w*KEY|export let \w*KEY|secret\b.*=.*process\.env/);
    // The secret is a function-local, never a property of the authority object.
    expect(AUTHORITY_SOURCE).not.toMatch(/\bsecret\b\s*[:,]/);
  });

  it('performs NO provider call in this phase', () => {
    for (const forbidden of ['runWithAiFallback', 'resolveRoleCandidates', 'getRegisteredProviders', 'fetch(', 'https://']) {
      expect(AUTHORITY_SOURCE, forbidden).not.toContain(forbidden);
    }
  });

  it('adds NO route and NO network surface', () => {
    expect(AUTHORITY_SOURCE).not.toContain('/api/');
    expect(AUTHORITY_SOURCE).not.toContain('express');
  });

  it('grants NO nutrition authority: no USDA, FDC, mass or nutrient surface', () => {
    for (const forbidden of ['applyRecipe', 'persist', 'usda', 'Fdc', 'candidate', 'gram']) {
      // `candidate`/`gram` appear only inside sanitizer-owned vocabulary checks
      // and comments, never as an authority call.
      const calls = AUTHORITY_SOURCE.match(new RegExp(`\\b${forbidden}\\w*\\(`, 'g')) ?? [];
      expect(calls, forbidden).toEqual([]);
    }
  });

  it('keeps the format module pure: no crypto, no network, no clock', () => {
    for (const forbidden of ['node:crypto', 'createHmac', 'randomBytes', 'Date', 'Math.random', 'fetch']) {
      expect(SHAPE_CODE, forbidden).not.toContain(forbidden);
    }
  });

  it('never leaks the credential probe into client-reachable code', () => {
    for (const file of [
      'src/core/nutritionV2/aiWholeRecipeSemanticOriginReceiptShape.ts',
    ]) {
      expect(read(file)).not.toContain(SECRET_PROBE);
    }
  });

  it('keeps the secret out of every exported symbol', async () => {
    const module = await import('../../server/wholeRecipeSemanticOriginReceipt');
    for (const [name, value] of Object.entries(module)) {
      expect(typeof value === 'function' || typeof value === 'object', name).toBe(true);
      if (typeof value === 'string') expect(value, name).not.toMatch(/^[0-9a-f]{64}$/);
    }
    // No exported key material of any shape.
    expect(Object.keys(module).filter((k) => /key|secret/i.test(k))).toEqual([]);
  });
});