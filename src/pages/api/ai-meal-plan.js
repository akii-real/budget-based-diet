import axios from 'axios';
import crypto from 'crypto';
import { MongoClient } from 'mongodb';

import {
  collectIngredientsFromMealGroups,
  refreshIngredientsViaBackend,
} from '../../lib/ingredientPrices';

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Snacks', 'Dinner'];
const DISTRIBUTION = {
  Breakfast: 0.25,
  Lunch: 0.35,
  Snacks: 0.15,
  Dinner: 0.25,
};
const DEFAULT_MAX_MODEL_CALLS = 4;
const MEAL_PLAN_DB = 'dietprices';
const MEAL_PLAN_COLLECTION = 'MealPlans';

function buildPrompt({
  name,
  age,
  height,
  weight,
  sex,
  dietGoal,
  preference,
  excludeRecipeNames,
  budget,
  calories,
  macros,
  variationNote,
}) {
  const lines = MEAL_TYPES.map((mt) => {
    const pct = DISTRIBUTION[mt];
    const target = Math.round(calories * pct);
    const minCal = Math.round(target * 0.85);
    const maxCal = Math.round(target * 1.15);
    const slotBudget = Math.round(budget * pct);
    return `- ${mt}: total calories for this slot between ${minCal} and ${maxCal} (target ~${target}), total estimated ? cost for all recipes in this slot at most ?${slotBudget}.`;
  }).join('\n');

  const vary = variationNote
    ? `\nCreate a different set of recipes than typical defaults; ${variationNote}`
    : '';

  const exclude =
    Array.isArray(excludeRecipeNames) && excludeRecipeNames.length
      ? `\nAvoid repeating previously suggested dishes. Do NOT use any of these recipe names (case-insensitive): ${excludeRecipeNames
          .slice(0, 120)
          .map((x) => `"${String(x).slice(0, 80)}"`)
          .join(', ')}.`
      : '';

  return `You are a nutrition assistant helping users in India who shop on quick-commerce apps (Blinkit, Zepto, Instamart).

HARD BUDGET RULE (non-negotiable):
- The user can spend at most ?${budget} on food for this entire day.
- Add up "Estimated Cost (?)" for EVERY recipe in EVERY slot. That sum MUST be less than or equal to ?${budget}. Never exceed it.
- "Estimated Cost (?)" is your best honest estimate for that recipe's ingredients in INR for one serving as written. Choose simpler or cheaper dishes if needed to stay within ?${budget} total.
- Actual checkout prices will be refined later from live app prices; your estimates must still respect this cap.

User profile:
- Name: ${name || 'User'}
- Age: ${age}, Height (cm): ${height}, Weight (kg): ${weight}, Sex: ${sex}
- Goal: ${dietGoal}
- Preference: ${preference || 'none specified'}
- Daily calorie target: ${calories} kcal
- Macro targets (approximate): protein ${macros.protein}g, carbs ${
    macros.carbs
  }g, fat ${macros.fat}g
- Maximum daily food budget: ?${budget} (same as HARD BUDGET RULE above)

Per meal slot (calories + share of the same ?${budget} total � slot ? caps are guidance; the full-day sum must still be = ?${budget}):
${lines}

Rules:
- Build a balanced day: include a clear protein source in every slot, include vegetables/fiber in at least 2 slots, and avoid repeating the exact same main dish across multiple slots.
- Prefer practical Indian home-style or easy-prep meals; keep ingredient names simple and grocery-friendly (e.g. "rice, toor dal, ghee, salt, turmeric") � no long prose inside Ingredients.
- Provide exactly 1 recipe per slot (Breakfast, Lunch, Snacks, Dinner); calories and costs are per recipe; respect slot calorie ranges and keep the whole day within ?${budget}.
- Use realistic numeric strings for macros and calories on each recipe.
- You MUST include at least one recipe in each of Breakfast, Lunch, Snacks, and Dinner (never use empty arrays for a slot).
- Preference rules:
  - If preference is "veg": strictly vegetarian. Do NOT include meat, chicken, fish/seafood, eggs, or gelatin.
  - If preference is "non-veg": you may include eggs and meat/fish, but still keep the day balanced and within budget.
${exclude}
${vary}

If you cannot satisfy the HARD BUDGET RULE while also respecting preference and avoiding excluded recipe names, respond with ONLY this JSON:
{"noMoreRecipes":true}

Respond with ONLY valid JSON (no markdown) in this exact shape:
{"mealGroups":{"Breakfast":[...],"Lunch":[...],"Snacks":[...],"Dinner":[...]}}

Each recipe object MUST use these exact string keys:
"Recipe name", "Meal Type", "Calories (kcal)", "Protein (g)", "Fats (g)", "Ingredients", "Instructions", "Estimated Cost (?)"

Meal Type must equal the group it belongs to (Breakfast, Lunch, Snacks, or Dinner).
Ingredients: a single comma-separated string. Instructions: numbered steps as one string.`;
}

function safeParseJson(text) {
  let t = String(text).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  // Try direct parse first.
  try {
    return JSON.parse(t);
  } catch (e) {
    // Salvage common model failures: extra prose around JSON or truncated tail.
    const start = t.indexOf('{');
    if (start >= 0) {
      // Find last plausible JSON object end.
      const end = t.lastIndexOf('}');
      if (end > start) {
        const slice = t.slice(start, end + 1);
        try {
          return JSON.parse(slice);
        } catch (sliceErr) {
          // Try to bracket-balance to the first complete JSON object.
          let depth = 0;
          let inString = false;
          let escaped = false;
          for (let i = 0; i < t.length; i++) {
            const ch = t[i];
            if (inString) {
              if (escaped) {
                escaped = false;
              } else if (ch === '\\') {
                escaped = true;
              } else if (ch === '"') {
                inString = false;
              }
              continue;
            }
            if (ch === '"') {
              inString = true;
              continue;
            }
            if (ch === '{') depth++;
            if (ch === '}') {
              depth--;
              if (depth === 0 && i > start) {
                const obj = t.slice(start, i + 1);
                try {
                  return JSON.parse(obj);
                } catch {
                  // keep scanning; final normalized parse error thrown below
                }
              }
            }
          }
        }
      }
    }
    const err = new Error('AI_JSON_PARSE');
    err.cause = e;
    throw err;
  }
}

function toApiError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function normalizeNameForMatch(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function collectRecipeNames(mealGroups) {
  const out = [];
  for (const mt of MEAL_TYPES) {
    for (const r of mealGroups?.[mt] || []) {
      const n = String(r?.['Recipe name'] || '').trim();
      if (n) out.push(n);
    }
  }
  return out;
}

function profileSignatureFromBody(body) {
  const snap = {
    age: Number(body?.age || 0),
    height: Number(body?.height || 0),
    weight: Number(body?.weight || 0),
    sex: String(body?.sex || ''),
    dietGoal: String(body?.dietGoal || ''),
    preference: String(body?.preference || ''),
    calories: Number(body?.calories || 0),
    macros: {
      protein: Number(body?.macros?.protein || 0),
      carbs: Number(body?.macros?.carbs || 0),
      fat: Number(body?.macros?.fat || 0),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
}

function planHashFromMealGroups(mealGroups) {
  const normalized = {};
  for (const mt of MEAL_TYPES) {
    normalized[mt] = (mealGroups?.[mt] || []).map((r) => ({
      recipe: String(r?.['Recipe name'] || '')
        .trim()
        .toLowerCase(),
      calories: String(r?.['Calories (kcal)'] || '').trim(),
      protein: String(r?.['Protein (g)'] || '').trim(),
      fats: String(r?.['Fats (g)'] || '').trim(),
      est: String(r?.['Estimated Cost (?)'] || '').trim(),
    }));
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

async function getMealPlanCollection() {
  const user = process.env.MONGO_DB_USERNAME;
  const pw = process.env.MONGO_DB_PASSWORD;
  const url = process.env.MONGO_DB_URL;
  if (!user || !pw || !url) return null;
  const uri = `mongodb+srv://${user}:${pw}@${url}/${MEAL_PLAN_DB}?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  return {
    client,
    collection: client.db(MEAL_PLAN_DB).collection(MEAL_PLAN_COLLECTION),
  };
}

async function listStoredPlans(collection, profileSignature, maxTotalCost) {
  return collection
    .find({
      profileSignature,
      totalEstimatedCost: { $lte: Number(maxTotalCost || 0) },
    })
    .sort({ totalEstimatedCost: 1, createdAt: -1 })
    .limit(50)
    .toArray();
}

function chooseStoredPlan(storedPlans, excludeNamesSet) {
  if (!Array.isArray(storedPlans) || storedPlans.length === 0) return null;
  for (const plan of storedPlans) {
    const names = Array.isArray(plan.recipeNames) ? plan.recipeNames : [];
    const hasExcluded = names.some((n) =>
      excludeNamesSet.has(normalizeNameForMatch(n))
    );
    if (!hasExcluded && plan.mealGroups) return plan;
  }
  return null;
}

function slotFromJsonKey(key) {
  const k = String(key || '')
    .toLowerCase()
    .replace(/[_-]/g, ' ');
  if (k.includes('breakfast')) return 'Breakfast';
  if (k.includes('lunch')) return 'Lunch';
  if (k.includes('snack')) return 'Snacks';
  if (k.includes('dinner') || k.includes('supper')) return 'Dinner';
  return null;
}

function slotFromRecipeMealType(recipe) {
  if (!recipe || typeof recipe !== 'object') return null;
  const v =
    recipe['Meal Type'] ??
    recipe.mealType ??
    recipe['meal type'] ??
    recipe.meal_type ??
    recipe.slot;
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase();
  if (s.includes('breakfast')) return 'Breakfast';
  if (s.includes('lunch')) return 'Lunch';
  if (s.includes('snack')) return 'Snacks';
  if (s.includes('dinner') || s.includes('supper')) return 'Dinner';
  return null;
}

function mealContainer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return (
    raw.mealGroups ??
    raw.meal_groups ??
    raw.MealGroups ??
    raw.mealsBySlot ??
    raw
  );
}

/**
 * Maps varied model output (wrong casing, "Snack" vs "Snacks", recipes only tagged by Meal Type)
 * into { Breakfast, Lunch, Snacks, Dinner }.
 */
function normalizeGroups(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { Breakfast: [], Lunch: [], Snacks: [], Dinner: [] };
  const container = mealContainer(raw);
  if (!container) return null;

  const assign = (recipe, jsonKey) => {
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return;
    let slot = slotFromRecipeMealType(recipe) || slotFromJsonKey(jsonKey);
    if (!slot) {
      const firstGap = MEAL_TYPES.find((mt) => out[mt].length === 0);
      slot = firstGap || 'Breakfast';
    }
    out[slot].push(recipe);
  };

  if (Array.isArray(container)) {
    container.forEach((r) => assign(r, null));
  } else {
    for (const [key, val] of Object.entries(container)) {
      if (!Array.isArray(val)) continue;
      val.forEach((r) => assign(r, key));
    }
  }

  return out;
}

function emptyMealSlots(mealGroups) {
  if (!mealGroups) return MEAL_TYPES.slice();
  return MEAL_TYPES.filter(
    (mt) => !Array.isArray(mealGroups[mt]) || mealGroups[mt].length === 0
  );
}

async function repairEmptyMealSlots(messages, content, mealGroups, chatJsonFn) {
  let m = messages;
  let c = content;
  let mg = mealGroups;
  for (let rep = 0; rep < 1; rep++) {
    const missing = emptyMealSlots(mg);
    if (missing.length === 0) break;
    if (!mg || MEAL_TYPES.every((mt) => !(mg[mt] && mg[mt].length))) {
      break;
    }
    m = [
      ...m,
      { role: 'assistant', content: c },
      {
        role: 'user',
        content:
          `Your JSON had no recipes in these slots: ${missing.join(', ')}. ` +
          `Reply with ONLY valid JSON using the same shape with top-level "mealGroups". ` +
          `Keys must be exactly Breakfast, Lunch, Snacks, and Dinner (each an array with at least one recipe).`,
      },
    ];
    c = await chatJsonFn(m, 0.45);
    const p = safeParseJson(c);
    mg = normalizeGroups(p);
    if (!mg) break;
  }
  return { messages: m, content: c, mealGroups: mg };
}

function parseRecipeEstimatedCost(recipe) {
  return (
    Number(
      String(recipe['Estimated Cost (?)'] ?? recipe.cost ?? '0').replace(
        /[^0-9.]/g,
        ''
      )
    ) || 0
  );
}

function sumMealPlanEstimatedTotal(mealGroups) {
  let total = 0;
  for (const mt of MEAL_TYPES) {
    for (const r of mealGroups[mt] || []) {
      total += parseRecipeEstimatedCost(r);
    }
  }
  return total;
}

function canonicalRecipeFields(m) {
  if (!m || typeof m !== 'object') return m;
  const name =
    m['Recipe name'] ??
    m.recipe_name ??
    m.recipeName ??
    m.name ??
    m.title ??
    'Recipe';
  const mealType = m['Meal Type'] ?? m.mealType ?? m['meal type'];
  const cal = m['Calories (kcal)'] ?? m.calories ?? m.Calories;
  const protein = m['Protein (g)'] ?? m.protein;
  const fats = m['Fats (g)'] ?? m.fats ?? m['Fat (g)'];
  const ingredients = m.Ingredients ?? m.ingredients;
  const instructions = m.Instructions ?? m.instructions;
  const est = m['Estimated Cost (?)'] ?? m.estimated_cost ?? m.cost;
  return {
    ...m,
    'Recipe name': name,
    ...(mealType != null ? { 'Meal Type': mealType } : {}),
    ...(cal != null ? { 'Calories (kcal)': cal } : {}),
    ...(protein != null ? { 'Protein (g)': protein } : {}),
    ...(fats != null ? { 'Fats (g)': fats } : {}),
    ...(ingredients != null ? { Ingredients: ingredients } : {}),
    ...(instructions != null ? { Instructions: instructions } : {}),
    ...(est != null ? { 'Estimated Cost (?)': est } : {}),
  };
}

function attachCostField(mealGroups) {
  const withCost = { ...mealGroups };
  for (const mt of MEAL_TYPES) {
    withCost[mt] = (withCost[mt] || []).map((m) => ({
      ...canonicalRecipeFields(m),
      cost: parseRecipeEstimatedCost(m),
    }));
  }
  return withCost;
}

function fallbackMealTemplate(preference, mt) {
  const veg = {
    Breakfast: 'Vegetable Poha with Peanuts',
    Lunch: 'Dal Khichdi with Curd',
    Snacks: 'Roasted Chana Chaat',
    Dinner: 'Paneer Bhurji with Roti',
  };
  const nonVeg = {
    Breakfast: 'Egg Bhurji with Toast',
    Lunch: 'Chicken Curry with Rice',
    Snacks: 'Boiled Eggs and Fruit',
    Dinner: 'Fish Curry with Roti',
  };
  return preference === 'non-veg' ? nonVeg[mt] : veg[mt];
}

function fallbackServingCost(preference, mt) {
  if (preference === 'non-veg') {
    return {
      Breakfast: 85, // Egg bhurji + toast
      Lunch: 180, // Chicken curry + rice
      Snacks: 95, // Eggs + fruit
      Dinner: 170, // Fish curry + roti
    }[mt];
  }
  return {
    Breakfast: 70, // Vegetable poha
    Lunch: 120, // Dal khichdi + curd
    Snacks: 55, // Roasted chana chaat
    Dinner: 140, // Paneer bhurji + roti
  }[mt];
}

function buildFallbackMealGroups({ calories, budget, preference }) {
  const out = { Breakfast: [], Lunch: [], Snacks: [], Dinner: [] };
  for (const mt of MEAL_TYPES) {
    const slotCal = Math.round(calories * DISTRIBUTION[mt]);
    // Use realistic single-serving fallback estimates, capped by daily budget context.
    const baseServingCost = fallbackServingCost(preference, mt);
    const budgetCapPerMeal = Math.max(
      30,
      Math.round((Number(budget) || 0) * 0.4)
    );
    const slotBudget = Math.min(baseServingCost, budgetCapPerMeal);
    const dish = fallbackMealTemplate(preference, mt);
    out[mt].push({
      'Recipe name': dish,
      'Meal Type': mt,
      'Calories (kcal)': String(slotCal),
      'Protein (g)': String(Math.max(8, Math.round((slotCal * 0.12) / 4))),
      'Fats (g)': String(Math.max(6, Math.round((slotCal * 0.22) / 9))),
      Ingredients:
        preference === 'non-veg'
          ? 'onion, tomato, ginger garlic, oil, salt, spices, main protein'
          : 'onion, tomato, ginger, garlic, oil, salt, spices, main ingredients',
      Instructions:
        '1. Prep ingredients. 2. Cook with basic spices until done. 3. Adjust salt and serve hot.',
      'Estimated Cost (?)': String(slotBudget),
    });
  }
  return out;
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

async function chatJson(messages, temperature) {
  const cfg = providerConfig();
  if (!cfg) {
    throw new Error('NO_AI_PROVIDER');
  }

  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000;
  try {
    const resp = await axios.post(
      `${cfg.base}/api/chat`,
      {
        model: cfg.model,
        messages,
        stream: false,
        format: 'json',
        options: { temperature, num_ctx: 4096, num_predict: 800 },
      },
      {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const body = resp.data;
    const content = body?.message?.content;
    if (!content) {
      throw new Error('AI_MEAL_PLAN_EMPTY');
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
        'Ollama error:',
        e.response?.status,
        e.response?.data || e.message
      );
      throw new Error('OLLAMA_HTTP');
    }
    throw e;
  }
}

function createBoundedModelCaller(maxCalls) {
  let used = 0;
  return {
    getUsed: () => used,
    call: async (messages, temperature) => {
      if (used >= maxCalls) {
        throw toApiError(
          502,
          'AI_RETRY_LIMIT',
          'Meal generation reached retry limit. Please try "Different Option".'
        );
      }
      used += 1;
      return chatJson(messages, temperature);
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res
      .status(405)
      .json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  if (!providerConfig()) {
    return res.status(503).json({
      error: 'No AI provider configured. Set OLLAMA_MODEL for local Ollama.',
      code: 'NO_AI_PROVIDER',
    });
  }

  const {
    name,
    age,
    height,
    weight,
    sex,
    dietGoal,
    preference,
    excludeRecipeNames,
    budget,
    calories,
    macros,
    variationSeed,
  } = req.body || {};

  const b = Number(budget);
  const c = Number(calories);
  if (!b || b <= 0 || !c || c <= 0 || !dietGoal || !macros) {
    return res.status(400).json({
      error: 'Invalid body: need budget, calories, dietGoal, macros',
      code: 'INVALID_BODY',
    });
  }

  const variationNote =
    variationSeed != null
      ? `use variation id ${variationSeed} for diversity.`
      : '';
  const profileSignature = profileSignatureFromBody(req.body || {});
  const excludedFromClient = Array.isArray(excludeRecipeNames)
    ? excludeRecipeNames
    : [];
  const excludeNamesSet = new Set(
    excludedFromClient.map(normalizeNameForMatch)
  );
  const clientExcludeSet = new Set(
    excludedFromClient.map(normalizeNameForMatch)
  );

  let mongoCtx = null;
  let storedPlans = [];
  let storedPlanHashes = new Set();
  try {
    mongoCtx = await getMealPlanCollection();
    if (mongoCtx?.collection) {
      storedPlans = await listStoredPlans(
        mongoCtx.collection,
        profileSignature,
        b
      );
      storedPlanHashes = new Set(
        storedPlans.map((p) => String(p.planHash || '')).filter(Boolean)
      );
      const chosenStored = chooseStoredPlan(storedPlans, clientExcludeSet);
      if (chosenStored) {
        return res.status(200).json({
          mealGroups: attachCostField(chosenStored.mealGroups),
          meta: {
            fromStored: true,
            planHash: chosenStored.planHash,
            createdAt: chosenStored.createdAt,
          },
        });
      }
      const allStoredNames = storedPlans.flatMap((p) => p.recipeNames || []);
      allStoredNames.forEach((n) =>
        excludeNamesSet.add(normalizeNameForMatch(n))
      );
    }
  } catch (e) {
    console.warn('meal-plan mongo read failed:', e?.message || String(e));
  }

  const prompt = buildPrompt({
    name,
    age,
    height,
    weight,
    sex,
    dietGoal,
    preference,
    excludeRecipeNames: [...excludeNamesSet],
    budget: b,
    calories: c,
    macros,
    variationNote,
  });

  const systemContent =
    'You output only valid JSON objects for meal plans. No markdown, no commentary. ' +
    'Every recipe must include "Estimated Cost (?)". The sum of those values across all recipes in all meal slots must never exceed the user maximum daily food budget given in the user message (in rupees).';

  try {
    const maxModelCalls =
      Number(process.env.AI_MEALPLAN_MAX_MODEL_CALLS) ||
      DEFAULT_MAX_MODEL_CALLS;
    const modelCaller = createBoundedModelCaller(maxModelCalls);
    let messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt },
    ];

    let content = await modelCaller.call(messages, 0.75);
    let parsed;
    try {
      parsed = safeParseJson(content);
    } catch (e) {
      if (e?.message === 'AI_JSON_PARSE') {
        // Ask the model to regenerate clean JSON (common when output is truncated).
        messages = [
          ...messages,
          { role: 'assistant', content },
          {
            role: 'user',
            content:
              'Your last response was not valid JSON (it was cut off or contained extra text). ' +
              'Regenerate the FULL meal plan as ONLY valid JSON in the exact required schema. No markdown.',
          },
        ];
        content = await modelCaller.call(messages, 0.35);
        parsed = safeParseJson(content);
      } else {
        throw e;
      }
    }
    if (parsed?.noMoreRecipes) {
      throw toApiError(
        409,
        'NO_MORE_RECIPES_BUDGET',
        'No more recipes available within the given budget constraints. Would you like to select from the previously provided options?'
      );
    }
    let mealGroups = normalizeGroups(parsed);

    if (!mealGroups || MEAL_TYPES.every((mt) => !mealGroups[mt]?.length)) {
      messages = [
        ...messages,
        { role: 'assistant', content },
        {
          role: 'user',
          content:
            'Your previous output did not match the required structure. ' +
            'Regenerate the FULL meal plan as ONLY valid JSON with top-level "mealGroups" object ' +
            'and exactly these keys: Breakfast, Lunch, Snacks, Dinner. ' +
            'Each key must contain at least one recipe object.',
        },
      ];
      content = await modelCaller.call(messages, 0.3);
      parsed = safeParseJson(content);
      mealGroups = normalizeGroups(parsed);
      if (!mealGroups || MEAL_TYPES.every((mt) => !mealGroups[mt]?.length)) {
        throw toApiError(
          502,
          'INVALID_MEAL_PLAN',
          'Invalid meal plan structure from AI'
        );
      }
    }

    ({ messages, content, mealGroups } = await repairEmptyMealSlots(
      messages,
      content,
      mealGroups,
      modelCaller.call
    ));
    if (!mealGroups || MEAL_TYPES.every((mt) => !mealGroups[mt]?.length)) {
      throw toApiError(
        502,
        'INVALID_MEAL_PLAN',
        'Invalid meal plan structure from AI (slot repair)'
      );
    }
    let stillMissing = emptyMealSlots(mealGroups);
    if (stillMissing.length > 0) {
      // Final recovery: ask for a complete regeneration before failing hard.
      messages = [
        ...messages,
        { role: 'assistant', content },
        {
          role: 'user',
          content:
            `You still left these required slots empty: ${stillMissing.join(
              ', '
            )}. ` +
            `Regenerate the FULL meal plan now. Return ONLY valid JSON with top-level "mealGroups", ` +
            `and include at least 1 recipe in each of Breakfast, Lunch, Snacks, and Dinner.`,
        },
      ];
      content = await modelCaller.call(messages, 0.3);
      parsed = safeParseJson(content);
      mealGroups = normalizeGroups(parsed);
      if (!mealGroups || MEAL_TYPES.every((mt) => !mealGroups[mt]?.length)) {
        throw toApiError(
          502,
          'INVALID_MEAL_PLAN',
          'Invalid meal plan structure from AI (full regeneration)'
        );
      }
      ({ messages, content, mealGroups } = await repairEmptyMealSlots(
        messages,
        content,
        mealGroups,
        modelCaller.call
      ));
      stillMissing = emptyMealSlots(mealGroups);
      if (stillMissing.length > 0) {
        throw toApiError(
          502,
          'MEAL_SLOTS_MISSING',
          `The AI did not return meals for: ${stillMissing.join(
            ', '
          )}. Try "Different Option" or a larger model.`
        );
      }
    }

    let estimatedTotal = sumMealPlanEstimatedTotal(mealGroups);
    if (estimatedTotal > b) {
      messages = [
        ...messages,
        { role: 'assistant', content },
        {
          role: 'user',
          content:
            `The sum of all "Estimated Cost (?)" in your JSON is ?${estimatedTotal.toFixed(
              0
            )}, which is above this user's maximum daily food budget of ?${b}. ` +
            `Regenerate the full meal plan JSON with the same schema and rules, but ensure the sum of every recipe's "Estimated Cost (?)" is less than or equal to ?${b}. ` +
            `Adjust recipes to cheaper options if needed; keep calorie targets per slot satisfied. ` +
            `Every slot Breakfast, Lunch, Snacks, Dinner must still have at least one recipe.`,
        },
      ];
      content = await modelCaller.call(messages, 0.35);
      parsed = safeParseJson(content);
      mealGroups = normalizeGroups(parsed);
      if (!mealGroups || MEAL_TYPES.every((mt) => !mealGroups[mt]?.length)) {
        throw toApiError(
          502,
          'INVALID_MEAL_PLAN',
          'Invalid meal plan structure from AI (retry)'
        );
      }
      ({ messages, content, mealGroups } = await repairEmptyMealSlots(
        messages,
        content,
        mealGroups,
        modelCaller.call
      ));
      if (!mealGroups || MEAL_TYPES.every((mt) => !mealGroups[mt]?.length)) {
        throw toApiError(
          502,
          'INVALID_MEAL_PLAN',
          'Invalid meal plan structure from AI (budget + slot repair)'
        );
      }
      stillMissing = emptyMealSlots(mealGroups);
      if (stillMissing.length > 0) {
        throw toApiError(
          502,
          'MEAL_SLOTS_MISSING',
          `After budget fix the AI still omitted: ${stillMissing.join(
            ', '
          )}. Try again or raise the budget slightly.`
        );
      }
      estimatedTotal = sumMealPlanEstimatedTotal(mealGroups);
      if (estimatedTotal > b) {
        throw toApiError(
          502,
          'BUDGET_NOT_SATISFIED',
          `AI could not produce a plan within ?${b} estimated total (got ?${Math.round(
            estimatedTotal
          )}). Try a higher budget or generate again.`
        );
      }
    }

    const withCost = attachCostField(mealGroups);
    const planHash = planHashFromMealGroups(withCost);
    if (storedPlanHashes.has(planHash)) {
      throw toApiError(
        409,
        'DUPLICATE_PLAN',
        'This plan already exists for the same profile. Please generate another option.'
      );
    }

    if (mongoCtx?.collection) {
      try {
        await mongoCtx.collection.updateOne(
          { profileSignature, planHash },
          {
            $setOnInsert: {
              profileSignature,
              planHash,
              mealGroups: withCost,
              recipeNames: collectRecipeNames(withCost),
              preference: String(preference || ''),
              dietGoal: String(dietGoal || ''),
              sex: String(sex || ''),
              budget: b,
              totalEstimatedCost: estimatedTotal,
              requestedBudget: b,
              calories: c,
              macros,
              source:
                variationSeed != null ? 'generated-variation' : 'generated',
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );
      } catch (e) {
        console.warn('meal-plan mongo save failed:', e?.message || String(e));
      }
    }

    // Price refresh is helpful but must never block the meal-plan response.
    try {
      const names = collectIngredientsFromMealGroups(withCost);
      void refreshIngredientsViaBackend(names).catch((e) => {
        console.warn(
          'ai-meal-plan ingredient refresh:',
          e?.message || String(e)
        );
      });
    } catch (e) {
      console.warn('ai-meal-plan ingredient refresh:', e?.message || String(e));
    }

    return res.status(200).json({
      mealGroups: withCost,
      meta: {
        modelCallsUsed: modelCaller.getUsed(),
        modelCallsMax: maxModelCalls,
        planHash,
      },
    });
  } catch (e) {
    console.error('ai-meal-plan:', e);
    if (e.message === 'NO_AI_PROVIDER') {
      return res.status(503).json({
        error: 'No AI provider configured. Set OLLAMA_MODEL for local Ollama.',
        code: 'NO_AI_PROVIDER',
      });
    }

    const fallbackCodes = new Set([
      'AI_RETRY_LIMIT',
      'INVALID_MEAL_PLAN',
      'MEAL_SLOTS_MISSING',
      'BUDGET_NOT_SATISFIED',
      'OLLAMA_HTTP',
      'OLLAMA_TIMEOUT',
      'AI_MEAL_PLAN_EMPTY',
      'AI_JSON_PARSE',
      'AI_EMPTY_RESPONSE',
    ]);
    const code = e.code || e.message;
    const shouldFallback =
      e?.name === 'AbortError' ||
      (code !== 'NO_MORE_RECIPES_BUDGET' && fallbackCodes.has(code || ''));
    if (shouldFallback) {
      const fallback = attachCostField(
        buildFallbackMealGroups({ calories: c, budget: b, preference })
      );
      const fallbackHash = planHashFromMealGroups(fallback);
      if (mongoCtx?.collection) {
        try {
          await mongoCtx.collection.updateOne(
            { profileSignature, planHash: fallbackHash },
            {
              $setOnInsert: {
                profileSignature,
                planHash: fallbackHash,
                mealGroups: fallback,
                recipeNames: collectRecipeNames(fallback),
                preference: String(preference || ''),
                dietGoal: String(dietGoal || ''),
                sex: String(sex || ''),
                budget: b,
                totalEstimatedCost: sumMealPlanEstimatedTotal(fallback),
                requestedBudget: b,
                calories: c,
                macros,
                source: 'fallback',
                createdAt: new Date(),
              },
            },
            { upsert: true }
          );
        } catch (saveErr) {
          console.warn(
            'meal-plan mongo fallback save failed:',
            saveErr?.message || String(saveErr)
          );
        }
      }
      return res.status(200).json({
        mealGroups: fallback,
        meta: {
          fallback: true,
          reason: code || 'fallback',
          planHash: fallbackHash,
        },
      });
    }

    if (e.status && e.code) {
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    if (
      e?.name === 'AbortError' ||
      String(e?.message || '').includes('aborted') ||
      e.message === 'OLLAMA_TIMEOUT'
    ) {
      return res.status(504).json({
        error:
          'Meal plan generation timed out. Try again, or switch to a faster/smaller model.',
        code: 'OLLAMA_TIMEOUT',
      });
    }
    if (e.message === 'OLLAMA_HTTP') {
      return res.status(502).json({
        error:
          'Ollama request failed. Make sure Ollama is running and OLLAMA_MODEL is downloaded.',
        code: 'OLLAMA_HTTP',
      });
    }
    if (e.message === 'AI_MEAL_PLAN_EMPTY') {
      return res
        .status(502)
        .json({ error: 'Empty AI response', code: 'AI_EMPTY_RESPONSE' });
    }
    if (e.message === 'AI_JSON_PARSE') {
      return res.status(502).json({
        error:
          'AI returned invalid JSON. Click "Different Option" again (or try once more).',
        code: 'AI_JSON_PARSE',
      });
    }
    return res
      .status(500)
      .json({ error: e.message || 'Server error', code: 'INTERNAL_ERROR' });
  } finally {
    if (mongoCtx?.client) {
      try {
        await mongoCtx.client.close();
      } catch (e) {
        // ignore close errors
      }
    }
  }
}
