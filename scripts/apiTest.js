/*
  End-to-end API test. Start the server first (npm run dev), then: npm run test:api
  Creates its own test shop and products (names start with "TEST-"), checks the
  stock, sale, credit and payment calculations, then deletes the test products/shop
  (soft delete, history kept).
*/
import 'dotenv/config';

const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}/api`;
let token = '';
let passed = 0;
let failed = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const tag = Date.now().toString().slice(-6);

async function main() {
  console.log(`Testing ${BASE}\n`);

  console.log('Auth');
  check('rejects wrong password', (await call('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, password: 'wrong' })).status === 401);
  const login = await call('POST', '/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  check('logs in', login.status === 200 && login.data.token, JSON.stringify(login.data));
  if (!login.data.token) return;
  token = login.data.token;
  check('protected route without token is 401', (await fetch(`${BASE}/products`)).status === 401);

  console.log('\nCategories & products');
  const cats = await call('GET', '/categories');
  check('default categories seeded', cats.data.length >= 5);
  const newCat = await call('POST', '/categories', { name: `TEST-Cat-${tag}` });
  check('creates category', newCat.status === 201);
  const dupCat = await call('POST', '/categories', { name: `test-cat-${tag}` });
  check('blocks duplicate category name', dupCat.status === 409);

  const cone = (await call('POST', '/products', { name: `TEST-Cone-${tag}`, category: cats.data[0]._id, price: 30, discountedPrice: 27, quantity: 100 })).data;
  const bar = (await call('POST', '/products', { name: `TEST-Bar-${tag}`, category: cats.data[1]._id, price: 20, quantity: 50 })).data;
  check('creates products', cone._id && bar._id);
  check('rejects discounted price above price', (await call('POST', '/products', { name: 'x', category: cats.data[0]._id, price: 10, discountedPrice: 12 })).status === 400);
  const edited = await call('PUT', `/products/${bar._id}`, { name: `TEST-Bar-${tag}`, category: cats.data[1]._id, price: 20, description: 'edited' });
  check('edits product without touching stock', edited.data.description === 'edited' && edited.data.quantity === 50);
  const search = await call('GET', `/products?search=TEST-Cone-${tag}`);
  check('search finds product', search.data.length === 1);
  check('add stock', (await call('PATCH', `/products/${bar._id}/stock`, { mode: 'add', quantity: 10 })).data.quantity === 60);
  check('cannot remove more than stock', (await call('PATCH', `/products/${bar._id}/stock`, { mode: 'remove', quantity: 999 })).status === 400);

  console.log('\nShops');
  const shop = (await call('POST', '/shops', { name: `TEST-Shop-${tag}`, city: 'Kochi', phone: '9999999999', openingBalance: 500 })).data;
  check('creates shop with previous balance', shop.outstandingBalance === 500);
  check('filter by city', (await call('GET', '/shops?city=kochi')).data.some((s) => s._id === shop._id));

  console.log('\nSales (₹5,000 supply, ₹2,000 paid → ₹3,000 credit)');
  // Top up bars so the bill is exactly ₹5,000: 100 cones × ₹30 + 100 bars × ₹20
  await call('PATCH', `/products/${bar._id}/stock`, { mode: 'add', quantity: 50 }); // bars: 110
  const saleBody = {
    shop: shop._id,
    items: [
      { product: cone._id, quantity: 100, discount: 0 },
      { product: bar._id, quantity: 100, discount: 0 },
    ],
    paidAmount: 2000,
    clientRequestId: `test-sale-${tag}`,
  };
  const sale = await call('POST', '/sales', saleBody);
  check('sale saved', sale.status === 201, JSON.stringify(sale.data));
  check('total = ₹5,000', sale.data.sale?.totalAmount === 5000);
  check('remaining credit = ₹3,000', sale.data.sale?.creditAmount === 3000);
  check('status Partial', sale.data.sale?.paymentStatus === 'Partial');
  check('shop outstanding = 500 + 3000', sale.data.shopOutstanding === 3500);

  const again = await call('POST', '/sales', saleBody);
  check('same request twice does not duplicate', again.data.duplicate === true && again.data.sale._id === sale.data.sale._id);

  const coneAfter = (await call('GET', `/products/${cone._id}`)).data;
  const barAfter = (await call('GET', `/products/${bar._id}`)).data;
  check('stock reduced once (cone 100 → 0)', coneAfter.quantity === 0);
  check('stock reduced once (bar 110 → 10)', barAfter.quantity === 10);

  const oversell = await call('POST', '/sales', { shop: shop._id, items: [{ product: bar._id, quantity: 11 }], paidAmount: 0 });
  check('cannot sell more than stock', oversell.status === 400);
  check('stock unchanged after failed sale', (await call('GET', `/products/${bar._id}`)).data.quantity === 10);

  const over = await call('POST', '/sales', { shop: shop._id, items: [{ product: bar._id, quantity: 1 }], paidAmount: 999 });
  check('paid more than bill is rejected', over.status === 400 && /more than the bill/.test(over.data.message));

  const discounted = await call('POST', '/sales', {
    shop: shop._id,
    items: [{ product: bar._id, quantity: 10, discount: 2 }],
    paidAmount: 0,
  });
  check('discounted full-credit sale: 10 × (20−2) = 180', discounted.data.sale?.totalAmount === 180 && discounted.data.sale?.paymentStatus === 'Credit');
  check('outstanding now 3680', discounted.data.shopOutstanding === 3680);

  console.log('\nPayments');
  const pay = await call('POST', '/payments', { shop: shop._id, amount: 1000, method: 'UPI', referenceNumber: 'UPI123', clientRequestId: `test-pay-${tag}` });
  check('payment saved', pay.status === 201, JSON.stringify(pay.data));
  check('remaining balance 2680', pay.data.payment?.remainingBalance === 2680);
  const payAgain = await call('POST', '/payments', { shop: shop._id, amount: 1000, method: 'UPI', clientRequestId: `test-pay-${tag}` });
  check('same payment twice does not duplicate', payAgain.data.duplicate === true);
  check('cannot collect more than outstanding', (await call('POST', '/payments', { shop: shop._id, amount: 99999, method: 'Cash' })).status === 400);
  check('needs a valid method', (await call('POST', '/payments', { shop: shop._id, amount: 1, method: 'Cheque' })).status === 400);

  console.log('\nShop account');
  const acc = (await call('GET', `/shops/${shop._id}`)).data;
  check('outstanding 2680', acc.outstandingBalance === 2680);
  check('total sales 5180', acc.summary.totalSales === 5180);
  check('total received 3000 (2000 at sale + 1000 collected)', acc.summary.totalReceived === 3000);
  check('records add up (500 + 5180 − 3000)', acc.summary.computedOutstanding === 2680);
  const ledger = (await call('GET', `/shops/${shop._id}/ledger`)).data;
  check('ledger has opening + 2 sales + 1 payment', ledger.entries.length === 4);
  check('ledger closing balance matches', ledger.closingBalance === 2680);
  check('cannot delete shop with balance', (await call('DELETE', `/shops/${shop._id}`)).status === 400);

  console.log('\nDashboard & reports');
  const dash = await call('GET', '/dashboard');
  check('dashboard loads', dash.status === 200 && dash.data.cards.todaySales >= 5180);
  for (const t of ['sales?group=day', 'sales?group=week', 'sales?group=month', 'shop-sales', 'product-sales', 'stock', 'outstanding', 'collections']) {
    const r = await call('GET', `/reports/${t}`);
    check(`report ${t}`, r.status === 200 && Array.isArray(r.data.rows), JSON.stringify(r.data).slice(0, 200));
  }
  const ps = (await call('GET', '/reports/product-sales')).data.rows.find((r) => r.product === `TEST-Bar-${tag}`);
  check('product report: bar 110 units, ₹20 discount', ps?.units === 110 && ps?.discount === 20);

  console.log('\nClean up');
  await call('POST', '/payments', { shop: shop._id, amount: 2680, method: 'Cash' });
  check('shop deletable once settled', (await call('DELETE', `/shops/${shop._id}`)).status === 200);
  check('sales history kept after shop delete', (await call('GET', `/sales?search=TEST-Shop-${tag}`)).data.length === 2);
  await call('DELETE', `/products/${cone._id}`);
  await call('DELETE', `/products/${bar._id}`);
  await call('DELETE', `/categories/${newCat.data._id}`);
  check('deleted product hidden from list', !(await call('GET', `/products?search=TEST-Cone-${tag}`)).data.length);

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('Note: test sales and payments stay in history by design (financial records are never deleted).');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
