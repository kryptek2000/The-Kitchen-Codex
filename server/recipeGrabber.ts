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
  /** Number of servings/yield; undefined when the source provides no valid yield. ZERO-FABRICATION. */
  servings?: number;
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
export function cleanHtmlToText(html: string): string {
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
 * Extract JSON-LD scripts from HTML, handling nested @graph and multi-type arrays
 */
export function extractJsonLd(html: string): any[] {
  const jsonLdBlocks: any[] = [];
  const scriptRegex = /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  const flattenItem = (item: any) => {
    if (!item) return;
    if (Array.isArray(item)) {
      item.forEach(flattenItem);
    } else if (typeof item === "object") {
      if (item["@graph"] && Array.isArray(item["@graph"])) {
        item["@graph"].forEach(flattenItem);
      }
      jsonLdBlocks.push(item);
    }
  };

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const raw = match[1].trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        flattenItem(parsed);
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
export function extractMetaTags(html: string): Record<string, string> {
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
 * Format ISO 8601 duration (e.g. PT20M, PT1H30M, P0DT0H45M0S) or human string into clean readable string.
 * ZERO-FABRICATION: returns "" if input is missing or empty.
 */
export function formatDuration(d?: string | number): string {
  if (d === undefined || d === null) return "";
  if (typeof d === "number") {
    if (isNaN(d) || d <= 0) return "";
    const hours = Math.floor(d / 60);
    const mins = Math.round(d % 60);
    if (hours === 0) return `${mins} mins`;
    if (mins === 0) return hours === 1 ? "1 hr" : `${hours} hrs`;
    return `${hours} hr${hours > 1 ? "s" : ""} ${mins} min${mins > 1 ? "s" : ""}`;
  }
  const str = String(d).trim();
  if (!str) return "";

  // ISO 8601 duration: P1DT2H30M or PT1H30M or PT45M or P0DT0H45M0S
  const isoRegex = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;
  const match = str.match(isoRegex);
  if (match && (match[1] || match[2] || match[3] || match[4])) {
    const days = match[1] ? parseFloat(match[1]) : 0;
    const hours = match[2] ? parseFloat(match[2]) : 0;
    const mins = match[3] ? parseFloat(match[3]) : 0;
    const secs = match[4] ? parseFloat(match[4]) : 0;

    const totalMins = Math.round(days * 24 * 60 + hours * 60 + mins + secs / 60);
    if (totalMins > 0) {
      const h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      if (h === 0) return `${m} mins`;
      if (m === 0) return h === 1 ? "1 hr" : `${h} hrs`;
      return `${h} hr${h > 1 ? "s" : ""} ${m} min${m > 1 ? "s" : ""}`;
    }
  }

  // Pure PT notation check
  if (/^PT/i.test(str)) {
    const hMatch = str.match(/(\d+(?:\.\d+)?)H/i);
    const mMatch = str.match(/(\d+(?:\.\d+)?)M/i);
    const sMatch = str.match(/(\d+(?:\.\d+)?)S/i);
    const hours = hMatch ? parseFloat(hMatch[1]) : 0;
    const mins = mMatch ? parseFloat(mMatch[1]) : 0;
    const secs = sMatch ? parseFloat(sMatch[1]) : 0;
    const totalMins = Math.round(hours * 60 + mins + secs / 60);
    if (totalMins > 0) {
      const h = Math.floor(totalMins / 60);
      const m = totalMins % 60;
      if (h === 0) return `${m} mins`;
      if (m === 0) return h === 1 ? "1 hr" : `${h} hrs`;
      return `${h} hr${h > 1 ? "s" : ""} ${m} min${m > 1 ? "s" : ""}`;
    }
  }

  // Pure digits
  if (/^\d+$/.test(str)) {
    const mins = parseInt(str, 10);
    if (!isNaN(mins) && mins > 0) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h === 0) return `${m} mins`;
      if (m === 0) return h === 1 ? "1 hr" : `${h} hrs`;
      return `${h} hr${h > 1 ? "s" : ""} ${m} min${m > 1 ? "s" : ""}`;
    }
  }

  return str;
}

/**
 * Parses recipe yield or servings field into a positive integer without defaulting blindly to 4.
 */
export function parseRecipeYield(recipeYield: any): number | undefined {
  if (recipeYield === undefined || recipeYield === null) return undefined;
  if (typeof recipeYield === "number") {
    return isNaN(recipeYield) || recipeYield <= 0 ? undefined : Math.round(recipeYield);
  }

  const rawList = Array.isArray(recipeYield) ? recipeYield : [recipeYield];
  for (const item of rawList) {
    if (typeof item === "number" && item > 0) return Math.round(item);
    if (typeof item !== "string") continue;
    const str = item.trim();
    if (!str) continue;

    // Check for "4 to 6 servings", "4-6 servings", "serves 4 to 6"
    const rangeMatch = str.match(/(\d+)\s*(?:-|to)\s*(\d+)/i);
    if (rangeMatch) {
      const min = parseInt(rangeMatch[1], 10);
      if (!isNaN(min) && min > 0) return min;
    }

    // Check for "1 loaf (8 slices)" or "8 slices" or "24 cookies" or "4 servings"
    const specificUnitMatch = str.match(/(\d+)\s*(?:servings?|portions?|people|slices?|pieces?|cookies?|muffins?|biscuits?|bars?|cups?|items?)\b/i);
    if (specificUnitMatch) {
      const num = parseInt(specificUnitMatch[1], 10);
      if (!isNaN(num) && num > 0) return num;
    }

    // First integer in string e.g. "Makes 12"
    const anyIntMatch = str.match(/\b(\d+)\b/);
    if (anyIntMatch) {
      const num = parseInt(anyIntMatch[1], 10);
      if (!isNaN(num) && num > 0) return num;
    }
  }

  return undefined;
}

/**
 * Checks if a Schema.org @type represents a Recipe
 */
function isRecipeType(type: any): boolean {
  if (!type) return false;
  if (typeof type === "string") return type.toLowerCase().includes("recipe");
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && t.toLowerCase().includes("recipe"));
  return false;
}

/**
 * Parser for Schema.org Recipe JSON-LD (supports @graph, arrays, HowToStep, HowToSection)
 * STRICT ZERO-FABRICATION: If times or metadata are absent, leave them empty/undefined.
 */
export function parseRecipeFromJsonLd(jsonLdList: any[], url?: string): GrabbedRecipeResult | null {
  const recipeObj = jsonLdList.find((item) => isRecipeType(item["@type"]));

  if (!recipeObj) return null;

  const title = recipeObj.name || "Imported Web Recipe";
  const description = recipeObj.description || "";
  const cuisine = (Array.isArray(recipeObj.recipeCuisine) ? recipeObj.recipeCuisine[0] : recipeObj.recipeCuisine) || "General";
  const category = (Array.isArray(recipeObj.recipeCategory) ? recipeObj.recipeCategory[0] : recipeObj.recipeCategory) || "Main Course";
  
  // Zero-fabrication: do NOT default to "15 mins", "30 mins", "45 mins"
  const prepTime = formatDuration(recipeObj.prepTime);
  const cookTime = formatDuration(recipeObj.cookTime);
  const totalTime = formatDuration(recipeObj.totalTime);

  const parsedYield = parseRecipeYield(recipeObj.recipeYield || recipeObj.yield);
  const servings = parsedYield;

  // Image
  let image = "";
  if (recipeObj.image) {
    if (typeof recipeObj.image === "string") {
      image = recipeObj.image;
    } else if (Array.isArray(recipeObj.image)) {
      const first = recipeObj.image[0];
      image = typeof first === "string" ? first : first?.url || "";
    } else if (recipeObj.image && typeof recipeObj.image === "object") {
      image = recipeObj.image.url || "";
    }
  }

  // Rating
  let rating = 5;
  if (recipeObj.aggregateRating?.ratingValue) {
    const r = parseFloat(recipeObj.aggregateRating.ratingValue);
    if (!isNaN(r)) rating = Math.min(5, Math.max(1, Math.round(r * 10) / 10));
  }

  // Calories
  let calories: string | undefined;
  if (recipeObj.nutrition?.calories) {
    calories = String(recipeObj.nutrition.calories).replace(/calories/i, "").trim();
  }

  // Ingredients (Zero automatic wikilink insertion)
  const ingredients: GrabbedRecipeResult["ingredients"] = [];
  const rawIngs = recipeObj.recipeIngredient || recipeObj.ingredients || [];
  if (Array.isArray(rawIngs)) {
    rawIngs.forEach((ingStr: any) => {
      if (typeof ingStr === "string" && ingStr.trim()) {
        const trimmed = ingStr.trim();
        const parsed = parseIngredientLine(trimmed);
        ingredients.push({
          original: trimmed,
          amount: parsed.amount,
          unit: parsed.unit,
          name: parsed.name || trimmed,
        });
      }
    });
  }

  // Instructions (Handles strings, HowToStep, HowToSection, nested itemListElement)
  const instructions: GrabbedRecipeResult["instructions"] = [];
  const rawSteps = recipeObj.recipeInstructions || [];

  const extractSteps = (steps: any[]) => {
    if (!Array.isArray(steps)) return;
    steps.forEach((s: any) => {
      if (typeof s === "string" && s.trim()) {
        instructions.push({ stepNumber: instructions.length + 1, text: s.trim() });
      } else if (s && typeof s === "object") {
        if (s["@type"] === "HowToSection" || Array.isArray(s.itemListElement)) {
          if (Array.isArray(s.itemListElement)) {
            extractSteps(s.itemListElement);
          }
        } else if (s.text || s.name) {
          const stepText = (s.text || s.name || "").trim();
          if (stepText) {
            instructions.push({ stepNumber: instructions.length + 1, text: stepText });
          }
        }
      }
    });
  };

  extractSteps(Array.isArray(rawSteps) ? rawSteps : [rawSteps]);

  // Author & Source
  let authorName = "";
  if (recipeObj.author) {
    if (typeof recipeObj.author === "string") {
      authorName = recipeObj.author;
    } else if (Array.isArray(recipeObj.author)) {
      const first = recipeObj.author[0];
      authorName = typeof first === "string" ? first : first?.name || "";
    } else if (typeof recipeObj.author === "object") {
      authorName = recipeObj.author.name || "";
    }
  }

  let sourceHost = "";
  if (url) {
    try {
      sourceHost = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      sourceHost = "";
    }
  }

  const source = authorName || sourceHost || "Web Grabber";

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
    calories,
    difficulty: "Medium",
    rating,
    source,
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
    calories,
    rating,
    source,
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
 * ZERO-FABRICATION: Only outputs optional timing fields if they exist and are non-empty.
 */
export function generateMarkdown(recipe: Partial<GrabbedRecipeResult>): string {
  const tagsStr = (recipe.tags || ["food/recipes"]).map((t) => `\n  - ${t}`).join("");
  let md = `---
title: "${recipe.title || "Untitled Recipe"}"
tags:${tagsStr}
cuisine: "${recipe.cuisine || "General"}"
category: "${recipe.category || "Main Course"}"
difficulty: "${recipe.difficulty || "Medium"}"
rating: ${recipe.rating !== undefined ? recipe.rating : 5}
`;

  if (recipe.prepTime) {
    md += `prep_time: "${recipe.prepTime}"\n`;
  }
  if (recipe.cookTime) {
    md += `cook_time: "${recipe.cookTime}"\n`;
  }
  if (recipe.totalTime) {
    md += `total_time: "${recipe.totalTime}"\n`;
  }
  if (recipe.servings !== undefined) {
    md += `servings: ${recipe.servings}\n`;
  }
  if (recipe.calories) {
    md += `calories: "${recipe.calories}"\n`;
  }

  md += `source: "${recipe.source || "Web Recipe Grabber"}"\n`;
  if (recipe.image && recipe.image.trim()) {
    md += `image: "${recipe.image.trim()}"\n`;
  }
  md += `created: "${new Date().toISOString().split("T")[0]}"
---

# ${recipe.title || "Untitled Recipe"}

`;

  if (recipe.callouts && recipe.callouts.length > 0) {
    recipe.callouts.forEach((c) => {
      md += `> [!${c.type || "tip"}] ${c.title || "Chef Note"}\n> ${c.content}\n\n`;
    });
  }

  // ZERO-FABRICATION: only emit sections that actually contain source data.
  if (recipe.ingredients && recipe.ingredients.length > 0) {
    md += `## 🥘 Ingredients\n`;
    recipe.ingredients.forEach((ing) => {
      md += `${renderIngredientLine(ing, "[ ]")}\n`;
    });
    md += `\n`;
  }

  if (recipe.instructions && recipe.instructions.length > 0) {
    md += `## 🍳 Instructions\n`;
    recipe.instructions.forEach((inst, idx) => {
      md += `${idx + 1}. ${inst.text}\n`;
    });
    md += `\n`;
  }

  if (recipe.notes) {
    md += `## 💡 Notes & Chef Tips\n${recipe.notes}\n\n`;
  }

  return md;
}

/**
 * Main grabber engine supporting { url, html, rawText } inputs.
 * Priority: JSON-LD -> Gemini (LLM) -> Heuristic Text Parsing
 */
export async function grabRecipeFromWeb(params: {
  url?: string;
  rawText?: string;
  html?: string;
}): Promise<GrabbedRecipeResult> {
  const { url, rawText } = params;
  let htmlContent = params.html || "";
  let siteName = "";

  // 1. Fetch web page securely if URL provided and HTML not already supplied
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

  // 2. Extract JSON-LD and meta tags if HTML is present
  const jsonLdList = htmlContent ? extractJsonLd(htmlContent) : [];
  const metaTags = htmlContent ? extractMetaTags(htmlContent) : {};

  // Pipeline Priority 1: High-fidelity JSON-LD Schema (zero-cost, zero-latency, deterministic)
  if (jsonLdList.length > 0) {
    const jsonLdResult = parseRecipeFromJsonLd(jsonLdList, effectiveSourceUrl);
    if (
      jsonLdResult &&
      jsonLdResult.title &&
      jsonLdResult.ingredients.length > 0 &&
      jsonLdResult.instructions.length > 0
    ) {
      return jsonLdResult;
    }
  }

  const cleanedText = htmlContent ? cleanHtmlToText(htmlContent) : rawText || "";

  // Pipeline Priority 2: Gemini structured extraction with model fallback & retry
  const ai = getGemini();

  if (ai && (cleanedText.length > 0 || Object.keys(metaTags).length > 0)) {
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
3. Extract prepTime, cookTime, and totalTime with clear units (e.g. "15 mins", "45 mins") ONLY if present in source text. Do NOT invent or guess timing if missing.
4. Extract servings as an integer number.
5. Extract difficulty: "Easy", "Medium", or "Hard".
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
              prepTime: parsed.prepTime || "",
              cookTime: parsed.cookTime || "",
              totalTime: parsed.totalTime || "",
              servings: typeof parsed.servings === "number" && parsed.servings > 0 ? parsed.servings : undefined,
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
            await new Promise((r) => setTimeout(r, 600 * attempts));
            continue;
          }
          break;
        }
      }
    }
  }

  // Pipeline Priority 3: Fallback JSON-LD if partial
  if (jsonLdList.length > 0) {
    const fallbackResult = parseRecipeFromJsonLd(jsonLdList, effectiveSourceUrl);
    if (fallbackResult) return fallbackResult;
  }

  // Pipeline Priority 4: Regex & Heuristic Text Fallback
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
      prepTime: "",
      cookTime: "",
      totalTime: "",
      servings: undefined,
      rating: 5,
      source: siteName || metaTags.siteName || "Imported Recipe",
      sourceUrl: url,
      image: metaTags.image || "",
      tags: ["food/recipes", "imported"],
      ingredients,
      instructions,
      callouts: [{ type: "tip", title: "Imported", content: "Recipe captured into Obsidian vault." }],
      notes: rawText || "",
      rawMarkdown: "",
    };

    fallback.rawMarkdown = generateMarkdown(fallback);
    return fallback;
  }

  throw new Error("Could not extract recipe content from the provided website or text. Please verify the URL or paste the recipe text directly.");
}
