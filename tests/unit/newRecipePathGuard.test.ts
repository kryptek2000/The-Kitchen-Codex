/**
 * The Kitchen Codex — New-Recipe Path Regression Guard (Phase 4C3C).
 *
 * The VaultAdapter honors a recipe's full `filePath`. A former per-producer
 * hardcoded path (e.g. `Food/Recipes/${fileName}`) now becomes a REAL nested
 * directory inside the connected vault root. This static guard proves the
 * recipe-producing components no longer emit such a nested persistence path for
 * NEW recipes.
 *
 * Only literal producer-path template literals are flagged. Legitimate
 * documentation, comments, and UI description strings that merely mention these
 * directories are NOT targeted (they are not persistence paths).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const PRODUCER_FILES = [
  'src/components/RecipeGrabberModal.tsx',
  'src/components/RecipeEditorModal.tsx',
  'src/components/ConnectVaultModal.tsx',
];

/** Hardcoded NEW-recipe persistence paths that create nested directories. */
const FORBIDDEN_PRODUCER_PATH = [
  'Food/Recipes/${',
  '6 - Full Notes/Food/Recipes/${',
  'Recipes/${',
];

describe('new-recipe path regression guard (Phase 4C3C)', () => {
  it('recipe producers do not hardcode a nested new-recipe persistence path', () => {
    for (const file of PRODUCER_FILES) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      for (const forbidden of FORBIDDEN_PRODUCER_PATH) {
        expect(src.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
    }
  });
});
