import { ObsidianRecipe, VaultNote, MealPlanDay, ShoppingCategoryGroup } from '../types';
import { parseObsidianRecipeMarkdown, parseVaultNoteMarkdown } from '../utils/markdownParser';
import { resolveNewRecipeVaultPath } from '../core/vaultPath';
import {
  SIGNATURE_STARTER_COLLECTION_VERSION,
  SIGNATURE_STARTER_MEAL_PLAN,
  SIGNATURE_STARTER_RECIPES,
  SIGNATURE_STARTER_SHOPPING_CATEGORIES,
} from './signatureStarterCollection';

export const DEFAULT_VAULT_PATH = 'My Recipe Vault / Kitchen Codex';

/**
 * The permanent, application-owned Signature Nine collection.
 *
 * These recipes are parsed from application-owned Markdown. They are NOT files
 * in the user's Vault and are NEVER counted as personal Vault recipes. A saved
 * personal copy is a separate recipe with its own Vault path and a durable
 * `starter_id` provenance field.
 */
export const STARTER_RECIPE_MARKDOWNS = SIGNATURE_STARTER_RECIPES.map((recipe) => ({
  starterId: recipe.id,
  fileName: recipe.fileName,
  markdown: recipe.markdown,
}));

/** Initial demo meal plan shown before a Vault is connected. */
export const STARTER_MEAL_PLAN: MealPlanDay[] = SIGNATURE_STARTER_MEAL_PLAN;

/** Initial demo shopping list shown before a Vault is connected. */
export const STARTER_SHOPPING_CATEGORIES: ShoppingCategoryGroup[] = SIGNATURE_STARTER_SHOPPING_CATEGORIES;

/**
 * Parses the built-in collection into fresh UI objects and marks their ownership.
 *
 * The stable `id` is collection-scoped (`starter:<starter-id>`), never the
 * personal-Vault path. `filePath` stays a virtual root filename so the built-in
 * can be exported/read without ever being treated as a Vault file.
 */
export function getStarterVaultRecipes(): ObsidianRecipe[] {
  return STARTER_RECIPE_MARKDOWNS.map((item) => {
    const filePath = resolveNewRecipeVaultPath(item.fileName);
    const recipe = parseObsidianRecipeMarkdown(item.markdown, item.fileName, filePath);
    recipe.id = `starter:${item.starterId}`;
    recipe.isBuiltIn = true;
    recipe.builtInId = item.starterId;
    recipe.starterId = item.starterId;
    recipe.starterVersion = SIGNATURE_STARTER_COLLECTION_VERSION;
    return recipe;
  });
}

/** True only for an application-owned, read-only Signature Nine recipe. */
export function isBuiltInRecipe(recipe: ObsidianRecipe | null | undefined): boolean {
  return recipe?.isBuiltIn === true;
}

/** The exact built-in collection size. */
export function getSignatureStarterCount(): number {
  return SIGNATURE_STARTER_RECIPES.length;
}

/** All personal (non-built-in) recipes from a mixed collection. */
export function personalRecipesOnly(recipes: ReadonlyArray<ObsidianRecipe>): ObsidianRecipe[] {
  return recipes.filter((recipe) => !recipe.isBuiltIn);
}

export const STARTER_VAULT_NOTES: { fileName: string; markdown: string }[] = [
  {
    fileName: 'Garlic.md',
    markdown: `---
title: Garlic
tags:
  - ingredients/aromatics
  - pantry/staple
  - alliums
category: Ingredient Guide
origin: Central Asia
flavor_profile: Pungent, savory, sweet and caramelized when roasted
storage: Cool, dry, dark, well-ventilated pantry basket (avoid plastic bags)
---

# Garlic

> [!tip] Cutting Technique & Pungency
> The finer garlic is chopped or grated, the more allicin forms and the sharper it tastes. Whole crushed cloves give a gentler, perfume-like aroma.

## Overview
Garlic (Allium sativum) is a foundation of savory cooking across Mediterranean, Asian, Middle Eastern, Latin American, and French cuisines.

## Culinary Uses & Pairings
- **Soffritto & mirepoix:** Sauté gently in olive oil or butter at low temperature to avoid bitter browning.
- **Roasted garlic:** Wrap whole heads in foil with olive oil and roast at 400°F (200°C) for 45 minutes until spreadably soft.
- **Pairings:** Rosemary, thyme, basil, tomatoes, butter, white wine, lemon, soy sauce, ginger, and chili.
`,
  },
  {
    fileName: 'Parmigiano-Reggiano.md',
    markdown: `---
title: Parmigiano-Reggiano
tags:
  - ingredients/dairy
  - italian/dop
  - pantry/cheese
category: Ingredient Guide
origin: Parma, Reggio Emilia, Modena (Italy) — DOP protected
aging: 24 to 36 months
flavor_profile: Rich, nutty, crystalline umami with hints of pineapple and dried fruit
storage: Wrapped in wax paper or parchment in the cheese drawer (36–40°F)
---

# Parmigiano-Reggiano

> [!tip] Save the Rinds
> Never throw away the hard rind of genuine Parmigiano-Reggiano. Freeze it and drop it into simmering tomato sauce, minestrone, or broth for deep umami.

## Overview
Genuine Parmigiano-Reggiano DOP is an aged cow's-milk hard cheese. The crunchy crystals are tyrosine crystals, a sign of slow artisanal aging.

## Culinary Uses & Pairings
- **Pasta emulsions:** Microplane finely over pasta with starchy cooking water to build a glossy sauce without cream.
- **Finishing:** Shave over arugula, carpaccio, or risotto.
- **Pairings:** Balsamic vinegar, prosciutto, walnuts, ripe pears, and dry sparkling wine.
`,
  },
  {
    fileName: 'Guanciale.md',
    markdown: `---
title: Guanciale
tags:
  - ingredients/cured-meat
  - italian/charcuterie
  - pantry/salumi
category: Ingredient Guide
origin: Lazio & Umbria, Central Italy
cut: Cured pork jowl (cheek)
flavor_profile: Deeply savory, peppery, with clean silky rendered fat
storage: Whole piece wrapped in butcher paper in the refrigerator for up to 3 months
---

# Guanciale

> [!tip] Low & Slow Rendering
> Start diced guanciale in a cold dry skillet over medium-low heat. The fat renders slowly while the exterior crisps without burning the pepper crust.

## Overview
Guanciale is cured pork cheek rubbed with salt, black pepper, and aromatics, then aged for 3 to 6 months. It supplies the fat and umami backbone for Roman classics such as carbonara, amatriciana, and gricia.

## Roman Pasta Pairings
1. **Gricia:** guanciale + Pecorino Romano + black pepper
2. **Carbonara:** guanciale + egg yolks + Pecorino Romano + black pepper
3. **Amatriciana:** guanciale + tomatoes + Pecorino Romano
4. **Cacio e pepe:** Pecorino Romano + toasted black pepper (no guanciale)
`,
  },
  {
    fileName: 'Sourdough Starter.md',
    markdown: `---
title: Sourdough Starter
tags:
  - baking/fermentation
  - pantry/living-culture
  - wild-yeast
category: Baking Reference
hydration: 100% (equal parts flour and water by weight)
organisms: Wild yeasts and lactic acid bacteria
storage: Room temperature with daily feeding, or refrigerator with weekly feeding
---

# Sourdough Starter (Levain)

> [!tip] The Float Test
> Drop a teaspoon of active starter into a glass of room-temperature water. If it floats, gas production is strong and the starter is ready to leaven dough.

## Feeding Ratio (1:1:1)
- 50 g mature starter
- 50 g unbleached bread flour or a 50/50 bread-and-rye blend
- 50 g filtered water at about 78°F (26°C)

## Activity Timeline
- **Hours 1–2:** lag phase
- **Hours 3–5:** rapid expansion and bubbling
- **Hours 5–7:** peak dome, ideal for mixing dough
- **Hours 8+:** collapse and hungry hooch formation
`,
  },
  {
    fileName: 'Extra Virgin Olive Oil.md',
    markdown: `---
title: Extra Virgin Olive Oil
tags:
  - ingredients/oils
  - pantry/essential
  - mediterranean
category: Ingredient Guide
origin: Mediterranean Basin (Italy, Greece, Spain)
acidity: Under 0.8% free acidity, cold extracted
flavor_profile: Fruity, grassy, with a peppery finish
storage: Dark glass away from heat and sunlight; do not store beside the stove
---

# Extra Virgin Olive Oil

> [!tip] Finishing vs. Cooking
> Use a high-quality single-estate olive oil raw over hot soups, grilled bread, or fresh mozzarella to preserve its delicate polyphenols and aroma.

## Overview
Extra-virgin olive oil is cold-pressed olive fruit without chemical refining. It is rich in monounsaturated fat and antioxidants.

## Kitchen Uses
- **Finishing:** drizzle over beans, vegetables, and grilled fish.
- **Gentle cooking:** sweat onions and garlic over low heat.
- **Pairings:** lemon, tomatoes, basil, Parmigiano-Reggiano, and crusty bread.
`,
  },
  {
    fileName: 'Thai Green Curry Paste.md',
    markdown: `---
title: Thai Green Curry Paste
tags:
  - ingredients/condiments
  - thai/curry
  - pantry/refrigerated
category: Ingredient Guide
origin: Central Thailand
flavor_profile: Fresh green chili heat, lemongrass, galangal, makrut lime, and shrimp paste
storage: Refrigerated after opening; use within 2 to 3 weeks or freeze in tablespoon portions
---

# Thai Green Curry Paste

> [!tip] Fry It First
> Bloom the paste in thick coconut cream until the oil separates. This tames the raw sharpness and builds a deeper, rounder curry.

## Overview
Green curry paste is a pounded blend of green chilies, lemongrass, galangal, garlic, shallot, makrut lime zest, coriander root, cumin, and shrimp paste. Brands vary widely in heat and salt, so taste as you go.

## Uses
- **Curry:** fry in coconut cream, then add protein and vegetables.
- **Marinade:** thin with coconut milk and lime juice for grilled chicken or fish.
- **Check labels:** many pastes contain shrimp; choose a vegan paste if needed.
`,
  },
  {
    fileName: 'Dark Chocolate.md',
    markdown: `---
title: Dark Chocolate
tags:
  - ingredients/chocolate
  - baking/pastry
  - pantry
category: Ingredient Guide
cacao: 60–75% for baking and lava cakes
flavor_profile: Bittersweet, fruity, roasted, with variable bitterness
storage: Cool, dry, odor-free cupboard at 60–70°F (15–21°C); wrap tightly
---

# Dark Chocolate

> [!tip] Match the Cacao
> For lava cakes, 70% chocolate gives a deep bittersweet center that balances vanilla ice cream. Higher percentages can turn dry and bitter.

## Overview
Dark chocolate is cocoa solids and cocoa butter with sugar; the percentage on the label counts total cocoa ingredients, not bitterness alone.

## Baking Notes
- **Melting:** Use a heatproof bowl over barely simmering water; keep water out of the chocolate.
- **Seizing:** A drop of water can make melted chocolate seize. Stir in warm cream to rescue it.
- **Pairings:** Espresso, orange, raspberry, sea salt, and vanilla.
`,
  },
];

export function getStarterVaultNotes(): VaultNote[] {
  return STARTER_VAULT_NOTES.map((item) => {
    const filePath = `Notes/${item.fileName}`;
    return parseVaultNoteMarkdown(item.markdown, item.fileName, filePath);
  });
}
