// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RepresentativeImageChooser } from '../../src/components/RepresentativeImageChooser';
import type { RepresentativeImageCandidate } from '../../src/core/representativeImage';

const candidates: RepresentativeImageCandidate[] = [
  {
    id: 'opaque-1',
    source: 'openverse',
    title: 'Blue Cheese Burger',
    thumbnailPath: '/api/recipes/image/representative-thumbnail/opaque-1',
    sourcePageUrl: 'https://www.flickr.com/photos/example/1',
    creator: 'Chef Example',
    license: 'cc_by',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    licenseVersion: '4.0',
  },
  {
    id: 'opaque-2',
    source: 'wikimedia_commons',
    title: 'Smashburger with blue cheese',
    thumbnailPath: '/api/recipes/image/representative-thumbnail/opaque-2',
    sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Burger.jpg',
    license: 'cc_by_sa',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    licenseVersion: '4.0',
  },
];

afterEach(() => cleanup());

describe('RepresentativeImageChooser — explicit selection UI', () => {
  it('shows representative-image wording, sources, creators and licenses', () => {
    render(<RepresentativeImageChooser candidates={candidates} query="blue cheese smashburger" onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Choose a Representative Recipe Image')).toBeTruthy();
    expect(screen.getByText(/Representative recipe image/)).toBeTruthy();
    expect(screen.getByText(/not guaranteed to depict the exact generated dish/)).toBeTruthy();
    expect(screen.getAllByTestId('representative-candidate')).toHaveLength(2);
    expect(screen.getByText(/Openverse/)).toBeTruthy();
    expect(screen.getByText(/Wikimedia Commons/)).toBeTruthy();
    expect(screen.getByText(/Chef Example/)).toBeTruthy();
    expect(screen.getByText(/CC BY 4\.0/)).toBeTruthy();
    expect(screen.getByText(/CC BY-SA 4\.0/)).toBeTruthy();
  });

  it('never auto-selects: Use This Image is disabled until a candidate is explicitly chosen', () => {
    const onSelect = vi.fn();
    render(<RepresentativeImageChooser candidates={candidates} onSelect={onSelect} onCancel={() => {}} />);
    const useButton = screen.getByTestId('use-representative-image') as HTMLButtonElement;
    expect(useButton.disabled).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTestId('representative-candidate')[1]);
    expect((screen.getByTestId('use-representative-image') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('use-representative-image'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: 'opaque-2', source: 'wikimedia_commons' });
  });

  it('Keep Current Image cancels without selecting anything', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    render(<RepresentativeImageChooser candidates={candidates} onSelect={onSelect} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Keep Current Image'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows a bounded no-results state that keeps the current image', () => {
    render(<RepresentativeImageChooser candidates={[]} onSelect={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/No reusable representative images were found/)).toBeTruthy();
    expect(screen.getByText(/current image \(or placeholder\) was kept/)).toBeTruthy();
  });

  it('exposes no AI-generation control in this phase', () => {
    const { container } = render(<RepresentativeImageChooser candidates={candidates} onSelect={() => {}} onCancel={() => {}} />);
    const text = container.textContent || '';
    expect(text).not.toMatch(/Generate with AI/i);
    expect(text).not.toMatch(/AI-generated/i);
    expect(text).not.toMatch(/free AI/i);
  });

  it('is a named dialog that receives initial focus', () => {
    render(<RepresentativeImageChooser candidates={candidates} onSelect={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Choose a Representative Recipe Image');
    expect(document.activeElement).toBe(dialog);
  });

  it('Escape closes without selecting anything', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    render(<RepresentativeImageChooser candidates={candidates} onSelect={onSelect} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('aria-pressed reflects the explicitly selected candidate', () => {
    render(<RepresentativeImageChooser candidates={candidates} onSelect={() => {}} onCancel={() => {}} />);
    const buttons = screen.getAllByTestId('representative-candidate');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(buttons[1]);
    const after = screen.getAllByTestId('representative-candidate');
    expect(after[0].getAttribute('aria-pressed')).toBe('false');
    expect(after[1].getAttribute('aria-pressed')).toBe('true');
  });
});
