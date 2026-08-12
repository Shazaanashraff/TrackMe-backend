// One-off migration: prepares the `users` collection for multiple rider
// profiles per identity (an account holder plus the riders they manage — a
// parent's children, an office's staff). See docs/modules/PROFILES.md.
//
// Every existing User document today IS the account holder — this concept
// did not exist before — so this is a backfill, not a data transformation:
//
//   1. Stamp `profileKind: 'PRIMARY'` on every User document that doesn't
//      have one yet.
//   2. Normalise a blank/null email to a genuinely missing field via $unset,
//      never `$set: { email: null }` — the new email index is sparse, and a
//      sparse index still indexes an explicit `null`, so two such documents
//      would collide (see models/User.js).
//   3. Drop the two indexes `users` used to share with every other account
//      type (a plain-unique `identityId_1`, a plain-unique `email_1`) and let
//      Mongoose rebuild them in the new shape: a PRIMARY-scoped unique
//      `identityId_1_primary_unique`, a sparse-unique `email_1`, and a plain
//      `identityId_1` for household lookups.
//
// Usage:
//   node scripts/migrate-rider-profiles.js            (dry run — prints the plan, no writes)
//   node scripts/migrate-rider-profiles.js --apply     (commits the migration)
//   node scripts/migrate-rider-profiles.js --verify    (post-run integrity assertions)
//
// Must be runnable against the sandbox database (MONGODB_URI containing
// "sandbox") — see docs/modules/SANDBOX.md — as well as the real one.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

// --- Pure planning helpers (unit-tested without a database) ---

// Every document that predates profileKind existing at all — every one of
// these is the account holder, since managed profiles are a feature this
// migration is introducing.
const planProfileKindBackfill = (docs) =>
  (docs || []).filter((d) => !d.profileKind).map((d) => d._id);

// A blank string or an explicit null both mean "no email" — the schema's
// setter already normalises '' -> undefined on writes going through
// Mongoose, but this catches documents written before that setter existed or
// through a path that bypassed it.
//
// Scoped to documents already marked MANAGED, never PRIMARY: every document
// this migration is about to backfill to PRIMARY (planProfileKindBackfill)
// needs its email kept intact, or it would come out the other side violating
// "a PRIMARY must have an email". Email was `required: true` on every User
// document before this migration existed, so a blank email pre-migration is
// itself a data anomaly, not something the backfill is expected to produce —
// this step is real cleanup only for a MANAGED profile written some other way.
const planBlankEmailCleanup = (docs) =>
  (docs || [])
    .filter((d) => d.profileKind === 'MANAGED' && (d.email === '' || d.email === null))
    .map((d) => d._id);

// --- Runner ---

const loadUsers = async () => User.collection.find({}).toArray();

// `apply` is a parameter rather than reading the top-level APPLY constant
// directly, so tests can exercise both the dry-run and the real write path
// against an already-connected test database without shelling out.
const runMigration = async (apply = APPLY) => {
  const docs = await loadUsers();

  const backfillIds = planProfileKindBackfill(docs);
  const blankEmailIds = planBlankEmailCleanup(docs);

  console.log('--- Current users collection ---');
  console.log(`Total documents:              ${docs.length}`);
  console.log(`Missing profileKind:          ${backfillIds.length}`);
  console.log(`Blank/null email to unset:    ${blankEmailIds.length}`);

  if (!apply) {
    console.log('\nDry run complete. No changes were made. Re-run with --apply to commit.');
    return true;
  }

  // --- Apply ---
  if (backfillIds.length) {
    await User.collection.updateMany(
      { _id: { $in: backfillIds } },
      { $set: { profileKind: 'PRIMARY' } }
    );
  }

  if (blankEmailIds.length) {
    await User.collection.updateMany(
      { _id: { $in: blankEmailIds } },
      { $unset: { email: '' } }
    );
  }

  // Drop the old shared-shape indexes if present. Safe to re-run: a missing
  // index is not an error, it just means this step already happened.
  const dropIfExists = async (name) => {
    try {
      await User.collection.dropIndex(name);
      console.log(`  dropped index ${name}`);
    } catch (err) {
      if (err.codeName !== 'IndexNotFound') throw err;
      console.log(`  index ${name} already absent`);
    }
  };
  await dropIfExists('identityId_1');
  await dropIfExists('email_1');

  // Rebuilds every index declared on the current schema, including the new
  // scoped-unique identityId_1_primary_unique and the sparse-unique email_1.
  await User.syncIndexes();

  console.log('\nMigration applied.');
  console.log(`  profileKind backfilled: ${backfillIds.length}`);
  console.log(`  emails normalised:      ${blankEmailIds.length}`);
  console.log('  indexes rebuilt via User.syncIndexes()');
  return true;
};

const runVerify = async () => {
  let ok = true;
  const fail = (msg) => {
    ok = false;
    console.error(`  FAIL ${msg}`);
  };

  console.log('--- Verifying rider-profiles migration ---');

  const missingKind = await User.collection.countDocuments({
    profileKind: { $nin: ['PRIMARY', 'MANAGED'] }
  });
  if (missingKind) fail(`${missingKind} user document(s) have no valid profileKind`);

  const primaryWithoutEmail = await User.collection.countDocuments({
    profileKind: 'PRIMARY',
    email: { $exists: false }
  });
  if (primaryWithoutEmail) fail(`${primaryWithoutEmail} PRIMARY document(s) have no email`);

  const managedWithEmail = await User.collection.countDocuments({
    profileKind: 'MANAGED',
    email: { $exists: true }
  });
  if (managedWithEmail) fail(`${managedWithEmail} MANAGED document(s) carry an email`);

  const duplicatePrimaries = await User.collection
    .aggregate([
      { $match: { profileKind: 'PRIMARY', identityId: { $exists: true } } },
      { $group: { _id: '$identityId', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: 'n' }
    ])
    .toArray();
  if (duplicatePrimaries[0]?.n) {
    fail(`${duplicatePrimaries[0].n} identity/identities have more than one PRIMARY profile`);
  }

  const indexes = await User.collection.indexes();
  const byName = new Map(indexes.map((i) => [i.name, i]));

  const scopedUnique = byName.get('identityId_1_primary_unique');
  if (!scopedUnique) {
    fail('identityId_1_primary_unique index is missing');
  } else if (!scopedUnique.unique || scopedUnique.partialFilterExpression?.profileKind !== 'PRIMARY') {
    fail('identityId_1_primary_unique index is not unique + PRIMARY-scoped as expected');
  }

  const emailIndex = byName.get('email_1');
  if (!emailIndex) {
    fail('email_1 index is missing');
  } else if (!emailIndex.unique || !emailIndex.sparse) {
    fail('email_1 index is not sparse + unique as expected');
  }

  const plainIdentityIndex = byName.get('identityId_1');
  if (!plainIdentityIndex) fail('plain identityId_1 index is missing (needed for household lookups)');

  console.log(`  users: ${await User.collection.countDocuments({})}`);
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

module.exports = { planProfileKindBackfill, planBlankEmailCleanup, runMigration, runVerify };

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
