const mongoose = require('mongoose');
const User = require('../../src/models/User');
const { runMigration, runVerify } = require('../../scripts/migrate-rider-profiles');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// End-to-end run of the migration against a live database, standing in for
// what a real deployment's `users` collection looks like the moment before
// this migration runs: every document predates profileKind, and the indexes
// are still the old shared shape (plain-unique identityId_1, plain-unique
// email_1) rather than the new PRIMARY-scoped ones. The unit test alongside
// this (tests/unit/migrate-rider-profiles.test.js) covers the planning logic
// in isolation; this covers the part most likely to break in practice — the
// index drop/rebuild, which already surfaced one Mongoose auto-naming
// collision during development (see User.js's explicit index name).

// Settled once, up front: Mongoose builds a model's own indexes on first use
// (autoIndex), and if that background build were still in flight when a test
// starts hand-rolling the legacy index shape, the two would race and collide
// on the same index name. Resolving it here means nothing later in this file
// can trigger it again.
beforeAll(async () => {
  await connectTestDb();
  await User.init();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

// Drops every index but _id and hand-builds the shape `users` had before this
// migration: identityId_1 and email_1 both plain-unique, non-sparse — exactly
// what accountFields.js gave every account type prior to `multiplePerIdentity`.
const seedLegacyShape = async () => {
  await clearTestDb();
  await User.collection.dropIndexes();
  await User.collection.createIndex({ identityId: 1 }, { unique: true, name: 'identityId_1' });
  await User.collection.createIndex({ email: 1 }, { unique: true, name: 'email_1' });

  await User.collection.insertMany([
    // A normal pre-migration rider: no profileKind field, a real email — this
    // is the only shape that could exist pre-migration, since email was
    // `required: true` on every User document until now.
    {
      _id: new mongoose.Types.ObjectId(),
      identityId: new mongoose.Types.ObjectId(),
      name: 'Legacy Rider',
      email: 'legacy@t.com',
      isActive: true
    },
    // A stray MANAGED profile with a corrupted blank email — the realistic
    // target of the cleanup step. Written with profileKind already set, since
    // MANAGED profiles don't exist until after this migration first runs; this
    // represents a later re-run finding an anomaly, not the first-run state.
    {
      _id: new mongoose.Types.ObjectId(),
      identityId: new mongoose.Types.ObjectId(),
      name: 'Blank Email Managed Profile',
      email: '',
      profileKind: 'MANAGED',
      isActive: true
    }
  ]);
};

beforeEach(seedLegacyShape);

describe('migrate-rider-profiles (live run)', () => {
  it('dry run makes no changes', async () => {
    const ok = await runMigration(false);
    expect(ok).toBe(true);

    const docs = await User.collection.find({}).toArray();
    const legacyRider = docs.find((d) => d.name === 'Legacy Rider');
    expect(legacyRider.profileKind).toBeUndefined();
  });

  it('backfills profileKind on documents that have none, leaving their email untouched', async () => {
    const ok = await runMigration(true);
    expect(ok).toBe(true);

    const legacyRider = await User.collection.findOne({ name: 'Legacy Rider' });
    expect(legacyRider.profileKind).toBe('PRIMARY');
    expect(legacyRider.email).toBe('legacy@t.com');
  });

  it('unsets a blank email on an already-MANAGED document, never on a PRIMARY one', async () => {
    await runMigration(true);

    const managedProfile = await User.collection.findOne({ name: 'Blank Email Managed Profile' });
    expect(managedProfile.profileKind).toBe('MANAGED');
    expect('email' in managedProfile).toBe(false);

    const legacyRider = await User.collection.findOne({ name: 'Legacy Rider' });
    expect(legacyRider.profileKind).toBe('PRIMARY');
    expect(legacyRider.email).toBe('legacy@t.com');
  });

  it('rebuilds the indexes in the new shape, replacing the old shared ones', async () => {
    await runMigration(true);

    const indexes = await User.collection.indexes();
    const byName = new Map(indexes.map((i) => [i.name, i]));

    expect(byName.has('identityId_1_primary_unique')).toBe(true);
    expect(byName.get('identityId_1_primary_unique').unique).toBe(true);
    expect(byName.get('identityId_1_primary_unique').partialFilterExpression.profileKind).toBe('PRIMARY');

    expect(byName.has('identityId_1')).toBe(true);
    expect(byName.get('identityId_1').unique).toBeFalsy();

    expect(byName.has('email_1')).toBe(true);
    expect(byName.get('email_1').unique).toBe(true);
    expect(byName.get('email_1').sparse).toBe(true);
  });

  it('a second --apply is a no-op that still verifies clean', async () => {
    await runMigration(true);
    const secondRun = await runMigration(true);
    expect(secondRun).toBe(true);

    const ok = await runVerify();
    expect(ok).toBe(true);
  });

  it('--verify fails before the migration has run', async () => {
    // No profileKind on the legacy document yet.
    const ok = await runVerify();
    expect(ok).toBe(false);
  });

  it('--verify passes after --apply', async () => {
    await runMigration(true);
    const ok = await runVerify();
    expect(ok).toBe(true);
  });

  it('--verify catches a second PRIMARY on one identity that bypassed the unique index', async () => {
    await runMigration(true);

    const existing = await User.collection.findOne({ profileKind: 'PRIMARY' });

    // The scoped-unique index is exactly what should make this impossible in the
    // running app — drop it to simulate the index having been lost or not yet
    // built (e.g. mid-deploy), and confirm --verify still catches the corruption
    // independently rather than trusting the index alone.
    await User.collection.dropIndex('identityId_1_primary_unique');
    await User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      identityId: existing.identityId,
      name: 'Rogue Second Primary',
      email: 'rogue@t.com',
      profileKind: 'PRIMARY',
      isActive: true
    });

    const ok = await runVerify();
    expect(ok).toBe(false);
  });
});
