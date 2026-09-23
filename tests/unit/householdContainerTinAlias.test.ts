import { describe, it, expect } from 'vitest';
import { parseIngredient } from '../../src/core/nutritionV2/matching/parse';
import { canonicalHouseholdUnit, householdContainerNouns } from '../../src/utils/householdUnits';

/**
 * Focused regression coverage: `tin` / `tins` are ordinary container aliases of
 * the EXISTING canonical container noun `can`.
 *
 * Contract proved here (no new semantics):
 *   - the alias resolves to the existing container noun `can`;
 *   - the canonical container vocabulary is unchanged (no new noun `tin`);
 *   - a leading `tin` is consumed as container amount metadata, so the count is
 *     preserved and the token never leaks into the match query;
 *   - the parsed result is identical (on every authority-bearing field) to the
 *     equivalent `can` line — no conversion, weight, or mass is introduced.
 */

type Parsed = {
  readonly container?: string;
  readonly count_noun?: string;
  readonly unit_kind?: string;
  readonly amount: number | null;
  readonly query: string;
  readonly measurement_kind: string;
  readonly quantity_kind: string;
  readonly package_net_mass?: unknown;
};

function parseOk(line: string): Parsed {
  const result = parseIngredient(line);
  if (!result.ok) throw new Error(`expected parse to succeed for: ${line}`);
  return result.parsed as unknown as Parsed;
}

function authorityFields(parsed: Parsed) {
  return {
    container: parsed.container,
    count_noun: parsed.count_noun,
    unit_kind: parsed.unit_kind,
    amount: parsed.amount,
    query: parsed.query,
    measurement_kind: parsed.measurement_kind,
    quantity_kind: parsed.quantity_kind,
    package_net_mass: parsed.package_net_mass,
  };
}

describe('tin / tins container alias', () => {
  it('resolves tin and tins to the existing canonical container noun `can`', () => {
    expect(canonicalHouseholdUnit('tin')).toEqual({ noun: 'can', kind: 'container' });
    expect(canonicalHouseholdUnit('tins')).toEqual({ noun: 'can', kind: 'container' });
    expect(canonicalHouseholdUnit('Tins')).toEqual({ noun: 'can', kind: 'container' });
  });

  it('adds no new canonical container noun', () => {
    expect(householdContainerNouns()).toContain('can');
    expect(householdContainerNouns()).not.toContain('tin');
  });

  it('classifies `1 tin chopped tomatoes` as container can, preserving count and cleaning the query', () => {
    const parsed = parseOk('1 tin chopped tomatoes');
    expect(parsed.container).toBe('can');
    expect(parsed.unit_kind).toBe('container');
    expect(parsed.amount).toBe(1);
    expect(parsed.query).toBe('chopped tomatoes');
    expect(parsed.query).not.toMatch(/tin/i);
  });

  it('classifies `2 tins beans` as container can, preserving count and cleaning the query', () => {
    const parsed = parseOk('2 tins beans');
    expect(parsed.container).toBe('can');
    expect(parsed.unit_kind).toBe('container');
    expect(parsed.amount).toBe(2);
    expect(parsed.query).toBe('beans');
    expect(parsed.query).not.toMatch(/tins/i);
  });

  it('is authority-identical to the equivalent `can` line (no conversion or mass)', () => {
    expect(authorityFields(parseOk('1 tin chopped tomatoes'))).toEqual(
      authorityFields(parseOk('1 can chopped tomatoes')),
    );
    expect(authorityFields(parseOk('2 tins beans'))).toEqual(authorityFields(parseOk('2 cans beans')));
    expect(parseOk('1 tin chopped tomatoes').package_net_mass).toBeUndefined();
  });
});
