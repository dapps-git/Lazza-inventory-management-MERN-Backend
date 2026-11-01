import { Router } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { ah } from '../utils/helpers.js';

const router = Router();

const sign = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

router.post(
  '/login',
  ah(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select('+password');
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    res.json({ token: sign(user._id), user: { id: user._id, name: user.name, email: user.email } });
  })
);

router.get('/me', protect, (req, res) => {
  res.json({ id: req.user._id, name: req.user.name, email: req.user.email });
});

export default router;
