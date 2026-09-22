require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { connectDB, getDB } = require('./config/db');
const { adminAuth, generateToken } = require('./middleware/auth');
const { sendOrderConfirmation } = require('./utils/email');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const allowedOrigins = [
  'http://localhost:1001',
  'http://127.0.0.1:1001',
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    try {
      const { hostname } = new URL(origin);
      if (allowedOrigins.includes(origin) || hostname.endsWith('.vercel.app')) {
        return callback(null, true);
      }
    } catch {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
const localUploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(localUploadDir, { recursive: true });
app.use('/uploads', express.static(localUploadDir, { maxAge: '7d', fallthrough: false }));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'demo',
  api_key: process.env.CLOUDINARY_API_KEY || 'demo',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'demo',
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const singleUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum upload size is 5 MB.' : err.message;
    return res.status(400).json({ error: message, message });
  });
};
const multipleUpload = (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'One or more files are too large. Maximum upload size is 5 MB each.' : err.message;
    return res.status(400).json({ error: message, message });
  });
};

const slugify = (t) => t.toString().toLowerCase().replace(/\s+/g,'-').replace(/[^\w\-]+/g,'').replace(/\-\-+/g,'-').replace(/^-+/,'').replace(/-+$/,'');
const genOrderId = () => 'SOFTY-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2,6).toUpperCase();
const DEFAULT_SHIPPING_SETTINGS = {
  insideDhakaCharge: 60,
  outsideDhakaCharge: 120,
  freeShippingEnabled: true,
  freeShippingMin: 3000,
};
const toBool = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};
const numOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const pricingFromInput = (input = {}, base = {}) => {
  const existingRegular = numOrNull(base.regularPrice) || (numOrNull(base.comparePrice) && numOrNull(base.comparePrice) > numOrNull(base.price) ? numOrNull(base.comparePrice) : numOrNull(base.price));
  const existingSale = numOrNull(base.salePrice) || numOrNull(base.price);
  const regularPrice = numOrNull(input.regularPrice ?? input.comparePrice) ?? existingRegular ?? numOrNull(input.price) ?? 0;
  let salePrice = numOrNull(input.salePrice);
  const discountPercent = numOrNull(input.discountPercent);
  const isOnSale = input.isOnSale !== undefined ? toBool(input.isOnSale, false) : toBool(base.isOnSale, false);

  if (discountPercent !== null && regularPrice > 0) {
    salePrice = Math.round(regularPrice * (1 - Math.min(Math.max(discountPercent, 0), 100) / 100));
  }
  if (salePrice === null) salePrice = isOnSale ? existingSale : null;

  const validSale = isOnSale && salePrice !== null && salePrice > 0 && salePrice < regularPrice;
  return {
    regularPrice,
    salePrice: validSale ? salePrice : null,
    isOnSale: validSale,
    price: validSale ? salePrice : regularPrice,
    comparePrice: validSale ? regularPrice : null,
  };
};
const mergePricingUpdate = (update, base = {}) => {
  const pricingKeys = ['regularPrice', 'salePrice', 'isOnSale', 'discountPercent', 'price', 'comparePrice'];
  if (!pricingKeys.some((key) => Object.prototype.hasOwnProperty.call(update, key))) return update;
  const next = { ...update, ...pricingFromInput(update, base) };
  delete next.discountPercent;
  return next;
};
const toIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'object') return String(value._id || value.id || value);
  return String(value);
};
const uniqueIdList = (value) => {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(source.map(toIdString).filter(Boolean))];
};
const addFilterCondition = (filter, condition) => {
  if (!filter.$and) filter.$and = [];
  filter.$and.push(condition);
};
const taxonomyFilter = (legacyField, arrayField, value) => ({
  $or: [{ [legacyField]: value }, { [arrayField]: value }],
});
const normalizeProductTaxonomy = async (db, input = {}) => {
  const categoryIds = uniqueIdList(input.categories);
  uniqueIdList(input.category).forEach((id) => {
    if (!categoryIds.includes(id)) categoryIds.push(id);
  });

  const subcategoryIds = uniqueIdList(input.subcategories);
  uniqueIdList(input.subcategory).forEach((id) => {
    if (!subcategoryIds.includes(id)) subcategoryIds.push(id);
  });

  if (subcategoryIds.length) {
    const objectIds = subcategoryIds.filter(ObjectId.isValid).map((id) => ObjectId.createFromHexString(id));
    const subFilter = objectIds.length
      ? { $or: [{ _id: { $in: objectIds } }, { slug: { $in: subcategoryIds } }] }
      : { slug: { $in: subcategoryIds } };
    const selectedSubcategories = await db.collection('subcategories').find(subFilter).toArray();
    selectedSubcategories.forEach((subcategory) => {
      const parentCategoryId = toIdString(subcategory.category);
      const subcategoryId = subcategory._id?.toString();
      if (subcategoryId && !subcategoryIds.includes(subcategoryId)) subcategoryIds.push(subcategoryId);
      if (parentCategoryId && !categoryIds.includes(parentCategoryId)) categoryIds.push(parentCategoryId);
    });
  }

  return {
    category: categoryIds[0] || '',
    subcategory: subcategoryIds[0] || '',
    categories: categoryIds,
    subcategories: subcategoryIds,
  };
};
const shippingSettingsOf = (settings = {}) => ({
  ...DEFAULT_SHIPPING_SETTINGS,
  ...(settings.shippingSettings || {}),
});
const calculateDeliveryCharge = (subtotal, district, settings = {}) => {
  const shipping = shippingSettingsOf(settings);
  if (shipping.freeShippingEnabled !== false && subtotal >= Number(shipping.freeShippingMin || 0)) return 0;
  return String(district || '').trim().toLowerCase() === 'dhaka'
    ? Number(shipping.insideDhakaCharge || 0)
    : Number(shipping.outsideDhakaCharge || 0);
};
const hasCloudinaryConfig = () =>
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET &&
  process.env.CLOUDINARY_CLOUD_NAME !== 'demo' &&
  process.env.CLOUDINARY_API_KEY !== 'demo' &&
  process.env.CLOUDINARY_API_SECRET !== 'demo';
const uploadBufferToCloudinary = (file) => new Promise((resolve, reject) => {
  if (!hasCloudinaryConfig()) {
    const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype];
    if (!extension) { reject(new Error('Upload a JPG, PNG, WebP, or GIF image.')); return; }
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`;
    fs.writeFile(path.join(localUploadDir, filename), file.buffer, error => error
      ? reject(error)
      : resolve({ secure_url: `/uploads/${filename}`, public_id: filename }));
    return;
  }
  const options = { folder: 'softy-ecommerce', resource_type: 'auto' };
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || process.env.CLOUDINARY_PRESET || process.env.UPLOAD_PRESET;
  if (uploadPreset) options.upload_preset = uploadPreset;
  const stream = cloudinary.uploader.upload_stream(
    options,
    (error, result) => error ? reject(error) : resolve(result)
  );
  stream.end(file.buffer);
});
const sendUploadError = (res, err) => {
  const status = err.http_code || err.statusCode || 500;
  const message = err.message || 'Image upload failed';
  console.error('Cloudinary upload failed:', message);
  res.status(status).json({ error: message, message });
};
const normalizeOrder = (order) => order ? ({
  ...order,
  orderNumber: order.orderNumber || order.orderId,
  totalAmount: order.totalAmount ?? order.total,
  shippingAddress: order.shippingAddress || order.shippingInfo,
  bkashTransactionId: order.bkashTransactionId || order.bkashTrxId || '',
  items: (order.items || order.orderItems || []).map(item => ({
    ...item,
    quantity: item.quantity ?? item.qty,
    qty: item.qty ?? item.quantity,
  })),
}) : order;

async function seedAdmin() {
  const db = getDB();
  const ex = await db.collection('admins').findOne({ email: process.env.ADMIN_EMAIL });
  if (!ex) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await db.collection('admins').insertOne({ email: process.env.ADMIN_EMAIL, password: hash, name: 'Softy Admin', createdAt: new Date() });
    console.log('Admin seeded');
  }
}

async function seedSettings() {
  const db = getDB();
  const ex = await db.collection('siteSettings').findOne({});
  if (!ex) {
    await db.collection('siteSettings').insertOne({
      logo: '/brand/softy-ecom-logo-v2.png', favicon: '/favicon.svg', companyName: 'Softy', slogan: 'Gentle care for real skin.',
      contact: { email: 'globalcosmeticslines@gmail.com', phone: '01911-238421', address: '64/68 North Kamalapur, Dhaka - 1217, Bangladesh', hours: 'Saturday to Thursday: 9:00 AM to 6:00 PM' },
      social: { fb: '', ig: '', tiktok: '', yt: '' },
      footerAbout: 'Thoughtfully formulated skincare for a cleaner, brighter, healthier routine.',
      bkashNumber: '', deliveryInfo: 'Free delivery on orders over BDT 1,500.',
      shippingSettings: DEFAULT_SHIPPING_SETTINGS,
      returnPolicy: 'Eligible unopened products can be reviewed for exchange within 7 days of delivery.',
      terms: 'By using our site you agree to our terms and conditions.',
      announcementText: 'FREE DELIVERY ON ORDERS OVER BDT 1,500 | 100% ORIGINAL PRODUCTS | EASY RETURNS',
      headerCategoryMenu: { enabled: true, label: 'Categories', showEmptyCategories: true },
      headerBrandMenu: { enabled: true, label: 'Brands' },
      navLinks: [
        { label: 'Shop', url: '/shop', active: true, accent: false },
        { label: 'Skin Care', url: '/shop?category=face-care', active: true, accent: false },
        { label: 'Best Sellers', url: '/shop?isBestSeller=true', active: true, accent: false },
        { label: 'About', url: '/about', active: true, accent: false },
      ],
      createdAt: new Date(),
    });
    console.log('Settings seeded');
  } else if (['/brand/softyy-logo.png', '/brand/softy-ecom-logo.png'].includes(ex.logo)) {
    await db.collection('siteSettings').updateOne(
      { _id: ex._id },
      { $set: { logo: '/brand/softy-ecom-logo-v2.png', updatedAt: new Date() } }
    );
  }
}

async function createIndexes() {
  const db = getDB();
  await db.collection('products').createIndex({ name: 'text', description: 'text', tags: 'text' });
  await db.collection('products').createIndex({ slug: 1 }, { unique: true });
  await db.collection('categories').createIndex({ slug: 1 }, { unique: true });
  await db.collection('brands').createIndex({ slug: 1 }, { unique: true });
  await db.collection('orders').createIndex({ orderId: 1 });
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('coupons').createIndex({ code: 1 }, { unique: true });
  await db.collection('newsletter').createIndex({ email: 1 }, { unique: true });
}
// ============ AUTH ROUTES ============
app.post('/api/auth/register', async (req, res) => {
  try {
    const db = getDB();
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
    const exists = await db.collection('users').findOne({ email });
    if (exists) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const user = { name, email, password: hash, phone: phone || '', addresses: [], createdAt: new Date() };
    const result = await db.collection('users').insertOne(user);
    const token = generateToken({ _id: result.insertedId });
    res.json({ token, user: { _id: result.insertedId, name, email, phone } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const db = getDB();
    const { email, password } = req.body;
    const user = await db.collection('users').findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    const token = generateToken(user);
    res.json({ token, user: { _id: user._id, name: user.name, email: user.email, phone: user.phone } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.json({ user: null });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const user = await db.collection('users').findOne({ _id: ObjectId.createFromHexString(decoded.id) }, { projection: { password: 0 } });
    res.json({ user });
  } catch (err) { res.json({ user: null }); }
});

app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const db = getDB();
    const { email, password } = req.body;
    const admin = await db.collection('admins').findOne({ email });
    if (!admin) return res.status(400).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    const token = generateToken(admin, 'admin');
    res.json({ token, admin: { _id: admin._id, name: admin.name, email: admin.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/admin/me', adminAuth, (req, res) => { res.json({ admin: req.admin }); });
// ============ PRODUCT ROUTES ============
app.get('/api/products', async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 20, category, subcategory, brand, search, q, minPrice, maxPrice, sort, isTrending, isNew, isBestSeller, isFeatured, isBridal } = req.query;
    const searchTerm = (search || q || '').trim();
    const filter = { isActive: true };
    if (category) {
      const cat = await db.collection('categories').findOne(ObjectId.isValid(category) ? { _id: ObjectId.createFromHexString(category) } : { slug: category });
      addFilterCondition(filter, taxonomyFilter('category', 'categories', cat ? cat._id.toString() : category));
    }
    if (subcategory) {
      const sub = await db.collection('subcategories').findOne(ObjectId.isValid(subcategory) ? { _id: ObjectId.createFromHexString(subcategory) } : { slug: subcategory });
      addFilterCondition(filter, taxonomyFilter('subcategory', 'subcategories', sub ? sub._id.toString() : subcategory));
    }
    if (brand) {
      const b = await db.collection('brands').findOne(ObjectId.isValid(brand) ? { _id: ObjectId.createFromHexString(brand) } : { slug: brand });
      filter.brand = b ? b._id.toString() : brand;
    }
    if (searchTerm) {
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { description: { $regex: searchTerm, $options: 'i' } },
        { tags: { $regex: searchTerm, $options: 'i' } },
      ];
    }
    if (minPrice || maxPrice) { filter.price = {}; if (minPrice) filter.price.$gte = Number(minPrice); if (maxPrice) filter.price.$lte = Number(maxPrice); }
    if (isTrending === 'true') filter.isTrending = true;
    if (isNew === 'true') filter.isNew = true;
    if (isBestSeller === 'true') filter.isBestSeller = true;
    if (isFeatured === 'true') filter.isFeatured = true;
    if (isBridal === 'true') filter.isBridal = true;
    let sortObj = { createdAt: -1 };
    if (sort === 'price' || sort === 'price_asc') sortObj = { price: 1 };
    else if (sort === '-price' || sort === 'price_desc') sortObj = { price: -1 };
    else if (sort === 'name') sortObj = { name: 1 };
    else if (sort === '-name') sortObj = { name: -1 };
    else if (sort === '-sold' || sort === 'popular') sortObj = { sold: -1 };
    else if (sort === '-averageRating') sortObj = { averageRating: -1 };
    else if (sort === '-createdAt') sortObj = { createdAt: -1 };
    else if (sort === 'createdAt') sortObj = { createdAt: 1 };
    const skip = (Number(page) - 1) * Number(limit);
    const products = await db.collection('products').find(filter).sort(sortObj).skip(skip).limit(Number(limit)).toArray();
    const total = await db.collection('products').countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / Number(limit)));
    res.json({ products, total, totalProducts: total, page: Number(page), pages, totalPages: pages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/featured', async (req, res) => {
  try {
    const db = getDB();
    const products = await db.collection('products').find({ isActive: true, isFeatured: true }).limit(10).toArray();
    res.json({ products });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const db = getDB();
    let product;
    if (ObjectId.isValid(req.params.id)) {
      product = await db.collection('products').findOne({ _id: ObjectId.createFromHexString(req.params.id) });
    } else {
      product = await db.collection('products').findOne({ slug: req.params.id });
    }
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const reviews = await db.collection('reviews').find({ product: product._id.toString(), isApproved: true }).sort({ createdAt: -1 }).limit(20).toArray();
    res.json({ product, reviews });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const db = getDB();
    let productId = req.params.id;
    if (!ObjectId.isValid(productId)) {
      const product = await db.collection('products').findOne({ slug: productId });
      if (!product) return res.status(404).json({ error: 'Product not found' });
      productId = product._id.toString();
    }
    const reviews = await db.collection('reviews').find({ product: productId, isApproved: true }).sort({ createdAt: -1 }).toArray();
    res.json({ reviews });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/products/:id/reviews', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    let productId = req.params.id;
    if (!ObjectId.isValid(productId)) {
      const product = await db.collection('products').findOne({ slug: productId });
      if (!product) return res.status(404).json({ error: 'Product not found' });
      productId = product._id.toString();
    }
    const { rating, comment } = req.body;
    if (!rating) return res.status(400).json({ error: 'Rating required' });
    const review = { product: productId, user: decoded.id, rating: Number(rating), comment: comment || '', isApproved: false, createdAt: new Date() };
    const result = await db.collection('reviews').insertOne(review);
    res.json({ review: { ...review, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Products
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 50, search, q, category, isActive } = req.query;
    const searchTerm = (search || q || '').trim();
    const filter = {};
    if (searchTerm) {
      const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchOr = [
        { name: { $regex: escaped, $options: 'i' } },
        { slug: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
        { tags: { $elemMatch: { $regex: escaped, $options: 'i' } } },
        { tags: { $regex: escaped, $options: 'i' } },
      ];
      if (ObjectId.isValid(searchTerm)) searchOr.push({ _id: ObjectId.createFromHexString(searchTerm) });
      const [matchedCategories, matchedBrands] = await Promise.all([
        db.collection('categories').find({ name: { $regex: escaped, $options: 'i' } }, { projection: { _id: 1 } }).toArray(),
        db.collection('brands').find({ name: { $regex: escaped, $options: 'i' } }, { projection: { _id: 1 } }).toArray(),
      ]);
      matchedCategories.forEach((item) => {
        searchOr.push({ category: item._id.toString() });
        searchOr.push({ categories: item._id.toString() });
      });
      matchedBrands.forEach((item) => searchOr.push({ brand: item._id.toString() }));
      filter.$or = searchOr;
    }
    if (category) addFilterCondition(filter, taxonomyFilter('category', 'categories', category));
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    const skip = (Number(page) - 1) * Number(limit);
    const products = await db.collection('products').find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray();
    const total = await db.collection('products').countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / Number(limit)));
    res.json({ products, total, totalProducts: total, page: Number(page), pages, totalPages: pages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const cleanText = (value) => (typeof value === 'string' ? value.trim() : '');

app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { name, description, shortDescription, additionalNote, images, brand, colors, stock, tags, isTrending, isFeatured, isBestSeller, isNew, isBridal } = req.body;
    const pricing = pricingFromInput(req.body);
    const taxonomy = await normalizeProductTaxonomy(db, req.body);
    if (!name || !pricing.regularPrice) return res.status(400).json({ error: 'Name and regular price required' });

    const product = {
      name, slug: slugify(name) + '-' + Date.now().toString(36), description: description || '', shortDescription: cleanText(shortDescription), additionalNote: cleanText(additionalNote),
      ...pricing,
      ...taxonomy,
      images: images || [], brand: brand || '',
      colors: colors || [], stock: stock || 0, tags: tags || [],
      isTrending: !!isTrending, isFeatured: !!isFeatured, isBestSeller: !!isBestSeller, isNew: isNew !== false, isBridal: !!isBridal,
      isActive: true, createdAt: new Date(),
    };
    const result = await db.collection('products').insertOne(product);
    res.json({ product: { ...product, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products/bulk-delete', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const ids = (req.body.ids || []).filter(ObjectId.isValid).map(id => ObjectId.createFromHexString(id));
    if (!ids.length) return res.status(400).json({ error: 'No valid product IDs supplied' });
    const result = await db.collection('products').deleteMany({ _id: { $in: ids } });
    res.json({ success: true, count: result.deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products/import', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'No products provided' });

    const categories = await db.collection('categories').find({}).toArray();
    const subcategories = await db.collection('subcategories').find({}).toArray();
    const catMap = {};
    categories.forEach(c => { catMap[c.name.toLowerCase().trim()] = c._id.toString(); });
    const subMap = {};
    subcategories.forEach(s => { subMap[s.name.toLowerCase().trim()] = s._id.toString(); });

    const results = { success: 0, errors: [] };

    for (let i = 0; i < products.length; i++) {
      const row = products[i];
      const rowNum = i + 1;
      try {
        const name = (row.Name || '').trim();
        if (!name) { results.errors.push({ row: rowNum, error: 'Missing product name' }); continue; }

        const regularPrice = Number(row.Price || row.RegularPrice || 0);
        if (regularPrice <= 0) { results.errors.push({ row: rowNum, error: 'Invalid or missing price' }); continue; }

        const salePrice = Number(row.SalePrice || 0);
        const isOnSale = salePrice > 0 && salePrice < regularPrice;

        const categoryId = row.Category ? (catMap[row.Category.toLowerCase().trim()] || '') : '';
        const subcategoryId = row.Subcategory ? (subMap[row.Subcategory.toLowerCase().trim()] || '') : '';
        const subcategoryDoc = subcategoryId ? subcategories.find((sub) => sub._id.toString() === subcategoryId) : null;
        const categoryIds = categoryId ? [categoryId] : [];
        const subcategoryParentId = toIdString(subcategoryDoc?.category);
        if (subcategoryParentId && !categoryIds.includes(subcategoryParentId)) categoryIds.push(subcategoryParentId);
        const subcategoryIds = subcategoryId ? [subcategoryId] : [];

        const colors = row.Colors ? row.Colors.split(',').map(c => c.trim()).filter(Boolean) : [];
        const tags = row.Tags ? row.Tags.split(',').map(t => t.trim()).filter(Boolean) : [];
        const images = row.Images ? row.Images.split(',').map(u => u.trim()).filter(Boolean) : [];

        const price = isOnSale ? salePrice : regularPrice;
        const slug = slugify(name) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

        const product = {
          name,
          slug,
          description: row.Description || '',
          regularPrice,
          salePrice: isOnSale ? salePrice : null,
          comparePrice: isOnSale ? regularPrice : null,
          price,
          isOnSale,
          stock: Number(row.Stock || 0),
          category: categoryIds[0] || '',
          subcategory: subcategoryIds[0] || '',
          categories: categoryIds,
          subcategories: subcategoryIds,
          images,
          colors,
          tags,
          isNew: row.IsNew !== 'false' && row.IsNew !== '0',
          isTrending: row.IsTrending === 'true' || row.IsTrending === '1',
          isFeatured: row.IsFeatured === 'true' || row.IsFeatured === '1',
          isBestSeller: row.IsBestSeller === 'true' || row.IsBestSeller === '1',
          isBridal: row.IsBridal === 'true' || row.IsBridal === '1',
          isActive: true,
          createdAt: new Date(),
        };

        await db.collection('products').insertOne(product);
        results.success++;
      } catch (err) {
        results.errors.push({ row: rowNum, error: err.message });
      }
    }

    res.json({ success: true, ...results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/products/bulk-update', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const ids = (req.body.ids || []).filter(ObjectId.isValid).map(id => ObjectId.createFromHexString(id));
    let updates = req.body.updates || req.body.data || {};
    delete updates._id;
    delete updates.categoryRows;
    if (!ids.length) return res.status(400).json({ error: 'No valid product IDs supplied' });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updates supplied' });
    const hasTaxonomyUpdate = ['category', 'categories', 'subcategory', 'subcategories'].some((key) => Object.prototype.hasOwnProperty.call(updates, key));
    if (hasTaxonomyUpdate) updates = { ...updates, ...(await normalizeProductTaxonomy(db, updates)) };
    const needsPerProductPricing = ['regularPrice', 'salePrice', 'isOnSale', 'discountPercent', 'price', 'comparePrice'].some((key) => Object.prototype.hasOwnProperty.call(updates, key));
    if (needsPerProductPricing) {
      const products = await db.collection('products').find({ _id: { $in: ids } }).toArray();
      await Promise.all(products.map((product) => {
        const next = mergePricingUpdate({ ...updates }, product);
        next.updatedAt = new Date();
        return db.collection('products').updateOne({ _id: product._id }, { $set: next });
      }));
      return res.json({ success: true, count: products.length });
    }
    updates.updatedAt = new Date();
    const result = await db.collection('products').updateMany({ _id: { $in: ids } }, { $set: updates });
    res.json({ success: true, count: result.modifiedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/products/bulk', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { ids = [], action, data = {} } = req.body;
    const objectIds = ids.filter(ObjectId.isValid).map(id => ObjectId.createFromHexString(id));
    if (!objectIds.length) return res.status(400).json({ error: 'No valid product IDs supplied' });
    if (action === 'delete') {
      const result = await db.collection('products').deleteMany({ _id: { $in: objectIds } });
      return res.json({ success: true, count: result.deletedCount });
    }
    if (action === 'update') {
      delete data._id;
      delete data.categoryRows;
      const hasTaxonomyUpdate = ['category', 'categories', 'subcategory', 'subcategories'].some((key) => Object.prototype.hasOwnProperty.call(data, key));
      if (hasTaxonomyUpdate) Object.assign(data, await normalizeProductTaxonomy(db, data));
      data.updatedAt = new Date();
      const result = await db.collection('products').updateMany({ _id: { $in: objectIds } }, { $set: data });
      return res.json({ success: true, count: result.modifiedCount });
    }
    res.status(400).json({ error: 'Invalid bulk action' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const existing = await db.collection('products').findOne({ _id: ObjectId.createFromHexString(req.params.id) });
    const update = mergePricingUpdate({ ...req.body }, existing || {});
    delete update._id;
    delete update.categoryRows;
    if (Object.prototype.hasOwnProperty.call(update, 'additionalNote')) update.additionalNote = cleanText(update.additionalNote);
    if (Object.prototype.hasOwnProperty.call(update, 'shortDescription')) update.shortDescription = cleanText(update.shortDescription);
    if (update.name && !update.slug) update.slug = slugify(update.name) + '-' + req.params.id;
    const hasTaxonomyUpdate = ['category', 'categories', 'subcategory', 'subcategories'].some((key) => Object.prototype.hasOwnProperty.call(update, key));
    if (hasTaxonomyUpdate) Object.assign(update, await normalizeProductTaxonomy(db, update));

    delete update.sizes;
    delete update.stitchVariations;

    update.updatedAt = new Date();
    await db.collection('products').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    await db.collection('products').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ CATEGORY ROUTES ============
app.get('/api/categories', async (req, res) => {
  try {
    const db = getDB();
    const categories = await db.collection('categories').find({}).sort({ order: 1, createdAt: 1 }).toArray();
    res.json({ categories });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const categories = await db.collection('categories').find({}).sort({ order: 1, createdAt: 1 }).toArray();
    res.json({ categories });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { name, slug, image, description, metaTitle, metaDescription, order, isActive } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const category = { name, slug: slug || slugify(name), image: image || '', description: description || '', metaTitle: metaTitle || '', metaDescription: metaDescription || '', order: Number(order) || 0, isActive: toBool(isActive, true), createdAt: new Date() };
    const result = await db.collection('categories').insertOne(category);
    res.json({ category: { ...category, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const update = { ...req.body }; delete update._id;
    if (update.name && !update.slug) update.slug = slugify(update.name);
    if (update.order !== undefined) update.order = Number(update.order) || 0;
    if (update.isActive !== undefined) update.isActive = toBool(update.isActive, true);
    await db.collection('categories').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    await db.collection('categories').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SUBCATEGORY ROUTES ============
app.get('/api/subcategories', async (req, res) => {
  try {
    const db = getDB();
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    const subs = await db.collection('subcategories').find(filter).sort({ order: 1 }).toArray();
    res.json({ subcategories: subs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/subcategories', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    const subcategories = await db.collection('subcategories').find(filter).sort({ order: 1 }).toArray();
    res.json({ subcategories });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/subcategories', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { name, slug, image, category, order, isActive } = req.body;
    if (!name || !category) return res.status(400).json({ error: 'Name and category required' });
    const sub = { name, slug: slug || slugify(name), image: image || '', category, order: Number(order) || 0, isActive: toBool(isActive, true), createdAt: new Date() };
    const result = await db.collection('subcategories').insertOne(sub);
    res.json({ subcategory: { ...sub, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/subcategories/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const update = { ...req.body }; delete update._id;
    if (update.name && !update.slug) update.slug = slugify(update.name);
    if (update.order !== undefined) update.order = Number(update.order) || 0;
    if (update.isActive !== undefined) update.isActive = toBool(update.isActive, true);
    await db.collection('subcategories').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/subcategories/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    await db.collection('subcategories').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ BRAND ROUTES ============
app.get('/api/brands', async (req, res) => {
  try {
    const db = getDB();
    const brands = await db.collection('brands').find({}).sort({ createdAt: 1 }).toArray();
    res.json({ brands });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/brands', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const brands = await db.collection('brands').find({}).sort({ createdAt: 1 }).toArray();
    res.json({ brands });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/brands', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { name, slug, logo, description, isActive } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const brand = { name, slug: slug || slugify(name), logo: logo || '', description: description || '', isActive: toBool(isActive, true), createdAt: new Date() };
    const result = await db.collection('brands').insertOne(brand);
    res.json({ brand: { ...brand, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/brands/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const update = { ...req.body }; delete update._id;
    if (update.name && !update.slug) update.slug = slugify(update.name);
    if (update.isActive !== undefined) update.isActive = toBool(update.isActive, true);
    await db.collection('brands').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/brands/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    await db.collection('brands').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ============ BANNER ROUTES ============
app.get('/api/banners', async (req, res) => {
  try { const db = getDB(); const banners = await db.collection('banners').find({ isActive: true }).sort({ order: 1 }).toArray(); res.json({ banners }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/banners', adminAuth, async (req, res) => {
  try { const db = getDB(); const banners = await db.collection('banners').find({}).sort({ order: 1 }).toArray(); res.json({ banners }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/banners', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { title, subtitle, description, image, mobileImage, linkText, link, linkUrl, order, isActive } = req.body;
    const banner = { title: title || '', subtitle: subtitle || '', description: description || '', image: image || '', mobileImage: mobileImage || '', linkText: linkText || '', link: link || linkUrl || '', linkUrl: linkUrl || link || '', order: Number(order) || 0, isActive: toBool(isActive, true), createdAt: new Date() };
    const result = await db.collection('banners').insertOne(banner);
    res.json({ banner: { ...banner, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/banners/reorder', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const orders = req.body.orders || [];
    const ops = orders
      .filter(item => item && ObjectId.isValid(item._id || item.id))
      .map(item => ({
        updateOne: {
          filter: { _id: ObjectId.createFromHexString(item._id || item.id) },
          update: { $set: { order: Number(item.order) || 0, updatedAt: new Date() } },
        },
      }));
    if (ops.length) await db.collection('banners').bulkWrite(ops);
    res.json({ success: true, count: ops.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); const update = { ...req.body }; delete update._id; if (update.linkUrl && !update.link) update.link = update.linkUrl; if (update.link && !update.linkUrl) update.linkUrl = update.link; if (update.order !== undefined) update.order = Number(update.order) || 0; if (update.isActive !== undefined) update.isActive = toBool(update.isActive, true); await db.collection('banners').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); await db.collection('banners').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SITE SETTINGS ============
app.get('/api/settings', async (req, res) => {
  try { const db = getDB(); const settings = await db.collection('siteSettings').findOne({}); res.json({ settings: settings || {} }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/settings', adminAuth, async (req, res) => {
  try { const db = getDB(); const update = { ...req.body }; delete update._id; delete update.createdAt; update.updatedAt = new Date(); await db.collection('siteSettings').updateOne({}, { $set: update }, { upsert: true }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/settings', adminAuth, async (req, res) => {
  try { const db = getDB(); const update = { ...req.body }; delete update._id; delete update.createdAt; update.updatedAt = new Date(); await db.collection('siteSettings').updateOne({}, { $set: update }, { upsert: true }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ ORDER ROUTES ============
app.post('/api/orders', async (req, res) => {
  try {
    const db = getDB();
    const { items, shippingInfo, paymentMethod, bkashTrxId, couponCode, userId } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });
    if (!shippingInfo || !shippingInfo.name || !shippingInfo.phone || !shippingInfo.address || !shippingInfo.district) return res.status(400).json({ error: 'Shipping info and district required' });
    let subtotal = 0;
    const orderItems = [];
    for (const item of items) {
      const product = await db.collection('products').findOne({ _id: ObjectId.createFromHexString(item.product) });
      if (!product) continue;
      const itemPrice = product.price;
      subtotal += itemPrice * item.qty;
      orderItems.push({ product: product._id.toString(), name: product.name, image: (product.images && product.images[0]) || '', price: itemPrice, color: item.color || '', qty: item.qty });
    }
    let discount = 0;
    if (couponCode) {
      const coupon = await db.collection('coupons').findOne({ code: couponCode.toUpperCase(), isActive: true });
      if (coupon && coupon.usedCount < (coupon.maxUses || 999999) && (!coupon.expiresAt || new Date(coupon.expiresAt) > new Date())) {
        if (!coupon.minOrder || subtotal >= coupon.minOrder) {
          discount = coupon.discountType === 'percentage' ? (subtotal * coupon.discountValue / 100) : coupon.discountValue;
          await db.collection('coupons').updateOne({ _id: coupon._id }, { $inc: { usedCount: 1 } });
        }
      }
    }
    const settings = await db.collection('siteSettings').findOne({}) || {};
    const deliveryCharge = calculateDeliveryCharge(subtotal, shippingInfo.district, settings);
    const total = Math.max(0, subtotal - discount + deliveryCharge);
    const order = { orderId: genOrderId(), user: userId || null, items: orderItems, shippingInfo, subtotal, discount, deliveryCharge, total, paymentMethod, bkashTrxId: bkashTrxId || '', status: 'pending', createdAt: new Date() };
    const result = await db.collection('orders').insertOne(order);
    if (userId) await db.collection('carts').deleteOne({ user: userId });

    sendOrderConfirmation({ ...order, _id: result.insertedId }, settings).catch(() => {});

    res.json({ order: normalizeOrder({ ...order, _id: result.insertedId }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/track/:orderId', async (req, res) => {
  try {
    const db = getDB();
    const lookup = req.params.orderId;
    const filter = ObjectId.isValid(lookup)
      ? { $or: [{ orderId: lookup }, { _id: ObjectId.createFromHexString(lookup) }] }
      : { orderId: lookup };
    const order = await db.collection('orders').findOne(filter);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: normalizeOrder(order) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/my', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const orders = await db.collection('orders').find({ user: decoded.id }).sort({ createdAt: -1 }).toArray();
    res.json({ orders: orders.map(normalizeOrder) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) filter.$or = [{ orderId: { $regex: search, $options: 'i' } }, { 'shippingInfo.name': { $regex: search, $options: 'i' } }, { 'shippingInfo.phone': { $regex: search, $options: 'i' } }];
    const skip = (Number(page) - 1) * Number(limit);
    const orders = await db.collection('orders').find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray();
    const total = await db.collection('orders').countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / Number(limit)));
    res.json({ orders: orders.map(normalizeOrder), total, totalOrders: total, page: Number(page), pages, totalPages: pages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); const order = await db.collection('orders').findOne({ _id: ObjectId.createFromHexString(req.params.id) }); if (!order) return res.status(404).json({ error: 'Order not found' }); res.json({ order: normalizeOrder(order) }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/orders/:id/status', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { status } = req.body;
    const valid = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await db.collection('orders').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: { status, updatedAt: new Date() } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const result = await db.collection('orders').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ CART ROUTES ============
app.get('/api/cart', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.json({ cart: { items: [] } });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    let cart = await db.collection('carts').findOne({ user: decoded.id });
    res.json({ cart: cart || { items: [] } });
  } catch (err) { res.json({ cart: { items: [] } }); }
});

app.post('/api/cart/add', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const { product, color, qty } = req.body;
    let cart = await db.collection('carts').findOne({ user: decoded.id });
    if (!cart) {
      cart = { user: decoded.id, items: [{ product, color: color || '', qty: qty || 1 }], updatedAt: new Date() };
      await db.collection('carts').insertOne(cart);
    } else {
      const existing = cart.items.findIndex(i => i.product === product && i.color === (color || ''));
      if (existing >= 0) { cart.items[existing].qty += (qty || 1); } else { cart.items.push({ product, color: color || '', qty: qty || 1 }); }
      await db.collection('carts').updateOne({ _id: cart._id }, { $set: { items: cart.items, updatedAt: new Date() } });
    }
    res.json({ cart });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/cart/update', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    await db.collection('carts').updateOne({ user: decoded.id }, { $set: { items: req.body.items, updatedAt: new Date() } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cart/remove/:productId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const cart = await db.collection('carts').findOne({ user: decoded.id });
    if (cart) {
      const newItems = cart.items.filter(i => i.product !== req.params.productId);
      await db.collection('carts').updateOne({ _id: cart._id }, { $set: { items: newItems, updatedAt: new Date() } });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ WISHLIST ROUTES ============
app.get('/api/wishlist', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.json({ wishlist: [] });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const wishlist = await db.collection('wishlists').find({ user: decoded.id }).toArray();
    res.json({ wishlist });
  } catch (err) { res.json({ wishlist: [] }); }
});

app.post('/api/wishlist/:productId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const existing = await db.collection('wishlists').findOne({ user: decoded.id, product: req.params.productId });
    if (existing) { await db.collection('wishlists').deleteOne({ _id: existing._id }); res.json({ added: false }); }
    else { await db.collection('wishlists').insertOne({ user: decoded.id, product: req.params.productId, createdAt: new Date() }); res.json({ added: true }); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/wishlist/:productId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    await db.collection('wishlists').deleteOne({ user: decoded.id, product: req.params.productId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ COUPON ROUTES ============
app.get('/api/coupons/validate/:code', async (req, res) => {
  try {
    const db = getDB();
    const coupon = await db.collection('coupons').findOne({ code: req.params.code.toUpperCase(), isActive: true });
    if (!coupon) return res.status(404).json({ error: 'Invalid coupon' });
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) return res.status(400).json({ error: 'Usage limit reached' });
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return res.status(400).json({ error: 'Coupon expired' });
    res.json({ coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue, minOrder: coupon.minOrder } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/coupons', adminAuth, async (req, res) => {
  try { const db = getDB(); const coupons = await db.collection('coupons').find({}).sort({ createdAt: -1 }).toArray(); res.json({ coupons }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/coupons', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { code, discountType, discountValue, minOrder, maxUses, expiresAt } = req.body;
    if (!code || !discountValue) return res.status(400).json({ error: 'Code and value required' });
    const coupon = { code: code.toUpperCase(), discountType: discountType || 'flat', discountValue: Number(discountValue), minOrder: Number(minOrder) || 0, maxUses: Number(maxUses) || 0, usedCount: 0, expiresAt: expiresAt ? new Date(expiresAt) : null, isActive: true, createdAt: new Date() };
    const result = await db.collection('coupons').insertOne(coupon);
    res.json({ coupon: { ...coupon, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/coupons/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); const update = { ...req.body }; delete update._id; if (update.code) update.code = update.code.toUpperCase(); await db.collection('coupons').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/coupons/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); await db.collection('coupons').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});
// ============ REVIEW ROUTES ============
app.get('/api/reviews', async (req, res) => {
  try { const db = getDB(); const filter = { isApproved: true }; if (req.query.product) filter.product = req.query.product; const reviews = await db.collection('reviews').find(filter).sort({ createdAt: -1 }).toArray(); res.json({ reviews }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const { product, rating, comment } = req.body;
    if (!product || !rating) return res.status(400).json({ error: 'Product and rating required' });
    const review = { product, user: decoded.id, rating: Number(rating), comment: comment || '', isApproved: false, createdAt: new Date() };
    const result = await db.collection('reviews').insertOne(review);
    res.json({ review: { ...review, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/reviews', adminAuth, async (req, res) => {
  try { const db = getDB(); const reviews = await db.collection('reviews').find({}).sort({ createdAt: -1 }).toArray(); res.json({ reviews }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/reviews/:id/approve', adminAuth, async (req, res) => {
  try { const db = getDB(); await db.collection('reviews').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: { isApproved: true } }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/reviews/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); const update = { ...req.body }; delete update._id; update.updatedAt = new Date(); await db.collection('reviews').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/reviews/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); await db.collection('reviews').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ NEWSLETTER ============
app.post('/api/newsletter/subscribe', async (req, res) => {
  try {
    const db = getDB();
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const existing = await db.collection('newsletter').findOne({ email });
    if (existing) return res.json({ message: 'Already subscribed' });
    await db.collection('newsletter').insertOne({ email, subscribedAt: new Date() });
    res.json({ message: 'Subscribed successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/newsletter', adminAuth, async (req, res) => {
  try { const db = getDB(); const subscribers = await db.collection('newsletter').find({}).sort({ subscribedAt: -1 }).toArray(); res.json({ subscribers }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ PAGES ============
app.get('/api/pages/:slug', async (req, res) => {
  try { const db = getDB(); const page = await db.collection('pages').findOne({ slug: req.params.slug, isPublished: true }); if (!page) return res.status(404).json({ error: 'Page not found' }); res.json({ page }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/pages', adminAuth, async (req, res) => {
  try { const db = getDB(); const pages = await db.collection('pages').find({}).sort({ createdAt: -1 }).toArray(); res.json({ pages }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/pages', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { title, content, metaDescription, isPublished } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const page = { title, slug: slugify(title), content: content || '', metaDescription: metaDescription || '', isPublished: isPublished !== false, createdAt: new Date() };
    const result = await db.collection('pages').insertOne(page);
    res.json({ page: { ...page, _id: result.insertedId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/pages/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); const update = { ...req.body }; delete update._id; if (update.title) update.slug = slugify(update.title); await db.collection('pages').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: update }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/pages/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); await db.collection('pages').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ CUSTOMERS ============
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 20, search } = req.query;
    const filter = {};
    if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }, { phone: { $regex: search, $options: 'i' } }];
    const skip = (Number(page) - 1) * Number(limit);
    const users = await db.collection('users').find(filter, { projection: { password: 0 } }).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).toArray();
    const total = await db.collection('users').countDocuments(filter);
    res.json({ users, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users/:id/orders', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const orders = await db.collection('orders').find({ user: req.params.id }).sort({ createdAt: -1 }).toArray();
    res.json({ orders: orders.map(normalizeOrder) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const user = await db.collection('users').findOne({ _id: ObjectId.createFromHexString(req.params.id) }, { projection: { password: 0 } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const orders = await db.collection('orders').find({ user: req.params.id }).sort({ createdAt: -1 }).toArray();
    res.json({ user, orders: orders.map(normalizeOrder) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try { const db = getDB(); await db.collection('users').deleteOne({ _id: ObjectId.createFromHexString(req.params.id) }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ FILE UPLOAD ============
app.post('/api/upload', adminAuth, singleUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file', message: 'No file' });
    const result = await uploadBufferToCloudinary(req.file);
    res.json({ url: result.secure_url, publicId: result.public_id });
  } catch (err) { sendUploadError(res, err); }
});

app.post('/api/upload/multiple', adminAuth, multipleUpload, async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files', message: 'No files' });
    const urls = [];
    for (const file of req.files) {
      const result = await uploadBufferToCloudinary(file);
      urls.push({ url: result.secure_url, publicId: result.public_id });
    }
    res.json({ urls });
  } catch (err) { sendUploadError(res, err); }
});

// ============ DASHBOARD ============
app.get('/api/admin/dashboard/stats', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const totalOrders = await db.collection('orders').countDocuments();
    const totalProducts = await db.collection('products').countDocuments();
    const totalUsers = await db.collection('users').countDocuments();
    const totalRevenue = await db.collection('orders').aggregate([{ $match: { status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$total' } } }]).toArray();
    const pendingOrders = await db.collection('orders').countDocuments({ status: 'pending' });
    const recentOrders = await db.collection('orders').find({}).sort({ createdAt: -1 }).limit(10).toArray();
    const monthlyRevenue = await db.collection('orders').aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, revenue: { $sum: '$total' }, count: { $sum: 1 } } },
      { $sort: { _id: -1 } }, { $limit: 12 },
    ]).toArray();
    res.json({ totalOrders, totalProducts, totalUsers, totalRevenue: totalRevenue[0]?.total || 0, pendingOrders, recentOrders: recentOrders.map(normalizeOrder), monthlyRevenue });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ ADMIN PASSWORD ============
app.put('/api/admin/change-password', adminAuth, async (req, res) => {
  try {
    const db = getDB();
    const { currentPassword, newPassword } = req.body;
    const admin = await db.collection('admins').findOne({ _id: req.admin._id });
    const valid = await bcrypt.compare(currentPassword, admin.password);
    if (!valid) return res.status(400).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.collection('admins').updateOne({ _id: req.admin._id }, { $set: { password: hash } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', async (req, res) => {
  try { await getDB().command({ ping: 1 }); res.json({ ok: true, service: 'softy-ecommerce' }); }
  catch (err) { res.status(503).json({ ok: false, error: 'Database unavailable' }); }
});

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone = '', subject = 'General inquiry', message } = req.body || {};
    if (!name || !email || !message || String(name).length > 120 || String(email).length > 254 || String(message).length > 3000) return res.status(400).json({ error: 'Please provide your name, email, and message.' });
    const result = await getDB().collection('contacts').insertOne({ name: String(name).trim(), email: String(email).trim().toLowerCase(), phone: String(phone).trim().slice(0, 30), subject: String(subject).trim().slice(0, 160), message: String(message).trim(), status: 'new', createdAt: new Date() });
    res.status(201).json({ success: true, id: result.insertedId });
  } catch (err) { res.status(500).json({ error: 'Could not send message' }); }
});

app.get('/api/admin/messages', adminAuth, async (req, res) => {
  const messages = await getDB().collection('contacts').find({}).sort({ createdAt: -1 }).limit(200).toArray();
  res.json({ messages });
});
app.put('/api/admin/messages/:id', adminAuth, async (req, res) => {
  const status = ['new', 'in-progress', 'resolved'].includes(req.body?.status) ? req.body.status : null;
  if (!status || !ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid request' });
  await getDB().collection('contacts').updateOne({ _id: ObjectId.createFromHexString(req.params.id) }, { $set: { status, updatedAt: new Date() } });
  res.json({ success: true });
});

async function seedSoftyCatalog() {
  const db = getDB();
  if (await db.collection('products').countDocuments()) return;
  const now = new Date();
  const categories = [
    { name: 'Face Care', slug: 'face-care', image: '/products/softyy/lemon-face-wash.jpg', order: 1 },
    { name: 'Serums', slug: 'serums', image: '/products/softyy/acne-serum.jpg', order: 2 },
    { name: 'Soothing Care', slug: 'soothing-care', image: '/products/softyy/milk-soothing-gel.jpg', order: 3 },
    { name: 'Daily Essentials', slug: 'daily-essentials', image: '/products/softyy/papaya-face-wash.jpg', order: 4 },
  ];
  const categoryResults = await Promise.all(categories.map(async category => {
    const result = await db.collection('categories').insertOne({ ...category, isActive: true, createdAt: now });
    return [category.slug, result.insertedId.toString()];
  }));
  const categoryIds = Object.fromEntries(categoryResults);
  const brandResult = await db.collection('brands').insertOne({ name: 'Softy', slug: 'softy', logo: '/brand/softy-ecom-logo-v2.png', isActive: true, createdAt: now });
  const stock = Number(process.env.SEED_STOCK || 12);
  const data = [
    ['Softyy Lemon Face Wash', 'lemon-face-wash', 'Face Care', 'Deep cleansing and oil control with a fresh lemon finish.', 350, '/products/softyy/lemon-face-wash.jpg', ['Oil Control', 'Acne Care', 'Brightening']],
    ['Softyy Milk Expert Face Wash', 'milk-expert-face-wash', 'Face Care', 'Gentle cleansing for skin that needs softness and moisture.', 350, '/products/softyy/milk-face-wash.jpg', ['Sensitive Skin', 'Moisturizing']],
    ['Softyy Acne Control Serum', 'acne-control-serum', 'Serums', 'Targeted salicylic acid and niacinamide care for clearer skin.', 450, '/products/softyy/acne-serum.jpg', ['Acne Care', 'Oil Control']],
    ['Softyy Papaya Face Wash', 'papaya-face-wash', 'Face Care', 'A gentle daily cleanse with papaya-inspired glow care.', 350, '/products/softyy/papaya-face-wash.jpg', ['Brightening', 'Gentle Care']],
    ['Softyy Salicylic Acid Face Wash', 'salicylic-face-wash', 'Face Care', 'Deep pore cleansing support for acne-prone skin.', 350, '/products/softyy/salicylic-face-wash.jpg', ['Acne Care', 'Deep Clean']],
    ['Softyy Milk Soothing Gel', 'milk-soothing-gel', 'Soothing Care', 'Lightweight daily hydration and soothing moisture support.', 480, '/products/softyy/milk-soothing-gel.jpg', ['Soothing', 'Moisturizing']],
  ];
  const dailyEssentialSlugs = new Set(['lemon-face-wash', 'milk-expert-face-wash', 'papaya-face-wash', 'milk-soothing-gel']);
  await db.collection('products').insertMany(data.map(([name, slug, category, description, price, image, concerns], index) => {
    const primaryCategory = categoryIds[category.toLowerCase().replace(' ', '-')] || categoryIds['face-care'];
    const categoryList = [primaryCategory];
    if (dailyEssentialSlugs.has(slug) && categoryIds['daily-essentials']) categoryList.push(categoryIds['daily-essentials']);
    return {
    name, slug, description, price, regularPrice: price, salePrice: null, isOnSale: false, comparePrice: null,
    image, images: [image], category: primaryCategory,
    categories: categoryList, brand: brandResult.insertedId.toString(),
    stock, isActive: true, isBestSeller: index < 4, isFeatured: index < 4, isTrending: index < 3, isNew: index === 2,
      tags: concerns, concerns, benefits: concerns, ingredients: 'See product packaging for the full ingredient list.', howToUse: 'Apply to damp skin, massage gently, then rinse well.', volume: index === 2 ? '30 ml' : index === 5 ? '250 gm' : '100 ml', sold: 0, averageRating: 0, createdAt: now,
    };
  }));
  console.log('Softy starter catalog seeded');
}

// ============ START ============
const PORT = process.env.PORT || 1002;
async function start() {
  await connectDB();
  await seedAdmin();
  await seedSettings();
  await createIndexes();
  await seedSoftyCatalog();
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}
start();
