import { describe, it, expect } from 'vitest';
import {
  parseFraction,
  parseDurationToMinutes,
  formatMinutesToDisplay,
  normalizeTags,
  normalizeDifficulty,
  normalizeRating,
  normalizeIngredient,
  validateCanonicalRecipe,
  normalizeCanonicalRecipe,
  CURRENT_RECIPE_SCHEMA_VERSION,
} from '../../src/schema';

describe('Schema v1 Validation & Normalization Engine', () => {
  describe('parseFraction', () => {
    it('handles unicode fractions and mixed numbers', () => {
      expect(parseFraction('½')).toBe(0.5);
      expect(parseFraction('1 ½')).toBe(1.5);
      expect(parseFraction('2 ¾')).toBe(2.75);
      expect(parseFraction('⅛')).toBe(0.125);
    });

    it('handles ASCII fractions and mixed numbers', () => {
      expect(parseFraction('1/2')).toBe(0.5);
      expect(parseFraction('1 1/2')).toBe(1.5);
      expect(parseFraction('2-1/4')).toBe(2.25);
      expect(parseFraction('3/4')).toBe(0.75);
    });

    it('handles integers and decimals', () => {
      expect(parseFraction('3')).toBe(3);
      expect(parseFraction('1.75')).toBe(1.75);
    });

    it('gracefully handles invalid strings', () => {
      expect(parseFraction('')).toBeNull();
      expect(parseFraction('dash')).toBeNull();
    });
  });

  describe('parseDurationToMinutes & formatMinutesToDisplay', () => {
    it('parses composite hours and minutes', () => {
      expect(parseDurationToMinutes('1 hr 30 mins')).toBe(90);
      expect(parseDurationToMinutes('2 hours and 15 mins')).toBe(135);
      expect(parseDurationToMinutes('1h30m')).toBe(90);
    });

    it('parses pure minutes and minute ranges', () => {
      expect(parseDurationToMinutes('45 mins')).toBe(45);
      expect(parseDurationToMinutes('20-25 minutes')).toBe(20);
      expect(parseDurationToMinutes('15m')).toBe(15);
    });

    it('parses decimal hours', () => {
      expect(parseDurationToMinutes('1.5 hours')).toBe(90);
      expect(parseDurationToMinutes('0.5 hr')).toBe(30);
    });

    it('formats minutes into standard display strings', () => {
      expect(formatMinutesToDisplay(45)).toBe('45 mins');
      expect(formatMinutesToDisplay(60)).toBe('1 hr');
      expect(formatMinutesToDisplay(90)).toBe('1 hr 30 mins');
      expect(formatMinutesToDisplay(120)).toBe('2 hrs');
      expect(formatMinutesToDisplay(135)).toBe('2 hrs 15 mins');
      expect(formatMinutesToDisplay(null)).toBeUndefined();
    });
  });

  describe('normalizeTags', () => {
    it('strips leading hashes, deduplicates, and lowercases', () => {
      const raw = ['#Dinner', 'quick-meals', '#DINNER', 'italian', '#Italian'];
      expect(normalizeTags(raw)).toEqual(['dinner', 'quick-meals', 'italian']);
    });

    it('handles comma-separated string format', () => {
      expect(normalizeTags('baking, #bread, sourdough')).toEqual(['baking', 'bread', 'sourdough']);
    });
  });

  describe('normalizeDifficulty & normalizeRating', () => {
    it('normalizes difficulty strings safely', () => {
      expect(normalizeDifficulty('easy')).toBe('Easy');
      expect(normalizeDifficulty('Intermediate')).toBe('Medium');
      expect(normalizeDifficulty('Advanced')).toBe('Hard');
      expect(normalizeDifficulty('unknown')).toBe('Unspecified');
      expect(normalizeDifficulty(null)).toBe('Unspecified');
    });

    it('clamps rating between 0 and 5', () => {
      expect(normalizeRating(5)).toBe(5);
      expect(normalizeRating(6)).toBe(5);
      expect(normalizeRating(-2)).toBe(0);
      expect(normalizeRating('4')).toBe(4);
    });
  });

  describe('normalizeIngredient', () => {
    it('extracts amounts, units, names, and preparations', () => {
      const parsed = normalizeIngredient('2 cups yellow onions, diced');
      expect(parsed.amount).toBe(2);
      expect(parsed.unit).toBe('cup');
      expect(parsed.name).toBe('yellow onions');
      expect(parsed.preparation).toBe('diced');
    });

    it('parses fraction amounts with wikilinks', () => {
      const parsed = normalizeIngredient('1 ½ tbsp [[Extra Virgin Olive Oil|Olive Oil]]');
      expect(parsed.amount).toBe(1.5);
      expect(parsed.unit).toBe('tbsp');
      expect(parsed.wikilink).toBe('[[Extra Virgin Olive Oil|Olive Oil]]');
      expect(parsed.wikilinkTarget).toBe('Extra Virgin Olive Oil');
      expect(parsed.wikilinkAlias).toBe('Olive Oil');
    });

    it('handles optional ingredients and checklists', () => {
      const parsed = normalizeIngredient('- [x] 1 pinch red pepper flakes (optional)');
      expect(parsed.amount).toBe(1);
      expect(parsed.unit).toBe('pinch');
      expect(parsed.optional).toBe(true);
      expect(parsed.isChecked).toBe(true);
    });
  });

  describe('validateCanonicalRecipe & normalizeCanonicalRecipe', () => {
    it('normalizes minimal recipe input into complete Schema v1 CanonicalRecipe', () => {
      const canonical = normalizeCanonicalRecipe({
        title: 'Classic Carbonara',
        prepTime: '15 mins',
        cookTime: '15 mins',
        category: 'Pasta',
        cuisine: 'Italian',
        servings: 4,
        difficulty: 'Medium',
        rating: 5,
        ingredients: ['400g Spaghetti', '200g Guanciale, diced', '4 large Egg Yolks'],
        instructions: ['Boil pasta.', 'Crisp guanciale.', 'Toss with eggs and cheese.'],
      });

      expect(canonical.schemaVersion).toBe(CURRENT_RECIPE_SCHEMA_VERSION);
      expect(canonical.identity.title).toBe('Classic Carbonara');
      expect(canonical.timings.prepMinutes).toBe(15);
      expect(canonical.timings.cookMinutes).toBe(15);
      expect(canonical.timings.totalMinutes).toBe(30);
      expect(canonical.timings.totalTimeDisplay).toBe('30 mins');
      expect(canonical.ingredients.length).toBe(3);
      expect(canonical.instructions.length).toBe(3);

      const validation = validateCanonicalRecipe(canonical);
      expect(validation.isValid).toBe(true);
      expect(validation.issues.length).toBe(0);
    });
  });
});
