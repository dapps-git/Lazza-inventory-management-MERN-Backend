import { Router } from 'express';
import Category from '../models/Category.js';
import Product from '../models/Product.js';
import { ah, HttpError } from '../utils/helpers.js';

const router = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const categories = await Category.find().sort({ name: 1 }).lean();
    const counts = await Product.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const map = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
    res.json(categories.map((c) => ({ ...c, productCount: map[String(c._id)] || 0 })));
  })
);

router.post(
  '/',
  ah(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new HttpError(400, 'Category name is required');
    const category = await Category.create({ name });
    res.status(201).json(category);
  })
);

router.put(
  '/:id',
  ah(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new HttpError(400, 'Category name is required');
    const category = await Category.findByIdAndUpdate(req.params.id, { name }, { new: true, runValidators: true });
    if (!category) throw new HttpError(404, 'Category not found');
    res.json(category);
  })
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const inUse = await Product.countDocuments({ category: req.params.id, isDeleted: false });
    if (inUse) throw new HttpError(400, `This category has ${inUse} product(s). Move or delete them first.`);
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) throw new HttpError(404, 'Category not found');
    res.json({ message: 'Category deleted' });
  })
);

export default router;
