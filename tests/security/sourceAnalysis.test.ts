import { expect, it } from 'vitest';
import { withoutTypeOnlyImports } from '../helpers/sourceAnalysis';
it('erases declared type-only imports while preserving actual dynamic and static imports', () => {
  const source = `import type { T } from './type-only';
const load = () => import('./runtime');
import { run } from './static';`;
  const result = withoutTypeOnlyImports(source);
  expect(result).not.toContain('./type-only');
  expect(result).toContain("import('./runtime')");
  expect(result).toContain("from './static'");
});
