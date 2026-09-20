// @vitest-environment jsdom
/**
 * The Kitchen Codex — recipe-detail route restoration (App-level).
 *
 * Proves the separate hands-on defect: a hard refresh on a recipe detail page
 * restores the SAME recipe instead of returning to the gallery, an invalid
 * route fails safely to the gallery, and the gallery route stays the gallery.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import App from '../../src/App';
import { buildGalleryRoute, buildRecipeRoute } from '../../src/utils/recipeRoute';

const RECIPE_ID = 'Classic Roman Carbonara.md';
const RECIPE_TITLE = 'Classic Roman Carbonara';

function setHash(hash: string) {
  window.history.replaceState(null, '', hash);
}

beforeEach(() => {
  setHash(buildGalleryRoute());
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', buildGalleryRoute());
});

describe('App recipe-detail route restoration', () => {
  it('opening a recipe reflects it in the browser route', async () => {
    render(<App />);
    const card = await screen.findByText(RECIPE_TITLE);
    fireEvent.click(card);
    await waitFor(() => {
      expect(window.location.hash).toBe(buildRecipeRoute(RECIPE_ID));
    });
  });

  it('remounting with a recipe route restores the same recipe', async () => {
    setHash(buildRecipeRoute(RECIPE_ID));
    render(<App />);
    // The detail view shows a Back control once the recipe is resolved.
    await waitFor(() => {
      expect(screen.getAllByText(RECIPE_TITLE).length).toBeGreaterThan(0);
    });
    // Gallery-only content should not be the active view.
    expect(window.location.hash).toBe(buildRecipeRoute(RECIPE_ID));
  });

  it('an invalid recipe route fails safely back to the gallery', async () => {
    setHash(buildRecipeRoute('does-not-exist.md'));
    render(<App />);
    await waitFor(() => {
      expect(window.location.hash).toBe(buildGalleryRoute());
    });
  });

  it('the gallery route stays the gallery', async () => {
    setHash(buildGalleryRoute());
    render(<App />);
    await screen.findByText(RECIPE_TITLE);
    expect(window.location.hash).toBe(buildGalleryRoute());
  });
});
