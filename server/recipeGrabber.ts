import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { safeFetchHtml } from "./ssrfGuard.js";
import { renderIngredientLine, parseIngredientLine } from "../src/utils/markdownParser.js";
import { MODEL_CONFIG } from "./modelConfig.js";

dotenv.config();

let aiClient: GoogleGenAI | null = null;

function getGemini(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
          timeout: MODEL_CONFIG.requestTimeoutMs,
        },
      });
    }
  }
  return aiClient;
}

export interface GrabbedRecipeResult {
  title: string;
  description: string;
  cuisine: string;
  category: string;
  difficulty: "Easy" | "Medium" | "Hard";
  prepTime: string;
  cookTime: string;
  totalTime: string;
  servings: number;
  calories?: string | number;
  rating: number;
  source: string;
  sourceUrl?: string;
  image?: string;
  tags: string[];
  ingredients: Array<{
    original: string;
    amount?: number | null;
    unit?: string;
    name: string;
    wikilink?: string;
    note?: string;
  }>;
  instructions: Array<{
    stepNumber: number;
    text: string;
    timerMinutes?: number | null;
  }>;
  callouts: Array<{
    type: "tip" | "warning" | "info" | "note" | "important";
    title?: string;
    content: string;
  }>;
  notes?: string;
  rawMarkdown: string;
}

/**
 * Strips heavy HTML tags (scripts, styles, SVGs, iframes) and retrieves clean readable text
 */
function cleanHtmlToText(html: string): string {
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Extract meta tags
  cleaned = cleaned.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
  return cleaned.slice(0, 30000); // Send generous snippet to LLM
}

/**
 * Extract JSON-LD scripts from HTML
 */
function extractJsonLd(html: string): any[] {
  const jsonLdBlocks: any[] = [];
  const scriptRegex = /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const raw = match[1].trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          jsonLdBlocks.push(...parsed);
        } else if (parsed["@graph"] && Array.isArray(parsed["@graph"])) {
          jsonLdBlocks.push(...parsed["@graph"]);
        } else {
          jsonLdBlocks.push(parsed);
        }
      }
    } catch {
      // Ignore JSON parse errors in malformed inline scripts
    }
  }

  return jsonLdBlocks;
}

/**
 * Extract OpenGraph and standard meta tags from HTML
 */
function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) meta.title = titleMatch[1].trim();

  // Meta image, description, site_name
  const ogImgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                     html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogImgMatch) meta.image = ogImgMatch[1].trim();

  const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (ogDescMatch) meta.description = ogDescMatch[1].trim();

  const ogSiteMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogSiteMatch) meta.siteName = ogSiteMatch[1].trim();

  return meta;
}

/**
 * Fallback parser for Schema.org Recipe JSON-LD if Gemini key is missing
 */
function parseRecipeFromJsonLd(jsonLdList: any[], url?: string): GrabbedRecipeResult | null {
  const recipeObj = jsonLdList.find(
    (item) => item["@type"] === "Recipe" || (Array.isArray(item["@type"]) && item["@type"].includes("Recipe"))
  );

  if (!recipeObj) return null;

  const title = recipeObj.name || "Imported Web Recipe";
  const description = recipeObj.description || "";
  const cuisine = (Array.isArray(recipeObj.recipeCuisine) ? recipeObj.recipeCuisine[0] : recipeObj.recipeCuisine) || "General";
  const category = (Array.isArray(recipeObj.recipeCategory) ? recipeObj.recipeCategory[0] : recipeObj.recipeCategory) || "Main Course";
  
  // Format ISO duration like PT20M -> 20 mins
  const formatDuration = (d?: string) => {
    if (!d || typeof d !== "string") return "";
    const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
    if (!m) return d;
    const hours = m[1] ? `${m[1]} hr ` : "";
    const mins = m[2] ? `${m[2]} mins` : "";
    return (hours + mins).trim() || d;
  };

  const prepTime = formatDuration(recipeObj.prepTime) || "15 mins";
  const cookTime = formatDuration(recipeObj.cookTime) || "30 mins";
  const totalTime = formatDuration(recipeObj.totalTime) || "45 mins";

  let servings = 4;
  if (recipeObj.recipeYield) {
    const yieldStr = Array.isArray(recipeObj.recipeYield) ? recipeObj.recipeYield[0] : String(recipeObj.recipeYield);
    const parsedYield = parseInt(yieldStr, 10);
    if (!isNaN(parsedYield) && parsedYield > 0) servings = parsedYield;
  }

  // Image
  let image = "";
  if (recipeObj.image) {
    if (typeof recipeObj.image === "string") image = recipeObj.image;
    else if (Array.isArray(recipeObj.image)) image = typeof recipeObj.image[0] === "string" ? recipeObj.image[0] : recipeObj.image[0]?.url || "";
    else if (recipeObj.image.url) image = recipeObj.image.url;
  }

  // Rating
  let rating = 5;
  if (recipeObj.aggregateRating?.ratingValue) {
    const r = parseFloat(recipeObj.aggregateRating.ratingValue);
    if (!isNaN(r)) rating = Math.min(5, Math.max(1, Math.round(r * 10) / 10));
  }

  // Ingredients
  const ingredients: GrabbedRecipeResult["ingredients"] = [];
  const rawIngs = recipeObj.recipeIngredient || [];
  if (Array.isArray(rawIngs)) {
    rawIngs.forEach((ingStr: any) => {
      if (typeof ingStr === "string" && ingStr.trim()) {
        const trimmed = ingStr.trim();
        const parsed = parseIngredientLine(trimmed);
        
        // Clean out preparation phrases (e.g. ", finely diced") to find the pure ingredient noun
        let pureNoun = (parsed.name || trimmed).split(',')[0].split('(')[0].trim();
        pureNoun = pureNoun.replace(/\b(?:minced|diced|chopped|sliced|divided|softened|melted|grated|peeled|cooked|uncooked|to taste|for serving|optional|picked over for shells)\b/gi, '').trim();
        pureNoun = pureNoun.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();

        ingredients.push({
          original: trimmed,
          amount: parsed.amount,
          unit: parsed.unit,
          name: parsed.name || trimmed,
        });
      }
    });
  }

  // Instructions
  const instructions: GrabbedRecipeResult["instructions"] = [];
  const rawSteps = recipeObj.recipeInstructions || [];
  if (Array.isArray(rawSteps)) {
    let stepNum = 1;
    rawSteps.forEach((s: any) => {
      if (typeof s === "string" && s.trim()) {
        instructions.push({ stepNumber: stepNum++, text: s.trim() });
      } else if (s && typeof s === "object") {
        if (s["@type"] === "HowToStep" && s.text) {
          instructions.push({ stepNumber: stepNum++, text: s.text.trim() });
        } else if (s["@type"] === "HowToSection" && Array.isArray(s.itemListElement)) {
          s.itemListElement.forEach((sub: any) => {
            if (sub.text) instructions.push({ stepNumber: stepNum++, text: sub.text.trim() });
          });
        }
      }
    });
  }

  const tags = [
    "food/recipes",
    `cuisine/${cuisine.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    category.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  ].filter(Boolean);

  const rawMarkdown = generateMarkdown({
    title,
    tags,
    cuisine,
    category,
    prepTime,
    cookTime,
    totalTime,
    servings,
    difficulty: "Medium",
    rating,
    source: recipeObj.author?.name || url || "Web Grabber",
    image,
    ingredients,
    instructions,
    callouts: [{ type: "tip", title: "Web Import Note", content: `Imported from ${url || "website"}` }],
    notes: description,
  });

  return {
    title,
    description,
    cuisine,
    category,
    difficulty: "Medium",
    prepTime,
    cookTime,
    totalTime,
    servings,
    rating,
    source: recipeObj.author?.name || (url ? new URL(url).hostname : "Web Grabber"),
    sourceUrl: url,
    image,
    tags,
    ingredients,
    instructions,
    callouts: [{ type: "tip", title: "Imported Recipe", content: description || `Grabbed from ${url || "online recipe"}` }],
    notes: description,
    rawMarkdown,
  };
}

/**
 * Generate Obsidian Markdown with YAML frontmatter
 */
export function generateMarkdown(recipe: Partial<GrabbedRecipeResult>): string {
  const tagsStr = (recipe.tags || ["food/recipes"]).map((t) => `\n  - ${t}`).join("");
  let md = `---
title: "${recipe.title || "Untitled Recipe"}"
tags:${tagsStr}
cuisine: "${recipe.cuisine || "General"}"
category: "${recipe.category || "Main Course"}"
difficulty: "${recipe.difficulty || "Medium"}"
rating: ${recipe.rating || 5}
prep_time: "${recipe.prepTime || "15 mins"}"
cook_time: "${recipe.cookTime || "30 mins"}"
total_time: "${recipe.totalTime || "45 mins"}"
servings: ${recipe.servings || 4}
source: "${recipe.source || "Web Recipe Grabber"}"
image: "${recipe.image || ""}"
created: "${new Date().toISOString().split("T")[0]}"
---

# ${recipe.title || "Untitled Recipe"}

`;

  if (recipe.callouts && recipe.callouts.length > 0) {
    recipe.callouts.forEach((c) => {
      md += `> [!${c.type || "tip"}] ${c.title || "Chef Note"}\n> ${c.content}\n\n`;
    });
  }

  md += `## 🥘 Ingredients\n`;
  if (recipe.ingredients && recipe.ingredients.length > 0) {
    recipe.ingredients.forEach((ing) => {
      md += `${renderIngredientLine(ing, "[ ]")}\n`;
    });
  } else {
    md += `- [ ] 2 tbsp Olive Oil\n- [ ] 1 tsp Sea Salt\n`;
  }
  md += `\n`;

  md += `## 🍳 Instructions\n`;
  if (recipe.instructions && recipe.instructions.length > 0) {
    recipe.instructions.forEach((inst, idx) => {
      md += `${idx + 1}. ${inst.text}\n`;
    });
  } else {
    md += `1. Prepare ingredients according to measurements.\n2. Cook thoroughly and enjoy.\n`;
  }
  md += `\n`;

  if (recipe.notes) {
    md += `## 💡 Notes & Chef Tips\n${recipe.notes}\n\n`;
  }

  return md;
}

/**
 * Main grabber engine using Gemini 3.7 Flash with smart extraction
 */
export async function grabRecipeFromWeb(params: {
  url?: string;
  rawText?: string;
  html?: string;
}): Promise<GrabbedRecipeResult> {
  const { url, rawText } = params;
  let htmlContent = params.html || "";
  let siteName = "";

  // 1. Fetch web page securely if URL provided
  let effectiveSourceUrl = url;
  if (url && !htmlContent) {
    const fetchResult = await safeFetchHtml(url);
    htmlContent = fetchResult.html;
    effectiveSourceUrl = fetchResult.finalUrl;
    try {
      const parsedUrl = new URL(effectiveSourceUrl);
      siteName = parsedUrl.hostname.replace(/^www\./, "");
    } catch {
      siteName = "";
    }
  }

  // 2. Extract JSON-LD and meta tags
  const jsonLdList = htmlContent ? extractJsonLd(htmlContent) : [];
  const metaTags = htmlContent ? extractMetaTags(htmlContent) : {};
  const cleanedText = htmlContent ? cleanHtmlToText(htmlContent) : rawText || "";

  // 3. Attempt Gemini structured extraction with model fallback & retry
  const ai = getGemini();

  if (ai) {
    const prompt = `You are an expert culinary chef and Obsidian Markdown archivist.
Extract this recipe into an accurate, structured JSON recipe object tailored for an Obsidian culinary vault.

Available Data:
- Source URL: ${url || "None provided"}
- Page Meta: ${JSON.stringify(metaTags)}
- JSON-LD Schemas found: ${JSON.stringify(jsonLdList.slice(0, 3))}
- Page Text Content:
"""
${cleanedText.slice(0, 24000)}
"""

REQUIREMENTS:
1. Extract the true title of the recipe (clean of website prefixes like "Best Ever..." or "| Serious Eats").
2. Extract cuisine (e.g. Italian, Mexican, French, Thai, Japanese, American, Indian, etc.) and category (e.g. Dinner, Lunch, Breakfast, Dessert, Soup, Side Dish, Baking).
3. Extract prepTime, cookTime, and totalTime with clear units (e.g. "15 mins", "45 mins").
4. Extract servings as an integer number.
5. Extract difficulty: must be "Easy", "Medium", or "Hard".
6. Extract ingredients: for each ingredient, identify the original line, amount as number (or null), unit (e.g. "tbsp", "cups", "g", "cloves"), and clean name (e.g. "Crab Meat", "Celery", "Mayonnaise", "Brioche Rolls", "Olive Oil", "Garlic"). Do NOT include brackets or wikilinks.
7. Extract instructions: sequential steps with stepNumber and text. If a step involves a specific timer duration, extract timerMinutes as number.
8. Extract callouts: culinary tips or warnings (type: "tip", "warning", "note", "important").
9. Extract high-quality food image URL if present in meta or schema.
10. Generate Obsidian tags like "food/recipes", "cuisine/italian", "dinner", etc.`;

    const modelsToTry = [
      MODEL_CONFIG.recipeGrabberPrimary,
      MODEL_CONFIG.recipeGrabberFallback,
      MODEL_CONFIG.recipeGrabberAlias,
    ];

    for (const modelName of modelsToTry) {
      let attempts = 0;
      const maxAttempts = 2;

      while (attempts < maxAttempts) {
        attempts++;
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  cuisine: { type: Type.STRING },
                  category: { type: Type.STRING },
                  difficulty: { type: Type.STRING, enum: ["Easy", "Medium", "Hard"] },
                  prepTime: { type: Type.STRING },
                  cookTime: { type: Type.STRING },
                  totalTime: { type: Type.STRING },
                  servings: { type: Type.INTEGER },
                  calories: { type: Type.STRING },
                  rating: { type: Type.NUMBER },
                  source: { type: Type.STRING },
                  image: { type: Type.STRING },
                  tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                  ingredients: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        original: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        name: { type: Type.STRING },
                        note: { type: Type.STRING },
                      },
                      required: ["original", "name"],
                    },
                  },
                  instructions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        stepNumber: { type: Type.INTEGER },
                        text: { type: Type.STRING },
                        timerMinutes: { type: Type.NUMBER },
                      },
                      required: ["stepNumber", "text"],
                    },
                  },
                  callouts: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        type: { type: Type.STRING, enum: ["tip", "warning", "info", "note", "important"] },
                        title: { type: Type.STRING },
                        content: { type: Type.STRING },
                      },
                      required: ["type", "content"],
                    },
                  },
                  notes: { type: Type.STRING },
                },
                required: ["title", "cuisine", "category", "ingredients", "instructions"],
              },
            },
          });

          const responseText = response.text;
          if (responseText) {
            const parsed = JSON.parse(responseText);

            // Ensure image fallback if empty
            const image = parsed.image || metaTags.image || "";
            const source = parsed.source || metaTags.siteName || siteName || "Web Grabber";
            const tags = Array.isArray(parsed.tags) && parsed.tags.length > 0 ? parsed.tags : ["food/recipes"];

            const rawMarkdown = generateMarkdown({
              ...parsed,
              image,
              source,
              tags,
            });

            return {
              title: parsed.title || metaTags.title || "Imported Recipe",
              description: parsed.description || metaTags.description || "",
              cuisine: parsed.cuisine || "General",
              category: parsed.category || "Main Course",
              difficulty: parsed.difficulty || "Medium",
              prepTime: parsed.prepTime || "15 mins",
              cookTime: parsed.cookTime || "30 mins",
              totalTime: parsed.totalTime || "45 mins",
              servings: parsed.servings || 4,
              calories: parsed.calories || "",
              rating: parsed.rating || 5,
              source,
              sourceUrl: url,
              image,
              tags,
              ingredients: parsed.ingredients || [],
              instructions: parsed.instructions || [],
              callouts: parsed.callouts || [],
              notes: parsed.notes || "",
              rawMarkdown,
            };
          }
        } catch (aiErr: any) {
          const errMsg = aiErr?.message || String(aiErr);
          const isRetryable =
            errMsg.includes("503") ||
            errMsg.includes("UNAVAILABLE") ||
            errMsg.includes("high demand") ||
            errMsg.includes("429") ||
            errMsg.includes("RESOURCE_EXHAUSTED");

          console.warn(`[RecipeGrabber] Gemini model '${modelName}' attempt ${attempts} failed:`, errMsg);

          if (isRetryable && attempts < maxAttempts) {
            // Short backoff before retry
            await new Promise((r) => setTimeout(r, 600 * attempts));
            continue;
          }
          // Break to cascade to next model
          break;
        }
      }
    }
  }

  // 4. Fallback: Parse from JSON-LD if Gemini is offline
  if (jsonLdList.length > 0) {
    const fallbackResult = parseRecipeFromJsonLd(jsonLdList, url);
    if (fallbackResult) return fallbackResult;
  }

  // 5. Final fallback if minimal raw text or HTML was given
  if (rawText || cleanedText || metaTags.title) {
    const title = metaTags.title || "Custom Imported Recipe";
    const textToScan = rawText || cleanedText || "";
    const lines = textToScan.split("\n").map((l) => l.trim()).filter(Boolean);
    const ingredients: GrabbedRecipeResult["ingredients"] = [];
    const instructions: GrabbedRecipeResult["instructions"] = [];
    let isInstructions = false;

    lines.forEach((line) => {
      if (/instructions|directions|steps|method|preparation/i.test(line)) {
        isInstructions = true;
        return;
      }
      if (!isInstructions) {
        if (/^\d|\b(cup|cups|tbsp|tsp|g|kg|oz|lb|clove|cloves|pinch|handful)\b/i.test(line) || line.startsWith("-") || line.startsWith("*")) {
          const cleanLine = line.replace(/^[-*+]\s*/, "");
          const parsed = parseIngredientLine(cleanLine);
          ingredients.push({
            original: cleanLine,
            amount: parsed.amount,
            unit: parsed.unit,
            name: parsed.name || cleanLine,
          });
        }
      } else {
        if (/^\d+[\.\)]\s*/.test(line) || line.length > 15) {
          instructions.push({
            stepNumber: instructions.length + 1,
            text: line.replace(/^\d+[\.\)]\s*/, ""),
          });
        }
      }
    });

    const fallback: GrabbedRecipeResult = {
      title,
      description: metaTags.description || "Recipe imported from web source",
      cuisine: "General",
      category: "Main Course",
      difficulty: "Medium",
      prepTime: "15 mins",
      cookTime: "30 mins",
      totalTime: "45 mins",
      servings: 4,
      rating: 5,
      source: siteName || metaTags.siteName || "Imported Recipe",
      sourceUrl: url,
      image: metaTags.image || "",
      tags: ["food/recipes", "imported"],
      ingredients: ingredients.length > 0 ? ingredients : [{ original: "Ingredients as noted", name: "Ingredients" }],
      instructions: instructions.length > 0 ? instructions : [{ stepNumber: 1, text: "Follow recipe steps as written." }],
      callouts: [{ type: "tip", title: "Imported", content: "Recipe captured into Obsidian vault." }],
      notes: rawText || "",
      rawMarkdown: "",
    };

    fallback.rawMarkdown = generateMarkdown(fallback);
    return fallback;
  }

  throw new Error("Could not extract recipe content from the provided website or text. Please verify the URL or paste the recipe text directly.");
}
