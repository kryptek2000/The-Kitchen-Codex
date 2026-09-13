// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RecipeEditorModal } from '../../src/components/RecipeEditorModal';
import { hydrateAiSelections } from '../../src/application/aiSelection';
import type { NetworkAdapter } from '../../src/application/adapters/NetworkAdapter';
import type { ObsidianRecipe } from '../../src/types';

/**
 * Mounted component-wiring regression for `RecipeEditorModal` Auto Recover.
 *
 * Terra FLAG: the pure `planRecoveredMetadataApplication` tests would NOT catch
 * the REAL `handleAutoRecoverMetadata` bypassing the planner and writing
 * recovered nutrition straight into state. This suite mounts the actual modal,
 * drives the real visible Auto Recover control, waits for the real async handler,
 * then drives the real Save action and inspects the persisted recipe.
 */

const GENERATED = { calories: 9999, protein: 888, carbohydrates: 777, fat: 666, fiber: 555, sodium: 444 };
const EXISTING = { calories: 500, protein: 20, carbohydrates: 30, fat: 10, fiber: 5, sodium: 400 };

const RECOVERED = {
  prepTime: { value: '15 mins', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
  cookTime: { value: '25 mins', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
  servings: { value: 6, confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
  calories: { value: GENERATED.calories, confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
  nutrition: {
    value: { ...GENERATED, confidenceNote: 'GENERATED_RECOVERED_NUTRITION_NOTE' },
    confidence: 'medium',
    source: 'culinary_inference',
    explanation: 'x',
  },
  category: { value: 'Pasta', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
  cuisine: { value: 'Italian', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
  difficulty: { value: 'Hard', confidence: 'medium', source: 'culinary_inference', explanation: 'x' },
};

function makeRecipe(withNutrition: boolean): ObsidianRecipe {
  return {
    id: 'r1',
    fileName: 'r1.md',
    filePath: 'Recipes/r1.md',
    rawMarkdown: '---\ntitle: Existing Recipe\n---\n# Existing Recipe',
    title: 'Existing Recipe',
    tags: ['food/recipes'],
    category: '',
    cuisine: '',
    prepTime: '',
    cookTime: '',
    servings: undefined,
    difficulty: 'Easy',
    rating: 5,
    calories: withNutrition ? EXISTING.calories : undefined,
    nutrition: withNutrition
      ? {
          calories: EXISTING.calories,
          protein: EXISTING.protein,
          carbohydrates: EXISTING.carbohydrates,
          fat: EXISTING.fat,
          fiber: EXISTING.fiber,
          sodium: EXISTING.sodium,
        }
      : undefined,
    ingredients: [{ original: '1 cup flour', name: 'flour' }],
    instructions: [{ stepNumber: 1, text: 'Mix.' }],
    callouts: [],
    wikilinks: [],
    dataviewFields: {},
    frontmatter: {},
  } as ObsidianRecipe;
}

function makeNetwork(): { network: NetworkAdapter; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async (path: string) => {
    if (path === '/api/recover-metadata') {
      return { ok: true, status: 200, data: { recovered: RECOVERED } };
    }
    return { ok: false, status: 404, data: {} };
  });
  const network = { request: vi.fn(), get: vi.fn(), post } as unknown as NetworkAdapter;
  return { network, post };
}

function inputValue(placeholder: string): string {
  return (screen.getByPlaceholderText(placeholder) as HTMLInputElement).value;
}

async function runAutoRecover() {
  fireEvent.click(screen.getByText('Auto-Fill Missing Fields'));
  // The real async handler must complete and apply the safe prep time field.
  await waitFor(() => expect(inputValue('e.g. 15 mins')).toBe('15 mins'));
}

beforeEach(async () => {
  // The real handler awaits buildAiSelectionRequestOptions(); hydrate so it
  // resolves instead of throwing AiSelectionNotReadyError.
  await hydrateAiSelections({ get: async () => undefined });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RecipeEditorModal — real Auto Recover interaction', () => {
  it('applies safe metadata, never overwrites existing nutrition, and saves only the original values', async () => {
    const { network, post } = makeNetwork();
    const onSave = vi.fn();
    render(
      <RecipeEditorModal
        initialRecipe={makeRecipe(true)}
        network={network}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    await runAutoRecover();

    // The real /api/recover-metadata request was issued exactly once.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/api/recover-metadata');

    // Safe non-nutrition fields updated.
    expect(inputValue('e.g. 15 mins')).toBe('15 mins');
    expect(inputValue('e.g. 30 mins')).toBe('25 mins');
    expect(inputValue('Main Course, Baking, Soup')).toBe('Pasta');
    expect(inputValue('Italian, Japanese, etc.')).toBe('Italian');
    expect(screen.getByDisplayValue('Hard')).toBeTruthy();

    // Existing nutrition fields are UNCHANGED (no overwrite).
    expect(inputValue('e.g. 520')).toBe(String(EXISTING.calories));
    expect(inputValue('e.g. 32')).toBe(String(EXISTING.protein));
    expect(inputValue('e.g. 45')).toBe(String(EXISTING.carbohydrates));
    expect(inputValue('e.g. 18')).toBe(String(EXISTING.fat));
    expect(inputValue('e.g. 6')).toBe(String(EXISTING.fiber));
    expect(inputValue('e.g. 580')).toBe(String(EXISTING.sodium));

    // Bounded feedback states generated nutrition was omitted.
    expect(screen.getByText(/Generated nutrition was omitted/)).toBeTruthy();

    // Trigger the REAL Save action.
    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    const md = saved.rawMarkdown;

    // No rejected generated number is serialized anywhere.
    for (const value of Object.values(GENERATED)) {
      expect(md).not.toContain(String(value));
      expect(JSON.stringify(saved.nutrition)).not.toContain(String(value));
    }
    expect(md).not.toContain('GENERATED_RECOVERED_NUTRITION_NOTE');

    // Original existing nutrition remains intact in the persisted recipe.
    expect(saved.nutrition?.calories).toBe(EXISTING.calories);
    expect(saved.nutrition?.protein).toBe(EXISTING.protein);
    expect(saved.nutrition?.carbohydrates).toBe(EXISTING.carbohydrates);
    expect(saved.nutrition?.fat).toBe(EXISTING.fat);
    expect(saved.nutrition?.fiber).toBe(EXISTING.fiber);
    expect(saved.nutrition?.sodium).toBe(EXISTING.sodium);

    // No generated nutrition source/provenance was attached.
    expect(saved.nutrition?.source).toBeUndefined();
    expect(saved.nutrition?.confidenceNote).toBeUndefined();

    // The safe metadata was persisted.
    expect(md).toContain('prep_time: 15 mins');
  });

  it('does not populate blank nutrition fields or serialize a nutrition block from rejected recovery', async () => {
    const { network } = makeNetwork();
    const onSave = vi.fn();
    render(
      <RecipeEditorModal
        initialRecipe={makeRecipe(false)}
        network={network}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    await runAutoRecover();

    // Blank nutrition fields stay blank.
    expect(inputValue('e.g. 520')).toBe('');
    expect(inputValue('e.g. 32')).toBe('');
    expect(inputValue('e.g. 45')).toBe('');
    expect(inputValue('e.g. 18')).toBe('');
    expect(inputValue('e.g. 6')).toBe('');
    expect(inputValue('e.g. 580')).toBe('');

    fireEvent.click(screen.getByText('Save Obsidian Note'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const saved = onSave.mock.calls[0][0] as ObsidianRecipe;
    expect(saved.nutrition).toBeUndefined();
    for (const value of Object.values(GENERATED)) {
      expect(saved.rawMarkdown).not.toContain(String(value));
    }
    expect(saved.rawMarkdown).not.toContain('nutrition:');
  });
});
