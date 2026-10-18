/** Remove explicit, erased type-only import declarations from runtime graph input. */
export function withoutTypeOnlyImports(source: string): string {
  return source.replace(/^\s*import\s+type\b[\s\S]*?;/gm, '');
}
