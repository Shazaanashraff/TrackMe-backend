// Shared MongoDB connection helper for integration tests.
// Uses a dedicated test database so dev/prod data is never touched.
const mongoose = require('mongoose');

const TEST_URI =
  process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/trackme_test';

async function connectTestDb() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_URI);
  }
}

// Remove all documents from every collection (keeps indexes).
async function clearTestDb() {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((c) => c.deleteMany({}))
  );
}

async function closeTestDb() {
  await clearTestDb();
  await mongoose.connection.close();
}

module.exports = { connectTestDb, clearTestDb, closeTestDb, TEST_URI };
