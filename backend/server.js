const express = require('express');
const cors = require('cors');
const fs = require('fs');
const XLSX = require('xlsx');
const { exec } = require('child_process');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// MongoDB Ingredient Schema
const ingredientSchema = new mongoose.Schema({
  name: String,
  source: String,
  price: Number,
});
const Ingredient = mongoose.model('Ingredient', ingredientSchema);

// MongoDB connection
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
      `mongodb+srv://${username}:${password}@${url}/${database}?retryWrites=true&w=majority`,
      { useNewUrlParser: true, useUnifiedTopology: true }
    );
    console.log('✅ MongoDB connection is successful');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
}

connectDB();

// ✅ Correct Excel file path
const FILE_PATH = 'D:/Projects/Diet Maker/backend/Userinfo.xlsx';

// ✅ Function to append data to Excel
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
    // Create the directory if it doesn't exist
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

// Route to save user data
app.post('/save-data', (req, res) => {
  try {
    appendToExcel(req.body);
    res.status(200).json({ message: 'Data saved successfully!' });
  } catch (error) {
    console.error('Error writing to Excel:', error);
    res.status(500).json({ message: 'Error saving data' });
  }
});

// ✅ Route to run Python scraper
app.post('/scrape', (req, res) => {
  const { ingredient } = req.body;

  exec(
    `python ./scraper/scraper.py "${ingredient}"`,
    async (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
        return res.status(500).json({ error: 'Scraping failed' });
      }

      if (stderr) {
        console.error(`stderr: ${stderr}`);
      }

      try {
        const result = JSON.parse(stdout);

        // Clear previous prices for the same ingredient
        await Ingredient.deleteMany({ name: ingredient });

        // Save new prices in MongoDB
        const ingredientDocs = result.map((item) => ({
          name: ingredient,
          source: item.source,
          price: item.price,
        }));

        await Ingredient.insertMany(ingredientDocs);
        res.status(200).json({
          message: 'Scraped and saved successfully',
          data: ingredientDocs,
        });
      } catch (parseError) {
        console.error('Failed to parse scraper output:', parseError.message);
        res.status(500).json({ error: 'Failed to parse scraper output' });
      }
    }
  );
});

// ✅ Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
