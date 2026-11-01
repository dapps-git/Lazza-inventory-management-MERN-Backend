import mongoose from 'mongoose';

export const PAYMENT_METHODS = ['Cash', 'UPI', 'Bank Transfer', 'Other'];

const paymentSchema = new mongoose.Schema(
  {
    clientRequestId: { type: String, unique: true, sparse: true },
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    shopName: { type: String, required: true },
    date: { type: Date, required: true, default: Date.now },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    referenceNumber: { type: String, trim: true, default: '' },
    balanceBefore: { type: Number, required: true },
    remainingBalance: { type: Number, required: true },
    notes: { type: String, trim: true, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

paymentSchema.index({ date: -1 });
paymentSchema.index({ shop: 1, date: -1 });

export default mongoose.model('Payment', paymentSchema);
