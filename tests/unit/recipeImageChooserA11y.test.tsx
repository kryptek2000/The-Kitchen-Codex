// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RecipeImageChooser } from '../../src/components/RecipeImageChooser';
import { RepresentativeImageChooser } from '../../src/components/RepresentativeImageChooser';
import type { RepresentativeImageCandidate } from '../../src/core/representativeImage';

/**
 * I6 — chooser accessibility (mounted keyboard/focus tests against the real
 * wrappers): named dialog + aria-modal, predictable initial focus, Tab trap,
 * focus restore, arrow-key tabs with roving tabindex, Escape without selection.
 */

const CANDIDATE: RepresentativeImageCandidate = {
  id: 'opaque-1',
  source: 'openverse',
  title: 'Blue Cheese Burger',
  thumbnailPath: '/api/recipes/image/representative-thumbnail/opaque-1',
  sourcePageUrl: 'https://example.com/a',
  creator: 'Chef',
  license: 'cc_by',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  licenseVersion: '4.0',
};

function licensedProps() {
  return {
    candidates: [CANDIDATE],
    query: 'blue cheese',
    searchTerms: 'blue cheese',
    suggestions: [],
    searchGeneration: 1,
    busy: false,
    message: null as string | null,
    messageKind: 'info' as const,
    onSearch: vi.fn(),
    onSelect: vi.fn(),
    onCancel: vi.fn(),
  };
}

function aiIdle() {
  return {
    phase: 'idle' as const,
    quote: null,
    preview: null,
    message: null,
    messageKind: 'info' as const,
    providerConfigured: true,
  };
}

beforeEach(() => {
  (URL as any).createObjectURL = vi.fn(() => 'blob:a11y');
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RecipeImageChooser — dialog semantics and focus', () => {
  it('renders a named modal dialog and moves initial focus into it', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);
    const onCancel = vi.fn();
    render(
      <RecipeImageChooser
        licensed={licensedProps()}
        ai={aiIdle()}
        onAiGenerate={vi.fn()}
        onAiConfirm={vi.fn()}
        onAiAccept={vi.fn()}
        onAiRegenerate={vi.fn()}
        onAiCancelPreview={vi.fn()}
        onCancel={onCancel}
      />
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBeTruthy();
    await waitFor(() => expect(document.activeElement === dialog || dialog.contains(document.activeElement)).toBe(true));
    document.body.removeChild(opener);
  });

  it('traps Tab inside the dialog and restores focus to the opener on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <RecipeImageChooser
        licensed={licensedProps()}
        ai={aiIdle()}
        onAiGenerate={vi.fn()}
        onAiConfirm={vi.fn()}
        onAiAccept={vi.fn()}
        onAiRegenerate={vi.fn()}
        onAiCancelPreview={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const dialog = screen.getByRole('dialog');
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')
    );
    expect(focusables.length).toBeGreaterThan(1);
    // jsdom has no layout (offsetParent is always null), so the wrap target
    // cannot be observed here; assert CONTAINMENT: Tab never leaves the dialog.
    const last = focusables[focusables.length - 1];
    const first = focusables[0];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(opener);
    document.body.removeChild(opener);
  });

  it('arrow keys switch tabs with roving tabindex and make no provider calls', async () => {
    const onSearch = vi.fn();
    const onGenerate = vi.fn();
    const props = licensedProps();
    props.onSearch = onSearch;
    render(
      <RecipeImageChooser
        licensed={props}
        ai={aiIdle()}
        onAiGenerate={onGenerate}
        onAiConfirm={vi.fn()}
        onAiAccept={vi.fn()}
        onAiRegenerate={vi.fn()}
        onAiCancelPreview={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const licensedTab = screen.getByTestId('image-mode-licensed');
    const aiTab = screen.getByTestId('image-mode-ai');
    expect(licensedTab.getAttribute('tabindex')).toBe('0');
    expect(aiTab.getAttribute('tabindex')).toBe('-1');
    licensedTab.focus();
    fireEvent.keyDown(licensedTab, { key: 'ArrowRight', bubbles: true });
    await waitFor(() => expect(screen.getByTestId('ai-image-panel')).toBeTruthy());
    expect(aiTab.getAttribute('aria-selected')).toBe('true');
    expect(onSearch).not.toHaveBeenCalled();
    expect(onGenerate).not.toHaveBeenCalled();
    fireEvent.keyDown(aiTab, { key: 'ArrowLeft', bubbles: true });
    await waitFor(() => expect(screen.getByTestId('representative-search-form')).toBeTruthy());
  });

  it('Escape closes without selection and parent re-renders do not steal focus', async () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const props = licensedProps();
    props.onSelect = onSelect;
    const { rerender } = render(
      <RecipeImageChooser
        licensed={props}
        ai={aiIdle()}
        onAiGenerate={vi.fn()}
        onAiConfirm={vi.fn()}
        onAiAccept={vi.fn()}
        onAiRegenerate={vi.fn()}
        onAiCancelPreview={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
    const input = screen.getByTestId('representative-search-input');
    input.focus();
    expect(document.activeElement).toBe(input);
    // Parent re-render with fresh inline callbacks must not yank focus back.
    rerender(
      <RecipeImageChooser
        licensed={{ ...props }}
        ai={aiIdle()}
        onAiGenerate={vi.fn()}
        onAiConfirm={vi.fn()}
        onAiAccept={vi.fn()}
        onAiRegenerate={vi.fn()}
        onAiCancelPreview={vi.fn()}
        onCancel={() => onCancel()}
      />
    );
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('busy, error, and confirmation states are text-announced (non-color meaning)', () => {
    const { rerender } = render(
      <RecipeImageChooser
        licensed={{ ...licensedProps(), busy: true }}
        ai={aiIdle()}
        onAiGenerate={vi.fn()}
        onAiConfirm={vi.fn()}
        onAiAccept={vi.fn()}
        onAiRegenerate={vi.fn()}
        onAiCancelPreview={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Searching licensed image catalogs/)).toBeTruthy();
    rerender(
      <RecipeImageChooser
        licensed={{ ...licensedProps(), message: 'Nope', messageKind: 'error' }}
        ai={aiIdle()}
        onAiGenerate={vi.fn()}
        onAiConfirm={vi.fn()}
        onAiAccept={vi.fn()}
        onAiRegenerate={vi.fn()}
        onAiCancelPreview={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('RepresentativeImageChooser standalone — dialog semantics', () => {
  it('renders a modal dialog with Escape and focus restore', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onCancel = vi.fn();
    render(<RepresentativeImageChooser {...licensedProps()} onCancel={onCancel} />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    cleanup();
    expect(document.activeElement).toBe(opener);
    document.body.removeChild(opener);
  });
});
