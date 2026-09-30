/**
 * AI-4A — WHOLE-RECIPE CONTEXT CONTRACT: the canonical shape, closed
 * vocabularies, authority firewall and privacy key set.
 *
 * PURE. No network, no session, no recipe wiring, no state. Every assertion here
 * exercises the REAL production sanitizer.
 *
 * RULINGS PINNED BY THIS FILE
 *  R1. `RecipeContextEnvelope` is a SEPARATE explicit structure. `AdaptedRecipe`
 *      stays narrow and is never widened.
 *  R2. Raw model output has ZERO suppression authority.
 *  R3. `consumption_fraction` / `consumed_fraction` / `yield_factor` are
 *      EXPLICITLY REJECTED authority fields.
 *  R4. No grams, no fraction, no nutrient quantity, no serving weight, no FDC
 *      numeric authority.
 */
import { describe, it, expect } from 'vitest';

import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
  AI_RECIPE_CONTEXT_DISPLAY_LABEL,
  AI_RECIPE_CONTEXT_ROLES,
  AI_RECIPE_CONTEXT_RELATIONS,
  AI_RECIPE_CONTEXT_ABSTAIN_REASONS,
  AI_RECIPE_CONTEXT_CONFIDENCE_VALUES,
  AI_RECIPE_CONTEXT_PREPARATION_HINTS,
  AI_RECIPE_CONTEXT_SINGLE_PARENT_RELATIONS,
  AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS,
  AUTHENTICATED_PROVENANCE_CLAIMS,
  MAX_RECIPE_CONTEXT_TARGETS,
  MAX_RECIPE_CONTEXT_RELATIONS,
  MAX_RECIPE_CONTEXT_PREPARATION_HINTS,
  MAX_RECIPE_CONTEXT_TITLE_LENGTH,
  MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH,
  MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH,
  isAiRecipeContextAuthorityKey,
  isAiRecipeContextProvenanceClass,
  sanitizeRecipeContextEnvelope,
  sanitizeAiRecipeContextProposal,
  validateAiRecipeContextRelationGraph,
  type AiRecipeContextInterpretation,
  type AiRecipeContextProposal,
  type RecipeContextEnvelope,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';

import {
  isAuthenticatedProvenanceClass,
} from '../../src/core/nutritionV2/aiAdvancedEstimate';

const REFS = ['l1', 'l2', 'l3'];

function proposal(
  rows: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown> {
  return {
    contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
    provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
    interpretations: rows,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { line_ref: 'l1', role: 'main', ...overrides };
}

/**
 * Permissive result view so an assertion can read `.code` without depending on
 * union narrowing (vitest's `expect` does not narrow).
 */
interface ResultView {
  readonly ok: boolean;
  readonly code?: string;
  readonly proposal?: AiRecipeContextProposal;
  readonly envelope?: RecipeContextEnvelope;
  readonly interpretations?: ReadonlyArray<AiRecipeContextInterpretation>;
  readonly lineCount?: number;
}

function sanitize(raw: unknown, allowed: ReadonlyArray<string> = REFS): ResultView {
  return sanitizeAiRecipeContextProposal(raw, { allowedLineRefs: allowed }) as ResultView;
}

function envelopeOf(raw: unknown): ResultView {
  return sanitizeRecipeContextEnvelope(raw) as ResultView;
}

function graphOf(
  interpretations: ReadonlyArray<AiRecipeContextInterpretation>,
  allowedLineRefs: ReadonlyArray<string>
): ResultView {
  return validateAiRecipeContextRelationGraph(interpretations, allowedLineRefs) as ResultView;
}

// ---------------------------------------------------------------------------
// 1. CONTRACT IDENTITY + PROVENANCE IS NEVER AUTHENTICATED
// ---------------------------------------------------------------------------
describe('AI-4A contract identity — provenance can never be authenticated', () => {
  it('THE provenance invariant: ai_recipe_context is NOT an authenticated class', () => {
    expect(isAuthenticatedProvenanceClass(AI_RECIPE_CONTEXT_PROVENANCE_CLASS)).toBe(false);
    expect(isAuthenticatedProvenanceClass('ai_recipe_context')).toBe(false);
    expect(isAuthenticatedProvenanceClass('ai_estimate')).toBe(false);
    expect(isAuthenticatedProvenanceClass('usda_derived')).toBe(true);
    expect(isAuthenticatedProvenanceClass('vetted_standard')).toBe(true);
  });

  it('the contract version is a closed explicit token', () => {
    expect(AI_RECIPE_CONTEXT_CONTRACT_VERSION).toBe('nutrition_ai_recipe_context_v1');
  });

  it('the display label is truthful about non-authentication', () => {
    expect(AI_RECIPE_CONTEXT_DISPLAY_LABEL).toBe(
      'AI recipe context (interpretation only, not USDA-authenticated)'
    );
    expect(AI_RECIPE_CONTEXT_DISPLAY_LABEL).toContain('not USDA-authenticated');
  });

  it('provenance classification is exact, never coercive', () => {
    expect(isAiRecipeContextProvenanceClass('ai_recipe_context')).toBe(true);
    expect(isAiRecipeContextProvenanceClass('usda_derived')).toBe(false);
    expect(isAiRecipeContextProvenanceClass('ai_estimate')).toBe(false);
    expect(isAiRecipeContextProvenanceClass(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. CLOSED VOCABULARIES
// ---------------------------------------------------------------------------
describe('AI-4A closed vocabularies', () => {
  it('the role enum is exactly the eight approved concepts', () => {
    expect([...AI_RECIPE_CONTEXT_ROLES]).toEqual([
      'main',
      'garnish',
      'cooking_medium',
      'serving_component',
      'reserved',
      'divided',
      'optional',
      'unknown',
    ]);
  });

  it('garnish and serving_component are DISTINCT roles (no overloading)', () => {
    expect(AI_RECIPE_CONTEXT_ROLES).toContain('garnish');
    expect(AI_RECIPE_CONTEXT_ROLES).toContain('serving_component');
    expect(AI_RECIPE_CONTEXT_ROLES.indexOf('garnish')).not.toBe(
      AI_RECIPE_CONTEXT_ROLES.indexOf('serving_component')
    );
  });

  it('the relation enum is exactly the four approved kinds', () => {
    expect([...AI_RECIPE_CONTEXT_RELATIONS]).toEqual([
      'divided_into',
      'reserved_from',
      'duplicate_of',
      'same_as',
    ]);
  });

  it('the abstention enum is closed', () => {
    expect([...AI_RECIPE_CONTEXT_ABSTAIN_REASONS]).toEqual([
      'no_recipe_context',
      'insufficient_evidence',
      'contradictory_context',
      'ambiguous_role',
      'already_deterministic',
      'untrusted_context',
    ]);
  });

  it('the confidence enum is closed', () => {
    expect([...AI_RECIPE_CONTEXT_CONFIDENCE_VALUES]).toEqual(['high', 'medium', 'low']);
  });

  it('the preparation hint vocabulary is closed and carries bone_in/skin_on', () => {
    expect(AI_RECIPE_CONTEXT_PREPARATION_HINTS).toContain('bone_in');
    expect(AI_RECIPE_CONTEXT_PREPARATION_HINTS).toContain('skin_on');
    expect(AI_RECIPE_CONTEXT_PREPARATION_HINTS).toContain('skinless');
    expect(AI_RECIPE_CONTEXT_PREPARATION_HINTS).toContain('boneless');
    for (const hint of AI_RECIPE_CONTEXT_PREPARATION_HINTS) {
      expect(hint).toMatch(/^[a-z_]+$/);
    }
  });

  it('the single-parent relation set is exactly the two allocating relations', () => {
    expect([...AI_RECIPE_CONTEXT_SINGLE_PARENT_RELATIONS].sort()).toEqual([
      'divided_into',
      'reserved_from',
    ]);
  });

  it('every vocab is frozen', () => {
    expect(Object.isFrozen(AI_RECIPE_CONTEXT_ROLES)).toBe(true);
    expect(Object.isFrozen(AI_RECIPE_CONTEXT_RELATIONS)).toBe(true);
    expect(Object.isFrozen(AI_RECIPE_CONTEXT_ABSTAIN_REASONS)).toBe(true);
    expect(Object.isFrozen(AI_RECIPE_CONTEXT_CONFIDENCE_VALUES)).toBe(true);
    expect(Object.isFrozen(AI_RECIPE_CONTEXT_PREPARATION_HINTS)).toBe(true);
  });

  it('EVERY valid role is accepted', () => {
    for (const role of AI_RECIPE_CONTEXT_ROLES) {
      const result = sanitize(proposal([row({ role })]));
      expect(result.ok, `role ${role}`).toBe(true);
    }
  });

  it('EVERY invalid role is refused', () => {
    for (const bad of ['secret_sauce', 'MAIN', '', 'side', 'oil', 'garnish2', 'Main']) {
      const result = sanitize(proposal([row({ role: bad })]));
      expect(result.ok, `role ${JSON.stringify(bad)}`).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_response');
    }
  });

  it('a whitespace-padded valid role is NORMALIZED, never a new value', () => {
    const result = sanitize(proposal([row({ role: '  main  ' })]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.interpretations[0].role).toBe('main');
  });

  it('EVERY valid relation kind is accepted', () => {
    for (const kind of AI_RECIPE_CONTEXT_RELATIONS) {
      const result = sanitize(
        proposal([row({ role: 'divided', relations: [{ kind, target_ref: 'l2' }] })])
      );
      expect(result.ok, `relation ${kind}`).toBe(true);
    }
  });

  it('an unknown relation kind is refused', () => {
    const result = sanitize(
      proposal([row({ relations: [{ kind: 'merged_into', target_ref: 'l2' }] })])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_relations');
  });

  it('EVERY valid confidence is accepted and NEVER grants authority', () => {
    for (const confidence of AI_RECIPE_CONTEXT_CONFIDENCE_VALUES) {
      const result = sanitize(proposal([row({ confidence })]));
      expect(result.ok, `confidence ${confidence}`).toBe(true);
    }
    // A high-confidence reading carries no authority field of any kind.
    const high = sanitize(proposal([row({ confidence: 'high' })]));
    expect(high.ok).toBe(true);
    if (high.ok) {
      const text = JSON.stringify(high.proposal);
      expect(text).not.toContain('grams');
      expect(text).not.toContain('authority');
      expect(text).not.toContain('apply');
      expect(text).not.toContain('persist');
    }
  });

  it('EVERY valid abstain reason is accepted', () => {
    for (const abstain_reason of AI_RECIPE_CONTEXT_ABSTAIN_REASONS) {
      const result = sanitize(proposal([row({ abstain_reason })]));
      expect(result.ok, `abstain ${abstain_reason}`).toBe(true);
    }
  });

  it('an invalid abstain reason is refused', () => {
    const result = sanitize(proposal([row({ abstain_reason: 'because' })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_response');
  });

  it('an invalid preparation hint is refused (closed, never open-ended text)', () => {
    const result = sanitize(proposal([row({ preparation_hints: ['sliced thin'] })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_response');
  });
});

// ---------------------------------------------------------------------------
// 3. NO NUMERIC AUTHORITY (R4 / §7)
// ---------------------------------------------------------------------------
describe('AI-4A carries NO numeric nutrition authority', () => {
  it('the whole contract vocabulary contains no mass/fraction/nutrient token', () => {
    const source = [...AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS].join(' ');
    for (const forbidden of [
      'consumption_fraction',
      'consumed_fraction',
      'yield_factor',
      'serving_weight',
      'portion_ref',
      'candidate_ref',
      'direct_mass',
      'user_mass',
      'ai_estimate',
      'conversion_basis',
    ]) {
      expect(source, forbidden).toContain(forbidden);
    }
  });

  it('R3: consumption_fraction / consumed_fraction / yield_factor are REFUSED', () => {
    for (const key of ['consumption_fraction', 'consumed_fraction', 'yield_factor']) {
      const result = sanitize(proposal([row({ [key]: 0.5 })]));
      expect(result.ok, key).toBe(false);
      if (result.ok) return;
      expect(result.code, key).toBe('authority_field');
    }
  });

  it('R3: a nested consumption fraction is REFUSED as an authority field', () => {
    const result = sanitize(
      proposal([row({ role: 'divided', relations: [{ kind: 'divided_into', target_ref: 'l2', consumption_fraction: 0.5 }] })])
    );
    expect(result.ok).toBe(false);
    // The interpretation-level recursive deny-walk catches a NESTED fraction
    // before the relation canonicalizer, so the refusal is an explicit
    // authority rejection rather than a structural one.
    if (result.ok) return;
    expect(result.code).toBe('authority_field');
  });

  it('a sanitized interpretation serializes to no mass-shaped token', () => {
    const result = sanitize(
      proposal([
        row({
          role: 'garnish',
          relations: [{ kind: 'same_as', target_ref: 'l2' }],
          preparation_hints: ['drained'],
          confidence: 'medium',
          abstain_reason: 'insufficient_evidence',
          explanation: 'appears as a finishing step only',
        }),
      ])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = JSON.stringify(result.proposal);
    for (const banned of ['gram', 'mass', 'weight', 'nutrient', 'calor', 'fdc', 'portion_']) {
      expect(text.toLowerCase(), banned).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. EXHAUSTIVE FORBIDDEN-KEY MATRIX (§14) — mutation-sensitive
// ---------------------------------------------------------------------------
describe('AI-4A forbidden authority keys — EVERY key is refused', () => {
  it('the deny vocabulary is non-trivial and includes the mandated AI-4 keys', () => {
    expect(AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS.size).toBeGreaterThan(100);
    for (const key of [
      'consumption_fraction',
      'consumed_fraction',
      'yield_factor',
      'fdc_id',
      'nutrients',
      'calories',
      'grams',
      'mass',
      'weight',
      'portion_index',
      'portion_ref',
      'candidate_ref',
      'direct_mass',
      'user_mass',
      'source_portion',
      'count_portion',
      'household_portion',
      'ai_estimate',
      'conversion_basis',
      'apply',
      'persist',
      'authorization',
      'codex_nutrition',
      'suppress',
      'auto_apply',
      'record_digest',
      'catalog_digest',
      'usda_derived',
      'vetted_standard',
    ]) {
      expect(AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS.has(key), key).toBe(true);
    }
  });

  it('EVERY denied key is refused on an interpretation as authority_field', () => {
    for (const key of AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS) {
      const result = sanitize(proposal([row({ [key]: 'x' })]));
      expect(result.ok, `interpretation key ${key}`).toBe(false);
      if (result.ok) return;
      expect(result.code, `interpretation key ${key}`).toBe('authority_field');
    }
  });

  it('EVERY denied key is refused at the proposal envelope', () => {
    for (const key of AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS) {
      const raw = { ...proposal([row()]), [key]: 'x' };
      const result = sanitize(raw);
      expect(result.ok, `envelope key ${key}`).toBe(false);
      if (result.ok) return;
      expect(result.code, `envelope key ${key}`).toBe('authority_field');
    }
  });

  it('EVERY denied key is refused on a relation', () => {
    for (const key of AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS) {
      const result = sanitize(
        proposal([row({ relations: [{ kind: 'same_as', target_ref: 'l2', [key]: 'x' }] })])
      );
      expect(result.ok, `relation key ${key}`).toBe(false);
      // Nested denial is caught by the recursive interpretation-level walk.
      if (result.ok) return;
      expect(result.code, `relation key ${key}`).toBe('authority_field');
    }
  });

  it('EVERY denied key is refused on a recipe-context envelope', () => {
    for (const key of AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS) {
      const raw = {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        targets: [{ line_ref: 'l1', source_text: '1 cup cream' }],
        [key]: 'x',
      };
      const result = envelopeOf(raw);
      expect(result.ok, `envelope ${key}`).toBe(false);
      if (result.ok) return;
      expect(result.code, `envelope ${key}`).toBe('authority_field');
    }
  });

  it('EVERY denied key is refused on a recipe-context TARGET', () => {
    for (const key of AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS) {
      const raw = {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        targets: [{ line_ref: 'l1', source_text: '1 cup cream', [key]: 'x' }],
      };
      const result = envelopeOf(raw);
      expect(result.ok, `target ${key}`).toBe(false);
      if (result.ok) return;
      expect(result.code, `target ${key}`).toBe('authority_field');
    }
  });

  it('an authenticated provenance CLAIM is refused even though provenance_class is allowed', () => {
    for (const claim of AUTHENTICATED_PROVENANCE_CLAIMS) {
      const result = sanitize({
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: claim,
        interpretations: [row()],
      });
      expect(result.ok, claim).toBe(false);
      if (result.ok) return;
      expect(result.code, claim).toBe('authority_field');
    }
  });

  it('the authority-key predicate is exact', () => {
    expect(isAiRecipeContextAuthorityKey('consumption_fraction')).toBe(true);
    expect(isAiRecipeContextAuthorityKey('role')).toBe(false);
    expect(isAiRecipeContextAuthorityKey('line_ref')).toBe(false);
    // `provenance_class` is the contract's own required field, never denied as a key.
    expect(isAiRecipeContextAuthorityKey('provenance_class')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. STRUCTURAL FIREWALL (§10 / §15)
// ---------------------------------------------------------------------------
describe('AI-4A structural firewall', () => {
  it('only a plain object is accepted', () => {
    for (const bad of [null, 1, 'x', true, []]) {
      const result = sanitize(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_response');
    }
  });

  it('an unsupported top-level type fails closed as unsafe at the inert pre-pass', () => {
    for (const bad of [undefined, () => {}]) {
      const result = sanitize(bad);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('unsafe_response');
    }
  });

  it('a non-plain-prototype value fails closed as unsafe', () => {
    for (const hostile of [new Date(0), new Map(), new Set(), /x/]) {
      const result = sanitize(hostile);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('unsafe_response');
    }
  });

  it('a non-plain prototype is refused', () => {
    const hostile = Object.create({ inherited: 1 });
    hostile.contract_version = AI_RECIPE_CONTEXT_CONTRACT_VERSION;
    const result = sanitize(hostile);
    expect(result.ok).toBe(false);
  });

  it('a wrong contract version is refused', () => {
    const result = sanitize({
      contract_version: 'nutrition_ai_recipe_context_v2',
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      interpretations: [row()],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported_contract_version');
  });

  it('a missing contract version is refused', () => {
    const result = sanitize({
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      interpretations: [row()],
    });
    expect(result.ok).toBe(false);
  });

  it('an extra property anywhere is refused', () => {
    expect(sanitize(proposal([row({ extra: 1 })])).ok).toBe(false);
    expect(
      sanitize({ ...proposal([row()]), extra: 1 }).ok
    ).toBe(false);
    expect(
      sanitize(proposal([row({ relations: [{ kind: 'same_as', target_ref: 'l2', extra: 1 }] })])).ok
    ).toBe(false);
  });

  it('a missing line_ref is refused', () => {
    const result = sanitize(proposal([{ role: 'main' }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_response');
  });

  it('an unknown line_ref is refused', () => {
    const result = sanitize(proposal([row({ line_ref: 'nope' })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown_line_ref');
  });

  it('a duplicate line_ref is refused', () => {
    const result = sanitize(proposal([row(), row()]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate_line_ref');
  });

  it('a malformed array is refused', () => {
    expect(sanitize(proposal([row({ relations: 'same_as' })])).ok).toBe(false);
    expect(sanitize(proposal([row({ preparation_hints: 'drained' })])).ok).toBe(false);
    expect(sanitize({ ...proposal([row()]), interpretations: {} }).ok).toBe(false);
  });

  it('an oversized explanation is refused', () => {
    const result = sanitize(proposal([row({ explanation: 'x'.repeat(MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH + 1) })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_response');
  });

  it('the explanation boundary is exact at the limit', () => {
    const atLimit = 'x'.repeat(MAX_RECIPE_CONTEXT_EXPLANATION_LENGTH);
    expect(sanitize(proposal([row({ explanation: atLimit })])).ok).toBe(true);
  });

  it('an unsafe nested object is refused', () => {
    const hostile = { role: 'main', relations: [{ kind: 'same_as', target_ref: 'l2', extra: Object.create(null) }] };
    expect(sanitize(proposal([hostile])).ok).toBe(false);
  });

  it('too many rows are refused, never truncated', () => {
    const rows = Array.from({ length: MAX_RECIPE_CONTEXT_TARGETS + 1 }, (_, i) => ({
      line_ref: `r${i}`,
      role: 'main',
    }));
    const result = sanitize(proposal(rows), rows.map((_, i) => `r${i}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('too_many_rows');
  });

  it('too many relations / hints are refused', () => {
    const manyRelations = Array.from({ length: MAX_RECIPE_CONTEXT_RELATIONS + 1 }, () => ({
      kind: 'same_as',
      target_ref: 'l2',
    }));
    expect(sanitize(proposal([row({ relations: manyRelations })])).ok).toBe(false);
    const manyHints = Array.from({ length: MAX_RECIPE_CONTEXT_PREPARATION_HINTS + 1 }, () => 'raw');
    expect(sanitize(proposal([row({ preparation_hints: manyHints })])).ok).toBe(false);
  });

  it('non-finite numbers are refused wherever a number could appear', () => {
    const result = envelopeOf({
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      targets: [{ line_ref: 'l1', source_text: '1 cup cream' }],
      base_servings: Number.NaN,
    });
    expect(result.ok).toBe(false);
    for (const bad of [Number.NaN, Infinity, -Infinity, 0, -4, 1001, -0]) {
      const attempt = envelopeOf({
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        targets: [{ line_ref: 'l1', source_text: '1 cup cream' }],
        base_servings: bad,
      });
      expect(attempt.ok, `base_servings ${String(bad)}`).toBe(false);
    }
  });

  it('a valid base_servings is accepted and is NOT nutrition authority', () => {
    const result = envelopeOf({
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      targets: [{ line_ref: 'l1', source_text: '1 cup cream' }],
      base_servings: 6,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.base_servings).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 6. RECIPE-CONTEXT ENVELOPE (R1) + PRIVACY KEY SET (§4 / §17)
// ---------------------------------------------------------------------------
describe('RecipeContextEnvelope — separate, narrow, and privacy-pinned', () => {
  function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
      provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
      targets: [{ line_ref: 'l1', source_text: '1 cup cream' }],
      ...overrides,
    };
  }

  it('a minimal valid envelope is accepted', () => {
    const result = envelopeOf(envelope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.envelope).sort()).toEqual([
      'contract_version',
      'provenance_class',
      'targets',
    ]);
    expect(Object.keys(result.envelope.targets[0]).sort()).toEqual([
      'line_ref',
      'source_text',
    ]);
  });

  it('the full allowed key set is exactly the approved boundary', () => {
    const result = envelopeOf(
      envelope({
        title: 'Creamy soup',
        base_servings: 4,
        targets: [
          {
            line_ref: 'l1',
            source_text: '2 tbsp parsley, for garnish',
            food_semantics: 'parsley',
            instruction_slots: ['slot-a'],
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.envelope).sort()).toEqual([
      'base_servings',
      'contract_version',
      'provenance_class',
      'targets',
      'title',
    ]);
    expect(Object.keys(result.envelope.targets[0]).sort()).toEqual([
      'food_semantics',
      'instruction_slots',
      'line_ref',
      'source_text',
    ]);
  });

  it('PRIVACY: every excluded private/authority field is refused', () => {
    const excluded = [
      'notes',
      'description',
      'tags',
      'category',
      'cuisine',
      'image',
      'source',
      'rawMarkdown',
      'frontmatter',
      'dataviewFields',
      'wikilinks',
      'filePath',
      'fileName',
      'id',
      'recipe_key',
      'sessionIdentity',
      'request_id',
      'servings',
      'instructions',
      'calories',
      'nutrition',
      'codexNutrition',
    ];
    for (const key of excluded) {
      const result = envelopeOf(envelope({ [key]: 'leak' }));
      expect(result.ok, key).toBe(false);
      if (!result.ok) {
        expect(
          result.code === 'invalid_envelope' || result.code === 'authority_field',
          `${key} -> ${result.code}`
        ).toBe(true);
      }
    }
  });

  it('PRIVACY: excluded fields are refused on a TARGET too', () => {
    for (const key of ['notes', 'filePath', 'recipe_key', 'rawMarkdown', 'instructions']) {
      const result = envelopeOf(
        envelope({ targets: [{ line_ref: 'l1', source_text: '1 cup cream', [key]: 'leak' }] })
      );
      expect(result.ok, key).toBe(false);
    }
  });

  it('no source-object spreading: a raw recipe is refused wholesale', () => {
    const rawRecipe = {
      id: 'r1',
      fileName: 'Soup.md',
      filePath: '/vault/Soup.md',
      title: 'Soup',
      tags: ['soup'],
      category: 'Dinner',
      cuisine: 'American',
      difficulty: 'Easy',
      rating: 5,
      ingredients: [{ original: '1 cup cream' }],
      instructions: [{ stepNumber: 1, text: 'Simmer.' }],
      rawMarkdown: '# Soup',
      dataviewFields: {},
      wikilinks: [],
      callouts: [],
    };
    const result = envelopeOf(rawRecipe);
    expect(result.ok).toBe(false);
    // A raw recipe is refused at its FIRST offending key; whichever
    // classification fires, no recipe field ever survives into the envelope.
    if (!result.ok) {
      expect(
        result.code === 'authority_field' || result.code === 'invalid_envelope',
        result.code
      ).toBe(true);
    }
  });

  it('empty and oversized target sets are refused', () => {
    expect(envelopeOf(envelope({ targets: [] })).ok).toBe(false);
    const many = Array.from({ length: MAX_RECIPE_CONTEXT_TARGETS + 1 }, (_, i) => ({
      line_ref: `r${i}`,
      source_text: '1 cup cream',
    }));
    expect(envelopeOf(envelope({ targets: many })).ok).toBe(false);
  });

  it('a duplicate target line_ref is refused', () => {
    const result = envelopeOf(
      envelope({
        targets: [
          { line_ref: 'l1', source_text: '1 cup cream' },
          { line_ref: 'l1', source_text: '1 cup milk' },
        ],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate_line_ref');
  });

  it('bounded title / source text are exact at the limit', () => {
    const longTitle = 'x'.repeat(MAX_RECIPE_CONTEXT_TITLE_LENGTH + 1);
    expect(envelopeOf(envelope({ title: longTitle })).ok).toBe(false);
    const longText = 'x'.repeat(MAX_RECIPE_CONTEXT_SOURCE_TEXT_LENGTH + 1);
    expect(
      envelopeOf(
        envelope({ targets: [{ line_ref: 'l1', source_text: longText }] })
      ).ok
    ).toBe(false);
  });

  it('a successful envelope is frozen and carries no unexpected key', () => {
    const result = envelopeOf(envelope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.envelope)).toBe(true);
    expect(Object.isFrozen(result.envelope.targets)).toBe(true);
    expect(Object.isFrozen(result.envelope.targets[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. RELATION GRAPH VALIDATOR (§9)
// ---------------------------------------------------------------------------
describe('AI-4A relation graph validator', () => {
  function interp(lineRef: string, relations: ReadonlyArray<{ kind: string; target_ref: string }>) {
    return {
      line_ref: lineRef,
      role: 'unknown',
      relations,
      preparation_hints: [],
    } as unknown as AiRecipeContextInterpretation;
  }

  it('an empty graph is valid', () => {
    expect(graphOf([], [])).toEqual({ ok: true, lineCount: 0 });
  });

  it('a simple divided_into is valid', () => {
    const result = graphOf(
      [interp('l1', [{ kind: 'divided_into', target_ref: 'l2' }]), interp('l2', [])],
      REFS
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lineCount).toBe(2);
  });

  it('an unknown relation target is refused', () => {
    const result = graphOf(
      [interp('l1', [{ kind: 'same_as', target_ref: 'nope' }])],
      REFS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown_relation_target');
  });

  it('a self relation is refused', () => {
    const result = graphOf(
      [interp('l1', [{ kind: 'same_as', target_ref: 'l1' }])],
      REFS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('self_relation');
  });

  it('a two-node cycle is refused', () => {
    const result = graphOf(
      [
        interp('l1', [{ kind: 'same_as', target_ref: 'l2' }]),
        interp('l2', [{ kind: 'same_as', target_ref: 'l1' }]),
      ],
      REFS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('circular_relation');
  });

  it('a three-node cycle is refused', () => {
    const result = graphOf(
      [
        interp('l1', [{ kind: 'duplicate_of', target_ref: 'l2' }]),
        interp('l2', [{ kind: 'duplicate_of', target_ref: 'l3' }]),
        interp('l3', [{ kind: 'duplicate_of', target_ref: 'l1' }]),
      ],
      REFS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('circular_relation');
  });

  it('a duplicate relation is refused', () => {
    const result = graphOf(
      [
        interp('l1', [
          { kind: 'same_as', target_ref: 'l2' },
          { kind: 'same_as', target_ref: 'l2' },
        ]),
      ],
      REFS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate_relation');
  });

  it('multiple parents for one target are refused', () => {
    const result = graphOf(
      [
        interp('l1', [{ kind: 'divided_into', target_ref: 'l3' }]),
        interp('l2', [{ kind: 'divided_into', target_ref: 'l3' }]),
      ],
      REFS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('multiple_parents');
  });

  it('multiple parents for reserved_from are refused', () => {
    const result = graphOf(
      [
        interp('l1', [{ kind: 'reserved_from', target_ref: 'l3' }]),
        interp('l2', [{ kind: 'reserved_from', target_ref: 'l3' }]),
      ],
      REFS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('multiple_parents');
  });

  it('a NON-single-parent relation may target a line twice from different sources', () => {
    const result = graphOf(
      [
        interp('l1', [{ kind: 'duplicate_of', target_ref: 'l3' }]),
        interp('l2', [{ kind: 'duplicate_of', target_ref: 'l3' }]),
      ],
      REFS
    );
    expect(result.ok).toBe(true);
  });

  it('an over-deep chain is refused, never stack-exhausted', () => {
    const deep: AiRecipeContextInterpretation[] = [];
    for (let i = 0; i < 20; i += 1) {
      deep.push(interp(`d${i}`, [{ kind: 'duplicate_of', target_ref: `d${i + 1}` }]));
    }
    const allowed = deep.map((_, i) => `d${i}`).concat('d20');
    const result = graphOf(deep, allowed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('relation_depth_exceeded');
  });
});

// ---------------------------------------------------------------------------
// 8. R2 — RAW OUTPUT HAS ZERO SUPPRESSION AUTHORITY
// ---------------------------------------------------------------------------
describe('AI-4A raw output carries NO suppression authority (R2)', () => {
  it('every suppression/auto-apply key is denied', () => {
    for (const key of ['suppress', 'suppression', 'suppress_ai3', 'auto_apply', 'auto_accept', 'silent']) {
      expect(AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS.has(key), key).toBe(true);
    }
  });

  it('a model cannot declare itself authoritative', () => {
    for (const key of ['authority_class', 'authorization', 'apply_token', 'application_authorized', 'user_confirmed']) {
      expect(AI_RECIPE_CONTEXT_FORBIDDEN_AUTHORITY_KEYS.has(key), key).toBe(true);
    }
  });

  it('the interpretation key set cannot express a gate or a flag effect', () => {
    const result = sanitize(
      proposal([
        row({ role: 'garnish' }),
        row({ line_ref: 'l2', role: 'cooking_medium', abstain_reason: 'insufficient_evidence' }),
      ])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = Object.keys(result.proposal.interpretations[0]).sort();
    expect(keys).toEqual(['line_ref', 'preparation_hints', 'relations', 'role']);
  });
});