import { Router } from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Category from '../models/Category.js';
import { ah, HttpError, escapeRegex, round2 } from '../utils/helpers.js';

const router = Router();

function cleanProduct(body = {}) {
  const price = round2(body.price);
  let discountPercent = null;
  let discountedPrice = null;

  if (body.discountPercent !== '' && body.discountPercent !== null && body.discountPercent !== undefined) {
    const pct = round2(body.discountPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new HttpError(400, 'Discount percentage must be between 0 and 100');
    }
    discountPercent = pct;
    discountedPrice = pct > 0 ? round2(price * (1 - pct / 100)) : null;
  } else if (body.discountedPrice !== '' && body.discountedPrice !== null && body.discountedPrice !== undefined) {
    discountedPrice = round2(body.discountedPrice);
    if (price > 0 && discountedPrice < price) {
      discountPercent = round2(((price - discountedPrice) / price) * 100);
    }
  }

  const data = {
    name: String(body.name || '').trim(),
    brand: String(body.brand || 'Lazza').trim() || 'Lazza',
    category: body.category && mongoose.isValidObjectId(body.category) ? body.category : null,
    price,
    discountPercent,
    discountedPrice,
    description: String(body.description || '').trim(),
  };
  if (!data.name) throw new HttpError(400, 'Product name is required');
  if (!Number.isFinite(data.price) || data.price < 0) throw new HttpError(400, 'Purchase / Sale rate must be 0 or more');
  if (data.discountedPrice !== null) {
    if (!Number.isFinite(data.discountedPrice) || data.discountedPrice < 0)
      throw new HttpError(400, 'Discounted price must be 0 or more');
    if (data.discountedPrice > data.price)
      throw new HttpError(400, 'Discounted price cannot be more than the rate');
  }
  return data;
}

router.get(
  '/',
  ah(async (req, res) => {
    const { search, category } = req.query;
    const q = { isDeleted: false };
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      q.$or = [{ name: rx }, { brand: rx }, { description: rx }];
    }
    if (category && mongoose.isValidObjectId(category)) q.category = category;
    const products = await Product.find(q).populate('category', 'name').sort({ name: 1 }).lean();
    res.json(products);
  })
);

router.get(
  '/:id',
  ah(async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, isDeleted: false }).populate('category', 'name');
    if (!product) throw new HttpError(404, 'Product not found');
    res.json(product);
  })
);

router.post(
  '/',
  ah(async (req, res) => {
    const data = cleanProduct(req.body);
    const qty = Number(req.body.quantity ?? 0);
    if (!Number.isInteger(qty) || qty < 0) throw new HttpError(400, 'Quantity must be a whole number, 0 or more');
    if (data.category && !(await Category.exists({ _id: data.category }))) throw new HttpError(400, 'Category not found');
    const product = await Product.create({ ...data, quantity: qty });
    res.status(201).json(await product.populate('category', 'name'));
  })
);

// Edits product details. Stock is changed only through /:id/stock so that
// a stale edit form cannot overwrite stock that sales have since reduced.
router.put(
  '/:id',
  ah(async (req, res) => {
    const data = cleanProduct(req.body);
    if (data.category && !(await Category.exists({ _id: data.category }))) throw new HttpError(400, 'Category not found');
    const product = await Product.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, data, {
      new: true,
      runValidators: true,
    }).populate('category', 'name');
    if (!product) throw new HttpError(404, 'Product not found');
    res.json(product);
  })
);

// Manage available stock: { mode: 'add' | 'remove' | 'set', quantity }
router.patch(
  '/:id/stock',
  ah(async (req, res) => {
    const { mode } = req.body || {};
    const qty = Number(req.body?.quantity);
    if (!Number.isInteger(qty) || qty < 0) throw new HttpError(400, 'Quantity must be a whole number, 0 or more');
    let product;
    if (mode === 'add') {
      product = await Product.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { $inc: { quantity: qty } },
        { new: true }
      );
    } else if (mode === 'remove') {
      product = await Product.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false, quantity: { $gte: qty } },
        { $inc: { quantity: -qty } },
        { new: true }
      );
      if (!product && (await Product.exists({ _id: req.params.id, isDeleted: false })))
        throw new HttpError(400, 'Cannot remove more than the available stock');
    } else if (mode === 'set') {
      product = await Product.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { $set: { quantity: qty } },
        { new: true }
      );
    } else {
      throw new HttpError(400, 'mode must be add, remove or set');
    }
    if (!product) throw new HttpError(404, 'Product not found');
    res.json(await product.populate('category', 'name'));
  })
);

// Soft delete: the product disappears from lists, past sales still show it.
router.delete(
  '/:id',
  ah(async (req, res) => {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );
    if (!product) throw new HttpError(404, 'Product not found');
    res.json({ message: 'Product deleted' });
  })
);

export default router;
