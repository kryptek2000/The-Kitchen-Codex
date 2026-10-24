// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import { ShoppingListView } from '../../src/components/ShoppingListView';
import { ShoppingCategoryGroup } from '../../src/types';

afterEach(() => cleanup());

const categories: ShoppingCategoryGroup[] = [
  {
    category: 'Produce',
    items: [
      { id: 'i1', text: 'Tomatoes', recipeSources: ['Soup'], isChecked: false },
      { id: 'i2', text: 'Onions', recipeSources: [], isChecked: true },
    ],
  },
];

describe('ShoppingListView', () => {
  it('renders categories and item text', () => {
    render(
      <ShoppingListView
        categories={categories}
        onToggleItem={() => {}}
        onAddItem={() => {}}
        onDeleteItem={() => {}}
        onClearChecked={() => {}}
      />
    );
    expect(screen.getAllByText('Produce').length).toBeGreaterThan(0);
    expect(screen.getByText('Tomatoes')).toBeTruthy();
    expect(screen.getByText('Onions')).toBeTruthy();
  });

  it('adding an item invokes onAddItem with category and text', () => {
    const onAdd = vi.fn();
    render(
      <ShoppingListView
        categories={categories}
        onToggleItem={() => {}}
        onAddItem={onAdd}
        onDeleteItem={() => {}}
        onClearChecked={() => {}}
      />
    );
    const input = screen.getByPlaceholderText(/Add custom item/i);
    fireEvent.change(input, { target: { value: 'Salt' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAdd).toHaveBeenCalledWith(expect.any(String), 'Salt');
  });

  it('checking/unchecking invokes onToggleItem', () => {
    const onToggle = vi.fn();
    render(
      <ShoppingListView
        categories={categories}
        onToggleItem={onToggle}
        onAddItem={() => {}}
        onDeleteItem={() => {}}
        onClearChecked={() => {}}
      />
    );
    const cb = screen.getByLabelText('Tomatoes');
    fireEvent.click(cb);
    expect(onToggle).toHaveBeenCalledWith('Produce', 'i1');
  });

  it('delete operates independently of item toggle', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    render(
      <ShoppingListView
        categories={categories}
        onToggleItem={onToggle}
        onAddItem={() => {}}
        onDeleteItem={onDelete}
        onClearChecked={() => {}}
      />
    );
    const delBtn = screen.getByLabelText('Delete Tomatoes');
    fireEvent.click(delBtn);
    expect(onDelete).toHaveBeenCalledWith('Produce', 'i1');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('Clear Done invokes onClearChecked', () => {
    const onClear = vi.fn();
    render(
      <ShoppingListView
        categories={categories}
        onToggleItem={() => {}}
        onAddItem={() => {}}
        onDeleteItem={() => {}}
        onClearChecked={onClear}
      />
    );
    fireEvent.click(screen.getByText('Clear Done').closest('button')!);
    expect(onClear).toHaveBeenCalled();
  });

  it('copy button produces checklist and toggles label', () => {
    // mock clipboard
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(
      <ShoppingListView
        categories={categories}
        onToggleItem={() => {}}
        onAddItem={() => {}}
        onDeleteItem={() => {}}
        onClearChecked={() => {}}
      />
    );
    fireEvent.click(screen.getByText('Copy as Markdown').closest('button')!);
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    const md = (navigator.clipboard.writeText as any).mock.calls[0][0];
    expect(md).toContain('Tomatoes');
    expect(md).toContain('[ ]');
    expect(md).toContain('[x]');
  });

  it('Weekly Planner navigation works', () => {
    const onNav = vi.fn();
    render(
      <ShoppingListView
        categories={categories}
        onToggleItem={() => {}}
        onAddItem={() => {}}
        onDeleteItem={() => {}}
        onClearChecked={() => {}}
        onNavigateToMealPlan={onNav}
      />
    );
    fireEvent.click(screen.getByText('Weekly Planner').closest('button')!);
    expect(onNav).toHaveBeenCalled();
  });

  it('empty state displays correctly', () => {
    render(
      <ShoppingListView
        categories={[{ category: 'Produce', items: [] }]}
        onToggleItem={() => {}}
        onAddItem={() => {}}
        onDeleteItem={() => {}}
        onClearChecked={() => {}}
      />
    );
    expect(screen.getByText(/Your shopping list is empty|Weekly Meal Plan is Empty/i)).toBeTruthy();
  });

  it('delete button is always visible (not hover-gated)', () => {
    const { container } = render(
      <ShoppingListView
        categories={categories}
        onToggleItem={() => {}}
        onAddItem={() => {}}
        onDeleteItem={() => {}}
        onClearChecked={() => {}}
      />
    );
    const btn = container.querySelector('button[aria-label="Delete Tomatoes"]');
    expect(btn).toBeTruthy();
    // should not have opacity-0 class
    expect(btn!.className).not.toMatch(/opacity-0/);
    // should have min-h 44
    expect(btn!.className).toMatch(/min-h-\[44px\]|w-11 h-11/);
  });
});
