import { describe, expect, it } from 'vitest';
import { normalizeSpeechText } from '../../src/application/speechText';

describe('speech text normalization', () => {
  it('removes bold and italic markers', () => {
    expect(normalizeSpeechText('**Stir continuously**')).toBe('Stir continuously');
    expect(normalizeSpeechText('*Add butter*')).toBe('Add butter');
  });

  it('removes list markers and headings', () => {
    expect(normalizeSpeechText('- Add butter')).toBe('Add butter');
    expect(normalizeSpeechText('1. Mix well')).toBe('Mix well');
    expect(normalizeSpeechText('### Prepare the sauce')).toBe('Prepare the sauce');
  });

  it('speaks link text instead of URLs', () => {
    expect(normalizeSpeechText('See [guide](https://example.com)')).toBe('See guide');
  });

  it('converts temperatures', () => {
    expect(normalizeSpeechText('Bake at 350°F')).toBe('Bake at 350 degrees Fahrenheit');
    expect(normalizeSpeechText('Bake at 180°C')).toBe('Bake at 180 degrees Celsius');
  });

  it('converts common fractions', () => {
    expect(normalizeSpeechText('1/2 cup')).toBe('one half cup');
    expect(normalizeSpeechText('1 1/2 tablespoons')).toBe('one and a half tablespoons');
  });

  it('preserves multiplication notation', () => {
    expect(normalizeSpeechText('2 * 3')).toBe('2 * 3');
    expect(normalizeSpeechText('Mix 2*3 cups')).toBe('Mix 2*3 cups');
  });

  it('preserves meaningful symbols and collapses whitespace', () => {
    expect(normalizeSpeechText('Simmer 10–12   minutes')).toBe('Simmer 10–12 minutes');
  });
});
