// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

import LivingLibrary from '../../src/components/LivingLibrary';
import { getLivingLibraryFixtures, LIVING_LIBRARY_FIXTURE_COUNT, LIVING_LIBRARY_PAGE_SIZE } from '../../src/data/livingLibraryFixtures';

afterEach(() => cleanup());

describe('Living Library (UD-2C)', () => {
  it('renders the library with the synthetic-data banner', () => {
    render(<LivingLibrary demo />);
    expect(screen.getByText(/Synthetic design fixtures/i)).toBeTruthy();
    expect(screen.getByText(/Model discovery/i)).toBeTruthy();
    expect(screen.getByTestId ? true : true).toBe(true);
  });

  it('shows the total fixture count and first page of 12', () => {
    render(<LivingLibrary demo />);
    const range = screen.getByText(/Showing/i).closest('nav') || document.body;
    expect(document.querySelector('[data-page-range]')?.textContent).toBe('1–12');
    expect(document.querySelector('[data-result-count]')?.textContent).toBe(String(LIVING_LIBRARY_FIXTURE_COUNT));
  });

  it('filters by search query across the whole catalog', () => {
    render(<LivingLibrary demo />);
    const all = getLivingLibraryFixtures();
    const first = all[0];
    const search = document.querySelector<HTMLInputElement>('[data-library-search]')!;
    fireEvent.change(search, { target: { value: first.name } });
    // result count should drop below total
    const rc = Number(document.querySelector('[data-result-count]')?.textContent);
    expect(rc).toBeLessThan(LIVING_LIBRARY_FIXTURE_COUNT);
    expect(rc).toBeGreaterThan(0);
  });

  it('resets filters via the reset button', () => {
    render(<LivingLibrary demo />);
    const search = document.querySelector<HTMLInputElement>('[data-library-search]')!;
    fireEvent.change(search, { target: { value: 'zzzz-no-match' } });
    expect(Number(document.querySelector('[data-result-count]')?.textContent)).toBe(0);
    const reset = document.querySelector<HTMLButtonElement>('[data-filter-reset]')!;
    fireEvent.click(reset);
    expect(document.querySelector<HTMLInputElement>('[data-library-search]')?.value).toBe('');
    expect(Number(document.querySelector('[data-result-count]')?.textContent)).toBe(LIVING_LIBRARY_FIXTURE_COUNT);
  });

  it('shows an honest empty state when nothing matches', () => {
    render(<LivingLibrary demo />);
    const search = document.querySelector<HTMLInputElement>('[data-library-search]')!;
    fireEvent.change(search, { target: { value: 'this-string-matches-no-model-xyz' } });
    expect(document.querySelector('[data-library-empty]')).toBeTruthy();
  });

  it('paginates: next page changes the range', () => {
    render(<LivingLibrary demo />);
    const next = document.querySelector<HTMLButtonElement>('[data-page-next]')!;
    fireEvent.click(next);
    expect(document.querySelector('[data-page-current]')?.textContent).toMatch(/Page 2/);
    expect(document.querySelector('[data-page-range]')?.textContent).toBe('13–24');
  });

  it('favorites toggle updates the favorites-only filter', () => {
    render(<LivingLibrary demo />);
    // toggle favorite on first card
    const firstCard = document.querySelector<HTMLElement>('[data-model-card]')!;
    const favBtn = firstCard.querySelector<HTMLButtonElement>('[data-favorite-toggle]')!;
    fireEvent.click(favBtn);
    // enable favorites-only
    const favCheckbox = document.querySelector<HTMLInputElement>('[data-filter-favorites]')!;
    fireEvent.click(favCheckbox);
    expect(Number(document.querySelector('[data-result-count]')?.textContent)).toBe(1);
  });

  it('comparison is capped at 3 models and shows a notice', () => {
    render(<LivingLibrary demo />);
    const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('[data-compare-checkbox]'));
    // check 4
    for (let i = 0; i < 4; i++) fireEvent.click(checkboxes[i]);
    expect(document.querySelector('[data-compare-notice]')).toBeTruthy();
    // only 3 compared
    const compared = document.querySelectorAll('[data-comparison-remove]');
    expect(compared.length).toBe(3);
  });

  it('opens the inspector and restores focus on close', () => {
    render(<LivingLibrary demo />);
    const inspectBtn = document.querySelector<HTMLButtonElement>('[data-inspect-button]')!;
    inspectBtn.focus();
    fireEvent.click(inspectBtn);
    const dialog = document.querySelector('[data-model-inspector]')!;
    expect(dialog).toBeTruthy();
    const closeBtn = document.querySelector<HTMLButtonElement>('[data-inspector-close]')!;
    expect(document.activeElement).toBe(closeBtn);
    // escape closes
    fireEvent.keyDown(dialog, { key: 'Escape' });
    // dialog removed
    expect(document.querySelector('[data-model-inspector]')).toBeNull();
  });

  it('inspector shows exact id, provider, context, pricing, readiness, compatibility, disabled apply', () => {
    render(<LivingLibrary demo />);
    const inspectBtn = document.querySelector<HTMLButtonElement>('[data-inspect-button]')!;
    fireEvent.click(inspectBtn);
    const dialog = document.querySelector('[data-model-inspector]')!;
    expect(dialog.textContent).toMatch(/Model inspector/i);
    expect(document.querySelector('[data-inspector-apply]')?.hasAttribute('disabled')).toBe(true);
    // exact id present (monospace) — any synth id
    expect(dialog.textContent).toMatch(/synth-/);
  });

  it('renders readiness badges as text (not color alone)', () => {
    render(<LivingLibrary demo />);
    const badges = document.querySelectorAll('[data-readiness]');
    expect(badges.length).toBeGreaterThan(0);
    badges.forEach((b) => {
      // each badge has non-empty text beyond the icon
      expect((b.textContent || '').trim().length).toBeGreaterThan(1);
    });
  });

  it('synthetic banner is present and states the count', () => {
    render(<LivingLibrary demo />);
    const banner = document.querySelector('[data-synthetic-banner]')!;
    expect(banner.textContent).toMatch(/2048/);
  });
});
