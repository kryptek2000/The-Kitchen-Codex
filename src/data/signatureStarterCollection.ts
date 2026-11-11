/**
 * The Kitchen Codex — Signature Nine Starter Collection.
 *
 * APPROVED product data (Option A): a permanent, application-owned, read-only
 * collection. These recipes are never written into a personal Vault unless the
 * user explicitly chooses “Save to My Vault” for one recipe.
 *
 * Data honesty:
 *  - recipes are application-authored cooking instructions, not scraped copies;
 *  - no nutrition values are invented (the fields are intentionally absent);
 *  - the photographs are Unsplash-hosted images under the Unsplash License and
 *    are identified as such in each note's frontmatter.
 *
 * Every recipe is a complete note: metadata, ingredients, ordered instructions,
 * food-safety cue, and notes. The collection is intentionally capped at nine.
 */

import type { MealPlanDay, ShoppingCategoryGroup } from '../types';

export const SIGNATURE_STARTER_COLLECTION_VERSION = 1;
export const SIGNATURE_STARTER_COLLECTION_SOURCE = 'signature-nine';
export const SIGNATURE_STARTER_SAVE_FOLDER = 'Signature Collection';

export interface SignatureStarterDefinition {
  /** Stable built-in identity. Never derived from a user Vault path. */
  readonly id: string;
  readonly fileName: string;
  readonly markdown: string;
}

export const SIGNATURE_STARTER_RECIPES: ReadonlyArray<SignatureStarterDefinition> = Object.freeze([
  {
    id: 'signature-artisan-sourdough-boule',
    fileName: 'Artisan Sourdough Boule.md',
    markdown: `---
title: Artisan Sourdough Boule
tags:
  - food/recipes
  - baking
  - bread
  - sourdough
  - weekend-project
category: Baking & Breads
cuisine: French
prep_time: 45 mins
cook_time: 45 mins
total_time: 18 hrs (including cold retard)
servings: 8
difficulty: Hard
image: "https://images.unsplash.com/photo-1589367920969-ab8e050bbb04?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-artisan-sourdough-boule
starter_version: 1
starter_collection: signature-nine
---

# Artisan Sourdough Boule

> [!tip] Steam Is the Crust
> A preheated heavy Dutch oven traps steam for the first 20 minutes. That steam keeps the crust elastic long enough for the loaf to open fully before it sets.

## Ingredients
- [ ] 450 g unbleached bread flour
- [ ] 50 g whole wheat flour
- [ ] 375 g filtered water, lukewarm (78°F / 26°C), divided
- [ ] 100 g active sourdough starter at peak rise
- [ ] 10 g fine sea salt
- [ ] 25 g rice flour, for dusting the banneton

## Instructions
1. **Autolyse.** Mix the bread flour, whole wheat flour, and 350 g of the water in a large bowl until no dry flour remains. Cover and rest for 45 minutes.
2. **Mix in the levain.** Add the active starter and salt with the remaining 25 g water. Squeeze and fold with wet hands until the dough is uniform. Rest for 30 minutes.
3. **Stretch and fold.** Perform four sets of stretch-and-folds, 30 minutes apart. Keep the dough covered at about 76°F (24°C).
4. **Bulk ferment.** Let the dough rest undisturbed for 1½ to 2 hours, until it has grown by roughly 40–50% and feels light with visible bubbles at the edges.
5. **Pre-shape.** Turn the dough onto a lightly floured counter. Shape into a loose round and rest uncovered for 20 minutes.
6. **Final shape.** Dust a banneton generously with rice flour. Shape the dough into a taut boule, seal the seam, and place it seam-side up in the banneton.
7. **Cold retard.** Cover and refrigerate for 12–16 hours. This develops flavor and makes scoring easier.
8. **Preheat.** Place a Dutch oven with its lid in the oven and preheat to 450°F (230°C) for at least 45 minutes.
9. **Bake covered.** Invert the dough onto parchment, score the top, and lower it into the hot Dutch oven. Cover and bake for 20 minutes.
10. **Bake uncovered.** Remove the lid, reduce the oven to 425°F (220°C), and bake for 20–25 minutes more, until deeply browned and the internal temperature reaches about 208°F (98°C).
11. **Cool completely.** Transfer to a wire rack and cool for at least 2 hours before slicing. Cutting hot bread gives a gummy crumb.

## Notes
- **Hydration:** 75% total water. If your flour is very absorbent, add water 10 g at a time during mixing.
- **Storage:** Keep the cut loaf cut-side down on a board for 1 day, then slice and freeze with parchment between slices.
- **Food safety:** The loaf is done when the interior is fully set and reaches 208°F (98°C); never rely on color alone.
`,
  },
  {
    id: 'signature-thai-green-coconut-curry',
    fileName: 'Thai Green Coconut Curry.md',
    markdown: `---
title: Thai Green Coconut Curry
tags:
  - food/recipes
  - dinner
  - thai
  - curry
  - gluten-free
  - quick-30min
category: Main Course
cuisine: Thai
prep_time: 15 mins
cook_time: 20 mins
total_time: 35 mins
servings: 4
difficulty: Easy
image: "https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-thai-green-coconut-curry
starter_version: 1
starter_collection: signature-nine
---

# Thai Green Coconut Curry

> [!tip] Fry the Paste
> Spoon the thick coconut cream from the top of the can and fry the green curry paste in it until the oil separates. This step is what gives the curry its layered, restaurant-style aroma.

## Ingredients
- [ ] 1 can (14 oz / 400 ml) full-fat coconut milk, not shaken
- [ ] 3 tbsp Thai green curry paste
- [ ] 1 lb (450 g) boneless chicken thighs, sliced into bite-size strips
- [ ] 1 cup low-sodium chicken broth
- [ ] 1 cup Thai or Chinese eggplant, cut into 1-inch chunks
- [ ] 1/2 cup bamboo shoots, rinsed and drained
- [ ] 1/2 red bell pepper, thinly sliced
- [ ] 5 makrut lime leaves, stems removed and leaves torn
- [ ] 1 tbsp fish sauce, plus more to taste
- [ ] 1 tsp palm sugar or light brown sugar
- [ ] 1 cup fresh Thai basil leaves
- [ ] 2 Thai bird's-eye chilies, lightly bruised (optional)
- [ ] Steamed jasmine rice, for serving

## Instructions
1. Open the coconut milk without shaking. Spoon about 1/3 cup of the thick cream from the top into a wok or deep skillet. Set the remaining milk aside.
2. Warm the coconut cream over medium heat for 2–3 minutes, until it shimmers and begins to separate.
3. Add the green curry paste and fry for 2 minutes, stirring constantly, until fragrant and slightly darkened.
4. Add the chicken and stir-fry for 4–5 minutes, until the exterior is opaque. The chicken will finish cooking in the sauce.
5. Pour in the remaining coconut milk and the chicken broth. Bring to a gentle simmer.
6. Add the eggplant, bamboo shoots, bell pepper, and lime leaves. Simmer for 6–8 minutes, until the eggplant is tender and the chicken reaches 165°F (74°C) in the thickest piece.
7. Season with fish sauce and sugar. Taste and adjust: more fish sauce for saltiness, more sugar for roundness, more chili for heat.
8. Turn off the heat and fold in the Thai basil and bruised chilies. Let the residual heat wilt the basil for 30 seconds.
9. Serve immediately with steamed jasmine rice.

## Notes
- **Vegetarian/Vegan**: Swap chicken with extra-firm tofu or king oyster mushrooms and use soy sauce instead of fish sauce.
- **Make ahead:** The curry keeps for 3 days refrigerated; reheat gently and add fresh basil at the end.
- **Food safety:** Chicken must reach 165°F (74°C). Cool leftovers within 2 hours and reheat to 165°F.
`,
  },
  {
    id: 'signature-tonkotsu-shoyu-ramen',
    fileName: 'Tonkotsu Shoyu Ramen.md',
    markdown: `---
title: Tonkotsu Shoyu Ramen
tags:
  - food/recipes
  - japanese
  - soup
  - ramen
  - weekend-project
category: Soup & Noodles
cuisine: Japanese
prep_time: 30 mins
cook_time: 8 hrs
total_time: 12 hrs (including chashu and egg marinade)
servings: 4
difficulty: Hard
image: "https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-tonkotsu-shoyu-ramen
starter_version: 1
starter_collection: signature-nine
---

# Tonkotsu Shoyu Ramen

> [!important] Hard Boil, Don't Gently Simmer
> Tonkotsu broth is opaque because collagen and fat are emulsified by a vigorous boil. Keep the pot at a strong rolling boil for the full cook time and top up only with boiling water.

## Ingredients

### Broth
- [ ] 2 lb (900 g) pork femur or knuckle bones, cut small by the butcher
- [ ] 1 lb (450 g) chicken feet, cleaned
- [ ] 12 cups cold water
- [ ] 1 yellow onion, halved
- [ ] 1 head garlic, halved crosswise
- [ ] 2-inch piece fresh ginger, sliced
- [ ] 2 scallions, cut into 3-inch lengths

### Chashu and Eggs
- [ ] 1 lb (450 g) skinless pork belly, rolled and tied
- [ ] 1/2 cup soy sauce
- [ ] 1/4 cup mirin
- [ ] 1/4 cup sake
- [ ] 2 tbsp sugar
- [ ] 1 cup water
- [ ] 4 large eggs

### Tare and Assembly
- [ ] 1/2 cup soy sauce
- [ ] 2 tbsp mirin
- [ ] 1 tbsp sake
- [ ] 1 tsp sugar
- [ ] 4 portions fresh alkaline ramen noodles
- [ ] 1 cup menma (seasoned bamboo shoots)
- [ ] 4 sheets nori
- [ ] 4 scallions, thinly sliced
- [ ] 1 tbsp toasted white sesame seeds
- [ ] 1 tsp black garlic oil (mayu), optional
- [ ] Ichimi togarashi, to taste

## Instructions
1. **Blanch the bones.** Put the pork bones and chicken feet in a large pot, cover with cold water, and bring to a boil. Boil for 10 minutes, then drain and rinse off all gray scum. Clean the pot.
2. **Start the broth.** Return the bones to the clean pot with 12 cups cold water. Bring to a hard boil, then keep at a strong rolling boil, uncovered, for 6 hours. Top up with boiling water whenever the level drops below the bones.
3. **Add aromatics.** Add the onion, garlic, ginger, and scallion lengths. Boil hard for 2 more hours, then strain through a fine-mesh sieve. Season the broth lightly with salt and keep hot.
4. **Braise the chashu.** While the broth cooks, combine the soy sauce, mirin, sake, sugar, and water in a small pot. Add the rolled pork belly, bring to a bare simmer, cover, and cook for 2 hours, turning once. Cool in the liquid, then slice thinly. Refrigerate until serving.
5. **Marinate the eggs.** Boil the eggs for 7 minutes, transfer to ice water, peel, and marinate in 1/2 cup of the chashu braising liquid for at least 2 hours (or overnight).
6. **Make the tare.** Stir together the soy sauce, mirin, sake, and sugar until the sugar dissolves.
7. **Warm the bowls.** Place 2 tbsp tare in each deep bowl. Add 1/4 tsp black garlic oil, if using.
8. **Cook the noodles.** Boil the fresh ramen noodles in a large pot of unsalted water for 90 seconds, or according to the package, until just tender. Drain well.
9. **Assemble.** Ladle about 1½ cups boiling broth into each bowl and whisk to combine with the tare. Fold in the noodles, then top with chashu, halved marinated eggs, menma, nori, scallions, and sesame seeds. Finish with ichimi togarashi.
10. **Serve immediately.** Ramen waits for no one; the noodles soften quickly once they meet the broth.

## Notes
- **Timing:** The broth, chashu, and eggs can be made a day ahead. Reheat the broth to a rolling boil before assembling.
- **Food safety:** Pork broth and chashu must be handled hot; cool leftovers quickly and refrigerate. Reheat to 165°F (74°C). Use fresh eggs and keep the marinated eggs refrigerated.
- **Shortcut:** A good unsalted pork or chicken stock can replace the 8-hour broth, but the result will be lighter, not tonkotsu.
`,
  },
  {
    id: 'signature-classic-roman-carbonara',
    fileName: 'Classic Roman Carbonara.md',
    markdown: `---
title: Classic Roman Carbonara
tags:
  - food/recipes
  - dinner
  - italian
  - pasta
  - roman
  - quick-30min
category: Pasta
cuisine: Italian
prep_time: 10 mins
cook_time: 15 mins
total_time: 25 mins
servings: 3
difficulty: Medium
image: "https://images.unsplash.com/photo-1612874742237-6526221588e3?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-classic-roman-carbonara
starter_version: 1
starter_collection: signature-nine
---

# Classic Roman Carbonara

> [!warning] No Cream, No Garlic
> True Roman carbonara gets its silkiness from egg yolks, grated Pecorino, and starchy pasta water. Cream, peas, and garlic are not part of the Roman classic.

## Ingredients
- [ ] 350 g spaghetti or rigatoni
- [ ] 150 g guanciale, cut into 1/4-inch lardons (or thick-cut pancetta)
- [ ] 4 large egg yolks
- [ ] 1 large whole egg
- [ ] 75 g Pecorino Romano, finely grated
- [ ] 25 g Parmigiano-Reggiano, finely grated
- [ ] 1 tbsp coarsely ground black pepper, toasted
- [ ] 1 tbsp kosher salt, for the pasta water

## Instructions
1. Whisk the egg yolks, whole egg, Pecorino, Parmigiano, and half the black pepper in a heatproof bowl until a thick paste forms.
2. Bring a large pot of water to a boil and salt it moderately. The guanciale and cheese are already salty.
3. Cook the spaghetti until 2 minutes shy of the package's al dente time. Reserve 1 cup of pasta water before draining.
4. While the pasta cooks, place the guanciale in a cold, wide skillet over medium-low heat. Render slowly for 8–10 minutes, until the fat is translucent and the edges are crisp. Remove the skillet from the heat.
5. Transfer the drained pasta directly into the skillet with the guanciale and fat. Toss for 30 seconds.
6. Let the skillet cool off the heat for 1 minute. This is the critical step that keeps the eggs from scrambling.
7. Pour the egg-cheese paste over the pasta and toss vigorously with tongs, adding hot pasta water a splash at a time, until a glossy sauce coats every strand. Use only as much water as the sauce needs.
8. Taste for pepper and cheese. Plate immediately in warm bowls, topping with the crisp guanciale and more Pecorino and black pepper.

## Notes
- **Rescue:** If the sauce tightens, add another splash of warm pasta water and toss off the heat.
- **Food safety:** The eggs are cooked by the residual heat of the pasta and pan; use fresh eggs and serve immediately. Do not hold the finished dish warm for long.
- **Substitutions:** Pancetta works; bacon is smokier and less traditional. Do not substitute cream for the egg emulsion.
`,
  },
  {
    id: 'signature-pan-seared-lemon-herb-salmon',
    fileName: 'Pan-Seared Lemon Herb Salmon.md',
    markdown: `---
title: Pan-Seared Lemon Herb Salmon
tags:
  - food/recipes
  - dinner
  - seafood
  - healthy
  - low-carb
  - quick-30min
category: Main Course
cuisine: Mediterranean
prep_time: 10 mins
cook_time: 12 mins
total_time: 22 mins
servings: 4
difficulty: Easy
image: "https://images.unsplash.com/photo-1467003909585-2f8a72700288?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-pan-seared-lemon-herb-salmon
starter_version: 1
starter_collection: signature-nine
---

# Pan-Seared Lemon Herb Salmon

> [!tip] Dry Skin, Hot Pan
> Pat the skin completely dry and press the fillets flat for the first 30 seconds. That contact is what produces a shatteringly crisp skin instead of a steamed one.

## Ingredients
- [ ] 4 skin-on salmon fillets, about 6 oz (170 g) each
- [ ] 2 tbsp avocado oil or other high-heat oil
- [ ] 2 tbsp unsalted butter
- [ ] 4 garlic cloves, lightly smashed
- [ ] 1 lemon, zested and halved
- [ ] 3 sprigs fresh thyme
- [ ] 2 sprigs fresh rosemary
- [ ] 2 tbsp fresh dill, chopped
- [ ] 1 tsp flaky sea salt
- [ ] 1/2 tsp freshly cracked black pepper
- [ ] 1 tbsp capers, drained

## Instructions
1. Pat the salmon fillets completely dry with paper towels. Season both sides with salt and pepper.
2. Heat the oil in a stainless-steel or cast-iron skillet over medium-high heat until it shimmers.
3. Lay the fillets skin-side down in the pan and press gently with a fish spatula for 30 seconds so the skin stays flat.
4. Sear undisturbed for 5–6 minutes, until the skin is golden and crisp and the flesh is cooked about three-quarters of the way up the side.
5. Flip carefully and reduce the heat to medium-low.
6. Add the butter, garlic, thyme, rosemary, and capers. When the butter foams, tilt the pan and baste the salmon for 1–2 minutes.
7. Squeeze half the lemon over the fillets. For medium-rare salmon, pull it at 125°F (52°C); for fully cooked salmon, continue to 145°F (63°C).
8. Transfer to plates, spoon over the pan butter, and finish with lemon zest, dill, and a little flaky salt.

## Notes
- **Food safety:** The FDA recommends 145°F (63°C) for fin fish. If you prefer medium-rare salmon, use very fresh fish and make that choice deliberately.
- **Sides:** Roasted asparagus, crushed potatoes, or a warm quinoa salad.
- **Skin:** If the skin sticks, give it another 30 seconds; it will release when browned.
`,
  },
  {
    id: 'signature-avocado-green-goddess-quinoa-salad',
    fileName: 'Avocado Green Goddess Quinoa Salad.md',
    markdown: `---
title: Avocado Green Goddess Quinoa Salad
tags:
  - food/recipes
  - lunch
  - salad
  - vegetarian
  - meal-prep
  - healthy
category: Salads & Bowls
cuisine: California
prep_time: 20 mins
cook_time: 15 mins
total_time: 35 mins
servings: 4
difficulty: Easy
image: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-avocado-green-goddess-quinoa-salad
starter_version: 1
starter_collection: signature-nine
---

# Avocado Green Goddess Quinoa Salad

> [!tip] Cool the Quinoa
> Spread the cooked quinoa on a plate to cool before dressing it. Warm quinoa drinks up the dressing and turns the salad heavy.

## Ingredients

### Salad
- [ ] 1 cup dry tri-color quinoa, rinsed
- [ ] 2 cups vegetable broth or water
- [ ] 2 cups baby arugula or baby kale
- [ ] 1 cup English cucumber, diced
- [ ] 1 cup cherry tomatoes, halved
- [ ] 2 ripe avocados, pitted and cubed
- [ ] 1/2 cup shelled edamame, cooked
- [ ] 1/3 cup pumpkin seeds, toasted
- [ ] 1/2 cup feta cheese, crumbled

### Green Goddess Dressing
- [ ] 1 ripe avocado
- [ ] 1/2 cup whole-milk Greek yogurt
- [ ] 1 cup fresh Italian parsley
- [ ] 1/2 cup fresh cilantro or dill
- [ ] 2 tbsp fresh chives, chopped
- [ ] 1 garlic clove
- [ ] 2 tbsp fresh lemon juice
- [ ] 2 tbsp extra-virgin olive oil
- [ ] 1/2 tsp fine sea salt, plus black pepper to taste
- [ ] 2–3 tbsp cold water, to loosen

## Instructions
1. Combine the quinoa and vegetable broth in a small pot. Bring to a boil, cover, reduce the heat to low, and simmer for 15 minutes, until the liquid is absorbed.
2. Remove from the heat, fluff with a fork, and spread on a plate to cool for 10 minutes.
3. Make the dressing: blend the avocado, yogurt, parsley, cilantro or dill, chives, garlic, lemon juice, olive oil, salt, and pepper until smooth. Add cold water a tablespoon at a time until pourable.
4. In a large bowl, layer the cooled quinoa, arugula, cucumber, tomatoes, and edamame.
5. Drizzle with half the dressing and toss gently.
6. Top with the cubed avocado, feta, and toasted pumpkin seeds. Serve with the remaining dressing on the side.

## Notes
- **Meal prep:** Store undressed for up to 4 days. Add avocado and seeds just before serving.
- **Vegan:** Omit the feta and use a plant-based yogurt.
- **Food safety:** Keep dressed salad refrigerated; discard anything left at room temperature for more than 2 hours.
`,
  },
  {
    id: 'signature-lemon-ricotta-pancakes-blueberry-compote',
    fileName: 'Lemon Ricotta Pancakes with Blueberry Compote.md',
    markdown: `---
title: Lemon Ricotta Pancakes with Blueberry Compote
tags:
  - food/recipes
  - breakfast
  - brunch
  - pancakes
  - lemon
category: Breakfast
cuisine: American
prep_time: 15 mins
cook_time: 20 mins
total_time: 35 mins
servings: 4
difficulty: Medium
image: "https://images.unsplash.com/photo-1528207776546-365bb710ee93?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-lemon-ricotta-pancakes-blueberry-compote
starter_version: 1
starter_collection: signature-nine
---

# Lemon Ricotta Pancakes with Blueberry Compote

> [!tip] Whip the Whites
> Fold in egg whites whipped to soft peaks at the very end. The air pockets make the ricotta pancakes tender and tall without extra baking powder.

## Ingredients

### Pancakes
- [ ] 1 1/2 cups all-purpose flour
- [ ] 2 tbsp granulated sugar
- [ ] 2 tsp baking powder
- [ ] 1/2 tsp baking soda
- [ ] 1/4 tsp fine sea salt
- [ ] 1 cup whole-milk ricotta
- [ ] 1 cup buttermilk
- [ ] 2 large eggs, separated
- [ ] 2 tbsp fresh lemon juice
- [ ] 1 tbsp lemon zest
- [ ] 1 tsp vanilla extract
- [ ] 2 tbsp unsalted butter, melted, plus more for the pan

### Blueberry Compote
- [ ] 2 cups fresh or frozen blueberries
- [ ] 1/4 cup granulated sugar
- [ ] 1 tbsp fresh lemon juice
- [ ] 1 tsp cornstarch
- [ ] 1 tbsp cold water
- [ ] Pinch of fine sea salt

## Instructions
1. **Compote.** Combine the blueberries, sugar, lemon juice, and salt in a small saucepan over medium heat. Simmer for 6–8 minutes, until the berries burst and the juices thicken slightly.
2. Stir the cornstarch into the cold water, add it to the pan, and simmer for 1 minute more. Remove from the heat and keep warm.
3. **Dry ingredients.** Whisk the flour, sugar, baking powder, baking soda, and salt in a large bowl.
4. **Wet ingredients.** In another bowl, whisk the ricotta, buttermilk, egg yolks, lemon juice, zest, vanilla, and melted butter until smooth.
5. Fold the wet mixture into the dry ingredients just until combined; a few small lumps are fine.
6. Beat the egg whites to soft peaks. Fold them into the batter in two additions, stopping as soon as no white streaks remain.
7. Heat a griddle or nonstick skillet over medium heat and brush lightly with butter. Scoop 1/4 cup batter per pancake.
8. Cook for 2–3 minutes, until bubbles form and the edges look set. Flip and cook for 2 minutes more, until cooked through and lightly golden.
9. Serve warm with the blueberry compote and extra lemon zest.

## Notes
- **Food safety:** Cook pancakes through; do not serve raw batter. The centers should be set, not wet.
- **Keep warm:** Hold cooked pancakes on a rack in a 200°F (95°C) oven; stacking steams them.
- **Frozen blueberries:** No need to thaw; add 1 minute to the compote.
`,
  },
  {
    id: 'signature-smoky-chicken-tinga-tacos',
    fileName: 'Smoky Chicken Tinga Tacos.md',
    markdown: `---
title: Smoky Chicken Tinga Tacos
tags:
  - food/recipes
  - dinner
  - mexican
  - tacos
  - chicken
  - weeknight
category: Main Course
cuisine: Mexican
prep_time: 15 mins
cook_time: 30 mins
total_time: 45 mins
servings: 4
difficulty: Easy
image: "https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-smoky-chicken-tinga-tacos
starter_version: 1
starter_collection: signature-nine
---

# Smoky Chicken Tinga Tacos

> [!tip] Reduce, Don't Drown
> After shredding the chicken, simmer the sauce until it clings to the meat. Wet tinga makes tortillas soggy; tight, glossy tinga makes a clean taco.

## Ingredients
- [ ] 1 1/2 lb (680 g) boneless, skinless chicken thighs
- [ ] 1 tbsp neutral oil
- [ ] 1 yellow onion, thinly sliced
- [ ] 3 garlic cloves, minced
- [ ] 1 can (14 oz / 400 g) fire-roasted diced tomatoes, drained
- [ ] 2–3 chipotle peppers in adobo, minced, plus 1 tbsp adobo sauce
- [ ] 1 tsp smoked paprika
- [ ] 1 tsp ground cumin
- [ ] 1/2 tsp dried oregano
- [ ] 1 bay leaf
- [ ] 1/2 cup chicken broth
- [ ] 1 tbsp apple cider vinegar
- [ ] 1 tsp kosher salt, plus more to taste
- [ ] 8 corn tortillas
- [ ] 2 cups shredded green cabbage
- [ ] 1/2 cup fresh cilantro, chopped
- [ ] 1 lime, cut into wedges
- [ ] 1 avocado, sliced
- [ ] 1/2 cup crumbled queso fresco

## Instructions
1. Heat the oil in a large skillet over medium-high heat. Season the chicken with salt and sear for 3 minutes per side, until browned. Transfer to a plate.
2. Lower the heat to medium. Add the onion and cook for 4 minutes, until softened. Add the garlic and cook for 30 seconds.
3. Stir in the tomatoes, chipotles, adobo, smoked paprika, cumin, oregano, bay leaf, and broth. Bring to a simmer.
4. Return the chicken to the skillet, cover, and simmer gently for 18–20 minutes, until the chicken reaches 165°F (74°C) in the thickest piece.
5. Transfer the chicken to a bowl and shred with two forks. Discard the bay leaf.
6. Simmer the sauce for 5–8 minutes, until thickened. Return the shredded chicken and stir in the vinegar. Cook for 2 minutes more, until the sauce coats the meat. Taste for salt.
7. Char the tortillas directly over a gas flame for 20–30 seconds per side, or in a dry skillet. Wrap in a clean towel to stay warm.
8. Fill each tortilla with tinga, cabbage, cilantro, avocado, and queso fresco. Serve with lime wedges.

## Notes
- **Heat:** Two chipotles give a moderate smoky heat; use three for a hotter filling.
- **Food safety:** Chicken must reach 165°F (74°C). Refrigerate leftovers within 2 hours.
- **Make ahead:** The tinga keeps for 3 days; reheat gently with a splash of broth.
`,
  },
  {
    id: 'signature-dark-chocolate-espresso-lava-cakes',
    fileName: 'Dark Chocolate Espresso Lava Cakes.md',
    markdown: `---
title: Dark Chocolate Espresso Lava Cakes
tags:
  - food/recipes
  - dessert
  - baking
  - chocolate
  - espresso
category: Dessert
cuisine: French
prep_time: 20 mins
cook_time: 12 mins
total_time: 32 mins
servings: 4
difficulty: Medium
image: "https://images.unsplash.com/photo-1606313564200-e75d5e30476c?auto=format&fit=crop&w=1200&q=80"
image_license: Unsplash License
image_source: Unsplash
starter_id: signature-dark-chocolate-espresso-lava-cakes
starter_version: 1
starter_collection: signature-nine
---

# Dark Chocolate Espresso Lava Cakes

> [!tip] The Jiggle Test
> Pull the cakes when the edges are set and the centers still wobble like soft custard. They continue to set as they rest, leaving a molten middle.

## Ingredients
- [ ] 120 g dark chocolate (70%), finely chopped
- [ ] 100 g unsalted butter, plus more for the ramekins
- [ ] 2 large eggs
- [ ] 2 large egg yolks
- [ ] 50 g granulated sugar
- [ ] 30 g all-purpose flour, sifted
- [ ] 1 tsp instant espresso powder
- [ ] 1 tbsp hot water
- [ ] 1 tsp vanilla extract
- [ ] 1 pinch fine sea salt
- [ ] Unsweetened cocoa powder, for dusting the ramekins
- [ ] Vanilla ice cream or whipped cream, for serving (optional)

## Instructions
1. Dissolve the espresso powder in the hot water and set aside to cool.
2. Heat the oven to 425°F (220°C). Butter four 6-oz ramekins generously, including the rims, and dust with cocoa powder, tapping out the excess.
3. Melt the chocolate and butter together in a heatproof bowl set over barely simmering water, stirring until glossy. Remove from the heat and cool for 5 minutes.
4. Whisk the eggs, egg yolks, sugar, vanilla, and salt in a medium bowl for 3 minutes, until pale and slightly thickened.
5. Whisk the cooled chocolate mixture and espresso into the eggs until smooth.
6. Fold in the sifted flour just until no dry streaks remain. Do not overmix.
7. Divide the batter among the ramekins, filling them about three-quarters full. Place them on a baking sheet.
8. Bake for 11–13 minutes, until the edges are set and the centers still jiggle softly. Begin checking at 11 minutes.
9. Rest for 1–2 minutes. Run a thin knife around each edge, invert onto a plate, and serve immediately with ice cream or whipped cream.

## Notes
- **Food safety:** The cakes contain eggs; use fresh eggs and serve soon after baking. The centers are intentionally molten, not raw batter; if you prefer a fully set cake, bake 2 minutes longer.
- **Make ahead:** The batter can be refrigerated in the ramekins for up to 4 hours. Add 2 minutes to the bake time.
- **Chocolate:** Use a bar you enjoy eating; 70% gives a bittersweet lava that balances the ice cream.
`,
  },
]);

/**
 * Demo meal plan shown before a Vault is connected. Every title is a member of
 * the Signature Nine above; the plan is never written into a personal Vault.
 */
export const SIGNATURE_STARTER_MEAL_PLAN: MealPlanDay[] = [
  { dayName: 'Monday', dinner: { recipeTitle: 'Thai Green Coconut Curry' } },
  { dayName: 'Tuesday', dinner: { recipeTitle: 'Smoky Chicken Tinga Tacos' } },
  { dayName: 'Wednesday', dinner: { recipeTitle: 'Tonkotsu Shoyu Ramen' } },
  { dayName: 'Thursday', dinner: { recipeTitle: 'Pan-Seared Lemon Herb Salmon' } },
  { dayName: 'Friday', dinner: { recipeTitle: 'Classic Roman Carbonara' } },
  { dayName: 'Saturday', dinner: { recipeTitle: 'Avocado Green Goddess Quinoa Salad' } },
  { dayName: 'Sunday', dinner: { recipeTitle: 'Artisan Sourdough Boule' } },
];

/**
 * Demo shopping list shown before a Vault is connected. It is intentionally a
 * small, coherent subset of the demo plan; `recipeSources` always name a real
 * Signature Nine recipe.
 */
export const SIGNATURE_STARTER_SHOPPING_CATEGORIES: ShoppingCategoryGroup[] = [
  {
    category: 'Monday Dinner: Thai Green Coconut Curry',
    items: [
      { id: 'sig-1', text: '1 can (14 oz) full-fat coconut milk', recipeSources: ['Thai Green Coconut Curry'], isChecked: true },
      { id: 'sig-2', text: '3 tbsp Thai green curry paste', recipeSources: ['Thai Green Coconut Curry'], isChecked: true },
      { id: 'sig-3', text: '1 lb boneless chicken thighs', recipeSources: ['Thai Green Coconut Curry'], isChecked: false },
      { id: 'sig-4', text: '1 cup Thai or Chinese eggplant', recipeSources: ['Thai Green Coconut Curry'], isChecked: false },
      { id: 'sig-5', text: '1 bunch Thai basil', recipeSources: ['Thai Green Coconut Curry'], isChecked: false },
      { id: 'sig-6', text: 'Jasmine rice', recipeSources: ['Thai Green Coconut Curry'], isChecked: false },
    ],
  },
  {
    category: 'Wednesday Dinner: Tonkotsu Shoyu Ramen',
    items: [
      { id: 'sig-7', text: '2 lb pork femur or knuckle bones', recipeSources: ['Tonkotsu Shoyu Ramen'], isChecked: false },
      { id: 'sig-8', text: '1 lb chicken feet', recipeSources: ['Tonkotsu Shoyu Ramen'], isChecked: false },
      { id: 'sig-9', text: '1 lb skinless pork belly', recipeSources: ['Tonkotsu Shoyu Ramen'], isChecked: false },
      { id: 'sig-10', text: '4 portions fresh alkaline ramen noodles', recipeSources: ['Tonkotsu Shoyu Ramen'], isChecked: false },
      { id: 'sig-11', text: 'Menma, nori, and scallions', recipeSources: ['Tonkotsu Shoyu Ramen'], isChecked: false },
    ],
  },
  {
    category: 'Friday Dinner: Classic Roman Carbonara',
    items: [
      { id: 'sig-12', text: '350 g spaghetti or rigatoni', recipeSources: ['Classic Roman Carbonara'], isChecked: false },
      { id: 'sig-13', text: '150 g guanciale', recipeSources: ['Classic Roman Carbonara'], isChecked: false },
      { id: 'sig-14', text: '4 large egg yolks + 1 whole egg', recipeSources: ['Classic Roman Carbonara'], isChecked: false },
      { id: 'sig-15', text: '75 g Pecorino Romano', recipeSources: ['Classic Roman Carbonara'], isChecked: true },
      { id: 'sig-16', text: '25 g Parmigiano-Reggiano', recipeSources: ['Classic Roman Carbonara'], isChecked: true },
    ],
  },
];
