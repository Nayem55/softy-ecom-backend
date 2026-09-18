const { MongoClient } = require('mongodb');
function scopedDB(db, prefix = 'ecom_') {
  if (!/^ecom_(?:test_[a-z0-9]+_)?$/.test(prefix)) throw new Error('Unsafe collection prefix');
  return { collection(name) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid collection name');
    return db.collection(prefix + name);
  }, async ping() { await db.command({ ping: 1 }); } };
}
async function connect(uri = process.env.MONGO_URI) {
  if (!uri) throw new Error('MONGO_URI is required');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000, connectTimeoutMS: 6000, socketTimeoutMS: 15000 });
  await client.connect();
  return { client, db: scopedDB(client.db()) };
}
async function indexes(db) {
  for (const [name, keys, opts] of [
    ['products', { slug: 1 }, { unique: true }], ['categories', { slug: 1 }, { unique: true }],
    ['subcategories', { slug: 1 }, { unique: true }], ['brands', { slug: 1 }, { unique: true }],
    ['pages', { slug: 1 }, { unique: true }], ['users', { email: 1 }, { unique: true }],
    ['admins', { email: 1 }, { unique: true }], ['newsletter', { email: 1 }, { unique: true }],
    ['coupons', { code: 1 }, { unique: true }], ['carts', { user: 1 }, { unique: true }],
    ['wishlists', { user: 1, product: 1 }, { unique: true }],
    ['orders', { orderId: 1 }, { unique: true }],
    ['orders', { idempotencyKey: 1 }, { unique: true, sparse: true }],
    ['orders', { paymentReference: 1 }, { unique: true, sparse: true }],
    ['orders', { user: 1, createdAt: -1 }, {}], ['orders', { status: 1, createdAt: 1 }, {}],
    ['reviews', { product: 1, isApproved: 1 }, {}], ['contacts', { createdAt: -1 }, {}],
  ]) await db.collection(name).createIndex(keys, opts);
}
module.exports = { scopedDB, connect, indexes };
