/**
 * The Kitchen Codex — SHISO H-2R conversation execution repair.
 *
 * OFFLINE. No live provider calls, no vault writes.
 *
 * The human browser test failed with:
 *   "Shiso could not read the model response. Please try again."
 * after the user answered "yes" to a pending edit question. The exact failure
 * stage was `parseShisoDecision` returning null: a syntactically valid
 * `tool_request` for a REAL tool whose args were unusable (a model trying to
 * apply an edit without the current line handle) was treated as an UNREADABLE
 * response and destroyed the whole turn.
 *
 * These tests pin the repair:
 *   1. unusable args for a KNOWN tool become a bounded repair request that the
 *      browser refuses with a precise observation (the model can correct itself
 *      within the same message);
 *   2. genuinely invalid decisions (unknown tool, empty reply) still fail as
 *      invalid responses — the closed vocabulary is unchanged;
 *   3. an affirmative "yes" to a pending edit executes the edit through the
 *      real application applier;
 *   4. a failed edit is never reported as a change, and the deterministic
 *      fallback says so plainly;
 *   5. a bare "yes" never satisfies the save-authorization boundary.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseShisoDecision } from '../../server/shiso/conversationTurn';
import { executeShisoTool, type ShisoToolContext } from '../../src/application/shisoTools';
import {
  initialShisoConversation,
  runShisoConversationTurn,
} from '../../src/application/shisoConversation';
import { classifySaveIntent } from '../../src/core/shiso/saveAuthorization';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';

beforeAll(async () => {
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
});

// ===========================================================================
// 1. Decision parsing: salvage vs genuine contract violations
// ===========================================================================

describe('H-2R — decision parsing', () => {
  it('accepts a valid structured edit tool call', () => {
    const decision = parseShisoDecision({
      kind: 'tool_request',
      tool: 'apply_ingredient_edits',
      args: {
        tool: 'apply_ingredient_edits',
        edits: [{ line_ref: 'ing:1:abcd', new_name: 'jalapeño' }],
      },
    });
    expect(decision).not.toBeNull();
    if (decision === null || decision.kind !== 'tool_request') return;
    expect(decision.tool).toBe('apply_ingredient_edits');
    expect((decision.args as unknown as { edits: unknown[] }).edits).toHaveLength(1);
  });

  it('an edit request with NO edits becomes a bounded repair request, not an unreadable response', () => {
    for (const args of [{}, { tool: 'apply_ingredient_edits' }, { edits: [] }]) {
      const decision = parseShisoDecision({
        kind: 'tool_request',
        tool: 'apply_ingredient_edits',
        args,
      });
      expect(decision, JSON.stringify(args)).not.toBeNull();
      if (decision === null || decision.kind !== 'tool_request') continue;
      expect(decision.tool).toBe('apply_ingredient_edits');
      expect((decision.args as unknown as { edits: unknown[] }).edits).toEqual([]);
    }
  });

  it('an edit entry missing its line_ref is dropped, leaving the repair request', () => {
    const decision = parseShisoDecision({
      kind: 'tool_request',
      tool: 'apply_ingredient_edits',
      args: { edits: [{ new_name: 'jalapeño' }] },
    });
    expect(decision).not.toBeNull();
    if (decision === null || decision.kind !== 'tool_request') return;
    expect((decision.args as unknown as { edits: unknown[] }).edits).toEqual([]);
  });

  it('other required-but-missing args also become bounded repair requests', () => {
    const cases: ReadonlyArray<{ tool: string; args: unknown; check: (args: Record<string, unknown>) => void }> = [
      { tool: 'investigate_ingredient_amount', args: {}, check: (a) => expect(a['line_ref']).toBe('') },
      { tool: 'search_usda_foods', args: {}, check: (a) => expect(a['query']).toBe('') },
      { tool: 'inspect_usda_food', args: {}, check: (a) => expect(a['fdc_id']).toBe(0) },
      {
        tool: 'apply_nutrition_corrections',
        args: { line_refs: 'all' },
        check: (a) => expect(a['line_refs']).toEqual([]),
      },
    ];
    for (const c of cases) {
      const decision = parseShisoDecision({ kind: 'tool_request', tool: c.tool, args: c.args });
      expect(decision, c.tool).not.toBeNull();
      if (decision === null || decision.kind !== 'tool_request') continue;
      expect(decision.tool).toBe(c.tool);
      c.check(decision.args as unknown as Record<string, unknown>);
    }
  });

  it('a genuinely invalid decision is still refused (closed vocabulary unchanged)', () => {
    // Unknown tool, unknown kind, empty reply, non-object.
    expect(parseShisoDecision({ kind: 'tool_request', tool: 'write_vault', args: {} })).toBeNull();
    expect(parseShisoDecision({ kind: 'tool_request' })).toBeNull();
    expect(parseShisoDecision({ kind: 'reply', text: '   ' })).toBeNull();
    expect(parseShisoDecision({ kind: 'reply' })).toBeNull();
    expect(parseShisoDecision(null)).toBeNull();
    expect(parseShisoDecision('{}')).toBeNull();
    // A valid reply still parses.
    const reply = parseShisoDecision({ kind: 'reply', text: 'Done.' });
    expect(reply).not.toBeNull();
    if (reply !== null) expect(reply.kind).toBe('reply');
  });
});

// ===========================================================================
// 2. The browser refuses salvaged args with PRECISE observations
// ===========================================================================

describe('H-2R — salvaged args are refused precisely by the application', () => {
  const ctx = (overrides: Partial<ShisoToolContext> = {}): ShisoToolContext => ({
    session: null,
    recipe: {
      title: 'Salsa',
      servings: 4,
      ingredients: [{ text: '2 jalapenos', name: 'jalapenos', line_ref: 'ing:1:abcd' }],
      instructions: [],
    },
    nutrition: { rows: [], summary: null, unsaved: false },
    ...overrides,
  });

  it('empty edits → invalid_arguments (never a silent change)', async () => {
    const obs = await executeShisoTool({ tool: 'apply_ingredient_edits', edits: [] }, ctx());
    expect(obs.ok).toBe(false);
    if (!obs.ok) expect((obs as { code?: string }).code).toBe('invalid_arguments');
  });

  it('an empty line_ref → unknown_line_ref', async () => {
    const obs = await executeShisoTool(
      { tool: 'investigate_ingredient_amount', line_ref: '' },
      ctx(),
    );
    expect(obs.ok).toBe(false);
    if (!obs.ok) expect((obs as { code?: string }).code).toBe('unknown_line_ref');
  });

  it('an empty corrections subset corrects NOTHING (never widened to everything)', async () => {
    const seen: Array<readonly string[] | undefined> = [];
    const obs = await executeShisoTool(
      { tool: 'apply_nutrition_corrections', line_refs: [] },
      ctx({
        nutrition: { rows: [], summary: null, unsaved: false },
        session: {} as never,
        applyNutritionCorrections: async (lineRefs) => {
          seen.push(lineRefs);
          return {
            ok: false,
            applied: [],
            unresolved: [],
            summary: 'No ingredient lines were specified for correction.',
            resolved_count: 0,
            total_count: 0,
            recalculation: 'absent',
            working_unsaved: false,
          };
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);
    expect(obs.ok).toBe(true);
    if (obs.ok) expect(obs.data['applied_count']).toBe(0);
  });
});

// ===========================================================================
// 3. The exact conversation: "yes" to a pending edit executes it
// ===========================================================================

interface CapturedRequest {
  readonly body: Record<string, unknown>;
}

function scriptedNetwork(script: unknown[]): { network: NetworkAdapter; requests: CapturedRequest[] } {
  let index = 0;
  const requests: CapturedRequest[] = [];
  const network = {
    post: async (path: string, body: unknown) => {
      if (path !== '/api/shiso/turn') return { status: 404, ok: false, data: {} };
      requests.push({ body: body as Record<string, unknown> });
      const entry = script[Math.min(index, script.length - 1)];
      index += 1;
      if (entry !== null && typeof entry === 'object' && 'fail' in (entry as Record<string, unknown>)) {
        const spec = (entry as { fail: { code: string; message: string } }).fail;
        return { status: 503, ok: false, data: { ok: false, code: spec.code, message: spec.message, aiAttempted: true } };
      }
      return { status: 200, ok: true, data: entry };
    },
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
  return { network, requests };
}

function turn(n: number, kind: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    kind,
    ...extra,
    model_invocations_used: n,
    tool_calls_used: Math.max(0, n - 1),
  };
}

const RECIPE_CONTEXT = {
  recipe: null,
  nutrition: {
    available: false,
    summary: null,
    unresolvedCount: 0,
    needsAmountCount: 0,
    needsMatchCount: 0,
    unsavedWorkingReview: false,
  },
  recipeKey: 'k1',
  sessionIdentity: 's1',
} as const;

function editToolContext(applyEdits: (edits: readonly unknown[]) => Promise<unknown>): ShisoToolContext {
  return {
    session: null,
    recipe: {
      title: 'Salsa',
      servings: 4,
      ingredients: [{ text: '2 jalapenos', name: 'jalapenos', line_ref: 'ing:1:abcd' }],
      instructions: [],
    },
    nutrition: null,
    applyIngredientEdits: applyEdits as never,
  };
}

describe('H-2R — the human-test conversation', () => {
  it('"yes" to a pending edit: SHISO re-reads the recipe and APPLIES the edit', async () => {
    const editsSeen: unknown[] = [];
    const { network, requests } = scriptedNetwork([
      // The model needs the current handles before it can address the line.
      turn(1, 'tool_request', { tool: 'get_current_recipe', args: { tool: 'get_current_recipe' } }),
      // Then it applies the confirmed edit with the handle it just read.
      turn(2, 'tool_request', {
        tool: 'apply_ingredient_edits',
        args: { tool: 'apply_ingredient_edits', edits: [{ line_ref: 'ing:1:abcd', new_name: 'jalapeño' }] },
      }),
      turn(3, 'reply', {
        text: 'Done — renamed it to jalapeño. These changes are in your UNSAVED working copy.',
        proposals: [],
      }),
    ]);

    const outcome = await runShisoConversationTurn(
      {
        network,
        context: RECIPE_CONTEXT as never,
        toolContext: editToolContext(async (edits) => {
          editsSeen.push(...edits);
          return {
            ok: true,
            applied: [
              {
                line_ref: 'ing:1:abcd',
                before: '2 jalapenos',
                after: '2 jalapeño',
                changes: ['name: "jalapenos" → "jalapeño"'],
              },
            ],
            refused: [],
            summary: 'Applied 1 ingredient change(s) to the UNSAVED working copy.',
            working_unsaved: true,
            note: 'Saved: no.',
          };
        }),
      },
      initialShisoConversation(),
      'yes',
    );

    expect(outcome.ok).toBe(true);
    // The edit REALLY executed through the application applier.
    expect(editsSeen).toHaveLength(1);
    expect(editsSeen[0]).toMatchObject({ line_ref: 'ing:1:abcd', new_name: 'jalapeño' });
    expect(outcome.toolsUsed).toEqual(['get_current_recipe', 'apply_ingredient_edits']);
    // The application confirmed the change back to the model as a finding.
    expect(
      outcome.state.findings.some(
        (f) => f.tool === 'apply_ingredient_edits' && /Applied 1 ingredient change/.test(f.summary),
      ),
    ).toBe(true);
    // The turn completed with the model's honest reply; three provider round trips max.
    expect(outcome.message).toContain('jalapeño');
    expect(requests).toHaveLength(3);
  }, 60000);

  it('a MALFORMED edit request is reported to the model as invalid_arguments, and nothing is applied', async () => {
    const editsSeen: unknown[] = [];
    const { network, requests } = scriptedNetwork([
      // The model wants to edit but cannot fill the args (the pre-repair killer).
      turn(1, 'tool_request', { tool: 'apply_ingredient_edits', args: { tool: 'apply_ingredient_edits' } }),
      turn(2, 'reply', { text: 'I could not apply that edit. Let me re-read the recipe.', proposals: [] }),
    ]);

    const outcome = await runShisoConversationTurn(
      {
        network,
        context: RECIPE_CONTEXT as never,
        toolContext: editToolContext(async (edits) => {
          editsSeen.push(...edits);
          throw new Error('must never be called for an empty edit list');
        }),
      },
      initialShisoConversation(),
      'yes',
    );

    expect(outcome.ok).toBe(true);
    expect(editsSeen).toHaveLength(0);
    // The turn SURVIVED: the browser sent the precise failure observation back.
    const followUp = requests[1];
    const observation = followUp?.body['observation'] as { ok: boolean; code?: string } | undefined;
    expect(observation?.ok).toBe(false);
    expect(observation?.code).toBe('invalid_arguments');
  }, 60000);

  it('a failed edit followed by a provider failure preserves findings — and states NO change was applied', async () => {
    const editsSeen: unknown[] = [];
    const { network } = scriptedNetwork([
      turn(1, 'tool_request', { tool: 'get_current_recipe', args: { tool: 'get_current_recipe' } }),
      turn(2, 'tool_request', { tool: 'apply_ingredient_edits', args: { tool: 'apply_ingredient_edits' } }),
      { fail: { code: 'provider_unavailable', message: 'The AI provider could not complete this request.' } },
    ]);

    const outcome = await runShisoConversationTurn(
      {
        network,
        context: RECIPE_CONTEXT as never,
        toolContext: editToolContext(async (edits) => {
          editsSeen.push(...edits);
          throw new Error('must never be called for an empty edit list');
        }),
      },
      initialShisoConversation(),
      'yes',
    );

    expect(editsSeen).toHaveLength(0);
    expect(outcome.ok).toBe(true);
    const message = outcome.message ?? '';
    // Verified findings are preserved…
    expect(message).toContain('get_current_recipe');
    // …and the fallback never implies the recipe was edited.
    expect(message).toContain('No recipe change was applied in this message');
    // Findings are retained for a later continue.
    expect(outcome.state.findings.some((f) => f.tool === 'get_current_recipe')).toBe(true);
  }, 60000);

  it('a bare "yes" is NOT a save authorization (trusted boundary unchanged)', () => {
    for (const message of ['yes', 'ok', 'sure', 'go ahead', 'do it', 'please do', 'yes please']) {
      expect(classifySaveIntent(message).authorized, message).toBe(false);
    }
    // The explicit save command still authorizes.
    expect(classifySaveIntent('yes, save').authorized).toBe(true);
    expect(classifySaveIntent('save my changes').authorized).toBe(true);
  });
});

// ===========================================================================
// 4. Structural pins: the repair lives where it must
// ===========================================================================

describe('H-2R — structural pins', () => {
  const root = join(__dirname, '../..');
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

  it('the server salvages known-tool args instead of ending the turn', () => {
    const server = read('server/shiso/conversationTurn.ts');
    expect(server).toContain('salvageToolArgs');
    expect(server).toContain('args: args ?? salvageToolArgs(tool)');
  });

  it('the prompt covers confirmations, handle re-reads, and bounded retry', () => {
    const prompt = read('server/shiso/conversationTurn.ts');
    expect(prompt).toMatch(/A SHORT \\"YES\\" IS THE GO-AHEAD/);
    expect(prompt).toMatch(/get_current_recipe FIRST/);
    expect(prompt).toMatch(/retry the edit ONCE/);
    expect(prompt).toMatch(/bare \\"yes\\" never authorizes SAVING/);
  });

  it('the deterministic fallback states when no edit succeeded', () => {
    const client = read('src/application/shisoConversation.ts');
    expect(client).toContain('EDITING_TOOLS');
    expect(client).toContain('No recipe change was applied in this message');
  });
});
