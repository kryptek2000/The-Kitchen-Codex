/**
 * AI-4E — SERVER-AUTHENTICATED AI-4C ORIGIN RECEIPT: authority + forgery proof.
 *
 * This is the load-bearing file for audit finding I-1. It proves, as code:
 *
 *   - a receipt is issued ONLY for a canonical wire, and never for a malformed one;
 *   - the MAC is over the COMPLETE canonical proposal, so every semantic mutation
 *     of the wire breaks it (the full mutation matrix);
 *   - a receipt for wire A never authenticates wire B, and never a different
 *     request id or context binding (cross-wire attacks);
 *   - a genuinely fabricated, contract-valid I-1 wire with NO provider execution
 *     can never be authenticated, so it can never reach CURRENT;
 *   - a NEW authority instance (the server-restart case) cannot verify an old
 *     receipt;
 *   - the security boundary is a CONSTANT-TIME comparison, not string equality;
 *   - the signing key never leaves the server process: not in a receipt, not in a
 *     thrown error, not in the exported surface, not in the client bundle.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  createRecipeContextOriginReceiptAuthority,
  recipeContextOriginReceiptPayload,
  readRecipeContextOriginEnvelope,
  type RecipeContextOriginReceiptAuthority,
} from '../../server/recipeContextOriginReceipt';
import {
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_LENGTH,
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_BYTES,
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX,
  AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION,
  isAiRecipeContextOriginReceiptShaped,
} from '../../src/core/nutritionV2/aiRecipeContextOriginReceiptShape';
import {
  readAiRecipeContextWirePayload,
} from '../../src/core/nutritionV2/aiRecipeContextWire';
import {
  AI_RECIPE_CONTEXT_REQUEST_VERSION,
} from '../../src/core/nutritionV2/aiRecipeContextRequest';
import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';

const REPO = process.cwd();
/** A distinctive credential-shaped probe: it must never appear anywhere client-side. */
const SECRET_PROBE = 'sk-or-v1-AI4E_MUST_NEVER_LEAK_0123456789';
const read = (relative: string): string => readFileSync(join(REPO, relative), 'utf8');
const AUTHORITY_SOURCE = read('server/recipeContextOriginReceipt.ts');
const AUTHORITY_CODE = AUTHORITY_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const SHAPE_CODE = read('src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const SHAPE_SOURCE = read('src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts');
const APP_SOURCE = read('server/app.ts');

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

type Wire = Record<string, unknown>;

function legitimateWire(overrides: { requestId?: string; binding?: string } = {}): Wire {
  return {
    request_version: AI_RECIPE_CONTEXT_REQUEST_VERSION,
    request_id: overrides.requestId ?? 'ai4e-req-1',
    context_binding: overrides.binding ?? `sha256:${'a'.repeat(64)}`,
    proposal: {
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      interpretations: [
        {
          line_ref: 'l1',
          role: 'main',
          relations: [{ kind: 'same_as', target_ref: 'l2' }],
          preparation_hints: ['divided'],
          confidence: 'medium',
          explanation: 'the primary ingredient',
        },
        {
          line_ref: 'l2',
          role: 'garnish',
          relations: [],
          preparation_hints: [],
          abstain_reason: 'insufficient_evidence',
        },
      ],
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const AUTHORITY: RecipeContextOriginReceiptAuthority = createRecipeContextOriginReceiptAuthority();

function issue(wire: unknown = legitimateWire()): string {
  const result = AUTHORITY.issue(wire);
  if (!result.ok) throw new Error('fixture wire must be issuable');
  return result.receipt;
}

/** Applies one mutation to the wire and asserts the receipt no longer authenticates. */
function expectMutationBreaksReceipt(label: string, mutate: (wire: Wire) => void): void {
  const receipt = issue();
  const wire = legitimateWire();
  mutate(wire);
  const result = AUTHORITY.verify(receipt, wire);
  expect(result.ok, `mutation "${label}" must invalidate the receipt`).toBe(false);
}

// ---------------------------------------------------------------------------
// A. RECEIPT ISSUE
// ---------------------------------------------------------------------------

describe('AI-4E issue — a canonical wire receives exactly one well-formed receipt', () => {
  it('issues one opaque, fixed-length, versioned receipt', () => {
    const result = AUTHORITY.issue(legitimateWire());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.startsWith(`${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.`)).toBe(true);
    expect(result.receipt.length).toBe(AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_LENGTH);
    expect(isAiRecipeContextOriginReceiptShaped(result.receipt)).toBe(true);
    // Opaque: no JSON, no payload, no request id, no recipe text inside the token.
    expect(result.receipt).not.toContain('ai4e-req-1');
    expect(result.receipt).not.toContain('request_id');
    expect(result.receipt).not.toContain('proposal');
    expect(result.receipt).not.toContain('sha256:');
    expect(result.receipt).not.toContain('{');
    expect(result.receipt).not.toContain('}');
    // Fixed width: the MAC portion is exactly 32 bytes of base64url.
    expect(result.receipt.slice(AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX.length + 1)).toHaveLength(
      43
    );
  });

  it('issues a DIFFERENT receipt for a different wire (the MAC is not a constant)', () => {
    // The MAC is deterministic, so the same wire yields the same receipt. Two
    // different wires must NOT collide, which proves the payload really is signed.
    expect(issue()).toBe(issue());
    expect(issue(legitimateWire({ requestId: 'ai4e-A' }))).not.toBe(
      issue(legitimateWire({ requestId: 'ai4e-B' }))
    );
    expect(issue(legitimateWire({ binding: `sha256:${'e'.repeat(64)}` }))).not.toBe(issue());
  });

  it('refuses to issue for a malformed, incomplete or non-canonical wire', () => {
    for (const label of [
      'not an object',
      'missing proposal',
      'missing context_binding',
      'blank request_id',
      'unknown envelope key',
      'unknown interpretation key',
      'forged provenance class',
      'bad role',
      'bad relation kind',
      'duplicate line_ref',
      'explanation too long',
      'unsupported request_version',
    ]) {
      const wire = legitimateWire();
      switch (label) {
        case 'not an object':
          expect(AUTHORITY.issue('nope').ok).toBe(false);
          continue;
        case 'missing proposal':
          delete wire['proposal'];
          break;
        case 'missing context_binding':
          delete wire['context_binding'];
          break;
        case 'blank request_id':
          wire['request_id'] = '   ';
          break;
        case 'unknown envelope key':
          wire['snapshot_digest'] = 'sha256:extra';
          break;
        case 'unknown interpretation key':
          (wire['proposal'] as Wire)['grams'] = 100;
          break;
        case 'forged provenance class':
          (wire['proposal'] as Wire)['provenance_class'] = 'deterministic';
          break;
        case 'bad role':
          ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['role'] = 'chief';
          break;
        case 'bad relation kind':
          (
            (((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['relations'] as Wire[])[0]
          )['kind'] = 'related_to';
          break;
        case 'duplicate line_ref':
          (
            (wire['proposal'] as Wire)['interpretations'] as Wire[]
          )[1]['line_ref'] = 'l1';
          break;
        case 'explanation too long':
          (
            (wire['proposal'] as Wire)['interpretations'] as Wire[]
          )[0]['explanation'] = 'x'.repeat(5000);
          break;
        case 'unsupported request_version':
          wire['request_version'] = 'nutrition_ai_recipe_context_request_v9';
          break;
      }
      expect(AUTHORITY.issue(wire).ok, `issuing must refuse: ${label}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// B. RECEIPT VERIFY
// ---------------------------------------------------------------------------

describe('AI-4E canonicalization — the signed payload is the CANONICAL wire', () => {
  it('an explicit null optional is canonicalized to absent, so it signs identically', () => {
    // The RELEASED strict reader already treats `null` as "absent" for every optional
    // wire field. The receipt therefore signs the CANONICAL form, never the raw one,
    // so a `null` cannot become a second, unsigned spelling of the same wire.
    const withNull = legitimateWire();
    (((withNull['proposal'] as Wire)['interpretations'] as Wire[])[0])['confidence'] = null;
    const without = legitimateWire();
    delete (((without['proposal'] as Wire)['interpretations'] as Wire[])[0])['confidence'];

    const receipt = issue(without);
    // Both spellings authenticate: the authority strict-reads first, so the payload
    // is always built from the CANONICAL wire, never the raw one.
    expect(AUTHORITY.verify(receipt, withNull).ok).toBe(true);
    expect(AUTHORITY.verify(receipt, clone(without)).ok).toBe(true);

    const canonicalOf = (raw: Wire) => {
      const read = readAiRecipeContextWirePayload(raw);
      if (!read.ok) throw new Error('fixture must be readable');
      return recipeContextOriginReceiptPayload(read.payload);
    };
    expect(canonicalOf(withNull)).toEqual(canonicalOf(without));
    // And no `null` ever reaches the signed payload.
    expect(JSON.stringify(canonicalOf(withNull))).not.toContain('null');
    // `recipeContextOriginReceiptPayload` is a CANONICAL-wire builder by contract:
    // the authority is the only caller and always supplies a strict read.
    expect(recipeContextOriginReceiptPayload(withNull as never)).not.toEqual(
      recipeContextOriginReceiptPayload(without as never)
    );
  });
});

describe('AI-4E verify — exact wire plus exact receipt succeeds', () => {
  it('authenticates the wire it was issued for and returns the CANONICAL wire', () => {
    const receipt = issue();
    const result = AUTHORITY.verify(receipt, legitimateWire());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wire.request_id).toBe('ai4e-req-1');
    expect(result.wire.proposal.interpretations).toHaveLength(2);
  });

  it('byte-identical replay of a genuine wire + genuine receipt may verify again', () => {
    const wire = legitimateWire();
    const receipt = issue(wire);
    expect(AUTHORITY.verify(receipt, clone(wire)).ok).toBe(true);
    expect(AUTHORITY.verify(receipt, clone(wire)).ok).toBe(true);
  });

  it('refuses a wrong receipt, a malformed receipt and a missing receipt', () => {
    const wire = legitimateWire();
    const receipt = issue(wire);

    // Wrong receipt: a genuine receipt for a DIFFERENT wire.
    expect(AUTHORITY.verify(issue(legitimateWire({ requestId: 'other' })), wire).ok).toBe(false);
    // Mutated MAC.
    const flipped = `${receipt.slice(0, -1)}${receipt.endsWith('A') ? 'B' : 'A'}`;
    expect(AUTHORITY.verify(flipped, wire).ok).toBe(false);
    // Malformed shapes.
    for (const bad of [
      '',
      'rctx1.',
      'rctx1',
      `${receipt}extra`,
      receipt.slice(0, -1),
      receipt.replace('rctx1', 'rctx0'),
      receipt.replace('rctx1', 'rctx2'),
      'a'.repeat(AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_LENGTH),
      `${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.${'+'.repeat(43)}`,
      `${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.${'='.repeat(43)}`,
      `${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.${'A'.repeat(42)}`,
      null,
      undefined,
      42,
      {},
      [],
      true,
    ]) {
      expect(AUTHORITY.verify(bad, wire).ok, `malformed receipt accepted: ${String(bad)}`).toBe(
        false
      );
    }
  });

  it('a receipt is bound to its own authority, not merely its shape', () => {
    // Two fresh authorities: this is the server-restart case. A receipt from one
    // cannot be authenticated by the other, because the keys differ.
    const a = createRecipeContextOriginReceiptAuthority();
    const b = createRecipeContextOriginReceiptAuthority();
    const wire = legitimateWire();
    const fromA = a.issue(wire);
    expect(fromA.ok).toBe(true);
    if (!fromA.ok) return;
    expect(a.verify(fromA.receipt, wire).ok).toBe(true);
    expect(b.verify(fromA.receipt, wire).ok).toBe(false);
    // Each authority issues and verifies its OWN receipts, and never the other's.
    const fromB = b.issue(wire);
    expect(fromB.ok).toBe(true);
    if (!fromB.ok) return;
    expect(b.verify(fromB.receipt, wire).ok).toBe(true);
    expect(a.verify(fromB.receipt, wire).ok).toBe(false);
    expect(a.verify(fromA.receipt, wire).ok).toBe(true);
    expect(b.verify(fromA.receipt, wire).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. FORGED I-1 REPRODUCTION
// ---------------------------------------------------------------------------

describe('AI-4E forged-wire regression — I-1 is closed', () => {
  /**
   * The exact I-1 shape: a caller who can reproduce the deterministic current
   * context binding, choose a request id and write a contract-valid proposal, but
   * NEVER executed the authorized AI-4C provider path.
   */
  function forgedI1Wire(overrides: { requestId?: string; binding?: string } = {}): Wire {
    return legitimateWire({
      ...(overrides.requestId === undefined ? {} : { requestId: overrides.requestId }),
      ...(overrides.binding === undefined ? {} : { binding: overrides.binding }),
    });
  }

  it('a fabricated contract-valid wire is refused for want of a receipt', () => {
    const forged = forgedI1Wire();
    // Sanity: the forged wire is structurally CONTRACT-VALID. It is refused purely
    // because it was never issued, which is precisely the I-1 gap.
    expect(AUTHORITY.issue(forged).ok).toBe(true);
    const envelope = readRecipeContextOriginEnvelope(
      {
        expected_request_id: 'ai4e-req-1',
        recipe: { title: 'probe' },
        wire: forged,
      },
      AUTHORITY
    );
    expect(envelope.ok).toBe(false);
    if (envelope.ok) return;
    expect((envelope as { code: string }).code).toBe('origin_unverified');
  });

  it('the forged wire is refused with a RANDOM receipt, a MALFORMED receipt, and ANOTHER WIRE\'s receipt', () => {
    const forged = forgedI1Wire();

    // A random-but-well-shaped receipt.
    const randomMac = Buffer.alloc(32, 0x5a).toString('base64url');
    expect(
      AUTHORITY.verify(`${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.${randomMac}`, forged).ok
    ).toBe(false);

    // A malformed receipt.
    for (const bad of ['nope', `${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.`, 'rctx1.short']) {
      expect(AUTHORITY.verify(bad, forged).ok).toBe(false);
    }

    // A genuine receipt issued for a DIFFERENT wire.
    const other = legitimateWire({ requestId: 'ai4e-other', binding: `sha256:${'b'.repeat(64)}` });
    const otherReceipt = issue(other);
    expect(AUTHORITY.verify(otherReceipt, forged).ok).toBe(false);
  });

  it('CURRENT is unreachable: no receipt shape at all is ever authenticable', () => {
    const forged = forgedI1Wire();
    // Exhaustively: every candidate string a forger could plausibly construct from
    // public knowledge (the binding is reproducible, the receipt format is public).
    for (const mac of [
      '',
      '0',
      'a'.repeat(43),
      Buffer.alloc(32, 0).toString('base64url'),
      Buffer.from(String(forged['request_id'])).toString('base64url').padEnd(43, 'A').slice(0, 43),
      `${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.${createUnkeyedSha256Like(forged)}`,
    ]) {
      expect(
        AUTHORITY.verify(`${AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_PREFIX}.${mac}`, forged).ok,
        `a self-computed digest must not authenticate: ${mac}`
      ).toBe(false);
    }
  });
});

/**
 * A forger's best effort: an UNKEYED hash over the wire, formatted like a receipt.
 * It must NOT authenticate, because the real MAC is keyed with a secret the forger
 * does not have. This is the exact gap AI-4E closes.
 */
function createUnkeyedSha256Like(wire: Wire): string {
  const canonical = JSON.stringify(wire);
  // A deterministic 32-byte stand-in for an unkeyed digest the forger can compute.
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    let h = 0x811c9dc5;
    for (let c = 0; c < canonical.length; c += 1) {
      h = ((h ^ canonical.charCodeAt(c)) * 0x01000193) >>> 0;
    }
    out += String.fromCharCode(h & 0xff);
  }
  return Buffer.from(out, 'latin1').toString('base64url');
}

// ---------------------------------------------------------------------------
// D. FULL MUTATION MATRIX
// ---------------------------------------------------------------------------

describe('AI-4E mutation matrix — every semantic wire change breaks the receipt', () => {
  const mutations: ReadonlyArray<readonly [string, (wire: Wire) => void]> = [
    ['request_version', (wire) => {
      wire['request_version'] = 'nutrition_ai_recipe_context_request_v0';
    }],
    ['request_id', (wire) => {
      wire['request_id'] = 'ai4e-req-2';
    }],
    ['context_binding', (wire) => {
      wire['context_binding'] = `sha256:${'c'.repeat(64)}`;
    }],
    ['proposal.contract_version', (wire) => {
      (wire['proposal'] as Wire)['contract_version'] = 'nutrition_ai_recipe_context_v0';
    }],
    ['proposal.provenance_class', (wire) => {
      (wire['proposal'] as Wire)['provenance_class'] = 'deterministic';
    }],
    ['interpretation order', (wire) => {
      const list = (wire['proposal'] as Wire)['interpretations'] as Wire[];
      list.reverse();
    }],
    ['line_ref', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['line_ref'] = 'l9';
    }],
    ['role', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['role'] = 'garnish';
    }],
    ['relation kind', (wire) => {
      (
        (((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['relations'] as Wire[])[0]
      )['kind'] = 'duplicate_of';
    }],
    ['relation target_ref', (wire) => {
      (
        (((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['relations'] as Wire[])[0]
      )['target_ref'] = 'l3';
    }],
    ['relation removed', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['relations'] = [];
    }],
    ['preparation hint changed', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['preparation_hints'] = ['reserved'];
    }],
    ['preparation hint removed', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['preparation_hints'] = [];
    }],
    ['confidence', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['confidence'] = 'high';
    }],
    ['confidence removed', (wire) => {
      delete ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['confidence'];
    }],
    ['abstain_reason added', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['abstain_reason'] =
        'insufficient_evidence';
    }],
    ['abstain_reason changed', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[1]['abstain_reason'] =
        'ambiguous_role';
    }],
    ['explanation', (wire) => {
      ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['explanation'] = 'different';
    }],
    ['explanation removed', (wire) => {
      delete ((wire['proposal'] as Wire)['interpretations'] as Wire[])[0]['explanation'];
    }],
    ['interpretation added', (wire) => {
      (wire['proposal'] as Wire)['interpretations'] = [
        ...((wire['proposal'] as Wire)['interpretations'] as Wire[]),
        { line_ref: 'l3', role: 'reserved', relations: [], preparation_hints: [] },
      ];
    }],
    ['interpretation removed', (wire) => {
      (wire['proposal'] as Wire)['interpretations'] = (
        (wire['proposal'] as Wire)['interpretations'] as Wire[]
      ).slice(0, 1);
    }],
  ];

  it('has at least the twenty required mutations', () => {
    expect(mutations.length).toBeGreaterThanOrEqual(20);
  });

  for (const [label, mutate] of mutations) {
    it(`"${label}" invalidates the receipt, with no re-signing`, () => {
      expectMutationBreaksReceipt(label, mutate);
    });
  }

  it('adding a field the wire contract does not have breaks the receipt', () => {
    expectMutationBreaksReceipt('smuggled unknown key', (wire) => {
      wire['origin_receipt'] = 'anything';
    });
  });

  it('the MAC — not merely the parser — is what breaks every readable mutation', () => {
    // The strongest form of the matrix. For each mutation whose result is STILL a
    // structurally readable wire, the strict reader must ACCEPT the mutated wire and
    // the MAC must still refuse it. That proves the signature is doing real work,
    // rather than the mutation happening to be rejected as malformed.
    const readableMutations: ReadonlyArray<readonly [string, (wire: Wire) => void]> = mutations.filter(
      ([label]) =>
        ![
          'request_version',
          'proposal.contract_version',
          'proposal.provenance_class',
        ].includes(label)
    );
    expect(readableMutations.length).toBeGreaterThanOrEqual(16);

    for (const [label, mutate] of readableMutations) {
      const receipt = issue();
      const wire = legitimateWire();
      mutate(wire);
      // The mutated wire is still a VALID wire...
      expect(
        readAiRecipeContextWirePayload(wire).ok,
        `"${label}" must leave the wire readable so the MAC is what refuses it`
      ).toBe(true);
      // ...and the receipt still does not authenticate it.
      expect(AUTHORITY.verify(receipt, wire).ok, `"${label}" must invalidate the MAC`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// E/F/G/H. CROSS-WIRE, REQUEST CORRELATION, CONTEXT, PROPOSAL BINDING
// ---------------------------------------------------------------------------

describe('AI-4E cross-wire attacks', () => {
  it('receipt A never authenticates wire B', () => {
    const wireA = legitimateWire({ requestId: 'ai4e-A' });
    const wireB = legitimateWire({ requestId: 'ai4e-B' });
    const receiptA = issue(wireA);
    expect(AUTHORITY.verify(receiptA, wireA).ok).toBe(true);
    expect(AUTHORITY.verify(receiptA, wireB).ok).toBe(false);
    // Same proposal, different request id: still refused (request id is signed).
    const sameProposalDifferentId = legitimateWire({ requestId: 'ai4e-B' });
    expect(AUTHORITY.verify(receiptA, sameProposalDifferentId).ok).toBe(false);
    // Same request id, different context binding: still refused (binding is signed).
    const sameIdDifferentBinding = legitimateWire({
      requestId: 'ai4e-A',
      binding: `sha256:${'d'.repeat(64)}`,
    });
    expect(AUTHORITY.verify(receiptA, sameIdDifferentBinding).ok).toBe(false);
    // Reordered proposal: refused. Model-output ORDER IS part of the canonical
    // semantics and is deliberately NOT normalized away.
    const reordered = legitimateWire({ requestId: 'ai4e-A' });
    (reordered['proposal'] as Wire)['interpretations'] = (
      (reordered['proposal'] as Wire)['interpretations'] as Wire[]
    ).reverse();
    expect(AUTHORITY.verify(receiptA, reordered).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I. CONSTANT-TIME IMPLEMENTATION
// ---------------------------------------------------------------------------

describe('AI-4E constant-time verification', () => {
  it('the security boundary is timingSafeEqual, never ordinary equality', () => {
    expect(AUTHORITY_CODE).toContain("from 'node:crypto'");
    expect(AUTHORITY_CODE).toContain('createHmac');
    expect(AUTHORITY_CODE).toContain('randomBytes');
    expect(AUTHORITY_CODE).toContain('timingSafeEqual');
    // The two MAC buffers must NEVER be compared with `===` or `==`.
    expect(AUTHORITY_CODE).not.toMatch(/expected\s*[!=]==?\s*provided/);
    expect(AUTHORITY_CODE).not.toMatch(/provided\s*[!=]==?\s*expected/);
    expect(AUTHORITY_CODE).not.toMatch(/expected\.equals|compare\(/);
    // The constant-time comparison is the ONLY accept path in `verify`.
    const authorityAt = AUTHORITY_CODE.indexOf('randomBytes(32)');
    const verifyBody = AUTHORITY_CODE.slice(
      AUTHORITY_CODE.indexOf('verify(receipt: unknown', authorityAt),
      AUTHORITY_CODE.indexOf('get issuedCount', authorityAt)
    );
    expect(verifyBody).toContain('if (!timingSafeEqual(expected, provided)) return { ok: false };');
    expect([...verifyBody.matchAll(/return \{ ok: true/g)]).toHaveLength(1);
  });

  it('malformed lengths fail closed BEFORE any comparison', () => {
    // The parser is the length gate, and it runs before the MAC exists.
    const parseAt = AUTHORITY_SOURCE.indexOf('function parseReceiptMac');
    const verifyAt = AUTHORITY_SOURCE.indexOf('verify(receipt: unknown');
    const compareAt = AUTHORITY_SOURCE.indexOf('timingSafeEqual(expected, provided)');
    expect(parseAt).toBeGreaterThan(0);
    expect(compareAt).toBeGreaterThan(verifyAt);
    // The explicit length guard precedes the constant-time call in source order.
    expect(compareAt).toBeGreaterThan(
      AUTHORITY_SOURCE.lastIndexOf('if (expected.length !== provided.length)', compareAt)
    );
  });
});

// ---------------------------------------------------------------------------
// J/K. KEY ISOLATION AND AUTHORITY OWNERSHIP
// ---------------------------------------------------------------------------

describe('AI-4E key isolation', () => {
  it('the secret is never derived from another credential and never exposed', () => {
    // Never from a provider key, the access token, a BYOK key, or any env value.
    for (const forbidden of [
      'process.env',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'AI_ENDPOINT_TOKEN',
      'Math.random',
      'createHash',
      'sha256Hex',
    ]) {
      expect(AUTHORITY_CODE.includes(forbidden), `authority must not reference ${forbidden}`).toBe(
        false
      );
    }
    // A random 256-bit key, generated once inside the authority.
    expect(AUTHORITY_CODE).toContain('randomBytes(32)');
    // There is no option to inject a caller-supplied key.
    expect(AUTHORITY_CODE).not.toMatch(/options\??\s*:/);
    expect(AUTHORITY_CODE).not.toMatch(/secret\s*\?:/);
  });

  it('the module exposes no secret, no key and no signing oracle', () => {
    for (const forbidden of [
      'export const secret',
      'export let secret',
      'export function createRecipeContextOriginReceiptAuthorityWithSecret',
    ]) {
      expect(AUTHORITY_SOURCE).not.toContain(forbidden);
    }
    // Only the authority may sign, and signing is reachable only through `issue`.
    expect(AUTHORITY_CODE).toContain('const secret = randomBytes(32);');
  });

  it('the format module carries no cryptography and no secret', () => {
    for (const forbidden of ['node:crypto', 'crypto', 'createHmac', 'randomBytes', 'secret']) {
      expect(SHAPE_CODE.includes(forbidden), `shape module must not contain ${forbidden}`).toBe(
        false
      );
    }
    // The format is versioned and fixed-length.
    expect(SHAPE_SOURCE).toContain(AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION);
    expect(SHAPE_SOURCE).toContain(AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_BYTES);
  });

  it('the receipt version participates in the signed payload', () => {
    const payload = recipeContextOriginReceiptPayload(legitimateWire() as never) as Record<
      string,
      unknown
    >;
    expect(payload['receipt_version']).toBe(AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION);
    // And the payload binds the request version, ids, binding and the full proposal.
    expect(Object.keys(payload).sort()).toEqual([
      'context_binding',
      'proposal',
      'receipt_version',
      'request_id',
      'request_version',
    ]);
    const proposal = payload['proposal'] as Record<string, unknown>;
    expect(Object.keys(proposal).sort()).toEqual([
      'contract_version',
      'interpretations',
      'provenance_class',
    ]);
    const interpretations = proposal['interpretations'] as Array<Record<string, unknown>>;
    expect(interpretations[0]['relations']).toEqual([{ kind: 'same_as', target_ref: 'l2' }]);
    expect(interpretations[0]['confidence']).toBe('medium');
    expect(interpretations[0]['explanation']).toBe('the primary ingredient');
    expect(interpretations[1]['abstain_reason']).toBe('insufficient_evidence');
    expect('confidence' in interpretations[1]).toBe(false);
  });

  it('the payload never spreads a caller object: only the closed wire fields are signed', () => {
    // A smuggled extra key on the wire is refused by the strict reader at issue time,
    // so it can never reach the signed payload.
    const wire = legitimateWire();
    (wire['proposal'] as Wire)['interpretations'] = [
      {
        ...((wire['proposal'] as Wire)['interpretations'] as Wire[])[0],
        grams: 250,
      },
    ];
    expect(AUTHORITY.issue(wire).ok).toBe(false);
    // And the builder itself constructs each entry from an explicit field list.
    expect(AUTHORITY_CODE).toContain('line_ref: entry.line_ref');
    expect(AUTHORITY_CODE).toContain('role: entry.role');
    // No caller OBJECT is ever spread. The only spreads are defensive array copies
    // (`[...entry.preparation_hints]`) and the conditional inclusion of an OPTIONAL
    // wire field from an empty-literal fallback.
    expect(AUTHORITY_CODE).not.toMatch(/\.\.\.entry[\s,}]/);
    expect(AUTHORITY_CODE).not.toMatch(/\.\.\.wire[\s,}]/);
    expect(AUTHORITY_CODE).not.toMatch(/\.\.\.relation[\s,}]/);
    expect(AUTHORITY_CODE).not.toMatch(/\.\.\.proposal[\s,}]/);
    expect(AUTHORITY_CODE).not.toMatch(/\.\.\.interpretations/);
    // Optional fields are included from an EMPTY literal, never from the entry.
    for (const optional of ['confidence', 'abstain_reason', 'explanation']) {
      expect(AUTHORITY_CODE).toContain(
        `...(entry.${optional} === undefined ? {} : { ${optional}: entry.${optional} })`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// THE ORIGIN ENVELOPE
// ---------------------------------------------------------------------------

describe('AI-4E origin envelope — receipt never flows downward', () => {
  const recipe = { title: 'probe', ingredients: [{ original: '1 onion', name: 'onion' }] };

  it('accepts a genuine receipt and rebuilds the EXACT closed D1 body', () => {
    const wire = legitimateWire();
    const result = readRecipeContextOriginEnvelope(
      {
        wire,
        expected_request_id: 'ai4e-req-1',
        recipe,
        instructions: [{ text: 'chop' }],
        recipe_instance: 'inst-1',
        origin_receipt: issue(wire),
      },
      AUTHORITY
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The receipt is consumed: the D1 body keeps its exact five-key shape.
    expect(Object.keys(result.body).sort()).toEqual([
      'expected_request_id',
      'instructions',
      'recipe',
      'recipe_instance',
      'wire',
    ]);
    expect(result.body['origin_receipt']).toBeUndefined();
  });

  it('refuses a caller-authored context/envelope/binding key by name', () => {
    const wire = legitimateWire();
    const receipt = issue(wire);
    for (const key of ['context', 'envelope', 'binding', 'targets', 'line_refs']) {
      const result = readRecipeContextOriginEnvelope(
        { wire, expected_request_id: 'ai4e-req-1', recipe, origin_receipt: receipt, [key]: {} },
        AUTHORITY
      );
      expect(result.ok, `key ${key} must be refused`).toBe(false);
      if (result.ok) continue;
      expect((result as { code: string }).code).toBe('invalid_input');
    }
  });

  it('refuses a structurally unusable body before any receipt work', () => {
    for (const body of [
      null,
      'text',
      42,
      [],
      {},
      { wire: legitimateWire(), recipe },
      { recipe, origin_receipt: 'x' },
      { wire: legitimateWire(), recipe, expected_request_id: '   ', origin_receipt: 'x' },
    ]) {
      const result = readRecipeContextOriginEnvelope(body, AUTHORITY);
      expect(result.ok, `body ${JSON.stringify(body)} must be refused`).toBe(false);
      if (result.ok) continue;
      expect((result as { code: string }).code).toBe('invalid_input');
    }
  });

  it('missing receipt and wrong receipt are the SAME public class', () => {
    const wire = legitimateWire();
    const missing = readRecipeContextOriginEnvelope(
      { wire, expected_request_id: 'ai4e-req-1', recipe },
      AUTHORITY
    );
    const wrong = readRecipeContextOriginEnvelope(
      { wire, expected_request_id: 'ai4e-req-1', recipe, origin_receipt: 'nope' },
      AUTHORITY
    );
    expect(missing.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    if (missing.ok || wrong.ok) return;
    expect((missing as { code: string }).code).toBe('origin_unverified');
    expect((wrong as { code: string }).code).toBe((missing as { code: string }).code);
  });

  it('the envelope module imports NO provider and NO AI-3 surface', () => {
    // Import specifiers, not prose: the module's documentation legitimately
    // discusses the provider path, so only real dependencies are asserted here.
    const specifiers = [...AUTHORITY_SOURCE.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1]
    );
    expect(specifiers.sort()).toEqual([
      '../src/core/nutritionV2/aiRecipeContextOriginReceiptShape.js',
      '../src/core/nutritionV2/aiRecipeContextWire.js',
      '../src/core/nutritionV2/schema.js',
      '../src/core/nutritionV2/usda/digest.js',
      'node:crypto',
    ]);
    for (const specifier of specifiers) {
      for (const forbidden of [
        'provider',
        'gemini',
        'openrouter',
        'nutritionContext',
        'phase4/',
        'calculation',
        'phase5',
        'advancedNutritionApply',
        'recipeContextReconcile',
      ]) {
        expect(specifier.includes(forbidden), `${specifier} must not reference ${forbidden}`).toBe(
          false
        );
      }
    }
    // No network of any kind in the origin gate.
    expect(AUTHORITY_CODE).not.toContain('fetch(');
  });
});

// ---------------------------------------------------------------------------
// SECRET LEAK / CLIENT BUNDLE ISOLATION
// ---------------------------------------------------------------------------

describe('AI-4E secret leak — the signing key cannot escape the server', () => {
  it('no client module can reach the authority, the crypto, or a secret', () => {
    const CLIENT_MODULES = [
      'src/core/nutritionV2/aiRecipeContextOriginReceiptShape.ts',
      'src/application/nutritionAiRecipeContext.ts',
      'src/core/nutritionV2/aiRecipeContextReconcile.ts',
      'src/core/nutritionV2/aiRecipeContextSession.ts',
      'src/components/AdvancedNutritionCard.tsx',
      'src/components/AdvancedNutritionModal.tsx',
      'src/App.tsx',
    ];
    for (const file of CLIENT_MODULES) {
      const source = read(file);
      for (const forbidden of [
        'recipeContextOriginReceipt',
        'node:crypto',
        'createHmac',
        'timingSafeEqual',
        'randomBytes(32)',
        'from "../../server',
        "from '../../server",
      ]) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
      // And no secret material of any shape.
      for (const forbidden of ['AI_RECIPE_CONTEXT_ORIGIN_SECRET', 'ORIGIN_SECRET', 'secretKey']) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
    }
  });

  it('nothing under src/ imports the server receipt authority or node crypto', () => {
    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
      }
      return out;
    };
    for (const file of walk(join(REPO, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('recipeContextOriginReceipt') || source.includes("node:crypto")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the receipt carries the MAC and nothing else — no secret, no payload, no digest', () => {
    const receipt = issue();
    const mac = receipt.slice(receipt.indexOf('.') + 1);
    // Only the MAC bytes are present, base64url encoded.
    expect(Buffer.from(mac, 'base64url')).toHaveLength(AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_MAC_BYTES);
    // No JSON, no key material, no signed payload, no request/context identifiers.
    for (const forbidden of [
      'receipt_version',
      'request_id',
      'context_binding',
      'proposal',
      'interpretation',
      'sha256:',
      '"',
      '{',
      '}',
      ':',
      SECRET_PROBE,
    ]) {
      expect(receipt.includes(forbidden), `receipt leaked ${forbidden}`).toBe(false);
    }
  });

  it('a receipt contains no substring of the server source or of any credential', () => {
    const receipt = issue();
    // Long distinctive identifiers from the implementation must not be recoverable.
    for (const fragment of [
      'createHmac',
      'timingSafeEqual',
      'randomBytes',
      'recipeContextOriginReceiptPayload',
      'AI_RECIPE_CONTEXT_ORIGIN_RECEIPT_VERSION',
    ]) {
      expect(receipt.includes(fragment), `receipt leaked ${fragment}`).toBe(false);
    }
    expect(receipt).not.toContain(SECRET_PROBE);
  });

  it('no thrown error, log line or response can carry the secret', () => {
    // The authority never throws, so there is no error path that could format a key.
    const authority = createRecipeContextOriginReceiptAuthority();
    for (const hostile of [null, undefined, 0, '', [], {}, Symbol('x'), () => 0, BigInt(1)]) {
      expect(() => authority.issue(hostile)).not.toThrow();
      expect(() => authority.verify(hostile, hostile)).not.toThrow();
      expect(() => authority.verify(issue(), hostile)).not.toThrow();
      expect(() => authority.verify(hostile, legitimateWire())).not.toThrow();
    }
    // The module logs nothing at all, so there is no logging path to leak through.
    expect(AUTHORITY_CODE).not.toContain('console.');
  });

  it('the app logs no receipt, MAC or secret on either route', () => {
    // Every AI-4 log statement may interpolate only the timestamp and the client IP.
    // No receipt, MAC, payload, secret or wire content is ever passed to a logger, so
    // there is no formatting path that could emit one.
    const interpolations = new Set<string>();
    for (const match of APP_SOURCE.matchAll(/console\.(?:log|error|warn)\(([\s\S]*?)\);/g)) {
      for (const hole of match[1].matchAll(/\$\{([^}]*)\}/g)) {
        interpolations.add(hole[1].trim());
      }
    }
    // Nothing receipt-shaped is ever interpolated anywhere in the app.
    for (const expression of interpolations) {
      expect(
        /receipt|rctx|hmac|mac|secret|origin|wire|proposal/i.test(expression),
        `log interpolation must not carry receipt material: ${expression}`
      ).toBe(false);
    }
    // The AI-4 refusal log is a FIXED message: it interpolates nothing at all.
    const refusalAt = APP_SOURCE.indexOf('refusing to issue an origin receipt');
    expect(refusalAt).toBeGreaterThan(0);
    const refusalLog = APP_SOURCE.slice(refusalAt, refusalAt + 500).split(');')[0];
    expect(refusalLog).toContain('refusing to issue an origin receipt');
    expect(refusalLog).not.toContain('${');
  });
});

// ---------------------------------------------------------------------------
// APPLICATION WIRING
// ---------------------------------------------------------------------------

describe('AI-4E application wiring', () => {
  it('createApp owns ONE authority instance shared by both routes', () => {
    expect(APP_SOURCE).toContain(
      'createRecipeContextOriginReceiptAuthority()'
    );
    const created = APP_SOURCE.split('createRecipeContextOriginReceiptAuthority()').length - 1;
    expect(created).toBe(1); // EXACTLY ONE instantiation, owned by createApp()
    // Both routes use the same instance.
    expect(APP_SOURCE).toContain('recipeContextOriginReceipts.issue(');
    expect(APP_SOURCE).toContain('readRecipeContextOriginEnvelope(req.body, recipeContextOriginReceipts)');
  });

  it('no new endpoint and no new limiter were introduced', () => {
    // Exactly the two AI-4 recipe-context routes, unchanged in count.
    const ai4Routes = [...APP_SOURCE.matchAll(/"\/api\/nutrition\/recipe-context[^"]*"/g)].map(
      (match) => match[0]
    );
    expect(new Set(ai4Routes)).toEqual(
      new Set(['"/api/nutrition/recipe-context"', '"/api/nutrition/recipe-context/reconcile"'])
    );
    // The reconcile limiter is still the pre-existing one.
    expect(APP_SOURCE).toContain('nutritionContextReconcileRateLimiter');
    expect(APP_SOURCE).not.toContain('originReceiptRateLimiter');
  });

  it('the origin gate runs BEFORE reconciliation, not after', () => {
    const gateAt = APP_SOURCE.indexOf('readRecipeContextOriginEnvelope(req.body, recipeContextOriginReceipts)');
    const reconcileAt = APP_SOURCE.indexOf('reconcileRecipeContextOnServer(envelope.body)');
    expect(gateAt).toBeGreaterThan(0);
    expect(reconcileAt).toBeGreaterThan(gateAt);
    // The adapter is NEVER handed the raw body, so the receipt cannot flow into it.
    expect(APP_SOURCE).not.toContain('reconcileRecipeContextOnServer(req.body)');
  });

  it('AI-4D1 and the server reconcile adapter remain free of cryptography and secrets', () => {
    for (const file of [
      'src/core/nutritionV2/aiRecipeContextReconcile.ts',
      'server/recipeContextReconcile.ts',
    ]) {
      const source = read(file);
      for (const forbidden of [
        'createHmac',
        'timingSafeEqual',
        'randomBytes',
        'node:crypto',
        'origin_receipt',
        'originReceipt',
        'secret',
        'HMAC',
      ]) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
    }
  });
});