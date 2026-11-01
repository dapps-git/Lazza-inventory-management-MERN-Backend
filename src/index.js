import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { protect } from './middleware/auth.js';
import { seedInitialData } from './utils/seed.js';
import authRoutes from './routes/auth.js';
import categoryRoutes from './routes/categories.js';
import productRoutes from './routes/products.js';
import shopRoutes from './routes/shops.js';
import saleRoutes from './routes/sales.js';
import paymentRoutes from './routes/payments.js';
import dashboardRoutes from './routes/dashboard.js';
import reportRoutes from './routes/reports.js';

process.env.TZ = process.env.TZ || 'Asia/Kolkata';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.use('/api/auth', authRoutes);
app.use('/api/categories', protect, categoryRoutes);
app.use('/api/products', protect, productRoutes);
app.use('/api/shops', protect, shopRoutes);
app.use('/api/sales', protect, saleRoutes);
app.use('/api/payments', protect, paymentRoutes);
app.use('/api/dashboard', protect, dashboardRoutes);
app.use('/api/reports', protect, reportRoutes);

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

// Error handler: turns validation / duplicate errors into readable messages
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ message: err.message });
  if (err.name === 'ValidationError') {
    return res.status(400).json({ message: Object.values(err.errors).map((e) => e.message).join(', ') });
  }
  if (err.name === 'CastError') return res.status(400).json({ message: `Invalid ${err.path}` });
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'value';
    return res.status(409).json({ message: `This ${field} already exists` });
  }
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 5000;
connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lazza_distributor')
  .then(async () => {
    await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()));
    await seedInitialData();
    app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
