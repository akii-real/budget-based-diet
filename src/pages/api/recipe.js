import axios from 'axios';
import { MongoClient } from 'mongodb';

import {
  listStaleIngredientNames,
  normalizeIngredientName,
  parseIngredientsString,
  refreshIngredientsViaBackend,
} from '../../lib/ingredientPrices';

async function getMongoCollection() {
  const user = process.env.MONGO_DB_USERNAME;
  const pw = process.env.MONGO_DB_PASSWORD;
  const url = process.env.MONGO_DB_URL;
  const DATABASE = 'dietprices';
  const COLLECTION = 'Ingredients';

  if (!user || !pw || !url) {
    throw new Error('MongoDB credentials missing');
  }

  const uri = `mongodb+srv://${user}:${pw}@${url}/${DATABASE}?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);

  try {
    await client.connect();
  } catch (error) {
    throw new Error('Failed to connect to MongoDB');
  }

  const db = client.db(DATABASE);
  return db.collection(COLLECTION);
}

function safeParseJson(text) {
  let t = String(text).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch (sliceErr) {}
    }
    const err = new Error('AI_JSON_PARSE');
    err.cause = e;
    throw err;
  }
}

function normalizeCost(recipe) {
  const n = Number(
    String(recipe['Estimated Cost (?)'] ?? recipe.cost ?? '0').replace(
      /[^0-9.]/g,
      ''
    )
  );
  return {
    ...recipe,
    cost: Number.isFinite(n) ? n : 0,
  };
}

function parseIngredientQuantities(quantitiesStr, ingredientsStr) {
  const result = {};
  const ingredients = parseIngredientsString(ingredientsStr || '');
  ingredients.forEach((name) => {
    result[name] = 0.1; // default 100g fallback
  });
  if (!quantitiesStr || typeof quantitiesStr !== 'string') return result;

  const unitToKg = (qty, unit) => {
    const u = String(unit || '').toLowerCase();
    if (!u || u === 'kg' || u === 'kgs') return qty;
    if (u === 'g' || u === 'gm' || u === 'grams') return qty / 1000;
    if (u === 'l' || u === 'liter' || u === 'litre') return qty; // approx water density
    if (u === 'ml') return qty / 1000;
    if (u === 'tbsp') return qty * 0.015;
    if (u === 'tsp') return qty * 0.005;
    if (
      u === 'piece' ||
      u === 'pieces' ||
      u === 'pc' ||
      u === 'nos' ||
      u === 'no'
    )
      return qty * 0.1;
    return qty;
  };

  quantitiesStr.split(',').forEach((item) => {
    const [rawName, rawQty] = item.split(':');
    if (!rawName || !rawQty) return;
    const name = normalizeIngredientName(rawName);
    const m = String(rawQty)
      .trim()
      .match(/([\d.]+)\s*([a-zA-Z]+)?/);
    if (!m) return;
    const qty = Number(m[1]);
    if (!Number.isFinite(qty) || qty <= 0) return;
    result[name] = Math.max(0.01, unitToKg(qty, m[2]));
  });
  return result;
}

function buildFallbackQuantities(ingredientsStr) {
  return parseIngredientsString(ingredientsStr)
    .map((name) => `${name}: 100 g`)
    .join(', ');
}

function buildFallbackInstructions(recipeName) {
  return (
    `1. Wash, peel, and prep all ingredients for ${recipeName}. ` +
    '2. Measure each ingredient as listed and keep them ready before turning on heat. ' +
    '3. Heat a pan on medium flame, add oil, and cook aromatics until fragrant and lightly golden. ' +
    '4. Add main ingredients and spices, stir continuously for even coating and avoid burning. ' +
    '5. Add water if needed, cover, and cook on low flame until ingredients are fully cooked and tender. ' +
    '6. Taste and adjust salt/spice, then simmer 2-3 more minutes before serving hot.'
  );
}

function buildFallbackRecipe(recipeName, mealTypeHint, seedRecipe) {
  const baseName = String(
    recipeName || seedRecipe?.['Recipe name'] || 'Homestyle Recipe'
  ).trim();
  const ingredients =
    String(seedRecipe?.Ingredients || '').trim() ||
    'onion, tomato, ginger, garlic, oil, salt, spices';
  const mealType =
    String(mealTypeHint || seedRecipe?.['Meal Type'] || 'Lunch').trim() ||
    'Lunch';
  const calories = String(seedRecipe?.['Calories (kcal)'] || '450');
  const protein = String(seedRecipe?.['Protein (g)'] || '18');
  const fats = String(seedRecipe?.['Fats (g)'] || '14');
  const estCost = String(
    seedRecipe?.['Estimated Cost (?)'] || seedRecipe?.cost || '250'
  );
  return normalizeCost({
    ...seedRecipe,
    'Recipe name': baseName,
    'Meal Type': mealType,
    'Calories (kcal)': calories,
    'Protein (g)': protein,
    'Fats (g)': fats,
    Ingredients: ingredients,
    'Ingredient Quantities': buildFallbackQuantities(ingredients),
    Instructions: buildFallbackInstructions(baseName),
    'Estimated Cost (?)': estCost,
  });
}

function providerConfig() {
  const ollamaModel = process.env.OLLAMA_MODEL || '';
  const ollamaBase = (
    process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
  ).replace(/\/$/, '');
  if (ollamaModel) {
    return { provider: 'ollama', model: ollamaModel, base: ollamaBase };
  }
  return null;
}

async function chatRecipeJson(messages) {
  const cfg = providerConfig();
  if (!cfg) {
    throw new Error('NO_AI_PROVIDER');
  }

  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000;
  try {
    const response = await axios.post(
      `${cfg.base}/api/chat`,
      {
        model: cfg.model,
        messages,
        stream: false,
        format: 'json',
        options: { temperature: 0.45, num_ctx: 4096, num_predict: 650 },
      },
      {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const body = response.data;
    const content = body?.message?.content;
    if (!content) {
      throw new Error('EMPTY_AI_RECIPE');
    }
    return content;
  } catch (e) {
    if (axios.isAxiosError(e)) {
      if (e.code === 'ECONNABORTED') {
        const err = new Error('OLLAMA_TIMEOUT');
        err.name = 'AbortError';
        throw err;
      }
      console.error(
        'Ollama recipe error:',
        e.response?.status,
        e.response?.data || e.message
      );
      throw new Error('OLLAMA_HTTP');
    }
    throw e;
  }
}

async function generateRecipeFromAI(recipeName, mealTypeHint) {
  const hint = mealTypeHint
    ? `The recipe is usually eaten for: ${mealTypeHint}. Set "Meal Type" to one of: Breakfast, Lunch, Snacks, Dinner (prefer ${mealTypeHint}).`
    : 'Set "Meal Type" to the most appropriate one of: Breakfast, Lunch, Snacks, Dinner.';

  const prompt = `Recipe title / dish name: "${recipeName}"

${hint}

Generate one complete, realistic recipe (Indian home-style when it fits the dish). Return ONLY valid JSON with these exact keys (all string values):
"Recipe name", "Meal Type", "Calories (kcal)", "Protein (g)", "Fats (g)", "Ingredients", "Ingredient Quantities", "Instructions", "Estimated Cost (?)"

Rules:
- "Recipe name" should match or closely match the dish name given.
- "Ingredients": comma-separated simple grocery-friendly names (e.g. "atta, ghee, salt, water") � no long prose.
- "Ingredient Quantities": comma-separated mapping in this exact style: "ingredient: quantity unit, ingredient: quantity unit" (example: "paneer: 150 g, onion: 80 g, oil: 15 ml, salt: 5 g").
- "Instructions": detailed numbered steps in one string with at least 6 steps, including prep, cook time/heat guidance, and finishing notes.
- "Estimated Cost (?)": rough total ingredient cost in INR as a numeric string.`;

  const content = await chatRecipeJson([
    {
      role: 'system',
      content:
        'You output only a single valid JSON object for one recipe. No markdown, no commentary.',
    },
    { role: 'user', content: prompt },
  ]);

  const parsed = safeParseJson(content);
  const instructions = String(parsed?.Instructions || '');
  const stepCount = (instructions.match(/\d+\./g) || []).length;
  if (
    !parsed ||
    typeof parsed.Ingredients !== 'string' ||
    !parsed.Ingredients.trim() ||
    typeof parsed['Ingredient Quantities'] !== 'string' ||
    !parsed['Ingredient Quantities'].trim() ||
    stepCount < 4
  ) {
    throw new Error('INVALID_AI_RECIPE');
  }

  return normalizeCost(parsed);
}

async function computePlatformPrices(collection, recipe) {
  const normalizedList = parseIngredientsString(recipe.Ingredients || '');
  const qtyKgByIngredient = parseIngredientQuantities(
    recipe['Ingredient Quantities'],
    recipe.Ingredients
  );
  const stale = await listStaleIngredientNames(collection, normalizedList);
  if (stale.length > 0) {
    await refreshIngredientsViaBackend(stale);
  }

  const totalPrices = { Blinkit: 0, Zepto: 0, Instamart: 0 };

  for (const raw of recipe.Ingredients?.split(',') || []) {
    const ingredient = normalizeIngredientName(raw.replace(/['"]+/g, ''));
    if (!ingredient) continue;

    let ingredientData = await collection.findOne({ name: ingredient });
    if (!ingredientData) {
      ingredientData = await collection.findOne({
        name: { $regex: escapeRegExp(ingredient), $options: 'i' },
      });
    }

    if (ingredientData?.prices?.length) {
      const blinkitPrice =
        ingredientData.prices.find((p) => p.platform === 'Blinkit')
          ?.price_per_kg || 0;
      const zeptoPrice =
        ingredientData.prices.find((p) => p.platform === 'Zepto')
          ?.price_per_kg || 0;
      const instamartPrice =
        ingredientData.prices.find((p) => p.platform === 'Instamart')
          ?.price_per_kg || 0;

      const qtyKg = qtyKgByIngredient[ingredient] || 0.1;
      totalPrices.Blinkit += blinkitPrice * qtyKg;
      totalPrices.Zepto += zeptoPrice * qtyKg;
      totalPrices.Instamart += instamartPrice * qtyKg;
    } else {
      console.warn(`No matching ingredient found in DB for: ${ingredient}`);
    }
  }

  return totalPrices;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { recipe } = req.body || {};
      if (
        !recipe ||
        typeof recipe.Ingredients !== 'string' ||
        !recipe.Ingredients.trim()
      ) {
        return res.status(400).json({
          error: 'Recipe with Ingredients string is required',
          code: 'INVALID_BODY',
        });
      }
      let effectiveRecipe = recipe;
      if (
        !effectiveRecipe['Ingredient Quantities'] ||
        !String(effectiveRecipe['Ingredient Quantities']).trim() ||
        !effectiveRecipe.Instructions ||
        (String(effectiveRecipe.Instructions).match(/\d+\./g) || []).length < 4
      ) {
        const nameHint = String(effectiveRecipe['Recipe name'] || '').trim();
        const mealHint = String(effectiveRecipe['Meal Type'] || '').trim();
        if (nameHint) {
          try {
            effectiveRecipe = await generateRecipeFromAI(nameHint, mealHint);
          } catch (e) {
            effectiveRecipe = buildFallbackRecipe(
              nameHint,
              mealHint,
              effectiveRecipe
            );
          }
        }
      }
      const collection = await getMongoCollection();
      const totalPrices = await computePlatformPrices(
        collection,
        effectiveRecipe
      );
      return res
        .status(200)
        .json({ recipe: effectiveRecipe, platformPrices: totalPrices });
    }

    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res
        .status(405)
        .json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    }

    const name =
      typeof req.query.name === 'string' ? req.query.name : req.query.name?.[0];
    const mealType =
      typeof req.query.mealType === 'string'
        ? req.query.mealType
        : req.query.mealType?.[0] || '';

    if (!name?.trim()) {
      return res
        .status(400)
        .json({ error: 'Recipe name is required', code: 'INVALID_QUERY' });
    }

    let recipe;
    try {
      recipe = await generateRecipeFromAI(name.trim(), mealType.trim());
    } catch (e) {
      recipe = buildFallbackRecipe(name.trim(), mealType.trim(), null);
    }
    const collection = await getMongoCollection();
    const totalPrices = await computePlatformPrices(collection, recipe);

    res.status(200).json({ recipe, platformPrices: totalPrices });
  } catch (error) {
    console.error('Error in /api/recipe:', error);
    const msg = error.message || 'Error fetching data';
    if (msg === 'NO_AI_PROVIDER') {
      return res.status(503).json({
        error: 'No AI provider configured. Set OLLAMA_MODEL for local Ollama.',
        code: 'NO_AI_PROVIDER',
      });
    }
    if (error?.name === 'AbortError' || msg === 'OLLAMA_TIMEOUT') {
      return res.status(504).json({
        error: 'Recipe generation timed out. Please try again.',
        code: 'OLLAMA_TIMEOUT',
      });
    }
    if (msg === 'OLLAMA_HTTP') {
      return res.status(502).json({
        error:
          'Ollama request failed. Make sure Ollama is running and OLLAMA_MODEL is pulled.',
        code: 'OLLAMA_HTTP',
      });
    }
    if (msg.includes('AI_RECIPE_HTTP')) {
      return res
        .status(502)
        .json({ error: 'AI recipe request failed', code: 'AI_RECIPE_HTTP' });
    }
    if (msg.includes('INVALID_AI_RECIPE') || msg.includes('EMPTY_AI_RECIPE')) {
      return res.status(502).json({
        error: 'AI returned invalid recipe data',
        code: 'AI_INVALID_RECIPE',
      });
    }
    if (msg === 'AI_JSON_PARSE') {
      return res.status(502).json({
        error: 'AI returned invalid recipe JSON',
        code: 'AI_JSON_PARSE',
      });
    }
    res.status(500).json({ error: msg, code: 'INTERNAL_ERROR' });
  }
}
