const { MongoClient } = require('mongodb');

let client;
let database;

const scopedDatabase = (db) => new Proxy(db, {
  get(target, property, receiver) {
    if (property === 'collection') {
      return (name, ...args) => {
        if (typeof name !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid collection name');
        return target.collection(`ecom_${name}`, ...args);
      };
    }
    return Reflect.get(target, property, receiver);
  },
});

async function connectDB() {
  if (database) return database;
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  database = scopedDatabase(client.db());
  await database.command({ ping: 1 });
  console.log('Softy ecommerce MongoDB connected');
  return database;
}

function getDB() {
  if (!database) throw new Error('Database not initialized');
  return database;
}

module.exports = { connectDB, getDB };
