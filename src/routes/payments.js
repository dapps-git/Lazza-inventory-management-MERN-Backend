import { Router } from 'express';
import mongoose from 'mongoose';
import Payment, { PAYMENT_METHODS } from '../models/Payment.js';
import Shop from '../models/Shop.js';
import ShopTransaction from '../models/ShopTransaction.js';
import { changeShopBalance } from '../services/ledger.js';
import {
  ah,
  HttpError,
  round2,
  dateRange,
  escapeRegex,
  resolveEntryDate,
  startOfDay,
  startOfWeek,
  startOfMonth,
  endOfDay,
} from '../utils/helpers.js';

const router = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const { shop, method, search, from, to } = req.query;
    const q = {};
    const range = dateRange(from, to);
    if (range) q.date = range;
    if (shop && mongoose.isValidObjectId(shop)) q.shop = shop;
    if (PAYMENT_METHODS.includes(method)) q.method = method;
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      q.$or = [{ shopName: rx }, { referenceNumber: rx }, { notes: rx }];
    }
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    res.json(await Payment.find(q).sort({ date: -1, createdAt: -1 }).limit(limit).lean());
  })
);

// Today / this week / this month totals, shop-wise collections and pending balances
router.get(
  '/summary',
  ah(async (req, res) => {
    const now = new Date();
    const sumBetween = async (start) => {
      const [r] = await Payment.aggregate([
        { $match: { date: { $gte: start, $lte: endOfDay(now) } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]);
      return { total: round2(r?.total || 0), count: r?.count || 0 };
    };
    const range = dateRange(req.query.from, req.query.to) || { $gte: startOfMonth(now), $lte: endOfDay(now) };
    const [today, week, month, shopWise, pending] = await Promise.all([
      sumBetween(startOfDay(now)),
      sumBetween(startOfWeek(now)),
      sumBetween(startOfMonth(now)),
      Payment.aggregate([
        { $match: { date: range } },
        {
          $group: {
            _id: '$shop',
            shopName: { $last: '$shopName' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            lastPayment: { $max: '$date' },
          },
        },
        { $sort: { total: -1 } },
      ]),
      Shop.find({ isDeleted: false, outstandingBalance: { $gt: 0 } })
        .select('name city phone outstandingBalance')
        .sort({ outstandingBalance: -1 })
        .lean(),
    ]);
    res.json({
      today,
      week,
      month,
      shopWise: shopWise.map((s) => ({ ...s, total: round2(s.total) })),
      pending,
      pendingTotal: round2(pending.reduce((s, p) => s + p.outstandingBalance, 0)),
    });
  })
);

/*
  Record a payment collected from a shop.
  body: { shop, amount, method, referenceNumber?, notes?, date?, clientRequestId }
  The amount cannot be more than the shop's current outstanding balance.
*/
router.post(
  '/',
  ah(async (req, res) => {
    const body = req.body || {};
    const clientRequestId = body.clientRequestId ? String(body.clientRequestId) : undefined;
    if (clientRequestId) {
      const existing = await Payment.findOne({ clientRequestId }).lean();
      if (existing) return res.status(200).json({ payment: existing, duplicate: true });
    }

    if (!mongoose.isValidObjectId(body.shop)) throw new HttpError(400, 'Please select a shop');
    const shop = await Shop.findOne({ _id: body.shop, isDeleted: false }).lean();
    if (!shop) throw new HttpError(400, 'Shop not found');

    const amount = round2(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter an amount greater than 0');
    if (!PAYMENT_METHODS.includes(body.method)) throw new HttpError(400, 'Choose a payment method');
    if (amount > shop.outstandingBalance)
      throw new HttpError(400, `Amount is more than the outstanding balance of ₹${shop.outstandingBalance}`);

    const date = resolveEntryDate(body.date);
    if (startOfDay(date) > startOfDay(new Date())) throw new HttpError(400, 'Payment date cannot be in the future');

    // 1. Reduce balance atomically, only if the shop still owes at least this much
    const updatedShop = await changeShopBalance(shop._id, -amount, amount);
    if (!updatedShop) throw new HttpError(409, 'Outstanding balance changed. Refresh and try again.');
    const remainingBalance = updatedShop.outstandingBalance;

    // 2. Save the payment (undo the balance change if it fails)
    let payment;
    try {
      payment = await Payment.create({
        clientRequestId,
        shop: shop._id,
        shopName: shop.name,
        date,
        amount,
        method: body.method,
        referenceNumber: String(body.referenceNumber || '').trim(),
        notes: String(body.notes || '').trim(),
        balanceBefore: round2(remainingBalance + amount),
        remainingBalance,
        createdBy: req.user?._id,
      });
    } catch (err) {
      await changeShopBalance(shop._id, amount);
      if (err?.code === 11000) {
        const existing = await Payment.findOne({ clientRequestId }).lean();
        if (existing) return res.status(200).json({ payment: existing, duplicate: true });
      }
      throw err;
    }

    // 3. Ledger entry
    await ShopTransaction.create({
      shop: shop._id,
      type: 'Payment',
      payment: payment._id,
      date,
      description: `Payment received (${payment.method}${payment.referenceNumber ? `, ref ${payment.referenceNumber}` : ''})`,
      debit: 0,
      credit: amount,
      balanceAfter: remainingBalance,
    });

    res.status(201).json({ payment, shopOutstanding: remainingBalance });
  })
);

export default router;
