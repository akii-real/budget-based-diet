# Budget-Based Diet Maker

Budget-Based Diet Maker is a full-stack app that builds daily meal plans around calorie/macronutrient goals and a strict INR budget, then enriches ingredient prices using quick-commerce style sources.

## Highlights

- Generate meal plans for `Breakfast`, `Lunch`, `Snacks`, and `Dinner` based on user profile and goal.
- Enforce a hard daily food budget while targeting calories and macros.
- Cache and reuse meal plan pools locally for faster alternate plan switching.
- View recipe-level details and compare estimated platform prices.
- Refresh ingredient prices via backend Python scripts and store them in MongoDB.

## Tech Stack

- Frontend: Next.js, React, Tailwind CSS, Chart.js
- API layer: Next.js API routes
- Backend: Node.js, Express, MongoDB (Mongoose), Python scrapers
- Data: MongoDB collections + local Excel export (`backend/Userinfo.xlsx`)

## Repository Structure

- `src/` - Next.js app pages, components, API routes, and helpers
- `backend/` - Express backend, MongoDB ingestion logic, Python scrapers
- `public/` - Static assets
- `scripts/` - Local development helper scripts
- `selenium/` - Browser automation-related assets/scripts

## Prerequisites

- Node.js 18+ recommended
- Python 3.9+
- MongoDB Atlas (or compatible MongoDB URL)
- Optional: Ollama running locally for local model inference

## Environment Variables

Create `backend/.env`:

```env
PORT=5000
MONGO_DB_USERNAME=your_username
MONGO_DB_PASSWORD=your_password
MONGO_DB_URL=your_cluster_host
PRICE_DATA_SOURCE=simulate
PRICE_MAX_AGE_MINUTES=30
```

Create `.env.local` in the project root:

```env
MONGO_DB_USERNAME=your_username
MONGO_DB_PASSWORD=your_password
MONGO_DB_URL=your_cluster_host

OLLAMA_MODEL=llama3.1
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_TIMEOUT_MS=60000
AI_MEALPLAN_MAX_MODEL_CALLS=4
```

## Local Development

Install dependencies:

```bash
yarn install
cd backend && yarn install
```

Run backend (Terminal 1):

```bash
cd backend
node server.js
```

Run frontend (Terminal 2):

```bash
yarn dev
```

Open `http://localhost:3000`.

## API Overview

- `POST /save-data` - Save user form payload to Excel
- `POST /refresh-ingredient-prices` - Refresh ingredient prices in MongoDB
- `POST /scrape` - Single ingredient scrape endpoint (legacy/fallback)
- `POST /api/ai-meal-plan` - Generate budget-aware daily meal plan
- `GET/POST /api/recipe` - Retrieve detailed recipe with price insights

## Current Status

This branch reflects the latest working iteration with improved AI meal-plan flow, recipe-level details, and backend ingredient price refresh handling.

## License

MIT
