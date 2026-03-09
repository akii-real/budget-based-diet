import { MongoClient } from 'mongodb';
import path from 'path';
import { promises as fs } from 'fs';

async function getMongoCollection() {
  const user = process.env.MONGO_DB_USERNAME;
  const pw = process.env.MONGO_DB_PASSWORD;
  const url = process.env.MONGO_DB_URL;
  const DATABASE = "dietprices";
  const COLLECTION = "Ingredients";

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

async function loadRecipes() {
  const filePath = path.join(process.cwd(), 'public', 'data', 'meal_plan.csv');
  let content;

  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Error reading CSV file: ${error.message}`);
  }

  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim());

  const recipes = lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const recipe = {};
    headers.forEach((header, idx) => {
      recipe[header] = values[idx] || '';
    });
    return recipe;
  });

  return recipes;
}

export default async function handler(req, res) {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Recipe name is required' });
    }

    const recipes = await loadRecipes();
    console.log('Loaded recipes:', recipes.map((r) => r['Recipe name'])); // Log only names for easy check

    const recipe = recipes.find(
      (r) => r['Recipe name']?.toLowerCase() === name.toLowerCase()
    );

    if (!recipe) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    const collection = await getMongoCollection();

    // Ingredients cleaning: remove extra quotes
    const recipeIngredients = recipe.Ingredients?.split(',').map((i) => i.replace(/['"]+/g, '').trim().toLowerCase()) || [];

    let totalPrices = { Blinkit: 0, Zepto: 0, Instamart: 0 };

    for (const ingredient of recipeIngredients) {
      if (!ingredient) continue;

      // Fuzzy match using regex, but add a fallback for strict matching
      const ingredientData = await collection.findOne({
        name: { $regex: ingredient, $options: 'i' },
      });

      if (ingredientData) {
        const blinkitPrice = ingredientData.prices.find((p) => p.platform === 'Blinkit')?.price_per_kg || 0;
        const zeptoPrice = ingredientData.prices.find((p) => p.platform === 'Zepto')?.price_per_kg || 0;
        const instamartPrice = ingredientData.prices.find((p) => p.platform === 'Instamart')?.price_per_kg || 0;

        totalPrices.Blinkit += blinkitPrice;
        totalPrices.Zepto += zeptoPrice;
        totalPrices.Instamart += instamartPrice;
      } else {
        console.warn(`No matching ingredient found in DB for: ${ingredient}`);
      }
    }

    res.status(200).json({ recipe, platformPrices: totalPrices });
  } catch (error) {
    console.error('Error in /api/recipe:', error);
    res.status(500).json({ error: error.message || 'Error fetching data' });
  }
}
