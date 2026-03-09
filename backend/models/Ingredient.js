import mongoose from 'mongoose';

const IngredientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  platform: { type: String, enum: ['Zepto', 'Blinkit'], required: true },
  price: { type: Number, required: true },
  unit: { type: String }, // e.g., "per 1kg", "per 500g"
  lastUpdated: { type: Date, default: Date.now },
});

export default mongoose.model('Ingredient', IngredientSchema);
