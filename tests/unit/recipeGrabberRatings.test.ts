import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { grabRecipeFromWeb } from '../../server/recipeGrabber.js';

// Avoid network; use rawText path which doesn't fetch.
describe('recipe grabber ratings', () => {
  it('extracts a 5/5 aggregate rating from JSON-LD', async () => {
    const html = `<html><head><script type="application/ld+json">
    {"@type":"Recipe","name":"Test","recipeIngredient":["1 cup flour"],"recipeInstructions":["Mix."],"aggregateRating":{"@type":"AggregateRating","ratingValue":"5","bestRating":"5","ratingCount":"10"}}
    </script></head><body></body></html>`;
    const result = await grabRecipeFromWeb({ html });
    expect(result.rating).toBe(5);
    expect(result.ratingSource).toBe('imported');
    expect(result.rawMarkdown).toContain('rating: 5');
    expect(result.rawMarkdown).toContain('rating_source: imported');
  });

  it('extracts a 4/5 aggregate rating', async () => {
    const html = `<html><head><script type="application/ld+json">
    {"@type":"Recipe","name":"Test","recipeIngredient":["1 cup flour"],"recipeInstructions":["Mix."],"aggregateRating":{"@type":"AggregateRating","ratingValue":"4","bestRating":"5"}}
    </script></head><body></body></html>`;
    const result = await grabRecipeFromWeb({ html });
    expect(result.rating).toBe(4);
    expect(result.ratingSource).toBe('imported');
  });

  it('leaves rating unrated when no aggregateRating', async () => {
    const html = `<html><head><script type="application/ld+json">
    {"@type":"Recipe","name":"Test","recipeIngredient":["1 cup flour"],"recipeInstructions":["Mix."]}
    </script></head><body></body></html>`;
    const result = await grabRecipeFromWeb({ html });
    expect(result.rating).toBe(0);
    expect(result.ratingSource).toBeUndefined();
    expect(result.rawMarkdown).not.toContain('rating: 5');
  });

  it('scales a 4.5/10 aggregate rating', async () => {
    const html = `<html><head><script type="application/ld+json">
    {"@type":"Recipe","name":"Test","recipeIngredient":["1 cup flour"],"recipeInstructions":["Mix."],"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.5","bestRating":"10"}}
    </script></head><body></body></html>`;
    const result = await grabRecipeFromWeb({ html });
    expect(result.rating).toBe(2.3);
    expect(result.ratingSource).toBe('imported');
  });
});
