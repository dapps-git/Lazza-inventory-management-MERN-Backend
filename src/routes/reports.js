import { Router } from 'express';
import Sale from '../models/Sale.js';
import Payment from '../models/Payment.js';
import Product from '../models/Product.js';
import Shop from '../models/Shop.js';
import { shopSummaries, emptySummary } from '../services/ledger.js';
import { ah, HttpError, round2, dateRange } from '../utils/helpers.js';

const router = Router();
const tz = () => process.env.TZ || 'Asia/Kolkata';
const r2 = (obj, keys) => keys.forEach((k) => (obj[k] = round2(obj[k] || 0)));

// Every report returns { columns, rows, totals } so the client can show and export it the same way.

// Daily / weekly / monthly sales: /reports/sales?group=day|week|month&from&to
async function salesByPeriod(group, range) {
  const unit = ['day', 'week', 'month'].includes(group) ? group : 'day';
  const fmt = { day: '%Y-%m-%d', week: '%Y-%m-%d', month: '%Y-%m' }[unit];
  const rows = await Sale.aggregate([
    ...(range ? [{ $match: { date: range } }] : []),
    {
      $group: {
        _id: {
          $dateTrunc: { date: '$date', unit, timezone: tz(), ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) },
        },
        invoices: { $sum: 1 },
        units: { $sum: { $sum: '$items.quantity' } },
        discount: { $sum: '$totalDiscount' },
        total: { $sum: '$totalAmount' },
        paid: { $sum: '$paidAmount' },
        credit: { $sum: '$creditAmount' },
      },
    },
    { $sort: { _id: -1 } },
    {
      $project: {
        _id: 0,
        period: { $dateToString: { date: '$_id', format: fmt, timezone: tz() } },
        invoices: 1,
        units: 1,
        discount: 1,
        total: 1,
        paid: 1,
        credit: 1,
      },
    },
  ]);
  rows.forEach((r) => {
    r2(r, ['discount', 'total', 'paid', 'credit']);
    if (unit === 'week') r.period = `Week of ${r.period}`;
  });
  return {
    columns: [
      { key: 'period', label: unit === 'day' ? 'Date' : unit === 'week' ? 'Week' : 'Month' },
      { key: 'invoices', label: 'Invoices', type: 'number' },
      { key: 'units', label: 'Units Sold', type: 'number' },
      { key: 'discount', label: 'Discount', type: 'money' },
      { key: 'total', label: 'Sales Amount', type: 'money' },
      { key: 'paid', label: 'Paid', type: 'money' },
      { key: 'credit', label: 'Credit', type: 'money' },
    ],
    rows,
  };
}

async function shopSales(range) {
  const rows = await Sale.aggregate([
    ...(range ? [{ $match: { date: range } }] : []),
    {
      $group: {
        _id: '$shop',
        shop: { $last: '$shopName' },
        invoices: { $sum: 1 },
        units: { $sum: { $sum: '$items.quantity' } },
        total: { $sum: '$totalAmount' },
        paid: { $sum: '$paidAmount' },
        credit: { $sum: '$creditAmount' },
      },
    },
    { $lookup: { from: 'shops', localField: '_id', foreignField: '_id', as: 's' } },
    {
      $project: {
        _id: 0,
        shop: 1,
        city: { $ifNull: [{ $first: '$s.city' }, ''] },
        invoices: 1,
        units: 1,
        total: 1,
        paid: 1,
        credit: 1,
      },
    },
    { $sort: { total: -1 } },
  ]);
  rows.forEach((r) => r2(r, ['total', 'paid', 'credit']));
  return {
    columns: [
      { key: 'shop', label: 'Shop' },
      { key: 'city', label: 'City' },
      { key: 'invoices', label: 'Invoices', type: 'number' },
      { key: 'units', label: 'Units', type: 'number' },
      { key: 'total', label: 'Sales Amount', type: 'money' },
      { key: 'paid', label: 'Paid at Sale', type: 'money' },
      { key: 'credit', label: 'Credit Given', type: 'money' },
    ],
    rows,
  };
}

async function productSales(range) {
  const rows = await Sale.aggregate([
    ...(range ? [{ $match: { date: range } }] : []),
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        product: { $last: '$items.productName' },
        units: { $sum: '$items.quantity' },
        gross: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } },
        discount: { $sum: { $multiply: ['$items.discount', '$items.quantity'] } },
        net: { $sum: '$items.lineTotal' },
        shops: { $addToSet: '$shop' },
      },
    },
    { $project: { _id: 0, product: 1, units: 1, gross: 1, discount: 1, net: 1, shops: { $size: '$shops' } } },
    { $sort: { net: -1 } },
  ]);
  rows.forEach((r) => r2(r, ['gross', 'discount', 'net']));
  return {
    columns: [
      { key: 'product', label: 'Product' },
      { key: 'units', label: 'Units Sold', type: 'number' },
      { key: 'shops', label: 'Shops', type: 'number' },
      { key: 'gross', label: 'Gross Amount', type: 'money' },
      { key: 'discount', label: 'Discount', type: 'money' },
      { key: 'net', label: 'Net Sales', type: 'money' },
    ],
    rows,
  };
}

async function stock() {
  const products = await Product.find({ isDeleted: false }).sort({ name: 1 }).lean();
  const rows = products.map((p) => ({
    product: p.name,
    brand: p.brand,
    price: p.price,
    discountedPrice: p.discountedPrice ?? '',
    quantity: p.quantity,
    value: round2(p.quantity * p.price),
  }));
  return {
    columns: [
      { key: 'product', label: 'Product' },
      { key: 'brand', label: 'Brand' },
      { key: 'price', label: 'Price', type: 'money' },
      { key: 'discountedPrice', label: 'Disc. Price', type: 'money' },
      { key: 'quantity', label: 'Available Stock', type: 'number' },
      { key: 'value', label: 'Stock Value', type: 'money' },
    ],
    rows,
  };
}

async function outstanding() {
  const shops = await Shop.find({ isDeleted: false }).sort({ outstandingBalance: -1, name: 1 }).lean();
  const sums = await shopSummaries(shops.map((s) => s._id));
  const rows = shops.map((s) => {
    const m = sums[String(s._id)] || emptySummary;
    return {
      shop: s.name,
      city: s.city,
      phone: s.phone,
      previous: s.openingBalance,
      sales: m.totalSales,
      received: m.totalReceived,
      outstanding: s.outstandingBalance,
    };
  });
  return {
    columns: [
      { key: 'shop', label: 'Shop' },
      { key: 'city', label: 'City' },
      { key: 'phone', label: 'Phone' },
      { key: 'previous', label: 'Previous Balance', type: 'money' },
      { key: 'sales', label: 'Total Sales', type: 'money' },
      { key: 'received', label: 'Total Received', type: 'money' },
      { key: 'outstanding', label: 'Outstanding', type: 'money' },
    ],
    rows,
  };
}

async function collections(range) {
  const payments = await Payment.find(range ? { date: range } : {}).sort({ date: -1 }).lean();
  const rows = payments.map((p) => ({
    date: p.date,
    shop: p.shopName,
    amount: p.amount,
    method: p.method,
    reference: p.referenceNumber,
    remaining: p.remainingBalance,
    notes: p.notes,
  }));
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'shop', label: 'Shop' },
      { key: 'amount', label: 'Collected', type: 'money' },
      { key: 'method', label: 'Method' },
      { key: 'reference', label: 'Reference' },
      { key: 'remaining', label: 'Balance After', type: 'money' },
      { key: 'notes', label: 'Notes' },
    ],
    rows,
  };
}

// Columns whose values make sense to add up in the totals row
const TOTAL_KEYS = {
  sales: ['invoices', 'units', 'discount', 'total', 'paid', 'credit'],
  'shop-sales': ['invoices', 'units', 'total', 'paid', 'credit'],
  'product-sales': ['units', 'gross', 'discount', 'net'],
  stock: ['quantity', 'value'],
  outstanding: ['previous', 'sales', 'received', 'outstanding'],
  collections: ['amount'],
};

router.get(
  '/:type',
  ah(async (req, res) => {
    const { type } = req.params;
    const range = dateRange(req.query.from, req.query.to);
    let report;
    if (type === 'sales') report = await salesByPeriod(req.query.group, range);
    else if (type === 'shop-sales') report = await shopSales(range);
    else if (type === 'product-sales') report = await productSales(range);
    else if (type === 'stock') report = await stock();
    else if (type === 'outstanding') report = await outstanding();
    else if (type === 'collections') report = await collections(range);
    else throw new HttpError(404, 'Unknown report');

    const totals = {};
    for (const k of TOTAL_KEYS[type]) totals[k] = round2(report.rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
    res.json({ ...report, totals });
  })
);

export default router;
