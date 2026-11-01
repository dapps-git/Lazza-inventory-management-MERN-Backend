import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    brand: { type: String, trim: true, default: 'Lazza' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    price: { type: Number, required: true, min: 0 },
    discountedPrice: { type: Number, min: 0, default: null },
    quantity: { type: Number, required: true, min: 0, default: 0 }, // available stock
    description: { type: String, trim: true, default: '' },
    // Products are soft-deleted so that past sales keep a valid reference
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', brand: 'text' });

export default mongoose.model('Product', productSchema);
