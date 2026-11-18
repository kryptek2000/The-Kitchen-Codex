import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getRecipeImage,
  isBundledStarterImageRef,
  LOCAL_RECIPE_IMAGE_PLACEHOLDER,
  resolveBundledStarterImage,
} from '../../src/utils/imageHelper';
import { assessRecipeImageHealth } from '../../src/core/recipeImage';
import { getStarterVaultRecipes } from '../../src/data/starterVault';
import { isApprovedStarterImagePath, STARTER_IMAGE_PATH_LIST } from '../../src/data/starterImageAssets';

function activeEmptyScope() {
  return {
    isActive: () => true,
    isAccepting: () => true,
    get: () => undefined,
    ownsUrl: () => false,
    subscribe: () => () => {},
  } as any;
}

describe('bundled Starter recipe images', () => {
  it('resolves the app-owned Starter namespace without a Vault or network', () => {
    for (const path of STARTER_IMAGE_PATH_LIST) {
      expect(isApprovedStarterImagePath(path)).toBe(true);
      expect(isBundledStarterImageRef(path)).toBe(true);
      expect(resolveBundledStarterImage(path)).toBe(path);
      expect(getRecipeImage({ image: path }, activeEmptyScope())).toBe(path);
    }
  });

  it('rejects every non-canonical app-image alias', () => {
    const approved = STARTER_IMAGE_PATH_LIST[0];
    const rejected = [
      '/app-images/starter/..\\..\\server.cjs',
      '/app-images/starter/..\\\\..\\\\server.cjs',
      '/app-images/starter/%5c..%5c..%5cserver.cjs',
      '/app-images/starter/..%2f..%2fserver.cjs',
      '/app-images/starter/%252e%252e%252fserver.cjs',
      '/app-images/starter/PROVENANCE.md',
      '/app-images/starter/nonexistent.jpg',
      `${approved}?bypass=1`,
      `${approved}#fragment`,
      '/app-images/starter/',
      '/app-images/starter',
      '/app-images/starter/../artisan-sourdough-boule.jpg',
      '/app-images/starter\\artisan-sourdough-boule.jpg',
      'app-images/starter/artisan-sourdough-boule.jpg',
      '//app-images/starter/artisan-sourdough-boule.jpg',
      '/APP-IMAGES/starter/artisan-sourdough-boule.jpg',
      '',
      '   ',
      undefined,
      null,
    ];
    for (const ref of rejected) {
      expect(isApprovedStarterImagePath(ref), String(ref)).toBe(false);
      expect(isBundledStarterImageRef(ref as string | undefined), String(ref)).toBe(false);
      expect(resolveBundledStarterImage(ref as string | undefined), String(ref)).toBeNull();
      if (typeof ref === 'string') {
        expect(getRecipeImage({ image: ref }, activeEmptyScope()), ref).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
      }
    }
  });

  it('rejects traversal and lookalike paths from the app-owned namespace', () => {
    expect(isBundledStarterImageRef('/app-images/starter/../secret.jpg')).toBe(false);
    expect(isBundledStarterImageRef('/app-images/starter/./secret.jpg')).toBe(false);
    expect(isBundledStarterImageRef('/app-images/other/soup.jpg')).toBe(false);
    expect(resolveBundledStarterImage('/app-images/starter/../secret.jpg')).toBeNull();
  });

  it('does not bypass the Vault scope for a user-selected Vault image', () => {
    const resolved = getRecipeImage({ image: 'Assets/User Photo.jpg' }, activeEmptyScope());
    expect(resolved).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
    expect(resolved).not.toContain('app-images');
  });

  it('does not replace a user-selected remote image with a Starter asset', () => {
    expect(getRecipeImage({ image: 'https://example.com/user-photo.jpg' })).toBe(
      'https://example.com/user-photo.jpg'
    );
  });

  it('keeps missing-image behavior honest', () => {
    expect(getRecipeImage({ image: undefined })).toBe(LOCAL_RECIPE_IMAGE_PLACEHOLDER);
  });

  it('classifies bundled Starter images as valid local app assets without Vault access', async () => {
    const health = await assessRecipeImageHealth({ image: STARTER_IMAGE_PATH_LIST[0] });
    expect(health.kind).toBe('valid_local');
    expect(health.deterministic).toBe(true);
  });

  it('classifies an unapproved app-image path as broken, never valid', async () => {
    const health = await assessRecipeImageHealth({ image: '/app-images/starter/PROVENANCE.md' });
    expect(health.kind).toBe('broken_local');
    expect(health.kind).not.toBe('valid_local');
  });

  it('has every Starter recipe image present in the bundled public namespace', () => {
    const recipes = getStarterVaultRecipes();
    expect(recipes).toHaveLength(9);
    for (const recipe of recipes) {
      expect(recipe.image, recipe.title).toMatch(/^\/app-images\/starter\/[a-z0-9-]+\.jpg$/);
      const file = join(process.cwd(), 'public', (recipe.image as string).replace(/^\//, ''));
      expect(readFileSync(file).length, recipe.title).toBeGreaterThan(1000);
    }
  });
});
