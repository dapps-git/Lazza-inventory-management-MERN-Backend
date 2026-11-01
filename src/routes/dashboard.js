import { Router } from 'express';
import Product from '../models/Product.js';
import Shop from '../models/Shop.js';
import Sale from '../models/Sale.js';
import Payment from '../models/Payment.js';
import { ah, round2, startOfDay, startOfMonth, endOfDay } from '../utils/helpers.js';

const router = Router();

const sumField = async (Model, field, match = {}) => {
  const [r] = await Model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` } } }]);
  return round2(r?.total || 0);
};

router.get(
  '/',
  ah(async (req, res) => {
    const now = new Date();
    const today = { $gte: startOfDay(now), $lte: endOfDay(now) };
    const month = { $gte: startOfMonth(now), $lte: endOfDay(now) };

    const [
      totalProducts,
      stockAgg,
      totalShops,
      todaySales,
      monthlySales,
      creditFromSales,
      openingBalances,
      totalCollected,
      totalOutstanding,
      recentSales,
      recentPayments,
      shopOutstanding,
      productStock,
    ] = await Promise.all([
      Product.countDocuments({ isDeleted: false }),
      Product.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            units: { $sum: '$quantity' },
            value: { $sum: { $multiply: ['$quantity', '$price'] } },
          },
        },
      ]),
      Shop.countDocuments({ isDeleted: false }),
      sumField(Sale, 'totalAmount', { date: today }),
      sumField(Sale, 'totalAmount', { date: month }),
      sumField(Sale, 'creditAmount'),
      sumField(Shop, 'openingBalance'),
      sumField(Payment, 'amount'),
      sumField(Shop, 'outstandingBalance', { isDeleted: false }),
      Sale.find().sort({ date: -1, createdAt: -1 }).limit(6).lean(),
      Payment.find().sort({ date: -1, createdAt: -1 }).limit(6).lean(),
      Shop.find({ isDeleted: false, outstandingBalance: { $gt: 0 } })
        .select('name city outstandingBalance')
        .sort({ outstandingBalance: -1 })
        .limit(10)
        .lean(),
      Product.find({ isDeleted: false })
        .select('name category quantity price')
        .populate('category', 'name')
        .sort({ quantity: 1 })
        .lean(),
    ]);

    res.json({
      cards: {
        totalProducts,
        totalStock: stockAgg[0]?.units || 0,
        stockValue: round2(stockAgg[0]?.value || 0),
        totalShops,
        todaySales,
        monthlySales,
        // Credit given on sales plus previous balances brought in
        totalCredit: round2(creditFromSales + openingBalances),
        totalCollected,
        totalOutstanding,
      },
      recentSales,
      recentPayments,
      shopOutstanding,
      productStock,
    });
  })
);

export default router;
