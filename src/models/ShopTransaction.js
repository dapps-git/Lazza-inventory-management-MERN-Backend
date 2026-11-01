import mongoose from 'mongoose';

// One row per change to a shop's account. This is the shop ledger.
// debit  = amount added to what the shop owes (goods supplied)
// credit = amount received from the shop
const shopTransactionSchema = new mongoose.Schema(
  {
    shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    type: { type: String, enum: ['Opening', 'Sale', 'Payment'], required: true },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    date: { type: Date, required: true, default: Date.now },
    description: { type: String, default: '' },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    balanceAfter: { type: Number, required: true },
  },
  { timestamps: true }
);

shopTransactionSchema.index({ shop: 1, date: 1, createdAt: 1 });
// A sale or payment can only appear once in the ledger
shopTransactionSchema.index({ sale: 1 }, { unique: true, partialFilterExpression: { sale: { $type: 'objectId' } } });
shopTransactionSchema.index({ payment: 1 }, { unique: true, partialFilterExpression: { payment: { $type: 'objectId' } } });

export default mongoose.model('ShopTransaction', shopTransactionSchema);
