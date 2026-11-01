import { Router } from 'express';
import mongoose from 'mongoose';
import Sale from '../models/Sale.js';
import Shop from '../models/Shop.js';
import Product from '../models/Product.js';
import ShopTransaction from '../models/ShopTransaction.js';
import { changeShopBalance } from '../services/ledger.js';
import { ah, HttpError, round2, dateRange, escapeRegex, resolveEntryDate, startOfDay } from '../utils/helpers.js';

const router = Router();

const isDupKey = (err, field) => err?.code === 11000 && (!field || Object.keys(err.keyPattern || {}).includes(field));

// INV-YYMMDD-0001, numbered per day
async function nextInvoiceNumber(date) {
  const d = new Date(date);
  const prefix = `INV-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}-`;
  const last = await Sale.findOne({ invoiceNumber: new RegExp(`^${prefix}`) })
    .sort({ invoiceNumber: -1 })
    .select('invoiceNumber')
    .lean();
  const n = last ? Number(last.invoiceNumber.slice(prefix.length)) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

async function restoreStock(taken) {
  for (const t of taken) await Product.updateOne({ _id: t.product }, { $inc: { quantity: t.quantity } });
}

router.get(
  '/',
  ah(async (req, res) => {
    const { shop, status, search, from, to } = req.query;
    const q = {};
    const range = dateRange(from, to);
    if (range) q.date = range;
    if (shop && mongoose.isValidObjectId(shop)) q.shop = shop;
    if (['Paid', 'Partial', 'Credit'].includes(status)) q.paymentStatus = status;
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      q.$or = [{ invoiceNumber: rx }, { shopName: rx }, { 'items.productName': rx }];
    }
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    res.json(await Sale.find(q).sort({ date: -1, createdAt: -1 }).limit(limit).lean());
  })
);

router.get(
  '/:id',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Sale not found');
    const sale = await Sale.findById(req.params.id)
      .populate('shop', 'name ownerName phone city address outstandingBalance')
      .lean();
    if (!sale) throw new HttpError(404, 'Sale not found');
    res.json(sale);
  })
);

/*
  Create a sale (supply products to a shop).
  body: { shop, date?, items: [{ product, quantity, discount }], paidAmount, notes?, clientRequestId }
  - Prices always come from the product record; `discount` is ₹ off per unit.
  - Stock is reduced atomically and never below zero.
  - Unpaid part is added to the shop's outstanding balance and written to the ledger.
  - Same clientRequestId twice returns the first sale (no duplicate).
*/
router.post(
  '/',
  ah(async (req, res) => {
    const body = req.body || {};
    const clientRequestId = body.clientRequestId ? String(body.clientRequestId) : undefined;

    if (clientRequestId) {
      const existing = await Sale.findOne({ clientRequestId }).lean();
      if (existing) return res.status(200).json({ sale: existing, duplicate: true });
    }

    if (!mongoose.isValidObjectId(body.shop)) throw new HttpError(400, 'Please select a shop');
    const shop = await Shop.findOne({ _id: body.shop, isDeleted: false }).lean();
    if (!shop) throw new HttpError(400, 'Shop not found');

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) throw new HttpError(400, 'Add at least one product');

    const ids = rawItems.map((i) => String(i.product));
    if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new HttpError(400, 'Invalid product in the list');
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'A product is listed twice. Combine the quantities.');

    const products = await Product.find({ _id: { $in: ids }, isDeleted: false }).lean();
    const byId = Object.fromEntries(products.map((p) => [String(p._id), p]));

    const items = rawItems.map((raw) => {
      const p = byId[String(raw.product)];
      if (!p) throw new HttpError(400, 'One of the selected products no longer exists');
      const quantity = Number(raw.quantity);
      if (!Number.isInteger(quantity) || quantity < 1)
        throw new HttpError(400, `Enter a whole-number quantity for ${p.name}`);
      if (quantity > p.quantity) throw new HttpError(400, `Only ${p.quantity} of ${p.name} in stock`);
      const unitPrice = round2(p.price);
      const discount = round2(raw.discount || 0);
      if (!Number.isFinite(discount) || discount < 0 || discount > unitPrice)
        throw new HttpError(400, `Discount for ${p.name} must be between 0 and ₹${unitPrice}`);
      return {
        product: p._id,
        productName: p.name,
        quantity,
        unitPrice,
        discount,
        lineTotal: round2((unitPrice - discount) * quantity),
      };
    });

    const subTotal = round2(items.reduce((s, i) => s + i.unitPrice * i.quantity, 0));
    const totalDiscount = round2(items.reduce((s, i) => s + i.discount * i.quantity, 0));
    const totalAmount = round2(items.reduce((s, i) => s + i.lineTotal, 0));
    const paidAmount = round2(body.paidAmount || 0);
    if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new HttpError(400, 'Paid amount must be 0 or more');
    if (paidAmount > totalAmount) throw new HttpError(400, 'Paid amount cannot be more than the bill total');
    const creditAmount = round2(totalAmount - paidAmount);
    const paymentStatus = creditAmount === 0 ? 'Paid' : paidAmount === 0 ? 'Credit' : 'Partial';

    const date = resolveEntryDate(body.date);
    if (startOfDay(date) > startOfDay(new Date()))
      throw new HttpError(400, 'Sale date cannot be in the future');

    // 1. Reduce stock atomically (only if enough stock remains)
    const taken = [];
    for (const item of items) {
      const updated = await Product.findOneAndUpdate(
        { _id: item.product, isDeleted: false, quantity: { $gte: item.quantity } },
        { $inc: { quantity: -item.quantity } },
        { new: true }
      );
      if (!updated) {
        await restoreStock(taken);
        throw new HttpError(409, `Not enough stock for ${item.productName}. Refresh and try again.`);
      }
      taken.push({ product: item.product, quantity: item.quantity });
    }

    // 2. Save the sale with a unique invoice number
    let sale;
    try {
      for (let attempt = 0; attempt < 5 && !sale; attempt += 1) {
        try {
          sale = await Sale.create({
            invoiceNumber: await nextInvoiceNumber(date),
            clientRequestId,
            date,
            shop: shop._id,
            shopName: shop.name,
            items,
            subTotal,
            totalDiscount,
            totalAmount,
            paidAmount,
            creditAmount,
            paymentStatus,
            notes: String(body.notes || '').trim(),
            createdBy: req.user?._id,
          });
        } catch (err) {
          if (isDupKey(err, 'invoiceNumber')) continue; // another sale took the number, retry
          throw err;
        }
      }
      if (!sale) throw new HttpError(500, 'Could not generate an invoice number, please retry');
    } catch (err) {
      await restoreStock(taken);
      if (isDupKey(err, 'clientRequestId')) {
        const existing = await Sale.findOne({ clientRequestId }).lean();
        return res.status(200).json({ sale: existing, duplicate: true });
      }
      throw err;
    }

    // 3. Update the shop account and write the ledger entry
    const updatedShop = await changeShopBalance(shop._id, creditAmount);
    await ShopTransaction.create({
      shop: shop._id,
      type: 'Sale',
      sale: sale._id,
      date,
      description: `Invoice ${sale.invoiceNumber} (${items.length} item${items.length > 1 ? 's' : ''})${
        paidAmount > 0 ? `, ₹${paidAmount} paid on delivery` : ''
      }`,
      debit: totalAmount,
      credit: paidAmount,
      balanceAfter: updatedShop.outstandingBalance,
    });

    res.status(201).json({ sale, shopOutstanding: updatedShop.outstandingBalance });
  })
);

export default router;
