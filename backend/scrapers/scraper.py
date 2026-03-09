import os
import time
import tempfile
import random
import pandas as pd
from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.options import Options
from selenium.webdriver.edge.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.microsoft import EdgeChromiumDriverManager
from pymongo import MongoClient

load_dotenv()

# ─── CONFIGURATION ─────────────────────────────────────────────────────────────
CSV_PATH = r"D:/Projects/Diet Maker/public/data/meal_plan.csv"
USE_REAL_SCRAPER = False  # ← Set to True to enable real scraping
DATABASE = "dietprices"
COLLECTION = "Ingredients"
PLATFORMS = ["Blinkit", "Zepto", "Instamart"]
DEFAULT_QUANTITY_G = 100  # assume 100 g per ingredient for cost estimates

# ────────────────────────────────────────────────────────────────────────────────

def get_mongo_collection():
    """Connect to MongoDB and return the collection."""
    user = os.getenv("MONGO_DB_USERNAME")
    pw = os.getenv("MONGO_DB_PASSWORD")
    url = os.getenv("MONGO_DB_URL")
    
    if not user or not pw or not url:
        raise RuntimeError("MongoDB credentials missing in .env file")
    
    uri = f"mongodb+srv://{user}:{pw}@{url}/{DATABASE}?retryWrites=true&w=majority"
    client = MongoClient(uri)
    return client[DATABASE][COLLECTION]

# ─── STEP 1: Read all unique ingredients from your CSV ─────────────────────────

def read_ingredients_from_csv(path):
    """Read and return sorted unique ingredients from CSV."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"CSV file not found: {path}")
    
    df = pd.read_csv(path)
    
    if "Ingredients" not in df.columns:
        raise ValueError("CSV must contain an 'Ingredients' column")
    
    # split comma-separated lists, strip whitespace, dedupe
    all_ings = df["Ingredients"].dropna().str.split(",").explode().str.strip()
    return sorted(all_ings.unique())

# ─── STEP 2A: Simulate & save prices ───────────────────────────────────────────

def generate_simulated_price_docs(ingredient):
    """Generate realistic simulated price document for an ingredient."""
    docs = []
    
    for platform in PLATFORMS:
        # Adjust the base price per platform
        if platform == "Blinkit":
            base_price_per_kg = round(random.uniform(50, 300), 2)
        elif platform == "Zepto":
            base_price_per_kg = round(random.uniform(100, 350), 2)
        elif platform == "Instamart":
            base_price_per_kg = round(random.uniform(75, 400), 2)
        else:
            base_price_per_kg = round(random.uniform(50, 400), 2)
        
        docs.append({
            "platform": platform,
            "price_per_kg": base_price_per_kg,
        })
    
    return {"name": ingredient, "prices": docs}

def simulate_and_store_prices():
    """Simulate prices for all ingredients and store in MongoDB."""
    try:
        coll = get_mongo_collection()
        ing_list = read_ingredients_from_csv(CSV_PATH)
        
        print(f"🔄 Processing {len(ing_list)} ingredients...")
        
        for ing in ing_list:
            doc = generate_simulated_price_docs(ing)
            coll.update_one({"name": ing}, {"$set": doc}, upsert=True)
        
        print(f"✅ Simulated prices for {len(ing_list)} ingredients written to MongoDB")
        
    except Exception as e:
        print(f"❌ Error in simulate_and_store_prices: {e}")
        raise

# ─── STEP 2B: (Optional) Real scraping stub ─────────────────────────────────────

def setup_driver():
    """Setup and return configured Edge WebDriver."""
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--user-agent=Mozilla/5.0")
    opts.add_argument(f"--user-data-dir={tempfile.mkdtemp()}")
    
    return webdriver.Edge(
        service=Service(EdgeChromiumDriverManager().install()), 
        options=opts
    )

def detect_location(driver):
    """Attempt to auto-detect location on Blinkit."""
    try:
        driver.get("https://blinkit.com/")
        WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.XPATH, "//button[contains(text(),'Detect')]"))
        ).click()
        time.sleep(2)
        print("📍 Location detected.")
    except TimeoutError:
        print("⚠️ Location detection timeout - proceeding without auto-detect.")
    except Exception as e:
        print(f"⚠️ Location detection failed: {e}")

def real_scrape_and_store():
    """Perform real web scraping (stub - add your scraping logic here)."""
    driver = None
    try:
        driver = setup_driver()
        detect_location(driver)
        
        # … your real scraping logic goes here …
        print("🔄 Real scraping logic to be implemented...")
        
    except Exception as e:
        print(f"❌ Error in real_scrape_and_store: {e}")
        raise
    finally:
        if driver:
            driver.quit()

# ─── STEP 3: Recompute each recipe's Estimated Cost and update CSV ────────────

def update_recipe_costs_in_csv():
    """Calculate estimated costs from MongoDB prices and update CSV."""
    try:
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
                    print(f"⚠️ No price found for ingredient '{name}', skipping.")
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
        
        print(f"✅ CSV updated with {len(costs)} recipe costs.")
        
    except FileNotFoundError:
        print(f"❌ CSV file not found: {CSV_PATH}")
        raise
    except Exception as e:
        print(f"❌ Error in update_recipe_costs_in_csv: {e}")
        raise

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    """Main execution function."""
    try:
        print("🚀 Starting meal plan cost calculator...\n")
        
        if USE_REAL_SCRAPER:
            print("📡 Using REAL scraping mode")
            real_scrape_and_store()
        else:
            print("🎲 Using SIMULATED pricing mode")
            simulate_and_store_prices()
        
        print("\n📊 Updating recipe costs in CSV...")
        update_recipe_costs_in_csv()
        
        print("\n✨ All done!")
        
    except Exception as e:
        print(f"\n💥 Fatal error: {e}")
        exit(1)

if __name__ == "__main__":
    main()