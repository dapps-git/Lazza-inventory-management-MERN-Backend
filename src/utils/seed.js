import User from '../models/User.js';
import Category from '../models/Category.js';

export const DEFAULT_CATEGORIES = [
  'Cone Ice Cream',
  'Choco Bar',
  'Sip Up',
  '1 Litre Cup Ice Cream',
  'Other Varieties',
];

// Runs on every start; only creates what is missing.
export async function seedInitialData() {
  if ((await Category.countDocuments()) === 0) {
    await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ name })));
    console.log('Seeded default product categories');
  }
  if ((await User.countDocuments()) === 0) {
    const { ADMIN_NAME = 'Admin', ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      console.warn('No users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the first admin.');
      return;
    }
    await User.create({ name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    console.log(`Created admin user ${ADMIN_EMAIL}`);
  }
}
