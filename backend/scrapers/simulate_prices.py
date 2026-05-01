"""
Simulated ingredient prices (random per platform) for dev when live scraping
is off or not implemented.

The app supplies ingredient names via the Express API (same as scraper.py).
This script only supports:

  python simulate_prices.py --single "paneer"

Toggle the backend with PRICE_DATA_SOURCE=simulate (see server.js).
"""

import json
import random
import sys

PLATFORMS = ["Blinkit", "Zepto", "Instamart"]


def normalize_ingredient_name(s):
    return " ".join(str(s).strip().lower().split())


def generate_simulated_price_docs(normalized_name):
    docs = []
    for platform in PLATFORMS:
        if platform == "Blinkit":
            base_price_per_kg = round(random.uniform(50, 300), 2)
        elif platform == "Zepto":
            base_price_per_kg = round(random.uniform(100, 350), 2)
        elif platform == "Instamart":
            base_price_per_kg = round(random.uniform(75, 400), 2)
        else:
            base_price_per_kg = round(random.uniform(50, 400), 2)
        docs.append({"platform": platform, "price_per_kg": base_price_per_kg})
    return {"name": normalized_name, "prices": docs}


def fetch_simulated_prices_for_ingredient(ingredient_raw):
    n = normalize_ingredient_name(ingredient_raw)
    if not n:
        raise ValueError("empty ingredient")
    doc = generate_simulated_price_docs(n)
    doc["scrapeMode"] = "simulated"
    return doc


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--single":
        try:
            raw = sys.argv[2]
            doc = fetch_simulated_prices_for_ingredient(raw)
            print(json.dumps(doc))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
    sys.stderr.write(
        "Usage: python simulate_prices.py --single \"ingredient name\"\n"
        "Or set PRICE_DATA_SOURCE=simulate on the backend.\n"
    )
    sys.exit(2)
