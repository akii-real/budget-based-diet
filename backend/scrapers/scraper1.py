import os
import time
import tempfile
import random
import pandas as pd
from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.options import Options # pyright: ignore[reportMissingImports]
from selenium.webdriver.edge.service import Service
from selenium.webdriver.support.ui import WebDriverWait # pyright: ignore[reportMissingImports]
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.microsoft import EdgeChromiumDriverManager
from pymongo import MongoClient

load_dotenv()

# ─── CONFIGURATION ─────────────────────────────────────────────────────────────
CSV_PATH = r"D:/Projects/Diet Maker/public/data/meal_plan.csv"
USE_REAL_SCRAPER = False   # ← Set to True to enable real scraping
DATABASE = "dietprices"
COLLECTION = "Ingredients"
PLATFORMS = ["Blinkit", "Zepto", "Instamart"]
DEFAULT_QUANTITY_G = 100    # assume 100 g per ingredient for cost estimates
# ────────────────────────────────────────────────────────────────────────────────

def get_mongo_collection():
    user = os.getenv("MONGO_DB_USERNAME")
    pw   = os.getenv("MONGO_DB_PASSWORD")
    url  = os.getenv("MONGO_DB_URL")
    if not user or not pw or not url:
        raise RuntimeError("MongoDB credentials missing")
    uri = f"mongodb+srv://{user}:{pw}@{url}/{DATABASE}?retryWrites=true&w=majority"
    client = MongoClient(uri)
    return client[DATABASE][COLLECTION]

# ─── STEP 1: Read all unique ingredients from your CSV ─────────────────────────
def read_ingredients_from_csv(path):
    df = pd.read_csv(path)
    if "Ingredients" not in df.columns:
        raise ValueError("CSV must contain an 'Ingredients' column")
    # split comma-separated lists, strip whitespace, dedupe
    all_ings = df["Ingredients"].dropna().str.split(",").explode().str.strip()
    return sorted(all_ings.unique())

# ─── STEP 2A: Simulate & save prices ───────────────────────────────────────────
def generate_simulated_price_docs(ingredient):
    docs = []
    for platform in PLATFORMS:
        # Generate a different random base price for each platform
        base_price_per_kg = round(random.uniform(50, 400), 2)
        
        # Adjust the base price per platform (you can have different ranges for each platform)
        if platform == "Blinkit":
            base_price_per_kg = round(random.uniform(50, 300), 2)
        elif platform == "Zepto":
            base_price_per_kg = round(random.uniform(100, 350), 2)
        elif platform == "Instamart":
            base_price_per_kg = round(random.uniform(75, 400), 2)
        
        docs.append({
            "platform": platform,
            "price_per_kg": base_price_per_kg,
        })
    
    return {"name": ingredient, "prices": docs}

def simulate_and_store_prices():
    coll = get_mongo_collection()
    ing_list = read_ingredients_from_csv(CSV_PATH)
    for ing in ing_list:
        doc = generate_simulated_price_docs(ing)
        coll.update_one({"name": ing}, {"$set": doc}, upsert=True)
    print(f"✅ Simulated prices for {len(ing_list)} ingredients written to MongoDB")

# ─── STEP 2B: (Optional) Real scraping stub ─────────────────────────────────────
def setup_driver():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument(f"--user-agent=Mozilla/5.0")
    opts.add_argument(f"--user-data-dir={tempfile.mkdtemp()}")
    return webdriver.Edge(service=Service(EdgeChromiumDriverManager().install()), options=opts)

def detect_location(driver):
    driver.get("https://blinkit.com/")
    try:
        WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.XPATH, "//button[contains(text(),'Detect')]"))
        ).click()
        time.sleep(2)
        print("📍 Location detected.")
    except:
        print("⚠️ Location detection skipped.")

def real_scrape_and_store():
    driver = setup_driver()
    detect_location(driver)
    # … your real scraping logic goes here …
    driver.quit()

# ─── STEP 3: Recompute each recipe’s Estimated Cost and update CSV ────────────
def update_recipe_costs_in_csv():
    coll = get_mongo_collection()
    df = pd.read_csv(CSV_PATH)
    costs = []

    for _, row in df.iterrows():
        ings = str(row.get("Ingredients", "")).split(",")
        total = 0.0
        for ing in ings:
            name = ing.strip()
            if not name:
                continue
            doc = coll.find_one({"name": name})
            if not doc:
                print(f"⚠️ No price for ingredient '{name}', skipping.")
                continue

            # Extract all prices for the ingredient across all platforms
            platform_prices = [p["price_per_kg"] for p in doc.get("prices", [])]
            if not platform_prices:
                print(f"⚠️ No platform prices for '{name}', skipping.")
                continue

            # Find the minimum price across all platforms
            min_price = min(platform_prices)

            # Add the minimum price to the total cost for this recipe
            total += min_price * (DEFAULT_QUANTITY_G / 1000.0)

        # Append the total estimated cost for the recipe
        costs.append(round(total, 2))

    # Update the CSV with the new costs
    df["Estimated Cost (₹)"] = costs
    df.to_csv(CSV_PATH, index=False)
    print("✅ CSV updated with new Estimated Cost column.")

# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    if USE_REAL_SCRAPER:
        real_scrape_and_store()
    else:
        simulate_and_store_prices()

    # in either case, re-run cost computation
    update_recipe_costs_in_csv()

if __name__ == "__main__":
    main()
