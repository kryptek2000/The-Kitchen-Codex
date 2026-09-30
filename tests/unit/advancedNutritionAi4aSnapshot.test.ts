/**
 * AI-4A — RECIPE-CONTEXT SNAPSHOT BINDING + CURRENTNESS.
 *
 * PURE, OFFLINE, LOCAL ONLY. The binding never crosses the wire, never persists
 * and never exposes a path, a secret or a provider identifier.
 *
 * The load-bearing property is two-sided:
 *   1. the binding MUST CHANGE when any participating recipe-context fact moves;
 *   2. the binding MUST NOT CHANGE when a NON-participating private field moves.
 *
 * (2) is what keeps the binding from becoming a covert channel for vault content
 * it has no business hashing, and what keeps a file rename from masquerading as
 * recipe identity.
 */
import { describe, it, expect } from 'vitest';

import {
  AI_RECIPE_CONTEXT_CONTRACT_VERSION,
  AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
} from '../../src/core/nutritionV2/phase4/recipeContextContract';
import {
  RECIPE_CONTEXT_SNAPSHOT_FIELDS,
  recipeContextSnapshotBinding,
  recipeContextSnapshotDigest,
  recipeContextSnapshotInputFromEnvelope,
  recipeContextSnapshotPayload,
  sanitizeRecipeContextSnapshotInput,
  isRecipeContextSnapshotCurrent,
  MAX_RECIPE_CONTEXT_INSTANCES_TOKEN,
  type RecipeContextSnapshotInput,
} from '../../src/core/nutritionV2/phase4/recipeContextSnapshot';

/** Permissive result view; vitest's `expect` does not narrow unions. */
interface SnapshotView {
  readonly ok: boolean;
  readonly code?: string;
  readonly snapshot?: RecipeContextSnapshotInput;
}

function sanitize(raw: unknown): SnapshotView {
  return sanitizeRecipeContextSnapshotInput(raw) as SnapshotView;
}

function snapshot(
  overrides: Partial<RecipeContextSnapshotInput> = {}
): RecipeContextSnapshotInput {
  return {
    title: 'Creamy chicken soup',
    targets: [
      { line_ref: 'l1', source_text: '2 tbsp parsley, for garnish', instruction_slots: ['s1'] },
      { line_ref: 'l2', source_text: '1 can (15 oz) chickpeas, drained', instruction_slots: [] },
      { line_ref: 'l3', source_text: '1 onion, divided', instruction_slots: ['s2'] },
    ],
    base_servings: 6,
    recipe_instance: 'instance-alpha-1',
    ...overrides,
  };
}

const base = snapshot();

// ---------------------------------------------------------------------------
// 1. THE BINDING EXISTS AND IS DETERMINISTIC
// ---------------------------------------------------------------------------
describe('AI-4A snapshot binding is deterministic and local', () => {
  it('the same input produces the SAME binding and digest', () => {
    expect(recipeContextSnapshotBinding(snapshot())).toBe(recipeContextSnapshotBinding(snapshot()));
    expect(recipeContextSnapshotDigest(snapshot())).toBe(recipeContextSnapshotDigest(snapshot()));
  });

  it('the digest uses the ESTABLISHED sha256:<hex> convention', () => {
    expect(recipeContextSnapshotDigest(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the digest is bound to a DIFFERENT convention than the key form (no invented 2nd digest)', () => {
    // `stableChoiceKey` form is JSON-ish, not a hex digest.
    expect(recipeContextSnapshotBinding(base)).not.toMatch(/^sha256:/);
    expect(recipeContextSnapshotDigest(base)).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('the payload contains ONLY the approved bound fields', () => {
    const payload = recipeContextSnapshotPayload(base);
    expect(Object.keys(payload).sort()).toEqual([...RECIPE_CONTEXT_SNAPSHOT_FIELDS].sort());
    expect(payload['contract']).toBe(AI_RECIPE_CONTEXT_CONTRACT_VERSION);
    expect(payload['provenance']).toBe(AI_RECIPE_CONTEXT_PROVENANCE_CLASS);
  });

  it('the payload carries NO path, NO credential and NO catalog internals', () => {
    const text = JSON.stringify(recipeContextSnapshotPayload(base));
    for (const banned of [
      'filePath',
      'fileName',
      '.md',
      'rawMarkdown',
      'notes',
      'fdc_id',
      'record_digest',
      'catalog_digest',
      'bundle_release',
      'api_key',
      'token',
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it('target payloads use the short positional key convention', () => {
    const payload = recipeContextSnapshotPayload(base);
    expect(Object.keys((payload['targets'] as Array<Record<string, unknown>>)[0]).sort()).toEqual([
      'line',
      'slots',
      'text',
    ]);
  });

  it('null optional fields are still bound (absent is not the same as null-free)', () => {
    const withNulls = snapshot({ title: null, base_servings: null, recipe_instance: null });
    expect(recipeContextSnapshotBinding(withNulls)).not.toBe(recipeContextSnapshotBinding(base));
  });
});

// ---------------------------------------------------------------------------
// 2. THE BINDING MUST CHANGE (§16)
// ---------------------------------------------------------------------------
describe('AI-4A snapshot MUST change when a bound fact changes', () => {
  it('a different title changes the binding', () => {
    expect(recipeContextSnapshotBinding(snapshot({ title: 'Chicken soup' }))).not.toBe(
      recipeContextSnapshotBinding(base)
    );
  });

  it('adding a target changes the binding', () => {
    expect(
      recipeContextSnapshotBinding(
        snapshot({
          targets: [
            ...base.targets,
            { line_ref: 'l4', source_text: '2 cups stock', instruction_slots: [] },
          ],
        })
      )
    ).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('REORDERING the target set changes the binding (order is bound)', () => {
    expect(
      recipeContextSnapshotBinding(snapshot({ targets: [...base.targets].reverse() }))
    ).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('removing a target changes the binding', () => {
    expect(
      recipeContextSnapshotBinding(snapshot({ targets: base.targets.slice(0, 2) }))
    ).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('changing a target authored text changes the binding', () => {
    const changed = snapshot({
      targets: [
        { ...base.targets[0], source_text: '2 tbsp parsley, chopped' },
        base.targets[1],
        base.targets[2],
      ],
    });
    expect(recipeContextSnapshotBinding(changed)).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('changing a target line_ref changes the binding', () => {
    const changed = snapshot({
      targets: [{ ...base.targets[0], line_ref: 'other' }, base.targets[1], base.targets[2]],
    });
    expect(recipeContextSnapshotBinding(changed)).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('changing base_servings changes the binding', () => {
    expect(recipeContextSnapshotBinding(snapshot({ base_servings: 8 }))).not.toBe(
      recipeContextSnapshotBinding(base)
    );
  });

  it('changing an instruction-evidence slot changes the binding', () => {
    const changed = snapshot({
      targets: [
        { ...base.targets[0], instruction_slots: ['s1', 's9'] },
        base.targets[1],
        base.targets[2],
      ],
    });
    expect(recipeContextSnapshotBinding(changed)).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('emptying an instruction-evidence slot changes the binding', () => {
    const changed = snapshot({
      targets: [{ ...base.targets[0], instruction_slots: [] }, base.targets[1], base.targets[2]],
    });
    expect(recipeContextSnapshotBinding(changed)).not.toBe(recipeContextSnapshotBinding(base));
  });

  it('changing the recipe-instance binding changes the binding', () => {
    expect(recipeContextSnapshotBinding(snapshot({ recipe_instance: 'instance-alpha-2' }))).not.toBe(
      recipeContextSnapshotBinding(base)
    );
  });

  it('each mutation changes the DIGEST too (both forms track every field)', () => {
    expect(recipeContextSnapshotDigest(snapshot({ title: 'x' }))).not.toBe(
      recipeContextSnapshotDigest(base)
    );
    expect(recipeContextSnapshotDigest(snapshot({ base_servings: 2 }))).not.toBe(
      recipeContextSnapshotDigest(base)
    );
  });
});

// ---------------------------------------------------------------------------
// 3. THE BINDING MUST NOT CHANGE (§16)
// ---------------------------------------------------------------------------
describe('AI-4A snapshot MUST NOT change for non-participating private fields', () => {
  it('unrelated private metadata cannot even ENTER the snapshot input', () => {
    for (const key of [
      'notes',
      'description',
      'tags',
      'category',
      'cuisine',
      'image',
      'source',
      'rawMarkdown',
      'frontmatter',
      'filePath',
      'fileName',
      'wikilinks',
      'dataviewFields',
      'recipe_key',
      'sessionIdentity',
      'request_id',
    ]) {
      const result = sanitize({ ...base, [key]: 'leak' });
      expect(result.ok, key).toBe(false);
      if (!result.ok) {
        expect(result.code === 'authority_field' || result.code === 'invalid_snapshot', key).toBe(
          true
        );
      }
    }
  });

  it('a denied key on a snapshot TARGET cannot enter either', () => {
    for (const key of ['notes', 'filePath', 'recipe_key', 'fdc_id', 'consumption_fraction']) {
      const result = sanitize({
        ...base,
        targets: [{ ...base.targets[0], [key]: 'leak' }],
      });
      expect(result.ok, key).toBe(false);
    }
  });

  it('provider / catalog state is not part of the binding surface', () => {
    // There is no field for it at all: the closed key set admits none.
    const result = sanitize({
      ...base,
      provider: 'openrouter',
    });
    expect(result.ok).toBe(false);
  });

  it('the binding is a pure function of the bound input alone', () => {
    // Two structurally identical inputs built independently agree.
    const a = recipeContextSnapshotBinding(snapshot());
    const b = recipeContextSnapshotBinding(snapshot());
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 4. SNAPSHOT INPUT SANITIZER — fail closed
// ---------------------------------------------------------------------------
describe('AI-4A snapshot input sanitizer', () => {
  it('a minimal valid snapshot is accepted', () => {
    const result = sanitize({
      targets: [{ line_ref: 'l1', source_text: '1 cup cream' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.title).toBeNull();
      expect(result.snapshot.base_servings).toBeNull();
      expect(result.snapshot.recipe_instance).toBeNull();
      expect(result.snapshot.targets[0].instruction_slots).toEqual([]);
    }
  });

  it('empty and oversized target sets are refused', () => {
    expect(sanitize({ targets: [] }).ok).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => ({
      line_ref: `r${i}`,
      source_text: '1 cup cream',
    }));
    expect(sanitize({ targets: many }).ok).toBe(false);
  });

  it('a duplicate target line_ref is refused', () => {
    const result = sanitize({
      targets: [
        { line_ref: 'l1', source_text: '1 cup cream' },
        { line_ref: 'l1', source_text: '1 cup milk' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate_line_ref');
  });

  it('non-finite / out-of-range servings are refused', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, 0, -1, 1001, -0]) {
      const result = sanitize({ ...base, base_servings: bad });
      expect(result.ok, String(bad)).toBe(false);
    }
  });

  it('an over-long recipe-instance token is refused (never a path smuggle)', () => {
    const result = sanitize({
      ...base,
      recipe_instance: 'x'.repeat(MAX_RECIPE_CONTEXT_INSTANCES_TOKEN + 1),
    });
    expect(result.ok).toBe(false);
  });

  it('a non-string, non-plain value fails closed', () => {
    expect(sanitize(new Date(0)).ok).toBe(false);
    expect(sanitize(undefined).ok).toBe(false);
    expect(sanitize('x').ok).toBe(false);
  });

  it('a successful snapshot is frozen', () => {
    const result = sanitize(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.targets)).toBe(true);
    expect(Object.isFrozen(result.snapshot.targets[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. ENVELOPE -> SNAPSHOT DERIVATION (AI-4A owns no recipe wiring)
// ---------------------------------------------------------------------------
describe('AI-4A snapshot derives from a SANITIZED envelope only', () => {
  it('derives a snapshot from a valid envelope plus a local instance token', () => {
    const result = recipeContextSnapshotInputFromEnvelope(
      {
        contract_version: AI_RECIPE_CONTEXT_CONTRACT_VERSION,
        provenance_class: AI_RECIPE_CONTEXT_PROVENANCE_CLASS,
        title: 'Creamy soup',
        base_servings: 6,
        targets: [{ line_ref: 'l1', source_text: '2 tbsp parsley, for garnish' }],
      },
      'instance-alpha-1'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.title).toBe('Creamy soup');
    expect(result.snapshot.base_servings).toBe(6);
    expect(result.snapshot.recipe_instance).toBe('instance-alpha-1');
    expect(result.snapshot.targets).toHaveLength(1);
    expect(result.snapshot.targets[0].instruction_slots).toEqual([]);
  });

  it('a non-envelope input is refused', () => {
    expect(recipeContextSnapshotInputFromEnvelope(null as never).ok).toBe(false);
    expect(recipeContextSnapshotInputFromEnvelope({ targets: 'x' } as never).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. CURRENTNESS
// ---------------------------------------------------------------------------
describe('AI-4A snapshot currentness', () => {
  it('an unchanged binding is CURRENT', () => {
    const captured = recipeContextSnapshotBinding(base);
    const current = recipeContextSnapshotBinding(snapshot());
    expect(isRecipeContextSnapshotCurrent(captured, current)).toBe(true);
  });

  it('a changed binding is NOT current', () => {
    const captured = recipeContextSnapshotBinding(base);
    const current = recipeContextSnapshotBinding(snapshot({ base_servings: 4 }));
    expect(isRecipeContextSnapshotCurrent(captured, current)).toBe(false);
  });

  it('currentness FAILS CLOSED on a malformed captured binding', () => {
    const current = recipeContextSnapshotBinding(base);
    for (const bad of [undefined, null, '', 0, false, {}, [], Number.NaN]) {
      expect(isRecipeContextSnapshotCurrent(bad, current), String(bad)).toBe(false);
      expect(isRecipeContextSnapshotCurrent(current, bad), String(bad)).toBe(false);
    }
  });

  it('the digest form is equally usable for currentness', () => {
    const captured = recipeContextSnapshotDigest(base);
    expect(isRecipeContextSnapshotCurrent(captured, recipeContextSnapshotDigest(base))).toBe(true);
    expect(
      isRecipeContextSnapshotCurrent(captured, recipeContextSnapshotDigest(snapshot({ title: 'y' })))
    ).toBe(false);
  });
});