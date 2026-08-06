/**
 * Migration Script: driver codes + optional driver email
 *
 * Two changes, both needed before a driver can be created without an email:
 *   1. Every existing driver gets a permanent driverCode (DRV-XXXX-XXXX) so the
 *      whole fleet can sign in the new way, not just drivers added from now on.
 *   2. The drivers.email unique index is rebuilt as sparse. A plain unique index
 *      treats every missing email as the same null, so it would allow exactly
 *      one email-less driver and reject the second with a duplicate-key error.
 *
 * Safe to re-run: drivers that already have a code are left alone, and the index
 * is only rebuilt when it is not already sparse.
 *
 * Run with: node scripts/migrate-driver-codes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Driver = require('../src/models/Driver');
const { generateUniqueDriverCode } = require('../src/utils/driverCode');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGOURI;

// Mongo cannot change an index in place — the old one is dropped and the model's
// current (sparse) definition is rebuilt from the schema.
async function rebuildEmailIndex() {
  const collection = Driver.collection;
  const indexes = await collection.indexes();
  const emailIndex = indexes.find((index) => index.key && index.key.email === 1);

  if (!emailIndex) {
    console.log('   No email index found — syncing indexes from the schema');
  } else if (emailIndex.sparse) {
    console.log('   email index is already sparse — leaving it alone');
    return;
  } else {
    console.log(`   Dropping non-sparse index ${emailIndex.name}`);
    await collection.dropIndex(emailIndex.name);
  }

  await Driver.syncIndexes();
  console.log('   Rebuilt drivers.email as a sparse unique index');
}

async function backfillDriverCodes() {
  const drivers = await Driver.find({
    $or: [{ driverCode: { $exists: false } }, { driverCode: null }, { driverCode: '' }]
  }).select('_id name');

  console.log(`   ${drivers.length} driver(s) without a driver ID`);

  let updated = 0;
  for (const driver of drivers) {
    // eslint-disable-next-line no-await-in-loop
    const code = await generateUniqueDriverCode(Driver);
    // eslint-disable-next-line no-await-in-loop
    await Driver.updateOne({ _id: driver._id }, { $set: { driverCode: code } });
    updated += 1;
    console.log(`   ${driver.name} → ${code}`);
  }

  return updated;
}

// Blank emails would sit in the unique index and collide with each other, so any
// left behind by older code are removed outright.
async function unsetBlankEmails() {
  const result = await Driver.updateMany({ email: '' }, { $unset: { email: '' } });
  return result.modifiedCount || 0;
}

const migrate = async () => {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected');

    console.log('\n📇 Clearing blank driver emails...');
    const cleared = await unsetBlankEmails();
    console.log(`   ${cleared} blank email(s) removed`);

    console.log('\n🔑 Rebuilding the drivers.email index...');
    await rebuildEmailIndex();

    console.log('\n🆔 Backfilling driver IDs...');
    const updated = await backfillDriverCodes();

    const remaining = await Driver.countDocuments({
      $or: [{ driverCode: { $exists: false } }, { driverCode: null }]
    });

    console.log('\n📊 Summary');
    console.log(`   • ${updated} driver(s) given a driver ID`);
    console.log(`   • ${remaining} driver(s) still without one`);

    console.log('\n🎉 Migration completed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) migrate();

module.exports = { rebuildEmailIndex, backfillDriverCodes, unsetBlankEmails };
