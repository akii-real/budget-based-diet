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

const RecipePage = () => {
  const router = useRouter();
  const { name } = router.query;

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

  useEffect(() => {
    if (typeof name === 'string' && name.length > 0) {
      console.log('Fetching recipe for name:', name);
      fetch(`/api/recipe?name=${encodeURIComponent(name)}`)
        .then((response) => {
          if (!response.ok)
            throw new Error(`HTTP error! Status: ${response.status}`);
          return response.json();
        })
        .then((data) => {
          setRecipe(data.recipe);
          setPlatformPrices(data.platformPrices);
          setError(null);
        })
        .catch((error) => {
          console.error('Error fetching recipe data:', error);
          setError('Failed to load recipe details.');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [name]);

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
        <p className="text-lg text-white bg-black bg-opacity-50 px-4 py-2 rounded">
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

          {priceComparison && (
            <div className="mt-6">
              <h2 className="text-xl font-semibold text-black mb-2">
                Estimated Cost:
              </h2>
              <p className="text-lg font-semibold text-green-700">
                Lowest Price: {lowestPrice}
              </p>

              <div className="mt-2">
                <h3 className="font-semibold">Price Comparison:</h3>
                <ul className="space-y-1">
                  {Object.keys(priceComparison).map((platform) => (
                    <li key={platform}>
                      <strong>{platform}: </strong>
                      {priceComparison[platform]}
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
