// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  RepresentativeImageChooser,
  REPRESENTATIVE_NO_RESULTS_MESSAGE,
} from '../../src/components/RepresentativeImageChooser';
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

  it('shows exactly ONE authoritative no-results message that keeps the current image', () => {
    render(<RepresentativeImageChooser candidates={[]} onSelect={() => {}} onCancel={() => {}} />);
    const matches = screen.getAllByText(/No reusable representative images were found/);
    expect(matches).toHaveLength(1);
    expect(matches[0].textContent).toBe(REPRESENTATIVE_NO_RESULTS_MESSAGE);
  });

  it('prefills the sanitized default search terms', () => {
    render(
      <RepresentativeImageChooser
        candidates={[]}
        searchTerms="blue cheese smashburger"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    expect((screen.getByTestId('representative-search-input') as HTMLInputElement).value).toBe(
      'blue cheese smashburger'
    );
  });

  it('typing alone makes NO search request', () => {
    const onSearch = vi.fn();
    render(
      <RepresentativeImageChooser
        candidates={[]}
        searchTerms="blue cheese smashburger"
        onSearch={onSearch}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    fireEvent.change(screen.getByTestId('representative-search-input'), {
      target: { value: 'blue cheese burger' },
    });
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('the Search button submits exactly one explicit search', () => {
    const onSearch = vi.fn();
    render(
      <RepresentativeImageChooser
        candidates={[]}
        searchTerms="blue cheese burger"
        onSearch={onSearch}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('representative-search-button'));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('blue cheese burger');
  });

  it('native Enter (form submit) submits exactly one explicit search', () => {
    const onSearch = vi.fn();
    render(
      <RepresentativeImageChooser
        candidates={[]}
        searchTerms="cheeseburger"
        onSearch={onSearch}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    // Native implicit submission from Enter is the form's submit event — the
    // SINGLE dispatch path (the Search button uses the same one).
    fireEvent.submit(screen.getByTestId('representative-search-form'));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('cheeseburger');
  });

  it('has NO separate key handler: raw and IME/composition Enter do not dispatch', () => {
    const onSearch = vi.fn();
    render(
      <RepresentativeImageChooser
        candidates={[]}
        searchTerms="cheeseburger"
        onSearch={onSearch}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    const input = screen.getByTestId('representative-search-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Process', isComposing: true });
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('the Search button and form share ONE canonical path (exactly once)', () => {
    const onSearch = vi.fn();
    render(
      <RepresentativeImageChooser
        candidates={[]}
        searchTerms="blue cheese burger"
        onSearch={onSearch}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    fireEvent.click(screen.getByTestId('representative-search-button'));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('blue cheese burger');
  });

  it('a new search generation immediately clears the preview and disables confirmation', () => {
    const { rerender } = render(
      <RepresentativeImageChooser
        candidates={candidates}
        searchGeneration={1}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]);
    expect((screen.getByTestId('use-representative-image') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Preview:/)).toBeTruthy();

    // Same candidate list, NEW generation: selection authority must be gone.
    rerender(
      <RepresentativeImageChooser
        candidates={candidates}
        searchGeneration={2}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    expect((screen.getByTestId('use-representative-image') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Preview:/)).toBeNull();
  });

  it('a preview that is not part of the current result set is never confirmable', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <RepresentativeImageChooser candidates={candidates} onSelect={onSelect} onCancel={() => {}} />
    );
    fireEvent.click(screen.getAllByTestId('representative-candidate')[0]); // opaque-1
    expect((screen.getByTestId('use-representative-image') as HTMLButtonElement).disabled).toBe(false);

    // New result set does NOT include opaque-1.
    rerender(
      <RepresentativeImageChooser candidates={[candidates[1]]} onSelect={onSelect} onCancel={() => {}} />
    );
    expect((screen.getByTestId('use-representative-image') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Preview:/)).toBeNull();
    fireEvent.click(screen.getByTestId('use-representative-image'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('no-results shows bounded suggestions that fill the input but never auto-search', () => {
    const onSearch = vi.fn();
    render(
      <RepresentativeImageChooser
        candidates={[]}
        suggestions={['blue cheese burger', 'smashburger', 'cheeseburger']}
        onSearch={onSearch}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    );
    const suggestions = screen.getAllByTestId('representative-suggestion');
    expect(suggestions).toHaveLength(3);
    fireEvent.click(suggestions[0]);
    expect(onSearch).not.toHaveBeenCalled();
    expect((screen.getByTestId('representative-search-input') as HTMLInputElement).value).toBe(
      'blue cheese burger'
    );
  });

  it('shows a bounded loading state while searching', () => {
    render(
      <RepresentativeImageChooser candidates={[]} busy onSelect={() => {}} onCancel={() => {}} />
    );
    expect(screen.getByTestId('representative-loading')).toBeTruthy();
    expect(screen.queryByText(/No reusable representative images were found/)).toBeNull();
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
