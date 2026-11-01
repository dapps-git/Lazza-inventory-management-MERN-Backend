import mongoose from 'mongoose';

const shopSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerName: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    city: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: '' },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    additionalDetails: { type: String, trim: true, default: '' },
    // Balance carried over from before this system was used ("Previous Balance")
    openingBalance: { type: Number, default: 0, min: 0 },
    // Current amount the shop owes. Only ever changed with atomic $inc together
    // with a ShopTransaction ledger entry.
    outstandingBalance: { type: Number, default: 0 },
    // Shops are soft-deleted so their account history is never lost
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model('Shop', shopSchema);
