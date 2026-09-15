// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RecipeImageChooser, type RecipeImageChooserProps } from '../../src/components/RecipeImageChooser';
import type { RecipeImageGenerationQuote } from '../../src/application/recipeImageRecovery';

const QUOTE: RecipeImageGenerationQuote = {
  provider: { id: 'gemini-image', name: 'Google Gemini Image' },
  model: 'gemini-2.5-flash-image',
  credentialSource: 'server_environment',
  costClass: 'variable',
  costLabel: 'Variable pricing — determined by your Google account',
  requiresConfirmation: true,
  confirmationToken: 'token-1',
  confirmationExpiresAt: Date.now() + 300000,
};

function noop() {}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    defaultMode: 'licensed' as const,
    licensed: {
      candidates: [],
      searchTerms: 'blue cheese burger',
      onSelect: noop,
      onCancel: noop,
    },
    ai: { phase: 'idle' as const },
    onAiGenerate: noop,
    onAiConfirm: noop,
    onAiAccept: noop,
    onAiRegenerate: noop,
    onAiCancelPreview: noop,
    onCancel: noop,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('RecipeImageChooser — two clearly separated modes', () => {
  it('opens in Licensed Search (Free) by default and exposes no AI action until switched', () => {
    const onAiGenerate = vi.fn();
    render(<RecipeImageChooser {...(baseProps({ onAiGenerate }) as RecipeImageChooserProps)} />);
    expect(screen.getByTestId('image-mode-licensed').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Choose a Representative Recipe Image')).toBeTruthy();
    // Opening the dialog makes zero provider calls.
    expect(onAiGenerate).not.toHaveBeenCalled();
  });

  it('switching to Generate with AI makes ZERO provider calls', () => {
    const onAiGenerate = vi.fn();
    render(<RecipeImageChooser {...(baseProps({ onAiGenerate }) as RecipeImageChooserProps)} />);
    fireEvent.click(screen.getByTestId('image-mode-ai'));
    expect(screen.getByTestId('image-mode-ai').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('ai-image-generate')).toBeTruthy();
    expect(onAiGenerate).not.toHaveBeenCalled();
  });

  it('requires an explicit Generate click (typing/opening never generates)', () => {
    const onAiGenerate = vi.fn();
    render(<RecipeImageChooser {...(baseProps({ onAiGenerate }) as RecipeImageChooserProps)} />);
    fireEvent.click(screen.getByTestId('image-mode-ai'));
    expect(onAiGenerate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ai-image-generate'));
    expect(onAiGenerate).toHaveBeenCalledTimes(1);
  });

  it('shows provider, exact model, credential source, and truthful pricing before confirmation', () => {
    render(
      <RecipeImageChooser
        {...(baseProps({ ai: { phase: 'confirming', quote: QUOTE } }) as RecipeImageChooserProps)}
      />
    );
    fireEvent.click(screen.getByTestId('image-mode-ai'));
    expect(screen.getByTestId('ai-image-quote').textContent).toContain('Google Gemini Image');
    expect(screen.getByTestId('ai-image-quote').textContent).toContain('gemini-2.5-flash-image');
    expect(screen.getByTestId('ai-image-quote').textContent).toContain('Using server API key');
    expect(screen.getByTestId('ai-image-quote').textContent).toContain('Variable pricing');
    // A paid/variable generation requires the explicit confirmation.
    expect(screen.getByTestId('ai-image-confirm')).toBeTruthy();
  });

  it('confirming invokes onAiConfirm exactly once (one deliberate confirmation)', () => {
    const onAiConfirm = vi.fn();
    render(
      <RecipeImageChooser
        {...(baseProps({ ai: { phase: 'confirming', quote: QUOTE }, onAiConfirm }) as RecipeImageChooserProps)}
      />
    );
    fireEvent.click(screen.getByTestId('image-mode-ai'));
    fireEvent.click(screen.getByTestId('ai-image-confirm'));
    expect(onAiConfirm).toHaveBeenCalledTimes(1);
  });

  it('Cancel on a quote makes zero calls', () => {
    const onAiConfirm = vi.fn();
    const onAiCancelPreview = vi.fn();
    render(
      <RecipeImageChooser
        {...(baseProps({ ai: { phase: 'confirming', quote: QUOTE }, onAiConfirm, onAiCancelPreview }) as RecipeImageChooserProps)}
      />
    );
    fireEvent.click(screen.getByTestId('image-mode-ai'));
    fireEvent.click(screen.getByTestId('ai-image-cancel'));
    expect(onAiConfirm).not.toHaveBeenCalled();
    expect(onAiCancelPreview).toHaveBeenCalledTimes(1);
  });

  it('shows a truthful disabled state + setup action when no image provider is configured', () => {
    const onOpenAiSettings = vi.fn();
    render(
      <RecipeImageChooser
        {...(baseProps({ ai: { phase: 'idle', providerConfigured: false }, onOpenAiSettings }) as RecipeImageChooserProps)}
      />
    );
    fireEvent.click(screen.getByTestId('image-mode-ai'));
    expect(screen.getByTestId('ai-image-unconfigured')).toBeTruthy();
    expect(screen.queryByTestId('ai-image-generate')).toBeNull();
    fireEvent.click(screen.getByTestId('open-ai-settings'));
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });

  it('never renders raw error text or credentials', () => {
    render(
      <RecipeImageChooser
        {...(baseProps({
          ai: { phase: 'error', message: 'Bounded failure. No secrets here.' },
        }) as RecipeImageChooserProps)}
      />
    );
    fireEvent.click(screen.getByTestId('image-mode-ai'));
    const text = document.body.textContent || '';
    expect(text).toContain('Bounded failure');
    expect(text).not.toMatch(/sk-or-|Bearer|api[_-]?key/i);
  });
});
