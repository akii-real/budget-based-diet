// pages/recipe.tsx

import { useState, useEffect } from 'react';

import { useRouter } from 'next/router';

interface Recipe {
  [key: string]: string;
}

interface PlatformPrices {
  Blinkit: number;
  Zepto: number;
  Instamart: number;
}

function findRecipeInStoredPlan(name: string): Recipe | null {
  if (typeof window === 'undefined' || !name) return null;
  try {
    const raw = localStorage.getItem('mealPlan');
    if (!raw) return null;
    const plan = JSON.parse(raw) as Record<string, Recipe[]>;
    const all = Object.values(plan).flat();
    const found = all.find(
      (m) => m['Recipe name']?.toLowerCase() === name.toLowerCase()
    );
    return found && found.Ingredients ? found : null;
  } catch {
    return null;
  }
}

const RecipePage = () => {
  const router = useRouter();
  const { name, mealType } = router.query;
  const nameStr =
    typeof name === 'string' ? name : Array.isArray(name) ? name[0] : '';
  const mealTypeStr =
    typeof mealType === 'string'
      ? mealType
      : Array.isArray(mealType)
      ? mealType[0]
      : '';

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [platformPrices, setPlatformPrices] = useState<PlatformPrices | null>(
    null
  );
  const [lowestPrice, setLowestPrice] = useState<string>('');
  const [priceComparison, setPriceComparison] = useState<{
    [key: string]: string;
  } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const aiEstimatedCost = recipe?.['Estimated Cost (?)'] || '';

  useEffect(() => {
    if (!nameStr) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      const stored = findRecipeInStoredPlan(nameStr);

      try {
        if (stored) {
          const response = await fetch('/api/recipe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipe: stored }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (cancelled) return;
          setRecipe(data.recipe);
          setPlatformPrices(data.platformPrices);
        } else {
          const params = new URLSearchParams({ name: nameStr });
          if (mealTypeStr) params.set('mealType', mealTypeStr);
          const response = await fetch(`/api/recipe?${params.toString()}`);
          if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            if (!cancelled) {
              setError(
                typeof errBody.error === 'string'
                  ? errBody.error
                  : 'Could not load this recipe from AI. Check your API key and try again.'
              );
            }
            return;
          }
          const data = await response.json();
          if (cancelled) return;
          setRecipe(data.recipe);
          setPlatformPrices(data.platformPrices);
        }
      } catch (e) {
        console.error('Error fetching recipe data:', e);
        if (!cancelled) setError('Failed to load recipe details.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nameStr, mealTypeStr]);

  useEffect(() => {
    if (platformPrices) {
      const priceValues = Object.values(platformPrices);
      const minPrice = Math.min(...priceValues);
      setLowestPrice(`₹${minPrice.toFixed(2)}`);

      const comparison: { [key: string]: string } = {};
      Object.keys(platformPrices).forEach((platform) => {
        comparison[platform] = `₹${platformPrices[
          platform as keyof PlatformPrices
        ].toFixed(2)}`;
      });

      setPriceComparison(comparison);
    }
  }, [platformPrices]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-cover bg-center">
        <p className="text-lg text-white bg-black bg-opacity-50 px-4 py-2 rounded">
          Loading recipe details...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-cover bg-center">
        <p className="text-lg text-white bg-black bg-opacity-50 px-4 py-2 rounded max-w-lg text-center">
          {error}
        </p>
      </div>
    );
  }

  if (!recipe) {
    return null;
  }

  return (
    <div
      className="min-h-screen bg-cover bg-center p-10"
      style={{ backgroundImage: `url('/assets/images/image.jpg')` }}
    >
      <div className="max-w-3xl mx-auto bg-white bg-opacity-90 backdrop-blur-md rounded-lg shadow-lg p-8">
        <h1 className="text-3xl font-bold text-red-600 mb-4">
          {recipe['Recipe name'] || 'Unnamed Recipe'}
        </h1>

        <div className="text-gray-800 space-y-3">
          <p>
            <strong>Meal Type:</strong> {recipe['Meal Type'] || 'N/A'}
          </p>
          <p>
            <strong>Calories:</strong> {recipe['Calories (kcal)'] || 'N/A'} kcal
          </p>
          <p>
            <strong>Protein:</strong> {recipe['Protein (g)'] || 'N/A'} g
          </p>
          <p>
            <strong>Fats:</strong> {recipe['Fats (g)'] || 'N/A'} g
          </p>

          {(priceComparison || aiEstimatedCost) && (
            <div className="mt-6">
              <h2 className="text-xl font-semibold text-black mb-2">
                Estimated Cost:
              </h2>
              {aiEstimatedCost && (
                <p className="text-base text-gray-800">
                  <strong>AI Predicted Cost:</strong> ₹
                  {Number(
                    String(aiEstimatedCost).replace(/[^0-9.]/g, '') || 0
                  ).toFixed(2)}
                </p>
              )}
              <p className="text-lg font-semibold text-green-700">
                Lowest Price: {lowestPrice}
              </p>

              <div className="mt-2">
                <h3 className="font-semibold">Price Comparison:</h3>
                <ul className="space-y-1">
                  {Object.keys(priceComparison || {}).map((platform) => (
                    <li key={platform}>
                      <strong>{platform}: </strong>
                      {priceComparison?.[platform]}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {recipe.Ingredients && (
            <div>
              <h2 className="text-xl font-semibold mt-6 mb-2 text-black">
                Ingredients:
              </h2>
              {recipe['Ingredient Quantities'] && (
                <p className="text-sm text-gray-700 mb-2">
                  <strong>Required Quantities:</strong>{' '}
                  {recipe['Ingredient Quantities']}
                </p>
              )}
              <ul className="list-disc list-inside space-y-1">
                {recipe.Ingredients.split(',').map((ingredient, index) => (
                  <li key={index}>{ingredient.trim()}</li>
                ))}
              </ul>
            </div>
          )}

          {recipe.Instructions && (
            <div>
              <h2 className="text-xl font-semibold mt-6 mb-2 text-black">
                Instructions:
              </h2>
              <p className="whitespace-pre-line">{recipe.Instructions}</p>
            </div>
          )}
        </div>

        <button
          onClick={() => router.back()}
          className="mt-6 bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
        >
          Back to Plan
        </button>
      </div>
    </div>
  );
};

export default RecipePage;
