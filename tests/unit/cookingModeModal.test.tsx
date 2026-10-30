// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import { CookingModeModal } from '../../src/components/CookingModeModal';

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

afterEach(() => cleanup());

function makeRecipe(overrides: any = {}): any {
  return {
    id: 'r1',
    title: 'Test Soup',
    fileName: 'test.md',
    filePath: 'test.md',
    rawMarkdown: '',
    tags: [],
    category: 'Soup',
    cuisine: 'Italian',
    difficulty: 'Easy',
    rating: 4,
    ingredients: [
      { original: '2 cups flour', amount: 2, unit: 'cups', name: 'flour' },
      { original: '1 egg', amount: 1, unit: '', name: 'egg' },
    ],
    instructions: [
      { stepNumber: 1, text: 'Mix the flour.', timerMinutes: 5 },
      { stepNumber: 2, text: 'Add the egg and stir.' },
      { stepNumber: 3, text: 'Serve hot.' },
    ],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    servings: 4,
    ...overrides,
  };
}

describe('CookingModeModal', () => {
  it('renders the correct recipe title and step', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Test Soup')).toBeTruthy();
    expect(screen.getByText('Mix the flour.')).toBeTruthy();
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    const progress = screen.getByRole('progressbar', { name: 'Cooking progress' });
    expect(progress.getAttribute('aria-valuemin')).toBe('1');
    expect(progress.getAttribute('aria-valuemax')).toBe('3');
    expect(progress.getAttribute('aria-valuenow')).toBe('1');
    expect(progress.getAttribute('aria-valuetext')).toBe('Step 1 of 3');
  });

  it('renders a complete long recipe title in the editorial header', () => {
    const longTitle = 'Skillet Cornmeal Porridge with Orchard Apples and Brown Butter';
    render(
      <CookingModeModal
        recipe={makeRecipe({ title: longTitle })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const title = screen.getByRole('heading', { name: longTitle });
    expect(title).toBeTruthy();
    expect(title.className).not.toContain('truncate');
  });

  it('navigates steps with next/prev', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByText('Next Step'));
    expect(screen.getByText('Add the egg and stir.')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    fireEvent.click(screen.getByText('Previous'));
    expect(screen.getByText('Mix the flour.')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  });

  it('preserves keyboard navigation outside interactive controls', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const root = document.getElementById('fullscreen-cooking-mode')!;
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(screen.getByText('Add the egg and stir.')).toBeTruthy();
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(screen.getByText('Mix the flour.')).toBeTruthy();
    fireEvent.keyDown(root, { key: ' ' });
    expect(screen.getByText('Add the egg and stir.')).toBeTruthy();

    const nextButton = document.getElementById('cooking-next-step-btn')!;
    nextButton.focus();
    fireEvent.keyDown(nextButton, { key: 'ArrowRight' });
    expect(screen.getByText('Add the egg and stir.')).toBeTruthy();
  });

  it('uses theme tokens and 48px primary navigation targets', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const root = document.getElementById('fullscreen-cooking-mode')!;
    expect(root.className).toContain('bg-[var(--bg-root,#0C0C0C)]');
    expect(document.getElementById('cooking-prev-step-btn')!.className).toContain('min-h-[48px]');
    expect(document.getElementById('cooking-next-step-btn')!.className).toContain('min-h-[48px]');
  });

  it('shows a clean finished state without duplicate footer navigation', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const nextButton = document.getElementById('cooking-next-step-btn')!;
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);

    expect(screen.getByText('Bon Appétit! 🎉')).toBeTruthy();
    expect(screen.getByText('Review Steps Again')).toBeTruthy();
    expect(screen.getByText('Done Cooking')).toBeTruthy();
    expect(document.getElementById('cooking-next-step-btn')).toBeNull();
    expect(document.querySelector('#fullscreen-cooking-mode footer')).toBeNull();

    fireEvent.click(screen.getByText('Review Steps Again'));
    expect(screen.getByText('Mix the flour.')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  });

  it('closes via exit button', () => {
    const onClose = vi.fn();
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={2}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByLabelText('Exit cooking mode'));
    expect(onClose).toHaveBeenCalled();
  });

  it('scales ingredients and shows drawer', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={8}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Toggle ingredients list'));
    expect(screen.getByText(/Ingredients \(8 servings\)/)).toBeTruthy();
    expect(screen.getAllByText(/4 cups flour/).length).toBeGreaterThan(0);
  });

  it('timer control invokes onStartTimer', () => {
    const onStart = vi.fn();
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={onStart}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByText(/Start 5 min Timer/));
    expect(onStart).toHaveBeenCalledWith('Test Soup', 5, 'Step 1: 5m', 'r1::step:1');
  });

  it('active timer renders and controls invoke callbacks', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    const timer: any = {
      id: 't1',
      recipeTitle: 'Test Soup',
      label: 'Step 1: 5m',
      totalSeconds: 300,
      remainingSeconds: 240,
      isRunning: true,
      createdAt: Date.now(),
      semanticKey: 'r1::step:1',
      endsAt: Date.now() + 240000,
    };
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[timer]}
        onStartTimer={() => {}}
        onToggleTimer={onToggle}
        onDeleteTimer={onDelete}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('4:00')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Pause timer'));
    expect(onToggle).toHaveBeenCalledWith('t1');
    fireEvent.click(screen.getByLabelText('Dismiss timer'));
    expect(onDelete).toHaveBeenCalledWith('t1');
  });

  it('handles missing optional data without crashing', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe({ ingredients: [], instructions: [], image: undefined, category: '', cuisine: '', totalTime: '', difficulty: 'Easy' })}
        servings={1}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Test Soup')).toBeTruthy();
  });

  it('long instruction text is accessible', () => {
    const longText = 'A'.repeat(300);
    render(
      <CookingModeModal
        recipe={makeRecipe({ instructions: [{ stepNumber: 1, text: longText }] })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(longText)).toBeTruthy();
  });
});

describe('CookingModeModal correction pass', () => {
  it('Escape closes the dialog', () => {
    const onClose = vi.fn();
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('initial focus enters the dialog', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const root = document.getElementById('fullscreen-cooking-mode');
    expect(root).toBeTruthy();
    expect(root!.contains(document.activeElement)).toBe(true);
  });

  it('Tab is contained within the dialog', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const root = document.getElementById('fullscreen-cooking-mode')!;
    const focusable = Array.from(root.querySelectorAll('button:not([disabled])')) as HTMLElement[];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    // focus should wrap to first
    expect(focusable[0]).toBe(document.activeElement);
  });

  it('renders inline emphasis without raw markers', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe({ instructions: [{ stepNumber: 1, text: '**Autolyse** the dough.' }] })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const root = document.getElementById('fullscreen-cooking-mode')!;
    expect(root.textContent).toContain('Autolyse');
    expect(root.textContent).not.toContain('**');
    // original data unchanged
    expect(makeRecipe().instructions[0].text).toBe('Mix the flour.');
  });

  it('treats HTML-like input as text', () => {
    const payload = '<img src=x onerror=alert(1)>';
    render(
      <CookingModeModal
        recipe={makeRecipe({ instructions: [{ stepNumber: 1, text: payload }] })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const root = document.getElementById('fullscreen-cooking-mode')!;
    expect(root.textContent).toContain(payload);
  });

  it('empty instructions do not produce NaN progress', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe({ instructions: [] })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    const bar = document.querySelector('#fullscreen-cooking-mode [style*="width"]') as HTMLElement;
    // progress bar width should be a finite percentage, not NaN
    expect(bar.style.width).not.toContain('NaN');
  });

  it('timer identity remains stable across step changes', () => {
    const timer: any = {
      id: 't1',
      recipeTitle: 'Test Soup',
      label: 'Step 1: 5m',
      totalSeconds: 300,
      remainingSeconds: 240,
      isRunning: true,
      createdAt: Date.now(),
      semanticKey: 'r1::step:1',
      endsAt: Date.now() + 240000,
    };
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[timer]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('4:00')).toBeTruthy();
    fireEvent.click(screen.getByText('Next Step'));
    // timer for step1 no longer displayed (step2 has no timer), but no crash
    expect(screen.getByText('Add the egg and stir.')).toBeTruthy();
  });
});

import { vaultAssets } from '../../src/utils/vaultAssets';

describe('CookingModeModal image compatibility', () => {
  afterEach(() => vaultAssets.clear());

  it('renders a safe remote recipe photograph', async () => {
    render(
      <CookingModeModal
        recipe={makeRecipe({ image: 'https://example.com/bread.jpg' })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('#fullscreen-cooking-mode [role="img"]') as HTMLElement;
    expect(img).toBeTruthy();
    expect(img.style.backgroundImage).toContain('https://example.com/bread.jpg');
  });

  it('renders an explicit Vault-relative image reference', async () => {
    vaultAssets.registerAsset('Assets/My Bread.jpg', new File(['x'], 'My Bread.jpg', { type: 'image/jpeg' }));
    render(
      <CookingModeModal
        recipe={makeRecipe({ image: 'Assets/My Bread.jpg' })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('#fullscreen-cooking-mode [role="img"]') as HTMLElement;
    expect(img).toBeTruthy();
    expect(img.style.backgroundImage).toMatch(/blob:/);
  });

  it('renders a Markdown image embed when supported', async () => {
    vaultAssets.registerAsset('Assets/Bread.jpg', new File(['x'], 'Bread.jpg', { type: 'image/jpeg' }));
    render(
      <CookingModeModal
        recipe={makeRecipe({ rawMarkdown: '![Bread](Assets/Bread.jpg)' })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('#fullscreen-cooking-mode [role="img"]') as HTMLElement;
    expect(img).toBeTruthy();
    expect(img.style.backgroundImage).toMatch(/blob:/);
  });

  it('renders an asynchronously resolved Vault asset', async () => {
    const handle = { getFile: async () => new File(['x'], 'Async.jpg', { type: 'image/jpeg' }) };
    vaultAssets.registerAsset('Assets/Async.jpg', handle);
    render(
      <CookingModeModal
        recipe={makeRecipe({ image: 'Assets/Async.jpg' })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    // allow async resolution
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('#fullscreen-cooking-mode [role="img"]') as HTMLElement;
    expect(img).toBeTruthy();
    expect(img.style.backgroundImage).toMatch(/blob:/);
  });

  it('shows fallback when no explicit image', async () => {
    render(
      <CookingModeModal
        recipe={makeRecipe({ image: undefined, rawMarkdown: '' })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('#fullscreen-cooking-mode [role="img"]');
    expect(img).toBeNull();
  });

  it('rejects unsafe URL schemes', async () => {
    render(
      <CookingModeModal
        recipe={makeRecipe({ image: 'javascript:alert(1)' })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('#fullscreen-cooking-mode [role="img"]');
    expect(img).toBeNull();
  });

  it('fails safely for missing Vault references', async () => {
    render(
      <CookingModeModal
        recipe={makeRecipe({ image: 'Assets/missing.jpg' })}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    await new Promise((r) => setTimeout(r, 0));
    const img = document.querySelector('#fullscreen-cooking-mode [role="img"]');
    expect(img).toBeNull();
  });
});

describe('CookingModeModal focus recovery', () => {
  it('recovers focus into the dialog when it escapes', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    // Move focus outside the dialog.
    document.body.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    const root = document.getElementById('fullscreen-cooking-mode')!;
    expect(root.contains(document.activeElement)).toBe(true);
  });
});

describe('CookingModeModal Slice 2', () => {
  it('shows an active timer tray count', () => {
    const timers = [
      { id: 't1', recipeTitle: 'Test Soup', label: 'Step 1: 5m', totalSeconds: 300, remainingSeconds: 200, isRunning: true, createdAt: 1 },
    ];
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={timers as any}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByLabelText('Active timers: 1')).toBeTruthy();
  });

  it('opens the timer tray to reveal active timers', () => {
    const timers = [
      { id: 't1', recipeTitle: 'Test Soup', label: 'Step 1: 5m', totalSeconds: 300, remainingSeconds: 200, isRunning: true, createdAt: 1 },
    ];
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={timers as any}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Active timers: 1'));
    expect(screen.getByText('Step 1: 5m')).toBeTruthy();
  });

  it('opens the ingredient sheet', () => {
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Toggle ingredients list'));
    expect(screen.getByText('Ingredients (4 servings)')).toBeTruthy();
  });
});

describe('CookingModeModal Slice 2-R1', () => {
  it('exposes New Custom Timer in the timer tray', () => {
    const timers = [
      { id: 't1', recipeTitle: 'Test Soup', label: 'Step 1: 5m', totalSeconds: 300, remainingSeconds: 200, isRunning: true, createdAt: 1 },
    ];
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={timers as any}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onAddCustomTimer={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Active timers: 1'));
    expect(screen.getByText('New Custom Timer')).toBeTruthy();
  });
});

describe('CookingModeModal zero-timer tray', () => {
  it('allows opening the tray and creating a custom timer with zero timers', () => {
    const onAdd = vi.fn();
    render(
      <CookingModeModal
        recipe={makeRecipe()}
        servings={4}
        activeTimers={[]}
        onStartTimer={() => {}}
        onToggleTimer={() => {}}
        onDeleteTimer={() => {}}
        onAddCustomTimer={onAdd}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Active timers: 0'));
    expect(screen.getByText('No active timers.')).toBeTruthy();
    fireEvent.click(screen.getByText('New Custom Timer'));
    expect(onAdd).toHaveBeenCalled();
  });
});
