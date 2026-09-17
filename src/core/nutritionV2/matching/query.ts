/**
 * The Kitchen Codex — Advanced Nutrition Phase 4.5D: ingredient-query projection.
 *
 * PURE, closed, versioned, offline. This module is the ONE authority for turning
 * a normalized food-name query into explicit ROLES:
 *
 *   - food identity      : the tokens that identify the food (what must match);
 *   - measurement        : the raw measurement token (owned by the canonical
 *                          parser; recorded here for evidence only);
 *   - size qualifiers    : bounded portion/size words (small, medium, large, ...)
 *                          preserved for Phase 4.5E count compatibility;
 *   - preparation        : a closed set of ordinary physical preparation words
 *                          (sliced, shredded, chopped, ...) that must NOT become
 *                          mandatory food identity;
 *   - notes              : a bounded trailing recipe instruction
 *                          (e.g. `formed into 4 patties`) — non-authoritative;
 *   - numeric qualifiers : bounded numeric qualifiers such as `80 20`;
 *   - aliases            : bounded, directional culinary aliases that fired;
 *   - anchors            : deterministic required matching anchors derived from
 *                          the food identity. Each anchor is a GROUP of accepted
 *                          tokens (usually one); a candidate must contain a token
 *                          from every group.
 *
 * It NEVER mutates the source ingredient, never rewrites stored recipes, and
 * never authorizes an automatic match. The anchor rule is deterministic and
 * bounded, and is included in the review digest through the candidate set.
 */

export const QUERY_PROJECTION_VERSION = 'usda_query_projection_v1';

/** A required anchor: the candidate must contain a token from `accepted`. */
export interface AnchorGroup {
  readonly accepted: ReadonlyArray<string>;
}

export interface IngredientQueryProjection {
  readonly version: string;
  /** Normalized food-identity text (roles removed). */
  readonly food_identity: string;
  /** Bounded identity tokens (order preserved). */
  readonly food_tokens: ReadonlyArray<string>;
  readonly anchor_groups: ReadonlyArray<AnchorGroup>;
  readonly measurement_tokens: ReadonlyArray<string>;
  readonly size_qualifiers: ReadonlyArray<string>;
  readonly preparation_qualifiers: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly numeric_qualifiers: ReadonlyArray<string>;
  readonly aliases: ReadonlyArray<string>;
}

/**
 * A closed set of ordinary physical preparation terms. These are removed from
 * mandatory food identity. Nutritionally significant qualifiers (raw/cooked,
 * salted/unsalted, whole/skim, ...) are deliberately NOT in this set.
 */
const PREPARATION_QUALIFIERS: ReadonlySet<string> = new Set([
  'sliced',
  'shredded',
  'chopped',
  'diced',
  'minced',
  'grated',
  'peeled',
  'drained',
  'rinsed',
  'halved',
  'quartered',
  'crushed',
  'mashed',
  'beaten',
  'softened',
  'melted',
  'trimmed',
  'stemmed',
  'seeded',
  'cored',
  'julienned',
  'cubed',
  'crumbled',
  'torn',
  'thawed',
  'defrosted',
  'patted',
  'rinsed',
]);

/** Bounded size/portion qualifiers. Preserved (not deleted) for Phase 4.5E. */
const SIZE_QUALIFIERS: ReadonlySet<string> = new Set([
  'small',
  'medium',
  'large',
  'jumbo',
  'mini',
  'petite',
  'xlarge',
  'xl',
  'xxl',
  'bite',
  'snack',
]);

/**
 * Generic descriptor tokens that are never used as the REQUIRED anchor. They
 * remain in food identity (so they still influence identity coverage) but the
 * head-noun anchor is chosen from the remaining tokens.
 */
const ANCHOR_STOPWORDS: ReadonlySet<string> = new Set([
  // colors / appearance
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'brown',
  'pink',
  'golden',
  'dark',
  'bright',
  'light',
  // preparation (mirrors the set above)
  ...PREPARATION_QUALIFIERS,
  // size (mirrors the set above)
  ...SIZE_QUALIFIERS,
  // preservation / state (nutritionally significant; kept in identity)
  'canned',
  'frozen',
  'dried',
  'fresh',
  'raw',
  'cooked',
  'prepared',
  'unprepared',
  'refrigerated',
  'bottled',
  'packaged',
  'ready',
  'to',
  'eat',
  'boiled',
  'steamed',
  'roasted',
  'baked',
  'fried',
  'grilled',
  'broiled',
  'sauteed',
  'braised',
  'microwaved',
  'pan',
  'broiled',
  // nutrition / composition qualifiers
  'salted',
  'unsalted',
  'sweetened',
  'unsweetened',
  'enriched',
  'unenriched',
  'whole',
  'skim',
  'low',
  'reduced',
  'nonfat',
  'fat',
  'free',
  'lean',
  'extra',
  'virgin',
  'plain',
  'regular',
  'natural',
  'organic',
  'fortified',
  'calcium',
  'ground',
  // salt types
  'kosher',
  'sea',
  'table',
  'iodized',
  // generic
  'commercial',
  'homemade',
  'prepared',
  'unspecified',
  'ns',
  'nfs',
]);

/**
 * Closed negation / contradiction markers (never positive relevance). `with` is
 * included so a candidate that is merely a food prepared `with <ingredient>`
 * (`Tuna salad, made with mayonnaise`, `Pumpkin, canned, with salt`) is not
 * treated as that ingredient — unless the query itself requests `with`.
 */
const NEGATION_TOKENS: ReadonlySet<string> = new Set([
  'without',
  'no',
  'not',
  'sans',
  'minus',
  'free',
  'less',
  'low',
  'with',
]);

/** Closed identity-changing variant qualifiers (unmatched -> lower relevance). */
const CONFLICT_QUALIFIER_TOKENS: ReadonlySet<string> = new Set([
  // Identity-changing variants (a materially different food).
  'meatless',
  'vegan',
  'vegetarian',
  'imitation',
  'turkey',
  'beef',
  'canadian',
  'bits',
  'tofu',
  'substitute',
  // Health-claim / diet qualifiers that mark a reduced or altered variant.
  'reduced',
  'light',
  'diet',
  'low',
  'free',
]);

/**
 * Closed dish-FORM qualifiers. A candidate that is a different dish form
 * (`Bacon biscuit sandwich`, `Soup, tomato`, `Orange juice`) must not outrank
 * the plain ingredient. Tokens that are part of a required anchor (e.g. `roll`
 * for burger buns) are treated as requested and never counted.
 */
const FORM_QUALIFIER_TOKENS: ReadonlySet<string> = new Set([
  'sandwich',
  'dressing',
  'salad',
  'soup',
  'stew',
  'casserole',
  'pie',
  'cake',
  'biscuit',
  'burrito',
  'wrap',
  'taco',
  'burger',
  'cheeseburger',
  'hamburger',
  'pizza',
  'sauce',
  'gravy',
  'dip',
  'spread',
  'snack',
  'cereal',
  'cookie',
  'cracker',
  'chips',
  'juice',
  'drink',
  'beverage',
  'powder',
  'mix',
  'bowl',
  'plate',
  'meal',
  'entree',
  'patty',
  'nugget',
  'tender',
  'loaf',
  'stick',
  'bar',
]);

/** Bounded trailing recipe-instruction lead-ins (non-authoritative notes). */
const NOTE_LEAD_INS: ReadonlyArray<string> = [
  'formed into',
  'shaped into',
  'patted into',
  'divided into',
  'cut into',
  'sliced into',
  'chopped into',
  'rolled into',
  'made into',
  'to taste',
  'as needed',
  'as desired',
  'for garnish',
  'for serving',
  'for frying',
  'for dusting',
  'for coating',
  'for dredging',
  'plus more',
  'or more',
  'optional',
  'divided',
  'reserved',
];

interface CulinaryAlias {
  readonly id: string;
  readonly from: ReadonlyArray<string>;
  readonly to: ReadonlyArray<string>;
  /** Optional explicit anchor override (e.g. bun/roll). */
  readonly anchors: ReadonlyArray<ReadonlyArray<string>> | undefined;
}

/**
 * Bounded, source-controlled, directional culinary aliases required by
 * demonstrated home-recipe language. Aliases never rewrite stored recipes and
 * never authorize an automatic exact match.
 */
const ALIASES: ReadonlyArray<CulinaryAlias> = Object.freeze([
  Object.freeze({
    id: 'burger_bun_to_hamburger_bun',
    from: Object.freeze(['burger', 'bun']),
    to: Object.freeze(['hamburger', 'bun']),
    anchors: Object.freeze([Object.freeze(['bun', 'roll'])]),
  }),
  Object.freeze({
    id: 'burger_bun_to_hamburger_bun',
    from: Object.freeze(['burger', 'buns']),
    to: Object.freeze(['hamburger', 'bun']),
    anchors: Object.freeze([Object.freeze(['bun', 'roll'])]),
  }),
]);

const NUMERIC_TOKEN = /^\d+(?:\.\d+)?$/;

function containsPhrase(tokens: ReadonlyArray<string>, phrase: ReadonlyArray<string>): number {
  if (phrase.length === 0 || tokens.length < phrase.length) return -1;
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (tokens[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Bounded morphological equivalence for matching only. Two tokens match when
 * they are identical or differ by one of a small, closed set of regular plural
 * endings. Short tokens (< 3 chars) only match exactly, so a stray letter can
 * never match a food token.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return false;
  if (`${short}s` === long) return true;
  if (`${short}es` === long) return true;
  if (short.endsWith('y') && `${short.slice(0, -1)}ies` === long) return true;
  return false;
}

function stripTrailingNote(text: string): { text: string; notes: string[] } {
  const lower = text.toLowerCase();
  let best = -1;
  for (const lead of NOTE_LEAD_INS) {
    const pattern = new RegExp(`(?:^|\\s)${lead.replace(/ /g, '\\s+')}\\b`);
    const match = pattern.exec(lower);
    if (match) {
      const start = match.index + (match[0].startsWith(' ') ? 1 : 0);
      if (best === -1 || start < best) best = start;
    }
  }
  if (best <= 0) return { text, notes: [] };
  return { text: text.slice(0, best).trim(), notes: [text.slice(best).trim()] };
}

function extractNumericQualifiers(tokens: string[]): { tokens: string[]; numeric: string[] } {
  const numeric: string[] = [];
  const kept: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (NUMERIC_TOKEN.test(tokens[i])) {
      let j = i;
      const run: string[] = [];
      while (j < tokens.length && NUMERIC_TOKEN.test(tokens[j])) {
        run.push(tokens[j]);
        j += 1;
      }
      // A run of exactly two numeric tokens is a bounded ratio qualifier
      // (e.g. `80 20` from `80/20`). A single numeric token is not identity.
      if (run.length === 2) numeric.push(run[0], run[1]);
      // Numeric tokens never become food identity.
      i = j;
      continue;
    }
    kept.push(tokens[i]);
    i += 1;
  }
  return { tokens: kept, numeric };
}

/**
 * Projects one normalized food-name query into closed roles. Deterministic and
 * independent of locale/time/state.
 */
export function projectQueryText(text: string): IngredientQueryProjection {
  const normalized = String(text).trim();
  const measurementTokens: string[] = [];

  const { text: withoutNote, notes } = stripTrailingNote(normalized);
  const rawTokens = withoutNote.length === 0 ? [] : withoutNote.split(/\s+/).filter(Boolean);
  const { tokens: withoutNumeric, numeric } = extractNumericQualifiers(rawTokens);

  const sizeQualifiers: string[] = [];
  const preparationQualifiers: string[] = [];
  const identityTokens: string[] = [];
  for (const token of withoutNumeric) {
    if (SIZE_QUALIFIERS.has(token)) {
      sizeQualifiers.push(token);
    } else if (PREPARATION_QUALIFIERS.has(token)) {
      preparationQualifiers.push(token);
    } else {
      identityTokens.push(token);
    }
  }

  // Contextual rule for `ground`: identity-bearing only when a meat species is
  // present; otherwise it is an ordinary preparation word (e.g. ground pepper).
  const MEAT_SPECIES: ReadonlySet<string> = new Set([
    'beef',
    'pork',
    'chicken',
    'turkey',
    'lamb',
    'veal',
    'bison',
    'venison',
    'duck',
  ]);
  const hasMeatSpecies = identityTokens.some((token) => MEAT_SPECIES.has(token));
  if (!hasMeatSpecies && identityTokens.includes('ground')) {
    const filtered: string[] = [];
    for (const token of identityTokens) {
      if (token === 'ground') preparationQualifiers.push(token);
      else filtered.push(token);
    }
    identityTokens.length = 0;
    identityTokens.push(...filtered);
  }

  // Bounded directional aliases (applied to the identity token sequence only).
  const aliases: string[] = [];
  let anchorOverride: ReadonlyArray<ReadonlyArray<string>> | undefined;
  for (const alias of ALIASES) {
    const index = containsPhrase(identityTokens, alias.from);
    if (index === -1) continue;
    identityTokens.splice(index, alias.from.length, ...alias.to);
    aliases.push(alias.id);
    if (alias.anchors) anchorOverride = alias.anchors;
    break;
  }

  // Deterministic anchor: head noun = last identity token not in the stopword
  // set; fall back to the last identity token, then to the query itself.
  let anchorTokens = identityTokens.filter((token) => !ANCHOR_STOPWORDS.has(token));
  if (anchorTokens.length === 0) anchorTokens = [...identityTokens];
  let anchorGroups: AnchorGroup[];
  if (anchorOverride) {
    anchorGroups = anchorOverride.map((accepted) => Object.freeze({ accepted: Object.freeze([...accepted]) }));
  } else if (anchorTokens.length > 0) {
    anchorGroups = [Object.freeze({ accepted: Object.freeze([anchorTokens[anchorTokens.length - 1]]) })];
  } else {
    anchorGroups = [];
  }

  return Object.freeze({
    version: QUERY_PROJECTION_VERSION,
    food_identity: identityTokens.join(' '),
    food_tokens: Object.freeze([...identityTokens]),
    anchor_groups: Object.freeze(anchorGroups),
    measurement_tokens: Object.freeze(measurementTokens),
    size_qualifiers: Object.freeze([...sizeQualifiers]),
    preparation_qualifiers: Object.freeze([...preparationQualifiers]),
    notes: Object.freeze([...notes]),
    numeric_qualifiers: Object.freeze([...numeric]),
    aliases: Object.freeze([...aliases]),
  });
}

/** True when the query itself explicitly requests a negation/variant qualifier. */
export function queryRequestsNegation(projection: IngredientQueryProjection): boolean {
  return projection.food_tokens.some((token) => NEGATION_TOKENS.has(token));
}

/**
 * Closed forward-negation markers. Unlike `NEGATION_TOKENS` (which also carries
 * `with`/`free`/`less`/`low` for the back/next windows), these are the only
 * tokens that negate a FOLLOWING food token: `salt not added`, `salt no salt`,
 * `salt never added`.
 */
const FORWARD_NEGATION_TOKENS: ReadonlySet<string> = new Set(['not', 'no', 'never']);

/**
 * True when a candidate contradicts the query for `anchorToken` (e.g. a query
 * for `salt` against `without salt`, `no salt`, `salt free`, `low salt`, or
 * `salt not added in processing`). The query's own explicit negation is honored
 * by the caller.
 */
export function candidateContradicts(
  candidateTokens: ReadonlyArray<string>,
  identityTokens: ReadonlyArray<string>
): boolean {
  for (const token of identityTokens) {
    for (let i = 0; i < candidateTokens.length; i += 1) {
      if (!tokensMatch(candidateTokens[i], token)) continue;
      // `<negation> [word] <token>` within a 2-token window.
      for (let back = 1; back <= 2; back += 1) {
        const prev = candidateTokens[i - back];
        if (prev && NEGATION_TOKENS.has(prev)) return true;
      }
      // `<token> free` / `<token> less` / `<token> added`.
      const next = candidateTokens[i + 1];
      if (next === 'free' || next === 'less' || next === 'added') return true;
      // `<token> [word] not|no|never ...` within a 2-token forward window.
      for (let fwd = 1; fwd <= 2; fwd += 1) {
        const following = candidateTokens[i + fwd];
        if (following && FORWARD_NEGATION_TOKENS.has(following)) return true;
      }
    }
  }
  return false;
}

/** Counts unmatched identity-changing variant / dish-form qualifiers. */
export function qualifierConflictCount(
  candidateTokens: ReadonlyArray<string>,
  projection: IngredientQueryProjection
): number {
  const requested = new Set(projection.food_tokens);
  for (const group of projection.anchor_groups) {
    for (const accepted of group.accepted) requested.add(accepted);
  }
  let conflicts = 0;
  for (const token of candidateTokens) {
    if (requested.has(token)) continue;
    if (CONFLICT_QUALIFIER_TOKENS.has(token) || FORM_QUALIFIER_TOKENS.has(token)) {
      conflicts += 1;
    }
  }
  return conflicts;
}
