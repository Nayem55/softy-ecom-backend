require('dotenv').config({ path: require('node:path').resolve(__dirname, '.env') });

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { products, categoryDescriptions } = require('../../Assets/catalog');

const publicRoots = [
  path.resolve(__dirname, '..', 'frontend', 'public'),
  path.resolve(__dirname, '..', '..', 'Portfolio', 'frontend', 'public'),
];
const imagePattern = /\.(?:jpe?g|png|webp)$/i;
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function copyImages(item) {
  const files = fs.readdirSync(item.folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && imagePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (!files.length) throw new Error(`No product images found for ${item.name}`);
  const folder = path.join('products', item.brand === 'Softy' ? 'softyy' : 'fresh-daily', item.slug);
  return files.map((file, index) => {
    const filename = `image-${index + 1}${path.extname(file).toLowerCase()}`;
    for (const root of publicRoots) {
      const destination = path.join(root, folder, filename);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(item.folder, file), destination);
    }
    return `/${folder.replaceAll(path.sep, '/')}/${filename}`;
  });
}

function productText(item) {
  const file = fs.readdirSync(item.folder, { withFileTypes: true })
    .find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'));
  return file ? fs.readFileSync(path.join(item.folder, file.name), 'utf8').trim() : '';
}

function productPrice(text, name) {
  const match = text.match(/price\s*[-:]?\s*(\d+)/i);
  if (!match) throw new Error(`No price found for ${name}`);
  return Number(match[1]);
}

async function syncCatalog() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db();
  const collection = (name) => db.collection(`ecom_${name}`);
  const now = new Date();

  try {
    const imageMap = new Map(products.map((item) => [item.slug, copyImages(item)]));
    const categoryNames = [...new Set(products.map((item) => item.category))];
    const categoryIds = new Map();
    for (const [order, name] of categoryNames.entries()) {
      const item = products.find((product) => product.category === name);
      const slug = slugify(name);
      const category = await collection('categories').findOneAndUpdate(
        { slug },
        { $set: { name, slug, description: categoryDescriptions[name], image: imageMap.get(item.slug)[0], order: order + 1, isActive: true, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
      categoryIds.set(name, category._id.toString());
    }

    const brandIds = new Map();
    for (const name of ['Softy', 'Fresh Daily']) {
      const slug = slugify(name);
      const brand = await collection('brands').findOneAndUpdate(
        { slug },
        { $set: { name, slug, isActive: true, ...(name === 'Softy' ? { logo: '/brand/softy-ecom-logo-v2.png' } : {}), updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: 'after' },
      );
      brandIds.set(name, brand._id.toString());
    }

    for (const [order, item] of products.entries()) {
      const details = productText(item);
      const price = productPrice(details, item.name);
      const existing = await collection('products').findOne({ $or: [{ slug: item.slug }, { slug: { $in: item.legacySlugs || [] } }, { name: item.name }] });
      const images = imageMap.get(item.slug);
      const payload = {
        name: item.name, slug: existing?.slug || item.slug,
        description: `${item.name} offers ${item.features.slice(0, 3).join(', ').toLowerCase()}${item.volume ? ` in a convenient ${item.volume} size` : ''}.`,
        price, regularPrice: price, salePrice: null, isOnSale: false, comparePrice: null,
        image: images[0], images, category: categoryIds.get(item.category), categories: [categoryIds.get(item.category)], brand: brandIds.get(item.brand),
        stock: Number(process.env.SEED_STOCK || 12), isActive: true, isBestSeller: Boolean(item.bestSeller), isFeatured: order < 8, isTrending: Boolean(item.bestSeller), isNew: Boolean(item.isNew),
        tags: item.features, concerns: item.features, benefits: item.features,
        ingredients: 'See product packaging for the full ingredient list.', howToUse: 'Follow the directions on the product packaging for best results.', volume: item.volume,
        details, sourceCategory: item.category, updatedAt: now,
      };
      await collection('products').updateOne(existing ? { _id: existing._id } : { slug: item.slug }, { $set: payload, $setOnInsert: { sold: 0, averageRating: 0, createdAt: now } }, { upsert: true });
    }
    await collection('categories').deleteMany({ slug: { $in: ['face-care', 'serums', 'soothing-care', 'daily-essentials'] } });
    console.log(`Synced ${products.length} ecommerce products and ${categoryNames.length} exact folder categories.`);
  } finally {
    await client.close();
  }
}

syncCatalog().catch((error) => { console.error(error); process.exitCode = 1; });
