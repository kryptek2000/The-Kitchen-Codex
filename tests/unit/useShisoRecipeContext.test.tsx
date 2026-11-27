// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useShisoRecipeContext } from '../../src/application-ui/useShisoRecipeContext';

describe('production SHISO recipe context projection', () => {
  it('retains authored quantity and unit for the deterministic nutrition path', () => {
    const { result } = renderHook(() => useShisoRecipeContext({
      title: '15-Minute Strawberry Spinach Salad',
      servings: 4,
      // This is the shape supplied by the production recipe view: the
      // authored line is present even when structured amount/unit fields have
      // not been materialized by the upstream parser.
      ingredients: [{
        original: '1/4 cup honey (or brown sugar)',
        name: 'honey',
      }],
      instructions: [],
    }));

    expect(result.current?.ingredients[0]).toMatchObject({
      text: '1/4 cup honey (or brown sugar)',
      name: 'honey',
      amount: 0.25,
      unit: 'cup',
    });
    expect(result.current?.ingredients[0]?.line_ref).toMatch(/^ing:/);
  });
});
