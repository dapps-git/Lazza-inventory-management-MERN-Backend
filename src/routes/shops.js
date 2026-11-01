import { Router } from 'express';
import mongoose from 'mongoose';
import Shop from '../models/Shop.js';
import Sale from '../models/Sale.js';
import Payment from '../models/Payment.js';
import ShopTransaction from '../models/ShopTransaction.js';
import { shopSummaries, emptySummary } from '../services/ledger.js';
import { ah, HttpError, escapeRegex, round2, dateRange } from '../utils/helpers.js';

const router = Router();

function cleanShop(body = {}) {
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const lat = num(body.location?.lat ?? body.lat);
  const lng = num(body.location?.lng ?? body.lng);
  const data = {
    name: String(body.name || '').trim(),
    ownerName: String(body.ownerName || '').trim(),
    phone: String(body.phone || '').trim(),
    city: String(body.city || '').trim(),
    address: String(body.address || '').trim(),
    location: { lat, lng },
    additionalDetails: String(body.additionalDetails || '').trim(),
  };
  if (!data.name) throw new HttpError(400, 'Shop name is required');
  if (!data.city) throw new HttpError(400, 'City is required');
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) throw new HttpError(400, 'Invalid latitude');
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) throw new HttpError(400, 'Invalid longitude');
  return data;
}

const getShop = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Shop not found');
  const shop = await Shop.findOne({ _id: id, isDeleted: false }).lean();
  if (!shop) throw new HttpError(404, 'Shop not found');
  return shop;
};

router.get(
  '/',
  ah(async (req, res) => {
    const { search, city } = req.query;
    const q = { isDeleted: false };
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      q.$or = [{ name: rx }, { ownerName: rx }, { phone: rx }, { address: rx }, { city: rx }];
    }
    if (city) q.city = new RegExp(`^${escapeRegex(city)}$`, 'i');
    const shops = await Shop.find(q).sort({ name: 1 }).lean();
    const summaries = await shopSummaries(shops.map((s) => s._id));
    res.json(shops.map((s) => ({ ...s, summary: summaries[String(s._id)] || emptySummary })));
  })
);

router.get(
  '/cities',
  ah(async (req, res) => {
    const cities = await Shop.distinct('city', { isDeleted: false });
    res.json(cities.sort((a, b) => a.localeCompare(b)));
  })
);

// Shop details + account summary
router.get(
  '/:id',
  ah(async (req, res) => {
    const shop = await getShop(req.params.id);
    const summary = (await shopSummaries([shop._id]))[String(shop._id)] || emptySummary;
    // Cross-check: opening + sales - received should equal stored outstanding
    const computed = round2(shop.openingBalance + summary.totalSales - summary.totalReceived);
    res.json({ ...shop, summary: { ...summary, computedOutstanding: computed } });
  })
);

// Account statement / ledger with optional date range
router.get(
  '/:id/ledger',
  ah(async (req, res) => {
    const shop = await getShop(req.params.id);
    const range = dateRange(req.query.from, req.query.to);
    const q = { shop: shop._id };
    let broughtForward = 0;
    if (range) {
      q.date = range;
      if (range.$gte) {
        // Balance of everything dated before the range start
        const [prev] = await ShopTransaction.aggregate([
          { $match: { shop: shop._id, date: { $lt: range.$gte } } },
          { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
        ]);
        broughtForward = prev ? round2(prev.debit - prev.credit) : 0;
      }
    }
    const entries = await ShopTransaction.find(q)
      .sort({ date: 1, createdAt: 1 })
      .populate('sale', 'invoiceNumber paymentStatus')
      .populate('payment', 'method referenceNumber')
      .lean();
    // Running balance recomputed in date order (entries may be back-dated)
    let running = broughtForward;
    const rows = entries.map((e) => {
      running = round2(running + e.debit - e.credit);
      return { ...e, runningBalance: running };
    });
    const totals = rows.reduce(
      (t, r) => ({ debit: round2(t.debit + r.debit), credit: round2(t.credit + r.credit) }),
      { debit: 0, credit: 0 }
    );
    res.json({
      shop: { _id: shop._id, name: shop.name, city: shop.city, ownerName: shop.ownerName, phone: shop.phone },
      broughtForward,
      entries: rows,
      totals,
      closingBalance: running,
      currentOutstanding: shop.outstandingBalance,
    });
  })
);

router.get(
  '/:id/sales',
  ah(async (req, res) => {
    const shop = await getShop(req.params.id);
    const q = { shop: shop._id };
    const range = dateRange(req.query.from, req.query.to);
    if (range) q.date = range;
    res.json(await Sale.find(q).sort({ date: -1 }).lean());
  })
);

router.get(
  '/:id/payments',
  ah(async (req, res) => {
    const shop = await getShop(req.params.id);
    const q = { shop: shop._id };
    const range = dateRange(req.query.from, req.query.to);
    if (range) q.date = range;
    res.json(await Payment.find(q).sort({ date: -1 }).lean());
  })
);

router.post(
  '/',
  ah(async (req, res) => {
    const data = cleanShop(req.body);
    const opening = round2(req.body?.openingBalance || 0);
    if (!Number.isFinite(opening) || opening < 0) throw new HttpError(400, 'Previous balance must be 0 or more');
    const shop = await Shop.create({ ...data, openingBalance: opening, outstandingBalance: opening });
    if (opening > 0) {
      await ShopTransaction.create({
        shop: shop._id,
        type: 'Opening',
        date: new Date(),
        description: 'Previous balance brought forward',
        debit: opening,
        credit: 0,
        balanceAfter: opening,
      });
    }
    res.status(201).json(shop);
  })
);

// Edits shop details only. Balances change only through sales and payments.
router.put(
  '/:id',
  ah(async (req, res) => {
    const data = cleanShop(req.body);
    const shop = await Shop.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, data, {
      new: true,
      runValidators: true,
    });
    if (!shop) throw new HttpError(404, 'Shop not found');
    res.json(shop);
  })
);

// Soft delete. Blocked while the shop still owes money; history is always kept.
router.delete(
  '/:id',
  ah(async (req, res) => {
    const shop = await getShop(req.params.id);
    if (shop.outstandingBalance > 0) {
      throw new HttpError(400, `This shop still owes ₹${shop.outstandingBalance}. Collect the balance before deleting.`);
    }
    await Shop.updateOne({ _id: shop._id }, { isDeleted: true });
    res.json({ message: 'Shop deleted. Its sales and payment history are kept.' });
  })
);

export default router;
