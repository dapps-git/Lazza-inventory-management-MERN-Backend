import mongoose from 'mongoose';

const saleItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true }, // snapshot at time of sale
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 }, // discount per unit (₹)
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const saleSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    // Sent by the client once per form; a repeated submit returns the existing sale
    clientRequestId: { type: String, unique: true, sparse: true },
    date: { type: Date, required: true, default: Date.now },
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    shopName: { type: String, required: true },
    items: { type: [saleItemSchema], validate: (v) => v.length > 0 },
    subTotal: { type: Number, required: true },
    totalDiscount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    paidAmount: { type: Number, required: true, min: 0 },
    creditAmount: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: ['Paid', 'Partial', 'Credit'], required: true },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

saleSchema.index({ date: -1 });
saleSchema.index({ shop: 1, date: -1 });

export default mongoose.model('Sale', saleSchema);
