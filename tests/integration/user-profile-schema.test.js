const mongoose = require('mongoose');
const User = require('../../src/models/User');
const Identity = require('../../src/models/Identity');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Schema-level invariants for multiple rider profiles per identity (see
// docs/modules/PROFILES.md). One User collection holds both the account
// holder (PRIMARY) and everyone they manage (MANAGED) — these lock the two
// constraints that make that safe: at most one PRIMARY per identity, and
// email only ever on the PRIMARY.

let identity;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  await User.syncIndexes();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Identity.deleteMany({});
  identity = await Identity.create({
    email: `schema-${Date.now()}-${Math.random().toString(36).slice(2)}@t.com`,
    password: 'P@ssw0rd!'
  });
});

describe('User.profileKind', () => {
  it('defaults to PRIMARY', async () => {
    const user = await User.create({ name: 'Solo Rider', identityId: identity._id, email: identity.email });
    expect(user.profileKind).toBe('PRIMARY');
  });

  it('rejects a second PRIMARY under the same identity', async () => {
    await User.create({ name: 'First', identityId: identity._id, email: identity.email, profileKind: 'PRIMARY' });

    await expect(
      User.create({ name: 'Second', identityId: identity._id, email: `other-${identity.email}`, profileKind: 'PRIMARY' })
    ).rejects.toThrow(/E11000|duplicate key/);
  });

  it('allows several MANAGED profiles under the same identity', async () => {
    await User.create({ name: 'Parent', identityId: identity._id, email: identity.email, profileKind: 'PRIMARY' });
    const childA = await User.create({ name: 'Child A', identityId: identity._id, profileKind: 'MANAGED' });
    const childB = await User.create({ name: 'Child B', identityId: identity._id, profileKind: 'MANAGED' });

    expect(String(childA.identityId)).toBe(String(identity._id));
    expect(String(childB.identityId)).toBe(String(identity._id));

    const household = await User.find({ identityId: identity._id }).sort({ createdAt: 1 });
    expect(household).toHaveLength(3);
  });

  it('rejects a PRIMARY profile with no email', async () => {
    await expect(
      User.create({ name: 'No Email Primary', identityId: identity._id, profileKind: 'PRIMARY' })
    ).rejects.toThrow(/must carry the account email/);
  });

  it('rejects a MANAGED profile that carries an email', async () => {
    await expect(
      User.create({
        name: 'Emailed Child', identityId: identity._id, profileKind: 'MANAGED', email: 'child@t.com'
      })
    ).rejects.toThrow(/cannot have its own email/);
  });

  it('a blank email string on a MANAGED profile is treated as no email, not a validation error', async () => {
    // Mirrors the emailOptional setter (accountFields.js): '' -> undefined before
    // the profileKind validators run.
    const child = await User.create({
      name: 'Blank Email Child', identityId: identity._id, profileKind: 'MANAGED', email: ''
    });
    expect(child.email).toBeUndefined();
  });
});
