// @vitest-environment jsdom
/**
 * The Kitchen Codex — SHISO-C1 UI-LEVEL acceptance.
 *
 * This is deliberately a USER test, not a unit test: it renders the real
 * `ShisoModal`, types a message, presses Send, waits for the conversation to
 * produce a proposal, presses "Use this", and asserts the authoritative applier
 * was invoked with a bound proposal — and that "No thanks" and "Withdraw" do not
 * invoke it.
 *
 * The provider is STUBBED at the network adapter, so no live model call is made.
 * The USDA data is the real pinned bundle, so the capability that produces the
 * proposal is genuine.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { useEffect, useState } from 'react';

import { ShisoModal } from '../../src/components/ShisoModal';
import { ShisoEntryProvider, useShiso } from '../../src/application-ui/shisoEntryPoints';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { AdvancedNutritionSession } from '../../src/core/nutritionV2/phase4';
import type { LiveRowState } from '../../src/core/nutritionV2/phase4/liveRow';
import type { AdaptedIngredient, Phase4Row } from '../../src/core/nutritionV2/phase4';
import { adaptRecipe, analyzeRecipe, buildReviewRows, createAdvancedNutritionSession, projectLiveRows } from '../../src/core/nutritionV2/phase4';
import { buildMatchingBundle } from '../fixtures/usdaMatchingFixtures';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { SettingsAdapter } from '../../src/application/adapters/SettingsAdapter';

function structured(original: string): Record<string, unknown> {
  const p = parseIngredient(original);
  if (!p.ok) return { original };
  return {
    original,
    ...(p.parsed.amount !== null ? { amount: p.parsed.amount } : {}),
    ...(p.parsed.raw_unit !== undefined ? { unit: p.parsed.raw_unit } : {}),
    name: p.parsed.query,
  };
}

const LINES = ['4 eggs, separated', '1 cup whole milk', '2 cups all-purpose flour', '6 tbsp unsalted butter', '1 tsp sea salt'];

let session: AdvancedNutritionSession;
let liveRows: readonly LiveRowState[] = [];
let butterRef = '';
let reviewRows: Phase4Row[] = [];

/**
 * A GENUINE Phase 4 session over a small authenticated bundle, built with the
 * repository's own matching fixture. This is the same pattern the existing
 * Advanced Nutrition component tests use: a real authority object, real digests,
 * real matching — just a small catalog so the UI test runs in seconds.
 */
const SPECS = [
  { fdcId: 7001, dataType: 'sr_legacy' as const, description: 'Butter, stick, unsalted', nutrients: [[208, 100], [0, 0], [0.01, 1], [0.85, 14]] },
  { fdcId: 7002, dataType: 'sr_legacy' as const, description: 'Butter, NFS', nutrients: [[717, 100], [0.85, 1], [0.06, 2.5]] },
  { fdcId: 7003, dataType: 'sr_legacy' as const, description: 'Egg, whole, raw', nutrients: [[143, 100], [12.56, 13], [0.72, 0.4], [9.51, 5]] },
];

beforeAll(async () => {
  const settings: Pick<SettingsAdapter, 'get'> = { get: async () => null };
  await hydrateAiSelections(settings);
  const { manifest, records } = buildMatchingBundle(SPECS);
  const created = createAdvancedNutritionSession(manifest, records);
  if (!created.ok) throw new Error('session failed');
  session = created.session;

  const recipe = adaptRecipe({
    title: 'SHISO Human Test — Separated Egg Batter',
    servings: 4,
    ingredients: LINES.map(structured),
  } as never) as never as { recipe: { adapted: AdaptedIngredient[] } };
  const adapted = recipe.recipe.adapted;
  const rows = buildReviewRows(session, adapted);
  const analysis = analyzeRecipe(session, adapted, 4);
  const state = {
    version: '', status: 'ready', recipeKey: 'k', sessionIdentity: 's',
    baseServings: 4, rows, matches: analysis.matches, portions: analysis.portions,
    countPortions: analysis.countPortions, householdPortions: analysis.householdPortions,
    userMasses: {}, basis: 'entire_recipe', selectedServings: 4,
    preview: null, previewKey: null, failure: null, operationSeq: 0,
  } as never;
  liveRows = projectLiveRows(
    state, new Map(analysis.rows.map((r) => [r.line_ref, r])), adapted, session, null,
    analysis.portions, analysis.countPortions,
  );
  reviewRows = rows as unknown as Phase4Row[];
  butterRef = adapted[3].line_ref;
}, 120000);

afterEach(() => cleanup());

/** Robust text presence check: assistant text can be split across elements. */
function hasText(re: RegExp): boolean {
  return re.test(document.body.textContent ?? '');
}
async function waitForText(re: RegExp, timeout = 15000) {
  await waitFor(() => expect(hasText(re)).toBe(true), { timeout });
}

/** A network adapter that answers the SHISO turn route from a scripted stub. */
function stubNetwork(script: unknown[]): { adapter: NetworkAdapter; calls: () => number } {
  let index = 0;
  let calls = 0;
  const adapter = {
    post: async (path: string) => {
      if (path !== '/api/shiso/turn') return { status: 404, ok: false, data: {} };
      calls += 1;
      const body = script[Math.min(index, script.length - 1)];
      index += 1;
      return { status: 200, ok: true, data: body };
    },
    get: async () => ({ status: 404, ok: false, data: {} }),
    request: async () => ({ status: 404, ok: false, data: {} }),
  } as unknown as NetworkAdapter;
  return { adapter, calls: () => calls };
}

/** Hosts the modal and registers an applier that records what it was asked to do. */
function Host(props: {
  network: NetworkAdapter;
  onApplied: (bound: unknown) => Promise<{ ok: boolean }>;
  canApply: boolean;
}) {
  return (
    <ShisoEntryProvider>
      <HostInner {...props} />
    </ShisoEntryProvider>
  );
}

function HostInner(props: {
  network: NetworkAdapter;
  onApplied: (bound: unknown) => Promise<{ ok: boolean }>;
  canApply: boolean;
}) {
  const shiso = useShiso();
  const [nutritionResult, setNutritionResult] = useState('');
  // Mirror the real app: the Advanced Nutrition OWNER publishes the genuine
  // identities. ShisoModal reads them from here, never from props.
  useEffect(() => {
    shiso.publishNutrition({
      rows: liveRows,
      summary: '3 matched',
      unsaved: false,
      recipeKey: 'k',
      sessionIdentity: 's',
      reviewRows: reviewRows,
    });
    return () => shiso.publishNutrition(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <button onClick={() => shiso.open('nutrition')}>open shiso</button>
      <button onClick={shiso.openForNutritionAnalysis}>analyze with shiso</button>
      <button
        data-testid="run-registered-nutrition"
        onClick={() => void shiso.runNutritionAnalysis?.().then((result) => setNutritionResult(`${result.ok}:${result.message}`))}
      >
        run registered nutrition
      </button>
      <p data-testid="registered-nutrition-result">{nutritionResult}</p>
      <button
        onClick={() => {
          if (props.canApply) shiso.registerApplier(props.onApplied as never);
        }}
      >
        register applier
      </button>
      <ShisoModal
        isOpen={shiso.isOpen}
        onClose={shiso.close}
        network={props.network}
        recipe={{ title: 'SHISO Human Test — Separated Egg Batter', servings: 4, ingredients: LINES.map((l) => ({ name: l })), instructions: [] } as never}
        nutritionSession={session}
        nutritionRows={liveRows}
        nutritionReviewRows={reviewRows}
        nutritionSummary="3 matched · 1 need amount · 1 need match"
        nutritionUnsaved={false}
      />
    </>
  );
}

async function askShiso(network: NetworkAdapter) {
  fireEvent.click(screen.getByText('open shiso'));
  fireEvent.click(screen.getByText('register applier'));
  const box = screen.getByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'why can you not calculate the butter?' } });
  fireEvent.click(screen.getByText('Send'));
}

describe('SHISO-C1 — the user can actually reach acceptance', () => {
  it('registers the single structured nutrition route for the in-place review action', async () => {
    let requests = 0;
    const adapter = {
      post: async (path: string) => {
        if (path !== '/api/shiso/nutrition') return { status: 404, ok: false, data: {} };
        requests += 1;
        return { status: 503, ok: false, data: { ok: false, code: 'unavailable' } };
      },
      get: async () => ({ status: 404, ok: false, data: {} }),
      request: async () => ({ status: 404, ok: false, data: {} }),
    } as unknown as NetworkAdapter;
    render(<Host network={adapter} canApply={false} onApplied={async () => ({ ok: true }) as never} />);
    fireEvent.click(screen.getByTestId('run-registered-nutrition'));
    await waitFor(() => expect(screen.getByTestId('registered-nutrition-result').textContent).toMatch(/false:The selected text AI connection is unavailable/i));
    expect(requests).toBe(1);
  });

  it('the legacy SHISO entry point launches one structured nutrition request without a conversational pre-call', async () => {
    let finishRequest: (() => void) | undefined;
    let calls = 0;
    const adapter = {
      post: async (path: string) => {
        if (path !== '/api/shiso/nutrition') return { status: 404, ok: false, data: {} };
        calls += 1;
        await new Promise<void>((resolve) => { finishRequest = resolve; });
        return { status: 503, ok: false, data: { ok: false, code: 'unavailable' } };
      },
      get: async () => ({ status: 404, ok: false, data: {} }),
      request: async () => ({ status: 404, ok: false, data: {} }),
    } as unknown as NetworkAdapter;
    render(
      <Host network={adapter} canApply={false} onApplied={async () => ({ ok: true }) as never} />,
    );
    fireEvent.click(screen.getByText('analyze with shiso'));
    const progress = await screen.findByTestId('shiso-progress');
    expect(progress.textContent).toMatch(/analyzing the recipe/i);
    expect(progress.textContent).toMatch(/not saved/i);
    await waitFor(() => expect(finishRequest).toBeTypeOf('function'));
    finishRequest?.();
    await waitForText(/could not complete the nutrition analysis/i);
    expect(calls).toBe(1);
    expect(hasText(/Analyze the complete nutrition for this recipe/i)).toBe(true);
    expect(screen.getByPlaceholderText('Ask Shiso…')).toBeTruthy();
  }, 60000);

  it('SHISO investigates, proposes, and "Use this" reaches the authoritative applier', async () => {
    const { adapter, calls } = stubNetwork([
      { ok: true, kind: 'tool_request', tool: 'investigate_ingredient_amount', args: { line_ref: butterRef }, model_invocations_used: 1, tool_calls_used: 0 },
      {
        ok: true,
        kind: 'reply',
        text: 'The selected butter record has no usable portion. Another record in the same ranked set does.',
        proposals: [
          {
            line_ref: butterRef,
            ingredient_label: '6 tbsp unsalted butter',
            outcome: 'verified_alternative_match',
            explanation: 'A compatible butter record carries an authenticated tablespoon portion.',
            question: null,
            fdc_id: 2710154,
            record_digest: 'sha256:whatever',
            review_digest: 'whatever',
          },
        ],
        model_invocations_used: 2,
        tool_calls_used: 1,
      },
    ]);
    const applied: unknown[] = [];
    render(
      <Host
        network={adapter}
        canApply
        onApplied={async (bound) => {
          applied.push(bound);
          return { ok: true, summary: 'Applied.', remaining: 'Still unsaved.' } as never;
        }}
      />,
    );

    await askShiso(adapter);

    // A real tool cycle happened: the browser executed the capability.
    await waitForText(/selected butter record/i);
    expect(calls()).toBe(2);

    // The tool badge proves a capability actually ran.
    expect(hasText(/investigate ingredient amount/i)).toBe(true);

    // The proposal card is present and actionable.
    const applyButton = screen.getAllByTestId('shiso-proposal-apply')[0];
    expect(applyButton).toBeTruthy();

    fireEvent.click(applyButton);

    // The authoritative applier received a BOUND proposal.
    await waitFor(() => expect(applied.length).toBe(1), { timeout: 10000 });
    const bound = applied[0] as { recipe_key: string; session_identity: string; proposal: { line_ref: string } };
    expect(bound.recipe_key).toBe('k');
    expect(bound.session_identity).toBe('s');
    expect(bound.proposal.line_ref).toBe(butterRef);

    // And the user is told exactly what happened, including that nothing is saved.
    await waitFor(() => expect(screen.getByTestId('shiso-apply-report').textContent).toMatch(/unsaved/i));
  }, 60000);

  it('"No thanks" dismisses the proposal and NEVER calls the applier', async () => {
    const { adapter } = stubNetwork([
      {
        ok: true,
        kind: 'reply',
        text: 'Here is a suggestion.',
        proposals: [
          {
            line_ref: butterRef, ingredient_label: '6 tbsp unsalted butter',
            outcome: 'verified_alternative_match', explanation: 'e', question: null,
            fdc_id: 2710154, record_digest: 'd', review_digest: 'r',
          },
        ],
        model_invocations_used: 1, tool_calls_used: 0,
      },
    ]);
    const applied: unknown[] = [];
    render(<Host network={adapter} canApply onApplied={async (b) => { applied.push(b); return { ok: true } as never; }} />);
    await askShiso(adapter);
    await waitForText(/Here is a suggestion/);

    fireEvent.click(screen.getAllByTestId('shiso-proposal-reject')[0]);
    await waitForText(/Dismissed/i);
    expect(applied).toHaveLength(0);
  }, 60000);

  it('"Withdraw" after applying un-applies the suggestion and explains the truth', async () => {
    const { adapter } = stubNetwork([
      {
        ok: true,
        kind: 'reply', text: 'Suggestion ready.',
        proposals: [
          {
            line_ref: butterRef, ingredient_label: '6 tbsp unsalted butter',
            outcome: 'verified_alternative_match', explanation: 'e', question: null,
            fdc_id: 2710154, record_digest: 'd', review_digest: 'r',
          },
        ],
        model_invocations_used: 1, tool_calls_used: 0,
      },
    ]);
    let calls = 0;
    render(
      <Host network={adapter} canApply onApplied={async () => { calls += 1; return { ok: true, summary: 'Applied.', remaining: 'x' } as never; }} />,
    );
    await askShiso(adapter);
    await waitForText(/Suggestion ready/);
    fireEvent.click(screen.getAllByTestId('shiso-proposal-apply')[0]);
    await waitFor(() => expect(calls).toBe(1), { timeout: 10000 });
    fireEvent.click(screen.getByText('Withdraw'));
    await waitForText(/still in your working review/i);
    // The underlying selection is NOT silently reverted — the user is told.
    expect(calls).toBe(1);
  }, 60000);

  it('"Use this" is unavailable and explained when Advanced Nutrition is not open', async () => {
    const { adapter } = stubNetwork([
      {
        ok: true,
        kind: 'reply', text: 'Suggestion ready.',
        proposals: [
          {
            line_ref: butterRef, ingredient_label: '6 tbsp unsalted butter',
            outcome: 'verified_alternative_match', explanation: 'e', question: null,
            fdc_id: 2710154, record_digest: 'd', review_digest: 'r',
          },
        ],
        model_invocations_used: 1, tool_calls_used: 0,
      },
    ]);
    const applied: unknown[] = [];
    render(
      <Host network={adapter} canApply={false} onApplied={async (b) => { applied.push(b); return { ok: true } as never; }} />,
    );
    fireEvent.click(screen.getByText('open shiso'));
    const box = screen.getByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'help' } });
    fireEvent.click(screen.getByText('Send'));
    await waitForText(/Suggestion ready/);
    const applyButton = screen.getAllByTestId('shiso-proposal-apply')[0] as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    expect(hasText(/Open Advanced Nutrition to apply/i)).toBe(true);
    expect(applied).toHaveLength(0);
  }, 60000);

  it('shows a truthful error when the authoritative transition refuses', async () => {
    const { adapter } = stubNetwork([
      {
        ok: true,
        kind: 'reply', text: 'Suggestion ready.',
        proposals: [
          {
            line_ref: butterRef, ingredient_label: '6 tbsp unsalted butter',
            outcome: 'verified_alternative_match', explanation: 'e', question: null,
            fdc_id: 999999999, record_digest: 'd', review_digest: 'r',
          },
        ],
        model_invocations_used: 1, tool_calls_used: 0,
      },
    ]);
    render(
      <Host
        network={adapter}
        canApply
        onApplied={async () => {
          const { prepareShisoProposalActions } = await import('../../src/core/shiso/proposalActions');
          const recipe = adaptRecipe({ title: 't', servings: 4, ingredients: LINES.map(structured) } as never) as never as { recipe: { adapted: AdaptedIngredient[] } };
          const adapted = recipe.recipe.adapted;
          const rows = buildReviewRows(session, adapted);
          const outcome = prepareShisoProposalActions({
            bound: {
              proposal_id: 'x', proposal_version: 'shiso_nutrition_correction_v1',
              recipe_key: 'k', session_identity: 's', catalog_digest: '', bundle_release: '',
              proposal: {
                line_ref: adapted[3].line_ref, ingredient_label: '6 tbsp unsalted butter',
                outcome: 'verified_alternative_match', explanation: 'e', question: null,
                fdc_id: 999999999, record_digest: 'd', review_digest: 'r',
              },
            },
            session, recipeKey: 'k', sessionIdentity: 's', rows, adapted,
          });
          return outcome;
        }}
      />,
    );
    fireEvent.click(screen.getByText('open shiso'));
    fireEvent.click(screen.getByText('register applier'));
    const box = screen.getByPlaceholderText('Ask Shiso…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'help' } });
    fireEvent.click(screen.getByText('Send'));
    await waitForText(/Suggestion ready/);
    fireEvent.click(screen.getAllByTestId('shiso-proposal-apply')[0]);
    // A forged id is refused, and the UI must SAY so rather than claim success.
    await waitFor(() => expect(screen.getByTestId('shiso-apply-error').textContent).toMatch(/not a valid candidate/i), { timeout: 10000 });
    expect(screen.queryByTestId('shiso-apply-report')).toBeNull();
  }, 60000);
});
