// One-off migration: drops the stale `{ userId: 1, driverId: 1 }` unique index
// on `driverenrollments`, left behind when commit 22079e3 ("add parent-managed
// student profiles") replaced the enrollment's unique key with
// `{ studentId: 1, driverId: 1 }` (see models/DriverEnrollment.js). Mongoose
// never drops an index that falls out of the schema, so any database that
// existed before that migration still carries the old one.
//
// Every enrollment written since then sets the deprecated `userId` to `null`
// (it stays on the document only so old rows keep translating), so the stale
// index silently caps each driver to ONE enrolled rider total: the second
// distinct rider to redeem that driver's key collides on `(null, driverId)`
// and the API returns "userId already exists". Different riders were never
// meant to share that slot — `studentId` is what actually identifies each one.
//
// Usage:
//   node scripts/drop-stale-enrollment-index.js            (dry run — prints the plan, no writes)
//   node scripts/drop-stale-enrollment-index.js --apply     (commits the migration)
//   node scripts/drop-stale-enrollment-index.js --verify    (post-run integrity assertions)
//
// Must be runnable against the sandbox database (MONGODB_URI containing
// "sandbox") — see docs/modules/SANDBOX.md — as well as the real one.

require('dotenv').config();
const mongoose = require('mongoose');
const DriverEnrollment = require('../src/models/DriverEnrollment');

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

const STALE_INDEX = 'userId_1_driverId_1';

const runMigration = async (apply = APPLY) => {
  const indexes = await DriverEnrollment.collection.indexes();
  const stale = indexes.find((i) => i.name === STALE_INDEX);

  console.log('--- Current driverenrollments indexes ---');
  console.log(indexes.map((i) => i.name).join(', '));
  console.log(`Stale unique ${STALE_INDEX} present: ${Boolean(stale)}`);

  if (!apply) {
    console.log('\nDry run complete. No changes were made. Re-run with --apply to commit.');
    return true;
  }

  if (stale) {
    try {
      await DriverEnrollment.collection.dropIndex(STALE_INDEX);
      console.log(`  dropped index ${STALE_INDEX}`);
    } catch (err) {
      if (err.codeName !== 'IndexNotFound') throw err;
      console.log(`  index ${STALE_INDEX} already absent`);
    }
  } else {
    console.log(`  index ${STALE_INDEX} already absent`);
  }

  // Rebuilds every index declared on the current schema (studentId_1_driverId_1
  // unique among them) without touching the one we just dropped.
  await DriverEnrollment.syncIndexes();

  console.log('\nMigration applied.');
  console.log('  indexes rebuilt via DriverEnrollment.syncIndexes()');
  return true;
};

const runVerify = async () => {
  let ok = true;
  const fail = (msg) => {
    ok = false;
    console.error(`  FAIL ${msg}`);
  };

  console.log('--- Verifying stale enrollment index removal ---');

  const indexes = await DriverEnrollment.collection.indexes();
  const byName = new Map(indexes.map((i) => [i.name, i]));

  if (byName.has(STALE_INDEX)) fail(`stale index ${STALE_INDEX} is still present`);

  const scopedUnique = byName.get('studentId_1_driverId_1');
  if (!scopedUnique) {
    fail('studentId_1_driverId_1 index is missing');
  } else if (!scopedUnique.unique) {
    fail('studentId_1_driverId_1 index is not unique as expected');
  }

  console.log(`  driverenrollments: ${await DriverEnrollment.collection.countDocuments({})}`);
  console.log(ok ? '\nVerification passed.' : '\nVerification FAILED.');
  return ok;
};

const run = async () => {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log(
    `Connected to MongoDB${VERIFY ? ' — VERIFY MODE' : APPLY ? '' : ' — DRY RUN (pass --apply to commit)'}\n`
  );

  const ok = VERIFY ? await runVerify() : await runMigration();

  await mongoose.connection.close();
  if (!ok) process.exit(1);
};

module.exports = { runMigration, runVerify };

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
