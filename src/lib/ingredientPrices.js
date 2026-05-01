/**
 * Ingredient parsing + backend price refresh (Express + Python scraper).
 */

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Snacks', 'Dinner'];

export function normalizeIngredientName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function parseIngredientsString(ingredientsStr) {
  if (!ingredientsStr || typeof ingredientsStr !== 'string') return [];
  return ingredientsStr
    .split(',')
    .map((i) => i.replace(/['"]+/g, '').trim())
    .filter(Boolean)
    .map(normalizeIngredientName)
    .filter(Boolean);
}

export function collectIngredientsFromMealGroups(mealGroups) {
  const set = new Set();
  for (const mt of MEAL_TYPES) {
    const recipes = mealGroups[mt] || [];
    for (const recipe of recipes) {
      parseIngredientsString(recipe.Ingredients).forEach((x) => set.add(x));
    }
  }
  return [...set];
}

export function getPriceMaxAgeMs() {
  return (Number(process.env.PRICE_MAX_AGE_MINUTES) || 30) * 60 * 1000;
}

/**
 * Returns ingredient names that are missing in Mongo or older than PRICE_MAX_AGE_MINUTES.
 */
export async function listStaleIngredientNames(collection, normalizedNames) {
  const maxAge = getPriceMaxAgeMs();
  const stale = [];
  for (const name of normalizedNames) {
    const doc = await collection.findOne({ name });
    if (!doc || !Array.isArray(doc.prices) || doc.prices.length === 0) {
      stale.push(name);
      continue;
    }
    const ts = doc.lastScrapedAt ? new Date(doc.lastScrapedAt).getTime() : 0;
    if (!ts || Date.now() - ts > maxAge) {
      stale.push(name);
    }
  }
  return stale;
}

/**
 * Calls Express backend to run Python scraper and upsert MongoDB Ingredients.
 */
export async function refreshIngredientsViaBackend(
  ingredientNames,
  { force = false } = {}
) {
  if (!ingredientNames?.length) {
    return { ok: true, results: [] };
  }

  const base = (process.env.BACKEND_URL || 'http://127.0.0.1:5000').replace(
    /\/$/,
    ''
  );
  const controller = new AbortController();
  const timeoutMs = Number(process.env.BACKEND_REFRESH_TIMEOUT_MS) || 8000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}/refresh-ingredient-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredients: ingredientNames, force }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('refresh-ingredient-prices:', data.error || res.status);
      return {
        ok: false,
        error: data.error || String(res.status),
        results: data.results,
      };
    }
    return data;
  } catch (e) {
    const msg =
      e?.name === 'AbortError'
        ? `timeout after ${timeoutMs}ms`
        : e?.message || String(e);
    console.warn('refreshIngredientsViaBackend failed:', msg);
    return { ok: false, error: msg, results: [] };
  } finally {
    clearTimeout(t);
  }
}
