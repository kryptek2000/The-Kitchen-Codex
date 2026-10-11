/**
 * The Kitchen Codex — Advanced Nutrition Phase 9B-2A.
 * WHOLE-RECIPE SEMANTIC-ORIGIN PROOF: core proof, binding coverage, tamper matrix.
 *
 * This is the load-bearing file for the 9B-2A primitive. It proves, as code:
 *
 *   - a proof is issued ONLY for a canonical sanitized semantic response, and
 *     never for a malformed, forbidden or non-canonical one;
 *   - the MAC covers request version, EFFECTIVE request id, context binding, the
 *     COMPLETE canonical semantic response, provider, model and operation id, so
 *     changing ANY of them breaks the proof (the full tampering matrix);
 *   - a proof for one request never authenticates another, and never another
 *     context, provider, model or server operation;
 *   - the security boundary is a CONSTANT-TIME comparison, not string equality;
 *   - the same exact proof over the same exact material verifies REPEATEDLY by
 *     design: there is no TTL, no nonce and no replay cache;
 *   - a NEW authority (the server-restart / second-instance case) cannot verify an
 *     old proof, and an AI-4E receipt is not accepted in this domain.
 *
 * It deliberately does NOT test nutrition authority: this primitive grants none.
 * See `advancedNutritionPhase9b2aSemanticOriginSecurity.test.ts` for the
 * unsafe-signing-refusal and cross-domain matrix.
 */
import { describe, it, expect } from 'vitest';

import {
  createWholeRecipeSemanticOperationId,
  createWholeRecipeSemanticOriginAuthority,
  type CanonicalWholeRecipeSemanticOrigin,
  type WholeRecipeSemanticOriginAuthority,
} from '../../server/wholeRecipeSemanticOriginReceipt';
import {
  isWholeRecipeSemanticOperationIdShaped,
  isWholeRecipeSemanticOriginReceiptShaped,
  WHOLE_RECIPE_SEMANTIC_OPERATION_ID_LENGTH,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_LENGTH,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_BYTES,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_CHARS,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX,
  WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_VERSION,
} from '../../src/core/nutritionV2/aiWholeRecipeSemanticOriginReceiptShape';
import { AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX } from '../../src/core/nutritionV2/aiRecipeContextOriginReceiptShape';
import { AI_ADVANCED_CONTRACT_VERSION } from '../../src/core/nutritionV2/aiAdvanced';
import { WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION } from '../../src/core/nutritionV2/aiWholeRecipeInterpretation';
import { adaptRecipe } from '../../src/core/nutritionV2/phase4/adapt';
import { materializeWholeRecipeInterpretationContext } from '../../server/wholeRecipeInterpretRequest';

// ---------------------------------------------------------------------------
// FIXTURES — a REAL 9B-1 derived context, never a hand-forged binding
// ---------------------------------------------------------------------------

const RECIPE = {
  ingredients: [{ name: '2 cups all-purpose flour' }, { name: '3 large eggs, separated' }],
};
const INSTRUCTIONS = [{ text: 'Separate the whites from the yolks.' }];

function derivedRefs(recipe: unknown): string[] {
  const adapted = adaptRecipe(recipe);
  if (adapted.ok === false) throw new Error('fixture recipe did not adapt');
  return adapted.recipe.adapted.map((ingredient) => ingredient.line_ref);
}

const REFS = derivedRefs(RECIPE);

function realContext(overrides: Record<string, unknown> = {}) {
  const result = materializeWholeRecipeInterpretationContext({
    request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
    request_id: '9b2a-unit',
    recipe: RECIPE,
    instructions: INSTRUCTIONS,
    targets: REFS.map((line_ref) => ({ line_ref })),
    ...overrides,
  });
  if (result.ok === false) throw new Error(`fixture did not materialize: ${result.code}`);
  return result.context;
}

const CONTEXT = realContext();

/** A realistic, fully populated canonical sanitized semantic response. */
function interpretations(): Record<string, unknown>[] {
  return [
    {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      line_ref: REFS[0],
      semantic_food: {
        normalized_name: 'all-purpose flour',
        modifiers: ['unbleached'],
        preparation: ['sifted'],
        state: [],
        qualifiers: ['dry'],
      },
      search_phrases: ['all purpose flour', 'plain flour'],
      amount_semantics: { kind: 'range', range_lower: 1, range_upper: 3, phrasing: 'a couple of cups' },
      unit_semantics: { family: 'volume', raw: 'cups', interpreted_unit: 'cup' },
      count_semantics: { noun: 'cup' },
      alternatives: [{ normalized_name: 'bread flour', notes: 'closer gluten structure' }],
      ambiguity: { ambiguous: true, reasons: ['plain vs self-rising'] },
      confidence: 'high',
      notes: 'model observation only',
    },
    {
      contract_version: AI_ADVANCED_CONTRACT_VERSION,
      line_ref: REFS[1],
      semantic_food: {
        modifiers: [],
        preparation: ['separated'],
        state: ['raw'],
        qualifiers: ['whole'],
      },
      search_phrases: ['whole egg'],
      amount_semantics: { kind: 'exact', echoed_value: 3 },
      unit_semantics: { family: 'count', raw: 'large' },
      count_semantics: { noun: 'egg', size: 'large', state: 'raw' },
      alternatives: [],
      ambiguity: { ambiguous: false, reasons: [] },
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

function issue(s: unknown): string {
  const result = AUTHORITY.issue(s);
  if (!result.ok) throw new Error("expected issuance, got invalid_subject");
  return result.receipt;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mutates(base: Record<string, unknown>, mutate: (s: Record<string, unknown>) => void) {
  const copy = deepClone(base) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

// ---------------------------------------------------------------------------
// Proof contract identity
// ---------------------------------------------------------------------------

describe('9B-2A — the proof contract is DISTINCT from AI-4E', () => {
  it('has its own closed version identity', () => {
    expect(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_VERSION).toBe(
      'nutrition_ai_whole_recipe_semantic_origin_receipt_v1'
    );
  });

  it('uses a token prefix distinct from the AI-4E receipt prefix', () => {
    expect(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX).toBe('wsem1');
    expect(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_PREFIX).not.toBe(
      AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX
    );
  });

  it('has a fixed, unbufferable token width', () => {
    expect(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_BYTES).toBe(32);
    expect(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_MAC_CHARS).toBe(43);
    expect(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_LENGTH).toBe(49);
  });

  it('bounds the token before any cryptographic work', () => {
    expect(isWholeRecipeSemanticOriginReceiptShaped('wsem1.' + 'a'.repeat(43))).toBe(true);
    expect(isWholeRecipeSemanticOriginReceiptShaped('wsem1.' + 'a'.repeat(42))).toBe(false);
    expect(isWholeRecipeSemanticOriginReceiptShaped('wsem1.' + 'a'.repeat(44))).toBe(false);
    expect(isWholeRecipeSemanticOriginReceiptShaped('rctx1.' + 'a'.repeat(43))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Core proof
// ---------------------------------------------------------------------------

describe('9B-2A — issue then verify', () => {
  it('issues a bounded, opaque proof and verifies it', () => {
    const s = subject();
    const receipt = issue(s);
    expect(receipt.startsWith('wsem1.')).toBe(true);
    expect(receipt).toHaveLength(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_LENGTH);
    expect(isWholeRecipeSemanticOriginReceiptShaped(receipt)).toBe(true);

    const verified = AUTHORITY.verify(receipt, s);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      // The canonical origin is returned, never the caller's raw object.
      expect(verified.origin.request_id).toBe('9b2a-unit');
      expect(verified.origin.contract_version).toBe(AI_ADVANCED_CONTRACT_VERSION);
      expect(verified.origin.interpretations).toHaveLength(2);
    }
  });

  it('carries no payload, identity or key material in the token', () => {
    const receipt = issue(subject());
    // An opaque MAC must leak none of the authenticated material.
    expect(receipt).not.toContain('9b2a-unit');
    expect(receipt).not.toContain('gemini');
    expect(receipt).not.toContain('all-purpose');
    expect(receipt).not.toContain('wsemo1');
    expect(receipt).not.toContain('sha256');
  });

  it('counts issuances for diagnostics without exposing the key', () => {
    const authority = createWholeRecipeSemanticOriginAuthority();
    expect(authority.issuedCount).toBe(0);
    authority.issue(subject());
    expect(authority.issuedCount).toBe(1);
    expect(Object.keys(authority)).toEqual(['issue', 'verify', 'issuedCount']);
  });

  it('is deterministic: identical material yields an identical proof', () => {
    const s = subject();
    const other = createWholeRecipeSemanticOriginAuthority();
    // Same authority, same material -> same MAC.
    expect(issue(s)).toBe(issue(s));
    // Different authority, same material -> different key, different MAC.
    expect(other.issue(s).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Same-material replay is allowed by design
// ---------------------------------------------------------------------------

describe('9B-2A — replay posture: same material replays, anything else does not', () => {
  it('verifies the SAME proof over the SAME material repeatedly (no TTL, no nonce)', () => {
    const s = subject();
    const receipt = issue(s);
    expect(AUTHORITY.verify(receipt, s).ok).toBe(true);
    expect(AUTHORITY.verify(receipt, s).ok).toBe(true);
    expect(AUTHORITY.verify(receipt, s).ok).toBe(true);
  });

  it('accepts an equivalent but structurally different caller object', () => {
    // Canonicalization, not object identity, decides: re-serialization and
    // key reordering must not change the authenticated material.
    const s = subject();
    const receipt = issue(s);
    const reshuffled = {
      operation_id: s.operation_id,
      model_id: s.model_id,
      provider_id: s.provider_id,
      interpretations: deepClone(s.interpretations),
      context: s.context,
    };
    expect(AUTHORITY.verify(receipt, reshuffled).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-component failures
// ---------------------------------------------------------------------------

describe('9B-2A — every authenticated component is load-bearing', () => {
  const base = subject();
  const receipt = issue(base);

  const cases: Array<[string, Record<string, unknown>]> = [
    ['effective request id', mutates(base, (s) => { (s.context as Record<string, unknown>).request_id = 'other'; })],
    ['context binding', mutates(base, (s) => { (s.context as Record<string, unknown>).context_binding = `sha256:${'b'.repeat(64)}`; })],
    ['request version', mutates(base, (s) => { (s.context as Record<string, unknown>).request_version = 'nutrition_ai_whole_recipe_interpretation_request_v2'; })],
    ['provider id', mutates(base, (s) => { s.provider_id = 'openrouter'; })],
    ['model id', mutates(base, (s) => { s.model_id = 'gemini-2.5-pro'; })],
    ['operation id', mutates(base, (s) => { s.operation_id = createWholeRecipeSemanticOperationId(); })],
    ['the whole semantic payload', mutates(base, (s) => { s.interpretations = []; })],
  ];

  for (const [label, candidate] of cases) {
    it(`fails when the ${label} changes`, () => {
      expect(AUTHORITY.verify(receipt, candidate).ok).toBe(false);
    });
  }

  it('fails under a different signing key (new authority / restart)', () => {
    const other = createWholeRecipeSemanticOriginAuthority();
    expect(other.verify(receipt, base).ok).toBe(false);
  });

  it('fails when the context binding is malformed rather than merely different', () => {
    for (const binding of ['sha256:short', 'not-a-binding', '', 'sha256:' + 'Z'.repeat(64)]) {
      const candidate = mutates(base, (s) => {
        (s.context as Record<string, unknown>).context_binding = binding;
      });
      expect(AUTHORITY.verify(receipt, candidate).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Semantic tampering matrix — one field at a time
// ---------------------------------------------------------------------------

describe('9B-2A — semantic tampering matrix', () => {
  const base = subject();
  const receipt = issue(base);
  const entry = 0;

  const mutations: Array<[string, (first: Record<string, unknown>) => void]> = [
    ['normalized_name', (e) => { (e.semantic_food as Record<string, unknown>).normalized_name = 'bread flour'; }],
    ['adding normalized_name where absent', (e) => { e.semantic_food = { normalized_name: 'x', modifiers: [], preparation: [], state: [], qualifiers: [] }; }],
    ['modifiers', (e) => { (e.semantic_food as Record<string, unknown>).modifiers = ['bleached']; }],
    ['preparation', (e) => { (e.semantic_food as Record<string, unknown>).preparation = ['unsifted']; }],
    ['state', (e) => { (e.semantic_food as Record<string, unknown>).state = ['toasted']; }],
    ['qualifiers', (e) => { (e.semantic_food as Record<string, unknown>).qualifiers = ['refined']; }],
    ['first search phrase', (e) => { (e.search_phrases as string[])[0] = 'bread flour'; }],
    ['search phrase count', (e) => { (e.search_phrases as string[]).push('strong white flour'); }],
    ['amount kind', (e) => { (e.amount_semantics as Record<string, unknown>).kind = 'approximate'; }],
    ['amount range lower', (e) => { (e.amount_semantics as Record<string, unknown>).range_lower = 2; }],
    ['amount range upper', (e) => { (e.amount_semantics as Record<string, unknown>).range_upper = 4; }],
    ['amount phrasing', (e) => { (e.amount_semantics as Record<string, unknown>).phrasing = 'a cup or so'; }],
    ['unit family', (e) => { (e.unit_semantics as Record<string, unknown>).family = 'mass'; }],
    ['unit raw', (e) => { (e.unit_semantics as Record<string, unknown>).raw = 'tablespoons'; }],
    ['unit interpreted_unit', (e) => { (e.unit_semantics as Record<string, unknown>).interpreted_unit = 'tbsp'; }],
    ['count noun', (e) => { (e.count_semantics as Record<string, unknown>).noun = 'tablespoon'; }],
    ['alternative normalized_name', (e) => { ((e.alternatives as Record<string, unknown>[])[0]).normalized_name = 'cake flour'; }],
    ['alternative notes', (e) => { ((e.alternatives as Record<string, unknown>[])[0]).notes = 'edited'; }],
    ['dropping an alternative', (e) => { e.alternatives = []; }],
    ['ambiguity flag', (e) => { (e.ambiguity as Record<string, unknown>).ambiguous = false; }],
    ['ambiguity reasons', (e) => { (e.ambiguity as Record<string, unknown>).reasons = ['single reason']; }],
    ['confidence', (e) => { e.confidence = 'low'; }],
    ['dropping confidence', (e) => { delete e.confidence; }],
    ['notes', (e) => { e.notes = 'edited observation'; }],
    ['dropping notes', (e) => { delete e.notes; }],
    ['line ref', (e) => { e.line_ref = REFS[1]; }],
  ];

  for (const [label, mutate] of mutations) {
    it(`fails when ${label} is tampered`, () => {
      const candidate = mutates(base, (s) => {
        mutate((s.interpretations as Record<string, unknown>[])[entry]);
      });
      expect(AUTHORITY.verify(receipt, candidate).ok).toBe(false);
    });
  }

  it('authenticates response ORDER: reordering interpretations breaks the proof', () => {
    const reordered = mutates(base, (s) => {
      (s.interpretations as unknown[]).reverse();
    });
    expect(AUTHORITY.verify(receipt, reordered).ok).toBe(false);
  });

  it('fails when a second interpretation is appended', () => {
    const candidate = mutates(base, (s) => {
      const list = s.interpretations as Record<string, unknown>[];
      list.push(deepClone(list[1]));
      list[2].line_ref = REFS[0];
    });
    expect(AUTHORITY.verify(receipt, candidate).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed receipts
// ---------------------------------------------------------------------------

describe('9B-2A — malformed receipts fail closed without leaking', () => {
  const base = subject();
  const receipt = issue(base);

  const malformed: Array<[string, unknown]> = [
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['non-string', 12345],
    ['object', { receipt: 'wsem1.' + 'a'.repeat(43) }],
    ['array', ['wsem1.' + 'a'.repeat(43)]],
    ['wrong prefix', 'wsem0.' + receipt.slice(6)],
    ['AI-4E receipt', 'rctx1.' + 'a'.repeat(43)],
    ['no separator', 'wsem1' + 'a'.repeat(43)],
    ['double separator', 'wsem1..' + 'a'.repeat(43)],
    ['truncated', receipt.slice(0, -1)],
    ['oversized', receipt + 'a'],
    ['padded base64', 'wsem1.' + '='.repeat(43)],
    ['standard-base64 alphabet', 'wsem1.' + 'a'.repeat(42) + '+'],
    ['leading whitespace', ` ${receipt}`],
    ['trailing whitespace', `${receipt} `],
    ['embedded newline', receipt.slice(0, 10) + '\n' + receipt.slice(10)],
    ['unicode lookalike separator', 'wsem1․' + 'a'.repeat(43)],
    ['unicode lookalike chars', 'wsem1.' + 'ａ'.repeat(43)],
    ['random valid-length bytes', 'wsem1.' + 'A'.repeat(43)],
    ['receipt from another material', issue({ ...base, model_id: 'other-model' })],
  ];

  for (const [label, candidate] of malformed) {
    it(`rejects ${label}`, () => {
      let result: unknown;
      expect(() => {
        result = AUTHORITY.verify(candidate, base);
      }).not.toThrow();
      expect((result as { ok: boolean }).ok).toBe(false);
    });
  }

  it('never leaks a MAC, secret or raw parser detail on failure', () => {
    const failed = AUTHORITY.verify('wsem1.' + 'A'.repeat(43), base);
    expect(JSON.stringify(failed)).toBe('{"ok":false}');
    expect(Object.keys(failed)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// Operation id
// ---------------------------------------------------------------------------

describe('9B-2A — server-owned semantic operation id', () => {
  it('mints distinct opaque ids', () => {
    const ids = new Set(Array.from({ length: 64 }, () => createWholeRecipeSemanticOperationId()));
    expect(ids.size).toBe(64);
  });

  it('uses a strict, bounded, opaque format', () => {
    const id = createWholeRecipeSemanticOperationId();
    expect(id).toHaveLength(WHOLE_RECIPE_SEMANTIC_OPERATION_ID_LENGTH);
    expect(id.startsWith('wsemo1.')).toBe(true);
    expect(id).toMatch(/^wsemo1\.[A-Za-z0-9_-]{32}$/);
  });

  it('embeds no user, provider, credential or timestamp data', () => {
    const id = createWholeRecipeSemanticOperationId();
    expect(id).not.toContain('gemini');
    expect(id).not.toContain('sk-');
    expect(id).not.toContain(String(new Date().getFullYear()));
  });

  it('is shape-checked before anything is signed', () => {
    const base = subject();
    for (const bad of ['', 'wsemo1.', 'wsemo1.short', 'wsemo2.' + 'a'.repeat(32), 'wsemo1.' + 'a'.repeat(31), 'wsemo1.' + 'a'.repeat(33), null, 42]) {
      expect(AUTHORITY.issue({ ...base, operation_id: bad }).ok).toBe(false);
    }
    expect(isWholeRecipeSemanticOperationIdShaped(createWholeRecipeSemanticOperationId())).toBe(true);
    expect(isWholeRecipeSemanticOperationIdShaped('wsemo1.short')).toBe(false);
  });

  it('changing the operation id invalidates an existing proof', () => {
    const s = subject();
    const receipt = issue(s);
    const swapped = { ...s, operation_id: createWholeRecipeSemanticOperationId() };
    expect(AUTHORITY.verify(receipt, swapped).ok).toBe(false);
    // A reissued proof for the new operation id is valid.
    expect(AUTHORITY.verify(issue(swapped), swapped).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execution identity bounds
// ---------------------------------------------------------------------------

describe('9B-2A — provider and model identity bounds', () => {
  const base = subject();

  it('accepts realistic provider and model identifiers', () => {
    for (const [provider, model] of [
      ['gemini', 'gemini-2.5-flash'],
      ['openrouter', 'google/gemini-2.5-flash'],
      ['openrouter-image', 'google/gemini-2.5-flash-image:free'],
    ]) {
      expect(AUTHORITY.issue({ ...base, provider_id: provider, model_id: model }).ok).toBe(true);
    }
  });

  it('refuses oversized or unsafe execution identities', () => {
    for (const bad of ['', ' ', 'gem ini', 'gemini\n', 'a'.repeat(121), 'gemini;drop', '<script>']) {
      expect(AUTHORITY.issue({ ...base, provider_id: bad }).ok).toBe(false);
      expect(AUTHORITY.issue({ ...base, model_id: bad }).ok).toBe(false);
    }
    expect(AUTHORITY.issue({ ...base, provider_id: 'a'.repeat(120) }).ok).toBe(true);
  });

  it('keeps the authenticated material free of credential FIELDS', () => {
    // Execution identity is bounded by a safe alphabet, but a value that merely
    // LOOKS like a credential still matches that alphabet — so the guarantee is
    // structural, not lexical: no credential-named field is ever bound, and the
    // proof never discloses whatever it authenticated. In the real 9B-2B flow
    // `provider_id`/`model_id` come from the provider run's own result, never
    // from the client.
    const withCredentialFields = { ...base, api_key: 'sk-or-v1-secret', authorization: 'Bearer x' };
    // An unknown top-level subject key is refused outright.
    expect(AUTHORITY.issue(withCredentialFields).ok).toBe(false);

    const s = subject({ provider_id: 'gemini', model_id: 'gemini-2.5-flash' });
    const receipt = issue(s);
    expect(receipt).not.toContain('sk-');
    expect(receipt).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// Effective request id
// ---------------------------------------------------------------------------

describe('9B-2A — the EFFECTIVE request id is what is bound', () => {
  it('binds the server-materialized id when the client omitted one', () => {
    // 9B-1 deterministically materializes `wr1:<count>:<first ref>` when the
    // client supplies no request id. That EFFECTIVE value is what must be bound,
    // so the server can never authenticate "undefined" while downstream code
    // uses a different id.
    const anonymous = materializeWholeRecipeInterpretationContext({
      request_version: WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION,
      recipe: RECIPE,
      instructions: INSTRUCTIONS,
      targets: REFS.map((line_ref) => ({ line_ref })),
    });
    if (anonymous.ok === false) throw new Error(anonymous.code);
    expect(anonymous.context.request_id).toMatch(/^wr1:/);

    const s = { ...subject(), context: anonymous.context };
    const receipt = issue(s);
    expect(AUTHORITY.verify(receipt, s).ok).toBe(true);

    const forged = mutates(s, (c) => { (c.context as Record<string, unknown>).request_id = 'client-chosen'; });
    expect(AUTHORITY.verify(receipt, forged).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Currentness is the released binding's job, not the receipt's
// ---------------------------------------------------------------------------

describe('9B-2A — the context binding remains the currentness anchor', () => {
  it('invalidates the proof when a model-visible input changes', () => {
    // Changing the authored quantity changes what the model is shown, which
    // changes the released `context_binding` — and therefore invalidates every
    // proof bound to the old binding. Currentness is the binding's job.
    const bumped = { ingredients: [{ name: '5 cups all-purpose flour' }, { name: '3 large eggs, separated' }] };
    const changed = realContext({
      recipe: bumped,
      targets: derivedRefs(bumped).map((line_ref) => ({ line_ref })),
    });
    const original = realContext();
    expect(changed.context_binding).not.toBe(original.context_binding);
    expect(AUTHORITY.verify(issue(subject({ context: original })), subject({ context: changed })).ok).toBe(false);
  });

  it('does NOT reintroduce recipe currentness into the proof module', () => {
    // The receipt authenticates a binding string; it never re-derives one.
    const base = subject();
    const receipt = issue(base);
    const stale = mutates(base, (s) => { (s.context as Record<string, unknown>).context_binding = `sha256:${'c'.repeat(64)}`; });
    expect(AUTHORITY.verify(receipt, stale).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verifier hygiene
// ---------------------------------------------------------------------------

describe('9B-2A — the verifier never throws on hostile material', () => {
  const receipt = issue(subject());

  const hostile: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['string', 'nope'],
    ['number', 7],
    ['array', []],
    ['array of arrays', [[]]],
    ['plain object', {}],
    ['prototype-pollution keys', JSON.parse('{"__proto__": {"x": 1}, "context": 1}')],
    ['constructor key', { constructor: 'x' }],
    ['deeply nested', nested(64)],
    ['huge string', { context: 'x'.repeat(1_000_000) }],
    ['cyclic', cyclic()],
    ['symbol-keyed', symbolKeyed()],
    ['getter-bearing', getterBearing()],
  ];

  for (const [label, candidate] of hostile) {
    it(`fails safely on ${label}`, () => {
      let result: unknown;
      expect(() => {
        result = AUTHORITY.verify(receipt, candidate);
      }).not.toThrow();
      expect((result as { ok: boolean }).ok).toBe(false);
    });

    it(`refuses to issue for ${label}`, () => {
      let result: { ok: boolean } | undefined;
      expect(() => {
        result = AUTHORITY.issue(candidate);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
    });
  }

  it('reports a bounded code and never a raw error for hostile material', () => {
    const result = AUTHORITY.issue(cyclic());
    expect(result).toEqual({ ok: false, code: 'invalid_subject' });
  });
});

function nested(depth: number): unknown {
  let node: Record<string, unknown> = {};
  for (let i = 0; i < depth; i += 1) node = { context: node };
  return node;
}

function cyclic(): Record<string, unknown> {
  const node: Record<string, unknown> = { context: 'x' };
  node['self'] = node;
  return node;
}

function symbolKeyed(): Record<string, unknown> {
  const node: Record<string, unknown> = { context: 'x' };
  Object.defineProperty(node, Symbol('s'), { value: 1, enumerable: true });
  return node;
}

function getterBearing(): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  Object.defineProperty(node, 'context', {
    // An accessor must be REFUSED, never invoked on the signing path.
    get() {
      throw new Error('accessor must never be invoked');
    },
    enumerable: true,
  });
  return node;
}

// ---------------------------------------------------------------------------
// Cross-instance truth
// ---------------------------------------------------------------------------

describe('9B-2A — process-local key truth', () => {
  it('a receipt from authority A never verifies under authority B', () => {
    const a: WholeRecipeSemanticOriginAuthority = createWholeRecipeSemanticOriginAuthority();
    const b: WholeRecipeSemanticOriginAuthority = createWholeRecipeSemanticOriginAuthority();
    const s = subject();
    const issued = a.issue(s);
    if (!issued.ok) throw new Error("expected issuance");
    expect(a.verify(issued.receipt, s).ok).toBe(true);
    expect(b.verify(issued.receipt, s).ok).toBe(false);
  });

  it('two receipts for the same material differ across authorities (independent keys)', () => {
    const s = subject();
    const a = createWholeRecipeSemanticOriginAuthority().issue(s);
    const b = createWholeRecipeSemanticOriginAuthority().issue(s);
    if (!a.ok || !b.ok) throw new Error('issuance failed');
    expect(a.receipt).not.toBe(b.receipt);
  });
});

// ---------------------------------------------------------------------------
// Canonical origin material
// ---------------------------------------------------------------------------

describe('9B-2A — the authenticated material binds exactly the required fields', () => {
  it('exposes the eight required components and nothing credential-shaped', async () => {
    const { wholeRecipeSemanticOriginMaterial } = await import(
      '../../server/wholeRecipeSemanticOriginReceipt'
    );
    const base = subject();
    const receipt = issue(base);
    const verified = AUTHORITY.verify(receipt, base);
    if (!verified.ok) throw new Error('verification failed');

    const material = wholeRecipeSemanticOriginMaterial(
      verified.origin as CanonicalWholeRecipeSemanticOrigin
    ) as Record<string, unknown>;

    expect(Object.keys(material).sort()).toEqual([
      'context_binding',
      'material',
      'model_id',
      'operation_id',
      'provider_id',
      'receipt_version',
      'request_id',
      'request_version',
      'semantic_response',
    ]);
    expect(material['receipt_version']).toBe(WHOLE_RECIPE_SEMANTIC_ORIGIN_RECEIPT_VERSION);
    expect(material['request_version']).toBe(WHOLE_RECIPE_AI_INTERPRETATION_REQUEST_VERSION);
    expect(material['request_id']).toBe('9b2a-unit');
    expect(material['provider_id']).toBe('gemini');
    expect(material['model_id']).toBeDefined();
    expect(material['operation_id']).toBe(base.operation_id);

    const serialized = JSON.stringify(material);
    for (const forbidden of ['api_key', 'apiKey', 'credential', 'token', 'password', 'file_path', 'raw_markdown', 'frontmatter']) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });
});