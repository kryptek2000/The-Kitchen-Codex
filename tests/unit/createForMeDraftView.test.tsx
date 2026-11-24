// @vitest-environment jsdom
/**
 * SHISO-C1.6-F1 — polished generated recipe editor.
 *
 * Verifies readable structured fields and that every legitimate ingredient/step
 * field survives controlled edits. No network, provider, or Vault is used.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import {
  CreateForMeDraftView,
  formatElapsedSeconds,
} from '../../src/components/CreateForMeModal';
import type { GeneratedRecipeDraft, GeneratedRecipeProvenance } from '../../src/schema/generatedRecipe';

const PROVENANCE: GeneratedRecipeProvenance = {
  generated: true,
  providerId: 'chatgpt-plan',
  model: 'gpt-test',
};

const FULL: GeneratedRecipeDraft = {
  title: 'Traditional Southern Cornbread Dressing',
  description: 'A savory holiday dressing with cornbread and herbs.',
  servings: 8,
  prepTime: '20 mins',
  cookTime: '45 mins',
  totalTime: '65 mins',
  cuisine: 'Southern',
  course: 'Side',
  difficulty: 'Easy',
  tags: ['holiday', 'side'],
  notes: 'Cool before serving.',
  ingredients: [
    {
      amount: 4,
      unit: 'cup',
      name: 'crumbled cornbread',
      preparation: 'day-old',
      optional: true,
    },
    { name: 'salt' },
  ],
  steps: [
    { text: 'Combine the cornbread and aromatics.', timerMinutes: 10 },
    { text: 'Bake until golden.' },
  ],
};

function Host({ initial }: { initial: GeneratedRecipeDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <CreateForMeDraftView draft={draft} provenance={PROVENANCE} onChange={setDraft} />
      <pre data-testid="draft-json">{JSON.stringify(draft)}</pre>
    </>
  );
}

afterEach(cleanup);

describe('CreateForMeDraftView', () => {
  it('renders readable title, metadata, ingredient rows, numbered steps, and optional/timer fields', () => {
    render(<CreateForMeDraftView draft={FULL} provenance={PROVENANCE} onChange={() => {}} />);

    expect((screen.getByLabelText('Recipe title') as HTMLInputElement).value).toBe(FULL.title);
    expect((screen.getByLabelText('Recipe description') as HTMLTextAreaElement).value).toContain(
      'savory holiday dressing'
    );
    expect((screen.getByLabelText('Servings') as HTMLInputElement).value).toBe('8');
    expect((screen.getByLabelText('Prep time') as HTMLInputElement).value).toBe('20 mins');
    expect((screen.getByLabelText('Cook time') as HTMLInputElement).value).toBe('45 mins');
    expect((screen.getByLabelText('Total time') as HTMLInputElement).value).toBe('65 mins');
    expect((screen.getByLabelText('Ingredient 1 amount') as HTMLInputElement).value).toBe('4');
    expect((screen.getByLabelText('Ingredient 1 unit') as HTMLInputElement).value).toBe('cup');
    expect((screen.getByLabelText('Ingredient 1 name') as HTMLInputElement).value).toBe(
      'crumbled cornbread'
    );
    expect((screen.getByLabelText('Ingredient 1 preparation') as HTMLInputElement).value).toBe(
      'day-old'
    );
    expect((screen.getByLabelText('Ingredient 1 optional') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Step 1 instruction') as HTMLTextAreaElement).value).toContain(
      'Combine the cornbread'
    );
    expect((screen.getByLabelText('Step 1 timer minutes') as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('Generated Draft')).toBeTruthy();
    expect(screen.getByText('Not saved yet')).toBeTruthy();
  });

  it('does not invent missing description, timing, metadata, or optional fields', () => {
    render(
      <CreateForMeDraftView
        draft={{ title: 'Minimal Toast', ingredients: [{ name: 'bread' }], steps: [{ text: 'Toast.' }] }}
        provenance={PROVENANCE}
        onChange={() => {}}
      />
    );
    expect(screen.queryByLabelText('Recipe description')).toBeNull();
    expect(screen.queryByLabelText('Servings')).toBeNull();
    expect(screen.queryByLabelText('Prep time')).toBeNull();
    expect(screen.queryByLabelText('Cook time')).toBeNull();
    expect(screen.queryByLabelText('Total time')).toBeNull();
    expect(screen.queryByLabelText('Recipe notes')).toBeNull();
  });

  it('preserves all legitimate structured fields while editing', () => {
    render(<Host initial={FULL} />);
    fireEvent.change(screen.getByLabelText('Recipe title'), {
      target: { value: 'Edited Dressing' },
    });
    fireEvent.change(screen.getByLabelText('Ingredient 1 preparation'), {
      target: { value: 'toasted' },
    });
    fireEvent.click(screen.getByLabelText('Ingredient 1 optional')); // turn off
    fireEvent.change(screen.getByLabelText('Step 1 timer minutes'), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText('Recipe description'), {
      target: { value: 'Edited description.' },
    });

    const draft = JSON.parse(screen.getByTestId('draft-json').textContent || '{}') as GeneratedRecipeDraft;
    expect(draft.title).toBe('Edited Dressing');
    expect(draft.description).toBe('Edited description.');
    expect(draft.servings).toBe(8);
    expect(draft.prepTime).toBe('20 mins');
    expect(draft.cookTime).toBe('45 mins');
    expect(draft.totalTime).toBe('65 mins');
    expect(draft.cuisine).toBe('Southern');
    expect(draft.course).toBe('Side');
    expect(draft.tags).toEqual(['holiday', 'side']);
    expect(draft.notes).toBe('Cool before serving.');
    expect(draft.ingredients[0]).toMatchObject({
      amount: 4,
      unit: 'cup',
      name: 'crumbled cornbread',
      preparation: 'toasted',
      optional: false,
    });
    expect(draft.steps[0]).toMatchObject({ timerMinutes: 12 });
    expect(draft.steps[1].text).toBe('Bake until golden.');
  });

  it('formats elapsed feedback in clearly labelled seconds', () => {
    expect(formatElapsedSeconds(0)).toBe('0.0s');
    expect(formatElapsedSeconds(1234)).toBe('1.2s');
    expect(formatElapsedSeconds(-5)).toBe('0.0s');
  });
});
