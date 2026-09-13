import { describe, it, expect } from 'vitest';
import { getRecipeImage, DEFAULT_FOOD_IMAGES, LOCAL_RECIPE_IMAGE_PLACEHOLDER } from '../../src/utils/imageHelper';

/**
 * Phase 1 wrong-image regression: a generated recipe must NEVER automatically
 * receive a keyword-matched generic stock photo, and an imageless recipe must
 * NEVER return an HTTP(S) placeholder. "Blue Cheese Smashburgers" previously
 * matched `beef`/`steak`/`burger` and displayed a generic sliced-beef image.
 */
describe('getRecipeImage — no automatic keyword stock matching / no remote placeholder', () => {
  it('returns a repository-owned local placeholder for imageless recipes (never HTTP/S)', () => {
    const image = getRecipeImage({
      title: 'Blue Cheese Smashburgers',
      category: 'Main Course',
      cuisine: 'American',
      tags: ['food/recipes', 'beef', 'burger'],
    });
    expect(image).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
    expect(image.startsWith('data:')).toBe(true);
    expect(image).not.toMatch(/^https?:\/\//);
    expect(DEFAULT_FOOD_IMAGES.default).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
  });

  it('never maps any keyword in the title/tags to a stock image', () => {
    for (const title of ['Steak', 'Chicken Curry', 'Salmon Salad', 'Pizza', 'Chocolate Cake']) {
      const image = getRecipeImage({ title, tags: [title.toLowerCase()] });
      expect(image).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
      expect(image).not.toMatch(/^https?:\/\//);
    }
  });

  it('the placeholder contains no script or external resource reference', () => {
    const decoded = decodeURIComponent(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
    expect(decoded).not.toMatch(/<script/i);
    expect(decoded).not.toMatch(/<image/i);
    expect(decoded).not.toMatch(/href\s*=/i);
    expect(decoded).not.toMatch(/src\s*=/i);
    expect(decoded).not.toMatch(/url\(\s*['"]?https?:/i);
    // The only absolute URI is the SVG namespace declaration (not a fetch).
    expect(decoded).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);
  });

  it('still honors an explicit image reference', () => {
    expect(getRecipeImage({ title: 'X', image: 'https://example.com/hero.jpg' })).toBe('https://example.com/hero.jpg');
    expect(getRecipeImage({ title: 'X', image: 'Assets/Hero.jpg' })).toBe('Assets/Hero.jpg');
  });
});
