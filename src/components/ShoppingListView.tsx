import React, { useState, useMemo } from 'react';
import {
  ShoppingCart,
  Copy,
  Check,
  Plus,
  Trash2,
  CheckCheck,
  FileCode,
  Calendar,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import { ShoppingCategoryGroup, MealPlanDay } from '../types';

interface ShoppingListViewProps {
  categories: ShoppingCategoryGroup[];
  mealPlan?: MealPlanDay[];
  onToggleItem: (categoryId: string, itemId: string) => void;
  onAddItem: (category: string, text: string) => void;
  onDeleteItem: (categoryId: string, itemId: string) => void;
  onClearChecked: () => void;
  onNavigateToMealPlan?: () => void;
}

export function ShoppingListView({
  categories,
  mealPlan = [],
  onToggleItem,
  onAddItem,
  onDeleteItem,
  onClearChecked,
  onNavigateToMealPlan,
}: ShoppingListViewProps) {
  const [newItemText, setNewItemText] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [copiedObsidian, setCopiedObsidian] = useState(false);

  const totalPlannedMeals = mealPlan.reduce(
    (acc, d) =>
      acc +
      (d.breakfast?.recipeTitle ? 1 : 0) +
      (d.lunch?.recipeTitle ? 1 : 0) +
      (d.dinner?.recipeTitle ? 1 : 0),
    0
  );

  const availableCategories = useMemo(() => {
    const existing = categories.map((c) => c.category);
    const defaults = [
      'Produce & Fresh Herbs',
      'Meat & Seafood',
      'Dairy & Eggs',
      'Pantry & Grains',
      'Spices & Baking',
      'Other',
    ];
    const combined = Array.from(new Set([...existing, ...defaults]));
    return combined;
  }, [categories]);

  const activeCategoryChoice = selectedCategory || availableCategories[0] || 'Produce & Fresh Herbs';

  const totalItems = categories.reduce((acc, cat) => acc + cat.items.length, 0);
  const checkedItems = categories.reduce(
    (acc, cat) => acc + cat.items.filter((i) => i.isChecked).length,
    0
  );

  const handleAddNewItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemText.trim()) return;
    onAddItem(activeCategoryChoice, newItemText.trim());
    setNewItemText('');
  };

  const handleCopyObsidianMarkdown = () => {
    let md = `## 🛒 Grocery Shopping List\n\n`;
    categories.forEach((cat) => {
      if (cat.items.length > 0) {
        md += `### ${cat.category}\n`;
        cat.items.forEach((item) => {
          const check = item.isChecked ? '[x]' : '[ ]';
          md += `- ${check} ${item.text}\n`;
        });
        md += '\n';
      }
    });

    navigator.clipboard.writeText(md);
    setCopiedObsidian(true);
    setTimeout(() => setCopiedObsidian(false), 2500);
  };

  return (
    <div id="obsidian-shopping-list-view" className="max-w-4xl mx-auto kc-vault-surface py-6 space-y-6">
      {/* Editorial header */}
      <header className="space-y-2 pb-4 border-b border-[var(--color-rule,var(--bg-elevated))]">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] font-semibold text-[var(--text-muted,#6B7280)]">
          <ShoppingCart className="w-4 h-4" aria-hidden="true" />
          <span>Shopping List</span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="font-serif text-[32px] sm:text-[40px] leading-[1.15] text-[var(--text-primary,#F3F4F6)]">
              Smart Grocery &amp; Pantry List
            </h1>
            <p className="text-[14px] leading-[1.55] text-[var(--text-secondary,#9CA3AF)] max-w-2xl">
              {totalItems === 0
                ? 'Only ingredients for meals on your weekly meal plan are displayed here.'
                : `${checkedItems} of ${totalItems} items completed`}
            </p>
          </div>
          <span
            className={`inline-flex items-center px-3 py-1 rounded-full text-[12px] font-semibold border ${
              totalPlannedMeals > 0
                ? 'bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)] border-[var(--accent-text,#F59E0B)]'
                : 'bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-muted,#6B7280)] border-[var(--color-control-border,rgba(255,255,255,0.1))]'
            }`}
          >
            {totalPlannedMeals} {totalPlannedMeals === 1 ? 'meal on plan' : 'meals on plan'}
          </span>
        </div>
      </header>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        {onNavigateToMealPlan && (
          <button
            onClick={onNavigateToMealPlan}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] hover:bg-[var(--bg-surface,#141414)] text-[var(--text-primary,#F3F4F6)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] text-[13px] font-semibold transition-colors duration-[140ms] min-h-[44px]"
          >
            <Calendar className="w-4 h-4" aria-hidden="true" />
            <span>Weekly Planner</span>
          </button>
        )}

        <button
          id="copy-obsidian-checklist-btn"
          onClick={handleCopyObsidianMarkdown}
          disabled={totalItems === 0}
          title="Copy as Obsidian Markdown Checklist format"
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--bg-elevated,#1E1E1E)] hover:bg-[var(--bg-surface,#141414)] text-[var(--text-secondary,#9CA3AF)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] text-[13px] font-semibold transition-colors duration-[140ms] min-h-[44px] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {copiedObsidian ? <Check className="w-4 h-4 text-emerald-400" aria-hidden="true" /> : <FileCode className="w-4 h-4 text-[var(--accent-text,#F59E0B)]" aria-hidden="true" />}
          <span>{copiedObsidian ? 'Copied Markdown!' : 'Copy as Markdown'}</span>
        </button>

        {checkedItems > 0 && (
          <button
            onClick={onClearChecked}
            className="flex items-center gap-1 px-4 py-2 rounded-lg text-[13px] font-medium text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--text-primary,#F3F4F6)] hover:bg-[var(--bg-elevated,#1E1E1E)] transition-colors duration-[140ms] min-h-[44px]"
          >
            <CheckCheck className="w-4 h-4" aria-hidden="true" />
            <span>Clear Done</span>
          </button>
        )}
      </div>

      {/* Add custom item form */}
      <form onSubmit={handleAddNewItem} className="flex flex-col sm:flex-row gap-2">
        <input
          id="new-grocery-item-input"
          type="text"
          value={newItemText}
          onChange={(e) => setNewItemText(e.target.value)}
          placeholder="Add custom item (e.g. 2 ripe Avocados, Sea Salt)..."
          aria-label="New grocery item"
          className="flex-1 text-sm bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-xl px-3.5 py-2.5 text-[var(--text-primary,#F3F4F6)] placeholder:text-[var(--text-muted,#6B7280)] focus:outline-none focus:border-[var(--accent-text,#F59E0B)] min-h-[44px]"
        />
        <select
          value={activeCategoryChoice}
          onChange={(e) => setSelectedCategory(e.target.value)}
          aria-label="Category for new item"
          className="text-sm bg-[var(--bg-elevated,#1E1E1E)] border border-[var(--color-control-border,rgba(255,255,255,0.1))] rounded-xl px-3 py-2 text-[var(--text-secondary,#9CA3AF)] focus:outline-none focus:border-[var(--accent-text,#F59E0B)] min-h-[44px] sm:max-w-xs"
        >
          {availableCategories.map((cat) => (
            <option key={cat} value={cat} className="bg-[var(--bg-elevated,#1E1E1E)]">
              {cat}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="flex items-center justify-center gap-1 px-4 py-2 bg-[var(--accent,#F59E0B)] hover:bg-[var(--accent-hover,#D97706)] text-[var(--color-on-accent,#0C0C0C)] rounded-xl text-sm font-bold transition-colors duration-[140ms] min-h-[44px]"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          <span>Add</span>
        </button>
      </form>

      {/* Categorized lists or empty state */}
      {totalItems === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-control-border,rgba(255,255,255,0.1))] bg-[var(--bg-surface,#141414)] p-8 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-[var(--accent-subtle,rgba(245,158,11,0.15))] border border-[var(--accent-text,#F59E0B)] text-[var(--accent-text,#F59E0B)] flex items-center justify-center mx-auto">
            <ShoppingCart className="w-6 h-6" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h3 className="font-serif font-bold text-sm text-[var(--text-primary,#F3F4F6)]">
              {totalPlannedMeals === 0 ? 'Weekly Meal Plan is Empty' : 'Your shopping list is empty'}
            </h3>
            <p className="text-xs text-[var(--text-secondary,#9CA3AF)] max-w-md mx-auto leading-relaxed">
              {totalPlannedMeals === 0
                ? 'The shopping list only displays ingredients when meals are scheduled on your weekly meal plan. Schedule meals in the planner to automatically generate your grocery list.'
                : 'All items have been completed or removed. Add more meals to your weekly meal plan or add custom items above.'}
            </p>
          </div>

          {onNavigateToMealPlan && (
            <button
              onClick={onNavigateToMealPlan}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent,#F59E0B)] hover:bg-[var(--accent-hover,#D97706)] text-[var(--color-on-accent,#0C0C0C)] font-bold text-xs transition-all duration-[140ms] shadow-sm min-h-[44px]"
            >
              <Calendar className="w-4 h-4" aria-hidden="true" />
              <span>Go to Weekly Meal Planner</span>
              <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {categories.map((group) => {
            if (group.items.length === 0) return null;

            return (
              <div
                key={group.category}
                className="rounded-2xl border border-[var(--color-rule,var(--bg-elevated))] bg-[var(--bg-surface,#141414)] p-4 shadow-xs space-y-2"
              >
                <h3 className="text-xs font-bold text-[var(--text-primary,#F3F4F6)] uppercase tracking-wider pb-2 border-b border-[var(--color-rule,var(--bg-elevated))] flex items-center justify-between">
                  <span>{group.category}</span>
                  <span className="text-[11px] font-normal text-[var(--text-muted,#6B7280)]">
                    {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                  </span>
                </h3>

                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li
                      key={item.id}
                      className={`flex items-center justify-between gap-3 p-2.5 rounded-lg transition-colors group ${
                        item.isChecked
                          ? 'bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-muted,#6B7280)] line-through'
                          : 'hover:bg-[var(--bg-elevated,#1E1E1E)] text-[var(--text-primary,#F3F4F6)]'
                      }`}
                    >
                      <label className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={item.isChecked}
                          onChange={() => onToggleItem(group.category, item.id)}
                          aria-label={item.text}
                          className="rounded accent-[var(--accent,#F59E0B)] cursor-pointer w-4 h-4 shrink-0"
                        />
                        <span className="text-xs sm:text-sm truncate">{item.text}</span>
                      </label>

                      <div className="flex items-center gap-2 shrink-0">
                        {item.recipeSources && item.recipeSources.length > 0 && (
                          <span className="text-[10px] font-mono text-[var(--text-muted,#6B7280)] hidden sm:inline truncate max-w-xs">
                            {item.recipeSources.join(', ')}
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteItem(group.category, item.id);
                          }}
                          aria-label={`Delete ${item.text}`}
                          className="w-11 h-11 flex items-center justify-center rounded-lg text-[var(--text-muted,#6B7280)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors duration-[140ms]"
                        >
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
