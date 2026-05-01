const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const mongoose = require('mongoose');
require('dotenv').config();

/** `live` → scrapers/scraper.py | `simulate` → scrapers/simulate_prices.py (same --single JSON) */
const PRICE_DATA_SOURCE = (
  process.env.PRICE_DATA_SOURCE || 'simulate'
).toLowerCase();
const INGREDIENT_PRICE_SCRIPT =
  PRICE_DATA_SOURCE === 'simulate' ? 'simulate_prices.py' : 'scraper.py';

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

function normalizeIngredientName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const ingredientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    prices: [
      {
        platform: { type: String },
        price_per_kg: { type: Number },
      },
    ],
    lastScrapedAt: { type: Date, default: Date.now },
    scrapeMode: { type: String },
  },
  { collection: 'Ingredients' }
);
ingredientSchema.index({ lastScrapedAt: 1 }, { expireAfterSeconds: 30 * 60 });

const Ingredient = mongoose.model('Ingredient', ingredientSchema);

async function connectDB() {
  const username = process.env.MONGO_DB_USERNAME;
  const password = process.env.MONGO_DB_PASSWORD;
  const url = process.env.MONGO_DB_URL;
  const database = 'dietprices';

  if (!username || !password || !url) {
    console.error('❌ MongoDB credentials are missing in .env file!');
    process.exit(1);
  }

  try {
    await mongoose.connect(
      `mongodb+srv://${username}:${password}@${url}/${database}?retryWrites=true&w=majority`
    );
    await Ingredient.collection.createIndex(
      { lastScrapedAt: 1 },
      { expireAfterSeconds: 30 * 60 }
    );
    console.log('✅ MongoDB connection is successful');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
}

connectDB();

function runPythonSingleIngredient(ingredientRaw) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'scrapers', INGREDIENT_PRICE_SCRIPT);
    const py = spawn('python', [script, '--single', ingredientRaw], {
      cwd: __dirname,
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    py.stdout.on('data', (d) => {
      out += d.toString();
    });
    py.stderr.on('data', (d) => {
      err += d.toString();
    });
    py.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(err || `Python exited with ${code}`));
      }
      try {
        const doc = JSON.parse(out.trim());
        if (doc.error) {
          return reject(new Error(doc.error));
        }
        resolve(doc);
      } catch (e) {
        reject(new Error(`Invalid JSON from scraper: ${out.slice(0, 200)}`));
      }
    });
  });
}

function getMaxAgeMs() {
  return (Number(process.env.PRICE_MAX_AGE_MINUTES) || 30) * 60 * 1000;
}

// ✅ Correct Excel file path
const FILE_PATH = 'D:/Projects/Diet Maker/backend/Userinfo.xlsx';

const appendToExcel = (newData) => {
  let workbook;
  let worksheet;
  let existingData = [];

  if (fs.existsSync(FILE_PATH)) {
    workbook = XLSX.readFile(FILE_PATH);
    if (workbook.Sheets.Userinfo) {
      worksheet = workbook.Sheets.Userinfo;
      existingData = XLSX.utils.sheet_to_json(worksheet);
    } else {
      worksheet = XLSX.utils.json_to_sheet([]);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Userinfo');
    }
  } else {
    const dir = FILE_PATH.substring(0, FILE_PATH.lastIndexOf('/'));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    workbook = XLSX.utils.book_new();
    worksheet = XLSX.utils.json_to_sheet([]);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Userinfo');
  }

  existingData.push(newData);
  const updatedWorksheet = XLSX.utils.json_to_sheet(existingData);
  workbook.Sheets.Userinfo = updatedWorksheet;

  XLSX.writeFile(workbook, FILE_PATH);
};

app.post('/save-data', (req, res) => {
  try {
    appendToExcel(req.body);
    res.status(200).json({ message: 'Data saved successfully!' });
  } catch (error) {
    console.error('Error writing to Excel:', error);
    res.status(500).json({ message: 'Error saving data' });
  }
});

/**
 * Run Python scraper per ingredient, upsert Blinkit/Zepto/Instamart prices in MongoDB.
 * Skips ingredients that were scraped recently unless force=true.
 */
app.post('/refresh-ingredient-prices', async (req, res) => {
  const { ingredients, force } = req.body || {};
  if (!Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'ingredients array is required' });
  }

  const unique = [
    ...new Set(ingredients.map(normalizeIngredientName).filter(Boolean)),
  ];
  const maxAgeMs = getMaxAgeMs();
  const results = [];

  for (const name of unique) {
    try {
      if (!force) {
        const existing = await Ingredient.findOne({ name });
        const ts = existing?.lastScrapedAt
          ? new Date(existing.lastScrapedAt).getTime()
          : 0;
        if (
          existing &&
          Array.isArray(existing.prices) &&
          existing.prices.length > 0 &&
          ts &&
          Date.now() - ts < maxAgeMs
        ) {
          results.push({ name, skipped: true, reason: 'fresh' });
          continue;
        }
      }

      const doc = await runPythonSingleIngredient(name);
      const { scrapeMode, ...mongoPayload } = doc;
      await Ingredient.updateOne(
        { name: doc.name },
        {
          $set: {
            ...mongoPayload,
            lastScrapedAt: new Date(),
          },
        },
        { upsert: true }
      );
      results.push({ name: doc.name, updated: true });
    } catch (e) {
      console.error(`refresh ${name}:`, e.message);
      results.push({ name, error: e.message });
    }
  }

  res.status(200).json({ ok: true, results });
});

/** @deprecated Prefer POST /refresh-ingredient-prices */
app.post('/scrape', async (req, res) => {
  const { ingredient } = req.body || {};
  if (!ingredient) {
    return res.status(400).json({ error: 'ingredient is required' });
  }
  try {
    const doc = await runPythonSingleIngredient(ingredient);
    const { scrapeMode, ...mongoPayload } = doc;
    await Ingredient.updateOne(
      { name: doc.name },
      {
        $set: {
          ...mongoPayload,
          lastScrapedAt: new Date(),
        },
      },
      { upsert: true }
    );
    res.status(200).json({
      message: 'Scraped and saved successfully',
      data: doc,
    });
  } catch (e) {
    console.error('/scrape error:', e);
    res.status(500).json({ error: e.message || 'Scraping failed' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(
    `Ingredient price backend: PRICE_DATA_SOURCE=${PRICE_DATA_SOURCE} → scrapers/${INGREDIENT_PRICE_SCRIPT}`
  );
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop the other process (e.g. Task Manager / netstat) or set PORT=5001 in backend/.env`
    );
    process.exit(1);
  }
  throw err;
});
