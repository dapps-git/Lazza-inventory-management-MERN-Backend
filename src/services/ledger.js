import Shop from '../models/Shop.js';
import Sale from '../models/Sale.js';
import Payment from '../models/Payment.js';
import { round2 } from '../utils/helpers.js';

// Atomically change a shop's outstanding balance and return the new balance.
// `guardMin` lets a caller require the balance to be at least that much first
// (used by payments so a shop is never collected below zero).
export async function changeShopBalance(shopId, delta, guardMin = null) {
  const filter = { _id: shopId };
  if (guardMin !== null) filter.outstandingBalance = { $gte: guardMin - 0.001 };
  const shop = await Shop.findOneAndUpdate(filter, { $inc: { outstandingBalance: round2(delta) } }, { new: true });
  if (!shop) return null;
  // Keep stored value clean of floating point dust
  const clean = round2(shop.outstandingBalance);
  if (clean !== shop.outstandingBalance) {
    await Shop.updateOne({ _id: shopId }, { $set: { outstandingBalance: clean } });
    shop.outstandingBalance = clean;
  }
  return shop;
}

// Account summary for one shop (or all shops when shopId is null)
export async function shopSummaries(shopIds = null) {
  const match = shopIds ? { shop: { $in: shopIds } } : {};
  const [sales, payments] = await Promise.all([
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$shop',
          salesCount: { $sum: 1 },
          totalSales: { $sum: '$totalAmount' },
          paidAtSale: { $sum: '$paidAmount' },
          itemsSupplied: { $sum: { $sum: '$items.quantity' } },
          lastSale: { $max: '$date' },
        },
      },
    ]),
    Payment.aggregate([
      { $match: match },
      { $group: { _id: '$shop', collected: { $sum: '$amount' }, lastPayment: { $max: '$date' } } },
    ]),
  ]);
  const out = {};
  for (const s of sales) {
    out[String(s._id)] = {
      salesCount: s.salesCount,
      totalSales: round2(s.totalSales),
      paidAtSale: round2(s.paidAtSale),
      itemsSupplied: s.itemsSupplied,
      lastSale: s.lastSale,
      collected: 0,
    };
  }
  for (const p of payments) {
    const k = String(p._id);
    out[k] = out[k] || { salesCount: 0, totalSales: 0, paidAtSale: 0, itemsSupplied: 0, lastSale: null };
    out[k].collected = round2(p.collected);
    out[k].lastPayment = p.lastPayment;
  }
  for (const v of Object.values(out)) v.totalReceived = round2(v.paidAtSale + v.collected);
  return out;
}

export const emptySummary = {
  salesCount: 0,
  totalSales: 0,
  paidAtSale: 0,
  itemsSupplied: 0,
  collected: 0,
  totalReceived: 0,
  lastSale: null,
  lastPayment: null,
};
